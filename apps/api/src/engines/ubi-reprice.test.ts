import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { decide, hashObject, permissionsForRole, type Ctx } from "@lyra/core";
import { Gateway, makeStub, type UbiContext } from "@lyra/model-gateway";
import { changeSetHashOf, endorsePolicy } from "./axis-endorse.js";
import { TelematicsIngest, repriceFromTelemetry, type PolicyRow, type UbiStamp } from "./telematics.js";
import { seedTestChart } from "@lyra/ledger/test-chart";

// docs/27 F5 (Group E, task 4): a telemetry-driven price change is an
// endorsement. These tests exist to hold that claim down — same pricing, same
// referral guard, same approval gate, same recipe, with only the transaction
// type recording that a sensor and not an underwriter moved the price.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const DAY = 86_400_000;
const SOURCE = "telematics:obd:km";
const NOW = Date.UTC(2026, 5, 15, 12);
const START = NOW - 30 * DAY;
const END = NOW + 335 * DAY;

let client: Client;
let ctx: Ctx;
let policy: PolicyRow;

/** A reply the model could plausibly return, in the shape `parseUbi` accepts. */
function reply(premiumDeltaPpm: number, code = "km_band"): string {
  return JSON.stringify({
    premiumDeltaPpm,
    factors: [{ code, weight: 1, evidenceRef: SOURCE }],
    confidence: 0.8
  });
}

function gatewayWithStub(...replies: string[]): { gateway: Gateway; stub: ReturnType<typeof makeStub> } {
  const stub = makeStub({ replies });
  return {
    gateway: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } }),
    stub
  };
}

function gatewayWith(...replies: string[]): Gateway {
  return gatewayWithStub(...replies).gateway;
}

/** The `UbiContext` a given model call was handed — the exposure it priced on. */
function contextOfCall(stub: ReturnType<typeof makeStub>, n: number): UbiContext {
  const user = [...stub.calls[n]!.messages].reverse().find((m) => m.role === "user");
  return JSON.parse(user!.content) as UbiContext;
}

/** The reprice provenance stamped on a version (`termsJson.ubi`). */
function ubiStamp(version: { termsJson: string | null }): UbiStamp {
  return (JSON.parse(version.termsJson ?? "{}") as { ubi?: UbiStamp }).ubi!;
}

/** The change set `repriceFromTelemetry` builds from `reply()`, and its hash. */
async function changeSetHashFor(code = "km_band"): Promise<string> {
  return changeSetHashOf({ changes: { [code]: { weight: 1, evidenceRef: SOURCE } }, reason: "ubi_reprice" });
}

/**
 * `conflict()`/`badRequest()` set Error.message to the fixed problem+json title
 * ("Conflict", "Bad request", docs/04 §1); the reason lives on `.detail`. Same
 * assertion shape as `telematics.test.ts`.
 */
async function refusalDetail(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return (e as { detail?: string }).detail ?? String(e);
  }
  throw new Error("expected a refusal, got none");
}

async function txns(type?: string) {
  const rows = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
  return type ? rows.filter((r) => r.type === type) : rows;
}

/** What a transaction's journal actually posted, on the side that carries it. */
async function debitSum(txnId: string): Promise<number> {
  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.txnId, txnId));
  return lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
}

async function currentVersion() {
  const [row] = await ctx.db
    .select()
    .from(schema.axisPolicyVersions)
    .where(
      and(
        eq(schema.axisPolicyVersions.tenantId, ctx.tenantId),
        eq(schema.axisPolicyVersions.policyId, policy.id),
        eq(schema.axisPolicyVersions.state, "effective")
      )
    );
  return row!;
}

/** Marks a gate satisfied without going through a desk, for the paths under test. */
async function preApprove(subjectRef: string, policyKey: string, amountMinor: number): Promise<void> {
  await ctx.db.insert(schema.approvals).values({
    id: `apr_${policyKey}_${subjectRef.slice(-8)}`,
    tenantId: ctx.tenantId,
    subjectRef,
    policyKey,
    module: policyKey.split(".")[0]!,
    requestedBy: "user:u_test",
    requestedAt: ctx.now - 1000,
    decidedBy: "user:u_desk",
    decision: "approved",
    reason: null,
    contextJson: JSON.stringify({ amountMinor }),
    decidedAt: ctx.now - 1000,
    delegationId: null
  } as never);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const tenantId = "t_1";
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: {
      kind: "user",
      id: "u_test",
      tenantId,
      grants: [{ roleKey: "owner", permissions: permissionsForRole("owner") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    // The endorse gate is the tenant's to automate; the refund gate is not, and
    // `endorsePolicy` refuses to let it be (docs/19 §7).
    policy: PolicyJson.parse({ currency: "ZAR", autoApprove: ["axis.endorse"] }),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);

  await ctx.db.insert(schema.products).values({
    id: "prod_ubi",
    tenantId,
    line: "motor",
    nameJson: JSON.stringify({ en: "Motor" }),
    // What the product declares it prices on — the guard that stops a model
    // inventing a rating factor and having it silently priced.
    pricingInputsJson: JSON.stringify({ km_band: {}, harsh_braking: {} }),
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  await ctx.db.insert(schema.axisPolicies).values({
    id: "pol_1",
    tenantId,
    customerId: "cust_1",
    providerId: "prov_1",
    productId: "prod_ubi",
    policyNo: "POL-1",
    versionSeq: 1,
    startAt: START,
    endAt: END,
    premiumMinor: 100_000,
    currency: "ZAR",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  await ctx.db.insert(schema.axisPolicyVersions).values({
    id: "pver_1",
    tenantId,
    policyId: "pol_1",
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: START,
    effectiveTo: END,
    premiumMinor: 100_000,
    taxMinor: 15_000,
    feesMinor: 0,
    commissionMinor: 10_000,
    currency: "ZAR",
    premiumDeltaMinor: 0,
    proRataDays: 365,
    termsJson: JSON.stringify({ km_band: { weight: 0 } }),
    state: "effective",
    issuedBy: "user:u_test",
    issuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  const [row] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, "pol_1"));
  policy = row!;
});

async function ingestKm(...values: number[]): Promise<void> {
  const ingest = new TelematicsIngest(ctx, SOURCE, policy);
  await ingest.ingest(`policy:${policy.id}`, values.map((value, i) => ({ at: NOW - (i + 1) * DAY, value })));
}

describe("endorsePolicy transaction type", () => {
  it("still writes an ENDORSE transaction when no opts are passed", async () => {
    const out = await endorsePolicy(ctx, policy, { changes: { km_band: { weight: 1 } }, premiumMinor: 110_000 });
    expect(out.txn?.type).toBe("ENDORSE");
    expect(out.txn?.idempotencyKey).toMatch(/^axis\.endorse:pol_1:/);
  });

  it("writes a UBI-REPRICE transaction whose journal lines are ENDORSE's, and balanced", async () => {
    const ubi = await endorsePolicy(
      ctx,
      policy,
      { changes: { km_band: { weight: 1 } }, premiumMinor: 110_000 },
      { type: "UBI-REPRICE" }
    );
    expect(ubi.txn?.type).toBe("UBI-REPRICE");

    // Same posting, different provenance: the two types' lines must agree line
    // for line, or "a reprice is an endorsement" is not true of the ledger.
    const reprice = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, ubi.txn!.id));
    const plain = await endorsePolicy(ctx, ubi.policy, {
      changes: { harsh_braking: { weight: 1 } },
      premiumMinor: 121_000
    });
    const endorse = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, plain.txn!.id));

    const shape = (ls: typeof reprice) =>
      ls.map((l) => `${l.side}:${l.accountCode}`).sort();
    expect(shape(reprice)).toEqual(shape(endorse));

    const sum = (ls: typeof reprice, side: string) =>
      ls.filter((l) => l.side === side).reduce((s, l) => s + l.amountMinor, 0);
    expect(sum(reprice, "debit")).toBe(sum(reprice, "credit"));
    expect(sum(reprice, "debit")).toBeGreaterThan(0);
  });

  it("gives a reprice and a manual endorsement of the same change set different idempotency keys", async () => {
    const changes = { km_band: { weight: 1 } };
    const first = await endorsePolicy(ctx, policy, { changes, premiumMinor: 110_000 }, { type: "UBI-REPRICE" });
    const second = await endorsePolicy(ctx, first.policy, { changes, premiumMinor: 121_000 });

    // Identical change set, so identical hash — the prefix is what separates
    // them, and it would separate them even off one version at one price.
    const hash = await changeSetHashOf({ changes });
    expect(first.txn!.idempotencyKey).not.toBe(second.txn!.idempotencyKey);
    expect(first.txn!.idempotencyKey).toBe(`axis.ubi-reprice:pol_1:pver_1:${hash}:10000:335`);
    expect(second.txn!.idempotencyKey).toBe(`axis.endorse:pol_1:${first.version.id}:${hash}:11000:335`);
  });

  it("keys the ledger transaction to the version it supersedes, not the change set alone", async () => {
    // The change set is what `changeSetHashOf` covers; the price is not. Two
    // endorsements naming the same factors at the same weights but a different
    // premium therefore hash the same, and on the hash alone they shared one
    // ledger idempotency key: `runTxn` returned the first settled transaction
    // without posting a journal, while `endorsePolicy` carried on and
    // superseded the version at the new premium. Money state moved with no
    // journal behind it (CLAUDE.md #12). Exactly one endorsement can supersede
    // a given version (§C.2), so that version's id is the honest scope.
    const changes = { km_band: { weight: 1 } };
    const first = await endorsePolicy(ctx, policy, { changes, premiumMinor: 110_000 });
    const second = await endorsePolicy(ctx, first.policy, { changes, premiumMinor: 130_000 });

    expect(second.txn!.id).not.toBe(first.txn!.id);
    // Each journal is that endorsement's own commission delta, pro-rated over
    // the remaining term. `commissionAccrual` debits the gross once, so the
    // debit sum is the amount posted: a replay would show the first amount
    // twice, and a double post would show it doubled.
    expect(await debitSum(first.txn!.id)).toBe(918);
    expect(await debitSum(second.txn!.id)).toBe(1836);
    // Each version names the transaction that actually posted its journal.
    expect(first.version.txnId).toBe(first.txn!.id);
    expect(second.version.txnId).toBe(second.txn!.id);
    expect((await currentVersion()).txnId).toBe(second.txn!.id);
  });

  it("keys the ledger transaction to the amount as well, so a retry at a different price posts its own journal", async () => {
    // The crack left under the version scoping. The charge `runTxn` settles and
    // something throws before the version insert (the refund leg, an eviction);
    // the retry re-reads the *same* still-current version, and `changeSetHashOf`
    // covers {changes, reason} and not the price. On (policy, version, hash)
    // alone a retry that prices differently — a reprice whose model returns
    // another `premiumDeltaPpm` for the same factor codes — replayed the settled
    // transaction, so `runTxn` posted no journal while `endorsePolicy` carried
    // on and superseded the version at the new premium: money state with no
    // journal behind it (CLAUDE.md #12).
    //
    // This does not make the path atomic — the abandoned settled charge is
    // still an over-post needing compensation, and that stays a recorded
    // follow-up. It guarantees the invariant that matters.
    const changes = { km_band: { weight: 1 } };
    const first = await endorsePolicy(ctx, policy, { changes, premiumMinor: 110_000 });

    // Rewind to exactly the mid-flight state: the charge is settled, neither
    // version write happened, so `current` reads back as `pver_1`.
    await ctx.db.delete(schema.axisPolicyVersions).where(eq(schema.axisPolicyVersions.id, first.version.id));
    await ctx.db
      .update(schema.axisPolicyVersions)
      .set({ state: "effective", effectiveTo: END, supersededAt: null })
      .where(eq(schema.axisPolicyVersions.id, "pver_1"));

    const retry = await endorsePolicy(ctx, policy, { changes, premiumMinor: 130_000 });

    expect(retry.txn!.id).not.toBe(first.txn!.id);
    // 100_000 -> 130_000 is a ratio of 1.3, so commission moves 10_000 -> 13_000,
    // pro-rated over the 335 days left of a 365-day term: round(3000 * 335/365).
    expect(await debitSum(retry.txn!.id)).toBe(2753);
    expect(retry.version.txnId).toBe(retry.txn!.id);
  });

  it("keys on the quote, not one rounded amount: two prices that share a charge still post two journals", async () => {
    // `chargeMinor` is not injective in the price. `share(x) = round(x * 335/365)`
    // maps a band of premium deltas onto one charge, so a retry that prices a
    // few minor units apart re-collides on a charge-keyed transaction and the
    // version moves against a replayed one. 100_174 and 100_175 both charge 184
    // and are a real difference: their commission legs are 16 and 17.
    //
    // `premiumDeltaMinor` + `proRataDays` is the honest key. Off a fixed
    // `current.id` the new premium is `current.premiumMinor + premiumDeltaMinor`
    // and every other quote field derives from that and `proRataDays`, so the
    // pair determines the whole quote where neither amount alone does — and the
    // day count separates a back-dated re-issue of the same target premium,
    // which `premiumDeltaMinor` alone would not.
    const changes = { km_band: { weight: 1 } };
    const first = await endorsePolicy(ctx, policy, { changes, premiumMinor: 100_174 });
    await ctx.db.delete(schema.axisPolicyVersions).where(eq(schema.axisPolicyVersions.id, first.version.id));
    await ctx.db
      .update(schema.axisPolicyVersions)
      .set({ state: "effective", effectiveTo: END, supersededAt: null })
      .where(eq(schema.axisPolicyVersions.id, "pver_1"));

    const retry = await endorsePolicy(ctx, policy, { changes, premiumMinor: 100_175 });

    expect(retry.txn!.id).not.toBe(first.txn!.id);
    expect(await debitSum(first.txn!.id)).toBe(16);
    expect(await debitSum(retry.txn!.id)).toBe(17);
  });
});

describe("repriceFromTelemetry", () => {
  it("refuses when no telemetry is stored, before any model call or transaction", async () => {
    const gw = gatewayWith(reply(100_000));
    expect(await refusalDetail(() => repriceFromTelemetry(ctx, policy, gw))).toMatch(/no telemetry stored/);
    expect(await txns()).toHaveLength(0);
    expect(await ctx.db.select().from(schema.aiAuditLog)).toHaveLength(0);
  });

  it("returns repriced:false on a zero adjustment, opening no transaction and no approval", async () => {
    await ingestKm(120, 95);
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(0)));
    expect(out).toEqual({ repriced: false });
    // TELEM-INGEST is the ingest's own row; the reprice adds nothing.
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect(await ctx.db.select().from(schema.approvals)).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);
  });

  it("returns repriced:false when the model names no evidenced factor, however large the delta", async () => {
    await ingestKm(120);
    const unevidenced = JSON.stringify({ premiumDeltaPpm: 200_000, factors: [{ code: "km_band", weight: 1 }] });
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(unevidenced));
    expect(out).toEqual({ repriced: false });
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
  });

  it("raises the premium by the ppm arithmetic exactly, in minor units", async () => {
    await ingestKm(120, 95, 140);
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)));
    expect(out.repriced).toBe(true);
    // 100_000 minor + round(100_000 * 100_000 / 1e6) = 110_000.
    expect(out.repriced && out.premiumMinor).toBe(110_000);
    const version = await currentVersion();
    expect(version.versionSeq).toBe(2);
    expect(version.premiumMinor).toBe(110_000);
    expect((await txns("UBI-REPRICE"))).toHaveLength(1);
  });

  it("posts a second journal when a later reprice repeats the factors at a different ppm", async () => {
    // The reported case for the key above: `changes` is built from the model's
    // factor codes and weights, so two proposals that differ only in
    // `premiumDeltaPpm` are one hash. F2's canonicalisation removed the
    // accidental key-order differentiator, so this stopped being rare.
    await ingestKm(120, 95);
    const first = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)));
    if (!first.repriced) throw new Error("the first reprice returned no price move");

    // A later window with its own kilometres in it — the first reprice advanced
    // `effectiveFrom` past everything it already priced.
    ctx.now = NOW + DAY;
    await new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at: NOW + DAY / 2, value: 130 }]);
    const second = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(50_000)));
    if (!second.repriced) throw new Error("the second reprice returned no price move");

    expect(second.premiumMinor).toBe(115_500);
    expect(await txns("UBI-REPRICE")).toHaveLength(2);
    expect(second.txn!.id).not.toBe(first.txn!.id);
    // 100_000 -> 110_000 then 110_000 -> 115_500: the second journal is the
    // second delta's commission, not a replay of the first's.
    expect(await debitSum(first.txn!.id)).toBe(918);
    expect(await debitSum(second.txn!.id)).toBe(503);
    const head = await currentVersion();
    expect(head.premiumMinor).toBe(115_500);
    expect(head.txnId).toBe(second.txn!.id);
  });

  it("prices each window once while a forward-dated endorsement is pending, not back to inception every run", async () => {
    // `priceEndorsement` allows a future `effectiveFrom` and inserts the new
    // version `state: "effective"` straight away, so the effective version can
    // start in the future while the cover still runs on the version it
    // superseded. Reading the priced watermark off the effective version alone
    // put the watermark in the future: every ingest 400s until that date
    // arrives and the reprice window is empty until then.
    //
    // Reading it off the version in force *now* fixes that and is still not a
    // watermark on its own. A reprice under a pending forward-dated endorsement
    // does not move the version in force: `priceEndorsement` sets
    // `effectiveFrom = max(now, current.effectiveFrom)` and `current` is the
    // forward-dated version, so the new version also starts at the future date,
    // and the superseded one is closed at its own start — a zero-width window
    // `versionAt` cannot match. The version containing `now` stays the
    // pre-endorsement one run after run, so every sweep would re-price back to
    // inception and compound the premium on kilometres already billed. The end
    // of the last window actually priced is what has to move.
    const future = await endorsePolicy(ctx, policy, {
      changes: { km_band: { weight: 1 } },
      premiumMinor: 110_000,
      effectiveFrom: NOW + 30 * DAY
    });
    expect(future.version.effectiveFrom).toBe(NOW + 30 * DAY);
    expect(future.version.state).toBe("effective");

    await new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at: NOW, value: 100 }]);

    ctx.now = NOW + DAY;
    const one = gatewayWithStub(reply(100_000));
    const first = await repriceFromTelemetry(ctx, future.policy, one.gateway);
    expect(first.repriced).toBe(true);
    const firstUbi = ubiStamp(await currentVersion());
    expect(contextOfCall(one.stub, 0).series[0]!.total).toBe(100);

    // A second batch inside the still-pending forward date, and a second sweep.
    ctx.now = NOW + 2 * DAY;
    await new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [
      { at: NOW + Math.round(1.5 * DAY), value: 10 }
    ]);
    const two = gatewayWithStub(reply(100_000));
    const second = await repriceFromTelemetry(ctx, future.policy, two.gateway);
    expect(second.repriced).toBe(true);
    const secondUbi = ubiStamp(await currentVersion());

    // Consecutive windows, sharing an endpoint: no instant is priced twice.
    expect(firstUbi.windowEnd).toBe(NOW + DAY);
    expect(secondUbi.windowStart).toBe(firstUbi.windowEnd);
    expect(secondUbi.windowEnd).toBe(NOW + 2 * DAY);
    // And the model saw only the second batch's exposure, not 110 km again.
    expect(contextOfCall(two.stub, 0).series[0]!.total).toBe(10);
  });

  it("still prices telemetry accepted before a forward-dated endorsement once that date arrives", async () => {
    // Deriving the watermark from the version graph strands exposure. While the
    // endorsement is pending, ingest accepts a point after the last priced
    // window — that acceptance is the promise that some window will price it.
    // When the forward date arrives the version in force jumps to it, and on any
    // version-derived watermark every window from then on starts at the future
    // date: the point sits after the last window's end and before every future
    // window's start, and is never billed. A version boundary is where the price
    // changed, not where pricing got up to.
    await new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at: NOW - DAY, value: 100 }]);
    const one = gatewayWithStub(reply(100_000));
    const first = await repriceFromTelemetry(ctx, policy, one.gateway);
    if (!first.repriced) throw new Error("expected the first sweep to reprice");
    const firstUbi = ubiStamp(await currentVersion());
    expect(firstUbi.windowEnd).toBe(NOW);

    // A manual forward-dated endorsement — it stamps no `ubi`, so it prices
    // nothing and must not move the watermark.
    const future = await endorsePolicy(ctx, first.policy, {
      changes: { harsh_braking: { weight: 1 } },
      premiumMinor: 120_000,
      effectiveFrom: NOW + 30 * DAY
    });
    expect(future.version.effectiveFrom).toBe(NOW + 30 * DAY);

    // Accepted inside the gap `[lastPricedWindowEnd, forwardDate)`.
    ctx.now = NOW + DAY;
    await new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at: NOW + DAY, value: 500 }]);

    // The forward date arrives.
    ctx.now = NOW + 31 * DAY;
    const two = gatewayWithStub(reply(100_000));
    const second = await repriceFromTelemetry(ctx, future.policy, two.gateway);
    expect(second.repriced).toBe(true);

    // The window resumes where pricing actually got up to, not at the forward
    // date: 500 km priced, not 0 (stranded) and not 600 (re-priced to inception).
    const secondUbi = ubiStamp(await currentVersion());
    expect(secondUbi.windowStart).toBe(firstUbi.windowEnd);
    expect(secondUbi.windowStart).toBe(NOW);
    expect(secondUbi.windowEnd).toBe(NOW + 31 * DAY);
    expect(contextOfCall(two.stub, 0).series[0]!.total).toBe(500);
  });

  it("refuses a reprice on an ended term before spending a model call on it", async () => {
    // `priceEndorsement` derives `effectiveFrom = max(now, current.effectiveFrom)`
    // and refuses anything at or past `endAt`, so a reprice after the term ends is
    // a guaranteed refusal. Discovering that after `gateway.complete` bills a
    // model call and writes an `ai_audit_log` row for a price that was never
    // going to move.
    await ingestKm(100);
    // Pinned at exactly `END`, not a day past it: `effectiveFrom >= endAt` is
    // refused, so `END` is already outside the priceable term and a `>` guard
    // here would burn a model call on it while a `now = END + DAY` test stayed
    // green.
    ctx.now = END;
    const one = gatewayWithStub(reply(100_000));

    expect(await refusalDetail(() => repriceFromTelemetry(ctx, policy, one.gateway))).toMatch(
      /term has ended/
    );
    expect(one.stub.calls.length).toBe(0);
  });

  it("refuses a reprice on a cover that is not on risk before spending a model call on it", async () => {
    // `priceEndorsement` refuses the whole endorsement on a cover that is not
    // bound or active — but it refuses it *after* `gateway.complete`, so the
    // refusal arrives having already billed a model call and written an
    // `ai_audit_log` row for a price that was never going to move.
    //
    // `lapsed` belongs in this list and deliberately *not* in the ingest
    // doorway's equivalent loop (telematics.test.ts): the pricer asks whether
    // the cover is on risk right now, and a lapsed cover is not, so it refuses —
    // reversibly, because the watermark does not move and the next window after
    // reinstatement prices everything it declined. The doorway asks the wider
    // question because its refusal destroys evidence. Two predicates, one
    // difference: `lapsed`.
    await ingestKm(100);

    for (const status of ["cancelled", "lapsed", "expired"]) {
      await ctx.db.update(schema.axisPolicies).set({ status }).where(eq(schema.axisPolicies.id, policy.id));
      const [off] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
      const one = gatewayWithStub(reply(100_000));

      expect(await refusalDetail(() => repriceFromTelemetry(ctx, off!, one.gateway))).toMatch(/not on risk/i);
      // The money property: no model call, so no billed provider request and no
      // audit row — and no reprice transaction behind it.
      expect(one.stub.calls.length).toBe(0);
      expect(await ctx.db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.tenantId, ctx.tenantId))).toHaveLength(0);
      expect(await txns("UBI-REPRICE")).toHaveLength(0);
    }
  });

  it("prices the kilometres driven during a lapse the reinstatement cured", async () => {
    // The money property behind the doorway/pricer split. Nothing in the
    // codebase records a lapse as a gap in cover: `reinstatePolicy` hops back to
    // `active`, clears `lapsedAt` and leaves the write-once term alone, and the
    // watermark is `max(startAt, last priced windowEnd)` which does not advance
    // while reprices are refused. So the first window after reinstatement spans
    // the lapse — and had the doorway refused the batch driven during it, the
    // model would be handed a smaller total over the same window and propose a
    // smaller uplift, with a journal balancing perfectly against a premium delta
    // that is simply too small.
    const beforeLapse = 200;
    const duringLapse = 250;
    const ingestOne = async (p: PolicyRow, at: number, value: number) =>
      new TelematicsIngest(ctx, SOURCE, p).ingest(`policy:${p.id}`, [{ at, value }]);
    const asStatus = async (status: string): Promise<PolicyRow> => {
      await ctx.db.update(schema.axisPolicies).set({ status }).where(eq(schema.axisPolicies.id, policy.id));
      const [row] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
      return row!;
    };

    await ingestOne(policy, NOW - 10 * DAY, beforeLapse);
    await ingestOne(await asStatus("lapsed"), NOW - 5 * DAY, duringLapse);

    const one = gatewayWithStub(reply(100_000));
    const out = await repriceFromTelemetry(ctx, await asStatus("active"), one.gateway);

    expect(out.repriced).toBe(true);
    // The number, not `repriced === true`: the whole defect is a total quietly
    // short by the lapse span.
    expect(contextOfCall(one.stub, 0).series[0]!.total).toBe(beforeLapse + duringLapse);
  });

  it("clamps an absurd downward proposal, so one reply cannot move the price more than 25%", async () => {
    await ingestKm(20);
    // -900_000 ppm would be -90%; MAX_REPRICE_PPM clamps it to -25%.
    const hash = await changeSetHashFor();
    const subjectRef = `axis_ubi_reprice:${policy.id}:pver_1:${hash}`;
    await preApprove(`${subjectRef}:refund`, "ledger.refund", 100_000);

    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(-900_000)));
    expect(out.repriced).toBe(true);
    expect(out.repriced && out.premiumMinor).toBe(75_000);
    expect(out.repriced && out.premiumDeltaPpm).toBe(-250_000);
  });

  it("refuses rather than writing a zero premium, which would freeze tax and commission forever", async () => {
    // `quoteEndorsement` prices the delta as a ratio of the current premium, so a
    // contract at 0 accrues no tax and no commission on any later move, and would
    // reprice forever, stamping a version each time and moving nothing.
    //
    // Repeated reprices are NOT the path into that state: the clamp is ±250 000
    // ppm and the engine rounds with `Math.round`, which rounds half toward +∞,
    // so P=1→1, P=2→2, P=3→2, P=4→3 — a positive integer premium never reaches
    // 0 by maximal downward steps. The reachable path is a cover written at 0 in
    // the first place: `EndorseBody.premiumMinor` is `nonnegative()`. The direct
    // UPDATE below is the honest way to reach that state in a test.
    await ctx.db
      .update(schema.axisPolicyVersions)
      .set({ premiumMinor: 0 })
      .where(eq(schema.axisPolicyVersions.id, "pver_1"));
    await ingestKm(20);

    expect(await refusalDetail(() => repriceFromTelemetry(ctx, policy, gatewayWith(reply(-250_000))))).toMatch(
      /zero or negative premium/
    );
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);
  });

  it("refuses when the product declares no pricing inputs, before any model call", async () => {
    // The referral guard is the only thing between an invented factor code and a
    // priced one, and with no declared inputs it has no allowlist to check
    // against. A model-proposed change may not proceed unchecked.
    await ctx.db
      .update(schema.products)
      .set({ pricingInputsJson: null })
      .where(eq(schema.products.id, "prod_ubi"));
    await ingestKm(120);

    expect(await refusalDetail(() => repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000))))).toMatch(
      /declares no pricing inputs/
    );
    expect(await ctx.db.select().from(schema.aiAuditLog)).toHaveLength(0);
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
  });

  it("refuses a proposal that repeats a factor code instead of keeping the last one", async () => {
    // `Object.fromEntries` would keep the second, leaving the priced change set
    // with one weight and the stamp recording two.
    await ingestKm(120);
    const dup = JSON.stringify({
      premiumDeltaPpm: 100_000,
      factors: [
        { code: "km_band", weight: 1, evidenceRef: SOURCE },
        { code: "km_band", weight: 9, evidenceRef: SOURCE }
      ],
      confidence: 0.8
    });
    expect(await refusalDetail(() => repriceFromTelemetry(ctx, policy, gatewayWith(dup)))).toMatch(
      /repeats a factor code/
    );
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);
  });

  it("propagates a gateway failure instead of returning a silent zero-delta reprice", async () => {
    await ingestKm(120);
    const broken = {
      complete: async () => {
        throw new Error("provider unavailable");
      }
    } as unknown as Gateway;
    await expect(repriceFromTelemetry(ctx, policy, broken)).rejects.toThrow(/provider unavailable/);
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);
  });

  it("refers a factor code the product does not price on, instead of pricing it", async () => {
    await ingestKm(120);
    expect(
      await refusalDetail(() => repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000, "moon_phase"))))
    ).toMatch(/needs referral/);
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);
  });

  it("stamps the model-gateway audit id onto the version it produced", async () => {
    await ingestKm(120, 95);
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)));
    const stamped = JSON.parse((await currentVersion()).termsJson!) as {
      ubi: { aiAuditId: string; premiumDeltaPpm: number; windowStart: number; windowEnd: number };
    };
    expect(stamped.ubi.aiAuditId).toBe(out.repriced && out.aiAuditId);
    expect(stamped.ubi.premiumDeltaPpm).toBe(100_000);
    expect(stamped.ubi.windowStart).toBe(START);
    expect(stamped.ubi.windowEnd).toBe(NOW);

    // The id must resolve to a real ai_audit_log row, or it answers nothing when
    // a customer disputes the premium.
    const [logged] = await ctx.db
      .select()
      .from(schema.aiAuditLog)
      .where(eq(schema.aiAuditLog.id, stamped.ubi.aiAuditId));
    expect(logged?.purpose).toBe("axis.policy.ubi_reprice");
  });

  it("does not carry the stamp onto a later manual endorsement", async () => {
    await ingestKm(120, 95);
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)));
    const manual = await endorsePolicy(ctx, out.repriced ? out.policy : policy, {
      changes: { harsh_braking: { weight: 1 } },
      premiumMinor: 120_000
    });
    // `ubi` describes the version that produced it. Carried forward, every later
    // version would claim a model moved its price.
    expect(JSON.parse(manual.version.termsJson!)).not.toHaveProperty("ubi");
    // …while the reprice's factors are ordinary terms and do carry forward.
    expect(JSON.parse(manual.version.termsJson!)).toHaveProperty("km_band");
  });

  it("writes the provenance in the version's own insert, not a second write after it", async () => {
    await ingestKm(120, 95);
    const out = await repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)));
    // The row the insert returned already carries it: a stamp added afterwards
    // could fail and leave a moved premium with no audit id, window or factors.
    expect(JSON.parse((out.repriced && out.version.termsJson) || "{}")).toHaveProperty("ubi");
    const versions = await ctx.db
      .select()
      .from(schema.axisPolicyVersions)
      .where(and(eq(schema.axisPolicyVersions.tenantId, ctx.tenantId), eq(schema.axisPolicyVersions.versionSeq, 2)));
    expect(versions).toHaveLength(1);
    expect(JSON.parse(versions[0]!.termsJson!)).toHaveProperty("ubi");
  });

  it("still requires the axis.endorse approval when the tenant has not automated it", async () => {
    ctx.policy = PolicyJson.parse({ currency: "ZAR" });
    await ingestKm(120, 95);
    await expect(repriceFromTelemetry(ctx, policy, gatewayWith(reply(100_000)))).rejects.toThrow();
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.policyKey, "axis.endorse"));
    expect(pending?.decision).toBe("pending");
    expect(await txns("UBI-REPRICE")).toHaveLength(0);
    expect((await currentVersion()).versionSeq).toBe(1);

    // The approver has to see what they are authorising: a policy id and a hash
    // do not distinguish a model's proposal from an underwriter's own change
    // (CLAUDE.md #11 — every AI artifact carries an inspectable "why").
    const context = JSON.parse(pending!.contextJson!) as {
      txnType: string;
      reason: string;
      source: string;
      ubi: { aiAuditId: string; premiumDeltaPpm: number; windowStart: number; factors: { code: string }[] };
    };
    expect(context.txnType).toBe("UBI-REPRICE");
    expect(context.reason).toBe("ubi_reprice");
    expect(context.source).toBe("telematics");
    expect(context.ubi.premiumDeltaPpm).toBe(100_000);
    expect(context.ubi.windowStart).toBe(START);
    expect(context.ubi.factors.map((f) => f.code)).toEqual(["km_band"]);
    const [logged] = await ctx.db
      .select()
      .from(schema.aiAuditLog)
      .where(eq(schema.aiAuditLog.id, context.ubi.aiAuditId));
    expect(logged?.purpose).toBe("axis.policy.ubi_reprice");
  });

  it("reprices once a desk approves the pending request, the way production does", async () => {
    ctx.policy = PolicyJson.parse({ currency: "ZAR" });
    await ingestKm(120, 95);
    const gw = gatewayWith(reply(100_000), reply(100_000));
    await expect(repriceFromTelemetry(ctx, policy, gw)).rejects.toThrow();
    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.policyKey, "axis.endorse"));

    // Dual control: the approver must not be the initiator, and must actually
    // hold the deciding permission (`axis:policies:endorse`).
    const initiator = ctx.actor;
    ctx.actor = {
      ...initiator,
      id: "u_desk",
      grants: [{ roleKey: "axis.lead", permissions: permissionsForRole("axis.lead") }]
    };
    await decide(ctx, pending!.id, "approved");
    ctx.actor = initiator;

    const out = await repriceFromTelemetry(ctx, policy, gw);
    expect(out.repriced).toBe(true);
    expect((await currentVersion()).premiumMinor).toBe(110_000);
    expect(await txns("UBI-REPRICE")).toHaveLength(1);
    // Single use: the approval is spent, not left standing for the next reprice.
    const [spent] = await ctx.db.select().from(schema.approvals).where(eq(schema.approvals.id, pending!.id));
    expect(spent?.decision).toBe("consumed");
  });
});

describe("changeSetHashOf", () => {
  it("hashes the same factors in either order to the same value", async () => {
    // A reprice builds `changes` from the model's reply order, and the hash is
    // both the approval subject ref and the idempotency key: order-sensitivity
    // would fork the key on nothing, so a granted approval stops matching.
    const changes = { km_band: { weight: 1 }, harsh_braking: { weight: 2 } };
    const reversed = { harsh_braking: { weight: 2 }, km_band: { weight: 1 } };
    const a = await changeSetHashOf({ changes, reason: "ubi_reprice" });
    expect(a).toBe(await changeSetHashOf({ changes: reversed, reason: "ubi_reprice" }));
    expect(a).toBe(await hashObject({ changes: reversed, reason: "ubi_reprice" }));
    expect(a).not.toBe(await changeSetHashOf({ changes: { km_band: { weight: 1 } }, reason: "ubi_reprice" }));
  });
});

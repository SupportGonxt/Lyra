import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  eq
} from "drizzle-orm"
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, syncTaxRules, type Ctx } from "@lyra/core";
import { runShop } from "./shop.js";

// docs/modules/axis.md §2.3's live process map wants bottlenecks, and a bottleneck
// is a step duration. The seed wrote `quote_fanout` and `quotes_compared`; no
// engine did, so the map showed them for seeded cases and for nothing else.
//
// These hold the two numbers that matter and the two that must not be invented:
// the fan-out's duration is its **slowest** provider (a mean would hide the one
// holding the panel up), and a comparison of one is not a comparison.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const statement of statements()) await client.execute(statement);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "user", id: "u_lead", tenantId: TENANT, grants: [{ roleKey: "axis.lead", permissions: permissionsForRole("axis.lead") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await ctx.db.insert(schema.distChannels).values({
    id: "chn_1",
    tenantId: TENANT,
    key: "web",
    kind: "aggregator",
    nameJson: JSON.stringify({ en: "Web" }),
    medium: "web",
    collectsPayment: "us",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  } as never);
  // A shop prices tax per supply (ADR-0121), and a supply with no rule on file is
  // refused rather than assumed — so an empty tenant cannot shop at all. Only the
  // rules are seeded here, not the demo tenant: the full seed charges every test
  // in the file (CLAUDE.md's own note on that).
  await syncTaxRules(ctx.db as never, TENANT, { now: NOW });
});

/** Three underwriters on one product. */
async function panel(providers: string[]) {
  for (const [index, id] of providers.entries()) {
    await ctx.db.insert(schema.providers).values({
      id,
      tenantId: TENANT,
      name: id,
      kind: "insurer",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    } as never);
    await ctx.db.insert(schema.distOfferings).values({
      id: `off_${index}`,
      tenantId: TENANT,
      productId: "pr_motor",
      providerId: id,
      code: `CODE-${index}`,
      nameJson: JSON.stringify({ en: `Offer ${index}` }),
      currency: "AED",
      pricingMode: "api",
      baseCommissionPpm: 100_000,
      maxDiscountPpm: 0,
      slaSeconds: 30,
      status: "active",
      effectiveFrom: NOW - 1000,
      createdAt: NOW,
      updatedAt: NOW
    } as never);
  }
}

/** A quoter that answers per provider, with the latency the carrier reported. */
const quoter = (byProvider: Record<string, { state: string; premiumMinor?: number; latencyMs?: number }>) =>
  (async ({ provider }: { provider?: { id: string } }) => {
    const answer = byProvider[provider?.id ?? ""] ?? { state: "error", latencyMs: 0 };
    return {
      state: answer.state as never,
      taxMinor: 0,
      feesMinor: 0,
      currency: "AED",
      ...(answer.premiumMinor !== undefined ? { premiumMinor: answer.premiumMinor } : {}),
      ...(answer.latencyMs !== undefined ? { latencyMs: answer.latencyMs } : {})
    };
  }) as never;

const shop = (caseId: string | null, q: unknown) =>
  runShop(ctx, {
    request: {
      id: "qr_1",
      tenantId: TENANT,
      caseId,
      customerId: "cus_1",
      channelId: "chn_1",
      productId: "pr_motor",
      inputsJson: JSON.stringify({ age: 34 }),
      consentId: null,
      currency: "AED",
      expiresAt: NOW + 86_400_000,
      createdAt: NOW,
      updatedAt: NOW
    } as never,
    channelKey: "web",
    inputs: { age: 34 },
    quoter: q as never
  });

const steps = async () =>
  (await ctx.db.select().from(schema.axisProcessEvents).where(eq(schema.axisProcessEvents.tenantId, TENANT))).sort((a, b) => a.ts - b.ts || a.step.localeCompare(b.step));

describe("a shop records the quoting engine's own steps", () => {
  it("records the fan-out with its slowest provider as the duration", async () => {
    // The duration must be the **slowest** member, not a mean: the mean hides the
    // one provider holding the panel up, which is the only thing a bottleneck read
    // is looking for. `quoteOne` measures the wait itself rather than trusting a
    // carrier's own latency claim, so the invariant is against what was recorded.
    await panel(["pv_a", "pv_b", "pv_c"]);
    const { responses } = await shop("cas_1", quoter({
      pv_a: { state: "quoted", premiumMinor: 200_000 },
      pv_b: { state: "quoted", premiumMinor: 210_000 },
      pv_c: { state: "declined" }
    }));

    const fanout = (await steps()).find((s) => s.step === "quote_fanout")!;
    const recorded = responses.map((r) => r.latencyMs).filter((ms): ms is number => typeof ms === "number");
    expect(fanout).toMatchObject({ caseId: "cas_1", actorRef: "agent:quoting", outcome: "ok" });
    expect(recorded.length).toBe(3);
    expect(fanout.durationMs).toBe(Math.max(...recorded));
  });

  it("records the comparison when the panel gave a choice, and not when it did not", async () => {
    await panel(["pv_a", "pv_b"]);
    await shop("cas_1", quoter({
      pv_a: { state: "quoted", premiumMinor: 200_000, latencyMs: 400 },
      pv_b: { state: "quoted", premiumMinor: 210_000, latencyMs: 500 }
    }));
    const compared = (await steps()).find((s) => s.step === "quotes_compared")!;
    // Ranking is instantaneous; a duration here would be noise dressed as a
    // measurement.
    expect(compared).toMatchObject({ durationMs: null, outcome: "ok" });

    // One quote is not a comparison.
    await ctx.db.delete(schema.axisProcessEvents);
    await ctx.db.delete(schema.distQuoteResponses);
    await ctx.db.delete(schema.distQuoteRequests);
    await shop("cas_2", quoter({
      pv_a: { state: "quoted", premiumMinor: 200_000, latencyMs: 400 },
      pv_b: { state: "declined", latencyMs: 500 }
    }));
    expect((await steps()).some((s) => s.step === "quotes_compared")).toBe(false);
  });

  it("calls a fan-out that reached nobody failed, and one where all declined ok", async () => {
    // Reaching nobody is a step that failed; a risk nobody will write is a step
    // that worked. Different facts, different outcomes.
    await panel(["pv_a", "pv_b"]);
    await shop("cas_1", quoter({ pv_a: { state: "error" }, pv_b: { state: "timeout" } }));
    expect((await steps()).find((s) => s.step === "quote_fanout")!.outcome).toBe("failed");

    await ctx.db.delete(schema.axisProcessEvents);
    await ctx.db.delete(schema.distQuoteResponses);
    await ctx.db.delete(schema.distQuoteRequests);
    await shop("cas_2", quoter({ pv_a: { state: "declined" }, pv_b: { state: "declined" } }));
    expect((await steps()).find((s) => s.step === "quote_fanout")!.outcome).toBe("ok");
  });

  it("records nothing when the shop names no case, because there is no timeline to join", async () => {
    await panel(["pv_a"]);
    await shop(null, quoter({ pv_a: { state: "quoted", premiumMinor: 200_000, latencyMs: 400 } }));
    expect(await steps()).toEqual([]);
  });

  it("never leaves the duration undefined, because a fan-out always waited", async () => {
    // The counterpart to the lifecycle writer's null: `quoteOne` times every
    // provider call itself, so a fan-out that ran has a duration even when the
    // carrier reports none. Null here would mean "not measured", which would be
    // untrue — we did wait.
    await panel(["pv_a"]);
    await shop("cas_1", quoter({ pv_a: { state: "quoted", premiumMinor: 200_000 } }));
    const fanout = (await steps()).find((s) => s.step === "quote_fanout")!;
    expect(typeof fanout.durationMs).toBe("number");
    expect(fanout.durationMs).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------- a quote keeps the decomposition it was priced from */

/**
 * ADR-0131, from the 2026-10-01 sweep's DIST finding. Both pricing paths compute a
 * per-rule breakdown — and `rating.ts:109` says outright it is *"shown in the
 * operator's 'why this price' panel"* — but `runShop` rebuilt every row from an
 * explicit field list that omitted it, into a table with no column for one. So the
 * decomposition was discarded at the single persistence point and the panel the
 * comment promises could not exist.
 *
 * For a **carrier-priced** quote this is worse than inconvenient: the underwriter's
 * own line items (base rate, claims loading, policy fee) exist nowhere else, so
 * "why is this £412?" had no answer and never would.
 */
describe("a quote keeps its price decomposition", () => {
  it("stores the carrier's own line items on the response row", async () => {
    await panel(["prov_a"]);
    // A carrier that itemises, as the real ones do.
    const itemising = (async () => ({
      state: "quoted",
      premiumMinor: 412_00,
      taxMinor: 0,
      feesMinor: 0,
      currency: "AED",
      breakdown: [
        { label: "base", amountMinor: 350_00 },
        { label: "claims loading", amountMinor: 47_00 },
        { label: "policy fee", amountMinor: 15_00 }
      ]
    })) as never;

    await shop("cas_bd", itemising);

    const [row] = await ctx.db
      .select()
      .from(schema.distQuoteResponses)
      .where(eq(schema.distQuoteResponses.state, "quoted"));
    expect(row).toBeTruthy();
    const stored = JSON.parse(String(row!.breakdownJson)) as { label: string; amountMinor: number }[];
    expect(stored).toHaveLength(3);
    // The line items survive with their own labels, not collapsed to a total — the
    // whole point is that a person can see *which* rule contributed what.
    expect(stored.map((b) => b.label)).toEqual(["base", "claims loading", "policy fee"]);
    // And they add up to the premium, so the decomposition is a decomposition.
    expect(stored.reduce((n, b) => n + b.amountMinor, 0)).toBe(412_00);
  });
});

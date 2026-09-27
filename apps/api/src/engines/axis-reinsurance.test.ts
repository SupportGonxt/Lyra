import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema, type Db } from "@lyra/db";
import { decide, emit, seed, type Ctx, type SeedResult } from "@lyra/core";
import { drainOutbox } from "../dispatch.js";
import { cedePolicy } from "./axis-reinsurance.js";

// docs/30 AXIS 5, ADR-0106. A policy the tenant underwrites itself (its
// provider is `is_internal`) cedes under every active treaty that attaches to
// it, the moment `axis.policy.issued` is heard: one cession row per (policy,
// treaty), each posted as an RI-CEDE transaction behind the
// `axis.reinsurance_cession` gate. A policy on another insurer's paper is that
// insurer's to reinsure, and cedes nothing here.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const NOW = Date.UTC(2026, 8, 27, 9);
const DAY = 86_400_000;

let database: Db;
let seeded: SeedResult;
let internalProviderId: string;
let externalProviderId: string;
let reinsurerId: string;
let motorProductId: string;

function ctxAs(actor: Ctx["actor"], now = NOW): Ctx {
  return {
    db: database as unknown as Ctx["db"],
    tenantId: seeded.tenantId,
    actor,
    requestId: "req_ri",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

const scheduler = () => ctxAs({ kind: "system", id: "scheduler", tenantId: seeded.tenantId, grants: [] });
const approver = () =>
  ctxAs({ kind: "user", id: "u_second_pair", tenantId: seeded.tenantId, grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] });

let seq = 0;
async function treaty(over: Partial<typeof schema.axisReinsuranceTreaties.$inferInsert> = {}) {
  const row = {
    id: `rit_${++seq}`,
    tenantId: seeded.tenantId,
    ref: `TRT-${seq}`,
    reinsurerId,
    kind: "quota_share",
    productLine: "motor",
    currency: "AED",
    cededSharePpm: 400_000,
    cedingCommissionPpm: 250_000,
    priority: 0,
    effectiveFrom: NOW - 30 * DAY,
    effectiveTo: NOW + 335 * DAY,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  };
  await database.insert(schema.axisReinsuranceTreaties).values(row);
  return row;
}

async function policy(over: Partial<typeof schema.axisPolicies.$inferInsert> = {}, terms: Record<string, unknown> = {}) {
  const id = `pol_ri_${++seq}`;
  const row = {
    id,
    tenantId: seeded.tenantId,
    customerId: "cus_ri",
    providerId: internalProviderId,
    productId: motorProductId,
    policyNo: `RI-${seq}`,
    startAt: NOW,
    endAt: NOW + 365 * DAY,
    premiumMinor: 10_000,
    grossMinor: 10_500,
    currency: "AED",
    commissionMinor: 0,
    currentVersionId: `pver_${id}`,
    status: "bound",
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  };
  await database.insert(schema.axisPolicies).values(row);
  await database.insert(schema.axisPolicyVersions).values({
    id: `pver_${id}`,
    tenantId: seeded.tenantId,
    policyId: id,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: row.startAt,
    effectiveTo: row.endAt,
    premiumMinor: row.premiumMinor,
    currency: row.currency,
    termsJson: JSON.stringify(terms),
    state: "effective",
    issuedBy: "system:test",
    issuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  return row;
}

const cessionsFor = (policyId: string) =>
  database
    .select()
    .from(schema.axisReinsuranceCessions)
    .where(and(eq(schema.axisReinsuranceCessions.tenantId, seeded.tenantId), eq(schema.axisReinsuranceCessions.policyId, policyId)));

const linesOf = async (txnId: string) => {
  const [txn] = await database.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, txnId));
  return database
    .select()
    .from(schema.ledgerJournalLines)
    .where(and(eq(schema.ledgerJournalLines.tenantId, seeded.tenantId), eq(schema.ledgerJournalLines.batchId, txn!.ledgerBatchId!)));
};

async function issue(c: Ctx, p: { id: string }) {
  await emit(c, { module: "axis", type: "axis.policy.issued", subject: p.id, data: { policyId: p.id } });
  await drainOutbox(c);
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  const providers = await database.select().from(schema.providers).where(eq(schema.providers.tenantId, seeded.tenantId));
  internalProviderId = providers.find((p) => p.isInternal)!.id;
  externalProviderId = providers.find((p) => !p.isInternal && p.kind === "insurer")!.id;
  reinsurerId = providers.find((p) => !p.isInternal && p.id !== externalProviderId)!.id;
  const [motor] = await database
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, seeded.tenantId), eq(schema.products.line, "motor")));
  motorProductId = motor!.id;
}, 180_000);

// Every test writes its own treaties; closing them all afterwards keeps one
// test's treaties out of the next test's plan even when an assertion fails.
afterEach(async () => {
  await database
    .update(schema.axisReinsuranceTreaties)
    .set({ status: "closed" })
    .where(eq(schema.axisReinsuranceTreaties.tenantId, seeded.tenantId));
});

describe("axis.policy.issued cedes the tenant's own underwriting", () => {
  it("raises one cession per attaching treaty, gated, and posts nothing until approved", async () => {
    const qs = await treaty();
    const p = await policy();
    await issue(scheduler(), p);

    const rows = await cessionsFor(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      treatyId: qs.id,
      reinsurerId,
      kind: "quota_share",
      premiumMinor: 10_000,
      cededPremiumMinor: 4_000,
      cedingCommissionMinor: 1_000,
      netPayableMinor: 3_000,
      retainedPremiumMinor: 6_000,
      state: "pending_approval",
      txnId: null
    });
    const [approval] = await database
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, seeded.tenantId), eq(schema.approvals.subjectRef, `axis_cession:${rows[0]!.id}`)));
    expect(approval).toMatchObject({ policyKey: "axis.reinsurance_cession", decision: "pending", requestedBy: "system:scheduler" });

    // The approver's decision is what posts it.
    await decide(approver(), approval!.id, "approved");
    await drainOutbox(scheduler());
    const [posted] = await cessionsFor(p.id);
    expect(posted).toMatchObject({ state: "posted" });
    expect(posted!.txnId).toBeTruthy();
    const lines = await linesOf(posted!.txnId!);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor]).sort()).toEqual([
      ["2000", "debit", 4_000],
      ["2060", "credit", 3_000],
      ["4097", "credit", 1_000]
    ]);
    const payable = lines.find((l) => l.accountCode === "2000")!;
    expect(JSON.parse(payable.dimsJson ?? "{}")).toMatchObject({ item: `policy:${p.id}`, counterparty: `provider:${internalProviderId}` });
    const owed = lines.find((l) => l.accountCode === "2060")!;
    expect(JSON.parse(owed.dimsJson ?? "{}")).toMatchObject({ item: `cession:${posted!.id}`, counterparty: `provider:${reinsurerId}` });

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.subjectRef, posted!.id)));
    expect(audits.map((a) => a.action)).toContain("axis.reinsurance.cede");
    const announced = (await database.select().from(schema.eventOutbox)).filter(
      (e) => e.type === "axis.reinsurance.ceded" && e.envelopeJson.includes(posted!.id)
    );
    expect(announced).toHaveLength(1);

    // Redelivery and a direct re-run change nothing: one row, one transaction.
    await issue(scheduler(), p);
    await cedePolicy(scheduler(), p.id);
    const again = await cessionsFor(p.id);
    expect(again).toHaveLength(1);
    expect(again[0]!.txnId).toBe(posted!.txnId);
    const txns = await database
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, seeded.tenantId), eq(schema.ledgerTxns.type, "RI-CEDE")));
    expect(txns.filter((t) => t.idempotencyKey === `axis.cede:${p.id}:${qs.id}`)).toHaveLength(1);

    await database.update(schema.axisReinsuranceTreaties).set({ status: "closed" }).where(eq(schema.axisReinsuranceTreaties.id, qs.id));
  });

  it("a policy on another insurer's paper is that insurer's to reinsure: nothing is ceded", async () => {
    const qs = await treaty();
    const p = await policy({ providerId: externalProviderId });
    const made = await cedePolicy(scheduler(), p.id);
    expect(made).toEqual([]);
    expect(await cessionsFor(p.id)).toEqual([]);
    await database.update(schema.axisReinsuranceTreaties).set({ status: "closed" }).where(eq(schema.axisReinsuranceTreaties.id, qs.id));
  });

  it("only active treaties in the policy's line, currency and period attach, in priority order, each on what the last left", async () => {
    const qs = await treaty({ cededSharePpm: 500_000, cedingCommissionPpm: 0, priority: 1 });
    const sp = await treaty({
      kind: "surplus",
      cededSharePpm: null,
      retentionMinor: 100_000,
      lines: 2,
      cedingCommissionPpm: 100_000,
      priority: 2
    });
    const others = [
      await treaty({ status: "draft" }),
      await treaty({ productLine: "travel" }),
      await treaty({ currency: "USD" }),
      await treaty({ effectiveFrom: NOW + DAY })
    ];
    const p = await policy({ premiumMinor: 12_000 }, { sumInsuredMinor: 600_000 });

    // Auto-approved by tenant policy: the gate passes and the cession posts at once.
    const auto = { ...scheduler(), policy: PolicyJson.parse({ autoApprove: ["axis.reinsurance_cession"] }) };
    const made = await cedePolicy(auto, p.id);

    expect(made.map((c) => [c.treatyId, c.cededPremiumMinor, c.cededSumInsuredMinor, c.retainedPremiumMinor, c.state])).toEqual([
      [qs.id, 6_000, 300_000, 6_000, "posted"],
      [sp.id, 4_000, 200_000, 2_000, "posted"]
    ]);
    expect(made[1]).toMatchObject({ cedingCommissionMinor: 400, netPayableMinor: 3_600, sumInsuredMinor: 600_000 });
    for (const t of [qs, sp, ...others]) {
      await database.update(schema.axisReinsuranceTreaties).set({ status: "closed" }).where(eq(schema.axisReinsuranceTreaties.id, t.id));
    }
  });

  it("a surplus treaty on a policy with no stated sum insured cedes nothing, and says so out loud", async () => {
    // The risk may well sit above the retention, uncovered: that is a fact for
    // somebody to act on, not a quiet no-op.
    const sp = await treaty({ kind: "surplus", cededSharePpm: null, retentionMinor: 100_000, lines: 2 });
    const p = await policy();
    expect(await cedePolicy(scheduler(), p.id)).toEqual([]);
    const said = (await database.select().from(schema.eventOutbox)).filter(
      (e) => e.type === "axis.reinsurance.unceded" && e.envelopeJson.includes(p.id)
    );
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0]!.envelopeJson).data).toMatchObject({ policyId: p.id, treatyId: sp.id, reason: "no_sum_insured" });
    await database.update(schema.axisReinsuranceTreaties).set({ status: "closed" }).where(eq(schema.axisReinsuranceTreaties.id, sp.id));
  });

  it("with no treaty attaching, a policy cedes nothing and writes nothing", async () => {
    const p = await policy();
    expect(await cedePolicy(scheduler(), p.id)).toEqual([]);
    expect(await cessionsFor(p.id)).toEqual([]);
  });
});

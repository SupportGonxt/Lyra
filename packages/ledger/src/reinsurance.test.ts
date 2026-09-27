import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, account, schema } from "@lyra/db";
import { APPROVAL_POLICIES, autoApproveProblem, planCessions, type Ctx } from "@lyra/core";
import { buildRecipe, reinsuranceCession } from "./recipes.js";
import { TXN_TYPES, autoApprovable } from "./types.js";
import { reverseTxn, runTxn } from "./txn.js";
import { seedTestChart } from "./test-chart.js";

// docs/30 AXIS 5, ADR-0106. RI-CEDE: the tenant, as underwriter, passes a
// share of a policy's premium to a reinsurer and earns a ceding commission on
// it. The premium never became the tenant's revenue (BIND booked it Dr 1200 /
// Cr 2000), so ceding it is a reclassification of that payable, not an expense:
//
//   Dr 2000 Insurer Payable            ceded premium
//     Cr 2060 Reinsurance Payable        ceded − ceding commission
//     Cr 4097 Ceding Commission          ceding commission

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
  .map((s) => s.trim())
  .filter(Boolean);
const NOW = Date.UTC(2026, 8, 27, 12);

async function freshCtx(): Promise<Ctx> {
  const client = createClient({ url: ":memory:" });
  for (const sql of SQL) await client.execute(sql);
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_ri",
    actor: { kind: "system", id: "scheduler", tenantId: "t_ri", grants: [] },
    requestId: "req_ri",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
  return ctx;
}

const sum = (ls: readonly { side: string; amountMinor: number }[], side: string, code?: string) =>
  ls.filter((l) => l.side === side && (code === undefined || (l as { accountCode?: string }).accountCode === code))
    .reduce((s, l) => s + l.amountMinor, 0);

describe("the chart carries the two reinsurance accounts", () => {
  it("2060 is a liability and 4097 income, both credit-normal, neither client money", () => {
    expect(account("2060")).toMatchObject({ type: "liability", normalSide: "credit" });
    expect(account("4097")).toMatchObject({ type: "income", normalSide: "credit" });
    expect(account("2060")?.clientMoney).toBeUndefined();
    expect(account("4097")?.clientMoney).toBeUndefined();
    expect(account("2060")?.ar).not.toBe(account("2060")?.en);
    expect(account("4097")?.ar).not.toBe(account("4097")?.en);
  });
});

describe("reinsuranceCession", () => {
  it("reclassifies the ceded premium from the insurer payable to the reinsurer, net of its commission", () => {
    const built = reinsuranceCession({ cededPremiumMinor: 4_000, cedingCommissionMinor: 1_000, dims: { policy: "pol_1" } });
    expect(built.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["2000", "debit", 4_000],
      ["2060", "credit", 3_000],
      ["4097", "credit", 1_000]
    ]);
    expect(built.every((l) => l.dims?.["policy"] === "pol_1")).toBe(true);
  });

  it("the payable leg keeps the policy's open item; the reinsurer's legs name the reinsurer", () => {
    const built = reinsuranceCession({
      cededPremiumMinor: 4_000,
      cedingCommissionMinor: 1_000,
      dims: { item: "policy:pol_1", counterparty: "provider:us", policy: "pol_1" },
      reinsurerDims: { item: "cession:ric_1", counterparty: "provider:re" }
    });
    expect(built.map((l) => [l.accountCode, l.dims?.["item"], l.dims?.["counterparty"], l.dims?.["policy"]])).toEqual([
      ["2000", "policy:pol_1", "provider:us", "pol_1"],
      ["2060", "cession:ric_1", "provider:re", "pol_1"],
      ["4097", "cession:ric_1", "provider:re", "pol_1"]
    ]);
  });

  it("with no commission, posts no zero income leg", () => {
    const built = reinsuranceCession({ cededPremiumMinor: 4_000 });
    expect(built.map((l) => l.accountCode)).toEqual(["2000", "2060"]);
  });

  it("with the whole ceded premium given back, posts no zero payable leg", () => {
    const built = reinsuranceCession({ cededPremiumMinor: 4_000, cedingCommissionMinor: 4_000 });
    expect(built.map((l) => l.accountCode)).toEqual(["2000", "4097"]);
  });

  it("refuses a commission larger than what was ceded", () => {
    expect(() => reinsuranceCession({ cededPremiumMinor: 1_000, cedingCommissionMinor: 1_001 })).toThrow();
  });

  it("refuses to be pointed at client money or equity", () => {
    for (const over of [
      { insurerPayableAccount: "1010" },
      { reinsurancePayableAccount: "2010" },
      { commissionIncomeAccount: "3100" }
    ]) {
      expect(() => reinsuranceCession({ cededPremiumMinor: 1_000, cedingCommissionMinor: 100, ...over })).toThrow();
    }
  });

  it("is the RI-CEDE row of the catalogue, with its accounts defaulted", () => {
    const built = buildRecipe("RI-CEDE", { cededPremiumMinor: 2_500, cedingCommissionMinor: 500 });
    expect(built.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["2000", "debit", 2_500],
      ["2060", "credit", 2_000],
      ["4097", "credit", 500]
    ]);
    expect(() => buildRecipe("RI-CEDE", { cededPremiumMinor: 0 })).toThrow();
  });
});

describe("RI-CEDE in the catalogue", () => {
  it("is financial and gated by its own approval policy", () => {
    expect(TXN_TYPES["RI-CEDE"]).toMatchObject({ code: "RI-CEDE", financial: true, approval: "axis.reinsurance_cession" });
  });

  it("is neither a payout nor client money: nothing leaves the business when a cession is booked", () => {
    expect(TXN_TYPES["RI-CEDE"]?.payout).toBeUndefined();
    expect(TXN_TYPES["RI-CEDE"]?.clientMoney).toBeUndefined();
    expect(autoApprovable("RI-CEDE")).toBe(true);
  });

  it("names a policy decided by the reinsurance approvers, with a second pair of eyes above threshold", () => {
    const policy = APPROVAL_POLICIES["axis.reinsurance_cession"];
    expect(policy).toMatchObject({ module: "axis", decide: "axis:reinsurance:approve", dualControl: "above_threshold" });
    expect(policy?.defaultThresholdMinor).toBeGreaterThan(0);
    // System-derived from an approved treaty, like a commission accrual: a
    // tenant may choose to automate it (docs/19 §7).
    expect(autoApproveProblem(["axis.reinsurance_cession"])).toBeNull();
  });
});

describe("invariants, for any cession", () => {
  it("balances, debits 2000 by exactly the ceded premium, and never touches client money", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e12 }), fc.integer({ min: 0, max: 1_000_000 }), (ceded, ppm) => {
        const commission = Math.floor((ceded * ppm) / 1_000_000);
        const built = buildRecipe("RI-CEDE", { cededPremiumMinor: ceded, cedingCommissionMinor: commission });
        expect(sum(built, "debit")).toBe(sum(built, "credit"));
        expect(sum(built, "debit", "2000")).toBe(ceded);
        expect(sum(built, "credit", "2060") + sum(built, "credit", "4097")).toBe(ceded);
        expect(built.some((l) => account(l.accountCode)?.clientMoney)).toBe(false);
        expect(built.every((l) => l.amountMinor > 0)).toBe(true);
      }),
      { numRuns: 300 }
    );
  });

  it("across a whole plan, the premium taken off the insurer payable plus what is retained is the policy's premium", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e10 }),
        fc.integer({ min: 0, max: 1e11 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1e10 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (premiumMinor, si, share, retention, lines, commissionPpm) => {
          const plan = planCessions({
            premiumMinor,
            sumInsuredMinor: si,
            treaties: [
              { id: "qs", kind: "quota_share", cededSharePpm: share, cedingCommissionPpm: commissionPpm },
              { id: "sp", kind: "surplus", retentionMinor: retention, lines, cedingCommissionPpm: commissionPpm }
            ]
          });
          let offPayable = 0;
          for (const c of plan.cessions) {
            const built = buildRecipe("RI-CEDE", {
              cededPremiumMinor: c.cededPremiumMinor,
              cedingCommissionMinor: c.commissionMinor
            });
            expect(sum(built, "debit")).toBe(sum(built, "credit"));
            offPayable += sum(built, "debit", "2000");
          }
          expect(offPayable + plan.retainedPremiumMinor).toBe(premiumMinor);
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe("RI-CEDE through the transaction engine", () => {
  const input = { type: "RI-CEDE", idempotencyKey: "axis.cede:pol_1:rit_1", currency: "AED", grossMinor: 4_000 };
  const recipe = () => ({ lines: buildRecipe("RI-CEDE", { cededPremiumMinor: 4_000, cedingCommissionMinor: 1_000 }), currency: "AED" });

  it("waits on an approval and posts nothing until one is given", async () => {
    const ctx = await freshCtx();
    await expect(runTxn(ctx, input, { recipe: recipe(), approvalSubjectRef: "axis_cession:ric_1" })).rejects.toMatchObject({
      code: "approval_required"
    });
    const [txn] = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
    expect(txn?.state).toBe("validated");
    const lines = await ctx.db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));
    expect(lines).toEqual([]);
    const [approval] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, ctx.tenantId), eq(schema.approvals.subjectRef, "axis_cession:ric_1")));
    expect(approval).toMatchObject({ policyKey: "axis.reinsurance_cession", decision: "pending" });
  });

  it("once approved, posts one balanced batch; a replay posts nothing new; a reversal nets to zero", async () => {
    const ctx = await freshCtx();
    const txn = await runTxn(ctx, input, { recipe: recipe(), preApproved: true });
    expect(txn.state).toBe("settled");
    await runTxn(ctx, input, { recipe: recipe(), preApproved: true });
    const batches = await ctx.db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId));
    expect(batches).toHaveLength(1);

    await reverseTxn(ctx, txn.id, "policy cancelled from inception");
    const rows = await ctx.db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));
    for (const code of ["2000", "2060", "4097"]) {
      const net = rows
        .filter((r) => r.accountCode === code)
        .reduce((s, r) => s + (r.side === "debit" ? r.amountMinor : -r.amountMinor), 0);
      expect(net).toBe(0);
    }
  });
});

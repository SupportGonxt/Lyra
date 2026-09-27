import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import {
  assertPeriodCode,
  budgetVsActual,
  compareBudgets,
  type BudgetAccount,
  type BudgetEntry,
  type Movement
} from "./budgets.js";
import { post, type PostingLine } from "./posting.js";
import { seedTestChart } from "./test-chart.js";

// docs/30 Ledger 4, ADR-0104. A budget is a plan for one account, one month,
// one currency; the actual is what the posted lines did to that account in that
// month in that currency. Variance is actual less budget. Nothing here ever adds
// an AED figure to a USD one.

const CHART = new Map<string, BudgetAccount>([
  ["1000", { name: "Cash – Operating", type: "asset", normalSide: "debit" }],
  ["2000", { name: "Insurer Payable", type: "liability", normalSide: "credit" }],
  ["4000", { name: "Commission – New", type: "income", normalSide: "credit" }],
  ["5100", { name: "Media Spend", type: "expense", normalSide: "debit" }]
]);

const budget = (accountCode: string, currency: string, amountMinor: number): BudgetEntry => ({
  accountCode,
  currency,
  amountMinor
});
const moved = (accountCode: string, currency: string, debitMinor: number, creditMinor: number): Movement => ({
  accountCode,
  currency,
  debitMinor,
  creditMinor
});

describe("compareBudgets (pure)", () => {
  it("measures an expense against its budget on its normal side", () => {
    const [row] = compareBudgets([budget("5100", "AED", 10_000)], [moved("5100", "AED", 9_000, 500)], CHART);
    expect(row).toEqual({
      accountCode: "5100",
      name: "Media Spend",
      type: "expense",
      currency: "AED",
      budgetMinor: 10_000,
      actualMinor: 8_500,
      varianceMinor: -1_500,
      variancePpm: -150_000,
      favourable: true
    });
  });

  it("reads a credit-normal account as credit less debit, and income over plan is favourable", () => {
    const [row] = compareBudgets([budget("4000", "AED", 20_000)], [moved("4000", "AED", 1_000, 26_000)], CHART);
    expect(row!.actualMinor).toBe(25_000);
    expect(row!.varianceMinor).toBe(5_000);
    expect(row!.variancePpm).toBe(250_000);
    expect(row!.favourable).toBe(true);
  });

  it("calls an expense over plan unfavourable and income under plan unfavourable", () => {
    const rows = compareBudgets(
      [budget("5100", "AED", 100), budget("4000", "AED", 100)],
      [moved("5100", "AED", 150, 0), moved("4000", "AED", 0, 50)],
      CHART
    );
    expect(rows.map((r) => [r.accountCode, r.favourable])).toEqual([
      ["4000", false],
      ["5100", false]
    ]);
  });

  it("is honest when there is no budget: no variance, no percentage, no verdict", () => {
    const [row] = compareBudgets([], [moved("5100", "AED", 700, 0)], CHART);
    expect(row).toMatchObject({ budgetMinor: null, actualMinor: 700, varianceMinor: null, variancePpm: null, favourable: null });
  });

  it("shows a budget nothing was posted against as a full shortfall", () => {
    const [row] = compareBudgets([budget("4000", "AED", 5_000)], [], CHART);
    expect(row).toMatchObject({ budgetMinor: 5_000, actualMinor: 0, varianceMinor: -5_000, variancePpm: -1_000_000 });
  });

  it("gives no percentage against a zero budget — a ratio to nothing is not a number", () => {
    const [row] = compareBudgets([budget("5100", "AED", 0)], [moved("5100", "AED", 300, 0)], CHART);
    expect(row).toMatchObject({ budgetMinor: 0, varianceMinor: 300, variancePpm: null, favourable: false });
  });

  it("never sums across currencies: a USD budget is not met by AED spend", () => {
    const rows = compareBudgets([budget("5100", "USD", 1_000)], [moved("5100", "AED", 3_672, 0)], CHART);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.currency === "USD")).toMatchObject({ budgetMinor: 1_000, actualMinor: 0, varianceMinor: -1_000 });
    expect(rows.find((r) => r.currency === "AED")).toMatchObject({ budgetMinor: null, actualMinor: 3_672 });
  });

  it("lists unbudgeted movement on income and expense only; a budgeted balance-sheet account is kept", () => {
    const rows = compareBudgets(
      [budget("2000", "AED", 400)],
      [moved("1000", "AED", 900, 0), moved("2000", "AED", 0, 300), moved("5100", "AED", 900, 0)],
      CHART
    );
    expect(rows.map((r) => r.accountCode)).toEqual(["2000", "5100"]);
    // No income/expense direction on a liability: the variance is stated, the verdict is not.
    expect(rows[0]).toMatchObject({ actualMinor: 300, varianceMinor: -100, favourable: null });
  });

  it("names an account the chart no longer holds by its code", () => {
    const [row] = compareBudgets([budget("9999", "AED", 1)], [], CHART);
    expect(row).toMatchObject({ accountCode: "9999", name: "9999", type: "unknown" });
  });

  it("refuses two budgets for the same account, month and currency", () => {
    expect(() => compareBudgets([budget("5100", "AED", 1), budget("5100", "AED", 2)], [], CHART)).toThrow(
      expect.objectContaining({ detail: expect.stringMatching(/twice/) })
    );
  });

  it("sorts by account, then currency", () => {
    const rows = compareBudgets(
      [budget("5100", "USD", 1), budget("4000", "AED", 1), budget("5100", "AED", 1)],
      [],
      CHART
    );
    expect(rows.map((r) => `${r.accountCode}/${r.currency}`)).toEqual(["4000/AED", "5100/AED", "5100/USD"]);
  });

  it("property: every row keeps one currency, variance is actual less budget, and each currency's actuals add up alone", () => {
    const code = fc.constantFrom("4000", "5100");
    const ccy = fc.constantFrom("AED", "USD", "EUR");
    const amt = fc.integer({ min: 0, max: 1_000_000 });
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ accountCode: code, currency: ccy, amountMinor: amt }), {
          selector: (b) => `${b.accountCode}/${b.currency}`
        }),
        fc.array(fc.record({ accountCode: code, currency: ccy, debitMinor: amt, creditMinor: amt })),
        (budgets, movements) => {
          const rows = compareBudgets(budgets, movements, CHART);
          for (const r of rows) {
            if (r.budgetMinor === null) expect(r.varianceMinor).toBeNull();
            else expect(r.varianceMinor).toBe(r.actualMinor - r.budgetMinor);
          }
          for (const currency of ["AED", "USD", "EUR"]) {
            const expected = movements
              .filter((m) => m.currency === currency)
              .reduce((s, m) => s + (CHART.get(m.accountCode)!.normalSide === "debit" ? m.debitMinor - m.creditMinor : m.creditMinor - m.debitMinor), 0);
            const got = rows.filter((r) => r.currency === currency).reduce((s, r) => s + r.actualMinor, 0);
            expect(got).toBe(expected);
          }
          const keys = new Set([...budgets, ...movements].map((x) => `${x.accountCode}/${x.currency}`));
          expect(rows.map((r) => `${r.accountCode}/${r.currency}`).sort()).toEqual([...keys].sort());
        }
      )
    );
  });
});

describe("assertPeriodCode", () => {
  it("accepts a calendar month and refuses anything else", () => {
    expect(() => assertPeriodCode("2026-06")).not.toThrow();
    for (const bad of ["2026-13", "2026-00", "2026-6", "26-06", "2026-06-01", ""]) {
      expect(() => assertPeriodCode(bad), bad).toThrow();
    }
  });
});

/* ------------------------------------------------------ against the journal */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

describe("budgetVsActual (posted lines)", () => {
  const JUNE_MID = Date.UTC(2026, 5, 15, 12);
  let ctx: Ctx;
  let n = 0;

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    ctx = {
      db: drizzle(client) as unknown as Ctx["db"],
      tenantId: "t_test",
      actor: { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
      requestId: "req_test",
      now: Date.UTC(2026, 6, 20),
      locale: "en",
      policy: PolicyJson.parse({}), // AED base
      entitlements: EntitlementsJson.parse({})
    };
    await seedTestChart(ctx);
  });

  const dr = (accountCode: string, amountMinor: number): PostingLine => ({ accountCode, side: "debit", amountMinor });
  const cr = (accountCode: string, amountMinor: number): PostingLine => ({ accountCode, side: "credit", amountMinor });

  async function book(type: string, currency: string, lines: PostingLine[], postedAt: number, tenantId = ctx.tenantId) {
    const id = `txn_${++n}`;
    const c = { ...ctx, tenantId };
    await c.db.insert(schema.ledgerTxns).values({
      id,
      tenantId,
      type,
      version: 1,
      idempotencyKey: id,
      state: "settled",
      actorKind: "system",
      actorId: "sys",
      currency,
      baseCurrency: "AED",
      grossMinor: 0,
      baseGrossMinor: 0,
      createdAt: postedAt,
      updatedAt: postedAt
    });
    await post(c, {
      txnId: id,
      currency,
      baseCurrency: "AED",
      fxRatePpm: currency === "AED" ? 1_000_000 : 3_672_500,
      lines,
      postedAt
    });
  }

  async function plan(accountCode: string, currency: string, amountMinor: number, period = "2026-06", tenantId = ctx.tenantId) {
    await ctx.db.insert(schema.ledgerBudgets).values({
      id: `bud_${++n}`,
      tenantId,
      accountCode,
      period,
      currency,
      amountMinor,
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
  }

  it("compares each month's budget with that month's lines, per currency, in transaction currency", async () => {
    await book("MANUAL", "AED", [dr("5100", 8_000), cr("1000", 8_000)], JUNE_MID);
    await book("MANUAL", "USD", [dr("5100", 1_000), cr("1000", 1_000)], JUNE_MID);
    await book("MANUAL", "AED", [dr("5100", 5_000), cr("1000", 5_000)], Date.UTC(2026, 6, 2)); // July
    await book("CMSN-ACCR", "AED", [dr("1100", 30_000), cr("4000", 30_000)], JUNE_MID);
    await plan("5100", "AED", 10_000);
    await plan("5100", "USD", 800);
    await plan("5100", "AED", 99_999, "2026-07");

    const report = await budgetVsActual(ctx, "2026-06");

    expect(report.periodCode).toBe("2026-06");
    expect(report.from).toBe(Date.UTC(2026, 5, 1));
    expect(report.to).toBe(Date.UTC(2026, 6, 1) - 1);
    expect(report.rows.map((r) => [r.accountCode, r.currency, r.budgetMinor, r.actualMinor, r.varianceMinor])).toEqual([
      ["4000", "AED", null, 30_000, null],
      ["5100", "AED", 10_000, 8_000, -2_000],
      // 1,000 USD, never its 3,672.50 AED base equivalent.
      ["5100", "USD", 800, 1_000, 200]
    ]);
  });

  it("leaves a year-end close out: moving profit to retained earnings is not performance", async () => {
    await book("CMSN-ACCR", "AED", [dr("1100", 30_000), cr("4000", 30_000)], JUNE_MID);
    await book("YEAR-END-CLOSE", "AED", [dr("4000", 30_000), cr("3100", 30_000)], JUNE_MID + 1);
    await plan("4000", "AED", 25_000);

    const [row] = (await budgetVsActual(ctx, "2026-06")).rows;
    expect(row).toMatchObject({ accountCode: "4000", actualMinor: 30_000, varianceMinor: 5_000 });
  });

  it("reads only its own tenant's budgets and lines", async () => {
    await seedTestChart({ ...ctx, tenantId: "t_other" });
    await book("MANUAL", "AED", [dr("5100", 4_000), cr("1000", 4_000)], JUNE_MID, "t_other");
    await plan("5100", "AED", 7_000, "2026-06", "t_other");

    expect((await budgetVsActual(ctx, "2026-06")).rows).toEqual([]);
  });

  it("refuses a period that is not a month", async () => {
    await expect(budgetVsActual(ctx, "2026-6")).rejects.toThrow();
  });
});

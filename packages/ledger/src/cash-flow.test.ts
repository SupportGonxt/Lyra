import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { cashFlowStatement } from "./reports.js";
import { post, type PostingLine } from "./posting.js";
import { seedTestChart } from "./test-chart.js";

// docs/19 §5.4, ADR-0090. IAS 7, indirect method: profit, adjusted for what did
// not move cash, plus the working-capital movement — proved against cash itself.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const JUNE = Date.UTC(2026, 5, 1);
const NOW = Date.UTC(2026, 5, 15, 12);
const WINDOW = { from: JUNE, to: NOW };
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
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}), // AED base
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
});

const dr = (accountCode: string, amountMinor: number): PostingLine => ({ accountCode, side: "debit", amountMinor });
const cr = (accountCode: string, amountMinor: number): PostingLine => ({ accountCode, side: "credit", amountMinor });

/** One settled txn of `type`, posted at `postedAt` in AED. */
async function book(type: string, lines: PostingLine[], postedAt = NOW - 1000): Promise<void> {
  const id = `txn_${++n}`;
  await ctx.db.insert(schema.ledgerTxns).values({
    id,
    tenantId: ctx.tenantId,
    type,
    version: 1,
    idempotencyKey: id,
    state: "settled",
    actorKind: "system",
    actorId: "sys",
    currency: "AED",
    baseCurrency: "AED",
    grossMinor: 0,
    baseGrossMinor: 0,
    createdAt: postedAt,
    updatedAt: postedAt
  });
  await post(ctx, { txnId: id, currency: "AED", baseCurrency: "AED", fxRatePpm: 1_000_000, lines, postedAt });
}

const row = (rows: { accountCode: string; amountMinor: number }[], code: string) =>
  rows.find((r) => r.accountCode === code)?.amountMinor;

describe("cashFlowStatement (IAS 7, indirect)", () => {
  it("starts from profit and adjusts for working capital, proved against cash", async () => {
    await book("CMSN-ACCR", [dr("1100", 1000), cr("4000", 1000)]); // earned, not yet received
    await book("CMSN-SETL", [dr("1000", 600), cr("1100", 600)]); // received in part
    await book("MANUAL", [dr("5100", 200), cr("1000", 200)]); // media paid in cash

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(cf.profitMinor).toBe(800);
    expect(row(cf.operating.rows, "1100")).toBe(-400); // receivable grew: cash not yet in
    expect(cf.operating.totalMinor).toBe(400);
    expect(cf.investing.totalMinor).toBe(0);
    expect(cf.financing.totalMinor).toBe(0);
    expect(cf.netIncreaseMinor).toBe(400);
    expect(cf.openingCashMinor).toBe(0);
    expect(cf.closingCashMinor).toBe(400);
    expect(cf.reconciled).toBe(true);
  });

  it("opens on the cash held before the window", async () => {
    await book("MANUAL-EQUITY", [dr("1000", 5000), cr("3000", 5000)], JUNE - 86_400_000);
    await book("MANUAL", [dr("5100", 100), cr("1000", 100)]);

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(cf.openingCashMinor).toBe(5000);
    expect(cf.closingCashMinor).toBe(4900);
    // The capital came in before the window, so it is not this window's financing.
    expect(cf.financing.totalMinor).toBe(0);
    expect(cf.reconciled).toBe(true);
  });

  it("puts capital raised under financing", async () => {
    await book("MANUAL-EQUITY", [dr("1000", 5000), cr("3000", 5000)]);
    const cf = await cashFlowStatement(ctx, WINDOW);
    expect(row(cf.financing.rows, "3000")).toBe(5000);
    expect(cf.netIncreaseMinor).toBe(5000);
    expect(cf.reconciled).toBe(true);
  });

  it("leaves client money out of cash and discloses it as restricted (IAS 7.48)", async () => {
    await book("CM-RECEIPT", [dr("1010", 700), cr("2010", 700)]);

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(cf.closingCashMinor).toBe(0);
    expect(cf.netIncreaseMinor).toBe(0);
    expect(cf.restrictedCashMinor).toBe(700);
    expect(cf.reconciled).toBe(true);
  });

  it("ignores the year-end close: it moves profit into equity and no cash", async () => {
    await book("CMSN-SETL", [dr("1000", 900), cr("4000", 900)]);
    await book("YEAR-END-CLOSE", [dr("4000", 900), cr("3100", 900)]);

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(cf.profitMinor).toBe(900);
    expect(cf.financing.totalMinor).toBe(0);
    expect(cf.netIncreaseMinor).toBe(900);
    expect(cf.reconciled).toBe(true);
  });

  it("shows revaluation of cash as the effect of exchange rates, not as operating (IAS 7.28)", async () => {
    await book("CMSN-SETL", [dr("1000", 1000), cr("4000", 1000)]);
    await book("FX-REVAL", [dr("1000", 50), cr("4095", 50)]);

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(cf.profitMinor).toBe(1050);
    expect(cf.nonCashFxMinor).toBe(-50);
    expect(cf.operating.totalMinor).toBe(1000);
    expect(cf.fxEffectMinor).toBe(50);
    expect(cf.netIncreaseMinor).toBe(1000);
    expect(cf.closingCashMinor).toBe(1050);
    expect(cf.reconciled).toBe(true);
  });

  it("follows an account's own class: equipment a tenant added is investing", async () => {
    await ctx.db.insert(schema.ledgerAccounts).values({
      id: "acc_equipment",
      tenantId: ctx.tenantId,
      code: "1500",
      nameJson: JSON.stringify({ en: "Equipment", ar: "المعدات" }),
      type: "asset",
      normalSide: "debit",
      cashFlow: "investing",
      status: "active",
      createdAt: NOW
    });
    await book("MANUAL-EQUITY", [dr("1000", 5000), cr("3000", 5000)]);
    await book("MANUAL", [dr("1500", 300), cr("1000", 300)]);

    const cf = await cashFlowStatement(ctx, WINDOW);

    expect(row(cf.investing.rows, "1500")).toBe(-300);
    expect(cf.operating.rows.find((r) => r.accountCode === "1500")).toBeUndefined();
    expect(cf.reconciled).toBe(true);
  });

  it("refuses a window that ends before it starts", async () => {
    await expect(cashFlowStatement(ctx, { from: NOW, to: JUNE })).rejects.toMatchObject({ status: 400, detail: expect.stringMatching(/before/) });
  });

  // Every batch balances, so cash moved by exactly what everything else moved
  // by. The statement is that identity, bucketed — it must hold for any book.
  it("reconciles for any balanced set of postings", async () => {
    // 1010 is left out: the ledger refuses a client-money float going negative,
    // which a random book does constantly; the restricted-cash test covers it.
    const codes = ["1000", "1100", "2000", "3000", "3100", "4000", "4095", "5100"];
    const types = ["MANUAL", "YEAR-END-CLOSE", "FX-REVAL"];
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            debit: fc.constantFrom(...codes),
            credit: fc.constantFrom(...codes),
            amount: fc.integer({ min: 1, max: 1_000_000 }),
            type: fc.constantFrom(...types),
            before: fc.boolean()
          }),
          { minLength: 1, maxLength: 8 }
        ),
        async (entries) => {
          const tenantId = `t_prop_${++n}`;
          ctx = { ...ctx, tenantId, actor: { ...ctx.actor, tenantId } };
          await seedTestChart(ctx);
          for (const e of entries) {
            // A close is what the YEAR-END-CLOSE recipe posts: profit accounts
            // against retained earnings, never cash.
            const [debit, credit] = e.type === "YEAR-END-CLOSE" ? ["4000", "3100"] : [e.debit, e.credit];
            if (debit === credit) continue;
            await book(e.type, [dr(debit, e.amount), cr(credit, e.amount)], e.before ? JUNE - 1000 : NOW - 1000);
          }
          const cf = await cashFlowStatement(ctx, WINDOW);
          expect(cf.reconciled).toBe(true);
          expect(cf.openingCashMinor + cf.netIncreaseMinor + cf.fxEffectMinor).toBe(cf.closingCashMinor);
        }
      ),
      { numRuns: 40 }
    );
  });
});

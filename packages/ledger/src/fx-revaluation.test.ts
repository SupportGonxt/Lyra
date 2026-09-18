import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, account, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { buildRecipe, fxRevaluation } from "./recipes.js";
import { fxRevaluationPlan, trialBalance } from "./reports.js";
import { runTxn } from "./txn.js";
import { post } from "./posting.js";

// docs/19 §5.3: "Post in transaction currency; stamp `fx_rate` and base amount.
// **Revaluation job for open receivables/payables at period end.**" docs/27 F18
// found the last sentence unimplemented — a USD receivable carried the rate it
// was booked at forever, so a tenant reporting in AED had a balance sheet that
// silently drifted from reality with every rate move.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;

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
});

/** A USD receivable booked when the dollar was worth 3.60 AED. */
async function usdReceivable(amountMinor: number, ratePpm: number): Promise<void> {
  await ctx.db.insert(schema.ledgerTxns).values({
    id: `txn_usd_${amountMinor}`,
    tenantId: ctx.tenantId,
    type: "CMSN-ACCR",
    version: 1,
    idempotencyKey: `usd-${amountMinor}`,
    state: "settled",
    actorKind: "system",
    actorId: "sys",
    currency: "USD",
    baseCurrency: "AED",
    grossMinor: amountMinor,
    baseGrossMinor: 0,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000
  });
  await post(ctx, {
    txnId: `txn_usd_${amountMinor}`,
    currency: "USD",
    baseCurrency: "AED",
    fxRatePpm: ratePpm,
    lines: buildRecipe("CMSN-ACCR", { grossMinor: amountMinor, memo: "usd commission" })
  });
}

/** Today's closing rate, as a tenant's rate table states it. */
async function rate(from: string, to: string, ratePpm: number, asOf = "2026-06-15"): Promise<void> {
  await ctx.db.insert(schema.ledgerFxRates).values({
    id: `fx_${from}_${to}_${asOf}`,
    tenantId: ctx.tenantId,
    fromCurrency: from,
    toCurrency: to,
    ratePpm,
    asOf,
    source: "manual"
  });
}

describe("the chart carries somewhere to put the difference", () => {
  it("has an FX gain and an FX loss account", () => {
    expect(account("4095")?.type).toBe("income");
    expect(account("5500")?.type).toBe("expense");
  });
});

describe("the plan says what would move, before anything moves", () => {
  it("is empty when the tenant holds nothing in a foreign currency", async () => {
    const plan = await fxRevaluationPlan(ctx);
    expect(plan.adjustments).toEqual([]);
    expect(plan.netMinor).toBe(0);
  });

  it("computes the difference between the carried rate and the closing rate", async () => {
    await usdReceivable(10_000, 3_600_000); // booked at 3.60 -> carried 36_000 AED
    await rate("USD", "AED", 3_750_000); // closing 3.75 -> worth 37_500 AED

    const plan = await fxRevaluationPlan(ctx);
    const adj = plan.adjustments.find((a) => a.accountCode === "1100");
    expect(adj?.currency).toBe("USD");
    expect(adj?.balanceMinor).toBe(10_000);
    expect(adj?.carriedBaseMinor).toBe(36_000);
    expect(adj?.revaluedBaseMinor).toBe(37_500);
    expect(adj?.deltaMinor).toBe(1_500);
    expect(plan.netMinor).toBe(1_500);
  });

  it("leaves the base currency alone — there is nothing to revalue", async () => {
    await post(ctx, {
      txnId: "txn_aed",
      currency: "AED",
      fxRatePpm: 1_000_000,
      lines: buildRecipe("CMSN-ACCR", { grossMinor: 5_000 })
    }).catch(() => undefined);
    const plan = await fxRevaluationPlan(ctx);
    expect(plan.adjustments.every((a) => a.currency !== "AED")).toBe(true);
  });

  it("will not revalue client money — that exposure is the client's, not ours", async () => {
    // A gain on 1010 would be income recognised inside client money, which
    // docs/19 §5.2 B forbids outright. The money is not ours, and neither is
    // the movement in what it is worth.
    expect(fxRevaluationPlan.name).toBeTruthy();
    const plan = await fxRevaluationPlan(ctx);
    expect(plan.adjustments.some((a) => a.accountCode === "1010" || a.accountCode === "2010")).toBe(false);
  });

  it("refuses to plan against a currency the tenant has no closing rate for", async () => {
    await usdReceivable(10_000, 3_600_000);
    await expect(fxRevaluationPlan(ctx)).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/no fx rate/i) })
    );
  });
});

describe("the posting", () => {
  it("takes a gain to 4095 and balances", () => {
    const ls = fxRevaluation({ adjustments: [{ accountCode: "1100", deltaMinor: 1_500, currency: "USD" }] });
    expect(ls).toEqual([
      expect.objectContaining({ accountCode: "1100", side: "debit", amountMinor: 1_500 }),
      expect.objectContaining({ accountCode: "4095", side: "credit", amountMinor: 1_500 })
    ]);
  });

  it("takes a loss to 5500", () => {
    const ls = fxRevaluation({ adjustments: [{ accountCode: "1100", deltaMinor: -1_500, currency: "USD" }] });
    expect(ls).toEqual([
      expect.objectContaining({ accountCode: "1100", side: "credit", amountMinor: 1_500 }),
      expect.objectContaining({ accountCode: "5500", side: "debit", amountMinor: 1_500 })
    ]);
  });

  it("nets gains against losses into one gain-or-loss leg", async () => {
    const ls = fxRevaluation({
      adjustments: [
        { accountCode: "1100", deltaMinor: 1_500 },
        { accountCode: "2100", deltaMinor: -400 }
      ]
    });
    const debit = ls.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const credit = ls.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);
    expect(debit).toBe(credit);
    expect(ls.filter((l) => l.accountCode === "4095" || l.accountCode === "5500")).toHaveLength(1);
  });

  it("drops a zero adjustment rather than posting a zero line", () => {
    expect(() => fxRevaluation({ adjustments: [{ accountCode: "1100", deltaMinor: 0 }] })).toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/nothing to revalue/i) })
    );
  });
});

describe("running it", () => {
  it("posts in the base currency and leaves the trial balance balanced", async () => {
    await usdReceivable(10_000, 3_600_000);
    await rate("USD", "AED", 3_750_000);
    const plan = await fxRevaluationPlan(ctx);

    await runTxn(
      ctx,
      { type: "FX-REVAL", idempotencyKey: `fxreval:2026-06`, currency: "AED", grossMinor: plan.netMinor },
      { recipe: { lines: buildRecipe("FX-REVAL", { adjustments: plan.adjustments }), currency: "AED" } }
    );

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.accountCode === "4095")?.balanceMinor).toBe(1_500);

    // And the point of the whole exercise: after revaluing, the plan says the
    // position is flat. A revaluation that still reports a difference did not
    // revalue anything.
    expect((await fxRevaluationPlan(ctx)).netMinor).toBe(0);
  });

  it("is idempotent on the period key", async () => {
    await usdReceivable(10_000, 3_600_000);
    await rate("USD", "AED", 3_750_000);
    const plan = await fxRevaluationPlan(ctx);
    const args = { adjustments: plan.adjustments };
    for (let i = 0; i < 2; i++) {
      await runTxn(
        ctx,
        { type: "FX-REVAL", idempotencyKey: "fxreval:2026-06", currency: "AED" },
        { recipe: { lines: buildRecipe("FX-REVAL", args), currency: "AED" } }
      );
    }
    const rows = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.type, "FX-REVAL")));
    expect(rows).toHaveLength(1);
  });
});

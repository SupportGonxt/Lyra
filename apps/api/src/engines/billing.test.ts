import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { recordUsage, invoiceNumber, sweepBilling, subscribeToDataProduct, deliverDataProduct } from "./billing.js";
import { seedTestChart } from "@lyra/ledger/test-chart";

// Group C revenue lines (docs/specs revenue lines full build design, task 3):
// recordUsage() had no real writer, only the schema and a hand-fixtured seed
// row. This covers it actually upserting the period's usage-meter row,
// accumulating across calls, and refusing to double-count a replayed
// idempotency key.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function actor(): Actor {
  return {
    kind: "system",
    id: "scheduler",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

async function makeCtx(now = 1_700_000_000_000): Promise<Ctx> {
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({ currency: "USD" }),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
  return ctx;
}

/** Fresh in-memory db + migrations + ctx, for describe blocks that don't need a shared beforeEach. */
async function testCtx(now = 1_700_000_000_000): Promise<Ctx> {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  return makeCtx(now);
}

describe("recordUsage", () => {
  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    ctx = await makeCtx();
  });

  it("creates a usage meter row on first call and posts USAGE-METER", async () => {
    const result = await recordUsage(ctx, {
      subscriptionId: "sub1",
      meter: "api-calls",
      period: "2026-08",
      delta: 100,
      includedQuantity: 1000,
      idempotencyKey: "usage:sub1:api-calls:2026-08:1"
    });
    expect(result.quantity).toBe(100);

    const [row] = await ctx.db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(
        and(
          eq(schema.ledgerUsageMeters.tenantId, ctx.tenantId),
          eq(schema.ledgerUsageMeters.id, result.meterId)
        )
      );
    expect(row?.quantity).toBe(100);

    const [txn] = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(
        and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.idempotencyKey, "usage:sub1:api-calls:2026-08:1"))
      );
    expect(txn?.type).toBe("USAGE-METER");
    expect(txn?.state).toBe("settled");
  });

  it("accumulates delta across calls in the same period", async () => {
    await recordUsage(ctx, {
      subscriptionId: "sub1",
      meter: "api-calls",
      period: "2026-08",
      delta: 100,
      idempotencyKey: "usage:sub1:api-calls:2026-08:1"
    });
    const second = await recordUsage(ctx, {
      subscriptionId: "sub1",
      meter: "api-calls",
      period: "2026-08",
      delta: 50,
      idempotencyKey: "usage:sub1:api-calls:2026-08:2"
    });
    expect(second.quantity).toBe(150);
  });

  it("is idempotent on a replayed key — does not double-increment", async () => {
    await recordUsage(ctx, {
      subscriptionId: "sub1",
      meter: "api-calls",
      period: "2026-08",
      delta: 100,
      idempotencyKey: "usage:sub1:api-calls:2026-08:1"
    });
    const replay = await recordUsage(ctx, {
      subscriptionId: "sub1",
      meter: "api-calls",
      period: "2026-08",
      delta: 100,
      idempotencyKey: "usage:sub1:api-calls:2026-08:1"
    });
    expect(replay.quantity).toBe(100);
  });
});

describe("invoiceNumber", () => {
  it("derives a stable, human-readable number from id and timestamp", () => {
    const n = invoiceNumber("inv_abcdef123456", Date.parse("2026-08-17T00:00:00Z"));
    expect(n).toMatch(/^INV-\d{8}-123456$/);
  });
});

describe("sweepBilling", () => {
  beforeEach(async () => {
    client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    ctx = await makeCtx();
  });

  it("raises SUB-INVOICE for subscriptions due, and advances nextInvoiceAt so the row leaves the sweep", async () => {
    const subId = "sub_due1";
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust1",
      plan: "pro",
      priceMinor: 10000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });

    const first = await sweepBilling(ctx);
    expect(first.invoicesRaised).toBe(1);

    const [sub] = await ctx.db
      .select()
      .from(schema.ledgerSubscriptions)
      .where(eq(schema.ledgerSubscriptions.id, subId));
    expect(sub?.nextInvoiceAt).toBeGreaterThan(ctx.now - 1000);

    const [invoice] = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.subscriptionId, subId));
    expect(invoice?.totalMinor).toBe(10000);
    expect(invoice?.txnId).toBeTruthy();

    const second = await sweepBilling(ctx);
    expect(second.invoicesRaised).toBe(0);
  });

  it("applies OVERAGE when usage exceeds included quantity, once", async () => {
    const subId = "sub_over1";
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust2",
      plan: "pro",
      priceMinor: 10000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });
    await recordUsage(ctx, {
      subscriptionId: subId,
      meter: "api-calls",
      period: "2026-08",
      delta: 1500,
      includedQuantity: 1000,
      unitPriceMicro: 1000,
      idempotencyKey: "usage:over1"
    });

    const result = await sweepBilling(ctx);
    expect(result.overagesApplied).toBe(1);

    const again = await sweepBilling(ctx);
    expect(again.overagesApplied).toBe(0);
  });

  it("posts SUB-RECOG for scheduled revenue rows due by the current period", async () => {
    const subId = "sub_recog1";
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust3",
      plan: "pro",
      priceMinor: 10000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });
    const first = await sweepBilling(ctx); // raises the invoice + schedule row for the current period
    expect(first.invoicesRaised).toBe(1);

    const [scheduleAfterFirst] = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(scheduleAfterFirst).toBeDefined();
    expect(scheduleAfterFirst?.state).toBe("scheduled");

    // Advance time to the next month so the schedule becomes due
    const nextMonthCtx = await makeCtx(ctx.now + 32 * 24 * 60 * 60 * 1000);
    const result = await sweepBilling(nextMonthCtx);
    expect(result.recognitionsPosted).toBe(1);

    const [schedule] = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(schedule?.state).toBe("recognized");
    expect(schedule?.txnId).toBeTruthy();
  });

  it("invoices an annual subscription once a year and recognises it straight-line", async () => {
    const subId = "sub_year1";
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_year",
      plan: "data_feed",
      priceMinor: 480_005, // not divisible by 12, so the remainder has to land somewhere
      currency: "USD",
      interval: "year",
      seats: 1,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });

    const first = await sweepBilling(ctx);
    expect(first.invoicesRaised).toBe(1);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.subscriptionId, subId));
    expect(invoices.length).toBe(1);
    expect(invoices[0]?.totalMinor).toBe(480_005);

    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(schedules.length).toBe(12);
    expect(schedules.reduce((s, r) => s + r.plannedMinor, 0)).toBe(480_005);
    expect(new Set(schedules.map((r) => r.period)).size).toBe(12);

    // A month later there is still nothing to invoice — the term runs a year.
    const nextMonth = await makeCtx(ctx.now + 40 * 24 * 60 * 60 * 1000);
    expect((await sweepBilling(nextMonth)).invoicesRaised).toBe(0);
  });

  it("bills only the new overage units when usage keeps arriving in an open period", async () => {
    const subId = "sub_delta1";
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_delta",
      plan: "pro",
      priceMinor: 10000,
      currency: "EUR",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });
    const period = new Date(ctx.now).toISOString().slice(0, 7);
    const usage = async (delta: number, key: string): Promise<void> => {
      await recordUsage(ctx, {
        subscriptionId: subId,
        meter: "api-calls",
        period,
        delta,
        includedQuantity: 1000,
        unitPriceMicro: 1_000_000, // 1 minor unit per call, so amounts are readable
        idempotencyKey: key
      });
    };

    // Tenant books in EUR too, so the overage invoice's currency has to come
    // from the subscription — the old hard-coded "USD" has no fx rate here and
    // would be refused by posting.ts outright.
    const eurCtx: Ctx = { ...ctx, policy: PolicyJson.parse({ currency: "EUR" }) };
    await usage(1500, "delta:1");
    expect((await sweepBilling(eurCtx)).overagesApplied).toBe(1);
    await usage(200, "delta:2");
    expect((await sweepBilling(eurCtx)).overagesApplied).toBe(1);

    const overageInvoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(and(eq(schema.ledgerInvoices.tenantId, ctx.tenantId), eq(schema.ledgerInvoices.subscriptionId, subId)));
    expect(overageInvoices.map((i) => i.totalMinor).sort((a, b) => a - b)).toEqual([200, 500]);
    // Currency and customer come from the subscription, not a hard-coded "USD"
    // and not the subscription id.
    expect(overageInvoices.every((i) => i.currency === "EUR")).toBe(true);
    expect(overageInvoices.every((i) => i.customerRef === "cust_delta")).toBe(true);

    // Nothing deferred: overage credits usage revenue on the invoice itself.
    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(schedules.length).toBe(0);

    // Still open, so the period is not closed to further usage.
    const [meter] = await ctx.db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(eq(schema.ledgerUsageMeters.tenantId, ctx.tenantId));
    expect(meter?.overageInvoicedQuantity).toBe(700);
    expect(meter?.overageInvoicedAt).toBeNull();
  });

  /**
   * A subscription with no invoice due, so raiseInvoices leaves it alone and
   * only the overage path touches it — isolates overage-only assertions from
   * the sibling subscription-invoicing sweep in the same tick.
   */
  async function overageSub(subId: string): Promise<void> {
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: `cust_${subId}`,
      plan: "pro",
      priceMinor: 10_000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now + 365 * 24 * 60 * 60 * 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });
  }

  it("skips a meter it has no fx rate for instead of losing the units for good", async () => {
    await overageSub("sub_fx3");
    const period = new Date(ctx.now).toISOString().slice(0, 7);
    await recordUsage(ctx, {
      subscriptionId: "sub_fx3",
      meter: "api-calls",
      period,
      delta: 1500,
      includedQuantity: 1000,
      unitPriceMicro: 1_000_000,
      idempotencyKey: "fx3:1"
    });

    // No AED rate on file: posting.ts would refuse the batch. Claiming the
    // units before checking the rate would satisfy the selection predicate
    // and lose them for good — the row would never be retried.
    expect((await sweepBilling(aedCtx(ctx))).overagesApplied).toBe(0);
    const txns = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.type, "OVERAGE")));
    expect(txns.length, "the skipped meter burned an idempotency key").toBe(0);
    const [meter] = await ctx.db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(eq(schema.ledgerUsageMeters.tenantId, ctx.tenantId));
    expect(meter?.overageInvoicedQuantity, "the skipped meter claimed units it never billed").toBe(0);

    await ctx.db.insert(schema.ledgerFxRates).values({
      id: "fx_usd_aed2",
      tenantId: ctx.tenantId,
      fromCurrency: "USD",
      toCurrency: "AED",
      ratePpm: 3_672_500,
      asOf: "2023-11-01"
    });
    expect((await sweepBilling(aedCtx(ctx))).overagesApplied).toBe(1);
  });

  it("keeps applying overages after one meter throws", async () => {
    await overageSub("sub_ov_wedged");
    await overageSub("sub_ov_healthy");
    const period = new Date(ctx.now).toISOString().slice(0, 7);
    await recordUsage(ctx, {
      subscriptionId: "sub_ov_wedged",
      meter: "api-calls",
      period,
      delta: 1500,
      includedQuantity: 1000,
      unitPriceMicro: 1_000_000,
      idempotencyKey: "wedged:1"
    });
    await recordUsage(ctx, {
      subscriptionId: "sub_ov_healthy",
      meter: "api-calls",
      period,
      delta: 1500,
      includedQuantity: 1000,
      unitPriceMicro: 1_000_000,
      idempotencyKey: "healthy:1"
    });

    const [wedgedMeter] = await ctx.db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(eq(schema.ledgerUsageMeters.subscriptionId, "sub_ov_wedged"));

    // A key already burnt by an earlier failure: runTxn throws `already failed`
    // on sight. Unisolated, that throw aborts the whole overage sweep — and in
    // cron, every other job queued behind it.
    await ctx.db.insert(schema.ledgerTxns).values({
      id: "txn_ov_wedged",
      tenantId: ctx.tenantId,
      type: "OVERAGE",
      idempotencyKey: `overage:${wedgedMeter!.id}:500`,
      state: "failed",
      actorKind: "system",
      actorId: "scheduler",
      currency: "USD",
      baseCurrency: "USD",
      grossMinor: 500,
      createdAt: ctx.now - 500,
      updatedAt: ctx.now - 500,
      failedAt: ctx.now - 500
    });

    expect((await sweepBilling(ctx)).overagesApplied).toBe(1);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    expect(invoices.map((i) => i.subscriptionId)).toEqual(["sub_ov_healthy"]);
  });

  it("recognises a schedule into its own income account, not always 4040", async () => {
    // The 4060 rows the data-product engine and the seed write are the case the
    // dead `"4050" ? "4040" : "4040"` ternary silently sent to subscription
    // revenue, merging the very revenue lines this engine separates.
    await ctx.db.insert(schema.ledgerRevenueSchedules).values({
      id: "sch_dp1",
      tenantId: ctx.tenantId,
      invoiceId: "inv_dp1",
      accountCode: "4060",
      period: "2023-10", // before ctx.now's own period
      plannedMinor: 7000,
      currency: "USD",
      state: "scheduled"
    });

    expect((await sweepBilling(ctx)).recognitionsPosted).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.id, "sch_dp1"));
    const lines = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, row!.txnId!));
    expect(lines.find((l) => l.side === "credit")?.accountCode).toBe("4060");
    expect(lines.find((l) => l.side === "debit")?.accountCode).toBe("2300");
  });

  it("skips a schedule row it has no fx rate for instead of blocking rows behind it", async () => {
    await ctx.db.insert(schema.ledgerRevenueSchedules).values({
      id: "sch_fx_head",
      tenantId: ctx.tenantId,
      invoiceId: "inv_fx_head",
      accountCode: "4060",
      period: "2023-09",
      plannedMinor: 5000,
      currency: "USD",
      state: "scheduled"
    });
    await ctx.db.insert(schema.ledgerRevenueSchedules).values({
      id: "sch_fx_tail",
      tenantId: ctx.tenantId,
      invoiceId: "inv_fx_tail",
      accountCode: "4060",
      period: "2023-10",
      plannedMinor: 3000,
      currency: "AED",
      state: "scheduled"
    });

    // No USD -> AED rate on file: the head-of-window row (earliest period) must
    // not block the row behind it in the asc(period) ordering.
    expect((await sweepBilling(aedCtx(ctx))).recognitionsPosted).toBe(1);

    const rows = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(rows.find((r) => r.id === "sch_fx_head")?.state).toBe("scheduled");
    expect(rows.find((r) => r.id === "sch_fx_tail")?.state).toBe("recognized");

    await ctx.db.insert(schema.ledgerFxRates).values({
      id: "fx_usd_aed3",
      tenantId: ctx.tenantId,
      fromCurrency: "USD",
      toCurrency: "AED",
      ratePpm: 3_672_500,
      asOf: "2023-11-01"
    });
    expect((await sweepBilling(aedCtx(ctx))).recognitionsPosted).toBe(1);
  });

  it("keeps recognizing schedule rows after one throws", async () => {
    await ctx.db.insert(schema.ledgerRevenueSchedules).values({
      id: "sch_wedged",
      tenantId: ctx.tenantId,
      invoiceId: "inv_wedged",
      accountCode: "4060",
      period: "2023-09",
      plannedMinor: 5000,
      currency: "USD",
      state: "scheduled"
    });
    await ctx.db.insert(schema.ledgerRevenueSchedules).values({
      id: "sch_healthy",
      tenantId: ctx.tenantId,
      invoiceId: "inv_healthy",
      accountCode: "4060",
      period: "2023-10",
      plannedMinor: 3000,
      currency: "USD",
      state: "scheduled"
    });
    // A key already burnt by an earlier failure: runTxn throws `already failed`
    // on sight. Unisolated, that throw aborts the whole recognition sweep.
    await ctx.db.insert(schema.ledgerTxns).values({
      id: "txn_recog_wedged",
      tenantId: ctx.tenantId,
      type: "SUB-RECOG",
      idempotencyKey: "sub-recog:sch_wedged",
      state: "failed",
      actorKind: "system",
      actorId: "scheduler",
      currency: "USD",
      baseCurrency: "USD",
      grossMinor: 5000,
      createdAt: ctx.now - 500,
      updatedAt: ctx.now - 500,
      failedAt: ctx.now - 500
    });

    expect((await sweepBilling(ctx)).recognitionsPosted).toBe(1);

    const rows = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(rows.find((r) => r.id === "sch_healthy")?.state).toBe("recognized");
    expect(rows.find((r) => r.id === "sch_wedged")?.state).toBe("scheduled");
  });

  it("is bounded-bite: a processed row never reappears in the same-tick result set (ADR-0050)", async () => {
    for (let i = 0; i < 3; i++) {
      await ctx.db.insert(schema.ledgerSubscriptions).values({
        id: `sub_bite_${i}`,
        tenantId: ctx.tenantId,
        customerRef: `cust_bite_${i}`,
        plan: "pro",
        priceMinor: 5000,
        currency: "USD",
        interval: "month",
        seats: 1,
        startAt: ctx.now - 1000,
        nextInvoiceAt: ctx.now - 1000,
        state: "active",
        createdAt: ctx.now - 1000,
        updatedAt: ctx.now - 1000
      });
    }
    const result = await sweepBilling(ctx);
    expect(result.invoicesRaised).toBe(3);
    const rerun = await sweepBilling(ctx);
    expect(rerun.invoicesRaised).toBe(0);
  });

  // The cron ctx (apps/api/src/index.ts) builds its policy from defaults, so the
  // tenant's base currency is whatever PolicyJson defaults to — never the
  // subscription's. Every test above happens to bill in the ctx's own currency,
  // which is why nothing here has ever posted a cross-currency invoice.
  const aedCtx = (from: Ctx): Ctx => ({ ...from, policy: PolicyJson.parse({ currency: "AED" }) });

  async function usdSub(subId: string): Promise<void> {
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: `cust_${subId}`,
      plan: "data_feed",
      priceMinor: 10_000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });
  }

  it("invoices a subscription billed in a currency the tenant does not report in", async () => {
    await usdSub("sub_fx1");
    await ctx.db.insert(schema.ledgerFxRates).values({
      id: "fx_usd_aed",
      tenantId: ctx.tenantId,
      fromCurrency: "USD",
      toCurrency: "AED",
      ratePpm: 3_672_500,
      asOf: "2023-11-01"
    });

    expect((await sweepBilling(aedCtx(ctx))).invoicesRaised).toBe(1);

    const [batch] = await ctx.db
      .select()
      .from(schema.ledgerJournalBatches)
      .where(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId));
    expect(batch?.currency).toBe("USD");
    expect(batch?.baseCurrency).toBe("AED");
    expect(batch?.fxRatePpm).toBe(3_672_500);
    expect(batch?.baseTotalDebitMinor).toBe(36_725); // 10_000 * 3.6725
    expect(batch?.baseTotalDebitMinor).toBe(batch?.baseTotalCreditMinor);
  });

  it("skips a subscription it has no rate for instead of burning its idempotency key", async () => {
    await usdSub("sub_fx2");

    // No rate on file: posting.ts refuses the batch, runTxn fails the txn, and a
    // `failed` row makes that key throw `already failed` for good — the period
    // could never be invoiced again, by cron or by hand.
    expect((await sweepBilling(aedCtx(ctx))).invoicesRaised).toBe(0);
    const txns = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
    expect(txns.length, "the skipped subscription burned an idempotency key").toBe(0);

    // Still due, and billable the moment finance adds the rate.
    await ctx.db.insert(schema.ledgerFxRates).values({
      id: "fx_usd_aed",
      tenantId: ctx.tenantId,
      fromCurrency: "USD",
      toCurrency: "AED",
      ratePpm: 3_672_500,
      asOf: "2023-11-01"
    });
    expect((await sweepBilling(aedCtx(ctx))).invoicesRaised).toBe(1);
  });

  it("keeps sweeping after one subscription throws", async () => {
    await usdSub("sub_wedged");
    await usdSub("sub_healthy");

    // A key already burnt by an earlier failure: runTxn throws `already failed`
    // on sight. Unisolated, that throw aborts the tenant's whole sweep — and in
    // cron, every other job queued behind it (index.ts's one per-tenant try).
    await ctx.db.insert(schema.ledgerTxns).values({
      id: "txn_wedged",
      tenantId: ctx.tenantId,
      type: "SUB-INVOICE",
      idempotencyKey: `sub-invoice:sub_wedged:${new Date(ctx.now).toISOString().slice(0, 7)}`,
      state: "failed",
      actorKind: "system",
      actorId: "scheduler",
      currency: "USD",
      baseCurrency: "USD",
      grossMinor: 10_000,
      createdAt: ctx.now - 500,
      updatedAt: ctx.now - 500,
      failedAt: ctx.now - 500
    });

    expect((await sweepBilling(ctx)).invoicesRaised).toBe(1);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    expect(invoices.map((i) => i.subscriptionId)).toEqual(["sub_healthy"]);

    // The wedged row keeps its due date: its period is still owed, and a sweep
    // that advanced it would silently write the period off.
    const [wedged] = await ctx.db
      .select()
      .from(schema.ledgerSubscriptions)
      .where(eq(schema.ledgerSubscriptions.id, "sub_wedged"));
    expect(wedged?.nextInvoiceAt).toBe(ctx.now - 1000);
  });

  /** A subscription due since `dueSince`, billed in the ctx's own currency. */
  async function sub(subId: string, dueSince: number, interval: "month" | "year", priceMinor: number): Promise<void> {
    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: `cust_${subId}`,
      plan: "growth",
      priceMinor,
      currency: "USD",
      interval,
      seats: 1,
      startAt: dueSince,
      nextInvoiceAt: dueSince,
      state: "active",
      createdAt: dueSince,
      updatedAt: dueSince
    });
  }

  it("bills every calendar month a stalled sweep missed, in one tick", async () => {
    const start = Date.UTC(2026, 0, 15);
    await sub("sub_catchup", start, "month", 10_000);

    // Three months of outage. Each missed period is owed and gets its own
    // invoice; none is billed twice, and the row is up to date afterwards.
    const late = await makeCtx(Date.UTC(2026, 3, 15));
    expect((await sweepBilling(late)).invoicesRaised).toBe(4); // Jan, Feb, Mar, Apr

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    expect(invoices.length).toBe(4);
    // One posting each: four invoices sharing a transaction would mean one period
    // was billed twice off the same journal entry.
    expect(new Set(invoices.map((i) => i.txnId)).size).toBe(4);
    expect((await sweepBilling(late)).invoicesRaised).toBe(0);
  });

  it("steps an annual subscription a year at a time, not a month", async () => {
    const start = Date.UTC(2025, 0, 15);
    await sub("sub_annual", start, "year", 480_000);

    // Eighteen months stale. A monthly step would bill eighteen full years.
    const late = await makeCtx(Date.UTC(2026, 5, 15));
    expect((await sweepBilling(late)).invoicesRaised).toBe(2); // 2025 and 2026 terms

    const [row] = await ctx.db
      .select()
      .from(schema.ledgerSubscriptions)
      .where(eq(schema.ledgerSubscriptions.id, "sub_annual"));
    expect(row?.nextInvoiceAt).toBe(Date.UTC(2027, 0, 15));
  });
});

// Migration 0026 populates next_invoice_at for subscriptions that predate the
// column. It runs against real production rows exactly once, so the only place
// its arithmetic can be checked is here: the statement is taken from the
// migration itself and replayed over rows this test controls.
describe("migration 0026: next_invoice_at backfill", () => {
  const DAY = 24 * 60 * 60 * 1000;

  function backfillStatement(): string {
    const file = readdirSync(MIGRATIONS).find((f) => f.startsWith("0026_"));
    const stmt = readFileSync(join(MIGRATIONS, file!), "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .find((s) => s.includes("next_invoice_at"));
    if (!stmt) throw new Error("test: migration 0026 no longer backfills next_invoice_at");
    return stmt;
  }

  it("does not make an already-invoiced year due again next month", async () => {
    // The real clock, because the migration dates off `now`: the tenant is
    // upgraded today and the sweep runs on the 1st of next month.
    const today = Date.now();
    const d = new Date(today);
    const firstOfNextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const ctx = await testCtx(firstOfNextMonth + DAY);

    // Both signed 20 days ago and invoiced by hand for their first term — the
    // yearly one for the whole year, which is what makes billing it again in a
    // month's time a duplicate of 12 months of revenue.
    for (const [id, interval] of [
      ["sub_bf_year", "year"],
      ["sub_bf_month", "month"]
    ] as const) {
      await ctx.db.insert(schema.ledgerSubscriptions).values({
        id,
        tenantId: ctx.tenantId,
        customerRef: `cust_${id}`,
        plan: "data_feed",
        priceMinor: 480_000,
        currency: "USD",
        interval,
        seats: 1,
        startAt: today - 20 * DAY,
        nextInvoiceAt: null,
        state: "active",
        createdAt: today - 20 * DAY,
        updatedAt: today - 20 * DAY
      });
    }

    await client.execute(backfillStatement());
    await sweepBilling(ctx);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    // The monthly term is up, so its second month is due. The annual term has
    // eleven months left to run.
    expect(invoices.map((i) => i.subscriptionId)).toEqual(["sub_bf_month"]);
  });
});

describe("subscribeToDataProduct", () => {
  it("posts DPROD-SUB with no journal lines", async () => {
    ctx = await testCtx();
    await ctx.db.insert(schema.scoutDataProducts).values({
      id: "dp1",
      tenantId: ctx.tenantId,
      name: "Market pulse",
      definitionJson: "{}",
      consentBasis: "legitimate-interest",
      aggregationMin: 20,
      status: "published",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });

    const result = await subscribeToDataProduct(ctx, {
      dataProductId: "dp1",
      subscriberRef: "partner1",
      idempotencyKey: "dprod-sub:dp1:partner1"
    });
    expect(result.txnId).toBeTruthy();

    const [txn] = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.id, result.txnId!)));
    expect(txn?.type).toBe("DPROD-SUB");
  });
});

describe("deliverDataProduct", () => {
  beforeEach(async () => {
    ctx = await testCtx();
    await ctx.db.insert(schema.scoutDataProducts).values({
      id: "dp1",
      tenantId: ctx.tenantId,
      name: "Market pulse",
      definitionJson: "{}",
      consentBasis: "legitimate-interest",
      aggregationMin: 20,
      status: "published",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
  });

  it("refuses delivery below the k-anonymity floor and burns no idempotency key", async () => {
    // conflict() (packages/core/src/errors.ts) fixes .message to "Conflict" and
    // carries the real reason in .detail, so the k-anonymity text is asserted
    // there — same pattern as analytics.test.ts's "rejects a timezone" case.
    try {
      await deliverDataProduct(ctx, {
        dataProductId: "dp1",
        subscriberRef: "partner1",
        cellCount: 5,
        netMinor: 50000,
        idempotencyKey: "dprod-deliver:dp1:1"
      });
      expect.unreachable("deliverDataProduct accepted a cell count below the k-anonymity floor");
    } catch (e) {
      expect((e as { detail?: string }).detail).toMatch(/k-anonymity/i);
    }

    const [txn] = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(
        and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.idempotencyKey, "dprod-deliver:dp1:1"))
      );
    expect(txn).toBeUndefined();
  });

  it("refuses to deliver a product that is not published", async () => {
    await ctx.db
      .update(schema.scoutDataProducts)
      .set({ status: "draft" })
      .where(eq(schema.scoutDataProducts.id, "dp1"));
    await expect(
      deliverDataProduct(ctx, {
        dataProductId: "dp1",
        subscriberRef: "partner1",
        cellCount: 50,
        netMinor: 50000,
        idempotencyKey: "dprod-deliver:dp1:draft"
      })
    ).rejects.toMatchObject({ detail: "data product dp1 is draft, not published" });
  });

  it("delivers, invoices, and recognises revenue against income account 4060", async () => {
    const result = await deliverDataProduct(ctx, {
      dataProductId: "dp1",
      subscriberRef: "partner1",
      cellCount: 50,
      netMinor: 50000,
      idempotencyKey: "dprod-deliver:dp1:2"
    });
    expect(result.deliverTxnId).toBeTruthy();

    const [invoice] = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.id, result.invoiceId));
    expect(invoice?.totalMinor).toBe(50000);

    const [recogTxn] = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.type, "SUB-RECOG")));
    expect(recogTxn).toBeTruthy();
    expect(recogTxn?.parentTxnId).toBe(result.deliverTxnId);

    // schema.ledgerPostings does not exist in packages/db/src/schema.ts — the
    // journal-lines table is exported as `ledgerJournalLines` (see schema.ts
    // re-export of ledger.ts's `journalLines`); columns txnId/side/accountCode
    // do match the brief as written.
    const lines = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, recogTxn!.id));
    const creditLine = lines.find((l) => l.side === "credit" && l.accountCode === "4060");
    expect(creditLine).toBeTruthy();
  });

  it("invoices in the tenant's own currency, not a hard-coded USD", async () => {
    const eurCtx: Ctx = { ...ctx, policy: PolicyJson.parse({ currency: "EUR" }) };
    const result = await deliverDataProduct(eurCtx, {
      dataProductId: "dp1",
      subscriberRef: "partner1",
      cellCount: 50,
      netMinor: 50000,
      idempotencyKey: "dprod-deliver:dp1:eur"
    });

    const [invoice] = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.id, result.invoiceId));
    expect(invoice?.currency).toBe("EUR");
  });

  it("writes one invoice and one schedule however many times a delivery is replayed", async () => {
    const args = {
      dataProductId: "dp1",
      subscriberRef: "partner1",
      cellCount: 50,
      netMinor: 50000,
      idempotencyKey: "dprod-deliver:dp1:replay"
    };
    const first = await deliverDataProduct(ctx, args);
    const second = await deliverDataProduct(ctx, args);
    expect(second.invoiceId).toBe(first.invoiceId);
    expect(second.scheduleId).toBe(first.scheduleId);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(invoices.length).toBe(1);
    expect(schedules.length).toBe(1);
  });
});

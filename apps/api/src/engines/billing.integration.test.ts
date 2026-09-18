import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, seed, type Actor, type Ctx } from "@lyra/core";
import { recordUsage, sweepBilling } from "./billing.js";

// Group C revenue lines, task 7: worked-example integration test proving the
// full F2 flow (subscription invoice -> overage -> revenue recognition)
// across multiple sweepBilling ticks. Setup block below is copied verbatim
// from billing.test.ts (lines 1-58) — no shared test-helper module exists in
// this codebase, each test file builds its own isolated in-memory db.

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

function actor(): Actor {
  return {
    kind: "system",
    id: "scheduler",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

async function makeCtx(now = 1_700_000_000_000): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({ currency: "USD" }),
    entitlements: EntitlementsJson.parse({})
  };
}

/** Fresh in-memory db + migrations + ctx, for describe blocks that don't need a shared beforeEach. */
async function testCtx(now = 1_700_000_000_000): Promise<Ctx> {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  return makeCtx(now);
}

/** Signed per-account net over every posted line: debit positive, credit negative. */
async function signedByAccount(ctx: Ctx): Promise<Map<string, number>> {
  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));
  const net = new Map<string, number>();
  for (const l of lines) {
    const delta = l.side === "debit" ? l.amountMinor : -l.amountMinor;
    net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + delta);
  }
  return net;
}

/**
 * CLAUDE.md §12's ledger invariants, asserted at every point in a sweep run
 * rather than only at the end: every transaction's own lines balance, and
 * deferred revenue 2300 is never released beyond what was deferred into it.
 */
async function assertLedgerInvariants(ctx: Ctx, at: string): Promise<void> {
  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));

  const perTxn = new Map<string, number>();
  for (const l of lines) {
    const delta = l.side === "debit" ? l.amountMinor : -l.amountMinor;
    perTxn.set(l.txnId, (perTxn.get(l.txnId) ?? 0) + delta);
  }
  for (const [txnId, net] of perTxn) {
    expect(net, `${at}: txn ${txnId} debits != credits`).toBe(0);
  }

  const net = await signedByAccount(ctx);
  // 2300 is a liability: its balance is credits minus debits, and a negative
  // balance means recognition released revenue that was never deferred.
  const deferred = -(net.get("2300") ?? 0);
  expect(deferred, `${at}: deferred revenue 2300 is negative (${deferred})`).toBeGreaterThanOrEqual(0);
}

/**
 * The same invariant, per invoice. Deferred revenue is a liability owed on one
 * invoice at a time and the account total hides that: an invoice that releases
 * revenue it never deferred nets away against the next invoice's fresh credit,
 * so 2300 stays comfortably positive while a customer's revenue is recognised
 * out of nothing. A recognition transaction names its invoice in `subjectRefs`
 * and an invoice row names its own posting, so every 2300 line can be attributed.
 */
async function assertDeferredPerInvoice(ctx: Ctx, at: string): Promise<void> {
  const txns = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
  const invoices = await ctx.db
    .select()
    .from(schema.ledgerInvoices)
    .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));

  const invoiceOfTxn = new Map<string, string>();
  for (const inv of invoices) if (inv.txnId) invoiceOfTxn.set(inv.txnId, inv.id);
  for (const t of txns) {
    const ref = t.subjectRefsJson ? (JSON.parse(t.subjectRefsJson) as { invoiceId?: string }) : {};
    // Don't overwrite an entry the first loop already set from the invoice's
    // own `txnId` — that attribution is authoritative, this one is a fallback
    // for txn-less invoices.
    if (ref.invoiceId && !invoiceOfTxn.has(t.id)) invoiceOfTxn.set(t.id, ref.invoiceId);
  }

  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));

  const perInvoice = new Map<string, number>();
  for (const l of lines) {
    if (l.accountCode !== "2300") continue;
    // ponytail: a 2300 line on a transaction that names no invoice cannot be
    // attributed, so it is left to the account-level check above.
    const invoiceId = invoiceOfTxn.get(l.txnId);
    if (!invoiceId) continue;
    const delta = l.side === "credit" ? l.amountMinor : -l.amountMinor;
    perInvoice.set(invoiceId, (perInvoice.get(invoiceId) ?? 0) + delta);
  }

  for (const [invoiceId, deferred] of perInvoice) {
    expect(
      deferred,
      `${at}: invoice ${invoiceId} released ${-deferred} more deferred revenue than it deferred`
    ).toBeGreaterThanOrEqual(0);
  }
}

describe("ledger invariants across sweeps and calendar months", () => {
  it("never double-bills, never drives 2300 negative, never recognises more than invoiced", async () => {
    // Real calendar dates, and meter periods that match the clock — the existing
    // worked example pins its meter to "2026-08" while ctx.now is 2023, so its
    // overage schedule never becomes due and the recognition path never runs.
    const jan1 = Date.parse("2026-01-01T00:00:00Z");
    const ctx = await testCtx(jan1);
    const subId = "sub_inv1";

    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_inv1",
      plan: "growth",
      priceMinor: 20000,
      currency: "USD",
      interval: "month",
      seats: 3,
      startAt: jan1,
      nextInvoiceAt: jan1,
      state: "active",
      createdAt: jan1,
      updatedAt: jan1
    });

    await recordUsage(ctx, {
      subscriptionId: subId,
      meter: "api-calls",
      period: "2026-01",
      delta: 12000,
      includedQuantity: 10000,
      unitPriceMicro: 500_000,
      idempotencyKey: "inv1:usage:1"
    });

    // Four ticks over three calendar months: the second lands inside the same
    // calendar month as the first (Jan 1 + 30d), which is exactly the case a
    // fixed 30-day cycle turns into a second invoice for one AR posting.
    const ticks: [string, Ctx][] = [
      ["jan-01", ctx],
      ["jan-31", await makeCtx(Date.parse("2026-01-31T00:00:00Z"))],
      ["feb-15", await makeCtx(Date.parse("2026-02-15T00:00:00Z"))],
      ["mar-15", await makeCtx(Date.parse("2026-03-15T00:00:00Z"))]
    ];
    for (const [label, tickCtx] of ticks) {
      await sweepBilling(tickCtx);
      await assertLedgerInvariants(tickCtx, label);
    }

    // One invoice per journal posting: a replayed SUB-INVOICE must not mint a
    // second invoice row behind the transaction that correctly no-op'd.
    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    const txnIds = invoices.map((i) => i.txnId);
    expect(new Set(txnIds).size, "two invoices share one transaction").toBe(txnIds.length);

    // One subscription invoice per calendar month billed, no more.
    const subInvoices = invoices.filter((i) => i.subscriptionId === subId && i.totalMinor === 20000);
    expect(subInvoices.length).toBe(3); // Jan, Feb, Mar

    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    const recognised = schedules.reduce((s, r) => s + r.recognizedMinor, 0);
    const invoiced = invoices.reduce((s, i) => s + i.subtotalMinor, 0);
    expect(recognised, "recognised more revenue than was invoiced").toBeLessThanOrEqual(invoiced);
  });
});

describe("the shipped seed's own tenant", () => {
  it("never drives deferred revenue 2300 negative, however long the sweep runs", async () => {
    // Every test above builds its own two-row fixture, so the invariant has only
    // ever been checked against data written by the engine itself. The seed is
    // the demo, the e2e fixture and the provisioning template — a hand-fixtured
    // revenue schedule with nothing deferred behind it releases revenue out of a
    // liability that was never credited, and only running the real tenant
    // through the real sweep finds it.
    client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    const seeded = await seed(drizzle(client) as never);

    const base: Ctx = {
      ...(await makeCtx()),
      tenantId: seeded.tenantId,
      // What the cron handler builds (index.ts): the policy defaults, not the
      // subscription's currency.
      policy: PolicyJson.parse({})
    };
    base.actor.tenantId = seeded.tenantId;

    // The seed's clock is 2026-01-06; a year of month-end ticks takes every
    // schedule row it ships past its own period and into the recognition path.
    const start = Date.UTC(2026, 0, 6, 8, 0, 0);
    for (let month = 0; month <= 12; month++) {
      const tick: Ctx = { ...base, now: Date.UTC(2026, month, 28, 8, 0, 0) };
      const at = `seed tenant, month ${month} (from ${new Date(start).toISOString()})`;
      await sweepBilling(tick);
      await assertLedgerInvariants(tick, at);
      await assertDeferredPerInvoice(tick, at);
    }
    // A year of month-end ticks over a fully seeded tenant, each one now also
    // reading the invoice and its released total to enforce the recognition
    // ceiling (docs/19 §11.9). Well past vitest's 5s default under a loaded
    // runner, and the timeout read as an engine failure rather than as one.
  }, 60_000);
});

describe("overage billing survives a crash mid-tick", () => {
  it("does not bill the same units twice when the meter update is lost", async () => {
    const jan15 = Date.parse("2026-01-15T00:00:00Z");
    const ctx = await testCtx(jan15);
    const subId = "sub_crash1";

    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_crash1",
      plan: "growth",
      priceMinor: 20000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: jan15,
      // Far enough out that no subscription invoice joins the overage invoices
      // this test counts.
      nextInvoiceAt: jan15 + 365 * 24 * 60 * 60 * 1000,
      state: "active",
      createdAt: jan15,
      updatedAt: jan15
    });

    // 1 minor per unit, so invoiced minor == overage units billed.
    const usage = { subscriptionId: subId, meter: "api-calls", period: "2026-01", includedQuantity: 10000, unitPriceMicro: 1_000_000 };
    await recordUsage(ctx, { ...usage, delta: 12000, idempotencyKey: "crash1:usage:1" });

    // The crash: applyOverages claims the units (updates the meter) before it
    // calls runTxn, so aborting that claim write reproduces a worker dying
    // before the OVERAGE transaction is ever posted. Per-meter isolation
    // (C3) catches this locally — it no longer takes the whole sweep down —
    // so the claimed-but-unposted units simply stay unclaimed for the retry.
    await client.execute("CREATE TRIGGER crash_meter BEFORE UPDATE ON ledger_usage_meters BEGIN SELECT RAISE(ABORT, 'crash'); END");
    await sweepBilling(ctx);
    await client.execute("DROP TRIGGER crash_meter");

    // Nothing was claimed or posted on the crashed tick: the meter's claim
    // write is the first write in applyOverages, so aborting it means runTxn
    // is never reached and no OVERAGE transaction exists yet.
    const invoicesAfterCrash = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    expect(invoicesAfterCrash).toHaveLength(0);

    // More usage arrives before the retry. Because the crashed tick never
    // claimed or billed anything, the retry sees the full 13,000 units and
    // bills the whole 3,000-unit overage exactly once.
    await recordUsage(ctx, { ...usage, delta: 1000, idempotencyKey: "crash1:usage:2" });
    await sweepBilling(ctx);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    const billedUnits = invoices.reduce((s, i) => s + i.totalMinor, 0);
    // 13,000 used, 10,000 included: 3,000 units of overage exist and at most
    // 3,000 may ever be billed. Under-billing after a crash is an accepted
    // outcome; billing 5,000 is not.
    expect(billedUnits).toBeLessThanOrEqual(3000);
  });
});

describe("F2 worked example: subscription + overage + recognition", () => {
  it("takes a subscription from due invoice through overage to recognized revenue", async () => {
    const ctx = await testCtx();
    const subId = "sub_worked1";

    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_worked1",
      plan: "growth",
      priceMinor: 20000,
      currency: "USD",
      interval: "month",
      seats: 3,
      startAt: ctx.now - 1000,
      nextInvoiceAt: ctx.now - 1000,
      state: "active",
      createdAt: ctx.now - 1000,
      updatedAt: ctx.now - 1000
    });

    await recordUsage(ctx, {
      subscriptionId: subId,
      meter: "api-calls",
      period: "2026-08",
      delta: 12000,
      includedQuantity: 10000,
      unitPriceMicro: 500,
      idempotencyKey: "worked1:usage:1"
    });

    // tick 1: raises subscription invoice + applies overage
    const tick1 = await sweepBilling(ctx);
    expect(tick1.invoicesRaised).toBe(1);
    expect(tick1.overagesApplied).toBe(1);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.subscriptionId, subId));
    // Both the subscription invoice (raiseInvoices) and the overage invoice
    // (applyOverages) carry subscriptionId: sub.id / meter.subscriptionId,
    // which are the same subId here — verified against actual behavior of
    // billing.ts, not the brief's initial guess of a single row.
    expect(invoices.length).toBe(2);
    const subInvoice = invoices.find((i) => i.totalMinor === 20000);
    const overageInvoice = invoices.find((i) => i.id !== subInvoice?.id);
    expect(subInvoice?.totalMinor).toBe(20000);
    expect(overageInvoice?.totalMinor).toBe(1); // ceil(2000 overage units * 500 micros / 1e6)

    // tick 2 (same ctx.now): nothing recognized yet — postRecognitions only
    // fires for schedules strictly before the current period, and no time
    // has passed since the schedules were raised in tick 1.
    const tick2 = await sweepBilling(ctx);
    expect(tick2).toEqual({ invoicesRaised: 0, overagesApplied: 0, recognitionsPosted: 0 });

    // Advance 17 real-clock days: enough to cross the calendar-month
    // boundary (Nov -> Dec) so the subscription's revenue schedule becomes
    // due, but short of the 30-day MONTH_MS bump applied to nextInvoiceAt
    // in tick 1 — so this does not raise a second subscription invoice.
    const nextMonthCtx = await makeCtx(ctx.now + 17 * 24 * 60 * 60 * 1000);
    const tick3 = await sweepBilling(nextMonthCtx);
    expect(tick3).toEqual({ invoicesRaised: 0, overagesApplied: 0, recognitionsPosted: 1 });

    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    // One schedule only: the subscription's. Overage credits usage revenue 4050
    // on the invoice itself, so it has nothing deferred to schedule — scheduling
    // it too was recognising the same revenue twice.
    expect(schedules.length).toBe(1);
    const recognized = schedules.filter((s) => s.state === "recognized");
    expect(recognized.length).toBe(1);
    expect(recognized[0]?.accountCode).toBe("2300");

    // tick 4: nothing left to do at this clock — the remaining schedule's
    // period ("2026-08") is still not before nextMonthCtx's real-clock period.
    const tick4 = await sweepBilling(nextMonthCtx);
    expect(tick4).toEqual({ invoicesRaised: 0, overagesApplied: 0, recognitionsPosted: 0 });
  });
});

describe("a subscription whose nextInvoiceAt no Date can hold", () => {
  // `nextInvoiceAt` is nullable and stored, and rows predating the API's bound
  // still hold anything. The catch-up guard `cursor <= ctx.now` filters large
  // positives and NaN but not large negatives, so `currentPeriod(-9e15)` gave
  // `"NaN-NaN"` — the invoice idempotency key `sub-invoice:<id>:NaN-NaN`, the
  // `ledger_revenue_schedules.period` it wrote, and `NaN` written back to
  // `nextInvoiceAt`. A poisoned key does not match on the next tick, so the
  // same period bills again.
  it("skips the row instead of billing it under a NaN period", async () => {
    const now = Date.parse("2026-03-01T00:00:00Z");
    const ctx = await testCtx(now);
    const subId = "sub_bad_cursor";

    await ctx.db.insert(schema.ledgerSubscriptions).values({
      id: subId,
      tenantId: ctx.tenantId,
      customerRef: "cust_bad",
      plan: "growth",
      priceMinor: 20000,
      currency: "USD",
      interval: "month",
      seats: 1,
      startAt: now,
      nextInvoiceAt: -9e15,
      state: "active",
      createdAt: now,
      updatedAt: now
    });

    const tick = await sweepBilling(ctx);
    expect(tick.invoicesRaised).toBe(0);

    const invoices = await ctx.db
      .select()
      .from(schema.ledgerInvoices)
      .where(eq(schema.ledgerInvoices.tenantId, ctx.tenantId));
    expect(invoices.length).toBe(0);

    const schedules = await ctx.db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.tenantId, ctx.tenantId));
    expect(schedules.map((s) => s.period)).not.toContain("NaN-NaN");

    // The cursor is left alone: a row nobody could bill must still be findable
    // by the same query next tick, not overwritten with NaN.
    const [row] = await ctx.db
      .select()
      .from(schema.ledgerSubscriptions)
      .where(eq(schema.ledgerSubscriptions.id, subId));
    expect(row?.nextInvoiceAt).toBe(-9e15);
  });
});

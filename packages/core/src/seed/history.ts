import { and, eq, inArray } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { applyPpm } from "../commission.js";
import { DAY, HOUR, MINUTE } from "./context.js";
import type { CoreDb } from "../context.js";
import { measureBook, windowPeriods } from "./north-book.js";

// docs/19 — the trading history the demo book implies. `seed.ts` writes the one
// sale the whole product tells a story about; this writes the months of ordinary
// days around it, so trend lines, period closes and reconciliation screens open
// on a book with a past instead of a fortnight of fixtures.
//
// Additive and re-runnable: it is applied to an already-seeded tenant (staging,
// production), skips days it has already written, and never touches a row the
// core seed owns. The two ledger invariants hold for every day it writes —
// each batch balances, and client money (1010) never falls below the liability
// it segregates (2010), because the only lines that touch either move both.

export const BASE = "AED";

/** One trading day, three transactions: money in, commission earned, money out. */
const SALES_PER_DAY = 2;

export interface HistoryOptions {
  /** How many days back from `now` to write. */
  days: number;
  /** The clock. Never `Date.now()` inside, so a re-run is deterministic. */
  now: number;
  /** Actor for the postings — a finance user id where one is known. */
  postedBy?: string | undefined;
}

export interface HistoryResult {
  daysWritten: number;
  daysSkipped: number;
  txns: number;
  batches: number;
  periodsCreated: number;
  /** north_snapshots rows written (see `measure`). */
  snapshots: number;
  /** analytics_unit_economics rows written, one per trading day. */
  unitEconomics: number;
}

/** What a trading day's postings add up to, per UTC day. */
interface DayTotals {
  premiumMinor: number;
  commissionMinor: number;
  sales: number;
  midnight: number;
}

export interface Line {
  code: string;
  side: "debit" | "credit";
  amountMinor: number;
  memo: string;
}

export interface Posting {
  type: string;
  idempotencyKey: string;
  correlationId: string;
  actorKind: string;
  actorId: string;
  grossMinor: number;
  amounts: Record<string, number>;
  at: number;
  /**
   * Empty for a ⊘ transaction (docs/19 §4): a state change with no money, which
   * gets a txn row and its transitions but no journal batch.
   */
  lines: readonly Line[];
}

export interface PostOptions {
  now: number;
  /** Already in `user:<id>` / `system:<name>` form. */
  postedBy: string;
  nid: (prefix: string) => string;
}

export interface PostResult {
  txns: number;
  batches: number;
  periodsCreated: number;
  /** Every posting handed in, keyed by idempotency key — fresh and pre-existing alike. */
  txnIds: Map<string, string>;
  /** The subset that did not already exist, in the order it was handed in. */
  fresh: readonly Posting[];
}

/**
 * D1 binds at most 100 parameters per statement, so a thousand-row insert has to
 * arrive as many small ones. Sized off the widest table rather than per call.
 */
const CHUNK = 3;

export async function insertChunked<T>(
  insert: (rows: T[]) => Promise<unknown>,
  rows: readonly T[],
  size = CHUNK
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

export const monthCode = (at: number): string => new Date(at).toISOString().slice(0, 7);
export const monthStartOf = (at: number): number => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};
export const nextMonthStart = (at: number): number => {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};

/** A day's premium, spread over a plausible range without a random source. */
export function premiumFor(dayIndex: number, sale: number): number {
  return 120_000 + (((dayIndex * 7919 + sale * 3301) % 69) * 5_000);
}

/**
 * Write a batch of postings: skip the ones already in the book, open any period
 * they reach back into, then post txn + journal + transitions and roll the
 * balance cache forward.
 *
 * Shared with `history-modules.ts` so there is exactly one money path in the
 * backfill: every caller gets the same balance assertion, the same idempotency
 * matching and the same period discipline.
 */
export async function postAll(
  db: CoreDb,
  tenantId: string,
  postings: readonly Posting[],
  options: PostOptions
): Promise<PostResult> {
  const { now, postedBy, nid } = options;

  /* ------------------------------------------------- skip what already exists */
  const wanted = postings.map((p) => p.idempotencyKey);
  const txnIds = new Map<string, string>();
  for (let i = 0; i < wanted.length; i += 20) {
    const rows = await db
      .select({ id: schema.ledgerTxns.id, key: schema.ledgerTxns.idempotencyKey })
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, tenantId), inArray(schema.ledgerTxns.idempotencyKey, wanted.slice(i, i + 20))));
    for (const row of rows) txnIds.set(row.key, row.id);
  }
  const fresh = postings.filter((p) => !txnIds.has(p.idempotencyKey));
  if (fresh.length === 0) return { txns: 0, batches: 0, periodsCreated: 0, txnIds, fresh };

  /* ------------------------------------------------------------- the periods */
  // A batch with no period is a NOT NULL violation, and the months this backfill
  // reaches are older than the three the core seed opens.
  const existing = await db
    .select({ id: schema.ledgerPeriods.id, code: schema.ledgerPeriods.code })
    .from(schema.ledgerPeriods)
    .where(eq(schema.ledgerPeriods.tenantId, tenantId));
  const periodIds = new Map(existing.map((p) => [p.code, p.id]));
  const oldestExisting = existing.map((p) => p.code).sort()[0];

  let periodsCreated = 0;
  // Opened for every posting handed in, not only the fresh ones, so a resumed
  // run opens the same months as a run that wrote the whole window at once.
  const firstAt = Math.min(...postings.map((p) => p.at));
  const lastAt = Math.max(now, ...postings.map((p) => p.at));
  for (let start = monthStartOf(firstAt); start <= lastAt; start = nextMonthStart(start)) {
    const code = monthCode(start);
    if (periodIds.has(code)) continue;
    // Months that end before the book the core seed opens are history: closed,
    // with the same checklist a real close writes.
    const closed = oldestExisting !== undefined && code < oldestExisting;
    const periodId = nid("per");
    await db.insert(schema.ledgerPeriods).values({
      id: periodId,
      tenantId,
      code,
      startAt: start,
      endAt: nextMonthStart(start) - 1,
      state: closed ? "hard_closed" : "open",
      checklistJson: closed
        ? JSON.stringify([
            { name: `trial_balance_zero@${code}`, ok: true },
            { name: `no_pending_external@${code}`, ok: true },
            { name: `no_open_client_money_breach@${code}`, ok: true }
          ])
        : null,
      closePackFileId: null,
      closedBy: closed ? postedBy : null,
      closedAt: closed ? nextMonthStart(start) + 5 * DAY : null
    });
    periodIds.set(code, periodId);
    periodsCreated += 1;
  }

  /* ---------------------------------------------------------- the postings */
  const txnRows: (typeof schema.ledgerTxns.$inferInsert)[] = [];
  const batchRows: (typeof schema.ledgerJournalBatches.$inferInsert)[] = [];
  const lineRows: (typeof schema.ledgerJournalLines.$inferInsert)[] = [];
  const transitionRows: (typeof schema.ledgerTxnTransitions.$inferInsert)[] = [];
  const deltas = new Map<string, { debitMinor: number; creditMinor: number }>();

  for (const p of fresh) {
    const txnId = nid("txn");
    txnIds.set(p.idempotencyKey, txnId);
    // A ⊘ transaction moves no money, so it carries no batch and no period.
    const batchId = p.lines.length > 0 ? nid("jbt") : null;

    const debit = p.lines.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
    const credit = p.lines.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);
    // Asserted, not assumed: an unbalanced batch would surface later as a ledger
    // property-test failure that says nothing about which day wrote it.
    if (debit !== credit) throw new Error(`seedHistory: ${p.idempotencyKey} does not balance (${debit}/${credit})`);

    txnRows.push({
      id: txnId,
      tenantId,
      type: p.type,
      idempotencyKey: p.idempotencyKey,
      correlationId: p.correlationId,
      state: "settled",
      actorKind: p.actorKind,
      actorId: p.actorId,
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify(p.amounts),
      grossMinor: p.grossMinor,
      baseGrossMinor: p.grossMinor,
      ledgerBatchId: batchId,
      createdAt: p.at,
      updatedAt: p.at + MINUTE,
      settledAt: p.at + MINUTE
    });

    if (batchId) {
      const code = monthCode(p.at);
      const periodId = periodIds.get(code);
      if (!periodId) throw new Error(`seedHistory: no ledger period ${code}`);
      batchRows.push({
        id: batchId,
        tenantId,
        txnId,
        periodId,
        currency: BASE,
        baseCurrency: BASE,
        fxRatePpm: 1_000_000,
        totalDebitMinor: debit,
        totalCreditMinor: credit,
        baseTotalDebitMinor: debit,
        baseTotalCreditMinor: credit,
        postedBy,
        postedAt: p.at
      });

      p.lines.forEach((l, i) => {
        lineRows.push({
          id: nid("jln"),
          tenantId,
          batchId,
          txnId,
          seq: i + 1,
          accountCode: l.code,
          side: l.side,
          amountMinor: l.amountMinor,
          currency: BASE,
          baseAmountMinor: l.amountMinor,
          baseCurrency: BASE,
          memo: l.memo,
          dimsJson: null,
          postedAt: p.at
        });
        const d = deltas.get(l.code) ?? { debitMinor: 0, creditMinor: 0 };
        if (l.side === "debit") d.debitMinor += l.amountMinor;
        else d.creditMinor += l.amountMinor;
        deltas.set(l.code, d);
      });
    }

    ["initiated", "settled"].forEach((to, i) => {
      transitionRows.push({
        id: nid("txt"),
        tenantId,
        txnId,
        fromState: i === 0 ? null : "initiated",
        toState: to,
        actorRef: postedBy,
        reason: null,
        ts: p.at + i * MINUTE
      });
    });
  }

  await insertChunked((rows) => db.insert(schema.ledgerTxns).values(rows), txnRows);
  await insertChunked((rows) => db.insert(schema.ledgerJournalBatches).values(rows), batchRows, 5);
  await insertChunked((rows) => db.insert(schema.ledgerJournalLines).values(rows), lineRows, 6);
  await insertChunked((rows) => db.insert(schema.ledgerTxnTransitions).values(rows), transitionRows, 12);

  /* ----------------------------------------------------------- the balances */
  // Balances are a cache of the lines, so they are added to rather than replaced:
  // the core seed's own postings are already in the row this backfill finds.
  for (const [accountCode, delta] of deltas) {
    const [row] = await db
      .select()
      .from(schema.ledgerAccountBalances)
      .where(
        and(
          eq(schema.ledgerAccountBalances.tenantId, tenantId),
          eq(schema.ledgerAccountBalances.accountCode, accountCode),
          eq(schema.ledgerAccountBalances.currency, BASE)
        )
      )
      .limit(1);
    if (row) {
      await db
        .update(schema.ledgerAccountBalances)
        .set({
          debitMinor: row.debitMinor + delta.debitMinor,
          creditMinor: row.creditMinor + delta.creditMinor,
          baseDebitMinor: row.baseDebitMinor + delta.debitMinor,
          baseCreditMinor: row.baseCreditMinor + delta.creditMinor,
          updatedAt: now
        })
        .where(eq(schema.ledgerAccountBalances.id, row.id));
    } else {
      await db.insert(schema.ledgerAccountBalances).values({
        id: nid("bal"),
        tenantId,
        accountCode,
        currency: BASE,
        debitMinor: delta.debitMinor,
        creditMinor: delta.creditMinor,
        baseDebitMinor: delta.debitMinor,
        baseCreditMinor: delta.creditMinor,
        updatedAt: now
      });
    }
  }

  return { txns: txnRows.length, batches: batchRows.length, periodsCreated, txnIds, fresh };
}

/**
 * The measured book behind the postings.
 *
 * A tenant seeded months ago has a ledger the backfill can extend, but every
 * screen that reads a *measurement* — the home KPI wall (analytics_unit_economics)
 * and all of NORTH (north_snapshots) — stays empty, because the core seed only
 * writes those around its own clock. This writes the same shapes for the window
 * the backfill covers. The row-backed metrics — policies issued, premium,
 * commission, the b2b share, the book in force — are measured from the rows
 * with the snapshotter's definitions (seed/north-book.ts), so a backfill that
 * lands under a month the core seed already measured rewrites that month
 * rather than leaving a figure its records no longer support. Policies are
 * written by the module pass (seed/history-modules.ts), which measures again
 * once they exist.
 *
 * Rates and ratios have no source in a ledger, so they follow the same
 * deterministic curve the rest of the seed uses — no random source, so a re-run
 * writes the same numbers.
 *
 * Additive and re-runnable: rows are keyed by the unique indexes on both tables
 * (tenant+day+module+unit, tenant+metric+grain+period+dims) and existing keys
 * are skipped, so this runs on every call rather than only when new days land.
 */
async function measure(
  db: CoreDb,
  tenantId: string,
  totals: Map<string, DayTotals>,
  nid: (prefix: string) => string,
  now: number,
  windowDays: number
): Promise<{ snapshots: number; unitEconomics: number }> {
  const days = [...totals.keys()].sort();
  if (days.length === 0) return { snapshots: 0, unitEconomics: 0 };

  /* ------------------------------------------------------ unit economics */
  const existingEcon = new Set(
    (
      await db
        .select({ day: schema.unitEconomics.day })
        .from(schema.unitEconomics)
        .where(and(eq(schema.unitEconomics.tenantId, tenantId), eq(schema.unitEconomics.unit, "bind")))
    ).map((r) => r.day)
  );
  const econRows: (typeof schema.unitEconomics.$inferInsert)[] = [];
  for (const day of days) {
    if (existingEcon.has(day)) continue;
    const t = totals.get(day)!;
    econRows.push({
      id: nid("uec"),
      tenantId,
      day,
      module: "dist",
      unit: "bind",
      volume: t.sales,
      // Per-bind cost of rating the panel and drafting the comparison — the same
      // figure the core seed books against its one itemised bind.
      aiCostMicro: t.sales * 41_200,
      mediaCostMicro: t.sales * 18_000,
      humanMinutes: t.sales * 12,
      // The broker's revenue on a bind is the commission, not the premium: the
      // premium is the insurer's money passing through client funds.
      revenueMinor: t.commissionMinor,
      currency: BASE,
      updatedAt: t.midnight + 23 * HOUR
    });
  }

  /* ---------------------------------------------------------- snapshots */
  const existingSnaps = new Set(
    (
      await db
        .select({
          metricKey: schema.northSnapshots.metricKey,
          grain: schema.northSnapshots.grain,
          period: schema.northSnapshots.period
        })
        .from(schema.northSnapshots)
        .where(eq(schema.northSnapshots.tenantId, tenantId))
    ).map((r) => `${r.metricKey}|${r.grain}|${r.period}`)
  );
  const snapRows: (typeof schema.northSnapshots.$inferInsert)[] = [];
  const snapshot = (metricKey: string, grain: "day" | "month", period: string, value: number, ts: number): void => {
    if (existingSnaps.has(`${metricKey}|${grain}|${period}`)) return;
    existingSnaps.add(`${metricKey}|${grain}|${period}`);
    snapRows.push({ id: nid("snp"), tenantId, metricKey, grain, period, dimsJson: null, dimsHash: "", value, ts });
  };

  /** Deterministic, seed-free, and stable per (key, period): the same day always
   *  measures the same, so a re-run against a wider window never rewrites history. */
  const curve = (key: string, period: string, min: number, span: number): number => {
    let h = 0;
    for (const ch of `${key}:${period}`) h = (h * 31 + ch.charCodeAt(0)) % 1_000_003;
    return min + (h % span);
  };

  // ILLUSTRATIVE: rates and ratios whose inputs this pass does not write.
  const periods = windowPeriods(windowDays, now);
  for (const p of periods) {
    if (p.grain === "day") {
      snapshot("quote_to_bind_rate", "day", p.period, curve("qtb", p.period, 1_900, 700), p.ts);
      snapshot("panel_response_rate", "day", p.period, curve("prr", p.period, 8_800, 1_100), p.ts);
      snapshot("quote_latency_p95", "day", p.period, curve("lat", p.period, 1_900, 1_900), p.ts);
    } else {
      snapshot("cac_per_policy", "month", p.period, curve("cac", p.period, 18_900, 5_800), p.ts);
      snapshot("renewal_retention", "month", p.period, curve("ret", p.period, 7_900, 500), p.ts);
      snapshot("loss_ratio", "month", p.period, curve("lrt", p.period, 5_900, 600), p.ts);
      snapshot("ai_cost_per_case", "month", p.period, curve("aic", p.period, 88, 34), p.ts);
    }
  }

  await insertChunked((rows) => db.insert(schema.unitEconomics).values(rows), econRows, 6);
  await insertChunked((rows) => db.insert(schema.northSnapshots).values(rows), snapRows, 8);
  // Measured, not derived from `totals`: the same rows the snapshotter reads.
  const book = await measureBook(db, tenantId, periods, {
    currency: BASE,
    nid,
    insert: (rows) => insertChunked((chunk) => db.insert(schema.northSnapshots).values(chunk), rows, 8)
  });
  return { snapshots: snapRows.length + book.written, unitEconomics: econRows.length };
}

export async function seedHistory(
  db: CoreDb,
  tenantId: string,
  options: HistoryOptions
): Promise<HistoryResult> {
  const { days, now } = options;
  if (days < 1) throw new Error("seedHistory: days must be at least 1");
  const postedBy = options.postedBy ? `user:${options.postedBy}` : "system:backfill";

  let seq = 0;
  const nid = (prefix: string): string => id(prefix, now + seq++);

  /* ------------------------------------------------------------- the window */
  const postings: Posting[] = [];
  const totals = new Map<string, DayTotals>();
  for (let dayIndex = days; dayIndex >= 1; dayIndex--) {
    // Anchored to UTC midnight, not to `now` minus a multiple of a day: a
    // posting six hours after an afternoon start lands on tomorrow's date, and
    // a day-by-day chart would show two thin days instead of one full one.
    const midnight = new Date(now - dayIndex * DAY).setUTCHours(0, 0, 0, 0);
    const dayKey = new Date(midnight).toISOString().slice(0, 10);
    for (let sale = 0; sale < SALES_PER_DAY; sale++) {
      const premiumMinor = premiumFor(dayIndex, sale);
      const taxMinor = applyPpm(premiumMinor, 50_000); // 5% VAT, AE standard rate
      const grossMinor = premiumMinor + taxMinor;
      const commissionMinor = applyPpm(premiumMinor, 150_000); // 15%, the motor rate
      const ref = `${dayKey}:${sale}`;
      const at = midnight + (9 + sale * 3) * HOUR;

      const day = totals.get(dayKey) ?? { premiumMinor: 0, commissionMinor: 0, sales: 0, midnight };
      day.premiumMinor += premiumMinor;
      day.commissionMinor += commissionMinor;
      day.sales += 1;
      totals.set(dayKey, day);

      postings.push(
        {
          // The customer pays. Their money sits segregated until the insurer is paid.
          type: "PREM-COLLECT",
          idempotencyKey: `history:prem-collect:${ref}`,
          correlationId: `history:sale:${ref}`,
          actorKind: "customer",
          actorId: `history:${ref}`,
          grossMinor,
          amounts: { gross: grossMinor, net: premiumMinor, tax: taxMinor },
          at,
          lines: [
            { code: "1010", side: "debit", amountMinor: grossMinor, memo: `Premium collected ${ref}` },
            { code: "2010", side: "credit", amountMinor: grossMinor, memo: `Client money held ${ref}` }
          ]
        },
        {
          // Commission is earned on issue, so it accrues before anyone pays it.
          type: "CMSN-ACCR",
          idempotencyKey: `history:cmsn-accr:${ref}`,
          correlationId: `history:sale:${ref}`,
          actorKind: "system",
          actorId: "scheduler",
          grossMinor: commissionMinor,
          amounts: { gross: commissionMinor, net: commissionMinor, tax: 0 },
          at: at + 5 * MINUTE,
          lines: [
            { code: "1100", side: "debit", amountMinor: commissionMinor, memo: `Commission receivable ${ref}` },
            { code: "4000", side: "credit", amountMinor: commissionMinor, memo: `Commission earned ${ref}` }
          ]
        },
        {
          // Settlement day: the insurer is paid out of client money and the
          // commission moves to the operating account, clearing the receivable.
          // Both client-money legs move together, so 1010 ≥ 2010 still holds.
          type: "PREM-REMIT",
          idempotencyKey: `history:prem-remit:${ref}`,
          correlationId: `history:sale:${ref}`,
          actorKind: "user",
          actorId: options.postedBy ?? "system",
          grossMinor,
          amounts: { gross: grossMinor, commission: commissionMinor, net: grossMinor - commissionMinor },
          at: at + 6 * HOUR,
          lines: [
            { code: "2010", side: "debit", amountMinor: grossMinor, memo: `Client money released ${ref}` },
            { code: "1000", side: "debit", amountMinor: commissionMinor, memo: `Commission received ${ref}` },
            { code: "1010", side: "credit", amountMinor: grossMinor, memo: `Remitted to insurer ${ref}` },
            { code: "1100", side: "credit", amountMinor: commissionMinor, memo: `Receivable cleared ${ref}` }
          ]
        }
      );
    }
  }

  /* --------------------------------------------------- post, then measure */
  const posted = await postAll(db, tenantId, postings, { now, postedBy, nid });
  const dayOf = (p: Posting): string => p.correlationId.slice("history:sale:".length, "history:sale:".length + 10);
  const freshDays = new Set(posted.fresh.map(dayOf));
  const allDays = new Set(postings.map(dayOf));

  // Measurements are written for the whole window, not only for days whose
  // postings are new: a tenant backfilled before this existed has the ledger
  // already and needs exactly this pass to fill its metric screens.
  const measured = await measure(db, tenantId, totals, nid, now, days);

  return {
    daysWritten: freshDays.size,
    daysSkipped: allDays.size - freshDays.size,
    txns: posted.txns,
    batches: posted.batches,
    periodsCreated: posted.periodsCreated,
    ...measured
  };
}

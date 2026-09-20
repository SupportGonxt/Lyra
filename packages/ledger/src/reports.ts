import { and, asc, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import { applyPpm, badRequest, notFound, tenantAccount, tenantChart, tenantChartMap, type Ctx } from "@lyra/core";
import { fxRateFor } from "./posting.js";

// docs/19 §9. Every figure a finance user sees comes from here, and every one of
// them is derived from ledger_journal_lines — the balances table is a cache we
// can always rebuild and check against (see `rebuildBalances`).

export interface TrialBalanceRow {
  accountCode: string;
  name: string;
  type: string;
  normalSide: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

export interface TrialBalance {
  currency: string;
  asOf: number;
  periodCode?: string;
  rows: TrialBalanceRow[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
}

function periodWindow(code: string): { from: number; to: number } {
  const [y, m] = code.split("-").map(Number);
  if (!y || !m) throw notFound(`period ${code}`);
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) - 1 };
}

/**
 * Summed from lines in base currency, so a multi-currency tenant still gets one
 * balanced statement. `periodCode` gives the movement in that month; without it
 * the report is cumulative to `asOf`.
 */
export async function trialBalance(
  ctx: Ctx,
  opts: { periodCode?: string; asOf?: number; currency?: string } = {}
): Promise<TrialBalance> {
  const asOf = opts.asOf ?? ctx.now;
  const l = schema.ledgerJournalLines;
  const where = [eq(l.tenantId, ctx.tenantId), lte(l.postedAt, asOf)];
  if (opts.periodCode) {
    const w = periodWindow(opts.periodCode);
    where.push(gte(l.postedAt, w.from), lte(l.postedAt, Math.min(w.to, asOf)));
  }
  if (opts.currency) where.push(eq(l.currency, opts.currency));

  const rows = await ctx.db
    .select({
      accountCode: l.accountCode,
      side: l.side,
      total: sql<number>`sum(${l.baseAmountMinor})`
    })
    .from(l)
    .where(and(...where))
    .groupBy(l.accountCode, l.side);

  const byAccount = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    const acc = byAccount.get(r.accountCode) ?? { debit: 0, credit: 0 };
    if (r.side === "debit") acc.debit += Number(r.total);
    else acc.credit += Number(r.total);
    byAccount.set(r.accountCode, acc);
  }

  const chartMap = await tenantChartMap(ctx);
  const out: TrialBalanceRow[] = [];
  let totalDebitMinor = 0;
  let totalCreditMinor = 0;
  for (const [code, v] of [...byAccount].sort(([a], [b]) => a.localeCompare(b))) {
    const def = chartMap.get(code);
    const normalSide = def?.normalSide ?? "debit";
    out.push({
      accountCode: code,
      name: def?.en ?? code,
      type: def?.type ?? "unknown",
      normalSide,
      debitMinor: v.debit,
      creditMinor: v.credit,
      balanceMinor: normalSide === "debit" ? v.debit - v.credit : v.credit - v.debit
    });
    totalDebitMinor += v.debit;
    totalCreditMinor += v.credit;
  }

  return {
    currency: opts.currency ?? ctx.policy.currency,
    asOf,
    ...(opts.periodCode ? { periodCode: opts.periodCode } : {}),
    rows: out,
    totalDebitMinor,
    totalCreditMinor,
    balanced: totalDebitMinor === totalCreditMinor
  };
}

export interface AccountStatementLine {
  batchId: string;
  txnId: string;
  seq: number;
  side: string;
  amountMinor: number;
  baseAmountMinor: number;
  currency: string;
  memo: string | null;
  dims: Record<string, unknown> | null;
  postedAt: number;
  runningMinor: number;
}

/** The drill-down behind any trial-balance figure: every line, with a running total. */
export async function accountStatement(
  ctx: Ctx,
  accountCode: string,
  opts: { currency?: string; from?: number; to?: number; limit?: number } = {}
): Promise<{ accountCode: string; openingMinor: number; closingMinor: number; lines: AccountStatementLine[] }> {
  const def = await tenantAccount(ctx, accountCode);
  const normalSide = def?.normalSide ?? "debit";
  const l = schema.ledgerJournalLines;
  const base = [eq(l.tenantId, ctx.tenantId), eq(l.accountCode, accountCode)];
  if (opts.currency) base.push(eq(l.currency, opts.currency));

  // Opening balance is everything before the window, not a stored figure —
  // otherwise a backdated correction would silently change history.
  let openingMinor = 0;
  if (opts.from) {
    const prior = await ctx.db
      .select({ side: l.side, total: sql<number>`sum(${l.baseAmountMinor})` })
      .from(l)
      .where(and(...base, sql`${l.postedAt} < ${opts.from}`))
      .groupBy(l.side);
    for (const p of prior) {
      const signed = p.side === normalSide ? Number(p.total) : -Number(p.total);
      openingMinor += signed;
    }
  }

  const where = [...base];
  if (opts.from) where.push(gte(l.postedAt, opts.from));
  if (opts.to) where.push(lte(l.postedAt, opts.to));

  const rows = await ctx.db
    .select()
    .from(l)
    .where(and(...where))
    .orderBy(asc(l.postedAt), asc(l.seq))
    .limit(opts.limit ?? 500);

  let running = openingMinor;
  const lines = rows.map((r) => {
    running += r.side === normalSide ? r.baseAmountMinor : -r.baseAmountMinor;
    return {
      batchId: r.batchId,
      txnId: r.txnId,
      seq: r.seq,
      side: r.side,
      amountMinor: r.amountMinor,
      baseAmountMinor: r.baseAmountMinor,
      currency: r.currency,
      memo: r.memo,
      dims: r.dimsJson ? (JSON.parse(r.dimsJson) as Record<string, unknown>) : null,
      postedAt: r.postedAt,
      runningMinor: running
    };
  });

  return { accountCode, openingMinor, closingMinor: running, lines };
}

export interface ClientMoneyPosition {
  currency: string;
  assetMinor: number;
  liabilityMinor: number;
  surplusMinor: number;
  breach: boolean;
  asOf: number;
}

/**
 * docs/12: the regulator's question is "is client money whole right now". This
 * answers it from lines, independently of the running-balance cache, so the two
 * can be compared as a control.
 */
export async function clientMoneyPosition(ctx: Ctx, currency?: string): Promise<ClientMoneyPosition[]> {
  const l = schema.ledgerJournalLines;
  const where = [eq(l.tenantId, ctx.tenantId), sql`${l.accountCode} in ('1010','2010')`];
  if (currency) where.push(eq(l.currency, currency));

  const rows = await ctx.db
    .select({
      currency: l.currency,
      accountCode: l.accountCode,
      side: l.side,
      total: sql<number>`sum(${l.amountMinor})`
    })
    .from(l)
    .where(and(...where))
    .groupBy(l.currency, l.accountCode, l.side);

  const byCurrency = new Map<string, { asset: number; liability: number }>();
  for (const r of rows) {
    const acc = byCurrency.get(r.currency) ?? { asset: 0, liability: 0 };
    const n = Number(r.total);
    if (r.accountCode === "1010") acc.asset += r.side === "debit" ? n : -n;
    else acc.liability += r.side === "credit" ? n : -n;
    byCurrency.set(r.currency, acc);
  }

  return [...byCurrency].map(([cur, v]) => ({
    currency: cur,
    assetMinor: v.asset,
    liabilityMinor: v.liability,
    surplusMinor: v.asset - v.liability,
    breach: v.asset < v.liability,
    asOf: ctx.now
  }));
}

export interface RebuildResult {
  accountCode: string;
  currency: string;
  storedDebitMinor: number;
  storedCreditMinor: number;
  rebuiltDebitMinor: number;
  rebuiltCreditMinor: number;
  drifted: boolean;
}

/**
 * The control that makes the balances cache trustworthy: re-sum every line and
 * compare. `apply` repairs drift; without it this is a read-only audit that can
 * be run against production safely.
 */
export async function rebuildBalances(
  ctx: Ctx,
  opts: { apply?: boolean } = {}
): Promise<RebuildResult[]> {
  const l = schema.ledgerJournalLines;
  const rebuilt = await ctx.db
    .select({
      accountCode: l.accountCode,
      currency: l.currency,
      side: l.side,
      amount: sql<number>`sum(${l.amountMinor})`,
      base: sql<number>`sum(${l.baseAmountMinor})`
    })
    .from(l)
    .where(eq(l.tenantId, ctx.tenantId))
    .groupBy(l.accountCode, l.currency, l.side);

  const key = (a: string, c: string) => `${a}|${c}`;
  const map = new Map<string, { debit: number; credit: number; baseDebit: number; baseCredit: number }>();
  for (const r of rebuilt) {
    const k = key(r.accountCode, r.currency);
    const v = map.get(k) ?? { debit: 0, credit: 0, baseDebit: 0, baseCredit: 0 };
    if (r.side === "debit") {
      v.debit += Number(r.amount);
      v.baseDebit += Number(r.base);
    } else {
      v.credit += Number(r.amount);
      v.baseCredit += Number(r.base);
    }
    map.set(k, v);
  }

  const stored = await ctx.db
    .select()
    .from(schema.ledgerAccountBalances)
    .where(eq(schema.ledgerAccountBalances.tenantId, ctx.tenantId));
  const storedMap = new Map(stored.map((s) => [key(s.accountCode, s.currency), s]));

  const out: RebuildResult[] = [];
  for (const [k, v] of map) {
    const [accountCode = "", currency = ""] = k.split("|");
    const s = storedMap.get(k);
    const drifted = !s || s.debitMinor !== v.debit || s.creditMinor !== v.credit;
    out.push({
      accountCode,
      currency,
      storedDebitMinor: s?.debitMinor ?? 0,
      storedCreditMinor: s?.creditMinor ?? 0,
      rebuiltDebitMinor: v.debit,
      rebuiltCreditMinor: v.credit,
      drifted
    });
    if (drifted && opts.apply) {
      await ctx.db
        .insert(schema.ledgerAccountBalances)
        .values({
          id: `bal_${ctx.tenantId}_${accountCode}_${currency}`,
          tenantId: ctx.tenantId,
          accountCode,
          currency,
          debitMinor: v.debit,
          creditMinor: v.credit,
          baseDebitMinor: v.baseDebit,
          baseCreditMinor: v.baseCredit,
          updatedAt: ctx.now
        })
        .onConflictDoUpdate({
          target: [
            schema.ledgerAccountBalances.tenantId,
            schema.ledgerAccountBalances.accountCode,
            schema.ledgerAccountBalances.currency
          ],
          set: {
            debitMinor: v.debit,
            creditMinor: v.credit,
            baseDebitMinor: v.baseDebit,
            baseCreditMinor: v.baseCredit,
            updatedAt: ctx.now
          }
        });
    }
  }
  return out;
}

export interface PnlSection {
  label: string;
  rows: { accountCode: string; name: string; amountMinor: number }[];
  totalMinor: number;
}

export interface Pnl {
  periodCode: string;
  currency: string;
  income: PnlSection;
  expense: PnlSection;
  grossMarginMinor: number;
  marginPpm: number;
}

/** Income statement for a month, base currency, from lines. */
export async function profitAndLoss(ctx: Ctx, code: string): Promise<Pnl> {
  const tb = await trialBalance(ctx, { periodCode: code });
  const pick = (type: string, label: string): PnlSection => {
    const rows = tb.rows
      .filter((r) => r.type === type)
      .map((r) => ({ accountCode: r.accountCode, name: r.name, amountMinor: r.balanceMinor }));
    return { label, rows, totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0) };
  };
  const income = pick("income", "Revenue");
  const expense = pick("expense", "Cost of revenue & operating");
  const grossMarginMinor = income.totalMinor - expense.totalMinor;
  return {
    periodCode: code,
    currency: ctx.policy.currency,
    income,
    expense,
    grossMarginMinor,
    marginPpm: income.totalMinor ? Math.round((grossMarginMinor / income.totalMinor) * 1_000_000) : 0
  };
}

export interface BalanceSheet {
  asOf: number;
  currency: string;
  assets: PnlSection;
  liabilities: PnlSection;
  /** Posted 3xxx accounts only. Empty until the tenant's first year-end close. */
  equity: PnlSection;
  /**
   * This year's income less expense, still sitting in 4xxx/5xxx because the year
   * has not been closed. Rendered as a labelled line (i18n `equity.current_year_unposted`)
   * so the statement balances without pretending the figure has been posted.
   * YEAR-END-CLOSE moves it into retained earnings and this goes to zero.
   */
  currentYearUnpostedMinor: number;
  /** Posted equity plus the unposted current year — what the statement must balance to. */
  equityMinor: number;
  balanced: boolean;
}

export async function balanceSheet(ctx: Ctx, asOf?: number): Promise<BalanceSheet> {
  const tb = await trialBalance(ctx, { ...(asOf !== undefined ? { asOf } : {}) });
  const pick = (type: string, label: string): PnlSection => {
    const rows = tb.rows
      .filter((r) => r.type === type)
      .map((r) => ({ accountCode: r.accountCode, name: r.name, amountMinor: r.balanceMinor }));
    return { label, rows, totalMinor: rows.reduce((s, r) => s + r.amountMinor, 0) };
  };
  const assets = pick("asset", "Assets");
  const liabilities = pick("liability", "Liabilities");
  const equity = pick("equity", "Equity");
  const income = tb.rows.filter((r) => r.type === "income").reduce((s, r) => s + r.balanceMinor, 0);
  const expense = tb.rows.filter((r) => r.type === "expense").reduce((s, r) => s + r.balanceMinor, 0);
  const currentYearUnpostedMinor = income - expense;
  const equityMinor = equity.totalMinor + currentYearUnpostedMinor;
  return {
    asOf: asOf ?? ctx.now,
    currency: ctx.policy.currency,
    assets,
    liabilities,
    equity,
    currentYearUnpostedMinor,
    equityMinor,
    balanced: assets.totalMinor === liabilities.totalMinor + equityMinor
  };
}

export interface YearEndPreview {
  fiscalYear: number;
  currency: string;
  incomeMinor: number;
  expenseMinor: number;
  netMinor: number;
  retainedEarningsAccount: string;
  /** The legs that zero every income and expense account, ready for YEAR-END-CLOSE. */
  closingLines: { accountCode: string; name: string; side: "debit" | "credit"; amountMinor: number }[];
}

/**
 * What a year-end close would post, without posting it. The balances are read
 * cumulatively to the last instant of the year: after the prior year's close the
 * income and expense accounts are already zero, so cumulative-to-date is exactly
 * this year's movement.
 */
export async function yearEndPreview(
  ctx: Ctx,
  fiscalYear: number,
  retainedEarningsAccount = "3100"
): Promise<YearEndPreview> {
  const tb = await trialBalance(ctx, { asOf: Date.UTC(fiscalYear + 1, 0, 1) - 1 });
  const closingLines: YearEndPreview["closingLines"] = [];
  let incomeMinor = 0;
  let expenseMinor = 0;
  for (const r of tb.rows) {
    if (r.type !== "income" && r.type !== "expense") continue;
    if (r.balanceMinor === 0) continue;
    if (r.type === "income") incomeMinor += r.balanceMinor;
    else expenseMinor += r.balanceMinor;
    // balanceMinor is normal-side signed, so a contra balance flips the closing
    // leg rather than posting a negative amount the ledger would refuse.
    const normalClose = r.type === "income" ? "debit" : "credit";
    const side: "debit" | "credit" =
      r.balanceMinor > 0 ? normalClose : normalClose === "debit" ? "credit" : "debit";
    closingLines.push({
      accountCode: r.accountCode,
      name: r.name,
      side,
      amountMinor: Math.abs(r.balanceMinor)
    });
  }
  return {
    fiscalYear,
    currency: ctx.policy.currency,
    incomeMinor,
    expenseMinor,
    netMinor: incomeMinor - expenseMinor,
    retainedEarningsAccount,
    closingLines
  };
}

export interface AgedRow {
  counterparty: string;
  currency: string;
  currentMinor: number;
  d30Minor: number;
  d60Minor: number;
  d90Minor: number;
  olderMinor: number;
  totalMinor: number;
}

const DAY = 86_400_000;

/**
 * Ageing by the `counterparty` dimension stamped on each line.
 *
 * @deprecated docs/27 F15 — this ages *lines by posting date*, so a settled
 * invoice never leaves the report and a 90-day term reads as 90 days overdue.
 * `agedOpenItems` replaces it and is what `/v1/ledger/reports/aged` serves;
 * this stays reachable behind `?legacy=1` for one release so a controller can
 * compare the two, and for no other reason.
 */
export async function agedBalances(
  ctx: Ctx,
  opts: { accountCodes?: string[]; asOf?: number } = {}
): Promise<AgedRow[]> {
  const asOf = opts.asOf ?? ctx.now;
  const codes = opts.accountCodes ?? ["1100", "1150", "1160"];
  const l = schema.ledgerJournalLines;
  const rows = await ctx.db
    .select()
    .from(l)
    .where(
      and(
        eq(l.tenantId, ctx.tenantId),
        lte(l.postedAt, asOf),
        sql`${l.accountCode} in (${sql.join(codes.map((c) => sql`${c}`), sql`,`)})`
      )
    )
    .orderBy(desc(l.postedAt))
    .limit(20_000);

  const buckets = new Map<string, AgedRow>();
  for (const r of rows) {
    const dims = r.dimsJson ? (JSON.parse(r.dimsJson) as Record<string, unknown>) : {};
    const counterparty = String(dims.counterparty ?? dims.provider ?? dims.partner ?? "unattributed");
    const k = `${counterparty}|${r.currency}`;
    const row =
      buckets.get(k) ??
      ({
        counterparty,
        currency: r.currency,
        currentMinor: 0,
        d30Minor: 0,
        d60Minor: 0,
        d90Minor: 0,
        olderMinor: 0,
        totalMinor: 0
      } satisfies AgedRow);
    const signed = r.side === "debit" ? r.amountMinor : -r.amountMinor;
    const age = Math.floor((asOf - r.postedAt) / DAY);
    if (age <= 30) row.currentMinor += signed;
    else if (age <= 60) row.d30Minor += signed;
    else if (age <= 90) row.d60Minor += signed;
    else if (age <= 120) row.d90Minor += signed;
    else row.olderMinor += signed;
    row.totalMinor += signed;
    buckets.set(k, row);
  }
  return [...buckets.values()].filter((r) => r.totalMinor !== 0).sort((a, b) => b.totalMinor - a.totalMinor);
}

/* --------------------------------------------- fx revaluation (F18) */

export interface FxAdjustment {
  accountCode: string;
  currency: string;
  /** Open balance in the transaction currency, signed to the account's normal side. */
  balanceMinor: number;
  /** What the ledger currently carries this at, in base currency. */
  carriedBaseMinor: number;
  /** What it is worth at the closing rate. */
  revaluedBaseMinor: number;
  /** revalued − carried. Positive increases the account's normal side. */
  deltaMinor: number;
  ratePpm: number;
}

export interface FxRevaluationPlan {
  asOf: number;
  baseCurrency: string;
  adjustments: FxAdjustment[];
  /** Net income effect: gains on assets less gains on liabilities. */
  netMinor: number;
}

/**
 * docs/19 §5.3, "revaluation job for open receivables/payables at period end"
 * (docs/27 F18). A read-only plan: what a revaluation *would* post, computed
 * from the lines and the rate table, so a controller sees the number before it
 * exists rather than after.
 *
 * Two exclusions, both deliberate.
 *
 * **The base currency.** There is nothing to revalue; the carried amount is the
 * amount.
 *
 * **Client money.** A gain on `1010` would be income recognised inside client
 * money, which docs/19 §5.2 B forbids outright — and rightly: the money is not
 * ours, so neither is the movement in what it is worth. A tenant holding client
 * money in a foreign currency has a segregation question, not a P&L one.
 *
 * Income and expense accounts are excluded for the ordinary reason: they were
 * translated at the rate on the day of the transaction and that is where they
 * stay. Only monetary balances — what is owed, in either direction — move.
 */
export async function fxRevaluationPlan(
  ctx: Ctx,
  opts: { asOf?: number; baseCurrency?: string } = {}
): Promise<FxRevaluationPlan> {
  const asOf = opts.asOf ?? ctx.now;
  const base = opts.baseCurrency ?? ctx.policy.currency;
  const l = schema.ledgerJournalLines;

  const rows = await ctx.db
    .select({
      accountCode: l.accountCode,
      currency: l.currency,
      side: l.side,
      amount: sql<number>`sum(${l.amountMinor})`,
      baseAmount: sql<number>`sum(${l.baseAmountMinor})`
    })
    .from(l)
    .where(and(eq(l.tenantId, ctx.tenantId), lte(l.postedAt, asOf)))
    .groupBy(l.accountCode, l.currency, l.side);

  const chartMap = await tenantChartMap(ctx);
  const revaluable = (code: string): boolean => {
    const def = chartMap.get(code);
    return Boolean(def) && (def?.type === "asset" || def?.type === "liability") && !def?.clientMoney;
  };

  const positions = new Map<string, { accountCode: string; currency: string; balance: number; carried: number }>();
  const at = (accountCode: string, currency: string) => {
    const k = `${accountCode}|${currency}`;
    const p = positions.get(k) ?? { accountCode, currency, balance: 0, carried: 0 };
    positions.set(k, p);
    return p;
  };

  for (const r of rows) {
    if (r.currency === base) continue;
    if (!revaluable(r.accountCode)) continue;
    const p = at(r.accountCode, r.currency);
    const sign = r.side === chartMap.get(r.accountCode)?.normalSide ? 1 : -1;
    p.balance += sign * Number(r.amount);
    p.carried += sign * Number(r.baseAmount);
  }

  // Prior revaluations post in the *base* currency against the same account, so
  // they are invisible to the loop above — and without them every period end
  // would report the same difference again, having already corrected it. The
  // `revalues` dim (recipes.ts `fxRevaluation`) is what ties a base-currency
  // adjustment back to the foreign position it belongs to.
  const priorAdjustments = await ctx.db
    .select({
      accountCode: l.accountCode,
      side: l.side,
      baseAmountMinor: l.baseAmountMinor,
      dimsJson: l.dimsJson
    })
    .from(l)
    .where(
      and(
        eq(l.tenantId, ctx.tenantId),
        lte(l.postedAt, asOf),
        eq(l.currency, base),
        sql`${l.dimsJson} like '%"revalues"%'`
      )
    );
  for (const r of priorAdjustments) {
    if (!revaluable(r.accountCode)) continue;
    const dims = r.dimsJson ? (JSON.parse(r.dimsJson) as Record<string, unknown>) : {};
    const revalues = dims["revalues"];
    if (typeof revalues !== "string" || revalues === base) continue;
    const p = at(r.accountCode, revalues);
    p.carried += (r.side === chartMap.get(r.accountCode)?.normalSide ? 1 : -1) * r.baseAmountMinor;
  }

  const adjustments: FxAdjustment[] = [];
  let netMinor = 0;
  for (const p of positions.values()) {
    if (p.balance === 0 && p.carried === 0) continue;
    const ratePpm = await fxRateFor(ctx, p.currency, base);
    // Fail closed. A missing rate is not "no movement": it is a position nobody
    // can value, and reporting it as flat would be the quiet wrong answer.
    if (!ratePpm) {
      throw badRequest(
        `no fx rate on file for ${p.currency} -> ${base}; cannot revalue the open ${p.accountCode} balance`
      );
    }
    const revalued = applyPpm(p.balance, ratePpm);
    const delta = revalued - p.carried;
    if (delta === 0) continue;
    adjustments.push({
      accountCode: p.accountCode,
      currency: p.currency,
      balanceMinor: p.balance,
      carriedBaseMinor: p.carried,
      revaluedBaseMinor: revalued,
      deltaMinor: delta,
      ratePpm
    });
    netMinor += chartMap.get(p.accountCode)?.normalSide === "debit" ? delta : -delta;
  }

  return { asOf, baseCurrency: base, adjustments, netMinor };
}

/* ------------------------------------------------- open-item aging (F15) */

/** What a customer, insurer or financier owes us. */
export const RECEIVABLE_AGING_ACCOUNTS = ["1100", "1150", "1155", "1160", "1200"] as const;
/** What we owe an insurer, channel, creator, supplier or the tax authority. */
export const PAYABLE_AGING_ACCOUNTS = ["2000", "2100", "2150", "2200", "2250", "2400"] as const;

export interface OpenItem {
  /** The item's own reference: an invoice number, a policy id, a settlement run. */
  ref: string;
  accountCode: string;
  /** Still outstanding, always positive whichever side of the ledger it is. */
  openMinor: number;
  raisedAt: number;
  dueAt: number;
  daysOverdue: number;
}

export interface AgedOpenItemRow {
  counterparty: string;
  currency: string;
  kind: "receivable" | "payable";
  currentMinor: number;
  d30Minor: number;
  d60Minor: number;
  d90Minor: number;
  olderMinor: number;
  totalMinor: number;
  items: OpenItem[];
}

/** `dims.item` is the open-item key; everything else is a fallback for old rows. */
function itemRef(dims: Record<string, unknown>, txnId: string): string {
  for (const k of ["item", "invoice", "policy", "settlement"]) {
    const v = dims[k];
    if (typeof v === "string" && v) return v;
  }
  // An unkeyed line is its own item. That is correct rather than convenient: two
  // lines nobody related can only be netted by guessing, and a guess here is a
  // debt that silently disappears from the report.
  return txnId;
}

function counterpartyRef(dims: Record<string, unknown>): string {
  for (const k of ["counterparty", "provider", "partner", "channel", "customer"]) {
    const v = dims[k];
    if (typeof v === "string" && v) return v;
  }
  return "unattributed";
}

/**
 * docs/27 F15. Three faults in one report, and they are worth naming separately
 * because the fix for each is different.
 *
 * **It aged lines.** A receivable raised in January and settled in February was
 * two lines in two buckets; nothing netted them, so a fully-paid item stayed on
 * the report forever and the totals were gross, not open. Here the unit is the
 * *item* — lines grouped by `dims.item` — and an item that nets to zero is
 * simply not open.
 *
 * **It aged by posting date.** That is when we invoiced, not when they owe. The
 * bucket is now measured from `dims.dueAt`, falling back to the date the item
 * was raised — a debt with no terms on file is due on demand. It deliberately
 * does *not* fall back to "today", which would report every unpaid item as
 * current: the friendly lie an aging report exists to prevent.
 *
 * **It had no payables side.** `kind: "payable"` reads the liability accounts
 * and flips the sign, so "what do we owe and how late are we" has an answer.
 * The two account sets are disjoint by construction (there is a test), so
 * nothing is counted on both sides.
 */
export async function agedOpenItems(
  ctx: Ctx,
  opts: {
    kind?: "receivable" | "payable";
    accountCodes?: readonly string[];
    asOf?: number;
    currency?: string;
    /** Items whose open balance is below this are noise; default 0 keeps all. */
    minOpenMinor?: number;
  } = {}
): Promise<AgedOpenItemRow[]> {
  const asOf = opts.asOf ?? ctx.now;
  const kind = opts.kind ?? "receivable";
  const codes = opts.accountCodes ?? (kind === "receivable" ? RECEIVABLE_AGING_ACCOUNTS : PAYABLE_AGING_ACCOUNTS);
  // The side that *increases* the balance: a receivable grows on a debit, a
  // payable on a credit. Everything on the other side reduces the item.
  const openingSide = kind === "receivable" ? "debit" : "credit";

  const l = schema.ledgerJournalLines;
  const where = [
    eq(l.tenantId, ctx.tenantId),
    lte(l.postedAt, asOf),
    sql`${l.accountCode} in (${sql.join(codes.map((c) => sql`${c}`), sql`,`)})`
  ];
  if (opts.currency) where.push(eq(l.currency, opts.currency));

  const rows = await ctx.db
    .select()
    .from(l)
    .where(and(...where))
    .orderBy(asc(l.postedAt))
    .limit(50_000);

  interface Acc {
    ref: string;
    accountCode: string;
    counterparty: string;
    currency: string;
    openMinor: number;
    raisedAt: number;
    dueAt: number | null;
  }
  const items = new Map<string, Acc>();
  for (const r of rows) {
    const dims = r.dimsJson ? (JSON.parse(r.dimsJson) as Record<string, unknown>) : {};
    const ref = itemRef(dims, r.txnId);
    const counterparty = counterpartyRef(dims);
    const key = `${r.accountCode}|${r.currency}|${counterparty}|${ref}`;
    const acc =
      items.get(key) ??
      ({
        ref,
        accountCode: r.accountCode,
        counterparty,
        currency: r.currency,
        openMinor: 0,
        raisedAt: r.postedAt,
        dueAt: null
      } satisfies Acc);
    acc.openMinor += r.side === openingSide ? r.amountMinor : -r.amountMinor;
    // The opening leg is what carries the terms and what the item was raised on.
    if (r.side === openingSide) {
      acc.raisedAt = Math.min(acc.raisedAt, r.postedAt);
      const due = dims["dueAt"];
      if (typeof due === "number" && Number.isFinite(due)) acc.dueAt = acc.dueAt === null ? due : Math.min(acc.dueAt, due);
    }
    items.set(key, acc);
  }

  const floor = opts.minOpenMinor ?? 0;
  const byCounterparty = new Map<string, AgedOpenItemRow>();
  for (const acc of items.values()) {
    if (acc.openMinor <= floor) continue;
    const dueAt = acc.dueAt ?? acc.raisedAt;
    // Never negative: an item that is not due yet is zero days overdue, not
    // minus thirty. A negative age would sort a future debt above a late one.
    const daysOverdue = Math.max(0, Math.floor((asOf - dueAt) / DAY));
    const k = `${acc.counterparty}|${acc.currency}`;
    const row =
      byCounterparty.get(k) ??
      ({
        counterparty: acc.counterparty,
        currency: acc.currency,
        kind,
        currentMinor: 0,
        d30Minor: 0,
        d60Minor: 0,
        d90Minor: 0,
        olderMinor: 0,
        totalMinor: 0,
        items: []
      } satisfies AgedOpenItemRow);
    if (daysOverdue <= 30) row.currentMinor += acc.openMinor;
    else if (daysOverdue <= 60) row.d30Minor += acc.openMinor;
    else if (daysOverdue <= 90) row.d60Minor += acc.openMinor;
    else if (daysOverdue <= 120) row.d90Minor += acc.openMinor;
    else row.olderMinor += acc.openMinor;
    row.totalMinor += acc.openMinor;
    row.items.push({
      ref: acc.ref,
      accountCode: acc.accountCode,
      openMinor: acc.openMinor,
      raisedAt: acc.raisedAt,
      dueAt,
      daysOverdue
    });
    byCounterparty.set(k, row);
  }

  const out = [...byCounterparty.values()];
  for (const row of out) row.items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return out.sort((a, b) => b.totalMinor - a.totalMinor);
}

/**
 * Half-open `[from, to)`, the window convention every metric compute windows
 * on. A period code cannot express a month-to-date, and NORTH's money metrics
 * are read through here rather than by NORTH querying journal lines itself
 * (docs/27 F49) — so the reports take the window.
 */
export interface ReportWindow {
  from: number;
  to: number;
}

/**
 * Expense movement (5xxx) in base currency over a window: debits less the
 * credits that relieve them, so a corrected or reversed cost nets out. This is
 * `profitAndLoss(...).expense.totalMinor` for an arbitrary window rather than
 * a whole month.
 */
export async function expenseMovementMinor(ctx: Ctx, window: ReportWindow): Promise<number> {
  const l = schema.ledgerJournalLines;
  const [row] = await ctx.db
    .select({
      v: sql<number>`coalesce(sum(case when ${l.side} = 'debit' then ${l.baseAmountMinor} else -${l.baseAmountMinor} end), 0)`
    })
    .from(l)
    .where(and(eq(l.tenantId, ctx.tenantId), sql`${l.accountCode} like '5%'`, gte(l.postedAt, window.from), lt(l.postedAt, window.to)));
  return row?.v ?? 0;
}

export interface CommissionByDimension {
  dimension: string;
  value: string;
  grossMinor: number;
  channelShareMinor: number;
  netMinor: number;
  currency: string;
}

/**
 * The aggregator's core question: what did we earn, from which underwriter,
 * through which channel, and what did the channel keep. Grouped by any dimension
 * stamped on the line.
 */
export async function commissionByDimension(
  ctx: Ctx,
  dimension: string,
  opts: { periodCode?: string; window?: ReportWindow } = {}
): Promise<CommissionByDimension[]> {
  const l = schema.ledgerJournalLines;
  // Parenthesised, and that is load-bearing: `AND` binds tighter than `OR`, so
  // an unbracketed `tenant AND code like '40%' or code = '2100' AND window`
  // parses as `(tenant AND 40%) OR (2100 AND window)` — every commission line
  // the tenant ever posted, whatever window was asked for.
  const where = [eq(l.tenantId, ctx.tenantId), sql`(${l.accountCode} like '40%' or ${l.accountCode} = '2100')`];
  if (opts.periodCode) {
    const w = periodWindow(opts.periodCode);
    where.push(gte(l.postedAt, w.from), lte(l.postedAt, w.to));
  } else if (opts.window) {
    where.push(gte(l.postedAt, opts.window.from), lt(l.postedAt, opts.window.to));
  }
  const rows = await ctx.db
    .select()
    .from(l)
    .where(and(...where))
    .limit(50_000);

  const out = new Map<string, CommissionByDimension>();
  for (const r of rows) {
    const dims = r.dimsJson ? (JSON.parse(r.dimsJson) as Record<string, unknown>) : {};
    const value = String(dims[dimension] ?? "unattributed");
    const k = `${value}|${r.currency}`;
    const row =
      out.get(k) ??
      ({ dimension, value, grossMinor: 0, channelShareMinor: 0, netMinor: 0, currency: r.currency } satisfies CommissionByDimension);
    const signed = r.side === "credit" ? r.amountMinor : -r.amountMinor;
    if (r.accountCode === "2100") row.channelShareMinor += signed;
    else row.netMinor += signed;
    row.grossMinor = row.netMinor + row.channelShareMinor;
    out.set(k, row);
  }
  return [...out.values()].sort((a, b) => b.grossMinor - a.grossMinor);
}

/** Flat rows for the XLSX/PDF exporters — one shape, every report. */
export interface ReportTable {
  title: string;
  columns: { key: string; label: string; kind: "text" | "money" | "date" | "number" }[];
  rows: Record<string, unknown>[];
  currency?: string;
  generatedAt: number;
}

export function trialBalanceTable(tb: TrialBalance): ReportTable {
  return {
    title: tb.periodCode ? `Trial balance ${tb.periodCode}` : "Trial balance",
    columns: [
      { key: "accountCode", label: "Account", kind: "text" },
      { key: "name", label: "Name", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "debitMinor", label: "Debit", kind: "money" },
      { key: "creditMinor", label: "Credit", kind: "money" },
      { key: "balanceMinor", label: "Balance", kind: "money" }
    ],
    rows: tb.rows as unknown as Record<string, unknown>[],
    currency: tb.currency,
    generatedAt: tb.asOf
  };
}

/**
 * Accounts with no movement still belong on a chart-of-accounts export.
 *
 * ADR-0083: reads this tenant's own chart, so an account it added at runtime
 * appears on its own export — a chart-of-accounts report that could not show
 * a tenant-added account was the finding this table exists to close.
 */
export async function chartOfAccountsTable(ctx: Ctx): Promise<ReportTable> {
  const chart = await tenantChart(ctx);
  return {
    title: "Chart of accounts",
    columns: [
      { key: "code", label: "Code", kind: "text" },
      { key: "en", label: "Name", kind: "text" },
      { key: "type", label: "Type", kind: "text" },
      { key: "normalSide", label: "Normal side", kind: "text" }
    ],
    rows: chart as unknown as Record<string, unknown>[],
    generatedAt: ctx.now
  };
}

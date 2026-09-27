import { and, eq, gte, lte, ne, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, scoped, tenantChartMap, type Ctx } from "@lyra/core";

// docs/30 Ledger 4, ADR-0104. Budget against actual, per account and month.
//
// A budget is a plan, not a posting: it moves no money, so it never touches the
// journal and never needs the posting invariants. What it must not do is lie.
// Three rules follow:
//
// 1. One currency per row. A budget is compared only with lines posted in its
//    own currency, in that currency's minor units — never with a base-currency
//    equivalent, and never added to a figure in another currency. An account
//    that moved in USD against an AED budget shows two rows.
// 2. No budget is not a zero budget. Unbudgeted movement shows the actual with
//    no variance, no percentage and no verdict; a zero budget has a variance
//    but no percentage, because a ratio to nothing is not a number.
// 3. Actuals are the journal. Every figure is summed from ledger_journal_lines,
//    like every other report (docs/19 §9), on the account's normal side.

export interface BudgetEntry {
  accountCode: string;
  currency: string;
  amountMinor: number;
}

/** Debits and credits on one account in one currency over the window. */
export interface Movement {
  accountCode: string;
  currency: string;
  debitMinor: number;
  creditMinor: number;
}

export interface BudgetAccount {
  name: string;
  type: string;
  normalSide: "debit" | "credit";
}

export interface BudgetVsActualRow {
  accountCode: string;
  name: string;
  type: string;
  currency: string;
  /** Null when no budget was set for this account, month and currency. */
  budgetMinor: number | null;
  /** Normal-side movement: debit less credit on a debit account, and vice versa. */
  actualMinor: number;
  /** actual − budget; null without a budget. */
  varianceMinor: number | null;
  /** variance ÷ budget in parts per million; null without a budget or against zero. */
  variancePpm: number | null;
  /**
   * Income over plan and spend under plan are good news. Only income and
   * expense accounts have a direction; anything else is null, as is a row
   * with no budget to be favourable against.
   */
  favourable: boolean | null;
}

export interface BudgetVsActual {
  periodCode: string;
  from: number;
  to: number;
  rows: BudgetVsActualRow[];
}

const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** `YYYY-MM`, a real month. */
export function assertPeriodCode(code: string): void {
  if (!PERIOD.test(code)) throw badRequest(`period must be a month as YYYY-MM, not "${code}"`);
}

/** Accounts whose unbudgeted movement is still worth a row: the P&L. */
const PERFORMANCE_TYPES = new Set(["income", "expense"]);

/** The one pure step: budgets and movements in, one row per account and currency out. */
export function compareBudgets(
  budgets: readonly BudgetEntry[],
  movements: readonly Movement[],
  chart: ReadonlyMap<string, BudgetAccount>
): BudgetVsActualRow[] {
  const key = (accountCode: string, currency: string) => `${accountCode}\u0000${currency}`;

  const planned = new Map<string, BudgetEntry>();
  for (const b of budgets) {
    const k = key(b.accountCode, b.currency);
    if (planned.has(k)) throw badRequest(`account ${b.accountCode} is budgeted twice in ${b.currency}`);
    planned.set(k, b);
  }

  const actual = new Map<string, { accountCode: string; currency: string; debit: number; credit: number }>();
  for (const m of movements) {
    const k = key(m.accountCode, m.currency);
    const acc = actual.get(k) ?? { accountCode: m.accountCode, currency: m.currency, debit: 0, credit: 0 };
    acc.debit += m.debitMinor;
    acc.credit += m.creditMinor;
    actual.set(k, acc);
  }

  const rows: BudgetVsActualRow[] = [];
  const keys = new Set([...planned.keys(), ...actual.keys()]);
  for (const k of keys) {
    const b = planned.get(k);
    const a = actual.get(k);
    const accountCode = (b ?? a)!.accountCode;
    const currency = (b ?? a)!.currency;
    const def = chart.get(accountCode);
    const type = def?.type ?? "unknown";
    if (!b && !PERFORMANCE_TYPES.has(type)) continue;

    const debit = a?.debit ?? 0;
    const credit = a?.credit ?? 0;
    const actualMinor = (def?.normalSide ?? "debit") === "debit" ? debit - credit : credit - debit;
    const budgetMinor = b ? b.amountMinor : null;
    const varianceMinor = budgetMinor === null ? null : actualMinor - budgetMinor;
    rows.push({
      accountCode,
      name: def?.name ?? accountCode,
      type,
      currency,
      budgetMinor,
      actualMinor,
      varianceMinor,
      variancePpm:
        varianceMinor === null || !budgetMinor ? null : Math.round((varianceMinor / budgetMinor) * 1_000_000),
      favourable:
        varianceMinor === null || !PERFORMANCE_TYPES.has(type)
          ? null
          : type === "income"
            ? varianceMinor >= 0
            : varianceMinor <= 0
    });
  }

  return rows.sort((x, y) => x.accountCode.localeCompare(y.accountCode) || x.currency.localeCompare(y.currency));
}

/** A close moves profit into retained earnings; it is not the month's performance (ADR-0090 §4). */
const CLOSING_TXN_TYPE = "YEAR-END-CLOSE";

/** Budget against actual for one month, from this tenant's budgets and posted lines. */
export async function budgetVsActual(ctx: Ctx, periodCode: string): Promise<BudgetVsActual> {
  assertPeriodCode(periodCode);
  const [y, m] = periodCode.split("-").map(Number) as [number, number];
  const from = Date.UTC(y, m - 1, 1);
  const to = Date.UTC(y, m, 1) - 1;

  const b = schema.ledgerBudgets;
  const l = schema.ledgerJournalLines;
  const t = schema.ledgerTxns;

  const [budgets, sums, chart] = await Promise.all([
    ctx.db
      .select({ accountCode: b.accountCode, currency: b.currency, amountMinor: b.amountMinor })
      .from(b)
      .where(scoped(ctx, b, eq(b.period, periodCode))),
    ctx.db
      .select({
        accountCode: l.accountCode,
        currency: l.currency,
        side: l.side,
        total: sql<number>`sum(${l.amountMinor})`
      })
      .from(l)
      .innerJoin(t, and(eq(t.id, l.txnId), eq(t.tenantId, l.tenantId)))
      .where(
        and(eq(l.tenantId, ctx.tenantId), gte(l.postedAt, from), lte(l.postedAt, to), ne(t.type, CLOSING_TXN_TYPE))
      )
      .groupBy(l.accountCode, l.currency, l.side),
    tenantChartMap(ctx)
  ]);

  const movements: Movement[] = sums.map((s) => ({
    accountCode: s.accountCode,
    currency: s.currency,
    debitMinor: s.side === "debit" ? Number(s.total) : 0,
    creditMinor: s.side === "credit" ? Number(s.total) : 0
  }));
  const accounts = new Map<string, BudgetAccount>(
    [...chart].map(([code, a]) => [code, { name: a.en, type: a.type, normalSide: a.normalSide }])
  );

  return { periodCode, from, to, rows: compareBudgets(budgets, movements, accounts) };
}

import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import { notFound, tenantChart, type Ctx } from "@lyra/core";
import type { Side } from "./posting.js";

// docs/22 §1.2 — the Money Map. "Sankey of value flow for a period: premium in
// -> insurer remittance -> commission retained -> partner share -> tax -> net.
// Nodes are clickable to filtered journals."
//
// Every figure here is summed from ledger_journal_lines joined to the
// transaction that produced them, so a link is attributable to a transaction
// type rather than inferred from an account moving. That join is the whole
// point: 2200 is credited by output tax on a subscription invoice as readily as
// by tax on drawn commission, and only one of those is a slice of premium. A
// map built from account totals alone would draw the other one too.

/** The filter that reproduces a node's figure in the journals view. */
export interface MoneyMapDrill {
  accountCodes: string[];
  side: Side;
  txnTypes: string[];
}

export interface MoneyMapNode {
  key: string;
  amountMinor: number;
  /** Absent on nodes that are a remainder rather than a query (`still-held`). */
  drill?: MoneyMapDrill;
}

export interface MoneyMapLink {
  from: string;
  to: string;
  amountMinor: number;
}

export interface MoneyMap {
  periodCode: string;
  currency: string;
  asOf: number;
  nodes: MoneyMapNode[];
  links: MoneyMapLink[];
  /**
   * premium in − remitted − drawn as commission. Positive is client money still
   * held at period end; negative means the period paid out premium it collected
   * earlier, which is ordinary and not a breach.
   */
  carriedMinor: number;
}

/**
 * A node whose amount is a query: which accounts, which side, which transaction
 * types. Order matters only in that the drill descriptor is handed to the UI
 * verbatim, so it stays stable and readable.
 *
 * ADR-0083: the "net" node's account list used to be the module-level
 * `INCOME_ACCOUNTS` derived from the static `CHART_OF_ACCOUNTS` import, so an
 * income account a tenant added at runtime never showed up in its own money
 * map. It is now built per call from this tenant's own chart.
 */
function sourcedNodes(incomeAccounts: string[]): { key: string; drill: MoneyMapDrill }[] {
  return [
    {
      key: "premium-in",
      drill: {
        accountCodes: ["1010"],
        side: "debit",
        txnTypes: ["CM-RECEIPT", "PREM-COLLECT", "PREM-INSTALMENT"]
      }
    },
    {
      key: "insurer-remittance",
      drill: { accountCodes: ["2010"], side: "debit", txnTypes: ["PREM-REMIT"] }
    },
    {
      key: "commission-retained",
      drill: { accountCodes: ["2010"], side: "debit", txnTypes: ["CM-TRANSFER"] }
    },
    {
      key: "partner-share",
      drill: { accountCodes: ["2100"], side: "credit", txnTypes: ["CM-TRANSFER"] }
    },
    {
      key: "tax",
      drill: { accountCodes: ["2200"], side: "credit", txnTypes: ["CM-TRANSFER"] }
    },
    {
      key: "net",
      drill: { accountCodes: incomeAccounts, side: "credit", txnTypes: ["CM-TRANSFER"] }
    }
  ];
}

function periodWindow(code: string): { from: number; to: number } {
  const [y, m] = code.split("-").map(Number);
  if (!y || !m) throw notFound(`period ${code}`);
  return { from: Date.UTC(y, m - 1, 1), to: Date.UTC(y, m, 1) - 1 };
}

/**
 * One grouped query, six nodes, six links. The period is required — a value
 * flow with no period is a balance sheet, and that report already exists.
 */
export async function valueFlow(
  ctx: Ctx,
  opts: { periodCode: string; currency?: string }
): Promise<MoneyMap> {
  const window = periodWindow(opts.periodCode);
  const l = schema.ledgerJournalLines;
  const t = schema.ledgerTxns;

  const incomeAccounts = (await tenantChart(ctx)).filter((a) => a.type === "income").map((a) => a.code);
  const SOURCED = sourcedNodes(incomeAccounts);
  const accounts = [...new Set(SOURCED.flatMap((n) => n.drill.accountCodes))];
  const types = [...new Set(SOURCED.flatMap((n) => n.drill.txnTypes))];

  const where = [
    eq(l.tenantId, ctx.tenantId),
    gte(l.postedAt, window.from),
    lte(l.postedAt, window.to),
    inArray(l.accountCode, accounts),
    inArray(t.type, types)
  ];
  if (opts.currency) where.push(eq(l.currency, opts.currency));

  const rows = await ctx.db
    .select({
      type: t.type,
      accountCode: l.accountCode,
      side: l.side,
      total: sql<number>`sum(${l.baseAmountMinor})`
    })
    .from(l)
    .innerJoin(t, and(eq(t.tenantId, l.tenantId), eq(t.id, l.txnId)))
    .where(and(...where))
    .groupBy(t.type, l.accountCode, l.side);

  const totals = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.type}|${r.accountCode}|${r.side}`;
    totals.set(key, (totals.get(key) ?? 0) + Number(r.total));
  }
  const sum = (d: MoneyMapDrill): number =>
    d.txnTypes.reduce(
      (s, type) =>
        s + d.accountCodes.reduce((a, code) => a + (totals.get(`${type}|${code}|${d.side}`) ?? 0), 0),
      0
    );

  const nodes: MoneyMapNode[] = SOURCED.map((n) => ({
    key: n.key,
    amountMinor: sum(n.drill),
    drill: n.drill
  }));
  const amount = (key: string): number => nodes.find((n) => n.key === key)?.amountMinor ?? 0;

  const carriedMinor = amount("premium-in") - amount("insurer-remittance") - amount("commission-retained");
  // A negative remainder is real (premium collected in an earlier period going
  // out in this one) but there is no ribbon to draw for it — the surface states
  // it as a footnote instead. Clamping keeps the diagram's geometry honest.
  const stillHeld = Math.max(carriedMinor, 0);
  nodes.push({ key: "still-held", amountMinor: stillHeld });

  const links: MoneyMapLink[] = [
    { from: "premium-in", to: "insurer-remittance", amountMinor: amount("insurer-remittance") },
    { from: "premium-in", to: "commission-retained", amountMinor: amount("commission-retained") },
    ...(stillHeld > 0 ? [{ from: "premium-in", to: "still-held", amountMinor: stillHeld }] : []),
    { from: "commission-retained", to: "partner-share", amountMinor: amount("partner-share") },
    { from: "commission-retained", to: "tax", amountMinor: amount("tax") },
    { from: "commission-retained", to: "net", amountMinor: amount("net") }
  ];

  return {
    periodCode: opts.periodCode,
    currency: opts.currency ?? ctx.policy.currency,
    asOf: window.to,
    nodes,
    links,
    carriedMinor
  };
}

export interface MoneyMapLine {
  txnId: string;
  /** Line number within the transaction — with txnId, the line's identity. */
  seq: number;
  txnType: string;
  accountCode: string;
  side: string;
  amountMinor: number;
  baseAmountMinor: number;
  currency: string;
  memo: string | null;
  postedAt: number;
}

/**
 * The lines behind one node — what "clickable to filtered journals" (docs/22
 * §1.2) opens. It runs the node's own drill descriptor, so the sum of what a
 * controller reads back is the figure they clicked. The generic journal-lines
 * list cannot do this: it filters by column, and "which transaction type
 * produced this line" is not a column on the line.
 */
export async function valueFlowLines(
  ctx: Ctx,
  opts: { periodCode: string; node: string; currency?: string; limit?: number }
): Promise<{
  node: string;
  periodCode: string;
  currency: string;
  totalMinor: number;
  lines: MoneyMapLine[];
}> {
  const incomeAccounts = (await tenantChart(ctx)).filter((a) => a.type === "income").map((a) => a.code);
  const sourced = sourcedNodes(incomeAccounts).find((n) => n.key === opts.node);
  // `still-held` is a remainder of three other nodes, so it has no lines of its
  // own; asking for them is a 404 rather than an empty list, which would read as
  // "nothing was held".
  if (!sourced) throw notFound(`money map node ${opts.node}`);
  const window = periodWindow(opts.periodCode);
  const l = schema.ledgerJournalLines;
  const t = schema.ledgerTxns;

  const where = [
    eq(l.tenantId, ctx.tenantId),
    gte(l.postedAt, window.from),
    lte(l.postedAt, window.to),
    inArray(l.accountCode, sourced.drill.accountCodes),
    eq(l.side, sourced.drill.side),
    inArray(t.type, sourced.drill.txnTypes)
  ];
  if (opts.currency) where.push(eq(l.currency, opts.currency));

  const rows = await ctx.db
    .select({
      txnId: l.txnId,
      seq: l.seq,
      txnType: t.type,
      accountCode: l.accountCode,
      side: l.side,
      amountMinor: l.amountMinor,
      baseAmountMinor: l.baseAmountMinor,
      currency: l.currency,
      memo: l.memo,
      postedAt: l.postedAt
    })
    .from(l)
    .innerJoin(t, and(eq(t.tenantId, l.tenantId), eq(t.id, l.txnId)))
    .where(and(...where))
    .orderBy(asc(l.postedAt), asc(l.seq))
    .limit(opts.limit ?? 500);

  return {
    node: opts.node,
    periodCode: opts.periodCode,
    currency: opts.currency ?? ctx.policy.currency,
    totalMinor: rows.reduce((s, r) => s + r.baseAmountMinor, 0),
    lines: rows
  };
}

import { eq } from "drizzle-orm";
import { schema, type AccountDef, type AccountType, type CashFlowClass } from "@lyra/db";
import { scoped, type Ctx } from "./context.js";
import { badRequest } from "./errors.js";

// ADR-0083. `CHART_OF_ACCOUNTS` (@lyra/db) is the default chart every tenant
// is seeded with; this file is the one seam every *runtime* reader of a
// tenant's chart routes through afterwards, the same relationship tax.ts has
// to the tax rulepack (docs/27 F17). A tenant may add an account at any time
// (`ledger_accounts` accepts an insert today, ADR-0083 §2) and this is what
// makes that account visible everywhere a seeded one already is.
//
// `packages/ledger/src/recipes.ts` is the one caller that does NOT route
// through here — its pure posting-shape builders validate against the fixed
// default chart on purpose (see the ADR).

/** A tenant's own row: everything `AccountDef` carried, plus what only exists once seeded. */
export interface TenantAccount extends AccountDef {
  id: string;
  status: string;
}

function fromRow(row: typeof schema.ledgerAccounts.$inferSelect): TenantAccount {
  const name = JSON.parse(row.nameJson) as { en: string; ar: string };
  return {
    id: row.id,
    code: row.code,
    en: name.en,
    ar: name.ar,
    type: row.type as AccountType,
    normalSide: row.normalSide as "debit" | "credit",
    ...(row.clientMoney ? { clientMoney: true as const } : {}),
    ...(row.clientMoneyPair ? { clientMoneyPair: row.clientMoneyPair } : {}),
    ...(row.suspense ? { suspense: true as const } : {}),
    ...(row.cashFlow ? { cashFlow: row.cashFlow as CashFlowClass } : {}),
    ...(row.currency ? { currency: row.currency } : {}),
    status: row.status
  };
}

/** Every account this tenant has, seeded or added. */
export async function tenantChart(ctx: Ctx): Promise<TenantAccount[]> {
  const rows = await ctx.db.select().from(schema.ledgerAccounts).where(scoped(ctx, schema.ledgerAccounts));
  return rows.map(fromRow);
}

/** One account by code, or undefined when this tenant has no such account. */
export async function tenantAccount(ctx: Ctx, code: string): Promise<TenantAccount | undefined> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerAccounts)
    .where(scoped(ctx, schema.ledgerAccounts, eq(schema.ledgerAccounts.code, code)))
    .limit(1);
  return rows[0] ? fromRow(rows[0]) : undefined;
}

/** `tenantChart` as a `code -> account` map, for callers that look up several codes. */
export async function tenantChartMap(ctx: Ctx): Promise<Map<string, TenantAccount>> {
  return new Map((await tenantChart(ctx)).map((a) => [a.code, a]));
}

/** Accounts flagged `suspense: true` in this tenant's chart (ADR-0083 §3). */
export async function suspenseAccounts(ctx: Ctx): Promise<TenantAccount[]> {
  return (await tenantChart(ctx)).filter((a) => a.suspense);
}

/**
 * One client-money pair: the asset a market's clients' money is held in, and
 * the liability that is what the broker owes those same clients.
 */
export interface ClientMoneyPair {
  assetCode: string;
  liabilityCode: string;
}

/**
 * ADR-0126. The register every client-money control reads. A broker is licensed
 * per market, so "is client money whole" is a question about each segregated
 * account and its own liability — never about the tenant's total, which is what
 * the fixed `1010`/`2010` pair made it mean. A shortfall in one market must not
 * be answered by a surplus in another.
 *
 * The chart is the source: `client_money_pair` is written on both sides by
 * `syncChartOfAccounts` and by the 0058 migration, so this derives the pairs
 * rather than listing them. A half-written pair — an asset with no liability, a
 * liability that does not name the asset back, or an asset paired with itself —
 * is a control that cannot work, so it is refused: naming the account is what
 * lets an operator fix the chart instead of guessing which one is broken.
 */
export async function clientMoneyPairs(ctx: Ctx): Promise<ClientMoneyPair[]> {
  const chart = await tenantChart(ctx);
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const pairs: ClientMoneyPair[] = [];
  for (const asset of chart.filter((a) => a.clientMoney && a.type === "asset")) {
    const liabilityCode = asset.clientMoneyPair;
    if (!liabilityCode || liabilityCode === asset.code) {
      throw badRequest(
        `client-money account ${asset.code} names no client-money liability; set client_money_pair before money can move through it`
      );
    }
    const liability = byCode.get(liabilityCode);
    if (!liability) {
      throw badRequest(`client-money account ${asset.code} names ${liabilityCode}, which is not an account in this chart`);
    }
    if (liability.type !== "liability" || !liability.clientMoney) {
      throw badRequest(`client-money account ${asset.code} names ${liabilityCode}, which is not a client-money liability`);
    }
    if (liability.clientMoneyPair !== asset.code) {
      throw badRequest(
        `client-money account ${asset.code} names ${liabilityCode}, which names ${liability.clientMoneyPair ?? "nothing"} back instead`
      );
    }
    pairs.push({ assetCode: asset.code, liabilityCode: liability.code });
  }
  return pairs;
}

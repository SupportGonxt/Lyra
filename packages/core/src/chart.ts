import { eq } from "drizzle-orm";
import { schema, type AccountDef, type AccountType } from "@lyra/db";
import { scoped, type Ctx } from "./context.js";

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
    ...(row.suspense ? { suspense: true as const } : {}),
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

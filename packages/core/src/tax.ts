import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest } from "./errors.js";
import type { Ctx } from "./context.js";

// docs/19 §5.3: "Tax treatment per market rulepack: rate, place of supply,
// reverse charge, exemption flags. Tax is never inferred in code." docs/27 F17:
// until this file existed, `ledger_tax_rules` had no reader anywhere in the
// product and `taxPpm` was an optional caller-supplied number that defaulted to
// zero — so "never inferred" was implemented as "always inferred as nothing".
//
// The contract here is deliberately unforgiving in one direction: a caller may
// *state* a rate (an insurer statement carries its own, a migration restates
// history), but it may never *omit* one. A tenant with no rulepack on file is a
// 400 naming the configuration it is missing, not a silent zero.

/** Brokerage/agency income — what a commission accrual is taxed under. */
export const DEFAULT_TAX_CODE = "commission";

/** The market a tenant's supplies are made in, until its policy says otherwise. */
export const DEFAULT_TAX_MARKET = "AE";

export interface TaxTreatment {
  ruleId: string;
  market: string;
  code: string;
  /** The statutory rate, parts per million, as written in the rulepack. */
  ratePpm: number;
  placeOfSupply: string | null;
  reverseCharge: boolean;
  exempt: boolean;
}

export interface TaxQuery {
  /** Defaults to the tenant's policy market. */
  market?: string | undefined;
  /** Defaults to `commission`. */
  code?: string | undefined;
  /** Supply date — a settlement re-derives the rate that applied then, not today's. */
  at?: number | undefined;
}

/**
 * The market whose rulepack governs this tenant's supplies. `policy.taxMarket`
 * is the tenant's own statement of where it is established; docs/29 named the
 * missing dimension and ADR-0075 adds it.
 */
export function taxMarketOf(ctx: Ctx): string {
  const stated = (ctx.policy as { taxMarket?: unknown }).taxMarket;
  return typeof stated === "string" && stated ? stated : DEFAULT_TAX_MARKET;
}

function treatment(r: typeof schema.ledgerTaxRules.$inferSelect): TaxTreatment {
  return {
    ruleId: r.id,
    market: r.market,
    code: r.code,
    ratePpm: r.ratePpm,
    placeOfSupply: r.placeOfSupply,
    reverseCharge: r.reverseCharge,
    exempt: r.exempt
  };
}

/**
 * The rule in force for a supply, or null when the tenant has none on file.
 * Same shape as `resolveRate` next door: the latest row whose window contains
 * the supply date wins, so a rate change is a new row and history stays
 * reproducible.
 */
export async function resolveTaxRule(ctx: Ctx, q: TaxQuery = {}): Promise<TaxTreatment | null> {
  const at = q.at ?? ctx.now;
  const t = schema.ledgerTaxRules;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.tenantId, ctx.tenantId),
        eq(t.market, q.market ?? taxMarketOf(ctx)),
        eq(t.code, q.code ?? DEFAULT_TAX_CODE),
        lte(t.effectiveFrom, at),
        or(isNull(t.effectiveTo), gt(t.effectiveTo, at))
      )
    )
    .orderBy(desc(t.effectiveFrom))
    .limit(1);
  return rows[0] ? treatment(rows[0]) : null;
}

/**
 * The rule in force, or a refusal. This is the function the money path calls:
 * there is no third outcome where the caller gets a zero it did not ask for.
 */
export async function taxTreatment(ctx: Ctx, q: TaxQuery = {}): Promise<TaxTreatment> {
  const found = await resolveTaxRule(ctx, q);
  if (found) return found;
  const market = q.market ?? taxMarketOf(ctx);
  const code = q.code ?? DEFAULT_TAX_CODE;
  throw badRequest(
    `tax is never inferred (docs/19 §5.3): this tenant has no "${code}" rule on file for market ${market}. Install the market rulepack or state taxPpm explicitly.`
  );
}

/**
 * The rate to actually apply. Exempt and reverse-charge supplies are taxed at
 * zero — but a *stated* zero, carrying the rule id that says why, which is the
 * whole difference between this and the old default.
 */
export function taxPpmOf(t: TaxTreatment): number {
  return t.exempt || t.reverseCharge ? 0 : t.ratePpm;
}

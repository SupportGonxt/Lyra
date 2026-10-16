import { and, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { schema, TAX_KINDS, type TaxKind } from "@lyra/db";
import { badRequest } from "./errors.js";
import type { Ctx } from "./context.js";
import type { TaxProvider } from "./seams.js";

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

/**
 * Which tax a rule levies, as distinct from how much (ADR-0121, docs/29 G1).
 *
 * A rate alone is not enough to post money: an insurance premium tax is not
 * recoverable VAT, and Egypt levies a table tax on a premium *beside* the VAT on
 * it — two returns, two liabilities. Until this existed every tax landed in
 * `2200 Tax Payable`, which is right for exactly one of these.
 */
export { TAX_KINDS };
export type { TaxKind };

/**
 * The liability account a tax of this kind posts to. `stamp_duty` and any kind a
 * tenant registers itself share the generic `2200 Tax Payable`: the default
 * chart carries a dedicated account only where a market the product ships for
 * needs one, and a tenant whose return splits it further adds an account
 * (ADR-0083 lets a tenant add accounts, never remove or renumber ours).
 */
export function taxAccountOf(kind: string): string {
  switch (kind) {
    case "premium_tax":
      return "2210";
    case "table_tax":
      return "2220";
    default:
      return "2200";
  }
}

/** A stored kind we do not recognise reads as `vat` — the pre-0121 behaviour,
 *  and the safe reading for a row written before the column existed. */
export function taxKindOf(raw: string | null | undefined): TaxKind {
  return (TAX_KINDS as readonly string[]).includes(raw ?? "") ? (raw as TaxKind) : "vat";
}

export interface TaxTreatment {
  /** The rulepack row behind this, or null when a provider computed it. */
  ruleId: string | null;
  market: string;
  code: string;
  /** Which tax this is — decides the liability account it posts to. */
  kind: TaxKind;
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
  return taxMarketOf2(ctx).market;
}

/**
 * The market **and whether the tenant stated it.**
 *
 * `taxMarketOf` alone cannot answer a question a nine-country broker has to ask:
 * *which supplies were taxed under a market nobody chose?* A tenant that has not
 * set `policy.taxMarket` is treated as established in `DEFAULT_TAX_MARKET`, which
 * is right for the launch market (ADR-0121) and **silent** for every other one —
 * and this file's own doctrine is the opposite: *"a tenant that installed a US
 * provider and then lost it must not quietly start taxing Illinois at the UAE's
 * 5%."* It refuses to infer a **rate**; it would infer a **market**.
 *
 * So the inference is made readable rather than removed. Everything that consumes
 * a market can now say whether it was stated or assumed, and a caller that cares —
 * an accrual, a report, an auditor — can find every supply that rests on the
 * default. Making it loud is what turns "we think this is a UAE supply" into a
 * question somebody can answer.
 */
export function taxMarketOf2(ctx: Ctx): { market: string; source: "stated" | "default" } {
  const stated = (ctx.policy as { taxMarket?: unknown }).taxMarket;
  return typeof stated === "string" && stated
    ? { market: stated, source: "stated" }
    : { market: DEFAULT_TAX_MARKET, source: "default" };
}

/**
 * The rulepack table as a provider (ADR-0121, docs/29 G2). It answers wherever a
 * rule is on file, which is why it can be the default without anyone configuring
 * anything — and why the seam costs a tenant nothing until its market needs a
 * provider the table cannot be.
 */
function tableTaxProvider(ctx: Ctx): TaxProvider {
  return {
    key: "table",
    resolve: async (q) => {
      const t = schema.ledgerTaxRules;
      const rows = await ctx.db
        .select()
        .from(t)
        .where(
          and(
            eq(t.tenantId, ctx.tenantId),
            eq(t.market, q.market),
            eq(t.code, q.code),
            lte(t.effectiveFrom, q.at),
            or(isNull(t.effectiveTo), gt(t.effectiveTo, q.at))
          )
        )
        .orderBy(desc(t.effectiveFrom))
        .limit(1);
      const r = rows[0];
      if (!r) return null;
      return {
        ratePpm: r.ratePpm,
        kind: taxKindOf(r.kind),
        placeOfSupply: r.placeOfSupply,
        reverseCharge: r.reverseCharge,
        exempt: r.exempt,
        ruleId: r.id
      };
    }
  };
}

/** Installed tax providers, by the key tenant policy names. */
export const TAX_PROVIDERS: Readonly<Record<string, (ctx: Ctx) => TaxProvider>> = { table: tableTaxProvider };

/**
 * Which provider answers this tenant's supplies. Policy names it and the table
 * is the default, so nothing has to be configured for the markets this product
 * ships for. An unknown name is a refusal rather than a silent fall back to the
 * table: a tenant that installed a US provider and then lost it must not quietly
 * start taxing Illinois at the UAE's 5%.
 */
export function taxProviderFor(ctx: Ctx): TaxProvider {
  const named = (ctx.policy as { taxProvider?: unknown }).taxProvider;
  const key = typeof named === "string" && named ? named : "table";
  const factory = TAX_PROVIDERS[key];
  if (!factory) {
    throw badRequest(
      `policy names tax provider "${key}", which is not installed (installed: ${Object.keys(TAX_PROVIDERS).join(", ")})`
    );
  }
  return factory(ctx);
}

/**
 * The rule in force for a supply, or null when no provider has one. Same shape
 * as `resolveRate` next door: the latest row whose window contains the supply
 * date wins, so a rate change is a new row and history stays reproducible.
 */
export async function resolveTaxRule(ctx: Ctx, q: TaxQuery = {}): Promise<TaxTreatment | null> {
  const market = q.market ?? taxMarketOf(ctx);
  const code = q.code ?? DEFAULT_TAX_CODE;
  const answer = await taxProviderFor(ctx).resolve({ market, code, at: q.at ?? ctx.now });
  // A provider is a boundary: an external engine answers with a string, and
  // an unrecognised kind must read as the pre-0121 default rather than flow
  // into a union that decides which liability account money lands on.
  return answer ? { ...answer, kind: taxKindOf(answer.kind), market, code } : null;
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

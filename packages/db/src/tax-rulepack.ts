// docs/19 §5.3 + docs/16 H12 — the market tax rulepack. "Tax treatment per market
// rulepack: rate, place of supply, reverse charge, exemption flags. Tax is never
// inferred in code."
//
// This is the compiled default a tenant is provisioned with, exactly as
// CHART_OF_ACCOUNTS is: rows land in `ledger_tax_rules` at seed time and the
// tenant owns them afterwards. It lives in @lyra/db so seed, the reconciler and
// the resolver in @lyra/core all read one table (docs/27 F17).
//
// Sighting 9's lesson applies: a compiled table read only at provisioning time
// has exactly one delivery, so `syncTaxRules` in @lyra/core backfills a tenant
// seeded before a code was added here.

export interface TaxRuleDef {
  /** ISO-3166 alpha-2, or a supranational code a tenant's policy names. */
  market: string;
  /** What is being taxed. `commission` is brokerage/agency income. */
  code: string;
  /** Parts per million. 5% = 50_000. */
  ratePpm: number;
  placeOfSupply?: string;
  /** The customer accounts for the tax, so we charge none. */
  reverseCharge?: boolean;
  /** Out of scope or zero-rated by statute — still a stated treatment. */
  exempt?: boolean;
}

/**
 * Deliberately short. Every row here is a statutory rate somebody has to be able
 * to cite, so this grows by ADR and market research, never by guess — an absent
 * market is a refusal (`taxTreatment` throws), which is the whole point of F17.
 */
export const TAX_RULEPACK: readonly TaxRuleDef[] = [
  // UAE: 5% VAT on brokerage/agency services supplied in the UAE.
  { market: "AE", code: "commission", ratePpm: 50_000, placeOfSupply: "AE" },
  { market: "AE", code: "service_fee", ratePpm: 50_000, placeOfSupply: "AE" },
  { market: "AE", code: "subscription", ratePpm: 50_000, placeOfSupply: "AE" },
  // Insurance premium itself is exempt from UAE VAT for life products and
  // standard-rated for general — the premium leg is stated by the product, not
  // by this default, so it is carried as an explicit exemption rather than as
  // an absent row a caller could read as "no tax".
  { market: "AE", code: "premium_life", ratePpm: 0, placeOfSupply: "AE", exempt: true },
  // KSA: 15% VAT.
  { market: "SA", code: "commission", ratePpm: 150_000, placeOfSupply: "SA" },
  { market: "SA", code: "service_fee", ratePpm: 150_000, placeOfSupply: "SA" },
  { market: "SA", code: "subscription", ratePpm: 150_000, placeOfSupply: "SA" }
];

export const TAX_MARKETS: readonly string[] = [...new Set(TAX_RULEPACK.map((r) => r.market))];

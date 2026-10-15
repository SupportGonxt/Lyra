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
  /**
   * Which tax this is, not how much (ADR-0121, docs/29 G1). Defaults to `vat`,
   * which is what every row here was before the column existed. It matters
   * because a rate cannot say which return the money belongs on: Egypt levies
   * VAT on general insurance *and* a table levy on the same premium, and the two
   * are reported separately.
   */
  kind?: TaxKind;
}

/**
 * The tax vocabulary the rulepack, the resolver and the ledger share. One home,
 * so a kind the resolver accepts can never be one the rulepack cannot express.
 */
export const TAX_KINDS = ["vat", "premium_tax", "table_tax", "stamp_duty", "none"] as const;
export type TaxKind = (typeof TAX_KINDS)[number];

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
  { market: "SA", code: "subscription", ratePpm: 150_000, placeOfSupply: "SA" },
  // Egypt, the market after the UAE: 14% VAT, life cover outside the charge,
  // and the table levy that sits on the same general-insurance premium as the
  // VAT — the row that makes `kind` more than a spare column.
  //
  // The table levy's RATE is the tenant's to confirm with its own adviser before
  // the first Egyptian invoice; it is compiled here so the shape is exercised,
  // not as a statement of law, and editing it is a rulepack change.
  { market: "EG", code: "commission", ratePpm: 140_000, placeOfSupply: "EG" },
  { market: "EG", code: "service_fee", ratePpm: 140_000, placeOfSupply: "EG" },
  { market: "EG", code: "subscription", ratePpm: 140_000, placeOfSupply: "EG" },
  { market: "EG", code: "premium_life", ratePpm: 0, placeOfSupply: "EG", exempt: true },
  { market: "EG", code: "premium_general_table", ratePpm: 1_250, placeOfSupply: "EG", kind: "table_tax" }
];

export const TAX_MARKETS: readonly string[] = [...new Set(TAX_RULEPACK.map((r) => r.market))];

/* ---------------------------------------------------------------- drafts */

/**
 * **Proposed** rates for markets the platform does not yet govern, and the
 * citation each one needs before it can.
 *
 * These rows are **not applied and must never be**. They do not enter
 * `ledger_tax_rules`, `TAX_RULEPACK` does not read them, and a tenant in one of
 * these markets therefore still hits the refusal above — *"a tenant with no
 * rulepack on file is a 400 naming the configuration it is missing, not a silent
 * zero"* — which is the correct behaviour and stays correct.
 *
 * They exist for one reason: **someone has to confirm each one, and a blank page
 * is a worse starting point than a number with its citation missing.** The
 * `ratePpm` values below are my own reading of published headline rates at the
 * time of writing, held at a distance from production on purpose. Two rules make
 * them safe rather than merely labelled:
 *
 *   1. **Nothing computes from a draft.** A test asserts the applied rulepack and
 *      this list share no market, so a draft cannot become law by being copied.
 *   2. **`citation` is what verification means.** A human promoting a market
 *      supplies the statute or the authority's page; a rate confirmed without one
 *      is a rate confirmed by memory, and this register has spent a whole build
 *      learning what memory costs.
 *
 * Rates also move — KSA raised VAT from 5% to 15% within a year — so the value
 * here is a hypothesis with a shelf life, never a fact.
 */
export interface TaxRuleDraft {
  market: string;
  /** The market's name, for a screen that lists what is waiting on a human. */
  marketName: string;
  currency: string;
  code: string;
  /** My own reading, to be replaced by a cited figure. */
  ratePpm: number;
  /**
   * What the confirmer must establish. Not boilerplate: it names the specific
   * question that decides whether this number is right.
   */
  mustConfirm: string;
}

export const TAX_RULEPACK_DRAFTS: readonly TaxRuleDraft[] = [
  {
    market: "QA",
    marketName: "Qatar",
    currency: "QAR",
    code: "commission",
    ratePpm: 0,
    mustConfirm:
      "Whether Qatar has introduced VAT at all. A draft of 0 is not 'no tax' — it is 'no rate known', and the two must not be confused when this is promoted."
  },
  {
    market: "KW",
    marketName: "Kuwait",
    currency: "KWD",
    code: "commission",
    ratePpm: 0,
    mustConfirm: "Whether Kuwait has introduced VAT; as with Qatar, 0 means unknown rather than zero-rated."
  },
  {
    market: "BH",
    marketName: "Bahrain",
    currency: "BHD",
    code: "commission",
    ratePpm: 100_000,
    mustConfirm: "The standard VAT rate in force, and whether brokerage commission is standard-rated."
  },
  {
    market: "OM",
    marketName: "Oman",
    currency: "OMR",
    code: "commission",
    ratePpm: 50_000,
    mustConfirm: "The standard VAT rate in force, and whether insurance brokerage carries any exemption."
  },
  {
    market: "JO",
    marketName: "Jordan",
    currency: "JOD",
    code: "commission",
    ratePpm: 160_000,
    mustConfirm:
      "Whether the general sales tax rate applies to brokerage services, and whether insurance is specially rated."
  },
  {
    market: "LB",
    marketName: "Lebanon",
    currency: "LBP",
    code: "commission",
    ratePpm: 110_000,
    mustConfirm: "The VAT rate in force, and whether insurance brokerage is within scope."
  }
];

/** The drafts for one market, or none. Read by a screen, never by the resolver. */
/**
 * The proposed rulepack for one market, or `[]` where the market is already governed
 * or has no proposal on file.
 *
 * **Test-only on purpose, and that is a decision rather than an omission.** Every
 * other accessor in this file reaches a screen; this one should not, because
 * `TAX_RULEPACK_DRAFTS` is a **code constant** — promoting a draft means editing this
 * file and deploying, not pressing a button. A rate with no citation rendered on a
 * settings screen is exactly the thing that must not exist, and a *proposed* rate
 * shown beside a *confirmed* one is the same error with a label.
 *
 * Its reader is `tax-rulepack.test.ts`, which asserts the applied rulepack and the
 * drafts share **no market** — so a draft cannot become law by being copied. That is
 * the check that gives the drafts their meaning, and it is the reason this accessor
 * exists rather than callers reaching into the constant.
 */
export const taxDraftsFor = (market: string): readonly TaxRuleDraft[] =>
  TAX_RULEPACK_DRAFTS.filter((draft) => draft.market === market.toUpperCase());

/**
 * The markets waiting on a human, which is the countable answer to "how much
 * expansion work is left" — the question `TAX_MARKETS` alone cannot answer.
 */
export const marketsAwaitingRulepack = (): readonly string[] => [
  ...new Set(TAX_RULEPACK_DRAFTS.map((draft) => draft.market))
].sort();

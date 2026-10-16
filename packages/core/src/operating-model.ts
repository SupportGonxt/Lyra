// What business are we operating, **where**, under **whose licence**, through
// **what process**?
//
// Four gaps, one question, and they were found by reading the client's own site
// (YALLACOMPARE-COMPARISON.md) rather than by guessing at requirements:
//
//   1. **Markets.** NXT governs three (AE, SA, EG); the client operates in nine.
//   2. **Regulators.** They answer to two in one country — the UAE Central Bank
//      *and* the DHA — and NXT modelled a tax market, not a regulator.
//   3. **Verticals.** Four of their eleven product lines are banking, and NXT was
//      insurance-shaped end to end: `axis_policies`, premiums, binds.
//   4. **Process.** A credit card has no policy document, and its lifecycle is
//      application → decision → disbursement → repayment, not quote → bind.
//
// What is here is deliberately **only what can be stated from source**. A licence
// number nobody gave me is `null` with a status, never a plausible-looking string:
// CLAUDE.md forbids inventing regulatory claims, and a made-up broker number is
// the worst possible thing to put in a compliance register.

/* ------------------------------------------------------------------ markets */

/** Where a market stands, in the only three states that are honest. */
export type MarketStatus =
  /** We hold a licence and can trade. */
  | "licensed"
  /** We operate here; the tax rulepack and/or licence are not on file yet. */
  | "ungoverned"
  /** Declared by a tenant, unknown to the platform — refused, never assumed. */
  | "unknown";

export interface MarketDef {
  /** ISO 3166-1 alpha-2. */
  code: string;
  name: { en: string; ar: string };
  currency: string;
  status: MarketStatus;
  /** Regulator keys from `REGULATORS` that license this market. */
  regulators: readonly string[];
}

/**
 * The markets the platform knows about.
 *
 * `AE` is the launch market and the only one **fully** stated, because it is the
 * only one whose regulators the client themselves publish. `SA` and `EG` are the
 * two named by ADR-0121's expansion order and both carry tax rulepacks, so they
 * are real even though no licence number is recorded here — the field is `null`
 * rather than invented.
 */
export const MARKETS: readonly MarketDef[] = [
  {
    code: "AE",
    name: { en: "United Arab Emirates", ar: "الإمارات العربية المتحدة" },
    currency: "AED",
    status: "licensed",
    regulators: ["ae_central_bank", "dha"]
  },
  { code: "SA", name: { en: "Saudi Arabia", ar: "المملكة العربية السعودية" }, currency: "SAR", status: "ungoverned", regulators: [] },
  { code: "EG", name: { en: "Egypt", ar: "مصر" }, currency: "EGP", status: "ungoverned", regulators: [] },
  // The rest of the client's nine. **These were missing, and their absence was a
  // contradiction rather than a gap:** `ungovernedMarkets()`'s own docstring says
  // *"a list of six typed by hand"* and it returned **two**, while
  // `packages/db/src/tax-rulepack.ts` already knew all six and drafted a rulepack for
  // each. So the platform had **two footprints** — three markets here, nine there — and
  // a broker in Qatar could be named in a tax draft while `marketFor("QA")` answered
  // `status: "unknown"` and no authorisation could ever cover it.
  //
  // `regulators: []` and `status: "ungoverned"` are the honest values: the client
  // operates in these countries and the platform has **no licence number, scope or
  // rate for any of them**. A market entry is a country and a currency — both facts —
  // and nothing here asserts a regulatory position. The currencies are the ones
  // `TAX_RULEPACK_DRAFTS` already states, and a test cross-checks the two lists so they
  // cannot drift apart again.
  { code: "QA", name: { en: "Qatar", ar: "قطر" }, currency: "QAR", status: "ungoverned", regulators: [] },
  { code: "KW", name: { en: "Kuwait", ar: "الكويت" }, currency: "KWD", status: "ungoverned", regulators: [] },
  { code: "BH", name: { en: "Bahrain", ar: "البحرين" }, currency: "BHD", status: "ungoverned", regulators: [] },
  { code: "OM", name: { en: "Oman", ar: "عُمان" }, currency: "OMR", status: "ungoverned", regulators: [] },
  { code: "JO", name: { en: "Jordan", ar: "الأردن" }, currency: "JOD", status: "ungoverned", regulators: [] },
  { code: "LB", name: { en: "Lebanon", ar: "لبنان" }, currency: "LBP", status: "ungoverned", regulators: [] }
];

/**
 * A market nobody declared is **refused, not defaulted.**
 *
 * This is the shape of the defect this module was written to close: `taxMarketOf`
 * answered `AE` for a tenant that had stated nothing, so a broker in six other
 * countries would have had UAE treatment applied silently — the same failure the
 * tax file's own comment forbids one level down (*"must not quietly start taxing
 * Illinois at the UAE's 5%"*).
 */
export function marketFor(code: string): MarketDef {
  const found = MARKETS.find((market) => market.code === code.toUpperCase());
  return (
    found ?? {
      code: code.toUpperCase(),
      name: { en: code.toUpperCase(), ar: code.toUpperCase() },
      currency: "",
      status: "unknown",
      regulators: []
    }
  );
}

/**
 * Every market the platform **knows** but does not govern — no licence on file.
 *
 * **Derived, not hand-listed**, and this docstring used to say *"the markets still to be
 * brought in… a list of six typed by hand"*, which conflated two different questions and
 * was wrong on its own numbers:
 *
 * - **no licence** is what this returns — `AE` is the only `licensed` market, so this is
 *   the other **eight**: the three tax-governed markets (SA, EG) plus the six the client
 *   operates in and the platform has nothing for (QA, KW, BH, OM, JO, LB);
 * - **no tax rulepack** is a different question, answered in `packages/db/src/tax-rulepack.ts`
 *   (`marketsAwaitingRulepack()`), and it is those **six**. `@lyra/core` cannot import
 *   `@lyra/db`, so the two lists are cross-checked in `operating-model.test.ts` rather
 *   than derived one from the other — *and that test is where the difference stays
 *   visible instead of drifting.*
 *
 * The distinction is the point: a market whose **tax** the platform cannot compute is
 * refused at the till, while a market with no **licence** is refused at the bind. Both
 * are "ungoverned" in English and neither is the other.
 */
export const ungovernedMarkets = (): readonly MarketDef[] => MARKETS.filter((m) => m.status !== "licensed");

/* --------------------------------------------------------------- regulators */

/**
 * What a licence is for. The **runtime** list is the source of truth and the
 * type is derived from it, because a union alone cannot be validated at a write
 * door: a tenant registering a licence needs the four values as data, and a
 * hand-typed second list in the API would go stale the first time one is added.
 */
export const REGULATOR_SCOPES = ["insurance_broking", "health_intermediary", "banking", "securities"] as const;

export type RegulatorScope = (typeof REGULATOR_SCOPES)[number];

export interface RegulatorDef {
  key: string;
  name: { en: string; ar: string };
  /** What the licence is for, which decides which product lines it covers. */
  scope: RegulatorScope;
  /** The registration the regulator issued, or null when it is not on file. */
  licenceNumber: string | null;
  /** Obligations this licence carries. Descriptive, never an invented rule. */
  obligations: readonly string[];
}

/**
 * The regulators the client is licensed by, **taken from their own site**. Two
 * entries, and both licence numbers are quoted rather than paraphrased.
 *
 * The `AR` names are the regulators' own transliterations in common use; the
 * scope values decide which product lines each licence can carry, which is why
 * the field exists rather than a free-text note.
 */
export const REGULATORS: readonly RegulatorDef[] = [
  {
    key: "ae_central_bank",
    name: { en: "Central Bank of the UAE", ar: "مصرف الإمارات العربية المتحدة المركزي" },
    scope: "insurance_broking",
    // Quoted from the client's own About page.
    licenceNumber: "20",
    obligations: ["commission disclosure", "client money handling", "complaints reporting"]
  },
  {
    key: "dha",
    name: { en: "Dubai Health Authority", ar: "هيئة الصحة بدبي" },
    scope: "health_intermediary",
    licenceNumber: "BRK-00045",
    obligations: ["intermediary registration", "health service provider feedback"]
  }
];

export const regulatorFor = (key: string): RegulatorDef | null => REGULATORS.find((r) => r.key === key) ?? null;

/**
 * Which licence a product line needs — the join that makes "regulated in nine
 * countries" answerable rather than a footnote. Health needs the DHA; everything
 * insurance-shaped needs the broking licence.
 */
export function regulatorsForProductLine(line: ProductLineKey): readonly RegulatorDef[] {
  const scope = PRODUCT_LINES[line].requiresRegulatorScope;
  return scope ? REGULATORS.filter((r) => r.scope === scope) : [];
}

/* ------------------------------------------- product lines and their process */

/**
 * A product line's **process**, which is the thing NXT was missing.
 *
 * The domain-pack seam (docs/21, CLAUDE.md §14) swaps vocabulary. It does not
 * change a lifecycle, and the five banking lines the client sells first have a
 * different one: an application is decided and disbursed, not bound.
 */
export type LifecycleKey = "insurance_policy" | "lending_application";

export interface LifecycleDef {
  key: LifecycleKey;
  /** The stages a case moves through, in order. Vocabulary, not a state machine. */
  stages: readonly string[];
  /** What the artefact produced at the end is called — a policy is not a loan. */
  artefact: string;
  /** Whether a third party's risk is being placed (insurance) or money lent. */
  placesRisk: boolean;
}

export const LIFECYCLES: Record<LifecycleKey, LifecycleDef> = {
  insurance_policy: {
    key: "insurance_policy",
    stages: ["quote", "bind", "policy", "renew"],
    artefact: "policy",
    placesRisk: true
  },
  lending_application: {
    key: "lending_application",
    // The client sells credit cards and four kinds of loan; none of them is
    // bound, and all of them are decided and then disbursed.
    stages: ["application", "decision", "disbursement", "repayment"],
    artefact: "facility",
    placesRisk: false
  }
};

/**
 * The client's **eleven** lines, keyed. Seven insurance, **four** banking — the
 * split is theirs, counted from their own navigation, and it is what makes "seven
 * of eleven usable today" a countable statement rather than an impression.
 *
 * (This list first said twelve and five. The test caught it: their finance nav
 * lists four products, and the figure had been written into two documents without
 * anyone counting.)
 */
export const PRODUCT_LINES = {
  car_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "insurance_broking" },
  health_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "health_intermediary" },
  group_health_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "health_intermediary" },
  life_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "insurance_broking" },
  home_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "insurance_broking" },
  travel_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "insurance_broking" },
  pet_insurance: { lifecycle: "insurance_policy", requiresRegulatorScope: "insurance_broking" },
  personal_loans: { lifecycle: "lending_application", requiresRegulatorScope: "banking" },
  credit_cards: { lifecycle: "lending_application", requiresRegulatorScope: "banking" },
  home_loans: { lifecycle: "lending_application", requiresRegulatorScope: "banking" },
  car_loans: { lifecycle: "lending_application", requiresRegulatorScope: "banking" }
} as const satisfies Record<string, { lifecycle: LifecycleKey; requiresRegulatorScope: RegulatorDef["scope"] | null }>;

export type ProductLineKey = keyof typeof PRODUCT_LINES;

export const lifecycleFor = (line: ProductLineKey): LifecycleDef => LIFECYCLES[PRODUCT_LINES[line].lifecycle];

/** The lines the platform can carry today: the ones whose process it has. */
export const supportedProductLines = (): readonly ProductLineKey[] =>
  (Object.keys(PRODUCT_LINES) as ProductLineKey[]).filter((line) => PRODUCT_LINES[line].lifecycle === "insurance_policy");

/* --------------------------------------- the tenant's catalogue and the model */

/**
 * The operating-model line a **tenant catalogue line** is selling.
 *
 * `core_products.line` is the tenant's own vocabulary — `motor`, `health`,
 * `travel`, `home`, `life`, `sme`, `card`, `loan`, `account` (docs/03) — while
 * the product lines above are the platform's classes of business, which is the
 * grain a licence is written at. Nothing bridged the two, so
 * `regulatorsForProductLine` could only ever be called with a key no route held.
 *
 * The map states the five readings that are unambiguous, and stops there: `sme`
 * is a segment rather than a class, and `card`/`loan`/`account` are lending lines
 * with no class of business on file. Those answer `null`, which the bind seam
 * reads as "no licence can be matched" — never as a guess. Same rule as
 * `REGULATORS[].licenceNumber`: absent with a status, not plausible-looking.
 */
export const CATALOGUE_PRODUCT_LINES: Readonly<Record<string, ProductLineKey>> = {
  motor: "car_insurance",
  health: "health_insurance",
  travel: "travel_insurance",
  home: "home_insurance",
  life: "life_insurance"
};

/** The class of business a catalogue line is, or null when the model has none. */
export function productLineOf(catalogueLine: string): ProductLineKey | null {
  return CATALOGUE_PRODUCT_LINES[catalogueLine] ?? null;
}

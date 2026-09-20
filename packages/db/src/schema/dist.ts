import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// Aggregator spine. The tenant sells other underwriters' products, and may be an
// underwriter itself (core_providers.is_internal). A product is the abstract
// cover; an *offering* is one underwriter's version of it, with its own pricing,
// eligibility and commission. Offerings reach customers through *channels*
// (b2c direct, or b2b partners with their own commission share).
//
// Money is minor units + currency, never floats. Rates are ppm (parts per
// million) so 12.5% is 125_000 — same convention as ledger_fx_rates.

export const channels = sqliteTable(
  "dist_channels",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(), // stable slug used in URLs, attribution and settlement refs
    kind: text("kind").notNull(), // b2c|b2b
    nameJson: text("name_json").notNull(),
    partnerId: text("partner_id"), // -> orbit_partners.id, b2b only
    /** Where the traffic arrives: our own site, a partner portal, an API key, an aggregator feed. */
    medium: text("medium").notNull().default("web"), // web|app|portal|api|branch|call_centre|embed
    /** b2b: who bills the customer. `us` = we collect and remit; `partner` = partner collects. */
    collectsPayment: text("collects_payment").notNull().default("us"), // us|partner|underwriter
    settlementTermsJson: text("settlement_terms_json"), // {frequency, dayOfMonth, netDays, minPayoutMinor}
    defaultCommissionPpm: integer("default_commission_ppm"), // channel share when no per-product rate
    currency: text("currency"),
    status: text("status").notNull().default("active"), // active|paused|terminated
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [
    // Partial: a soft-deleted channel must not block reusing its key.
    uniqueIndex("dist_channels_key_uq").on(t.tenantId, t.key).where(sql`deleted_at IS NULL`),
    index("dist_channels_tenant_idx").on(t.tenantId, t.kind, t.status),
    index("dist_channels_partner_idx").on(t.tenantId, t.partnerId)
  ]
);

/** One underwriter's version of a product: what we can actually quote and sell. */
export const offerings = sqliteTable(
  "dist_offerings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    productId: text("product_id").notNull(), // -> core_products.id
    providerId: text("provider_id").notNull(), // -> core_providers.id (may be our own, is_internal)
    code: text("code").notNull(), // the underwriter's own product code
    nameJson: text("name_json").notNull(),
    currency: text("currency").notNull(),
    /** How a premium is obtained: live API, rate table we hold, or a human at the insurer. */
    pricingMode: text("pricing_mode").notNull().default("api"), // api|table|manual|referral
    ratingInputsJson: text("rating_inputs_json"), // fields the quote request must carry
    ratingTableJson: text("rating_table_json"), // pricingMode=table
    coverageJson: text("coverage_json"), // limits, deductibles, benefits — shown in comparison
    eligibilityJson: text("eligibility_json"), // age, market, vehicle value, sum insured bounds
    /** Commission the underwriter pays us, before any channel share. */
    baseCommissionPpm: integer("base_commission_ppm").notNull().default(0),
    /** Tenant-set floor/ceiling for discretionary discount, ppm of premium. */
    maxDiscountPpm: integer("max_discount_ppm").notNull().default(0),
    minPremiumMinor: integer("min_premium_minor"),
    maxSumInsuredMinor: integer("max_sum_insured_minor"),
    slaSeconds: integer("sla_seconds").notNull().default(30), // quote fan-out timeout
    /** Which channels may sell it; null = all. */
    channelKeysJson: text("channel_keys_json"),
    upsellOfOfferingId: text("upsell_of_offering_id"), // tier ladder: this is the richer version of that
    crossSellTagsJson: text("cross_sell_tags_json"), // ["motor_owner","new_parent"] — matched by the AI
    status: text("status").notNull().default("active"), // draft|active|paused|withdrawn
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [
    // Partial: a withdrawn (soft-deleted) offering must not block reusing its code.
    uniqueIndex("dist_offerings_code_uq")
      .on(t.tenantId, t.providerId, t.code)
      .where(sql`deleted_at IS NULL`),
    index("dist_offerings_product_idx").on(t.tenantId, t.productId, t.status),
    index("dist_offerings_provider_idx").on(t.tenantId, t.providerId, t.status)
  ]
);

/**
 * Effective-dated commission rate for a channel. Resolution is most-specific-wins:
 * (channel, offering) > (channel, product) > (channel, line) > channel default.
 * Rows are never edited — a change closes the old row and opens a new one, so a
 * settlement can always re-derive the rate that applied on the sale date.
 */
export const commissionRates = sqliteTable(
  "dist_commission_rates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    channelId: text("channel_id").notNull(),
    offeringId: text("offering_id"),
    productId: text("product_id"),
    line: text("line"),
    /** Share of the commission we receive that is passed to the channel. */
    channelSharePpm: integer("channel_share_ppm").notNull(),
    /** Optional override of what the underwriter pays us for this channel. */
    baseCommissionPpm: integer("base_commission_ppm"),
    /** Flat per-policy fee on top of the percentage share. */
    flatFeeMinor: integer("flat_fee_minor").notNull().default(0),
    /**
     * docs/decisions/ADR-0083. Reserved seam (docs/16) for depth beyond a flat
     * rate: `{ tiers?: {uptoMinor?, ratePpm}[], volumeBonus?: {thresholdMinor,
     * bonusPpm}, overridePpm? }`, parsed by `commissionStructureOf`
     * (packages/core/src/commission.ts) and fed into `splitCommission`. Null
     * means "flat", the only case before this column existed.
     */
    structureJson: text("structure_json"),
    currency: text("currency"),
    /** Commission is earned on issue, or only once the premium is collected. */
    earnedOn: text("earned_on").notNull().default("issue"), // issue|collection
    clawbackDays: integer("clawback_days").notNull().default(0), // cancellation window
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("dist_commission_rates_idx").on(t.tenantId, t.channelId, t.effectiveFrom),
    index("dist_commission_rates_offering_idx").on(t.tenantId, t.offeringId, t.effectiveFrom)
  ]
);

/**
 * One comparative shop: the customer's details fanned out to every eligible
 * offering. `consentId` records the basis on which we passed those details to
 * third parties — no fan-out without one (docs/12 §3).
 */
export const quoteRequests = sqliteTable(
  "dist_quote_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id"), // -> axis_cases.id, created on intent to buy
    customerId: text("customer_id"),
    channelId: text("channel_id").notNull(),
    productId: text("product_id").notNull(),
    /** The risk, normalised to the product's rating inputs. PII lives here. */
    inputsJson: text("inputs_json").notNull(),
    consentId: text("consent_id"), // -> core_consents.id; required to share with providers
    fanoutCount: integer("fanout_count").notNull().default(0),
    respondedCount: integer("responded_count").notNull().default(0),
    bestOfferingId: text("best_offering_id"),
    bestPremiumMinor: integer("best_premium_minor"),
    currency: text("currency").notNull(),
    sharedWithCustomerAt: integer("shared_with_customer_at"),
    /**
     * SHA-256 of the one-time link the public portal hands an anonymous visitor
     * (J-C1). No session exists there, so this is the only thing standing
     * between a stranger and someone else's comparison; the plaintext is shown
     * once, in the response that created the request, and never stored.
     */
    portalTokenHash: text("portal_token_hash"),
    state: text("state").notNull().default("open"), // open|fanned_out|complete|expired|converted|abandoned
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("dist_quote_requests_idx").on(t.tenantId, t.state, t.createdAt),
    index("dist_quote_requests_customer_idx").on(t.tenantId, t.customerId, t.createdAt),
    index("dist_quote_requests_channel_idx").on(t.tenantId, t.channelId, t.createdAt)
  ]
);

/** One provider's answer in a comparative shop. Declines are kept — they are the panel's quality signal. */
export const quoteResponses = sqliteTable(
  "dist_quote_responses",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    requestId: text("request_id").notNull(),
    offeringId: text("offering_id").notNull(),
    providerId: text("provider_id").notNull(),
    state: text("state").notNull().default("pending"), // pending|quoted|declined|referred|timeout|error
    premiumMinor: integer("premium_minor"),
    taxMinor: integer("tax_minor").notNull().default(0),
    feesMinor: integer("fees_minor").notNull().default(0),
    currency: text("currency"),
    /** What we expect to earn if this one wins — resolved at quote time, stamped, not recomputed. */
    commissionPpm: integer("commission_ppm"),
    commissionMinor: integer("commission_minor"),
    channelCommissionMinor: integer("channel_commission_minor"),
    coverageJson: text("coverage_json"),
    /** Comparison scaffolding: rank by price, and the AI's value score across cover vs price. */
    priceRank: integer("price_rank"),
    valueScore: integer("value_score"), // 0-100
    rationaleKey: text("rationale_key"), // i18n key: why this one is highlighted
    declineReason: text("decline_reason"),
    latencyMs: integer("latency_ms"),
    validUntil: integer("valid_until"),
    rawRef: text("raw_ref"), // -> core_files.id, the provider's raw response for audit
    selectedAt: integer("selected_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("dist_quote_responses_uq").on(t.tenantId, t.requestId, t.offeringId),
    index("dist_quote_responses_provider_idx").on(t.tenantId, t.providerId, t.createdAt),
    index("dist_quote_responses_state_idx").on(t.tenantId, t.state, t.createdAt)
  ]
);

/**
 * The three-way money view of one sale: what the underwriter owes us, what we
 * owe the channel, what we keep. Rows are the settlement source of truth; the
 * journals they post are in ledger_journal_lines and never edited in place.
 */
export const commissionEntries = sqliteTable(
  "dist_commission_entries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    policyId: text("policy_id").notNull(), // -> axis_policies.id
    offeringId: text("offering_id"),
    providerId: text("provider_id").notNull(),
    channelId: text("channel_id").notNull(),
    rateId: text("rate_id"), // -> dist_commission_rates.id, the row that applied
    kind: text("kind").notNull().default("new_business"), // new_business|renewal|endorsement|clawback|adjustment
    premiumMinor: integer("premium_minor").notNull(),
    /** Receivable from the underwriter. */
    grossCommissionMinor: integer("gross_commission_minor").notNull(),
    /** Payable to the channel (0 for b2c). */
    channelCommissionMinor: integer("channel_commission_minor").notNull().default(0),
    /** gross - channel - tax. Derived on write, stored so a statement is reproducible. */
    netCommissionMinor: integer("net_commission_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    currency: text("currency").notNull(),
    earnedOn: text("earned_on").notNull().default("issue"), // issue|collection
    earnedAt: integer("earned_at"),
    /** A clawback points at the entry it reverses; the original is never mutated. */
    reversalOf: text("reversal_of"),
    providerSettlementId: text("provider_settlement_id"), // -> ledger_settlements.id (money in)
    channelSettlementId: text("channel_settlement_id"), // -> ledger_settlements.id (money out)
    txnId: text("txn_id"), // -> ledger_txns.id
    state: text("state").notNull().default("accrued"),
    // accrued|invoiced|received|payable|paid|clawed_back|disputed|written_off
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    // Backs the accrue route's check-then-insert (apps/api/src/routes/dist.ts):
    // one accrual per (policy, kind), enforced against concurrent requests.
    // Clawbacks are exempt — each reversed accrual adds a kind='clawback' row.
    uniqueIndex("dist_commission_entries_accrual_uq")
      .on(t.tenantId, t.policyId, t.kind)
      .where(sql`kind != 'clawback'`),
    index("dist_commission_entries_idx").on(t.tenantId, t.state, t.earnedAt),
    index("dist_commission_entries_policy_idx").on(t.tenantId, t.policyId),
    index("dist_commission_entries_provider_idx").on(t.tenantId, t.providerId, t.state),
    index("dist_commission_entries_channel_idx").on(t.tenantId, t.channelId, t.state)
  ]
);

/**
 * An AI-detected next-best-offer on a customer's journey. Kept separate from
 * ai_suggestions because it carries money and consent: an offer is only
 * surfaced where the customer's marketing purpose allows it, and every
 * surfaced offer is attributable if it converts.
 */
export const nextBestOffers = sqliteTable(
  "dist_next_best_offers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id").notNull(),
    kind: text("kind").notNull(), // cross_sell|upsell|renewal|bundle|top_up
    offeringId: text("offering_id").notNull(),
    /** What triggered it: the policy or quote the customer already has. */
    anchorRef: text("anchor_ref"),
    channelId: text("channel_id"),
    score: integer("score").notNull(), // 0-100 propensity
    expectedValueMinor: integer("expected_value_minor"),
    currency: text("currency"),
    reasonKey: text("reason_key").notNull(), // i18n key — never free text on a customer surface
    reasonJson: text("reason_json"), // evidence: signals the model used, for the audit trail
    runId: text("run_id"), // -> ai_runs.id
    model: text("model"),
    /** Suppressed when consent is missing, a frequency cap hits, or a human declines it. */
    state: text("state").notNull().default("proposed"),
    // proposed|surfaced|accepted|dismissed|suppressed|expired|converted
    suppressReason: text("suppress_reason"), // no_consent|frequency_cap|not_eligible|agent_declined
    surfacedAt: integer("surfaced_at"),
    decidedAt: integer("decided_at"),
    convertedRequestId: text("converted_request_id"), // -> dist_quote_requests.id
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("dist_nbo_customer_idx").on(t.tenantId, t.customerId, t.state),
    index("dist_nbo_state_idx").on(t.tenantId, t.state, t.score)
  ]
);

/**
 * The commercial agreement behind a b2b channel. Versioned and never edited: a
 * new set of terms supersedes the old one so a commission dispute six months
 * from now can be settled by reading the version that was active on the sale
 * date — the same reason `dist_commission_rates` rows are closed rather than
 * updated.
 *
 * `termsJson` carries what the money engine needs to be told rather than made to
 * guess: {settlement: {frequency, netDays, minPayoutMinor}, clawbackDays,
 * exclusivity, territories, terminationNoticeDays}.
 */
export const partnerAgreements = sqliteTable(
  "dist_partner_agreements",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    partnerId: text("partner_id").notNull(), // -> orbit_partners.id
    version: integer("version").notNull(),
    kind: text("kind").notNull().default("distribution"), // distribution|referral|introducer|underwriting|data
    termsJson: text("terms_json").notNull(),
    documentFileId: text("document_file_id"),
    /** Who on each side put their name to it. */
    signedByUserId: text("signed_by_user_id"),
    signedByPartnerName: text("signed_by_partner_name"),
    signedAt: integer("signed_at"),
    effectiveFrom: integer("effective_from"),
    effectiveTo: integer("effective_to"),
    state: text("state").notNull().default("draft"), // draft|pending_signature|active|superseded|terminated
    supersedesId: text("supersedes_id"),
    /** The approval that let it become active; null while it is still paper. */
    approvalId: text("approval_id"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("dist_partner_agreements_uq").on(t.tenantId, t.partnerId, t.version),
    index("dist_partner_agreements_state_idx").on(t.tenantId, t.partnerId, t.state)
  ]
);

import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// docs/19 — transactions & double-entry ledger. Implemented once here, inherited
// by every module. Posted rows are immutable: corrections are contra postings.

/* ------------------------------------------------------------ transactions */

export const txns = sqliteTable(
  "ledger_txns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(), // catalogue code, docs/19 §4 (BIND, CMSN-ACCR, ...)
    version: integer("version").notNull().default(1),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id"), // saga / business process grouping
    parentTxnId: text("parent_txn_id"),
    reversalOf: text("reversal_of"),
    state: text("state").notNull().default("initiated"),
    // initiated|validated|authorized|executing|pending_external|settled
    // |reversing|reversed|adjusting|adjusted|failed|rejected|expired
    actorKind: text("actor_kind").notNull(), // user|agent|partner|system|customer
    actorId: text("actor_id").notNull(),
    autonomyLevel: text("autonomy_level"),
    subjectRefsJson: text("subject_refs_json"),
    currency: text("currency").notNull(),
    baseCurrency: text("base_currency").notNull(),
    fxRatePpm: integer("fx_rate_ppm"), // parts per million, stamped at posting
    amountsJson: text("amounts_json"), // {gross,net,tax,fee,commission,share}
    grossMinor: integer("gross_minor").notNull().default(0),
    baseGrossMinor: integer("base_gross_minor").notNull().default(0),
    ledgerBatchId: text("ledger_batch_id"),
    eventIdsJson: text("event_ids_json"),
    evidenceRefsJson: text("evidence_refs_json"),
    guardrailsJson: text("guardrails_json"), // consent_checked, disclosure_presented, ...
    failureCode: text("failure_code"),
    failureDetail: text("failure_detail"),
    externalTimeoutAt: integer("external_timeout_at"),
    metadataJson: text("metadata_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    settledAt: integer("settled_at"),
    failedAt: integer("failed_at")
  },
  (t) => [
    uniqueIndex("ledger_txns_idem_uq").on(t.tenantId, t.type, t.idempotencyKey),
    index("ledger_txns_tenant_idx").on(t.tenantId, t.state, t.createdAt),
    index("ledger_txns_corr_idx").on(t.tenantId, t.correlationId),
    index("ledger_txns_type_idx").on(t.tenantId, t.type, t.createdAt)
  ]
);

/** Append-only state-machine history; powers the transaction detail timeline. */
export const txnTransitions = sqliteTable(
  "ledger_txn_transitions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    txnId: text("txn_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorRef: text("actor_ref").notNull(),
    reason: text("reason"),
    ts: integer("ts").notNull()
  },
  (t) => [index("ledger_txn_transitions_idx").on(t.tenantId, t.txnId, t.ts)]
);

/** Saga steps with their compensation handles (docs/19 §8). */
export const sagaSteps = sqliteTable(
  "ledger_saga_steps",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    txnId: text("txn_id").notNull(),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("pending"),
    // pending|running|done|compensating|compensated|failed
    requestHash: text("request_hash"),
    resultJson: text("result_json"),
    compensationRef: text("compensation_ref"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at")
  },
  (t) => [uniqueIndex("ledger_saga_steps_uq").on(t.tenantId, t.txnId, t.seq)]
);

/* ----------------------------------------------------------------- ledger */

/** Chart of accounts (docs/19 §5.1), tenant-scoped and extensible. */
export const accounts = sqliteTable(
  "ledger_accounts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    code: text("code").notNull(), // "1010"
    nameJson: text("name_json").notNull(),
    type: text("type").notNull(), // asset|liability|income|expense|equity
    normalSide: text("normal_side").notNull(), // debit|credit
    clientMoney: integer("client_money", { mode: "boolean" }).notNull().default(false),
    // ADR-0083. A clearing/suspense account that must net to zero at period
    // close (e.g. 1300 PSP Clearing) — read by periods.ts's no_suspense_balance
    // close check, never inferred from the account's name or code.
    suspense: integer("suspense", { mode: "boolean" }).notNull().default(false),
    currency: text("currency"), // null = multi-currency account
    parentCode: text("parent_code"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("ledger_accounts_uq").on(t.tenantId, t.code)]
);

/** A batch is the atomic posting unit; it must balance in txn and base currency. */
export const journalBatches = sqliteTable(
  "ledger_journal_batches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    txnId: text("txn_id").notNull(),
    periodId: text("period_id").notNull(),
    currency: text("currency").notNull(),
    baseCurrency: text("base_currency").notNull(),
    fxRatePpm: integer("fx_rate_ppm").notNull().default(1_000_000),
    totalDebitMinor: integer("total_debit_minor").notNull(),
    totalCreditMinor: integer("total_credit_minor").notNull(),
    baseTotalDebitMinor: integer("base_total_debit_minor").notNull(),
    baseTotalCreditMinor: integer("base_total_credit_minor").notNull(),
    reversalOfBatchId: text("reversal_of_batch_id"),
    postedBy: text("posted_by").notNull(),
    postedAt: integer("posted_at").notNull()
  },
  (t) => [
    index("ledger_batches_tenant_idx").on(t.tenantId, t.postedAt),
    index("ledger_batches_period_idx").on(t.tenantId, t.periodId),
    uniqueIndex("ledger_batches_txn_uq").on(t.tenantId, t.txnId)
  ]
);

/** Immutable. Never updated, never deleted — corrections are new contra lines. */
export const journalLines = sqliteTable(
  "ledger_journal_lines",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    batchId: text("batch_id").notNull(),
    txnId: text("txn_id").notNull(),
    seq: integer("seq").notNull(),
    accountCode: text("account_code").notNull(),
    side: text("side").notNull(), // debit|credit
    amountMinor: integer("amount_minor").notNull(), // always positive; side carries sign
    currency: text("currency").notNull(),
    baseAmountMinor: integer("base_amount_minor").notNull(),
    baseCurrency: text("base_currency").notNull(),
    memo: text("memo"),
    dimsJson: text("dims_json"), // provider, partner, campaign, product line
    postedAt: integer("posted_at").notNull()
  },
  (t) => [
    index("ledger_lines_account_idx").on(t.tenantId, t.accountCode, t.postedAt),
    index("ledger_lines_batch_idx").on(t.tenantId, t.batchId),
    uniqueIndex("ledger_lines_seq_uq").on(t.tenantId, t.batchId, t.seq)
  ]
);

/** Running balances, maintained inside the posting transaction. Rebuildable from lines. */
export const accountBalances = sqliteTable(
  "ledger_account_balances",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    accountCode: text("account_code").notNull(),
    currency: text("currency").notNull(),
    debitMinor: integer("debit_minor").notNull().default(0),
    creditMinor: integer("credit_minor").notNull().default(0),
    baseDebitMinor: integer("base_debit_minor").notNull().default(0),
    baseCreditMinor: integer("base_credit_minor").notNull().default(0),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("ledger_balances_uq").on(t.tenantId, t.accountCode, t.currency)]
);

/** open → soft_closed (adjustments with reason) → hard_closed (contra only). */
export const periods = sqliteTable(
  "ledger_periods",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    code: text("code").notNull(), // YYYY-MM
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    state: text("state").notNull().default("open"), // open|soft_closed|hard_closed
    checklistJson: text("checklist_json"),
    // docs/27 F20. Why the period is in the state it is in: the break a forced
    // close accepted, or the reason a signed-off month was reopened. The audit
    // log stores only hashes of before/after, so without this the sentence an
    // auditor actually wants to read exists nowhere.
    stateReason: text("state_reason"),
    closePackFileId: text("close_pack_file_id"),
    closedBy: text("closed_by"),
    closedAt: integer("closed_at")
  },
  (t) => [uniqueIndex("ledger_periods_uq").on(t.tenantId, t.code)]
);

/* ------------------------------------------------- reconciliation & money */

export const reconRuns = sqliteTable(
  "ledger_recon_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    process: text("process").notNull(), // insurer|psp|client_money|partner|media
    period: text("period").notNull(),
    counterpartyRef: text("counterparty_ref"),
    statementFileId: text("statement_file_id"),
    matchedCount: integer("matched_count").notNull().default(0),
    varianceCount: integer("variance_count").notNull().default(0),
    varianceMinor: integer("variance_minor").notNull().default(0),
    currency: text("currency").notNull(),
    state: text("state").notNull().default("running"), // running|review|closed|failed
    evidenceBundleFileId: text("evidence_bundle_file_id"),
    closedBy: text("closed_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("ledger_recon_runs_idx").on(t.tenantId, t.process, t.period)]
);

/** AI-proposed matches land here as proposals; a human confirms (docs/19 §6). */
export const reconMatches = sqliteTable(
  "ledger_recon_matches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    runId: text("run_id").notNull(),
    statementLineRef: text("statement_line_ref"),
    txnId: text("txn_id"),
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    deltaMinor: integer("delta_minor").notNull().default(0),
    method: text("method").notNull(), // deterministic|tolerance|ai_proposed
    confidence: integer("confidence"),
    state: text("state").notNull().default("proposed"), // proposed|confirmed|rejected|unmatched
    reasonCode: text("reason_code"),
    confirmedBy: text("confirmed_by"),
    confirmedAt: integer("confirmed_at"),
    // docs/19 §6 / docs/27 F19: the CMSN-SETL this match booked. `txnId` above
    // is the *accrual* the statement line matched; this is the settlement that
    // cleared it. Two different transactions, so two different columns — one
    // holding both would be a column that means whatever the last writer meant.
    settlementTxnId: text("settlement_txn_id"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("ledger_recon_matches_idx").on(t.tenantId, t.runId, t.state)]
);

/** Client-money segregation checks. A shortfall is a hard alarm (CM-BREACH-FLAG). */
export const clientMoneyChecks = sqliteTable(
  "ledger_client_money_checks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    assetMinor: integer("asset_minor").notNull(), // 1010
    liabilityMinor: integer("liability_minor").notNull(), // 2010
    currency: text("currency").notNull(),
    shortfallMinor: integer("shortfall_minor").notNull().default(0),
    breach: integer("breach", { mode: "boolean" }).notNull().default(false),
    triggeredBy: text("triggered_by").notNull(), // txn id or "scheduled"
    resolvedAt: integer("resolved_at"),
    ts: integer("ts").notNull()
  },
  (t) => [index("ledger_cm_checks_idx").on(t.tenantId, t.ts)]
);

/* --------------------------------------------- billing, revenue, payments */

export const subscriptions = sqliteTable(
  "ledger_subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    customerRef: text("customer_ref").notNull(),
    plan: text("plan").notNull(),
    edition: text("edition"),
    priceMinor: integer("price_minor").notNull(),
    currency: text("currency").notNull(),
    interval: text("interval").notNull().default("month"), // month|year
    seats: integer("seats").notNull().default(1),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at"),
    nextInvoiceAt: integer("next_invoice_at"),
    state: text("state").notNull().default("active"), // active|paused|cancelled|past_due
    termsJson: text("terms_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("ledger_subscriptions_idx").on(t.tenantId, t.state, t.customerRef),
    index("ledger_subscriptions_next_invoice_idx").on(t.tenantId, t.nextInvoiceAt)
  ]
);

export const invoices = sqliteTable(
  "ledger_invoices",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    number: text("number").notNull(),
    customerRef: text("customer_ref").notNull(),
    subscriptionId: text("subscription_id"),
    subtotalMinor: integer("subtotal_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull(),
    linesJson: text("lines_json").notNull(),
    state: text("state").notNull().default("draft"), // draft|issued|paid|void|credited|overdue
    dueAt: integer("due_at"),
    issuedAt: integer("issued_at"),
    paidAt: integer("paid_at"),
    pdfFileId: text("pdf_file_id"),
    txnId: text("txn_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("ledger_invoices_no_uq").on(t.tenantId, t.number),
    index("ledger_invoices_state_idx").on(t.tenantId, t.state, t.dueAt)
  ]
);

/** Straight-line or usage-based recognition. Never recognises more than invoiced (§11.9). */
export const revenueSchedules = sqliteTable(
  "ledger_revenue_schedules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    invoiceId: text("invoice_id").notNull(),
    accountCode: text("account_code").notNull(),
    period: text("period").notNull(),
    plannedMinor: integer("planned_minor").notNull(),
    recognizedMinor: integer("recognized_minor").notNull().default(0),
    currency: text("currency").notNull(),
    txnId: text("txn_id"),
    state: text("state").notNull().default("scheduled") // scheduled|recognized|cancelled
  },
  (t) => [uniqueIndex("ledger_rev_sched_uq").on(t.tenantId, t.invoiceId, t.period, t.accountCode)]
);

/** Metered usage: API calls, AI tokens, seats, binds, posts. Feeds OVERAGE. */
export const usageMeters = sqliteTable(
  "ledger_usage_meters",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subscriptionId: text("subscription_id"),
    meter: text("meter").notNull(), // api_calls|ai_tokens|seats|binds|conversations|posts
    period: text("period").notNull(), // YYYY-MM
    quantity: integer("quantity").notNull().default(0),
    includedQuantity: integer("included_quantity").notNull().default(0),
    unitPriceMicro: integer("unit_price_micro").notNull().default(0),
    /** Overage units already invoiced, so a later tick bills only the new ones. */
    overageInvoicedQuantity: integer("overage_invoiced_quantity").notNull().default(0),
    /** Set once the period is closed and no further overage can arrive for it. */
    overageInvoicedAt: integer("overage_invoiced_at"),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("ledger_usage_uq").on(t.tenantId, t.subscriptionId, t.meter, t.period)]
);

/** Card data is never stored — tokenised providers only (docs/12). */
export const payments = sqliteTable(
  "ledger_payments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    txnId: text("txn_id"),
    direction: text("direction").notNull(), // in|out
    method: text("method").notNull(), // card|bank|wallet|cash|offset
    providerRef: text("provider_ref"), // PSP id
    providerToken: text("provider_token"), // token only, never PAN
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    feeMinor: integer("fee_minor").notNull().default(0),
    state: text("state").notNull().default("pending"),
    // pending|authorized|captured|settled|failed|refunded|charged_back
    failureCode: text("failure_code"),
    settlementBatch: text("settlement_batch"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("ledger_payments_idx").on(t.tenantId, t.state, t.createdAt),
    index("ledger_payments_batch_idx").on(t.tenantId, t.settlementBatch),
    // Premium financing reads the settlement signal by providerRef ("<planId>:<seq>",
    // ADR-0066), once per plan per cron tick — up to SWEEP_MAX scans per tenant
    // otherwise, on the table that grows fastest once an intake exists.
    index("ledger_payments_ref_idx").on(t.tenantId, t.providerRef)
  ]
);

/** Instalment plans (PLAN-CREATE posts no journal; each instalment does). */
export const paymentPlans = sqliteTable(
  "ledger_payment_plans",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(), // policy id
    financierRef: text("financier_ref"),
    totalMinor: integer("total_minor").notNull(),
    currency: text("currency").notNull(),
    instalments: integer("instalments").notNull(),
    scheduleJson: text("schedule_json").notNull(),
    state: text("state").notNull().default("active"), // active|completed|defaulted|cancelled
    missedStreak: integer("missed_streak").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("ledger_payment_plans_idx").on(t.tenantId, t.state),
    // One live plan per subject, enforced by the database. The engine checks the
    // same rule before it writes (a check gives the caller a 409 with the
    // offending plan id instead of a constraint error), but two concurrent
    // requests both pass that read — Workers have no serialisable transaction to
    // hold it. Partial, because a subject may hold any number of finished plans:
    // cancel one and open another.
    uniqueIndex("ledger_payment_plans_live_uq")
      .on(t.tenantId, t.subjectRef)
      .where(sql`state IN ('active','defaulted')`)
  ]
);

/** Rates stamped onto postings; never fetched at read time. */
export const fxRates = sqliteTable(
  "ledger_fx_rates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromCurrency: text("from_currency").notNull(),
    toCurrency: text("to_currency").notNull(),
    ratePpm: integer("rate_ppm").notNull(),
    asOf: text("as_of").notNull(), // YYYY-MM-DD
    source: text("source").notNull().default("manual")
  },
  (t) => [uniqueIndex("ledger_fx_uq").on(t.tenantId, t.fromCurrency, t.toCurrency, t.asOf)]
);

/** Tax treatment comes from the market rulepack — never inferred in code (§5.3). */
export const taxRules = sqliteTable(
  "ledger_tax_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    market: text("market").notNull(),
    code: text("code").notNull(),
    ratePpm: integer("rate_ppm").notNull(),
    placeOfSupply: text("place_of_supply"),
    reverseCharge: integer("reverse_charge", { mode: "boolean" }).notNull().default(false),
    exempt: integer("exempt", { mode: "boolean" }).notNull().default(false),
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to")
  },
  (t) => [index("ledger_tax_rules_idx").on(t.tenantId, t.market, t.effectiveFrom)]
);

/** Partner/creator/publisher settlement runs with an attached statement. */
export const settlements = sqliteTable(
  "ledger_settlements",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    counterpartyKind: text("counterparty_kind").notNull(), // partner|creator|publisher|insurer
    counterpartyRef: text("counterparty_ref").notNull(),
    period: text("period").notNull(),
    grossMinor: integer("gross_minor").notNull().default(0),
    adjustmentsMinor: integer("adjustments_minor").notNull().default(0),
    netMinor: integer("net_minor").notNull().default(0),
    currency: text("currency").notNull(),
    statementFileId: text("statement_file_id"),
    state: text("state").notNull().default("draft"), // draft|approved|paid|disputed
    disputeReason: text("dispute_reason"),
    // The proof money actually left the building: a human-confirmed bank/PSP
    // reference, required before `pay` can move a settlement to `paid` (docs/25
    // §7 — no PSP connector here, so this is the v1 payout control).
    externalRef: text("external_ref"),
    paidVia: text("paid_via"), // bank_transfer|psp|other
    approvedBy: text("approved_by"),
    txnId: text("txn_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("ledger_settlements_uq").on(t.tenantId, t.counterpartyKind, t.counterpartyRef, t.period)]
);

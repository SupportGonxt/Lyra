import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// docs/03 §AXIS — operations. Case is the unit of work.

export const cases = sqliteTable(
  "axis_cases",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    ref: text("ref").notNull(), // human-facing short ref, unique per tenant
    kind: text("kind").notNull(), // quote|bind|endorse|renewal_ops|group_medical|kyc|claim
    customerId: text("customer_id"),
    productLine: text("product_line"),
    channelId: text("channel_id"), // -> dist_channels.id, where the case came from
    quoteRequestId: text("quote_request_id"), // -> dist_quote_requests.id, the comparative shop
    status: text("status").notNull().default("intake"), // intake|quoting|awaiting_docs|review|approval|issued|failed|cancelled
    slaDueAt: integer("sla_due_at"),
    ownerRef: text("owner_ref"), // user:<id> | agent:<key>
    teamId: text("team_id"),
    priority: text("priority").notNull().default("normal"), // low|normal|high|urgent
    source: text("source").notNull().default("web"), // web|orbit|partner|import|api|agent
    riskScore: integer("risk_score"),
    valueMinor: integer("value_minor"),
    currency: text("currency"),
    metaJson: text("meta_json"),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [
    index("axis_cases_tenant_idx").on(t.tenantId, t.status, t.slaDueAt),
    index("axis_cases_owner_idx").on(t.tenantId, t.ownerRef, t.status),
    index("axis_cases_customer_idx").on(t.tenantId, t.customerId),
    // Partial: a soft-deleted case must not block reusing its ref.
    uniqueIndex("axis_cases_ref_uq").on(t.tenantId, t.ref).where(sql`deleted_at IS NULL`)
  ]
);

/**
 * @deprecated docs/27 F13 / docs/specs/gap-axis-design.md §C.10. Two tables
 * held one concept; `dist_quote_responses` won. Nothing writes here any more —
 * a hand-keyed quote goes to POST /v1/axis/cases/:id/quotes, which files it as
 * a quote response. Kept readable for cases quoted before the change; the
 * removal migration waits until those have aged out (migrations are
 * forward-only, so dropping it is a one-way door).
 */
export const quotes = sqliteTable(
  "axis_quotes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id").notNull(),
    providerId: text("provider_id").notNull(),
    offeringId: text("offering_id"), // -> dist_offerings.id
    responseId: text("response_id"), // -> dist_quote_responses.id when it came from a fan-out
    premiumMinor: integer("premium_minor").notNull(),
    currency: text("currency").notNull(),
    coverageJson: text("coverage_json"),
    validUntil: integer("valid_until"),
    winFlag: integer("win_flag", { mode: "boolean" }).notNull().default(false),
    declineReason: text("decline_reason"),
    source: text("source").notNull().default("manual"), // manual|api|portal|ai_extract
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("axis_quotes_tenant_idx").on(t.tenantId, t.caseId),
    index("axis_quotes_provider_idx").on(t.tenantId, t.providerId, t.createdAt)
  ]
);

export const documents = sqliteTable(
  "axis_documents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id").notNull(),
    fileId: text("file_id").notNull(),
    docType: text("doc_type").notNull(), // eid|mulkiya|census|medical|tradelicense|other
    extractionJson: text("extraction_json"),
    extractionConfidence: integer("extraction_confidence"), // 0-100
    extractionModel: text("extraction_model"),
    verifiedBy: text("verified_by"),
    verifiedAt: integer("verified_at"),
    status: text("status").notNull().default("received"), // received|extracting|extracted|verified|rejected
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("axis_documents_tenant_idx").on(t.tenantId, t.caseId, t.docType)]
);

export const tasks = sqliteTable(
  "axis_tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id"),
    type: text("type").notNull(),
    titleKey: text("title_key").notNull(),
    assigneeRef: text("assignee_ref"),
    state: text("state").notNull().default("open"), // open|in_progress|blocked|done|cancelled
    dueAt: integer("due_at"),
    checklistJson: text("checklist_json"),
    createdBy: text("created_by").notNull(),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("axis_tasks_tenant_idx").on(t.tenantId, t.state, t.dueAt),
    index("axis_tasks_assignee_idx").on(t.tenantId, t.assigneeRef, t.state)
  ]
);

/** Module-local approval rows mirror core_approvals for case-scoped queries. */
export const approvals = sqliteTable(
  "axis_approvals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    approvalId: text("approval_id").notNull(), // -> core_approvals.id
    caseId: text("case_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    policyKey: text("policy_key").notNull(),
    decision: text("decision").notNull().default("pending"),
    ts: integer("ts").notNull()
  },
  (t) => [index("axis_approvals_tenant_idx").on(t.tenantId, t.caseId, t.decision)]
);

export const policies = sqliteTable(
  "axis_policies",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id"),
    customerId: text("customer_id").notNull(),
    providerId: text("provider_id").notNull(),
    productId: text("product_id"),
    offeringId: text("offering_id"), // -> dist_offerings.id, the underwriter's variant sold
    channelId: text("channel_id"), // -> dist_channels.id, who sold it — drives commission split
    policyNo: text("policy_no").notNull(),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at").notNull(),
    premiumMinor: integer("premium_minor").notNull(),
    currency: text("currency").notNull(),
    commissionMinor: integer("commission_minor").notNull().default(0),
    docsJson: text("docs_json"),
    escrowBatchId: text("escrow_batch_id"),
    // The instalment plan, read and acted on: `PaymentPlanJson` (../json.ts) is
    // its shape and `sweepPolicyLifecycle` lapses a policy whose instalment
    // went unpaid past grace (engines/axis-lifecycle.ts). What stays reserved
    // under docs/16 H9 is *financing* — a premium-finance agreement with a
    // third party — not this column. It read `// H9 reserved` long after the
    // sweep started depending on it (docs/27 F25).
    paymentPlanJson: text("payment_plan_json"),
    // docs/27 F5. The head row is the contract; terms live in axis_policy_versions.
    // premiumMinor/startAt/endAt above are denormalizations of the effective
    // version and are written only by the lifecycle endpoints.
    currentVersionId: text("current_version_id"), // -> axis_policy_versions.id
    versionSeq: integer("version_seq").notNull().default(1),
    taxMinor: integer("tax_minor").notNull().default(0),
    feesMinor: integer("fees_minor").notNull().default(0),
    grossMinor: integer("gross_minor").notNull().default(0), // premium + tax + fees
    renewedFromPolicyId: text("renewed_from_policy_id"), // prior term, same risk
    renewalSeq: integer("renewal_seq").notNull().default(0), // 0 = new business
    inceptedAt: integer("incepted_at"),
    lapsedAt: integer("lapsed_at"),
    cancelledAt: integer("cancelled_at"),
    cancelReasonCode: text("cancel_reason_code"),
    cancelEffectiveAt: integer("cancel_effective_at"), // may differ from cancelledAt
    statusReason: text("status_reason"),
    lastTxnId: text("last_txn_id"), // -> ledger_txns.id
    status: text("status").notNull().default("active"),
    // draft|bound|active|lapsed|cancelled|expired|renewed|ntu — POLICY_STATES in
    // packages/core/src/lifecycle.ts is the authority.
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("axis_policies_tenant_idx").on(t.tenantId, t.endAt),
    index("axis_policies_customer_idx").on(t.tenantId, t.customerId),
    index("axis_policies_renewal_idx").on(t.tenantId, t.renewedFromPolicyId),
    uniqueIndex("axis_policies_no_uq").on(t.tenantId, t.providerId, t.policyNo)
  ]
);

/**
 * docs/27 F5 / design §C.2. Endorsement history is a real child list, not
 * "every policy sharing a customerId". One row per priced state of the
 * contract; `[effectiveFrom, effectiveTo)` intervals of the non-voided rows are
 * contiguous and non-overlapping, and exactly one is `effective` at a time.
 */
export const policyVersions = sqliteTable(
  "axis_policy_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    policyId: text("policy_id").notNull(), // -> axis_policies.id
    versionSeq: integer("version_seq").notNull(), // 1 = as issued, dense
    endorsementNo: text("endorsement_no"), // insurer's ref, null on seq 1
    reason: text("reason").notNull(),
    // issue|endorsement|cancellation|reinstatement|renewal_rollover|correction
    reasonCode: text("reason_code"), // tenant taxonomy, e.g. mta.vehicle_change
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to").notNull(),
    premiumMinor: integer("premium_minor").notNull(),
    taxMinor: integer("tax_minor").notNull().default(0),
    feesMinor: integer("fees_minor").notNull().default(0),
    commissionMinor: integer("commission_minor").notNull().default(0),
    currency: text("currency").notNull(),
    premiumDeltaMinor: integer("premium_delta_minor").notNull().default(0), // signed vs prior
    proRataDays: integer("pro_rata_days"),
    termsJson: text("terms_json").notNull(), // cover, limits, excess, insured items
    ratingJson: text("rating_json"), // apps/api/src/engines/rating.ts output
    quoteResponseId: text("quote_response_id"), // -> dist_quote_responses.id (F13 seam)
    txnId: text("txn_id"), // -> ledger_txns.id that authorized it
    approvalId: text("approval_id"), // -> core_approvals.id
    documentFileId: text("document_file_id"), // -> core_files.id, this version's schedule
    deliveredAt: integer("delivered_at"),
    deliveryRef: text("delivery_ref"), // orbit message id
    state: text("state").notNull().default("pending"), // pending|effective|superseded|voided
    issuedBy: text("issued_by").notNull(),
    issuedAt: integer("issued_at").notNull(),
    supersededAt: integer("superseded_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_policy_versions_seq_uq").on(t.tenantId, t.policyId, t.versionSeq),
    index("axis_policy_versions_policy_idx").on(t.tenantId, t.policyId, t.effectiveFrom),
    index("axis_policy_versions_txn_idx").on(t.tenantId, t.txnId)
  ]
);

export const escrowBatches = sqliteTable(
  "axis_escrow_batches",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    period: text("period").notNull(), // YYYY-MM
    providerId: text("provider_id").notNull(),
    expectedMinor: integer("expected_minor").notNull().default(0),
    receivedMinor: integer("received_minor").notNull().default(0),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("open"), // open|reconciling|matched|variance|closed
    varianceReason: text("variance_reason"),
    evidenceFileId: text("evidence_file_id"),
    closedBy: text("closed_by"),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("axis_escrow_uq").on(t.tenantId, t.period, t.providerId)]
);

export const sops = sqliteTable(
  "axis_sops",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    nameJson: text("name_json").notNull(),
    stepsJson: text("steps_json").notNull(),
    appliesTo: text("applies_to"), // case kind
    status: text("status").notNull().default("draft"), // draft|active|retired
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("axis_sops_uq").on(t.tenantId, t.key, t.version)]
);

/** Normalized step events for process mining (docs/05 AXIS). */
export const processEvents = sqliteTable(
  "axis_process_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id").notNull(),
    step: text("step").notNull(),
    actorRef: text("actor_ref").notNull(),
    durationMs: integer("duration_ms"),
    outcome: text("outcome"),
    ts: integer("ts").notNull()
  },
  (t) => [index("axis_process_events_idx").on(t.tenantId, t.caseId, t.ts)]
);

/** Tenant-configurable SLA, routing and queue policy (docs/03 §AXIS admin). */
export const opsPolicies = sqliteTable(
  "axis_ops_policies",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    kind: text("kind").notNull(), // sla|routing|queue
    valueJson: text("value_json").notNull(),
    status: text("status").notNull().default("active"), // active|disabled
    updatedBy: text("updated_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("axis_ops_policies_key_uq").on(t.tenantId, t.key)]
);

/** Claims: the other consequential AXIS flow (guidance is regulated — docs/12). */
export const claims = sqliteTable(
  "axis_claims",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    policyId: text("policy_id").notNull(),
    customerId: text("customer_id").notNull(),
    caseId: text("case_id"),
    claimNo: text("claim_no").notNull(),
    incidentAt: integer("incident_at"),
    reportedAt: integer("reported_at").notNull(),
    amountMinor: integer("amount_minor"),
    settledMinor: integer("settled_minor"),
    currency: text("currency").notNull(),
    status: text("status").notNull().default("reported"), // reported|assessing|approved|rejected|settled|withdrawn
    fnolJson: text("fnol_json"),
    assessorRef: text("assessor_ref"),
    // docs/27 F23/F24. `amountMinor` is what the claimant notified; `settledMinor`
    // is what was agreed. `incurredMinor` is never stored — it is
    // paid + reserve - recovered, computed in `@lyra/core` claims.ts:incurred().
    policyVersionId: text("policy_version_id"), // the version in force at incidentAt
    coverageState: text("coverage_state").notNull().default("unknown"),
    // in_force|not_yet_incepted|lapsed_at_loss|cancelled_at_loss|out_of_cover|unknown
    coverageCheckedAt: integer("coverage_checked_at"),
    coverageJson: text("coverage_json"), // the limits/excess applied, snapshotted
    perilCode: text("peril_code"),
    causeCode: text("cause_code"),
    catCode: text("cat_code"), // catastrophe event grouping
    reserveMinor: integer("reserve_minor").notNull().default(0), // denormalized head of history
    paidMinor: integer("paid_minor").notNull().default(0),
    recoveredMinor: integer("recovered_minor").notNull().default(0),
    excessMinor: integer("excess_minor").notNull().default(0),
    handlerRef: text("handler_ref"), // user:<id>; assessorRef stays for the external assessor
    slaDueAt: integer("sla_due_at"),
    fraudScore: integer("fraud_score"), // 0-100, from the SIU model
    siuState: text("siu_state"), // null|referred|clearing|substantiated
    complexity: text("complexity").notNull().default("standard"), // fast_track|standard|complex|litigated
    reopenedAt: integer("reopened_at"),
    closedAt: integer("closed_at"),
    lastTxnId: text("last_txn_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("axis_claims_tenant_idx").on(t.tenantId, t.status, t.reportedAt),
    index("axis_claims_customer_idx").on(t.tenantId, t.customerId),
    index("axis_claims_policy_idx").on(t.tenantId, t.policyId, t.reportedAt),
    uniqueIndex("axis_claims_no_uq").on(t.tenantId, t.claimNo)
  ]
);

/**
 * Reserve movement history (§C.4). Append-only — enforced by triggers in
 * migration 0017, because a reserve you can edit in place cannot answer "what
 * did we think this was worth in March", which is what triangles and reserve
 * adequacy are made of. `axis_claims.reserveMinor` is the sum of the latest
 * `amountMinor` per head, written in the same batch; invariants in
 * `claim-reserves.ts`.
 */
export const claimReserves = sqliteTable(
  "axis_claim_reserves",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    claimId: text("claim_id").notNull(),
    seq: integer("seq").notNull(),
    head: text("head").notNull().default("indemnity"), // indemnity|expense|recovery
    amountMinor: integer("amount_minor").notNull(), // reserve AFTER this movement
    previousMinor: integer("previous_minor").notNull().default(0),
    deltaMinor: integer("delta_minor").notNull(), // signed
    currency: text("currency").notNull(),
    basis: text("basis").notNull(), // ai_recommended|assessor|desk_estimate|insurer_advised|formula|closure
    rationale: text("rationale"),
    evidenceJson: text("evidence_json"), // doc ids / comparable claims the estimate cites
    confidence: integer("confidence"), // 0-100 when basis = ai_recommended
    aiAuditId: text("ai_audit_id"), // -> ai_audit_log.id
    approvalId: text("approval_id"),
    txnId: text("txn_id"),
    setBy: text("set_by").notNull(),
    setAt: integer("set_at").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_claim_reserves_seq_uq").on(t.tenantId, t.claimId, t.head, t.seq),
    index("axis_claim_reserves_claim_idx").on(t.tenantId, t.claimId, t.setAt)
  ]
);

/**
 * One ledger transaction, one payment record (§C.5). The unique index on txnId
 * is what makes paying a claim twice structurally impossible — the money is the
 * transaction, this row is the record of who it went to and why.
 */
export const claimPayments = sqliteTable(
  "axis_claim_payments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    claimId: text("claim_id").notNull(),
    kind: text("kind").notNull(), // indemnity|expense|interim|final|ex_gratia|excess_refund
    payeeKind: text("payee_kind").notNull(), // claimant|repairer|provider|third_party|insurer
    payeeRef: text("payee_ref"),
    payeeSealed: text("payee_sealed"), // bank details via sealFields — never plaintext
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),
    method: text("method").notNull().default("eft"), // eft|cheque|card|insurer_direct
    txnId: text("txn_id").notNull(), // -> ledger_txns.id
    approvalId: text("approval_id"),
    state: text("state").notNull().default("requested"), // requested|approved|paid|failed|reversed
    failureCode: text("failure_code"),
    requestedBy: text("requested_by").notNull(),
    requestedAt: integer("requested_at").notNull(),
    paidAt: integer("paid_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_claim_payments_txn_uq").on(t.tenantId, t.txnId),
    index("axis_claim_payments_claim_idx").on(t.tenantId, t.claimId, t.state)
  ]
);

/** Money coming back the other way (§C.6): subrogation, salvage, excess, reinsurance. */
export const claimRecoveries = sqliteTable(
  "axis_claim_recoveries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    claimId: text("claim_id").notNull(),
    kind: text("kind").notNull(), // subrogation|salvage|excess|reinsurance|third_party
    counterpartyRef: text("counterparty_ref"),
    expectedMinor: integer("expected_minor").notNull().default(0),
    recoveredMinor: integer("recovered_minor").notNull().default(0),
    feeMinor: integer("fee_minor").notNull().default(0),
    currency: text("currency").notNull(),
    state: text("state").notNull().default("identified"), // identified|pursuing|agreed|recovered|written_off|abandoned
    nextActionAt: integer("next_action_at"),
    prospects: integer("prospects"), // 0-100, AI-scored likelihood
    txnId: text("txn_id"),
    approvalId: text("approval_id"), // write-off approval
    openedBy: text("opened_by").notNull(),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("axis_claim_recoveries_idx").on(t.tenantId, t.state, t.nextActionAt)]
);

/**
 * One period, one provider, one direction (§C.8). Header row for a
 * bordereau — outbound generation totals its lines against
 * `dist_commission_entries`; inbound reconciliation matches its lines
 * against local policies/claims. `escrowBatchId` links the money side
 * instead of reimplementing it (§E.3).
 */
export const bordereaux = sqliteTable(
  "axis_bordereaux",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    direction: text("direction").notNull(), // inbound|outbound
    counterpartyKind: text("counterparty_kind").notNull(), // provider|channel|partner
    counterpartyId: text("counterparty_id").notNull(),
    kind: text("kind").notNull(), // premium|claims|combined
    period: text("period").notNull(), // YYYY-MM
    currency: text("currency").notNull(),
    lineCount: integer("line_count").notNull().default(0),
    grossPremiumMinor: integer("gross_premium_minor").notNull().default(0),
    commissionMinor: integer("commission_minor").notNull().default(0),
    claimsPaidMinor: integer("claims_paid_minor").notNull().default(0),
    reserveMinor: integer("reserve_minor").notNull().default(0),
    varianceMinor: integer("variance_minor").notNull().default(0),
    state: text("state").notNull().default("draft"), // draft|generated|sent|acknowledged|matched|variance|closed
    fileId: text("file_id"), // -> core_files.id, the file we sent/rendered
    sourceFileId: text("source_file_id"), // -> core_files.id, the inbound file we parsed
    escrowBatchId: text("escrow_batch_id"), // -> axis_escrow_batches.id
    generatedBy: text("generated_by"),
    generatedAt: integer("generated_at"),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_bordereaux_period_uq").on(
      t.tenantId,
      t.direction,
      t.counterpartyId,
      t.kind,
      t.period
    ),
    index("axis_bordereaux_tenant_idx").on(t.tenantId, t.state, t.period)
  ]
);

/**
 * Per-row detail (§C.8). `rawJson` preserves the inbound row verbatim so a
 * disputed match can be re-checked against exactly what the provider sent.
 * `matchState` is set once by reconciliation and not revisited by
 * regeneration — regenerating a period recomputes totals, it does not
 * re-run matching on lines a human may have already actioned.
 */
export const bordereauLines = sqliteTable(
  "axis_bordereau_lines",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    bordereauId: text("bordereau_id").notNull(),
    lineNo: integer("line_no").notNull(),
    policyId: text("policy_id"),
    policyVersionId: text("policy_version_id"),
    claimId: text("claim_id"),
    externalRef: text("external_ref"),
    riskRef: text("risk_ref"), // pack-neutral: VIN, plate, member no, ...
    effectiveFrom: integer("effective_from"),
    effectiveTo: integer("effective_to"),
    grossPremiumMinor: integer("gross_premium_minor").notNull().default(0),
    taxMinor: integer("tax_minor").notNull().default(0),
    netPremiumMinor: integer("net_premium_minor").notNull().default(0),
    commissionMinor: integer("commission_minor").notNull().default(0),
    claimsPaidMinor: integer("claims_paid_minor").notNull().default(0),
    reserveMinor: integer("reserve_minor").notNull().default(0),
    currency: text("currency").notNull(),
    matchState: text("match_state").notNull().default("unmatched"), // unmatched|matched|variance|missing_ours|missing_theirs
    varianceMinor: integer("variance_minor").notNull().default(0),
    rawJson: text("raw_json"), // the inbound row, verbatim
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_bordereau_lines_line_uq").on(t.tenantId, t.bordereauId, t.lineNo),
    index("axis_bordereau_lines_bordereau_idx").on(t.tenantId, t.bordereauId, t.matchState)
  ]
);

/** A regulated complaint (§A.1, §D.8). `dueAt` is the regulatory clock, not an SLA. */
export const complaints = sqliteTable(
  "axis_complaints",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    ref: text("ref").notNull(),
    customerId: text("customer_id"),
    policyId: text("policy_id"),
    claimId: text("claim_id"),
    caseId: text("case_id"),
    channel: text("channel").notNull(), // web|phone|email|whatsapp|regulator|social
    categoryCode: text("category_code").notNull(), // tenant taxonomy
    summarySealed: text("summary_sealed"), // sealFields — may contain PII
    receivedAt: integer("received_at").notNull(),
    acknowledgedAt: integer("acknowledged_at"),
    dueAt: integer("due_at").notNull(),
    resolvedAt: integer("resolved_at"),
    state: text("state").notNull().default("received"),
    // received|investigating|awaiting_customer|resolved|escalated|closed
    outcome: text("outcome"), // upheld|partly_upheld|not_upheld|withdrawn
    rootCauseCode: text("root_cause_code"),
    redressMinor: integer("redress_minor").notNull().default(0),
    currency: text("currency"),
    regulatorRef: text("regulator_ref"),
    ownerRef: text("owner_ref"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_complaints_ref_uq").on(t.tenantId, t.ref),
    index("axis_complaints_due_idx").on(t.tenantId, t.state, t.dueAt)
  ]
);

/** SIU investigation record — distinct from `claims.siuState`'s lightweight flag (§A.1, §D.8). */
export const siuReferrals = sqliteTable(
  "axis_siu_referrals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    claimId: text("claim_id").notNull(),
    policyId: text("policy_id"),
    score: integer("score").notNull(), // 0-100
    reasonsJson: text("reasons_json").notNull(), // [{ indicator, weight, evidenceRef }]
    aiAuditId: text("ai_audit_id"),
    source: text("source").notNull().default("model"), // model|handler|insurer|tip
    state: text("state").notNull().default("open"),
    // open|investigating|substantiated|unsubstantiated|closed
    assignedTo: text("assigned_to"),
    outcome: text("outcome"),
    savedMinor: integer("saved_minor").notNull().default(0), // leakage prevented
    currency: text("currency"),
    openedAt: integer("opened_at").notNull(),
    closedAt: integer("closed_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("axis_siu_claim_uq").on(t.tenantId, t.claimId),
    index("axis_siu_state_idx").on(t.tenantId, t.state, t.score)
  ]
);

/** Underwriting referral: a risk outside delegated authority (§A.4, §D.6). */
export const referrals = sqliteTable(
  "axis_referrals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    caseId: text("case_id"),
    policyId: text("policy_id"),
    quoteResponseId: text("quote_response_id"),
    kind: text("kind").notNull(), // authority_limit|eligibility|sanctions|manual
    triggerJson: text("trigger_json").notNull(), // which rule fired, with values
    valueMinor: integer("value_minor"),
    currency: text("currency"),
    state: text("state").notNull().default("open"), // open|accepted|declined|counter_offered|expired
    decidedBy: text("decided_by"),
    decisionNote: text("decision_note"),
    counterTermsJson: text("counter_terms_json"),
    approvalId: text("approval_id"),
    slaDueAt: integer("sla_due_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("axis_referrals_state_idx").on(t.tenantId, t.state, t.slaDueAt)]
);

/**
 * H6 — raw usage/sensor points against a contract (docs/16 `TimeseriesIngest`).
 *
 * `source` is the series key (`telematics:obd:km`), because the seam's point
 * shape carries a value and no metric name. The unique index is the dedup
 * guard: a replayed or overlapping batch that double-counts kilometres would
 * reprice the policy wrong and bill a customer for it.
 */
export const telemetryPoints = sqliteTable(
  "axis_telemetry_points",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(), // policy:<id>
    source: text("source").notNull(),
    at: integer("at").notNull(),
    value: real("value").notNull(),
    txnId: text("txn_id").notNull(),
    createdAt: integer("created_at").notNull()
  },
  // One index, not two: a second index on the identical columns is pure write
  // amplification on this feature's hottest insert path, and every read (dedup
  // lookup, window aggregate) is a prefix scan the unique index already serves.
  (t) => [uniqueIndex("axis_telem_point_uq").on(t.tenantId, t.subjectRef, t.source, t.at)]
);

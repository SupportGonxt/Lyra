import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// docs/12 — compliance operating surface. Consent and the hash-chained audit log
// live in core.ts; these are the regulated processes that must be provable:
// data-subject rights, disclosures, screening, retention, legal hold, evidence.

/** J-C4 / J-CO1. SLA-tracked; completeness is proven, not asserted. */
export const dsarRequests = sqliteTable(
  "compliance_dsar_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id"),
    subjectIdentifier: text("subject_identifier").notNull(),
    type: text("type").notNull(), // access|erasure|rectification|portability|objection|restriction
    channel: text("channel").notNull(), // portal|email|whatsapp|regulator
    verificationRef: text("verification_ref"),
    /** The subject's own words from the J-C4 portal intake — a rectification or
     * objection is unusable without them. PII: treat as the request body it is. */
    subjectNote: text("subject_note"),
    state: text("state").notNull().default("received"),
    // received|verifying|in_progress|awaiting_legal|fulfilled|refused|expired
    dueAt: integer("due_at").notNull(),
    fulfilledAt: integer("fulfilled_at"),
    refusalReason: text("refusal_reason"),
    bundleFileId: text("bundle_file_id"),
    completenessProofJson: text("completeness_proof_json"),
    handledBy: text("handled_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("compliance_dsar_idx").on(t.tenantId, t.state, t.dueAt)]
);

/** Per-table result of an erasure run: hard-deleted PII, tombstoned references. */
export const erasureLog = sqliteTable(
  "compliance_erasure_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    dsarId: text("dsar_id").notNull(),
    tableName: text("table_name").notNull(),
    rowsErased: integer("rows_erased").notNull().default(0),
    rowsTombstoned: integer("rows_tombstoned").notNull().default(0),
    retainedReason: text("retained_reason"), // e.g. statutory 7y financial record
    ts: integer("ts").notNull()
  },
  (t) => [index("compliance_erasure_idx").on(t.tenantId, t.dsarId)]
);

/** DISCLOSURE-PRESENT: snapshot of exactly what wording was shown, when. */
export const disclosures = sqliteTable(
  "compliance_disclosures",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    locale: text("locale").notNull().default("en"),
    subjectRef: text("subject_ref").notNull(),
    customerId: text("customer_id"),
    wordingHash: text("wording_hash").notNull(),
    wordingRef: text("wording_ref"),
    criteriaJson: text("criteria_json"), // ranking/eligibility criteria shown
    channel: text("channel").notNull(),
    acknowledgedAt: integer("acknowledged_at"),
    ts: integer("ts").notNull()
  },
  (t) => [index("compliance_disclosures_idx").on(t.tenantId, t.subjectRef, t.ts)]
);

/**
 * docs/17 SIG-013, ADR-0108: the tenant's own mandatory disclosure wording per
 * product line and locale — what `compliance_disclosures` above snapshots when
 * one is shown. The tenant's compliance team writes the text; the platform
 * never does (docs/12). `version` rises on every wording change, so a
 * presentation's `wordingRef` names exactly which wording a creative carried.
 * One active row per (product line, locale); retiring one and activating
 * another is how wording is replaced.
 */
export const disclosureWordings = sqliteTable(
  "compliance_disclosure_wordings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    productLine: text("product_line").notNull(),
    locale: text("locale").notNull().default("en"),
    key: text("key").notNull(),
    wording: text("wording").notNull(),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"), // active|retired
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("compliance_disclosure_wordings_active_uq")
      .on(t.tenantId, t.productLine, t.locale)
      .where(sql`status = 'active'`)
  ]
);

export const screenings = sqliteTable(
  "compliance_screenings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    kind: text("kind").notNull(), // sanctions|pep|adverse_media|fraud
    provider: text("provider").notNull(),
    queryHash: text("query_hash").notNull(),
    result: text("result").notNull(), // clear|hit|inconclusive
    hitsJson: text("hits_json"),
    dispositionedBy: text("dispositioned_by"),
    disposition: text("disposition"), // false_positive|confirmed|escalated
    blocked: integer("blocked", { mode: "boolean" }).notNull().default(false),
    caseRef: text("case_ref"),
    ts: integer("ts").notNull()
  },
  (t) => [index("compliance_screenings_idx").on(t.tenantId, t.result, t.ts)]
);

/** Retention runs driven by tenant policy_json (docs/03 §Retention). */
export const retentionRuns = sqliteTable(
  "compliance_retention_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    policyKey: text("policy_key").notNull(), // messages|files|ai_audit|consent
    tableName: text("table_name").notNull(),
    cutoffAt: integer("cutoff_at").notNull(),
    rowsAffected: integer("rows_affected").notNull().default(0),
    rowsHeld: integer("rows_held").notNull().default(0), // skipped due to legal hold
    state: text("state").notNull().default("running"), // running|done|failed
    error: text("error"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at")
  },
  (t) => [index("compliance_retention_idx").on(t.tenantId, t.policyKey, t.startedAt)]
);

/** A hold freezes deletion for its subject — retention and erasure both respect it. */
export const legalHolds = sqliteTable(
  "compliance_legal_holds",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    reason: text("reason").notNull(),
    authority: text("authority"),
    placedBy: text("placed_by").notNull(),
    releasedBy: text("released_by"),
    releasedAt: integer("released_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("compliance_holds_idx").on(t.tenantId, t.subjectRef, t.releasedAt)]
);

/** AUDIT-EXPORT: a signed evidence bundle with a hash manifest (J-CO1). */
export const evidenceBundles = sqliteTable(
  "compliance_evidence_bundles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    purpose: text("purpose").notNull(), // regulator|audit|dispute|internal
    scopeJson: text("scope_json").notNull(),
    manifestJson: text("manifest_json").notNull(), // per-file sha256
    bundleHash: text("bundle_hash").notNull(),
    fileId: text("file_id"),
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    state: text("state").notNull().default("building"), // building|ready|delivered|failed
    deliveredTo: text("delivered_to"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("compliance_evidence_idx").on(t.tenantId, t.state, t.createdAt)]
);

/** Operational incidents (J-A3) — including the platform-wide agent pause. */
export const incidents = sqliteTable(
  "compliance_incidents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull(), // outage|data|model|security|regulatory
    severity: text("severity").notNull().default("sev3"), // sev1..sev4
    title: text("title").notNull(),
    summary: text("summary"),
    affectedJson: text("affected_json"),
    agentsPaused: integer("agents_paused", { mode: "boolean" }).notNull().default(false),
    notifiableAt: integer("notifiable_at"), // regulator clock, when applicable
    notifiedAt: integer("notified_at"),
    state: text("state").notNull().default("open"), // open|mitigated|resolved|postmortem
    openedBy: text("opened_by").notNull(),
    resolvedAt: integer("resolved_at"),
    postmortemRef: text("postmortem_ref"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("compliance_incidents_idx").on(t.tenantId, t.state, t.severity)]
);

/** Which rulepack version was in force when a decision was made (H12). */
export const rulepackApplications = sqliteTable(
  "compliance_rulepack_applications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    rulepackId: text("rulepack_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    ruleKey: text("rule_key").notNull(),
    outcome: text("outcome").notNull(), // pass|fail|not_applicable
    detailJson: text("detail_json"),
    ts: integer("ts").notNull()
  },
  (t) => [index("compliance_rulepack_app_idx").on(t.tenantId, t.subjectRef, t.ts)]
);

/** Named policy thresholds (refund ceilings, dual-control floors) — versioned,
 *  because "what was the limit in March" is an audit question. */
export const policyThresholds = sqliteTable(
  "compliance_policy_thresholds",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    valueJson: text("value_json").notNull(),
    dualControl: integer("dual_control", { mode: "boolean" }).notNull().default(false),
    effectiveFrom: integer("effective_from").notNull(),
    effectiveTo: integer("effective_to"),
    setBy: text("set_by").notNull()
  },
  (t) => [uniqueIndex("compliance_thresholds_uq").on(t.tenantId, t.key, t.version)]
);

import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// docs/03 §NORTH — executive intelligence. Reads views + snapshots only,
// never module hot tables. north_metrics is the semantic layer: one definition
// of each metric, everywhere.

export const metrics = sqliteTable(
  "north_metrics",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    nameJson: text("name_json").notNull(),
    definitionSqlRef: text("definition_sql_ref").notNull(),
    unit: text("unit").notNull().default("count"), // count|money|percent|ratio|duration_ms
    currency: text("currency"),
    grain: text("grain").notNull().default("day"), // day|week|month
    owner: text("owner"),
    targetJson: text("target_json"),
    sensitivity: text("sensitivity").notNull().default("internal"), // public|internal|restricted
    direction: text("direction").notNull().default("up"), // up|down = good
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("north_metrics_key_uq").on(t.tenantId, t.key)]
);

export const snapshots = sqliteTable(
  "north_snapshots",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    metricKey: text("metric_key").notNull(),
    grain: text("grain").notNull(), // day|week|month
    period: text("period").notNull(), // YYYY-MM-DD | YYYY-Www | YYYY-MM
    dimsJson: text("dims_json"),
    dimsHash: text("dims_hash").notNull().default(""), // "" = grand total
    value: integer("value").notNull(), // minor units for money metrics
    ts: integer("ts").notNull(),
    // docs/19 §7 and §11.10 — a success fee may only be charged on a *verified*
    // metric. Verification is a second read of the same definition landing on
    // the same number, recorded by whoever stood behind it; docs/27 F21 found
    // SUCCESS-FEE posting against nothing at all. Null means "computed, not
    // attested", which is what every snapshotter run produces.
    verifiedAt: integer("verified_at"),
    verifiedBy: text("verified_by"),
    /** What the verification re-read: a recompute id, a statement, a signed-off pack. */
    verificationRef: text("verification_ref")
  },
  (t) => [
    index("north_snapshots_idx").on(t.tenantId, t.metricKey, t.grain, t.period),
    uniqueIndex("north_snapshots_uq").on(t.tenantId, t.metricKey, t.grain, t.period, t.dimsHash)
  ]
);

export const briefings = sqliteTable(
  "north_briefings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    audience: text("audience").notNull().default("exec"), // exec|board|investor
    locale: text("locale").notNull().default("en"),
    narrativeRef: text("narrative_ref"), // the briefing prose itself (see engines/narrator.ts)
    highlightsJson: text("highlights_json"),
    anomaliesJson: text("anomalies_json"),
    status: text("status").notNull().default("draft"), // draft|review|published
    generatedBy: text("generated_by").notNull().default("ai"),
    aiAuditId: text("ai_audit_id"),
    approvedBy: text("approved_by"),
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("north_briefings_uq").on(t.tenantId, t.date, t.audience, t.locale)]
);

export const anomalies = sqliteTable(
  "north_anomalies",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    metricKey: text("metric_key").notNull(),
    window: text("window").notNull(),
    magnitude: integer("magnitude").notNull(), // signed basis points vs expected
    expected: integer("expected"),
    actual: integer("actual"),
    driverAnalysisJson: text("driver_analysis_json"),
    state: text("state").notNull().default("new"), // new|explained|action_created|dismissed
    linkedActionRef: text("linked_action_ref"),
    explainedBy: text("explained_by"),
    detectedAt: integer("detected_at").notNull()
  },
  (t) => [index("north_anomalies_idx").on(t.tenantId, t.state, t.detectedAt)]
);

export const scenarios = sqliteTable(
  "north_scenarios",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    question: text("question").notNull(),
    assumptionsJson: text("assumptions_json").notNull(),
    modelRunRef: text("model_run_ref"),
    resultJson: text("result_json"),
    author: text("author").notNull(),
    sharedWithJson: text("shared_with_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("north_scenarios_tenant_idx").on(t.tenantId, t.createdAt)]
);

export const boardpacks = sqliteTable(
  "north_boardpacks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    period: text("period").notNull(),
    title: text("title").notNull(),
    sectionsJson: text("sections_json").notNull(),
    pdfFileId: text("pdf_file_id"),
    xlsxFileId: text("xlsx_file_id"),
    distributionLogJson: text("distribution_log_json"),
    status: text("status").notNull().default("draft"), // draft|review|final|distributed
    approvedBy: text("approved_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("north_boardpacks_tenant_idx").on(t.tenantId, t.period)]
);

export const alertRules = sqliteTable(
  "north_alert_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    metricKey: text("metric_key").notNull(),
    operator: text("operator").notNull(), // gt|gte|lt|lte|eq
    thresholdValue: integer("threshold_value").notNull(), // minor units for money metrics
    windowGrain: text("window_grain").notNull().default("day"), // day|week|month
    notifyChannelRef: text("notify_channel_ref"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("north_alert_rules_tenant_idx").on(t.tenantId, t.metricKey)]
);

export const decisions = sqliteTable(
  "north_decisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    title: text("title").notNull(),
    contextRef: text("context_ref"),
    optionsJson: text("options_json"),
    chosen: text("chosen"),
    owner: text("owner").notNull(),
    reviewAt: integer("review_at"),
    outcomeReviewJson: text("outcome_review_json"),
    status: text("status").notNull().default("open"), // open|reviewed|reversed
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("north_decisions_tenant_idx").on(t.tenantId, t.reviewAt)]
);

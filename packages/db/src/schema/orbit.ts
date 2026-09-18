import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

// docs/03 §ORBIT — customers, conversations, renewals, partners.

export const conversations = sqliteTable(
  "orbit_conversations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id"),
    channel: text("channel").notNull(), // whatsapp|web|voice|email|agent (H1 reserved)
    externalRef: text("external_ref"), // wa id, thread id
    connectorId: text("connector_id"), // orbit_channel_connectors.id (null for internally-raised conversations)
    doId: text("do_id"), // UserChannel Durable Object
    state: text("state").notNull().default("bot"), // bot|human|closed
    assigneeRef: text("assignee_ref"),
    teamId: text("team_id"),
    csat: integer("csat"),
    summary: text("summary"),
    lang: text("lang").notNull().default("en"),
    intent: text("intent"),
    sentiment: integer("sentiment"), // -100..100
    firstResponseMs: integer("first_response_ms"),
    lastMessageAt: integer("last_message_at"),
    closedAt: integer("closed_at"),
    // Routing/SLA (gap-orbit-design.md §1B). Lower priority number = more
    // urgent; 2 is the unrouted/default level, sweepRouting only ever moves
    // it down (toward 0) on an FRT breach, never up.
    priority: integer("priority").notNull().default(2),
    slaPolicyKey: text("sla_policy_key"),
    requireSkillsJson: text("require_skills_json"), // JSON string[]; null = no skill requirement
    queuedAt: integer("queued_at"),
    assignedAt: integer("assigned_at"),
    firstResponseDueAt: integer("first_response_due_at"),
    resolutionDueAt: integer("resolution_due_at"),
    frtBreachedAt: integer("frt_breached_at"),
    resolutionBreachedAt: integer("resolution_breached_at"),
    reopenCount: integer("reopen_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("orbit_conv_tenant_idx").on(t.tenantId, t.state, t.lastMessageAt),
    index("orbit_conv_customer_idx").on(t.tenantId, t.customerId),
    index("orbit_conv_assignee_idx").on(t.tenantId, t.assigneeRef, t.state),
    // The sweep's own read pattern: "give me this team's open queue, most
    // urgent and longest-waiting first."
    index("orbit_conv_queue_idx").on(t.tenantId, t.teamId, t.state, t.priority, t.queuedAt)
  ]
);

export const messages = sqliteTable(
  "orbit_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    role: text("role").notNull(), // customer|agent_ai|agent_human|system
    modality: text("modality").notNull().default("text"), // text|voice|image|doc (reserved)
    content: text("content").notNull(),
    attachmentsJson: text("attachments_json"),
    redactionsJson: text("redactions_json"),
    aiAuditId: text("ai_audit_id"), // links a drafted/sent AI turn to its audit row
    deliveryStatus: text("delivery_status"), // queued|sent|delivered|read|failed
    externalRef: text("external_ref"),
    ts: integer("ts").notNull()
  },
  (t) => [
    index("orbit_messages_conv_idx").on(t.tenantId, t.conversationId, t.ts),
    uniqueIndex("orbit_messages_ext_uq").on(t.tenantId, t.externalRef)
  ]
);

export const channelConnectors = sqliteTable(
  "orbit_channel_connectors",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    provider: text("provider").notNull(), // whatsapp-cloud-api|mailgun-email
    transport: text("transport").notNull(), // whatsapp|email|web|voice|agent
    label: text("label").notNull(),
    secretsJson: text("secrets_json").notNull(), // sealed via packages/core field-crypto (beforeWrite)
    configJson: text("config_json").notNull().default("{}"),
    status: text("status").notNull().default("active"), // active|disabled
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("orbit_channel_connectors_tenant_idx").on(t.tenantId)]
);

export const channelIdentities = sqliteTable(
  "orbit_channel_identities",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    connectorId: text("connector_id").notNull(),
    handle: text("handle").notNull(), // provider-side address: wa id, email
    customerId: text("customer_id").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("orbit_channel_identities_handle_uq").on(t.tenantId, t.connectorId, t.handle),
    index("orbit_channel_identities_customer_idx").on(t.customerId)
  ]
);

export const renewals = sqliteTable(
  "orbit_renewals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    policyRef: text("policy_ref").notNull(),
    customerId: text("customer_id").notNull(),
    expiryAt: integer("expiry_at").notNull(),
    churnScore: integer("churn_score"), // 0-100
    strategy: text("strategy").notNull().default("human"), // auto_requote|human|do_not_contact
    requotesJson: text("requotes_json"),
    state: text("state").notNull().default("scheduled"), // scheduled|offered|accepted|lost
    outcomeReason: text("outcome_reason"),
    ownerRef: text("owner_ref"),
    offeredAt: integer("offered_at"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("orbit_renewals_tenant_idx").on(t.tenantId, t.state, t.expiryAt),
    // Unique per term (policy + expiry), not per policy: a policy renews every
    // term and each term gets its own renewal row.
    uniqueIndex("orbit_renewals_policy_term_uq").on(t.tenantId, t.policyRef, t.expiryAt)
  ]
);

export const journeys = sqliteTable(
  "orbit_journeys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    version: integer("version").notNull().default(1),
    nameJson: text("name_json").notNull(),
    graphJson: text("graph_json").notNull(),
    status: text("status").notNull().default("draft"), // draft|active|paused|retired
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("orbit_journeys_uq").on(t.tenantId, t.key, t.version)]
);

/** A customer's position in a journey graph. */
export const journeyRuns = sqliteTable(
  "orbit_journey_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    journeyId: text("journey_id").notNull(),
    customerId: text("customer_id").notNull(),
    node: text("node").notNull(),
    state: text("state").notNull().default("running"), // running|waiting|done|halted
    contextJson: text("context_json"),
    nextAt: integer("next_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("orbit_journey_runs_due_idx").on(t.tenantId, t.state, t.nextAt),
    uniqueIndex("orbit_journey_runs_uq").on(t.tenantId, t.journeyId, t.customerId)
  ]
);

/**
 * A distribution partner. `status` is whether we are trading with them today;
 * `stage` is where they are in getting there. The two are separate because a
 * live partner can be paused for a billing dispute without losing the record
 * that their diligence and agreement are done — pausing must not mean
 * re-onboarding.
 *
 * The stage ladder is walked by the onboarding engine, never set by hand:
 * `prospect > applied > screening > diligence > agreement > integration >
 * sandbox > live`, with `suspended` and `terminated` reachable from any stage.
 */
export const partners = sqliteTable(
  "orbit_partners",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(), // telco|auto|superapp|bank
    apiKeyRef: text("api_key_ref"),
    revshareJson: text("revshare_json"),
    sandboxFlag: integer("sandbox_flag", { mode: "boolean" }).notNull().default(true),
    status: text("status").notNull().default("active"),
    contactJson: text("contact_json"),
    /** Where they are in onboarding. Advanced only by the engine. */
    stage: text("stage").notNull().default("prospect"),
    /** Who inside the tenant owns this relationship. */
    ownerRef: text("owner_ref"),
    /** Legal identity, so a payout is made to a named entity and not a nickname. */
    legalName: text("legal_name"),
    registrationNo: text("registration_no"),
    taxId: text("tax_id"),
    country: text("country"),
    /** Latest diligence: what was checked, by whom, and what came back. */
    screeningId: text("screening_id"), // -> compliance_screenings.id
    riskRating: text("risk_rating"), // low|medium|high
    /** The agreement version currently governing. */
    agreementId: text("agreement_id"), // -> dist_partner_agreements.id
    /** Bank details are a reference into the payout provider, never held here. */
    payoutMethodRef: text("payout_method_ref"),
    goLiveAt: integer("go_live_at"),
    suspendedAt: integer("suspended_at"),
    suspendedReason: text("suspended_reason"),
    terminatedAt: integer("terminated_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("orbit_partners_tenant_idx").on(t.tenantId, t.status),
    index("orbit_partners_stage_idx").on(t.tenantId, t.stage),
    index("orbit_partners_owner_idx").on(t.tenantId, t.ownerRef)
  ]
);

export const partnerTxns = sqliteTable(
  "orbit_partner_txns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    partnerId: text("partner_id").notNull(),
    kind: text("kind").notNull(), // quote|bind|refund
    payloadHash: text("payload_hash").notNull(),
    amountMinor: integer("amount_minor").notNull().default(0),
    currency: text("currency").notNull(),
    revshareCalcMinor: integer("revshare_calc_minor").notNull().default(0),
    settlementBatch: text("settlement_batch"),
    txnRef: text("txn_ref"), // -> ledger txn
    ts: integer("ts").notNull()
  },
  (t) => [
    index("orbit_partner_txns_idx").on(t.tenantId, t.partnerId, t.ts),
    index("orbit_partner_txns_batch_idx").on(t.tenantId, t.settlementBatch)
  ]
);

export const handoverNotes = sqliteTable(
  "orbit_handover_notes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    fromRef: text("from_ref").notNull(),
    toRef: text("to_ref"),
    summary: text("summary").notNull(),
    factsJson: text("facts_json"),
    generatedBy: text("generated_by").notNull().default("ai"), // ai|human
    acceptedBy: text("accepted_by"),
    ts: integer("ts").notNull()
  },
  (t) => [index("orbit_handover_idx").on(t.tenantId, t.conversationId, t.ts)]
);

export const qaScores = sqliteTable(
  "orbit_qa_scores",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    rubricKey: text("rubric_key").notNull(),
    score: integer("score").notNull(), // 0-100
    breakdownJson: text("breakdown_json"),
    flagsJson: text("flags_json"),
    scoredBy: text("scored_by").notNull(), // actor ref: user:<id> | agent:<key>
    disputedBy: text("disputed_by"),
    ts: integer("ts").notNull()
  },
  (t) => [index("orbit_qa_idx").on(t.tenantId, t.conversationId, t.ts)]
);

/**
 * A routable unit of agents. `isDefault` marks the team new conversations
 * fall into when no routing rule matches — at most one per tenant, enforced
 * in `routeConversation`/application code, not the schema (SQLite has no
 * partial-unique-boolean shorthand worth reaching for here).
 */
export const teams = sqliteTable(
  "orbit_teams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    nameJson: text("name_json").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    status: text("status").notNull().default("active"), // active|disabled
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("orbit_teams_key_uq").on(t.tenantId, t.key)]
);

export const teamMembers = sqliteTable(
  "orbit_team_members",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id").notNull(),
    userId: text("user_id").notNull(),
    skillsJson: text("skills_json").notNull().default("[]"), // JSON string[]
    maxConcurrent: integer("max_concurrent").notNull().default(5),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("orbit_team_members_uq").on(t.tenantId, t.teamId, t.userId),
    index("orbit_team_members_user_idx").on(t.tenantId, t.userId)
  ]
);

/** One row per agent per tenant — an agent has one presence, regardless of how many teams they're on. */
export const agentPresence = sqliteTable(
  "orbit_agent_presence",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    status: text("status").$type<"available" | "away" | "offline">().notNull().default("offline"),
    activeCount: integer("active_count").notNull().default(0),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("orbit_agent_presence_uq").on(t.tenantId, t.userId)]
);

/**
 * First-matching-rule-wins, ordered by `seq` ascending. `conditionsJson` is
 * `{ channel?, intent?, sentimentBelow? }` — an omitted field is a wildcard.
 */
export const routingRules = sqliteTable(
  "orbit_routing_rules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    teamId: text("team_id").notNull(),
    seq: integer("seq").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    conditionsJson: text("conditions_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("orbit_routing_rules_seq_uq").on(t.tenantId, t.seq)]
);

export const slaPolicies = sqliteTable(
  "orbit_sla_policies",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    frtMinutes: integer("frt_minutes").notNull(),
    resolutionMinutes: integer("resolution_minutes").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("orbit_sla_policies_key_uq").on(t.tenantId, t.key)]
);

/**
 * A knowledge-base article: the answer the agent retrieves before it improvises
 * one, and the thing a deflection points a customer at (docs/modules/orbit.md
 * §5 "self-contained toolset", docs/27 F32).
 *
 * One row per (key, locale) rather than a `bodyJson` map, because retrieval is
 * per-language: an article is embedded and scored in the language it is written
 * in, and a `{en, ar}` blob would put both languages in one vector. `vectorId`
 * is the id it was upserted under in VEC_KB — null means it has never been
 * embedded, which is the normal state of a draft and of every row on a deploy
 * with no Vectorize index bound.
 */
export const kbArticles = sqliteTable(
  "orbit_kb_articles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    locale: text("locale").notNull().default("en"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"), // JSON string[]
    status: text("status").notNull().default("draft"), // draft|published|retired
    vectorId: text("vector_id"),
    updatedBy: text("updated_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("orbit_kb_articles_key_uq").on(t.tenantId, t.key, t.locale),
    index("orbit_kb_articles_status_idx").on(t.tenantId, t.status, t.locale)
  ]
);

/**
 * A canned reply. `bodyJson` is `{en, ar}` here and deliberately not one row
 * per locale like an article: a macro is picked by a human by name and then
 * rendered in the conversation's language, so both languages are read together
 * and neither is retrieved on its own.
 */
export const macros = sqliteTable(
  "orbit_macros",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    nameJson: text("name_json").notNull(),
    bodyJson: text("body_json").notNull(),
    category: text("category"),
    /** The article this macro is the short form of, if any. */
    articleId: text("article_id"),
    usageCount: integer("usage_count").notNull().default(0),
    status: text("status").notNull().default("active"), // active|disabled
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("orbit_macros_key_uq").on(t.tenantId, t.key)]
);

/**
 * One row per attempt to answer a customer from the knowledge base, whether it
 * worked or not. The `escalated` rows are the point: containment % (§7) is a
 * ratio, and a log that only kept the wins would report 100% forever.
 */
export const deflections = sqliteTable(
  "orbit_deflections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    question: text("question").notNull(),
    articleId: text("article_id"),
    score: integer("score").notNull(), // 0-100
    outcome: text("outcome").notNull(), // deflected|escalated
    /** How the article was found: `vector` (VEC_KB) or `lexical` (the fallback). */
    via: text("via").notNull().default("lexical"),
    ts: integer("ts").notNull()
  },
  (t) => [
    index("orbit_deflections_tenant_idx").on(t.tenantId, t.ts),
    index("orbit_deflections_conversation_idx").on(t.tenantId, t.conversationId)
  ]
);

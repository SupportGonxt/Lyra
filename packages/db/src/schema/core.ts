import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

// docs/03 §Core. Conventions: ULID text PK · tenant_id on every table ·
// created_at/updated_at epoch ms · soft delete via deleted_at · JSON columns are
// TEXT validated by the zod shapes in ../json.ts · composite index (tenant_id, hot key).

export const tenants = sqliteTable("core_tenants", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("standard"),
  region: text("region").notNull().default("auto"),
  dbBinding: text("db_binding"),
  status: text("status").notNull().default("active"), // active|suspended|closed
  brandJson: text("brand_json"),
  policyJson: text("policy_json"),
  entitlementsJson: text("entitlements_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

export const users = sqliteTable(
  "core_users",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    email: text("email").notNull(),
    phone: text("phone"),
    name: text("name").notNull(),
    locale: text("locale").notNull().default("en"),
    status: text("status").notNull().default("invited"), // invited|active|suspended
    authProvider: text("auth_provider").notNull().default("password"), // password|oidc|saml
    passwordHash: text("password_hash"),
    mfaEnrolled: integer("mfa_enrolled", { mode: "boolean" }).notNull().default(false),
    mfaSecret: text("mfa_secret"),
    // Hashed single-use recovery codes, so a lost phone is not a support ticket.
    mfaRecoveryJson: text("mfa_recovery_json"),
    // Subject claim from the identity provider that owns this account. Matching
    // on email alone would let a renamed mailbox inherit a session.
    externalId: text("external_id"),
    // Set only for provider-side staff (ROLE-028): scopes provider.viewer's
    // reads to this provider's own rows. See ADR-0025.
    providerId: text("provider_id").references(() => providers.id),
    lastSeenAt: integer("last_seen_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [
    // Partial: a soft-deleted user must not block re-inviting the same email.
    uniqueIndex("core_users_tenant_email_uq")
      .on(t.tenantId, t.email)
      .where(sql`deleted_at IS NULL`)
  ]
);

export const sessions = sqliteTable(
  "core_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    ip: text("ip"),
    ua: text("ua"),
    mfaSatisfied: integer("mfa_satisfied", { mode: "boolean" }).notNull().default(false),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at")
  },
  (t) => [
    index("core_sessions_tenant_idx").on(t.tenantId, t.userId),
    uniqueIndex("core_sessions_token_uq").on(t.tokenHash)
  ]
);

export const roles = sqliteTable(
  "core_roles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(), // docs/06 §1
    name: text("name").notNull(),
    permissionsJson: text("permissions_json").notNull(),
    system: integer("system", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("core_roles_tenant_idx").on(t.tenantId, t.key),
    uniqueIndex("core_roles_tenant_key_uq").on(t.tenantId, t.key)
  ]
);

export const userRoles = sqliteTable(
  "core_user_roles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    roleId: text("role_id").notNull(),
    scopeJson: text("scope_json"), // ABAC overlay: team, module, product line
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("core_user_roles_tenant_idx").on(t.tenantId, t.userId),
    uniqueIndex("core_user_roles_uq").on(t.tenantId, t.userId, t.roleId)
  ]
);

export const teams = sqliteTable(
  "core_teams",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    moduleScope: text("module_scope"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_teams_tenant_idx").on(t.tenantId, t.name)]
);

/** The 360 spine. ORBIT owns writes; every module reads. */
export const customers = sqliteTable(
  "core_customers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull().default("person"), // person|business
    nameJson: text("name_json").notNull(),
    emailsJson: text("emails_json"),
    phonesJson: text("phones_json"),
    nationalIdHash: text("national_id_hash"),
    /**
     * Legal identity for a `business` customer, mirroring orbit_partners' own
     * three columns for the same reason: a company that registers is a named
     * entity, and KYB has nothing to check if the trading name is all we kept.
     * Null for a person.
     */
    registrationNo: text("registration_no"),
    taxId: text("tax_id"),
    country: text("country"),
    kycStatus: text("kyc_status").notNull().default("none"), // none|pending|verified|failed
    consentId: text("consent_id"),
    tagsJson: text("tags_json"),
    ltvCached: integer("ltv_cached"),
    riskFlagsJson: text("risk_flags_json"),
    locale: text("locale").notNull().default("en"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [
    index("core_customers_tenant_idx").on(t.tenantId, t.updatedAt),
    index("core_customers_natid_idx").on(t.tenantId, t.nationalIdHash)
  ]
);

/** Immutable rows; the current consent is the latest row per purpose. */
export const consents = sqliteTable(
  "core_consents",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    customerId: text("customer_id").notNull(),
    purposesJson: text("purposes_json").notNull(),
    channelOptinsJson: text("channel_optins_json").notNull(),
    source: text("source").notNull(), // web|whatsapp|import|agent|portal
    evidenceRef: text("evidence_ref"),
    ts: integer("ts").notNull(),
    expiry: integer("expiry"),
    version: integer("version").notNull().default(1)
  },
  (t) => [index("core_consents_tenant_idx").on(t.tenantId, t.customerId, t.ts)]
);

export const products = sqliteTable(
  "core_products",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    line: text("line").notNull(), // motor|health|travel|home|life|sme|card|loan|account
    nameJson: text("name_json").notNull(),
    providerId: text("provider_id"),
    termsRef: text("terms_ref"),
    status: text("status").notNull().default("active"),
    // Horizon seams (docs/16): reserved, sparsely used in v1.
    structure: text("structure").notNull().default("conventional"), // conventional|takaful|parametric
    takafulJson: text("takaful_json"),
    parametricTriggerJson: text("parametric_trigger_json"),
    standardMappingJson: text("standard_mapping_json"),
    pricingInputsJson: text("pricing_inputs_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("core_products_tenant_idx").on(t.tenantId, t.line)]
);

export const providers = sqliteTable(
  "core_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("insurer"), // insurer|bank|financier (H9)
    /** We are also an underwriter: this row is us. Its offerings carry no external commission. */
    isInternal: integer("is_internal", { mode: "boolean" }).notNull().default(false),
    linesJson: text("lines_json"),
    integrationJson: text("integration_json"), // api|portal|email
    commissionJson: text("commission_json"),
    /** {frequency, netDays, dayOfMonth} — when they pay us commission. */
    settlementTermsJson: text("settlement_terms_json"),
    currency: text("currency"),
    /** Quote fan-out endpoint config; secrets are wrangler/env refs, never values. */
    quoteEndpointJson: text("quote_endpoint_json"),
    panelStatus: text("panel_status").notNull().default("active"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [index("core_providers_tenant_idx").on(t.tenantId, t.panelStatus)]
);

export const files = sqliteTable(
  "core_files",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    r2Key: text("r2_key").notNull(),
    kind: text("kind").notNull(),
    subjectRef: text("subject_ref"),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes"),
    contentType: text("content_type"),
    piiLevel: text("pii_level").notNull().default("none"), // none|low|high
    createdAt: integer("created_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [index("core_files_tenant_idx").on(t.tenantId, t.subjectRef)]
);

/** Append-only. Hash-chained per tenant: each row's chain_hash covers the prior. */
export const auditLog = sqliteTable(
  "core_audit_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    actorRef: text("actor_ref").notNull(),
    action: text("action").notNull(),
    subjectRef: text("subject_ref"),
    beforeHash: text("before_hash"),
    afterHash: text("after_hash"),
    prevHash: text("prev_hash"),
    chainHash: text("chain_hash").notNull(),
    ip: text("ip"),
    ua: text("ua"),
    ts: integer("ts").notNull()
  },
  (t) => [index("core_audit_tenant_idx").on(t.tenantId, t.ts)]
);

/** Append-only, exportable, 7y retention. Every model-gateway call lands here. */
export const aiAuditLog = sqliteTable(
  "ai_audit_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    module: text("module").notNull(),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    provider: text("provider").notNull(),
    tier: text("tier").notNull(), // fast|standard|reasoning
    inputHash: text("input_hash").notNull(),
    outputHash: text("output_hash"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    costMicro: integer("cost_micro").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    toolCallsJson: text("tool_calls_json"),
    guardrailFlagsJson: text("guardrail_flags_json"),
    actorRef: text("actor_ref").notNull(),
    subjectRef: text("subject_ref"),
    outcome: text("outcome").notNull().default("ok"), // ok|refused|error|budget_exceeded|killed
    ts: integer("ts").notNull()
  },
  (t) => [
    index("ai_audit_tenant_idx").on(t.tenantId, t.ts),
    index("ai_audit_module_idx").on(t.tenantId, t.module, t.ts)
  ]
);

/** Idempotency for inbound events (dedupe) — docs/04 §7. */
export const eventInbox = sqliteTable(
  "core_event_inbox",
  {
    id: text("id").notNull(), // the event envelope id
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    consumer: text("consumer").notNull(),
    processedAt: integer("processed_at").notNull(),
    attempts: integer("attempts").notNull().default(1),
    status: text("status").notNull().default("done") // done|failed|dead
  },
  (t) => [
    // One row per (event, consumer): every consumer processes an event once.
    primaryKey({ columns: [t.id, t.consumer] }),
    index("core_event_inbox_tenant_idx").on(t.tenantId, t.processedAt)
  ]
);

/** Transactional outbox: written in the same txn as the state change, drained to the queue. */
export const eventOutbox = sqliteTable(
  "core_event_outbox",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    module: text("module").notNull(),
    type: text("type").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    publishedAt: integer("published_at"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("core_event_outbox_pending_idx").on(t.tenantId, t.publishedAt, t.createdAt),
    // The drain (packages/core/src/events.ts) scans all tenants: published_at IS
    // NULL ORDER BY created_at. The tenant-leading index above cannot serve it.
    index("core_event_outbox_drain_idx")
      .on(t.createdAt)
      .where(sql`published_at IS NULL`)
  ]
);

/** Dead-letter queue with replay from the admin console (docs/09). */
export const eventDlq = sqliteTable(
  "core_event_dlq",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    consumer: text("consumer").notNull(),
    envelopeJson: text("envelope_json").notNull(),
    error: text("error").notNull(),
    attempts: integer("attempts").notNull(),
    replayedAt: integer("replayed_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_event_dlq_tenant_idx").on(t.tenantId, t.createdAt)]
);

export const apiKeys = sqliteTable(
  "core_api_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(), // qvk_live_ / qvk_test_ + 8 chars, for lookup
    keyHash: text("key_hash").notNull(),
    mode: text("mode").notNull().default("test"), // test|live
    scopesJson: text("scopes_json").notNull(),
    createdBy: text("created_by").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("core_api_keys_tenant_idx").on(t.tenantId, t.mode),
    uniqueIndex("core_api_keys_prefix_uq").on(t.prefix)
  ]
);

/**
 * docs/04 §2. One row per enterprise sign-in route. `kind` is the seam: OIDC is
 * implemented, SAML sits behind the same shape so adding it is a handler and
 * not a schema change (CLAUDE.md §15).
 *
 * No client secret is stored. `clientSecretRef` names the wrangler secret /
 * environment variable that holds it, so a database dump is not a set of
 * working credentials.
 */
export const identityProviders = sqliteTable(
  "core_identity_providers",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    kind: text("kind").notNull().default("oidc"), // oidc|saml
    name: text("name").notNull(),
    /** Email domain this provider owns, lower case, no `@`. Drives discovery. */
    emailDomain: text("email_domain").notNull(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id"),
    clientSecretRef: text("client_secret_ref"),
    discoveryUrl: text("discovery_url"),
    authorizeUrl: text("authorize_url"),
    tokenUrl: text("token_url"),
    jwksUrl: text("jwks_url"),
    /** SAML only: IdP SSO URL and the base64 signing certificate. */
    ssoUrl: text("sso_url"),
    certificate: text("certificate"),
    /** Role granted to an account created on first sign-in. */
    defaultRoleKey: text("default_role_key"),
    /** Off by default: a half-configured provider must not shadow the password form. */
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    /** PLAT-013 rides on the provider too: an IdP without MFA cannot cover staff. */
    mfaAsserted: integer("mfa_asserted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    index("core_identity_providers_tenant_idx").on(t.tenantId, t.enabled),
    uniqueIndex("core_identity_providers_domain_uq").on(t.tenantId, t.emailDomain)
  ]
);

export const webhooks = sqliteTable(
  "core_webhooks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    url: text("url").notNull(),
    eventTypesJson: text("event_types_json").notNull(),
    secret: text("secret").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_webhooks_tenant_idx").on(t.tenantId, t.status)]
);

export const webhookDeliveries = sqliteTable(
  "core_webhook_deliveries",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    webhookId: text("webhook_id").notNull(),
    eventId: text("event_id").notNull(),
    status: text("status").notNull(), // pending|delivered|failed|dead
    responseCode: integer("response_code"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    error: text("error"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_webhook_deliveries_idx").on(t.tenantId, t.webhookId, t.createdAt)]
);

export const notifications = sqliteTable(
  "core_notifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    titleKey: text("title_key").notNull(), // i18n key, never a literal string
    paramsJson: text("params_json"),
    subjectRef: text("subject_ref"),
    readAt: integer("read_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_notifications_user_idx").on(t.tenantId, t.userId, t.createdAt)]
);

/** Shared approval engine (CLAUDE.md rule 4). AXIS is the heaviest user. */
export const approvals = sqliteTable(
  "core_approvals",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    policyKey: text("policy_key").notNull(),
    module: text("module").notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: integer("requested_at").notNull(),
    decidedBy: text("decided_by"),
    decision: text("decision").notNull().default("pending"), // pending|approved|rejected
    reason: text("reason"),
    contextJson: text("context_json"),
    decidedAt: integer("decided_at"),
    /**
     * Set when the decider held no deciding permission of their own and acted
     * under a delegation (docs/06 §4). The audit trail has to say whose
     * authority was spent, not just who clicked.
     */
    delegationId: text("delegation_id")
  },
  (t) => [
    index("core_approvals_tenant_idx").on(t.tenantId, t.decision, t.requestedAt),
    index("core_approvals_subject_idx").on(t.tenantId, t.subjectRef)
  ]
);

/* --------------------------------------------- horizon-reserved (docs/16) */

/** H1 agentic commerce: delegated authority an agent acts under. */
export const mandates = sqliteTable(
  "core_mandates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    principalRef: text("principal_ref").notNull(),
    agentIdentity: text("agent_identity").notNull(),
    scopeJson: text("scope_json").notNull(),
    spendCapMinor: integer("spend_cap_minor"),
    currency: text("currency"),
    verificationRef: text("verification_ref"),
    expiry: integer("expiry"),
    status: text("status").notNull().default("active"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_mandates_tenant_idx").on(t.tenantId, t.principalRef)]
);

/** H5 digital identity. */
export const identityVerifications = sqliteTable(
  "core_identity_verifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    method: text("method").notNull(),
    evidenceLevel: text("evidence_level").notNull(),
    providerRef: text("provider_ref"),
    expiry: integer("expiry"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_identity_verifications_idx").on(t.tenantId, t.subjectRef)]
);

/** H11 compounding intelligence. Purpose-bound reads; erasure-linked. */
export const memories = sqliteTable(
  "core_memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    kind: text("kind").notNull(),
    contentJson: text("content_json").notNull(),
    provenance: text("provenance").notNull(),
    sensitivity: text("sensitivity").notNull().default("low"),
    purposesJson: text("purposes_json"),
    expiry: integer("expiry"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_memories_idx").on(t.tenantId, t.subjectRef, t.kind)]
);

/**
 * H11, ADR-0085: one markdown note per record, written by people. `subjectRef`
 * is the canonical `<kind>:<id>` the API derives from the record's own id
 * prefix, so every spelling of a ref reaches the same note. `version` is the
 * optimistic-concurrency counter a save must name. Erased with its subject
 * (docs/12 §3) along with every link to or from it.
 */
export const notes = sqliteTable(
  "core_notes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectRef: text("subject_ref").notNull(),
    bodyMd: text("body_md").notNull(),
    authorRef: text("author_ref").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("core_notes_subject_uq").on(t.tenantId, t.subjectRef)]
);

/**
 * Derived, never written by hand: the `[[wikilinks]]` of one note, rebuilt from
 * its body on every save. `fromRef` is the note's subject, `toRef` the linked
 * record's canonical ref. Backlinks read `toRef`; the graph walks both.
 */
export const links = sqliteTable(
  "core_links",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    noteId: text("note_id").notNull(),
    fromRef: text("from_ref").notNull(),
    toRef: text("to_ref").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    uniqueIndex("core_links_note_to_uq").on(t.tenantId, t.noteId, t.toRef),
    index("core_links_to_idx").on(t.tenantId, t.toRef),
    index("core_links_from_idx").on(t.tenantId, t.fromRef)
  ]
);

/** docs/15 §5 lens engine: role default workspace + learned personal adaptation. */
export const lenses = sqliteTable(
  "core_lenses",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    lensJson: text("lens_json").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("core_lenses_user_uq").on(t.tenantId, t.userId)]
);

/** H12 regulation-as-data. */
export const rulepacks = sqliteTable(
  "core_rulepacks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    market: text("market").notNull(),
    version: text("version").notNull(),
    effectiveAt: integer("effective_at").notNull(),
    rulesJson: text("rules_json").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [index("core_rulepacks_idx").on(t.tenantId, t.market, t.effectiveAt)]
);

/** Idempotency-Key ledger for POSTs (docs/04 §1, honoured 24h). */
export const idempotencyKeys = sqliteTable(
  "core_idempotency_keys",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    responseJson: text("response_json"),
    status: text("status").notNull().default("in_flight"), // in_flight|done
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (t) => [uniqueIndex("core_idempotency_uq").on(t.tenantId, t.key, t.route)]
);

/**
 * One item on a checklist that gates something going live: a partner, a channel
 * or a member of staff. Deliberately one table for all three — an onboarding is
 * the same shape whichever subject it hangs off (a required thing, who owns it,
 * what proves it was done), and three near-identical tables would drift.
 *
 * Steps are generated from a template at start, so the set is auditable: nobody
 * can quietly go live by never creating the step they could not pass. Waiving a
 * required step is an approval, not a field edit.
 */
export const onboardingSteps = sqliteTable(
  "core_onboarding_steps",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    subjectKind: text("subject_kind").notNull(), // partner|channel|staff
    subjectRef: text("subject_ref").notNull(),
    /** Template that produced this run, kept so a later template change is visible. */
    template: text("template").notNull(),
    /** Stable slug: `kyc_screening`, `agreement_signed`, `contract_acknowledged`. */
    key: text("key").notNull(),
    labelJson: text("label_json").notNull(),
    /** Position in the checklist; the lowest incomplete step is what is blocking. */
    seq: integer("seq").notNull(),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    /** Which stage this step must clear before the subject may leave. */
    gatesStage: text("gates_stage").notNull(),
    state: text("state").notNull().default("pending"), // pending|in_progress|done|waived|failed
    /** What proves it: a file id, a screening id, an agreement id, a consent id. */
    evidenceKind: text("evidence_kind"), // file|screening|agreement|consent|verification|attestation
    evidenceRef: text("evidence_ref"),
    ownerRef: text("owner_ref"), // core_users.id who must action it
    dueAt: integer("due_at"),
    notesJson: text("notes_json"),
    /** Set only when `state = waived`; points at the approval that allowed it. */
    waivedApprovalId: text("waived_approval_id"),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [
    uniqueIndex("core_onboarding_steps_uq").on(t.tenantId, t.subjectKind, t.subjectRef, t.key),
    index("core_onboarding_steps_subject_idx").on(t.tenantId, t.subjectKind, t.subjectRef, t.seq),
    index("core_onboarding_steps_owner_idx").on(t.tenantId, t.ownerRef, t.state)
  ]
);

/**
 * "While I am away, my approvals go to them." An approval queue that nobody can
 * clear is an outage in a system where every consequential action pauses for a
 * human — but a delegation is itself consequential, so it is scoped, dated,
 * capped and audited rather than being a profile setting.
 *
 * `scopeJson` narrows what may be delegated: `{policyKeys: [...]}` or
 * `{modules: [...]}`. Absent = everything the delegator can decide. The
 * delegate never gains a permission the delegator does not hold.
 */
export const delegations = sqliteTable(
  "core_delegations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    fromUserId: text("from_user_id").notNull(),
    toUserId: text("to_user_id").notNull(),
    reason: text("reason").notNull(), // leave|travel|cover|offboarding
    scopeJson: text("scope_json"),
    /** Ceiling on any single approval taken under this delegation. */
    maxAmountMinor: integer("max_amount_minor"),
    currency: text("currency"),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    status: text("status").notNull().default("active"), // active|revoked|expired
    createdBy: text("created_by").notNull(),
    revokedBy: text("revoked_by"),
    revokedAt: integer("revoked_at"),
    createdAt: integer("created_at").notNull()
  },
  (t) => [
    index("core_delegations_to_idx").on(t.tenantId, t.toUserId, t.status, t.endsAt),
    index("core_delegations_from_idx").on(t.tenantId, t.fromUserId, t.status)
  ]
);

/**
 * ADR-0028: the one deliberate exception to "every table has tenant_id" — a
 * flag gates a capability for tenants that haven't signed up yet, so it can't
 * be scoped to one. `enabled: false` is a hard kill regardless of percent or
 * allow-list; `targetTenantIdsJson` (non-empty) overrides `rolloutPercent`.
 * Evaluated by the pure `flagEnabled()` in packages/core/src/flags.ts, never
 * queried ad hoc.
 */
export const featureFlags = sqliteTable("core_feature_flags", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  description: text("description").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  rolloutPercent: integer("rollout_percent").notNull().default(0),
  targetTenantIdsJson: text("target_tenant_ids_json"),
  updatedBy: text("updated_by").notNull(),
  updatedAt: integer("updated_at").notNull()
});

/**
 * ADR-0027: a time-boxed session swap, not a new authority. `tenantId` is the
 * *target* tenant being entered (so this table needs no GLOBAL_TABLES
 * exemption, unlike the two below) — a platform user's own grants never
 * change, only which tenant their Ctx resolves to. No renewal: past
 * `expiresAt` without an `/end` call, the session token 401s (auth.ts).
 */
export const impersonationSessions = sqliteTable(
  "core_impersonation_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    platformUserId: text("platform_user_id").notNull(),
    targetUserId: text("target_user_id").notNull(),
    approvalId: text("approval_id").notNull(),
    reason: text("reason").notNull(),
    startedAt: integer("started_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    endedAt: integer("ended_at")
  },
  (t) => [
    index("core_impersonation_sessions_platform_idx").on(t.platformUserId, t.startedAt),
    index("core_impersonation_sessions_tenant_idx").on(t.tenantId, t.startedAt)
  ]
);

/**
 * ADR-0029: platform-global like `core_feature_flags` above — an SLO targets
 * a whole module across every tenant, not one tenant's slice of it. Burn is
 * computed live on read (per-tenant-loop over each module's own tables), never
 * stored here.
 */
export const sloDefinitions = sqliteTable("core_slo_definitions", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  description: text("description").notNull(),
  module: text("module").notNull(), // events|webhooks|ai
  targetPercent: integer("target_percent").notNull(),
  windowDays: integer("window_days").notNull().default(30),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
});

/**
 * ADR-0029: platform-global — a deploy belongs to a Worker/environment, not a
 * tenant. Written by the CI deploy step; the API route is read-only.
 */
export const deployments = sqliteTable(
  "core_deployments",
  {
    id: text("id").primaryKey(),
    environment: text("environment").notNull(), // staging|production
    workerName: text("worker_name").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("success"), // success|failed
    deployedBy: text("deployed_by").notNull(),
    deployedAt: integer("deployed_at").notNull()
  },
  (t) => [index("core_deployments_env_idx").on(t.environment, t.deployedAt)]
);

/** docs/24 Phase 2 item 11: an outbound message's per-channel copy, keyed for reuse across modules (dist reminders, orbit handover, signal campaigns). */
export const messageTemplates = sqliteTable(
  "core_message_templates",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    key: text("key").notNull(), // e.g. "dist.renewal_reminder", "signal.campaign_intro"
    channel: text("channel").notNull(), // email|sms|whatsapp|push
    subjectJson: text("subject_json"), // {en, ar, ...} — absent for channels with no subject line
    bodyJson: text("body_json").notNull(), // {en, ar, ...}
    variablesJson: text("variables_json"), // string[] of {{placeholders}} the body references
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at")
  },
  (t) => [uniqueIndex("core_message_templates_key_idx").on(t.tenantId, t.key, t.channel)]
);

/** docs/24 Phase 2 item 12: a per-tenant override layered over the static i18n.ts CATALOGUES at request time. */
export const localeOverrides = sqliteTable(
  "core_locale_overrides",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    locale: text("locale").notNull(), // en|ar
    key: text("key").notNull(), // i18n catalogue key
    value: text("value").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (t) => [uniqueIndex("core_locale_overrides_key_idx").on(t.tenantId, t.locale, t.key)]
);

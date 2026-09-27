# 03 — Data Model (Drizzle, SQLite dialect — D1 cloud / libSQL on-prem)

Conventions: `id` TEXT ulid PK · `tenant_id` TEXT NOT NULL on every table ·
`created_at`/`updated_at` INTEGER (epoch ms) · soft delete via `deleted_at` ·
JSON columns are TEXT with zod-validated shapes in packages/db/src/json.ts ·
all FKs indexed · composite index `(tenant_id, <hot key>)` on every table.

## Core (`core_`)

- `core_tenants` — id, slug, name, plan, region, db_binding, status,
  brand_json, policy_json (auto_approve[], ai_budget, locales[], data_residency),
  entitlements_json, created_at.
- `core_users` — id, tenant_id, email, phone, name, locale, status,
  auth_provider, mfa_enrolled, last_seen_at.
- `core_roles` — id, tenant_id, key (see docs/06 §1), name, permissions_json.
- `core_user_roles` — user_id, role_id, scope_json (e.g. team, module).
- `core_teams` — id, tenant_id, name, module_scope.
- `core_customers` — id, tenant_id, type (person|business), name_json (en/ar),
  emails_json, phones_json, national_id_hash, kyc_status, consent_id, tags_json,
  ltv_cached, risk_flags_json. (The 360 spine; ORBIT owns writes, all read.)
- `core_consents` — id, tenant_id, customer_id, purposes_json (marketing,
  profiling, data_sharing, cross_border), channel_optins_json, source, ts,
  expiry, version. Immutable rows; current = latest per purpose.
- `core_products` — id, tenant_id, line (motor|health|travel|home|life|sme|
  card|loan|account), name_json, provider_id, terms_ref (R2 key), status.
- `core_providers` — insurer/bank partners: id, tenant_id, name, lines_json,
  integration_json (api|portal|email), commission_json, panel_status.
- `core_files` — id, tenant_id, r2_key, kind, subject_ref, sha256, pii_level.
- `core_audit_log` — id, tenant_id, actor_ref, action, subject_ref, before_hash,
  after_hash, ip, ua, ts. Append-only. (Separate from ai_audit_log.)
- `core_event_inbox` / `core_event_outbox` — idempotency + reliable publish.
- `core_api_keys`, `core_webhooks`, `core_webhook_deliveries` (see docs/04).
- `core_notifications` — in-app inbox items per user.
- `ai_audit_log` — id, tenant_id, module, purpose, model, provider, tier,
  input_hash, output_hash, tokens_in/out, cost_micro, latency_ms, tool_calls_json,
  guardrail_flags_json, actor_ref, subject_ref, ts. Append-only, exportable.

## AXIS (`axis_`) — operations

- `axis_cases` — the unit of work: id, tenant_id, kind (quote|bind|endorse|
  renewal_ops|group_medical|kyc), customer_id, product_line, status (intake|
  quoting|awaiting_docs|review|approval|issued|failed), sla_due_at, owner_ref
  (user|agent), priority, source (web|orbit|partner|import).
- `axis_quotes` — case_id, provider_id, premium, currency, coverage_json,
  validity, win_flag, decline_reason.
- `axis_documents` — case_id, file_id, doc_type (eid|mulkiya|census|medical|
  tradelicense|other), extraction_json, extraction_confidence, verified_by.
- `axis_tasks` — case_id, type, assignee_ref, state, due_at, checklist_json.
- `axis_approvals` — subject_ref, policy_key, requested_by, decided_by,
  decision, reason, ts. (Shared approval engine lives in core; AXIS heaviest user.)
- `axis_policies` — issued policies: case_id, provider_id, policy_no, start/end,
  premium, commission, docs_json, escrow_batch_id.
- `axis_escrow_batches` — reconciliation support: period, provider_id,
  expected/received, status, evidence_file_id.
- `axis_sops` — versioned SOP definitions (JSON steps) powering copilots.
- `axis_process_events` — normalized step events for process mining.

## ORBIT (`orbit_`) — customers & partners

- `orbit_conversations` — id, tenant_id, customer_id, channel (whatsapp|web|
  voice|email), do_id (DurableObject), state (bot|human|closed), assignee_ref,
  csat, summary, lang.
- `orbit_messages` — conversation_id, role (customer|agent_ai|agent_human|system),
  content, attachments_json, ts, redactions_json.
- `orbit_renewals` — policy_ref, customer_id, expiry_at, churn_score,
  strategy (auto_requote|human|do_not_contact), requotes_json, state
  (scheduled|offered|accepted|lost), outcome_reason.
- `orbit_journeys` — configurable journey definitions (JSON graph) + versions.
- `orbit_partners` — embedded partners: id, name, kind (telco|auto|superapp|bank),
  api_key_ref, revshare_json, sandbox_flag, status.
- `orbit_partner_txns` — partner_id, kind (quote|bind), payload_hash, amount,
  revshare_calc, settlement_batch.
- `orbit_handover_notes`, `orbit_qa_scores` (AI QA of conversations).

## SIGNAL (`signal_`) — marketing

- `signal_campaigns` — id, objective (acq|renewal|xsell), audience_id, channels,
  budget_json, state, guardrail_checks_json.
- `signal_audiences` — definition_json (rule tree over spine + consent-aware),
  size_cached, refresh_policy.
- `signal_creatives` — campaign_id, kind (ad|lp|email|social|video_script),
  locale, content_ref, variant_group, compliance_status, performance_json.
- `signal_experiments` — hypothesis, variants_json, metric, state, result_json.
- `signal_budget_moves` — automated reallocations: ts, from/to, amount, reason,
  approved_by (auto|user).
- `signal_aeo_pages` — structured answer-engine content units: query_cluster,
  content_ref, citations_check_json, freshness.
- `signal_attribution_events` — normalized touch events → bind attribution.

## SCOUT (`scout_`) — product intelligence

- `scout_signals` — ingested market observations: source (search|quotes|
  abandonment|reviews|news|regulatory), payload_json, embedding_ref, cluster_id.
- `scout_clusters` — theme, momentum_score, size, first/last_seen.
- `scout_whitespaces` — candidate gaps: description, evidence_refs_json,
  demand_estimate, competition_score, status (candidate|validating|validated|
  parked), owner.
- `scout_panel_bench` — provider_id, line, our_price_idx, market_price_idx,
  win_rate, coverage_gaps_json, period.
- `scout_experiments` — whitespace_id, landing_ref, traffic_plan, results_json.
- `scout_data_products` — packaged insight products for providers: definition,
  consent_basis, subscribers_json, delivery (api|report).

## NORTH (`north_`) — executive intelligence

- `north_metrics` — registry: key, name_json, definition_sql_ref, owner,
  target_json, sensitivity. (Semantic layer — single source of metric truth.)
- `north_snapshots` — metric_key, grain (day|week), dims_json, value, ts.
- `north_briefings` — date, audience (exec|board|investor), narrative_ref (R2),
  highlights_json, anomalies_json, status, generated_by, approved_by.
- `north_anomalies` — metric_key, window, magnitude, driver_analysis_json,
  state (new|explained|action_created), linked_action_ref.
- `north_scenarios` — question, assumptions_json, model_run_ref, result_json,
  author, shared_with.
- `north_boardpacks` — period, sections_json, pdf_file_id, distribution_log.
- `north_decisions` — decision log: title, context_ref, options_json, chosen,
  owner, review_at, outcome_review_json.

## Horizon-reserved structures (docs/16 — created in v1, sparsely used)

- `core_mandates` (H1) — delegated agent authority: principal_ref, agent_identity,
  scope_json, spend_cap, verification_ref, expiry, status.
- `core_identity_verifications` (H5) — subject_ref, method, evidence_level,
  provider_ref, expiry.
- `core_memories` (H11) — subject_ref, kind, content_json, provenance,
  sensitivity, expiry; purpose-bound reads; erasure-linked.
- `core_lenses` (docs/15 §5) — user workspace personalization state.
- `core_rulepacks` (H12) — market, version, effective_at, rules_json.
- Reserved enum values & fields: `channel='agent'`, `orbit_messages.modality`,
  `core_products.{structure,takaful_json,parametric_trigger_json,
  standard_mapping_json,pricing_inputs_json}`, `axis_policies.payment_plan_json`,
  `core_providers.kind='financier'`, agent `autonomy_level`.

## Views (read models)

`v_customer_360`, `v_case_pipeline`, `v_renewal_book`, `v_cac_ltv`,
`v_exec_daily` — defined in packages/db/src/views.ts; NORTH reads only views +
snapshots, never module hot tables directly.

## Retention & residency

Per-tenant policy_json drives: message retention (default 24m), file retention
(7y for policy docs), ai_audit_log (7y), consent (indefinite), right-to-erasure
job (Workflow) that hard-deletes customer PII + tombstones references.
The retention purge (`POST /v1/compliance/retention/run`, classes `messages`,
`files`, `ai_audit`) runs nightly only on the cadence `policy_json.retention.schedule`
names (`never` by default — ADR-0107); legal holds freeze it either way.
Dedicated-D1 tenants pin region via Cloudflare placement hints; on-prem = local.

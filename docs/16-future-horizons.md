# 16 — Future Horizons: Tomorrow's Functionality, Built Into Today's Seams

Future-proofing here is concrete: for each horizon we name **what we build
NOW** (schema fields, enums, interfaces — cheap today, impossible to retrofit
later) and **what lights up LATER** behind capability flags. Seams are
load-bearing (CLAUDE.md rule 12): implement against the interface, never the
single current case. Every NOW item ships with its contract test in the
milestone that touches that area.

## H1 — Agentic commerce: when the customer is an AI

Consumers will increasingly send their own AI agents to research and buy
coverage. The winner is the platform that is the *best counterparty for
agents* while staying human-safe.

- **NOW:** `channel` enum includes `'agent'`; machine-readable offer schema —
  every ranked quote exposes signed, structured terms (`offer_json` +
  detached signature, schema versioned) so an external agent can verify what
  it's buying; `orbit_partners.kind` includes `'ai_agent_platform'`;
  delegated-authority table `core_mandates` (principal, agent identity,
  scope, spend cap, expiry, verification method) — empty in v1, referenced by
  the embedded bind path; AEO content units already structured for citation.
- **LATER:** agent-facing storefront profile (capabilities manifest at
  `/.well-known/lyra-agent.json`), mandate verification against emerging
  delegated-payment standards, agent-traffic analytics in SIGNAL ("share of
  agent-mediated binds"), negotiation policies (floor prices for agent
  bargaining) in AXIS admin.

## H2 — Autonomy ladder: from copilot to trusted operator

- **NOW:** `autonomy_level` (L0 draft / L1 approve / L2 act+report / L3
  envelope-autonomous) on every agent registration; `AutonomyEnvelope`
  interface (max actions/day, max value/action, reversibility class,
  escalation rules) in packages/core; the approval engine keys off it; the
  Quiet Ledger (docs/15 §4.9) is the reporting surface; every L2-capable
  action declares its `reversal_fn` or is capped at L1.
- **LATER:** per-tenant graduation workflows (agent earns L2 on a task after
  n approved-unchanged proposals with human sign-off), NORTH oversight page
  ("autonomous actions this week, reversal rate"), envelope marketplace
  presets per industry.

## H3 — Voice-native & multimodal service

- **NOW:** `orbit_messages.modality` enum (`text|voice|image|video|document`)
  with normalized-transcript convention (voice stores audio ref + transcript
  + diarization); AgentRoom protocol carries media frames opaquely; TTS/ASR
  behind a `SpeechProvider` seam in model-gateway; video-FNOL capture flow
  reserved in mobile doc-capture pipeline (guided capture is modality-generic).
- **LATER:** real-time speech-to-speech agents (Arabic dialects: Gulf,
  Egyptian, Levantine — dialect field on tenant locale policy), telephony
  ingress (SIP partner), visual damage pre-assessment (describe-only, never
  adjudicate), voice biometrics as an `IdentityVerifier` (H5).

## H4 — Open finance / open insurance rails

Regulators (CBUAE open finance, and analogues in KSA/EG) are standardizing
consented data sharing and product APIs.

- **NOW:** `DataInConnector` interface with consent-purpose binding (a
  connector cannot be registered without mapped purposes); product model
  keeps a `standard_mapping_json` field (map our product schema to external
  open-insurance schemas without migration); OAuth server foundations in the
  gateway support the granular-consent claims shape (FAPI-ready structure,
  even while we use plain OAuth2 in v1).
- **LATER:** licensed open-finance consumption (bank data → affordability &
  personalization in SIGNAL/ORBIT with explicit consent), publishing our
  quotes onto national open-insurance rails, premium-financing integrations
  (H9).

## H5 — Digital identity & verified everything

- **NOW:** `IdentityVerifier` seam + `core_identity_verifications` table
  (subject, method, evidence_level, ref, expiry) — v1 methods: document+
  selfie via extraction pipeline; every KYC touchpoint reads evidence_level,
  not method.
- **LATER:** UAE Pass, KSA Nafath, reusable-KYC providers as drop-in
  verifiers; step-up verification policies per action value; verified-agent
  identity for H1 mandates.

## H6 — Sensor & usage-based products (telematics, health, IoT)

- **NOW:** SCOUT's ingest generalized as `TimeseriesIngest` API (source
  registration, schema, consent purpose `telemetry`); product schema carries
  `pricing_inputs_json` (declares which behavioral inputs a product may use —
  surfaced to the customer, enforced at quote time).
- **LATER:** driving-score partners for UBI motor, wearable-linked wellness
  riders, fleet dashboards for SME lines; fairness audits extend to
  behavioral inputs (docs/12 §4 applies automatically because inputs are
  declared, not smuggled).

## H7 — Parametric & climate products

- **NOW:** `core_products.parametric_trigger_json` (event source, index,
  threshold, payout rule) — null for conventional products; SCOUT playbook
  templates include flight-delay, weather, outage covers.
- **LATER:** trigger-oracle connectors with dual-source confirmation, instant
  payout orchestration via PSP payout APIs (still approval-gated per
  autonomy envelope), NORTH exposure aggregation views.

## H8 — Takaful-native

- **NOW:** product model fields `structure` (`conventional|takaful`),
  `takaful_json` (wakala fee, surplus rule, fund ref — shaped by `TakafulJson`,
  packages/db/src/json.ts); Hijri calendar support already in the design
  system; disclosure templates keyed by structure. The Shariah-board review
  lane is built (docs/27 F45): `POST /v1/compliance/shariah/{submit,certify}`,
  gated on `compliance.shariah_certify` (dual control, never auto-approvable),
  with the ruling refused through the generic product CRUD so the gate has no
  second door. `SURPLUS-DIST` posts a real takaful split — 2040 participants'
  fund out, 2050 participants' payable and 4095 operator share in — and its
  precondition refuses a product whose ruling is missing or expired.
- **LATER:** surplus-distribution statements to participants (ORBIT journey),
  takaful fund reporting pack in NORTH, and segregation of the tabarru' fund
  under its own asset account with its own invariant — deliberately not folded
  into the CBUAE client-money test (1010 ≥ 2010), which answers a different
  regime.

## H9 — Embedded lending & flexible premium

- **NOW:** `axis_policies.payment_plan_json` (plan type, installments,
  financier ref, status); `core_providers.kind` includes `'financier'`;
  revenue-share ledger already generalizes to financing commissions.
- **LATER:** pay-monthly at checkout via financing partners, dunning journeys
  in ORBIT, affordability signals (H4) gating plan offers, arrears views in
  NORTH.

## H10 — Marketplace & extension ecosystem

- **NOW:** the extension manifest format (id, publisher, scopes, surfaces:
  tool|connector|journey-step|metric|report-block, signature) is defined and
  validated in the Dev Portal harness even though only first-party
  extensions exist; all first-party connectors/tools are packaged AS
  extensions from day one — we are our own marketplace's first customer.
- **LATER:** third-party submissions with review + signing, revenue share,
  tenant install flows with scope consent screens, version pinning per
  tenant.

## H11 — Intelligence that compounds

- **NOW:** `core_memories` (subject: user|customer|tenant; kind: preference|
  fact|pattern; content, provenance, expiry, sensitivity) with privacy
  controls wired to docs/12 (viewable, erasable, purpose-bound) — the
  substrate for personalization (Lens), ORBIT customer memory, and SIGNAL
  winning-pattern memory; scenario engine primitives registered with
  versioned assumptions (NORTH) so the business "digital twin" can improve
  over time; model-gateway routing policies accept quality/cost/latency
  objectives (auto-routing later, static maps now).
  Beside it, the human half (ADR-0089): `core_notes` — one markdown note per
  record, `[[wikilinks]]` derived into `core_links` for backlinks and a graph,
  exportable as an Obsidian vault — gated by `core:notes:*` *and* the record's
  own read, and erased with `core_memories` when an erasure DSAR is fulfilled.
- **LATER:** per-tenant small-model distillation for high-volume tasks
  (extraction, classification) trained on tenant-approved data; on-device
  extraction in mobile (privacy + speed); cross-module "next best action"
  service ranking every surface's suggestions through one calibrated model;
  federated benchmarks across consenting tenants (k-anonymous, opt-in).

## H12 — Regulation as versioned data

- **NOW:** rulepack schema (`market`, `version`, `rules_json`: quiet hours,
  disclosure templates, retention floors, contact frequency caps, required
  approvals) loaded per tenant market — UAE pack ships in v1; guardrail
  floors read from the pack, not from code.
- **LATER:** KSA and Egypt packs, effective-date scheduling (a pack change
  activates on the regulation's date with diff preview to compliance),
  regulator-mode read-only access grants with scoped audit views.

## Horizon governance

Each horizon has an owner, a design partner (real tenant), and entry
criteria; nothing exits "LATER" without an ADR + eval/threat review. The NOW
items above are in scope for M0–M6 and their contract tests are part of the
milestone acceptance suites — grep tag `@seam:Hx` must return ≥ 1 passing
test per horizon by M6 close.

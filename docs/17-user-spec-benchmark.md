# LYRA — Detailed User Specification & Build Benchmark (URS)

**Purpose.** This is the auditable requirements register for the LYRA
platform. Every requirement has a stable ID, a priority, a target milestone, a
verification method and a status box. You bench the build against this document:
if a requirement is not verifiably met, the system is not complete.

**Relationship to the pack.** `docs/00–16` describe design and intent. This
document converts that intent into **countable, testable obligations**. Where
this document and a spec disagree, the spec wins and this register is corrected
(same rule as `CLAUDE.md`).

---

## 0. How to use this document

### 0.1 ID scheme
| Prefix | Domain |
|---|---|
| `PLAT` | Platform / Core spine (tenancy, identity, audit, consent, events, model gateway) |
| `AXIS` `ORB` `SIG` `SCT` `NOR` | The five modules |
| `ROLE` | Role capability obligations |
| `JRN` | End-to-end journey acceptance |
| `UX` | Frontend craft, ambient AI, Lens personalization |
| `MOB` | Mobile application |
| `ADM` | Admin surfaces (module, tenant, platform) |
| `DEV` | Developer platform & APIs |
| `DEP` | Deployment (cloud + on-prem parity) |
| `SEC` | Security, privacy, AI governance |
| `NFR` | Non-functional (performance, scale, availability, a11y, i18n) |
| `SEAM` | Future-horizon seams (docs/16 NOW items) |
| `ANL` | Analytics & reporting fabric |

IDs are permanent. Never renumber; deprecate with `(DEPRECATED — superseded by X)`.

### 0.2 Priority (MoSCoW)
`M` = Must (v1 blocker) · `S` = Should (v1 target, degradable) ·
`C` = Could (v1.1) · `W` = Won't (backlog, listed for completeness)

### 0.3 Verification methods
`T` automated test (unit/integration/e2e) · `E` AI eval golden set ·
`M` measurement against a numeric budget · `D` demonstration/inspection ·
`A` analysis/document review (e.g. counsel sign-off, ADR)

Every `M`-priority requirement must have at least one automated method (`T`,
`E`, or `M`) unless its nature makes that impossible, in which case `D`+`A`
with a named approver is required.

### 0.4 Status
`☐` not started · `◐` in progress · `☑` verified (evidence linked) ·
`⊘` waived (requires written waiver + approver + date)

### 0.5 Completion scoring
- **Module complete** = 100% of its `M` requirements `☑` + ≥80% of `S`.
- **System complete (v1)** = every module complete **and** all `PLAT`, `SEC`,
  `NFR`, `DEP`, `SEAM` `M` items `☑` **and** all `JRN` acceptance passing
  **and** the quality gates in docs/13 §6 green.
- Report coverage per milestone as: `☑ M / total M` per prefix. Anything `⊘`
  must be listed in the release notes with its waiver.

### 0.6 Standalone obligation (applies to every module requirement)
Unless a requirement is explicitly tagged `[∫]`, it **must be satisfiable with
the module licensed alone** (Core spine only). Requirements tagged `[∫X]`
describe behaviour that appears only when module X is also licensed, and must
degrade to a documented standalone path with an explicit UI notice — never a
silent failure or an error.

---

## 1. PLAT — Platform & Core spine

### 1.1 Tenancy & isolation
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-001 | Every persisted table carries `tenant_id`; no table exists without it | M | M0 | T | ☐ |
| PLAT-002 | All data access passes the tenancy guard (`withTenant`/`tenantWhere`); a lint rule fails builds on raw cross-tenant queries | M | M0 | T | ☐ |
| PLAT-003 | A cross-tenant read attempt returns 403/404 and raises `CrossTenantError` internally; never leaks existence | M | M0 | T | ☐ |
| PLAT-004 | Tenant resolution by hostname via registry (KV) → tenant record with brand, policy, entitlements, db binding | M | M1 | T | ☐ |
| PLAT-005 | Enterprise/regulated tenants can be provisioned on a dedicated database with identical schema and zero code change | M | M1 | T,D | ☐ |
| PLAT-006 | Entitlements gate module access at the gateway AND drive UI visibility from the same object | M | M1 | T | ☐ |
| PLAT-007 | New tenant provisioning (create → brand → entitlements → domain → seed → smoke) completes in < 1 business day, automated | M | M1 | M,D | ☐ |
| PLAT-008 | Cross-tenant isolation test suite runs on every CI build and blocks merge on failure | M | M0 | T | ☐ |

### 1.2 Identity, authentication, authorization
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-010 | Email+password auth with session cookies; password policy and lockout | M | M0 | T | ☐ |
| PLAT-011 | SSO via OIDC (Azure AD, Google) and SAML for enterprise tenants | M | M1 | T,D | ☐ |
| PLAT-012 | MFA (TOTP/WebAuthn) available to all users; enforceable per role by policy | M | M1 | T | ☐ |
| PLAT-013 | MFA mandatory for all staff/admin roles; cannot be disabled by tenant config | M | M1 | T | ☐ |
| PLAT-014 | Machine auth via scoped API keys (`qvk_live_`/`qvk_test_`), hashed at rest, prefix lookup | M | M1 | T | ☐ |
| PLAT-015 | OAuth2 client-credentials for partner applications | M | M3 | T | ☐ |
| PLAT-016 | RBAC permissions expressed as `module:resource:action` with wildcard support | M | M0 | T | ☐ |
| PLAT-017 | Every route enforces authorization via a single `can()` path; no ad-hoc checks | M | M1 | T | ☐ |
| PLAT-018 | Auto-generated authz matrix test asserts every route × role → expected status | M | M1 | T | ☐ |
| PLAT-019 | PII fields masked by default; reveal requires `core:pii:view` and writes an audit entry | M | M1 | T | ☐ |
| PLAT-020 | Staff admin surfaces additionally protected by network/identity gate (CF Access / OIDC forward-auth) | M | M1 | D | ☐ |
| PLAT-021 | Session revocation (single session and all sessions) available to user and admin | S | M1 | T | ☐ |
| PLAT-022 | Impersonation requires tenant-admin consent, shows a persistent banner, and is fully audited | M | M1 | T,D | ☐ |

### 1.3 Customer spine & consent
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-030 | Unified customer record (person & business) with bilingual names, identifiers, tags, computed value/risk | M | M1 | T | ☐ |
| PLAT-031 | Consent stored as an immutable ledger; current state derived as latest per purpose | M | M1 | T | ☐ |
| PLAT-032 | Consent purposes at minimum: marketing, profiling, data sharing, cross-border | M | M1 | T | ☐ |
| PLAT-033 | Every outbound message, profiling job, audience build and aggregate checks consent at runtime | M | M1 | T | ☐ |
| PLAT-034 | Consent withdrawal propagates to all suppression points in < 15 minutes | M | M1 | T,M | ☐ |
| PLAT-035 | Channel opt-ins tracked separately per channel (email, WhatsApp, SMS, voice) | M | M1 | T | ☐ |
| PLAT-036 | Customer-facing preference centre allows self-service consent management | S | M3 | T | ☐ |
| PLAT-037 | Right-to-access produces a machine- and human-readable export within policy SLA | M | M1 | T | ☐ |
| PLAT-038 | Right-to-erasure hard-deletes PII, tombstones references, and purges derived stores (vectors, caches, exports) | M | M1 | T | ☐ |
| PLAT-039 | Erasure-completeness verification job proves no PII remains for an erased subject | M | M1 | T | ☐ |

### 1.4 Files & documents
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-045 | Signed upload/download flows; no file bytes pass through application logs | M | M1 | T | ☐ |
| PLAT-046 | Files carry checksum, PII level, subject reference and retention class | M | M1 | T | ☐ |
| PLAT-047 | Uploads are content-type sniffed and malware-scanned before processing | M | M1 | T | ☐ |
| PLAT-048 | Document viewer supports PDF and images with extraction overlay | M | M2 | D | ☐ |

### 1.5 Eventing & integration bus
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-050 | Event envelope `{id, ts, tenant_id, module, type, actor, subject, data, v}` published for all catalogued events | M | M1 | T | ☐ |
| PLAT-051 | Consumers are idempotent via an inbox dedupe on event id | M | M1 | T | ☐ |
| PLAT-052 | Reliable publish via outbox; no event lost on transaction failure | M | M1 | T | ☐ |
| PLAT-053 | Dead-letter queue with admin browse, inspect and replay | M | M1 | T,D | ☐ |
| PLAT-054 | Cross-module integration occurs only via events/core views — no direct module-to-module imports (enforced by lint) | M | M1 | T | ☐ |
| PLAT-055 | Event contract versioning: additive changes free; breaking changes require new version and sunset window | M | M1 | T | ☐ |

### 1.6 Model gateway & AI substrate
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-060 | All model access flows through the gateway; direct provider SDK use in app code fails lint | M | M1 | T | ☐ |
| PLAT-061 | Every call carries tenant, module, purpose, actor and tier | M | M1 | T | ☐ |
| PLAT-062 | Providers supported: managed edge models, frontier API (via gateway), and OpenAI-compatible internal endpoint | M | M1 | T | ☐ |
| PLAT-063 | Tiers `fast`/`standard`/`reasoning` mapped to providers by tenant policy | M | M1 | T | ☐ |
| PLAT-064 | Per-tenant daily AI budget metered with hard stop and admin alert at threshold | M | M1 | T | ☐ |
| PLAT-065 | Every model call written to an append-only AI audit log with token counts, cost, latency, tool calls, guardrail flags | M | M1 | T | ☐ |
| PLAT-066 | Guardrail pipeline: PII redaction pre-call, policy classification pre/post, grounding check on regulated statements | M | M1 | T,E | ☐ |
| PLAT-067 | Prompt-injection resistance suite passes 100% against the live tool registry | M | M3 | T,E | ☐ |
| PLAT-068 | Retrieval indexes are tenant-namespaced; no cross-tenant retrieval possible | M | M1 | T | ☐ |
| PLAT-069 | Numeric-verification gate: generated prose containing figures fails closed unless every figure matches a structured source | M | M6 | T,E | ☐ |
| PLAT-070 | Eval harness gates provider/model/prompt changes in CI with published thresholds | M | M1 | T,E | ☑ |
| PLAT-071 | Arabic/English parity measured per generative task; parity gap within threshold | M | M3 | E | ☐ |
| PLAT-072 | Model/prompt versions recorded on every generated artifact for reproducibility | M | M1 | T | ☐ |

### 1.7 Agents, tools & autonomy
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-075 | Agents may only call tools from a typed registry with RBAC scope and per-tenant enablement | M | M3 | T | ☐ |
| PLAT-076 | Every tool declares a `consequential` flag; consequential calls require approval unless tenant-allowlisted | M | M3 | T | ☐ |
| PLAT-077 | Autonomy levels L0–L3 declared per agent with an envelope (max actions/day, max value, reversibility class, escalation) | M | M3 | T | ☐ |
| PLAT-078 | L2+ actions declare a reversal function or are capped at L1 | M | M3 | T | ☐ |
| PLAT-079 | Kill switches at agent, module, tenant and global scope; effective within one request cycle; audited | M | M2 | T,D | ☐ |
| PLAT-080 | Auto-approve allowlist changes require compliance-role sign-off and are audited | M | M3 | T | ☐ |
| PLAT-081 | Long-horizon work runs as durable, resumable workflows surviving restart | M | M3 | T | ☐ |
| PLAT-082 | Conversation/agent sessions maintain isolated state with a tool-call ledger | M | M3 | T | ☐ |

### 1.8 Audit & evidence
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-085 | Append-only human action audit log (actor, action, subject, before/after hash, ip, ua, ts) | M | M1 | T | ☐ |
| PLAT-086 | Audit logs are tamper-evident (hash-chained daily anchors) | M | M1 | T | ☐ |
| PLAT-087 | Audit search by subject, actor, action, time range, with permission gating | M | M1 | T | ☐ |
| PLAT-088 | Signed evidence bundle export (PDF + JSONL + hash manifest) for any subject or scope | M | M2 | T,D | ☐ |
| PLAT-089 | Audit retention configurable above regulatory floors; floors cannot be lowered | M | M1 | T | ☐ |

### 1.9 Notifications, search, automation
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-090 | Per-user notification inbox with channel routing (in-app, email, push, messaging) | M | M1 | T | ☐ |
| PLAT-091 | Quiet hours and frequency caps honoured on all notification channels | M | M3 | T | ☐ |
| PLAT-092 | Global command palette searches entities, actions and documentation | M | M0 | T | ☐ |
| PLAT-093 | Natural-language filters compile to visible, editable structured queries | S | M2 | T,D | ☐ |
| PLAT-094 | No-code automation recipes (event → condition → action) with simulate/dry-run, versioning and diff | M | M2 | T | ☐ |
| PLAT-095 | Guardrail floors (consent, quiet hours, approval thresholds, k-anonymity) are not configurable below regulatory minimums in any builder | M | M2 | T | ☐ |
| PLAT-096 | Shared approvals engine supports dual-control, reason codes, delegation and expiry | M | M2 | T | ☐ |
| PLAT-097 | Bulk import/export (CSV/XLSX) with validation, preview, partial-failure reporting | M | M2 | T | ☐ |

### 1.10 Internationalization & branding
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| PLAT-100 | All user-facing strings externalized to i18n keys; hard-coded copy fails lint | M | M0 | T | ☐ |
| PLAT-101 | English and Arabic shipped for every user-facing surface at release | M | per-MS | T,A | ☐ |
| PLAT-102 | Full RTL support via logical CSS properties only; no physical-direction properties | M | M0 | T | ☐ |
| PLAT-103 | Arabic copy authored natively (not machine-translated) with a review lane gate | M | per-MS | A | ☐ |
| PLAT-104 | Brand name, logo, palette, domain and legal identity read from tenant config; hard-coded house mark in UI fails review | M | M0 | T | ☐ |
| PLAT-105 | Brand palette save validates contrast (WCAG AA) and rejects failing combinations | M | M1 | T | ☐ |
| PLAT-106 | Hijri calendar display option alongside Gregorian | S | M2 | D | ☐ |
| PLAT-107 | Currency, number and date formatting locale-correct with tabular numerals in metrics | M | M0 | T | ☐ |

---

## 2. ANL — Analytics & reporting fabric (available inside every module)

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ANL-001 | Shared semantic metric layer: every module publishes metrics with owner, definition, target, sensitivity | M | M6 | T | ☐ |
| ANL-002 | A metric means the same thing in every module and report (single definition source) | M | M6 | T | ☐ |
| ANL-003 | Metric definitions are versioned; changes annotate every affected chart from the change date | M | M6 | T | ☐ |
| ANL-004 | Explore surface: pivot, segment, cohort, compare-to-period/cohort/target, saved explorations | M | M4 | T,D | ☐ |
| ANL-005 | Dashboard builder with tile types: stat, timeseries, funnel, distribution, table, breakdown, map | M | M4 | D | ☐ |
| ANL-006 | Role-default dashboards ship for every role; users may build their own | M | M4 | D | ☐ |
| ANL-007 | Live updating tiles with staleness indication; no silent stale data | M | M4 | T | ☐ |
| ANL-008 | Anomaly detection and baseline/forecast primitives available to any module metric | M | M6 | T | ☐ |
| ANL-009 | Natural-language analytics question → visible editable query, never a black box | S | M6 | T,D | ☐ |
| ANL-010 | Warehouse-out: scheduled columnar export and read-only BI connectivity | S | M4 | T,D | ☐ |
| ANL-011 | Report Studio: composable blocks (narrative, chart, table, KPI wall, image) → branded PDF/XLSX/CSV/PPTX | M | M4 | T,D | ☐ |
| ANL-012 | Scheduled report delivery (email, object store, webhook, chat platform) with failure alerting | M | M4 | T | ☐ |
| ANL-013 | Report snapshot versioning with distribution log and read receipts | M | M6 | T | ☐ |
| ANL-014 | AI-written executive summary available on any report, subject to the numeric-verification gate | M | M6 | T,E | ☐ |
| ANL-015 | Every analytics figure is traceable to source rows/query (click-through evidence) | M | M4 | T,D | ☐ |
| ANL-016 | Exports honour PII permissions and mask/withhold restricted fields | M | M4 | T | ☐ |
| ANL-017 | Aggregate outputs enforce k-anonymity suppression where data leaves the tenant | M | M5 | T | ☐ |

---

## 3. ROLE — Role capability obligations

Each role must be able to complete its full working day inside the product with
no out-of-band tooling. Verification is a scripted role walkthrough per release.

| ID | Role | Must be able to | Pri | MS | Verify | Status |
|---|---|---|---|---|---|---|
| ROLE-001 | `platform.admin` | Create/suspend tenants, set entitlements, manage flags, browse/replay DLQ, view cost per tenant, publish status | M | M1 | T,D | ☐ |
| ROLE-002 | `platform.support` | Diagnose with consented impersonation, read logs/traces, never see raw PII without permission | M | M1 | T,D | ☐ |
| ROLE-003 | `tenant.admin` | Manage people/roles/SSO mapping, brand studio, policies, entitlement view, billing/usage, integrations, audit search | M | M1 | T,D | ☐ |
| ROLE-004 | `tenant.compliance` | Export evidence bundles, search consent, set approval policies, review flagged content, read AI audit, view compliance posture | M | M2 | T,D | ☐ |
| ROLE-005 | `axis.agent` | Work exceptions, run cases, verify extractions, request approvals, communicate with customer | M | M2 | T,D | ☐ |
| ROLE-006 | `axis.lead` | Manage queues/routing, SLA policies, team performance, reassign work, approve within limits | M | M2 | T,D | ☐ |
| ROLE-007 | `axis.admin` | Configure SOPs, ranking criteria, extraction templates, connectors, approval policies, kill switch | M | M2 | D | ☐ |
| ROLE-008 | `orbit.agent` | Handle conversations across channels, accept AI drafts, hand over, log dispositions | M | M3 | T,D | ☐ |
| ROLE-009 | `orbit.lead` | Supervise live wall, barge/whisper, review QA scores, coach, manage staffing alerts | M | M3 | T,D | ☐ |
| ROLE-010 | `orbit.retention` | Work the renewal book, run save desk within bounded authority, analyse win/loss | M | M3 | T,D | ☐ |
| ROLE-011 | `orbit.partners` | Onboard partners, manage keys/plans, view usage and settlements, resolve disputes | M | M3 | T,D | ☐ |
| ROLE-012 | `orbit.admin` | Configure channels, persona/tone, tool matrix, journey guardrails, QA rubric, routing | M | M3 | D | ☐ |
| ROLE-013 | `signal.marketer` | Brief and generate creative, build audiences, launch campaigns, run experiments | M | M4 | T,D | ☐ |
| ROLE-014 | `signal.lead` | Approve budget moves, set bounds, review economics, arbitrate experiments | M | M4 | T,D | ☐ |
| ROLE-015 | `signal.admin` | Manage brand kit, banned claims, channel auth, disclosure templates, suppression sources | M | M4 | D | ☐ |
| ROLE-016 | `scout.pm` | Review radar, own whitespace dossiers, run product experiments, promote/park | M | M5 | T,D | ☐ |
| ROLE-017 | `scout.lead` | Set thresholds, prioritise portfolio, approve data products, run panel negotiations | M | M5 | T,D | ☐ |
| ROLE-018 | `scout.admin` | Manage sources/crawl policy, k-anonymity floor, hypothesis library, export policy | M | M5 | D | ☐ |
| ROLE-019 | `north.exec` | Read the brief, drill evidence, triage anomalies, run scenarios, assign actions, approve packs | M | M6 | T,D | ☐ |
| ROLE-020 | `north.analyst` | Steward metric definitions, investigate drivers, build boards, prepare packs | M | M6 | T,D | ☐ |
| ROLE-021 | `north.board` | Read-only brief and packs, watermarked, no operational data access | M | M6 | T | ☐ |
| ROLE-022 | `north.admin` | Approve metric changes, map sensitivity/audiences, schedule briefs, manage connectors | M | M6 | D | ☐ |
| ROLE-023 | `dev.developer` | Obtain test keys, read docs, use sandbox, test webhooks, inspect logs | M | M1 | T,D | ☐ |
| ROLE-024 | `dev.admin` | Promote to live keys, rotate secrets, manage OAuth clients, approve extensions | M | M1 | T,D | ☐ |
| ROLE-025 | `customer` | Self-serve quote, purchase, service, renew, exercise privacy rights | M | M3 | T,D | ☐ |
| ROLE-026 | `partner.developer` | Self-onboard, sandbox integrate, certify, go live without bespoke engineering | M | M3 | T,D | ☐ |
| ROLE-027 | `partner.manager` | View volumes, revenue share, settlements, integration health | M | M3 | T,D | ☐ |
| ROLE-028 | `provider.viewer` | Access purchased data products only, scoped and k-anonymised | S | M5 | T | ☐ |
| ROLE-029 | Every role | Lands on a role-appropriate default workspace with role-appropriate vocabulary and density | M | M6 | D | ☐ |
| ROLE-030 | Every role | Cannot see or act beyond its permission bundle (verified by the authz matrix) | M | M1 | T | ☐ |

---

## 4. AXIS — AI Operations requirements

### 4.1 Production Board & work management
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-001 | Cases created from web intake, email, CSV/XLSX import and API | M | M2 | T | ☐ |
| AXIS-002 | Case kinds supported: quote, bind, endorsement, renewal-ops, group medical, KYC | M | M2 | T | ☐ |
| AXIS-003 | Board presents cases by stage with table and kanban views, swimlanes by team/line/source | M | M2 | D | ☐ |
| AXIS-004 | SLA clocks per case kind with visual urgency and breach state | M | M2 | T | ☐ |
| AXIS-005 | Predicted SLA breach flagged at least 4 hours ahead | M | M2 | T,M | ☐ |
| AXIS-006 | Saved views per user and per team, shareable | M | M2 | T | ☐ |
| AXIS-007 | Bulk actions (assign, reprioritise, close, tag) with permission checks and audit | M | M2 | T | ☐ |
| AXIS-008 | Queue prioritisation ranks by value × risk × SLA with explainable ordering | M | M2 | T,D | ☐ |
| AXIS-009 | Board updates live without manual refresh | M | M2 | T | ☐ |
| AXIS-010 | `[∫ORB]` Cases auto-created from conversations with full context linkage | M | M3 | T | ☐ |
| AXIS-011 | `[∫SIG]` Campaign-sourced cases tagged to originating spend for attribution | M | M4 | T | ☐ |

### 4.2 Case Room & quote-to-bind
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-015 | Unified case timeline (events, documents, messages, AI actions, approvals) | M | M2 | T | ☐ |
| AXIS-016 | Panel quoting fans out to providers across ≥3 connector types (REST, portal automation, structured email) | M | M2 | T,D | ☐ |
| AXIS-017 | Quote normalisation into comparable structure (premium, coverage, excess, validity) | M | M2 | T | ☐ |
| AXIS-018 | Quote ranking uses declared, auditable criteria; criteria snapshot stored per presentation | M | M2 | T | ☐ |
| AXIS-019 | Any pay-for-position or preferential ranking is disclosed in UI when enabled | M | M2 | T,D | ☐ |
| AXIS-020 | Copilot drafts responses, summarises the case file and proposes next step; drafts never auto-send | M | M2 | T,E | ☐ |
| AXIS-021 | Missing-information chase automated with channel-policy compliance | M | M2 | T | ☐ |
| AXIS-022 | Bind flow generates policy schedule, stores documents, delivers to customer channel | M | M2 | T | ☐ |
| AXIS-023 | Approval strip surfaces pending approvals inline with reason codes | M | M2 | T | ☐ |
| AXIS-024 | Fully automated motor happy path (intake → ≥3 quotes → bind → delivery) completes with zero human touches | M | M2 | T,M | ☐ |
| AXIS-025 | Same-session issuance achieved for motor and travel lines | M | M2 | M | ☐ |
| AXIS-026 | `[∫SCT]` Pricing/coverage benchmarks display inline in the quote panel | S | M5 | T | ☐ |
| AXIS-027 | `[∫ORB]` Agent can reply to the customer in-thread from the case | M | M3 | T | ☐ |

### 4.3 Document intelligence
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-030 | Extraction supports national ID, vehicle registration, trade licence, medical report and census documents | M | M2 | T,E | ☐ |
| AXIS-031 | Extraction accuracy meets published field-level threshold in both Arabic and English | M | M2 | E | ☐ |
| AXIS-032 | Per-field confidence scoring; sub-threshold fields route to human verification | M | M2 | T | ☐ |
| AXIS-033 | Verify UI shows document and extracted fields side by side with overlay positioning | M | M2 | D | ☐ |
| AXIS-034 | Verify queue is keyboard-first (navigate, correct, confirm without mouse) | M | M2 | T,D | ☐ |
| AXIS-035 | Census normaliser converts arbitrary employee lists to canonical structure with age/salary banding and dependents | M | M2 | T | ☐ |
| AXIS-036 | Census year-over-year diff view highlights joiners, leavers and changes | M | M2 | T | ☐ |
| AXIS-037 | Extraction template editor allows new document types without code deployment | M | M2 | D | ☐ |
| AXIS-038 | Extraction accuracy dashboard per document type and language | M | M2 | T,D | ☐ |
| AXIS-039 | Original documents retained with checksum linkage to extracted values | M | M2 | T | ☐ |

### 4.4 Underwriting assist & servicing
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-045 | Risk flags surfaced with the evidence that produced them | M | M2 | T | ☐ |
| AXIS-046 | Referral packaging assembles a complete submission for insurer underwriters | M | M2 | T | ☐ |
| AXIS-047 | System never issues an underwriting decision; all outputs are assist-only and labelled | M | M2 | T,A | ☐ |
| AXIS-048 | Endorsements, MTAs and cancellations supported with document regeneration | M | M2 | T | ☐ |
| AXIS-049 | Policy register searchable by policy number, customer, provider, line, status | M | M2 | T | ☐ |
| AXIS-050 | Renewal-ops handoff to retention with full case context | M | M3 | T | ☐ |

### 4.5 Exceptions & process intelligence
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-055 | A single exceptions queue aggregates failed automations, integration errors, SLA risk and low-confidence extractions | M | M2 | T | ☐ |
| AXIS-056 | Exceptions carry copilot-drafted resolution proposals | M | M2 | T | ☐ |
| AXIS-057 | Live process map visualises pipeline flow with volumes and durations | M | M2 | D | ☐ |
| AXIS-058 | Bottleneck, rework-loop and drop-off analytics identify the top constraints | M | M2 | T,D | ☐ |
| AXIS-059 | Routing/SOP changes can be simulated against historical cases before rollout | S | M2 | T | ☐ |
| AXIS-060 | Capacity and staffing forecasts account for seasonal peaks | S | M2 | T | ☐ |

### 4.6 Compliance operations
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-065 | Approval policies configurable for pricing overrides, discounts and refunds with reason codes | M | M2 | T | ☐ |
| AXIS-066 | Disclosure and ranking-criteria logging captured on every customer presentation | M | M2 | T | ☐ |
| AXIS-067 | Retention rules applied per product line above regulatory floors | M | M2 | T | ☐ |
| AXIS-068 | Audit-on-demand exports a complete signed bundle for any case in one action | M | M2 | T,D | ☐ |
| AXIS-069 | Client-money/escrow reconciliation imports provider statements and auto-matches transactions | M | M2 | T | ☐ |
| AXIS-070 | Reconciliation exceptions queue with evidence attachment and sign-off trail | M | M2 | T | ☐ |
| AXIS-071 | Reconciliation evidence bundle export suitable for regulatory submission | M | M2 | D,A | ☐ |
| AXIS-072 | Match rate meets published threshold on the reference statement set | M | M2 | M | ☐ |

### 4.7 Provider network, analytics, admin, developer
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| AXIS-075 | Connector health dashboard with latency, error rate and last-success per provider | M | M2 | T,D | ☐ |
| AXIS-076 | Win-rate and quote-latency analytics by provider, line and segment | M | M2 | T | ☐ |
| AXIS-077 | Commission schedules configurable per provider and line | M | M2 | T | ☐ |
| AXIS-078 | Panel coverage-gap reporting identifies lines/segments without competitive quotes | M | M2 | T | ☐ |
| AXIS-079 | Module analytics home reports handling minutes per policy, straight-through rate, cost per case, exception rate, extraction accuracy, SLA hit rate, reconciliation match rate, approval turnaround | M | M2 | T,D | ☐ |
| AXIS-080 | All AXIS metrics available to scheduled reports and dashboards | M | M2 | T | ☐ |
| AXIS-081 | `[∫NOR]` AXIS metrics auto-register in the semantic layer and appear in the executive brief | M | M6 | T | ☐ |
| AXIS-082 | Admin console: SOP builder with versioning and publish/rollback | M | M2 | T,D | ☐ |
| AXIS-083 | Admin console: SLA policies, routing rules, queue definitions | M | M2 | D | ☐ |
| AXIS-084 | Admin console: agent kill switch pausing all AXIS automations tenant-wide in one action | M | M2 | T | ☐ |
| AXIS-085 | Developer console: case/document APIs documented with working examples | M | M2 | T,D | ☐ |
| AXIS-086 | Developer console: connector SDK with test harness and mock providers | M | M2 | T | ☐ |
| AXIS-087 | Developer console: extraction playground and `axis.*` webhook tester | M | M2 | D | ☐ |

---

## 5. ORBIT — AI Customer & Partners requirements

### 5.1 Conversations & agent console
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-001 | Channels: messaging (WhatsApp), embeddable web chat, inbound email | M | M3 | T | ☐ |
| ORB-002 | Voice channel | C | v1.1 | T | ☐ |
| ORB-003 | Language auto-detection including Arabic, English and Arabizi | M | M3 | T,E | ☐ |
| ORB-004 | AI agent identifies itself as AI on first contact and on request | M | M3 | T | ☐ |
| ORB-005 | Streaming responses with first-token latency inside published budget | M | M3 | M | ☐ |
| ORB-006 | AI drafts appear as ghost text accepted by a single keystroke; never auto-sent | M | M3 | T,D | ☐ |
| ORB-007 | Human handover transfers full context: transcript summary, suggested actions, sentiment | M | M3 | T | ☐ |
| ORB-008 | Human can query the AI privately mid-conversation without the customer seeing it | M | M3 | T | ☐ |
| ORB-009 | Tri-pane console: queue, conversation, customer context with copilot | M | M3 | D | ☐ |
| ORB-010 | Conversation console fully RTL-correct with native Arabic layout | M | M3 | T,D | ☐ |
| ORB-011 | Unified threaded history across all channels per customer | M | M3 | T | ☐ |
| ORB-012 | Transcript search is redaction-aware and permission-gated | M | M3 | T | ☐ |
| ORB-013 | Conversations attachable to any module object (case, campaign, dossier) | M | M3 | T | ☐ |
| ORB-014 | Dispositions and tagging with reporting rollup | M | M3 | T | ☐ |
| ORB-015 | Escalation to human available to the customer at any point | M | M3 | T | ☐ |

### 5.2 AI Agent Studio
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-020 | Persona and tone editor per tenant/brand, versioned | M | M3 | T,D | ☐ |
| ORB-021 | Tool enablement matrix per tenant with permission scoping | M | M3 | T | ☐ |
| ORB-022 | Knowledge base management with retrieval grounding and citation of source | M | M3 | T,E | ☐ |
| ORB-023 | Standalone tool set covers CX and knowledge answers without other modules | M | M3 | T | ☐ |
| ORB-024 | `[∫AXIS]` Quote, bind, endorsement and document tools appear automatically | M | M3 | T | ☐ |
| ORB-025 | `[∫SIG]` Offer and creative tools available inside conversations | S | M4 | T | ☐ |
| ORB-026 | FNOL/claims support is guidance-only and explicitly labelled as not a claims decision | M | M3 | T,A | ☐ |
| ORB-027 | Guardrail and disclosure configuration with floors that cannot be removed | M | M3 | T | ☐ |
| ORB-028 | Conversation-quality eval thresholds met in Arabic and English before release | M | M3 | E | ☑ |

### 5.3 Renewals & retention
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-035 | Churn scoring per policy with feature explainability | M | M3 | T | ☐ |
| ORB-036 | Strategy assignment per policy: automated requote, human outreach, or suppress | M | M3 | T | ☐ |
| ORB-037 | Renewal book view by expiry cohort with risk banding and filters | M | M3 | T,D | ☐ |
| ORB-038 | Hosted one-tap renewal acceptance page, tenant-branded | M | M3 | T | ☐ |
| ORB-039 | Save desk with objection cards and outcome logging with reasons | M | M3 | T | ☐ |
| ORB-040 | Price-match authority bounded per role with approval beyond bounds | M | M3 | T | ☐ |
| ORB-041 | Retention measured against a holdout control from first launch | M | M3 | T,M | ☐ |
| ORB-042 | Standalone mode provides reminders and hosted forms without requote capability, with the limitation shown in UI | M | M3 | T,D | ☐ |
| ORB-043 | `[∫AXIS]` Pre-expiry panel requote executed automatically per strategy | M | M3 | T | ☐ |
| ORB-044 | Win/loss analysis by reason, provider, segment and price delta | M | M3 | T | ☐ |

### 5.4 Journeys
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-050 | Visual journey builder: triggers, waits, branches, messages, tasks, webhooks | M | M3 | T,D | ☐ |
| ORB-051 | Consent checks, quiet hours and frequency caps embedded and unremovable | M | M3 | T | ☐ |
| ORB-052 | Simulate mode dry-runs a synthetic customer through a journey before publish | M | M3 | T | ☐ |
| ORB-053 | Journey versioning with diff review and one-click rollback | M | M3 | T | ☐ |
| ORB-054 | Prebuilt library: welcome, document chase, renewal 90/60/30, win-back, NPS, dunning | M | M3 | D | ☐ |
| ORB-055 | `[∫SIG]` Journeys can target SIGNAL audiences and use SIGNAL creative | S | M4 | T | ☐ |
| ORB-056 | `[∫AXIS]` Journey steps can open and advance cases | M | M3 | T | ☐ |
| ORB-057 | Journey performance analytics per step with drop-off attribution | M | M3 | T | ☐ |

### 5.5 Partner & embedded platform
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-060 | Partner portal is tenant-brandable and externally accessible | M | M3 | T,D | ☐ |
| ORB-061 | Partner self-service onboarding wizard issuing sandbox credentials | M | M3 | T | ☐ |
| ORB-062 | Sandbox returns deterministic mock quotes for integration development | M | M3 | T | ☐ |
| ORB-063 | Embedded quote and bind APIs available in both API-only and drop-in webview modes | M | M3 | T | ☐ |
| ORB-064 | Partner certification checklist gates promotion to live credentials | M | M3 | T,D | ☐ |
| ORB-065 | Partner attribution automatic on every transaction | M | M3 | T | ☐ |
| ORB-066 | Revenue-share ledger computes per transaction with configurable schemes | M | M3 | T | ☐ |
| ORB-067 | Monthly settlement batches with statement documents and dispute flagging | M | M3 | T | ☐ |
| ORB-068 | Partner time-to-first-live-transaction achievable within published target without bespoke engineering | M | M3 | M,D | ☐ |
| ORB-069 | Partner usage, error rates and integration health visible to both sides | M | M3 | T | ☐ |

### 5.6 360, quality, supervision, analytics, admin, developer
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ORB-075 | Customer 360 shows identities, policies, cases, conversations, value, risk and consent state | M | M3 | T,D | ☐ |
| ORB-076 | Consent and preference history visible with source and timestamp | M | M3 | T | ☐ |
| ORB-077 | AI quality scoring applied to 100% of conversations (resolution, tone, compliance phrases) | M | M3 | T,E | ☐ |
| ORB-078 | Sampled human calibration review with agreement tracking | M | M3 | T | ☐ |
| ORB-079 | Coaching plans and scorecards per agent | S | M3 | D | ☐ |
| ORB-080 | Supervisor wall: volumes, wait times, containment, SLA, sentiment heat | M | M3 | T,D | ☐ |
| ORB-081 | Barge and whisper into any live conversation with audit | M | M3 | T | ☐ |
| ORB-082 | `[∫SIG]` Staffing surge alerts when campaigns launch | S | M4 | T | ☐ |
| ORB-083 | Analytics home: containment rate, first response, resolution time, CSAT/NPS, retention vs control, save rate, partner metrics, revenue share | M | M3 | T,D | ☐ |
| ORB-084 | Consent-violation counter with hard alarm at any non-zero value | M | M3 | T | ☐ |
| ORB-085 | Admin: channel configuration and message templates | M | M3 | D | ☐ |
| ORB-086 | Admin: QA rubric editor, handover routing, partner plans, kill switch | M | M3 | D | ☐ |
| ORB-087 | Developer: conversation simulator with scripted Arabic and English personas | M | M3 | T | ☐ |
| ORB-088 | Developer: embedded-flow playground, `orbit.*` webhook tester, scoped keys | M | M3 | D | ☐ |

---

## 6. SIGNAL — AI Marketing requirements

### 6.1 Growth cockpit & economics
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-001 | Cockpit reports CAC and LTV by channel, campaign and segment | M | M4 | T,D | ☐ |
| SIG-002 | Marginal (not only blended) economics displayed for allocation decisions | M | M4 | T | ☐ |
| SIG-003 | Spend-to-outcome flow visualisation | M | M4 | D | ☐ |
| SIG-004 | Pacing versus budget and target with alerting | M | M4 | T | ☐ |
| SIG-005 | Standalone conversion capture via first-party pixel and webhook | M | M4 | T | ☐ |
| SIG-006 | `[∫AXIS]` True bind and premium attribution replaces proxy conversions | M | M4 | T | ☐ |
| SIG-007 | `[∫ORB]` Retention campaign outcomes attributed to renewals | S | M4 | T | ☐ |

### 6.2 Creative studio & compliance
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-010 | Generation of ad copy, landing pages, emails, messaging templates and video scripts from a brief | M | M4 | T,E | ☐ |
| SIG-011 | Arabic and English generated natively with separate prompting, not post-translation | M | M4 | E,A | ☐ |
| SIG-012 | Brand kit enforcement (tokens, tone, banned terms) applied to all output | M | M4 | T | ☐ |
| SIG-013 | Mandatory disclosures auto-appended per product line | M | M4 | T | ☐ |
| SIG-014 | Compliance classifier screens every creative before publish with hard-block and soft-flag lanes | M | M4 | T,E | ☐ |
| SIG-015 | No creative can publish without passing pre-flight; bypass is impossible by configuration | M | M4 | T | ☐ |
| SIG-016 | Human review lane for flagged content with decision audit | M | M4 | T | ☐ |
| SIG-017 | Asset library with versioning, rights metadata and performance annotation | M | M4 | T | ☐ |
| SIG-018 | Winning-pattern memory improves subsequent generation per tenant | S | M4 | T | ☐ |
| SIG-019 | Landing pages rendered by a hosted engine with tenant branding and consent banners | M | M4 | T | ☐ |
| SIG-020 | Creative test velocity target met (variants produced and live per period) | M | M4 | M | ☐ |

### 6.3 Audiences & campaigns
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-025 | Audience builder over consented data with rule tree and size estimation | M | M4 | T | ☐ |
| SIG-026 | Suppression lists always applied and always visible in the builder | M | M4 | T,D | ☐ |
| SIG-027 | Bind-probability and predicted-LTV scoring available for targeting and bidding | M | M4 | T | ☐ |
| SIG-028 | Lookalike expansion with consent basis preserved | S | M4 | T | ☐ |
| SIG-029 | Audiences shareable to ORBIT journeys and SCOUT experiments | M | M4 | T | ☐ |
| SIG-030 | Campaign management across paid search, paid social, owned email and messaging | M | M4 | T | ☐ |
| SIG-031 | At least two major ad platform connectors ship in v1 | M | M4 | T | ☐ |
| SIG-032 | Value-based bidding signals exported to connected platforms (ADR-0112; adapters tested against mocks, not a live account) | S | M4 | T | ◐ |
| SIG-033 | Consistent UTM/attribution schema enforced across campaigns | M | M4 | T | ☐ |
| SIG-034 | Protected attributes excluded from targeting and scoring models | M | M4 | T,A | ☐ |

### 6.4 Budget autopilot
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-040 | Daily reallocation proposals based on marginal efficiency | M | M4 | T | ☐ |
| SIG-041 | Moves execute automatically only within tenant-configured bounds | M | M4 | T | ☐ |
| SIG-042 | Moves beyond bounds require approval with reasoning presented | M | M4 | T | ☐ |
| SIG-043 | Every move logged with inputs, reasoning and reversal option where possible | M | M4 | T | ☐ |
| SIG-044 | Anomaly guard auto-pauses on spend spike or tracking breakage and alerts | M | M4 | T | ☐ |
| SIG-045 | Global one-click pause of all autonomous spend activity | M | M4 | T | ☐ |
| SIG-046 | Autopilot uplift measured against a frozen-budget holdout | M | M4 | T,M | ☐ |

### 6.5 Search, answer engines, experiments, attribution
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-050 | Answer-engine content units with structured data, citations and freshness policy | M | M4 | T | ☐ |
| SIG-051 | Citation-share monitoring for target query clusters across major AI assistants | S | M4 | T,M | ☐ |
| SIG-052 | Technical SEO monitoring: web vitals, indexation, hreflang for ar/en, cannibalisation | M | M4 | T | ☐ |
| SIG-053 | Experiment registry with hypothesis, variants, metric and pre-declared analysis | M | M4 | T | ☐ |
| SIG-054 | Sequential/valid statistical inference; no conclusion without threshold | M | M4 | T | ☐ |
| SIG-055 | Experiment learnings library searchable across campaigns | S | M4 | T | ☐ |
| SIG-056 | Server-side first-party event collection with consent gating | M | M4 | T | ☐ |
| SIG-057 | Attribution reported as ranges with method disclosed; no false precision | M | M4 | T,A | ☐ |
| SIG-058 | Path/touch analysis to conversion available | S | M4 | T | ☐ |

### 6.6 Analytics, admin, developer
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SIG-065 | Analytics home: CAC trend, creative velocity, flag rate and review time, autopilot uplift, citation share, channel efficiency, cohort LTV | M | M4 | T,D | ☐ |
| SIG-066 | `[∫NOR]` Growth economics feed the executive brief automatically | M | M6 | T | ☐ |
| SIG-067 | Admin: brand kit, banned claims, disclosure templates | M | M4 | D | ☐ |
| SIG-068 | Admin: channel authorization, budget bounds, approval thresholds, suppression sources, kill switch | M | M4 | T,D | ☐ |
| SIG-069 | Developer: pixel/tag setup and debugger | M | M4 | T | ☐ |
| SIG-070 | Developer: catalog/feed endpoints, `signal.*` webhook tester, platform sandbox mocks, scoped keys | M | M4 | D | ☐ |

---

## 7. SCOUT — AI Products requirements

### 7.1 Sensing & clustering
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SCT-001 | External sources: search trends, review platforms, news, regulatory feeds, competitor page monitoring | M | M5 | T | ☐ |
| SCT-002 | Crawling honours robots directives and configurable politeness limits | M | M5 | T,A | ☐ |
| SCT-003 | Custom signal ingestion via API and CSV for standalone operation | M | M5 | T | ☐ |
| SCT-004 | `[∫AXIS]` Internal demand signals: quote requests, abandonment reasons, lost-quote reasons | M | M5 | T | ☐ |
| SCT-005 | `[∫ORB]` Conversation theme signals from quality summaries | M | M5 | T | ☐ |
| SCT-006 | Semantic clustering with momentum scoring (volume × growth × novelty) | M | M5 | T | ☐ |
| SCT-007 | Human-readable theme cards with representative evidence per cluster | M | M5 | T,D | ☐ |
| SCT-008 | Signal provenance retained for every clustered item | M | M5 | T | ☐ |

### 7.2 Radar & whitespace workbench
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SCT-015 | Radar visualises opportunities on demand × competition with momentum over time | M | M5 | D | ☐ |
| SCT-016 | Period-over-period comparison of the radar | M | M5 | T | ☐ |
| SCT-017 | Auto-drafted whitespace dossiers with description, evidence links, demand estimate, competition score | M | M5 | T,E | ☐ |
| SCT-018 | Regulatory considerations flagged for human/counsel review and never asserted as cleared | M | M5 | T,A | ☐ |
| SCT-019 | Lifecycle states candidate → validating → validated → parked with owner and decision log | M | M5 | T | ☐ |
| SCT-020 | Cold start: a first radar with evidenced candidates produced from a historical demand export alone | M | M5 | T,D | ☐ |
| SCT-021 | Seeded hypothesis playbooks available as starting templates | S | M5 | D | ☐ |
| SCT-022 | Quarterly radar report auto-assembled and exportable | M | M5 | T | ☐ |

### 7.3 Panel, price & competitor intelligence
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SCT-030 | `[∫AXIS]` Win-rate and price-index benchmarking by provider, line and segment | M | M5 | T | ☐ |
| SCT-031 | Coverage-term differences extracted from policy wordings and diffed across versions | M | M5 | T,E | ☐ |
| SCT-032 | Seeded wording change is detected by the differ on the reference set | M | M5 | T | ☐ |
| SCT-033 | Decline-pattern analysis by provider and segment | M | M5 | T | ☐ |
| SCT-034 | Negotiation pack generated as an evidence document in one action | M | M5 | T,D | ☐ |
| SCT-035 | Competitor tracking with page/pricing diff alerts and launch detection | M | M5 | T | ☐ |
| SCT-036 | Regulatory-change watch with flagged items routed to compliance | M | M5 | T | ☐ |
| SCT-037 | Bench coverage reported as a share of quote volume benchmarked | M | M5 | T,M | ☐ |

### 7.4 Experiments & data products
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SCT-045 | Test offers launchable as hosted landing experiments with traffic and spend caps | M | M5 | T | ☐ |
| SCT-046 | Standalone mini page engine when SIGNAL is absent; `[∫SIG]` uses the shared engine when present | M | M5 | T | ☐ |
| SCT-047 | Unavailable products display a mandatory honesty notice; no sale of non-existent cover | M | M5 | T,A | ☐ |
| SCT-048 | Qualified-demand funnel measurement with results appended to the dossier | M | M5 | T | ☐ |
| SCT-049 | Data products packaged from anonymised, consent-based aggregates | M | M5 | T | ☐ |
| SCT-050 | k-anonymity floor enforced (configurable upward only); any cell below the floor is suppressed | M | M5 | T | ☐ |
| SCT-051 | Consent basis recorded per data product and re-verified before each delivery | M | M5 | T | ☐ |
| SCT-052 | Subscriber management with scoped access and delivery logging | M | M5 | T | ☐ |
| SCT-053 | Data product delivery by API and scheduled report | M | M5 | T | ☐ |

### 7.5 Analytics, admin, developer
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SCT-060 | Analytics home: whitespaces validated, signal-to-dossier lead time, bench coverage, negotiation outcomes, data-product revenue, experiment cycle time | M | M5 | T,D | ☐ |
| SCT-061 | `[∫NOR]` Market intelligence surfaces in the executive brief | M | M6 | T | ☐ |
| SCT-062 | Admin: source manager, crawl policy, momentum thresholds, k-anonymity floor, export/consent policy, kill switch | M | M5 | T,D | ☐ |
| SCT-063 | Developer: signal ingest API, connector SDK with harness, embedding-search playground, `scout.*` webhooks, scoped keys | M | M5 | D | ☐ |

---

## 8. NORTH — AI Insights requirements

### 8.1 Metric layer & data inputs
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| NOR-001 | Metric registry with owner, versioned definition, target and sensitivity per metric | M | M6 | T | ☐ |
| NOR-002 | Definition changes require approval and annotate all affected charts from the change date | M | M6 | T | ☐ |
| NOR-003 | Metric lineage inspectable from any chart (definition, source, last refresh) | M | M6 | T,D | ☐ |
| NOR-004 | Standalone connectors: warehouse read, scheduled file import, metrics push API | M | M6 | T | ☐ |
| NOR-005 | `[∫all]` Co-deployed module metrics auto-register with no manual mapping | M | M6 | T | ☐ |
| NOR-006 | NORTH reads only views/snapshots, never module hot tables | M | M6 | T | ☐ |
| NOR-007 | Sensitivity mapping controls which roles/audiences see which metrics | M | M6 | T | ☐ |

### 8.2 The daily brief
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| NOR-010 | Brief generated on schedule per audience and locale (English and Arabic) | M | M6 | T,E | ☐ |
| NOR-011 | Brief is a written narrative that states what changed and why, numbers first | M | M6 | E,D | ☐ |
| NOR-012 | 100% of numeric claims in the brief machine-verified against the metric layer; unverified output never ships | M | M6 | T,E | ☐ |
| NOR-013 | Every claim links to its evidence (chart plus underlying query) | M | M6 | T | ☐ |
| NOR-014 | Suggestions are explicitly labelled as suggestions, distinct from actions taken | M | M6 | T,D | ☐ |
| NOR-015 | Delivery to app, email, messaging summary and mobile push per user preference | M | M6 | T | ☐ |
| NOR-016 | Brief generation failure alerts operators rather than publishing a degraded brief | M | M6 | T | ☐ |
| NOR-017 | Executive engagement measured (open/read rate) against target | M | M6 | M | ☐ |

### 8.3 Anomalies, scenarios, decisions
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| NOR-020 | Seasonal-aware anomaly detection per metric with configurable sensitivity | M | M6 | T | ☐ |
| NOR-021 | Automated driver decomposition attributes movement to dimensions with shares | M | M6 | T,E | ☐ |
| NOR-022 | Correlations labelled as correlation, never asserted as cause | M | M6 | T,A | ☐ |
| NOR-023 | Seeded anomaly in the reference dataset is detected and correctly attributed | M | M6 | T | ☐ |
| NOR-024 | Anomaly states tracked (new, explained, action created) with time-to-explanation measured | M | M6 | T,M | ☐ |
| NOR-025 | Action creation from an anomaly assigns owner and due date with follow-up | M | M6 | T | ☐ |
| NOR-026 | Scenario engine answers what-if questions from registered primitives on tenant data | M | M6 | T | ☐ |
| NOR-027 | Scenario outputs always present ranges, assumptions and confidence; never bare point estimates | M | M6 | T,A | ☐ |
| NOR-028 | Scenarios saved, shareable and revisitable with actuals overlay | M | M6 | T | ☐ |
| NOR-029 | Decision log records context, options, choice, owner and review date | M | M6 | T | ☐ |
| NOR-030 | Outcome review auto-drafted from subsequent metric movement at review date | S | M6 | T | ☐ |

### 8.4 Board room, posture, analytics, admin, developer
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| NOR-035 | Pack templates for executive, board and investor audiences | M | M6 | D | ☐ |
| NOR-036 | Pack auto-assembly from briefs, snapshots, decisions and module sections | M | M6 | T | ☐ |
| NOR-037 | In-app pack editing with version history | M | M6 | T | ☐ |
| NOR-038 | Branded PDF render in one action within published time budget | M | M6 | T,M | ☐ |
| NOR-039 | Distribution requires approval; recipients and reads logged | M | M6 | T | ☐ |
| NOR-040 | Board audience restricted to read-only surfaces enforced server-side | M | M6 | T | ☐ |
| NOR-041 | Compliance posture tile assembles live control signals for the compliance role | M | M6 | T,D | ☐ |
| NOR-042 | Analytics home: brief engagement, time-to-explanation, verification pass rate, scenario reuse, pack assembly time, decision-review timeliness | M | M6 | T,D | ☐ |
| NOR-043 | Admin: metric approvals, audience/sensitivity mapping, schedules, locales, targets, connectors, kill switch | M | M6 | T,D | ☐ |
| NOR-044 | Developer: connector setup, metrics push API, brief/anomaly webhooks, scenario primitive registration, scoped keys | M | M6 | D | ☐ |

---

## 9. JRN — End-to-end journey acceptance

Each journey is an automated end-to-end test tagged `@journey:J-XX`. The journey
passes only if every step criterion holds. These are the system's behavioural
contract — a module can be "feature complete" and still fail here.

| ID | Journey | Pass criteria | Pri | MS | Verify | Status |
|---|---|---|---|---|---|---|
| JRN-C1 | Consumer: get covered | Quick quote → ranked offers with declared criteria → document capture → payment redirect → policy delivered on channel; completes within published time target; zero human touches on happy path | M | M2 | T,M | ☐ |
| JRN-C2 | Consumer: get help | Inbound message in Arabic resolved by AI including policy copy and endorsement, with disclosure of AI, escalation available, transcript logged and quality-scored | M | M3 | T,E | ☐ |
| JRN-C3 | Consumer: renew in one tap | Pre-expiry offer with completed requote → single-tap acceptance → updated policy delivered; no data re-entry | M | M3 | T | ☐ |
| JRN-C4 | Consumer: privacy rights | Self-service access and erasure requests fulfilled within policy SLA, fully logged, derived stores purged and verified | M | M1 | T | ☐ |
| JRN-O1 | Ops: exception clearing | Agent works only the exceptions queue; copilot proposals present; median clear time within target; no raw inbox required | M | M2 | T,M | ☐ |
| JRN-O2 | Ops: group medical bid | Arbitrary-format census uploaded → normalised with gaps chased → provider pack issued → quotes compared → proposal document produced | M | M2 | T | ☐ |
| JRN-O3 | Ops: month-end reconciliation | Statements imported → auto-match at/above threshold → exceptions evidenced → sign-off bundle exported | M | M2 | T,M | ☐ |
| JRN-X1 | CX: handover catch | AI escalates mid-conversation; human receives summary and suggested actions; resolution recorded; QA score available next cycle | M | M3 | T | ☐ |
| JRN-X2 | Retention: save desk | Risk list produced → outreach with objection support → bounded price-match applied with approval → outcome and reason logged | M | M3 | T | ☐ |
| JRN-X3 | Partner: integrate | External developer self-onboards → sandbox transaction succeeds → certification passes → live credentials issued → first live transaction, without bespoke engineering support | M | M3 | T,D | ☐ |
| JRN-M1 | Marketing: campaign in a day | Brief → multilingual variants generated → compliance lane cleared → published to ≥2 channels → economics visible same day | M | M4 | T,M | ☐ |
| JRN-M2 | Marketing: budget morning | Autopilot proposals reviewed and approved/undone from mobile within minutes, with reasoning and evidence shown | M | M4 | T | ☐ |
| JRN-M3 | Marketing: own the answer box | Query cluster selected → content unit published → citation share tracked over successive periods | S | M4 | T,M | ☐ |
| JRN-P1 | Product: radar to validated | Whitespace promoted → experiment live → demand measured → validated or parked with evidence and decision recorded | M | M5 | T | ☐ |
| JRN-P2 | Product: panel negotiation | Bench alert → negotiation pack generated → outcome (commission/coverage change) recorded against the pack | M | M5 | T | ☐ |
| JRN-E1 | Exec: the morning read | Push received → brief read on mobile within minutes → anomaly triaged and action assigned, all before leaving the app | M | M6 | T,M | ☐ |
| JRN-E2 | Exec: board day | Pack assembled within time target → approved → distributed → read receipts visible | M | M6 | T,M | ☐ |
| JRN-E3 | Exec: what-if | Scenario asked in natural language → ranges and assumptions returned → saved → revisited with actuals | M | M6 | T | ☐ |
| JRN-A1 | Admin: new tenant in a day | Tenant created, branded (contrast validated), entitled, domained, seeded, smoke-tested — within one business day | M | M1 | T,M | ☐ |
| JRN-A2 | Admin: new teammate | Invite → role bundle assigned → access effective immediately and bounded exactly to the bundle | M | M0 | T | ☐ |
| JRN-A3 | Admin: incident pause | Module agents paused in one action → degraded-mode notice visible to users → resumed with audit note | M | M2 | T | ☐ |
| JRN-D1 | Developer: first call | Test key issued → SDK snippet succeeds → webhook received and verified → promotion to live gated by approval | M | M1 | T | ☐ |
| JRN-CO1 | Compliance: regulator request | Scope defined → signed evidence bundle exported (cases, conversations, AI actions) → delivered same business day | M | M2 | T,D | ☐ |
| JRN-999 | Every journey | Instrumented as a funnel with an owner and target; journey health visible in analytics | M | per-MS | T | ☐ |

---

## 10. UX — Frontend craft, ambient AI, personalization

### 10.1 Premium craft bar (applies to every screen at every release)
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| UX-001 | All six states designed and implemented: empty, loading, error, partial, offline, degraded-AI | M | per-MS | D | ☐ |
| UX-002 | Skeletons mirror final layout; no spinner shown for waits beyond the published threshold | M | per-MS | T,M | ☐ |
| UX-003 | Cumulative layout shift within published budget on load | M | per-MS | M | ☐ |
| UX-004 | Every action reachable by keyboard with sensible focus order and visible focus ring | M | per-MS | T | ☐ |
| UX-005 | Touch targets meet minimum size on all interactive elements | M | per-MS | T | ☐ |
| UX-006 | Dark and light themes both verified for every screen | M | per-MS | T,D | ☐ |
| UX-007 | Tenant accent applied with automated contrast validation | M | M1 | T | ☐ |
| UX-008 | Empty states teach the next action rather than stating absence | M | per-MS | D | ☐ |
| UX-009 | Error states state what happened, what the system did, what the user can do, plus a copyable trace id | M | per-MS | T,D | ☐ |
| UX-010 | Tabular numerals used for all metrics and money | M | per-MS | D | ☐ |
| UX-011 | Motion has a reduced-motion equivalent; motion never carries information alone | M | per-MS | T | ☐ |
| UX-012 | Print/PDF output clean for briefs, packs and evidence bundles | M | M6 | D | ☐ |
| UX-013 | Screen-reader pass completed on primary workspaces each release | M | per-MS | D | ☐ |
| UX-014 | RTL rendering flawless on every screen (no mirrored-icon or truncation defects) | M | per-MS | T,D | ☐ |
| UX-015 | Interaction latency budgets met for keystroke echo, optimistic commit, warm navigation | M | per-MS | M | ☐ |
| UX-016 | AI streaming first-token budget met for cloud and on-prem targets | M | M3 | M | ☐ |
| UX-017 | Long operations report named progress steps rather than an indeterminate wait | M | M2 | D | ☐ |

### 10.2 Ambient AI grammar
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| UX-020 | A single consistent marker denotes AI-generated content platform-wide; no other AI iconography | M | M2 | T,D | ☐ |
| UX-021 | AI never interrupts with modals or toasts on its own initiative | M | M2 | D | ☐ |
| UX-022 | Ghost-text completion available wherever the user writes; single-keystroke accept; typing dismisses | M | M3 | T | ☐ |
| UX-023 | Prediction chips show confidence and reveal their reasoning on hover/tap | M | M3 | T | ☐ |
| UX-024 | Background AI work surfaces in a review tray, not as an interruption | M | M3 | T | ☐ |
| UX-025 | Forecast strip limited to a small ranked set with one action and a learning dismissal | M | M4 | T,D | ☐ |
| UX-026 | Every AI-produced value explains itself within one interaction (source, confidence, model, time) | M | M2 | T | ☐ |
| UX-027 | Presence escalates with stakes: informational chip → suggestion → approval with full reasoning | M | M3 | T,D | ☐ |
| UX-028 | Per-user digest of AI activity (drafts accepted, actions taken, time saved) available | S | M4 | T | ☐ |
| UX-029 | Autonomous actions offer one-click reversal within the stated window where the domain permits | M | M4 | T | ☐ |
| UX-030 | No fabricated precision in AI-presented figures; ranges shown where uncertainty exists | M | M6 | T,A | ☐ |

### 10.3 Role personalization (Lens)
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| UX-035 | Each role has a default workspace, density and vocabulary set | M | M6 | D | ☐ |
| UX-036 | Pinned items and saved views persist and surface first for the user | M | M6 | T | ☐ |
| UX-037 | Command palette learns the user's frequent actions | S | M6 | T | ☐ |
| UX-038 | Time-of-day and cycle-aware arrangement (e.g. reading mode in the morning, reconciliation at period end) | S | M6 | T,D | ☐ |
| UX-039 | Density and power features unlock progressively with explicit user acceptance, never silently | M | M6 | T | ☐ |
| UX-040 | "Why am I seeing this?" available on every personalized element | M | M6 | T | ☐ |
| UX-041 | Per-surface and global reset to defaults available | M | M6 | T | ☐ |
| UX-042 | Personalization state is per-user, exportable and erasable under privacy rules | M | M6 | T | ☐ |
| UX-043 | Lens state synchronises between web and mobile | M | M6 | T | ☐ |

---

## 11. MOB — Mobile application

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| MOB-001 | Single app adapts navigation and default screen to the signed-in role | M | M6 | T | ☐ |
| MOB-002 | Biometric unlock with secure credential storage | M | M6 | T | ☐ |
| MOB-003 | Executive brief readable as a designed reading experience, not a shrunken dashboard | M | M6 | D | ☐ |
| MOB-004 | Anomaly triage by swipe with assign/snooze/explain | M | M6 | T | ☐ |
| MOB-005 | Unified approvals centre spanning all modules in one queue | M | M6 | T | ☐ |
| MOB-006 | Consequential approvals require biometric confirmation | M | M6 | T | ☐ |
| MOB-007 | Every approval card shows the AI's reasoning summary and an evidence link | M | M6 | T | ☐ |
| MOB-008 | Reversibility state labelled on each approval card | M | M6 | T,D | ☐ |
| MOB-009 | Guided document capture with edge detection and quality warnings | M | M6 | T,D | ☐ |
| MOB-010 | Background upload with retry and result notification | M | M6 | T | ☐ |
| MOB-011 | Agent pocket console: triage, quick replies, draft acceptance, handover | M | M6 | T | ☐ |
| MOB-012 | Offline read of role-relevant data with explicit staleness indication | M | M6 | T | ☐ |
| MOB-013 | Offline mutations queue and replay with conflict surfacing | M | M6 | T | ☐ |
| MOB-014 | Notification channels separated (critical, approvals, brief, activity) and quiet-hours aware | M | M6 | T | ☐ |
| MOB-015 | Deep links open the exact object; web/app link parity | M | M6 | T | ☐ |
| MOB-016 | Screenshot protection on sensitive screens, tenant-configurable | S | M6 | T | ☐ |
| MOB-017 | Remote session revocation effective on next request | M | M6 | T | ☐ |
| MOB-018 | Board/read-only builds enforce restrictions server-side, not merely in UI | M | M6 | T | ☐ |
| MOB-019 | Cold start, list smoothness and crash-free session targets met | M | M6 | M | ☐ |
| MOB-020 | Full RTL and dynamic-type support with accessibility pass on primary flows | M | M6 | T,D | ☐ |
| MOB-021 | Whitelabel build configuration (name, icon, palette) without code changes | S | v1.1 | D | ☐ |

---

## 12. ADM / DEV — Admin surfaces & developer platform

### 12.1 Module and tenant administration
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ADM-001 | Every module ships its own admin console sufficient to operate it standalone | M | per-MS | D | ☐ |
| ADM-002 | Every module ships a kill switch, health tiles and AI-spend visibility | M | per-MS | T | ☐ |
| ADM-003 | All settings changes produce a diff and an audit entry | M | M1 | T | ☐ |
| ADM-004 | Schema-driven settings forms with validation and safe defaults | M | M1 | D | ☐ |
| ADM-005 | Tenant admin: people, roles, SSO group mapping, deactivation | M | M1 | T | ☐ |
| ADM-006 | Tenant admin: brand studio with live preview and contrast report before save | M | M1 | T,D | ☐ |
| ADM-007 | Tenant admin: policies (auto-approve allowlist, AI budget, retention, locales, quiet hours) | M | M1 | T | ☐ |
| ADM-008 | Tenant admin: entitlement view and upgrade request path | M | M1 | D | ☐ |
| ADM-009 | Tenant admin: usage meters and invoices (seats, tokens, API calls) | M | M1 | T | ☐ |
| ADM-010 | Tenant admin: consent registry search per customer | M | M1 | T | ☐ |
| ADM-011 | Tenant admin: data tools (import wizards, export, erasure trigger) | M | M1 | T | ☐ |
| ADM-012 | Tenant admin: integrations directory showing granted scopes with disconnect | M | M1 | T | ☐ |
| ADM-013 | Tenant admin: audit search and signed bundle export | M | M1 | T | ☐ |
| ADM-014 | Low-code builders (journeys, SOPs, audiences, metrics, pages) all support draft → review → publish with diff and rollback | M | per-MS | T | ☐ |
| ADM-015 | Simulate/dry-run available before publishing any builder artifact | M | per-MS | T | ☐ |

### 12.2 Platform administration
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| ADM-020 | Tenant lifecycle automation (create, suspend, resume, delete with safeguards) | M | M1 | T | ☐ |
| ADM-021 | Entitlement and plan management with immediate effect | M | M1 | T | ☐ |
| ADM-022 | Global feature flags with staged per-tenant rollout percentages | M | M1 | T | ☐ |
| ADM-023 | DLQ browse, inspect and replay | M | M1 | T | ☐ |
| ADM-024 | Model gateway operations: provider health, routing override, global budget guard | M | M1 | T | ☐ |
| ADM-025 | Cost explorer per tenant (AI, storage, egress) with unit-cost drift alerting | M | M1 | T | ☐ |
| ADM-026 | Status publishing and in-app release notes per module | S | M1 | D | ☐ |

### 12.3 Developer platform
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| DEV-001 | Test and live API keys, scoped by module and permission, with rotation and last-used | M | M1 | T | ☐ |
| DEV-002 | Generated API reference always matching deployed routes | M | M1 | T | ☐ |
| DEV-003 | Typed client SDK published per release with contract tests | M | M1 | T | ☐ |
| DEV-004 | Deterministic sandbox tenant with scenario seeding and reset | M | M1 | T | ☐ |
| DEV-005 | Webhook studio: register, send test events, inspect signature and payload, replay | M | M1 | T | ☐ |
| DEV-006 | Request and AI-call logs with trace id search, redacted appropriately | M | M1 | T | ☐ |
| DEV-007 | Idempotency honoured on all mutating endpoints for the published window | M | M1 | T | ☐ |
| DEV-008 | Rate limits enforced per key with standards-compliant responses | M | M1 | T | ☐ |
| DEV-009 | Error responses follow a single documented problem format including trace id | M | M1 | T | ☐ |
| DEV-010 | Pagination, filtering and field selection consistent across all collections | M | M1 | T | ☐ |
| DEV-011 | API versioning with additive-change policy and documented sunset for breaking changes | M | M1 | A | ☐ |
| DEV-012 | Command-line tool for login, keys, seeding, log tail | S | M1 | D | ☐ |
| DEV-013 | Extension manifest format defined and validated; first-party connectors packaged as extensions | S | M5 | T | ☐ |

---

## 13. DEP — Deployment & parity

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| DEP-001 | Local development runs the full stack with one command | M | M0 | T | ☐ |
| DEP-002 | Three environments (local, staging, production) with isolated credentials and data | M | M1 | D | ☐ |
| DEP-003 | Preview deployment per pull request with seeded sandbox | M | M1 | T | ☐ |
| DEP-004 | Migrations are forward-only, applied automatically before deploy, and never edited after application | M | M1 | T | ☐ |
| DEP-005 | Production deploy gated by manual approval after staging smoke journeys pass | M | M1 | D | ☐ |
| DEP-006 | Rollback path documented and rehearsed for app and schema | M | M1 | D | ☐ |
| DEP-007 | Backups scheduled with retention; restore drill performed and documented periodically | M | M1 | D,A | ☐ |
| DEP-008 | Custom tenant domains provisioned with automated certificates | M | M1 | T | ☐ |
| DEP-009 | Secrets managed per environment outside source control, with rotation | M | M1 | A | ☐ |
| DEP-010 | On-prem stack deploys from a single compose definition with an internal model server | M | M6 | T,D | ☐ |
| DEP-011 | On-prem runs the same application code paths; compliance features do not fork | M | M6 | T | ☐ |
| DEP-012 | On-prem supports air-gapped installation with offline images, weights and local licence validation | S | M6 | D | ☐ |
| DEP-013 | Internal model must pass the same eval thresholds before a tier is assigned | M | M6 | E | ☐ |
| DEP-014 | Capability parity matrix published; every gap has an explicit in-product notice, never silent degradation | M | M6 | T,D | ☐ |
| DEP-015 | On-prem install, migrate, seed and smoke commands documented and working | M | M6 | T | ☐ |
| DEP-016 | On-prem upgrade path (pull, migrate, restart) documented and rehearsed | M | M6 | D | ☐ |
| DEP-017 | All five modules functional on-prem | M | M6 | T | ☐ |

---

## 14. SEC — Security, privacy & AI governance

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SEC-001 | Transport encryption enforced everywhere; encryption at rest for all stores | M | M1 | D | ☐ |
| SEC-002 | Field-level encryption for national identifiers and bank details | M | M2 | T | ☑ |
| SEC-003 | Card data never stored; payment handled by tokenised providers only | M | M2 | T,A | ☐ |
| SEC-004 | Input validation at every boundary with schema enforcement | M | M1 | T | ☐ |
| SEC-005 | Outbound fetch protected against server-side request forgery with host allowlisting | M | M1 | T | ☐ |
| SEC-006 | Secrets never present in code, logs or model prompts (automated scanner) | M | M1 | T | ☐ |
| SEC-007 | Dependency and image vulnerability scanning on a schedule with triage SLA | M | M1 | T | ☐ |
| SEC-008 | Baseline dynamic security scan in CI | M | M1 | T | ☐ |
| SEC-009 | Penetration test before general availability and periodically thereafter | M | pre-GA | A | ☐ |
| SEC-010 | Responsible-disclosure channel published | S | pre-GA | D | ☐ |
| SEC-011 | Data-processing register generated from the purposes map | M | M2 | T | ☐ |
| SEC-012 | Breach response runbook with notification checklist, contact tree and evidence preservation | M | M2 | A | ☐ |
| SEC-013 | Breach tabletop exercise conducted and minuted periodically | M | M2 | A | ☐ |
| SEC-014 | Cross-border transfer controls gate provider selection and storage region by tenant policy | M | M2 | T | ☐ |
| SEC-015 | Data-residency policy can force in-region or on-prem model serving | M | M6 | T | ☐ |
| SEC-016 | Minimum-necessary field whitelisting for every AI context builder | M | M1 | T | ☐ |
| SEC-017 | Human accountability preserved: no autonomous regulated advice, pricing or claims decisions | M | M3 | T,A | ☐ |
| SEC-018 | Fairness review for value/risk models with protected attributes excluded and proxy audits scheduled | M | M4 | T,A | ☐ |
| SEC-019 | Red-team suite for prompt injection, tool escape and exfiltration runs in CI | M | M3 | T | ☐ |
| SEC-020 | External content treated strictly as data, never as instructions to agents | M | M3 | T | ☐ |
| SEC-021 | Regulatory rulepacks versioned as data; guardrail floors read from the pack, not code | M | M5 | T | ☐ |
| SEC-022 | Regulatory positions and customer-facing legal copy reviewed by qualified counsel before launch | M | pre-GA | A | ☐ |
| SEC-023 | Compliance evidence map maintained: each control linked to its verifying artifact | M | M6 | A | ☐ |
| SEC-024 | Kill switches tested on a schedule with results recorded | M | M2 | T | ☐ |

---

## 15. NFR — Non-functional requirements

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| NFR-001 | Non-AI API latency within published percentile budget under expected load | M | M1 | M | ☐ |
| NFR-002 | Web primary-content load and interaction budgets met on a mid-tier mobile connection | M | M1 | M | ☐ |
| NFR-003 | Route payload budgets enforced in CI | M | M1 | M | ☐ |
| NFR-004 | Load tested at a multiple of projected peak with published thresholds as assertions | M | M3 | M | ☐ |
| NFR-005 | Concurrent conversation scale target met with per-message latency budget | M | M3 | M | ☐ |
| NFR-006 | Queue backlog drain rate sufficient to clear projected peak within target window | M | M3 | M | ☐ |
| NFR-007 | Availability objective defined per service with error budget policy and freeze rule | M | M1 | A | ☐ |
| NFR-008 | Graceful degradation on model-provider failure via tier fallback, exercised by drill | M | M3 | T | ☐ |
| NFR-009 | Graceful degradation on channel-provider outage with queueing and user notice | M | M3 | T | ☐ |
| NFR-010 | Accessibility conformance target met on all primary surfaces, verified automatically and manually | M | per-MS | T,D | ☐ |
| NFR-011 | Pseudo-locale and RTL build renders without layout breakage | M | M0 | T | ☐ |
| NFR-012 | Observability: structured logs, metrics and traces with trace id propagation end to end | M | M1 | T | ☐ |
| NFR-013 | Unit-economics telemetry (cost per case, per conversation, per brief) tracked with drift alerts | M | M2 | T | ☐ |
| NFR-014 | Data archival strategy keeps hot stores within operating limits | S | M4 | D | ☐ |
| NFR-015 | Mutation-test score threshold met on core and gateway packages, ratcheting upward only | M | M1 | T | ☐ |
| NFR-016 | Flaky tests quarantined and resolved within the published window; quarantine list trends to zero | M | M1 | A | ☐ |
| NFR-017 | Documentation kept current: any behaviour diverging from specs blocks merge | M | per-MS | A | ☐ |

---

## 16. SEAM — Future-horizon readiness (docs/16 "NOW" obligations)

These prove the architecture will not need a rebuild. Each requires at least one
passing contract test tagged `@seam:Hx` by M6 close.

| ID | Horizon | Requirement (built now) | Pri | MS | Verify | Status |
|---|---|---|---|---|---|---|
| SEAM-H1 | Agentic commerce | `agent` channel type, signed machine-readable offer schema, delegated-mandate structure referenced by the bind path | M | M3 | T | ☐ |
| SEAM-H2 | Autonomy ladder | Autonomy level and envelope declared per agent; reversal function or L1 cap enforced | M | M3 | T | ☐ |
| SEAM-H3 | Voice & multimodal | Modality enum on messages, normalised transcript convention, speech-provider seam | M | M3 | T | ☐ |
| SEAM-H4 | Open finance | Data-in connector interface with mandatory consent-purpose binding; external-standard mapping field on products | M | M4 | T | ☐ |
| SEAM-H5 | Digital identity | Identity-verifier seam and verification record with evidence level consumed by all KYC touchpoints | M | M2 | T | ☐ |
| SEAM-H6 | Sensor/usage pricing | Timeseries ingest interface; declared pricing-inputs field enforced at quote time | M | M5 | T | ☐ |
| SEAM-H7 | Parametric products | Parametric trigger definition field on products, null for conventional | S | M5 | T | ☐ |
| SEAM-H8 | Takaful | Product structure flag and takaful attributes; disclosure templates keyed by structure | M | M2 | T | ☐ |
| SEAM-H9 | Premium financing | Payment-plan structure on policies; financier provider kind; revenue-share generalisation | S | M2 | T | ☐ |
| SEAM-H10 | Marketplace | Extension manifest validated in the developer harness; first-party connectors shipped as extensions | S | M5 | T | ☐ |
| SEAM-H11 | Compounding intelligence | Memory store with provenance, sensitivity, expiry and privacy controls; versioned scenario primitives | M | M6 | T | ☐ |
| SEAM-H12 | Regulation as data | Rulepack schema with market/version/effective date; one live pack in production use | M | M5 | T | ☐ |
| SEAM-999 | All | No documented seam is bypassed or removed without an approved decision record | M | M6 | A | ☐ |

---

## 17. Traceability & benching procedure

### 17.1 Required traceability
Every requirement must link to: (a) the spec section it derives from, (b) the
test(s) or evidence that verify it, (c) the commit/PR that implemented it. Keep
this as a machine-readable file at `docs/traceability.csv` with columns:
`req_id, spec_ref, test_ref, evidence_ref, status, verified_by, verified_at`.
CI fails if any `M` requirement marked `☑` has no `test_ref` or `evidence_ref`.

### 17.2 How to bench a build
1. Export the register to `traceability.csv` (one row per ID above).
2. Tag tests with requirement IDs (e.g. `it("AXIS-024: motor happy path …")`)
   so coverage can be computed automatically from test names.
3. Run the suite; generate a coverage report per prefix:
   `☑ M / total M`, `◐`, `☐`, `⊘`.
4. Review every `⊘` waiver with its approver and expiry.
5. Publish the scorecard with each milestone close (§17.3).

### 17.3 Milestone scorecard template
| Prefix | Must total | ☑ | ◐ | ☐ | ⊘ | % Must complete |
|---|---|---|---|---|---|---|
| PLAT | | | | | | |
| ANL | | | | | | |
| ROLE | | | | | | |
| AXIS | | | | | | |
| ORB | | | | | | |
| SIG | | | | | | |
| SCT | | | | | | |
| NOR | | | | | | |
| JRN | | | | | | |
| UX | | | | | | |
| MOB | | | | | | |
| ADM/DEV | | | | | | |
| DEP | | | | | | |
| SEC | | | | | | |
| NFR | | | | | | |
| SEAM | | | | | | |
| **Total** | | | | | | |

### 17.4 Release gates (all must hold)
- No `M` requirement at `☐` for any milestone at or before the release.
- All `JRN` journeys for shipped modules passing.
- Eval thresholds green; injection suite at 100%.
- Accessibility, performance and mutation gates green.
- Counsel sign-off recorded for `SEC-022` before any public launch.
- Trademark clearance recorded before the house mark appears publicly.

### 17.5 Change control
New requirements get the next free ID in their prefix and a rationale line.
Removing or downgrading a `M` requirement needs a decision record naming the
approver and the risk accepted. This register is versioned with the code.

---

## 18. Sign-off

| Area | Owner | Verified (date) | Signature |
|---|---|---|---|
| Platform & security | | | |
| AXIS | | | |
| ORBIT | | | |
| SIGNAL | | | |
| SCOUT | | | |
| NORTH | | | |
| Frontend & mobile experience | | | |
| Deployment (cloud & on-prem) | | | |
| Compliance & legal (incl. counsel) | | | |
| Product owner (acceptance) | | | |

**Caveat.** Thresholds referenced as "published" live in the specs
(`docs/07 §7`, `docs/13`, `docs/15 §2`) so numbers change in one place only.
Regulatory obligations in `SEC` are engineering controls, not legal advice;
`SEC-022` (counsel review) gates public launch.

---

## 19. TXN — Transactions & ledger (docs/19)

### 19.1 Transaction framework
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| TXN-001 | Every transaction carries the full envelope of docs/19 §2 including actor, autonomy level and guardrail results | M | P1 | T | ☐ |
| TXN-002 | Idempotency key enforced per (tenant, type, key); replay returns the original and posts nothing new | M | P1 | T | ☐ |
| TXN-003 | Canonical state machine implemented incl. `pending_external` with timeout and compensation | M | P1 | T | ☐ |
| TXN-004 | Completed transactions and posted journal lines are immutable; corrections are contra transactions referencing the original | M | P1 | T | ☐ |
| TXN-005 | Failed and rejected transactions never post journal lines | M | P1 | T | ☐ |
| TXN-006 | Every transaction type is schema-validated against its version | M | P1 | T | ☐ |
| TXN-007 | Saga engine with per-step compensation; partial success impossible | M | P2 | T | ☐ |
| TXN-008 | Stalled sagas alert rather than expiring silently | M | P2 | T | ☐ |
| TXN-009 | Transaction APIs: create with idempotency header, read, reverse, adjust (permissioned, reason-coded) | M | P1 | T | ☐ |
| TXN-010 | Every transaction emits `txn.{type}.{state}` events consumed idempotently | M | P1 | T | ☐ |

### 19.2 Transaction catalogue coverage
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| TXN-020 | Distribution lifecycle transactions implemented (quote request, panel quote, presentation, bind, group bind, endorse, cancel, lapse, reinstate, renew) | M | P2 | T | ☐ |
| TXN-021 | FNOL registration recorded as guidance-only with no adjudication capability | M | P3 | T,A | ☐ |
| TXN-022 | Claim status synchronisation from provider | S | P3 | T | ☐ |
| TXN-023 | Money-in transactions: premium collection, instalment, deposit, PSP settlement, chargeback and chargeback reversal | M | P2 | T | ☐ |
| TXN-024 | Money-out transactions: premium remittance, refund, payout instruction, revenue-share settlement, creator payout, supplier payment | M | P2 | T | ☐ |
| TXN-025 | Earnings transactions: commission accrual/settlement/clawback, brokerage fee, service fee, referral qualify/settle, financing commission, revenue-share accrual, advertising placement | M | P2 | T | ☐ |
| TXN-026 | Subscription and usage transactions: create, invoice, recognise, change with proration, cancel, usage meter, overage, credit note, dunning | M | P4 | T | ☐ |
| TXN-027 | Success-fee transaction cannot post without a verified metric snapshot reference | M | P6 | T | ☐ |
| TXN-028 | Client-money transactions: receipt, permitted transfer, reconciliation, breach flag | M | P2 | T | ☐ |
| TXN-029 | Partner transactions: onboarding, partner quote, partner bind, revenue-share adjustment | M | P3 | T | ☐ |
| TXN-030 | Marketplace transactions: extension install with scope consent, extension revenue share | S | P7 | T | ☐ |
| TXN-031 | Marketing transactions: media commit, media spend, budget move, publish, boost, creator brief, creator verify | M | P4 | T | ☐ |
| TXN-032 | Data-product transactions: subscription, delivery with k-anonymity gate enforced pre-send | M | P5 | T | ☐ |
| TXN-033 | AI transactions: model-call metering and budget-stop | M | P1 | T | ☐ |
| TXN-034 | Compliance transactions: consent grant/withdraw, KYC verify, sanctions screen, disclosure present, approval decision, DSAR fulfilment, audit export | M | P1 | T | ☐ |
| TXN-035 | Agentic transactions: mandate register, agent quote with signed offer, agent bind enforcing cap and validity, mandate revoke | S | P3 | T | ☐ |
| TXN-036 | Takaful surplus distribution recorded where the structure applies | S | P5 | T | ☐ |
| TXN-037 | Parametric trigger requires dual-source confirmation before any payout instruction | M | P5 | T | ☐ |
| TXN-038 | Telematics ingestion and usage-based repricing recorded with declared inputs only | C | v1.1 | T | ☐ |

### 19.3 Ledger
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| TXN-050 | Double-entry posting engine; every batch balances in transaction and base currency | M | P1 | T | ☐ |
| TXN-051 | Chart of accounts per docs/19 §5.1, tenant-scoped and extensible | M | P1 | T | ☐ |
| TXN-052 | Worked flow A (commission-only) posts exactly as specified | M | P2 | T | ☐ |
| TXN-053 | Worked flow B (broker-collected client money) posts exactly as specified | M | P2 | T | ☐ |
| TXN-054 | Client-money invariant: segregated cash ≥ client-money liability at every instant | M | P2 | T | ☐ |
| TXN-055 | No journal may debit a client-money asset to credit income or operating expense | M | P2 | T | ☐ |
| TXN-056 | Client-money shortfall raises a hard alarm and blocks further transfers | M | P2 | T | ☐ |
| TXN-057 | Worked flow C (partner revenue share) posts exactly as specified | M | P3 | T | ☐ |
| TXN-058 | Worked flow D (subscription + overage with deferred revenue) posts exactly as specified | M | P4 | T | ☐ |
| TXN-059 | Worked flow E (premium financing) posts exactly as specified | S | P4 | T | ☐ |
| TXN-060 | Media spend and AI cost accruals feed per-unit economics telemetry | M | P4 | T | ☐ |
| TXN-061 | Multi-currency: FX rate and base amount stamped at posting; period-end revaluation of open balances | M | P4 | T | ☐ |
| TXN-062 | Tax treatment driven by market rulepack, never inferred in code | M | P4 | T | ☐ |
| TXN-063 | Period lifecycle: open → soft-close (reason-coded adjustments) → hard-close (contra only) | M | P4 | T | ☐ |
| TXN-064 | Trial balance equals the sum of all journal lines at any point in time | M | P1 | T | ☐ |
| TXN-065 | Revenue recognition never exceeds amounts invoiced | M | P4 | T | ☐ |

### 19.4 Reconciliation, settlement, approvals
| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| TXN-070 | Insurer statement reconciliation with matched, variance and missing-both-ways queues | M | P2 | T | ☐ |
| TXN-071 | PSP settlement reconciliation clearing the clearing account to zero with fee recognition | M | P2 | T | ☐ |
| TXN-072 | Client-money reconciliation producing a segregation proof bundle | M | P2 | T,D | ☐ |
| TXN-073 | Partner statement reconciliation with dispute adjustments | M | P3 | T | ☐ |
| TXN-074 | Media invoice reconciliation with accrual true-up | S | P4 | T | ☐ |
| TXN-075 | Matching engine: deterministic keys, then tolerance matching, then AI proposals that require human confirmation | M | P2 | T | ☐ |
| TXN-076 | AI-proposed matches are never auto-posted | M | P2 | T | ☐ |
| TXN-077 | Settlement run cannot be approved with open exceptions | M | P3 | T | ☐ |
| TXN-078 | Period close produces a signed, immutable close pack | M | P4 | T,D | ☐ |
| TXN-079 | Dual control enforced (approver ≠ initiator) for refunds above threshold, all payouts, client-money transfers and settlement batches | M | P2 | T | ☐ |
| TXN-080 | No transaction type debiting client money, issuing a payout or crossing a regulatory floor can be added to an auto-approve allowlist | M | P2 | T | ☐ |
| TXN-081 | Ledger Explorer renders posted entries with no edit affordance present in the DOM | M | P2 | T | ☐ |
| TXN-082 | Money always displayed with currency and base-currency equivalent | M | P2 | T | ☐ |
| TXN-083 | Reversal of any settled transaction yields net-zero economics with the original intact | M | P1 | T | ☐ |
| TXN-084 | Random saga interruption at any step ends settled or fully compensated | M | P2 | T | ☐ |

---

## 20. SOC — Content production & social engine (docs/20)

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| SOC-001 | The business can run marketing end to end without third-party management or production tooling | M | P4 | D,A | ☐ |
| SOC-002 | Brief generator produces evidence-linked briefs; `[∫SCOUT]` whitespace auto-generates launch briefs | M | P4 | T | ☐ |
| SOC-003 | `[∫ORBIT]` Voice-of-customer angles mined from conversations under privacy filters | S | P4 | T | ☐ |
| SOC-004 | `[∫AXIS]` Creative reads the live product record so claims cannot contradict the product | M | P4 | T | ☐ |
| SOC-005 | Copy studio covers long-form, short-form, conversational and disclosure copy | M | P4 | T | ☐ |
| SOC-006 | Arabic and English authored natively with dialect register selection | M | P4 | E,A | ☐ |
| SOC-007 | Brand voice model and claim library with substantiation links enforced | M | P4 | T | ☐ |
| SOC-008 | Variant matrix generation across angle × audience × platform × length | M | P4 | T | ☐ |
| SOC-009 | Brand-locked visual template system with safe areas and type scale | M | P4 | T | ☐ |
| SOC-010 | Generative imagery with brand style presets, background handling and on-image RTL text | M | P4 | T | ☐ |
| SOC-011 | Automatic derivation of all required aspect ratios with safe-area validation | M | P4 | T | ☐ |
| SOC-012 | No synthetic likeness of a real person without a stored consent record | M | P4 | T,A | ☐ |
| SOC-013 | Video studio: script → storyboard → assembly with captions and per-platform cut-downs | M | P4 | T | ☐ |
| SOC-014 | Voiceover synthesis in Arabic and English with dialect options | S | P4 | T | ☐ |
| SOC-015 | Music, fonts, stock and footage used only under a stored licence reference | M | P4 | T,A | ☐ |
| SOC-016 | Asset library with versioning, rights, usage log, expiry and performance annotation | M | P4 | T | ☐ |
| SOC-017 | Every asset records creator (human/AI), model and prompt version, approvals and compliance decision | M | P4 | T | ☐ |
| SOC-018 | Market packs with cultural sensitivity rules and calendar awareness | M | P4 | D | ☐ |
| SOC-019 | Mandatory human review lane for Arabic creative before first publish | M | P4 | T | ☐ |
| SOC-020 | Compliance pre-flight blocks publish without a pass token; bypass impossible by configuration | M | P4 | T | ☐ |
| SOC-021 | Mandatory disclosures auto-appended by product line and channel format | M | P4 | T | ☐ |
| SOC-022 | AI-content disclosure applied where platform policy requires it | M | P4 | T | ☐ |
| SOC-023 | Unified calendar with channel lanes, embargoes, blackout windows and per-market timezones | M | P4 | T,D | ☐ |
| SOC-024 | Per-platform adaptation of caption, hashtags, mentions, links, threads and alt text | M | P4 | T | ☐ |
| SOC-025 | Publish queue with retry, rate-limit awareness and per-channel partial-failure surfacing | M | P4 | T | ☐ |
| SOC-026 | Every publish attempt recorded as a transaction with the platform's returned id or its own error text | M | P4 | T | ☐ |
| SOC-027 | Assisted-publish fallback where direct posting is restricted, explicitly labelled in UI | M | P4 | T,D | ☐ |
| SOC-028 | Approval routing before scheduling; scheduled items diffable and cancellable to cut-off | M | P4 | T | ☐ |
| SOC-029 | Social inbox aggregating comments, mentions, DMs and reviews where permitted, with sentiment/intent/language | M | P4 | T | ☐ |
| SOC-030 | `[∫ORBIT]` Service-intent items become conversations with full context; standalone provides internal inbox | M | P4 | T | ☐ |
| SOC-031 | Listening monitors for brand, competitor, category and campaign with share-of-voice | M | P4 | T | ☐ |
| SOC-032 | Crisis detection with a defined escalation path and owner | M | P4 | T | ☐ |
| SOC-033 | Moderation with policy-based hiding/escalation and regulated-complaint routing | M | P4 | T | ☐ |
| SOC-034 | Creator operations: discovery, vetting, briefs, deliverable tracking, disclosure verification before payout | S | P4 | T | ☐ |
| SOC-035 | In-house paid media buying: campaign build, audience push, creative rotation, bid/budget strategy | M | P4 | T | ☐ |
| SOC-036 | Owned channels: web/blog CMS, landing pages, email, SMS/push, WhatsApp templates — all consent-gated | M | P4 | T | ☐ |
| SOC-037 | SEO and AEO content operations with schema markup, freshness SLAs and citation monitoring | M | P4 | T | ☐ |
| SOC-038 | Launch orchestration gates from evidence to measurement, each with owner, checklist and state | M | P4 | T,D | ☐ |
| SOC-039 | Unified analytics across organic, paid and owned with incrementality views and disclosed method | M | P4 | T | ☐ |
| SOC-040 | No inauthentic-behaviour capability: no fake engagement, bulk unsolicited DMs or multi-account manipulation | M | P4 | T,A | ☐ |
| SOC-041 | Channel connectors declare permissions used and policy limits respected, with health and scope state visible | M | P4 | T | ☐ |
| SOC-042 | Composer renders live per-platform previews in Arabic and English with genuine RTL behaviour | M | P4 | T,D | ☐ |

---

## 21. EDN / DOM — Editions, packaging & domain packs (docs/21)

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| EDN-001 | Every edition (Bots, Ops, Social, Radar, Insights, Suite) boots, seeds and passes its own smoke journeys with all other modules disabled | M | P7 | T | ☐ |
| EDN-002 | Entitlements enforced at the gateway and drive UI visibility from the same object | M | P1 | T | ☐ |
| EDN-003 | Unlicensed module routes return 403, not partial behaviour | M | P1 | T | ☐ |
| EDN-004 | Integration-tagged capabilities check entitlement at render and call time | M | P1 | T | ☐ |
| EDN-005 | Dormant seams show the standalone path plus a single explanatory note — never an error, dead control or silent no-op | M | P1 | T,D | ☐ |
| EDN-006 | Licensing an additional module lights up integrated behaviour with no data migration | M | P7 | T | ☐ |
| EDN-007 | Removing an entitlement retains historical records read-only with an explicit banner | M | P7 | T | ☐ |
| EDN-008 | Time-boxed trials with automatic reversion and stated retention policy | S | P7 | T | ☐ |
| EDN-009 | Metered units per edition recorded as usage transactions so invoices are reconstructible from the ledger | M | P4 | T | ☐ |
| EDN-010 | Success-fee billing requires a verified metric snapshot | M | P6 | T | ☐ |
| EDN-011 | Whitelabel applies in every deployment shape (brand, domain, email identity, optional branded mobile build) | M | P7 | T | ☐ |
| EDN-012 | Deployment shapes supported: multi-tenant, dedicated database, single-tenant cloud, on-prem, air-gapped | M | P6 | D | ☐ |
| DOM-001 | Domain pack supplies vocabulary, entity aliasing, journeys, metrics, rulepacks, tool set and compliance floors as versioned config | M | P7 | T | ☐ |
| DOM-002 | Vocabulary injected at render time AND prompt time; hard-coded domain nouns fail lint | M | P7 | T | ☐ |
| DOM-003 | Nine domain packs ship in v1, each with default journeys, metrics, report templates and a demo dataset | M | P7 | T,D | ☐ |
| DOM-004 | A domain pack may rename and restrict but can never weaken a compliance floor or remove audit, consent or approval behaviour | M | P7 | T | ☐ |
| DOM-005 | Packs are versioned and diffable; entity remapping warns it is not live-safe | M | P7 | T | ☐ |
| DOM-006 | Standalone Lyra Bots on a non-insurance pack shows zero insurance vocabulary in UI or AI output | M | P7 | T | ☐ |
| DOM-007 | Domain Pack Configurator previews real screens with the new vocabulary before saving | M | P7 | D | ☐ |
| DOM-008 | Compliance floors render as visibly locked, non-editable elements | M | P7 | T | ☐ |

---

## 22. DEP additions — live domain (docs/24 §2)

| ID | Requirement | Pri | MS | Verify | Status |
|---|---|---|---|---|---|
| DEP-020 | Production web app served at `lyra.vantax.co.za` with automated certificates | M | P0 | T,D | ☐ |
| DEP-021 | API served at `api.lyra.vantax.co.za` under `/v1` | M | P0 | T | ☐ |
| DEP-022 | Developer portal at `dev.lyra.vantax.co.za` | M | P1 | D | ☐ |
| DEP-023 | Platform admin at `admin.lyra.vantax.co.za` behind an identity gate with MFA | M | P1 | T,D | ☐ |
| DEP-024 | Tenant workspaces resolve by hostname on `*.lyra.vantax.co.za` | M | P1 | T | ☐ |
| DEP-025 | Staging equivalents isolated from production credentials and data | M | P0 | D | ☐ |
| DEP-026 | Tenant custom hostnames supported with automated certificates | M | P7 | T | ☐ |
| DEP-027 | Email identity configured with SPF, DKIM and DMARC before first send | M | P1 | D | ☐ |
| DEP-028 | Data-residency position documented per tenant; the domain's country implies nothing about storage location | M | P1 | A | ☐ |

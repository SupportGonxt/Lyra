# Module Spec — LYRA AXIS (AI Operations)

"The factory that never sleeps." AXIS turns the quote-to-policy pipeline into a
governed production line: AI does the work, humans handle exceptions, the
regulator gets evidence on demand. Standalone-sellable to insurers, brokers,
TPAs, aggregators.

## 1. Personas

Ops Agent (production) · Ops Team Lead · Underwriting Liaison · Compliance
Officer · Tenant Admin · AXIS Module Admin · Developer (integrations).

## 2. Capabilities

### 2.1 Case orchestration (quote-to-bind)
- Intake from any source (web funnel, ORBIT conversation, partner API, CSV/
  email import) normalises into `axis_cases` with SLA clocks per kind.
- **Panel quoting agent**: fans out to provider integrations (API where
  available; portal-automation via Browser Rendering worker; structured email
  otherwise), normalises quotes, ranks by tenant-configured criteria
  (declared, auditable ranking — no pay-for-position unless disclosed flag).
- Follow-up automation: chases missing info via ORBIT channels; humans see a
  single "exceptions" queue, never a raw inbox.
- Bind & issue: generates policy schedule from provider docs, files to R2,
  delivers via customer channel, writes `axis_policies`.

### 2.2 Document intelligence
- Extraction pipeline (model-gateway `fast` tier + layout heuristics) for
  Emirates ID, mulkiya/vehicle reg, trade licences, medical reports, census
  spreadsheets (group medical). Confidence-scored; below threshold → human
  verify screen with side-by-side viewer.
- Census normaliser: any-format employee lists → canonical census with
  age-banding, salary bands, dependents; diff view against prior year.

### 2.3 SOP copilots & process mining
- SOPs authored in the Admin console (versioned JSON steps); the copilot
  enforces steps in-flow, drafts responses, summarises case files.
- `axis_process_events` feed a live process map: bottlenecks, rework loops,
  SLA breach prediction (flag cases predicted to breach 4h ahead).

### 2.4 Compliance ops
- Approval engine for consequential actions (pricing overrides, manual
  discounts, refunds): dual-control with reason codes.
- Escrow/client-money reconciliation workspace: import provider statements,
  auto-match, exception queue, evidence bundle export (CBUAE-ready).
- Retention & disclosure logging automatic per policy line.
- "Audit-on-demand": one-click export of any case's full trail (events,
  documents, AI actions, approvals) as a signed PDF+JSON bundle.

### 2.5 Reinsurance (ADR-0106)
- Proportional treaties (quota share, surplus) as tenant data: reinsurer, line,
  currency, share or retention × lines, ceding commission, priority, period.
- A policy the tenant underwrites itself (`is_internal` provider) cedes on
  `axis.policy.issued`: one cession per policy × treaty, posted as `RI-CEDE`
  behind the `axis.reinsurance_cession` approval (docs/19 §5.2 H).

## 3. Agents & automations

| Agent | Trigger | Tier | Consequential? |
|---|---|---|---|
| Quote Runner | case → quoting | fast/standard | no (read/aggregate) |
| Doc Extractor | file upload | fast | no |
| Case Copilot | agent opens case | standard | drafts only |
| Chaser | missing-info timer | standard | send = yes (channel policy) |
| Issuer | bind approved | standard | yes (issue policy) |
| SLA Sentinel | schedule 5m | fast | no (alerts) |
| Recon Matcher | statement import | fast | proposes; human confirms |

## 4. Screens (web workspace)

1. **Production Board** — kanban/table hybrid of cases by status; SLA heat;
   saved views per team; bulk actions; live via SSE.
2. **Case Room** — timeline (events+messages+docs), quote panel comparison,
   copilot side-rail (draft/summarise/next-step), approval strip, audit tab.
3. **Verify Queue** — extraction confirmations, keyboard-first (J/K, enter).
4. **Exceptions** — the only inbox: chases failed, integrations erroring,
   SLA at-risk.
5. **Recon** — statement import, match table, exception drill-down.
6. **Process Map** — Sankey of the pipeline with drill-to-cases.
7. **AXIS Admin** (module-admin role): SOP editor, ranking-criteria editor,
   SLA policies, provider integration health, approval policies, extraction
   templates, queues & routing rules.
8. **AXIS Dev** (developer role): integration sandbox (mock providers),
   webhook tester for axis.* events, extraction playground, API keys scoped
   to AXIS, logs.

Mobile (see docs/08): approvals, exceptions triage, verify queue (camera-first
re-capture request), SLA alerts.

## 5. Self-contained toolset (no external dependency to operate)

Ships with: user/role management scoped to AXIS · SOP builder · ranking editor
· provider connector framework + 3 built-in connector types (REST, portal-
automation script, email-parse) · import/export (CSV, XLSX) · report builder
(saved queries → schedule to email/R2) · full audit export · sandbox tenant
data generator. Runs standalone with only the core spine (identity, files,
model gateway) — ORBIT/SIGNAL/SCOUT/NORTH absent = features degrade to none,
no errors.

## 6. Data / API / Events

Tables `axis_*` (docs/03) · routes `/v1/axis/*` (docs/04 §4) · emits
`axis.case.*`, `axis.quote.added`, `axis.policy.issued`,
`axis.document.extracted`, `axis.approval.*`; consumes `orbit.conversation.*`
(intake), `core.consent.updated`.

## 7. KPIs (module dashboard, also feeds NORTH)

Handling minutes/policy · same-session issuance rate (motor/travel) · docs
auto-extract rate & accuracy · SLA hit rate · quote panel coverage & win rate
by provider · exception rate · recon match rate · approval turnaround.

## 8. Acceptance criteria (v1)

- Motor case: web intake → ≥3 provider quotes → bind → policy PDF delivered,
  fully automated happy path, < 10 min, zero human touches.
- EID + mulkiya extraction ≥ 95% field accuracy on test set (both languages).
- Any case exports a complete signed audit bundle.
- Kill-switch: module admin can pause any agent tenant-wide in one click.

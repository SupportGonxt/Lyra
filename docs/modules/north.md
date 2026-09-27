# Module Spec — LYRA NORTH (AI Insights)

"The whole business, narrated." NORTH is Atheon-class executive intelligence:
one governed metric layer, a daily written briefing that explains *why*,
anomaly detection with driver analysis, decision simulations grounded in the
tenant's own data, and one-click board packs. Standalone-sellable to any
mid-to-large enterprise — NORTH must run happily on data imported from
non-LYRA systems.

## 1. Personas

CEO/Exec (primary) · CFO/COO · Board member / Investor (read-only pack
audience) · Analyst (metric steward) · NORTH Module Admin · Developer (data
connectors).

## 2. Capabilities

### 2.1 Semantic metric layer
- `north_metrics` registry: every metric has an owner, a definition (SQL over
  core views or connector sources), a target, and a sensitivity level.
  Definitions are versioned; a metric change shows as an annotation on every
  chart from that date. **One version of the numbers** is the product.
- Connectors for standalone mode: warehouse (Postgres/BigQuery/Snowflake read),
  CSV/Sheets scheduled import, webhook metrics push, and native LYRA views
  when co-deployed.

### 2.2 The Daily Brief (flagship)
- Nightly Workflow: snapshot metrics → detect movements → driver analysis
  (decomposition by dimension; correlation candidates ranked, labelled as
  correlation) → **written narrative** (reasoning tier) in the exec's locale,
  ≤ 400 words, numbers first, "what we'd do" suggestions clearly marked as
  suggestions.
- Delivery: app home, email digest, WhatsApp summary (opt-in), mobile push.
- Every claim in the brief is click-through-to-evidence (chart + query).
  Hallucination control: the narrator can only reference numbers returned by
  the metric layer (structured context, verified post-check that every figure
  in prose matches source; mismatch = regenerate or fail loudly, never ship
  unverified numbers).

### 2.3 Anomaly & driver detection
- Per-metric baselines (seasonal-aware); anomalies open cards with automated
  driver decomposition ("motor CAC +22%: 80% attributable to Meta CPM in KSA
  campaign group") and a create-action button (assign owner, due date;
  outcome tracked).

### 2.4 Scenario simulations
- Ask-and-answer: "What if we shift 20% of acquisition budget to renewals?"
  → scenario engine composes from registered model primitives (elasticities,
  funnel rates, cohort retention from tenant data), returns range estimates
  with assumptions listed; saved to `north_scenarios`, shareable.
  Guardrail: simulations always display assumption provenance and confidence
  band; no point estimates without ranges.
- Built so far (ADR-0103): one driver per scenario — `metric`, a relative
  `changeBps`, `horizonMonths`/`horizonDays` — applied to the metric's own
  forecast band (`POST /v1/north/scenarios/{id}/run`, deterministic, no model
  call). Elasticities, funnel/cohort composition, multi-driver and
  slice-scoped drivers are not built yet.

### 2.5 Board & investor packs
- Templates (exco weekly, board monthly/quarterly, investor update):
  auto-assembled from briefs, metric snapshots, decision log, module KPI
  sections; edited in-app; rendered to PDF (Browser Rendering) with tenant
  brand; distribution logged (who received/opened which version).

### 2.6 Decision log
- Lightweight registry of significant decisions (context, options, chosen,
  owner, review date); NORTH nags at review date and drafts the outcome
  review from subsequent metric movement.

## 3. Agents & automations

| Agent | Trigger | Tier | Consequential? |
|---|---|---|---|
| Snapshotter | nightly | fast | no |
| Anomaly Hunter | post-snapshot | standard | no |
| Driver Analyst | anomaly opened | reasoning | no |
| Narrator | brief build | reasoning | no (verified prose) |
| Scenario Engine | user ask | reasoning | no |
| Pack Assembler | schedule/user | standard | distribution = approval |

## 4. Screens

1. **Today** (exec home) — the Brief as beautiful reading (typographic,
   evidence links), metric ticker strip, anomaly cards, "ask NORTH" bar.
2. **Metric Explorer** — registry, chart canvas with annotations, definition
   drawer (SQL + owner + lineage), compare/cohort tools.
3. **Anomalies** — card wall with states (new/explained/action created),
   driver breakdowns.
4. **Scenarios** — ask bar, assumption panel, result ranges, saved library.
5. **Board Room** — pack templates, assembly editor, versioning, distribution
   & read log.
6. **Decisions** — log table + review queue.
7. **NORTH Admin** — metric registry management (approve definition changes),
   audience & sensitivity control (who sees which metrics), brief schedule &
   locales, connector management, target setting.
8. **NORTH Dev** — connector setup (warehouse creds, test query), metrics
   push API keys, brief webhook (post to Slack/Teams), sandbox with the
   synthetic "Aldebaran" dataset.

Mobile (this module's primary surface is mobile): the Brief as a morning read,
swipeable anomaly cards, ask-NORTH voice input, approve pack distribution.
Board members get a locked-down read-only mobile mode (packs + brief only).

## 5. Self-contained toolset

Metric registry + connectors · brief engine · anomaly engine · scenario
primitives · pack builder + PDF render · distribution with read receipts ·
sensitivity-scoped sharing. Fully standalone on imported data (the Atheon
sale); when co-deployed, module KPI sections auto-populate.

## 6. Data / API / Events

Tables `north_*` · routes `/v1/north/*` · emits `north.anomaly.detected`,
`north.briefing.published`; consumes every module's events for context; reads
only views/snapshots (docs/03) — never hot tables.

## 7. KPIs

Exec daily-open rate > 70% · time-to-explanation for anomalies < 24h ·
% brief figures verified (must be 100%) · scenario reuse rate · pack assembly
time < 10 min · decision reviews completed on time.

## 8. Acceptance criteria (v1)

- Brief generated nightly for the synthetic tenant in en + ar; 100% of numeric
  claims machine-verified against the metric layer (test harness).
- Seeded anomaly (CAC spike) detected and correctly attributed in the fixture.
- Board pack assembled and PDF-rendered with tenant brand in one click.
- A metric definition change shows as a chart annotation from the change date.

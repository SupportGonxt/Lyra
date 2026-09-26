# Module Spec — LYRA SIGNAL (AI Marketing)

"Spend follows signal." SIGNAL is a closed-loop growth engine: it generates
compliant creative at volume, scores audiences on bind-probability and LTV
(not clicks), moves budget daily, and owns the emerging AI-answer-engine
channel. Standalone-sellable to any growth team.

## 1. Personas

Growth Lead · Performance Marketer · Content/Brand Marketer · Compliance
Reviewer · SIGNAL Module Admin · Developer (pixel/feeds).

## 2. Capabilities

### 2.1 Creative studio (generative, governed)
- Briefs → multi-variant generation: ad copy, landing pages (blocks rendered by
  apps/web hosted-pages engine), emails, WhatsApp templates, video scripts —
  Arabic + English natively (not translated afterthoughts; separate prompts,
  cultural review lane).
- Brand kit enforcement: tenant tokens, banned-claims list, mandatory
  disclosures per product line auto-appended.
- **Compliance pre-flight**: every creative passes a claims classifier tuned to
  CBUAE marketing/telemarketing rules + tenant legal phrases; hard-block list,
  soft-flag lane to human Compliance Reviewer; nothing publishes unchecked.
- Asset versioning, rights metadata, performance annotations feeding back into
  generation ("winning-pattern memory" per tenant).

### 2.2 Audience & LTV intelligence
- Audience builder over the consent-aware spine (rule tree + lookalike scoring
  via embeddings); size/reach estimator; suppression lists always applied
  (recent purchasers, do-not-contact, complainers).
- Bind-probability + predicted-LTV models score prospects; value-based bidding
  exports to ad platforms (Google/Meta APIs via connectors; TikTok v1.1).
- Marketing at three scales (ADR-0091). **Prospects** are identified people
  other modules reported, by event: a lapsed comparison (`quote_expired`), a
  renewal at churn risk (`churn_risk`, left to ORBIT's journeys), a customer
  holding no contract (`no_policy`). **Niche** audiences name a reason and a
  score floor; **broad** plans argue from the counts; an **individual** draft
  is written from that person's one reason and gated by `checkOutreachDraft`.
  **Responses** (`signal_responses`) record the send, delivered/read receipts,
  replies, binds and opt-outs against the campaign, the audience and the
  person at once.

### 2.3 Budget autopilot
- Daily loop: marginal CAC/LTV per channel×campaign → reallocation proposals;
  within tenant-set bounds executes automatically, beyond bounds requests
  approval; every move logged with reasoning (`signal_budget_moves`).
- Anomaly guard: spend spike / tracking breakage auto-pauses and alerts.

### 2.4 SEO + AEO command
- Content units structured for answer engines: query-cluster pages with
  schema.org, citations, freshness SLAs; AEO monitor samples major AI
  assistants for target queries and logs citation share (`signal_aeo_pages`).
- Technical SEO watcher (Workers cron + Browser Rendering): CWV, index status,
  hreflang ar/en, cannibalisation alerts.

### 2.5 Experiments & attribution
- Experiment registry (hypothesis → variant → metric → conclusion) with
  sequential testing math; nothing "wins" by eyeball.
- Attribution: server-side event collection (first-party pixel via Worker),
  touch stitching to bind events from AXIS; reported as contribution ranges,
  not false precision.

## 3. Agents & automations

| Agent | Trigger | Tier | Consequential? |
|---|---|---|---|
| Creative Generator | brief submitted | standard | no (drafts) |
| Compliance Pre-flight | creative saved | fast | blocks publish |
| Budget Autopilot | daily 06:00 | reasoning | moves within bounds |
| AEO Monitor | weekly | standard | no |
| SEO Watcher | daily | fast | no |
| Experiment Analyst | data threshold | reasoning | no (recommends) |

## 4. Screens

1. **Growth Cockpit** — CAC/LTV by channel, budget map (sankey money→binds),
   autopilot feed ("moved AED 8k from Meta-Motor to Google-Health: +12% mLTV"),
   approve/undo strip.
2. **Creative Studio** — brief composer, variant gallery with compliance
   badges, side-by-side ar/en, performance overlays, one-click to channels.
3. **Audiences** — builder canvas, size dial, overlap matrix, suppression
   panel (always visible).
4. **Experiments** — registry table + detail with sequential-test chart.
5. **AEO Board** — query clusters, citation share trend, content freshness
   queue.
6. **SIGNAL Admin** — brand kit & banned claims, channel connections (OAuth),
   budget bounds & approval thresholds, disclosure templates per line,
   suppression sources, UTM schema.
7. **SIGNAL Dev** — pixel/tag setup & debugger, feed endpoints (catalog),
   webhook tester, sandbox ad-platform mocks, API keys.

Mobile: cockpit summary, approve budget moves & flagged creatives, experiment
result alerts.

## 5. Self-contained toolset

Creative generation + review lanes · hosted landing-page engine · audience
builder + exports · experiment math · attribution collection · connector
framework (Google, Meta built-in) · report scheduler. Runs standalone with
core spine; without AXIS bind events, attribution falls back to
tenant-configured conversion webhooks.

## 6. Data / API / Events

Tables `signal_*` · routes `/v1/signal/*` · emits `signal.campaign.*`,
`signal.experiment.concluded`, `signal.budget.moved`,
`signal.creative.flagged`; consumes `axis.policy.issued` (conversions),
`orbit.renewal.accepted` (retention campaigns), `core.consent.updated`
(instant suppression), and for prospects and responses (ADR-0091)
`dist.quote.expired`, `orbit.renewal.due`, `core.customers.created`,
`orbit.message.status`, `orbit.message.received`.

## 7. KPIs

Blended CAC trend · creative test velocity (variants/week) · compliance flag
rate & time-to-review · autopilot uplift vs frozen-budget holdout · AEO
citation share on top-20 queries · experiment throughput & win rate.

## 8. Acceptance criteria (v1)

- Brief → 20 compliant ar/en variants → publish to Meta+Google in < 1 hour
  with human review only at the flag lane.
- Budget autopilot runs 14 consecutive days against a holdout with full move
  logs and one-click global pause.
- Consent update propagates to suppression across live campaigns < 15 min.

# 30 — Module review against the category leaders (2026-09-23)

Ten workspaces read against the products a buyer compares them with, asking
three questions of each: **is it complete** (the capabilities a buyer expects,
present / partial / missing, reachable in the UI or not), **does it stand
alone** (does it run with only core and its own data), and **does it work in
conjunction** (the events it emits and consumes, and the ones that go nowhere).

Method: three read-only reviews (AXIS/ORBIT/SIGNAL; SCOUT/NORTH/Ledger/
Distribution; Compliance/Analytics/Admin) reading `docs/modules/*`, docs/05,
docs/27, `ui.md`, the web module specs and bespoke routes, the API routes and
engines, and every `emit(ctx` and dispatch consumer. **Citations below are the
reviewers'; each is re-opened when its item is fixed** (CLAUDE.md: open every
`file:line` before relying on it), and items found wrong at that point are
struck here, not silently dropped. Findings, not a backlog: an item that needs a
product or spec decision says so.

## 0. What applies to every module

~~**No module can be switched off.** `PATCH /v1/core/modules/:module/config`
stores `enabled`, `autonomy` and `modelTier`; `moduleSettings()` resolves them;
`moduleEnabled()` (`packages/core/src/module-config.ts:39`) has no caller (docs/27,
2026-09-23 entry). API routers mount unconditionally (`apps/api/src/index.ts`),
the cron sweeps run for every tenant, and the only real switch is the build-time
`LYRA_MODULES` flag, which hides web screens. "Module off" today means "its
tables are empty". This is the first thing standalone operation needs, and it
wants an ADR (what a disabled module answers, whether its sweeps and consumers
stop, how the nav and the module switcher reflect it).~~ **Fixed** 2026-09-23
(ADR-0087, "Order of work" §3.2 below, re-verified at source 2026-10-01):
`moduleEnabled()` now has real callers — `apps/api/src/auth.ts:235,244`
refuses a disabled module's routes, `apps/api/src/dispatch.ts:88` and
`apps/api/src/index.ts:255` stand its cron sweeps and consumers down per
tenant — and the nav/module switcher reflect it too. This paragraph was never
struck when the fix landed, though §3.2 already recorded it as done.

**Modules read each other's tables more than they exchange events.** The shared
schema means nothing fails at import time; features go quiet instead. SCOUT
imports SIGNAL engines and writes `signal_campaigns`; ORBIT imports AXIS engines
and writes `axis_cases`/`axis_tasks`; NORTH computes every metric from other
modules' tables and cannot run on imported data as its spec promises.

**Many emitted events have no in-process consumer**, and several seeded
consumers listen for events nothing emits. The in-process consumers are a
handful of branches in `apps/api/src/dispatch.ts` plus the generic journey and
webhook fan-out.

> **Re-verified at source 2026-10-01.** Of the four directions below, **three were
> already fixed** when the table was last read, and the fourth is now. The rows are
> kept, struck where they are stale, because the table is what a reader believes
> without checking — the same reason `ui.md` §6's heading is pinned by a test.
>
> - ~~Emitted under the wrong name~~ — **fixed**. The consents resource emits
>   `core.consent.updated` (which suppression, prospects and responses all listen
>   for) *alongside* the generic `core.consents.created` it always emitted, and says
>   so in a comment (`resources.ts:256`). **And the save desk was fixed too —
>   corrected 2026-10-01, having first been written the other way round here.**
>   The renewals resource does not ride the generic `orbit.renewals.updated`: it
>   emits `RENEWAL_EVENTS[state]` — `orbit.renewal.offered` / `.accepted` / `.lost`
>   (`resources.ts:782,836`) — **on a state change only**, with the comment *"so a
>   later edit to a decided row announces nothing twice"*. The indirect emit is what
>   the seam guard pins (`event-seams.test.ts` `INDIRECT`), and sweeping those lists
>   is what caught this row reading the opposite of the truth.
> - ~~Emitted twice~~ — **fixed**. `ledger.settlement.approved` and
>   `ledger.settlement.paid` have one emitter each (`settlement.ts:547,628`), and the
>   CRUD path now passes **no** `event` — both sites carry a comment saying why.
> - ~~Consumed or subscribed, never emitted~~ — **mostly fixed** by
>   `SEED_EVENT_RENAMES` (`packages/core/src/seed.ts:2751`), which maps the eight
>   names the seed once shipped to the names the facts are actually announced as,
>   so a tenant seeded earlier is repaired rather than stranded;
>   `signal.campaign.launched` and `north.briefing.published` are emitted too.
>   **One remained genuinely dead: `north.anomaly.detected`** — nothing emitted it,
>   because the detector wrote a `north_anomalies` row and announced it to nobody.
>   Fixed 2026-10-01 (`north-snapshotter.ts`): it emits when a row is written and
>   **only** then, inside the `!openAnomaly` branch, so re-detecting an already-open
>   anomaly does not fire a subscriber twice for one event. **Tested** 2026-10-01
>   (`north-anomaly-event.test.ts`): announced once with its figures and subject, and
>   a second sweep over the same open anomaly adds nothing. No test had exercised
>   `runSnapshotter` before, which is why this took a deliberate fixture.
> - **Emitted, never consumed in-process** — ~~still true~~ **true by design**.
>   These are for the journey, webhook and external consumers, which is what the
>   in-process consumer list beside it says; the defect was never the absence of an
>   in-process branch but a name nobody emitted.

Dead in both directions:

| Direction | Examples |
| --- | --- |
| Emitted, never consumed in-process | `scout.whitespace.promoted`, `scout.bench.updated`, `north.alert.triggered`, `orbit.renewal.attributed`, `orbit.fnol.registered`, `signal.acquisition.closed`, `signal.budget.moved`, `dist.commission.accrued`, `compliance.screening.hit`, `compliance.shariah.certified` |
| Consumed or subscribed, never emitted | seeded journey triggers `dist.policy.issued`, `dist.partner.approved`, `orbit.renewal.raised`, `orbit.document.missing`; seeded webhooks `dist.quote.bound`, `dist.quote.ready`, `ledger.settlement.posted`, `ledger.recon.completed`; spec'd `signal.campaign.launched`, `north.briefing.published`, `north.anomaly.detected` |
| Emitted under the wrong name | save-desk decisions (CRUD `orbit.renewals.updated`, not `accepted`/`lost`); admin-entered consents (`core.consents.created`, not the `core.consent.updated` suppression listens for) |
| Emitted twice | `ledger.settlement.approved`, `ledger.settlement.paid` |

## 1. Scorecards

Counts are of the 12–18 capabilities each review listed (✓ exists, ◐ partial,
✗ missing).

| Workspace | Leaders compared | ✓ | ◐ | ✗ | Stands alone? |
| --- | --- | --- | --- | --- | --- |
| AXIS · Operations | Guidewire, Duck Creek, Sapiens, Pega | 12 | 5 | 1 | Yes — core spine only |
| ORBIT · Conversations | Zendesk, Intercom, Service Cloud, Sprinklr | 10 | 3 | 3 | Yes (2026-09-26) — AXIS work goes by event; AXIS tools only where AXIS is held |
| SIGNAL · Marketing | HubSpot, Braze/Iterable, Ads managers, Marketo | 5 | 8 | 3 | Yes (2026-09-26) — people by CSV (`/v1/core/customers/import`), channels on the platform and first contact (ADR-0093), conversions by signed `/track`, autopilot on imported spend |
| SCOUT · Market | Crayon/Klue, Similarweb, Qualtrics, Earnix/Akur8 | 8 | 4 | 4 | Yes (2026-09-26) — demand from the platform's quotes, its own signals by CSV (`/v1/scout/signals/import`), coverage from converted requests when AXIS is off, whitespace recomputed nightly; the SIGNAL handover says it needs SIGNAL |
| NORTH · Insight | Tableau Pulse, ThoughtSpot, Power BI, Anaplan | 5 | 7 | 4 | Yes (2026-09-27) — computed metrics read the modules held; every other number arrives by push or file (`/v1/north/metrics/import`, the metrics tab's Import) |
| Ledger | NetSuite, Sage Intacct, Xero, Insurity | 12 | 1 | 5 | Mostly — soft reads of NORTH/Dist/AXIS |
| Distribution | Salesforce PRM, Impartner, Applied Epic, Zywave | 9 | 4 | 2 | Yes (2026-09-27) — without AXIS the chosen quote is recorded as the sale and accrues through the same rate, gate and settlement (ADR-0094) |
| Compliance | OneTrust, TrustArc, Vanta/Drata | 8 | 6 | 3 | Serves SIGNAL/Ledger via events |
| Analytics | Looker, Power BI, Metabase, Mode | 6 | 4 | 6 | Reads everyone's tables by design |
| Admin / Platform | Okta/Entra, Retool/Backstage, Credo AI/Arize | 12 | 5 | 2 | Underpins every module |

## 2. Ranked gaps (buyer value ÷ effort)

### AXIS · Operations
1. ~~Document extraction from an uploaded file — the vision path exists in the API; the web screen demands pasted text.~~ **Fixed** 2026-09-23: an empty paste now reads the stored file (`axis-doc-intel.tsx`, test "reads the stored file when nothing is pasted").
2. ~~Policy schedule produced on bind.~~ **Fixed** 2026-09-26: `bindPolicy` issues the schedule with the bind; a document the renderer refuses is audited (`axis.policy.document_failed`), never a 409 on a policy that now exists.
3. ~~Quote desk issues through `/quote-responses/:id/bind`.~~ **Fixed** 2026-09-23: a named customer is required at shop time; the desk binds (docs/27).
4. ~~Screens for NTU / lapse / reinstate~~ — **reviewer was wrong**: all three are declared actions on the policies tab (`apps/web/app/modules/axis.ts` `/{id}/ntu`, `/lapse`, `/reinstate`) and render on the generic record page. SLA prediction now has its caller (2026-09-26): an ambient line under the case's due date, ✦ with the evidenced driver as its why.
5. ~~Reinsurance treaties and cessions (missing).~~ **Fixed** 2026-09-27: quota-share and surplus treaties are an AXIS tenant resource, and a policy the tenant underwrites itself cedes on `axis.policy.issued` — one cession per policy and treaty, floored minor units with the remainder retained — posted through the gated RI-CEDE recipe (Dr 2000 / Cr 2060 / Cr 4097); ADR-0106 flags two accounting choices for the product owner.

### ORBIT · Conversations
1. ~~Seeded journeys fire~~ — **fixed** 2026-09-23: seeded trigger names are renamed to emitted events on resync (`syncSeedEventNames`), guarded by `event-seams.test.ts`.
   **And run, 2026-09-26.** Both active seeded journeys still halted at the first node the executor did not know (renewal v2 on `agent`, onboarding on `survey`). Underneath that, no seeded journey carried the `cooldownDays` that `triggerJourney` requires (ORB-051), so none could enrol anybody, and every event matching a seeded trigger failed its `orbit.journeys` consumer. Fixed:
   - executors for `wait_for` (an event wakes the run, with `event`/`timeout` edges and a 30-day ceiling), `survey` (the rating link for the run's own conversation) and `agent` (a pending draft a person sends, eval `orbit-journey-draft`; with no approval step, the renewal churn score);
   - seeded cooldowns, with `syncSeedJourneyCooldowns` backfilling them on resync;
   - a guard that every seeded node type has an executor, and a test that walks both active journeys end to end (`orbit-journey-seeded.test.ts`).
   **Partners too, 2026-09-26.**
   - A graph with `subject: "partner"` follows a partner. Runs gained `partner_id` in migration 0037, the first table rebuild, with a test that it keeps existing runs.
   - Partner events now carry `partnerId`, and a partner quote emits `orbit.partner.quoted`, so partner activation runs end to end.
   - A partner run halts at any customer-facing step (`not_for_partners`).
   - A journey without a cap can no longer be activated (the journeys resource's `beforeWrite`).
   - `onJourneyEvent` isolates each journey, so one refused graph no longer fails the consumer for every other journey on the same event.
2. ~~Save-desk outcomes emit `orbit.renewal.accepted`/`lost`.~~ **Fixed** 2026-09-23 (renewal outcome events: offered/accepted/lost).
3. ~~Real-time AI replies on inbound, sent within the agent's autonomy.~~ **Fixed** 2026-09-27: `orbit.message.received` has a consumer (`engines/orbit-auto-reply.ts`, kicked by the webhook itself and retried by the drain) that sends the service agent's reply through the consented outbound path only when its autonomy is `act_within_limits`+ and `orbit.ai_reply` is on the tenant's allowlist and the reply clears `checkAutoReply` (evals/orbit-auto-reply); otherwise it writes the pending draft at once (ADR-0098).
4. ~~Web chat channel (a `ChannelAdapter` plus a portal route).~~ **Fixed** 2026-09-27: a `lyra-webchat` adapter (transport `web`, webhook door shut) takes storefront lines from `POST /v1/portal/{slug}/chat/messages` into ORBIT under a hashed visitor token, staff replies reach `/portal/:tenantSlug/chat` by polling `GET …/chat`, and a line after a person takes over now continues that conversation instead of opening a new one (ADR-0099).
5. ~~Module-aware tools.~~ **Fixed** 2026-09-26: the agent is offered only tools the person it acts for can run (`TOOL_PERMISSION`), so an ORBIT-only tenant sees no AXIS tool; `start_quote` and a document chase announce `orbit.quote.requested` / `orbit.conversation.document` and AXIS raises its own case and task (`engines/axis-orbit-intake.ts`). The scheduler stands down every module a tenant did not buy (`switchedOff`), and `solo-modules.test.ts` holds each module alone to what a full tenant is told. `bindPartner` still has no route (Distribution).

### SIGNAL · Marketing
1. *Done: writable spend (`signal:spend:write`) with a per-line honest CSV import; a restated day is corrected, not doubled.*
2. *Done (ADR-0092): signed `lead`/`bind` touches on `/track`, keyed by a tenant webhook secret, replay-safe by `eventId`.*
3. *Done: the audience rule builder (tagged / prospect reason / prospect score, all or any); 500 cap lifted and unrunnable rules refused on write (ADR-0091).*
6. *Done (ADR-0091): marketing at three scales — `signal_prospects` from DIST/ORBIT/core events, prospect-sourced niche audiences, drafts written from the person's own reason behind `checkOutreachDraft`, and `signal_responses` rolled up per campaign, audience and person.*
4. ~~Experiment engine.~~ **Fixed** 2026-09-27: `engines/signal-experiment.ts` reads each arm from attribution touches on its own creative since the experiment began (the metric names which touch exposes and which converts), computes probability-to-beat-control, and concludes a running experiment nightly once every arm has its minimum sample and the answer is ≥95% either way — `signal.experiment.concluded` on the bus, `GET /v1/signal/experiments/{id}/readout` for where it stands now. `signal.campaign.launched` fires on a campaign's first move to live (not a resume) and `signal.creative.flagged` on every flagged draft; the dev screen's topic flags are held to the API's sources.
5. ~~Ad-platform seam (`core/seams.ts`) with Google/Meta adapters — channels are allowed (CLAUDE.md §13).~~ **Fixed** 2026-09-27: `AdPlatform` (`@seam:H10`) with Google Ads and Meta adapters on sealed `ads` connectors (ADR-0100) — daily spend is pulled through the CSV import's write (restated days corrected; nightly before the autopilot, or `POST /v1/signal/spend/pull`), and a budget move reaches the platform only after the `signal.budget_move` gate passes it, decrease first, with an undo reversing what was pushed.

### SCOUT · Market
1. ~~Data-product subscribe/deliver routes (billing functions exist, called only from tests).~~ **Fixed** 2026-09-27: `POST /v1/scout/data-products/{id}/subscribe` records a provider's fee per delivery under the new `scout.data_product_subscribe` approval and posts `DPROD-SUB`, and `…/deliver` builds the cut the definition names (consented rows only, thin cells suppressed), lets the `DPROD-DELIVER` k-anonymity precondition refuse it, bills the approved fee through `deliverDataProduct` and logs the artefact where the screen's delivery log reads — both idempotent, audited and wired to `/scout/data-products` (ADR-0101).
2. ~~First external source adapter (news/RSS), per ADR-0078.~~ **Fixed** 2026-09-27: `engines/scout-rss.ts` reads the https feeds a tenant lists in `moduleConfig.scout.settings.rssFeeds` through the harvest's one write path (deduped by feed host and guid), refusing any DOCTYPE/ENTITY, following no redirect, sending nothing of the tenant's and keeping no author, with `fetch` injected for tests (ADR-0101).
3. ~~Watch alerts routed to notifications.~~ **Fixed** 2026-09-26: the nightly window runs the watch after the harvest and `notifyUrgentWatch` tells every `scout.lead`, once per subject per day.
4. PDF wording diff via the AXIS extraction path. ***Decided 2026-10-01: ADR-0123 — transcribed, not parsed.*** The choice was between a PDF-text dependency and a vision path; the answer is a `wording.transcribe` purpose through `packages/model-gateway`, the transcription stored and pinned to the document, the diff labelling each side as transcribed, and an eval gating it before default-on. The library lost on its **failure mode**, not its cost: on a scanned wording it returns the empty string and the differ then reports *no coverage-term change* between two documents it could not read — a confident false negative taken to a provider. **Implemented the same day**: purpose, migration `0056`, `engines/scout-wording.ts`, `POST /v1/scout/wording-diff/documents` and the eval — gate passes (`termRecall 1.000`, `localeParity 1.000`, `hallucinatedFigureRate 0.000`). Building the eval found **two Arabic normalisation bugs, neither the model's**: punctuation inside the Arabic block, and the attached `و` particle. The screen still takes text rather than documents. The original note, kept as the reasoning that framed the decision was: *Open 2026-09-27, needs a decision first:* the AXIS path produces no text to diff — `POST /v1/axis/documents/:id/extract` either takes caller-supplied `rawText` (never stored) or renders page 1 to an image and reads the named fields of `eid`/`mulkiya` (`EXTRACTION_FIELDS`), storing only those fields; `axis_documents` rows also require a case. Choosing a PDF-text dependency (docs/02 §9, ADR-0016) or a multi-page vision transcription purpose (eval-first), and where a wording's text lives, is the decision.
5. ~~Price elasticity from bench data on the pricing screen.~~ **Fixed** 2026-09-27: `estimateElasticity` (packages/core/src/elasticity.ts) fits a volume-weighted log-log slope of win rate on price index per line over the bench cells above the k-anonymity floor, with a 95% interval and an honest "not enough data" / "prices too close" state, served by `GET /v1/scout/price-elasticity` and rendered as a third panel on `/scout/pricing`.

### NORTH · Insight
1. ~~Schedule the brief; emit `north.briefing.published`.~~ **Fixed** 2026-09-26: `nightlyBriefing` drafts yesterday's exec brief after the snapshot, once per date; publishing stays a person's act (only a verified brief, stamped who and when), and that transition alone emits `north.briefing.published`. 2026-10-03 (ADR-0114): that brief existed only when the model answered — with none configured the newest was 31 days old after a simulated month, and `/north/brief` showed it as current. The nightly now writes one exec brief per tenant locale dated today, falls back to a deterministic en/ar template (`generatedBy: "template"`, no ✦) when the model is unavailable or refuses, and the screen says when a brief is not today's.
2. ~~Deliver `north.alert.triggered`.~~ **Fixed** 2026-09-23: `engines/north-alert-notify.ts`, consumed in `dispatch.ts`.
3. ~~Metric push API.~~ **Fixed** 2026-09-26: `POST /v1/north/metrics/{key}/values` (`north:metrics:write`) writes grand-total snapshots for a metric the snapshotter does not compute (a registered one answers 409, so two writers never fight); a changed value drops its verification. 2026-09-27: the same push from a CSV (`POST /v1/north/metrics/import`, `metric,period,value`), one push per metric so a refused metric is reported on its own lines.
4. ~~Scenario engine (the what-if screen stores a question and nothing computes it).~~ **Fixed** 2026-09-27: `POST /v1/north/scenarios/{id}/run` (`north:scenarios:run`) reads one driver from the stored assumptions (`metric`, `changeBps`, `horizonMonths`/`horizonDays`), shifts the metric's own forecast band by it and stores the p10/p50/p90 answer on the row — too little history is stored as "no baseline", unreadable assumptions are a 422 naming each one, and the what-if screen computes on save and shows the bands (ADR-0103).
5. ~~Board-pack approval and distribution log.~~ **Fixed** 2026-09-26: approve (review → final, `north:boardpacks:approve`) and distribute (`north:boardpacks:distribute`) — each named person notified once, each send logged with who and when, `north.boardpack.distributed` emitted.

### Ledger
1. ~~Remove the duplicate settlement emits.~~ **Fixed** 2026-09-23: each settlement transition emits once.
2. ~~Cash-flow statement (indirect method).~~ **Fixed** 2026-09-24 (ADR-0090, IFRS IAS 7 indirect): `cashFlowStatement` is proved against cash by a property test, served at `/v1/ledger/reports/cash-flow` and its export, and shown at `/ledger/reports/cash-flow`.
3. ~~Emit `ledger.recon.completed` and `ledger.period.closed`.~~ **Fixed**: recon already announced its close (`recon.ts` `announceCompleted`); 2026-09-26 a period close and reopen emit `ledger.period.closed` / `ledger.period.reopened`.
4. ~~Budgets and budget-vs-actual.~~ **Fixed** 2026-09-27: budgets per account, month and currency are an audited resource (`/v1/ledger/budgets`, `ledger:budgets:*`, no approval — they move no money, ADR-0104) and `/ledger/reports/budget-vs-actual` compares them with the month's posted lines in the same currency, never summed across currencies and never reading a missing budget as zero.
5. ~~Inbound bordereaux reconciliation.~~ **Fixed** 2026-09-27: a provider's CSV imports all-or-nothing with every bad line named (`POST /v1/axis/bordereaux/import`), and reconciliation matches it by (reference, currency) against the period's commission entries and claims — matched, variance, missing on our side or theirs, duplicates flagged, an optional stored tolerance in minor units — then reports on `/axis/bordereaux` with each difference linked to the record whose own approval-gated path adjusts it, never writing money itself (ADR-0105).

### Distribution
1. ~~Accrue commission on `axis.policy.issued`.~~ **Fixed** 2026-09-23: `engines/commission-accrual.ts` raises the `dist.commission_accrue` approval on bind; the decision books it.
2. ~~Fix the dead seeded triggers and webhook subscriptions.~~ **Fixed** 2026-09-23 (`syncSeedEventNames`, `event-seams.test.ts`).
3. ~~Expose commission tiers (`structureJson`) in the rates form.~~ **Fixed** 2026-09-23: the field is on the rates form, and the API validates it strictly (`CommissionStructureJson`, `packages/core/src/commission.ts`) before the rate-change approval — the engine reads a malformed structure as flat, so it must be refused on write (`dist.test.ts` "commission-rate structures are validated on write").
4. ~~Referral qualify/settle desk.~~ **Fixed** 2026-09-26: `/distribution/referrals` — qualify and settle with an idempotency key per referral, the referral ledger read from its REFERRAL-QUAL/SETL transactions.
5. ~~Select → bind handoff.~~ **Fixed** 2026-09-26: the comparison names the policy a bound quote became (`policyId`), so the compare screen shows it on every revisit instead of offering a bind the API refuses.
6. ~~Accrual without AXIS.~~ **Fixed** 2026-09-27 (ADR-0094): `POST /v1/dist/quote-responses/:id/sale` confirms the chosen quote as the sale and books its commission through `accrueCommission`'s own path; "Record sale" on the compare screen where AXIS is not on.

### Compliance
1. ~~Admin consent writes go through `recordConsent` so suppression fires.~~ **Fixed** 2026-09-23: `announceConsent` is the single emitter.
2. ~~Audit export in the UI (F59).~~ **Fixed** 2026-09-23 (see Admin 2).
3. ~~DSAR runner that erases.~~ **Fixed** 2026-09-23 (ADR-0089): a fulfilled erasure reaches AI memories and record notes, logged (`engines/compliance-erasure.ts`).
4. ~~Screening hits block binding; a real screening provider behind the seam.~~ **Fixed** 2026-09-27 (ADR-0095): `assertNotScreenedOut` is asked by policy create, quote bind, renew, reinstate and the Distribution sale; `POST /v1/compliance/screenings/{id}/disposition` (a reason required; only a false positive lifts the block, `compliance.screening.cleared`); OpenSanctions answers sanctions and PEPs once `OPENSANCTIONS_API_KEY` or a self-hosted `OPENSANCTIONS_URL` is set — a commercial licence is the procurement step before production turns it on.
5. ~~Scheduled retention with more record classes.~~ **Fixed** 2026-09-27 (ADR-0107): `engines/compliance-retention.ts` purges `messages`, `files` (object deleted, row tombstoned) and `ai_audit` under their docs/12 floors with legal holds honoured, and the nightly window runs it on `policy.retention.schedule` — `never` by default, so no tenant loses data until it chooses a cadence.

### Analytics
1. ~~Dashboard schedules refused at creation until delivery supports them.~~ **Fixed** 2026-09-23 (`assertDeliverableSchedule`).
2. ~~Schedule create screen.~~ **Fixed** 2026-09-26: `/analytics/schedules/new` schedules a saved report with the builder's own body (named cadence, file, recipients), under the report's own names.
3. ~~Report builder and natural-language questions.~~ **Fixed** 2026-09-23 (ADR-0088): `/analytics/builder`, `POST /v1/analytics/ask` (eval-first), AI datasets and `/admin/ai/analytics`.
4. ~~Readable dimension labels.~~ **Fixed** 2026-09-26: report and builder results resolve ref-shaped values through `/v1/names`, and the report summary names measures and splits from the dataset registry.
5. ~~Dashboard tile editor with filters.~~ **Fixed** 2026-09-27: `/analytics/dashboard/:id/edit` adds tiles from a saved report or a dataset and measure (the builder's own form reader), removes, reorders by button or Alt+Arrow, resizes on the twelve-column grid and sets a date range and dimension filters every tile inherits at render, saved through the dashboards write permission and refused at the write when the layout is malformed (`DashboardLayoutSchema`, `checkDashboardLayout`).

### Admin / Platform
1. ~~Agents CRUD could raise autonomy without the dual-control approval~~ — **fixed** 2026-09-23 (`resources.ts` agents `beforeWrite`, `ai.test.ts` "the agents CRUD cannot move autonomy").
2. ~~Audit log filters, search and export.~~ **Fixed** 2026-09-23: `GET /v1/core/audit-log/export` (CSV of the chain with every hash, `core:audit:export`, itself audited; `core-audit-export.test.ts`), search on the audit tab, and an Export CSV button (`ResourceSpec.download`, `/admin/audit-export`).
3. ~~Approvals pagination (F60).~~ **Fixed** 2026-09-26: `/v1/me/inbox` pages by keyset `(requestedAt, id)`; the approvals screen follows the cursor.
4. ~~DLQ replay~~ **fixed** 2026-09-26 (`replayDead`, `POST /v1/core/event-dlq/{id}/replay`, a Replay action on the DLQ tab: only the dead consumer re-runs). The platform AI kill switch has its button (2026-09-26): a card on `/platform` that stops all AI with a stated reason and releases through the gated route, never the generic flag toggle.
5. ~~SCIM provisioning~~ **Fixed** 2026-09-27 (ADR-0096): `/v1/scim/v2` Users and Groups (roles, membership only) for an API key carrying `core:users:*`/`core:roles:*` scopes; deactivation suspends; a Group grant is held to `assertCanGrant`. SAML **fixed** the same day (ADR-0097, superseding ADR-0001): xml-crypto verifies, identity is read only from the signed reference, and the comment-truncation, signature-wrapping, entity, SHA-1, replay and audience vectors are tests (`engines/saml.test.ts`).

## 2b. The market-leader queue (2026-10-01)

Findings from a 24-agent sweep with adversarial verification — twelve recon agents, twelve verifiers whose
only instruction was to falsify. **Six survived; six were overstated or wrong.** Only the survivors are acted
on, and the killed ones are recorded as killed so nobody re-chases them.

**Closed:**

- **A placement names its licence** (`ADR-0125`). `axis_authorisations` is a tenant-owned register per market,
  regulator, scope and product line; `enforceAuthorisation` refuses a bind with four distinct reasons
  (`none_on_file`, `expired`, `suspended`, `not_yet_valid`). This also closed a dead seam: `operating-model.ts`
  had **no production reader** and now has five — the seed derives from `MARKETS`/`REGULATORS` and re-types
  **zero** licence numbers.
- **Client money is many accounts.** `clientMoneyPairs` derives each asset's liability from the tenant's own
  chart, so the posting invariant, position report, period-close check and Money Map are per account. A **KSA
  pair (1011/2011, SAR)** is seeded. The invariant evaluates **every pair, including ones a batch never
  named** — because a check that reads only the accounts a batch mentions is exactly how a second client-money
  account stays invisible.
- **Entitlements had no owner.** `admin:entitlements:write` was exempt with the reason *"entitlements are
  edited by the platform operator, not by a tenant route"* — a claim about code that did not exist — while the
  tenant's own route accepted the field, so a tenant admin could add every module and raise their own seat
  limit. Closed as a named refusal, and the exemption retired because its reason had become false.

**Closed since:**

- **The group-bind hole.** `/policies/:id/bind-group` went straight to its own accrual and never entered
  `bindPolicy`, so a broker could write group medical in a market it holds no licence in while the individual
  path refused the same market. **A register is only a control where every door asks it.**
- **The eleventh backfill.** The authorisation register is checked on the bind path, so a tenant provisioned
  before migration `0057` held no licence row and **every bind was refused** — an outage, not a gap, and one
  this change introduced. `ensureSeedAuthorisations` is now the eleventh `ensure…`/`sync…` beside
  `syncTaxRules` and nine others in `POST /v1/auth/demo/resync-roles`, whose own comments name this exact
  shape. **A compiled table read only at provisioning time has one delivery.**
- **NORTH's per-market money** (ADR-0128). `gwp` sums nine currencies into one integer and the screen called it
  *"AED 1,234,567.00"*; the commission reader beside it *dropped* non-AED rows. Now `functionalCurrencyOf`
  states the currency in all three readers, `axis_policies.market` records the market on the contract (nullable,
  written at bind from the same statement the licence check reads), and `gwp_by_market` cuts the total with a
  named `unrecorded` bucket for rows written before the column existed. **Two screens are still owed.**
- **SCOUT's coverage column** (ADR-0127). One column, two facts, four shapes; the panel rendered `NaN`, the
  portal "None", the negotiation pack omitted it. `coverageOf` now normalises all four on read and every reader
  routes through it.

## 2c. An open decision the client owns: does accepting a renewal renew it? (2026-10-02)

Found while closing item 3, and it is a **design question rather than a defect**, so it is put here rather than
decided in code.

**What the platform does today:**

1. ORBIT's re-quote engine prices an `auto_requote` renewal across the panel and writes
   `orbit_renewals.requotes_json` — the cheapest answer, or a null price when the panel did not answer
   (`engines/orbit-requote.ts`, ADR-0129).
2. The save desk records the offer; acceptance is a generic resource write of `state: "accepted"`
   (`resources.ts:891` maps it to the `orbit.renewal.accepted` event).
3. That event has **one** consumer: attribution (`dispatch.ts:211`), which measures the outcome for docs/17
   SIG-007.

**What it does not do:** create the successor policy. `renewPolicy` — which carries `quoteResponseId` onto the
successor's version and posts the renewal's journal — is reachable only from
`POST /v1/axis/policies/:id/renew`. **The retention loop therefore ends at a number and a label**, and a person
who wants the renewal to actually happen must go to AXIS and re-key the price the engine already computed.

**The decision:**

- **(a) Acceptance renews**, carrying the chosen quote. This is a saga — it creates a policy version and posts
  money — and CLAUDE.md rule 4 names pricing as its first gated example, so it needs a stated approver. It is the
  step that makes "the retention loop carries a price" true end to end.
- **(b) The human renews in AXIS and ORBIT only measures.** Then nothing in the product is broken, and the defect
  is only the docstring that implied otherwise — now corrected in `axis-lifecycle.ts`.

**We have not chosen, deliberately.** Option (a) creates policies and posts money on an event, and *"the engine
did it silently"* is not an answer this platform accepts anywhere else. Both readings are consistent with
docs/17's wording, so the client's intent decides it.

**Recorded, not yet built:**

- **The six missing rulepacks.** `TAX_MARKETS` is `["AE","EG","SA"]`; the client operates in nine. Proposed
  rates for the other six live in `TAX_RULEPACK_DRAFTS` (`packages/db/src/tax-rulepack.ts`) and are **never
  applied**: a test asserts the applied rulepack and the drafts share no market, so a draft cannot become law
  by being copied. A draft of `0` means *"no rate known"* and says so in words — **not** zero-rated, and the
  two must not be confused when one is promoted. Verification means supplying a citation; a rate confirmed
  without one is confirmed by memory.
- **`bindGroup` is not gated by the authorisation register.** A group placement goes through
  `engines/group-commission.ts` and never enters `bindPolicy`. A real hole in the shipped feature.
- **No backfill of authorisations for existing tenants.** `seed()` refuses a second call, so a tenant
  provisioned before `0057` holds no licence and its next bind is refused — the sighting-9 shape.

## 2d. The sovereign stack did not start (2026-10-16)

`pnpm onprem:up` — a documented command in `CLAUDE.md` — **could not start the stack at all.** Three independent
defects, none of them visible to any check that does not run the container. Every static artefact passed: the
image built, `docker compose config` validated, the three on-prem adapters had tests, and `scripts/lyra-onprem.ts`
had its own.

**1. The libsql healthcheck used a binary the image does not contain.**
`ops/docker-compose.yml` probed with `curl -fsS http://localhost:8080/health`. The image ships only `sqld`, `dash`
and the usual text tools, so every probe failed with
`exec: "curl": executable file not found in $PATH` and `FailingStreak: 21`. `libsql` was permanently unhealthy,
`migrate` waits on `service_healthy` and never ran, and `app` waits on
`migrate: service_completed_successfully` and never started. The stack died at its first step complaining about a
dependency rather than a missing binary.

The check now reads `/proc/net/tcp` and asserts a socket is **listening on the SQL port** (8080 = `0x1F90`,
LISTEN = `0A`). `dash` has no `/dev/tcp` and nothing in the image can make an HTTP request. Deliberately **not**
`sqld --version`: that proves the binary exists, not that the server serves, and a healthcheck that does not check
health is worse than none because it reports green.

**2. `onpremInit` emitted host-local addresses into a container environment.**
`.env.example:42` sets `LIBSQL_URL=file:./.data/lyra.db`. Compose gives it an in-network default
(`${LIBSQL_URL:-http://libsql:8080}`), but `:-` applies only when the variable is **unset or empty**, so the
non-empty host path won and the default never fired. `migrate` then died with
`ConnectionFailed("Unable to open connection to local database ./.data/lyra.db")` — drizzle opening a file that
does not exist in that container.

The same trap catches the model tier: `OPENAI_COMPAT_URL=http://localhost:11434/v1`, where `localhost` inside the
app container is the container, not the `llm` service. **Four other addresses in the template already name
services** (`REDIS_URL`, `QDRANT_URL`, `EMBEDDINGS_URL`, `RENDER_URL`), which is what made the two wrong ones look
deliberate. `onpremInit` now emits the in-network address for those two keys. `APP_ORIGIN` is left alone — it is
genuinely deployment-specific.

**3. The app image inherited the builder's umask and could not read its own source.**
`COPY . .` preserves the *host's* file modes and `USER node` drops to a non-root user. **Seventy tracked files in
the tree were mode 0600** while their neighbours were 0644 — invisible to `git`, which records only the executable
bit. Measured in the built image:

```
-rw-------  root root  /app/apps/api/src/onprem/s3.ts     <- unreadable by node
-rw-r--r--  root root  /app/apps/api/src/node.ts          <- readable
```

So `app` read *some* of its own source and not the rest, and died with
`EACCES: permission denied, open '/app/apps/api/src/onprem/s3.ts'`. Fixed with `RUN chmod -R a+rX /app` before
`USER node` — a permission **floor** rather than a `chown` to `node`, which would let the running user rewrite its
own code — and by making the seventy working-tree files readable (no diff; git tracks only `100644` vs `100755`).

**Verified after all three:**

```
docker compose up -d libsql migrate app   → exit 0
libsql running · migrate exited 0 · app running
/health → {"ok":true,"environment":"local",…}
```

**The lesson worth keeping.** The review had on-prem recorded as *build-complete*: thirteen services, three tested
adapters, a tested install script, a building image. **All of that was true, and the stack could not start.**
"Complete on inspection" is a statement about artefacts, not about a system — and the only thing that found any of
the three defects was executing it.

**Adjacent, and verified in the same round:** the `0055_numerous_tag` migration — the one whose journal absence CI
found — applies correctly to a **real libsql server**, not only to a local SQLite file: 56 rows in
`__drizzle_migrations` matching the 56-entry journal, `ledger_accounts.client_money_pair` present,
`axis_authorisations` and `north_metric_definitions` created.

## 3. Order of work

1. **Wiring defects** (done 2026-09-23): duplicate emits, consent bypass, save-desk
   events, dead seeded triggers with a guard, dashboard-schedule refusal, a
   path-literal guard, commission accrual on bind, NORTH alert delivery.
2. **Module switch** (ADR-0087, done 2026-09-23: routes, nav, sweeps and consumers): `enabled: false` makes a module's API answer
   a refusal, stops its sweeps and consumers, and removes it from the nav and the
   module switcher; cross-module features degrade explicitly (ORBIT hides AXIS
   tools).
3. **Per-module top gaps**, one module at a time, test-first, each checked by the
   layout sweep and the e2e journeys.
4. AI analytics and reports (ADR-0088) and per-record memory (ADR-0089) —
   merged 2026-09-23.

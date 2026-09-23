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

**No module can be switched off.** `PATCH /v1/core/modules/:module/config`
stores `enabled`, `autonomy` and `modelTier`; `moduleSettings()` resolves them;
`moduleEnabled()` (`packages/core/src/module-config.ts:39`) has no caller (docs/27,
2026-09-23 entry). API routers mount unconditionally (`apps/api/src/index.ts`),
the cron sweeps run for every tenant, and the only real switch is the build-time
`LYRA_MODULES` flag, which hides web screens. "Module off" today means "its
tables are empty". This is the first thing standalone operation needs, and it
wants an ADR (what a disabled module answers, whether its sweeps and consumers
stop, how the nav and the module switcher reflect it).

**Modules read each other's tables more than they exchange events.** The shared
schema means nothing fails at import time; features go quiet instead. SCOUT
imports SIGNAL engines and writes `signal_campaigns`; ORBIT imports AXIS engines
and writes `axis_cases`/`axis_tasks`; NORTH computes every metric from other
modules' tables and cannot run on imported data as its spec promises.

**Many emitted events have no in-process consumer**, and several seeded
consumers listen for events nothing emits. The in-process consumers are a
handful of branches in `apps/api/src/dispatch.ts` plus the generic journey and
webhook fan-out. Dead in both directions:

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
| ORBIT · Conversations | Zendesk, Intercom, Service Cloud, Sprinklr | 10 | 3 | 3 | No — imports AXIS engines, writes AXIS tables |
| SIGNAL · Marketing | HubSpot, Braze/Iterable, Ads managers, Marketo | 5 | 8 | 3 | Partly — studio yes; autopilot/attribution idle without AXIS/ORBIT |
| SCOUT · Market | Crayon/Klue, Similarweb, Qualtrics, Earnix/Akur8 | 8 | 4 | 4 | No — reads quotes/policies, writes SIGNAL |
| NORTH · Insight | Tableau Pulse, ThoughtSpot, Power BI, Anaplan | 5 | 7 | 4 | No — every metric reads other modules |
| Ledger | NetSuite, Sage Intacct, Xero, Insurity | 12 | 1 | 5 | Mostly — soft reads of NORTH/Dist/AXIS |
| Distribution | Salesforce PRM, Impartner, Applied Epic, Zywave | 9 | 4 | 2 | Partly — accrual needs AXIS policies |
| Compliance | OneTrust, TrustArc, Vanta/Drata | 8 | 6 | 3 | Serves SIGNAL/Ledger via events |
| Analytics | Looker, Power BI, Metabase, Mode | 6 | 4 | 6 | Reads everyone's tables by design |
| Admin / Platform | Okta/Entra, Retool/Backstage, Credo AI/Arize | 12 | 5 | 2 | Underpins every module |

## 2. Ranked gaps (buyer value ÷ effort)

### AXIS · Operations
1. ~~Document extraction from an uploaded file — the vision path exists in the API; the web screen demands pasted text.~~ **Fixed** 2026-09-23: an empty paste now reads the stored file (`axis-doc-intel.tsx`, test "reads the stored file when nothing is pasted").
2. Policy schedule produced on bind (the document engine exists; only a manual route calls it).
3. Quote desk issues through `/quote-responses/:id/bind` — needs the customer-at-shop decision (docs/27, 2026-09-23).
4. ~~Screens for NTU / lapse / reinstate~~ — **reviewer was wrong**: all three are declared actions on the policies tab (`apps/web/app/modules/axis.ts` `/{id}/ntu`, `/lapse`, `/reinstate`) and render on the generic record page. SLA prediction (`axis.ts:454`) still has no web caller.
5. Reinsurance treaties and cessions (missing).

### ORBIT · Conversations
1. Seeded journeys fire — emit `orbit.renewal.raised`; implement the `wait_for` node.
2. Save-desk outcomes emit `orbit.renewal.accepted`/`lost`.
3. Real-time AI replies on inbound, sent within the agent's autonomy.
4. Web chat channel (a `ChannelAdapter` plus a portal route).
5. Module-aware tools: hide AXIS tools when AXIS is off; replace direct `axis_cases` writes with an event AXIS consumes; route `bindPartner`.

### SIGNAL · Marketing
1. Writable spend with CSV import (unblocks the autopilot and `signal.spend.recorded`).
2. Standalone conversions: signed `lead`/`bind` touches on `/track`.
3. Full audience rules with a builder instead of raw JSON; lift the 500 cap.
4. Experiment engine: compute probability-to-beat-control; emit `signal.experiment.concluded`, `campaign.launched`, `creative.flagged`.
5. Ad-platform seam (`core/seams.ts`) with Google/Meta adapters — channels are allowed (CLAUDE.md §13).

### SCOUT · Market
1. Data-product subscribe/deliver routes (billing functions exist, called only from tests).
2. First external source adapter (news/RSS), per ADR-0078.
3. Watch alerts routed to notifications.
4. PDF wording diff via the AXIS extraction path.
5. Price elasticity from bench data on the pricing screen.

### NORTH · Insight
1. Schedule the brief with the nightly snapshot; emit `north.briefing.published`.
2. Deliver `north.alert.triggered` (notification consumer reading `notifyChannelRef`).
3. Metric push API — makes NORTH usable standalone on imported data.
4. Scenario engine (the what-if screen stores a question and nothing computes it).
5. Board-pack approval and distribution log.

### Ledger
1. Remove the duplicate settlement emits.
2. Cash-flow statement (indirect method).
3. Emit `ledger.recon.completed` and `ledger.period.closed`.
4. Budgets and budget-vs-actual.
5. Inbound bordereaux reconciliation.

### Distribution
1. Accrue commission on `axis.policy.issued` (idempotent consumer).
2. Fix the dead seeded triggers and webhook subscriptions.
3. Expose commission tiers (`structureJson`) in the rates form.
4. Referral qualify/settle desk (API exists, no screen).
5. Select → bind handoff.

### Compliance
1. Admin consent writes go through `recordConsent` so suppression fires.
2. Audit export in the UI (F59).
3. DSAR runner that erases (`forgetMemories`, notes, `erasureLog`) — part of the per-record memory build.
4. Screening hits block binding; a real screening provider behind the seam.
5. Scheduled retention with more record classes.

### Analytics
1. Dashboard schedules refused at creation until delivery supports them (today: accepted, then fail every run).
2. Schedule create screen.
3. Report builder and natural-language questions — **in progress** (AI analytics build).
4. Readable dimension labels.
5. Dashboard tile editor with filters.

### Admin / Platform
1. ~~Agents CRUD could raise autonomy without the dual-control approval~~ — **fixed** 2026-09-23 (`resources.ts` agents `beforeWrite`, `ai.test.ts` "the agents CRUD cannot move autonomy").
2. Audit log filters, search and export.
3. Approvals pagination (F60).
4. DLQ replay and a button for the platform AI kill switch.
5. SCIM provisioning; then SAML.

## 3. Order of work

1. **Wiring defects** (in progress): duplicate emits, consent bypass, save-desk
   events, dead seeded triggers with a guard, dashboard-schedule refusal, a
   path-literal guard, commission accrual on bind, NORTH alert delivery.
2. **Module switch** (needs an ADR): `enabled: false` makes a module's API answer
   a refusal, stops its sweeps and consumers, and removes it from the nav and the
   module switcher; cross-module features degrade explicitly (ORBIT hides AXIS
   tools).
3. **Per-module top gaps**, one module at a time, test-first, each checked by the
   layout sweep and the e2e journeys.
4. AI analytics and reports, and per-record memory — built in parallel
   (2026-09-23), merged when green.

# 22 — UI Design: Transaction, Social, Launch & Builder Surfaces

Extends docs/07 (Constellation system) and docs/15 (Experience Excellence) to
the surfaces introduced by docs/19–21. Same tokens, same premium bar, same
ambient-AI grammar — applied to money, content and configuration, which each
carry their own trust requirements.

**How to read the status markers.** This is a spec of intent; everything below
stays whether or not it is built yet. Each surface carries one of **Built**,
**Partly built** or **Not yet built**, and where a built surface shipped
differently from the paragraph above it, an *As built* note says how. The code
is authoritative for what exists; this document is authoritative for what it is
supposed to become.

## 1. Money surfaces — designing for immutability and trust

**Design thesis.** Financial UI earns trust by making irreversibility visible.
Posted entries must *look* sealed; anything editable must look editable. No
ambiguity, ever.

**Sealed treatment.** Posted journal lines render on `ink-800` with a 1px
`ink-600` inner ring, a hairline left rule in `ion-500`, no hover elevation, and
no edit affordance in the DOM at all (not disabled — absent). Draft/pending
transactions render on `ink-700` with a dashed rule and visible controls.

*As built:* the sealed/draft distinction is a kit feature, not a per-screen
one — `Table`'s row treatment and `PostingFlow`'s sealed legs
(`packages/ui/src/data.tsx`, `packages/ui/src/flow.tsx`) carry it, and
"sealed rows never gain hover elevation" is a comment on the code that
implements it. Colours follow the Horizon surface ramp and hue tokens rather
than the literal `ink-800` / `ion-500` stops named here (docs/07 §1.3).

### 1.1 Ledger Explorer — **Built**, across three routes
- Virtualised journal table: date · txn code · description · account · debit ·
  credit · currency · base equivalent · batch · actor. Tabular numerals
  throughout; debits and credits in separate columns, never signed in one.
- Sticky trial-balance footer that recomputes live and shows the balance check
  as a single ✓/✗ chip — the most important pixel on the screen.
- Filters: account, transaction type, actor, currency, period, amount range;
  natural-language filter compiles to a visible query (docs/15 §4.6).
- Every row expands to the full transaction envelope; every row exports with its
  evidence manifest.

*As built:* the explorer is three routes, not one — `/ledger/statement`
(account statement, opening/closing balance, debit and credit in their own
columns), `/ledger/journal` (manual entry, with the live balance check and a
submit control that stays inert until debits equal credits) and
`/ledger/reports/:report` (six reports from `/v1/ledger/reports` behind one
route). `/ledger/transactions` lists open transactions and each row links to
§1.3 rather than expanding in place. The table is **not virtualised** and paging
is the server's (docs/07 §2.1). The live trial-balance footer exists on the
manual-journal screen; a **natural-language filter is not yet built**.

### 1.2 Money Map — **Built**
- Sankey of value flow for a period: premium written → {cancelled, collected,
  still due} → premium in → insurer remittance → commission retained → partner
  share → tax → net. Nodes are clickable to filtered journals.
- Premium written is the bind family's Dr `1200 Premium Receivable` (docs/27
  F14), so a month of binds no customer has paid for yet is drawn, not empty.
  The period identity is **written = collected + still due + cancelled**:
  `premium-written` is 1200 debits under BIND, BIND-GROUP, RENEW, REINSTATE,
  PARTNER-BIND and AGENT-BIND; `premium-cancelled` the 1200 credits under the
  same types (a reversal posts under its original's type); `premium-collected`
  the 1200 credits under CM-RECEIPT, PREM-COLLECT and PREM-INSTALMENT (a receipt
  that clears the receivable, which is also cash on 1010 and so part of premium
  in); `premium-due` is the remainder, with no drill of its own. The signed
  remainder travels as `uncollectedMinor`; a negative one (receivables written
  earlier, collected now) is stated, not drawn, as `carriedMinor` is.
- Client-money segregation shown as a distinct, always-visible bar: cash held vs
  obligations, with the invariant margin. If it ever narrows, the bar turns
  `flare-500` and the Money Map surfaces a `CM-BREACH-FLAG` banner above
  everything else on the page.

*As built:* `/ledger/money-map` (`apps/web/app/routes/ledger-money-map.tsx`) —
a hand-laid SVG flow, not a charting library (docs/07 §2.1). Node drill-down is
a server round trip via `?node=`, so the filtered lines are the server's answer
rather than a client filter that could disagree with it. The breach flag ships
as a `role="alert"` section carrying `data-flag="CM-BREACH-FLAG"`, rendered
above everything else, and a breach outranks every other headline on the page.
The segregation bar is one row per currency: cash held, what is owed, the
margin. Columns with nothing in them collapse, so a commission-only month (no
written premium) and an unpaid month (no premium in) both span the width. When
net is zero and premium was written, the headline names the written figure and
what is still due on it rather than "net: 0" over a month of real business.

Every premium receipt (the generic `POST /v1/ledger/txn/…` endpoint and the
premium-financing instalment engine) is built by `premiumReceiptLines`, which
clears whatever the bind left open on 1200 for the item the receipt names
(ADR-0114). So a paid policy lands on `premium-collected` and leaves
`premium-due`; before that, no payment path cleared 1200 and every bound premium
read as still due. Cancellation does not yet credit 1200 for an unpaid portion
(ADR-0114, "Not decided here"); a reversed bind does.

### 1.3 Transaction Detail — **Built**
- Left: state-machine timeline (initiated → … → settled) with timestamps, actor
  chips (human/agent + autonomy level), and any `pending_external` waits shown as
  named steps, not spinners.
- Centre: journal lines (sealed), amounts with currency + base, saga steps with
  compensation status.
- Right: approvals (who, when, reason), guardrail results (consent, disclosure,
  sanctions), evidence list with hashes, and — where AI participated — the
  reasoning summary with an evidence link.
- Footer: `Reverse` and `Adjust` as deliberately low-glamour, permissioned
  controls that open a reason-coded dialog; never one-click, never primary-styled.

*As built:* `/ledger/transactions/:id`. The timeline is `StateFlow` and the
lines are `PostingFlow` (docs/07 §2.3): the flow is drawn from the documented
machine plus the transitions the transaction actually recorded, and the legs are
re-added on render so a total that disagrees with the ledger prints an em-dash
instead of a figure. Reversal is an idempotent, permissioned, confirmed action
that shows the counter-entry link from either end of the pair; when policy
raises a gate, the 403's `approval_required` policy key is rendered as the
reason (§5.4). A separate `Adjust` control is **not yet built** — reversal plus
a fresh entry is the path.

### 1.4 Reconciliation Workbench — **Partly built**
- Three panes: **statement** (imported) · **system** (our transactions) ·
  **variance**. Matched pairs collapse; variances stay open with a reason
  taxonomy.
- AI-proposed matches appear as ghost pairings with confidence, accepted with a
  single keystroke and never auto-posted (docs/19 §6). Bulk-accept requires a
  confidence floor and logs a single approval covering the batch.
- Progress ring shows match rate against target; export produces the evidence
  bundle.

*As built:* `/ledger/recon` — run summary, run history and a proposed-match
table where each row carries its confidence and is decided one at a time, with
who and why written onto the match by the API. The doctrine holds ("a
reconciliation run is arithmetic; deciding a match is a judgement" — nothing
auto-posts). **Not yet built:** the three-pane statement/system/variance layout,
single-keystroke acceptance, bulk-accept with a confidence floor and its batch
approval, and the progress ring.

### 1.5 Settlement Runs & Period Close — **Built**
- Run cards: scope, counts, totals, exceptions, approver, state. A run cannot be
  approved with open exceptions — the button explains why rather than disabling
  silently.
- Period Close: a checklist with owners (recognition, revaluation, recon
  sign-offs, client-money proof), each item linking to its evidence; close is a
  single irreversible action with a confirmation that states what becomes
  contra-only afterwards.

*As built:* `/ledger/settlement` and `/ledger/settlements/:id` for runs
(`draft → approved → paid`, with `disputed` as an exit, drawn by `StateFlow`);
settling and paying are separate permissions (`ledger:settlements:settle`,
`ledger:payouts:approve`), so approving and paying are separate screens' worth
of authority. `/ledger/period-close` and `/ledger/year-end` carry the close.
Confirmations state their consequence — a redraft of a draft period replaces its
figures, a redraft of an approved one returns it untouched.

## 2. Social Studio

### 2.1 Composer — **Partly built**
- Three-column: **content** (copy fields per platform, variant tabs, asset rail)
  · **live previews** (real per-platform chrome: IG feed/reel, TikTok, X, LinkedIn,
  FB, YouTube, WhatsApp) rendered side by side and re-rendering as you type ·
  **governance** (compliance chip, disclosures, approvals, schedule).
- The compliance chip is the gate: grey → checking → green (pass) or amber
  (flagged, with the specific rule quoted) or red (hard block). **The schedule
  control does not exist until the chip is green** — no disabled-button
  guesswork.
- Arabic and English shown as parallel columns, each with its own preview and
  its own review state; RTL previews are genuinely RTL, including caption
  truncation behaviour.
- Ghost text throughout (docs/15 §4.1); the ✦ marker on AI-drafted fields;
  per-field "why this angle?" evidence popovers back to the brief.
- Aspect-ratio strip shows every derived crop with safe-area overlays; a crop
  failing a platform's safe area is flagged before publish, not after.

*As built:* `/signal/studio` is a brief-and-variants desk, not the three-column
composer. A campaign brief generates up to eight variants via
`/v1/signal/creatives/generate`; each variant carries its compliance status, a
blocked one renders `GuardrailNotice` with the rule, and variants can be edited,
cleared or discarded. The aspect-ratio strip exists as the post-card preview at
the three `POST_RATIOS` (square, portrait, story) — and the preview and the
download route render the *same* SVG bytes, so what is approved is what ships.
**Not yet built:** per-platform preview chrome, the parallel en/ar review
columns, the scheduling control and its green-chip gate, and safe-area overlays.

### 2.2 Calendar — **Not yet built**
- Month/week with **channel lanes**, colour-coded by pillar (not by channel —
  pillars are the strategy). Drag to reschedule within permitted windows;
  blackout windows and market holidays shown as ruled bands.
- Density controls; a "gaps" overlay highlights cadence shortfalls per pillar and
  market. Hovering a slot shows the preview thumbnail plus its approval state.

### 2.3 Publish Queue & Channel Health — **Not yet built**
- Queue rows show attempt state per target with the platform's returned id on
  success and the platform's own error text on failure (never a generic
  "something went wrong").
- Channel Health strip: token validity, permission scope, rate-limit headroom,
  and — critically — an explicit **"assisted publish only"** badge where a
  platform's policy or app-approval state prevents direct posting (docs/20 §9).

### 2.4 Inbox & Listening — **Not yet built**
- Triage queue, keyboard-first (J/K, 1–9 dispositions), with intent and sentiment
  chips, language flag, and a single-key handover to ORBIT when licensed.
- Listening board: topic momentum, share-of-voice, and a crisis lane that pins
  above the fold with an escalation path and an owner.

*Note:* the SIGNAL rail currently carries cockpit, studio, audience value,
answer engines, experiments, budget, analytics, admin and dev — none of §2.2–2.4.
A handover component to ORBIT exists (`apps/web/app/components/signal-handover.tsx`)
but not the inbox it would be triggered from.

## 3. Launch Cockpit — **Not yet built**

- A horizontal **gate rail**: Evidence → Product → Pricing → Compliance →
  Content → Channels → Paid → Launch → Measure. Each gate is a card with owner
  avatar, state chip, blocking-items count, and a countdown to the target date.
- Clicking a gate slides in its workspace; the rail stays visible so the whole
  launch is always legible at a glance.
- The Launch Conductor's chase list appears as a quiet ledger ("2 owners nudged,
  1 gate at risk"), never as nagging modals.
- Post-launch, the same rail becomes the retrospective: planned vs actual per
  gate, and the measured outcome from the metric layer.

*Note:* `/signal/cockpit` is a **spend** cockpit — pacing, channel performance,
budget moves and CAC — and is not this gate rail. The name collision is real;
this surface has no route yet.

## 4. Builder surfaces

### 4.1 Bot Builder (Lyra Bots edition) — **Not yet built**
- Flow canvas with typed nodes (message, ask, branch, tool call, handover, wait),
  live validation, and unreachable-path warnings.
- Right rail: persona, tone, guardrails, knowledge sources, tool matrix with
  scope badges (read/write/consequential).
- Test console: scripted personas (including Arabic dialect personas), replayable
  transcripts, and a diff view when a change alters behaviour on saved cases —
  the closest thing to unit tests inside the product.
- Deploy: draft → sandbox → live with a visible diff and one-click rollback.

### 4.2 Domain Pack Configurator — **Not yet built**
- Two-column mapping table (Lyra primitive → tenant vocabulary) with a live
  preview panel that re-renders three real screens using the new vocabulary, so
  the effect is seen before saving.
- Compliance floors shown as locked rows with a padlock and an explanation —
  visibly not editable.
- Diff + version history; entity remapping warns that it is not a live-safe
  change.

*Note:* domain packs today are code tables (`apps/web/app/modules/vocabulary.ts`
and `labelsFrom(LABELS)`), and tenant policy stores only the pack's *name*
(`domainPack`, defaulting to `insurance-retail`). A configurator would first
need packs to become tenant data.

### 4.3 Journey, SOP, Audience & Metric builders — **Partly built**
Consistent shell for all low-code builders: canvas/table, versioning header
(draft/published + version chip), **Simulate** as a primary action, diff-on-
publish, rollback in the version menu, and guardrail floors rendered as locked
elements. One grammar learned once.

*As built:* only the ORBIT journey editor exists
(`/orbit/journeys/:id/builder`), and deliberately as **forms, not a canvas** —
the graph the runtime reads is a list of nodes and a list of edges, so the
editor edits that list. ADR-0014 defers the visual builder (ORB-050) out of
go-live scope and records `graph_json` as a docs/16 seam. SOP, audience and
metric builders are **not yet built**, and so is the shared versioning /
simulate / diff-on-publish shell.

## 5. Cross-surface rules

1. Money always shows currency and base-currency equivalent; never a bare number.
   *Enforced by* `Money` / `MoneyField` in `packages/ui/src/format.tsx`, cited at
   every money call site in `apps/web`.
2. Anything irreversible states its consequence in the confirmation, and names
   the reversal path if one exists.
3. Anything AI-produced carries ✦ and explains itself within one interaction.
   *Enforced by* `AGENT_MARK` and `Provenance` (docs/07 §2.2, §2.5).
4. Anything gated shows the gate and the reason, not a disabled control.
   *Enforced by* `ApprovalStrip`'s `blockedReason` and `GuardrailNotice` — "a
   dead button teaches nothing".
5. Anything platform-limited shows the limitation and the fallback path.
6. Every builder can be simulated before it is published. *Aspirational: no
   builder currently offers Simulate (§4.3).*
7. Every list is keyboard-navigable, saved-viewable and exportable within
   permission. *As built:* keyboard reachability is a kit guarantee (the table's
   `role="region"` / `tabIndex={0}`, asserted in `ui.test.ts`); saved views are
   per-screen where they exist and are **not** a kit feature.
8. All of the above verified against the 20-point premium bar (docs/15 §6) per
   release, including RTL, dark/light, and reduced-motion parity. *As built:* the
   automated part of this is the `e2e` job — `expectNoA11yViolations` inside the
   journeys plus `e2e/pseudo-locale.spec.ts` for RTL (docs/07 §5). Whether the
   full 20-point bar is walked per release is not determined from code.

# 27 — Feature gap register (SME review, 2026-08)

Eight domain experts read the code as written, not the docs as promised:
market intelligence (SCOUT), admin/compliance, marketing (SIGNAL), insurance
operations (AXIS), Middle East market fit, customer service (ORBIT), AI
platform, and finance/ledger.

This register is the synthesis. It is a *findings* document, not a plan — each
P0/P1 needs an ADR or a spec update before it becomes work. Line references
were accurate at the commit that closed the go-live remediation program.

Findings that have since been fixed are marked *Closed* with what closed them,
so the register stays a record of what was found rather than being rewritten.
The P0 list was re-verified against the code on 2026-08-12; the verdict table
below is the original synthesis and is not updated as items close.

**One-line verdict per domain**

| Domain | Verdict |
| --- | --- |
| Finance/ledger | Real double-entry engine, no accounting department around it |
| AXIS | A document-and-case workbench with approval gates, not an insurance system |
| ORBIT | A console with no channels, no routing, and no confirmed AI draft producer |
| SCOUT | A good data model and labelling layer over almost no live intelligence |
| SIGNAL | Content generation without the publish loop it advertises |
| AI platform | Correct gateway discipline; the loop above it is one tool round-trip |
| Admin/compliance | The strongest area; gaps are depth, not absence |
| Middle East | Would win a technical evaluation, would not close against an incumbent |

---

## P0 — would fail in front of a paying customer

**F1. The ledger posting path is not atomic.** *Closed 2026-08-07 (`1093d7c`).*
`post()` now decides everything before it writes, assembles the header, the
lines, the balance upserts, the client-money check row and the transaction
stamp into one `Write[]`, and hands the set to `atomically()`
(`packages/db/src/tx.ts`) — the one capability D1 and libSQL share, so the
posting lands whole or not at all on both homes.

**F2. No manual journal.** *Closed 2026-08-12
(`docs/specs/gap-finance-design.md`).* `MANUAL-JRNL` is a real transaction type
whose recipe (`recipes.ts` `manualJournal()`) posts the lines the author wrote,
and the orphaned `ledger.manual_journal` approval policy is now the gate on it:
`ledger:journals:draft` opens the draft, a second seat approves, and only then
does it post. The two things it may not express are refused rather than
policed by convention — client-money accounts and any 3xxx equity row.
`/ledger/journal` is the screen.

**F3. No equity accounts, so no year-end close.** *Closed 2026-08-12
(`docs/specs/gap-finance-design.md`).* The chart carries 3000/3100/3200;
`balanceSheet` reports posted equity plus the current year's unposted result
instead of plugging the difference; and `YEAR-END-CLOSE` sweeps income and
expense into retained earnings (3100) under the idempotency key
`yearend:{year}`, so a second attempt is a 409 rather than a second posting.
`TXN_PRECONDITIONS` refuses a year with any period still open, and
`closePeriod`/`reopenPeriod` own the gates on the months themselves.
`/ledger/year-end` is the screen.

**F4. AXIS cannot bind.** *Closed.* `POST /v1/axis/quote-responses/:id/bind`
issues the policy from the selected panel response, under an idempotency key;
`api/src/axis-bind.test.ts` holds the replay and refusal cases.

**F5. AXIS has no endorsement, cancellation, lapse, or renewal.** *Closed.*
`axis_policy_versions` carries `versionSeq` and `endorsementNo`
(`schema/axis.ts:195-225`); `engines/axis-endorse.ts` prices and applies a
mid-term change and `engines/axis-lifecycle.ts` carries cancel, NTU, lapse,
reinstate and renew, with `sweepPolicyLifecycle` on the cron tick.

**F6. ORBIT has no inbound channel of any kind.** *Closed (ADR-0037/0038).*
`engines/orbit-channel-inbound.ts` takes signature-verified inbound over the
`Channel` adapter seam, with WhatsApp and Mailgun adapters
(`orbit-channel-whatsapp.ts`, `orbit-channel-mailgun.ts`) and an outbound
counterpart.

**F7. No confirmed producer of AI draft replies.** *Closed 2026-08-12
(ADR-0058).* `engines/orbit-draft.ts` is the missing middle: a per-tenant sweep
on the cron tick drafts the next reply for every conversation whose newest
message is the customer's, which is also its idempotency key. Context is
assembled from the database so `verifyGroundedness` can score it — an
ungrounded draft is a `refused` `ai_runs` row, never an inbox entry — and the
same scorer backs `evals/orbit-draft`. The seeded `service` agent is the off
switch; `POST /v1/orbit/drafts/sweep` forces a run.

**F8. Production never configures the model gateway.** *Closed.*
`customerFacing` now comes from the purpose catalogue
(`model-gateway/src/purposes.ts`), which `gateway.ts:156` passes into the
guardrails, so `regulated_claim` blocks on every customer-facing purpose
without a per-tenant setting. `gatewayFor(env)` (`api/src/mw.ts`) passes the
provider bindings it actually has; model choice stays with
`ctx.policy.modelOverrides`.

**F9. Retrieval is tenant-scoped, not subject-scoped.** *Closed.*
`routes/ai.ts` filters recall on `{ tenantId, conversationId: subjectRef }`
and recalls nothing when there is no subject.

**F10. No eval exercises a model.** *Closed.* `evals/live.ts` holds the
live scorers, gated behind `LYRA_EVAL_LIVE=1` (`pnpm eval:live`) so CI stays
deterministic, and `run.ts` now fails — rather than skips — an eval directory
with no scorer registered.

**F11. SCOUT's cold-start Radar is broken by construction.** *Closed 2026-08-12.*
The two nulls were the symptom; the cause was that nothing wrote `scout_clusters`
outside the seed. `sweepWhitespace` is now the Clusterer run — it persists one
cluster per category (re-scored in place on every sweep) and links each
whitespace row to it, and scores competition as panel breadth.

**F12. Three SCOUT routes are dead links.** *Closed 2026-08-12.* `/scout/pricing`,
`/scout/experiments`, `/scout/analytics` were linked from `scout-panel.tsx` and
`scout-radar.tsx` but not registered in `routes.ts`, stranding ~200 lines of
`scout.shared.ts`. All three screens are now built, registered, and listed in
the SCOUT workspace tools (`apps/web/app/modules/scout.ts`).

**F13. `axis_quotes` is written only by the seed.** *Closed.*
`dist_quote_responses` is now the single source of quote truth — the desk, the
bind path and the customer-facing comparison all read it, and
`api/src/axis-quotes-source.test.ts` holds that line.

---

## P1 — blocks a serious pilot

*Finance.* **F14–F22 are closed** (2026-09-18). What each one was, and what
closed it:

**F14** *Closed.* Premium accounting was cash-basis only — `1200 Premium
Receivable` appeared once, as a chargeback default, and `2000 Insurer Payable`
was posted by nothing, so GWP was never a receivable. `bindPosting`
(`recipes.ts`) books Dr 1200 / Cr 2000 beside the commission accrual whenever
`gwpMinor` is stated, and `clientMoneyReceipt` clears the receivable and
reclassifies the payable when the premium arrives. Both production bind sites
pass it. ADR-0079 names what is deliberately out of scope: ENDORSE,
UBI-REPRICE and CANCEL need a *signed* premium movement of their own.

**F15** *Closed.* Aging aged journal lines by posting date against a free-text
counterparty, and had no payables side. `agedOpenItems` (`reports.ts`) groups
lines into open *items* by `dims.item`, ages them from `dims.dueAt` (falling
back to the raise date — never to today, which would report every unpaid item
as current), and reads the liability accounts for `kind: "payable"`.
`agedBalances` stays reachable behind `?legacy=1` for one release.

**F16** *Closed.* `packages/ledger/src/statements.ts` reads CAMT.053, MT940 and
OFX, detecting the format from the file's content rather than its name, and
hands `reconcile()` the shape it already took. Money is parsed as text, not
through a float. `POST /v1/ledger/recon/runs` accepts `statementText`, and the
recon screen has a real file input.

**F17** *Closed.* `ledger_tax_rules` had no reader and `taxPpm` was applied as
`?? 0`, so "tax is never inferred" was implemented as "always inferred, as
nothing". `taxTreatment` (`core/src/tax.ts`) resolves the market rulepack's
rate or **throws**; `quoteCommission` honours a stated rate and refuses an
omitted one. `policy.taxMarket` is the jurisdiction dimension docs/29 found
missing. ADR-0078.

**F18** *Closed.* `fxRevaluationPlan` (`reports.ts`) values every open foreign
monetary position at the closing rate and reports the difference; `FX-REVAL`
posts it in base currency to 4095 / 5500. Client money is excluded — that
exposure is the client's. The `revalues` dim ties a base-currency adjustment
back to the position it corrected, so the second run is flat.

**F19** *Closed.* `decideMatch` books `CMSN-SETL` on a confirmed insurer match,
under `recon-setl:{matchId}`; `settleRun` covers the deterministic matches that
never reach a reviewer. The *statement's* amount clears — the variance stays on
1100 for a controller, because a recon that closes its own gap can never report
one.

**F20** *Closed.* `force` now requires a reason of at least ten characters
naming the break being accepted, is refused over a month that passes every
check, carries the failing checks into the approval request, and persists to
`ledger_periods.state_reason`. `reopenPeriod` does have an approval gate
(`ledger.period_reopen`, added after this register was written); it now
requires a reason too.

**F21** *Closed.* `TXN_PRECONDITIONS["SUCCESS-FEE"]` requires an
`args.metricSnapshotId` naming a `north_snapshots` row in this tenant with
`verified_at` set. `POST /v1/north/snapshots/:id/verify` is the only writer of
that column and takes a required evidence ref.

**F22** *Closed.* fast-check is a dependency and `packages/ledger/src/properties.test.ts`
holds all eleven docs/19 §11 obligations as property tests. It found three real
defects on its first run: a claim float could go negative (1010 ≥ 2010 does not
imply it — CLAIM-PAY moves both sides equally, so an unfunded payout kept them
equal and negative); `ledger.refund` was missing `neverAutoApprove` despite
REFUND-ISSUE being a payout; and obligation 9 had nowhere to live, so
`recognition.ts` now holds the schedule split and the ceiling that
`sweepBilling` enforces against the ledger's own released total.

*AXIS.* Claims carry two money fields (`schema/axis.ts:227-252`); reserve is one
mutable integer overwritten in place (`claim-detail.tsx:452-460`), settlement
flips straight to `settled` (`:270-282`), and no claim-payment recipe exists
(**F23**). No coverage-in-force check at FNOL — `claim-detail.tsx:221` loads the
policy for display only (**F24**). Premium is a free-text integer with no
tax/fee split and no collection (`paymentPlanJson` is `// H9 reserved`)
(**F25**). No policy document generation; `axis-zero-touch.test.ts:217` concedes
it and substitutes an analytics PDF (**F26**). No state machine on policies or
claims (**F27**). Absent surfaces: FNOL intake, claims desk, endorsement wizard,
cancellation flow, renewal desk, underwriting referral desk, complaints
register, SIU queue (**F28**).

*ORBIT.* No routing or queueing engine — the only agent action is self-assign
(`orbit-console.tsx:267-282`); `LiveConversation.teamId` (`:45`) is never used;
`SLOW_MS` (`:66`) is a hardcoded 15 minutes that only recolours a badge
(**F29**). Journey execution never advances past the trigger —
`triggerJourney:84-165` writes a run at `startNode()` and nothing advances
`wait`/`send`/`branch`/`task` (**F30**). `ORBIT_TOOL_DEFS`
(`engines/orbit-tools.ts:14-57`) ships 3 of the 8 tools `docs/modules/orbit.md`
promises (**F31**). No KB/RAG article manager, no macros, no deflection
(**F32**).

*AI platform.* The agent loop is capped at one tool round-trip and the second
call is toolless (`routes/ai.ts:123-142`) (**F33**). `core_memories`
(`schema/core.ts:519-532`) is never read or written (**F34**). No streaming
anywhere, against `docs/15` §2 "streamed always" (**F35**). No cross-provider
fallback — `gateway.ts:110-119` retries the identical provider and model
(**F36**). Injection scanning covers only `role === "user"` (`gateway.ts:69-71`)
while tool results are pushed back as `{role: "tool"}`
(`orbit-tools.ts:238`), so indirect injection via tool output is unscreened
(**F37**). `consequential: true` is written to `ai_tool_calls`
(`orbit-tools.ts:229`) and nothing branches on it (**F38**). `autonomyLevel` has
zero production reads, three inconsistent enum vocabularies exist
(`core/src/seams.ts:39`, `routes/ai.ts:484`, `docs/16` L0–L3), and
`AutonomyEnvelope` (`seams.ts:40-45`) has no implementation — the doc-comment
at `:34-38` claiming enforcement is false (**F39**). `purpose` is
caller-controlled (`ai.ts:36`) and safety keys off it (**F40**). Guardrail
floors are six hard-coded English regexes with no Arabic
(`guardrails.ts:17-46`), contradicting `docs/16` H12 (**F41**).

*AI platform — closed 2026-09-18.* Seven of the nine above are closed, each
with its golden set authored first under `packages/model-gateway/evals`
(CLAUDE.md, AI features are eval-first). F39 stands where ADR-0049 left it.

- **F33** *Closed.* `POST /v1/ai/runs` is a bounded multi-round loop. The two
  decisions that define a loop are pure and in the gateway where an eval can
  reach them — `planRound`/`offersTools` (`model-gateway/src/agent-loop.ts`),
  `evals/agent-loop` — because an API unit test mocks the gateway and the
  database, which is how a loop that could not loop stayed green. The command
  loop had the same defect behind a `while` that could run six times:
  `seq === 0 ? { tools } : {}` made rounds two to six toolless. Both now share
  one ceiling and one rule; the terminator stays toolless so a run always ends
  in prose rather than a dropped request.
- **F34** *Closed.* `packages/core/src/memory.ts` — `remember`,
  `recallMemories`, `forgetMemories`, and `recallable` as the purpose-bound
  selection rule (`evals/memory-recall`). Three rules fail closed: a memory
  with no `purposesJson` is read by nothing, an unrecognised sensitivity ranks
  above the scale, and `maxSensitivity` has no default. Read and written by the
  ORBIT run, so it is not a seam waiting for a caller. `forgetMemories` is the
  erasure link and is honestly labelled: no DSAR runner calls it yet.
- **F35** *Closed.* `Gateway.stream` + `POST /v1/ai/runs/stream` (SSE).
  `guardChunk` (`src/stream-guard.ts`, `evals/streaming`) runs the real output
  rule over the accumulated text behind a holdback sized against the rules —
  a per-chunk check misses any phrase split across a boundary, and emitted text
  cannot be recalled. `preflight()` is shared with `complete()`, so a streamed
  call is budgeted, scrubbed, screened and audited by the same code. Two stated
  limits: no tools on a streamed call, and no fallback past the first byte.
- **F36** *Closed.* `fallbackChain` (`src/models.ts`, `evals/provider-fallback`)
  — one link per provider, the tier's own route among the candidates, links
  with no credentials dropped rather than attempted, and on-prem pinned to the
  primary alone so an outage cannot become a residency breach. A 400/404/422
  stops the chain.
- **F37** *Closed earlier* at `gateway.ts` (`role === "tool"` screened as
  untrusted); the command loop's remaining hole is closed too — it formatted
  tool results back as ordinary `role: "user"` turns, where the screen only
  warns, and now marks them `untrusted`.
- **F38** *Closed.* Two lines, the first preventive: a consequential tool is
  dispatched only if `POLICY_FOR_TOOL` names its approval policy, so a new one
  with no gate refuses rather than runs. Then `verdictFor` compares the call
  against `gate()`'s own audit trail — not against tenant policy, because
  `gate()` has three legitimate paths that return no approval id.
- **F40** *Closed earlier.* `purposes.ts` is the governed vocabulary;
  `resolvePurpose` fails closed on an unknown or cross-module pair and
  `isKnownPurpose` rejects at the door.
- **F41** *Closed.* Six Arabic regulated-claim patterns mirroring the English
  six (`evals/guardrails-ar`). `\b` is ASCII-only in JavaScript and bounds
  nothing in Arabic script; `(?<!\p{L})` with the `u` flag is the equivalent.

*Middle East.* `localeFrom()` (`i18n.ts:138-140`) strips to the base subtag, so
`ar-SA` Eastern Arabic-Indic digits can never render (**F42**). Zero regional
payment rails — Telr, PayFort, PayTabs, Network International, mada, STC Pay,
Benefit Pay all absent (**F43**). KYC/national ID is a declared-but-empty
`IdentityVerifier` seam (ADR-0018) (**F44**). Takaful has schema and a
conditional card but no Shariah-board workflow or surplus distribution
(**F45**). Only cx-quality (5/10 Arabic) and axis (12/24) have Arabic eval
cases; north, compliance, injection, signal and axis-copilot have **zero** —
exactly the safety gates (**F46**). `docs/12:79` claims drift monitors sample
production weekly; nothing implements it (**F47**).

*NORTH.* The anomaly detector compares a period against the previous *write of
the same period* (`north-snapshotter.ts:305-336`), so day-grain anomalies never
fire and month-grain anomalies cry wolf at every month start (**F48**). NORTH's
financial metrics sum `axis_policies` directly (`:105-114`) and never read the
ledger, so the AI briefing narrates a figure that can never be tied to the
trial balance — and `verifyNumericClaims` then verifies the narrative against
that unverified source (**F49**). All eight specified screens now exist, on six
bespoke plus eight CRUD routes, including scenarios, decisions and a
channel-level driver decomposition on anomalies; only the forecast endpoint is
still absent (**F50**).

*SCOUT.* No source ingestion, no live clustering
(`core/src/seed/scout.ts:31` is seed-only), no Bench Builder
(`resources.ts:485-491` seed-only), no competitor or regulatory watch
(**F51**). `VEC_MARKET` embeddings are written (`resources.ts:462-469`) and
never queried (**F52**).

### P1 re-verification, 2026-08-12

The P1 prose above is the original synthesis and is not rewritten. This is what
a read of the current code says about it. Items not listed were not re-checked
and should be assumed to stand.

*Closed.*

- **F20** — both gates exist. `closePeriod` requires
  `ledger:periods:force_close` rather than `ledger:periods:close` when `force`
  is set (`packages/ledger/src/periods.ts:178`) and gates on
  `ledger.period_close_force`; `reopenPeriod` (`:237-240`) requires
  `ledger:periods:reopen` and gates on `ledger.period_reopen`.
- **F24** — FNOL resolves coverage state before the claim exists:
  `apps/api/src/engines/axis-fnol.ts:115-122` returns `in_force` and pins the
  policy version, limits and deductible, or refuses.
- **F26** — `apps/api/src/engines/axis-policy-document.ts` generates the policy
  document; the analytics-PDF substitute is gone.
- **F27** — `axis-claim-lifecycle.ts` and `axis-case-lifecycle.ts` are the state
  machines.
- **F29** — `apps/api/src/engines/orbit-routing.ts` is the routing and queueing
  engine: `pickRoute`, `pickAssignee`, `routeConversation`, `sweepRouting`,
  with `PRESENCE_STALE_MS` replacing the hardcoded badge threshold.
- **F28** — closed. The last three surfaces ship: the underwriting referral desk
  as a bespoke route (`apps/web/app/routes/referral-desk.tsx`, `/axis/referrals`
  — bespoke because the decide body carries its own `intent`, which the
  declarative `ActionSpec` path cannot express), and the complaints register and
  SIU queue as declarative tabs on the AXIS workspace. All eight named surfaces
  are now reachable from the workspace tools list, including the claims desk and
  renewal desk, which had descriptions in `routing.ts` but no link.
- **F37** — the injection scan covers tool output:
  `packages/model-gateway/src/gateway.ts:78` is
  `m.role === "user" || m.role === "tool"`.

*Partly closed.*

- **F23** — `CLAIM-PAY` is a real recipe (`packages/ledger/src/recipes.ts:488`)
  and the claim lifecycle owns reserve and settlement. The two-money-field
  schema shape is unchanged.
- **F25** — `paymentPlanJson` is read: `axis-lifecycle.ts:637-647` sweeps active
  policies for a missed instalment. The tax/fee split on premium is still absent
  and the column comment still reads `// H9 reserved`.
- **F31** — `ORBIT_TOOL_DEFS` carries six of the eight tools, not three.
- **F39** — `autonomyLevel` has production reads now
  (`signal-autopilot.ts:365` filters campaigns on it, `orbit-draft.ts:98`
  carries it). The three enum vocabularies and the unimplemented
  `AutonomyEnvelope` stand.

*Stands, re-verified.*

- **F14** — no recipe posts `1200 Premium Receivable` or `2000 Insurer Payable`;
  the commission recipes default `receivableAccount` to `1100`.
- **F16** — no CAMT, MT940 or OFX anywhere in the tree.
- **F18** — no revaluation code.
- **F19** — `decideMatch` (`recon.ts:297-330`) still only sets match state and
  audits; it books nothing.
- **F22** — `fast-check` is not a dependency of any package.
- **F30** — `orbit-journeys.ts` exports `triggerJourney` and nothing else; no
  advance step exists.
- **F41** — *superseded 2026-09-18.* Was still six English regexes at that
  re-verification; closed since, see the AI-platform block above.
- **F43** — no regional rail: Telr, PayFort, PayTabs, Network International,
  mada and STC Pay have zero hits.
- **F49** — `north-snapshotter.ts:107-120` still sums `axis_policies` for GWP
  and commission and never reads the ledger.
- **F50** — closed except the forecast endpoint: 8/8 screens, 6 bespoke + 8
  CRUD routes, drivers written by `north-snapshotter.ts`'s `SLICED` map.
- **F52** — `VEC_MARKET` is written at `resources.ts:608` and read nowhere.

F48 changed shape rather than closing: the naive, seasonal-unaware threshold is
now a recorded decision (ADR-0024, `north-snapshotter.ts:522-523`), so the
finding is a known limitation rather than a defect.

### New findings — UI inventory audit, 2026-08-20

*Settings.* The MFA-disable link points at `/settings?mfa=off`
(`settings.tsx:1563`), but that URL carries no `:tab` segment; the loader
defaults an unmatched tab to `"account"` (`settings.tsx:983`), so the link
never reaches the security tab where the `mfa=off` query param is read. The
disable flow is unreachable from its own entry point (**F53**).

*AXIS.* `axis-dev.tsx` prints the model name and confidence score as plain
text (`:171`, `l("confidence")`/`l("model")`) with no ✦ marker and no
inspectable "why", contradicting the ambient-AI grammar (CLAUDE.md §11)
(**F54**). `policy-endorse.tsx`'s loader hard-codes `may.endorse: true`
whenever the policy read succeeds or 404s (`:206,209`) and only flips it false
on a *read* 403 (`:212`) — an actor who can read a policy but lacks
`axis:policies:endorse` still sees the endorse action enabled, and only
discovers the real gate when the endorse POST itself 403s; `policy-cancel.tsx`
follows the identical pattern (**F55**).

*Distribution.* `quote-compare.tsx`'s `select` and `offer/decide` actions
(`:411-427`) — accepting a quote response, accepting or dismissing a
next-best-offer — POST with no idempotency key at all, unlike every other
consequential write in the module (**F56**). `customer-360.tsx` generates one
`idempotencyKey` per page load (`:364`) and threads that same value into the
hidden field of every offer row's accept/dismiss form (`:812,997,1007`); two
different offer decisions made in the same page load carry the identical key
(**F57**).

*SCOUT.* The Settings link on the SCOUT workspace is gated on
`scout:whitespaces:write` (`apps/web/app/modules/scout.ts:163`), a permission
that does not exist in the RBAC vocabulary — only `:read` and `:promote` are
defined (`packages/core/src/rbac.ts:190`) — so the link is dead for every role
(**F58**).

*Compliance.* `core:audit:export` is a defined permission
(`packages/core/src/rbac.ts:70,330`) with no UI surface anywhere in
`apps/web/app` — nothing renders an export control gated on it (**F59**).
`pendingApprovals` defaults to the newest 100 pending rows ordered by
`requestedAt desc` (`packages/core/src/approvals.ts:526-540`), and the inbox
route calls it with no limit override (`apps/api/src/routes/me.ts:208`); once
a tenant holds more than 100 pending approvals, the longest-waiting ones fall
off the inbox with no pagination to reach them (**F60**). The portal DSAR
endpoint emits `compliance.dsar-requests.created` (`portal.ts:935-940`) and
nothing in the tree subscribes to it — a data subject who files a request
through the public portal gets no acknowledgement (**F61**).

*NORTH.* `north-snapshotter.ts` queries `schema.scoutWhitespaces`,
`schema.signalSpend` and `schema.signalAttributionEvents` directly
(`:138-140,503-507,522-549`) instead of consuming SCOUT's and SIGNAL's
domain events off `lyra-events`, violating CLAUDE.md rule 6 ("Events over
calls... Direct cross-module imports are forbidden except from
packages/core") — NORTH's snapshot silently drifts if either module's schema
changes shape (**F62**). Two `NorthShell` screens link to routes that are not
registered: `north-admin.tsx:584` links to `/north/alerts`, and
`north-brief.tsx:520` links to `/north/metrics?q=...`; `apps/web/app/routes.ts:154-162`
registers only `north/brief`, `north/explorer`, `north/anomalies`,
`north/whatif`, `north/board`, `north/board/:id/file`, `north/decisions`,
`north/admin` and `north/dev` — neither `alerts` nor `metrics` is a route, so
both links 404 (**F63**). *Closed 2026-08-23.* `/north/alerts` shipped as a
bespoke screen (routes.ts, north-alerts.tsx) and joined NorthShell's own rail
beside anomalies; the north-admin link panel now points at a real screen. The
`/north/metrics?q=...` link was removed with the explorer covering the same
ground. F62 remains open: the snapshotter still reads SIGNAL/SCOUT tables
directly, though the new signal-outreach and scout-validate engines emit
(`signal.acquisition.closed`, `scout.whitespace.validated`) on the bus, giving
the event-driven rewrite its consumers' vocabulary.

*Ledger.* `ledger-journal.tsx` and `ledger-year-end.tsx` import only
`Problem`, never `Gate` — the component that renders an approval-gated 403 as
a calm "queued, see /approvals" notice. Both MANUAL-JRNL and YEAR-END-CLOSE
run with dual control always on (`apps/api/src/ledger-journals.test.ts:133,223`),
so the normal first submission on either screen is guaranteed to 403 with
`approval_required`, and the actor sees a raw policy-key string
(`ledger.manual_journal` / `ledger.year_end_close`) in a danger alert instead
of the queued-for-approval state every other gated screen shows (**F64**).
The money-map Sankey's node labels (`ledger-money-map.tsx:452`) are drawn as
`<text>` at a fixed `node.x + NODE_WIDTH + 8` offset with no width
measurement or truncation in `layoutMap()` (`:123-153`); a longer label —
Arabic translations of the same node names routinely run longer than their
English source — clips into the neighbouring column with nothing to catch
it. The same `<svg>` carries `role="img"` with one `aria-label` covering the
whole diagram (`:437`), so the six node names and amounts rendered as `<text>`
are invisible to a screen reader (**F65**).

---

### New finding — CX judge locale parity, 2026-08-27

*ORBIT / model-gateway.* The live CX judge marks an ungrounded detail down in
English and lets the identical detail through in Arabic. Deploy run
33032591942 scored `rubric.ar = 5.000`, `rubric.en = 4.750`, failing
`parityGap.ar-en = 0.250 (need <= 0.2)`. The whole gap is one case: five judge
samples out of five returned `accuracy: 4` for `en-quote-confirm`, each citing
the same reason — the reply said the AED 1,000 excess applied "on each claim"
where the conversation gave only "excess AED 1,000". Under ADR-0074's
`min(mean, accuracy)` cap that is a 4.0. `ar-quote-confirm` adds the same
detail in the same position (`عن كل مطالبة`) against the same context and
scored 5.000.

The direction matters and is the opposite of what the parity metric was built
to catch. This is not Arabic being marked harshly; it is Arabic
*under-detecting*. An unsupported policy term slipping past the rubric in one
language is precisely the customer-facing failure the CX gate exists to stop,
and the same `parseCxScore`/`cxJudgePrompt` path serves ORBIT's production QA
sweep (`apps/api/src/engines/orbit-qa.ts:81`), so the blind spot is not
confined to the eval — Arabic replies on the QA wall are being scored by a
judge that is measurably less sensitive to fabrication than the English one
(**F66**).

The two fixtures were corrected in the same commit as this entry (they asserted
`expectPass: true` over an invented per-claim term, which a golden set should
never do), so the gate no longer fails on them. That unblocks the deploy; it
does not address F66. Fixing the judge means a prompt change under docs/13 §3.4
— a frozen judge version, so `cx-rubric-v3` and its own ADR, with the parity
evidence above as the context. Until then the gate cannot see this class of
defect in Arabic, and `parityGap` will only catch it when English happens to
catch what Arabic misses.

**Root cause, and why no fixture can currently show it, 2026-08-27.** The
accuracy instruction is an enumeration, not a rule: `cx-judge.ts:85-87` says *"A
number, date or decision the conversation does not support is a 1"*. `"on each
claim"` is none of the three — it is a scope qualifier on a figure the
conversation *did* give. English scored it 4 anyway, reading past the letter of
the list; Arabic followed the list exactly. So the parity gap is not two judges
of differing skill, it is one under-specified instruction that one language
happened to over-perform. `cx-rubric-v3` should widen the clause to cover any
detail the conversation does not support — scope, condition, exclusion, term —
rather than add a fourth noun to the list.

A probe pair for this class was written and then pulled back out rather than
committed, which is the part worth recording. The only `expectPass: false` cases
in `live-cx-quality` invent a **figure** — the case both languages catch — so
nothing in the golden set exercises the qualifier class, and the register's claim
that Arabic under-detects rests on the one production observation above and not
on a repeatable measurement. But `worstReject` gates the deploy (`live.ts:277`,
`rejectMax: 3.5`), and `eval-live` runs on push to `main` and has taken a deploy
down before (run 32289549099). Adding a case that is *expected* to fail into a
deploy-blocking gate turns a measurement into a release blocker. The probe needs
somewhere to run that is not the gate — an unthresholded diagnostic task, or a
third state beside `expectPass` that `live.ts:255-258` reports without failing —
and that choice belongs in the `cx-rubric-v3` ADR, alongside the prompt change it
is meant to verify. Until one exists, this finding stays a single observation.

**F66 closed by ADR-0077, 2026-08-27.** Both halves shipped. The accuracy clause
is now a rule with the nouns demoted to examples — *"any detail the conversation
does not support is a 1 — a number, a date, a decision, and equally a scope,
condition, exclusion, deadline or term attached to one that it does support"* —
and the judge bumped to `cx-rubric-v3`, so stored `orbit_qa_scores` rows keep the
version they were scored under.

The place to measure turned out to need no new concept. `metricOk`
(`harness.ts:37`) already fails only against a bound, and `metric()` defaults an
absent one to `±Infinity`, so an unbounded metric is reported and cannot gate. A
sample flagged `diagnostic: true` is held out of all four aggregates —
`perLocale`, `parityGap`, `worstReject`, `scoredRate` — and reported as a max
under that name. A separate flag and not a third value of `expectPass`, because
`!expectPass` on a tri-state files the probe as a reject, feeding it into the one
gate it exists to avoid. The `en`/`ar` qualifier pair now runs there: excess given
correctly, "on each claim" invented. A unit test asserts every gated aggregate is
identical with and without a 4.9 diagnostic present — the score that would blow
`rejectMax` if the hold-out ever regressed.

### New finding — on-prem image generation, 2026-08-27

*Model gateway / on-prem.* Text generation has two homes and images have one.
`resolveModel` (`packages/model-gateway/src/models.ts:79`) branches on
`opts.onPrem` and pins every tier to `ONPREM_ROUTES`, and it enforces that pin
over a tenant override — `models.ts:87` re-routes any non-`openai-compat`
model back to internal, with the comment naming why ("an on-prem tenant with a
cloud override is a data-residency breach"). `generateImage` has no equivalent:
it reads `IMAGE_CATALOGUE[IMAGE_MODEL.cloud]` unconditionally
(`packages/model-gateway/src/gateway.ts:352`), and `IMAGE_MODEL` is
`{ cloud: "flux-schnell" }` (`models.ts:66`) — a one-key map where its text
sibling `EMBED_MODEL` (`models.ts:49`) has both `cloud` and `onprem`. So the
residency guarantee that text gets by construction, images do not get at all.

~~This is currently latent rather than live~~ — **struck 2026-08-27, it was
live.** The draft rested on "nothing calls it", from a grep that never left
`packages/model-gateway`:

1. ~~**Nothing calls it.**~~ `apps/api/src/engines/signal-creative.ts:289` calls
   it from `generateCreativeImage`, routed at `apps/api/src/routes/signal.ts:195`
   as `POST /v1/signal/creatives/image`. The route checks
   `signal:creatives:generate` and nothing about residency, so an on-prem
   tenant's image brief did reach Cloudflare. SIGNAL did not need to "grow a
   caller"; it had one.
2. **It is a marked simplification, not an oversight.** `gateway.ts:348` read
   `// ponytail: Workers AI cloud only, no on-prem image model yet.` — the
   ceiling was named where the shortcut was taken. Which is the lesson worth
   more than the fix: a named ceiling is a promise to check the callers before
   one arrives, and no one did. The comment made the gap legible and let it
   read as accounted for.

The failure mode was silent by construction: an on-prem tenant's campaign
prompt left the building, and the only thing that would have stopped it is a
branch that exists for text and not for images.

Two further observations from the same read, both corrections to assumptions
worth recording so they are not re-derived:

- **The on-prem stack is not missing.** `ops/docker-compose.yml` serves Ollama
  (`:132`), vLLM behind a `gpu` profile (`:139-146`) and TEI embeddings
  (`:161-163`), every image and model env-var pinned, weights persisted in a
  `models:` volume. CLAUDE.md's repository layout said `infra/onprem/`, which
  does not exist — ADR-0010 moved it to `ops/` deliberately, and three handover
  docs had been carrying the correction for it. Reading that layout is what
  produced this finding's first, wrong draft ("there is no on-prem deployment"),
  so the layout block and `docs/11-deployment-onprem.md:7` were fixed at source
  rather than annotated again. Updating a text model on-prem is therefore an existing
  operational job (change `VLLM_MODEL`, restart), not missing capability: the
  `internal-chat` catalogue key is a slug, so whatever the server loads under
  it is what runs, with no code change at all.
- **An image eval exists but does not measure images.**
  `evals/creative-image/` is scored by `scoreInjection` (`evals/run.ts:977`)
  and its cases are jailbreak prompts asserting `expectHit: true`. That guards
  prompt-injection screening on the image path, which is worth having and is
  not the same thing as measuring whether a newer image model is better. So
  the eval-first discipline that governs a text model swap (CLAUDE.md §4) has
  no equivalent for a visual one — there is no golden set a candidate image
  model could be scored against.

**Correction, 2026-08-27 — SIGNAL already has that caller, so this was live and
not latent.** This finding said "nothing outside the gateway calls
`generateImage`". `apps/api/src/engines/signal-creative.ts:289` calls it from
`generateCreativeImage`, routed at `apps/api/src/routes/signal.ts:195` as
`POST /v1/signal/creatives/image` — permission-gated, not residency-gated. An
on-prem tenant could therefore send an image brief to Workers AI over the one
path that did not check `ctx.policy.dataResidency`. The same reading mistake as
the layout block above: a claim about what calls a function, made without
grepping outside the package that defines it.

Closed by **ADR-0075**: on-prem deployments have no image generation and say
so — `generateImage` refuses before the provider call, pinned by the third
on-prem sibling test beside `complete()`'s and `embed()`'s. Adding
`internal-image` to `IMAGE_CATALOGUE` and an `onprem` key to `IMAGE_MODEL`
stays small and stays available; what is not decided is *which* on-prem image
server (docs/02 §9) and what visual-quality threshold would gate it
(docs/13 §3.4). Refusing now is what keeps both from being guessed at under
deadline (**F67**).

**F67 closed, 2026-08-27 — ADR-0076 decides the second half.** The visual-quality
threshold this finding asked for is not going to be a number, and the ADR says why
rather than leaving it open a second time. Every scorer in `evals/run.ts` compares
model output that is *text* to an expected value, including the one that looks like
a counter-example: `scoreAxisVision` (`run.ts:186`) sends an image and scores the
**extraction** against `c.expected`. A generated image has no expected value — two
`flux-schnell` runs on one brief differ and both may be fine — so the only absolute
gate available is a model judging taste, which docs/13 §3.4 would require frozen
and which F66 is the standing evidence against buying untested.

So the gate is the properties a wrong image actually breaks: injection screening
(already `evals/creative-image/`), residency (ADR-0075), and the approval step,
which is stronger than a rubric because a person is accountable for the send. The
ADR names the trigger that makes a measured gate worth its cost — **a second image
model becoming a candidate**, at which point a comparative A/B on a fixed brief set
is both meaningful and cheap. Adding an `onprem` or second cloud key to
`IMAGE_MODEL` (`models.ts:66`) fires that trigger by construction.

### NORTH F48 / F49 / F50 — closed, and what stayed open, 2026-09-19

*F48 — closed.* The anomaly baseline was `existing?.value`, the previous *write*
of the same period (`north-snapshotter.ts`). Day grain therefore never fired at
all — a day is written once per nightly run — and month grain fired a false
critical on the first night of every month, when a fresh month-to-date collapses
against a full prior month. Three changes: `Period.closed`, so an open period is
written and displayed but is never an anomaly subject and never a baseline;
`periodsFor` keys the month off *yesterday*, so the month that just ended gets
exactly one closed write measured over its real window (before this, no month
was ever snapshotted whole, so nothing could detect against one); and the
baseline — headline and each dimensional slice — is read from
`previousPeriod(grain, period)` in `packages/core/src/north-period.ts`, the
module `narrator.ts` now shares, which had been doing the comparison correctly
all along thirty metres away. ADR-0024's naive threshold is untouched: it was
never the bug, and changing it here would have muddied the regression test.
Spec §F.3's three named baselines and §F.7's history backfill are **not** built
— `prior_period` is the floor the spec itself calls B1, and
`seasonal_robust_z` needs history a fresh tenant does not have.

*F49 — partly closed (ADR-0078).* `net_commission` is now the sum of `netMinor`
over `commissionByDimension`, with its channel decomposition from the same call,
so a clawback nets out by construction and the figure traces to the trial
balance. `expense_ratio`'s numerator moved to `expenseMovementMinor`; there is
now no SQL against `ledger_journal_lines` outside `packages/ledger`. That work
found a second defect worth its own line: `commissionByDimension`'s account
predicate was unbracketed, and `AND` binds tighter than `OR`, so **every 4xxx
line the tenant had ever posted was counted in every period's commission
report** — the window only ever constrained the 2100 side.

Still open, and deliberately: `gwp` stays operational, because for a broker
premium is not revenue — it enters client money and leaves again, and no
account's balance is GWP. What is missing is the *reconciliation*: spec §E.3's
`north_tieouts` row per money metric per period, and §E.2's board-safety filter,
which is the enforcement point that keeps an unreconciled figure out of a board
pack and out of the model's context. Both want a schema change. Until they
exist, a board pack can still print a GWP nobody has tied to anything.

*F50 — closed.* `GET /v1/north/forecast` (`north:forecasts:read`, a new
permission: a forward-looking number is a materially different disclosure from a
recorded one, so `north:snapshots:read` does not imply it). It reads closed
snapshots only — projecting from a month-to-date as though it were a month is
F48's bug in another hat — and hands them to
`packages/core/src/north-forecast.ts`: damped Holt on the deseasonalised series,
fitted by a 405-combination grid search on a holdout, answering p10/p50/p90 per
period with the fitted α, β, φ and the seasonal index per phase. No model is in
that path. `/north/explorer` reads it, because an endpoint nothing reads is the
defect this register keeps recording.

Two deliberate departures from spec §H, both written at the call site: the
seasonal step needs two full cycles rather than 12 months / 56 days before the
engine will answer at all, and the seasonal indices are ratio-to-moving-average
rather than §H.2's `median{y : phase = i} / median{y}` — that form cannot tell a
season from a trend, and on two years of a rising series it returns the trend,
applied twice. Not built: §H.3's driver projection, §H.4's immutable versioned
runs and nightly re-run, §H.5's variance report and coverage self-check. The
endpoint is the read half; a stored run is a table and its own change.

---

### F51/F52 revisited — SCOUT ingestion, clustering, bench and watch, 2026-09-19

F51 named four absences and F52 one dead seam. Four of the five close here; the
fifth is recorded as proposed in **ADR-0078** rather than built, because it is
the one that needs a third-party service.

*Closed.*

- **Signal ingestion.** The seam is `SignalSource`
  (`packages/core/src/seams.ts`), beside `Channel` and `IdentityVerifier` where
  docs/02 §11 says extension seams live. The Harvester is
  `apps/api/src/engines/scout-ingest.ts`: three adapters, all `external: false`
  — `internal.quotes`, `internal.abandonment` and `internal.feed`, the last
  being what an integrator posts to `POST /v1/scout/signals/harvest`. Idempotent
  on (source, sourceRef), so a schedule needs no lock, and every new row is
  embedded through the same `embedUpsert` the CRUD ingest path uses.
  `GET /v1/scout/sources` is the registry; `/scout/admin` renders it.
- **Live clustering.** `apps/api/src/engines/scout-cluster.ts` clusters the
  *persisted* corpus — `sweepWhitespace` only ever clustered quote demand — and
  stamps `scout_signals.cluster_id`, a documented column nothing outside the
  seed had written. It also fills `trail_json`, which the Radar's sparkline
  needs and nothing was writing. `POST /v1/scout/clusters/sweep`,
  `scout:clusters:build`.
- **Bench Builder.** `apps/api/src/engines/scout-bench.ts` with the arithmetic
  in `packages/core/src/bench.ts`: a provider's median premium indexed to the
  panel median in basis points, win rate off `selectedAt`, and the requests the
  panel answered that this provider did not. `scout_panel_bench` held seed rows
  only, so the panel screen, the negotiation-pack PDF and the provider-facing
  k-anonymity gate were all standing on a fixture. Idempotent per
  (provider, line, period); emits `scout.bench.updated` (module doc §6).
  `POST /v1/scout/panel-bench/sweep`, `scout:panel_bench:build`, reachable from
  `/scout/panel`.
- **Competitor and regulatory watch.** `apps/api/src/engines/scout-watch.ts`
  over `packages/core/src/watch.ts`: each watched subject's window scored
  against the window before it, severity from newness, regulation and growth.
  Deliberately a derivation and not a write — a persisted finding would have to
  decide when last night's finding is tonight's, and a window comparison cannot
  answer that. `GET /v1/scout/watch`, rendered on `/scout/admin`.
- **F52.** `VEC_MARKET` now has the reader it was written for. The Clusterer
  asks the index, once per known theme, which of this tenant's vectors sit near
  it, and places a signal into that cluster above `SIMILARITY_FLOOR` — the one
  question an embedding answers that `GROUP BY source` cannot. Two readers
  existed already (`POST /v1/scout/signals/similar`, the command loop's recall);
  what was missing was the one inside clustering. A deployment with no
  Vectorize binding still clusters, by source.

*ADR'd instead of built.*

- **External sources** — search-trend connectors, app/review scraping,
  news/regulatory RSS, competitor page monitors. Each is a third party and none
  is on docs/02 §9's list. **ADR-0078** proposes them one at a time, each with
  its vendor, legal basis, crawl politeness and credential home named, and
  records that the seam is the insertion point: an adapter file plus one line in
  `sourcesFor`, with no engine, route, table or screen change.

*Found on the way.* `/scout/admin` was rendering `l(`source.${one.source}`)`
against a catalogue that holds `adm.source.*`, so all six rows of the signal-
source panel printed raw i18n keys. Sighting 10's shape in a second catalogue.
The guard is `apps/web/app/routes/scout.labels.test.ts`, which selects its
subjects from the import graph rather than a list and checks static keys, the
literal prefix of a built key, and any key-shaped literal in a namespace this
catalogue owns.

## P2 — depth, not absence

Commission is flat-rate only — no ladders, tiers, volume bonuses or overrides
(`core/src/commission.ts:84-108`); clawback posts but nothing computes what is
clawable; no producer statements (`settlement.ts:39` serves partner, creator
and publisher, and explicitly refuses `insurer` at `:99-106`) — the remittance
advice at `:658-702` is good and simply pointed at the wrong kind. Period-close
checks are three deterministic tests with no subledger tie-out, no
recon-complete and no suspense check. Revenue schedules exist as data with
nothing driving them and no cap at invoiced. No bordereaux, inbound or outbound
— zero hits in code *or* docs. Chart of accounts is a hard-coded TypeScript
constant, so a tenant cannot add an account without a deploy. No budget vs
actual, no cash-flow statement, no fixed assets or operating-expense accounts.
Dead code in the money path: `closeRun` (`recon.ts:382-390`) has no callers,
`CREATOR-SPEND` (`recipes.ts:398`) has no matching `TXN_TYPES` entry and is
unreachable. `cx-judge.ts` is well-built and called by nothing. `K_FLOOR` is
hardcoded (`scout.shared.ts:40`). Only 2 of 6 SCOUT tables export
(`engines/report.ts:237,251`). No multimodal path (`extract.ts:7-9`). No AE-only
rulepack review, no Egypt/FRA pack. `packages/agents/` and `apps/agents/` do
not exist despite the CLAUDE.md target layout and `docs/02:59` — the runtime is
`api/src/engines/`. `docs/01-brand.md:83` names the light-mode AXIS hue
`#A2660B`; `tokens.css` ships `#b45309` at both definition sites
(`:523,618`) — only the dark-mode values are guarded by a test, so the light
row can drift from its own doc unnoticed.

**Thin screens.** *Re-read at source 2026-09-18/19; all seven claims are now
closed in code and the paragraph never caught up in between. Kept, not
deleted, per the convention above — and a standing warning that a finding
written as prose rather than as a failing test rots the moment someone fixes
it.*

- *Closed.* `ledger-open-txn.tsx` no longer asks for raw JSON. `GET /txn-types`
  publishes each recipe's arguments as a flat field list (`ArgField`,
  `ledger.shared.ts:113`, mirroring `recipes.ts`), the form renders money in a
  money field, and the action reads back exactly the arguments the type declared
  (`:91-93`).
- *Closed.* `ledger-recon.tsx` **can** import a file: `statementFromCsv`
  (`ledger.shared.ts:191`) parses a pasted statement, previewed at `:819` and
  posted at `:221`. It can also close a run and write off a variance — see
  below.
- *Closed.* `ledger-reports.tsx`, `ledger-account.tsx` and `ledger-money-map.tsx`
  all download through the shared `ReportDownloads` component: the original six
  reports plus the two added for this pass, `account-statement` and
  `value-flow`, both now in `REPORT_EXPORTS`.
- *Closed.* `axis-board.tsx` has per-card transitions through
  `POST /v1/axis/cases/:id/transition` (`:435`, `:601`) — the same state machine
  and approval gate the case detail screen uses — and sorts by `byUrgency`,
  which is value × risk × SLA with weights, not lateness (`:249-261`).
- *Closed.* `north-brief.tsx` follows its anomaly: it assigns an owner
  (`intent=own-anomaly`, `:313`) and links out to the anomaly itself (`:495`).

*Closed, 2026-09-19.* **Close a run**: `closeRun` had no callers at all (it was
named under "dead code in the money path" above); `POST
/v1/ledger/recon/runs/:id/close` is the caller. The sharper find: `closeRun`
counts `proposed` *and* `unmatched` as open, but the decide control only
covered `proposed`, so a run with one straggler could never reach
nothing-left-open by any path a reader had — fixed in the same commit.
**Write off a variance**: `RECON-WRITEOFF` (`packages/ledger/src/recipes.ts`,
account `5510`), dual control always, refusing client money and equity — see
docs/19 §4.6. Two live defects fell out of building it: `argFields` silently
dropped every **required** recipe argument its two dumb probes (`1`,
`"sample text"`) couldn't describe — an enum, a pattern-constrained string, and
predating this work, `YEAR-END-CLOSE`'s `fiscalYear`, a bounded integer that
refuses the probe value `1` — so those types could never be posted from the
generic open-transaction screen at all.

**Act in bulk** stays open by decision, not by omission: an ADR (filed
independently by two agents working this register in parallel — see the
renumbering note under "Suggested order") records the constraints a bulk
decide must satisfy and leaves the product question (may a reviewer *confirm*
in bulk, or only reject?) to the owner.

- `axis-doc-intel.tsx` still requires caller-supplied `rawText` ("OCR is out of
  scope", `routes/axis.ts:73-78`).

### New finding — saved views are written, listed, and never applied, 2026-09-18

Found by asking what the API sends that nothing reads, which is how dead seam 15
was found. `analytics_saved_views` stores a `route`, a `queryJson`, a
`columnsJson` and an `isDefault` per row, and the API is built to serve exactly
one question with them: `GET /v1/analytics/saved-views` takes a **`?route=`
filter** (`routes/analytics.ts:658`) and orders **`isDefault` first**
(`:662`) — the shape a list screen needs to ask "what views exist for this
screen, preferred one first".

No screen asks. `module.tsx` is the one file that renders every resource-tab
list — filters, columns, sort, pagination — and it contains no reference to
saved views, `route=` or `isDefault`. The web's only reader is the generic
`/analytics/saved-views` tab (`modules/analytics.ts:440`), which lists the rows
as records: a reader can see that a saved view exists and can never apply one.

The seed makes the gap concrete rather than theoretical. Six views are seeded
(`packages/core/src/seed/analytics.ts:998-1067`), every one of them naming a
real resource tab — `/axis/cases`, `/ledger/txns`,
`/distribution/quote-requests`, `/orbit/renewals`, `/analytics/exports`,
`/analytics/report-runs` — and three carry `isDefault: true`, including the
finance controller's private "My reconciliation queue". A default that is never
applied is a promise in the data model that the UI does not keep.

Two notes for whoever picks this up. The `?route=` value is a *resource tab*
path (`/ledger/txns`, the generated list) and not a bespoke screen path
(`/ledger/transactions`, `ledger-open-txn.tsx`) — the two differ by one segment
and read alike, which is the kind of near-collision nothing currently compares
against the route tree. And `columnsJson` implies per-user column selection,
which `module.tsx` does not have at all; applying `queryJson` alone is the
smaller, coherent first step. A finding, not a backlog: it needs a spec update
before any screen changes.

---

## What is genuinely strong

Worth protecting under any refactor, because these are the parts a buyer's
technical reviewer will test:

- **AI boundary discipline in the money path.** Recon pass 3 is opt-in
  (`routes/ledger.ts:586-616`, "no silent AI in the money path"); AI matches
  never auto-confirm (`recon.ts:145-294`, `AI_CONFIRM_FLOOR = 60`); the
  `MatchProposer` is injected so `packages/ledger` carries no model-gateway
  dependency and *cannot* call a model by accident.
- **Runtime dual control.** `approvals.ts:301-302` rejects an approver equal to
  the initiator; the gate fails closed on unstated amounts (`:164-170`);
  `txn.ts:263-265` refuses to honour an `auto_approve` entry for a payout or
  client-money type.
- **Client-money segregation.** `posting.ts:319-351` asserts `1010 ≥ 2010` and
  persists a check row on every post, throwing on shortfall.
- **Single write path.** `routes/ledger.ts:49-52` — no endpoint writes a journal
  line directly, and the type/recipe mapping is enforced bidirectionally
  (`txn.ts:249-254`). No counterexample found.
- **Settlement staleness guard.** `settlement.ts:426-434` refuses to approve a
  settlement whose totals moved since drafting.
- **Server-side tool re-validation.** `executeOrbitToolCalls`
  (`orbit-tools.ts:189-239`) re-checks every model-requested call against the
  allow-list and converts `approval_required` into a tool result.
- **Gateway order of operations** — scrub before hash, kill before budget, audit
  on every terminal state, hashes only — and `verifyNumericClaims` /
  `verifyGroundedness` shared verbatim between production and evals
  (`core/src/narrator-verify.ts:91,107`).
- **RTL is real.** Zero physical-direction CSS across `apps/web/app/**` and
  `packages/ui/src/**`; `dirFor()`/`langFor()` (`i18n.ts:59-80`); a bilingual
  `KIT_TEXT` in the kit itself; Hijri as a first-class `CalendarPreference` with
  a golden test (`ui.test.ts:359`).
- **k-anonymity suppression** (`core/src/k-anonymity.ts:17-19`), evidence
  bundles with manifest + sha256 + R2 (`routes/ledger.ts:706-833`,
  `routes/compliance.ts:204-310`), PII sealing with audited reveal
  (`routes/axis.ts:174`), and `EvidenceLink` + `AgentBadge why=` on every AI
  surface checked.

---

### AXIS P1 re-verification, 2026-09-18

Every AXIS P1 (F23-F28) re-read at source rather than taken from the 2026-08-12
block above. All six are now closed. Four were already closed by earlier work
and needed only confirming; the other two had *residue* of one shape, and it is
the shape worth recording: in each case the expensive half had been built and
its answer routed nowhere.

*Confirmed closed, no change needed.*

- **F26** — `engines/axis-policy-document.ts` generates the schedule and
  `axis-zero-touch.test.ts:221-229` now asserts it is attached to the version it
  describes. The analytics-PDF substitute the finding named is gone.
- **F28** — all eight surfaces exist and are registered:
  `fnol-intake.tsx`, `claims-desk.tsx`, `policy-endorse.tsx`,
  `policy-cancel.tsx`, `renewal-desk.tsx`, `referral-desk.tsx`, and complaints
  and SIU as declarative tabs on the AXIS workspace. `spec.routes.test.ts` and
  `routing.reachable.test.ts` both hold.

*Closed this round.*

- **F23** — the state machine, the reserve history and the `CLAIM-PAY` recipe
  had all shipped; the join between them had not. `transitionClaim` refuses
  `settling` and `settled` by hand and says why in a comment — "move a claim to
  settling by requesting a payment" — and `requestClaimPayment` then never
  touched `status`, so **both states were unreachable by any path** and no claim
  in any deployed tenant could ever be settled. `settledMinor` was the same
  defect in a column: three readers (the reserve advisor's comparables, the
  fraud scorer's history, customer-360's position lines) and no writer after
  FNOL, so all three reasoned from a permanent null and two fed it to a model as
  fact. `settlementTarget` (`engines/axis-claims.ts`) walks the machine rather
  than around it, and freezes `settledMinor` at the total paid.
- **F24** — the check was real and its answer was read by nothing.
  `checkCoverage` resolves cover before the claim exists and snapshots version,
  limits, excess and warnings; `coverageState` then had no consumer outside its
  own engine, so a claim recorded as out of cover, lapsed at the loss or
  cancelled at the loss was paid like any other. Refused now at the payment
  door — not at FNOL, because a notification of loss is always taken. Ex gratia
  passes under its own gate; `unknown` passes, because refusing on it would turn
  "we could not tell" into "no".
- **F25** — the tax/fee split is whole and was already whole: `rating.ts:169`
  computes `taxMinor` from `taxPpm`, the quoter carries it, bind writes
  premium/tax/fees/gross to the policy and the version, the schedule prints it.
  Nothing asserted it survived the chain, so `axis-bind.test.ts` now walks every
  step. The column comment was the real defect: `paymentPlanJson` read
  `// H9 reserved` while `sweepPolicyLifecycle` had been lapsing policies off it
  for months. What docs/16 H9 reserves is premium *financing*, not this column.
- **F27** — `POLICY_TRANSITIONS` and `CLAIM_TRANSITIONS` were enforced by the
  dedicated engines and by nothing on generic CRUD, leaving a second writable
  path around the same contract: a reported claim could be PATCHed straight to
  `settled`, a cancelled policy revived. The AXIS workspace's own `editable`
  spec offered exactly that. Guarded now in `resources.ts` with the `beforeWrite`
  shape `complaints` and `siu-referrals` already use, importing the maps from
  `@lyra/core` so the two doors cannot drift.

The general shape, which is worth more than the four fixes: **F23, F24 and F27
are all one defect seen from three sides — a contract that is declared,
computed, or enforced on one path, and consulted on none.** The tell is not a
screen misbehaving; it is a grep for a column's or a map's readers coming back
with only its own writer. Asking that question of `settledMinor` and
`coverageState` found both in minutes, where reading the screens had found
neither in a month.

---

## ORBIT P1 re-verification, 2026-09-18

Read of the ORBIT P1 block (F29–F32) as the code now stands, and what closing
them took.

- **F29 — closed, and was already closed before this round.**
  `apps/api/src/engines/orbit-routing.ts` is the routing and queueing engine:
  `pickRoute` and `pickAssignee` pure and table-tested, `routeConversation`
  stamping the team, the assignee and both SLA clocks, `sweepRouting`
  escalating an FRT breach and reassigning an absent agent's queue.
  `orbit_conversations.teamId` is read by all four. The hardcoded `SLOW_MS`
  badge threshold is gone; `PRESENCE_STALE_MS` and `orbit_sla_policies` are
  what the timers read now. Nothing further was needed.
- **F30 — closed.** `triggerJourney` wrote a run at `startNode()` and nothing
  moved it, and nothing called `triggerJourney` either: a published journey
  could not enrol anybody. `advanceJourneyRuns` (`orbit-journeys.ts`) executes
  all four node types — `wait` parks on `nextAt`, `send` writes a transcript
  turn and emits `orbit.journey.sent`, `branch` picks a `when`-labelled edge off
  an allowlisted customer attribute or the run context, `task` raises a
  conversation through `routeConversation` and waits for a human to close it.
  Consent is re-checked at every send and quiet hours defer rather than drop.
  The trigger half is `onJourneyEvent`, called from the outbox drain for every
  event and matched against each journey's own `trigger` node (CLAUDE.md rule
  6). Cron tick plus `POST /v1/orbit/journeys/sweep` and
  `POST /v1/orbit/journeys/:id/trigger`.
- **F31 — closed.** `ORBIT_TOOL_DEFS` now carries the eight tools
  docs/modules/orbit.md §2.1 names. The five added: `send_document` (both
  directions, one tool, because the doc registers one — a `collect` leaves an
  `axis_tasks` chase row), `make_renewal_offer` (refuses a decided renewal),
  `fnol_guidance` (writes nothing, reads its questions off `FnolBody` so the
  script cannot drift from the intake contract), `book_callback` and
  `human_handover` (both queue through `routeConversation`). The two that reach
  a customer or a price gate before they write, under two new approval policies
  `orbit.document_send` and `orbit.renewal_offer`.
- **F32 — closed.** `orbit-kb.ts` is the article manager, the macro sender and
  the deflection loop, with `orbit_kb_articles`, `orbit_macros` and
  `orbit_deflections` behind them and three workspace tabs over those.
  Retrieval is VEC_KB when the index is bound and a deterministic lexical score
  when it is not, and every hit and every logged deflection carries `via` so a
  retrieval-quality question is answerable. This is **VEC_KB's first reader** —
  `routes/axis.ts:344` has embedded document text into it since the binding
  existed with nothing ever querying it, which is F52's shape on the other
  index — so the query filters on a `kind` metadata field, the index holding two
  populations now. A miss is logged as loudly as a hit, because containment %
  (§7) is a ratio and a log that kept only the wins would report 100% forever.

---

## Suggested order

All thirteen P0s are closed as of 2026-08-12. F2 and F3 went together, as
predicted: opening balances need the 3xxx accounts. What remains is P1 and P2,
which are depth rather than absence.

Every item above is a finding, not an approved change. P1s that alter a
documented seam or add a third-party service need an ADR first.

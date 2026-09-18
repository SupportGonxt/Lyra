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

*Finance.* Premium accounting is cash-basis only — `1200 Premium Receivable`
appears once, as a chargeback default (`recipes.ts:296`), and `2000 Insurer
Payable` is never posted, so GWP is never a receivable (**F14**). Aging ages
journal lines by posting date against a free-text counterparty string, not open
items by due date, and there is no payables aging (`reports.ts:411-459`)
(**F15**). No cash application and no bank statement import — CAMT/MT940/OFX
absent; `ledger-recon.tsx:521` requires hand-pasted JSON (**F16**). Tax is a
caller-supplied `taxPpm` defaulting to zero (`core/src/commission.ts:45-58`)
while `docs/19` §5.3 says tax is never inferred; the `taxRules` table is unread
(**F17**). No FX revaluation of open balances (**F18**). Insurer statement
reconciliation posts nothing — `decideMatch` (`recon.ts:297-330`) updates match
state and never books the `CMSN-SETL` the spec promises (**F19**). `force: true`
on period close is accepted straight from the request body
(`routes/ledger.ts:187-195`) and `reopenPeriod` (`periods.ts:172-186`) has no
approval gate at all (**F20**). `SUCCESS-FEE` can post with no verified metric
snapshot despite `docs/19` §11.10 (**F21**). Four of the ten mandated property
obligations are untested, and the tests are seeded-LCG fuzz, not property tests
— fast-check is not a dependency (**F22**).

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
- **F41** — the guardrail floors are still six English regexes
  (`guardrails.ts:17-31`), no Arabic.
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

**Thin screens.** *Re-read at source 2026-09-18; five of the seven claims had
been closed in code and the paragraph never caught up. Kept, not deleted, per
the convention above — and a standing warning that a finding written as prose
rather than as a failing test rots the moment someone fixes it.*

- *Closed.* `ledger-open-txn.tsx` no longer asks for raw JSON. `GET /txn-types`
  publishes each recipe's arguments as a flat field list (`ArgField`,
  `ledger.shared.ts:113`, mirroring `recipes.ts`), the form renders money in a
  money field, and the action reads back exactly the arguments the type declared
  (`:91-93`).
- *Closed.* `ledger-recon.tsx` **can** import a file: `statementFromCsv`
  (`ledger.shared.ts:191`) parses a pasted statement, previewed at `:819` and
  posted at `:221`.
- *Closed.* `ledger-reports.tsx` downloads all six reports in four formats
  (`:184-186`, `:288-292`) through `GET /v1/ledger/reports/:report/export`.
- *Closed.* `axis-board.tsx` has per-card transitions through
  `POST /v1/axis/cases/:id/transition` (`:435`, `:601`) — the same state machine
  and approval gate the case detail screen uses — and sorts by `byUrgency`,
  which is value × risk × SLA with weights, not lateness (`:249-261`).
- *Closed.* `north-brief.tsx` follows its anomaly: it assigns an owner
  (`intent=own-anomaly`, `:313`) and links out to the anomaly itself (`:495`).

Still open, and all three need API work before any screen can change — none is
a frontend gap:

- `ledger-recon.tsx` cannot close a run, write off a variance, or act in bulk.
  Close is the sharper one: `closeRun` (`packages/ledger/src/recon.ts:382`)
  exists, is exported, and **has no callers anywhere in the repo** — no route
  publishes it, so there is nothing for a button to post to. Write-off has no
  engine at all. Bulk decide could in principle be built over the existing
  `POST /recon/matches/:id/decide`, one call per match, but a bulk money
  decision fanned out client-side is a transaction-integrity question
  (CLAUDE.md §12), not a UI one — it needs an ADR, not a button.
- `ledger-account.tsx` and `ledger-money-map.tsx` export no action, and unlike
  the six reports there is no endpoint for them to call: `REPORT_EXPORTS`
  (`routes/ledger.ts:456`) holds trial-balance, pnl, balance-sheet, aged,
  commission and client-money, and neither an account statement nor a money map
  is among them.
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

## Suggested order

All thirteen P0s are closed as of 2026-08-12. F2 and F3 went together, as
predicted: opening balances need the 3xxx accounts. What remains is P1 and P2,
which are depth rather than absence.

Every item above is a finding, not an approved change. P1s that alter a
documented seam or add a third-party service need an ADR first.

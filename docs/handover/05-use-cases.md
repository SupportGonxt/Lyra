# 05 — Use cases

Every business use case LYRA supports, written for someone with no prior
context: a support engineer taking a ticket, or a UAT tester working through
staging with a demo login.

The source of truth is [`docs/06-roles-and-journeys.md`](../06-roles-and-journeys.md)
(the J-XX journey catalogue) plus the module specs under
[`docs/modules/`](../modules). Every route, button label and test filename in
this document was verified against the code at the time of writing.

Describes commit `c7f1f57` on `main` (2026-08-18). Previous revision described
`a295218`/`8afd07d` (2026-08-13); [`README.md` §7](README.md#7-revision-history)
lists what changed in between, and which work is still on unmerged branches.

---

## 1. How to read this document

Each use case has a fixed shape:

| Field | Means |
| --- | --- |
| **ID** | `UC-NN` for ordering, plus the real journey ID (`J-XX`) it implements. J-IDs are the ones in docs/06 and in the `@journey:` tags in the e2e suite — never invent one. |
| **Actor** | The RBAC role key that can do this. A role that lacks the permission does not get a disabled button; it does not get the screen. |
| **Preconditions** | What must already be true. On the seeded demo tenant most of this is already there. |
| **Screens / routes** | The URL paths involved, verified against [`apps/web/app/routes.ts`](../../apps/web/app/routes.ts) and [`apps/web/app/routing.ts`](../../apps/web/app/routing.ts). |
| **Steps** | Numbered, in the order a person does them. |
| **Expected result** | What the screen says when it worked. |
| **What gets written** | Rows, audit entries, approvals, ledger postings, events. |
| **Automated coverage** | The spec file that proves it, and its tags. |

Two conventions that recur everywhere and explain most "why did nothing
happen?" tickets:

- **Approval gate.** Actions matching a dual-control or threshold policy
  (`packages/core/src/approvals.ts`) do **not** write. They return a queued
  refusal — a `role="status"` banner reading *"Waiting on an approval"* naming
  the policy (e.g. `axis.bind`), plus a link **"Open the approval queue"** to
  [`/approvals`](../../apps/web/app/routes/approvals.tsx). The original edit
  must be **re-submitted** after approval; approving does not replay it.
- **Permission gate.** No permission means the whole screen is replaced with
  *"Your roles do not include access to this area."* — not a 404 and not a
  silent empty list.

Every use case number in section 3 is a journey. Section 4 holds supporting
flows that carry no J-ID but are real, tested product surfaces support will be
asked about.

---

## 2. Roles and personas

### 2.1 Role catalogue

From [`docs/06-roles-and-journeys.md`](../06-roles-and-journeys.md) §1. Every
role maps to a permission bundle in `packages/core`; module admin ⊂ tenant
admin for that module's settings; PII requires `core:pii:view` **regardless of
role** (that is why list screens show `[redacted]` for message bodies and
customer contact details to actors who otherwise have full module access).

**Platform (goNXT staff — outside the tenant):**

| Role | Can do |
| --- | --- |
| `platform.admin` | Tenants, entitlements, billing, dead-letter queue, global flags. |
| `platform.support` | Impersonate-with-consent (logged), read diagnostics. |
| `platform.engineer` | Deploys and migrations via the CI identity, not through the UI. |

**Tenant staff:**

| Role | Can do |
| --- | --- |
| `tenant.admin` | Users and roles, brand, tenant policies, integrations, API keys, billing view. |
| `tenant.compliance` | Audit exports, consent registry, approval policies, the creative flag lane, the AI audit log, and pausing agents. |
| `axis.agent` | Work the AXIS case and exceptions queues, register claims, run the claims desk. |
| `axis.lead` | Everything `axis.agent` does, plus binding, endorsing, cancelling, surfacing offers to customers, and shopping the provider panel. |
| `axis.admin` | AXIS operating policy, SOP publish, connector health. |
| `orbit.agent` | Conversations, drafting and approving AI replies, handover notes. |
| `orbit.lead` | Conversation QA scoring and coaching. |
| `orbit.retention` | The save desk, renewals queue, proposing next-best offers. |
| `orbit.partners` | Partner accounts and the partner portal. |
| `orbit.admin` | ORBIT journeys, channels, consent settings. |
| `signal.marketer` | Author audiences, creatives and AEO pages. |
| `signal.lead` | Everything `signal.marketer` does, plus launching campaigns and reversing autopilot budget moves. |
| `signal.admin` | SIGNAL connectors, brand kit, budget ceilings. |
| `scout.pm` | Work whitespace candidates and experiments. |
| `scout.lead` | Promote whitespaces, read panel benchmarks, assemble negotiation packs. |
| `scout.admin` | SCOUT data feeds and cluster settings. |
| `north.exec` | The daily brief, anomalies, scenarios, board packs. |
| `north.analyst` | Metric definitions and stewardship. |
| `north.board` | Read-only board packs. |
| `north.admin` | NORTH connectors and metric registry admin. |
| `dev.developer` | Developer console, **test** keys, sandbox. |
| `dev.admin` | Live keys. |

**External:**

| Role | Can do |
| --- | --- |
| `customer` | Hosted pages, chat, self-serve portal. |
| `partner.developer` / `partner.manager` | The ORBIT partner portal. |
| `provider.viewer` | Insurer read access to the SCOUT data products they bought. |

**Two roles exist in the seed that docs/06 §1 does not list** — they were added
for the money-movement dual-control rule and are real in the product:

| Role | Can do |
| --- | --- |
| `finance.controller` | Ledger, reconciliation, period close, settlement runs, and deciding money-out approvals. **Two controllers are seeded on purpose** — money out is dual control, so one controller means nothing clears. |
| `finance.analyst` | Read the ledger and its reports. |

### 2.2 Demo accounts (seeded tenant)

Tenant slug **`gonxt`** (display name **GONXT**, plan `enterprise`). Password
for every account: **`Gonxt-Demo-2026!`** — defined once in
[`e2e/env.ts`](../../e2e/env.ts) and mirrored from `packages/core/src/seed.ts`.
These are demo fixtures, never live credentials.

On the login screen there is a **"Demo sign-in"** disclosure containing a
one-click button per persona; the password form works too.

| Name | Email | Role | Lands on |
| --- | --- | --- | --- |
| Amina Saleh | `amina.saleh@gonxt.ae` | `tenant.admin` | `/admin` |
| Khalid Al Rashed | `khalid.rashed@gonxt.ae` | `tenant.compliance` (locale **ar**) | `/admin` |
| Layla Hassan | `layla.hassan@gonxt.ae` | `axis.agent` | `/axis` |
| Omar Farouk | `omar.farouk@gonxt.ae` | `axis.lead` | `/axis` |
| Suhail Hamdan | `suhail.hamdan@gonxt.ae` | `axis.admin` | `/axis` |
| Sara Al Nasser | `sara.nasser@gonxt.ae` | `orbit.agent` | `/orbit` |
| Yusuf Karim | `yusuf.karim@gonxt.ae` | `orbit.retention` | `/orbit` |
| Dana Aziz | `dana.aziz@gonxt.ae` | `orbit.partners` | `/orbit` |
| Hind Saqr | `hind.saqr@gonxt.ae` | `orbit.admin` | `/orbit` |
| Noor Jamal | `noor.jamal@gonxt.ae` | `signal.lead` | `/signal` |
| Tariq Mansour | `tariq.mansour@gonxt.ae` | `scout.lead` | `/scout` |
| Hala Zayed | `hala.zayed@gonxt.ae` | `north.exec` | `/north` |
| Rana Hadid | `rana.hadid@gonxt.ae` | `north.analyst` | `/north` |
| Faisal Omar | `faisal.omar@gonxt.ae` | `finance.controller` | first allowed workspace |
| Nadia Rahman | `nadia.rahman@gonxt.ae` | `finance.controller` | first allowed workspace |
| Mona Idris | `mona.idris@gonxt.ae` | `finance.analyst` | first allowed workspace |
| Raed Samir | `raed.samir@gonxt.ae` | `dev.admin` | `/admin` |
| Yasmin Faris | `yasmin.faris@gonxt.ae` | `provider.viewer` (scoped to Falcon Insurance) | first allowed workspace |

Khalid Al Rashed's account is seeded with locale `ar`, so **his whole workspace
renders in Arabic, right-to-left**. This is deliberate — it is how RTL gets
exercised on every screen he touches, and it is why the compliance e2e spec
asserts Arabic labels. If a tester reports "the app is in Arabic", check who
they signed in as before filing a bug.

The eleven personas the automated suite drives are exported as `PERSONAS` in
[`e2e/env.ts`](../../e2e/env.ts).

### 2.3 Where a role lands after sign-in

`landingFor()` in [`apps/web/app/routing.ts`](../../apps/web/app/routing.ts):
the role prefix picks the workspace — `axis.*` → `/axis`, `orbit.*` → `/orbit`,
and so on for `signal`, `scout`, `north`. The non-module prefixes are mapped
explicitly: `tenant.*` → `/admin`, `platform.*` → `/platform`, `dev.*` →
`/admin`, `customer` → `/settings`. If that destination is not in the actor's
nav, the router falls back to the first workspace they are allowed to open, and
finally to `/settings`, which every actor can always reach. **A landing
redirect never lands anyone in a 403.**

The twelve module workspaces are `/axis`, `/orbit`, `/signal`, `/scout`,
`/north`, `/distribution`, `/ledger`, `/analytics`, `/compliance`, `/admin`,
`/platform`, `/settings`.

---

## 3. Use cases by module

### 3.1 AXIS — operations

---

#### UC-01 — Exception clearing (`J-O1`)

| | |
| --- | --- |
| **Actor** | `axis.agent` (demo: Layla Hassan) |
| **Preconditions** | Signed in; at least one AXIS case exists. The seeded tenant has a full case book. |
| **Screens / routes** | [`/axis/cases`](../../apps/web/app/routes/module.tsx) (list, generic workspace screen), `/axis/cases/:id` (record), [`/axis/exceptions`](../../apps/web/app/routes/axis-exceptions.tsx) (the cross-resource work queue) |

**The point of this journey:** a human should only ever see the automations
that *failed*, never a raw inbox. Target from docs/06: exceptions under 10% of
cases, median clear under 15 minutes.

**Steps**

1. Sign in as an AXIS agent. You land on `/axis`.
2. Open **Cases** from the AXIS workspace (`/axis/cases`).
3. Open the **New** disclosure, fill **Reference**, **Kind**, **Status**, and
   **Create** — or pick an existing case from the list.
4. Open the case from its row link. The URL becomes `/axis/cases/<id>`.
5. In the record's edit form, set **Status** to **Failed** and **Save changes**.
6. Go back to the list filtered to failures: `/axis/cases?status=failed`. The
   case is there.
7. Open it again, set **Status** to **Quoting**, and **Save changes** — this is
   "clearing" the exception.
8. Return to `/axis/cases?status=failed`.

**Expected result** — the case shows *Quoting* on its record, and it has
**disappeared** from the `status=failed` queue. The queue is the work list: an
item leaving it is the whole success signal.

**What gets written** — the `axis_cases` row's status; an audit entry per
update (visible on `/admin/audit-log` as `axis.cases.update`); process events
that feed the AXIS process map at `/axis/process-map`.

**Automated coverage** — [`e2e/ops.spec.ts`](../../e2e/ops.spec.ts),
`@journey:J-O1 @accept:M2`.

---

#### UC-02 — Group medical bid: shop the provider panel (`J-O2`)

| | |
| --- | --- |
| **Actor** | `axis.lead` (demo: Omar Farouk) |
| **Preconditions** | A product on the `health` line and a distribution channel (`alpha-brokers` is seeded). |
| **Screens / routes** | `/admin/products?line=health`, `/distribution/channels`, [`/distribution/channels/:id/detail`](../../apps/web/app/routes/channel-detail.tsx), `/distribution/quote-requests`, `/distribution/quote-requests/:id`, [`/distribution/quote-requests/:id/compare`](../../apps/web/app/routes/quote-compare.tsx), [`/axis/quote-desk`](../../apps/web/app/routes/axis-quote-desk.tsx) |

**The point of this journey:** turn a days-long group bid into hours — census
in, panel out, quotes compared, proposal produced.

**Steps**

1. Sign in as the AXIS lead.
2. Open `/admin/products?line=health` and open the first product. Note its id
   from the URL.
3. Open `/distribution/channels?q=alpha-brokers`, open **alpha-brokers**, and
   note its id from the URL.
4. Open `/distribution/quote-requests`, open the **New** disclosure, and fill
   **Channel**, **Product**, **Risk details** (JSON), **Currency** (`AED`).
   **Create**.
5. Filter to `/distribution/quote-requests?state=open` and open the request.
6. Open the comparison view: `/distribution/quote-requests/<id>/compare`.

**Expected result** — with no provider responses yet, the comparison page says
plainly **"The panel was never asked"** and **"This request has no responses at
all, not even a decline. Re-shop it to send the requirement out."** That
honesty is the feature: an empty compare screen must never look like "the panel
declined". Once providers answer, the same screen ranks the quotes by the
tenant's declared criteria.

**What gets written** — a `dist_quote_requests` row; audit entries for the
create; provider-facing dispatch when the request is shopped.

**Automated coverage** — [`e2e/ops.spec.ts`](../../e2e/ops.spec.ts),
`@journey:J-O2 @accept:M2`.

**Support note** — the census-upload half of docs/06's prose (any-format
employee list → normalised census with gap chasing) is specified in
[`docs/modules/axis.md`](../modules/axis.md) §2.2 and is not part of the
covered path above; the automated spec covers the panel-shopping half.

---

### 3.2 ORBIT — customers and partners

---

#### UC-03 — Customer gets help on WhatsApp; agent approves the AI's reply (`J-C2`)

| | |
| --- | --- |
| **Actor** | `orbit.agent` (demo: Sara Al Nasser) |
| **Preconditions** | Signed in with ORBIT agent rights. |
| **Screens / routes** | `/orbit/conversations`, `/orbit/conversations/:id`, [`/orbit/conversations/:id/thread`](../../apps/web/app/routes/conversation.tsx), `/orbit/messages`, [`/orbit/console`](../../apps/web/app/routes/orbit-console.tsx) |

**The point of this journey:** the AI drafts, the human decides. Nothing the
model writes reaches a customer without a person pressing a button — CLAUDE.md
§11's ambient-AI rule, and the reason the confirmation copy is worded the way
it is.

**Steps**

1. Sign in as the ORBIT agent.
2. Open `/orbit/conversations`, open the **New** disclosure, choose
   **Channel = WhatsApp**, enter a **Customer**, **Create**.
3. Open the new conversation row's link, and note the conversation id from the
   URL.
4. Open `/orbit/messages`, **New**, set **Conversation** to that id,
   **Sender = Customer**, type the customer's question, **Create**.
5. Add a second message on the same conversation with **Sender = AI agent** and
   the drafted reply text. (In production this is the model's output; in a
   demo it is entered by hand so the flow can be shown without a live model.)
6. Open the thread: `/orbit/conversations/<id>/thread`.

**Expected result** — a region titled **"Suggested reply"** holds the draft. One
click on **"Approve and queue"** and the status line reads exactly:
**"Draft approved and queued as an AI turn. It has not left yet."** The reply is
*queued*, not sent. The message list masks message bodies as `[redacted]` for
anyone without `core:pii:view`.

**What gets written** — `orbit_conversations` and `orbit_messages` rows; the
approved draft becomes an AI turn with a delivery status; the model call (in
production) is written to `ai_audit_log` with tenant, module, purpose and actor.

**Automated coverage** —
[`e2e/orbit-journeys.spec.ts`](../../e2e/orbit-journeys.spec.ts),
`@journey:J-C2 @accept:M3`.

---

#### UC-04 — Renew in one tap (`J-C3`)

| | |
| --- | --- |
| **Actor** | `orbit.retention` (demo: Yusuf Karim), with `axis.lead` (Omar Farouk) for one step |
| **Preconditions** | A policy inside the 45-day renewal window and the nightly renewal sweep having run. The seeded tenant has such a policy. |
| **Screens / routes** | `/orbit/renewals`, `/orbit/renewals/:id`, [`/distribution/next-best-offers/suggest`](../../apps/web/app/routes/dist-offers.tsx), [`/orbit/pipeline`](../../apps/web/app/routes/orbit-pipeline.tsx) |

**The point of this journey:** the customer re-enters nothing, and the two acts
are deliberately split between two roles — proposing offers is retention's job,
**surfacing an offer to a customer is not**.

**Steps**

1. The nightly sweep raises renewals for policies expiring within 45 days.
   There is **no UI button for this** — it is a scheduled engine
   (`apps/api/src/engines/renewals.ts`), and `orbit_renewals` has no create
   permission by design. On staging, wait for the schedule or ask an engineer
   to trigger the sweep.
2. Sign in as retention. Open `/orbit/renewals` and open the renewal.
3. Propose offers for that customer:
   `/distribution/next-best-offers/suggest?customerId=<id>`. The **Customer**
   field arrives pre-filled from the query string. Press **"Propose offers"**.
4. Look for a **"Surface … to the customer"** button. **There is none for this
   actor** — surfacing needs `dist:offers:surface`, which retention does not
   hold, so the button is never rendered.
5. Sign in as the AXIS lead, open the same suggest URL, and press
   **"Surface … to the customer"**.
6. Sign back in as retention, open `/orbit/renewals/<id>`, set **State** to
   **Accepted**, and **Save changes**.

**Expected result** — after step 5 the page shows **"Surfaced."**; after step 6
the renewal reads **Accepted**. The one-tap close for the customer is the
hosted renewal link; the desk-side close is this state change.

**What gets written** — `orbit_renewals` rows from the sweep;
`dist_next_best_offers` rows moving `proposed` → `surfaced`; audit entries for
both the propose and the surface.

**Automated coverage** —
[`e2e/orbit-journeys.spec.ts`](../../e2e/orbit-journeys.spec.ts),
`@journey:J-C3 @accept:M3`.

**Support note** — the UI's renewal states are `scheduled | offered | accepted |
lost`. Some older docs and API tests mention `renewed`; the API column is
untyped text and will accept it, but no screen offers it. Treat **Accepted** as
the real close.

---

#### UC-05 — Handover catch: AI escalates to a human (`J-X1`)

| | |
| --- | --- |
| **Actor** | `orbit.agent` for the handover; `orbit.lead` for the QA score |
| **Preconditions** | An escalated conversation. The seed contains one on WhatsApp number `wa:971559876543`. |
| **Screens / routes** | `/orbit/conversations`, `/orbit/conversations/:id/thread`, `/orbit/qa-scores`, [`/orbit/quality`](../../apps/web/app/routes/orbit-quality.tsx) |

**The point of this journey:** when the AI escalates, the human console opens
with the *context already assembled* — summary, suggested action, mood — and
the quality score shows up afterwards without anyone requesting it.

**Steps (part A — reading an escalation)**

1. Sign in as the ORBIT agent.
2. Open `/orbit/conversations` and open the row for `wa:971559876543`.
3. Click **"Open thread"**.

**Expected result (A)** — a region **"Handover notes"** contains the AI's
escalation summary (the seeded one reads *"Collision reported in Arabic on
Sheikh Zayed Road…"*), and a region **"Quality scores"** lists the QA agent's
scores for that conversation.

**Steps (part B — handing to a teammate)**

4. Create a conversation from the **New** disclosure with an **External
   reference** you can find again, open it, and click **"Open thread"**.
5. Fill **"What the next person needs to know"** and press **"Save handover
   note"**.

**Expected result (B)** — the note appears under **Handover notes**
immediately.

**Steps (part C — who may score)**

6. As the agent, try to score the handover. The agent cannot: scoring needs
   `orbit:qa:score`.
7. Sign in as the ORBIT lead and open `/orbit/qa-scores`. The `orbit.escalation`
   scores are listed.

**What gets written** — `orbit_handover_notes`; `orbit_qa_scores` (written by
the QA agent for 100% of conversations, per
[`docs/modules/orbit.md`](../modules/orbit.md) §2.1).

**Automated coverage** — [`e2e/handover.spec.ts`](../../e2e/handover.spec.ts),
three tests, `@journey:J-X1 @accept:M3`.

---

#### UC-06 — Save desk and its price-match bounds (`J-X2`)

| | |
| --- | --- |
| **Actor** | `orbit.retention` on the desk; `axis.lead` and `finance.controller` on the gated actions |
| **Preconditions** | Renewals in the book with churn risk scored. |
| **Screens / routes** | [`/orbit/save`](../../apps/web/app/routes/orbit-save.tsx), `/axis/policies`, [`/ledger/settlement`](../../apps/web/app/routes/settlement.tsx), [`/ledger/settlements/:id`](../../apps/web/app/routes/settlement-detail.tsx), [`/approvals`](../../apps/web/app/routes/approvals.tsx) |

**The point of this journey:** a retention agent may discount, but only inside
bounds somebody else set — and the boundary is enforced by the approval engine,
not by an honour system.

**Steps (the desk)**

1. Sign in as retention and open `/orbit/save`.
2. The desk shows **High churn risk**, **Waiting on us**, **Offer out** and
   **Saved this window** counters, then three queues: **Save queue**, **Offers
   outstanding**, **Recently settled**.
3. On a queue row use **"Make the offer"** to send a save offer, **"Change
   strategy"** to reassign, and **"Record the outcome"** to close it with a
   **Result** (accepted / lost) and a **Reason** (`price`, `competitor`,
   `saved_discount`, `saved_service`, …). **"Why this score"** explains the
   churn risk.

**Expected result (the desk)** — the status line reads **"Recorded."** and the
row moves between queues.

**Steps (the bounds — what a save cannot do on its own)**

4. As the AXIS lead, open `/axis/policies` and try to create a policy with a
   premium above the bind threshold (250,000.00 in minor units).
5. As a finance controller, open `/ledger/settlement`, open a **Draft** run,
   and press **Approve**.

**Expected result (the bounds)** — step 4 is refused with an alert naming
**`axis.bind`**, and the policy does **not** appear in the list. Step 5 is
refused with **"Waiting on an approval"** naming **`dist.settlement_run`**, plus
an **"Open the approval queue"** link. `dist.settlement_run` is
`always` + `neverAutoApprove`: a settlement run **always** needs a second
controller, no matter the amount, and can never be auto-approved by tenant
policy.

**What gets written** — a `core_approvals` row per refusal, carrying the policy
key and the subject reference; nothing else until a second person decides it.

**Automated coverage** — [`e2e/save-desk.spec.ts`](../../e2e/save-desk.spec.ts),
two tests, `@journey:J-X2`. Note the automated spec covers the **dual-control
refusals**, not the `/orbit/save` screen itself — the desk is covered by the
manual UAT script in [`06-test-scripts.md`](./06-test-scripts.md).

---

#### UC-07 — Partner integration: signup to sandbox key (`J-X3`)

| | |
| --- | --- |
| **Actor** | An external partner developer (no LYRA session), then `orbit.partners` internally |
| **Preconditions** | None — this is a public API endpoint. |
| **Screens / routes** | API only: `POST /v1/onboarding/partners/signup`, then `GET /v1/dist/quote-requests` with the minted key. Internally: `/orbit/partners`, [`/onboarding/:kind/:ref`](../../apps/web/app/routes/onboarding.tsx) |

**The point of this journey:** a partner developer gets from "never heard of
LYRA" to a working sandbox call in under 30 minutes, and the sandbox key is
provably scoped — it cannot read tenant data.

**Steps**

1. `POST /v1/onboarding/partners/signup` with the partner's details. The
   response includes a sandbox API key.
2. Call `GET /v1/dist/quote-requests` with `Authorization: Bearer <key>` — it
   works.
3. Call `GET /v1/core/users` with the same key — it is refused.
4. Repeat step 1 with the **same email**. It is throttled.
5. Internally, the partner's onboarding checklist is at
   `/onboarding/partner/<ref>`; certification steps are ticked there before a
   live key is issued.

**Expected result** — sandbox keys read distribution surfaces and nothing else;
a duplicate signup from one address does not mint a second key.

**What gets written** — a partner record, an onboarding checklist, an API key
row marked as sandbox scope.

**Automated coverage** —
[`e2e/partner-signup.spec.ts`](../../e2e/partner-signup.spec.ts), two tests,
`@journey:J-X3 @accept:M3`. This journey is API-only in the automated suite —
there is no partner-facing signup **page** in `apps/web`; the flow is exercised
against the API.

---

### 3.3 SIGNAL — marketing

---

#### UC-08 — Campaign in a day (`J-M1`)

| | |
| --- | --- |
| **Actor** | `signal.lead` (demo: Noor Jamal) |
| **Preconditions** | Signed in with the launch permission. `signal.campaign_launch` is on the tenant's `auto_approve` allowlist, so a launch by a lead does not queue for approval. |
| **Screens / routes** | `/signal/audiences`, `/signal/audiences/:id`, `/signal/campaigns`, `/signal/campaigns/:id`, [`/signal/studio`](../../apps/web/app/routes/signal-studio.tsx), [`/signal/cockpit`](../../apps/web/app/routes/signal-cockpit.tsx), `/admin/audit-log` |

**Steps**

1. Sign in as the growth lead.
2. Open `/signal/audiences`, **New**, fill **Name** and **Definition** (a JSON
   rule tree), **Create**. Open the audience and note its id from the URL.
3. Open `/signal/campaigns`, **New**, fill **Name**, **Audience** (that id),
   **Channels** (`["email","whatsapp"]`), **Budget**
   (`{"dailyMinor":50000}`), **Owner**. **Create**.
4. Open the campaign. It reads **Draft**.
5. Change its state to **Live** and **Save changes**.
6. Open `/admin/audit-log`.

**Expected result** — the campaign record reads **Live** with no approval
interruption (auto-approve allowlist), and `/admin/audit-log` carries a
`signal.campaigns.update` entry naming the campaign. Launching without a trail
is the failure mode this journey guards.

**Negative case** — a marketer who lacks the launch permission does not see a
disabled button: opening `/signal/campaigns` shows **"Your roles do not include
access to this area."**

**What gets written** — `signal_audiences`, `signal_campaigns`; a
`core_audit_log` entry per write; campaign lifecycle events on the bus.

**Automated coverage** — [`e2e/campaign.spec.ts`](../../e2e/campaign.spec.ts),
two tests, `@journey:J-M1 @accept:M4`.

**Support note** — creative generation (the "20 ar/en variants" and the
compliance flag lane in [`docs/modules/signal.md`](../modules/signal.md) §2.1)
lives in the studio at `/signal/studio` and is covered by the compliance and
signal **evals**, not by this e2e spec.

---

#### UC-09 — Budget morning: reverse an autopilot move (`J-M2`)

| | |
| --- | --- |
| **Actor** | `signal.lead` (demo: Noor Jamal) |
| **Preconditions** | An autopilot budget move exists. The seed contains one referencing *"Bing's cost per policy"*. |
| **Screens / routes** | `/signal/budget-moves`, `/signal/budget-moves/:id`, [`/signal/budget`](../../apps/web/app/routes/signal-budget.tsx), `/approvals` |

**The point of this journey:** the autopilot moves money daily; a human must be
able to undo a move from a phone in two minutes — but undoing is itself an
approved act, so it leaves a trail.

**Steps**

1. Sign in as the SIGNAL lead.
2. Open `/signal/budget-moves` and open the *Bing's cost per policy* row. Note
   the move id.
3. In the edit form fill **Reversed by** and **Reversed** (a datetime), then
   **Save changes**.
4. Read the refusal, then follow **"Open the approval queue"** to `/approvals`.
5. Find the **Budget move** request for that move id and press **Approve**.
6. Return to the record, **re-enter** the same two fields, and **Save changes**
   again.

**Expected result** — step 3 gives **"Waiting on an approval"** naming
**`signal.budget_move`**; step 5 gives **"Approved. The action may now
proceed."**; step 6 writes, and reopening the record shows the reversal fields
persisted. `signal.budget_move` is **single control** — the same lead who asked
may approve it (`dualControl: "never"`), which is what makes the two-minute
mobile flow possible.

**What gets written** — `signal_budget_moves` reversal fields; a `core_approvals`
row with the decision and the deciding actor; audit entries for both.

**Automated coverage** —
[`e2e/signal-budget.spec.ts`](../../e2e/signal-budget.spec.ts),
`@journey:J-M2 @accept:M4`.

---

#### UC-10 — Own the answer box (`J-M3`)

| | |
| --- | --- |
| **Actor** | `signal.lead` / `signal.marketer` |
| **Preconditions** | A query cluster worth answering. |
| **Screens / routes** | `/signal/aeo-pages`, `/signal/aeo-pages/:id`, [`/signal/answer-engines`](../../apps/web/app/routes/signal-answer-engines.tsx) |

**Steps**

1. Sign in as the SIGNAL lead.
2. Open `/signal/aeo-pages`, **New**, fill **Query cluster** and **Content**,
   **Create**.
3. Open the new page from its row.

**Expected result** — the record reads **Draft**, and shows the query cluster
and content reference it was authored against. `/signal/answer-engines` is
where answer-engine coverage and citation share are read.

**What gets written** — a `signal_aeo_pages` row.

**Automated coverage** — [`e2e/answer-box.spec.ts`](../../e2e/answer-box.spec.ts),
`@journey:J-M3`.

**Support note** — docs/06 describes an eight-week citation-share trend for this
journey. Authoring is built and tested; the longitudinal citation-share trend is
a reporting surface on `/signal/answer-engines` and has no e2e assertion.

---

### 3.4 SCOUT — product

---

#### UC-11 — Radar quarterly: validate a whitespace candidate (`J-P1`)

| | |
| --- | --- |
| **Actor** | `scout.lead` (demo: Tariq Mansour) |
| **Preconditions** | An unpromoted whitespace candidate. The seed has *"Domestic helper package"*. |
| **Screens / routes** | `/scout/whitespaces`, `/scout/whitespaces/:id`, [`/scout/radar`](../../apps/web/app/routes/scout-radar.tsx), [`/scout/experiments`](../../apps/web/app/routes/scout-experiments.tsx), `/approvals` |

**The point of this journey:** whitespaces are *derived* from clusters — there
is no "create whitespace" button anywhere. The only write is moving one along
its lifecycle, and that write is approval-gated.

**Steps**

1. Sign in as the SCOUT lead.
2. Open `/scout/whitespaces` and open the **Domestic helper package** row.
   (This list has no search — `?q=` is rejected with a 400. Find the row by
   reading the list.)
3. Set **Status** to **Validated**, fill **Owner**, fill **Promoted**
   (a datetime). **Save changes**.
4. Follow **"Open the approval queue"**, find the **Whitespace promote**
   request for that whitespace id, and press **Approve**.
5. Return to the record, re-enter the same three fields, **Save changes**.

**Expected result** — step 3 is refused with **"Waiting on an approval"** naming
**`scout.whitespace_promote`**; step 4 approves it (single control — the same
lead decides); step 5 persists, and the record's detail list shows **Validated**
and the owner.

**Known UI limit** — the status select offers `candidate`, `validating`,
`validated`, `parked`. It does **not** offer `promoted`, even though the API
accepts that value. A ticket asking "why can't I set promoted?" is this, not a
bug in the actor's permissions.

**What gets written** — the `scout_whitespaces` row; a `core_approvals` row and
its decision; audit entries.

**Automated coverage** —
[`e2e/scout-whitespace.spec.ts`](../../e2e/scout-whitespace.spec.ts),
`@journey:J-P1 @accept:M5`.

---

#### UC-12 — Panel negotiation (`J-P2`)

| | |
| --- | --- |
| **Actor** | `tenant.admin` proposes the rate change; a **second** person (`finance.controller`) decides it. `scout.lead` reads the benchmarks. |
| **Preconditions** | A distribution channel to change rates on. Two distinct human accounts. |
| **Screens / routes** | `/distribution/commission-rates`, [`/scout/panel-bench`](../../apps/web/app/routes/scout-panel.tsx), [`/scout/panel`](../../apps/web/app/routes/scout-panel.tsx), `/approvals` |

**The point of this journey:** a bench alert produces evidence for a meeting,
and the commercial outcome of that meeting — a commission rate change — is
**dual control**. `dist.rate_change` is `always` + `neverAutoApprove`: one
person can never move a commission rate, and tenant policy cannot automate it
away.

**Steps**

1. Sign in as the SCOUT lead and open `/scout/panel-bench`. Benchmarks by line
   (e.g. `motor`) are readable — win rate, price index versus panel median.
   `/scout/panel` assembles the negotiation pack.
2. Sign in as the tenant admin. Open `/distribution/commission-rates`, **New**,
   fill **Channel**, **Channel share**, **Effective from**. **Create**.
3. Read the refusal. Confirm the new rate is **not** in the list.
4. Sign in **as a different person** (a finance controller). Open `/approvals`,
   find the **Dist rate change** request, press **Approve**.

**Expected result** — step 3 shows an alert naming **`dist.rate_change`** and
the rate row is absent; step 4 shows **"Approved. The action may now
proceed."** The requester must then re-submit the create.

**What gets written** — a `core_approvals` row; on retry after approval, the
`dist_commission_rates` row plus audit entries.

**Automated coverage** —
[`e2e/panel-negotiation.spec.ts`](../../e2e/panel-negotiation.spec.ts),
two tests, `@journey:J-P2 @accept:M5`.

---

### 3.5 NORTH — executive

---

#### UC-13 — The 7am read (`J-E1`)

| | |
| --- | --- |
| **Actor** | `north.exec` (demo: Hala Zayed), typically on a phone |
| **Preconditions** | The nightly briefing Workflow has run; an anomaly has been detected. The seed contains a `cac_per_policy` anomaly and yesterday's published briefing. |
| **Screens / routes** | `/north/briefings`, `/north/briefings/:id`, `/north/anomalies`, `/north/anomalies/:id`, [`/north/brief`](../../apps/web/app/routes/north-brief.tsx) |

**Steps**

1. Sign in as the executive **in a phone-sized viewport** — this journey is
   specified as a mobile read.
2. Open `/north/briefings`. Find yesterday's row (dated, audience *Executive*,
   locale *en*).
3. The row reads **Published**. Open it; the heading is the briefing date.
4. Open `/north/anomalies` and open the **`cac_per_policy`** anomaly.
5. Fill **Linked action** with the follow-up reference and **Save changes**.

**Expected result** — the briefing renders as a short written narrative with
numbers first; the anomaly record then shows **Action created**. Every figure in
the prose is machine-verified against the metric layer before publication — the
narrator cannot state a number the snapshot did not provide.

**What gets written** — `north_briefings` (published state), `north_anomalies`
(linked action), plus the action record.

**Automated coverage** — [`e2e/north.spec.ts`](../../e2e/north.spec.ts),
`@journey:J-E1 @accept:M6`. The numeric-claim verification itself is gated by
the `north` eval (recall 1.0, false positives 0).

---

#### UC-14 — Board Thursday (`J-E2`)

| | |
| --- | --- |
| **Actor** | `north.exec`; `north.board` reads the result |
| **Preconditions** | A period worth reporting on. |
| **Screens / routes** | `/north/boardpacks`, `/north/boardpacks/:id` |

**Steps**

1. Sign in as the executive.
2. Open `/north/boardpacks`, **New**, fill **Title**, **Period** (e.g.
   `2026-Q1`), **Sections** (JSON), **Create**.
3. Open the pack from its row.

**Expected result** — the pack exists with its sections, assembled in one
action rather than hand-built.

**Automated coverage** — [`e2e/north.spec.ts`](../../e2e/north.spec.ts),
`@journey:J-E2 @accept:M6`.

**Support note — deliberate scope gap.** docs/06's J-E2 prose continues
"approve → distribute → read receipts before the meeting". **Assembly is built;
approve, distribute and read-receipt tracking are not.** There is no UI for
them and the spec does not assert them. If a stakeholder asks for read
receipts, that is a roadmap item, not a defect.

---

#### UC-15 — What-if scenario (`J-E3`)

| | |
| --- | --- |
| **Actor** | `north.exec` |
| **Preconditions** | None beyond a signed-in exec. |
| **Screens / routes** | `/north/scenarios`, `/north/scenarios/:id` |

**Steps**

1. Sign in as the executive.
2. Open `/north/scenarios`, **New**, fill **Question**, **Assumptions** (JSON),
   **Author**. **Create**.
3. Open the scenario from its row.
4. Later — at the review date — edit **Assumptions** to add the actuals
   (e.g. an `actualDeltaPts` key) and **Save changes**.
5. Reopen the scenario.

**Expected result** — the saved scenario returns with the updated assumptions
intact, so the original question can be re-read against what actually happened.
Ranges and assumptions are shown, never a single confident number.

**What gets written** — a `north_scenarios` row, versioned by its updates.

**Automated coverage** — [`e2e/north.spec.ts`](../../e2e/north.spec.ts),
`@journey:J-E3 @accept:M6`.

---

### 3.6 Ledger and finance

---

#### UC-16 — Month-end reconciliation (`J-O3`)

| | |
| --- | --- |
| **Actor** | `finance.controller` (demo: Nadia Rahman or Faisal Omar) |
| **Preconditions** | Transactions in the period, and a statement to reconcile against. |
| **Screens / routes** | [`/ledger/transactions`](../../apps/web/app/routes/ledger-transaction.tsx), [`/ledger/recon`](../../apps/web/app/routes/ledger-recon.tsx), `/ledger/recon/:id`, [`/ledger/period-close`](../../apps/web/app/routes/ledger-periods.tsx), `/axis/cases/:id/detail` (evidence bundles) |

**The point of this journey:** match ≥ 95% automatically, and every exception a
human decides carries a written reason, so the sign-off bundle can be handed to
an auditor without further explanation.

**Steps**

1. Sign in as a finance controller.
2. Open `/ledger/transactions`. Open a transaction: fill **Transaction key**
   (the idempotency key), **Currency** (`AED`), **Gross amount**, **Amount**,
   and press **"Open transaction"**.
3. Confirm the confirmation reads **"Opened as …"**.
4. Open `/ledger/recon`. Paste the bank/provider **Statement lines** and press
   **"Start run"**.
5. Open the run from the **Run** link. The matcher has proposed matches.
6. Find the row for your statement reference. It reads **Within tolerance** and
   **Proposed**.
7. Fill **Why** with a reason (e.g. *"Matches bank feed for this period"*) and
   press **Confirm**.

**Expected result** — **"Match recorded as Confirmed"**, and the row now reads
**Confirmed**. A match cannot be confirmed without a reason — the **Why** field
is the audit evidence, not a nicety.

**What gets written** — a `ledger_transactions` row keyed by its idempotency
key; balanced double-entry lines in `ledger_journal_lines`; a recon run and its
match rows with the decider and the reason; a recon evidence bundle downloadable
from the case detail page.

**Automated coverage** — [`e2e/ops.spec.ts`](../../e2e/ops.spec.ts),
`@journey:J-O3 @accept:M2`. Ledger invariants (every batch balances; no
period-closed posting) are property-tested in `packages/core` and must never be
relaxed to make a test pass.

---

### 3.7 Admin, developer and compliance

---

#### UC-17 — New tenant (`J-A1`)

| | |
| --- | --- |
| **Actor** | `platform.admin` in the specification; `tenant.admin` for everything reachable today |
| **Preconditions** | A seeded tenant. |
| **Screens / routes** | `/admin/tenants`, `/admin/tenants/:id`, `/admin/roles`, `/admin/agents`, [`/settings/brand`](../../apps/web/app/routes/settings.tsx) |

**Steps (what is reachable)**

1. Sign in as the tenant admin.
2. Open `/admin/roles` — more than ten roles are provisioned.
3. Open `/admin/agents` — at least eight agents are provisioned.
4. Open `/admin/tenants`. **Exactly one row** is listed: your own tenant,
   `gonxt`, plan **enterprise**. `core_tenants` has no `tenant_id` column, so it
   is scoped by its own id — this list can never span tenants.
5. Open the tenant row. The heading is **GONXT**; the slug `gonxt` shows in the
   read-only detail list; the **Brand** field holds the brand JSON.
6. Appearance is edited at `/settings/brand`: **Product name**, logos for light
   and dark backgrounds, square mark, **Accent** / **Accent, hovered** /
   **Text on the accent** (six-digit hex), and **Typeface**. A live **Preview**
   is shown, and a failing contrast ratio is refused with a message rather than
   saved.

**Expected result** — the tenant is complete enough to work in, and no
cross-tenant data is reachable from inside it.

**Support note — deliberate scope gap.** docs/06's J-A1 is a platform-admin
flow: create tenant → brand upload with contrast auto-check → entitlements →
domain → invite the tenant admin → synthetic smoke suite green. **There is no
tenant-creation form in `apps/web`, no `platform.admin` demo persona, and no
domain-binding or smoke-suite screen.** The admin module's own code says so:
creating a tenant is a platform act, not a tenant act; the tenants tab edits the
one you are signed in to. Tenant creation today is an operational task, not a
UI journey.

**Automated coverage** —
[`e2e/tenant-onboarding.spec.ts`](../../e2e/tenant-onboarding.spec.ts),
two tests, `@journey:J-A1 @accept:M1`.

---

#### UC-18 — New teammate (`J-A2`)

| | |
| --- | --- |
| **Actor** | `tenant.admin` (demo: Amina Saleh) |
| **Preconditions** | Signed in as tenant admin. |
| **Screens / routes** | [`/admin/staff`](../../apps/web/app/routes/staff.tsx), [`/admin/staff/:id`](../../apps/web/app/routes/staff-member.tsx), [`/admin/permissions`](../../apps/web/app/routes/admin-roles.tsx) |

**Steps**

1. Sign in as the tenant admin and open `/admin/staff`.
2. Fill **Email** and **Name**.
3. Tick the role bundle — for example the **Tenant administrator** checkbox.
4. Press **"Send invitation"**.

**Expected result** — an **Invited** heading appears, and the new person is in
the staff table with status **Invited**. The role bundle is effective
immediately; there is no separate activation step to chase. Per-role permission
grids are inspectable at `/admin/permissions`.

**What gets written** — a `core_users` row in invited state with its role
grants; audit entries for the invitation.

**Automated coverage** — [`e2e/staff.spec.ts`](../../e2e/staff.spec.ts),
`@journey:J-A2 @accept:M1`. This spec also runs an **axe-core WCAG 2.2 AA
check** on `/admin/staff`.

---

#### UC-19 — Incident pause: stop an agent (`J-A3`)

| | |
| --- | --- |
| **Actor** | `tenant.compliance` pauses (demo: Khalid Al Rashed, Arabic UI); `tenant.admin` resumes (demo: Amina Saleh) |
| **Preconditions** | At least one agent running. The seed provisions eight or more. |
| **Screens / routes** | [`/admin/ai/console`](../../apps/web/app/routes/ai-console.tsx), [`/admin/ai/budget`](../../apps/web/app/routes/ai-budget.tsx), `/admin/ai/runs/:id` |

**The point of this journey:** the kill switch is one click, it needs a reason,
and the pause is visible to *everyone* immediately — not just to the person who
pressed it.

**Steps**

1. Sign in as the tenant admin and open `/admin/ai/console`. Each agent is a
   card; the *Executive briefing* agent reads **Active**.
2. In a second browser session, sign in as the compliance officer and open the
   same screen. Because that account's locale is Arabic, the card is titled
   **الإحاطة التنفيذية** and reads **نشط** (active).
3. Fill **السبب** (the reason) and press **إيقاف الوكيل** (pause the agent).
4. Watch the **admin's** session.
5. As the admin, press **"Resume agent"**.

**Expected result** — step 3 flips the compliance officer's card to **موقوف**
(paused); step 4 shows the admin's card flipping to **Paused** without them
doing anything; step 5 returns it to **Active**. Pausing **requires a reason**;
the field is not optional.

**What gets written** — the agent's paused state and the reason; audit entries
for both the pause and the resume.

**Automated coverage** — [`e2e/ai-console.spec.ts`](../../e2e/ai-console.spec.ts),
`@journey:J-A3`. The spec drives two browser contexts at once — it is the only
e2e spec that proves cross-session visibility.

**Known limit** — docs/06 says "resume with audit note". The **pause** takes a
reason; the **resume** has no note field on the console.

---

#### UC-20 — First API call (`J-D1`)

| | |
| --- | --- |
| **Actor** | `tenant.admin` issues the key; a developer uses it |
| **Preconditions** | Signed in as tenant admin. |
| **Screens / routes** | [`/settings/security`](../../apps/web/app/routes/settings.tsx), [`/admin/developer`](../../apps/web/app/routes/admin-developer.tsx), [`/axis/dev`](../../apps/web/app/routes/axis-dev.tsx) (extraction sandbox), and the public `GET /openapi.json` |

**Steps**

1. Confirm the API document is public: `GET {API}/openapi.json` returns 200,
   and `GET {API}/health` returns 200.
2. Confirm everything else needs a credential: `GET {API}/v1/me` without a
   token returns **401**, and with a bad token also returns 401.
3. Sign in as the tenant admin and open `/settings/security`.
4. In the API keys panel fill **"What is it for"**, choose the **test**
   environment, and press **"Issue key"**.
5. Copy the secret from the confirmation — it begins **`qvk_test_`** and is
   shown **once**.
6. Call `GET {API}/v1/me` with `Authorization: Bearer qvk_test_…`. It succeeds.
7. Back on `/settings/security`, press **Revoke** on that key's row.
8. Call `/v1/me` with the same key again.

**Expected result** — the key row reads **Test** / **Active** while live; after
revoking, the status line says **"That key has been revoked."**, the row reads
**Revoked**, its **Revoke** button is gone, and the API rejects the key. The
developer portal at `/admin/developer` holds the SDK snippets and the sandbox
links.

**What gets written** — an API key row (hashed secret only), then its revocation
with the actor and timestamp; audit entries for issue and revoke.

**Automated coverage** — [`e2e/dev-portal.spec.ts`](../../e2e/dev-portal.spec.ts),
two tests, `@journey:J-D1 @accept:M1`.

**Support note — scope difference.** docs/06 describes a *dev portal* with a
webhook tester and a `dev.admin`-approved promotion from test to live key. The
built flow issues keys from **Settings → Sign-in & access**; `/admin/developer`
is the developer-facing console. Webhook signature verification is real and
contract-tested in `packages/sdk`, but there is no interactive webhook-tester
screen.

---

#### UC-21 — Regulator request: signed evidence bundle (`J-CO1`)

| | |
| --- | --- |
| **Actor** | `tenant.compliance` (demo: Khalid Al Rashed — Arabic UI) |
| **Preconditions** | A subject to scope the request to (a customer id, case id or conversation id). |
| **Screens / routes** | [`/compliance/run/evidence`](../../apps/web/app/routes/compliance-run.tsx), also `/compliance/run/screening` and `/compliance/run/retention`, plus `/admin/audit-log` and `/admin/ai-audit-log` |

**The point of this journey:** same-day turnaround, and the bundle is *signed* —
the regulator can verify it was not edited after export.

**Steps**

1. Sign in as the compliance officer. The workspace renders in Arabic, RTL.
2. Open `/compliance/run/evidence`. The heading reads **عمليات الامتثال**
   (compliance runs).
3. Fill **الموضوع** (the subject — e.g. `customer-91827`) and **أُعدّت لصالح**
   (prepared for — e.g. the federal regulator).
4. Press **إنشاء الحزمة** (build the bundle).

**Expected result** — a **الحزمة** (bundle) section appears reading **جاهزة**
(ready) with a **تنزيل الحزمة** (download the bundle) link. The bundle contains
the cases, conversations and AI-audit entries in scope.

**What gets written** — a compliance run row, the generated bundle in object
storage with its signature, and an audit entry naming the officer, the subject
and the recipient.

**Automated coverage** — [`e2e/compliance.spec.ts`](../../e2e/compliance.spec.ts),
`@journey:J-CO1 @accept:M6`. Because this persona is Arabic, this spec doubles
as RTL coverage of a real working screen.

---

### 3.8 Public portal (no session)

---

#### UC-22 — Get covered: self-serve quote (`J-C1`)

| | |
| --- | --- |
| **Actor** | A member of the public. **No sign-in.** |
| **Preconditions** | The tenant's storefront is published. |
| **Screens / routes** | [`/portal/gonxt`](../../apps/web/app/routes/portal.$tenantSlug.tsx), [`/portal/gonxt/quotes/:id?token=…`](../../apps/web/app/routes/portal.$tenantSlug.quotes.$id.tsx) |

**The point of this journey:** under ten minutes, same-session issuance, and a
ranking the visitor can trust — the ranking criteria are declared on the page
and nothing about commission or internal value scoring is ever shown.

**Steps**

1. Open `/portal/gonxt` with no session (a private window is the honest test).
2. In the **Motor comprehensive** product region, click **"Get a quote"**.
3. Fill **Your age**, **Value to insure**, **Full name**, **Email**, and tick
   **"I agree to be contacted about this quote."**
4. Press **"Request quote"**. The browser is redirected to
   `/portal/gonxt/quotes/<id>?token=<one-time token>`.
5. Read the offers.
6. Press **"Choose this cover"** on an offer.
7. Attach a document with the **Document** file input and press **"Upload
   document"**.

**Expected result**

- Step 4 lands on a page headed **"Your quotes"**.
- Step 5 shows ranked offers with **"Ranked by total price, cheapest first."**
  and a **Cheapest** marker. The words *commission*, *value score* and
  *declined because* appear **nowhere** — internal ranking signals are not
  public.
- Step 6 shows **"Next: send your documents"** and states plainly **"Nothing is
  bound yet."**, with the chosen offer marked **Chosen**.
- Step 7 confirms **"Received. Upload another if you have one."**

**Security property to check** — the comparison page is reachable **only** with
the one-time token in the link. Opening
`/portal/gonxt/quotes/<id>` without a valid token does not render the quotes.

**What gets written** — a quote request and its offers; the consent tick;
uploaded documents in object storage against the request.

**Automated coverage** —
[`e2e/self-serve-quote.spec.ts`](../../e2e/self-serve-quote.spec.ts),
two tests, `@journey:J-C1 @accept:M6`.

---

#### UC-23 — Exercise privacy rights (`J-C4`)

| | |
| --- | --- |
| **Actor** | Any data subject. **No sign-in.** |
| **Preconditions** | None. |
| **Screens / routes** | [`/portal/gonxt`](../../apps/web/app/routes/portal.$tenantSlug.tsx) → [`/portal/gonxt/privacy`](../../apps/web/app/routes/portal.$tenantSlug.privacy.tsx); internally `/compliance/run/retention` and the DSAR queue |

**The point of this journey:** requests are honoured inside 30 days and fully
logged — **and the intake form must never reveal whether an address belongs to a
customer**, because that would itself be a data leak to anyone who can type an
email address.

**Steps**

1. Open `/portal/gonxt` with no session.
2. Follow the footer link **"Your privacy rights"**.
3. Choose a request type — for example the **"Delete my data"** radio.
4. Fill **"Email address you deal with us on"**, optionally **"Full name
   (optional)"** and the free-text help field.
5. Press **"Send request"**.
6. Repeat with an email address that is definitely not a customer.

**Expected result** — both submissions show **"Request received"** with a
reference beginning **`dsr_`**. The unknown address gets the **same** response:
no *"not found"*, no *"no record"*, no *"unknown"*. Enumeration is impossible by
construction.

**What gets written** — a `dsr_…` request row routed into the compliance queue;
audit entries; the erasure or access package is produced by the retention
workflow.

**Automated coverage** —
[`e2e/privacy-portal.spec.ts`](../../e2e/privacy-portal.spec.ts),
two tests, `@journey:J-C4 @accept:M6`.

---

## 4. Supporting flows (no journey ID)

These carry no J-ID in docs/06 but are real, tested product surfaces that
support will be asked about. They are numbered on from the journeys so they can
be cited unambiguously.

---

### UC-24 — Endorse a policy mid-term

**Actor** `axis.lead` · **Routes**
[`/axis/policies/:id/detail`](../../apps/web/app/routes/policy-detail.tsx) →
[`/axis/policies/:id/endorse`](../../apps/web/app/routes/policy-endorse.tsx)

1. Open the policy detail page and click **Endorse**.
2. Enter the change (**Changes (JSON)**) and press **"Price this change"**.
3. Read the priced result — **Pro-rata days** and the money effect are shown
   before anything is written.
4. Tick **"I have checked the figures above and want this change written."**
5. Press **"Confirm the endorsement"**.

**Expected** — heading **"Endorsement written"**. **Price first, write second**
is the contract here: the confirm checkbox cannot be ticked before pricing, so
nobody writes a money change they have not read.

**Writes** — an endorsement record, a new policy version, and balanced ledger
postings for the premium difference.

**Coverage** — [`e2e/axis-lifecycle.spec.ts`](../../e2e/axis-lifecycle.spec.ts)
(untagged) plus `apps/api/src/axis-endorse.test.ts` and
`apps/web/app/routes/policy-endorse.test.ts`.

---

### UC-25 — Cancel a policy

**Actor** `axis.lead` · **Routes**
[`/axis/policies/:id/cancel`](../../apps/web/app/routes/policy-cancel.tsx)

1. From the policy detail page click **Cancel**.
2. Fill **Reason** and press **"Price this cancellation"**.
3. The pricing shows **Pro-rata days**, **Refund**, and **Commission
   clawback**.
4. Tick **"I have checked the figures above and want this cancellation
   written."** and press **"Confirm the cancellation"**.

**Expected** — the status line reads **"This cancellation needs an approval
first"**. A cancellation is money out and does **not** write on one person's
say-so, however carefully they read the figures.

**Coverage** — [`e2e/axis-lifecycle.spec.ts`](../../e2e/axis-lifecycle.spec.ts),
`apps/api/src/axis-lifecycle.test.ts`,
`apps/web/app/routes/policy-cancel.test.ts`.

---

### UC-26 — Work the renewal desk

**Actor** `orbit.retention` · **Routes**
[`/axis/renewals`](../../apps/web/app/routes/renewal-desk.tsx)

1. Open `/axis/renewals`.
2. On a renewal row press **"Auto re-quote"** → status reads **"Recorded."**
3. Press **"Do not contact"** to suppress per consent → **"Recorded."**
4. Press **"Bind renewal"**.

**Expected** — binding shows **"Waiting on an approval"**. Re-quoting and
suppression are desk work; binding is a money act and is gated.

**Coverage** — [`e2e/axis-lifecycle.spec.ts`](../../e2e/axis-lifecycle.spec.ts),
`apps/web/app/routes/renewal-desk.test.ts`.

---

### UC-27 — Claim: first notice of loss through to payment

**Actor** `axis.agent` for intake, `axis.lead`/handler for assessment ·
**Routes** [`/axis/claims/new`](../../apps/web/app/routes/fnol-intake.tsx),
[`/axis/claims/desk`](../../apps/web/app/routes/claims-desk.tsx),
[`/axis/claims/:id/detail`](../../apps/web/app/routes/claim-detail.tsx)

**Intake (`/axis/claims/new`, "New claim (FNOL)")**

1. Pick the **policy** the loss happened under.
2. Fill **Date of loss**, **Peril** (Theft / Collision / Weather / Liability /
   Other), **Cause**, **What happened**, **Estimated amount**, **Contact**, and
   **Reported via** (Phone / Email / WhatsApp / Web form / In person /
   Intermediary).
3. Press **"Check cover"** first.
4. Then press **"Register claim"**.

**Expected (intake)** — the **Coverage check** panel states the cover position
at the date of loss: **In force**, **Not yet incepted**, **Lapsed at loss**,
**Cancelled at loss**, **Out of cover** or **Unknown**. If there is no cover the
screen says **"No cover found for that date"** and offers **"Register anyway,
flag for review"** — the claim is never silently blocked, but it is never
silently accepted either. On success: **"Claim {claimNo} registered."**

**Desk (`/axis/claims/desk`)**

5. The desk lists claims by state (**Reported**, **Triage**, **Assessing**,
   **Awaiting docs**, **Approved**, **Rejected**, **Settling**, **Recovering**,
   **Reopened**, **Withdrawn**, **Settled**, **Closed**) with **Incurred**,
   **Reserve**, **Days open**, **Fraud score** and **Handler** columns, and an
   **Overdue** / **Due soon** SLA marker.
6. Use **"Assign a handler"** to give it an owner, and **Advance** with an
   **Outcome** and a **Reason code** to move it along.

**Detail (`/axis/claims/:id/detail`)**

7. **First notice** shows the report unedited. **Reserve** takes a new reserve
   amount with a **Basis** — press **"Add the reserve"**.
8. **Move the claim** transitions it with an outcome.
9. **Payment** takes **Paid to**, **Payee**, **Amount** and **Method** — press
   **"Request the payment"**.

**Expected (detail)** — reserve movements post to the ledger; the payment is
*requested*, not paid — money out is dual control and clears only when a second
finance controller decides it. **Cover at the loss**, the **Fraud score** and
any **Investigation** referral are shown alongside so the handler decides with
the evidence in view.

**Writes** — `axis_claims`, reserve movements, claim payments, and balanced
`ledger_journal_lines` for every money movement; AI triage, reserve
recommendation and fraud score entries in `ai_audit_log`.

**Coverage** — `apps/api/src/axis-fnol.test.ts`,
`apps/api/src/axis-claim-reserve.test.ts`,
`apps/api/src/axis-claim-payment.test.ts`,
`apps/web/app/routes/fnol-intake.test.ts`,
`apps/web/app/routes/claims-desk.test.ts`,
`apps/web/app/routes/claim-detail.test.ts`. The model behaviour is gated by the
`axis-fnol-triage`, `axis-reserve` and `axis-fraud` evals. **There is no e2e
spec for the claim lifecycle** — it is covered by the manual UAT script in
[`06-test-scripts.md`](./06-test-scripts.md).

---

### UC-28 — Close an accounting period, and close a year

**Actor** `finance.controller` · **Routes**
[`/ledger/period-close`](../../apps/web/app/routes/ledger-periods.tsx),
[`/ledger/year-end`](../../apps/web/app/routes/ledger-year-end.tsx),
[`/ledger/journal`](../../apps/web/app/routes/ledger-journal.tsx),
[`/ledger/reports/trial-balance`](../../apps/web/app/routes/ledger-reports.tsx)

1. Open `/ledger/period-close` and enter the period code (format `2026-07`).
2. Read the **checks** table. Every check reads **OK** or **Fail** with a
   **detail** column. If any check fails, the period is **blocked** and the
   close buttons do not proceed.
3. Press **Soft close** — confirmation: *"Soft close this period? Ordinary
   posting stops; adjustments with a reason still post."*
4. Press **Hard close** — confirmation: *"Hard close this period? Only contra
   entries post afterwards."*
5. **Reopen** is available and is itself confirmed and logged.
6. **"Run the check"** rebuilds balances from the journal and shows any
   **drift** between stored and rebuilt debit/credit totals.
7. Year end: `/ledger/year-end` previews the closing entry into retained
   earnings (account **3100**) before it is posted.

**Expected** — a closed period refuses ordinary postings; the recent-periods
table records **who** closed it and **when**; a drift table appearing at step 6
means stored balances disagree with the journal and is a Sev-1 finance issue,
not a display bug.

**Coverage** — `apps/api/src/ledger.test.ts`,
`apps/web/app/routes/ledger.shared.test.ts`, and
[`e2e/live/ledger-history.spec.ts`](../../e2e/live/ledger-history.spec.ts)
(read-only, against the deployed environment).

---

### UC-29 — Commission settlement run

**Actor** `finance.controller`, twice over · **Routes**
[`/ledger/settlement`](../../apps/web/app/routes/settlement.tsx),
[`/ledger/settlements/:id`](../../apps/web/app/routes/settlement-detail.tsx),
[`/distribution/commission-entries/statement`](../../apps/web/app/routes/commission-statement.tsx),
[`/distribution/commission-entries/:id/clawback`](../../apps/web/app/routes/commission-clawback.tsx)

1. Open `/ledger/settlement`. Runs are listed by month with a state; a new
   month's run starts as **Draft**.
2. Open the run and review its commission entries.
3. Press **Approve**.
4. A **second** finance controller opens `/approvals` and decides the
   **`dist.settlement_run`** request.
5. Clawbacks against individual commission entries are raised from
   `/distribution/commission-entries/:id/clawback`.

**Expected** — step 3 always yields **"Waiting on an approval"** naming
`dist.settlement_run`; there is no amount small enough and no tenant policy
permissive enough to skip it.

**Coverage** — `apps/api/src/settlement.test.ts`,
`apps/web/app/routes/settlement.test.ts`, and
[`e2e/save-desk.spec.ts`](../../e2e/save-desk.spec.ts) `@journey:J-X2`.

---

### UC-30 — Bind a group scheme and earn group commission

**Actor** `axis.lead` · **Route** `POST /v1/axis/policies/:id/bind-group`

1. Bind the group policy through the group-bind route rather than the ordinary
   bind. This is the whole use case: the two routes are different money.
2. The engine
   ([`apps/api/src/engines/group-commission.ts`](../../apps/api/src/engines/group-commission.ts))
   posts a `BIND-GROUP` transaction, crediting income account **4000**.

**Expected** — a balanced `BIND-GROUP` transaction on the policy, under dual
control like any other bind. An ordinary bind posts `BIND` and earns **no** group
commission; a tenant who binds a group scheme the ordinary way has not lost
commission to a bug, they used the wrong route.

A policy with `commissionMinor <= 0` is **rejected with a 400**, not bound
silently at zero: `cannot bind-group with no commission: BIND-GROUP posts a
commission accrual`. The line exists to accrue commission, so a zero-commission
group bind is a data error worth surfacing rather than a no-op worth swallowing.

---

### UC-31 — Charge a broker fee

**Actor** `axis.lead` · **Route** `POST /v1/axis/policies/:id/broker-fee`

Posts `FEE-BROK`: Dr **1160** (receivable), Cr **4020** (fee income). Separate
from commission, separately accounted, and separately disputed by tenants — keep
the two apart when triaging.

---

### UC-32 — Qualify and settle a referral

**Actor** `finance.controller` (holds `dist:commissions:*`) · **Routes**
`POST /v1/dist/referrals/qualify` (`dist:commissions:adjust`), then
`POST /v1/dist/referrals/settle` (`dist:commissions:settle`)

1. **Qualify** the referral. This is a **non-financial** transaction — it records
   that the referral met its criteria and posts no journal lines.
2. **Settle** it. `REFERRAL-SETL` posts Dr **1160** / Cr **4030** via
   [`apps/api/src/engines/referral-settlement.ts`](../../apps/api/src/engines/referral-settlement.ts).

**Expected** — qualification alone moves no money. "The referral qualified but
nothing was paid" is the designed two-step, not a stalled job.

---

### UC-33 — Place an advertisement, with its disclosure

**Actor** `signal.lead` (or `axis.lead` — both hold
`compliance:disclosures:present`) · **Routes**
`POST /v1/compliance/disclosures/present`, then
`POST /v1/ledger/txn/AD-PLACEMENT`

1. Present the disclosure for the subject with `key: "ad_placement"`. This
   inserts a `disclosures` row and posts a non-financial `DISCLOSURE-PRESENT`
   transaction alongside it.
2. Place the ad. `AD-PLACEMENT` posts Dr **1160** / Cr **4070**.

**Expected** — step 1 is **not optional, not once-forever, and subject-specific.**
`AD-PLACEMENT` carries a precondition (`freshAdPlacementDisclosure` in
[`packages/ledger/src/preconditions.ts`](../../packages/ledger/src/preconditions.ts))
that refuses the posting with a 409 unless a matching `disclosures` row exists
for **that** subject, presented within the **last 24 hours**. Absent, stale and
wrong-subject all produce the same message. This is the single most useful thing
to know about the ad revenue line — see
[`04-support-playbook.md` S-20](04-support-playbook.md).

There is no dedicated module route for the placement; it posts through the
generic ledger transaction endpoint.

---

### UC-34 — Quote through a partner (and the bind that is not yet routed)

**Actor** `orbit.partners` · **Route** `POST /v1/orbit/partners/:id/quotes`
(`orbit:partners:read`)

Request a partner pricing quote. Sandbox partners return clearly-marked
synthetic pricing.

**The bind that follows is engine-only.**
[`apps/api/src/engines/partner-bind.ts`](../../apps/api/src/engines/partner-bind.ts)
implements `bindPartner()`, which posts `PARTNER-BIND` (income account **4075** —
distinct from the direct-bind **4000**, so partner-origin revenue is separable in
the ledger without a report-time join) and chains `RSHARE-ACCR` under the same
`parentTxnId` when the revenue share is non-zero. **It has no route yet, by
choice, and its own source says why:** `orbit_partners` has no commission-rate
column, so the engine currently treats the quote's premium as gross commission,
and its receivable account still defaults to `1100` where the sibling revenue
line pairs 4075 with `1160`. Both must be resolved before the engine is exposed.

So there is no user-facing partner-bind flow to test today. A tenant asking where
it is should be told it is unshipped, not investigated as a defect.

---

## 5. Cross-cutting behaviour a tester should expect on every screen

| Behaviour | What you see | Where it comes from |
| --- | --- | --- |
| **AI marker** | Every AI-produced artifact carries a single **✦** and an inspectable "why". | CLAUDE.md §11 / `docs/15` |
| **Ghost text, never modals** | AI drafts appear as ghost text, quiet chips and background drafts. Nothing auto-sends outside the tenant's autonomy policy. | `docs/15` §4 |
| **Brand, not strings** | Product name, logos, accent colours and typeface come from tenant config. A hard-coded "LYRA" on a user-facing screen is a bug. | CLAUDE.md §5, `/settings/brand` |
| **RTL and i18n** | Every string is an i18n key (en, ar). Arabic renders right-to-left with logical CSS properties. Khalid Al Rashed's account is the ready-made RTL test. | CLAUDE.md §7 |
| **Accessibility** | WCAG 2.2 AA: keyboard-reachable interactive elements, visible focus, body-text contrast ≥ 4.5:1. Asserted by axe-core in the e2e suite. | CLAUDE.md §8, [`e2e/a11y.ts`](../../e2e/a11y.ts) |
| **PII masking** | Message bodies and contact details render as `[redacted]` without `core:pii:view`, even for actors with full module access. | `docs/06` §1 |
| **Command palette** | ⌘K opens the same destinations as the module rail. Each workspace carries its own hue. | [`e2e/horizon-shell.spec.ts`](../../e2e/horizon-shell.spec.ts) |
| **Idempotency** | Anything that changes money carries an idempotency key; re-submitting does not double-post. | CLAUDE.md §12, `docs/19` |
| **Domain vocabulary** | Industry nouns come from the active domain pack, never hard-coded, so the same screens sell outside insurance. | CLAUDE.md §14, `docs/21` |

---

## 6. Coverage summary

**23 journeys, all covered.** Every J-ID in
[`docs/06-roles-and-journeys.md`](../06-roles-and-journeys.md) has at least one
`@journey:`-tagged Playwright spec:

| Module | Journeys | Use cases |
| --- | --- | --- |
| AXIS | J-O1, J-O2 | UC-01, UC-02 |
| ORBIT | J-C2, J-C3, J-X1, J-X2, J-X3 | UC-03 – UC-07 |
| SIGNAL | J-M1, J-M2, J-M3 | UC-08 – UC-10 |
| SCOUT | J-P1, J-P2 | UC-11, UC-12 |
| NORTH | J-E1, J-E2, J-E3 | UC-13 – UC-15 |
| Ledger | J-O3 | UC-16 |
| Admin / dev / compliance | J-A1, J-A2, J-A3, J-D1, J-CO1 | UC-17 – UC-21 |
| Public portal | J-C1, J-C4 | UC-22, UC-23 |
| Supporting (no J-ID) | — | UC-24 – UC-29 |
| Revenue lines (no J-ID) | — | UC-30 – UC-34 |

Several journeys are covered **narrower than docs/06's prose** — deliberately,
because the specs test what is built rather than what was imagined. Those gaps
are called out inline above (J-A1 tenant creation, J-E2 distribution and read
receipts, J-D1 webhook tester, J-M3 citation-share trend, J-X3 being API-only,
J-A3's resume note, J-O2's census upload). Read them as scope, not as defects.

**Two caveats on this table as of this revision.**

**The module screens grew faster than this document did.** Roughly thirty new
screens landed across the five modules, along with a unified answer-bar hero on
the module landing pages. The journeys above still pass and still describe the
flows that carry a J-ID, but a tester walking a module top to bottom will meet
screens that have no UC entry here. Treat an unlisted screen as untested-by-name
rather than as new behaviour, and read the module's route directory
([`apps/web/app/routes/`](../../apps/web/app/routes)) as the authoritative list.

**UC-30 – UC-34 are ledger-first use cases.** They are driven through the API
because that is where the revenue lines live; the screens that will drive them
are thinner than the accounting behind them. That asymmetry is deliberate for
now — the money had to be right before the UI was worth building.

**Related:** manual UAT scripts and the automated suite map are in
[`06-test-scripts.md`](./06-test-scripts.md).

# ORBIT — UI design brief

Written for a designer with no access to the repository: everything you need to
redesign these screens is in the prose below. It describes what is **built
today** (2026-08). Every label, permission string, column, threshold and piece of
copy was read out of the source. Nothing here is aspirational; anything specced
but not built is marked **not yet built**, and where a screen is thin the "What
is weak today" section says so rather than inventing the fix. If this file and
the code disagree, the code is the authority and this file is the bug.

---

## Orientation

1. ORBIT is the customer side of LYRA: every conversation the tenant has with a
   customer, and everything a relationship needs between conversations.
2. **Fifteen** record types are browsable as tabs: conversations, messages,
   renewals, journeys, journey runs, partners, partner transactions, handover
   notes, quality scores, channels, teams, team members, routing rules, SLA
   policies, agent presence.
3. On top of those there are **ten hand-built screens**: the conversation
   thread, the journey builder, and eight desks (live console, supervisor wall,
   save desk, renewal pipeline, conversation quality, customer analytics, ORBIT
   admin, developer tools).
4. And there is a **public tier with no session at all** — seven pages a
   stranger reaches from a link or a search result. They are covered in §15 and
   they are the only ORBIT surfaces where the visitor is the customer rather
   than the staff.
5. The nav label is **"Conversations"** (`nav.orbit` / «المحادثات»), not
   "ORBIT" — the module name never appears in the UI.
6. Who lives in it all day: `orbit.agent` (customer desk), `orbit.retention`
   (renewal book), `orbit.partners` (partner desk), `orbit.lead` (queue,
   quality, routing tables). They differ mainly in *write* affordances.
7. Who visits: `tenant.admin` (reads broadly, writes little), `north.exec` /
   `north.analyst` (renewals), `partner.developer` / `partner.manager`
   (partners + partner transactions).
8. Screen that matters most: **the conversation thread**
   (`/orbit/conversations/:id/thread`) — where an AI draft is approved or
   discarded and a reply leaves the tenant. Second: **the live console**
   (`/orbit/console`) — the queue an agent starts the day in. Third: **the
   renewal pipeline** (`/orbit/pipeline`) — the retention book as four stages.
9. Everything that is not one of the ten bespoke screens is generated CRUD: one
   list route and one record route render all fifteen tabs from a declarative
   spec, so a change to the generated pattern (§2) is a change to fifteen
   screens at once.
10. Design constraints that shape everything: messages are immutable; withheld
    affordances are **absent, never disabled**; AI is ghost text and quiet chips
    with a ✦ marker and an inspectable "why" — never a modal, never an auto-send;
    industry nouns come from the tenant's domain pack, so "policy" and "premium"
    are data, not strings you may harden into a design.

---

## Chrome every ORBIT screen sits inside

ORBIT has **its own shell** — it is not the generic workspace chrome. Three
horizontal bands and one vertical rail, all sized from tokens:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ [logo] Product · served-for   [ ⌘K search ] [posture chips] [☾] [✦] [account ▾]│ --chrome-top
├──────────────┬────────────────────────────────────────────────────────────────┤
│ Live console │  Breadcrumbs                                                   │
│ Supervisor…  │                                                                │
│ Save desk    │  <main id="workspace" tabindex="-1">                           │
│ Renewal pipe │                                                                │
│ Conversation │      the screen                                                │
│   quality    │                                                                │
│ Customer     │                                                                │
│   analytics  │                                                                │
│ ORBIT admin  │                                                                │
│ Developer…   │                                                                │
│ --rail-width │                                                                │
├──────────────┴────────────────────────────────────────────────────────────────┤
│ status band — tenant, environment, link to /design                             │ --chrome-status
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Module rail.** Eight destinations, always text-labelled, in this order: Live
  console, Supervisor wall, Save desk, Renewal pipeline, Conversation quality,
  Customer analytics, ORBIT admin, Developer tools. The active item carries a
  4 px accent tick on its leading edge. The rail is *scoped* — it lists only
  `/orbit/*` destinations. It is the same eight for every actor: unlike the
  "Reports and tools" strip inside the workspace (§2), the rail is **not**
  permission-filtered, so an actor can reach a desk whose loader then refuses
  them.
- **Module switcher.** Appears in the top band only when this actor's roles
  reach more than one shell; it is how you leave ORBIT for AXIS, SIGNAL, SCOUT,
  NORTH or the generic workspace.
- **Search palette.** ⌘K / Ctrl-K opens a command palette in the top band.
- **Posture chips.** Small quiet chips in the top band reporting platform
  posture (environment, degradations). Ambient, never modal.
- **Companion toggle.** A ✦ button that opens the AI companion panel. Gated on
  `ai:runs:read` and rendered only at `lg` and wider — below that width the
  companion is unreachable.
- **Theme toggle** (☾) and an **account menu** sit at the trailing end.
- **Skip link** "Skip to content" jumps to `#workspace`; `<main tabIndex={-1}>`
  is re-keyed on every pathname so a route change moves focus honestly.
- **Loading.** After 400 ms of pending navigation the shell renders a page
  skeleton, not a spinner. Below that threshold nothing flashes.
- **Breadcrumbs** sit at the top of the canvas, derived from the path and the
  actor's nav.
- **Status band.** Bottom of the viewport: tenant/environment text and a link to
  `/design`, the design-system playground.
- **View transitions.** Rail navigation uses view transitions; the shell tags
  elements with `lyra-vt-*` classes so header, rail and canvas persist across a
  route change.
- **No Meridian.** The ambient meridian band is NORTH-only by decision; ORBIT
  does not render it.
- ORBIT's accent is `--module-orbit` = **`#37d3b2`** (ion teal). Module accents
  are product identity and are **not** tenant-overridable.
- A tenant may override exactly five custom properties: `--accent`,
  `--accent-hover`, `--accent-contrast`, `--font-display`, `--font-ui`. The font
  is chosen from a three-entry allowlist (`space-grotesk`, `inter`,
  `ibm-plex-sans-arabic`), never interpolated.
- **Access.** The shell's loader refuses the whole module with 403 if the
  session's available shells do not include `orbit`. There is no partial ORBIT.

### Layout tokens

Bands and rail are token-sized, so a redesign changes the token, not the markup:
`--chrome-top`, `--chrome-module`, `--chrome-status`, `--rail-width`,
`--gutter*` (canvas gutters), `--stack-gap` (vertical rhythm between panels),
`--measure-canvas` (the reading measure the canvas is capped to).

### Colour, type and density tokens

Dark-first. `--bg`, `--surface-1/2/3`, `--border`, `--border-strong`, `--text`,
`--text-muted`, `--text-subtle`, `--accent` (vega `#ffb020` dark / `#d98e0b`
light), `--success` (ion `#37d3b2`), `--danger` (flare `#ff5d5d`), `--warning`
(vega), `--info` (photon `#6e9bff`).
Type scale: 12 / 13 / 14 (body) / 16 / 18 / 22 / 28 / 36 / 48. Screen titles are
`font-serif` at 22.
Radii: sm 6, md 10, lg 16, `--radius-orbit: 999px`.
Density: default row 44 px; `[data-density="compact"]` row 34 px — every
generated table renders compact.
Motion: `--duration-fast 150ms`, `--duration-slow 250ms`; reduced motion honoured
globally.

### Components available (`@lyra/ui`)

`Button` (primary / secondary / ghost / danger, default secondary; sizes sm
`h-8 px-3 text-13`, md `h-10 px-4 text-14`, lg `h-11 px-5 text-16`; `loading`
sets `aria-busy` and disables), `ConfirmButton` (a two-tap destructive button —
there is no browser `confirm()` dialog anywhere), `Badge`/`Tag` (tones neutral /
accent / success / danger / warning / info; `dot` renders a 1.5 pill), `Panel`,
`Card`, `Tabs`, `Table` (`stickyHeader`, `density`, `caption`), `EmptyState`,
`Field`, `Input`, `Textarea`, `Select`, `Checkbox`, `DatePicker` (native
`<input type="date">`, supports `calendar="islamic-umalqura"`), `ProgressBar`,
`DateTime`, `Money`, `Popover`, `Ref` (a shortened opaque reference in
`font-mono` with the full value as its tooltip, an em dash when empty),
`StateFlow` / `PostingFlow` (state-machine ribbons).
AI grammar: `AGENT_MARK = "✦"`, `AgentBadge` (mark plus an inspectable "why"
popover), `GhostText`, `ConfidenceMeter`, `EvidenceLink`, `GuardrailNotice`,
`ApprovalStrip`, `BudgetMeter`.
The kit's own chrome is translated: `GhostText` renders "Accept `Tab`" /
"Discard `Esc`" through the kit text catalogue in both `en` and `ar`.

Status words are mapped to the six badge tones by a single shared table, so
`active`, `accepted`, `delivered` read green and `failed`, `lost`, `halted` read
red on every screen without a per-screen decision.

---

## Routes belonging to ORBIT

Ten routes sit **inside the ORBIT shell**:

| Path | Kind |
|---|---|
| `/orbit/conversations/:id/thread` | bespoke — the thread (§1) |
| `/orbit/console` | bespoke — live console (§13.1) |
| `/orbit/supervisor` | bespoke — supervisor wall (§13.2) |
| `/orbit/save` | bespoke — save desk (§13.3) |
| `/orbit/pipeline` | bespoke — renewal pipeline (§13.4) |
| `/orbit/quality` | bespoke — conversation quality (§13.5) |
| `/orbit/analytics` | bespoke — customer analytics (§13.6) |
| `/orbit/admin` | bespoke — routing health (§13.7) |
| `/orbit/dev` | bespoke — developer tools (§13.8) |
| `/orbit/journeys/:id/builder` | bespoke — journey builder (§14) |

Everything else in ORBIT is the **generated pair** under the generic workspace
layout: `/orbit` (falls through to the first tab this actor may read),
`/orbit/:resource` (list) and `/orbit/:resource/:id` (record). Those two routes
render all fifteen tabs from one declarative spec.

Note the shell seam: the ten routes above wear the ORBIT chrome described
above; the generated list and record wear the **generic workspace chrome**.
Moving between `/orbit/conversations` and `/orbit/console` therefore changes the
frame around the canvas. Known rough edge; repeated in the cross-cutting notes.

Separately there are seven **public, session-less** routes (§15) outside every
layout and every shell: `/portal/:tenantSlug`, `/portal/:tenantSlug/privacy`,
`/portal/:tenantSlug/register`, `/portal/:tenantSlug/quotes/:id`,
`/portal/:tenantSlug/partners`, `/portal/:tenantSlug/renewals/:id`,
`/portal/:tenantSlug/feedback/:id`.

---

# 1. Conversation thread — the screen that matters

## Route + title

- Path: `/orbit/conversations/:id/thread`, inside the ORBIT shell.
- `h1` = the customer's name, `font-serif text-22`, falling back to the literal
  **"Conversation"**.
- This screen has **its own bilingual label table** (en + ar) declared in the
  route itself rather than in the shared catalogue. Generic words ("Back to
  list") still come from the platform translator, and industry nouns come from
  the tenant's domain pack.
- Reached from: the **"Open thread"** button on the conversation record screen,
  or a direct URL. It is not a tab and not linked from the generated list.

## Who sees it

Reaching the screen needs `orbit:conversations:read` (plus the ORBIT shell).

| Role key | Reaches it | Sees messages | Reply composer | Assign/Close | Handover panel | QA panel |
|---|---|---|---|---|---|---|
| `orbit.agent` | yes | yes | yes | **no** (lacks `orbit:conversations:assign`) | read + write | read |
| `orbit.lead` | yes | yes | yes | yes | read + write | read |
| `orbit.retention` | yes | yes | yes | no | read only | read |
| `orbit.partners` | yes | yes | **no** | no | read only | read |
| `tenant.admin` | yes (read-only grants) | yes | no | no | read only | read |
| `north.exec`, `north.analyst` | **no** — they hold only `orbit:renewals:read` | — | — | — | — | — |
| everyone else (compliance, axis, finance, scout, signal, dev, provider, customer) | **no** | — | — | — | — | — |

Permission strings this screen reads:

```
reply:         orbit:messages:send
assign:        orbit:conversations:assign
handover:      orbit:handover:read
handoverWrite: orbit:handover:write
qa:            orbit:qa:read
customer:      core:customers:read
audit:         ai:audit:read
```

**What a denied user sees**: the nav item is absent entirely. A direct URL
renders the route error boundary — "This did not load" / **"Your roles do not
include access to this area."**

## Purpose

Read one conversation end to end, decide what an AI has drafted, and reply —
with the delivery status stated honestly at every step.

## Layout skeleton

Single column, one vertical stack, inside the canvas. No split pane, no sticky
composer.

```
┌───────────────────────────────────────────────────────────────┐
│ Back to list                                     text-12 subtle│
│ Rania Haddad                                     font-serif 22 │
│ [WhatsApp] [Human]  cnv_01h…                    badges + mono  │
│ Renewal outreach on CDR-MOT-2501-664118 — already replaced…    │  summary, 13 muted
├───────────────────────────────────────────────────────────────┤
│ [Assign to me]  [Close conversation]        only with :assign  │
├───────────────────────────────────────────────────────────────┤
│ role=status: "Reply queued for delivery. It has not left yet." │
├───────────────────────────────────────────────────────────────┤
│ ╭ Customer context ───────────────────────────── Card, padded ╮│
│ │ Customer      Assigned to    │ 2-col from sm               ││
│ │ Channel       Team           │ each Fact: border-s ps-3    ││
│ │ Intent        Language       │ dt 12 subtle / dd 13        ││
│ │ Sentiment     Satisfaction   │ empty renders "—"           ││
│ │ Started       Last message   │                             ││
│ │ Closed                       │                             ││
│ ╰──────────────────────────────────────────────────────────── ╯│
├───────────────────────────────────────────────────────────────┤
│ Load older messages   ← link, or "This is the start of the…"   │
│ ┌ inbound ───────────────┐                       me-auto      │
│ │ From customer [Customer] 09:41                 max-w-prose  │
│ │ I already bought a new policy…                              │
│ └────────────────────────┘                                    │
│                       ┌──────────── outbound ┐  ms-auto       │
│                       │ To customer [AI agent] 09:05 [Read] ✦ │
│                       │ Hello Rania — your motor cover…       │
│                       └───────────────────────┘               │
├───────────────────────────────────────────────────────────────┤
│ ┏ dashed border ━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Suggested reply ┓│
│ ┃ [✦ Drafted by renewal ▾]  What it was based on  Audit record┃│
│ ┃ Model confidence  ▓▓▓▓▓▓▓░░░  78%                          ┃│
│ ┃ Thank you, Rania — I've closed the renewal on…   ghost text ┃│
│ ┃ Accept [Tab]   Discard [Esc]                                ┃│
│ ┃ [Approve and queue]                                         ┃│
│ ┃ Approving queues these exact words as an AI turn…           ┃│
│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛│
├───────────────────────────────────────────────────────────────┤
│ Reply                                                          │
│ ┌───────────────────────────────────────────────┐ Textarea r=4 │
│ └───────────────────────────────────────────────┘              │
│ Sending a reply leaves the tenant and is recorded in the audit log. │
│ [Send reply]  ← primary, disabled while the box is empty       │
├───────────────────────────────────────────────────────────────┤
│ ╭ Handover notes ──────────────────────────────── Card ───────╮│
│ │ │ Rania re-bought on the web on 8 January…                  ││
│ │ │ Written by: Human agent · Accepted by: Dana Aziz · 09:44  ││
│ │ ── form (only with orbit:handover:write) ──                 ││
│ │ Hand to          [ Choose a colleague or team ▾ ]           ││
│ │ What the next person needs to know [textarea r=3, required] ││
│ │ [Save handover note]                                        ││
│ ╰─────────────────────────────────────────────────────────────╯│
│ ╭ Quality scores ─────────────────────────────── Card ────────╮│
│ │ Rubric: orbit.escalation  [Score: 52]  [Disputed]  09:26    ││
│ ╰─────────────────────────────────────────────────────────────╯│
└───────────────────────────────────────────────────────────────┘
```

## Every element

**Header**

| Element | Label / source | Behaviour |
|---|---|---|
| Back link | "Back to list", `text-12 text-subtle`, underline on hover | to `/orbit/conversations` |
| Title | customer name from the customer record (localised name object, or its first value, or the raw string when masked); else "Conversation" | none |
| Channel badge | WhatsApp / Web / Voice / Email / Agent | tone `neutral`, static |
| State badge | Bot / Human / Closed | tone `accent` unless closed, then `neutral` |
| Id | the conversation id, `font-mono` | selectable text, not a link |
| Summary | the stored summary, 13 muted, prose measure | rendered only when non-null |

**Action row** (only with `orbit:conversations:assign`)

| Button | Label | Variant | Effect |
|---|---|---|---|
| Assign to me | "Assign to me" | secondary sm, **disabled when closed** | resolves the actor server-side, then sets `assigneeRef` to them and `state` to `human`. Taking a conversation also takes it off the bot. |
| Close / Reopen | "Close conversation" / "Reopen conversation" | ghost sm | sets `closed` with a close timestamp, or returns it to `human` and clears it |

**Status lines** (`role="status"`, 13 muted, appear after an action)

- After a send: the *delivery status the row came back with* — "Queued for
  delivery" / "Sent" / "Delivered" / "Read" / "Delivery failed" / "Not
  dispatched". A status this build has never heard of is echoed raw. Reporting
  "sent" for a row that only reached the queue is the one lie this screen must
  not tell.
- "This conversation is now assigned to you and taken off the bot."
- "Conversation closed." / "Conversation reopened and returned to a human."
- "Handover note saved."
- "Draft approved and queued as an AI turn. It has not left yet."

**Customer context card** (title "Customer context"; two columns from `sm`; each
fact is a leading-edge rule with a 12-subtle term over a 13 value; a missing
value renders `—`)

| Term | Value |
|---|---|
| Customer | Name; a **link** to the customer record only with `core:customers:read`, otherwise plain text |
| Assigned to | The assignee's **name**, resolved from the tenant directory; falls back to a shortened `Ref` chip with the full value on hover; "Nobody" when unassigned |
| Channel | translated channel |
| Team | The team's **name**, resolved the same way, else a `Ref` chip |
| Intent | raw string, e.g. `renewal.offer`, `claim.first_notice` |
| Language | raw `en` / `ar` |
| Sentiment | integer −100…100, tabular. **Not** a word, not a colour. |
| Customer satisfaction | integer 1–5, tabular, shown only when given |
| Started / Last message / Closed | date-times at minute precision |

**Thread**

- Paging line above the list: either the link **"Load older messages"** (a URL
  parameter, so the position is shareable and reload-stable) or the sentence
  **"This is the start of the conversation."**
- The loader walks the keyset cursor backwards: 50 per page, at most 10 pages,
  i.e. 500 turns. The list API caps at 200 rows per request regardless.
- The list is `aria-live="polite"` with additions only, so a screen reader is not
  read the archive.
- Each turn:
  - **Direction is derived from the sender role, not stored.** `customer` =
    inbound, `system` = internal, everything else = outbound.
  - Inbound bubbles hug the leading edge, outbound the trailing edge; outbound
    carries an accent-tinted border and a raised surface.
  - Meta line (11 subtle, wraps): direction word ("From customer" / "To
    customer" / "Internal") · role badge (Customer / AI agent / Agent / System;
    an unknown role echoes itself) · time at minute precision · **delivery badge
    on outbound only** (queued = warning, sent = info, delivered = success,
    read = success, failed = danger, none = neutral "Not dispatched") · a ✦
    `AgentBadge` when the turn carries an AI audit id, whose "why" says "An agent
    wrote this turn. The audit record holds the prompt and the evidence." · an
    "Audit record" link, only with `ai:audit:read`.
  - Body: pre-wrapped 13 text.
  - Attachments and redactions are **not rendered** — deliberately deferred until
    a channel actually sends one.

**Draft block** — see AI surfaces below.

**Composer** (only with `orbit:messages:send`)

| Input | Type | Required | Notes |
|---|---|---|---|
| Reply body | textarea, 4 rows, controlled | Send is disabled while it is empty | hint: **"Sending a reply leaves the tenant and is recorded in the audit log."** |
| nonce | hidden | — | sent as the idempotency key; a fresh value after every successful send, so a retry or a double click is free but a genuine second reply is not swallowed |

The send posts `{conversationId, role: "agent_human", content, deliveryStatus:
"queued"}`. **It does not send a timestamp** — the server owns `ts`, and passing
it is rejected as an unknown field.

**Canned replies** (docs/27 F32) sit directly above the composer, shown only
when the reader holds `orbit:messages:send` *and* the macro list came back —
`orbit:macros:read` is fetched with the loader's optional swallow, so an agent
without it gets the whole screen minus the picker. A select of active macros by
name, and one button: **"Send canned reply"**, hint *"Sent in this
conversation's language, word for word, under your name."*

The form posts `{macroKey}` to `POST /v1/orbit/conversations/:id/macro` and
**never the wording**. The API renders the macro in the conversation's own
language and writes it as `agent_human`. An agent who could edit a canned reply
on its way out would make the macro library a suggestion rather than a standard,
which is why the key is the only thing that crosses.

Without the permission the whole form is replaced by one line: **"You do not hold
the permission to reply in this conversation."**

**Handover notes card** (only with `orbit:handover:read` and a successful
sub-fetch)

- Title "Handover notes", newest first.
- Each note: the summary, then a meta line — `Written by: {AI agent|Human agent}
  [· Accepted by: {name}] · {time}`.
- Empty: **"None recorded."**
- Form (only with `orbit:handover:write`): **"Hand to"** is a `Select` of
  colleagues and teams drawn from the tenant directory, placeholder "Choose a
  colleague or team" — not a free-text reference field. Then "What the next
  person needs to know" (textarea, 3 rows, required) and a secondary "Save
  handover note". The author is filled server-side and the note is marked
  written by a human.

**Quality scores card** (only with `orbit:qa:read`)

- Title "Quality scores", newest first.
- Row: `Rubric: {rubricKey}` · badge `Score: {n}` (**success at ≥ 70, else
  warning** — 70 is hard-coded on this screen) · badge "Disputed" (danger) when
  a disputer is recorded · time.
- Empty: **"None recorded."** No scoring form here; scoring happens on the
  generated Quality scores list and on the quality desk (§13.5).

## Table columns

None. This screen has no table.

## Forms

Four posts, discriminated by a hidden intent:

| Intent | Fields | Validation | Effect |
|---|---|---|---|
| reply | body, nonce | empty body is a silent no-op | creates a human turn, queued |
| approve | hidden body (the draft verbatim), hidden AI audit id, nonce keyed to the draft | same empty guard | creates an **AI** turn, queued, keeping the audit id |
| assign / close / reopen | none | none | patches the conversation |
| handover | recipient (optional), summary (required) | empty summary is also a server-side no-op | creates a handover note |

A server error never throws away the actor's input: the page re-renders with the
problem and the typed text intact.

## States

| State | What is shown |
|---|---|
| Loading | every button gets a busy/disabled state. No skeleton, no spinner in the canvas. |
| Not found | error boundary: "This did not load" / "There is nothing at this address." |
| No read permission | error boundary: "Your roles do not include access to this area." |
| **Can read the conversation but not its messages** | a warning `GuardrailNotice` titled "Messages", reason **"You can see this conversation but not its messages."** The header and context card still render. Reading a conversation and reading its messages are separate grants, so this is genuinely reachable. |
| Empty thread | "No messages yet." |
| Side panel refused | the panel is simply absent — a withheld read is an empty panel, not a blank screen. Only 403/404 are swallowed; a real failure still surfaces. |
| Write rejected | an alert strip in danger tone with the server's detail |
| Write rejected **because approval is required** | a warning `GuardrailNotice` titled **"This reply needs approval before it can be sent"** with the server's reason. The API does not gate message creation today, so this path is prepared and currently unreachable. |

## AI surfaces

The module's densest AI surface. Everything obeys the ambient grammar: ✦ once,
ghost text, quiet chips, inspectable "why", no modal, no auto-send.

**Draft detection.** A message is a live suggestion only if it is the **last**
row, its role is `agent_ai`, it has **no delivery status**, and neither its audit
id nor its exact text has already been dispatched by another row. An undispatched
AI row with human turns after it is history, not an offer. The draft is lifted
out of the thread and rendered separately.

**The block** — a labelled section with a **dashed** border, because it is not
yet part of the record.

| Element | Copy | Source |
|---|---|---|
| `AgentBadge` | `✦ Drafted by {agent}` — the agent key, falling back to the word "Assistant". The "Drafted by" prefix is translated. | kit |
| its "why" popover | **"Drafted, not sent. Approve it as it stands, move it into the composer to edit, or discard it."** then `{purpose} · Autonomy: {level}` — seeded as `orbit.renewal.draft_reply · Autonomy: suggest_only` | the AI run behind the draft |
| `EvidenceLink` | trigger and popover both "What it was based on"; body is the raw evidence pretty-printed in mono, focusable and scrollable | the run's evidence |
| Audit link | "Audit record", only with `ai:audit:read` | |
| `ConfidenceMeter` | kit-labelled "Model confidence", the run's confidence as a fraction (seed 78 → 78%), success tone above 0.7 | |
| `GhostText` | the draft body, polite live region, subtle text | |
| Ghost actions | **"Accept `Tab`"** and **"Discard `Esc`"** — translated in both languages | kit |
| Approve button | "Approve and queue", secondary sm, disabled when the conversation is closed | only with `orbit:messages:send` |
| Approve hint | **"Approving queues these exact words as an AI turn and keeps the audit trail with them."** | |

**Behaviour, precisely**

- **Accept** copies the draft into the composer. It sends nothing; the human
  still presses "Send reply".
- **Approve and queue** posts the draft **verbatim** as a new message with the
  role `agent_ai` and the same audit id — who wrote the words does not change
  because a human let them through. Delivery comes back queued, and the
  confirmation says so.
- **Discard** sets local state. **That is all it does.** Messages are immutable
  in the API, so the draft row is never deleted or updated — reload the page and
  the suggestion is back. The only real defence is that once anything has been
  dispatched with the same audit id or the same words, the draft stops counting
  as live.
- History turns that carry an audit id also show a bare ✦ badge, so a past AI
  turn is marked without repeating the whole apparatus.

## Actions and consequences

| Action | Approval gate | Ledger | Reversible |
|---|---|---|---|
| Send reply | Not gated by the API today. The screen renders an approval notice verbatim the moment the API starts answering `approval_required`. An outbound send is doctrinally consequential; the honest current state is "queued, not gated". | no | **No.** Append-only; a sent turn cannot be edited or withdrawn. |
| Approve draft | same | no | **No.** Creates a second permanent row. |
| Discard draft | none | no | Yes, trivially — local state, survives nothing. |
| Assign to me | none | no | Yes. Sets the state to `human` as a side effect. |
| Close / Reopen | none | no | Yes, symmetric pair. |
| Save handover note | none | no | Not from here. The generated handover-notes record can edit and soft-delete it with `orbit:handover:write`. |

## Mobile

The Expo app **does** have a thread: a pocket console at `/j/threads` listing the
conversations a human still owns (bot and human states, newest activity first, 50
rows), each card showing the summary over a "state · channel" line, opening a
per-conversation screen with the transcript and a composer. The mobile reply goes
through the conversation's bound channel connector; the phone never picks a
transport. There is no draft-approval surface, no handover form and no QA panel
on mobile — those are web-only.

## RTL notes

- Bubble sides mirror by construction: logical `me-auto` / `ms-auto`, logical
  padding, logical rules. There are no physical-direction utilities in this
  route, and the design system enforces the same rule inside the kit.
- The direction **word** carries the meaning, not the side: "From customer" /
  "To customer" / "Internal" is written on every bubble, so the thread survives
  monochrome, mirroring and a screen reader.
- Arabic content in an English UI and vice versa is normal here. Message bodies
  inherit the page direction and carry no per-message `dir`, so an Arabic body
  inside an English page renders LTR-first. **Still a live bug for a designer to
  solve.**
- The ✦ mark is direction-neutral; do not mirror it. Mono ids and tabular
  numbers must not be mirrored either.

## What is weak today

1. **Discard is a lie of omission.** It hides a row that is still there. Either
   the UI must say "hidden for you, still on the record", or the platform needs
   a dismissal row. Today a reload undoes the user's decision.
2. **No per-message `dir`.** Arabic bodies in an LTR page and the reverse.
3. **Sentiment is a bare signed integer** (−58, 42, 64) with no scale, no anchor,
   no legend. Satisfaction is a bare 1–5 with no label.
4. **The composer does not stick.** On a long thread you scroll past the whole
   archive to reach the reply box, and the draft block sits between the thread
   and the composer.
5. **No attachment rendering**, though attachments exist as data and as a column
   on the Messages list.
6. **Paging is one-way and coarse.** "Load older messages" fetches 50 more from
   the top each time, capped at 10 pages; there is no jump-to-date.
7. **The 70 threshold on quality scores is invisible.** A 52 and a 66 both render
   warning; the bar is never drawn or named.
8. **Closed conversations still show a live composer.** Only "Assign to me" and
   "Approve and queue" are disabled when the conversation is closed; "Send reply"
   is not.
9. **The intent string is raw.** `renewal.offer` and `claim.first_notice` are
   shown to a human unchanged.

---

# 2. The generated pattern (read once, applies to §3–§12)

Every ORBIT screen that is not one of the ten bespoke routes is produced by two
generic routes — a list and a record — driven by one declarative spec. There is
no per-resource UI code. A designer changing one of these screens is changing all
of them, in every module, unless they propose a bespoke route.

These screens wear the **generic workspace chrome**, not the ORBIT shell.

## List screen anatomy

```
┌──────────────────────────────────────────────────────────────────────┐
│ Conversations                                     font-serif 22      │  ← always the WORKSPACE
│ [Conversations][Messages][Renewals][Journeys][Journey runs]…         │     name, never the tab
│  ↑ h-8 rounded-md px-3 text-13; active = raised surface, medium      │
│ Live console · Supervisor wall · Save desk · Renewal pipeline · …    │  ← "Reports and tools"
├──────────────────────────────────────────────────────────────────────┤
│ [search?] [Select filter] [Select filter] [Live records ▾] [Apply] [Clear] │
├──────────────────────────────────────────────────────────────────────┤
│ ▸ +  New — Conversations            <details>, closed by default     │
├──────────────────────────────────────────────────────────────────────┤
│ Col1 (link) │ Col2 │ Col3 │ … sticky header, compact density         │
│ …rows…                                              inside a Panel   │
│ ────────────────────────────────────────────────────────────────────│
│ 12 shown              Rows per page [50 ▾]      [Previous] [Next]    │
└──────────────────────────────────────────────────────────────────────┘
```

- **The `h1` is the workspace name — "Conversations" — on all fifteen tabs**, in
  `font-serif` at 22. The tab name appears only in the tab strip and the table
  caption. Being on `/orbit/qa-scores` still says "Conversations" at the top.
- The tab strip renders only when the actor can read more than one tab, and lists
  only readable tabs. The four `orbit.*` roles and `tenant.admin` see most or all
  fifteen; `north.*` and `partner.*` see one or two — and with one, the strip
  disappears.
- **The "Reports and tools" strip.** Under the tabs sits a small nav of 12-subtle
  links to the eight bespoke desks: Live console, Supervisor wall, Save desk,
  Renewal pipeline, Conversation quality, Customer analytics, ORBIT admin,
  Developer tools. Each is filtered by the permission its own desk gates on
  (`orbit:conversations:read`, `orbit:presence:read`, `orbit:renewals:read`,
  `orbit:renewals:read`, `orbit:qa:read`, `orbit:conversations:read`,
  `orbit:teams:write`, `orbit:messages:send` respectively), so an actor who would
  only be told no is not offered the door. This is the *only* permission-filtered
  route to those desks — the ORBIT rail is not filtered.
- The filter bar renders only if the tab declares search or filters, or the actor
  can restore deleted rows. Filters are selects whose first option is "All".
  Their option words come from the domain pack, so a tenant can rename "Motor" or
  "Bank". The bar submits as a GET, so filters live in the URL and are
  shareable.
- "Clear" (ghost) appears only when a filter or a search term is set.
- **Deleted view.** `?deleted=1` only, deliberately — a truthy coercion means
  `?deleted=false` would switch it on. A banded warning strip says **"You are
  looking at deleted records. They stay out of the live list until you restore
  them."** with "Back to live records". The live/deleted select and the extra
  "Restore" column appear only when this actor holds the tab's remove
  permission.
- **Create panel.** A `<details>` disclosure labelled `+ New — {tab}`, **not a
  modal**, closed by default, forced open when the last create was rejected.
  Renders only when the tab declares creatable fields *and* the actor holds the
  create permission. Fields with a hint render the hint under the control.
- **Reveal-once.** When a create returns a secret (an API key, a connector
  credential), the screen renders a one-time reveal panel — a titled block, the
  body explaining it will not be shown again, and the value in a mono
  `role="status"` region.
- **Table.** Compact density (34 px rows), sticky header, caption
  `{workspace} — {tab}` (plus "— Deleted" in the deleted view), wrapped in a
  `Panel`. Numeric and money columns right-align. Only columns marked sortable
  have a sort control; using it sets the sort in the URL and drops the cursor.
- **The first column is the only link into the record.** Whole-row click was
  rejected as unreachable from a keyboard. In the deleted view even that is
  plain text.
- **Reference resolution.** Before rendering, the screen collects every
  reference-shaped value on the page and resolves them to names in one batch, so
  an "Owner" column reads *Dana Aziz* rather than `user:us_01KE…`. What does not
  resolve degrades to a shortened mono chip with the full value on hover.
- **Cell rendering.** Null / empty → `—` in subtle; money → a formatted amount
  using its sibling currency column, else a bare tabular number; date → day
  precision, datetime → minute precision; boolean → Yes/No; JSON → mono 11,
  truncated at 60 characters; text marked `badge` → a small dotted badge toned by
  the shared status table; other text truncated at 80 characters.
- **Status tones.** `active` / `done` / `issued` / `settled` / `posted` =
  success; `running` / `review` / `in_progress` = info; `pending` / `blocked` /
  `approval` = warning; `failed` / `rejected` / `cancelled` / `lapsed` = danger;
  `draft` / `open` / `closed` / `intake` = neutral. **Anything not in that table
  is neutral** — which is why many ORBIT badges (`bot`, `human`, `whatsapp`,
  `queued`, `offered`, `scheduled`, `lost`, `halted`, `waiting`) render grey.
- **Footer.** "{count} shown" — the count of rows on *this page*, never a total.
  A "Rows per page" select offers 25 / 50 / 100 / 200 (default 50); changing it
  drops the cursor and returns to the first page. Keyset paging: "Next" follows
  the returned cursor; **"Previous" returns to the first page**, keeping filters.
  There is no cursor stack yet.
- **Empty states.** "Nothing here yet" + "No records match this view. Clear the
  filters, or create the first one."; with filters applied the body becomes "No
  records match these filters."; in the deleted view, "Deleted records" +
  "Nothing has been deleted here."
- **Root redirect.** Landing on `/orbit` with no permission for the first tab
  redirects to the first tab this actor may actually read.

## Record screen anatomy

```
┌──────────────────────────────────────────────────────────────────────┐
│ Back to list                                                          │
│ {first column's value}                             font-serif 22      │
│ Conversations · cnv_01JX…                          12 subtle + mono   │
│ [Open thread]   ← only if the tab declares a record link              │
├──────────────────────────────────────────────────────────────────────┤
│ ╭ dl, 1/2/3 columns, rounded panel ─────────────────────────────────╮ │
│ │ External reference   Customer      Channel                        │ │
│ │ CDR-…                Rania Haddad  WhatsApp                       │ │
│ │ …every declared column, then Created and Updated…                 │ │
│ ╰───────────────────────────────────────────────────────────────────╯ │
├──────────────────────────────────────────────────────────────────────┤
│ ╭ Edit ─────────────────── only with the update permission ─────────╮ │
│ │ [field] [field]                                    2-col from sm  │ │
│ │ [Save changes]                                                    │ │
│ ╰───────────────────────────────────────────────────────────────────╯ │
│ ─────────────────────────────────────────────────────────────────────│
│ [Delete]  ← danger sm, only with remove, two-tap ConfirmButton        │
└──────────────────────────────────────────────────────────────────────┘
```

- The heading is the value of the tab's **first declared column**, run through
  the domain pack's word list where the column is an enumerated one, and falling
  back to a shortened reference when it is opaque.
- Subtitle: `{tab label} · {id in mono}`.
- The detail list shows every declared column plus Created / Updated at minute
  precision. It uses the same cell renderer as the table, so a JSON column is
  still truncated at 60 characters here — the record is **not** a fuller view of
  a JSON column than the list is.
- **The form *is* the record**; there is no separate edit mode. The editable set
  defaults to the creatable set when not declared. An empty string means "not
  supplied", not "clear" — only the JSON editor can express null.
- **Approval gate.** When a write comes back needing approval, the record renders
  a gate block — a gated action is a queued one, not a failure — with a link to
  the approvals queue. A save that succeeds renders a `role="status"` line, the
  tab's own "done" wording where it has one, else "Saved."
- **Delete is soft**, and uses a two-tap `ConfirmButton` reading "Delete this
  record? It is retained for audit and can be restored by an administrator."
  There is no browser dialog.
- No ORBIT tab declares custom actions, so the "Actions" section never renders in
  this module.

---

# 3. Conversations

## Route + title

`/orbit/conversations` (list), `/orbit/conversations/:id` (record). Id prefix
`cnv`. Tab label **"Conversations"** / «المحادثات». The page `h1` is
"Conversations" either way.

## Who sees it

Read `orbit:conversations:read` · create `orbit:conversations:reply` · update
`orbit:conversations:assign` · **no remove**.

- `orbit.agent`: reads, holds reply so **sees the create panel**, lacks assign →
  **no edit form on the record**.
- `orbit.lead`, `orbit.admin`, `platform.admin`: create + edit.
- `orbit.retention`: read + create panel, no edit.
- `orbit.partners`, `tenant.admin`: read only.
- Everyone else: the tab is absent; a direct URL says "Your roles do not include
  access to this area."

## Purpose

The queue: every conversation the tenant is having, newest activity first.

## Table columns

Default sort: last message, descending.

| # | Header | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | External reference | text | start | no | **the link into the record.** Seeded values are channel handles: `wa:971501234567`, `web:sess-2601-0417`, `email:thread-9f21`, `portal:alpha-brokers`, `cc:call-77120` |
| 2 | Customer | text | start | no | resolves to the customer's name where the directory knows it, else a shortened chip |
| 3 | Channel | badge | start | no | WhatsApp / Web / Voice / Email / Agent — all neutral |
| 4 | State | badge | start | no | Bot / Human / Closed (all neutral) |
| 5 | Assignee | text | start | no | resolves to a person's name, else a shortened chip |
| 6 | Intent | text | start | no | raw dotted key: `renewal.offer`, `claim.first_notice`, `quote.compare`, `policy.document`, `partner.settlement`, `renewal.callback`, `coverage.question`, `policy.certificate` |
| 7 | Sentiment | number | end | no | −100…100 |
| 8 | Satisfaction | number | end | no | 1–5, mostly `—` |
| 9 | First response | number | end | no | **raw milliseconds** |
| 10 | Closed | datetime | start | no | |
| 11 | Last message | datetime | start | **yes** | |

Filters: **State** (Bot / Human / Closed) and **Channel** (WhatsApp / Web /
Voice / Email / Agent). No free-text search — the API does not register
conversations as searchable.

## Forms

**Create** (`+ New — Conversations`, needs `orbit:conversations:reply`): Channel
(select, required — whatsapp / web / voice / email / agent), Customer (text),
External reference (text), Language (free text, unvalidated).

**Edit** (record, needs `orbit:conversations:assign` — routing and closing, not
rewriting history): State (select), Assignee (text), Team (text), Summary
(textarea).

There is no client-side validation beyond required fields; error copy is
whatever the API's problem document says.

## States

Standard list/record states from §2. On seeded data the list shows 8 rows, 5 of
which have no messages at all and only a summary — including two Arabic-only
threads and an "Alpha Brokers asking why a bind reversed" partner thread.

## AI surfaces

None on the list or record. The ✦ appears only once you open the thread.

## Actions and consequences

- Editing the state here is a plain patch — it does **not** set the closed
  timestamp the way the thread's Close button does. Two paths to the same column,
  one of which leaves the timestamp behind.
- No approval gate, no ledger, no delete.

## Mobile

The phone reaches conversations two ways: the generic list (tap through to a
generic record) and the bespoke pocket console at `/j/threads` described in §1.

## RTL notes

The tab strip, table and filter bar mirror wholesale; tabular columns keep LTR
digits. The external-reference values (`wa:971501234567`) are LTR strings inside
an RTL row and need `dir="ltr"` on the cell to stop the colon jumping.

## What is weak today

- "First response" prints raw milliseconds (`184000`), not "3m 4s".
- Sentiment, satisfaction and first response are three unlabelled numbers in a
  row — no thresholds, no colour, no units.
- Eleven columns at compact density on a table that has nowhere to put the
  summary — the most useful field on the record is not a column at all.
- No way to reach the thread from the list: you must open the record first, then
  press "Open thread". The live console (§13.1) is the answer to this, but the
  list does not link to it per row.

---

# 4. Messages

## Route + title

`/orbit/messages`, `/orbit/messages/:id`. Id prefix `msg`. Tab label
**"Messages"** / «الرسائل».

## Who sees it

Read `orbit:messages:read` · create `orbit:messages:send` · **no update, no
remove — the resource is immutable in the API**.

All four `orbit.*` roles plus `tenant.admin` read it. `orbit.agent`,
`orbit.lead`, `orbit.retention` and `orbit.admin` also get the create panel;
`orbit.partners` and `tenant.admin` do not. Nobody gets an edit form, ever.

Message text is registered as PII, so masking applies to the body for an actor
without `core:pii:view`.

## Purpose

Every turn in the tenant, across every conversation, as one flat list. Used for
spot checks and delivery-failure sweeps, not for reading a conversation — that is
what the thread is for.

## Table columns

Default sort: timestamp, descending.

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Message | text | **the link into the record**, truncated at 80 characters |
| 2 | Conversation | text | resolves where possible, else a shortened chip |
| 3 | Sender | badge | Customer / AI agent / Agent / System |
| 4 | Modality | text | e.g. `text`, `voice` |
| 5 | Delivery | badge | Queued / Sent / Delivered / Read / Failed |
| 6 | External reference | text | the carrier's own id |
| 7 | When | datetime | **sortable** |
| 8 | Attachments | json | last on purpose: a turn with five files must not push the turn itself off the side of the table |

Filters: **Sender** (Customer / AI agent / Human agent / System) and **Delivery**
(Queued / Sent / Delivered / Read / Failed).

## Forms

**Create** (needs `orbit:messages:send`): Conversation (text, required), Sender
(select, required), Message (textarea, required). The timestamp and the delivery
status are the server's; there is no field for either.

**Edit**: none, ever. A turn that was sent cannot be edited or withdrawn.

## States

Standard. The record screen is a read-only detail list with no edit form and no
delete button — the most stripped record in the module.

## AI surfaces

None here. An AI turn is identified only by its Sender badge reading "AI agent";
the ✦ marker and the "why" live on the thread.

## Actions and consequences

Creating a message from this list posts a turn into a conversation with no
channel context and no draft review. It is a developer-grade affordance sitting
in an operator-grade screen.

## Mobile

Generic list only, reachable by URL; not on any mobile tab.

## RTL notes

Message bodies are mixed-language and carry no per-row `dir` — same defect as the
thread, one row at a time.

## What is weak today

- The create panel here can send a customer-facing turn with none of the thread's
  guardrails.
- Attachments render as truncated JSON.
- There is no link from a message row to its conversation's thread.

---

# 5. Renewals

## Route + title

`/orbit/renewals`, `/orbit/renewals/:id`. Tab label **"Renewals"** /
«التجديدات».

## Who sees it

Read `orbit:renewals:read` · update `orbit:renewals:update` · **no create, no
remove**. A renewal is raised by the expiry sweep, never by hand, so the tab
declares no creatable fields and the create panel never appears.

`orbit.retention`, `orbit.lead`, `orbit.admin` edit. `orbit.agent`,
`orbit.partners`, `tenant.admin`, `north.exec` and `north.analyst` read.

## Purpose

The retention book: everything expiring, soonest first, with the churn score the
model gave it and the strategy a human chose.

## Layout note

Default sort is **expiry ascending** — the only tab in the module that sorts
ascending, because the next thing to expire is the next thing to work.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Policy reference | text | the link into the record; the noun comes from the domain pack |
| 2 | Customer | text | resolved to a name where possible |
| 3 | Expires | date | **sortable**, day precision, ascending by default |
| 4 | Churn risk | number | 0–100, right-aligned, no colour and no threshold |
| 5 | Strategy | badge | Auto re-quote / Human / Do not contact |
| 6 | State | badge | Scheduled / Offered / Accepted / Lost |
| 7 | Offered | datetime | |
| 8 | Decided | datetime | |
| 9 | Owner | text | resolved to a name |
| 10 | Re-quotes | json | every re-quote the sweep gathered; wide, so last |

Filters: **State** and **Strategy**.

## Forms

**Edit** (needs `orbit:renewals:update`): Strategy (select), State (select),
Owner (text), Outcome reason (text).

**The state machine is enforced by the API, not by the form.** Permitted moves
are `scheduled → offered | accepted | lost`, `offered → accepted | lost`, and
nothing at all out of `accepted` or `lost`. An illegal move comes back as an
error reading "a renewal cannot move {from} -> {to}". The select still offers all
four states, so the form lets you ask for a move the server will refuse.

## States

Standard. Empty on a fresh demo because the sweep fills this table, not the seed;
the renewal pipeline (§13.4) has a "Run the sweep" button for exactly that
reason.

## AI surfaces

The churn score is model output but is rendered as a bare number here, with **no
✦ marker and no "why"**. The save desk (§13.3) is where that score is given its
evidence and its marker.

## Actions and consequences

A renewal reaching `accepted` or `lost` is terminal. There is no undo and no
approval gate on the transition.

## Mobile

Yes — a bespoke renewals tab. It lists the two states a phone call can still
change, soonest expiry first, resolves the customer and policy references to
words (a renewal card is otherwise a list of opaque ids), and paints an urgency
edge on the leading side of each card using the same urgency rule as the web
pipeline, so a card is never hot on one surface and calm on the other. It shows
"expires in N days" / "expired N days ago", the state, and the churn score where
one exists. History stages are dropped: a phone gets the two stages a call can
still move.

## RTL notes

Dates mirror; the day/month order is locale-driven. The Islamic calendar is
available to the date picker but this tab renders dates read-only.

## What is weak today

- Churn risk is an uncontextualised 0–100 with no band and no marker, even though
  it is the number the whole tab is sorted around in spirit.
- The state select offers transitions the server rejects.
- "Re-quotes" — the actual money on offer — is truncated JSON.

---

# 6. Journeys

## Route + title

`/orbit/journeys`, `/orbit/journeys/:id`. Tab label **"Journeys"** /
«الرحلات». The record screen carries an **"Open builder"** button to
`/orbit/journeys/:id/builder` (§14).

## Who sees it

Read `orbit:journeys:read` · create / update / remove `orbit:journeys:write`.

## Purpose

The automations that talk to customers between conversations: a keyed, versioned
graph with a lifecycle.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Key | text | the link into the record; a stable slug |
| 2 | Version | number | |
| 3 | Status | badge | Draft / Active / Paused / Retired |
| 4 | Created by | text | resolved to a name |
| 5 | Created | datetime | **sortable** |

Filter: **Status**.

## Forms

**Create**: Key (required), Version (number, required), Name (JSON, required —
the localised name object), Graph (JSON, required).

**Edit**: Status (select) and Graph (JSON).

The JSON editors are a fallback. The real editing surface is the builder (§14),
which is where a designer should send anyone who is not debugging.

## States

Standard.

## AI surfaces

None.

## Actions and consequences

Status is the live switch: an `active` journey is one the scheduler will
actually run. The generated form will set it without any of the builder's
readiness checks — see §14, where activation is blocked until the graph has a
trigger, at least one step, no orphans and a cooldown.

## Mobile

Generic list only.

## RTL notes

Keys and JSON stay LTR inside an RTL page.

## What is weak today

The generated form can activate a journey the builder would refuse to activate.
That is a real inconsistency between two doors onto the same row.

---

# 7. Journey runs

## Route + title

`/orbit/journey-runs`, `/orbit/journey-runs/:id`. Tab label **"Journey runs"** /
«مسارات الرحلة».

## Who sees it

Read `orbit:journeys:read`. **Read-only** — no create, no update, no remove. The
scheduler owns every column.

## Purpose

Where each customer stands inside a graph, and when the runtime will touch them
next.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Journey | text | the link into the record |
| 2 | Customer | text | resolved to a name |
| 3 | Node | text | the step key the run is sitting on |
| 4 | State | badge | Running / Waiting / Done / Halted |
| 5 | Next step | datetime | **sortable**, ascending by default |
| 6 | Updated | datetime | **sortable** |

Filter: **State**. Note the column is **State**, not Status — journeys have a
status, runs have a state, and they are different vocabularies.

## Forms

None.

## States

Standard, minus every write state.

## AI surfaces

None.

## Actions and consequences

None available. A stuck run cannot be halted, retried or re-scheduled from the
UI. **Not yet built.**

## Mobile

Generic list only.

## RTL notes

Nothing specific.

## What is weak today

A read-only view of a runtime you cannot intervene in. The most obvious missing
affordance in the module.

---

# 8. Partners

## Route + title

`/orbit/partners`, `/orbit/partners/:id`. Tab label **"Partners"** /
«الشركاء».

## Who sees it

Read `orbit:partners:read` · create `orbit:partners:create` · **no update and no
remove**. The absence is deliberate: stage, status, sandbox flag and go-live date
belong to the partner lifecycle engine and its `dist.partner_activate` approval,
so a raw edit would let an actor promote themselves straight to live. There is
**no edit form on a partner record**, and there never will be through this
screen.

`orbit.partners`, `orbit.lead`, `orbit.admin` read and create. `partner.manager`
and `partner.developer` read this tab and partner transactions and nothing else
in ORBIT.

## Purpose

The counterparties selling on the tenant's behalf, and where each one stands on
the onboarding ladder.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Name | text | the link into the record |
| 2 | Kind | text | Telco / Motor / Super app / Bank |
| 3 | Onboarding stage | badge | Prospect → Applied → Screening → Diligence → Agreement → Integration → Sandbox → Live |
| 4 | Status | badge | includes Suspended and Terminated |
| 5 | Risk rating | badge | Low / Medium / High |
| 6 | Owner | text | resolved to a name |
| 7 | Country | text | ISO alpha-2 |
| 8 | Sandbox | boolean | Yes / No |
| 9 | Went live | datetime | |
| 10 | Suspended | datetime | |
| 11 | Created | datetime | **sortable** |

**Search is enabled** on this tab — the only ORBIT tab with a free-text search
box, matching on the partner name.

Filters: **Kind** (Telco / Motor / Super app / Bank), **Onboarding stage** (all
eight rungs), **Risk rating** (Low / Medium / High).

## Forms

**Create** (needs `orbit:partners:create`): Name (required), Kind (select,
required), Sandbox (checkbox), Revenue share (JSON), Contact (JSON).
Creating a partner is **gated by the `dist.partner_activate` approval**, so a
create can come back as a queued approval rather than a row — see the gate block
in §2.

**Edit**: none. See above.

## States

Standard, minus every update state.

## AI surfaces

None.

## Actions and consequences

- Creating a partner is an approval-gated write.
- Advancing a partner along the ladder happens on a separate onboarding
  checklist screen at `/onboarding/partners/:ref` (generic workspace chrome, not
  ORBIT chrome), which shows the checklist, the ladder and the agreement side by
  side and whose blocking writes — waiving a required check, signing an
  agreement — come back as approvals. **Nothing in the partner record links to
  it**: today it is reachable only by typing the URL.

## Mobile

Generic list only.

## RTL notes

Country codes and the JSON columns stay LTR.

## What is weak today

- The stage ladder is eight badges in a column with no sense of direction; the
  record shows no progress, no next step and no link to the checklist that
  would.
- **The kind filter and the public partner signup disagree.** Staff can filter on
  Telco / Motor / Super app / Bank; a partner self-registering on the public page
  (§15.5) chooses from Aggregator / Bank / Broker / Retailer / Platform, and the
  API accepts any short free-text kind. A partner who signs up as "aggregator"
  cannot be found by the staff filter.
- Revenue share — the commercial heart of the relationship — is truncated JSON.

---

# 9. Partner transactions

## Route + title

`/orbit/partner-txns`, `/orbit/partner-txns/:id`. Tab label **"Partner
transactions"** / «معاملات الشركاء».

## Who sees it

Read `orbit:partners:read`. **Read-only** — the runtime writes these rows.

## Purpose

What each partner actually did, and what it owes or is owed.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Transaction reference | text | the link into the record |
| 2 | Partner | text | resolved to a name |
| 3 | Kind | text | Quote / Bind / Refund |
| 4 | Amount | money | formatted with the row's own currency column |
| 5 | Partner share | money | same currency |
| 6 | Settlement batch | text | which batch swept it |
| 7 | When | datetime | **sortable**, descending by default |

Filter: **Kind**.

## Forms

None.

## States

Standard, read-only.

## AI surfaces

None.

## Actions and consequences

None. Money moves in the ledger, not here; this tab is the partner-side view of
rows another module posted.

## Mobile

Generic list only.

## RTL notes

Money is formatted per locale and keeps its currency next to the number; do not
mirror the pairing.

## What is weak today

There is no total, no per-partner subtotal and no link to the settlement batch
the row names. Reading "what does this partner get paid this month" is not
possible on this screen.

---

# 10. Handover notes

## Route + title

`/orbit/handover-notes`, `/orbit/handover-notes/:id`. Tab label **"Handover
notes"** / «ملاحظات التسليم».

## Who sees it

Read `orbit:handover:read` · create / update / remove `orbit:handover:write`.

## Purpose

What one person needs the next person to know, whether that person is a human or
was written by an agent.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Summary | text | the link into the record, truncated at 80 characters |
| 2 | Conversation | text | resolved where possible |
| 3 | From | text | resolved to a name |
| 4 | To | text | resolved to a name |
| 5 | Written by | badge | AI / Human |
| 6 | Accepted by | text | resolved to a name |
| 7 | When | datetime | **sortable**, descending |

Filter: **Written by** (AI / Human).

## Forms

**Create**: Conversation (required), From (required), To, Summary (textarea,
required), Facts (JSON).
**Edit**: To, Summary, Accepted by, Facts.

Note the asymmetry with the thread (§1): there, the recipient is a picker of
colleagues and teams; here it is a plain text field expecting a reference.

## States

Standard. Soft delete and restore are available with `orbit:handover:write`.

## AI surfaces

A note written by an agent is marked only by the **"AI"** word in the "Written
by" column — **there is no ✦ marker and no "why" on this screen**, even though
the same information carries both on the thread. That is an ambient-grammar gap,
not a decision.

## Actions and consequences

Editing "Accepted by" is how a handover is acknowledged. Nothing enforces that
the person named is the person acting.

## Mobile

Generic list only.

## RTL notes

Nothing specific beyond the general table rules.

## What is weak today

- The AI-written note has no marker and no evidence.
- "To" is a free-text reference field on a screen that sits next to a thread with
  a proper picker.
- Nothing links a note back to its conversation's thread.

---

# 11. Quality scores

## Route + title

`/orbit/qa-scores`, `/orbit/qa-scores/:id`. Tab label **"Quality scores"** /
«درجات الجودة».

## Who sees it

Read `orbit:qa:read` · create `orbit:qa:score` · **no update, no remove**. A
reviewer scoring a conversation against a rubric and the AI scorer write the same
shape, and **neither may amend a score afterwards**. A correction is a new row.

## Purpose

How well the tenant is answering, rubric by rubric, conversation by
conversation.

## Table columns

| # | Header | Type | Notes |
|---|---|---|---|
| 1 | Rubric | text | the link into the record |
| 2 | Conversation | text | resolved where possible |
| 3 | Score | number | right-aligned, 0–100 |
| 4 | Scored by | text | resolved to a name; an agent scorer reads as a machine reference |
| 5 | Disputed by | text | resolved to a name; empty on most rows |
| 6 | When | datetime | **sortable**, descending |

No filters.

## Forms

**Create** (needs `orbit:qa:score`): Conversation (required), Rubric (required),
Score (number, required), Breakdown (JSON), Flags (JSON).
**Edit**: none.

## States

Standard, minus every update state.

## AI surfaces

None on this screen, though a large share of the rows are agent-written. The
quality desk (§13.5) is where an agent-written score is marked with ✦ and where a
correction is offered as a new row.

## Actions and consequences

A score is permanent. Disputing one is not possible from any screen — the
disputed-by column can be read but never written. **Not yet built.**

## Mobile

Generic list only.

## RTL notes

Scores are tabular and stay LTR.

## What is weak today

- Scores are bare 0–100 with no band. The thread draws its own line at 70; this
  list draws none.
- Breakdown and flags — the reason for the score — are truncated JSON.
- No dispute affordance anywhere.

---

# 12. Routing, knowledge and administration tabs

Nine generated tabs cover the tables the routing engine reads (§12.1–12.6) and
the knowledge the agent answers from (§12.7–12.9). Before the first six existed
a tenant could not see, let alone edit, the roster and rules that decide where a
conversation lands; before the last three, there was nothing to answer a
customer *from* and no record of whether an answer landed. They are plain CRUD,
so they are plain tabs; the ORBIT admin desk (§13.7) is the read on whether they
hang together, not a second editor.

## 12.1 Channels

`/orbit/channel-connectors`. Tab label **"Channels"** / «القنوات».
Read `orbit:channels:read` · create / update / remove `orbit:channels:write`.

Columns: **Name** (the link), **Provider**, **Carries** (badge — WhatsApp /
Email / Web / Voice / Agent), **Status** (badge — Active / Disabled),
**Updated** (sortable).
Filters: **Carries**, **Status**.

Create: Name (required), Provider (select — "WhatsApp Cloud API" or "Mailgun",
required), Carries (select, required), **Credentials** (JSON, required, hint:
*"One JSON object of provider secrets. Stored sealed and never shown again."*),
Settings (JSON).
Edit: Name, Status, Credentials, Settings.

**Credentials are sealed before they reach storage and are never read back** —
which is why there is no credentials column on the list. A designer must never
add one, and must never render a "current value" in the edit form.

Why it matters: a conversation with no channel connector cannot be replied to.
The thread's reply and the supervisor's barge both fail with "conversation has no
channel connector" when this table is empty for that transport.

## 12.2 Teams

`/orbit/teams`. Read `orbit:teams:read` · write `orbit:teams:write`.
Columns: **Key** (the link), **Name**, **Default team** (boolean), **Status**
(badge), **Updated** (sortable). Filter: Status.
Create: Key (required), Name (JSON, required — the localised name), Default team
(checkbox, hint: *"Where a conversation lands when no routing rule matches."*).
Edit: Name, Default team, Status.

## 12.3 Team members

`/orbit/team-members`. Same permissions as Teams.
Columns: **Team** (the link), **Person**, **Skills**, **Concurrent limit**,
**Created** (sortable). No filters.
Create: Team (required), Person (required), Skills (JSON, hint: *"A JSON list of
skill tags, e.g. ["arabic", "claims"]."*), Concurrent limit (number, hint: *"How
many conversations this person may hold at once."*).
Edit: Skills, Concurrent limit.

## 12.4 Routing rules

`/orbit/routing-rules`. Same permissions as Teams. Sorted by **Order**
ascending.
Columns: **Order** (sortable, the link), **Team**, **Conditions**, **Enabled**,
**Updated** (sortable). No filters.
Create/Edit: Order (hint: *"Rules are read in this order and the first match
wins."*), Team, Conditions (JSON, hint: *"A JSON object of channel, intent and
sentimentBelow. Empty matches everything."*), Enabled.

## 12.5 SLA policies

`/orbit/sla-policies`. Same permissions as Teams.
Columns: **Key** (the link), **First reply target**, **Resolution target**,
**Updated** (sortable). No filters.
Create: Key (required), First reply target (number, required, hint: *"Minutes
allowed before the first human or AI reply."*), Resolution target (number,
required).
Edit: both targets.

## 12.6 Agent presence

`/orbit/agent-presence`. Read `orbit:presence:read` · create / update
`orbit:presence:write` · **no remove**.
Columns: **Person** (the link), **Status** (badge — Available / Away /
Offline), **Open now** (number), **Updated** (sortable). Filter: Status.
Create: Person (required), Status (select, required). Edit: Status.

Any agent with the write permission may write **any** presence row — leads
legitimately mark a colleague away, so this is not scoped to self.

## 12.7 Knowledge base

`/orbit/kb-articles`. Read `orbit:kb:read` · create / update / remove
`orbit:kb:write` · publish `orbit:kb:publish`.
Columns: **Key** (the link), **Title**, **Language**, **Status** (badge — Draft
/ Published / Retired), **Updated** (sortable). Filters: Status, Language.
Create: Key (required), Language (select en/ar, required), Title (required),
Answer (textarea, required, hint: *"This is sent to the customer word for word,
so write it as the answer and not as a note to a colleague."*), Tags (JSON).
Edit: Title, Answer, Tags.

**Status is not editable here.** Publishing is what embeds an article into the
search index, so it happens at `POST /v1/orbit/kb/articles/:id/publish` — an
edit form that set the column would publish an article no index has heard of,
which would then be findable only by word match.

One row per (key, language): retrieval is per-language, and an article is
embedded and scored in the language it is written in.

## 12.8 Canned replies

`/orbit/macros`. Read `orbit:macros:read` · create / update / remove
`orbit:macros:write`.
Columns: **Key** (the link), **Name**, **Category**, **Times used** (sortable),
**Status** (badge). Filter: Status.
Create: Key (required), Name (JSON, required), Wording (JSON, required, hint:
*"One wording per language, keyed en and ar. A conversation in a language with
no wording falls back to English."*), Category.
Edit: Name, Wording, Category, Status.

Sent by `POST /v1/orbit/conversations/:id/macro`, which renders the wording in
the conversation's own language and writes it as `agent_human` — a macro is
wording a person chose, and the transcript must not later read as though the
model wrote it.

## 12.9 Self-service answers

`/orbit/deflections`. Read `orbit:conversations:read`. **Read-only** — every
row is written by the deflection engine, because a hand-written row would be a
claim about containment nobody made.
Columns: **Question asked**, **Outcome** (badge — Answered / Passed to a
person), **Score** (sortable), **Found by** (Meaning match / Word match),
**When** (sortable, newest first). Filter: Outcome.

The misses are the point: containment % is a ratio, and a log that only kept
the wins would report 100% forever.

## What is weak across all nine

- An article is written in a plain textarea with no preview of how it will read
  in the channel it is sent through, and no link from a deflection row back to
  the article that answered (or failed to answer) it.
- Six of the nine are edited as raw JSON (team names, skills, rule conditions,
  connector settings, macro names and macro wording). A routing rule is a sentence — "WhatsApp, claims intent,
  sentiment below −40, go to the escalation team" — rendered as a JSON blob.
- Ordering routing rules means typing numbers into a field; there is no drag, no
  move-up, no gap-filling.
- Nothing validates a rule against reality: you can point a rule at a disabled
  team, or set an SLA target no roster can meet, and only the admin desk (§13.7)
  will notice.
- Presence has no "me" affordance — an agent going to lunch edits a row in a
  table.

---

## 13. What is weak across ORBIT, ranked

The module's central problem is that it is **two shells wearing one URL prefix**
(§Routes belonging to ORBIT, §2): the ten bespoke routes carry the ORBIT chrome,
the AI grammar and the desks; the eighteen generated tabs carry the generic
workspace shell instead, and every actor crosses that seam constantly — a lead
opening a conversation from `/orbit/conversations` lands in one frame, then
presses "Open thread" into another. Everything below is ranked by how much of
the module a defect touches, not by the section it happens to sit in.

1. **The module is two chromes, not one.** The ORBIT shell (rail, search
   palette, companion, ✦ grammar) belongs only to the ten bespoke routes; the
   generated list and record for all fifteen tabs render inside the generic
   workspace shell instead. Moving between `/orbit/conversations` and
   `/orbit/console`, or between a generated record and "Open thread", changes
   the frame around the canvas with no visual continuity. This is the single
   largest inconsistency in the module and the doc flags it as a known rough
   edge at the point the routes are introduced.
2. **The module's one consequential action is not actually gated.** Sending a
   reply and approving an AI draft both leave the tenant — the composer's own
   hint says so — but the API does not enforce approval on either write today.
   The screen already renders the warning notice for an `approval_required`
   response; that response never comes. On the screen the doc calls "the
   screen that matters," the human-in-the-loop guarantee is UI-ready and
   API-absent. (§1)
3. **Discard hides a draft, it does not dismiss one.** Messages are
   immutable, so "Discard" is local component state: reload the page and a
   rejected AI draft is offered again as if the human had never seen it. The
   only real backstop is that a draft stops counting as live once its audit id
   or exact words are dispatched some other way. (§1)
4. **Routing configuration is four raw JSON editors with no validation against
   reality.** Connector credentials, team skills and — the one that matters
   most — routing-rule conditions are all free JSON textareas. A rule can name
   a disabled team or demand an SLA no roster can meet, and nothing catches
   it before it silently misroutes every conversation it matches; a rule is a
   sentence ("WhatsApp, claims intent, sentiment below −40, escalate") shown
   as a blob, and reordering the rules that decide where a conversation lands
   means typing numbers into a field. (§12)
5. **Two doors onto the same journey disagree about what's safe to activate.**
   The generated Journeys edit form can flip an automation to Active with none
   of the purpose-built builder's readiness checks (a trigger, at least one
   step, no orphans, a cooldown). Whichever door an editor uses last decides
   whether a customer-facing automation runs unchecked. (§6)
6. **A stuck journey run cannot be touched from any screen.** Journey runs are
   entirely read-only — no halt, no retry, no re-schedule — so a run wedged on
   a bad node stays wedged until someone edits the database directly. (§7)
7. **The renewal state machine is enforced only by the API rejecting you after
   the fact.** The edit form's State select still offers all four states,
   including moves the server refuses (`scheduled → offered | accepted |
   lost`, nothing legal out of `accepted` or `lost`), so the form invites a
   request it knows will fail. (§5)
8. **Related records never link to each other.** A message row has no link to
   its own conversation's thread; a handover note has no link back to the
   thread it was written from; the flagship Conversations list has no link
   into the thread at all — a lead must open the generated record first and
   then press "Open thread" a second time. (§1, §3, §4, §10)
9. **The money that matters most is truncated JSON, three times over.** A
   renewal's actual re-quote offers, a partner's revenue share, and partner
   transactions as a whole (no per-partner subtotal, no total, no link to the
   settlement batch a row names) are all either a mono blob cut at 60
   characters or simply absent as a summary. (§5, §8, §9)
10. **Every score in the module is a bare, unbanded number.** Sentiment
    (−100…100), satisfaction (1–5), quality score (0–100 — the thread
    hard-codes a 70 line the list never draws), and renewal churn risk (0–100,
    the column the retention book is sorted around in spirit) all render as
    plain tabular numbers with no scale, colour or threshold anywhere outside
    the one screen that happens to hard-code its own. (§1, §3, §5, §11)
11. **AI authorship is marked on one screen and erased on three others.** The
    thread's draft carries the full ✦ / "why" / confidence apparatus; the same
    fact is reduced to the bare word "AI" with no marker and no evidence on a
    handover note, and disappears completely from quality scores and the
    renewal churn score, even though both are largely agent-written. This is
    an ambient-grammar gap, not a design decision. (§5, §10, §11)
12. **Staff and the public disagree on what a partner is.** The staff filter
    offers Telco / Motor / Super app / Bank; the public self-registration page
    offers Aggregator / Bank / Broker / Retailer / Platform, and the API
    accepts either as free text — a partner who signs up as "aggregator" is
    invisible to every staff filter. (§8)
13. **The Messages list can send a customer-facing turn with none of the
    thread's guardrails.** Its create panel is a developer-grade write —
    conversation id, sender, body, nothing else — sitting in an
    operator-reachable screen, with no draft review and no delivery-status
    honesty. (§4)
14. **No per-message direction on the module's two densest text surfaces.**
    Neither the thread nor the Messages list carries a per-row `dir`, so an
    Arabic body in an English-directed page (or the reverse) renders
    wrong-handed. Flagged in the thread's own RTL notes as a live bug. (§1,
    §4)
15. **The composer and the close state disagree with each other.** A long
    thread must be scrolled past its whole archive to reach the reply box, and
    a closed conversation disables "Assign to me" and "Approve and queue" but
    leaves "Send reply" live — the one write that should least be possible on
    a closed conversation is the one nothing stops. Attachments, meanwhile,
    exist as data on both screens and render on neither. (§1)
16. **A quality score can never be corrected or disputed from any screen.**
    "Disputed by" is readable everywhere it appears and writable nowhere —
    every scoring mistake is permanent. (§11)
17. **Smaller consistency slips that add up:** "First response" prints raw
    milliseconds instead of a duration (§3); patching a conversation's state
    from the generated form skips the timestamp the thread's own Close button
    sets, so the same column drifts depending on which door was used (§3); and
    agent presence has no "me" affordance, so an agent going to lunch edits a
    row in a table exactly like a lead editing someone else's (§12).

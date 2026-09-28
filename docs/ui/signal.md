# SIGNAL — UI design brief

Screen-by-screen description of what is **actually built today** in the SIGNAL
workspace of LYRA. Nothing here is aspirational. Every label, permission string,
column, error message and seeded value below was read out of the repository. If
a screen is thin, this document says so and says exactly why.

---

## 1. Orientation (read this first)

1. SIGNAL is the marketing and growth workspace. In the sidebar it is called
   **"Marketing"** (`nav.signal`), never "SIGNAL" — the module codename appears
   nowhere in the UI.
2. **SIGNAL is two workspaces wearing one name.** There are nine hand-written
   screens — **Cockpit, Studio, Audience value, Answer engines, Experiments,
   Budget, Analytics, Admin, Developer** — living at `/signal/<name>` inside
   their own module shell; and there are eight generic screens over the raw
   tables — **Audiences, Campaigns, Creatives, Experiments, Budget moves,
   Answer pages, Attribution, Spend** — living at `/signal/<tab>` and
   `/signal/<tab>/:id` inside the ordinary workspace shell. Both are shipped,
   both are reachable, and they do not look alike. §3 says how to tell which one
   you are on.
3. The people who live here: a **growth marketer** (`signal.marketer`) who
   builds audiences, campaigns, creatives and experiments; a **growth lead**
   (`signal.lead`) who additionally launches campaigns, publishes creatives,
   decides experiments and approves/reverses budget moves.
4. Two visitors: a **compliance officer** (`tenant.compliance`) who can only
   read and rule on creatives, and **executives/analysts** (`north.exec`,
   `north.analyst`) who can only read attribution and spend. Neither can open
   any of the nine bespoke screens — see §4b.
5. The unit of work is the **campaign**: an audience is who it reaches,
   creatives are what it says, experiments are what it has not decided yet.
6. **Budget moves, attribution and spend are a ledger, not a workspace** — the
   budget autopilot and the ad platforms write them; a human only reverses a
   budget move inside a 7-day window.
7. Money in SIGNAL is real money. A budget move above the tenant threshold
   (AED 50,000.00) needs a human approval before it takes effect.
8. The three screens that matter most: **Studio** (`/signal/studio` — where a
   campaign is argued, drafted, cleared and launched), **Cockpit**
   (`/signal/cockpit` — what the money bought and what the autopilot did), and
   **Budget** (`/signal/budget` — the ceiling, the headroom and the undo).
9. Everything else supports those three. Attribution and Spend are evidence;
   Answer pages are an owned-content surface; Audiences are inputs; the eight
   generic tabs are the raw rows underneath.
10. **The campaign chain is the spine of the module** and it crosses two
    workspaces. A market opportunity found in SCOUT, or a scenario typed by a
    marketer, becomes a targeting pool with a stated reason per demographic
    band, then a written plan with three costed options and a probability each,
    then drafted content written against the recommended option, then a
    compliance verdict, then an approval-gated launch, then spend and outcome
    on the cockpit. §7.11 walks the whole chain end to end; §7.2 is the screen
    it mostly happens on.

---

## 2. Two hard constraints the design must respect

State both of these to anyone redesigning this module. They are product rules,
not preferences, and no amount of user demand changes them.

> **Hard product refusals, not settings: no fake engagement, no bulk unsolicited
> DMs, no multi-account manipulation. There is no UI for these and there must
> never be.**

Concretely, this means the redesign must not introduce: an engagement/likes/
followers panel, a "warm up accounts" flow, a bulk direct-message composer, a
list of connected personal accounts to rotate between, a follower-growth chart
that implies purchased reach, or any "boost engagement" affordance. These are
not toggles to be defaulted off. They must not exist as pixels. If a designer
asks "where does the DM blast live?", the answer is that it does not and will
not. The channels a person can tick when creating a campaign in the Studio are
exactly nine (`SIGNAL_CHANNELS`): `google_search`, `bing_search`, `meta`,
`instagram`, `youtube`, `email`, `whatsapp`, `sms`, `push` — paid platform
placements plus consented owned channels. The channels the model may name in a
plan are a longer list of fourteen — the same nine plus `tiktok`, `display`,
`radio`, `ooh` and `partner` (`CAMPAIGN_CHANNELS` in
`packages/model-gateway`); a plan option can therefore recommend a channel the
create form does not offer, and the plan card renders the slug it was given.
The channels present in the seeded spend and attribution data are the first
four. There is no channel anywhere in either list that reaches a person who did
not consent.

> **No synthetic likeness of a real person without a stored consent record. The
> seeded video creative records `likeness: none — illustrated brand character`;
> show where a consent record would surface in the UI.**

Today that likeness declaration exists as a key inside `complianceNotesJson` on
one seeded creative:

```json
{
  "likeness": "none — illustrated brand character, no real person depicted or voiced",
  "submittedBy": "…",
  "submittedAt": 0
}
```

and the UI renders it as a 60-character-truncated monospace JSON blob in a
read-only `<dd>` on the creative record page. That is the current state and it
is inadequate. The consent store it *should* point at already exists: the
Administration workspace's **Consents** tab (`GET /v1/core/consents`, permission
`core:consents:read`, immutable, columns `customerId`, `source`, `purposesJson`,
`channelOptinsJson`, `evidenceRef`, `version`, `expiry`, `ts`). `signal.lead`
and `signal.marketer` both hold `core:consents:read` — but the Administration
nav entry is gated on `core:users:read`, which they do not hold, so they cannot
reach it. A redesign must surface, on any creative whose `kind` is
`video_script` or `social`, an explicit likeness row with one of exactly two
states — *no real person depicted* or *consent record `<evidenceRef>`, expires
`<date>`* — linking to the consent record. A creative that depicts a real person
with no linked consent record must not be publishable.

---

## 3. How SIGNAL screens are built — two chromes, one module

SIGNAL is built twice over, and the difference is visible on screen. A designer
must know which of the two they are looking at before commenting on anything.

**Chrome A — the bespoke SIGNAL shell (nine screens).** Hand-written screens,
each designed for one job, inside a module shell of their own with a left rail,
a search palette, a theme toggle, a Companion button and a module switcher.
Composed cards, real charts, money formatted through the `Money` primitive,
buttons that say what they do ("Launch the campaign", "Pause the autopilot"),
✦ marks on every model-written artefact, and a warning panel — not a red bar —
when an action needs an approver.

| URL | Screen | Section |
|---|---|---|
| `/signal/cockpit` | Growth cockpit | §7.1 |
| `/signal/studio` | Campaign studio | §7.2 |
| `/signal/audience-value` | Audiences and value | §7.3 |
| `/signal/answer-engines` | Answer engines | §7.4 |
| `/signal/experiments` | Experiments | §7.5 |
| `/signal/budget` | Budget and bounds | §7.6 |
| `/signal/analytics` | Growth analytics | §7.7 |
| `/signal/admin` | Marketing settings | §7.8 |
| `/signal/dev` | Developer console | §7.9 |
| `/signal/creatives/:id/image` | image byte proxy, no UI | §7.10 |

**Chrome B — the generic workspace (eight tabs, sixteen screens).** The raw
tables, rendered by exactly two generic files:

- `apps/web/app/routes/module.tsx` — every list screen
- `apps/web/app/routes/record.tsx` — every record screen

driven by one data file, `apps/web/app/modules/signal.ts` (a `WorkspaceSpec`:
path, an en+ar label table, eight tab definitions and — new — nine links to the
bespoke screens), against one API registration block in
`apps/api/src/resources.ts` (generic CRUD over the Drizzle tables in
`packages/db/src/schema/signal.ts`). §§8–22 describe these sixteen screens in
full and everything said there still holds.

**How the two are joined.** Beneath the tab strip on every generic SIGNAL
screen, `module.tsx` renders a second, quieter nav — `<nav aria-label="Reports">`
of small underlined `text-12 text-subtle` links — one per bespoke screen the
actor has permission for. That row is the only pointer from the raw tables to
the designed screens. There is no pointer the other way except the individual
links each bespoke screen chooses to render (Cockpit → Budget, Analytics →
Cockpit and Budget, Studio → a campaign's own studio URL).

**Naming collision to know about.** The bespoke experiments screen is
`/signal/experiments`; the generic experiments *tab* had to move out of its way
and lives at **`/signal/signal-experiments`** (tab key `signal-experiments`).
Both exist, both list experiments, and they look nothing alike.

Consequences of Chrome B a designer must internalise (none of these apply to
Chrome A):

- Every list is the same list: `<h1>` + tab strip + filter bar + optional
  create disclosure + one table + a two-button pager.
- Every record is the same record: back link + `<h1>` + a `<dl>` of every
  column + an edit form of the editable fields + (rarely) a delete button.
- **JSON columns are raw textareas.** `budgetJson`, `channelsJson`,
  `definitionJson`, `variantsJson`, `resultJson`, `complianceNotesJson`,
  `citationsCheckJson` are all `<textarea rows=6 class="font-mono text-12">`
  containing literal JSON. A marketer edits a campaign budget by typing JSON.
- **`contentRef` is a plain text string**, e.g.
  `signal/creatives/motor-search/en-a.json`,
  `signal/creatives/renewal-nudge/ar-email.mjml`,
  `signal/creatives/summer-travel/en-script.md`. Nothing on the generic
  screens renders the creative — no preview, no thumbnail, no copy of the ad
  text. (The Studio does render draft content, its brand-frame preview and its
  generated images; see §7.2.)
- Two schema columns are written but **never rendered at all**:
  `signal_campaigns.guardrailChecksJson` (frequency cap, quiet hours,
  suppression audience applied, brand-kit pass, banned-claims pass) and
  `signal_aeo_pages.citedByJson` (which answer engines cite the page).
  `signal_creatives.aiAuditId`, `signal_attribution_events.anonId` and
  `signal_attribution_events.creativeId` are likewise invisible.

Enumerating the concrete columns and fields anyway is the whole point of the
rest of this document.

---

## 4a. Shared chrome on the sixteen generic screens

**Route tree** (`apps/web/app/routes.ts`): the generic SIGNAL screens sit inside
`layout("routes/workspace.tsx")`, which also owns `/approvals`. The nine
bespoke screens sit inside a second layout, `layout("routes/signal-shell.tsx")`
— see §4b.

| Pattern | File | SIGNAL instances |
|---|---|---|
| `/:module` | `routes/module.tsx` | `/signal` |
| `/:module/:resource` | `routes/module.tsx` | 8 list screens |
| `/:module/:resource/:id` | `routes/record.tsx` | 8 record screens |

**Shell** (`apps/web/app/components/shell.tsx`):

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [brand mark + tenant name]        Signed in as {name}  Settings  Sign out│ h-14, sticky
├────────────┬─────────────────────────────────────────────────────────────┤
│ ● Home     │                                                             │
│ ● Operations│                   main content                             │
│ ● Conversations│                (max-width container, gap-6 column)      │
│ ●▪ Marketing│                                                            │
│ ● Market   │                                                             │
│ ● Insight  │                                                             │
│ ● Ledger   │                                                             │
│ ● Analytics│                                                             │
│  md:w-60   │                                                             │
└────────────┴─────────────────────────────────────────────────────────────┘
```

- Sidebar `md:w-60`, always text-labelled (never icon-only); below `md` it
  collapses to a horizontally scrollable strip above the content.
- Each nav item shows a 1.5-unit `aria-hidden` accent dot before the label.
  SIGNAL's is `--module-signal: #ff7a45` (also `--chart-3`). On the generic
  screens this orange dot is the *only* module-colour signal — headers, tabs,
  buttons and badges all use the tenant accent, not the module accent. The
  bespoke shell inverts that: it makes `--module-signal` its working accent
  throughout (§4b).
- Tenant branding overrides `--accent` / `--accent-hover` / `--accent-contrast`
  and `--font-display` / `--font-ui` from tenant config. Seeded tenant GONXT:
  accent `#5B8CFF`, hover `#7FA6FF`, contrast `#070b14`, font `space-grotesk`,
  locales `["en","ar"]`, currency `AED`, domain pack `insurance-gulf`.
- Header strings: `header.signedInAs` "Signed in as {name}",
  `header.settings` "Settings", `header.signOut` "Sign out".

**Nav gating trap.** The sidebar entry is
`{ labelKey: "nav.signal", href: "/signal", icon: "megaphone", permission: "signal:campaigns:read" }`
(`apps/api/src/routes/me.ts`). It is gated on **campaigns read alone**. So
`tenant.compliance` (creatives only) and `north.exec` / `north.analyst`
(attribution + spend only) hold real SIGNAL read permissions **and have no way
to navigate to SIGNAL at all**. They must be given a URL by a colleague. It
still points at `/signal`, i.e. at the generic tabs, never at the cockpit.

**Table** (`packages/ui/src/data.tsx`): wrapper
`overflow-auto rounded-lg border border-border`; `<caption>` is `sr-only` and
reads `"Marketing — {Tab}"`; `<th>` is `uppercase tracking-wider text-11
text-subtle`, `text-end` when numeric; sortable headers are `<button>`s showing
`↕` idle, `▲`/`▼` active, with `aria-sort`; compact density = `px-2.5 py-1.5`
cells; sticky header on.

**Cell rendering** (`apps/web/app/components/fields.tsx`):

- `null` / `undefined` / `""` → `<span class="text-subtle">—</span>`
- `money` → localised currency from the sibling `currency` column; **with no
  currency it degrades to a bare number** (the `Money` primitive refuses to
  invent one)
- `json` → `font-mono text-11 text-subtle`, **truncated at 60 characters**
- `text` → truncated at 80 characters
- `datetime` → `<DateTime precision="minute">` in the actor's locale
- `badge: true` → a tone-coloured chip

**Badge tones** — this matters, because most SIGNAL states fall through:

| Tone | Values that hit it in SIGNAL |
|---|---|
| success (green) | `live` |
| info (blue) | `running`, `review` |
| warning (amber) | `pending`, `blocked` |
| danger (red) | *(none in SIGNAL)* |
| neutral (grey) | `draft`, `open`, **and everything unmatched**: `scheduled`, `paused`, `ended`, `passed`, `flagged`, `human`, `ai`, `manual`, `hourly`, `daily`, `concluded`, `abandoned`, `published`, `stale`, `retired`, `impression`, `click`, `visit`, `lead`, `bind`, `api`, `import` |

So **`blocked` and `pending` share the same amber**, `passed` and `flagged` are
both the same grey, and a `bind` worth AED 4,480 is styled exactly like an
`impression`. This is the single biggest visual defect in the module.

**Empty state** (`EmptyState`): dashed border, `p-10`, centred, a thin-line
`ConstellationArt` SVG with one accent dot, `font-display text-16` title,
`text-13 text-subtle` body.

**Error alert** (`Problem`): `role="alert"`, `rounded-md border
border-danger/40 bg-danger/10 p-3`, one line of `text-13`, rendering
`problem.detail ?? problem.title`.

**Pagination**: keyset, forward-only. Footer row: `{count} shown` on the start
side, `Previous` (only when a cursor is set; it simply drops the cursor and
returns to page 1) and `Next` (only when the API returned one) on the end side.
Default page size 50.

**Route-level errors** (`root.tsx` ErrorBoundary): `<h1 class="font-display
text-28">This did not load</h1>`, then one of `error.notFound` /
`error.forbidden` / `error.unauthorized` / `error.generic`, the request id as
`Reference {id}` in `font-mono text-12 text-muted`, and a **Try again** button.

---

## 4b. The SIGNAL shell (chrome on the nine bespoke screens)

`apps/web/app/components/signal-shell.tsx`, entered through the route layout
`apps/web/app/routes/signal-shell.tsx`. This is a different room from §4a: it
has its own header band, its own rail, its own footer, and none of the generic
tab strip or filter bar.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [brand lockup] {tenant name}   [search] [posture chips] [☾] [✦] [account]│ h-[var(--chrome-top)]
├──────────┬───────────────────────────────────────────────────────────────┤
│▌Cockpit  │ ──────────────────────────────────────────────── 0.5px accent │
│ Studio   │ Marketing › Campaign studio                      (breadcrumbs)│
│ Audience │                                                               │
│  value   │                    main content, #workspace                   │
│ Answer   │                    (cards in a gap-6 column)                  │
│  engines │                                                               │
│ Experi…  │                                                               │
│ Budget   │                                                               │
│ Analytics│                                                               │
│ Admin    │                                                               │
│ Dev      │                                                               │
│ [modules]│                                                               │
├──────────┴───────────────────────────────────────────────────────────────┤
│ footer · Design doctrine                                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Accent.** The whole shell sets its working accent to
  `var(--module-signal)` — the orange `#ff7a45`. Inside these nine screens the
  accent bar, the active rail marker, the primary buttons, the badges and the
  chart lines are SIGNAL orange, not the tenant blue. This is the single
  clearest way to tell Chrome A from Chrome B at a glance.
- **Rail.** Nine items, in the order listed in §3, each linking to its
  `/signal/<name>` URL. The active item carries a 4px accent bar on its inline
  start edge. The rail is compiled into the shell (a constant list of nine
  paths), **not** read from `session.nav` — so it does not shrink for an actor
  with fewer permissions; the screen behind the link enforces permission
  instead. Below `md` the rail collapses into a horizontal band that also
  carries the module switcher.
- **Header.** Brand lockup linking to `/signal/cockpit`; the tenant's served
  name; a **search palette** whose entries are the nine rail destinations;
  **posture chips** (the environment/health chips shared across shells); a
  theme toggle; a **✦ Companion** button, rendered only for an actor holding
  `ai:runs:read`; and an account menu.
- **Module switcher** appears twice — once in the mobile band, once at the foot
  of the desktop rail — with SIGNAL marked as current.
- **Main region** is `<main id="workspace" tabIndex={-1}>`, reached by a skip
  link, opening with a 0.5px accent rule, then breadcrumbs, then the screen.
- **Slow loads** show a `PageSkeleton` once a navigation passes 400 ms — the
  generic screens have no such treatment.
- **Toasts.** The shell installs a toast provider; bespoke screens use it for
  post-action confirmation instead of the generic screens' silence.
- **Cold open** animation on first paint.
- **Footer** carries a link to `/design`, the design-system playground.

**Who is allowed inside — the hard gate.** The shell's own loader checks
`session.availableShells` and throws a bare **403** when `"signal"` is missing.
That list is derived from role names (`availableShellsForRoles`): a role's
prefix picks its workspace, `tenant.*` / `platform.*` / `dev.*` map to the
admin shell, `tenant.compliance` maps to the compliance shell, and only
`signal.*` roles map to `"signal"`.

Consequences, and they are severe:

- `signal.marketer`, `signal.lead`, `signal.admin` — all nine screens open.
- **`tenant.admin`, `tenant.compliance`, `north.exec`, `north.analyst` get a
  403 on every one of the nine**, even though they hold the underlying read
  permissions and can see the same data through the generic tabs. A compliance
  officer cannot open the Studio to look at the draft they are ruling on. An
  executive cannot open the cockpit or the analytics screen, which are the two
  screens written for an executive.
- Because the "Reports" link row under the tab strip is filtered by
  *permission*, not by shell entitlement, those actors are **offered links they
  will be 403'd on**. Clicking "Growth cockpit" as a `tenant.admin` produces a
  full-page error boundary.

**Refusals in this chrome.** Every bespoke screen renders action failures
through one shared component, `Gate`:

- A 403 whose code is `approval_required` renders as a **warning panel**
  (`role="status"`, warning border and 8 %-tint fill) reading
  **"Waiting for an approver"** / *"This change needs a second pair of eyes
  under policy {policy}. It is queued, not lost."* with an **"Open approvals"**
  link to `/approvals`.
- Everything else renders as the red `Problem` bar of §4a — but the message has
  first been through `explain()`, which swaps a machine code for a written
  sentence from the module's own label table (about thirty of them, e.g.
  `name_required` → a sentence, not the token). Locally-detected refusals never
  reach the API at all: the screen returns a 400 with a code and `explain()`
  turns it into the sentence.

This is the opposite of the generic screens' behaviour (§6), and it is the
single largest behavioural difference between the two chromes.

---

## 5. Who sees what (role × tab matrix)

Read permissions per tab. `signal.marketer` and `signal.lead` are the only roles
that see the whole workspace.

| Tab | read permission | marketer | lead | signal.admin | tenant.admin | tenant.compliance | north.exec / north.analyst |
|---|---|---|---|---|---|---|---|
| Audiences | `signal:audiences:read` | ✓ | ✓ | ✓ | ✓ (read) | — | — |
| Campaigns | `signal:campaigns:read` | ✓ | ✓ | ✓ | ✓ (read) | — | — |
| Creatives | `signal:creatives:read` | ✓ | ✓ | ✓ | ✓ (read) | ✓ | — |
| Experiments | `signal:experiments:read` | ✓ | ✓ | ✓ | ✓ (read) | — | — |
| Budget moves | `signal:budget_moves:read` | ✓ | ✓ | ✓ | ✓ (read) | — | — |
| Answer pages | `signal:aeo:read` | ✓ | ✓ | ✓ | ✓ (read) | — | — |
| Attribution | `signal:attribution:read` | ✓ | ✓ | ✓ | ✓ (read) | — | ✓ |
| Spend | `signal:spend:read` | ✓ | ✓ | ✓ | ✓ (read) | — | ✓ |

**Roles with no SIGNAL permission whatsoever** (`/signal` is a hard 403 for
them, and no nav entry appears): `axis.lead`, `axis.agent`, `orbit.agent`,
`orbit.partners`, `orbit.retention`, `scout.lead`, `finance.controller`,
`finance.analyst`, `dev.admin`.

**The nine bespoke screens have a second, coarser gate on top of all of this.**
Permission is necessary but not sufficient: the actor's role must also resolve
to the SIGNAL *shell*, which only `signal.*` roles do (§4b). The matrix above
therefore describes the generic tabs only. For the bespoke screens the matrix
is one column wide:

| Screen | permission the screen checks | marketer | lead | signal.admin | everyone else |
|---|---|---|---|---|---|
| Cockpit | `signal:spend:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Studio | `signal:campaigns:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Audience value | `signal:audiences:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Answer engines | `signal:aeo:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Experiments | `signal:experiments:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Budget | `signal:budget_moves:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Analytics | `signal:spend:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Admin | `signal:campaigns:read` | ✓ | ✓ | ✓ | 403 at the shell |
| Developer | `signal:spend:read` | ✓ | ✓ | ✓ | 403 at the shell |

Within those screens, individual controls are withheld by permission the same
way the generic screens withhold forms — with one difference: a bespoke screen
sometimes renders the control **disabled** with the note *"Your role does not
include this view."* beside it, rather than omitting it. That contradicts the
generic rule below and is a real inconsistency, not a reading error.

Write permissions:

| Action | permission | who holds it |
|---|---|---|
| create/update audience | `signal:audiences:create` | marketer, lead, signal.admin |
| create campaign | `signal:campaigns:create` | marketer, lead, signal.admin |
| update campaign | `signal:campaigns:update` | marketer, lead, signal.admin |
| create creative | `signal:creatives:generate` | marketer, lead, signal.admin |
| update creative | `signal:creatives:approve` | lead, signal.admin, **tenant.compliance** |
| create experiment | `signal:experiments:create` | marketer, lead, signal.admin |
| update experiment | `signal:experiments:decide` | lead, signal.admin |
| update budget move (reverse) | `signal:budget_moves:approve` | lead, signal.admin |
| create/update/delete answer page | `signal:aeo:write` | marketer, lead, signal.admin |
| attribution, spend | read only for everyone | — |

**Withholding is absence, not disablement.** A tab the actor cannot read is not
in the tab strip. A create form they cannot submit is not rendered. An edit form
they cannot save is not rendered. There are no greyed-out buttons anywhere in
SIGNAL; keep it that way.

**Denied-user experience.** Two distinct outcomes:

- Actor holds *some* SIGNAL tab but not the first one: hitting bare `/signal`
  403s, and the loader silently `redirect`s them to their first readable tab.
  They never see an error.
- Actor holds *no* SIGNAL tab, or lands directly on a tab they cannot read
  (`/signal/campaigns` as a compliance officer): full-page error boundary —
  **"This did not load" / "Your roles do not include access to this area." /
  Reference {id} / Try again**.

---

## 6. The approval gate (what makes SIGNAL consequential)

`packages/core/src/approvals.ts` defines six SIGNAL policies:

| policy key | decide permission | dual control | threshold |
|---|---|---|---|
| `signal.budget_move` | `signal:budget_moves:approve` | never | — |
| `signal.campaign_launch` | `signal:campaigns:launch` | never | — |
| `signal.creative_publish` | `signal:creatives:approve` | never | — |
| **`signal.budget_commit`** | `signal:campaigns:launch` | above_threshold | `defaultThresholdMinor: 50_000_00` |
| `signal.boost` | `signal:campaigns:update` | — | — |
| `signal.creator_brief` | `signal:creatives:approve` | — | — |

The seeded tenant carries an explicit threshold row for `signal.budget_commit`:
`{"amountMinor": 5000000, "currency": "AED"}` — **AED 50,000.00**, dual control
off, effective from 120 days ago. Above that number a budget commitment needs
two people; the policy record is the only place that number lives today and it
is **never displayed in any SIGNAL screen**.

Which SIGNAL writes are wired to a gate (`apps/api/src/resources.ts`):

- `PATCH /v1/signal/campaigns/:id` → `signal.campaign_launch`, **no amount
  field**. The seeded tenant's `policy.autoApprove` contains
  `"signal.campaign_launch"`, so in the demo tenant campaign edits (including
  `state: "live"`) pass straight through and only write a
  `core.approval.auto` audit entry.
- `PATCH /v1/signal/creatives/:id` → `signal.creative_publish`. **Not
  auto-approved.** Every creative edit is gated.
- `PATCH /v1/signal/budget-moves/:id` → `signal.budget_move`,
  `amountField: "amountMinor"`. **Not auto-approved.**

**What the gate does to the UI — and it depends on which chrome you are in.**
`gate()` writes a `pending` approval row and then throws HTTP 403
`approval_required` whose `detail` is the bare policy key.

*On the sixteen generic screens*, `Problem` renders `problem.detail ??
problem.title`, so the user's whole feedback for a blocked save is a red bar
reading, literally:

```
signal.creative_publish
```

No sentence, no link to the approval, no mention that a request was raised on
their behalf. The record stays as it was, their form values stay on screen. To
proceed they must navigate to `/approvals`, find the request, decide it, come
back and press Save again — within the 24-hour approval TTL
(`APPROVAL_TTL_MS`), after which the approval goes stale and a fresh one is
raised. A rejected request also blocks re-submission for 24 hours with the same
opaque red bar. **This remains the highest-value fix on the generic screens.**

*On the nine bespoke screens*, the same 403 renders as the `Gate` warning panel
described in §4b: **"Waiting for an approver"**, *"This change needs a second
pair of eyes under policy {policy}. It is queued, not lost."*, and an **"Open
approvals"** link. Same 403, same policy key, three sentences and a way out.
The pattern the generic screens need already exists in the codebase; it simply
was never wired into `record.tsx`.

---

## 7. `/signal` — workspace entry

**Route + title.** Path `/signal`. Rendered by `routes/module.tsx` with no
`:resource` param, so `tabOf(spec, undefined)` returns the **first** tab and the
screen is identical to `/signal/audiences` — except that the URL stays `/signal`
while every tab link points at `/signal/<key>`. Page title (`<h1>`) is
`t("nav.signal")` = **"Marketing"** on this and every SIGNAL screen.

**Who sees it.** Anyone with `signal:audiences:read` gets the Audiences list at
this URL. Anyone with another SIGNAL read but not that one is redirected to
their first readable tab (compliance officer → `/signal/creatives`; north roles
→ `/signal/attribution-events`). Anyone with no SIGNAL read gets the full-page
"Your roles do not include access to this area."

**Purpose.** It is not a landing page. It is the first readable tab wearing a
shorter URL — plus, beneath the tab strip, the row of "Reports" links that is
the only signposted way into the nine designed screens:

| Link label | Destination | Link permission |
|---|---|---|
| Growth cockpit | `/signal/cockpit` | `signal:spend:read` |
| Campaign studio | `/signal/studio` | `signal:campaigns:read` |
| Audiences and value | `/signal/audience-value` | `signal:audiences:read` |
| Answer engines | `/signal/answer-engines` | `signal:aeo:read` |
| Experiments | `/signal/experiments` | `signal:experiments:read` |
| Budget and bounds | `/signal/budget` | `signal:budget_moves:read` |
| Growth analytics | `/signal/analytics` | `signal:spend:read` |
| Marketing settings | `/signal/admin` | `signal:campaigns:read` |
| Developer console | `/signal/dev` | `signal:spend:read` |

**What is weak today.** `/signal` still has no overview of its own — no
spend-to-date, no live campaign count, no pending approvals badge. The module's
overview screen exists (`/signal/cockpit`) but the module's front door does not
open onto it; it opens onto a list of audience definitions with nine small grey
links underneath. The nine links are also gated on permission rather than on
shell entitlement, so a `tenant.admin` is offered every one of them and 403s on
every one (§4b). A redesign should either redirect `/signal` to the cockpit for
actors who can open it, or promote those nine links from 12px grey text to the
navigation they actually are.

---

## 7.1 `/signal/cockpit` — Growth cockpit

**Route + shell.** `/signal/cockpit`, bespoke shell (§4b). Breadcrumb
*Marketing › Growth cockpit*.

**Who sees it.** SIGNAL shell entitlement + `signal:spend:read`.

**Purpose.** Two questions on one screen: what the money bought this window, and
what the autopilot changed while nobody was watching. Title *"Growth cockpit"*,
lede *"What the money bought this window, and what the agents changed while you
were away."*

**Window control.** A `<nav>` of three badges — **7 days / 30 days / 90 days** —
linking to `?days=7|30|90`, the current one accented and carrying
`aria-current="page"`. Everything on the screen re-reads against that window.
An unrecognised `?days` value falls back to the default rather than erroring.

**Loader.** Five reads in parallel, each individually fault-tolerant: spend,
attribution events, campaigns, budget moves, and the actor's own policy record
(for the autopilot's paused flag). A read that fails yields an empty list, so
one dead endpoint costs one card, not the page.

**Headline.** The `<h1>` is not a fixed string: it is computed from the numbers
and states one of four answers about the window (cost per acquisition, spend
against plan, whether anything is live at all, or that there is nothing to
report yet). A designer should treat the `<h1>` as a sentence that changes.

**Cards, in order.**

1. **KPI wall** — Spend, Plan, Signed (binds) and Cost per acquisition for the
   window. Money renders through `Money`; a figure with no data reads *"Not
   enough data yet"* rather than `0`.
2. **Pacing bar** — spend against plan as a `ProgressBar`, **danger** tone above
   100 %, **warning** above 80 %, accent below.
3. **Trend sparkline** — daily spend. Rendered only when there are at least two
   points; a single day draws nothing rather than a flat line.
4. **Pipeline by channel** — a table of channel / spend / impressions / clicks /
   conversions / signed. This is the same table definition the Studio uses for
   one campaign, so the columns match between the two screens.
5. **Running now** — the live campaigns, each linking to
   `/signal/studio?campaignId=…`. This is the only cross-link from the cockpit
   into the studio.
6. **What the agents changed** — the budget moves in the window: when, `from →
   to` (rendered as two channel endpoints either side of an arrow that flips
   direction with the locale), amount, the reason sentence, and a "Moved by"
   badge reading either **"Needed an approver"** (info) or **"Inside its
   bounds"** (accent). Empty state when the autopilot has done nothing.
7. **Autopilot** — see below.

**Autopilot card.** Three controls, each permission-gated and each a POST:

| Control | Permission | Effect |
|---|---|---|
| Pause the autopilot | `signal:autopilot:pause` | tenant policy flag on |
| Resume the autopilot | same | flag off |
| Look for a move now | `signal:autopilot:run` | one sweep, immediately |

After a run the card reports **"The autopilot made {n} move(s)."** The card
carries an inspectable **why**: *"The autopilot compares cost per acquisition
across channels over the last seven days and moves budget toward the cheaper
one, inside each campaign's per-move ceiling."* — plus an evidence link to the
module's own documentation. An actor without the permissions sees the card
without the buttons.

**AI surfaces.** The autopilot explanation above is the ✦ "why" for the moves
listed in card 6. The moves themselves are shown with the "Needed an approver" /
"Inside its bounds" badge rather than a ✦ mark — the mark is on the explanation,
not on each row.

**Empty/degraded.** Every card has its own empty state; a window with no spend
shows the KPI wall reading *"Not enough data yet"* and empty tables beneath.

---

## 7.2 `/signal/studio` — Campaign studio

**Route + shell.** `/signal/studio`, bespoke shell. Optional query parameters:
`?campaignId=…` (which campaign is open), `?opportunityId=…` (arrived from a
SCOUT opportunity), and three transient flags the screen sets on itself after a
successful POST — `&generated=n`, `&generatedImage=1`, `&planned=1`.

**Who sees it.** SIGNAL shell entitlement + `signal:campaigns:read`. Individual
cards additionally need `signal:campaigns:create`, `signal:creatives:generate`,
`signal:creatives:approve` and `signal:campaigns:update`.

**Purpose.** *"Say what you want and who it is for. The model drafts the words,
you edit them, then you launch."* It is the whole campaign chain on one screen.

**A rule that shapes the design: progress lives in the URL.** There is no wizard
state in the browser. Every step is a form POST that redirects back to the same
screen with a new query string, so a refresh re-reads what was written instead
of asking the model for a second set of drafts. Each page load also mints one
idempotency key, so a double-clicked Launch is one launch.

**The step strip.** Directly under the headline, an ordered list of five badges:
**The goal → The words → Review → Launch → Live**. The current step is derived,
not stored: no campaign = 1; a campaign with no drafts = 2; drafts but none
cleared = 3; cleared drafts but not live = 4; live = 5.

**Card 1 — The goal** (only when no campaign is open; needs
`signal:campaigns:create`).

| Field | Label | Input | Required |
|---|---|---|---|
| name | What is this campaign called | text | yes |
| objective | What is it for | select: Winning new customers / Keeping customers / Selling more to customers | yes |
| audienceId | *(audience)* | select of existing audiences, placeholder **"Everyone"** | no |
| channels | Where it runs | checkboxes over the nine channels; `google_search` and `meta` pre-ticked | at least one |
| daily budget | Daily budget | money field, defaults to 500,00 | yes |
| autopilot bound | *(per-move ceiling)* | money field, defaults to 100,00 | no |
| owner | Who owns it | select of real people and teams, placeholder "Choose a colleague or team" | yes |

Hints in use: *"Who it reaches. Leave empty to reach everyone."*, *"Tick every
place this campaign may buy. The autopilot moves budget between the ones you
tick."*, *"The most the autopilot may move between channels in one decision."*
Submit is **"Start the campaign"**; on success the screen redirects to itself
with the new `campaignId` and shows *"Draft created. Now give the model a
brief."* Beside the form, **"Or continue a draft"** lists campaigns in `draft`,
`review` or `scheduled` with an **Open** link each.

Refusals, each rendered as one sentence by `explain()`: name required, objective
required, owner required, at least one channel, a budget required.

**Card 2 — Who it goes to, and why** (rendered when the open campaign's audience
carries a model-argued targeting pool; absent for an audience somebody wrote by
hand, deliberately — "it has a rule but nobody argued it, and inventing a reason
would put words in a human's mouth").

- Title **"Who it goes to, and why"**, description **"About {n} people on the
  book"** — the estimated reach.
- A **✦ AgentBadge** in the card's action slot whose inspectable "why" is the
  model's own one-paragraph summary of the pool; the same paragraph is printed
  in the card body.
- Then **one bordered row per demographic band**, and this is the part the brief
  asks about: each row shows a badge naming the **axis and value** (e.g. an age
  band, a region, a language, an income band), then **the reason that band was
  chosen**, written by the model in a sentence, then **the number of customers
  who sit in that band**, end-aligned.
- Footer: *"Each band below was chosen from the book itself. The count is how
  many customers sit in it."*

The axis names are rendered as the raw slug the domain pack supplied, on
purpose, so that no UI table re-hard-codes industry vocabulary (CLAUDE.md §14).
A designer proposing pretty axis labels must propose them in the pack, not in
the screen. §7.11 covers where the bands and reasons come from and what is
excluded from them.

**Card 3 — How the model would run this** (the plan). Two states.

*No plan yet:* a card titled **"Nothing has been argued for this campaign yet"**
with the hint *"Say what it is selling and the model will draft three ways to
spend, each with its own chance of working. The drafts you generate afterwards
are written for the one it recommends."*, one input — **"What is this campaign
selling?"** (hint: *"A line of cover, or the scenario you have in mind."*,
3–200 characters, prefilled with the campaign name) — and a **✦ Plan it**
button beside an evidence link to the AI-pattern documentation. While it runs
the button reads *"Planning..."*.

*Plan present:* title **"How the model would run this"**, hint *"Three ways to
spend, ranked by its own chance of success. The drafts below are written for the
recommended one."*, a ✦ badge whose "why" is the model's written **notes**, the
notes printed in the body, and then **exactly three option cards**, highest
probability first:

- the option's **name**;
- a **"Recommended"** badge on one of them, which also gets an accent border and
  a 5 %-tint fill;
- its **probability** as a percentage badge, coloured by the number itself:
  green at 60 % and above, amber from 35 %, grey below;
- its **channels**, end-aligned;
- its **angle** — the strategic idea, one line;
- **"The offer: …"**;
- a bulleted list of **why** — the reasons the model gives for that probability;
- **"What would sink it: {risk}"**.

Card footer is one of two sentences: **"{n}% of the options it drafted survived
checking."** when the model answered, or **"The model did not answer. These
options were derived from the demand figures alone."** when it did not. The
second sentence is not decoration: a fallback plan still shows three options
with three different probabilities, and this line is the only thing telling the
reader nobody argued them.

**Card 4 — Tell the model what to say** (the brief; needs
`signal:creatives:generate`).

| Field | Label | Input |
|---|---|---|
| brief | Tell the model what to say | textarea, at least 10 characters |
| kind | What kind of content | select: Ad / Landing page / Email / Social / Video script |
| count | How many variants | number 1–8, default 3 |
| locales | Languages | checkboxes en / ar, `en` pre-ticked |

Hint: *"The offer, the tone, anything that must appear. The draft is yours to
edit."* Button **✦ Draft the content** (*"Drafting"* while running). On success:
**"✦ {n} draft(s) ready to read."**

When the screen was opened from a SCOUT opportunity, this card's description
changes to **"From an opportunity SCOUT found"** and the textarea arrives
**prefilled** with a brief built from that opportunity — its category, its
estimated demand and its competition reading. The opportunity is fetched
tolerantly: a dead id is not an error, the card simply loses its prefill.

**Card 5 — Generate an image** (needs `signal:creatives:generate`). One textarea,
**"What should the image show?"** (10–2000 characters), hint *"Describe the
scene. The model drafts a hero image for this campaign."*, button **✦ Generate
image**. On success: **"✦ New image ready below."** The bytes are served through
a proxy route (§7.10) and rendered as an image variant in card 6 with alt text
*"AI-generated campaign image"*.

**Card 6 — Drafts.** One block per generated variant:

- a **compliance badge**: Cleared → green, Blocked → red, Flagged → amber, *"Not
  checked yet"* → grey. **This is the one place in SIGNAL where the compliance
  states are tonally distinct** (contrast §4a, where blocked and pending share
  amber);
- badges for kind and language, a ✦ **AgentBadge** when the draft was
  model-written — its inspectable "why" is *"Drafted from your brief, the
  audience definition and the compliance rules for this content type."* — and a
  timestamp;
- a **guardrail notice** when the draft is blocked: *"Compliance blocked this
  draft. Edit it or discard it."*;
- for an image variant: the image itself plus a **Discard** button;
- for a text variant: the **draft text in an editable textarea** (read-only for
  an actor without `signal:creatives:approve`) with **Save**, **"Clear this
  draft"** / **"Cleared"**, and **Discard**;
- beside it, **"How it will look"** — the cleared words drawn onto the tenant's
  own brand frame as an SVG, with a ratio selector (**Feed 1:1 / Feed 4:5 /
  Story 9:16**) and a **Download** button that saves exactly the bytes on
  screen. Hint: *"The cleared words on your own brand. Download the frame you
  need."*

Empty: *"No drafts yet. Give the model a brief above."* Clearing and discarding
are both writes against the creative and both carry `signal.creative_publish` on
the API side, so both can come back as the approval panel.

**Card 7 — Launch.** When the campaign is live: a **"Pause it"** form and a
success badge. Otherwise a **"Launch the campaign"** button with the hint
*"Going live spends money. It is recorded, and it may need an approver."* The
button is disabled — with the note **"Clear at least one draft before
launching."** — until the campaign has at least one cleared draft and the actor
holds `signal:campaigns:update`. On success: **"The campaign is live."**

This is the module's consequential action. The API gates it on
`signal.campaign_launch`; in a tenant where that policy is not auto-approved the
answer is the **"Waiting for an approver"** panel, not an error.

**Card 8 — How it is doing.** Spend, signed and clicks for this campaign, plus
the same channel table as the cockpit, scoped to this campaign. Empty: *"No
spend recorded yet."*

**Footer.** **"Start a new one"** clears `?campaignId` and returns to card 1.

**AI surfaces on this screen** — four, all marked ✦ and all inspectable: the
targeting pool summary, the plan notes, each generated text draft, and the
generated image. None of them sends anything. Every one of them is a draft a
human edits, clears or discards.

---

## 7.3 `/signal/audience-value` — Audiences and value

**Route + shell.** `/signal/audience-value`, bespoke shell. `?days=7|30|90`.

**Who sees it.** Shell entitlement + `signal:audiences:read`.

**Purpose.** *"What each audience is worth against what it costs to reach."*
Read-only: there is no form on this screen.

**How the numbers are made.** There is no endpoint that answers this question.
The screen reads audiences, campaigns, spend and attribution events for the
window and does the join itself — **the campaign is the join**: spend is
attributed to an audience through the campaigns that target it. A designer
should know that these figures are derived on the client's behalf at request
time, not stored, and that a campaign with no audience contributes to nothing.

**Layout.** A headline naming the best-performing and worst-performing audience
by value against cost, the three window badges, then a table with one row per
audience: size, spend, signed, cost per acquisition, value per customer and the
value-to-cost multiple.

**Thin-data rule.** An audience with fewer than five signed customers in the
window is treated as too thin to rank, and its multiple reads *"Not enough data
yet"* rather than a number computed off one or two conversions.

**Currency.** Money is rendered in the currency of the spend rows themselves;
with no spend at all the screen falls back to `ZAR` — the platform default, not
the seeded tenant's `AED`. On an empty window a designer may therefore see a
currency the tenant does not use. This is a real defect.

---

## 7.4 `/signal/answer-engines` — Answer engines

**Route + shell.** `/signal/answer-engines`, bespoke shell.

**Who sees it.** Shell entitlement + `signal:aeo:read`; the status control needs
`signal:aeo:write`.

**Purpose.** The owned-content surface: the pages written so that an AI answer
engine has something correct to quote. Distinct from the generic Answer pages
tab (§18) in that it shows coverage and staleness rather than rows.

**Loader.** All pages, newest-updated first, plus two derived readings:
**coverage** (which question clusters are answered at all) and **how many pages
are stale**. A page is stale when it has not been refreshed in **30 days**.

**Status control.** One action, `set-status`, over the four states **Draft /
Published / Stale / Retired**. Publishing a page also stamps its freshness to
now — a page published today is fresh by definition, and the screen does not
make a human set two fields to say one thing. Refusals: a page must be named, a
status must be chosen.

**Citations.** Where the underlying row records which engines have cited a page,
this screen names the engines. The generic tab does not render that column at
all (§18).

---

## 7.5 `/signal/experiments` — Experiments

**Route + shell.** `/signal/experiments`, bespoke shell. `?id=…` opens one test.
Not to be confused with `/signal/signal-experiments`, the generic tab (§14).

**Who sees it.** Shell entitlement + `signal:experiments:read`; creating needs
`signal:experiments:create`, deciding needs `signal:experiments:decide`.

**Purpose.** The registry of running tests, and one opened test read against its
stopping rule.

**Create.** Hypothesis, metric, and arms — two arms are created at an even split
by default. Refusals: a hypothesis is required, a metric is required, arms are
required.

**Decide.** Records the verdict on an opened test.

**The sequential read.** The distinguishing element of this screen: an
experiment's probability is drawn against a **95 % decision boundary** rendered
as a hairline over a progress bar, so a reader sees at a glance whether the test
has crossed its stopping rule or is merely ahead. Copy states either that the
boundary was crossed or that it was not.

**An honesty note in the copy** worth keeping: *"The reading at the stop, not
the path to it: interim snapshots are not kept."* The chart shows where the test
ended, not how it wandered there, and says so.

---

## 7.6 `/signal/budget` — Budget and bounds

**Route + shell.** `/signal/budget`, bespoke shell. `?days=7|30|90`.

**Who sees it.** Shell entitlement + `signal:budget_moves:read`.

**Purpose.** The ceiling, what has been spent against it, what the autopilot is
allowed to do, and the undo. **Every write on this screen is consequential.**

**Loader.** Campaigns that have not ended, spend for the window, budget moves
for the window. From those it derives:

- **Ceiling** — the sum of every live campaign's planned spend for the window;
- **Spent** — the window's actual spend;
- **Headroom** — ceiling minus spent.

**One currency, deliberately.** The screen picks the dominant currency of the
live campaigns and computes the ceiling from campaigns in *that* currency only.
Adding AED minor units to ZAR ones would produce a total true in neither, so
campaigns in another currency are excluded from the total rather than
mis-summed. A designer must not "fix" this by showing one grand total.

**Setting bounds.** One form per campaign: the daily budget, the per-move
ceiling (**"Per-move ceiling"**), and the **autonomy level** — Suggest / Draft /
Act with approval / Act / Act and report. Refusals: a campaign, a budget, a
bound, an autonomy level; a bound larger than the daily budget is refused; and
widening what the agents may do requires an explicit **checkbox confirmation**
reading *"I understand this changes what the agents may spend"*. On success:
**"Bounds updated."**

The save is a read-before-write: the screen re-reads the campaign, merges the
budget fields it owns, and PATCHes — so it cannot blank a budget key it does not
render.

**Reversing a move.** The moves table is the cockpit's table plus an **Undo**
cell. A reversal is itself gated on `signal.budget_move`. A move is only
reversible inside its window; outside it the cell is absent.

**Approvals.** Bounds changes route through `signal.campaign_launch` and
reversals through `signal.budget_move`; both render as the *"Waiting for an
approver"* panel rather than as failures.

**Autopilot against a frozen budget** (docs/17 SIG-046, ADR-0110). A card
between the bounds form and the moves table, read from
`GET /v1/signal/holdout/readout?since=<window start>` and absent — not empty —
for a reader without `signal:attribution:read`. It leads with one sentence
(*"Acquisitions cost 50% less where the autopilot ran."*, or *"… more …"*), then
two stats: cost per acquisition where the autopilot ran, and for the campaigns
held out, each hinted with its campaign and acquisition counts. With no
campaign held out it is an `EmptyState` naming the door (*tick Holdout on a
campaign*); with a side that bought or spent nothing the sentence says so and
the stat reads *None* — never a zero. The per-campaign table carries a
**Holdout** column with a *Held out* badge. A campaign is held out from the
Campaigns tab's edit form (`holdout` checkbox), which is an ordinary campaign
update behind `signal.campaign_launch`; the autopilot then never moves its
budget.

---

## 7.7 `/signal/analytics` — Growth analytics

**Route + shell.** `/signal/analytics`, bespoke shell. `?days=7|30|90`.

**Who sees it.** Shell entitlement + `signal:spend:read`; the export card needs
`analytics:exports:create`.

**Purpose.** *"What a customer costs, what one is worth, which channel actually
produced them, and whether last quarter's customers came back."* None of these
four figures has an endpoint — the autopilot computes cost per acquisition
privately and exposes nothing — so all four are derived on this screen from the
spend ledger and the attribution touches, using the same derivations the cockpit
uses.

**KPI wall.** Spend, blended cost per acquisition, blended value per customer,
the **value-to-cost multiple** (hint: *"Three or better is a business that can
afford to grow."*) and cost per click. Any figure without data reads *"Not
enough data yet"*.

**Attribution table.** Per channel: spend, clicks, signed, cost per acquisition,
value, and the value-to-cost multiple — **rendered in red when the multiple is
below 1**, i.e. when the channel costs more than it returns. That red number is
the screen's one piece of editorial.

**Cohort table.** Per month: cohort size, retained, and a retention percentage
shown as a figure beside a progress bar (the bar's label is its accessible name,
so the figure is printed separately rather than swallowed by the aria
attribute). Retention below 30 % takes the warning tone.

**Export card.** Format select — **xlsx / pdf / csv / json** — and an Export
button. The export goes through the platform's own reporting pipeline over the
registered `spend` dataset (metrics spend, impressions, clicks, conversions;
dimensions channel and campaign; daily grain; the window taken from the page).
Rendering happens inside the request, so what comes back is already final: the
card then shows **"Ready"** or **"Queued"**, a format badge, any error in
`role="alert"`, and a **Download** link straight to the API origin. It is the
platform's own pipeline, not a second spreadsheet writer — the API masks PII on
the way out.

**Footer.** Links to the cockpit and to the budget screen.

---

## 7.8 `/signal/admin` — Marketing settings

**Route + shell.** `/signal/admin`, bespoke shell. Read-only: nothing on this
screen is editable.

**Who sees it.** Shell entitlement + `signal:campaigns:read`.

**Purpose.** Show a marketer what the module is currently configured to do —
and, unusually, what it is not.

**Cards.**

1. **Faults** — a computed list of configuration problems worth a marketer's
   attention.
2. **Brand kit** — the tenant's colours, fonts and served name as the module
   reads them.
3. **Guardrails** — frequency caps, quiet hours, suppression rules as
   configured.
4. **Bounds** — the autonomy defaults and per-move ceilings.
5. **Approval thresholds** — the six SIGNAL policies of §6, each with its decide
   permission, whether it needs two people, its threshold, and **whether this
   tenant auto-approves it**. This screen is the first and only place in the UI
   where the `signal.budget_commit` threshold is displayed to a human.
6. **Suppression sources** — the audiences that exist to be subtracted.
7. **Disclosure wordings** — the standing disclosure text.
8. **"Not configured here yet"** — an explicit card naming two known gaps:
   channel credentials and UTM conventions are not configurable in the UI.

That last card is the pattern worth keeping: the settings screen states its own
holes rather than implying completeness.

---

## 7.9 `/signal/dev` — Developer console

**Route + shell.** `/signal/dev`, bespoke shell.

**Who sees it.** Shell entitlement + `signal:spend:read`. The sandbox controls
additionally need `signal:autopilot:run` **and** a non-production environment —
the copy says so: *"Never available in production."*

**Purpose.** The module's own integration surface, so an integrator does not
need the repository.

**Cards.**

1. **Read console** — the eight SIGNAL resources with their paths and the
   permission each requires; a **Read** action fetches up to 100 rows of one and
   shows them.
2. **curl** — the equivalent command for the selected read.
3. **Webhooks and topics** — the events SIGNAL emits
   (`signal.budget.moved`, `signal.autopilot.paused`,
   `signal.autopilot.resumed`, `signal.campaign.launched`,
   `signal.experiment.concluded`, `signal.creative.flagged`). A topic nothing
   raises would be marked **not yet built**; `signal-dev.test.ts` holds each
   flag to the API's sources.
4. **Sandbox** — `ping` and `tick` actions for a non-production tenant.
5. Two cards that are **deliberately empty**: the tracking pixel and the product
   feed, each with a lede explaining what would go there. **Not yet built**, and
   the screen says so rather than omitting them.

---

## 7.10 `/signal/creatives/:id/image` — image bytes

Not a screen. A proxy route that streams a generated creative's image from the
API with the right content type, so the browser can render it inside the Studio
without the page holding the bytes. Nothing renders here; opening the URL
directly returns an image.

---

## 7.11 The campaign chain, end to end

This is the sequence the module exists for. It crosses SCOUT and SIGNAL and
touches both chromes. Read it before redesigning any single screen in it.

**Step 1 — the starting point.** Either:

- *a market opportunity found by SCOUT.* On SCOUT's radar screen, an
  opportunity carries a **"Promote to SIGNAL"** action gated on
  `scout:whitespaces:promote`. It is refused outright when the evidence behind
  the opportunity is below the **k-anonymity floor** — a brief built from a
  handful of records would restate a few quotes as market demand, and every
  draft would carry that outward. It also needs its own approval
  (`scout.whitespace_promote`); or
- *a scenario a marketer types.* The Studio's "The goal" card, then its
  "What is this campaign selling?" input.

**Step 2 — who it goes to, and why.** The targeting proposal is argued from the
tenant's own book. A model is given **suppressed counts of customer attributes**
along a small set of axes defined by the active domain pack, and asked which
bands to target and why. What comes back per band is an axis, a value, a written
reason, and the number of customers in it. Three properties a designer must
respect:

- **The axes are the pack's, not the screen's.** The default insurance pack
  cuts on living-standards band, age band, region, language and life stage. The
  Gulf pack (`insurance-gulf`, used by the seeded tenant) cuts on **income
  quintile (Q1–Q5), age band, region (the seven emirates), language and life
  stage** — no living-standards measure, because that measure is South African.
- **Some axes may never be targeted.** Protected attributes are excluded by the
  code, not by the prompt. In the Gulf pack, nationality and residency status
  are deliberately excluded as proxies for race and ethnicity.
- **Reach is the smallest band, not the sum.** Estimated reach is capped by the
  narrowest axis in the rule, because a rule that ANDs three axes cannot reach
  more people than its tightest one.

Every proposed rule has consent conditions appended to it unconditionally — a
band the model proposes cannot escape the consent requirement by omission. Bands
whose evidence does not survive checking are dropped, and the surviving share
becomes the pool's **confidence**. A model failure produces a deterministic
fallback pool at **confidence 0**, which the UI must show as "nobody argued
this", not as a low score.

This is what card 2 of the Studio renders: the summary, the reach, and one row
per band with **the reason that band was chosen** and its count.

**Step 3 — the plan.** The campaign, the opportunity's demand figures and the
targeting pool go to a second model call, which must return **exactly three
options with different probabilities**, plus written notes. Each option carries
a name, an angle, an offer, its channels, a 0–100 probability, a list of reasons
for that probability, and the risk that would sink it. The options are sorted
highest probability first and one is marked recommended. The system prompt is
explicit that a human funds this — the model is arguing, not spending. A model
failure again produces a deterministic three-option plan at **confidence 0**,
with probabilities stepped down from a base figure.

This is Studio card 3. The API treats planning as **not consequential**: a plan
is an argument, not a spend, so it needs no approval.

**Step 4 — the content.** The draft request carries the campaign brief **plus
context lines built from the plan** — the recommended option's angle and offer,
and the bands the pool is made of. That is the point of writing the plan down:
the copy speaks to a specific group about a specific idea rather than to
"customers" about a category noun. Each draft comes back with a compliance
verdict already attached.

This is Studio cards 4–6.

**Step 5 — the human.** A person edits, clears or discards each draft. Clearing
is gated on `signal.creative_publish`. Nothing has been sent.

**Step 6 — the launch.** Gated on `signal.campaign_launch`; above the tenant
threshold a budget commitment additionally needs two people
(`signal.budget_commit`). Studio card 7.

**Step 7 — the run.** Spend and attribution flow back; the cockpit (§7.1), the
analytics screen (§7.7) and the campaign's own performance card report it, and
the autopilot moves budget between the campaign's channels inside its per-move
ceiling, writing a budget move for each decision.

**When SCOUT is the origin, steps 1–4 happen in one server-side transaction.**
Promoting an opportunity writes the audience with its reasons, the campaign in
`draft` with its plan attached, and **six draft creatives** (three per language),
with no channel and no budget — those are spend decisions, and this route only
creates the draft a human then funds. Every model call in it is individually
tolerant: a failed brief, a failed pool or a failed generation leaves the
promotion standing with less in it, never a 500. SCOUT then shows a **draft
tray** — a `role="status"` panel carrying the ✦ mark and a link straight to
`/signal/studio?campaignId=…` — which reads *"Handed over. Nothing drafted
yet."* when the count is zero.

**Where the chain is invisible.** None of steps 2–4 leaves a trace on the
generic Campaign record screen (§11): the plan, the pool, the reasons and the
probabilities live in JSON columns that screen renders as 60-character truncated
grey monospace. A campaign argued in full detail looks, on the generic tab, like
a campaign nobody thought about.

---

## 8. `/signal/audiences` — Audiences (list)

**Route + title.** `/signal/audiences`. `<h1>` "Marketing". Tab label
`audiences` → **"Audiences"** (ar: الجماهير). API `GET /v1/signal/audiences`.

**Who sees it.** `signal:audiences:read` — `signal.marketer`, `signal.lead`,
`signal.admin`, `tenant.admin` (read only). Denied users: full-page
`error.forbidden`.

**Purpose.** List every reachable segment, its cached size, how often it
refreshes, and which consent purposes it depends on.

**Layout skeleton.**

```
Marketing                                                          (24px display)
[Audiences] Campaigns  Creatives  Experiments  Budget moves  Answer pages …   (h-8 chips)

[ Refresh: All ▾ ]  [ Apply ]                                       (filter bar, gap-3)

  + New — Audiences                                                 (<details>, closed)

┌──────────────────────────────────────────────────────────────────────────┐
│ NAME ↕        │  SIZE │ REFRESH │ CONSENT PURPOSES │ LAST REFRESHED │ CREATED ↕│
│ Motor policy… │ 4,182 │ [Daily] │ marketing        │ 12 Jul, 03:00  │ 2 Apr    │
│ Renewals due… │ 1,247 │ [Daily] │ marketing        │ 12 Jul, 03:00  │ 2 Apr    │
│ …                                                                        │
└──────────────────────────────────────────────────────────────────────────┘
  6 shown                                                       [Previous][Next]
```

Roughly: header block ~120px, filter bar ~48px, create disclosure ~48px closed,
table fills the rest. Table is `overflow-auto`, so on narrow viewports it
scrolls horizontally inside its own border.

**Every element.**

| Element | Label / i18n key | Source | Behaviour |
|---|---|---|---|
| `<h1>` | `nav.signal` "Marketing" | shared catalogue | — |
| Tab strip | `<nav aria-label="Sections">` (`common.tabs`) | `visibleTabs(spec, permissions)` | Only readable tabs render. Current tab `bg-surface-2 font-medium text-text`, others `text-subtle hover:bg-surface-2` |
| Filter select | aria-label "Refresh" (`refreshPolicy`) | spec filter | Options: All (`common.all`), Manual, Hourly, Daily. Submits as `?refreshPolicy=` |
| Apply | `common.apply` "Apply" | — | `Button variant="secondary"`, shows loading spinner while navigating |
| Clear | `common.clear` "Clear" | — | Ghost link back to `/signal/audiences`; **rendered only when a filter or search is active** |
| Create disclosure | `+ New — Audiences` (`common.new`) | — | `<details>`; auto-opens when the last create failed |
| Row link | first cell (Name) | — | `<Link>` to `/signal/audiences/<id>` |
| Footer count | `common.rows` "{count} shown" | rows on this page | Not a total — 50 rows shows "50 shown" with more behind Next |

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Name (`name`) | text | start | **yes** | Link into the record; truncated at 80 chars |
| 2 | Size (`sizeCached`) | number | **end** | no | Raw integer, no thousands formatting beyond locale. `null` renders "—" |
| 3 | Refresh (`refreshPolicy`) | text, **badge** | start | no | Manual / Hourly / Daily — all neutral grey |
| 4 | Consent purposes (`consentPurposes`) | text | start | no | Comma string, e.g. `marketing,profiling`, or `none` |
| 5 | Last refreshed (`lastRefreshedAt`) | datetime | start | no | Minute precision; "—" when never refreshed |
| 6 | Created (`createdAt`) | datetime | start | **yes** | — |

No default sort is declared, so the API's own default ordering applies until the
user clicks a sortable header (which sets `?sort=&order=` and drops the cursor).

**Forms — create (`+ New — Audiences`).** Grid `sm:grid-cols-2`, submit
`common.create` "Create".

| Field | Label | Input | Required | Default | Validation / error copy |
|---|---|---|---|---|---|
| `name` | Name | `<Input type="text">` | **yes** | empty | Server-side zod; failure renders the API's `detail` in the red `Problem` bar |
| `definitionJson` | Definition | `<Textarea rows=6 class="font-mono text-12">` | **yes** | empty | Must be valid JSON; a malformed body returns 400 with the zod message |
| `refreshPolicy` | Refresh | `<Select>` | no | first option | manual / hourly / daily |
| `consentPurposes` | Consent purposes | `<Input type="text">` | no | empty | Free text; **nothing validates that the purposes named here actually exist as consent purposes** |

There is no client-side validation beyond the browser's `required` attribute,
and no field-level error placement: every error is one line at the top.

**States.**

- *Empty (unfiltered)*: "Nothing here yet" / "No records match this view. Clear
  the filters, or create the first one."
- *Empty (filtered)*: "Nothing here yet" / "No records match these filters."
- *Loading*: no skeleton. The Apply button shows its loading state; the table
  keeps the previous rows until the navigation resolves.
- *Error*: full-page boundary (loader errors) or the red `Problem` bar (create
  errors).
- *Permission denied*: "Your roles do not include access to this area."

**AI surfaces.** None. No ✦ marker, no ghost text, no suggestion chip appears on
this screen. An audience definition is typed by hand as JSON.

**Actions and consequences.** Create and update only. No delete (the spec
declares no `remove`, and the table has no `deletedAt`). Nothing here is gated
by an approval. Changing `consentPurposes` or `definitionJson` silently changes
who a live campaign will reach on its next refresh — with no warning, no
preview, no size re-estimate.

**Mobile.** Not present. The Expo app maps `/signal` to
`signal/campaigns` only. Audiences are web only.

**RTL notes.** Tab strip, table column order and the filter bar all mirror.
Numbers stay LTR (`tabular-nums`). The `definitionJson` textarea must stay
**LTR with `dir="ltr"`** — JSON is code and mirrors into nonsense; today it
inherits page direction, which is a bug in Arabic. Consent purpose strings
(`marketing,profiling`) are ASCII tokens and should also stay LTR.

**What is weak today.** Six seeded audiences and one of them is
`"Do not contact — withdrawn consent, complaints, open claims"` (213 people),
which every other audience subtracts via `excludeAudienceId` inside
`definitionJson`. That suppression relationship — the single most important
safety property of the whole module — is invisible: it is buried in truncated
JSON. The list cannot answer "is the suppression list applied to this
audience?", "how big is this audience really" (`sizeCached` may be months old
and one row is `null` "never refreshed" with no visual distinction from a
freshly computed one), or "which campaigns use this audience".

---

## 9. `/signal/audiences/:id` — Audience (record)

**Route + title.** `/signal/audiences/<aud_…>`. `<h1>` is the **Name** value,
e.g. "Motor policyholders with no health cover". Subtitle:
`Audiences · aud_01J…` with the id in `font-mono`.

**Who sees it.** `signal:audiences:read` to view; the edit form appears only
with `signal:audiences:create`.

**Purpose.** Read one audience's definition and change how it refreshes.

**Layout skeleton.**

```
Back to list                                                        (12px, subtle)
Motor policyholders with no health cover                            (24px display)
Audiences · aud_01J8…                                               (12px mono id)

┌─ details ────────────────────────────────────────────────────────────────┐
│ Name              Size               Refresh                             │
│ Motor policyho…   4182               Daily                               │
│ Consent purposes  Last refreshed     Created                             │
│ marketing         12 Jul 2026 03:00  02 Apr 2026 09:14                   │
│ Updated                                                                  │
│ 12 Jul 2026 03:00                                                        │
└──────────────────────────────────────────────────────────────────────────┘   (3-col grid ≥lg, 2-col ≥sm, 1-col below)

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ Definition                          Refresh                              │
│ ┌───────────────────────────┐       [ Daily ▾ ]                          │
│ │ {"include":[…],           │       Consent purposes                     │
│ │  "excludeAudienceId":"…"} │       [ marketing            ]             │
│ └───────────────────────────┘                                            │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Every element.** Back link `common.back` "Back to list" → `/signal/audiences`.
`<dl>` renders **all six columns** plus `common.createdAt` "Created" and
`common.updatedAt` "Updated" when present; each is a `<dt>` in
`text-12 text-subtle` above a `<dd>` in `text-13 text-text`. No Actions section
(SIGNAL declares no record actions anywhere). No delete button.

**Forms — edit.** Heading `common.edit` "Edit", submit `common.save`
"Save changes", `PATCH /v1/signal/audiences/<id>`.

| Field | Label | Input | Prefilled from | Notes |
|---|---|---|---|---|
| `definitionJson` | Definition | Textarea rows=6, mono 12px | row value | Raw JSON, no formatter, no schema hint |
| `refreshPolicy` | Refresh | Select manual/hourly/daily | row value | — |
| `consentPurposes` | Consent purposes | text input | row value | — |

`name` is **not** editable — it is a create-only field. An audience cannot be
renamed through the UI.

**States.** Loading: no skeleton (the loader blocks the navigation). Save
failure: red `Problem` bar above the `<dl>`. Save success: **no confirmation at
all** — the action returns `{ problem: null, done: null }`, the page re-renders
with the same values, and nothing says "Saved". Not found / no permission:
full-page boundary.

**AI surfaces.** None.

**Actions and consequences.** Saving takes effect immediately on the next
refresh cycle; no approval, no audit surface on this screen. Not reversible
through the UI — there is no version history for a definition.

**Mobile.** Web only.

**RTL notes.** The `<dl>` grid mirrors. The JSON textarea and the mono id must
stay LTR.

**What is weak today.** The `<dl>` shows `sizeCached` as a bare integer with no
"as of" relationship to `lastRefreshedAt` next to it; a size computed three
months ago looks identical to one computed at 03:00 today. There is no
"Refresh now" button even though `refreshPolicy: manual` exists as a state,
which means a manual audience can only ever be refreshed by a background job
the UI never mentions.

---

## 10. `/signal/campaigns` — Campaigns (list)

**Route + title.** `/signal/campaigns`. Tab label **"Campaigns"** (ar: الحملات).
API `GET /v1/signal/campaigns`. Default sort `startAt desc`.

**Who sees it.** `signal:campaigns:read` — marketer, lead, signal.admin,
tenant.admin (read). This is also the permission that gates the **sidebar entry
for the whole module**.

**Purpose.** The spine of the module: every campaign, what it is for, whether it
is live, who owns it and when it runs.

**Layout skeleton.**

```
Marketing
Audiences [Campaigns] Creatives  Experiments  Budget moves  Answer pages  Attribution  Spend

[ Search…            ] [ State: All ▾ ] [ Objective: All ▾ ] [ Apply ] [ Clear ]
  ^ w-64, role="search"

  + New — Campaigns

┌──────────────────────────────────────────────────────────────────────────────┐
│ NAME              │OBJECTIVE│ STATE  │AUTONOMY│ OWNER      │ STARTS ↕│ ENDS   │
│ Motor — always-on │ acq     │[Live]  │[act]   │ user:gl…   │ 01 Jan  │ —      │
│ December brand…   │ acq     │[Paused]│[act_w…]│ user:gl…   │ 01 Dec  │ 31 Dec │
│ Health cross-sell │ xsell   │[Live]  │[act]   │ user:mk…   │ 15 Feb  │ —      │
└──────────────────────────────────────────────────────────────────────────────┘
  7 shown                                                          [Previous][Next]
```

**Every element.** As §8, plus: a search `<Input type="search" name="q"
class="w-64">` with placeholder and aria-label "Search" (`common.search`),
wrapped in `<Form method="get" role="search">`; the API searches the `name`
column only (`searchable: ["name"]`).

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Name (`name`) | text | start | no | Link into the record. **Not sortable** despite being the primary column |
| 2 | Objective (`objective`) | text | start | no | Renders the **raw enum** `acq` / `renewal` / `xsell` — not a badge, so `optionLabel` never runs and the translated words "Acquisition" / "Renewal" / "Cross-sell" in the label table are unused here (they only appear in the filter select) |
| 3 | State (`state`) | text, **badge** | start | no | Draft (grey) / In review (**blue**) / Scheduled (grey) / Live (**green**) / Paused (grey) / Ended (grey) |
| 4 | Autonomy (`autonomyLevel`) | text, **badge** | start | no | Raw values `suggest` / `draft` / `act_with_approval` / `act` — **not in the label table**, so they render untranslated, and every one is grey |
| 5 | Owner (`ownerRef`) | text | start | no | Raw ref like `user:usr_01J…`; no name resolution |
| 6 | Starts (`startAt`) | datetime | start | **yes** | Default sort, descending |
| 7 | Ends (`endAt`) | datetime | start | no | "—" for open-ended |

**Filters.** State (`draft`, `review`, `scheduled`, `live`, `paused`, `ended`,
rendered via the label table as Draft / In review / Scheduled / Live / Paused /
Ended) and Objective (Acquisition / Renewal / Cross-sell). Both plus "All".

**Forms — create.**

| Field | Label | Input | Required | Notes |
|---|---|---|---|---|
| `name` | Name | text | **yes** | — |
| `objective` | Objective | select acq/renewal/xsell | **yes** | Shows translated labels |
| `audienceId` | Audience | **plain text input** | no | The user must paste an `aud_…` id. There is no picker, no lookup, no validation that it exists |
| `channelsJson` | Channels | JSON textarea | **yes** | Seeded shape: `["google_search","bing_search"]` |
| `budgetJson` | Budget | JSON textarea | **yes** | Seeded shape: `{"currency":"AED","period":"2026-01","dailyCapMinor":350000,"periodCapMinor":10850000,"upliftMinor":1500000,"autopilotBoundMinor":1000000}` |
| `ownerRef` | Owner | text | **yes** | Raw ref, typed |
| `startAt` | Starts | `datetime-local` | no | — |
| `endAt` | Ends | `datetime-local` | no | Nothing enforces `endAt > startAt` in the form |

**States.** Empty/loading/error/denied exactly as §8. There is one extra: the
create disclosure re-opens automatically when a create was rejected, so the
user's context is preserved with the red bar above it.

**AI surfaces.** None on this screen — and that is the defect, because the
campaigns themselves are full of AI. Campaigns carry an `autonomyLevel` column
with values up to `act` (autonomous spend within `autopilotBoundMinor`), the
budget autopilot writes budget moves under `system:signal.budget_autopilot`, and
a campaign promoted from SCOUT arrives with a model-written plan, a
model-argued audience and six model-written drafts attached (§7.11). None of
that shows here: **no ✦ marker, no autonomy explanation and no "why" anywhere
on the generic campaign surface.** The Studio (§7.2) renders all of it. The
same campaign therefore looks thought-about on one screen and anonymous on the
other.

**Actions and consequences.** Create is not gated. Every `PATCH` — including
setting `state: "live"` — routes through the `signal.campaign_launch` policy;
in the seeded tenant that policy is on the `autoApprove` allowlist, so it
resolves instantly and writes a `core.approval.auto` audit entry. In a tenant
without that allowlist entry, changing state to live throws the opaque
`signal.campaign_launch` red bar (see §6). Going live is **not reversible** in
the sense that spend begins; the remedy is setting state back to `paused`.

**Mobile.** **This is the one SIGNAL screen that exists on mobile.** See §24.

**RTL notes.** Everything mirrors except: `ownerRef`, `audienceId`,
`channelsJson`, `budgetJson` and datetimes-as-typed, which are LTR data.

**What is weak today.** A campaign is money, and this screen shows no money at
all. `budgetJson` is not a column, so `dailyCapMinor`, `periodCapMinor`,
`upliftMinor`, `autopilotBoundMinor` and `releasedMinor` / `unspentMinor` are
invisible on the list — the user cannot see which campaign is capped at
AED 3,500/day or which one has AED 23,000 released. `guardrailChecksJson`
(frequency cap 2/week, quiet hours 20:00–08:00 Asia/Dubai, suppression audience
applied, brand-kit pass, banned-claims pass) is written by the system and
**never rendered anywhere in the product**. One seeded campaign sits in
`scheduled` purely because its Arabic email is unreviewed (`localesRequired:
["en","ar"]`), and nothing on screen explains why it has not gone live.

---

## 11. `/signal/campaigns/:id` — Campaign (record)

**Route + title.** `/signal/campaigns/<cmp_…>`. `<h1>` is the campaign **Name**.
Subtitle `Campaigns · cmp_01J…`.

**Who sees it.** `signal:campaigns:read`; edit form needs
`signal:campaigns:update`.

**Purpose.** Read a campaign's settings and change its state, budget, dates or
owner.

**Layout skeleton.**

```
Back to list
Motor — always-on search
Campaigns · cmp_01J8…

┌─ details (3-col ≥lg) ────────────────────────────────────────────────────┐
│ Name             Objective        State                                  │
│ Motor — always…  acq              [Live]                                 │
│ Autonomy         Owner            Starts                                 │
│ [act]            user:usr_01J…    01 Jan 2026 00:00                      │
│ Ends             Created          Updated                                │
│ —                12 Dec 2025      28 Jul 2026 03:00                      │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ State                       Budget                                       │
│ [ Live ▾ ]                  ┌────────────────────────────┐               │
│ Starts                      │ {"currency":"AED","period" │               │
│ [ 2026-01-01T00:00 ]        │ :"2026-01","dailyCapMinor" │               │
│ Ends                        │ :350000,…}                 │               │
│ [                    ]      └────────────────────────────┘               │
│ Owner                                                                    │
│ [ user:usr_01J…           ]                                              │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Every element.** `<dl>` over the seven list columns + Created + Updated.
Note what the record page **does not show**, because the spec's `columns` array
is the whole `<dl>`: `audienceId`, `channelsJson`, `budgetJson`,
`guardrailChecksJson`, `deletedAt`. So the budget is invisible in the details
block yet editable in the form below it — a user edits a value they were never
shown.

**Forms — edit** (`PATCH /v1/signal/campaigns/<id>`):

| Field | Label | Input | Notes |
|---|---|---|---|
| `state` | State | Select: Draft / In review / Scheduled / Live / Paused / Ended | **The launch control.** No confirmation dialog, no consequence copy |
| `budgetJson` | Budget | JSON textarea, mono 12px | Money edited as raw minor-unit integers |
| `startAt` | Starts | `datetime-local` | — |
| `endAt` | Ends | `datetime-local` | — |
| `ownerRef` | Owner | text | — |

**States.** Save failure → red bar. Save success → silent. Approval required
(non-auto-approve tenant) → red bar reading `signal.campaign_launch`.

**AI surfaces.** None here. The AI runs that touched this campaign do exist —
seeded `ai_run` rows with `agentKey: "creative"`, `purpose: "creative.variant"`,
`subjectRef: "campaigns:motor-jan"`, one `refused` with
`errorCode: "guardrail_block"` and confidence 40, one `cancelled` — but they are
only visible in the **Administration → AI** screens. Nothing links a campaign to
the AI work done on it.

**Actions and consequences.** Setting `state` to `live` starts spend. Setting it
to `paused` stops it. Neither is confirmed, neither is explained, and there is
no delete button (campaigns have a `deletedAt` column but the spec declares no
`remove`, so soft delete is unreachable from the UI).

**Mobile.** Read-only detail view exists — see §22.

**RTL notes.** Details grid and form grid mirror; the JSON textarea and
`ownerRef` must not.

**What is weak today.** The single most consequential control in the module —
the campaign state select — is an unlabelled-by-consequence dropdown sitting in
a generic two-column form between "Budget" and "Owner", with a "Save changes"
button. Launching a campaign should not look like editing a phone number.
Nothing shows spend to date against `periodCapMinor`, nothing shows which
creatives are attached or whether any are `blocked`, nothing shows the audience
name, nothing shows the guardrail check results.

---

## 12. `/signal/creatives` — Creatives (list)

**Route + title.** `/signal/creatives`. Tab label **"Creatives"** (ar: المواد
الإبداعية). API `GET /v1/signal/creatives`.

**Who sees it.** `signal:creatives:read` — marketer, lead, signal.admin,
tenant.admin (read), **`tenant.compliance`**. Create needs
`signal:creatives:generate` (marketer, lead, signal.admin — **not** compliance).
Update needs `signal:creatives:approve` (lead, signal.admin, **compliance**).
So the compliance officer sees the table and an edit form on the record page,
but no create disclosure. And, per §4, they have no sidebar link to get here.

**Purpose.** Every piece of content the tenant may publish, with its compliance
verdict.

**Layout skeleton.**

```
Marketing
Audiences  Campaigns [Creatives] Experiments  Budget moves  Answer pages  Attribution  Spend

[ Kind: All ▾ ] [ Compliance: All ▾ ] [ Apply ]

  + New — Creatives            (absent for tenant.compliance)

┌──────────────────────────────────────────────────────────────────────────────────────┐
│ CONTENT             │CAMPAIGN│KIND│LANG│VARIANT│COMPLIANCE│NOTES   │PERF    │MADE BY│CREATED ↕│
│ signal/creatives/m… │cmp_01J…│ ad │ en │ mot-a │[Passed]  │{"lane"…│{"impr"…│[AI]   │12 Dec   │
│ signal/creatives/m… │cmp_01J…│ ad │ en │ mot-b │[Flagged] │{"lane"…│{"impr"…│[AI]   │12 Dec   │
│ signal/creatives/…  │cmp_01J…│ ad │ ar │ mot-g │[Blocked] │{"lane"…│—       │[AI]   │14 Dec   │
└──────────────────────────────────────────────────────────────────────────────────────┘
  9 shown                                                                [Previous][Next]
```

Ten columns in a table that must fit an already-narrow content column: this
screen always scrolls horizontally on a laptop.

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Content (`contentRef`) | text | start | no | Link into the record. A **file path string**, e.g. `signal/creatives/motor-search/en-a.json`. Truncated at 80 chars, so the distinguishing tail is often what gets cut |
| 2 | Campaign (`campaignId`) | text | start | no | Raw `cmp_…` id, no name, **no link** |
| 3 | Kind (`kind`) | text | start | no | Raw enum `ad` / `lp` / `email` / `social` / `video_script` — not a badge, so not translated in the cell |
| 4 | Language (`locale`) | text | start | no | `en` / `ar` |
| 5 | Variant group (`variantGroup`) | text | start | no | The A/B arm |
| 6 | Compliance (`complianceStatus`) | text, **badge** | start | no | Pending (**amber**) / Passed (grey) / Flagged (grey) / Blocked (**amber**) |
| 7 | Compliance notes (`complianceNotesJson`) | json | start | no | Mono 11px, **truncated at 60 chars** |
| 8 | Performance (`performanceJson`) | json | start | no | Mono 11px, truncated. Seeded shapes `{"impressions":…,"clicks":…,"ctrBps":…,"binds":…}` for ads, `{"visits":…,"quoteStarts":…,"quoteStartRateBps":…}` for landing pages |
| 9 | Made by (`generatedBy`) | text, **badge** | start | no | **Human** / **AI** — both neutral grey |
| 10 | Created (`createdAt`) | datetime | start | **yes** | — |

**Filters.** Kind (Ad / Landing page / Email / Social / Video script) and
Compliance (Pending / Passed / Flagged / Blocked), each plus All.

**Forms — create** (`signal:creatives:generate` only):

| Field | Label | Input | Required | Notes |
|---|---|---|---|---|
| `kind` | Kind | Select ad/lp/email/social/video_script | **yes** | — |
| `contentRef` | Content | text | **yes** | The path is typed by hand |
| `campaignId` | Campaign | text | no | Raw id, typed |
| `locale` | Language | text | no | Free text — nothing constrains it to the tenant's `["en","ar"]` |

Note that `variantGroup`, `complianceStatus` and `generatedBy` are **not**
create fields; the API sets them.

**States.** As §8. A compliance officer arriving from a pasted URL with only
`signal:creatives:read` sees the table with **no tab strip beyond one entry**
(the strip only renders when more than one tab is visible — for compliance,
exactly one is, so there is no tab strip at all and the screen looks like a
context-free table under the word "Marketing").

**AI surfaces.** The only trace of AI on **this** screen is the `generatedBy`
badge reading "AI" in neutral grey — no ✦ marker, no inspectable "why", and the
`aiAuditId` the row carries is never surfaced, so even where an audit link
exists there is nothing to open. The generic creatives tab therefore still
violates CLAUDE.md §11 in spirit.

It is no longer true that SIGNAL has no ✦ anywhere: the Studio (§7.2) marks the
targeting pool, the plan, every generated draft and the generated image, each
with an inspectable "why"; the cockpit (§7.1) marks the autopilot. **The mark
exists on the nine bespoke screens and is missing on the eight generic ones** —
which is the same split as the approval panel (§6). The compliance officer, who
cannot open the bespoke screens at all (§4b), is exactly the actor who never
sees a ✦ or a rationale.

**Actions and consequences.** Create is ungated. **Every update is gated on
`signal.creative_publish`, which is not auto-approved** — so a compliance
officer marking a creative `passed` gets 403 and a red bar reading
`signal.creative_publish`, must go to `/approvals`, approve their own request
(dual control is `never` on this policy, so self-approval is permitted), and
come back. Two round trips through a different screen to record one verdict.

**Mobile.** Web only.

**RTL notes.** The table mirrors. `contentRef` paths, `campaignId`, `locale`
codes and the two JSON columns must stay LTR — today they do not, and an Arabic
compliance officer reads file paths with the slashes in the wrong order. The
Arabic-language creatives themselves are never displayed (only their paths), so
there is no bidirectional content rendering problem yet — there will be the
moment a preview is added.

**What is weak today.** This screen is where a regulator's question lands and it
cannot answer one. The seeded data holds a creative flagged with
`{"lane":"soft_flag","rule":"comparison_claim_requires_source","excerpt":"the
cheapest motor cover in the UAE"}` and one **blocked** with
`{"lane":"hard_block","rule":"no_guarantee_of_cover","excerpt":"قبول مضمون مهما
كان سجلك"}` decided by a named compliance officer. Both render as
`{"lane":"soft_fl…` in 11px grey. The rule that was broken, the offending
sentence, who decided and when — all present in the data, all invisible. And
`blocked` shares its amber with `pending`, so the one creative that must never
ship looks like the ones merely awaiting review.

---

## 13. `/signal/creatives/:id` — Creative (record) — **the compliance verdict screen**

**Route + title.** `/signal/creatives/<crv_…>`. `<h1>` is the **contentRef**,
i.e. a raw file path such as `signal/creatives/summer-travel/en-script.md`.
Subtitle `Creatives · crv_01J…`.

**Who sees it.** `signal:creatives:read`. The edit form requires
`signal:creatives:approve` — held by `signal.lead`, `signal.admin` and
`tenant.compliance`. A `signal.marketer` sees the record read-only: they can
create a creative but cannot change its status.

**Purpose.** Record the compliance verdict on one piece of content.

**Layout skeleton.**

```
Back to list
signal/creatives/summer-travel/en-script.md                        (24px display — a file path)
Creatives · crv_01J8…

┌─ details (3-col ≥lg) ────────────────────────────────────────────────────┐
│ Content             Campaign           Kind                              │
│ signal/creatives/…  cmp_01J8…          video_script                      │
│ Language            Variant group      Compliance                        │
│ en                  —                  [Pending]                         │
│ Compliance notes    Performance        Made by                           │
│ {"likeness":"none…  —                  [AI]                              │
│ Created             Updated                                              │
│ 20 Jul 2026 11:02   20 Jul 2026 11:02                                    │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ Compliance                  Compliance notes                             │
│ [ Pending ▾ ]               ┌────────────────────────────┐               │
│ Content                     │ {"likeness":"none — illus… │               │
│ [ signal/creatives/…      ] └────────────────────────────┘               │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Every element.** The `<dl>` covers all ten list columns plus Created and
Updated. Nothing else. No preview, no rendered content, no link to the campaign,
no link to the AI run that generated it, no approval history.

**Forms — edit** (`PATCH /v1/signal/creatives/<id>`):

| Field | Label | Input | Required | Notes |
|---|---|---|---|---|
| `complianceStatus` | Compliance | Select: Pending / Passed / Flagged / Blocked | no | The verdict |
| `complianceNotesJson` | Compliance notes | JSON textarea rows=6 mono | no | The reasoning — same submit as the verdict, deliberately |
| `contentRef` | Content | text | no | Repointing the content is possible **after** it passed compliance, with no re-review trigger |

**This is where the likeness constraint lives.** The seeded video script carries
`complianceNotesJson.likeness = "none — illustrated brand character, no real
person depicted or voiced"`. Today: a truncated grey blob in the details grid
and a raw JSON textarea in the form. **What the redesign must add**, and only
here:

- A dedicated **Likeness** row in the details block for `kind` in
  {`video_script`, `social`}, with two possible renderings:
  - *No real person depicted* — plain, with the declared text.
  - *Consent on file* — the consent record's `evidenceRef`, its `version`, its
    `expiry` date, and a link to `/admin/consents/<id>`.
- A third rendering that must be visually loud: **no likeness declaration at
  all** on a creative whose kind can depict a person. That state must block the
  `passed` option in the compliance select.
- The link target already exists (`GET /v1/core/consents`, `core:consents:read`,
  which `signal.lead` and `signal.marketer` both hold). The Administration nav
  entry that hides it is gated on `core:users:read`; the link from this screen
  is what makes the consent record reachable for the people who need it.

**States.** Loading: none. Save failure: red bar. **Save under the approval
gate: red bar reading `signal.creative_publish`** and the record unchanged.
Success: silent. Denied: full-page boundary.

**AI surfaces.** "Made by: AI" badge only. `aiAuditId` exists on the row and is
never rendered — so the "why did the model write this" trail is one column away
and unreachable.

**Actions and consequences.** Every save is gated (see §6). Marking a creative
`blocked` does not, by itself, stop a live campaign from serving it — there is
no visible enforcement link between `complianceStatus` and campaign state in the
UI. There is no delete.

**Mobile.** Web only.

**RTL notes.** `<h1>` is a file path and **must be forced LTR** even in Arabic —
today it inherits page direction and a path like
`signal/creatives/motor-lp/ar.mdx` renders with reversed segment order, which is
a live bug on the Arabic locale. The `complianceNotesJson` excerpt for the
blocked Arabic creative is genuine Arabic prose inside a JSON string inside a
mono textarea — bidirectional text inside code formatting, currently unhandled.

**What is weak today.** This screen decides whether content may be published and
it never shows the content. The reviewer sees a path, a truncated JSON note and
a dropdown. The verdict cannot be recorded in one action because of the approval
gate. There is no "why this needs approval", no diff against the previous
verdict, no record of who ruled last time.

---

## 14. `/signal/signal-experiments` — Experiments (list)

**Route + title.** `/signal/signal-experiments` — note the doubled module name
in the URL, which comes from the resource key `signal-experiments` (the table
name deconflicts against other modules' experiments). Tab label
**"Experiments"** (ar: التجارب). API `GET /v1/signal/signal-experiments`.

**Who sees it.** `signal:experiments:read` — marketer, lead, signal.admin,
tenant.admin (read). Create: `signal:experiments:create` (marketer, lead).
Update: `signal:experiments:decide` (**lead only**, plus signal.admin) — a
marketer can start an experiment but not conclude one.

**Purpose.** What the team is still deciding, and on what evidence.

**Layout skeleton.**

```
Marketing
… [Experiments] …

[ State: All ▾ ] [ Apply ]

  + New — Experiments

┌────────────────────────────────────────────────────────────────────────────────┐
│ HYPOTHESIS                       │CAMPAIGN│METRIC         │ MIN SAMPLE │STATE   │CONCLUDED│CREATED ↕│
│ An Arabic-first landing page wi… │cmp_01J…│quote_start_ra…│      4,000 │[Conclu]│14 Jun   │02 May   │
│ A discount-led headline beats a… │cmp_01J…│ctr            │      6,000 │[Conclu]│20 Jun   │10 May   │
│ A 45-day nudge outperforms a 30… │cmp_01J…│renewal_rate   │      2,500 │[Runni] │—        │01 Jul   │
└────────────────────────────────────────────────────────────────────────────────┘
  5 shown                                                              [Previous][Next]
```

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Hypothesis (`hypothesis`) | text | start | no | Link into the record; a full sentence truncated at 80 chars — usually cut mid-claim |
| 2 | Campaign (`campaignId`) | text | start | no | Raw id, no link; `null` for the AEO experiment |
| 3 | Metric (`metric`) | text | start | no | Raw metric key, e.g. `quote_start_rate`, `ctr`, `renewal_rate` |
| 4 | Minimum sample (`minSample`) | number | **end** | no | — |
| 5 | State (`state`) | text, **badge** | start | no | Draft (grey) / Running (**blue**) / Concluded (grey) / Abandoned (grey) |
| 6 | Concluded (`concludedAt`) | datetime | start | no | "—" while running |
| 7 | Created (`createdAt`) | datetime | start | **yes** | — |

**Filter.** State: All / Draft / Running / Concluded / Abandoned.

**Forms — create.**

| Field | Label | Input | Required | Notes |
|---|---|---|---|---|
| `hypothesis` | Hypothesis | `<Textarea rows=3>` | **yes** | — |
| `campaignId` | Campaign | text | no | Raw id |
| `variantsJson` | Variants | JSON textarea rows=6 | **yes** | The A/B arms |
| `metric` | Metric | text | **yes** | Free text — nothing constrains it to metrics that exist |
| `minSample` | Minimum sample | `type="number" step=1` | no | Nothing enforces it before concluding |

**States.** As §8.

**AI surfaces.** None.

**Actions and consequences.** Concluding an experiment (`state: concluded` +
`resultJson`) is not gated by any approval. It is also not enforced against
`minSample` — a lead can conclude a two-visit experiment.

**Mobile.** Web only.

**RTL notes.** `hypothesis` is prose and mirrors correctly. `metric`,
`campaignId` and `variantsJson` are LTR data.

**What is weak today.** The result is where the value is and it is not a column:
`resultJson` never appears in the list. The seeded data holds
`+280 bps` with `probabilityToBeatControlBps: 9870` on the winning Arabic-first
landing page, `-50 bps` on the losing discount headline, and a genuinely
important abandonment reason — *"Only 38% of the audience holds a WhatsApp
opt-in…"* with `reachableShareBps: 3800`. None of it is visible until the record
page, and even there it is a truncated blob. A concluded experiment and an
abandoned one look identical (both grey).

---

## 15. `/signal/signal-experiments/:id` — Experiment (record)

**Route + title.** `/signal/signal-experiments/<exp_…>`. `<h1>` is the
**hypothesis sentence** — the only SIGNAL heading that reads like a sentence.
Subtitle `Experiments · exp_01J…`.

**Who sees it.** `signal:experiments:read`; edit form needs
`signal:experiments:decide` (lead / signal.admin only).

**Purpose.** Record the outcome of one experiment.

**Layout skeleton.**

```
Back to list
An Arabic-first landing page raises quote starts for Arabic-speaking visitors
Experiments · exp_01J8…

┌─ details ────────────────────────────────────────────────────────────────┐
│ Hypothesis          Campaign          Metric                             │
│ An Arabic-first la… cmp_01J8…         quote_start_rate                   │
│ Minimum sample      State             Concluded                          │
│ 4000                [Concluded]       14 Jun 2026 09:00                  │
│ Created             Updated                                              │
│ 02 May 2026         14 Jun 2026                                          │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ State                       Result                                       │
│ [ Concluded ▾ ]             ┌────────────────────────────┐               │
│ Concluded                   │ {"winner":"ar-first","upli │               │
│ [ 2026-06-14T09:00 ]        │ ftBps":280,…}              │               │
│                             └────────────────────────────┘               │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Every element.** `<dl>` over the seven list columns + Created + Updated.
`variantsJson` and `resultJson` are **not columns**, so the variants under test
and the result are absent from the details block — `resultJson` appears only as
an editable textarea below it.

**Forms — edit.**

| Field | Label | Input | Notes |
|---|---|---|---|
| `state` | State | Select Draft / Running / Concluded / Abandoned | — |
| `resultJson` | Result | JSON textarea rows=6 mono | Where uplift, confidence and reasoning are typed |
| `concludedAt` | Concluded | `datetime-local` | Set by hand; nothing sets it automatically when state becomes `concluded` |

**States.** Save failure → red bar; success → silent. No gate on this resource.

**AI surfaces.** None.

**Actions and consequences.** Concluding an experiment is the decision the whole
tab exists for and it carries no confirmation, no audit surface on screen, no
minimum-sample check.

**Mobile.** Web only.

**RTL notes.** The hypothesis heading mirrors correctly (it is prose). The JSON
textarea must stay LTR.

**What is weak today.** The three fields that constitute an experiment —
hypothesis, variants, result — are split across three different presentations:
one as a heading, one invisible, one as a raw textarea. There is no way to see
the two arms side by side, no way to see the metric's actual numbers, and no
link to the creatives that were the variants.

---

## 16. `/signal/budget-moves` — Budget moves (list)

**Route + title.** `/signal/budget-moves`. Tab label **"Budget moves"**
(ar: تحويلات الميزانية). API `GET /v1/signal/budget-moves`. Default sort
`ts desc`.

**Who sees it.** `signal:budget_moves:read` — marketer, lead, signal.admin,
tenant.admin (read). **No create** (the spec declares no `create` and no
`fields`, so no disclosure renders for anyone — the autopilot writes these
rows). Update requires `signal:budget_moves:approve` — **lead and signal.admin
only**; a marketer sees the ledger but can never touch it.

**Purpose.** The autopilot's ledger: every reallocation of money between
campaigns and channels, who authorised it, and how long it can be undone.

**Layout skeleton.**

```
Marketing
… [Budget moves] …

  (no filter bar at all — no search, no filters, no deleted toggle)

┌──────────────────────────────────────────────────────────────────────────────────────┐
│ REASON                    │FROM              │TO                │  AMOUNT │APPROVED BY│REVERSIBLE UNTIL│ WHEN ↕ │
│ Search converts at 2.1x … │signal_campaign:… │signal_campaign:… │AED 8,000│auto       │19 Jul 12:00    │12 Jul  │
│ Duplicated conversion pi… │signal_campaign:… │signal_campaign:… │AED 3,200│auto       │16 Jul 09:00    │09 Jul  │
│ Bound exceeded — release… │signal_campaign:… │signal_campaign:… │AED15,000│user:usr_…│—               │02 Jul  │
│ Autopilot proposes a shi… │signal_campaign:… │signal_campaign:… │AED24,000│pending    │—               │28 Jul  │
└──────────────────────────────────────────────────────────────────────────────────────┘
  6 shown                                                                    [Previous][Next]
```

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Reason (`reason`) | text | start | no | Link into the record. A sentence, truncated at 80 chars |
| 2 | From (`fromRef`) | text | start | no | Raw ref like `signal_campaign:cmp_01J…#meta` — the `#` suffix is the channel |
| 3 | To (`toRef`) | text | start | no | Same shape, e.g. `…#google_search` |
| 4 | Amount (`amountMinor`) | **money**, currency from the sibling `currency` column | **end** | no | Renders as AED with correct minor-unit scaling |
| 5 | Approved by (`approvedBy`) | text | start | no | `.notNull()` in the schema. Seeded values are the literal strings `"auto"`, a `user:usr_…` ref, and — on the one waiting row — the literal string **`"pending"`** |
| 6 | Reversible until (`reversibleUntil`) | datetime | start | no | Always `ts + 7 days` in the seed |
| 7 | When (`ts`) | datetime | start | **yes** | Default sort, descending |

**Filters.** **None.** No search, no filter select, no deleted toggle — this is
the only SIGNAL list with no filter bar at all, so the entire `<Form
method="get">` block is absent and the table starts immediately under the tabs.
There is no way to find only the reversible moves, only the pending ones, or
only the ones over a threshold.

**Forms.** No create form (list). The record page has an edit form — see §17.

**States.** Empty: "Nothing here yet" / "No records match this view. Clear the
filters, or create the first one." — **wrong copy for this screen**, since there
are no filters to clear and nothing can be created here. Loading: none. Denied:
full-page boundary.

**AI surfaces.** None visible. Every seeded move was written by
`system:signal.budget_autopilot`; the pending ones raise approvals whose
`requestedBy` is that same system ref. Because `approvals.tsx` computes
`agentRaised = requestedBy.startsWith("agent:") || Boolean(runs[row.id])`, the
`system:` prefix does not match and **no ✦ appears even on the approvals
screen**. Money moved by an autonomous process is presented as if a person moved
it.

**Actions and consequences.** This screen is a record of **money that has
already moved**. The seeded ledger: AED 8,000 brand→search (auto); AED 3,200
auto and later **reversed** by the growth lead for a duplicated conversion pixel
(the reversal detail is nested inside `evidenceJson.reversal`, never rendered);
AED 2,500 travel remainder; AED 15,000 approved by the growth lead because it
exceeded `autopilotBoundMinor` (AED 10,000); AED 1,800 bing→google; and
**AED 24,000 sitting with `approvedBy: "pending"` and
`evidenceJson.requiresApproval: true`** waiting on `/approvals`. The only human
action available is a reversal, and it is only possible before
`reversibleUntil`. **A reversal is irreversible** — there is no un-reverse.

**Mobile.** Web only.

**RTL notes.** The amount column must stay end-aligned and the currency must
render per the Arabic locale (`AED ٨٬٠٠٠٫٠٠` vs `AED 8,000.00`) — the `Money`
primitive handles this. `fromRef` / `toRef` are LTR identifiers and must be
forced LTR; today they mirror and read as garbage in Arabic.

**What is weak today.** The row whose `approvedBy` is the literal string
`"pending"` is styled exactly like the rows that actually happened — same weight,
same colour, same position in a `ts`-sorted list. AED 24,000 waiting on a human
decision is indistinguishable from AED 8,000 already spent, and there is no link
from that row to the approval that would release it. The seven-day reversal
window is shown as a bare timestamp with no urgency treatment and no countdown;
a move with two hours left looks like one with six days. `fromRef`/`toRef` are
raw composite identifiers — the user cannot see that money moved *from December
brand on Meta to Motor always-on on Google Search* without decoding two id
strings. And `evidenceJson`, which holds the autopilot's actual reasoning and
any reversal record, is not a column at all.

---

## 17. `/signal/budget-moves/:id` — Budget move (record)

**Route + title.** `/signal/budget-moves/<bmv_…>`. `<h1>` is the **reason**
sentence. Subtitle `Budget moves · bmv_01J…`.

**Who sees it.** `signal:budget_moves:read`; edit form requires
`signal:budget_moves:approve` (lead / signal.admin).

**Purpose.** Read one move and, within the window, reverse it.

**Layout skeleton.**

```
Back to list
Search converts at 2.1x the blended rate; brand has surplus
Budget moves · bmv_01J8…

┌─ details ────────────────────────────────────────────────────────────────┐
│ Reason              From               To                                │
│ Search converts a…  signal_campaign:…  signal_campaign:…                 │
│ Amount              Approved by        Reversible until                  │
│ AED 8,000.00        auto               19 Jul 2026 12:00                 │
│ When                Created            Updated                           │
│ 12 Jul 2026 12:00   12 Jul 2026        12 Jul 2026                       │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ Reversed by                 Reversed                                     │
│ [                       ]   [                    ]                       │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
```

**Forms — edit** (`PATCH /v1/signal/budget-moves/<id>`):

| Field | Label | Input | Required | Notes |
|---|---|---|---|---|
| `reversedBy` | Reversed by | **plain text input** | no | The user types an actor ref by hand |
| `reversedAt` | Reversed | `datetime-local` | no | The user types the reversal time by hand |

That is the entire reversal mechanism: two free-text-ish fields and "Save
changes". Nothing validates that `reversedAt` is before `reversibleUntil`.
Nothing populates `reversedBy` with the signed-in actor. Nothing prevents
reversing an already-reversed move.

**States.** Save → gated on `signal.budget_move` with
`amountField: "amountMinor"`; since `amountMinor` is not among the editable
fields the gate sees no amount, so `needsDualControl` compares `0` against the
policy's threshold and dual control resolves to false. The save throws 403 and
renders a red bar reading `signal.budget_move`, with a pending approval created
behind the scenes. Success: silent. Denied: full-page boundary.

**AI surfaces.** None.

**Actions and consequences.** **A reversal is money moving back.** It is gated,
it is irreversible, and the UI presents it as two optional text fields under the
heading "Edit". `reversedBy` and `reversedAt` are also **not columns**, so after
a successful reversal the record page shows no evidence that it happened —
the two fields are write-only from the UI's point of view.

**Mobile.** Web only.

**RTL notes.** As §16: refs and the mono id stay LTR; the money value formats
per locale.

**What is weak today.** The most consequential write in the module is a pair of
blank inputs the user fills in about themselves. It should be a single
**Reverse this move** action with a required reason, the actor and timestamp set
server-side, a visible countdown to `reversibleUntil`, and a hard stop after the
window closes. Everything needed to build that already exists in the schema
(`reversibleUntil`, `evidenceJson.reversal`); only the UI is missing.

---

## 18. `/signal/aeo-pages` — Answer pages (list)

**Route + title.** `/signal/aeo-pages`. Tab label **"Answer pages"**
(ar: صفحات الإجابات). API `GET /v1/signal/aeo-pages`. AEO = answer-engine
optimisation: owned pages written to be cited by answer engines.

**Who sees it.** `signal:aeo:read`. Create / update / **delete** all require
`signal:aeo:write` (marketer, lead, signal.admin). This is the **only** SIGNAL
tab that declares `remove`.

**Purpose.** The tenant's owned answer content, its freshness and whether its
claims are sourced.

**Layout skeleton.**

```
Marketing
… [Answer pages] …

[ Status: All ▾ ] [ Records shown: Live records ▾ ] [ Apply ]

  + New — Answer pages

┌────────────────────────────────────────────────────────────────────────────────┐
│ QUERY CLUSTER                    │LANG│CONTENT                │STATUS   │LAST VERIFIED│UPDATED ↕│
│ best car insurance dubai         │ en │signal/aeo/best-car-…  │[Publis] │20 Jul       │20 Jul   │
│ تأمين السيارات في دبي            │ ar │signal/aeo/ar-motor-…  │[Publis] │20 Jul       │20 Jul   │
│ car insurance renewal grace per… │ en │signal/aeo/renewal-g…  │[Stale]  │02 Apr       │02 Apr   │
└────────────────────────────────────────────────────────────────────────────────┘
  6 shown                                                              [Previous][Next]
```

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Query cluster (`queryCluster`) | text | start | no | Link into the record. The search intent, in English or Arabic |
| 2 | Language (`locale`) | text | start | no | `en` / `ar` |
| 3 | Content (`contentRef`) | text | start | no | Path string |
| 4 | Status (`status`) | text, **badge** | start | no | Draft (grey) / Published (grey) / Stale (grey) / Retired (grey) — **all four are the same grey** |
| 5 | Last verified (`freshness`) | datetime | start | no | — |
| 6 | Updated (`updatedAt`) | datetime | start | **yes** | — |

**Filters.** Status (All / Draft / Published / Stale / Retired) **and** the
deleted-records select, which appears because `canRestore` is true whenever the
actor holds `tab.remove`:

```
[ Records shown: Live records ▾ ]     options: "Live records" | "Deleted records"
```

**This select is broken.** `signal_aeo_pages` has **no `deletedAt` column**, so
`crud.ts` throws `badRequest("signal/aeo-pages has no soft delete")` on
`?deleted=1`. Selecting "Deleted records" and pressing Apply produces the
full-page error boundary: **"This did not load" / "The page could not be built.
Nothing was saved, and you can try again."** The `canRestore` heuristic infers
soft-deletability from the `remove` permission, which is wrong for this table.

**Forms — create.**

| Field | Label | Input | Required |
|---|---|---|---|
| `queryCluster` | Query cluster | text | **yes** |
| `contentRef` | Content | text | **yes** |
| `locale` | Language | text | no |

**States.** Empty / filtered-empty / loading / error as §8, plus the
deleted-view banner (`role="status"`, amber `border-warning/40 bg-warning/10`)
which **can never legitimately appear here** because the query that would show
it always 400s first.

**AI surfaces.** None, despite this being the most obviously AI-adjacent surface
in the module (content written to be cited by answer engines, with a machine
citation check).

**Actions and consequences.** Create, update and **delete**. The delete button
sits on the record page and is confirmed with `common.deleteConfirm`:

> "Delete this record? It is retained for audit and can be restored by an
> administrator."

**That sentence is false here.** With no `deletedAt` column, `crud.ts` executes
a real `DELETE`. The row is gone permanently, and the copy promised otherwise.
This is the most serious correctness bug in the SIGNAL UI.

**Mobile.** Web only.

**RTL notes.** `queryCluster` is genuine user-facing content in both scripts —
the seeded list mixes `best car insurance dubai` and `تأمين السيارات في دبي` in
the **same column**, so this cell needs per-cell direction handling
(`dir="auto"`), which it does not have today. In an Arabic UI the English
clusters mis-render and vice versa. `contentRef` stays LTR.

**What is weak today.** `citedByJson` — which answer engines actually cite this
page (the seeded top page is cited by ChatGPT and Perplexity) — is **not a
column and not in the editable list**, so the one metric that says whether the
whole AEO effort works is invisible. `citationsCheckJson` is editable but not
displayed as a column, and its content is exactly the claim-sourcing audit that
matters: the top page reads *9 claims / 9 sourced*; the stale page reads *7
claims / 6 sourced / 1 unverified with a note*. That single unverified claim on
a **published** page is the thing a compliance officer would want to see, and it
appears nowhere. Four statuses share one grey.

---

## 19. `/signal/aeo-pages/:id` — Answer page (record)

**Route + title.** `/signal/aeo-pages/<aeo_…>`. `<h1>` is the **query cluster**.
Subtitle `Answer pages · aeo_01J…`.

**Who sees it.** `signal:aeo:read`; edit and delete need `signal:aeo:write`.

**Purpose.** Publish, retire or re-verify one answer page.

**Layout skeleton.**

```
Back to list
car insurance renewal grace period uae
Answer pages · aeo_01J8…

┌─ details ────────────────────────────────────────────────────────────────┐
│ Query cluster       Language          Content                            │
│ car insurance ren…  en                signal/aeo/renewal-grace/en.mdx    │
│ Status              Last verified     Updated                            │
│ [Stale]             02 Apr 2026       02 Apr 2026                        │
│ Created                                                                  │
│ 14 Jan 2026                                                              │
└──────────────────────────────────────────────────────────────────────────┘

┌─ Edit ───────────────────────────────────────────────────────────────────┐
│ Status                      Content                                      │
│ [ Stale ▾ ]                 [ signal/aeo/renewal-grace/en.mdx        ]   │
│ Citation check                                                           │
│ ┌────────────────────────────┐                                           │
│ │ {"claims":7,"sourced":6,"u │                                           │
│ │ nverified":[{"claim":"…"}] │                                           │
│ └────────────────────────────┘                                           │
│ [ Save changes ]                                                         │
└──────────────────────────────────────────────────────────────────────────┘
────────────────────────────────────────────────────────────────────────────
[ Delete ]                                                    (danger, sm)
```

**Forms — edit.**

| Field | Label | Input | Notes |
|---|---|---|---|
| `status` | Status | Select Draft / Published / Stale / Retired | — |
| `contentRef` | Content | text | Path |
| `citationsCheckJson` | Citation check | JSON textarea rows=6 mono | Editable but not shown in the details block above |

**Delete.** `<Button variant="danger" size="sm">Delete</Button>` in its own form
below a `border-t` divider, guarded by a native `confirm()` with the
`common.deleteConfirm` text. On success it redirects to
`/signal/aeo-pages`. As established in §18, the deletion is **permanent** and
the confirm copy misstates it.

**States.** Save failure → red bar; success → silent. Delete failure → red bar.

**AI surfaces.** None.

**Actions and consequences.** Publishing is ungated (no approval policy on this
resource). Deleting is permanent and irreversible.

**Mobile.** Web only.

**RTL notes.** The `<h1>` may be Arabic or English depending on the row — needs
`dir="auto"`. The JSON textarea stays LTR.

**What is weak today.** Beyond the delete bug: the "Stale" status is set by hand
with no relationship to `freshness`, so a page can read "Published / last
verified four months ago" with nothing prompting a re-check. The unverified
claim inside `citationsCheckJson` is the reason the page is stale and it is only
legible by reading raw JSON in the edit textarea.

---

## 20. `/signal/attribution-events` — Attribution (list)

**Route + title.** `/signal/attribution-events`. Tab label **"Attribution"**
(ar: الإسناد). API `GET /v1/signal/attribution-events`. Default sort `ts desc`.

**Who sees it.** `signal:attribution:read` — marketer, lead, signal.admin,
tenant.admin (read), **`north.exec`, `north.analyst`**. Registered
`immutable: true` in the API: **no create, no update, no delete for anyone.**

**Purpose.** Every recorded touch on the path to a sale, as it landed.

**Layout skeleton.**

```
Marketing
… [Attribution] …            (for north roles: only two tabs render — Attribution, Spend)

[ Touch: All ▾ ] [ Apply ]

┌────────────────────────────────────────────────────────────────────────────────┐
│ SUBJECT                │CUSTOMER   │TOUCH        │CHANNEL       │CAMPAIGN │  VALUE│ WHEN ↕│
│ signal_creative:crv_…  │—          │[Impression] │google_search │cmp_01J… │      —│04 Jul │
│ signal_creative:crv_…  │—          │[Click]      │google_search │cmp_01J… │      —│04 Jul │
│ signal_aeo_page:aeo_…  │—          │[Visit]      │answer_engine │—        │      —│05 Jul │
│ dist_quote_request:q…  │cus_01J8…  │[Lead]       │google_search │cmp_01J… │      —│06 Jul │
│ axis_case:cas_01J8…    │cus_01J8…  │[Bind]       │google_search │cmp_01J… │AED4,480│08 Jul│
└────────────────────────────────────────────────────────────────────────────────┘
  8 shown                                                              [Previous][Next]
```

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Subject (`subjectRef`) | text | start | no | Link into the record. A cross-module ref: `signal_creative:…`, `signal_aeo_page:…`, `dist_quote_request:…`, `axis_case:…`. **None of these are links to the referenced record** |
| 2 | Customer (`customerId`) | text | start | no | Raw id or "—" for anonymous pre-identification touches |
| 3 | Touch (`touchType`) | text, **badge** | start | no | Impression / Click / Visit / Lead / Bind — **all five neutral grey** |
| 4 | Channel (`channel`) | text | start | no | `google_search`, `bing_search`, `meta`, `email`, `answer_engine` |
| 5 | Campaign (`campaignId`) | text | start | no | Raw id; empty on the answer-engine visit |
| 6 | Value (`valueMinor`) | **money** from sibling `currency` | **end** | no | Only populated on `bind` |
| 7 | When (`ts`) | datetime | start | **yes** | Default sort, descending |

**Filter.** Touch: All / Impression / Click / Visit / Lead / Bind.

**Forms.** None — immutable resource, no create disclosure, no edit form on the
record page.

**States.** As §8; the empty-state copy again invites the user to "create the
first one" on a resource nobody can create.

**AI surfaces.** None.

**Actions and consequences.** Read only.

**Mobile.** Web only.

**RTL notes.** Every value in this table except the money column is an ASCII
identifier or snake_case token and must be forced LTR. The money column stays
end-aligned and locale-formatted.

**What is weak today.** The seeded data contains a **complete stitched journey**:
`anonId: "an_2f7c91b4"` sees an impression, clicks, visits, then visits an
answer page, is stitched to an identified customer, becomes a lead against a
real `dist_quote_request`, and binds for **AED 4,480**, pointing at a real
`axis_case`. That is the single most compelling story in the module's data, and
the UI presents it as seven unrelated grey rows sorted by time, mixed in with a
second journey (`an_84b0d2e1`) that stops at the visit. `anonId` — the column
that groups a journey — **is not displayed at all**. There is no grouping, no
funnel, no journey view, no filter by customer or by campaign, and the refs do
not link anywhere. An analyst cannot answer "what did this campaign produce"
without exporting the table.

---

## 21. `/signal/attribution-events/:id` — Attribution event (record)

**Route + title.** `/signal/attribution-events/<atr_…>`. `<h1>` is the
**subjectRef** string. Subtitle `Attribution · atr_01J…`.

**Who sees it.** `signal:attribution:read` (includes north roles).

**Purpose.** One touch, in full.

**Layout skeleton.**

```
Back to list
axis_case:cas_01J8…
Attribution · atr_01J8…

┌─ details ────────────────────────────────────────────────────────────────┐
│ Subject             Customer          Touch                              │
│ axis_case:cas_01J…  cus_01J8…         [Bind]                             │
│ Channel             Campaign          Value                              │
│ google_search       cmp_01J8…         AED 4,480.00                       │
│ When                Created                                              │
│ 08 Jul 2026 14:22   08 Jul 2026 14:22                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

Nothing below the details block: no actions, no edit form, no delete.

**Every element.** Back link, heading, subtitle, one `<dl>` of seven columns
plus Created (and Updated if present). That is the whole screen.

**States.** Loading none; not-found / denied → full-page boundary.

**AI surfaces.** None.

**Actions and consequences.** None. Immutable.

**Mobile.** Web only.

**RTL notes.** Force LTR on every identifier; money formats per locale.

**What is weak today.** A read-only page with seven values and no links is
strictly worse than the row it came from — the user loses the surrounding
journey by opening it. `anonId` and `creativeId` exist on the row and are not
shown, so the record cannot even answer "which creative was this?".

---

## 22. `/signal/spend` and `/signal/spend/:id` — Spend

**Route + title.** `/signal/spend` and `/signal/spend/<spd_…>`. Tab label
**"Spend"** (ar: الإنفاق). API `GET /v1/signal/spend`. Default sort `day desc`.

**Who sees it.** `signal:spend:read` — marketer, lead, signal.admin,
tenant.admin (read), **`north.exec`, `north.analyst`**. No create, no update, no
delete anywhere.

**Purpose.** Actual money spent per channel per day, as reported by the ad
platforms.

**Layout skeleton (list).**

```
Marketing
… [Spend]

[ Source: All ▾ ] [ Apply ]

┌──────────────────────────────────────────────────────────────────────────────────────┐
│ DAY ↕      │CHANNEL      │CAMPAIGN │    AMOUNT│IMPRESSIONS│ CLICKS│CONVERSIONS│SOURCE  │ WHEN ↕│
│ 2026-01-05 │google_search│cmp_01J… │AED3,412.0│    182,400│  4,102│         38│[API]   │06 Jan │
│ 2026-01-04 │meta         │cmp_01J… │AED1,180.0│     96,300│  1,244│          9│[API]   │05 Jan │
│ 2026-01-01 │google_search│cmp_01J… │AED2,905.0│    150,110│  3,388│         31│[Import]│30 Jul │
└──────────────────────────────────────────────────────────────────────────────────────┘
  12 shown                                                                  [Previous][Next]
```

**Table columns.**

| # | Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|---|
| 1 | Day (`day`) | **text** | start | **yes** | An ISO date **string**, not a date type — so it renders raw as `2026-01-05` regardless of locale, and never localises |
| 2 | Channel (`channel`) | text | start | no | `google_search` / `bing_search` / `meta` / `email` |
| 3 | Campaign (`campaignId`) | text | start | no | Raw id, no link |
| 4 | Amount (`amountMinor`) | **money** from sibling `currency` | **end** | no | — |
| 5 | Impressions (`impressions`) | number | **end** | no | — |
| 6 | Clicks (`clicks`) | number | **end** | no | — |
| 7 | Conversions (`conversions`) | number | **end** | no | — |
| 8 | Source (`source`) | text, **badge** | start | no | API / Import / (manual) — all grey |
| 9 | When (`ts`) | datetime | start | **yes** | When the import landed, not the day it covers |

`signal_spend` carries `uniqueIndex(tenantId, campaignId, channel, day)` and has
**no `createdAt`/`updatedAt`**, so the record page's `<dl>` shows the nine
columns and nothing else.

**Filter.** Source: All / Manual / API / Import.

**Forms.** None anywhere.

**States.** As §8, including the inapplicable "create the first one" copy.

**AI surfaces.** None.

**Actions and consequences.** Read only.

**Record page.** `<h1>` is the **day string** (`2026-01-05`) — the least
identifying heading in the module, since several rows share a day. Subtitle
`Spend · spd_01J…`. A `<dl>` of the nine columns. No form, no actions.

**Mobile.** Web only.

**RTL notes.** All four numeric columns must stay end-aligned and LTR-numeric;
channel tokens and campaign ids force LTR; the `day` string is ISO and stays
LTR. Column order mirrors.

**What is weak today.** No totals row, no month-to-date, no comparison against
the campaign's `periodCapMinor`, no derived CPC or CPA even though clicks,
conversions and amount are all right there. The `day` vs `ts` distinction — the
whole reason both columns exist, per the spec's own comment — is invisible: the
seeded New Year's Day row was imported **twelve hours ago** (source `import`)
while every other row landed at 03:00 the morning after its day, and nothing on
screen flags that one figure was restated seven months late. The only difference
is a grey "Import" badge next to eleven grey "API" badges.

---

## 23. `/approvals` — where SIGNAL's gated actions land

Not a SIGNAL route, but SIGNAL's approvals surface here and no SIGNAL screen
links to it. Route `/approvals` (`apps/web/app/routes/approvals.tsx`), inside
the same workspace layout. This screen owns its **own** en+ar label table.

**Who sees it.** Pending items come from `GET /v1/me/inbox` — filtered to
policies whose `decide` permission the actor holds, so `signal.lead` sees
budget-move and creative-publish requests, and `tenant.compliance` sees
creative-publish requests. Decided history comes from
`GET /v1/core/approvals?decision=…&sort=requestedAt&order=desc&limit=25` and
requires `core:approvals:read`; without it the section shows *"Decisions across
the tenant are not yours to read, so this list stays empty."*

**Copy in use** (verbatim):

- Title: **"Approvals"**
- Intro: *"Actions that need a person before they take effect. A decision is
  final and is written to the audit log."*
- Section heading: *"Why this needs approval"*
- Dual control on: *"Two people: whoever raised this may not decide it."*
  Off: *"One approver."*
- Reason hint: *"Required to reject, kept with the decision in the audit log."*
- Reject confirm: *"Reject this request? A decision cannot be undone."*
- Empty pending: *"Nothing is waiting for your decision."*
- After approving (`role="status"`): *"Approved. The action may now proceed."*

**Layout skeleton.**

```
Approvals
Actions that need a person before they take effect. A decision is final and is
written to the audit log.

┌─ pending item ───────────────────────────────────────────────────────────┐
│ signal.budget_move                              [subject link]           │
│ Why this needs approval                                                  │
│   Amount            AED 24,000.00                                        │
│   From              signal_campaign:cmp_…#meta                           │
│   To                signal_campaign:cmp_…#google_search                  │
│   Bound             AED 10,000.00                                        │
│   One approver.                                                          │
│ [ Approve ]   Reason [                    ] [ Reject ]                   │
└──────────────────────────────────────────────────────────────────────────┘
```

**The "why" list.** `OWN_FIELD = {amountMinor, currency, dualControl,
expiresAt}` are rendered specially; **every other key in `contextJson` is
listed**. The seeded SIGNAL approvals carry
`{amountMinor, currency: "AED", dualControl: false, fromRef, toRef, boundMinor:
1_000_000}`, so the reviewer does see the from/to refs and the autopilot bound —
as raw refs.

**The ✦ marker.** `agentRaised = requestedBy.startsWith("agent:") ||
Boolean(runs[row.id])`. The seeded SIGNAL approvals are raised by
`system:signal.budget_autopilot`, which starts with `system:`, not `agent:`, and
has no linked `ai_run`. **So no ✦ appears on them.** An autonomous budget
reallocation is presented with no indication that a machine proposed it.

**Broken subject link.** `subjectOf("budget-moves:<id>")` resolves the resource
against `tab.api.endsWith("/" + resource)` and builds
`` `/${workspace.path}/${tab.key}/…` `` — but `workspace.path` is already
`"/signal"`, so the produced href is **`//signal/budget-moves/<id>`** with a
double slash, which the browser reads as a protocol-relative URL to the host
`signal`. The link out of an approval into the money it concerns does not work.

**What is weak today.** The **generic** SIGNAL screens never link *to* this
screen: the user who hits the red `signal.creative_publish` bar has no path
forward except knowing that `/approvals` exists. The nine bespoke screens do —
the `Gate` panel of §4b ends in an "Open approvals" link — so the forward half
of the journey is fixed on nine screens and missing on eight. The return half is
broken everywhere: this screen's link back into SIGNAL still produces the
double-slash href above, for bespoke and generic subjects alike.

---

## 24. Mobile (Expo app)

`apps/mobile/src/nav.ts` maps `"/signal": "signal/campaigns"`. That is the
entire SIGNAL mobile surface.

**List** (`app/m/[nav]/index.tsx`): a `FlatList` fed by
`listRows(token, "signal/campaigns")` → `GET /v1/signal/campaigns?limit=50`.
Each row shows a title (the `name`) and a subtitle (the `state` value, raw). A
`nav.back` button at the top. While loading: the text `app.loading` "Loading".
On error: a `Notice` with the message and the request id.

**Record** (`app/m/[nav]/[id].tsx`): every field of the row, verbatim, in
declaration order, with object values `JSON.stringify`'d with two-space indent —
so `budgetJson` and `channelsJson` appear as multi-line raw JSON. **No edit, no
actions, no approvals, no delete.**

Everything else in SIGNAL — audiences, creatives, experiments, budget moves,
answer pages, attribution, spend — is **web only**. So are **all nine bespoke
screens**: there is no mobile cockpit, no mobile studio, no mobile budget
screen, and the mobile app has no concept of the SIGNAL shell. A growth lead
cannot approve a budget move from a phone; the approvals screen is web only too.

For a designer this is the module's largest coverage gap: the campaign chain of
§7.11 — argue, plan, draft, clear, launch — is a desktop-only journey end to
end, and the one screen that reached the phone is the raw campaign table.

---

## 25. RTL and i18n rules for the whole module

- All labels come from i18n keys. Shared chrome uses `apps/web/app/i18n/en.ts`
  (`common.*`, `nav.*`, `error.*`). **Module vocabulary lives in
  `apps/web/app/modules/signal.ts`'s own `labels` table**, en + ar, per
  CLAUDE.md §14 — so the domain pack can rename "Campaigns" without touching
  code. A designer must not introduce hard-coded English strings, and must not
  introduce industry nouns ("policy", "premium", "insurer") into SIGNAL chrome.
- Layout must use logical properties only (`margin-inline-start`, `text-start`,
  `text-end`). The existing code already does.
- **What mirrors:** the sidebar, the tab strip, the filter bar, table column
  order, the details grid, form grids, button rows, the pager.
- **What must not mirror** (and today wrongly does, because nothing sets
  `dir="ltr"`): every `*Ref` and `*Id` value (`ownerRef`, `fromRef`, `toRef`,
  `subjectRef`, `campaignId`, `audienceId`, `customerId`), every `contentRef`
  file path, every mono record id in a subtitle, every JSON textarea and JSON
  cell, `locale` codes, `channel` and `source` tokens, the ISO `day` string, and
  metric keys like `quote_start_rate`.
- **What needs `dir="auto"` per value:** `queryCluster` on Answer pages (the
  seeded list genuinely mixes English and Arabic in one column) and any future
  rendered creative content.
- Numbers use `tabular-nums`; money renders through the `Money` primitive, which
  **refuses to render without a currency** and degrades to a bare number rather
  than guessing.
- Arabic labels already exist for all 8 tabs, all 55 column names and all 26
  enum values — see the `ar` block in `apps/web/app/modules/signal.ts`. Any new
  label needs both.

---

## 26. Accessibility notes (current state, to preserve)

- Tab strip is `<nav aria-label="Sections">` + `<ul>` + `<Link aria-current="page">`.
- Filter bar is `<Form method="get">`, with `role="search"` only where a search
  input exists (Campaigns). Every `Select` carries an `aria-label` from the
  label table.
- Tables have an `sr-only` `<caption>` reading `"Marketing — {Tab}"`; sortable
  headers are real `<button>`s with `aria-sort`.
- Every row's link target is the **first cell**, not the whole row — one
  predictable, keyboard-reachable target per row. Keep this.
- Errors use `role="alert"`; the deleted-view banner and the post-action
  confirmation use `role="status"`.
- Focus rings are `outline-2 outline-offset-2 outline-accent` throughout.
- Deletion confirms via native `confirm()`. Not a design pattern to keep, but do
  not replace it with something less blocking.

On the nine bespoke screens, additionally:

- The shell's main region is a focusable landmark the skip link targets, so
  keyboard users reach content without walking the module rail.
- The window selectors on the cockpit, budget, audience-value and analytics
  screens are `<nav>`s of links with `aria-current="page"` on the active one —
  not buttons, so the window is bookmarkable and announced as navigation.
- The refusal panel is `role="status"` when it is an approval and
  `role="alert"` when it is an error, so a queued action is not announced as a
  failure.
- Progress bars carry their label as accessible name; where a figure also needs
  reading (analytics cohorts) the figure is printed as text beside the bar
  rather than folded into the bar's label.
- The Studio's step strip is an ordered list with the current step marked, so
  position in the chain is available without colour.

---

## 27. Summary of what is weak, in priority order

The module's central problem is now the **split between the two chromes** (§3):
the nine bespoke screens carry the explanations, the ✦ marks, the money
discipline and the approval panel; the eight generic tabs carry none of it, and
the actors most likely to be blocked — compliance, tenant admins, executives —
can only reach the generic ones.

1. **Four roles are 403 on every designed screen.** Shell entitlement is
   derived from a role's prefix, so `tenant.admin`, `tenant.compliance`,
   `north.exec` and `north.analyst` cannot open the cockpit, the studio or the
   budget screen — while the "Reports" link row on `/signal` cheerfully offers
   them all nine, because those links are gated on permission instead (§4b, §5,
   §7). Every one is a link to a full-page error.
2. **The approval gate is invisible on the generic screens.** A blocked save
   there still shows one red line reading `signal.creative_publish` or
   `signal.budget_move` — no explanation, no policy name, no link. The bespoke
   screens already render the panel that fixes it ("Waiting for an approver",
   the policy, a link to `/approvals`); it was simply never wired into the
   generic record screen (§6).
3. **No ✦ on the generic screens**, contrary to CLAUDE.md §11: AI-generated
   creatives carry only a grey "AI" badge, `aiAuditId` is never surfaced, and
   autopilot-raised approvals do not register as agent-raised because
   `system:` is not `agent:` (§12, §16, §23). The bespoke screens do carry the
   mark and an inspectable "why".
4. **The whole campaign argument is invisible on the generic campaign record.**
   The plan, the three probabilities, the targeting pool and its per-band
   reasons all live in JSON columns rendered as truncated grey monospace
   (§7.11, §11).
5. **`/signal` is still the audiences list wearing a shorter URL.** The overview
   exists at `/signal/cockpit`; the module's front door does not go there, and
   the nine links that would take you are 12px grey text under the tab strip
   (§7).
6. **`/signal/aeo-pages` delete is permanent while the confirm text promises
   restoration**, and the "Deleted records" filter it offers always errors.
7. **Money is invisible where money is decided — on the generic screens.**
   Campaigns show no budget, no spend to date, no cap; budget moves show refs
   instead of names; Spend has no totals. The cockpit, budget and analytics
   screens show all of it, to a smaller audience.
8. **Badge tones are meaningless on the generic screens.** `blocked` =
   `pending` (amber); `passed` = `flagged` = `retired` = `bind` = `impression`
   (grey). The Studio already renders the compliance states in distinct,
   correct tones (§7.2) — the generic tab should adopt them.
9. **JSON textareas for `budgetJson`, `channelsJson`, `definitionJson`,
   `variantsJson`, `resultJson`, `complianceNotesJson`, `citationsCheckJson`.**
   Seven structured objects edited as raw text by non-engineers — including the
   budget object the budget screen edits with three labelled fields.
10. **Withholding is inconsistent between the chromes.** The generic screens
    hide what you may not use; some bespoke screens instead render the control
    **disabled** with "Your role does not include this view." Two different
    grammars for the same fact (§5).
11. **The likeness/consent record has no home** beyond a truncated JSON key
    (§2, §13).
12. **The attribution journey is shredded** into ungrouped rows; `anonId`, the
    column that stitches them, is not displayed.
13. **Cross-module refs are never links**: `campaignId`, `audienceId`,
    `subjectRef`, `ownerRef`, `customerId` are all dead text — and the one link
    that does exist, from an approval back to its budget move, produces a
    double-slash href that leaves the site (§23).
14. **Written-but-never-rendered data**: `guardrailChecksJson` (frequency caps,
    quiet hours, suppression applied, banned-claims pass), `citedByJson`,
    `evidenceJson`, `aiAuditId`, `anonId`, `creativeId`. The admin screen
    (§7.8) renders the guardrail configuration but no screen renders the
    per-campaign check results.
15. **Reversal of a budget move is two blank inputs** on the generic record
    screen, with no window enforcement; the budget screen's Undo does the same
    job in one click and knows the window (§7.6).
16. **No save confirmation on the generic screens.** A successful PATCH renders
    the same page with no message. The bespoke screens confirm every write in a
    sentence.
17. **Empty-state copy invites creation on read-only resources** (budget moves,
    attribution, spend) — and on the budget-moves list it offers to clear
    filters that do not exist.
18. **`ZAR` is the fallback currency on four bespoke screens.** With no spend
    rows in the window, the studio, budget, audience-value and analytics
    screens render money in the platform default rather than the tenant's
    currency, so an empty Gulf tenant reads in Rand (§7.3).
19. **The campaign chain is desktop-only.** Mobile is one raw campaign table
    (§24).

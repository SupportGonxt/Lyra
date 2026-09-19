# SCOUT — market intelligence, screen by screen

**Updated 2026-08-19.** Written for a designer with no access to the repository:
everything you need to design against is in the prose here. It describes what is
**actually built today**. Anything specced but unbuilt is marked **not yet
built**. Where the code does not say, this file says "not determined from code"
rather than guessing. Code is the authority; if this file and a screen disagree,
the screen is right and this file is a bug.

This is a rewrite. The previous version (2026-07-30) described a SCOUT made
entirely of generated tables, with no bespoke screens, no charts and no AI
markers anywhere. All three of those claims are now false and have been deleted
rather than hedged — see §14 for the list, so anyone holding the old file knows
what to stop believing.

---

## 1. Orientation

1. **SCOUT is the market-intelligence module.** It answers three questions:
   what is the market asking for that we do not sell (*whitespace*), where do we
   sit against the carriers we quote alongside (*panel and price benchmarks*),
   and what can we package and sell back to that panel (*data products*).

2. **Its nav label is "Market"** (Arabic: **السوق**). The word "SCOUT" is an
   internal module name and appears in exactly two user-facing strings, both on
   the module's own settings and integrator screens ("SCOUT settings", "SCOUT
   for integrators"). Everywhere else the module is called Market. Its accent
   colour is the design token `--module-scout` (a photon blue, #6e9bff) and no
   screen hard-codes that hex.

3. **SCOUT reads; it barely writes.** Signals arrive from a harvester, clusters
   are computed, benchmarks are computed. Of everything on these screens only
   four things are a human write: moving a whitespace card, creating and
   deciding an experiment, changing a data product's status, and handing a
   whitespace to the campaign studio.

4. **SCOUT owns no money and no customer.** Nothing here debits anything, and no
   individual person is ever the subject of a row. That is what makes the
   k-anonymity rules in §4.3 the module's central design constraint rather than
   a footnote.

5. **The data is our own.** Every figure on every SCOUT screen is computed from
   the tenant's own quote traffic, its own book and its own harvested signals.
   The Radar says this out loud: *"Whitespace read off our own signals, clusters
   and panel data — nothing bought in."* No screen may imply an industry survey.

6. **Its counterparties can log in.** A provider (carrier) role can hold two
   SCOUT read permissions, so a competitor of the tenant may be reading a SCOUT
   surface. Two affordances are deliberately gated *higher* than their data
   would suggest because of this — see §5.4.

7. **The module has both a hover surface and a promote flow now.** Whitespace
   commentary — one grounded sentence per candidate, with its evidence — is
   prefetched with the Radar and revealed on hover and on focus. From the
   dossier beside it, a whitespace can be handed to the SIGNAL campaign studio,
   which drafts a campaign and six creatives and sends none of them.

8. **AI is present, quiet, and marked.** SCOUT has exactly three AI-written
   artifacts on screen (§12.1). Every one carries the single ✦ marker and an
   inspectable "why". Deterministic fallback text — which reads like a sentence
   but is a template — is deliberately **not** marked. There is no chat, no
   modal, no autonomous action.

9. **SCOUT has two coexisting UIs.** Nine bespoke screens in a SCOUT-specific
   shell, and a generated six-tab CRUD workspace at the same `/scout` root.
   Both are real, both are reachable, they show the same tables in two different
   registers. §2 is entirely about that, because it is the fact a designer will
   trip on first.

10. **Nothing in SCOUT is real-time.** No screen polls, no screen streams, no
    screen has a live region that updates on its own except the draft tray after
    a promotion. Numbers change when a sweep runs or a period closes.

---

## 2. How SCOUT is built — say it plainly

There are **two SCOUT user interfaces**, and they share a URL prefix.

### 2.1 The bespoke shell — nine screens

Nine screens are hand-built, each its own layout, and they all sit inside a
SCOUT-specific chrome (§3):

| URL | Screen | § |
|---|---|---|
| `/scout/radar` | Radar — the whitespace quadrant and dossier | 10.1 |
| `/scout/whitespace/:id` | Whitespace card — the full case for one theme | 10.2 |
| `/scout/panel` | Panel intelligence — carriers on price and conversion | 10.3 |
| `/scout/pricing` | Price benchmarks — our index against the median, by line | 10.4 |
| `/scout/experiments` | Experiments — the bounded-test board | 10.5 |
| `/scout/analytics` | Pricing analytics — elasticity, adequacy, export | 10.6 |
| `/scout/data-products` | Data products — catalogue, k-monitor, subscribers | 10.7 |
| `/scout/admin` | SCOUT settings — what governs the module | 10.8 |
| `/scout/dev` | SCOUT for integrators — the two non-CRUD calls, live | 10.9 |

`/scout/whitespace/:id` is a *hidden* route: nothing in navigation points at it,
it is opened from a dot on the Radar. The other eight are the module's nav rail.

### 2.2 The generated workspace — six tabs

At the same time `/scout` itself is a **generated CRUD workspace**: six
resources rendered by the platform's generic list and record screens, exactly
like every other module's workspace. Its tabs are `signals`, `clusters`,
`whitespaces`, `panel-bench`, `scout-experiments`, `data-products` (§7), and its
record screen is `/scout/:resource/:id` (§8).

### 2.3 How the router picks between them

Static paths outrank the dynamic one. `/scout/radar` is a declared static path,
so it renders the bespoke Radar. `/scout/signals` is not, so it falls through to
the generic `:module/:resource` route and renders the generated signals table.
There is no ambiguity and no redirect — a designer just needs to know that
`/scout/panel` and `/scout/panel-bench` are two different screens over
overlapping data.

### 2.4 How a user crosses between them

The generated workspace renders a **links strip** labelled "Reports and tools"
above its tabs, and SCOUT declares eight links in it — one per bespoke screen.
Each link is permission-gated (§5.3). Those links use *different words* from the
nav rail for the same destinations, which is a real inconsistency worth fixing
(§13):

| Links-strip label (workspace) | Rail label (shell) | Destination |
|---|---|---|
| Opportunity radar | Radar | `/scout/radar` |
| Panel benchmarks | Panel | `/scout/panel` |
| Price benchmarks | Pricing | `/scout/pricing` |
| Experiments | Experiments | `/scout/experiments` |
| Pricing analytics | Analytics | `/scout/analytics` |
| Data products | Data Products | `/scout/data-products` |
| Settings | Admin | `/scout/admin` |
| For integrators | Dev | `/scout/dev` |

Going the other way — from a bespoke screen back into the generated tables —
there is **no link at all**. A user on the Radar cannot reach the raw signals
table except by typing the URL or going back through the workspace. That is a
gap, not a decision (§13).

### 2.5 SCOUT does own API routes

The module has seven bespoke endpoints of its own beyond generated CRUD. A
designer does not need their shapes, but does need to know these exist, because
each is a screen affordance with its own failure mode:

- run the whitespace sweep (a button on the Radar),
- read all whitespace commentary (the Radar's prefetch),
- read one row's commentary,
- promote a whitespace to a SIGNAL campaign (§11),
- compare two wordings word by word (integrator screen),
- find the nearest stored signals to a phrase (integrator screen),
- render the negotiation pack PDF (a button on Panel intelligence).

---

## 3. The frame every SCOUT screen sits in

The nine bespoke screens share one chrome — the "Horizon" module shell. Reading
outward from the content:

**Top band** (height is the token `--chrome-top`):
- The Constellation mark and the tenant's product name, linking to
  `/scout/radar` — SCOUT's home is the Radar, not a dashboard.
- A hairline divider, then the **tenant's served name**, truncated to 16
  characters, hidden below the `sm` breakpoint.
- A **search palette** scoped to the eight rail destinations.
- Pushed to the end of the line: posture chips, the theme toggle, a **companion
  toggle** (the ✦ glyph, shown only at `lg` and up and only to an actor who may
  read AI runs), and an account menu showing initials and the actor's role key.

**Rail** (width is the token `--rail-width`, desktop only, `md` and up):
- The module switcher (which lists every module *except* SCOUT itself),
- the shift rail,
- then the eight nav items. Each item is a text label with a 4px × 2px vertical
  accent bar at its inline start: invisible at rest, 50% on hover, full on the
  active item. Labels truncate; there are no icons and no counts.

**Below `md`** the rail collapses to a module switcher plus a horizontally
scrolling row of the same eight items.

**Canvas**: `<main>` capped at `--measure-canvas`, with a 2px accent hairline
across its top, breadcrumbs, and the screen. A skip link ("Skip to content")
precedes everything and targets it. The main element is re-keyed on every
navigation and takes focus, so each screen change announces from the top.

**Status band** (`--chrome-status`, `sm` and up): the product name and, at the
end of the line, a link to `/design` labelled "doctrine".

**A slow navigation shows a skeleton.** If a navigation has been settling for
more than 400ms the canvas renders a page skeleton rather than a spinner or a
frozen previous screen.

Three things a designer should not assume:

- **The rail is not permission-filtered.** Every actor inside the shell sees all
  eight labels, including Settings and For integrators. Clicking one an actor
  cannot use lands on a screen whose panels are individually withheld, not on a
  403. This is deliberate — a withheld panel explains itself, a missing nav item
  does not — but it means the rail is not a capability list.
- **There is no accent dot per nav item.** The accent is the vertical bar
  described above. (The old version of this doc described a 6px dot in a 240px
  sidebar; that frame no longer exists.)
- **The generated `/scout` workspace does not use this shell.** It uses the
  platform's standard workspace chrome, with the module rail and tabs. Two
  chromes, same prefix.

---

## 4. Facts from the data the design must accommodate

### 4.1 A dismissed signal has no status column

`scout_signals` is append-only: source, reference, payload, weight, observed-at,
plus which cluster it landed in. **There is no status, no dismissed flag, no
reviewed flag.** So there is no "mark as reviewed" affordance to design, no
inbox pattern, no unread count. A signal is data, not a task. Do not design a
triage queue over this table; the storage cannot hold the result.

### 4.2 Every estimate carries its own method, and "market" means our median

A whitespace's demand estimate is stored beside a small blob describing how it
was arrived at: a unit, a method, a confidence and a free-text note. Screens
that show the estimate must show that blob with it — a number whose method is
hidden is a number the reader will over-trust.

The same applies to the word **market**. The "market price index" on every
benchmark screen is *our quoted price over the median of the panel's own
responses to the same request*. It is not an industry survey, and the Price
benchmarks screen carries that sentence permanently as a note. Any new surface
using the word must carry the same qualification.

**Win rate is meaningless without volume.** A 100% win rate on three quotes is
noise. Every screen showing win rate shows volume in the same row, and the
blended figures on the analytics screen are volume-weighted, never averaged.

### 4.3 Thin cuts are withheld, not shown thin

SCOUT's central privacy rule: a cut of data below **20** underlying quotes can
name the single counterparty behind it, so it is not served at all.

- On the panel bench, a row below the floor **404s from the API**. The screen
  therefore shows a permanent notice — "Thin cuts withheld" — explaining that
  the row is missing by design, because a silently shorter table reads as a
  data bug.
- A whitespace candidate below the floor is **never written** by the sweep, so
  it cannot appear on the Radar at all.
- A whitespace whose evidence is below the floor returns commentary marked
  *suppressed*: no sentence, no evidence, no AI marker (§9.3).
- A promotion of a below-floor whitespace is refused (§11.3).
- A data product may set its own floor, but a floor below the module's is
  rejected on save.

Design consequence: **absence is a state that must be explained on screen**, in
every place a suppression can bite. There are four such notices and they are all
permanent (not dismissible), because the condition is permanent.

### 4.4 A whitespace's status is free text

The stored status column is unconstrained text with a documented vocabulary of
`candidate`, `validating`, `validated`, `parked`. The generated form offers
exactly those four. The bespoke whitespace card offers a fifth — `promoted` —
as a move out of `validated`, and because the column is free text the write
succeeds. So a card can reach a status the generated table's filter does not
list and the platform's own state machine does not know. **This is a defect, not
a design** (§13). A designer should treat four statuses as the vocabulary and
flag any fifth they see.

---

## 5. Permissions

### 5.1 The twelve SCOUT permissions

| Permission | What it unlocks |
|---|---|
| `scout:signals:read` | The signals table; the integrator screen's similarity search |
| `scout:signals:ingest` | Writing a signal — a harvester key's grant, not a person's |
| `scout:clusters:read` | Clusters, and the Radar |
| `scout:clusters:build` | Running the Clusterer over the persisted signal corpus |
| `scout:panel_bench:build` | Running the Bench Builder — rebuilding the bench, which reading it does not imply |
| `scout:whitespaces:read` | Whitespace rows and their commentary |
| `scout:whitespaces:promote` | Moving a card, running the sweep, promoting to SIGNAL, and the negotiation pack |
| `scout:panel_bench:read` | Panel, price and analytics screens; the wording differ |
| `scout:experiments:read` | The experiment board |
| `scout:experiments:create` | Spinning up a draft experiment |
| `scout:experiments:decide` | Recording a verdict on an experiment |
| `scout:data_products:read` | The data-product catalogue |
| `scout:data_products:create` | Defining a data product |
| `scout:data_products:publish` | Changing a data product's status |

Plus `scout:ai:invoke`, which is what lets a role trigger model work in the
module at all.

One permission carries far more than its name suggests:
**`scout:whitespaces:promote` gates four unrelated affordances** — the card
move, the whitespace sweep, the promote-to-SIGNAL handover, and the negotiation
pack PDF. A role that should be able to do one of those gets all four.

### 5.2 The roles

| Role | Holds |
|---|---|
| `scout.pm` | All SCOUT reads, `scout:ai:invoke`, AI suggestions read, `experiments:create`, `whitespaces:promote` |
| `scout.lead` | Everything `scout.pm` has, plus `experiments:decide` and `data_products:create` |
| `scout.admin` | `scout:*:*` — every SCOUT permission — plus AI suggestions read and full product/provider admin |
| `provider.viewer` | Exactly two: `scout:data_products:read`, `scout:panel_bench:read` |
| `north.exec`, `north.analyst` | `scout:clusters:read` only |
| `tenant.admin` | `scout:*:read` — every SCOUT read |

Note what nobody holds: `data_products:publish` is reachable only through
`scout.admin`'s wildcard. There is no non-admin publisher role.

### 5.3 Getting into the shell is a separate gate from permissions

Entry to the nine bespoke screens is decided by the actor's **role prefix**, not
by their permissions. Only `scout.*` and `provider.*` roles resolve to the SCOUT
shell. Everyone else gets a **403 on every `/scout/<screen>` URL**, before any
loader runs.

That produces a genuinely confusing outcome a designer should know about:
`tenant.admin`, `north.exec` and `north.analyst` all hold SCOUT read
permissions, can see SCOUT data in the generated `/scout` tabs, and are refused
at the door of the Radar. There is no explanatory screen for this — it is a bare
403. (§13.)

The eight workspace links are gated on permissions the actor may not have, and
one of them is gated on a permission **that does not exist**: the Settings link
requires `scout:whitespaces:write`, which is not a declared permission. Only a
wildcard holder — `scout.admin` — passes that check, so in practice the Settings
link is admin-only by accident rather than by design (§13).

### 5.4 Two affordances gated deliberately higher than their data

Because a carrier may be signed in:

- **The negotiation pack PDF** is gated on `scout:whitespaces:promote`, not on
  `scout:panel_bench:read`. The pack bakes every provider's price index, win
  rate and volume into one document for the tenant's own negotiation prep;
  `provider.viewer` holds the bench read, so gating it there would hand a
  carrier its counterparties' numbers — or its own prep pack against itself.
  The screen says so: *"The pack quotes counterparty numbers, so it needs the
  promote permission."*
- **Data products** are visible to `provider.viewer` only when published, and
  further scoped to that provider's own subscriptions.

### 5.5 What a withheld panel looks like

Every bespoke SCOUT screen loads its panels independently and each read is
individually protected: **a 403 on one read costs one panel, never the page**.
The withheld panel renders a guardrail notice in its place, naming the missing
grant in plain language and telling the reader to ask an administrator for the
grant rather than for a one-off.

Guardrail notices are used instead of disabled buttons, on purpose: a disabled
control cannot take focus, so a screen reader would never reach the explanation
of why it is disabled. **Never design a disabled control here.** Either the
control is live, or it is replaced by prose.

---

## 6. Shared anatomy of a generated SCOUT list screen

The six tabs at §7 all render the same generic list screen. Top to bottom:

1. **Links strip**, `aria-label="Reports and tools"` — SCOUT's eight bridges
   into the bespoke screens (§2.4). Each link appears only if the actor holds
   its permission.
2. **Tab bar** — the six resources.
3. **Filter row** — one select per declared filter, plus free-text search where
   the resource declares searchable columns.
4. **Table** — the declared columns in the declared order, sorted by the
   resource's default sort. Status columns render as badges.
5. **Create** — a form appears only if the resource declares a create
   permission and the actor holds it.
6. **Pagination.**

Empty state is the platform's standard empty table; there is no SCOUT-specific
empty illustration or copy on these tabs.

---

## 7. The six generated tabs

### 7.1 `/scout/signals`
Read `scout:signals:read`; create `scout:signals:ingest`. Sorted by observed-at
descending. Filter: source. Columns: source, source reference, cluster,
weight, observed at, created at. Create fields: source, source reference,
payload JSON, weight, observed at. Every ingested signal is embedded into the
market vector index as a side effect of the write.

### 7.2 `/scout/clusters`
Read `scout:clusters:read`. **Read-only** — no create, no edit. Sorted by
momentum score descending. Columns: theme, summary, momentum score, size, last
seen, updated at.

### 7.3 `/scout/whitespaces`
Read `scout:whitespaces:read`; update `scout:whitespaces:promote`. No create —
rows are written by the sweep. Sorted by demand estimate descending. Filter:
status (candidate / validating / validated / parked). Columns: description,
cluster, evidence refs, demand estimate, competition score, status (badge),
owner, promoted at, updated at. Editable: status (select of the same four),
owner, promoted at.

**Every edit here passes an approval gate** under the policy
`scout.whitespace_promote`. Unless the tenant has explicitly allow-listed that
policy for automatic approval, saving returns a 403 whose body names the policy,
and the screen shows "Queued for approval — This change needs an approval under
policy {policy}. It is queued, not lost." with a link to the approvals queue.
An existing approval is single-use and expires after 24 hours.

The old version of this doc said promotion here was "a generic PATCH, no
bespoke route in the API". The PATCH is still generic, but a bespoke
promote-to-SIGNAL route now exists alongside it and does something different
(§11) — this tab's edit changes a status; the Radar's button drafts a campaign.

### 7.4 `/scout/panel-bench`
Read `scout:panel_bench:read`. **Read-only.** Sorted by period descending.
Columns: provider, line, period, our price index, market price index, win rate,
volume, updated at. Rows below the k-anonymity floor are not served (§4.3), and
the provider column shows raw identifiers here — the bespoke Panel screen
resolves them to names, this one does not.

### 7.5 `/scout/scout-experiments`
Read `scout:experiments:read`; create `scout:experiments:create`; update
`scout:experiments:decide`. Filter: state (draft / running / concluded /
abandoned). Columns: whitespace, landing reference, state (badge), started at,
concluded at, created at.

### 7.6 `/scout/data-products`
Read `scout:data_products:read`; create `scout:data_products:create`; update
`scout:data_products:publish`. Filter: delivery (API feed / report). Columns:
name, consent basis, aggregation minimum, delivery, status (badge), updated at.
Consent basis and aggregation minimum are **required** on create — a data
product cannot exist without naming why it may exist and how thin it will go.

---

## 8. The generated record screen — `/scout/:resource/:id`

The platform's standard record screen: the row's fields as a definition list,
an edit form for the resource's editable fields if the actor holds the update
permission, and the row's audit trail. For `whitespaces` the same approval gate
described in §7.3 applies to the save. Nothing about this screen is
SCOUT-specific.

---

## 9. Whitespace commentary — the contract, and why this section exists

### 9.1 The lesson, first

The component that renders whitespace commentary was once written against an
**assumed** API contract. It expected a stance, a note, a confidence and a list
of lines. The server sent none of those. Every rendered figure read `undefined`,
the surface looked alive in review, and the tests stayed green — because the
fixtures had been written to match the assumption rather than the server.

A second near-miss on the same surface: an earlier draft called the coverage
figure `coverageGap`, labelled it "Uncovered" and printed it with a percent
sign. It is neither a gap nor a percentage — it is a **count of the tenant's own
active contracts on that line**. Thirty-four contracts on the book rendered as
"34% uncovered", a number a reader would have acted on.

Hence this section. What follows is read off the server, not off the web
component. If you are designing a new surface over this data, design against
these fields and nothing else.

### 9.2 What one commentary row actually contains

The Radar asks for all of them at once (default 50 rows, capped at 200, ordered
by demand estimate descending, and only rows in `candidate`, `validating` or
`validated`). One row carries exactly:

| Field | Meaning | Can be empty? |
|---|---|---|
| whitespace id | which row this is about | no |
| category | the product line the candidate was flagged on | **yes — null** |
| status | the whitespace's status word | no |
| commentary | **one sentence** explaining why this is whitespace | **yes — null when suppressed** |
| evidence | the five numbers the sentence was checked against | **yes — null when suppressed** |
| why | the evidence as one plain line each, for display | **yes — empty when suppressed** |
| ai | provenance: the ✦ marker, an audit reference, model, provider, tier, timestamp | **yes — null when the sentence was not written by a model** |
| suppressed | true when there is too little behind the row to say anything | no |

The **evidence** object is five fields and no more: category, demand momentum
(0–100), coverage (a **count** of active contracts on the book for that
category), competition score (0–100, or **null** meaning "not measured"), and
the count of demand signals behind the candidate.

The **why** lines are the exact lines the model was given and scored against —
so the "why" a reader inspects and the pool the sentence was verified against
cannot drift apart. They are rendered **verbatim and untranslated on purpose**:
they are the audit trail, not copy. Do not design a localised or prettified
version of them.

### 9.3 Three states, and what each looks like

**Written by a model.** `ai` is present, `commentary` is a sentence. The surface
shows ✦, the sentence, and the "why" is inspectable. This is the only state in
which a ✦ appears.

**Written by the fallback.** When the model was unreachable, slow, or said
something the evidence did not support, the sentence is a deterministic template
— `"<category>: demand momentum <n> vs. <n> contracts on the book"`. It reads
like prose but no model wrote it, so **`ai` is null and there is no ✦**. The
reader still gets the sentence and the evidence.

**Suppressed.** Too few signals behind the cell (§4.3). `commentary`, `evidence`
and `ai` are all null and `why` is empty. The surface shows, in place of the
sentence: *"Too few signals behind this cell to say anything about it without
describing the people in it."* No ✦, no numbers, no partial reveal.

### 9.4 The two components that render it

**The ghost** — what a Radar hover shows. A 224px-wide floating card, centred on
the dot, above it by default and **below it when the dot sits high on the
chart** so it never leaves the canvas. It is **always in the DOM and always in
the accessibility tree**; hover and keyboard focus only change its opacity, and
it respects reduced-motion. Each dot points at its own ghost by description, so
tabbing to a dot announces the commentary without any pointer. Contents, in
order: ✦ (only when a model wrote it), the sentence *or* the suppressed line,
one fact line, and the status word.

The fact line is four figures joined by a middle dot, all locale-formatted:
**Demand momentum**, **On the book**, **Competition** (or "Not measured"), and
**Signals read**.

**The chip** — what the dossier beside the Radar shows. A status badge, an
evidence link that opens the "why", a ✦ when a model wrote it, and the sentence.
When there is no "why" to open (a suppressed row), the evidence link degrades to
plain text rather than an inert link.

The "why" panel itself contains: the five lines verbatim, an audit reference for
the AI run, "provider · model", and the timestamp the sentence was written.

### 9.5 Status words

Five status words are translated for display: **Candidate**, **Being checked**
(`validating`), **Checked** (`validated`), **Parked**, and — for a status the
front end does not recognise — **Status not read**. Note that the whitespace
card screen uses a different, longer vocabulary for the same column (§10.2); the
two do not agree, which is part of the §4.4 defect.

---

## 10. The nine bespoke screens

Each entry below covers: URL, what the screen loads, what it renders, every
interaction, its permission gate, any approval, its AI surfaces, and its
empty/degraded/error states. All nine sit in the §3 shell and all nine are
refused to actors outside the `scout.*` / `provider.*` role prefixes (§5.3).

Common to all nine:

- **Every panel loads independently and fails alone.** A withheld read renders a
  guardrail notice in that panel's place; the rest of the screen is unaffected.
- **Every screen opens with an arithmetic headline** — one sentence stating the
  single most useful count on the screen, computed from the loaded rows. Those
  headlines are **not AI** and carry no ✦.
- **Every write mints an idempotency key when the screen loads**, so a
  double-submitted form is one write, not two.
- **Approval-gated writes come back as "Queued for approval"** with the policy
  name and a link to the approvals queue — never as an error.

### 10.1 Radar — `/scout/radar`

**The module's home screen.** Loads, in parallel and each independently
protected: up to 200 clusters (by momentum, descending), up to 200 whitespaces
(by demand estimate, descending), and the commentary prefetch (§9.2). Selection
is in the URL — `?w=<whitespace id>` — so a chosen theme is linkable and
survives a reload.

**Headline.** "N whitespace themes are worth pursuing right now" when any theme
is both open and high-momentum; otherwise "N whitespace themes are plotted on
the radar"; otherwise "N signals have not clustered into a theme yet";
otherwise the empty line, "No clustered whitespace yet. Run a sweep."

**Lede.** *"Whitespace read off our own signals, clusters and panel data —
nothing bought in."*

**The quadrant.** A 370px-tall plotting area with dashed midlines and two corner
labels, **Pursue** (top, open market) and **Park** (bottom). Axes:

- Horizontal: *"Fit with distribution strength"*. The value is **100 minus the
  competition score** — an open market plots to the end of the axis. Both axes
  are 0–100 percentages.
- Vertical: **the linked cluster's demand momentum**.
- **Dot area is evidence volume**: 14px at zero evidence references, growing 6px
  per reference to a ceiling of 38px at four or more. It is a coarse signal on
  purpose, not a scale to read values off.

The axis caption states all three encodings in words: *"Vertical axis = demand
momentum · dot size = evidence volume · choose a theme for its dossier."*

Each dot is a label plus a marker in a zero-width column, so the label centres
on the dot's position in both reading directions. Labels are two lines
maximum, truncated. Each dot is focusable, carries its ghost (§9.4) and links
to itself with `?w=`.

**Unplotted rows are counted, never dropped.** A whitespace with no cluster has
no momentum to plot against, so it appears as a count — "N unclustered" — with
the explanation: *"Momentum is the cluster's, so a whitespace with no cluster
has no vertical position and is left off the quadrant."* A whitespace with no
competition score is unplottable for the same reason.

**The dossier** (beside the quadrant, populated only when a theme is chosen;
otherwise *"Choose a theme to read its dossier."*):

- The **cluster summary**, carrying **✦** and the why-line *"Cluster summary
  written by the clusterer over N signals."*
- The **commentary chip** for the chosen theme (§9.4).
- Four metrics: **Demand estimate**, **Competition**, **Momentum 90d**,
  **Cluster size**.
- A status badge and, if set, the promoted-at date.
- The estimate's method, confidence and note (§4.2).
- The evidence references behind the row.
- A link to the full whitespace card (§10.2).

**Three write affordances**, each its own form:

| Action | Permission | Result copy |
|---|---|---|
| **Run the whitespace sweep** — "Re-reads the last quarter of quotes and rewrites the candidate list." | `scout:whitespaces:promote` | "N candidates written." |
| **Spin up an experiment** — "Creates a draft experiment against this theme. Nothing goes live until you start it." | `scout:experiments:create` | "Draft experiment created." |
| **Hand this to the campaign studio** | `scout:whitespaces:promote` | See §11 |

Without the permission, each is replaced by a guardrail notice, never disabled.
The experiment and handover forms require a chosen theme — submitting without
one returns *"Pick a theme on the radar first."*

**Empty/degraded.** No clusters at all: the empty headline and the sweep card,
so the screen tells you what to do rather than showing a blank chart. Clusters
but no whitespaces: the unclustered count carries the screen. A withheld
commentary read costs the ghosts and the chip; the dots stay.

### 10.2 Whitespace card — `/scout/whitespace/:id`

Opened from a dot on the Radar; not in navigation. *"The whole case for one
theme: what was observed, what it is estimated to be worth, what has been tried,
and every move anyone has made on it."*

Loads the whitespace row, up to 25 linked signals, up to 20 experiments, and up
to 25 audit entries. Its lede counts the flags and experiments recorded against
the theme.

**Cards:**
- **The case** — the description, the estimate with its method/confidence/note,
  the status, the owner, the promoted-at date.
- **Experiments** — "Every bounded test run against this theme, newest first."
  Empty: *"Nothing has been tested against this theme yet."*
- **Regulatory flags** — "Items the circular feed raised on this cluster and who
  has to read them. A flag records that an item appeared — never what it
  requires." Empty: *"No regulatory items raised on this cluster."* The second
  sentence of that hint is a compliance boundary, not filler: this card must
  never be designed to look like an instruction.
- **Decision log** — "Every write against this card, from the audit log.
  Append-only." Three states: withheld (*"Reading the audit log needs the audit
  permission."*), empty (*"No moves recorded yet."*), or the list.
- **Move this card** — the one write. A target-status select and an optional
  owner field ("Who carries it from here. Leave as-is to keep the current
  owner."). Gated on `scout:whitespaces:promote`, otherwise *"Moving a card
  needs the promote permission."* When the card is in a state with no legal
  target: *"This card is in a state with nowhere to move."* An illegal target
  returns *"A card cannot move there from where it is."*

  The card's own hint says the quiet part: *"Promoting or parking a card is an
  approved change, so it queues for a second pair of eyes."* This write goes
  through the generic whitespace update, so it passes the
  `scout.whitespace_promote` approval gate (§7.3) — the realistic outcome of
  pressing this button on a tenant without auto-approval is **"Queued for
  approval"**, not "Moved to X". Design the queued state as the primary
  outcome, not the exception.

**The status vocabulary on this screen is wrong** (§4.4): it offers `promoted`
as a move out of `validated`, a status the platform's state machine, the stored
schema's documented vocabulary and the generated table's filter all lack.

**Footer.** A link to draft creative for the theme in the SIGNAL studio — shown
only if the actor's session actually has SIGNAL available, so the link never
leads to a module the user cannot enter.

**Missing row.** *"No whitespace with that reference on this board."* with a
"Back to the radar" link.

### 10.3 Panel intelligence — `/scout/panel`

*"Where each carrier sits on price and conversion, for {period}."* Loads up to
200 bench rows by period descending, takes the **latest period present** and
rolls the rows up by provider. Provider identifiers are **resolved to carrier
names** — an earlier version of this screen shipped a column headed CARRIER
containing six raw identifiers.

**Headline.** "N of M carriers are priced below the median", or if none are,
"N carriers are on the bench for this period."

**Table.** Carrier, lines covered, volume, share, win rate, price index, market
index, position. Position is a word, not a number: **Below the median**, **At
the median** (within 2%), **Above the median**, or **No price to index**. The
index is shown as a ratio to two decimals, not in basis points.

**The k-anonymity notice is always visible**, not conditional: *"Thin cuts
withheld — A bench cut below 20 quotes names the one counterparty behind it, so
the API withholds it rather than serving it thin."* Always, because the reader
cannot tell a suppressed row from an absent one, and only a permanent notice
covers both.

**Wording gaps** are listed per carrier where recorded.

**Commission is deliberately absent from this screen.** Price and conversion
only. Do not add it.

**Negotiation pack.** "Build the negotiation pack — Volume delivered,
competitive index and the wording gaps, as a PDF." Gated on
`scout:whitespaces:promote` (§5.4), otherwise *"The pack quotes counterparty
numbers, so it needs the promote permission."* Pressing it downloads a PDF named
for today's date; the download is a full document navigation, not an in-page
fetch, and the response is marked never-cache. The export is audited.

**Rebuild the bench.** The Bench Builder (module doc §3, nightly) on demand:
*"Recomputes every counterparty x line x month cell from this workspace's own
quote outcomes."* Gated on `scout:panel_bench:build`, which reading the bench
does not imply — otherwise *"Rewriting the bench is a separate permission from
reading it."* Idempotent: a cell is keyed (provider, line, period) and updated
in place, so a second press writes the same numbers. Success says how many cells
were rebuilt and how many were new.

**Empty.** *"No bench rows for this period."*

### 10.4 Price benchmarks — `/scout/pricing`

*"Our quoted price against the panel median, by line, for {period}."* Same bench
data as §10.3, rolled up **by line** instead of by carrier. Read-only — there is
no control on this screen at all.

**Headline.** "N of M lines are losing to the panel this period", or "N lines
are on the bench for this period."

Two panels: **Index against the median** (every line, with its distance rendered
as "3% above" / "3% below" rather than a signed number or an arrow), and **Where
we lose** — the lines above the median. When nothing is above: *"Every priced
cut sits at or below the median."*

**A permanent note carries the §4.2 qualification**: *"The index is our quoted
price over the median of the panel's own responses to the same request. It is
not an industry price survey."*

**Empty.** *"Nothing priced in this period."*

### 10.5 Experiments — `/scout/experiments`

*"Every promoted whitespace runs as a bounded experiment with a written stop
rule."* Loads experiments and the whitespace rows needed to name them, so the
board shows themes rather than identifiers.

**Headline.** "N of M experiments are running right now", or "N experiments are
on the board."

Each experiment shows: the theme, state, live-since date, the **stop rule**, the
spend cap rendered as "{amount} {currency} a day, {days} days at most", quote
starts, waitlist, and a verdict. Verdicts are words: **Supported**, **Did not
replicate**, **Interim read**. Where no plan was recorded: *"No plan
recorded."*

**Vocabulary note:** the stored state `abandoned` displays as **Parked**, and a
permanent footnote explains why: *"Parked is not failed — the evidence stays
attached so the theme can be re-opened when the market moves."*

**Record a decision.** A form offering exactly three decisions — running,
concluded, parked. It appears only when the actor holds
`scout:experiments:decide` **and** there is at least one experiment; there is no
empty decision form. Its hint is a deliberate warning: *"Concluding an
experiment is a decision about a build, so it is logged against you."* Submitting
without a decision: *"Choose one of the three decisions."* Success: *"Decision
recorded."*

**Empty.** *"No experiments yet."*

### 10.6 Pricing analytics — `/scout/analytics`

*"Elasticity, win rate and price adequacy across the whole bench."* Loads the
whole bench and computes across every period.

**Headline.** "{pct}% of priced volume sits at or below the median, across N
periods", or "N periods are on the bench."

**KPI wall**: periods on the bench, blended win rate, blended index, volume at
or below the median, priced volume. All blended figures are volume-weighted
(§4.2).

**Observed elasticity table.** Win-rate points moved per percent of price moved,
between the last two periods of each cut. Its hint is the honesty of the screen:
*"Observed, not measured: no experiment moved these prices on purpose."* Where
the price did not move between periods the row reads **"Price held"** rather
than dividing by zero.

A detail worth preserving: the price-move and win-rate-move columns are joined
by a **separator, not an arrow** — an arrow points the wrong way once the page
is in Arabic.

**Export.** Gated on the analytics export permission. Offers two tables —
**Whitespace pipeline** and **Signal volume** — over a 365-day window at monthly
grain, in a choice of formats, "Rendered by the platform's own report engine,
with its own masking rules." Result states: **Ready.** with a download link, or
**Queued.** Submitting without a table or a format returns the matching
"Choose what to export." / "Choose a file format."

**A permanent notice explains what cannot be exported**: *"The bench itself is
not exportable — The report engine has no price-bench table registered, so the
index and win-rate figures above cannot be rendered as a file. The negotiation
pack is the export that carries them."* This is the model for how SCOUT states
an absence: name it, explain it, point at the alternative.

**Empty.** *"Fewer than two periods on the bench, so there is nothing to
compare."*

### 10.7 Data products — `/scout/data-products`

*"Insight packaged and sold back to the panel. Every cut names its consent basis
and the floor below which its cells are suppressed."* Selection is in the URL
(`?product=<id>`) and does not scroll the page. Also loads the platform's export
log to show what has actually been rendered.

**Headline.** "N of M data products are flagged for review", or "N of M data
products are published."

**K-anonymity monitor.** Published count, module floor, subscribing carriers,
flagged count. Its hint is the module's privacy doctrine in one line: *"The
floor is the promise. A cut that can name one counterparty is flagged however
high its floor."*

Three warnings can be raised against a product, each with its own explanation:

| Warning | Why |
|---|---|
| Floor below the module minimum | "This cut suppresses below the module's floor of {floor}, so thin cells could reach a subscriber." |
| Keyed on one counterparty | "Every cell of a cut keyed on the carrier names that carrier, whatever the floor is set to." |
| Published on a feed that is not building | "Subscribers are reading a cut older than its own cadence claims." |

**Catalogue**, most recently changed first. A chosen product shows its
definition — source, window, dimensions, measures — captioned *"The cut as the
builder defined it — not recomputed here"*, its consent basis, its floor as
"k ≥ N" with the note *"Cells below this count are suppressed, not rounded"*,
and its rebuild cadence (or *"No rebuild cadence set."*). Freshness reads as
**Last built** / **Stale since** / **Never built.** / **Halted at**; a failed
build says so outright: *"The last build did not complete."*

**Subscribers** — "Read from the product's own subscriber list, suspensions
included", so a suspended subscriber is shown as suspended rather than removed.
Empty: *"Nobody subscribes to this product yet."*

**Delivery log** — cuts rendered by the report engine. Empty: *"No cut of this
product has been rendered yet."*

**Change status.** Draft / Published / Suspended. Hint: *"Publishing exposes the
cut to its subscribers. Suspending withdraws it without deleting it."* Gated on
`scout:data_products:publish`, otherwise *"Publishing a data product needs the
SCOUT publish permission."* Terminal state: *"This product has no status left to
move to."* **A publish is refused outright when the product's floor is below the
module floor**, with the reason stated: *"The suppression floor on that cut is
below the module's k-anonymity floor, so it cannot be published from here."*

**Empty.** *"No data product has been defined yet."*

### 10.8 SCOUT settings — `/scout/admin`

Read-only. Its lede is unusually candid and should stay that way: *"What governs
the module, and where each number lives. Some of these are tenant settings; the
rest are the module's own code, and this screen says which is which rather than
pretending otherwise."*

**Headline.** "N SCOUT changes are awaiting a decision", or "N signal sources
have gone quiet."

**Signal sources.** The six known sources — Search demand, Quote flow,
Abandonment, Reviews, News, Regulatory — each **Ingesting**, **Quiet** (nothing
in 14 days) or **Never ingested**. Counted from the signals themselves. Read as
`adm.source.<kind>`: this row printed `source.search` and its five siblings as
raw keys until `apps/web/app/routes/scout.labels.test.ts` was written.

**Registered adapters.** Below the health counts, the registry itself
(`GET /v1/scout/sources`, mirroring `describeSources` in
`apps/api/src/engines/scout-ingest.ts`): each adapter's id and kind, badged
**Reads rows LYRA already holds** or **Fetches from outside LYRA**. Nothing is
badged external today, and the permanent notice says why: *"No source fetches
from outside yet"* — search trends, review sites, news and regulatory feeds are
third-party services, each needing a recorded decision first (ADR-0078), and
they plug into this same registry when one is made.

**Competitor and regulatory watch.** Each watched subject's last 30 days scored
against the 30 before them, badged **Moving fast**, **Worth a look** or
**Steady**, with the observation count and either the percent change or *"New to
the watch"*. The card states that it is a reading and not a record: nothing on
it is stored (`GET /v1/scout/watch`). Empty: *"Nothing is being watched yet"*,
with the developer screen as its door.

**Suppression floors.** The module floor, with: *"Compiled into the module, not
a tenant setting: cuts below it are suppressed before a reader sees them.
Changing it is a code change with an ADR, so it cannot drift per tenant."* Plus
any data products carrying their own floor (*"Every data product uses the module
floor."* when none do).

**SCOUT policy thresholds.** Versioned; the screen reads the live rows and takes
the **highest version**, not the newest row. *"A change is a new version, never
an edit."* When there are none, it says why rather than showing an empty table:
*"SCOUT has no policy threshold set — Whitespace detection compares each
category against the panel's own mean rather than a fixed number, so there is no
momentum threshold to tune."*

**Approval gates.** Which SCOUT moves are gated, and how many are awaiting a
decision. Empty: *"No SCOUT change has been sent for approval."*

**Hypothesis templates.** A permanent absence notice: *"Hypothesis templates are
not stored — Experiments are written against a whitespace row rather than
instantiated from a library, so there is no template set to edit. Copy an
experiment that worked instead."*

### 10.9 SCOUT for integrators — `/scout/dev`

*"The two SCOUT calls that are not plain CRUD, run against this tenant's own
data so what you see here is what your key returns."* Three panels.

**Nearest signals.** A phrase (up to 4,000 characters, "The endpoint embeds it;
it is not stored") and a neighbour count (a whole number 1–20, default 10).
Returns stored signals nearest the phrase, closest first: signal, source,
observed, distance. Gated on `scout:signals:read`. Validation copy: *"Type a
phrase to search for."*, *"That phrase is longer than the endpoint accepts."*,
*"Neighbours must be a whole number from 1 to 20."* Empty result explains the
two possible causes: *"Nothing near that phrase — Either the index holds nothing
like it, or the signals it matched have since been deleted; a match without a
row is dropped rather than served as a bare id."* The raw response is shown
beneath.

**Wording differ.** Two plain-text fields, Before and After, word-level diff,
counts rendered as "{added} words added · {removed} removed · {kept}
unchanged." Gated on `scout:panel_bench:read`. Plain text only — extracting text
from a PDF is explicitly out of scope and the screen says so. Missing input:
*"Both versions of the wording are needed to compare them."*

**The same calls from your own client.** Copyable request examples. *"Bearer
authentication with an API key; the tenant comes from the key, never from the
body."* Keys are minted in the developer portal and never shown here.

Ingest is deliberately **not** offered: *"writing a signal needs
scout:signals:ingest, which belongs to a harvester key rather than to a person
signed in here"* — followed by the contract, so an integrator can still build
against it.

**One notice on this screen is now false.** It states *"SCOUT publishes no
events — Nothing in this module emits onto the event bus, so there is no topic
to subscribe a webhook to."* A completed promotion **does** emit a
`scout.whitespace.promoted` event. The copy needs to change (§13).

---

## 11. Promote to signal — the handover, end to end

This is SCOUT's only cross-module action and its only consequential one. It
lives on the Radar dossier and reads: **"Hand this to the campaign studio"**,
with the hint *"Drafts a campaign and its content from this reading. It needs an
approval first, and it sends nothing."*

### 11.1 Who sees it

`scout:whitespaces:promote`. Without it, a guardrail notice replaces the button:
*"Handing a theme over needs the {permission} grant. Ask an administrator for
it, not for a one-off."* — the module's standard formulation, aimed at fixing
the role rather than granting an exception.

### 11.2 What happens when it succeeds

A campaign is drafted from the whitespace's evidence, an audience is suggested,
a plan is made, and **six creative variants** are written. The campaign is
created in **draft**, with **no channels and zero budget**. Nothing is sent,
nothing is scheduled, nothing is spent. The whitespace is moved to *validated*
and stamped with a promoted-at date and an owner. The move is written to the
audit log and announced on the event bus.

The screen answers with a **draft tray**: a live region carrying ✦ and the
heading **"Background drafts"**, and one of three sentences:

- *"Handed over. N drafts written, none sent."*
- *"Handed over. Nothing drafted yet."*
- *"Queued for approval. Nothing has been drafted and nothing sent."*

Only in the first two — and only when the actor may enter SIGNAL — does the tray
offer **"Read the drafts"**, linking into the campaign studio at that campaign.

The phrase "none sent" is load-bearing and should survive any rewrite. It is the
whole promise of the ambient-AI grammar in one clause.

### 11.3 The four ways it does not succeed

1. **No approval yet.** The handover is gated by policy
   `scout.whitespace_promote`. Unless the tenant auto-approves that policy, the
   first press queues an approval and the tray says so. Approvals are
   single-use and expire after 24 hours; a second handover after a consumed
   approval queues again.
2. **Too little evidence.** A whitespace whose signal count is below the
   k-anonymity floor is refused, because a campaign built on a cell that thin
   describes the people in it.
3. **Already promoted.** A validated whitespace cannot be promoted twice — the
   state machine has no self-hop, so a repeat is refused **independently of the
   idempotency key**. There is no "promote again".
4. **No category on the row.** Refused; there is nothing to build a brief
   against.

A double-click is not one of the failure modes: the screen mints an idempotency
key when it loads, so the second submission returns the first result rather than
drafting a second campaign.

### 11.4 What the model is and is not allowed to write

The brief is drafted from the same five evidence facts the commentary is
grounded on (§9.2). The model is forbidden from stating a number the evidence
did not give it, and from promising cover, acceptance, a price, or that the
tenant is cheapest. A brief that states an unsupported number is **discarded
entirely**, not trimmed — and a deterministic fallback brief is used instead.
The handover therefore never blocks on a model call and never persists an
unevidenced sentence.

---

## 12. Cross-cutting notes

### 12.1 AI surfaces — all of them

| Surface | Where | Marked | Its "why" |
|---|---|---|---|
| Whitespace commentary sentence | Radar ghost and dossier chip; anywhere commentary is shown | **✦, only when a model wrote it** | The five evidence lines, verbatim, plus the audit reference, provider · model and the time it was written |
| Cluster summary | Radar dossier | **✦** | "Cluster summary written by the clusterer over N signals." |
| Campaign brief and creative variants | Produced by the handover; **read in SIGNAL, not in SCOUT** | ✦ in the draft tray | Not rendered in SCOUT — the tray links to the studio |

Rules a new SCOUT AI surface must follow:

- **One ✦ per artifact, never per screen**, and never on a fallback or a
  suppressed row. If a reader sees ✦, a model wrote that text and it is
  inspectable.
- **The "why" is the evidence, not an explanation of the evidence.** Show the
  same lines the model was given.
- **Nothing is a modal**, nothing auto-sends, nothing acts. Every AI artifact in
  SCOUT is either a sentence beside a number or a draft that has to be opened
  somewhere else.
- **Arithmetic is not AI.** Every screen headline is computed; none carries ✦.

### 12.2 Vocabulary

No industry noun is hard-coded. "Carrier", "line", "contracts on the book" and
the domain word in every AI prompt are read from the tenant's active domain
pack, so the same screens work for a market that is not insurance. When
designing copy, treat every industry noun as a slot.

Two consequences: never write a label that only parses in insurance, and expect
the same screen to read differently between two tenants.

### 12.3 Mobile

Below `md` the rail becomes a horizontally scrolling row (§3). Beyond that,
**mobile parity is not determined from code** for these nine screens — the
Radar's 370px quadrant in particular has no documented small-screen treatment,
and it is the screen most in need of one (§13).

### 12.4 RTL and internationalisation

Every string on every SCOUT screen has an English and an Arabic entry; there is
no untranslated user-facing copy, with one deliberate exception: the AI "why"
lines (§9.2), which are the audit trail. Layout uses logical properties only, so
the rail, the accent bars, the dot labels and the ghost all flip. Two specific
decisions worth keeping:

- **No arrows in comparison columns.** The analytics screen joins its move
  columns with a separator, because an arrow points the wrong way in Arabic.
- **The commentary ghost is centred on its dot** by an inline-start offset of
  half its own width, so it centres correctly in both directions rather than
  hanging off one side.

### 12.5 Accessibility

- **Hover is never the only path to information.** The commentary ghost is in
  the DOM and the accessibility tree at all times, opens on focus as well as
  hover, and is announced from the dot itself.
- **No disabled controls.** A missing permission replaces the control with
  prose (§5.5).
- **Motion respects reduced-motion** on the ghost.
- Skip link, focused main region, and a re-keyed canvas per navigation (§3).
- Every one of the four "explained absence" notices is a permanent element, not
  a transient toast, so it is reachable at any time.

---

## 13. What is weak across the whole module

Ordered by how much design work each needs.

1. **Two vocabularies for the same eight destinations** (§2.4). The rail says
   "Radar / Panel / Pricing"; the workspace links say "Opportunity radar / Panel
   benchmarks / Price benchmarks". One of the two is wrong. Pick one.
2. **The bespoke screens are a dead end back to the data.** Nothing on the nine
   screens links to the generated tables (§2.4), so a reader who wants the rows
   behind a chart has nowhere to go.
3. **The whitespace card offers a status the platform does not know** (§4.4,
   §10.2). `promoted` is not in the stored vocabulary, not in the state machine
   and not in the generated filter — and the column is free text, so the write
   lands. Two screens now disagree about what statuses exist.
4. **A bare 403 for role holders who can read the data** (§5.3). `tenant.admin`
   and the NORTH roles hold SCOUT reads and are refused at the shell door with
   no explanation. Either admit them or explain the refusal.
5. **The Settings link is gated on a permission that does not exist** (§5.3),
   so only a wildcard admin sees it — by accident.
6. **One permission gates four unrelated things** (§5.1). Nobody can be given
   the negotiation pack without also being given the sweep and the handover.
7. **The integrator screen says SCOUT publishes no events** (§10.9). It does,
   since the handover shipped.
8. **The Radar has no documented mobile treatment** (§12.3).
9. **The move card presents an approval as the exception** (§10.2) when on most
   tenants it is the rule. The queued state deserves to be designed first.
10. **Dot size saturates at four evidence references** (§10.1), so a theme with
    forty references looks identical to one with four. Fine as a coarse cue,
    misleading if a reader tries to compare two large dots.

---

## 14. What the previous version of this doc got wrong

Recorded so nobody works from a stale copy:

| Old claim | Reality |
|---|---|
| "Every SCOUT screen is generated. There is no bespoke SCOUT route, no SCOUT chart, no SCOUT dashboard, no radar, no dossier." | Nine bespoke screens, including a quadrant chart and a dossier (§2.1, §10). |
| "SCOUT owns no route file." / "No bespoke SCOUT endpoint exists." | Seven bespoke endpoints (§2.5). |
| "There is no ✦ anywhere in SCOUT today, on any screen." | Three AI surfaces, all marked (§12.1). |
| "No charts. No sparkline, no trend line, no radar, no scatter." | The Radar is a two-axis scatter with a third encoding in dot area (§10.1). |
| "SCOUT declares no links, so the links strip never renders." | Eight links declared (§2.4). |
| "There is no bespoke promote endpoint." | There is, and it drafts a campaign and six creatives (§11). |
| A 240px sidebar with a 6px accent dot per nav item, present only for holders of `scout:signals:read`. | A tokenised rail with a vertical accent bar, not permission-filtered, inside a module-specific shell (§3). |
| "Nothing is marked" (the AI table). | See §12.1. |

Still true from the old version and carried forward unchanged: the append-only
signals table (§4.1), the estimate-carries-its-method and market-is-our-median
facts (§4.2), the permission strings and roles (§5.1, §5.2), the generated-list
anatomy (§6), the six tabs' columns (§7) and the generated record screen (§8).

---

## 15. Reference

| Thing | Where it is decided |
|---|---|
| Which nine bespoke screens exist and at what URL | `apps/web/app/routes.ts` (the `scout` block) |
| Which URLs are hidden from navigation | `apps/web/app/routing.ts` |
| Who may enter the SCOUT shell | `apps/web/app/routing.ts` (role-prefix map), enforced in `apps/web/app/routes/scout-shell.tsx` |
| The shell chrome and the eight rail items | `apps/web/app/components/scout-shell.tsx` |
| The generated workspace: tabs, columns, filters, links | `apps/web/app/modules/scout.ts` |
| Every screen's copy, in English and Arabic, and the bench arithmetic | `apps/web/app/routes/scout.shared.ts` |
| The commentary payload — **the authoritative shape** | `apps/api/src/engines/scout-whitespace.ts` |
| How commentary is rendered (ghost, chip, why) | `apps/web/app/components/whitespace-commentary.tsx` |
| The promote handover, screen side | `apps/web/app/components/signal-handover.tsx` |
| The promote handover, server side | `apps/api/src/engines/scout-promote.ts` |
| The bespoke endpoints | `apps/api/src/routes/scout.ts` |
| Permissions and roles | `packages/core/src/rbac.ts` |
| The whitespace state machine and the k-anonymity floor | `packages/core/src/whitespace.ts` |
| The six tables and what may be null | `packages/db/src/schema/scout.ts` |
| The AI prompts and what they may not say | `packages/model-gateway/src/whitespace-brief.ts` |

---

## 16. Not determined from code

Stated here rather than guessed:

- **Mobile layouts** for the nine bespoke screens below the `md` breakpoint,
  beyond the rail collapsing (§12.3). The quadrant in particular.
- **Print styles** for any SCOUT screen. The negotiation pack is a server-
  rendered PDF, not a print stylesheet; nothing else has one.
- **The visual design of the ghost card** beyond its size (224px), its position
  and its contents — tone, border and elevation come from the design system's
  defaults and are not specified in SCOUT.
- **How a cluster's momentum score is computed.** Screens display it, and the
  Radar plots against it; the clusterer's method is not documented here.
  (`packages/core/src/momentum.ts` is the arithmetic —
  volume x growth x novelty over two windows — and
  `apps/api/src/engines/scout-cluster.ts` is what runs it over the persisted
  corpus, placing a signal against VEC_MARKET before scoring.)
- **Whether any SCOUT screen has ever been reviewed against a real Arabic
  corpus.** Every string is translated; the layout is logical-property clean;
  no RTL screenshot review is recorded.

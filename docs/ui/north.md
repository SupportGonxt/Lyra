# NORTH / Analytics — screen-by-screen UI design brief

This describes what is **built today**, in code, in this repository. Every label,
every empty-state sentence, every permission string below was read out of the
source. Nothing here is aspirational. Where a screen is missing or broken, it
says so rather than describing the screen it ought to be.

---

## 0. Orientation

1. NORTH is the platform's insight half. It splits across two URLs: `/analytics`
   (the machinery — dashboards, reports, runs, exports, schedules, saved views,
   unit economics, journey events) and `/north` (the executive layer — metrics,
   snapshots, briefings, anomalies, scenarios, board packs, decisions). **`/north`
   itself is now two unrelated systems that share a URL prefix — see point 11.**
2. Two people live here. The **analyst** (role `north.analyst`) is in it all day:
   parameterise a report, run it, read the table, export it to Excel, check why
   last night's run failed.
3. The **executive** (role `north.exec`) is in it for ninety seconds: open the
   default dashboard, read four numbers, notice one anomaly, leave. They will not
   scroll, will not filter, and will not read a row of JSON.
4. A third reader matters less often but matters more when they arrive: the
   **compliance officer** and the **finance controller**, who use this module as a
   register — who exported personal data, who approved it, and when it expires.
5. The three screens that matter most are `/analytics/dashboard/:id` (the exec's
   ninety seconds), `/analytics/report/:id` (the analyst's whole day), and `/`
   (the home dashboard, which is the only screen every role sees).
6. Everything else in `/analytics` and `/north` is a generic list-and-record
   screen generated from a declarative spec — the same two React files render all
   fifteen tabs across both workspaces.
7. Reporting is real: eight seeded report definitions, a semantic layer with nine
   datasets, a working run engine with totals and row limits, and four export
   formats (xlsx, pdf, csv, json) rendered inline and stored in object storage.
8. The XLSX writer is hand-rolled and genuinely enterprise-shaped — frozen header
   row, autofilter, currency number formats, a totals row with a top border.
9. The bar is "full analytics per area, with actual reporting, export to Excel
   and PDF, full enterprise class". The engine clears that bar. The **screens do
   not yet**, and §9 is the list of exactly where they fall short.
10. Read §2 (who sees what) before designing anything. In this module, permission
    is not a footnote — it is the single largest determinant of what is on screen,
    and today it locks the analyst out of the two screens built for them.
11. **`/north` is built twice, and the two builds do not know about each other.**
    Everything in §4.6 is the OLD generic system: a `layout("routes/workspace.tsx")`
    catch-all (`:module`, `:module/:resource`) driven by the declarative spec in
    `apps/web/app/modules/north.ts`. Since it was written, a second, bespoke,
    hand-built system landed alongside it: `layout("routes/north-shell.tsx")` wraps
    nine static routes — `north/brief`, `north/explorer`, `north/anomalies`,
    `north/whatif`, `north/board`, `north/board/:id/file`, `north/decisions`,
    `north/admin`, `north/dev` (`apps/web/app/routes.ts`). React Router ranks a
    static route above the dynamic `:module`/`:module/:resource` segment, so these
    nine URLs are served entirely by the new system; every other `/north/*` path
    (`/north`, `/north/metrics`, `/north/snapshots`, `/north/alerts`, …) still falls
    through to the old one. The two systems are **not linked from each other's
    nav**: the main shell's "Insight" link (`nav.north`) still resolves to `/north`,
    the OLD system's home — a person who only ever clicks the main nav never sees
    the new Brief/Explorer/Board/Decisions screens at all. The new system is reached
    only by a direct URL, a bookmark, or a link some other bespoke screen happens to
    render. See the new §4.6a for the bespoke system, and §9 for the two confirmed
    dead-end links this split produces.

---

## 1. The frame every screen sits in

All authenticated screens render inside `apps/web/app/components/shell.tsx`.

```
┌──────────────────────────────────────────────────────────────────┐
│ [logo or product name]              Signed in as {name} ⚙ Sign out│  h-14, sticky,
├───────────┬──────────────────────────────────────────────────────┤  border-b, surface-1
│ Home      │                                                      │
│ Operations│                                                      │
│ Convers.  │            <main id="content">                       │
│ Marketing │            max-w-[100rem], mx-auto,                  │
│ Market    │            p-4 / sm:p-6                              │
│ Insight   │                                                      │
│ Distrib.  │                                                      │
│ Ledger    │                                                      │
│ Analytics │                                                      │
│ Compliance│                                                      │
│ Admin     │                                                      │
└───────────┴──────────────────────────────────────────────────────┘
   sidebar: md:flex-row, collapses to a horizontal strip below md
```

- Skip link: `app.skipToContent` — "Skip to content", `sr-only` until focused.
- Product name and logo come from tenant brand config, never a literal. Brand
  colours are injected as CSS custom properties on the outer `<div>`.
- Nav items come from `GET /v1/me`. The two that matter here are labelled
  **"Insight"** (`nav.north`, href `/north`) and **"Analytics"** (`nav.analytics`,
  href `/analytics`). A nav item the actor cannot read is not returned at all.
- Header right side: `header.signedInAs` — "Signed in as {name}", a Settings link,
  a Sign out link.

**The absence rule.** Everywhere in this module, a control the actor may not use
is *not rendered*. Never disabled, never greyed, never with a tooltip explaining
the denial. Tabs, create panels, action buttons, links, and whole dashboard
panels all follow it. The API re-checks every one of them. The single deliberate
exception is a *whole screen* the actor navigated to directly — that degrades to
a denial notice, because a blank page is worse than a sentence.

### 1.1 The other frame: `NorthShell` (the bespoke fork)

The nine routes named in §0.11 render inside `apps/web/app/components/north-shell.tsx`
(`NorthShell`), not `shell.tsx`. It does not extend or wrap `Shell` — it duplicates
the header/rail/footer JSX outright. A code comment on that duplication cites "this
plan's Global Constraints" in `docs/superpowers/specs/2026-08-15-north-shell-fork-design.md`
as the reason the shared `ShellChrome` extraction was deferred rather than done.

- **Its own scoped rail.** `NORTH_NAV_PATHS` is a compile-time array of the eight
  rail destinations (all nine routes except the `board/:id/file` detail route,
  which is hidden the same way other `:id` routes are in `routing.ts`). It is
  explicitly **not** derived from `session.nav` — a code comment notes `session.nav`
  is shaped for `WORKSPACE_PATHS` (top-level roots only) and cannot express this
  rail.
- **Header logo/home link → `/north/brief`**, not `/north`. Footer links to `/design`,
  the doctrine route.
- **Module switcher excludes NORTH itself** from its own list of other modules.
- **The Meridian scrubber lives here, once, at the shell.** `?asOf=<epoch-ms>` in
  the URL drives every screen's replay moment. A non-finite value (`Number("abc")`
  → `NaN`) is treated as "live" rather than forwarded — the shell computes
  `initialAsOf` with this guard and passes it down; each screen's own loader then
  independently re-reads `asOf` from `useSearchParams()`/`request.url` and applies
  its own `Number.isFinite` guard again when building its own upstream query string
  — the guard is not centralised into a single trusted value handed down by
  context, it is the same defensive check repeated once at the shell (for the
  scrub UI) and once per screen (for that screen's own API calls). Dragging the
  scrubber updates the param via a history `replace`, so back/forward and
  shareable links both carry the replay moment.
- **A Companion panel gated on `ai:runs:read`** (`mayCompanion`), present in this
  shell and not documented anywhere in the OLD system's chrome.

---

## 2. Who sees what

Permissions are `module:resource:action` strings. A grant matches only on exact
segment equality or a `*` wildcard in that segment. **There is no implied
hierarchy: holding `analytics:reports:write` does not grant `analytics:reports:read`.**
That single fact causes the module's worst defect (§9.1).

### Permission surface

| Permission | Gates |
|---|---|
| `analytics:dashboards:read` | `/analytics/dashboard/:id`, the Dashboards tab |
| `analytics:dashboards:write` | Create / edit / delete a dashboard |
| `analytics:reports:read` | The Reports, Runs, Unit economics and Journey events tabs; `/analytics/report/:id` |
| `analytics:reports:write` | Edit / delete a report definition |
| `analytics:reports:run` | The **Run report** button |
| `analytics:exports:create` | The **Export** button; creating an export row |
| `analytics:exports:download` | The Exports tab; the **Download** link |
| `analytics:exports:unmasked` | Requesting an export with identifiers unmasked |
| `analytics:schedules:read` / `:write` | The Schedules tab; editing one |
| `analytics:saved_views:read` / `:write` | The Saved views tab |
| `north:metrics:read` … `north:decisions:write` | The seven `/north` tabs |
| A dataset's own permission | Each dashboard tile and each report definition, re-checked at query time |

**The bespoke fork's permissions (§1.1) are a second, overlapping surface**, read
per-screen rather than from the table above:

| Permission | Gates |
|---|---|
| `north:briefings:generate` / `:approve` | `north/brief` — the generate form / the publish action |
| `north:anomalies:assign` | `north/brief`'s inline "own this anomaly" action; `north/anomalies` |
| `north:anomalies:read` | `north/anomalies` |
| `north:snapshots:read` | `north/explorer`, `north/dev` |
| `north:forecasts:read` | `north/explorer` — the projection card only; a reader without it loses the card and keeps the screen |
| `north:scenarios:read` / `:run` | `north/whatif` — read the library / save a question |
| `north:boardpacks:read` / `:generate` | `north/board` |
| `north:decisions:read` / `:write` | `north/decisions` |
| `north:metrics:read` / `:write` | `north/admin` |
| `north:snapshots:run` | `north/admin`, `north/dev` |
| `north:alerts:read` | `north/admin` (gates a link to `/north/alerts`, which does not exist under this shell — §9) |
| `core:api_keys:read` | `north/dev` |
| `ai:runs:read` | the Companion panel in `NorthShell` itself |

These strings are exact-segment permissions like every other grant in this module
(§2 intro) — holding `north:briefings:generate` does not grant
`north:briefings:approve`, and none of them is implied by the OLD system's
`north:briefings:read` etc. in §2's first table.

### Role matrix for the named roles

`R` = read, `W` = write, `—` = not held.

| Role | dashboards | reports | reports:run | exports create/dl | exports:unmasked | schedules | saved views | north:* |
|---|---|---|---|---|---|---|---|---|
| `north.exec` | **R** | **R** | ✓ | ✓ / ✓ | — | **—** | R/W | read + assign/run/decide/generate |
| `north.analyst` | **W only** | **W only** | ✓ | ✓ / ✓ | — | R/W | R/W | read + metrics:write, briefings:generate, scenarios:run |
| `north.board` | R | — | — | — | — | — | — | briefings, boardpacks, snapshots, decisions (read) |
| `north.admin` | R+W (`analytics:*:*`) | R+W | ✓ | ✓ / ✓ | ✓ | R/W | R/W | `north:*:*` |
| `tenant.admin` | R+W (`analytics:*:*`) | R+W | ✓ | ✓ / ✓ | ✓ | R/W | R/W | `north:*:read` |
| `tenant.compliance` | — | R | ✓ | ✓ / ✓ | ✓ | — | — | — |
| `finance.controller` | R | R | ✓ | ✓ / ✓ | ✓ | R | R | — |
| `finance.analyst` | **—** | R | ✓ | ✓ / ✓ | — | — | — | — |
| `axis.lead`, `orbit.lead`, `signal.lead` | **—** | R | ✓ | ✓ / ✓ | — | — | R/W | — |
| `scout.lead` | **—** | R | ✓ | ✓ / ✓ | — | — | — | — |
| `orbit.retention`, `orbit.partners`, `signal.marketer`, `scout.pm` | — | R | ✓ | — | — | — | — | — |
| `axis.agent`, `orbit.agent`, `dev.admin`, `dev.developer`, `customer` | — | — | — | — | — | — | — | — |
| `axis.admin`, `orbit.admin`, `signal.admin`, `scout.admin` | R | R | ✓ | ✓ / ✓ | — | R | R | — |

Read that table carefully. Consequences a designer must design around:

- **`north.analyst` holds `analytics:dashboards:write` and `analytics:reports:write`
  but neither `:read`.** They cannot open a dashboard, cannot open a report, and
  the Dashboards and Reports tabs never appear for them. The two headline screens
  of this module are, today, closed to the person the module exists for.
- **`north.exec` holds no `analytics:schedules:read`.** The seeded schedule that
  mails a PDF to that exec every morning at 07:00 is invisible to the exec.
- **`finance.analyst` and every module lead hold no `analytics:dashboards:read`.**
  For them `/analytics` opens on Reports and there is no dashboard tab at all.
- **`axis.agent` and `orbit.agent` hold nothing.** They never see the Analytics
  nav item; direct navigation gives them a denial notice.

### Dataset permissions (the second gate)

Every report definition carries a `requiredPermission`, and every dashboard tile
resolves a dataset that carries one too. These are checked **again** at query time
against the actor.

| Dataset | Permission |
|---|---|
| `policies` | `axis:policies:read` |
| `quotes`, `quoteResponses` | `dist:quote_requests:read` |
| `commissions` | `dist:commissions:read` |
| `cases` | `axis:cases:read` |
| `transactions` | `ledger:txns:read` |
| `aiSpend` | `ai:budgets:read` |
| `conversations` | `orbit:conversations:read` |
| `campaigns` | `signal:campaigns:read` |
| `spend` | `signal:spend:read` |

`north.exec` holds `dist:commissions:read`, `ledger:txns:read`, `axis:metrics:read`,
`signal:attribution:read`, `signal:spend:read`, `orbit:renewals:read`,
`scout:clusters:read`. They do **not** hold `axis:policies:read`,
`dist:quote_requests:read`, `axis:cases:read` or `ai:budgets:read`. Of the eight
seeded reports, the exec can see **two**: "Commission earned" and "Transactions by
state". The other six are filtered out of the Reports list silently.

---

## 3. Shared rendering rules

Every list and record screen resolves cell rendering through one shared component.
Design once, applies everywhere.

| Column type | Rendering | Alignment |
|---|---|---|
| `text` | Plain text, truncated to 80 chars with `…` | start |
| `text` + `badge` | Status chip, `dot` variant, `size="sm"`, tone from a shared word map | start |
| `money` | `<Money amountMinor currency>` — integer minor units plus a sibling currency column. **A money value with no currency column renders as a bare number**, deliberately: a number without a currency beside it is not money | end, tabular figures |
| `number` | Tabular figures | end, tabular figures |
| `date` | Localised date, day precision | start |
| `datetime` | Localised date + time, minute precision | start |
| `boolean` | The words "Yes" / "No" (`common.yes` / `common.no`) | start |
| `json` | Monospace, 11px, subtle grey, `JSON.stringify` truncated to 60 chars | start |
| null / undefined / `""` | An em dash `—` in subtle grey | as column |

**Badge tone map** (shared across the whole platform): `active`, `approved`,
`done`, `posted`, `paid`, `issued`, `settled`, `matched`, `verified`, `live` →
success. `running`, `review`, `in_progress`, `quoting`, `assessing`,
`reconciling`, `extracting` → info. `pending`, `approval`, `blocked`, `variance`,
`awaiting_docs`, `high` → warning. `failed`, `rejected`, `cancelled`, `withdrawn`,
`lapsed`, `breached`, `error`, `urgent` → danger. `draft`, `open`, `intake`,
`closed` → neutral. Anything unmapped → neutral.

Note the gaps this leaves in analytics: `queued`, `expired`, `rendering`, `ready`,
`paused`, `partial`, `undelivered` are all **unmapped** and therefore all render
as identical neutral grey chips. An expired export and a ready export look the
same at a glance.

**Enum labelling** falls back in three steps: `<column>.<value>` in the
workspace's own table, then bare `<value>`, then a humanised form
(`pending_settlement` → "Pending settlement"). A raw key never reaches a person.

**Type scale**: `text-28` page-level stat values and home `h1`; `text-24` screen
`h1`; `text-16` section `h2`; `text-14`; `text-13` body/UI; `text-12` labels and
metadata; `text-11` monospace JSON. Fonts: `font-display` for headings and stat
values, `font-ui` for everything else, `font-mono` for identifiers and JSON.

**Surfaces**: `bg-bg` page, `bg-surface-1` cards and panels, `bg-surface-2` hover
and inset, `bg-surface-3` progress track. Borders `border-border`. Text
`text-text` / `text-subtle` / `text-muted`. Semantic: `accent`, `success`,
`warning`, `danger`, `info`.

---

## 4. Screens

---

### 4.1 `/` — Home

**Route + title.** Path `/` (index route). No page title element beyond the
greeting `h1`. Copy keys live in the route's own label table, not the shell
catalogue.

**Who sees it.** Every signed-in actor. There is no permission on the route. Each
of its six panels is fetched independently and degrades independently: a panel the
actor may not read (403 or 404) renders **nothing at all** — no card, no notice.
A panel that errors (5xx) renders a failure notice inside its card. All fourteen
listed roles reach this screen; what differs is how many cards appear.

**Purpose.** The one screen every role opens: what is waiting on you, what changed,
and how the business did over the last thirty days.

**Layout skeleton.**

```
Welcome back, {name}                                    h1, font-display, text-28
What is waiting for you in {brand}.                     text-13, subtle
                                                        gap-8 between blocks
┌──────────┬──────────┬──────────┬──────────┐           KPIWall:
│ WAITING  │ UNREAD   │ REVENUE, │ UNITS    │           grid gap-6
│ ON YOU   │          │ 30 DAYS  │ DELIVERED│           sm:grid-cols-2
│    3     │    5     │ AED 515.63│   54    │           lg:grid-cols-4
│          │          │ [ -218% ]│ ╱╲╱‾╲╱   │
│          │          │ Change is│           │
│          │          │ margin…  │           │
└──────────┴──────────┴──────────┴──────────┘

Decisions waiting on you                                h2, text-16
┌─────────────────────────────────────────────┐
│ pricing.override   Subject {ref}             │  ApprovalStrip, one per row
│ requested by …            [Approve] [Reject] │
└─────────────────────────────────────────────┘
{count} more waiting elsewhere · Open the full queue     text-12

┌────────────────────────────┬────────────────┐  grid gap-6 lg:grid-cols-3
│ Recent activity   (span 2) │ Unread         │
│ (timeline)                 │ (list + Mark   │
│                            │  as read)      │
├────────────────────────────┼────────────────┤
│ Where the work is (span 2) │ Recent agent   │
│ (module bars)              │ work           │
└────────────────────────────┴────────────────┘

Your workspaces                                          h2, text-16
[ Operations ] [ Conversations ] [ Analytics ] …         grid, sm:2, lg:3, h-10 tiles
```

**Every element.**

| Element | Label (key) | Source | Behaviour |
|---|---|---|---|
| Greeting | "Welcome back, {name}" (`greeting`) | `/v1/me` actor name | — |
| Subtitle | "What is waiting for you in {brand}." (`subtitle`) | tenant brand name | — |
| KPI 1 | "Waiting on you" (`kpi.approvals`) | `/v1/me/counts` | number only, not a link |
| KPI 2 | "Unread" (`kpi.notifications`) | `/v1/me/counts` | number only |
| KPI 3 | "Revenue, 30 days" (`kpi.revenue`) | `/v1/analytics/unit-economics` folded server-side | `<Money>`; delta badge = margin % |
| KPI 3 hint | "Change is margin after AI and media cost" (`kpi.revenue.hint`) | static | — |
| KPI 4 | "Units delivered" (`kpi.volume`) | same rows, summed `volume` | — |
| KPI 4 hint | Sparkline, aria "Units delivered per day over the last 30 days" (`kpi.volume.trend`) | volume grouped by ISO day, sorted lexically | rendered only when ≥ 2 points |
| Approvals panel | "Decisions waiting on you" (`approvals.title`) | `/v1/me/approvals` | Approve / Reject post inline |
| Approval summary | the raw policy key, e.g. `pricing.override` | approval row | deliberately untranslated — the vocabulary belongs to the domain pack |
| Approval subject | "Subject {ref}" (`approvals.subject`) | `subjectRef` | — |
| Mid-decision | "Deciding…" (`approvals.deciding`) | client state | **buttons are removed, not disabled**, while a decision is in flight |
| Approval failure | "That decision was not recorded, and nothing changed." (`approvals.failed`) | action result | `role="alert"`, danger border |
| Approvals overflow | "{count} more waiting elsewhere" (`approvals.more`) | counts − rows shown | — |
| Approvals link | "Open the full queue" (`approvals.all`) | static | → `/approvals` |
| Activity | "Recent activity" (`activity.title`) | audit log | `<Timeline>`, dot + title + time + subject ref |
| Notifications | "Unread" (`notifications.title`) | `/v1/me/notifications` | each row has a ghost "Mark as read" button (`notifications.dismiss`), becomes "Dismissing…" while posting |
| Notification title | `notice.<titleKey>` | notification | an untranslated key renders as itself, on purpose — it should look wrong in review, not vanish |
| Areas | "Where the work is" (`areas.title`) | unit economics folded by module | per-module row: name, "{count} delivered", money, and a 1px accent bar at `max(share, 2)%` of the busiest area |
| Areas link behaviour | — | nav from `/v1/me` | a module the actor **can** open is a link; one they cannot is counted but rendered as plain text with its raw module key |
| Agent runs | "Recent agent work" (`runs.title`) | `/v1/ai/runs` | agent key + state badge + purpose + start time |
| Agent console link | "Agent console" (`runs.console`) | — | shown only if `/admin` is in nav |
| Workspaces | "Your workspaces" (`links.title`) | nav minus `/` | 40px-tall bordered tiles |

**Charts and tiles.** One sparkline only: an SVG polyline, `viewBox="0 0 100 28"`,
`preserveAspectRatio="none"`, `role="img"` with the aria label above, 1.5px
non-scaling stroke in `var(--accent)`. No axes, no gridlines, no dots, no
tooltip. Y is min-max normalised over the visible window, so a flat series and a
volatile series look equally dramatic. The module bars are 1px `bg-accent` fills
on a `bg-surface-2` track sized with `inlineSize`, not a chart.

Analytics notifications that surface here (all three exist in the catalogue):
"A scheduled report was delivered" (`notice.analytics.schedule.delivered`),
"…reached only some recipients" (`.undelivered`), "…could not be produced"
(`.failed`).

**Table columns.** None — home has no table.

**Forms.** None beyond two inline posts: approve/reject a decision, and mark a
notification read.

**States.**
- *Loading*: none. All six panels are loader-fetched server-side; the screen paints
  complete.
- *Empty per panel*: "Nothing waiting on you." / "Nothing unread." / activity empty /
  "No delivery recorded in this window." / runs empty.
- *Empty screen*: when approvals, notifications, activity, runs are all empty **and**
  there are no unit economics — title "Nothing is waiting" (`empty.title`), body,
  and a button "Open a workspace" (`empty.action`) pointing at the first nav item.
- *Error per panel*: "This did not load. Nothing is wrong with your work — try again
  in a moment." (`panel.failed`) with a "Reload" link (`panel.retry`), inside
  `role="alert"`.
- *Permission denied per panel*: **absolutely nothing renders.** The design
  rationale in code: "a wall of 'you may not see this' cards teaches an actor about
  permissions they never asked for, and absence says the same thing more quietly."

**AI surfaces.** The approval strips are where agent work lands for a human, but
no ✦ mark is rendered on this screen. The agent-run panel names the agent key in
plain text with a state badge — no ✦, no "why".

**Actions and consequences.** Approve / Reject is **consequential and effectively
irreversible from this screen** — it posts a decision, writes an audit row, and
releases or blocks whatever was waiting. There is no confirm dialog: the mid-flight
state replaces the buttons instead. Mark-as-read is trivially reversible only by
an administrator.

**Mobile.** Expo home screen is a different, much thinner thing: greeting plus a
list of nav entries. No KPIs, no approvals, no sparkline. An href with no mobile
screen renders as a row marked unavailable rather than a dead tap.

**RTL notes.**
- Everything uses logical properties, so the layout mirrors correctly.
- `<Money>` and number formatting go through `Intl` with the actor's locale — the
  currency symbol lands on the correct side automatically and the digits do not
  mirror.
- **The sparkline does not mirror.** Index 0 is always at `x = 0`, which in RTL is
  the *right-hand* edge visually but the polyline is still drawn left-to-right in
  the SVG coordinate space, so in an RTL page the oldest day sits on the left
  while every adjacent text block reads right-to-left. **This needs an explicit
  decision.** The recommendation: keep time flowing in the reading direction —
  reverse the point order under `dir="rtl"` — and state the rule once for all
  charts rather than per component.
- The module bars grow with `inlineSize`, so they already fill from the reading
  edge and are correct.
- The delta badge shows a bare `+`/`−` and a number. No arrow glyph exists today;
  if one is added it must be chosen from a set that does not mirror (▲ / ▼), never
  a left/right arrow.

**What is weak today.**
1. **The revenue KPI under-reports across currencies.** The fold takes the first
   row's currency and *skips every row in another currency* (`if (row.currency !==
   currency) continue;`). A tenant writing business in AED and USD sees only the
   AED half, labelled "Revenue, 30 days" with no indication anything was dropped.
   The comment says a mixed total would be a lie — true — but silently discarding
   half the business is a bigger lie. The design needs either a per-currency KPI
   set or an explicit "AED only — 2 other currencies not shown" line under the
   number. Same defect, same line, in the "Where the work is" fold.
2. The margin delta on that KPI is calculated as `(revenue − cost) / revenue` and
   shown as a percentage badge tinted green above zero. On seeded data revenue is
   booked once (on the bind) while cost accrues across cases, conversations,
   renewals and campaigns, so the badge reads roughly **−218%** in alarming red on
   a perfectly healthy demo tenant.
3. The approval summary is a raw policy key (`pricing.override`). Deliberate — but
   it means the most consequential control on the platform is labelled with a
   dotted identifier.
4. The sparkline has **no test at all**. It is the only chart primitive in the
   design system and nothing verifies its point maths, its single-value case, or
   its all-equal-values case (which divides by a guarded `|| 1`).

---

### 4.2 `/analytics/dashboard/:id` — Dashboard

**Route + title.** Path `/analytics/dashboard/:id`. Eyebrow "Dashboard"
(`dashboard`), then the dashboard's own localised name as `h1`.

**Who sees it.** Requires `analytics:dashboards:read`.
- **Pass**: `north.exec`, `north.board`, `north.admin`, `tenant.admin`,
  `finance.controller`, and the four module admins.
- **Fail**: `north.analyst` (holds only `:write`), `finance.analyst`, `axis.lead`,
  `orbit.lead`, `signal.lead`, `scout.lead`, `orbit.retention`, `orbit.partners`,
  `tenant.compliance`, `axis.agent`, `orbit.agent`, `dev.admin`.
- **A denied user sees**: an `EmptyState`, title "You do not have permission to
  open dashboards.", body "Your roles do not include access to this area."
- **A second gate**: even with the permission, the dashboard must appear in the
  actor's own dashboard *list* — which filters by the dashboard's `rolesJson`
  allowlist and by personal ownership. Fail that and the screen shows title "This
  dashboard is not available to you.", body "There is nothing at this address."
- **A third gate**: each tile's dataset permission, checked per tile at query time.

**Purpose.** A fixed board of pre-defined tiles an executive reads without
touching a control.

**Layout skeleton.**

```
Dashboard                                     text-12, subtle (eyebrow)
Distribution funnel                           h1, font-display, text-24
Generated 30 Jul 2026, 09:14                  text-12, subtle

┌──────────┬──────────────────────────────────────────────┐
│ span 3   │ span 9                                       │  grid gap-6
│ Quote    │ Requests by day                              │  lg:grid-cols-12
│ requests │  ╱╲___╱‾‾╲__╱                                │  (single column
│   1,204  │  Total 1,204                                 │   below lg)
├──────────┴──────────────────┬───────────────────────────┤
│ span 6                      │ span 6                    │
│ Panel responses by underwr. │ Offers by price rank      │
│ Gulf Re      42 ▇▇▇▇▇▇▇▇▇   │ ┌────┬──────┬──────┐      │
│ Emirates Ins 31 ▇▇▇▇▇▇      │ │rank│premium│latency│     │
│ …up to 8 rows               │ └────┴──────┴──────┘      │
└─────────────────────────────┴───────────────────────────┘
```

Each tile is a `<section aria-label="{tile key}">`, `rounded-lg`,
`border-border`, `bg-surface-1`, `p-4`, `flex flex-col gap-3`, spanning
`lg:col-span-{1..12}` from the tile's declared `span`.

**Breakpoints.** One and only one: below `lg` every tile is full width and stacks
in declaration order; at `lg` and above the 12-column grid applies. There is no
`sm`/`md` intermediate — a 3-span number tile and a 9-span line chart are the same
width on a tablet.

**Every element.**

| Element | Label | Source | Behaviour |
|---|---|---|---|
| Eyebrow | "Dashboard" (`dashboard`) | static | — |
| Title | dashboard `nameJson` for the locale | `/v1/analytics/dashboards/:id/data` | — |
| Generated | "Generated" + datetime, minute precision | server response | — |
| Tile heading | `h2`, `font-display text-16` | **the tile's `key` verbatim** | see §9 |
| Tile body | per `viz` — see below | tile result | **no tile is clickable. There is no drill-through anywhere on this screen.** |

**Charts and tiles.** Four visualisation types are implemented, all without a
charting library.

| `viz` | Rendering | Axes / units | Empty copy |
|---|---|---|---|
| `number` | One `<Stat>` per money-or-number column present in the result totals. Label = column name; value = `<Money>` for money columns, formatted number otherwise | none | "No figures in this window." |
| `line` | `<Sparkline>` over the first numeric column, aria-labelled `"{table title} — {column label}"`, plus the **last row's value** printed beneath | **no axes at all** — no time axis, no value axis, no min/max labels | as above |
| `bar` | Up to **8** rows. Each row: name, right-aligned value, then a `<ProgressBar>` at `abs(value) / max(abs(value))` | no axis; scale is relative to the largest bar | as above |
| `donut` | **Not a donut.** Renders identically to `bar`, except the basis is the sum of positive values, so each bar reads as a share of total | no axis, no legend, no circle | as above |
| anything else (`table`) | Compact `<Table>` with a `{count} shown` footer | column types from the semantic layer | as above |

Seeded boards, for reference:
- `dist.funnel` — "Distribution funnel", `isDefault: true`, tenant scope, no role
  list. Tiles: *Quote requests* (number, span 3, dataset `quotes`), *Requests by
  day* (line, span 9, `quotes` grain day), *Panel responses by underwriter* (bar,
  span 6, `quoteResponses` by `providerId`, limit 8), *Offers by price rank*
  (table, span 6, `quoteResponses` by `priceRank`).
- `finance.commission` — "Commission and premium": number, donut by channel, bar
  by month, table by type and state.
- `orbit.service` — "Service load": number, donut by status, bar by channel, table
  by product line.
- `analyst.desk` — "My desk", **personal scope owned by `north.analyst`**: bar of
  AI cost by purpose, line of best premium by day.

**Table columns.** Only inside a `table` tile, and they are whatever the tile's
definition selected — dimensions first, then metrics. Money columns carry a
currency sibling; number columns are right-aligned with tabular figures.

**Forms.** None. This screen has no date-range picker, no filter, no refresh
button, and no parameters of any kind. Every window is baked into the stored tile
definition.

**States.**
- *Loading*: none — server-rendered complete.
- *Empty (no tiles)*: "This dashboard has no tiles yet."
- *Empty (tile returned no rows)*: "No figures in this window."
- *Error (whole dashboard)*: title "This dashboard could not be built.", body =
  the API problem detail.
- *Error (single tile)*: the dashboard survives — by design, one dead tile must not
  blank the board. That tile renders `role="note"`, `text-13 text-muted`:
  **"This tile could not be built. {raw error message}"**
- *Permission denied (screen)*: "You do not have permission to open dashboards." /
  "Your roles do not include access to this area."
- *Permission denied (single tile)*: **falls into the tile-error path above**, and
  the raw message is the API's `ForbiddenError`, so the tile literally reads:
  `This tile could not be built. forbidden: dist:quote_requests:read`

**AI surfaces.** None. No ✦, no anomaly annotation, no narrative, no "why". The
design system has `AgentBadge` (a ✦ chip whose "why" opens in a popover, not a
modal), `EvidenceLink` (dotted underline, claim → source in a popover) and
`ConfidenceMeter` — none is imported by this route.

**Actions and consequences.** None. Read-only, no writes, nothing irreversible.

**Mobile.** Web only. Expo has no dashboard screen; `/analytics` on mobile opens
the flat report list instead.

**RTL notes.**
- The 12-column grid mirrors correctly; tile order follows the reading direction.
- Tile headings, labels and empty copy all mirror.
- Numbers and money do not mirror and are correctly formatted per locale.
- **Bars grow from the reading edge** (`inlineSize` on the fill) — correct in both
  directions, no change needed.
- **The sparkline does not mirror** — same unresolved decision as §4.1. On a
  dashboard it is worse, because a 9-span line tile is the largest thing on the
  board and its time direction will contradict the page.
- Tile *keys* are English literals (`"Requests by day"`) stored in the layout JSON,
  so an Arabic dashboard shows Arabic chrome around English headings.

**What is weak today.**
1. **Tile headings are raw layout keys.** The heading resolves through the route's
   label table, which contains no tile names at all, so it falls back to the key
   string stored in the dashboard's JSON. Every seeded tile is therefore an
   English literal, untranslatable, and un-brandable.
2. **A permission denial is shown to an executive as a permission string.** The
   default tenant dashboard is `dist.funnel`; all four of its tiles read `quotes`
   or `quoteResponses`, gated on `dist:quote_requests:read`, which `north.exec`
   does not hold. The exec's default board today is four grey boxes reading
   "This tile could not be built. forbidden: dist:quote_requests:read". This is
   the single worst first impression in the product.
3. There is no drill-through. A tile is a dead end; nothing links to the report,
   the underlying rows, or the record.
4. There is no time control. Windows are frozen in stored JSON. An exec who wants
   "last quarter instead of last month" has no path.
5. `donut` is a lie — it renders bars. Either implement it or delete the enum.
6. Line tiles have no axis, no scale and no dates. The reader is shown a shape and
   a single last value.
7. "Generated" gives no indication of how stale the underlying data is or whether
   it will refresh.

---

### 4.3 `/analytics/report/:id` — Report

The analyst's screen. The most complete thing in the module.

**Route + title.** Path `/analytics/report/:id`. Eyebrow "Report" (`report`),
`h1` = the report's localised name, then its description at `text-13 text-muted`.

**Who sees it.** Requires `analytics:reports:read` **and** the report's own
`requiredPermission`.
- **Pass on the first gate**: `north.exec`, `north.admin`, `tenant.admin`,
  `tenant.compliance`, `finance.controller`, `finance.analyst`, `axis.lead`,
  `orbit.lead`, `signal.lead`, `scout.lead`, `orbit.retention`, `orbit.partners`,
  and the four module admins.
- **Fail on the first gate**: `north.analyst` (holds `:write`, not `:read`),
  `north.board`, `axis.agent`, `orbit.agent`, `dev.admin`, `customer`.
- **Denied copy**: `EmptyState`, title "You do not have permission to read this
  report.", body "Your roles do not include access to this area."
- **The second gate produces the identical screen** — a 403 on the report fetch is
  rendered the same way, so an actor who holds `analytics:reports:read` but not
  `axis:policies:read` is told the same thing as one who holds nothing.
- **Run** additionally needs `analytics:reports:run`; **Export** needs
  `analytics:exports:create`; the **Download** link needs
  `analytics:exports:download`.

**Purpose.** Read a stored report definition, choose parameters, run it, read the
figures, and export the full set to Excel or PDF.

**Layout skeleton.**

```
Report                                                    eyebrow, text-12
Commission earned                                         h1, text-24
Earned and clawed-back commission by channel and state.   text-13, muted

┌───────────────┬───────────────┬───────────────┐         dl, sm:grid-cols-3
│ Dataset       │ Metrics       │ Dimensions    │         gap-x-8 gap-y-3
│ commissions   │ entries, …    │ kind, state   │
└───────────────┴───────────────┴───────────────┘

⚠ This report reads personal data                         role="note"
  It reaches direct identifiers. Every download is …      (warning tint if high)

Last run 30 Jul 2026, 07:00                               role="status" aria-live

┌──────────┬──────────┬──────────┬──────────┐             Form, grid gap-4
│ From     │ To       │ Bucket by│ Row limit│             sm:2 lg:4
│ [date]   │ [date]   │ [select] │ [number] │
└──────────┴──────────┴──────────┴──────────┘
[ Run report ]        Format [Excel (.xlsx) ▾]  [ Export ]

┌────────────────────────────────────────────────────────┐
│ Export ready  ·  Masked  ·  1 row  ·  13 KB            │
│ Link expires 6 Aug 2026        [ Download ]            │
└────────────────────────────────────────────────────────┘

Results                                                    h2, text-16
┌────────┬────────┬─────────┬─────────┬─────────┐          Table, sticky header
│ kind   │ channel│ state   │ premium │ net     │
├────────┼────────┼─────────┼─────────┼─────────┤
│ …                                              │
├────────┴────────┴─────────┴─────────┴─────────┤
│ Totals   premium AED 412,500   net AED 51,563  │          dl in footer
└────────────────────────────────────────────────┘

Recent runs                                                h2, text-16
┌──────────┬────────┬──────┬──────────┬────────────┐       last 8 runs
│ Started  │ State  │ Rows │ Duration │ Reason     │
└──────────┴────────┴──────┴──────────┴────────────┘
```

**Every element.**

| Element | Label (key) | Data source | Behaviour |
|---|---|---|---|
| Eyebrow | "Report" (`report`) | static | — |
| Title / description | report `nameJson` / `descriptionJson` | `GET /v1/analytics/reports/:id` | — |
| Definition list | "Dataset" / "Metrics" / "Dimensions" | stored definition | comma-joined; `—` when absent |
| PII notice (low) | "This report reads personal data" + "Identifying columns come back pseudonymised unless your role may see them, and exports are masked the same way." | `piiLevel` | plain border, `role="note"` |
| PII notice (high) | same title + "It reaches direct identifiers. Every download is written to the audit log, exports are masked by default, and an unmasked copy needs a written reason plus a second approver — ask an administrator rather than working around it." | `piiLevel` | **warning border + warning tint** |
| Run status line | one of: "Ran just now." / "Last run {datetime}" / "This report has not been run yet." / "A run is still in progress. No figures are shown until it finishes." / "The last run failed." | run history + action result | `<p role="status" aria-live="polite">` |
| Problem | API problem detail | action result | `role="alert"`, danger border |
| Parameter: From | "From" (`from`) | definition | `<input type="date">`; offered **only if** the stored definition declares `from` |
| Parameter: To | "To" (`to`) | definition | same rule |
| Parameter: Bucket by | "Bucket by" (`grain`) | definition | `<select>`: "No bucketing" (empty), day, week, month, quarter, year |
| Parameter: Row limit | "Row limit" (`limit`) | definition | `<input type="number">` |
| Run button | "Run report" (`run`) / "Running the report…" (`running`) while busy | — | `POST /v1/analytics/reports/:id/run` with the overrides and `totals: true` |
| Run-denied note | "You may read this report but not run it." (`noPermissionRun`) | held permissions | replaces the button |
| Format select | "Format" (`format`), width `w-48` | static | Excel (.xlsx) — default — / PDF / CSV / JSON |
| Export button | "Export" (`export`), secondary variant | — | `POST /v1/analytics/exports` with `reportId`, `format`, from/to/limit and `totals: true`. **`grain` is deliberately not sent** |
| Export state badge | "Queued" / "Rendering" / "Ready" / "Failed" / "Expired" | export row | neutral tone for all of them (see §3) |
| Masking badge | "Masked" (`masked`) / "Unmasked" (`unmasked`) | `piiMasked` | **neutral when masked, warning tone when unmasked** |
| Export size | "{n} KB", floored at 1 | `sizeBytes` | `Math.max(1, round(bytes / 1024))` |
| Expiry | "Link expires" + date | `expiresAt` | 7 days from creation |
| Download | "Download" (`download`) | — | an `<a>` straight to `{apiOrigin}/v1/analytics/exports/{id}/download`, `rel="noopener"` |
| Export failure | "The export could not be written." (`exportFailed`) | export row | — |
| Gone | "This file is no longer downloadable." (`exportGone`) | expired / no file | — |
| Results heading | "Results" (`results`) | — | — |
| Truncation warning | "Cut off at the row limit — narrow the window or export the full set." (`truncated`) | `truncated` flag | shown above/with the table |
| Totals | "Totals" (`totals`) | run totals | a `<dl>` in the table footer |
| History heading | "Recent runs" (`history`) | — | last 8 |

**Table columns — Results.** Dynamic: whatever the definition's dimensions and
metrics produced, in that order. Dimension columns are text and start-aligned;
metric columns are number or money and end-aligned with tabular figures. Money
columns pair with a currency sibling. Header labels come from the semantic layer's
column names.

**Table columns — Recent runs.**

| Header (key) | Type | Align | Sortable | Notes |
|---|---|---|---|---|
| Started (`col.started`) | datetime | start | list is fixed `startedAt desc` | minute precision |
| State (`col.state`) | badge | start | no | queued / running / done / failed / expired |
| Rows (`col.rows`) | number | end | no | null while running |
| Duration (`col.duration`) | number + "ms" | end | no | — |
| Reason (`col.error`) | text | start | no | the engine's own message, e.g. `unknown dimension agentRef on aiSpend` |

If the actor cannot read run history (403), the history table is simply omitted —
no error, no notice.

**Forms.**

*Parameters form* (`method="post"`, intent `run` or `export`):

| Input | Type | Required | Default | Validation | Error copy |
|---|---|---|---|---|---|
| `from` | `date` | no | the definition's stored value | native date input; parsed as `T00:00:00Z` | API problem detail, rendered in the alert box |
| `to` | `date` | no | stored value | as above | as above |
| `grain` | `select` | no | stored value, or "No bucketing" | one of `day\|week\|month\|quarter\|year` | as above |
| `limit` | `number` | no | stored value | integer, `step=1`; the engine caps it | "Cut off at the row limit…" is shown as a *result*, not a validation error |
| `format` | `select` | yes | `xlsx` | one of four | — |

**There is no client-side validation.** No required-field marks on parameters, no
range check that `from` precedes `to`, no minimum. Everything is decided by the
API and returned as a problem detail into a single red box above the form.

*Unmasked export form: does not exist on this screen.* The `unmasked` flag and
`piiJustification` (10–500 characters, plus dual-control approval) are fields on
the generic Exports create panel in `/analytics/exports` only. The PII notice on
this screen tells the reader to "ask an administrator" precisely because the
screen offers no way to do it.

**States.**
- *Loading*: the Run and Export buttons take a loading state; the run status line
  says "Running the report…". The rest of the page stays.
- *Never run*: `EmptyState` under "Results" with body "This report has not been
  run yet."
- *Run in progress*: body "A run is still in progress. No figures are shown until
  it finishes."
- *Revisited after a previous run*: body **"Figures are not kept between visits.
  Run the report to see them."** — results are not persisted; `resultRef` is
  always null and a run row is a receipt, not a cache.
- *Failed*: status line "The last run failed."; the reason appears in the history
  table's Reason column.
- *Error*: problem alert box above the parameters.
- *Permission denied*: the `EmptyState` described above; nothing else renders.

**AI surfaces.** None. No ✦ anywhere on the screen. No suggested parameters, no
narrative summary of the result, no anomaly callout, no "explain this number".
This is the largest AI-shaped hole in the module: the analyst's main screen is
entirely manual.

**Actions and consequences.**
- **Run** — safe and repeatable. Writes a `report_runs` row (state `done` or
  `failed`, `resultRef` null, `expiresAt` = +24h) every time. Not irreversible,
  but it is not free either: every click leaves a permanent audit row.
- **Export** — **consequential and irreversible.** It renders bytes synchronously,
  writes them to object storage, creates a `files` row and an `analytics_exports`
  row with a watermark naming the requester and the timestamp. There is no delete
  and no undo; the artefact expires after 7 days but the register row is permanent.
  An unmasked export additionally records the justification and the approver.
- **Download** — increments `downloadCount` and is written to the audit log for a
  high-PII report.

**Export flow, end to end.**
1. Actor picks a format and presses Export.
2. `POST /v1/analytics/exports` → permission check (`analytics:exports:create`,
   plus `analytics:exports:unmasked` when unmasked).
3. The report runs, masking applied unless the actor holds `core:pii:view` or the
   export was explicitly approved unmasked.
4. The renderer runs **inline** — no queue. XLSX/PDF/CSV/JSON, typically ~200 ms.
5. Bytes → object storage; a `files` row and an `analytics_exports` row are written,
   `state: "ready"` (or `"failed"` with error `no object store bound` when storage
   is unbound), `expiresAt` = now + 7 days.
6. The screen re-renders with the export strip: state badge, masking badge, row
   count, size in KB, expiry date, Download link.
7. Download streams from `/v1/analytics/exports/:id/download` with a
   `content-disposition` filename. Past `expiresAt` the route 404s.

**Mobile.** Web only. Expo shows the report *list* under `/m/analytics` and a flat
key/value dump of one report definition — it cannot run, parameterise, or export
anything.

**RTL notes.**
- The whole layout mirrors: the parameter grid, the definition `dl`, the table.
- Table numeric columns align to the inline-end edge, which is correct in both
  directions.
- Money and dates come from `Intl` per locale; digits do not mirror. Note the
  platform stores minor units and renders through `Intl.NumberFormat` with the
  correct minor exponent per ISO 4217, so a JPY (0-decimal) and a KWD (3-decimal)
  figure both render truthfully.
- Duration is rendered as `{n} ms` with a hard-coded space and the literal "ms".
  In Arabic this reads as a Latin unit glued to Arabic-context digits — it needs
  a translated unit or a locale-aware duration format.
- **PDF export refuses non-Latin text.** The PDF writer is base-14 Helvetica with
  WinAnsi encoding; it rejects any table containing characters outside Latin-1
  with the message "this report contains non-Latin text the PDF fonts cannot
  render; export it as xlsx". **An Arabic-locale tenant can therefore never export
  a PDF containing Arabic data.** The Format select offers PDF anyway, and the
  refusal only appears after the click, as a red problem box. The design must
  either mark PDF unavailable for Arabic content up front or explain the
  constraint beside the select.

**What is weak today.**
1. `north.analyst` — the role this screen was built for — cannot open it.
2. The two denial reasons ("you cannot read reports" and "you cannot read *this*
   report's dataset") produce identical copy, so an actor who is one grant away
   from access cannot tell.
3. Results vanish on navigation. "Figures are not kept between visits" is honest,
   but the analyst re-runs a report every time they come back — cost, latency, and
   a run row each time.
4. No client-side validation at all. A `from` after a `to` is a server round-trip.
5. The parameter set is fixed at four fields and only shows those the definition
   already declares — there is no way to add a dimension, change a metric, or
   filter by value. The tab that links here is labelled **"Report builder"**; there
   is no builder.
6. The Download link points at the API origin directly. A session cookie scoped to
   the web host will not ride along once the two are not same-site — flagged in
   code as a known ceiling awaiting a web-origin proxy route.
7. Export states are all neutral grey badges: `ready`, `queued`, `rendering`,
   `expired` and `failed` are visually identical apart from their text.
8. Money is written in *major* units into CSV, XLSX and PDF but stays in *minor*
   units in JSON. Nothing on screen says so.
9. No AI, anywhere, on the analyst's primary surface.

---

### 4.4 `/analytics` — Analytics workspace (8 tabs)

**Route + title.** `/analytics` (first readable tab) and `/analytics/:resource`.
`h1` = "Analytics" (`nav.analytics`). Rendered by the generic module list route.

**Who sees it.** The workspace itself has no gate; **each tab is gated
individually** and only tabs the actor can read are rendered. Landing on
`/analytics` with no resource opens the first *declared* tab (Dashboards); if the
actor cannot read it the loader redirects to the first tab they can. An actor who
can read none of the eight gets the standard route error: "Your roles do not
include access to this area."

Per-role tab sets:

| Role | Tabs they actually see |
|---|---|
| `north.exec` | Dashboards, Reports, Runs, Exports, Saved views, Unit economics, Journey events |
| `north.analyst` | **Schedules, Saved views** — and nothing else |
| `tenant.admin`, `north.admin` | all eight |
| `finance.controller` | all except… (holds `analytics:*:read` + run + exports) — Dashboards, Reports, Runs, Exports, Schedules, Saved views, Unit economics, Journey events |
| `finance.analyst` | Reports, Runs, Exports, Unit economics, Journey events |
| `tenant.compliance` | Reports, Runs, Exports, Unit economics, Journey events |
| `axis.lead`, `orbit.lead`, `signal.lead` | Reports, Runs, Exports, Saved views, Unit economics, Journey events |
| `scout.lead` | Reports, Runs, Exports, Unit economics, Journey events |
| `orbit.retention`, `orbit.partners` | Reports, Runs, Unit economics, Journey events |
| `axis.agent`, `orbit.agent`, `dev.admin` | none — the nav item is not offered |

**Purpose.** The register behind the module: every dashboard, definition, run,
artefact, schedule and saved view, listed and inspectable.

**Layout skeleton.** Identical for all eight tabs.

```
Analytics                                                h1, text-24
[Dashboards] [Reports] [Runs] [Exports] [Schedules] …    tab pills, h-8, rounded-md
                                                          current: bg-surface-2 + medium
Report builder                                            link strip, text-12 subtle
                                                          (only where declared)
[search][filter ▾][filter ▾][Live records ▾] [Apply] Clear   flex-wrap, items-end

┌ + New — Reports ─────────────────────────────────────┐  <details>, closed by default,
│  (grid gap-4 sm:grid-cols-2 of fields)               │  auto-opens if the last create
│  [ Create ]                                          │  was rejected
└──────────────────────────────────────────────────────┘

┌──────────┬──────────┬──────────┬──────────┬─────────┐  Table, compact, sticky header
│ Key      │ Name     │ PII level│ Scope    │ Updated │  first column is a link to
├──────────┼──────────┼──────────┼──────────┼─────────┤  the record screen
│ …                                                    │
├──────────────────────────────────────────────────────┤
│ 24 shown                          [Previous] [Next]  │  keyset paging
└──────────────────────────────────────────────────────┘
```

The tab strip renders only when the actor can see **more than one** tab — a
single-tab actor gets no navigation at all.

**Paging is keyset and forward-only.** "Next" carries a cursor; "Previous" simply
drops the cursor and returns to the top of the current view, keeping filters. The
footer says "{count} shown" — **never "of N"**, because a keyset page does not
know the total.

**Every element and every tab's columns.**

#### Tab 1 — Dashboards (`/analytics/dashboards`)
Read `analytics:dashboards:read`; create/update/delete `analytics:dashboards:write`.
Record screen offers a **"Open dashboard"** button → `/analytics/dashboard/{id}`.

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `key` | Key | text | start | no |
| `nameJson` | Name | json | start | no |
| `module` | Module | text | start | no |
| `scope` | Scope | badge | start | no |
| `ownerRef` | Owner | text | start | no |
| `rolesJson` | Roles | json | start | no |
| `isDefault` | Default | boolean | start | no |
| `updatedAt` | Updated | datetime | start | **yes** |

Create fields: `key`\*, `module`\*, `name` (json)\*, `layout` (json)\*, `scope`
(select: Tenant / Team / Personal), `roles` (json), `isDefault` (checkbox).
Editable: name, layout, roles, scope, isDefault — `key` and `module` are frozen
after creation.

#### Tab 2 — Reports (`/analytics/reports`)
Read `analytics:reports:read`; update/delete `analytics:reports:write`.
**No create fields — the list offers no "New report" panel at all**, deliberately:
authoring a definition is the builder's job, and the builder does not exist.
Record screen offers **"Report builder"** → `/analytics/report/{id}`.

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `key` | Key | text | start | no |
| `nameJson` | Name | json | start | no |
| `descriptionJson` | Description | json | start | no |
| `module` | Module | text | start | no |
| `piiLevel` | PII level | badge (None / Low / High) | start | no |
| `scope` | Scope | badge | start | no |
| `requiredPermission` | Required permission | text | start | no |
| `ownerRef` | Owner | text | start | no |
| `system` | System | boolean | start | no |
| `updatedAt` | Updated | datetime | start | **yes** |

Editable: key, module, name, description, piiLevel (select), scope (select).
The list is **filtered server-side by each row's own `requiredPermission`** — rows
the actor cannot query never appear, with no indication that anything was hidden.

#### Tab 3 — Runs (`/analytics/report-runs`)
Read `analytics:reports:read`. Sorted `startedAt` desc. No create, no edit.
Filters: **State** (Queued / Running / Done / Failed / Expired) and **Trigger**
(Person / Schedule / API).

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `reportId` | Report | text | start | no |
| `trigger` | Trigger | text | start | no |
| `state` | State | badge | start | no |
| `requestedBy` | Requested by | text | start | no |
| `rowCount` | Rows | number | end | no |
| `truncated` | Truncated | boolean | start | no |
| `durationMs` | Duration | number | end | no |
| `paramsJson` | Parameters | json | start | no |
| `error` | Reason | text | start | no |
| `startedAt` | Started | datetime | start | **yes** |
| `endedAt` | Ended | datetime | start | no |
| `expiresAt` | Expires | datetime | start | no |

Seeded rows cover every outcome the engine can produce: a schedule-triggered
success (`requestedBy: system:scheduler`, 4 rows, 412 ms), a user run, an API-
triggered run, a failure with reason `unknown dimension agentRef on aiSpend`, one
`running` with null rows and null duration, one `queued`, and one `expired` that
ran two days ago.

#### Tab 4 — Exports (`/analytics/exports`)
Read **`analytics:exports:download`** — not `:create`, deliberately: listing the
register and requesting an artefact are different rights. Create
`analytics:exports:create`.

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `reportId` | Report | text | start | no |
| `format` | Format | text | start | no |
| `state` | State | badge | start | no |
| `requestedBy` | Requested by | text | start | no |
| `approvedBy` | Approved by | text | start | no |
| `rowCount` | Rows | number | end | no |
| `sizeBytes` | Size | number | end | no |
| `piiMasked` | Masked | boolean | start | no |
| `piiJustification` | Reason for unmasked data | text | start | no |
| `fileId` | File | text | start | no |
| `downloadCount` | Downloads | number | end | no |
| `error` | Reason | text | start | no |
| `createdAt` | Created | datetime | start | **yes** |
| `expiresAt` | Expires | datetime | start | no |

Create fields: `format` (select: Excel (.xlsx) / PDF / CSV / JSON)\*, `reportId`\*,
`from` (date), `to` (date), `limit` (number), `totals` (checkbox), `orientation`
(select: Portrait / Landscape), `unmasked` (checkbox), `piiJustification` (text).

**This is the only place an unmasked export can be requested.** The
justification field is a plain single-line text input with no character counter,
no required mark, and no explanation that it must be 10–500 characters or that a
second approver is needed — those rules live in the API and surface only as a
rejection.

#### Tab 5 — Schedules (`/analytics/schedules`)
Read `analytics:schedules:read`; update/delete `analytics:schedules:write`.
**No create fields.**

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `nameJson` | Name | json | start | no |
| `reportId` | Report | text | start | no |
| `dashboardId` | Dashboard | text | start | no |
| `cron` | Schedule | text | start | no |
| `timezone` | Time zone | text | start | no |
| `format` | Format | text | start | no |
| `recipientsJson` | Recipients | json | start | no |
| `status` | Status | badge (Active / Paused) | start | no |
| `lastState` | Last result | badge (Delivered / Partial / Undelivered / Failed) | start | no |
| `nextRunAt` | Next run | datetime | start | **yes** |
| `lastRunAt` | Last run | datetime | start | no |

Editable: name, report, dashboard, timezone, format, recipients. **`cron` and
`status` are deliberately excluded from the edit form** — changing either must
recompute `nextRunAt`, which only the API's pause/resume endpoints do. The
consequence today is that **the cron expression is read-only in the UI and there
is no pause or resume button on the record screen**, because no `actions` are
declared on this resource.

Seeded schedules: "Executive 7am read" (`0 7 * * *`, PDF, to `north.exec` +
`tenant.admin`), "Monday panel pack" (`0 8 * * 1`, XLSX), "Month-end commission
file" (`0 6 1 * *`, CSV), **"Daily funnel board" (`0 7 * * 1-5`, PDF, targeting the
`dist.funnel` dashboard, `status: paused`, `lastState: failed`, `nextRunAt: null`)**,
"Daily AI spend digest" (`30 5 * * *`, CSV).

#### Tab 6 — Saved views (`/analytics/saved-views`)
Read `analytics:saved_views:read`; create/delete `analytics:saved_views:write`.

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `name` | Name | text | start | **yes** |
| `route` | Screen | text | start | no |
| `queryJson` | Query | json | start | no |
| `columnsJson` | Columns | json | start | no |
| `isDefault` | Default | boolean | start | no |
| `updatedAt` | Updated | datetime | start | no |

Create fields: `route`\*, `name`\*, `query` (json)\*, `columns` (json),
`isDefault`, `shared`.

Seeded views point at `/analytics/report-runs` ("Runs that failed") and
`/analytics/exports` ("Unmasked artefacts", shared with `tenant.compliance` and
`finance.controller`). **Nothing in the UI consumes them.** Saved views are stored,
listed and editable, but no list screen reads a saved view to apply its filters,
column set or default. They are, today, notes.

#### Tab 7 — Unit economics (`/analytics/unit-economics`)
Read `analytics:reports:read`. Read-only.

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `day` | Day | text (ISO date string) | start | **yes** |
| `module` | Module | text | start | no |
| `unit` | Unit | text | start | no |
| `volume` | Volume | number | end | no |
| `revenueMinor` | Revenue | money (currency from `currency`) | end | no |
| `humanMinutes` | Human minutes | number | end | no |
| `updatedAt` | Updated | datetime | start | no |

Six seeded rows, all AED: `dist`/bind volume 1, revenue 51,563 minor (AED 515.63 —
a 12.5% commission on a 412,500-minor premium); `axis`/case ×9, 143 minutes, zero
revenue; `orbit`/conversation ×34, 96 minutes; `orbit`/renewal ×7, 21 minutes;
`signal`/campaign ×1 with 1,250,000,000 media micro-units, 34 minutes;
`north`/brief ×2, 15 minutes. Revenue is booked exactly once, on the bind — the
case, conversation and renewal rows carry the cost of the same work.

Note the AI cost column (`aiCostMicro`) and the media cost column are **not
displayed**, even though the home screen's revenue KPI hint says "Change is margin
after AI and media cost". The reader cannot see the cost side of the margin
anywhere in the UI.

#### Tab 8 — Journey events (`/analytics/journey-events`)
Read `analytics:reports:read`. Sorted `ts` desc. Filter: **Outcome** (Progressed /
Completed / Abandoned / Failed).

| Column | Header | Type | Align | Sortable |
|---|---|---|---|---|
| `journeyId` | Journey | text | start | **yes** |
| `step` | Step | text | start | no |
| `actorRef` | Actor | text | start | no |
| `subjectRef` | Subject | text | start | no |
| `outcome` | Outcome | badge | start | no |
| `durationMs` | Duration | number | end | no |
| `ts` | When | datetime | start | **yes** |

Twelve seeded rows, all journey `J-C1`. The happy path runs landed →
quote_requested → offers_ranked (40 s) → offer_chosen (110 s) → documents_uploaded
(5 min) → payment_authorised (70 s) → policy_issued (`completed`), then
cross_sell_offered (`progressed` — offered, not taken). Plus one session that
**abandoned** at quote_requested after 70 s, and one that **failed** at
payment_authorised after 145 s (card declined). The distinction is deliberate and
load-bearing: a failed step is not a customer walking away, and a funnel must not
merge the two.

**This is the funnel data, and there is no funnel.** The tab is a flat event log
sorted by timestamp. There is no step-by-step conversion view, no drop-off chart,
no per-step median duration, and no way to see that six of twelve events belong to
one completed journey. Every funnel question the seed data was built to answer
must currently be answered by reading rows.

**Forms (create panel, all tabs).** A `<details>` disclosure above the table
labelled "New — {tab}", closed by default, auto-opened when the previous create
was rejected. Fields render in a `grid gap-4 sm:grid-cols-2`. Types map to native
inputs: text → `text`, number/money → `number` with `step=1`, date → `date`,
datetime → `datetime-local`, select → `<select>`, boolean → a checkbox carrying its
own label, json and textarea → a `<textarea>` (json gets 6 rows and a monospace
12px face, textarea gets 3 rows). Required fields carry the field component's
required mark. Submit is "Create".

An empty string means "not supplied", never "set to empty" — clearing a value to
null is only expressible through a JSON field.

**States.**
- *Loading*: the Apply and Create buttons show a loading state; the table stays.
- *Empty, unfiltered*: title "Nothing here yet", body "No records match this view.
  Clear the filters, or create the first one."
- *Empty, filtered*: "No records match these filters."
- *Deleted view, empty*: "Nothing has been deleted here."
- *Error on write*: a `role="alert"` danger box above the table with the API's
  problem detail, form input preserved.
- *Permission denied (tab)*: the tab is absent.
- *Permission denied (workspace)*: standard route error, "Your roles do not
  include access to this area."

**The deleted-records view.** Where the actor holds the tab's delete permission, a
third filter appears: "Live records" / "Deleted records". Switching to deleted
bands the list with a warning-tinted status bar reading "You are looking at
deleted records. They stay out of the live list until you restore them." plus a
"Back to live records" link, and appends a "Restore" button column. Deleted rows
are **not** links — their record page would 404.

**AI surfaces.** None on any of the eight tabs.

**Actions and consequences.**
- Create — writes a row. Reversible via soft delete.
- Delete — soft delete, confirmed with a native `confirm()` carrying the copy
  "Delete this record? It is retained for audit and can be restored by an
  administrator."
- **Creating an export from the Exports tab is irreversible** — it renders and
  stores bytes and writes a permanent register row. It is offered through the same
  ordinary "+ New" disclosure as every other create, with no additional weight,
  no confirmation, and no warning about the unmasked checkbox.

**Mobile.** `/m/analytics` maps to the **reports** collection only. It is a flat
`FlatList` of cards, each showing a derived title and subtitle, tapping through to
a key/value dump. No tabs, no filters, no create, no export. The other seven tabs
have no mobile presence.

**RTL notes.** Tabs, filters, table and pager all mirror. Numeric columns align to
the inline-end edge. JSON cells are monospace Latin inside a mirrored row —
readable, but they are the one place the eye has to switch direction mid-line, and
truncating a JSON string at 60 characters in an RTL row places the ellipsis at the
visually-left edge. Enum labels are translated; column headers are translated;
**stored `key` values, `route` values and permission strings are not** and never
will be.

**What is weak today.**
1. `north.analyst` sees exactly two tabs: Schedules and Saved views.
2. Schedules cannot be paused, resumed, or rescheduled from the UI. The
   pause/resume endpoints exist; no button reaches them.
3. Saved views are stored and never applied.
4. Journey events is a log, not a funnel.
5. The Exports create panel is the platform's PII escape hatch and looks like a
   generic form.
6. Unit economics shows revenue and volume but hides both cost columns.
7. Twelve of fourteen Exports columns and eleven of twelve Runs columns render at
   once in a compact table — both scroll horizontally on anything narrower than a
   desktop, and neither has a column chooser (though `columnsJson` exists on
   saved views, unread).

---

### 4.5 `/analytics/:tab/:id` — Record

**Route + title.** `/analytics/{resource}/{id}`. `h1` = the value of the row's
**first declared column** (so: a dashboard key, a report key, a run's `reportId`,
an export's `reportId`, a schedule's name JSON, a saved view's name, a unit-
economics `day`, a journey event's `journeyId`) falling back to the id.

**Who sees it.** The tab's own `read` permission, re-checked by the API on the
`GET`. There is no separate route gate — an actor without it gets the route error
"Your roles do not include access to this area."

**Purpose.** One row, every field, and whatever may be changed about it.

**Layout skeleton.**

```
Back to list                                        text-12, subtle
commission.earned                                   h1, text-24
Reports · anl_rep_0c8f…                             text-12, id in mono
[ Report builder ]                                  recordLink button, secondary

┌──────────┬──────────┬──────────┐                  dl in a bordered card
│ Key      │ Name     │ PII level│                  sm:grid-cols-2 lg:grid-cols-3
│ commis…  │ {"en":…} │ None     │                  gap-x-8 gap-y-4
├──────────┼──────────┼──────────┤
│ …every declared column, plus  │
│ Created and Updated            │
└────────────────────────────────┘

┌ Actions ───────────────────────┐                  only if any are declared
│ (none declared in analytics)   │                  — this section never renders
└────────────────────────────────┘                    in /analytics today

┌ Edit ──────────────────────────┐                  only if update permission held
│ (grid gap-4 sm:grid-cols-2)    │
│ [ Save changes ]               │
└────────────────────────────────┘

──────────────────────────────────
[ Delete ]                                          danger, sm, native confirm
```

**Every element.** Back link "Back to list" (`common.back`); heading; a subtitle
line reading "{tab label} · {id}" with the id in monospace; the record link button
where declared ("Open dashboard" on a dashboard, "Report builder" on a report); a
definition list of every column rendered with the shared cell rules plus Created
and Updated appended; an Edit form; a Delete button.

**Forms.** The edit form contains the tab's `editable` field list (falling back to
its create fields). It uses the identical field components as the create panel.
Submit is "Save changes". A rejected save shows the problem detail in a danger box
above the definition list and leaves the input intact. Success renders no
confirmation at all unless the tab declared an action — the page simply re-renders.

**States.** Loading: button loading state only. Error: danger box. Not found:
"There is nothing at this address." Denied: the workspace error copy.

**AI surfaces.** None.

**Actions and consequences.** Delete is soft and confirmed once with the native
dialog. Save is a PATCH. Neither is irreversible; an administrator can restore.
Note that **no analytics resource declares any API-owned action**, so the Actions
section never renders here — which is exactly why schedules cannot be paused.

**Mobile.** `/m/analytics/{id}` shows a scrolling list of every returned field as
`key` (raw, untranslated, monospace-ish muted) over a selectable value, in the
order the API returned them. No edit, no delete, no actions.

**RTL notes.** Mirrors correctly. The monospace id and the raw field keys on mobile
are Latin inside RTL text — acceptable for identifiers, jarring for the mobile
field labels, which are **raw column names** (`piiJustification`, `nextRunAt`).

**What is weak today.** The record screen is entirely generic. A report record
shows its definition as a truncated JSON string. A schedule record shows a cron
expression as text with no human reading ("Every weekday at 07:00"). An export
record shows `fileId` as a column but offers **no download link** — the only
download affordance in the product is on the report screen, so the Exports
register is a register you cannot act from.

---

### 4.6 `/north` — Insight workspace (7 tabs) — the OLD/legacy generic system

**This is the system the main shell's "Insight" nav link actually opens.** A
second, bespoke, hand-built system now exists alongside it at `/north/brief` and
eight sibling routes (§1.1, §4.6a) — reachable only by direct URL, never from
this nav link. The two share the `/north` URL prefix; two of this system's tab
names (`anomalies`, `decisions`) collide with the new system's route names, and
the new system wins the match at those exact paths (§0.11).

**Route + title.** `/north` and `/north/:resource`. `h1` = "Insight"
(`nav.north`). Same generic list route as §4.4.

**Who sees it.** Per-tab, from the `north:*` grants.

| Role | Tabs |
|---|---|
| `north.exec` | all seven (read), plus assign / run / decide / generate rights |
| `north.analyst` | all seven (read), plus metrics write, briefings generate, scenarios run |
| `north.board` | Snapshots, Briefings, Board packs, Decisions |
| `north.admin`, `tenant.admin` | all seven |
| everyone else in the matrix | **none** — the Insight nav item is not offered |

**Purpose.** The executive layer: the metric catalogue, its history, the generated
briefings, the anomalies raised against it, what-if scenarios, board packs, and the
decisions taken.

**Layout skeleton.** Identical to §4.4.

#### Tab 1 — Metrics
Read `north:metrics:read`, write `north:metrics:write`. Sorted `key` asc.
Filters: Grain (Daily / Weekly / Monthly), Unit, Sensitivity.

| Column | Header | Type | Align |
|---|---|---|---|
| `key` | Key | text | start |
| `unit` | Unit | text (Count / Money / Percent / Ratio / Duration) | start |
| `grain` | Grain | text | start |
| `direction` | Direction | text ("Up is good" / "Down is good") | start |
| `sensitivity` | Sensitivity | badge (Public / Internal / Restricted) | start |
| `owner` | Owner | text | start |
| `updatedAt` | Updated | datetime | start |

Create: `key`\*, `name` (json)\*, `definitionSqlRef`\*, `unit`, `currency`, `grain`,
`direction`, `sensitivity`, `owner`, `target` (json). `key` is never editable.

#### Tab 2 — Snapshots
Read `north:snapshots:read`. **Immutable — no create, no edit, no delete.** Sorted
`ts` desc. Filter: Grain.

| Column | Header | Type | Align |
|---|---|---|---|
| `metricKey` | Metric | text | start |
| `period` | Period | text | start (sortable) |
| `grain` | Grain | text | start |
| `value` | Value | number | end |
| `dimsHash` | Dimensions | text | start |
| `ts` | When | datetime | start |

This is the module's time series and it is presented as a flat table. There is no
chart of a metric over time anywhere in `/north`.

#### Tab 3 — Briefings
Read `north:briefings:read`, create `north:briefings:generate`, update
`north:briefings:approve`. Sorted `date` desc. Filters: Audience (Exec / Board /
Investor), Status (Draft / Review / Published).

| Column | Header | Type | Align |
|---|---|---|---|
| `date` | Date | date | start |
| `audience` | Audience | text | start |
| `locale` | Language | text | start |
| `status` | Status | badge | start |
| `narrativeRef` | Narrative | text | start |
| `highlightsJson` | Highlights | json | start |
| `anomaliesJson` | Anomalies | json | start |
| `generatedBy` | Generated by | text | start |
| `aiAuditId` | AI audit | text | start |
| `approvedBy` | Approved by | text | start |
| `publishedAt` | Published | datetime | start |

Create: `date`\*, `audience`, `locale`. Editable: `status` only.

**This is the module's flagship AI artefact and it is rendered as a table row.**
The narrative is a reference string, the highlights are truncated JSON, and the
`aiAuditId` — the inspectable "why" — is a bare identifier that links nowhere.

#### Tab 4 — Anomalies
Read `north:anomalies:read`, update `north:anomalies:assign`. Sorted `detectedAt`
desc. Filter: State (New / Explained / Action created / Dismissed).

| Column | Header | Type | Align |
|---|---|---|---|
| `metricKey` | Metric | text | start |
| `window` | Window | text | start |
| `magnitude` | Magnitude | number | end |
| `expected` | Expected | number | end |
| `actual` | Actual | number | end |
| `state` | State | badge | start |
| `detectedAt` | Detected | datetime | start |

Editable: state, linked action reference, explained by.

#### Tab 5 — Scenarios
Read `north:scenarios:read`, create/update `north:scenarios:run`.

| Column | Header | Type | Align |
|---|---|---|---|
| `question` | Question | text | start |
| `author` | Author | text | start |
| `modelRunRef` | Model run | text | start |
| `resultJson` | Result | json | start |
| `createdAt` | Created | datetime | start |
| `updatedAt` | Updated | datetime | start |

Create: `question` (textarea)\*, `assumptions` (json)\*, `author`\*, `sharedWith`
(json). Editable: assumptions, sharedWith.

The scenario **result** — the entire point of running one — is a JSON blob
truncated to 60 characters in the list and rendered in full only as monospace text
on the record screen.

#### Tab 6 — Board packs
Read `north:boardpacks:read`, create `north:boardpacks:generate`. **No update.**
Sorted `period` desc. Filter: Status (Draft / Review / Final / Distributed).

| Column | Header | Type | Align |
|---|---|---|---|
| `title` | Title | text | start |
| `period` | Period | text | start |
| `status` | Status | badge | start |
| `approvedBy` | Approved by | text | start |
| `pdfFileId` | PDF | text | start |
| `xlsxFileId` | Excel | text | start |
| `distributionLogJson` | Distribution | json | start |
| `updatedAt` | Updated | datetime | start |

Create: `title`\*, `period`\*, `sections` (json)\*.

**`pdfFileId` and `xlsxFileId` render as plain identifier text.** A board pack has
a PDF and an Excel file and there is no way to open either from the UI.

#### Tab 7 — Decisions
Read `north:decisions:read`, write `north:decisions:write`. Sorted `reviewAt` asc.
Filter: Status (Open / Reviewed / Reversed).

| Column | Header | Type | Align |
|---|---|---|---|
| `title` | Title | text | start |
| `owner` | Owner | text | start |
| `chosen` | Chosen option | text | start |
| `status` | Status | badge | start |
| `reviewAt` | Review on | date | start |
| `updatedAt` | Updated | datetime | start |

Create: `title`\*, `contextRef`, `options` (json), `owner`\*, `reviewAt`.
Editable: chosen, status, owner, reviewAt, outcome review (json).

**Forms, states, actions.** Identical mechanics to §4.4 / §4.5. No `north`
resource declares an API-owned action either, so "Generate a briefing" and
"Generate a board pack" are ordinary creates through a `<details>` panel — which
means the two most expensive AI operations in the module are triggered by a button
labelled "Create" with no confirmation and no cost indication.

**AI surfaces.** Three tabs are *about* AI output (briefings, anomalies, scenarios)
and **not one renders the ✦ mark, an agent attribution, a confidence figure, or an
inspectable "why".** The `aiAuditId` and `modelRunRef` columns exist and are inert
strings. The design system's `AgentBadge` puts the ✦ in an accent chip whose "why"
opens in a **popover, never a modal** — that is the pattern this module should
adopt and currently does not.

**Mobile.** `/m/north` maps to **metrics** only. Flat list, flat record. Briefings,
anomalies, board packs and decisions have no mobile presence — which is exactly
backwards for an executive surface.

**RTL notes.** Same as §4.4. Two module-specific problems: metric `direction`
labels ("Up is good" / "Down is good") are directional *words* and translate
cleanly, but any arrow glyph added later must be vertical (▲▼), never horizontal.
Metric `period` values are ISO strings rendered as plain text, so they are Latin
digits in an RTL row with no locale formatting.

**What is weak today.** `/north` is the executive module rendered entirely as
generic CRUD tables. There is no metric chart, no anomaly context, no readable
briefing, no board pack download, no decision timeline. Everything the module
promises exists as a row of columns, and its two richest payloads (briefing
narrative, scenario result) are truncated JSON.

---

### 4.6a NorthShell — the bespoke fork (8 hand-built screens)

This is the system described in §1.1: nine routes under `layout("routes/north-shell.tsx")`
in `apps/web/app/routes.ts` (eight distinct screens plus one file-download detail
route). Unlike §4.6, none of these is generic CRUD — each is its own component,
its own loader, its own `LABELS` (`en`/`ar`), reading through the shared helpers
in `apps/web/app/routes/north-shared.tsx` (`labelsFrom`, `readable` — a 403/404
degrades a card, not the screen; `parsed()` — safe against the CRUD's hydrated-JSON
vs. a module route's raw-text split; `refuse`/`refused` — the common action-result
shape; `MetricValue`/`num`/`pct` — the one place a stored minor-unit/basis-point
integer becomes a displayed number).

**Cross-screen mechanics common to all eight:**
- **Idempotency.** Every write-capable screen's loader mints
  `idempotencyKey: crypto.randomUUID()` once per page load; the form carries it as
  a hidden field; the action forwards it as an `idempotency-key` header only when
  present. One key per load, so a double-submitted write is the same write.
- **Replay (`?asOf=`).** Time-scoped data (briefings, anomalies, snapshots) is
  bound to the shell's Meridian moment; definitional/catalogue data (the metrics
  list) deliberately is not — a code comment in `north-brief.tsx` gives the
  rationale: bounding a *definitions* catalogue by the replay moment would hide
  definitions created since, rather than replay their values, which is not what
  replay is for.
- **Consequential writes surface their approval gate rather than swallowing it**
  (CLAUDE.md rule 4): an action that comes back `approval_required` renders via
  the shared `Gate` component (`routes/staff.tsx`), never silently retried or hidden.
- **Interruptions are inline, never a modal** (CLAUDE.md rule 11) — `GuardrailNotice`
  rendered in the page flow.

#### `north/brief` — The Brief

Read-gated implicitly (no explicit `north:briefings:read` in this screen's own
`PERM`; the API is the authority per `readable()`'s 403/404-to-null pattern).
Write permissions: `north:briefings:generate`, `north:briefings:approve`,
`north:anomalies:assign`. The module's flagship screen and its **only** real ✦ AI
surface (see §7). Loader fetches the seven most recent briefings and anomalies
(both replay-bound by `?asOf=`) and the metrics catalogue (deliberately not
replay-bound, see above). Three actions: `generate` (creates a briefing for a
question/audience, gated on `:generate`), `publish` (gated on `:approve`, may come
back `approval_required` and is shown via `Gate`, not swallowed), and
`own-anomaly` (assigns the current actor to an anomaly interrupting the brief,
gated on `:assign`). The headline `<h1>` is not written copy — it is the model's
own first sentence, extracted from the stored narrative
(`firstSentence(paragraphs(brief.narrativeRef).at(0))`). Below it, a kicker line
carries the actual `✦` glyph inside an `EvidenceLink`: `✦ Narrated by NORTH from
the live ledger` (`en`) / `✦ صياغة نورث من السجل الحي` (`ar`), whose popover shows
an audit-body sentence plus a `<Ref value={brief.aiAuditId}>` block when present —
this specifically resolves the OLD system's §4.6 complaint that `aiAuditId` "links
nowhere": here it opens an inspectable popover. A `draft`-status brief shows a
`GuardrailNotice` "numbers unverified" warning when a figure could not be traced
to a snapshot. Links out to `/north/board` ("Board pack"), `/north/whatif`
("What-if"), `/north/anomalies/{id}`, and — for each metric highlight — a
`Link to="/north/metrics?q=..."` (source at line ~520). **That last link is a
dead end**: `/north/metrics` is not registered under `NorthShell` (§4.6, §9), so
clicking a highlighted metric silently exits into the OLD system's chrome, losing
the Meridian scrubber and the scoped rail with no warning. This is the module's
flagship screen, so it is also the most-visited path to this defect.

#### `north/whatif` — Scenarios ("What if")

`PERM = { read: "north:scenarios:read", run: "north:scenarios:run" }`. **Confirms
the doc's earlier finding: this is not a slider or simulator.** A scenario is
literally a question plus free-text assumptions (`name: value` per line, parsed
by `readAssumptions()` — a line with no `name:` is refused outright, not silently
dropped) and, optionally, a stored result. The screen's own code comments are
explicit about why: "Nothing in the API composes an answer yet… so this screen
saves the question and its assumptions, renders a stored result where one exists,
and says plainly that a stored figure is a point estimate with no band behind it.
It does not invent a range to satisfy the guardrail — a fabricated band is worse
than a missing one." Saving a scenario stores only `question`, `author`,
`assumptionsJson` — never a fabricated `resultJson` or `modelRunRef`. The library
table's "Result" column is a badge ("Answered"/"Unanswered") keyed off whether
`resultJson` has any keys. The headline is deliberately marked as **not** an AI
surface: `headlineFor()`'s own comment reads "Not AI-authored text, so no ✦
(CLAUDE.md §11): a person typed this question, nothing summarised it." Numeric
result fields are unit-decoded from their key's suffix (`*Minor` → money,
`*Bps`/`*Ppm` → percent-shaped, `*Ms` → seconds) via `unitOf()`/`Value()` — the
same convention `north-shared.tsx`'s `MetricValue` uses for stored metrics. Links
back to `/north/brief` only.

#### `north/explorer`, `north/anomalies`, `north/board` (+ `north/board/:id/file`), `north/decisions`, `north/admin`, `north/dev`

These six were read in a prior investigation pass in this session; their exact
on-screen copy strings were not re-verified in this final pass and are
deliberately **not** quoted here to avoid presenting unconfirmed text as fact.
Structural facts that were confirmed and are not in doubt:

- **`north/explorer`** — `north:snapshots:read`. Browses the metric/snapshot
  catalogue that the shell's Meridian scrubber replays against. It also reads
  `GET /v1/north/forecast` (`north:forecasts:read`, docs/27 F50) and renders the
  projection as a p10/p50/p90 table with the fitted parameters beneath it — no
  ✦ marker, because the projection is arithmetic in packages/core and not a
  model call. Week grain has no projection; the endpoint answers for the two
  grains the snapshotter writes.
- **`north/anomalies`** — `north:anomalies:read`, `north:anomalies:assign`. Has a
  state-transition map (`explain` → `explained`, `own` → `action_created`,
  `dismiss` → `dismissed`) mirrored by the inline anomaly-ownership action on
  `north/brief`.
- **`north/board`** (+ its file-download detail route `north/board/:id/file`) —
  `north:boardpacks:read`, `north:boardpacks:generate`. Generation is served by
  `apps/api/src/engines/north-boardpack.ts`. Unlike the OLD system's Board packs
  tab (§4.6 Tab 6), where `pdfFileId`/`xlsxFileId` render as inert identifier
  text, this bespoke screen has a dedicated file-download route.
- **`north/decisions`** — `north:decisions:read`, `north:decisions:write`.
- **`north/admin`** — `north:metrics:read`, `north:metrics:write`,
  `north:snapshots:run`, `north:alerts:read`. Renders `<Link to="/north/alerts">`
  gated on `:alerts:read`. **This is a dead end**: `/north/alerts` is not
  registered under `NorthShell` either (it was never a §4.6 tab name at all — the
  OLD system has no Alerts tab), so this link falls through to the OLD system's
  generic `:module/:resource` route rather than any purpose-built screen.
- **`north/dev`** — `north:snapshots:read`, `north:metrics:read`,
  `north:snapshots:run`, `core:api_keys:read`.

None of these six renders the `✦` mark, an `AgentBadge`, `GhostText`,
`ConfidenceMeter`, or an `EvidenceLink` — each has a self-documenting code comment
explaining why its headline/helper text is arithmetic on stored data rather than
AI output, the same pattern `north-whatif.tsx`'s `headlineFor()` makes explicit.

**AI surfaces across all eight bespoke screens, definitively:** exactly one —
`north/brief`. The other seven deliberately have none.

**A defect that is not specific to any one screen:** the fork exists as a set of
direct URLs with no discoverable path from the main product nav (§0.11). Every
fact above is reachable only by a person who already knows `/north/brief` exists.

---

### 4.7 Screens that are referenced but do not exist

Design should know these are gaps, not omissions from this brief.

| Referenced as | Where | Reality |
|---|---|---|
| "Report builder" | the Reports record-screen button | Points at `/analytics/report/{id}` — the read-and-run screen. There is no builder. A report definition can only be authored via the API or the seed. |
| Schedule pause / resume | `POST /v1/analytics/schedules/:id/pause` and `/resume` exist and recompute `nextRunAt` | No UI reaches them. |
| Export download from the register | `fileId` and `downloadCount` columns | No download control on the Exports tab or its record screen. |
| Board pack PDF / Excel | `pdfFileId`, `xlsxFileId` | Identifier text only. |
| Journey funnel | the journey-events data models a full funnel with abandon and fail distinguished | Rendered as a reverse-chronological event log. |
| Saved-view application | `queryJson`, `columnsJson`, `isDefault`, `shared` | Stored, never read by any screen. |
| AI briefing reader | `narrativeRef`, `highlightsJson`, `aiAuditId` | Table row. |

---

## 5. Export pipeline — the whole path

Design needs this because the artefact is the product for half the module's users.

**Formats.** Four. `xlsx`, `pdf`, `csv`, `json`.

**XLSX** (hand-written, no library). Sheet structure, top to bottom:
1. Row 1 — the report title, bold 16pt.
2. Optional watermark row — grey 9pt (present on every unmasked export, and on
   scheduled exports, formatted `{actor} · {ISO timestamp to seconds}`).
3. `Generated {ISO timestamp to seconds}`.
4. One row per metadata entry, formatted `key: value`.
5. A blank row.
6. The header row — white bold text on a dark indigo fill (`#1E1B4B`).
7. Data rows.
8. Optionally a bold **Total** row with a thin top border.

The header row is **frozen** and an **autofilter** spans the data range — because
the first thing anyone does with an export is sort it. Column widths are computed
from the longest value in the first 200 rows, clamped to 10–48 characters.

Money cells are written in *major units* with a currency number format. A table
that carries its own `currency` column drops the currency prefix from the format
(mixed-currency sheets); otherwise the format is e.g. `"AED "#,##0.00`. Numbers use
`#,##0`. **Dates are written as ISO text, not Excel date serials** — so date
columns will not sort as dates in Excel. Sheet names are stripped of `: \ / ? * [ ]`
and truncated to 31 characters.

**PDF.** Base-14 Helvetica, WinAnsi encoding, portrait or landscape (landscape is
the default). Supports a diagonal watermark. **Refuses any table containing
non-Latin-1 characters** with the message "this report contains non-Latin text the
PDF fonts cannot render; export it as xlsx". A smart-quote and currency-symbol
transliteration pass runs first so a plain English report is never refused over
typography.

**CSV** — major units, no styling.
**JSON** — **minor units retained.** The only format that does not convert.

**Lifecycle.**
- Report runs expire after **24 hours** (`report_runs.expiresAt`). The row survives
  as the receipt; there was never a payload to lose, since `resultRef` is always
  null.
- Export artefacts expire after **7 days** (`analytics_exports.expiresAt`). Past
  that, the download route 404s and the row stays as the audit trail.
- `downloadCount` increments per download.

---

## 6. RTL and numerals — the cross-cutting rules

Every rule below is enforced or expected across the whole module.

1. **Logical properties only.** `margin-inline-start`, `padding-inline-end`,
   `inset-inline-start`, `inline-size`. Physical properties are a test failure —
   the design system's own test suite asserts it. No `margin-left` anywhere.
2. **Numbers and currency do not mirror.** All money goes through `<Money>`, which
   formats integer minor units with `Intl.NumberFormat` and the correct minor
   exponent for the ISO 4217 code. Digits, decimal separators and symbol placement
   are the locale's business, not the layout's.
3. **Numeric table columns align to the inline-end edge** with tabular figures.
   That is the right edge in LTR and the left edge in RTL, automatically, and it is
   correct in both.
4. **Chart axes and time direction need an explicit decision, and this brief takes
   one.** Today the sparkline draws index 0 at SVG `x=0` regardless of direction,
   so time flows left-to-right on a right-to-left page. **Rule to adopt: time
   flows in the reading direction.** Under `dir="rtl"` the oldest point sits at the
   inline-start edge (visually right) and the newest at the inline-end edge. This
   must be a single shared rule for the sparkline and for every future axis, chart
   and timeline, not a per-component choice. Categorical bar charts already comply
   because their fills grow with `inline-size`; only time-ordered series need the
   flip.
5. **Sparklines and trend arrows.** The sparkline's *shape* carries direction —
   flipping the point order preserves meaning because the value axis is vertical
   and vertical never mirrors. Trend indicators must therefore be **vertical
   glyphs** (▲ ▼) or signed numbers, **never horizontal arrows** (→ ←), which
   invert meaning under mirroring. The delta badge today shows a signed number with
   no glyph, which is safe; keep it that way or add a vertical glyph.
6. **Progress and gauge fills** already use `inline-size`, so they fill from the
   reading edge in both directions. No change.
7. **The `<Timeline>` primitive** uses `border-inline-start` and
   `inset-inline-start: -26px` for its dots — correct in both directions.
8. **Latin islands.** Monospace identifiers, permission strings, cron expressions,
   route paths, JSON blobs and stored dashboard tile keys are Latin and stay Latin
   inside RTL rows. Identifiers are acceptable; **tile keys and mobile field labels
   are not** and should be translated or replaced.
9. **Units glued to numbers** (`ms`, `KB`) are English literals today. They need
   i18n keys or a locale-aware unit formatter.
10. **PDF cannot render Arabic.** See §5. This is a hard constraint on the export
    surface, not a bug the UI can style around, and the format picker must reflect it.

---

## 7. AI surfaces — where ✦ appears

**Nowhere in the OLD system (§4.6), and in exactly one of eight screens in the
bespoke fork (§4.6a).** The claim that ✦ appears "nowhere in this module" is no
longer accurate as a whole-module statement — `north/brief` renders a real
`AGENT_MARK`/`EvidenceLink` surface — but it remains true of every other screen,
old and new: seventeen of the module's eighteen screens (the OLD system's seven
generic tabs plus seven of the bespoke fork's eight) have no ✦ anywhere.

**The one real instance.** `north/brief`'s headline `<h1>` is the model's own
first sentence, pulled straight from the stored narrative
(`firstSentence(paragraphs(brief.narrativeRef).at(0))`) rather than written page
copy. The `✦` glyph itself sits on the kicker line beneath it, inside an
`EvidenceLink`: `<span aria-hidden="true">{AGENT_MARK}</span> {l("kicker")}` —
"Narrated by NORTH from the live ledger" / "صياغة نورث من السجل الحي". Its popover
source shows an audit-body sentence and, when present, a `<Ref value={brief.aiAuditId}>`
block — an inspectable "why" one interaction away, exactly the pattern this
section used to say the module lacked entirely. This specifically fixes the OLD
system's own §4.6 complaint that `aiAuditId` "is a bare identifier that links
nowhere" — it does, on the Briefings tab; it does not, on `north/brief`.

The design system provides the vocabulary, still largely unused everywhere else:

| Primitive | What it is | Interaction |
|---|---|---|
| `AGENT_MARK` | The one and only `✦` | — |
| `AgentBadge` | An accent chip reading `✦ Drafted by {agent}` or `✦ AI-generated` | If a `why` is supplied, the chip becomes a button opening a **popover** titled "Why this was drafted". Never a modal. |
| `GhostText` | A streamed draft rendered in subtle grey, announced `aria-live="polite"` | Tab to accept, Esc to discard. Never commits itself. |
| `ConfidenceMeter` | 0–1 as a labelled progress bar; green at/above the floor (default 0.7), amber within 0.2 below, red beneath | Below the floor the UI must require review rather than offer acceptance |
| `EvidenceLink` | A claim with a dotted accent underline | Click opens a popover: "Evidence" over the source document, span and timestamp |
| `GuardrailNotice`, `BudgetMeter`, `ApprovalStrip` | Refusal, spend ceiling, human decision | — |

Where they *should* land, given the data that already exists:

- **Briefings** — `narrativeRef` is the drafted narrative, `generatedBy` names the
  agent and `aiAuditId` is the audit row. That is exactly an `AgentBadge` with a
  `why` popover pointing at the audit entry, over a readable narrative, with each
  highlight an `EvidenceLink` to the snapshot it came from.
- **Anomalies** — `expected` vs `actual` vs `magnitude` is a confidence-shaped
  claim about a metric; it wants a ✦ chip and a "why" naming the window and the
  baseline.
- **Scenarios** — `modelRunRef` is the model run behind `resultJson`. Same pattern.
- **Dashboard tiles** — an anomaly touching a tile's metric is the obvious quiet
  chip: a ✦ marker in the tile corner whose popover explains the deviation. This
  is the single highest-value AI addition in the module and it requires no new
  data.
- **The report screen** — a ghost-text suggestion for parameters, or a one-line
  ✦ summary of the result, would be the analyst's first AI touchpoint.

Rules that constrain any of the above: never a modal; never auto-send outside the
tenant's autonomy policy; every AI artefact carries the single ✦ and an
inspectable "why" one interaction away; consequential actions still require the
approval path.

---

## 8. Mobile (Expo)

Mobile has **no workspace screens**. Each nav href resolves to exactly one
collection:

| Web href | Mobile route | Collection |
|---|---|---|
| `/north` | `/m/north` | `north/metrics` |
| `/analytics` | `/m/analytics` | `analytics/reports` |

This table describes the OLD system only (§4.6) — `session.nav`, which is what
drives the mobile nav mapping, is `WORKSPACE_PATHS`-shaped and has no entries for
`/north/brief` or any other bespoke-fork route (§1.1). Whether the bespoke fork
has any mobile presence at all — a separate Expo screen, a deep link, or nothing
— **is not determined from code**: this pass reviewed the Expo app's routing only
far enough to confirm the `/m/north` → `north/metrics` mapping above, and did not
audit the mobile app for bespoke-fork-specific screens.

**List screen** (`/m/{nav}`). A `FlatList` with `gap: md`, `padding: lg`, safe-area
insets top and bottom. Header block: a quiet "Back" button aligned to the reading
edge (the stack draws no header, and an edge swipe is not reachable by
screen-reader or switch-control users), the workspace title, a "Loading" line while
fetching, an error notice with a request id and a "Try again" button, and a
"{n} items" count. Each row is a `Pressable` with `minHeight` at the touch-target
constant, hairline border, `RADIUS.md`, a 16px two-line title and a 13px muted
subtitle, both derived generically from the row.

**Record screen** (`/m/{nav}/{id}`). A `ScrollView` of every field the API
returned, in API order: a muted label showing the **raw column name**, then the
selectable value at 14px with 1.5 line height, separated by hairline rules. No
edit, no actions, no download.

**Not on mobile at all**: dashboards, the report screen, running a report,
exporting, schedules, saved views, unit economics, journey events, briefings,
anomalies, board packs, decisions, and the home KPI wall.

**RTL on mobile** is handled: the session carries a `dir` and the back button
aligns to `flex-end` under RTL. Text styles route through a shared `textOf`
helper.

**Parity note for design.** The executive persona is the most likely mobile reader
and has the least mobile surface. If one thing moves to mobile it should be the
default dashboard, read-only, in the exec's ninety-second shape.

---

## 9. What is weak today — ranked

**9.1 An entire second build of this module is invisible from the product's own
navigation, and its own screens link into dead ends.** §0.11/§1.1/§4.6a: the
bespoke `NorthShell` fork (`north/brief` and seven siblings) is reachable only by
a direct URL — the main shell's "Insight" nav link still opens the OLD system
(§4.6), and nothing in the OLD system links forward to the new one either. Two of
the new system's route names (`anomalies`, `decisions`) URL-collide with OLD-system
tab names, so the new system silently shadows those two OLD tabs at those exact
paths. And the new system is not internally consistent about its own boundary:
`north/admin` links to `/north/alerts` (gated on `north:alerts:read`) and
`north/brief` — the module's flagship, most-visited screen — links each metric
highlight to `/north/metrics?q=...`. Neither path is registered under
`NorthShell`, so both clicks silently exit the new chrome (losing the Meridian
scrubber and the scoped rail, with no visual warning) into the OLD system's
generic `:module/:resource` route. This is not one incident; it is the same class
of defect appearing twice, once on the module's own most-visited screen.

**9.2 `north.analyst` is locked out of the two screens built for them.**
The role holds `analytics:dashboards:write` and `analytics:reports:write` and
neither `:read`. Permission matching is exact-segment; there is no implied
hierarchy. Result: `/analytics/dashboard/:id` shows "You do not have permission to
open dashboards.", `/analytics/report/:id` shows "You do not have permission to
read this report.", and `/analytics` renders only Schedules and Saved views. The
seed compounds it — the `analyst.desk` dashboard and the `book.premium-by-customer`
report are both personal-scoped and owned by `north.analyst`, and that report's
`requiredPermission` is `axis:policies:read`, which the analyst also lacks. This is
a grant-list bug, not a design problem, but every design decision about the
analyst's screens is untestable until it is fixed.

**9.3 The executive's default dashboard is four permission errors.**
`dist.funnel` is the tenant default with no role allowlist; all four of its tiles
read `dist:quote_requests:read`, which `north.exec` does not hold. The exec's board
renders four grey notes reading "This tile could not be built. forbidden:
dist:quote_requests:read". Design must decide what a permission-denied tile looks
like — it must not be a raw permission string, and it must not be indistinguishable
from a tile that genuinely broke.

**9.4 Seeded runs and exports have no artefacts, and the UI does not say so.**
Every seeded `report_runs` row has `resultRef: null` and every seeded
`analytics_exports` row has `fileId: null`. The rows list normally, show sizes
(48,210 bytes, 12,884 bytes) and download counts (2, 1, 3), and any download
attempt 404s. Newly generated exports work correctly end to end. **The UI needs a
truthful state for "this row is a record of something that produced no artefact"**
— distinct from ready, from expired and from failed. Today all five states share a
neutral grey badge.

**9.5 The home revenue KPI under-reports across currencies.**
The fold pins to the first row's currency and skips every other row. A multi-
currency tenant sees a fraction of its revenue under a label claiming to be
revenue, with nothing indicating rows were dropped. Design surface this — do not
hide it. Either a per-currency stat set, or the number plus an explicit
"AED only · 2 other currencies not included" line. The identical defect is in the
"Where the work is" panel.

**9.6 The paused dashboard schedule is deliberate and reads as broken.**
"Daily funnel board" is `status: paused`, `lastState: failed`, `nextRunAt: null`,
because **only report schedules are delivered — dashboard delivery is not built**.
The screen shows a paused, failed schedule with no next run and no explanation. It
needs copy that distinguishes "paused because the capability does not exist yet"
from "paused because someone paused it". And `north.exec`, whose morning PDF this
concerns, cannot see the Schedules tab at all.

**9.7 `nextRunAt` on seeded rows does not match the cron expression.**
The API's `nextRun()` is a real five-field cron walker stepping minute by minute in
UTC over up to 366 days — correct. But the **seed** computes `nextRunAt`
arithmetically as "now plus an offset", so a schedule showing `0 7 * * *` may have
a "Next run" three hours from now at an arbitrary minute. Any design that presents
cron and next-run side by side will look wrong on a fresh install, and no screen
translates the cron expression into readable words.

**9.8 The Sparkline has no test.**
The only chart primitive in the design system. Nothing covers the single-value
case, the all-equal case (guarded by `span || 1`), or point placement. It is also
the component with the unresolved RTL question in §6.4. Any redesign should treat
its behaviour as unverified.

**9.9 There is no builder, no funnel, no pause, and no download from the register.**
See §4.7. Four named capabilities have data models, endpoints or labels but no
screen. (The bespoke fork's `north/board` is a partial exception — it does have a
file-download route, §4.6a.)

**9.10 AI surfaces are almost entirely absent, across both systems.**
The OLD system's three `/north` tabs that exist to hold AI output (Briefings,
Anomalies, Scenarios) render it as truncated JSON in table cells with zero ✦
marks (§4.6, §7). The bespoke fork adds exactly one real surface — `north/brief`
— across its eight screens (§4.6a, §7); the other seven have none, each by
explicit design choice recorded in its own code comments. Fifteen of the module's
eighteen screens, old and new combined, render AI-adjacent data with no ✦, no
agent attribution, and no inspectable "why". See §7 for where it belongs and for
the one screen that already does this correctly.

**9.11 Dashboard tile headings are raw English keys** stored in layout JSON,
untranslatable and un-brandable, on a screen whose entire chrome is translated.

**9.12 The Meridian design spec promises more than the shipped shell builds.**
`docs/superpowers/specs/2026-08-15-north-shell-fork-design.md`, cited directly in
`north-shell.tsx`'s own code comments, describes a scenario-picker and confidence
bands as part of the Meridian replay experience. Neither exists in the shipped
`NorthShell`: the scrubber moves a single `?asOf=` timestamp and nothing else: no
scenario selector, no confidence band rendered anywhere against a replayed value.

**9.13 `north-snapshotter.ts` reads SCOUT's and SIGNAL's tables directly,
bypassing the event bus.** CLAUDE.md rule 6 ("Events over calls… Direct
cross-module imports are forbidden except from packages/core") is written for
exactly this shape of coupling. `apps/api/src/engines/north-snapshotter.ts`
computes `whitespacePromotionRate` from `schema.scoutWhitespaces` and
`campaignReturnOnSpend`/`costPerLead`/`costPerAcquisition` from
`schema.signalSpend`/`schema.signalAttributionEvents` via direct Drizzle queries
against those modules' own tables, not via `lyra-events`. There is no code-level
link between NORTH and SCOUT or SIGNAL anywhere at the UI/route layer — the
"handover" described elsewhere as an organisational pattern between NORTH and
SCOUT/SIGNAL has no code counterpart in either direction at that layer — but at
the data layer this snapshotter is a real, working cross-module coupling that the
architecture rule above says should not exist in this form.

**9.14 `/north/whatif` has no slider, no simulator, and no confidence band —
despite what "what-if" and "scenario" imply.** A scenario is a stored question
plus free-text `name: value` assumption lines (§4.6a); there is no engine in this
codebase that computes an answer from them (`apps/api/src/engines` holds the
snapshotter and the board pack, not a scenario engine), so a saved scenario's
result stays empty until something else fills it in by hand, and the screen says
so explicitly rather than fabricating a range. This is a genuine capability gap
against the feature's name, not a rendering defect — the screen is honest about
the gap it has, which is the right call given the gap exists at all.

---

## Appendix — copy reference

Every user-visible string this module renders today, in English, by screen.

**Shared** — "{count} shown" · "{count} in total" · "Nothing here yet" · "No records
match this view. Clear the filters, or create the first one." · "No records match
these filters." · "Nothing has been deleted here." · "Your roles do not include
access to this area." · "There is nothing at this address." · "This did not load" ·
"The page could not be built. Nothing was saved, and you can try again." · "Try
again" · "Reference {id}" · "Search" · "Apply" · "Clear" · "All" · "New" ·
"Create" · "Save changes" · "Delete" · "Cancel" · "Edit" · "Open" · "Back to list" ·
"Next" · "Previous" · "Working…" · "Saved" · "Yes" · "No" · "Actions" · "Delete this
record? It is retained for audit and can be restored by an administrator." ·
"Restore" · "Records shown" · "Live records" · "Deleted records" · "You are looking
at deleted records. They stay out of the live list until you restore them." · "Back
to live records" · "Record" · "Details" · "History" · "Created" · "Updated" ·
"Identifier" · "Sections" · "Reports and tools" · "Filters".

**Home** — "Welcome back, {name}" · "What is waiting for you in {brand}." · "Waiting
on you" · "Unread" · "Revenue, 30 days" · "Change is margin after AI and media
cost" · "Units delivered" · "Units delivered per day over the last 30 days" ·
"Decisions waiting on you" · "Subject {ref}" · "{count} more waiting elsewhere" ·
"Open the full queue" · "Deciding…" · "That decision was not recorded, and nothing
changed." · "Mark as read" · "Dismissing…" · "Nothing unread." · "A scheduled report
was delivered" · "A scheduled report reached only some recipients" · "A scheduled
report could not be produced" · "Recent agent work" · "Agent console" · "Running" ·
"Awaiting approval" · "Finished" · "Refused" · "Failed" · "Cancelled" · "Stopped on
budget" · "Where the work is" · "Delivery by area over the last 30 days" · "{count}
delivered" · "Your workspaces" · "This did not load. Nothing is wrong with your
work — try again in a moment." · "Reload" · "Nothing is waiting" · "Open a
workspace".

**Dashboard** — "Dashboard" · "You do not have permission to open dashboards." ·
"This dashboard is not available to you." · "This dashboard could not be built." ·
"This dashboard has no tiles yet." · "This tile could not be built." · "No figures
in this window." · "Generated" · "Total".

**Report** — "Report" · "Parameters" · "From" · "To" · "Bucket by" · "No bucketing" ·
"Row limit" · "Run report" · "Running the report…" · "Ran just now." · "This report
has not been run yet." · "Last run" · "A run is still in progress. No figures are
shown until it finishes." · "The last run failed." · "Figures are not kept between
visits. Run the report to see them." · "You may read this report but not run it." ·
"Results" · "Totals" · "Cut off at the row limit — narrow the window or export the
full set." · "Generated" · "Definition" · "Dataset" · "Metrics" · "Dimensions" ·
"Export" · "Format" · "Export ready" · "Download" · "Excel (.xlsx)" · "PDF" · "CSV" ·
"JSON" · "You do not have permission to read this report." · "Queued" · "Running" ·
"Done" · "Failed" · "Rendering" · "Ready" · "Expired" · "Recent runs" · "Started" ·
"State" · "Rows" · "Duration" · "Reason" · "ms" · "KB" · "This report reads personal
data" · "Identifying columns come back pseudonymised unless your role may see them,
and exports are masked the same way." · "It reaches direct identifiers. Every
download is written to the audit log, exports are masked by default, and an
unmasked copy needs a written reason plus a second approver — ask an administrator
rather than working around it." · "The export could not be written." · "Link
expires" · "Masked" · "Unmasked" · "This file is no longer downloadable."

**Analytics workspace** — "Dashboards" · "Reports" · "Runs" · "Exports" ·
"Schedules" · "Saved views" · "Unit economics" · "Journey events" · "Report
builder" · "Open dashboard" · "Key" · "Name" · "PII level" · "Last result" · "Rows" ·
"Duration" · "Truncated" · "Expires" · "Reason" · "Requested by" · "Approved by" ·
"Parameters" · "Size" · "File" · "Downloads" · "Masked" · "Reason for unmasked
data" · "Schedule" · "Time zone" · "Recipients" · "Next run" · "Screen" · "Day" ·
"Unit" · "Volume" · "Revenue" · "Human minutes" · "Journey" · "Step" · "Actor" ·
"Subject" · "Outcome" · "When" · "Tenant" · "Team" · "Personal" · "None" · "Low" ·
"High" · "Active" · "Paused" · "Delivered" · "Partial" · "Undelivered" · "Person" ·
"API" · "Progressed" · "Completed" · "Abandoned" · "Portrait" · "Landscape".

**Insight workspace** — "Metrics" · "Snapshots" · "Briefings" · "Anomalies" ·
"Scenarios" · "Board packs" · "Decisions" · "Count" · "Money" · "Percent" · "Ratio" ·
"Duration" · "Daily" · "Weekly" · "Monthly" · "Public" · "Internal" · "Restricted" ·
"Up is good" · "Down is good" · "Exec" · "Board" · "Investor" · "Draft" · "Review" ·
"Published" · "Final" · "Distributed" · "New" · "Explained" · "Action created" ·
"Dismissed" · "Open" · "Reviewed" · "Reversed".

**NorthShell — Brief (`north/brief`) — the module's only real ✦ surface, English
strings verified verbatim against `LABELS.en` in `north-brief.tsx`** — "Narrated
by NORTH from the live ledger" (the kicker beside the ✦ mark; Arabic: "صياغة نورث
من السجل الحي") · "Numbers unverified" (the draft-status `GuardrailNotice`) ·
"Board pack" · "What-if" (the two outbound links). Full copy for this screen's
remaining labels (form fields, empty states, per-audience/per-status text) was
read in a prior pass in this session but is not re-quoted here verbatim; treat
only the strings above as confirmed against this final read.

**NorthShell — Scenarios (`north/whatif`) — English strings verified verbatim
against `LABELS.en` in `north-whatif.tsx`** — "Scenarios" · "What if — asked once,
kept for the next person who asks it" · "The Brief" · "A scenario is a question
plus the assumptions it rests on. Both are stored so the answer can be argued
with later, which is the only kind of answer worth keeping." · "Ask a what-if" ·
"The question" · "What if we move a fifth of the motor book onto the panel?"
(hint copy) · "Assumptions" · "Asked by" · "Save the question" · "Saving records
the question and its assumptions. No engine computes the answer yet, so the
result stays empty until somebody fills it in." · "Saved scenarios" · "Every
scenario asked in this tenant, most recent first" · "Question" · "Asked" ·
"Result" · "Open" · "Answered" · "Unanswered" · "What it assumes" · "What it
answers" · "Nothing has answered this yet. The question and its assumptions are
stored; the result is empty because no engine has run against them." · "Shared
with" · "Model run" · "Not recorded" · "These are point estimates. No confidence
band was stored with them, so read them as a single line through a range nobody
has measured." · "No scenarios have been asked" · "The first question somebody
writes down is the first one anybody else can argue with." · "You do not have
permission to read scenarios. Ask a tenant administrator for NORTH scenario
access." · "Scenario saved." · "Queued for approval" · "Saving this scenario
needs sign-off under policy {policy}. It is queued, not lost." · "Open the
approvals queue" · "Write the question out — a scenario without one cannot be
argued with later." · "Put your name to it." · "Assumptions are read one per line
as name: value. One of these lines carried no name."

**The other six bespoke-fork screens** (`north/explorer`, `north/anomalies`,
`north/board`, `north/board/:id/file`, `north/decisions`, `north/admin`,
`north/dev`) were read in a prior pass in this session; their exact copy strings
are deliberately omitted here rather than quoted from memory — see §4.6a for
their confirmed structural facts (permissions, endpoints, state machines).

# ui.md — the LYRA UI inventory

Every screen the product renders, the route that serves it, the data it loads,
what a person can do on it, what gates that action, and the rules every screen
obeys whether or not it remembers to.

**Status.** As-built, read from the code. The eight `docs/ui/*.md` briefs were
refreshed against current code on 2026-08-20 (AXIS's nineteen bespoke routes
under [axis-shell.tsx](apps/web/app/routes/axis-shell.tsx) and its AI surfaces
included) and now agree with this file. This file stays the route index and
shared-vocabulary layer (§§1-8); `docs/ui/*.md` is the per-screen depth layer
(§9). Where the two still disagree, treat it as drift to fix, not a
tiebreaker to invoke.

**Keep it current.** A new screen that is not in this file is a screen nobody
can find. Adding one is part of the same PR, the same way `/docs` is.

---

## 1. The two kinds of screen

LYRA has 109 declared routes and only two shapes behind them.

**Generated.** Most of a workspace is lists and records, so those are *one pair*
of route files driven by declarative specs in [apps/web/app/modules/](apps/web/app/modules/):

- [module.tsx](apps/web/app/routes/module.tsx) — `/:module` and `/:module/:resource`, the tabbed list
- [record.tsx](apps/web/app/routes/record.tsx) — `/:module/:resource/:id`, the single record

Adding a resource adds a `ResourceSpec` entry, not a route. 133 resource tabs
across 10 workspaces render this way. §7 is the full table.

**Bespoke.** A screen that is genuinely its own thing — a quote comparison, a
trial balance, the approvals queue, a journey builder — gets a static path.
React Router ranks a static segment above the dynamic `:module`, so it wins the
match without ceremony. §8 onward.

The rule for choosing: if it is a list of rows with a filter and a form, it is a
spec. If the *shape of the answer* is the point, it is a route.

---

## 2. Shells and the layout language

### 2.1 The five shells

| Shell | File | Wraps |
| --- | --- | --- |
| Workspace | [workspace.tsx](apps/web/app/routes/workspace.tsx) | everything behind a session that is not a module shell |
| AXIS | [axis-shell.tsx](apps/web/app/routes/axis-shell.tsx) | `/axis/*` bespoke screens |
| ORBIT | [orbit-shell.tsx](apps/web/app/routes/orbit-shell.tsx) | `/orbit/*` bespoke screens |
| SIGNAL | [signal-shell.tsx](apps/web/app/routes/signal-shell.tsx) | `/signal/*` bespoke screens |
| SCOUT | [scout-shell.tsx](apps/web/app/routes/scout-shell.tsx) | `/scout/*` bespoke screens |
| NORTH | [north-shell.tsx](apps/web/app/routes/north-shell.tsx) | `/north/*` bespoke screens |

**Module switcher (ADR-0085 amendment).** The top bar names the module the
reader is in (its hue dot and name, "Modules" outside one) and opens every
workspace they may open, grouped as the rail groups them (`switcherFor`,
[menu.ts](apps/web/app/components/menu.ts)). On a phone the strip under the bar
carries only the current module's screens and records.

**One frame (ADR-0085).** The five module layouts are routes (they gate a
module and let a build ship one alone), but they all render the one
[`Shell`](apps/web/app/components/shell.tsx) through
[`ModuleShell`](apps/web/app/components/module-shell.tsx). The rail reads, top
to bottom: **Home and Inbox** (approvals waiting on the reader, with a count) →
inside any workspace, **its menu** ([components/menu.ts](apps/web/app/components/menu.ts)):
its screens (a module's from [modules/screens.ts](apps/web/app/modules/screens.ts),
each filtered by the permission its loader needs; a shared workspace's from its
spec `links`), then its record lists under a "Records" disclosure → every
workspace the API's nav offers. The same menu shows on a module's generic lists
and on its bespoke screens; the page's tab strip is kept for phones only. The Meridian day strip is NORTH's only. A
paused module (the AI kill switch, J-A3) shows a degraded-mode banner on every
screen of it. ⌘K indexes every tab the reader may open. Every screen's
`<title>` is "Screen · Workspace · Product" ([title.ts](apps/web/app/title.ts)).

All of them call `bootstrapSession()` ([session.server.ts](apps/web/app/session.server.ts)),
which is the single source of shell data: **actor, tenant brand, permissions,
and the nav the API has already filtered for that actor**. A route reads it with
`useShellData()` / `useAxisSessionData()` / `useOrbitSessionData()` / … — a
`useRouteLoaderData` hook per shell, so a screen never refetches identity.

Module shells are conditional: [routes.ts](apps/web/app/routes.ts) wraps each
module block in `shouldInclude("axis")` etc. ([routing.ts](apps/web/app/routing.ts)),
so `LYRA_MODULES` gates the route table and the module index off the same answer.
A disabled module has no routes at all, not hidden ones.

**Error boundaries are per shell, not per document.** `workspace.tsx` has its own
`ErrorBoundary`: without it, hitting `/north` without a NORTH role fell through to
root's boundary, which replaces the whole document — dropping the rail, the day
strip and the tenant's brand, so a closed door read as a crash. The boundary also
survives its own loader having failed, in which case it renders a bare
[error-panel](apps/web/app/components/error-panel.tsx) with no shell around it.

### 2.2 Chrome bands (ADR-0068)

The chrome is **bands, never overlays**. Each has a token'd height in
[tokens.css](packages/ui/src/tokens.css) so the canvas can subtract them and
nothing floats over content:

| Token | Height | Band |
| --- | --- | --- |
| `--chrome-top` | 50px | top bar — brand, search, actor |
| `--chrome-module` | 38px | module band — the module rail / switcher strip |
| `--chrome-meridian` | 74px | today's strip (NORTH, ADR-0061) |
| `--chrome-status` | 28px | status strip |
| `--rail-width` | 196px → 252px at ≥1240px | the nav rail |

Spacing is a 4px grid (`--space-base`), with `--gutter` 12px→16px at ≥640px,
`--gutter-canvas` 16px→24px, `--gutter-rail` 12px, and `--stack-gap` 16px as the
vertical rhythm between canvas blocks. A screen that invents its own padding is a
bug; every frame comes from these.

### 2.3 Horizon grammar

[horizon.tsx](packages/ui/src/horizon.tsx) is the editorial layer of Constellation
(ADR-0031, docs/07 §2) — seven marks repeated on every surface, extracted so a
screen composes them instead of re-deriving inline styles:

| Mark | Component | What it is |
| --- | --- | --- |
| eyebrow | `Eyebrow` | small tracked-out label saying what a block *is* |
| lede | `Lede` | one serif sentence saying what it *means* (the serif's only role besides the login hero and home headline, docs/01 §4) |
| figure | `Figure` | every number in mono, tabular, unit set quietly (`tone`: neutral/ok/bad; `size`: sm/md/lg) |
| hue bar | `HueBar` | 2px of module colour, drawn once per page by the shell; a `Panel` signs its module with the eyebrow's dot instead, so bars never stack |
| hairline | `Hairline` | a rule instead of a shadow |
| answer | `AnswerBanner` | ✦, who it was answered for, how long it took |
| provenance | `Provenance` | the "why" behind an AI artifact, inspectable in place |

Plus `Panel` (the framed block), `AutoGrid` (`min` default `17rem`), and
`hueVar(module)` which returns `var(--module-<name>)` or the neutral `var(--accent)`
for surfaces belonging to no module (home, settings, the ledger shell).

Module hues are fixed: AXIS `#e8a33d`, ORBIT `#3fc9b4`, SIGNAL `#f0764f`,
SCOUT `#6c9ef0`, NORTH `#a98be8`. `--chart-1..5` alias them, so a chart of
per-module figures is already colour-consistent with the rail.

### 2.4 Type and motion

Display `Archivo`, UI `Instrument Sans`, mono `IBM Plex Mono`, serif
`Instrument Serif`, Arabic `IBM Plex Sans Arabic` in every stack. Three type
roles are utilities in tokens.css — `page-title` (Archivo 600, 28/1.15),
`section-title` (Archivo 600, 18), `eyebrow` (12, tracked, drops tracking in
Arabic) — and a guard fails on a copied recipe or a stray serif. KPI figures are
Archivo 700 tabular. Every Tailwind class must compile to CSS
([classes.resolve.test.ts](apps/web/app/classes.resolve.test.ts)). Nine sizes
`--text-12` … `--text-48`; `--leading-body` 1.5, `--leading-display` 1.15.
Radii are small on purpose (2/3/6px) with `--radius-orbit: 999px` for pills.
Motion: `--duration-fast|medium|slow` 120/180/240ms on `--ease-observatory`
and `--ease-settle`.

---

## 3. Constellation — the component inventory

Everything a screen may use, from [packages/ui/src/](packages/ui/src/). Nothing
outside this list is a shared component; a one-off lives with its route.

### 3.1 `primitives.tsx` — controls and containers

`Button` (`primary|secondary|ghost|danger` × `sm|md|lg`), `IconButton` (requires
`label`), `Field` + `useFieldControl`, `Input` (with `prefix`/`suffix`),
`Textarea`, `DatePicker` (`calendar`, `withTime`), `Select` +
`toSelectValue`/`fromSelectValue`, `Checkbox`, `RadioGroup`, `Switch`, `Slider`,
`Card`, `PageHeader` (`eyebrow`, `title`, `description`, `back`, `meta`),
`Badge`/`Tag` (`neutral|accent|success|danger|warning|info`), `Avatar`,
`Skeleton`, `Separator`, `Tabs`, `ProgressBar`.

### 3.2 `overlays.tsx` — anything that sits above

`Dialog`, `Drawer`, `Tooltip`, `Popover`, `Menu`, `ToastProvider` + `useToast`,
`CommandBar` + `groupCommandItems`. Overlays are for *interaction*, never for
telling the user something the page could have said (§5).

### 3.3 `data.tsx` — lists, numbers, history

`Table` (generic `Column<T>`, `SortState`), `Pagination`, `EmptyState`, `Stat`,
`Sparkline`, `LineChart`, `DonutChart`, `KPIWall`, `Timeline`, `AuditTrail`.

### 3.4 `flow.tsx` — process made visible

- `flowPlan(...)` → `FlowPlan` from a `FlowMachine` (states + transitions) and the
  record's `FlowVisit[]` history. Each `FlowStep` is `done | current | pending`.
- `StateFlow` — the lifecycle of a transaction, settlement, claim, case or policy,
  drawn as the machine with the record's actual path through it lit.
- `PostingFlow` — double-entry made visual: `FlowLeg`s moving between accounts with
  a `FlowBalance`, so a journal reads as money moving rather than as a table.

These are the "process flows are visual and show moving, transacting data"
surfaces. A money or state screen that renders a status *word* where a
`StateFlow` would fit is under-built.

### 3.5 `format.tsx` — never print a raw value

`Money` / `MoneyField` / `formatMoney` / `minorFromMajor` / `majorFromMinor` —
money is minor units on the wire, always. `Ref` / `isOpaqueRef` / `shortRef` —
opaque ids are shortened, not dumped. `DateTime` / `formatDate` / `instantOf` /
`formatInstant` with `precision: day|time|minute|second`. `NoData` for the empty
cell.

`instantOf` returns `null` rather than an `Invalid Date`, and every caller must
handle that `null` — this is the family closed by `4f115cd eee6f44 4925eaf
21e7d69 cecc256 ed32020 2e0dd89 09a3299`. A degraded date renders the same
hover reason an empty cell does; it never renders `NaN`.

### 3.6 `nav.tsx` — the rail and the bar

`NavRail`, `NavSection`, `NavItem` (`module` tints it), `ModuleSwitcher`,
`Breadcrumbs`, `TopBar`. `LyraModule = "axis" | "orbit" | "signal" | "scout" | "north"`.

### 3.7 `ai.tsx` — the ambient AI grammar (docs/15)

`AGENT_MARK = "✦"` — the single marker every AI artifact carries. `AgentBadge`
(`agent`, `why`), `GhostText` (`onAccept` / `onDiscard`), `ConfidenceMeter`
(`floor` default 0.7), `EvidenceLink` (`source`, `sourceLabel`),
`GuardrailNotice`, `BudgetMeter`, `ApprovalStrip`.

### 3.8 `text.tsx` — the kit's own strings

`uiText(locale)` / `UiTextProvider` / `useUiText`, `KIT_TEXT` for `en` and `ar`.
Also the ambient context providers: `UiCalendarProvider` /
`useUiCalendar` (`gregorian | islamic-umalqura | dual`), `UiTimeZoneProvider` /
`useUiTimeZone`, `useUiLocale`. A component never reaches for `navigator` or
`Intl` defaults; it reads the tenant's preference from context.

### 3.9 `post-card.ts`

`postCardSvg(PostCardInput)` + `POST_RATIOS` — SIGNAL's generated social creative,
rendered server-side as SVG so a campaign preview needs no image service.

---

## 4. Rules every screen obeys

These are not style advice. Each one has a test, a lint rule, or a CI gate.

1. **Tenancy.** Every loader goes through the session's tenant. There is no
   cross-tenant read from a screen, ever (CLAUDE.md §1).
2. **Permissions withhold, they do not disable.** A tab, action, link or button
   the actor may not use **does not render**. `visibleTabs(spec, permissions)`,
   `LinkSpec.permission` and `ActionSpec` all follow the same rule. The route is
   still the authority — the UI hiding it is a courtesy, not the gate.
3. **Approval is a step, not a dialog.** Anything `consequential: true` (pricing,
   claims guidance, regulated advice, outbound send, payment) renders an
   `ApprovalStrip` and goes to `/approvals`. It never auto-commits outside the
   tenant's `auto_approve` allowlist (CLAUDE.md §4, docs/19). The gate keeps the
   request it stopped; once approved, the requester finishes it with one press
   on `/approvals` ("ready for you to finish"), replayed in their own session
   (ADR-0086).
4. **Brand tokens, not brand strings.** Name, logo and colours come from tenant
   config. A hard-coded "LYRA" in a user-facing surface is a bug (CLAUDE.md §5).
   Every session layout's `meta` is `sessionMeta` ([title.ts](apps/web/app/title.ts)):
   "Screen · Workspace · (brand.name ?? tenantName)" — never a literal.
5. **Domain-pack vocabulary.** No industry noun is hard-coded. Every label goes
   through `labeller()` / `labelsIn(locale, pack)` and resolves pack → route table
   → shared table → `common.<key>` → raw key ([vocabulary.ts](apps/web/app/modules/vocabulary.ts),
   CLAUDE.md §14, ADR-0022). A qualified key (`issue.policyNo`) falls back to its
   noun (`policyNo`) so a bespoke route is reachable by a pack too.
   **Passing the `pack` argument is part of using the seam** — three routes once
   called `labelsIn(locale)` and the seam was dead there no matter what the pack said.
6. **i18n and RTL from day one.** All strings via keys, `en` and `ar`. **Logical
   CSS properties only** — `margin-inline-start`, never `margin-left`; enforced by
   [ui.test.ts](packages/ui/src/ui.test.ts) across the whole kit.
7. **Accessibility, WCAG 2.2 AA.** Keyboard-reachable, focus visible, contrast
   ≥ 4.5:1 for body text — [contrast.test.ts](packages/ui/src/contrast.test.ts) asserts
   the palette (`--star-500` is 6.32:1 on `--ink-900`; `--vega-700` exists because
   `--vega-500` fails AA as text on light). axe-core runs inside the journey specs
   via `expectNoA11yViolations` ([e2e/a11y.ts](e2e/a11y.ts)), so the `e2e` CI job is
   the a11y gate — there is no separate one.
8. **Ambient AI grammar (docs/15).** AI is ghost text, quiet chips and background
   drafts. Never a modal. Never auto-send outside autonomy policy. Every AI
   artifact carries ✦ and an inspectable "why". A new AI surface maps to a pattern
   in docs/15 §4 or adds one via ADR.
9. **Empty, degraded and error are designed states.** `EmptyState` for nothing yet,
   `NoData` for a missing cell, the shell's `ErrorPanel` for a failed loader. A
   degraded value shows its reason on hover; it never shows `NaN`, `Invalid Date`,
   or a silently-zeroed figure.
10. **A web type that mirrors an API type says so.** It carries a comment naming
    the file it mirrors, and its fixture is in the shape the *server* sends — not
    the shape the screen assumed. `whitespace-commentary.tsx` shipped sharing one
    field with its endpoint and every figure read `undefined`, green the whole way,
    because the fixtures mocked the assumption.

---

### 4.1 Density (2026-09-23)

A staff screen is read, not admired: the data comes first and fills the fold.
Three rules, each held by `layoutFindings` in `scripts/sweep-lib.mjs` (run by
`scripts/sweep.mjs` at 1440×900; `SWEEP_ONLY=/a,/b` for a quick loop):

1. **Data starts in the top half.** The first row, figure (`Stat` carries
   `data-stat`), chart or list item sits above 450px. A register with a
   composer uses [`WorkLayout`](apps/web/app/components/work-layout.tsx) —
   data column first, the form in a sticky aside on xl, stacked below on
   narrower screens. Generic lists keep **one toolbar row** (saved view,
   search, filters named in their own "All" choice) and put **New / Import**
   in the header as panels that drop over the table; the bulk bar exists only
   while rows are ticked.
2. **Say a sentence once.** A headline is not restated as the card caption and
   again as the empty state's body. Empty states are compact (`EmptyState`, a
   small mark, one teaching line, one action).
3. **Long screens carry in-page navigation.** Over four viewports tall means a
   `nav` of anchored sections or tabs.

Tables default to `compact`; `Stat` figures are `text-22`.

## 5. Interaction conventions

**Navigation.** The rail is the primary; the module band switches workspace; the
breadcrumb is where you are, not where you can go. `routeDiscovery: { mode: "initial" }`
([react-router.config.ts](apps/web/react-router.config.ts)) ships the full manifest with
the document — lazy discovery deduped a navigation's own request against the eager
batch and left `navigate()` awaiting a promise nothing settled.

**Search.** `/search` ([search.ts](apps/web/app/routes/search.ts)) is a resource route
feeding the top bar; `/search/results` ([search-results.tsx](apps/web/app/routes/search-results.tsx))
is the screen. `CommandBar` + `groupCommandItems` is the keyboard path.

**The companion rail.** `/companion` ([companion.ts](apps/web/app/routes/companion.ts))
has no screen of its own — it feeds the shell's companion rail.

**Drill-down.** Every hero figure is a link. `Figure` inside a `KPIWall` resolves to
the list or record that produced it; a number that cannot be opened is a number
nobody can check.

**Forms.** `Field` owns the label/description/error wiring via `useFieldControl`;
a bare `<input>` beside a `<label>` is not the pattern. Money is `MoneyField`
(minor units), dates are `DatePicker` (calendar-aware), a set is `Select` with
`toSelectValue`.

**Toasts confirm, they do not inform.** A toast follows an action the user took.
Anything the user needs to *read* belongs on the page.

---

## 6. Route index

All 123 declared routes, in manifest order. `routes.inventory.test.ts` holds
this table to `apps/web/app/routes.ts` — URL, route module and the count above —
so a screen cannot ship missing from the inventory a reader is told to consult
first. What each screen *does* is still written by hand; what exists is not.

| URL | Route module |
| --- | --- |
| `/` | [home.tsx](apps/web/app/routes/home.tsx) |
| `/login` | [login.tsx](apps/web/app/routes/login.tsx) |
| `/logout` | [logout.tsx](apps/web/app/routes/logout.tsx) |
| `/portal/:tenantSlug` | [portal.$tenantSlug.tsx](apps/web/app/routes/portal.$tenantSlug.tsx) |
| `/portal/:tenantSlug/privacy` | [portal.$tenantSlug.privacy.tsx](apps/web/app/routes/portal.$tenantSlug.privacy.tsx) |
| `/portal/:tenantSlug/register` | [portal.$tenantSlug.register.tsx](apps/web/app/routes/portal.$tenantSlug.register.tsx) |
| `/portal/:tenantSlug/quotes/:id` | [portal.$tenantSlug.quotes.$id.tsx](apps/web/app/routes/portal.$tenantSlug.quotes.$id.tsx) |
| `/portal/:tenantSlug/partners` | [portal.$tenantSlug.partners.tsx](apps/web/app/routes/portal.$tenantSlug.partners.tsx) |
| `/portal/:tenantSlug/renewals/:id` | [portal.$tenantSlug.renewals.$id.tsx](apps/web/app/routes/portal.$tenantSlug.renewals.$id.tsx) |
| `/portal/:tenantSlug/feedback/:id` | [portal.$tenantSlug.feedback.$id.tsx](apps/web/app/routes/portal.$tenantSlug.feedback.$id.tsx) |
| `/settings` | [settings.tsx](apps/web/app/routes/settings.tsx) |
| `/settings/:tab` | [settings.tsx](apps/web/app/routes/settings.tsx) |
| `/approvals` | [approvals.tsx](apps/web/app/routes/approvals.tsx) |
| `/admin/ai/console` | [ai-console.tsx](apps/web/app/routes/ai-console.tsx) |
| `/center` | [command-center.tsx](apps/web/app/routes/command-center.tsx) |
| `/admin/ai/budget` | [ai-budget.tsx](apps/web/app/routes/ai-budget.tsx) |
| `/admin/ai/analytics` | [ai-analytics.tsx](apps/web/app/routes/ai-analytics.tsx) |
| `/admin/ai/runs/:id` | [ai-run.tsx](apps/web/app/routes/ai-run.tsx) |
| `/admin/cost-explorer` | [cost-explorer.tsx](apps/web/app/routes/cost-explorer.tsx) |
| `/ledger/reports/:report` | [ledger-reports.tsx](apps/web/app/routes/ledger-reports.tsx) |
| `/ledger/money-map` | [ledger-money-map.tsx](apps/web/app/routes/ledger-money-map.tsx) |
| `/ledger/transactions` | [ledger-open-txn.tsx](apps/web/app/routes/ledger-open-txn.tsx) |
| `/ledger/transactions/:id` | [ledger-transaction.tsx](apps/web/app/routes/ledger-transaction.tsx) |
| `/ledger/period-close` | [ledger-periods.tsx](apps/web/app/routes/ledger-periods.tsx) |
| `/ledger/year-end` | [ledger-year-end.tsx](apps/web/app/routes/ledger-year-end.tsx) |
| `/ledger/fx-revaluation` | [ledger-fx-revaluation.tsx](apps/web/app/routes/ledger-fx-revaluation.tsx) |
| `/ledger/journal` | [ledger-journal.tsx](apps/web/app/routes/ledger-journal.tsx) |
| `/ledger/statement` | [ledger-account.tsx](apps/web/app/routes/ledger-account.tsx) |
| `/ledger/recon` | [ledger-recon.tsx](apps/web/app/routes/ledger-recon.tsx) |
| `/analytics/builder` | [analytics-builder.tsx](apps/web/app/routes/analytics-builder.tsx) |
| `/analytics/report/:id` | [analytics-report.tsx](apps/web/app/routes/analytics-report.tsx) |
| `/analytics/dashboard/:id` | [analytics-dashboard.tsx](apps/web/app/routes/analytics-dashboard.tsx) |
| `/distribution/quote-requests/:id/compare` | [quote-compare.tsx](apps/web/app/routes/quote-compare.tsx) |
| `/distribution/commission-entries/statement` | [commission-statement.tsx](apps/web/app/routes/commission-statement.tsx) |
| `/distribution/commission-entries/:id/clawback` | [commission-clawback.tsx](apps/web/app/routes/commission-clawback.tsx) |
| `/distribution/next-best-offers/suggest` | [dist-offers.tsx](apps/web/app/routes/dist-offers.tsx) |
| `/compliance/run/:kind` | [compliance-run.tsx](apps/web/app/routes/compliance-run.tsx) |
| `/ledger/settlement` | [settlement.tsx](apps/web/app/routes/settlement.tsx) |
| `/ledger/settlements/:id` | [settlement-detail.tsx](apps/web/app/routes/settlement-detail.tsx) |
| `/admin/permissions` | [admin-roles.tsx](apps/web/app/routes/admin-roles.tsx) |
| `/admin/developer` | [admin-developer.tsx](apps/web/app/routes/admin-developer.tsx) |
| `/admin/security` | [admin-security.tsx](apps/web/app/routes/admin-security.tsx) |
| `/admin/automation` | [admin-automation.tsx](apps/web/app/routes/admin-automation.tsx) |
| `/admin/audit-export` | [admin-audit-export.tsx](apps/web/app/routes/admin-audit-export.tsx) |
| `/admin/staff` | [staff.tsx](apps/web/app/routes/staff.tsx) |
| `/admin/staff/:id` | [staff-member.tsx](apps/web/app/routes/staff-member.tsx) |
| `/platform` | [platform.tsx](apps/web/app/routes/platform.tsx) |
| `/design` | [design.tsx](apps/web/app/routes/design.tsx) |
| `/search` | [search.ts](apps/web/app/routes/search.ts) |
| `/companion` | [companion.ts](apps/web/app/routes/companion.ts) |
| `/search/results` | [search-results.tsx](apps/web/app/routes/search-results.tsx) |
| `/onboarding/:kind/:ref` | [onboarding.tsx](apps/web/app/routes/onboarding.tsx) |
| `/admin/customers/:id/360` | [customer-360.tsx](apps/web/app/routes/customer-360.tsx) |
| `/admin/products/:id/detail` | [product-detail.tsx](apps/web/app/routes/product-detail.tsx) |
| `/distribution/channels/:id/detail` | [channel-detail.tsx](apps/web/app/routes/channel-detail.tsx) |
| `/surface/:module/:screen` | [surface.tsx](apps/web/app/routes/surface.tsx) |
| `/journey/axis` | [journey-axis.tsx](apps/web/app/routes/journey-axis.tsx) |
| `/journey/north` | [journey-north.tsx](apps/web/app/routes/journey-north.tsx) |
| `/journey/scout` | [journey-scout.tsx](apps/web/app/routes/journey-scout.tsx) |
| `/journey/signal` | [journey-signal.tsx](apps/web/app/routes/journey-signal.tsx) |
| `/:module` | [module.tsx](apps/web/app/routes/module.tsx) |
| `/:module/:resource` | [module.tsx](apps/web/app/routes/module.tsx) |
| `/:module/:resource/:id` | [record.tsx](apps/web/app/routes/record.tsx) |
| `/axis/exceptions` | [axis-exceptions.tsx](apps/web/app/routes/axis-exceptions.tsx) |
| `/axis/board` | [axis-board.tsx](apps/web/app/routes/axis-board.tsx) |
| `/axis/quote-desk` | [axis-quote-desk.tsx](apps/web/app/routes/axis-quote-desk.tsx) |
| `/axis/doc-intelligence` | [axis-doc-intel.tsx](apps/web/app/routes/axis-doc-intel.tsx) |
| `/axis/documents/:id/file` | [axis-document-file.tsx](apps/web/app/routes/axis-document-file.tsx) |
| `/axis/analytics` | [axis-analytics.tsx](apps/web/app/routes/axis-analytics.tsx) |
| `/axis/admin` | [axis-admin.tsx](apps/web/app/routes/axis-admin.tsx) |
| `/axis/dev` | [axis-dev.tsx](apps/web/app/routes/axis-dev.tsx) |
| `/axis/process-map` | [axis-process-map.tsx](apps/web/app/routes/axis-process-map.tsx) |
| `/axis/claims/new` | [fnol-intake.tsx](apps/web/app/routes/fnol-intake.tsx) |
| `/axis/claims/desk` | [claims-desk.tsx](apps/web/app/routes/claims-desk.tsx) |
| `/axis/renewals` | [renewal-desk.tsx](apps/web/app/routes/renewal-desk.tsx) |
| `/axis/referrals` | [referral-desk.tsx](apps/web/app/routes/referral-desk.tsx) |
| `/axis/policies/:id/detail` | [policy-detail.tsx](apps/web/app/routes/policy-detail.tsx) |
| `/axis/policies/:id/endorse` | [policy-endorse.tsx](apps/web/app/routes/policy-endorse.tsx) |
| `/axis/policies/:id/cancel` | [policy-cancel.tsx](apps/web/app/routes/policy-cancel.tsx) |
| `/axis/claims/:id/detail` | [claim-detail.tsx](apps/web/app/routes/claim-detail.tsx) |
| `/axis/cases/:id/evidence-bundles/:bundleId/download` | [case-evidence-download.tsx](apps/web/app/routes/case-evidence-download.tsx) |
| `/axis/cases/:id/detail` | [case-detail.tsx](apps/web/app/routes/case-detail.tsx) |
| `/axis/bordereaux` | [axis-bordereaux.tsx](apps/web/app/routes/axis-bordereaux.tsx) |
| `/orbit/conversations/:id/thread` | [conversation.tsx](apps/web/app/routes/conversation.tsx) |
| `/orbit/console` | [orbit-console.tsx](apps/web/app/routes/orbit-console.tsx) |
| `/orbit/supervisor` | [orbit-supervisor.tsx](apps/web/app/routes/orbit-supervisor.tsx) |
| `/orbit/save` | [orbit-save.tsx](apps/web/app/routes/orbit-save.tsx) |
| `/orbit/pipeline` | [orbit-pipeline.tsx](apps/web/app/routes/orbit-pipeline.tsx) |
| `/orbit/quality` | [orbit-quality.tsx](apps/web/app/routes/orbit-quality.tsx) |
| `/orbit/analytics` | [orbit-analytics.tsx](apps/web/app/routes/orbit-analytics.tsx) |
| `/orbit/admin` | [orbit-admin.tsx](apps/web/app/routes/orbit-admin.tsx) |
| `/orbit/dev` | [orbit-dev.tsx](apps/web/app/routes/orbit-dev.tsx) |
| `/orbit/journeys/:id/builder` | [orbit-journey.tsx](apps/web/app/routes/orbit-journey.tsx) |
| `/signal/cockpit` | [signal-cockpit.tsx](apps/web/app/routes/signal-cockpit.tsx) |
| `/signal/studio` | [signal-studio.tsx](apps/web/app/routes/signal-studio.tsx) |
| `/signal/creatives/:id/image` | [signal-creative-image.tsx](apps/web/app/routes/signal-creative-image.tsx) |
| `/signal/audience-value` | [signal-audience-value.tsx](apps/web/app/routes/signal-audience-value.tsx) |
| `/signal/answer-engines` | [signal-answer-engines.tsx](apps/web/app/routes/signal-answer-engines.tsx) |
| `/signal/experiments` | [signal-experiments.tsx](apps/web/app/routes/signal-experiments.tsx) |
| `/signal/budget` | [signal-budget.tsx](apps/web/app/routes/signal-budget.tsx) |
| `/signal/analytics` | [signal-analytics.tsx](apps/web/app/routes/signal-analytics.tsx) |
| `/signal/admin` | [signal-admin.tsx](apps/web/app/routes/signal-admin.tsx) |
| `/signal/dev` | [signal-dev.tsx](apps/web/app/routes/signal-dev.tsx) |
| `/scout/radar` | [scout-radar.tsx](apps/web/app/routes/scout-radar.tsx) |
| `/scout/whitespace/:id` | [scout-whitespace.tsx](apps/web/app/routes/scout-whitespace.tsx) |
| `/scout/panel` | [scout-panel.tsx](apps/web/app/routes/scout-panel.tsx) |
| `/scout/pricing` | [scout-pricing.tsx](apps/web/app/routes/scout-pricing.tsx) |
| `/scout/experiments` | [scout-experiments.tsx](apps/web/app/routes/scout-experiments.tsx) |
| `/scout/analytics` | [scout-analytics.tsx](apps/web/app/routes/scout-analytics.tsx) |
| `/scout/data-products` | [scout-data-products.tsx](apps/web/app/routes/scout-data-products.tsx) |
| `/scout/admin` | [scout-admin.tsx](apps/web/app/routes/scout-admin.tsx) |
| `/scout/dev` | [scout-dev.tsx](apps/web/app/routes/scout-dev.tsx) |
| `/north/brief` | [north-brief.tsx](apps/web/app/routes/north-brief.tsx) |
| `/north/explorer` | [north-explorer.tsx](apps/web/app/routes/north-explorer.tsx) |
| `/north/anomalies` | [north-anomalies.tsx](apps/web/app/routes/north-anomalies.tsx) |
| `/north/journeys` | [north-journeys.tsx](apps/web/app/routes/north-journeys.tsx) |
| `/north/alerts` | [north-alerts.tsx](apps/web/app/routes/north-alerts.tsx) |
| `/north/whatif` | [north-whatif.tsx](apps/web/app/routes/north-whatif.tsx) |
| `/north/board` | [north-board.tsx](apps/web/app/routes/north-board.tsx) |
| `/north/board/:id/file` | [north-board-file.tsx](apps/web/app/routes/north-board-file.tsx) |
| `/north/decisions` | [north-decisions.tsx](apps/web/app/routes/north-decisions.tsx) |
| `/north/admin` | [north-admin.tsx](apps/web/app/routes/north-admin.tsx) |
| `/north/dev` | [north-dev.tsx](apps/web/app/routes/north-dev.tsx) |

---

## 7. Generated workspace screens

Two route files render all of these:

- **List** — `/:module` and `/:module/:resource` ([module.tsx](apps/web/app/routes/module.tsx)).
  Tabs across the top (only those the actor may read), a link strip to the
  workspace's bespoke screens, a search box where the API registered the resource
  searchable, filters, sortable columns, pagination, and create when the spec
  names `create` and the actor holds it.
  A tab may also declare **`bulk`** (a checkbox column plus a bar that applies
  one action to the selection, answered per row) and **`import`** (a CSV file
  posted as `{ csv }`, answered with every refused line). Cases declare both
  (AXIS-001, AXIS-007); each action and the import carry their own permission.
- **Record** — `/:module/:resource/:id` ([record.tsx](apps/web/app/routes/record.tsx)).
  The record's fields, an edit form from `editable ?? fields`, delete when
  `remove` is held, the `recordLink` out to a deeper bespoke screen, and the
  state-change `actions` the API owns.

### 7.0 Saved views on the list screen

`GET /v1/analytics/saved-views?route=<path>` (docs/27 "saved views are written,
listed, and never applied", closed) answers the exact question a list screen
asks: what views exist for this resource tab, `isDefault` ordered first. The
list screen — `module.tsx` — is now that reader.

**The `route` value is the resource-tab path, never the bespoke screen one
segment away.** A saved view for the ledger transaction list is stored with
`route: "/ledger/txns"` — `${spec.path}/${tab.key}`, the generated list this
file renders — and not `/ledger/transactions`, which is `ledger-open-txn.tsx`,
a hand-built screen with no `ResourceSpec` and no saved views of its own. The
two differ by one path segment and nothing before this compared either against
the route tree; get this wrong and a view is fetched and applied to a screen
its author never saw. `module.tsx`'s loader always asks with
`${spec.path}/${tab.key}` — the same string a `ResourceSpec.recordLink`
already interpolates against — never a link's `href`.

**What "apply" means.** Only `queryJson` — the loader's own query state
(`q`, `sort`/`order`, and each declared `FilterSpec.name`) — is ever applied.
`columnsJson` is read by nothing: it implies a per-user column selection
`module.tsx` has no concept of at all, and adding one is a separate spec
change, not a corollary of this one.

**A saved view's `queryJson` may name a key this tab no longer recognises** —
a column that was never given a `FilterSpec` (`piiMasked` on `/analytics/exports`
has no declared filter, though it is a real column), or a key that matches
nothing on the resource at all (a saved view can go stale exactly the way a
seed row can). `crud.ts`'s generic list throws `badRequest("unknown filter
column …")` on any query key it does not recognise as a column, so forwarding
one straight through would turn "apply a saved view" into a 400 that crashes
the list underneath it. `queryFromSavedView` (`modules/spec.ts`) is the
narrowing point: it keeps only the keys `q`, `sort`, `order`, and a
`FilterSpec.name` declared on *this* tab, and drops everything else
silently — a narrower view is the honest degradation, not a crash.

**When it applies.** The tenant's (or the actor's own private) saved views for
the current route are fetched on every load of that tab, best-effort — an
actor without `analytics:saved_views:read` still gets the ordinary list, just
no picker (the same 4xx-except-401-swallowed shape `north-shared.tsx`'s
`readable()` uses elsewhere). A picker renders above the filter bar whenever at
least one view exists. On the *pristine* first visit to the tab — no `q`,
`sort` or declared filter already present in the URL — the `isDefault: true`
view, if one exists, is pre-applied automatically; the API already orders
`isDefault` first, so "the first one" and "the default one" are the same row.
Picking a different view, or "All", replaces the filter/sort state with that
view's (or with nothing) via `?view=<id>`; it never merges with whatever the
reader had already typed into the filter bar.

The spec is the contract ([spec.ts](apps/web/app/modules/spec.ts)):

| Field | Meaning |
| --- | --- |
| `key` | URL segment inside the workspace |
| `api` | API path, no origin |
| `read` / `create` / `update` / `remove` | permissions; an absent one means the affordance never renders |
| `columns` / `fields` / `editable` | what the list shows, what create writes, what edit writes |
| `search` / `filters` / `sort` / `order` | list behaviour |
| `revealOnCreate` | a value the create response carries once and no read returns (a signing secret, a minted key) — shown instead of discarded, never a column |
| `recordLink` | the deeper screen behind this record |
| `actions` | state changes the API owns |

Field types are meaning, not storage: `rate` is parts-per-million read as a
percentage (a channel's `400000` is 40%, not four hundred thousand), `ratio` is a
multiplier in ppm (FX 18.5 is `18500000`, never 1850%), `measure` is a number
whose unit is a sibling column (NORTH stores money, basis points, milliseconds and
counts in one `value`), `money` is minor units.

### 7.1 The 133 resource tabs


#### `/admin` — 35 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `tenants` | `/v1/core/tenants` | `core:tenants:read` |  | ✓ |  |  |  |
| `users` | `/v1/core/users` | `core:users:read` | ✓ | ✓ | ✓ | ✓ |  |
| `roles` | `/v1/core/roles` | `core:roles:read` | ✓ | ✓ | ✓ |  |  |
| `user-roles` | `/v1/core/user-roles` | `core:roles:read` | ✓ |  | ✓ |  |  |
| `teams` | `/v1/core/teams` | `core:teams:read` | ✓ | ✓ | ✓ | ✓ |  |
| `customers` | `/v1/core/customers` | `core:customers:read` | ✓ | ✓ | ✓ | ✓ |  |
| `consents` | `/v1/core/consents` | `core:consents:read` | ✓ |  |  |  |  |
| `products` | `/v1/core/products` | `core:products:read` | ✓ | ✓ | ✓ | ✓ |  |
| `providers` | `/v1/core/providers` | `core:providers:read` | ✓ | ✓ | ✓ | ✓ |  |
| `files` | `/v1/core/files` | `core:files:read` |  |  | ✓ | ✓ |  |
| `approvals` | `/v1/core/approvals` | `core:approvals:read` |  |  |  |  |  |
| `mandates` | `/v1/core/mandates` | `core:settings:read` | ✓ | ✓ | ✓ |  |  |
| `identity-verifications` | `/v1/core/identity-verifications` | `core:customers:read` |  |  |  |  |  |
| `memories` | `/v1/core/memories` | `core:settings:read` | ✓ | ✓ | ✓ |  |  |
| `lenses` | `/v1/core/lenses` | `core:settings:read` | ✓ | ✓ | ✓ |  |  |
| `rulepacks` | `/v1/core/rulepacks` | `compliance:rulepacks:read` | ✓ | ✓ |  |  |  |
| `api-keys` | `/v1/core/api-keys` | `core:api_keys:read` |  |  | ✓ |  |  |
| `identity-providers` | `/v1/core/identity-providers` | `core:identity_providers:read` | ✓ | ✓ | ✓ | ✓ |  |
| `webhooks` | `/v1/core/webhooks` | `core:webhooks:read` | ✓ | ✓ | ✓ |  |  |
| `webhook-deliveries` | `/v1/core/webhook-deliveries` | `core:webhooks:read` |  |  |  |  |  |
| `notifications` | `/v1/core/notifications` | `core:notifications:read` |  |  |  |  |  |
| `audit-log` | `/v1/core/audit-log` | `core:audit:read` |  |  |  |  |  |
| `event-dlq` | `/v1/core/event-dlq` | `admin:dlq:read` |  |  |  |  |  |
| `message-templates` | `/v1/core/message-templates` | `core:templates:read` | ✓ | ✓ | ✓ | ✓ |  |
| `locale-overrides` | `/v1/core/locale-overrides` | `core:locale_overrides:read` | ✓ | ✓ | ✓ | ✓ |  |
| `agents` | `/v1/ai/agents` | `ai:agents:read` | ✓ | ✓ | ✓ |  |  |
| `prompts` | `/v1/ai/prompts` | `ai:prompts:read` | ✓ | ✓ | ✓ |  |  |
| `runs` | `/v1/ai/runs` | `ai:runs:read` |  |  |  |  | `/admin/ai/runs/{id}` |
| `tool-calls` | `/v1/ai/tool-calls` | `ai:runs:read` |  |  |  |  |  |
| `suggestions` | `/v1/ai/suggestions` | `ai:suggestions:read` |  | ✓ |  |  |  |
| `budgets` | `/v1/ai/budgets` | `ai:budgets:read` |  | ✓ |  |  |  |
| `evals` | `/v1/ai/evals` | `ai:evals:read` | ✓ |  |  |  |  |
| `knowledge-sources` | `/v1/ai/knowledge-sources` | `ai:prompts:read` | ✓ | ✓ | ✓ |  |  |
| `guardrail-events` | `/v1/ai/guardrail-events` | `ai:audit:read` |  |  |  |  |  |
| `ai-audit-log` | `/v1/ai/ai-audit-log` | `ai:audit:read` |  |  |  |  |  |

**AI operations** → `/admin/ai/analytics` ([ai-analytics.tsx](apps/web/app/routes/ai-analytics.tsx),
tools list, `analytics:reports:run`; its own screen rather than an AI-console
tab, ADR-0088). Eleven definitions over the five AI datasets (`aiRuns`,
`aiSpend`, `aiSuggestions`, `aiGuardrails`, `aiEvals`), each run through
`POST /v1/analytics/run` — no bespoke endpoint. Top half: six `Stat`s
(suggestions kept, refused calls, guardrail blocks, eval pass rate, AI cost,
average latency); then cost / runs / latency / eval score per day as
`LineChart`s; then cost by module, top purposes by cost, runs by module and eval
suites weakest-first as compact tables. Every figure and panel links to
`/analytics/builder?def=…&run=1` with the exact definition it was drawn from.
7/30/90-day window links. A panel whose dataset the reader may not read says
so (any 4xx but 401 blanks that panel only); a missing figure is `—`, never 0.

#### `/analytics` — 8 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `dashboards` | `/v1/analytics/dashboards` | `analytics:dashboards:read` | ✓ | ✓ | ✓ |  | `/analytics/dashboard/{id}` |
| `reports` | `/v1/analytics/reports` | `analytics:reports:read` |  | ✓ | ✓ |  | `/analytics/report/{id}` |
| `report-runs` | `/v1/analytics/report-runs` | `analytics:reports:read` |  |  |  |  |  |
| `exports` | `/v1/analytics/exports` | `analytics:exports:download` | ✓ |  |  |  |  |
| `schedules` | `/v1/analytics/schedules` | `analytics:schedules:read` |  | ✓ | ✓ |  |  |
| `saved-views` | `/v1/analytics/saved-views` | `analytics:saved_views:read` | ✓ |  | ✓ |  |  |
| `unit-economics` | `/v1/analytics/unit-economics` | `analytics:reports:read` |  |  |  |  |  |
| `journey-events` | `/v1/analytics/journey-events` | `analytics:reports:read` |  |  |  |  |  |

Tools list: **Build a report** → `/analytics/builder` (`analytics:reports:run`).

**Report builder** ([analytics-builder.tsx](apps/web/app/routes/analytics-builder.tsx),
ADR-0088). The first web reader of `GET /v1/analytics/datasets`: dataset →
measures → splits → time bucket → from/to → up to four filter rows → sort →
row limit, in a GET form beside the preview (data first, the form in a sticky
aside on xl). The whole build is the URL, `?def=<base64url JSON>`
([analytics-def.ts](apps/web/app/analytics-def.ts)), so any build is a link;
the preview runs through `POST /v1/analytics/run` **only when the link says
`run=1`** — a shared, suggested or dashboard-supplied definition is loaded for
the reader to read, never run for them. Preview = table with totals, plus a
`LineChart` when the run has a grain and nothing else to split by, or a
`DonutChart` for exactly one split and no grain. Save (`analytics:reports:write`)
posts `/v1/analytics/reports` and, with `analytics:schedules:write`, optionally a
daily/weekly/monthly schedule to named recipients. Dataset names are this
screen's own en/ar labels; measure and split names fall back to the registry's
English label where no catalogue or pack word exists (ponytail).

**Ask in words** (same screen, docs/15 §4.6 + §4.7, ADR-0088). One input posts
`/v1/analytics/ask`; the answer renders as a dashed ghost line — the compiled
definition read back as phrases (`describeDef`) under an `AgentBadge` whose
`why=` is the model's one-sentence reason — and a **Load into the builder** link
(no `run=1`). A 422 `ask_refused` is worded by the screen from its reason code
("outside what your data covers" / "did not compile"); the model's prose never
reaches the page. No modal, no auto-run, no toast.

#### `/axis` — 13 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `cases` | `/v1/axis/cases` | `axis:cases:read` | ✓ | ✓ | ✓ | ✓ |  |
| `quotes` | `/v1/axis/quotes` | `axis:quotes:read` |  |  |  |  |  |
| `documents` | `/v1/axis/documents` | `axis:documents:read` | ✓ | ✓ |  |  |  |
| `tasks` | `/v1/axis/tasks` | `axis:tasks:read` | ✓ | ✓ | ✓ |  |  |
| `policies` | `/v1/axis/policies` | `axis:policies:read` | ✓ | ✓ |  |  |  |
| `claims` | `/v1/axis/claims` | `axis:claims:read` | ✓ | ✓ |  |  |  |
| `complaints` | `/v1/axis/complaints` | `axis:complaints:read` | ✓ | ✓ |  |  |  |
| `siu-referrals` | `/v1/axis/siu-referrals` | `axis:siu:read` |  | ✓ |  |  |  |
| `escrow-batches` | `/v1/axis/escrow-batches` | `axis:escrow:read` |  | ✓ |  |  |  |
| `sops` | `/v1/axis/sops` | `axis:sops:read` | ✓ | ✓ | ✓ |  |  |
| `case-approvals` | `/v1/axis/case-approvals` | `axis:cases:approve` |  |  |  |  |  |
| `process-events` | `/v1/axis/process-events` | `axis:metrics:read` |  |  |  |  |  |
| `ops-policies` | `/v1/axis/ops-policies` | `axis:ops_policies:read` | ✓ | ✓ | ✓ |  |  |

#### `/compliance` — 10 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `dsar-requests` | `/v1/compliance/dsar-requests` | `compliance:dsar:read` | ✓ | ✓ |  |  |  |
| `erasure-log` | `/v1/compliance/erasure-log` | `compliance:dsar:read` |  |  |  |  |  |
| `disclosures` | `/v1/compliance/disclosures` | `compliance:disclosures:read` |  |  |  |  |  |
| `screenings` | `/v1/compliance/screenings` | `compliance:screenings:read` |  |  |  |  |  |
| `retention-runs` | `/v1/compliance/retention-runs` | `compliance:retention:read` |  |  |  |  |  |
| `legal-holds` | `/v1/compliance/legal-holds` | `compliance:legal_holds:read` | ✓ | ✓ | ✓ |  |  |
| `evidence-bundles` | `/v1/compliance/evidence-bundles` | `compliance:evidence:read` |  |  |  |  |  |
| `incidents` | `/v1/compliance/incidents` | `compliance:incidents:read` | ✓ | ✓ | ✓ |  |  |
| `rulepack-applications` | `/v1/compliance/rulepack-applications` | `compliance:rulepacks:read` |  |  |  |  |  |
| `policy-thresholds` | `/v1/compliance/policy-thresholds` | `compliance:thresholds:read` | ✓ | ✓ | ✓ |  |  |

#### `/distribution` — 7 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `channels` | `/v1/dist/channels` | `dist:channels:read` | ✓ | ✓ | ✓ | ✓ |  |
| `offerings` | `/v1/dist/offerings` | `dist:offerings:read` | ✓ | ✓ | ✓ | ✓ |  |
| `commission-rates` | `/v1/dist/commission-rates` | `dist:rates:read` | ✓ |  |  |  |  |
| `quote-requests` | `/v1/dist/quote-requests` | `dist:quote_requests:read` | ✓ | ✓ |  |  | `/distribution/quote-requests/{id}/compare` |
| `quote-responses` | `/v1/dist/quote-responses` | `dist:quote_requests:read` |  |  |  |  |  |
| `commission-entries` | `/v1/dist/commission-entries` | `dist:commissions:read` |  | ✓ |  |  |  |
| `next-best-offers` | `/v1/dist/next-best-offers` | `dist:offers:read` |  | ✓ |  |  |  |

#### `/ledger` — 20 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `txns` | `/v1/ledger/txns` | `ledger:txns:read` | ✓ |  |  |  | `/ledger/transactions/{id}` |
| `txn-transitions` | `/v1/ledger/txn-transitions` | `ledger:txns:read` |  |  |  |  |  |
| `saga-steps` | `/v1/ledger/saga-steps` | `ledger:txns:read` |  |  |  |  |  |
| `accounts` | `/v1/ledger/accounts` | `ledger:accounts:read` | ✓ | ✓ | ✓ |  |  |
| `journal-batches` | `/v1/ledger/journal-batches` | `ledger:journals:read` |  |  |  |  |  |
| `journal-lines` | `/v1/ledger/journal-lines` | `ledger:journals:read` |  |  |  |  |  |
| `account-balances` | `/v1/ledger/account-balances` | `ledger:accounts:read` |  |  |  |  |  |
| `periods` | `/v1/ledger/periods` | `ledger:periods:read` |  | ✓ |  |  |  |
| `recon-runs` | `/v1/ledger/recon-runs` | `ledger:recon:read` | ✓ |  |  |  |  |
| `recon-matches` | `/v1/ledger/recon-matches` | `ledger:recon:read` |  | ✓ |  |  |  |
| `client-money-checks` | `/v1/ledger/client-money-checks` | `ledger:client_money:read` |  |  |  |  |  |
| `subscriptions` | `/v1/ledger/subscriptions` | `admin:billing:read` | ✓ | ✓ | ✓ |  |  |
| `invoices` | `/v1/ledger/invoices` | `ledger:invoices:read` | ✓ | ✓ |  |  |  |
| `revenue-schedules` | `/v1/ledger/revenue-schedules` | `ledger:journals:read` |  |  |  |  |  |
| `usage-meters` | `/v1/ledger/usage-meters` | `admin:billing:read` |  |  |  |  |  |
| `payments` | `/v1/ledger/payments` | `ledger:payments:read` | ✓ |  |  |  |  |
| `payment-plans` | `/v1/ledger/payment-plans` | `ledger:payments:read` |  |  |  |  |  |
| `fx-rates` | `/v1/ledger/fx-rates` | `ledger:accounts:read` | ✓ |  |  |  |  |
| `tax-rules` | `/v1/ledger/tax-rules` | `ledger:accounts:read` | ✓ | ✓ | ✓ |  |  |
| `settlements` | `/v1/ledger/settlements` | `dist:commissions:read` | ✓ | ✓ |  |  | `/ledger/settlements/{id}` |

#### `/north` — 8 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `metrics` | `/v1/north/metrics` | `north:metrics:read` | ✓ | ✓ | ✓ |  |  |
| `snapshots` | `/v1/north/snapshots` | `north:snapshots:read` |  |  |  |  |  |
| `briefings` | `/v1/north/briefings` | `north:briefings:read` | ✓ | ✓ |  |  |  |
| `anomalies` | `/v1/north/anomalies` | `north:anomalies:read` |  | ✓ |  |  |  |
| `alerts` | `/v1/north/alert_rules` | `north:alerts:read` | ✓ | ✓ | ✓ |  |  |
| `scenarios` | `/v1/north/scenarios` | `north:scenarios:read` | ✓ | ✓ |  |  |  |
| `boardpacks` | `/v1/north/boardpacks` | `north:boardpacks:read` | ✓ |  |  |  |  |
| `decisions` | `/v1/north/decisions` | `north:decisions:read` | ✓ | ✓ | ✓ |  |  |

#### `/orbit` — 18 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `conversations` | `/v1/orbit/conversations` | `orbit:conversations:read` | ✓ | ✓ |  |  | `/orbit/conversations/{id}/thread` |
| `messages` | `/v1/orbit/messages` | `orbit:messages:read` | ✓ |  |  |  |  |
| `renewals` | `/v1/orbit/renewals` | `orbit:renewals:read` |  | ✓ |  |  |  |
| `journeys` | `/v1/orbit/journeys` | `orbit:journeys:read` | ✓ | ✓ | ✓ |  | `/orbit/journeys/{id}/builder` |
| `journey-runs` | `/v1/orbit/journey-runs` | `orbit:journeys:read` |  |  |  |  |  |
| `partners` | `/v1/orbit/partners` | `orbit:partners:read` | ✓ |  |  | ✓ |  |
| `partner-txns` | `/v1/orbit/partner-txns` | `orbit:partners:read` |  |  |  |  |  |
| `handover-notes` | `/v1/orbit/handover-notes` | `orbit:handover:read` | ✓ | ✓ | ✓ |  |  |
| `qa-scores` | `/v1/orbit/qa-scores` | `orbit:qa:read` | ✓ |  |  |  |  |
| `channel-connectors` | `/v1/orbit/channel-connectors` | `orbit:channels:read` | ✓ | ✓ | ✓ |  |  |
| `teams` | `/v1/orbit/teams` | `orbit:teams:read` | ✓ | ✓ | ✓ |  |  |
| `team-members` | `/v1/orbit/team-members` | `orbit:teams:read` | ✓ | ✓ | ✓ |  |  |
| `routing-rules` | `/v1/orbit/routing-rules` | `orbit:teams:read` | ✓ | ✓ | ✓ |  |  |
| `sla-policies` | `/v1/orbit/sla-policies` | `orbit:teams:read` | ✓ | ✓ | ✓ |  |  |
| `agent-presence` | `/v1/orbit/agent-presence` | `orbit:presence:read` | ✓ | ✓ |  |  |  |
| `kb-articles` | `/v1/orbit/kb-articles` | `orbit:kb:read` | ✓ | ✓ | ✓ |  |  |
| `macros` | `/v1/orbit/macros` | `orbit:macros:read` | ✓ | ✓ | ✓ |  |  |
| `deflections` | `/v1/orbit/deflections` | `orbit:conversations:read` |  |  |  |  |  |

#### `/scout` — 6 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `signals` | `/v1/scout/signals` | `scout:signals:read` | ✓ |  |  |  |  |
| `clusters` | `/v1/scout/clusters` | `scout:clusters:read` |  |  |  |  |  |
| `whitespaces` | `/v1/scout/whitespaces` | `scout:whitespaces:read` |  | ✓ |  |  |  |
| `panel-bench` | `/v1/scout/panel-bench` | `scout:panel_bench:read` |  |  |  |  |  |
| `scout-experiments` | `/v1/scout/scout-experiments` | `scout:experiments:read` | ✓ | ✓ |  |  |  |
| `data-products` | `/v1/scout/data-products` | `scout:data_products:read` | ✓ | ✓ |  |  |  |

#### `/signal` — 8 tabs

| Tab | API | Read | C | U | D | Search | Record link |
| --- | --- | --- | :-: | :-: | :-: | :-: | --- |
| `audiences` | `/v1/signal/audiences` | `signal:audiences:read` | ✓ | ✓ |  |  |  |
| `campaigns` | `/v1/signal/campaigns` | `signal:campaigns:read` | ✓ | ✓ |  | ✓ |  |
| `creatives` | `/v1/signal/creatives` | `signal:creatives:read` | ✓ | ✓ |  |  |  |
| `signal-experiments` | `/v1/signal/signal-experiments` | `signal:experiments:read` | ✓ | ✓ |  |  |  |
| `budget-moves` | `/v1/signal/budget-moves` | `signal:budget_moves:read` |  | ✓ |  |  |  |
| `aeo-pages` | `/v1/signal/aeo-pages` | `signal:aeo:read` | ✓ | ✓ | ✓ |  |  |
| `attribution-events` | `/v1/signal/attribution-events` | `signal:attribution:read` |  |  |  |  |  |
| `spend` | `/v1/signal/spend` | `signal:spend:read` |  |  |  |  |  |


---

## 8. App-level shared components (`apps/web/app/components/`)

`packages/ui` is the design system: generic, tenant-agnostic, reusable outside
LYRA. This directory is the layer above it — components that know about
shifts, whitespaces, campaigns and the shell itself. Twenty-five files, none
of them tested by an inventory agent, so they are documented here rather than
left to whichever module chapter happened to mention them.

| File | What it is |
| --- | --- |
| [shell.tsx](apps/web/app/components/shell.tsx) | The frame every workspace renders inside — chrome bands, tenant brand override contract, role-pill profile switcher, nav tree with module hue markers, breadcrumb trail. See §2. |
| [hero.tsx](apps/web/app/components/hero.tsx) | The clickable hero figure: `lensOf` counts and lists through one predicate over one array, so the figure and its drill-down list can never disagree. A figure with nothing to list (a rate, a median, a scalar) gets no `to` and renders as plain text. |
| [meridian.tsx](apps/web/app/components/meridian.tsx) | The NORTH today-strip (ADR-0061): one line for today, ticked by the hour, a dot per landed event, a draggable playhead. Left of now is replay; right of now is unarrived, and the strip never fabricates a figure for a time that has not happened. |
| [shift.ts](apps/web/app/components/shift.ts) | Pure functions shared by the shift rail and the Meridian strip — both are views over `/v1/me/inbox`, so `shift.test.ts` verifies the logic without a browser. |
| [shift-rail.tsx](apps/web/app/components/shift-rail.tsx) (referenced as the rail header in `shift.ts`) | What today asks of this actor, in arrival order, over a ring showing how much of the day is behind them. Renders nothing when the inbox fails to read — a rail reading "0 of 0" on a failed fetch would be a lie. |
| [shift-clear.tsx](apps/web/app/components/shift-clear.tsx) | The empty state for a queue whose purpose is to be emptied. Distinct from `EmptyState`: reaching zero here is success, not absence, and the copy says so. Purely presentational — every figure is passed in. |
| [companion.tsx](apps/web/app/components/companion.tsx) | The right rail (Horizon spec §4 item 7): what agents have been doing, footed by the autonomy envelope. Read-only by construction — autonomy changes and pausing an agent happen at `/admin/ai/console`. Opens closed, loads on first open, and is absent (not disabled) without `ai:runs:read` (ADR-0059). |
| [search.tsx](apps/web/app/components/search.tsx) | The command palette and the one client-side fetch in the shell. Goes to `/search` in the web app, not the API — the session cookie is deliberately unreadable by script, so only the web app's own loader can answer. Folds the design's "Where" overlay into the palette (ADR-0031) rather than a second overlay. |
| [posture.tsx](apps/web/app/components/posture.tsx) | The two top-bar chips beside the theme toggle: client money held, and whether this month's ledger is still open. Absent, not empty, without `ledger:client_money:read` — same withheld-not-disabled rule the nav follows. |
| [confirm.tsx](apps/web/app/components/confirm.tsx) | A submit button that asks first, replacing `window.confirm()` (which does not translate, does not mirror under RTL, cannot carry tenant brand, and is suppressed in some embedded webviews — silently dropping the CLAUDE.md §4 consequential-action guard). The ask lives on the button so a form with several submitters still knows which one confirmed. |
| [ref-picker.tsx](apps/web/app/components/ref-picker.tsx) | Types over a record's name, submits its id — for screens that hang work off a record (a screening's customer, a quote's customer, a settlement's channel) so a person is not stuck copying a `cu_01K…` id out of another tab. Degrades to a plain paste box for an actor whose role cannot read the list. |
| [error-panel.tsx](apps/web/app/components/error-panel.tsx) | What happened → what we did → what you can do, plus a copyable support reference tied to the id the API logged the failure under. No stack traces. Renders in two homes: bare on the root boundary (nothing loaded, no shell to sit in), inside the shell on the workspace boundary (docs/15: a screen that fails is still a screen — losing the rail on a mistyped URL should not read as a crash). Suppresses the retry offer for 403/404, where reloading changes nothing. |
| [cold-open.tsx](apps/web/app/components/cold-open.tsx) | The session's cold-open animation (ADR-0055): field holds, constellation draws, wordmark settles, veil lifts off a workspace already rendered underneath. `pointer-events: none`, `aria-hidden`, and unmounts itself when its animation ends — a purely visual fact that has no business persisting across requests, so the trigger is structural (mounts in an effect) rather than server state. |
| [mark.tsx](apps/web/app/components/mark.tsx) | `ConstellationMark` — the Lyra harp logotype, four charted stars with Vega set apart in the tenant accent. Decorative (`aria-hidden`); the wordmark beside it carries the name. |
| [theme-toggle.tsx](apps/web/app/components/theme-toggle.tsx) | Flips `data-theme` on the document and the `lyra_theme` cookie together, so the first paint already carries the right palette. The only reader of theme state is CSS — no context, no provider, no store (ponytail). |
| [turnstile.tsx](apps/web/app/components/turnstile.tsx) | The Cloudflare Turnstile challenge on the two forms a stranger can post without a session — portal lead capture and public DSAR intake (docs/10 §6). Writes a hidden `cf-turnstile-response` input the route's action forwards as `turnstileToken`. Renders nothing where no site key is bound (dev, on-prem, CI, or an un-applied `infra/cloudflare/turnstile.tf`), matching the API side, which requires no challenge where it holds no secret. |
| [fields.tsx](apps/web/app/components/fields.tsx) | The generated-CRUD renderers for `ColumnSpec`/`FieldSpec` — money, rate, ratio, measure, ref, badge-toned enum — shared by `module.tsx` and `record.tsx` so a field type means the same thing everywhere it appears. |
| [whitespace-commentary.tsx](apps/web/app/components/whitespace-commentary.tsx) + [whitespace-api.server.ts](apps/web/app/components/whitespace-api.server.ts) | SCOUT's hover commentary and the promote-to-signal handover. `whitespace-api.server.ts` is the two calls the feature needs in one file: `GET /v1/scout/whitespaces/commentary?limit=N` (a read of already-stored commentary, not a model call, so the radar can prefetch every dot in one round) and the promote call. See `docs/ui/scout.md` for the fuller history of this contract, including the shipped mismatch between the assumed and actual response shape. |
| [signal-handover.tsx](apps/web/app/components/signal-handover.tsx) | The button that hands a SCOUT whitespace to the SIGNAL campaign studio. Marked consequential (CLAUDE.md §4): the label says exactly what pressing it does, the API may answer "queued for approval" rather than "done", and any drafts land in a tray to be read rather than sent (docs/15 §4 pattern 3). `may: false` renders the reason in place of the button rather than a disabled control, because a disabled control cannot have its explanation announced to a screen reader. |
| [axis-shell.tsx](apps/web/app/components/axis-shell.tsx) | AXIS module shell — see `docs/ui/axis.md`. |
| [orbit-shell.tsx](apps/web/app/components/orbit-shell.tsx) | ORBIT module shell — see `docs/ui/orbit.md`. |
| [signal-shell.tsx](apps/web/app/components/signal-shell.tsx) | SIGNAL module shell — see `docs/ui/signal.md`. |
| [scout-shell.tsx](apps/web/app/components/scout-shell.tsx) | SCOUT module shell — see `docs/ui/scout.md`. |
| [north-shell.tsx](apps/web/app/components/north-shell.tsx) | NORTH module shell — see `docs/ui/north.md`. |

Each module shell is documented in full — its own routes, loader data, and
bespoke screens — in its `docs/ui/*.md` chapter; this table only locates the
shell component itself.

---

## 9. Where this document does not yet reach

The eight module chapters this document depends on for bespoke-screen detail —
`docs/ui/axis.md`, `orbit.md`, `signal.md`, `scout.md`, `north.md`,
`ledger.md`, `compliance.md`, `admin.md` — live in `docs/ui/*.md`, refreshed
2026-08-20 (see §Status). Read the relevant chapter there for per-screen
loader data, interaction lists and AI-surface detail beyond what §§1-8
establish as the shared vocabulary. Where a fact could not be confirmed from
code in either document, it is marked **not determined from code** rather
than guessed.

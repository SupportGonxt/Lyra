# LEDGER — UI design brief

What is built today, screen by screen. Nothing here is aspirational: every label,
column, permission string and piece of copy below is taken from the code that
ships. Where a screen is weak, that is said plainly under **What is weak today**.

## Orientation

LEDGER is the money module. It owns transactions (a state machine with an
idempotency key), the double-entry journal behind them, the chart of accounts,
accounting periods, reconciliation runs, client money, settlements between us,
providers and channels, and six finance reports. Two people live here day to
day. A **controller** (`finance.controller`, holds `ledger:*:*`) arrives at
month-end: run the trial balance, chase the pending transactions, check client
money, soft-close, hard-close. An **analyst** (`finance.analyst`, every
`ledger:*:read` plus `ledger:recon:run`) is here daily: read reports, export
them, run a reconciliation — but cannot open a transaction, post, close a
period or confirm a match. A third role exists purely as the other half of
dual control: a **director** (`finance.director`) holds every `ledger:*:read`
plus the approve/post/reverse verbs (`ledger:journals:post`,
`ledger:periods:close`, `:force_close`, `:reopen`, `:year_end`,
`ledger:payouts:approve`, `ledger:txns:reverse`, …) and deliberately none of
the origination verbs — no `ledger:txns:create`, no `ledger:journals:draft`.
The role graph's own comment (`rbac.ts`) is explicit that this is separation
of duties as a property of the graph, not a switch: a tenant with one finance
seat cannot post a manual journal, force a close or reopen a period. The
director shows up on this doc wherever an approval is decided — approvals
inbox, year-end close (§9), manual journal (§10) — never as an originator. The
three screens that matter most are **`/ledger/reports/:report`**
(where the numbers are read), **`/ledger/transactions/:id`** (the only place a
posting can be inspected line by line) and **`/ledger/period-close`** (the gate).
Everything else is a list.

The whole module is **web only**. The Expo app shows a generic read-only list of
`ledger/txns` at `/m/ledger` with no money formatting and no record screen. Treat
mobile as out of scope unless a section says otherwise.

---

## Foundations that apply to every LEDGER screen

Read this once; the per-screen sections assume it.

### Money rendering — the rules the code enforces

Money is stored and transported as **integer minor units** (`grossMinor`,
`amountMinor`, `debitMinor`). There are no decimals anywhere in the API.

- `<Money>` (`packages/ui`) always renders `tabular-nums`. Digits must not jitter
  between rows.
- A `<Table>` column marked `numeric` gets `text-end tabular-nums text-text`.
  **Every money column is `numeric`.** In the reports screen `moneyColumn()`
  hard-sets `numeric: true` so this cannot be forgotten.
- `signed` is used **only** on differences, running balances and margins — trial
  balance `Difference`, statement `Opening`/`Closing`/`Running`, recon `Delta` and
  `Variance amount`, P&L `Gross margin`. A debit column and a credit column are
  never signed: they are magnitudes, and the side is a separate column.
- `toned` (red/green) is used **only** on recon deltas and variances. Ledger
  debit/credit columns are never toned. A red number in LEDGER means "these two
  figures disagree", never "this is an expense".
- **Currency lives in the column header, not in the cell.** In exports,
  `labelCurrency()` puts the code in the column label or gives it its own column.
  On screen, the currency is a separate `Currency` column in every multi-currency
  table (aged, commission, client money, balances). A money value that arrives
  with no currency degrades to a plain tabular number rather than guessing.
- Negative numbers use the locale's own convention via `Intl.NumberFormat` —
  a leading minus in `en`. There are no parentheses and no red-for-negative
  outside the two `toned` cases above.
- Percentages are `Intl.NumberFormat(percent)` over a ppm value divided by
  1,000,000 (`marginPpm / 1_000_000`). Rates are stored as ppm integers
  (`ratePpm`, `baseCommissionPpm`, `channelSharePpm`) and displayed as raw ppm
  in the generic tables — that is a known ugliness, see the weak list.

### Tables

`<Table>` requires a `caption` (screen-reader text, visually hidden). Journal
lines, audit rows and statement lines pass `rowState={() => "sealed"}` — a
visual treatment that says *this row is a record, not an editable thing*. Sealed
rows must never look clickable in a redesign.

### Permission behaviour

Two different patterns exist and both must be preserved:

1. **Absence** — a tab, action or link the actor cannot use is not rendered at
   all (`visibleTabs` / `visibleActions` / `visibleLinks`). There are no
   disabled buttons in this module.
2. **A denied notice** — a bespoke route the actor reached anyway renders an
   `EmptyState`:
   - title: "You do not have permission to see this."
   - body: "This screen needs {permission}. Ask an administrator if you should
     have it." — with the literal permission string interpolated.
   The reports screen has its own wording: "You cannot open this report" / "It
   needs a permission your role does not hold. An administrator can grant it."

The permission is pre-checked in the loader before the API call, deliberately:
asking first means a 403 never reaches the audit log as a failed read the actor
did not intend.

### Who holds what (the full LEDGER truth table)

| Role key | LEDGER permissions |
|---|---|
| `finance.controller` | `ledger:*:*` — everything, plus `core:approvals:read`/`decide`, `dist:commissions:*`, `analytics:exports:unmasked` |
| `finance.analyst` | every `ledger:*:read` (txns, journals, accounts, periods, recon, invoices, payments, client_money) + `ledger:ai:invoke`, `ledger:recon:run`, `ledger:recon:export`, `ledger:invoices:create`, `ledger:journals:draft`. Drafts a manual journal but cannot post it — `ledger:journals:draft`, not `ledger:journals:post`, is the whole point of the split. **No** create, authorize, reverse, post, close, confirm, transfer |
| `finance.director` | every `ledger:*:read` + `core:approvals:read`/`decide`, `ledger:journals:post`, `ledger:periods:close`, `ledger:periods:force_close`, `ledger:periods:reopen`, `ledger:periods:year_end`, `ledger:payouts:approve`, `ledger:invoices:approve`, `ledger:client_money:transfer`, `ledger:txns:reverse`. A second seat that is only a second seat: it approves and posts what the analyst drafted, and cannot originate any of it — no `ledger:txns:create`, no `ledger:journals:draft`, no bank import, and (notably) no `ledger:txns:authorize`, `ledger:recon:confirm` or `ledger:accounts:write` either. A tenant with a single finance seat cannot post a manual journal, force a close or reopen a period: separation of duties as a property of the role graph, not a runtime check |
| `tenant.admin` | `ledger:*:read` only |
| `tenant.compliance` | `ledger:client_money:read`, `ledger:journals:read` only |
| `north.admin` | `ledger:journals:read`, `ledger:txns:read` |
| `north.analyst` | `ledger:journals:read` |
| `north.exec` | `ledger:txns:read` |
| `axis.admin` | `ledger:txns:read`, `ledger:recon:read`, `ledger:recon:run` |
| `axis.agent`, `axis.lead`, `orbit.partners`, `signal.lead`, `signal.admin`, `partner.manager` | `ledger:txns:read` |
| `orbit.agent`, `orbit.retention`, `scout.lead`, `north.board`, `dev.admin`, `customer`, `provider.viewer` | none |
| `platform.admin` | `*:*:*` |

The permission constants, verbatim: `ledger:txns:read`, `ledger:txns:create`,
`ledger:txns:authorize`, `ledger:txns:reverse`, `ledger:journals:read`,
`ledger:journals:draft`, `ledger:journals:post`, `ledger:journals:void`,
`ledger:accounts:read`, `ledger:accounts:write`,
`ledger:periods:read`, `ledger:periods:close`, `ledger:periods:force_close`,
`ledger:periods:reopen`, `ledger:periods:year_end`, `ledger:recon:read`,
`ledger:recon:run`, `ledger:recon:confirm`, `ledger:recon:export`,
`ledger:invoices:read`,
`ledger:invoices:create`, `ledger:invoices:approve`, `ledger:payments:read`,
`ledger:payments:create`, `ledger:payments:refund`, `ledger:payouts:approve`,
`ledger:client_money:read`, `ledger:client_money:transfer`, `ledger:ai:invoke`.
Plus `core:approvals:read` and `core:audit:read`, which reveal two panels on the
transaction screen.

The screen-facing `PERM` object (`apps/web/app/routes/ledger.shared.ts`) does
not carry a 1:1 constant for every server permission above: it has
`txnsRead`, `txnsCreate`, `txnsAuthorize`, `txnsReverse`, `periodsRead`,
`periodsClose`, `periodsYearEnd`, `journalsDraft`, `journalsRead`,
`journalsPost`, `reconRead`, `reconRun`, `reconConfirm`, `approvalsRead`,
`auditRead` — no `journalsVoid`, `periodsForceClose` or `periodsReopen`. See
§4's weak note on the Reopen button for the consequence.

### RTL — the rule for a financial table in Arabic

The shell sets `dir="rtl"` for `ar` and the codebase uses logical properties
only (`ms-auto`, `me-2`, `ps-5`, `border-e`, `text-start`, `border-s-[3px]`).
For a money table specifically:

- **Column order mirrors.** In Arabic the first column (Account) sits at the
  right edge; Debit and Credit run leftward. This is automatic and correct.
- **Numbers never mirror.** `1 234 567` stays left-to-right inside its cell,
  whatever the paragraph direction. `Intl.NumberFormat` with the `ar` locale
  produces Arabic-Indic digits where the locale asks for them; the *digit order*
  is unchanged.
- **Numeric alignment follows the writing direction, not a physical edge.**
  `text-end` in LTR is right; in RTL it is left. So an Arabic trial balance has
  its debit and credit figures flush **left** within their columns, and the
  decimal positions still line up. Do not "fix" this to right-aligned.
- **Currency codes stay Latin** (`ZAR`, `AED`) in both directions; they are
  identifiers.
- The balance sheet uses `grid lg:grid-cols-2` rather than any physical
  positioning, because CSS grid flow is writing-mode aware: Assets sits on the
  right in Arabic without a single direction check in the code.

### The AI boundary — state this in every design

**AI is never in the money path.** There is exactly one AI surface in LEDGER:
pass 3 of a reconciliation run, opt-in per run via a checkbox that defaults
**off**. It produces `recon_matches` rows with `method: "ai_proposed"` and
`state: "proposed"` — a suggestion about which statement line probably pairs with
which transaction. It posts nothing. It never writes a journal line, never
authorises a transaction, never closes a period, never decides an approval. A
proposal only becomes a decision when a person submits Confirm or Reject **with a
reason code**, and their name goes on the row.

Where the boundary is visible to the user today:

- The recon screen's intro: "Match a counterparty statement against what we
  settled. Nothing posts here — a match is a judgement, and it is recorded as
  one."
- The propose checkbox's hint: "Proposals are never posted. Each one still needs
  a person to confirm it."
- The `How` column shows an **info-toned** badge reading "Assistant" for
  `ai_proposed`, versus a neutral badge for "Exact" / "Within tolerance" — so a
  machine-suggested pairing is visually distinct in the row it appears in.
- `Decided by` shows the human's name and their reason code beneath it.

The ✦ marker (docs/15) does **not** currently appear anywhere in LEDGER. The
"Assistant" badge is doing that job. A redesign should put the ✦ on that badge
and on nothing else in this module. Do not invent a "✦ suggest a journal entry"
affordance; there is none, and there must not be.

---

## 1. `/ledger/reports/:report` — Finance reports

**Route + title.** `apps/web/app/routes/ledger-reports.tsx`, registered as
`route("ledger/reports/:report", …)`. Page title (h1): "Finance reports".
Six values of `:report`: `trial-balance`, `pnl`, `balance-sheet`, `aged`,
`commission`, `client-money`. Labels come from the ledger workspace catalogue
under `report.*`.

**Who sees it.** Per-report permission:

| Report | Permission | Who holds it |
|---|---|---|
| trial-balance, pnl, balance-sheet, aged, commission | `ledger:journals:read` | finance.controller, finance.analyst, tenant.admin, tenant.compliance, north.admin, north.analyst |
| client-money | `ledger:client_money:read` | finance.controller, finance.analyst, tenant.admin, tenant.compliance |

A denied user still gets the h1 and the six-tab strip (the tabs themselves are
filtered by permission), and in the body an `EmptyState`: "You cannot open this
report" / "It needs a permission your role does not hold. An administrator can
grant it." No numbers leak.

**Purpose.** Read the six statutory-shaped views of the journal, filter them by
period/date/currency, and export any of them.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Finance reports                                       (h1 24)│
│ ┌ nav aria-label="Sections" ───────────────────────────────┐ │
│ │ [Trial balance] Profit and loss  Balance sheet  Aged …  │ │  ~48px
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ GET form, inline ────────────────────────────────────────┐ │
│ │ Period [2026-07 ▾]  As at [ 📅 ]  Currency [ZAR]        │ │  ~72px
│ │                                  [Apply]  Clear         │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ KPIWall ─────────────────────────────────────────────────┐ │
│ │  Total debits      Total credits      Difference        │ │  ~110px
│ │  12 480 300        12 480 300         0                 │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ [ Discrepancy card — only when the report does not balance ] │
├──────────────────────────────────────────────────────────────┤
│ ┌ Table ───────────────────────────────────────────────────┐ │
│ │ Account │ Name │ Type │ Normal side │ Debit │ Credit │ Bal│ │  fills
│ │ 1000    │ Bank │ asset│ debit       │ 384120│      0 │ …  │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ Export:  xlsx · pdf · csv · json          (plain <a download>)│
└──────────────────────────────────────────────────────────────┘
```

**The tab strip.** `<nav aria-label={t("common.tabs")}>` — "Sections". Six links,
current one marked. Links to reports the actor cannot read are absent.

**Parameters per report** (a GET `<Form>`; changing a parameter is a navigation,
so every view is a shareable URL):

| Report | Parameters |
|---|---|
| trial-balance | `period` (month), `asOf` (date), `currency` (text, 3) |
| pnl | `period` (month) |
| balance-sheet | `asOf` (date) |
| aged | `accounts` (text), `asOf` (date) |
| commission | `by` (text — the dimension), `period` (month) |
| client-money | `currency` (text, 3) |

Input types: months use native `<input type="month">`; dates use the `DatePicker`
primitive; currency is `<Input maxLength={3}>`. Buttons: **Apply** (`common.apply`)
and a **Clear** link (`common.clear`) that navigates to the bare report path.
A date-only `asOf` is widened by `epochOf()` to `T23:59:59.999Z` — "as at the
30th" means the end of the 30th, not its first millisecond. Say so in a hint if
you redesign this; today it is silent.

**The six views.**

*Trial balance.* KPIWall: Total debits, Total credits, Difference (`signed`).
When not balanced, a `Discrepancy` alert renders above the table. Columns:
Account (mono, links to the account record when the code resolves), Name, Type,
Normal side, Debit (numeric money), Credit (numeric money), Balance (numeric
money).

*Profit and loss.* KPIs: Revenue, Cost of revenue and operating, Gross margin
(`signed`), Margin (percent from `marginPpm`). Two section tables, each with a
footer total row.

*Balance sheet.* KPIs: Assets, Liabilities, Equity. `Discrepancy` when
A ≠ L + E. Body is `grid lg:grid-cols-2`. Equity is split: a posted-only
`equity` section (rows + `Section.totalMinor`), a `currentYearUnpostedMinor`
figure (the current fiscal year's income/expense movement, not yet swept into
Retained Earnings by a year-end close), and `equityMinor` — the true,
combined equity figure the balance check uses. The view renders an extra Stat
for the unposted piece only when it is non-zero, and the posted-equity rows
only when there are any (a tenant that has never run a year-end close has
nothing there yet). This is docs/27 F2/F3's split, from `7a56b31`.

*Aged.* Columns: Counterparty, Currency, 0–30, 31–60, 61–90, 91–120, Over 120,
Total. All six money columns numeric. No links.

*Commission.* Columns: Value, Currency, Gross, Channel share, Net. Above the
table, a line reading "Dimension: {dimension}" naming what `by` grouped on.

*Client money.* Columns: Currency, Client bank, Owed to clients, Surplus or
shortfall, Status (Badge, dot — danger "Short" / success "Whole"). One
`Discrepancy` card per breached currency, titled "Client money is short —
{currency}", body: "The client bank position is below what is owed to clients.
This is a reportable breach: escalate it today, before the next remittance run."

*Budget vs actual* (`budget-vs-actual`, ADR-0104). Parameter: `period` (month;
this month when blank). Needs `ledger:budgets:read` **and**
`ledger:journals:read` (`ReportSpec.also`); the denied state names whichever is
missing. One row per account and currency — actuals are the month's posted
lines in that currency, never converted, and no row is ever summed with
another. Columns: Account (linked), Name, Currency, Budget, Actual, Variance
(`signed`), Variance %, Against plan (Badge — success "Favourable" / danger
"Adverse", income and expense only). A row with no budget prints "No budget" in
Budget and Variance and "—" in Variance %, never a zero. Headline: "no budget is
set for {period}", "{n} line(s) off plan" or "every budgeted line is on plan".
Budgets themselves are the `/ledger/budgets` tab (`ledger:budgets:write` to
create, edit amount/note, or delete; audited, no approval).

**Account links.** Only `trial-balance`, `pnl` and `balance-sheet` carry account
links. They resolve through an index built from
`/v1/ledger/accounts?limit=200&sort=code&order=asc`. On 403 the index is `{}` and
the codes render as plain text — "the numbers without the links, not an error".
Accounts past the 200th lose their link (a marked shortcut in the code).

**Export.** Four plain `<a download>` links to
`${API_ORIGIN}/v1/ledger/reports/:key/export?…&format=xlsx|pdf|csv|json`. They
carry the current parameters. No progress state, no job queue — the browser
downloads. Money cells in the export are `kind: "money"`; the currency goes into
the column label or its own column, never inside the number. **PDF is offered for
every report and the API returns 400 on text no embedded font covers** — Latin-1
and Arabic render (ADR-0115), so an Arabic tenant's report now downloads; a CJK
or Hebrew value still gets a failed download with no explanation. Design a fix.

**States.**
- *Loading*: React Router navigation state; the Apply button shows `loading`.
- *Empty*: an empty result renders the table with zero rows and the KPIs at zero.
  There is no dedicated empty message on this screen.
- *Error*: the route error boundary — "This did not load" / "The page could not
  be built. Nothing was saved, and you can try again." with a `Reference {id}`.
- *Denied*: as above.

**AI surfaces.** None. Nothing on this screen is model-generated.

**Actions and consequences.** Read-only. Nothing here posts, nothing needs an
idempotency key, nothing passes an approval gate. The file's own header states
the rule: nothing on the screen computes money — the API sums the journal and the
screen renders what it sends, because a screen that re-derives a total is a
second source of truth and the first thing to disagree with the ledger. **A
redesign must not add client-side arithmetic, not even a subtotal.**

**Mobile.** Web only.

**RTL.** As in Foundations. The balance sheet's two-column grid reorders itself.

**What is weak today.**
1. **No drill-through.** A trial-balance row links to the *account record* (its
   code, type, normal side) — not to the journal lines that produced the figure.
   You cannot click 12 480 300 and see what makes it up. This is the single
   biggest gap in the module. The data exists (`/ledger/journal-lines` filters by
   account) and the account statement screen exists at `/ledger/statement`, but
   nothing connects the report row to either.
2. PDF export is offered where it cannot succeed.
3. The Discrepancy card tells you the totals disagree and gives you nowhere to go.
4. Six parameters across six reports, each with a different set — the form
   changes shape per tab with no indication of why.
5. **The balance-sheet headline uses the wrong equity figure.** The page's h1
   is built by `reportsHeadline()`; its `"balance-sheet"` case computes the
   "out by {amount}" discrepancy as `assets.totalMinor - (liabilities.totalMinor
   + equity.totalMinor)` — the **posted-only** `equity.totalMinor`, not
   `equityMinor`. `BalanceSheetView` itself balances correctly against
   `bs.equityMinor`. Whenever `currentYearUnpostedMinor` is non-zero (any
   tenant mid-fiscal-year, before its next year-end close) and the sheet is
   genuinely out of balance, the headline's figure disagrees with the report
   body's own figure by exactly `currentYearUnpostedMinor`. Confirmed in code
   (`apps/web/app/routes/ledger-reports.tsx`), not yet fixed.

---

## 2. `/ledger/transactions` — Open a transaction

**Route + title.** `apps/web/app/routes/ledger-open-txn.tsx`. Title:
"Open a transaction" (`open.title`). Intro (`open.intro`): "Money moves by running
a transaction type. Pick the type, give it its arguments, and the ledger posts the
recipe."

**Who sees it.** `ledger:txns:create` — **`finance.controller` only**, plus
`platform.admin`. `finance.analyst` does not hold it and gets the denied
EmptyState naming `ledger:txns:create`. The link to this screen is also withheld
from the workspace link strip for everyone else, so a denied user normally never
arrives.

**Purpose.** Run one transaction type by hand, with an idempotency key, and see
the catalogue of every type this tenant can run.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ {openHeadline}                                          (h1) │
│ Money moves by running a transaction type. …          (intro)│
├──────────────────────────────────────────────────────────────┤
│ ┌ POST form ───────────────────────────────────────────────┐ │
│ │ Transaction type [BIND            ▾ 16rem]              │ │
│ │ Currency [ZAR 7rem]   Gross amount, in minor units [11r] │ │
│ │ Transaction key [────────────────────────────── req'd]  │ │
│ │ ARGUMENTS                                                │ │
│ │ [Gross ▾][Channel ▾][Tax ▾] …  — one Field per arg,     │ │
│ │  money args as MoneyField, *Account args as Input+hint  │ │
│ │ Reason [──────────────────────────────────────────]     │ │
│ │ [Open transaction]   This form carries a one-time key…  │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ Type catalogue ──────────────────────────────────────────┐ │
│ │ Code       │ Details                       │ Approvals   │ │
│ │ BIND       │ [Posts a journal]             │ —           │ │
│ │ PREM-REMIT │ [Posts a journal][Needs appr…]│ ledger.remit│ │
│ │            │ [Money out][Client money]     │             │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

The h1 is `openHeadline(types, l)` (`apps/web/app/routes/ledger.shared.ts`), not a
static string: "{count} transaction type(s) ready to run." — or, if any of them
carry an approval policy, "{count} transaction type(s) ready to run; {gated}
need approval first." — or "No transaction types are published yet." when the
catalogue is empty.

**The form, field by field.**

| Field | Label (key) | Type | Required | Default | Notes |
|---|---|---|---|---|---|
| `type` | Transaction type (`open.type`) | Select, `w-64` | yes | first option | Options are **bare codes** — `BIND`, `PREM-REMIT`, `CM-TRANSFER`. No human names. |
| `currency` | Currency | Input, `w-28`, `maxLength=3` | yes | `me.policy.currency` | Free text; no validation against a currency list on the client |
| `grossMinor` | Gross amount, in minor units (`open.gross`) | Input `type=number step=1 inputMode=numeric`, `w-44` | yes | empty | Minor units. 416 000 means R4 160,00 |
| `naturalKey` | Transaction key (`open.key`) | Input, `maxLength=200` | **yes** | a server-minted `web:<uuid>` | Hint: "The natural key for this transaction. Reusing it returns the same transaction." |
| `arg.<name>` | one per recipe argument (`arg.*`, e.g. "Gross commission", "Income account") | `MoneyField` for an integer field whose name ends `Minor`; plain `Input` (numeric for other integers) otherwise | per-field, from the recipe | field's own default shown as `placeholder` | Rendered from the selected type's `args: ArgField[]` (see below); an `Account`-suffixed text field also gets the hint "Account code" |
| `argFields` | — | hidden | — | `JSON.stringify(argFields)` | Posted back so the action reads exactly the field list it rendered, not whatever the current selection would be |
| `reason` | Reason | Input, `maxLength=500` | no | empty | |
| `headerKey` | — | hidden | — | `web.open:<uuid>` | Sent as the `idempotency-key` HTTP header |

Submit: **Open transaction** (`open.submit`), preceded by
`confirm("Open this transaction? It posts to the ledger.")`. Beneath the button,
always: "This form carries a one-time key, so pressing twice posts once."

**Both keys are minted server-side, once per form render.** This is load-bearing:
a key the browser generates at submit time is a new key on every press, which is
exactly the double-post the header exists to stop. A redesign must not move key
generation into the client.

**Per-field arguments, and the gap that remains.** The recipe's own schema
stays private to `packages/ledger`, but `GET /v1/ledger/txn-types` now
publishes each recipe's arguments as a flat field list — `args: ArgField[]`,
`{name, kind: "integer"|"text", required, default?}` — computed by
`argFields(code)` (`packages/ledger/src/recipes.ts`), which probes the
recipe's zod schema with `safeParse(1)`/`safeParse("sample text")` to infer
each field's kind. Selecting a type swaps in a `Field` per argument: an
integer field named `…Minor` becomes a `MoneyField`, a text field named
`…Account` becomes an `Input` with an "Account code" hint, everything else is
a plain `Input`. This is the shipped replacement for what earlier revisions of
this screen did with a raw JSON textarea (docs/ui.md §7 P3-16 in the code's own
words).

`argFields()` cannot express an **array** field — it only probes `1` and
`"sample text"`, so a field like `lines` or `closingLines` fails both probes
and is silently omitted rather than raising an error. Three types have an
array argument: `MANUAL-JRNL` and `OPEN-BAL` need a `lines` array (their
schema is `{lines, reason}`, so this screen shows only `reason` for them), and
`YEAR-END-CLOSE` needs `closingLines` (its schema is `{closingLines,
retainedEarningsAccount, fiscalYear, memo}`, so this screen shows only the
latter three). None of the three types are filtered out of the type picker or
the catalogue table below — `TXN_TYPES` carries all three as `financial: true`
with no exclusion — so a controller can select one, fill in the visible
fields, and submit; the ledger will always refuse with a field error naming
the missing array. `MANUAL-JRNL` has a bespoke composer at `/ledger/journal`
(§ below) and `YEAR-END-CLOSE` has one at `/ledger/year-end` (§ below), so a
controller who knows to look elsewhere is unaffected — but **no bespoke
screen exists for `OPEN-BAL`**; this generic form is the only UI that can
reach it, and it cannot actually complete the submission.

The recipes and what they take (the field list this screen now renders,
grouped by shape):

- **Commission accrual** (`BIND`, `BIND-GROUP`, `RENEW`, `ENDORSE`, `REINSTATE`,
  `PARTNER-BIND`, `AGENT-BIND`, `CMSN-ACCR`, `FEE-BROK`, `FEE-SERVICE`,
  `REFERRAL-SETL`, `FIN-CMSN`, `AD-PLACEMENT`, `EXT-RSHARE`): either an explicit
  split — `grossMinor`, `channelMinor`, `taxMinor` — **or** the inputs to compute
  one: `premiumMinor`, `baseCommissionPpm`, `channelSharePpm`, `taxPpm`,
  `flatFeeMinor`. Plus `incomeAccount` (default varies by code: 4000 new, 4010
  renewal, 4020 brokerage, 4030 referral, 4070 ads, 4075 marketplace),
  `receivableAccount` (default 1100, or 1150 financier / 1160 trade),
  `memo`, `dims`.
- **Settlement** (`CMSN-SETL`, `PSP-SETTLE`): `amountMinor`, `receivableAccount`,
  `cashAccount` (1000), `feeMinor`.
- **Clawback** (`CANCEL`, `CMSN-CLAWBACK`): `amountMinor`, `receivableAccount`,
  `channelMinor`.
- **Client money** (`PREM-COLLECT`, `PREM-INSTALMENT`, `CM-RECEIPT`,
  `PREM-REMIT`): just `amountMinor`, `memo`, `dims`.
- **Client-money transfer** (`CM-TRANSFER`): the commission args **plus**
  `amountMinor`, which must equal the commission earned or the API rejects it
  with "transfer amount X does not equal commission earned Y".
- **Expense accrual** (`RSHARE-ACCR`, `RSHARE-ADJUST`, `SURPLUS-DIST`,
  `MEDIA-SPEND`, `BOOST`): `amountMinor`, `expenseAccount`, `payableAccount`.
- **Authored entries** (`MANUAL-JRNL`, `OPEN-BAL`): a `lines` array of
  `{accountCode, side, amountMinor}` plus a `reason` of at least ten
  characters. The array is invisible to this screen (see above) — only
  `reason` renders. `MANUAL-JRNL` has a bespoke composer at `/ledger/journal`;
  `OPEN-BAL` has none.
- **Year-end close** (`YEAR-END-CLOSE`): `closingLines`, `fiscalYear`,
  `retainedEarningsAccount` (default `3100`), `memo`. The retained-earnings leg
  is computed, never entered. `closingLines` is likewise invisible here; use
  `/ledger/year-end`.
- **Payout** (`PAYOUT-INSTRUCT`, `RSHARE-SETL`, `CREATOR-PAYOUT`,
  `SUPPLIER-PAY`): `amountMinor`, `payableAccount`, `cashAccount`,
  `withholdingMinor`.
- **Invoice** (`SUB-INVOICE`, `SUB-CHANGE`, `OVERAGE`, `SUCCESS-FEE`):
  `netMinor`, `taxMinor`, `creditAccount` (2300 deferred), `receivableAccount`.
- **Recognition** (`SUB-RECOG`): `amountMinor`, `incomeAccount` (4040),
  `deferredAccount` (2300).
- **Credit note** (`SUB-CANCEL`, `CREDIT-NOTE`): `netMinor`, `taxMinor`,
  `debitAccount`, `receivableAccount`.
- **Deposit / refund / chargeback** (`DEPOSIT-TAKE`, `REFUND-ISSUE`,
  `CHARGEBACK`, `CHARGEBACK-WIN`): `amountMinor`, plus `feeMinor` for
  chargebacks.

**A field this form still never asks for: `dims`.** `argFields()` explicitly
skips any field named `dims` (a free-form dimension/tag object several
recipes accept), on every recipe, not only the three above. There is no
escape hatch for it on this screen — a controller who needs to set `dims` on
a hand-opened transaction cannot, from this form. Not determined from code
whether any recipe treats `dims` as required (the schemas read as optional
everywhere it appears).

**A related gap the form does not resolve:** the commission recipe's two
input shapes — an explicit split (`grossMinor`/`channelMinor`/`taxMinor`) or
premium + rates (`premiumMinor`/`baseCommissionPpm`/`channelSharePpm`/
`taxPpm`) — are mutually exclusive server-side, but `argFields()` has no way
to say so: both sets of fields render together as a flat list, with nothing
on screen indicating that filling in both is redundant (the recipe presumably
prefers one; not determined from code which).

**The catalogue table** (`open.catalogue` "Type catalogue", caption "Transaction
types this tenant can run"):

| Column | Content |
|---|---|
| Code (`open.code`) | mono, the raw code |
| Details | Badges: accent "Posts a journal" or neutral "No journal"; warning "Needs approval"; warning "Money out"; info "Client money" |
| Approvals | The policy key in mono (`ledger.remit`, `ledger.payout`, `dist.settlement_run`, `ledger.client_money_transfer`, `ledger.credit_note`, `ledger.refund`) or "—" |

Around 70 codes. There is no search and no grouping — see the weak list.

**States.**
- *Loading*: submit button `loading`.
- *Success*: a card, "Transaction opened" / "Opened as {id}." with an "Open it"
  link to `/ledger/transactions/:id`.
- *Approval required*: the API returns **403 with `code: "approval_required"`**
  and a `policy_key`. The screen renders a warning card: "Approval requested" /
  "Nothing has happened yet. The request is waiting in the approvals queue for
  someone who may decide it." plus a link to `/approvals`. **The "nothing has
  happened yet" sentence is the most important copy on the screen** — the actor
  must not press again.
- *Field errors*: a `role="alert"` list, one row per bad field:
  `<span class="font-mono text-12 text-muted">{path}</span> — {message}`, e.g.
  `premiumMinor — Required`.
- *Bad JSON*: "Arguments must be a JSON object." (`open.argsInvalid`), client-side.
- *Denied*: EmptyState naming `ledger:txns:create`.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible? |
|---|---|---|---|---|
| Open transaction | Yes, if the type is `financial` — the recipe posts a balanced batch inside the same transaction that creates the row | Yes: the `idempotency-key` header **and** the natural key on a unique index `(tenant, type, idempotencyKey)`. Reusing a key returns the same transaction, it does not post twice | Only if the type carries a policy key. `autoApprovable() = !payout && !clientMoney` — anything moving money out or touching client money always needs a person | Never by deletion. Reversal is a separate transaction from `/ledger/transactions/:id`, legal only once the original is `settled`, and posts a contra batch carrying `reversalOfBatchId` |

**Mobile.** Web only. Do not design a mobile version of this.

**RTL.** The Arabic labels (`arg.*`) exist for every argument this screen
currently renders. Currency and code inputs stay LTR by convention (as
Foundations).

**What is weak today.**
1. **`MANUAL-JRNL`, `OPEN-BAL` and `YEAR-END-CLOSE` remain selectable here
   with an incomplete field set** (their array argument is invisible — see
   above), so a submission through this screen for any of the three always
   fails server-side. `OPEN-BAL` in particular has no bespoke screen anywhere
   in the app; an operator needing to post an opening balance cannot complete
   it through the UI at all today.
2. `dims` is never asked for, on any recipe, for the reason above.
3. The type select shows bare codes with no descriptions, no grouping and no
   search across ~70 options — and the badges explaining what each code does are
   in a *different table further down the page*, not in the select.
4. `grossMinor` on the form and the same-shaped amount inside the recipe's own
   arguments (e.g. `arg.grossMinor`) are two separate fields with no
   cross-check on screen.
5. Minor units are unforgiving: nothing on screen shows "416 000 = R4 160,00"
   for the plain numeric args (`baseCommissionPpm` and friends); the `Minor`
   fields at least get a `MoneyField`.
6. The catalogue table is long and unfiltered.
7. No radio or grouping distinguishes the commission recipe's two
   mutually-exclusive input shapes (see above) — both render as one flat list.

---

## 3. `/ledger/transactions/:id` — One transaction

**Route + title.** `apps/web/app/routes/ledger-transaction.tsx`. Title:
"Transaction" (`txn.title`). Intro: "One transaction, its journal, and everything
done to it."

**Who sees it.** `ledger:txns:read` — a wide list: both finance roles,
tenant.admin, tenant.compliance (via journals), north.exec/admin, axis.agent,
axis.lead, axis.admin, orbit.partners, signal.lead/admin, partner.manager.
Four panels are separately gated and simply **absent** without the permission:

| Panel | Permission |
|---|---|
| Journal lines + the balance check | `ledger:journals:read` |
| Move state | `ledger:txns:authorize` |
| Reverse | `ledger:txns:reverse` |
| Approvals | `core:approvals:read` |
| Audit trail | `core:audit:read` |

So an `axis.agent` sees the details and the history and nothing else. A denied
user (no `ledger:txns:read`) sees the standard EmptyState. Panels that error for
any reason other than 401 are swallowed and rendered as absent, not fatal — an
unreadable audit log must not take down the money screen.

**Purpose.** The one place a posting can be inspected: its journal lines, whether
they balance, what happened to it, and what may happen next.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Transaction                            [ settled ]     (h1)  │
│ One transaction, its journal, and everything done to it.     │
├──────────────────────────────────────────────────────────────┤
│ ┌ dl grid auto-fit minmax(11rem,1fr) ──────────────────────┐ │
│ │ Identifier   Gross        Idempotency key   Created      │ │
│ │ txn_01H…     4 160,00 ZAR web:9f2…          12 Jul 14:02 │ │
│ │ Settled      Actor        Correlation       Opened by    │ │
│ │ Reverses     Reversed by  Journal batch     Failure      │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ Journal lines                                                │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ # │ Account │ Side   │    Debit │   Credit │ Memo        │ │
│ │ 1 │ 1100    │[Debit] │ 416 000  │          │ commission… │ │
│ │ 2 │ 4000    │[Credit]│          │  291 200 │ our share   │ │
│ │ 3 │ 2100    │[Credit]│          │  124 800 │ channel …   │ │
│ └──────────────────────────────────────────────────────────┘ │
│ Total debits 416 000 · Total credits 416 000                 │
│ Debits equal credits.                            (in success)│
├──────────────────────────────────────────────────────────────┤
│ ┌ Move state ────────┐  ┌ Reverse ─────────────────────────┐ │
│ │ Move to [ ▾ ]      │  │ A reversal does not delete …     │ │
│ │ Reason [        ]  │  │ Reason [required, ≥3 chars]      │ │
│ │ Failure code [   ] │  │ [Reverse this transaction]danger │ │
│ │ [Move]             │  └──────────────────────────────────┘ │
│ └────────────────────┘                                       │
├──────────────────────────────────────────────────────────────┤
│ History (Timeline)  ·  Approvals  ·  Audit trail             │
└──────────────────────────────────────────────────────────────┘
```

**Details grid** (`<dl>`, `grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]`):
Identifier, Gross (a `<Money>` also showing `baseMinor`/`baseCurrency` when they
differ), Idempotency key (mono), Created, Settled, Actor, Correlation, Opened by
(the parent transaction), Reverses, Reversed by, Journal batch, Failure. Empty
fields render as "—".

**Journal-lines table** (caption "Journal lines posted by this transaction",
`rowState={() => "sealed"}`):

| Column | Type | Alignment | Notes |
|---|---|---|---|
| `#` | seq, mono | start | |
| Account | code, mono | start | Not a link today — see weak list |
| Side | Badge | start | "Debit" / "Credit" |
| Debit | money | **numeric/end** | Renders `<Money>` only when `side === "debit"`; otherwise the cell is blank, not zero |
| Credit | money | **numeric/end** | Mirror of the above |
| Memo | text | start | |

A blank rather than a zero is deliberate: a debit-and-credit table with zeros in
half the cells is unreadable. Preserve it.

Beneath: when balanced, one line — Total debits, Total credits, and
"Debits equal credits." in `text-success`. When not, a `role="alert"` danger card
titled "This batch does not balance", the delta in
`font-display text-28 font-bold text-danger` with `signed`, and the body:
"Debits and credits differ by the amount above. Double entry says they cannot. Do
not act on this transaction — send the batch id to finance engineering." This is
the loudest thing in the module and should stay that way.

A non-financial transaction shows "No journal lines" / "A non-financial
transaction settles without a batch. Nothing was posted."

**The state machine.** Thirteen states with tone:

| State | Tone |
|---|---|
| initiated, validated | neutral |
| authorized, executing, adjusted | info |
| pending_external ("Waiting on a third party"), reversing, adjusting | warning |
| settled | success |
| reversed, failed, rejected, expired | danger |

Legal moves: initiated → validated / rejected / failed; validated → authorized /
rejected / failed; authorized → executing / failed / rejected; executing →
settled / pending_external / failed; pending_external → executing / failed /
expired; **settled → reversing / adjusting**; reversing → reversed / failed;
adjusting → adjusted / failed; adjusted → reversing; reversed, failed, rejected,
expired → nothing.

**Move state form** (only with `ledger:txns:authorize`): a Select "Move to"
containing **only the legal next states** — an illegal move is not offered, not
rejected after the fact. Input "Reason" (500), Input "Failure code" (64), button
"Move". When there is nowhere to go: "No move is legal from this state."
Success: "Moved to {state}."

**Reverse card** (only with `ledger:txns:reverse` **and** `state === "settled"`):
body copy, verbatim — "A reversal does not delete anything. It opens a second
transaction that posts the opposite journal and leaves both on the record."
A required Textarea "Reason" (min 3, max 500, 3 rows), a hidden minted
idempotency key, and a danger button "Reverse this transaction". Confirm:
"Reverse this transaction? A counter-entry will be posted and both remain on the
record." Success: "Reversal posted as {id}." — and the details grid's
"Reversed by" then carries the forward link.

**History.** A `Timeline` of transitions rendered `from → to` with actor, reason
and timestamp.

**Approvals section.** Policy key, decision badge, actor, when, reason. Empty:
"Nothing about this transaction has needed an approval." Always a link: "Open the
approvals queue".

**Audit table.** `rowState="sealed"`, columns When / Actor / Action.

**States.** Loading — buttons show `loading`. Error — panels absent rather than
fatal, except the transaction itself, which throws to the boundary. Denied — the
standard EmptyState.

**AI surfaces.** None. No panel on this screen is model-generated, and there is
no "explain this transaction" affordance. **Do not add one that could be mistaken
for an authority on the numbers.** If a redesign wants a plain-language summary
of a batch, it belongs beside the lines, marked ✦, and must never sit between the
actor and the figures.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible |
|---|---|---|---|---|
| Move state | No journal of its own; moving into `executing`/`settled` is what lets the batch land | No key on the form — the state machine is the guard | The transition endpoint re-checks the type's policy | Only by another legal transition |
| Reverse | **Yes** — a contra batch carrying `reversalOfBatchId` | Yes, a minted key in a hidden field | Passes the same policy gate as the original type; a payout reversal needs approval | The reversal is itself a transaction; it can be inspected but there is no "un-reverse". `adjusted → reversing` is the only second bite |

Nothing on this screen deletes anything. There is no delete affordance and there
must never be one.

**Mobile.** Web only. `/m/ledger` lists txn rows and stops there — tapping one
goes nowhere.

**RTL.** Debit and Credit columns swap to the reading order automatically; the
figures stay LTR and align to `text-end` (left in Arabic). The mono identifier,
account codes and idempotency key must be forced LTR — today they inherit.

**What is weak today.**
1. Account codes in the journal-lines table are not links. From a journal line
   you cannot reach the account statement, though `/ledger/statement?account=1100`
   exists and would answer the next question every reader has.
2. The transaction's *type* has no explanation on screen — `PREM-REMIT` is shown
   raw with no hint that it moves client money out.
3. "Move to" is a bare select of state names. Nothing says what `executing` will
   do or that `settled` is where a journal lands.
4. Approvals show as a flat list with no "why is this waiting on someone".
5. The unbalanced-batch alert tells the reader to email finance engineering — an
   honest but blunt dead end.

---

## 4. `/ledger/period-close` — Period close

**Route + title.** `apps/web/app/routes/ledger-periods.tsx`. Title: "Period close"
(`period.title`). Intro: "A period closes when its checks pass. Soft close first:
it stops ordinary posting and still allows an adjustment with a reason."

**Who sees it.** `ledger:periods:read` — finance.controller, finance.analyst,
finance.director, tenant.admin. The close buttons (all three — Soft close,
Hard close, and Reopen) are gated as one group on `ledger:periods:close`,
held by **finance.controller and finance.director**; the balance-rebuild card
needs `ledger:journals:post`, held only by **finance.controller** (director
does not hold it — the director approves and posts what the analyst drafted,
and this maintenance action is neither). Denied: the standard EmptyState
naming `ledger:periods:read`. `finance.analyst` sees the whole screen
read-only, with no close buttons and no rebuild card.

**Purpose.** See whether a month may close, close it, and check the balance cache
against the journal.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Period close                                           (h1)  │
│ A period closes when its checks pass. Soft close first: …    │
├──────────────────────────────────────────────────────────────┤
│ Look up a period   Period [2026-07]  [Apply]  Clear          │
├──────────────────────────────────────────────────────────────┤
│ [ This period cannot close yet ─ danger, only when blocked ] │
│   trial_balance_zero@2026-07 — debits and credits differ …   │
├──────────────────────────────────────────────────────────────┤
│ ┌ Card "2026-07"                              [ Open ] ────┐ │
│ │ From 1 Jul 2026   To 31 Jul 2026   Closed by —           │ │
│ │ ┌ Checks ──────────────────────────────────────────────┐ │ │
│ │ │ Check                       │ State  │ Detail        │ │ │
│ │ │ trial_balance_zero@2026-07  │ [Pass] │ 0             │ │ │
│ │ │ no_pending_external@2026-07 │ [Fail] │ 2 waiting     │ │ │
│ │ │ no_open_client_money_breach…│ [Pass] │ none open     │ │ │
│ │ └──────────────────────────────────────────────────────┘ │ │
│ │ [Soft close]                                             │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ Periods ─────────────────────────────────────────────────┐ │
│ │ 2026-07 [Open]  · 2026-06 [Soft closed] · 2026-05 [Hard…]│ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ Check balances against the journal ──────────────────────┐ │
│ │ The journal is the truth and the balances table is a …   │ │
│ │ [Run the check]                                          │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Period selector.** A GET `<Form>`: Input `period`, `w-40`, `pattern="\d{4}-\d{2}"`,
hint "2026-07". Defaults to the current month. **Apply** and a **Clear** link.
Opening a month that has no row creates it (open, with its checks evaluated) —
worth knowing before designing an "add a period" button; there is none, and none
is needed.

**Period card.** Titled with the code, `actions` slot holding a Badge whose tone
is: open → success, soft_closed → warning, hard_closed → neutral. A `<dl>` of
From / To / Closed by (with `closedAt`).

**Checks.** Three named checks, evaluated server-side:
`trial_balance_zero@<code>`, `no_pending_external@<code>`,
`no_open_client_money_breach@<code>`. Failures render **first**, above the card,
as a `role="alert"` danger block: "This period cannot close yet" / "The checks
below have not passed. Fix what they name, then close." — listing each failed
check's name (mono) and detail. Then the full table: Check (mono), State (Badge —
success "Pass" / danger "Fail"), Detail.

**Close actions** (only with `ledger:periods:close`), one button, whichever fits
the current state:

| State | Button | Variant | Confirm copy |
|---|---|---|---|
| open | Soft close | secondary | "Soft close this period? Ordinary posting stops; adjustments with a reason still post." |
| soft_closed | Hard close | danger | "Hard close this period? Only contra entries post afterwards." |
| soft_closed / hard_closed | Reopen | ghost | "Reopen this period? Posting resumes and the close is undone." |

Success: "Period {code} is now {state}." / "Period {code} is open again."

**`force` is deliberately not exposed in this screen** — the UI never sends
`force: true` and offers no control for it, because the checks are the gate
and a screen that hands out an override turns them into a formality. The
capability is fully wired server-side, though, not merely stubbed: `closePeriod()`
(`packages/ledger/src/periods.ts`) accepts an internal `force` option gated on
`ledger:periods:force_close` plus the `ledger.period_close_force` policy
(always dual-control, never auto-approved — see Foundations), and only
`finance.director`/`finance.controller` hold that permission. **Do not add an
override in a redesign** without going through that same gate.

**Recent periods table.** Twelve rows, newest first: code (accent, mono, a link
back to `?period=`), state Badge, Closed by, Closed at.

**Rebuild card** (only with `ledger:journals:post`). Title: "Check balances
against the journal". Body: "The journal is the truth and the balances table is a
cache derived from it. This re-reads every line and reports where the two
disagree. It writes nothing and moves no money…". Button "Run the check", with a
confirm. Success: "Checked {count} balances. Every one agrees with the journal."
Drift: a danger alert, "{count} of {total} balances disagree with the journal",
then a table — Account (mono), Currency, `Stored · Debit`, `From the journal ·
Debit`, `Stored · Credit`, `From the journal · Credit`, all numeric `<Money>` —
with the footnote "Only the accounts that disagree are listed."

**States.** Loading — buttons `loading`. Empty — a month with no activity still
renders its card and its checks. Error — the boundary. Denied — as above.

**AI surfaces.** None. A close is never machine-initiated and nothing suggests
when to close.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible |
|---|---|---|---|---|
| Soft close | No journal lines; stops ordinary posting | No key on the form | `ledger.period_close` policy, gated on `ledger:periods:close` | Yes — Reopen |
| Hard close | No lines; only contra entries post afterwards | No key | Same policy and permission (a UI-side `force: true` is never sent — see above; if it were, the server would gate it on `ledger:periods:force_close` and the `ledger.period_close_force` policy instead) | Yes — Reopen, and reopening is audited |
| Reopen | No lines | No key | **A different policy**: `reopenPeriod()` (`packages/ledger/src/periods.ts`) requires `ledger:periods:reopen` and gates on `ledger.period_reopen`, not `ledger.period_close` — see the weak note below | Closing again |
| Run the check | **Writes nothing.** Read-only comparison, reported and discarded | n/a | n/a | n/a — nothing to reverse |

The rebuild's read-only nature is the most important thing to communicate. It
sits under `ledger:journals:post` because it *could* have been a write, and the
copy carries the whole burden of saying it is not. A redesign should make that
structural — put it in a "Diagnostics" region, not next to the close buttons.

**Mobile.** Web only.

**RTL.** The period code `2026-07` stays LTR. The drift table's four money
columns pair up as Stored/Journal — in Arabic they mirror as a block, which is
correct; do not un-pair them.

**What is weak today.**
1. A failed check names itself in `snake_case@2026-07` and gives a one-line
   detail. There is no link from `no_pending_external@2026-07` to the list of
   pending transactions blocking it — the controller has to go find them.
2. Soft, hard and reopen are three words for a state machine nobody explains on
   the screen; only the confirm dialogue says what each does.
3. The rebuild card sits beside the close buttons and looks equally consequential.
4. Twelve periods, no pagination, no year view.
5. **The Reopen button is gated on the wrong client-side permission.** The
   screen shows Soft close, Hard close and Reopen as one group behind
   `loaded.canClose`, which is `held.has(PERM.periodsClose)`. The server-side
   route for Reopen actually requires `ledger:periods:reopen` (a distinct
   permission, distinct policy `ledger.period_reopen`) — but `ledger.shared.ts`'s
   `PERM` object has no `periodsReopen` constant at all, so there is no correct
   value to gate against even if someone wanted to. Not currently exploitable:
   every stock role that holds `ledger:periods:close` also holds
   `ledger:periods:reopen` (`finance.controller`, `finance.director`). It
   breaks the first time a custom role holds one permission without the other
   — a role with `close` but not `reopen` would see (and be able to press) a
   Reopen button the server will 403.

---

## 5. `/ledger/statement` — Account statement

**Route + title.** `apps/web/app/routes/ledger-account.tsx`. Title: "Account
statement" (`account.title`). Intro: "Every line posted to this account, with the
balance it left behind."

**Who sees it.** `ledger:journals:read` — finance.controller, finance.analyst,
tenant.admin, tenant.compliance, north.admin, north.analyst. Denied: the standard
EmptyState naming `ledger:journals:read`.

**Purpose.** Read one account's lines over a date window, with a running balance,
and see whether the cached balance still agrees with the journal.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Account statement                                      (h1)  │
│ Every line posted to this account, with the balance it left. │
├──────────────────────────────────────────────────────────────┤
│ Look up an account                                           │
│ Account [1000]  Currency [ZAR]  From [📅]  To [📅]           │
│ Account code from the chart of accounts, e.g. 1000    (hint) │
│ [Apply]   Pick an account →                                  │
├──────────────────────────────────────────────────────────────┤
│ ┌ dl ──────────────────────────────────────────────────────┐ │
│ │ Opening    Closing    Total debits  Total credits  Cached│ │
│ │ 120 000    384 120    512 400       248 280       384 120│ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ [ The cached balance disagrees with the journal — danger ]   │
├──────────────────────────────────────────────────────────────┤
│ ┌ Statement (compact, sealed rows) ────────────────────────┐ │
│ │ When   │ Side    │  Amount │ Running │ Transaction │ Memo│ │
│ │ 3 Jul  │[Debit]  │ 384 120 │ 504 120 │ txn_01H…    │ …   │ │
│ └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**The lookup form** (GET): Input `account` (**required**, hint "Account code from
the chart of accounts, e.g. 1000"), Input `currency` (`maxLength=3`, defaults to
`me.policy.currency`), From and To as `<input type="date">`. **Apply**, and a
ghost link "Pick an account" to `/ledger/accounts`.

**KPI block** (`<dl>`): Opening (`signed`, `font-display text-20`), Closing
(`signed`, same), Total debits, Total credits, Cached balance.

**Drift alert.** When `statement.closingMinor !== balance.balanceMinor`, a
`role="alert"` block (`border-danger/40 bg-danger/10 p-5`): "The cached balance
disagrees with the journal" / "The statement closes on one figure and the balance
cache holds another. The journal is the truth. Rebuild the cache from the period
close screen." — with a link to `/ledger/period-close`. This is the one place in
LEDGER where an alert hands the reader the next screen. Copy that pattern
elsewhere.

**Lines table** (`density="compact"`, `rowState={() => "sealed"}`, row key
`` `${batchId}|${seq}` ``):

| Column | Type | Alignment | Notes |
|---|---|---|---|
| When | datetime | start | |
| Side | Badge | start | info "Debit" / neutral "Credit" |
| Amount | money | numeric/end | Never signed — the side column carries the sign |
| Running | money `signed` | numeric/end | The only signed column |
| Transaction | mono, accent | start | Links to `/ledger/transactions/:id` |
| Memo | text | start | |

**States.**
- *No account entered*: EmptyState "Pick an account" / "Enter an account code
  above to read its statement."
- *No lines in the window*: "No lines in this window" / "Nothing posted to this
  account between these dates."
- *Loading / Error / Denied*: as everywhere else.

**AI surfaces.** None.

**Actions and consequences.** Read-only. No posting, no key, no approval.

**Mobile.** Web only.

**RTL.** The running balance is the one signed column; its minus sign belongs on
the numeric side of the figure and `Intl` places it. Do not hand-position it.

**What is weak today.**
1. The account is typed as a code with no autocomplete. "Pick an account" leaves
   the screen and comes back with nothing filled in.
2. Nothing anywhere links *into* this screen with the account pre-filled — not
   the trial balance, not the journal-lines table on a transaction. The most
   useful screen in the module is the hardest one to reach.
3. Opening/closing are shown but the date window that produced them is only
   visible in the form above.
4. There is no pagination indicator; a busy account is a long scroll.

---

## 6. `/ledger/recon` — Reconciliation

**Route + title.** `apps/web/app/routes/ledger-recon.tsx`. Title:
"Reconciliation" (`recon.title`). Intro: "Match a counterparty statement against
what we settled. Nothing posts here — a match is a judgement, and it is recorded
as one."

**Who sees it.** `ledger:recon:read` **or** `ledger:recon:run` — finance.controller,
finance.analyst, tenant.admin, axis.admin. Starting a run needs
`ledger:recon:run` (controller, analyst, axis.admin); deciding a match needs
`ledger:recon:confirm` (**controller only**). So the analyst runs the
reconciliation and the controller signs off on it — that separation is the point
of the screen.

**Purpose.** Load a counterparty statement, see what matched, and decide the ones
that did not.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Reconciliation                                         (h1)  │
│ Match a counterparty statement against what we settled. …    │
├──────────────────────────────────────────────────────────────┤
│ Open a run   Run id [ ]  [Apply]                             │
├──────────────────────────────────────────────────────────────┤
│ ┌ Summary KPIs ────────────────────────────────────────────┐ │
│ │ Matched 42 │ Variance 3 │ Variance amount −1 240 │ Open 3│ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ Matches ─────────────────────────────────────────────────┐ │
│ │ Stmt line │ Transaction │ Amount │ Delta │ How │ State │ …│ │
│ │ ST-0091   │ txn_01H…    │ 384120 │     0 │[Exact]│[Conf]│ │
│ │ ST-0104   │ txn_01H…    │ 120000 │ −1240 │[Assist│[Prop]│ │
│ │           │             │        │  75%  │ ant]  │      │ │
│ │           │  Why [        ] [Confirm] [Reject]         │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ ┌ Start run ───────────────────────────────────────────────┐ │
│ │ Process [Insurer ▾] Period [2026-07] Currency [ZAR]      │ │
│ │ Counterparty [ ]  Tolerance, in minor units [ ]          │ │
│ │ Statement lines                                          │ │
│ │ ┌────────────────────────────────── 8 rows, mono ──────┐ │ │
│ │ │ INS-8891, 1500.55, TXN-01, 2026-08-01, August premium │ │ │
│ │ └───────────────────────────────────────────────────────┘ │ │
│ │ Paste the statement as it was exported — ref, amount, …  │ │
│ │ Commas or tabs; a header row is fine.              (hint)│ │
│ │ 41 lines read, 0 not.        [preview table, read-only]  │ │
│ │ ☐ Let the assistant propose matches for the leftovers    │ │
│ │   Proposals are never posted. Each one still needs a …   │ │
│ │ [Start run]                                              │ │
│ └──────────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────┤
│ Runs — ten most recent                                       │
└──────────────────────────────────────────────────────────────┘
```

**Summary KPIs**: Matched, Variance, Variance amount (money, `signed`, `toned`),
Awaiting a decision.

**Matches table** (caption "Proposed and decided matches in this run"):

| Column | Content |
|---|---|
| Statement line | `statementLineRef`, mono |
| Transaction | mono, accent, links to `/ledger/transactions/:id` |
| Amount | numeric money |
| Delta | numeric money, `signed`, `toned` only when non-zero |
| How | Badge — **info** "Assistant" for `ai_proposed`, neutral "Exact" / "Within tolerance"; the confidence `{n}%` sits beneath |
| State | Badge — success "Confirmed", danger "Rejected", warning otherwise |
| Decided by | Name, with the reason code beneath |
| Decide | Inline form, only when the actor holds `ledger:recon:confirm` **and** `row.state === "proposed"` |

**The decide form** is per-row: a required Input `reasonCode` (`maxLength=64`,
label "Why", visually hidden, hint "Recorded against your name on the match. Say
what convinced you.") and two submit buttons, **Confirm** and **Reject**, each
with its own confirm: "Confirm this match? Your name and reason go on the record."
/ "Reject this match? Your name and reason go on the record." Result:
"Match recorded as {decision}."

**Start-run form** (only with `ledger:recon:run`):

| Field | Label | Type | Default |
|---|---|---|---|
| `process` | Process | Select | `insurer` — options Insurer, Payment provider, Client money, Partner, Media |
| `period` | Period | Input | current `YYYY-MM` |
| `currency` | Currency | Input, 3 | `me.policy.currency` |
| `counterpartyRef` | Counterparty | Input | empty |
| `toleranceMinor` | Tolerance, in minor units | Input `type=number min=0` | empty |
| `lines` | Statement lines | Textarea, **required**, 8 rows, mono | empty — placeholder `"INS-8891, 1500.55, TXN-01, 2026-08-01, August premium"`, hint: "Paste the statement as it was exported — one line per row, columns in this order: reference, amount, our reference, date, description. Only the first two are needed. Commas or tabs; a header row is fine." |
| `propose` | "Let the assistant propose matches for the leftovers" | **Checkbox, unchecked** | off |

**Parsing the paste.** `statementFromCsv()` (`ledger.shared.ts`) is imported by both the
route (loader/action, server-side) and by a `StatementPreview` component rendered
live under the textarea (client-side) — the same function runs in both places, so
the preview cannot itself drift from what the server will do, though it is still
only a preview: nothing is read from it, the raw pasted text travels in the `lines`
form field and is re-parsed server-side on submit. The separator is auto-detected —
tab if any non-blank row contains one, else comma. A first row whose amount column
does not parse is treated as a header and dropped silently, but only while no data
row has been read yet; the same failure on any later row is a rejection. Any row
whose ref is empty or whose amount does not parse as money in the chosen currency is
rejected outright (not skipped) and is listed by row number with its raw text in a
danger-toned alert both live in the preview and, if the user submits anyway, again
after the round trip — and **a run with even one rejected row does not start at
all**: the action returns the rejected list instead of calling `/v1/ledger/recon/runs`.
Submit "Start run", confirm "Start this reconciliation run?" Result:
"Run {id} started: {matched} matched, {variances} with a variance."
Empty paste (blocked by `required`, but also handled server-side): "Paste the
statement before starting a run."

**Three passes.** Pass 1 exact, pass 2 within tolerance, pass 3 the assistant —
and pass 3 only runs when `propose` is ticked. Everything pass 3 produces lands
in `proposed` and waits for a person.

**Runs list.** Ten most recent: Period, Process, Counterparty, Matched count,
Variance count, Variance amount, State badge, Created.

**States.**
- *No run selected*: EmptyState "Pick a run" / "Start a run above, or open one by
  its id."
- *Run with nothing to decide*: "No matches yet" / "This run produced nothing to
  decide."
- *Loading / Error / Denied*: as everywhere else.

**AI surfaces.** The only ones in LEDGER, described in full under Foundations.
Three visible markers today: the intro sentence, the checkbox hint, and the
info-toned "Assistant" badge with its confidence percentage. **Put the ✦ on that
badge in a redesign, and nowhere else in this module.** Never let a proposal
pre-select Confirm, never let it auto-decide at high confidence, never post from
this screen.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible |
|---|---|---|---|---|
| Start run | **No.** A run reads and compares; it writes `recon_runs` and `recon_matches` rows only | No key — a duplicate run is a new run, harmless because nothing posts | None | Start another run |
| Confirm / Reject a match | **No journal line.** It records a human judgement with a name and a reason code | No key | None; the permission `ledger:recon:confirm` is the gate | The match's state can be set again through the generic record screen, and every change is audited |

Nothing on this screen touches the ledger. That is worth stating in the design,
because it is the screen users most often assume does.

**Mobile.** Web only.

**RTL.** `Textarea` (`packages/ui/src/primitives.tsx:277`) is a plain passthrough
with no `dir` prop of its own, so in an `ar` session the `lines` field inherits the
page's `dir="rtl"` while its content — comma- or tab-delimited references, amounts
and ISO dates — is inherently left-to-right token order; nothing in the route
overrides this. The Delta column is the only toned column in the module —
red/green must survive both directions and must not be the only signal (the sign
carries it too).

**What is weak today.**
1. There is a live preview now (`StatementPreview`, reusing the exact parser the
   server will run) but still no upload and no column mapping — every real
   counterparty statement is pasted by hand, column order is fixed
   (ref, amount, our ref, date, description) and unlabelled beyond the hint text,
   and `recon_runs` still carries a `statementFileId` column that nothing in this
   screen populates. The `lines` textarea has no `dir="ltr"` override, so a pasted
   statement is subject to RTL reflow in an Arabic session (see RTL note above).
2. There is no unmatched view on this screen even though `reconcile()`
   (`packages/ledger/src/recon.ts`) returns `unmatchedStatementRefs` and
   `unmatchedTxnIds` and the labels exist ("Statement lines with no transaction",
   "Transactions with no statement line") — `recon.unmatchedRefs` /
   `recon.unmatchedTxns` in `ledger.shared.ts`, unreferenced by
   `ledger-recon.tsx`.
3. `reasonCode` is free text up to 64 characters, per row, with no vocabulary —
   so the audit trail fills with whatever people type.
4. A run with 500 matches is one flat table with no filter by state or method.
5. Confidence renders as a bare percentage under a badge with no explanation of
   what it measures.

---

## 7. The generic workspace — `/ledger` and `/ledger/:resource[/:id]`

Everything not listed above is rendered by two generic routes (`module.tsx`,
`record.tsx`) from a declarative spec. The list screen is: h1, a link strip
("Reports and tools"), a tab strip ("Sections"), a filter/search bar, a table, a
create panel where permitted. The record screen is: a back link ("Back to list"),
the first column's value as the h1, `{tab label} · {id}` beneath, an optional
"Journal, approvals and next steps" button, a `<dl>` grid of every column plus
Created/Updated, an actions section, an edit form, and a delete form guarded by
"Delete this record? It is retained for audit and can be restored by an
administrator."

**The link strip** (`apps/web/app/modules/ledger.ts`; withheld links are absent),
in order: Trial balance, Profit and loss, Balance sheet, Aged, Commission (all
`ledger:journals:read`), Client money (`ledger:client_money:read`), **Money map**
(`ledger:journals:read`, §8 below), Chart of accounts (`ledger:accounts:read`),
Open a transaction (`ledger:txns:create`), Period close (`ledger:periods:read`),
**Year-end close** (`ledger:journals:read`, §9), **Manual journal**
(`ledger:journals:draft`, §10), Account statement (`ledger:journals:read`),
Reconciliation (`ledger:recon:read`), Commission settlements
(`dist:commissions:read`, `routes/settlement.tsx` — a DIST-owned screen reached
from LEDGER's own link strip; out of scope for this doc, see docs/ui/dist.md).
The permission gate on Year-end close and Manual journal is looser than the
screen itself: both links show for anyone who can read journals, and the form
inside each still enforces its own real requirement — `ledger:periods:year_end`
server-side for year-end (`apps/api/src/routes/ledger.ts:241`); for the manual
journal, the client loader gates rendering on `journalsDraft` **or** `txnsCreate`,
and the API's `POST /v1/ledger/txn/:type` (the one write path every recipe goes
through) applies the same either/or at the type level: "`if (!(def.approval &&
can(ctx.actor, "ledger:journals:draft", subject))) require_(ctx.actor,
"ledger:txns:create", subject)`" (`apps/api/src/routes/ledger.ts:87-91`, docs/27
F2) — MANUAL-JRNL is an approval-gated type, so `ledger:journals:draft` alone is
enough to originate it; a type that settles without a second seat still needs
the full `ledger:txns:create`. A read-only visitor can still reach either screen
and see its own denial there rather than at the link.

**The twenty tabs, in order:**

| Tab | Label | Read permission | Money columns | Writes |
|---|---|---|---|---|
| `txns` | Transactions | `ledger:txns:read` | Gross | **No create form** — a transaction is opened by `POST /v1/ledger/txn/:type`, never typed into a row. Carries the "Journal, approvals and next steps" link |
| `txn-transitions` | Transitions | `ledger:txns:read` | — | read-only |
| `saga-steps` | Saga steps | `ledger:txns:read` | — | read-only |
| `accounts` | Chart of accounts | `ledger:accounts:read` | — | create/edit/delete with `ledger:accounts:write`. **Only name, parent, clientMoney and currency are editable** — code, type and normal side are what every posted line was written against |
| `journal-batches` | Journal batches | `ledger:journals:read` | Total debits, Total credits | read-only |
| `journal-lines` | Journal lines | `ledger:journals:read` | Amount, Base amount | read-only, filterable by side |
| `account-balances` | Balances | `ledger:accounts:read` | Debit, Credit | read-only — a derived cache, never hand-written |
| `periods` | Periods | `ledger:periods:read` | — | state editable with `ledger:periods:close`, routed through the `ledger.period_close` policy |
| `recon-runs` | Reconciliations | `ledger:recon:read` | Variance amount | create with `ledger:recon:run` |
| `recon-matches` | Matches | `ledger:recon:read` | Amount, Delta | state + reasonCode editable with `ledger:recon:confirm` |
| `client-money-checks` | Client money checks | `ledger:client_money:read` | Asset, Liability, Shortfall | read-only |
| `subscriptions` | Subscriptions | `admin:billing:read` | Price | full CRUD with `admin:billing:write` |
| `invoices` | Invoices | `ledger:invoices:read` | Subtotal, Tax, Total | create with `ledger:invoices:create`, state change with `ledger:invoices:approve` — a draft invoice is a document, issuing it is what raises the transaction |
| `revenue-schedules` | Revenue schedules | `ledger:journals:read` | Planned, Recognized | read-only |
| `usage-meters` | Usage meters | `admin:billing:read` | — | read-only |
| `payments` | Payments | `ledger:payments:read` | Amount, Fee | no create form — a payment is captured by its transaction type |
| `payment-plans` | Payment plans | `ledger:payments:read` | Total | only the plan's own state is editable |
| `fx-rates` | FX rates | `ledger:accounts:read` | — | create only, **immutable** — a corrected rate is a new row for a new `asOf` |
| `tax-rules` | Tax rules | `ledger:accounts:read` | — | CRUD with `ledger:accounts:write` |
| `settlements` | Settlements | `dist:commissions:read` | Gross, Adjustments, Net | no create or edit form — a settlement run is raised by DIST with an approval on the net amount (`dist.settlement_run`), and paying one is a transaction |

**Column labels worth knowing** (these are the strings on screen, not the field
names): `idempotencyKey` → "Reference", `grossMinor` → "Gross", `actorKind` →
"Actor", `correlationId` → "Correlation", `settledAt` → "Settled".

**Enum values** resolve through `optionLabel()`: `<owner>.<value>` first
(`state.pending_external` → "Waiting on a third party"), then the bare value, then
`humanise()` (`pending_settlement` → "Pending settlement"). A raw i18n key must
never reach a person.

**States.** Empty: "Nothing here yet" / "No records match this view. Clear the
filters, or create the first one." Filtered-empty: "No records match these
filters." Row count: "{count} shown". Denied at workspace level:
"Your roles do not include access to this area."

**What is weak today.**
1. Twenty tabs in one strip, with no grouping. Journal batches, invoices, FX
   rates and usage meters are four different jobs sharing one row of tabs.
2. `ratePpm`, `unitPriceMicro` and `fxRatePpm` render as raw integers — `150000`
   where a person expects 15%.
3. Money columns in these tables have their currency in a sibling column that is
   often not shown, so a figure can appear currency-less.
4. The record screen's `<dl>` shows every column at equal weight; on a journal
   batch, the two totals are lost among the identifiers.
5. Settlements is the one tab whose permission belongs to another module
   (`dist:commissions:read`), so it appears and disappears for reasons nothing on
   the screen explains.

---

## 8. `/ledger/money-map` — Money map

**Route + title.** `apps/web/app/routes/ledger-money-map.tsx`. Title: "Money map"
(`title`). Intro (`intro`): "Where a period's money went: premium in, what the
insurer took, what was kept, and how the kept part split. Every node opens the
journal lines that add up to it." Cites docs/22 §1.2 in its own header comment:
"Sankey of value flow for a period … Nodes are clickable to filtered journals.
Client-money segregation shown as a distinct, always-visible bar."

**Who sees it.** `ledger:journals:read` gates the whole screen — denied renders
an EmptyState ("You cannot open the money map" / "It needs a permission your
role does not hold. An administrator can grant it."). A second, narrower
permission, `ledger:client_money:read`, gates only the segregation bar further
down the page: an actor with journals-read but not client-money-read still gets
the full diagram, just with the segregation section replaced by one sentence
saying why it is hidden (`seg.denied`) — not a 403 for the page.

**Purpose.** Show where a period's premium turned into insurer remittance,
retained commission, partner share, tax and net — as a flow diagram — with a
click-through to the journal lines behind any node, plus a permanent client-money
whole/short check.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ [ Client money is short ─ danger, only when any currency breaches ] │
│   Cash held is below what is owed to clients. …               │
│   AED −12 400.00   ZAR −900.00                                │
├──────────────────────────────────────────────────────────────┤
│ {headline}                                              (h1) │
│ Where a period's money went: premium in, what the insurer …   │
├──────────────────────────────────────────────────────────────┤
│ Period [2026-07 month]  Currency [AED]  [Apply]                │
├──────────────────────────────────────────────────────────────┤
│ ┌ Diagram — svg, always dir="ltr" ────────────────────────────┐│
│ │ Premium in ══╗                                               ││
│ │              ╠══ Insurer remittance                          ││
│ │              ╠══ Commission retained ══╦══ Partner share      ││
│ │              ╚══ Still held for clients╠══ Tax                ││
│ │                                        ╚══ Net to the business││
│ └───────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────┤
│ Carried out of the period    R 12 000,00                      │
├──────────────────────────────────────────────────────────────┤
│ ┌ Client money segregation ────────────────────────────────────┐│
│ │ AED  Cash held … Owed to clients … Margin … [Whole/Short]     ││
│ │ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░ asset track                                   ││
│ │ ▓▓▓▓▓▓▓▓▓▓░░░░░ liability track                               ││
│ └───────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────┤
│ ┌ Journal lines behind this node — only when ?node= is set ─────┐│
│ │ Posted │Transaction│Txn id│Account│Side│Amount│Memo            ││
│ └───────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

**The headline.** `moneyMapHeadline(map, breached, l, locale)`: a client-money
breach outranks everything — "{count} currency breach(es) in client money." —
else the `net` node's amount for the period — "{node} for {period}: {amount}."
— else, when nothing posted, the shared `empty` copy. The code comment is
explicit that this headline carries **no ✦ marker**: "this is not an agent's
finding (CLAUDE.md §11) — both numbers are the loader's."

**The breach flag.** `data-flag="CM-BREACH-FLAG"`, `role="alert"`, rendered
**above the header**, before the h1 — docs/22 §1.2's ordering rule that a
segregation breach outranks the page's own title. One line per breached
currency: the code and its (negative) margin.

**Filter form.** A GET `<Form>`: `period` as an HTML `type="month"` input
(defaulting to the current URL param or the loaded map's own period), `currency`
as free text (`maxLength=3`, no client-side validation against a currency
list), **Apply**. Omitting `period` server-side defaults to the current month
(`periodCode(ctx.now)`, `apps/api/src/routes/ledger.ts:366`).

**The diagram.** An SVG Sankey-style flow, hand-rolled (`layoutMap()`, no chart
library — code comment: "no chart library for six nodes"), three columns in a
fixed order: premium-in → {insurer-remittance, commission-retained,
still-held} → {partner-share, tax, net}. One scale for the whole diagram, set
by the tallest column, so ribbon thickness is comparable across columns.
Drillable nodes (those with a `drill` descriptor from the API) render as a
`<Link>` wrapping the node's rect and its two text lines (name, amount);
non-drillable nodes render as plain, unlinked shapes. The section carrying the
`<svg>` is **always `dir="ltr"`**, in both locales, with an explicit code
comment: "the diagram reads left to right … mirroring them would put the
insurer's money before the premium that paid it" — a deliberate, justified RTL
exception, not an oversight.

**Carried.** A `<Stat>`: "Carried out of the period" with the period's
`carriedMinor`, signed. When negative, an explanatory line renders beneath it
(`carriedNegative`): "Negative: this period paid out premium it collected
earlier. Ordinary, and not a client-money breach — the segregation bar below is
what says whether client money is whole." No such explanation renders when the
figure is zero or positive.

**Client money segregation.** Always titled ("Client money segregation"), one
row per currency when the actor holds `ledger:client_money:read`: currency
code, Cash held, Owed to clients, Margin (all `<Money>`, margin signed), a Badge
("Whole" / "Short", success/danger tone), then two stacked bars sharing one
scale — cash held over what is owed — with the liability track turning
`bg-flare-500` the moment `breach` is true (else `bg-vega-600`). Without the
permission: same section, same title, one sentence explaining it is hidden
(`seg.denied`) — the map above is unaffected.

**Drill-through.** Clicking a drillable node navigates to `?node=<key>` (filters
kept, e.g. `?period=2026-07&node=tax`). This opens a **Journal lines behind this
node** section: a caption naming the node, a total (`<Money>` of
`drilled.totalMinor`), a **Close** ghost-button link back to the un-noded URL,
and a `<Table density="compact">` of every line: Posted (`<DateTime>`,
minute precision), Transaction (type), Transaction id, Account, Side (mapped
through `side.debit`/`side.credit`), Amount (`<Money>`), Memo (or "—"). Empty:
"No lines in this period."

**States.** *Empty* (no nodes at all): "Nothing was posted in this period",
replacing the diagram section entirely. *Denied*: the whole-screen EmptyState
above. *Loading*: the Apply button `loading` while navigation is in flight (this
is a GET form, so every filter change and every node click is a full loader
round-trip, not a client-side re-render).

**AI surfaces.** None. The headline, breach flag and every figure on the page
are loader data straight from the ledger's own summary endpoint — the code's
own comment (quoted above) is explicit about withholding the ✦ marker for
exactly this reason.

**Actions and consequences.** None of this screen writes anything.
Every interaction — filtering, clicking a node, closing the drill — is a `GET`
navigation. There is no form that posts, no confirm dialogue, nothing to
reverse.

**Mobile.** Web only. Not in the Expo app's generic `ledger/txns` list (see
Orientation) — no mobile equivalent exists.

**RTL.** The diagram section is always `dir="ltr"` (see above, a documented
exception). Everything outside it — the headline, the breach list, the
segregation bar, the drill-through table — follows the page's own direction
normally. The `type="month"` filter input is a native browser widget and stays
LTR by platform convention, matching Foundations' rule for currency and code
inputs.

**What is weak today.**
1. **The diagram's per-node text is invisible to assistive technology.** The
   `<svg>` carries `role="img"` with one `aria-label` — the page title
   ("Money map") — and an ARIA `img` role conventionally removes its children
   from the accessibility tree in favour of that single label. The six node
   names and their amounts are plain `<text>` elements inside that subtree, so
   a screen-reader user hears "Money map" and nothing else: not "Insurer
   remittance", not any figure. The data the diagram exists to show is not
   exposed outside the visual rendering.
2. **Node label placement does not account for text length.** `layoutMap()`
   positions each node's name and amount at a fixed `x`/`y` offset computed
   purely from pixel geometry — there is no text measurement, wrapping or
   reserved width for the label. The Arabic labels (e.g. "التحويل إلى
   المؤمِّن" for "Insurer remittance") are visibly longer than their English
   counterparts; nothing in the layout code accounts for that, so a redesign
   or a future node with a longer name has no guard against overlap or
   clipping.
3. Clicking a node to open the drill-through does not move focus into the new
   "Journal lines" section — a keyboard or screen-reader user who activates the
   link has to find the newly-appeared content themselves; nothing announces it
   or receives focus.
4. The `currency` filter is free text with no validation against a real
   currency list, the same pattern already noted on the open-transaction screen
   (§2).
5. `carriedNegative`'s explanation only appears for a negative figure; a reader
   seeing "Carried out of the period" with a positive or zero amount has no
   equivalent one-line gloss for what "carried" means.

---

## 9. `/ledger/year-end` — Year-end close

**Route + title.** `apps/web/app/routes/ledger-year-end.tsx`. Title: "Year-end
close" (`ye.title`). Intro (`ye.intro`): "One entry zeroes every income and
expense account into retained earnings. The lines are read out of the journal,
not typed: what is previewed here is exactly what posts."

**Who sees it.** `ledger:journals:read` to view — denied renders the standard
EmptyState naming that permission. Posting is a separate, narrower permission:
`ledger:periods:year_end` (`loaded.canPost`), held by **finance.director** and
**finance.controller** (see Foundations). Without it, the screen still shows the
full preview; the Post button is simply absent.

**Purpose.** Preview and, with the right permission, post the single entry that
zeroes every income and expense account for a fiscal year into retained
earnings.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Year-end close                                          (h1) │
│ One entry zeroes every income and expense account …          │
├──────────────────────────────────────────────────────────────┤
│ Fiscal year [2026]  [Apply]                                   │
├──────────────────────────────────────────────────────────────┤
│ Fiscal year 2026 nets R 412 000,00.                            │
│ ┌ KPI wall ──────────────────────────────────────────────────┐│
│ │ Income          Expense          Result for the year        ││
│ │ R 900 000,00    R 488 000,00     R 412 000,00                ││
│ └────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────┤
│ ┌ The entry that would post ────────────────────────────────┐│
│ │ Account │ Side   │ Amount                                  ││
│ │ 4000    │ Debit  │ R 900 000,00                             ││
│ │ 5000    │ Credit │ R 488 000,00                             ││
│ │ 3100    │ Credit │ R 412 000,00                             ││
│ └────────────────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────────────┤
│ [ Close every month of the year first ─ only when blocked ]   │
├──────────────────────────────────────────────────────────────┤
│ [Post the close]              [Go to period close]            │
└──────────────────────────────────────────────────────────────┘
```

**Year selector.** A GET `<Form>`: Input `year`, defaulting to
`String(new Date().getUTCFullYear())`, validated client-side against
`/^\d{4}$/` before it is trusted (an unmatched value falls back to the current
year rather than being sent as-is). **Apply**.

**Preview.** Fetched from `GET /v1/ledger/year-end/:year` on every load —
`{fiscalYear, currency, incomeMinor, expenseMinor, netMinor,
retainedEarningsAccount, closingLines}`. Rendered as a `<KPIWall>` of three
figures (Income, Expense, "Result for the year") and, beneath it, a captioned
table of `closingLines`: Account, Side (Debit/Credit), Amount — **exactly the
lines that will post**, read out of the journal rather than computed or typed
on this screen. Nothing to close (`closingLines.length === 0`) renders "Nothing
to close" / "No income or expense account carries a balance for this year, so
there is no closing entry to post." instead of the table.

**Post.** Rendered only when `closingLines.length > 0 && loaded.canPost`. One
button, "Post the close" (`ye.post`), a confirm: "Post the year-end close? It
needs a second seat's approval, and once it settles the year's result sits in
retained earnings." A ghost-button link, "Go to period close" (`ye.toPeriods`),
always sits beside it regardless of `canPost` — the screen's own acknowledgment
that this entry cannot post into open months.

**The POST itself.** `action()` sends `POST /v1/ledger/year-end/:year` with an
**empty body** (`{}`) and no client-side idempotency key — unlike the manual
journal (§10), there is nothing for a double-submit to duplicate: the server
mints a fixed natural key per fiscal year (`yearend:<year>`) rather than trusting
one from the browser.

**States.** *Success*: "Fiscal year {year} is closed. The result now sits in
{account}." (`ye.posted`). *Blocked on open months*: the action's error handler
does a **substring match** on `String(result.problem.detail ?? "").includes("open
periods")` — if true, an extra hint renders: "Close every month of the year
first" / "The year-end entry posts into months that are already frozen. Soft
close each month on the period-close screen, then come back." (`ye.prereq` /
`ye.prereqBody`), on top of whatever the API's own Problem already showed.
*Any other failure, including the routine approval-gated response* (see below):
a plain `<Problem>` alert. *Denied*: the whole-screen EmptyState.

**AI surfaces.** None.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible |
|---|---|---|---|---|
| Post the close | Yes — the previewed lines post as one batch, `retainedEarningsAccount` taking the balancing leg | Server-minted natural key `yearend:<year>`, not client-supplied | `ledger:periods:year_end` (`YEAR-END-CLOSE`'s policy key is `ledger.year_end_close`) — **dual control is always on for this type**, so even a `finance.director`'s or `finance.controller`'s first POST comes back `403 approval_required`, not a settled txn (`apps/api/src/ledger-journals.test.ts:223`, via the same `throughApproval` helper used for the manual journal) | Never by deletion; a reversal is a separate contra transaction, same rules as any other posted batch |

**Mobile.** Web only.

**RTL.** The fiscal year (`2026`) and account codes stay LTR by Foundations'
convention. Everything else follows the page direction normally.

**What is weak today.**
1. **The routine approval-gated response renders as a plain danger alert, not
   as a queued-for-approval notice.** `YEAR-END-CLOSE` always requires
   approval (see the Actions table above) — a director or controller posting
   the close will, on the very first submission, get back `{code:
   "approval_required", status: 403, detail: "ledger.year_end_close"}`. This
   route imports only `Problem` from `./module`, not the `Gate` component
   (`apps/web/app/routes/module.tsx`) that exists specifically to tell an
   approval-gated refusal apart from a real failure — `Gate` renders a
   warning-toned "queued, nothing has happened yet" card with a link to
   `/approvals`; `<Problem>` renders a `role="alert"` danger box showing
   `problem.detail ?? problem.title`, which for this response is the bare
   string `ledger.year_end_close`. The screen's own copy elsewhere (`ye.posted`
   with its "needs a second seat's approval" confirm text) shows the design
   knew approval was coming; the error path does not reflect that.
2. The `.includes("open periods")` substring match on the Problem's `detail`
   is a fragile coupling to the API's exact English wording — a copy change on
   the API side silently drops the "close every month first" hint with no
   compile-time signal.

---

## 10. `/ledger/journal` — Manual journal

**Route + title.** `apps/web/app/routes/ledger-journal.tsx`. Title: "Manual
journal" (`mj.title`). Intro (`mj.intro`): "A hand-written entry for what no
transaction type covers — an accrual, a correction, a reclass. It never posts
on the drafter's word alone: a second seat approves it." The file's own header
comment (docs/27 F2): "The one instrument that can express any entry, so the
screen's whole job is to make the two things it cannot express visible before
someone types them: client money and equity."

**Who sees it.** `ledger:journals:draft` **or** `ledger:txns:create` —
`finance.analyst` holds the former (and not the latter, deliberately: rbac.ts's
own comment reads "Drafts a manual journal but cannot post it — deliberately
not `ledger:journals:post`, which is the whole point of the split");
`finance.controller` holds `ledger:txns:create` outright. Denied: EmptyState
naming `ledger:journals:draft`.

**Purpose.** Compose and submit a balanced multi-line journal entry by hand,
for whatever no transaction-type recipe covers.

**Layout skeleton.**

```
┌──────────────────────────────────────────────────────────────┐
│ Manual journal                                          (h1) │
│ A hand-written entry for what no transaction type covers …   │
│ Client-money and equity accounts are out of reach here …     │
├──────────────────────────────────────────────────────────────┤
│ Why this entry exists [────────────────────────────── req'd] │
│ ┌ Lines ───────────────────────────────────────────────────┐ │
│ │ Account[4000] Side[Debit▾] Amount[R 900,00] Memo[──] [×] │ │
│ │ Account[5000] Side[Credit▾] Amount[R 900,00] Memo[──] [×]│ │
│ │ [Add a line]                                              │ │
│ └────────────────────────────────────────────────────────────┘│
│ Total debits R 900,00    Total credits R 900,00               │
│ The entry balances. / Debits and credits do not agree yet …   │
│ [Send for approval]                                            │
└──────────────────────────────────────────────────────────────┘
```

**The form.** `reason` (Input, `maxLength=500`, hint "At least ten characters.
It is what an auditor reads first."). A dynamic grid of line rows
(`MIN_LINES = 2` at start, **Add a line** / **Remove this line** per row, the
last two rows never droppable below the minimum): each row is Account
(`accountCode`, Input, hint "Four digits"), Side (Select, Debit/Credit), Amount
(`MoneyField`, `amountMinor`), Memo (optional Input). Beneath the grid: Total
debits, Total credits, "Out by {amount}" or "The entry balances." /
"Debits and credits do not agree yet, so this cannot be submitted."
(`mj.difference` / `mj.balanced` / `mj.unbalanced`). Totals are **recomputed
from the live `FormData`**, not mirrored in component state — the code's own
comment: "a second copy of that arithmetic here is a second answer." Submit —
"Send for approval" (`mj.submit`) — via `<ConfirmButton>`, `disabled={!balanced}`,
confirm copy: "Send this entry for approval? It posts to the ledger the moment
a second seat approves it."

**What this form refuses to let anyone type.** Client-money and equity accounts
are named out of bounds in the intro copy itself (`mj.forbidden`): "Client-money
and equity accounts are out of reach here: client money moves through its own
transaction types, and equity moves at the year-end close." The form has no
client-side check for this — the account-code field accepts anything — the
sentence is the entire enforcement on this screen; the real rule lives
server-side in the recipe/precondition layer.

**The POST itself.** `POST /v1/ledger/txn/MANUAL-JRNL` with
`{idempotencyKey: `mj:${crypto.randomUUID()}`, args: {lines, reason}}`. The
key is minted **inside the server-side `action` function**, once per action
invocation — not once per form render the way the generic open-transaction
screen (§2) does it. See the weak note below for what that means for a
double-submit.

**States.** *Success, settled*: "Posted as {id}." (`mj.settled`) — only reachable
once a second seat has already approved the same request and it is being
replayed. *Success, sent*: "Sent for approval. It posts when a second seat
approves it." (`mj.sent`) — branches on `result.txn.state`. *The routine first
submission*: see the weak note below — this is not actually a success state on
first send. *Denied*: EmptyState. *Loading*: submit `loading`.

**AI surfaces.** None. Every figure on the page is what was typed into the form.

**Actions and consequences.**

| Action | Posts? | Idempotency | Approval | Reversible |
|---|---|---|---|---|
| Send for approval | Only once approved — the first call always requests approval, never settles on its own | `mj:<uuid>` minted fresh inside the action on every invocation — **not deduplicated against a prior press the way the natural-key screen (§2) is** | `ledger:journals:draft` is enough to *originate* it (`def.approval && can(...draft)` shortcut, `apps/api/src/routes/ledger.ts:87-91`, docs/27 F2); **dual control is always on** for `MANUAL-JRNL` (policy key `ledger.manual_journal`) — the first POST from any actor, drafter or controller, comes back `403 approval_required` (`apps/api/src/ledger-journals.test.ts:133`, via `throughApproval`) | Never by deletion; once settled, reversal follows the same contra-batch rule as any transaction |

**Mobile.** Web only.

**RTL.** The Arabic `mj.*` labels exist for every field on this screen. Account
codes stay LTR by Foundations' convention.

**What is weak today.**
1. **The routine approval-gated response renders as a bare policy-key string in
   a danger alert, not as a queued notice.** Because dual control is always on
   for `MANUAL-JRNL`, the *expected* outcome of a normal, correct submission —
   balanced lines, a good reason, a permitted actor — is a `403
   approval_required` on the first send. This route imports only `Problem`
   from `./module`, never `Gate`; `<Problem>` shows `problem.detail ??
   problem.title`, and for this response `detail` is the literal string
   `ledger.manual_journal` — the policy key, unexplained, in a red
   `role="alert"` box, with no link to `/approvals` and no reassurance that the
   entry was in fact captured. The `mj.sent` copy ("Sent for approval. It posts
   when a second seat approves it.") that the screen is clearly designed to
   show for exactly this moment never actually renders on a first submission —
   it is only reachable if `result.txn` comes back non-null, which the
   approval-gated path does not do; it throws instead. Practically: an analyst
   filling in their first manual journal sees what reads as a rejection, for
   a request that in fact went through and is sitting in the approvals queue
   waiting on a controller.
2. **The idempotency key is generated fresh on every invocation of the
   server-side `action`, not once per form render.** The generic open-transaction
   screen (§2) explicitly mints its key once, server-side, at render time,
   with a code comment explaining why: a key generated at submit time is a new
   key on every press, which is exactly the double-post the header exists to
   prevent. This screen does the opposite — `idempotencyKey:
   \`mj:${crypto.randomUUID()}\`` is computed inside `action()`, so it is a new
   value on every action call. `<ConfirmButton>` disables its trigger only
   after the confirm dialog is accepted and the request is in flight
   (`apps/web/app/components/confirm.tsx`); a double-click or a fast double-tap
   before that disable takes effect can fire two action invocations, each with
   its own key, and the API's `(tenant, type, idempotencyKey)` uniqueness check
   will not catch it — two distinct journal entries can post for one intended
   submission.
3. The account-code field for client-money and equity accounts is not actually
   blocked or even warned against inline — the whole safeguard is a sentence
   in the intro (`mj.forbidden`); a user who does not read it finds out only
   after submitting.
4. No running preview of what the entry means in plain terms (e.g. "moves R900
   from 4000 to 5000") — only the raw account codes and the balance check.

---

## Cross-cutting notes for a redesign

**The one thing to fix first.** Build the drill-through. A trial-balance row →
the journal lines behind it → the transaction that posted them → the account
statement. Every piece already exists as a separate screen; nothing links them.
Today a controller who wants to know what makes up a number opens a second tab
and retypes an account code.

**The second.** The open-transaction form's `args` textarea was since replaced
with per-field inputs (§2) — the remaining gap there is narrower: an
array-typed recipe argument still has no field type and falls back to raw
JSON. The recon form's `lines` was never JSON; it takes pasted CSV/TSV with a
live preview (§6). What is still worth fixing is the approval-gated screens
(§9, §10): a normal first submission comes back `403 approval_required` and
renders as a raw policy-key string in a danger alert instead of the
`Gate`-style "queued, see /approvals" notice that §2's own hand-rolled
equivalent already gives that same response.

**Do not build.** The unmasked-export UI does not exist —
`analytics:exports:unmasked` is held by `finance.controller` and nothing renders
it. If a design adds it, it needs its own approval story, and that is an ADR, not
a screen.

**A seed-data trap.** The demo tenant's December client-money check
(asset 498 300, liability 512 400, shortfall 14 100, breach, resolved) **predates
the seeded postings and does not tie to the trial balance.** It is there to show
the breach state, not to reconcile. A design review that walks the demo data will
find this and should not treat it as a bug in the screens.

**Invariants that may never be relaxed.** Every batch balances in both the
transaction currency and the base currency. Money-affecting state is never
written directly — always through a transaction with an idempotency key, a state
machine and, where the type demands it, an approval. Reversal is a contra batch
carrying `reversalOfBatchId`; nothing in this module deletes anything. These are
property-tested. No design may introduce a screen that implies otherwise — no
"edit this posting", no "delete this line", no "adjust the balance".

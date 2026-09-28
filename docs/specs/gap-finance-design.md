# FINANCE — accrual broking ledger, open items, cash application, close

Closes **F2, F3, F14, F15, F16, F17, F18, F19, F20, F21, F22** from
`docs/27-feature-gap-register.md`.

Scope: `packages/db` (schema + chart of accounts), `packages/ledger`
(types, recipes, posting, periods, recon, reports, engine), `packages/core`
(rbac, approvals, commission), `apps/api/src/routes/ledger.ts`,
`apps/web/app/routes/ledger-*.tsx`, `packages/model-gateway/evals/ledger/*`.

Out of scope, named so nobody thinks they were forgotten: tenant-editable chart
of accounts, tiered/sliding commission scales, producer statements, bordereaux,
budget-vs-actual, cash-flow statement, fixed assets. Those are the P2 depth
findings and each needs its own spec. This one closes the P0/P1 finance block.

## Governing constraints (`CLAUDE.md`)

| # | Constraint | How it binds this design |
|---|---|---|
| 1 | Tenancy first | Every new table carries `tenant_id`; every read goes through `scoped(ctx, …)`. The four new tables' unique indexes all lead with `tenant_id`. |
| 2 | One schema, two homes | SQLite dialect only. No window functions in the aging or revaluation queries; aggregation happens in TypeScript over a bounded row set. No `RETURNING` reliance. |
| 3 | Model access only via `packages/model-gateway` | `packages/ledger` keeps its **zero** model-gateway dependency. Every AI surface here is an injected function type (as `MatchProposer` already is) or lives in the route layer. |
| 4 | Human in the loop | Nine new/amended approval policies, six of them `neverAutoApprove`. |
| 5 | Brand tokens | No screen hard-codes a brand string. |
| 6 | Events over calls | Six new event types on `lyra-events`; no new cross-module import. |
| 7 | RTL + i18n | Every new chart row carries `en` **and** `ar`. Every new column label is an i18n key. Aging buckets are logical-ordered, not left-to-right-ordered. |
| 8 | WCAG 2.2 AA | Aging and variance status is never colour-only: each carries a text label and an icon. |
| 9 | Forward-only migrations | Six migrations, ordered in §B.5. None edits an applied one. |
| 12 | Transaction integrity (docs/19) | Every new money movement is a `TXN_TYPES` row + a `RECIPES` row with an idempotency key and a state machine. No new posting path. |
| 14 | Domain-pack vocabulary | "premium", "insurer", "policy" never appear in a UI string or a system prompt. Chart rows keep their accounting names (they are ledger identifiers, not user copy); screens label them through `labelsFrom(...)(locale, pack)`. |
| 15 | Build to the seams | Client-money account membership becomes a **derived set** off the chart's `clientMoney` flag rather than two constants; tax and FX become **resolvers** in front of pure recipes. |

Post-F1 constraint, load-bearing everywhere below: `post()` assembles one write
set and hands it to `atomically()`. There is no interactive transaction on
either home. **Every validating read happens before the write set is
assembled.** Nothing in this design reads inside a write, and nothing in this
design writes twice.

---

## 0. Decisions

**D1 — No new posting path.** Every new money movement is a tuple in
`TXN_TYPES` plus a row in `RECIPES`. Eleven new transaction types, zero new
`ctx.db.insert(ledgerJournalLines)` call sites.
*Rejected:* a "journal service" that writes lines for manual entries. It would
be a second write path and would immediately be the thing that bypasses
`clientMoneyCheck`.

**D2 — Read-decide-then-write, enforced by shape.** Tax rule resolution, FX
rate resolution, open-item allocation, metric-snapshot verification and
year-end balance gathering are all **reads** that complete before
`buildRecipe`. Their outputs are (a) recipe args and (b) extra rows appended to
the same write set. No post-commit hook, no second call.
*Rejected:* a queue-consumer that projects open items after the fact. It would
be eventually consistent with the ledger, and an aging report that disagrees
with the trial balance is worse than no aging report.

**D3 — Exactly one new mechanism: `TXN_PRECONDITIONS`.** A registry, keyed by
transaction type, of async validators run inside `runTxn` before the recipe is
built:

```ts
// packages/ledger/src/preconditions.ts
export type Precondition = (ctx: Ctx, args: Record<string, unknown>) => Promise<void>;
export const TXN_PRECONDITIONS: Record<string, Precondition[]> = { … };
```

It serves `MANUAL-JRNL`, `OPEN-BAL`, `YEAR-END-CLOSE`, `FX-REVAL`,
`CASH-APPLY`, `WRITE-OFF` and `SUCCESS-FEE` (F21). It is table-driven for the
same reason `RECIPES` is: a precondition is a row, never a branch.
*Rejected:* seven `if (type === …)` guards in `runTxn`.

**D4 — Open items are a projection written inside the same batch, not a query
over journal lines.** A journal line has no due date, no counterparty identity
beyond a free-text dim, and no notion of partial settlement.
*Rejected:* extending `agedBalances()` (`packages/ledger/src/reports.ts:411`)
to read `dueAt`. There is nowhere for it to read it from.

**D5 — Equity is posted from the first year-end close onward.** `3000` /
`3100` / `3200` become real accounts; `YEAR-END-CLOSE` posts income and expense
into `3100`. Before a tenant's first close, `balanceSheet` shows a *labelled*
unposted current-year line so the statement still balances.
*Rejected:* keeping the derived plug (`reports.ts:383`). It is the reason
`closePeriod` can only flip a status, and it makes retained earnings
un-auditable.

**D6 — Tax is resolved, never passed.** `taxPpm` stops being a free parameter.
Callers pass a `taxRuleId` (or an explicit `taxExemptReason`); the resolver
reads `ledger_tax_rules`, and the resolved rule id + rate is stamped into the
transaction's `metadata_json` and every tax line's `dims`.
*Rejected:* looking the rule up inside the recipe. Recipes are pure and
synchronous; making one async would make all of them async.

**D7 — FX revaluation is cumulative-to-date, not reverse-and-repost.** Each
open item carries `base_revalued_minor` and `last_revalued_period`; a
revaluation posts only the *delta* since the last one. No reversing job exists
to fail halfway.
*Rejected:* month-end reverse + month-start repost. Two write sets where one
will do, and it puts a reversal in a period that may already be hard-closed.

**D8 — Bank-import duplicate defence is a DB unique index.** `uniqueIndex` on
`(tenant_id, account_code, line_ref)`, where `line_ref` is the statement's own
end-to-end identifier (or a deterministic hash when the format has none).
Re-uploading the same file is a no-op by construction.
*Rejected:* an application-side "have I seen this file" check. Ladder rung 4:
a DB constraint beats app code, and it is the only version that survives two
concurrent uploads.

**D9 — Insurer-statement matching posts through `runTxn`.** `decideMatch`
gains a posting step that calls `runTxn(ctx, "CMSN-SETL", …)` with idempotency
key `recon:{matchId}`. It never writes a line.
*Rejected:* posting from the route handler. `decideMatch` has three callers
(route, bulk confirm, close run); the gate belongs where they all pass.

**D10 — Close gates go inside `closePeriod` / `reopenPeriod`, not at the
route.** `periods.ts:174` and `periods.ts:199` are the root cause; the route is
one caller of several (close run, year-end, tests, future scheduler).

**D11 — A success fee needs a countersigned metric snapshot.** *Built*
(ADR-0111): `ledger_metric_pins`, `packages/ledger/src/metric-pins.ts`, key
`success-fee:{pinId}` — leaner than §B.1's `ledger_fee_metric_snapshots`, see
the ADR for what was deferred. A new table
holds a *pinned copy* of the `north_snapshots` row plus a `source_hash`; both
parties countersign; the fee's idempotency key is derived from the snapshot id,
so one snapshot can bill exactly once.
*Rejected:* reading `north_snapshots` live at posting time. The number would be
free to move after sign-off, which is precisely the fraud the control exists to
stop.

**D12 — The chart stays a TypeScript constant.** Eight new rows are added to
`CHART_OF_ACCOUNTS`. Making it tenant-extensible (as `docs/19 §5.1` already
promises) is a real gap but a separate one — see §S.
*Rejected:* doing it here. It would double the size of this change and every
feature below works without it.

**D13 — `fast-check` becomes a devDependency** of `packages/ledger` and
`packages/core`. It is the only new dependency in this spec, and it exists to
close F22, which cannot be closed with seeded-LCG fuzz.

**D14 — Five of the eleven features get no AI at all.** F3, F17, F18, F20 and
F22 are deterministic obligations. Adding a model to any of them would add a
failure mode and remove a guarantee. §Q says so explicitly per feature, because
"we considered it and said no" is a design output.

---

## A. Role design

### A.1 New permission keys

Appended to `PERMISSIONS` in `packages/core/src/rbac.ts` after the existing
ledger block (`rbac.ts:148-157`):

```ts
  // ledger — manual journals & equity (F2, F3)
  "ledger:journals:draft", "ledger:journals:void",
  "ledger:periods:force_close", "ledger:periods:reopen", "ledger:periods:year_end",

  // ledger — open items & collections (F15)
  "ledger:openitems:read", "ledger:openitems:write",

  // ledger — bank statements & cash application (F16)
  "ledger:bank:read", "ledger:bank:import",
  "ledger:cash:apply", "ledger:cash:writeoff",

  // ledger — tax & FX reference data (F17, F18)
  "ledger:tax:read", "ledger:tax:write",
  "ledger:fx:read", "ledger:fx:write", "ledger:fx:revalue",

  // ledger — success-fee metric snapshots (F21)
  "ledger:fees:read", "ledger:fees:snapshot", "ledger:fees:countersign",
```

Eighteen keys. Naming follows the existing `module:resource:action` shape; no
key uses a domain-pack noun.

Three deliberate splits:

- `ledger:journals:draft` ≠ `ledger:journals:post`. An analyst prepares, a
  controller posts. Without the split, the orphaned `ledger.manual_journal`
  policy has nobody who can initiate but not authorise.
- `ledger:periods:force_close` ≠ `ledger:periods:close`. Overriding a failing
  checklist is a different act from closing a clean month.
- `ledger:cash:writeoff` ≠ `ledger:cash:apply`. Applying cash moves an existing
  balance; writing off destroys one.

### A.2 Role bundles

`readsOf("ledger")` (`rbac.ts:210-212`) filters `PERMISSIONS` for
`ledger:*:read`, so `finance.analyst` picks up `ledger:openitems:read`,
`ledger:bank:read`, `ledger:tax:read`, `ledger:fx:read` and `ledger:fees:read`
with no edit. `finance.controller` holds `ledger:*:*` (`rbac.ts:464`) and picks
up **all eighteen** with no edit — which is why the approval layer, not the
permission layer, is what actually restrains a controller.

| Role | Adds | Deliberately does **not** get |
|---|---|---|
| `finance.analyst` (`rbac.ts:458`) | `ledger:journals:draft`, `ledger:openitems:write`, `ledger:bank:import`, `ledger:cash:apply`, `ledger:fees:snapshot` (plus the five reads, free via `readsOf`) | `ledger:journals:post`, `ledger:cash:writeoff`, `ledger:tax:write`, `ledger:fx:write`, `ledger:fx:revalue`, `ledger:periods:*`, `ledger:fees:countersign` |
| `finance.controller` (`rbac.ts:463`) | everything, via `ledger:*:*` — no edit to the bundle | — (restrained by policy, see A.3) |
| **`finance.director`** *(new)* | `...readsOf("ledger")`, `core:approvals:read`, `core:approvals:decide`, `ledger:journals:post`, `ledger:periods:close`, `ledger:periods:force_close`, `ledger:periods:reopen`, `ledger:periods:year_end`, `ledger:cash:writeoff`, `ledger:payouts:approve`, `ledger:invoices:approve`, `ledger:client_money:transfer`, `ledger:fees:countersign`, `analytics:*:read`, `analytics:reports:run`, `analytics:exports:create`, `analytics:exports:download` | `ledger:txns:create`, `ledger:journals:draft`, `ledger:bank:import`, `ledger:cash:apply`, `ledger:tax:write`, `ledger:fx:write` |
| `tenant.admin` (`rbac.ts:242`) | unchanged | — |
| `north.exec` (`rbac.ts:426`) | `ledger:fees:read` (free via its existing `ledger:*:read`) | any write |

`finance.director` exists because dual control needs a second seat that is
*only* a second seat. It cannot initiate any of the transactions it authorises:
no `ledger:txns:create`, no `ledger:journals:draft`, no `ledger:bank:import`.
That makes separation of duties a property of the role graph, not of who
happens to be logged in.

A tenant with only one finance seat cannot post a manual journal, force a
close, reopen a period or pay a success fee. That is the correct outcome and it
is `needsDualControl` failing closed (`packages/core/src/approvals.ts:165-171`),
not a bug. Onboarding must surface it: see §T.

### A.3 Approval policies

Amendments and additions in `APPROVAL_POLICIES`
(`packages/core/src/approvals.ts:42-135`):

```ts
  // EXISTING, now finally reachable (approvals.ts:51) — no change needed
  policy({ key: "ledger.manual_journal", module: "ledger",
           decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true }),

  // EXISTING (approvals.ts:50) — unchanged; covers the clean close only
  policy({ key: "ledger.period_close", module: "ledger",
           decide: "ledger:periods:close", dualControl: "above_threshold" }),

  // NEW
  policy({ key: "ledger.period_close_force", module: "ledger",
           decide: "ledger:periods:force_close", dualControl: "always", neverAutoApprove: true }),
  policy({ key: "ledger.period_reopen", module: "ledger",
           decide: "ledger:periods:reopen", dualControl: "always", neverAutoApprove: true }),
  policy({ key: "ledger.year_end_close", module: "ledger",
           decide: "ledger:periods:year_end", dualControl: "always", neverAutoApprove: true }),
  policy({ key: "ledger.opening_balance", module: "ledger",
           decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true }),
  policy({ key: "ledger.write_off", module: "ledger",
           decide: "ledger:cash:writeoff", dualControl: "above_threshold",
           defaultThresholdMinor: 250_00, neverAutoApprove: true }),
  policy({ key: "ledger.fx_revaluation", module: "ledger",
           decide: "ledger:fx:revalue", dualControl: "above_threshold",
           defaultThresholdMinor: 10_000_00 }),
  policy({ key: "ledger.tax_rule_change", module: "ledger",
           decide: "ledger:tax:write", dualControl: "always", neverAutoApprove: true }),
  policy({ key: "ledger.fee_snapshot_countersign", module: "ledger",
           decide: "ledger:fees:countersign", dualControl: "always", neverAutoApprove: true }),
```

Nine policies; one of them (`ledger.manual_journal`) already exists and is only
being wired up.

Notes that matter:

- `ledger.period_close_force` and `ledger.period_reopen` pass
  `amountMinor: undefined` deliberately. `needsDualControl` fails closed on an
  unstated amount (`approvals.ts:165-171`), and `dualControl: "always"` makes
  that explicit rather than incidental.
- `ledger.fx_revaluation` is the only new policy that is **not**
  `neverAutoApprove`. Revaluation posts a mechanical delta from a rate the
  tenant already loaded; a tenant that has put it on its `autoApprove`
  allowlist has made a defensible choice. Above 10,000.00 (minor units) it
  still takes two people, because a large delta usually means a bad rate.
- `ledger.tax_rule_change` gates *reference data*, not a posting. It is the
  only policy in the codebase that gates a non-transaction, and it earns that
  because a wrong `rate_ppm` silently mis-states every subsequent invoice.
- `ledger.write_off` threshold is per-write-off, not per-batch. Bulk write-off
  from the recon screen calls `gate()` once per item; there is no "approve 200
  small ones as one big one" path, because that is how a threshold gets
  defeated.
- `ledger.success_fee` (`approvals.ts:49`) is unchanged. F21 is enforced by a
  precondition, not by a new policy — approval and precondition are different
  controls and stacking them is the point.

### A.4 Authority limits

Thresholds resolve as they do today: policy `defaultThresholdMinor` unless the
tenant's policy row overrides it. No new mechanism. Recommended defaults ship
in the tenant seed:

| Policy | Default threshold (minor) | Rationale |
|---|---|---|
| `ledger.write_off` | 250_00 | below a bank charge's worth, one person may clear it |
| `ledger.fx_revaluation` | 10_000_00 | a delta this size implies a rate error |
| `ledger.credit_note` | 1_000_00 (existing) | unchanged |
| `ledger.period_close` | none (existing `above_threshold` with no amount ⇒ dual control) | closing a month is never solo |

### A.5 Dual-control matrix

| Action | Initiator permission | Approver permission | Dual control | Auto-approvable |
|---|---|---|---|---|
| Draft manual journal | `ledger:journals:draft` | — | no | n/a |
| Post manual journal | `ledger:journals:draft` | `ledger:journals:post` | always | never |
| Post opening balance | `ledger:journals:draft` | `ledger:journals:post` | always | never |
| Year-end close | `ledger:periods:year_end` | `ledger:periods:year_end` | always | never |
| Close period (clean) | `ledger:periods:close` | `ledger:periods:close` | above threshold | yes |
| Force close (failing checks) | `ledger:periods:close` | `ledger:periods:force_close` | always | never |
| Reopen period | `ledger:periods:close` | `ledger:periods:reopen` | always | never |
| Book accrued premium | `ledger:txns:create` | — | no | n/a |
| Credit an accrual | `ledger:txns:create` | `ledger:invoices:approve` | above threshold | never |
| Import bank statement | `ledger:bank:import` | — | no | n/a |
| Apply cash | `ledger:cash:apply` | — | no | n/a |
| Write off a residual | `ledger:cash:apply` | `ledger:cash:writeoff` | above threshold | never |
| Change a tax rule | `ledger:tax:write` | `ledger:tax:write` | always | never |
| Load an FX rate | `ledger:fx:write` | — | no | n/a |
| Run FX revaluation | `ledger:fx:revalue` | `ledger:fx:revalue` | above threshold | yes |
| Confirm a recon match | `ledger:recon:confirm` | — | no | n/a |
| Confirm with variance > tolerance | `ledger:recon:confirm` | `ledger:cash:writeoff` | above threshold | never |
| Create fee snapshot | `ledger:fees:snapshot` | — | no | n/a |
| Countersign fee snapshot | `ledger:fees:snapshot` | `ledger:fees:countersign` | always | never |
| Post success fee | `ledger:invoices:create` | `ledger:invoices:approve` | always (existing) | never |

Applying cash is deliberately single-control. It moves an existing receivable
to an existing bank balance; it cannot create money, cannot cross the
client-money boundary in the wrong direction, and every application is
reversible by contra. Gating it would put a controller in the path of the
highest-volume daily task in a broking back office, which is how organisations
end up sharing a login.

---

## B. Schema

### B.1 New tables

All in `packages/db/src/schema/ledger.ts`, following the file's existing
conventions (text ids, integer epoch-ms timestamps, `_json` suffix for
serialised blobs, minor units as integers).

#### `ledger_open_items` (F15, F18)

The subledger. One row per receivable or payable *document*, written in the
same `atomically()` write set as the batch that created it.

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `id("oi", now)` |
| `tenant_id` | text not null | |
| `kind` | text not null | `receivable` \| `payable` |
| `account_code` | text not null | must match a chart row whose type agrees with `kind` |
| `counterparty_kind` | text not null | `client` \| `provider` \| `partner` \| `creator` \| `publisher` \| `financier` \| `other` — the docs/21 seam; no domain noun |
| `counterparty_ref` | text not null | e.g. `provider:prv_123` |
| `document_ref` | text not null | invoice number, statement ref, agreement ref |
| `origin_txn_id` | text not null | the transaction that opened it |
| `origin_batch_id` | text not null | |
| `currency` | text not null | |
| `amount_minor` | integer not null | signed positive; direction implied by `kind` |
| `settled_minor` | integer not null default 0 | sum of allocations |
| `written_off_minor` | integer not null default 0 | |
| `base_amount_minor` | integer not null | at origin rate |
| `base_revalued_minor` | integer not null | cumulative base value after the last revaluation (D7) |
| `last_revalued_period` | text | `YYYY-MM`, null until first revaluation |
| `issued_at` | integer not null | |
| `due_at` | integer not null | **the column F15 needs and no journal line has** |
| `state` | text not null | `open` \| `part_settled` \| `settled` \| `written_off` \| `disputed` |
| `disputed_reason` | text | |
| `collection_note` | text | |
| `dims_json` | text | copied from the originating line's dims |
| `created_at` / `updated_at` | integer not null | |

Indexes:
`uniqueIndex ledger_open_items_doc_uq (tenant_id, kind, account_code, document_ref)`
— the same document cannot be opened twice, at the DB not in app code.
`index ledger_open_items_due_idx (tenant_id, kind, state, due_at)` — the aging
query's only access path.
`index ledger_open_items_cp_idx (tenant_id, counterparty_ref, state)`.

`state` is derived on write, never stored independently of the numbers:
`settled_minor + written_off_minor >= amount_minor ⇒ settled`.

#### `ledger_open_item_allocations` (F16)

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `id("oal", now)` |
| `tenant_id` | text not null | |
| `open_item_id` | text not null | |
| `txn_id` | text not null | the `CASH-APPLY` / `CMSN-SETL` / `WRITE-OFF` transaction |
| `batch_id` | text not null | |
| `bank_line_id` | text | null for non-bank settlement |
| `amount_minor` | integer not null | positive; may exceed nothing |
| `kind` | text not null | `payment` \| `write_off` \| `credit` \| `fx_reval` |
| `applied_at` | integer not null | |
| `applied_by` | text not null | `actorRef(ctx)` |

`uniqueIndex ledger_oal_uq (tenant_id, open_item_id, txn_id, kind)` — replaying
a `CASH-APPLY` with the same idempotency key cannot double-allocate even if the
transaction row somehow survives.

**Allocations are append-only. There is no UPDATE and no DELETE route.** An
allocation is undone by reversing its transaction, which writes a compensating
allocation row with a negative `amount_minor` and `kind` unchanged.

#### `ledger_bank_lines` (F16)

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `id("bkl", now)` |
| `tenant_id` | text not null | |
| `account_code` | text not null | `1000` or `1010` — which bank this statement is for |
| `statement_id` | text not null | `id("bst", now)` — groups one upload |
| `line_ref` | text not null | statement end-to-end id, or `sha256(valueDate|amount|currency|counterparty|remittance|seq)` truncated to 32 when the format has none |
| `booking_date` | text not null | `YYYY-MM-DD` |
| `value_date` | text not null | `YYYY-MM-DD` |
| `direction` | text not null | `credit` (money in) \| `debit` (money out) |
| `amount_minor` | integer not null | positive |
| `currency` | text not null | |
| `counterparty_name` | text | |
| `counterparty_account` | text | IBAN/masked |
| `remittance_info` | text | the free-text field everything hinges on |
| `bank_txn_code` | text | e.g. CAMT `BkTxCd/Prtry/Cd` |
| `state` | text not null | `unapplied` \| `part_applied` \| `applied` \| `ignored` |
| `applied_minor` | integer not null default 0 | |
| `applied_txn_id` | text | last `CASH-APPLY` |
| `source_format` | text not null | `camt053` \| `mt940` \| `ofx` \| `manual` |
| `source_file_ref` | text | R2 key of the original upload |
| `imported_at` | integer not null | |
| `imported_by` | text not null | |

**`uniqueIndex ledger_bank_lines_ref_uq (tenant_id, account_code, line_ref)` is
the entire duplicate-import defence** (D8). The importer inserts every parsed
line and tolerates the constraint violation per row; the import summary reports
`inserted` / `duplicate` counts from that.

`index ledger_bank_lines_state_idx (tenant_id, account_code, state, value_date)`.

#### `ledger_fee_metric_snapshots` (F21)

| Column | Type | Notes |
|---|---|---|
| `id` | text pk | `id("fms", now)` |
| `tenant_id` | text not null | |
| `agreement_ref` | text not null | the contract the fee is billed under |
| `metric_key` | text not null | matches `north_snapshots.metric_key` |
| `grain` | text not null | `day` \| `month` \| `quarter` |
| `period` | text not null | |
| `dims_hash` | text not null | pins the exact `north_snapshots` row |
| `north_snapshot_id` | text not null | |
| `baseline_value` | real not null | contractual baseline |
| `observed_value` | real not null | **copied**, not referenced (D11) |
| `uplift_value` | real not null | `observed - baseline` |
| `fee_basis_minor` | integer not null | the money the fee is computed on |
| `fee_rate_ppm` | integer not null | |
| `fee_amount_minor` | integer not null | `applyPpm(fee_basis_minor, fee_rate_ppm)` |
| `currency` | text not null | |
| `source_hash` | text not null | `sha256` over the canonical JSON of the pinned `north_snapshots` row |
| `state` | text not null | `draft` \| `awaiting_countersign` \| `verified` \| `rejected` \| `consumed` \| `expired` |
| `prepared_by` | text not null | |
| `prepared_at` | integer not null | |
| `countersigned_by` | text | must differ from `prepared_by` |
| `countersigned_at` | integer | |
| `counterparty_signoff_ref` | text | evidence of the client's acceptance (file ref or e-sign id) |
| `rejected_reason` | text | |
| `consumed_txn_id` | text | set when a `SUCCESS-FEE` posts against it |
| `expires_at` | integer not null | `prepared_at + 90d`; a stale metric is not a verified metric |

`uniqueIndex ledger_fms_uq (tenant_id, agreement_ref, metric_key, grain, period, dims_hash)`
— one snapshot per measured thing per period.
`uniqueIndex ledger_fms_consumed_uq (tenant_id, consumed_txn_id)` where not
null — a transaction consumes at most one snapshot.

**Exactly-once billing is the idempotency key**, not this table: the
`SUCCESS-FEE` transaction uses `success-fee:{snapshotId}`, and
`ledger_txns_idem_uq` refuses the second attempt. `consumed_txn_id` records the
outcome; it does not enforce it.

### B.2 Column additions to existing tables

| Table | Column | Type | Why |
|---|---|---|---|
| `ledger_recon_matches` | `posted_txn_id` | text | F19 — the `CMSN-SETL` this match produced; null until confirmed |
| `ledger_recon_matches` | `variance_treatment` | text | F19 — `none` \| `write_off` \| `carry` \| `dispute` |
| `ledger_recon_matches` | `open_item_id` | text | F19/F15 — which subledger row the match settles |
| `ledger_recon_runs` | `closed_at` | integer | F19 — gives `closeRun()` (`recon.ts:382-390`) a reason to exist |
| `ledger_recon_runs` | `closed_by` | text | |
| `ledger_recon_runs` | `statement_ref` | text | ties a run to the provider statement document |
| `ledger_periods` | `fiscal_year` | text | F3 — `2026`; the year-end close targets a fiscal year, not a month |
| `ledger_periods` | `year_end_txn_id` | text | F3 — set on the period that carries the close |
| `ledger_txns` | *(none)* | | manual-journal drafts live in `metadata_json` at state `initiated` |

`ledger_tax_rules` and `ledger_fx_rates` **need no change**. They already have
exactly the columns F17 and F18 require and are simply never read. That is the
single largest lazy win in this spec: two features close with a reader, not a
migration.

### B.3 Chart of accounts additions

`packages/db/src/chart-of-accounts.ts`, eight new rows:

```ts
  { code: "2005", en: "Insurer Payable — Funded", ar: "مستحقات شركة التأمين — ممولة",
    type: "liability", normalSide: "credit", clientMoney: true },
  { code: "2360", en: "Unapplied Receipts", ar: "المقبوضات غير المخصصة",
    type: "liability", normalSide: "credit", clientMoney: true },
  { code: "3000", en: "Share Capital",            ar: "رأس المال",
    type: "equity", normalSide: "credit" },
  { code: "3100", en: "Retained Earnings",        ar: "الأرباح المحتجزة",
    type: "equity", normalSide: "credit" },
  { code: "3200", en: "Current-Year Earnings",    ar: "أرباح السنة الحالية",
    type: "equity", normalSide: "credit" },
  { code: "4085", en: "FX Revaluation Gain",      ar: "أرباح إعادة تقييم العملات",
    type: "income", normalSide: "credit" },
  { code: "5500", en: "Write-offs & Bad Debt",    ar: "الديون المعدومة والشطب",
    type: "expense", normalSide: "debit" },
  { code: "5600", en: "FX Revaluation Loss",      ar: "خسائر إعادة تقييم العملات",
    type: "expense", normalSide: "debit" },
```

Arabic strings are placeholders for the localisation pass; the row must not
ship without one, which is why they are here rather than omitted.

`2005` deserves its own paragraph. Under accrual (F14) the broker owes the
provider from inception, but only *holds the cash* from receipt. One
`2000 Insurer Payable` cannot distinguish the two, and if it were marked
`clientMoney` the invariant would trip the instant an accrual is booked, before
any money exists. So the payable splits: `2000` is unfunded (not client money),
`2005` is funded (client money). Receipt reclasses `2000 → 2005`. The
segregation invariant then reads exactly right: the client bank account must
cover what has actually been collected on others' behalf, and not a currency
unit more.

`2400 Refunds Payable` is deliberately **not** marked `clientMoney`, even
though a refund from the client account arguably is. Existing tenants have
balances there that were never funded from `1010`, and flipping the flag would
manufacture historical breaches. Revisit under the tenant-chart work (§S).

### B.4 Derived client-money sets (the seam)

`chart-of-accounts.ts` gains:

```ts
export const CLIENT_MONEY_ASSET_ACCOUNTS: string[] =
  CHART_OF_ACCOUNTS.filter((a) => a.clientMoney && a.type === "asset").map((a) => a.code);
export const CLIENT_MONEY_LIABILITY_ACCOUNTS: string[] =
  CHART_OF_ACCOUNTS.filter((a) => a.clientMoney && a.type === "liability").map((a) => a.code);
```

`CLIENT_MONEY_ACCOUNT` (`chart-of-accounts.ts:70`) and
`CLIENT_MONEY_LIABILITY_ACCOUNT` (`:71`) stay exported unchanged so no existing
caller breaks. `clientMoneyCheck` (`packages/ledger/src/posting.ts:370-403`)
switches from the two singular constants to the two sets, summing each side.

This **strengthens** the invariant — it adds `2005` and `2360` to the liability
side and nothing to the asset side, so any state that satisfied the new check
satisfied the old one. That direction matters: CLAUDE.md guardrail "do not
weaken tenancy, audit, or approval flows to make tests pass" cuts both ways,
and a change to a safety invariant has to be shown monotone.

`INCOME_OR_EXPENSE = /^[45]/` in `posting.ts` is unchanged. The new equity
range `3xxx` is **not** added to it: `YEAR-END-CLOSE` legitimately debits
income to credit equity, and it never touches a client-money asset, so the
existing rule already permits it and forbids nothing it should permit.

### B.5 Migration order

Forward-only, six files, in this order:

1. `NNNN_ledger_chart_equity_fx.sql` — no schema change; chart is code. Seeds
   `ledger_accounts` rows for the eight new codes for tenants that have the
   table populated.
2. `NNNN_ledger_open_items.sql` — `ledger_open_items` +
   `ledger_open_item_allocations` + indexes.
3. `NNNN_ledger_bank_lines.sql` — `ledger_bank_lines` + indexes.
4. `NNNN_ledger_fee_metric_snapshots.sql` — table + two unique indexes.
5. `NNNN_ledger_recon_posting_cols.sql` — three columns on
   `ledger_recon_matches`, three on `ledger_recon_runs`.
6. `NNNN_ledger_period_fiscal_year.sql` — two columns on `ledger_periods`;
   backfill `fiscal_year = substr(code, 1, 4)`.

Migration 2 does **not** backfill open items from historical journal lines.
There is no due date to backfill from (§D4). Tenants start their subledger at
go-live and carry legacy balances in as `OPEN-BAL` (F2), which is exactly what
opening balances are for.

---

## C. Transaction types and recipes

### C.1 New `TXN_TYPES` tuples

`packages/ledger/src/types.ts`, appended to the existing table
(`types.ts:58-160`). Tuple shape is unchanged:
`[code, financial, approvalPolicyKey, opts?]`.

```ts
  // manual & structural (F2, F3)
  ["MANUAL-JRNL",    true, "ledger.manual_journal"],
  ["OPEN-BAL",       true, "ledger.opening_balance"],
  ["YEAR-END-CLOSE", true, "ledger.year_end_close"],

  // accrual broking (F14)
  ["PREM-BOOK",      true, null],
  ["PREM-CREDIT",    true, "ledger.credit_note"],
  ["PREM-RECEIPT",   true, null,                            { clientMoney: true }],
  ["PREM-SWEEP",     true, "ledger.client_money_transfer",  { clientMoney: true }],

  // cash application (F16)
  ["CASH-APPLY",     true, null,                            { clientMoney: true }],
  ["CASH-UNAPPLIED", true, null,                            { clientMoney: true }],
  ["WRITE-OFF",      true, "ledger.write_off"],

  // revaluation (F18)
  ["FX-REVAL",       true, "ledger.fx_revaluation"],
```

Eleven rows. Also: **delete `CREATOR-SPEND` from `RECIPES`**
(`recipes.ts:398`) — it has no `TXN_TYPES` entry, so it is unreachable, and
dead code in the money path is a liability, not a spare part.

### C.2 New recipes

`packages/ledger/src/recipes.ts`. All pure, all synchronous, all
`spec(Schema, build, defaults)`.

**`manualJournal`** — args `{ lines: [{accountCode, side, amountMinor, memo?, dims?}], memo, reason }`.
Zod refinements, all of which are structural bars rather than warnings:
- `lines.length >= 2`
- `Σ debit === Σ credit`
- no `accountCode` in `CLIENT_MONEY_ASSET_ACCOUNTS ∪ CLIENT_MONEY_LIABILITY_ACCOUNTS`
- no `accountCode` starting `3` (equity is posted only by `OPEN-BAL` and `YEAR-END-CLOSE`)
- `reason` min length 10

The client-money bar is the important one. A manual journal is the one
instrument that can express any entry, so it is the one instrument that must
not be able to express a client-money entry. Moving client money is
`CM-TRANSFER` / `PREM-SWEEP`, which carry the dual-control policy and the
invariant check. Anyone who needs to adjust `1010` needs a transaction type,
not a free-text journal.

**`openingBalance`** — same shape, but permits `3xxx` and permits client-money
accounts (a migrating broker genuinely has a client-account balance on day
one). Precondition-gated to the tenant's first period (§D.1).

**`yearEndClose`** — args `{ closingLines: [{accountCode, side, amountMinor}], retainedEarningsAccount, fiscalYear }`.
Pure: the balances were read before the write set was assembled. Debits every
income account by its credit balance, credits every expense account by its
debit balance, and puts the residual on `3100`.

**`premiumBooking`** (F14) — args
`{ grossMinor, commissionMinor, channelMinor, taxMinor, taxRuleId, basis: "net"|"gross", receivableAccount, payableAccount, incomeAccount, dueAt, counterpartyRef, documentRef, memo, dims }`.

```
basis = "net"   (broker deducts commission at source)
  Dr receivableAccount (1200)         gross
    Cr payableAccount   (2000)        gross − commission
    Cr incomeAccount    (4000/4010)   commission − channel − tax
    Cr 2100 Partner Payable           channel
    Cr 2200 Tax Payable               tax

basis = "gross" (provider pays commission on statement)
  Dr receivableAccount (1200)         gross
    Cr payableAccount   (2000)        gross
  … commission accrues separately through the existing BIND/CMSN-ACCR recipe
    against 1100, unchanged.
```

`lines()` already drops zero-amount legs, so a nil channel share or a
zero-rated tax produces a three-line entry with no special casing.

**`premiumCredit`** — the exact mirror, with `PREM-CREDIT` under
`ledger.credit_note`. Not a reversal: a cancellation mid-term is a new economic
event with its own date and its own period, and reversing the original would
land in a closed month.

**`premiumReceipt`** — args `{ grossMinor, netMinor, cashAccount, receivableAccount, fundedPayableAccount, unfundedPayableAccount, … }`.

```
  Dr 1010 Cash–Client Money           gross
    Cr 1200 Premium Receivable        gross
  Dr 2000 Insurer Payable (unfunded)  net
    Cr 2005 Insurer Payable (funded)  net
```

Four lines, balanced, and after it the invariant reads `1010 ≥ 2005` with the
commission difference legitimately sitting in the client account awaiting
sweep. Worked through: gross 10,000, commission 1,500. After receipt
`1010 = 10,000`, client-money liabilities `= 8,500`. After `PREM-SWEEP`
`1010 = 8,500`, liabilities `= 8,500`. After `PREM-REMIT` both are zero. The
invariant holds at every instant and is tight at two of the three.

**`premiumSweep`** — `Dr 1000 / Cr 1010` for the commission, then the existing
`commissionAccrual` legs. Structurally identical to today's
`clientMoneyTransfer` and reuses it.

**`cashApplication`** (F16) — args
`{ cashAccount, allocations: [{accountCode, amountMinor}], unappliedMinor, unappliedAccount }`.

```
  Dr cashAccount (1010 or 1000)       total received
    Cr each allocation.accountCode    its amount
    Cr 2360 Unapplied Receipts        residual (if any)
```

**`cashUnapplied`** — `Dr 2360 / Cr <target>` when a previously unapplied
receipt is later identified. Keeps the "we received money we could not place"
state honest instead of leaving it in suspense forever.

**`writeOff`** — `Dr 5500 / Cr receivableAccount`, or
`Dr payableAccount / Cr 5500` for a payable. `5500` takes both signs; a
recovered write-off is a credit to `5500`, not a new income account, because
splitting recovery into its own code buys a report column nobody asked for.

**`fxRevaluation`** (F18) — args `{ deltas: [{accountCode, side, amountMinor}], gainAccount: "4085", lossAccount: "5600" }`.
Sums the deltas and puts the balancing leg on `4085` or `5600` depending on
sign.

### C.3 Amendment to an existing recipe

`premiumRemittance` (`recipes.ts`) gains a `payableAccount` arg defaulting to
`"2010"`. Cash-basis tenants are byte-identical; the accrual path passes
`"2005"`. One optional arg with a defaulted value, zero regression surface.

### C.4 `TXN_PRECONDITIONS` (D3)

```ts
export const TXN_PRECONDITIONS: Record<string, Precondition[]> = {
  "OPEN-BAL":       [firstPeriodOnly],
  "YEAR-END-CLOSE": [fiscalYearFullySoftClosed, notAlreadyClosed],
  "FX-REVAL":       [ratesPresentForEveryOpenCurrency, periodOpen],
  "CASH-APPLY":     [allocationsMatchOpenItems, bankLineHasCapacity],
  "WRITE-OFF":      [openItemExistsAndOpen],
  "MANUAL-JRNL":    [periodOpenOrReasoned],
  "SUCCESS-FEE":    [verifiedMetricSnapshot],   // F21
};
```

Each is `async (ctx, args) => void`, throws `badRequest` / `conflict`, and runs
in `runTxn` **before** `buildRecipe` and before the write set is assembled —
which is the whole reason this registry is the right shape. Read, decide, then
write.

---

## D. F2 — Manual journals, opening balances

> *"Every line must come from a recipe keyed to a business event; `TXN_TYPES`
> has no manual, accrual, reclass, or opening-balance type. The approval policy
> `ledger.manual_journal` already exists and is orphaned. No controller can
> operate without this."*

`MANUAL-JRNL` is also the reclass type: a reclass is a manual journal with a
reason, and giving it a separate code would give it a separate audit story for
no gain.

### D.1 Role design

Create: `ledger:journals:draft`. Post: `ledger:journals:post`. Void a draft:
`ledger:journals:void`. Policy `ledger.manual_journal` (existing,
`approvals.ts:51`), `dualControl: "always"`, `neverAutoApprove: true`.
`ledger.opening_balance` is separate because an opening balance is a one-time
act of a different kind, and its own policy lets a tenant grant it during
migration and never again.

Authority: no threshold — every manual journal takes two people regardless of
size. A 1.00 manual journal to a suspense account is exactly as much of a
control bypass as a 1,000,000.00 one.

Precondition `firstPeriodOnly`: `OPEN-BAL` is refused if any batch already
exists in a period earlier than or equal to the target, and refused outright
after the tenant's first hard close.

### D.2 CRUD

Drafts live in `ledger_txns` at state `initiated` with `type = "MANUAL-JRNL"`
and the line array in `metadata_json`. No new table: a draft *is* an
un-authorised transaction, which is what `initiated` means.

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/ledger/journals/drafts` | `ledger:journals:draft` | body `{type: "MANUAL-JRNL"\|"OPEN-BAL", periodCode, currency, reason, lines[]}`; validates against the recipe schema immediately so a draft can never be unpostable |
| GET | `/v1/ledger/journals/drafts` | `ledger:journals:read` | filters `state`, `preparedBy`, `periodCode` |
| GET | `/v1/ledger/journals/drafts/:id` | `ledger:journals:read` | |
| PATCH | `/v1/ledger/journals/drafts/:id` | `ledger:journals:draft` | only while `initiated`, only by `preparedBy`; re-validates |
| DELETE | `/v1/ledger/journals/drafts/:id` | `ledger:journals:void` | soft: state → `rejected` with a reason. **The row is never deleted.** |
| POST | `/v1/ledger/journals/drafts/:id/submit` | `ledger:journals:draft` | state → `validated`, raises the approval, emits `ledger.journal.submitted` |
| POST | `/v1/ledger/journals/drafts/:id/post` | `ledger:journals:post` | `gate()` then `runTxn`; approver ≠ preparer enforced by `approvals.ts:301-302` |

Structurally forbidden, and these are hard bars not conventions:

- **No UPDATE and no DELETE on `ledger_journal_lines`, ever.** Already true;
  this feature is the one most likely to be asked to break it, and the answer
  is a contra posting.
- **No PATCH on a posted transaction.** After `post`, the draft's
  `metadata_json` is frozen; the record of what was proposed must survive what
  was posted.
- **No manual journal to a client-money account** (§C.2). Enforced in the zod
  schema, so it fails at validation and never reaches the gate.
- **No manual journal to `3xxx`.** Equity moves by `OPEN-BAL` or
  `YEAR-END-CLOSE`.
- **No back-dating into a hard-closed period.** `assertPostable`
  (`periods.ts:52-60`) already refuses; soft-closed requires the reason the
  draft already carries.

Events: `ledger.journal.submitted`, `ledger.journal.posted`,
`ledger.journal.rejected` on `lyra-events`. Audit: `ledger.journal.draft`,
`ledger.journal.post`, `ledger.journal.void`, each with before/after.

### D.3 Reporting

**Journal register** — new report `journal-register`, joining the existing
`GET /v1/ledger/reports/:report` map and `REPORT_EXPORTS`
(`routes/ledger.ts:377-496`).

Columns: `postedAt` (date), `batchId` (text), `txnType` (text), `reference`
(text), `accountCode` (text), `accountName` (text), `debitMinor` (money),
`creditMinor` (money), `preparedBy` (text), `approvedBy` (text), `reason`
(text).

Filters: period, transaction type, account, preparer, `manualOnly`.
Drill-down: row → `/ledger/transactions/:id` → batch → the approval record.

**Manual-journal control report** — `manual-journal-control`. Every
`MANUAL-JRNL` and `OPEN-BAL` in a period with preparer, approver, elapsed
seconds between submit and approve, and amount. Columns: `postedAt`,
`txnId`, `amountMinor` (money), `preparedBy`, `approvedBy`, `secondsToApprove`
(number), `reason`, `accountsTouched` (text).

This is the report an auditor asks for by name, and `secondsToApprove` is on it
because a median of four seconds is the signature of rubber-stamping.

New screen `apps/web/app/routes/ledger-journal.tsx`
(route `ledger/journal`, plus `ledger/journal/:id`): a line grid with
account autocomplete, running debit/credit totals, a difference indicator that
blocks submit while non-zero, and an approval panel that is inert for the
preparer.

### D.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.manual_journal_count` | count | month | `packages/ledger/src/reports.ts` | posted `MANUAL-JRNL` in period |
| `finance.manual_journal_value_minor` | minor units | month | ledger reports | Σ debit of those batches |
| `finance.manual_journal_ratio_bps` | basis points | month | ledger reports | manual value ÷ total posted value × 10,000 |
| `finance.manual_journal_median_approval_secs` | seconds | month | ledger reports | median submit→approve |
| `finance.manual_journal_rejected_pct` | ratio 0–1 | month | ledger reports | rejected ÷ submitted |

Snapshotted into `north_snapshots` by the existing NORTH collector; the ratio
is the one that goes on a board pack, because a manual-journal ratio climbing
through 200 bps means a broken automated flow somewhere upstream.

### D.5 AI surfaces

**✦ Account suggestion (ghost text, docs/15 §4 pattern "ghost completion").**
As the preparer types a memo or picks a counterparty, the account field shows a
greyed suggested code. Accepting it is a keystroke; ignoring it costs nothing.

- Purpose `journal.account_suggest`, tier `fast`, via `gateway.complete` in the
  **route layer** (`apps/api/src/routes/ledger.ts`), never in `packages/ledger`.
- Input: memo, counterparty kind, amount sign, the tenant's own last 200 manual
  journal codings. Never another tenant's.
- Output: up to three `{accountCode, confidence, why}`.
- "Why": the chip expands to the three historical journals the suggestion was
  drawn from, with dates and amounts. Inspectable means clickable, not a
  sentence of model prose.
- Never auto-fills. Never submits. A suggestion below confidence 60 is not
  shown at all — same floor as `AI_CONFIRM_FLOOR`, and for the same reason.
- Permission `ledger:ai:invoke` (`rbac.ts:162`), already exists.
- Eval `packages/model-gateway/evals/ledger/journal-account-suggest.eval.ts`,
  golden set 120 memo→account pairs drawn from the seeded chart, threshold
  top-1 ≥ 0.70 / top-3 ≥ 0.90. **Written before the prompt.**

**✦ Reason-quality nudge.** If `reason` is under 20 characters or matches a
template ("adjustment", "per email"), a quiet chip suggests what a reviewer
will ask. Non-blocking, no model call needed for the trigger — the trigger is a
regex, only the suggested phrasing is generated. Rung 6: most of this feature
is a regex, so most of this feature should be a regex.

---

## E. F3 — Equity accounts and the year-end close

> *"`AccountType` declares `"equity"`; the chart contains no 3xxx rows.
> `balanceSheet` derives equity as a plug. `closePeriod` only flips a status."*

### E.1 Role design

New permission `ledger:periods:year_end`. New policy `ledger.year_end_close`,
`dualControl: "always"`, `neverAutoApprove: true`. Held by
`finance.director` and (via `ledger:*:*`) `finance.controller`; the two are
different people, so the close needs both.

Preconditions `fiscalYearFullySoftClosed` (all twelve periods of the fiscal
year at `soft_closed` or `hard_closed`) and `notAlreadyClosed`
(`ledger_periods.year_end_txn_id` null for every period in the year).

### E.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/ledger/periods/:code/year-end` | `ledger:periods:year_end` | `:code` is the final period of the fiscal year; body `{fiscalYear, retainedEarningsAccount?}`; idempotency key `yearend:{fiscalYear}` |
| GET | `/v1/ledger/periods/:code/year-end/preview` | `ledger:periods:read` | dry run: the closing lines that *would* post, no write |
| GET | `/v1/ledger/reports/equity-movement` | `ledger:journals:read` | see E.3 |

The preview endpoint is not decoration. Read-decide-then-write means the
closing lines are computed by a read; exposing that read is free and it is the
only way a controller can check a close before it is irreversible.

Structurally forbidden:

- **No reopening a fiscal year by deleting the close transaction.** The close
  is reversed by `POST /v1/ledger/txn/:id/reverse` (existing), which writes a
  contra batch and clears `year_end_txn_id`. Under
  `ledger.year_end_close` approval, of course.
- **No direct posting to `3100` from any recipe other than `openingBalance`
  and `yearEndClose`.** `3200` is never posted at all — it is a presentation
  line only (see E.3).
- **No close of a fiscal year with an open period in it.**

Events: `ledger.year_end.closed`. Audit: `ledger.period.year_end` with the full
closing line set in `after`.

### E.3 Reporting

`balanceSheet()` (`reports.ts:369-392`) changes shape:

- Equity becomes a real section with account rows: `3000`, `3100`, and any
  other posted `3xxx`.
- Current-year earnings appear as **one derived line labelled
  `equity.current_year_unposted`**, computed as it is today (income − expense
  for the unclosed year only). It is visibly a derived line, with a tooltip
  saying so, and it goes to zero the moment the year closes.
- The plug at `reports.ts:383` disappears. Prior-year retained earnings come
  from the posted `3100` balance.

Two new reports on the existing `/v1/ledger/reports/:report` route:

**`equity-movement`** — columns `accountCode`, `accountName`,
`openingMinor` (money), `postedMinor` (money), `closingMinor` (money),
`sourceTxnId` (text). Drill-down: row → journal register filtered to that
account → batch → transaction.

**`income-statement`** (if not already present under another name) —
columns `accountCode`, `accountName`, `periodMinor` (money),
`yearToDateMinor` (money), `priorYearMinor` (money). Its total must equal the
balance-sheet current-year line to the currency unit; that equality is a
property test (§N).

Screen: `apps/web/app/routes/ledger-year-end.tsx` (route `ledger/year-end`) —
a checklist of the twelve periods with their states, the preview table, and a
two-stage confirm. Reuses the `ledger-period-close.tsx` layout.

### E.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.retained_earnings_minor` | minor units | month | ledger reports | posted `3100` balance |
| `finance.current_year_earnings_minor` | minor units | month | ledger reports | income − expense, fiscal-year-to-date |
| `finance.net_margin_ratio` | ratio 0–1 | month | ledger reports | current-year earnings ÷ income |
| `finance.equity_minor` | minor units | month | ledger reports | Σ `3xxx` + unposted current-year |
| `finance.days_to_year_end_close` | days | year | ledger reports | fiscal year end → `YEAR-END-CLOSE` postedAt |

`days_to_year_end_close` is the operational one. Everything else on this list
is an output of the accounting; that one is a measure of whether the accounting
function works.

### E.5 AI surfaces

**None.** A year-end close is arithmetic over balances that either tie or do
not. There is no judgement in it, no ambiguity to resolve, and no upside to
introducing a component that can be wrong. The narrative commentary a board
pack wants is NORTH's job and already exists there.

Stated here explicitly because the absence is a decision, not an oversight.

---

## F. F14 — Accrual premium accounting

> *"Gross written premium is never a receivable; there is no insurer payable."*

### F.1 Role design

No new permission: booking an accrual is `ledger:txns:create`, which every
operational finance role has. It creates no cash movement and no consequential
external effect, so gating it would be theatre.

`PREM-CREDIT` uses the existing `ledger.credit_note` policy
(`approvals.ts:53`), `above_threshold` at 1,000.00, `neverAutoApprove`.
Cancelling a booked premium reduces both a receivable and a payable and is
therefore worth a second look above a threshold.

`PREM-SWEEP` uses `ledger.client_money_transfer`, `always` + `neverAutoApprove`
— unchanged from today's rule, correctly, because taking commission out of a
client account is the single most regulated movement in the module.

Which basis a given agreement uses (`net` or `gross`) is agreement
configuration read from the distribution module, not a per-transaction choice
by the operator. A user who could pick the basis could pick where the money
appears to be.

### F.2 CRUD

No new routes. `PREM-BOOK`, `PREM-CREDIT`, `PREM-RECEIPT` and `PREM-SWEEP` all
go through the existing generic `POST /v1/ledger/txn/:type`
(`routes/ledger.ts:78-121`). That endpoint already validates against `RECIPES`,
already resolves the approval policy from `TXN_TYPES`, already enforces
idempotency. Adding four routes would add four places to get it wrong.

Reads:

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/ledger/open-items` | `ledger:openitems:read` | see §G — the accrual's visible surface is the subledger |
| GET | `/v1/ledger/reports/premium-register` | `ledger:journals:read` | booked / received / remitted / outstanding by counterparty |

Idempotency keys: `prem-book:{agreementRef}:{documentRef}`,
`prem-receipt:{documentRef}:{valueDate}:{amountMinor}`.

Structurally forbidden:

- **No `PREM-RECEIPT` without a matching open item.** Precondition. Cash
  arriving against nothing is `CASH-UNAPPLIED` (§H), not a premium receipt.
- **No `PREM-SWEEP` beyond the collected commission.** The sweepable amount is
  `Σ commission on receipts collected − Σ already swept`, read before the write
  set. Sweeping uncollected commission out of a client account is the classic
  segregation breach and it is barred arithmetically, not by policy.
- **No editing a booked accrual.** Correct with `PREM-CREDIT` + rebook.

Events: `ledger.premium.booked`, `ledger.premium.received`,
`ledger.premium.swept`, `ledger.premium.credited`.

### F.3 Reporting

**`premium-register`** — columns `bookedAt` (date), `documentRef` (text),
`counterparty` (text), `grossMinor` (money), `commissionMinor` (money),
`netPayableMinor` (money), `receivedMinor` (money), `remittedMinor` (money),
`outstandingMinor` (money), `dueAt` (date), `state` (text).
Drill-down: row → open item → allocations → bank lines → transactions.

**`insurer-payable-position`** (label via domain pack, not this filename) —
columns `counterparty`, `unfundedMinor` (money, `2000`), `fundedMinor` (money,
`2005`), `remittedMtdMinor` (money), `nextDueAt` (date), `agedOverdueMinor`
(money).

The funded/unfunded split is the single most useful number in a broking back
office and it does not exist anywhere in the codebase today.

**Client-money position** — extend the existing money-map screen
(`apps/web/app/routes/ledger-money-map.tsx`) with the derived-set totals: bank
`1010` on one side, `2010 + 2005 + 2360` itemised on the other, and the surplus
or deficit. Today the screen exports no action and shows two constants; it
should at minimum show the truth.

### F.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.gwp_booked_minor` | minor units | month | ledger reports | Σ `PREM-BOOK` gross |
| `finance.commission_booked_minor` | minor units | month | ledger reports | Σ commission legs |
| `finance.commission_rate_bps` | basis points | month | ledger reports | commission ÷ GWP × 10,000 |
| `finance.premium_collected_pct` | ratio 0–1 | month | ledger reports | received ÷ booked, same cohort |
| `finance.insurer_payable_funded_minor` | minor units | day | ledger reports | `2005` balance |
| `finance.insurer_payable_unfunded_minor` | minor units | day | ledger reports | `2000` balance |
| `finance.client_money_surplus_minor` | minor units | day | `packages/ledger/src/posting.ts` (already computed by `clientMoneyCheck`) | `1010 − Σ` client-money liabilities |
| `finance.remittance_lag_days` | days | month | ledger reports | median receipt→`PREM-REMIT` |

`client_money_surplus_minor` is computed where the check already computes it,
not recomputed for the dashboard. Two implementations of a regulatory invariant
is one implementation too many.

`remittance_lag_days` at day grain would be noise; monthly median is what a
regulator asks about.

### F.5 AI surfaces

**✦ Booking anomaly chip (docs/15 §4 pattern "quiet chip").** On a `PREM-BOOK`
whose commission rate deviates from the agreement's historical distribution, a
chip appears next to the amount: "✦ 4.2% — this agreement has averaged 12.5%
over 340 bookings."

- Purpose `premium.anomaly`, tier `fast`. Called from the route layer after the
  transaction posts, never before — it must not be able to block a booking.
- The **detection is statistical, not generative**: median absolute deviation
  over the agreement's history, computed in `packages/ledger`. The model only
  writes the one-line explanation, and only when the statistic already fired.
  Rung 6 again: the part that decides is arithmetic, the part that talks is the
  model.
- "Why": expands to the distribution, n, and the five nearest comparable
  bookings.
- Never reverses, never blocks, never notifies outside the screen unless the
  tenant has configured an alert.
- Eval `packages/model-gateway/evals/ledger/premium-anomaly.eval.ts` — golden
  set of 60 labelled anomalies + 60 normal bookings, precision ≥ 0.80 at
  recall ≥ 0.60. The eval tests the *statistic*; the prose is checked only for
  not asserting a number the statistic did not produce.

---

## G. F15 — Open-item aging by due date, both directions

> *"`agedBalances` ages by posting date, not due date, and only receivables."*

### G.1 Role design

`ledger:openitems:read` (free to `finance.analyst` via `readsOf`),
`ledger:openitems:write` for the three mutable fields only.

There is no permission to change an open item's *amount*. The amount comes from
the batch that created it and the only way to change it is to post something.
That is the whole design of a subledger and it is why `PATCH` is restricted to
`due_at`, `disputed` + `disputed_reason`, and `collection_note`.

Changing `due_at` is audited (`ledger.openitem.reschedule`) because moving a
due date is how aging gets massaged.

### G.2 CRUD

Creation is not an API operation. Open items are emitted by a new pure function
registered beside each recipe:

```ts
// packages/ledger/src/open-items.ts
export type OpenItemEmitter = (args: never, ctx: EmitCtx) => OpenItemDraft[];
export const OPEN_ITEM_EMITTERS: Record<string, OpenItemEmitter> = {
  "PREM-BOOK":   (a) => [{ kind: "receivable", accountCode: a.receivableAccount, … },
                         { kind: "payable",    accountCode: a.payableAccount,    … }],
  "BIND":        (a) => [{ kind: "receivable", accountCode: a.receivableAccount, … }],
  "SUB-INVOICE": (a) => [{ kind: "receivable", accountCode: "1160", … }],
  "RSHARE-ACCR": (a) => [{ kind: "payable",    accountCode: "2100", … }],
  …
};
```

`post()` appends the resulting inserts to the write set it already hands to
`atomically()`. Same batch, same atomic unit, no second write, no projection
lag. A type with no emitter emits nothing — the registry is opt-in, so adding
accrual coverage is one row at a time and nothing regresses in between.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/ledger/open-items` | `ledger:openitems:read` | filters `kind`, `state`, `counterpartyRef`, `accountCode`, `dueBefore`, `overdueOnly`, `currency`; cursor paginated |
| GET | `/v1/ledger/open-items/:id` | `ledger:openitems:read` | includes allocations and the originating batch |
| PATCH | `/v1/ledger/open-items/:id` | `ledger:openitems:write` | **only** `dueAt`, `disputed`, `disputedReason`, `collectionNote` |
| GET | `/v1/ledger/reports/aged-receivables` | `ledger:journals:read` | |
| GET | `/v1/ledger/reports/aged-payables` | `ledger:journals:read` | |
| GET | `/v1/ledger/reports/open-items` | `ledger:openitems:read` | flat detail, exportable |

Structurally forbidden: no POST, no DELETE. An open item that should not exist
is closed by a `WRITE-OFF` or by reversing its origin transaction.

New close check in `closeChecks()` (`periods.ts:73-155`):
**`subledger_tie_out@{code}`** — for each receivable/payable control account,
`Σ open_items.amount_minor − settled_minor − written_off_minor` must equal the
account's balance. A subledger that does not tie to its control account is the
oldest bug in accounting and the month must not freeze over it.

Events: `ledger.openitem.opened`, `ledger.openitem.settled`,
`ledger.openitem.overdue` (emitted by a daily scheduled job that flips nothing
— it only emits, so ORBIT can drive dunning without ledger knowing ORBIT
exists).

### G.3 Reporting

**`aged-receivables` / `aged-payables`** replace the current
`agedBalances()` (`reports.ts:411-459`) rather than extending it. Columns:
`counterparty` (text), `currency` (text), `currentMinor` (money),
`d1_30Minor`, `d31_60Minor`, `d61_90Minor`, `d91_120Minor`, `over120Minor`,
`totalMinor` (all money), `oldestDueAt` (date), `disputedMinor` (money).

Buckets are by `due_at`, not `posted_at`. "Current" means not yet due; today
"current" means posted in the last 30 days, which is a different and much
friendlier number.

Drill-down: counterparty row → open-item list → item detail → allocations →
bank lines → transaction → batch → lines.

Account codes come from `CHART_OF_ACCOUNTS` filtered by type, not from
`["1100","1150","1160"]` hard-coded at `reports.ts:415`. Adding `1200` to the
chart today does not put it in the aging; that is the bug.

**`collections-worklist`** — the operational screen behind
`apps/web/app/routes/ledger-collections.tsx` (route `ledger/collections`).
Columns: `counterparty`, `overdueMinor` (money), `oldestDaysOverdue` (number),
`itemCount` (number), `lastContactAt` (date), `promiseToPayAt` (date),
`nextAction` (text), `riskBand` (text). Sortable, bulk-selectable, with a
"log contact" action that writes a `collection_note` and emits an event ORBIT
can act on.

### G.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.dso_days` | days | month | `packages/ledger/src/reports.ts` | countback DSO over open receivables |
| `finance.dpo_days` | days | month | ledger reports | countback DPO over open payables |
| `finance.overdue_receivable_minor` | minor units | day | ledger reports | Σ open receivables past `due_at` |
| `finance.overdue_ratio` | ratio 0–1 | day | ledger reports | overdue ÷ total open receivable |
| `finance.aging_over_90_ratio` | ratio 0–1 | month | ledger reports | >90-day bucket ÷ total |
| `finance.disputed_minor` | minor units | day | ledger reports | Σ items in `disputed` |
| `finance.collection_effectiveness_ratio` | ratio 0–1 | month | ledger reports | collected ÷ (opening open + booked) |
| `finance.write_off_ratio_bps` | basis points | month | ledger reports | written off ÷ booked × 10,000 |

Countback DSO, not the naive `AR ÷ revenue × days`, because broking revenue is
lumpy at renewal season and the naive form swings 20 days on seasonality alone.

### G.5 AI surfaces

**✦ Collections prioritiser (docs/15 §4 pattern "background draft").**
Overnight, ranks the open receivable book by likelihood-of-payment-if-chased
and drafts a contact for the top N.

- Purpose `collections.prioritise`, tier `reasoning`. Runs in `apps/agents`,
  not in `packages/ledger`.
- Inputs: item age, amount, counterparty payment history, prior contact
  outcomes, dispute flag. **Not** the counterparty's free-text notes, which
  routinely contain third-party personal data.
- Output: an ordered list plus a per-item one-line rationale and a draft
  message. The draft lands in the collections worklist as a ✦ suggestion.
- **Never sends.** Outbound is `consequential: true` (CLAUDE.md #4) and goes
  through the channel's own approval. The prioritiser produces a draft and
  stops.
- "Why": each ranking expands to the four features that drove it with their
  contributions, and to the three most similar historical items and what
  happened to them.
- Eval `packages/model-gateway/evals/ledger/collections-prioritise.eval.ts` —
  backtest against 12 months of settled items; the ranking must beat
  amount-descending on recovered-value-at-k for k = 10, 25, 50. If it does not
  beat sorting by size, ship sorting by size and delete the model.

---

## H. F16 — Bank statement import and cash application

> *"`ledger-recon.tsx:521` requires hand-pasted JSON."*

### H.1 Role design

`ledger:bank:import` to upload, `ledger:bank:read` to view, `ledger:cash:apply`
to allocate, `ledger:cash:writeoff` for the residual. Import and apply are
analyst-level; write-off is not.

The residual split is the control that matters. An operator applying a 9,997.00
receipt against a 10,000.00 invoice must either leave 3.00 open, park it in
`2360`, or get a write-off approved. The one thing they cannot do is make it
disappear, and that is enforced by `cashApplication` requiring
`Σ allocations + unappliedMinor === amountMinor` exactly.

### H.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/ledger/bank/import` | `ledger:bank:import` | multipart; `{accountCode, format?}`; format sniffed if absent; original stored in R2, key on `source_file_ref` |
| GET | `/v1/ledger/bank/statements` | `ledger:bank:read` | one row per upload with counts |
| GET | `/v1/ledger/bank/lines` | `ledger:bank:read` | filters `accountCode`, `state`, `valueDateFrom/To`, `direction`, `q` (searches `remittance_info`, `counterparty_name`) |
| GET | `/v1/ledger/bank/lines/:id` | `ledger:bank:read` | with suggested matches |
| POST | `/v1/ledger/bank/lines/:id/apply` | `ledger:cash:apply` | body `{allocations:[{openItemId, amountMinor}], unappliedMinor, writeOffMinor?}`; runs `CASH-APPLY` |
| POST | `/v1/ledger/bank/lines/:id/ignore` | `ledger:bank:import` | body `{reason}`; state → `ignored`; no posting |
| POST | `/v1/ledger/bank/apply-bulk` | `ledger:cash:apply` | body `{lineIds[]}`; applies only lines with a single unambiguous deterministic match |

No unapply route. An application is undone through the existing
`POST /v1/ledger/txn/:id/reverse`, which writes a contra batch and a
compensating allocation. One reversal mechanism for the whole module.

**Parsers** in `packages/ledger/src/bank/`: `parseCamt053.ts`, `parseMt940.ts`,
`parseOfx.ts`, each `(text: string) => BankLineDraft[]`, pure and
independently testable. MT940 and OFX are line-oriented and parse with a
regex-per-tag; CAMT.053 is XML — see §S for the dependency question.

Import flow, strictly read-decide-then-write:
1. read the file, parse to drafts (pure);
2. read existing `line_ref`s for the account (one indexed query);
3. assemble the insert write set;
4. `atomically()`;
5. report `{inserted, duplicate, failed}`.

Structurally forbidden:

- **No editing a bank line's amount, date or reference.** The bank said what it
  said. Corrections come as new statement lines.
- **No deleting a bank line.** `ignored` with a reason.
- **No applying more than the line's remaining capacity.** Precondition
  `bankLineHasCapacity`.
- **No applying to an open item in another currency** without an explicit FX
  gain/loss leg. Refused at validation.
- **No import without `accountCode`.** A statement that does not know which
  bank it is from is not a statement.

Matching reuses the existing three-pass `reconcile()` unchanged: deterministic
(exact `document_ref` in `remittance_info` + exact amount), tolerance (amount
within tenant tolerance + fuzzy counterparty), then optional `ai_proposed`.
Rung 2 of the ladder: the matcher exists, and the reason this feature was
missing was never the matcher.

Events: `ledger.bank.imported`, `ledger.cash.applied`,
`ledger.cash.unapplied_aged` (daily, for `2360` older than 30 days).

### H.3 Reporting

**`bank-unapplied`** — columns `valueDate` (date), `accountCode` (text),
`counterpartyName` (text), `amountMinor` (money), `currency` (text),
`remittanceInfo` (text), `ageDays` (number), `suggestedMatch` (text),
`suggestedConfidence` (number).

**`cash-application-log`** — columns `appliedAt` (date), `bankLineRef` (text),
`openItemDoc` (text), `counterparty` (text), `amountMinor` (money), `kind`
(text), `appliedBy` (text), `txnId` (text). The audit trail an examiner asks
for.

**`unapplied-aging`** — `2360` balance bucketed by age. Money sitting in
unapplied receipts for 90 days is either someone else's money or a lost
invoice, and both are findings.

Screen: rebuild `apps/web/app/routes/ledger-recon.tsx` around a
two-panel layout — bank lines left, candidate open items right, drag or keyboard
to allocate, running residual, and a file drop zone replacing the JSON
textarea at `ledger-recon.tsx:521`. Bulk-confirm for deterministic matches.
Keyboard-complete throughout (WCAG 2.2 AA); drag is an alternative, never the
only route.

### H.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.auto_match_rate` | ratio 0–1 | day | `packages/ledger/src/recon.ts` | deterministically matched lines ÷ imported |
| `finance.cash_application_lag_hours` | hours | day | ledger reports | median `value_date` → applied |
| `finance.unapplied_minor` | minor units | day | ledger reports | `2360` balance |
| `finance.unapplied_over_30d_minor` | minor units | day | ledger reports | aged portion |
| `finance.bank_lines_imported` | count | day | ledger reports | |
| `finance.duplicate_import_rate` | ratio 0–1 | day | ledger reports | duplicates ÷ parsed — a rising value means a broken upload habit |
| `finance.write_off_at_application_minor` | minor units | month | ledger reports | residuals written off during application |

`auto_match_rate` is the number that justifies the whole feature. If it is not
above 0.70 within a month of a tenant going live, the tolerance configuration
is wrong, not the matcher.

### H.5 AI surfaces

**✦ Remittance reader (candidates only).** Bank remittance text is a swamp:
`"PYMT REF 4471/ POL 88213 -PART"`. The reader extracts candidate document
references, counterparty names and invoice numbers from `remittance_info`.

- Purpose `bank.remittance_read`, tier `fast`, injected into `reconcile()` as
  an extension of the existing `MatchProposer` seam. **`packages/ledger` keeps
  zero model-gateway dependency** — the function is passed in from the route,
  exactly as `aiProposer` is today (`routes/ledger.ts:622-679`).
- Output: extracted tokens, **not** matches. The tokens go through the same
  deterministic pass-1 matcher. If a token matches a document reference
  exactly, the match is deterministic and marked as such; if it does not, there
  is no match.
- This is the important structural decision: the model reads text, the
  deterministic matcher decides money. A hallucinated invoice number matches
  nothing and produces nothing.
- Opt-in per run, off by default, mirroring the existing `propose` flag
  (`routes/ledger.ts:586-616`).
- Confidence floor `AI_CONFIRM_FLOOR = 60`, never auto-confirmed.
- "Why": the chip shows the exact substring of `remittance_info` each token was
  taken from, highlighted in place.
- Eval `packages/model-gateway/evals/ledger/bank-remittance-read.eval.ts` —
  golden set of 200 real-shaped remittance strings across the three formats and
  four locales including Arabic; token-level F1 ≥ 0.85, **and zero fabricated
  references** (a fabricated token is a hard fail, not a scored miss).

**No AI writes an allocation.** Ever. The proposal path ends at a suggestion a
human confirms, which is the boundary `docs/27` already identifies as one of
the module's genuine strengths and which this spec protects rather than erodes.

---

## I. F17 — Tax from `ledger_tax_rules`, never inferred

> *"`splitCommission` takes `taxPpm` as an argument; `ledger_tax_rules` is
> never read. docs/19 §5.3: 'Tax is never inferred in code.'"*

No new table. The table exists with exactly the right columns and has never
been read. This is a resolver and a validation change.

### I.1 Role design

`ledger:tax:read` (free to analysts via `readsOf`), `ledger:tax:write` for
maintenance. Policy `ledger.tax_rule_change`, `dualControl: "always"`,
`neverAutoApprove: true`.

A tax rule change is gated harder than most postings because it is not one
posting — it is every posting after it. A wrong `rate_ppm` is silent, systemic
and only discovered at filing.

### I.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/ledger/tax-rules` | `ledger:tax:read` | filters `market`, `code`, `activeAt` |
| GET | `/v1/ledger/tax-rules/:id` | `ledger:tax:read` | |
| POST | `/v1/ledger/tax-rules` | `ledger:tax:write` | gated; creates a new row |
| PATCH | `/v1/ledger/tax-rules/:id` | `ledger:tax:write` | gated; **only `effective_to`** |
| POST | `/v1/ledger/tax-rules/resolve` | `ledger:tax:read` | `{market, placeOfSupply, code?, at}` → the resolved rule; the same function the posting path uses |

**Structurally forbidden: `rate_ppm`, `market`, `code`, `place_of_supply`,
`reverse_charge`, `exempt` and `effective_from` are immutable after insert.** A
rate change is a new row with a new `effective_from` and the old row's
`effective_to` set. Editing a rate in place would retroactively restate every
posting that used it, which is the thing tax authorities most dislike.

No DELETE. Close it with `effective_to`.

**The resolver** `resolveTaxRule(ctx, {market, placeOfSupply, code, at})` in
`packages/core/src/tax.ts`:
- most-specific-wins, mirroring `resolveRate` (`commission.ts:84-108`) so there
  is one resolution idiom in the codebase, not two;
- returns `{ruleId, ratePpm, exempt, reverseCharge}`;
- **throws** when nothing matches. No default of zero. A missing rule is a
  configuration error surfaced at the point of transaction, not a silent
  zero-rating discovered at filing.

**The signature change** at `commission.ts:45-58`:

```ts
// before (F17):  const taxMinor = applyPpm(grossMinor - channelMinor, input.taxPpm ?? 0);
// after:
//   splitCommission takes { taxRuleId, taxRatePpm } — both required, both resolved
//   by the caller. There is no `?? 0`.
```

`quoteCommission` (`commission.ts:115-169`) resolves the rule before it splits,
using the offering's market and the counterparty's place of supply. `taxPpm` as
a free parameter is removed from the public signature entirely; leaving it as
optional-with-a-default is how it came to be zero everywhere.

**Recipe-level enforcement.** A zod refinement shared by `CommissionArgs`,
`InvoiceArgs` and the new `PremiumArgs`:

```
taxMinor > 0  ⇒  taxRuleId required
taxMinor === 0 ⇒  taxRuleId required AND (rule.exempt || rule.reverseCharge)
                  OR an explicit taxExemptReason
```

Zero tax must be *asserted*, not defaulted. That refinement is the whole
finding.

Resolution happens in the route/engine before `buildRecipe`, so recipes stay
pure (D2). The resolved `{ruleId, ratePpm}` is stamped into the transaction's
`metadata_json` and into every tax line's `dims_json`, so a filing report can
reconstruct which rule produced which currency unit years later.

Events: `ledger.tax_rule.created`, `ledger.tax_rule.closed`.

### I.3 Reporting

**`tax-summary`** — columns `market` (text), `taxCode` (text), `ratePpm`
(number), `placeOfSupply` (text), `taxableBaseMinor` (money), `taxMinor`
(money), `reverseChargeMinor` (money), `exemptMinor` (money), `ruleId` (text).
Grouped by period. Drill-down: rule → the journal lines carrying that
`ruleId` in dims → batch → transaction.

**`tax-rule-history`** — every version of every rule with who changed it, when,
and the approval reference. Columns `market`, `code`, `ratePpm`,
`effectiveFrom` (date), `effectiveTo` (date), `createdBy`, `approvedBy`,
`supersededBy`.

**`tax-exceptions`** — postings with `taxMinor === 0` and their asserted
reason. This is the report that catches "we defaulted to zero and nobody
noticed", and it should be empty.

Screen: `apps/web/app/routes/ledger-tax-rules.tsx` (route `ledger/tax-rules`)
— an effective-dated timeline per market, with the resolve-preview tool so a
controller can ask "what rate applies to this sale on this date" without
posting anything.

### I.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.tax_payable_minor` | minor units | month | ledger reports | `2200` balance |
| `finance.tax_effective_rate_bps` | basis points | month | ledger reports | tax ÷ taxable base × 10,000 |
| `finance.tax_unresolved_count` | count | day | ledger reports | postings with no `taxRuleId` in dims — **target zero** |
| `finance.tax_exempt_ratio` | ratio 0–1 | month | ledger reports | exempt base ÷ total base |
| `finance.reverse_charge_minor` | minor units | month | ledger reports | |

`tax_unresolved_count` is an alarm dressed as a KPI. Any non-zero value means
something posted without a rule, and it should page.

### I.5 AI surfaces

**None.**

Tax is a lookup against effective-dated reference data. A model in this path
could only add a way to be wrong, and being wrong about tax is a regulatory
event. docs/19 §5.3 already says tax is never inferred in code; inferring it
with a model would be the same mistake with worse observability.

The one adjacent thing worth having is not AI: the resolve-preview tool in
§I.3, which is a deterministic query.

---

## J. F18 — FX revaluation of open balances

> *"docs/19 §5.3 requires a revaluation job for open receivables and payables
> at period end; it does not exist."*

No new table. `ledger_fx_rates` already has `from_currency`, `to_currency`,
`rate_ppm`, `as_of`, `source`.

### J.1 Role design

`ledger:fx:read`, `ledger:fx:write` (load rates), `ledger:fx:revalue` (run it).
Policy `ledger.fx_revaluation`, `above_threshold` at 10,000.00,
auto-approvable (see A.3 for why this one is).

Loading a rate is not gated: it is reference data with a source and a date, and
a wrong rate is caught by the revaluation's own threshold before it becomes a
posting. Gating it would slow the daily task and protect nothing.

### J.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/ledger/fx-rates` | `ledger:fx:read` | filters `from`, `to`, `asOfFrom/To` |
| POST | `/v1/ledger/fx-rates` | `ledger:fx:write` | `{fromCurrency, toCurrency, ratePpm, asOf, source}`; upsert on the existing unique index |
| POST | `/v1/ledger/fx/revalue` | `ledger:fx:revalue` | `{periodCode, asOf?, dryRun?}`; idempotency key `fxreval:{periodCode}:{baseCurrency}` |
| GET | `/v1/ledger/reports/fx-exposure` | `ledger:fx:read` | |
| GET | `/v1/ledger/reports/fx-revaluation` | `ledger:fx:read` | what the last run posted |

**Structurally forbidden: an `fx_rates` row is immutable once a revaluation has
referenced it.** Enforced by a precondition on the upsert. Restating a rate
after it has produced postings would silently invalidate them.

No DELETE on rates.

**The algorithm**, cumulative (D7), strictly read-decide-then-write:

1. Read all `ledger_open_items` where `state in ('open','part_settled','disputed')`
   and `currency != baseCurrency`.
2. Read the rate for each distinct currency pair at `asOf`. Precondition
   `ratesPresentForEveryOpenCurrency` fails the whole run if any is missing —
   partial revaluation is worse than none.
3. For each item: `targetBase = applyPpm(outstandingMinor, ratePpm)`;
   `delta = targetBase − base_revalued_minor`.
4. Aggregate deltas by `account_code` and side.
5. Assemble **one** write set: the `FX-REVAL` batch, the
   `base_revalued_minor` / `last_revalued_period` updates on every item, and an
   allocation row per item with `kind = "fx_reval"`.
6. `atomically()`.

Because the delta is measured against `base_revalued_minor` rather than the
original rate, there is nothing to reverse next month and no ordering hazard if
a run is repeated. Repeating a run in the same period is refused by the
idempotency key; running it again after new items appear posts only the new
deltas.

`applyPpm` (`commission.ts`) is reused for the rounding, so FX rounding and
commission rounding are the same round-half-up and cannot drift apart.

New close check: **`fx_revalued@{code}`** — if any open item in a non-base
currency has `last_revalued_period` earlier than the closing period, the check
fails. Forceable like any other, with the F20 gate.

Events: `ledger.fx.revalued`.

### J.3 Reporting

**`fx-exposure`** — columns `currency` (text), `openReceivableMinor` (money),
`openPayableMinor` (money), `netExposureMinor` (money),
`baseValueMinor` (money), `rateUsed` (number), `rateAsOf` (date),
`unrealisedMinor` (money).

**`fx-revaluation`** — columns `periodCode` (text), `currency` (text),
`accountCode` (text), `priorBaseMinor` (money), `newBaseMinor` (money),
`deltaMinor` (money), `gainOrLoss` (text), `txnId` (text).
Drill-down: row → the `FX-REVAL` batch → per-item allocations.

**`fx-rate-history`** — every rate with source and as-of, so a delta can be
explained by pointing at the two rates that produced it.

Screen: extend `apps/web/app/routes/ledger-period-close.tsx` with an FX panel:
currencies open, rate loaded / missing, computed delta, and a dry-run button.
A missing rate is shown as a blocking item in the close checklist, not as an
error at run time.

### J.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.fx_net_exposure_minor` | minor units (base) | day | ledger reports | Σ open non-base items at latest rate |
| `finance.fx_unrealised_pnl_minor` | minor units | month | ledger reports | cumulative revaluation delta not yet settled |
| `finance.fx_realised_pnl_minor` | minor units | month | ledger reports | `4085 − 5600` on settled items |
| `finance.fx_exposure_ratio` | ratio 0–1 | month | ledger reports | non-base open ÷ total open |
| `finance.fx_rate_staleness_days` | days | day | ledger reports | max age of the newest rate per open pair |

`fx_rate_staleness_days` above 3 means the close will fail; showing it daily
turns a month-end surprise into a Tuesday task.

### J.5 AI surfaces

**None.**

Revaluation is `outstanding × rate − previously recognised`. There is no
judgement, no ambiguity, and a model in the loop would introduce variance into
a number that must be reproducible from two inputs.

If someone wants commentary on why exposure moved, that is a NORTH briefing
over the KPI series, not a component of the posting path.

---

## K. F19 — Insurer statement reconciliation that posts

> *"`decideMatch` updates `state` and audits. It posts nothing. docs/19 §6
> requires `CMSN-SETL` postings."*

The insertion point is precisely `packages/ledger/src/recon.ts:297-330`.

### K.1 Role design

`ledger:recon:confirm` (exists) to confirm. Confirming a match **with a
variance above the tenant's tolerance** additionally requires
`ledger:cash:writeoff` and passes through `ledger.write_off`, because a
tolerated variance is a write-off wearing a different hat.

`variance_treatment` values and who may choose them:

| Treatment | Effect | Permission |
|---|---|---|
| `none` | variance is zero | `ledger:recon:confirm` |
| `write_off` | residual to `5500` | `ledger:cash:writeoff` + `ledger.write_off` gate |
| `carry` | residual stays as an open item, redated | `ledger:recon:confirm` |
| `dispute` | open item flagged `disputed` with a reason, no posting | `ledger:recon:confirm` |

Closing a run (`closeRun`, currently dead at `recon.ts:382-390`) requires
`ledger:recon:run` and refuses while any match is `confirmed` but unposted.

### K.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/ledger/recon/matches/:id/decide` | `ledger:recon:confirm` | **amended**: body gains `varianceTreatment` and optional `openItemId`; now posts |
| POST | `/v1/ledger/recon/matches/bulk-decide` | `ledger:recon:confirm` | zero-variance deterministic matches only; each posts its own transaction with its own key |
| POST | `/v1/ledger/recon/runs/:id/close` | `ledger:recon:run` | gives `closeRun()` its first caller |
| GET | `/v1/ledger/recon/runs/:id/variances` | `ledger:recon:read` | the variance queue |
| GET | `/v1/ledger/reports/statement-variance` | `ledger:recon:read` | |

**`decideMatch` becomes read-decide-then-write:**

1. read the match, its run, the linked open item and the tenant tolerance;
2. decide the treatment and compute the posting lines;
3. gate if the treatment requires it;
4. call `runTxn(ctx, "CMSN-SETL", args, { idempotencyKey: \`recon:${matchId}\` })`;
5. in the same write set as `runTxn`'s: the match update
   (`state`, `posted_txn_id`, `variance_treatment`, `confirmed_by`,
   `confirmed_at`) and the allocation row.

The idempotency key is `recon:{matchId}` and `ledger_txns_idem_uq` is the race
guard, so `gate()` uses `singleUse: false` — the DB already prevents the double
post and a consumed approval would only produce a confusing second prompt.

**It never writes a journal line directly.** The route header comment at
`routes/ledger.ts:1` — "no endpoint writes a journal line directly; money moves
by running a transaction type" — is the module's best property and this change
is written to preserve it.

Structurally forbidden:

- **No confirming a match whose transaction is in a hard-closed period.**
  `assertPostable` refuses; the answer is a contra in the open period.
- **No un-confirming.** Reverse the `CMSN-SETL`, which resets the match to
  `proposed` and clears `posted_txn_id`.
- **No closing a run with unposted confirmed matches.**
- **No bulk-deciding anything with a variance.** Bulk is for the boring ones.

New close check: **`no_unposted_confirmed_match@{code}`** — a confirmed match
with a null `posted_txn_id` means someone believes money moved and the ledger
disagrees.

Events: `ledger.recon.matched`, `ledger.recon.posted`,
`ledger.recon.variance_written_off`, `ledger.recon.run_closed`.

### K.3 Reporting

**`statement-variance`** — columns `statementRef` (text), `counterparty`
(text), `documentRef` (text), `expectedMinor` (money), `statementMinor`
(money), `varianceMinor` (money), `variancePct` (number), `treatment` (text),
`reasonCode` (text), `ageDays` (number), `postedTxnId` (text).
Drill-down: variance → match → both sides (our open item, their statement line)
→ the posted transaction.

**`recon-run-summary`** — columns `runId`, `statementRef`, `startedAt` (date),
`closedAt` (date), `linesTotal` (number), `matchedDeterministic` (number),
`matchedTolerance` (number), `matchedAi` (number), `unmatched` (number),
`variancePostedMinor` (money), `writtenOffMinor` (money).

The three-way split of match method on one row is what tells a controller
whether the AI pass is earning its cost.

**`statement-missing-both-ways`** — docs/19 §6's third queue, currently
unreported: our items with no statement line, and their lines with no item.
Columns `side` (text), `documentRef`, `counterparty`, `amountMinor` (money),
`ageDays` (number).

Screen: `ledger-recon.tsx` gains the variance queue as a third panel, with
per-row treatment selection and a bulk-confirm for zero-variance rows. Same
rebuild as §H.3 — the two features share a screen and should share one rebuild.

### K.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.recon_match_rate` | ratio 0–1 | month | `packages/ledger/src/recon.ts` | matched ÷ statement lines |
| `finance.recon_ai_contribution_ratio` | ratio 0–1 | month | recon | confirmed AI matches ÷ all confirmed |
| `finance.recon_ai_precision` | ratio 0–1 | month | recon | AI proposals confirmed ÷ AI proposals shown |
| `finance.statement_variance_minor` | minor units | month | recon | Σ absolute variance |
| `finance.statement_variance_bps` | basis points | month | recon | variance ÷ statement total × 10,000 |
| `finance.unposted_confirmed_matches` | count | day | recon | **target zero** |
| `finance.recon_close_lag_days` | days | month | recon | statement date → run closed |
| `finance.commission_leakage_minor` | minor units | month | recon | expected − received, signed, on settled items |

`commission_leakage_minor` is the one a broker's board cares about: it is the
money the provider owed and did not pay, and nothing in the system surfaces it
today.

`recon_ai_precision` is the kill-switch metric. If it falls below 0.70 the pass
should be turned off by default for that tenant, and the KPI exists so that is
an observation rather than an argument.

### K.5 AI surfaces

**Existing pass 3 is unchanged and is deliberately protected.** The injected
`MatchProposer`, the `AI_CONFIRM_FLOOR = 60`, the off-by-default `propose` flag
(`routes/ledger.ts:586-616`), the zero model-gateway dependency in
`packages/ledger` — `docs/27` names these as genuine strengths and nothing in
this spec touches them. The new posting step happens *after* human
confirmation, so adding it does not move the AI boundary by one line.

**✦ Variance explanation chip (new).** On a variance row, a chip offers a
one-line hypothesis: "✦ 1.5% short — matches the withholding rate on this
counterparty's last 6 statements."

- Purpose `recon.variance_explain`, tier `fast`, route layer, on demand only
  (the user clicks; no batch pre-generation, no cost for variances nobody
  looks at).
- Input: the variance, the counterparty's variance history, the applicable tax
  and agreement rates. Never free-text notes.
- Output: hypothesis + a suggested `reasonCode` from the existing enum.
- **Never selects the treatment.** It can suggest a reason code; a human picks
  `write_off` / `carry` / `dispute`, and `write_off` is separately gated.
- "Why": expands to the prior variances the pattern was drawn from, with dates
  and percentages.
- Eval `packages/model-gateway/evals/ledger/recon-variance-explain.eval.ts` —
  80 labelled variances across six causes (withholding, FX, fee netting,
  partial cancellation, rate dispute, timing); reason-code accuracy ≥ 0.75,
  and any explanation that asserts an unsupported number is a hard fail.

---

## L. F20 — Approval gates on forced close and reopen

> *"`closePeriod(force: true)` skips the checklist with no approval.
> `reopenPeriod` has no gate at all."*

Two lines of code, and they are the two lines that make every other control in
this module optional.

### L.1 Role design

New permissions `ledger:periods:force_close`, `ledger:periods:reopen`. New
policies `ledger.period_close_force` and `ledger.period_reopen`, both
`dualControl: "always"`, both `neverAutoApprove: true`.

A forced close is a controller saying "I know this is broken and I accept it."
That is exactly the kind of statement that needs a second name on it, and the
existing `ledger.period_close` policy is not it — that one covers the clean
close and can be auto-approved.

Reopening is higher-privilege than closing, which is why it gets its own
permission and is not folded into `ledger:periods:close`. Reopening a
hard-closed period after a statutory filing is a serious act; the code
currently treats it as a status flip.

### L.2 CRUD

Routes are **unchanged**. `POST /v1/ledger/periods/:code/close`
(`routes/ledger.ts:187-195`) and `POST /v1/ledger/periods/:code/reopen`
(`:197-201`) keep their paths, bodies and `require_` calls.

The gates go **inside** the functions (D10):

```
closePeriod(ctx, code, to, opts)                      // periods.ts:158
  … existing state checks …
  const checks = await closeChecks(ctx, code);        // :170
  const failed = checks.filter(c => !c.ok);           // :171
  if (failed.length) {
    if (!opts.force) throw conflict(...)              // :174-176, unchanged
    await gate(ctx, {
      policyKey: "ledger.period_close_force",
      subjectRef: `period:${code}`,
      context: { failedChecks: failed.map(c => c.name), to, reason: opts.reason }
    });
  }

reopenPeriod(ctx, code)                               // periods.ts:199
  const p = await ensurePeriod(ctx, code);
  if (p.state === "open") return p;                   // :201, no-op stays ungated
  await gate(ctx, {
    policyKey: "ledger.period_reopen",
    subjectRef: `period:${code}`,
    context: { from: p.state, reason }
  });
```

Both pass `amountMinor: undefined`, so `needsDualControl`
(`approvals.ts:165-171`) fails closed. Both are `singleUse: true`: there is no
DB unique index guarding a second force-close, so the approval itself has to be
consumed.

`reopenPeriod` gains a required `reason: string` (min 20 chars), threaded from
the route body. Reopening without a written reason is not a thing a finance
system should permit.

Structurally forbidden:

- **No `force` on a hard close from `open`.** Already refused
  (`periods.ts:166-168`); force does not override the soft-close-first rule,
  only the checklist.
- **No silent force.** The audit entry already records `forced: Boolean(opts.force)`
  and the failing checks (`periods.ts:188-193`); it gains the approval id.
- **No reopening a period whose fiscal year is closed** without first reversing
  the `YEAR-END-CLOSE`. New precondition.

Events: `ledger.period.force_closed`, `ledger.period.reopened` — both
high-severity, both routed to the compliance evidence stream so they appear in
an evidence bundle without anyone remembering to add them.

### L.3 Reporting

**`period-override-log`** — every forced close and every reopen. Columns
`periodCode` (text), `action` (text), `at` (date), `requestedBy` (text),
`approvedBy` (text), `failedChecks` (text), `reason` (text), `approvalId`
(text).

Empty in a healthy tenant. Not empty is the finding.

**`close-checklist-history`** — the stored `checklistJson` per period over
time, so a check that has been failing quietly for four months is visible as a
row of red rather than as four separate incidents.

Screen: `ledger-period-close.tsx` gains — per failing check — the count of
affected records and a drill-down to them, so "force" is a decision made with
the evidence rather than instead of it. The force button is disabled until a
reason of 20+ characters is entered, and it says which approver role is
required.

### L.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.forced_closes` | count | month | `packages/ledger/src/periods.ts` | forced closes |
| `finance.period_reopens` | count | month | periods | reopens |
| `finance.close_check_failures` | count | month | periods | failing checks at close time |
| `finance.days_to_close` | days | month | periods | period end → soft close |
| `finance.days_to_hard_close` | days | month | periods | period end → hard close |
| `finance.close_first_pass_rate` | ratio 0–1 | month | periods | closes with zero failing checks ÷ closes |

`close_first_pass_rate` is the health metric for the entire finance function.
`forced_closes` is the control metric. They are different numbers and both
belong on the controller's dashboard.

### L.5 AI surfaces

**None in the decision path.**

One read-only surface, which is not in the path: **✦ close-readiness
explainer**, purpose `close.readiness_explain`, which turns a failing check
into plain language and points at the records causing it
("✦ `subledger_tie_out` fails by 1,240.00 across 3 open items — most likely the
two receipts applied on the 29th"). It reads; it cannot close, cannot force,
cannot approve. Eval
`packages/model-gateway/evals/ledger/close-readiness-explain.eval.ts`, 40
seeded failure scenarios, correct-root-cause ≥ 0.70, and zero cases where it
tells the user the check can be safely ignored — that phrasing is a hard fail.

The gate itself is deterministic and stays that way. An approval that a model
could influence is not an approval.

---

## M. F21 — `SUCCESS-FEE` requires a verified metric snapshot

> *"docs/19 §7 requires a verified metric snapshot and both parties' sign-off.
> `RECIPES["SUCCESS-FEE"]` is `invoiceRaised` with no gate."*

docs/19 §11 obligation 10 states it as a property test, so this is both a
feature gap and a missing test.

### M.1 Role design

`ledger:fees:snapshot` to prepare, `ledger:fees:countersign` to countersign,
`ledger:fees:read` to view. Policy `ledger.fee_snapshot_countersign`,
`dualControl: "always"`, `neverAutoApprove: true`. The existing
`ledger.success_fee` policy (`approvals.ts:49`) is unchanged and still applies
to the posting.

So a success fee crosses three separate controls: internal countersign of the
measurement, the counterparty's own sign-off recorded as
`counterparty_signoff_ref`, and the posting approval. docs/19 §7 asks for
"verified metric snapshot + both parties' sign-off" and that is what those
three are.

`prepared_by ≠ countersigned_by` is enforced in the table (a check on write)
**and** by `approvals.ts:301-302`. Belt and braces on the one control that
directly authorises revenue recognition.

Snapshots expire after 90 days (`expires_at`). A metric verified last quarter
is not evidence about this one.

### M.2 CRUD

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/ledger/fee-snapshots` | `ledger:fees:read` | filters `agreementRef`, `state`, `period` |
| GET | `/v1/ledger/fee-snapshots/:id` | `ledger:fees:read` | includes the pinned north row and the hash |
| POST | `/v1/ledger/fee-snapshots` | `ledger:fees:snapshot` | `{agreementRef, metricKey, grain, period, dimsHash, baselineValue, feeBasisMinor, feeRatePpm, currency}`; reads `north_snapshots`, copies the value, computes `source_hash`; state → `draft` |
| POST | `/v1/ledger/fee-snapshots/:id/submit` | `ledger:fees:snapshot` | → `awaiting_countersign` |
| POST | `/v1/ledger/fee-snapshots/:id/countersign` | `ledger:fees:countersign` | gated; `{counterpartySignoffRef}`; → `verified` |
| POST | `/v1/ledger/fee-snapshots/:id/reject` | `ledger:fees:countersign` | `{reason}`; → `rejected` |
| POST | `/v1/ledger/txn/SUCCESS-FEE` | `ledger:invoices:create` | existing route; body gains required `feeSnapshotId` |

**Precondition `verifiedMetricSnapshot`** in `TXN_PRECONDITIONS["SUCCESS-FEE"]`:

```
args.feeSnapshotId is present                                       else badRequest
snapshot exists, tenant matches                                      else notFound
snapshot.state === "verified"                                        else conflict
snapshot.expires_at > ctx.now                                        else conflict
snapshot.consumed_txn_id is null                                     else conflict
snapshot.fee_amount_minor === args.amountMinor                       else badRequest
snapshot.currency === args.currency                                  else badRequest
sha256(canonical(north_snapshots row)) === snapshot.source_hash      else conflict
```

The last one is the interesting check. If the underlying NORTH snapshot has
been recomputed since sign-off, the hash no longer matches and the fee cannot
post until someone re-verifies. That is the difference between a snapshot and a
reference.

Idempotency key `success-fee:{snapshotId}` — the existing
`ledger_txns_idem_uq` makes exactly-once billing a database property.
`consumed_txn_id` is written in the same write set, purely as a record.

Structurally forbidden:

- **No editing `observed_value`, `fee_amount_minor` or `source_hash`** after
  `submit`. Withdraw and re-prepare.
- **No countersigning your own snapshot.**
- **No posting `SUCCESS-FEE` without `feeSnapshotId`.** The arg is required in
  the zod schema, so there is no path where it is absent.
- **No reusing a consumed snapshot.**
- **No deleting a snapshot.** Reject it; the rejected measurement is part of
  the story.

Events: `ledger.fee_snapshot.prepared`, `ledger.fee_snapshot.verified`,
`ledger.fee_snapshot.rejected`, `ledger.success_fee.posted`.

### M.3 Reporting

**`success-fee-register`** — columns `agreementRef` (text), `metricKey` (text),
`period` (text), `baselineValue` (number), `observedValue` (number),
`upliftValue` (number), `feeBasisMinor` (money), `feeRatePpm` (number),
`feeAmountMinor` (money), `state` (text), `preparedBy`, `countersignedBy`,
`postedTxnId`. Drill-down: snapshot → the pinned NORTH row → the metric's
underlying series → the posted invoice.

**`fee-snapshot-audit`** — every state transition with actor, timestamp, hash
at the time, and the approval id. The document produced when a client disputes
a fee.

Screen: `apps/web/app/routes/ledger-fee-snapshots.tsx`
(route `ledger/fee-snapshots`) — the metric series charted with the baseline
marked, the uplift computation shown as arithmetic rather than as a total, the
countersign panel (inert for the preparer), and a hash-integrity indicator that
turns amber the moment the source row moves.

### M.4 Analytics KPIs

| KPI | Unit | Grain | Computed in | Definition |
|---|---|---|---|---|
| `finance.success_fee_billed_minor` | minor units | month | ledger reports | Σ posted `SUCCESS-FEE` |
| `finance.success_fee_pipeline_minor` | minor units | month | ledger reports | Σ verified, unconsumed |
| `finance.snapshot_rejection_rate` | ratio 0–1 | month | ledger reports | rejected ÷ submitted |
| `finance.snapshot_countersign_lag_hours` | hours | month | ledger reports | median submit → countersign |
| `finance.snapshot_hash_mismatch_count` | count | day | ledger reports | verified snapshots whose source row has moved — **target zero** |
| `finance.success_fee_realisation_ratio` | ratio 0–1 | quarter | ledger reports | billed ÷ contractually eligible |

`snapshot_hash_mismatch_count` is another alarm as a KPI. A non-zero value
means a measurement changed after someone signed for it.

### M.5 AI surfaces

**✦ Countersignature request draft only.** When a snapshot reaches
`awaiting_countersign`, a background draft prepares the note to the
counterparty explaining the measurement: metric, baseline, observed, uplift,
resulting fee, and the method.

- Purpose `fee.countersign_draft`, tier `reasoning`, in `apps/agents`.
- **Numbers are interpolated from the snapshot row, never generated.** The
  model writes the connective prose around fixed values. Any output containing
  a number not present in the snapshot fails validation before it is shown —
  a deterministic check, not a scored eval criterion.
- Never sends. Outbound is `consequential: true`; the draft sits in the screen
  until a human sends it through the channel's own approval.
- "Why": shows the snapshot fields each sentence drew on.
- Eval `packages/model-gateway/evals/ledger/fee-countersign-draft.eval.ts` —
  50 snapshots across four metric families; numeric-fidelity must be 1.00
  (any drift is a hard fail), tone/completeness rubric ≥ 0.80.

**No AI verifies a snapshot, computes an uplift, or countersigns anything.**
The verification is a hash comparison and two human signatures. That is the
control docs/19 §7 asks for and it is not improvable by a model.

---

## N. F22 — Real property tests

> *"Four of the ten mandated property obligations are untested, and the tests
> are seeded-LCG fuzz, not property tests — fast-check is not a dependency."*

### N.1 Dependency

`fast-check` as a devDependency of `packages/ledger` and `packages/core`
(D13). It is the only new dependency in this spec. Seeded-LCG fuzz cannot
shrink, and a 400-line counterexample that will not shrink is a test that
nobody debugs and everybody quarantines.

### N.2 Arbitraries

`packages/ledger/src/testing/arbitraries.ts`:

```ts
export const arbMoney       // integer minor units, biased to boundaries: 0, 1, 99, 100, MAX_SAFE/2
export const arbCurrency    // from a fixed set incl. one zero-decimal currency
export const arbAccount     // drawn from CHART_OF_ACCOUNTS, tagged by type/clientMoney
export const arbPostingLine
export const arbTxnType     // drawn from TXN_TYPES, so a new type is covered the day it lands
export const arbRecipeArgs  // per-type, generated from the zod schema
export const arbTxnSequence // an ordered sequence of transactions with a shared tenant
export const arbFxRate      // ratePpm across 4 orders of magnitude, incl. 1:1
export const arbInterruption// an index at which a saga is cut
```

`arbTxnType` drawing from `TXN_TYPES` is the load-bearing one: every new
transaction type is automatically under all ten properties from the commit that
adds it, without anyone remembering to extend a fixture list.

### N.3 The ten obligations (docs/19 §11)

`packages/ledger/src/invariants.property.test.ts`, one property per obligation,
numbered to match the doc so the mapping is checkable by eye.

| # | Obligation | Property | Status today |
|---|---|---|---|
| 1 | Every batch balances in both currencies | for any `arbTxnSequence`, every batch has `Σdebit = Σcredit` and `Σbase debit = Σbase credit` | fuzz → property |
| 2 | `1010` ≥ `2010` after any client-money sequence | for any sequence of client-money transactions, `Σ client-money assets ≥ Σ client-money liabilities` at every step — **restated for the derived sets (§B.4), which is strictly stronger** | fuzz → property |
| 3 | No journal debits client-money assets to credit income/expense | for any generated recipe args, `post()` either rejects or produces no such batch | fuzz → property |
| 4 | Replay with the same idempotency key posts nothing new | for any transaction, running it twice leaves line count and balances identical | fuzz → property |
| 5 | Reversal returns net-zero economics, original intact | for any settled transaction, after reversal all account deltas sum to zero and the original batch is byte-identical | **untested** |
| 6 | Every payout has an approval with a distinct approver above threshold | for any payout above threshold, an approval row exists with `approvedBy ≠ requestedBy` | **untested** |
| 7 | Random saga interruption ends settled or fully compensated | for any `arbInterruption` index, the final state is `settled` or every posted batch has a contra | **untested** |
| 8 | Trial balance equals sum of journal lines at any point | after any prefix of any sequence, `ledger_account_balances` equals a from-lines rebuild | fuzz → property |
| 9 | Recognition schedules never recognise more than invoiced | for any schedule and any recognition sequence, `Σ recognised ≤ invoiced` | **untested** |
| 10 | `SUCCESS-FEE` cannot post without a verified metric snapshot | for any `SUCCESS-FEE` args and any snapshot state, posting succeeds iff the snapshot is `verified`, unexpired, unconsumed and hash-matching | **untested** (closed by §M) |

Four untested, exactly as the register says. Obligation 10 is closed by the F21
precondition; the other three are testing gaps against code that already
mostly works, and finding out which is which is the point.

### N.4 Additional properties for new behaviour

Not in docs/19 §11 — these guard this spec's own additions:

11. **Subledger ties out.** After any sequence, for every control account,
    `Σ open item outstanding = account balance`.
12. **Allocations never exceed the item.** `settled + written_off ≤ amount` for
    every open item, always.
13. **Bank line capacity.** `applied_minor ≤ amount_minor` for every bank line.
14. **FX revaluation is idempotent within a period** and cumulative across
    periods: revaluing twice at the same rate posts nothing the second time,
    and revaluing at rate A then rate B equals revaluing once at B.
15. **Year-end close zeroes income and expense** and moves exactly that sum to
    `3100`.
16. **Tax is always attributable.** Every line hitting `2200` carries a
    resolvable `taxRuleId` in its dims.

### N.5 CI, ratchets, reporting

- `pnpm test` runs properties at `numRuns: 100`; nightly runs at `numRuns: 5000`
  with a persisted failure corpus, so a rare counterexample found at 3am is a
  permanent regression test by morning.
- Every shrunk counterexample is committed as an example-based regression test
  next to the property. The property finds it once; the example keeps it found.
- Stryker mutation score on `packages/ledger` and `packages/core` stays
  ≥ 70% and raise-only (CLAUDE.md §7). Properties should move it materially —
  if they do not, they are asserting less than they appear to.
- A failing property is Sev-1, not Sev-2 flake. These are the invariants; a
  flaky invariant is a broken invariant.
- KPI `eng.property_obligations_covered` — count, target 10/10 — reported on
  the engineering dashboard, because "four of ten" is precisely the kind of
  fact that stays true for a year unless someone counts it monthly.

### N.6 AI surfaces

**None.** Obviously. Noted only because the pattern of this document is that
every feature says what it decided about AI, and "the test suite that verifies
the money is correct" is the last place to introduce a component that is
correct on average.

---

## O. Reporting index

Every report is a `ReportTable {title, columns[{key,label,kind}], rows,
currency, generatedAt}` on the existing `GET /v1/ledger/reports/:report`, with
an XLSX twin in `REPORT_EXPORTS` (`routes/ledger.ts:377-496`) at
`GET /v1/ledger/reports/:report/export`, permission-for-permission with the
JSON route and audited as `ledger.report.export`. Money cells carry minor
units; the renderer divides by 100. No new export mechanism.

| Report | Feature | Permission | Drill-down |
|---|---|---|---|
| `journal-register` | F2 | `ledger:journals:read` | → transaction → batch → lines |
| `manual-journal-control` | F2 | `ledger:journals:read` | → transaction → approval |
| `equity-movement` | F3 | `ledger:journals:read` | → journal register (filtered) |
| `income-statement` | F3 | `ledger:journals:read` | → account → lines |
| `premium-register` | F14 | `ledger:journals:read` | → open item → allocations |
| `insurer-payable-position` | F14 | `ledger:journals:read` | → open items (payable) |
| `aged-receivables` | F15 | `ledger:journals:read` | → open items → item → allocations |
| `aged-payables` | F15 | `ledger:journals:read` | → open items → item → allocations |
| `open-items` | F15 | `ledger:openitems:read` | → item → transaction |
| `collections-worklist` | F15 | `ledger:openitems:read` | → item → contact history |
| `bank-unapplied` | F16 | `ledger:bank:read` | → bank line → candidates |
| `cash-application-log` | F16 | `ledger:bank:read` | → allocation → transaction |
| `unapplied-aging` | F16 | `ledger:bank:read` | → `2360` lines |
| `tax-summary` | F17 | `ledger:tax:read` | → rule → lines carrying it |
| `tax-rule-history` | F17 | `ledger:tax:read` | → rule version → approval |
| `tax-exceptions` | F17 | `ledger:tax:read` | → transaction |
| `fx-exposure` | F18 | `ledger:fx:read` | → open items by currency |
| `fx-revaluation` | F18 | `ledger:fx:read` | → `FX-REVAL` batch → allocations |
| `fx-rate-history` | F18 | `ledger:fx:read` | → rate → revaluations using it |
| `statement-variance` | F19 | `ledger:recon:read` | → match → both sides → transaction |
| `recon-run-summary` | F19 | `ledger:recon:read` | → run → matches |
| `statement-missing-both-ways` | F19 | `ledger:recon:read` | → item or statement line |
| `period-override-log` | F20 | `ledger:periods:read` | → period → approval |
| `close-checklist-history` | F20 | `ledger:periods:read` | → period → failing records |
| `success-fee-register` | F21 | `ledger:fees:read` | → snapshot → NORTH series → invoice |
| `fee-snapshot-audit` | F21 | `ledger:fees:read` | → transition → approval |

Existing reports changed, not added: `balance-sheet` (equity becomes a real
section, §E.3), `aged` (superseded by the two due-date reports; kept as an
alias for one minor version, then removed).

### Screens

| Route | File | Feature | Notes |
|---|---|---|---|
| `ledger/journal`, `ledger/journal/:id` | `ledger-journal.tsx` *(new)* | F2 | line grid, running totals, approval panel |
| `ledger/year-end` | `ledger-year-end.tsx` *(new)* | F3 | period checklist, preview, two-stage confirm |
| `ledger/open-items`, `ledger/open-items/:id` | `ledger-open-items.tsx` *(new)* | F15 | subledger browser |
| `ledger/collections` | `ledger-collections.tsx` *(new)* | F15 | worklist, ✦ prioritiser |
| `ledger/bank` | `ledger-bank.tsx` *(new)* | F16 | upload, statement list, line browser |
| `ledger/tax-rules` | `ledger-tax-rules.tsx` *(new)* | F17 | effective-dated timeline, resolve preview |
| `ledger/fee-snapshots`, `…/:id` | `ledger-fee-snapshots.tsx` *(new)* | F21 | series chart, countersign panel |
| `ledger/recon` | `ledger-recon.tsx` *(rebuild)* | F16, F19 | file drop replaces the JSON textarea at `:521`; two-panel allocation; variance queue |
| `ledger/period-close` | `ledger-period-close.tsx` *(extend)* | F18, F20 | FX panel, per-check drill-down, gated force |
| `ledger/money-map` | `ledger-money-map.tsx` *(extend)* | F14 | derived client-money sets, funded/unfunded split |
| `ledger/transactions` | `ledger-open-txn.tsx` *(extend)* | F14, F17 | typed forms replace the raw JSON args at `:79-120` |

All new screens: story in the design-system playground, mobile parity noted,
logical CSS properties only, keyboard-complete, status never colour-only
(CLAUDE.md DoD + §7/§8).

---

## P. KPI index

All KPIs are computed in `packages/ledger` (reports, recon, periods, posting)
and snapshotted into `north_snapshots` by the existing NORTH collector. None is
computed twice, and none is computed in the web layer.

Units are one of: **minor units** (integer, in the stated currency),
**basis points** (integer, ÷10,000), **ratio** (0–1 real), **days**, **hours**,
**seconds**, **count**.

| Domain | Count | Alarm KPIs (target zero / paging) |
|---|---|---|
| Manual journals (F2) | 5 | — |
| Equity (F3) | 5 | — |
| Accrual (F14) | 8 | `client_money_surplus_minor` < 0 |
| Open items (F15) | 8 | — |
| Cash application (F16) | 7 | — |
| Tax (F17) | 5 | `tax_unresolved_count` > 0 |
| FX (F18) | 5 | `fx_rate_staleness_days` > 3 |
| Recon (F19) | 8 | `unposted_confirmed_matches` > 0 |
| Close (F20) | 6 | `forced_closes` > 0 |
| Success fee (F21) | 6 | `snapshot_hash_mismatch_count` > 0 |
| Testing (F22) | 1 | `property_obligations_covered` < 10 |

Sixty-four KPIs, six of them alarms. The alarms are the ones that should exist
whether or not anyone builds a dashboard; the rest are for the dashboard.

Controller's daily view: `client_money_surplus_minor`,
`unapplied_minor`, `overdue_receivable_minor`, `unposted_confirmed_matches`,
`tax_unresolved_count`, `fx_rate_staleness_days`.

Month-end view: `close_first_pass_rate`, `days_to_close`, `forced_closes`,
`dso_days`, `commission_leakage_minor`, `statement_variance_bps`.

Board view (via NORTH): `gwp_booked_minor`, `commission_rate_bps`,
`net_margin_ratio`, `dso_days`, `write_off_ratio_bps`, `equity_minor`.

---

## Q. AI surfaces index

| Feature | Surface | Purpose | Pattern (docs/15 §4) | Tier | Can it commit? | Eval |
|---|---|---|---|---|---|---|
| F2 | account suggestion | `journal.account_suggest` | ghost completion | fast | no — suggests a field value | `journal-account-suggest.eval.ts` |
| F3 | **none** | — | — | — | — | — |
| F14 | booking anomaly chip | `premium.anomaly` | quiet chip | fast | no — post-hoc, statistic-triggered | `premium-anomaly.eval.ts` |
| F15 | collections prioritiser | `collections.prioritise` | background draft | reasoning | no — drafts, never sends | `collections-prioritise.eval.ts` |
| F16 | remittance reader | `bank.remittance_read` | background draft | fast | no — emits tokens, matcher decides | `bank-remittance-read.eval.ts` |
| F17 | **none** | — | — | — | — | — |
| F18 | **none** | — | — | — | — | — |
| F19 | match proposer *(existing)* | `recon.match` | quiet chip | reasoning | no — floor 60, human confirms | existing |
| F19 | variance explanation | `recon.variance_explain` | quiet chip | fast | no — suggests a reason code only | `recon-variance-explain.eval.ts` |
| F20 | close-readiness explainer | `close.readiness_explain` | quiet chip | fast | no — read-only | `close-readiness-explain.eval.ts` |
| F21 | countersign draft | `fee.countersign_draft` | background draft | reasoning | no — numbers interpolated, never sends | `fee-countersign-draft.eval.ts` |
| F22 | **none** | — | — | — | — | — |

Rules holding across all of them:

- Every one goes through `packages/model-gateway` with tenant, module
  (`ledger`), purpose, actor, and lands in `ai_audit_log`. `packages/ledger`
  keeps **zero** model-gateway dependency: gateway-backed functions are
  injected at the route or agent boundary, exactly as `MatchProposer` is today.
- Every one requires `ledger:ai:invoke` (`rbac.ts:162`).
- Every artifact carries the single ✦ marker and an inspectable "why" that
  expands to *records*, not to prose about records.
- **None can commit a consequential action.** Not one of them posts, approves,
  applies, closes, sends or countersigns.
- Eval-first, without exception: the golden set and thresholds are authored
  before the prompt (CLAUDE.md TDD §4). Two of the evals have hard-fail
  criteria rather than thresholds — fabricated references (F16) and numeric
  drift (F21) — because those are correctness bars, not quality scores.
- Every prompt reads its nouns from the active domain pack (CLAUDE.md #14).
  No system prompt in this spec contains "policy", "premium" or "insurer".

---

## R. Where the code fights this design

Ordered by how much it hurts. Every one is a place where the spec wins
(CLAUDE.md: "If a spec and its acceptance test disagree, fix the test to match
the spec — the spec wins") and the route around is named.

**R1. `packages/ledger/src/reports.ts:383` — derived equity, with a comment
defending it.**

```ts
const equityMinor = income - expense + tb.rows.filter((r) => r.type === "equity")…
```
preceded by *"Retained earnings are derived, not posted: a closing journal
would be a second source of truth for the same number."*

The comment is a coherent position and it is the wrong one. Without a posted
close, retained earnings cannot be audited, prior years cannot be locked, and
`closePeriod` can only ever flip a status (which is F3 verbatim).
**Route around:** post the close (§E), replace the plug with the `3100` balance
plus a *labelled* unposted current-year line, and rewrite the comment to say
why the derivation now applies only to the open year. The comment must change
in the same commit; leaving a comment that argues against the code is how the
next person reverts it.

**R2. `packages/db/src/chart-of-accounts.ts:19-61` — the chart is a hard-coded
TypeScript constant, while `docs/19 §5.1` calls it "tenant-scoped,
extensible".**

The `ledger_accounts` table exists and is not the source of truth. Eight new
codes therefore require a deploy.
**Route around:** accept it for this spec (D12) and add the eight rows. Every
feature here works with a fixed chart. Flagged in §S as needing an ADR, because
the doc and the code disagree today and one of them has to move.

**R3. `packages/ledger/src/posting.ts:370-403` — `clientMoneyCheck` reads two
singular constants.**

`CLIENT_MONEY_ACCOUNT` and `CLIENT_MONEY_LIABILITY_ACCOUNT` (`chart-of-accounts.ts:70-71`)
are singular, so accrual accounting cannot express "money held for a provider"
without either breaking the invariant or being invisible to it.
**Route around:** derive the two sets from the chart's `clientMoney` flag
(§B.4), keep both constants exported for back-compat, and add `2005`. The
change is **monotone** — it adds to the liability side only — so any previously
valid state stays valid. `2400` is deliberately left out to avoid manufacturing
historical breaches.

**R4. `packages/core/src/commission.ts:56` — `input.taxPpm ?? 0`.**

```ts
const taxMinor = applyPpm(grossMinor - channelMinor, input.taxPpm ?? 0);
```

The `?? 0` is the entire F17 defect in eight characters: every caller that
forgets tax gets zero tax, silently, forever.
**Route around:** remove the optionality. `splitCommission` takes
`{taxRuleId, taxRatePpm}`, both required; `quoteCommission` resolves before it
splits; zero tax must be asserted with an exempt/reverse-charge rule or an
explicit reason (§I.2). This is a breaking signature change inside
`packages/core` with callers in `packages/ledger` and `apps/api` — do it in one
commit, because a deprecation period here means a period during which tax is
optional.

**R5. `packages/ledger/src/reports.ts:415` — aging account codes are hard-coded
and aging is by `postedAt`.**

```ts
const codes = opts.accountCodes ?? ["1100", "1150", "1160"];
```

`1200` is absent, payables are absent, and there is no due date on a journal
line to age by.
**Route around:** do not extend it. `aged-receivables` / `aged-payables` read
`ledger_open_items` (§G.3); account codes come from the chart filtered by type.
Keep `agedBalances()` for one minor version behind the `aged` alias, then
delete it — two aging implementations is how two aging numbers happen.

**R6. `apps/api/src/engines/settlement.ts:99-106` — `assertPayable` refuses
`insurer`.**

> `${kind} settlements are money in, not out; collect them with CMSN-SETL
> against the provider remittance`

Correct today (nothing posts `CMSN-SETL` from recon — that is F19) and wrong
after F19 lands: `PREM-REMIT` is genuinely money out to a provider.
**Route around:** F19 makes the message's own advice true, so the refusal stays
until `decideMatch` posts. Then `PAYABLE_KINDS` gains `provider` and the
settlement engine handles provider remittance through the same statement +
`externalRef` + `paidVia` flow it already has for partners. The remittance
advice builder at `settlement.ts:658-702` is, as the register says, good and
pointed at the wrong kind — it needs a `counterparty_kind` parameter, not a
rewrite. `ledger_settlements` already permits `counterparty_kind = "insurer"`
in the schema, so the DB is ahead of the engine here; sequence F19 before the
settlement change or the engine will accept a remittance it cannot reconcile.
*(Note for the vocabulary pass: the string `insurer` in `PAYABLE_KINDS` is a
docs/21 violation in its own right — it should be `provider`.)*

**R7. `packages/ledger/src/periods.ts:174` and `:199-213` — force and reopen
are ungated.**

`if (failed.length && !opts.force)` and a `reopenPeriod` that flips state with
no approval at all.
**Route around:** gate inside the functions, not at the route (§L.2, D10).
`routes/ledger.ts:187-201` is one caller; the close run, the year-end flow and
any future scheduler are others, and a route-level gate protects exactly one of
them.

**R8. Recipe purity vs. open-item emission.**

`RECIPES` entries are pure `(args) => PostingLine[]`. Open items need
`due_at`, a counterparty reference and a document reference — data that is in
the args but not in a `PostingLine`.
**Route around:** a parallel pure registry `OPEN_ITEM_EMITTERS` (§G.2) keyed by
the same transaction code, whose output `post()` appends to the same write set.
Recipes stay pure and synchronous; nothing becomes async; nothing writes twice.
Rejected alternative: widening `PostingLine` with subledger fields, which would
put document metadata on every line of every transaction type forever.

**R9. `apps/web/app/routes/ledger-recon.tsx:521` — statement import is a JSON
textarea.**

**Route around:** rebuilt as part of the shared F16/F19 screen work (§O). Note
the sequencing: F16 (parsers, bank lines) must land before the screen rebuild,
or the rebuild has nothing to drop a file into.

**R10. `apps/web/app/routes/ledger-open-txn.tsx:79-120` — raw JSON args.**

Every new transaction type in §C would otherwise ship as another JSON blob a
human types by hand into a money system.
**Route around:** generate typed forms from the recipe zod schemas. The schemas
are already the single source of truth for argument shape; the form is a
rendering of the schema, not a second definition of it. This is a prerequisite
for F2, F14 and F16 being usable, not a polish item.

**R11. `packages/ledger/src/recon.ts:382-390` — `closeRun()` has no callers.**

Dead code in the money path.
**Route around:** F19 gives it a caller and a precondition
(`POST /v1/ledger/recon/runs/:id/close`, §K.2). If F19 slips, delete the
function — an unreferenced close path is worse than no close path because it
looks like the feature exists.

**R12. `packages/ledger/src/recipes.ts:398` — `CREATOR-SPEND` has no
`TXN_TYPES` entry.**

Unreachable recipe.
**Route around:** delete it (§C.1). If creator spend is real, it needs a tuple
and a policy; if it is not, it should not be in the file that defines what the
system can post.

**R13. Commission is flat-rate only (`packages/core/src/commission.ts:84-108`).**

`resolveRate` does most-specific-wins over a single `rate_ppm`. Broking
agreements routinely use tiered or sliding scales, and `premiumBooking` takes
`commissionMinor` as a given, so F14 does not depend on this.
**Route around:** out of scope, and the design is written so it stays out of
scope — the caller computes commission, the recipe posts it. When tiered scales
arrive they change `quoteCommission` and nothing in this spec.

**R14. `packages/db/src/schema/north.ts` — `north_snapshots` has no
verification concept.**

`(metric_key, grain, period, dims_hash)` and a value, nothing about sign-off.
**Route around:** `ledger_fee_metric_snapshots` pins a copy plus a
`source_hash` (§B.1). Deliberately not a change to NORTH: verification for
billing is a ledger concern, and adding sign-off state to the analytics
snapshot table would put a finance control in an analytics table where it can
be recomputed.

**R15. CAMT.053 is XML and there is no XML parser in the dependency tree.**

MT940 and OFX parse with regex per tag; CAMT.053 does not, safely.
**Route around:** three options, in ladder order. (a) Ship MT940 + OFX first
and CAMT.053 second — most tenants can export at least one of the three. (b)
Parse the CAMT subset with a small hand-rolled tag reader — viable because the
subset is shallow and fixed, and it avoids a dependency in a code path that
eats untrusted files. (c) Add `fast-xml-parser`. **Recommendation: (a) then
(b), escalate to (c) only if a real statement breaks the hand-rolled reader.**
Either way this is a dependency decision that needs a call before F16 starts —
see §S.

**R16. Route naming: `POST /v1/ledger/txn/:type` is singular.**

Every other collection in the API is plural. Eleven new types make the
inconsistency more visible.
**Route around:** leave it. Renaming is a breaking API change, versioned under
`/v1`, for an aesthetic gain. Noted so it is a decision rather than an
oversight.

**R17. `docs/19 §5.1` lists no `3xxx` codes.**

The doc's own chart has no equity accounts, so F3 cannot be built without the
doc changing first. Spec-first: see §S.

---

## S. What needs an ADR or a docs edit before implementation

CLAUDE.md is explicit that the spec wins over code and that docs are touched
when behaviour diverges. Five items must land **before** the corresponding
code.

**S1. `docs/19-transactions-and-ledger.md §5.1` — add the equity range.**
*Docs edit, blocking F3.* Add `3000` Share Capital, `3100` Retained Earnings,
`3200` Current-Year Earnings, plus a `§5.2 H` worked entry for
`YEAR-END-CLOSE`. Also add `2005`, `2360`, `4085`, `5500`, `5600`. Without this
the chart in code and the chart in the doc disagree on day one.

**S2. `docs/19 §5.2 B` — add the accrual client-money entries.**
*Docs edit, blocking F14.* The worked example shows only the cash-basis flow
(`CM-RECEIPT` / `PREM-REMIT` / `CM-TRANSFER`) and states the invariant as
"`1010` ≥ `2010`". The accrual flow needs `PREM-BOOK` / `PREM-RECEIPT` /
`PREM-SWEEP` worked through, and the invariant restated as
"`Σ client-money assets ≥ Σ client-money liabilities`". Changing the wording of
a stated regulatory invariant is not something to do in a code comment.

**S3. ADR — "Client-money account membership is derived from the chart."**
*Blocking F14.* Replacing two named constants with two derived sets changes how
the module's most important safety property is computed. The ADR must record:
the monotonicity argument (§B.4), why `2005` is client money and `2000` is not,
why `2400` is excluded for now, and what a tenant must check before flipping
`clientMoney` on any future account.

**S4. ADR — "Equity is posted at year end; retained earnings stop being
derived."** *Blocking F3.* `reports.ts:383` carries an explicit design comment
arguing the opposite (R1). Overturning a documented decision needs a recorded
decision, not a diff.

**S5. ADR — "`fast-check` as a test dependency" and the CAMT.053 parser
decision.** *Blocking F22 and F16 respectively.* CLAUDE.md forbids third-party
services beyond docs/02 §9 without an ADR and says novelty needs one.
`fast-check` is a devDependency and uncontroversial, but docs/19 §11 mandates
property-based testing without naming a tool, so the choice should be recorded
once. The CAMT.053 question (R15) is the same ADR: it is a decision about
parsing untrusted input in the money path and it should be written down before
someone reaches for the first XML library that appears in a search.

Two more that are recommended but not blocking:

**S6. ADR — "Tenant-extensible chart of accounts."** *Not blocking; resolves
R2.* `docs/19 §5.1` says "tenant-scoped, extensible" and the code says
otherwise. Either the doc or the code is wrong and the disagreement should be
closed deliberately. This spec proceeds on the current code (D12).

**S7. `docs/21` vocabulary pass over the ledger module.** *Not blocking.*
`PAYABLE_KINDS` contains `"insurer"` (`settlement.ts:39`); the register itself
uses "insurer statement". The chart's account names are ledger identifiers and
may stay, but enum values that flow into UI labels and system prompts are
squarely inside CLAUDE.md #14. Rename `insurer` → `provider` when R6 is
addressed, not as a separate sweep.

---

## T. Build order

Outside-in per CLAUDE.md: each block starts with its failing acceptance specs
(`@accept:` tagged) and its journey specs (`@journey:` tagged), then unit
cycles underneath.

| # | Block | Delivers | Depends on | Gated by |
|---|---|---|---|---|
| 0 | Foundations | `fast-check`, arbitraries, the six untested/weak properties (§N.3 1–10) against **current** behaviour | — | S5 |
| 1 | Chart + derived sets | eight chart rows, `CLIENT_MONEY_*_ACCOUNTS`, `clientMoneyCheck` over sets, property 2 restated | 0 | S1, S3 |
| 2 | F20 close gates | two `gate()` calls, two policies, two permissions, `period-override-log` | — | — |
| 3 | F17 tax resolver | `resolveTaxRule`, `splitCommission` signature, zod refinements, tax reports | 1 | — |
| 4 | F2 manual journals | `MANUAL-JRNL`, `OPEN-BAL`, `TXN_PRECONDITIONS`, drafts, journal screen | 1, 2 | — |
| 5 | F3 year-end close | `YEAR-END-CLOSE`, balance-sheet rework, equity reports | 1, 4 | S1, S4 |
| 6 | F15 open items | two tables, `OPEN_ITEM_EMITTERS`, aging reports, `subledger_tie_out` check | 1 | — |
| 7 | F14 accrual | four transaction types, `2005` flow, premium reports | 1, 3, 6 | S2 |
| 8 | F16 cash application | `ledger_bank_lines`, three parsers, `CASH-APPLY`, recon screen rebuild | 6, 7 | S5 (CAMT) |
| 9 | F18 FX revaluation | `FX-REVAL`, cumulative algorithm, `fx_revalued` check, exposure reports | 6 | — |
| 10 | F19 recon posting | `decideMatch` posts, `closeRun` lives, variance queue | 6, 8 | — |
| 11 | F21 success fee | snapshot table, precondition, countersign flow | 4 | — |
| 12 | F22 closeout | properties 11–16, nightly corpus, mutation ratchet | all | — |

Block 0 first is deliberate. The properties are written against current
behaviour before anything changes, so the four untested obligations are either
confirmed working or found broken *before* eleven new transaction types are
layered on top. Writing them last would mean writing them against code this
spec wrote, which tests the author's assumptions rather than the invariant.

Block 2 before everything else it does not depend on: while force-close is
ungated, every other control in this document is advisory.

Onboarding change to schedule with block 2: a tenant with fewer than two
finance seats cannot post a manual journal, force a close, reopen a period or
pay a success fee. That is correct behaviour (§A.2) and it must be surfaced at
setup, not discovered at month end.

# ADR-0083 — The chart of accounts is tenant data, not a deploy, and period
close gains a subledger tie-out, a recon-complete check and a suspense check

**Date:** 2026-09-20
**Status:** Accepted
**Builds on:** docs/19 §5.1 (chart of accounts), docs/19 §6 (period close),
docs/27-feature-gap-register.md P2 ("chart of accounts is a hard-coded
TypeScript constant, so a tenant cannot add an account without a deploy" and
"period-close checks are three deterministic tests with no subledger tie-out,
no recon-complete and no suspense check"), CLAUDE.md §1 (tenancy first), §2
(one schema, two homes), §9 (migrations are forward-only), F17/ADR-tax-rulepack
precedent (`packages/core/src/tax.ts`)
**Closes:** the two P2 findings named above

## Context

`packages/db/src/chart-of-accounts.ts` exports `CHART_OF_ACCOUNTS`, a
hard-coded array of `AccountDef` (code, bilingual name, type, normalSide,
`clientMoney?`), and a synchronous `account(code)` lookup over it. Every
reader of the chart — `packages/ledger/src/posting.ts`,
`packages/ledger/src/reports.ts`, `packages/ledger/src/money-map.ts`,
`apps/api/src/routes/ledger.ts`'s `/reports/chart-of-accounts` — imports the
static constant directly. Adding an account today means adding a line to a
TypeScript file and shipping a release.

The finding is narrower than it first reads, though, because the table already
exists and is already the seed target. `ledger_accounts` (`packages/db/src/
schema/ledger.ts:95-111`) is `tenant_id, code, name_json, type, normal_side,
client_money, currency, parent_code, status`, unique on `(tenant_id, code)`,
documented in its own comment as "tenant-scoped and extensible" — and
`seed()` already inserts one row per `CHART_OF_ACCOUNTS` entry per tenant
(`packages/core/src/seed.ts:281-296`), with `syncChartOfAccounts` as the
existing backfill for a tenant seeded before an account was added to the
constant (`seed.ts:2406-2434`, wired to `POST /v1/auth/demo/resync-roles`
alongside the other three provisioned-once catalogues). So this is dead seam
17: a table declared, seeded and even kept in sync — with no reader anywhere
in the product. The bug is not "there is nowhere to add a tenant account"; a
row can already be inserted. The bug is that nothing downstream would ever see
it, because every reader still asks the static file instead of the table an
extra account would actually land in.

Separately, `packages/ledger/src/periods.ts`'s `closeChecks` runs four
checks today (docs/27 undercounts it as three — `trial_balance_zero`,
`batches_match_lines`, `no_pending_external` and `no_open_client_money_
breach` are all there), all of them global ledger-health invariants rather
than tie-outs to anything outside the ledger itself. Missing: whether a
subledger (open receivables/payables) agrees with the GL control account it
rolls up to, whether every reconciliation run touching the closing period has
actually reached a terminal state, and whether a clearing/suspense account is
sitting on an unexplained balance at the moment the month is frozen.

## Decision

### 1. The chart of accounts becomes tenant data read at runtime; the constant
becomes seed data only

`CHART_OF_ACCOUNTS` stays exactly as it is — codes, bilingual names, type,
normalSide, `clientMoney` — but its role changes from "the chart" to "the
default chart every tenant is seeded with", the same relationship `PEOPLE` in
`seed.ts` already has to seeded staff, and the same shape as `docs/19 §5.3`'s
tax rulepack (F17, `packages/core/src/tax.ts`): a compiled default, a
per-tenant table it is written into once, and a typed reader that goes through
the table, never the constant, from that point on.

`packages/core/src/chart.ts` (new, mirroring `tax.ts`'s shape exactly) is the
one seam every runtime reader routes through:

- `tenantChart(ctx): Promise<TenantAccount[]>` — every account row for
  `ctx.tenantId`, tenant-scoped through `scoped()` (CLAUDE.md §1), the same
  helper `lens.ts` and `entitlements.ts` already route through.
- `tenantAccount(ctx, code): Promise<TenantAccount | undefined>` — one row,
  for the call sites that only need one account.
- `TenantAccount` carries everything `AccountDef` did (`code`, `en`, `ar`,
  `type`, `normalSide`, `clientMoney?`) plus `suspense?` (new, see §3) and the
  row's own `id`/`status`, so a caller reading `.normalSide` or `.clientMoney`
  off the result needs no other change.

Readers moved onto this seam, because they read live tenant data (an
account's existence, name or normal side) and must reflect an account a
tenant added at runtime:

- `packages/ledger/src/posting.ts` — `post()`'s "does this account exist"
  check, `balanceOf()`'s and `clientMoneyCheck()`'s normalSide lookups. All
  three already take `ctx`, so this is a lookup-shape change (`account(code)`
  → `await tenantAccount(ctx, code)` / a `Map` built once per `post()` call),
  not a signature change for any external caller.
- `packages/ledger/src/reports.ts` — every report that renders an account's
  name, type or normal side (`accountStatement`, `agedBalances`,
  `agedOpenItems`, `balanceSheet`, `profitAndLoss`, `chartOfAccountsTable`).
  `chartOfAccountsTable()` gains a `ctx` parameter for exactly this reason —
  a chart-of-accounts *report* that cannot show an account a tenant added is
  the finding, restated.
- `packages/ledger/src/money-map.ts` — `INCOME_ACCOUNTS` becomes a per-tenant
  set built from `tenantChart(ctx)` inside the function that uses it, rather
  than a module-level constant.
- `apps/api/src/routes/ledger.ts`'s `/reports/chart-of-accounts` and
  `/reports/account-balance/:code` routes, which already hold `ctx`.

**`packages/ledger/src/recipes.ts` is the one caller kept on the static
constant, by design, not by omission.** Its own header says why it exists:
"no database, no state, no side effects — so every posting shape in the
system is unit-testable in isolation" (docs/19 §5.2 A–G). A recipe is a fixed
posting shape in a fixed catalogue — adding a new *recipe* is already a
deploy, same as adding a new transaction type — and its `account(code)?
.clientMoney` / `account(code)?.normalSide` calls are structural validation
against that fixed catalogue's own accounts (1010, 2010, 3xxx, the default
`clearingAccount`/`writeOffAccount` codes), not a query over what a specific
tenant happens to have added. Making recipes tenant/DB-aware would cross an
explicit architectural boundary to fix a bug that does not live there: a
recipe never rejects an account for not being in `CHART_OF_ACCOUNTS` in a way
that would stop a tenant-added account from posting — `posting.ts.post()` is
the one gate that actually enforces "does this account exist", and that gate
is the one moved to tenant data above. If a future recipe needs a tenant's own
account (not one of the fixed structural codes), that is new recipe design,
not this ADR.

`packages/core/src/seed.ts` is unchanged in shape: it already writes
`ledger_accounts` rows from `CHART_OF_ACCOUNTS` at `seed()` and backfills
missing codes via `syncChartOfAccounts`. Both keep reading the constant —
that is correct, since seeding is exactly the "materialize the default into
the tenant table" step this ADR relies on, not a runtime read that should
move.

### 2. No UI in this pass

`ledger_accounts` already accepts an insert; nothing in this pass adds a
screen for a tenant to add one. That is follow-up work, tracked here rather
than built now: a workspace tab under `modules/ledger.ts` (`accounts` as a
spec-driven resource, following the `WORKSPACES` convention every other
tenant-editable catalogue uses) plus a guard that a tenant may add an account
but never edit `code`, `normalSide` or `clientMoney` on the seeded rows
(docs/19 §5.1's own comment: "tenants may add accounts, never remove or
renumber these").

### 3. `suspense` is a new column, not inferred

No account in `CHART_OF_ACCOUNTS` was flagged as a clearing/suspense account
before this ADR — 1300 "PSP Clearing" is the only one whose entire purpose is
to hold a balance that must clear to zero, so it is the one flagged
`suspense: true`. The flag lives beside `clientMoney` on the same type and the
same table, for the same reason: a boolean a period-close check reads, not a
name pattern it would have to infer.

### 4. Three new period-close checks, same mechanism as the existing four

`closeChecks` gains three entries, each a `CloseCheck` exactly like the four
already there — `{ name, ok, detail? }`, appended to the same array, subject
to the same `force` override in `closePeriod` (docs/27 F20: forcing is a
decision, audited with the reason and the overridden check names, never a
silent flag). No second close-check mechanism; these read the same way the
existing four do, off the same `ctx`.

- **`subledger_ties_to_control`.** `reports.ts` already computes the
  subledger's own total independently of the balances cache:
  `agedOpenItems`'s item-netted sum over `RECEIVABLE_AGING_ACCOUNTS` and
  `PAYABLE_AGING_ACCOUNTS` (docs/27 F15) is the subledger detail; the same
  account codes' rows in `ledger_account_balances` are the GL control balance
  the existing `trial_balance_zero` check already trusts. The two are
  computed from the same `ledger_journal_lines` by two different paths — one
  summing lines directly and netting by item, one reading the incrementally
  maintained cache — so a mismatch means the cache drifted from the lines it
  is supposed to mirror, which is exactly the class of bug `rebuildBalances`
  exists to repair (`reports.ts`'s own docstring: "the balances table is a
  cache we can always rebuild and check against"). The check is a tie-out
  precisely because it never assumes agreement — it queries both and
  compares, per account code.
- **`recon_complete`.** Every `ledger_recon_runs` row for this tenant whose
  `period` equals the period being closed must be `state = 'closed'`
  (`recon.ts`'s own state machine — `running|review|closed|failed` — reused
  as-is, no new status introduced). A run left `running`, `review` or
  `failed` for the period blocks close and names the process and
  counterparty in its detail, the same shape `closeChecks`' other checks
  already use (`plural()`, a joined list of what is outstanding).
- **`no_suspense_balance`.** Every account with `suspense: true` in this
  tenant's chart (via `tenantChart(ctx)`, §1) must net to zero across
  currencies in `ledger_account_balances`, signed by its own `normalSide`. A
  tenant with no suspense-flagged account (there is always at least 1300, but
  a future tenant chart could in principle have none) passes trivially — the
  check is "nothing outstanding", not "an account exists".

All three are hard blocks by default, force-overridable exactly like the
existing four: `closePeriod({ force: true, reason })` accepts the break and
records which checks it overrode, same as today.

## Consequences

- A tenant-added account is now visible to every report and postable through
  `post()` without a deploy, closing the finding as stated.
- `chartOfAccountsTable()`, `agedOpenItems`, `balanceSheet` and
  `profitAndLoss` all take (or already took) `ctx`; none gained a new
  required parameter a caller does not already have in scope.
- `recipes.ts` is explicitly out of scope, and future readers of this ADR
  should not "finish the job" by wiring it to tenant data — that would violate
  the pure-builder boundary docs/19 §5.2 states outright.
- Period close is measurably stricter: a tenant whose subledger has drifted
  from its control account, whose reconciliation is not actually finished, or
  who is carrying an unexplained clearing-account balance cannot close
  silently. All three are overridable the same way every existing check is,
  so this adds rigor without adding a new escape hatch.
- Follow-up, not built here: the accounts workspace tab (§2) and extending
  `suspense` to any future clearing account a tenant's own chart introduces.

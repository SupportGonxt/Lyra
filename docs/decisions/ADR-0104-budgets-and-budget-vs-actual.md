# ADR-0104 — Budgets and budget vs actual

Date: 2026-09-27 · Status: accepted

## Context

The module review (docs/30, Ledger 4) found no budgets and no budget-vs-actual
report; docs/27 recorded the same gap. A controller plans each account's month
and wants to see the month's postings against that plan. Four choices had to
be made: what a budget is keyed by, how currencies meet, whether setting one
needs an approval, and who may see it.

## Decision

1. **A budget is one account, one month, one currency.** `ledger_budgets`
   (`tenant_id`, `account_code`, `period` `YYYY-MM`, `currency`, `amount_minor`,
   `note`), unique on tenant + period + account + currency. The amount is the
   expected movement on the account's normal side, so it is never negative.
   It is served by the generic resource registry at `/v1/ledger/budgets`. A
   write is refused unless the account is in the tenant's own chart (the
   `tenantAccount` seam, ADR-0083), the period is a real month and the
   currency is three upper-case letters. The merged row is checked, so an
   edit cannot move a budget onto an unknown account.
2. **Currencies never meet.** A budget is compared only with lines posted in
   its own currency, in that currency's minor units (`amount_minor`, not
   `base_amount_minor`). An account that moved in USD against an AED budget
   gets two rows. Converting would add an FX-rate choice to every row, and a
   stale rate would read as a variance. `compareBudgets` is property-tested:
   the sum of the actuals in each currency equals that currency's movement,
   whatever mix of currencies goes in.
3. **No budget is not zero.** A row with no budget has `budgetMinor`,
   `varianceMinor`, `variancePpm` and `favourable` all null. The screen prints
   "No budget" and the export leaves the cell blank. A zero budget has a
   variance but no percentage. Unbudgeted movement is listed for income and
   expense accounts only. A balance-sheet account appears only when someone
   budgeted it.
4. **Actuals are the journal.** They are summed from `ledger_journal_lines` over
   the calendar month by `posted_at`, like the trial balance. `YEAR-END-CLOSE`
   batches are excluded, because moving profit to retained earnings is not the
   month's performance (the same exclusion as ADR-0090 §4).
5. **Favourable** is `variance >= 0` for income and `variance <= 0` for
   expense. It is null for every other type, which has no direction.
6. **No approval gate.** A budget moves no money and no contractual state
   (CLAUDE.md §12 does not apply). It is not one of the consequential action
   kinds in §4. It follows the existing config-table convention (`tax-rules`,
   `fx-rates`): the generator audits every create, update and delete
   (`ledger.budgets.*`, with before and after hashes), and nothing is gated.
7. **Its own permission.** `ledger:budgets:read` / `ledger:budgets:write` are
   new catalogue entries. A plan is forward-looking. Reading the journal
   (`north.analyst` holds `ledger:journals:read`) does not grant reading next
   month's targets, and setting targets is not the same authority as editing
   the chart. `finance.controller` gets both through `ledger:*:*`.
   `finance.analyst`, `finance.director` and `tenant.admin` get read through
   `readsOf("ledger")` / `ledger:*:read`. The report
   (`GET /v1/ledger/reports/budget-vs-actual?period=`) and its export require
   both `ledger:budgets:read` and `ledger:journals:read`. Tenants provisioned
   before this ADR pick up the read grant on the next `resync-roles`.

## Consequences

- The report does not consolidate across currencies. A tenant that budgets
  one account in two currencies reads two rows. A consolidated view would
  need a rate policy first (spot at month end? the budget's own rate?), which
  is a separate decision.
- There are no annual or quarterly budgets. A year is twelve rows, and
  totalling them is left to the export.
- Budgets are not versioned. The audit log records every change; there is no
  "original versus revised budget" comparison.

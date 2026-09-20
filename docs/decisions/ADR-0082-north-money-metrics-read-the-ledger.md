# ADR-0082 — NORTH's money metrics are adapters over the ledger's reports, and GWP is the named exception

**Date:** 2026-09-19
**Status:** Accepted
**Builds on:** ADR-0024 (a typed compute per metric, not an SQL executor),
docs/19 §5.1 (chart of accounts), docs/modules/north.md §2.2 (no unverified
numbers), docs/specs/gap-north-design.md §E, CLAUDE.md §6 and §12
**Closes:** the computable half of F49 (docs/27-feature-gap-register.md)

## Context

`north-snapshotter.ts` computed `net_commission` as
`sum(axis_policies.commission_minor)` over policies *created* in the window.
Three things are wrong with that figure at once:

- it is **gross** of the channel's share, which is a credit to `2100` and
  therefore invisible to a sum over the policy table — so a metric named "net
  commission retained" was not net of anything;
- it is blind to a **clawback**, which posts a contra batch
  (`seed/ledger.ts:672-674`) and changes no policy row;
- it ties to **nothing in the trial balance**, so the number the daily brief
  narrates cannot be reconciled by the CFO who is asked to sign it.

The last one is the reason this is a dead seam rather than an arithmetic slip.
`verifyNumericClaims` (`packages/core/src/narrator-verify.ts`) checks that
every figure in the prose matches the snapshot, and it does. The verifier is
working; the source it verifies against was never the ledger. A contract
computed on one path and consulted on none.

## Decision

**1. A money metric is computed by calling a report in `packages/ledger`, never
by summing a module table, and NORTH writes no SQL against
`ledger_journal_lines`.**

`net_commission` is now the sum of `netMinor` over
`commissionByDimension(ctx, "channel", { window })`, and its channel
decomposition is the same call's rows — so the grand total and the drivers
cannot disagree, and a reversal nets out by construction because it is a debit
to the accounts the report already reads. `expense_ratio`'s numerator moved to
`expenseMovementMinor` for the same reason; the raw `like '5%'` query it used
was NORTH holding its own opinion about the ledger.

Two supporting changes landed in `packages/ledger` with it: a `window` option
beside `periodCode` (a month-to-date is `[monthStart, now)` and no period code
can express that), and a fix to `commissionByDimension`'s account predicate,
which was unbracketed and therefore let every `40%` line escape the period
filter entirely.

**2. `gwp` stays operational, and that is an accounting position, not a gap
left open by accident.**

For a broker, gross written premium is not revenue. Premium enters segregated
client money (`1010` debit / `2010` credit) and leaves again on remittance
(`seed/ledger.ts:687-688`, `:713-714`). No general-ledger account's balance is
GWP. Deriving one — netting client-money movements, say — would produce a
number that agrees with the ledger only by construction and means nothing as a
production figure, which is a worse failure than the one being fixed: a
plausible number nobody can challenge.

So `gwp` keeps its policy-table sum, with the reason written at the compute
site, and F49 stays **partly open** in docs/27 for the two pieces this ADR does
not build: the periodic reconciliation of `gwp` against premium collected
(`north_tieouts`, spec §E.3), and the board-safety filter that keeps an
unreconciled metric out of a board pack and out of the model's context
(spec §E.2). Both want a schema change and are their own change.

## Consequences

- A CFO can trace `net_commission` to `commissionByDimension`, and from there
  to the journal lines behind an account statement. That chain is the
  acceptance test for the metric, not the absence of the old bug.
- `packages/ledger` is now on `apps/api`'s NORTH path. It is a shared package,
  not a module, so CLAUDE.md §6 is intact — the rule forbids cross-*module*
  imports, and the alternative (NORTH re-deriving balances) is precisely what
  §12 exists to prevent.
- A commission line posted in a currency other than the tenant's base is
  excluded from the snapshot rather than converted, because a snapshot is one
  integer in one currency and NORTH owns no fx opinion. A multi-currency tenant
  needs a per-currency metric or a base-currency report; today's seeds are
  single-currency and the exclusion is explicit at the call site.
- The seeded demo figures move: the clawback at `seed/ledger.ts:672-674` now
  reduces the month it was earned in, which is the whole point.

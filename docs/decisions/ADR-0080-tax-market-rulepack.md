# ADR-0080 — Tax is stated by a market rulepack, and an unstated tax is a refusal

**Date:** 2026-09-18
**Status:** Accepted
**Builds on:** docs/19 §5.3 ("Tax treatment per market rulepack… Tax is never
inferred in code"), docs/16 H12, docs/29 (the missing *tax jurisdiction*
dimension), CLAUDE.md §12 (transaction integrity)
**Closes:** F17 (docs/27-feature-gap-register.md)

## Context

`ledger_tax_rules` has existed since the first ledger migration and had no
reader anywhere in the product. The only tax input on the money path was
`CommissionInput.taxPpm` (`packages/core/src/commission.ts`), optional, applied
as `input.taxPpm ?? 0`. Two things followed:

* every commission accrual posted whatever the caller happened to pass, and the
  two production call sites (`engines/rating.ts`, `routes/dist.ts`) passed
  nothing — so `2200 Tax Payable` was credited zero on every bind;
* docs/19 §5.3's "never inferred" was implemented as "always inferred, as
  nothing", which is the failure mode the sentence exists to forbid.

A rate cannot be resolved without a jurisdiction, and no tenant field named
one. docs/29 had already found this: *tax jurisdiction for the US*, *tax
treatment for Europe* — missing **dimensions**, not missing rows.

## Decision

1. **`policy.taxMarket`** (default `AE`) is the tenant's stated establishment,
   the lookup key for its supplies. It is a tenant's own statement, not derived
   from currency or locale — AED is used outside the UAE and `ar` is spoken in
   seven markets with four different rates.
2. **`TAX_RULEPACK`** (`packages/db/src/tax-rulepack.ts`) is the compiled
   default, provisioned into `ledger_tax_rules` at seed time exactly as
   `CHART_OF_ACCOUNTS` is. It is deliberately short: every row is a statutory
   rate somebody must be able to cite, so it grows by research, never by guess.
3. **`taxTreatment(ctx, q)`** (`packages/core/src/tax.ts`) resolves the rule in
   force at the supply date, or **throws**. There is no third outcome. A tenant
   with no rulepack for a market gets a 400 naming what it is missing.
4. **A caller may state a rate; it may never omit one.** `quoteCommission`
   honours an explicit `taxPpm` (an insurer statement carries its own rate, a
   migration restates history) and stamps `taxRuleId: null` to record that no
   rule was consulted. A caller that states nothing gets the rulepack's rate or
   the refusal.
5. **Exempt and reverse-charge are stated zeroes.** `taxPpmOf` returns 0 for
   both, but the treatment carries the rule id that says *why* — which is the
   entire difference between this and the default it replaces.
6. **`syncTaxRules`** is the fifth reconciler on `/v1/auth/demo/resync-roles`.
   Sighting 9's rule: a compiled table read only at provisioning time has one
   delivery. Here the staleness is loud rather than silent — a tenant seeded
   before the rulepack existed cannot bind at all — which is the right way
   round.

## Consequences

* `quoteCommission` returns `taxRuleId`, so an accrual is reproducible after a
  rate change: the row that priced it is named on the entry.
* Two unit expectations in `commission.test.ts` moved (15_000 → 14_250 net,
  7_500 → 7_125) because the seeded panel is now taxed. The spec wins; the
  tests were asserting the absence of the bug.
* A new market is an ADR plus a `TAX_RULEPACK` row plus a `syncTaxRules` run —
  never a code branch, and never a silent zero.
* What this does **not** do: place-of-supply logic, reverse-charge *decision*
  (the flag is read, not derived), and per-line tax on premium itself. Those
  are docs/29's remaining dimensions and need their own ADR.

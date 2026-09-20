# ADR-0079 — Gross written premium is a receivable at bind, and the receipt clears it

**Date:** 2026-09-18
**Status:** Accepted
**Builds on:** docs/19 §5.1 (chart of accounts), §5.2 A and B, CLAUDE.md §12
**Closes:** F14 (docs/27-feature-gap-register.md)

## Context

`1200 Premium Receivable` appeared exactly once in the product — as
`ChargebackArgs.receivableAccount`'s default — and `2000 Insurer Payable` was
never posted by any recipe. Both are in docs/19 §5.1's chart. The consequence
is not cosmetic: gross written premium, the first figure any insurance
regulator, reinsurer or auditor asks for, existed only as `axis_policies`
column sums and never as a ledger balance, so it could not be tied to a trial
balance. (This is also the second half of F49: NORTH narrates a GWP figure the
ledger cannot confirm.)

The spec does not say, in one place, what the bind entry looks like when the
broker collects. §5.2 A is the commission-only aggregator; §5.2 B is the
client-money receipt. Neither states how the two meet, which is the ambiguity
this ADR resolves.

## Decision

**A bind books the premium as a debt in both directions, and the receipt
reclassifies rather than re-recognises.**

```
BIND          Dr 1200 Premium Receivable   10,000
                Cr 2000 Insurer Payable    10,000
              …plus the commission accrual of §5.2 A

PREM-COLLECT  Dr 1010 Cash – Client Money  10,000
                Cr 1200 Premium Receivable 10,000
              Dr 2000 Insurer Payable      10,000
                Cr 2010 Client Money Liab  10,000
```

Four properties made this the shape chosen over the alternatives:

1. **Premium is never revenue.** The two bind legs are an asset and a liability
   of equal size. The balance sheet moves; the P&L does not. Income is still
   only what the commission accrual says.
2. **The receipt recognises nothing.** It debits the client-money asset, so
   docs/19 §5.2 B forbids it crediting any income or expense account — and it
   does not: it credits an asset (1200) and a liability (2010). The
   `assertClientMoneyShape` check in `posting.ts` therefore passes without
   being touched, which is the point. An invariant you have to relax is the
   wrong invariant.
3. **`1010 ≥ 2010` still holds**, because the receipt credits 2010 by exactly
   what it debits 1010 by.
4. **`gwpMinor` is optional and its absence means something.** In the
   commission-only model the insurer collects directly and no premium touches
   our balance sheet, so there is no debt to record — a bind that states no
   premium posts exactly what it posted before this change.

`CMSN-ACCR` is deliberately **not** in the bind family. A commission accrual
raised on its own — a late statement, a corrected rate — must not invent a
second premium debt for a contract that already has one.

## Consequences

* `bindPosting` replaces `commissionAccrual` for `BIND`, `BIND-GROUP`, `RENEW`,
  `REINSTATE`, `PARTNER-BIND` and `AGENT-BIND`. Both production bind sites
  (`routes/axis.ts` `bindPolicy`, `engines/group-commission.ts` `bindGroup`)
  pass `gwpMinor: policy.grossMinor` — premium + tax + fees, the whole debt —
  so the seam has callers in the same commit that declares it.
* Aged receivables now have premium in them, which is what F15 needs to be
  worth reading.
* **Out of scope, deliberately.** `ENDORSE` and `UBI-REPRICE` stay
  commission-only: a mid-term premium delta is a *signed* receivable movement
  (a refund is a credit to 1200) and `CommissionArgs` has no signed amount, so
  it needs its own recipe rather than an overloaded one. `CANCEL` likewise
  claws the commission back but does not yet reverse the premium legs. Both are
  named here so the gap is a decision rather than an oversight.

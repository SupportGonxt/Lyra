# ADR-0117 — A premium receipt clears what the ledger says is open

**Date:** 2026-10-03
**Status:** Accepted
**Builds on:** ADR-0079, docs/19 §5.2 B, docs/27 F14 and F15

## Context

ADR-0079 gave `clientMoneyReceipt` a four-leg form that clears `1200 Premium
Receivable` and reclassifies `2000 Insurer Payable` to client money, selected
by `clearsReceivableAccount`. No caller passed it. Every receipt in the product
(the generic `POST /v1/ledger/txn/{CM-RECEIPT|PREM-COLLECT|PREM-INSTALMENT}`
endpoint, and the premium-financing engine's PREM-INSTALMENT) posted the plain
Dr 1010 / Cr 2010 pair. 1200 was debited at every bind and credited by nothing:
the open-item aging showed every paid policy as unpaid, and the Money Map read
every bound premium as still due.

Passing the flag at each call site would have repeated the defect's shape: the
caller would decide how much of a debt a receipt clears, and the first caller
to forget would reopen it. A flat "always clear" would credit 1200 for a
commission-only bind that never debited it.

## Decision

* One builder, `premiumReceiptLines` (`packages/ledger/src/premium-receipt.ts`),
  builds every premium receipt. It reads the open 1200 balance for the item the
  receipt names (`dims.item`, else `policy:<dims.policy>`, the key the bind
  writes) in the receipt's currency, and clears `min(received, open)` on the
  bind's own dims, so the aging nets the item. Cash beyond what is open is held
  as plain client money. Clearing arguments a caller sends are discarded.
* `clientMoneyReceipt` gains `clearsReceivableMinor` (partial clearing, never
  more than the cash) and `receivableDims` (the item's dims on the 1200 and 2000
  legs).
* `apps/api/src/premium-receipt.guard.test.ts` fails on a premium receipt built
  anywhere else, on a dynamic `buildRecipe(` that does not branch to the
  builder, and on any other source naming the clearing arguments.

## Not decided here

Cancellation. docs/19 §4 (the `CANCEL` row) says only "pro-rata or
short-period"; §5.2 A's worked entry for an early cancellation is the
commission clawback alone; ADR-0079 names "`CANCEL` … does not yet reverse the
premium legs" as deliberately out of scope. Whether a cancellation credits 1200
for the unpaid portion (and debits 2000 to match) needs a spec update first. A
reversed bind already takes both legs back.

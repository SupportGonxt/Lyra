# ADR-0090 — Statement of cash flows under IFRS (IAS 7), indirect method

Date: 2026-09-23 · Status: accepted

## Context

The ledger reports a trial balance, an income statement and a balance sheet
(`packages/ledger/src/reports.ts`). It has no statement of cash flows. The
module review (docs/30, Ledger gap 2) deferred it for an accounting decision:
which accounts are cash, and how each line is classified. The user chose
**IFRS** on 2026-09-23.

## Decision

1. **IAS 7, indirect method.** `cashFlowStatement(ctx, { from, to })` starts
   from profit for the window. It adds the movement of every non-cash
   balance-sheet account, bucketed as operating, investing or financing. It
   proves the result against the movement of cash itself. The whole statement
   rests on one identity: every batch balances, so the movement on cash
   accounts equals the credit-minus-debit movement on every other account.
2. **Classification is data, not code.** `ledger_accounts.cash_flow` is a
   nullable text column (`cash | operating | investing | financing`). Null
   derives from the account type: asset/liability → operating, equity →
   financing, income/expense → profit. The default chart sets only `1000` to
   `cash`. `syncChartOfAccounts` backfills the class onto a tenant's existing
   rows where it is null, so a tenant provisioned before this ADR gets it on
   the next `resync-roles` (the lesson of CLAUDE.md sighting 9).
3. **Client money is not cash and cash equivalents.** `1010` is held for
   insurers and customers and is offset by `2010`. It is restricted, so it is
   left out of cash and disclosed as a note (IAS 7.48). Both `1010` and `2010`
   stay in operating, where they net.
4. **Non-cash entries.**
   - `YEAR-END-CLOSE` batches are excluded: they are a reclassification within
     equity.
   - `FX-REVAL` lines on a cash account are removed from operating and shown as
     the effect of exchange rate changes on cash (IAS 7.28).

## Consequences

- The seeded chart has no non-current assets or borrowings, so investing and
  financing stay empty until a tenant adds such accounts and classifies them.
  Equity contributions (`3000`) and drawings (`3200`) are financing.
- IAS 7.31–34 (interest and dividends) needs accounts for those flows first;
  none exist in the default chart.
- The direct method (IAS 7.18(a)) is not offered. It would need gross receipts
  and payments by nature, which the lines do not carry as a dimension.

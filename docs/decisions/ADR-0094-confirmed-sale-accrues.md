# ADR-0094 — A confirmed sale accrues commission without AXIS

Date: 2026-09-27 · Status: accepted

## Context

Distribution accrued commission from exactly one fact: a bound AXIS policy.
That covered the manual route and the `axis.policy.issued` consumer, and both
read `axis_policies`. A tenant that runs Distribution without AXIS never binds
anything. So its channels never earned commission, and its settlements had no
lines to pay.

The sale that tenant *can* see is the quote the customer chose on the
comparison. On 2026-09-27 the user chose "confirmed sale on a quote". The
alternatives were a provider-signed sale notice, or requiring AXIS for
commission.

## Decision

1. **The chosen quote is the sale.** `POST /v1/dist/quote-responses/:id/sale`
   (`dist:commissions:adjust`, idempotency key) confirms a selected, quoted
   response. It refuses with 409 when:
   - the quote was not selected;
   - it is not a quote;
   - AXIS is on (`moduleOn`). With AXIS, the bind is the sale, and a second
     door onto the same fact would accrue it twice.
2. **One path, two subjects.** `engines/commission-accrual.ts` rates, gates,
   inserts, audits and announces through one `book()`. A policy and a sale
   differ only in:
   - the subject: `policyId`, or `saleRef = quote_response:<id>`;
   - the gate's subject: `<policyId>:<kind>`, or `sale:<responseId>:<kind>`.

   The rate comes from the quote's offering and the comparison's channel. The
   approval is the same `dist.commission_accrue`. Settlement reads the entry
   as it reads any other.
3. **Schema.** Migration 0040 makes `dist_commission_entries.policy_id`
   nullable and adds `sale_ref`. `dist_commission_entries_sale_uq` allows one
   accrual per (sale, kind), with clawbacks exempt, just as the policy index
   does. `dist_quote_responses.sold_at` records the confirmation.
   `dist.sale.confirmed` announces it.
4. **Clawback.** A sale has no term to prorate against, so a sale entry
   reverses in full.

## Consequences

- A Distribution tenant without AXIS books channel commission from the
  compare screen's "Record sale". The comparison shows it as recorded once
  `soldAt` is set.
- A provider-signed sale notice can later become a second caller of the same
  sale door. It needs no schema change.

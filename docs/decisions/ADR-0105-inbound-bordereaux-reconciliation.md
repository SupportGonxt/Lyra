# ADR-0105 — Inbound bordereaux reconciliation reports; it never moves money

Date: 2026-09-27 · Status: accepted

## Context

docs/30 Ledger 5 asked for inbound bordereaux reconciliation. A provider sends
a file of the policies, premiums and commissions it booked for a period, and we
reconcile it against our own records. AXIS already had the storage for this:
`axis_bordereaux` and `axis_bordereau_lines` (docs/27 §E). It also had a first
reconcile pass, `engines/axis-bordereaux.ts`, with three limits:

- It took JSON lines only.
- It matched one line at a time against *any* policy with that number. It
  compared gross premium against `axis_policies.gross_minor` and checked
  neither the period, nor the currency, nor the commission.
- It could never produce `missing_theirs`, because it read only the lines
  *they* sent.

## Decision

1. **The file.** `POST /v1/axis/bordereaux/import` takes the provider's CSV,
   as a multipart `file` or as JSON `{ csv }`, with the header fields beside
   it. It reads the CSV with the shared `parseCsv`.
   - `policyNo` is required.
   - The amounts the kind compares are required columns, written as whole
     minor units. Premium compares `grossPremiumMinor` and `commissionMinor`.
     Claims compares `claimsPaidMinor` and `reserveMinor`. Combined compares
     all four.
   - `currency` (per line), `taxMinor` and `riskRef` are optional.
   - The row is kept verbatim in `rawJson`.

   **All or nothing.** The other importers keep the rows they can read. This
   one does not, because an inbound period is one-shot: a second import for
   the same period is a 409. Storing the good rows of a bad file would lock
   the period with lines missing. So any unreadable row refuses the whole
   file with a 422, `rowErrors` names each line, and nothing is stored.
2. **Our side is what outbound reports.** `ourRecords` covers:
   - commission entries earned in the period for the provider;
   - for claims, claims updated in the period on the provider's policies.

   Outbound generation reads the same function, so the two directions cannot
   disagree about what "our records" means.
3. **The match is pure.** `engines/bordereau-match.ts` has no database and no
   clock. Its rules:
   - **Grouping.** Lines group by (reference, currency). A reference is
     compared trimmed and case-insensitively.
   - **Currencies.** Currency is part of the key, so nothing is compared or
     summed across currencies. A reference held in AED by them and in USD by
     us is two discrepancies, each true in its own currency.
   - **Duplicates.** Each side is summed within its group before comparing.
     A group where *they* listed the reference more than once is marked
     `duplicate`, so a match on sums never hides it. A line sent twice by
     mistake reads as twice what we hold.
   - **Tolerance.** `toleranceMinor` is an absolute allowance in the group's
     own minor units, per field, applied to the summed group. The default is
     0. It is meant for rounding between two systems, not as a materiality
     threshold. It never turns a missing line into a match, and the true
     delta is always reported.
4. **Reports only.** `POST /bordereaux/:id/reconcile` writes three things:
   - each of their lines' `matchState`;
   - the group's variance, on the group's first line only, so a duplicate is
     never counted twice;
   - the header's `state` (`matched` or `variance`), its `varianceMinor` (in
     the header currency only) and its `toleranceMinor`. That last field is
     new, added by migration 0041. `GET /bordereaux/:id/reconciliation`
     answers under the stored tolerance, so the report reads back with the
     rule it was run under.

   Reconciliation writes nothing money-affecting (CLAUDE.md §12). Resolving a
   difference goes through the paths that already carry approvals. The screen
   links each group to our record:
   - a commission entry's record page, which carries the approval-gated
     clawback (`dist.commission_adjust`) and its dispute state;
   - a claim's detail page;
   - when we hold nothing booked for the reference, the policy itself.
5. **Provider files only.** Reconciliation refuses (409) an outbound
   bordereau, and any counterparty that is not a provider. Our records are
   keyed by `providerId`, so a channel's or partner's file would read as
   entirely `missing_ours`. That would be a false report, not a
   reconciliation.

## Consequences

- An entry booked without AXIS (ADR-0094) has no policy number. It is listed
  under its sale reference, so it will read as `missing_theirs` against a
  provider file until a provider's reference can be stored against a sale.
- A group only on our side is reported but never stored as a line. Lines stay
  "what they sent".
- The row-error messages are the API's English, as on every other import
  panel. Line numbers and headings are translated.
- Channel and partner reconciliation, and auto-proposing an adjustment for a
  variance, are left for when a real feed needs them.

## Addendum, 2026-09-28 — who reconciles

The finance controller reconciles a provider's inbound file: it holds
`axis:bordereaux:read` and `axis:bordereaux:reconcile`, and — like
`orbit.retention` under ADR-0054 — a named exception in
`availableShellsForRoles` opens the AXIS shell for it, because the screen lives
at `/axis/bordereaux` and a grant without the door is unreachable. Its default
workspace stays the ledger. Existing tenants pick the grant up on
`POST /v1/auth/demo/resync-roles`.

# ADR-0095 — Screening hits block binding; OpenSanctions behind the seam

Date: 2026-09-27 · Status: accepted

## Context

docs/19 §4 says a screening hit blocks the subject until a person records a
disposition. Two things stood between the platform and that rule:

1. **The block was a column nothing read.** `compliance_screenings.blocked`
   was written true on a hit, but no bind, renewal, reinstatement or sale
   consulted it. There was also no way to record a disposition: the
   resource was read-only, so a block could not be cleared by anyone.
2. **Nothing was consulted.** The only `ScreeningProvider` was a stub that
   matched two fake tokens. It said so on every hit, and it answered "clear"
   for every real name.

The user approved both halves on 2026-09-27. docs/02 §9 requires an ADR for
the provider.

## Decision

1. **One question, asked by every door.** `assertNotScreenedOut(ctx,
   customerId)` in packages/core answers 409 while any screening on
   `customer:<id>` stands blocked. It is asked by:
   - policy create (the CRUD `beforeWrite`, which runs before the `axis.bind`
     approval is raised);
   - quote-response bind;
   - `renewPolicy`;
   - `reinstatePolicy`;
   - Distribution's confirmed sale (ADR-0094).

   It lives in core because those doors belong to different modules
   (CLAUDE.md §6).
2. **Disposition is a person's act.**
   `POST /v1/compliance/screenings/:id/disposition` takes
   `false_positive | confirmed | escalated` and a required reason, under the
   new `compliance:screenings:disposition` permission.
   - Only `false_positive` lifts the block.
   - Every disposition is audited under the officer's name.
   - A lifted block emits `compliance.screening.cleared`.
   - Dual control was considered and not taken. docs/19 asks for "a
     disposition by a person", and a tenant has one compliance officer as
     often as not. The audit row is the control.
3. **OpenSanctions** (`engines/screening.ts`, `openSanctions`) answers
   `sanctions` from the `sanctions` collection and `pep` from `peps`. The
   deployment selects it by environment:
   - `OPENSANCTIONS_API_KEY` (a wrangler secret) uses the hosted match API;
   - `OPENSANCTIONS_URL` uses a self-hosted `yente` instead, which is the
     on-prem answer (ADR-0010), because the same image serves the same API.

   The list's own `match` becomes a hit. A score of 0.7 or more without a
   match is inconclusive: a person looks, and nothing blocks. A failed call
   answers 502 and writes no row, so an unanswered screening never reads as
   clear.
4. **The stub stays, labelled.** It still answers where no list is
   configured, and for `adverse_media` and `fraud`, which OpenSanctions does
   not cover. The "no provider" warning shows whenever the stub produced the
   result. Hits carry `stub: false` from a real list.

## Consequences

- Hosted OpenSanctions is free for non-commercial use only. A tenant selling
  cover is commercial, so production needs a paid licence before the key is
  set; self-hosted `yente` carries the same data licence. Until then,
  production runs the labelled stub exactly as before.
- A blocked customer's bind is refused before any approval is raised. So no
  approver is ever asked to approve cover for someone compliance is holding.

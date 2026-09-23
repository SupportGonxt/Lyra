# ADR-0086 — The requester finishes an approved request with one press

**Status:** accepted · 2026-09-23
**Context:** docs/06 J-M1, J-M2, J-X2, J-P1, J-P2, J-E2; CLAUDE.md §4 (human in the loop), §12 (transaction integrity); senior design panel, 2026-09-23.

## Context

`gate()` answers an ungated attempt with 403 `approval_required` and a pending
row. An approval is a single-use pass that the *next* attempt spends. Nothing
kept the attempt itself, so after somebody approved, the requester had to find
the screen again and re-enter the whole form; the e2e specs refill forms after
approving (`e2e/signal-budget.spec.ts`). Six documented journeys stalled at
"approved" and the approvals screen told reviewers "approving this is what
creates it", which was not true.

## Decision

1. When a write is stopped with `approval_required`, the API keeps the request
   (method, path + query, JSON body up to 64 KB) on the requester's own
   pending approval row (`context.resume`). Uploads (non-JSON bodies) are not
   kept.
2. `GET /v1/me/approvals/ready` lists the caller's approved, unfinished
   requests. `POST /v1/me/approvals/:id/finish` replays the kept request
   **through the same app, in the requester's own session**.
3. Only the requester may finish, only while the approval is valid (the
   existing 24 h TTL), and only once (`context.completedAt`).

## Why a replay, and why as the requester

- Every permission check, every validation, the idempotency key and the gate
  itself run again exactly as they would on a manual retry. The gate spends
  the approval. No second write path exists to drift from the first.
- Executing as the approver would let a decider act with the requester's
  intent but the decider's grants. Executing server-side with no session
  would need a service identity. Replaying as the requester needs neither.

## Consequences

- Approval stays a decision, never an execution: nothing runs until the
  requester presses Finish, so an approval nobody acts on still lapses.
- A request stopped before this change has no kept body; it is finished the
  old way.
- Money-moving policies (`neverAutoApprove`) are unchanged: the replay passes
  through the same gate and ledger invariants.

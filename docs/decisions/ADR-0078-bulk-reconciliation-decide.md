# ADR-0078 — Deciding reconciliation matches in bulk

Status: open · 2026-09-19
Context: docs/19-transactions-and-ledger.md §6 (reconciliation, variance states),
docs/27-feature-gap-register.md "thin screens" (`ledger-recon.tsx` … cannot act
in bulk), CLAUDE.md §12 (transaction integrity), CLAUDE.md Guardrails ("do not
weaken tenancy, audit, or approval flows").
Code: `packages/ledger/src/recon.ts:297` (`decideMatch`),
`apps/api/src/routes/ledger.ts:843` (`POST /recon/matches/:id/decide`),
`apps/web/app/routes/ledger-recon.tsx:442` (the per-row decide control),
`packages/core/src/audit.ts:60` (`audit`), `packages/core/src/idempotency.ts:24`
(`withIdempotency`), `apps/api/src/http.ts:186` (`MAX_PAGE = 200`).

## Context

A reconciliation run can produce as many matches as the statement has lines —
the run endpoint takes up to 5000 (`apps/api/src/routes/ledger.ts:741`). Every
one of them that is not `confirmed` by pass 1 is open, and a run closes only
when nothing is open at all: `closeRun` (`recon.ts:382`) counts `proposed` *and*
`unmatched` (`recon.ts:360`) and has no force flag by design. So a 300-line
insurer statement whose references were exported in the wrong column is 300
decisions, one form submit each, before the run can be closed. That is the
gap docs/27 records, and it is the reason a reviewer will reach for a database
console instead — which is the outcome this ADR exists to prevent.

The thing bulk decide would batch is not a mechanical update. `decideMatch` is
the human half of the reconciliation: it writes the actor and the moment onto
the row (`recon.ts:314-322`) and emits one audit entry per match carrying the
method and the confidence it overrode (`recon.ts:324-329`). An AI-proposed
match reaches a reviewer precisely because the model is not trusted to post it
(`recon.ts:226-240`, `AI_CONFIRM_FLOOR`). A control that confirms 300 of those
in one click, under one reason, is a control that launders a model's output
into the ledger with a person's name on it. That is why this is a
transaction-integrity question and not a UI change, and why the navigation
agent stopped here rather than building it.

Three facts about the existing path constrain any answer.

1. **Audit is a hash chain.** `audit()` reads the current tip and writes
   `prevHash` from it (`audit.ts:61-77`). Two entries written concurrently read
   the same tip and both claim it, which `verifyChain` reports as
   `prev_mismatch` (`audit.ts:96-97`). Any batch must therefore be a sequential
   loop — never `Promise.all` — and ids stay sortable inside one millisecond
   because they are monotonic ULIDs (`packages/db/src/ids.ts:27-29`).
2. **`decideMatch` is already idempotent per match**, by conflict: a match that
   is `confirmed` or `rejected` throws (`recon.ts:310-312`). A batch that treats
   that conflict as fatal makes a retry after a partial failure impossible; one
   that ignores it silently hides a double decision.
3. **The screen already reads at most 200 matches** (`ledger-recon.tsx:150`,
   the `MAX_PAGE` ceiling at `http.ts:186`). A bulk control offered over a page
   cannot claim to act on a run.

## The question that is genuinely open

Whether a reviewer may confirm many matches at once **at all**, or only reject
many at once. Rejecting in bulk clears stragglers so a run can close and posts
nothing; confirming in bulk asserts, in one act, that 300 counterparty lines are
each the transaction we think they are. The two are not the same risk, and which
of them the product is willing to offer is the product owner's call, not this
file's. The options below are written so that either answer is buildable without
re-litigating the design.

## Options

### A. Reject-only bulk, confirm stays one at a time

`POST /v1/ledger/recon/runs/:id/decide-bulk` accepting only
`decision: "rejected"`. Clears the stragglers that block a close — the case the
engine's own docstring names ("reject the stragglers with a reason instead",
`recon.ts:377-381`) — and leaves every posting-relevant judgement individual.

Cheapest, and closes the docs/27 item as it is actually felt. Does nothing for a
tolerance run where 200 matches are genuinely correct within a fils.

### B. Both decisions in bulk, under the constraints in the next section

Covers the tolerance case too. Costs the concealment risk described above, which
the constraints are there to bound.

### C. Do nothing

Defensible, and it should be said plainly: the per-match path is correct, and
every bulk control over money is a lever someone can pull too far. The cost is
that the workaround is a console, which has no audit trail at all.

## Constraints on A or B, if either is built

These are the part this ADR does settle. A bulk decide must be a *batch of the
existing act*, not a second path to the same rows.

1. **One `decideMatch` call per match, in a sequential loop, inside the
   route.** No new SQL touching `ledger_recon_matches`, no `UPDATE … WHERE runId
   = ?`. The engine function is where the state guard, the actor stamp and the
   audit entry live, and a set-based update is the shape that loses all three at
   once. This is the rule that makes the feature a UI affordance rather than a
   second write path — the same reasoning as the ledger router's own rule that no
   endpoint writes a journal line directly (`apps/api/src/routes/ledger.ts:53-56`),
   one table over.
2. **One audit entry per match, as today**, plus one envelope entry
   (`ledger.recon.decide_bulk`) naming the run, the decision, the reason and the
   count. The envelope is additional context, never a replacement: an auditor
   asking "who rejected match X" must find the answer on X, not on a batch row
   they have to join through.
3. **Explicit match ids in the body, never a filter.** `{ matchIds: string[],
   decision, reasonCode }`, capped at `MAX_PAGE` (200) so the request cannot
   exceed what the screen can show, and refused if any id belongs to another run
   or another tenant. A server-side filter ("everything still proposed") would
   let the set change between what the reviewer read and what they signed: a run
   re-reconciled, or a colleague deciding a match, between the render and the
   submit would silently widen the batch. Ids are what the reviewer actually
   saw.
4. **The reason is per batch, and the screen must say so.** One `reasonCode`
   covering N matches is the honest reading of one decision over a set; the
   confirm copy has to state the count and the reason together, so nobody
   believes they typed N reasons.
5. **Idempotent as a whole.** The route carries an `idempotency-key` header
   through `withIdempotency` (`idempotency.ts:24`) like every other write that
   moves money, so a double submit is one batch. Within the batch, a match that
   is already decided is **skipped and reported**, not fatal: the response is
   `{ decided: string[], skipped: { id, state }[] }` and the screen shows both.
   A partial failure is then resumable by resubmitting the same body.
6. **AI-proposed matches are not bulk-confirmable under option B.** A batch
   whose ids include a `method: "ai_proposed"` row with a `confirmed` decision
   is refused, naming those ids. Tolerance and deterministic matches are
   arithmetic a reviewer can check in aggregate; an AI proposal is the one class
   the engine deliberately refuses to auto-confirm, and a bulk control is
   auto-confirmation with a human's name attached. Rejecting AI proposals in
   bulk stays allowed — that direction posts nothing.
7. **The permission is unchanged** (`ledger:recon:confirm`). A bulk control is
   not a new authority, and a new scope would let a tenant grant the batch
   without the single.
8. **No approval gate is added.** Deciding a match posts no journal — it records
   a judgement about matches that are already posted — so the gate belongs
   where money moves, which is `RECON-WRITEOFF` (dual control always, see
   `packages/ledger/src/types.ts`). Adding a gate here instead would put a
   second pair of eyes on the cheap act and leave the expensive one where it
   was.

## Consequences

- A reviewer can clear a run in one act, and the audit trail is the same N rows
  it would have been — so the trail grows no cheaper to read, and a bad batch is
  as visible as a bad decision.
- Constraint 1 makes bulk decide O(N) round trips inside one request. At 200
  matches on D1 that is a slow request, and if it becomes a timeout the answer
  is a smaller cap or a queued job that still calls `decideMatch` per match —
  never a set-based update.
- Constraint 6 means the tolerance case (option B's whole justification) is
  served and the AI case is not, so a run made mostly of AI proposals is still
  a per-match afternoon. That is the intended price.
- Constraint 3's cap of 200 means a 5000-line statement still takes 25 batches.
  Honest, and preferable to a filter nobody read.
- Leaving this `open` means the docs/27 item stays open. `045ff8c` (the close)
  and `7cf1431` (the write-off) already removed the two reasons a run could not
  be finished at all, so what remains is effort, not a dead end.

## Not decided here

Whether the same shape applies to other per-row judgements (approval queue
decisions, settlement lines). Each has its own posting consequences; this ADR
claims nothing beyond reconciliation matches.

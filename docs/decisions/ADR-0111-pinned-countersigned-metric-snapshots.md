# ADR-0111 — A success fee bills a pinned, countersigned metric snapshot

Date: 2026-09-28 · Status: accepted

## Context

docs/specs/gap-finance-design.md D11: "A new table holds a *pinned copy* of the
`north_snapshots` row plus a `source_hash`; both parties countersign; the fee's
idempotency key is derived from the snapshot id, so one snapshot can bill
exactly once. *Rejected:* reading `north_snapshots` live at posting time."

The F21 fix (docs/27) did the rejected thing. `TXN_PRECONDITIONS["SUCCESS-FEE"]`
required `args.metricSnapshotId` to name a `north_snapshots` row with
`verified_at` set, and read that row when the fee posted. A verified row is
attested, not frozen: the snapshotter can recompute it, and someone can verify it
again. The number the fee billed could therefore change between the parties
agreeing on it and the fee posting. The approval `ledger.success_fee`
(dual control, never auto-approved) covers the posting. It says nothing about
which figure the posting used. Nothing stopped two postings on one snapshot
either, because the idempotency key was whatever the caller sent.

## Decision

1. **Table `ledger_metric_pins`** (migration `pinned_metric_snapshots`). It
   holds a copy of one verified `north_snapshots` row: source id, metric key,
   grain, period, dims hash, value. It also copies the metric definition's unit
   and currency, because a bare number means nothing a counterparty can sign,
   and it records who verified the source and when. `source_hash` is the sha-256
   of the canonical JSON of those fields (`pinHashInput`). The table also holds
   who pinned the row and when, plus two signatures. Each signature records who
   signed and when. The counterparty's signature also carries its evidence ref.
   A unique index on `(tenant_id, source_snapshot_id)` means one snapshot can
   have only one pin.
2. **State machine `pinned → countersigned`.** The state becomes
   `countersigned` once both sides have signed, in either order. Each side can
   be signed only once, through a conditional update, so two concurrent signers
   cannot both win. Dual control:
   - The person who pinned cannot sign our side.
   - One person cannot sign both sides.
   - The counterparty side requires `evidenceRef`, such as an e-sign id or a
     signed statement's reference.

   Pins have no edit or delete path in the ledger package or in the API. The
   generic resource is registered `immutable` and read-only. That is stronger
   than "immutable once signed".
3. **The SUCCESS-FEE precondition reads the pin, never the live row.**
   `args.pinnedSnapshotId` is required and must name a `countersigned` pin in
   this tenant. The pin's copy must still hash to `source_hash`. The
   transaction's idempotency key must be exactly `success-fee:{pinId}`
   (`successFeeKey`). The ledger's existing `(tenant, type, key)` unique index
   then makes one pin bill exactly once, and a replay returns the first posting.
   To check the key, `Precondition` gained an optional third argument, the
   envelope's `{ idempotencyKey }`, which `runTxn` passes in. The existing
   preconditions ignore it.
4. **The pin is mandatory. The old reference is not supported.** No seed, test
   or route posted a SUCCESS-FEE through `metricSnapshotId` except the tests this
   change rewrites. A fee that still sends only `metricSnapshotId` is refused
   with "pinnedSnapshotId is required".
5. **Scopes.** Three new scopes:
   - `ledger:metric_pins:read`
   - `ledger:metric_pins:pin`
   - `ledger:metric_pins:countersign`

   `finance.controller` holds `ledger:*:*`, so it can pin and sign. It already
   decides `ledger.success_fee`. `finance.director` gets `:countersign` and not
   `:pin`, following that role's rule of approving but never originating. The
   read scope reaches every role built on `readsOf("ledger")`.
6. **Routes.**
   - `POST /v1/ledger/metric-pins` creates a pin from `{ snapshotId }`.
   - `POST /v1/ledger/metric-pins/{id}/countersign/{tenant|counterparty}`
     records a signature.
   - The generic read-only `metric-pins` resource serves list and read.

   Each step is audited: `ledger.metric_pin.pinned` and
   `ledger.metric_pin.countersigned`.
7. **Web.** The ledger workspace gets a `metric-pins` tab. Its create form is the
   Pin action. The two countersign actions are record actions, confirmed before
   posting, and the counterparty action asks for the evidence. The `state` badge
   shows the status.

## Deferred from the spec's fuller §B.1 table

The spec's `ledger_fee_metric_snapshots` also carries `agreement_ref`,
baseline/uplift, fee basis/rate/amount, `expires_at` (90 days),
`rejected`/`consumed` states and `consumed_txn_id`. None of these is needed to
close D11's control: a frozen figure that both parties signed and that bills
once. They belong to computing the fee from the figure, and the recipe does not
do that today because the caller still supplies `netMinor`. They can be added
forward-only when fee computation is built. If a pin is wrong before anyone
signs it, there is no way to discard it. Discarding one would need a
`rejected` state, which is also deferred.

## Consequences

- A metric can now move after sign-off and the fee does not move with it. A
  pinned figure that has been altered in the database fails the hash check at
  posting.
- A SUCCESS-FEE that fails or is rejected uses up its pin's key. Billing that
  metric again needs a new snapshot and a new pin. That is deliberate, because
  a key that could be retried would reopen double billing.

# ADR-0110 — SIGNAL frozen-budget holdout: a flag on the campaign

Date: 2026-09-28 · Status: accepted

## Context

docs/17 SIG-046 and the docs/modules/signal.md §7 KPI ask for "autopilot
uplift vs frozen-budget holdout", and §8 asks the autopilot to run "against a
holdout". `compareHoldout` in `signal-autopilot.ts` computed the comparison
and had no caller: nothing let a tenant designate a holdout, nothing froze its
budget, and nothing reported uplift. The autopilot could move any campaign's
budget. ADR-0020 called that math "real and unit-tested", which it was; it was
also unreachable — a dead seam.

## Decision

1. **The seam is a boolean on the campaign.** `signal_campaigns.holdout`
   (migration `signal_holdout`, `NOT NULL DEFAULT false`). The autopilot moves
   budget *between the channels of one campaign*
   (`signal_campaign:<id>#<channel>` on both sides of every move), so the
   campaign is the smallest unit whose budget can be frozen whole. A flag on a
   spend row or a channel would let the autopilot move money out of a
   "frozen" channel into a live sibling. `signal_experiments` was considered
   and rejected: an experiment is variant/arm-shaped with a sample-size
   verdict; a holdout here is a standing designation with no arms.
2. **Frozen means frozen.** `runBudgetAutopilot` filters `holdout = false`
   before evaluating, so a holdout campaign is never evaluated, never proposed
   for and never moved. A move proposed *before* its campaign was held out is
   not executed by a later approval: `onBudgetMoveDecided` refuses to push it
   and leaves the approval unspent and the move pending. An **undo** is left
   alone — it restores a state that existed before the designation, and
   refusing a human's reversal is the worse failure.
3. **Cohorts.** *Acted* is every non-holdout campaign on an autonomy level the
   autopilot acts on (`AUTOPILOT_LEVELS`: `act`, `act_with_approval`).
   *Holdout* is every campaign with the flag, whatever its autonomy. A
   campaign the autopilot may not touch is in neither — its budget says
   nothing about the autopilot. Spend is `signal_spend` in the window;
   conversions are attributed `bind` touches, the basis
   `cost_per_acquisition` counts (one row, one contract). Unattributed spend
   and touches (no `campaignId`) are in neither side.
4. **No fabricated zero.** `compareHoldout` returns 0 uplift when a side has
   no conversions; the readout instead reports `status` —
   `no_holdout`, `no_conversions`, `no_spend` — and `upliftBps: null`. A zero
   reads as "the autopilot made no difference", which is a claim.
5. **One reader, in core.** `holdoutReadout` (and `compareHoldout`) moved to
   `packages/core/src/signal-holdout.ts`. Two modules read it — SIGNAL's
   `GET /v1/signal/holdout/readout` and NORTH's `autopilot_uplift_bps` — and
   CLAUDE.md §6 allows a shared import only from core; `journey-health.ts` is
   the precedent for a cross-module read living there. The route reads under
   `signal:attribution:read`, the scope of `/attribution/funnel` beside it:
   the readout is a measurement over attribution.
6. **Designation is a campaign update.** The holdout checkbox rides the
   generic campaigns edit form, so it goes through the same
   `signal.campaign_launch` approval every campaign update does. No new
   approval policy.

## Consequences

- `autopilot_uplift_bps` is registered in the snapshotter but **not seeded**
  as a `north_metrics` row: no docs target exists to seed, and a seed-only
  definition would reach new tenants and no deployed one (CLAUDE.md sighting
  9). A tenant snapshots it by registering the definition (key
  `autopilot_uplift_bps`, unit `percent`, scale `bps`, direction `up`).
- The readout sums minor units across currencies, as `cost_per_acquisition`
  does. A tenant spending in two currencies gets a figure true in neither;
  the upgrade path is the same currency filter the NORTH commission metrics
  apply.
- Holding out is all-or-nothing per campaign. Geo or audience splits
  (docs/20 "incrementality views") would need a finer seam and a new ADR.

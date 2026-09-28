# ADR-0109 — Cost per acquisition reported as a range, method disclosed

Date: 2026-09-28 · Status: accepted

## Context

docs/17 SIG-057: "Attribution reported as ranges with method disclosed; no
false precision." NORTH's `cost_per_acquisition` (engines/north-snapshotter.ts)
was SIGNAL spend over attributed `bind` touches, one number, and the cockpit
divided the same two figures out of a 200-row page of touches. The equity deal
settles success fees on the **lower bound** of a range, so the range has to be
real, reproducible and defensible, not a margin painted on a point.

Two things are uncertain in that division:

1. **The count.** Ten binds in a month is one draw; the same spend could as
   plausibly have bought seven or fourteen. A single channel in a single month
   has small counts, where a normal approximation (±1.96·√k) is wrong and
   goes negative at k = 1.
2. **The credit.** `signal_attribution_events` is last-touch: a bind row
   carries the channel of the customer's newest lead (engines/signal-attribution.ts
   `onBindIssued`). A channel's count therefore depends on the model — first
   touch, last touch, any touch.

## Decision

1. **Garwood's exact Poisson interval on the count, 95% by default**
   (`ATTRIBUTION_CONFIDENCE`). The equal-tailed interval solved from the
   Poisson tails themselves: upper μ with P(X ≤ k; μ) = α/2, lower μ with
   P(X ≥ k; μ) = α/2 (0 when k = 0). It is the standard exact interval for a
   count, has no tuning, holds its coverage at k = 1, and is conservative
   (coverage ≥ nominal) — the right side to err on for money. Implemented in
   `packages/core/src/attribution-range.ts` with no dependency: the Poisson CDF
   summed in log space (stable for means in the thousands) and each bound found
   by bisection, since the CDF is monotone in μ. Reference values (k = 0, 1, 5,
   10, 100 at 95%; k = 10 at 90%) and each bound's own tail equation are
   asserted in its tests.
2. **Invert into cost.** More binds is a cheaper acquisition, so
   `low = floor(spend / countUpper)` and `high = ceil(spend / countLower)`:
   rounded outward so the reported range always contains the exact one. The
   point stays `round(spend / binds)` — the existing metric, unchanged.
3. **Credit uncertainty by envelope, not by pretending independence.** For
   one channel, `creditLow` is its last-touch binds whose customer touched no
   other channel beforehand (credited under every single-credit model) and
   `creditHigh` is every bind whose customer touched it at all before binding.
   The cost range spans the count interval of both. Method
   `poisson_exact_credit_envelope`; for SIGNAL as a whole every model credits
   every bind, the envelope collapses, method `poisson_exact`. Where some model
   credits nothing, `high` is `null` — there is no upper bound, and the screen
   says so rather than printing one.
4. **Zero conversions is no range.** Spend that bought nothing has no cost per
   acquisition; `cacRange` returns `null`, matching the metric's existing
   "writes nothing" behaviour.
5. **Three doors, one function.**
   - `GET /v1/signal/attribution/range?since&until&channel&currency`
     (`signal:attribution:read`) returns `{spendMinor, binds, range}`, `range`
     carrying `method` and the i18n `methodKey`.
   - NORTH registers `cost_per_acquisition_low` and `_high` beside the point, so
     the lower bound a fee settles on is a stored, re-derivable snapshot. They
     reach an already-provisioned tenant through `ensureSeedMetrics` on
     `/v1/auth/demo/resync-roles` — the snapshotter computes only metrics that
     have a row (CLAUDE.md sighting 9).
   - The SIGNAL cockpit renders "low – high (point)" with a native `<details>`
     naming the method in en and ar, and reads it from the API rather than
     dividing a page of touches.

## Consequences

- A success fee references `north_snapshots` where `metric_key =
  'cost_per_acquisition_low'` for the month; re-running `cacRange` over that
  month's spend and binds reproduces it exactly.
- The interval covers counting noise and model choice. It does not cover
  mis-recorded touches, organic binds wrongly credited, or spend recorded in
  the wrong period — those are data quality, not statistics.
- The NORTH bounds are SIGNAL-wide and all-currency, like the point they sit
  beside; the cockpit asks for its headline currency explicitly.
- Not yet converted: the analytics screen's blended CAC and per-channel column,
  and the audience-value table, still show a point. They should route through
  the same `cacRange` (follow-up).

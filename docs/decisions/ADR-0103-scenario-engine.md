# ADR-0103 — The NORTH scenario engine is a driver applied to the forecast band

Date: 2026-09-27 · Status: accepted

## Context

docs/30 NORTH 4: the what-if screen (`/north/whatif`) stored a question and its
`name: value` assumptions, and nothing computed them. `north_scenarios.result_json`
was filled only by the seed, with hand-written point estimates.

docs/modules/north.md §2.4 describes an engine that "composes from registered
model primitives (elasticities, funnel rates, cohort retention from tenant
data), returns range estimates with assumptions listed", and §3 puts the
Scenario Engine on the reasoning tier. None of those primitives exists yet.
What does exist is the metric layer's closed snapshots and a deterministic,
banded forecast over them (`packages/core/src/north-forecast.ts`, docs/27 F50).
Spec §H.6 already says of the forecast that the numbers are arithmetic, and a
model may only narrate them.

The assumptions a person types are free-form, so the engine needs a precise
input shape that a line-per-assumption form can carry.

## Decision

1. **One driver per scenario, read from the flat assumptions:**
   - `metric` — a registered `north_metrics.key` in the tenant;
   - `changeBps` — a signed change *relative to the metric's own value*.
     `1000` is +10% and `-500` is −5%. It is not in percentage points, so on a
     60% ratio `-500` gives 57%. The allowed range is −10 000 to +100 000;
   - `horizonMonths` for a monthly metric, or `horizonDays` for a daily one.
     The allowed range is 1 to 36, the same bound as `GET /v1/north/forecast`.

   Any other assumption stays on the row. The result names it in `ignored`,
   and the screen shows it as "stated but not used", so nobody reads it as
   applied.
2. **The answer is the baseline band, shifted.**
   - The engine reads the same closed, grand-total snapshots the forecast
     reads. `closedHistory` in `engines/north-scenario.ts` is shared by both.
   - It projects them with `forecast()` (damped Holt, p10/p50/p90).
   - It multiplies every quantile by `(10 000 + changeBps) / 10 000`.
   - Per period it stores the baseline band, the scenario band and the delta
     band, and the result carries the fit as provenance.

   §2.4's "no point estimate without a range" holds by construction. The band
   is the baseline's own uncertainty. The change is applied exactly as stated,
   not treated as uncertain itself.
3. **The engine is deterministic and makes no model call.** The same history
   and the same driver always give the same answer. So there is no golden set
   to write first (CLAUDE.md TDD rule 4 applies only to model behaviour), and
   `modelRunRef` stays null. A later narrator may explain a result. It will not
   produce the numbers.
4. **Honest states.**
   - When the engine cannot read the assumptions, it returns a 422 whose
     `errors` map names each assumption and why (`missing`, `unknown`,
     `unsupported_grain`, `not_integer`, `out_of_range`). Nothing is written.
   - Fewer than four closed periods is an *answer*: it is stored with
     `reason: "insufficient_history"` and no points. Nothing is estimated in
     their place.
5. **One writer.**
   - `POST /v1/north/scenarios/{id}/run` (`north:scenarios:run`) is the only
     path that writes `resultJson`. It is audited as `north.scenario.run`.
   - The generic CRUD strips `resultJson` and `modelRunRef` on create and
     update.
   - Changing `assumptionsJson` clears a stored result, because an answer to
     other assumptions is not this scenario's answer.

## Consequences

- The what-if screen computes on save, can compute again later against newer
  snapshots, and shows the bands. Seeded scenarios name no driver, so they keep
  their stored point estimates and the screen still warns about them. Running
  one returns the 422 that says what is missing.
- The engine does not yet cover what §2.4 describes beyond this:
  - elasticities, where one metric's change moves another;
  - funnel and cohort composition;
  - several drivers in one scenario;
  - a driver scoped to a dimensional slice (such as "motor" or one channel).

  Each of these is a new primitive composed on top of this shape, and each
  needs its own spec line first. `ignored` is the seam through which such
  assumptions become visible today.
- Results are not versioned runs. Re-running overwrites the row. Spec §H.4's
  immutable runs remain the forecast's open item, and the scenario engine
  inherits it.

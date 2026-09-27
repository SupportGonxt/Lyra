import { forecast, type ForecastFit, type Observation } from "./north-forecast.js";
import type { Grain } from "./north-period.js";

/**
 * NORTH's scenario engine (docs/modules/north.md §2.4, docs/30 NORTH 4,
 * ADR-0103). A stored scenario is a question plus `name: value` assumptions;
 * this reads one *driver* out of them and answers it from the metric's own
 * forecast.
 *
 * The driver, exactly:
 *
 * - `metric` — a registered NORTH metric key.
 * - `changeBps` — the relative change applied to that metric, signed basis
 *   points of its own value (`1000` is +10%, `-500` is −5%). Relative, not
 *   points: on a percent metric `-500` takes 60% to 57%, not to 55%.
 * - `horizonMonths` for a monthly metric, `horizonDays` for a daily one — how
 *   many periods to project, 1..MAX_SCENARIO_HORIZON.
 *
 * Every other assumption is kept on the scenario and named in `ignored`, so a
 * reader can see which of the stated assumptions the numbers actually rest on.
 *
 * The answer is the baseline forecast band (north-forecast.ts, damped Holt,
 * p10/p50/p90) and the same band with the change applied — so §2.4's guardrail
 * holds by construction: no point estimate without a range. Pure, DB-free and
 * deterministic, like the forecast it wraps; no model is in this path.
 */

/** Same bound as `GET /v1/north/forecast`: past it the band outgrows the number. */
export const MAX_SCENARIO_HORIZON = 36;
/** A metric cannot fall by more than all of itself. */
const MIN_CHANGE_BPS = -10_000;
/** Ten-fold is already not a scenario anyone plans on. */
const MAX_CHANGE_BPS = 100_000;

export type ScenarioProblem = "missing" | "unknown" | "unsupported_grain" | "not_integer" | "out_of_range";

export interface ScenarioDriver {
  metric: string;
  changeBps: number;
  /** Periods to project, at the metric's grain. */
  horizon: number;
  /** Assumption names the engine did not read, sorted. */
  ignored: string[];
}

const HORIZON_KEY: Record<Grain, string> = { month: "horizonMonths", day: "horizonDays" };

function integerOf(raw: unknown): number | "missing" | "not_integer" {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) return "missing";
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN; // Number() trims itself
  return Number.isInteger(value) ? value : "not_integer";
}

/**
 * The driver, or every reason there is none — keyed by the assumption each
 * reason is about, so a screen can say which line to fix.
 *
 * @param grain the grain of the metric the assumptions named, as the caller
 *   resolved it; `null` when no such metric exists.
 */
export function readScenarioDriver(
  assumptions: unknown,
  grain: string | null
): { driver: ScenarioDriver } | { errors: Record<string, ScenarioProblem> } {
  const given: Record<string, unknown> =
    assumptions && typeof assumptions === "object" && !Array.isArray(assumptions)
      ? (assumptions as Record<string, unknown>)
      : {};
  const errors: Record<string, ScenarioProblem> = {};

  const metric = typeof given.metric === "string" ? given.metric.trim() : "";
  const known = grain === "month" || grain === "day";
  if (!metric) errors.metric = "missing";
  else if (grain === null) errors.metric = "unknown";
  else if (!known) errors.metric = "unsupported_grain";

  const change = integerOf(given.changeBps);
  if (typeof change === "string") errors.changeBps = change;
  else if (change < MIN_CHANGE_BPS || change > MAX_CHANGE_BPS) errors.changeBps = "out_of_range";

  // The horizon's name depends on the metric's grain, so it is only asked for
  // once there is a metric with a grain to ask it in.
  const horizonKey = metric && known ? HORIZON_KEY[grain] : null;
  let horizon = 0;
  if (horizonKey) {
    const read = integerOf(given[horizonKey]);
    if (typeof read === "string") errors[horizonKey] = read;
    else if (read < 1 || read > MAX_SCENARIO_HORIZON) errors[horizonKey] = "out_of_range";
    else horizon = read;
  }

  if (Object.keys(errors).length) return { errors };
  const read = new Set(["metric", "changeBps", horizonKey!]);
  return {
    driver: {
      metric,
      changeBps: change as number,
      horizon,
      ignored: Object.keys(given)
        .filter((key) => !read.has(key))
        .sort()
    }
  };
}

export interface Band {
  p10: number;
  p50: number;
  p90: number;
}

export interface ScenarioPoint {
  period: string;
  /** The metric's own forecast for the period. */
  baseline: Band;
  /** The same band with the change applied. */
  scenario: Band;
  /** scenario − baseline, low to high. */
  delta: Band;
}

export interface ScenarioResult {
  method: "baseline_shift";
  metricKey: string;
  grain: Grain;
  changeBps: number;
  horizon: number;
  points: ScenarioPoint[];
  /** The forecast fit the baseline came from — provenance for every number above. */
  fit: ForecastFit;
  ignored: string[];
  /** Why there are no points, when there are none. */
  reason?: "insufficient_history";
}

const shifted = (value: number, changeBps: number): number => Math.round((value * (10_000 + changeBps)) / 10_000);

/**
 * @param history closed observations of the metric's grand total, ascending,
 *   at `grain` — the same input `forecast` takes.
 */
export function projectScenario(grain: Grain, history: readonly Observation[], driver: ScenarioDriver): ScenarioResult {
  const base = forecast(grain, history, driver.horizon);
  const points = base.points.map(({ period, p10, p50, p90 }): ScenarioPoint => {
    const scenario = { p10: shifted(p10, driver.changeBps), p50: shifted(p50, driver.changeBps), p90: shifted(p90, driver.changeBps) };
    const [low, mid, high] = [scenario.p10 - p10, scenario.p50 - p50, scenario.p90 - p90].sort((a, b) => a - b);
    return { period, baseline: { p10, p50, p90 }, scenario, delta: { p10: low!, p50: mid!, p90: high! } };
  });
  return {
    method: "baseline_shift",
    metricKey: driver.metric,
    grain,
    changeBps: driver.changeBps,
    horizon: driver.horizon,
    points,
    fit: base.fit,
    ignored: driver.ignored,
    // readScenarioDriver never lets a zero horizon through, so the only way to
    // no points is too little history.
    ...(points.length ? {} : { reason: "insufficient_history" as const })
  };
}

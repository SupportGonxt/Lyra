import { CYCLE, nextPeriod, phaseOf, type Grain } from "./north-period.js";

/**
 * NORTH's forecast (docs/modules/north.md §2.4, docs/27 F50, spec §H):
 * damped Holt on the deseasonalised series, fitted by grid search, with an
 * empirical range. Pure and DB-free — the caller hands it closed observations
 * and gets a projection back — so it is unit-testable and lands inside the
 * Stryker ratchet that covers packages/core.
 *
 * Three properties matter more than accuracy here:
 *
 * - **Reproducible.** A fixed grid search over 405 parameter combinations, no
 *   optimiser, no randomness. The same history is the same forecast, and every
 *   intermediate — the seasonal index per phase, the level, the trend, the
 *   damping, the residual quantiles — comes back on `fit` so a person can
 *   redo it by hand. A board number has to be defensible in a room.
 * - **Never a point estimate.** Every projected period is a p10/p50/p90 band
 *   (§2.4's guardrail), and `fit.intervalSource` says whether the band was
 *   measured from holdout residuals or is the default width.
 * - **Not AI.** The model is nowhere in this path. The gateway may narrate a
 *   forecast; the numbers are arithmetic (spec §H.6).
 *
 * Two deliberate departures from spec §H, both because a young tenant has
 * little history and a forecast it refuses to give is worth less than one that
 * says how thin it is:
 *
 * - The seasonal step is applied only with two full cycles behind it, and
 *   `fit.seasonal` is false otherwise, rather than requiring 12 months / 56
 *   days before answering at all.
 * - Residuals are normalised by √h and pooled rather than quantiled per
 *   horizon: a single-origin holdout gives one residual per horizon, and a
 *   quantile of one number is not a quantile.
 */

export interface Observation {
  /** A period label, ascending, at `grain`. */
  period: string;
  value: number;
}

export interface ForecastPoint {
  period: string;
  p10: number;
  p50: number;
  p90: number;
}

export interface ForecastFit {
  method: "damped_holt_seasonal";
  alphaPpm: number;
  betaPpm: number;
  phiPpm: number;
  /** Was a seasonal index applied at all, and which one per phase (bp, mean 10 000). */
  seasonal: boolean;
  seasonalIndexBp: Record<number, number>;
  /** Mean absolute scaled error on the holdout, ×1e6. Null when there was nothing to score. */
  masePpm: number | null;
  intervalSource: "empirical" | "default";
  observations: number;
  holdout: number;
  /** The last period the projection is built from — the reader's "as of". */
  lastObserved: string | null;
}

export interface Forecast {
  grain: Grain;
  points: ForecastPoint[];
  fit: ForecastFit;
  /** Why there are no points, when there are none. */
  reason?: "insufficient_history" | "empty_horizon";
}

/** Fewer than this and there is no trend to speak of, only two numbers. */
const MIN_OBSERVATIONS = 4;
/** Holdout length by grain, capped at a third of the series (spec §H.2 step 5). */
const HOLDOUT = { day: 14, month: 3 } as const;
/** Below this many residuals a quantile is noise, so the band is the stated default. */
const MIN_RESIDUALS = 8;
/** ±25% at h = 1, widening by √h — the band when nothing was measured. */
const DEFAULT_BAND_BP = 2_500;

const ALPHAS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const BETAS = ALPHAS;
const PHIS = [0.8, 0.85, 0.9, 0.95, 1.0];

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Linear-interpolated quantile, so a small residual set still gives a stable edge. */
function quantile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * A centred moving average over one whole cycle — the local level, with the
 * season averaged out of it. An even cycle has no exact centre, so the two end
 * points get half weight (the standard 2×m MA).
 */
function centredAverages(values: readonly number[], cycle: number): (number | null)[] {
  const half = Math.floor(cycle / 2);
  const even = cycle % 2 === 0;
  return values.map((_, t) => {
    if (t < half || t + half >= values.length) return null;
    let sum = 0;
    for (let k = -half; k <= half; k++) {
      const weight = even && Math.abs(k) === half ? 0.5 : 1;
      sum += values[t + k]! * weight;
    }
    return sum / cycle;
  });
}

/**
 * Each phase's median ratio to the local level, in bp, rescaled so the mean
 * index is exactly 10 000.
 *
 * Ratio-to-moving-average rather than spec §H.2's `median{y : phase = i} /
 * median{y}`, because that form cannot tell a season from a trend: on two years
 * of a rising series every December is larger than every January for reasons
 * that have nothing to do with December, and the "seasonal" index it produces
 * is the trend, applied twice. Dividing by the local level removes it.
 */
function seasonalIndices(grain: Grain, obs: readonly Observation[]): Record<number, number> {
  const cycle = CYCLE[grain];
  const out: Record<number, number> = {};
  const levels = centredAverages(
    obs.map((o) => o.value),
    cycle
  );
  const byPhase = new Map<number, number[]>();
  obs.forEach((o, t) => {
    const level = levels[t];
    if (level === null || level === undefined || level === 0) return;
    const phase = phaseOf(grain, o.period);
    byPhase.set(phase, [...(byPhase.get(phase) ?? []), (o.value / level) * 10_000]);
  });
  if (!byPhase.size) return out;
  // A phase with no observation is simply absent, and `indexFor` reads 10 000
  // for it: no claim rather than a guess.
  const phases = [...byPhase.keys()].sort((a, b) => a - b);
  const raw = phases.map((phase) => Math.max(1, median(byPhase.get(phase)!)));
  // Rescale the whole set so the mean index is 10 000 — the ratios between
  // phases are the seasonal claim and must survive normalisation. (Dividing by
  // the median does not give a mean of 1: it is a robust centre, not the mean.)
  const target = phases.length * 10_000;
  const sum = raw.reduce((a, b) => a + b, 0);
  const scaled = raw.map((v) => Math.max(1, Math.round((v * target) / sum)));
  const residual = target - scaled.reduce((a, b) => a + b, 0);
  if (residual !== 0 && scaled.length) {
    let largest = 0;
    for (let i = 1; i < scaled.length; i++) if (scaled[i]! > scaled[largest]!) largest = i;
    scaled[largest] = Math.max(1, scaled[largest]! + residual);
  }
  phases.forEach((phase, i) => {
    out[phase] = scaled[i]!;
  });
  return out;
}

const indexFor = (indices: Record<number, number>, grain: Grain, period: string): number =>
  indices[phaseOf(grain, period)] ?? 10_000;

interface HoltState {
  level: number;
  trend: number;
}

/** One pass of damped Holt over a deseasonalised series. */
function fitHolt(d: readonly number[], alpha: number, beta: number, phi: number): HoltState {
  let level = d[0]!;
  let trend = (d[1] ?? d[0]!) - d[0]!;
  for (let t = 1; t < d.length; t++) {
    const previous = level;
    level = alpha * d[t]! + (1 - alpha) * (level + phi * trend);
    trend = beta * (level - previous) + (1 - beta) * phi * trend;
  }
  return { level, trend };
}

/** h steps ahead: the level plus the trend, damped geometrically (spec §H.2 step 3). */
function project(state: HoltState, phi: number, h: number): number {
  let damping = 0;
  let power = 1;
  for (let i = 1; i <= h; i++) {
    power *= phi;
    damping += power;
  }
  return state.level + state.trend * damping;
}

/** Mean absolute error of the naive one-step forecast — MASE's denominator. */
function naiveScale(d: readonly number[]): number {
  if (d.length < 2) return 0;
  let sum = 0;
  for (let t = 1; t < d.length; t++) sum += Math.abs(d[t]! - d[t - 1]!);
  return sum / (d.length - 1);
}

const empty = (grain: Grain, observations: number, reason: Forecast["reason"], lastObserved: string | null): Forecast => ({
  grain,
  points: [],
  fit: {
    method: "damped_holt_seasonal",
    alphaPpm: 0,
    betaPpm: 0,
    phiPpm: 0,
    seasonal: false,
    seasonalIndexBp: {},
    masePpm: null,
    intervalSource: "default",
    observations,
    holdout: 0,
    lastObserved
  },
  ...(reason ? { reason } : {})
});

/**
 * @param history closed observations, ascending, one per period at `grain`.
 *   Gaps are taken as given: the method reads position, not calendar distance.
 */
export function forecast(grain: Grain, history: readonly Observation[], horizon: number): Forecast {
  const n = history.length;
  const lastObserved = n ? history[n - 1]!.period : null;
  if (horizon <= 0) return empty(grain, n, "empty_horizon", lastObserved);
  if (n < MIN_OBSERVATIONS) return empty(grain, n, "insufficient_history", lastObserved);

  const seasonal = n >= 2 * CYCLE[grain];
  const holdout = Math.max(1, Math.min(HOLDOUT[grain], Math.floor(n / 3)));
  const trainCount = n - holdout;
  const train = history.slice(0, trainCount);

  // Indices for scoring come from the training window only: a holdout scored
  // against a season the holdout helped define is not a holdout.
  const trainIndices = seasonal ? seasonalIndices(grain, train) : {};
  const deseason = (obs: readonly Observation[], indices: Record<number, number>): number[] =>
    obs.map((o) => (seasonal ? (o.value * 10_000) / indexFor(indices, grain, o.period) : o.value));

  const trainD = deseason(train, trainIndices);
  const scale = naiveScale(trainD);

  let best = { alpha: ALPHAS[0]!, beta: BETAS[0]!, phi: PHIS[PHIS.length - 1]!, mase: Number.POSITIVE_INFINITY };
  const residuals: number[] = [];
  if (trainD.length >= 2) {
    for (const alpha of ALPHAS) {
      for (const beta of BETAS) {
        for (const phi of PHIS) {
          const state = fitHolt(trainD, alpha, beta, phi);
          let error = 0;
          for (let h = 1; h <= holdout; h++) {
            const actual = history[trainCount + h - 1]!;
            const projected = project(state, phi, h) * (seasonal ? indexFor(trainIndices, grain, actual.period) / 10_000 : 1);
            error += Math.abs(actual.value - projected);
          }
          const mase = error / holdout / (scale || 1);
          if (mase < best.mase) best = { alpha, beta, phi, mase };
        }
      }
    }

    // Residuals of the winning fit, as a signed fraction of the actual in bp and
    // normalised by √h, so pooling across horizons does not mix their spreads.
    const state = fitHolt(trainD, best.alpha, best.beta, best.phi);
    for (let h = 1; h <= holdout; h++) {
      const actual = history[trainCount + h - 1]!;
      if (actual.value === 0) continue; // a zero has no relative error
      const projected = project(state, best.phi, h) * (seasonal ? indexFor(trainIndices, grain, actual.period) / 10_000 : 1);
      residuals.push(((actual.value - projected) / Math.abs(actual.value)) * 10_000 / Math.sqrt(h));
    }
  }

  // The published fit uses every observation, including the holdout: the
  // holdout exists to choose the parameters, not to be thrown away.
  const indices = seasonal ? seasonalIndices(grain, history) : {};
  const state = fitHolt(deseason(history, indices), best.alpha, best.beta, best.phi);

  const empirical = residuals.length >= MIN_RESIDUALS;
  const lowBp = empirical ? quantile(residuals, 0.1) : -DEFAULT_BAND_BP;
  const highBp = empirical ? quantile(residuals, 0.9) : DEFAULT_BAND_BP;

  const points: ForecastPoint[] = [];
  let period = lastObserved!;
  for (let h = 1; h <= horizon; h++) {
    period = nextPeriod(grain, period);
    const p50 = project(state, best.phi, h) * (seasonal ? indexFor(indices, grain, period) / 10_000 : 1);
    const spread = Math.sqrt(h) / 10_000;
    points.push({
      period,
      p10: Math.round(p50 * (1 + lowBp * spread)),
      p50: Math.round(p50),
      p90: Math.round(p50 * (1 + highBp * spread))
    });
  }

  return {
    grain,
    points,
    fit: {
      method: "damped_holt_seasonal",
      alphaPpm: Math.round(best.alpha * 1_000_000),
      betaPpm: Math.round(best.beta * 1_000_000),
      phiPpm: Math.round(best.phi * 1_000_000),
      seasonal,
      seasonalIndexBp: indices,
      masePpm: Number.isFinite(best.mase) ? Math.round(best.mase * 1_000_000) : null,
      intervalSource: empirical ? "empirical" : "default",
      observations: n,
      holdout,
      lastObserved
    }
  };
}

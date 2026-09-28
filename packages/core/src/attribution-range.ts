// docs/17 SIG-057, ADR-0109: attribution reported as a range with its method
// disclosed. Cost per acquisition is spend over a *count* of attributed binds,
// and a count is a draw: ten binds this month could as easily have been seven
// or fourteen. A success fee settled on a single point would be settled on
// noise, so the figure is carried as an interval and the fee references its
// lower bound.
//
// Two sources of uncertainty, combined by envelope rather than by pretending
// they are independent:
//
//  1. Sampling — Garwood's exact (central, equal-tailed) Poisson interval on
//     the count. Exact means it is solved from the Poisson tails themselves,
//     not a normal approximation, so it stays honest at the small counts a
//     single channel in a single month actually has, and it holds its coverage
//     at k = 1. It is conservative (coverage ≥ the nominal level), which is the
//     right side to err on for money.
//  2. Credit — which binds a channel is credited with depends on the model
//     (last touch, first touch, any touch). `creditLow`/`creditHigh` are the
//     fewest and most binds any single-credit model could give it; the cost
//     interval spans the count interval of both.
//
// Pure, no dependency: the Poisson CDF is summed in log space and each bound
// found by bisection on its tail equation (the CDF is monotone in the mean).

/** The level every surface reports at unless asked otherwise (ADR-0109). */
export const ATTRIBUTION_CONFIDENCE = 0.95;

export type AttributionMethod = "poisson_exact" | "poisson_exact_credit_envelope";

export interface CountInterval {
  lower: number;
  upper: number;
}

export interface CacRangeInput {
  /** Spend in minor units over the window. */
  spendMinor: number;
  /** Binds credited under the reporting model (last touch). */
  conversions: number;
  /** Fewest binds any single-credit model credits. Defaults to `conversions`. */
  creditLow?: number;
  /** Most binds any single-credit model credits. Defaults to `conversions`. */
  creditHigh?: number;
  confidence?: number;
}

export interface CacRange {
  /** Cheapest defensible cost per acquisition, minor units, rounded down. */
  low: number;
  /** Spend over the reported count, rounded to the nearest minor unit. */
  point: number;
  /** Dearest defensible cost, rounded up; null when some model credits nothing — no upper bound exists. */
  high: number | null;
  method: AttributionMethod;
  /** i18n key a screen resolves to name the method. */
  methodKey: `attribution.method.${AttributionMethod}`;
  confidence: number;
  conversions: { low: number; point: number; high: number };
  /** The count interval the cost interval was inverted from. */
  countInterval: CountInterval;
}

const isCount = (n: number): boolean => Number.isInteger(n) && n >= 0;

function mustCount(n: number, name: string): void {
  if (!isCount(n)) throw new RangeError(`${name} must be a non-negative integer, got ${n}`);
}

function mustConfidence(confidence: number): void {
  if (!(confidence > 0 && confidence < 1)) throw new RangeError(`confidence must lie strictly between 0 and 1, got ${confidence}`);
}

/**
 * P(X ≤ k) for X ~ Poisson(mu). Summed in log space around the largest term,
 * so a mean in the thousands does not underflow e^-mu to zero.
 */
export function poissonCdf(k: number, mu: number): number {
  mustCount(k, "k");
  if (!(mu >= 0)) throw new RangeError(`mu must be a non-negative number, got ${mu}`);
  if (mu === 0) return 1;
  const logMu = Math.log(mu);
  // log of each term, by the recurrence t_i = t_{i-1} + ln(mu) - ln(i).
  const logs: number[] = [-mu];
  for (let i = 1; i <= k; i++) logs.push(logs[i - 1]! + logMu - Math.log(i));
  let top = -Infinity;
  for (const log of logs) top = Math.max(top, log);
  let sum = 0;
  for (const log of logs) sum += Math.exp(log - top);
  return Math.min(1, Math.exp(top + Math.log(sum)));
}

/** Bisection for the mean at which a decreasing function of it crosses `target`. */
function solveDecreasing(f: (mu: number) => number, target: number, lo: number, hi: number): number {
  for (let i = 0; i < 200 && hi - lo > 1e-12 * Math.max(1, hi); i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Garwood's exact two-sided interval on a Poisson mean given `k` observed.
 * Upper: P(X ≤ k; mu) = α/2. Lower: P(X ≥ k; mu) = α/2, i.e.
 * P(X ≤ k-1; mu) = 1-α/2, and 0 when nothing was observed.
 */
export function poissonInterval(k: number, confidence: number = ATTRIBUTION_CONFIDENCE): CountInterval {
  mustCount(k, "k");
  mustConfidence(confidence);
  const tail = (1 - confidence) / 2;
  // Every bound sits within k ± (a generous multiple of) sqrt(k) + a constant.
  const reach = 20 * Math.sqrt(k + 1) + 20;
  const upper = solveDecreasing((mu) => poissonCdf(k, mu), tail, k, k + reach);
  const lower = k === 0 ? 0 : solveDecreasing((mu) => poissonCdf(k - 1, mu), 1 - tail, 0, k);
  return { lower, upper };
}

/**
 * Cost per acquisition as an interval. More binds means a cheaper acquisition,
 * so the cost's low end comes from the count's upper bound and vice versa.
 * Rounded outward, so the reported range always contains the exact one.
 */
export function cacRange(input: CacRangeInput): CacRange | null {
  const { spendMinor, conversions } = input;
  const creditLow = input.creditLow ?? conversions;
  const creditHigh = input.creditHigh ?? conversions;
  const confidence = input.confidence ?? ATTRIBUTION_CONFIDENCE;
  mustCount(spendMinor, "spendMinor");
  mustCount(conversions, "conversions");
  mustCount(creditLow, "creditLow");
  mustCount(creditHigh, "creditHigh");
  if (creditLow > conversions || creditHigh < conversions) {
    throw new RangeError(`credit bounds [${creditLow}, ${creditHigh}] must contain the reported ${conversions}`);
  }
  mustConfidence(confidence);
  if (conversions === 0) return null;

  const countInterval: CountInterval = {
    lower: poissonInterval(creditLow, confidence).lower,
    upper: poissonInterval(creditHigh, confidence).upper
  };
  const method: AttributionMethod =
    creditLow === conversions && creditHigh === conversions ? "poisson_exact" : "poisson_exact_credit_envelope";
  return {
    low: Math.floor(spendMinor / countInterval.upper),
    point: Math.round(spendMinor / conversions),
    high: countInterval.lower > 0 ? Math.ceil(spendMinor / countInterval.lower) : null,
    method,
    methodKey: `attribution.method.${method}`,
    confidence,
    conversions: { low: creditLow, point: conversions, high: creditHigh },
    countInterval
  };
}

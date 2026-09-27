// docs/30 SCOUT 5 / docs/modules/scout.md §2.3 and §2.5 ("demand curves,
// elasticity") — how much a line's win rate moves when its price moves, read
// from the bench cells `buildPanelBench` (bench.ts) already writes. Pure, so the
// route owns only the read and the screen only the words.
//
// ponytail: this is an observational slope across provider x month cells, not
// a controlled price test. Cells differ in more than price (cover, latency — the
// seed's own gap notes say so), so the number says "on this panel, dearer rows
// won less by this much", never "raise price 1% and lose e%". The screen's note
// carries that sentence; nothing here claims causality.

/** One bench cell, as the fit needs it — a subset of `BenchRow` / the stored row. */
export interface ElasticityObservation {
  readonly line: string;
  /** Basis points against the panel median (10000 = at the median). */
  readonly ourPriceIdx: number | null;
  /** 0-100. */
  readonly winRate: number | null;
  /** Answers in the cell — the fit's weight. */
  readonly volume: number;
}

export type ElasticityState = "estimated" | "insufficient";
export type ElasticityGap = "too-few" | "no-spread";

export interface Elasticity {
  readonly state: ElasticityState;
  /** Why no slope was fitted; null when one was. */
  readonly reason: ElasticityGap | null;
  /** Cells that entered the fit. */
  readonly observations: number;
  /** Answers across those cells. */
  readonly volume: number;
  /** d ln(win share) / d ln(price index). Negative = dearer loses more. */
  readonly elasticity: number | null;
  /** 95% interval on the slope (Student t on n-2 df). */
  readonly low: number | null;
  readonly high: number | null;
  readonly rSquared: number | null;
  /** The interval excludes zero — the data shows a direction, not just a number. */
  readonly clear: boolean;
}

export interface LineElasticity extends Elasticity {
  readonly line: string;
}

/** A slope through fewer cells than this is a line through noise. */
export const ELASTICITY_MIN_OBSERVATIONS = 5;

/** Weighted SD of ln(price index) below which the cells are "all the same
 *  price" (about 2%): the slope is undefined there, not zero. */
export const ELASTICITY_MIN_SPREAD = 0.02;

/** Two-sided 95% Student t by degrees of freedom. */
const T95: ReadonlyArray<readonly [number, number]> = [
  [1, 12.706],
  [2, 4.303],
  [3, 3.182],
  [4, 2.776],
  [5, 2.571],
  [6, 2.447],
  [7, 2.365],
  [8, 2.306],
  [9, 2.262],
  [10, 2.228],
  [12, 2.179],
  [15, 2.131],
  [20, 2.086],
  [30, 2.042],
  [40, 2.021],
  [60, 2.0],
  [120, 1.98]
];

/** Critical t for a 95% interval. Between tabulated entries it takes the next
 *  lower df (a larger t), so a gap in the table widens the interval rather
 *  than narrowing it; beyond 120 df it is the normal 1.96. */
export function tCritical95(df: number): number {
  if (df > 120) return 1.96;
  let t = T95[0]![1];
  for (const [d, v] of T95) if (d <= df) t = v;
  return t;
}

const NONE = { elasticity: null, low: null, high: null, rSquared: null, clear: false } as const;

/**
 * Volume-weighted least squares of ln(win share) on ln(price index / 10000).
 *
 * Win share is smoothed by half a win — (wins + 0.5) / (volume + 1) — so a cell
 * that won nothing stays on the log scale instead of being dropped: dropping
 * zeros would throw away exactly the dearest, most-losing cells and flatten the
 * slope. Weighting by volume means a 40-answer cell cannot pull the fit as hard
 * as a 1,800-answer one.
 */
export function estimateElasticity(cells: readonly ElasticityObservation[]): Elasticity {
  const points = cells.flatMap((cell) =>
    cell.ourPriceIdx !== null && cell.ourPriceIdx > 0 && cell.winRate !== null && cell.volume > 0
      ? [
          {
            x: Math.log(cell.ourPriceIdx / 10_000),
            y: Math.log(((cell.winRate / 100) * cell.volume + 0.5) / (cell.volume + 1)),
            w: cell.volume
          }
        ]
      : []
  );
  const volume = points.reduce((sum, p) => sum + p.w, 0);
  const n = points.length;
  if (n < ELASTICITY_MIN_OBSERVATIONS) return { state: "insufficient", reason: "too-few", observations: n, volume, ...NONE };

  const mx = points.reduce((sum, p) => sum + p.w * p.x, 0) / volume;
  const my = points.reduce((sum, p) => sum + p.w * p.y, 0) / volume;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += p.w * (p.x - mx) ** 2;
    sxy += p.w * (p.x - mx) * (p.y - my);
    syy += p.w * (p.y - my) ** 2;
  }
  if (Math.sqrt(sxx / volume) < ELASTICITY_MIN_SPREAD) {
    return { state: "insufficient", reason: "no-spread", observations: n, volume, ...NONE };
  }

  const slope = sxy / sxx;
  // Residual sum of squares, floored at zero against float cancellation on a
  // perfect fit (a tiny negative would make the interval NaN).
  const rss = Math.max(0, syy - slope * sxy);
  const se = Math.sqrt(rss / (n - 2) / sxx);
  const half = tCritical95(n - 2) * se;
  const low = slope - half;
  const high = slope + half;
  return {
    state: "estimated",
    reason: null,
    observations: n,
    volume,
    elasticity: slope,
    low,
    high,
    rSquared: syy > 0 ? 1 - rss / syy : 1,
    clear: high < 0 || low > 0
  };
}

/** One estimate per line, lines in name order so two reads render the same. */
export function priceElasticityByLine(rows: readonly ElasticityObservation[]): LineElasticity[] {
  const byLine = new Map<string, ElasticityObservation[]>();
  for (const row of rows) byLine.set(row.line, [...(byLine.get(row.line) ?? []), row]);
  return [...byLine.keys()].sort().map((line) => ({ line, ...estimateElasticity(byLine.get(line)!) }));
}

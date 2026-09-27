import { describe, it, expect } from "vitest";
import {
  ELASTICITY_MIN_OBSERVATIONS,
  ELASTICITY_MIN_SPREAD,
  estimateElasticity,
  priceElasticityByLine,
  tCritical95,
  type ElasticityObservation
} from "./elasticity.js";

// A cell sitting exactly on a constant-elasticity curve: winShare = a * idx^e.
// Large volume so the half-win smoothing barely moves the point.
const onCurve = (idx: number, e: number, over: Partial<ElasticityObservation> = {}): ElasticityObservation => ({
  line: "motor",
  ourPriceIdx: idx,
  winRate: 30 * Math.pow(idx / 10_000, e),
  volume: 1_000_000,
  ...over
});

const spread = [8_000, 9_000, 10_000, 11_000, 12_000];

describe("tCritical95", () => {
  it("reads the two-sided 95% Student t for small samples and the normal beyond the table", () => {
    expect(tCritical95(3)).toBe(3.182);
    expect(tCritical95(10)).toBe(2.228);
    expect(tCritical95(1_000)).toBe(1.96);
  });

  it("holds the textbook value at every tabulated df", () => {
    const table: Array<[number, number]> = [
      [2, 4.303], [4, 2.776], [5, 2.571], [6, 2.447], [7, 2.365], [8, 2.306],
      [9, 2.262], [12, 2.179], [15, 2.131], [20, 2.086], [40, 2.021], [60, 2.0]
    ];
    for (const [df, t] of table) expect(tCritical95(df)).toBe(t);
  });

  it("takes the next lower tabulated df between entries, so a gap errs wide, never narrow", () => {
    expect(tCritical95(11)).toBe(2.228);
    expect(tCritical95(25)).toBe(2.086);
    expect(tCritical95(30)).toBe(2.042);
    expect(tCritical95(31)).toBe(2.042);
    expect(tCritical95(50)).toBe(2.021);
    expect(tCritical95(120)).toBe(1.98);
    expect(tCritical95(121)).toBe(1.96);
    expect(tCritical95(1)).toBe(12.706);
  });
});

describe("estimateElasticity", () => {
  it("recovers the exponent of a constant-elasticity curve", () => {
    const got = estimateElasticity(spread.map((idx) => onCurve(idx, -2)));
    expect(got.state).toBe("estimated");
    expect(got.elasticity).toBeCloseTo(-2, 3);
    expect(got.rSquared).toBeCloseTo(1, 5);
    expect(got.observations).toBe(5);
    expect(got.volume).toBe(5_000_000);
    expect(got.clear).toBe(true);
    expect(got.low!).toBeLessThanOrEqual(got.elasticity!);
    expect(got.high!).toBeGreaterThanOrEqual(got.elasticity!);
  });

  it("is order-independent", () => {
    const cells = spread.map((idx) => onCurve(idx, -1.5));
    const a = estimateElasticity(cells);
    const b = estimateElasticity([...cells].reverse());
    expect(b.elasticity).toBeCloseTo(a.elasticity!, 6);
    expect(b.low).toBeCloseTo(a.low!, 6);
  });

  it("says 'too few' rather than fitting a line through fewer than the minimum cells", () => {
    const got = estimateElasticity(spread.slice(0, ELASTICITY_MIN_OBSERVATIONS - 1).map((idx) => onCurve(idx, -2)));
    expect(got).toMatchObject({ state: "insufficient", reason: "too-few", observations: 4, elasticity: null, low: null, high: null, rSquared: null, clear: false });
  });

  it("counts only priced cells with a win rate and some volume", () => {
    const cells = [
      ...spread.slice(0, 4).map((idx) => onCurve(idx, -2)),
      onCurve(12_000, -2, { ourPriceIdx: null }),
      onCurve(12_000, -2, { ourPriceIdx: 0 }),
      onCurve(12_000, -2, { winRate: null }),
      onCurve(12_000, -2, { volume: 0 })
    ];
    const got = estimateElasticity(cells);
    expect(got.observations).toBe(4);
    expect(got.reason).toBe("too-few");
  });

  it("says 'no spread' when every cell sits at (nearly) the same price — the slope is undefined, not zero", () => {
    const flat = [10_000, 10_010, 9_995, 10_005, 10_000].map((idx, i) => onCurve(idx, -2, { winRate: 20 + i }));
    const got = estimateElasticity(flat);
    expect(got).toMatchObject({ state: "insufficient", reason: "no-spread", observations: 5, elasticity: null });
  });

  it("fits right at the spread floor and refuses just under it", () => {
    // Two cells either side of the median in log space: SD of ln(idx) equals the offset.
    const at = (d: number) => [-d, d, -d, d, 0].map((x) => onCurve(Math.round(10_000 * Math.exp(x)), -2));
    expect(estimateElasticity(at(ELASTICITY_MIN_SPREAD * 1.3)).state).toBe("estimated");
    expect(estimateElasticity(at(ELASTICITY_MIN_SPREAD * 0.8)).reason).toBe("no-spread");
  });

  it("widens the interval across zero when win rate does not move with price", () => {
    // Win rate zig-zags independently of price: no evidence either way.
    const noisy = spread.map((idx, i) => onCurve(idx, 0, { winRate: [30, 10, 40, 12, 28][i]!, volume: 50 }));
    const got = estimateElasticity(noisy);
    expect(got.state).toBe("estimated");
    expect(got.low!).toBeLessThan(0);
    expect(got.high!).toBeGreaterThan(0);
    expect(got.clear).toBe(false);
    expect(got.rSquared!).toBeLessThan(0.5);
  });

  it("weights a cell by its volume, so a thin outlier moves the slope less than a thick one", () => {
    const base = spread.map((idx) => onCurve(idx, -2, { volume: 1_000 }));
    const outlier = (volume: number) => onCurve(12_000, 3, { volume });
    const thin = estimateElasticity([...base, outlier(10)]).elasticity!;
    const thick = estimateElasticity([...base, outlier(100_000)]).elasticity!;
    expect(Math.abs(thin - -2)).toBeLessThan(Math.abs(thick - -2));
  });

  it("keeps a zero win rate on the log scale by half-a-win smoothing instead of dropping it", () => {
    const cells = spread.map((idx, i) => onCurve(idx, -2, { winRate: [40, 30, 20, 10, 0][i]!, volume: 200 }));
    const got = estimateElasticity(cells);
    expect(got.observations).toBe(5);
    expect(Number.isFinite(got.elasticity!)).toBe(true);
    expect(got.elasticity!).toBeLessThan(-3);
  });

  it("reports a perfect fit with a zero-width interval rather than NaN", () => {
    // Exactly linear in log space with identical smoothing effect: residuals vanish.
    const got = estimateElasticity(spread.map((idx) => onCurve(idx, -1, { volume: 1e12 })));
    expect(got.high! - got.low!).toBeLessThan(1e-3);
    expect(Number.isNaN(got.low!)).toBe(false);
  });
});

describe("priceElasticityByLine", () => {
  it("fits each line on its own cells and orders lines by name", () => {
    const rows = [
      ...spread.map((idx) => onCurve(idx, -2, { line: "travel" })),
      ...spread.map((idx) => onCurve(idx, -0.5, { line: "motor" })),
      onCurve(10_000, -1, { line: "health" })
    ];
    const got = priceElasticityByLine(rows);
    expect(got.map((one) => one.line)).toEqual(["health", "motor", "travel"]);
    expect(got[0]).toMatchObject({ line: "health", state: "insufficient", reason: "too-few", observations: 1 });
    expect(got[1]!.elasticity).toBeCloseTo(-0.5, 3);
    expect(got[2]!.elasticity).toBeCloseTo(-2, 3);
  });

  it("returns nothing for no rows", () => {
    expect(priceElasticityByLine([])).toEqual([]);
  });
});

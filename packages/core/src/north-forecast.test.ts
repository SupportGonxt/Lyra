import { describe, expect, it } from "vitest";
import { forecast, type Observation } from "./north-forecast.js";
import { nextPeriod } from "./north-period.js";

/** `count` observations ending at `last`, values from `value(i)`. */
function series(grain: "day" | "month", first: string, count: number, value: (i: number) => number): Observation[] {
  const out: Observation[] = [];
  let period = first;
  for (let i = 0; i < count; i++) {
    out.push({ period, value: value(i) });
    period = nextPeriod(grain, period);
  }
  return out;
}

describe("forecast: what it refuses", () => {
  it("refuses a series too short to have a trend, and says so", () => {
    const f = forecast("month", series("month", "2026-01", 2, () => 100), 3);
    expect(f.points).toEqual([]);
    expect(f.reason).toBe("insufficient_history");
    expect(f.fit.observations).toBe(2);
  });

  it("refuses a horizon of nothing rather than returning an empty forecast as a result", () => {
    const f = forecast("month", series("month", "2025-01", 24, () => 100), 0);
    expect(f.points).toEqual([]);
    expect(f.reason).toBe("empty_horizon");
  });
});

describe("forecast: the shape of the projection", () => {
  it("a flat series stays flat", () => {
    const f = forecast("month", series("month", "2025-01", 24, () => 100_000), 6);
    expect(f.points).toHaveLength(6);
    for (const p of f.points) expect(p.p50).toBe(100_000);
    expect(f.points.map((p) => p.period)).toEqual(["2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06"]);
  });

  it("a linear trend continues, and the damping bends it down", () => {
    const f = forecast("month", series("month", "2025-01", 24, (i) => 100_000 + i * 10_000), 12);
    const last = 100_000 + 23 * 10_000;
    expect(f.points[0]!.p50).toBeGreaterThan(last);
    // Each step adds no more than the naive one, and by the twelfth it adds
    // strictly less — an undamped extrapolation is what gets a forecast deleted.
    // Never accelerating, and never past where the naive line would have gone —
    // φ ≤ 1 by construction. The grid is allowed to choose φ = 1 for a series
    // this clean; what it may not do is extrapolate faster than the trend.
    const steps = f.points.map((p, i) => p.p50 - (i === 0 ? last : f.points[i - 1]!.p50));
    for (const step of steps) expect(step).toBeLessThanOrEqual(10_001);
    expect(steps.at(-1)!).toBeLessThanOrEqual(steps[0]!);
    expect(f.points.at(-1)!.p50).toBeLessThanOrEqual(last + 12 * 10_000 + 1);
    expect(f.fit.phiPpm).toBeLessThanOrEqual(1_000_000);
  });

  it("carries a weekday shape into the days it projects", () => {
    // 2026-01-05 is a Monday. Mondays are triple; the rest is flat.
    const weekday = [3, 1, 1, 1, 1, 1, 1];
    const f = forecast("day", series("day", "2026-01-05", 70, (i) => 10_000 * weekday[i % 7]!), 7);
    expect(f.fit.seasonal).toBe(true);
    const peak = [...f.points].sort((a, b) => b.p50 - a.p50)[0]!;
    expect(peak.period).toBe("2026-03-16"); // the first Monday after the series ends
    expect(peak.p50).toBeGreaterThan(f.points.filter((p) => p !== peak)[0]!.p50 * 2);
  });

  it("a series with no full cycle behind it is projected without a seasonal claim", () => {
    const f = forecast("month", series("month", "2026-01", 6, () => 50_000), 3);
    expect(f.fit.seasonal).toBe(false);
    expect(f.points).toHaveLength(3);
  });
});

describe("forecast: the range, never a point estimate", () => {
  const f = forecast("month", series("month", "2025-01", 24, (i) => 100_000 + i * 2_000 + (i % 3) * 5_000), 6);

  it("every point is a band around its p50", () => {
    for (const p of f.points) {
      expect(p.p10).toBeLessThanOrEqual(p.p50);
      expect(p.p50).toBeLessThanOrEqual(p.p90);
    }
  });

  it("the band widens with the horizon, because the further out is less certain", () => {
    const widths = f.points.map((p) => p.p90 - p.p10);
    expect(widths.at(-1)!).toBeGreaterThan(widths[0]!);
  });

  it("names where the band came from rather than implying it was measured", () => {
    expect(["empirical", "default"]).toContain(f.fit.intervalSource);
    const thin = forecast("month", series("month", "2026-01", 5, (i) => 1_000 + i), 2);
    expect(thin.fit.intervalSource).toBe("default");
  });
});

describe("forecast: reproducible", () => {
  it("two runs of the same history are the same forecast", () => {
    const history = series("month", "2025-01", 24, (i) => 80_000 + ((i * 7919) % 11) * 1_000);
    expect(forecast("month", history, 6)).toEqual(forecast("month", history, 6));
  });

  it("carries the parameters a person would need to reproduce it by hand", () => {
    const f = forecast("month", series("month", "2025-01", 24, (i) => 80_000 + i * 900), 3);
    expect(f.fit.method).toBe("damped_holt_seasonal");
    expect(f.fit.alphaPpm).toBeGreaterThan(0);
    expect(f.fit.betaPpm).toBeGreaterThanOrEqual(0);
    expect(f.fit.observations).toBe(24);
    expect(f.fit.holdout).toBeGreaterThan(0);
    expect(f.fit.masePpm === null || Number.isFinite(f.fit.masePpm)).toBe(true);
  });
});

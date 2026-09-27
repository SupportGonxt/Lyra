import { describe, expect, it } from "vitest";
import { forecast, type Observation } from "./north-forecast.js";
import { nextPeriod } from "./north-period.js";
import { MAX_SCENARIO_HORIZON, projectScenario, readScenarioDriver } from "./north-scenario.js";

// docs/30 NORTH 4, ADR-0103. The what-if screen stored a question and nothing
// computed it. The engine reads one driver out of the stored assumptions — a
// metric, a relative change to it, a horizon at the metric's grain — and
// shifts the metric's own forecast band by it. Arithmetic, not a model call.

function series(grain: "day" | "month", first: string, count: number, value: (i: number) => number): Observation[] {
  const out: Observation[] = [];
  let period = first;
  for (let i = 0; i < count; i++) {
    out.push({ period, value: value(i) });
    period = nextPeriod(grain, period);
  }
  return out;
}

describe("readScenarioDriver: what the engine reads out of the assumptions", () => {
  it("reads a metric, a signed change in basis points and a horizon in months for a monthly metric", () => {
    expect(readScenarioDriver({ metric: "gwp", changeBps: -500, horizonMonths: 6 }, "month")).toEqual({
      driver: { metric: "gwp", changeBps: -500, horizon: 6, ignored: [] }
    });
  });

  it("takes the horizon in days for a daily metric, and ignores a horizon in months there", () => {
    expect(readScenarioDriver({ metric: "gwp", changeBps: 1_000, horizonDays: 14, horizonMonths: 6 }, "day")).toEqual({
      driver: { metric: "gwp", changeBps: 1_000, horizon: 14, ignored: ["horizonMonths"] }
    });
  });

  it("names every assumption it did not read, sorted, so nobody thinks one was applied", () => {
    const read = readScenarioDriver(
      { volumeUpliftBps: 1_200, metric: "gwp", changeBps: 0, horizonMonths: 1, currency: "AED", horizonDays: 3 },
      "month"
    );
    expect(read).toEqual({ driver: { metric: "gwp", changeBps: 0, horizon: 1, ignored: ["currency", "horizonDays", "volumeUpliftBps"] } });
  });

  it("accepts numbers written as text, since a form posts text, and trims the metric key", () => {
    expect(readScenarioDriver({ metric: " gwp ", changeBps: "-250", horizonMonths: " 3 " }, "month")).toEqual({
      driver: { metric: "gwp", changeBps: -250, horizon: 3, ignored: [] }
    });
  });

  it("reports every problem at once, keyed by the assumption it is about", () => {
    expect(readScenarioDriver({}, null)).toEqual({ errors: { metric: "missing", changeBps: "missing" } });
    expect(readScenarioDriver({ metric: "", changeBps: "" }, null)).toEqual({
      errors: { metric: "missing", changeBps: "missing" }
    });
    expect(readScenarioDriver({ metric: "gwp" }, "month")).toEqual({
      errors: { changeBps: "missing", horizonMonths: "missing" }
    });
    expect(readScenarioDriver({ metric: "gwp", changeBps: 10 }, "day")).toEqual({ errors: { horizonDays: "missing" } });
    // A cleared value and a blank line are missing, not "not a number".
    expect(readScenarioDriver({ metric: "gwp", changeBps: null, horizonMonths: "   " }, "month")).toEqual({
      errors: { changeBps: "missing", horizonMonths: "missing" }
    });
  });

  it("says a metric that resolved to nothing is unknown, and one at a grain nothing forecasts is unsupported", () => {
    expect(readScenarioDriver({ metric: "nope", changeBps: 10, horizonMonths: 3 }, null)).toEqual({
      errors: { metric: "unknown" }
    });
    expect(readScenarioDriver({ metric: "gwp", changeBps: 10, horizonMonths: 3 }, "week")).toEqual({
      errors: { metric: "unsupported_grain" }
    });
    expect(readScenarioDriver({ metric: 42, changeBps: 10 }, null)).toEqual({ errors: { metric: "missing" } });
  });

  it("refuses a fraction, a non-number, and anything outside the bounds", () => {
    expect(readScenarioDriver({ metric: "gwp", changeBps: 1.5, horizonMonths: 2.5 }, "month")).toEqual({
      errors: { changeBps: "not_integer", horizonMonths: "not_integer" }
    });
    expect(readScenarioDriver({ metric: "gwp", changeBps: "ten", horizonMonths: true }, "month")).toEqual({
      errors: { changeBps: "not_integer", horizonMonths: "not_integer" }
    });
    // A metric cannot fall by more than all of itself.
    expect(readScenarioDriver({ metric: "gwp", changeBps: -10_001, horizonMonths: 0 }, "month")).toEqual({
      errors: { changeBps: "out_of_range", horizonMonths: "out_of_range" }
    });
    expect(
      readScenarioDriver({ metric: "gwp", changeBps: 100_001, horizonMonths: MAX_SCENARIO_HORIZON + 1 }, "month")
    ).toEqual({ errors: { changeBps: "out_of_range", horizonMonths: "out_of_range" } });
  });

  it("takes the bounds themselves", () => {
    expect(
      readScenarioDriver({ metric: "gwp", changeBps: -10_000, horizonMonths: MAX_SCENARIO_HORIZON }, "month")
    ).toMatchObject({ driver: { changeBps: -10_000, horizon: MAX_SCENARIO_HORIZON } });
    expect(readScenarioDriver({ metric: "gwp", changeBps: 100_000, horizonMonths: 1 }, "month")).toMatchObject({
      driver: { changeBps: 100_000, horizon: 1 }
    });
  });

  it("reads nothing out of something that is not an object", () => {
    expect(readScenarioDriver(null, "month")).toEqual({ errors: { metric: "missing", changeBps: "missing" } });
    expect(readScenarioDriver(["gwp"], "month")).toEqual({ errors: { metric: "missing", changeBps: "missing" } });
  });
});

describe("projectScenario: the baseline band, shifted", () => {
  const history = series("month", "2025-01", 24, (i) => 100_000 + i * 1_000 + (i % 3) * 700);

  it("keeps the baseline as the metric's own forecast, and moves every quantile by the change", () => {
    const base = forecast("month", history, 6);
    const run = projectScenario("month", history, { metric: "gwp", changeBps: 1_000, horizon: 6, ignored: ["note"] });

    expect(run.method).toBe("baseline_shift");
    expect(run).toMatchObject({ metricKey: "gwp", grain: "month", changeBps: 1_000, horizon: 6, ignored: ["note"] });
    expect(run.reason).toBeUndefined();
    expect(run.fit).toEqual(base.fit);
    expect(run.points.map((p) => p.period)).toEqual(base.points.map((p) => p.period));
    run.points.forEach((point, i) => {
      const b = base.points[i]!;
      expect(point.baseline).toEqual({ p10: b.p10, p50: b.p50, p90: b.p90 });
      expect(point.scenario).toEqual({
        p10: Math.round((b.p10 * 11_000) / 10_000),
        p50: Math.round((b.p50 * 11_000) / 10_000),
        p90: Math.round((b.p90 * 11_000) / 10_000)
      });
      expect(point.delta.p50).toBe(point.scenario.p50 - point.baseline.p50);
    });
  });

  it("is a range, never a point: the scenario band keeps the baseline's width scaled", () => {
    const run = projectScenario("month", history, { metric: "gwp", changeBps: 1_000, horizon: 3, ignored: [] });
    for (const point of run.points) {
      expect(point.scenario.p10).toBeLessThan(point.scenario.p50);
      expect(point.scenario.p50).toBeLessThan(point.scenario.p90);
      expect(point.delta.p10).toBeLessThanOrEqual(point.delta.p50);
      expect(point.delta.p50).toBeLessThanOrEqual(point.delta.p90);
    }
  });

  it("orders the delta band low to high when the change is a fall", () => {
    const run = projectScenario("month", history, { metric: "gwp", changeBps: -500, horizon: 2, ignored: [] });
    for (const point of run.points) {
      const shifts = [
        point.scenario.p10 - point.baseline.p10,
        point.scenario.p50 - point.baseline.p50,
        point.scenario.p90 - point.baseline.p90
      ].sort((a, b) => a - b);
      expect(point.delta).toEqual({ p10: shifts[0], p50: shifts[1], p90: shifts[2] });
      expect(point.delta.p90).toBeLessThan(0);
      expect(point.delta.p10).toBeLessThan(point.delta.p90);
    }
  });

  it("changes nothing at zero, and removes the whole metric at -100%", () => {
    const flat = projectScenario("month", history, { metric: "gwp", changeBps: 0, horizon: 2, ignored: [] });
    for (const point of flat.points) {
      expect(point.scenario).toEqual(point.baseline);
      expect(point.delta).toEqual({ p10: 0, p50: 0, p90: 0 });
    }
    const gone = projectScenario("month", history, { metric: "gwp", changeBps: -10_000, horizon: 1, ignored: [] });
    expect(gone.points[0]!.scenario).toEqual({ p10: 0, p50: 0, p90: 0 });
    expect(gone.points[0]!.delta.p50).toBe(-gone.points[0]!.baseline.p50);
  });

  it("works at day grain", () => {
    const daily = series("day", "2026-06-01", 30, (i) => 500 + (i % 7) * 10);
    const run = projectScenario("day", daily, { metric: "orders", changeBps: 2_000, horizon: 3, ignored: [] });
    expect(run.grain).toBe("day");
    expect(run.points.map((p) => p.period)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
  });

  it("with too little history says so and projects nothing — no baseline, no invented numbers", () => {
    const run = projectScenario("month", history.slice(0, 3), { metric: "gwp", changeBps: 1_000, horizon: 6, ignored: [] });
    expect(run.points).toEqual([]);
    expect(run.reason).toBe("insufficient_history");
    expect(run.fit.observations).toBe(3);
    expect(run.fit.lastObserved).toBe("2025-03");
  });

  it("with no history at all says the same, with nothing observed", () => {
    const run = projectScenario("month", [], { metric: "gwp", changeBps: 1_000, horizon: 6, ignored: [] });
    expect(run.points).toEqual([]);
    expect(run.reason).toBe("insufficient_history");
    expect(run.fit.lastObserved).toBeNull();
  });

  it("the same history and driver is the same answer", () => {
    const driver = { metric: "gwp", changeBps: 750, horizon: 4, ignored: [] };
    expect(projectScenario("month", history, driver)).toEqual(projectScenario("month", history, driver));
  });
});

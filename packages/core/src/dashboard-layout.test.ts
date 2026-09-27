import { describe, expect, it } from "vitest";
import { applyDashboardFilters, DashboardLayoutSchema, dashboardRange, layoutProblem } from "./dashboard-layout.js";

// docs/30 Analytics 5. A dashboard's `layoutJson` is read by the tile renderer
// on every paint, so a malformed one is refused at the write rather than drawn
// as blank tiles (the CommissionStructureJson precedent, ADR-0084).

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 27, 12);

const tile = (over: Record<string, unknown> = {}) => ({
  key: "Premium",
  viz: "number",
  span: 4,
  definition: { dataset: "policies", metrics: ["gwp"] },
  ...over
});

describe("DashboardLayoutSchema", () => {
  it("accepts the tiles the seed writes, and a span defaults to four", () => {
    const parsed = DashboardLayoutSchema.parse({ tiles: [{ key: "A", viz: "bar", definition: { dataset: "cases", metrics: ["cases"] } }] });
    expect(parsed.tiles[0]!.span).toBe(4);
    expect(parsed.filters).toBeUndefined();
  });

  it("accepts a tile drawn from a saved report instead of an inline definition", () => {
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ definition: undefined, reportId: "rpt_1" })] }).success).toBe(true);
  });

  it("refuses a tile with neither a report nor a definition, and one with both", () => {
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ definition: undefined })] }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ reportId: "rpt_1" })] }).success).toBe(false);
  });

  it("refuses a span outside the twelve-column grid, a fractional one, and an unknown viz", () => {
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ span: 0 })] }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ span: 13 })] }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ span: 2.5 })] }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ viz: "pie" })] }).success).toBe(false);
  });

  it("refuses two tiles under one key, because the key is how a result finds its tile", () => {
    const result = DashboardLayoutSchema.safeParse({ tiles: [tile(), tile()] });
    expect(result.success).toBe(false);
    expect(layoutProblem(result.error!)).toEqual({ path: "tiles.1.key", message: "duplicate tile key" });
  });

  it("refuses unknown keys rather than storing what nothing reads", () => {
    expect(DashboardLayoutSchema.safeParse({ tiles: [], colour: "red" }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ metric: "gwp" })] }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [], filters: { since: 1 } }).success).toBe(false);
  });

  it("refuses a missing tile list, a blank key and more than 24 tiles", () => {
    expect(DashboardLayoutSchema.safeParse({}).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: [tile({ key: "  " })] }).success).toBe(false);
    const many = Array.from({ length: 25 }, (_, i) => tile({ key: `t${i}` }));
    expect(DashboardLayoutSchema.safeParse({ tiles: many }).success).toBe(false);
    expect(DashboardLayoutSchema.safeParse({ tiles: many.slice(0, 24) }).success).toBe(true);
  });

  it("holds the filters to one range: a rolling window or fixed dates, never both, never backwards", () => {
    const ok = (filters: unknown) => DashboardLayoutSchema.safeParse({ tiles: [], filters }).success;
    expect(ok({ lastDays: 30 })).toBe(true);
    expect(ok({ from: NOW - DAY, to: NOW })).toBe(true);
    expect(ok({ from: NOW })).toBe(true);
    expect(ok({ from: NOW, to: NOW })).toBe(true);
    expect(ok({ lastDays: 30, from: NOW })).toBe(false);
    expect(ok({ lastDays: 30, to: NOW })).toBe(false);
    expect(ok({ from: NOW, to: NOW - DAY })).toBe(false);
    expect(ok({ lastDays: 0 })).toBe(false);
    expect(ok({ lastDays: 3661 })).toBe(false);
    expect(ok({ lastDays: 3660 })).toBe(true);
    expect(ok({ where: [{ field: "status", op: "eq", value: "active" }] })).toBe(true);
    expect(ok({ where: [{ field: "status", op: "like", value: "a" }] })).toBe(false);
    expect(ok({ where: Array.from({ length: 11 }, () => ({ field: "status", op: "not_null" })) })).toBe(false);
  });

  it("names the first problem with its dotted path, the way a form posts the field", () => {
    const result = DashboardLayoutSchema.safeParse({ tiles: [tile({ span: 20 })] });
    expect(layoutProblem(result.error!).path).toBe("tiles.0.span");
    const range = DashboardLayoutSchema.safeParse({ tiles: [], filters: { from: 2, to: 1 } });
    expect(layoutProblem(range.error!)).toEqual({ path: "filters.to", message: "the range ends before it starts" });
    const both = DashboardLayoutSchema.safeParse({ tiles: [], filters: { lastDays: 7, to: 1 } });
    expect(layoutProblem(both.error!)).toEqual({ path: "filters.lastDays", message: "a rolling window cannot also have fixed dates" });
    const which = DashboardLayoutSchema.safeParse({ tiles: [tile({ definition: undefined })] });
    expect(layoutProblem(which.error!)).toEqual({ path: "tiles.0", message: "a tile names a report or carries a definition, exactly one" });
  });
});

describe("dashboardRange", () => {
  it("turns a rolling window into the instants ending now", () => {
    expect(dashboardRange({ lastDays: 7 }, NOW)).toEqual({ from: NOW - 7 * DAY, to: NOW });
  });
  it("passes fixed dates through, either end alone", () => {
    expect(dashboardRange({ from: 5, to: 9 }, NOW)).toEqual({ from: 5, to: 9 });
    expect(dashboardRange({ from: 5 }, NOW)).toEqual({ from: 5 });
    expect(dashboardRange({ to: 9 }, NOW)).toEqual({ to: 9 });
  });
  it("is nothing without a range", () => {
    expect(dashboardRange(undefined, NOW)).toEqual({});
    expect(dashboardRange({ where: [] }, NOW)).toEqual({});
  });
});

describe("applyDashboardFilters", () => {
  const def = { dataset: "policies", metrics: ["gwp"], from: 1, to: 2, filters: [{ field: "currency", op: "eq" as const, value: "AED" }] };
  const dims = new Set(["status", "currency"]);

  it("leaves a tile alone when the dashboard has no filters", () => {
    expect(applyDashboardFilters(def, undefined, dims, NOW)).toEqual({ definition: def, unfiltered: [] });
  });

  it("puts the dashboard's range over the tile's own", () => {
    const { definition } = applyDashboardFilters(def, { lastDays: 30 }, dims, NOW);
    expect(definition.from).toBe(NOW - 30 * DAY);
    expect(definition.to).toBe(NOW);
    expect(definition.filters).toEqual(def.filters);
  });

  it("replaces only the end the dashboard sets", () => {
    expect(applyDashboardFilters(def, { from: 7 }, dims, NOW).definition).toMatchObject({ from: 7, to: 2 });
  });

  it("adds a dimension filter beside the tile's own when the tile's dataset has that dimension", () => {
    const status = { field: "status", op: "eq" as const, value: "active" };
    const { definition, unfiltered } = applyDashboardFilters(def, { where: [status] }, dims, NOW);
    expect(definition.filters).toEqual([...def.filters, status]);
    expect(unfiltered).toEqual([]);
  });

  it("names the filters a tile cannot take instead of failing it, once each", () => {
    const channel = { field: "channelId", op: "eq" as const, value: "ch_1" };
    const bare = { dataset: "cases", metrics: ["cases"] };
    const { definition, unfiltered } = applyDashboardFilters(bare, { where: [channel, { ...channel, value: "ch_2" }] }, dims, NOW);
    expect(definition).toEqual(bare);
    expect(definition.filters).toBeUndefined();
    expect(unfiltered).toEqual(["channelId"]);
  });

  it("does not change the definition it was given", () => {
    const before = JSON.stringify(def);
    applyDashboardFilters(def, { lastDays: 1, where: [{ field: "status", op: "not_null" }] }, dims, NOW);
    expect(JSON.stringify(def)).toBe(before);
  });
});

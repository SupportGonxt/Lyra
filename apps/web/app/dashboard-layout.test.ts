import { describe, expect, it } from "vitest";
import {
  addTile,
  filtersFromForm,
  layoutOf,
  MAX_TILES,
  moveTile,
  rangeChoice,
  removeTile,
  reorderKey,
  resizeTile,
  spanClass,
  tileFromChoice,
  type TileSpec
} from "./dashboard-layout";
import type { DatasetInfo } from "./analytics-def";

// docs/30 Analytics 5: the tile editor's moves as pure functions, so every one
// a pointer could make is a keyboard one too and each is a one-line test.

const tile = (key: string, span = 4): TileSpec => ({ key, viz: "number", span, definition: { dataset: "policies", metrics: ["gwp"] } });
const keys = (tiles: TileSpec[]) => tiles.map((t) => t.key);

const POLICIES: DatasetInfo = {
  key: "policies",
  module: "axis",
  timeColumn: "start_at",
  dimensions: [
    { key: "status", label: "Status", kind: "text", pii: false },
    { key: "channelId", label: "Channel", kind: "text", pii: false }
  ],
  metrics: [
    { key: "gwp", label: "GWP", kind: "money", agg: "sum" },
    { key: "policies", label: "Policies", kind: "number", agg: "count" }
  ]
};

describe("layoutOf", () => {
  it("reads a stored layout as text or as the object generic CRUD hydrates", () => {
    const layout = { tiles: [tile("A")], filters: { lastDays: 30 } };
    expect(layoutOf(JSON.stringify(layout))).toEqual(layout);
    expect(layoutOf(layout)).toEqual(layout);
  });
  it("is null for anything that is not a layout, rather than a guess", () => {
    expect(layoutOf("{nope")).toBeNull();
    expect(layoutOf(null)).toBeNull();
    expect(layoutOf({ tiles: "all" })).toBeNull();
    expect(layoutOf({ tiles: [{ viz: "bar" }] })).toBeNull();
    expect(layoutOf({ tiles: [{ key: "A", viz: "pie", definition: { dataset: "x", metrics: ["y"] } }] })).toBeNull();
  });
});

describe("moveTile", () => {
  const tiles = [tile("A"), tile("B"), tile("C")];
  it("moves one tile to a new position and keeps the rest in order", () => {
    expect(keys(moveTile(tiles, 0, 2))).toEqual(["B", "C", "A"]);
    expect(keys(moveTile(tiles, 2, 0))).toEqual(["C", "A", "B"]);
    expect(keys(moveTile(tiles, 1, 2))).toEqual(["A", "C", "B"]);
  });
  it("clamps past either end and leaves the input untouched", () => {
    expect(keys(moveTile(tiles, 0, -1))).toEqual(["A", "B", "C"]);
    expect(keys(moveTile(tiles, 2, 9))).toEqual(["A", "B", "C"]);
    expect(keys(tiles)).toEqual(["A", "B", "C"]);
  });
});

describe("reorderKey", () => {
  it("moves with Alt and an arrow, to either end with Alt and Home or End", () => {
    expect(reorderKey("ArrowUp", true, 2, 4)).toBe(1);
    expect(reorderKey("ArrowDown", true, 2, 4)).toBe(3);
    expect(reorderKey("Home", true, 2, 4)).toBe(0);
    expect(reorderKey("End", true, 1, 4)).toBe(3);
  });
  it("does nothing at the edge, without Alt, or for any other key", () => {
    expect(reorderKey("ArrowUp", true, 0, 4)).toBeNull();
    expect(reorderKey("ArrowDown", true, 3, 4)).toBeNull();
    expect(reorderKey("Home", true, 0, 4)).toBeNull();
    expect(reorderKey("ArrowDown", false, 1, 4)).toBeNull();
    expect(reorderKey("Enter", true, 1, 4)).toBeNull();
  });
});

describe("resizeTile", () => {
  it("sets a span inside the twelve-column grid, rounding and clamping", () => {
    const tiles = [tile("A"), tile("B")];
    expect(resizeTile(tiles, 1, 6)[1]!.span).toBe(6);
    expect(resizeTile(tiles, 1, 40)[1]!.span).toBe(12);
    expect(resizeTile(tiles, 1, 0)[1]!.span).toBe(1);
    expect(resizeTile(tiles, 1, 7.6)[1]!.span).toBe(8);
    expect(resizeTile(tiles, 1, Number.NaN)[1]!.span).toBe(4);
    expect(tiles[1]!.span).toBe(4);
  });
});

describe("addTile and removeTile", () => {
  it("adds at the end, renaming a key already on the board", () => {
    const tiles = [tile("Premium")];
    expect(keys(addTile(tiles, tile("Premium"))!)).toEqual(["Premium", "Premium (2)"]);
    expect(keys(addTile([...tiles, tile("Premium (2)")], tile("Premium"))!)).toEqual(["Premium", "Premium (2)", "Premium (3)"]);
    expect(keys(addTile(tiles, tile("  Cases  "))!)).toEqual(["Premium", "Cases"]);
  });
  it("refuses a blank title and a full board", () => {
    expect(addTile([], tile("  "))).toBeNull();
    const full = Array.from({ length: MAX_TILES }, (_, i) => tile(`t${i}`));
    expect(addTile(full, tile("one more"))).toBeNull();
  });
  it("removes one tile by position", () => {
    expect(keys(removeTile([tile("A"), tile("B"), tile("C")], 1))).toEqual(["A", "C"]);
  });
});

describe("tileFromChoice", () => {
  it("builds the tile's definition through the builder's own form reader", () => {
    expect(tileFromChoice({ dataset: "policies", metric: "gwp", dimension: "status", grain: "none" }, POLICIES)).toEqual({
      dataset: "policies",
      metrics: ["gwp"],
      dimensions: ["status"]
    });
    expect(tileFromChoice({ dataset: "policies", metric: "policies", dimension: "", grain: "month" }, POLICIES)).toEqual({
      dataset: "policies",
      metrics: ["policies"],
      grain: "month"
    });
  });
  it("is null without a measure the dataset has", () => {
    expect(tileFromChoice({ dataset: "policies", metric: "", dimension: "", grain: "none" }, POLICIES)).toBeNull();
    expect(tileFromChoice({ dataset: "policies", metric: "nope", dimension: "", grain: "none" }, POLICIES)).toBeNull();
    expect(tileFromChoice({ dataset: "policies", metric: "gwp", dimension: "", grain: "none" }, undefined)).toBeNull();
  });
});

describe("filtersFromForm", () => {
  const form = (entries: Record<string, string>) => new URLSearchParams(entries);

  it("reads a rolling window", () => {
    expect(filtersFromForm(form({ range: "30" }))).toEqual({ lastDays: 30 });
  });
  it("reads fixed dates with the builder's day rules: the end date is inclusive", () => {
    expect(filtersFromForm(form({ range: "fixed", from: "2026-09-01", to: "2026-09-30" }))).toEqual({
      from: Date.UTC(2026, 8, 1),
      to: Date.UTC(2026, 8, 30) + 86_400_000 - 1
    });
  });
  it("ignores dates unless the range says fixed", () => {
    expect(filtersFromForm(form({ range: "", from: "2026-09-01" }))).toBeUndefined();
  });
  it("reads dimension filter rows with the builder's own encoding", () => {
    expect(filtersFromForm(form({ range: "7", "f0.field": "status", "f0.op": "in", "f0.value": "active, lapsed", "f1.field": "", "f1.op": "eq" }))).toEqual({
      lastDays: 7,
      where: [{ field: "status", op: "in", value: ["active", "lapsed"] }]
    });
  });
  it("is nothing when nothing is chosen", () => {
    expect(filtersFromForm(form({}))).toBeUndefined();
  });
});

describe("spanClass", () => {
  it("draws a span on the grid, four when unset, clamped at either edge", () => {
    expect(spanClass(6)).toBe("lg:col-span-6");
    expect(spanClass(undefined)).toBe("lg:col-span-4");
    expect(spanClass(0)).toBe("lg:col-span-1");
    expect(spanClass(30)).toBe("lg:col-span-12");
  });
});

describe("rangeChoice", () => {
  it("reads filters back to the range control's value", () => {
    expect(rangeChoice(undefined)).toBe("");
    expect(rangeChoice({ lastDays: 90 })).toBe("90");
    expect(rangeChoice({ from: 1 })).toBe("fixed");
    expect(rangeChoice({ to: 1 })).toBe("fixed");
    expect(rangeChoice({ where: [] })).toBe("");
  });
});

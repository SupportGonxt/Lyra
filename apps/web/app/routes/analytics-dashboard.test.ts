import { describe, expect, it } from "vitest";
import { filterSummary, tileHealth, unfilteredNote, type TileResult } from "./analytics-dashboard";

const table = { title: "t", columns: [], rows: [], generatedAt: 0 };

describe("tileHealth", () => {
  it("counts a tile with no table as failed even without an error string", () => {
    const tiles: TileResult[] = [{ key: "a" }, { key: "b", table }];
    expect(tileHealth(tiles)).toEqual({ ok: 1, failed: 1, total: 2 });
  });

  it("counts an explicit tile error as failed", () => {
    const tiles: TileResult[] = [{ key: "a", error: "denied" }];
    expect(tileHealth(tiles)).toEqual({ ok: 0, failed: 1, total: 1 });
  });

  it("is all-ok when every tile has a table", () => {
    const tiles: TileResult[] = [
      { key: "a", table },
      { key: "b", table }
    ];
    expect(tileHealth(tiles)).toEqual({ ok: 2, failed: 0, total: 2 });
  });

  it("is zero-total on an empty dashboard", () => {
    expect(tileHealth([])).toEqual({ ok: 0, failed: 0, total: 0 });
  });
});

// docs/30 Analytics 5: the dashboard says which filters it is drawn under, and
// a tile whose data cannot take one says so rather than pretending.
const l = (key: string, vars?: Record<string, string>) => (vars ? `${key}(${Object.values(vars).join(",")})` : key);

describe("filterSummary", () => {
  it("says nothing for a dashboard without filters", () => {
    expect(filterSummary(undefined, l)).toEqual([]);
    expect(filterSummary({}, l)).toEqual([]);
  });

  it("reads a rolling window, fixed dates and each dimension filter as phrases", () => {
    expect(filterSummary({ lastDays: 30 }, l)).toEqual(["range.last(30)"]);
    expect(filterSummary({ from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 30, 23) }, l)).toEqual(["from 2026-09-01", "to 2026-09-30"]);
    expect(
      filterSummary(
        {
          where: [
            { field: "status", op: "in", value: ["active", "lapsed"] },
            { field: "channelId", op: "not_null" }
          ]
        },
        l
      )
    ).toEqual(["status op.in active, lapsed", "channelId op.not_null"]);
  });
});

describe("unfilteredNote", () => {
  it("names the dashboard filters a tile's data could not take, or nothing", () => {
    expect(unfilteredNote({ key: "a" }, l)).toBeNull();
    expect(unfilteredNote({ key: "a", unfiltered: [] }, l)).toBeNull();
    expect(unfilteredNote({ key: "a", unfiltered: ["providerId", "status"] }, l)).toBe("unfiltered(providerId, status)");
  });
});

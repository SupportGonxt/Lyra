import { describe, expect, it } from "vitest";
import { coverageOf, coverageReach, coverageTerms, encodeCoverage, type Coverage } from "./coverage.js";

// `scout_panel_bench.coverage_gaps_json` is one column that carried two facts in
// four shapes (ADR-0127): the Bench Builder's object of counts, the seed's array
// of booleans, the seed's array of `*Minor`, and nothing at all. Every shape is
// already in a tenant's database, so the accessor has to read all of them — the
// alternative is a data migration that guesses at shapes nobody documented.
//
// Each test below is one shape as it is actually stored, quoted from the row.

describe("coverageOf", () => {
  it("reads the builder's object of counts as a reach fact", () => {
    expect(coverageOf(JSON.stringify({ unquotedRequests: 41, declined: 6 }))).toEqual({
      kind: "reach",
      unquotedRequests: 41,
      declined: 6
    });
  });

  it("reads an object carrying only one count, the other answering zero", () => {
    expect(coverageOf(JSON.stringify({ unquotedRequests: 3 }))).toEqual({
      kind: "reach",
      unquotedRequests: 3,
      declined: 0
    });
  });

  it("reads a seeded array of booleans as terms, present included", () => {
    expect(
      coverageOf(JSON.stringify([{ term: "agency_repair", ours: false, panelMedian: true, note: "the cheapest row is cheapest partly because of this" }]))
    ).toEqual({
      kind: "terms",
      terms: [
        {
          term: "agency_repair",
          ours: { present: false },
          panelMedian: { present: true },
          note: "the cheapest row is cheapest partly because of this"
        }
      ]
    });
  });

  it("reads a seeded array of `*Minor` as terms, in money", () => {
    expect(
      coverageOf(JSON.stringify([{ term: "excess", oursMinor: 50_000, panelMedianMinor: 100_000, note: "better cover at a higher index" }]))
    ).toEqual({
      kind: "terms",
      terms: [
        {
          term: "excess",
          ours: { present: true, minor: 50_000 },
          panelMedian: { present: true, minor: 100_000 },
          note: "better cover at a higher index"
        }
      ]
    });
  });

  it("passes an already-normalised coverage through unchanged, string or parsed", () => {
    // The web never sees the string: `hydrate()` (apps/api/src/crud.ts) parses
    // every `*Json` column before the generic CRUD response is serialised, so
    // the same accessor has to take the value it is handed.
    const normal: Coverage = {
      kind: "terms",
      terms: [{ term: "roadside", ours: { present: false }, panelMedian: { present: true } }]
    };
    expect(coverageOf(encodeCoverage(normal))).toEqual(normal);
    expect(coverageOf(normal)).toEqual(normal);
  });

  it("keeps a seeded figure the ADR's position has no money field for", () => {
    // Three more shapes the seed wrote, all in the same array the `*Minor` row
    // uses: `ours: 365` days, `oursSeconds: 118`, `ours: "annual_only"`. The
    // position carries `present`/`minor`, so a non-money figure goes in its
    // note rather than being dropped on the floor.
    expect(
      coverageOf(JSON.stringify([{ term: "maternity_waiting_days", ours: 365, panelMedian: null }]))
    ).toEqual({
      kind: "terms",
      terms: [{ term: "maternity_waiting_days", ours: { present: true, note: "365" }, panelMedian: { present: false } }]
    });
    expect(
      coverageOf(JSON.stringify([{ term: "quote_latency", oursSeconds: 118, panelMedianSeconds: 3 }]))
    ).toEqual({
      kind: "terms",
      terms: [
        {
          term: "quote_latency",
          ours: { present: true, note: "118 seconds" },
          panelMedian: { present: true, note: "3 seconds" }
        }
      ]
    });
    expect(
      coverageOf(JSON.stringify([{ term: "trip_basis", ours: "annual_only", panelMedian: "single_trip" }]))
    ).toEqual({
      kind: "terms",
      terms: [
        {
          term: "trip_basis",
          ours: { present: true, note: "annual_only" },
          panelMedian: { present: true, note: "single_trip" }
        }
      ]
    });
  });

  it("carries a wording diff's own fields (ADR-0123) through the accessor", () => {
    const diffed: Coverage = {
      kind: "terms",
      terms: [{ term: "flood", ours: { present: true }, panelMedian: { present: false }, changedAt: 1, direction: "added" }]
    };
    expect(coverageOf(encodeCoverage(diffed))).toEqual(diffed);
  });

  it("reads the empty term list the seed writes for a row with no gaps", () => {
    expect(coverageOf(JSON.stringify({ kind: "terms", terms: [] }))).toEqual({ kind: "terms", terms: [] });
    expect(coverageOf(encodeCoverage(coverageTerms([])))).toEqual({ kind: "terms", terms: [] });
  });

  it("is null for no column, unreadable JSON and a value in neither shape", () => {
    // Null is the third state — "nothing recorded here" — and it is not the
    // same claim as "no gaps", so it never collapses into an empty term list.
    expect(coverageOf(null)).toBeNull();
    expect(coverageOf(undefined)).toBeNull();
    expect(coverageOf("{not json")).toBeNull();
    expect(coverageOf(JSON.stringify("roadside"))).toBeNull();
    expect(coverageOf(JSON.stringify(["roadside"]))).toBeNull();
    expect(coverageOf(JSON.stringify({ somethingElse: 1 }))).toBeNull();
    expect(coverageOf(JSON.stringify([]))).toEqual({ kind: "terms", terms: [] });
  });

  it("drops a term entry with no term name rather than inventing one", () => {
    expect(coverageOf(JSON.stringify([{ ours: false }, { term: "roadside", ours: false }]))).toEqual({
      kind: "terms",
      terms: [{ term: "roadside", ours: { present: false }, panelMedian: { present: false } }]
    });
  });
});

describe("the producers' helpers", () => {
  it("builds the reach fact the Bench Builder stores", () => {
    const reach = coverageReach(41, 6);
    expect(reach).toEqual({ kind: "reach", unquotedRequests: 41, declined: 6 });
    // Never negative: a count is a fact about rows, not a signed delta.
    expect(coverageReach(-1, -2)).toEqual({ kind: "reach", unquotedRequests: 0, declined: 0 });
  });

  it("builds the term list the seed stores", () => {
    const terms = coverageTerms([{ term: "roadside", ours: { present: false }, panelMedian: { present: true } }]);
    expect(terms).toEqual({
      kind: "terms",
      terms: [{ term: "roadside", ours: { present: false }, panelMedian: { present: true } }]
    });
    expect(terms.terms).not.toBe(undefined);
  });

  it("round-trips through encodeCoverage and back", () => {
    const reach = coverageReach(4, 1);
    expect(coverageOf(encodeCoverage(reach))).toEqual(reach);
  });
});

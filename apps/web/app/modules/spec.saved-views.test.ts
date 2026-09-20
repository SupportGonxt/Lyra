import { describe, expect, it } from "vitest";
import { queryFromSavedView, recognizedQueryKeys, type ResourceSpec } from "./spec";

// docs/27 "saved views are written, listed, and never applied" — `GET
// /v1/analytics/saved-views` orders `isDefault` first and takes `?route=`
// filter, exactly what a list screen needs, and nothing read it. This is the
// narrowing point ui.md §7.0 names: forward only the query keys this tab still
// declares, since crud.ts's `filterSql` throws `unknown filter column` on
// anything else (apps/api/src/crud.ts), and a saved view can go stale exactly
// the way a seed row can.

const tab: ResourceSpec = {
  key: "quote-requests",
  api: "/v1/dist/quote-requests",
  read: "dist:quote_requests:read",
  columns: [],
  search: true,
  filters: [{ name: "state", options: ["open", "fanned_out", "complete"] }]
};

describe("recognizedQueryKeys", () => {
  it("holds the reserved keys plus every declared filter name", () => {
    expect(recognizedQueryKeys(tab)).toEqual(new Set(["q", "sort", "order", "state"]));
  });

  it("holds only the reserved keys when a tab declares no filters", () => {
    const { filters: _filters, ...bare } = tab;
    expect(recognizedQueryKeys(bare)).toEqual(new Set(["q", "sort", "order"]));
  });
});

describe("queryFromSavedView", () => {
  it("applies a declared filter — the seeded /distribution/quote-requests view", () => {
    // packages/core/src/seed/analytics.ts: queryJson {"state":"fanned_out"}
    expect(queryFromSavedView(tab, { state: "fanned_out" })).toEqual({ state: "fanned_out" });
  });

  it("carries q, sort and order through when the view saved them", () => {
    expect(queryFromSavedView(tab, { q: "acme", sort: "createdAt", order: "asc" })).toEqual({
      q: "acme",
      sort: "createdAt",
      order: "asc"
    });
  });

  it("drops a key the tab does not declare as a filter, rather than forwarding it", () => {
    // packages/core/src/seed/analytics.ts: the /orbit/renewals view carries
    // queryJson {"status":"raised","withinDays":30} — the tab's own filter is
    // named `state`, not `status`, and `withinDays` is not a column at all.
    // crud.ts would 400 on either; the honest behaviour is to drop them.
    expect(queryFromSavedView(tab, { status: "raised", withinDays: 30 })).toEqual({});
  });

  it("drops a real column that was never given a FilterSpec", () => {
    // packages/core/src/seed/analytics.ts: /analytics/exports's view carries
    // {"piiMasked": false} and that tab declares no filters at all.
    const { filters: _filters, ...exportsTab } = tab;
    expect(queryFromSavedView(exportsTab, { piiMasked: false })).toEqual({});
  });

  it("stringifies a non-string value for a key it does keep", () => {
    const withBool: ResourceSpec = {
      ...tab,
      filters: [{ name: "piiMasked", options: ["true", "false"] }]
    };
    expect(queryFromSavedView(withBool, { piiMasked: false })).toEqual({ piiMasked: "false" });
  });

  it("ignores null and undefined values rather than stringifying them", () => {
    expect(queryFromSavedView(tab, { state: null, q: undefined })).toEqual({});
  });
});

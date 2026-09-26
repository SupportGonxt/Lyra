import { describe, expect, it } from "vitest";
import { fieldLabels, reportOf, reportStatus, type ReportRow } from "./analytics-report";

// `GET /v1/analytics/reports/:id` is hand-written, so its `*Json` columns are
// never hydrated by crud.ts — but `reportView()` in apps/api/src/routes/analytics.ts
// parses the two localised ones itself and sends `name`/`description` beside
// them. The fixture is that shape.
const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: "rep_1",
  key: "gwp.by_line",
  module: "core",
  name: { en: "Written premium by line", ar: "القسط المكتتب حسب الفرع" },
  description: { en: "Bound quotes, bucketed." },
  definitionJson: JSON.stringify({ dataset: "quotes", metrics: ["gwp"], limit: 50 }),
  piiLevel: "none",
  scope: "tenant",
  updatedAt: 1_770_000_000_000,
  ...over
});

describe("reportOf", () => {
  it("takes the names the server already parsed and parses only the definition", () => {
    const report = reportOf(row());
    expect(report.name.ar).toBe("القسط المكتتب حسب الفرع");
    expect(report.description.en).toBe("Bound quotes, bucketed.");
    expect(report.definition.metrics).toEqual(["gwp"]);
  });

  it("still renders a report the server sent no description for", () => {
    // `reportView()` omits the key entirely when `descriptionJson` is null.
    const { description: _absent, ...sent } = row();
    expect(reportOf(sent).description).toEqual({});
  });

  it("reads an unusable definition as an empty one rather than throwing", () => {
    expect(reportOf(row({ definitionJson: "not json" })).definition).toEqual({});
  });
});

describe("reportStatus", () => {
  it("prefers a run in flight over everything else", () => {
    expect(reportStatus(true, true, true, "failed")).toBe("running");
  });

  it("shows a just-triggered result once it lands", () => {
    expect(reportStatus(false, true, false, "queued")).toBe("ranNow");
  });

  it("shows the queue when a run is pending but nothing fresh landed yet", () => {
    expect(reportStatus(false, false, true, null)).toBe("inProgress");
  });

  it("flags the last run's failure over stale history", () => {
    expect(reportStatus(false, false, false, "failed")).toBe("lastFailed");
  });

  it("falls back to stale when the last run just succeeded a while ago", () => {
    expect(reportStatus(false, false, false, "succeeded")).toBe("stale");
  });

  it("says never run when there is no history at all", () => {
    expect(reportStatus(false, false, false, null)).toBe("neverRun");
  });
});

describe("fieldLabels", () => {
  // docs/30 Analytics 4: the definition summary printed `gwp` and `line`.
  it("names measures and splits the way the dataset registry does", () => {
    const ds = {
      key: "quotes",
      module: "dist",
      timeColumn: "createdAt",
      dimensions: [{ key: "line", label: "Product line", kind: "text", pii: false }],
      metrics: [{ key: "gwp", label: "Written premium", kind: "money", agg: "sum" }]
    };
    expect(fieldLabels(ds)).toEqual({ line: "Product line", gwp: "Written premium" });
    expect(fieldLabels(undefined)).toEqual({});
  });
});

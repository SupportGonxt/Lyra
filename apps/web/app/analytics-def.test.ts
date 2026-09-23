import { describe, expect, it } from "vitest";
import {
  builderHref,
  decodeDef,
  defFromParams,
  encodeDef,
  fitToDataset,
  type DatasetInfo,
  type ReportDefinition
} from "./analytics-def";

// The builder's whole state is one definition in the URL (?def=), so a build is
// a link: shareable, bookmarkable, and the thing the ask bar and the AI
// operations dashboard hand over. These are the four ways that link is made and
// read.

const DEF: ReportDefinition = {
  dataset: "aiSpend",
  metrics: ["calls", "costMicro"],
  dimensions: ["purpose"],
  grain: "day",
  filters: [{ field: "module", op: "eq", value: "orbit" }],
  sort: { field: "costMicro", dir: "desc" },
  limit: 50
};

/** GET /v1/analytics/datasets, one row, in the server's shape. */
const AI_SPEND: DatasetInfo = {
  key: "aiSpend",
  module: "ai",
  timeColumn: "ts",
  dimensions: [
    { key: "module", label: "Module", kind: "text", pii: false },
    { key: "purpose", label: "Purpose", kind: "text", pii: false }
  ],
  metrics: [
    { key: "calls", label: "Calls", kind: "number", agg: "count" },
    { key: "costMicro", label: "Cost (micro)", kind: "number", agg: "sum" }
  ]
};

describe("encodeDef / decodeDef", () => {
  it("round-trips a definition through a URL-safe token", () => {
    const token = encodeDef(DEF);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeDef(token)).toEqual(DEF);
  });

  it("carries Arabic filter values intact", () => {
    const def: ReportDefinition = { ...DEF, filters: [{ field: "module", op: "eq", value: "مركبات" }] };
    expect(decodeDef(encodeDef(def))).toEqual(def);
  });

  it.each([
    ["nothing", null],
    ["garbage", "%%%"],
    ["not an object", encodeRaw("[1,2]")],
    ["no dataset", encodeRaw(JSON.stringify({ metrics: ["calls"] }))],
    ["no metric", encodeRaw(JSON.stringify({ dataset: "aiSpend", metrics: [] }))],
    ["an unknown grain", encodeRaw(JSON.stringify({ dataset: "aiSpend", metrics: ["calls"], grain: "hour" }))],
    [
      "an unknown filter op",
      encodeRaw(JSON.stringify({ dataset: "aiSpend", metrics: ["calls"], filters: [{ field: "module", op: "like" }] }))
    ]
  ])("reads %s as no definition, never a throw", (_why, token) => {
    expect(decodeDef(token)).toBeNull();
  });
});

describe("defFromParams", () => {
  it("builds the definition the builder form posts", () => {
    const params = new URLSearchParams([
      ["dataset", "aiSpend"],
      ["metric", "calls"],
      ["metric", "costMicro"],
      ["dimension", "purpose"],
      ["grain", "day"],
      ["from", "2026-06-01"],
      ["to", "2026-06-30"],
      ["f0.field", "module"],
      ["f0.op", "in"],
      ["f0.value", "axis, orbit"],
      ["f1.field", "purpose"],
      ["f1.op", "eq"],
      ["f1.value", "42"],
      ["f2.field", ""],
      ["sort", "costMicro"],
      ["dir", "asc"],
      ["limit", "25"]
    ]);
    expect(defFromParams(params)).toEqual({
      dataset: "aiSpend",
      metrics: ["calls", "costMicro"],
      dimensions: ["purpose"],
      grain: "day",
      from: Date.UTC(2026, 5, 1),
      to: Date.UTC(2026, 5, 30, 23, 59, 59, 999),
      filters: [
        { field: "module", op: "in", value: ["axis", "orbit"] },
        { field: "purpose", op: "eq", value: 42 }
      ],
      sort: { field: "costMicro", dir: "asc" },
      limit: 25
    });
  });

  it("drops a null test's value and a blank grain", () => {
    const params = new URLSearchParams([
      ["dataset", "aiSpend"],
      ["metric", "calls"],
      ["grain", "none"],
      ["f0.field", "module"],
      ["f0.op", "is_null"],
      ["f0.value", "ignored"]
    ]);
    expect(defFromParams(params)).toEqual({
      dataset: "aiSpend",
      metrics: ["calls"],
      filters: [{ field: "module", op: "is_null" }]
    });
  });

  it("is nothing without a dataset", () => {
    expect(defFromParams(new URLSearchParams([["metric", "calls"]]))).toBeNull();
  });
});

describe("fitToDataset", () => {
  it("keeps only what the chosen dataset offers — a dataset switch leaves no stale keys", () => {
    const stale: ReportDefinition = {
      dataset: "aiSpend",
      metrics: ["calls", "gwp"],
      dimensions: ["purpose", "status"],
      filters: [
        { field: "module", op: "eq", value: "axis" },
        { field: "status", op: "eq", value: "active" }
      ],
      sort: { field: "gwp", dir: "desc" }
    };
    expect(fitToDataset(stale, AI_SPEND)).toEqual({
      dataset: "aiSpend",
      metrics: ["calls"],
      dimensions: ["purpose"],
      filters: [{ field: "module", op: "eq", value: "axis" }]
    });
  });

  it("keeps a sort on the period only when there is a grain", () => {
    const def: ReportDefinition = { dataset: "aiSpend", metrics: ["calls"], sort: { field: "period", dir: "asc" } };
    expect(fitToDataset(def, AI_SPEND).sort).toBeUndefined();
    expect(fitToDataset({ ...def, grain: "month" }, AI_SPEND).sort).toEqual({ field: "period", dir: "asc" });
  });
});

describe("builderHref", () => {
  it("opens the builder on a definition, running it only when asked", () => {
    expect(builderHref(DEF)).toBe(`/analytics/builder?def=${encodeDef(DEF)}`);
    expect(builderHref(DEF, { run: true })).toBe(`/analytics/builder?def=${encodeDef(DEF)}&run=1`);
  });
});

function encodeRaw(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}

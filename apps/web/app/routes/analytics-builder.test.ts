import { describe, expect, it } from "vitest";
import { askProblem, chartFor, describeDef, reportKey, scheduleBody, type RunResult } from "./analytics-builder";

// POST /v1/analytics/run answers RunResult (apps/api/src/engines/report.ts) plus
// `runId` and `totals`; the fixtures are that shape, period column first when
// there is a grain, exactly as runReport orders it.
const result = (over: Partial<RunResult>): RunResult => ({
  runId: "run_1",
  title: "aiSpend report",
  columns: [],
  rows: [],
  currency: "AED",
  generatedAt: 0,
  rowCount: 0,
  truncated: false,
  ...over
});

describe("chartFor", () => {
  it("draws a line over the period when the run has a grain", () => {
    const run = result({
      columns: [
        { key: "period", label: "Period", kind: "text" },
        { key: "calls", label: "Calls", kind: "number" }
      ],
      rows: [
        { period: "2026-06-14", calls: 3 },
        { period: "2026-06-15", calls: 5 }
      ]
    });
    expect(chartFor(run)).toEqual({ kind: "line", metric: "calls", values: [3, 5], xLabels: ["2026-06-14", "2026-06-15"] });
  });

  it("draws shares when the run has exactly one dimension and no grain", () => {
    const run = result({
      columns: [
        { key: "purpose", label: "Purpose", kind: "text" },
        { key: "calls", label: "Calls", kind: "number" }
      ],
      rows: [
        { purpose: "triage", calls: 2 },
        { purpose: "draft", calls: 1 }
      ]
    });
    expect(chartFor(run)).toEqual({
      kind: "donut",
      metric: "calls",
      slices: [
        { name: "triage", value: 2 },
        { name: "draft", value: 1 }
      ]
    });
  });

  it("draws nothing for a grand total, two dimensions, or a period with a dimension beside it", () => {
    expect(chartFor(result({ columns: [{ key: "calls", label: "Calls", kind: "number" }], rows: [{ calls: 3 }] }))).toBeNull();
    const two = result({
      columns: [
        { key: "module", label: "Module", kind: "text" },
        { key: "purpose", label: "Purpose", kind: "text" },
        { key: "calls", label: "Calls", kind: "number" }
      ],
      rows: [{ module: "axis", purpose: "triage", calls: 1 }]
    });
    expect(chartFor(two)).toBeNull();
    const mixed = result({
      columns: [
        { key: "period", label: "Period", kind: "text" },
        { key: "module", label: "Module", kind: "text" },
        { key: "calls", label: "Calls", kind: "number" }
      ],
      rows: [{ period: "2026-06-14", module: "axis", calls: 1 }]
    });
    // Two series interleaved in one line would draw a zig-zag that means nothing.
    expect(chartFor(mixed)).toBeNull();
  });

  it("does not draw shares of a negative figure", () => {
    const run = result({
      columns: [
        { key: "state", label: "State", kind: "text" },
        { key: "net", label: "Net", kind: "money" }
      ],
      rows: [
        { state: "a", net: 5 },
        { state: "b", net: -2 }
      ]
    });
    expect(chartFor(run)).toBeNull();
  });
});

describe("reportKey", () => {
  it("is a slug the API's key pattern accepts, unique per save", () => {
    expect(reportKey("AI spend by purpose!", 1_770_000_000_000)).toMatch(/^ai-spend-by-purpose-[a-z0-9]+$/);
    expect(reportKey("AI spend by purpose!", 1_770_000_000_000)).not.toBe(reportKey("AI spend by purpose!", 1_770_000_000_001));
  });

  it("still makes a key from a name in a script the pattern cannot hold", () => {
    expect(reportKey("إنفاق الذكاء الاصطناعي", 1)).toMatch(/^report-[a-z0-9]+$/);
  });
});

describe("scheduleBody", () => {
  it("is nothing when the reader did not ask for a schedule", () => {
    expect(scheduleBody(form({ cadence: "" }), "rep_1", { en: "x" }, "en")).toBeNull();
  });

  it("names the report, the cron and each recipient", () => {
    expect(
      scheduleBody(form({ cadence: "weekly", format: "csv", recipients: "a@x.test, b@x.test" }), "rep_1", { en: "Spend" }, "en")
    ).toEqual({
      reportId: "rep_1",
      name: { en: "Spend" },
      cron: "0 6 * * 1",
      format: "csv",
      recipients: ["a@x.test", "b@x.test"],
      locale: "en"
    });
  });

  it("refuses a cadence it does not know rather than inventing a cron", () => {
    expect(scheduleBody(form({ cadence: "hourly", recipients: "a@x.test" }), "rep_1", { en: "x" }, "en")).toBeNull();
  });
});

describe("describeDef", () => {
  const l = (key: string) => ({ "dataset.aiSpend": "AI calls and spend", day: "Day", by: "by", since: "since" })[key] ?? key;
  const names = { metric: (k: string) => k.toUpperCase(), dimension: (k: string) => `<${k}>` };

  it("reads a compiled question back as one line a reader can check", () => {
    expect(
      describeDef(
        {
          dataset: "aiSpend",
          metrics: ["calls", "costMicro"],
          dimensions: ["purpose"],
          grain: "day",
          from: Date.UTC(2026, 4, 16),
          filters: [
            { field: "module", op: "eq", value: "orbit" },
            { field: "purpose", op: "in", value: ["a", "b"] },
            { field: "model", op: "is_null" }
          ],
          sort: { field: "costMicro", dir: "desc" },
          limit: 10
        },
        l,
        names
      )
    ).toEqual([
      "AI calls and spend",
      "CALLS, COSTMICRO",
      "by <purpose>",
      "Day",
      "since 2026-05-16",
      "<module> op.eq orbit",
      "<purpose> op.in a, b",
      "<model> op.is_null",
      "sort COSTMICRO, desc",
      "limit 10"
    ]);
  });
});

describe("askProblem", () => {
  it("reads the API's refusal as a refusal the screen words, with the reason code", () => {
    expect(askProblem({ title: "x", status: 422, code: "ask_refused", reason: "unknown_dataset" })).toBe("outside");
    expect(askProblem({ title: "x", status: 422, code: "ask_refused", reason: "refused" })).toBe("outside");
    expect(askProblem({ title: "x", status: 422, code: "ask_refused", reason: "bad_filter" })).toBe("unclear");
  });

  it("is not a refusal for any other problem — those stay problems", () => {
    expect(askProblem({ title: "x", status: 400, code: "bad_request" })).toBeNull();
    expect(askProblem({ title: "x", status: 403, code: "forbidden" })).toBeNull();
  });
});

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

import { describe, expect, it } from "vitest";
import {
  ASK_MAX_DAYS,
  analyticsAskMessages,
  analyticsAskSchema,
  catalogueLines,
  parseAnalyticsAsk,
  type AskCatalogueEntry
} from "./analytics-ask";

// The parser is the trust boundary between a model and the report builder.
// The eval (evals/analytics-ask) scores it over a golden set; these pin each
// rule on its own so a mutant that loosens one is caught by name.

const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;

const CATALOGUE: AskCatalogueEntry[] = [
  {
    key: "aiSpend",
    module: "ai",
    dimensions: [
      { key: "module", label: "Module", kind: "text" },
      { key: "purpose", label: "Purpose", kind: "text" }
    ],
    metrics: [
      { key: "calls", label: "Calls", kind: "number" },
      { key: "costMicro", label: "Cost (micro)", kind: "number" }
    ]
  },
  {
    key: "cases",
    dimensions: [{ key: "priority", label: "Priority", kind: "text" }],
    metrics: [{ key: "cases", label: "Cases", kind: "number" }]
  }
];

const ask = (reply: unknown) =>
  parseAnalyticsAsk(typeof reply === "string" ? reply : JSON.stringify(reply), CATALOGUE, NOW);

const base = { dataset: "aiSpend", metrics: ["calls"], why: "Calls from the audit log." };

describe("parseAnalyticsAsk", () => {
  it("returns the definition and the why for a reply that holds to the catalogue", () => {
    expect(ask({ ...base, dimensions: ["purpose"], grain: "day" })).toEqual({
      ok: true,
      definition: { dataset: "aiSpend", metrics: ["calls"], dimensions: ["purpose"], grain: "day" },
      why: "Calls from the audit log."
    });
  });

  it("reads a fenced reply", () => {
    expect(ask("```json\n" + JSON.stringify(base) + "\n```").ok).toBe(true);
  });

  it("drops a grain of none rather than carrying it", () => {
    const got = ask({ ...base, grain: "none" });
    expect(got.ok && got.definition.grain).toBe(undefined);
  });

  it("turns lastDays into a from instant and leaves to open", () => {
    const got = ask({ ...base, lastDays: 30 });
    expect(got.ok && got.definition).toEqual({ dataset: "aiSpend", metrics: ["calls"], from: NOW - 30 * DAY });
  });

  it.each([0, -1, 1.5, ASK_MAX_DAYS + 1, "30"])("refuses a window of %s days", (lastDays) => {
    expect(ask({ ...base, lastDays })).toEqual({ ok: false, reason: "bad_window" });
  });

  it("accepts the longest window it allows", () => {
    expect(ask({ ...base, lastDays: ASK_MAX_DAYS }).ok).toBe(true);
  });

  it("resolves an exact label to its key, case aside", () => {
    const got = ask({ ...base, metrics: ["cost (MICRO)"], dimensions: ["Purpose"] });
    expect(got.ok && got.definition).toEqual({ dataset: "aiSpend", metrics: ["costMicro"], dimensions: ["purpose"] });
  });

  it("collapses a repeated measure", () => {
    const got = ask({ ...base, metrics: ["calls", "Calls"] });
    expect(got.ok && got.definition.metrics).toEqual(["calls"]);
  });

  it.each([
    ["prose", "Sure, here is your report.", "unparseable"],
    ["an array", "[1]", "unparseable"],
    ["a refusal", { refusal: "Nothing holds salaries." }, "refused"],
    ["no why", { dataset: "aiSpend", metrics: ["calls"] }, "missing_why"],
    ["a blank why", { ...base, why: "   " }, "missing_why"],
    ["an unknown dataset", { ...base, dataset: "salaries" }, "unknown_dataset"],
    ["no measures", { ...base, metrics: [] }, "invalid"],
    ["measures not a list", { ...base, metrics: "calls" }, "unknown_metric"],
    ["an unknown measure", { ...base, metrics: ["profit"] }, "unknown_metric"],
    ["a measure from another dataset", { ...base, metrics: ["cases"] }, "unknown_metric"],
    ["thirteen measures", { ...base, metrics: Array(13).fill("calls") }, "unknown_metric"],
    ["an unknown dimension", { ...base, dimensions: ["region"] }, "unknown_dimension"],
    ["a dimension from another dataset", { ...base, dimensions: ["priority"] }, "unknown_dimension"],
    ["a grain the engine lacks", { ...base, grain: "hour" }, "invalid"],
    ["a limit past the ceiling", { ...base, limit: 50_001 }, "invalid"],
    ["filters not a list", { ...base, filters: { field: "module" } }, "bad_filter"],
    ["a filter on an unknown field", { ...base, filters: [{ field: "region", op: "eq", value: "x" }] }, "bad_filter"],
    ["a filter on a measure", { ...base, filters: [{ field: "calls", op: "gt", value: 1 }] }, "bad_filter"],
    ["an unknown op", { ...base, filters: [{ field: "module", op: "like", value: "x%" }] }, "bad_filter"],
    ["an eq with no value", { ...base, filters: [{ field: "module", op: "eq" }] }, "bad_filter"],
    ["an eq with an object", { ...base, filters: [{ field: "module", op: "eq", value: { a: 1 } }] }, "bad_filter"],
    ["an in with a scalar", { ...base, filters: [{ field: "module", op: "in", value: "axis" }] }, "bad_filter"],
    ["an empty in", { ...base, filters: [{ field: "module", op: "in", value: [] }] }, "bad_filter"],
    ["a non-finite value", { ...base, filters: [{ field: "module", op: "gt", value: null }] }, "bad_filter"],
    ["a filter that is not an object", { ...base, filters: ["module=axis"] }, "bad_filter"],
    ["a sort on an unknown field", { ...base, sort: { field: "region", dir: "asc" } }, "bad_sort"],
    ["a sort with no direction", { ...base, sort: { field: "calls" } }, "bad_sort"],
    ["a sort on the period with no grain", { ...base, sort: { field: "period", dir: "asc" } }, "bad_sort"],
    ["a sort that is not an object", { ...base, sort: "calls" }, "bad_sort"]
  ])("refuses %s", (_why, reply, reason) => {
    expect(ask(reply)).toEqual({ ok: false, reason });
  });

  it("keeps each kind of filter the engine runs", () => {
    const got = ask({
      ...base,
      filters: [
        { field: "module", op: "in", value: ["axis", "orbit"] },
        { field: "Purpose", op: "not_null", value: "ignored" },
        { field: "module", op: "neq", value: 3 }
      ]
    });
    expect(got.ok && got.definition.filters).toEqual([
      { field: "module", op: "in", value: ["axis", "orbit"] },
      { field: "purpose", op: "not_null" },
      { field: "module", op: "neq", value: 3 }
    ]);
  });

  it("sorts on a measure, a dimension, or the period when there is a grain", () => {
    const measure = ask({ ...base, sort: { field: "calls", dir: "desc" } });
    expect(measure.ok && measure.definition.sort).toEqual({ field: "calls", dir: "desc" });
    const dimension = ask({ ...base, sort: { field: "Module", dir: "asc" } });
    expect(dimension.ok && dimension.definition.sort).toEqual({ field: "module", dir: "asc" });
    const period = ask({ ...base, grain: "month", sort: { field: "period", dir: "asc" } });
    expect(period.ok && period.definition.sort).toEqual({ field: "period", dir: "asc" });
  });

  it("caps an over-long why instead of passing it through", () => {
    const got = ask({ ...base, why: "x".repeat(1_000) });
    expect(got.ok && got.why.length).toBe(400);
  });
});

describe("analyticsAskMessages", () => {
  const messages = analyticsAskMessages("AI spend by module", CATALOGUE, { locale: "ar", today: "2026-06-15" });

  it("puts the catalogue and the rules in the system turn and the question alone in the user turn", () => {
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(messages[1]!.content).toBe("AI spend by module");
    expect(messages[0]!.content).toContain("dataset aiSpend");
    expect(messages[0]!.content).toContain("costMicro (Cost (micro))");
    expect(messages[0]!.content).toContain("Today is 2026-06-15.");
  });

  it("asks for the why in the reader's language", () => {
    expect(messages[0]!.content).toContain("in Arabic");
    expect(analyticsAskMessages("q", CATALOGUE, { locale: "en", today: "x" })[0]!.content).toContain("in English");
  });

  it("names the refusal shape so an unanswerable question has somewhere to go", () => {
    expect(messages[0]!.content).toContain('{"refusal"');
  });
});

describe("catalogueLines", () => {
  it("says so when a dataset has nothing to split by", () => {
    expect(catalogueLines([{ key: "x", dimensions: [], metrics: [{ key: "n", label: "N", kind: "number" }] }])).toEqual([
      "dataset x\n  metrics: n (N)\n  dimensions: none"
    ]);
  });
});

describe("analyticsAskSchema", () => {
  it("offers exactly the engine's grains and a place for the why and the refusal", () => {
    const schema = analyticsAskSchema().schema as { properties: Record<string, { enum?: string[] }> };
    expect(schema.properties.grain!.enum).toEqual(["none", "day", "week", "month", "quarter", "year"]);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["why", "refusal", "lastDays"]));
  });
});

import { describe, expect, it } from "vitest";
import { RULE_ROWS, ruleFromForm, ruleRows } from "./audience-rule";

// docs/30 SIGNAL gap 3. An audience was a JSON object typed by hand; the builder
// offers only what outreach can resolve (ADR-0091) and posts the same JSON.

const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

describe("ruleRows", () => {
  it("reads a rule the builder can show into rows, padded to a fixed count", () => {
    const view = ruleRows({ any: [{ field: "tagsJson", op: "contains", value: "vip" }, { field: "prospect.reason", op: "eq", value: "no_policy" }] });
    expect(view?.join).toBe("any");
    expect(view?.rows.slice(0, 2)).toEqual([
      { what: "tag", value: "vip" },
      { what: "reason", value: "no_policy" }
    ]);
    expect(view?.rows).toHaveLength(RULE_ROWS);
  });

  it("reads a stored string, and an empty value as a blank rule", () => {
    expect(ruleRows(JSON.stringify({ all: [{ field: "prospect.score", op: "gte", value: 70 }] }))?.rows[0]).toEqual({ what: "score", value: "70" });
    expect(ruleRows(undefined)?.join).toBe("all");
  });

  it("gives up on anything it cannot show, so the JSON view keeps it intact", () => {
    expect(ruleRows({ all: [{ field: "policy.status", op: "eq", value: "active" }] })).toBeNull();
    expect(ruleRows({ all: [{ all: [] }] })).toBeNull();
    expect(ruleRows("not json")).toBeNull();
  });
});

describe("ruleFromForm", () => {
  it("builds the rule from the filled rows, skipping blank ones", () => {
    expect(
      ruleFromForm(form({ "definitionJson.join": "all", "definitionJson.0.what": "reason", "definitionJson.0.value": "quote_expired", "definitionJson.1.what": "", "definitionJson.2.what": "score", "definitionJson.2.value": " 60 " }), "definitionJson")
    ).toEqual({ all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }, { field: "prospect.score", op: "gte", value: 60 }] });
  });

  it("round-trips what ruleRows read", () => {
    const rule = { any: [{ field: "tagsJson", op: "contains", value: "vip" }] };
    const view = ruleRows(rule)!;
    const f = form({ "definitionJson.join": view.join });
    view.rows.forEach((r, i) => {
      f.set(`definitionJson.${i}.what`, r.what);
      f.set(`definitionJson.${i}.value`, r.value);
    });
    expect(ruleFromForm(f, "definitionJson")).toEqual(rule);
  });

  it("is null when nothing was filled in", () => {
    expect(ruleFromForm(form({ "definitionJson.join": "all" }), "definitionJson")).toBeNull();
  });
});

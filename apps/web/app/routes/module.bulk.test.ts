import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { axis } from "../modules/axis";
import { action } from "./module";

// AXIS-001 and AXIS-007: the API took a CSV of cases and a bulk action over a
// selection, and no screen offered either. Both answer per row, so the action
// carries the whole outcome back rather than a bare "done".

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: typeof init.body === "string" ? init.body : null });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
  });
  return calls;
}

function args(form: FormData): any {
  return {
    request: new Request("https://web.test/axis/cases", { method: "POST", body: form }),
    params: { module: "axis", resource: "cases" },
    context: { get: () => ({ env, ctx: {} }) }
  };
}

describe("the cases list declares both doors", () => {
  it("declares bulk actions and an import on the cases tab", () => {
    const cases = axis.tabs.find((tab) => tab.key === "cases");
    expect(cases?.bulk?.api).toBe("/v1/axis/cases/bulk");
    expect(cases?.bulk?.actions.map((a) => a.value)).toEqual(["assign", "reprioritise", "tag", "close"]);
    expect(cases?.import?.api).toBe("/v1/axis/cases/import");
  });
});

describe("bulk", () => {
  it("sends the selected ids and the chosen action's one parameter", async () => {
    const calls = stub({ applied: 2, failed: 1, outcomes: [{ caseId: "cas_3", ok: false, error: "closed" }] });
    const form = new FormData();
    form.set("intent", "bulk");
    form.set("bulkAction", "reprioritise");
    form.append("ids", "cas_1");
    form.append("ids", "cas_2");
    form.append("ids", "cas_3");
    form.set("priority", "urgent");
    form.set("tag", "ignored: not this action's field");

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/cases/bulk");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      action: "reprioritise",
      caseIds: ["cas_1", "cas_2", "cas_3"],
      priority: "urgent"
    });
    expect(result).toMatchObject({ problem: null, bulk: { applied: 2, failed: 1 } });
  });

  it("refuses an empty selection before asking the API", async () => {
    const calls = stub({});
    const form = new FormData();
    form.set("intent", "bulk");
    form.set("bulkAction", "close");
    const result = await action(args(form));
    expect(calls).toHaveLength(0);
    expect(result.problem?.status).toBe(400);
  });
});

describe("import", () => {
  it("posts the file's text and carries every refused line back", async () => {
    const calls = stub({ created: 1, skippedDuplicate: 0, errors: [{ line: 3, ref: "C-2", error: "unknown kind" }] }, 201);
    const form = new FormData();
    form.set("intent", "import");
    form.set("file", new File(["ref,kind,customerRef\nC-1,quote,cus_1\nC-2,nope,cus_1\n"], "cases.csv", { type: "text/csv" }));

    const result = await action(args(form));

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/cases/import");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ csv: "ref,kind,customerRef\nC-1,quote,cus_1\nC-2,nope,cus_1\n" });
    expect(result).toMatchObject({ problem: null, imported: { created: 1, errors: [{ line: 3 }] } });
  });
});

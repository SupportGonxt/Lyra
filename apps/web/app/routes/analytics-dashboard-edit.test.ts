import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { action, loader, reportChoices } from "./analytics-dashboard-edit";

// docs/30 Analytics 5: the tile editor saves through generic CRUD's PATCH, the
// door `analytics:dashboards:write` already guards. The real api.server runs
// against a stubbed fetch, so these assert the request the API receives — not
// a mock's idea of it (sighting 8).

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
afterEach(() => vi.unstubAllGlobals());

const tile = { key: "Premium", viz: "number", span: 6, definition: { dataset: "policies", metrics: ["gwp"] } };

function actionArgs(fields: Record<string, string>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return {
    request: new Request("https://web.test/analytics/dashboard/dsh_1/edit", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: { id: "dsh_1" }
  } as unknown as ActionFunctionArgs;
}

function loaderArgs() {
  return {
    request: new Request("https://web.test/analytics/dashboard/dsh_1/edit"),
    context: { get: () => ({ env, ctx: null }) },
    params: { id: "dsh_1" }
  } as unknown as LoaderFunctionArgs;
}

type Reply = { status?: number; body: unknown };

function stub(route: (url: string, method: string) => Reply) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url: String(input), method, body: init.body ? JSON.parse(String(init.body)) : null });
    const reply = route(String(input), method);
    const status = reply.status ?? 200;
    const type = status >= 400 ? "application/problem+json" : "application/json";
    return Promise.resolve(new Response(JSON.stringify(reply.body), { status, headers: { "content-type": type } }));
  });
  return calls;
}

describe("saving a layout", () => {
  it("patches the dashboard's layout with its tiles and filters, then returns to the dashboard", async () => {
    const calls = stub(() => ({ body: { id: "dsh_1" } }));
    const thrown = await action(
      actionArgs({ tiles: JSON.stringify([tile]), range: "30", "f0.field": "status", "f0.op": "eq", "f0.value": "active" })
    ).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("location")).toBe("/analytics/dashboard/dsh_1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/v1/analytics/dashboards/dsh_1");
    expect(calls[0]!.body).toEqual({
      layoutJson: { tiles: [tile], filters: { lastDays: 30, where: [{ field: "status", op: "eq", value: "active" }] } }
    });
  });

  it("sends no filters key when none are set", async () => {
    const calls = stub(() => ({ body: {} }));
    await action(actionArgs({ tiles: JSON.stringify([tile]), range: "" })).catch(() => null);
    expect(calls[0]!.body).toEqual({ layoutJson: { tiles: [tile] } });
  });

  it("refuses an unreadable tile list without calling the API", async () => {
    const calls = stub(() => ({ body: {} }));
    expect(await action(actionArgs({ tiles: "{nope" }))).toEqual({ problem: null, error: "unreadable" });
    expect(await action(actionArgs({}))).toEqual({ problem: null, error: "unreadable" });
    expect(calls).toEqual([]);
  });

  it("keeps the API's refusal, field map and all, instead of crashing", async () => {
    stub(() => ({
      status: 400,
      body: { title: "Bad request", status: 400, detail: "dashboard layout is not valid", errors: { "layoutJson.tiles.0.span": "too big" } }
    }));
    const result = await action(actionArgs({ tiles: JSON.stringify([tile]) }));
    expect(result.error).toBeNull();
    expect(result.problem?.status).toBe(400);
    expect(result.problem?.errors).toEqual({ "layoutJson.tiles.0.span": "too big" });
  });
});

describe("opening the editor", () => {
  const me = (permissions: string[]) => ({ body: { permissions, locale: "en", actor: { id: "u_1" } } });

  it("is a refusal, not a crash, for a reader who cannot write dashboards", async () => {
    const calls = stub((url) => (url.endsWith("/v1/me") ? me(["analytics:dashboards:read"]) : { body: {} }));
    const loaded = await loader(loaderArgs());
    expect(loaded.denied).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://api.test/v1/me"]);
  });

  it("treats a dashboard missing from the reader's list as not theirs", async () => {
    stub((url) => (url.endsWith("/v1/me") ? me(["analytics:dashboards:read", "analytics:dashboards:write"]) : { body: { data: [] } }));
    const loaded = await loader(loaderArgs());
    expect(loaded.denied).toBe(false);
    expect(loaded.name).toBeNull();
  });

  it("loads the stored layout, the datasets and the saved reports", async () => {
    stub((url) => {
      if (url.endsWith("/v1/me")) return me(["analytics:dashboards:read", "analytics:dashboards:write", "analytics:reports:read"]);
      if (url.endsWith("/v1/analytics/dashboards"))
        return { body: { data: [{ id: "dsh_1", key: "board", nameJson: '{"en":"Board"}', layoutJson: JSON.stringify({ tiles: [tile], filters: { lastDays: 7 } }) }] } };
      if (url.includes("/datasets")) return { body: { data: [{ key: "policies", module: "axis", timeColumn: "start_at", dimensions: [], metrics: [] }] } };
      return { body: { data: [{ id: "rpt_1", key: "gwp", name: { en: "Premium" }, definitionJson: '{"dataset":"policies","metrics":["gwp"]}' }] } };
    });
    const loaded = await loader(loaderArgs());
    expect(loaded.name).toBe("Board");
    expect(loaded.malformed).toBe(false);
    expect(loaded.layout).toEqual({ tiles: [tile], filters: { lastDays: 7 } });
    expect(loaded.datasets.map((d) => d.key)).toEqual(["policies"]);
    expect(loaded.reports).toEqual([{ id: "rpt_1", name: "Premium", dataset: "policies" }]);
  });

  it("opens a malformed stored layout empty and says so, rather than guessing", async () => {
    stub((url) => {
      if (url.endsWith("/v1/me")) return me(["analytics:dashboards:read", "analytics:dashboards:write"]);
      if (url.endsWith("/v1/analytics/dashboards")) return { body: { data: [{ id: "dsh_1", key: "board", nameJson: {}, layoutJson: "{nope" }] } };
      return { body: { data: [] } };
    });
    const loaded = await loader(loaderArgs());
    expect(loaded.name).toBe("board");
    expect(loaded.malformed).toBe(true);
    expect(loaded.layout).toEqual({ tiles: [] });
    expect(loaded.reports).toEqual([]);
  });
});

describe("reportChoices", () => {
  it("names a report in the reader's language and reads its dataset from the definition", () => {
    const rows = [
      { id: "r1", key: "a", name: { en: "Premium", ar: "الأقساط" }, definitionJson: '{"dataset":"policies"}' },
      { id: "r2", key: "b", name: {}, definitionJson: "not json" }
    ];
    expect(reportChoices(rows, "ar")).toEqual([
      { id: "r1", name: "الأقساط", dataset: "policies" },
      { id: "r2", name: "b", dataset: null }
    ]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { actionUrl, visibleActions, type ActionSpec, type ResourceSpec } from "../modules/spec";
import { runAction } from "../record.server";

// The record-level action seam: a state change the API owns (`/pause`,
// `/clawback`) that a generic PATCH must not impersonate. Nothing here touches
// a real module spec — the seam is declared by module owners, so it is tested
// against a fixture instead.

const pause: ActionSpec = {
  intent: "pause",
  method: "POST",
  path: "/{id}/pause",
  labelKey: "schedules.pause",
  permission: "analytics:write"
};

const reject: ActionSpec = {
  intent: "reject",
  method: "POST",
  path: "/{id}/reject",
  labelKey: "schedules.reject",
  permission: "analytics:approve",
  confirm: true,
  fields: [{ name: "reason", type: "textarea", required: true }]
};

const tab: ResourceSpec = {
  key: "schedules",
  api: "/v1/analytics/schedules",
  read: "analytics:read",
  columns: [{ name: "name", type: "text" }],
  actions: [pause, reject]
};

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One captured call, and whatever the API is pretending to answer with. */
function stubFetch(reply: Response) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null
    });
    return Promise.resolve(reply.clone());
  });
  return calls;
}

describe("visibleActions", () => {
  it("offers only the actions the actor holds the permission for", () => {
    expect(visibleActions(tab, ["analytics:read", "analytics:write"])).toEqual([pause]);
  });

  it("offers nothing to an actor holding neither", () => {
    expect(visibleActions(tab, ["analytics:read"])).toEqual([]);
  });

  it("is empty for a resource that declares no actions", () => {
    const { actions: _omitted, ...bare } = tab;
    expect(visibleActions(bare, ["analytics:write"])).toEqual([]);
  });
});

describe("actionUrl", () => {
  it("interpolates {id} into the resource's own API base", () => {
    expect(actionUrl(tab, pause, "sch_01H")).toBe("/v1/analytics/schedules/sch_01H/pause");
  });

  it("escapes an id rather than letting it reshape the path", () => {
    expect(actionUrl(tab, pause, "a/b")).toBe("/v1/analytics/schedules/a%2Fb/pause");
  });
});

describe("runAction", () => {
  it("posts to the interpolated URL and reports the intent as done", async () => {
    const calls = stubFetch(new Response(null, { status: 204 }));
    const result = await runAction(tab, pause, "sch_01H", new FormData(), { env });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.test/v1/analytics/schedules/sch_01H/pause");
    expect(calls[0]?.method).toBe("POST");
    expect(result).toEqual({ problem: null, done: "pause" });
  });

  it("sends the action's own fields, and only those", async () => {
    const form = new FormData();
    form.set("reason", "duplicate");
    form.set("name", "should not travel");
    const calls = stubFetch(new Response(null, { status: 204 }));

    await runAction(tab, reject, "sch_01H", form, { env });

    expect(calls[0]?.body).toBe(JSON.stringify({ reason: "duplicate" }));
  });

  describe("an action that makes a new record of the same resource", () => {
    // ADR-0113: "Expand as lookalike" answers with a new audience. The screen
    // follows it — the size and consent basis the reader needs to see are that
    // record's own columns.
    const expand: ActionSpec = {
      intent: "lookalike",
      method: "POST",
      path: "/{id}/lookalike",
      labelKey: "audiences.lookalike",
      permission: "signal:audiences:create",
      opensCreated: true,
      fields: [{ name: "size", type: "number", required: true }]
    };
    const created = () =>
      new Response(JSON.stringify({ id: "aud_new", size: 40, basis: ["marketing", "profiling"] }), {
        status: 201,
        headers: { "content-type": "application/json" }
      });

    it("reports the id the API answered with", async () => {
      const form = new FormData();
      form.set("size", "40");
      const calls = stubFetch(created());
      const result = await runAction(tab, expand, "aud_seed", form, { env });
      expect(calls[0]?.body).toBe(JSON.stringify({ size: 40 }));
      expect(result).toEqual({ problem: null, done: "lookalike", opened: "aud_new" });
    });

    it("opens nothing for an action that does not declare it, whatever the API answers", async () => {
      stubFetch(created());
      expect(await runAction(tab, pause, "sch_01H", new FormData(), { env })).toEqual({ problem: null, done: "pause" });
    });

    it("opens nothing when the answer carries no id", async () => {
      stubFetch(new Response(null, { status: 204 }));
      expect(await runAction(tab, expand, "aud_seed", new FormData(), { env })).toEqual({ problem: null, done: "lookalike" });
    });
  });

  it("surfaces a rejection as a Problem rather than throwing", async () => {
    stubFetch(
      new Response(JSON.stringify({ title: "forbidden", status: 403, detail: "not yours" }), {
        status: 403,
        headers: { "content-type": "application/json" }
      })
    );

    const result = await runAction(tab, pause, "sch_01H", new FormData(), { env });

    expect(result.done).toBeNull();
    expect(result.problem?.status).toBe(403);
    expect(result.problem?.detail).toBe("not yours");
  });
});

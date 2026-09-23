import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  LABELS,
  action,
  covers,
  grantsOf,
  keptGrants,
  labelsIn,
  matrixOf,
  rolesLede,
  type RoleRow
} from "./admin-roles";

// A roles editor is the escalation surface of the whole product: the API's PATCH
// on /v1/core/roles has no grant check of its own, so these tests are the proof
// that the only permissions this screen can write are ones the session already
// holds, and that saving never strips a grant the actor could not see.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/**
 * Replies keyed by the tail of the URL, because the action makes three hops
 * (session, re-read, write) and asserting the write means knowing which is which.
 */
function stubFetch(replies: Array<[string, Response]>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
    const match = replies.find(([suffix]) => url.endsWith(suffix));
    return Promise.resolve(match ? match[1].clone() : new Response(null, { status: 204 }));
  });
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function session(permissions: string[]): [string, Response] {
  return ["/v1/me", json({ actor: {}, permissions, roles: [], nav: [] })];
}

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/admin/roles", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

const role = (over: Partial<RoleRow> = {}): RoleRow => ({
  id: "rol_1",
  key: "axis.reviewer",
  name: "Reviewer",
  permissionsJson: ["axis:cases:read"],
  system: false,
  createdAt: 1_770_000_000_000,
  ...over
});

function form(fields: Record<string, string>, permissions: string[] = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const permission of permissions) data.append("permissions", permission);
  return data;
}

describe("labelsIn", () => {
  it("keeps ar on exactly the keys en has", () => {
    expect(Object.keys(LABELS.ar ?? {}).sort()).toEqual(Object.keys(LABELS.en ?? {}).sort());
  });

  it("translates every key rather than echoing english", () => {
    for (const [key, value] of Object.entries(LABELS.ar ?? {})) {
      expect(value.trim(), key).not.toBe("");
      expect(value, key).not.toBe(LABELS.en?.[key]);
    }
  });

  it("falls back to the key itself, never to a blank control", () => {
    expect(labelsIn("ar")("title")).toBe(LABELS.ar?.title);
    expect(labelsIn("de")("title")).toBe(LABELS.en?.title);
    expect(labelsIn("en")("nope")).toBe("nope");
  });

  it("interpolates the policy name the approval notice quotes", () => {
    expect(labelsIn("en")("approvalBody", { policy: "role.change" })).toContain("role.change");
  });
});

describe("rolesLede", () => {
  const l = labelsIn("en");

  it("reads empty when the organisation has no roles", () => {
    expect(rolesLede([], l)).toBe(LABELS.en?.introEmpty);
  });

  it("counts roles and only the custom ones", () => {
    const roles = [{ system: true }, { system: false }, { system: false }];
    expect(rolesLede(roles, l)).toBe("3 roles, 2 of them custom.");
  });
});

describe("covers", () => {
  it("reads a wildcard segment as any value in that position", () => {
    expect(covers("axis:*:*", "axis:cases:read")).toBe(true);
    expect(covers("*:*:*", "core:roles:update")).toBe(true);
    expect(covers("axis:cases:read", "axis:cases:read")).toBe(true);
  });

  it("does not let a wildcard cross into another module", () => {
    expect(covers("axis:*:*", "orbit:cases:read")).toBe(false);
    expect(covers("axis:cases:read", "axis:cases:update")).toBe(false);
  });

  it("refuses a malformed grant instead of matching loosely", () => {
    expect(covers("axis:cases", "axis:cases:read")).toBe(false);
  });
});

describe("grantsOf", () => {
  it("takes the hydrated array the resource returns", () => {
    expect(grantsOf({ permissionsJson: ["a:b:c"] })).toEqual(["a:b:c"]);
  });

  it("parses raw text, and treats malformed text as no grants rather than throwing", () => {
    expect(grantsOf({ permissionsJson: '["a:b:c"]' })).toEqual(["a:b:c"]);
    expect(grantsOf({ permissionsJson: "not json" })).toEqual([]);
    expect(grantsOf({ permissionsJson: '{"a":1}' })).toEqual([]);
  });
});

describe("matrixOf", () => {
  it("groups by module, resources down and actions across", () => {
    const blocks = matrixOf(["orbit:threads:read", "axis:cases:read", "axis:cases:update", "axis:tasks:read"]);

    expect(blocks.map((b) => b.module)).toEqual(["axis", "orbit"]);
    expect(blocks[0]?.actions).toEqual(["read", "update"]);
    expect(blocks[0]?.rows.map((r) => r.resource)).toEqual(["cases", "tasks"]);
    expect(blocks[0]?.rows[1]?.cells.map((c) => c.action)).toEqual(["read"]);
  });

  it("drops a malformed permission rather than rendering a headerless column", () => {
    expect(matrixOf(["broken", "axis:cases:read"]).map((b) => b.module)).toEqual(["axis"]);
  });
});

describe("keptGrants", () => {
  it("preserves grants outside the actor's own ceiling", () => {
    expect(keptGrants(["ledger:journal:post", "axis:cases:read"], new Set(["axis:cases:read"]))).toEqual([
      "ledger:journal:post"
    ]);
  });
});

describe("save", () => {
  it("writes the picked grants plus the ones the actor could not see", async () => {
    const calls = stubFetch([
      session(["core:roles:update", "axis:cases:read", "axis:cases:update"]),
      ["/v1/core/roles/rol_1", json(role({ permissionsJson: ["axis:cases:read", "ledger:journal:post"] }))]
    ]);

    const result = await action(
      args(form({ intent: "save", roleId: "rol_1", name: "Reviewer", idempotencyKey: "k1" }, ["axis:cases:update"]))
    );

    const write = calls.find((call) => call.method === "PATCH");
    expect(write?.url).toBe("https://api.test/v1/core/roles/rol_1");
    expect(write?.body).toBe(
      JSON.stringify({ name: "Reviewer", permissionsJson: ["axis:cases:update", "ledger:journal:post"] })
    );
    expect(result.done).toBe("saved");
  });

  it("refuses a permission the session does not hold, before any write", async () => {
    const calls = stubFetch([session(["core:roles:update"])]);

    const result = await action(args(form({ intent: "save", roleId: "rol_1", name: "Reviewer" }, ["*:*:*"])));

    expect(result.error).toBe("notYours");
    expect(calls.filter((call) => call.method !== "GET")).toHaveLength(0);
  });

  it("will not write a role the platform provisioned", async () => {
    const calls = stubFetch([
      session(["core:roles:update"]),
      ["/v1/core/roles/rol_1", json(role({ system: true }))]
    ]);

    const result = await action(args(form({ intent: "save", roleId: "rol_1", name: "Renamed" })));

    expect(result.error).toBe("systemLocked");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
  });

  it("needs a name and a role", async () => {
    stubFetch([session(["core:roles:update"])]);

    expect((await action(args(form({ intent: "save", roleId: "rol_1", name: "  " })))).error).toBe("nameRequired");
    expect((await action(args(form({ intent: "save", name: "Reviewer" })))).error).toBe("roleRequired");
  });

  it("surfaces a refusal as a Problem rather than throwing", async () => {
    stubFetch([
      session(["core:roles:update"]),
      ["/v1/core/roles/rol_1", json({ title: "forbidden", status: 403, code: "approval_required" }, 403)]
    ]);

    const result = await action(args(form({ intent: "save", roleId: "rol_1", name: "Reviewer" })));

    expect(result.problem?.status).toBe(403);
    expect(result.done).toBeNull();
  });
});

describe("create", () => {
  it("creates a tenant role, never a system one", async () => {
    const calls = stubFetch([session(["core:roles:create", "axis:cases:read"])]);

    const result = await action(
      args(form({ intent: "create", key: "axis.reviewer", name: "Reviewer" }, ["axis:cases:read"]))
    );

    const write = calls.find((call) => call.method === "POST");
    expect(write?.url).toBe("https://api.test/v1/core/roles");
    expect(write?.body).toBe(
      JSON.stringify({ key: "axis.reviewer", name: "Reviewer", permissionsJson: ["axis:cases:read"], system: false })
    );
    expect(result.done).toBe("created");
  });

  it("refuses a key that would not be usable in user_roles or in code", async () => {
    stubFetch([session([])]);

    expect((await action(args(form({ intent: "create", key: "Axis Reviewer", name: "R" })))).error).toBe("keyRequired");
    expect((await action(args(form({ intent: "create", key: "", name: "R" })))).error).toBe("keyRequired");
  });
});

describe("unknown intent", () => {
  it("answers 400 without reading the session", async () => {
    const calls = stubFetch([session([])]);

    const result = await action(args(form({ intent: "delete-everything" })));

    expect(result.problem?.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

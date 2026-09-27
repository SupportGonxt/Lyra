import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { PERM } from "./signal.shared";
import { RESOURCES, TOPICS, action, curlFor, eventsOf, subscribesToSignal } from "./signal-dev";
import type { HookRow } from "./admin-developer";

// The integrator's bench. What is worth asserting is the refusals — this screen
// hands a resource name straight into a URL and a row count straight into a
// query string, so a name it does not know or a count outside the API's range
// must never reach the network — and the honesty of the two catalogues: the
// resource list must match what the API actually registers, and a topic marked
// emitted must actually be raised somewhere.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...replies: Response[]) {
  const calls: Array<{ url: string; method: string; key: string | null }> = [];
  let at = 0;
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({ url: String(input), method: init.method ?? "GET", key: headers.get("idempotency-key") });
    const reply = replies[Math.min(at, replies.length - 1)] ?? new Response(null, { status: 204 });
    at += 1;
    return Promise.resolve(reply.clone());
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/signal/dev", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};

const hook = (over: Partial<HookRow> = {}): HookRow => ({
  id: "hk_1",
  url: "https://partner.test/hooks/signal",
  eventTypesJson: ["signal.budget.moved"],
  status: "active",
  createdAt: 1_770_000_000_000,
  ...over
});

/* ------------------------------------------------------------- catalogues */

describe("catalogues", () => {
  it("lists every SIGNAL resource the API registers, each behind its own read scope", () => {
    // apps/api/src/resources.ts — if SIGNAL grows a ninth list, the console
    // stops offering it and this test is where that is noticed.
    expect(RESOURCES.map((one) => one.path)).toEqual([
      "audiences",
      "campaigns",
      "creatives",
      "signal-experiments",
      "budget-moves",
      "aeo-pages",
      "attribution-events",
      "spend"
    ]);
    expect(RESOURCES.map((one) => one.permission)).toContain(PERM.attributionRead);
    expect(new Set(RESOURCES.map((one) => one.permission)).size).toBe(RESOURCES.length);
  });

  it("marks a topic emitted exactly when some API source raises it", () => {
    // A hand-kept list here once agreed with the screen and with nothing else.
    // The API's own sources decide: a topic is emitted iff an emit names it.
    const root = join(import.meta.dirname, "..", "..", "..", "api", "src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []
      );
    const source = walk(root).map((f) => readFileSync(f, "utf8")).join("\n");
    const raised = (name: string) => new RegExp(`type:[^\\n]*"${name.replaceAll(".", "\\.")}"`).test(source);
    expect(TOPICS.map((t) => [t.name, t.emitted])).toEqual(TOPICS.map((t) => [t.name, raised(t.name)]));
    expect(TOPICS.every((topic) => topic.name.startsWith("signal."))).toBe(true);
  });
});

/* ---------------------------------------------------------------- reading */

describe("webhook reading", () => {
  it("reads the subscription list whether the column came back parsed or as text", () => {
    expect(eventsOf(hook())).toEqual(["signal.budget.moved"]);
    expect(eventsOf(hook({ eventTypesJson: '["signal.autopilot.paused"]' }))).toEqual(["signal.autopilot.paused"]);
    expect(eventsOf(hook({ eventTypesJson: "not json" }))).toEqual([]);
    // A bag instead of a list, or numbers among the names, is not a crash.
    expect(eventsOf(hook({ eventTypesJson: '{"a":1}' }))).toEqual([]);
    expect(eventsOf(hook({ eventTypesJson: ["signal.budget.moved", 7] as unknown as string[] }))).toEqual([
      "signal.budget.moved"
    ]);
  });

  it("keeps only endpoints this module sends to", () => {
    expect(subscribesToSignal(hook())).toBe(true);
    expect(subscribesToSignal(hook({ eventTypesJson: ["axis.claim.opened"] }))).toBe(false);
    expect(subscribesToSignal(hook({ eventTypesJson: [] }))).toBe(false);
    // A prefix match, not a substring one: this is not a SIGNAL endpoint.
    expect(subscribesToSignal(hook({ eventTypesJson: ["orbit.signal.echo"] }))).toBe(false);
  });
});

describe("curl", () => {
  it("writes the console's own request, origin and limit included", () => {
    const written = curlFor("https://api.test", "spend", 25);
    expect(written).toContain('curl "https://api.test/v1/signal/spend?limit=25"');
    expect(written).toContain("authorization: Bearer $LYRA_API_KEY");
  });
});

/* ----------------------------------------------------------------- action */

describe("read console", () => {
  it("refuses a resource the API does not register, before any call", async () => {
    const calls = stubFetch();
    const result = await action(args(form({ intent: "read", resource: "core_users", limit: "10" })));
    expect(result.problem?.code).toBe("resource_required");
    expect(calls).toHaveLength(0);
  });

  it("refuses a row count outside what the list endpoints accept", async () => {
    const calls = stubFetch();
    for (const limit of ["0", "101", "", "ten"]) {
      const result = await action(args(form({ intent: "read", resource: "spend", limit })));
      expect(result.problem?.code).toBe("limit_required");
    }
    expect(calls).toHaveLength(0);
  });

  it("reads the list and hands back the rows unchanged", async () => {
    const calls = stubFetch(json({ data: [{ id: "sp_1", amountMinor: 1_200 }] }));
    const result = await action(args(form({ intent: "read", resource: "spend", limit: "10" })));
    expect(calls[0]?.url).toBe("https://api.test/v1/signal/spend?limit=10");
    expect(calls[0]?.method).toBe("GET");
    expect(result.problem).toBeNull();
    expect(result.resource).toBe("spend");
    expect(result.rows).toEqual([{ id: "sp_1", amountMinor: 1_200 }]);
  });

  it("shows the API's own refusal rather than a screen-invented one", async () => {
    stubFetch(json({ title: "Forbidden", status: 403, code: "forbidden" }, 403));
    const result = await action(args(form({ intent: "read", resource: "attribution-events", limit: "5" })));
    expect(result.problem?.code).toBe("forbidden");
    expect(result.rows).toBeUndefined();
  });
});

describe("webhook test", () => {
  it("refuses without an endpoint, before any call", async () => {
    const calls = stubFetch();
    const result = await action(args(form({ intent: "ping" })));
    expect(result.problem?.code).toBe("hook_required");
    expect(calls).toHaveLength(0);
  });

  it("delivers to the real endpoint and reports what came back", async () => {
    const calls = stubFetch(json({ ok: false, status: 502, error: "bad gateway" }));
    const result = await action(args(form({ intent: "ping", hookId: "hk_1", key: "idem_1" })));
    expect(calls[0]?.url).toBe("https://api.test/v1/core/webhooks/hk_1/test");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.key).toBe("idem_1");
    // A failed delivery is a result, not an error — the tester exists to see it.
    expect(result.problem).toBeNull();
    expect(result.ping).toEqual({ ok: false, status: 502, error: "bad gateway" });
  });
});

describe("sandbox tick", () => {
  it("runs the demo spend route and counts what it wrote", async () => {
    const calls = stubFetch(json({ inserted: 42 }));
    const result = await action(args(form({ intent: "tick", key: "idem_2" })));
    expect(calls[0]?.url).toBe("https://api.test/v1/signal/demo/spend-tick");
    expect(calls[0]?.key).toBe("idem_2");
    expect(result.inserted).toBe(42);
  });

  it("passes the API's production 404 straight through", async () => {
    // demoOnly() — the route is simply absent in production, and the screen
    // says so rather than pretending the tick ran.
    stubFetch(json({ title: "Not found", status: 404, code: "not_found" }, 404));
    const result = await action(args(form({ intent: "tick" })));
    expect(result.problem?.code).toBe("not_found");
    expect(result.inserted).toBeUndefined();
  });
});

describe("intents", () => {
  it("refuses anything else, before any call", async () => {
    const calls = stubFetch();
    expect((await action(args(form({ intent: "delete" })))).problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });
});

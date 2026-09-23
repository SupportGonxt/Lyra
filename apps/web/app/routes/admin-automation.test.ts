import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { action, allowlistChange } from "./admin-automation";

// The auto-approve allowlist is the escape hatch out of the approval gate
// (CLAUDE.md §4). Until this screen its only writer was the seed; the API took
// changes (PATCH /v1/core/settings/auto-approve) and nothing offered them.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://app.test/admin/automation", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

describe("allowlistChange", () => {
  const automatable = new Set(["axis.price_match", "axis.bind", "ledger.period_close"]);

  it("sends only what changed", () => {
    expect(allowlistChange(["axis.bind"], ["axis.bind", "axis.price_match"], automatable)).toEqual({
      add: ["axis.price_match"],
      remove: []
    });
    expect(allowlistChange(["axis.bind", "ledger.period_close"], ["ledger.period_close"], automatable)).toEqual({
      add: [],
      remove: ["axis.bind"]
    });
  });

  // A box the browser posts for a policy the floor forbids is never forwarded:
  // the API would refuse it, and the whole save with it.
  it("never adds a policy the floor forbids", () => {
    expect(allowlistChange([], ["ledger.payout"], automatable)).toEqual({ add: [], remove: [] });
  });
});

describe("action", () => {
  it("patches the allowlist with the difference", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
      calls.push({ url: String(input), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
      const body = (init.method ?? "GET") === "GET"
        ? { autoApprove: ["axis.bind"], policies: [{ key: "axis.bind", module: "axis", automatable: true }, { key: "axis.price_match", module: "axis", automatable: true }] }
        : { autoApprove: ["axis.price_match"] };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    });
    const form = new FormData();
    form.set("intent", "save");
    form.append("policy", "axis.price_match");

    const result = await action(args(form));

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("https://api.test/v1/core/settings/auto-approve");
    expect(JSON.parse(patch!.body!)).toEqual({ add: ["axis.price_match"], remove: ["axis.bind"] });
    expect(result).toEqual({ problem: null, saved: true });
  });

  it("reports a refusal beside the form instead of throwing", async () => {
    vi.stubGlobal("fetch", (_: unknown, init: RequestInit = {}) =>
      Promise.resolve(
        (init.method ?? "GET") === "GET"
          ? new Response(JSON.stringify({ autoApprove: [], policies: [{ key: "axis.bind", module: "axis", automatable: true }] }), { headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ type: "about:blank", title: "Forbidden", status: 403 }), { status: 403, headers: { "content-type": "application/problem+json" } })
      )
    );
    const form = new FormData();
    form.set("intent", "save");
    form.append("policy", "axis.bind");
    const result = await action(args(form));
    expect(result.saved).toBe(false);
    expect(result.problem?.status).toBe(403);
  });
});

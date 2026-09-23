import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { action } from "./record";

// A PATCH that went through returned `done: null`, so "Saved" rendered only
// for declared actions and an edit was indistinguishable from nothing.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saving an edit", () => {
  it("says it was saved", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(JSON.stringify({ id: "tm_1" }), { status: 200, headers: { "content-type": "application/json" } }))
    );
    const result = await action({
      request: new Request("https://web.test/orbit/teams/tm_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "update", key: "desk" })
      }),
      params: { module: "orbit", resource: "teams", id: "tm_1" },
      context: { get: () => ({ env, ctx: {} }) }
    } as never);
    expect(result).toMatchObject({ problem: null, done: "update" });
  });
});

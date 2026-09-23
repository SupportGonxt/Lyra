import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env";
import { action } from "./approvals";

// Approving a request never did it: the asker re-entered the whole form. The
// "Finish" press replays the kept request through the API, once.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("finishing an approved request", () => {
  it("posts to the finish endpoint and says it went through", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${String(input)}`);
      return Promise.resolve(new Response(JSON.stringify({ id: "cr_1" }), { status: 201, headers: { "content-type": "application/json" } }));
    });
    const result = await action({
      request: new Request("https://web.test/approvals", {
        method: "POST",
        body: new URLSearchParams({ intent: "finish", id: "apr_1" })
      }),
      params: {},
      context: { get: () => ({ env, ctx: {} }) }
    } as never);
    expect(calls).toContain("POST https://api.test/v1/me/approvals/apr_1/finish");
    expect(result).toMatchObject({ finished: "apr_1", problem: null });
  });
});

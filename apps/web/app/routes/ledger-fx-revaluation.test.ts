import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { fxHeadline, labelIn } from "./ledger.shared";
import { action } from "./ledger-fx-revaluation";

// docs/19 §5.3, docs/27 F18: the API computed a revaluation plan and could post
// it; no screen showed the plan or offered the post.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
const l = labelIn("en");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fxHeadline", () => {
  it("says there is nothing to revalue when every balance is at the closing rate", () => {
    expect(fxHeadline({ adjustments: [], netMinor: 0, baseCurrency: "AED" }, l, "en")).toBe(
      "Every foreign balance is already carried at the closing rate."
    );
  });

  it("states the net effect in the base currency", () => {
    const plan = { adjustments: [{}, {}], netMinor: -12_50, baseCurrency: "AED" };
    expect(fxHeadline(plan, l, "en")).toContain("2 balances");
    expect(fxHeadline(plan, l, "en")).toContain("12.50");
  });
});

describe("action", () => {
  it("posts the revaluation as of the chosen day", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: URL | string) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ txn: { id: "txn_1" }, plan: { netMinor: 100, baseCurrency: "AED", adjustments: [] } }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const form = new FormData();
    form.set("asOf", "2026-08-31");
    const result = await action({
      request: new Request("https://web.test/ledger/fx-revaluation", { method: "POST", body: form }),
      context: { get: () => ({ env, ctx: null }) },
      params: {}
    } as unknown as ActionFunctionArgs);
    expect(calls[0]).toBe(`https://api.test/v1/ledger/fx-revaluation?asOf=${Date.UTC(2026, 7, 31, 23, 59, 59, 999)}`);
    expect(result).toEqual({ problem: null, posted: "txn_1" });
  });
});

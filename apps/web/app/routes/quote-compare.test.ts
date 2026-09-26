import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { action, boundPolicy, labeller, requestExpired } from "./quote-compare";

describe("requestExpired", () => {
  it("is false when the request never expires", () => {
    expect(requestExpired(null, 1_000)).toBe(false);
  });

  it("is false before the expiry", () => {
    expect(requestExpired(2_000, 1_000)).toBe(false);
  });

  it("is true at and after the expiry", () => {
    expect(requestExpired(1_000, 1_000)).toBe(true);
    expect(requestExpired(1_000, 2_000)).toBe(true);
  });
});

describe("boundPolicy", () => {
  // docs/30 Distribution 5: after a reload the action result is gone, so the
  // comparison's own policyId is what keeps the bind panel from coming back.
  it("reads the policy the comparison says the chosen quote became", () => {
    expect(boundPolicy({ policyId: "pol_1" }, undefined)).toBe("pol_1");
  });
  it("prefers the bind that just happened, and is null for an unbound quote", () => {
    expect(boundPolicy({ policyId: null }, { policyId: "pol_2" })).toBe("pol_2");
    expect(boundPolicy({ policyId: null }, undefined)).toBeNull();
    expect(boundPolicy(null, undefined)).toBeNull();
  });
});

describe("labeller", () => {
  it("lets the tenant's pack rename the offer noun", () => {
    // Without the pack this screen titled a reorder "Renewal" on a retail
    // tenant — the route table answered before anyone asked the pack.
    expect(labeller("en", "retail-ecom")("kind.renewal")).toBe("Reorder");
    expect(labeller("ar", "retail-ecom")("kind.renewal")).toBe("إعادة طلب");
  });

  it("keeps the insurance wording when no pack renames it", () => {
    expect(labeller("en")("kind.renewal")).toBe("Renewal");
    expect(labeller("en", "insurance-retail")("kind.renewal")).toBe("Renewal");
  });

  it("still answers its own keys, which no pack has an opinion on", () => {
    expect(labeller("en")("title")).toBe("Quote comparison");
  });
});

// The sale (docs/27): a selected quote becomes a policy through
// POST /v1/axis/quote-responses/:id/bind. The comparison closed on a selection
// and then offered nothing — the quote the customer accepted could not be
// turned into the contract they hold from any screen.
describe("bind", () => {
  const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("issues the selected quote as a policy for the chosen term", async () => {
    const calls: Array<{ url: string; body: string | null; key: string | null }> = [];
    vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
      calls.push({
        url: String(input),
        body: typeof init.body === "string" ? init.body : null,
        key: new Headers(init.headers).get("idempotency-key")
      });
      return Promise.resolve(
        new Response(JSON.stringify({ policy: { id: "pol_1", policyNo: "GNX-1" } }), {
          status: 201,
          headers: { "content-type": "application/json" }
        })
      );
    });
    const form = new FormData();
    form.set("intent", "bind");
    form.set("responseId", "qr_9");
    form.set("idempotencyKey", "k");
    form.set("policyNo", "GNX-1");
    form.set("startAt", "2026-10-01");
    form.set("endAt", "2027-09-30");

    const result = await action({
      request: new Request("https://web.test/distribution/quote-requests/req_1/compare", { method: "POST", body: form }),
      context: { get: () => ({ env, ctx: null }) },
      params: { id: "req_1" }
    } as unknown as ActionFunctionArgs);

    expect(calls[0]?.url).toBe("https://api.test/v1/axis/quote-responses/qr_9/bind");
    expect(calls[0]?.key).toBe("k:qr_9:bind");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      policyNo: "GNX-1",
      startAt: Date.UTC(2026, 9, 1),
      endAt: Date.UTC(2027, 8, 30)
    });
    expect(result).toMatchObject({ problem: null, done: "done.bind", policyId: "pol_1" });
  });
});

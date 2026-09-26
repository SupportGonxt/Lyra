import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import { action, labelsIn, referralOf } from "./dist-referrals";

// docs/30 Distribution 4: the desk for referral routes that had no screen.
const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;
afterEach(() => vi.unstubAllGlobals());

const args = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return {
    request: new Request("https://web.test/distribution/referrals", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
};

function stub(status = 201, body: unknown = { txn: { id: "txn_1" } }) {
  const calls: Array<{ url: string; body: unknown; key: string | null }> = [];
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body ?? "null")), key: new Headers(init.headers).get("idempotency-key") });
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  });
  return calls;
}

describe("referral desk", () => {
  it("reads the referral out of the ledger key", () => {
    expect(referralOf({ idempotencyKey: "dist.referral.settle:REF-9:x" })).toBe("REF-9:x");
  });

  it("qualifies with an idempotency key per referral, and settles in whole minor units", async () => {
    const calls = stub();
    expect((await action(args({ intent: "qualify", key: "k", referralRef: "REF-1", channelId: "ch_1" }))).done).toEqual({ step: "qualify", ref: "REF-1" });
    expect(calls[0]).toMatchObject({ url: expect.stringContaining("/v1/dist/referrals/qualify"), body: { referralRef: "REF-1", channelId: "ch_1" }, key: "k:qualify:REF-1" });
    await action(args({ intent: "settle", key: "k", referralRef: "REF-1", currency: "aed", grossMinor: "5000" }));
    expect(calls[1]!.body).toEqual({ referralRef: "REF-1", currency: "AED", grossMinor: 5000 });
  });

  it("refuses a blank referral or a fee that is not a positive whole number, before calling anything", async () => {
    const calls = stub();
    expect((await action(args({ intent: "qualify", referralRef: " " }))).error).toBe("errRef");
    expect((await action(args({ intent: "settle", referralRef: "R", currency: "AED", grossMinor: "1.5" }))).error).toBe("errAmount");
    expect(calls).toEqual([]);
  });

  it("shows the API's refusal — settling a referral not yet qualified is a 409", async () => {
    stub(409, { title: "Conflict", status: 409, detail: "referral R has not been qualified" });
    expect((await action(args({ intent: "settle", referralRef: "R", currency: "AED", grossMinor: "10" }))).problem).toMatchObject({ status: 409 });
  });

  it("speaks both languages", () => {
    expect(labelsIn("ar")("qualify")).not.toBe("Qualify");
  });
});

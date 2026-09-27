import { describe, expect, it } from "vitest";
import { googleAdsPlatform, GOOGLE_ADS_API_VERSION } from "./signal-ad-google.js";

// docs/30 SIGNAL 5, ADR-0100. The Google Ads REST shapes, against an injected
// fetch: OAuth refresh -> access token, GAQL `googleAds:search` (paged, proto3
// JSON that omits zero-valued fields), and `campaignBudgets:mutate`.

const SECRETS = { developerToken: "dev-tok", clientId: "cid", clientSecret: "csec", refreshToken: "rtok" };
const CONFIG = { customerId: "123-456-7890", loginCustomerId: "9990001111" };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function fakeFetch(respond: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? init.body : ""
    };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const SEARCH = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/googleAds:search`;

describe("googleAdsPlatform.pullSpend", () => {
  it("exchanges the refresh token, pages through GAQL results and converts micros to minor units", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url === "https://oauth2.googleapis.com/token") return { json: { access_token: "at-1", expires_in: 3599 } };
      const body = JSON.parse(call.body) as { pageToken?: string };
      if (!body.pageToken) {
        return {
          json: {
            results: [
              {
                campaign: { resourceName: "customers/1234567890/campaigns/111", id: "111" },
                segments: { date: "2026-09-25" },
                metrics: { costMicros: "12345000", impressions: "1000", clicks: "40", conversions: 2.6 },
                customer: { currencyCode: "AED" }
              }
            ],
            nextPageToken: "p2"
          }
        };
      }
      // A day with no spend: proto3 JSON leaves every zero out.
      return { json: { results: [{ campaign: { id: "222" }, segments: { date: "2026-09-25" }, metrics: {}, customer: { currencyCode: "AED" } }] } };
    });

    const rows = await googleAdsPlatform(impl).pullSpend({ since: "2026-09-24", until: "2026-09-26" }, SECRETS, CONFIG);

    expect(rows).toEqual([
      { externalCampaignId: "111", day: "2026-09-25", amountMinor: 1235, currency: "AED", impressions: 1000, clicks: 40, conversions: 3 },
      { externalCampaignId: "222", day: "2026-09-25", amountMinor: 0, currency: "AED", impressions: 0, clicks: 0, conversions: 0 }
    ]);
    expect(calls[0]!.method).toBe("POST");
    expect(new URLSearchParams(calls[0]!.body).get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(calls[0]!.body).get("refresh_token")).toBe("rtok");
    expect(calls[1]!.url).toBe(SEARCH);
    expect(calls[1]!.headers.authorization).toBe("Bearer at-1");
    expect(calls[1]!.headers["developer-token"]).toBe("dev-tok");
    expect(calls[1]!.headers["login-customer-id"]).toBe("9990001111");
    const query = (JSON.parse(calls[1]!.body) as { query: string }).query;
    expect(query).toMatch(/FROM campaign/);
    expect(query).toMatch(/segments\.date BETWEEN '2026-09-24' AND '2026-09-26'/);
    expect(JSON.parse(calls[2]!.body)).toMatchObject({ pageToken: "p2" });
  });

  it("refuses a window that is not two dates before any network call — the query is built from it", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await expect(googleAdsPlatform(impl).pullSpend({ since: "2026-09-24' OR 1=1 --", until: "2026-09-26" }, SECRETS, CONFIG)).rejects.toThrow(/date/);
    expect(calls).toHaveLength(0);
  });

  it("names a missing credential or customer id without calling out", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await expect(googleAdsPlatform(impl).pullSpend({ since: "2026-09-24", until: "2026-09-26" }, { ...SECRETS, refreshToken: "" }, CONFIG)).rejects.toThrow(/refreshToken/);
    await expect(googleAdsPlatform(impl).pullSpend({ since: "2026-09-24", until: "2026-09-26" }, SECRETS, {})).rejects.toThrow(/customerId/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the provider's error message and status, never the token", async () => {
    const { impl } = fakeFetch((call) =>
      call.url.includes("oauth2")
        ? { json: { access_token: "at-secret" } }
        : { status: 403, json: { error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } } }
    );
    const err = await googleAdsPlatform(impl).pullSpend({ since: "2026-09-24", until: "2026-09-26" }, SECRETS, CONFIG).catch((e: Error) => e);
    expect(String(err)).toMatch(/403.*The caller does not have permission/);
    expect(String(err)).not.toMatch(/at-secret|rtok|csec/);
  });
});

describe("googleAdsPlatform.adjustDailyBudget", () => {
  it("reads the campaign's budget, then mutates amount_micros by the delta", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("oauth2")) return { json: { access_token: "at-1" } };
      if (call.url.endsWith("googleAds:search")) {
        return {
          json: {
            results: [
              {
                campaign: { id: "111" },
                campaignBudget: { resourceName: "customers/1234567890/campaignBudgets/555", amountMicros: "500000000" },
                customer: { currencyCode: "AED" }
              }
            ]
          }
        };
      }
      return { json: { results: [{ resourceName: "customers/1234567890/campaignBudgets/555" }] } };
    });

    const out = await googleAdsPlatform(impl).adjustDailyBudget("111", -10_000, "AED", SECRETS, CONFIG);

    expect(out).toEqual({ beforeMinor: 50_000, afterMinor: 40_000 });
    expect((JSON.parse(calls[1]!.body) as { query: string }).query).toMatch(/WHERE campaign\.id = 111/);
    expect(calls[2]!.url).toBe(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/1234567890/campaignBudgets:mutate`);
    expect(JSON.parse(calls[2]!.body)).toEqual({
      operations: [{ update: { resourceName: "customers/1234567890/campaignBudgets/555", amountMicros: "400000000" }, updateMask: "amount_micros" }]
    });
  });

  it("refuses a shared budget, a currency the account does not bill in, and a campaign it cannot find — without mutating", async () => {
    const answer = (result: unknown) =>
      fakeFetch((call) => (call.url.includes("oauth2") ? { json: { access_token: "a" } } : { json: { results: result ? [result] : [] } }));

    const shared = answer({ campaignBudget: { resourceName: "r", amountMicros: "1000000", explicitlyShared: true }, customer: { currencyCode: "AED" } });
    await expect(googleAdsPlatform(shared.impl).adjustDailyBudget("111", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/shared/);
    expect(shared.calls.some((c) => c.url.endsWith(":mutate"))).toBe(false);

    const usd = answer({ campaignBudget: { resourceName: "r", amountMicros: "1000000" }, customer: { currencyCode: "USD" } });
    await expect(googleAdsPlatform(usd.impl).adjustDailyBudget("111", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/USD/);

    const none = answer(null);
    await expect(googleAdsPlatform(none.impl).adjustDailyBudget("111", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/no campaign 111/);

    const bad = answer(null);
    await expect(googleAdsPlatform(bad.impl).adjustDailyBudget("111 OR 1=1", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/campaign id/);
    expect(bad.calls).toHaveLength(0);
  });

  it("refuses a decrease that would empty the budget", async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.url.includes("oauth2")
        ? { json: { access_token: "a" } }
        : { json: { results: [{ campaignBudget: { resourceName: "r", amountMicros: "100000000" }, customer: { currencyCode: "AED" } }] } }
    );
    await expect(googleAdsPlatform(impl).adjustDailyBudget("111", -10_000, "AED", SECRETS, CONFIG)).rejects.toThrow(/budget/);
    expect(calls.some((c) => c.url.endsWith(":mutate"))).toBe(false);
  });
});

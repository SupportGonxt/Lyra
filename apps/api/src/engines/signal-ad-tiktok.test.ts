import { describe, expect, it } from "vitest";
import { tiktokAdsPlatform, TIKTOK_API_VERSION } from "./signal-ad-tiktok.js";

// docs/modules/signal.md / docs/30 SIGNAL 5, ADR-0100. The TikTok Marketing API
// shapes against an injected fetch: the integrated report (decimal-string spend,
// conversion count), the Events API (hashed email/phone), and the campaign
// budget, which TikTok holds in the currency's major unit.

const SECRETS = { accessToken: "tt-secret" };
const CONFIG = { advertiserId: "7000000000000000000", currency: "AED" };
const API = `https://business-api.tiktok.com/open_api/${TIKTOK_API_VERSION}`;
const ADVERTISER = "7000000000000000000";

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

describe("tiktokAdsPlatform.pullSpend", () => {
  it("reads the integrated report and maps a day's spend, clicks and conversions", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("/report/integrated/get/")) {
        return {
          json: {
            code: 0,
            data: {
              list: [
                {
                  dimensions: { campaign_id: "1800000000000000000", stat_time_day: "2026-09-25 00:00:00" },
                  metrics: { spend: "123.45", impressions: "4000", clicks: "90", conversion: "7" }
                }
              ],
              page_info: { page: 1, total_page: 1 }
            }
          }
        };
      }
      return { json: { code: 0, data: {} } };
    });

    const platform = tiktokAdsPlatform(impl);
    const rows = await platform.pullSpend({ since: "2026-09-25", until: "2026-09-25" }, SECRETS, CONFIG);

    expect(calls[0]!.url).toContain(`${API}/report/integrated/get/`);
    expect(calls[0]!.url).toContain(`advertiser_id=${ADVERTISER}`);
    expect(calls[0]!.headers["access-token"]).toBe("tt-secret");
    expect(rows).toEqual([
      { externalCampaignId: "1800000000000000000", day: "2026-09-25", amountMinor: 12345, currency: "AED", impressions: 4000, clicks: 90, conversions: 7 }
    ]);
  });

  it("follows page_info.total_page and throws on a TikTok application error", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("page=1")) {
        return { json: { code: 0, data: { list: [], page_info: { total_page: 2 } } } };
      }
      if (call.url.includes("page=2")) {
        return { json: { code: 0, data: { list: [], page_info: { total_page: 2 } } } };
      }
      return { json: { code: 40105, message: "no permission" } };
    });
    const rows = await tiktokAdsPlatform(impl).pullSpend({ since: "2026-09-01", until: "2026-09-02" }, SECRETS, CONFIG);
    expect(rows).toEqual([]);
    expect(calls.filter((c) => c.url.includes("/report/integrated/get/"))).toHaveLength(2);

    const { impl: bad } = fakeFetch(() => ({ json: { code: 40105, message: "no permission" } }));
    await expect(tiktokAdsPlatform(bad).pullSpend({ since: "2026-09-01", until: "2026-09-02" }, SECRETS, CONFIG)).rejects.toThrow(
      /code 40105/
    );
  });
});

describe("tiktokAdsPlatform.adjustDailyBudget", () => {
  it("reads the campaign budget in major units and posts the delta back", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.includes("/advertiser/info/")) return { json: { code: 0, data: { list: [{ currency: "AED" }] } } };
      if (call.url.includes("/campaign/get/")) return { json: { code: 0, data: { list: [{ budget: 250 }] } } };
      return { json: { code: 0, data: {} } };
    });
    const out = await tiktokAdsPlatform(impl).adjustDailyBudget("1800000000000000000", -5000, "AED", SECRETS, CONFIG);
    expect(out).toEqual({ beforeMinor: 25000, afterMinor: 20000 });

    const update = calls.find((c) => c.url.includes("/campaign/update/"))!;
    expect(JSON.parse(update.body)).toEqual({ advertiser_id: ADVERTISER, campaign_id: "1800000000000000000", budget: 200 });
  });

  it("refuses a currency the account does not bill in", async () => {
    const { impl } = fakeFetch(() => ({ json: { code: 0, data: { list: [{ currency: "SAR" }] } } }));
    await expect(tiktokAdsPlatform(impl).adjustDailyBudget("1800000000000000000", -5000, "AED", SECRETS, CONFIG)).rejects.toThrow(/bills in SAR/);
  });
});

describe("tiktokAdsPlatform.uploadConversions", () => {
  it("posts hashed email/phone to the Events API and fails a conversion with no match key", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { code: 0, data: {} } }));
    const out = await tiktokAdsPlatform(impl).uploadConversions!(
      [
        { conversionId: "c1", at: 1_760_000_000_000, valueMinor: 12000, currency: "AED", emailSha256: ["abc"] },
        { conversionId: "c2", at: 1_760_000_000_000, valueMinor: 9000, currency: "AED" }
      ],
      SECRETS,
      { ...CONFIG, pixelId: "777777" }
    );
    expect(out).toEqual([
      { conversionId: "c1", status: "sent" },
      { conversionId: "c2", status: "failed", error: "no match key" }
    ]);
    const posted = JSON.parse(calls[0]!.body) as { event_source_id: string; data: { user: Record<string, unknown>; properties: { value: number } }[] };
    expect(posted.event_source_id).toBe("777777");
    expect(posted.data).toHaveLength(1);
    expect(posted.data[0]!.user).toEqual({ email: ["abc"] });
    expect(posted.data[0]!.properties.value).toBe(120);
  });
});

import { describe, expect, it } from "vitest";
import { metaAdsPlatform, META_GRAPH_VERSION } from "./signal-ad-meta.js";

// docs/30 SIGNAL 5, ADR-0100. The Meta Marketing API shapes, against an
// injected fetch: campaign-level daily insights (decimal-string spend, an
// `actions` list for conversions, cursor paging) and the campaign's own
// `daily_budget`, which Meta holds in the currency's minor unit.

const SECRETS = { accessToken: "EAAB-secret" };
const CONFIG = { adAccountId: "act_42" };
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

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
      body: typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ""
    };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("metaAdsPlatform.pullSpend", () => {
  it("reads daily campaign insights, follows the cursor, and counts the configured conversion action", async () => {
    const next = `${GRAPH}/act_42/insights?after=cursor2`;
    const { impl, calls } = fakeFetch((call) => {
      if (call.url === next) {
        return { json: { data: [{ campaign_id: "900", date_start: "2026-09-26", spend: "0", impressions: "0", clicks: "0", account_currency: "AED" }] } };
      }
      return {
        json: {
          data: [
            {
              campaign_id: "900",
              date_start: "2026-09-25",
              date_stop: "2026-09-25",
              spend: "123.455",
              impressions: "4000",
              clicks: "90",
              account_currency: "AED",
              actions: [
                { action_type: "link_click", value: "90" },
                { action_type: "lead", value: "4" }
              ]
            }
          ],
          paging: { cursors: { after: "cursor2" }, next }
        }
      };
    });

    const rows = await metaAdsPlatform(impl).pullSpend({ since: "2026-09-25", until: "2026-09-26" }, SECRETS, CONFIG);

    expect(rows).toEqual([
      { externalCampaignId: "900", day: "2026-09-25", amountMinor: 12346, currency: "AED", impressions: 4000, clicks: 90, conversions: 4 },
      { externalCampaignId: "900", day: "2026-09-26", amountMinor: 0, currency: "AED", impressions: 0, clicks: 0, conversions: 0 }
    ]);
    const first = new URL(calls[0]!.url);
    expect(`${first.origin}${first.pathname}`).toBe(`${GRAPH}/act_42/insights`);
    expect(first.searchParams.get("level")).toBe("campaign");
    expect(first.searchParams.get("time_increment")).toBe("1");
    expect(JSON.parse(first.searchParams.get("time_range")!)).toEqual({ since: "2026-09-25", until: "2026-09-26" });
    // The token travels in a header, never in a URL a log could keep.
    expect(calls[0]!.headers.authorization).toBe("Bearer EAAB-secret");
    expect(calls.every((c) => !c.url.includes("EAAB-secret"))).toBe(true);
    expect(calls[1]!.url).toBe(next);
  });

  it("counts a different conversion action when the connector names one, and accepts a bare account id", async () => {
    const { impl, calls } = fakeFetch(() => ({
      json: {
        data: [
          {
            campaign_id: "900",
            date_start: "2026-09-25",
            spend: "10",
            impressions: "1",
            clicks: "1",
            account_currency: "JPY",
            actions: [{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }, { action_type: "lead", value: "9" }]
          }
        ]
      }
    }));
    const rows = await metaAdsPlatform(impl).pullSpend(
      { since: "2026-09-25", until: "2026-09-25" },
      SECRETS,
      { adAccountId: "42", conversionAction: "offsite_conversion.fb_pixel_purchase" }
    );
    expect(rows[0]).toMatchObject({ amountMinor: 10, currency: "JPY", conversions: 2 });
    expect(calls[0]!.url.startsWith(`${GRAPH}/act_42/insights?`)).toBe(true);
  });

  it("refuses to follow a paging link off the Graph host — the bearer token would go with it", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { data: [], paging: { next: "https://evil.example/steal" } } }));
    await expect(metaAdsPlatform(impl).pullSpend({ since: "2026-09-25", until: "2026-09-25" }, SECRETS, CONFIG)).rejects.toThrow(/paging/);
    expect(calls).toHaveLength(1);
  });

  it("names a missing token or account, and a malformed window, without calling out", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await expect(metaAdsPlatform(impl).pullSpend({ since: "2026-09-25", until: "2026-09-25" }, {}, CONFIG)).rejects.toThrow(/accessToken/);
    await expect(metaAdsPlatform(impl).pullSpend({ since: "2026-09-25", until: "2026-09-25" }, SECRETS, {})).rejects.toThrow(/adAccountId/);
    await expect(metaAdsPlatform(impl).pullSpend({ since: "yesterday", until: "2026-09-25" }, SECRETS, CONFIG)).rejects.toThrow(/date/);
    expect(calls).toHaveLength(0);
  });

  it("surfaces the Graph error message and status", async () => {
    const { impl } = fakeFetch(() => ({ status: 400, json: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190 } } }));
    await expect(metaAdsPlatform(impl).pullSpend({ since: "2026-09-25", until: "2026-09-25" }, SECRETS, CONFIG)).rejects.toThrow(/400.*Invalid OAuth access token/);
  });
});

describe("metaAdsPlatform.adjustDailyBudget", () => {
  it("reads the account currency and the campaign's daily budget, then posts the new one", async () => {
    const { impl, calls } = fakeFetch((call) => {
      if (call.url.startsWith(`${GRAPH}/act_42?`)) return { json: { id: "act_42", currency: "AED" } };
      if (call.method === "GET") return { json: { id: "900", daily_budget: "50000" } };
      return { json: { success: true } };
    });

    const out = await metaAdsPlatform(impl).adjustDailyBudget("900", 10_000, "AED", SECRETS, CONFIG);

    expect(out).toEqual({ beforeMinor: 50_000, afterMinor: 60_000 });
    expect(new URL(calls[1]!.url).searchParams.get("fields")).toBe("daily_budget");
    expect(calls[2]!.method).toBe("POST");
    expect(calls[2]!.url).toBe(`${GRAPH}/900`);
    expect(new URLSearchParams(calls[2]!.body).get("daily_budget")).toBe("60000");
    expect(calls[2]!.headers.authorization).toBe("Bearer EAAB-secret");
  });

  it("refuses a campaign whose budget lives on its ad sets, a currency mismatch, and an unacknowledged write", async () => {
    const adsets = fakeFetch((call) => (call.url.includes("act_42") ? { json: { currency: "AED" } } : { json: { id: "900" } }));
    await expect(metaAdsPlatform(adsets.impl).adjustDailyBudget("900", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/ad set/);
    expect(adsets.calls.some((c) => c.method === "POST")).toBe(false);

    const usd = fakeFetch(() => ({ json: { currency: "USD", daily_budget: "100" } }));
    await expect(metaAdsPlatform(usd.impl).adjustDailyBudget("900", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/USD/);
    expect(usd.calls.some((c) => c.method === "POST")).toBe(false);

    const unack = fakeFetch((call) =>
      call.method === "POST" ? { json: { success: false } } : call.url.includes("act_42") ? { json: { currency: "AED" } } : { json: { daily_budget: "100" } }
    );
    await expect(metaAdsPlatform(unack.impl).adjustDailyBudget("900", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/did not confirm/);

    const bad = fakeFetch(() => ({ json: {} }));
    await expect(metaAdsPlatform(bad.impl).adjustDailyBudget("../me", 1, "AED", SECRETS, CONFIG)).rejects.toThrow(/campaign id/);
    expect(bad.calls).toHaveLength(0);
  });
});

// docs/17 SIG-032, ADR-0112. Conversions API: each bind as a server event on
// the tenant's pixel, deduplicated by event_id, matched on the fbclid Meta
// issued or — only when the exporter supplied them, which it does only under
// data-sharing consent — SHA-256 identifiers. Nothing else about the person.
describe("metaAdsPlatform.uploadConversions", () => {
  const AT = Date.parse("2026-09-26T10:15:30Z");
  const PIXEL = { ...CONFIG, pixelId: "555" };

  it("matches on fbclid and hashed identifiers, and posts one event per bind with its value", async () => {
    const meta = metaAdsPlatform();
    expect(meta.conversionKeys).toEqual(["fbclid", "emailSha256", "phoneSha256"]);
    expect(meta.conversionMaxAgeDays).toBe(7);

    const { impl, calls } = fakeFetch(() => ({ json: { events_received: 2, fbtrace_id: "x" } }));
    const results = await metaAdsPlatform(impl).uploadConversions!(
      [
        { conversionId: "att_1", at: AT, valueMinor: 12_550, currency: "AED", fbclid: "IwAR1" },
        { conversionId: "att_2", at: AT, valueMinor: 9_000, currency: "AED", emailSha256: ["e".repeat(64)], phoneSha256: ["p".repeat(64)] }
      ],
      SECRETS,
      PIXEL
    );
    expect(results).toEqual([
      { conversionId: "att_1", status: "sent" },
      { conversionId: "att_2", status: "sent" }
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${GRAPH}/555/events`);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.authorization).toBe("Bearer EAAB-secret");
    expect(calls[0]!.url).not.toContain("EAAB");
    expect(JSON.parse(calls[0]!.body)).toEqual({
      data: [
        {
          event_name: "Purchase",
          event_time: Math.floor(AT / 1000),
          event_id: "att_1",
          action_source: "system_generated",
          user_data: { fbc: `fb.1.${AT}.IwAR1` },
          custom_data: { value: 125.5, currency: "AED" }
        },
        {
          event_name: "Purchase",
          event_time: Math.floor(AT / 1000),
          event_id: "att_2",
          action_source: "system_generated",
          user_data: { em: ["e".repeat(64)], ph: ["p".repeat(64)] },
          custom_data: { value: 90, currency: "AED" }
        }
      ]
    });
  });

  it("never sends an event with nothing to match it on, and needs a pixel", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { events_received: 0 } }));
    expect(await metaAdsPlatform(impl).uploadConversions!([{ conversionId: "att_1", at: AT, valueMinor: 1, currency: "AED" }], SECRETS, PIXEL)).toEqual([
      { conversionId: "att_1", status: "failed", error: "no match key" }
    ]);
    expect(calls).toHaveLength(0);
    await expect(
      metaAdsPlatform(impl).uploadConversions!([{ conversionId: "att_1", at: AT, valueMinor: 1, currency: "AED", fbclid: "x" }], SECRETS, CONFIG)
    ).rejects.toThrow(/pixelId/);
  });

  it("treats a batch Meta did not fully acknowledge as failed, and a refused one as an error", async () => {
    const partial = fakeFetch(() => ({ json: { events_received: 0 } }));
    expect(
      await metaAdsPlatform(partial.impl).uploadConversions!([{ conversionId: "att_1", at: AT, valueMinor: 1, currency: "AED", fbclid: "x" }], SECRETS, PIXEL)
    ).toEqual([{ conversionId: "att_1", status: "failed", error: "meta-ads acknowledged 0 of 1 events" }]);

    const refused = fakeFetch(() => ({ status: 400, json: { error: { message: "Invalid parameter" } } }));
    await expect(
      metaAdsPlatform(refused.impl).uploadConversions!([{ conversionId: "att_1", at: AT, valueMinor: 1, currency: "AED", fbclid: "x" }], SECRETS, PIXEL)
    ).rejects.toThrow(/400: Invalid parameter/);
  });
});

import { describe, expect, it } from "vitest";
import { metaAdsPlatform, META_GRAPH_VERSION } from "./signal-ad-meta.js";
import { googleAdsPlatform } from "./signal-ad-google.js";
import type { AdCreativePush } from "@lyra/core";

// docs/modules/signal.md §2.1 / §4.2, §8 clause 1. The publish half of "brief ->
// 20 compliant variants -> publish to Meta+Google": the two documented request
// shapes, against an injected fetch. Like every other adapter test in this
// directory these verify the *contract we send*, not that the platform accepts
// it — the live check is a credential and a sandbox account.

const _GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

const CREATIVE: AdCreativePush = {
  creativeId: "scr_1",
  kind: "ad_copy",
  locale: "en",
  headline: "Cover your car in an afternoon",
  body: "Compare nine UAE insurers in one place.",
  callToAction: "learn_more",
  landingUrl: "https://nxt.example/quote",
  externalCampaignId: "900",
  disclosure: "Terms apply.",
  pool: {
    headlines: ["Cover your car in an afternoon", "Motor cover, nine insurers", "Same-day motor cover"],
    descriptions: ["Compare nine UAE insurers in one place.", "A price you can check."]
  }
};

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

describe("metaAdsPlatform.publishCreative", () => {
  it("creates a creative, then a PAUSED ad in the configured ad set", async () => {
    const { impl, calls } = fakeFetch((call) =>
      call.url.includes("/adcreatives") ? { json: { id: "cr_7" } } : { json: { id: "ad_9" } }
    );
    const platform = metaAdsPlatform(impl);
    const result = await platform.publishCreative!(
      CREATIVE,
      { accessToken: "tok" },
      { adAccountId: "act_42", pageId: "111", adsetId: "222" }
    );

    expect(result).toEqual({ status: "published", externalId: "ad_9" });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "POST /v23.0/act_42/adcreatives",
      "POST /v23.0/act_42/ads"
    ]);

    const creative = JSON.parse(calls[0]!.body) as { object_story_spec: { page_id: string; link_data: Record<string, unknown> } };
    expect(creative.object_story_spec.page_id).toBe("111");
    expect(creative.object_story_spec.link_data.link).toBe(CREATIVE.landingUrl);
    expect(creative.object_story_spec.link_data.name).toBe(CREATIVE.headline);
    // The disclosure rides in the copy, because Meta's own field cannot hold it.
    expect(String(creative.object_story_spec.link_data.message)).toContain("Terms apply.");

    // PAUSED is the design: publishing places the object, a human spends money.
    expect(JSON.parse(calls[1]!.body)).toMatchObject({ adset_id: "222", status: "PAUSED", creative: { creative_id: "cr_7" } });
  });

  it("refuses to guess where the ad goes", async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    // A Page but no ad set: the creative has somewhere to live and nowhere to
    // run, which is not a default this adapter is willing to invent.
    const result = await metaAdsPlatform(impl).publishCreative!(
      CREATIVE,
      { accessToken: "tok" },
      { adAccountId: "act_42", pageId: "111" }
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("adsetId");
    expect(calls).toHaveLength(0);
  });

  it("reports a platform refusal as an outcome, not a throw", async () => {
    const { impl } = fakeFetch(() => ({ status: 400, json: { error: { message: "Invalid parameter" } } }));
    const result = await metaAdsPlatform(impl).publishCreative!(
      CREATIVE,
      { accessToken: "tok" },
      { adAccountId: "act_42", pageId: "111", adsetId: "222" }
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Invalid parameter");
  });
});

describe("googleAdsPlatform.publishCreative", () => {
  const secrets = { developerToken: "dev", clientId: "cid", clientSecret: "cs", refreshToken: "rt" };

  function googleFetch() {
    return fakeFetch((call) =>
      call.url.includes("oauth2.googleapis.com")
        ? { json: { access_token: "at" } }
        : { json: { results: [{ resourceName: "customers/7/adGroupAds/42~9" }] } }
    );
  }

  it("builds a responsive search ad from the campaign's cleared pool, PAUSED", async () => {
    const { impl, calls } = googleFetch();
    const result = await googleAdsPlatform(impl).publishCreative!(CREATIVE, secrets, { customerId: "7-7-7", adGroupId: "42" });

    expect(result).toEqual({ status: "published", externalId: "customers/7/adGroupAds/42~9" });
    const mutate = calls.find((c) => c.url.includes("adGroupAds:mutate"))!;
    const op = (JSON.parse(mutate.body) as { operations: Array<{ create: Record<string, any> }> }).operations[0]!.create;
    expect(op.status).toBe("PAUSED");
    expect(op.adGroup).toBe("customers/777/adGroups/42");
    expect(op.ad.finalUrls).toEqual([CREATIVE.landingUrl]);
    // Google wants 3 headlines and 2 descriptions; the pool supplies them and
    // the deck's own copy leads.
    expect(op.ad.responsiveSearchAd.headlines).toHaveLength(3);
    expect(op.ad.responsiveSearchAd.headlines[0].text).toBe(CREATIVE.headline);
    expect(op.ad.responsiveSearchAd.descriptions).toHaveLength(2);
  });

  it("refuses rather than padding a thin pool with invented copy", async () => {
    const { impl, calls } = googleFetch();
    const thin = { ...CREATIVE, pool: { headlines: ["Only one other"], descriptions: [] } };
    const result = await googleAdsPlatform(impl).publishCreative!(thin, secrets, { customerId: "777", adGroupId: "42" });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("3 headlines and 2 descriptions");
    // It refused before spending an OAuth round trip on a request Google would reject.
    expect(calls).toHaveLength(0);
  });

  it("sends the developer token and the manager account when one is configured", async () => {
    const { impl, calls } = googleFetch();
    await googleAdsPlatform(impl).publishCreative!(CREATIVE, secrets, { customerId: "777", adGroupId: "42", loginCustomerId: "999" });
    const mutate = calls.find((c) => c.url.includes("adGroupAds:mutate"))!;
    expect(mutate.headers["developer-token"]).toBe("dev");
    expect(mutate.headers["login-customer-id"]).toBe("999");
  });
});

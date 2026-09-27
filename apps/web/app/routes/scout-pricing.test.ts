import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoaderFunctionArgs } from "react-router";
import type { Env } from "../env";
import { labelsIn, type LineElasticity } from "./scout.shared";
import { elasticityRange, elasticityReading, loader } from "./scout-pricing";

// docs/30 SCOUT 5: the pricing screen reads each line's fitted elasticity from
// GET /v1/scout/price-elasticity and says, in words, what it does and does not
// show. Fixtures are in the server's shape (packages/core/src/elasticity.ts).

const l = labelsIn("en");
const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

const fit = (over: Partial<LineElasticity> = {}): LineElasticity => ({
  line: "motor",
  state: "estimated",
  reason: null,
  observations: 7,
  volume: 9_775,
  elasticity: -2.1,
  low: -3.4,
  high: -0.8,
  rSquared: 0.81,
  clear: true,
  ...over
});

const gap = (reason: "too-few" | "no-spread", observations = 1): LineElasticity =>
  fit({ state: "insufficient", reason, observations, elasticity: null, low: null, high: null, rSquared: null, clear: false });

describe("elasticityReading", () => {
  it("says a clear negative slope as 'dearer loses'", () => {
    expect(elasticityReading(fit())).toEqual({ key: "price.el.dearerLoses", tone: "warning" });
  });

  it("says a clear positive slope as 'dearer still wins', without calling it good", () => {
    expect(elasticityReading(fit({ elasticity: 0.9, low: 0.2, high: 1.6 }))).toEqual({ key: "price.el.dearerWins", tone: "info" });
  });

  it("refuses a direction when the interval crosses zero", () => {
    expect(elasticityReading(fit({ low: -1, high: 0.4, clear: false }))).toEqual({ key: "price.el.unclear", tone: "neutral" });
  });

  it("names why nothing was fitted", () => {
    expect(elasticityReading(gap("too-few"))).toEqual({ key: "price.el.tooFew", tone: "neutral" });
    expect(elasticityReading(gap("no-spread", 6))).toEqual({ key: "price.el.noSpread", tone: "neutral" });
  });
});

describe("elasticityRange", () => {
  it("prints the slope and its interval to two places", () => {
    expect(elasticityRange(fit(), l, "en")).toBe(l("price.el.range", { e: "-2.10", low: "-3.40", high: "-0.80" }));
  });

  it("prints the minimum a fit needs when there were too few cells", () => {
    expect(elasticityRange(gap("too-few", 2), l, "en")).toBe(l("price.el.needs", { n: "2", min: "5" }));
  });

  it("prints nothing numeric when the prices did not spread", () => {
    expect(elasticityRange(gap("no-spread", 6), l, "en")).toBe(l("none"));
  });
});

describe("loader", () => {
  const args = {
    request: new Request("https://web.test/scout/pricing"),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as LoaderFunctionArgs;

  it("reads the fitted elasticity from the bench route", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", (input: URL | string) => {
      const url = String(input);
      urls.push(url);
      const body = url.includes("/price-elasticity") ? { data: [fit()] } : url.includes("/config") ? { kFloor: 20 } : { data: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
    });
    const loaded = await loader(args);
    expect(urls.some((url) => url.endsWith("/v1/scout/price-elasticity"))).toBe(true);
    expect(loaded.elasticity).toEqual([fit()]);
  });

  it("renders the rest of the screen when the elasticity read fails", async () => {
    vi.stubGlobal("fetch", (input: URL | string) =>
      Promise.resolve(
        String(input).includes("/price-elasticity")
          ? new Response(JSON.stringify({ status: 500 }), { status: 500, headers: { "content-type": "application/problem+json" } })
          : new Response(JSON.stringify({ data: [] }), { headers: { "content-type": "application/json" } })
      )
    );
    expect((await loader(args)).elasticity).toEqual([]);
  });
});

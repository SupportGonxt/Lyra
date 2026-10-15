import { describe, expect, it } from "vitest";
import { TAX_MARKETS } from "@lyra/db";
import { DEFAULT_TAX_MARKET } from "./tax.js";
import { taxMarketOf2 } from "./tax.js";
import type { Ctx } from "./context.js";

// NXT governs three markets (AE, SA, EG). The platform is being taken into a
// broker that operates in **nine MENA countries**, so the question this file
// answers stops being academic: which supplies were taxed under a market nobody
// chose?

const ctxWith = (policy: Record<string, unknown>) => ({ policy } as unknown as Ctx);

describe("taxMarketOf2", () => {
  it("reports a stated market as stated", () => {
    expect(taxMarketOf2(ctxWith({ taxMarket: "SA" }))).toEqual({ market: "SA", source: "stated" });
  });

  it("reports the fallback as a default rather than passing it off as the tenant's own", () => {
    // The whole point: `taxMarketOf` alone cannot tell these apart, and a broker
    // across nine countries has to be able to.
    expect(taxMarketOf2(ctxWith({}))).toEqual({ market: DEFAULT_TAX_MARKET, source: "default" });
    expect(taxMarketOf2(ctxWith({ taxMarket: "" }))).toEqual({ market: DEFAULT_TAX_MARKET, source: "default" });
    // A non-string is not a statement either — a number in the policy is a
    // configuration error, not a market.
    expect(taxMarketOf2(ctxWith({ taxMarket: 971 }))).toEqual({ market: DEFAULT_TAX_MARKET, source: "default" });
  });

  it("governs three markets, which is the number that matters for expansion", () => {
    // An inventory, not decoration: the gap between this list and the broker's
    // nine countries is the expansion work, and a test is where that number
    // stays honest.
    expect([...TAX_MARKETS].sort()).toEqual(["AE", "EG", "SA"]);
  });
});

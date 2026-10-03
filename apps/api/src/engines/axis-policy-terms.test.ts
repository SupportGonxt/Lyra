import { describe, expect, it } from "vitest";
import { POLICY_STATES } from "@lyra/core";
import { statusLabel, termRows } from "./axis-policy-terms.js";

const opts = (locale: "en" | "ar", pack = "insurance-retail") => ({ locale, pack, currency: "AED" });

describe("policy document words for codes", () => {
  it("has a word for every policy state in both languages", () => {
    for (const s of POLICY_STATES) {
      expect(statusLabel(s, "en"), s).not.toBe(s);
      expect(statusLabel(s, "ar"), s).toMatch(/[؀-ۿ]/);
    }
  });

  it("labels known keys, formats money, booleans and nested limits", () => {
    const json = JSON.stringify({ excessMinor: 50_000, limits: { thirdParty: 1_000_000 }, roadside: true, line: "motor" });
    expect(termRows(json, opts("en"))).toEqual([
      { k: "Excess", v: "AED 500.00" },
      { k: "Limits — Third party", v: "1,000,000" },
      { k: "Roadside assistance", v: "Yes" },
      { k: "Product line", v: "Motor" }
    ]);
    expect(termRows(json, opts("ar"))[3]).toEqual({ k: "خط المنتج", v: "المركبات" });
  });

  it("humanises an unknown key in English and numbers it in Arabic", () => {
    const json = JSON.stringify({ windscreenCapMinor: 100_00, garage_network: "gold" });
    expect(termRows(json, opts("en")).map((r) => r.k)).toEqual(["Windscreen cap", "Garage network"]);
    expect(termRows(json, opts("ar")).map((r) => r.k)).toEqual(["شرط إضافي ١", "شرط إضافي ٢"]);
    // The tenant's own value is data and prints as given.
    expect(termRows(json, opts("ar"))[1]!.v).toBe("gold");
  });

  it("reads the domain pack's noun for a key", () => {
    expect(termRows(JSON.stringify({ cover: "x" }), opts("en", "retail-ecom"))[0]!.k).toBe("Entitlement");
  });

  it("prints a usage-based reprice as its price movement, not its audit stamp", () => {
    const json = JSON.stringify({ ubi: { aiAuditId: "aud_1", premiumDeltaPpm: -32_000, factors: [] } });
    expect(termRows(json, opts("en"))).toEqual([{ k: "Usage-based price adjustment", v: "-3.2%" }]);
  });

  it("survives a terms row that is not JSON", () => {
    expect(termRows("{not json", opts("en"))).toEqual([]);
  });
});

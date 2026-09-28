import { describe, expect, it } from "vitest";
import {
  AD_TRANSPORT,
  adCampaignMap,
  adChannel,
  applyBudgetDelta,
  currencyExponent,
  decimalToMinor,
  dailyBudgetDelta,
  externalCampaignFor,
  microsToMinor,
  minorToMicros,
  minorToUnits,
  conversionValueRule,
  conversionValueMinor,
  hashEmail,
  hashPhone,
  clickId
} from "./ad-platform.js";
import { sha256Hex } from "./crypto.js";

// docs/30 SIGNAL 5. The money arithmetic every ad-platform adapter shares.
// Platforms report in their own units — Google in micros, Meta in decimal
// strings — and a rounding slip here is a CAC the autopilot trusts.

describe("currencyExponent", () => {
  it("reads the minor-unit digits of the currency, not an assumed two", () => {
    expect(currencyExponent("AED")).toBe(2);
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("usd")).toBe(2);
  });

  it("refuses something that is not a currency code", () => {
    expect(() => currencyExponent("dollars")).toThrow(/currency/);
    expect(() => currencyExponent("")).toThrow(/currency/);
  });
});

describe("decimalToMinor", () => {
  it("converts a decimal amount string exactly, without float drift", () => {
    expect(decimalToMinor("12.34", 2)).toBe(1234);
    expect(decimalToMinor("0.1", 2)).toBe(10);
    expect(decimalToMinor("1000", 2)).toBe(100000);
    expect(decimalToMinor("4.35", 2)).toBe(435); // 4.35 * 100 = 434.99999999999994 in floats
    expect(decimalToMinor("7", 0)).toBe(7);
    expect(decimalToMinor("1.234", 3)).toBe(1234);
  });

  it("rounds half up on the first dropped digit only", () => {
    expect(decimalToMinor("12.345", 2)).toBe(1235);
    expect(decimalToMinor("12.344", 2)).toBe(1234);
    expect(decimalToMinor("12.3449", 2)).toBe(1234);
    expect(decimalToMinor("0.995", 2)).toBe(100);
    expect(decimalToMinor("2.5", 0)).toBe(3);
    expect(decimalToMinor("2.4", 0)).toBe(2);
  });

  it("refuses a negative, empty or non-numeric amount", () => {
    for (const bad of ["-1.00", "", "abc", "1.2.3", ".5", "1e3", " 1"]) {
      expect(() => decimalToMinor(bad, 2), bad).toThrow(/amount/);
    }
  });
});

describe("microsToMinor / minorToMicros", () => {
  it("divides micros down to the currency's minor unit, rounding half up", () => {
    expect(microsToMinor("12340000", 2)).toBe(1234);
    expect(microsToMinor(12345000, 2)).toBe(1235);
    expect(microsToMinor("12344999", 2)).toBe(1234);
    expect(microsToMinor("7000000", 0)).toBe(7);
    expect(microsToMinor("1234000", 3)).toBe(1234);
    expect(microsToMinor("0", 2)).toBe(0);
  });

  it("refuses micros that are not a whole non-negative number", () => {
    for (const bad of ["-5", "1.5", "", "x"]) expect(() => microsToMinor(bad, 2), bad).toThrow(/micros/);
    expect(() => microsToMinor(-1, 2)).toThrow(/micros/);
    expect(() => microsToMinor(1.5, 2)).toThrow(/micros/);
  });

  it("scales minor units back up to micros", () => {
    expect(minorToMicros(1234, 2)).toBe(12_340_000);
    expect(minorToMicros(7, 0)).toBe(7_000_000);
    expect(minorToMicros(1234, 3)).toBe(1_234_000);
  });
});

describe("dailyBudgetDelta", () => {
  it("spreads a window move over its days as a daily rate", () => {
    expect(dailyBudgetDelta(70_000, 7)).toBe(10_000);
    expect(dailyBudgetDelta(10_000, 7)).toBe(1_429);
    expect(dailyBudgetDelta(5, 1)).toBe(5);
  });

  it("falls back to a single day for a window it cannot read", () => {
    expect(dailyBudgetDelta(700, 0)).toBe(700);
    expect(dailyBudgetDelta(700, Number.NaN)).toBe(700);
    expect(dailyBudgetDelta(700, -3)).toBe(700);
  });
});

describe("applyBudgetDelta", () => {
  it("raises and lowers a daily budget", () => {
    expect(applyBudgetDelta(50_000, 10_000)).toBe(60_000);
    expect(applyBudgetDelta(50_000, -10_000)).toBe(40_000);
  });

  it("refuses a move that would leave the campaign with no budget at all", () => {
    expect(() => applyBudgetDelta(10_000, -10_000)).toThrow(/budget/);
    expect(() => applyBudgetDelta(10_000, -20_000)).toThrow(/budget/);
    expect(applyBudgetDelta(10_000, -9_999)).toBe(1);
  });
});

describe("adCampaignMap", () => {
  it("reads platform campaign id -> LYRA campaign id from the connector config", () => {
    const map = adCampaignMap({ campaigns: { "111": "cmp_a", "222": "cmp_a", "333": "cmp_b" } });
    expect([...map.entries()]).toEqual([
      ["111", "cmp_a"],
      ["222", "cmp_a"],
      ["333", "cmp_b"]
    ]);
  });

  it("is empty for a config that maps nothing, and ignores entries that are not strings", () => {
    expect(adCampaignMap({}).size).toBe(0);
    expect(adCampaignMap({ campaigns: "111" }).size).toBe(0);
    expect(adCampaignMap({ campaigns: null }).size).toBe(0);
    expect(adCampaignMap({ campaigns: ["111"] }).size).toBe(0);
    expect([...adCampaignMap({ campaigns: { "111": 5, "222": "", "333": "cmp_b" } }).entries()]).toEqual([["333", "cmp_b"]]);
  });
});

describe("externalCampaignFor", () => {
  const map = adCampaignMap({ campaigns: { "111": "cmp_a", "222": "cmp_a", "333": "cmp_b" } });

  it("names the one platform campaign behind a LYRA campaign", () => {
    expect(externalCampaignFor(map, "cmp_b")).toBe("333");
  });

  it("names none when zero or several platform campaigns map to it — a budget cannot be split by guess", () => {
    expect(externalCampaignFor(map, "cmp_a")).toBeNull();
    expect(externalCampaignFor(map, "cmp_z")).toBeNull();
  });
});

describe("adChannel", () => {
  it("is the connector's configured channel, else the adapter's default", () => {
    expect(adChannel({ channel: "google_display" }, "google_search")).toBe("google_display");
    expect(adChannel({}, "google_search")).toBe("google_search");
    expect(adChannel({ channel: "" }, "meta")).toBe("meta");
    expect(adChannel({ channel: 7 }, "meta")).toBe("meta");
  });
});

it("ad connectors carry the one transport ORBIT's senders never select", () => {
  expect(AD_TRANSPORT).toBe("ads");
});

// docs/17 SIG-032, ADR-0112. Value-based bidding: what a bind is worth to the
// platform's bidder, and the only identifiers that may travel with it.

describe("minorToUnits", () => {
  it("states a minor amount in whole currency units, as the platforms' value fields take it", () => {
    expect(minorToUnits(12_345, 2)).toBe(123.45);
    expect(minorToUnits(7, 0)).toBe(7);
    expect(minorToUnits(1_234, 3)).toBe(1.234);
    expect(minorToUnits(0, 2)).toBe(0);
  });
});

describe("conversionValueRule", () => {
  it("sends no value until the tenant configures one", () => {
    expect(conversionValueRule({})).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: null })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: { basis: "none" } })).toEqual({ basis: "none" });
  });

  it("reads commission, or premium at a configured rate in ppm", () => {
    expect(conversionValueRule({ conversionValue: { basis: "commission" } })).toEqual({ basis: "commission" });
    expect(conversionValueRule({ conversionValue: { basis: "premium_rate", ratePpm: 150_000 } })).toEqual({ basis: "premium_rate", ratePpm: 150_000 });
  });

  it("treats a malformed rule as no rule, never as a guess", () => {
    expect(conversionValueRule({ conversionValue: { basis: "premium_rate" } })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: { basis: "premium_rate", ratePpm: 0 } })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: { basis: "premium_rate", ratePpm: 1_000_001 } })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: { basis: "premium_rate", ratePpm: 1.5 } })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: { basis: "revenue" } })).toEqual({ basis: "none" });
    expect(conversionValueRule({ conversionValue: "commission" })).toEqual({ basis: "none" });
  });
});

describe("conversionValueMinor", () => {
  it("is the commission as booked, or the premium times the rate rounded half up", () => {
    expect(conversionValueMinor({ basis: "commission" }, { premiumMinor: 100_000, commissionMinor: 12_500 })).toBe(12_500);
    expect(conversionValueMinor({ basis: "premium_rate", ratePpm: 125_000 }, { premiumMinor: 100_001, commissionMinor: null })).toBe(12_500);
    expect(conversionValueMinor({ basis: "premium_rate", ratePpm: 125_000 }, { premiumMinor: 100_004, commissionMinor: null })).toBe(12_501);
  });

  it("is null when the basis has nothing to read, or the value would be zero", () => {
    expect(conversionValueMinor({ basis: "none" }, { premiumMinor: 100_000, commissionMinor: 5 })).toBeNull();
    expect(conversionValueMinor({ basis: "commission" }, { premiumMinor: 100_000, commissionMinor: null })).toBeNull();
    expect(conversionValueMinor({ basis: "commission" }, { premiumMinor: 100_000, commissionMinor: 0 })).toBeNull();
    expect(conversionValueMinor({ basis: "premium_rate", ratePpm: 10 }, { premiumMinor: null, commissionMinor: 5 })).toBeNull();
    expect(conversionValueMinor({ basis: "premium_rate", ratePpm: 10 }, { premiumMinor: 1, commissionMinor: null })).toBeNull();
  });
});

describe("hashed identifiers", () => {
  it("normalise before hashing, so the platform can match the same person", async () => {
    expect(await hashEmail("  Rania.Haddad@Example.AE ")).toBe(await sha256Hex("rania.haddad@example.ae"));
    expect(await hashPhone("+971 50-123 4567")).toBe(await sha256Hex("971501234567"));
  });

  it("refuse what is not an email or a phone number rather than hash noise", async () => {
    expect(await hashEmail("not-an-email")).toBeNull();
    expect(await hashEmail("")).toBeNull();
    expect(await hashPhone("call me")).toBeNull();
    expect(await hashPhone("12")).toBeNull();
  });
});

describe("clickId", () => {
  it("accepts a platform click id and nothing that could smuggle markup or spaces", () => {
    expect(clickId("Cj0KCQjw-abc_123")).toBe("Cj0KCQjw-abc_123");
    expect(clickId(undefined)).toBeNull();
    expect(clickId("")).toBeNull();
    expect(clickId("a b")).toBeNull();
    expect(clickId("<x>")).toBeNull();
    expect(clickId("x".repeat(513))).toBeNull();
  });
});

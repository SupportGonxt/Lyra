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
  minorToMicros
} from "./ad-platform.js";

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

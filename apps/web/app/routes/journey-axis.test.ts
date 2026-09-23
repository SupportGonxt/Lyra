import { describe, expect, it, vi } from "vitest";

vi.mock("../api.server", () => ({ api: vi.fn(), asRouteError: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { formatMoney } from "@lyra/ui";
import { bookValue, groupByProductLine, labelsIn, summary } from "./journey-axis";

const row = (productLine: string, valueMinor: number, currency = "AED") => ({
  id: `cas_${productLine}_${valueMinor}`,
  ref: "C-1",
  productLine,
  status: "open",
  priority: "normal",
  valueMinor,
  currency
});

describe("groupByProductLine", () => {
  it("ranks lines by value and counts their cases", () => {
    const lines = groupByProductLine([row("home", 100), row("motor", 500), row("home", 50), row("", 10)]);
    expect(lines.map((l) => [l.productLine, l.total, l.count])).toEqual([
      ["motor", 500, 1],
      ["home", 150, 2],
      ["unassigned", 10, 1]
    ]);
  });

  it("leaves an unpriced case out of the book instead of formatting a null currency", () => {
    const unpriced = { ...row("", 0), productLine: null, valueMinor: null, currency: null };
    const lines = groupByProductLine([row("motor", 500), unpriced as never]);
    expect(lines.map((l) => [l.productLine, l.currency])).toEqual([["motor", "AED"]]);
    expect(() => formatMoney(lines[0]!.total, lines[0]!.currency, "en")).not.toThrow();
  });
});

describe("bookValue", () => {
  it("never adds two currencies together", () => {
    const lines = groupByProductLine([row("motor", 500, "AED"), row("home", 300, "USD"), row("life", 100, "AED")]);
    expect(bookValue(lines)).toEqual({ total: 600, currency: "AED", mixed: true });
    expect(bookValue([])).toBeNull();
  });
});

describe("summary", () => {
  it("counts in English with a real plural", () => {
    const l = labelsIn("en");
    expect(summary(l, 1, 1, "en")).toBe("1 case across 1 product line.");
    expect(summary(l, 12, 3, "en")).toBe("12 cases across 3 product lines.");
  });

  it("counts in Arabic with the dual and the few/many forms", () => {
    const l = labelsIn("ar");
    expect(summary(l, 2, 2, "ar")).toBe("حالتان عبر خطا منتج.");
    expect(summary(l, 1, 1, "ar")).toBe("حالة واحدة عبر خط منتج واحد.");
    expect(summary(l, 3, 11, "ar")).toContain("حالات");
  });

  it("formats money in the reader's locale, not the server's", () => {
    // The screen used toLocaleString(undefined), i.e. whatever the Worker's
    // default is, for every reader.
    expect(formatMoney(123_456, "AED", "ar")).not.toBe(formatMoney(123_456, "AED", "en"));
  });
});

import { describe, expect, it } from "vitest";
import { LABELS, coverageText, labelsIn, priceVsMarket, signedPercent } from "./portal.$tenantSlug.suppliers.$id";

// docs: PORTALS-DESIGN-AND-AUDIT.md §1. The logic on the insurer's page is the
// price index (basis points against market → a readable percent) and the copy,
// which must exist in both languages before a reader meets it.

describe("priceVsMarket", () => {
  it("reads a basis-point index as a signed percent against market", () => {
    expect(priceVsMarket(10_000)).toBe(0);
    expect(priceVsMarket(10_400)).toBe(4);
    expect(priceVsMarket(9_700)).toBe(-3);
  });

  it("is null when the bench has no price for the row", () => {
    expect(priceVsMarket(null)).toBeNull();
  });
});

describe("signedPercent", () => {
  it("signs a rise and leaves a fall to its own minus", () => {
    expect(signedPercent(4)).toBe("+4%");
    expect(signedPercent(0)).toBe("0%");
    expect(signedPercent(-3)).toBe("-3%");
  });

  it("renders nothing rather than NaN when there is no index", () => {
    expect(signedPercent(null)).toBeNull();
  });
});

describe("coverageText", () => {
  const l = labelsIn("en");

  it("lists the terms when the column holds a terms fact", () => {
    expect(
      coverageText(
        {
          kind: "terms",
          terms: [
            { term: "roadside", ours: { present: false }, panelMedian: { present: true } },
            { term: "excess", ours: { present: true, minor: 50_000 }, panelMedian: { present: true, minor: 100_000 } }
          ]
        },
        l
      )
    ).toBe("roadside, excess");
  });

  it("states the counts when the column holds a reach fact", () => {
    // The shape the Bench Builder writes. `parseArray` made this "None".
    expect(coverageText({ kind: "reach", unquotedRequests: 41, declined: 6 }, l)).toBe("41 never quoted, 6 declined");
  });

  it("is the empty state only for a null column or a terms fact with no terms", () => {
    expect(coverageText(null, l)).toBeNull();
    expect(coverageText({ kind: "terms", terms: [] }, l)).toBeNull();
  });

  it("has words for both facts in both languages", () => {
    for (const locale of ["en", "ar"]) {
      const text = coverageText({ kind: "reach", unquotedRequests: 41, declined: 6 }, labelsIn(locale));
      expect(text, locale).not.toBeNull();
      expect(text, locale).toContain("41");
      expect(text, locale).toContain("6");
    }
  });
});

describe("supplier labels", () => {
  it("has the same keys in every language", () => {
    const en = Object.keys(LABELS.en!).sort();
    for (const [locale, table] of Object.entries(LABELS)) {
      expect(Object.keys(table).sort(), `locale ${locale}`).toEqual(en);
    }
  });

  it("falls back to English rather than printing a raw key", () => {
    expect(labelsIn("fr")("supplier.position.title")).toBe(LABELS.en!["supplier.position.title"]);
  });

  it("interpolates a variable", () => {
    expect(labelsIn("en")("supplier.products.floor", { n: "20" })).toContain("20");
  });

  it("has words for a link that no longer works, in both languages", () => {
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      expect(l("supplier.denied.title")).not.toBe("supplier.denied.title");
      expect(l("supplier.denied.body")).not.toBe("supplier.denied.body");
    }
  });
});

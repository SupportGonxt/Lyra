import { describe, expect, it } from "vitest";
import { translator } from "./i18n";
import { documentTitle } from "./title";

// WCAG 2.4.2: every in-session page carried the tenant name alone as its
// <title> (49 routes failed axe `document-title`), so tabs, history and a
// screen reader's page announcement could not tell one screen from another.

const t = translator("en");

describe("documentTitle", () => {
  it("names a bespoke screen, its workspace and the product", () => {
    expect(documentTitle("/axis/quote-desk", t, "GONXT", "en")).toBe("Quote desk · Operations · GONXT");
  });

  it("names a workspace landing once", () => {
    expect(documentTitle("/ledger", t, "GONXT", "en")).toBe("Ledger · GONXT");
  });

  it("names a generic resource tab from the workspace spec", () => {
    expect(documentTitle("/axis/cases", t, "GONXT", "en")).toBe("Cases · Operations · GONXT");
  });

  it("names a record under its resource", () => {
    expect(documentTitle("/axis/cases/cas_01ABC", t, "GONXT", "en")).toBe("Cases · Operations · GONXT");
  });

  it("names home", () => {
    expect(documentTitle("/", t, "GONXT", "en")).toBe("Home · GONXT");
  });

  it("falls back to the product for a path it cannot name", () => {
    expect(documentTitle("/nowhere/at-all", t, "GONXT", "en")).toBe("GONXT");
  });

  it("is translated", () => {
    expect(documentTitle("/ledger", translator("ar"), "GONXT", "ar")).not.toContain("Ledger");
  });
});

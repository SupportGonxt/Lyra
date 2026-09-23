import { describe, expect, it } from "vitest";
import { chosen, metricName, metricText, narrative, num, parsed, pct } from "./north-shared";

// The generic CRUD hydrates every `*Json` column before it leaves the API
// (apps/api/src/crud.ts), while a bespoke module route hands the raw text
// through. Both shapes reach these screens, so both are pinned here.

describe("parsed", () => {
  it("takes an already-hydrated object as it is", () => {
    expect(parsed<{ a: number }>({ a: 1 }, { a: 0 })).toEqual({ a: 1 });
    expect(parsed<number[]>([1, 2], [])).toEqual([1, 2]);
  });

  it("still parses the raw text a module route hands through", () => {
    expect(parsed<{ a: number }>('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it("falls back rather than taking the screen down on a malformed column", () => {
    expect(parsed<string[]>("{not json", [])).toEqual([]);
  });

  it("treats empty, null and absent as nothing recorded", () => {
    expect(parsed("", "fallback")).toBe("fallback");
    expect(parsed(null, "fallback")).toBe("fallback");
    expect(parsed(undefined, "fallback")).toBe("fallback");
  });
});

describe("metricName", () => {
  const names = { en: "Gross written premium", ar: "إجمالي الأقساط المكتتبة" };

  it("reads the actor's locale out of a hydrated name column", () => {
    expect(metricName({ key: "gwp", nameJson: names }, "ar")).toBe(names.ar);
  });

  it("reads it out of the raw text just the same", () => {
    expect(metricName({ key: "gwp", nameJson: JSON.stringify(names) }, "en")).toBe(names.en);
  });

  it("falls back to English before it falls back to the key", () => {
    expect(metricName({ key: "gwp", nameJson: { en: names.en } }, "ar")).toBe(names.en);
    expect(metricName({ key: "gwp", nameJson: null }, "en")).toBe("gwp");
  });
});

describe("num", () => {
  it("renders an em dash where the detector recorded nothing", () => {
    expect(num(null, "en")).toBe("—");
    expect(num(undefined, "en")).toBe("—");
  });

  it("keeps zero, which is a number and not an absence", () => {
    expect(num(0, "en")).toBe("0");
  });
});

describe("pct", () => {
  it("signs a move so a rise reads as a rise", () => {
    expect(pct(1200, "en")).toBe("+12%");
    expect(pct(-1200, "en")).toBe("-12%");
  });

  it("has nothing to say without a prior", () => {
    expect(pct(null, "en")).toBeNull();
  });
});

describe("narrative", () => {
  it("passes prose through", () => {
    expect(narrative("Motor closed the month above every prior month.")).toBe(
      "Motor closed the month above every prior month."
    );
  });

  it("declines a storage key no bucket ever held", () => {
    expect(narrative("briefings/tn_01KE953T001KXF59BET3N3P5S6/brf_01KE953T0188ZHZRJCA23ST82K.md")).toBeNull();
    expect(narrative("")).toBeNull();
    expect(narrative(null)).toBeNull();
  });

  it("does not mistake a sentence that mentions a file for a key", () => {
    expect(narrative("See the attached brief.md for the full read.")).not.toBeNull();
  });
});

/**
 * NORTH narrates per audience *and* per locale, so a bilingual tenant has an en
 * and an ar briefing for the same day. The rows arrive newest-first, and both
 * screens used to take `rows[0]` — on staging the newest happened to be ar, so
 * an English reader's brief opened in Arabic.
 */
describe("chosen", () => {
  const rows = [
    { id: "brf_ar", locale: "ar" },
    { id: "brf_en", locale: "en" },
    { id: "brf_old_en", locale: "en" }
  ];

  it("gives the reader the newest briefing in their own language", () => {
    expect(chosen(rows, null, "en")?.id).toBe("brf_en");
    expect(chosen(rows, null, "ar")?.id).toBe("brf_ar");
  });

  it("still shows the newest one when nothing was narrated in that language", () => {
    expect(chosen(rows, null, "fr")?.id).toBe("brf_ar");
  });

  it("honours an explicit pick over the reader's language", () => {
    expect(chosen(rows, "brf_old_en", "ar")?.id).toBe("brf_old_en");
  });

  it("falls back to the newest when the asked-for briefing is gone", () => {
    expect(chosen(rows, "brf_deleted", "en")?.id).toBe("brf_ar");
  });

  it("has nothing to show before the first briefing exists", () => {
    expect(chosen([], null, "en")).toBeNull();
    expect(chosen(null, null, "en")).toBeNull();
  });
});

describe("metricText", () => {
  // The explorer's chart axis printed "56400" beside a figure of AED 564.00:
  // the axis took the stored integer, not the metric's units.
  it("reads a money metric in major units with its currency", () => {
    expect(metricText(56_400, "money", "AED", "en")).toMatch(/564\.00/);
  });
  it("reads a percent metric from basis points", () => {
    expect(metricText(1_250, "percent", null, "en")).toBe("12.5%");
  });
  it("reads a count as a grouped number", () => {
    expect(metricText(32_210, "count", null, "en")).toBe("32,210");
  });
});

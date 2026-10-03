import { describe, expect, it } from "vitest";
import { shape, visualLine } from "./arabic.js";

// ADR-0114. The PDF draws glyphs in the order it is handed them, left to right,
// so Arabic has to arrive already joined (contextual forms) and already
// reordered (bidi). These pin both against hand-checked Unicode values.

const hex = (s: string): string[] =>
  shape(s).flatMap((c) => c.cps.map((cp) => cp.toString(16).toUpperCase()));

describe("arabic shaping", () => {
  it("picks isolated, initial, medial and final forms by neighbour", () => {
    // ب alone, then ببب: initial, medial, final.
    expect(hex("ب")).toEqual(["FE8F"]);
    expect(hex("ببب")).toEqual(["FE91", "FE92", "FE90"]);
    // مريم: م initial, ر final (right-joining, so the next letter starts again),
    // ي initial, م final.
    expect(hex("مريم")).toEqual(["FEE3", "FEAE", "FEF3", "FEE2"]);
  });

  it("never joins a right-joining letter to what follows it", () => {
    // دار: د isolated, ا isolated (د does not join forward), ر isolated.
    expect(hex("دار")).toEqual(["FEA9", "FE8D", "FEAD"]);
  });

  it("forms the lam-alef ligature, isolated and final", () => {
    expect(hex("لا")).toEqual(["FEFB"]);
    // سلام: س initial, then لا final (it joins the س before it), م isolated.
    expect(hex("سلام")).toEqual(["FEB3", "FEFC", "FEE1"]);
    expect(hex("لأ")).toEqual(["FEF7"]);
    expect(hex("لإ")).toEqual(["FEF9"]);
    expect(hex("لآ")).toEqual(["FEF5"]);
    // The ligature still copies out as the two letters it replaced.
    expect(shape("سلام")[1]!.src).toBe("لا");
  });

  it("treats marks as transparent and keeps them with their letter", () => {
    // بَب: the fatha does not break the join; it rides on the first cluster.
    const c = shape("بَب");
    expect(c).toHaveLength(2);
    expect(c[0]!.cps.map((x) => x.toString(16).toUpperCase())).toEqual(["FE91", "64E"]);
    expect(c[1]!.cps[0]!.toString(16).toUpperCase()).toBe("FE90");
  });

  it("honours ZWNJ and ZWJ, then drops them", () => {
    expect(hex("ب‌ب")).toEqual(["FE8F", "FE8F"]);
    expect(hex("ب‍")).toEqual(["FE91"]);
  });

  it("does not touch Latin text", () => {
    expect(hex("Ab1")).toEqual(["41", "62", "31"]);
  });
});

describe("arabic bidi", () => {
  const visual = (s: string, fallback: 0 | 1 = 0): string =>
    visualLine(s, fallback)
      .clusters.map((c) => c.src)
      .join("");

  it("draws an Arabic name right to left", () => {
    const { base, clusters } = visualLine("مريم الكعبي");
    expect(base).toBe(1);
    // Visual order is the logical order reversed, cluster by cluster.
    expect(clusters.map((c) => c.src).join("")).toBe([..."مريم الكعبي"].reverse().join(""));
  });

  it("keeps a number left to right inside an Arabic line", () => {
    // "شارع 12" (street 12): the digits stay 1 then 2, and sit to the LEFT of
    // the word, because the line runs right to left.
    expect(visual("شارع 12")).toBe("12 عراش");
    // A date keeps its separators inside the number run.
    expect(visual("تاريخ 2026-06-15")).toBe("2026-06-15 خيرات");
    // Arabic-Indic digits are numbers too.
    expect(visual("رقم ١٢٣")).toBe("١٢٣ مقر");
  });

  it("keeps a Latin run left to right inside an Arabic line", () => {
    expect(visual("وثيقة POL-0001")).toBe("POL-0001 ةقيثو");
  });

  it("keeps an Arabic run right to left inside a Latin line", () => {
    expect(visual("Insured: مريم")).toBe("Insured: ميرم");
    // A number after Arabic belongs to it (W2), so it is drawn on its far side.
    expect(visual("Policy POL-1 مريم 2026")).toBe("Policy POL-1 2026 ميرم");
  });

  it("mirrors brackets in a right-to-left run", () => {
    const line = visualLine("مريم (الكعبي)");
    const drawn = line.clusters.flatMap((c) => c.cps);
    // Logical "(" opens on the right; drawn left to right it is the ")" glyph
    // that comes first.
    expect(String.fromCodePoint(drawn[0]!)).toBe("(");
    expect(line.clusters[0]!.src).toBe(")");
  });

  it("keeps a bracket pair together around Arabic at the end of a Latin line (N0)", () => {
    // Sources in visual order; the brackets are drawn mirrored, so the reader
    // sees "Policy POL-1 (الكعبي) 2026 مريم".
    expect(visual("Policy POL-1 مريم 2026 (الكعبي)")).toBe("Policy POL-1 )يبعكلا( 2026 ميرم");
    // And a Latin bracket stays a Latin bracket.
    expect(visual("Cover (full)")).toBe("Cover (full)");
  });

  it("uses the fallback direction when nothing is strong", () => {
    expect(visualLine("2026-06-15", 1).base).toBe(1);
    expect(visual("2026-06-15", 1)).toBe("2026-06-15");
    expect(visualLine("2026-06-15").base).toBe(0);
  });
});

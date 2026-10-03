import { describe, expect, it } from "vitest";
import { arabicFace } from "./pdf-font.js";
import { compactTrueType, glyphClosure, parseTrueType } from "./truetype.js";

// ADR-0114. The per-document subset renumbers glyphs; a viewer then reaches
// each one through /CIDToGIDMap. These check the subset is a font that still
// measures and maps the same.

describe("truetype subset", () => {
  const face = arabicFace();
  const drawn = [0xfee3, 0xfeae, 0xfef3, 0xfee2, 0xfefb].map((cp) => face.glyph(cp));

  it("finds a glyph for every presentation form the shaper emits", () => {
    expect(drawn.every((g) => g > 0)).toBe(true);
    expect(face.glyph(0x4e00)).toBe(0); // CJK: not in the face
  });

  it("keeps only the drawn glyphs (and what they are built from), densely numbered", () => {
    const { bytes, gidMap } = compactTrueType(face, drawn, ["OS/2", "name"]);
    const sub = parseTrueType(bytes);
    const closure = glyphClosure(face, drawn);
    expect(sub.numGlyphs).toBe(closure.size);
    expect([...gidMap.values()].sort((a, b) => a - b)).toEqual([...Array(closure.size).keys()]);
    expect(gidMap.get(0)).toBe(0);
    // Same advance through the new id as through the old one.
    for (const g of drawn) expect(sub.advance(gidMap.get(g)!)).toBe(face.advance(g));
    expect(sub.unitsPerEm).toBe(face.unitsPerEm);
    expect(bytes.length).toBeLessThan(8_000);
  });
});

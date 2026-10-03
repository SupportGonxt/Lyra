import { NOTO_NASKH_ARABIC_TTF } from "./fonts/noto-naskh-arabic.js";
import { compactTrueType, parseTrueType, type TrueType } from "./truetype.js";
import { concat, utf8 } from "./zip.js";

// The embedded Arabic face for pdf.ts (ADR-0115): Noto Naskh Arabic, drawn as a
// Type0 font over a CIDFontType2 with Identity-H, so the two bytes written per
// glyph *are* the face's glyph id. Each document embeds only the glyphs it drew,
// renumbered densely, with a /CIDToGIDMap from the one id to the other.

export const FONT_NAME = "NotoNaskhArabic-Regular";

let cached: TrueType | undefined;

/** Parsed once per isolate, on the first document that needs it. */
export function arabicFace(): TrueType {
  if (!cached) {
    const bin = atob(NOTO_NASKH_ARABIC_TTF);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    cached = parseTrueType(bytes);
  }
  return cached;
}

/** Advance in 1/1000 em, the unit PDF widths are written in. */
export function advance1000(gid: number): number {
  const f = arabicFace();
  return Math.round((f.advance(gid) * 1000) / f.unitsPerEm);
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");

/** UTF-16BE hex, the form PDF text strings and ToUnicode targets take. */
export function utf16Hex(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += hex4(s.charCodeAt(i));
  return out;
}

/**
 * The six objects that embed the face, numbered from `first`: Type0 font,
 * CIDFontType2, FontDescriptor, FontFile2, ToUnicode, CIDToGIDMap. `used` maps
 * each glyph drawn (by the face's own id) to the text it stands for.
 */
export function fontObjects(first: number, used: ReadonlyMap<number, string>): (string | Uint8Array)[] {
  const f = arabicFace();
  const gids = [...used.keys()].sort((a, b) => a - b);
  const tag = subsetTag(gids);
  const name = `${tag}+${FONT_NAME}`;
  // `first` itself is the Type0 font, which nothing inside the set refers to.
  const [cid, descriptor, file, toUni, cidToGid] = [first + 1, first + 2, first + 3, first + 4, first + 5];
  const scale = (v: number): number => Math.round((v * 1000) / f.unitsPerEm);

  // The content stream draws the face's own glyph ids as CIDs; the embedded
  // subset renumbers them densely and /CIDToGIDMap says where each went. That
  // keeps one drawn name a few kilobytes instead of a full-size hmtx and loca.
  const widths = gids.map((g) => `${g} [${advance1000(g)}]`).join(" ");
  const { bytes: ttf, gidMap } = compactTrueType(f, gids, ["OS/2", "name"]);
  const map = new Uint8Array((gids[gids.length - 1]! + 1) * 2);
  for (const [cidNo, gid] of gidMap) {
    map[cidNo * 2] = gid >> 8;
    map[cidNo * 2 + 1] = gid & 0xff;
  }

  const cmapLines: string[] = [];
  for (let i = 0; i < gids.length; i += 100) {
    const chunk = gids.slice(i, i + 100);
    cmapLines.push(`${chunk.length} beginbfchar`);
    for (const g of chunk) cmapLines.push(`<${hex4(g)}> <${utf16Hex(used.get(g)!)}>`);
    cmapLines.push("endbfchar");
  }
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...cmapLines,
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end",
    "end"
  ].join("\n");

  return [
    `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H ` +
      `/DescendantFonts [${cid} 0 R] /ToUnicode ${toUni} 0 R >>`,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
      `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
      `/FontDescriptor ${descriptor} 0 R /DW 0 /W [${widths}] /CIDToGIDMap ${cidToGid} 0 R >>`,
    `<< /Type /FontDescriptor /FontName /${name} /Flags 4 ` +
      `/FontBBox [${f.bbox.map(scale).join(" ")}] /ItalicAngle 0 /Ascent ${scale(f.ascent)} ` +
      `/Descent ${scale(f.descent)} /CapHeight ${scale(f.ascent)} /StemV 80 /FontFile2 ${file} 0 R >>`,
    concat([utf8(`<< /Length ${ttf.length} /Length1 ${ttf.length} >>\nstream\n`), ttf, utf8("\nendstream")]),
    `<< /Length ${utf8(cmap).length} >>\nstream\n${cmap}\nendstream`,
    concat([utf8(`<< /Length ${map.length} >>\nstream\n`), map, utf8("\nendstream")])
  ];
}

/** Six capitals naming the subset (PDF 32000 §9.6.4), stable for a glyph set. */
function subsetTag(gids: readonly number[]): string {
  let h = 0x811c9dc5;
  for (const g of gids) {
    h ^= g;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26);
  }
  return out;
}

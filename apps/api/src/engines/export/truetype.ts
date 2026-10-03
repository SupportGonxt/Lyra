// A TrueType reader and glyph subsetter — exactly as much of the format as an
// embedded PDF font needs (ADR-0115): the cmap to find a glyph, hmtx to measure
// it, and glyf/loca to ship only the glyphs a document draws.
//
// Glyph ids are preserved by the subsetter: an unused glyph keeps its slot with
// an empty outline. That is what lets the PDF use Identity-H with
// /CIDToGIDMap /Identity, where the code drawn *is* the glyph id, and it means
// the same font answers the same id in every document.

export interface TrueType {
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  readonly bbox: readonly [number, number, number, number];
  readonly numGlyphs: number;
  /** Glyph for a code point, or 0 (.notdef) when the font has none. */
  glyph(cp: number): number;
  /** Advance width in font units. */
  advance(gid: number): number;
  /** Every code point the cmap maps, with its glyph. */
  readonly cmap: ReadonlyMap<number, number>;
  readonly tables: ReadonlyMap<string, Uint8Array>;
}

const u16 = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!;
const i16 = (b: Uint8Array, o: number): number => {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (b: Uint8Array, o: number): number => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

export function parseTrueType(bytes: Uint8Array): TrueType {
  const n = u16(bytes, 4);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const tag = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    const off = u32(bytes, o + 8);
    tables.set(tag, bytes.subarray(off, off + u32(bytes, o + 12)));
  }
  const need = (tag: string): Uint8Array => {
    const t = tables.get(tag);
    if (!t) throw new Error(`truetype: missing ${tag} table`);
    return t;
  };
  const head = need("head");
  const hhea = need("hhea");
  const hmtx = need("hmtx");
  const numGlyphs = u16(need("maxp"), 4);
  const numberOfHMetrics = u16(hhea, 34);
  // A per-document subset has no cmap (the PDF maps ids itself); that is a
  // font with no characters, not a broken one.
  const cmapTable = tables.get("cmap");
  const cmap = cmapTable ? readCmap(cmapTable) : new Map<number, number>();

  return {
    unitsPerEm: u16(head, 18),
    ascent: i16(hhea, 4),
    descent: i16(hhea, 6),
    bbox: [i16(head, 36), i16(head, 38), i16(head, 40), i16(head, 42)],
    numGlyphs,
    glyph: (cp) => cmap.get(cp) ?? 0,
    advance: (gid) => u16(hmtx, Math.min(gid, numberOfHMetrics - 1) * 4),
    cmap,
    tables
  };
}

/** The Windows Unicode BMP subtable (3,1) or Unicode (0,3), format 4. */
function readCmap(t: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
  const count = u16(t, 2);
  let at = -1;
  for (let i = 0; i < count; i++) {
    const pid = u16(t, 4 + i * 8);
    const eid = u16(t, 6 + i * 8);
    const off = u32(t, 8 + i * 8);
    if (u16(t, off) === 4 && ((pid === 3 && eid === 1) || (pid === 0 && at < 0))) at = off;
  }
  if (at < 0) throw new Error("truetype: no format-4 Unicode cmap");
  const segX2 = u16(t, at + 6);
  const ends = at + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = u16(t, ends + s * 2);
    const start = u16(t, starts + s * 2);
    const delta = u16(t, deltas + s * 2);
    const rangeOff = u16(t, ranges + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g: number;
      if (rangeOff === 0) g = (c + delta) & 0xffff;
      else {
        const p = ranges + s * 2 + rangeOff + (c - start) * 2;
        g = u16(t, p);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) out.set(c, g);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- subset */

/** `gids` plus every glyph a composite among them is built from. */
export function glyphClosure(font: TrueType, gids: Iterable<number>): Set<number> {
  const loca = locaOffsets(font);
  const glyf = font.tables.get("glyf")!;
  const out = new Set<number>([0]);
  const todo = [...gids];
  while (todo.length) {
    const g = todo.pop()!;
    if (out.has(g) && g !== 0) continue;
    out.add(g);
    const start = loca[g]!;
    if (loca[g + 1]! <= start || i16(glyf, start) >= 0) continue;
    let p = start + 10;
    for (;;) {
      const flags = u16(glyf, p);
      const component = u16(glyf, p + 2);
      if (!out.has(component)) todo.push(component);
      p += 4 + (flags & 0x1 ? 4 : 2);
      if (flags & 0x8) p += 2;
      else if (flags & 0x40) p += 4;
      else if (flags & 0x80) p += 8;
      if (!(flags & 0x20)) break;
    }
  }
  return out;
}

function locaOffsets(font: TrueType): number[] {
  const loca = font.tables.get("loca")!;
  const long = i16(font.tables.get("head")!, 50) === 1;
  const out: number[] = [];
  for (let g = 0; g <= font.numGlyphs; g++) out.push(long ? u32(loca, g * 4) : u16(loca, g * 2) * 2);
  return out;
}

export interface SubsetOptions {
  /** Tables to carry, besides the glyph tables the subsetter rebuilds. */
  keep: readonly string[];
  /** Replace the cmap with one mapping exactly these code points. */
  cmap?: ReadonlyMap<number, number>;
}

/**
 * A copy of the font where every glyph outside `gids` (and its composite
 * closure) is empty. Glyph ids do not move. `loca` is always written long.
 */
export function subsetTrueType(font: TrueType, gids: Iterable<number>, opts: SubsetOptions): Uint8Array {
  const used = glyphClosure(font, gids);
  const loca = locaOffsets(font);
  const glyf = font.tables.get("glyf")!;

  const pieces: Uint8Array[] = [];
  const newLoca = new Uint8Array((font.numGlyphs + 1) * 4);
  let at = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    put32(newLoca, g * 4, at);
    if (!used.has(g)) continue;
    const data = glyf.subarray(loca[g]!, loca[g + 1]!);
    const padded = new Uint8Array(data.length + ((4 - (data.length % 4)) % 4));
    padded.set(data);
    pieces.push(padded);
    at += padded.length;
  }
  put32(newLoca, font.numGlyphs * 4, at);
  const newGlyf = new Uint8Array(at);
  let o = 0;
  for (const p of pieces) {
    newGlyf.set(p, o);
    o += p.length;
  }

  const head = font.tables.get("head")!.slice();
  head[50] = 0;
  head[51] = 1; // indexToLocFormat: long
  put32(head, 8, 0); // checkSumAdjustment, recomputed below

  const out = new Map<string, Uint8Array>();
  for (const tag of opts.keep) {
    const t = font.tables.get(tag);
    if (t) out.set(tag, t);
  }
  out.set("head", head);
  out.set("hhea", font.tables.get("hhea")!);
  out.set("maxp", font.tables.get("maxp")!);
  out.set("hmtx", font.tables.get("hmtx")!);
  out.set("loca", newLoca);
  out.set("glyf", newGlyf);
  if (opts.cmap) out.set("cmap", writeCmap(opts.cmap));

  const bytes = writeSfnt(out);
  // checkSumAdjustment = 0xB1B0AFBA - checksum(whole font), into head.
  const headAt = tableOffset(bytes, "head");
  put32(bytes, headAt + 8, (0xb1b0afba - checksum(bytes)) >>> 0);
  return bytes;
}

/**
 * A font of only `gids` (and their composite closure), renumbered densely from
 * .notdef = 0 in ascending old-id order. `gidMap` takes an old id to its new
 * one, which the PDF writes as its /CIDToGIDMap so the content stream can keep
 * drawing old ids. Used per document: a subset that keeps every slot (above)
 * still ships a full hmtx and loca, ~11 KB for one drawn name.
 */
export function compactTrueType(
  font: TrueType,
  gids: Iterable<number>,
  keep: readonly string[]
): { bytes: Uint8Array; gidMap: Map<number, number> } {
  const used = [...glyphClosure(font, gids)].sort((a, b) => a - b);
  const gidMap = new Map(used.map((g, i) => [g, i]));
  const loca = locaOffsets(font);
  const glyf = font.tables.get("glyf")!;
  const hmtx = font.tables.get("hmtx")!;
  const hhea = font.tables.get("hhea")!;
  const metrics = u16(hhea, 34);
  const n = used.length;

  const pieces: Uint8Array[] = [];
  const newLoca = new Uint8Array((n + 1) * 4);
  const newHmtx = new Uint8Array(n * 4);
  let at = 0;
  used.forEach((g, i) => {
    put32(newLoca, i * 4, at);
    put16(newHmtx, i * 4, font.advance(g));
    const lsb = g < metrics ? u16(hmtx, g * 4 + 2) : u16(hmtx, metrics * 4 + (g - metrics) * 2);
    put16(newHmtx, i * 4 + 2, lsb);
    const data = glyf.slice(loca[g]!, loca[g + 1]!);
    if (data.length && i16(data, 0) < 0) {
      // Composite: point each component at its new id.
      let p = 10;
      for (;;) {
        const flags = u16(data, p);
        put16(data, p + 2, gidMap.get(u16(data, p + 2))!);
        p += 4 + (flags & 0x1 ? 4 : 2);
        if (flags & 0x8) p += 2;
        else if (flags & 0x40) p += 4;
        else if (flags & 0x80) p += 8;
        if (!(flags & 0x20)) break;
      }
    }
    const padded = new Uint8Array(data.length + ((4 - (data.length % 4)) % 4));
    padded.set(data);
    pieces.push(padded);
    at += padded.length;
  });
  put32(newLoca, n * 4, at);
  const newGlyf = new Uint8Array(at);
  let o = 0;
  for (const p of pieces) {
    newGlyf.set(p, o);
    o += p.length;
  }

  const head = font.tables.get("head")!.slice();
  head[50] = 0;
  head[51] = 1;
  put32(head, 8, 0);
  const newHhea = hhea.slice();
  put16(newHhea, 34, n);
  const maxp = font.tables.get("maxp")!.slice();
  put16(maxp, 4, n);

  const out = new Map<string, Uint8Array>();
  for (const tag of keep) {
    const t = font.tables.get(tag);
    if (t) out.set(tag, t);
  }
  out.set("head", head);
  out.set("hhea", newHhea);
  out.set("maxp", maxp);
  out.set("hmtx", newHmtx);
  out.set("loca", newLoca);
  out.set("glyf", newGlyf);
  const bytes = writeSfnt(out);
  put32(bytes, tableOffset(bytes, "head") + 8, (0xb1b0afba - checksum(bytes)) >>> 0);
  return { bytes, gidMap };
}

function writeCmap(map: ReadonlyMap<number, number>): Uint8Array {
  const cps = [...map.keys()].filter((c) => c < 0xffff).sort((a, b) => a - b);
  const segs: { start: number; end: number; delta: number }[] = [];
  for (const c of cps) {
    const delta = (map.get(c)! - c) & 0xffff;
    const last = segs[segs.length - 1];
    if (last && last.end === c - 1 && last.delta === delta) last.end = c;
    else segs.push({ start: c, end: c, delta });
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1 });
  const segX2 = segs.length * 2;
  let es = 0;
  while (1 << (es + 1) <= segs.length) es++;
  const sub = new Uint8Array(16 + segX2 * 4);
  put16(sub, 0, 4);
  put16(sub, 2, sub.length);
  put16(sub, 6, segX2);
  put16(sub, 8, 2 << es);
  put16(sub, 10, es);
  put16(sub, 12, segX2 - (2 << es));
  segs.forEach((s, i) => {
    put16(sub, 14 + i * 2, s.end);
    put16(sub, 16 + segX2 + i * 2, s.start);
    put16(sub, 16 + segX2 * 2 + i * 2, s.delta);
    // idRangeOffset stays 0.
  });
  const t = new Uint8Array(12 + sub.length);
  put16(t, 2, 1);
  put16(t, 4, 3);
  put16(t, 6, 1);
  put32(t, 8, 12);
  t.set(sub, 12);
  return t;
}

function writeSfnt(tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const dirLen = 12 + n * 16;
  let size = dirLen;
  for (const tag of tags) size += (tables.get(tag)!.length + 3) & ~3;
  const out = new Uint8Array(size);
  put32(out, 0, 0x00010000);
  put16(out, 4, n);
  put16(out, 6, (1 << es) * 16);
  put16(out, 8, es);
  put16(out, 10, n * 16 - (1 << es) * 16);
  let at = dirLen;
  tags.forEach((tag, i) => {
    const data = tables.get(tag)!;
    const o = 12 + i * 16;
    for (let k = 0; k < 4; k++) out[o + k] = tag.charCodeAt(k);
    out.set(data, at);
    put32(out, o + 4, checksum(out.subarray(at, at + ((data.length + 3) & ~3))));
    put32(out, o + 8, at);
    put32(out, o + 12, data.length);
    at += (data.length + 3) & ~3;
  });
  return out;
}

function tableOffset(font: Uint8Array, tag: string): number {
  for (let i = 0; i < u16(font, 4); i++) {
    const o = 12 + i * 16;
    if (String.fromCharCode(font[o]!, font[o + 1]!, font[o + 2]!, font[o + 3]!) === tag) return u32(font, o + 8);
  }
  throw new Error(`truetype: no ${tag}`);
}

function checksum(b: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < b.length; i += 4) {
    sum = (sum + (((b[i]! << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)) >>> 0)) >>> 0;
  }
  return sum;
}

function put16(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >> 8) & 0xff;
  b[o + 1] = v & 0xff;
}

function put32(b: Uint8Array, o: number, v: number): void {
  b[o] = (v >>> 24) & 0xff;
  b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff;
  b[o + 3] = v & 0xff;
}

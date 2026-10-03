// Arabic for the PDF writer (ADR-0114): contextual shaping and the bidi
// reordering a printed line needs. A PDF draws glyphs left to right in the
// order it is given them, so this file turns logical text ("مريم", typed right
// to left) into the visual sequence of glyphs a reader sees.
//
// Shaping is by the Unicode Arabic Presentation Forms (FB50–FDFF, FE70–FEFF),
// which the embedded font maps directly — not by parsing the font's GSUB. That
// covers every letter of Arabic and the four Persian/Urdu letters below, the
// lam-alef ligatures, and harakat drawn as zero-width marks. It does not do the
// optional ligatures, kashida justification or mark positioning (GPOS): a
// vowelled name prints its marks at the font's default offset.
//
// Bidi is the subset of UAX #9 that a single line of a table cell needs: no
// explicit embeddings or isolates (their controls are dropped), rules W1–W7,
// N0 (bracket pairs), N1–N2, I1–I2, L1–L2 and bracket mirroring (L4). Enough
// for names, addresses, labels with digits, dates and amounts in an Arabic
// line. One deliberate deviation, at W4 below: a hyphenated number stays whole.

/** One printed unit: a base glyph (or ligature) with the marks it carries. */
export interface Cluster {
  /** Code points to draw, presentation forms already applied. Empty = invisible. */
  readonly cps: readonly number[];
  /** The logical text this cluster came from, for ToUnicode and copy-paste. */
  readonly src: string;
  readonly type: BidiType;
}

export interface Placed extends Cluster {
  readonly level: number;
}

export type BidiType = "L" | "R" | "AL" | "EN" | "AN" | "ES" | "ET" | "CS" | "WS" | "ON";

/** Any code point this module treats as Arabic script. */
export function isArabic(cp: number): boolean {
  return (cp >= 0x0600 && cp <= 0x06ff) || (cp >= 0x0750 && cp <= 0x077f) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfefc);
}

export const HAS_ARABIC = /[؀-ۿݐ-ݿﭐ-﷿ﹰ-ﻼ]/u;

/* ----------------------------------------------------------------- joining */

/** [isolated, final, initial, medial]; two entries means right-joining only. */
const FORMS: Record<number, readonly number[]> = {
  0x0621: [0xfe80],
  0x0622: [0xfe81, 0xfe82],
  0x0623: [0xfe83, 0xfe84],
  0x0624: [0xfe85, 0xfe86],
  0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa],
  0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae],
  0x0632: [0xfeaf, 0xfeb0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee],
  // Alef maksura is dual-joining; its initial and medial forms are in Forms-A.
  0x0649: [0xfeef, 0xfef0, 0xfbe8, 0xfbe9],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  0x0671: [0xfb50, 0xfb51],
  // Persian and Urdu letters that Gulf names and addresses carry.
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59],
  0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d],
  0x0698: [0xfb8a, 0xfb8b],
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91],
  0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95],
  0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff]
};

/** Lam + this alef → [isolated, final] ligature. */
const LAM_ALEF: Record<number, readonly [number, number]> = {
  0x0622: [0xfef5, 0xfef6],
  0x0623: [0xfef7, 0xfef8],
  0x0625: [0xfef9, 0xfefa],
  0x0627: [0xfefb, 0xfefc]
};

/** Every presentation-form code point the shaper can emit. */
export const PRESENTATION_FORMS: readonly number[] = [
  ...Object.values(FORMS).flat(),
  ...Object.values(LAM_ALEF).flat()
].filter((cp) => cp >= 0xfb50);

const LAM = 0x0644;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const TATWEEL = 0x0640;

/** Combining marks: drawn on the letter before them, transparent to joining. */
export function isMark(cp: number): boolean {
  return (
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x06df && cp <= 0x06e4) ||
    cp === 0x06e7 ||
    cp === 0x06e8 ||
    (cp >= 0x06ea && cp <= 0x06ed)
  );
}

type Join = "D" | "R" | "C" | "U";

function joining(cp: number): Join {
  const f = FORMS[cp];
  if (f) return f.length === 4 ? "D" : f.length === 2 ? "R" : "U";
  if (cp === TATWEEL || cp === ZWJ) return "C";
  return "U";
}

/** True when the shaper knows how to join this letter, or it never joins. */
export function shapeable(cp: number): boolean {
  if (FORMS[cp] || isMark(cp) || !isArabic(cp)) return true;
  // Other Arabic letters that join but have no presentation form here would be
  // drawn unjoined — wrong, so they are refused rather than misprinted.
  return !joinsWithoutForms(cp);
}

function joinsWithoutForms(cp: number): boolean {
  // Letters in the Arabic block (and Supplement) outside FORMS are joining.
  return (cp >= 0x0620 && cp <= 0x064a && cp !== TATWEEL) || (cp >= 0x066e && cp <= 0x06d5 && cp !== 0x06d4) || (cp >= 0x06ee && cp <= 0x06ff && !(cp >= 0x06f0 && cp <= 0x06f9) && cp !== 0x06fd && cp !== 0x06fe) || (cp >= 0x0750 && cp <= 0x077f);
}

/** Logical text → clusters with contextual forms and lam-alef applied. */
export function shape(s: string): Cluster[] {
  const cps = [...s].map((c) => c.codePointAt(0)!);
  const n = cps.length;

  // Neighbour that matters for joining: skip marks, they are transparent.
  const prevJoin = (i: number): Join => {
    for (let k = i - 1; k >= 0; k--) if (!isMark(cps[k]!)) return joining(cps[k]!);
    return "U";
  };
  const nextJoin = (i: number): Join => {
    for (let k = i + 1; k < n; k++) if (!isMark(cps[k]!)) return joining(cps[k]!);
    return "U";
  };
  const forward = (j: Join): boolean => j === "D" || j === "C";
  const backward = (j: Join): boolean => j === "D" || j === "R" || j === "C";

  const out: Cluster[] = [];
  for (let i = 0; i < n; i++) {
    const cp = cps[i]!;
    // Joiners steer the joining above and are not drawn; embedding and isolate
    // controls are outside the subset of UAX #9 implemented here.
    if (cp === ZWJ || cp === ZWNJ || cp === 0x200b || cp === 0xfeff || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) continue;

    if (isMark(cp)) {
      const last = out[out.length - 1];
      if (last && last.cps.length) {
        out[out.length - 1] = { ...last, cps: [...last.cps, cp], src: last.src + String.fromCodePoint(cp) };
        continue;
      }
      out.push({ cps: [cp], src: String.fromCodePoint(cp), type: "AL" });
      continue;
    }

    const j = joining(cp);
    const forms = FORMS[cp];
    if (!forms) {
      // LRM, RLM and ALM are strong for bidi and invisible on the page.
      out.push({ cps: isFormatMark(cp) ? [] : [cp], src: String.fromCodePoint(cp), type: bidiType(cp) });
      continue;
    }
    const joinsPrev = backward(j) && forward(prevJoin(i));
    const after = nextJoin(i);
    const joinsNext = forward(j) && backward(after);

    // Lam followed directly by an alef: one ligature glyph, right-joining.
    const next = cps[i + 1];
    if (cp === LAM && next !== undefined && LAM_ALEF[next]) {
      const lig = LAM_ALEF[next]!;
      out.push({ cps: [joinsPrev ? lig[1] : lig[0]], src: String.fromCodePoint(cp, next), type: "AL" });
      i++;
      continue;
    }

    const form = joinsPrev && joinsNext ? forms[3] : joinsPrev ? forms[1] : joinsNext ? forms[2] : forms[0];
    out.push({ cps: [form ?? forms[0]!], src: String.fromCodePoint(cp), type: "AL" });
  }
  return out;
}

/* -------------------------------------------------------------------- bidi */

const LRM = 0x200e;
const RLM = 0x200f;
const ALM = 0x061c;
function isFormatMark(cp: number): boolean {
  return cp === LRM || cp === RLM || cp === ALM;
}

export function bidiType(cp: number): BidiType {
  if (cp === LRM) return "L";
  if (cp === RLM) return "R";
  if (cp === ALM) return "AL";
  if (cp >= 0x30 && cp <= 0x39) return "EN";
  if (cp >= 0x06f0 && cp <= 0x06f9) return "EN";
  if (cp === 0xb2 || cp === 0xb3 || cp === 0xb9) return "EN";
  if ((cp >= 0x0660 && cp <= 0x0669) || cp === 0x066b || cp === 0x066c) return "AN";
  if (cp === 0x2b || cp === 0x2d || cp === 0x2212) return "ES";
  if (cp === 0x23 || cp === 0x24 || cp === 0x25 || (cp >= 0xa2 && cp <= 0xa5) || cp === 0xb0 || cp === 0xb1 || cp === 0x066a || cp === 0x20ac) return "ET";
  if (cp === 0x2c || cp === 0x2e || cp === 0x2f || cp === 0x3a || cp === 0xa0 || cp === 0x060c) return "CS";
  if (cp === 0x20 || cp === 0x09 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x3000) return "WS";
  if (cp >= 0x0590 && cp <= 0x05ff) return "R";
  if (isArabic(cp)) return "AL";
  if (cp < 0x80) return /[A-Za-z]/.test(String.fromCharCode(cp)) ? "L" : "ON";
  if (cp >= 0xa1 && cp <= 0xbf) return cp === 0xaa || cp === 0xb5 || cp === 0xba ? "L" : "ON";
  if (cp === 0xd7 || cp === 0xf7) return "ON";
  if (cp >= 0x2010 && cp <= 0x2027) return "ON";
  if (cp >= 0x2030 && cp <= 0x205e) return cp === 0x2030 || cp === 0x2031 || cp === 0x2032 || cp === 0x2033 || cp === 0x2034 ? "ET" : "ON";
  return "L";
}

/** First strong character decides the paragraph (P2/P3); none → `fallback`. */
export function baseLevel(clusters: readonly Cluster[], fallback: 0 | 1 = 0): 0 | 1 {
  for (const c of clusters) {
    if (c.type === "L") return 0;
    if (c.type === "R" || c.type === "AL") return 1;
  }
  return fallback;
}

/** Resolve levels and return clusters in visual (left-to-right drawing) order. */
export function reorder(clusters: readonly Cluster[], base: 0 | 1): Placed[] {
  const n = clusters.length;
  const t: BidiType[] = clusters.map((c) => c.type);
  const sos: BidiType = base ? "R" : "L";

  // W2: EN after AL is AN. W3: AL is R.
  let strong: BidiType = sos;
  for (let i = 0; i < n; i++) {
    const x = t[i]!;
    if (x === "L" || x === "R" || x === "AL") strong = x;
    else if (x === "EN" && strong === "AL") t[i] = "AN";
  }
  for (let i = 0; i < n; i++) if (t[i] === "AL") t[i] = "R";

  // W4: one separator between two numbers of the same kind joins them.
  // Deliberate deviation (ADR-0114): UAX #9 joins a `-` only between European
  // numbers, and W2 has already turned digits after Arabic into AN — so strict
  // bidi prints "تاريخ 2026-06-15" as "15-06-2026". A document full of ISO
  // dates and policy numbers cannot afford that, so `-` and `+` join AN too.
  for (let i = 1; i < n - 1; i++) {
    const [a, x, b] = [t[i - 1], t[i], t[i + 1]];
    if (x === "ES" && a === b && (a === "EN" || a === "AN")) t[i] = a!;
    else if (x === "CS" && a === b && (a === "EN" || a === "AN")) t[i] = a!;
  }
  // W5: terminators touching a European number are part of it.
  for (let i = 0; i < n; i++) {
    if (t[i] !== "ET") continue;
    let k = i;
    while (k < n && t[k] === "ET") k++;
    if ((i > 0 && t[i - 1] === "EN") || (k < n && t[k] === "EN")) for (let m = i; m < k; m++) t[m] = "EN";
    i = k - 1;
  }
  // W6: what is left of the separators and terminators is neutral.
  for (let i = 0; i < n; i++) if (t[i] === "ES" || t[i] === "ET" || t[i] === "CS") t[i] = "ON";
  // W7: EN after L (or an L start) is L.
  strong = sos;
  for (let i = 0; i < n; i++) {
    const x = t[i]!;
    if (x === "L" || x === "R") strong = x;
    else if (x === "EN" && strong === "L") t[i] = "L";
  }

  // N0: a bracket pair takes one direction, so "(الكعبي)" stays a pair at the
  // end of a Latin line instead of the closer drifting to the far side.
  const e: BidiType = base ? "R" : "L";
  const strongOf = (x: BidiType | undefined): BidiType | undefined =>
    x === "L" ? "L" : x === "R" || x === "EN" || x === "AN" ? "R" : undefined;
  for (const [o, c] of bracketPairs(clusters, t)) {
    let inside: BidiType | undefined;
    for (let k = o + 1; k < c; k++) {
      const s = strongOf(t[k]);
      if (s === e) {
        inside = e;
        break;
      }
      if (s) inside = s;
    }
    if (!inside) continue;
    let dirOf = inside;
    if (inside !== e) {
      let before: BidiType = sos;
      for (let k = o - 1; k >= 0; k--) {
        const s = strongOf(t[k]);
        if (s) {
          before = s;
          break;
        }
      }
      dirOf = before === inside ? inside : e;
    }
    t[o] = dirOf;
    t[c] = dirOf;
  }

  // N1/N2: neutrals between two strongs of one direction take it; else base.
  const dir = (x: BidiType | undefined, edge: BidiType): BidiType => {
    const v = x ?? edge;
    return v === "L" ? "L" : "R"; // EN and AN count as R here
  };
  for (let i = 0; i < n; i++) {
    if (t[i] !== "ON" && t[i] !== "WS") continue;
    let k = i;
    while (k < n && (t[k] === "ON" || t[k] === "WS")) k++;
    const before = dir(i > 0 ? t[i - 1] : undefined, sos);
    const after = dir(k < n ? t[k] : undefined, sos);
    const r: BidiType = before === after ? before : base ? "R" : "L";
    for (let m = i; m < k; m++) t[m] = r;
    i = k - 1;
  }

  // I1/I2.
  const levels = t.map((x) => {
    if (base === 0) return x === "R" ? 1 : x === "AN" || x === "EN" ? 2 : 0;
    return x === "L" || x === "EN" || x === "AN" ? 2 : 1;
  });
  // L1: trailing whitespace returns to the paragraph level.
  for (let i = n - 1; i >= 0 && clusters[i]!.type === "WS"; i--) levels[i] = base;

  // L2: reverse every run at or above each level, highest first.
  const order = clusters.map((_, i) => i);
  const max = Math.max(base, ...levels);
  const minOdd = base % 2 ? base : base + 1;
  for (let lv = max; lv >= minOdd; lv--) {
    for (let i = 0; i < n; i++) {
      if (levels[order[i]!]! < lv) continue;
      let k = i;
      while (k < n && levels[order[k]!]! >= lv) k++;
      order.splice(i, k - i, ...order.slice(i, k).reverse());
      i = k - 1;
    }
  }

  return order.map((i) => {
    const c = clusters[i]!;
    const level = levels[i]!;
    return { ...c, level, cps: level % 2 ? c.cps.map(mirror) : c.cps };
  });
}

const OPENERS: Record<number, number> = { 0x28: 0x29, 0x5b: 0x5d, 0x7b: 0x7d };

/** BD16: matched bracket pairs, by opener position, over neutral brackets only. */
function bracketPairs(clusters: readonly Cluster[], t: readonly BidiType[]): [number, number][] {
  const stack: { close: number; at: number }[] = [];
  const pairs: [number, number][] = [];
  clusters.forEach((c, i) => {
    const cp = c.cps[0];
    if (t[i] !== "ON" || cp === undefined || c.cps.length !== 1) return;
    if (OPENERS[cp] !== undefined) {
      if (stack.length < 63) stack.push({ close: OPENERS[cp]!, at: i });
      return;
    }
    const k = stack.map((s) => s.close).lastIndexOf(cp);
    if (k < 0) return;
    pairs.push([stack[k]!.at, i]);
    stack.length = k;
  });
  return pairs.sort((a, b) => a[0] - b[0]);
}

const MIRROR: Record<number, number> = { 0x28: 0x29, 0x29: 0x28, 0x3c: 0x3e, 0x3e: 0x3c, 0x5b: 0x5d, 0x5d: 0x5b, 0x7b: 0x7d, 0x7d: 0x7b, 0xab: 0xbb, 0xbb: 0xab };

function mirror(cp: number): number {
  return MIRROR[cp] ?? cp;
}

/** Shape, then lay out: the visual clusters for one line of logical text. */
export function visualLine(s: string, fallback: 0 | 1 = 0): { base: 0 | 1; clusters: Placed[] } {
  const shaped = shape(s);
  const base = baseLevel(shaped, fallback);
  return { base, clusters: reorder(shaped, base) };
}

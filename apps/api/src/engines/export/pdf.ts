import type { ReportTable } from "@lyra/ledger";
import { promptInstant } from "@lyra/model-gateway";
import { HAS_ARABIC, isArabic, isMark, shapeable, visualLine } from "./arabic.js";
import { majorUnits, minorExponent } from "./money.js";
import { advance1000, arabicFace, fontObjects, utf16Hex } from "./pdf-font.js";
import { concat, utf8 } from "./zip.js";

// A PDF table renderer in one file. Same reason as the XLSX writer: no approved
// PDF dependency (docs/02 §9), and a report that only exists as a spreadsheet is
// no good to the person who has to attach it to a regulator submission.
//
// Latin is base-14 Helvetica, WinAnsi encoding, as it always was. Arabic is an
// embedded, per-document subset of Noto Naskh Arabic (ADR-0114, pdf-font.ts),
// shaped and reordered by arabic.ts — and only a string that contains Arabic
// takes that path, so a Latin document is byte for byte what it was before.
// Text neither font can draw (CJK, Hebrew, a Latin letter outside Latin-1) is
// still refused by `pdfSafe` rather than drawn as boxes.
//
// Typographic punctuation is the other half of that: business copy is full of
// en dashes and curly quotes ("Cash – Client Money" is a seeded account name),
// none of which are Latin-1, so a plain English report used to be refused over
// one dash. `transliterate` folds those to their exact ASCII equivalents at the
// single point every string passes through, so the refusal is left to mean what
// it says: text this font genuinely cannot draw.

export interface PdfOptions {
  meta?: Record<string, string>;
  totals?: Record<string, number>;
  /** Diagonal grey stamp on every page — used for unmasked PII exports. */
  watermark?: string;
  /** Right-hand footer text, e.g. the tenant name. */
  footer?: string;
  orientation?: "portrait" | "landscape";
  /**
   * "rtl" lays the page out from the right: title and meta flush right,
   * columns in reverse order, text cells flush right, the page number on the
   * right. Direction *within* a string is decided per string either way.
   */
  direction?: "ltr" | "rtl";
  /** The renderer's own words, for a document in another language. English by default. */
  labels?: PdfLabels;
}

export interface PdfLabels {
  generated?: string;
  continued?: string;
  total?: string;
  noData?: string;
  page?: (page: number, of: number) => string;
}

const PAGE = { portrait: { w: 595.28, h: 841.89 }, landscape: { w: 841.89, h: 595.28 } };
const MARGIN = 36;
const LINE = 14;
const FONT = { body: 9, header: 9, title: 16, meta: 8 };

/**
 * Per-document state for the Arabic face: the glyphs drawn (with the text each
 * stands for, for ToUnicode) and which way a string with no strong letter runs.
 * Module-level because `toPdf` is synchronous and every string goes through
 * `text`; it is set and cleared around exactly one document.
 */
let doc: { glyphs: Map<number, string>; base: 0 | 1 } | undefined;

export function toPdf(tables: readonly ReportTable[], opts: PdfOptions = {}): Uint8Array {
  const size = PAGE[opts.orientation ?? "landscape"];
  const pages: string[] = [];
  doc = { glyphs: new Map(), base: opts.direction === "rtl" ? 1 : 0 };
  try {
    for (const t of tables) {
      pages.push(...renderTable(t, opts, size));
    }
    if (!pages.length) {
      const none = opts.labels?.noData ?? "No data";
      pages.push(streamOf([text(lineX(none, FONT.body, opts, size), size.h - MARGIN, none, FONT.body, "F1")]));
    }

    return assemble(pages, size, opts);
  } finally {
    doc = undefined;
  }
}

/** Where a line of page furniture starts: the left margin, or flush right. */
function lineX(s: string, fontSize: number, opts: PdfOptions, size: { w: number }): number {
  return opts.direction === "rtl" ? size.w - MARGIN - textWidth(s, fontSize) : MARGIN;
}

/** Each column's left edge. LTR accumulates exactly as it always did. */
function columnLefts(widths: readonly number[], opts: PdfOptions, size: { w: number }): number[] {
  const out: number[] = [];
  if (opts.direction === "rtl") {
    let right = size.w - MARGIN;
    for (const w of widths) {
      right -= w;
      out.push(right);
    }
    return out;
  }
  let x = MARGIN;
  for (const w of widths) {
    out.push(x);
    x += w;
  }
  return out;
}

/** A cell's text origin: numbers flush to the far edge, text to the near one. */
function cellX(left: number, w: number, s: string, fontSize: number, numeric: boolean, rtl: boolean): number {
  if (rtl) return numeric ? left + 4 : left + w - 2 - textWidth(s, fontSize);
  return numeric ? left + w - 4 - textWidth(s, fontSize) : left + 2;
}

/* ------------------------------------------------------------------ layout */

function renderTable(t: ReportTable, opts: PdfOptions, size: { w: number; h: number }): string[] {
  const usable = size.w - MARGIN * 2;
  const widths = columnWidths(t, usable);
  const lefts = columnLefts(widths, opts, size);
  const rtl = opts.direction === "rtl";
  const words = opts.labels ?? {};
  const numeric = (kind: string): boolean => kind === "money" || kind === "number";
  const pages: string[] = [];

  let ops: string[] = [];
  let y = size.h - MARGIN;

  const startPage = (withTitle: boolean): void => {
    ops = [];
    y = size.h - MARGIN;
    if (opts.watermark) ops.push(watermark(opts.watermark, size));
    if (withTitle) {
      ops.push(text(lineX(t.title, FONT.title, opts, size), y, t.title, FONT.title, "F2"));
      y -= LINE + 8;
      const generated = `${words.generated ?? "Generated"} ${iso(t.generatedAt)}`;
      ops.push(text(lineX(generated, FONT.meta, opts, size), y, generated, FONT.meta, "F1", GREY));
      y -= LINE;
      for (const [k, v] of Object.entries(opts.meta ?? {})) {
        const line = `${k}: ${v}`;
        ops.push(text(lineX(line, FONT.meta, opts, size), y, line, FONT.meta, "F1", GREY));
        y -= LINE - 2;
      }
      y -= 6;
    } else {
      const continued = `${t.title} (${words.continued ?? "continued"})`;
      ops.push(text(lineX(continued, FONT.meta, opts, size), y, continued, FONT.meta, "F1", GREY));
      y -= LINE + 4;
    }
    ops.push(headerBand(t, widths, lefts, y, usable, rtl));
    y -= LINE + 4;
  };

  startPage(true);

  for (const row of t.rows) {
    if (y < MARGIN + LINE * 3) {
      pages.push(streamOf(ops));
      startPage(false);
    }
    t.columns.forEach((c, i) => {
      const s = format(row[c.key], c.kind, t.currency);
      ops.push(text(cellX(lefts[i]!, widths[i]!, s, FONT.body, numeric(c.kind), rtl), y, s, FONT.body, "F1"));
    });
    y -= LINE;
  }

  if (opts.totals && Object.keys(opts.totals).length) {
    if (y < MARGIN + LINE * 3) {
      pages.push(streamOf(ops));
      startPage(false);
    }
    ops.push(rule(MARGIN, y + LINE - 4, usable));
    t.columns.forEach((c, i) => {
      const v = opts.totals?.[c.key];
      const s = i === 0 ? (words.total ?? "Total") : v === undefined ? "" : format(v, c.kind, t.currency);
      ops.push(text(cellX(lefts[i]!, widths[i]!, s, FONT.body, numeric(c.kind), rtl), y, s, FONT.body, "F2"));
    });
    y -= LINE;
  }

  pages.push(streamOf(ops));
  return pages;
}

function headerBand(
  t: ReportTable,
  widths: readonly number[],
  lefts: readonly number[],
  y: number,
  usable: number,
  rtl: boolean
): string {
  const parts: string[] = [
    `q 0.118 0.106 0.294 rg ${MARGIN} ${(y - 3).toFixed(2)} ${usable.toFixed(2)} ${(LINE + 2).toFixed(2)} re f Q`
  ];
  t.columns.forEach((c, i) => {
    const w = widths[i]!;
    const label = clip(c.label, w - 4, FONT.header);
    const right = c.kind === "money" || c.kind === "number";
    parts.push(text(cellX(lefts[i]!, w, label, FONT.header, right, rtl), y + 2, label, FONT.header, "F2", WHITE));
  });
  return parts.join("\n");
}

function columnWidths(t: ReportTable, usable: number): number[] {
  // Width by the widest of label and a sample of values, then scaled to fit —
  // proportional beats equal columns when one column is an ID and one is a code.
  const raw = t.columns.map((c) => {
    const sample = t.rows.slice(0, 100).reduce((m, r) => Math.max(m, String(r[c.key] ?? "").length), c.label.length);
    return Math.min(Math.max(sample, 6), 40);
  });
  const total = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((r) => (r / total) * usable);
}

function format(v: unknown, kind: string, currency?: string): string {
  if (v === null || v === undefined) return "";
  if (kind === "money") {
    const dp = minorExponent(currency);
    const n = majorUnits(Number(v), currency);
    const s = n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
    return currency ? `${currency} ${s}` : s;
  }
  if (kind === "number") return Number(v).toLocaleString("en-US");
  if (kind === "date") return iso(Number(v));
  return String(v);
}

/* --------------------------------------------------------------- content */

const GREY = "0.42 0.45 0.50";
const WHITE = "1 1 1";

function text(x: number, y: number, value: string, size: number, font: string, colour = "0 0 0"): string {
  if (!HAS_ARABIC.test(value)) {
    return `BT ${colour} rg /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdf(value)}) Tj ET`;
  }
  // Glyphs are drawn in visual order, one text object, switching face per run:
  // Latin runs stay Helvetica, Arabic runs are glyph ids in the embedded face.
  // ActualText carries the logical string so copy, search and screen readers
  // get "مريم" rather than the reversed glyph sequence.
  const shown = faceRuns(value, true)
    .map((r) => (r.gids ? `/F3 ${size} Tf <${r.gids.map(hex4).join("")}> Tj` : `/${font} ${size} Tf (${escapePdf(r.text)}) Tj`))
    .join(" ");
  return (
    `/Span << /ActualText <FEFF${utf16Hex(value)}> >> BDC ` +
    `BT ${colour} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${shown} ET EMC`
  );
}

const hex4 = (n: number): string => n.toString(16).toUpperCase().padStart(4, "0");

/** A run of one face in visual order: Helvetica `text`, or embedded-face `gids`. */
interface FaceRun {
  text: string;
  gids?: number[];
}

/**
 * Shape and reorder `value`, then split it by face. A cluster goes to the
 * Arabic face when the face has every glyph it needs and it is Arabic, or a
 * space inside a right-to-left run; everything else stays Helvetica. With
 * `record`, the glyphs used are noted for the document's font subset.
 */
function faceRuns(value: string, record: boolean): FaceRun[] {
  const face = arabicFace();
  const { clusters } = visualLine(value, doc?.base ?? 0);
  const out: FaceRun[] = [];
  for (const c of clusters) {
    if (!c.cps.length) continue;
    const covered = c.cps.every((cp) => face.glyph(cp) !== 0);
    const arabic = covered && (c.cps.some(isArabic) || (c.type === "WS" && c.level % 2 === 1));
    const last = out[out.length - 1];
    if (!arabic) {
      const s = String.fromCodePoint(...c.cps);
      if (last && !last.gids) last.text += s;
      else out.push({ text: s });
      continue;
    }
    const gids = c.cps.map((cp) => face.glyph(cp));
    if (record && doc) {
      const base = [...c.src].filter((ch) => !isMark(ch.codePointAt(0)!)).join("") || String.fromCodePoint(c.cps[0]!);
      c.cps.forEach((cp, k) => {
        const g = gids[k]!;
        if (!doc!.glyphs.has(g)) doc!.glyphs.set(g, k === 0 ? base : String.fromCodePoint(cp));
      });
    }
    if (last?.gids) last.gids.push(...gids);
    else out.push({ text: "", gids });
  }
  return out;
}

function rule(x: number, y: number, w: number): string {
  return `q 0.61 0.64 0.69 RG 0.5 w ${x} ${y.toFixed(2)} m ${(x + w).toFixed(2)} ${y.toFixed(2)} l S Q`;
}

function watermark(label: string, size: { w: number; h: number }): string {
  const angle = 0.55; // ~32 degrees, in radians as cos/sin below
  const c = Math.cos(angle).toFixed(4);
  const s = Math.sin(angle).toFixed(4);
  return (
    `q 0.90 0.90 0.92 rg BT /F2 54 Tf ${c} ${s} -${s} ${c} ${(size.w * 0.12).toFixed(2)} ` +
    `${(size.h * 0.25).toFixed(2)} Tm (${escapePdf(label)}) Tj ET Q`
  );
}

function streamOf(ops: readonly string[]): string {
  return ops.join("\n");
}

/** Helvetica advance widths, in 1/1000 em, for the WinAnsi range we allow. */
const W = (() => {
  const t = new Array<number>(256).fill(556);
  const set = (chars: string, w: number): void => {
    for (const ch of chars) t[ch.charCodeAt(0)] = w;
  };
  set(" !\"'()*,-./:;[]{}|`", 278);
  set("ijltI", 222);
  set("0123456789", 556);
  set("fr", 333);
  set("ABCDEFGHJKLNOPQRSTUVXYZ", 667);
  set("MW", 833);
  set("mw", 833);
  set("abcdeghknopqsuvxyz", 556);
  return t;
})();

function textWidth(s: string, size: number): number {
  // Measured after folding, because folding is what gets drawn: an ellipsis is
  // one character to measure and three to print, and a right-aligned column
  // whose width was measured on the wrong string sits in the wrong place.
  if (!HAS_ARABIC.test(s)) return (latinUnits(s) / 1000) * size;
  // Measured on the shaped glyphs: a medial form and an isolated one differ.
  let total = 0;
  for (const r of faceRuns(s, false)) {
    total += r.gids ? r.gids.reduce((sum, g) => sum + advance1000(g), 0) : latinUnits(r.text);
  }
  return (total / 1000) * size;
}

function latinUnits(s: string): number {
  const t = transliterate(s);
  let total = 0;
  for (let i = 0; i < t.length; i++) total += W[t.charCodeAt(i) & 0xff]!;
  return total;
}

function clip(s: string, max: number, size: number): string {
  if (textWidth(s, size) <= max) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size) > max) out = out.slice(0, -1);
  return `${out}...`;
}

/**
 * Typographic characters with an *exact* ASCII equivalent, and the ASCII they
 * become. This is the Windows-1252-and-adjacent punctuation that word
 * processors, CRMs and pasted email produce by default, so it arrives in real
 * data constantly: an en dash in an account name, a curly apostrophe in a
 * counterparty, a non-breaking space in a pasted amount.
 *
 * The test is *exact*, never approximate. Punctuation, spacing and symbols fold,
 * because "–" and "-" are the same mark. Letters never fold: "Ÿ" -> "Y"
 * silently renames a person and "ش" -> "?" silently deletes one, so a
 * letter outside Latin-1 is left alone and refused by `pdfSafe` instead. An
 * export that is quietly wrong is worse than one that will not be written.
 */
const FOLD: Record<string, string> = {
  // Dashes, hyphens and the minus sign.
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  // Single quotes, primes and the modifier apostrophe.
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "ʼ": "'",
  // Double quotes and the double prime.
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
  // Single angle quotes. The double << >> are Latin-1 already and are kept.
  "‹": "<", "›": ">",
  "…": "...",
  "⁄": "/",
  "•": "*", "‣": "*",
  // Currency and marks that are Windows-1252 but not Latin-1.
  "€": "EUR", "™": "(TM)", "℠": "(SM)", "№": "No.",
  // Presentation ligatures — pasted out of PDFs, and exactly two letters each.
  "ﬁ": "fi", "ﬂ": "fl", "Œ": "OE", "œ": "oe",
  // Zero-width and bidi formatting marks carry no meaning in a printed cell.
  "\u200b": "", "\u200c": "", "\u200d": "", "\u200e": "", "\u200f": "", "\u2060": "", "\ufeff": "",
  "\u202a": "", "\u202b": "", "\u202c": "", "\u202d": "", "\u202e": ""
};

// Every key of FOLD, plus the spaces that are not U+0020 — no-break, the
// U+2000–U+200A quads, narrow, medium-mathematical and ideographic. Those carry
// no FOLD entry and take the default in `transliterate`: a plain space.
const FOLDABLE =
  /[\u00a0\u02bc\u0152\u0153\u2000-\u200f\u2010-\u2015\u2018-\u201f\u2022\u2023\u2026\u202a-\u202e\u202f\u2032\u2033\u2039\u203a\u2044\u205f\u2060\u20ac\u2116\u2120\u2122\u2212\u3000\ufb01\ufb02\ufeff]/gu;

/** Fold typographic punctuation to its ASCII equivalent. Everything else is untouched. */
export function transliterate(s: string): string {
  return s.replace(FOLDABLE, (ch) => FOLD[ch] ?? " ");
}

function escapePdf(s: string): string {
  // The content stream is UTF-8 encoded but the font is WinAnsi, so a literal
  // high byte would arrive as two and render as mojibake. Escaping everything
  // above ASCII as octal keeps the stream pure ASCII and lets the viewer decode
  // it against WinAnsi — which is how "Müller" stays "Müller".
  //
  // ponytail: anything still outside Latin-1 at this point was never in a table
  // (`pdfSafe` gates those) — it is a footer, watermark or meta value, which no
  // caller currently populates from tenant-supplied text. It becomes a visible
  // question mark. Widen `pdfSafe` to cover PdfOptions if one ever does.
  let out = "";
  for (const ch of transliterate(s)) {
    const code = ch.codePointAt(0)!;
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code < 32 || code > 255) out += "?";
    else if (code > 126) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return out;
}

/** True when every table can be rendered without substitution. */
export function pdfSafe(tables: readonly ReportTable[]): boolean {
  // Latin-1 is the whole of WinAnsiEncoding, drawn in Helvetica. Beyond it, only
  // Arabic the embedded face has a glyph for *and* the shaper can join
  // (ADR-0114); anything else — CJK, Hebrew, a Latin letter outside Latin-1, an
  // Arabic-script letter with no presentation form — would print as a box or
  // unjoined, so the caller is told to export xlsx instead. Tested on the
  // *folded* string so this and `escapePdf` agree on what is renderable: a gate
  // stricter than the renderer refuses exports that would have rendered fine,
  // which is what made "Cash – Client Money" a 400.
  const drawable = (cp: number): boolean =>
    cp <= 0xff || (isArabic(cp) && shapeable(cp) && arabicFace().glyph(cp) !== 0);
  return everyDrawnString(tables, (v) => {
    for (const ch of transliterate(v)) if (!drawable(ch.codePointAt(0)!)) return false;
    return true;
  });
}

/**
 * True when no drawn string needs the embedded Arabic face. render.ts uses it
 * to keep sending Arabic reports to a bound browser, which lays the whole table
 * out right to left; this writer is the fallback when none is bound.
 */
export function latinOnly(tables: readonly ReportTable[]): boolean {
  return everyDrawnString(tables, (v) => !HAS_ARABIC.test(v));
}

function everyDrawnString(tables: readonly ReportTable[], ok: (v: string) => boolean): boolean {
  return tables.every(
    (t) =>
      ok(t.title) &&
      t.columns.every((c) => ok(c.label)) &&
      // Only the values a column projects: report rows carry more fields than
      // they render (a chart-of-accounts row holds an Arabic `ar` name that no
      // column draws), and refusing over a field that never reaches the page is
      // the same false refusal in a different place.
      t.rows.every((r) =>
        t.columns.every((c) => {
          const v = r[c.key];
          return typeof v !== "string" || ok(v);
        })
      )
  );
}

/* --------------------------------------------------------------- assembly */

function assemble(pages: readonly string[], size: { w: number; h: number }, opts: PdfOptions): Uint8Array {
  const footer = opts.footer ?? "";
  const rtl = opts.direction === "rtl";
  const objects: (string | Uint8Array)[] = [];
  const push = (body: string | Uint8Array): number => objects.push(body);

  // 1 catalog, 2 pages, 3 F1, 4 F2 — then two objects per page, then (only if
  // a glyph of it was drawn) the five objects of the embedded Arabic face.
  push("<< /Type /Catalog /Pages 2 0 R >>");
  push(""); // placeholder, filled once the kids are known
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  // Footers are drawn before any font object is written: the tenant's name can
  // be Arabic, and the subset has to include its glyphs.
  const contents = pages.map((content, i) => {
    const label = opts.labels?.page ? opts.labels.page(i + 1, pages.length) : `Page ${i + 1} of ${pages.length}`;
    const y = MARGIN - 12;
    const far = (s: string): number => size.w - MARGIN - textWidth(s, FONT.meta);
    return (
      `${content}\n` +
      text(rtl ? far(label) : MARGIN, y, label, FONT.meta, "F1", GREY) +
      (footer ? `\n${text(rtl ? MARGIN : far(footer), y, footer, FONT.meta, "F1", GREY)}` : "")
    );
  });
  const glyphs = doc?.glyphs ?? new Map<number, string>();
  const arabicId = 4 + pages.length * 2 + 1;
  const arabicRef = glyphs.size ? ` /F3 ${arabicId} 0 R` : "";

  const kids: string[] = [];
  contents.forEach((withFooter) => {
    const streamId = push(`<< /Length ${utf8(withFooter).length} >>\nstream\n${withFooter}\nendstream`);
    const pageId = push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size.w.toFixed(2)} ${size.h.toFixed(2)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R${arabicRef} >> >> /Contents ${streamId} 0 R >>`
    );
    kids.push(`${pageId} 0 R`);
  });
  objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${kids.join(" ")}] >>`;
  if (glyphs.size) for (const o of fontObjects(objects.length + 1, glyphs)) push(o);

  const parts: Uint8Array[] = [utf8("%PDF-1.4\n%âãÏÓ\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(at);
    const bytes =
      typeof body === "string"
        ? utf8(`${i + 1} 0 obj\n${body}\nendobj\n`)
        : concat([utf8(`${i + 1} 0 obj\n`), body, utf8("\nendobj\n")]);
    parts.push(bytes);
    at += bytes.length;
  });

  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  parts.push(utf8(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`));

  return concat(parts);
}

/** Same guard, same reason as the XLSX writer's `iso`: `ms` comes off a stored row. */
function iso(ms: number): string {
  return promptInstant(ms).replace("T", " ").slice(0, 19);
}

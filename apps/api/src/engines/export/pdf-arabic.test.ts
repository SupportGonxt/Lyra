import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReportTable } from "@lyra/ledger";
import { pdfSafe, toPdf } from "./pdf.js";

// ADR-0114: the PDF writer embeds an Arabic font, so Arabic is drawn rather than
// refused. These read the file back the way a viewer does — the ToUnicode map
// turns drawn glyph ids into text — and check the text that comes out.

const NAME = "مريم الكعبي";

const table = (over: Partial<ReportTable> = {}): ReportTable => ({
  title: "Policy schedule",
  columns: [
    { key: "k", label: "Detail", kind: "text" },
    { key: "v", label: "Value", kind: "text" }
  ],
  rows: [
    { k: "Policy number", v: "POL-0001" },
    { k: "Insured", v: NAME }
  ],
  generatedAt: Date.parse("2026-06-15T00:00:00Z"),
  ...over
});

const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

/** `<gid> <utf16>` pairs out of the ToUnicode CMap. */
function toUnicode(pdf: string): Map<string, string> {
  const cmap = /begincmap([\s\S]*?)endcmap/.exec(pdf)?.[1];
  if (!cmap) throw new Error("no ToUnicode CMap");
  const out = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, gid, hex] of block[1]!.matchAll(/<([0-9A-F]{4})>\s*<([0-9A-F]+)>/g)) {
      const units = hex!.match(/.{4}/g)!.map((h) => parseInt(h, 16));
      out.set(gid!, String.fromCharCode(...units));
    }
  }
  return out;
}

/** Every string drawn in the embedded font, decoded glyph by glyph, in drawn order. */
function drawnArabic(pdf: string): string[][] {
  const map = toUnicode(pdf);
  const runs: string[][] = [];
  for (const m of pdf.matchAll(/\/F3 [\d.]+ Tf <([0-9A-F]*)> Tj/g)) {
    runs.push(m[1]!.match(/.{4}/g)!.map((gid) => map.get(gid) ?? "�"));
  }
  return runs;
}

/** ActualText spans, decoded from UTF-16BE hex. */
function actualTexts(pdf: string): string[] {
  return [...pdf.matchAll(/\/ActualText <FEFF([0-9A-F]*)>/g)].map((m) =>
    String.fromCharCode(...m[1]!.match(/.{4}/g)!.map((h) => parseInt(h, 16)))
  );
}

describe("pdf — Arabic text", () => {
  it("accepts Arabic now that the font covers it, and still refuses what it does not", () => {
    expect(pdfSafe([table()])).toBe(true);
    expect(pdfSafe([table({ title: "جدول الوثيقة" })])).toBe(true);
    expect(pdfSafe([table({ columns: [{ key: "k", label: "البيان", kind: "text" }] })])).toBe(true);
    // CJK and Hebrew are outside the embedded font.
    expect(pdfSafe([table({ rows: [{ k: "Insured", v: "王小明" }] })])).toBe(false);
    expect(pdfSafe([table({ rows: [{ k: "Insured", v: "שלום" }] })])).toBe(false);
    // A letter outside Latin-1 is still never approximated.
    expect(pdfSafe([table({ rows: [{ k: "Insured", v: "Ÿ" }] })])).toBe(false);
    // An Arabic-script letter the shaper cannot join is refused, not misprinted.
    expect(pdfSafe([table({ rows: [{ k: "Insured", v: "ڤ" }] })])).toBe(false);
  });

  it("embeds the font as a Type0/CIDFontType2 subset with a ToUnicode map", () => {
    const pdf = latin1(toPdf([table()]));
    expect(pdf).toContain("/Subtype /Type0");
    expect(pdf).toContain("/Encoding /Identity-H");
    expect(pdf).toContain("/Subtype /CIDFontType2");
    expect(pdf).toMatch(/\/CIDToGIDMap \d+ 0 R/);
    expect(pdf).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoNaskhArabic-Regular/);
    expect(pdf).toContain("/FontFile2");
    expect(pdf).toMatch(/\/ToUnicode \d+ 0 R/);
    expect(pdf).toContain("begincmap");
    // Every glyph drawn has a width: /W carries an entry for it.
    expect(pdf).toMatch(/\/W \[\d+ \[\d+/);
  });

  it("reads back as the customer's name, in logical order, through ToUnicode", () => {
    const pdf = latin1(toPdf([table()]));
    const runs = drawnArabic(pdf);
    expect(runs).toHaveLength(1);
    // Drawn left to right, so a viewer reverses the right-to-left run.
    expect([...runs[0]!].reverse().join("")).toBe(NAME);
    // And the span says so outright, for copy-paste and search.
    expect(actualTexts(pdf)).toContain(NAME);
  });

  it("maps a lam-alef ligature glyph back to both letters", () => {
    const pdf = latin1(toPdf([table({ rows: [{ k: "Insured", v: "سلام" }] })]));
    const [run] = drawnArabic(pdf);
    expect(run).toHaveLength(3);
    expect([...run!].reverse().join("")).toBe("سلام");
  });

  it("draws digits in Helvetica on the left of an Arabic word", () => {
    const pdf = latin1(toPdf([table({ rows: [{ k: "Address", v: "شارع 12" }] })]));
    // One text object: the number first (it is on the left), then the word.
    expect(pdf).toMatch(/\/F1 9 Tf \(12\) Tj \/F3 9 Tf <[0-9A-F]+> Tj/);
    expect(actualTexts(pdf)).toContain("شارع 12");
  });

  it("subsets: only drawn glyphs ship, so one name costs a few kilobytes, not the font", () => {
    const one = toPdf([table()]);
    expect(one.length).toBeLessThan(10_000);
  });

  it("is deterministic — the same table renders the same bytes", () => {
    const a = createHash("sha256").update(toPdf([table()])).digest("hex");
    const b = createHash("sha256").update(toPdf([table()])).digest("hex");
    expect(a).toBe(b);
  });

  it("lays a right-to-left document out from the right", () => {
    const pdf = latin1(toPdf([table({ title: "جدول الوثيقة" })], { direction: "rtl", orientation: "portrait" }));
    // The title is right-aligned: its text matrix starts well past mid-page.
    const tm = /1 0 0 1 ([\d.]+) [\d.]+ Tm \/F3 16 Tf/.exec(pdf);
    expect(tm).not.toBeNull();
    expect(Number(tm![1])).toBeGreaterThan(595.28 / 2);
  });

  it("prints caller-supplied page labels", () => {
    const pdf = latin1(
      toPdf([table()], { labels: { generated: "أُنشئ", page: (i, n) => `صفحة ${i} من ${n}`, total: "المجموع" } })
    );
    expect(actualTexts(pdf)).toContain("صفحة 1 من 1");
  });
});

describe("pdf — Latin output is unchanged by ADR-0114", () => {
  it("renders a Latin-only document byte for byte as before", () => {
    // Pinned from the writer as it stood before the Arabic font existed: a
    // Latin document must not grow a font object, change an object number or
    // move a byte.
    const t = {
      title: "Trial balance",
      columns: [
        { key: "name", label: "Name", kind: "text" },
        { key: "balanceMinor", label: "Balance", kind: "money" },
        { key: "at", label: "At", kind: "date" }
      ],
      rows: [
        { name: "Cash – Client Money", balanceMinor: 120_000_00, at: Date.parse("2026-06-15T00:00:00Z") },
        { name: "Müller & Frère (GmbH)", balanceMinor: -5_00, at: null }
      ],
      currency: "AED",
      generatedAt: Date.parse("2026-06-15T00:00:00Z")
    } as ReportTable;
    const out = toPdf([t, t], {
      meta: { Period: "2026-06", "Requested by": "user:u_1" },
      totals: { balanceMinor: 119_995_00 },
      watermark: "user:u_1 - 2026-06-15",
      footer: "GONXT Insurance",
      orientation: "portrait"
    });
    expect(out.length).toBe(3906);
    expect(createHash("sha256").update(out).digest("hex")).toBe(
      "ec17e09563b5460d5f5838a1d7525403c75628ebe7e724d898eb609dd398fb48"
    );
  });
});

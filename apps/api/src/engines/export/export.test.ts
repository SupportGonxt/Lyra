import { describe, expect, it } from "vitest";
import type { ReportTable } from "@lyra/ledger";
import { pdfSafe, toPdf, transliterate } from "./pdf.js";
import { toXlsx } from "./xlsx.js";
import { render, toCsv, type BrowserBinding } from "./render.js";
import { majorUnits, minorExponent } from "./money.js";

// The bug these cover: `pdfSafe` rejected anything outside Latin-1, and the
// seeded chart of accounts contains "Cash – Client Money" with an EN DASH, so a
// perfectly English ledger PDF came back 400. The fold now lives in pdf.ts,
// which is the one place both the ledger and analytics exports pass through.

const table = (over: Partial<ReportTable> = {}): ReportTable => ({
  title: "Trial balance",
  columns: [
    { key: "name", label: "Name", kind: "text" },
    { key: "balanceMinor", label: "Balance", kind: "money" }
  ],
  rows: [{ name: "Cash – Client Money", balanceMinor: 120_000_00 }],
  currency: "AED",
  generatedAt: Date.parse("2026-06-15T00:00:00Z"),
  ...over
});

/** The PDF content streams, decoded the way a viewer reads them: one byte, one character. */
const pdfText = (t: ReportTable): string => new TextDecoder("latin1").decode(toPdf([t]));

describe("pdf transliteration", () => {
  it("renders the seeded account name instead of refusing it", () => {
    const t = table();
    expect(pdfSafe([t])).toBe(true);

    const out = pdfText(t);
    expect(out.startsWith("%PDF")).toBe(true);
    expect(out).toContain("Cash - Client Money");
    expect(out).not.toContain("Cash ? Client Money");
  });

  it("round-trips every class of typographic character to its ASCII equivalent", () => {
    const cases: [string, string][] = [
      ["en dash", "a–b"],
      ["em dash", "a—b"],
      ["figure dash", "a‒b"],
      ["non-breaking hyphen", "a‑b"],
      ["minus sign", "a−b"],
      ["curly single quotes", "a‘b’c"],
      ["curly double quotes", "a“b”c"],
      ["low-9 quotes", "a‚b„c"],
      ["primes", "a′b″c"],
      ["single angle quotes", "a‹b›c"],
      ["ellipsis", "a…b"],
      ["fraction slash", "a⁄b"],
      ["bullets", "a•b‣c"],
      ["euro sign", "a€b"],
      ["trademark", "a™b"],
      ["numero", "a№b"],
      ["ligatures", "aﬁbﬂc"],
      ["oe ligature", "aŒbœc"],
      ["non-breaking space", "a b"],
      ["en quad and hair space", "a b c"],
      ["narrow and ideographic spaces", "a b　c"],
      ["zero-width and bidi marks", "a​b‎c‪d"]
    ];

    for (const [name, raw] of cases) {
      const folded = transliterate(raw);
      // Nothing survives the fold that the PDF font cannot draw...
      expect(folded, name).toMatch(/^[\x20-\x7e]*$/);
      // ...so the gate lets the row through...
      expect(pdfSafe([table({ rows: [{ name: raw, balanceMinor: 1 }] })]), name).toBe(true);
      // ...and what lands in the file is exactly what the fold produced, give
      // or take the backslashes PDF string literals need around brackets.
      const drawn = folded.replace(/[()\\]/g, "\\$&");
      expect(pdfText(table({ rows: [{ name: raw, balanceMinor: 1 }] })), name).toContain(drawn);
    }

    expect(transliterate("Cash – Client Money")).toBe("Cash - Client Money");
    expect(transliterate("“quoted”, he said…")).toBe('"quoted", he said...');
    expect(transliterate("Client’s premium €1")).toBe("Client's premium EUR1");
    // Zero-width marks are removed, not turned into spaces.
    expect(transliterate("a​b")).toBe("ab");
  });

  it("keeps Latin-1 letters rather than approximating or mangling them", () => {
    const t = table({ rows: [{ name: "Müller & Frère", balanceMinor: 1 }] });
    expect(pdfSafe([t])).toBe(true);
    // Written as octal escapes so a WinAnsi viewer decodes ü as ü and not as
    // the two UTF-8 bytes it would otherwise receive.
    expect(pdfText(t)).toContain("M\\374ller");
  });

  // This test said "still refuses Arabic" until ADR-0114 embedded an Arabic
  // face; the spec (a schedule for every customer) won, so Arabic is drawable
  // now and the refusal is pinned on scripts no embedded font covers.
  it("refuses text no embedded font can draw, and says what to do instead", () => {
    expect(pdfSafe([table({ rows: [{ name: "نقد", balanceMinor: 1 }] })])).toBe(true);
    expect(pdfSafe([table({ rows: [{ name: "現金", balanceMinor: 1 }] })])).toBe(false);
    expect(pdfSafe([table({ title: "報告" })])).toBe(false);
    expect(pdfSafe([table({ columns: [{ key: "name", label: "שם", kind: "text" }] })])).toBe(
      false
    );
    // Letters outside Latin-1 are never approximated: "Ÿ" must not become "Y".
    expect(transliterate("Ÿ")).toBe("Ÿ");
    expect(pdfSafe([table({ rows: [{ name: "Ÿ", balanceMinor: 1 }] })])).toBe(false);
  });

  it("ignores row fields no column renders", () => {
    // A chart-of-accounts row carries both names; the table draws only `en`.
    // Refusing over the Arabic one is the same false refusal in a new place.
    const t = table({ rows: [{ name: "Cash – Client Money", ar: "النقد", balanceMinor: 1 }] });
    expect(pdfSafe([t])).toBe(true);
    expect(pdfText(t)).toContain("Cash - Client Money");
  });
});

describe("money in the exports", () => {
  it("knows the currencies that do not have two minor digits", () => {
    expect(minorExponent("AED")).toBe(2);
    expect(minorExponent("jpy")).toBe(0);
    expect(minorExponent("KWD")).toBe(3);
    expect(minorExponent(undefined)).toBe(2);
    expect(minorExponent("ZZZ")).toBe(2);
    expect(majorUnits(120_000_00, "AED")).toBe(120_000);
    expect(majorUnits(120_000, "JPY")).toBe(120_000);
    expect(majorUnits(1_234_567, "KWD")).toBeCloseTo(1234.567, 6);
  });

  it("writes CSV money in major units, matching the spreadsheet", () => {
    // The same figure used to leave as 12000000 here and 120,000.00 in XLSX.
    const csv = toCsv(table());
    expect(csv).toContain("Cash – Client Money,120000.00");
    expect(csv).not.toContain("12000000");
    expect(new TextDecoder().decode(toXlsx([table()]))).toContain("<v>120000</v>");
  });

  it("uses each currency's own exponent in CSV and XLSX", () => {
    const jpy = table({ currency: "JPY", rows: [{ name: "Cash", balanceMinor: 120_000 }] });
    expect(toCsv(jpy)).toContain("Cash,120000");
    expect(new TextDecoder().decode(toXlsx([jpy]))).toContain(`formatCode="&quot;JPY &quot;#,##0"`);

    const kwd = table({ currency: "KWD", rows: [{ name: "Cash", balanceMinor: 1_234_567 }] });
    expect(toCsv(kwd)).toContain("Cash,1234.567");
    expect(new TextDecoder().decode(toXlsx([kwd]))).toContain(`formatCode="&quot;KWD &quot;#,##0.000"`);
  });

  it("does not stamp one currency's code on a multi-currency report", () => {
    const mixed: ReportTable = {
      title: "Commission",
      columns: [
        { key: "currency", label: "Currency", kind: "text" },
        { key: "grossMinor", label: "Gross", kind: "money" }
      ],
      rows: [
        { currency: "AED", grossMinor: 100_00 },
        { currency: "JPY", grossMinor: 100 }
      ],
      generatedAt: 0
    };
    const xml = new TextDecoder().decode(toXlsx([mixed]));
    expect(xml).toContain(`formatCode="#,##0.00"`);
    expect(xml).not.toContain("AED &quot;");
    // Each row is still divided by its own currency's exponent.
    expect(xml).toContain("<v>100</v>");
    expect(toCsv(mixed)).toContain("JPY,100");
  });

  it("leaves non-numeric money cells alone rather than writing NaN", () => {
    const odd = table({ rows: [{ name: "Cash", balanceMinor: null }, { name: "Cash", balanceMinor: "n/a" }] });
    expect(toCsv(odd)).not.toContain("NaN");
    expect(toCsv(odd)).toContain("Cash,n/a");
  });

  it("keeps the UTF-8 BOM and Arabic intact in the spreadsheet and the CSV", () => {
    const t = table({ rows: [{ name: "نقد", balanceMinor: 1_00 }] });
    expect(toCsv(t).charCodeAt(0)).toBe(0xfeff);
    expect(toCsv(t)).toContain("نقد");
    expect(new TextDecoder().decode(toXlsx([t]))).toContain("نقد");
  });
});

describe("render() pdf fallback for Arabic", () => {
  const arabicTable = table({ rows: [{ name: "نقد", balanceMinor: 1_00 }] });

  it("draws Arabic in-process when no browser binding is available (ADR-0114)", async () => {
    const out = await render("pdf", arabicTable, {});
    expect(out.contentType).toBe("application/pdf");
    expect(new TextDecoder("latin1").decode(out.bytes)).toContain("/Subtype /Type0");
  });

  it("throws when the report has a script no PDF font covers and no browser binding", async () => {
    const cjk = table({ rows: [{ name: "現金", balanceMinor: 1_00 }] });
    await expect(render("pdf", cjk, {})).rejects.toMatchObject({ detail: expect.stringMatching(/non-Latin/) });
  });

  it("renders via the browser binding instead of throwing when one is bound", async () => {
    const fakePdfBytes = new TextEncoder().encode("%PDF-fake");
    let sawHtml = "";
    const browser: BrowserBinding = {
      async fetch(req) {
        const body = JSON.parse(await req.text()) as { html: string };
        sawHtml = body.html;
        return new Response(fakePdfBytes, { status: 200 });
      }
    };

    const out = await render("pdf", arabicTable, {}, browser);
    expect(out.contentType).toBe("application/pdf");
    expect(new TextDecoder().decode(out.bytes)).toBe("%PDF-fake");
    // The HTML sent to the browser carries the Arabic text and is marked RTL.
    expect(sawHtml).toContain('dir="rtl"');
    expect(sawHtml).toContain("نقد");
  });

  it("still renders Latin-1 reports directly, without calling the browser", async () => {
    const browser: BrowserBinding = {
      fetch: async () => {
        throw new Error("should not be called for a Latin-1 report");
      }
    };
    const out = await render("pdf", table(), {}, browser);
    expect(out.contentType).toBe("application/pdf");
    expect(new TextDecoder("latin1").decode(out.bytes).startsWith("%PDF")).toBe(true);
  });
});

/**
 * `north_decisions.review_at` is a nullable stored instant on a read-write
 * resource, and it is the one `kind: "date"` column in the board-pack tree. A
 * row written before the API bounded its write surfaces can hold 9e15, which no
 * `Date` can. `new Date(9e15).toISOString()` throws `RangeError`, and all three
 * renderers called it — so one such row meant a 500 and no board pack at all,
 * rather than one unreadable cell.
 */
describe("a date column holding an instant no Date can hold", () => {
  const dated = (v: unknown): ReportTable => ({
    title: "Open decisions",
    columns: [
      { key: "title", label: "Decision", kind: "text" },
      { key: "reviewAt", label: "Review by", kind: "date" }
    ],
    rows: [{ title: "Renew the binder", reviewAt: v }],
    generatedAt: Date.parse("2026-06-15T00:00:00Z")
  });

  it("renders the degraded marker in the PDF instead of throwing", () => {
    const out = pdfText(dated(9e15));
    expect(out.startsWith("%PDF")).toBe(true);
    expect(out).toContain("unknown");
  });

  it("renders the degraded marker in the spreadsheet instead of throwing", () => {
    const xml = new TextDecoder().decode(toXlsx([dated(9e15)]));
    expect(xml).toContain("unknown");
  });

  it("renders the degraded marker in the HTML the browser prints", async () => {
    let sawHtml = "";
    const browser: BrowserBinding = {
      async fetch(req) {
        sawHtml = (JSON.parse(await req.text()) as { html: string }).html;
        return new Response(new TextEncoder().encode("%PDF-fake"), { status: 200 });
      }
    };
    // Arabic in the title forces the browser path, which is the one `cellText` feeds.
    await render("pdf", { ...dated(9e15), title: "نقد" }, {}, browser);
    expect(sawHtml).toContain("unknown");
  });

  it("still renders a date a Date can hold", () => {
    const at = Date.parse("2026-06-15T09:30:00Z");
    expect(pdfText(dated(at))).toContain("2026-06-15");
    expect(new TextDecoder().decode(toXlsx([dated(at)]))).toContain("2026-06-15");
  });

  // `generatedAt` is the table's own stamp, not a cell: routes/ledger.ts reads
  // `?asOf=` off the query string and reports.ts carries it straight into
  // `generatedAt`, so the header line is fed by caller input. The three cell
  // renderers were guarded and this one was not, and it sits in the RTL path —
  // the browser HTML — which is where an Arabic tenant's every export goes.
  it("renders the degraded marker in the generated-at header, not a RangeError", async () => {
    let sawHtml = "";
    const browser: BrowserBinding = {
      async fetch(req) {
        sawHtml = (JSON.parse(await req.text()) as { html: string }).html;
        return new Response(new TextEncoder().encode("%PDF-fake"), { status: 200 });
      }
    };
    await render("pdf", { ...dated(Date.parse("2026-06-15T09:30:00Z")), title: "نقد", generatedAt: 9e15 }, {}, browser);
    expect(sawHtml).toContain("Generated unknown");
  });
});

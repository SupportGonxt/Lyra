import { badRequest } from "@lyra/core";
import type { ReportTable } from "@lyra/ledger";
import { isoDay, promptInstant } from "@lyra/model-gateway";
import { majorUnits, minorExponent, rowCurrency } from "./money.js";
import { toXlsx } from "./xlsx.js";
import { latinOnly, pdfSafe, toPdf } from "./pdf.js";

// One table in, one file out. Lifted verbatim out of routes/analytics.ts so the
// ledger's finance reports serialise through the same writer as every analytics
// export — two renderers for the same money is two sets of rounding to explain.

export interface Rendered {
  bytes: Uint8Array;
  contentType: string;
}

export interface RenderOptions {
  totals?: Record<string, number>;
  watermark?: string;
  orientation?: "portrait" | "landscape";
  meta?: Record<string, string>;
}

/** docs/02 §9 / docs/11 §3: Cloudflare Browser Rendering's REST-API shape (a
 * `Fetcher`), so on-prem's `render` HTTP service can implement the same
 * contract with no code branch here. */
export interface BrowserBinding {
  fetch(req: Request): Promise<Response>;
}

export type ExportFormat = "xlsx" | "pdf" | "csv" | "json";

export const EXPORT_FORMATS: readonly ExportFormat[] = ["xlsx", "pdf", "csv", "json"];

export function isExportFormat(value: string): value is ExportFormat {
  return (EXPORT_FORMATS as readonly string[]).includes(value);
}

/**
 * `browser` is optional and only ever needed for the pdf/non-Latin case: every
 * other format renders the same with or without it. Unbound (on-prem with no
 * `render` service configured yet), Arabic is drawn in-process (ADR-0115) and
 * only a script no PDF font covers is told to export xlsx instead — same
 * no-op-when-unbound idiom as `wf`/`bucket` elsewhere.
 */
export async function render(
  format: ExportFormat,
  table: ReportTable & { rowCount?: number },
  opts: RenderOptions,
  browser?: BrowserBinding
): Promise<Rendered> {
  switch (format) {
    case "xlsx":
      return {
        bytes: toXlsx([table], opts),
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      };
    case "pdf": {
      // Where a browser binding is available it still takes every non-Latin
      // report: a real browser has every script's font, full shaping and mark
      // positioning, and lays the whole table out right to left. Unbound, the
      // in-process writer draws Arabic itself with its embedded face
      // (ADR-0115); only text neither can draw sends the caller to XLSX.
      if (browser && (!latinOnly([table]) || !pdfSafe([table]))) {
        return { bytes: await renderPdfViaBrowser(browser, table, opts), contentType: "application/pdf" };
      }
      if (!pdfSafe([table])) {
        throw badRequest("this report contains non-Latin text the PDF fonts cannot render; export it as xlsx");
      }
      return { bytes: toPdf([table], opts), contentType: "application/pdf" };
    }
    case "csv":
      return { bytes: new TextEncoder().encode(toCsv(table)), contentType: "text/csv; charset=utf-8" };
    default:
      // JSON is the machine-readable format and keeps money in minor units —
      // the same integers the API and the ledger use, with `kind: "money"` on
      // the column to say so. CSV does not, because CSV is opened in a
      // spreadsheet, not parsed. See `toCsv`.
      return {
        bytes: new TextEncoder().encode(JSON.stringify({ ...table, totals: opts.totals }, null, 2)),
        contentType: "application/json"
      };
  }
}

/** Arabic block + supplement + presentation forms — the script base-14 Helvetica cannot draw. */
const RTL_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

function isRtl(table: ReportTable): boolean {
  return (
    RTL_RE.test(table.title) ||
    table.columns.some((c) => RTL_RE.test(c.label)) ||
    table.rows.some((r) => table.columns.some((c) => typeof r[c.key] === "string" && RTL_RE.test(r[c.key] as string)))
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cellText(v: unknown, kind: ReportTable["columns"][number]["kind"], row: Record<string, unknown>, table: ReportTable): string {
  if (v === null || v === undefined) return "";
  if (kind === "money") {
    const currency = rowCurrency(row, table);
    return `${currency} ${majorUnits(Number(v), currency).toLocaleString("en-US", { minimumFractionDigits: minorExponent(currency), maximumFractionDigits: minorExponent(currency) })}`;
  }
  if (kind === "number") return Number(v).toLocaleString("en-US");
  // `isoDay`, not `new Date(...).toISOString()`: `v` comes off a stored row, and
  // a row written before the API bounded its write surfaces can hold an instant
  // no `Date` can. The throw costs the whole document, not this one cell.
  if (kind === "date") return isoDay(Number(v));
  return String(v);
}

/** Builds the HTML page a real browser prints to PDF — RTL-aware (CLAUDE.md rule 7: logical properties, not left/right). */
function tableHtml(table: ReportTable & { rowCount?: number }, opts: RenderOptions): string {
  const dir = isRtl(table) ? "rtl" : "ltr";
  const head = table.columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("");
  const rows = table.rows
    .map(
      (r) =>
        `<tr>${table.columns.map((c) => `<td class="${c.kind === "money" || c.kind === "number" ? "num" : ""}">${escapeHtml(cellText(r[c.key], c.kind, r, table))}</td>`).join("")}</tr>`
    )
    .join("");
  const totalsRow =
    opts.totals && Object.keys(opts.totals).length
      ? `<tr class="totals">${table.columns
          .map((c, i) => (i === 0 ? "<td>Total</td>" : `<td class="num">${opts.totals?.[c.key] !== undefined ? escapeHtml(cellText(opts.totals[c.key], c.kind, opts.totals as Record<string, unknown>, table)) : ""}</td>`))
          .join("")}</tr>`
      : "";
  const meta = Object.entries(opts.meta ?? {})
    .map(([k, v]) => `<div class="meta">${escapeHtml(k)}: ${escapeHtml(v)}</div>`)
    .join("");
  return `<!doctype html><html dir="${dir}"><head><meta charset="utf-8"><style>
    body { font-family: "Noto Sans Arabic", "Noto Sans", Arial, sans-serif; font-size: 11px; margin: 24px; }
    h1 { font-size: 18px; }
    .meta, .generated { color: #6b7280; font-size: 10px; }
    ${opts.watermark ? ".watermark { position: fixed; inset-inline-start: 15%; top: 35%; font-size: 64px; color: #e8e8ec; transform: rotate(-28deg); z-index: -1; }" : ""}
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th { background: #1e1b4b; color: #fff; text-align: start; padding: 4px 6px; }
    td { padding: 3px 6px; border-block-end: 1px solid #e5e7eb; }
    td.num, th.num { text-align: end; }
    tr.totals td { font-weight: bold; border-block-start: 1px solid #9ca3af; }
  </style></head><body>
    ${opts.watermark ? `<div class="watermark">${escapeHtml(opts.watermark)}</div>` : ""}
    <h1>${escapeHtml(table.title)}</h1>
    <div class="generated">Generated ${promptInstant(table.generatedAt).replace("T", " ").slice(0, 19)}</div>
    ${meta}
    <table><thead><tr>${head}</tr></thead><tbody>${rows}${totalsRow}</tbody></table>
  </body></html>`;
}

async function renderPdfViaBrowser(browser: BrowserBinding, table: ReportTable & { rowCount?: number }, opts: RenderOptions): Promise<Uint8Array> {
  const res = await browser.fetch(
    new Request("https://browser-rendering/v1/pdf", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        html: tableHtml(table, opts),
        pdfOptions: { landscape: (opts.orientation ?? "landscape") === "landscape", printBackground: true }
      })
    })
  );
  if (!res.ok) throw badRequest("browser-rendered PDF export failed");
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Money is written in major units, matching the XLSX and the PDF. CSV looks
 * machine-readable, but this one is not: it opens on a UTF-8 BOM specifically so
 * Excel takes it, which says who actually reads it. The same trial balance
 * arriving as `12000000` in CSV and `120,000.00` in XLSX is how a controller
 * reconciles a figure a hundred times too large, and neither number is labelled.
 * Anything that wants the raw integers asks for JSON, which keeps them.
 *
 * Written as a plain decimal — no separators, no currency symbol — so it still
 * parses as a number. The currency stays in its own column or in the header.
 */
export function toCsv(table: ReportTable): string {
  const esc = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const value = (c: ReportTable["columns"][number], r: Record<string, unknown>): string => {
    const v = r[c.key];
    if (c.kind !== "money" || v === null || v === undefined || v === "") return esc(v);
    const n = Number(v);
    if (!Number.isFinite(n)) return esc(v);
    const currency = rowCurrency(r, table);
    return majorUnits(n, currency).toFixed(minorExponent(currency));
  };
  const head = table.columns.map((c) => esc(c.label)).join(",");
  const rows = table.rows.map((r) => table.columns.map((c) => value(c, r)).join(","));
  // A leading BOM so Excel opens UTF-8 CSV without mangling Arabic.
  // eslint-disable-next-line no-irregular-whitespace
  return `﻿${[head, ...rows].join("\r\n")}\r\n`;
}

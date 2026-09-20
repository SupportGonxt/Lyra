import { badRequest } from "@lyra/core";
import type { StatementLine } from "./recon.js";

// docs/27 F16 / docs/19 §6. Bank and processor statement import: CAMT.053
// (ISO 20022 XML), MT940 (SWIFT text) and OFX (SGML). Before this the only way
// into the reconciliation engine was hand-pasted JSON, which is not an import.
//
// Three rules the whole module obeys.
//
// **A parser is a translation, not a policy.** Every format lands on the same
// `StatementLine[]` that `reconcile()` already takes; nothing here decides what
// matches, and the matching engine is untouched.
//
// **Money is parsed as text.** `Number("1250.50") * 100` is 125049.99999999999
// on some inputs, and a one-fil variance nobody can explain is exactly what a
// reconciliation exists to surface rather than to create. The decimal string is
// split on its point and the fraction is read as digits.
//
// **Silence is never an answer.** A file nobody can read, an entry with no
// amount, a statement with no lines: each is a refusal naming what is wrong. A
// parser that returned an empty array would read, to the controller, as "the
// bank sent an empty statement", which is the one thing it certainly did not do.
//
// No XML library: Workers has no DOMParser and docs/02 §9 governs dependencies.
// These formats are flat and regular enough that a tag scanner is the boring
// choice, and a regex over a known element name is what the format guarantees.

export const STATEMENT_FORMATS = ["camt053", "mt940", "ofx"] as const;
export type StatementFormat = (typeof STATEMENT_FORMATS)[number];

export interface ParsedStatement {
  format: StatementFormat;
  /** The account the statement is for: IBAN, account number, whatever it states. */
  accountRef: string | null;
  /** The statement's own currency, when it states one at the header level. */
  currency: string | null;
  lines: StatementLine[];
}

/* -------------------------------------------------------------- detection */

/**
 * By content, never by filename. A `.txt` from a bank is as likely to be MT940
 * as anything else, and an uploader who renames a file should not thereby
 * change how it is read.
 */
export function detectStatementFormat(text: string): StatementFormat | null {
  const head = text.slice(0, 4_000);
  if (/camt\.053|<BkToCstmrStmt\b/i.test(head)) return "camt053";
  if (/OFXHEADER|<OFX\b|<STMTTRN\b/i.test(head)) return "ofx";
  // :20: is the transaction reference, mandatory and first, in every MT940.
  if (/^:20:/m.test(head) && /^:61:/m.test(text)) return "mt940";
  return null;
}

export function parseStatement(text: string): ParsedStatement {
  const format = detectStatementFormat(text);
  if (!format) {
    throw badRequest(
      `this file is not a statement in any format we read (${STATEMENT_FORMATS.join(", ")})`
    );
  }
  const parsed =
    format === "camt053" ? parseCamt053(text) : format === "mt940" ? parseMt940(text) : parseOfx(text);
  if (!parsed.lines.length) throw badRequest(`the ${format} statement has no lines`);
  return parsed;
}

/* ------------------------------------------------------------ money as text */

/**
 * "1250.50" -> 125050, "1250,50" -> 125050, "0.01" -> 1, "1250.500" -> 1250500.
 *
 * The scale is the file's, not ours: a three-decimal currency (KWD, BHD, OMR)
 * states three, and rounding it to two would silently divide a Kuwaiti dinar
 * statement by ten. The minor unit belongs to the currency.
 */
export function decimalToMinor(raw: string, what: string): number {
  const cleaned = raw.trim().replace(/\s/g, "").replace(",", ".");
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!m) throw badRequest(`${what} is not an amount: "${raw}"`);
  const [, sign = "", whole = "0", frac = ""] = m;
  const minor = Number(whole) * 10 ** frac.length + Number(frac || "0");
  if (!Number.isSafeInteger(minor)) throw badRequest(`${what} is outside safe integer range: "${raw}"`);
  return sign === "-" ? -minor : minor;
}

/** A tag's text content, first occurrence, attributes ignored. */
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i").exec(xml);
  return m?.[1]?.trim() ?? null;
}

function blocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "gi");
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? "");
  return out;
}

/* ------------------------------------------------------------- CAMT.053 */

function parseCamt053(xml: string): ParsedStatement {
  const stmt = blocks(xml, "Stmt")[0] ?? xml;
  const accountRef = tag(stmt, "IBAN") ?? tag(stmt, "Othr") ?? null;
  const lines: StatementLine[] = [];
  let currency: string | null = null;

  for (const [i, entry] of blocks(stmt, "Ntry").entries()) {
    const amt = /<(?:\w+:)?Amt\b[^>]*Ccy="([A-Z]{3})"[^>]*>([\s\S]*?)<\/(?:\w+:)?Amt>/i.exec(entry);
    if (!amt) throw badRequest(`CAMT.053 entry ${i + 1} has no amount`);
    const ccy = amt[1] ?? "";
    const minor = decimalToMinor(amt[2] ?? "", `CAMT.053 entry ${i + 1} amount`);
    // CdtDbtInd carries the sign; the amount element never does.
    const credit = (tag(entry, "CdtDbtInd") ?? "CRDT").toUpperCase() === "CRDT";
    const bookedRaw = tag(blocks(entry, "BookgDt")[0] ?? "", "Dt") ?? tag(blocks(entry, "ValDt")[0] ?? "", "Dt");
    const ustrd = tag(entry, "Ustrd");
    const endToEnd = tag(entry, "EndToEndId");
    currency ??= ccy;
    lines.push({
      ref: tag(entry, "NtryRef") ?? tag(entry, "AcctSvcrRef") ?? `entry-${i + 1}`,
      amountMinor: credit ? minor : -minor,
      currency: ccy,
      ...(endToEnd && endToEnd !== "NOTPROVIDED" ? { ourRef: endToEnd } : {}),
      ...(bookedRaw ? { postedAt: isoDay(bookedRaw) } : {}),
      ...(ustrd ? { description: ustrd } : {})
    });
  }
  return { format: "camt053", accountRef, currency, lines };
}

/** "2026-06-03" (or a full ISO instant) as UTC midnight. */
function isoDay(raw: string): number {
  const at = Date.parse(raw.length === 10 ? `${raw}T00:00:00Z` : raw);
  if (!Number.isFinite(at)) throw badRequest(`not a date: "${raw}"`);
  return at;
}

/* ---------------------------------------------------------------- MT940 */

/**
 * `:61:` is one statement line, and its layout is positional:
 * `YYMMDD` value date, optional `MMDD` entry date, `C`/`D`/`RC`/`RD`, amount
 * with a comma decimal, a four-character transaction type, the customer
 * reference, then `//` and the bank's own reference. `:86:` after it is free
 * text about the line above.
 */
function parseMt940(text: string): ParsedStatement {
  const accountRef = /^:25:(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  const currency = /^:60[FM]:[CD]\d{6}([A-Z]{3})/m.exec(text)?.[1] ?? null;
  const lines: StatementLine[] = [];

  // Split on the field tags rather than on newlines: an MT940 line may wrap.
  const fields = text.split(/\r?\n(?=:\d{2}[A-Z]?:)/);
  for (const [i, field] of fields.entries()) {
    const trimmed = field.trim();
    if (!trimmed.startsWith(":61:")) continue;
    const m = /^:61:(\d{6})(\d{4})?(RC|RD|C|D)([\d.,]+)([A-Z][A-Z0-9]{3})([^\n]*)/.exec(trimmed);
    // A `:61:` this cannot read is a line the bank sent and we cannot account
    // for. Skipping it would quietly shorten the statement, which reconciles
    // beautifully and means nothing.
    if (!m) {
      throw badRequest(
        `MT940 line ${lines.length + 1} is not a statement line we can read (amount or indicator malformed): "${trimmed.slice(0, 80)}"`
      );
    }
    const [, valueDate = "", , indicator = "C", amountRaw = "", , rest = ""] = m;
    const minor = decimalToMinor(amountRaw, `MT940 line ${lines.length + 1} amount`);
    // RC reverses a credit and RD reverses a debit, so both flip.
    const credit = indicator === "C" || indicator === "RD";
    const [customerRef = "", bankRef = ""] = rest.split("//");
    const info = fields[i + 1]?.startsWith(":86:") ? fields[i + 1]?.slice(4).replace(/\r?\n/g, " ").trim() : undefined;
    lines.push({
      ref: (bankRef.trim() || customerRef.trim() || `line-${lines.length + 1}`).trim(),
      amountMinor: credit ? minor : -minor,
      currency: currency ?? "XXX",
      ...(customerRef.trim() ? { ourRef: customerRef.trim() } : {}),
      postedAt: yymmdd(valueDate),
      ...(info ? { description: info } : {})
    });
  }
  return { format: "mt940", accountRef, currency, lines };
}

/**
 * MT940 states a two-digit year. The SWIFT convention — and the only one that
 * does not put a 2026 statement in 1926 — is that it belongs to this century.
 */
function yymmdd(raw: string): number {
  const yy = Number(raw.slice(0, 2));
  const mm = Number(raw.slice(2, 4));
  const dd = Number(raw.slice(4, 6));
  if (!mm || mm > 12 || !dd || dd > 31) throw badRequest(`not an MT940 date: "${raw}"`);
  return Date.UTC(2000 + yy, mm - 1, dd);
}

/* ------------------------------------------------------------------ OFX */

/**
 * OFX 1.x is SGML: tags are frequently unclosed, so a value runs to the next
 * `<`. OFX 2.x is well-formed XML and the same scan reads it, because a closing
 * tag simply terminates the value earlier.
 */
function ofxValue(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([^<\\r\\n]*)`, "i").exec(block);
  return m?.[1]?.trim() || null;
}

/**
 * Splits the transaction blocks by scanning literal markers rather than a
 * regex: the equivalent pattern (a lazy `[\s\S]*?` closed off by an
 * alternation of a close tag, a lookahead for the next open tag, or a
 * lookahead for the list's end) is the classic catastrophic-backtracking
 * shape CodeQL flags — a run of unclosed `<STMTTRN>` tags gives the engine
 * exponentially many ways to place the lazy match before it fails. A plain
 * `indexOf` scan is O(n) and reads the same three terminators (closing tag,
 * next block, end of list), whichever comes first.
 */
function ofxTransactionBlocks(text: string): string[] {
  const OPEN = "<STMTTRN>";
  const CLOSE = "</STMTTRN>";
  const LIST_END = "</BANKTRANLIST>";
  const blocks: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(OPEN, searchFrom);
    if (start === -1) break;
    const contentStart = start + OPEN.length;
    const stops = [text.indexOf(CLOSE, contentStart), text.indexOf(OPEN, contentStart), text.indexOf(LIST_END, contentStart)].filter(
      (i) => i !== -1
    );
    const stop = stops.length ? Math.min(...stops) : text.length;
    blocks.push(text.slice(contentStart, stop));
    searchFrom = stop;
  }
  return blocks;
}

function parseOfx(text: string): ParsedStatement {
  const currency = ofxValue(text, "CURDEF");
  const accountRef = ofxValue(text, "ACCTID");
  const lines: StatementLine[] = [];

  for (const [i, block] of ofxTransactionBlocks(text).entries()) {
    const raw = ofxValue(block, "TRNAMT");
    if (!raw) throw badRequest(`OFX transaction ${i + 1} has no amount`);
    // OFX carries the sign on the amount itself, which is why there is no
    // indicator to read here and no sign to apply.
    const minor = decimalToMinor(raw, `OFX transaction ${i + 1} amount`);
    const posted = ofxValue(block, "DTPOSTED");
    const memo = ofxValue(block, "MEMO");
    const name = ofxValue(block, "NAME");
    const description = [name, memo].filter(Boolean).join(" — ") || undefined;
    lines.push({
      ref: ofxValue(block, "FITID") ?? `txn-${i + 1}`,
      amountMinor: minor,
      currency: currency ?? "XXX",
      ...(posted ? { postedAt: ofxDate(posted) } : {}),
      ...(description ? { description } : {}),
      // OFX has no dedicated counterparty-reference field, so anything that
      // looks like our own reference has to come out of the free text. A
      // reference we invented has a shape; a bank's narrative does not.
      ...(refFromText(description) ? { ourRef: refFromText(description) as string } : {})
    });
  }
  return { format: "ofx", accountRef, currency, lines };
}

/** `YYYYMMDD` with an optional `HHMMSS` and an optional `[±h:TZ]` suffix. */
function ofxDate(raw: string): number {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  if (!m) throw badRequest(`not an OFX date: "${raw}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/**
 * An upper-case token with a hyphen and a digit: POL-88431, INV-2026-4.
 *
 * The two `[A-Z0-9-]*` groups either side of the required `\d` overlap the
 * same character class, so on a non-matching tail the engine can place the
 * split point between them in exponentially many ways before giving up —
 * the CodeQL-flagged shape. One greedy group plus a separate digit check
 * removes the ambiguity without changing which strings match: a token still
 * has to start `[A-Z]{2,6}-` and contain a digit somewhere in the rest.
 */
function refFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /\b[A-Z]{2,6}-[A-Z0-9-]+\b/.exec(text)?.[0];
  return m && /\d/.test(m) ? m : undefined;
}

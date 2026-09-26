import { isSignalSourceKind, type HarvestedSignal } from "@lyra/core";
import { parseCsv, type RowError } from "./axis-case-import.js";
import { HARVEST_MAX_PER_SOURCE } from "./scout-ingest.js";

// @accept:SA. SCOUT's own signals from a file. What a line means is decided
// here; storing it is the harvest path's job (dedupe by source and reference,
// embed where a Vectorize binding exists), so a file and a fed item land the
// same way. Nothing here fetches from outside Lyra (ADR-0078).

const FIXED = new Set(["source", "sourceRef", "observedAt", "weight"]);

function dayOf(v: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const t = Date.parse(`${v}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v ? null : t;
}

export function parseSignalCsv(csv: string, now: number): { items: HarvestedSignal[]; errors: RowError[] } {
  const { header, rows, parseErrors } = parseCsv(csv);
  if (!header.includes("source") && !parseErrors.length) return { items: [], errors: [{ line: 1, ref: null, error: "missing column source" }] };
  const out: { items: HarvestedSignal[]; errors: RowError[] } = { items: [], errors: [...parseErrors] };
  if (!header.includes("source")) return out;

  for (const { line, cells } of rows) {
    const fail = (error: string) => out.errors.push({ line, ref: cells.sourceRef || null, error });
    const source = (cells.source ?? "").trim();
    const sourceRef = (cells.sourceRef ?? "").trim();
    const observedAt = dayOf((cells.observedAt ?? "").trim());
    const weightText = (cells.weight ?? "").trim();
    const weight = weightText === "" ? 1 : /^\d+$/.test(weightText) ? Number(weightText) : NaN;
    if (!isSignalSourceKind(source)) { fail("source is not a known kind"); continue; }
    if (!sourceRef) { fail("sourceRef is required"); continue; }
    if (observedAt === null) { fail("observedAt must be a real YYYY-MM-DD date"); continue; }
    if (observedAt > now) { fail("observedAt is in the future"); continue; }
    if (!(weight >= 1 && weight <= 1_000)) { fail("weight must be a whole number from 1 to 1000"); continue; }
    if (out.items.length >= HARVEST_MAX_PER_SOURCE) { fail(`at most ${HARVEST_MAX_PER_SOURCE} signals per file`); continue; }
    const payload = Object.fromEntries(Object.entries(cells).filter(([k, v]) => !FIXED.has(k) && v !== ""));
    out.items.push({ source, sourceRef, observedAt, weight, payload });
  }
  return out;
}

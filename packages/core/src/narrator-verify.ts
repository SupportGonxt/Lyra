// docs/15 §4 ambient-AI inspectability gate for NORTH briefings (CLAUDE.md
// rule 11): every number a briefing states must trace back to the snapshot it
// was generated from. Pure and DB-free like momentum.ts/whitespace.ts so both
// apps/api's narrator engine and this package's own eval harness
// (packages/model-gateway/evals/north) score the identical function.

export type Unit = "count" | "money" | "percent" | "ratio" | "duration_ms";

export interface SnapshotMetric {
  metricKey: string;
  name: string;
  unit: Unit;
  currency: string | null;
  grain: "day" | "month";
  period: string;
  value: number;
  previousPeriod: string | null;
  previousValue: number | null;
  /** (value - previous) / previous, in basis points. Null with no comparable prior period. */
  deltaBps: number | null;
}

export interface BriefingSnapshot {
  tenantId: string;
  /** The briefing's own date (YYYY-MM-DD) — not necessarily a reported period itself. */
  date: string;
  metrics: SnapshotMetric[];
}

/** A metric's value in the units a sentence would actually use — minor units and
 *  basis points are the storage format, never the prose format. */
export function displayValue(m: Pick<SnapshotMetric, "unit" | "value">): number {
  switch (m.unit) {
    case "percent":
    case "ratio":
      return m.value / 100; // bps -> percent
    case "money":
      return m.value / 100; // minor -> major currency unit
    default:
      return m.value; // count, duration_ms
  }
}

const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/**
 * The same digits, written the way half this product's locales write them.
 *
 * docs/27 F46. `NUMBER_RE` is ASCII, so an Arabic briefing numbered in
 * Arabic-Indic digits contains no numbers as far as the verifier is concerned,
 * `mismatches` comes back empty and `verifyNumericClaims` returns ok for any
 * fabrication at all. A gate that answers "clean" because it could not read the
 * sentence is worse than no gate: it reports a verification that never happened.
 * So normalisation belongs here, at the one function both verifiers extract
 * through, and not at any call site.
 *
 * Four groups, each a real thing an `ar-*` renderer emits:
 *   U+0660-0669  Arabic-Indic digits          — `Intl.NumberFormat("ar-SA")`
 *   U+06F0-06F9  Extended Arabic-Indic digits — fa/ur, ahead of docs/16 H11
 *   U+066B       Arabic decimal separator ٫   — becomes "."
 *   U+066C       Arabic thousands separator ٬ — becomes "," so the existing
 *                grouping branch of NUMBER_RE strips it unchanged
 * plus the bidi controls (U+200E/200F/061C, the isolates U+2066-2069) that
 * `Intl` interleaves with Arabic currency and percent output — left in place
 * they split one number into two, each of which then matches nothing.
 */
export function normalizeDigits(text: string): string {
  return text
    .replace(/[‎‏؜⁦-⁩]/g, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",");
}

/** Every bare number in the text — a straightforward regex, not a claim parser. */
export function extractNumbers(text: string): number[] {
  return [...normalizeDigits(text).matchAll(NUMBER_RE)]
    .map((m) => Number(m[0].replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

function acceptablePool(snapshot: BriefingSnapshot): number[] {
  const pool: number[] = [];
  const push = (v: number | null): void => {
    if (v === null || !Number.isFinite(v)) return;
    pool.push(v, Math.round(v), Math.round(v * 10) / 10);
  };
  for (const m of snapshot.metrics) {
    push(displayValue(m));
    if (m.previousValue !== null) push(displayValue({ unit: m.unit, value: m.previousValue }));
    if (m.deltaBps !== null) push(Math.abs(m.deltaBps) / 100);
  }
  // A date mentioned in prose ("...for 2026-01-05...") is not a numeric claim.
  for (const period of [snapshot.date, ...snapshot.metrics.map((m) => m.period), ...snapshot.metrics.map((m) => m.previousPeriod)]) {
    if (!period) continue;
    for (const part of period.split("-")) {
      const n = Number(part);
      if (Number.isFinite(n)) pool.push(n);
    }
  }
  return pool;
}

function nearAny(claim: number, pool: number[]): boolean {
  const tolerance = Math.max(0.06, Math.abs(claim) * 0.001);
  return pool.some((p) => Math.abs(p - claim) <= tolerance);
}

export interface VerificationResult {
  ok: boolean;
  /** Numbers found in the text with no matching snapshot value, within tolerance. */
  mismatches: number[];
}

/**
 * The ambient-AI-grammar inspectability gate (CLAUDE.md rule 11): every number
 * the model wrote must trace back to the snapshot it was given. Runs after
 * generation, never blocks generation itself — see narrator.ts's generateBriefing.
 */
export function verifyNumericClaims(text: string, snapshot: BriefingSnapshot): VerificationResult {
  const pool = acceptablePool(snapshot);
  const mismatches = extractNumbers(text).filter((n) => !nearAny(n, pool));
  return { ok: mismatches.length === 0, mismatches };
}

export interface GroundednessResult {
  ok: boolean;
  mismatches: number[];
}

/**
 * Same inspectability gate as verifyNumericClaims, generalized to plain
 * context lines instead of a BriefingSnapshot: the AXIS case copilot has
 * no snapshot, only the case/document/task facts assembled into prose.
 */
export function verifyGroundedness(text: string, contextLines: string[]): GroundednessResult {
  const pool = extractNumbers(contextLines.join("\n"));
  const mismatches = extractNumbers(text).filter((n) => !nearAny(n, pool));
  return { ok: mismatches.length === 0, mismatches };
}

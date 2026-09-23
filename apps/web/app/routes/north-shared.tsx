import { Money, formatMoney } from "@lyra/ui";
// ../api-error, never ../api.server: this module is not a route, so the client
// bundle takes it whole and a `.server` import here is a build error.
import { ApiError } from "../api-error";
import { labelsFrom as kitLabelsFrom } from "./detail-kit";

// The half-dozen things every bespoke NORTH screen needs and none of them owns:
// the label resolver, the 403-swallowing read, the action envelope, and the one
// rule for turning a stored snapshot integer into a number a person reads.
//
// Storage formats are not display formats (packages/core/src/narrator-verify.ts
// §displayValue): money is minor units, a percent or ratio is basis points. That
// conversion lives here once so two NORTH screens cannot disagree about it.

export type Labels = Record<string, Record<string, string>>;

/**
 * The one resolver, taken uncurried for the NORTH screens that were written
 * before there was a shared one (docs/ui.md §7 P3-14).
 */
export function labelsFrom(
  labels: Labels,
  locale: string
): (key: string, vars?: Record<string, string>) => string {
  return kitLabelsFrom(labels)(locale);
}

/**
 * A section the actor may not read is absent, not an error: the API is the
 * authority on what they see, so one withheld permission costs a card rather
 * than the whole screen.
 *
 * Any 4xx, not only 403/404. This swallowed exactly those two for months and
 * /north/explorer served HTTP 500 to everyone the whole time: its snapshots
 * call asked for `limit=360`, MAX_PAGE is 200 (apps/api/src/http.ts:186), the
 * API answered 400, and a rethrown ApiError is a crash to React Router. A card
 * the API refuses is still a missing card, whatever it refused it for; a 5xx
 * still rethrows, because that one really is broken. So does 401: a signed-out
 * reader needs the login redirect, not a page of empty cards.
 */
export async function readable<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) return null;
    throw error;
  }
}

/** Every NORTH action answers in this shape; `saved` names what was written. */
export interface ActionResult {
  problem: { title: string; status: number; code?: string; detail?: string; requestId?: string } | null;
  saved: string | null;
}

export const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  saved: null
});

/** `ApiError` → a Problem beside the form it was refused for, never a crash. */
export function refused(error: unknown): ActionResult {
  if (error instanceof ApiError) return { problem: error.problem, saved: null };
  throw error;
}

/** A page of generic-CRUD rows (apps/api/src/crud.ts). */
export interface Page<T> {
  data: T[];
  cursor?: string;
  total?: number;
}

export type MetricUnit = "count" | "money" | "percent" | "ratio" | "duration_ms";

export interface Metric {
  id: string;
  key: string;
  // A `*Json` column: an object from the generic CRUD, text from a module
  // route. Read it with parsed(), never JSON.parse().
  nameJson: unknown;
  definitionSqlRef: string | null;
  unit: MetricUnit;
  currency: string | null;
  grain: "day" | "week" | "month";
  owner: string | null;
  targetJson: unknown;
  sensitivity: string;
  direction: string;
  updatedAt: number;
}

export interface Snapshot {
  id: string;
  metricKey: string;
  grain: string;
  period: string;
  value: number;
  dimsHash: string;
  ts: number;
}

export interface Anomaly {
  id: string;
  metricKey: string;
  window: string;
  /** Signed basis points against what the detector expected. */
  magnitude: number;
  // Nullable in north_anomalies: a detector that fired on shape rather than on a
  // pair of values has neither, and rendering "null" at a person is a defect.
  expected: number | null;
  actual: number | null;
  state: string;
  driverAnalysisJson: unknown;
  linkedActionRef: string | null;
  explainedBy: string | null;
  detectedAt: number;
}

/** The metric's name in this locale, falling back to the key it is stored under. */
export function metricName(metric: Pick<Metric, "key" | "nameJson">, locale: string): string {
  const names = parsed<Record<string, string> | null>(metric.nameJson, null);
  return names?.[locale] ?? names?.en ?? metric.key;
}

/**
 * Reads a JSON column without letting one bad row take the screen down, and
 * without caring which of the two shapes it arrived in: the generic CRUD
 * hydrates every `*Json` column into an object (apps/api/src/crud.ts hydrate),
 * while a bespoke module route hands the raw text through. Calling JSON.parse
 * on the hydrated object stringifies it to "[object Object]" and throws, which
 * silently cost NORTH its metric names, its targets and its driver bars.
 */
export function parsed<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * The briefing being read: the one asked for, else the newest the reader can
 * actually read.
 *
 * The rows arrive newest-first, so the old `rows[0]` was "newest in any
 * locale". A tenant that narrates in both en and ar therefore served whichever
 * language happened to be generated last — on staging that put an Arabic
 * paragraph on an English reader's brief and on the flagship journey's NORTH
 * step. `locale` is the reader's, not the row's.
 *
 * Structural in its row type because two screens pick from the same column:
 * north-brief.tsx and journey-north.tsx.
 */
export function chosen<T extends { id: string; locale: string }>(
  rows: readonly T[] | null | undefined,
  id: string | null,
  locale: string
): T | null {
  if (!rows?.length) return null;
  if (id) return rows.find((row) => row.id === id) ?? rows[0]!;
  return rows.find((row) => row.locale === locale) ?? rows[0]!;
}

/**
 * `narrativeRef` holds the briefing prose (apps/api/src/engines/narrator.ts).
 * Rows seeded before f506bf7 hold a storage key like
 * `briefings/<tenant>/<id>.md` instead, and no bucket was ever bound to hold
 * that object — so printing it is the raw-key bug (ui.md §7 P3-14) pointing at
 * text that does not exist. Such a row gets no narrative rather than a filename
 * presented as a briefing.
 *
 * Shared because both screens that read the column had the bug: the journey
 * step printed the key as its narrative section, and north-brief additionally
 * headlined the `<h1>` with it.
 */
export function narrative(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return /^[\w/-]+\.md$/.test(ref) ? null : ref;
}

/**
 * A nullable stored integer inside a sentence, where a component cannot go.
 * An em dash rather than the string "null" when the detector recorded neither.
 */
export function num(value: number | null | undefined, locale: string): string {
  return typeof value === "number" ? new Intl.NumberFormat(locale).format(value) : "—";
}

/** Basis points → the percent a person reads. `null` when there is no prior. */
export function pct(bps: number | null, locale: string): string | null {
  if (bps === null || !Number.isFinite(bps)) return null;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "exceptZero"
  }).format(bps / 10_000);
}

/** One stored integer as text in its own units — for places a component cannot go (a chart axis). */
export function metricText(value: number, unit: MetricUnit, currency: string | null | undefined, locale: string): string {
  if (unit === "money" && currency) return formatMoney(value, currency, locale);
  if (unit === "percent" || unit === "ratio") {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value / 10_000);
  }
  if (unit === "duration_ms") {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "second", maximumFractionDigits: 1 }).format(value / 1_000);
  }
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * One stored integer, rendered in its own units. Money goes through `<Money>`
 * so a three-decimal currency is right without this file knowing which ones
 * those are.
 */
export function MetricValue({
  value,
  unit,
  currency,
  locale
}: {
  value: number;
  unit: MetricUnit;
  currency?: string | null;
  locale: string;
}) {
  if (unit === "money" && currency) {
    return <Money amountMinor={value} currency={currency} locale={locale} />;
  }
  return <span className="tabular-nums">{metricText(value, unit, currency, locale)}</span>;
}

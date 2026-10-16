// ADR-0127 — a coverage gap and a coverage term are two facts, not one column.
//
// `scout_panel_bench.coverage_gaps_json` is one column that carried both, in
// four shapes: the Bench Builder's object of counts
// (`{ unquotedRequests, declined }`), the seed's array of booleans
// (`{ term, ours: false, panelMedian: true, note }`), the seed's array of money
// (`{ term, oursMinor, panelMedianMinor, note }`) and the normalised union
// below. Every one of those shapes is already in a tenant's database, which is
// what decides the answer: the contract lives in the type and in `coverageOf`,
// and the column keeps its name.
//
// The distinction the column lost, and this file restores:
//
//   reach — "the panel answered requests this provider never did"
//   terms — "our wording differs on this term, and here is where each side sits"
//
// A reader that confuses the two reads a count as a list (the panel screen
// rendered `NaN`) or a list as nothing (the supplier portal rendered "None").
// `kind` is what makes that mistake a type error instead of a screen.

/** One side of a term comparison. `present` is the whole of what a boolean
 *  shape ever said; `minor` is the money shape in minor units. A coverage
 *  position can be absent, included, better or worse than the panel, or a
 *  stated figure — the boolean was always a lossy encoding of the figure. */
export interface CoverPosition {
  readonly present: boolean;
  readonly minor?: number;
  readonly note?: string;
}

export interface CoverageTerm {
  readonly term: string;
  /** Our position, and the panel's, in the *same* units. */
  readonly ours: CoverPosition;
  readonly panelMedian: CoverPosition;
  readonly note?: string;
  /** Set only when a wording diff produced this term (ADR-0123). */
  readonly changedAt?: number;
  readonly direction?: "added" | "removed";
}

/** Requests the panel answered on a line that this provider never did, and the
 *  ones it answered with a decline. Counts, not a list. */
export interface CoverageReach {
  readonly kind: "reach";
  readonly unquotedRequests: number;
  readonly declined: number;
}

/** Terms where our wording differs from the panel median. */
export interface CoverageTerms {
  readonly kind: "terms";
  readonly terms: readonly CoverageTerm[];
}

export type Coverage = CoverageReach | CoverageTerms;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const countOf = (value: unknown): number => (isCount(value) ? Math.max(0, value) : 0);

/** Optional fields are spread, never assigned `undefined`: `exactOptionalPropertyTypes`. */
function position(present: boolean, minor?: number, note?: string): CoverPosition {
  return {
    present,
    ...(minor !== undefined ? { minor } : {}),
    ...(note !== undefined ? { note } : {})
  };
}

/**
 * One side of one term, whichever of the seed's shapes wrote it.
 *
 * The suffixed branch is the awkward half: `oursSeconds: 118` is a fourth form
 * the seed wrote and the ADR's `CoverPosition` has no field for a figure that
 * is not money. Dropping it would be the same lossy move the boolean was, so
 * the value goes into the position's `note` with the unit the key names.
 */
function positionOf(raw: Record<string, unknown>, key: "ours" | "panelMedian"): CoverPosition {
  const value = raw[key];
  if (isRecord(value)) {
    return position(
      value.present === true,
      isCount(value.minor) ? value.minor : undefined,
      typeof value.note === "string" ? value.note : undefined
    );
  }
  const minor = raw[`${key}Minor`];
  if (isCount(minor)) return position(true, minor);
  if (typeof value === "boolean") return position(value);
  if (isCount(value)) return position(true, undefined, String(value));
  if (typeof value === "string") return position(true, undefined, value);
  if (value === null || value === undefined) {
    const suffixed = Object.keys(raw).find((one) => one.startsWith(key) && one !== key && isCount(raw[one]));
    if (suffixed) {
      const unit = suffixed.slice(key.length).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
      return position(true, undefined, `${raw[suffixed] as number} ${unit}`);
    }
    return position(false);
  }
  return position(false);
}

/** One stored term entry, or null when it names no term — nothing is invented. */
function termOf(raw: Record<string, unknown>): CoverageTerm | null {
  const term = typeof raw.term === "string" && raw.term.length > 0 ? raw.term : null;
  if (term === null) return null;
  const note = typeof raw.note === "string" ? raw.note : undefined;
  const changedAt = isCount(raw.changedAt) ? raw.changedAt : undefined;
  const direction = raw.direction === "added" || raw.direction === "removed" ? raw.direction : undefined;
  return {
    term,
    ours: positionOf(raw, "ours"),
    panelMedian: positionOf(raw, "panelMedian"),
    ...(note !== undefined ? { note } : {}),
    ...(changedAt !== undefined ? { changedAt } : {}),
    ...(direction !== undefined ? { direction } : {})
  };
}

const termsIn = (raw: readonly unknown[]): CoverageTerm[] =>
  raw.flatMap((one) => {
    if (!isRecord(one)) return [];
    const term = termOf(one);
    return term === null ? [] : [term];
  });

/** A value is a term list only if every entry is a term object: one bare string
 *  among the entries makes it an unrecognised shape rather than a partial one.
 *  An entry that *is* an object but names no term is dropped by `termsIn`. */
const asTerms = (raw: readonly unknown[]): CoverageTerms | null =>
  raw.some((one) => !isRecord(one)) ? null : coverageTerms(termsIn(raw));

/** The write side: one name for the encoding, so a producer never hand-rolls a
 *  string that `coverageOf` has to guess at. */
export function encodeCoverage(coverage: Coverage): string {
  return JSON.stringify(coverage);
}

export function coverageReach(unquotedRequests: number, declined: number): CoverageReach {
  return { kind: "reach", unquotedRequests: countOf(unquotedRequests), declined: countOf(declined) };
}

export function coverageTerms(terms: readonly CoverageTerm[]): CoverageTerms {
  return { kind: "terms", terms: [...terms] };
}

/**
 * The one accessor every reader routes through.
 *
 * Accepts the stored string *or* the value the web is handed: `hydrate()`
 * (apps/api/src/crud.ts) parses every `*Json` column before the generic CRUD
 * response is serialised, so the panel screen never sees a string. A string is
 * parsed; anything else is read as the already-parsed shape.
 *
 * `null` is the third state — nothing recorded — and it is not the same claim
 * as "no gaps", so an unreadable or unrecognised value is null rather than an
 * empty term list. An array of bare strings (`["roadside"]`) is refused for the
 * same reason: no producer ever wrote one, and reading it as a term would mean
 * inventing both sides of a comparison.
 */
export function coverageOf(json: unknown): Coverage | null {
  let raw = json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw)) return asTerms(raw);

  if (isRecord(raw)) {
    if (raw.kind === "terms") return Array.isArray(raw.terms) ? asTerms(raw.terms) : null;
    if (raw.kind === "reach") {
      // At least one count has to be there: `{ kind: "reach" }` alone would be
      // read as "no requests went unanswered", which is a claim, not a fact.
      if (!isCount(raw.unquotedRequests) && !isCount(raw.declined)) return null;
      return coverageReach(countOf(raw.unquotedRequests), countOf(raw.declined));
    }
    // The builder's shape predates `kind` and is still what every stored row
    // written by it holds.
    if (raw.kind === undefined && (isCount(raw.unquotedRequests) || isCount(raw.declined))) {
      return coverageReach(countOf(raw.unquotedRequests), countOf(raw.declined));
    }
  }

  return null;
}

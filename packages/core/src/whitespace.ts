// docs/modules/scout.md §2.1/§8 — the cold-start whitespace radar: turn a real
// quote export into evidenced whitespace candidates instead of the 7
// hand-written rows in seed/scout.ts (those stay a fixed demo narrative; this
// is what a live tenant's own data would actually produce).
//
// Reuses clusterSignals/momentumScore (momentum.ts) for the demand side and
// checkKAnonymity (k-anonymity.ts) for the suppression gate, exactly as
// panel-bench does in apps/api/src/resources.ts - no reimplementation of
// either.

import { clusterSignals, type RawSignal } from "./momentum.js";
import { checkKAnonymity, DEFAULT_K_FLOOR } from "./k-anonymity.js";
import { conflict } from "./errors.js";

/** How many of this tenant's own policies already sit in a category - the
 *  "coverage" a whitespace candidate has to be thin against. Source: a count
 *  over axis_policies grouped by core_products.line (see seed/axis.ts for the
 *  shape of a real policy row). */
export interface CoverageInput {
  readonly category: string;
  readonly policyCount: number;
}

export interface WhitespaceCandidate {
  readonly category: string;
  readonly momentum: number;
  readonly coverage: number;
  /** Evidence count backing this category - the cell checkKAnonymity gates on. */
  readonly cellCount: number;
  readonly visible: boolean;
}

/**
 * A category is a whitespace candidate when demand is moving faster than this
 * tenant's book on average, and the book's coverage of it is thinner than
 * average - real signal, thin footprint. `visible` is false when the evidence
 * behind it (`cellCount`, the quote count clusterSignals grouped) is below the
 * k-anonymity floor, same rule panel-bench applies to `volume`.
 *
 * ponytail: average-of-the-book thresholding, no seasonal/segment baseline.
 * Upgrade path is the same one momentum.ts already names for its own
 * two-window scoring - richer baselines slot in without changing this shape.
 */
export function computeWhitespaceCandidates(
  quoteSignals: readonly RawSignal[],
  coverage: readonly CoverageInput[],
  now: number,
  windowMs?: number,
  kFloor: number = DEFAULT_K_FLOOR
): WhitespaceCandidate[] {
  const clusters = clusterSignals(quoteSignals, now, windowMs);
  const momentumByCategory = new Map(clusters.map((c) => [c.category, c]));
  const coverageByCategory = new Map(coverage.map((c) => [c.category, c.policyCount]));

  const categories = new Set([...momentumByCategory.keys(), ...coverageByCategory.keys()]);
  if (categories.size === 0) return [];

  const momentumOf = (category: string): number => momentumByCategory.get(category)?.momentum ?? 0;
  const coverageOf = (category: string): number => coverageByCategory.get(category) ?? 0;

  const avgMomentum = [...categories].reduce((sum, c) => sum + momentumOf(c), 0) / categories.size;
  const avgCoverage = [...categories].reduce((sum, c) => sum + coverageOf(c), 0) / categories.size;

  const out: WhitespaceCandidate[] = [];
  for (const category of categories) {
    const momentum = momentumOf(category);
    const cov = coverageOf(category);
    if (!(momentum > avgMomentum && cov < avgCoverage)) continue;

    const cellCount = momentumByCategory.get(category)?.signalIds.length ?? 0;
    out.push({
      category,
      momentum,
      coverage: cov,
      cellCount,
      visible: checkKAnonymity(cellCount, kFloor).allowed
    });
  }

  return out.sort((a, b) => b.momentum - a.momentum);
}

// docs/19 §2: promotion changes contractual-ish state (a whitespace candidate
// becomes a committed campaign), so it is a transaction with a state machine and
// not an UPDATE. Same idiom as lifecycle.ts POLICY_TRANSITIONS — in core because
// both the CRUD resource (apps/api/src/resources.ts) and the promote engine
// enforce it, and the vocabulary is the one scout_whitespaces.status already
// documents (packages/db/src/schema/scout.ts).

export const WHITESPACE_STATES = [
  "candidate", // the sweep flagged it; nothing decided
  "validating", // an analyst is checking the evidence
  "validated", // promoted: a SIGNAL campaign exists for it
  "parked" // rejected or deferred; the next sweep may re-flag the category
] as const;
export type WhitespaceState = (typeof WHITESPACE_STATES)[number];

/** Anything not listed is refused. Note `validated` has no self-hop: that is
 *  what makes a second promotion of the same candidate a 409 rather than a
 *  second campaign, independently of the idempotency key. */
export const WHITESPACE_TRANSITIONS: Record<WhitespaceState, readonly WhitespaceState[]> = {
  candidate: ["validating", "validated", "parked"],
  validating: ["validated", "parked", "candidate"],
  validated: ["parked"],
  parked: ["candidate"]
};

export function canWhitespaceTransition(from: WhitespaceState, to: WhitespaceState): boolean {
  return WHITESPACE_TRANSITIONS[from].includes(to);
}

export function isWhitespaceState(s: string): s is WhitespaceState {
  return (WHITESPACE_STATES as readonly string[]).includes(s);
}

/** Throws 409 rather than returning false, for the route call sites. An unknown
 *  persisted status is refused too — a row nobody can classify is not promotable. */
export function assertWhitespaceTransition(from: string, to: WhitespaceState): void {
  if (!isWhitespaceState(from) || !canWhitespaceTransition(from, to)) {
    throw conflict(`whitespace cannot move from ${from} to ${to}`);
  }
}

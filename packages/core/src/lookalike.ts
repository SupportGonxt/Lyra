// docs/17-user-spec-benchmark.md §SIG-028 — "Lookalike expansion with consent
// basis preserved" — under §SIG-034, "Protected attributes excluded from
// targeting and scoring models". ADR-0113 records the choices.
//
// A lookalike is a scoring model over people, so it answers to both lines at
// once. Pure and DB-free for the same reason targeting.ts is: the engine hands
// it tag sets and consent states, and everything that decides who is in —
// which axes count, which cells are thick enough to count, whose consent
// covers being scored, and what the resulting audience may be used for — is
// here, where a test can hold it.
//
// ponytail: similarity is share-weighted overlap on the pack's targetable axes,
// not an embedding. docs/modules/signal.md §2.2 says "lookalike scoring via
// embeddings"; an embedding over a customer's attributes is exactly the place a
// protected attribute leaks back in through a correlated one, and nothing could
// prove otherwise. Overlap on declared axes can be proved (lookalike.test.ts)
// and explained per member (`matched`). Upgrade path is a learned weight per
// axis inside `similarity`, fed only what `seedProfile` already filtered.

import { DEFAULT_K_FLOOR } from "./k-anonymity.js";
import { countAttributes, parseAttributeTag, isTargetable, type Attribute, type AttributeCount } from "./targeting.js";

/** Every consent purpose the platform records (`PurposesJson`), in the order a
 *  basis is written in. */
export const CONSENT_PURPOSES = ["marketing", "profiling", "dataSharing", "crossBorder"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export type Purposes = Partial<Record<ConsentPurpose, boolean>>;

/**
 * What a person must have granted to be scored at all, as a seed member or as a
 * candidate. Marketing because the audience exists to be marketed to;
 * profiling because a similarity score *is* profiling (PDPL, GDPR art. 4(4)).
 */
export const LOOKALIKE_PURPOSES = ["marketing", "profiling"] as const satisfies readonly ConsentPurpose[];

/** The most people one expansion may return. A bound, not a default. */
export const LOOKALIKE_MAX_SIZE = 5_000;

export interface LookalikePerson {
  readonly id: string;
  readonly tags: readonly string[];
  /** The person's current, unexpired consent; null when there is none. */
  readonly purposes: Purposes | null;
  /** On a suppression list (withdrawn consent, a suppressed prospect). */
  readonly suppressed?: boolean;
}

/** What the seed looks like: only targetable cells at or above the floor. */
export interface SeedProfile {
  /** Seed members who could be profiled at all. */
  readonly size: number;
  readonly cells: readonly AttributeCount[];
  /** The axes those cells fall on, most common cell first. */
  readonly axes: readonly string[];
}

export interface LookalikeMember {
  readonly id: string;
  /** 0..1000: the mean, over the profile's axes, of the seed's share carrying
   *  this person's best value on that axis. */
  readonly score: number;
  /** The "why": the seed cells this person shares. */
  readonly matched: readonly Attribute[];
}

export interface LookalikeExclusions {
  readonly seed: number;
  readonly suppressed: number;
  readonly consent: number;
  readonly unlike: number;
  readonly beyondSize: number;
}

export type LookalikeRefusal = "bad_size" | "seed_below_floor" | "no_profile" | "no_match";

export type LookalikeResult =
  | {
      readonly ok: true;
      readonly profile: SeedProfile;
      readonly members: readonly LookalikeMember[];
      /** The purposes every member granted — what the audience may be used for. */
      readonly basis: readonly ConsentPurpose[];
      readonly excluded: LookalikeExclusions;
    }
  | { readonly ok: false; readonly reason: LookalikeRefusal; readonly profile: SeedProfile };

/** Whether a consent state grants every required purpose. No row grants nothing. */
export function consentCovers(purposes: Purposes | null, required: readonly ConsentPurpose[]): boolean {
  if (!purposes) return false;
  return required.every((p) => purposes[p] === true);
}

/**
 * The strictest basis a set of people share: the purposes *every* one granted.
 * An audience inherits this rather than any member's own, so a use one member
 * never consented to is a use the audience cannot be put to.
 */
export function consentBasis(members: readonly (Purposes | null)[]): ConsentPurpose[] {
  if (members.length === 0) return [];
  return CONSENT_PURPOSES.filter((p) => members.every((m) => m?.[p] === true));
}

function profilable(p: LookalikePerson): boolean {
  return !p.suppressed && consentCovers(p.purposes, LOOKALIKE_PURPOSES);
}

/**
 * The seed, as cells. A seed member who has not consented to profiling is not
 * read at all; a cell under the floor is dropped, because a thin cell names the
 * handful of people behind it and must not become something a score points at.
 * Protected axes never become cells (`countAttributes`).
 */
export function seedProfile(
  seed: readonly LookalikePerson[],
  opts: { pack?: string; floor?: number } = {}
): SeedProfile {
  const floor = opts.floor ?? DEFAULT_K_FLOOR;
  const usable = seed.filter(profilable);
  const cells = countAttributes(
    usable.map((p) => p.tags),
    opts.pack
  ).filter((c) => c.count >= floor);
  const axes: string[] = [];
  for (const c of cells) if (!axes.includes(c.axis)) axes.push(c.axis);
  return { size: usable.length, cells, axes };
}

/** One person against the profile. Tags off the pack's targetable axes — which
 *  includes every protected axis — are never read. */
export function similarity(
  profile: SeedProfile,
  tags: readonly string[],
  pack?: string
): { score: number; matched: Attribute[] } {
  if (profile.axes.length === 0 || profile.size === 0) return { score: 0, matched: [] };
  let total = 0;
  const matched: Attribute[] = [];
  for (const axis of profile.axes) {
    let best: AttributeCount | null = null;
    for (const tag of tags) {
      const attr = parseAttributeTag(tag);
      if (!attr || attr.axis !== axis || !isTargetable(attr.axis, pack)) continue;
      const cell = profile.cells.find((c) => c.axis === axis && c.value === attr.value);
      if (cell && (!best || cell.count > best.count)) best = cell;
    }
    if (best) {
      total += best.count / profile.size;
      matched.push({ axis: best.axis, value: best.value });
    }
  }
  return { score: Math.round((1000 * total) / profile.axes.length), matched };
}

/**
 * Seed and candidates to a ranked, consented, suppressed audience.
 *
 * Refuses rather than degrades: a thin seed is the profile of a handful of
 * named people, a seed with no targetable cell has nothing to be alike on, and
 * an empty result is not an audience.
 */
export function expandLookalike(input: {
  seed: readonly LookalikePerson[];
  candidates: readonly LookalikePerson[];
  size: number;
  pack?: string;
  floor?: number;
}): LookalikeResult {
  const floor = input.floor ?? DEFAULT_K_FLOOR;
  const profile = seedProfile(input.seed, { floor, ...(input.pack !== undefined ? { pack: input.pack } : {}) });
  const { size } = input;
  if (!Number.isInteger(size) || size < 1 || size > LOOKALIKE_MAX_SIZE) return { ok: false, reason: "bad_size", profile };
  if (profile.size < floor) return { ok: false, reason: "seed_below_floor", profile };
  if (profile.cells.length === 0) return { ok: false, reason: "no_profile", profile };

  const seedIds = new Set(input.seed.map((p) => p.id));
  const excluded = { seed: 0, suppressed: 0, consent: 0, unlike: 0, beyondSize: 0 };
  const scored: (LookalikeMember & { purposes: Purposes | null })[] = [];
  for (const c of input.candidates) {
    if (seedIds.has(c.id)) excluded.seed++;
    else if (c.suppressed) excluded.suppressed++;
    else if (!consentCovers(c.purposes, LOOKALIKE_PURPOSES)) excluded.consent++;
    else {
      const s = similarity(profile, c.tags, input.pack);
      if (s.score === 0) excluded.unlike++;
      else scored.push({ id: c.id, ...s, purposes: c.purposes });
    }
  }
  if (scored.length === 0) return { ok: false, reason: "no_match", profile };

  scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const kept = scored.slice(0, size);
  excluded.beyondSize = scored.length - kept.length;
  return {
    ok: true,
    profile,
    members: kept.map(({ id, score, matched }) => ({ id, score, matched })),
    basis: consentBasis(kept.map((m) => m.purposes)),
    excluded
  };
}

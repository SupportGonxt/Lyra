import { describe, expect, it } from "vitest";
import {
  CONSENT_PURPOSES,
  LOOKALIKE_MAX_SIZE,
  LOOKALIKE_PURPOSES,
  consentBasis,
  consentCovers,
  expandLookalike,
  seedProfile,
  similarity,
  type LookalikePerson,
  type Purposes
} from "./lookalike.js";
import { PROTECTED_AXES } from "./targeting.js";

// docs/17 §SIG-028 (lookalike expansion with consent basis preserved) under
// §SIG-034 (protected attributes excluded from targeting and scoring models).
// ADR-0113. Builders first: every fixture is a person with tags and a consent
// state, so a test says which of the three it is varying.

const FLOOR = 3;

const MARKETING_AND_PROFILING: Purposes = { marketing: true, profiling: true };
const EVERYTHING: Purposes = { marketing: true, profiling: true, dataSharing: true, crossBorder: true };

let seq = 0;
function person(tags: readonly string[], purposes: Purposes | null = MARKETING_AND_PROFILING, extra: Partial<LookalikePerson> = {}): LookalikePerson {
  seq += 1;
  return { id: `cu_${String(seq).padStart(4, "0")}`, tags, purposes, ...extra };
}

function many(n: number, tags: readonly string[], purposes: Purposes | null = MARKETING_AND_PROFILING): LookalikePerson[] {
  return Array.from({ length: n }, () => person(tags, purposes));
}

describe("consentCovers", () => {
  it("holds only when every required purpose is exactly true", () => {
    expect(consentCovers({ marketing: true, profiling: true }, LOOKALIKE_PURPOSES)).toBe(true);
    expect(consentCovers({ marketing: true, profiling: false }, LOOKALIKE_PURPOSES)).toBe(false);
    expect(consentCovers({ marketing: true }, LOOKALIKE_PURPOSES)).toBe(false);
    expect(consentCovers({ profiling: true }, LOOKALIKE_PURPOSES)).toBe(false);
  });

  it("treats no consent row as no consent, whatever is required", () => {
    expect(consentCovers(null, LOOKALIKE_PURPOSES)).toBe(false);
    expect(consentCovers(null, [])).toBe(false);
  });

  it("requires nothing extra when nothing is required", () => {
    expect(consentCovers({}, [])).toBe(true);
  });

  it("does not accept a truthy stand-in for true", () => {
    expect(consentCovers({ marketing: "yes", profiling: 1 } as unknown as Purposes, LOOKALIKE_PURPOSES)).toBe(false);
  });
});

describe("consentBasis", () => {
  it("is the purposes every member granted, in the canonical order", () => {
    expect(
      consentBasis([
        { crossBorder: true, marketing: true, profiling: true, dataSharing: true },
        { marketing: true, profiling: true, dataSharing: true }
      ])
    ).toEqual(["marketing", "profiling", "dataSharing"]);
  });

  it("is narrowed by the strictest member alone", () => {
    expect(consentBasis([EVERYTHING, EVERYTHING, { marketing: true }])).toEqual(["marketing"]);
  });

  it("is empty for no members — an empty audience grants nothing", () => {
    expect(consentBasis([])).toEqual([]);
  });

  it("is empty when any member has no consent row", () => {
    expect(consentBasis([EVERYTHING, null])).toEqual([]);
  });

  it("names only the purposes the platform knows", () => {
    expect(CONSENT_PURPOSES).toEqual(["marketing", "profiling", "dataSharing", "crossBorder"]);
    expect(consentBasis([{ ...EVERYTHING, telepathy: true } as Purposes])).toEqual([...CONSENT_PURPOSES]);
  });
});

describe("seedProfile", () => {
  it("counts targetable cells of the consented seed at or above the floor", () => {
    const seed = [...many(4, ["lsm:7", "region:gauteng"]), ...many(2, ["lsm:8", "region:gauteng"])];
    const profile = seedProfile(seed, { floor: FLOOR });
    expect(profile.size).toBe(6);
    expect(profile.cells).toEqual([
      { axis: "region", value: "gauteng", count: 6 },
      { axis: "lsm", value: "7", count: 4 }
    ]);
    // lsm:8 is two people: under the floor, so it neither shows nor scores.
    expect(profile.axes).toEqual(["region", "lsm"]);
  });

  it("keeps a cell of exactly the floor", () => {
    const profile = seedProfile(many(FLOOR, ["lsm:7"]), { floor: FLOOR });
    expect(profile.cells).toEqual([{ axis: "lsm", value: "7", count: FLOOR }]);
  });

  it("leaves out seed members who did not consent to profiling, or are suppressed", () => {
    const seed = [
      ...many(3, ["lsm:7"]),
      ...many(5, ["lsm:9"], { marketing: true }),
      ...many(5, ["lsm:9"], null),
      person(["lsm:9"], MARKETING_AND_PROFILING, { suppressed: true })
    ];
    const profile = seedProfile(seed, { floor: FLOOR });
    expect(profile.size).toBe(3);
    expect(profile.cells).toEqual([{ axis: "lsm", value: "7", count: 3 }]);
  });

  it("never builds a cell on a protected axis, even one a pack declares", () => {
    const seed = many(10, PROTECTED_AXES.map((a) => `${a}:x`));
    const profile = seedProfile(seed, { floor: FLOOR });
    expect(profile.cells).toEqual([]);
    expect(profile.axes).toEqual([]);
  });

  it("reads axes from the tenant's pack", () => {
    const seed = many(4, ["lsm:7", "incomequintile:4"]);
    expect(seedProfile(seed, { floor: FLOOR }).axes).toEqual(["lsm"]);
    expect(seedProfile(seed, { floor: FLOOR, pack: "insurance-gulf" }).axes).toEqual(["incomequintile"]);
  });

  it("defaults to the platform k-anonymity floor", () => {
    expect(seedProfile(many(19, ["lsm:7"])).cells).toEqual([]);
    expect(seedProfile(many(20, ["lsm:7"])).cells).toEqual([{ axis: "lsm", value: "7", count: 20 }]);
  });
});

describe("similarity", () => {
  // Ten seed members: all gauteng; six lsm:7, four lsm:8.
  const seed = [...many(6, ["lsm:7", "region:gauteng"]), ...many(4, ["lsm:8", "region:gauteng"])];
  const profile = seedProfile(seed, { floor: FLOOR });

  it("is 1000 for a person who carries the modal value on every axis", () => {
    // region: 10/10, lsm: 6/10 is not 1 — so the modal person scores the mean.
    expect(similarity(profile, ["region:gauteng", "lsm:7"])).toEqual({
      score: 800,
      matched: [
        { axis: "region", value: "gauteng" },
        { axis: "lsm", value: "7" }
      ]
    });
  });

  it("weights a value by the share of the seed carrying it", () => {
    expect(similarity(profile, ["region:gauteng", "lsm:8"]).score).toBe(700);
    expect(similarity(profile, ["lsm:7"]).score).toBe(300);
    expect(similarity(profile, ["lsm:8"]).score).toBe(200);
    expect(similarity(profile, ["region:gauteng"]).score).toBe(500);
  });

  it("takes the best value when a person carries two on one axis", () => {
    const both = similarity(profile, ["lsm:8", "lsm:7"]);
    expect(both.score).toBe(300);
    expect(both.matched).toEqual([{ axis: "lsm", value: "7" }]);
  });

  it("is zero for a person who shares nothing", () => {
    expect(similarity(profile, ["region:limpopo", "lsm:3", "vip"])).toEqual({ score: 0, matched: [] });
    expect(similarity(profile, [])).toEqual({ score: 0, matched: [] });
  });

  it("is zero against an empty profile rather than dividing by it", () => {
    expect(similarity(seedProfile([], { floor: FLOOR }), ["lsm:7"])).toEqual({ score: 0, matched: [] });
  });

  it("is not moved by any protected tag a person carries", () => {
    const protectedTags = PROTECTED_AXES.map((a) => `${a}:x`);
    for (const tags of [["lsm:7"], ["region:gauteng", "lsm:8"], []]) {
      expect(similarity(profile, [...tags, ...protectedTags])).toEqual(similarity(profile, tags));
    }
  });
});

describe("expandLookalike", () => {
  const seed = many(4, ["lsm:7", "region:gauteng"]);

  it("ranks consented non-members by similarity and keeps the top N", () => {
    const best = person(["lsm:7", "region:gauteng"]);
    const half = person(["region:gauteng"]);
    const other = person(["lsm:7"]);
    const nobody = person(["region:limpopo"]);
    const out = expandLookalike({ seed, candidates: [nobody, other, half, best], size: 2, floor: FLOOR });
    if (!out.ok) throw new Error(out.reason);
    expect(out.members.map((m) => m.id)).toEqual([best.id, half.id]);
    expect(out.members.map((m) => m.score)).toEqual([1000, 500]);
    expect(out.members[0]!.matched).toEqual([
      { axis: "lsm", value: "7" },
      { axis: "region", value: "gauteng" }
    ]);
    expect(out.excluded).toEqual({ seed: 0, consent: 0, suppressed: 0, unlike: 1, beyondSize: 1 });
  });

  it("breaks a tie by id so the same book gives the same audience", () => {
    const a = person(["region:gauteng"]);
    const b = person(["region:gauteng"]);
    const out = expandLookalike({ seed, candidates: [b, a], size: 1, floor: FLOOR });
    if (!out.ok) throw new Error(out.reason);
    expect(out.members.map((m) => m.id)).toEqual([a.id]);
  });

  it("never returns a seed member, however alike", () => {
    const out = expandLookalike({ seed, candidates: [...seed], size: 10, floor: FLOOR });
    expect(out).toEqual({ ok: false, reason: "no_match", profile: expect.anything() });
  });

  it("counts every exclusion by its reason", () => {
    const out = expandLookalike({
      seed,
      candidates: [
        seed[0]!,
        person(["lsm:7"], { marketing: true }),
        person(["lsm:7"], { profiling: true }),
        person(["lsm:7"], null),
        person(["lsm:7"], MARKETING_AND_PROFILING, { suppressed: true }),
        person(["lsm:7"])
      ],
      size: 10,
      floor: FLOOR
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.members).toHaveLength(1);
    expect(out.excluded).toEqual({ seed: 1, consent: 3, suppressed: 1, unlike: 0, beyondSize: 0 });
  });

  it("checks suppression before consent, so a suppressed person counts once", () => {
    const out = expandLookalike({
      seed,
      candidates: [person(["lsm:7"], null, { suppressed: true }), person(["lsm:7"])],
      size: 10,
      floor: FLOOR
    });
    if (!out.ok) throw new Error(out.reason);
    expect(out.excluded).toEqual({ seed: 0, consent: 0, suppressed: 1, unlike: 0, beyondSize: 0 });
  });

  it("inherits the strictest consent basis of the members it returns", () => {
    const wide = person(["lsm:7"], EVERYTHING);
    const narrow = person(["lsm:7"], { ...MARKETING_AND_PROFILING, dataSharing: true });
    const both = expandLookalike({ seed, candidates: [wide, narrow], size: 10, floor: FLOOR });
    if (!both.ok) throw new Error(both.reason);
    expect(both.basis).toEqual(["marketing", "profiling", "dataSharing"]);

    // Take the narrow one out by size and the basis widens with it: the basis
    // describes who is in the audience, not who was considered.
    const onlyWide = expandLookalike({
      seed,
      candidates: [wide, person(["region:gauteng"], MARKETING_AND_PROFILING)],
      size: 1,
      floor: FLOOR
    });
    if (!onlyWide.ok) throw new Error(onlyWide.reason);
    expect(onlyWide.basis).toEqual([...CONSENT_PURPOSES]);
  });

  it("always includes marketing and profiling in the basis", () => {
    const out = expandLookalike({ seed, candidates: [person(["lsm:7"])], size: 1, floor: FLOOR });
    if (!out.ok) throw new Error(out.reason);
    expect(out.basis).toEqual([...LOOKALIKE_PURPOSES]);
  });

  it("refuses a seed whose consented members are under the floor", () => {
    const thin = [...many(FLOOR - 1, ["lsm:7"]), ...many(5, ["lsm:7"], { marketing: true })];
    const out = expandLookalike({ seed: thin, candidates: [person(["lsm:7"])], size: 1, floor: FLOOR });
    expect(out).toEqual({ ok: false, reason: "seed_below_floor", profile: expect.objectContaining({ size: FLOOR - 1 }) });
  });

  it("accepts a seed of exactly the floor", () => {
    const out = expandLookalike({ seed: many(FLOOR, ["lsm:7"]), candidates: [person(["lsm:7"])], size: 1, floor: FLOOR });
    expect(out.ok).toBe(true);
  });

  it("refuses a seed with no targetable cell to be alike on", () => {
    const out = expandLookalike({
      seed: many(5, ["religion:observant", "vip"]),
      candidates: [person(["religion:observant"])],
      size: 5,
      floor: FLOOR
    });
    expect(out).toEqual({ ok: false, reason: "no_profile", profile: expect.objectContaining({ size: 5, cells: [] }) });
  });

  it("finds nobody by a protected axis the seed shares, provably", () => {
    // The seed is alike on region *and* on a protected axis; a candidate who
    // shares only the protected one is unlike, and one who shares only the
    // region scores exactly what they would with no protected tags anywhere.
    const protectedTags = PROTECTED_AXES.map((a) => `${a}:x`);
    const taggedSeed = many(4, ["region:gauteng", ...protectedTags]);
    const cleanSeed = many(4, ["region:gauteng"]);
    const onlyProtected = person(protectedTags);
    const onlyRegion = person(["region:gauteng"]);
    const tagged = expandLookalike({ seed: taggedSeed, candidates: [onlyProtected, onlyRegion], size: 10, floor: FLOOR });
    const clean = expandLookalike({ seed: cleanSeed, candidates: [onlyProtected, onlyRegion], size: 10, floor: FLOOR });
    if (!tagged.ok || !clean.ok) throw new Error("expected both to expand");
    expect(tagged.members).toEqual(clean.members);
    expect(tagged.members.map((m) => m.id)).toEqual([onlyRegion.id]);
    expect(tagged.profile.axes).toEqual(["region"]);
    expect(JSON.stringify(tagged)).not.toMatch(new RegExp(PROTECTED_AXES.join("|")));
  });

  it("refuses a size outside 1..LOOKALIKE_MAX_SIZE rather than clamping it", () => {
    for (const size of [0, -1, 1.5, LOOKALIKE_MAX_SIZE + 1, Number.NaN]) {
      expect(expandLookalike({ seed, candidates: [person(["lsm:7"])], size, floor: FLOOR })).toEqual({
        ok: false,
        reason: "bad_size",
        profile: expect.anything()
      });
    }
    expect(expandLookalike({ seed, candidates: [person(["lsm:7"])], size: LOOKALIKE_MAX_SIZE, floor: FLOOR }).ok).toBe(true);
  });

  it("answers no_match when every candidate is excluded or unlike", () => {
    const out = expandLookalike({ seed, candidates: [person(["region:limpopo"]), person(["lsm:7"], null)], size: 5, floor: FLOOR });
    expect(out).toEqual({ ok: false, reason: "no_match", profile: expect.anything() });
  });

  it("uses the tenant's pack for the axes it scores on", () => {
    const gulfSeed = many(4, ["incomequintile:4", "lsm:7"]);
    const q4 = person(["incomequintile:4"]);
    const l7 = person(["lsm:7"]);
    const out = expandLookalike({ seed: gulfSeed, candidates: [l7, q4], size: 5, floor: FLOOR, pack: "insurance-gulf" });
    if (!out.ok) throw new Error(out.reason);
    expect(out.members.map((m) => m.id)).toEqual([q4.id]);
  });
});

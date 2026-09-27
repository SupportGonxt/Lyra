import { describe, expect, it } from "vitest";
import { FIELDS_BY_KIND, matchBordereau, type MatchLine } from "./bordereau-match.js";

// docs/30 Ledger 5 (ADR-0105). The pure half of inbound bordereau
// reconciliation: their lines against our records, grouped by (reference,
// currency), classified matched / variance / missing_ours / missing_theirs.

const PREMIUM = FIELDS_BY_KIND.premium;

function theirs(id: string, ref: string, gross: number, commission: number, currency = "AED"): MatchLine {
  return { id, ref, currency, amounts: { grossPremiumMinor: gross, commissionMinor: commission } };
}
const ours = theirs;

describe("matchBordereau", () => {
  it("matches a line whose every compared amount agrees", () => {
    const out = matchBordereau([theirs("l1", "POL-1", 100_000, 10_000)], [ours("ce1", "POL-1", 100_000, 10_000)], { fields: PREMIUM });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ ref: "POL-1", currency: "AED", state: "matched", varianceMinor: 0, duplicate: false });
    expect(out.groups[0]!.theirs.ids).toEqual(["l1"]);
    expect(out.groups[0]!.ours.ids).toEqual(["ce1"]);
    expect(out.groups[0]!.deltas).toEqual({ grossPremiumMinor: 0, commissionMinor: 0 });
  });

  it("reports an amount mismatch as variance, theirs less ours, on the primary field", () => {
    const out = matchBordereau([theirs("l1", "POL-1", 105_000, 10_000)], [ours("ce1", "POL-1", 100_000, 10_000)], { fields: PREMIUM });
    expect(out.groups[0]).toMatchObject({ state: "variance", varianceMinor: 5_000 });
    expect(out.groups[0]!.deltas).toEqual({ grossPremiumMinor: 5_000, commissionMinor: 0 });
  });

  it("a mismatch on a secondary field alone is still variance, though the primary delta is zero", () => {
    const out = matchBordereau([theirs("l1", "POL-1", 100_000, 9_000)], [ours("ce1", "POL-1", 100_000, 10_000)], { fields: PREMIUM });
    expect(out.groups[0]).toMatchObject({ state: "variance", varianceMinor: 0 });
    expect(out.groups[0]!.deltas.commissionMinor).toBe(-1_000);
  });

  it("classifies a line only they sent as missing_ours, and a record only we hold as missing_theirs", () => {
    const out = matchBordereau([theirs("l1", "THEIRS-ONLY", 50_000, 5_000)], [ours("ce9", "OURS-ONLY", 70_000, 7_000)], { fields: PREMIUM });
    const byRef = Object.fromEntries(out.groups.map((g) => [g.ref, g]));
    expect(byRef["THEIRS-ONLY"]).toMatchObject({ state: "missing_ours", varianceMinor: 50_000 });
    expect(byRef["THEIRS-ONLY"]!.ours.ids).toEqual([]);
    expect(byRef["OURS-ONLY"]).toMatchObject({ state: "missing_theirs", varianceMinor: -70_000 });
    expect(byRef["OURS-ONLY"]!.theirs.ids).toEqual([]);
  });

  it("never compares across currencies: the same reference in two currencies is two discrepancies", () => {
    const out = matchBordereau([theirs("l1", "POL-1", 100_000, 10_000, "AED")], [ours("ce1", "POL-1", 100_000, 10_000, "USD")], { fields: PREMIUM });
    expect(out.groups.map((g) => [g.currency, g.state])).toEqual([
      ["AED", "missing_ours"],
      ["USD", "missing_theirs"]
    ]);
  });

  it("totals per currency, never summing one currency into another", () => {
    const out = matchBordereau(
      [theirs("l1", "A", 110, 0, "AED"), theirs("l2", "B", 200, 0, "USD"), theirs("l3", "C", 5, 0, "USD")],
      [ours("o1", "A", 100, 0, "AED"), ours("o2", "B", 200, 0, "USD")],
      { fields: PREMIUM }
    );
    expect(out.totals).toEqual([
      { currency: "AED", matched: 0, variance: 1, missingOurs: 0, missingTheirs: 0, theirsMinor: 110, oursMinor: 100, varianceMinor: 10 },
      { currency: "USD", matched: 1, variance: 0, missingOurs: 1, missingTheirs: 0, theirsMinor: 205, oursMinor: 200, varianceMinor: 5 }
    ]);
  });

  it("sums duplicate lines on either side before comparing, and flags a reference they listed twice", () => {
    // An endorsement listed beside the original line, and two commission
    // entries on our side for the same policy: sums agree, so it matches —
    // but the duplicate stays visible so a person can see why.
    const matched = matchBordereau(
      [theirs("l1", "POL-1", 80_000, 8_000), theirs("l2", "POL-1", 20_000, 2_000)],
      [ours("ce1", "POL-1", 60_000, 6_000), ours("ce2", "POL-1", 40_000, 4_000)],
      { fields: PREMIUM }
    );
    expect(matched.groups).toHaveLength(1);
    expect(matched.groups[0]).toMatchObject({ state: "matched", duplicate: true });
    expect(matched.groups[0]!.theirs).toEqual({ ids: ["l1", "l2"], amounts: { grossPremiumMinor: 100_000, commissionMinor: 10_000 } });
    expect(matched.groups[0]!.ours.ids).toEqual(["ce1", "ce2"]);

    // The same line sent twice by mistake reads as double what we hold.
    const doubled = matchBordereau(
      [theirs("l1", "POL-1", 100_000, 10_000), theirs("l2", "POL-1", 100_000, 10_000)],
      [ours("ce1", "POL-1", 100_000, 10_000)],
      { fields: PREMIUM }
    );
    expect(doubled.groups[0]).toMatchObject({ state: "variance", varianceMinor: 100_000, duplicate: true });
  });

  it("only their side makes a duplicate; two of our entries alone do not", () => {
    const out = matchBordereau([theirs("l1", "POL-1", 100, 10)], [ours("a", "POL-1", 50, 5), ours("b", "POL-1", 50, 5)], { fields: PREMIUM });
    expect(out.groups[0]).toMatchObject({ state: "matched", duplicate: false });
  });

  it("matches references ignoring surrounding space and letter case, and reports their spelling", () => {
    const out = matchBordereau([theirs("l1", "  pol-7 ", 100, 10)], [ours("ce1", "POL-7", 100, 10)], { fields: PREMIUM });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]).toMatchObject({ ref: "pol-7", state: "matched" });
  });

  it("a tolerance in minor units absorbs a difference up to and including it, per field, and still reports the delta", () => {
    const within = matchBordereau([theirs("l1", "P", 100_003, 9_997)], [ours("o", "P", 100_000, 10_000)], { fields: PREMIUM, toleranceMinor: 3 });
    expect(within.groups[0]).toMatchObject({ state: "matched", varianceMinor: 3 });
    const beyond = matchBordereau([theirs("l1", "P", 100_004, 10_000)], [ours("o", "P", 100_000, 10_000)], { fields: PREMIUM, toleranceMinor: 3 });
    expect(beyond.groups[0]!.state).toBe("variance");
    // A tolerance never turns a missing line into a match, however small.
    const missing = matchBordereau([theirs("l1", "P", 1, 0)], [], { fields: PREMIUM, toleranceMinor: 1_000 });
    expect(missing.groups[0]!.state).toBe("missing_ours");
    // The tolerance is summed-group, not per line: two lines each 2 off make 4.
    const summed = matchBordereau([theirs("a", "P", 52, 0), theirs("b", "P", 52, 0)], [ours("o", "P", 100, 0)], { fields: PREMIUM, toleranceMinor: 3 });
    expect(summed.groups[0]!.state).toBe("variance");
  });

  it("refuses a negative or fractional tolerance rather than guessing", () => {
    expect(() => matchBordereau([], [], { fields: PREMIUM, toleranceMinor: -1 })).toThrow(/tolerance/);
    expect(() => matchBordereau([], [], { fields: PREMIUM, toleranceMinor: 0.5 })).toThrow(/tolerance/);
  });

  it("reads a missing amount as zero, and compares only the fields asked for", () => {
    const out = matchBordereau(
      [{ id: "l1", ref: "C-1", currency: "AED", amounts: { claimsPaidMinor: 400, grossPremiumMinor: 999 } }],
      [{ id: "c1", ref: "C-1", currency: "AED", amounts: { claimsPaidMinor: 400, reserveMinor: 0 } }],
      { fields: FIELDS_BY_KIND.claims }
    );
    expect(out.groups[0]).toMatchObject({ state: "matched" });
    expect(Object.keys(out.groups[0]!.deltas)).toEqual(["claimsPaidMinor", "reserveMinor"]);
  });

  it("orders groups by reference then currency, and is the same answer whatever order the lines arrive in", () => {
    const t = [theirs("l1", "B", 1, 0), theirs("l2", "A", 1, 0, "USD"), theirs("l3", "A", 1, 0)];
    const o = [ours("o1", "C", 1, 0), ours("o2", "A", 1, 0)];
    const one = matchBordereau(t, o, { fields: PREMIUM });
    const two = matchBordereau([...t].reverse(), [...o].reverse(), { fields: PREMIUM });
    expect(one.groups.map((g) => `${g.ref}/${g.currency}`)).toEqual(["A/AED", "A/USD", "B/AED", "C/AED"]);
    expect(two.groups.map((g) => ({ ...g, theirs: g.theirs.amounts, ours: g.ours.amounts }))).toEqual(
      one.groups.map((g) => ({ ...g, theirs: g.theirs.amounts, ours: g.ours.amounts }))
    );
  });

  it("an empty file against an empty period is an empty, balanced report", () => {
    expect(matchBordereau([], [], { fields: PREMIUM })).toEqual({ groups: [], totals: [] });
  });

  it("names which fields each bordereau kind compares, the primary one first", () => {
    expect(FIELDS_BY_KIND).toEqual({
      premium: ["grossPremiumMinor", "commissionMinor"],
      claims: ["claimsPaidMinor", "reserveMinor"],
      combined: ["grossPremiumMinor", "commissionMinor", "claimsPaidMinor", "reserveMinor"]
    });
  });
});

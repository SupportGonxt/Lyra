import { describe, expect, it } from "vitest";
import {
  TAX_MARKETS,
  TAX_RULEPACK,
  TAX_RULEPACK_DRAFTS,
  marketsAwaitingRulepack,
  taxDraftsFor
} from "./tax-rulepack.js";

// The client operates in nine MENA countries and the platform governs three. The
// drafts are a starting point for the other six, and what makes them safe is not
// the label on them — it is that the applied rulepack and the drafts are
// **disjoint**, so a draft cannot become law by being copied across.

describe("an applied rule is never a draft", () => {
  it("shares no market between the rulepack and the drafts", () => {
    // The structural promise. If this ever fails, a proposed rate is being
    // applied to real supplies without anyone confirming it.
    const applied = new Set(TAX_MARKETS);
    const drafted = new Set(TAX_RULEPACK_DRAFTS.map((d) => d.market));
    expect([...drafted].filter((market) => applied.has(market))).toEqual([]);
  });

  it("governs exactly the three markets ADR-0121 names", () => {
    expect([...TAX_MARKETS].sort()).toEqual(["AE", "EG", "SA"]);
  });

  it("keeps every applied rate a real rate, not an unknown one", () => {
    // A 0 in the applied pack means zero-rated or exempt and must say so. A 0 that
    // means "we do not know" belongs in the drafts, and this is the line between
    // the two.
    for (const rule of TAX_RULEPACK) {
      if (rule.ratePpm === 0) expect(rule.exempt === true || rule.kind === "none").toBe(true);
    }
  });
});

describe("the drafts", () => {
  it("names the six markets still waiting on a human", () => {
    expect(marketsAwaitingRulepack()).toEqual(["BH", "JO", "KW", "LB", "OM", "QA"]);
    // Nine operating, three governed, six drafted — and the arithmetic is the
    // point: it is now a countable piece of work.
    expect(TAX_MARKETS.length + marketsAwaitingRulepack().length).toBe(9);
  });

  it("says what must be confirmed, in a sentence a person can act on", () => {
    for (const draft of TAX_RULEPACK_DRAFTS) {
      expect(draft.marketName.length).toBeGreaterThan(2);
      expect(draft.currency).toMatch(/^[A-Z]{3}$/);
      // Not boilerplate: "confirm the rate" is not a question, and this field has
      // to carry the specific one that decides whether the number is right.
      expect(draft.mustConfirm.length).toBeGreaterThan(40);
    }
  });

  it("does not let a zero pass as zero-rated", () => {
    // Qatar and Kuwait carry a draft of 0, which means "no rate known" — the two
    // are different facts and the draft says so in words rather than leaving a
    // reader to infer it from a number.
    for (const market of ["QA", "KW"]) {
      const [draft] = taxDraftsFor(market);
      expect(draft!.ratePpm).toBe(0);
      expect(draft!.mustConfirm).toMatch(/unknown|not 'no tax'|has introduced/i);
    }
  });

  it("answers no drafts for a market that has none", () => {
    expect(taxDraftsFor("AE")).toEqual([]);
    expect(taxDraftsFor("ae")).toEqual([]);
  });
});

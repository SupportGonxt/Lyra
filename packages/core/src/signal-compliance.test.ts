import { describe, expect, it } from "vitest";
import { checkCompliance, checkOutreachDraft, preflightCreative, tenantPatternProblem } from "./signal-compliance.js";

// The pre-flight every creative and every personal draft passes. Its eval
// (model-gateway/evals/signal, evals/outreach-draft) scores it from outside;
// these pin each rule, each language and each field of the "why" from inside.

const SOURCE = "A superlative against the whole market needs a source (panel size, published pricing) or it must be dropped.";
const COVER = "Acceptance is the underwriter's decision, not ours. Never publishable in this form.";

describe("checkCompliance", () => {
  it("passes plain copy with no findings", () => {
    expect(checkCompliance("Cover in minutes, built for your family.")).toEqual({ status: "passed", findings: [] });
  });

  it.each([
    ["cheapest", "The cheapest motor cover around."],
    ["lowest price", "Always the lowest price."],
    ["best in the UAE", "Rated best in the UAE by drivers."],
    ["best in the market", "Simply the best in the market."],
    ["Cheapest", "Cheapest, full stop."]
  ])("flags the market superlative %s, whatever its case", (excerpt, text) => {
    expect(checkCompliance(text)).toEqual({
      status: "flagged",
      findings: [{ rule: "comparison_claim_requires_source", excerpt, note: SOURCE }]
    });
  });

  it.each([
    ["guaranteed", "Acceptance guaranteed."],
    ["guarantee", "We guarantee you will be covered."],
    ["100% accepted", "100% accepted, no questions."],
    ["always accepted", "You are always accepted."]
  ])("flags the promise of cover %s", (excerpt, text) => {
    expect(checkCompliance(text)).toEqual({ status: "flagged", findings: [{ rule: "no_guarantee_of_cover", excerpt, note: COVER }] });
  });

  it("does not match inside another word", () => {
    expect(checkCompliance("Our cheapestimate tool, unguaranteedly fun.").status).toBe("passed");
  });

  it.each([
    ["الأرخص", "نحن الأرخص في المنطقة"],
    ["الأقل سعرًا", "التأمين الأقل سعرًا"],
    ["الأفضل في السوق", "نحن الأفضل في السوق"],
    ["الأفضل في الإمارات", "الأفضل في الإمارات"],
    ["الأفضل في المنطقة", "الأفضل في المنطقة"],
    ["رقم ١ في السوق", "رقم ١ في السوق"]
  ])("flags the Arabic market superlative %s", (excerpt, text) => {
    expect(checkCompliance(text).findings).toEqual([{ rule: "comparison_claim_requires_source", excerpt, note: SOURCE }]);
  });

  it.each([
    ["مضمون", "التأمين مضمون"],
    ["مضمونة", "موافقة مضمونة"],
    ["قبول مؤكد", "لك قبول مؤكد"],
    ["100% قبول", "100% قبول للجميع"],
    ["١٠٠٪ قبول", "١٠٠٪ قبول"],
    ["قبول 100%", "قبول 100%"],
    ["نقبل الجميع", "نقبل الجميع"]
  ])("flags the Arabic promise of cover %s", (excerpt, text) => {
    const [finding] = checkCompliance(text).findings;
    expect(finding).toEqual({ rule: "no_guarantee_of_cover", excerpt, note: COVER });
  });

  // Copy pasted from elsewhere carries doubled spaces; the rules still read it.
  it.each([
    "الأقل  سعرًا",
    "الأفضل  في السوق",
    "الأفضل في  الإمارات",
    "رقم  ١ في السوق",
    "رقم ١  في السوق",
    "رقم ١ في  السوق",
    "قبول  مؤكد",
    "100 ٪ قبول",
    "100%  قبول",
    "قبول  100%",
    "قبول 100 %",
    "نقبل  الجميع"
  ])("flags %s across doubled spaces", (text) => {
    expect(checkCompliance(text).status).toBe("flagged");
  });

  it("reports every rule a text breaks, in rule order", () => {
    expect(checkCompliance("The cheapest cover, acceptance guaranteed.").findings.map((f) => f.rule)).toEqual([
      "comparison_claim_requires_source",
      "no_guarantee_of_cover"
    ]);
  });
});

describe("checkOutreachDraft", () => {
  const evidence = ["Recipient first name: Amina", "Why this person: their quote expired on 2026-08-12 without being taken up"];

  it("passes a draft that states only what its evidence gave", () => {
    expect(checkOutreachDraft("Hi Amina, your quote from 2026-08-12 lapsed. Reply to pick it up.", evidence)).toEqual({ ok: true, why: null });
  });

  it("refuses a number the evidence never gave, naming it", () => {
    expect(checkOutreachDraft("Hi Amina, take 20% off this week.", evidence)).toEqual({
      ok: false,
      why: "states 20, which the evidence does not"
    });
  });

  it("names every invented number, comma-separated", () => {
    expect(checkOutreachDraft("Hi Amina, 20% off, only 3 days left.", evidence).why).toBe("states 20, 3, which the evidence does not");
  });

  it("refuses a grounded draft that fails the pre-flight, with the rule's why", () => {
    expect(checkOutreachDraft("Hi Amina, we are the cheapest.", evidence)).toEqual({ ok: false, why: SOURCE });
  });
});

/* ------------------------------------------------- the tenant's own rules */

// docs/modules/signal.md §2.1. The brand kit and the banned-claims list used to
// be two strings the seed wrote as "pass" — so these tests are the difference
// between an attestation and a check. The kit is *additive*: a tenant says what
// else must be true, never whether the built-ins run.

const KIT = {
  requiredPhrases: ["nxt"],
  forbiddenWords: ["cheap"],
  bannedClaims: [
    { pattern: "approved by the central bank", note: "A regulator's name is not ours to borrow.", severity: "block" as const },
    { pattern: "no questions asked", note: "Our own register avoids this phrasing." }
  ]
};

describe("a tenant's brand kit", () => {
  it("changes nothing when the tenant has none", () => {
    // The defaults are what every existing tenant already runs on.
    expect(checkCompliance("Compare nine UAE insurers today")).toEqual({ status: "passed", findings: [] });
    expect(checkCompliance("Compare nine UAE insurers today", null).status).toBe("passed");
  });

  it("blocks a claim the tenant marked as blocking", () => {
    const result = checkCompliance("nxt is approved by the central bank", KIT);
    expect(result.status).toBe("blocked");
    expect(result.findings[0]).toMatchObject({ rule: "tenant_banned_claim", severity: "block" });
  });

  it("flags a claim the tenant left advisory", () => {
    const result = checkCompliance("nxt cover, no questions asked", KIT);
    expect(result.status).toBe("flagged");
    expect(result.findings.find((f) => f.rule === "tenant_banned_claim")?.severity).toBe("flag");
  });

  it("matches a literal phrase literally, not as a pattern", () => {
    // "10%" as a regex is "10" then "0 or more %", so a tenant typing it means
    // the phrase — a pattern would match "10" anywhere and block good copy.
    const kit = { requiredPhrases: [], forbiddenWords: [], bannedClaims: [{ pattern: "10% off", note: "x" }] };
    expect(checkCompliance("Get 10% off your first month", kit).status).toBe("flagged");
    expect(checkCompliance("Save 10 fils a day", kit).status).toBe("passed");
  });

  it("flags a missing required phrase and a forbidden word", () => {
    const missing = checkCompliance("Cover your car in an afternoon", KIT);
    expect(missing.findings.map((f) => f.rule)).toContain("brand_required_phrase_missing");
    const forbidden = checkCompliance("nxt: cheap cover, fast", KIT);
    expect(forbidden.findings.map((f) => f.rule)).toContain("brand_forbidden_word");
  });

  it("keeps the built-in rules running alongside the tenant's", () => {
    const result = checkCompliance("nxt is the cheapest, guaranteed", KIT);
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("comparison_claim_requires_source");
    expect(rules).toContain("no_guarantee_of_cover");
    // The built-ins stay advisory; only the tenant's own block made it a block.
    expect(result.findings.find((f) => f.rule === "no_guarantee_of_cover")?.severity).toBeUndefined();
  });
});

describe("tenant-supplied patterns are bounded before they run", () => {
  it("refuses the catastrophic-backtracking shape", () => {
    // This repo has already paid for one ReDoS (stripFence). A pattern that
    // hangs the worker fails differently from one that matches wrongly.
    expect(tenantPatternProblem({ pattern: "(a+)+$", isRegex: true, note: "x" })).toContain("nested quantifier");
    expect(tenantPatternProblem({ pattern: "(\\w*)*", isRegex: true, note: "x" })).toContain("nested quantifier");
  });

  it("refuses an over-long, empty or invalid pattern", () => {
    expect(tenantPatternProblem({ pattern: "", note: "x" })).toBe("empty pattern");
    expect(tenantPatternProblem({ pattern: "a".repeat(201), note: "x" })).toContain("longer than");
    expect(tenantPatternProblem({ pattern: "([", isRegex: true, note: "x" })).toContain("not a valid regular expression");
  });

  it("accepts an ordinary phrase or pattern", () => {
    expect(tenantPatternProblem({ pattern: "no questions asked", note: "x" })).toBeNull();
    expect(tenantPatternProblem({ pattern: "free\\s+cover", isRegex: true, note: "x" })).toBeNull();
  });

  it("skips a rejected pattern rather than running it", () => {
    const kit = { requiredPhrases: [], forbiddenWords: [], bannedClaims: [{ pattern: "(a+)+$", isRegex: true, note: "x" }] };
    // The dangerous pattern is not applied, and it does not take the copy down.
    expect(checkCompliance("aaaa", kit).status).toBe("passed");
  });
});

describe("preflightCreative with a kit", () => {
  const scope = { productLine: "motor", disclosure: { id: "d1", version: 1, key: "motor", productLine: "motor", locale: "en", wording: "Motor cover is arranged by NXT." }, tenantConfigured: true };

  it("lets a tenant's own block outrank a soft flag", () => {
    const result = preflightCreative("nxt: approved by the central bank, cheapest", scope, KIT);
    expect(result.lane).toBe("hard_block");
    expect(result.status).toBe("blocked");
  });

  it("carries the kit's findings into the creative's own record", () => {
    const result = preflightCreative("nxt cover, no questions asked. Motor cover is arranged by NXT.", scope, KIT);
    expect(result.status).toBe("flagged");
    expect(result.findings.some((f) => f.rule === "tenant_banned_claim")).toBe(true);
  });

  it("still hard-blocks a missing mandatory disclosure with no kit at all", () => {
    const result = preflightCreative("Cover your car today", scope, null);
    expect(result.status).toBe("blocked");
    expect(result.findings[0]!.rule).toBe("disclosure_missing");
  });
});

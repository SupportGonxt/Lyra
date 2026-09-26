import { describe, expect, it } from "vitest";
import { checkCompliance, checkOutreachDraft } from "./signal-compliance.js";

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

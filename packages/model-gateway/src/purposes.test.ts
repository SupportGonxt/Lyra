import { describe, expect, test } from "vitest";
import { isKnownPurpose, resolvePurpose } from "./purposes";

// Hardcoded, not derived from PURPOSES — a mutant that hollows out an entry
// in the registry must still fail against these fixed expectations.
const REGISTERED: [purpose: string, module: string, customerFacing: boolean][] = [
  ["quote.explain", "dist", true],
  ["dist.quote.explain", "dist", true],
  ["quote.compare", "dist", true],
  ["dist.nbo.propose", "dist", true],
  ["axis.case.copilot", "axis", false],
  ["axis.document.extract", "axis", false],
  ["axis.document.embed", "axis", false],
  ["axis.dev.extract_sample", "axis", false],
  ["axis.fnol.triage", "axis", false],
  ["axis.claim.reserve_recommend", "axis", false],
  ["axis.claim.fraud_score", "axis", false],
  ["axis.case.sla_predict", "axis", false],
  ["axis.policy.ubi_reprice", "axis", false],
  ["conversation.reply", "orbit", true],
  ["orbit.conversation.reply", "orbit", true],
  ["orbit.renewal.draft_reply", "orbit", true],
  ["orbit.renewal.draft_outreach", "orbit", true],
  ["renewal.outreach_draft", "orbit", true],
  ["orbit.message.embed", "orbit", false],
  ["orbit.message.recall", "orbit", false],
  ["creative.generate", "signal", false],
  ["creative.variant", "signal", false],
  ["creative.image_generate", "signal", false],
  ["aeo.draft", "signal", false],
  ["market.scan", "scout", false],
  ["radar.summarise", "scout", false],
  ["whitespace.describe", "scout", false],
  ["scout.signal.embed", "scout", false],
  ["scout.signal.similar", "scout", false],
  ["briefing.generate", "north", false],
  ["exec.briefing", "north", false],
  ["recon.match", "ledger", false],
  ["output.review", "core", false],
  ["knowledge.embed", "core", false],
  ["analytics.ask", "analytics", false]
];

describe("resolvePurpose", () => {
  test.each(REGISTERED)("%s under %s resolves customerFacing=%s with no flags", (purpose, module, customerFacing) => {
    expect(resolvePurpose(module, purpose)).toEqual({ customerFacing, flags: [] });
  });

  test("fails closed on an unregistered purpose", () => {
    expect(resolvePurpose("dist", "nope")).toEqual({ customerFacing: true, flags: ["unknown_purpose"] });
  });

  test("fails closed when the calling module doesn't own the purpose", () => {
    expect(resolvePurpose("axis", "quote.explain")).toEqual({
      customerFacing: true,
      flags: ["purpose_module_mismatch"]
    });
  });
});

describe("isKnownPurpose", () => {
  test.each(REGISTERED)("%s is known under its own module %s", (purpose, module) => {
    expect(isKnownPurpose(module, purpose)).toBe(true);
  });

  test("is false for the wrong module", () => {
    expect(isKnownPurpose("orbit", "quote.explain")).toBe(false);
  });

  test("is false for an unregistered purpose", () => {
    expect(isKnownPurpose("dist", "nope")).toBe(false);
  });
});

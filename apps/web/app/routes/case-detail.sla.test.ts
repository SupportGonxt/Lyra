import { describe, expect, it } from "vitest";
import { labelsIn, slaOutlook } from "./case-detail";

// docs/30 AXIS 4: POST /v1/axis/cases/:id/sla-predict had no web caller. The
// answer is ambient (docs/15 §4): a sentence beside the due date, its "why"
// the one driver the model had evidence for.
describe("slaOutlook", () => {
  const l = labelsIn("en");

  it("states the likelihood and the hours left", () => {
    expect(slaOutlook(l, { breachProbability: 72, hoursToBreach: 5, driver: null })).toBe("72% likely to miss its SLA — 5 h left");
  });

  it("says when it is already overdue, and when the model saw nothing to go on", () => {
    expect(slaOutlook(l, { breachProbability: 95, hoursToBreach: 0, driver: null })).toBe("95% likely to miss its SLA — due now");
    expect(slaOutlook(l, { breachProbability: 0, hoursToBreach: null, driver: null })).toBe("No sign this case will miss its SLA");
    expect(slaOutlook(l, null)).toBe("No prediction right now");
  });

  it("speaks Arabic", () => {
    expect(slaOutlook(labelsIn("ar"), { breachProbability: 72, hoursToBreach: 5, driver: null })).not.toMatch(/likely/);
  });
});

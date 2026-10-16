import { describe, expect, it } from "vitest";
import { observedShare, type AeoWeekRow } from "./signal-answer-engines";

// J-M3 "citation share trend over 8 weeks" (docs/06:69, docs/modules/signal.md
// §4.5, §7). The rule that makes this a measurement rather than a decoration is
// that a week nobody sampled is *absent*, not zero — the trend is the only place
// the module's headline AEO claim is checked against what was actually answered.

const week = (over: Partial<AeoWeekRow> = {}): AeoWeekRow => ({
  week: "2026-09-28",
  sampled: 0,
  cited: 0,
  share: null,
  ...over
});

describe("observedShare", () => {
  it("aggregates the window rather than averaging weekly percentages", () => {
    // 1/1 and 1/9 is 2/10 = 20%, not the 56% a mean of 100% and 11% would give.
    const observed = observedShare([week({ sampled: 1, cited: 1, share: 1 }), week({ sampled: 9, cited: 1, share: 1 / 9 })]);
    expect(observed).toEqual({ sampled: 10, cited: 2, share: 0.2 });
  });

  it("answers null rather than zero when nothing was sampled", () => {
    expect(observedShare([week(), week()])).toEqual({ sampled: 0, cited: 0, share: null });
    expect(observedShare([])).toEqual({ sampled: 0, cited: 0, share: null });
  });

  it("distinguishes a sampled miss from an unsampled week", () => {
    // A window of real zeroes is 0%; a window of silence is null. A chart that
    // merged them would show a collapse on a week nobody asked.
    expect(observedShare([week({ sampled: 4, cited: 0, share: 0 })]).share).toBe(0);
    expect(observedShare([week()]).share).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  orderTreaties,
  planCessions,
  treatyApplies,
  treatyProblem,
  type TreatyTerms
} from "./reinsurance.js";

// docs/30 AXIS 5, ADR-0106. The cession is the one number a reinsurer, an
// auditor and the ledger all have to agree on, so the arithmetic lives here —
// pure, in minor units — and the posting only ever carries what this returns.

const qs = (over: Partial<TreatyTerms> = {}): TreatyTerms => ({
  id: "rit_qs",
  kind: "quota_share",
  cededSharePpm: 400_000,
  cedingCommissionPpm: 250_000,
  ...over
});

const surplus = (over: Partial<TreatyTerms> = {}): TreatyTerms => ({
  id: "rit_sp",
  kind: "surplus",
  retentionMinor: 100_000,
  lines: 4,
  cedingCommissionPpm: 0,
  ...over
});

describe("quota share", () => {
  it("cedes its share of the premium and takes its commission off the ceded part", () => {
    const plan = planCessions({ premiumMinor: 10_000, sumInsuredMinor: null, treaties: [qs()] });
    expect(plan.cessions).toEqual([
      {
        treatyId: "rit_qs",
        cededPremiumMinor: 4_000,
        cededSumInsuredMinor: null,
        commissionMinor: 1_000,
        netPayableMinor: 3_000,
        retainedPremiumMinor: 6_000
      }
    ]);
    expect(plan.retainedPremiumMinor).toBe(6_000);
    expect(plan.skipped).toEqual([]);
  });

  it("leaves the rounding dust with the cedant, so ceded + retained is the premium exactly", () => {
    const plan = planCessions({
      premiumMinor: 10_001,
      sumInsuredMinor: null,
      treaties: [qs({ cededSharePpm: 333_333, cedingCommissionPpm: 300_000 })]
    });
    const [c] = plan.cessions;
    // 10_001 × 0.333333 = 3_333.66…; the reinsurer is owed the whole units only.
    expect(c?.cededPremiumMinor).toBe(3_333);
    expect(plan.retainedPremiumMinor).toBe(6_668);
    // 3_333 × 0.3 = 999.9: commission is income, so it is never rounded up into existence.
    expect(c?.commissionMinor).toBe(999);
    expect(c?.netPayableMinor).toBe(2_334);
  });

  it("scales the sum insured by the same share when one is known", () => {
    const plan = planCessions({ premiumMinor: 10_000, sumInsuredMinor: 1_000_000, treaties: [qs()] });
    expect(plan.cessions[0]?.cededSumInsuredMinor).toBe(400_000);
  });

  it("with a per-risk limit, shares only the part of the risk inside it", () => {
    const plan = planCessions({
      premiumMinor: 10_000,
      sumInsuredMinor: 2_000_000,
      treaties: [qs({ cededSharePpm: 500_000, limitMinor: 1_000_000 })]
    });
    // Half of the first million is ceded: a quarter of the risk, a quarter of the premium.
    expect(plan.cessions[0]).toMatchObject({ cededSumInsuredMinor: 500_000, cededPremiumMinor: 2_500 });
    expect(plan.retainedPremiumMinor).toBe(7_500);
  });

  it("a limit above the sum insured is no limit at all", () => {
    const limited = planCessions({ premiumMinor: 10_000, sumInsuredMinor: 500_000, treaties: [qs({ limitMinor: 1_000_000 })] });
    const open = planCessions({ premiumMinor: 10_000, sumInsuredMinor: 500_000, treaties: [qs()] });
    expect(limited.cessions).toEqual(open.cessions);
  });

  it("a limit exactly at the sum insured is no limit either", () => {
    const plan = planCessions({ premiumMinor: 10_000, sumInsuredMinor: 1_000_000, treaties: [qs({ limitMinor: 1_000_000 })] });
    expect(plan.cessions[0]).toMatchObject({ cededSumInsuredMinor: 400_000, cededPremiumMinor: 4_000 });
  });

  it("with a limit and no sum insured, it cannot say what is inside the limit and cedes nothing", () => {
    const plan = planCessions({ premiumMinor: 10_000, sumInsuredMinor: null, treaties: [qs({ limitMinor: 1_000_000 })] });
    expect(plan.cessions).toEqual([]);
    expect(plan.skipped).toEqual([{ treatyId: "rit_qs", reason: "no_sum_insured" }]);
    expect(plan.retainedPremiumMinor).toBe(10_000);
  });

  it("a whole-account cession with full commission leaves nothing payable", () => {
    const plan = planCessions({
      premiumMinor: 7_777,
      sumInsuredMinor: null,
      treaties: [qs({ cededSharePpm: 1_000_000, cedingCommissionPpm: 1_000_000 })]
    });
    expect(plan.cessions[0]).toMatchObject({ cededPremiumMinor: 7_777, commissionMinor: 7_777, netPayableMinor: 0 });
    expect(plan.retainedPremiumMinor).toBe(0);
  });
});

describe("surplus", () => {
  it("cedes the part of the risk above the retention, up to its lines", () => {
    const plan = planCessions({ premiumMinor: 9_000, sumInsuredMinor: 300_000, treaties: [surplus()] });
    // 200k of a 300k risk sits above the 100k retention: two thirds of the premium.
    expect(plan.cessions[0]).toMatchObject({ cededSumInsuredMinor: 200_000, cededPremiumMinor: 6_000, retainedPremiumMinor: 3_000 });
  });

  it("caps the cession at lines × retention; the excess beyond capacity stays with the cedant", () => {
    const plan = planCessions({ premiumMinor: 10_000, sumInsuredMinor: 1_000_000, treaties: [surplus()] });
    // capacity 4 × 100k = 400k of a 1m risk.
    expect(plan.cessions[0]).toMatchObject({ cededSumInsuredMinor: 400_000, cededPremiumMinor: 4_000 });
    expect(plan.retainedPremiumMinor).toBe(6_000);
  });

  it("cedes exactly the capacity when the excess meets it", () => {
    const plan = planCessions({ premiumMinor: 5_000, sumInsuredMinor: 500_000, treaties: [surplus()] });
    expect(plan.cessions[0]).toMatchObject({ cededSumInsuredMinor: 400_000, cededPremiumMinor: 4_000 });
  });

  it("a risk inside the retention cedes nothing", () => {
    for (const si of [50_000, 100_000]) {
      const plan = planCessions({ premiumMinor: 9_000, sumInsuredMinor: si, treaties: [surplus()] });
      expect(plan.cessions).toEqual([]);
      expect(plan.skipped).toEqual([{ treatyId: "rit_sp", reason: "nothing_to_cede" }]);
      expect(plan.retainedPremiumMinor).toBe(9_000);
    }
  });

  it("without a sum insured there is no surplus to measure", () => {
    const plan = planCessions({ premiumMinor: 9_000, sumInsuredMinor: null, treaties: [surplus()] });
    expect(plan.skipped).toEqual([{ treatyId: "rit_sp", reason: "no_sum_insured" }]);
  });

  it("a zero sum insured has no surplus either", () => {
    const plan = planCessions({ premiumMinor: 9_000, sumInsuredMinor: 0, treaties: [surplus()] });
    expect(plan.skipped).toEqual([{ treatyId: "rit_sp", reason: "nothing_to_cede" }]);
  });

  it("rounds the ceded premium down and the commission down", () => {
    const plan = planCessions({
      premiumMinor: 1_000,
      sumInsuredMinor: 300_000,
      treaties: [surplus({ cedingCommissionPpm: 150_000 })]
    });
    // 1_000 × 2/3 = 666.67 → 666; 666 × 0.15 = 99.9 → 99.
    expect(plan.cessions[0]).toMatchObject({ cededPremiumMinor: 666, commissionMinor: 99, netPayableMinor: 567 });
    expect(plan.retainedPremiumMinor).toBe(334);
  });

  it("stays exact where a float product would not: minor units past 2^53 in the intermediate", () => {
    const plan = planCessions({
      premiumMinor: 1_000_000_000_001,
      sumInsuredMinor: 9_000_000_000_000_000,
      treaties: [surplus({ retentionMinor: 3_000_000_000_000_000, lines: 1 })]
    });
    // (1e12 + 1) × 3e15 / 9e15 = (1e12 + 1) / 3, floored.
    expect(plan.cessions[0]?.cededPremiumMinor).toBe(333_333_333_333);
    expect(plan.retainedPremiumMinor).toBe(666_666_666_668);
  });
});

describe("several treaties", () => {
  it("each works on what the one before it left retained, in the order given", () => {
    const plan = planCessions({
      premiumMinor: 12_000,
      sumInsuredMinor: 600_000,
      treaties: [qs({ cededSharePpm: 500_000, cedingCommissionPpm: 0 }), surplus({ lines: 2 })]
    });
    // QS takes half: 6_000 premium, 300k risk. Surplus then sees a 300k risk
    // with a 100k retention and 200k of capacity: two thirds of the 6_000 left.
    expect(plan.cessions.map((c) => [c.treatyId, c.cededPremiumMinor, c.cededSumInsuredMinor, c.retainedPremiumMinor])).toEqual([
      ["rit_qs", 6_000, 300_000, 6_000],
      ["rit_sp", 4_000, 200_000, 2_000]
    ]);
    expect(plan.retainedPremiumMinor).toBe(2_000);
  });

  it("a skipped treaty leaves the premium for the next", () => {
    const plan = planCessions({
      premiumMinor: 10_000,
      sumInsuredMinor: null,
      treaties: [surplus(), qs()]
    });
    expect(plan.skipped.map((s) => s.treatyId)).toEqual(["rit_sp"]);
    expect(plan.cessions.map((c) => c.cededPremiumMinor)).toEqual([4_000]);
  });

  it("once the whole premium is ceded, later treaties have nothing to take", () => {
    const plan = planCessions({
      premiumMinor: 10_000,
      sumInsuredMinor: null,
      treaties: [qs({ id: "rit_all", cededSharePpm: 1_000_000 }), qs()]
    });
    expect(plan.skipped).toEqual([{ treatyId: "rit_qs", reason: "nothing_to_cede" }]);
    expect(plan.retainedPremiumMinor).toBe(0);
  });

  it("orders by priority, then id, so a replay plans the same cessions", () => {
    const ordered = orderTreaties([
      { id: "b", priority: 1 },
      { id: "c", priority: 0 },
      { id: "a", priority: 1 }
    ]);
    expect(ordered.map((t) => t.id)).toEqual(["c", "a", "b"]);
  });

  it("does not reorder the caller's array", () => {
    const input = [
      { id: "b", priority: 1 },
      { id: "a", priority: 0 }
    ];
    orderTreaties(input);
    expect(input.map((t) => t.id)).toEqual(["b", "a"]);
  });
});

/** AppError carries its message in `detail`; the Error message is the generic title. */
function refusal(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return (e as { detail?: string }).detail ?? "";
  }
  return "(did not throw)";
}

describe("refusals", () => {
  it("refuses a premium that is not a non-negative whole number of minor units", () => {
    for (const premiumMinor of [-1, 1.5, Number.NaN]) {
      expect(refusal(() => planCessions({ premiumMinor, sumInsuredMinor: null, treaties: [qs()] }))).toMatch(/premium/);
    }
  });

  it("refuses a sum insured that is not a non-negative whole number", () => {
    for (const sumInsuredMinor of [-1, 2.5]) {
      expect(refusal(() => planCessions({ premiumMinor: 1, sumInsuredMinor, treaties: [qs()] }))).toMatch(/sum insured/);
    }
  });

  it("refuses to plan against a treaty whose terms are not coherent", () => {
    expect(refusal(() => planCessions({ premiumMinor: 1_000, sumInsuredMinor: null, treaties: [qs({ cededSharePpm: 1_000_001 })] }))).toMatch(
      /treaty rit_qs: a quota share/
    );
  });

  it("a zero premium cedes nothing", () => {
    const plan = planCessions({ premiumMinor: 0, sumInsuredMinor: null, treaties: [qs()] });
    expect(plan).toEqual({
      premiumMinor: 0,
      retainedPremiumMinor: 0,
      cessions: [],
      skipped: [{ treatyId: "rit_qs", reason: "nothing_to_cede" }]
    });
  });
});

describe("treatyProblem", () => {
  const ok = { effectiveFrom: 1, effectiveTo: 2 };

  it("accepts a coherent quota share and a coherent surplus", () => {
    expect(treatyProblem({ ...qs(), ...ok })).toBeNull();
    expect(treatyProblem({ ...surplus(), ...ok })).toBeNull();
    expect(treatyProblem({ ...qs({ limitMinor: 1 }), ...ok })).toBeNull();
    expect(treatyProblem({ ...qs({ cededSharePpm: 1_000_000, cedingCommissionPpm: 1_000_000 }), ...ok })).toBeNull();
  });

  it("names an unknown kind", () => {
    expect(treatyProblem({ ...qs(), kind: "excess_of_loss" as never, ...ok })).toMatch(/kind/);
  });

  it("a quota share needs a share above zero and at most the whole", () => {
    expect(treatyProblem({ ...qs({ cededSharePpm: null }), ...ok })).toMatch(/cededSharePpm/);
    expect(treatyProblem({ ...qs({ cededSharePpm: 0 }), ...ok })).toMatch(/cededSharePpm/);
    expect(treatyProblem({ ...qs({ cededSharePpm: 1_000_001 }), ...ok })).toMatch(/cededSharePpm/);
    expect(treatyProblem({ ...qs({ cededSharePpm: 1.5 }), ...ok })).toMatch(/cededSharePpm/);
  });

  it("a quota share limit, when stated, is a positive whole amount", () => {
    expect(treatyProblem({ ...qs({ limitMinor: 0 }), ...ok })).toMatch(/limitMinor/);
    expect(treatyProblem({ ...qs({ limitMinor: 2.5 }), ...ok })).toMatch(/limitMinor/);
  });

  it("a surplus needs a positive retention and at least one line", () => {
    expect(treatyProblem({ ...surplus({ retentionMinor: null }), ...ok })).toMatch(/retentionMinor/);
    expect(treatyProblem({ ...surplus({ retentionMinor: 0 }), ...ok })).toMatch(/retentionMinor/);
    expect(treatyProblem({ ...surplus({ lines: 0 }), ...ok })).toMatch(/lines/);
    expect(treatyProblem({ ...surplus({ lines: null }), ...ok })).toMatch(/lines/);
    expect(treatyProblem({ ...surplus({ lines: 1.5 }), ...ok })).toMatch(/lines/);
  });

  it("a ceding commission is between nothing and the whole ceded premium", () => {
    expect(treatyProblem({ ...qs({ cedingCommissionPpm: -1 }), ...ok })).toMatch(/cedingCommissionPpm/);
    expect(treatyProblem({ ...qs({ cedingCommissionPpm: 1_000_001 }), ...ok })).toMatch(/cedingCommissionPpm/);
    expect(treatyProblem({ ...qs({ cedingCommissionPpm: 0.5 }), ...ok })).toMatch(/cedingCommissionPpm/);
  });

  it("an effective period ends after it starts", () => {
    expect(treatyProblem({ ...qs(), effectiveFrom: 2, effectiveTo: 2 })).toMatch(/effective/);
    expect(treatyProblem({ ...qs(), effectiveFrom: 3, effectiveTo: 2 })).toMatch(/effective/);
  });

  it("the period is checked only when both ends are known", () => {
    expect(treatyProblem({ ...qs(), effectiveFrom: 3 })).toBeNull();
  });
});

describe("treatyApplies", () => {
  const treaty = { status: "active", productLine: "motor", currency: "AED", effectiveFrom: 100, effectiveTo: 200 };
  const policy = { line: "motor", currency: "AED", startAt: 150 };

  it("an active treaty in the policy's line, currency and period applies", () => {
    expect(treatyApplies(treaty, policy)).toBe(true);
  });

  it("a treaty with no line covers every line", () => {
    expect(treatyApplies({ ...treaty, productLine: null }, { ...policy, line: "travel" })).toBe(true);
    expect(treatyApplies({ ...treaty, productLine: null }, { ...policy, line: null })).toBe(true);
  });

  it("does not apply to another line, or to a policy whose line is unknown", () => {
    expect(treatyApplies(treaty, { ...policy, line: "home" })).toBe(false);
    expect(treatyApplies(treaty, { ...policy, line: null })).toBe(false);
  });

  it("does not apply when it is not active", () => {
    for (const status of ["draft", "closed"]) expect(treatyApplies({ ...treaty, status }, policy)).toBe(false);
  });

  it("does not apply across currencies: a cession is posted in the policy's currency", () => {
    expect(treatyApplies(treaty, { ...policy, currency: "USD" })).toBe(false);
  });

  it("attaches on the policy's start: from inclusive, to exclusive", () => {
    expect(treatyApplies(treaty, { ...policy, startAt: 100 })).toBe(true);
    expect(treatyApplies(treaty, { ...policy, startAt: 99 })).toBe(false);
    expect(treatyApplies(treaty, { ...policy, startAt: 199 })).toBe(true);
    expect(treatyApplies(treaty, { ...policy, startAt: 200 })).toBe(false);
  });
});

describe("the invariants, for any premium, risk and treaty set", () => {
  const treatyArb: fc.Arbitrary<TreatyTerms> = fc.oneof(
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 4 }),
      kind: fc.constant("quota_share" as const),
      cededSharePpm: fc.integer({ min: 1, max: 1_000_000 }),
      limitMinor: fc.option(fc.integer({ min: 1, max: 1e12 }), { nil: null }),
      cedingCommissionPpm: fc.integer({ min: 0, max: 1_000_000 })
    }),
    fc.record({
      id: fc.string({ minLength: 1, maxLength: 4 }),
      kind: fc.constant("surplus" as const),
      retentionMinor: fc.integer({ min: 1, max: 1e12 }),
      lines: fc.integer({ min: 1, max: 30 }),
      cedingCommissionPpm: fc.integer({ min: 0, max: 1_000_000 })
    })
  );

  it("ceded + retained is the premium; every leg is whole and non-negative; commission + payable is the ceded premium", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e12 }),
        fc.option(fc.integer({ min: 0, max: 1e13 }), { nil: null }),
        fc.array(treatyArb, { maxLength: 4 }),
        (premiumMinor, sumInsuredMinor, treaties) => {
          const plan = planCessions({ premiumMinor, sumInsuredMinor, treaties });
          const ceded = plan.cessions.reduce((s, c) => s + c.cededPremiumMinor, 0);
          expect(ceded + plan.retainedPremiumMinor).toBe(premiumMinor);
          expect(plan.cessions.length + plan.skipped.length).toBe(treaties.length);
          let left = premiumMinor;
          for (const c of plan.cessions) {
            for (const v of [c.cededPremiumMinor, c.commissionMinor, c.netPayableMinor, c.retainedPremiumMinor]) {
              expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
            }
            expect(c.cededPremiumMinor).toBeGreaterThan(0);
            expect(c.commissionMinor + c.netPayableMinor).toBe(c.cededPremiumMinor);
            left -= c.cededPremiumMinor;
            expect(c.retainedPremiumMinor).toBe(left);
          }
          if (sumInsuredMinor !== null) {
            const cededSi = plan.cessions.reduce((s, c) => s + (c.cededSumInsuredMinor ?? 0), 0);
            expect(cededSi).toBeLessThanOrEqual(sumInsuredMinor);
          }
        }
      ),
      { numRuns: 500 }
    );
  });
});

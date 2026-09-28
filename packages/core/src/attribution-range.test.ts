import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ATTRIBUTION_CONFIDENCE, cacRange, poissonCdf, poissonInterval } from "./attribution-range.js";

// docs/17 SIG-057, ADR-0109: cost per acquisition reported as a range whose
// method is named. The reference values are Garwood's exact Poisson interval
// as tabulated (e.g. Ulm 1990; the chi-square form 0.5*chi2(a/2, 2k) and
// 0.5*chi2(1-a/2, 2k+2)), to four decimals.

describe("poissonCdf", () => {
  it("is exact against hand-worked values", () => {
    expect(poissonCdf(0, 1)).toBeCloseTo(Math.exp(-1), 12);
    expect(poissonCdf(1, 1)).toBeCloseTo(2 * Math.exp(-1), 12);
    expect(poissonCdf(2, 3)).toBeCloseTo(Math.exp(-3) * (1 + 3 + 4.5), 12);
  });

  it("is 1 for a zero mean and never exceeds 1", () => {
    expect(poissonCdf(0, 0)).toBe(1);
    expect(poissonCdf(5, 0)).toBe(1);
    expect(poissonCdf(50, 3)).toBeLessThanOrEqual(1);
    expect(poissonCdf(50, 3)).toBeCloseTo(1, 12);
  });

  it("stays finite where a naive e^-mu underflows", () => {
    const p = poissonCdf(1_000, 1_000);
    expect(p).toBeGreaterThan(0.5);
    expect(p).toBeLessThan(0.52);
  });

  it("falls as the mean rises, for a fixed count", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.double({ min: 0.01, max: 300, noNaN: true }), (k, mu) => {
        expect(poissonCdf(k, mu * 1.1)).toBeLessThanOrEqual(poissonCdf(k, mu) + 1e-12);
      })
    );
  });

  it("refuses a count or mean it cannot mean", () => {
    expect(() => poissonCdf(-1, 1)).toThrow(RangeError);
    expect(() => poissonCdf(1.5, 1)).toThrow(RangeError);
    expect(() => poissonCdf(1, -0.1)).toThrow(RangeError);
    expect(() => poissonCdf(1, Number.NaN)).toThrow(RangeError);
  });
});

describe("poissonInterval (Garwood exact)", () => {
  it.each([
    [0, 0, 3.6889],
    [1, 0.0253, 5.5716],
    [5, 1.6235, 11.6683],
    [10, 4.7954, 18.3904],
    [100, 81.3639, 121.6268]
  ])("k=%i at 95%% is [%f, %f]", (k, lower, upper) => {
    const ci = poissonInterval(k, 0.95);
    expect(ci.lower).toBeCloseTo(lower, 3);
    expect(ci.upper).toBeCloseTo(upper, 3);
  });

  it("widens as the confidence asked for rises", () => {
    const ninety = poissonInterval(10, 0.9);
    const ninetyNine = poissonInterval(10, 0.99);
    expect(ninety.lower).toBeCloseTo(5.4254, 3);
    expect(ninety.upper).toBeCloseTo(16.9622, 3);
    expect(ninetyNine.lower).toBeLessThan(ninety.lower);
    expect(ninetyNine.upper).toBeGreaterThan(ninety.upper);
  });

  it("defaults to the documented 95%", () => {
    expect(ATTRIBUTION_CONFIDENCE).toBe(0.95);
    expect(poissonInterval(3)).toEqual(poissonInterval(3, 0.95));
  });

  it("brackets the count, strictly for any count above zero", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (k) => {
        const ci = poissonInterval(k);
        expect(ci.lower).toBeGreaterThan(0);
        expect(ci.lower).toBeLessThan(k);
        expect(ci.upper).toBeGreaterThan(k);
      })
    );
  });

  it("each bound solves its own tail equation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), (k) => {
        const ci = poissonInterval(k, 0.95);
        expect(poissonCdf(k, ci.upper)).toBeCloseTo(0.025, 6);
        expect(1 - poissonCdf(k - 1, ci.lower)).toBeCloseTo(0.025, 6);
      })
    );
  });

  it("narrows relative to the count as the count grows", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000 }), fc.integer({ min: 1, max: 1_000 }), (k, extra) => {
        const small = poissonInterval(k);
        const big = poissonInterval(k + extra);
        expect((big.upper - big.lower) / (k + extra)).toBeLessThan((small.upper - small.lower) / k);
      })
    );
  });

  it("refuses a confidence outside (0, 1)", () => {
    expect(() => poissonInterval(3, 0)).toThrow(RangeError);
    expect(() => poissonInterval(3, 1)).toThrow(RangeError);
    expect(() => poissonInterval(3, Number.NaN)).toThrow(RangeError);
    expect(() => poissonInterval(-1)).toThrow(RangeError);
  });
});

describe("cacRange", () => {
  it("names no range for zero conversions — there is nothing to price", () => {
    expect(cacRange({ spendMinor: 50_000, conversions: 0 })).toBeNull();
    expect(cacRange({ spendMinor: 0, conversions: 0 })).toBeNull();
  });

  it("inverts the count interval into a cost interval, rounded outward", () => {
    // 10 binds on AED 1,000.00: counts [4.7954, 18.3904].
    const range = cacRange({ spendMinor: 100_000, conversions: 10 });
    expect(range).toEqual({
      low: Math.floor(100_000 / poissonInterval(10).upper),
      point: 10_000,
      high: Math.ceil(100_000 / poissonInterval(10).lower),
      method: "poisson_exact",
      methodKey: "attribution.method.poisson_exact",
      confidence: 0.95,
      conversions: { low: 10, point: 10, high: 10 },
      countInterval: { lower: expect.closeTo(4.7954, 3), upper: expect.closeTo(18.3904, 3) }
    });
    expect(range!.low).toBe(5_437);
    expect(range!.high).toBe(20_854);
  });

  it("widens to the credit envelope when models disagree on which binds count", () => {
    const envelope = cacRange({ spendMinor: 100_000, conversions: 10, creditLow: 6, creditHigh: 14 })!;
    const plain = cacRange({ spendMinor: 100_000, conversions: 10 })!;
    expect(envelope.method).toBe("poisson_exact_credit_envelope");
    expect(envelope.methodKey).toBe("attribution.method.poisson_exact_credit_envelope");
    expect(envelope.point).toBe(plain.point);
    expect(envelope.low).toBe(Math.floor(100_000 / poissonInterval(14).upper));
    expect(envelope.high).toBe(Math.ceil(100_000 / poissonInterval(6).lower));
    expect(envelope.conversions).toEqual({ low: 6, point: 10, high: 14 });
    expect(envelope.countInterval.lower).toBe(poissonInterval(6).lower);
    expect(envelope.countInterval.upper).toBe(poissonInterval(14).upper);
  });

  it("keeps the plain method when the credit bounds agree with the point", () => {
    expect(cacRange({ spendMinor: 1_000, conversions: 4, creditLow: 4, creditHigh: 4 })!.method).toBe("poisson_exact");
  });

  it("has no upper bound when some model credits nothing", () => {
    const range = cacRange({ spendMinor: 100_000, conversions: 2, creditLow: 0, creditHigh: 3 })!;
    expect(range.high).toBeNull();
    expect(range.low).toBe(Math.floor(100_000 / poissonInterval(3).upper));
    expect(range.countInterval.lower).toBe(0);
  });

  it("prices free acquisitions at zero across the whole range", () => {
    expect(cacRange({ spendMinor: 0, conversions: 3 })).toMatchObject({ low: 0, point: 0, high: 0 });
  });

  it("carries the confidence it was asked for", () => {
    const range = cacRange({ spendMinor: 100_000, conversions: 10, confidence: 0.9 })!;
    expect(range.confidence).toBe(0.9);
    expect(range.high).toBe(Math.ceil(100_000 / poissonInterval(10, 0.9).lower));
  });

  it("refuses inputs that are not counts or money", () => {
    expect(() => cacRange({ spendMinor: -1, conversions: 1 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1.5, conversions: 1 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: 1.5 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: -1 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: 3, creditLow: 4 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: 3, creditHigh: 2 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: 3, creditLow: -1 })).toThrow(RangeError);
    expect(() => cacRange({ spendMinor: 1, conversions: 3, creditHigh: 3.5 })).toThrow(RangeError);
  });

  const inputs = fc
    .record({
      spendMinor: fc.integer({ min: 0, max: 1_000_000_000 }),
      conversions: fc.integer({ min: 1, max: 500 }),
      below: fc.integer({ min: 0, max: 500 }),
      above: fc.integer({ min: 0, max: 500 })
    })
    .map(({ spendMinor, conversions, below, above }) => ({
      spendMinor,
      conversions,
      creditLow: Math.max(0, conversions - below),
      creditHigh: conversions + above
    }));

  it("orders its bounds and holds the point inside them", () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const range = cacRange(input)!;
        expect(range.low).toBeLessThanOrEqual(range.point);
        if (range.high !== null) expect(range.point).toBeLessThanOrEqual(range.high);
        expect(range.low).toBeGreaterThanOrEqual(0);
      })
    );
  });

  it("is never narrower than the plain count interval", () => {
    fc.assert(
      fc.property(inputs, (input) => {
        const envelope = cacRange(input)!;
        const plain = cacRange({ spendMinor: input.spendMinor, conversions: input.conversions })!;
        expect(envelope.low).toBeLessThanOrEqual(plain.low);
        if (envelope.high !== null) expect(envelope.high).toBeGreaterThanOrEqual(plain.high!);
      })
    );
  });

  it("narrows, relative to its point, as conversions grow at a fixed cost", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 }), fc.integer({ min: 1, max: 500 }), (k, extra) => {
        const unit = 1_000_000;
        const small = cacRange({ spendMinor: unit * k, conversions: k })!;
        const big = cacRange({ spendMinor: unit * (k + extra), conversions: k + extra })!;
        expect((big.high! - big.low) / big.point).toBeLessThan((small.high! - small.low) / small.point);
      })
    );
  });
});

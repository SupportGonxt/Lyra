import { describe, expect, it } from "vitest";
import { dayIntoMonth, dayKey, dayName, dayStart, monthKey, monthName, monthStart, quarterKey } from "./period.js";

// The seed's own clock: every label below is what the demo used to hard-code,
// so a drift here is a demo that narrates the wrong month.
const T0 = Date.UTC(2026, 0, 6, 8, 0, 0);

describe("period keys", () => {
  it("names days around the clock", () => {
    expect(dayKey(T0)).toBe("2026-01-06");
    expect(dayKey(T0, -1)).toBe("2026-01-05");
    expect(dayKey(T0, -6)).toBe("2025-12-31");
    expect(dayStart(T0)).toBe(Date.UTC(2026, 0, 6));
    expect(dayStart(T0, -5)).toBe(Date.UTC(2026, 0, 1));
  });

  it("names months around the clock", () => {
    expect(monthKey(T0)).toBe("2026-01");
    expect(monthKey(T0, -1)).toBe("2025-12");
    expect(monthKey(T0, -3)).toBe("2025-10");
    expect(monthKey(T0, 5)).toBe("2026-06");
    expect(monthStart(T0, 1)).toBe(Date.UTC(2026, 1, 1));
  });

  it("spells a month for the locale reading it", () => {
    expect(monthName(T0, -1)).toBe("December");
    expect(monthName(T0, -2)).toBe("November");
    expect(monthName(T0, -1, "ar-AE")).toBe("ديسمبر");
  });

  it("writes a date day-first, the way the demo's prose does", () => {
    expect(dayName(T0)).toBe("6 January");
    expect(dayName(T0 - 6 * 86_400_000)).toBe("31 December");
  });

  it("never lands a seed timestamp after the clock that minted it", () => {
    // T0 is day 6 of its month: `monthStart(T0, 0) + 3*DAY` (day 4) is
    // ordinary, already-past arithmetic here — the bug this guards is a seed
    // run on, say, day 2 of a month asking for "3 days into this month",
    // which is a future timestamp, not a past one.
    expect(dayIntoMonth(T0, 0, 3)).toBe(monthStart(T0, 0) + 3 * 86_400_000);
    // Day 2 of January: "8 days into this month" would be January 9th,
    // three days after T2 itself.
    const T2 = Date.UTC(2026, 0, 2, 8, 0, 0);
    expect(dayIntoMonth(T2, 0, 8)).toBeLessThan(T2);
    expect(dayIntoMonth(T2, 0, 8)).toBe(T2 - 86_400_000);
    // The 1st itself: every offset is "in the future" relative to month
    // start, the exact shape that broke north-snapshotter.test.ts and
    // e2e/axis-lifecycle.spec.ts on 2026-10-01.
    const T1 = Date.UTC(2026, 0, 1, 8, 0, 0);
    expect(dayIntoMonth(T1, 0, 9)).toBeLessThan(T1);
  });

  it("walks quarters back into the previous year", () => {
    expect(quarterKey(T0)).toBe("2026-Q1");
    expect(quarterKey(T0, -1)).toBe("2025-Q4");
    expect(quarterKey(T0, -5)).toBe("2024-Q4");
    expect(quarterKey(T0, 4)).toBe("2027-Q1");
  });
});

import { describe, expect, it } from "vitest";
import { isClosedPeriod, periodBounds, periodOf, previousPeriod } from "./north-period.js";

const at = (iso: string): number => Date.parse(iso);

describe("periodOf", () => {
  it("labels a timestamp by the period that contains it", () => {
    expect(periodOf("day", at("2026-03-01T23:59:59.999Z"))).toBe("2026-03-01");
    expect(periodOf("month", at("2026-03-01T00:00:00.000Z"))).toBe("2026-03");
  });
});

describe("previousPeriod", () => {
  it("walks a day back across a month boundary", () => {
    expect(previousPeriod("day", "2026-03-01")).toBe("2026-02-28");
  });

  it("walks a day back across a leap day", () => {
    expect(previousPeriod("day", "2024-03-01")).toBe("2024-02-29");
  });

  it("walks a month back across a year boundary", () => {
    expect(previousPeriod("month", "2026-01")).toBe("2025-12");
  });

  it("walks a month back inside a year", () => {
    expect(previousPeriod("month", "2026-03")).toBe("2026-02");
  });
});

describe("periodBounds", () => {
  it("is half-open: a day ends where the next one starts", () => {
    const march1 = periodBounds("day", "2026-03-01");
    expect(march1.since).toBe(at("2026-03-01T00:00:00.000Z"));
    expect(march1.until).toBe(at("2026-03-02T00:00:00.000Z"));
  });

  it("gives a month its real length, February included", () => {
    expect(periodBounds("month", "2026-02")).toEqual({
      since: at("2026-02-01T00:00:00.000Z"),
      until: at("2026-03-01T00:00:00.000Z")
    });
  });

  it("rolls a December month into the next year", () => {
    expect(periodBounds("month", "2025-12").until).toBe(at("2026-01-01T00:00:00.000Z"));
  });
});

describe("isClosedPeriod", () => {
  it("a period is closed only once its whole window has elapsed", () => {
    expect(isClosedPeriod("month", "2026-02", at("2026-02-28T23:59:59.999Z"))).toBe(false);
    expect(isClosedPeriod("month", "2026-02", at("2026-03-01T00:00:00.000Z"))).toBe(true);
    expect(isClosedPeriod("day", "2026-03-01", at("2026-03-01T12:00:00.000Z"))).toBe(false);
    expect(isClosedPeriod("day", "2026-03-01", at("2026-03-02T00:00:00.001Z"))).toBe(true);
  });
});

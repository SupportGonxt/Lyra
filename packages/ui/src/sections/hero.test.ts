/**
 * The hero counts a headline figure up from zero, which means parsing a
 * tenant-supplied string with a regex. CodeQL js/polynomial-redos flagged two
 * versions of it: `\D*` and `[\d,]+` both match a comma (alert 12), and then a
 * trailing `(.*)$` that fails on a newline sends the engine back to retry every
 * shorter numeral (alert 13). The pattern now ends at the numeral and the caller
 * slices the suffix.
 */
import { describe, expect, it } from "vitest";
import { countFrame, countable, splitHeadline } from "./hero.js";

describe("splitHeadline", () => {
  it("splits a real headline into prefix, numeral and suffix", () => {
    expect(splitHeadline("AED 1,240,500")).toEqual({ prefix: "AED ", numStr: "1,240,500", suffix: "" });
    expect(splitHeadline("4.2m")).toEqual({ prefix: "", numStr: "4.2", suffix: "m" });
    expect(splitHeadline("98.5%")).toEqual({ prefix: "", numStr: "98.5", suffix: "%" });
    expect(splitHeadline("$12")).toEqual({ prefix: "$", numStr: "12", suffix: "" });
  });

  it("declines a value with no numeral rather than inventing one", () => {
    expect(splitHeadline("no data yet")).toBeUndefined();
    expect(splitHeadline("")).toBeUndefined();
  });

  it("stays linear on the strings that made the old patterns backtrack", () => {
    // 50k commas, and the same again with a newline the old `(.*)$` could not
    // cross. Either overlap reintroduced blows the budget rather than merely
    // slowing.
    for (const hostile of [",".repeat(50_000) + "x", ",".repeat(50_000) + "\n"]) {
      const started = performance.now();
      splitHeadline(hostile);
      expect(performance.now() - started).toBeLessThan(1_000);
    }
  });

  it("keeps a suffix that contains a newline", () => {
    expect(splitHeadline("12\nrows")).toEqual({ prefix: "", numStr: "12", suffix: "\nrows" });
  });
});

describe("countFrame", () => {
  it("lands the animation back on the string the caller wrote", () => {
    // The last frame runs at eased === 1, so whatever it formats is what the
    // chip is left showing for the rest of the session.
    for (const value of ["AED 1,240,500", "4.2", "98.5", "12", "2026-08-12", "2026"]) {
      const parts = splitHeadline(value);
      expect(parts, `${value} carries a numeral`).toBeDefined();
      const { prefix, numStr, suffix } = parts!;
      expect(`${prefix}${countFrame(numStr, Number(numStr.replace(/,/g, "")))}${suffix}`).toBe(value);
    }
  });

  it("groups a grouped numeral and leaves a bare one alone", () => {
    // A NORTH briefing's date chip reads "2026-08-12". Grouped, it settles on
    // "2,026-08-12" — the bug this function exists to prevent.
    expect(countFrame("2026", 2026)).toBe("2026");
    expect(countFrame("1,240,500", 1_240_500)).toBe("1,240,500");
  });

  it("keeps the caller's decimals mid-flight", () => {
    expect(countFrame("4.20", 2.1)).toBe("2.10");
    expect(countFrame("61", 30.4)).toBe("30");
  });
});

describe("countable", () => {
  // A date or an identifier is not a quantity: counting "2026-09-22" up from
  // zero put "1786-09-22" on screen mid-frame (journey/north).
  it("refuses dates, times and identifiers", () => {
    expect(countable("2026-09-22")).toBe(false);
    expect(countable("10:09")).toBe(false);
    expect(countable("GNX-2512")).toBe(false);
    expect(countable("2026/09")).toBe(false);
  });
  it("counts quantities, money and percentages", () => {
    expect(countable("AED 4,111.04")).toBe(true);
    expect(countable("42%")).toBe(true);
    expect(countable("12 cases")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  AGE_BANDS,
  SALARY_BANDS,
  ageAt,
  bandOf,
  detectColumns,
  diffCensus,
  normaliseCensus,
  rollupCensus,
  salaryMinorOf
} from "./census.js";

// docs/modules/axis.md §2.2: "any-format employee lists → canonical census with
// age-banding, salary bands, dependents; diff view against prior year." Nothing
// implemented it — a group scheme could be bound and there was no census.
//
// These hold the three decisions that make it trustworthy rather than merely
// working: an age is meaningless without a date, bands are declared rather than
// inferred, and a row that cannot be read is named rather than dropped.

const ASOF = Date.UTC(2026, 9, 1);

describe("the bands", () => {
  it("puts a value in the band whose upper bound it fits", () => {
    expect(bandOf(AGE_BANDS, 17)).toBe("0-17");
    expect(bandOf(AGE_BANDS, 18)).toBe("18-29");
    expect(bandOf(AGE_BANDS, 65)).toBe("65+");
    expect(bandOf(AGE_BANDS, 120)).toBe("65+");
  });

  it("has no band for a value below the floor, and does not invent one", () => {
    expect(bandOf(AGE_BANDS, -1)).toBeNull();
    expect(bandOf(AGE_BANDS, Number.NaN)).toBeNull();
  });

  it("declares salary bands in minor units, like every amount here", () => {
    expect(bandOf(SALARY_BANDS, 5_000_00)).toBe("under-5k");
    expect(bandOf(SALARY_BANDS, 5_000_01)).toBe("5k-15k");
  });

  it("prefers a date of birth, because an age cannot be re-aged at renewal", () => {
    // A member born 1986-10-02 is 39 on 2026-10-01 and 40 the next day: the same
    // row banded at two renewal dates, which is exactly why DOB is preferred.
    const born = Date.UTC(1986, 9, 2);
    expect(ageAt(born, ASOF)).toBe(39);
    expect(ageAt(born, Date.UTC(2026, 9, 2))).toBe(40);
  });
});

describe("reading a salary", () => {
  it("reads a bare number as major units, because that is what a spreadsheet holds", () => {
    expect(salaryMinorOf("12000")).toBe(1_200_000);
    expect(salaryMinorOf("12,000")).toBe(1_200_000);
    expect(salaryMinorOf("12000.50")).toBe(1_200_050);
    expect(salaryMinorOf("AED 12000")).toBe(1_200_000);
  });

  it("is null for a blank or unreadable cell rather than zero", () => {
    // Zero salary is a band ("under-5k") and would price a life as earning
    // nothing — a claim the file did not make.
    expect(salaryMinorOf("")).toBeNull();
    expect(salaryMinorOf(undefined)).toBeNull();
    expect(salaryMinorOf("n/a")).toBeNull();
  });
});

describe("detecting the columns", () => {
  it("finds the usual payroll headings in either separator style", () => {
    const { mapping, ambiguous } = detectColumns(["Employee No", "Date of Birth", "Basic Salary", "Dependants"]);
    expect(mapping).toMatchObject({ memberRef: "Employee No", dateOfBirth: "Date of Birth", salary: "Basic Salary", dependents: "Dependants" });
    expect(ambiguous).toEqual([]);
  });

  it("leaves a field unmapped when two columns both look like it", () => {
    // Guessing between two salary columns produces a plausible wrong answer,
    // which is worse than a named refusal.
    const { mapping, ambiguous } = detectColumns(["Name", "Salary", "Gross Salary"]);
    expect(ambiguous).toContain("salary");
    expect(mapping.salary).toBeUndefined();
  });
});

describe("normalising any-format lists", () => {
  it("reads a census and bands every life, without being told the columns", () => {
    const census = normaliseCensus(
      [
        ["Employee No", "Name", "Date of Birth", "Salary", "Dependents", "Relationship"],
        ["E1", "Rania", "1986-10-02", "24000", "3", "employee"],
        ["E2", "Omar", "1995-01-15", "9600", "0", "employee"],
        ["E3", "Layla", "1960-05-05", "90000", "1", "spouse"]
      ],
      { asOf: ASOF }
    );
    expect(census.problems).toEqual([]);
    expect(census.members.map((m) => [m.name, m.ageBand, m.salaryBand, m.dependents])).toEqual([
      ["Rania", "30-39", "15k-30k", 3],
      ["Omar", "30-39", "5k-15k", 0],
      ["Layla", "65+", "60k+", 1]
    ]);
    expect(census.members[0]!.salaryMinor).toBe(2_400_000);
    // 60 000 is exactly the top of `30k-60k`, so a value meant to reach the open
    // band has to be above it.
    expect(bandOf(SALARY_BANDS, 6_000_000)).toBe("30k-60k");
  });

  it("names every row it cannot read, with the number a reader can find", () => {
    // A census quietly one life short is a scheme priced on the wrong number.
    const census = normaliseCensus(
      [
        ["Name", "Age", "Dependents"],
        ["Rania", "34", "3"],
        ["", "40", "1"],
        ["Ahmed", "999", "0"],
        ["Sara", "30", "99"],
        ["Rania", "34", "3"]
      ],
      { asOf: ASOF }
    );
    expect(census.members.map((m) => m.name)).toEqual(["Rania"]);
    expect(census.problems.map((p) => p.row)).toEqual([3, 4, 5, 6]);
    expect(census.problems[0]!.reason).toContain("no name");
    expect(census.problems[1]!.reason).toContain("not a person");
    expect(census.problems[2]!.reason).toContain("not a household");
    expect(census.problems[3]!.reason).toContain("already used on row 2");
  });

  it("skips a blank line without calling it a problem", () => {
    const census = normaliseCensus([["Name", "Age"], ["Rania", "34"], ["", ""]], { asOf: ASOF });
    expect(census.members).toHaveLength(1);
    expect(census.problems).toEqual([]);
  });

  it("refuses a headerless file it was not told how to read", () => {
    const census = normaliseCensus([["Rania", "34"]], { asOf: ASOF });
    expect(census.members).toEqual([]);
    expect(census.problems[0]!.reason).toContain("no column looks like a name");
  });

  it("reads a headerless file when the mapping is given", () => {
    const census = normaliseCensus([["E1", "Rania", "34"]], { asOf: ASOF, headerless: true, mapping: { memberRef: "col0", name: "col1", age: "col2" } });
    expect(census.members).toEqual([]);
  });
});

describe("the roll-up", () => {
  it("counts lives per band, dependents and what a scheme cannot price", () => {
    const census = normaliseCensus(
      [
        ["Name", "Age", "Salary", "Dependents"],
        ["Rania", "34", "24000", "3"],
        ["Omar", "34", "", "0"],
        ["Layla", "", "60000", "1"]
      ],
      { asOf: ASOF }
    );
    const roll = rollupCensus(census);
    expect(roll.lives).toBe(3);
    expect(roll.byAgeBand["30-39"]).toBe(2);
    expect(roll.byAgeBand["65+"]).toBe(0);
    expect(roll.dependents).toBe(4);
    expect(roll.averageDependents).toBe(1.3);
    // Two members carry only one of the two banded dimensions.
    expect(roll.unpriced).toBe(2);
  });

  it("has no average for an empty census rather than a zero", () => {
    expect(rollupCensus({ asOf: ASOF, members: [], problems: [], mapping: {} }).averageDependents).toBeNull();
  });
});

describe("the diff against last year", () => {
  const list = (rows: (readonly string[])[]) => normaliseCensus([["Name", "Date of Birth", "Salary", "Dependents"], ...rows], { asOf: ASOF });

  it("calls an aged life movement, not churn", () => {
    // A member who turned 40 is the same person. Reporting them as removed and
    // added would make every birthday look like a loss.
    // Born mid-1987: 39 on the prior date, 40 on the next — so the band moves.
    const prior = list([["Rania", "1987-06-01", "24000", "3"]]);
    const current = normaliseCensus([["Name", "Date of Birth", "Salary", "Dependents"], ["Rania", "1987-06-01", "24000", "3"]], { asOf: Date.UTC(2027, 9, 1) });
    const diff = diffCensus(prior, current);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.moved).toEqual([{ memberRef: "rania", name: "Rania", from: "30-39", to: "40-49", what: "age" }]);
    expect(diff.unchanged).toBe(0);
  });

  it("reports a new life, a left life and a changed household separately", () => {
    const prior = list([["Rania", "1986-10-01", "24000", "3"], ["Omar", "1995-01-15", "9600", "0"]]);
    const current = list([["Rania", "1986-10-01", "24000", "4"], ["Layla", "1960-05-05", "90000", "1"]]);
    const diff = diffCensus(prior, current);
    expect(diff.added.map((m) => m.name)).toEqual(["Layla"]);
    expect(diff.removed.map((m) => m.name)).toEqual(["Omar"]);
    expect(diff.dependentsChanged).toEqual([{ memberRef: "rania", name: "Rania", from: 3, to: 4 }]);
    expect(diff.unchanged).toBe(0);
  });

  it("counts a life nothing moved in as unchanged", () => {
    const prior = list([["Rania", "1986-10-01", "24000", "3"]]);
    const diff = diffCensus(prior, list([["Rania", "1986-10-01", "24000", "3"]]));
    expect(diff).toMatchObject({ unchanged: 1 });
    expect(diff.moved).toEqual([]);
  });
});

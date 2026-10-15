import { describe, expect, it } from "vitest";
import { parseCensusText, parseDelimited, sniffDelimiter } from "./census-text.js";

// The census normaliser (#/v1/axis/census/normalise) takes rows; a screen gets
// text. Everything that can go wrong between the two lives here, so it is a pure
// function under test rather than three lines inside a loader.

describe("sniffDelimiter", () => {
  it("reads a tab as a spreadsheet paste, whatever else is in the line", () => {
    expect(sniffDelimiter("Name\tAge, years\tSalary")).toBe("\t");
  });

  it("compares the comma and the semicolon on the header, not the data", () => {
    // A European export: semicolons separate, and the addresses below are full
    // of commas that must not win the vote.
    expect(sniffDelimiter("Name;Age;Address\nRania;34;Dubai, Marina, Tower 2")).toBe(";");
    expect(sniffDelimiter("Name,Age,Salary")).toBe(",");
  });
});

describe("parseDelimited", () => {
  it("keeps a delimiter inside a quoted cell", () => {
    // `Al Farsi, Ahmed` is one name, and splitting it invents a column.
    expect(parseDelimited('Name,Age\n"Al Farsi, Ahmed",34', ",")).toEqual([["Name", "Age"], ["Al Farsi, Ahmed", "34"]]);
  });

  it("reads a doubled quote inside a quoted cell as one quote", () => {
    expect(parseDelimited('Name\n"Al ""Farsi"" Ahmed"', ",")).toEqual([["Name"], ['Al "Farsi" Ahmed']]);
  });

  it("treats CRLF and LF as the same line break", () => {
    expect(parseDelimited("Name,Age\r\nRania,34", ",")).toEqual([["Name", "Age"], ["Rania", "34"]]);
  });

  it("keeps an empty middle row, so the normaliser's row numbers stay true to the sheet", () => {
    expect(parseDelimited("Name\nRania\n\nOmar", ",")).toEqual([["Name"], ["Rania"], [""], ["Omar"]]);
  });

  it("does not invent a trailing row for a file that ends in a newline", () => {
    expect(parseDelimited("Name\nRania\n", ",")).toEqual([["Name"], ["Rania"]]);
  });
});

describe("parseCensusText", () => {
  it("reads the paste an operator actually makes, trailing blank line and all", () => {
    expect(parseCensusText("Employee No\tName\tSalary\nE1\tRania\t24000\n\n")).toEqual([
      ["Employee No", "Name", "Salary"],
      ["E1", "Rania", "24000"]
    ]);
  });

  it("is empty for an empty paste rather than one blank row", () => {
    // The screen shows "paste a list" for this; a single blank row would read as
    // a list with one unreadable member.
    expect(parseCensusText("   \n  ")).toEqual([]);
  });
});

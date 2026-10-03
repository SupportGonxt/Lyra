import { describe, expect, it } from "vitest";
import { hasData } from "./adoption-verdict.mjs";

// role-adoption.mjs scored a screen "no data" whenever it held no table row
// or figure, or held any empty state at all. That called a list of 34 claim
// cards empty, and called an empty state that hands the reader their next
// move as bad as one that abandons them. A screen shows data when it shows
// rows, figures, list items or cards — or, having none, offers the action
// that makes some. Only a bare empty state with nothing beside it is empty.

const measured = (over) => ({ rows: 0, stats: 0, items: 0, guided: 0, bare: 0, ...over });

describe("hasData", () => {
  it("counts table rows, figures and list items or cards", () => {
    expect(hasData(measured({ rows: 3 }))).toBe(true);
    expect(hasData(measured({ stats: 2 }))).toBe(true);
    expect(hasData(measured({ items: 34 }))).toBe(true);
  });

  it("counts an empty state that offers an action", () => {
    expect(hasData(measured({ guided: 1 }))).toBe(true);
  });

  it("does not count a bare empty state", () => {
    expect(hasData(measured({ bare: 1 }))).toBe(false);
    expect(hasData(measured({ bare: 1, guided: 1 }))).toBe(false);
  });

  it("lets real data outweigh a bare empty panel beside it", () => {
    expect(hasData(measured({ rows: 5, bare: 1 }))).toBe(true);
  });

  it("calls a screen with nothing at all empty", () => {
    expect(hasData(measured({}))).toBe(false);
    expect(hasData(null)).toBe(false);
  });
});

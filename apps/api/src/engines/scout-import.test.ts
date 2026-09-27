import { describe, expect, it } from "vitest";
import { parseSignalCsv } from "./scout-import.js";

// @accept:SA — SCOUT's own signals from a file, so a tenant that bought SCOUT
// alone has a market to read. The file goes through the same harvest path as a
// fed item (ADR-0078: nothing here fetches from outside Lyra); this is the part
// that decides what a line means.

const NOW = Date.UTC(2026, 8, 26);

describe("parseSignalCsv", () => {
  it("reads the kind, the reference, the day and the weight, and keeps every other column as the payload", () => {
    const out = parseSignalCsv("source,sourceRef,observedAt,weight,line,term\nsearch,q-1,2026-09-20,3,motor,cheap car insurance\nreviews,r-9,2026-09-21,,home,\n", NOW);
    expect(out.errors).toEqual([]);
    expect(out.items).toEqual([
      { source: "search", sourceRef: "q-1", observedAt: Date.UTC(2026, 8, 20), weight: 3, payload: { line: "motor", term: "cheap car insurance" } },
      { source: "reviews", sourceRef: "r-9", observedAt: Date.UTC(2026, 8, 21), weight: 1, payload: { line: "home" } }
    ]);
  });

  it("names every line it refuses: an unknown kind, no reference, a day that is not a day or is in the future, a silly weight", () => {
    const out = parseSignalCsv(
      "source,sourceRef,observedAt,weight\ngossip,a,2026-09-20,\nsearch,,2026-09-20,\nsearch,c,yesterday,\nsearch,d,2027-01-01,\nsearch,e,2026-09-20,5000\nsearch,f,2026-09-20,\n",
      NOW
    );
    expect(out.errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(out.items.map((i) => i.sourceRef)).toEqual(["f"]);
  });

  it("refuses a file with no source column before reading a line", () => {
    expect(parseSignalCsv("sourceRef,observedAt\na,2026-09-20\n", NOW).errors[0]).toMatchObject({ line: 1, error: "missing column source" });
  });
});

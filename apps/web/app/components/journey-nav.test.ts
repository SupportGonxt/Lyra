import { describe, expect, it } from "vitest";
import { counted, journeyContext, journeyLabels, lineName, stepHref, STEPS } from "./journey-nav";

// The flagship journey (docs/28 §2) is one thread of context carried in the URL.
// The step list used to be four badges nobody could click, named with internal
// codenames ("AXIS", "NORTH") no reader is ever shown anywhere else, and every
// count on the four screens was an English `case${n === 1 ? "" : "s"}` — which
// has no Arabic at all, where a count takes one of six forms.

describe("stepHref", () => {
  it("carries every piece of context the journey has learned, and nothing else", () => {
    const search = "?productLine=motor&briefingId=brf_1&utm=x&whitespaceId=wsp_2&subject=EV%20cover";
    expect(stepHref("north", search)).toBe(
      "/journey/north?productLine=motor&briefingId=brf_1&whitespaceId=wsp_2&subject=EV+cover"
    );
  });

  it("drops empty values rather than carrying `productLine=`", () => {
    expect(stepHref("scout", "?productLine=&briefingId=brf_1")).toBe("/journey/scout?briefingId=brf_1");
    expect(stepHref("axis", "")).toBe("/journey/axis");
  });

  it("sets and clears context on the way forward", () => {
    const next = stepHref("signal", "?productLine=motor&whitespaceId=old", { whitespaceId: "wsp_9", subject: "Home" });
    expect(next).toBe("/journey/signal?productLine=motor&whitespaceId=wsp_9&subject=Home");
    expect(stepHref("scout", "?productLine=motor&whitespaceId=old", { whitespaceId: null })).toBe(
      "/journey/scout?productLine=motor"
    );
  });

  it("reads a URLSearchParams as well as a string", () => {
    expect(journeyContext(new URLSearchParams({ productLine: "home", other: "x" })).toString()).toBe("productLine=home");
  });

  it("walks the four steps in the documented order", () => {
    expect([...STEPS]).toEqual(["axis", "north", "scout", "signal"]);
  });
});

describe("step labels", () => {
  it("names each step the way the module rail does, never by codename", () => {
    for (const locale of ["en", "ar"]) {
      const l = journeyLabels({})(locale);
      for (const step of STEPS) {
        const name = l(`step.${step}`);
        expect(name).not.toBe(`step.${step}`);
        expect(name).not.toMatch(/AXIS|NORTH|SCOUT|SIGNAL/);
      }
    }
    const en = journeyLabels({})("en");
    expect(STEPS.map((s) => en(`step.${s}`))).toEqual(["Operations", "Insight", "Market", "Marketing"]);
  });

  it("lets a route's own table win over the shared journey table", () => {
    const l = journeyLabels({ en: { "step.axis": "Mine" }, ar: {} })("en");
    expect(l("step.axis")).toBe("Mine");
    expect(l("step.north")).toBe("Insight");
  });
});

describe("counted", () => {
  const TABLE = {
    en: { "case.one": "{n} case", "case.other": "{n} cases" },
    ar: {
      "case.zero": "لا حالات",
      "case.one": "حالة واحدة",
      "case.two": "حالتان",
      "case.few": "{n} حالات",
      "case.many": "{n} حالة",
      "case.other": "{n} حالة"
    }
  };

  it("uses the English one/other split", () => {
    const l = journeyLabels(TABLE)("en");
    expect(counted(l, "case", 1, "en")).toBe("1 case");
    expect(counted(l, "case", 0, "en")).toBe("0 cases");
    expect(counted(l, "case", 1200, "en")).toBe("1,200 cases");
  });

  it("uses all six Arabic plural forms", () => {
    const l = journeyLabels(TABLE)("ar");
    const n = (v: number) => new Intl.NumberFormat("ar").format(v);
    expect(counted(l, "case", 0, "ar")).toBe("لا حالات");
    expect(counted(l, "case", 1, "ar")).toBe("حالة واحدة");
    expect(counted(l, "case", 2, "ar")).toBe("حالتان");
    expect(counted(l, "case", 3, "ar")).toBe(`${n(3)} حالات`);
    expect(counted(l, "case", 11, "ar")).toBe(`${n(11)} حالة`);
    expect(counted(l, "case", 100, "ar")).toBe(`${n(100)} حالة`);
  });

  it("falls back to `other` when a locale's table lacks the form", () => {
    const l = journeyLabels({ en: { "x.other": "{n} things" } })("en");
    expect(counted(l, "x", 1, "en")).toBe("1 things");
  });
});

describe("lineName", () => {
  it("translates a known product line and humanises an unknown one", () => {
    expect(lineName(journeyLabels({})("ar"), "motor")).not.toBe("motor");
    expect(lineName(journeyLabels({})("en"), "motor")).toBe("Motor");
    expect(lineName(journeyLabels({})("en"), "pet_cover")).toBe("Pet cover");
    expect(lineName(journeyLabels({})("en"), "")).toBe("No product line");
  });
});

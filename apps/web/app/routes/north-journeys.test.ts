import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { headline, labelsIn, ranked, statusTone, type JourneyRow } from "./north-journeys";

const row = (id: string, status: JourneyRow["status"], completion: number | null): JourneyRow => ({
  id,
  persona: "x",
  steps: [
    { key: "a", count: 10 },
    { key: "b", count: 0 }
  ],
  completion,
  status,
  weekly: [0, 1]
});

describe("journey health screen", () => {
  it("puts what needs a person first: stalled, then the weakest flowing, then quiet", () => {
    const order = ranked([row("J-A", "quiet", null), row("J-B", "flowing", 0.9), row("J-C", "stalled", 0), row("J-D", "flowing", 0.2)]);
    expect(order.map((r) => r.id)).toEqual(["J-C", "J-D", "J-B", "J-A"]);
  });

  it("says how many stalled, in words", () => {
    const l = labelsIn("en");
    expect(headline([row("J-C", "stalled", 0)], l)).toBe("1 journey started and never finished");
    expect(headline([row("J-C", "stalled", 0), row("J-D", "stalled", 0)], l)).toBe("2 journeys started and never finished");
    expect(headline([row("J-B", "flowing", 1)], l)).toBe("Every journey people started, they finished");
    expect(headline([row("J-A", "quiet", null)], l)).toBe("No journey has moved in this window");
  });

  it("marks stalled as needing attention, never as danger", () => {
    expect(statusTone("stalled")).toBe("warning");
    expect(statusTone("flowing")).toBe("success");
    expect(statusTone("quiet")).toBe("neutral");
  });

  // The funnels are core's (packages/core/src/journey-health.ts); the web may
  // not import @lyra/core, so the ids and step keys are read from it as text.
  it("names every journey and step core measures, in both languages", () => {
    const core = readFileSync(new URL("../../../../packages/core/src/journey-health.ts", import.meta.url), "utf8");
    const ids = [...core.matchAll(/\{ id: "(J-[A-Z]+\d)"/g)].map((m) => m[1]!);
    const steps = [...new Set([...core.matchAll(/\{ key: "(\w+)", actions:/g)].map((m) => m[1]!))];
    expect(ids.length).toBeGreaterThan(10);
    expect(steps.length).toBeGreaterThan(10);
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      for (const id of ids) expect(l(id), `${locale} ${id}`).not.toBe(id);
      for (const key of steps) expect(l(`step.${key}`), `${locale} ${key}`).not.toBe(`step.${key}`);
    }
  });
});

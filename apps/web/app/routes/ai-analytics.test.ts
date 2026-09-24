import { describe, expect, it } from "vitest";
import { decodeDef } from "../analytics-def";
import { PANELS, figureHref, kpisOf, microToMinor, panelDefinitions, windowDays, type Panels } from "./ai-analytics";

// The AI operations dashboard reads only the AI datasets, only through
// POST /v1/analytics/run — the same definitions a reader can open in the
// builder. The fixtures are RunResult rows as runReport returns them.

const FROM = Date.UTC(2026, 5, 1);

describe("panelDefinitions", () => {
  const defs = panelDefinitions(FROM);

  it("reads only the AI datasets, each windowed from the same instant", () => {
    for (const key of PANELS) {
      expect(defs[key].dataset, key).toMatch(/^ai(Runs|Spend|Suggestions|Guardrails|Evals)$/);
      expect(defs[key].from, key).toBe(FROM);
    }
  });

  it("buckets every over-time panel by day and nothing else", () => {
    expect(defs.costByDay).toMatchObject({ dataset: "aiSpend", grain: "day" });
    expect(defs.runsByDay).toMatchObject({ dataset: "aiRuns", grain: "day" });
    expect(defs.evalsByDay).toMatchObject({ dataset: "aiEvals", grain: "day" });
    expect(defs.costByModule.grain).toBeUndefined();
  });
});

describe("figureHref", () => {
  it("opens the builder on exactly the definition the figure was drawn from, and runs it", () => {
    const def = panelDefinitions(FROM).costByModule;
    const href = figureHref(def);
    expect(href).toMatch(/^\/analytics\/builder\?def=[A-Za-z0-9_-]+&run=1$/);
    expect(decodeDef(new URL(href, "https://x.test").searchParams.get("def"))).toEqual(def);
  });
});

describe("windowDays", () => {
  it.each([
    [null, 30],
    ["7", 7],
    ["90", 90],
    ["31", 30],
    ["-7", 30],
    ["abc", 30]
  ])("reads %s as %s days", (raw, days) => {
    expect(windowDays(raw)).toBe(days);
  });
});

describe("microToMinor", () => {
  it("turns micro-units into minor units, 1,000,000 micro to 100 minor", () => {
    expect(microToMinor(1_000_000)).toBe(100);
    expect(microToMinor(4_999)).toBe(0);
    expect(microToMinor(5_000)).toBe(1);
  });
});

describe("kpisOf", () => {
  const one = (row: Record<string, unknown>) => ({ rows: [row] });

  it("reads each headline figure from its panel's one total row", () => {
    const panels: Partial<Panels> = {
      quality: one({ shown: 40, acceptanceRate: 55 }),
      spend: one({ calls: 12, costMicro: 3_000_000, refusalRate: 8, latency: 420 }),
      guardrails: one({ events: 9, blocks: 2 }),
      evals: one({ cases: 30, avgScore: 81, passRate: 90 })
    };
    expect(kpisOf(panels)).toEqual({
      acceptanceRate: 55,
      shown: 40,
      refusalRate: 8,
      calls: 12,
      costMinor: 300,
      latency: 420,
      blocks: 2,
      events: 9,
      passRate: 90,
      avgScore: 81
    });
  });

  it("says nothing — not zero — for a panel the reader may not see or that has no rows", () => {
    expect(kpisOf({ quality: null, spend: { rows: [] } })).toEqual({
      acceptanceRate: null,
      shown: null,
      refusalRate: null,
      calls: null,
      costMinor: null,
      latency: null,
      blocks: null,
      events: null,
      passRate: null,
      avgScore: null
    });
  });

  it("reads a rate over zero shown rows as no rate rather than 0%", () => {
    expect(kpisOf({ quality: one({ shown: 0, acceptanceRate: null }) }).acceptanceRate).toBeNull();
  });
});

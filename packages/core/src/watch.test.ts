import { describe, it, expect } from "vitest";
import { detectWatch, WATCH_WINDOW_MS, type WatchSignal } from "./watch.js";

const NOW = Date.UTC(2026, 8, 19);
const DAY = 86_400_000;
const recent = (days: number): number => NOW - days * DAY;
const prior = (days: number): number => NOW - WATCH_WINDOW_MS - days * DAY;

const sig = (over: Partial<WatchSignal> & Pick<WatchSignal, "id">): WatchSignal => ({
  source: "news",
  sourceRef: "competitor-a",
  weight: 1,
  observedAt: recent(2),
  ...over
});

describe("detectWatch", () => {
  it("ignores demand sources — those are the Clusterer's", () => {
    expect(
      detectWatch(
        [
          sig({ id: "s1", source: "quotes", sourceRef: "cus_1" }),
          sig({ id: "s2", source: "abandonment", sourceRef: "cus_1" }),
          sig({ id: "s3", source: "search", sourceRef: "ev cover" })
        ],
        NOW
      )
    ).toEqual([]);
  });

  it("a subject new to the watch is attention, a regulatory one urgent", () => {
    const found = detectWatch(
      [sig({ id: "s1" }), sig({ id: "s2", source: "regulatory", sourceRef: "circular-2026-11" })],
      NOW
    );
    const byKind = new Map(found.map((f) => [f.kind, f]));
    expect(byKind.get("competitor")!.severity).toBe("attention");
    expect(byKind.get("competitor")!.deltaPct).toBeNull();
    expect(byKind.get("regulatory")!.severity).toBe("urgent");
  });

  it("a doubling on real volume is urgent; a doubling of one item is not", () => {
    const loud = detectWatch(
      [
        sig({ id: "p1", observedAt: prior(1) }),
        sig({ id: "p2", observedAt: prior(2) }),
        sig({ id: "r1" }),
        sig({ id: "r2" }),
        sig({ id: "r3" }),
        sig({ id: "r4" })
      ],
      NOW
    );
    expect(loud[0]!.severity).toBe("urgent");
    expect(loud[0]!.deltaPct).toBe(100);

    const quiet = detectWatch([sig({ id: "p1", observedAt: prior(1) }), sig({ id: "r1" }), sig({ id: "r2" })], NOW);
    expect(quiet[0]!.severity).toBe("info");
    expect(quiet[0]!.count).toBe(2);
    expect(quiet[0]!.priorCount).toBe(1);
  });

  it("a subject that went quiet long ago is neither prior volume nor a collapse", () => {
    const found = detectWatch(
      [sig({ id: "ancient", observedAt: NOW - 5 * WATCH_WINDOW_MS }), sig({ id: "r1" })],
      NOW
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.priorCount).toBe(0);
    expect(found[0]!.signalIds).toEqual(["r1"]);
  });

  it("a subject with nothing in the current window is silence, not a finding", () => {
    expect(detectWatch([sig({ id: "p1", observedAt: prior(3) })], NOW)).toEqual([]);
  });

  it("orders urgent before attention before info", () => {
    const found = detectWatch(
      [
        sig({ id: "i1", sourceRef: "steady", observedAt: prior(1) }),
        sig({ id: "i2", sourceRef: "steady" }),
        sig({ id: "a1", sourceRef: "brand-new" }),
        sig({ id: "u1", source: "regulatory", sourceRef: "circular" })
      ],
      NOW
    );
    expect(found.map((f) => f.severity)).toEqual(["urgent", "attention", "info"]);
  });

  it("weights an observation rather than counting rows", () => {
    const found = detectWatch([sig({ id: "r1", weight: 5 })], NOW);
    expect(found[0]!.count).toBe(5);
  });
});

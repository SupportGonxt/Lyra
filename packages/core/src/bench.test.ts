import { describe, it, expect } from "vitest";
import { benchPeriod, buildPanelBench, median, type BenchQuote } from "./bench.js";

const AT = Date.UTC(2026, 4, 12, 9, 0, 0); // 2026-05

const quote = (over: Partial<BenchQuote> & Pick<BenchQuote, "requestId" | "providerId">): BenchQuote => ({
  line: "motor",
  state: "quoted",
  premiumMinor: 100_000,
  selectedAt: null,
  createdAt: AT,
  ...over
});

describe("benchPeriod", () => {
  it("is the UTC month, not the runner's", () => {
    expect(benchPeriod(Date.UTC(2026, 0, 1, 0, 30))).toBe("2026-01");
    expect(benchPeriod(Date.UTC(2025, 11, 31, 23, 30))).toBe("2025-12");
  });
});

describe("median", () => {
  it("takes the middle of an odd list and the mean of an even pair", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([10, 20])).toBe(15);
    expect(median([])).toBeNull();
  });
});

describe("buildPanelBench", () => {
  it("indexes a provider against the panel median in basis points", () => {
    const rows = buildPanelBench([
      quote({ requestId: "r1", providerId: "cheap", premiumMinor: 80_000 }),
      quote({ requestId: "r1", providerId: "mid", premiumMinor: 100_000 }),
      quote({ requestId: "r1", providerId: "dear", premiumMinor: 120_000 })
    ]);
    const idx = new Map(rows.map((r) => [r.providerId, r]));
    expect(idx.get("mid")!.ourPriceIdx).toBe(10_000);
    expect(idx.get("cheap")!.ourPriceIdx).toBe(8_000);
    expect(idx.get("dear")!.ourPriceIdx).toBe(12_000);
    // The baseline is stored, not assumed, so a later market feed can move it.
    expect(idx.get("mid")!.marketPriceIdx).toBe(10_000);
  });

  it("wins are selected answers over quoted ones, declines never counted", () => {
    const rows = buildPanelBench([
      quote({ requestId: "r1", providerId: "p", selectedAt: AT }),
      quote({ requestId: "r2", providerId: "p" }),
      quote({ requestId: "r3", providerId: "p", state: "declined", premiumMinor: null })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.winRate).toBe(50);
    expect(rows[0]!.volume).toBe(3);
    expect(rows[0]!.coverageGaps.declined).toBe(1);
  });

  it("counts the requests the panel saw and this provider did not answer", () => {
    const rows = buildPanelBench([
      quote({ requestId: "r1", providerId: "absent" }),
      quote({ requestId: "r2", providerId: "present" }),
      quote({ requestId: "r3", providerId: "present" })
    ]);
    const absent = rows.find((r) => r.providerId === "absent")!;
    expect(absent.coverageGaps.unquotedRequests).toBe(2);
  });

  it("splits cells by line and by UTC month", () => {
    const rows = buildPanelBench([
      quote({ requestId: "r1", providerId: "p" }),
      quote({ requestId: "r2", providerId: "p", line: "travel" }),
      quote({ requestId: "r3", providerId: "p", createdAt: Date.UTC(2026, 5, 2) })
    ]);
    expect(rows.map((r) => `${r.line}/${r.period}`)).toEqual(["motor/2026-05", "travel/2026-05", "motor/2026-06"]);
  });

  it("is deterministic under reordering — the property the upsert relies on", () => {
    const input = [
      quote({ requestId: "r1", providerId: "b", premiumMinor: 90_000 }),
      quote({ requestId: "r1", providerId: "a", premiumMinor: 110_000 }),
      quote({ requestId: "r2", providerId: "a", premiumMinor: 130_000, selectedAt: AT })
    ];
    expect(buildPanelBench(input)).toEqual(buildPanelBench([...input].reverse()));
  });

  it("prices nothing when nothing was priced, rather than dividing by zero", () => {
    const rows = buildPanelBench([
      quote({ requestId: "r1", providerId: "p", state: "timeout", premiumMinor: null }),
      quote({ requestId: "r2", providerId: "p", state: "error", premiumMinor: null })
    ]);
    expect(rows[0]!.ourPriceIdx).toBeNull();
    expect(rows[0]!.marketPriceIdx).toBeNull();
    expect(rows[0]!.winRate).toBeNull();
    expect(rows[0]!.volume).toBe(2);
  });
});

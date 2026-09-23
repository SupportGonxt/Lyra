/**
 * The NORTH step of the flagship journey read `highlightsJson` as `string[]`
 * and printed `narrativeRef` verbatim. Against live data that rendered
 * "0 Highlights" and a storage key where the briefing should be. Both are
 * contract bugs — the tests below are written against what the server sends,
 * not against what the screen assumed.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../api.server", () => ({ api: vi.fn(), asRouteError: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { highlightsOf } from "./journey-north";

/** One row as apps/api/src/engines/narrator.ts writes it. */
const row = (highlightsJson: unknown) => ({
  id: "brf_1",
  date: "2026-08-12",
  audience: "exec",
  locale: "en",
  narrativeRef: "Motor closed the month above every prior month.",
  highlightsJson,
  status: "published",
  createdAt: 0
});

describe("highlightsOf", () => {
  it("reads the objects the API actually sends", () => {
    const sent = [
      { metricKey: "gwp", period: "2026-07", value: 238_900_000, deltaBps: 1_841, note: "Led by motor." },
      { metricKey: "quote_to_bind_rate", period: "2026-08-11", value: 1_890, deltaBps: -1_923 }
    ];
    expect(highlightsOf(row(sent))).toEqual(sent);
    expect(highlightsOf(row(JSON.stringify(sent)))).toEqual(sent);
  });

  it("keeps nothing that is not a highlight, and survives a bad column", () => {
    expect(highlightsOf(row(["gwp", "renewal_retention"]))).toEqual([]);
    expect(highlightsOf(row(null))).toEqual([]);
    expect(highlightsOf(row("{not json"))).toEqual([]);
    expect(highlightsOf(row({ metricKey: "gwp" }))).toEqual([]);
    expect(highlightsOf(null)).toEqual([]);
  });
});

// The run sheet had the presenter say "NORTH didn't ask me what to look at.
// AXIS told it" while the loader only printed the product line: a briefing has
// no product-line column (packages/db/src/schema/north.ts) and the generic list
// filters on columns only (apps/api/src/crud.ts filterSql), so there is no
// filter to pass. The screen now says so rather than implying one.
describe("the product line the Insight step was handed", () => {
  it("is never sent to the API as a filter that does not exist", async () => {
    const { api } = await import("../api.server");
    const { loader } = await import("./journey-north");
    const calls = vi.mocked(api);
    calls.mockReset();
    calls.mockImplementation(async (path: string) =>
      path.startsWith("/v1/north/briefings") ? { data: [row([])] } : { data: [] }
    );
    const result = await loader({
      request: new Request("https://lyra.test/journey/north?productLine=motor&briefingId=brf_1"),
      context: { get: () => ({ env: {} }) },
      params: {}
    } as never);
    const paths = calls.mock.calls.map(([path]) => String(path));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.filter((path) => path.includes("productLine"))).toEqual([]);
    expect(result).toMatchObject({ productLine: "motor", briefingId: "brf_1" });
  });

  it("is named honestly in the lede, in both languages", async () => {
    const { labelsIn, lede } = await import("./journey-north");
    for (const locale of ["en", "ar"]) {
      const l = labelsIn(locale);
      const text = lede(l, { productLine: "motor", audience: "exec", highlights: 2, locale });
      expect(text).toContain(l("line.motor"));
      expect(text).not.toMatch(/AXIS|NORTH|told it/);
    }
    expect(lede(labelsIn("en"), { productLine: "motor", audience: "exec", highlights: 2, locale: "en" })).toMatch(
      /not split by product line/
    );
  });
});

describe("hero chips", () => {
  it("never put a date where the count-up animates it", async () => {
    // Hero counts every chip value up from zero (packages/ui hero.tsx
    // useCountUp), so a `2026-08-12` value played as 0-08-12 … 2026-08-12.
    const { heroChips, labelsIn } = await import("./journey-north");
    const chips = heroChips(labelsIn("en"), row([]), 1, "en");
    expect(chips.map((c) => c.value).filter((v) => /\d{4}-\d{2}/.test(v))).toEqual([]);
    expect(chips.some((c) => (c.detail ?? "").includes("2026"))).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error";
import { deltaBps, headlineDirection, ppm } from "./north-explorer";

vi.mock("../api.server", () => ({ api: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { loader } from "./north-explorer";

describe("deltaBps", () => {
  it("has no change to report with fewer than two snapshots", () => {
    expect(deltaBps([])).toBeNull();
    expect(deltaBps([100])).toBeNull();
  });

  it("reads the change of the last snapshot on the one before it", () => {
    expect(deltaBps([100, 110])).toBe(1000);
    expect(deltaBps([50, 100, 110])).toBe(1000);
    expect(deltaBps([100, 90])).toBe(-1000);
  });

  it("refuses to divide by a zero prior rather than reporting infinity", () => {
    expect(deltaBps([0, 42])).toBeNull();
  });

  it("keeps the direction of the move when the prior was negative", () => {
    // A loss shrinking from -100 to -50 is an improvement of 50%, not -50%.
    expect(deltaBps([-100, -50])).toBe(5000);
  });
});

describe("headlineDirection", () => {
  it("has nothing to headline with fewer than two snapshots", () => {
    expect(headlineDirection([])).toBeNull();
    expect(headlineDirection([100])).toBeNull();
  });

  it("names the direction the last two snapshots moved", () => {
    expect(headlineDirection([100, 110])).toBe("up");
    expect(headlineDirection([100, 90])).toBe("down");
  });

  it("reports nothing rather than a trend that isn't there", () => {
    expect(headlineDirection([100, 100])).toBeNull();
  });
});

describe("ppm", () => {
  it("shows a fitted parameter the way a person reads it", () => {
    expect(ppm(350_000)).toBe("0.35");
    expect(ppm(1_000_000)).toBe("1.00");
    expect(ppm(0)).toBe("0.00");
  });
});

function fakeContext() {
  return { get: () => ({ env: {} }) };
}

describe("north-explorer loader asOf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("appends &to=<asOf> to the snapshots query when ?asOf= is present", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "day" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    await loader({
      request: new Request("https://lyra.test/north/explorer?asOf=1700000000000"),
      context: fakeContext()
    } as never);
    const snapshotsCall = vi.mocked(api).mock.calls[1]?.[0] as string;
    expect(snapshotsCall).toContain("&to=1700000000000");
  });

  it("omits &to= when ?asOf= is absent", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "day" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    await loader({
      request: new Request("https://lyra.test/north/explorer"),
      context: fakeContext()
    } as never);
    const snapshotsCall = vi.mocked(api).mock.calls[1]?.[0] as string;
    expect(snapshotsCall).not.toContain("&to=");
  });

  // Both halves of the 500 this screen served in production. The loader asked
  // for limit=360, MAX_PAGE is 200 (apps/api/src/http.ts:186), so the API
  // answered 400 — and `readable()` swallowed only 403/404, so the rethrown
  // ApiError reached React Router as a crash. Every earlier test here mocked
  // `api` with a resolved page, which is why it was green the whole time.
  it("never asks the list API for more rows than it will serve", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "day" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    await loader({ request: new Request("https://lyra.test/north/explorer"), context: fakeContext() } as never);
    for (const [url] of vi.mocked(api).mock.calls) {
      const limit = Number(new URL(url as string, "https://api.test").searchParams.get("limit"));
      expect(limit).toBeLessThanOrEqual(200);
    }
  });

  // docs/modules/north.md §8: "A metric definition change shows as a chart
  // annotation from the change date." The dates come from the metric's own
  // history — written by the API's `metrics` resource when the value actually
  // differs — so the screen has to ask for them, and ask for the metric it is
  // showing rather than the tenant's whole history.
  it("asks for the definition history of the metric being read", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "net_commission", grain: "month" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    vi.mocked(api).mockResolvedValueOnce({ points: [], fit: {} });
    vi.mocked(api).mockResolvedValueOnce({
      data: [{ id: "mdf_1", metricKey: "net_commission", definitionSqlRef: "v2", changedAt: 1700000000000, changedBy: "user:rana" }]
    });
    const result = (await loader({
      request: new Request("https://lyra.test/north/explorer?metric=net_commission&grain=month"),
      context: fakeContext()
    } as never)) as unknown as { definitionChanges: { changedAt: number }[] };

    const historyCall = vi
      .mocked(api)
      .mock.calls.map(([url]) => url as string)
      .find((url) => url.startsWith("/v1/north/metric-definitions"));
    expect(historyCall).toContain("metricKey=net_commission");
    expect(result.definitionChanges).toHaveLength(1);
    expect(result.definitionChanges[0]!.changedAt).toBe(1700000000000);
  });

  // docs/27 F50. The endpoint exists to be read by something; this is the
  // something.
  it("asks for a projection of the metric and grain being read", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "net_commission", grain: "month" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    vi.mocked(api).mockResolvedValueOnce({ points: [], fit: {} });
    await loader({
      request: new Request("https://lyra.test/north/explorer?metric=net_commission&grain=month"),
      context: fakeContext()
    } as never);
    const forecastCall = vi.mocked(api).mock.calls.map(([url]) => url as string).find((url) => url.startsWith("/v1/north/forecast"));
    expect(forecastCall).toContain("metricKey=net_commission");
    expect(forecastCall).toContain("grain=month");
    expect(forecastCall).toContain("horizon=6");
  });

  it("asks for no projection at week grain, which the snapshotter does not write", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "month" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [] });
    const out = (await loader({
      request: new Request("https://lyra.test/north/explorer?grain=week"),
      context: fakeContext()
    } as never)) as { forecast: unknown };
    expect(vi.mocked(api).mock.calls.some(([url]) => (url as string).startsWith("/v1/north/forecast"))).toBe(false);
    expect(out.forecast).toBeNull();
  });

  it("loses the projection card, not the screen, when the reader lacks north:forecasts:read", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "day" }] });
    vi.mocked(api).mockResolvedValueOnce({ data: [{ id: "s1", period: "2026-01-01", value: 1, dimsHash: "", ts: 1 }] });
    vi.mocked(api).mockRejectedValueOnce(new ApiError({ title: "forbidden", status: 403 }, null));
    const out = (await loader({
      request: new Request("https://lyra.test/north/explorer"),
      context: fakeContext()
    } as never)) as { forecast: unknown; snapshots: unknown[] };
    expect(out.forecast).toBeNull();
    expect(out.snapshots).toHaveLength(1);
  });

  it("renders without the snapshots rather than crashing when the API refuses them", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "day" }] });
    vi.mocked(api).mockRejectedValueOnce(new ApiError({ title: "bad request", status: 400 }, null));
    const out = (await loader({
      request: new Request("https://lyra.test/north/explorer"),
      context: fakeContext()
    } as never)) as { snapshots: unknown };
    expect(out.snapshots).toBeNull();
  });
});

/* --------------- a dimensioned metric is read as a breakdown */

/**
 * The 2026-10-01 sweep's NORTH work made the market cut a **metric**
 * (`gwp_by_market`), which writes **only** dimensional rows (`dimsHash != ""`).
 * This loader filtered those out — with a reason that was right for the chart and
 * wrong for the metric — so the market metric appeared in the picker and rendered
 * *"No snapshots for this metric yet"*: a money figure with no reader at all.
 *
 * A dims row is not an extra point on a line. It is a row of a **breakdown**, and a
 * breakdown is read as a table.
 */
describe("north-explorer loader keeps dimensional rows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const snap = (id: string, dimsHash: string, period: string, value: number) => ({
    id,
    metricKey: "gwp_by_market",
    grain: "month",
    period,
    value,
    dimsHash,
    ts: 1
  });

  it("returns the slices for a metric that has only slices", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp_by_market", grain: "month" }] });
    vi.mocked(api).mockResolvedValueOnce({
      data: [snap("a", "market=AE", "2026-07", 3_091_200), snap("b", "market=unrecorded", "2026-07", 416_000)]
    });

    const out = (await loader({
      request: new Request("https://lyra.test/north/explorer?metric=gwp_by_market"),
      context: fakeContext()
    } as never)) as unknown as { snapshots: unknown[]; slices: { dimsHash: string }[] };

    // Nothing for the single-series chart, because a breakdown has no single line —
    // and both rows kept, because dropping them was the defect.
    expect(out.snapshots).toHaveLength(0);
    expect(out.slices.map((r) => r.dimsHash).sort()).toEqual(["market=AE", "market=unrecorded"]);
  });

  it("still separates a metric that carries both", async () => {
    vi.mocked(api).mockResolvedValueOnce({ data: [{ key: "gwp", grain: "month" }] });
    vi.mocked(api).mockResolvedValueOnce({
      data: [snap("t", "", "2026-07", 3_507_200), snap("s", "channel=web", "2026-07", 3_091_200)]
    });

    const out = (await loader({
      request: new Request("https://lyra.test/north/explorer?metric=gwp"),
      context: fakeContext()
    } as never)) as unknown as { snapshots: unknown[]; slices: unknown[] };

    expect(out.snapshots).toHaveLength(1);
    expect(out.slices).toHaveLength(1);
  });
});

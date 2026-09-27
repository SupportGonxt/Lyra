import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error";

vi.mock("../api.server", () => ({ api: vi.fn() }));
vi.mock("../context", () => ({ cloudflare: { toString: () => "cloudflare-context" } }));

import { api } from "../api.server";
import { action, answerOf, needsOf } from "./north-whatif";

// docs/30 NORTH 4. The screen now asks the scenario engine
// (POST /v1/north/scenarios/{id}/run) for the answer. These fixtures are in the
// server's shape: StoredScenarioResult in apps/api/src/engines/north-scenario.ts,
// and the 422 problem `unprocessable(detail, errors)` builds (packages/core/src/errors.ts).

const computed = {
  method: "baseline_shift",
  metricKey: "gwp",
  grain: "month",
  changeBps: 1_000,
  horizon: 2,
  points: [
    { period: "2026-09", baseline: { p10: 90, p50: 100, p90: 110 }, scenario: { p10: 99, p50: 110, p90: 121 }, delta: { p10: 9, p50: 10, p90: 11 } }
  ],
  fit: { method: "damped_holt_seasonal", observations: 24, intervalSource: "empirical", lastObserved: "2026-08" },
  ignored: ["note"],
  unit: "money",
  currency: "AED",
  computedAt: 1
};

const unreadable = () =>
  new ApiError(
    { title: "Cannot process", status: 422, detail: "…", errors: { metric: "missing", horizonMonths: "out_of_range" } },
    "req_1"
  );

function post(fields: Record<string, string>) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  return {
    request: new Request("http://web.test/north/whatif", { method: "POST", body }),
    context: { get: () => ({ env: {} }) },
    params: {}
  } as never;
}

describe("answerOf", () => {
  it("reads an engine answer, text or object", () => {
    expect(answerOf(computed)?.metricKey).toBe("gwp");
    expect(answerOf(JSON.stringify(computed))?.points).toHaveLength(1);
  });

  it("is null for a stored figure no engine produced, and for nothing at all", () => {
    expect(answerOf({ gwpDeltaMinor: 18_600_000, note: "…" })).toBeNull();
    expect(answerOf(null)).toBeNull();
    expect(answerOf({ method: "baseline_shift" })).toBeNull();
  });
});

describe("needsOf", () => {
  it("lists which assumption to fix and why, from a 422", () => {
    expect(needsOf(unreadable())).toEqual([
      { name: "metric", reason: "missing" },
      { name: "horizonMonths", reason: "out_of_range" }
    ]);
  });

  it("is null for anything that is not an unreadable-assumptions refusal", () => {
    expect(needsOf(new ApiError({ title: "x", status: 403 }, null))).toBeNull();
    expect(needsOf(new ApiError({ title: "x", status: 422 }, null))).toBeNull();
    expect(needsOf(new Error("boom"))).toBeNull();
  });
});

describe("north-whatif action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes an existing scenario on request", async () => {
    vi.mocked(api).mockResolvedValue({ id: "scn_1", resultJson: computed });
    const result = await action(post({ intent: "run", id: "scn_1" }));
    expect(api).toHaveBeenCalledWith("/v1/north/scenarios/scn_1/run", expect.objectContaining({ method: "POST" }));
    expect(result).toEqual({ problem: null, saved: "run", ran: "scn_1" });
  });

  it("says which assumptions stopped the computation, rather than failing the screen", async () => {
    vi.mocked(api).mockRejectedValue(unreadable());
    const result = await action(post({ intent: "run", id: "scn_1" }));
    expect(result).toEqual({
      problem: null,
      saved: null,
      ran: "scn_1",
      needs: [
        { name: "metric", reason: "missing" },
        { name: "horizonMonths", reason: "out_of_range" }
      ]
    });
  });

  it("saves the question and then asks the engine for the answer", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "scn_new" }).mockResolvedValueOnce({ id: "scn_new", resultJson: computed });
    const result = await action(
      post({ question: "What if?", author: "Hala", assumptions: "metric: gwp\nchangeBps: 1000\nhorizonMonths: 2" })
    );
    expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual(["/v1/north/scenarios", "/v1/north/scenarios/scn_new/run"]);
    expect(result).toEqual({ problem: null, saved: "scenario", ran: "scn_new" });
  });

  it("keeps the save when the engine cannot read the assumptions, and says what it needs", async () => {
    vi.mocked(api).mockResolvedValueOnce({ id: "scn_new" }).mockRejectedValueOnce(unreadable());
    const result = await action(post({ question: "What if?", author: "Hala", assumptions: "retentionDeltaPts: -5" }));
    expect(result).toMatchObject({ problem: null, saved: "scenario", ran: "scn_new", needs: [{ name: "metric", reason: "missing" }, { name: "horizonMonths", reason: "out_of_range" }] });
  });

  it("refuses a run with no scenario named", async () => {
    const result = await action(post({ intent: "run" }));
    expect(result.problem?.code).toBe("missing_scenario");
    expect(api).not.toHaveBeenCalled();
  });
});

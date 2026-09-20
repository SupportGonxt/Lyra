import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { Env } from "../env";
import {
  DECISIONS,
  adequacy,
  elasticities,
  labelsIn,
  latestPeriod,
  losses,
  rollByLine,
  verdictKey,
  type Dot,
  type ExperimentRow,
  type LineBench,
  type Loss,
  type PanelRow,
  type ProviderRoll
} from "./scout.shared";
import { action as experimentsAction, experimentsHeadline } from "./scout-experiments";
import { action as analyticsAction, analyticsHeadline } from "./scout-analytics";
import { radarHeadline } from "./scout-radar";
import { action as panelAction, panelHeadline } from "./scout-panel";
import { priceHeadline } from "./scout-pricing";

const l = labelsIn("en");

// The three SCOUT screens that read the panel bench and the experiment board.
// Only one of them writes — concluding an experiment is a decision about a build
// and is logged against the person who made it — so what is asserted here is
// that every refusal happens before the API is called, that the write carries an
// idempotency key, and that an API problem arrives as a Problem the screen can
// render rather than an exception. The derivations are checked beside them
// because the index, the elasticity and the adequacy have no endpoint: these
// screens are the only place those numbers exist.

const env = { ENVIRONMENT: "test", API_ORIGIN: "https://api.test", SESSION_COOKIE: "s" } as Env;

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...replies: Response[]) {
  const calls: Array<{ url: string; method: string; body: string | null; key: string | null }> = [];
  let at = 0;
  vi.stubGlobal("fetch", (input: URL | string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    calls.push({
      url: String(input),
      method: init.method ?? "GET",
      body: typeof init.body === "string" ? init.body : null,
      key: headers.get("idempotency-key")
    });
    const reply = replies[Math.min(at, replies.length - 1)] ?? new Response(null, { status: 204 });
    at += 1;
    return Promise.resolve(reply.clone());
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function args(form: FormData): ActionFunctionArgs {
  return {
    request: new Request("https://web.test/scout", { method: "POST", body: form }),
    context: { get: () => ({ env, ctx: null }) },
    params: {}
  } as unknown as ActionFunctionArgs;
}

const form = (fields: Record<string, string>): FormData => {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return body;
};

/* ------------------------------------------------------------------ fixtures */

const bench = (over: Partial<PanelRow> = {}): PanelRow => ({
  id: "pb_1",
  providerId: "prv_1",
  line: "motor",
  period: "2026-06",
  ourPriceIdx: 10_000,
  marketPriceIdx: 10_000,
  winRate: 30,
  volume: 100,
  coverageGapsJson: null,
  updatedAt: 1_770_000_000_000,
  ...over
});

const experiment = (over: Partial<ExperimentRow> = {}): ExperimentRow => ({
  id: "sxp_1",
  whitespaceId: "sws_1",
  landingRef: null,
  trafficPlanJson: null,
  resultsJson: null,
  state: "draft",
  startedAt: null,
  concludedAt: null,
  createdAt: 1_770_000_000_000,
  ...over
});

/* ------------------------------------------------------------- derivations */

describe("price benchmarks", () => {
  it("weights the index by volume and reads the newest period lexically", () => {
    const rows = [bench({ period: "2026-05" }), bench({ period: "2026-06" }), bench({ period: "2026-04" })];
    expect(latestPeriod(rows)).toBe("2026-06");
  });

  it("indexes a line against the median and names only the cuts above it", () => {
    const rows = [
      // 1000 at 5% above, 100 at market: the weighting must not read as 2.5%.
      bench({ line: "motor", ourPriceIdx: 10_500, volume: 1_000 }),
      bench({ line: "motor", ourPriceIdx: 10_000, volume: 100 }),
      bench({ line: "home", ourPriceIdx: 9_400, volume: 500 })
    ];
    const byLine = rollByLine(rows);
    expect(byLine.map((row) => row.line)).toEqual(["motor", "home"]);
    expect(Math.round(byLine[0]!.pct!)).toBe(5);
    expect(Math.round(byLine[1]!.pct!)).toBe(-6);

    const lost = losses(rows);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.line).toBe("motor");
    expect(Math.round(lost[0]!.pct)).toBe(5);
  });

  it("leaves an unpriced cut null rather than counting it as the median", () => {
    const byLine = rollByLine([bench({ ourPriceIdx: null })]);
    expect(byLine[0]!.pct).toBeNull();
    expect(losses([bench({ ourPriceIdx: null })])).toEqual([]);
  });
});

describe("pricing analytics", () => {
  it("reads elasticity from the last two periods of one cut", () => {
    const moved = elasticities([
      bench({ period: "2026-05", ourPriceIdx: 10_000, winRate: 30 }),
      bench({ period: "2026-06", ourPriceIdx: 9_500, winRate: 36 })
    ]);
    expect(moved).toHaveLength(1);
    expect(Math.round(moved[0]!.idxPct)).toBe(-5);
    expect(moved[0]!.winDelta).toBe(6);
    // Six points of win rate for five percent of price cut.
    expect(moved[0]!.ratio).toBeCloseTo(1.2, 2);
  });

  it("omits a cut with one period rather than comparing it against itself", () => {
    expect(elasticities([bench()])).toEqual([]);
  });

  it("measures adequacy as volume at or below the median", () => {
    const measured = adequacy([
      bench({ ourPriceIdx: 9_000, volume: 300 }),
      bench({ ourPriceIdx: 11_000, volume: 100 }),
      bench({ ourPriceIdx: null, volume: 999 })
    ]);
    expect(measured).toEqual({ atOrBelow: 300, priced: 400 });
  });
});

describe("experiment verdicts", () => {
  it("reads the state and the recorded verdict, never a threshold nothing stores", () => {
    expect(verdictKey(experiment()).key).toBe("xp.draft");
    expect(verdictKey(experiment({ state: "running" })).key).toBe("xp.running");
    expect(verdictKey(experiment({ state: "abandoned" })).key).toBe("xp.parked");
    expect(
      verdictKey(experiment({ state: "concluded", resultsJson: { verdict: "supported" } })).tone
    ).toBe("success");
    expect(
      verdictKey(experiment({ state: "concluded", resultsJson: { verdict: "did_not_replicate" } })).key
    ).toBe("xp.notReplicated");
  });
});

/* ----------------------------------------------------------------- actions */

describe("scout-experiments action", () => {
  it("refuses a decision with no experiment before calling the API", async () => {
    const calls = stubFetch(json({}));
    const result = await experimentsAction(args(form({ intent: "decide", state: "concluded" })));
    expect(result.problem?.code).toBe("experiment_required");
    expect(calls).toHaveLength(0);
  });

  it("refuses a state that is not one of the three decisions", async () => {
    const calls = stubFetch(json({}));
    const result = await experimentsAction(args(form({ intent: "decide", id: "sxp_1", state: "deleted" })));
    expect(result.problem?.code).toBe("state_required");
    expect(calls).toHaveLength(0);
  });

  it("patches the experiment with an idempotency key", async () => {
    const calls = stubFetch(json(experiment({ state: "concluded" })));
    const result = await experimentsAction(
      args(form({ intent: "decide", id: "sxp_1", state: "concluded", key: "scout-xp:abc" }))
    );
    expect(result.problem).toBeNull();
    expect(result.done).toEqual({ id: "sxp_1", state: "concluded" });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/v1/scout/scout-experiments/sxp_1");
    expect(JSON.parse(calls[0]!.body!)).toEqual({ state: "concluded" });
    expect(calls[0]!.key).toBe("scout-xp:abc");
  });

  it("hands an approval gate back as a Problem rather than throwing", async () => {
    stubFetch(
      json({ title: "Approval required", status: 403, code: "approval_required", policy_key: "scout.experiment" }, 403)
    );
    const result = await experimentsAction(args(form({ intent: "decide", id: "sxp_1", state: "abandoned" })));
    expect(result.problem?.code).toBe("approval_required");
    expect(result.done).toBeNull();
  });

  it("only offers the three states the decide permission may set", () => {
    expect([...DECISIONS]).toEqual(["running", "concluded", "abandoned"]);
  });
});

describe("scout-analytics action", () => {
  it("refuses an unknown dataset before calling the API", async () => {
    const calls = stubFetch(json({}));
    const result = await analyticsAction(args(form({ intent: "export", dataset: "panelBench", format: "xlsx" })));
    expect(result.problem?.code).toBe("dataset_required");
    expect(calls).toHaveLength(0);
  });

  it("refuses an unknown format before calling the API", async () => {
    const calls = stubFetch(json({}));
    const result = await analyticsAction(args(form({ intent: "export", dataset: "whitespaces", format: "docx" })));
    expect(result.problem?.code).toBe("format_required");
    expect(calls).toHaveLength(0);
  });

  it("exports a registered dataset through the platform's own report engine", async () => {
    const calls = stubFetch(json({ id: "exp_1", format: "xlsx", state: "ready", rowCount: 12, expiresAt: null, error: null }));
    const result = await analyticsAction(args(form({ intent: "export", dataset: "whitespaces", format: "xlsx" })));
    expect(result.problem).toBeNull();
    expect(result.exported?.state).toBe("ready");
    expect(calls[0]!.url).toBe("https://api.test/v1/analytics/exports");
    const body = JSON.parse(calls[0]!.body!) as { definition: { dataset: string; metrics: string[] } };
    expect(body.definition.dataset).toBe("whitespaces");
    expect(body.definition.metrics.length).toBeGreaterThan(0);
  });

  // docs/27 P2: only whitespaces and signals were exportable; clusters,
  // experiments and data products carry the same k-anonymity-safe shape (a
  // count/aggregate over a table with no thin-cell counterparty risk) and were
  // simply never registered. Panel bench is excluded on purpose (see the test
  // above) and stays that way.
  it.each(["clusters", "experiments", "dataProducts"] as const)(
    "exports %s, the SCOUT tables that were missing from the registry",
    async (dataset) => {
      const calls = stubFetch(json({ id: "exp_1", format: "xlsx", state: "ready", rowCount: 3, expiresAt: null, error: null }));
      const result = await analyticsAction(args(form({ intent: "export", dataset, format: "xlsx" })));
      expect(result.problem).toBeNull();
      expect(result.exported?.state).toBe("ready");
      const body = JSON.parse(calls[0]!.body!) as { definition: { dataset: string; metrics: string[] } };
      expect(body.definition.dataset).toBe(dataset);
      expect(body.definition.metrics.length).toBeGreaterThan(0);
    }
  );
});

/* ------------------------------------------------------------------ headlines */

const dot = (over: Partial<Dot> = {}): Dot => ({
  id: "sws_1",
  label: "Motor for gig drivers",
  fit: 30,
  momentum: 30,
  evidence: 5,
  status: "candidate",
  selected: false,
  ...over
});

describe("radarHeadline", () => {
  it("leads with the pursue-quadrant count when any dot clears both axes", () => {
    const dots = [dot({ fit: 80, momentum: 80 }), dot({ fit: 20, momentum: 20 })];
    expect(radarHeadline(dots, 0, l)).toBe(l("radar.headlinePursue", { n: "1" }));
  });

  it("falls back to the plotted count with nothing in the pursue quadrant", () => {
    const dots = [dot({ fit: 20, momentum: 20 })];
    expect(radarHeadline(dots, 0, l)).toBe(l("radar.headlinePlotted", { n: "1" }));
  });

  it("reports the unclustered count with nothing plotted at all", () => {
    expect(radarHeadline([], 4, l)).toBe(l("radar.headlineUnplotted", { n: "4" }));
  });

  it("falls back to the empty state with nothing plotted or unclustered", () => {
    expect(radarHeadline([], 0, l)).toBe(l("radar.empty"));
  });
});

const roll = (over: Partial<ProviderRoll> = {}): ProviderRoll => ({
  providerId: "prv_1",
  volume: 100,
  share: 1,
  winRate: 30,
  ourIdx: 10_000,
  marketIdx: 10_000,
  lines: ["motor"],
  gaps: 0,
  ...over
});

describe("scout-panel action", () => {
  it("runs the Bench Builder and reports what it rewrote", async () => {
    const calls = stubFetch(json({ quotes: 40, cells: 6, created: 2, updated: 4, periods: ["2026-06"] }));
    const result = (await panelAction(args(form({ intent: "rebuild" })))) as { problem: null; done: unknown };
    expect(result.problem).toBeNull();
    expect(result.done).toEqual({ intent: "rebuild", cells: 6, created: 2, updated: 4 });
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/v1/scout/panel-bench/sweep");
  });

  it("hands the build permission's refusal back as a Problem rather than throwing", async () => {
    stubFetch(json({ title: "Forbidden", status: 403, code: "forbidden" }, 403));
    const result = (await panelAction(args(form({ intent: "rebuild" })))) as {
      problem: { code?: string } | null;
      done: null;
    };
    expect(result.problem?.code).toBe("forbidden");
    expect(result.done).toBeNull();
  });

  it("refuses an intent it does not know before calling the API", async () => {
    const calls = stubFetch(json({}));
    const result = (await panelAction(args(form({ intent: "sweep" })))) as { problem: { code?: string } | null };
    expect(result.problem?.code).toBe("bad_intent");
    expect(calls).toHaveLength(0);
  });
});

describe("panelHeadline", () => {
  it("leads with the cheaper-than-median count", () => {
    const rolls = [roll({ ourIdx: 9_000, marketIdx: 10_000 }), roll({ ourIdx: 10_000, marketIdx: 10_000 })];
    expect(panelHeadline(rolls, l)).toBe(l("panel.headlineCheaper", { n: "1", total: "2" }));
  });

  it("falls back to the roll count with nobody priced below the median", () => {
    const rolls = [roll({ ourIdx: 10_000, marketIdx: 10_000 })];
    expect(panelHeadline(rolls, l)).toBe(l("panel.headlineCount", { n: "1" }));
  });

  it("falls back to the title with no rolls at all", () => {
    expect(panelHeadline([], l)).toBe(l("panel.title"));
  });
});

const line = (over: Partial<LineBench> = {}): LineBench => ({
  line: "motor",
  volume: 100,
  ourIdx: 10_000,
  marketIdx: 10_000,
  pct: 0,
  ...over
});

const loss = (over: Partial<Loss> = {}): Loss => ({ providerId: "prv_1", line: "motor", pct: 5, volume: 100, ...over });

describe("priceHeadline", () => {
  it("leads with the loss count when the panel is beating us somewhere", () => {
    expect(priceHeadline([line(), line({ line: "home" })], [loss()], l)).toBe(
      l("price.headlineLosses", { n: "1", lines: "2" })
    );
  });

  it("falls back to the line count with no losses", () => {
    expect(priceHeadline([line()], [], l)).toBe(l("price.headlineCount", { n: "1" }));
  });

  it("falls back to the title with nothing priced", () => {
    expect(priceHeadline([], [], l)).toBe(l("price.title"));
  });
});

describe("experimentsHeadline", () => {
  it("leads with the running count", () => {
    const rows = [experiment({ state: "running" }), experiment({ state: "draft" })];
    expect(experimentsHeadline(rows, l)).toBe(l("xp.headlineRunning", { n: "1", total: "2" }));
  });

  it("falls back to the row count with nothing running", () => {
    const rows = [experiment({ state: "draft" })];
    expect(experimentsHeadline(rows, l)).toBe(l("xp.headlineCount", { n: "1" }));
  });

  it("falls back to the empty state with no experiments", () => {
    expect(experimentsHeadline([], l)).toBe(l("xp.empty"));
  });
});

describe("analyticsHeadline", () => {
  it("leads with the adequacy share when there is one", () => {
    expect(analyticsHeadline(3, 62.4, l)).toBe(l("an.headlineAdequacy", { pct: "62", periods: "3" }));
  });

  it("falls back to the period count with no adequacy share", () => {
    expect(analyticsHeadline(3, null, l)).toBe(l("an.headlineCount", { n: "3" }));
  });

  it("falls back to the title with no periods on the bench", () => {
    expect(analyticsHeadline(0, null, l)).toBe(l("an.title"));
  });
});

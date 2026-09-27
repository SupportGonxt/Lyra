import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { concludeExperiments, experimentReadout, probabilityToBeat, readout } from "./signal-experiment.js";

// docs/30 SIGNAL 4. An experiment stored its hypothesis and variants and
// nothing ever read them out: the verdicts in the log were typed by hand.
// The readout is a pure function of per-arm counts, so it is tested as one.

describe("probabilityToBeat", () => {
  it("is a half for identical arms and near certainty for a clear gap", () => {
    expect(probabilityToBeat({ samples: 1_000, conversions: 100 }, { samples: 1_000, conversions: 100 })).toBeCloseTo(0.5, 5);
    expect(probabilityToBeat({ samples: 9_204, conversions: 1_086 }, { samples: 7_918, conversions: 1_156 })).toBeGreaterThan(0.99);
    expect(probabilityToBeat({ samples: 2_140, conversions: 137 }, { samples: 2_088, conversions: 123 })).toBeLessThan(0.5);
  });

  it("is a half when either arm has nothing to compare", () => {
    expect(probabilityToBeat({ samples: 0, conversions: 0 }, { samples: 10, conversions: 5 })).toBe(0.5);
  });
});

describe("readout", () => {
  const arms = (control: [number, number], variant: [number, number]) => ({
    control: { samples: control[0], conversions: control[1] },
    arabic_first: { samples: variant[0], conversions: variant[1] }
  });

  it("keeps running below the minimum sample, whatever the gap", () => {
    expect(readout(arms([100, 5], [100, 30]), 3_000).verdict).toBe("running");
  });

  it("calls a winner past the sample once the probability clears 95%", () => {
    const r = readout(arms([9_204, 1_086], [7_918, 1_156]), 3_000);
    expect(r).toMatchObject({ verdict: "won", winner: "arabic_first", samples: { control: 9_204, arabic_first: 7_918 } });
    expect(r.rateBps).toEqual({ control: 1_180, arabic_first: 1_460 });
    expect(r.upliftBps).toBe(280);
    expect(r.probabilityToBeatControlBps).toBeGreaterThan(9_500);
  });

  it("calls it lost when every variant is at most 5% likely to beat control", () => {
    expect(readout(arms([5_000, 500], [5_000, 380]), 2_000)).toMatchObject({ verdict: "lost", winner: null });
  });

  it("stays running when the sample is met but the answer is not", () => {
    expect(readout(arms([3_000, 300], [3_000, 310]), 2_000).verdict).toBe("running");
  });
});

/* ------------------------------------------------------ from attribution */

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-09-27T12:00:00Z");
const DAY = 86_400_000;

describe("experiments read from attribution touches", () => {
  let ctx: Ctx;
  const experiment = (id: string, state: string, metric = "click_to_bind_rate") => ({
    id,
    tenantId: "t_1",
    hypothesis: "h",
    variantsJson: JSON.stringify([
      { key: "control", creativeId: "crv_a", splitBps: 5_000 },
      { key: "bold", creativeId: "crv_b", splitBps: 5_000 }
    ]),
    metric,
    minSample: 100,
    state,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY
  });
  const touches = (creativeId: string, touchType: string, n: number, at = NOW - DAY) =>
    Array.from({ length: n }, (_, i) => ({
      id: `atr_${creativeId}_${touchType}_${at}_${i}`, tenantId: "t_1", anonId: `a${i}`, touchType, channel: "search", creativeId, ts: at
    }));

  beforeEach(async () => {
    const client = createClient({ url: ":memory:" });
    for (const s of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")).map((s) => s.trim()).filter(Boolean)) {
      await client.execute(s);
    }
    ctx = {
      db: drizzle(client) as unknown as Ctx["db"],
      tenantId: "t_1",
      actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
      requestId: "req_1",
      now: NOW,
      locale: "en",
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    };
    await ctx.db.insert(schema.signalExperiments).values([experiment("exp_run", "running"), experiment("exp_draft", "draft")]);
    await ctx.db.insert(schema.signalAttributionEvents).values([
      ...touches("crv_a", "click", 400),
      ...touches("crv_a", "bind", 20),
      ...touches("crv_b", "click", 400),
      ...touches("crv_b", "bind", 60),
      // Before the experiment began: not its evidence.
      ...touches("crv_b", "bind", 50, NOW - 20 * DAY)
    ]);
  });

  it("counts each arm's exposures and conversions on its own creative since it began", async () => {
    const r = await experimentReadout(ctx, "exp_run");
    expect(r.samples).toEqual({ control: 400, bold: 400 });
    expect(r.rateBps).toEqual({ control: 500, bold: 1_500 });
    expect(r.verdict).toBe("won");
  });

  it("refuses a metric it cannot count", async () => {
    await ctx.db.insert(schema.signalExperiments).values(experiment("exp_odd", "running", "vibes"));
    await expect(experimentReadout(ctx, "exp_odd")).rejects.toMatchObject({ status: 400 });
  });

  it("concludes a running experiment with a clear answer, once, and announces it", async () => {
    expect(await concludeExperiments(ctx)).toEqual({ concluded: 1 });
    const [row] = await ctx.db.select().from(schema.signalExperiments).where(eq(schema.signalExperiments.id, "exp_run"));
    expect(row).toMatchObject({ state: "concluded", concludedAt: NOW });
    expect(JSON.parse(row!.resultJson!)).toMatchObject({ verdict: "won", winner: "bold" });
    const events = (await ctx.db.select().from(schema.eventOutbox)).filter((e) => e.type === "signal.experiment.concluded");
    expect(events).toHaveLength(1);
    // A draft is not running, and a concluded one is not re-read.
    expect(await concludeExperiments(ctx)).toEqual({ concluded: 0 });
  });

  it("reads out through GET /experiments/:id/readout for a reader, and refuses anyone else", async () => {
    const get = async (permissions: string[]) => {
      const a = new Hono<App>();
      a.onError(onError);
      a.use("*", async (c, next) => {
        c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
        await next();
      });
      a.route("/", signalRoutes);
      const res = await a.fetch(new Request("http://api.test/experiments/exp_run/readout"));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    expect((await get([])).status).toBe(403);
    const ok = await get(["signal:experiments:read"]);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ verdict: "won", winner: "bold" });
  });
});

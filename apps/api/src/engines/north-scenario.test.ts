import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { forecast, type Ctx } from "@lyra/core";
import { runScenario } from "./north-scenario.js";

// docs/30 NORTH 4. The what-if screen stored a question and its assumptions and
// nothing computed them. runScenario reads the driver out of the stored
// assumptions, projects the metric's closed grand-total snapshots through the
// forecast, and stores the shifted band on the row.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
let ctx: Ctx;

const MONTHS = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")).map((s) => s.trim()).filter(Boolean)) {
    await client.execute(s);
  }
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_exec", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  const metric = (key: string, grain: string, tenantId = "t_1") => ({
    id: `met_${key}_${tenantId}`, tenantId, key, nameJson: "{}", definitionSqlRef: key, unit: "money", currency: "AED", grain, createdAt: NOW, updatedAt: NOW
  });
  await ctx.db.insert(schema.northMetrics).values([metric("gwp", "month"), metric("thin", "month"), metric("weekly", "week"), metric("secret", "month", "t_2")]);
  let n = 0;
  const snap = (metricKey: string, period: string, value: number, dimsHash = "", tenantId = "t_1") => ({
    id: `snp_${n++}`, tenantId, metricKey, grain: "month", period, dimsHash, value, ts: NOW
  });
  await ctx.db.insert(schema.northSnapshots).values([
    ...MONTHS.map((period, i) => snap("gwp", period, 1_000_000 + i * 10_000)),
    // The open month is a partial observation and must not be a baseline.
    snap("gwp", "2026-08", 1),
    // A dimensional slice is part of the total, not another observation of it.
    ...MONTHS.map((period) => snap("gwp", period, 5, "channel=ch_1")),
    // Another tenant's history is not this tenant's baseline.
    ...MONTHS.map((period) => snap("gwp", period, 9, "", "t_2")),
    ...MONTHS.map((period) => snap("secret", period, 9, "", "t_2")),
    snap("thin", "2026-06", 100),
    snap("thin", "2026-07", 110)
  ]);
  const scenario = (id: string, assumptions: unknown, tenantId = "t_1") => ({
    id, tenantId, question: `${id}?`, assumptionsJson: JSON.stringify(assumptions), modelRunRef: null, resultJson: null,
    author: "hala.zayed", sharedWithJson: null, createdAt: NOW - 1000, updatedAt: NOW - 1000
  });
  await ctx.db.insert(schema.northScenarios).values([
    scenario("scn_price", { metric: "gwp", changeBps: 1_000, horizonMonths: 3, currency: "AED" }),
    scenario("scn_thin", { metric: "thin", changeBps: -500, horizonMonths: 3 }),
    scenario("scn_prose", { channelSharePpm: 450_000, horizonMonths: 6 }),
    scenario("scn_unknown", { metric: "nope", changeBps: 100, horizonMonths: 3 }),
    scenario("scn_weekly", { metric: "weekly", changeBps: 100, horizonMonths: 3 }),
    scenario("scn_other", { metric: "secret", changeBps: 100, horizonMonths: 3 }),
    scenario("scn_elsewhere", { metric: "gwp", changeBps: 100, horizonMonths: 3 }, "t_2")
  ]);
});

const row = async (id: string) => (await ctx.db.select().from(schema.northScenarios).where(eq(schema.northScenarios.id, id)))[0]!;

describe("running a scenario", () => {
  it("projects the closed grand totals, shifts the band by the change, and stores the answer on the row", async () => {
    const result = await runScenario(ctx, "scn_price");
    const expected = forecast("month", MONTHS.map((period, i) => ({ period, value: 1_000_000 + i * 10_000 })), 3);

    expect(result.id).toBe("scn_price");
    const stored = JSON.parse((await row("scn_price")).resultJson!);
    expect(stored).toEqual(result.resultJson);
    expect(stored).toMatchObject({
      method: "baseline_shift",
      metricKey: "gwp",
      grain: "month",
      unit: "money",
      currency: "AED",
      changeBps: 1_000,
      horizon: 3,
      ignored: ["currency"],
      computedAt: NOW
    });
    expect(stored.reason).toBeUndefined();
    expect(stored.fit).toEqual(expected.fit);
    expect(stored.fit.lastObserved).toBe("2026-07");
    expect(stored.points.map((p: { period: string }) => p.period)).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(stored.points[0].baseline.p50).toBe(expected.points[0]!.p50);
    expect(stored.points[0].scenario.p50).toBe(Math.round((expected.points[0]!.p50 * 11_000) / 10_000));
    expect((await row("scn_price")).updatedAt).toBe(NOW);
    // No model ran, so there is no model run to point at.
    expect((await row("scn_price")).modelRunRef).toBeNull();
  });

  it("audits the run", async () => {
    await runScenario(ctx, "scn_price");
    const audits = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "north.scenario.run"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ subjectRef: "scn_price" });
  });

  it("stores an honest 'too little history' rather than inventing a baseline", async () => {
    await runScenario(ctx, "scn_thin");
    const stored = JSON.parse((await row("scn_thin")).resultJson!);
    expect(stored).toMatchObject({ reason: "insufficient_history", points: [], metricKey: "thin" });
    expect(stored.fit.observations).toBe(2);
  });

  it("refuses assumptions it cannot read with 422, naming each one, and writes nothing", async () => {
    await expect(runScenario(ctx, "scn_prose")).rejects.toMatchObject({
      status: 422,
      extras: { errors: { metric: "missing", changeBps: "missing" } }
    });
    await expect(runScenario(ctx, "scn_unknown")).rejects.toMatchObject({ status: 422, extras: { errors: { metric: "unknown" } } });
    await expect(runScenario(ctx, "scn_weekly")).rejects.toMatchObject({
      status: 422,
      extras: { errors: { metric: "unsupported_grain" } }
    });
    // Another tenant's metric is not a metric here.
    await expect(runScenario(ctx, "scn_other")).rejects.toMatchObject({ status: 422, extras: { errors: { metric: "unknown" } } });
    for (const id of ["scn_prose", "scn_unknown", "scn_weekly", "scn_other"]) expect((await row(id)).resultJson).toBeNull();
  });

  it("does not reach another tenant's scenario", async () => {
    await expect(runScenario(ctx, "scn_elsewhere")).rejects.toMatchObject({ status: 404 });
    await expect(runScenario(ctx, "scn_nope")).rejects.toMatchObject({ status: 404 });
  });

  it("reads assumptions stored as text that is not JSON as no assumptions at all", async () => {
    await ctx.db.update(schema.northScenarios).set({ assumptionsJson: "not json" }).where(eq(schema.northScenarios.id, "scn_price"));
    await expect(runScenario(ctx, "scn_price")).rejects.toMatchObject({ status: 422 });
  });
});

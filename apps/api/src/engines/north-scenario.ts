import { and, asc, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import {
  audit,
  isClosedPeriod,
  projectScenario,
  readScenarioDriver,
  unprocessable,
  type Ctx,
  type Grain,
  type Observation,
  type ScenarioResult
} from "@lyra/core";
import { must } from "../rows.js";

// docs/30 NORTH 4, ADR-0103: the scenario engine. The what-if screen stored a
// question and its assumptions; this is what answers it. The arithmetic is
// packages/core/src/north-scenario.ts (pure, mutation-gated); this file is the
// I/O around it — read the row, resolve the metric, read the same closed
// snapshots the forecast reads, store the answer.

/**
 * How far back a projection reads. Three years of months or two of days is more
 * than the damped Holt fit can use and less than a page of rows; the bound is
 * here so a tenant with a decade of history cannot turn one request into a
 * table scan.
 */
const HISTORY_LIMIT = 800;

/**
 * A metric's *closed* grand-total observations, ascending. A month-to-date row
 * is a partial observation, a dimensional slice is part of the total rather
 * than another reading of it — neither is a baseline. Shared with
 * `GET /v1/north/forecast`, so a scenario's baseline is exactly the forecast
 * that endpoint projects.
 */
export async function closedHistory(ctx: Ctx, metricKey: string, grain: Grain): Promise<Observation[]> {
  const rows = await ctx.db
    .select({ period: schema.northSnapshots.period, value: schema.northSnapshots.value })
    .from(schema.northSnapshots)
    .where(
      and(
        eq(schema.northSnapshots.tenantId, ctx.tenantId),
        eq(schema.northSnapshots.metricKey, metricKey),
        eq(schema.northSnapshots.grain, grain),
        eq(schema.northSnapshots.dimsHash, "") // the headline, never a dimensional split
      )
    )
    .orderBy(asc(schema.northSnapshots.period))
    .limit(HISTORY_LIMIT);
  return rows.filter((row) => isClosedPeriod(grain, row.period, ctx.now));
}

/** What `north_scenarios.result_json` holds: the projection plus the units to read it in. */
export interface StoredScenarioResult extends ScenarioResult {
  unit: string;
  currency: string | null;
  computedAt: number;
}

function assumptionsOf(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Compute one stored scenario and write the answer onto its row.
 *
 * Assumptions the engine cannot read are a 422 naming each one, and nothing is
 * written: the stored question stays unanswered rather than answered with a
 * guess. Too little history is *not* a refusal — it is an answer ("there is no
 * baseline to shift"), stored with no numbers, so the screen can say so.
 */
export async function runScenario(ctx: Ctx, scenarioId: string): Promise<{ id: string; resultJson: StoredScenarioResult }> {
  const scenario = await must(ctx, schema.northScenarios, scenarioId, "scenario");
  const assumptions = assumptionsOf(scenario.assumptionsJson);
  const named =
    assumptions && typeof assumptions === "object" && typeof (assumptions as { metric?: unknown }).metric === "string"
      ? (assumptions as { metric: string }).metric.trim()
      : "";

  const [metric] = named
    ? await ctx.db
        .select()
        .from(schema.northMetrics)
        .where(and(eq(schema.northMetrics.tenantId, ctx.tenantId), eq(schema.northMetrics.key, named)))
        .limit(1)
    : [];

  const read = readScenarioDriver(assumptions, metric?.grain ?? null);
  if ("errors" in read) throw unprocessable("The assumptions do not name a driver the scenario engine can compute", read.errors);

  const grain = metric!.grain as Grain;
  const projection = projectScenario(grain, await closedHistory(ctx, read.driver.metric, grain), read.driver);
  const result: StoredScenarioResult = {
    ...projection,
    unit: metric!.unit,
    currency: metric!.currency ?? null,
    computedAt: ctx.now
  };

  await ctx.db
    .update(schema.northScenarios)
    .set({ resultJson: JSON.stringify(result), updatedAt: ctx.now })
    .where(and(eq(schema.northScenarios.tenantId, ctx.tenantId), eq(schema.northScenarios.id, scenario.id)));
  await audit(ctx, {
    action: "north.scenario.run",
    subjectRef: scenario.id,
    after: {
      metricKey: result.metricKey,
      changeBps: result.changeBps,
      horizon: result.horizon,
      points: result.points.length,
      ...(result.reason ? { reason: result.reason } : {})
    }
  });
  return { id: scenario.id, resultJson: result };
}

import { and, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { actorRef, audit, badRequest, conflict, notFound, periodBounds, periodOf, type Ctx, type Grain } from "@lyra/core";
import { REGISTRY } from "./north-snapshotter.js";
import { parseCsv, type RowError } from "./axis-case-import.js";

// docs/30 NORTH 3. A metric whose numbers live outside Lyra — footfall, a
// partner's own sales — is pushed, not computed. Only a metric the snapshotter
// cannot compute takes a push, so two writers never fight over one figure.

export interface PushedValue {
  period: string;
  value: number;
}

/** Whether `period` is a real label at `grain`: it survives a round trip through its own window. */
function isPeriod(grain: Grain, period: string): boolean {
  try {
    return periodOf(grain, periodBounds(grain, period).since) === period;
  } catch {
    return false;
  }
}

export async function pushMetricValues(ctx: Ctx, key: string, values: readonly PushedValue[]): Promise<{ written: number }> {
  const [metric] = await ctx.db
    .select()
    .from(schema.northMetrics)
    .where(and(eq(schema.northMetrics.tenantId, ctx.tenantId), eq(schema.northMetrics.key, key)))
    .limit(1);
  if (!metric) throw notFound(`metric ${key}`);
  if (REGISTRY[key]) throw conflict(`metric ${key} is computed by the snapshotter`);
  const grain = metric.grain as Grain;
  const bad = values.find((v) => !isPeriod(grain, v.period));
  if (bad) throw badRequest(`${bad.period} is not a ${grain} period`, { period: `expected a ${grain} period` });

  const existing = await ctx.db
    .select()
    .from(schema.northSnapshots)
    .where(
      and(
        eq(schema.northSnapshots.tenantId, ctx.tenantId),
        eq(schema.northSnapshots.metricKey, key),
        eq(schema.northSnapshots.grain, grain),
        eq(schema.northSnapshots.dimsHash, ""),
        inArray(schema.northSnapshots.period, values.map((v) => v.period))
      )
    );
  const byPeriod = new Map(existing.map((row) => [row.period, row]));

  for (const v of values) {
    const row = byPeriod.get(v.period);
    if (!row) {
      await ctx.db.insert(schema.northSnapshots).values({
        id: newId("snp", ctx.now),
        tenantId: ctx.tenantId,
        metricKey: key,
        grain,
        period: v.period,
        dimsHash: "",
        value: v.value,
        ts: ctx.now
      });
    } else if (row.value !== v.value) {
      // The attested number is no longer the one stored.
      await ctx.db
        .update(schema.northSnapshots)
        .set({ value: v.value, ts: ctx.now, verifiedAt: null, verifiedBy: null, verificationRef: null })
        .where(eq(schema.northSnapshots.id, row.id));
    }
  }
  await audit(ctx, {
    action: "north.metric.pushed",
    subjectRef: `north_metric:${metric.id}`,
    after: { by: actorRef(ctx), periods: values.map((v) => v.period) }
  });
  return { written: values.length };
}

/**
 * @accept:SA. Metric values from a file: `metric,period,value`, one push per
 * metric (the generic import panel's `created` counts values written) so one that refuses (unknown, computed, wrong grain) is reported on
 * its own lines while the rest land.
 */
export async function importMetricCsv(ctx: Ctx, csv: string): Promise<{ created: number; skippedDuplicate: number; errors: RowError[] }> {
  const { header, rows, parseErrors } = parseCsv(csv);
  const errors: RowError[] = [...parseErrors];
  const missing = ["metric", "period", "value"].find((col) => !header.includes(col));
  if (missing && !parseErrors.length) return { created: 0, skippedDuplicate: 0, errors: [{ line: 1, ref: null, error: `missing column ${missing}` }] };
  if (missing) return { created: 0, skippedDuplicate: 0, errors };

  const byMetric = new Map<string, { lines: number[]; values: PushedValue[] }>();
  for (const { line, cells } of rows) {
    const metric = (cells.metric ?? "").trim();
    const value = (cells.value ?? "").trim();
    if (!metric) { errors.push({ line, ref: null, error: "metric is required" }); continue; }
    if (!/^-?\d+$/.test(value)) { errors.push({ line, ref: metric, error: "value must be a whole number" }); continue; }
    const group = byMetric.get(metric) ?? { lines: [], values: [] };
    group.lines.push(line);
    group.values.push({ period: (cells.period ?? "").trim(), value: Number(value) });
    byMetric.set(metric, group);
  }

  let created = 0;
  for (const [metric, group] of byMetric) {
    try {
      created += (await pushMetricValues(ctx, metric, group.values)).written;
    } catch (err) {
      const detail = (err as { detail?: string }).detail ?? "refused";
      for (const line of group.lines) errors.push({ line, ref: metric, error: detail });
    }
  }
  // A pushed period overwrites in place, so there is no duplicate to skip.
  return { created, skippedDuplicate: 0, errors };
}

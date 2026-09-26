import { and, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { actorRef, audit, badRequest, conflict, notFound, periodBounds, periodOf, type Ctx, type Grain } from "@lyra/core";
import { REGISTRY } from "./north-snapshotter.js";

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

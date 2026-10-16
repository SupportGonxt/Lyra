import { eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import type { Env } from "../env.js";

// ADR-0118. Feeds the tenant's own metric history into Aletheia's self-learning
// so its benchmarks and causal edges grow from LYRA's snapshots — the "learned
// state" that becomes the fused, fingerprinted moat (docs/FUSION.md). One flat
// series per metric key, grand-total rows only: a dimensional split is not a
// benchmark the engine should learn, and the learn API takes a list per key.
//
// Gated on ALETHEIA_URL: with no Aletheia deployed this is a no-op, never an
// error, so the cron tick is identical whether the engine is present or not.

export interface AletheiaIngestResult {
  /** Metric keys pushed. */
  pushed: number;
  /** Total values across all keys. */
  samples: number;
}

/** The learn endpoint for a tenant, or null when Aletheia is not configured. */
export function aletheiaLearnUrl(env: Pick<Env, "ALETHEIA_URL">, tenantId: string): string | null {
  if (!env.ALETHEIA_URL) return null;
  return `${env.ALETHEIA_URL.replace(/\/$/, "")}/api/${encodeURIComponent(tenantId)}/learn`;
}

export async function ingestAletheia(
  ctx: Ctx,
  env: Pick<Env, "ALETHEIA_URL" | "ALETHEIA_TOKEN">
): Promise<AletheiaIngestResult | null> {
  const url = aletheiaLearnUrl(env, ctx.tenantId);
  if (!url) return null;

  const rows = await ctx.db
    .select({ metricKey: schema.northSnapshots.metricKey, period: schema.northSnapshots.period, value: schema.northSnapshots.value, dimsHash: schema.northSnapshots.dimsHash })
    .from(schema.northSnapshots)
    .where(eq(schema.northSnapshots.tenantId, ctx.tenantId));

  const series = new Map<string, { period: string; value: number }[]>();
  for (const r of rows) {
    if (r.dimsHash !== "") continue; // grand total only
    const list = series.get(r.metricKey) ?? [];
    list.push({ period: r.period, value: r.value });
    series.set(r.metricKey, list);
  }

  let samples = 0;
  const body: Record<string, number[]> = {};
  for (const key of [...series.keys()].sort()) {
    const values = series
      .get(key)!
      .sort((a, b) => a.period.localeCompare(b.period))
      .map((p) => p.value);
    body[key] = values;
    samples += values.length;
  }

  if (samples === 0) return { pushed: 0, samples: 0 };

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.ALETHEIA_TOKEN) headers["authorization"] = `Bearer ${env.ALETHEIA_TOKEN}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`aletheia ingest ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return { pushed: Object.keys(body).length, samples };
}

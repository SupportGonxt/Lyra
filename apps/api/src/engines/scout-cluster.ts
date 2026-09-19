import { eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { clusterSignals, scoped, type Ctx, type RawSignal } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import { embedQuery } from "./vectorize.js";
import { signalsSince } from "./scout-ingest.js";
import type { Env } from "../env.js";

// docs/modules/scout.md §2.1 "Everything embedded (Vectorize) and clustered
// weekly" / §3 "Clusterer | weekly | standard". `sweepWhitespace` already
// clusters *quote* demand; this is the other half — the Clusterer over the
// persisted `scout_signals` corpus, whatever wrote it.
//
// docs/27 F52: VEC_MARKET was written on every signal ingest and never read by
// the thing it was written for. This is that reader. The index decides which
// existing cluster a new signal joins — the one question an embedding can
// answer that a `GROUP BY source` cannot — and `scout_signals.cluster_id`,
// a column nothing outside the seed had ever written, is what records the
// answer.

/** How far back a sweep reads. Two windows of the clusterer's own period, so
 *  `clusterSignals` has a prior window to measure growth against. */
export const CLUSTER_WINDOW_MS = 7 * 86_400_000;
export const CLUSTER_LOOKBACK_MS = 26 * CLUSTER_WINDOW_MS;

/** Rows per sweep. The index query below is one call per known theme, not per
 *  signal, so this bounds the database work rather than the model work. */
export const CLUSTER_MAX_SIGNALS = 2_000;

/** Neighbours asked for per theme. */
const TOP_K = 20;

/**
 * Below this a "nearest" neighbour is not near. Cosine similarity as Vectorize
 * reports it, and deliberately strict: a signal the index cannot place
 * confidently falls back to its source, which is a coarser but never wrong
 * grouping. Loosening this silently merges unrelated themes, so it is a
 * constant with a name rather than a literal in the loop.
 */
export const SIMILARITY_FLOOR = 0.72;

/** How many momentum points `trail_json` keeps — enough for the Radar's
 *  sparkline (docs §4 screen 1), short enough to stay a column and not a table. */
export const TRAIL_POINTS = 12;

export interface ClusterSweepReport {
  readonly signals: number;
  readonly clusters: number;
  /** Signals the index placed into an existing cluster rather than their source bucket. */
  readonly placedByIndex: number;
  readonly themes: string[];
}

/** One recorded momentum reading. Parsed defensively — a malformed blob is a
 *  trail we cannot read, and starting a fresh one loses less than throwing. */
export interface TrailPoint {
  readonly at: number;
  readonly momentum: number;
}

export function appendTrail(json: string | null, point: TrailPoint, keep = TRAIL_POINTS): string {
  let held: TrailPoint[] = [];
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json);
      if (Array.isArray(parsed)) {
        held = parsed.filter(
          (one): one is TrailPoint =>
            typeof one === "object" &&
            one !== null &&
            typeof (one as TrailPoint).at === "number" &&
            typeof (one as TrailPoint).momentum === "number"
        );
      }
    } catch {
      held = [];
    }
  }
  // A re-run inside the same request clock replaces its own point rather than
  // stacking duplicates — the sweep has to be safe to run twice.
  const without = held.filter((one) => one.at !== point.at);
  return JSON.stringify([...without, point].slice(-keep));
}

/**
 * Ask VEC_MARKET, once per known theme, which of this tenant's vectors sit
 * near that theme. Returns the best theme per vector id, above the floor.
 *
 * The tenant filter is not optional — one index carries every tenant's vectors
 * (routes/scout.ts says the same about `/signals/similar`).
 */
export async function themesByVector(
  ctx: Ctx,
  gateway: Gateway,
  env: Env,
  themes: readonly string[]
): Promise<Map<string, { theme: string; score: number }>> {
  const best = new Map<string, { theme: string; score: number }>();
  if (!env.VEC_MARKET) return best;

  for (const theme of themes) {
    const matches = await embedQuery(ctx, gateway, env.VEC_MARKET, {
      module: "scout",
      purpose: "scout.cluster.assign",
      text: theme,
      topK: TOP_K,
      filter: { tenantId: ctx.tenantId }
    });
    for (const match of matches) {
      if (match.score < SIMILARITY_FLOOR) continue;
      const held = best.get(match.id);
      // Ties resolve on the theme name so two runs cannot disagree.
      if (!held || match.score > held.score || (match.score === held.score && theme < held.theme)) {
        best.set(match.id, { theme, score: match.score });
      }
    }
  }
  return best;
}

/**
 * Cluster the persisted signal corpus and write the result back.
 *
 * Idempotent: themes are derived from the rows, not accumulated, so a second
 * run over the same corpus updates the same cluster rows with the same numbers
 * and re-stamps the same `cluster_id`s. Nothing is appended except one trail
 * point per distinct clock.
 *
 * A deployment with no Vectorize binding still clusters — by source — which is
 * the same degradation `embedQuery` documents for every other index.
 */
export async function sweepSignalClusters(ctx: Ctx, gateway: Gateway, env: Env): Promise<ClusterSweepReport> {
  const rows = await signalsSince(ctx, ctx.now - CLUSTER_LOOKBACK_MS, CLUSTER_MAX_SIGNALS);
  if (!rows.length) return { signals: 0, clusters: 0, placedByIndex: 0, themes: [] };

  const existing = await ctx.db
    .select({ id: schema.scoutClusters.id, theme: schema.scoutClusters.theme, trailJson: schema.scoutClusters.trailJson })
    .from(schema.scoutClusters)
    .where(scoped(ctx, schema.scoutClusters));

  const placement = await themesByVector(
    ctx,
    gateway,
    env,
    existing.map((row) => row.theme)
  );

  let placedByIndex = 0;
  const themeOf = (row: { embeddingRef: string | null; source: string }): string => {
    const placed = row.embeddingRef ? placement.get(row.embeddingRef) : undefined;
    if (placed) {
      placedByIndex += 1;
      return placed.theme;
    }
    return row.source;
  };

  const themed = rows.map((row) => ({ row, theme: themeOf(row) }));
  const signals: RawSignal[] = themed.map(({ row, theme }) => ({
    id: row.id,
    category: theme,
    sourceRef: row.sourceRef,
    weight: row.weight,
    observedAt: row.observedAt
  }));

  const clusters = clusterSignals(signals, ctx.now, CLUSTER_WINDOW_MS);
  const spans = new Map<string, { first: number; last: number }>();
  for (const s of signals) {
    const span = spans.get(s.category);
    if (!span) spans.set(s.category, { first: s.observedAt, last: s.observedAt });
    else {
      span.first = Math.min(span.first, s.observedAt);
      span.last = Math.max(span.last, s.observedAt);
    }
  }

  const byTheme = new Map(existing.map((row) => [row.theme, row]));
  const idByTheme = new Map<string, string>();
  for (const cluster of clusters) {
    const span = spans.get(cluster.category) ?? { first: ctx.now, last: ctx.now };
    const held = byTheme.get(cluster.category);
    const trailJson = appendTrail(held?.trailJson ?? null, { at: ctx.now, momentum: cluster.momentum });
    if (held) {
      idByTheme.set(cluster.category, held.id);
      await ctx.db
        .update(schema.scoutClusters)
        .set({
          momentumScore: cluster.momentum,
          size: cluster.signalIds.length,
          lastSeen: span.last,
          trailJson,
          updatedAt: ctx.now
        })
        .where(scoped(ctx, schema.scoutClusters, eq(schema.scoutClusters.id, held.id)));
      continue;
    }
    const id = newId("clu", ctx.now);
    idByTheme.set(cluster.category, id);
    await ctx.db.insert(schema.scoutClusters).values({
      id,
      tenantId: ctx.tenantId,
      theme: cluster.category,
      summary: null,
      momentumScore: cluster.momentum,
      size: cluster.signalIds.length,
      firstSeen: span.first,
      lastSeen: span.last,
      trailJson,
      updatedAt: ctx.now
    } as never);
  }

  // The stamp. Without it `scout_signals.cluster_id` stays what it was before
  // this engine existed: a documented column nothing wrote outside the seed.
  for (const { row, theme } of themed) {
    const clusterId = idByTheme.get(theme);
    if (!clusterId || row.clusterId === clusterId) continue;
    await ctx.db
      .update(schema.scoutSignals)
      .set({ clusterId })
      .where(scoped(ctx, schema.scoutSignals, eq(schema.scoutSignals.id, row.id)));
  }

  return {
    signals: rows.length,
    clusters: clusters.length,
    placedByIndex,
    themes: clusters.map((one) => one.category)
  };
}

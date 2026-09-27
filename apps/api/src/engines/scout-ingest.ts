import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { scoped, type Ctx, type HarvestedSignal, type HarvestWindow, type SignalSource } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import { embedUpsert } from "./vectorize.js";
import type { Env } from "../env.js";

// docs/modules/scout.md §2.1 "Signal ingestion" / §3 "Harvester | schedules per
// source | fast | no". This is the Harvester: it asks every registered
// `SignalSource` (packages/core/src/seams.ts) for what it saw inside a window
// and writes one `scout_signals` row per item it has not already recorded.
//
// What ships is the seam plus adapters that read rows LYRA already holds. The
// external built-ins docs §2.1 names — search-trend connectors, app/review
// scraping, news/regulatory RSS, competitor page monitors — are third-party
// services and are refused until ADR-0078 is accepted (docs/02 §9, CLAUDE.md
// guardrails). An accepted ADR adds an adapter file and one line in
// `sourcesFor`; nothing else here changes. That is the seam working.

/** Half a year back, the same lookback the whitespace sweep reads. */
export const HARVEST_LOOKBACK_MS = 182 * 86_400_000;

/** Ceiling per source per run, so one loud source cannot make a sweep unbounded. */
export const HARVEST_MAX_PER_SOURCE = 500;

export interface HarvestReport {
  /** What the adapters offered, before deduplication. */
  readonly harvested: number;
  /** New `scout_signals` rows. A second run over the same window writes 0. */
  readonly ingested: number;
  /** Items already recorded under the same (source, sourceRef). */
  readonly duplicates: number;
  readonly bySource: Record<string, number>;
}

/**
 * Demand the panel was asked for. One signal per quote request, keyed by the
 * request id, so the same request never lands twice however often the harvest
 * runs. `weight` is the fan-out: a request sent to eight insurers is a louder
 * demand observation than one sent to one.
 */
function quoteDemandSource(ctx: Ctx): SignalSource {
  return {
    id: "internal.quotes",
    kind: "quotes",
    external: false,
    harvest: async (w) => rowsToSignals(ctx, w, "quotes", () => true)
  };
}

/**
 * The other half of the funnel: a shop that expired or was abandoned without
 * converting. docs §2.1 names funnel abandonment with reasons as its own
 * source, and `state` is the reason the schema actually records.
 */
function abandonmentSource(ctx: Ctx): SignalSource {
  return {
    id: "internal.abandonment",
    kind: "abandonment",
    external: false,
    harvest: async (w) => rowsToSignals(ctx, w, "abandonment", (state) => state === "abandoned" || state === "expired")
  };
}

async function rowsToSignals(
  ctx: Ctx,
  window: HarvestWindow,
  kind: "quotes" | "abandonment",
  keep: (state: string) => boolean
): Promise<HarvestedSignal[]> {
  const rows = await ctx.db
    .select({
      id: schema.distQuoteRequests.id,
      state: schema.distQuoteRequests.state,
      line: schema.products.line,
      fanoutCount: schema.distQuoteRequests.fanoutCount,
      respondedCount: schema.distQuoteRequests.respondedCount,
      createdAt: schema.distQuoteRequests.createdAt
    })
    .from(schema.distQuoteRequests)
    .innerJoin(schema.products, eq(schema.products.id, schema.distQuoteRequests.productId))
    .where(
      scoped(
        ctx,
        schema.distQuoteRequests,
        gte(schema.distQuoteRequests.createdAt, window.since),
        lte(schema.distQuoteRequests.createdAt, window.until)
      )
    )
    .limit(HARVEST_MAX_PER_SOURCE);

  return rows
    .filter((row) => keep(row.state))
    .map((row) => ({
      source: kind,
      sourceRef: row.id,
      payload: { line: row.line, state: row.state, fanout: row.fanoutCount, responded: row.respondedCount },
      observedAt: row.createdAt,
      weight: Math.max(1, row.fanoutCount)
    }));
}

/**
 * The feed adapter: whatever an integrator posted to the feed API in this
 * window, handed back unchanged. It is how a source with no connector — a
 * pasted regulator circular, an analyst's competitor note, a CSV of review
 * snippets — reaches the Clusterer through exactly the same path a crawled
 * one will. `external: false` is honest: the *items* came from outside, the
 * *fetch* did not.
 */
export function fedSource(items: readonly HarvestedSignal[]): SignalSource {
  return {
    id: "internal.feed",
    kind: "news",
    external: false,
    harvest: async (w) => items.filter((one) => one.observedAt >= w.since && one.observedAt <= w.until)
  };
}

/** Every source this deployment has. One place to read "what can arrive". */
export function sourcesFor(ctx: Ctx, fed: readonly HarvestedSignal[] = []): SignalSource[] {
  const sources = [quoteDemandSource(ctx), abandonmentSource(ctx)];
  if (fed.length) sources.push(fedSource(fed));
  return sources;
}

/** What the source manager renders — the registry, without running anything. */
export function describeSources(ctx: Ctx): { id: string; kind: string; external: boolean }[] {
  return [...sourcesFor(ctx), fedSource([])].map((s) => ({ id: s.id, kind: s.kind, external: s.external }));
}

/**
 * Run every source over `[now - lookback, now]` and persist what is new.
 *
 * Idempotent by construction: the (source, sourceRef) pairs already in
 * `scout_signals` are read first and anything matching is skipped, so a second
 * run in the same window ingests nothing. That is the same guarantee
 * `sweepWhitespace` gets from its live-category check, and it is why this can
 * be scheduled without a lock.
 *
 * Each new row is embedded into VEC_MARKET through the same `embedUpsert` the
 * CRUD ingest path uses (resources.ts SCOUT signals `beforeWrite`) — one
 * writer's worth of behaviour, two callers. A deployment with no Vectorize
 * binding stores the row without an `embedding_ref`, and the Clusterer then
 * falls back to grouping by source rather than failing.
 */
export async function harvestSignals(
  ctx: Ctx,
  gateway: Gateway,
  env: Env,
  opts: { fed?: readonly HarvestedSignal[]; lookbackMs?: number; fedOnly?: boolean } = {}
): Promise<HarvestReport> {
  const window: HarvestWindow = { since: ctx.now - (opts.lookbackMs ?? HARVEST_LOOKBACK_MS), until: ctx.now };
  // A file import stores what it was given and nothing else; a harvest also
  // runs every registered source.
  const sources = opts.fedOnly ? [fedSource(opts.fed ?? [])] : sourcesFor(ctx, opts.fed ?? []);

  const harvested: HarvestedSignal[] = [];
  for (const source of sources) {
    const items = await source.harvest(window);
    harvested.push(...items.slice(0, HARVEST_MAX_PER_SOURCE));
  }
  if (!harvested.length) return { harvested: 0, ingested: 0, duplicates: 0, bySource: {} };

  const refs = [...new Set(harvested.map((one) => one.sourceRef))];
  const known = await ctx.db
    .select({ source: schema.scoutSignals.source, sourceRef: schema.scoutSignals.sourceRef })
    .from(schema.scoutSignals)
    .where(scoped(ctx, schema.scoutSignals, inArray(schema.scoutSignals.sourceRef, refs)));
  const seen = new Set(known.map((row) => `${row.source}\u0000${row.sourceRef}`));

  const bySource: Record<string, number> = {};
  let ingested = 0;
  for (const one of harvested) {
    const key = `${one.source}\u0000${one.sourceRef}`;
    if (seen.has(key)) continue;
    seen.add(key); // two adapters offering the same item is a duplicate too

    const payloadJson = JSON.stringify(one.payload);
    const embeddingRef = await embedUpsert(ctx, gateway, env.VEC_MARKET, {
      module: "scout",
      purpose: "scout.signal.embed",
      id: newId("vec", ctx.now),
      text: payloadJson,
      metadata: { tenantId: ctx.tenantId, source: one.source }
    });

    await ctx.db.insert(schema.scoutSignals).values({
      id: newId("sig", ctx.now),
      tenantId: ctx.tenantId,
      source: one.source,
      sourceRef: one.sourceRef,
      payloadJson,
      embeddingRef: embeddingRef ?? null,
      clusterId: null,
      weight: one.weight ?? 1,
      observedAt: one.observedAt,
      createdAt: ctx.now
    } as never);

    ingested += 1;
    bySource[one.source] = (bySource[one.source] ?? 0) + 1;
  }

  return { harvested: harvested.length, ingested, duplicates: harvested.length - ingested, bySource };
}

/** The signals the Clusterer and the watch both read — one query, tenant-scoped. */
export async function signalsSince(
  ctx: Ctx,
  since: number,
  limit: number
): Promise<
  {
    id: string;
    source: string;
    sourceRef: string | null;
    payloadJson: string;
    embeddingRef: string | null;
    clusterId: string | null;
    weight: number;
    observedAt: number;
  }[]
> {
  return ctx.db
    .select({
      id: schema.scoutSignals.id,
      source: schema.scoutSignals.source,
      sourceRef: schema.scoutSignals.sourceRef,
      payloadJson: schema.scoutSignals.payloadJson,
      embeddingRef: schema.scoutSignals.embeddingRef,
      clusterId: schema.scoutSignals.clusterId,
      weight: schema.scoutSignals.weight,
      observedAt: schema.scoutSignals.observedAt
    })
    .from(schema.scoutSignals)
    .where(and(scoped(ctx, schema.scoutSignals, gte(schema.scoutSignals.observedAt, since))))
    .limit(limit);
}

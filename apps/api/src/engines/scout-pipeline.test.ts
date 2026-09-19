import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { id as newId, schema, EntitlementsJson, PolicyJson } from "@lyra/db";
import { permissionsForRole, seed, type Ctx, type HarvestedSignal } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { describeSources, harvestSignals } from "./scout-ingest.js";
import { appendTrail, sweepSignalClusters } from "./scout-cluster.js";
import { sweepPanelBench } from "./scout-bench.js";
import { runWatch } from "./scout-watch.js";
import type { Env } from "../env.js";

// docs/27 F51/F52. Three sweeps and a harvester, each of which has to be safe
// to run twice — that is what a nightly/weekly schedule means — and each of
// which must see only its own tenant's rows.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;
let tenantId: string;

const NOW = Date.UTC(2026, 4, 20, 8, 0, 0);

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "scout-pipeline-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "user",
      id: "u_1",
      tenantId,
      grants: [{ roleKey: "scout.admin", permissions: permissionsForRole("scout.admin") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

function gateway(): Gateway {
  const stub = makeStub({});
  return new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
}

/** Vectorize as a Map — the same stand-in journeys.test.ts uses. Every vector
 *  scores 1, so what this proves is the round trip and the tenant filter, never
 *  the ranking, which is Cloudflare's. */
function fakeIndex(): Env["VEC_MARKET"] {
  const vectors = new Map<string, { id: string; metadata?: Record<string, unknown> }>();
  return {
    upsert: async (rows: { id: string; metadata?: Record<string, unknown> }[]) => {
      for (const row of rows) vectors.set(row.id, row);
    },
    query: async (_values: number[], opts: { topK: number; filter?: Record<string, unknown> }) => ({
      matches: [...vectors.values()]
        .filter((one) => Object.entries(opts.filter ?? {}).every(([key, want]) => one.metadata?.[key] === want))
        .slice(0, opts.topK)
        .map((one) => ({ id: one.id, score: 1, metadata: one.metadata }))
    })
  } as unknown as Env["VEC_MARKET"];
}

/** One shopped request with `count` panel answers, on its own product line. */
async function seedShop(line: string, count: number, at: number, opts: { wins?: number } = {}): Promise<void> {
  const productId = newId("prd", at);
  const offeringIds = Array.from({ length: count }, (_, i) => newId("off", at + i));
  await ctx.db.insert(schema.products).values({
    id: productId,
    tenantId,
    line,
    nameJson: JSON.stringify({ en: line }),
    createdAt: at,
    updatedAt: at
  } as never);
  await ctx.db.insert(schema.distOfferings).values(
    offeringIds.map((offeringId, i) => ({
      id: offeringId,
      tenantId,
      productId,
      providerId: `prov_${i}`,
      code: `BENCH-${line}-${i}`,
      nameJson: JSON.stringify({ en: line }),
      currency: "AED",
      effectiveFrom: at,
      createdAt: at,
      updatedAt: at
    })) as never
  );

  const requestId = newId("qr", at);
  await ctx.db.insert(schema.distQuoteRequests).values({
    id: requestId,
    tenantId,
    customerId: `cust_${line}`,
    channelId: "chn_test",
    productId,
    inputsJson: "{}",
    currency: "AED",
    state: "complete",
    fanoutCount: count,
    respondedCount: count,
    createdAt: at,
    updatedAt: at
  } as never);
  await ctx.db.insert(schema.distQuoteResponses).values(
    offeringIds.map((offeringId, i) => ({
      id: newId("qs", at + i),
      tenantId,
      requestId,
      offeringId,
      providerId: `prov_${i}`,
      state: "quoted",
      premiumMinor: 90_000 + i * 10_000,
      currency: "AED",
      selectedAt: i < (opts.wins ?? 0) ? at : null,
      createdAt: at,
      updatedAt: at
    })) as never
  );
}

const fed = (over: Partial<HarvestedSignal> & Pick<HarvestedSignal, "sourceRef">): HarvestedSignal => ({
  source: "regulatory",
  payload: { headline: "circular" },
  observedAt: NOW - 86_400_000,
  weight: 1,
  ...over
});

describe("the signal source registry", () => {
  it("ships no adapter that leaves LYRA — the seam is declared, the integration is not (ADR-0078)", () => {
    const sources = describeSources(ctx);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((one) => one.external === false)).toBe(true);
    expect(sources.map((one) => one.id)).toContain("internal.feed");
  });
});

describe("harvestSignals", () => {
  it("records each source item once, and a second run ingests nothing", async () => {
    await seedShop("bench-motor", 3, NOW - 86_400_000);
    const env = { VEC_MARKET: fakeIndex() } as Env;

    const first = await harvestSignals(ctx, gateway(), env, { fed: [fed({ sourceRef: "circular-11" })] });
    expect(first.ingested).toBeGreaterThan(0);
    expect(first.bySource.regulatory).toBe(1);

    const second = await harvestSignals(ctx, gateway(), env, { fed: [fed({ sourceRef: "circular-11" })] });
    expect(second.ingested).toBe(0);
    expect(second.duplicates).toBe(second.harvested);
  });

  it("embeds what it writes, so VEC_MARKET holds a vector per signal", async () => {
    const env = { VEC_MARKET: fakeIndex() } as Env;
    await harvestSignals(ctx, gateway(), env, { fed: [fed({ sourceRef: "circular-embedded" })] });

    const rows = await ctx.db
      .select({ ref: schema.scoutSignals.embeddingRef, sourceRef: schema.scoutSignals.sourceRef })
      .from(schema.scoutSignals)
      .where(eq(schema.scoutSignals.tenantId, tenantId));
    const row = rows.find((one) => one.sourceRef === "circular-embedded");
    expect(row?.ref).toMatch(/^vec_/);
  });

  it("stores the row without a vector when no index is bound, rather than refusing", async () => {
    const report = await harvestSignals(ctx, gateway(), {} as Env, { fed: [fed({ sourceRef: "circular-no-index" })] });
    expect(report.ingested).toBe(1);
    const rows = await ctx.db
      .select({ ref: schema.scoutSignals.embeddingRef, sourceRef: schema.scoutSignals.sourceRef })
      .from(schema.scoutSignals)
      .where(eq(schema.scoutSignals.tenantId, tenantId));
    expect(rows.find((one) => one.sourceRef === "circular-no-index")?.ref).toBeNull();
  });
});

describe("appendTrail", () => {
  it("keeps the last N points and replaces its own clock rather than stacking", () => {
    const once = appendTrail(null, { at: 10, momentum: 5 });
    expect(appendTrail(once, { at: 10, momentum: 9 })).toBe(JSON.stringify([{ at: 10, momentum: 9 }]));
    let trail: string | null = null;
    for (let i = 0; i < 20; i += 1) trail = appendTrail(trail, { at: i, momentum: i }, 3);
    expect(JSON.parse(trail!)).toHaveLength(3);
  });

  it("starts a fresh trail on a malformed blob instead of throwing", () => {
    expect(JSON.parse(appendTrail("{not json", { at: 1, momentum: 2 }))).toEqual([{ at: 1, momentum: 2 }]);
  });
});

describe("sweepSignalClusters", () => {
  it("clusters the persisted corpus, stamps cluster_id, and is idempotent", async () => {
    const env = { VEC_MARKET: fakeIndex() } as Env;
    await harvestSignals(ctx, gateway(), env, {
      fed: [fed({ sourceRef: "cluster-a" }), fed({ sourceRef: "cluster-b" })]
    });

    const first = await sweepSignalClusters(ctx, gateway(), env);
    expect(first.signals).toBeGreaterThan(0);
    expect(first.clusters).toBeGreaterThan(0);

    const stamped = await ctx.db
      .select({ clusterId: schema.scoutSignals.clusterId })
      .from(schema.scoutSignals)
      .where(eq(schema.scoutSignals.tenantId, tenantId));
    expect(stamped.every((one) => one.clusterId !== null)).toBe(true);

    const before = await ctx.db
      .select()
      .from(schema.scoutClusters)
      .where(eq(schema.scoutClusters.tenantId, tenantId));
    const second = await sweepSignalClusters(ctx, gateway(), env);
    const after = await ctx.db.select().from(schema.scoutClusters).where(eq(schema.scoutClusters.tenantId, tenantId));
    expect(after).toHaveLength(before.length);
    expect(second.themes.sort()).toEqual(first.themes.sort());
  });

  it("writes a momentum trail the Radar's sparkline can read", async () => {
    const env = { VEC_MARKET: fakeIndex() } as Env;
    await sweepSignalClusters(ctx, gateway(), env);
    const rows = await ctx.db
      .select({ trailJson: schema.scoutClusters.trailJson })
      .from(schema.scoutClusters)
      .where(eq(schema.scoutClusters.tenantId, tenantId));
    const withTrail = rows.filter((one) => one.trailJson !== null);
    expect(withTrail.length).toBeGreaterThan(0);
    expect(Array.isArray(JSON.parse(withTrail[0]!.trailJson!))).toBe(true);
  });

  it("clusters by source when no index is bound rather than failing", async () => {
    const report = await sweepSignalClusters(ctx, gateway(), {} as Env);
    expect(report.placedByIndex).toBe(0);
    expect(report.clusters).toBeGreaterThan(0);
  });
});

describe("sweepPanelBench", () => {
  it("builds a cell per provider and updates it in place on a second run", async () => {
    await seedShop("bench-travel", 3, NOW - 5 * 86_400_000, { wins: 1 });

    const first = await sweepPanelBench(ctx);
    expect(first.cells).toBeGreaterThan(0);
    // Seeded bench rows the seed's own quote history also produces are updates,
    // not creations — every cell is one or the other, never neither.
    expect(first.created + first.updated).toBe(first.cells);

    const second = await sweepPanelBench(ctx);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(second.cells);

    const rows = await ctx.db
      .select()
      .from(schema.scoutPanelBench)
      .where(eq(schema.scoutPanelBench.tenantId, tenantId));
    const travel = rows.filter((one) => one.line === "bench-travel");
    expect(travel).toHaveLength(3);
    // 90k / 100k / 110k against a panel median of 100k.
    expect(travel.map((one) => one.ourPriceIdx).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([9_000, 10_000, 11_000]);
    expect(travel.every((one) => one.coverageGapsJson !== null)).toBe(true);
  });

  it("announces the rebuild on the bus (docs/modules/scout.md §6)", async () => {
    await sweepPanelBench(ctx);
    const events = await ctx.db
      .select({ type: schema.eventOutbox.type })
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.tenantId, tenantId));
    expect(events.map((one) => one.type)).toContain("scout.bench.updated");
  });
});

describe("runWatch", () => {
  it("raises a regulatory subject new to the watch and never writes a row", async () => {
    const env = { VEC_MARKET: fakeIndex() } as Env;
    await harvestSignals(ctx, gateway(), env, { fed: [fed({ sourceRef: "circular-watch-1" })] });

    const before = await ctx.db.select().from(schema.scoutSignals).where(eq(schema.scoutSignals.tenantId, tenantId));
    const report = await runWatch(ctx);
    const after = await ctx.db.select().from(schema.scoutSignals).where(eq(schema.scoutSignals.tenantId, tenantId));

    expect(after).toHaveLength(before.length);
    const regulatory = report.findings.filter((one) => one.kind === "regulatory");
    expect(regulatory.length).toBeGreaterThan(0);
    expect(regulatory.every((one) => one.severity === "urgent" || one.severity === "attention")).toBe(true);
  });

  it("never reports demand sources — those belong to the Clusterer", async () => {
    const report = await runWatch(ctx);
    expect(report.findings.some((one) => one.source === "quotes" || one.source === "abandonment")).toBe(false);
  });
});

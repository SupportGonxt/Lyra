import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { id as newId, schema } from "@lyra/db";
import { EntitlementsJson, PolicyJson } from "@lyra/db";
import { permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { cellSize, clusterSizes, coveragePerLine, evidenceRefCount, sweepWhitespace } from "./scout-whitespace.js";

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

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "scout-whitespace-test-password-2026" });
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
    now: Date.UTC(2026, 0, 6, 8, 0, 0),
    locale: "en",
    policy: PolicyJson.parse({}),
    // What seed() provisions: every module, so coverage reads the policy book.
    entitlements: EntitlementsJson.parse({ modules: ["axis", "orbit", "signal", "scout", "north"] })
  };
}, 120_000);

function stubbedGateway(opts?: { replies?: string[]; fail?: Error }): { stub: ReturnType<typeof makeStub>; gw: Gateway } {
  const stub = makeStub(opts?.fail ? { fail: opts.fail } : opts?.replies ? { replies: opts.replies } : {});
  return { stub, gw: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } }) };
}

// clusterSignals' novelty term wants distinct customers; checkKAnonymity's
// DEFAULT_K_FLOOR (20) wants a cell this size or bigger to come out `visible`.
// "motor" already has seed's own case/quote plus two active policies, so a
// fresh category with zero coverage and 20 same-window quotes clears both the
// momentum-above-average and coverage-below-average bars against it.
// docs/27 F13: demand is `dist_quote_responses`, grouped by the line of the
// product its request shopped for. A cluster is therefore one product, one
// offering, and `count` request/response pairs from distinct customers.
async function seedQuoteCluster(category: string, count: number, at: number): Promise<void> {
  const productId = newId("prd", at);
  const offeringId = newId("off", at);
  await ctx.db.insert(schema.products).values({
    id: productId,
    tenantId,
    line: category,
    nameJson: JSON.stringify({ en: category }),
    createdAt: at,
    updatedAt: at
  } as never);
  await ctx.db.insert(schema.distOfferings).values({
    id: offeringId,
    tenantId,
    productId,
    providerId: "prov_test",
    code: `WSP-${category}`,
    nameJson: JSON.stringify({ en: category }),
    currency: "AED",
    effectiveFrom: at,
    createdAt: at,
    updatedAt: at
  } as never);

  const rows = Array.from({ length: count }, (_, i) => ({
    requestId: newId("qr", at + i),
    responseId: newId("qs", at + i),
    customerId: `cust_${category}_${i}`
  }));
  await ctx.db.insert(schema.distQuoteRequests).values(
    rows.map((r) => ({
      id: r.requestId,
      tenantId,
      customerId: r.customerId,
      channelId: "chn_test",
      productId,
      inputsJson: "{}",
      currency: "AED",
      state: "complete",
      createdAt: at,
      updatedAt: at
    })) as never
  );
  await ctx.db.insert(schema.distQuoteResponses).values(
    rows.map((r) => ({
      id: r.responseId,
      tenantId,
      requestId: r.requestId,
      offeringId,
      providerId: "prov_test",
      state: "quoted",
      premiumMinor: 100_000,
      currency: "AED",
      createdAt: at,
      updatedAt: at
    })) as never
  );
}

describe("sweepWhitespace", () => {
  it("drafts a candidate's description through the gateway and persists the reply", async () => {
    // Not "home" or "motor": the sweep skips any category that already has a
    // live whitespace, and seedScout seeds those. "cyber" has neither a
    // product nor a seeded row, so it is genuinely fresh.
    await seedQuoteCluster("cyber", 20, ctx.now);
    const { stub, gw } = stubbedGateway({ replies: ["Cyber demand is climbing fast against a thin book."] });

    const count = await sweepWhitespace(ctx, gw);
    expect(count).toBe(1);
    expect(stub.calls[0]!.module).toBe("scout");
    expect(stub.calls[0]!.purpose).toBe("whitespace.describe");
    expect(stub.calls[0]!.tier).toBe("reasoning");

    const [row] = await ctx.db
      .select()
      .from(schema.scoutWhitespaces)
      .where(and(eq(schema.scoutWhitespaces.tenantId, tenantId), eq(schema.scoutWhitespaces.category, "cyber")));
    expect(row).toBeDefined();
    expect(row!.description).toBe("Cyber demand is climbing fast against a thin book.");
  });

  it("falls back to the deterministic template when the gateway call fails", async () => {
    await seedQuoteCluster("travel", 20, ctx.now);
    const { gw } = stubbedGateway({ fail: new Error("boom") });

    const count = await sweepWhitespace(ctx, gw);
    expect(count).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.scoutWhitespaces)
      .where(and(eq(schema.scoutWhitespaces.tenantId, tenantId), eq(schema.scoutWhitespaces.category, "travel")));
    expect(row).toBeDefined();
    expect(row!.description).toMatch(/^travel: demand momentum \d+ vs\. \d+ policies on the book$/);
  });

  // docs/27 F11: the Radar plots a whitespace row against its cluster's
  // momentum and drops any row missing either the link or a competition score.
  // A cold-start sweep that writes both nulls is a Radar that is empty forever.
  it("writes a plottable row: a real cluster link and a scored competition", async () => {
    await seedQuoteCluster("marine", 20, ctx.now);
    const { gw } = stubbedGateway({ replies: ["Marine demand is moving against a thin book."] });

    expect(await sweepWhitespace(ctx, gw)).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.scoutWhitespaces)
      .where(and(eq(schema.scoutWhitespaces.tenantId, tenantId), eq(schema.scoutWhitespaces.category, "marine")));
    expect(row!.clusterId).not.toBeNull();
    expect(row!.competitionScore).not.toBeNull();
    expect(row!.competitionScore).toBeGreaterThanOrEqual(0);
    expect(row!.competitionScore).toBeLessThanOrEqual(100);

    const [cluster] = await ctx.db
      .select()
      .from(schema.scoutClusters)
      .where(and(eq(schema.scoutClusters.tenantId, tenantId), eq(schema.scoutClusters.id, row!.clusterId!)));
    expect(cluster!.theme).toBe("marine");
    expect(cluster!.momentumScore).toBe(row!.demandEstimate);
    expect(cluster!.size).toBe(20);
  });

  // Re-running the sweep is the weekly Clusterer run: the category's cluster is
  // the same row with fresher numbers, never a second one competing with it.
  it("re-scores an existing cluster instead of inserting a duplicate", async () => {
    const { gw } = stubbedGateway({ replies: ["Marine demand is still moving."] });
    await sweepWhitespace(ctx, gw);

    const clusters = await ctx.db
      .select()
      .from(schema.scoutClusters)
      .where(and(eq(schema.scoutClusters.tenantId, tenantId), eq(schema.scoutClusters.theme, "marine")));
    expect(clusters).toHaveLength(1);
  });
});

// The cell a whitespace is suppressed against. This exists because the shipped
// seed suppressed all seven of its rows: `evidence_refs_json` on those rows is
// {refs:[...]} naming three *sources*, not the array of signal ids the sweep
// writes, so the count came back 0 against a floor of 20 and the Radar said
// "too few signals" about a theme whose own dossier printed "Cluster size 305".
describe("cellSize", () => {
  it("counts the cluster's signals, not the sources cited for them", () => {
    const sizes = new Map([["clu_1", 305]]);
    expect(cellSize({ clusterId: "clu_1", evidenceRefsJson: JSON.stringify(["a", "b", "c"]) }, sizes)).toBe(305);
  });

  it("falls back to the refs when the row has no cluster, which is then all there is", () => {
    expect(cellSize({ clusterId: null, evidenceRefsJson: JSON.stringify(["a", "b"]) }, new Map())).toBe(2);
  });

  it("falls back when the cluster link dangles rather than reading it as a full cell", () => {
    // A deleted cluster must suppress, not publish: a miss in the map is "we do
    // not know how many", and the safe reading of that is the refs alone.
    expect(cellSize({ clusterId: "clu_gone", evidenceRefsJson: JSON.stringify(["a"]) }, new Map())).toBe(1);
  });

  it("reads a zero-size cluster as zero rather than reaching past it", () => {
    const sizes = new Map([["clu_1", 0]]);
    expect(cellSize({ clusterId: "clu_1", evidenceRefsJson: JSON.stringify(["a", "b"]) }, sizes)).toBe(0);
  });
});

describe("evidenceRefCount", () => {
  it("counts a bare array - the shape the sweep writes", () => {
    expect(evidenceRefCount(JSON.stringify(["a", "b", "c"]))).toBe(3);
  });

  it("counts the refs inside the seed's {refs, demandEstimate} blob", () => {
    expect(evidenceRefCount(JSON.stringify({ refs: ["a", "b"], demandEstimate: { unit: "policies_per_year" } }))).toBe(2);
  });

  it("reads nothing, malformed JSON and an unknown shape as no evidence", () => {
    expect(evidenceRefCount(null)).toBe(0);
    expect(evidenceRefCount("{oops")).toBe(0);
    expect(evidenceRefCount(JSON.stringify({ demandEstimate: 5 }))).toBe(0);
  });
});

describe("clusterSizes", () => {
  it("reads each named cluster's size, and skips the nulls", async () => {
    const [cluster] = await ctx.db
      .select({ id: schema.scoutClusters.id, size: schema.scoutClusters.size })
      .from(schema.scoutClusters)
      .where(eq(schema.scoutClusters.tenantId, tenantId))
      .limit(1);
    expect(cluster).toBeDefined();

    const sizes = await clusterSizes(ctx, [cluster!.id, null, cluster!.id]);
    expect(sizes.get(cluster!.id)).toBe(cluster!.size);
  });

  it("asks nothing when every row is unclustered", async () => {
    expect(await clusterSizes(ctx, [null, null])).toEqual(new Map());
  });

  it("does not read another tenant's cluster size", async () => {
    const foreign = newId("clu", ctx.now);
    await ctx.db.insert(schema.scoutClusters).values({
      id: foreign,
      tenantId: "ten_other",
      theme: "elsewhere",
      momentumScore: 90,
      size: 999,
      firstSeen: ctx.now,
      lastSeen: ctx.now,
      updatedAt: ctx.now
    });
    expect(await clusterSizes(ctx, [foreign])).toEqual(new Map());
  });
});

// @accept:SA — coverage is "what this tenant already sells on that line". With
// AXIS it is the active policy book. Without AXIS there is no policy book, and
// reading one returned zero everywhere, so every line with demand looked like
// untouched whitespace. The platform's own record of a sale is a converted
// quote request, so that is the book a SCOUT-only tenant is measured against.
describe("coveragePerLine", () => {
  it("counts active policies when AXIS is on, and converted quote requests when it is not", async () => {
    const withAxis = await coveragePerLine(ctx);
    expect(withAxis.get("motor")).toBeGreaterThan(0);

    await seedQuoteCluster("pet", 3, ctx.now - 86_400_000);
    const pet = await ctx.db
      .select({ id: schema.distQuoteRequests.id })
      .from(schema.distQuoteRequests)
      .innerJoin(schema.products, eq(schema.products.id, schema.distQuoteRequests.productId))
      .where(and(eq(schema.distQuoteRequests.tenantId, tenantId), eq(schema.products.line, "pet")));
    for (const r of pet.slice(0, 2)) {
      await ctx.db.update(schema.distQuoteRequests).set({ state: "converted" }).where(eq(schema.distQuoteRequests.id, r.id));
    }

    const scoutOnly = await coveragePerLine({ ...ctx, entitlements: EntitlementsJson.parse({ modules: ["scout"] }) });
    expect(scoutOnly.get("pet")).toBe(2);
    expect(withAxis.get("pet")).toBeUndefined();
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { IDEMPOTENCY_TTL_MS, canonicalJson, notFound, sha256Hex, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { axisRoutes } from "./routes/axis.js";
import { crudRouter } from "./crud.js";
import { BY_MODULE } from "./resources.js";
import { onError } from "./mw.js";
import { MAX_POINTS_PER_BATCH, TelematicsIngest, type PolicyRow } from "./engines/telematics.js";
import type { App } from "./env.js";
import { seedTestChart } from "@lyra/ledger/test-chart";

// docs/27 F5 (Group E, task 5). Route-level coverage for the two doorways onto
// telematics/UBI: `/telemetry` (a machine/device authority) and `/reprice` (a
// priced endorsement, so it stays behind `axis:policies:endorse`). Modeled on
// premium-financing.test.ts's testApp(ctx) + seedTenantAndPolicy() convention
// and engines/ubi-reprice.test.ts's gateway-stub helpers.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const SOURCE = "telematics:obd:km";
const NOW = Date.UTC(2026, 5, 15, 12);
const START = NOW - 30 * DAY;
const END = NOW + 335 * DAY;

/** A reply the model could plausibly return, in the shape `parseUbi` accepts. */
function reply(premiumDeltaPpm: number, code = "km_band"): string {
  return JSON.stringify({
    premiumDeltaPpm,
    factors: [{ code, weight: 1, evidenceRef: SOURCE }],
    confidence: 0.8
  });
}

/** The gateway plus the stub behind it, so a test can read what was priced. */
function gatewayCapturing(...replies: string[]): { gateway: Gateway; stub: ReturnType<typeof makeStub> } {
  const stub = makeStub({ replies });
  return {
    stub,
    gateway: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } })
  };
}

function gatewayWith(...replies: string[]): Gateway {
  return gatewayCapturing(...replies).gateway;
}

async function seedTenantAndPolicy(opts: { permissions?: string[] } = {}): Promise<{ ctx: Ctx; policy: PolicyRow }> {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const tenantId = "t_1";
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: {
      kind: "user",
      id: "u_test",
      tenantId,
      grants: [{ roleKey: "test", permissions: opts.permissions ?? ["*:*:*"] }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    // autoApprove keeps `axis.endorse` out of the way for the tests that are
    // not specifically exercising the approval gate — repriceFromTelemetry's
    // own approval behaviour is engines/ubi-reprice.test.ts's job, not this
    // file's.
    policy: PolicyJson.parse({ currency: "ZAR", autoApprove: ["axis.endorse"] }),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);

  await ctx.db.insert(schema.products).values({
    id: "prod_ubi",
    tenantId,
    line: "motor",
    nameJson: JSON.stringify({ en: "Motor" }),
    pricingInputsJson: JSON.stringify({ km_band: {}, harsh_braking: {} }),
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  await ctx.db.insert(schema.axisPolicies).values({
    id: "pol_1",
    tenantId,
    customerId: "cust_1",
    providerId: "prov_1",
    productId: "prod_ubi",
    policyNo: "POL-1",
    versionSeq: 1,
    // The reprice route keys on `currentVersionId ?? versionSeq`; a real policy
    // always carries the id, so seeding it pins the branch ADR-0065 describes
    // rather than the sequence fallback.
    currentVersionId: "pver_1",
    startAt: START,
    endAt: END,
    premiumMinor: 100_000,
    currency: "ZAR",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  await ctx.db.insert(schema.axisPolicyVersions).values({
    id: "pver_1",
    tenantId,
    policyId: "pol_1",
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: START,
    effectiveTo: END,
    premiumMinor: 100_000,
    taxMinor: 15_000,
    feesMinor: 0,
    commissionMinor: 10_000,
    currency: "ZAR",
    premiumDeltaMinor: 0,
    proRataDays: 365,
    termsJson: JSON.stringify({ km_band: { weight: 0 } }),
    state: "effective",
    issuedBy: "user:u_test",
    issuedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  } as never);

  const [row] = await ctx.db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, "pol_1"));
  return { ctx, policy: row! };
}

/**
 * Direct-engine fixture setup (not through the route under test), mirroring
 * engines/ubi-reprice.test.ts's own `ingestKm` — this file's reprice tests
 * need telemetry already on file, and re-deriving the ingest engine's own
 * validation here would be the duplication the brief says not to ship.
 */
async function ingestKm(ctx: Ctx, policy: PolicyRow, ...values: number[]): Promise<void> {
  const ingest = new TelematicsIngest(ctx, SOURCE, policy);
  await ingest.ingest(
    `policy:${policy.id}`,
    values.map((value, i) => ({ at: NOW - (i + 1) * DAY, value }))
  );
}

async function points(ctx: Ctx) {
  return ctx.db.select().from(schema.axisTelemetryPoints).where(eq(schema.axisTelemetryPoints.tenantId, ctx.tenantId));
}

async function versions(ctx: Ctx) {
  return ctx.db.select().from(schema.axisPolicyVersions).where(eq(schema.axisPolicyVersions.tenantId, ctx.tenantId));
}

/** One row per gateway completion, so its length is the model-call count. */
async function modelCalls(ctx: Ctx) {
  return ctx.db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.tenantId, ctx.tenantId));
}

/** The transaction a reprice posts under: zero rows is "no money moved". */
async function ubiTxns(ctx: Ctx) {
  return ctx.db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.type, "UBI-REPRICE")));
}

async function keys(ctx: Ctx) {
  return ctx.db.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.tenantId, ctx.tenantId));
}

const batch = (points: unknown[]): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ source: SOURCE, points })
});

/**
 * Mirrors premium-financing.test.ts's testApp(ctx): a fixed ctx and a fixed
 * gateway injected directly, mounting the real axisRoutes and the real
 * axis/telemetry-points resource under their real paths — exercising the
 * actual route/permission/CRUD-lockdown wiring without the login detour.
 */
function testApp(ctx: Ctx, gateway: Gateway): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.notFound((c) => onError(notFound(c.req.path), c));
  app.use("*", async (c, next) => {
    c.set("ctx", ctx);
    c.set("gateway", gateway);
    await next();
  });
  app.route("/v1/axis", axisRoutes);
  const telemetryPoints = BY_MODULE.axis?.find((r) => r.path === "telemetry-points");
  if (!telemetryPoints) throw new Error("no axis/telemetry-points resource");
  app.route("/v1/axis/telemetry-points", crudRouter(telemetryPoints));
  return app;
}

describe("POST /policies/:id/telemetry", () => {
  it("stores points when the actor holds axis:policies:telemetry", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: SOURCE,
        points: [
          { at: NOW - DAY, value: 120 },
          { at: NOW - 2 * DAY, value: 95 }
        ]
      })
    });

    expect(res.status).toBe(201);
    expect(await points(ctx)).toHaveLength(2);
  });

  it("rejects without axis:policies:telemetry, before any write", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:read"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SOURCE, points: [{ at: NOW - DAY, value: 120 }] })
    });

    expect(res.status).toBe(403);
    expect(await points(ctx)).toHaveLength(0);
  });

  it("does not let axis:policies:endorse alone authorise /telemetry (separation of duties)", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SOURCE, points: [{ at: NOW - DAY, value: 120 }] })
    });

    expect(res.status).toBe(403);
    expect(await points(ctx)).toHaveLength(0);
  });

  it("surfaces a batch the engine refuses as a client error, not a 500, leaving no rows", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    // `at` before the cover term's startAt — TelematicsIngest's own bounds
    // check, not anything the route duplicates.
    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: SOURCE, points: [{ at: START - DAY, value: 120 }] })
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await points(ctx)).toHaveLength(0);
  });

  it("refuses an oversized batch at the route, not after parsing every point", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    const over = Array.from({ length: MAX_POINTS_PER_BATCH + 1 }, (_, i) => ({ at: NOW - DAY - i, value: 1 }));
    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, batch(over));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await points(ctx)).toHaveLength(0);
  });

  it("refuses a fractional instant, so `at` cannot drift off the dedup key", async () => {
    // The unique index is on the exact `at`; 1.5ms and 1.6ms are two rows for
    // one moment, and no window boundary lands between them.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, batch([{ at: NOW - DAY + 0.5, value: 1 }]));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await points(ctx)).toHaveLength(0);
  });
});

describe("retry storms", () => {
  it("stores one set of rows when a device re-flushes the same batch with no key", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));
    const body = batch([
      { at: NOW - DAY, value: 120 },
      { at: NOW - 2 * DAY, value: 95 }
    ]);

    const first = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, body);
    const second = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
    expect(await points(ctx)).toHaveLength(2);
    const txns = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.type, "TELEM-INGEST"));
    expect(txns).toHaveLength(1);
    expect(await keys(ctx)).toHaveLength(1);
  });

  it("refuses a caller key replayed with a different batch instead of storing both", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    const app = testApp(ctx, gatewayWith(reply(0)));
    const withKey = (points: unknown[]): RequestInit => {
      const init = batch(points);
      return { ...init, headers: { ...(init.headers as Record<string, string>), "idempotency-key": "k_dev_1" } };
    };

    const first = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, withKey([{ at: NOW - DAY, value: 120 }]));
    const second = await app.request(`/v1/axis/policies/${policy.id}/telemetry`, withKey([{ at: NOW - DAY, value: 999 }]));

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await points(ctx)).toHaveLength(1);
  });

  // The fallback key the route derives for `pol_1` once `ingestKm` has run:
  // the current version AND the newest unpriced instant, which `ingestKm`
  // stamps at NOW - DAY. Spelled out here rather than recomputed, so a change
  // to what the key names fails these tests instead of following them.
  // The exposure fingerprint the route derives: the newest unpriced instant and
  // how many unpriced points stand behind it, so a backfill moves the key too.
  const FALLBACK_KEY = `axis_ubi_reprice:pol_1:pver_1:${NOW - DAY}x3`;

  it("keys a header-less reprice to the exposure it is repricing, so a retry replays", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95, 140);
    const app = testApp(ctx, gatewayWith(reply(100_000), reply(100_000)));

    const first = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });
    expect(first.status).toBe(200);
    // Nothing else in the request identifies the attempt: the body is empty, so
    // without the version and the exposure in the key a retry is a second real
    // price move.
    expect((await keys(ctx)).map((k) => k.key)).toEqual([FALLBACK_KEY]);

    // The retry the transport would send after a lost response.
    const retry = await app.request(`/v1/axis/policies/${policy.id}/reprice`, {
      method: "POST",
      headers: { "idempotency-key": FALLBACK_KEY }
    });

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(await first.json());
    expect(await versions(ctx)).toHaveLength(2);
    expect(await modelCalls(ctx)).toHaveLength(1);
  });

  it("collapses a header-less double submit: the second call is refused, not priced again", async () => {
    // What the fallback key is FOR (ADR-0065). Two un-keyed submits arriving
    // while the first is still running read the same current version and the
    // same unpriced telemetry, so they derive one key and the second is refused as in-flight
    // rather than reaching the model. Pinned deterministically — an `in_flight`
    // row is exactly the state the first request is in mid-flight — because a
    // real race here would be a flaky test, which is Sev-2 in this repo.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95, 140);
    const app = testApp(ctx, gatewayWith(reply(100_000)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    await ctx.db.insert(schema.idempotencyKeys).values({
      id: "idm_inflight",
      tenantId: ctx.tenantId,
      key: FALLBACK_KEY,
      route: `POST ${route}`,
      // The route hands `withIdempotency` an empty request object: a reprice
      // carries no body, which is why the key has to carry the version and the
      // exposure.
      requestHash: await sha256Hex(canonicalJson({})),
      responseJson: null,
      status: "in_flight",
      expiresAt: ctx.now + 60_000,
      createdAt: ctx.now
    });

    const res = await app.request(route, { method: "POST" });

    expect(res.status).toBe(409);
    // Which 409: `withIdempotency` also throws one for a key reused with a
    // different body, so the status alone does not say the fallback key
    // collapsed anything.
    expect(((await res.json()) as { detail?: string }).detail).toMatch(/still in flight/);
    expect(await versions(ctx)).toHaveLength(1);
    expect(await modelCalls(ctx)).toHaveLength(0);
  });

  it("cannot bump the price twice from one window, key or no key", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95, 140);
    const app = testApp(ctx, gatewayWith(reply(100_000), reply(100_000)));

    const first = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });
    // A second header-less call derives a *different* key (the new version), so
    // the key is not what stops it — the window is: the reprice advanced
    // `effectiveFrom` to now, and the kilometres it priced are behind it.
    const second = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });

    expect(first.status).toBe(200);
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.status).toBeLessThan(500);
    expect(await versions(ctx)).toHaveLength(2);
    expect(await modelCalls(ctx)).toHaveLength(1);
  });
});

describe("POST /policies/:id/reprice", () => {
  it("reprices when the actor holds axis:policies:endorse", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95, 140);
    const app = testApp(ctx, gatewayWith(reply(100_000)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });

    expect(res.status).toBe(200);
    const out = (await res.json()) as { repriced: boolean; premiumMinor?: number };
    expect(out.repriced).toBe(true);
    expect(out.premiumMinor).toBe(110_000);
  });

  it("returns repriced:false as a 200, not an error, on a genuine no-op", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95);
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repriced: false });
  });

  it("bills one model call for a header-less retry storm whose reprice moves nothing", async () => {
    // `repriced:false` is NOT a free no-op: it is only reachable after
    // `gateway.complete` has billed a provider call and written an
    // `ai_audit_log` row. Three POSTs must therefore buy exactly one model call
    // — and leave no version and no UBI-REPRICE transaction behind. Asserting
    // the call count and the zero rows, not that the calls returned 200: a
    // liveness assertion is what let a header-less storm bill three times.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95);
    const app = testApp(ctx, gatewayWith(reply(0), reply(0), reply(0)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;

    const first = await app.request(route, { method: "POST" });
    const second = await app.request(route, { method: "POST" });
    const third = await app.request(route, { method: "POST" });

    for (const res of [first, second, third]) {
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ repriced: false });
    }
    expect(await modelCalls(ctx)).toHaveLength(1);
    expect(await versions(ctx)).toHaveLength(1);
    expect(await ubiTxns(ctx)).toHaveLength(0);
  });

  it("replays a caller's key rather than re-asking a model that answers differently", async () => {
    // The model is not deterministic: the same window asked twice comes back 0
    // and then +20%. A caller-supplied `Idempotency-Key` is the caller saying
    // "these two POSTs are one request", so the second must replay the first's
    // no-op. The 200000 must never reach a version or the ledger.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    await ingestKm(ctx, policy, 120, 95);
    const app = testApp(ctx, gatewayWith(reply(0), reply(200_000)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    const init: RequestInit = { method: "POST", headers: { "idempotency-key": "k_ops_1" } };

    const first = await app.request(route, init);
    const second = await app.request(route, init);

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ repriced: false });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ repriced: false });
    expect(await modelCalls(ctx)).toHaveLength(1);
    expect(await versions(ctx)).toHaveLength(1);
    expect(await ubiTxns(ctx)).toHaveLength(0);
  });

  it("mints a new fallback key when new telemetry arrives, so the next window prices it", async () => {
    // Pins the key *format*: it names the exposure to be priced, not the version
    // it starts from, so it changes exactly when new unpriced telemetry lands.
    // Without that, one no-op would suppress this cover for 24h while kilometres
    // pile up unpriced. (Keeping a no-op's key is pinned by the two tests above,
    // which are the ones that fail if the key is released — this one passes
    // either way, since a released key would also let the second POST price.)
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    const app = testApp(ctx, gatewayWith(reply(0), reply(100_000)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    const ingestAt = (at: number, value: number) =>
      new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at, value }]);

    await ingestAt(NOW - 3 * DAY, 120);
    const first = await app.request(route, { method: "POST" });
    expect(await first.json()).toEqual({ repriced: false });

    await ingestAt(NOW - 2 * DAY, 400);
    const second = await app.request(route, { method: "POST" });

    expect(second.status).toBe(200);
    const out = (await second.json()) as { repriced: boolean; premiumMinor?: number };
    expect(out.repriced).toBe(true);
    expect(out.premiumMinor).toBe(110_000);
    expect(await versions(ctx)).toHaveLength(2);
    const [txn] = await ubiTxns(ctx);
    expect(txn?.state).toBe("settled");
    expect(await modelCalls(ctx)).toHaveLength(2);
  });

  it("mints a new fallback key for a backfilled point older than the newest stored one", async () => {
    // A device that buffers offline uploads out of order, so the exposure grows
    // *behind* the newest point already stored. A key that named only the max
    // instant would not move for that batch, and the kilometres it carries would
    // replay a no-op until the key expired. The key counts the unpriced points
    // as well as dating them, so this prices. (Like the test above, this pins
    // the key format, not the decision to keep a no-op's key.)
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    const app = testApp(ctx, gatewayWith(reply(0), reply(100_000)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    const ingestAt = (at: number, value: number) =>
      new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at, value }]);

    await ingestAt(NOW - 2 * DAY, 120);
    expect(await (await app.request(route, { method: "POST" })).json()).toEqual({ repriced: false });

    // Older than the point already stored, and still unpriced: the no-op moved
    // no watermark, so this instant is inside the window the next reprice reads.
    await ingestAt(NOW - 3 * DAY, 400);
    const second = await app.request(route, { method: "POST" });

    const out = (await second.json()) as { repriced: boolean; premiumMinor?: number };
    expect(out.repriced).toBe(true);
    expect(out.premiumMinor).toBe(110_000);
    expect(await versions(ctx)).toHaveLength(2);
    expect((await ubiTxns(ctx))[0]?.state).toBe("settled");
    expect(await modelCalls(ctx)).toHaveLength(2);
  });

  it("does not bill a second model call for a point the priced window cannot reach yet", async () => {
    // Ingest bounds a point by the cover's term and the priced watermark, never
    // by the clock, so a device running fast stores a future-dated point. The
    // reprice prices `[watermark, now)`, so that point changes nothing about the
    // question being asked — and a key that counted it would ask a model the
    // same question a second time, on the tenant's money.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    const app = testApp(ctx, gatewayWith(reply(0), reply(100_000)));
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    const ingestAt = (at: number, value: number) =>
      new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at, value }]);

    await ingestAt(NOW - DAY, 120);
    expect(await (await app.request(route, { method: "POST" })).json()).toEqual({ repriced: false });

    await ingestAt(NOW + DAY, 400);
    const second = await app.request(route, { method: "POST" });

    expect(await second.json()).toEqual({ repriced: false });
    expect(await modelCalls(ctx)).toHaveLength(1);
    expect(await versions(ctx)).toHaveLength(1);
    expect(await ubiTxns(ctx)).toHaveLength(0);
  });

  it("prices a future-dated point once the clock reaches it, rather than replaying the no-op", async () => {
    // The other half of the same divergence. Once `now` passes the point, it is
    // inside the priced window and worth a real price move — but the exposure
    // it belongs to has not changed since the last run by any measure taken
    // past the window's end, so a key ignoring the upper bound replays a stored
    // `repriced:false` over it for the whole 24h TTL.
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:endorse"] });
    const { gateway, stub } = gatewayCapturing(reply(0), reply(100_000), reply(100_000));
    const app = testApp(ctx, gateway);
    const route = `/v1/axis/policies/${policy.id}/reprice`;
    const ingestAt = (at: number, value: number) =>
      new TelematicsIngest(ctx, SOURCE, policy).ingest(`policy:${policy.id}`, [{ at, value }]);

    await ingestAt(NOW - DAY, 120);
    await app.request(route, { method: "POST" });
    await ingestAt(NOW + HOUR * 12, 400);
    await app.request(route, { method: "POST" });

    // Inside the key's TTL deliberately: past it the third POST runs on an
    // expired slot whatever the key says, and the test would pass with the key
    // stubbed to a constant — pinning the TTL rather than the window bound. Read
    // from the constant so a shortened TTL fails here instead of quietly turning
    // this into a different test.
    const advance = HOUR * 13;
    expect(advance, "the scenario must stay inside the idempotency window it is testing around").toBeLessThan(
      IDEMPOTENCY_TTL_MS
    );
    ctx.now = NOW + advance;
    const out = (await (await app.request(route, { method: "POST" })).json()) as {
      repriced: boolean;
      premiumMinor?: number;
    };

    expect(out.repriced).toBe(true);
    expect(out.premiumMinor).toBe(110_000);
    expect(await versions(ctx)).toHaveLength(2);
    expect((await ubiTxns(ctx))[0]?.state).toBe("settled");
    // Two runs, not three: the middle call replayed. And the run that did price
    // was asked about both points' kilometres, over a window ending at the
    // clock it ran under.
    expect(await modelCalls(ctx)).toHaveLength(2);
    const priced = JSON.parse(stub.calls[1]!.messages.at(-1)!.content) as {
      series: { total: number }[];
      windowEnd: string;
    };
    expect(priced.series[0]!.total).toBe(520);
    expect(priced.windowEnd).toBe(new Date(NOW + advance).toISOString());
  });

  it("rejects without axis:policies:endorse, before any write", async () => {
    const { ctx, policy } = await seedTenantAndPolicy({ permissions: ["axis:policies:telemetry"] });
    await ingestKm(ctx, policy, 120, 95);
    const app = testApp(ctx, gatewayWith(reply(100_000)));

    const res = await app.request(`/v1/axis/policies/${policy.id}/reprice`, { method: "POST" });

    expect(res.status).toBe(403);
    const [version] = await ctx.db
      .select()
      .from(schema.axisPolicyVersions)
      .where(eq(schema.axisPolicyVersions.policyId, policy.id));
    expect(version!.versionSeq).toBe(1);
  });
});

describe("telemetry-points resource route (regression)", () => {
  it("rejects a direct create against the generic CRUD route", async () => {
    const { ctx } = await seedTenantAndPolicy();
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request("/v1/axis/telemetry-points", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectRef: "policy:pol_1", source: SOURCE, at: NOW, value: 10 })
    });

    // ro() declares no `create` permission, so crud.ts never registers the
    // POST route at all — it falls through to app.notFound (404), matching
    // the payment-plans regression test's established, tested convention.
    expect(res.status).toBe(404);
  });

  it("rejects a direct update against the generic CRUD route", async () => {
    const { ctx, policy } = await seedTenantAndPolicy();
    await ingestKm(ctx, policy, 120);
    const [row] = await points(ctx);
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/telemetry-points/${row!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 999 })
    });

    expect(res.status).toBe(404);
  });

  it("rejects a direct delete against the generic CRUD route, leaving the row", async () => {
    const { ctx, policy } = await seedTenantAndPolicy();
    await ingestKm(ctx, policy, 120);
    const [row] = await points(ctx);
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request(`/v1/axis/telemetry-points/${row!.id}`, { method: "DELETE" });

    // 404 because `ro()` declares read only — the row is still there, so the
    // status is the missing *verb*, not a missing record.
    expect(res.status).toBe(404);
    expect(await points(ctx)).toHaveLength(1);
  });

  it("still allows a read, of this tenant's actual points", async () => {
    const { ctx, policy } = await seedTenantAndPolicy();
    await ingestKm(ctx, policy, 120);
    const app = testApp(ctx, gatewayWith(reply(0)));

    const res = await app.request("/v1/axis/telemetry-points", { method: "GET" });

    // A 200 alone would pass against an empty page: the point of `ro()` is that
    // read still works, so assert the row comes back.
    expect(res.status).toBe(200);
    const out = (await res.json()) as { data: { subjectRef: string; source: string; value: number }[] };
    expect(out.data).toHaveLength(1);
    expect(out.data[0]).toMatchObject({ subjectRef: `policy:${policy.id}`, source: SOURCE, value: 120 });
  });
});

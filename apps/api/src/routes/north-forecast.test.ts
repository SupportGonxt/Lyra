import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "../index.js";
import type { Env } from "../env.js";

// docs/27 F50: the forecast endpoint. What matters here rather than in the
// engine test is the seam every reader crosses — the permission gate (sighting
// 6: a route whose failure mode is "the caller lacks a permission" has to be
// tested *as* that caller), the refusal to forecast from an open period, and
// the 404 for a metric this tenant does not have.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let env: Env;
let database: Db;
let tenantId: string;
/** hala.zayed — north.exec, so every NORTH read including the forecast. */
let execToken: string;
/** layla.hassan — axis.agent, no NORTH read at all. */
let outsiderToken: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(token: string | null, path: string): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function login(local: string): Promise<string> {
  const first = await app.fetch(
    new Request("http://api.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" })
    }),
    env as never,
    exec as never
  );
  expect(first.status).toBe(200);
  const token = ((await first.json()) as { token: string }).token;
  const verified = await app.fetch(
    new Request("http://api.test/v1/auth/mfa/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) })
    }),
    env as never,
    exec as never
  );
  expect(verified.status).toBe(200);
  return token;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173", FIELD_KEY: "test-field-key" } as unknown as Env;
  execToken = await login("hala.zayed");
  outsiderToken = await login("layla.hassan");

  const [tenant] = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, "gonxt"));
  tenantId = tenant!.id;

  // Two years of closed months for one metric, so the projection has a season
  // and a trend to find, plus an open month-to-date row it must ignore.
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const period = `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    rows.push({
      id: `snp_fc_${i}`,
      tenantId,
      metricKey: "gwp",
      grain: "month",
      period,
      dimsHash: "",
      value: 100_000_000 + i * 1_000_000,
      ts: Date.now()
    });
  }
  const openMonth = new Date().toISOString().slice(0, 7);
  rows.push({
    id: "snp_fc_open",
    tenantId,
    metricKey: "gwp",
    grain: "month",
    period: openMonth,
    dimsHash: "",
    // A month-to-date collapse. If the forecast reads it, the projection dives.
    value: 1_000,
    ts: Date.now()
  });
  await database.delete(schema.northSnapshots).where(and(eq(schema.northSnapshots.tenantId, tenantId), eq(schema.northSnapshots.metricKey, "gwp")));
  await database.insert(schema.northSnapshots).values(rows);
});

describe("GET /v1/north/forecast", () => {
  it("projects the metric forward, as a band and with the fit that produced it", async () => {
    const res = await call(execToken, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=6");
    expect(res.status).toBe(200);
    expect(res.body.metricKey).toBe("gwp");
    expect(res.body.unit).toBe("money");
    expect(res.body.currency).toBe("AED");
    expect(res.body.points).toHaveLength(6);
    for (const point of res.body.points) {
      expect(point.p10).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p90);
    }
    expect(res.body.fit.method).toBe("damped_holt_seasonal");
    expect(res.body.fit.observations).toBe(24);
  });

  it("forecasts from closed periods only — a month-to-date row is half a month", async () => {
    const res = await call(execToken, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=3");
    expect(res.status).toBe(200);
    expect(res.body.fit.lastObserved).toBe("2024-12");
    // The open row is a thousand; a projection that read it would be nowhere
    // near the hundred million the closed months are.
    expect(res.body.points[0].p50).toBeGreaterThan(50_000_000);
  });

  it("refuses a reader without north:forecasts:read, and refuses it as a 403", async () => {
    const res = await call(outsiderToken, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=3");
    expect(res.status).toBe(403);
  });

  it("refuses a signed-out reader", async () => {
    expect((await call(null, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=3")).status).toBe(401);
  });

  it("404s a metric this tenant does not have, rather than forecasting nothing", async () => {
    const res = await call(execToken, "/v1/north/forecast?metricKey=not_a_metric&grain=month&horizon=3");
    expect(res.status).toBe(404);
  });

  it("400s a horizon outside the bounds it will answer for", async () => {
    expect((await call(execToken, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=0")).status).toBe(400);
    expect((await call(execToken, "/v1/north/forecast?metricKey=gwp&grain=month&horizon=99")).status).toBe(400);
  });

  it("says why it has no points rather than returning an empty list as an answer", async () => {
    const res = await call(execToken, "/v1/north/forecast?metricKey=policies_issued&grain=day&horizon=7");
    expect(res.status).toBe(200);
    if (res.body.points.length === 0) expect(res.body.reason).toBe("insufficient_history");
  });
});

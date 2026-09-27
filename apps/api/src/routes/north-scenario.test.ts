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

// docs/30 NORTH 4: POST /v1/north/scenarios/{id}/run. The engine test holds the
// arithmetic; this holds the seams a reader crosses — the permission gate, as
// the caller who lacks it (sighting 6), the 422 that names which assumption to
// fix, and the generic CRUD that must not be a second, uncomputed writer of the
// answer.

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
/** hala.zayed — north.exec, so every NORTH read including scenarios, and north:scenarios:run. */
let execToken: string;
/** layla.hassan — axis.agent, no NORTH read at all. */
let outsiderToken: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(token: string | null, method: string, path: string, body?: unknown): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
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

  // Two years of closed months for gwp, and an open month it must not read.
  const rows = [];
  for (let i = 0; i < 24; i++) {
    const period = `${2023 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
    rows.push({ id: `snp_sc_${i}`, tenantId, metricKey: "gwp", grain: "month", period, dimsHash: "", value: 100_000_000 + i * 1_000_000, ts: Date.now() });
  }
  rows.push({ id: "snp_sc_open", tenantId, metricKey: "gwp", grain: "month", period: new Date().toISOString().slice(0, 7), dimsHash: "", value: 1_000, ts: Date.now() });
  await database.delete(schema.northSnapshots).where(and(eq(schema.northSnapshots.tenantId, tenantId), eq(schema.northSnapshots.metricKey, "gwp")));
  await database.insert(schema.northSnapshots).values(rows);
});

async function ask(assumptions: Record<string, unknown>): Promise<string> {
  const created = await call(execToken, "POST", "/v1/north/scenarios", {
    question: "What if motor prices rise 10%?",
    author: "hala.zayed",
    assumptionsJson: assumptions
  });
  expect(created.status).toBe(201);
  return created.body.id as string;
}

describe("POST /v1/north/scenarios/{id}/run", () => {
  it("computes the stored question and the answer reads back on the scenario", async () => {
    const id = await ask({ metric: "gwp", changeBps: 1_000, horizonMonths: 3, note: "price only" });
    const run = await call(execToken, "POST", `/v1/north/scenarios/${id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.resultJson).toMatchObject({ method: "baseline_shift", metricKey: "gwp", unit: "money", currency: "AED", ignored: ["note"] });
    expect(run.body.resultJson.fit.lastObserved).toBe("2024-12");
    expect(run.body.resultJson.points).toHaveLength(3);

    const read = await call(execToken, "GET", `/v1/north/scenarios/${id}`);
    expect(read.body.resultJson).toEqual(run.body.resultJson);
    const point = read.body.resultJson.points[0];
    expect(point.scenario.p50).toBe(Math.round((point.baseline.p50 * 11_000) / 10_000));
    expect(point.scenario.p10).toBeLessThan(point.scenario.p90);
  });

  it("names each assumption it cannot read with a 422, and leaves the question unanswered", async () => {
    const id = await ask({ channelSharePpm: 450_000, horizonMonths: 6 });
    const run = await call(execToken, "POST", `/v1/north/scenarios/${id}/run`);
    expect(run.status).toBe(422);
    expect(run.body.errors).toEqual({ metric: "missing", changeBps: "missing" });
    expect((await call(execToken, "GET", `/v1/north/scenarios/${id}`)).body.resultJson).toBeNull();
  });

  it("refuses a reader without north:scenarios:run as a 403, and a signed-out one as a 401", async () => {
    const id = await ask({ metric: "gwp", changeBps: 1_000, horizonMonths: 3 });
    expect((await call(outsiderToken, "POST", `/v1/north/scenarios/${id}/run`)).status).toBe(403);
    expect((await call(null, "POST", `/v1/north/scenarios/${id}/run`)).status).toBe(401);
  });

  it("404s a scenario that does not exist", async () => {
    expect((await call(execToken, "POST", "/v1/north/scenarios/scn_nope/run")).status).toBe(404);
  });
});

describe("the generic scenario CRUD is not a second writer of the answer", () => {
  it("drops a result and a model run sent with a new question", async () => {
    const created = await call(execToken, "POST", "/v1/north/scenarios", {
      question: "What if everything doubled?",
      author: "hala.zayed",
      assumptionsJson: { metric: "gwp", changeBps: 10_000, horizonMonths: 1 },
      resultJson: { gwpDeltaMinor: 999 },
      modelRunRef: "run_forged"
    });
    expect(created.status).toBe(201);
    expect(created.body.resultJson).toBeNull();
    expect(created.body.modelRunRef).toBeNull();
  });

  it("ignores a patched result, and clears a computed one when the assumptions change under it", async () => {
    const id = await ask({ metric: "gwp", changeBps: 1_000, horizonMonths: 3 });
    await call(execToken, "POST", `/v1/north/scenarios/${id}/run`);

    const forged = await call(execToken, "PATCH", `/v1/north/scenarios/${id}`, { resultJson: { gwpDeltaMinor: 1 } });
    // Stripped to nothing, so there is nothing to update — and nothing changed.
    expect(forged.status).toBe(400);
    expect((await call(execToken, "GET", `/v1/north/scenarios/${id}`)).body.resultJson.method).toBe("baseline_shift");

    const shared = await call(execToken, "PATCH", `/v1/north/scenarios/${id}`, { sharedWithJson: ["rana.hadid"] });
    expect(shared.body.resultJson.method).toBe("baseline_shift");

    const changed = await call(execToken, "PATCH", `/v1/north/scenarios/${id}`, {
      assumptionsJson: { metric: "gwp", changeBps: -500, horizonMonths: 3 }
    });
    expect(changed.status).toBe(200);
    // An answer to other assumptions is not this scenario's answer.
    expect(changed.body.resultJson).toBeNull();
  });
});

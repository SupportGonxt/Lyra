import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/modules/north.md §8: **"A metric definition change shows as a chart
// annotation from the change date."**
//
// The date is the whole of the criterion's second half, and `north_metrics`
// could not supply it: it holds the definition in force and one `updated_at`, so
// a metric edited three times could only ever say when it was last touched. This
// file holds the history that makes a change datable — and that a *no-op* edit
// leaves no trace, because a phantom row saying the definition changed would be
// worse than no row at all.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

let database: Db;
let env: Env;
let seeded: SeedResult;
let tokens: Record<string, string>;
let metricId: string;
let metricKey: string;

async function call<T = any>(who: string | null, method: string, path: string, payload?: unknown): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : null) as T };
}

function ok<T>(res: { status: number; body: T }, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

const history = () =>
  database
    .select()
    .from(schema.northMetricDefinitions)
    .where(and(eq(schema.northMetricDefinitions.tenantId, seeded.tenantId), eq(schema.northMetricDefinitions.metricKey, metricKey)));

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(stmt);
  }
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  tokens = {};
  const login = ok(await call(null, "POST", "/v1/auth/login", { email: "rana.hadid@gonxt.ae", password: PASSWORD, tenantSlug: "gonxt" }));
  const token = login.token as string;
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
  // `north.analyst` holds `north:metrics:write`; a tenant admin does not.
  tokens["analyst"] = token;

  const [metric] = await database.select().from(schema.northMetrics).limit(1);
  metricId = metric!.id;
  metricKey = metric!.key;
}, 120_000);

describe("a metric definition change is datable", () => {
  it("records a row when the definition changes, naming the new definition and the actor", async () => {
    const [before] = await database.select().from(schema.northMetrics).where(eq(schema.northMetrics.id, metricId));
    expect(await history()).toHaveLength(0);

    ok(
      await call("analyst", "PATCH", `/v1/north/metrics/${metricId}`, {
        definitionSqlRef: "sql/metrics/revised_gwp.sql"
      })
    );

    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definitionSqlRef).toBe("sql/metrics/revised_gwp.sql");
    expect(rows[0]!.definitionSqlRef).not.toBe(before!.definitionSqlRef);
    // The date is the point of the criterion: an annotation is drawn *from* it.
    expect(rows[0]!.changedAt).toBeGreaterThanOrEqual(before!.updatedAt);
    expect(rows[0]!.changedBy).toContain("user:");
  });

  it("leaves no trace when the definition is rewritten with the same value", async () => {
    // A save that changes nothing is not a change. A phantom row would move the
    // annotation to a date on which nothing happened.
    ok(
      await call("analyst", "PATCH", `/v1/north/metrics/${metricId}`, {
        definitionSqlRef: "sql/metrics/revised_gwp.sql"
      })
    );
    expect(await history()).toHaveLength(1);
  });

  it("keeps every change, newest last, so a metric edited twice has two dates", async () => {
    ok(await call("analyst", "PATCH", `/v1/north/metrics/${metricId}`, { definitionSqlRef: "sql/metrics/v3.sql" }));
    const rows = await history();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.definitionSqlRef).sort()).toEqual(["sql/metrics/revised_gwp.sql", "sql/metrics/v3.sql"]);
  });

  it("does not record a metric being created, because a first definition is not a change", async () => {
    // The hook returns early on `create`: there is no earlier value to differ
    // from, and a "changed on" row for a metric's birth would be a lie.
    const created = ok(
      await call("analyst", "POST", "/v1/north/metrics", {
        key: "definition_history_probe",
        nameJson: JSON.stringify({ en: "Probe", ar: "مسبار" }),
        definitionSqlRef: "sql/metrics/probe.sql",
        unit: "count",
        grain: "month"
      })
    );
    const rows = await database
      .select()
      .from(schema.northMetricDefinitions)
      .where(eq(schema.northMetricDefinitions.metricKey, "definition_history_probe"));
    expect(rows).toHaveLength(0);
    expect(created.id).toBeTruthy();
  });
});

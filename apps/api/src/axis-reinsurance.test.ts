import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, id as newId, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/30 AXIS 5, ADR-0106 — the HTTP surface of reinsurance: treaties are a
// tenant resource the reinsurance desk writes, cessions are read-only (the
// engine is their one writer), and the write path refuses exactly the terms
// the planner would refuse to cede against.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const DAY = 86_400_000;
const exec = { waitUntil() {}, passThroughOnException() {} };

let env: Env;
let database: Db;
let seeded: SeedResult;
let lead: string;
let controller: string;
let internalId: string;
let reinsurerId: string;

interface Res<T = any> { status: number; body: T; }

async function call<T = any>(method: string, path: string, token: string, payload?: unknown): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : null) as T };
}

async function login(local: string): Promise<string> {
  const res = await call("POST", "/v1/auth/login", "", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" });
  expect(res.status).toBe(200);
  const issued = res.body.token as string;
  const verified = await call("POST", "/v1/auth/mfa/verify", issued, {
    code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
  });
  expect(verified.status).toBe(200);
  return issued;
}

async function grantRole(userId: string, roleKey: string): Promise<void> {
  const now = Date.now();
  const [role] = await database
    .select()
    .from(schema.roles)
    .where(and(eq(schema.roles.tenantId, seeded.tenantId), eq(schema.roles.key, roleKey)));
  await database.insert(schema.userRoles).values({
    id: newId("urr", now),
    tenantId: seeded.tenantId,
    userId,
    roleId: role!.id,
    createdAt: now
  } as typeof schema.userRoles.$inferInsert);
}

const quotaShare = (ref: string, over: Record<string, unknown> = {}) => ({
  ref,
  reinsurerId,
  kind: "quota_share",
  productLine: "motor",
  currency: "AED",
  cededSharePpm: 400_000,
  cedingCommissionPpm: 250_000,
  effectiveFrom: Date.now() - DAY,
  effectiveTo: Date.now() + 365 * DAY,
  ...over
});

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;
  const providers = await database.select().from(schema.providers).where(eq(schema.providers.tenantId, seeded.tenantId));
  internalId = providers.find((p) => p.isInternal)!.id;
  reinsurerId = providers.find((p) => !p.isInternal)!.id;
  controller = await login("faisal.omar");
  lead = await login("omar.farouk");
}, 180_000);

describe("reinsurance treaties (docs/30 AXIS 5)", () => {
  it("an operations lead and a finance controller read treaties and cessions but may not write a treaty", async () => {
    for (const token of [lead, controller]) {
      expect((await call("GET", "/v1/axis/reinsurance-treaties", token)).status).toBe(200);
      expect((await call("GET", "/v1/axis/reinsurance-cessions", token)).status).toBe(200);
      expect((await call("POST", "/v1/axis/reinsurance-treaties", token, quotaShare("TRT-NOPE"))).status).toBe(403);
    }
  });

  it("the operations administrator writes one, and it lands in draft", async () => {
    await grantRole(seeded.users["axis.lead"]!, "axis.admin");
    const admin = await login("omar.farouk");
    const res = await call("POST", "/v1/axis/reinsurance-treaties", admin, quotaShare("TRT-QS-1"));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ref: "TRT-QS-1", kind: "quota_share", status: "draft", cededSharePpm: 400_000 });

    const activated = await call("PATCH", `/v1/axis/reinsurance-treaties/${res.body.id}`, admin, { status: "active" });
    expect(activated.status).toBe(200);
    expect(activated.body.status).toBe("active");
  });

  it("refuses terms the planner could not cede against, naming what is wrong", async () => {
    const admin = await login("omar.farouk");
    const cases: [Record<string, unknown>, RegExp][] = [
      [quotaShare("TRT-BAD-1", { cededSharePpm: 0 }), /cededSharePpm/],
      [quotaShare("TRT-BAD-2", { cededSharePpm: 1_000_001 }), /cededSharePpm|1000000/],
      [quotaShare("TRT-BAD-3", { kind: "surplus", cededSharePpm: null, retentionMinor: 100_000 }), /lines/],
      [quotaShare("TRT-BAD-4", { cedingCommissionPpm: 1_000_001 }), /cedingCommissionPpm|1000000/],
      [quotaShare("TRT-BAD-5", { effectiveTo: Date.now() - 2 * DAY }), /effective period/],
      [quotaShare("TRT-BAD-6", { reinsurerId: internalId }), /another carrier/],
      [quotaShare("TRT-BAD-7", { reinsurerId: "pv_nobody" }), /no provider/],
      [quotaShare("TRT-BAD-8", { status: "pending" }), /status/]
    ];
    for (const [payload, why] of cases) {
      const res = await call("POST", "/v1/axis/reinsurance-treaties", admin, payload);
      expect(res.status, JSON.stringify(payload)).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(why);
    }
  });

  it("checks an edit against the treaty it lands on, not only the fields it sends", async () => {
    const admin = await login("omar.farouk");
    const made = await call("POST", "/v1/axis/reinsurance-treaties", admin, quotaShare("TRT-QS-2"));
    expect(made.status).toBe(201);
    // Switching kind without the surplus terms leaves a treaty the planner refuses.
    const res = await call("PATCH", `/v1/axis/reinsurance-treaties/${made.body.id}`, admin, { kind: "surplus" });
    expect(res.status).toBe(400);
  });

  it("cessions have no write door: the engine is their only writer", async () => {
    const admin = await login("omar.farouk");
    const res = await call("POST", "/v1/axis/reinsurance-cessions", admin, { policyId: "pol_x" });
    expect([403, 404, 405]).toContain(res.status);
  });
});

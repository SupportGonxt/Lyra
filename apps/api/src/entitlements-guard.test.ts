import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// The licence is not a tenant's to write.
//
// Found by the entitlement sweep and confirmed with a probe before this file
// existed: logged in as `tenant.admin`, `PATCH /v1/core/tenants/{own id}` with a
// new `entitlementsJson` returned 200, a dropped module 403'd the module's routes,
// and adding every module back with `seats: 100000` returned 200 and was then
// reported by `GET /v1/me`. The tenants resource guarded `policyJson` — the
// approval allowlist — and left the licence itself open, with its own comment
// saying why that is wrong: *"a guard on only one of two doors is not a guard."*

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

let database: Db;
let env: Env;
let seeded: SeedResult;
let tokens: Record<string, string>;

async function call<T = any>(who: string | null, method: string, path: string, payload?: unknown) {
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

async function signIn(who: string, local: string) {
  const login = await call(null, "POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" });
  const token = login.body.token as string;
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
  tokens[who] = token;
}

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
  // `amina.saleh` is the tenant administrator — the seat that could widen its own
  // licence before this guard existed.
  await signIn("admin", "amina.saleh");
}, 120_000);

const entitlementsOf = async () => {
  const [row] = await database.select({ e: schema.tenants.entitlementsJson }).from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId));
  return JSON.parse(String(row!.e)) as { modules: string[]; seats: number };
};

describe("a tenant cannot widen its own licence", () => {
  it("refuses an entitlement change on the tenant's own route", async () => {
    const before = await entitlementsOf();
    const res = await call("admin", "PATCH", `/v1/core/tenants/${seeded.tenantId}`, {
      entitlementsJson: JSON.stringify({ modules: [...before.modules, "ledger"], seats: 100_000 })
    });
    // A named refusal, not a silent strip: a tenant asking for more should be
    // told it is a closed door.
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("admin:entitlements:write");
    // And the row is untouched — the refusal is the control, not the message.
    expect(await entitlementsOf()).toEqual(before);
  });

  it("still lets a tenant rename itself, so the guard is on the licence and not on the record", async () => {
    // The door that should stay open. A guard that broke ordinary tenant edits
    // would be traded away the first time someone needed one.
    const res = await call("admin", "PATCH", `/v1/core/tenants/${seeded.tenantId}`, { name: "GONXT Renamed" });
    expect(res.status).toBe(200);
  });
});

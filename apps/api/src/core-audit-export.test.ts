import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// `core:audit:export` has been granted to the administrator and the compliance
// officer all along, and no endpoint asked for it (docs/27 F59): the hash-chained
// audit log could be read a page at a time and never taken away as evidence.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  "tenant.admin": "amina.saleh",
  "finance.controller": "faisal.omar" // reads the log, may not export it
};

let env: Env;
let database: Db;
let tokens: Record<string, string>;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173"
  } as unknown as Env;

  tokens = {};
  for (const [role, local] of Object.entries(PEOPLE)) {
    const login = await call(null, "POST", "/v1/auth/login", {
      email: `${local}@gonxt.ae`,
      password: PASSWORD,
      tenantSlug: "gonxt"
    });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const verified = await call(
      null,
      "POST",
      "/v1/auth/mfa/verify",
      { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
      { authorization: `Bearer ${token}` }
    );
    expect(verified.status).toBe(200);
    tokens[role] = token;
  }

  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  tenantId = customer.tenantId;
}, 120_000);

async function raw(who: string, path: string): Promise<Response> {
  return app.fetch(
    new Request(`http://api.test${path}`, { headers: { authorization: `Bearer ${tokens[who]}` } }),
    env as never,
    exec as never
  );
}

describe("GET /v1/core/audit-log/export", () => {
  it("hands the administrator a CSV of the chain, newest last, with its hashes", async () => {
    // Counted first: the export audits itself, one row after the read.
    const before = (await database.select().from(schema.auditLog)).filter((r) => r.tenantId === tenantId).length;
    const res = await raw("tenant.admin", "/v1/core/audit-log/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const text = (await res.text()).replace(/^\uFEFF/, "");
    const [head, ...lines] = text.trim().split("\r\n");
    expect(head).toBe("ts,action,actorRef,subjectRef,ip,beforeHash,afterHash,prevHash,chainHash");
    expect(lines.length).toBe(before);
    const after = await database.select().from(schema.auditLog);
    expect(after.some((r) => r.tenantId === tenantId && r.action === "core.audit.exported")).toBe(true);
  });

  it("narrows by action text and time window", async () => {
    const res = await raw("tenant.admin", "/v1/core/audit-log/export?q=core.&from=0&to=9999999999999");
    const text = (await res.text()).trim().split("\r\n").slice(1);
    expect(text.length).toBeGreaterThan(0);
    expect(text.every((line) => line.split(",")[1]!.includes("core."))).toBe(true);
  });

  it("refuses a reader who may not export", async () => {
    expect((await raw("finance.controller", "/v1/core/audit-log/export")).status).toBe(403);
  });
});

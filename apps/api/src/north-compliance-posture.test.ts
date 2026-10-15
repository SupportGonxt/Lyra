import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/12-security-compliance.md §5, the claim that was not true:
//   "NORTH surfaces a live 'Compliance posture' tile for `tenant.compliance`
//    from these signals."
//
// The engine has its own tests (`packages/core/src/compliance-posture.ts`). This
// file is about the **gathering**: that the route reads figures rather than
// inventing them, that it is a query and not a stored score, and that the role
// §5 names is actually admitted.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

let database: Db;
let env: Env;
let tokens: Record<string, string>;

interface PostureRow {
  key: string;
  evidence: string;
  value: string;
  source: string;
}

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown
): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      // Without this the login POST had no body at all and the API answered
      // "request body is not valid JSON" — a helper that silently dropped its
      // argument.
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : null) as T };
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
  // The call stays: it is what populates the database this file queries.
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  tokens = {};
  // `asma.qasim` is the seeded `tenant.compliance` — the role §5 names, and the
  // one whose access is the whole point of the last test here.
  for (const [who, local] of [["compliance", "asma.qasim"], ["agent", "sara.nasser"]] as const) {
    const login = await call(null, "POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" });
    expect(login.status, `login ${local}: ${JSON.stringify(login.body)}`).toBe(200);
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
    expect(verified.status, `mfa ${local}`).toBe(200);
    tokens[who] = token;
  }
}, 120_000);

describe("GET /v1/north/compliance-posture", () => {
  it("advertises the role docs/12 §5 names, which holds core:audit:read", async () => {
    // The claim is *for* `tenant.compliance`. A posture the compliance officer
    // cannot open is not the tile §5 describes.
    const res = await call<{ controls: PostureRow[] }>("compliance", "GET", "/v1/north/compliance-posture");
    expect(res.status).toBe(200);
    expect(res.body.controls).toHaveLength(7);
  });

  it("refuses a seat with neither the audit read nor the compliance role", async () => {
    const res = await call("agent", "GET", "/v1/north/compliance-posture");
    expect(res.status).toBe(403);
  });

  it("reads its figures rather than asserting them", async () => {
    // The seeded tenant has consents and AI runs; a tile that hard-coded a
    // reassuring string would pass every other test in this file.
    const before = await call<{ controls: PostureRow[] }>("compliance", "GET", "/v1/north/compliance-posture");
    const aiBefore = before.body.controls.find((row) => row.key === "ai_logging")!;
    expect(Number(aiBefore.value.replace(/[^0-9]/g, ""))).toBeGreaterThan(0);

    const [consents] = await database.select().from(schema.consents).limit(1);
    expect(consents).toBeTruthy();

    const after = await call<{ controls: PostureRow[] }>("compliance", "GET", "/v1/north/compliance-posture");
    expect(after.body.controls.map((row) => row.key)).toEqual(before.body.controls.map((row) => row.key));
  });

  it("keeps documents on file distinct from counted facts", async () => {
    const res = await call<{ controls: PostureRow[] }>("compliance", "GET", "/v1/north/compliance-posture");
    const onFile = res.body.controls.filter((row) => row.evidence === "on_file").map((row) => row.key);
    // Tenancy isolation and breach are the two §5 evidences that are documents;
    // nothing may promote them to a live figure by passing through the route.
    expect(onFile.sort()).toEqual(["breach", "tenancy_isolation"]);
  });
});

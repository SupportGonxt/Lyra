import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@lyra/core";
import type { Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Found by the month simulation's fuzz pass (apps/api/sim): a body of the wrong
// shape must be the caller's 400, never the server's 500. A multipart route
// read `c.req.formData()` unguarded, an import read `c.req.json()` unguarded,
// and an unknown ledger type reached `txnType`, which throws a plain Error.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const exec = { waitUntil() {}, passThroughOnException() {} };
let env: Env;
const tokens: Record<string, string> = {};

async function call(who: string, method: string, path: string, body: string, contentType: string): Promise<number> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, { method, headers: { "content-type": contentType, authorization: `Bearer ${tokens[who]}` }, body }),
    env as never,
    exec as never
  );
  return res.status;
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
  const database = drizzle(client) as unknown as Db;
  await seed(database as never, {});
  const store = new Map<string, Uint8Array>();
  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    FILES: {
      async put(key: string, bytes: Uint8Array) {
        store.set(key, bytes);
      },
      async get() {
        return null;
      }
    }
  } as unknown as Env;
  for (const who of ["omar.farouk", "faisal.omar", "layla.hassan"]) {
    const res = await app.fetch(
      new Request("http://api.test/v1/auth/demo/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${who}@gonxt.ae` }) }),
      env as never,
      exec as never
    );
    tokens[who] = ((await res.json()) as { token: string }).token;
  }
}, 120_000);

describe("a malformed body is a 400, never a 500", () => {
  it("a document upload sent as JSON", async () => {
    expect(await call("omar.farouk", "POST", "/v1/axis/documents/upload", "{}", "application/json")).toBe(400);
  });

  it("a document upload whose multipart body is not multipart", async () => {
    expect(await call("omar.farouk", "POST", "/v1/axis/documents/upload", "not a form", "multipart/form-data; boundary=x")).toBe(400);
  });

  it("a CSV import whose JSON does not parse", async () => {
    expect(await call("layla.hassan", "POST", "/v1/core/customers/import", "{not json", "application/json")).toBe(400);
  });

  it("a bordereau import whose multipart body is not multipart", async () => {
    expect(await call("omar.farouk", "POST", "/v1/axis/bordereaux/import", "garbage", "multipart/form-data; boundary=x")).toBe(400);
  });

  it("a ledger transaction of a type that does not exist", async () => {
    expect(await call("faisal.omar", "POST", "/v1/ledger/txn/NOT-A-TYPE", "{}", "application/json")).toBe(400);
  });
});

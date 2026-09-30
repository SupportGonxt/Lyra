import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@lyra/core";
import type { Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Found by the month simulation's RBAC matrix (apps/api/sim): fifteen routes
// validated the body or looked the record up before asking whether the caller
// may act at all, so a reader without the permission got a 400 describing the
// input schema, or a 404 confirming which ids exist, instead of a 403. The
// rule is order: permission first, then everything else.
//
// The subjects are every documented operation, not a list — a guard that picks
// its own subjects has to take all of them (CLAUDE.md, "the recurring defect").

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const exec = { waitUntil() {}, passThroughOnException() {} };
/** Low-privilege seats: a provider's read-only viewer and a front-line agent. */
const SEATS = ["yasmin.faris", "layla.hassan"];
/** Surfaces with their own credential (visitor, provider signature, SCIM token) or a stream. */
const OWN_CREDENTIAL = /^\/v1\/(auth|portal|channels|scim|realtime)\b|^\/carrier-sandbox|^\/health|^\/openapi/;

/**
 * Operations whose real rule is "any one of several permissions", which the
 * spec's single scope cannot say. Each names the family and why; a caller
 * holding any member legitimately passes to validation.
 */
const ANY_OF: Record<string, { family: string[]; why: string }> = {
  "GET /v1/scout/config": {
    family: ["scout:signals:read", "scout:data_products:read", "scout:panel_bench:read"],
    why: "the k-anonymity floor every SCOUT reader's screen needs"
  },
  "POST /v1/ai/runs": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/ai/runs/stream": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/ai/command/runs": { family: ["axis", "core", "dist", "ledger", "north", "orbit", "scout", "signal"].map((m) => `${m}:ai:invoke`), why: "authorised by the agent's module" },
  "POST /v1/axis/cases/{id}/transition": { family: ["axis:cases:update", "axis:cases:approve"], why: "the permission depends on the target state" },
  "POST /v1/axis/claims/{id}/transition": {
    family: ["axis:claims:update", "axis:claims:triage", "axis:claims:approve", "axis:claims:close", "axis:claims:reopen", "axis:claims:recover"],
    why: "the permission depends on the target state"
  },
  "POST /v1/axis/cases/bulk": { family: ["axis:cases:update", "axis:cases:assign"], why: "per-action, checked per row" },
  "POST /v1/core/api-keys": { family: ["core:api_keys:create", "dev:keys_test:issue", "dev:keys_live:issue"], why: "a test key and a live key need different grants" },
  "POST /v1/ledger/txn/{type}": { family: ["ledger:txns:create", "ledger:journals:draft"], why: "a drafter may originate a gated transaction" },
  "GET /v1/orbit/portal-links/{kind}/{id}": { family: ["orbit:renewals:read", "orbit:conversations:read"], why: "a renewal link and a feedback link" }
};

let env: Env;

async function fetchAs(token: string | null, method: string, path: string, body?: string): Promise<{ status: number; json: any }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body } : {})
    }),
    env as never,
    exec as never
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, json };
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
  env = { DB_CLIENT: database, ENVIRONMENT: "development" } as unknown as Env;
}, 120_000);

describe("permission is checked before anything else", () => {
  it("every documented operation refuses a caller without its permission with a 403", async () => {
    const spec = (await fetchAs(null, "GET", "/openapi.json")).json;
    const violations: string[] = [];
    let checked = 0;
    for (const email of SEATS) {
      const token = (await fetchAs(null, "POST", "/v1/auth/demo/login", JSON.stringify({ email: `${email}@gonxt.ae` }))).json.token as string;
      const held = new Set<string>((await fetchAs(token, "GET", "/v1/me")).json.permissions);
      for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
        if (OWN_CREDENTIAL.test(path)) continue;
        for (const [method, op] of Object.entries(ops)) {
          const permission: string | undefined = op.security?.[0]?.session?.[0];
          if (!permission || held.has(permission)) continue;
          const upper = method.toUpperCase();
          if (ANY_OF[`${upper} ${path}`]?.family.some((p) => held.has(p))) continue;
          const res = await fetchAs(token, upper, path.replace(/\{[^}]+\}/g, "zz_missing"), upper === "GET" || upper === "DELETE" ? undefined : "{}");
          checked++;
          if (res.status !== 403) violations.push(`${email} ${upper} ${path} → ${res.status} (lacks ${permission})`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  }, 300_000);
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { seed, sha256Hex, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { id as newId, schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// PLAT: `core:api_keys:create` was a granted permission with no endpoint behind
// it — no key could ever be minted. This is the credential path, so the tests
// are about what must never happen: the plaintext must not reach the database,
// a caller must not mint a key stronger than themselves, and one tenant's key
// must not be visible from another.
//
// `core_webhooks.secret` had the same shape of hole from the other side: the
// column was writable and required, so the only way to register a webhook was
// to type your own signing secret — and the admin form does not offer the
// field. Both mints live in routes/core.ts and both are tested here.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
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
let tokens: Record<string, string>;
/** A second tenant, reachable only through its own key. */
let otherKey: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(token: string | null, method: string, path: string, payload?: unknown): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function login(local: string): Promise<string> {
  const first = await call(null, "POST", "/v1/auth/login", {
    email: `${local}@gonxt.ae`,
    password: PASSWORD,
    tenantSlug: "gonxt"
  });
  expect(first.status).toBe(200);
  const token = first.body.token as string;
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

/** A gonxt credential holding exactly what dev.developer holds (docs/06), by hand. */
async function developerKey(): Promise<string> {
  const now = Date.now();
  const [tenant] = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, "gonxt"));
  const token = `qvk_test_DEVDEVDEVDEVDEVDEVDEVDEVDEVDEVDE`;
  await database.insert(schema.apiKeys).values({
    id: newId("key", now),
    tenantId: tenant!.id,
    name: "developer",
    prefix: token.slice(0, 17),
    keyHash: await sha256Hex(token),
    mode: "test",
    scopesJson: JSON.stringify(["dev:consoles:read", "dev:sandbox:use", "dev:keys_test:issue", "core:webhooks:read"]),
    createdBy: "system:test",
    createdAt: now
  });
  return token;
}

/** Mint a key for a second tenant by hand — the only way in without a user there. */
async function foreignTenantKey(): Promise<string> {
  const now = Date.now();
  const tenantId = newId("tn", now);
  await database.insert(schema.tenants).values({
    id: tenantId,
    slug: "otherco",
    name: "Other Co",
    status: "active",
    createdAt: now,
    updatedAt: now
  });
  const secret = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH";
  const token = `qvk_test_${secret}`;
  await database.insert(schema.apiKeys).values({
    id: newId("key", now),
    tenantId,
    name: "other co ci",
    prefix: token.slice(0, 17),
    keyHash: await sha256Hex(token),
    mode: "test",
    scopesJson: JSON.stringify(["core:api_keys:read", "core:api_keys:revoke", "core:webhooks:read", "core:webhooks:write"]),
    createdBy: "system:test",
    createdAt: now
  });
  return token;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173"
  } as unknown as Env;
  tokens = {
    admin: await login("amina.saleh"), // tenant.admin — holds core:*:*
    agent: await login("layla.hassan"), // axis.agent — holds no core:api_keys:*
    devAdmin: await login("raed.samir") // dev.admin — holds dev:keys_live:issue
  };
  otherKey = await foreignTenantKey();
}, 120_000);

const mint = (who: string, payload: unknown) => call(tokens[who] ?? null, "POST", "/v1/core/api-keys", payload);

describe("POST /v1/core/api-keys", () => {
  it("returns the plaintext once and stores only its hash", async () => {
    const res = await mint("admin", { name: "ci", mode: "test", scopes: ["core:api_keys:read"] });
    expect(res.status).toBe(201);
    const plaintext = res.body.key as string;
    expect(plaintext).toMatch(/^qvk_test_[A-Z2-7]{40,}$/);

    const rows = await database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, res.body.id));
    const row = rows[0]!;
    // Not "does the hash column hold it" — no column anywhere may hold it.
    expect(JSON.stringify(row)).not.toContain(plaintext.slice(17));
    expect(row.keyHash).toBe(await sha256Hex(plaintext));
    // The prefix is the lookup handle auth.ts slices back out of a presented key.
    expect(row.prefix).toBe(plaintext.slice(0, 17));
    expect(row.createdBy).toMatch(/^user:/);

    // Reading the key back never re-issues the plaintext.
    const record = await call(tokens.admin!, "GET", `/v1/core/api-keys/${res.body.id}`);
    expect(record.status).toBe(200);
    expect(record.body.key).toBeUndefined();
    expect(JSON.stringify(record.body)).not.toContain(plaintext.slice(17));
  });

  it("issues a key that actually authenticates", async () => {
    const res = await mint("admin", { name: "round trip", scopes: ["core:api_keys:read"] });
    expect(res.status).toBe(201);
    const asKey = await call(res.body.key as string, "GET", "/v1/core/api-keys");
    expect(asKey.status).toBe(200);
    // Scoped to what it was granted, and nothing more.
    const denied = await call(res.body.key as string, "GET", "/v1/core/users");
    expect(denied.status).toBe(403);
  });

  it("refuses a scope the caller does not hold", async () => {
    // tenant.admin is core:*:* plus reads — it cannot write axis policies, so it
    // cannot mint a key that can either.
    const res = await mint("admin", { name: "escalation", scopes: ["axis:policies:create"] });
    expect(res.status).toBe(403);
    expect(await countNamed("escalation")).toBe(0);
  });

  it("refuses a scope that is not a permission at all", async () => {
    const res = await mint("admin", { name: "nonsense", scopes: ["not:a:permission"] });
    expect(res.status).toBe(400);
    expect(await countNamed("nonsense")).toBe(0);
  });

  it("never trusts tenantId or createdBy from the body", async () => {
    const res = await mint("admin", {
      name: "spoofed",
      scopes: ["core:api_keys:read"],
      tenantId: "t_somewhere_else",
      createdBy: "user:root"
    });
    expect(res.status).toBe(400);
    expect(await countNamed("spoofed")).toBe(0);
  });

  // J-D1 (docs/06): a developer mints a *test* key; going live is dev.admin's
  // call. The route used to check only core:api_keys:create, so neither
  // dev:keys_test:issue nor dev:keys_live:issue did anything.
  it("lets a holder of dev:keys_test:issue mint a test key, and only a test key", async () => {
    const developer = await developerKey();
    const test = await call(developer, "POST", "/v1/core/api-keys", { name: "dev test", mode: "test", scopes: [] });
    expect(test.status).toBe(201);
    const live = await call(developer, "POST", "/v1/core/api-keys", { name: "dev live", mode: "live", scopes: [] });
    expect(live.status).toBe(403);
  });

  it("keeps a live key behind dev:keys_live:issue, even for a tenant admin", async () => {
    const admin = await mint("admin", { name: "admin live", mode: "live", scopes: [] });
    expect(admin.status).toBe(403);
    const devAdmin = await call(tokens.devAdmin ?? null, "POST", "/v1/core/api-keys", { name: "go live", mode: "live", scopes: [] });
    expect(devAdmin.status).toBe(201);
  });

  it("is 403 for a session without core:api_keys:create", async () => {
    const res = await mint("agent", { name: "agent key", scopes: [] });
    expect(res.status).toBe(403);
  });

  it("leaves the generated list and record endpoints intact", async () => {
    // The hand-written router mounts at /v1/core, before the generated CRUD.
    // A stray `get("/api-keys")` there would shadow both of these.
    const created = await mint("admin", { name: "still listed", scopes: [] });
    expect(created.status).toBe(201);
    const list = await call(tokens.admin!, "GET", "/v1/core/api-keys");
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((k) => k.id)).toContain(created.body.id);
    expect(list.body.data.every((k: Record<string, unknown>) => k.key === undefined)).toBe(true);
    const record = await call(tokens.admin!, "GET", `/v1/core/api-keys/${created.body.id}`);
    expect(record.status).toBe(200);
    expect(record.body.name).toBe("still listed");
  });

  it("keeps a key inside the tenant that minted it", async () => {
    const created = await mint("admin", { name: "tenant a only", scopes: [] });
    expect(created.status).toBe(201);
    const list = await call(otherKey, "GET", "/v1/core/api-keys");
    expect(list.status).toBe(200);
    expect((list.body.data as { id: string }[]).map((k) => k.id)).not.toContain(created.body.id);
    const record = await call(otherKey, "GET", `/v1/core/api-keys/${created.body.id}`);
    expect(record.status).toBe(404);
  });

  it("writes an audit entry for the mint", async () => {
    const created = await mint("admin", { name: "audited", scopes: [] });
    const rows = await database.select().from(schema.auditLog);
    const entry = rows.find((a) => a.subjectRef === `api-keys:${created.body.id}`);
    expect(entry?.action).toBe("core.api-keys.create");
  });
});

async function countNamed(name: string): Promise<number> {
  const rows = await database.select().from(schema.apiKeys).where(eq(schema.apiKeys.name, name));
  return rows.length;
}

describe("DELETE /v1/core/api-keys/:id", () => {
  it("revokes rather than deletes: the row survives, the key stops authenticating", async () => {
    const created = await mint("admin", { name: "to be revoked", scopes: ["core:api_keys:read"] });
    expect(created.status).toBe(201);
    const plaintext = created.body.key as string;

    const del = await call(tokens.admin!, "DELETE", `/v1/core/api-keys/${created.body.id}`);
    expect(del.status).toBe(204);

    const rows = await database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeTruthy();

    const asKey = await call(plaintext, "GET", "/v1/core/api-keys");
    expect(asKey.status).toBe(401);
  });

  it("writes an audit entry and refuses without core:api_keys:revoke", async () => {
    const created = await mint("admin", { name: "audited revoke", scopes: [] });
    const denied = await call(tokens.agent!, "DELETE", `/v1/core/api-keys/${created.body.id}`);
    expect(denied.status).toBe(403);

    const ok = await call(tokens.admin!, "DELETE", `/v1/core/api-keys/${created.body.id}`);
    expect(ok.status).toBe(204);
    const rows = await database.select().from(schema.auditLog);
    const entry = rows.find((a) => a.subjectRef === `api-keys:${created.body.id}` && a.action === "core.api-keys.revoke");
    expect(entry).toBeTruthy();
  });

  it("404s revoking another tenant's key", async () => {
    const created = await mint("admin", { name: "not yours to revoke", scopes: [] });
    const res = await call(otherKey, "DELETE", `/v1/core/api-keys/${created.body.id}`);
    expect(res.status).toBe(404);
    const rows = await database.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, created.body.id));
    expect(rows[0]?.revokedAt).toBeFalsy();
  });
});

/* ------------------------------------------------------------- webhooks */

const register = (who: string, payload: unknown) =>
  call(tokens[who] ?? null, "POST", "/v1/core/webhooks", payload);

describe("POST /v1/core/webhooks", () => {
  it("generates the signing secret and returns it exactly once", async () => {
    const res = await register("admin", {
      url: "https://hooks.example.com/lyra",
      eventTypesJson: ["axis.case.issued"]
    });
    expect(res.status).toBe(201);
    const secret = res.body.secret as string;
    // Long enough to be an HMAC key nobody guesses, and prefixed so a leaked
    // one is recognisable in a log search.
    expect(secret).toMatch(/^whsec_[A-Z2-7]{40,}$/);

    const rows = await database.select().from(schema.webhooks).where(eq(schema.webhooks.id, res.body.id));
    expect(rows[0]?.secret).toBe(secret);
    expect(rows[0]?.url).toBe("https://hooks.example.com/lyra");

    // Every read path keeps it out — the mint is the only place it appears.
    const record = await call(tokens.admin!, "GET", `/v1/core/webhooks/${res.body.id}`);
    expect(record.status).toBe(200);
    expect(record.body.secret).toBeUndefined();
    const list = await call(tokens.admin!, "GET", "/v1/core/webhooks");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it("keeps the secret out of the audit trail", async () => {
    const res = await register("admin", { url: "https://hooks.example.com/audited", eventTypesJson: [] });
    expect(res.status).toBe(201);
    const rows = await database.select().from(schema.auditLog);
    const entry = rows.find((a) => a.subjectRef === `webhooks:${res.body.id}`);
    expect(entry?.action).toBe("core.webhooks.create");
    // An audit row is readable with core:audit:read; a signing secret in the
    // after-image would put it back on a read path.
    expect(JSON.stringify(rows)).not.toContain(res.body.secret as string);
  });

  it("refuses a caller-supplied secret rather than honouring it", async () => {
    const res = await register("admin", {
      url: "https://hooks.example.com/byo",
      eventTypesJson: [],
      secret: "whsec_chosen_by_the_client"
    });
    expect(res.status).toBe(400);
    const rows = await database.select().from(schema.webhooks);
    expect(rows.every((w) => w.secret !== "whsec_chosen_by_the_client")).toBe(true);
  });

  it("mints a distinct secret per webhook", async () => {
    const a = await register("admin", { url: "https://hooks.example.com/a", eventTypesJson: [] });
    const b = await register("admin", { url: "https://hooks.example.com/b", eventTypesJson: [] });
    expect(a.body.secret).not.toBe(b.body.secret);
  });

  it("is 403 for a session without core:webhooks:write", async () => {
    const res = await register("agent", { url: "https://hooks.example.com/nope", eventTypesJson: [] });
    expect(res.status).toBe(403);
  });

  it("never trusts tenantId from the body", async () => {
    const res = await register("admin", {
      url: "https://hooks.example.com/spoofed",
      eventTypesJson: [],
      tenantId: "t_somewhere_else"
    });
    expect(res.status).toBe(400);
    const rows = await database.select().from(schema.webhooks);
    expect(rows.every((w) => w.tenantId !== "t_somewhere_else")).toBe(true);
  });
});

describe("POST /v1/core/webhooks/:id/rotate", () => {
  it("replaces the secret with a fresh one and returns it once", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/rotate", eventTypesJson: [] });
    const before = created.body.secret as string;

    const res = await call(tokens.admin!, "POST", `/v1/core/webhooks/${created.body.id}/rotate`);
    expect(res.status).toBe(200);
    const after = res.body.secret as string;
    expect(after).toMatch(/^whsec_[A-Z2-7]{40,}$/);
    expect(after).not.toBe(before);

    const rows = await database.select().from(schema.webhooks).where(eq(schema.webhooks.id, created.body.id));
    expect(rows[0]?.secret).toBe(after);

    const record = await call(tokens.admin!, "GET", `/v1/core/webhooks/${created.body.id}`);
    expect(record.body.secret).toBeUndefined();
  });

  it("writes an audit entry without the secret in it", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/rotate-audit", eventTypesJson: [] });
    const res = await call(tokens.admin!, "POST", `/v1/core/webhooks/${created.body.id}/rotate`);
    const rows = await database.select().from(schema.auditLog);
    const entry = rows.find((a) => a.subjectRef === `webhooks:${created.body.id}` && a.action === "core.webhooks.rotate");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(rows)).not.toContain(res.body.secret as string);
  });

  it("is 403 for a session without core:webhooks:write", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/rotate-403", eventTypesJson: [] });
    const res = await call(tokens.agent!, "POST", `/v1/core/webhooks/${created.body.id}/rotate`);
    expect(res.status).toBe(403);
  });

  it("404s rotating another tenant's webhook", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/rotate-foreign", eventTypesJson: [] });
    const res = await call(otherKey, "POST", `/v1/core/webhooks/${created.body.id}/rotate`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/core/webhooks/:id/test", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("delivers a signed test event and reports the response status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const created = await register("admin", { url: "https://hooks.example.com/test-ok", eventTypesJson: [] });
    const res = await call(tokens.admin!, "POST", `/v1/core/webhooks/${created.body.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe(200);
  });

  it("reports a failed delivery without throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    const created = await register("admin", { url: "https://hooks.example.com/test-fail", eventTypesJson: [] });
    const res = await call(tokens.admin!, "POST", `/v1/core/webhooks/${created.body.id}/test`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(500);
  });

  it("writes an audit entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const created = await register("admin", { url: "https://hooks.example.com/test-audit", eventTypesJson: [] });
    await call(tokens.admin!, "POST", `/v1/core/webhooks/${created.body.id}/test`);
    const rows = await database.select().from(schema.auditLog);
    const entry = rows.find((a) => a.action === "core.webhooks.test" && a.subjectRef === `webhooks:${created.body.id}`);
    expect(entry).toBeDefined();
  });

  it("is 403 for a session without core:webhooks:read", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/test-403", eventTypesJson: [] });
    const res = await call(tokens.agent!, "POST", `/v1/core/webhooks/${created.body.id}/test`);
    expect(res.status).toBe(403);
  });

  it("404s testing another tenant's webhook", async () => {
    const created = await register("admin", { url: "https://hooks.example.com/test-foreign", eventTypesJson: [] });
    const res = await call(otherKey, "POST", `/v1/core/webhooks/${created.body.id}/test`);
    expect(res.status).toBe(404);
  });
});

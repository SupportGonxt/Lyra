import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, sha256Hex, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// ADR-0096, docs/30 Admin 5. SCIM 2.0 (RFC 7643/7644): an identity provider
// creates, updates and deactivates the tenant's people and keeps their role
// membership, so a leaver in Entra or Okta is a leaver here too. The caller is
// an API key whose scopes are the same permissions a person would need, and
// the escalation guard is the same: a key cannot grant a role it does not hold.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const exec = { waitUntil() {}, passThroughOnException() {} };
const SCIM = "application/scim+json";
const PROVISION = ["core:users:read", "core:users:create", "core:users:update", "core:roles:read", "core:roles:assign"];

let env: Env;
let database: Db;
let seeded: SeedResult;
const tokens: Record<string, string> = {};

async function mintKey(name: string, scopes: string[]): Promise<string> {
  const secret = `qvk_live_${name.padEnd(8, "x").slice(0, 8)}${"s".repeat(24)}`;
  await database.insert(schema.apiKeys).values({
    id: `key_${name}`,
    tenantId: seeded.tenantId,
    name,
    prefix: secret.slice(0, secret.lastIndexOf("_") + 9),
    keyHash: await sha256Hex(secret),
    mode: "live",
    scopesJson: JSON.stringify(scopes),
    createdBy: "user:u_admin",
    createdAt: Date.now()
  });
  return secret;
}

async function scim<T = any>(who: string, method: string, path: string, payload?: unknown): Promise<{ status: number; type: string | null; body: T }> {
  const res = await app.fetch(
    new Request(`http://api.test/v1/scim/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${tokens[who]}`, "content-type": SCIM },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = await res.text();
  return { status: res.status, type: res.headers.get("content-type"), body: text ? (JSON.parse(text) as T) : (null as T) };
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
  seeded = await seed(database as never, { mfaSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;
  tokens.idp = await mintKey("idp", PROVISION);
  // Holds everything orbit.admin confers (rbac.ts), so it may grant that role.
  const orbitAdmin = (await database.select().from(schema.roles).where(eq(schema.roles.key, "orbit.admin")))[0]!;
  tokens.wide = await mintKey("wide", [...PROVISION, ...(JSON.parse(orbitAdmin.permissionsJson) as string[])]);
  tokens.reader = await mintKey("reader", ["core:users:read"]);
}, 120_000);

const userBody = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName,
  externalId: `ext-${userName}`,
  name: { formatted: "Mariam Al Suwaidi" },
  emails: [{ value: userName, primary: true }],
  active: true,
  ...extra
});

describe("SCIM 2.0 Users", () => {
  let id: string;

  it("describes what it supports", async () => {
    const res = await scim("idp", "GET", "/ServiceProviderConfig");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ patch: { supported: true }, filter: { supported: true }, bulk: { supported: false } });
  });

  it("creates an active person who signs in through the identity provider, and answers in SCIM", async () => {
    const res = await scim("idp", "POST", "/Users", userBody("Mariam.S@gonxt.ae"));
    expect(res.status).toBe(201);
    expect(res.type).toContain(SCIM);
    expect(res.body).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName: "mariam.s@gonxt.ae",
      externalId: "ext-Mariam.S@gonxt.ae",
      active: true,
      meta: { resourceType: "User" }
    });
    id = res.body.id;
    const [row] = await database.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row).toMatchObject({ status: "active", authProvider: "oidc", passwordHash: null });
  });

  it("refuses a second person with the same userName, as SCIM's uniqueness error", async () => {
    const res = await scim("idp", "POST", "/Users", userBody("mariam.s@gonxt.ae"));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"], status: "409", scimType: "uniqueness" });
  });

  it("finds a person by userName, the filter every IdP sends before it creates", async () => {
    const res = await scim("idp", "GET", `/Users?filter=${encodeURIComponent('userName eq "MARIAM.S@gonxt.ae"')}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: 1 });
    expect(res.body.Resources[0].id).toBe(id);
    const none = await scim("idp", "GET", `/Users?filter=${encodeURIComponent('userName eq "nobody@gonxt.ae"')}`);
    expect(none.body.totalResults).toBe(0);
  });

  it("refuses a filter it does not implement rather than returning everyone", async () => {
    const res = await scim("idp", "GET", `/Users?filter=${encodeURIComponent('name.familyName co "a"')}`);
    expect(res.status).toBe(400);
    expect(res.body.scimType).toBe("invalidFilter");
  });

  it("deactivates on PATCH active=false, which locks the person out", async () => {
    const res = await scim("idp", "PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: false }]
    });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    const [row] = await database.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row!.status).toBe("suspended");
  });

  it("renames and reactivates on PUT, and deactivates on DELETE", async () => {
    const put = await scim("idp", "PUT", `/Users/${id}`, userBody("mariam.s@gonxt.ae", { name: { formatted: "Mariam Suwaidi" } }));
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ active: true, name: { formatted: "Mariam Suwaidi" } });
    const del = await scim("idp", "DELETE", `/Users/${id}`);
    expect(del.status).toBe(204);
    const [row] = await database.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row!.status).toBe("suspended");
  });

  it("answers 403 in SCIM's shape to a key without the permission", async () => {
    const res = await scim("reader", "POST", "/Users", userBody("x@gonxt.ae"));
    expect(res.status).toBe(403);
    expect(res.body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
  });

  it("audits every change under the key", async () => {
    const audits = await database.select().from(schema.auditLog).where(eq(schema.auditLog.subjectRef, `users:${id}`));
    expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(["core.scim.user_create", "core.scim.user_update", "core.scim.user_deactivate"]));
  });
});

describe("SCIM 2.0 Groups are the tenant's roles", () => {
  let userId: string;
  const role = async (key: string) =>
    (await database.select().from(schema.roles).where(and(eq(schema.roles.tenantId, seeded.tenantId), eq(schema.roles.key, key))))[0]!;

  beforeAll(async () => {
    userId = (await scim("idp", "POST", "/Users", userBody("groups.person@gonxt.ae"))).body.id;
  });

  it("lists roles as groups by their key", async () => {
    const res = await scim("idp", "GET", `/Groups?filter=${encodeURIComponent('displayName eq "orbit.admin"')}`);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources[0]).toMatchObject({ displayName: "orbit.admin", id: (await role("orbit.admin")).id });
  });

  it("adds and removes members, granting only what the key itself holds", async () => {
    const orbitAdmin = await role("orbit.admin");
    const patch = (op: "add" | "remove") => ({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [op === "add" ? { op, path: "members", value: [{ value: userId }] } : { op, path: `members[value eq "${userId}"]` }]
    });
    // The narrow key cannot hand out ORBIT administration it does not hold.
    expect((await scim("idp", "PATCH", `/Groups/${orbitAdmin.id}`, patch("add"))).status).toBe(403);
    const added = await scim("wide", "PATCH", `/Groups/${orbitAdmin.id}`, patch("add"));
    expect(added.status).toBe(200);
    expect(added.body.members.map((m: { value: string }) => m.value)).toContain(userId);
    const removed = await scim("idp", "PATCH", `/Groups/${orbitAdmin.id}`, patch("remove"));
    expect(removed.status).toBe(200);
    expect(removed.body.members.map((m: { value: string }) => m.value)).not.toContain(userId);
  });
});

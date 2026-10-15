import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs: PORTALS-DESIGN-AND-AUDIT.md. The whole chain for the two external doors:
// a staff seat mints the link behind the permission that reads the row, the link
// opens the public page, and a wrong token is a 404 that confirms nothing.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let env: Env;
let db: Db;
let token: string;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
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
  db = drizzle(client) as unknown as Db;
  const result = await seed(db as never, { mfaSecret: DEMO_TOTP_SECRET });
  tenantId = result.tenantId;

  env = {
    DB_CLIENT: db,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    FIELD_KEY: "portal-parties-test-field-key"
  } as unknown as Env;

  const login = await call("POST", "/v1/auth/login", { email: "amina.saleh@gonxt.ae", password: PASSWORD, tenantSlug: "gonxt" });
  expect(login.status).toBe(200);
  token = login.body.token as string;
  const verified = await call(
    "POST",
    "/v1/auth/mfa/verify",
    { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
    { authorization: `Bearer ${token}` }
  );
  expect(verified.status).toBe(200);
}, 120_000);

async function seedParty(id: string): Promise<void> {
  await db.insert(schema.providers).values({
    id,
    tenantId,
    name: "Cedar Insurance",
    kind: "insurer",
    currency: "AED",
    panelStatus: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  });
  await db.insert(schema.distChannels).values({
    id: "chn_" + id,
    tenantId,
    key: "alpha-" + id,
    kind: "b2b",
    nameJson: JSON.stringify({ en: "Alpha Brokers" }),
    medium: "portal",
    currency: "AED",
    status: "active",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000
  });
}

describe("party portal links", () => {
  it("mints a supplier link behind core:providers:read and opens it with the token", async () => {
    await seedParty("prv_link_1");
    const minted = await call<{ url: string }>("GET", "/v1/core/providers/prv_link_1/portal-link");
    expect(minted.status).toBe(200);
    expect(minted.body.url).toContain("/portal/gonxt/suppliers/prv_link_1?token=");

    // The public page: no session — `token` is set, so the header carries it and
    // the API is called with the forged session too, which the route ignores.
    const linkToken = new URL(minted.body.url).searchParams.get("token")!;
    const opened = await call<{ supplier: { name: string } }>(
      "GET",
      `/v1/portal/gonxt/suppliers/prv_link_1?token=${linkToken}`
    );
    expect(opened.status).toBe(200);
    expect(opened.body.supplier.name).toBe("Cedar Insurance");

    const wrong = await call("GET", "/v1/portal/gonxt/suppliers/prv_link_1?token=deadbeef");
    expect(wrong.status).toBe(404);
    const missing = await call("GET", "/v1/portal/gonxt/suppliers/prv_link_1");
    expect(missing.status).toBe(404);
  });

  it("mints a channel link behind dist:channels:read and opens it with the token", async () => {
    await seedParty("prv_link_2");
    const minted = await call<{ url: string }>("GET", "/v1/dist/channels/chn_prv_link_2/portal-link");
    expect(minted.status).toBe(200);
    expect(minted.body.url).toContain("/portal/gonxt/channels/chn_prv_link_2?token=");

    const linkToken = new URL(minted.body.url).searchParams.get("token")!;
    const opened = await call<{ channel: { name: Record<string, string> } }>(
      "GET",
      `/v1/portal/gonxt/channels/chn_prv_link_2?token=${linkToken}`
    );
    expect(opened.status).toBe(200);
    expect(opened.body.channel.name).toEqual({ en: "Alpha Brokers" });

    const wrong = await call("GET", "/v1/portal/gonxt/channels/chn_prv_link_2?token=deadbeef");
    expect(wrong.status).toBe(404);
  });

  // The bug the portal audit found, pinned at the route rather than the engine:
  // `portalCtx` used to parse an empty policy, so every public portal route read
  // the *default* module settings. The k-anonymity floor lives on that policy, so
  // a tenant that raised its own floor had a cell below it served over a public
  // URL. `activeTenant` already selects the whole tenant row, so the real config
  // costs no extra query — and this is the assertion that keeps it honest.
  it("applies the tenant's own policy on the public door, not the default", async () => {
    await db
      .update(schema.tenants)
      .set({ policyJson: JSON.stringify({ moduleConfig: { scout: { settings: { kAnonymityFloor: 500 } } } }) })
      .where(eq(schema.tenants.id, tenantId));

    const now = 1_760_000_000_000;
    await db.insert(schema.providers).values({
      id: "prv_floor",
      tenantId,
      name: "Floor Test Insurance",
      kind: "insurer",
      currency: "AED",
      panelStatus: "active",
      createdAt: now,
      updatedAt: now
    });
    await db.insert(schema.scoutPanelBench).values({
      id: "pnb_floor",
      tenantId,
      providerId: "prv_floor",
      line: "motor",
      period: "2026-09",
      winRate: 30,
      volume: 100, // above the default 50, below this tenant's 500
      updatedAt: now
    });

    const minted = await call<{ url: string }>("GET", "/v1/core/providers/prv_floor/portal-link");
    expect(minted.status).toBe(200);
    const linkToken = new URL(minted.body.url).searchParams.get("token")!;
    const opened = await call<{ position: unknown[]; kAnonymityFloor: number }>(
      "GET",
      `/v1/portal/gonxt/suppliers/prv_floor?token=${linkToken}`
    );

    expect(opened.status).toBe(200);
    expect(opened.body.kAnonymityFloor).toBe(500);
    // The tenant's floor withholds it, so the row is absent rather than thinned.
    expect(opened.body.position).toEqual([]);
  });
});

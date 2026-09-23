import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, EntitlementsJson, PolicyJson, type Db } from "@lyra/db";
import {
  assertSeatAvailable,
  entitledGrants,
  seed,
  totpAt,
  TOTP_STEP_SEC,
  type Ctx,
  type Grant
} from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Audit findings: entitlements (edition/modules/seats) were parsed on every
// request but enforced nowhere, and a corrupt tenant policy/entitlements blob
// silently reset to defaults with no audit trail. These are the regressions.

/** Nav is grouped (heading items wrap the real destinations in `children`). */
function navHrefs(nav: { href: string; children?: { href: string }[] }[]): string[] {
  return nav.flatMap((n) => [n.href, ...(n.children ?? []).map((c) => c.href)]);
}

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let env: Env;
let database: Db;
let token: string;
let tenantId: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  auth = true
): Promise<{ status: number; body: T }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth && token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function setTenantColumn(values: Partial<typeof schema.tenants.$inferInsert>): Promise<void> {
  await database.update(schema.tenants).set(values).where(eq(schema.tenants.id, tenantId));
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

  const login = await call("POST", "/v1/auth/login", {
    email: "amina.saleh@gonxt.ae",
    password: PASSWORD,
    tenantSlug: "gonxt"
  }, false);
  expect(login.status).toBe(200);
  token = login.body.token as string;
  tenantId = login.body.user.tenantId as string;
  if (login.body.mfaRequired) {
    const verify = await call("POST", "/v1/auth/mfa/verify", {
      code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
    });
    expect(verify.status).toBe(200);
  }
}, 120_000);

describe("module gating (docs/21 entitlements)", () => {
  it("a fully entitled tenant reaches module routes and sees them in the nav", async () => {
    const list = await call("GET", "/v1/signal/campaigns");
    expect(list.status).toBe(200);
    const me = await call("GET", "/v1/me");
    expect(me.status).toBe(200);
    expect(navHrefs(me.body.nav)).toContain("/signal");
    expect(me.body.permissions.some((p: string) => p.startsWith("signal:"))).toBe(true);
  });

  it("a tenant without a module gets 403 on its routes and no nav entry", async () => {
    await setTenantColumn({
      entitlementsJson: JSON.stringify(
        EntitlementsJson.parse({ edition: "suite", modules: ["axis", "orbit", "scout", "north"], seats: 250 })
      )
    });
    try {
      const list = await call("GET", "/v1/signal/campaigns");
      expect(list.status).toBe(403);
      const me = await call("GET", "/v1/me");
      expect(me.status).toBe(200);
      expect(navHrefs(me.body.nav)).not.toContain("/signal");
      expect(me.body.permissions.some((p: string) => p.startsWith("signal:"))).toBe(false);
      // Entitled modules are untouched.
      expect((await call("GET", "/v1/axis/cases")).status).toBe(200);
    } finally {
      await setTenantColumn({
        entitlementsJson: JSON.stringify(
          EntitlementsJson.parse({
            edition: "suite",
            modules: ["axis", "orbit", "signal", "scout", "north"],
            seats: 250
          })
        )
      });
    }
  });

  // The tenant's own switch (PATCH /v1/core/modules/:module/config) used to be
  // stored and read by nothing. It now subtracts exactly as a missing
  // entitlement does, and — core being ungated — the same admin can turn the
  // module back on.
  it("a module the tenant switched off answers 403 and leaves the nav, and can be switched back", async () => {
    const off = await call("PATCH", "/v1/core/modules/orbit/config", { enabled: false });
    expect(off.status).toBe(200);
    try {
      expect((await call("GET", "/v1/orbit/conversations")).status).toBe(403);
      const me = await call("GET", "/v1/me");
      expect(navHrefs(me.body.nav)).not.toContain("/orbit");
      expect(me.body.permissions.some((p: string) => p.startsWith("orbit:"))).toBe(false);
      expect((await call("GET", "/v1/axis/cases")).status).toBe(200);
    } finally {
      expect((await call("PATCH", "/v1/core/modules/orbit/config", { enabled: true })).status).toBe(200);
    }
    expect((await call("GET", "/v1/orbit/conversations")).status).toBe(200);
  });

  it("entitledGrants keeps wildcard-module grants (platform staff) whole", () => {
    const grants: Grant[] = [{ roleKey: "platform.admin", permissions: ["*:*:*"] }];
    const filtered = entitledGrants(grants, EntitlementsJson.parse({}));
    expect(filtered[0]!.permissions).toEqual(["*:*:*"]);
  });
});

describe("corrupt tenant config (auth.ts safeJson)", () => {
  it("a corrupt policy blob is audited once and falls back closed, not silently", async () => {
    await setTenantColumn({ policyJson: "{definitely not json" });
    try {
      // Two requests: the tenant still works on defaults...
      const first = await call("GET", "/v1/me");
      expect(first.status).toBe(200);
      expect(first.body.policy.autoApprove).toEqual([]); // closed: nothing auto-approves
      const second = await call("GET", "/v1/me");
      expect(second.status).toBe(200);
      // ...and the detection left exactly one audit row, not one per request.
      const rows = await database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "core.tenant.config_corrupt"));
      expect(rows.length).toBe(1);
      expect(rows[0]!.tenantId).toBe(tenantId);
    } finally {
      await setTenantColumn({
        policyJson: JSON.stringify(PolicyJson.parse({ autoApprove: ["signal.campaign_launch"] }))
      });
    }
  });
});

describe("seat enforcement helper", () => {
  function ctxWith(seats: number): Ctx {
    return {
      db: database as unknown as Ctx["db"],
      tenantId,
      actor: { kind: "system", id: "test", tenantId, grants: [] },
      requestId: "req_test",
      now: Date.now(),
      locale: "en",
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({ seats })
    };
  }

  it("refuses a new user once the tenant's seats are used", async () => {
    await expect(assertSeatAvailable(ctxWith(1))).rejects.toMatchObject({ status: 403 });
  });

  it("allows a new user while seats remain", async () => {
    await expect(assertSeatAvailable(ctxWith(250))).resolves.toBeUndefined();
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, EntitlementsJson, type Db } from "@lyra/db";
import {
  GATED_MODULES,
  seed,
  totpAt,
  TOTP_STEP_SEC
} from "@lyra/core";
import { app } from "./index.js";
import { scheduledConfig, switchedOff } from "./auth.js";
import { openapi } from "./openapi.js";
import type { Env } from "./env.js";

// @accept:SA — every module stands alone. A tenant that bought one module gets
// that module whole: each of its read routes answers, and nothing a platform
// route reads breaks because a sibling module is absent. A 403 on the module's
// own route or any 5xx is a module that only works in company.

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
    APP_ORIGIN: "http://localhost:5173",
    FIELD_KEY: "solo-suite-field-key-0123456789abcdef"
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

/** The platform: never gated, so it must answer whichever single module was bought. */
const PLATFORM = ["core", "dist", "ledger", "compliance", "analytics", "ai"] as const;

/** Every parameterless GET the spec declares under a module's base path. */
function reads(module: string): string[] {
  const paths = (openapi() as { paths: Record<string, Record<string, unknown>> }).paths;
  return Object.entries(paths)
    .filter(([path, ops]) => path.startsWith(`/v1/${module}/`) && !path.includes("{") && "get" in ops)
    .map(([path]) => path);
}

async function soloIn<T>(module: string, run: () => Promise<T>): Promise<T> {
  await setTenantColumn({ entitlementsJson: JSON.stringify(EntitlementsJson.parse({ edition: "suite", modules: [module], seats: 250 })) });
  try {
    return await run();
  } finally {
    await setTenantColumn({
      entitlementsJson: JSON.stringify(EntitlementsJson.parse({ edition: "suite", modules: [...GATED_MODULES], seats: 250 }))
    });
  }
}

/** What a tenant holding every module is told on each path: the bar a solo tenant must meet. */
async function statuses(paths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const path of paths) out.set(path, (await call("GET", path)).status);
  return out;
}

describe.each(GATED_MODULES.map((m) => [m]))("%s alone @accept:SA", (module) => {
  // A route the admin is refused with every module on (separation of duties:
  // approving is not administering) is refused alone too; that is not a gap.
  // A solo tenant must get what a full one gets, and never a 5xx.
  it("answers its own and the platform's read routes as a full tenant would", async () => {
    const paths = [...reads(module), ...PLATFORM.flatMap(reads)];
    expect(reads(module).length).toBeGreaterThan(0);
    const full = await statuses(paths);
    const solo = await soloIn(module, () => statuses(paths));
    const worse = paths.filter((p) => solo.get(p)! >= 500 || (solo.get(p) === 403 && full.get(p) !== 403));
    expect(worse.map((p) => `${solo.get(p)} (full ${full.get(p)}) ${p}`)).toEqual([]);
  });
});

// The scheduler decides whose sweeps and consumers run from `switchedOff`. It
// read the tenant's own switches only, so a module the tenant never bought
// still swept and consumed on the clock.
it("the scheduler stands down every module a solo tenant did not buy @accept:SA", async () => {
  const off = await soloIn("orbit", () => switchedOff(env, tenantId));
  expect([...off].sort()).toEqual(["axis", "north", "scout", "signal"]);
});

// The nightly tick ran every tenant on policy *defaults* plus its module
// switches, so a paused autopilot still moved money, quiet hours were reckoned
// in UTC and every tenant was insurance-retail. It must run on the tenant's own.
it("the scheduler runs a tenant on its own policy, not the defaults", async () => {
  await database.update(schema.tenants).set({ policyJson: JSON.stringify({ timezone: "Asia/Dubai", currency: "AED", domainPack: "insurance-gulf", signalAutopilotPaused: true }) }).where(eq(schema.tenants.id, tenantId));
  const { policy, entitlements } = await soloIn("signal", () => scheduledConfig(env, tenantId));
  expect(policy).toMatchObject({ timezone: "Asia/Dubai", currency: "AED", domainPack: "insurance-gulf", signalAutopilotPaused: true });
  expect(entitlements.modules).toEqual(["signal"]);
  expect(policy.moduleConfig?.axis?.enabled).toBe(false);
  expect(policy.moduleConfig?.signal?.enabled ?? true).toBe(true);
});

// A module bought alone needs people to work on; the platform's import is open
// to it whichever module that is.
it("a SIGNAL-only tenant can import the people it markets to @accept:SA", async () => {
  const out = await soloIn("signal", () => call("POST", "/v1/core/customers/import", { csv: "name,email,tags\nSolo Prospect,solo@x.test,motor\n" }));
  expect(out.status).toBe(201);
  expect(out.body).toMatchObject({ created: 1, errors: [] });
});

// ADR-0093: a channel is the platform's, so a module bought alone can configure
// the account it sends through, and the secrets never come back out.
it("a SIGNAL-only tenant configures a channel on the platform route @accept:SA", async () => {
  const out = await soloIn("signal", () =>
    call("POST", "/v1/core/channel-connectors", {
      provider: "mailgun-email",
      transport: "email",
      label: "Marketing mail",
      secretsJson: { apiKey: "key-solo-secret" },
      configJson: { domain: "mg.example.test" }
    })
  );
  expect(out.status).toBe(201);
  expect(JSON.stringify(out.body)).not.toContain("key-solo-secret");
});

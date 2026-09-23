import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, parseJson, PolicyJson, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// The tenant's auto-approve allowlist (docs/19 §7, CLAUDE.md convention 4) had
// five readers and exactly one writer — the seed. An operator could not change
// it at runtime, and the admin surface that appeared to offer it wrote nothing:
// a dead seam of the shape this repo keeps finding.
//
// The write path needs two guards the seed never needed, because this list is
// the escape hatch out of the approval gate:
//   * an unknown policy key sits inert in the array and grants nothing — so it
//     must be refused loudly rather than stored and silently ignored;
//   * a `neverAutoApprove` policy may not be added at all. That is docs/19 §7's
//     floor: no tenant setting may automate a payout, a client-money movement
//     or a regulatory crossing.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  "tenant.admin": "amina.saleh",
  "finance.controller": "faisal.omar" // no core:settings:update
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

async function allowlist(): Promise<readonly string[]> {
  const [row] = await database.select().from(schema.tenants).where(eq(schema.tenants.id, tenantId)).limit(1);
  return parseJson(PolicyJson, row!.policyJson).autoApprove;
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

describe("PATCH /v1/core/settings/auto-approve", () => {
  it("adds a permitted policy key and audits the change", async () => {
    const before = await allowlist();
    expect(before).not.toContain("axis.price_match");

    const res = await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", {
      add: ["axis.price_match"]
    });
    expect(res.status).toBe(200);
    expect(res.body.autoApprove).toContain("axis.price_match");
    expect(await allowlist()).toContain("axis.price_match");

    const audits = await database.select().from(schema.auditLog);
    expect(audits.some((a) => a.action === "core.auto_approve.updated")).toBe(true);
  });

  it("removes a key it previously granted", async () => {
    await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", { add: ["axis.price_match"] });
    const res = await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", {
      remove: ["axis.price_match"]
    });
    expect(res.status).toBe(200);
    expect(await allowlist()).not.toContain("axis.price_match");
  });

  it("refuses an unknown policy key instead of storing an inert entry", async () => {
    const res = await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", {
      add: ["axis.not_a_real_policy"]
    });
    expect(res.status).toBe(400);
    expect(await allowlist()).not.toContain("axis.not_a_real_policy");
  });

  it("refuses a neverAutoApprove policy — docs/19 §7's floor", async () => {
    for (const key of ["ledger.payout", "ledger.client_money_transfer", "axis.claim_payment"]) {
      const res = await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", { add: [key] });
      expect(res.status, `${key} must be refused`).toBe(400);
      expect(await allowlist()).not.toContain(key);
    }
  });

  // The guarded endpoint is only a guard if it is the only door. The generic
  // CRUD `PATCH /v1/core/tenants/:id` replaces `policyJson` wholesale, so it
  // reaches the same array — and the settings screen's calendar form already
  // posts through it. Without a check there, docs/19 §7's floor is one
  // hand-written request away from being lifted.
  it("refuses a neverAutoApprove key posted through the tenant CRUD path too", async () => {
    const res = await call("tenant.admin", "PATCH", `/v1/core/tenants/${tenantId}`, {
      policyJson: { autoApprove: ["ledger.payout"] }
    });
    expect(res.status).toBe(400);
    expect(await allowlist()).not.toContain("ledger.payout");
  });

  it("refuses an unknown policy key through the tenant CRUD path", async () => {
    const res = await call("tenant.admin", "PATCH", `/v1/core/tenants/${tenantId}`, {
      policyJson: { autoApprove: ["axis.not_a_real_policy"] }
    });
    expect(res.status).toBe(400);
  });

  it("still allows the CRUD path to write the rest of the policy", async () => {
    const res = await call("tenant.admin", "PATCH", `/v1/core/tenants/${tenantId}`, {
      policyJson: { calendarPreference: "gregorian", autoApprove: ["axis.price_match"] }
    });
    expect(res.status).toBe(200);
    expect(await allowlist()).toContain("axis.price_match");
  });

  it("refuses an actor without core:settings:update", async () => {
    const res = await call("finance.controller", "PATCH", "/v1/core/settings/auto-approve", {
      add: ["axis.price_match"]
    });
    expect(res.status).toBe(403);
  });
});

// The read an admin screen needs to offer the list at all: what is on it now,
// and which policies may go on it. Without the second half a screen has to
// hard-code docs/19 §7's floor and drift from APPROVAL_POLICIES.
describe("GET /v1/core/settings/auto-approve", () => {
  it("returns the allowlist and every policy, marking the ones the floor forbids", async () => {
    await call("tenant.admin", "PATCH", "/v1/core/settings/auto-approve", { add: ["axis.price_match"] });
    const res = await call("tenant.admin", "GET", "/v1/core/settings/auto-approve");
    expect(res.status).toBe(200);
    expect(res.body.autoApprove).toEqual(await allowlist());
    const byKey = new Map(res.body.policies.map((p: { key: string }) => [p.key, p]));
    expect(byKey.get("axis.price_match")).toMatchObject({ module: "axis", automatable: true });
    expect(byKey.get("ledger.payout")).toMatchObject({ module: "ledger", automatable: false });
  });
});

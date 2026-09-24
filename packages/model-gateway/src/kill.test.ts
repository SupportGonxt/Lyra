import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { AppError, permissionsForRole, type Ctx } from "@lyra/core";
import { AI_KILL_SWITCH, assertNotKilled, killedBy } from "./kill.js";
import { Gateway } from "./gateway.js";
import { makeStub } from "./providers/stub.js";

// docs/12 §4: "Kill switches: per-agent, per-module, per-tenant, global — all
// one click, all logged, all tested monthly." Per-agent is the agent row's
// status (routes/ai.ts). The other three land here, in front of the only door
// to a model.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = 1_700_000_000_000;
let client: Client;

function makeCtx(policy: Record<string, unknown> = {}): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: {
      kind: "user",
      id: "u_1",
      tenantId: "t_1",
      grants: [{ roleKey: "axis.agent", permissions: permissionsForRole("axis.agent") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse(policy),
    entitlements: EntitlementsJson.parse({})
  };
}

async function flag(patch: Partial<typeof schema.featureFlags.$inferInsert>) {
  await client.execute({
    sql: `insert into core_feature_flags
            (id, key, description, enabled, rollout_percent, target_tenant_ids_json, updated_by, updated_at)
          values (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "ff_kill",
      AI_KILL_SWITCH,
      "kill",
      patch.enabled ? 1 : 0,
      patch.rolloutPercent ?? 100,
      patch.targetTenantIdsJson ?? null,
      "u_ops",
      NOW
    ]
  });
}

/** Only the suites that read the kill-switch table build a database (see guardrails.test.ts). */
async function freshDb(): Promise<void> {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
}

describe("killedBy", () => {
  const clean = PolicyJson.parse({});

  it("allows the call when no tier is engaged", () => {
    expect(killedBy({ policy: clean, module: "axis", tenantId: "t_1" })).toBeNull();
  });

  it("kills every module for a paused tenant", () => {
    const policy = PolicyJson.parse({ aiPaused: true });
    expect(killedBy({ policy, module: "axis", tenantId: "t_1" })).toBe("tenant");
    expect(killedBy({ policy, module: "orbit", tenantId: "t_1" })).toBe("tenant");
  });

  it("kills only the named module", () => {
    const policy = PolicyJson.parse({ aiPausedModules: ["orbit"] });
    expect(killedBy({ policy, module: "orbit", tenantId: "t_1" })).toBe("module");
    expect(killedBy({ policy, module: "axis", tenantId: "t_1" })).toBeNull();
  });

  it("kills on the platform flag, and reports global ahead of the tenant's own pause", () => {
    const on = { key: AI_KILL_SWITCH, enabled: true, rolloutPercent: 100, targetTenantIdsJson: null };
    expect(killedBy({ policy: clean, module: "axis", tenantId: "t_1", flag: on })).toBe("global");
    // Which tier is reported matters: a tenant admin can release their own
    // pause and must not be told to, when it is ops holding the switch.
    expect(
      killedBy({ policy: PolicyJson.parse({ aiPaused: true }), module: "axis", tenantId: "t_1", flag: on })
    ).toBe("global");
  });

  it("scopes a targeted platform kill to the tenants it names", () => {
    const targeted = {
      key: AI_KILL_SWITCH,
      enabled: true,
      rolloutPercent: 100,
      targetTenantIdsJson: JSON.stringify(["t_2"])
    };
    expect(killedBy({ policy: clean, module: "axis", tenantId: "t_1", flag: targeted })).toBeNull();
    expect(killedBy({ policy: clean, module: "axis", tenantId: "t_2", flag: targeted })).toBe("global");
  });

  it("treats a disabled flag as no kill at all", () => {
    const off = { key: AI_KILL_SWITCH, enabled: false, rolloutPercent: 100, targetTenantIdsJson: null };
    expect(killedBy({ policy: clean, module: "axis", tenantId: "t_1", flag: off })).toBeNull();
  });
});

describe("assertNotKilled", () => {
  beforeEach(freshDb);

  it("passes when nothing is paused and no flag row exists", async () => {
    await expect(assertNotKilled(makeCtx(), "axis")).resolves.toBeNull();
  });

  it("throws 503 naming the tier that stopped the call", async () => {
    const err = await assertNotKilled(makeCtx({ aiPausedModules: ["axis"] }), "axis").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(503);
    expect((err as AppError).detail).toContain("module");
  });

  it("reads the platform flag from the database", async () => {
    await flag({ enabled: true });
    await expect(assertNotKilled(makeCtx(), "axis")).rejects.toBeInstanceOf(AppError);
  });
});

describe("gateway enforcement", () => {
  beforeEach(freshDb);

  it("audits a killed call and never reaches the provider", async () => {
    const stub = makeStub();
    const gw = new Gateway({ env: {}, providers: { stub, "workers-ai": stub, anthropic: stub } });
    const ctx = makeCtx({ aiPaused: true });

    await expect(
      gw.complete(ctx, { module: "axis", purpose: "axis.case.copilot", tier: "fast", messages: [] })
    ).rejects.toBeInstanceOf(AppError);

    const rows = await ctx.db.select().from(schema.aiAuditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("killed");
    // The whole point of a kill switch is that nothing downstream runs.
    expect(stub.calls).toHaveLength(0);
  });
});

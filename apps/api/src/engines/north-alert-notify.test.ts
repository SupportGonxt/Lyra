import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { emit, permissionsForRole, type Ctx } from "@lyra/core";
import { drainOutbox } from "../dispatch.js";

// Regression: the snapshotter emits `north.alert.triggered` when a threshold
// rule breaches (north-snapshotter.ts), and nothing consumed it — and the
// rule's `notifyChannelRef` was never read — so an alert rule an analyst set up
// told nobody anything. The consumer writes to the in-app inbox
// (core_notifications), the same path every other internal notice uses.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.UTC(2026, 5, 15, 12);

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function ctxFor(tenantId: string, now = NOW): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: {
      kind: "system",
      id: "scheduler",
      tenantId,
      grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
    },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

async function user(c: Ctx, id: string, roleKey?: string): Promise<void> {
  await c.db.insert(schema.users).values({
    id,
    tenantId: c.tenantId,
    email: `${id}@example.test`,
    name: id,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });
  if (!roleKey) return;
  const roleId = `rol_${c.tenantId}_${roleKey}`;
  const existing = await c.db.select().from(schema.roles).where(eq(schema.roles.id, roleId));
  if (!existing.length) {
    await c.db.insert(schema.roles).values({
      id: roleId,
      tenantId: c.tenantId,
      key: roleKey,
      name: roleKey,
      permissionsJson: "[]",
      createdAt: NOW
    });
  }
  await c.db.insert(schema.userRoles).values({
    id: `ur_${id}`,
    tenantId: c.tenantId,
    userId: id,
    roleId,
    createdAt: NOW
  });
}

async function rule(c: Ctx, id: string, notifyChannelRef: string | null, enabled = true): Promise<void> {
  await c.db.insert(schema.northAlertRules).values({
    id,
    tenantId: c.tenantId,
    metricKey: "gwp",
    operator: "lt",
    thresholdValue: 1_000_000,
    windowGrain: "day",
    notifyChannelRef,
    enabled,
    createdAt: NOW,
    updatedAt: NOW
  });
}

const fire = (c: Ctx, ruleId: string, period = "2026-06-15") =>
  emit(c, {
    module: "north",
    type: "north.alert.triggered",
    subject: ruleId,
    data: { ruleId, metricKey: "gwp", value: 400_000, thresholdValue: 1_000_000, operator: "lt", grain: "day", period }
  });

const inbox = async (c: Ctx) =>
  (await c.db.select().from(schema.notifications)).filter((n) => n.tenantId === c.tenantId);

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = ctxFor("t_1");
});

describe("north.alert.triggered reaches an inbox", () => {
  it("notifies the user the rule names", async () => {
    await user(ctx, "u_cfo");
    await user(ctx, "u_bystander", "north.analyst");
    await rule(ctx, "nar_1", "user:u_cfo");
    await fire(ctx, "nar_1");
    await drainOutbox(ctx);

    const notes = await inbox(ctx);
    expect(notes.map((n) => n.userId)).toEqual(["u_cfo"]);
    expect(notes[0]?.titleKey).toBe("north.alert.triggered");
    expect(JSON.parse(notes[0]?.paramsJson ?? "{}")).toMatchObject({ metricKey: "gwp", period: "2026-06-15" });
  });

  it("notifies every holder of the role the rule names", async () => {
    await user(ctx, "u_exec_1", "north.exec");
    await user(ctx, "u_exec_2", "north.exec");
    await user(ctx, "u_analyst", "north.analyst");
    await rule(ctx, "nar_2", "role:north.exec");
    await fire(ctx, "nar_2");
    await drainOutbox(ctx);
    expect((await inbox(ctx)).map((n) => n.userId).sort()).toEqual(["u_exec_1", "u_exec_2"]);
  });

  it("falls back to the rule's authors (north.analyst) when the rule names no one it can reach", async () => {
    await user(ctx, "u_analyst", "north.analyst");
    await rule(ctx, "nar_3", null);
    await rule(ctx, "nar_4", "slack:#ops");
    await fire(ctx, "nar_3");
    await fire(ctx, "nar_4");
    await drainOutbox(ctx);
    expect((await inbox(ctx)).map((n) => `${n.userId}:${n.subjectRef}`).sort()).toEqual([
      "u_analyst:nar_3",
      "u_analyst:nar_4"
    ]);
  });

  it("tells nobody about a rule that was disabled before delivery", async () => {
    await user(ctx, "u_cfo");
    await rule(ctx, "nar_5", "user:u_cfo", false);
    await fire(ctx, "nar_5");
    await drainOutbox(ctx);
    expect(await inbox(ctx)).toEqual([]);
  });

  it("notifies once per rule per period, however many nightly runs re-fire it", async () => {
    await user(ctx, "u_cfo");
    await rule(ctx, "nar_6", "user:u_cfo");
    await fire(ctx, "nar_6");
    await drainOutbox(ctx);
    const later = ctxFor("t_1", NOW + 3_600_000);
    await fire(later, "nar_6");
    await drainOutbox(later);
    expect(await inbox(ctx)).toHaveLength(1);
    await fire(later, "nar_6", "2026-06-16");
    await drainOutbox(later);
    expect(await inbox(ctx)).toHaveLength(2);
  });

  it("never reaches a user of another tenant, even one the rule names", async () => {
    const other = ctxFor("t_2");
    await user(other, "u_foreign");
    await user(ctx, "u_analyst", "north.analyst");
    await rule(ctx, "nar_7", "user:u_foreign");
    await fire(ctx, "nar_7");
    await drainOutbox(ctx);
    expect((await inbox(other)).length).toBe(0);
    expect((await inbox(ctx)).map((n) => n.userId)).toEqual(["u_analyst"]);
  });
});

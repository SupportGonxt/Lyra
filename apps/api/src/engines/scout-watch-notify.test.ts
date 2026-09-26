import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { seed, type Ctx, type WatchFinding } from "@lyra/core";
import { notifyUrgentWatch } from "./scout-watch.js";

// docs/30 SCOUT gap 3. The watch was a screen someone had to open; an urgent
// finding now reaches the people who lead SCOUT, once a day per subject.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T02:00:00Z");
let ctx: Ctx;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const sqls = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sqls) await client.execute(s);
  const db = drizzle(client) as unknown as Ctx["db"];
  const { tenantId } = await seed(db, { password: "scout-watch-notify-2026" });
  ctx = {
    db,
    tenantId,
    actor: { kind: "system", id: "scheduler", tenantId, grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

const finding = (key: string, severity: WatchFinding["severity"]): WatchFinding => ({
  kind: "competitor",
  key,
  source: "news",
  subject: "EV motor cover",
  count: 12,
  priorCount: 2,
  deltaPct: 500,
  severity,
  firstSeen: NOW - 3600_000,
  lastSeen: NOW,
  signalIds: []
});

describe("notifyUrgentWatch", () => {
  it("tells every SCOUT lead of each urgent finding, once a day per subject, and nothing else", async () => {
    const leads = await ctx.db
      .select({ userId: schema.userRoles.userId })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(eq(schema.roles.key, "scout.lead"));
    expect(leads.length).toBeGreaterThan(0);

    const told = await notifyUrgentWatch(ctx, [finding("news:ev", "urgent"), finding("news:quiet", "attention")]);
    expect(told).toBe(leads.length);
    expect(await notifyUrgentWatch({ ...ctx, now: NOW + 3600_000 }, [finding("news:ev", "urgent")])).toBe(0);
    expect(await notifyUrgentWatch({ ...ctx, now: NOW + 26 * 3600_000 }, [finding("news:ev", "urgent")])).toBe(leads.length);

    const rows = (await ctx.db.select().from(schema.notifications)).filter((n) => n.titleKey === "scout.watch.alert");
    expect(rows).toHaveLength(2 * leads.length);
    expect(rows[0]).toMatchObject({ kind: "alert", subjectRef: "news:ev" });
    expect(JSON.parse(rows[0]!.paramsJson!)).toMatchObject({ subject: "EV motor cover", deltaPct: 500, day: "2026-08-20" });
  });
});

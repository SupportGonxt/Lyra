import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { pushMetricValues } from "./north-metric-push.js";

// docs/30 NORTH 3. A metric the snapshotter cannot compute (no registered
// definition) had no way in, so NORTH was only usable on Lyra's own tables.
// A push writes grand-total snapshots for such a metric; a changed value drops
// its verification, because the attested number is no longer the one stored.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")).map((s) => s.trim()).filter(Boolean)) {
    await client.execute(s);
  }
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_ops", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  const metric = (key: string, grain = "month") => ({
    id: `met_${key}`, tenantId: "t_1", key, nameJson: "{}", definitionSqlRef: `push:${key}`, grain, createdAt: NOW, updatedAt: NOW
  });
  await ctx.db.insert(schema.northMetrics).values([metric("store_footfall"), metric("gwp")]);
});

const snaps = () => ctx.db.select().from(schema.northSnapshots);

describe("pushMetricValues", () => {
  it("writes a grand-total snapshot per period, and a re-push updates rather than duplicates", async () => {
    expect(await pushMetricValues(ctx, "store_footfall", [{ period: "2026-07", value: 1200 }, { period: "2026-08", value: 900 }])).toEqual({ written: 2 });
    await pushMetricValues(ctx, "store_footfall", [{ period: "2026-08", value: 950 }]);
    const rows = await snaps();
    expect(rows.map((r) => [r.period, r.grain, r.dimsHash, r.value]).sort()).toEqual([
      ["2026-07", "month", "", 1200],
      ["2026-08", "month", "", 950]
    ]);
  });

  it("drops the verification of a value that changed, and keeps it on an identical re-push", async () => {
    await pushMetricValues(ctx, "store_footfall", [{ period: "2026-07", value: 1200 }, { period: "2026-08", value: 900 }]);
    await ctx.db.update(schema.northSnapshots).set({ verifiedAt: NOW, verifiedBy: "user:u_cfo", verificationRef: "stmt-7" });
    await pushMetricValues(ctx, "store_footfall", [{ period: "2026-07", value: 1200 }, { period: "2026-08", value: 901 }]);
    const byPeriod = Object.fromEntries((await snaps()).map((r) => [r.period, r.verifiedBy]));
    expect(byPeriod).toEqual({ "2026-07": "user:u_cfo", "2026-08": null });
  });

  it("refuses an unknown metric, one the snapshotter computes, and a period not in the metric's grain", async () => {
    await expect(pushMetricValues(ctx, "nope", [{ period: "2026-07", value: 1 }])).rejects.toMatchObject({ status: 404 });
    await expect(pushMetricValues(ctx, "gwp", [{ period: "2026-07", value: 1 }])).rejects.toMatchObject({ status: 409 });
    await expect(pushMetricValues(ctx, "store_footfall", [{ period: "2026-07-01", value: 1 }])).rejects.toMatchObject({ status: 400 });
    expect(await snaps()).toEqual([]);
  });
});

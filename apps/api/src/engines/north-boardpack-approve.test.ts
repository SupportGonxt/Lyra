import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { approveBoardpack, assembleBoardpackSections, distributeBoardpack } from "./north-boardpack.js";

// docs/30 NORTH 5. A board pack stopped at "review": the columns for approval
// and a distribution log existed and nothing wrote them. Approval moves it to
// final; distribution sends a final pack to named people, once each, and keeps
// the log a board secretary is asked for.

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
    actor: { kind: "user", id: "u_exec", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  const pack = (id: string, status: string) => ({
    id, tenantId: "t_1", period: "2026-07", title: "July", sectionsJson: "[]", pdfFileId: "file_1", xlsxFileId: null,
    distributionLogJson: "[]", status, approvedBy: null, createdAt: NOW, updatedAt: NOW
  });
  await ctx.db.insert(schema.northBoardpacks).values([pack("bpk_review", "review"), pack("bpk_draft", "draft")]);
  const user = (id: string, tenantId = "t_1") => ({ id, tenantId, email: `${id}@x.test`, name: id, status: "active", createdAt: NOW, updatedAt: NOW });
  await ctx.db.insert(schema.users).values([user("u_board1"), user("u_board2"), user("u_elsewhere", "t_2")] as never);
});

const row = async (id: string) => (await ctx.db.select().from(schema.northBoardpacks).where(eq(schema.northBoardpacks.id, id)))[0]!;

describe("approving a board pack", () => {
  it("moves a pack in review to final, stamping who", async () => {
    await approveBoardpack(ctx, "bpk_review");
    expect(await row("bpk_review")).toMatchObject({ status: "final", approvedBy: "user:u_exec" });
  });

  it("refuses a draft (it has no rendered file) and a second approval", async () => {
    await expect(approveBoardpack(ctx, "bpk_draft")).rejects.toMatchObject({ status: 409 });
    await approveBoardpack(ctx, "bpk_review");
    await expect(approveBoardpack(ctx, "bpk_review")).rejects.toMatchObject({ status: 409 });
    await expect(approveBoardpack(ctx, "bpk_nope")).rejects.toMatchObject({ status: 404 });
  });
});

describe("distributing a board pack", () => {
  it("refuses a pack nobody approved", async () => {
    await expect(distributeBoardpack(ctx, "bpk_review", ["u_board1"])).rejects.toMatchObject({ status: 409 });
  });

  it("tells each named person once, logs it, and moves the pack to distributed", async () => {
    await approveBoardpack(ctx, "bpk_review");
    await distributeBoardpack(ctx, "bpk_review", ["u_board1", "u_board1@x.test", "u_board2"]);
    await distributeBoardpack({ ...ctx, now: NOW + 1000 }, "bpk_review", ["u_board2"]);

    const pack = await row("bpk_review");
    expect(pack.status).toBe("distributed");
    expect(JSON.parse(pack.distributionLogJson!)).toEqual([
      { to: "u_board1", at: NOW, by: "user:u_exec", fileId: "file_1" },
      { to: "u_board2", at: NOW, by: "user:u_exec", fileId: "file_1" }
    ]);
    const told = (await ctx.db.select().from(schema.notifications)).map((n) => [n.userId, n.titleKey, n.subjectRef]);
    expect(told).toEqual([
      ["u_board1", "north.boardpack.distributed", "bpk_review"],
      ["u_board2", "north.boardpack.distributed", "bpk_review"]
    ]);
    const events = (await ctx.db.select().from(schema.eventOutbox)).map((e) => e.type);
    expect(events.filter((t) => t === "north.boardpack.distributed")).toHaveLength(1);
  });

  it("refuses a recipient outside this tenant, sending nothing", async () => {
    await approveBoardpack(ctx, "bpk_review");
    await expect(distributeBoardpack(ctx, "bpk_review", ["u_board1", "u_elsewhere"])).rejects.toMatchObject({ status: 400 });
    expect(await ctx.db.select().from(schema.notifications)).toEqual([]);
  });
});

/* ---------------------- a board pack says which row is the headline */

/**
 * The 2026-10-01 sweep's NORTH finding. `north_snapshots` holds one row per metric
 * **per slice** — `dimsHash` `""` is the grand total — and the pack's "Metric
 * snapshot" table selected `metricKey`, `period` and `value` with **no dimension**.
 * For period "2025-12" that printed `gwp` three times (3,507,200 gross; 3,091,200
 * web; 416,000 brokerAlpha) with nothing to distinguish them, in the artifact a
 * board signs off.
 */
describe("the metric snapshot distinguishes a headline from its slices", () => {
  it("names the dimension, leads with the total, and keeps the breakdown", async () => {
    // The registry row first: `north_metrics` is what the snapshotter reads to decide
    // what to compute, and it is where the currency is stated (item 4).
    await ctx.db.insert(schema.northMetrics).values({
      id: "mtr_gwp",
      tenantId: "t_1",
      key: "gwp",
      nameJson: JSON.stringify({ en: "Gross written premium" }),
      definitionSqlRef: "sql/metrics/gwp.sql",
      unit: "money",
      currency: "AED",
      grain: "month",
      direction: "up",
      sensitivity: "internal",
      createdAt: NOW,
      updatedAt: NOW
    } as never);

    await ctx.db.insert(schema.northSnapshots).values([
      { id: "s_web", tenantId: "t_1", metricKey: "gwp", grain: "month", period: "2026-07", dimsHash: "channel=web", value: 3_091_200, ts: 1 },
      { id: "s_broker", tenantId: "t_1", metricKey: "gwp", grain: "month", period: "2026-07", dimsHash: "channel=brokerAlpha", value: 416_000, ts: 2 },
      { id: "s_total", tenantId: "t_1", metricKey: "gwp", grain: "month", period: "2026-07", dimsHash: "", value: 3_507_200, ts: 3 }
    ]);

    const sections = await assembleBoardpackSections(ctx, "2026-07");
    const rows = sections.metrics.rows as { metricKey: string; dimension?: string; value: number }[];

    // Three rows, three distinguishable facts — not three rows that look alike.
    expect(rows).toHaveLength(3);
    expect(rows[0]!.dimension).toBe("Total");
    expect(rows[0]!.value).toBe(3_507_200);
    // The breakdown survives: a headline without its slices hides where the money
    // is, which is why the fix labelled the rows rather than filtering them out.
    expect(rows.slice(1).map((r) => r.dimension).sort()).toEqual(["channel=brokerAlpha", "channel=web"]);
    // And the total leads, so a reader scanning the column sees the headline first.
    expect(rows.findIndex((r) => r.dimension === "Total")).toBe(0);

    // Every row names the currency the figure is **in** — the number alone was the
    // finding: a board read "3,507,200" with nothing saying which currency, after the
    // multi-market work had made nine of them possible in one table.
    const priced = sections.metrics.rows as { currency?: string }[];
    expect(priced.every((r) => r.currency === "AED")).toBe(true);
    expect(sections.metrics.columns.map((c) => c.key)).toContain("currency");
  });
});

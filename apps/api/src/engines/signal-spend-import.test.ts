import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { importSpend } from "./signal-spend-import.js";
import { Hono } from "hono";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// docs/30 SIGNAL gap 1. Spend actuals are what the autopilot's CAC and every
// response rate divide by, and nothing but a demo tick could write them. The
// import is the door an ad-platform export actually comes through: per-line
// honest, and re-importing the same day corrects it instead of doubling it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  const sqls = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sqls) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await ctx.db.insert(schema.signalCampaigns).values({
    id: "cmp_1",
    tenantId: "t_1",
    name: "Motor",
    objective: "acq",
    channelsJson: "[]",
    budgetJson: "{}",
    ownerRef: "user:1",
    createdAt: NOW,
    updatedAt: NOW
  });
});

const HEADER = "day,campaignId,channel,amountMinor,currency,impressions,clicks,conversions";
const rows = () => ctx.db.select().from(schema.signalSpend);
const events = async () =>
  (await ctx.db.select().from(schema.eventOutbox)).map((e) => JSON.parse(e.envelopeJson)).filter((e) => e.type === "signal.spend.recorded");

describe("importSpend", () => {
  it("writes each valid line as an import and announces it", async () => {
    const result = await importSpend(ctx, [HEADER, "2026-08-18,cmp_1,meta,125000,AED,40000,900,12", "2026-08-18,,google_search,50000,AED,,,"].join("\n"));
    expect(result).toEqual({ created: 2, updated: 0, errors: [] });
    const stored = (await rows()).map((r) => [r.day, r.campaignId, r.channel, r.amountMinor, r.clicks, r.source]);
    expect(stored).toEqual([
      ["2026-08-18", "cmp_1", "meta", 125000, 900, "import"],
      ["2026-08-18", null, "google_search", 50000, 0, "import"]
    ]);
    expect(await events()).toHaveLength(2);
  });

  it("corrects a day it already holds, with or without a campaign, instead of doubling it", async () => {
    const csv = (amount: number) => [HEADER, `2026-08-18,cmp_1,meta,${amount},AED,1,1,1`, `2026-08-18,,meta,${amount},AED,1,1,1`].join("\n");
    await importSpend(ctx, csv(100));
    expect(await importSpend(ctx, csv(250))).toEqual({ created: 0, updated: 2, errors: [] });
    expect((await rows()).map((r) => r.amountMinor)).toEqual([250, 250]);
  });

  it("names every line it refused and why, and still writes the rest", async () => {
    const result = await importSpend(
      ctx,
      [
        HEADER,
        "2026-02-30,cmp_1,meta,1,AED,0,0,0",
        "2026-08-18,cmp_nope,meta,1,AED,0,0,0",
        "2026-08-18,cmp_1,,1,AED,0,0,0",
        "2026-08-18,cmp_1,meta,-5,AED,0,0,0",
        "2026-08-18,cmp_1,meta,1.5,AED,0,0,0",
        "2026-08-18,cmp_1,meta,1,dirham,0,0,0",
        "2026-08-18,cmp_1,meta,1,AED,x,0,0",
        "2026-08-19,cmp_1,meta,1,AED,0,0,0"
      ].join("\n")
    );
    expect(result.created).toBe(1);
    expect(result.errors.map((e) => [e.line, e.error])).toEqual([
      [2, "day must be a real YYYY-MM-DD date"],
      [3, "no campaign cmp_nope"],
      [4, "channel is required"],
      [5, "amountMinor must be a whole number of minor units, 0 or more"],
      [6, "amountMinor must be a whole number of minor units, 0 or more"],
      [7, "currency must be a 3-letter ISO code"],
      [8, "impressions must be a whole number, 0 or more"]
    ]);
  });

  it("refuses a file missing a required column, writing nothing", async () => {
    const result = await importSpend(ctx, ["day,channel,currency", "2026-08-18,meta,AED"].join("\n"));
    expect(result).toEqual({ created: 0, updated: 0, errors: [{ line: 1, ref: null, error: "missing column amountMinor" }] });
    expect(await rows()).toEqual([]);
  });

  it("will not credit another tenant's campaign", async () => {
    await ctx.db.insert(schema.signalCampaigns).values({
      id: "cmp_other",
      tenantId: "t_2",
      name: "Theirs",
      objective: "acq",
      channelsJson: "[]",
      budgetJson: "{}",
      ownerRef: "user:2",
      createdAt: NOW,
      updatedAt: NOW
    });
    const result = await importSpend(ctx, [HEADER, "2026-08-18,cmp_other,meta,1,AED,0,0,0"].join("\n"));
    expect(result.errors).toEqual([{ line: 2, ref: "2026-08-18", error: "no campaign cmp_other" }]);
  });
});

describe("POST /spend/import", () => {
  const post = async (permissions: string[], payload: unknown) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    const res = await a.fetch(new Request("http://api.test/spend/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("imports for a holder of signal:spend:write, and refuses a reader", async () => {
    const csv = [HEADER, "2026-08-18,cmp_1,meta,100,AED,0,0,0"].join("\n");
    expect((await post(["signal:spend:read"], { csv })).status).toBe(403);
    expect(await rows()).toEqual([]);
    const ok = await post(["signal:spend:write"], { csv });
    expect(ok).toEqual({ status: 201, body: { created: 1, updated: 0, errors: [] } });
    expect((await post(["signal:spend:write"], {})).status).toBe(400);
  });
});

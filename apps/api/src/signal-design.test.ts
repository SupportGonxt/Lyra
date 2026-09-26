import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { onError } from "./mw.js";
import { signalRoutes } from "./routes/signal.js";
import type { App } from "./env.js";

// ST2: a designer's canvas edits are saved on the creative. Moving a headline
// does not change what the ad says, so it is not a publish: no approval, but
// audited, and only a design the engine can draw is stored.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-09-26T12:00:00Z");
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort().flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")).map((s) => s.trim()).filter(Boolean)) {
    await client.execute(s);
  }
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
  await ctx.db.insert(schema.signalCreatives).values({
    id: "crv_1", tenantId: "t_1", kind: "social", contentRef: "Cover in minutes", complianceStatus: "passed", createdAt: NOW, updatedAt: NOW
  });
});

const put = async (permissions: string[], id: string, body: unknown) => {
  const a = new Hono<App>();
  a.onError(onError);
  a.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
    await next();
  });
  a.route("/", signalRoutes);
  const res = await a.fetch(new Request(`http://api.test/creatives/${id}/design`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const design = { template: "quote", edits: { square: { headline: { dx: 12, dy: -8, scale: 1.2 } } } };

describe("PUT /creatives/:id/design", () => {
  it("stores the layout and edits, audited, with no approval raised", async () => {
    const out = await put(["signal:creatives:generate"], "crv_1", design);
    expect(out.status).toBe(200);
    const [row] = await ctx.db.select().from(schema.signalCreatives).where(eq(schema.signalCreatives.id, "crv_1"));
    expect(JSON.parse(row!.designJson!)).toEqual(design);
    expect(row!.contentRef).toBe("Cover in minutes");
    expect(await ctx.db.select().from(schema.approvals)).toEqual([]);
    const audits = await ctx.db.select().from(schema.auditLog);
    expect(audits.map((a) => a.action)).toContain("signal.creative.designed");
  });

  it("refuses what the engine cannot draw, a reader without the grant, and an unknown creative", async () => {
    expect((await put(["signal:creatives:generate"], "crv_1", { template: "collage" })).status).toBe(400);
    expect((await put(["signal:creatives:generate"], "crv_1", { template: "quote", edits: { square: { headline: { dx: 0, dy: 0, scale: 9 } } } })).status).toBe(400);
    expect((await put(["signal:creatives:read"], "crv_1", design)).status).toBe(403);
    expect((await put(["signal:creatives:generate"], "crv_nope", design)).status).toBe(404);
  });
});

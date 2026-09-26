import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { approveBoardpack, distributeBoardpack } from "./north-boardpack.js";

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

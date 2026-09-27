import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { assertNotScreenedOut } from "./screening.js";
import type { Ctx } from "./context.js";

// docs/19 §4, docs/30 Compliance 4: a screening hit blocks. The block was a
// flag on the screening row that nothing read, so a sanctioned customer bound
// as easily as anyone. Every bind asks this one question first.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const NOW = 1_700_000_000_000;
let ctx: Ctx;

const screening = (id: string, over: Partial<typeof schema.screenings.$inferInsert> = {}) => ({
  id,
  tenantId: "t_1",
  subjectRef: "customer:cus_1",
  kind: "sanctions",
  provider: "stub",
  queryHash: "h",
  result: "hit",
  blocked: true,
  ts: NOW,
  ...over
});

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
});

describe("assertNotScreenedOut", () => {
  it("lets a customer with no standing block through", async () => {
    await ctx.db.insert(schema.screenings).values([
      screening("scr_clear", { result: "clear", blocked: false }),
      screening("scr_cleared", { blocked: false, disposition: "false_positive" }),
      // Someone else's block, and another tenant's block on this customer id.
      screening("scr_other", { subjectRef: "customer:cus_2" }),
      screening("scr_tenant", { tenantId: "t_2" })
    ]);
    await expect(assertNotScreenedOut(ctx, "cus_1")).resolves.toBeUndefined();
  });

  it("refuses while a hit stands, naming the screening", async () => {
    await ctx.db.insert(schema.screenings).values(screening("scr_hit"));
    await expect(assertNotScreenedOut(ctx, "cus_1")).rejects.toMatchObject({
      status: 409,
      detail: expect.stringContaining("scr_hit")
    });
  });

  it("has nothing to ask about a bind with no customer", async () => {
    await ctx.db.insert(schema.screenings).values(screening("scr_hit"));
    await expect(assertNotScreenedOut(ctx, null)).resolves.toBeUndefined();
  });
});

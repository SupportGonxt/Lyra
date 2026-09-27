import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, id, schema } from "@lyra/db";
import { benchPeriod, seed, type Ctx } from "@lyra/core";
import { benchElasticity } from "./scout-bench.js";

// docs/30 SCOUT 5: price elasticity from the bench, read over the cells the
// pricing screen could itself see — a cell under the k-anonymity floor names
// the one counterparty behind it, so it does not feed an aggregate either.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
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
  const { tenantId } = await seed(db, { password: "scout-elasticity-2026" });
  ctx = {
    db,
    tenantId,
    actor: { kind: "system", id: "scheduler", tenantId, grants: [] },
    requestId: "req_1",
    // The seed writes its bench at its own clock (2026-01); read a month later.
    now: Date.UTC(2026, 1, 1),
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

const cell = (n: number, over: Partial<typeof schema.scoutPanelBench.$inferInsert>) =>
  ({
    id: id("pnb", ctx.now + 1_000 + n),
    tenantId: ctx.tenantId,
    providerId: `prv_${n}`,
    line: "pets",
    period: benchPeriod(ctx.now),
    ourPriceIdx: 10_000,
    marketPriceIdx: 10_000,
    winRate: 30,
    volume: 500,
    coverageGapsJson: "[]",
    updatedAt: ctx.now,
    ...over
  }) as typeof schema.scoutPanelBench.$inferInsert;

describe("benchElasticity", () => {
  it("fits the seeded motor line, whose cells spread either side of the panel median", async () => {
    const lines = await benchElasticity(ctx);
    const motor = lines.find((one) => one.line === "motor")!;
    expect(motor.state).toBe("estimated");
    expect(motor.observations).toBeGreaterThanOrEqual(5);
    // Dearer seeded rows win less: the slope points down.
    expect(motor.elasticity!).toBeLessThan(0);
  });

  it("says a one-provider line is not enough to fit, rather than omitting it", async () => {
    const lines = await benchElasticity(ctx);
    expect(lines.find((one) => one.line === "health")).toMatchObject({ state: "insufficient", reason: "too-few" });
  });

  it("leaves out cells under the k-anonymity floor and cells older than the bench window", async () => {
    await ctx.db.insert(schema.scoutPanelBench).values([
      cell(1, { ourPriceIdx: 8_000, winRate: 50 }),
      cell(2, { ourPriceIdx: 9_000, winRate: 40 }),
      cell(3, { ourPriceIdx: 11_000, winRate: 25 }),
      cell(4, { ourPriceIdx: 12_000, winRate: 20 }),
      // Would be the fifth — but 19 answers is one under the default floor of 20.
      cell(5, { ourPriceIdx: 10_000, winRate: 30, volume: 19 }),
      // And this one is two years old.
      cell(6, { ourPriceIdx: 10_000, winRate: 30, period: benchPeriod(ctx.now - 730 * 86_400_000) })
    ]);
    const pets = (await benchElasticity(ctx)).find((one) => one.line === "pets")!;
    expect(pets).toMatchObject({ state: "insufficient", reason: "too-few", observations: 4, volume: 2_000 });

    const lowered = { ...ctx, policy: PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: 19 } } } }) };
    const fitted = (await benchElasticity(lowered)).find((one) => one.line === "pets")!;
    expect(fitted.state).toBe("estimated");
    expect(fitted.observations).toBe(5);
  });

  it("reads only this tenant's cells", async () => {
    await ctx.db.insert(schema.scoutPanelBench).values(
      [1, 2, 3, 4, 5].map((n) => cell(10 + n, { tenantId: "ten_someone_else", line: "boats", ourPriceIdx: 8_000 + n * 800 }))
    );
    expect((await benchElasticity(ctx)).some((one) => one.line === "boats")).toBe(false);
  });
});

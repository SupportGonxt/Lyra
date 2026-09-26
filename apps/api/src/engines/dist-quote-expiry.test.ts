import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { expireQuoteRequests } from "./dist-quote-expiry.js";

// `expired` was a declared quote-request state nothing ever wrote (docs/30), so a
// lapsed comparison stayed "complete" forever and nobody heard it lapse.

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
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function request(id: string, state: string, expiresAt: number | null, customerId: string | null = "cus_1") {
  await ctx.db.insert(schema.distQuoteRequests).values({
    id,
    tenantId: "t_1",
    customerId,
    channelId: "ch_1",
    productId: "prd_motor",
    inputsJson: "{}",
    currency: "AED",
    state,
    expiresAt,
    createdAt: NOW - 10 * 86_400_000,
    updatedAt: NOW - 10 * 86_400_000
  });
}

describe("expireQuoteRequests", () => {
  it("expires every lapsed live request once and announces each", async () => {
    await request("qr_open", "open", NOW - 1);
    await request("qr_done", "complete", NOW - 1, null);
    await request("qr_future", "complete", NOW + 1);
    await request("qr_bought", "converted", NOW - 1);
    await request("qr_never", "complete", null);

    expect(await expireQuoteRequests(ctx)).toBe(2);
    expect(await expireQuoteRequests(ctx)).toBe(0);

    const states = Object.fromEntries((await ctx.db.select().from(schema.distQuoteRequests)).map((r) => [r.id, r.state]));
    expect(states).toEqual({ qr_open: "expired", qr_done: "expired", qr_future: "complete", qr_bought: "converted", qr_never: "complete" });
    const events = (await ctx.db.select().from(schema.eventOutbox)).map((e) => JSON.parse(e.envelopeJson));
    expect(events.map((e) => [e.type, e.data]).sort((a, b) => a[1].quoteRequestId.localeCompare(b[1].quoteRequestId))).toEqual([
      ["dist.quote.expired", { quoteRequestId: "qr_done", customerId: null, productId: "prd_motor" }],
      ["dist.quote.expired", { quoteRequestId: "qr_open", customerId: "cus_1", productId: "prd_motor" }]
    ]);
  });
});

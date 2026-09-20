import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { requestPartnerQuote } from "./orbit-partner-quotes.js";
import { bindPartner } from "./partner-bind.js";
import { seedTestChart } from "@lyra/ledger/test-chart";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

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

function actor(): Actor {
  return {
    kind: "user",
    id: "amina",
    tenantId: "t_1",
    grants: [{ roleKey: "orbit.partners", permissions: permissionsForRole("orbit.partners") }]
  };
}

async function makeCtx(now = 1_770_000_000_000): Promise<Ctx> {
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
  return ctx;
}

async function seedPartner(id: string, patch: Partial<typeof schema.orbitPartners.$inferInsert> = {}) {
  await ctx.db.insert(schema.orbitPartners).values({
    id,
    tenantId: ctx.tenantId,
    name: "Acme Telco",
    kind: "telco",
    revshareJson: JSON.stringify({ pct: 10 }),
    sandboxFlag: true,
    status: "active",
    stage: "sandbox",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...patch
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

async function txnsFor(partnerId: string) {
  return ctx.db
    .select()
    .from(schema.orbitPartnerTxns)
    .where(and(eq(schema.orbitPartnerTxns.tenantId, ctx.tenantId), eq(schema.orbitPartnerTxns.partnerId, partnerId)));
}

describe("bindPartner", () => {
  it("chains PARTNER-BIND and RSHARE-ACCR under one parentTxnId when revshare is non-zero", async () => {
    await seedPartner("prt_1");
    const quote = await requestPartnerQuote(ctx, "prt_1", {
      productLine: "motor",
      amountMinor: 100_000,
      currency: "AED"
    });

    const result = await bindPartner(ctx, "prt_1", quote.id);

    expect(result.shareTxnId).not.toBeNull();
    expect(result.grossMinor).toBe(quote.quotedPremiumMinor);
    expect(result.shareMinor).toBeGreaterThan(0);

    const bindTxn = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, result.bindTxnId));
    const shareTxn = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, result.shareTxnId!));
    expect(bindTxn[0]!.type).toBe("PARTNER-BIND");
    expect(shareTxn[0]!.type).toBe("RSHARE-ACCR");
    expect(shareTxn[0]!.parentTxnId).toBe(result.bindTxnId);
    expect(bindTxn[0]!.parentTxnId).toBeNull();

    const rows = await txnsFor("prt_1");
    const bindRow = rows.find((r) => r.kind === "bind");
    expect(bindRow).toBeDefined();
    expect(bindRow!.txnRef).toBe(result.bindTxnId);
  });

  it("skips the RSHARE-ACCR leg entirely when the quote has zero revshare", async () => {
    await seedPartner("prt_2", { revshareJson: null });
    const quote = await requestPartnerQuote(ctx, "prt_2", {
      productLine: "motor",
      amountMinor: 100_000,
      currency: "AED"
    });

    const result = await bindPartner(ctx, "prt_2", quote.id);

    expect(result.shareTxnId).toBeNull();
    expect(result.shareMinor).toBe(0);

    const bindTxn = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, result.bindTxnId));
    expect(bindTxn[0]!.type).toBe("PARTNER-BIND");
  });

  it("is idempotent — binding the same quote twice returns the same ledger txns", async () => {
    await seedPartner("prt_3");
    const quote = await requestPartnerQuote(ctx, "prt_3", {
      productLine: "motor",
      amountMinor: 100_000,
      currency: "AED"
    });

    const first = await bindPartner(ctx, "prt_3", quote.id);
    const second = await bindPartner(ctx, "prt_3", quote.id);

    expect(second.bindTxnId).toBe(first.bindTxnId);
    expect(second.shareTxnId).toBe(first.shareTxnId);

    const rows = await txnsFor("prt_3");
    const bindRows = rows.filter((r) => r.kind === "bind");
    expect(bindRows.length).toBe(1);
  });

  it("rejects binding for a suspended partner", async () => {
    await seedPartner("prt_4");
    const quote = await requestPartnerQuote(ctx, "prt_4", {
      productLine: "motor",
      amountMinor: 100_000,
      currency: "AED"
    });
    await ctx.db
      .update(schema.orbitPartners)
      .set({ status: "suspended", suspendedAt: ctx.now, suspendedReason: "billing dispute" })
      .where(eq(schema.orbitPartners.id, "prt_4"));

    await expect(bindPartner(ctx, "prt_4", quote.id)).rejects.toMatchObject({ status: 409 });
  });

  it("rejects an unknown quote id", async () => {
    await seedPartner("prt_5");
    await expect(bindPartner(ctx, "prt_5", "otx_missing")).rejects.toMatchObject({ status: 404 });
  });
});

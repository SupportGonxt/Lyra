import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, TAX_RULEPACK, id, schema } from "@lyra/db";
import { DEFAULT_TAX_CODE, resolveTaxRule, taxPpmOf, taxTreatment } from "./tax.js";
import { quoteCommission } from "./commission.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

// docs/27 F17 / docs/19 §5.3: "Tax is never inferred in code." Before this, the
// `ledger_tax_rules` table had no reader at all and `taxPpm` was a caller-supplied
// number defaulting to zero — so every commission accrual in the system posted
// nothing to 2200 unless somebody happened to pass a rate. These tests hold the
// two halves of the contract: the rulepack is what states a rate, and a tenant
// with nothing on file is refused rather than silently taxed at zero.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const NOW = 1_700_000_000_000;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const actor: Actor = {
  kind: "user",
  id: "u_1",
  tenantId: "t_1",
  grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
};

let client: Client;
let ctx: Ctx;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor,
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

/** The market rulepack as a tenant receives it at provisioning time. */
async function installRulepack(market = "AE"): Promise<void> {
  const rows = TAX_RULEPACK.filter((r) => r.market === market).map((r, i) => ({
    id: id("tax", NOW + i),
    tenantId: "t_1",
    market: r.market,
    code: r.code,
    ratePpm: r.ratePpm,
    placeOfSupply: r.placeOfSupply ?? null,
    reverseCharge: r.reverseCharge ?? false,
    exempt: r.exempt ?? false,
    effectiveFrom: 0,
    effectiveTo: null
  }));
  await ctx.db.insert(schema.ledgerTaxRules).values(rows);
}

describe("tax treatment comes from the rulepack", () => {
  it("resolves the rule in force for the tenant's market", async () => {
    await installRulepack();
    const t = await taxTreatment(ctx, {});
    expect(t.market).toBe("AE");
    expect(t.code).toBe(DEFAULT_TAX_CODE);
    expect(taxPpmOf(t)).toBe(50_000); // 5% UAE VAT
  });

  it("refuses rather than inferring zero when the tenant has no rulepack", async () => {
    await expect(taxTreatment(ctx, {})).rejects.toThrowError(
      expect.objectContaining({ detail: expect.stringMatching(/tax is never inferred/i) })
    );
  });

  it("returns null rather than throwing when the caller only wants to look", async () => {
    expect(await resolveTaxRule(ctx, {})).toBeNull();
  });

  it("an exempt rule taxes at zero — stated, not assumed", async () => {
    await ctx.db.insert(schema.ledgerTaxRules).values({
      id: id("tax", NOW),
      tenantId: "t_1",
      market: "AE",
      code: DEFAULT_TAX_CODE,
      ratePpm: 50_000,
      exempt: true,
      reverseCharge: false,
      effectiveFrom: 0
    });
    const t = await taxTreatment(ctx, {});
    expect(t.exempt).toBe(true);
    expect(taxPpmOf(t)).toBe(0);
  });

  it("a reverse-charge rule taxes at zero on our side", async () => {
    await ctx.db.insert(schema.ledgerTaxRules).values({
      id: id("tax", NOW),
      tenantId: "t_1",
      market: "AE",
      code: DEFAULT_TAX_CODE,
      ratePpm: 50_000,
      exempt: false,
      reverseCharge: true,
      effectiveFrom: 0
    });
    expect(taxPpmOf(await taxTreatment(ctx, {}))).toBe(0);
  });

  it("re-derives the rate that applied on the sale date, not today's", async () => {
    await ctx.db.insert(schema.ledgerTaxRules).values([
      {
        id: id("tax", NOW),
        tenantId: "t_1",
        market: "AE",
        code: DEFAULT_TAX_CODE,
        ratePpm: 0,
        exempt: false,
        reverseCharge: false,
        effectiveFrom: 0,
        effectiveTo: NOW - 1_000
      },
      {
        id: id("tax", NOW + 1),
        tenantId: "t_1",
        market: "AE",
        code: DEFAULT_TAX_CODE,
        ratePpm: 50_000,
        exempt: false,
        reverseCharge: false,
        effectiveFrom: NOW - 1_000
      }
    ]);
    expect(taxPpmOf(await taxTreatment(ctx, { at: NOW - 5_000 }))).toBe(0);
    expect(taxPpmOf(await taxTreatment(ctx, {}))).toBe(50_000);
  });
});

/* ---------------------------------------------- the commission split reads it */

async function seedPanel(): Promise<{ offering: string; channel: string }> {
  const provider = id("prv", NOW);
  const product = id("prd", NOW);
  const offering = id("off", NOW);
  const channel = id("chn", NOW);
  await ctx.db.insert(schema.products).values({
    id: product,
    tenantId: "t_1",
    line: "motor",
    nameJson: JSON.stringify({ en: "Motor comprehensive" }),
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.providers).values({
    id: provider,
    tenantId: "t_1",
    name: "Falcon Insurance",
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.distOfferings).values({
    id: offering,
    tenantId: "t_1",
    productId: product,
    providerId: provider,
    code: "FAL-MOT-COMP",
    nameJson: JSON.stringify({ en: "Falcon Motor Comprehensive" }),
    currency: "AED",
    baseCommissionPpm: 150_000,
    effectiveFrom: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.distChannels).values({
    id: channel,
    tenantId: "t_1",
    key: "b2c-tax",
    kind: "b2c",
    nameJson: JSON.stringify({ en: "Direct" }),
    createdAt: NOW,
    updatedAt: NOW
  });
  return { offering, channel };
}

describe("quoteCommission stops defaulting tax to zero", () => {
  it("taxes the net commission at the rulepack's rate", async () => {
    await installRulepack();
    const p = await seedPanel();
    const s = await quoteCommission(ctx, {
      offeringId: p.offering,
      channelId: p.channel,
      premiumMinor: 100_000
    });
    // 15% of 100_000 = 15_000 gross, no channel share, 5% VAT on the net.
    expect(s.grossMinor).toBe(15_000);
    expect(s.taxMinor).toBe(750);
    expect(s.netMinor).toBe(14_250);
    expect(s.taxRuleId).not.toBeNull();
  });

  it("refuses a sale when no tax rule covers it", async () => {
    const p = await seedPanel();
    await expect(
      quoteCommission(ctx, { offeringId: p.offering, channelId: p.channel, premiumMinor: 100_000 })
    ).rejects.toThrowError(expect.objectContaining({ detail: expect.stringMatching(/tax is never inferred/i) }));
  });

  it("still honours an explicitly stated rate — a caller may state, never omit", async () => {
    const p = await seedPanel();
    const s = await quoteCommission(ctx, {
      offeringId: p.offering,
      channelId: p.channel,
      premiumMinor: 100_000,
      taxPpm: 0
    });
    expect(s.taxMinor).toBe(0);
    expect(s.taxRuleId).toBeNull();
  });
});

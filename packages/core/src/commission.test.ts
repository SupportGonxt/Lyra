import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, TAX_RULEPACK, id, schema } from "@lyra/db";
import {
  applyPpm,
  commissionStructureOf,
  quoteCommission,
  resolveRate,
  splitCommission,
  tieredCommissionMinor,
  volumeBonusMinor
} from "./commission.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

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

describe("splitCommission", () => {
  it("splits premium three ways and keeps the remainder exact", () => {
    // AED 1,234.56 premium, 15% commission to us, 40% of that to the b2b channel, 5% VAT on our net.
    const s = splitCommission({
      premiumMinor: 123_456,
      baseCommissionPpm: 150_000,
      channelSharePpm: 400_000,
      taxPpm: 50_000
    });
    expect(s.grossMinor).toBe(18_518); // 123456 * 0.15 = 18518.4 -> half-up on .4 rounds down
    expect(s.channelMinor).toBe(7_407);
    expect(s.taxMinor).toBe(556);
    expect(s.channelMinor + s.taxMinor + s.netMinor).toBe(s.grossMinor);
  });

  it("keeps the whole commission on a b2c sale", () => {
    const s = splitCommission({ premiumMinor: 100_000, baseCommissionPpm: 125_000 });
    expect(s).toEqual({
      grossMinor: 12_500,
      channelMinor: 0,
      taxMinor: 0,
      netMinor: 12_500,
      bonusMinor: 0,
      overrideMinor: 0
    });
  });

  it("refuses to pay a channel more than the underwriter pays us", () => {
    expect(() =>
      splitCommission({
        premiumMinor: 100_000,
        baseCommissionPpm: 100_000,
        channelSharePpm: PPM_FULL,
        flatFeeMinor: 1
      })
    ).toThrowError(expect.objectContaining({ detail: expect.stringContaining("exceeds") }));
  });

  it("rounds half up, symmetrically for refunds", () => {
    expect(applyPpm(5, 500_000)).toBe(3); // 2.5 -> 3
    expect(applyPpm(-5, 500_000)).toBe(-3);
  });
});

describe("tieredCommissionMinor", () => {
  it("applies 10% on the first 100k and 12% above it", () => {
    // ADR-0084. 150,000 premium: 100,000 at 10% + 50,000 at 12%.
    const out = tieredCommissionMinor(150_000, [
      { uptoMinor: 100_000, ratePpm: 100_000 },
      { ratePpm: 120_000 }
    ]);
    expect(out).toBe(10_000 + 6_000);
  });

  it("charges the flat top rate when the amount never reaches the first band", () => {
    const out = tieredCommissionMinor(50_000, [
      { uptoMinor: 100_000, ratePpm: 100_000 },
      { ratePpm: 120_000 }
    ]);
    expect(out).toBe(5_000);
  });

  it("refuses a ladder whose last tier is capped, since it cannot cover an amount past it", () => {
    expect(() => tieredCommissionMinor(150_000, [{ uptoMinor: 100_000, ratePpm: 100_000 }])).toThrowError(
      expect.objectContaining({ detail: expect.stringContaining("open-ended") })
    );
  });

  it("refuses an empty ladder", () => {
    expect(() => tieredCommissionMinor(1, [])).toThrowError(expect.objectContaining({ detail: expect.stringContaining("empty") }));
  });
});

describe("volumeBonusMinor", () => {
  it("pays nothing below the threshold", () => {
    expect(volumeBonusMinor(50_000, { priorVolumeMinor: 0, thresholdMinor: 100_000, bonusPpm: 50_000 })).toBe(0);
  });

  it("pays the bonus only on the slice of this sale above the threshold", () => {
    // 80k prior + 50k this sale = 130k cumulative, 30k of it over the 100k line.
    const bonus = volumeBonusMinor(50_000, { priorVolumeMinor: 80_000, thresholdMinor: 100_000, bonusPpm: 50_000 });
    expect(bonus).toBe(1_500); // 5% of 30,000
  });

  it("pays the bonus on the full sale once already over the threshold", () => {
    const bonus = volumeBonusMinor(20_000, { priorVolumeMinor: 150_000, thresholdMinor: 100_000, bonusPpm: 50_000 });
    expect(bonus).toBe(1_000); // 5% of the full 20,000
  });
});

describe("splitCommission with tiers, a volume bonus and an override", () => {
  it("uses the ladder instead of the flat rate when tiers are given", () => {
    const s = splitCommission({
      premiumMinor: 150_000,
      baseCommissionPpm: 999_999, // must be ignored: tiers win
      tiers: [
        { uptoMinor: 100_000, ratePpm: 100_000 },
        { ratePpm: 120_000 }
      ]
    });
    expect(s.grossMinor).toBe(16_000);
    expect(s.bonusMinor).toBe(0);
  });

  it("adds the volume bonus on top of the base gross, before the channel share", () => {
    const s = splitCommission({
      premiumMinor: 50_000,
      baseCommissionPpm: 100_000, // 5,000
      channelSharePpm: 400_000,
      volumeBonus: { priorVolumeMinor: 80_000, thresholdMinor: 100_000, bonusPpm: 50_000 }
    });
    // bonus: 30k over the line at 5% = 1,500. gross = 5,000 + 1,500 = 6,500.
    expect(s.bonusMinor).toBe(1_500);
    expect(s.grossMinor).toBe(6_500);
    expect(s.channelMinor).toBe(2_600); // 40% of 6,500
    expect(s.netMinor).toBe(3_900);
  });

  it("reports an override on top of gross without touching net", () => {
    const s = splitCommission({
      premiumMinor: 100_000,
      baseCommissionPpm: 150_000,
      override: { overridePpm: 200_000 }
    });
    expect(s.grossMinor).toBe(15_000);
    expect(s.overrideMinor).toBe(3_000); // 20% of gross
    expect(s.netMinor).toBe(15_000); // override does not reduce what the split already accounts for
  });
});

describe("commissionStructureOf", () => {
  it("is flat ({}) for a null or malformed structure", () => {
    expect(commissionStructureOf(null)).toEqual({});
    expect(commissionStructureOf("not json")).toEqual({});
  });

  it("parses a stored ladder", () => {
    const json = JSON.stringify({ tiers: [{ ratePpm: 100_000 }], overridePpm: 50_000 });
    expect(commissionStructureOf(json)).toEqual({ tiers: [{ ratePpm: 100_000 }], overridePpm: 50_000 });
  });
});

const PPM_FULL = 1_000_000;

async function seedPanel() {
  // docs/27 F17: quoteCommission now resolves tax from the market rulepack and
  // refuses a supply it has no rule for, so a panel without one is not a panel
  // anybody could sell through.
  await ctx.db.insert(schema.ledgerTaxRules).values(
    TAX_RULEPACK.filter((r) => r.market === "AE").map((r, i) => ({
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
    }))
  );
  const rows = {
    product: id("prd", NOW),
    provider: id("prv", NOW),
    offering: id("off", NOW),
    b2b: id("chn", NOW),
    b2c: id("chn", NOW + 1)
  };
  await ctx.db.insert(schema.products).values({
    id: rows.product,
    tenantId: "t_1",
    line: "motor",
    nameJson: JSON.stringify({ en: "Motor comprehensive" }),
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.providers).values({
    id: rows.provider,
    tenantId: "t_1",
    name: "Falcon Insurance",
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.distOfferings).values({
    id: rows.offering,
    tenantId: "t_1",
    productId: rows.product,
    providerId: rows.provider,
    code: "FAL-MOT-COMP",
    nameJson: JSON.stringify({ en: "Falcon Motor Comprehensive" }),
    currency: "AED",
    baseCommissionPpm: 150_000,
    effectiveFrom: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
  for (const [idValue, kind, share] of [
    [rows.b2b, "b2b", 300_000],
    [rows.b2c, "b2c", null]
  ] as const) {
    await ctx.db.insert(schema.distChannels).values({
      id: idValue,
      tenantId: "t_1",
      key: `${kind}-${idValue.slice(-4)}`,
      kind,
      nameJson: JSON.stringify({ en: kind }),
      defaultCommissionPpm: share,
      createdAt: NOW,
      updatedAt: NOW
    });
  }
  return rows;
}

describe("rate resolution", () => {
  it("prefers the offering override, then the product rate, then the channel default", async () => {
    const p = await seedPanel();
    await ctx.db.insert(schema.distCommissionRates).values([
      {
        id: id("rte", NOW),
        tenantId: "t_1",
        channelId: p.b2b,
        productId: p.product,
        channelSharePpm: 350_000,
        effectiveFrom: NOW - 1000,
        createdBy: "user:u_1",
        createdAt: NOW
      },
      {
        id: id("rte", NOW + 1),
        tenantId: "t_1",
        channelId: p.b2b,
        offeringId: p.offering,
        channelSharePpm: 450_000,
        baseCommissionPpm: 175_000,
        effectiveFrom: NOW - 1000,
        createdBy: "user:u_1",
        createdAt: NOW
      }
    ]);

    const winner = await resolveRate(ctx, {
      channelId: p.b2b,
      offeringId: p.offering,
      productId: p.product
    });
    expect(winner?.channelSharePpm).toBe(450_000);

    // A different offering of the same product falls back to the product rate.
    const fallback = await resolveRate(ctx, {
      channelId: p.b2b,
      offeringId: "off_other",
      productId: p.product
    });
    expect(fallback?.channelSharePpm).toBe(350_000);
  });

  it("re-derives the rate that applied on the sale date, not today's", async () => {
    const p = await seedPanel();
    await ctx.db.insert(schema.distCommissionRates).values([
      {
        id: id("rte", NOW),
        tenantId: "t_1",
        channelId: p.b2b,
        offeringId: p.offering,
        channelSharePpm: 200_000,
        effectiveFrom: NOW - 10_000,
        effectiveTo: NOW - 1_000,
        createdBy: "user:u_1",
        createdAt: NOW
      },
      {
        id: id("rte", NOW + 1),
        tenantId: "t_1",
        channelId: p.b2b,
        offeringId: p.offering,
        channelSharePpm: 500_000,
        effectiveFrom: NOW - 1_000,
        createdBy: "user:u_1",
        createdAt: NOW
      }
    ]);

    const old = await quoteCommission(ctx, {
      offeringId: p.offering,
      channelId: p.b2b,
      premiumMinor: 100_000,
      at: NOW - 5_000
    });
    expect(old.sharePpm).toBe(200_000);
    expect(old.channelMinor).toBe(3_000);

    const current = await quoteCommission(ctx, {
      offeringId: p.offering,
      channelId: p.b2b,
      premiumMinor: 100_000
    });
    expect(current.sharePpm).toBe(500_000);
    // Net of the rulepack's 5% VAT on our share (F17): 7_500 gross share - 375.
    expect(current.netMinor).toBe(7_125);
  });

  it("resolves a tiered rate and an override stamped on the winning rate row", async () => {
    const p = await seedPanel();
    await ctx.db.insert(schema.distCommissionRates).values([
      {
        id: id("rte", NOW),
        tenantId: "t_1",
        channelId: p.b2b,
        offeringId: p.offering,
        channelSharePpm: 300_000,
        structureJson: JSON.stringify({
          tiers: [
            { uptoMinor: 100_000, ratePpm: 100_000 },
            { ratePpm: 120_000 }
          ],
          overridePpm: 50_000
        }),
        effectiveFrom: NOW - 1000,
        createdBy: "user:u_1",
        createdAt: NOW
      }
    ]);

    const out = await quoteCommission(ctx, {
      offeringId: p.offering,
      channelId: p.b2b,
      premiumMinor: 150_000
    });
    // 100k @ 10% + 50k @ 12% = 16,000 gross, before the rulepack's 5% VAT on our net.
    expect(out.grossMinor).toBe(16_000);
    expect(out.overrideMinor).toBe(800); // 5% of gross
  });

  it("pays no channel share on a b2c sale even if the channel carries a default", async () => {
    const p = await seedPanel();
    const s = await quoteCommission({ ...ctx }, {
      offeringId: p.offering,
      channelId: p.b2c,
      premiumMinor: 100_000
    });
    expect(s.channelMinor).toBe(0);
    expect(s.netMinor).toBe(14_250); // 15_000 less the rulepack's 5% VAT (F17)
  });
});

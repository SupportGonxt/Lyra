import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx } from "@lyra/core";
import { channelPortalView, supplierPortalView } from "./party-portals.js";

// docs: PORTALS-DESIGN-AND-AUDIT.md. The two external doors assemble their views
// here, and the two rules the assembly exists to hold are what this file pins:
// the k-anonymity floor (a row below it is absent, never zeroed) and the wall
// between the two sides of a sale (a channel sees its own share only).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T08:00:00Z");
// A tenant that raised its own floor: an empty policy would use the default (50)
// and serve the 5-volume row below it. Scheduled-config supplies the real one.
const RAISED_FLOOR = 20;

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function makeCtx(policy: Record<string, unknown> = {}): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "portal", tenantId: "t_1", grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse(policy),
    entitlements: EntitlementsJson.parse({})
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = makeCtx({ moduleConfig: { scout: { settings: { kAnonymityFloor: RAISED_FLOOR } } } });
});

async function seedSupplier(): Promise<void> {
  await ctx.db.insert(schema.providers).values([
    { id: "prv_cedar", tenantId: "t_1", name: "Cedar Insurance", kind: "insurer", linesJson: JSON.stringify(["motor", "home"]), currency: "AED", panelStatus: "active", settlementTermsJson: JSON.stringify({ frequency: "monthly" }), createdAt: NOW, updatedAt: NOW },
    { id: "prv_other", tenantId: "t_1", name: "Other", kind: "insurer", currency: "AED", panelStatus: "active", createdAt: NOW, updatedAt: NOW }
  ]);
  await ctx.db.insert(schema.scoutPanelBench).values([
    // Above the raised floor: served. Below it: absent, never zeroed.
    // The seed's booleans shape, as a database written before ADR-0127 holds
    // it: the reader normalises it through `coverageOf`, not by shape-guessing.
    { id: "pnb_1", tenantId: "t_1", providerId: "prv_cedar", line: "motor", period: "2026-09", ourPriceIdx: 10_400, marketPriceIdx: 10_000, winRate: 31, volume: 120, coverageGapsJson: JSON.stringify([{ term: "roadside", ours: false, panelMedian: true }]), updatedAt: NOW },
    { id: "pnb_2", tenantId: "t_1", providerId: "prv_cedar", line: "home", period: "2026-09", ourPriceIdx: 9_800, marketPriceIdx: 10_000, winRate: 44, volume: 5, updatedAt: NOW },
    // Another provider's row must never appear.
    { id: "pnb_3", tenantId: "t_1", providerId: "prv_other", line: "motor", period: "2026-09", winRate: 99, volume: 500, updatedAt: NOW }
  ]);
  await ctx.db.insert(schema.scoutDataProducts).values([
    { id: "dtp_1", tenantId: "t_1", name: "Motor demand curves", definitionJson: "{}", consentBasis: "legitimate_interest", aggregationMin: 50, subscribersJson: JSON.stringify([{ providerId: "prv_cedar", since: NOW }]), delivery: "report", status: "published", createdAt: NOW, updatedAt: NOW },
    { id: "dtp_2", tenantId: "t_1", name: "Unsubscribed pack", definitionJson: "{}", consentBasis: "consent", aggregationMin: 50, subscribersJson: JSON.stringify([{ providerId: "prv_other", since: NOW }]), delivery: "api", status: "published", createdAt: NOW, updatedAt: NOW },
    { id: "dtp_3", tenantId: "t_1", name: "Draft pack", definitionJson: "{}", consentBasis: "consent", aggregationMin: 50, subscribersJson: JSON.stringify([{ providerId: "prv_cedar", since: NOW }]), delivery: "api", status: "draft", createdAt: NOW, updatedAt: NOW }
  ]);
  await ctx.db.insert(schema.ledgerSettlements).values([
    { id: "stl_1", tenantId: "t_1", counterpartyKind: "insurer", counterpartyRef: "provider:prv_cedar", period: "2026-09", grossMinor: 500_000, adjustmentsMinor: -20_000, netMinor: 480_000, currency: "AED", state: "approved", externalRef: null, createdAt: NOW, updatedAt: NOW }
  ]);
}

async function seedChannel(): Promise<void> {
  await ctx.db.insert(schema.distChannels).values({
    id: "chn_alpha",
    tenantId: "t_1",
    key: "alpha-brokers",
    kind: "b2b",
    nameJson: JSON.stringify({ en: "Alpha Brokers", ar: "ألفا" }),
    partnerId: "prt_1",
    medium: "portal",
    collectsPayment: "us",
    defaultCommissionPpm: 250_000,
    currency: "AED",
    status: "active",
    settlementTermsJson: JSON.stringify({ frequency: "monthly" }),
    createdAt: NOW,
    updatedAt: NOW
  });
  await ctx.db.insert(schema.distCommissionEntries).values([
    { id: "ce_1", tenantId: "t_1", policyId: "pol_1", offeringId: "off_1", providerId: "prv_cedar", channelId: "chn_alpha", kind: "new_business", premiumMinor: 100_000, grossCommissionMinor: 20_000, channelCommissionMinor: 12_000, netCommissionMinor: 8_000, currency: "AED", earnedOn: "issue", earnedAt: NOW, state: "accrued", createdAt: NOW, updatedAt: NOW },
    { id: "ce_2", tenantId: "t_1", policyId: "pol_2", offeringId: "off_1", providerId: "prv_cedar", channelId: "chn_alpha", kind: "renewal", premiumMinor: 50_000, grossCommissionMinor: 10_000, channelCommissionMinor: 6_000, netCommissionMinor: 4_000, currency: "AED", earnedOn: "issue", earnedAt: NOW, state: "paid", createdAt: NOW, updatedAt: NOW }
  ]);
  await ctx.db.insert(schema.ledgerSettlements).values([
    { id: "stl_c1", tenantId: "t_1", counterpartyKind: "partner", counterpartyRef: "channel:chn_alpha", period: "2026-09", grossMinor: 18_000, adjustmentsMinor: 0, netMinor: 18_000, currency: "AED", state: "approved", externalRef: null, createdAt: NOW, updatedAt: NOW }
  ]);
  await ctx.db.insert(schema.distPartnerAgreements).values({
    id: "pag_1",
    tenantId: "t_1",
    partnerId: "prt_1",
    version: 2,
    kind: "distribution",
    termsJson: "{}",
    state: "active",
    effectiveFrom: NOW - 86_400_000,
    createdBy: "u_1",
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("supplierPortalView", () => {
  it("serves the provider's own position, dropping rows below the tenant's raised floor", async () => {
    await seedSupplier();
    const view = await supplierPortalView(ctx, "prv_cedar");

    expect(view.supplier.name).toBe("Cedar Insurance");
    expect(view.supplier.lines).toEqual(["motor", "home"]);
    expect(view.kAnonymityFloor).toBe(RAISED_FLOOR);
    // The 5-volume home row is below the raised floor (20) and is absent.
    expect(view.position.map((p) => p.line)).toEqual(["motor"]);
    expect(view.position[0]).toMatchObject({ winRate: 31, volume: 120 });
    expect(view.position[0]!.coverage).toEqual({
      kind: "terms",
      terms: [{ term: "roadside", ours: { present: false }, panelMedian: { present: true } }]
    });
  });

  // The bug this reader shipped with: `parseArray` kept only strings, and
  // neither shape the column holds is one — so both read as `[]` and the page
  // said "None" for every carrier. Each shape now arrives as its own fact.
  it("carries the Bench Builder's reach counts as a fact, not as an empty list", async () => {
    await seedSupplier();
    await ctx.db
      .update(schema.scoutPanelBench)
      .set({ coverageGapsJson: JSON.stringify({ unquotedRequests: 41, declined: 6 }) })
      .where(eq(schema.scoutPanelBench.id, "pnb_1"));

    const view = await supplierPortalView(ctx, "prv_cedar");
    expect(view.position[0]!.coverage).toEqual({ kind: "reach", unquotedRequests: 41, declined: 6 });
  });

  it("lists only published products this provider subscribes to", async () => {
    await seedSupplier();
    const view = await supplierPortalView(ctx, "prv_cedar");
    expect(view.products.map((p) => p.id)).toEqual(["dtp_1"]);
  });

  it("shows the settlement between the tenant and this provider only", async () => {
    await seedSupplier();
    const view = await supplierPortalView(ctx, "prv_cedar");
    expect(view.settlement.currency).toBe("AED");
    expect(view.settlement.receivableMinor).toBe(480_000);
    expect(view.settlement.batches.map((b) => b.id)).toEqual(["stl_1"]);
    // Stated, not implied.
    expect(view.ranking).toEqual({ declared: true, payForPosition: false });
  });

  it("404s an unknown provider", async () => {
    await seedSupplier();
    await expect(supplierPortalView(ctx, "prv_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("channelPortalView", () => {
  it("totals the channel's own share and never the tenant's margin", async () => {
    await seedChannel();
    const view = await channelPortalView(ctx, "chn_alpha");

    expect(view.channel.name).toEqual({ en: "Alpha Brokers", ar: "ألفا" });
    expect(view.totals).toMatchObject({ entries: 2, grossMinor: 150_000, yourShareMinor: 18_000, currency: "AED" });
    // The channel's share only — `net` (8k+4k) and `gross` (20k+10k) are absent.
    expect(JSON.stringify(view)).not.toContain("netCommissionMinor");
    expect(view.money.accrued).toBe(12_000);
    expect(view.money.paid).toBe(6_000);
  });

  it("lists the book, the settlements and the agreement behind the channel", async () => {
    await seedChannel();
    const view = await channelPortalView(ctx, "chn_alpha");
    expect(view.book.map((b) => b.id)).toEqual(["ce_2", "ce_1"]); // most recent first
    expect(view.settlements.map((s) => s.id)).toEqual(["stl_c1"]);
    expect(view.agreement).toMatchObject({ kind: "distribution", version: 2, state: "active" });
  });

  it("404s an unknown channel", async () => {
    await seedChannel();
    await expect(channelPortalView(ctx, "chn_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

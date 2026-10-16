import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { sealFields, type AdCreativePush, type AdPlatform, type Ctx } from "@lyra/core";
import { publishCreative } from "./signal-publish.js";

// docs/modules/signal.md §2.1, §4.2, §8 clause 1. The publisher is where the
// module stops being able to describe work and starts being able to do it, so
// what it refuses matters as much as what it sends:
//  - a creative the pre-flight has not passed is never placed (the guardrail is
//    not advisory);
//  - a platform that already has it is skipped, because the object is real and
//    a second one would bill behind the same row;
//  - one platform's refusal is that platform's outcome, not a failed push.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-encryption-secret";
const NOW = Date.parse("2026-09-27T08:00:00Z");
const TENANT = "t_1";

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

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "system", id: "publisher", tenantId: TENANT, grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };

  await ctx.db.insert(schema.signalCampaigns).values({
    id: "cmp_1",
    tenantId: TENANT,
    name: "Motor Q4",
    objective: "acq",
    channelsJson: JSON.stringify(["meta"]),
    budgetJson: JSON.stringify({}),
    state: "live",
    autonomyLevel: "act",
    ownerRef: "user:1",
    createdAt: NOW,
    updatedAt: NOW
  });
});

async function creative(id: string, over: Partial<{ complianceStatus: string; contentRef: string; locale: string; campaignId: string | null }> = {}) {
  await ctx.db.insert(schema.signalCreatives).values({
    id,
    tenantId: TENANT,
    campaignId: over.campaignId === undefined ? "cmp_1" : over.campaignId,
    kind: "ad_copy",
    locale: over.locale ?? "en",
    contentRef: over.contentRef ?? `Cover your car\nCompare nine UAE insurers.`,
    variantGroup: "vg_1",
    complianceStatus: over.complianceStatus ?? "passed",
    generatedBy: "ai",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function connector(id: string, provider: string, config: Record<string, unknown> = { adAccountId: "act_42", pageId: "111", adsetId: "222", landingUrl: "https://nxt.example/quote" }) {
  await ctx.db.insert(schema.orbitChannelConnectors).values({
    id,
    tenantId: TENANT,
    provider,
    transport: "ads",
    label: id,
    secretsJson: JSON.stringify(await sealFields(FIELD_KEY, { accessToken: `tok-${id}` }, ["accessToken"])),
    configJson: JSON.stringify(config),
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });
}

/** A platform that records what it was asked to do and answers as told. */
function fakePlatform(provider: string, reply: { status: "published" | "failed"; externalId?: string; error?: string } | (() => never)) {
  const pushes: AdCreativePush[] = [];
  const platform: AdPlatform & { pushes: AdCreativePush[] } = {
    provider,
    defaultChannel: provider,
    pushes,
    async pullSpend() {
      return [];
    },
    async adjustDailyBudget() {
      return { beforeMinor: 1, afterMinor: 1 };
    },
    async publishCreative(push) {
      pushes.push(push);
      // A function stands in for an adapter that throws; returning it satisfies
      // the seam because it returns `never`, and narrows `reply` for the rest.
      if (typeof reply === "function") return reply();
      // `exactOptionalPropertyTypes` is on: an absent id is an absent key, not
      // a key holding undefined.
      return reply.status === "published"
        ? { status: "published" as const, ...(reply.externalId !== undefined ? { externalId: reply.externalId } : {}) }
        : { status: "failed" as const, ...(reply.error !== undefined ? { error: reply.error } : {}) };
    }
  };
  return platform;
}

const env = { FIELD_KEY };

describe("publishCreative", () => {
  it("refuses a creative the pre-flight has not passed, and places nothing", async () => {
    await creative("scr_flagged", { complianceStatus: "flagged" });
    await connector("con_meta", "meta-ads");
    const platform = fakePlatform("meta-ads", { status: "published", externalId: "ad_1" });

    await expect(publishCreative(ctx, env, { creativeId: "scr_flagged" }, { "meta-ads": platform })).rejects.toMatchObject({
      code: "bad_request"
    });
    expect(platform.pushes).toHaveLength(0);
    const placements = await ctx.db.select().from(schema.signalCreativePublishes);
    expect(placements).toHaveLength(0);
  });

  it("places a passed creative and records where it landed", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    const platform = fakePlatform("meta-ads", { status: "published", externalId: "ad_9" });

    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": platform });

    expect(result.outcomes).toEqual([{ provider: "meta-ads", status: "published", externalId: "ad_9", reason: null }]);
    const [placement] = await ctx.db
      .select()
      .from(schema.signalCreativePublishes)
      .where(eq(schema.signalCreativePublishes.creativeId, "scr_1"));
    expect(placement).toMatchObject({ provider: "meta-ads", externalId: "ad_9", status: "published", error: null });
  });

  it("hands the adapter the campaign's other cleared variants as a pool", async () => {
    await creative("scr_1");
    await creative("scr_2", { contentRef: "Motor cover, nine insurers\nA price you can check." });
    // A variant that has not cleared is not pool material.
    await creative("scr_3", { contentRef: "Unreviewed line\nDo not use.", complianceStatus: "pending" });
    // Neither is one in the other language.
    await creative("scr_4", { contentRef: "تغطية سيارتك\nقارن تسع شركات.", locale: "ar" });
    await connector("con_google", "google-ads");
    const platform = fakePlatform("google-ads", { status: "published", externalId: "customers/1/adGroupAds/2~3" });

    await publishCreative(ctx, env, { creativeId: "scr_1" }, { "google-ads": platform });

    const push = platform.pushes[0]!;
    expect(push.headline).toBe("Cover your car");
    expect(push.body).toBe("Compare nine UAE insurers.");
    expect(push.landingUrl).toBe("https://nxt.example/quote");
    expect(push.externalCampaignId).toBeNull();
    expect(push.pool.headlines).toEqual(["Motor cover, nine insurers"]);
    expect(push.pool.descriptions).toEqual(["A price you can check."]);
  });

  it("skips a platform that already has it rather than buying a second ad", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    const first = fakePlatform("meta-ads", { status: "published", externalId: "ad_9" });
    await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": first });

    const second = fakePlatform("meta-ads", { status: "published", externalId: "ad_10" });
    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": second });

    expect(result.outcomes).toEqual([{ provider: "meta-ads", status: "skipped", externalId: "ad_9", reason: "already placed" }]);
    expect(second.pushes).toHaveLength(0);
    const placements = await ctx.db.select().from(schema.signalCreativePublishes);
    expect(placements).toHaveLength(1);
  });

  it("retries a placement that failed, because that is why the failure was recorded", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": fakePlatform("meta-ads", { status: "failed", error: "rate limited" }) });

    const [after] = await ctx.db.select().from(schema.signalCreativePublishes);
    expect(after).toMatchObject({ status: "failed", error: "rate limited", externalId: null });

    const retry = fakePlatform("meta-ads", { status: "published", externalId: "ad_11" });
    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": retry });

    expect(result.outcomes[0]!.status).toBe("published");
    const [final] = await ctx.db.select().from(schema.signalCreativePublishes);
    expect(final).toMatchObject({ status: "published", externalId: "ad_11", error: null });
  });

  it("keeps one platform's refusal from taking the others down with it", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    await connector("con_google", "google-ads");
    const meta = fakePlatform("meta-ads", () => {
      throw new Error("meta exploded");
    });
    const google = fakePlatform("google-ads", { status: "published", externalId: "customers/1/adGroupAds/2~3" });

    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": meta, "google-ads": google });

    expect(result.outcomes).toEqual([
      { provider: "meta-ads", status: "failed", externalId: null, reason: "meta exploded" },
      { provider: "google-ads", status: "published", externalId: "customers/1/adGroupAds/2~3", reason: null }
    ]);
    const rows = await ctx.db.select().from(schema.signalCreativePublishes);
    expect(rows.map((r) => [r.provider, r.status]).sort()).toEqual([
      ["google-ads", "published"],
      ["meta-ads", "failed"]
    ]);
  });

  it("skips a connected platform whose adapter has no publish path", async () => {
    await creative("scr_1");
    await connector("con_tiktok", "tiktok-ads");
    const silent: AdPlatform = {
      provider: "tiktok-ads",
      defaultChannel: "tiktok",
      async pullSpend() {
        return [];
      },
      async adjustDailyBudget() {
        return { beforeMinor: 1, afterMinor: 1 };
      }
    };

    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "tiktok-ads": silent });
    expect(result.outcomes).toEqual([{ provider: "tiktok-ads", status: "skipped", externalId: null, reason: "tiktok-ads has no publish path" }]);
  });

  it("publishes nothing when the tenant has no ad connector", async () => {
    await creative("scr_1");
    const result = await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": fakePlatform("meta-ads", { status: "published" }) });
    expect(result.outcomes).toEqual([]);
  });

  it("names the platforms when the caller names them", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    await connector("con_google", "google-ads");
    const meta = fakePlatform("meta-ads", { status: "published", externalId: "ad_1" });
    const google = fakePlatform("google-ads", { status: "published", externalId: "rn_1" });

    const result = await publishCreative(ctx, env, { creativeId: "scr_1", providers: ["google-ads"] }, { "meta-ads": meta, "google-ads": google });
    expect(result.outcomes.map((o) => o.provider)).toEqual(["google-ads"]);
    expect(meta.pushes).toHaveLength(0);
  });

  it("emits the published event once, with the providers that took it", async () => {
    await creative("scr_1");
    await connector("con_meta", "meta-ads");
    await publishCreative(ctx, env, { creativeId: "scr_1" }, { "meta-ads": fakePlatform("meta-ads", { status: "published", externalId: "ad_1" }) });

    const [event] = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, TENANT), eq(schema.eventOutbox.type, "signal.creative.published")));
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.envelopeJson)).toMatchObject({ data: { creativeId: "scr_1", providers: ["meta-ads"] } });
  });
});

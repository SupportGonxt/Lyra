import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { hmacHex, type Ctx } from "@lyra/core";
import { recordSignedConversion, verifyTrackSignature } from "./signal-track.js";

// docs/30 SIGNAL gap 2, ADR-0092. `/track` took anonymous impressions, clicks
// and visits only, so a lead or a sale made on a partner's own site never
// reached a campaign. A conversion is a claim about money, so it must be signed
// — by the same key the tenant already holds for our webhooks, in the same
// scheme we sign deliveries with (dispatch.ts): v1=HMAC(secret, `${ts}.${body}`).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
const SECRET = "whsec_test_secret";
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
    actor: { kind: "system", id: "portal-track", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  const hook = (id: string, tenantId: string, status = "active") => ({ id, tenantId, url: "https://partner.test/hook", eventTypesJson: "[]", secret: SECRET, status, createdAt: NOW });
  await ctx.db.insert(schema.webhooks).values([hook("whk_1", "t_1"), hook("whk_off", "t_1", "disabled"), hook("whk_other", "t_2")]);
  await ctx.db.insert(schema.signalCampaigns).values({
    id: "cmp_1", tenantId: "t_1", name: "Partner", objective: "acq", audienceId: "aud_1", channelsJson: "[]", budgetJson: "{}", ownerRef: "user:1", createdAt: NOW, updatedAt: NOW
  });
  await ctx.db.insert(schema.customers).values({ id: "cus_1", tenantId: "t_1", nameJson: "{}", createdAt: NOW, updatedAt: NOW });
});

const sign = async (raw: string, ts = NOW, secret = SECRET) => `v1=${await hmacHex(secret, `${ts}.${raw}`)}`;

describe("verifyTrackSignature", () => {
  const raw = JSON.stringify({ touchType: "lead" });

  it("accepts the tenant's own active key, signed now", async () => {
    await expect(verifyTrackSignature(ctx, { keyId: "whk_1", timestamp: String(NOW), signature: await sign(raw) }, raw)).resolves.toBeUndefined();
  });

  it.each([
    ["a wrong signature", { keyId: "whk_1", timestamp: String(NOW) }, "v1=deadbeef"],
    ["another body's signature", { keyId: "whk_1", timestamp: String(NOW) }, "other"],
    ["a disabled key", { keyId: "whk_off", timestamp: String(NOW) }, null],
    ["another tenant's key", { keyId: "whk_other", timestamp: String(NOW) }, null],
    ["an unknown key", { keyId: "whk_nope", timestamp: String(NOW) }, null],
    ["a stale timestamp", { keyId: "whk_1", timestamp: String(NOW - 6 * 60_000) }, null],
    ["a future timestamp", { keyId: "whk_1", timestamp: String(NOW + 6 * 60_000) }, null],
    ["no timestamp", { keyId: "whk_1", timestamp: "" }, null]
  ])("refuses %s with 401", async (_why, headers, override) => {
    const signature = override === "other" ? await sign("{}", Number(headers.timestamp)) : (override ?? (await sign(raw, Number(headers.timestamp) || NOW)));
    await expect(verifyTrackSignature(ctx, { ...headers, signature }, raw)).rejects.toMatchObject({ status: 401 });
  });
});

describe("recordSignedConversion", () => {
  const touches = () => ctx.db.select().from(schema.signalAttributionEvents);
  const responses = () => ctx.db.select().from(schema.signalResponses);

  it("records a signed lead against its campaign, and a response the campaign and audience roll up", async () => {
    const out = await recordSignedConversion(ctx, { touchType: "lead", eventId: "ev_1", channel: "partner_site", campaignId: "cmp_1", customerId: "cus_1" });
    expect(out.duplicate).toBe(false);
    expect((await touches()).map((t) => [t.touchType, t.campaignId, t.customerId, t.subjectRef])).toEqual([["lead", "cmp_1", "cus_1", "track:ev_1"]]);
    expect((await responses()).map((r) => [r.kind, r.campaignId, r.audienceId, r.customerId, r.ref])).toEqual([["lead", "cmp_1", "aud_1", "cus_1", "ev_1"]]);
  });

  it("carries a bind's value", async () => {
    await recordSignedConversion(ctx, { touchType: "bind", eventId: "ev_2", channel: "partner_site", campaignId: "cmp_1", valueMinor: 240000, currency: "AED" });
    const [t] = await touches();
    expect(t).toMatchObject({ touchType: "bind", valueMinor: 240000, currency: "AED", customerId: null });
  });

  it("ignores a replay of the same event", async () => {
    await recordSignedConversion(ctx, { touchType: "lead", eventId: "ev_1", channel: "partner_site", campaignId: "cmp_1" });
    const again = await recordSignedConversion(ctx, { touchType: "lead", eventId: "ev_1", channel: "partner_site", campaignId: "cmp_1" });
    expect(again.duplicate).toBe(true);
    expect(await touches()).toHaveLength(1);
    expect(await responses()).toHaveLength(1);
  });

  it("refuses a campaign or a customer this tenant does not hold", async () => {
    await expect(recordSignedConversion(ctx, { touchType: "lead", eventId: "ev_3", channel: "x", campaignId: "cmp_nope" })).rejects.toMatchObject({ status: 400 });
    await expect(recordSignedConversion(ctx, { touchType: "lead", eventId: "ev_4", channel: "x", customerId: "cus_nope" })).rejects.toMatchObject({ status: 400 });
    expect(await touches()).toEqual([]);
  });
});

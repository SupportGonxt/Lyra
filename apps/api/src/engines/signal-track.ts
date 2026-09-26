import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { badRequest, hmacHex, timingSafeEqual, unauthorized, type Ctx } from "@lyra/core";
import { recordTouch } from "./signal-attribution.js";

// docs/30 SIGNAL gap 2, ADR-0092. A lead or a sale reported from a partner's
// own site, on the public /track endpoint. A conversion is a claim about money,
// so it is signed with a key the tenant already holds — one of its webhook
// secrets, named by id so each partner's key revokes on its own — in the scheme
// Lyra signs its own deliveries with (dispatch.ts deliver): v1=HMAC(`${ts}.${body}`).

const WINDOW_MS = 5 * 60_000;

export interface TrackSignature {
  keyId: string;
  timestamp: string;
  signature: string;
}

/** Resolves when the signature is good; a 401 otherwise, never saying which part failed. */
export async function verifyTrackSignature(ctx: Ctx, sig: TrackSignature, raw: string): Promise<void> {
  const refuse = () => unauthorized("track signature not valid");
  const ts = Number(sig.timestamp);
  if (!sig.timestamp || !Number.isFinite(ts) || Math.abs(ctx.now - ts) > WINDOW_MS) throw refuse();
  const [hook] = await ctx.db
    .select({ secret: schema.webhooks.secret })
    .from(schema.webhooks)
    .where(and(eq(schema.webhooks.tenantId, ctx.tenantId), eq(schema.webhooks.id, sig.keyId), eq(schema.webhooks.status, "active")))
    .limit(1);
  if (!hook) throw refuse();
  const expected = `v1=${await hmacHex(hook.secret, `${sig.timestamp}.${raw}`)}`;
  if (!timingSafeEqual(expected, sig.signature)) throw refuse();
}

export interface SignedConversion {
  touchType: "lead" | "bind";
  /** The sender's own id for this conversion: the replay key. */
  eventId: string;
  channel: string;
  campaignId?: string | null | undefined;
  customerId?: string | null | undefined;
  valueMinor?: number | null | undefined;
  currency?: string | null | undefined;
}

export async function recordSignedConversion(ctx: Ctx, input: SignedConversion): Promise<{ id: string; duplicate: boolean }> {
  const subjectRef = `track:${input.eventId}`;
  const [seen] = await ctx.db
    .select({ id: schema.signalAttributionEvents.id })
    .from(schema.signalAttributionEvents)
    .where(and(eq(schema.signalAttributionEvents.tenantId, ctx.tenantId), eq(schema.signalAttributionEvents.subjectRef, subjectRef)))
    .limit(1);
  if (seen) return { id: seen.id, duplicate: true };

  let audienceId: string | null = null;
  if (input.campaignId) {
    const [campaign] = await ctx.db
      .select({ audienceId: schema.signalCampaigns.audienceId })
      .from(schema.signalCampaigns)
      .where(and(eq(schema.signalCampaigns.tenantId, ctx.tenantId), eq(schema.signalCampaigns.id, input.campaignId)))
      .limit(1);
    if (!campaign) throw badRequest(`no campaign ${input.campaignId}`, { campaignId: "unknown campaign" });
    audienceId = campaign.audienceId;
  }
  if (input.customerId) {
    const [customer] = await ctx.db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, input.customerId)))
      .limit(1);
    if (!customer) throw badRequest(`no customer ${input.customerId}`, { customerId: "unknown customer" });
  }

  const id = await recordTouch(ctx, {
    touchType: input.touchType,
    channel: input.channel,
    campaignId: input.campaignId ?? null,
    customerId: input.customerId ?? null,
    valueMinor: input.valueMinor ?? null,
    currency: input.currency ?? null,
    subjectRef
  });
  // ADR-0091: the conversion rolls up broad (campaign) and niche (audience),
  // and individual only when the sender named the person.
  if (input.campaignId) {
    await ctx.db.insert(schema.signalResponses).values({
      id: newId("rsp", ctx.now),
      tenantId: ctx.tenantId,
      campaignId: input.campaignId,
      audienceId,
      customerId: input.customerId ?? null,
      outreachId: null,
      kind: input.touchType,
      ref: input.eventId,
      ts: ctx.now
    });
  }
  return { id, duplicate: false };
}

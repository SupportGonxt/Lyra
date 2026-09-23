import { and, desc, eq } from "drizzle-orm";
import {
  ChannelOptinsJson,
  PurposesJson,
  id as newId,
  parseJson,
  schema,
  toJson
} from "@lyra/db";
import { consentRequired } from "./errors.js";
import { audit } from "./audit.js";
import { emit } from "./events.js";
import type { Ctx } from "./context.js";

// docs/12 §2 (PDPL). Consent rows are immutable; the current state is the latest
// row for the customer. An expired row grants nothing.

export type Purpose = keyof PurposesJson;
export type Channel = keyof ChannelOptinsJson;

export interface ConsentState {
  id: string;
  purposes: PurposesJson;
  channels: ChannelOptinsJson;
  source: string;
  ts: number;
  expiry: number | null;
  expired: boolean;
}

const NONE: PurposesJson = PurposesJson.parse({});
const NO_CHANNELS: ChannelOptinsJson = ChannelOptinsJson.parse({});

export async function currentConsent(ctx: Ctx, customerId: string): Promise<ConsentState | null> {
  const rows = await ctx.db
    .select()
    .from(schema.consents)
    .where(and(eq(schema.consents.tenantId, ctx.tenantId), eq(schema.consents.customerId, customerId)))
    .orderBy(desc(schema.consents.ts))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const expired = row.expiry != null && row.expiry <= ctx.now;
  return {
    id: row.id,
    purposes: expired ? NONE : parseJson(PurposesJson, row.purposesJson),
    channels: expired ? NO_CHANNELS : parseJson(ChannelOptinsJson, row.channelOptinsJson),
    source: row.source,
    ts: row.ts,
    expiry: row.expiry,
    expired
  };
}

export async function hasPurpose(ctx: Ctx, customerId: string, purpose: Purpose): Promise<boolean> {
  const state = await currentConsent(ctx, customerId);
  return state?.purposes[purpose] === true;
}

/** Throws 403 consent_required. Every purpose-bound read/write goes through this. */
export async function assertPurpose(ctx: Ctx, customerId: string, purpose: Purpose): Promise<void> {
  if (!(await hasPurpose(ctx, customerId, purpose))) throw consentRequired(purpose);
}

/**
 * Outbound marketing needs both the purpose and the channel opt-in.
 * Service messages (renewal due, claim update) are not marketing and use
 * `assertChannel(ctx, id, channel, { marketing: false })`.
 */
export async function assertChannel(
  ctx: Ctx,
  customerId: string,
  channel: Channel,
  opts: { marketing?: boolean } = {}
): Promise<void> {
  const state = await currentConsent(ctx, customerId);
  if (!state?.channels[channel]) throw consentRequired(`channel:${channel}`);
  if (opts.marketing !== false && !state.purposes.marketing) throw consentRequired("marketing");
}

export interface RecordConsentInput {
  customerId: string;
  purposes: Partial<PurposesJson>;
  channels: Partial<ChannelOptinsJson>;
  source: "web" | "whatsapp" | "import" | "agent" | "portal";
  evidenceRef?: string;
  expiry?: number;
}

/**
 * The one event a consent write produces. Every consent write is a fact
 * SIGNAL's suppression consumer needs to see — withdrawal is the case that
 * matters, but re-consent must reach it too, or a customer who opts back in
 * stays wrongly suppressed. Every writer routes through here: `recordConsent`
 * and the generic `POST /v1/core/consents` (apps/api resources.ts), which used
 * to emit only `core.consents.created` and so never suppressed anything.
 */
export async function announceConsent(
  ctx: Ctx,
  input: { customerId: string; purposes: PurposesJson; channels: ChannelOptinsJson; source: string }
): Promise<void> {
  await emit(ctx, {
    module: "core",
    type: "core.consent.updated",
    subject: `customer:${input.customerId}`,
    data: { customerId: input.customerId, purposes: input.purposes, channels: input.channels, source: input.source }
  });
}

/** Append a new consent row. Withdrawal is a row with the purposes set false. */
export async function recordConsent(ctx: Ctx, input: RecordConsentInput): Promise<ConsentState> {
  const prior = await currentConsent(ctx, input.customerId);
  const purposes = PurposesJson.parse(input.purposes);
  const channels = ChannelOptinsJson.parse(input.channels);

  const row = {
    id: newId("cns", ctx.now),
    tenantId: ctx.tenantId,
    customerId: input.customerId,
    purposesJson: toJson(PurposesJson, purposes),
    channelOptinsJson: toJson(ChannelOptinsJson, channels),
    source: input.source,
    evidenceRef: input.evidenceRef ?? null,
    ts: ctx.now,
    expiry: input.expiry ?? null,
    version: (prior ? 1 : 0) + 1
  };
  await ctx.db.insert(schema.consents).values(row);

  await audit(ctx, {
    action: "core.consent.record",
    subjectRef: `customer:${input.customerId}`,
    ...(prior ? { before: { purposes: prior.purposes, channels: prior.channels } } : {}),
    after: { purposes, channels, source: input.source }
  });

  await announceConsent(ctx, { customerId: input.customerId, purposes, channels, source: input.source });

  return {
    id: row.id,
    purposes,
    channels,
    source: input.source,
    ts: ctx.now,
    expiry: row.expiry,
    expired: false
  };
}

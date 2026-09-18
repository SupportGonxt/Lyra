import { eq, and } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { recordConsent, type Ctx, type InboundEvent } from "@lyra/core";
import { isUniqueViolation } from "../crud.js";
import { adapterFor } from "./orbit-channel-adapters.js";
import { routeConversation } from "./orbit-routing.js";

export type ChannelConnectorRow = typeof schema.orbitChannelConnectors.$inferSelect;

async function getOrCreateConversation(
  ctx: Ctx,
  connector: ChannelConnectorRow,
  handle: string,
  displayName: string | undefined
): Promise<{ id: string; customerId: string }> {
  const [identity] = await ctx.db
    .select()
    .from(schema.orbitChannelIdentities)
    .where(
      and(
        eq(schema.orbitChannelIdentities.tenantId, ctx.tenantId),
        eq(schema.orbitChannelIdentities.connectorId, connector.id),
        eq(schema.orbitChannelIdentities.handle, handle)
      )
    );

  let customerId: string;
  if (identity) {
    customerId = identity.customerId;
  } else {
    customerId = id("cus", ctx.now);
    await ctx.db.insert(schema.customers).values({
      id: customerId,
      tenantId: ctx.tenantId,
      type: "person",
      nameJson: JSON.stringify({ en: displayName ?? handle }),
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await ctx.db.insert(schema.orbitChannelIdentities).values({
      id: id("cid", ctx.now),
      tenantId: ctx.tenantId,
      connectorId: connector.id,
      handle,
      customerId,
      createdAt: ctx.now
    });

    // docs/12 §2: a customer who opens the conversation has, by that act, opted
    // in to being replied to on that channel — without this row the outbound
    // gate 403s every reply. Only the channel the customer actually used, and no
    // purposes: a reply is a service message, not marketing. New customers only,
    // because consent rows are immutable and the latest wins, so re-granting on
    // a returning handle would resurrect a revoked opt-in. `consentChannel` is
    // the seam that binds a transport to a consent channel (ADR-0038) —
    // `connector.transport` has values (`web`, `agent`) the consent model has no
    // channel for.
    const consentChannel = adapterFor(connector.provider).consentChannel;
    if (consentChannel) {
      await recordConsent(ctx, {
        customerId,
        purposes: {},
        channels: { [consentChannel]: true },
        source: "agent",
        evidenceRef: `inbound:${connector.id}:${handle}`
      });
    }
  }

  const [conversation] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(
      and(
        eq(schema.orbitConversations.tenantId, ctx.tenantId),
        eq(schema.orbitConversations.customerId, customerId),
        eq(schema.orbitConversations.connectorId, connector.id),
        eq(schema.orbitConversations.state, "bot")
      )
    );
  if (conversation) return { id: conversation.id, customerId };

  const conversationId = id("cnv", ctx.now);
  await ctx.db.insert(schema.orbitConversations).values({
    id: conversationId,
    tenantId: ctx.tenantId,
    customerId,
    channel: connector.transport,
    externalRef: handle,
    connectorId: connector.id,
    state: "bot",
    lastMessageAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  await routeConversation(ctx, conversationId);
  return { id: conversationId, customerId };
}

/**
 * Turns parsed `InboundEvent[]` (from any `ChannelAdapter`) into DB state:
 * resolve/create a customer + channel identity for a handle, resolve/create
 * a conversation, insert the message, or update delivery status on a
 * receipt. Redelivered webhooks are de-duped by `externalRef` via the
 * `orbit_messages_ext_uq` unique index — a violation on insert means "already
 * processed", counted as skipped rather than an error.
 */
export async function processChannelEvents(
  ctx: Ctx,
  connector: ChannelConnectorRow,
  events: InboundEvent[],
  opts: {
    signal?: (conversationId: string, customerId: string | null, text: string) => Promise<void>;
    /**
     * docs/27 F32. Offered every inbound customer message once it is durable,
     * after `signal`: language is what knowledge-base retrieval picks an
     * article by, and `signal` is what sets it, so a deflection that ran first
     * would search in the previous message's language. Optional for the same
     * reason `signal` is — this engine has to stay callable with no AI wiring.
     */
    deflect?: (conversationId: string, text: string) => Promise<void>;
  } = {}
): Promise<{ processed: number; skipped: number }> {
  let processed = 0;
  let skipped = 0;

  for (const event of events) {
    if (event.kind === "ignored") {
      skipped++;
      continue;
    }

    if (event.kind === "status") {
      await ctx.db
        .update(schema.orbitMessages)
        .set({ deliveryStatus: event.receipt.status })
        .where(and(eq(schema.orbitMessages.tenantId, ctx.tenantId), eq(schema.orbitMessages.externalRef, event.receipt.externalRef)));
      processed++;
      continue;
    }

    const conversation = await getOrCreateConversation(ctx, connector, event.message.handle, event.message.displayName);
    try {
      await ctx.db.insert(schema.orbitMessages).values({
        id: id("msg", ctx.now),
        tenantId: ctx.tenantId,
        conversationId: conversation.id,
        role: "customer",
        modality: event.message.modality,
        content: event.message.text,
        attachmentsJson: event.message.media ? JSON.stringify(event.message.media) : null,
        externalRef: event.message.externalRef,
        ts: event.message.sentAt
      });
      await ctx.db
        .update(schema.orbitConversations)
        .set({ lastMessageAt: event.message.sentAt, updatedAt: ctx.now })
        .where(eq(schema.orbitConversations.id, conversation.id));
      processed++;
      // Language + sentiment annotation (engines/orbit-signal.ts). Runs after
      // the message is durable; a failure leaves the previous signal standing.
      // Awaited so webhook return implies the conversation is fully annotated.
      await opts.signal?.(conversation.id, conversation.customerId, event.message.text);
      // Inside the try, after the insert: a redelivered webhook throws on the
      // unique index above and must not answer the customer a second time.
      await opts.deflect?.(conversation.id, event.message.text);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      skipped++;
    }
  }

  return { processed, skipped };
}

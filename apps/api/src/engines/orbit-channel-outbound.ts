import { and, eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { assertChannel, badRequest, consentRequired, openFields, scoped, type ConnectorSecrets, type Ctx } from "@lyra/core";
import { fieldKey, type Env } from "../env.js";
import { adapterFor } from "./orbit-channel-adapters.js";

// The outbound half of the ChannelAdapter seam (ADR-0037/ADR-0038): resolve
// the conversation's connector, open its sealed secrets, hand the text to the
// provider, and only then record what was actually sent. Write-after-send is
// the point — a failed send must not leave a message row claiming "sent".

type ConversationRow = typeof schema.orbitConversations.$inferSelect;
type ConnectorRow = typeof schema.orbitChannelConnectors.$inferSelect;

export async function dispatchOutbound(
  ctx: Ctx,
  env: Env,
  conversation: ConversationRow,
  connector: ConnectorRow,
  text: string,
  /**
   * Who wrote the words. Default `agent_human`: this is the human reply path.
   * An auto-reply (engines/orbit-auto-reply.ts, ADR-0098) sends through the
   * same consent gate and the same write-after-send, as `agent_ai` with the
   * audit id of the model call that produced it — the ✦ and its "why".
   */
  author: { role: "agent_human" | "agent_ai"; aiAuditId?: string } = { role: "agent_human" }
): Promise<{ messageId: string; externalRef: string }> {
  if (!conversation.externalRef) throw badRequest("conversation has no channel address to reply to");

  const adapter = adapterFor(connector.provider);

  // docs/12 §2: every outbound send checks consent at runtime. `consentChannel`
  // is the seam that says which opt-in binds for this adapter (ADR-0038) —
  // `marketing: false` because a reply is a service message, so the channel
  // opt-in alone is enough and the marketing purpose is not required. An
  // adapter with a null consentChannel is one the consent model has no
  // channel for (nothing to check). A conversation with no linked customerId
  // is NOT automatically exempt — a client can create a conversation row
  // directly with an arbitrary externalRef and no customerId, which must not
  // bypass consent. Resolve the customer via the channel identity the
  // inbound path created instead; refuse the send if there is none.
  if (adapter.consentChannel) {
    let customerId = conversation.customerId;
    if (!customerId) {
      const [identity] = await ctx.db
        .select()
        .from(schema.orbitChannelIdentities)
        .where(
          and(
            eq(schema.orbitChannelIdentities.tenantId, ctx.tenantId),
            eq(schema.orbitChannelIdentities.connectorId, connector.id),
            eq(schema.orbitChannelIdentities.handle, conversation.externalRef)
          )
        );
      if (!identity) throw consentRequired(`channel:${adapter.consentChannel}`);
      customerId = identity.customerId;
    }
    await assertChannel(ctx, customerId, adapter.consentChannel, { marketing: false });
  }

  const secrets = await openFields(fieldKey(env), JSON.parse(connector.secretsJson) as ConnectorSecrets);
  const config = JSON.parse(connector.configJson) as Record<string, unknown>;

  const sent = await adapter.send({ conversationId: conversation.id, to: conversation.externalRef, text }, secrets, config);

  const messageId = id("msg", ctx.now);
  await ctx.db.insert(schema.orbitMessages).values({
    id: messageId,
    tenantId: ctx.tenantId,
    conversationId: conversation.id,
    role: author.role,
    modality: "text",
    content: text,
    aiAuditId: author.aiAuditId ?? null,
    deliveryStatus: "sent",
    externalRef: sent.externalRef,
    ts: ctx.now
  });

  // C2: this is the FRT clock's only stop condition. Without it, a human
  // agent can reply within seconds and the SLA sweep still sees a null
  // firstResponseMs plus a due date in the past, so it flags the
  // conversation as breached, deprioritizes it, and re-routes it away from
  // the agent who already answered. Only the first human reply counts —
  // firstResponseMs is elapsed ms from queue entry to first response
  // (docs/03 §ORBIT, apps/web's orbit-console reads it as a duration, not a
  // timestamp), so once it is set, later replies must not touch it.
  // An AI answer is not the human first response the SLA measures.
  if (author.role === "agent_human" && conversation.firstResponseMs === null) {
    await ctx.db
      .update(schema.orbitConversations)
      .set({
        firstResponseMs: ctx.now - (conversation.queuedAt ?? conversation.createdAt),
        firstResponseDueAt: null,
        updatedAt: ctx.now
      })
      .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conversation.id)));
  }

  return { messageId, externalRef: sent.externalRef };
}

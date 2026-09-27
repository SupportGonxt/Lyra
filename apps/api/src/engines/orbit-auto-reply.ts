import { and, desc, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { audit, autonomyPermitsSend, gate, scoped, type Ctx, type Envelope } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import type { Env } from "../env.js";
import { findAgent } from "./ai-agent.js";
import { dispatchOutbound } from "./orbit-channel-outbound.js";
import { AGENT_KEY, replyToInbound, type ReplyOutcome } from "./orbit-draft.js";

// docs/30 ORBIT 3, ADR-0098: real-time AI replies on inbound, sent within the
// agent's autonomy. The consumer of `orbit.message.received` (dispatch.ts, and
// kicked straight after the webhook by routes/channels.ts so "real time" does
// not wait for the next cron tick).
//
// Two switches, both required, neither sufficient (CLAUDE.md rule 4): the
// service agent's own autonomy is `act_within_limits` or higher — raising it is
// itself dual-controlled (`ai.autonomy_raise`) — AND the tenant lists
// `orbit.ai_reply` on its auto_approve allowlist. Anything short of both, and
// the reply is drafted for a human exactly as the sweep would have drafted it,
// only now rather than on the next tick (rule 11: a background draft).

/** The approval policy an auto-sent reply passes through (packages/core approvals.ts). */
export const AUTO_REPLY_POLICY = "orbit.ai_reply";

/**
 * A reply this long after the customer wrote is no longer "real time" — the
 * drain was down, or the queue backed up — and the conversation may have moved
 * on without us. Past it, a person decides: the reply is drafted, never sent.
 */
export const REPLY_WINDOW_MS = 30 * 60_000;
const HISTORY = 12;

export type AutoReplyResult = ReplyOutcome | "skipped";

export async function onInboundMessage(
  ctx: Ctx,
  deps: { env: Env; gateway: Gateway },
  event: Envelope
): Promise<AutoReplyResult> {
  const { conversationId, messageId } = event.data as { conversationId?: string; messageId?: string };
  if (!conversationId || !messageId) return "skipped";

  const [conv] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conversationId)))
    .limit(1);
  // A conversation a person holds is never answered over their head — the same
  // rule the knowledge-base deflection keeps (engines/orbit-kb.ts).
  if (!conv || conv.state !== "bot") return "skipped";

  const history = await ctx.db
    .select()
    .from(schema.orbitMessages)
    .where(
      and(eq(schema.orbitMessages.tenantId, ctx.tenantId), eq(schema.orbitMessages.conversationId, conversationId))
    )
    .orderBy(desc(schema.orbitMessages.ts))
    .limit(HISTORY);
  // Only the newest message is answered. Anything after it — a deflection that
  // already answered, a human reply, a later customer message with its own
  // event — means this one is no longer the question.
  const newest = history[0];
  if (!newest || newest.id !== messageId || newest.role !== "customer") return "skipped";

  const agent = await findAgent(ctx, AGENT_KEY);
  if (!agent || agent.status !== "active") return "skipped";

  const connectorId = conv.connectorId;
  const mayAutoSend =
    connectorId !== null &&
    autonomyPermitsSend(agent.autonomyLevel) &&
    ctx.policy.autoApprove.includes(AUTO_REPLY_POLICY) &&
    ctx.now - newest.ts <= REPLY_WINDOW_MS;

  const send = mayAutoSend
    ? async (text: string, aiAuditId: string): Promise<string> => {
        // Routed through gate() rather than decided by the `if` above alone:
        // gate() is where the allowlist is honoured (or refused, should the
        // policy ever become neverAutoApprove) and where the auto-approval
        // lands in the audit chain.
        await gate(ctx, {
          policyKey: AUTO_REPLY_POLICY,
          subjectRef: conv.id,
          context: { messageId, agentKey: agent.key, autonomyLevel: agent.autonomyLevel }
        });
        const [connector] = await ctx.db
          .select()
          .from(schema.orbitChannelConnectors)
          .where(scoped(ctx, schema.orbitChannelConnectors, eq(schema.orbitChannelConnectors.id, connectorId)))
          .limit(1);
        if (!connector || connector.status !== "active") throw new Error("connector unavailable");
        // The consent gate, the provider send and write-after-send are the
        // human reply path's own (ADR-0037/0038) — not a second copy of them.
        const sent = await dispatchOutbound(ctx, deps.env, conv, connector, text, { role: "agent_ai", aiAuditId });
        await ctx.db
          .update(schema.orbitConversations)
          .set({ lastMessageAt: ctx.now, updatedAt: ctx.now })
          .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conv.id)));
        await audit(ctx, {
          action: "orbit.ai_reply.sent",
          subjectRef: conv.id,
          after: {
            messageId: sent.messageId,
            inReplyTo: messageId,
            aiAuditId,
            agentKey: agent.key,
            autonomyLevel: agent.autonomyLevel
          }
        });
        return sent.messageId;
      }
    : undefined;

  // The run id is the claim: this consumer can be reached twice for one message
  // (the webhook's kick and the drain), and only the first insert wins.
  return replyToInbound(ctx, deps.gateway, agent, conv, history, {
    runId: `air_in_${messageId}`,
    ...(send ? { send } : {})
  });
}

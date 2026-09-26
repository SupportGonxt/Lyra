import { and, desc, eq, gte, ne } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { verifyGroundedness, type Ctx } from "@lyra/core";
import { isoDay, type Gateway } from "@lyra/model-gateway";
import { activePrompt, findAgent } from "./ai-agent.js";

// docs/27 F7. The draft loop had two ends and no middle: apps/web's
// conversation.tsx renders a trailing `agent_ai` message with no
// deliveryStatus as a pending draft with approve/discard, and approving
// re-posts it as queued — but the only thing that ever wrote such a row was
// packages/core/src/seed/orbit.ts. This is the producer: a background sweep
// that drafts the next reply for conversations waiting on us.
//
// Draft only, never sent (CLAUDE.md rule 4 — an outbound send is
// consequential, so a human approves it; rule 11 — AI arrives as a background
// draft, never a modal, never an auto-send).

/** The seeded ORBIT drafting agent. No agent row, no sweep — a tenant seeded
 *  before this existed is skipped, not crashed. */
const AGENT_KEY = "service";
const PURPOSE = "orbit.conversation.reply";

/** How far back a conversation can have gone quiet and still get a draft.
 *  Older than this and the reply is archaeology, not service. */
const STALE_MS = 7 * 86_400_000;
const MAX_CONVERSATIONS = 25;
const HISTORY = 12;

/**
 * Draft the next agent reply for every conversation whose newest message is
 * from the customer. Idempotent by construction: writing the draft makes the
 * newest message `agent_ai`, so the next sweep passes over it — which also
 * means a conversation can never accumulate two pending drafts.
 *
 * Returns the number of drafts written.
 */
export async function sweepConversationDrafts(ctx: Ctx, gateway: Gateway): Promise<number> {
  const agent = await findAgent(ctx, AGENT_KEY);
  if (!agent || agent.status !== "active") return 0;

  const conversations = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(
      and(
        eq(schema.orbitConversations.tenantId, ctx.tenantId),
        ne(schema.orbitConversations.state, "closed"),
        gte(schema.orbitConversations.lastMessageAt, ctx.now - STALE_MS)
      )
    )
    .orderBy(desc(schema.orbitConversations.lastMessageAt))
    .limit(MAX_CONVERSATIONS);

  let drafted = 0;
  for (const conv of conversations) {
    // One conversation's model failure is not the batch's problem — the next
    // tick tries again, and the guard above means nothing double-drafts.
    try {
      if (await draftReply(ctx, gateway, agent, conv)) drafted += 1;
    } catch {
      // Anything thrown after draftReply opened its run row has already been
      // recorded there as `failed`. Anything thrown before it — building the
      // context — leaves no row at all, so it is invisible here by design:
      // every formatter on that path is total (see `isoDay`) precisely because
      // this catch cannot tell the two cases apart.
    }
  }
  return drafted;
}

type Conversation = typeof schema.orbitConversations.$inferSelect;
export type Agent = NonNullable<Awaited<ReturnType<typeof findAgent>>>;

async function draftReply(ctx: Ctx, gateway: Gateway, agent: Agent, conv: Conversation): Promise<boolean> {
  const history = await ctx.db
    .select()
    .from(schema.orbitMessages)
    .where(
      and(eq(schema.orbitMessages.tenantId, ctx.tenantId), eq(schema.orbitMessages.conversationId, conv.id))
    )
    .orderBy(desc(schema.orbitMessages.ts))
    .limit(HISTORY);

  // Newest first. Only a conversation waiting on us gets a draft; anything
  // else already has an answer, a pending draft, or is a system note.
  const newest = history[0];
  if (!newest || newest.role !== "customer") return false;

  const locale = conv.lang === "ar" ? "ar" : "en";
  const lctx: Ctx = { ...ctx, locale };
  const contextLines = await buildContext(lctx, conv, history);
  const drafted = await writeDraft(lctx, gateway, agent, conv, {
    purpose: PURPOSE,
    trigger: "schedule",
    instruction:
      "Draft the next reply to this customer using only the context lines below. " +
      "Do not state a number that is not in the context. Never say a message, payment or " +
      `change has been made — you are drafting for a human to approve. Reply in ${locale}.`,
    contextLines,
    userContent: newest.content
  });
  return drafted !== null;
}

/**
 * A journey `agent` node's proactive outreach (engines/orbit-journeys.ts).
 * Same gate, same run record and same pending-draft row as a reply — the
 * conversation view's approve/discard is the only way it reaches the customer.
 * Returns the draft's message id, or null when the gate refused it.
 */
export async function draftJourneyOutreach(
  ctx: Ctx,
  gateway: Gateway,
  agent: Agent,
  conv: Conversation,
  step: { key: string; purpose: string; lines: readonly string[] }
): Promise<string | null> {
  const locale = conv.lang === "ar" ? "ar" : "en";
  const lctx: Ctx = { ...ctx, locale };
  const contextLines = [...(await buildContext(lctx, conv, [])), ...step.lines];
  return writeDraft(lctx, gateway, agent, conv, {
    purpose: step.purpose,
    trigger: "schedule",
    instruction:
      `Draft an outreach message to this customer for journey step ${step.key}, using only the context ` +
      "lines below. Do not state a number, date or discount that is not in the context. Never say a " +
      `message, payment or change has been made — you are drafting for a human to approve. Write in ${locale}.`,
    contextLines,
    userContent: `Draft the message for step ${step.key}.`
  });
}

interface DraftRequest {
  purpose: string;
  trigger: string;
  instruction: string;
  contextLines: string[];
  userContent: string;
}

/** The one path a draft takes: an ai_runs row, the model, the groundedness gate, a pending message. */
async function writeDraft(
  lctx: Ctx,
  gateway: Gateway,
  agent: Agent,
  conv: Conversation,
  req: DraftRequest
): Promise<string | null> {
  const runId = newId("air", lctx.now);
  await lctx.db.insert(schema.aiRuns).values({
    id: runId,
    tenantId: lctx.tenantId,
    agentKey: agent.key,
    module: "orbit",
    purpose: req.purpose,
    subjectRef: conv.id,
    actorRef: "system:scheduler",
    autonomyLevel: agent.autonomyLevel,
    trigger: req.trigger,
    state: "running",
    inputHash: "",
    startedAt: lctx.now
  });

  try {
    const prompt = await activePrompt(lctx, agent.promptRef);
    const result = await gateway.complete(lctx, {
      module: "orbit",
      purpose: req.purpose,
      tier: agent.tier as "fast" | "standard" | "reasoning",
      subjectRef: conv.id,
      locale: lctx.locale,
      messages: [
        { role: "system", content: `${prompt}\n\n${req.instruction}\n\n${req.contextLines.join("\n")}` },
        { role: "user", content: req.userContent }
      ]
    });

    // The runtime half of the eval gate (packages/model-gateway/evals/orbit-draft,
    // orbit-journey-draft): a message quoting a premium nobody quoted is worse
    // than none, because a busy human approves what reads plausibly. Ungrounded
    // drafts are recorded as refused runs and never reach the inbox.
    const groundedness = verifyGroundedness(result.text, req.contextLines);
    const text = result.text.trim();
    const ok = groundedness.ok && text.length > 0;
    const messageId = newId("omg", lctx.now);

    if (ok) {
      await lctx.db.insert(schema.orbitMessages).values({
        id: messageId,
        tenantId: lctx.tenantId,
        conversationId: conv.id,
        role: "agent_ai",
        modality: "text",
        content: text,
        attachmentsJson: null,
        redactionsJson: null,
        aiAuditId: result.auditId,
        // No deliveryStatus: that absence IS the pending-draft state the
        // conversation view reads. Approving sets it to `queued`.
        deliveryStatus: null,
        externalRef: null,
        ts: lctx.now
      } as never);
    }

    await lctx.db
      .update(schema.aiRuns)
      .set({
        state: ok ? "succeeded" : "refused",
        inputHash: result.auditId,
        outputRef: result.auditId,
        confidence: groundedness.ok ? 95 : Math.max(20, 95 - groundedness.mismatches.length * 15),
        evidenceJson: JSON.stringify({
          model: result.model,
          provider: result.provider,
          flags: result.flags,
          mismatches: groundedness.mismatches
        }),
        tokensIn: result.usage.tokensIn,
        tokensOut: result.usage.tokensOut,
        costMicro: result.usage.costMicro,
        latencyMs: result.latencyMs,
        endedAt: lctx.now
      })
      .where(and(eq(schema.aiRuns.tenantId, lctx.tenantId), eq(schema.aiRuns.id, runId)));

    return ok ? messageId : null;
  } catch (err) {
    await lctx.db
      .update(schema.aiRuns)
      .set({
        state: "failed",
        errorCode: err instanceof Error ? err.message.slice(0, 120) : "error",
        endedAt: lctx.now
      })
      .where(and(eq(schema.aiRuns.tenantId, lctx.tenantId), eq(schema.aiRuns.id, runId)));
    throw err;
  }
}

/**
 * Everything the drafter is allowed to know, as prose. Assembled from the DB
 * rather than from a tool loop on purpose: the same lines are the input to
 * `verifyGroundedness`, so "did the model make this number up" is answerable.
 */
async function buildContext(
  ctx: Ctx,
  conv: Conversation,
  history: readonly (typeof schema.orbitMessages.$inferSelect)[]
): Promise<string[]> {
  // orbit_conversations.customerId is nullable (an inbound message from a
  // handle nobody has matched yet). No customer, no book — the drafter then
  // has only the transcript, which is exactly what a human would have.
  const customerId = conv.customerId;
  const [customer] = customerId
    ? await ctx.db
        .select()
        .from(schema.customers)
        .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, customerId)))
        .limit(1)
    : [];

  const policies = customerId
    ? await ctx.db
        .select()
        .from(schema.axisPolicies)
        .where(
          and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.customerId, customerId))
        )
        .orderBy(desc(schema.axisPolicies.endAt))
        .limit(10)
    : [];

  const claims = customerId
    ? await ctx.db
        .select()
        .from(schema.axisClaims)
        .where(and(eq(schema.axisClaims.tenantId, ctx.tenantId), eq(schema.axisClaims.customerId, customerId)))
        .orderBy(desc(schema.axisClaims.reportedAt))
        .limit(5)
    : [];

  const lines: string[] = [
    `Customer ${nameOf(customer?.nameJson, ctx.locale)}, locale ${conv.lang}, ${policies.filter((p) => p.status === "active").length} active policies.`,
    ...(conv.intent ? [`Conversation intent: ${conv.intent}.`] : []),
    ...policies.map(
      (p) =>
        `Policy ${p.policyNo}: status ${p.status}, premium ${p.premiumMinor / 100} ${p.currency}, ` +
        `cover ${isoDay(p.startAt)} to ${isoDay(p.endAt)}.`
    ),
    ...claims.map(
      (cl) =>
        `Claim ${cl.claimNo}: status ${cl.status}, reported ${isoDay(cl.reportedAt)}, ` +
        `reserve ${cl.reserveMinor / 100} ${cl.currency}, paid ${cl.paidMinor / 100} ${cl.currency}.`
    ),
    // Oldest first, so the transcript reads forwards.
    ...[...history].reverse().map((m) => `${m.role}: ${m.content.slice(0, 500)}`)
  ];
  return lines;
}

function nameOf(json: string | null | undefined, locale: string): string {
  if (!json) return "";
  try {
    const map = JSON.parse(json) as Record<string, string>;
    return map[locale] ?? map.en ?? Object.values(map)[0] ?? "";
  } catch {
    return "";
  }
}


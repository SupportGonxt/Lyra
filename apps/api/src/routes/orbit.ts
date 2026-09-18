import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@lyra/db";
import { badRequest, require_, withIdempotency, type Ctx } from "@lyra/core";
import { portalLinkToken } from "./portal.js";
import { body } from "../http.js";
import { must } from "../rows.js";
import { dispatchOutbound } from "../engines/orbit-channel-outbound.js";
import { sweepRenewals } from "../engines/renewals.js";
import { sweepRouting } from "../engines/orbit-routing.js";
import { sweepConversationDrafts } from "../engines/orbit-draft.js";
import { advanceJourneyRuns, triggerJourney } from "../engines/orbit-journeys.js";
import { applyMacro, deflect, publishArticle, searchKb } from "../engines/orbit-kb.js";
import { requestPartnerQuote } from "../engines/orbit-partner-quotes.js";
import type { App } from "../env.js";

// docs/16 H3: the AgentRoom Durable Object seam. One room per conversation,
// opened (or continued, if it already lives at that id) on first turn. The
// room itself has no RBAC or tenancy — that is enforced here, at the gateway,
// same as every other route (CLAUDE.md rule 1) — before the DO is ever
// touched.

export const orbitRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

const TurnBody = z.object({
  role: z.enum(["customer", "agent_ai", "agent_human", "system"]),
  content: z.string().min(1).max(20_000),
  modality: z.enum(["text", "voice", "image", "document"]).optional(),
  aiAuditId: z.string().optional()
});

/**
 * Append one turn to a conversation's room. Distinct from the generic
 * `POST /v1/orbit/messages` CRUD create: this goes through the Durable Object
 * so the room can hold in-memory turn state instead of round-tripping the DB
 * per step, checkpointing to `orbit_messages`/`orbit_conversations` itself.
 */
orbitRoutes.post("/conversations/:id/turns", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:messages:send", { tenantId: ctx.tenantId, module: "orbit" });
  const conversationId = c.req.param("id");
  await must(ctx, schema.orbitConversations, conversationId, "conversation");
  const input = await body(c, TurnBody);

  const room = c.env.AGENT_ROOM.get(c.env.AGENT_ROOM.idFromName(`${ctx.tenantId}:${conversationId}`));
  const result = await room.turn({ tenantId: ctx.tenantId, conversationId, ts: ctx.now, ...input });
  return c.json(result, 201);
});

const ReplyBody = z.object({ text: z.string().min(1).max(20_000) });

/**
 * Sends a reply back out over whichever channel the conversation is bound
 * to. Distinct from `POST /messages` (generic CRUD create, no dispatch) and
 * from `/turns` (the AgentRoom path) — this is the human-agent reply path,
 * ADR-0037/ADR-0038's ChannelAdapter.send() the one place it is called from.
 */
orbitRoutes.post("/conversations/:id/reply", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:messages:send", { tenantId: ctx.tenantId, module: "orbit" });
  const conversationId = c.req.param("id");
  const conversation = await must(ctx, schema.orbitConversations, conversationId, "conversation");
  if (!conversation.connectorId) throw badRequest("conversation has no channel connector");
  const connector = await must(ctx, schema.orbitChannelConnectors, conversation.connectorId, "connector");
  const input = await body(c, ReplyBody);

  return c.json(await dispatchOutbound(ctx, c.env, conversation, connector, input.text), 201);
});

/**
 * Force the nightly renewal sweep now. `orbit_renewals` has no `create`
 * permission — a renewal is raised by the sweep, never by a person — and
 * `sweepRenewals` otherwise only runs off the Workers cron tick, so without
 * this an operator (or an e2e test) has no way to put a row in the queue.
 * Same idiom as staff.ts's `/delegations/expire`.
 */
orbitRoutes.post("/renewals/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:renewals:update", { tenantId: ctx.tenantId, module: "orbit" });
  return c.json({ raised: await sweepRenewals(ctx, c.env.WF) });
});

/**
 * Force the routing sweep now (SLA breach escalation + absence reassignment).
 * Same idiom as `/renewals/sweep` above: this otherwise only runs off the
 * Workers cron tick, so without this an operator (or an e2e test) has no way
 * to force it. Reuses `orbit:conversations:assign` — this endpoint changes
 * exactly the fields that permission already governs (team/assignee),
 * so a new permission would be a distinction without a difference.
 */
orbitRoutes.post("/routing/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:conversations:assign", { tenantId: ctx.tenantId, module: "orbit" });
  return c.json(await sweepRouting(ctx));
});

/**
 * Force the draft sweep now (docs/27 F7). Same idiom again: the producer of the
 * inbox's pending drafts otherwise only runs off the cron tick, which an
 * operator demoing the approve/discard flow cannot wait for. Needs
 * `ai:invoke` because that is exactly what it does — run an agent — and
 * `conversations:reply` because a draft lands in the transcript.
 */
orbitRoutes.post("/drafts/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:ai:invoke", { tenantId: ctx.tenantId, module: "orbit" });
  require_(ctx.actor, "orbit:conversations:reply", { tenantId: ctx.tenantId, module: "orbit" });
  return c.json({ drafted: await sweepConversationDrafts(ctx, c.get("gateway")) });
});

const KbSearchBody = z.object({
  query: z.string().min(1).max(500),
  locale: z.string().min(2).max(8).optional(),
  limit: z.number().int().min(1).max(10).optional()
});

/**
 * What the knowledge base has on a question. A POST rather than a GET because
 * the query is a customer's own words — often long, often Arabic, and not
 * something to leave in a URL that lands in every access log (docs/12 §4).
 */
orbitRoutes.post("/kb/search", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:kb:read", { tenantId: ctx.tenantId, module: "orbit" });
  const input = await body(c, KbSearchBody);
  const hits = await searchKb(ctx, c.get("gateway"), c.env.VEC_KB, {
    query: input.query,
    locale: input.locale ?? ctx.locale,
    ...(input.limit === undefined ? {} : { limit: input.limit })
  });
  return c.json({
    data: hits.map((hit) => ({
      articleId: hit.article.id,
      key: hit.article.key,
      title: hit.article.title,
      body: hit.article.body,
      locale: hit.article.locale,
      score: hit.score,
      via: hit.via
    }))
  });
});

/**
 * Publish an article: the act that makes it answerable to a customer, and the
 * one that embeds it. Separate from the CRUD PATCH on purpose — `status` is not
 * editable through the generic resource, because setting it there would
 * publish an article that is in no index and can only ever be found lexically.
 */
orbitRoutes.post("/kb/articles/:id/publish", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:kb:publish", { tenantId: ctx.tenantId, module: "orbit" });
  return c.json(await publishArticle(ctx, c.get("gateway"), c.env.VEC_KB, c.req.param("id")));
});

const DeflectBody = z.object({ question: z.string().min(1).max(2000) });

/** Try to answer this conversation's question from the knowledge base; the result says whether it did. */
orbitRoutes.post("/conversations/:id/deflect", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:ai:invoke", { tenantId: ctx.tenantId, module: "orbit" });
  const input = await body(c, DeflectBody);
  return c.json(
    await deflect(ctx, c.get("gateway"), c.env.VEC_KB, {
      conversationId: c.req.param("id"),
      question: input.question
    })
  );
});

const MacroBody = z.object({ macroKey: z.string().min(1).max(64) });

/** Send a canned reply into the conversation, in the language the conversation is in. */
orbitRoutes.post("/conversations/:id/macro", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:conversations:reply", { tenantId: ctx.tenantId, module: "orbit" });
  const input = await body(c, MacroBody);
  return c.json(await applyMacro(ctx, { conversationId: c.req.param("id"), macroKey: input.macroKey }), 201);
});

const TriggerBody = z.object({ customerIds: z.array(z.string().min(1)).min(1).max(500) });

/**
 * Enrol a cohort by hand. The normal path is the event bus — `onJourneyEvent`
 * off the outbox drain (CLAUDE.md rule 6) — and this is the operator's door to
 * the same engine: a win-back list pasted in, or a journey author checking a
 * graph against one real customer before publishing it. `orbit:journeys:publish`
 * rather than `:write`, because enrolling a live cohort is the act a draft
 * author is not trusted with.
 */
orbitRoutes.post("/journeys/:id/trigger", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:journeys:publish", { tenantId: ctx.tenantId, module: "orbit" });
  const journeyId = c.req.param("id");
  const input = await body(c, TriggerBody);
  const result = await withIdempotency(
    ctx,
    c.req.header("idempotency-key"),
    "orbit.journey_trigger",
    { journeyId, ...input },
    () => triggerJourney(ctx, journeyId, input.customerIds)
  );
  return c.json(result, 201);
});

/**
 * Force the journey advance step now. Same idiom as `/routing/sweep` above: it
 * otherwise only runs off the Workers cron tick, so an operator demoing a
 * journey — or an e2e test — has no way to see a wait elapse. Gated on
 * `orbit:journeys:publish` for the same reason the trigger is: advancing a run
 * sends.
 */
orbitRoutes.post("/journeys/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:journeys:publish", { tenantId: ctx.tenantId, module: "orbit" });
  return c.json(await advanceJourneyRuns(ctx));
});

const PartnerQuoteBody = z.object({
  productLine: z.string().min(1),
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3)
});

// F1 (docs spec Group B): the live path behind orbit-partner-quotes.ts's
// requestPartnerQuote(), wired here. Gated on orbit:partners:read rather
// than :update — a quote is a pricing lookup, it persists a log row but
// never mutates the partner itself. Real rating integration stays a
// separate, credential-gated line (see engines/dist-quoter.ts).
orbitRoutes.post("/partners/:id/quotes", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "orbit:partners:read", { tenantId: ctx.tenantId, module: "orbit" });
  const partnerId = c.req.param("id");
  const input = await body(c, PartnerQuoteBody);
  const result = await withIdempotency(
    ctx,
    c.req.header("idempotency-key"),
    "orbit.partner_quote",
    { partnerId, ...input },
    () => requestPartnerQuote(ctx, partnerId, input)
  );
  return c.json(result, 201);
});

/**
 * The public link for a renewal or a closed conversation, for whoever is about
 * to send it. Nothing in the repo sends outbound renewal or CSAT messages yet
 * (renewal-campaign.ts only emits `orbit.renewal.offered`), so without this the
 * hosted pages at `/portal/:tenantSlug/renewals/:id` and `/feedback/:id` would
 * be unreachable by anyone. Read-only, and gated on the same permission that
 * lets the caller read the row it describes — a link is as sensitive as the row.
 */
orbitRoutes.get("/portal-links/:kind/:id", async (c) => {
  const ctx = ctxOf(c);
  const kind = c.req.param("kind");
  if (kind !== "renewal" && kind !== "feedback") throw badRequest("kind must be renewal or feedback");
  const rowId = c.req.param("id");

  if (kind === "renewal") {
    require_(ctx.actor, "orbit:renewals:read", { tenantId: ctx.tenantId, module: "orbit" });
    await must(ctx, schema.orbitRenewals, rowId, "renewal");
  } else {
    require_(ctx.actor, "orbit:conversations:read", { tenantId: ctx.tenantId, module: "orbit" });
    await must(ctx, schema.orbitConversations, rowId, "conversation");
  }

  // The slug, not the id, is what the portal routes key on. `ctx.db` is already
  // tenant-scoped, but `tenants` is the scoping table itself, so this reads it
  // by primary key rather than through withTenant's filter.
  const [tenant] = await ctx.db
    .select({ slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, ctx.tenantId))
    .limit(1);
  if (!tenant) throw badRequest("tenant");

  const token = await portalLinkToken(c.env, kind, ctx.tenantId, rowId);
  const path = kind === "renewal" ? `renewals/${rowId}` : `feedback/${rowId}`;
  return c.json({ url: `${c.env.APP_ORIGIN}/portal/${tenant.slug}/${path}?token=${token}` });
});

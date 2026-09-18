import { eq, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, conflict, emit, notFound, require_, scoped, type Ctx } from "@lyra/core";
import type { Gateway } from "@lyra/model-gateway";
import type { VectorizeIndex } from "../env.js";
import { embedQuery, embedUpsert } from "./vectorize.js";

// docs/27 F32 — "No KB/RAG article manager, no macros, no deflection."
//
// The three live in one engine because they are one loop: an article is what
// retrieval returns, a macro is the short form of one a human sends by hand,
// and a deflection is the record of whether the retrieval answered the customer
// or a person had to. Splitting them would put the containment ratio
// (docs/modules/orbit.md §7) in a file that cannot see either numerator.
//
// Retrieval is VEC_KB when the index is bound and a deterministic lexical score
// when it is not. The fallback is not a placeholder: tests, on-prem
// (ops/docker-compose.yml has no Vectorize) and any tenant whose articles were
// written before the index existed all run on it, so it has to answer honestly
// rather than return nothing. `via` on every result and every logged deflection
// says which one answered — a retrieval quality question is unanswerable
// without it.
//
// This is also VEC_KB's first *reader*. `routes/axis.ts:344` has been embedding
// extracted document text into it since the index was bound and nothing ever
// queried it (docs/27 F52 is the same shape on VEC_MARKET), which is why the
// query below filters on `kind`: the index holds two populations now.

/** Score at or above which an answer is good enough to send to a customer unaccompanied. */
export const DEFLECT_MIN_SCORE = 30;

/** How many articles retrieval hands back. */
const TOP_K = 3;

/**
 * Words too common to carry a topic. Kept tiny and bilingual on purpose: a long
 * stop list is a language model in disguise, and the score below already
 * discounts a term by how ordinary it is across the query.
 */
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "in", "on", "is", "are", "do", "does", "how", "what", "my", "i",
  "you", "your", "it", "this", "that", "with", "can", "me", "we",
  "في", "من", "على", "الى", "إلى", "عن", "هل", "ما", "هذا", "هذه", "كيف", "و"
]);

/** Lowercased word-ish tokens, stop words dropped. Arabic and Latin both fall out of the same class split. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

export interface ScorableArticle {
  title: string;
  body: string;
}

/**
 * 0..100, how well an article answers a question.
 *
 * Deliberately pure and deliberately simple: it is the fallback retrieval, the
 * tie-break on vector matches, and the number written to
 * `orbit_deflections.score`, so it has to be the same function in all three
 * places and reproducible from the row afterwards. A title hit weighs more than
 * a body hit because a title is what an article is *about* — a body mentions
 * many things it does not answer.
 */
export function scoreArticle(query: string, article: ScorableArticle): number {
  const asked = new Set(tokens(query));
  if (!asked.size) return 0;
  const title = new Set(tokens(article.title));
  const body = new Set(tokens(article.body));

  let hit = 0;
  for (const term of asked) {
    if (title.has(term)) hit += 1;
    else if (body.has(term)) hit += 0.4;
  }
  return Math.min(100, Math.round((hit / asked.size) * 100));
}

type ArticleRow = typeof schema.orbitKbArticles.$inferSelect;

export interface KbHit {
  article: ArticleRow;
  score: number;
  via: "vector" | "lexical";
}

/**
 * Published articles in the reader's language, best first. A draft is never
 * retrievable — that is what draft means — and neither is another locale's
 * article, because an English answer sent into an Arabic conversation is a
 * worse outcome than no answer (CLAUDE.md rule 7).
 */
export async function searchKb(
  ctx: Ctx,
  gateway: Gateway,
  index: VectorizeIndex | undefined,
  opts: { query: string; locale: string; limit?: number }
): Promise<KbHit[]> {
  const limit = opts.limit ?? TOP_K;
  const published = await ctx.db
    .select()
    .from(schema.orbitKbArticles)
    .where(
      scoped(
        ctx,
        schema.orbitKbArticles,
        eq(schema.orbitKbArticles.status, "published"),
        eq(schema.orbitKbArticles.locale, opts.locale)
      )
    );
  if (!published.length) return [];

  const matches = await embedQuery(ctx, gateway, index, {
    module: "orbit",
    purpose: "orbit.kb.search",
    text: opts.query,
    topK: limit,
    filter: { tenantId: ctx.tenantId, kind: "kb_article", locale: opts.locale }
  });

  if (matches.length) {
    const byId = new Map(published.map((a) => [a.id, a]));
    const hits: KbHit[] = [];
    for (const match of matches) {
      const article = byId.get(match.id);
      // A vector id whose row is gone, unpublished or in another language is
      // not a hit: the index is eventually consistent with D1, and the rows
      // above are the authority on what may be sent.
      if (!article) continue;
      hits.push({ article, score: Math.min(100, Math.round(match.score * 100)), via: "vector" });
    }
    if (hits.length) return hits.slice(0, limit);
  }

  return published
    .map((article): KbHit => ({ article, score: scoreArticle(opts.query, article), via: "lexical" }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || (a.article.id < b.article.id ? -1 : 1))
    .slice(0, limit);
}

/**
 * Publish an article and put it in the index under its own row id, so a
 * retrieved vector maps back to a row with one lookup and no join table.
 * Embedding is best-effort by construction — `embedUpsert` is a no-op when no
 * index is bound — and a `vectorId` of null then honestly says "this row is
 * only reachable lexically".
 */
export async function publishArticle(
  ctx: Ctx,
  gateway: Gateway,
  index: VectorizeIndex | undefined,
  articleId: string
): Promise<ArticleRow> {
  const [article] = await ctx.db
    .select()
    .from(schema.orbitKbArticles)
    .where(scoped(ctx, schema.orbitKbArticles, eq(schema.orbitKbArticles.id, articleId)))
    .limit(1);
  if (!article) throw notFound("article");
  require_(ctx.actor, "orbit:kb:write", { tenantId: ctx.tenantId, module: "orbit" });

  const vectorId = await embedUpsert(ctx, gateway, index, {
    module: "orbit",
    purpose: "orbit.kb.embed",
    id: article.id,
    text: `${article.title}\n\n${article.body}`,
    metadata: { tenantId: ctx.tenantId, kind: "kb_article", locale: article.locale }
  });

  await ctx.db
    .update(schema.orbitKbArticles)
    .set({
      status: "published",
      vectorId: vectorId ?? null,
      updatedBy: `${ctx.actor.kind}:${ctx.actor.id}`,
      updatedAt: ctx.now
    })
    .where(scoped(ctx, schema.orbitKbArticles, eq(schema.orbitKbArticles.id, articleId)));

  await audit(ctx, {
    action: "orbit.kb.published",
    subjectRef: articleId,
    before: { status: article.status },
    after: { status: "published", vectorId: vectorId ?? null }
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.kb.published",
    subject: articleId,
    data: { articleId, key: article.key, locale: article.locale }
  });
  return { ...article, status: "published", vectorId: vectorId ?? null };
}

export interface DeflectResult {
  outcome: "deflected" | "escalated";
  articleId: string | null;
  score: number;
  via: "vector" | "lexical";
  messageId: string | null;
}

/**
 * Try to answer a customer's question from the knowledge base.
 *
 * Two rules keep this from being a worse experience than no deflection at all.
 * A conversation a human already holds is never deflected — a bot talking over
 * an agent mid-thread is the failure mode every service desk has — and a miss
 * is logged as loudly as a hit, because containment % (§7) is a ratio and a log
 * that only kept the wins would report 100% forever.
 */
export async function deflect(
  ctx: Ctx,
  gateway: Gateway,
  index: VectorizeIndex | undefined,
  input: { conversationId: string; question: string }
): Promise<DeflectResult> {
  const [conversation] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, input.conversationId)))
    .limit(1);
  if (!conversation) throw notFound("conversation");
  require_(ctx.actor, "orbit:conversations:reply", { tenantId: ctx.tenantId, module: "orbit" });

  const hits =
    conversation.state === "bot"
      ? await searchKb(ctx, gateway, index, { query: input.question, locale: conversation.lang })
      : [];
  const best = hits[0];
  const deflected = Boolean(best && best.score >= DEFLECT_MIN_SCORE);

  let messageId: string | null = null;
  if (deflected && best) {
    messageId = newId("msg", ctx.now);
    await ctx.db.insert(schema.orbitMessages).values({
      id: messageId,
      tenantId: ctx.tenantId,
      conversationId: input.conversationId,
      role: "agent_ai",
      modality: "text",
      content: best.article.body,
      ts: ctx.now
    });
    await ctx.db
      .update(schema.orbitConversations)
      .set({ lastMessageAt: ctx.now, updatedAt: ctx.now })
      .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, input.conversationId)));
  }

  const result: DeflectResult = {
    outcome: deflected ? "deflected" : "escalated",
    articleId: deflected && best ? best.article.id : null,
    score: best?.score ?? 0,
    via: best?.via ?? "lexical",
    messageId
  };

  await ctx.db.insert(schema.orbitDeflections).values({
    id: newId("dfl", ctx.now),
    tenantId: ctx.tenantId,
    conversationId: input.conversationId,
    question: input.question,
    articleId: result.articleId,
    score: result.score,
    outcome: result.outcome,
    via: result.via,
    ts: ctx.now
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.conversation.deflected",
    subject: input.conversationId,
    data: { conversationId: input.conversationId, ...result }
  });
  return result;
}

/**
 * Send a canned reply. `agent_human`, not `agent_ai`: a macro is wording a
 * person chose and a person is accountable for, and the transcript must not
 * later read as though the model wrote it.
 */
export async function applyMacro(
  ctx: Ctx,
  input: { conversationId: string; macroKey: string }
): Promise<{ messageId: string; locale: string }> {
  require_(ctx.actor, "orbit:conversations:reply", { tenantId: ctx.tenantId, module: "orbit" });

  const [conversation] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, input.conversationId)))
    .limit(1);
  if (!conversation) throw notFound("conversation");

  const [macro] = await ctx.db
    .select()
    .from(schema.orbitMacros)
    .where(scoped(ctx, schema.orbitMacros, eq(schema.orbitMacros.key, input.macroKey)))
    .limit(1);
  if (!macro) throw notFound("macro");
  // A disabled macro is wording that was withdrawn — usually because it was
  // wrong or non-compliant — so it is refused rather than sent.
  if (macro.status !== "active") throw conflict(`macro is ${macro.status}`);

  const bodies = JSON.parse(macro.bodyJson) as Record<string, string | undefined>;
  const body = bodies[conversation.lang] ?? bodies.en;
  if (!body) throw conflict(`macro ${macro.key} has no wording in ${conversation.lang} or en`);

  const messageId = newId("msg", ctx.now);
  await ctx.db.insert(schema.orbitMessages).values({
    id: messageId,
    tenantId: ctx.tenantId,
    conversationId: input.conversationId,
    role: "agent_human",
    modality: "text",
    content: body,
    ts: ctx.now
  });
  await ctx.db
    .update(schema.orbitConversations)
    .set({ lastMessageAt: ctx.now, updatedAt: ctx.now })
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, input.conversationId)));
  // Incremented in SQL rather than read-modify-written: two agents sending the
  // same macro in the same second must count twice.
  await ctx.db
    .update(schema.orbitMacros)
    .set({ usageCount: sql`${schema.orbitMacros.usageCount} + 1`, updatedAt: ctx.now })
    .where(scoped(ctx, schema.orbitMacros, eq(schema.orbitMacros.id, macro.id)));

  await audit(ctx, {
    action: "orbit.macro.applied",
    subjectRef: input.conversationId,
    after: { macroKey: macro.key, locale: bodies[conversation.lang] ? conversation.lang : "en" }
  });
  return { messageId, locale: bodies[conversation.lang] ? conversation.lang : "en" };
}

/** Scoped helper for the analytics read behind the containment chip. */
export async function containment(ctx: Ctx, sinceTs: number): Promise<{ deflected: number; escalated: number }> {
  const rows = await ctx.db
    .select({ outcome: schema.orbitDeflections.outcome })
    .from(schema.orbitDeflections)
    .where(scoped(ctx, schema.orbitDeflections, sql`${schema.orbitDeflections.ts} >= ${sinceTs}`));
  return {
    deflected: rows.filter((r) => r.outcome === "deflected").length,
    escalated: rows.filter((r) => r.outcome === "escalated").length
  };
}

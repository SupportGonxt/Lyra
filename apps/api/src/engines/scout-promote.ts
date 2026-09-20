import { and, eq, isNull, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  actorRef,
  assertWhitespaceTransition,
  audit,
  checkKAnonymity,
  conflict,
  emit,
  gate,
  kAnonymityFloor,
  notFound,
  type Ctx
} from "@lyra/core";
import {
  fallbackWhitespaceBrief,
  parseWhitespaceBrief,
  promptNouns,
  whitespaceBriefMessages,
  whitespaceBriefSchema,
  creativeContextLines,
  type CampaignPlan,
  type CampaignPlanEvidence,
  type Gateway,
  type PlanAudience,
  type WhitespaceBrief,
  type WhitespaceEvidence
} from "@lyra/model-gateway";
import { cellSize, clusterSizes, coveragePerLine } from "./scout-whitespace.js";

// docs/modules/scout.md §4 ("whitespace approvals (promote/park)") ->
// docs/specs/gap-signal-design.md §1523, which already catalogues
// `scout.whitespace.promoted` as consumed by SIGNAL: "offers a brief". This is
// the emitter that was specified and never written.
//
// docs/19 §2 shape, non-financial (⊘ — no journal lines, no money moves): an
// idempotency key, a state machine hop, an approval gate, an audit row and one
// event. SIGNAL is reached through the bus and through its own creative engine,
// never by promoting straight into someone else's tables (CLAUDE.md rule 6).

export interface PromoteResult {
  /** Terminal state of the transaction. Only ever "committed" in a response body:
   *  a promotion still waiting on its approval never returns one — `gate` throws
   *  403 `approval_required` — so a caller can trust this to mean it happened. */
  state: "committed";
  whitespaceId: string;
  campaignId: string;
  /** How many creative drafts were written. None was sent. */
  drafts: number;
  brief: WhitespaceBrief;
  /** Whether the brief came from the model or the deterministic fallback. */
  briefSource: "ai" | "fallback";
  /** The gateway audit row for the brief call; null when the fallback was used. */
  briefAuditId: string | null;
  creatives: { id: string; locale: string; complianceStatus: string }[];
  /** Every ai_audit_log id this promotion produced — brief, pool, one per locale. */
  auditIds: string[];
  /** The targeting pool the campaign was aimed at. Null when the tenant has no
   *  attributes above the k-anonymity floor. The bands and the reasons behind
   *  them hang off the audience row itself, which SIGNAL owns. */
  audience: SuggestedAudience | null;
  /** The three ranked options the campaign was planned against, the notes
   *  behind them, and which one the copy was written for. */
  plan: CampaignPlan;
  /** Whether the plan came from the model or the deterministic fallback. */
  planSource: "ai" | "fallback";
}

/** Six drafts (three per locale) — enough for a human to pick from, far short of
 *  the 20 a real campaign brief asks for, because nobody has approved a spend yet. */
const DRAFT_VARIANTS = 6;

export async function promoteWhitespace(
  ctx: Ctx,
  gateway: Gateway,
  generateCreatives: CreativeGenerator,
  suggestAudience: AudienceSuggester,
  planCampaign: CampaignPlanner,
  whitespaceId: string
): Promise<PromoteResult> {
  const rows = await ctx.db
    .select({
      id: schema.scoutWhitespaces.id,
      category: schema.scoutWhitespaces.category,
      status: schema.scoutWhitespaces.status,
      demandEstimate: schema.scoutWhitespaces.demandEstimate,
      competitionScore: schema.scoutWhitespaces.competitionScore,
      clusterId: schema.scoutWhitespaces.clusterId,
      evidenceRefsJson: schema.scoutWhitespaces.evidenceRefsJson
    })
    .from(schema.scoutWhitespaces)
    .where(and(eq(schema.scoutWhitespaces.tenantId, ctx.tenantId), eq(schema.scoutWhitespaces.id, whitespaceId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw notFound("whitespace");
  if (!row.category) throw conflict("whitespace has no category to brief against");

  // The hop is checked before the approval is asked for: an already-promoted
  // candidate is a 409, not a pending approval someone then has to decline.
  assertWhitespaceTransition(row.status, "validated");

  const signalCount = cellSize(row, await clusterSizes(ctx, [row.clusterId]));
  // A brief built from a thin cell would restate a handful of quotes as market
  // demand, and every creative variant would carry it outward (docs/scout §2.5).
  if (!checkKAnonymity(signalCount, kAnonymityFloor(ctx.policy, "scout")).allowed) {
    throw conflict("whitespace evidence is below the k-anonymity floor");
  }

  // CLAUDE.md rule 4 / docs/19: promotion commits the tenant to a campaign, so
  // it needs the existing scout.whitespace_promote approval — the same policy the
  // CRUD update path gates on, with the same `whitespaces:<id>` subjectRef, so one
  // pending approval serves both routes rather than two queues for one decision.
  await gate(ctx, {
    policyKey: "scout.whitespace_promote",
    subjectRef: `whitespaces:${whitespaceId}`,
    context: { category: row.category, momentum: row.demandEstimate ?? 0 }
  });

  const coverageByLine = await coveragePerLine(ctx);
  const ev: WhitespaceEvidence = {
    category: row.category,
    momentum: row.demandEstimate ?? 0,
    coverage: coverageByLine.get(row.category) ?? 0,
    competitionScore: row.competitionScore,
    signalCount
  };

  const drafted = await draftBrief(ctx, gateway, ev);

  // Who the campaign is for, argued from the book's own attribute counts. Same
  // doctrine as the brief: a tenant that has tagged nobody, or a model call
  // that fails, leaves the campaign with a null audience for a human to fill
  // in - it does not cost them the promotion. The pool is a draft either way;
  // nothing is sent off the back of it.
  const audience = await suggestAudience(ctx, gateway, {
    subject: ev.category,
    momentum: ev.momentum,
    signalCount: ev.signalCount
  }).catch(() => null);

  // What to argue, in three ranked options with a probability each and the
  // reasons behind it. Same doctrine again: a model failure leaves the
  // deterministic plan at confidence 0, and nothing here is a spend — the
  // options exist so a human funds one on an argument rather than on a vibe.
  const planEv: CampaignPlanEvidence = {
    subject: ev.category,
    objective: drafted.brief.objective,
    proposition: drafted.brief.proposition,
    momentum: ev.momentum,
    signalCount: ev.signalCount,
    coverage: ev.coverage,
    competitionScore: ev.competitionScore,
    bookSize: await bookSize(ctx),
    audience: audience?.proposal ?? null
  };
  const planned = await planCampaign(ctx, gateway, planEv);

  const campaignId = newId("cmp", ctx.now);
  await ctx.db.insert(schema.signalCampaigns).values({
    id: campaignId,
    tenantId: ctx.tenantId,
    name: drafted.brief.name,
    objective: drafted.brief.objective,
    audienceId: audience?.audienceId ?? null,
    // No channel and no budget: those are spend decisions, and this route only
    // creates the draft a human then funds (signal.budget_commit gates that).
    channelsJson: "[]",
    budgetJson: JSON.stringify({ currency: ctx.policy.currency, dailyMinor: 0, totalMinor: 0 }),
    state: "draft",
    planJson: JSON.stringify(planned.plan),
    guardrailChecksJson: null,
    autonomyLevel: ctx.policy.autonomyDefault,
    startAt: null,
    endAt: null,
    ownerRef: actorRef(ctx),
    createdAt: ctx.now,
    updatedAt: ctx.now
  } as never);

  // ponytail: provenance rides `variantGroup` (= the whitespace id) plus the
  // audit row and the event, because signal_campaigns has no whitespace_id
  // column. Upgrade path is that column; then this comment and the variantGroup
  // convention both go away and the join is direct.
  //
  // Same doctrine as `draftBrief` below (docs/15 §4 — AI drafts, it does not
  // gate): a generator failure leaves the promotion with the drafts it managed
  // to write, not a 500. The campaign, the state hop, the audit row and the
  // event carry no model output, and the tray reads "Handed over. Nothing
  // drafted yet." when the count is zero.
  const generated = await generateCreatives(ctx, gateway, {
    campaignId,
    kind: "ad",
    brief: `${drafted.brief.proposition}\n\n${drafted.brief.brief}`,
    // Why the plan is worth writing down: the copy is generated against the
    // recommended option's angle and offer and the bands the pool is made of,
    // so it speaks to a specific group about a specific idea rather than to
    // "customers" about a category noun.
    context: creativeContextLines(planned.plan, planned.plan.recommended, planEv.audience),
    variantGroup: whitespaceId,
    count: DRAFT_VARIANTS
  }).catch(partialOf);

  await ctx.db
    .update(schema.scoutWhitespaces)
    .set({ status: "validated", promotedAt: ctx.now, owner: actorRef(ctx), updatedAt: ctx.now })
    .where(and(eq(schema.scoutWhitespaces.tenantId, ctx.tenantId), eq(schema.scoutWhitespaces.id, whitespaceId)));

  await audit(ctx, {
    action: "scout.whitespace.promoted",
    subjectRef: whitespaceId,
    before: { status: row.status },
    after: {
      status: "validated",
      campaignId,
      briefSource: drafted.source,
      briefAuditId: drafted.auditId,
      audienceId: audience?.audienceId ?? null,
      planSource: planned.source,
      planRecommended: planned.plan.recommended,
      planConfidence: planned.plan.confidence,
      creatives: generated.variants.length
    }
  });

  // docs/04 §7 envelope, built by `emit`. SIGNAL (and anything else listening)
  // learns about the promotion here rather than through a cross-module import.
  await emit(ctx, {
    module: "scout",
    type: "scout.whitespace.promoted",
    subject: whitespaceId,
    data: {
      campaignId,
      category: ev.category,
      objective: drafted.brief.objective,
      momentum: ev.momentum,
      coverage: ev.coverage,
      signalCount: ev.signalCount,
      briefSource: drafted.source,
      planSource: planned.source,
      planRecommended: planned.plan.recommended
    }
  });

  return {
    state: "committed",
    whitespaceId,
    campaignId,
    drafts: generated.variants.length,
    brief: drafted.brief,
    briefSource: drafted.source,
    briefAuditId: drafted.auditId,
    creatives: generated.variants.map((v) => ({
      id: v.id,
      locale: v.locale,
      complianceStatus: v.complianceStatus
    })),
    audience,
    plan: planned.plan,
    planSource: planned.source,
    auditIds: [
      ...(drafted.auditId ? [drafted.auditId] : []),
      ...(audience?.auditId ? [audience.auditId] : []),
      ...(planned.auditId ? [planned.auditId] : []),
      ...generated.auditIds
    ]
  };
}

/**
 * The brief, through the gateway (CLAUDE.md rule 3 — module/purpose/tier/actor,
 * one ai_audit_log row) and through the strict parser. A gateway failure or an
 * unparseable/ungrounded reply falls back to the deterministic brief rather than
 * aborting: docs/15 §4 — AI drafts, it does not gate. The caller still gets to
 * see which happened via `source`, and a fallback carries confidence 0.
 */
async function draftBrief(
  ctx: Ctx,
  gateway: Gateway,
  ev: WhitespaceEvidence
): Promise<{ brief: WhitespaceBrief; source: "ai" | "fallback"; auditId: string | null }> {
  const nouns = promptNouns(ctx.policy.domainPack);
  try {
    const res = await gateway.complete(ctx, {
      module: "scout",
      purpose: "whitespace.brief",
      tier: "reasoning",
      subjectRef: ev.category,
      responseSchema: whitespaceBriefSchema(),
      messages: whitespaceBriefMessages(ev, nouns)
    });
    const brief = parseWhitespaceBrief(res.text, ev, nouns);
    return brief
      ? { brief, source: "ai", auditId: res.auditId }
      : { brief: fallbackWhitespaceBrief(ev, nouns), source: "fallback", auditId: res.auditId };
  } catch {
    return { brief: fallbackWhitespaceBrief(ev, nouns), source: "fallback", auditId: null };
  }
}

/**
 * SIGNAL's creative generator, passed in rather than imported.
 *
 * Not a speculative seam: `generateCreatives` lives in apps/api/src/engines/
 * signal-creative.ts and calling it from a SCOUT engine is the cross-module
 * import CLAUDE.md rule 6 forbids. The route supplies it, so the dependency
 * points at the composition root instead of sideways between modules — and the
 * promote tests get to assert what the brief handed the generator without a
 * live model.
 */
export type CreativeGenerator = (
  ctx: Ctx,
  gateway: Gateway,
  brief: {
    campaignId: string;
    kind: "ad";
    brief: string;
    context: string[];
    variantGroup: string;
    count: number;
  }
) => Promise<CreativeResult>;

/**
 * SIGNAL's audience suggester, passed in for exactly the reason
 * `CreativeGenerator` is: `suggestTargeting` lives in apps/api/src/engines/
 * signal-audience.ts and importing it here would be the cross-module import
 * CLAUDE.md rule 6 forbids. The route composes the two.
 */
export type AudienceSuggester = (
  ctx: Ctx,
  gateway: Gateway,
  subject: { subject: string; momentum: number | null; signalCount: number | null }
) => Promise<SuggestedAudience>;

/**
 * SIGNAL's campaign planner, injected for the reason the other two seams are:
 * `planCampaign` lives in apps/api/src/engines/signal-campaign-plan.ts and
 * importing it here would be the cross-module import CLAUDE.md rule 6 forbids.
 */
export type CampaignPlanner = (
  ctx: Ctx,
  gateway: Gateway,
  ev: CampaignPlanEvidence
) => Promise<{ plan: CampaignPlan; source: "ai" | "fallback"; auditId: string | null }>;

/** Mirrors `SuggestedAudience` in signal-audience.ts, structurally - SCOUT may
 *  not import the SIGNAL engine, and only reads what it forwards: the two ids,
 *  and the pool itself, which the plan is argued against. */
export interface SuggestedAudience {
  audienceId: string;
  auditId: string | null;
  proposal: PlanAudience;
}

/**
 * Customers on the book, for the plan's denominator.
 *
 * ponytail: a second count rather than a figure threaded out of the audience
 * suggester, because the suggester refuses a book with nothing above the
 * k-anonymity floor and the plan still needs a book size when it does. Erased
 * people are excluded here for the same reason they are excluded there — the
 * denominator a human reads is a count of people who exist.
 */
async function bookSize(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.customers)
    .where(and(eq(schema.customers.tenantId, ctx.tenantId), isNull(schema.customers.deletedAt)));
  return rows[0]?.n ?? 0;
}

interface CreativeResult {
  variants: { id: string; locale: string; complianceStatus: string }[];
  auditIds: string[];
}

/**
 * What survived a generator rejection.
 *
 * The generator writes a row per variant as it parses them and has no
 * transaction to roll back (one model call per locale, the first locale's rows
 * committed before the second call is made), so a rejection can still leave
 * drafts in the table. It says so by hanging a `partial` off the error — read
 * here by shape, not by `instanceof`: the class lives in a SIGNAL engine and
 * importing it is the cross-module import CLAUDE.md rule 6 forbids, which is
 * why the generator itself arrives injected. No partial, or a shape that does
 * not match: nothing was written, so nothing is reported.
 */
function partialOf(err: unknown): CreativeResult {
  const partial = (err as { partial?: unknown } | null)?.partial as CreativeResult | undefined;
  return Array.isArray(partial?.variants) && Array.isArray(partial?.auditIds)
    ? partial
    : { variants: [], auditIds: [] };
}

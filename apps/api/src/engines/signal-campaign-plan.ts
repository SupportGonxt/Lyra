import { and, eq } from "drizzle-orm";
import {
  campaignPlanMessages,
  campaignPlanSchema,
  creativeContextLines,
  fallbackCampaignPlan,
  parseCampaignPlan,
  knowledgeBlock,
  promptNouns,
  type CampaignPlan,
  type CampaignPlanEvidence,
  type CampaignChannel,
  type CampaignOption,
  type DemographicReason,
  type PlanAudience,
  CAMPAIGN_CHANNELS,
  type Gateway
} from "@lyra/model-gateway";
import { schema } from "@lyra/db";
import { taxMarketOf, type Ctx } from "@lyra/core";

// The three-option campaign plan a promotion argues before a line of copy is
// written: the planner's notes, three ranked approaches each with a
// probability of success and the reasons behind it, and the one the copy is
// then written against.
//
// Nothing here is consequential (CLAUDE.md rule 4): a plan is an argument, not
// a spend. A human funds the option, and the creative that ships still passes
// its own approval. What the plan does buy is an inspectable "why" — docs/15 §4
// — on a number a marketer would otherwise be asked to take on trust.

export interface PlannedCampaign {
  plan: CampaignPlan;
  /** Whether the plan came from the model or the deterministic fallback. */
  source: "ai" | "fallback";
  /** The gateway audit row; null when the call itself failed. */
  auditId: string | null;
}

/**
 * Plan, through the gateway (CLAUDE.md rule 3 — module/purpose/tier/actor, one
 * ai_audit_log row) and through the strict parser.
 *
 * Mirrors `proposePool` in signal-audience.ts and `draftBrief` in
 * scout-promote.ts, for the same reason: an unparseable, ungrounded or
 * wholly-rejected reply degrades to the deterministic three-option plan at
 * confidence 0 rather than 500ing at a marketer mid-promotion.
 */
export async function planCampaign(
  ctx: Ctx,
  gateway: Gateway,
  ev: CampaignPlanEvidence
): Promise<PlannedCampaign> {
  const nouns = promptNouns(ctx.policy.domainPack);
  // The planner reasons inside the tenant's own world: its market's language,
  // its disclosure rules, how an aggregator earns (packages/model-gateway/src
  // /knowledge.ts). Context, not evidence — the prompt says so, and none of it
  // reaches `verifyGroundedness`, so a knowledge fact can never be cited as
  // though the tenant's data had stated it.
  const knowledge = knowledgeBlock(ctx.policy.domainPack, { markets: [taxMarketOf(ctx)] });
  try {
    const res = await gateway.complete(ctx, {
      module: "signal",
      purpose: "campaign.plan",
      tier: "reasoning",
      subjectRef: ev.subject,
      responseSchema: campaignPlanSchema(),
      messages: campaignPlanMessages(ev, nouns, knowledge)
    });
    const plan = parseCampaignPlan(res.text, ev, nouns);
    return plan
      ? { plan, source: "ai", auditId: res.auditId }
      : { plan: fallbackCampaignPlan(ev, nouns), source: "fallback", auditId: res.auditId };
  } catch {
    return { plan: fallbackCampaignPlan(ev, nouns), source: "fallback", auditId: null };
  }
}

/* ------------------------------------------------ reading a plan back out */

/** A row written by a model a year ago is not a schema. Bad JSON is no plan. */
function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** An option is only usable if it says what to argue and where to argue it. */
function storedOption(raw: unknown): CampaignOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // A channel nobody can buy is not a channel: an option is only runnable
  // through the same vocabulary the planner validated against.
  const channels = (Array.isArray(o.channels) ? o.channels : []).filter((c): c is CampaignChannel =>
    (CAMPAIGN_CHANNELS as readonly unknown[]).includes(c)
  );
  if (typeof o.name !== "string" || !o.name || typeof o.angle !== "string" || channels.length === 0) return null;
  return {
    name: o.name,
    angle: o.angle,
    offer: typeof o.offer === "string" ? o.offer : "",
    channels,
    probability: typeof o.probability === "number" && Number.isFinite(o.probability) ? o.probability : 0,
    why: Array.isArray(o.why) ? o.why.filter((w): w is string => typeof w === "string") : [],
    risk: typeof o.risk === "string" ? o.risk : null
  };
}

/**
 * The plan a campaign was argued from, off `signal_campaigns.plan_json`.
 *
 * Tolerant for the same reason the studio's reader is (apps/web's
 * signal.shared.ts `planOf`, which is this function's mirror): the column holds
 * a model artifact that may be a year old, and one malformed option costs that
 * option rather than the copy. Null when nothing runnable survives, which is
 * also what a hand-typed campaign that never planned looks like.
 */
export function storedPlan(raw: unknown): CampaignPlan | null {
  const bag = asRecord(typeof raw === "string" ? tryParse(raw) : raw);
  if (!bag) return null;
  const options = (Array.isArray(bag.options) ? bag.options : [])
    .map(storedOption)
    .filter((o): o is CampaignOption => o !== null);
  if (options.length === 0) return null;
  const recommended =
    typeof bag.recommended === "string" && options.some((o) => o.name === bag.recommended)
      ? bag.recommended
      : options[0]!.name;
  return {
    notes: typeof bag.notes === "string" ? bag.notes : "",
    options,
    recommended,
    confidence: typeof bag.confidence === "number" && Number.isFinite(bag.confidence) ? bag.confidence : 0
  };
}

/**
 * The pool a campaign targets, rebuilt from the audience row.
 *
 * `suggestTargeting` parks the whole proposal under `definitionJson.targeting`
 * alongside the rule the resolver runs, so the bands and the reason each was
 * chosen survive a reload. Null for an audience somebody wrote by hand: it has
 * a rule but no argument, and inventing one for the prompt would put words in
 * a human's mouth.
 */
export async function planAudience(ctx: Ctx, audienceId: string | null): Promise<PlanAudience | null> {
  if (!audienceId) return null;
  const rows = await ctx.db
    .select()
    .from(schema.signalAudiences)
    .where(and(eq(schema.signalAudiences.tenantId, ctx.tenantId), eq(schema.signalAudiences.id, audienceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const t = asRecord(asRecord(tryParse(row.definitionJson))?.targeting);
  if (!t) return null;
  return {
    name: row.name,
    summary: typeof t.summary === "string" ? t.summary : row.name,
    estimatedReach: typeof t.estimatedReach === "number" ? t.estimatedReach : (row.sizeCached ?? 0),
    // The pack names the scale the stored bands are on (ADR-0069). Read live
    // rather than off the row: a tenant that switches pack should not have last
    // month's audience still calling its bands LSM.
    pack: ctx.policy.domainPack,
    lsm: Array.isArray(t.lsm) ? t.lsm.filter((n): n is number => typeof n === "number") : [],
    reasons: (Array.isArray(t.reasons) ? t.reasons : []).flatMap((raw): DemographicReason[] => {
      const r = asRecord(raw);
      if (!r || typeof r.axis !== "string" || typeof r.value !== "string" || typeof r.reason !== "string") return [];
      return [
        {
          axis: r.axis,
          value: r.value,
          reason: r.reason,
          count: typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 0
        }
      ];
    })
  };
}

/**
 * The plan and the pool, flattened to the sentences the copy generator prompts
 * with. Empty when the campaign was never planned — copy then comes from the
 * brief alone, exactly as it did before campaigns had plans.
 */
export async function creativeContextFor(
  ctx: Ctx,
  campaign: { planJson?: string | null; audienceId?: string | null }
): Promise<string[]> {
  const plan = storedPlan(campaign.planJson ?? null);
  if (!plan) return [];
  return creativeContextLines(plan, plan.recommended, await planAudience(ctx, campaign.audienceId ?? null));
}


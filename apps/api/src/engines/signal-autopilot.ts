import { and, desc, eq, gte, inArray, isNull, lt } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { AUTOPILOT_LEVELS, audit, emit, gate, AppError, type Ctx } from "@lyra/core";
import { pushBudgetMove, type AdPlatforms } from "./signal-ad-platforms.js";

// docs/modules/signal.md §2.3 "autopilot" — CAC/LTV-driven budget reallocation
// with a bound check, an anomaly guard, and a daily trigger. Same shape as
// renewals.ts: pure scoring/decision functions, one impure sweep.

const DAY_MS = 86_400_000;

/** Trailing spend/attribution window the CAC/LTV computation looks over. */
const CAC_WINDOW_DAYS = 7;
const LTV_WINDOW_DAYS = 30;

/** Minimum CAC gap (cheapest vs priciest channel) before a move is worth making. */
const MIN_GAP_BPS = 1_000; // 10%

/**
 * ponytail: move a flat 20% of the pricier channel's window spend. A real
 * sizing rule would fit the marginal CAC curve per channel; a fixed fraction
 * is the smallest thing that produces a bounded, explainable move. Upgrade
 * path: replace with a marginal-CAC-curve fit if a tenant's spend swings hard
 * enough that 20% either overshoots or is too timid.
 */
const REALLOCATE_FRACTION = 0.2;

/** Last N moves for a campaign the anomaly guard compares a proposal against. */
const ANOMALY_HISTORY_LIMIT = 10;
const ANOMALY_Z_THRESHOLD = 3;

/**
 * ponytail: hardcoded fallback when a campaign's budgetJson carries no
 * autopilotBoundMinor — matches the smallest bound the SIGNAL seed narrative
 * uses (AED 1,000). No new config plumbing invented for this; a tenant-level
 * default is the upgrade path if that ever proves too coarse.
 */
const DEFAULT_BOUND_MINOR = 100_000;

const EVAL_ACTION = "signal.autopilot.evaluated";

export interface ChannelCac {
  readonly channel: string;
  readonly spendMinor: number;
  readonly conversions: number;
  /** Infinity when the channel spent money but produced zero conversions. */
  readonly cacMinor: number;
}

/** Customer acquisition cost per channel: spend / conversions, summed over whatever rows are passed in. */
export function computeChannelCac(
  spend: readonly { channel: string; amountMinor: number; conversions: number }[]
): ChannelCac[] {
  const byChannel = new Map<string, { spendMinor: number; conversions: number }>();
  for (const row of spend) {
    const e = byChannel.get(row.channel) ?? { spendMinor: 0, conversions: 0 };
    e.spendMinor += row.amountMinor;
    e.conversions += row.conversions;
    byChannel.set(row.channel, e);
  }
  return [...byChannel.entries()].map(([channel, e]) => ({
    channel,
    spendMinor: e.spendMinor,
    conversions: e.conversions,
    cacMinor: e.conversions > 0 ? Math.round(e.spendMinor / e.conversions) : Infinity
  }));
}

/** Lifetime value: the average bound value over the supplied bind events, 0 with none. */
export function computeLtv(bindValuesMinor: readonly number[]): number {
  if (!bindValuesMinor.length) return 0;
  return Math.round(bindValuesMinor.reduce((a, b) => a + b, 0) / bindValuesMinor.length);
}

export type AutopilotDecision = "act" | "act_with_approval";

/**
 * ponytail: bound-inclusive — a move landing exactly on the bound still
 * auto-executes. Cross-referenced against every seed move: none sits exactly
 * on a bound, so this is a genuine (not seed-derived) call; recorded in
 * docs/decisions/ADR-0012.
 */
export function boundCheck(amountMinor: number, boundMinor: number): AutopilotDecision {
  return amountMinor <= boundMinor ? "act" : "act_with_approval";
}

export interface AnomalyResult {
  readonly isAnomaly: boolean;
  readonly mean: number;
  readonly stdev: number;
  readonly zScore: number;
}

/**
 * Deterministic rolling mean/stdev check against a campaign's recent move
 * amounts (docs/modules/signal.md §2.3 "anomaly guard"). ponytail: a fixed
 * z-score cutoff over the last N moves, no seasonality/day-of-week model —
 * upgrade path if the flag rate on real traffic ever proves too noisy.
 */
export function anomalyGuard(proposedAmountMinor: number, recentAmountsMinor: readonly number[]): AnomalyResult {
  if (recentAmountsMinor.length < 2) {
    return { isAnomaly: false, mean: recentAmountsMinor[0] ?? proposedAmountMinor, stdev: 0, zScore: 0 };
  }
  const mean = recentAmountsMinor.reduce((a, b) => a + b, 0) / recentAmountsMinor.length;
  const variance = recentAmountsMinor.reduce((a, b) => a + (b - mean) ** 2, 0) / recentAmountsMinor.length;
  const stdev = Math.sqrt(variance);
  const zScore = stdev === 0 ? (proposedAmountMinor === mean ? 0 : Infinity) : Math.abs(proposedAmountMinor - mean) / stdev;
  return { isAnomaly: zScore > ANOMALY_Z_THRESHOLD, mean, stdev, zScore };
}

export interface ReallocationProposal {
  readonly fromChannel: string;
  readonly toChannel: string;
  readonly amountMinor: number;
  readonly cac: readonly ChannelCac[];
}

/** Propose shifting spend from the priciest priced channel to the cheapest, if the gap clears MIN_GAP_BPS. */
export function proposeReallocation(cac: readonly ChannelCac[]): ReallocationProposal | null {
  const priced = cac.filter((c) => Number.isFinite(c.cacMinor) && c.spendMinor > 0);
  if (priced.length < 2) return null;
  const cheapest = priced.reduce((a, b) => (b.cacMinor < a.cacMinor ? b : a));
  const priciest = priced.reduce((a, b) => (b.cacMinor > a.cacMinor ? b : a));
  if (cheapest.channel === priciest.channel) return null;
  const gapBps = ((priciest.cacMinor - cheapest.cacMinor) / cheapest.cacMinor) * 10_000;
  if (gapBps < MIN_GAP_BPS) return null;
  const amountMinor = Math.round(priciest.spendMinor * REALLOCATE_FRACTION);
  if (amountMinor <= 0) return null;
  return { fromChannel: priciest.channel, toChannel: cheapest.channel, amountMinor, cac: priced };
}

interface BudgetJson {
  autopilotBoundMinor?: number;
}

function parseBudgetJson(raw: string): BudgetJson {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as BudgetJson) : {};
  } catch {
    return {};
  }
}

interface EligibleCampaign {
  id: string;
  budgetJson: string;
}

type ProposalOutcome =
  | { decision: "act" | "act_with_approval"; fromChannel: string; toChannel: string; amountMinor: number; currency: string; cac: readonly ChannelCac[]; ltvMinor: number; boundMinor: number }
  | { decision: "anomaly_rejected"; anomaly: AnomalyResult }
  | { decision: "no_action" };

async function proposeForCampaign(ctx: Ctx, campaign: EligibleCampaign): Promise<ProposalOutcome> {
  const spendRows = await ctx.db
    .select({
      channel: schema.signalSpend.channel,
      amountMinor: schema.signalSpend.amountMinor,
      conversions: schema.signalSpend.conversions,
      currency: schema.signalSpend.currency,
      ts: schema.signalSpend.ts
    })
    .from(schema.signalSpend)
    .where(
      and(
        eq(schema.signalSpend.tenantId, ctx.tenantId),
        eq(schema.signalSpend.campaignId, campaign.id),
        gte(schema.signalSpend.ts, ctx.now - CAC_WINDOW_DAYS * DAY_MS)
      )
    );
  const cac = computeChannelCac(spendRows);
  const proposal = proposeReallocation(cac);
  if (!proposal) return { decision: "no_action" };

  const binds = await ctx.db
    .select({ valueMinor: schema.signalAttributionEvents.valueMinor })
    .from(schema.signalAttributionEvents)
    .where(
      and(
        eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
        eq(schema.signalAttributionEvents.campaignId, campaign.id),
        eq(schema.signalAttributionEvents.touchType, "bind"),
        gte(schema.signalAttributionEvents.ts, ctx.now - LTV_WINDOW_DAYS * DAY_MS)
      )
    );
  const ltvMinor = computeLtv(binds.map((b) => b.valueMinor ?? 0).filter((v) => v > 0));
  const cheapest = proposal.cac.reduce((a, b) => (b.cacMinor < a.cacMinor ? b : a));
  // Reallocating into a channel that already costs more per acquisition than
  // that acquisition is worth is not a move worth making.
  if (ltvMinor > 0 && cheapest.cacMinor >= ltvMinor) return { decision: "no_action" };

  const campaignRef = `signal_campaign:${campaign.id}`;
  const recentMoves = await ctx.db
    .select({ amountMinor: schema.signalBudgetMoves.amountMinor, fromRef: schema.signalBudgetMoves.fromRef, toRef: schema.signalBudgetMoves.toRef })
    .from(schema.signalBudgetMoves)
    .where(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId))
    .orderBy(desc(schema.signalBudgetMoves.ts))
    .limit(200);
  const history = recentMoves
    .filter((m) => m.fromRef.startsWith(campaignRef) || m.toRef.startsWith(campaignRef))
    .slice(0, ANOMALY_HISTORY_LIMIT)
    .map((m) => m.amountMinor);

  const anomaly = anomalyGuard(proposal.amountMinor, history);
  if (anomaly.isAnomaly) return { decision: "anomaly_rejected", anomaly };

  const budget = parseBudgetJson(campaign.budgetJson);
  const boundMinor = budget.autopilotBoundMinor ?? DEFAULT_BOUND_MINOR;
  const currency = spendRows.find((r) => r.channel === proposal.fromChannel)?.currency ?? "AED";
  return {
    decision: boundCheck(proposal.amountMinor, boundMinor),
    fromChannel: proposal.fromChannel,
    toChannel: proposal.toChannel,
    amountMinor: proposal.amountMinor,
    currency,
    cac: proposal.cac,
    ltvMinor,
    boundMinor
  };
}

/** Outcome-shaped audit payload for EVAL_ACTION — mirrors commitMove's `after` richness so a decision can be judged from the audit log alone, not just named. */
function evalAuditPayload(outcome: ProposalOutcome): Record<string, unknown> {
  switch (outcome.decision) {
    case "act":
    case "act_with_approval":
      return {
        decision: outcome.decision,
        fromChannel: outcome.fromChannel,
        toChannel: outcome.toChannel,
        amountMinor: outcome.amountMinor,
        boundMinor: outcome.boundMinor,
        cacMinor: Object.fromEntries(outcome.cac.map((c) => [c.channel, c.cacMinor]))
      };
    case "anomaly_rejected":
      return { decision: outcome.decision, zScore: outcome.anomaly.zScore, mean: outcome.anomaly.mean, stdev: outcome.anomaly.stdev };
    case "no_action":
      return { decision: outcome.decision };
  }
}

async function commitMove(
  ctx: Ctx,
  campaign: EligibleCampaign,
  proposal: Extract<ProposalOutcome, { decision: "act" | "act_with_approval" }>,
  push: AdPushOptions
): Promise<void> {
  const fromRef = `signal_campaign:${campaign.id}#${proposal.fromChannel}`;
  const toRef = `signal_campaign:${campaign.id}#${proposal.toChannel}`;
  const moveId = newId("bmv", ctx.now);

  let approvedBy = "auto";
  // Every move goes through the approvals engine, under-bound ones included.
  // The bound is a tenant autonomy grant, so it is passed as `withinBound`
  // rather than as a reason to skip the call: gate() still honours
  // `neverAutoApprove` (a floor no bound may undercut) and still writes the
  // decision to the audit chain. Deciding with a bare `if` here left both out.
  try {
    const approval = await gate(ctx, {
      policyKey: "signal.budget_move",
      subjectRef: `budget-moves:${moveId}`,
      amountMinor: proposal.amountMinor,
      withinBound: proposal.decision === "act",
      context: { fromRef, toRef, boundMinor: proposal.boundMinor }
    });
    // gate() returned instead of throwing: within bound, auto-approved by
    // tenant policy, or an existing still-valid approved row — either way, acted.
    approvedBy = approval?.decidedBy ?? "auto";
  } catch (err) {
    if (err instanceof AppError && err.code === "approval_required") {
      approvedBy = "pending";
    } else {
      throw err;
    }
  }

  await ctx.db.insert(schema.signalBudgetMoves).values({
    id: moveId,
    tenantId: ctx.tenantId,
    fromRef,
    toRef,
    amountMinor: proposal.amountMinor,
    currency: proposal.currency,
    reason: `Marginal CAC on ${proposal.toChannel} ran below ${proposal.fromChannel} over the trailing ${CAC_WINDOW_DAYS}-day window, so budget followed the cheaper channel.`,
    evidenceJson: JSON.stringify({
      windowDays: CAC_WINDOW_DAYS,
      cacMinor: Object.fromEntries(proposal.cac.map((c) => [c.channel, c.cacMinor])),
      ltvMinor: proposal.ltvMinor,
      boundMinor: proposal.boundMinor
    }),
    approvedBy,
    reversedBy: null,
    reversedAt: null,
    reversibleUntil: ctx.now + 7 * DAY_MS,
    ts: ctx.now
  });

  await audit(ctx, {
    action: "signal.budget_move.created",
    subjectRef: `budget-moves:${moveId}`,
    after: { fromRef, toRef, amountMinor: proposal.amountMinor, approvedBy }
  });
  await emit(ctx, {
    module: "signal",
    type: "signal.budget.moved",
    subject: `budget-moves:${moveId}`,
    data: { fromRef, toRef, amountMinor: proposal.amountMinor, approvedBy }
  });

  // docs/30 SIGNAL 5: the gate above passed it, so a connected ad account
  // hears the move now. A pending move waits for its approver
  // (signal-ad-platforms.ts `onBudgetMoveDecided`). No ad connector: no-op.
  if (approvedBy !== "pending") {
    const [row] = await ctx.db
      .select()
      .from(schema.signalBudgetMoves)
      .where(and(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId), eq(schema.signalBudgetMoves.id, moveId)));
    if (row) await pushBudgetMove(ctx, push.fieldKey, row, "apply", push.platforms);
  }
}

/** Where an approved move is pushed from: the sealed-secret key and, in tests, the platform adapters. */
export interface AdPushOptions {
  fieldKey?: string | undefined;
  platforms?: AdPlatforms;
}

/**
 * Daily trigger (wired from apps/api/src/index.ts `scheduled()`): evaluate
 * every live, autopilot-eligible campaign once per tenant per day and act on
 * (or flag, or skip) a reallocation proposal. Idempotent via an audit-log
 * marker written for every evaluated campaign regardless of outcome — keying
 * off signal_budget_moves row existence (the sweepRenewals idiom) would miss
 * deduping the "no move created" outcomes (anomaly-rejected, insufficient
 * data), so a second same-day tick would silently re-evaluate those.
 */
export async function runBudgetAutopilot(ctx: Ctx, push: AdPushOptions = {}): Promise<number> {
  // docs/modules/signal.md §8 "one-click global pause": a tenant-wide kill
  // switch checked before touching any campaign, distinct from a single
  // campaign's own state=paused filtered out below.
  if (ctx.policy.signalAutopilotPaused) return 0;

  const dayStart = Math.floor(ctx.now / DAY_MS) * DAY_MS;

  const campaigns = await ctx.db
    .select({ id: schema.signalCampaigns.id, budgetJson: schema.signalCampaigns.budgetJson })
    .from(schema.signalCampaigns)
    .where(
      and(
        eq(schema.signalCampaigns.tenantId, ctx.tenantId),
        eq(schema.signalCampaigns.state, "live"),
        inArray(schema.signalCampaigns.autonomyLevel, [...AUTOPILOT_LEVELS]),
        // ADR-0110: a holdout's budget is frozen — never evaluated, never moved.
        eq(schema.signalCampaigns.holdout, false),
        isNull(schema.signalCampaigns.deletedAt)
      )
    );
  if (!campaigns.length) return 0;

  const alreadyEvaluated = new Set(
    (
      await ctx.db
        .select({ subjectRef: schema.auditLog.subjectRef })
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.tenantId, ctx.tenantId),
            eq(schema.auditLog.action, EVAL_ACTION),
            gte(schema.auditLog.ts, dayStart),
            lt(schema.auditLog.ts, dayStart + DAY_MS)
          )
        )
    ).map((r) => r.subjectRef)
  );

  let created = 0;
  for (const campaign of campaigns) {
    const subjectRef = `signal_campaign:${campaign.id}`;
    if (alreadyEvaluated.has(subjectRef)) continue;

    const outcome = await proposeForCampaign(ctx, campaign);
    await audit(ctx, { action: EVAL_ACTION, subjectRef, after: evalAuditPayload(outcome) });

    if (outcome.decision === "act" || outcome.decision === "act_with_approval") {
      await commitMove(ctx, campaign, outcome, push);
      created++;
    }
  }
  return created;
}

import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@lyra/db";
import {
  AD_TRANSPORT,
  AppError,
  adCampaignMap,
  adChannel,
  audit,
  dailyBudgetDelta,
  externalCampaignFor,
  gate,
  openFields,
  type AdPlatform,
  type AdSpendWindow,
  type ConnectorSecrets,
  type Ctx,
  type Envelope
} from "@lyra/core";
import { googleAdsPlatform } from "./signal-ad-google.js";
import { metaAdsPlatform } from "./signal-ad-meta.js";
import { recordSpend, spendRefusal } from "./signal-spend-import.js";

// docs/30 SIGNAL 5, ADR-0100. The `AdPlatform` seam (core/seams.ts) wired into
// SIGNAL both ways, through the connector rows ADR-0093 made the platform's:
//
//  - pull: each active `ads` connector's daily spend lands through
//    `recordSpend`, the same write the CSV import uses, so a day the platform
//    restates is corrected, not doubled;
//  - push: a budget move reaches the platform only after the
//    `signal.budget_move` gate — at commit when the bound or tenant policy
//    passed it (signal-autopilot.ts), on the approver's decision otherwise
//    (`onBudgetMoveDecided`, which spends that approval through `gate()`), and
//    an undo reverses exactly what was pushed (`onBudgetMoveUpdated`).
//
// A tenant with no ad connector sees nothing change: no call, no audit row.

export type AdPlatforms = Readonly<Record<string, AdPlatform>>;

export const AD_PLATFORMS: AdPlatforms = {
  "google-ads": googleAdsPlatform(),
  "meta-ads": metaAdsPlatform()
};

type ConnectorRow = typeof schema.orbitChannelConnectors.$inferSelect;
type MoveRow = typeof schema.signalBudgetMoves.$inferSelect;

export interface AdAccount {
  row: ConnectorRow;
  platform: AdPlatform;
  config: Record<string, unknown>;
}

function configOf(row: ConnectorRow): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(row.configJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function adAccounts(ctx: Ctx, platforms: AdPlatforms): Promise<AdAccount[]> {
  const rows = await ctx.db
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, ctx.tenantId),
        eq(schema.orbitChannelConnectors.transport, AD_TRANSPORT),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    );
  return rows.flatMap((row) => {
    const platform = platforms[row.provider];
    return platform ? [{ row, platform, config: configOf(row) }] : [];
  });
}

export async function secretsOf(fieldKey: string | undefined, row: ConnectorRow): Promise<ConnectorSecrets> {
  if (!fieldKey) throw new Error("FIELD_KEY is not configured");
  return openFields(fieldKey, JSON.parse(row.secretsJson) as ConnectorSecrets);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/* ------------------------------------------------------------------ pull */

export interface SpendPullResult {
  connectors: number;
  created: number;
  updated: number;
  errors: { connectorId: string; error: string }[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Platforms restate recent days (late conversions, invalid-click credits); the pull re-reads this many. */
export const SPEND_PULL_DAYS = 3;
export const SPEND_PULL_MAX_DAYS = 31;

/** The last SPEND_PULL_DAYS whole days by default; either end can be named. */
export function spendPullWindow(now: number, given: { since?: string | undefined; until?: string | undefined } = {}): AdSpendWindow {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const until = given.until ?? iso(now - DAY_MS);
  const since = given.since ?? iso(Date.parse(`${until}T00:00:00Z`) - (SPEND_PULL_DAYS - 1) * DAY_MS);
  return { since, until };
}

export async function pullAdSpend(
  ctx: Ctx,
  fieldKey: string | undefined,
  window: AdSpendWindow,
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<SpendPullResult> {
  const accounts = await adAccounts(ctx, platforms);
  const out: SpendPullResult = { connectors: accounts.length, created: 0, updated: 0, errors: [] };
  if (!accounts.length) return out;

  const campaigns = new Set(
    (await ctx.db.select({ id: schema.signalCampaigns.id }).from(schema.signalCampaigns).where(eq(schema.signalCampaigns.tenantId, ctx.tenantId))).map(
      (c) => c.id
    )
  );

  for (const { row, platform, config } of accounts) {
    const subjectRef = `connector:${row.id}`;
    let pulled;
    try {
      pulled = await platform.pullSpend(window, await secretsOf(fieldKey, row), config);
    } catch (err) {
      out.errors.push({ connectorId: row.id, error: message(err) });
      await audit(ctx, { action: "signal.spend.pull_failed", subjectRef, after: { window, error: message(err) } });
      continue;
    }

    // Several platform campaigns can stand behind one LYRA campaign, and every
    // unmapped one is channel-level spend: sum each (campaign, channel, day)
    // before writing, or the last platform row would overwrite the others.
    const map = adCampaignMap(config);
    const channel = adChannel(config, platform.defaultChannel);
    const days = new Map<string, Parameters<typeof recordSpend>[1]>();
    for (const r of pulled) {
      const campaignId = map.get(r.externalCampaignId) ?? null;
      const key = `${campaignId ?? ""}\u0000${r.day}`;
      const held = days.get(key);
      if (held) {
        held.amountMinor += r.amountMinor;
        held.impressions += r.impressions;
        held.clicks += r.clicks;
        held.conversions += r.conversions;
      } else {
        days.set(key, { campaignId, channel, day: r.day, amountMinor: r.amountMinor, currency: r.currency, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions });
      }
    }
    let created = 0;
    let updated = 0;
    for (const line of days.values()) {
      if (!DAY.test(line.day)) {
        out.errors.push({ connectorId: row.id, error: `${line.day}: not a YYYY-MM-DD day` });
        continue;
      }
      if (line.campaignId && !campaigns.has(line.campaignId)) {
        out.errors.push({ connectorId: row.id, error: `${line.day}: no campaign ${line.campaignId}` });
        continue;
      }
      // A day the ledger refused to accrue (no FX rate for the account's
      // currency, a closed month) is named and skipped, not written.
      try {
        if ((await recordSpend(ctx, line, "api")) === "created") created++;
        else updated++;
      } catch (err) {
        out.errors.push({ connectorId: row.id, error: `${line.day}: ${spendRefusal(err)}` });
      }
    }
    out.created += created;
    out.updated += updated;
    await audit(ctx, { action: "signal.spend.pulled", subjectRef, after: { window, created, updated } });
  }
  return out;
}

/* ------------------------------------------------------------------ push */

export type PushDirection = "apply" | "reverse";

export interface PushLeg {
  channel: string;
  /** none: no connected account carries it · already: pushed before · skipped: held back because the decrease did not happen. */
  status: "pushed" | "failed" | "skipped" | "none" | "already";
  error?: string;
}

interface Side {
  campaignId: string;
  channel: string;
}

async function isHoldout(ctx: Ctx, campaignIds: readonly string[]): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: schema.signalCampaigns.id })
    .from(schema.signalCampaigns)
    .where(
      and(
        eq(schema.signalCampaigns.tenantId, ctx.tenantId),
        inArray(schema.signalCampaigns.id, [...campaignIds]),
        eq(schema.signalCampaigns.holdout, true)
      )
    );
  return rows.length > 0;
}

function sideOf(ref: string): Side | null {
  const m = /^signal_campaign:([^#]+)#(.+)$/.exec(ref);
  return m ? { campaignId: m[1]!, channel: m[2]! } : null;
}

function targetsFor(accounts: AdAccount[], side: Side): { account: AdAccount; externalCampaignId: string }[] {
  return accounts.flatMap((account) => {
    if (adChannel(account.config, account.platform.defaultChannel) !== side.channel) return [];
    const externalCampaignId = externalCampaignFor(adCampaignMap(account.config), side.campaignId);
    return externalCampaignId ? [{ account, externalCampaignId }] : [];
  });
}

async function marked(ctx: Ctx, subjectRef: string): Promise<boolean> {
  const [hit] = await ctx.db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.tenantId, ctx.tenantId), eq(schema.auditLog.action, "signal.budget_move.pushed"), eq(schema.auditLog.subjectRef, subjectRef))
    )
    .limit(1);
  return Boolean(hit);
}

async function note(ctx: Ctx, moveId: string, direction: PushDirection, channel: string, record: Record<string, unknown>): Promise<void> {
  const [row] = await ctx.db
    .select({ evidenceJson: schema.signalBudgetMoves.evidenceJson })
    .from(schema.signalBudgetMoves)
    .where(and(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId), eq(schema.signalBudgetMoves.id, moveId)));
  let evidence: Record<string, unknown> = {};
  try {
    evidence = JSON.parse(row?.evidenceJson ?? "{}") as Record<string, unknown>;
  } catch {
    evidence = {};
  }
  const key = direction === "apply" ? "platformPush" : "platformUndo";
  const legs = { ...((evidence[key] as Record<string, unknown> | undefined) ?? {}), [channel]: record };
  await ctx.db
    .update(schema.signalBudgetMoves)
    .set({ evidenceJson: JSON.stringify({ ...evidence, [key]: legs }) })
    .where(and(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId), eq(schema.signalBudgetMoves.id, moveId)));
}

/**
 * Push one budget move to the ad accounts that carry its channels. The caller
 * has already passed the `signal.budget_move` gate; a move still marked
 * `pending` is refused outright rather than trusted to the caller.
 */
export async function pushBudgetMove(
  ctx: Ctx,
  fieldKey: string | undefined,
  move: MoveRow,
  direction: PushDirection,
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<PushLeg[]> {
  if (move.approvedBy === "pending") throw new Error(`budget move ${move.id} is pending approval and is never pushed`);
  const from = sideOf(move.fromRef);
  const to = sideOf(move.toRef);
  if (!from || !to) return [];

  let windowDays = Number.NaN;
  try {
    windowDays = Number((JSON.parse(move.evidenceJson ?? "{}") as { windowDays?: unknown }).windowDays);
  } catch {
    // unreadable evidence: dailyBudgetDelta falls back to one day
  }
  const delta = dailyBudgetDelta(move.amountMinor, windowDays);
  // The decrease always goes first: if it cannot happen, the increase would be
  // new spend nobody approved, so it is held back.
  const [down, up] = direction === "apply" ? [from, to] : [to, from];
  const accounts = await adAccounts(ctx, platforms);
  const legs: PushLeg[] = [];

  for (const [side, sign] of [[down, -1], [up, 1]] as const) {
    const subjectRef = `budget-moves:${move.id}#${side.channel}#${direction}`;
    const targets = targetsFor(accounts, side);
    const decrease = legs[0];
    if (!targets.length || (direction === "reverse" && !(await marked(ctx, `budget-moves:${move.id}#${side.channel}#apply`)))) {
      legs.push({ channel: side.channel, status: "none" });
      continue;
    }
    if (await marked(ctx, subjectRef)) {
      legs.push({ channel: side.channel, status: "already" });
      continue;
    }
    const fail = async (status: "failed" | "skipped", error: string) => {
      legs.push({ channel: side.channel, status, error });
      await audit(ctx, { action: "signal.budget_move.push_failed", subjectRef, after: { status, error } });
      await note(ctx, move.id, direction, side.channel, { status, error });
    };
    if (decrease && (decrease.status === "failed" || decrease.status === "skipped")) {
      await fail("skipped", `the decrease on ${decrease.channel} did not happen`);
      continue;
    }
    if (targets.length > 1) {
      await fail("failed", `${targets.length} connected accounts carry ${side.channel} for ${side.campaignId}`);
      continue;
    }
    const { account, externalCampaignId } = targets[0]!;
    try {
      const moved = await account.platform.adjustDailyBudget(externalCampaignId, sign * delta, move.currency, await secretsOf(fieldKey, account.row), account.config);
      const record = { status: "pushed", connectorId: account.row.id, externalCampaignId, ...moved };
      legs.push({ channel: side.channel, status: "pushed" });
      await audit(ctx, { action: "signal.budget_move.pushed", subjectRef, after: { ...record, deltaMinor: sign * delta } });
      await note(ctx, move.id, direction, side.channel, record);
    } catch (err) {
      await fail("failed", message(err));
    }
  }
  return legs;
}

async function loadMove(ctx: Ctx, id: string): Promise<MoveRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(schema.signalBudgetMoves)
    .where(and(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId), eq(schema.signalBudgetMoves.id, id)));
  return row;
}

/**
 * `signal.approval.decided` (approvals.ts `decide`): an over-bound move the
 * approver just passed. The approval is spent through `gate()` — the same
 * call the autopilot made — so this path cannot push a move the gate would
 * refuse, and a move with no connected account never spends one.
 */
export async function onBudgetMoveDecided(
  ctx: Ctx,
  fieldKey: string | undefined,
  event: Envelope,
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<void> {
  const data = event.data as { approvalId?: string; decision?: string; policyKey?: string };
  if (data.policyKey !== "signal.budget_move" || data.decision !== "approved" || !event.subject?.startsWith("budget-moves:")) return;
  let move = await loadMove(ctx, event.subject.slice("budget-moves:".length));
  if (!move || move.reversedAt) return;
  const from = sideOf(move.fromRef);
  const to = sideOf(move.toRef);
  const accounts = await adAccounts(ctx, platforms);
  if (!from || !to || (!targetsFor(accounts, from).length && !targetsFor(accounts, to).length)) return;
  // ADR-0110: a campaign designated frozen-budget holdout after this move was
  // proposed is not moved by the approval that follows. The approval is left
  // unspent and the move stays pending — frozen means frozen.
  if (await isHoldout(ctx, [from.campaignId, to.campaignId])) return;

  const [approval] = await ctx.db
    .select({ decision: schema.approvals.decision })
    .from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, ctx.tenantId), eq(schema.approvals.id, data.approvalId ?? "")));
  if (approval?.decision !== "approved") return;

  let decidedBy: string | null;
  try {
    decidedBy = (await gate(ctx, { policyKey: "signal.budget_move", subjectRef: event.subject, amountMinor: move.amountMinor }))?.decidedBy ?? null;
  } catch (err) {
    if (err instanceof AppError && err.code === "approval_required") return;
    throw err;
  }
  if (move.approvedBy === "pending") {
    const approvedBy = decidedBy ?? "auto";
    await ctx.db
      .update(schema.signalBudgetMoves)
      .set({ approvedBy })
      .where(and(eq(schema.signalBudgetMoves.tenantId, ctx.tenantId), eq(schema.signalBudgetMoves.id, move.id)));
    move = { ...move, approvedBy };
  }
  await pushBudgetMove(ctx, fieldKey, move, "apply", platforms);
}

/** `signal.budget-moves.updated` (the CRUD reversal, itself behind the gate): undo what was pushed. */
export async function onBudgetMoveUpdated(
  ctx: Ctx,
  fieldKey: string | undefined,
  event: Envelope,
  platforms: AdPlatforms = AD_PLATFORMS
): Promise<void> {
  if (!event.subject) return;
  const move = await loadMove(ctx, event.subject);
  if (!move?.reversedAt || move.approvedBy === "pending") return;
  await pushBudgetMove(ctx, fieldKey, move, "reverse", platforms);
}

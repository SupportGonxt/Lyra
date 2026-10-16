import { and, desc, eq, gte } from "drizzle-orm";
import { id as newId } from "@lyra/db";
import { schema } from "@lyra/db";
import { audit, emit, type Ctx } from "@lyra/core";

// docs/modules/signal.md §2.3: "Anomaly guard: spend spike auto-pauses and
// alerts" and "tracking breakage auto-pauses and alerts".
//
// What existed was `anomalyGuard` in signal-autopilot.ts, and it answers a
// different question: it compares a *proposed budget move* to past move amounts
// and, on a hit, returns without making the move. So an operator reading §2.3
// would expect a runaway spend or a broken pixel to stop a campaign, and neither
// would: nothing watched spend, nothing watched delivery, nothing paused a
// campaign, and nothing alerted anybody. The only signal was a *missing* budget
// move, which is indistinguishable from a quiet day.
//
// This file is the missing half. The detectors are pure functions over daily
// spend rows so each threshold is unit-tested against a fixture; `runSpendWatch`
// is the acting half, and it is deliberately the only thing here that writes.

/** Days of history the baseline is taken from. */
export const WATCH_BASELINE_DAYS = 14;

/** A day this many times its own trailing median is a spike. */
export const SPIKE_MULTIPLE = 3;

/** Days of history a channel needs before "3× normal" means anything. A
 *  channel's first day is not a spike; it is a channel's first day. */
export const MIN_BASELINE_DAYS = 3;

/** Spend below this is not worth stopping a campaign over. */
export const WATCH_MIN_AMOUNT_MINOR = 5_000;

export interface DailySpend {
  campaignId: string | null;
  channel: string;
  /** YYYY-MM-DD. */
  day: string;
  amountMinor: number;
  impressions: number;
  clicks: number;
}

export interface SpendSpike {
  campaignId: string | null;
  channel: string;
  day: string;
  amountMinor: number;
  baselineMinor: number;
  multiple: number;
}

export interface TrackingBreak {
  campaignId: string | null;
  channel: string;
  day: string;
  amountMinor: number;
  impressions: number;
  clicks: number;
}

export interface SilentSpend {
  campaignId: string;
  channel: string;
  day: string;
  amountMinor: number;
}

/** The median of a set of amounts. Zero for an empty set — never NaN. */
export function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** The newest day present in the rows — what "now" means for these detectors. */
export function latestDay(rows: readonly DailySpend[]): string | null {
  return rows.reduce<string | null>((newest, r) => (newest === null || r.day > newest ? r.day : newest), null);
}

/**
 * Days that spent several times their own trailing median.
 *
 * The baseline is that (campaign, channel)'s own history rather than the
 * account's, because channels differ by orders of magnitude — a search campaign
 * and a brand campaign sharing one baseline would flag the search campaign every
 * day. A series with fewer than `MIN_BASELINE_DAYS` days behind it is skipped
 * rather than compared against itself.
 */
export function detectSpendSpikes(
  rows: readonly DailySpend[],
  opts: { multiple?: number; baselineDays?: number; minBaselineDays?: number; minAmountMinor?: number } = {}
): SpendSpike[] {
  const multiple = opts.multiple ?? SPIKE_MULTIPLE;
  const baselineDays = opts.baselineDays ?? WATCH_BASELINE_DAYS;
  const minBaselineDays = opts.minBaselineDays ?? MIN_BASELINE_DAYS;
  const minAmount = opts.minAmountMinor ?? WATCH_MIN_AMOUNT_MINOR;
  const newest = latestDay(rows);
  if (newest === null) return [];

  const bySeries = new Map<string, DailySpend[]>();
  for (const row of rows) {
    const key = `${row.campaignId ?? ""}|${row.channel}`;
    const series = bySeries.get(key);
    if (series) series.push(row);
    else bySeries.set(key, [row]);
  }

  const out: SpendSpike[] = [];
  for (const series of bySeries.values()) {
    const today = series.filter((r) => r.day === newest);
    const history = series
      .filter((r) => r.day < newest)
      .sort((a, b) => b.day.localeCompare(a.day))
      .slice(0, baselineDays);
    if (history.length < minBaselineDays) continue;
    const baseline = median(history.map((r) => r.amountMinor));
    if (baseline <= 0) continue;
    for (const row of today) {
      if (row.amountMinor < minAmount) continue;
      const ratio = row.amountMinor / baseline;
      if (ratio > multiple) {
        out.push({
          campaignId: row.campaignId,
          channel: row.channel,
          day: row.day,
          amountMinor: row.amountMinor,
          baselineMinor: baseline,
          multiple: Math.round(ratio * 10) / 10
        });
      }
    }
  }
  return out.sort((a, b) => b.multiple - a.multiple);
}

/**
 * Days that spent real money and recorded no delivery at all.
 *
 * This is the pixel-broke case: money leaves the account, nothing arrives. It is
 * checked separately from a spike because the failure is the *absence* of
 * evidence, and a spike detector reading only spend would call it a normal day.
 */
export function detectTrackingBreaks(
  rows: readonly DailySpend[],
  opts: { minAmountMinor?: number } = {}
): TrackingBreak[] {
  const minAmount = opts.minAmountMinor ?? WATCH_MIN_AMOUNT_MINOR;
  return rows
    .filter((r) => r.amountMinor >= minAmount && r.impressions === 0 && r.clicks === 0)
    .map((r) => ({
      campaignId: r.campaignId,
      channel: r.channel,
      day: r.day,
      amountMinor: r.amountMinor,
      impressions: r.impressions,
      clicks: r.clicks
    }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/**
 * Money still leaving a campaign we believe is paused.
 *
 * A pause the platform performed and the ad account did not honour is worse than
 * no pause: it reads as stopped while it spends. Only a campaign the tenant
 * paused is checked — a `live` one is supposed to spend.
 */
export function detectSilentSpend(
  rows: readonly DailySpend[],
  paused: ReadonlyMap<string, string>,
  opts: { minAmountMinor?: number } = {}
): SilentSpend[] {
  const minAmount = opts.minAmountMinor ?? WATCH_MIN_AMOUNT_MINOR;
  const newest = latestDay(rows);
  if (newest === null) return [];
  return rows
    .filter((r) => r.day === newest && r.campaignId !== null && r.amountMinor >= minAmount && paused.get(r.campaignId) === "paused")
    .map((r) => ({ campaignId: r.campaignId!, channel: r.channel, day: r.day, amountMinor: r.amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor);
}

/* ----------------------------------------------------------------- acting */

export interface WatchResult {
  /** Campaigns this run paused. */
  paused: { campaignId: string; kind: "spend_spike" | "tracking_break"; channels: string[] }[];
  spikes: number;
  breaks: number;
  silent: number;
  /** Campaigns already paused when the run started, so a second run is a no-op. */
  alreadyPaused: number;
}

/** How many days of spend the watch reads. One more than the baseline, so the
 *  newest day can be compared against a full window. */
export const WATCH_WINDOW_DAYS = WATCH_BASELINE_DAYS + 1;

/** The i18n key the inbox renders (rule 7: a key and its parameters, never a sentence). */
export const WATCH_ALERT_TITLE_KEY = "signal.anomaly.detected";

/** Holds `signal:campaigns:update` — whoever runs campaigns is told when one stops. */
export const WATCH_ALERT_ROLE = "signal.lead";

/**
 * Tells the people who run campaigns that the guard stopped one.
 *
 * "Alerts" in this platform means the in-app inbox (`core_notifications`) — the
 * same path NORTH's alert rules and schedule failures use, because CLAUDE.md §13
 * forbids adding a mail or chat service to fill the gap. Returns how many were
 * told, so the caller can record it.
 */
async function notifyWatch(
  ctx: Ctx,
  campaignId: string,
  kinds: readonly string[],
  channels: readonly string[],
  detail: unknown[]
): Promise<number> {
  const holders = await ctx.db
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(
      and(
        eq(schema.userRoles.tenantId, ctx.tenantId),
        eq(schema.roles.tenantId, ctx.tenantId),
        eq(schema.roles.key, WATCH_ALERT_ROLE)
      )
    );
  const recipients = [...new Set(holders.map((r) => r.userId))];
  if (!recipients.length) return 0;
  await ctx.db.insert(schema.notifications).values(
    recipients.map((userId) => ({
      id: newId("ntf", ctx.now),
      tenantId: ctx.tenantId,
      userId,
      kind: "alert",
      titleKey: WATCH_ALERT_TITLE_KEY,
      paramsJson: JSON.stringify({ campaignId, kinds, channels, detail }),
      subjectRef: `signal_campaign:${campaignId}`,
      readAt: null,
      createdAt: ctx.now
    }))
  );
  return recipients.length;
}

/**
 * Watches spend and delivery, and stops what has gone wrong.
 *
 * Pausing rather than throttling is deliberate: the guard's job is to stop the
 * bleeding first and explain second. A human turns it back on, and the campaign
 * is `paused`, which the state machine allows from `live` and nothing else
 * silently re-enters.
 *
 * A campaign is paused **once** per run with the reasons gathered: three broken
 * channels are one pause with three reasons, not three competing writes.
 */
export async function runSpendWatch(ctx: Ctx): Promise<WatchResult> {
  const sinceDay = new Date(ctx.now - WATCH_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await ctx.db
    .select({
      campaignId: schema.signalSpend.campaignId,
      channel: schema.signalSpend.channel,
      day: schema.signalSpend.day,
      amountMinor: schema.signalSpend.amountMinor,
      impressions: schema.signalSpend.impressions,
      clicks: schema.signalSpend.clicks
    })
    .from(schema.signalSpend)
    .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), gte(schema.signalSpend.day, sinceDay)))
    .orderBy(desc(schema.signalSpend.day));

  const result: WatchResult = { paused: [], spikes: 0, breaks: 0, silent: 0, alreadyPaused: 0 };
  if (!rows.length) return result;

  const spikes = detectSpendSpikes(rows);
  const breaks = detectTrackingBreaks(rows);
  result.spikes = spikes.length;
  result.breaks = breaks.length;

  // The reasons, gathered per campaign, so one pause carries all of them.
  const reasons = new Map<string, { kinds: Set<"spend_spike" | "tracking_break">; channels: Set<string>; detail: unknown[] }>();
  for (const spike of spikes) {
    if (!spike.campaignId) continue;
    const bag = reasons.get(spike.campaignId) ?? { kinds: new Set(), channels: new Set(), detail: [] };
    bag.kinds.add("spend_spike");
    bag.channels.add(spike.channel);
    bag.detail.push(spike);
    reasons.set(spike.campaignId, bag);
  }
  for (const broke of breaks) {
    if (!broke.campaignId) continue;
    const bag = reasons.get(broke.campaignId) ?? { kinds: new Set(), channels: new Set(), detail: [] };
    bag.kinds.add("tracking_break");
    bag.channels.add(broke.channel);
    bag.detail.push(broke);
    reasons.set(broke.campaignId, bag);
  }

  // Every campaign's state, not only the ones with a reason: silent spend is
  // about a campaign that is paused and still billing, and that campaign by
  // definition has no spike for the reasons map to have captured.
  const campaignRows = await ctx.db
    .select({ id: schema.signalCampaigns.id, state: schema.signalCampaigns.state })
    .from(schema.signalCampaigns)
    .where(eq(schema.signalCampaigns.tenantId, ctx.tenantId));
  const stateById = new Map(campaignRows.map((r) => [r.id, r.state]));

  for (const [campaignId, bag] of reasons) {
    const state = stateById.get(campaignId);
    // Only a running campaign is stopped; one already paused is not written
    // again, so a second run is a no-op rather than a stream of audits.
    if (state !== "live") {
      result.alreadyPaused += 1;
      continue;
    }
    // A guard that fires is a state change, so it goes through the same shape
    // every other state change does: write, audit, announce.
    await ctx.db
      .update(schema.signalCampaigns)
      .set({ state: "paused", updatedAt: ctx.now })
      .where(and(eq(schema.signalCampaigns.tenantId, ctx.tenantId), eq(schema.signalCampaigns.id, campaignId)));

    const kinds = [...bag.kinds];
    await audit(ctx, {
      action: "signal.campaign.paused_by_guard",
      subjectRef: `signal_campaign:${campaignId}`,
      before: { state: "live" },
      after: { state: "paused", kinds, channels: [...bag.channels], detail: bag.detail }
    });
    await emit(ctx, {
      module: "signal",
      type: "signal.anomaly.detected",
      subject: `signal_campaign:${campaignId}`,
      data: { campaignId, kinds, channels: [...bag.channels], action: "paused" }
    });
    // Stopping the spend is half of "auto-pauses and alerts"; the other half is
    // telling somebody, in the inbox they already read.
    const told = await notifyWatch(ctx, campaignId, kinds, [...bag.channels], bag.detail);
    if (told) {
      await audit(ctx, {
        action: "signal.anomaly.notified",
        subjectRef: `signal_campaign:${campaignId}`,
        after: { notified: told, role: WATCH_ALERT_ROLE, kinds }
      });
    }
    result.paused.push({ campaignId, kind: kinds[0]!, channels: [...bag.channels] });
  }

  // Silent spend is reported, never auto-paused: the campaign is already paused
  // on our side, so the fault is the platform's or the account's, and stopping
  // something already stopped is not an action.
  const silent = detectSilentSpend(rows, stateById);
  result.silent = silent.length;
  for (const row of silent) {
    await audit(ctx, {
      action: "signal.anomaly.silent_spend",
      subjectRef: `signal_campaign:${row.campaignId}`,
      after: row
    });
    await emit(ctx, {
      module: "signal",
      type: "signal.anomaly.detected",
      subject: `signal_campaign:${row.campaignId}`,
      data: { campaignId: row.campaignId, kinds: ["silent_spend"], channels: [row.channel], action: "reported" }
    });
  }

  return result;
}

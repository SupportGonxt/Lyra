import { detectWatch, WATCH_WINDOW_MS, type Ctx, type WatchFinding, type WatchSignal } from "@lyra/core";
import { signalsSince } from "./scout-ingest.js";

// docs/modules/scout.md §2.1 "news/regulatory RSS, competitor page monitors
// with diff alerts" — the watch, as an internal engine over `scout_signals`.
// docs/27 F51 called it absent; what was absent is this read, not the data.
// Every regulatory circular, competitor note and review snippet the Harvester
// or the feed API recorded is already in that table.
//
// This is deliberately a *read*: a sweep that persisted findings would have to
// decide when a finding it raised last night is the same one tonight, and the
// honest answer is that a window scored against the window before it is a
// derivation, not a record. Nothing is written, so the route is safe to call
// as often as a screen refreshes and can never double-raise.

/** How many rows one watch reads. Two windows' worth of subjects, not a corpus. */
export const WATCH_MAX_SIGNALS = 2_000;

export interface WatchReport {
  readonly windowMs: number;
  readonly findings: WatchFinding[];
  readonly counts: { urgent: number; attention: number; info: number };
}

/**
 * Score the watch over `[now - 2 windows, now]` — the current window and the
 * one it is compared against. Tenant-scoped through `signalsSince`, which is
 * the same read the Clusterer uses, so the two can never disagree about which
 * signals exist.
 */
export async function runWatch(ctx: Ctx, windowMs: number = WATCH_WINDOW_MS): Promise<WatchReport> {
  const rows = await signalsSince(ctx, ctx.now - 2 * windowMs, WATCH_MAX_SIGNALS);
  const signals: WatchSignal[] = rows.map((row) => ({
    id: row.id,
    source: row.source,
    sourceRef: row.sourceRef,
    weight: row.weight,
    observedAt: row.observedAt
  }));
  const findings = detectWatch(signals, ctx.now, windowMs);
  return {
    windowMs,
    findings,
    counts: {
      urgent: findings.filter((one) => one.severity === "urgent").length,
      attention: findings.filter((one) => one.severity === "attention").length,
      info: findings.filter((one) => one.severity === "info").length
    }
  };
}

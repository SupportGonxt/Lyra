// docs/modules/scout.md §2.1 "news/regulatory RSS, competitor page monitors with
// diff alerts" — the *watch* half of that sentence. The monitors themselves are
// external services and need an ADR (ADR-0078); what runs today is this: an
// internal engine over the signals already in `scout_signals`, which is where
// any monitor, feed or hand-keyed item lands whatever wrote it.
//
// Pure, so the same function scores a seeded corpus, a fed corpus and a
// (LATER) crawled one identically.

import type { SignalSourceKind } from "./seams.js";

/** Which watch a source answers to. `search` is demand, not a watch subject. */
const WATCH_KIND_OF: Partial<Record<SignalSourceKind, WatchKind>> = {
  regulatory: "regulatory",
  news: "competitor",
  reviews: "competitor"
};

export type WatchKind = "competitor" | "regulatory";

/** Info is a running subject, attention is new or regulated, urgent is moving fast. */
export type WatchSeverity = "info" | "attention" | "urgent";

export interface WatchSignal {
  readonly id: string;
  readonly source: string;
  /** The monitored subject: a competitor's page, a regulator's feed, a product
   *  listing. Null means the source itself is the only subject there is. */
  readonly sourceRef: string | null;
  readonly weight: number;
  readonly observedAt: number;
}

export interface WatchFinding {
  readonly kind: WatchKind;
  /** Stable identity of the watched subject — `source:sourceRef`. */
  readonly key: string;
  readonly source: string;
  readonly subject: string | null;
  /** Weighted volume inside the window. */
  readonly count: number;
  /** The same in the window before it — 0 means the subject is new to the watch. */
  readonly priorCount: number;
  /** Percent change, null when there is no prior window to compare against. */
  readonly deltaPct: number | null;
  readonly severity: WatchSeverity;
  readonly firstSeen: number;
  readonly lastSeen: number;
  readonly signalIds: readonly string[];
}

/** A subject has to move by this much, off at least this many observations,
 *  before "moving fast" means anything. Two items doubling to four is noise. */
const URGENT_GROWTH = 2;
const URGENT_MIN_COUNT = 3;

export const WATCH_WINDOW_MS = 30 * 86_400_000;

/**
 * Score every watched subject observed inside `[now - windowMs, now]` against
 * the window before it.
 *
 * Severity, in the order it is decided:
 *  - `urgent`    — volume at least doubled on a subject with real volume, or a
 *                  regulatory subject appeared that was not there before.
 *  - `attention` — a competitor subject new to the watch, or any regulatory one.
 *  - `info`      — a subject that is simply still there.
 *
 * Signals outside both windows are ignored rather than counted as prior, so a
 * subject that went quiet a year ago does not read as a collapse this month.
 * Sources that are not watch subjects (`quotes`, `abandonment`, `search` —
 * those are demand, and the Clusterer's business) are dropped.
 */
export function detectWatch(
  signals: readonly WatchSignal[],
  now: number,
  windowMs: number = WATCH_WINDOW_MS
): WatchFinding[] {
  const cutoff = now - windowMs;
  const priorCutoff = cutoff - windowMs;

  interface Bucket {
    kind: WatchKind;
    source: string;
    subject: string | null;
    count: number;
    priorCount: number;
    firstSeen: number;
    lastSeen: number;
    signalIds: string[];
  }
  const buckets = new Map<string, Bucket>();

  for (const s of signals) {
    const kind = WATCH_KIND_OF[s.source as SignalSourceKind];
    if (!kind) continue;
    if (s.observedAt < priorCutoff || s.observedAt > now) continue;

    const key = `${s.source}:${s.sourceRef ?? "*"}`;
    const bucket = buckets.get(key) ?? {
      kind,
      source: s.source,
      subject: s.sourceRef,
      count: 0,
      priorCount: 0,
      firstSeen: s.observedAt,
      lastSeen: s.observedAt,
      signalIds: []
    };
    if (s.observedAt >= cutoff) {
      bucket.count += s.weight;
      bucket.signalIds.push(s.id);
      bucket.lastSeen = Math.max(bucket.lastSeen, s.observedAt);
    } else {
      bucket.priorCount += s.weight;
    }
    bucket.firstSeen = Math.min(bucket.firstSeen, s.observedAt);
    buckets.set(key, bucket);
  }

  const out: WatchFinding[] = [];
  for (const [key, b] of buckets) {
    // A subject with nothing in the current window is not a finding — it is
    // silence, which the source-health panel already reports.
    if (b.count === 0) continue;
    const isNew = b.priorCount === 0;
    const deltaPct = isNew ? null : Math.round(((b.count - b.priorCount) / b.priorCount) * 100);
    const grew = !isNew && b.count >= URGENT_MIN_COUNT && b.count >= b.priorCount * URGENT_GROWTH;

    const severity: WatchSeverity =
      grew || (b.kind === "regulatory" && isNew) ? "urgent" : isNew || b.kind === "regulatory" ? "attention" : "info";

    out.push({
      kind: b.kind,
      key,
      source: b.source,
      subject: b.subject,
      count: b.count,
      priorCount: b.priorCount,
      deltaPct,
      severity,
      firstSeen: b.firstSeen,
      lastSeen: b.lastSeen,
      signalIds: b.signalIds
    });
  }

  const rank: Record<WatchSeverity, number> = { urgent: 0, attention: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || b.count - a.count || a.key.localeCompare(b.key));
}

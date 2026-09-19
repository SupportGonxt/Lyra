/**
 * NORTH period arithmetic on the *label*, not on a timestamp.
 *
 * `north_snapshots.period` is a label — `2026-03-01` at day grain, `2026-03` at
 * month grain — and every reader of that column eventually needs the same four
 * questions answered: which period contains this instant, which label comes
 * before this one, what window does a label cover, and has that window fully
 * elapsed. Pure and DB-free so it is unit-testable and lands inside the Stryker
 * ratchet that covers packages/core.
 *
 * One module because the two engines that ask disagreed: the narrator
 * (engines/narrator.ts) compared a metric against `previousDay`/`previousMonth`
 * while the snapshotter compared it against the previous *write of the same
 * period* (docs/27 F48), so a briefing could call a metric flat while an
 * anomaly row said it collapsed. Both now route through here.
 *
 * UTC throughout: a period is what the nightly rollup closed, and the rollup
 * runs on UTC days wherever the person reading it sits.
 */

export type Grain = "day" | "month";

/** Half-open `[since, until)`, the same convention every compute in the snapshotter windows on. */
export interface PeriodBounds {
  since: number;
  until: number;
}

/** The period label containing `ts`. */
export function periodOf(grain: Grain, ts: number): string {
  return new Date(ts).toISOString().slice(0, grain === "day" ? 10 : 7);
}

function partsOf(grain: Grain, period: string): { y: number; m: number; d: number } {
  const [y, m, d] = period.split("-").map(Number);
  if (!y || !m || (grain === "day" && !d)) throw new Error(`not a ${grain} period: ${period}`);
  return { y, m, d: grain === "day" ? d! : 1 };
}

export function periodBounds(grain: Grain, period: string): PeriodBounds {
  const { y, m, d } = partsOf(grain, period);
  const since = Date.UTC(y, m - 1, d);
  // Date.UTC normalises an overflowing day or month, so February and December
  // need no special case: the 29th of a non-leap February and the 13th month
  // both roll forward exactly as the calendar does.
  const until = grain === "day" ? Date.UTC(y, m - 1, d + 1) : Date.UTC(y, m, 1);
  return { since, until };
}

/** The label immediately before `period` at the same grain. */
export function previousPeriod(grain: Grain, period: string): string {
  const { y, m, d } = partsOf(grain, period);
  return periodOf(grain, grain === "day" ? Date.UTC(y, m - 1, d - 1) : Date.UTC(y, m - 2, 1));
}

/**
 * Has this period's whole window elapsed? An *open* period is a partial
 * observation — a month-to-date row is rewritten every night — so it may be
 * displayed but is never an anomaly subject and never a baseline (docs/27 F48).
 */
export function isClosedPeriod(grain: Grain, period: string, now: number): boolean {
  return now >= periodBounds(grain, period).until;
}

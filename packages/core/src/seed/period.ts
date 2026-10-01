/**
 * The period labels a person reads on a screen: `2026-01`, `2026-01-05`,
 * `2026-Q1`. The seed clock moves — a demo provisioned in August must not
 * narrate January — so every label is derived from the clock rather than
 * written down beside the number it labels.
 *
 * UTC throughout: a period is what the nightly rollup closed, and the rollup
 * runs on UTC days no matter where the person reading it sits.
 */

const DAY = 86_400_000;

/** `2026-01-05` — the UTC day `days` from `ts`. */
export const dayKey = (ts: number, days = 0): string => new Date(ts + days * DAY).toISOString().slice(0, 10);

/** Midnight UTC of the day `days` from `ts`. */
export function dayStart(ts: number, days = 0): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);
}

/** Midnight UTC on the 1st of the month `months` from `ts`. */
export function monthStart(ts: number, months = 0): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1);
}

/**
 * `monthStart(ts, months) + days * DAY`, clamped so it never lands after
 * `ts` itself.
 *
 * Seed fixtures use the unclamped form — `monthStart(now, 0) + N*DAY` — to
 * mean "N days into the still-open current month": an already-earned
 * commission, a policy already on risk. That reads correctly only when the
 * month has actually had N days yet. On the 1st through Nth of any month
 * the seed clock lands on, it is a *future* timestamp, and every reader of
 * it (a snapshotter window, a pro-rata-days computation) then disagrees
 * with the demo's own present moment — the exact shape that broke
 * north-snapshotter.test.ts's month-close assertions and
 * e2e/axis-lifecycle.spec.ts's cancellation pricing on 2026-10-01. Clamping
 * to one day before `ts` keeps the fixture honestly in the past and still
 * strictly inside any `[since, now)` window; it collapses distinct offsets
 * onto the same instant only in the rare window where the literal day
 * hasn't arrived yet, which costs the demo's variety, not its correctness.
 */
export function dayIntoMonth(ts: number, months: number, days: number): number {
  return Math.min(monthStart(ts, months) + days * DAY, ts - DAY);
}

/** `2026-01` — the month `months` from `ts`. */
export const monthKey = (ts: number, months = 0): string =>
  new Date(monthStart(ts, months)).toISOString().slice(0, 7);

/**
 * `December` — the month `months` from `ts`, spelled for a person. The demo's
 * narratives name their months in prose, and prose has to agree with the chip
 * beside it.
 */
export const monthName = (ts: number, months = 0, locale = "en"): string =>
  new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" }).format(new Date(monthStart(ts, months)));

/**
 * `26 January` — a date the way a person writes it mid-sentence. Day-first
 * because that is how the demo's copy (and the UAE) writes a date; `en-US`
 * would render `January 26` into prose written the other way round.
 */
export const dayName = (ts: number, locale = "en-GB"): string =>
  new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(ts));

/** `2026-Q1` — the quarter `quarters` from `ts`. */
export function quarterKey(ts: number, quarters = 0): string {
  const d = new Date(ts);
  const q = Math.floor(d.getUTCMonth() / 3) + quarters;
  // Floor division so a negative offset walks back into the previous year
  // rather than naming a Q0: -1 is last year's Q4, not this year's.
  const year = d.getUTCFullYear() + Math.floor(q / 4);
  return `${year}-Q${(((q % 4) + 4) % 4) + 1}`;
}

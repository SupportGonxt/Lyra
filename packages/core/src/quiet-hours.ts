// Quiet hours are a platform floor, not a SIGNAL one: docs/05 §Journeys calls
// them "baked in as unremovable" for every outbound send, and ORBIT's journey
// engine has to honour the same window SIGNAL's outreach sender does. It lived
// in apps/api/src/engines/signal-outreach.ts, where a second module could only
// have reached it through a cross-module import (CLAUDE.md rule 6), so it lives
// here and both callers import it from one place.

/** Local hours the platform will not send in. 20:00 up to (not including) 08:00. */
export const QUIET_FROM_HOUR = 20;
export const QUIET_UNTIL_HOUR = 8;

/** The tenant-local hour of an instant. A tenant with no timezone setting reads UTC. */
export function localHour(now: number, timezone: string | undefined): number {
  try {
    return Number(
      new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: timezone ?? "UTC" }).format(now)
    );
  } catch {
    return new Date(now).getUTCHours();
  }
}

/** Quiet hours in the tenant's currency of time: 20:00–08:00 local. */
export function inQuietHours(now: number, timezone: string | undefined): boolean {
  const hour = localHour(now, timezone);
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

const HOUR_MS = 3_600_000;

/**
 * The next instant the window is open, for a caller that defers rather than
 * drops. Walked hour by hour rather than computed from a date, because the
 * tenant's offset is only ever observable through `localHour` — a DST shift or
 * a half-hour zone makes arithmetic on the UTC instant wrong. Twelve steps is
 * the whole window plus slack; a timezone that somehow never opens returns the
 * last probe rather than looping.
 */
export function nextOpenAt(now: number, timezone: string | undefined): number {
  let probe = now;
  for (let i = 0; i < 13; i++) {
    probe += HOUR_MS;
    if (!inQuietHours(probe, timezone)) return probe;
  }
  return probe;
}

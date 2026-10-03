import { and, eq, gte, inArray, like, lt } from "drizzle-orm";
import { schema } from "@lyra/db";
import { periodBounds, type Grain } from "../north-period.js";
import type { CoreDb } from "../context.js";

// NORTH's row-backed metrics, measured from the rows a seeder wrote.
//
// The nightly snapshotter (apps/api/src/engines/north-snapshotter.ts, REGISTRY)
// computes these from axis_policies and the ledger. The seed used to type them
// in beside the rows instead — 57 policies issued yesterday over a book holding
// three, a month's commission no journal line supported — so the demo showed
// figures its own records contradicted. Every seeder that writes policies or
// commission postings now measures through here, with the snapshotter's
// definitions, so a seeded snapshot is the number the snapshotter would have
// written over the same rows:
//
//   policies_issued  (day)   count(axis_policies created in the window)
//   gwp              (month) sum(axis_policies.premium_minor created in the window)
//   net_commission   (month) ledger 40xx credits less debits posted in the
//                            window, base currency — `commissionByDimension`'s
//                            netMinor, the ledger reader the snapshotter sums
//   broker_channel_share (month) b2b premium / all premium, bp; none written
//                            when the window has no policies (the snapshotter
//                            returns null and writes nothing)
//   active_policies  (month) policies in force at the rollup instant
//
// One deliberate difference: the snapshotter's active_policies is "status is
// active, now", a gauge it can only read on the night it runs. A seed writes
// every past month at once, so it reconstructs the same gauge as of each
// month's rollup — created by then and not yet ended by then — from the
// lifecycle stamps the rows carry.
//
// A window ends at the period's end or at the rollup instant (`ts`), whichever
// comes first: an open month is what the 02:00 run measured, so a row written
// at 08:00 the same day is tomorrow's number, not this one's.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The metrics this module owns. A seeder must not also type a value for one. */
export const ROW_BACKED_METRICS = ["policies_issued", "gwp", "net_commission", "broker_channel_share", "active_policies"] as const;

export interface BookPeriod {
  grain: Grain;
  period: string;
  /** When the nightly rollup wrote it: the morning after a day, the 1st after a month, today for the open month. */
  ts: number;
}

interface Window {
  since: number;
  until: number;
}

/** `[since, min(until, ts))` — what the rollup at `ts` could see of the period. */
export function windowOf(p: BookPeriod): Window {
  const bounds = periodBounds(p.grain, p.period);
  return { since: bounds.since, until: Math.min(bounds.until, p.ts) };
}

interface PolicyRow {
  createdAt: number;
  premiumMinor: number;
  channelId: string | null;
  status: string;
  endAt: number;
  cancelledAt: number | null;
  lapsedAt: number | null;
}

/** When a policy stopped being in force, or Infinity while it still is. */
function endedAt(p: PolicyRow): number {
  switch (p.status) {
    case "cancelled":
    case "ntu":
      return p.cancelledAt ?? p.createdAt;
    case "lapsed":
      return p.lapsedAt ?? p.endAt;
    case "expired":
    case "renewed":
      return p.endAt;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

const within = (at: number, w: Window): boolean => at >= w.since && at < w.until;

/** One measured value: a grand total (`dims` absent) or a slice of one. */
export interface Measurement {
  metricKey: (typeof ROW_BACKED_METRICS)[number];
  grain: Grain;
  period: string;
  ts: number;
  value: number;
  dims?: Record<string, string>;
}

/** Pure: the measurements a set of rows implies. Exported for the seed tests' sake. */
export function measurementsOf(
  periods: readonly BookPeriod[],
  rows: {
    policies: readonly PolicyRow[];
    b2bChannels: ReadonlySet<string>;
    commissionLines: readonly { side: string; amountMinor: number; postedAt: number }[];
  }
): Measurement[] {
  const out: Measurement[] = [];
  for (const p of periods) {
    const w = windowOf(p);
    const sold = rows.policies.filter((row) => within(row.createdAt, w));
    const at = { grain: p.grain, period: p.period, ts: p.ts };
    if (p.grain === "day") {
      out.push({ metricKey: "policies_issued", ...at, value: sold.length });
      continue;
    }
    const premium = sold.reduce((sum, row) => sum + row.premiumMinor, 0);
    out.push({ metricKey: "gwp", ...at, value: premium });
    // The slices the snapshotter's driver analysis reads back, keyed the way it
    // keys them (`channel=<dist_channels.id>`), so the two never disagree.
    const byChannel = new Map<string, number>();
    for (const row of sold) {
      if (row.channelId) byChannel.set(row.channelId, (byChannel.get(row.channelId) ?? 0) + row.premiumMinor);
    }
    for (const [channel, value] of [...byChannel.entries()].sort()) {
      out.push({ metricKey: "gwp", ...at, value, dims: { channel } });
    }
    out.push({
      metricKey: "net_commission",
      ...at,
      value: rows.commissionLines
        .filter((line) => within(line.postedAt, w))
        .reduce((sum, line) => sum + (line.side === "credit" ? line.amountMinor : -line.amountMinor), 0)
    });
    if (premium > 0) {
      const b2b = sold.filter((row) => row.channelId && rows.b2bChannels.has(row.channelId)).reduce((sum, row) => sum + row.premiumMinor, 0);
      out.push({ metricKey: "broker_channel_share", ...at, value: Math.round((b2b / premium) * 10_000) });
    }
    out.push({
      metricKey: "active_policies",
      ...at,
      value: rows.policies.filter((row) => row.createdAt < w.until && endedAt(row) >= w.until).length
    });
  }
  return out;
}

const dimsHashOf = (dims: Record<string, string>): string =>
  Object.entries(dims)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

/**
 * Measure the row-backed metrics for `periods` and upsert them by the snapshot
 * unique index. Re-runnable: a value the rows still support is left alone, a
 * value they no longer support (a backfill landed under it) is rewritten.
 * Returns the measurements and how many rows it inserted or changed.
 */
export async function measureBook(
  db: CoreDb,
  tenantId: string,
  periods: readonly BookPeriod[],
  opts: { currency: string; nid: (prefix: string) => string; insert?: (rows: (typeof schema.northSnapshots.$inferInsert)[]) => Promise<void> }
): Promise<{ measurements: Measurement[]; written: number }> {
  if (periods.length === 0) return { measurements: [], written: 0 };
  const windows = periods.map(windowOf);
  const from = Math.min(...windows.map((w) => w.since));
  const to = Math.max(...windows.map((w) => w.until));

  // Policies are read whole, not windowed: the in-force gauge needs every
  // contract written before the window as well as inside it.
  const policies = await db
    .select({
      createdAt: schema.axisPolicies.createdAt,
      premiumMinor: schema.axisPolicies.premiumMinor,
      channelId: schema.axisPolicies.channelId,
      status: schema.axisPolicies.status,
      endAt: schema.axisPolicies.endAt,
      cancelledAt: schema.axisPolicies.cancelledAt,
      lapsedAt: schema.axisPolicies.lapsedAt
    })
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, tenantId), lt(schema.axisPolicies.createdAt, to)));
  const b2bChannels = new Set(
    (
      await db
        .select({ id: schema.distChannels.id })
        .from(schema.distChannels)
        .where(and(eq(schema.distChannels.tenantId, tenantId), eq(schema.distChannels.kind, "b2b")))
    ).map((row) => row.id)
  );
  const l = schema.ledgerJournalLines;
  const commissionLines = await db
    .select({ side: l.side, amountMinor: l.amountMinor, postedAt: l.postedAt })
    .from(l)
    .where(and(eq(l.tenantId, tenantId), like(l.accountCode, "40%"), eq(l.currency, opts.currency), gte(l.postedAt, from), lt(l.postedAt, to)));

  const measurements = measurementsOf(periods, { policies, b2bChannels, commissionLines });

  const s = schema.northSnapshots;
  const existing = new Map(
    (
      await db
        .select({ id: s.id, metricKey: s.metricKey, grain: s.grain, period: s.period, dimsHash: s.dimsHash, value: s.value, ts: s.ts })
        .from(s)
        .where(and(eq(s.tenantId, tenantId), inArray(s.metricKey, [...ROW_BACKED_METRICS])))
    ).map((row) => [`${row.metricKey}|${row.grain}|${row.period}|${row.dimsHash}`, row])
  );

  const fresh: (typeof s.$inferInsert)[] = [];
  let written = 0;
  for (const m of measurements) {
    const dimsHash = m.dims ? dimsHashOf(m.dims) : "";
    const before = existing.get(`${m.metricKey}|${m.grain}|${m.period}|${dimsHash}`);
    if (before) {
      if (before.value === m.value && before.ts === m.ts) continue;
      await db.update(s).set({ value: m.value, ts: m.ts }).where(eq(s.id, before.id));
      written++;
      continue;
    }
    fresh.push({
      id: opts.nid("snp"),
      tenantId,
      metricKey: m.metricKey,
      grain: m.grain,
      period: m.period,
      dimsJson: m.dims ? JSON.stringify(m.dims) : null,
      dimsHash,
      value: m.value,
      ts: m.ts
    });
  }
  if (fresh.length > 0) {
    if (opts.insert) await opts.insert(fresh);
    else await db.insert(s).values(fresh);
  }
  return { measurements, written: written + fresh.length };
}

/**
 * The periods a backfill of the last `days` days covers, stamped the way the
 * nightly rollup stamps them: a closed day the morning after, a closed month
 * on the 1st of the next, the open month this morning.
 */
export function windowPeriods(days: number, now: number): BookPeriod[] {
  const today = new Date(now).setUTCHours(0, 0, 0, 0);
  const out: BookPeriod[] = [];
  const months = new Set<string>();
  for (let back = days; back >= 1; back--) {
    const midnight = new Date(now - back * DAY_MS).setUTCHours(0, 0, 0, 0);
    out.push({ grain: "day", period: new Date(midnight).toISOString().slice(0, 10), ts: midnight + DAY_MS + 2 * HOUR_MS });
    months.add(new Date(midnight).toISOString().slice(0, 7));
  }
  for (const period of [...months].sort()) {
    const next = periodBounds("month", period).until;
    out.push({ grain: "month", period, ts: (next > now ? today : next) + 2 * HOUR_MS });
  }
  return out;
}

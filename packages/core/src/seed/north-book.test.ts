import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import { periodBounds } from "../north-period.js";
import { seed } from "../seed.js";
import { seedHistory } from "./history.js";
import { seedModuleHistory } from "./history-modules.js";
import { measurementsOf, windowOf } from "./north-book.js";
import type { CoreDb } from "../context.js";

// The demo's NORTH figures are only worth showing if the records behind them
// say the same thing. A seeded snapshot is checked here against the seeded
// rows with the snapshotter's own definitions, and the ledger is checked
// against the policies: every contract that carries commission is accrued in
// the month it was written, so NORTH, the P&L and the policy list agree.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

async function freshDb(): Promise<CoreDb> {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sql of statements) await client.execute(sql);
  return drizzle(client) as unknown as CoreDb;
}

/** Commission-accrual transaction types: what puts a contract's commission on the books. */
const ACCRUALS = new Set(["BIND", "CMSN-ACCR"]);
/** Commission income: new business and renewal (chart of accounts 4000/4010). */
const COMMISSION_INCOME = new Set(["4000", "4010"]);

const signed = (line: { side: string; amountMinor: number }): number => (line.side === "credit" ? line.amountMinor : -line.amountMinor);

async function book(db: CoreDb) {
  const [policies, snapshots, txns, lines] = await Promise.all([
    db.select().from(schema.axisPolicies),
    db.select().from(schema.northSnapshots),
    db.select().from(schema.ledgerTxns),
    db.select().from(schema.ledgerJournalLines)
  ]);
  const txnById = new Map(txns.map((t) => [t.id, t]));
  return { policies, snapshots, txns, lines, txnById };
}

/**
 * Every row-backed headline the tenant holds equals what its rows add up to,
 * by the snapshotter's definitions. Returns how many periods it checked.
 */
async function expectMeasuredFromRows(db: CoreDb): Promise<{ days: number; months: number }> {
  const { policies, snapshots, lines } = await book(db);
  const headline = (metricKey: string) => snapshots.filter((s) => s.metricKey === metricKey && s.dimsHash === "");
  const sold = (w: { since: number; until: number }) => policies.filter((p) => p.createdAt >= w.since && p.createdAt < w.until);

  const days = headline("policies_issued");
  // [period, snapshot, rows] for every day the two disagree on.
  expect(
    days
      .map((s) => [s.period, s.value, sold(windowOf({ grain: "day", period: s.period, ts: s.ts })).length] as const)
      .filter(([, snap, rows]) => snap !== rows)
  ).toEqual([]);

  const months = headline("gwp");
  for (const snap of months) {
    const w = windowOf({ grain: "month", period: snap.period, ts: snap.ts });
    expect([snap.period, snap.value]).toEqual([snap.period, sold(w).reduce((sum, p) => sum + p.premiumMinor, 0)]);
    // The channel slices are the same rows cut up, so they sum to the headline.
    const slices = snapshots.filter((s) => s.metricKey === "gwp" && s.period === snap.period && s.dimsHash.startsWith("channel="));
    expect([snap.period, slices.reduce((sum, s) => sum + s.value, 0)]).toEqual([snap.period, snap.value]);
  }

  const commission = headline("net_commission");
  expect(commission.map((s) => s.period).sort()).toEqual(months.map((s) => s.period).sort());
  for (const snap of commission) {
    const w = windowOf({ grain: "month", period: snap.period, ts: snap.ts });
    // The snapshotter's definition: every 40xx line in the window, net.
    const ledger = lines
      .filter((l) => l.accountCode.startsWith("40") && l.currency === "AED" && l.postedAt >= w.since && l.postedAt < w.until)
      .reduce((sum, l) => sum + signed(l), 0);
    expect([snap.period, snap.value]).toEqual([snap.period, ledger]);
  }
  return { days: days.length, months: months.length };
}

describe.each([
  ["the fixed test clock", undefined],
  // Early in a month: last month's 30-day-offset fixtures land in this one.
  ["three days into a month", Date.UTC(2026, 9, 3, 8)],
  // Late in a month: the sale issued two days out lands in the next one.
  ["the last day of a month", Date.UTC(2026, 6, 31, 20)]
])("NORTH's seeded snapshots agree with the seeded book, seeded at %s", (_label, now) => {
  it("measures policies issued, premium and commission from the rows, not from a typed series", async () => {
    const db = await freshDb();
    await seed(db, { password: "gonxt-test-password", ...(now === undefined ? {} : { now }) });
    const { policies, snapshots, lines, txnById } = await book(db);
    expect(await expectMeasuredFromRows(db)).toEqual({ days: 5, months: 4 });

    for (const snap of snapshots.filter((s) => s.metricKey === "net_commission" && s.dimsHash === "")) {
      const w = windowOf({ grain: "month", period: snap.period, ts: snap.ts });
      // The ledger's commission is the commission on the window's contracts,
      // less the b2b channel's share booked at bind and less any contract
      // unwound since: nothing else posts to 40xx before the rollup.
      const inWindow = (at: number | null): boolean => at !== null && at >= w.since && at < w.until;
      const written = policies.filter((p) => inWindow(p.createdAt)).reduce((sum, p) => sum + p.commissionMinor, 0);
      const unwound = policies.filter((p) => inWindow(p.cancelledAt)).reduce((sum, p) => sum + p.commissionMinor, 0);
      const channelShare = lines
        .filter((l) => l.accountCode === "2100" && ACCRUALS.has(txnById.get(l.txnId)!.type) && inWindow(l.postedAt))
        .reduce((sum, l) => sum + signed(l), 0);
      expect([snap.period, snap.value]).toEqual([snap.period, written - unwound - channelShare]);
    }

    // The series is measured, so its narration is too: no briefing headlines a
    // row-backed metric with a value the snapshot beside it does not hold.
    const briefings = await db.select().from(schema.northBriefings);
    for (const b of briefings) {
      for (const h of JSON.parse(b.highlightsJson ?? "[]") as { metricKey: string; period: string; value: number }[]) {
        const snap = snapshots.find((s) => s.metricKey === h.metricKey && s.period === h.period && s.dimsHash === "");
        if (["policies_issued", "gwp", "net_commission", "broker_channel_share", "active_policies"].includes(h.metricKey)) {
          expect([b.date, h.metricKey, h.value]).toEqual([b.date, h.metricKey, snap?.value]);
        }
      }
    }
  });

  it("accrues every contract's commission in the month it was written, so the P&L and the policies agree", async () => {
    const db = await freshDb();
    await seed(db, { password: "gonxt-test-password", ...(now === undefined ? {} : { now }) });
    const { policies, lines, txnById } = await book(db);
    const firstPeriod = Math.min(...(await db.select().from(schema.ledgerPeriods)).map((p) => p.startAt));

    // The channel's share of a b2b bind is a liability (2100) from the moment it
    // is earned, never our income — the one part of a contract's commission the
    // P&L leaves out on purpose.
    const accrual = lines.filter((l) => ACCRUALS.has(txnById.get(l.txnId)!.type));
    const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);
    const monthsSeen = new Set([...policies.filter((p) => p.createdAt >= firstPeriod).map((p) => monthOf(p.createdAt)), ...lines.map((l) => monthOf(l.postedAt))]);
    expect(monthsSeen.size).toBeGreaterThan(0);

    for (const month of monthsSeen) {
      const w = periodBounds("month", month);
      const inMonth = (at: number | null): boolean => at !== null && at >= w.since && at < w.until;
      const written = policies.filter((p) => inMonth(p.createdAt)).reduce((sum, p) => sum + p.commissionMinor, 0);
      const unwound = policies.filter((p) => inMonth(p.cancelledAt)).reduce((sum, p) => sum + p.commissionMinor, 0);

      const income = lines.filter((l) => COMMISSION_INCOME.has(l.accountCode) && inMonth(l.postedAt)).reduce((sum, l) => sum + signed(l), 0);
      const channelShare = accrual.filter((l) => l.accountCode === "2100" && inMonth(l.postedAt)).reduce((sum, l) => sum + signed(l), 0);

      expect([month, income + channelShare]).toEqual([month, written - unwound]);
      // Nothing but an accrual touches commission income: no figure on the P&L
      // that a contract does not explain.
      expect(lines.filter((l) => COMMISSION_INCOME.has(l.accountCode) && inMonth(l.postedAt) && !ACCRUALS.has(txnById.get(l.txnId)!.type))).toEqual([]);
    }
  });
});

describe("measurementsOf", () => {
  const day = { grain: "day" as const, period: "2026-03-04", ts: Date.UTC(2026, 2, 5, 2) };
  const month = { grain: "month" as const, period: "2026-03", ts: Date.UTC(2026, 2, 10, 2) };
  const policy = (createdAt: number, premiumMinor: number, channelId: string | null, extra: Partial<{ status: string; cancelledAt: number }> = {}) => ({
    createdAt,
    premiumMinor,
    channelId,
    status: extra.status ?? "active",
    endAt: createdAt + 365 * 86_400_000,
    cancelledAt: extra.cancelledAt ?? null,
    lapsedAt: null
  });

  it("windows an open month at its rollup instant, not at its end", () => {
    const rows = {
      policies: [policy(Date.UTC(2026, 2, 4, 9), 100_000, "ch_b2b"), policy(Date.UTC(2026, 2, 9, 9), 300_000, "ch_web"), policy(Date.UTC(2026, 2, 10, 9), 999_000, "ch_web")],
      b2bChannels: new Set(["ch_b2b"]),
      commissionLines: [
        { side: "credit", amountMinor: 15_000, postedAt: Date.UTC(2026, 2, 4, 9) },
        { side: "debit", amountMinor: 5_000, postedAt: Date.UTC(2026, 2, 6, 9) },
        { side: "credit", amountMinor: 70_000, postedAt: Date.UTC(2026, 2, 10, 9) }
      ]
    };
    const got = Object.fromEntries(measurementsOf([day, month], rows).map((m) => [`${m.metricKey}:${m.grain}${m.dims ? `:${m.dims.channel}` : ""}`, m.value]));
    expect(got).toEqual({
      "policies_issued:day": 1,
      "gwp:month": 400_000,
      "gwp:month:ch_b2b": 100_000,
      "gwp:month:ch_web": 300_000,
      "net_commission:month": 10_000,
      "broker_channel_share:month": 2_500,
      "active_policies:month": 2
    });
  });

  it("writes no channel share for a month with no premium, and counts a cancelled contract out of force", () => {
    const cancelled = policy(Date.UTC(2026, 1, 3), 100_000, "ch_web", { status: "cancelled", cancelledAt: Date.UTC(2026, 2, 2) });
    const got = measurementsOf([month], { policies: [cancelled], b2bChannels: new Set(), commissionLines: [] });
    expect(got.map((m) => [m.metricKey, m.value])).toEqual([
      ["gwp", 0],
      ["net_commission", 0],
      ["active_policies", 0]
    ]);
  });
});

describe("a deployed tenant's backfill", () => {
  // seed() once, then the history passes a deployed demo gets: the core seed
  // measured its months over the core book alone, so a backfill that lands
  // under them has to rewrite them, not skip a key it finds already written.
  it("re-measures the months the core seed measured, so NORTH reads the whole book", async () => {
    const db = await freshDb();
    const now = Date.UTC(2026, 9, 3, 8);
    const { tenantId } = await seed(db, { password: "gonxt-test-password", now });
    const gwpSeptember = async () =>
      (await db.select().from(schema.northSnapshots)).find((s) => s.metricKey === "gwp" && s.period === "2026-09" && s.dimsHash === "")!;
    const before = await gwpSeptember();

    await seedHistory(db, tenantId, { days: 45, now });
    await seedModuleHistory(db, tenantId, { days: 45, now });

    const after = await gwpSeptember();
    expect(after.id).toBe(before.id);
    expect(after.value).toBeGreaterThan(before.value);
    // Every day the backfill covers plus the core seed's five, and every month.
    const checked = await expectMeasuredFromRows(db);
    expect(checked.days).toBe(45);
    expect(checked.months).toBe(4);
  });
});

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, inArray } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { seedHistory } from "./history.js";
import { DAY, HOUR, MINUTE } from "./context.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 7, 12, 8, 0, 0);
const TENANT = "t_history_test";
const DAYS = 120;

/** A 120-day window off `NOW` opens on 14 Apr and closes on 11 Aug. */
const midnightOf = (dayKey: string): number => Date.parse(`${dayKey}T00:00:00.000Z`);

/**
 * The day the exact-value assertions below are written against — mid-window,
 * inside a month that is wholly closed, so it exercises both the closed-period
 * branch and a full month's rollup. Nothing about it is special otherwise.
 */
const SAMPLE = "2026-06-15";

let client: Client;
let db: CoreDb;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;
});

/** The three months the core seed opens, so the backfill has an anchor to age against. */
async function seedPeriods(): Promise<void> {
  for (const delta of [-1, 0]) {
    const start = Date.UTC(2026, 7 + delta, 1);
    await db.insert(schema.ledgerPeriods).values({
      id: `per_${delta}`,
      tenantId: TENANT,
      code: new Date(start).toISOString().slice(0, 7),
      startAt: start,
      endAt: Date.UTC(2026, 8 + delta, 1) - 1,
      state: "open",
      checklistJson: null,
      closePackFileId: null,
      closedBy: null,
      closedAt: null
    });
  }
}

describe("seedHistory", () => {
  it("writes a transaction history across the whole window", async () => {
    await seedPeriods();
    const result = await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    expect(result.daysWritten).toBe(DAYS);
    expect(result.daysSkipped).toBe(0);
    expect(result.txns).toBe(DAYS * 2 * 3);
    expect(result.batches).toBe(result.txns);

    const txns = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));
    expect(txns).toHaveLength(DAYS * 2 * 3);
    // Every posting lands inside the window and is settled — a trend line drawn
    // over this book has a point on every day of it.
    for (const txn of txns) {
      expect(txn.state).toBe("settled");
      expect(txn.createdAt).toBeGreaterThan(NOW - (DAYS + 1) * DAY);
      expect(txn.createdAt).toBeLessThanOrEqual(NOW);
    }
    const days = new Set(txns.map((t) => new Date(t.createdAt).toISOString().slice(0, 10)));
    expect(days.size).toBe(DAYS);
  });

  it("creates the periods the window reaches back into, closed if they predate the book", async () => {
    await seedPeriods();
    const result = await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    // 120 days back from 12 Aug is 14 Apr: Apr, May, Jun are missing (Jul, Aug exist).
    expect(result.periodsCreated).toBe(3);
    const periods = await db.select().from(schema.ledgerPeriods).where(eq(schema.ledgerPeriods.tenantId, TENANT));
    const byCode = new Map(periods.map((p) => [p.code, p]));
    expect([...byCode.keys()].sort()).toEqual(["2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    for (const code of ["2026-04", "2026-05", "2026-06"]) {
      expect(byCode.get(code)!.state).toBe("hard_closed");
      expect(byCode.get(code)!.closedAt).not.toBeNull();
    }

    // A created period spans its month exactly, and a closed one carries the
    // same three checks a real close writes — the close pack renders them by
    // name, so a blank or renamed check is a blank row on the pack.
    const april = byCode.get("2026-04")!;
    expect(april.id.startsWith("per_")).toBe(true);
    expect(april.startAt).toBe(Date.UTC(2026, 3, 1));
    expect(april.endAt).toBe(Date.UTC(2026, 4, 1) - 1);
    expect(april.closedBy).toBe("system:backfill");
    expect(april.closedAt).toBe(Date.UTC(2026, 4, 1) + 5 * DAY);
    expect(JSON.parse(april.checklistJson!)).toEqual([
      { name: "trial_balance_zero@2026-04", ok: true },
      { name: "no_pending_external@2026-04", ok: true },
      { name: "no_open_client_money_breach@2026-04", ok: true }
    ]);

    // Every batch is filed against a real period — an orphan batch never
    // appears in a close pack and silently drops out of the trial balance.
    const batches = await db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.tenantId, TENANT));
    for (const batch of batches) expect(periods.some((p) => p.id === batch.periodId)).toBe(true);
  });

  it("balances every batch it posts", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    const lines = await db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, TENANT));
    const sums = new Map<string, { debit: number; credit: number }>();
    for (const line of lines) {
      const s = sums.get(line.batchId) ?? { debit: 0, credit: 0 };
      if (line.side === "debit") s.debit += line.amountMinor;
      else s.credit += line.amountMinor;
      // Base currency equals txn currency here, so a divergence means the
      // base leg was computed from the wrong amount.
      expect(line.baseAmountMinor).toBe(line.amountMinor);
      sums.set(line.batchId, s);
    }
    expect(sums.size).toBeGreaterThan(0);
    for (const [batchId, s] of sums) expect(`${batchId}:${s.debit}`).toBe(`${batchId}:${s.credit}`);

    const batches = await db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.tenantId, TENANT));
    for (const batch of batches) {
      expect(batch.totalDebitMinor).toBe(batch.totalCreditMinor);
      expect(batch.baseTotalDebitMinor).toBe(batch.totalDebitMinor);
    }
  });

  it("never lets client money fall below the liability it segregates", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    // docs/19 §5: 1010 (cash held for clients) ≥ 2010 (what is owed to them),
    // checked after every single posting rather than only at the end — a
    // remittance that ran before its collection would balance but breach.
    const lines = await db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, TENANT));
    lines.sort((a, b) => a.postedAt - b.postedAt || a.seq - b.seq);
    let cash = 0;
    let owed = 0;
    for (const line of lines) {
      const signed = line.side === "debit" ? line.amountMinor : -line.amountMinor;
      if (line.accountCode === "1010") cash += signed;
      if (line.accountCode === "2010") owed -= signed; // liability: credit increases it
      expect(cash).toBeGreaterThanOrEqual(owed);
    }
  });

  it("rolls the account balance cache forward instead of overwriting it", async () => {
    await seedPeriods();
    const opening = 500_000;
    await db.insert(schema.ledgerAccountBalances).values({
      id: "bal_seed_1000",
      tenantId: TENANT,
      accountCode: "1000",
      currency: "AED",
      debitMinor: opening,
      creditMinor: 0,
      baseDebitMinor: opening,
      baseCreditMinor: 0,
      updatedAt: NOW - 400 * DAY
    });

    await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    const lines = await db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, TENANT));
    const posted = lines
      .filter((l) => l.accountCode === "1000" && l.side === "debit")
      .reduce((n, l) => n + l.amountMinor, 0);
    expect(posted).toBeGreaterThan(0);

    const [balance] = await db
      .select()
      .from(schema.ledgerAccountBalances)
      .where(and(eq(schema.ledgerAccountBalances.tenantId, TENANT), eq(schema.ledgerAccountBalances.accountCode, "1000")));
    expect(balance!.debitMinor).toBe(opening + posted);
    expect(balance!.baseDebitMinor).toBe(opening + posted);
    expect(balance!.id).toBe("bal_seed_1000");
  });

  it("is a no-op on a second run against the same window", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: DAYS, now: NOW });
    const before = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));

    // Re-running is how a half-finished remote seed is resumed, so it has to be
    // safe rather than merely tolerated.
    const again = await seedHistory(db, TENANT, { days: DAYS, now: NOW });
    expect(again.daysWritten).toBe(0);
    expect(again.daysSkipped).toBe(DAYS);
    expect(again.txns).toBe(0);
    expect(again.periodsCreated).toBe(0);

    const after = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));
    expect(after).toHaveLength(before.length);
  });

  it("extends a window that already covers part of the range", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: 30, now: NOW });
    const wider = await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    expect(wider.daysWritten).toBe(DAYS - 30);
    expect(wider.daysSkipped).toBe(30);
    const txns = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));
    expect(txns).toHaveLength(DAYS * 2 * 3);
    // Two backfills, 150 days between them: ~4s warm, so the 5s default made
    // this the one flaky spec in the file.
  }, 30_000);

  it("measures every day it writes, so the metric screens open on the same book", async () => {
    await seedPeriods();
    const result = await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    // One unit-economics row per trading day: the home KPI wall reads this
    // table for the last 30 days and shows nothing without it.
    const econ = await db.select().from(schema.unitEconomics).where(eq(schema.unitEconomics.tenantId, TENANT));
    expect(econ).toHaveLength(DAYS);
    expect(result.unitEconomics).toBe(DAYS);
    expect(econ.every((r) => r.volume === 2 && r.revenueMinor > 0)).toBe(true);

    const snaps = await db.select().from(schema.northSnapshots).where(eq(schema.northSnapshots.tenantId, TENANT));
    // Four daily metrics on every day, seven monthly ones on each month
    // touched. The b2b share of premium is the eighth, and it is not written:
    // this pass writes no contracts, so there is no premium to take a share of
    // and the snapshotter would write nothing either (the module pass does).
    const months = new Set(snaps.filter((s) => s.grain === "month").map((s) => s.period));
    expect(snaps.filter((s) => s.grain === "day")).toHaveLength(DAYS * 4);
    expect(snaps.filter((s) => s.grain === "month")).toHaveLength(months.size * 7);
    expect(result.snapshots).toBe(snaps.length);

    // The measurements are the rows, not a parallel invention: the month's
    // commission is the ledger's commission income for it, and premium and
    // policies count the contracts — none yet, until the module pass writes
    // them (history-modules.test.ts measures the two passes together).
    const at = (metricKey: string) => snaps.find((s) => s.metricKey === metricKey && s.period === "2026-07")!.value;
    const lines = await db
      .select()
      .from(schema.ledgerJournalLines)
      .where(and(eq(schema.ledgerJournalLines.tenantId, TENANT), eq(schema.ledgerJournalLines.accountCode, "4000")));
    const earnedInJuly = lines
      .filter((l) => l.side === "credit" && new Date(l.postedAt).toISOString().startsWith("2026-07"))
      .reduce((n, l) => n + l.amountMinor, 0);
    expect(earnedInJuly).toBeGreaterThan(0);
    expect(at("net_commission")).toBe(earnedInJuly);
    expect([at("gwp"), at("active_policies")]).toEqual([0, 0]);
  });

  it("posts a sale as collect, accrue, remit — with the accounts and memos a close pack reads", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: DAYS, now: NOW, postedBy: "usr_fin" });

    const ref = `${SAMPLE}:0`;
    const at = midnightOf(SAMPLE) + 9 * HOUR;
    const txns = await db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, TENANT), eq(schema.ledgerTxns.correlationId, `history:sale:${ref}`)));
    txns.sort((a, b) => a.createdAt - b.createdAt);

    expect(txns.map((t) => t.type)).toEqual(["PREM-COLLECT", "CMSN-ACCR", "PREM-REMIT"]);
    // The idempotency keys are what a re-run matches on, so they are contract,
    // not decoration: change one and the backfill double-posts the whole window.
    expect(txns.map((t) => t.idempotencyKey)).toEqual([
      `history:prem-collect:${ref}`,
      `history:cmsn-accr:${ref}`,
      `history:prem-remit:${ref}`
    ]);
    expect(txns.map((t) => t.actorKind)).toEqual(["customer", "system", "user"]);
    expect(txns.map((t) => t.actorId)).toEqual([`history:${ref}`, "scheduler", "usr_fin"]);
    // Collection at 09:00, accrual five minutes later, remittance six hours on.
    expect(txns.map((t) => t.createdAt)).toEqual([at, at + 5 * MINUTE, at + 6 * HOUR]);
    for (const txn of txns) {
      expect(txn.id.startsWith("txn_")).toBe(true);
      expect(txn.updatedAt).toBe(txn.createdAt + MINUTE);
      expect(txn.settledAt).toBe(txn.createdAt + MINUTE);
    }
    // 310_000 premium, 5% VAT on top, 15% commission out of the premium.
    expect(txns.map((t) => JSON.parse(t.amountsJson!))).toEqual([
      { gross: 325_500, net: 310_000, tax: 15_500 },
      { gross: 46_500, net: 46_500, tax: 0 },
      { gross: 325_500, commission: 46_500, net: 279_000 }
    ]);

    const lines = await db
      .select()
      .from(schema.ledgerJournalLines)
      .where(
        and(
          eq(schema.ledgerJournalLines.tenantId, TENANT),
          inArray(
            schema.ledgerJournalLines.txnId,
            txns.map((t) => t.id)
          )
        )
      );
    lines.sort((a, b) => a.postedAt - b.postedAt || a.seq - b.seq);
    expect(lines.map((l) => `${l.seq} ${l.accountCode} ${l.side} ${l.amountMinor} ${l.memo}`)).toEqual([
      `1 1010 debit 325500 Premium collected ${ref}`,
      `2 2010 credit 325500 Client money held ${ref}`,
      `1 1100 debit 46500 Commission receivable ${ref}`,
      `2 4000 credit 46500 Commission earned ${ref}`,
      `1 2010 debit 325500 Client money released ${ref}`,
      `2 1000 debit 46500 Commission received ${ref}`,
      `3 1010 credit 325500 Remitted to insurer ${ref}`,
      `4 1100 credit 46500 Receivable cleared ${ref}`
    ]);
    expect(lines.every((l) => l.id.startsWith("jln_"))).toBe(true);

    // The batch is stamped with the actor the caller named, not the fallback.
    const [batch] = await db
      .select()
      .from(schema.ledgerJournalBatches)
      .where(eq(schema.ledgerJournalBatches.id, txns[0]!.ledgerBatchId!));
    expect(batch!.id.startsWith("jbt_")).toBe(true);
    expect(batch!.postedBy).toBe("user:usr_fin");
    expect(batch!.postedAt).toBe(at);

    // Every settled txn walks initiated → settled a minute apart; a state
    // machine that jumped straight to settled would have no audit trail.
    const transitions = await db
      .select()
      .from(schema.ledgerTxnTransitions)
      .where(and(eq(schema.ledgerTxnTransitions.tenantId, TENANT), eq(schema.ledgerTxnTransitions.txnId, txns[0]!.id)));
    transitions.sort((a, b) => a.ts - b.ts);
    expect(transitions.map((t) => [t.fromState, t.toState, t.ts, t.actorRef])).toEqual([
      [null, "initiated", at, "user:usr_fin"],
      ["initiated", "settled", at + MINUTE, "user:usr_fin"]
    ]);
    expect(transitions.every((t) => t.id.startsWith("txt_"))).toBe(true);
  });

  it("writes the measurement rows the metric screens read, down to the value", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: DAYS, now: NOW });

    const econ = await db.select().from(schema.unitEconomics).where(eq(schema.unitEconomics.tenantId, TENANT));
    // Written oldest-first, so a chart that trusts insertion order draws forward.
    expect(econ.map((r) => r.day)).toEqual([...econ.map((r) => r.day)].sort());
    const sample = econ.find((r) => r.day === SAMPLE)!;
    expect(sample.id.startsWith("uec_")).toBe(true);
    expect(sample).toMatchObject({
      module: "dist",
      unit: "bind",
      volume: 2,
      currency: "AED",
      // Per-bind cost of rating the panel and drafting the comparison, ×2 sales.
      aiCostMicro: 82_400,
      mediaCostMicro: 36_000,
      humanMinutes: 24,
      // Revenue on a bind is the commission, not the premium.
      revenueMinor: 84_750,
      // Booked at 23:00 the same day, not at midnight the next one.
      updatedAt: midnightOf(SAMPLE) + 23 * HOUR
    });

    const snaps = await db.select().from(schema.northSnapshots).where(eq(schema.northSnapshots.tenantId, TENANT));
    const at = (metricKey: string, period: string) => snaps.find((s) => s.metricKey === metricKey && s.period === period)!;
    // The keys are the catalogue NORTH renders by. A missing or renamed key is
    // an empty tile on the metric wall, not a test-only detail.
    expect(new Set(snaps.filter((s) => s.grain === "day").map((s) => s.metricKey))).toEqual(
      new Set(["policies_issued", "quote_to_bind_rate", "panel_response_rate", "quote_latency_p95"])
    );
    expect(new Set(snaps.filter((s) => s.grain === "month").map((s) => s.metricKey))).toEqual(
      new Set([
        "gwp",
        "net_commission",
        "active_policies",
        "cac_per_policy",
        "renewal_retention",
        "loss_ratio",
        "ai_cost_per_case"
      ])
    );
    expect(snaps.every((s) => s.id.startsWith("snp_") && s.dimsHash === "" && s.dimsJson === null)).toBe(true);
    expect([...new Set(snaps.filter((s) => s.grain === "month").map((s) => s.period))]).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
      "2026-07",
      "2026-08"
    ]);

    // The nightly rollup publishes a closed day at 02:00 the next morning.
    const dayTs = midnightOf(SAMPLE) + DAY + 2 * HOUR;
    expect(["policies_issued", "quote_to_bind_rate", "panel_response_rate", "quote_latency_p95"].map((k) => [
      k,
      at(k, SAMPLE).value,
      at(k, SAMPLE).ts
    ])).toEqual([
      // Measured from axis_policies, which this pass does not write.
      ["policies_issued", 0, dayTs],
      // Rates have no ledger source, so they follow the seed's deterministic
      // curve — pinned here because "deterministic" is the whole promise.
      ["quote_to_bind_rate", 2_066, dayTs],
      ["panel_response_rate", 9_752, dayTs],
      ["quote_latency_p95", 3_268, dayTs]
    ]);

    // A closed month rolls up on the 1st of the next; the open one re-runs
    // nightly, so August is stamped this morning rather than in September.
    expect(at("gwp", "2026-06").ts).toBe(Date.UTC(2026, 6, 1) + 2 * HOUR);
    expect(at("gwp", "2026-08").ts).toBe(Date.UTC(2026, 7, 12) + 2 * HOUR);
    expect([
      at("gwp", "2026-06").value,
      at("net_commission", "2026-06").value,
      at("cac_per_policy", "2026-06").value,
      at("renewal_retention", "2026-06").value,
      at("loss_ratio", "2026-06").value,
      at("ai_cost_per_case", "2026-06").value
    ]).toEqual([0, 2_540_250, 22_069, 7_974, 6_427, 89]);
  });

  it("does not duplicate measurements on a second run", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: 30, now: NOW });
    const again = await seedHistory(db, TENANT, { days: 30, now: NOW });

    expect(again.unitEconomics).toBe(0);
    expect(again.snapshots).toBe(0);
    const econ = await db.select().from(schema.unitEconomics).where(eq(schema.unitEconomics.tenantId, TENANT));
    expect(econ).toHaveLength(30);
  });

  it("stays inside one tenant", async () => {
    await seedPeriods();
    await seedHistory(db, TENANT, { days: 10, now: NOW });
    const others = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, "t_other"));
    expect(others).toEqual([]);
  });
});

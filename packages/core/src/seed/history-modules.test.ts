import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, sql } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { chainFor, verifyChain } from "../audit.js";
import { CASE_STATES } from "../lifecycle.js";
import { DEFAULT_K_FLOOR } from "../k-anonymity.js";
import { PROTECTED_AXES, countAttributes, parseAttributeTag, targetablePool, targetingPack } from "../targeting.js";
import { seedHistory } from "./history.js";
import { seedModuleHistory, type ModuleHistoryResult } from "./history-modules.js";
import { DAY } from "./context.js";

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
const TENANT = "t_module_history";
const DAYS = 365;

/**
 * Every table the module backfill writes, with the column carrying the event's
 * own clock. The list is the spec: a module missing from here has no year of
 * history, so covering a new one means adding a line and watching the span
 * assertion hold.
 */
const TIMED = [
  ["axis_policies", schema.axisPolicies, schema.axisPolicies.createdAt],
  ["axis_policy_versions", schema.axisPolicyVersions, schema.axisPolicyVersions.createdAt],
  ["axis_cases", schema.axisCases, schema.axisCases.createdAt],
  ["axis_claims", schema.axisClaims, schema.axisClaims.createdAt],
  ["axis_claim_reserves", schema.axisClaimReserves, schema.axisClaimReserves.createdAt],
  ["axis_claim_payments", schema.axisClaimPayments, schema.axisClaimPayments.createdAt],
  ["axis_bordereaux", schema.axisBordereaux, schema.axisBordereaux.createdAt],
  ["axis_bordereau_lines", schema.axisBordereauLines, schema.axisBordereauLines.createdAt],
  ["axis_telemetry_points", schema.axisTelemetryPoints, schema.axisTelemetryPoints.at],
  ["dist_quote_requests", schema.distQuoteRequests, schema.distQuoteRequests.createdAt],
  ["dist_quote_responses", schema.distQuoteResponses, schema.distQuoteResponses.createdAt],
  ["dist_commission_entries", schema.distCommissionEntries, schema.distCommissionEntries.createdAt],
  ["ledger_payment_plans", schema.ledgerPaymentPlans, schema.ledgerPaymentPlans.createdAt],
  ["ledger_settlements", schema.ledgerSettlements, schema.ledgerSettlements.createdAt],
  ["orbit_renewals", schema.orbitRenewals, schema.orbitRenewals.createdAt],
  ["orbit_conversations", schema.orbitConversations, schema.orbitConversations.createdAt],
  ["orbit_messages", schema.orbitMessages, schema.orbitMessages.ts],
  ["scout_signals", schema.scoutSignals, schema.scoutSignals.observedAt],
  ["scout_whitespaces", schema.scoutWhitespaces, schema.scoutWhitespaces.createdAt],
  ["signal_campaigns", schema.signalCampaigns, schema.signalCampaigns.createdAt],
  ["signal_creatives", schema.signalCreatives, schema.signalCreatives.createdAt],
  ["signal_spend", schema.signalSpend, schema.signalSpend.ts],
  ["core_approvals", schema.approvals, schema.approvals.requestedAt],
  ["ai_audit_log", schema.aiAuditLog, schema.aiAuditLog.ts],
  ["core_audit_log", schema.auditLog, schema.auditLog.ts]
] as const;

/** Tables with no clock of their own — aggregates over the whole window. */
const UNTIMED = [
  ["scout_clusters", schema.scoutClusters],
  ["scout_panel_bench", schema.scoutPanelBench]
] as const;

let client: Client;
let db: CoreDb;
let result: ModuleHistoryResult;

/** One year, seeded once: every assertion below reads the same book. */
beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const stmt of migrationStatements()) await client.execute(stmt);
  db = drizzle(client) as unknown as CoreDb;
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
  await seedHistory(db, TENANT, { days: DAYS, now: NOW });
  result = await seedModuleHistory(db, TENANT, { days: DAYS, now: NOW });
}, 600_000);

describe("seedModuleHistory", () => {
  it("balances every transaction it posts, and the book as a whole", async () => {
    const lines = await db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.tenantId, TENANT));
    expect(lines.length).toBeGreaterThan(0);

    const perTxn = new Map<string, { debit: number; credit: number }>();
    let debit = 0;
    let credit = 0;
    for (const line of lines) {
      const t = perTxn.get(line.txnId) ?? { debit: 0, credit: 0 };
      if (line.side === "debit") {
        t.debit += line.amountMinor;
        debit += line.amountMinor;
      } else {
        t.credit += line.amountMinor;
        credit += line.amountMinor;
      }
      perTxn.set(line.txnId, t);
    }
    expect([...perTxn].filter(([, t]) => t.debit !== t.credit)).toEqual([]);
    expect(debit).toBe(credit);

    // The batch header has to agree with the lines it totals, or a close pack
    // reconciles against a number nothing produced.
    const batches = await db
      .select()
      .from(schema.ledgerJournalBatches)
      .where(eq(schema.ledgerJournalBatches.tenantId, TENANT));
    const wrong = batches.filter((b) => {
      const t = perTxn.get(b.txnId);
      return !t || t.debit !== b.totalDebitMinor || t.credit !== b.totalCreditMinor;
    });
    expect(wrong).toEqual([]);
  });

  it("keeps client money at or above the liability it segregates, at every instant of the year", async () => {
    const lines = await db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.tenantId, TENANT));
    lines.sort(
      (a, b) =>
        a.postedAt - b.postedAt ||
        (a.batchId < b.batchId ? -1 : a.batchId > b.batchId ? 1 : 0) ||
        a.seq - b.seq
    );

    let cash = 0;
    let owed = 0;
    let worst = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const signed = line.side === "debit" ? line.amountMinor : -line.amountMinor;
      if (line.accountCode === "1010") cash += signed;
      if (line.accountCode === "2010") owed -= signed;
      worst = Math.min(worst, cash - owed);
      if (cash < owed) {
        throw new Error(
          `client money breach at ${new Date(line.postedAt).toISOString()}: ${cash} < ${owed}`
        );
      }
    }
    expect(worst).toBeGreaterThanOrEqual(0);
  });

  it("never pays a claim more than the float that funded it", async () => {
    const txns = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));
    const funded = new Map<string, number>();
    const paid = new Map<string, number>();
    for (const t of txns) {
      const bucket = t.type === "CLAIM-FUND" ? funded : t.type === "CLAIM-PAY" ? paid : null;
      if (!bucket) continue;
      const ref = t.correlationId ?? t.id;
      bucket.set(ref, (bucket.get(ref) ?? 0) + t.grossMinor);
    }
    expect(paid.size).toBeGreaterThan(0);
    expect([...paid].filter(([ref, amount]) => amount > (funded.get(ref) ?? 0))).toEqual([]);
  });

  it("gives every module a year of history", async () => {
    for (const [name, table, clock] of TIMED) {
      const [row] = await db
        .select({ n: sql<number>`count(*)`, lo: sql<number>`min(${clock})`, hi: sql<number>`max(${clock})` })
        .from(table)
        .where(eq(table.tenantId, TENANT));
      expect(row!.n, `${name} has no rows`).toBeGreaterThan(0);
      const span = (row!.hi - row!.lo) / DAY;
      expect(span, `${name} spans only ${Math.round(span)} days`).toBeGreaterThan(300);
    }
    for (const [name, table] of UNTIMED) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(table)
        .where(eq(table.tenantId, TENANT));
      expect(row!.n, `${name} has no rows`).toBeGreaterThan(0);
    }
  });

  it("sizes each cluster by the signals that actually point at it", async () => {
    // `size` is the cell the k-anonymity floor measures (scout-whitespace.ts
    // `cellSize`). Seeded at 0 it suppressed every whitespace hanging off the
    // cluster, so the radar said "too few signals" about a year of them.
    const clusters = await db
      .select({ id: schema.scoutClusters.id, size: schema.scoutClusters.size })
      .from(schema.scoutClusters)
      .where(eq(schema.scoutClusters.tenantId, TENANT));
    expect(clusters.length).toBeGreaterThan(0);

    for (const cluster of clusters) {
      const [row] = await db
        .select({ n: sql<number>`count(*)` })
        .from(schema.scoutSignals)
        .where(and(eq(schema.scoutSignals.tenantId, TENANT), eq(schema.scoutSignals.clusterId, cluster.id)));
      expect(cluster.size, `cluster ${cluster.id}`).toBe(row!.n);
      expect(cluster.size, `cluster ${cluster.id} is below the k-anonymity floor`).toBeGreaterThanOrEqual(20);
    }
  });

  it("writes a lifecycle, not one state — policies and claims across their real machines", async () => {
    const policyStates = (
      await db
        .select({ state: schema.axisPolicies.status })
        .from(schema.axisPolicies)
        .where(eq(schema.axisPolicies.tenantId, TENANT))
        .groupBy(schema.axisPolicies.status)
    )
      .map((r) => r.state)
      .sort();
    expect(policyStates).toEqual(["active", "expired", "lapsed", "renewed"]);

    const claimStates = (
      await db
        .select({ state: schema.axisClaims.status })
        .from(schema.axisClaims)
        .where(eq(schema.axisClaims.tenantId, TENANT))
        .groupBy(schema.axisClaims.status)
    ).map((r) => r.state);
    expect(claimStates).toContain("closed");
    expect(claimStates.length).toBeGreaterThan(2);
  });

  it("points every contract at the transaction that paid for it", async () => {
    // `history.ts` posts PREM-COLLECT/CMSN-ACCR in a pass of its own, so its
    // ids are in the ledger but not in this pass's map. Looked up there they
    // read null, and every money link on a policy, its version and its
    // commission entry was silently empty.
    const keyed = new Map(
      (
        await db
          .select({ id: schema.ledgerTxns.id, key: schema.ledgerTxns.idempotencyKey })
          .from(schema.ledgerTxns)
          .where(eq(schema.ledgerTxns.tenantId, TENANT))
      ).map((r) => [r.id, r.key])
    );

    const policies = await db
      .select({
        policyNo: schema.axisPolicies.policyNo,
        txnId: schema.axisPolicies.lastTxnId
      })
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.tenantId, TENANT));
    expect(policies.filter((p) => p.txnId === null)).toEqual([]);
    // `HIST-<day>-<sale>` and `history:prem-collect:<day>:<sale>` name one event.
    for (const p of policies) {
      const ref = p.policyNo.slice("HIST-".length).replace(/-(\d+)$/, ":$1");
      expect(keyed.get(p.txnId!), p.policyNo).toBe(`history:prem-collect:${ref}`);
    }

    const versions = await db
      .select({ txnId: schema.axisPolicyVersions.txnId })
      .from(schema.axisPolicyVersions)
      .where(eq(schema.axisPolicyVersions.tenantId, TENANT));
    expect(versions.filter((v) => v.txnId === null)).toEqual([]);

    const entries = await db
      .select({ txnId: schema.distCommissionEntries.txnId })
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.tenantId, TENANT));
    expect(entries.filter((e) => e.txnId === null)).toEqual([]);
    for (const e of entries) {
      expect(keyed.get(e.txnId!)?.startsWith("history:cmsn-accr:")).toBe(true);
    }
  });

  it("spreads the year over a book of customers rather than one", async () => {
    const known = new Set(
      (
        await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.tenantId, TENANT))
      ).map((r) => r.id)
    );
    expect(known.size).toBeGreaterThanOrEqual(120);

    const owners = await db
      .select({ customerId: schema.axisPolicies.customerId, n: sql<number>`count(*)` })
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.tenantId, TENANT))
      .groupBy(schema.axisPolicies.customerId);
    // Every contract hangs off a customer that exists, and no one customer owns
    // the book: a year of contracts over the population is a handful each.
    expect(owners.filter((o) => o.customerId === null || !known.has(o.customerId))).toEqual([]);
    expect(owners.length).toBeGreaterThanOrEqual(100);
    expect(Math.max(...owners.map((o) => o.n))).toBeLessThan(40);
  });

  it("gives SIGNAL and SCOUT a real targeting pool on the Gulf pack's axes", async () => {
    // The seam was built and left with nothing to work on: every seeded customer
    // carried `tagsJson: null`, so `countAttributes` returned nothing,
    // `targetablePool` returned nothing, and `suggestTargeting` threw
    // "no customer attributes survive a k-anonymity floor of 20".
    const PACK = "insurance-gulf";
    const rows = await db
      .select({ type: schema.customers.type, tags: schema.customers.tagsJson })
      .from(schema.customers)
      .where(eq(schema.customers.tenantId, TENANT));
    const tagSets = rows.map((r) => JSON.parse(r.tags ?? "[]") as string[]);
    expect(tagSets.filter((t) => t.length === 0)).toEqual([]);

    const axes = new Set(tagSets.flatMap((t) => t.map((tag) => parseAttributeTag(tag)?.axis)));
    // Only this pack's axes, spelled as the pack spells them. `lsm` here would
    // mean the ZA scale leaked into a UAE book.
    expect([...axes].sort()).toEqual([...targetingPack(PACK).axes].sort());
    for (const axis of PROTECTED_AXES) expect(axes.has(axis), `tagged ${axis}`).toBe(false);

    const counts = countAttributes(tagSets, PACK);
    const pool = targetablePool(counts, DEFAULT_K_FLOOR, PACK);
    // Every axis the pack offers survives the floor somewhere, or a UI that
    // offers it has an empty dropdown.
    for (const axis of targetingPack(PACK).axes)
      expect(pool.map((c) => c.axis), `no cell on ${axis}`).toContain(axis);
    for (const cell of pool) expect(cell.count).toBeGreaterThanOrEqual(DEFAULT_K_FLOOR);
    expect(pool.filter((c) => c.axis === "incomequintile")).toHaveLength(5);

    // The floor has to bind on something, or it is untested in the demo. The
    // northern emirates and the youngest band are tagged and suppressed.
    const shown = new Set(pool.map((c) => `${c.axis}:${c.value}`));
    const all = new Set(counts.map((c) => `${c.axis}:${c.value}`));
    for (const thin of ["region:umm-al-quwain", "region:fujairah", "ageband:18-24"]) {
      expect(all.has(thin), `${thin} not tagged at all`).toBe(true);
      expect(shown.has(thin), `${thin} leaked past the floor`).toBe(false);
    }

    // A company has no age band, life stage or household income quintile.
    const personal = ["ageband", "incomequintile", "lifestage"];
    for (const [i, row] of rows.entries())
      if (row.type === "business")
        expect(tagSets[i]!.filter((t) => personal.includes(parseAttributeTag(t)?.axis ?? ""))).toEqual([]);

    // The gap SCOUT is meant to find: Sharjah is above the floor and has nobody
    // in the top two income quintiles. Assert the joint, since the pool a model
    // sees is marginal and cannot show it.
    const sharjah = tagSets.filter((t) => t.includes("region:sharjah"));
    expect(sharjah.length).toBeGreaterThanOrEqual(DEFAULT_K_FLOOR);
    expect(sharjah.filter((t) => t.includes("incomequintile:4") || t.includes("incomequintile:5"))).toEqual([]);
  });

  it("leaves real work in the AXIS queues, not a year of closed cases", async () => {
    const rows = await db
      .select({ status: schema.axisCases.status, closed: schema.axisCases.closedAt, n: sql<number>`count(*)` })
      .from(schema.axisCases)
      .where(eq(schema.axisCases.tenantId, TENANT))
      .groupBy(schema.axisCases.status, sql`closed_at is null`);

    const states = new Set(rows.map((r) => r.status));
    for (const state of CASE_STATES) expect([...states], `no case is ever ${state}`).toContain(state);

    // The board (apps/web/app/routes/axis-board.tsx `LANES`), the quote desk
    // (`OPEN_CASE_STATUSES`) and the exception queue (`STUCK_CASE_STATUSES`)
    // each read a status filter. Every lane a human works needs cards in it.
    const openBy = new Map<string, number>();
    for (const r of rows) if (r.closed === null) openBy.set(r.status, (openBy.get(r.status) ?? 0) + r.n);
    for (const lane of ["intake", "quoting", "awaiting_docs", "review", "approval", "failed"]) {
      expect(openBy.get(lane) ?? 0, `queue ${lane} is empty`).toBeGreaterThan(0);
    }
    // A case that bound a contract is issued and closed — the bulk of the year.
    expect(openBy.get("issued") ?? 0).toBe(0);
  });

  it("leaves the audit chain verifiable after back-dating a year into it", async () => {
    const rows = await chainFor({ db, tenantId: TENANT } as never, 0, 100_000);
    expect(rows.length).toBeGreaterThan(50);
    expect(await verifyChain(rows)).toEqual([]);
  });

  it("is a no-op on a second run", async () => {
    const before = await censusOf(db);
    const again = await seedModuleHistory(db, TENANT, { days: DAYS, now: NOW });
    const after = await censusOf(db);

    expect(after).toEqual(before);
    expect(again.txns).toBe(0);
    expect(Object.entries(again.rows).filter(([, n]) => n !== 0)).toEqual([]);
  }, 600_000);

  it("stays inside one tenant", async () => {
    for (const [name, table] of [...TIMED.map((t) => [t[0], t[1]] as const), ...UNTIMED]) {
      const rows = await db.select({ t: table.tenantId }).from(table).groupBy(table.tenantId);
      expect(
        rows.map((r) => r.t),
        name
      ).toEqual([TENANT]);
    }
  });

  it("reports what it wrote, so a seed run is auditable", () => {
    expect(result.txns).toBeGreaterThan(0);
    expect(result.rows["axis_policies"]).toBe(DAYS * 2);
  });

  // The two passes together are the backfill a deployed tenant gets, so NORTH
  // must read the book they wrote: the ledger pass measured before any contract
  // existed, and the module pass measures again over the same window.
  it("leaves NORTH's row-backed snapshots equal to the rows the two passes wrote", async () => {
    const [snaps, policies, lines] = await Promise.all([
      db.select().from(schema.northSnapshots).where(eq(schema.northSnapshots.tenantId, TENANT)),
      db.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.tenantId, TENANT)),
      db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.tenantId, TENANT))
    ]);
    const headline = (metricKey: string) => snaps.filter((s) => s.metricKey === metricKey && s.dimsHash === "");
    const windowOf = (s: { grain: string; period: string; ts: number }) => {
      const since = Date.parse(s.grain === "day" ? `${s.period}T00:00:00Z` : `${s.period}-01T00:00:00Z`);
      const d = new Date(since);
      const end = s.grain === "day" ? since + DAY : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      return { since, until: Math.min(end, s.ts) };
    };
    const sold = (w: { since: number; until: number }) => policies.filter((p) => p.createdAt >= w.since && p.createdAt < w.until);

    const days = headline("policies_issued");
    expect(days).toHaveLength(DAYS);
    // [period, snapshot, rows] for every day the two disagree on.
    const disagree = days.filter((s) => s.value !== sold(windowOf(s)).length).map((s) => [s.period, s.value, sold(windowOf(s)).length]);
    expect(disagree).toEqual([]);
    // Two contracts a trading day, every day: what the ledger pass's own
    // measurement (no contracts yet) wrote as zero has been rewritten.
    expect(new Set(days.map((s) => s.value))).toEqual(new Set([2]));

    const months = headline("gwp");
    expect(months.length).toBe(13);
    for (const s of months) {
      const w = windowOf(s);
      expect([s.period, s.value]).toEqual([s.period, sold(w).reduce((n, p) => n + p.premiumMinor, 0)]);
      const commission = headline("net_commission").find((c) => c.period === s.period)!;
      const ledger = lines
        .filter((l) => l.accountCode.startsWith("40") && l.postedAt >= w.since && l.postedAt < w.until)
        .reduce((n, l) => n + (l.side === "credit" ? l.amountMinor : -l.amountMinor), 0);
      expect([s.period, commission.value]).toEqual([s.period, ledger]);
    }
  });
});

/** Row counts for every table the backfill can touch, keyed by table name. */
async function censusOf(target: CoreDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const tables = [
    ...TIMED.map((t) => [t[0], t[1]] as const),
    ...UNTIMED,
    ["ledger_txns", schema.ledgerTxns] as const,
    ["ledger_journal_lines", schema.ledgerJournalLines] as const,
    ["ledger_journal_batches", schema.ledgerJournalBatches] as const,
    ["ledger_txn_transitions", schema.ledgerTxnTransitions] as const,
    ["ledger_periods", schema.ledgerPeriods] as const,
    ["core_customers", schema.customers] as const
  ];
  for (const [name, table] of tables) {
    const [row] = await target.select({ n: sql<number>`count(*)` }).from(table);
    out[name] = row!.n;
  }
  return out;
}

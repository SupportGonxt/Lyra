import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, or } from "drizzle-orm";
import { schema } from "@lyra/db";
import { seed } from "../seed.js";
import { seedSettlement } from "./settlement.js";
import { dayIntoMonth } from "./period.js";
import { DAY, HOUR, type SeedContext } from "./context.js";
import type { CoreDb } from "../context.js";

// Same DB harness as ../seed.test.ts and ./axis.test.ts: an in-memory libSQL db
// with the real migrations replayed, one extra ".." because this file sits one
// directory deeper (packages/core/src/seed/ rather than packages/core/src/).
const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// The seed clock the whole GONXT tenant is built on (packages/core/src/seed.ts
// T0), pinned here too so every `monthStart`/`now - N * HOUR` in settlement.ts
// resolves to an exact, assertable number instead of a moving target.
const T0 = Date.UTC(2026, 0, 6, 8, 0, 0);

const MONTH_MINUS_2 = Date.UTC(2025, 10, 1); // Nov 1 2025 — the settlement seed's "monthBefore"
const MONTH_MINUS_1 = Date.UTC(2025, 11, 1); // Dec 1 2025 — when the closed month is posted

const THIS_MONTH = "2026-01";
const MONTH_BEFORE = "2025-11";

const ACCRUAL_AT = MONTH_MINUS_1 + 2 * DAY;
const PAYOUT_AT = MONTH_MINUS_1 + 11 * DAY;

// Four earnings, summed (never typed in) into the four settlement totals below.
// splitCommission({ premiumMinor, baseCommissionPpm, channelSharePpm }):
// grossMinor = applyPpm(premiumMinor, baseCommissionPpm) = floor((premiumMinor*baseCommissionPpm + 500_000) / 1_000_000)
// channelMinor = applyPpm(grossMinor, channelSharePpm)

// paid bucket (Alpha Brokers, monthBefore)
const PAID_1_AT = MONTH_MINUS_2 + 6 * DAY;
const PAID_1_GROSS = 61_800; // applyPpm(412_000, 150_000)
const PAID_1_CHANNEL = 18_540; // applyPpm(61_800, 300_000)
const PAID_2_AT = MONTH_MINUS_2 + 17 * DAY;
const PAID_2_GROSS = 34_560; // applyPpm(288_000, 120_000)
const PAID_2_CHANNEL = 10_368; // applyPpm(34_560, 300_000)
const PAID_TOTAL = PAID_1_CHANNEL + PAID_2_CHANNEL; // 28_908

// approved bucket (bank embed, monthBefore)
const APPROVED_AT = MONTH_MINUS_2 + 9 * DAY;
const APPROVED_GROSS = 115_200; // applyPpm(640_000, 180_000)
const APPROVED_CHANNEL = 46_080; // applyPpm(115_200, 400_000)

// draft bucket (Alpha Brokers, thisMonth)
// settlement.ts mints these via dayIn(N) = dayIntoMonth(now, 0, N), which
// clamps to T0 - DAY once the literal day hasn't happened yet relative to T0
// (day 8 and day 9, with T0 on day 6) — mirror the same clamp here rather
// than the bare `monthStart(T0,0) + N*DAY` that only agrees with it below
// the clamp.
const DRAFT_1_AT = dayIntoMonth(T0, 0, 3);
const DRAFT_1_GROSS = 187_200; // applyPpm(1_248_000, 150_000)
const DRAFT_1_CHANNEL = 65_520; // applyPpm(187_200, 350_000)
const DRAFT_2_AT = dayIntoMonth(T0, 0, 8);
const DRAFT_2_GROSS = 64_480; // applyPpm(496_000, 130_000)
const DRAFT_2_CHANNEL = 22_568; // applyPpm(64_480, 350_000)
const DRAFT_TOTAL = DRAFT_1_CHANNEL + DRAFT_2_CHANNEL; // 88_088 — above Alpha's 50_000 floor

// disputed bucket (bank embed, thisMonth)
const DISPUTED_AT = dayIntoMonth(T0, 0, 5);
const DISPUTED_GROSS = 55_680; // applyPpm(348_000, 160_000)
const DISPUTED_CHANNEL = 22_272; // applyPpm(55_680, 400_000)

let db: CoreDb;
let tenantId: string;
let controllerId: string;
let analystId: string;
let alphaId: string;
let bankId: string;
let cedarProviderId: string;

beforeEach(async () => {
  const client: Client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  const r = await seed(db, { password: "settlement-test-password-2026", now: T0 });
  tenantId = r.tenantId;
  controllerId = r.users["finance.controller"]!;
  analystId = r.users["finance.analyst"]!;
  alphaId = r.channels.brokerAlpha!;
  bankId = r.channels.bankEmbed!;
  cedarProviderId = r.providers.cedar!;
});

async function policyByNo(no: string) {
  const [row] = await db
    .select()
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, tenantId), eq(schema.axisPolicies.policyNo, no)));
  if (!row) throw new Error(`test: no policy ${no}`);
  return row;
}

async function entryByPolicyId(policyId: string) {
  const [row] = await db.select().from(schema.distCommissionEntries).where(eq(schema.distCommissionEntries.policyId, policyId));
  if (!row) throw new Error(`test: no commission entry for policy ${policyId}`);
  return row;
}

async function settlementByPeriodCounterparty(period: string, counterpartyRef: string) {
  const [row] = await db
    .select()
    .from(schema.ledgerSettlements)
    .where(
      and(
        eq(schema.ledgerSettlements.tenantId, tenantId),
        eq(schema.ledgerSettlements.period, period),
        eq(schema.ledgerSettlements.counterpartyRef, counterpartyRef)
      )
    );
  if (!row) throw new Error(`test: no settlement ${period}/${counterpartyRef}`);
  return row;
}

async function txnByIdemKey(type: string, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, tenantId), eq(schema.ledgerTxns.type, type), eq(schema.ledgerTxns.idempotencyKey, idempotencyKey)));
  if (!row) throw new Error(`test: no txn ${type}/${idempotencyKey}`);
  return row;
}

async function batchByTxnId(txnId: string) {
  const [row] = await db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.txnId, txnId));
  if (!row) throw new Error(`test: no batch for txn ${txnId}`);
  return row;
}

async function linesFor(batchId: string) {
  return db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.batchId, batchId)).orderBy(schema.ledgerJournalLines.seq);
}

async function periodByCode(code: string) {
  const [row] = await db.select().from(schema.ledgerPeriods).where(and(eq(schema.ledgerPeriods.tenantId, tenantId), eq(schema.ledgerPeriods.code, code)));
  if (!row) throw new Error(`test: no period ${code}`);
  return row;
}

/* --------------------------------------------------------- policies + entries */

describe("seedSettlement: policies and commission entries", () => {
  it("paid bucket (Alpha Brokers): two earnings, each with its own clean policy", async () => {
    const p1 = await policyByNo("CDR-MOT-2511-901447");
    expect(p1.providerId).toBe(cedarProviderId);
    expect(p1.channelId).toBe(alphaId);
    expect(p1.premiumMinor).toBe(412_000);
    expect(p1.currency).toBe("AED");
    expect(p1.status).toBe("active");
    expect(p1.commissionMinor).toBe(PAID_1_GROSS);
    expect(p1.startAt).toBe(PAID_1_AT);
    expect(p1.endAt).toBe(PAID_1_AT + 365 * DAY);
    expect(p1.createdAt).toBe(PAID_1_AT);
    expect(p1.updatedAt).toBe(PAID_1_AT);

    const e1 = await entryByPolicyId(p1.id);
    expect(e1.kind).toBe("new_business");
    expect(e1.channelId).toBe(alphaId);
    expect(e1.premiumMinor).toBe(412_000);
    expect(e1.grossCommissionMinor).toBe(PAID_1_GROSS);
    expect(e1.channelCommissionMinor).toBe(PAID_1_CHANNEL);
    expect(e1.netCommissionMinor).toBe(PAID_1_GROSS - PAID_1_CHANNEL);
    expect(e1.taxMinor).toBe(0);
    expect(e1.currency).toBe("AED");
    expect(e1.earnedOn).toBe("issue");
    expect(e1.earnedAt).toBe(PAID_1_AT);
    expect(e1.reversalOf).toBeNull();
    expect(e1.providerSettlementId).toBeNull();
    expect(e1.state).toBe("paid");
    expect(e1.createdAt).toBe(PAID_1_AT);
    expect(e1.updatedAt).toBe(PAID_1_AT + HOUR);

    const p2 = await policyByNo("FLC-MOT-2511-664902");
    expect(p2.premiumMinor).toBe(288_000);
    expect(p2.commissionMinor).toBe(PAID_2_GROSS);
    const e2 = await entryByPolicyId(p2.id);
    expect(e2.kind).toBe("renewal");
    expect(e2.grossCommissionMinor).toBe(PAID_2_GROSS);
    expect(e2.channelCommissionMinor).toBe(PAID_2_CHANNEL);
    expect(e2.netCommissionMinor).toBe(PAID_2_GROSS - PAID_2_CHANNEL);
    expect(e2.state).toBe("paid");
    expect(e2.earnedAt).toBe(PAID_2_AT);

    // Both entries carry the same stamp: the settlement they were paid under.
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    expect(stlPaid.state).toBe("paid");
    expect(e1.channelSettlementId).toBe(stlPaid.id);
    expect(e2.channelSettlementId).toBe(stlPaid.id);
    const txPayout = await txnByIdemKey("RSHARE-SETL", `rshare-setl:${stlPaid.id}`);
    expect(e1.txnId).toBe(txPayout.id);
    expect(e2.txnId).toBe(txPayout.id);
  });

  it("approved bucket (bank embed): signed off, expense accrued, cash not yet moved", async () => {
    const policy = await policyByNo("GLF-HLT-2511-330815");
    expect(policy.channelId).toBe(bankId);
    expect(policy.premiumMinor).toBe(640_000);
    expect(policy.commissionMinor).toBe(APPROVED_GROSS);
    expect(policy.startAt).toBe(APPROVED_AT);

    const entry = await entryByPolicyId(policy.id);
    expect(entry.kind).toBe("new_business");
    expect(entry.channelId).toBe(bankId);
    expect(entry.grossCommissionMinor).toBe(APPROVED_GROSS);
    expect(entry.channelCommissionMinor).toBe(APPROVED_CHANNEL);
    expect(entry.netCommissionMinor).toBe(APPROVED_GROSS - APPROVED_CHANNEL);
    expect(entry.state).toBe("payable");

    const stlApproved = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${bankId}`);
    expect(stlApproved.state).toBe("approved");
    expect(entry.channelSettlementId).toBe(stlApproved.id);
    const txBankAccrual = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${stlApproved.id}`);
    expect(entry.txnId).toBe(txBankAccrual.id);
  });

  it("draft bucket: this month, still accumulating — no stamp, no txn yet", async () => {
    const p1 = await policyByNo("CDR-MOP-2601-772350");
    expect(p1.channelId).toBe(alphaId);
    expect(p1.commissionMinor).toBe(DRAFT_1_GROSS);
    const e1 = await entryByPolicyId(p1.id);
    expect(e1.channelCommissionMinor).toBe(DRAFT_1_CHANNEL);
    expect(e1.state).toBe("accrued");
    expect(e1.earnedAt).toBe(DRAFT_1_AT);
    // Not yet signed off: no settlement stamp, no txn — this is the run's carry.
    expect(e1.channelSettlementId).toBeNull();
    expect(e1.txnId).toBeNull();

    const p2 = await policyByNo("ORX-MOT-2601-518064");
    expect(p2.commissionMinor).toBe(DRAFT_2_GROSS);
    const e2 = await entryByPolicyId(p2.id);
    expect(e2.kind).toBe("renewal");
    expect(e2.channelCommissionMinor).toBe(DRAFT_2_CHANNEL);
    expect(e2.state).toBe("accrued");
    expect(e2.earnedAt).toBe(DRAFT_2_AT);
    expect(e2.channelSettlementId).toBeNull();
    expect(e2.txnId).toBeNull();
  });

  it("disputed bucket: Meridian reads the travel commission differently — no stamp, no txn", async () => {
    const policy = await policyByNo("GNX-TRV-2601-140973");
    expect(policy.channelId).toBe(bankId);
    expect(policy.commissionMinor).toBe(DISPUTED_GROSS);
    const entry = await entryByPolicyId(policy.id);
    expect(entry.channelCommissionMinor).toBe(DISPUTED_CHANNEL);
    expect(entry.state).toBe("disputed");
    expect(entry.channelSettlementId).toBeNull();
    expect(entry.txnId).toBeNull();
    expect(entry.earnedAt).toBe(DISPUTED_AT);
  });
});

/* ----------------------------------------------------------- ledgerSettlements */

describe("seedSettlement: the four ledger_settlements rows", () => {
  // The ledger seed writes its own ledger_settlements rows for other
  // counterparties (underwriters, other periods); scope to the two channel
  // refs this seeder pays to keep the count meaningful.
  async function settlementSeedRows() {
    return db
      .select()
      .from(schema.ledgerSettlements)
      .where(
        and(
          eq(schema.ledgerSettlements.tenantId, tenantId),
          or(eq(schema.ledgerSettlements.counterpartyRef, `channel:${alphaId}`), eq(schema.ledgerSettlements.counterpartyRef, `channel:${bankId}`)),
          or(eq(schema.ledgerSettlements.period, MONTH_BEFORE), eq(schema.ledgerSettlements.period, THIS_MONTH))
        )
      );
  }

  it("writes exactly four rows, one per state", async () => {
    const rows = await settlementSeedRows();
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.state).sort()).toEqual(["approved", "disputed", "draft", "paid"]);
    for (const r of rows) {
      expect(r.currency).toBe("AED");
      expect(r.counterpartyKind).toBe("partner");
      expect(r.adjustmentsMinor).toBe(0);
      // gross === net: the seed never models a dispute adjustment.
      expect(r.grossMinor).toBe(r.netMinor);
    }
  });

  it("paid: closed month, both signatures, money out — totals summed from its two entries", async () => {
    const s = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    expect(s.grossMinor).toBe(PAID_TOTAL);
    expect(s.netMinor).toBe(PAID_TOTAL);
    expect(s.approvedBy).toBe(`user:${analystId}`);
    expect(s.createdAt).toBe(ACCRUAL_AT);
    expect(s.updatedAt).toBe(PAYOUT_AT + HOUR);
    const txPayout = await txnByIdemKey("RSHARE-SETL", `rshare-setl:${s.id}`);
    expect(s.txnId).toBe(txPayout.id);
  });

  it("approved: signed off, waiting on the second controller for cash to move", async () => {
    const s = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${bankId}`);
    expect(s.grossMinor).toBe(APPROVED_CHANNEL);
    expect(s.netMinor).toBe(APPROVED_CHANNEL);
    expect(s.approvedBy).toBe(`user:${controllerId}`);
    expect(s.createdAt).toBe(ACCRUAL_AT);
    expect(s.updatedAt).toBe(ACCRUAL_AT + HOUR);
    const txBankAccrual = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${s.id}`);
    expect(s.txnId).toBe(txBankAccrual.id);
  });

  it("draft: this month, nothing posted, re-running it is free", async () => {
    const s = await settlementByPeriodCounterparty(THIS_MONTH, `channel:${alphaId}`);
    expect(s.grossMinor).toBe(DRAFT_TOTAL);
    expect(s.netMinor).toBe(DRAFT_TOTAL);
    expect(s.approvedBy).toBeNull();
    expect(s.txnId).toBeNull();
    expect(s.createdAt).toBe(dayIntoMonth(T0, 0, 9));
    expect(s.updatedAt).toBe(T0 - 2 * HOUR);
  });

  // The floor is the agreement's, and the engine re-applies it on approval
  // (engines/settlement.ts totalsFor): a month under it pays nothing and carries
  // its whole balance forward, so a draft seeded below the floor is one no
  // controller could ever sign off — the approval refuses it as stale instead.
  it("draft: clears the minimum payout its own agreement sets, so it can be approved", async () => {
    const s = await settlementByPeriodCounterparty(THIS_MONTH, `channel:${alphaId}`);
    // The same lookup the engine does: channel -> partner -> active agreement.
    const partners = await db.select().from(schema.orbitPartners).where(eq(schema.orbitPartners.tenantId, tenantId));
    const partner = partners.find(
      (p) => (JSON.parse(p.revshareJson ?? "{}") as { channelId?: string }).channelId === alphaId
    );
    const [agreement] = await db
      .select()
      .from(schema.distPartnerAgreements)
      .where(
        and(
          eq(schema.distPartnerAgreements.tenantId, tenantId),
          eq(schema.distPartnerAgreements.partnerId, partner!.id),
          eq(schema.distPartnerAgreements.state, "active")
        )
      );
    const minPayoutMinor = (JSON.parse(agreement!.termsJson) as { settlement: { minPayoutMinor: number } }).settlement
      .minPayoutMinor;
    expect(s.netMinor).toBeGreaterThanOrEqual(minPayoutMinor);
  });

  it("disputed: this month, the argument is still open", async () => {
    const s = await settlementByPeriodCounterparty(THIS_MONTH, `channel:${bankId}`);
    expect(s.grossMinor).toBe(DISPUTED_CHANNEL);
    expect(s.netMinor).toBe(DISPUTED_CHANNEL);
    expect(s.approvedBy).toBeNull();
    expect(s.txnId).toBeNull();
    expect(s.createdAt).toBe(dayIntoMonth(T0, 0, 9));
    expect(s.updatedAt).toBe(T0 - 6 * HOUR);
  });
});

/* --------------------------------------------------------------- transactions */

describe("seedSettlement: the three ledger_txns rows", () => {
  it("txAccrual: Alpha's commission accrued and settled, controller actor", async () => {
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    const t = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${stlPaid.id}`);
    expect(t.state).toBe("settled");
    expect(t.actorKind).toBe("user");
    expect(t.actorId).toBe(controllerId);
    expect(t.currency).toBe("AED");
    expect(t.baseCurrency).toBe("AED");
    expect(t.fxRatePpm).toBe(1_000_000);
    expect(t.grossMinor).toBe(PAID_TOTAL);
    expect(t.baseGrossMinor).toBe(PAID_TOTAL);
    expect(t.createdAt).toBe(ACCRUAL_AT);
    expect(t.updatedAt).toBe(ACCRUAL_AT + HOUR);
    expect(t.settledAt).toBe(ACCRUAL_AT + HOUR);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: PAID_TOTAL, adjustments: 0, net: PAID_TOTAL });
    expect(JSON.parse(t.subjectRefsJson!)).toEqual({ settlement: stlPaid.id, channel: alphaId });
    expect(t.correlationId).toBe(`settlement:${stlPaid.id}`);
  });

  it("txPayout: the money leaving, same amount as the accrual it closes out", async () => {
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    const t = await txnByIdemKey("RSHARE-SETL", `rshare-setl:${stlPaid.id}`);
    expect(t.state).toBe("settled");
    expect(t.actorId).toBe(controllerId);
    expect(t.grossMinor).toBe(PAID_TOTAL);
    expect(t.baseGrossMinor).toBe(PAID_TOTAL);
    expect(t.createdAt).toBe(PAYOUT_AT);
    expect(t.updatedAt).toBe(PAYOUT_AT + HOUR);
    expect(t.settledAt).toBe(PAYOUT_AT + HOUR);
    expect(JSON.parse(t.amountsJson!)).toEqual({ net: PAID_TOTAL });
  });

  it("txBankAccrual: Meridian's accrual posted, analyst actor, the payable sitting on 2100", async () => {
    const stlApproved = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${bankId}`);
    const t = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${stlApproved.id}`);
    expect(t.actorId).toBe(analystId);
    expect(t.grossMinor).toBe(APPROVED_CHANNEL);
    expect(t.baseGrossMinor).toBe(APPROVED_CHANNEL);
    expect(t.createdAt).toBe(ACCRUAL_AT);
    expect(t.settledAt).toBe(ACCRUAL_AT + HOUR);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: APPROVED_CHANNEL, adjustments: 0, net: APPROVED_CHANNEL });
  });
});

/* --------------------------------------------------------- journals & balances */

describe("seedSettlement: journal batches and lines", () => {
  it("bAccrual: debits 5400, credits 2100, posted an hour after the accrual, in the closed period", async () => {
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    const t = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${stlPaid.id}`);
    const batch = await batchByTxnId(t.id);
    expect(batch.totalDebitMinor).toBe(PAID_TOTAL);
    expect(batch.totalCreditMinor).toBe(PAID_TOTAL);
    expect(batch.baseTotalDebitMinor).toBe(PAID_TOTAL);
    expect(batch.baseTotalCreditMinor).toBe(PAID_TOTAL);
    expect(batch.postedAt).toBe(ACCRUAL_AT + HOUR);
    expect(batch.postedBy).toBe(`user:${controllerId}`);
    const period = await periodByCode(MONTH_BEFORE);
    expect(batch.periodId).toBe(period.id);

    const lines = await linesFor(batch.id);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["5400", "debit", PAID_TOTAL],
      ["2100", "credit", PAID_TOTAL]
    ]);
    expect(lines[0]!.memo).toBe(`settlement ${MONTH_BEFORE} channel:${alphaId}`);
    expect(JSON.parse(lines[0]!.dimsJson!)).toEqual({ channel: alphaId, settlement: stlPaid.id, period: MONTH_BEFORE });

    // Stamped back onto the txn — the whole point of the linking column.
    const [reloaded] = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, t.id));
    expect(reloaded!.ledgerBatchId).toBe(batch.id);
  });

  it("bPayout: debits 2100 (the payable clears), credits 1000 (cash out), same total as the accrual", async () => {
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    const t = await txnByIdemKey("RSHARE-SETL", `rshare-setl:${stlPaid.id}`);
    const batch = await batchByTxnId(t.id);
    expect(batch.postedAt).toBe(PAYOUT_AT + HOUR);
    const lines = await linesFor(batch.id);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["2100", "debit", PAID_TOTAL],
      ["1000", "credit", PAID_TOTAL]
    ]);
    expect(lines[0]!.memo).toBe(`payout ${MONTH_BEFORE} channel:${alphaId}`);
  });

  it("bBankAccrual: Meridian's own accrual, posted by the analyst", async () => {
    const stlApproved = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${bankId}`);
    const t = await txnByIdemKey("RSHARE-ACCR", `rshare-accr:${stlApproved.id}`);
    const batch = await batchByTxnId(t.id);
    expect(batch.postedBy).toBe(`user:${analystId}`);
    const lines = await linesFor(batch.id);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["5400", "debit", APPROVED_CHANNEL],
      ["2100", "credit", APPROVED_CHANNEL]
    ]);
    expect(lines[0]!.memo).toBe(`settlement ${MONTH_BEFORE} channel:${bankId}`);
  });

  it("every batch this seed posts balances: debit === credit", async () => {
    const stlPaid = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${alphaId}`);
    const stlApproved = await settlementByPeriodCounterparty(MONTH_BEFORE, `channel:${bankId}`);
    const txnIds = [stlPaid.txnId, stlApproved.txnId].filter((id): id is string => id !== null);
    expect(txnIds).toHaveLength(2); // only paid + approved have posted a txn
    for (const txnId of txnIds) {
      const batch = await batchByTxnId(txnId);
      expect(batch.totalDebitMinor).toBe(batch.totalCreditMinor);
      expect(batch.baseTotalDebitMinor).toBe(batch.baseTotalCreditMinor);
    }
  });
});

describe("seedSettlement: account balances add to what the ledger seed already posted", () => {
  it.each(["1000", "2100", "5400"])(
    "%s:AED — the cached balance is exactly the sum of every journal line ever posted to it",
    async (accountCode) => {
      const lines = await db
        .select()
        .from(schema.ledgerJournalLines)
        .where(and(eq(schema.ledgerJournalLines.tenantId, tenantId), eq(schema.ledgerJournalLines.accountCode, accountCode)));
      const debit = lines.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
      const credit = lines.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);

      const [balance] = await db
        .select()
        .from(schema.ledgerAccountBalances)
        .where(
          and(
            eq(schema.ledgerAccountBalances.tenantId, tenantId),
            eq(schema.ledgerAccountBalances.accountCode, accountCode),
            eq(schema.ledgerAccountBalances.currency, "AED")
          )
        );
      expect(balance).toBeDefined();
      expect(balance!.debitMinor).toBe(debit);
      expect(balance!.creditMinor).toBe(credit);
      expect(balance!.baseDebitMinor).toBe(debit);
      expect(balance!.baseCreditMinor).toBe(credit);
    }
  );

  it("5400 is new to this seeder: its whole balance is the two accrual batches, nothing carried from the ledger seed", async () => {
    const [balance] = await db
      .select()
      .from(schema.ledgerAccountBalances)
      .where(
        and(
          eq(schema.ledgerAccountBalances.tenantId, tenantId),
          eq(schema.ledgerAccountBalances.accountCode, "5400"),
          eq(schema.ledgerAccountBalances.currency, "AED")
        )
      );
    expect(balance!.debitMinor).toBe(PAID_TOTAL + APPROVED_CHANNEL);
    expect(balance!.creditMinor).toBe(0);
  });
});

/* ---------------------------------------------------- ctx fallbacks & guardrails */

function makeFallbackCtx(overrides: Partial<SeedContext>): SeedContext {
  return {
    db,
    now: T0,
    tenantId: "t_fallback",
    users: {},
    teams: { motor: "team_motor", health: "team_health", retention: "team_retention" },
    providers: { gonxt: "prov_gonxt", falcon: "prov_falcon", cedar: "prov_cedar", oryx: "prov_oryx", gulfHealth: "prov_gulfhealth", meridian: "prov_meridian" },
    products: { motor: "prod_motor", health: "prod_health", travel: "prod_travel", home: "prod_home", life: "prod_life" },
    offerings: {
      gonxtMotor: "off_gonxt_motor",
      falconMotor: "off_falcon_motor",
      cedarMotor: "off_cedar_motor",
      oryxMotor: "off_oryx_motor",
      cedarMotorPlus: "off_cedar_motor_plus",
      gulfHealth: "off_gulf_health",
      gonxtTravel: "off_gonxt_travel",
      cedarHome: "off_cedar_home",
      oryxLife: "off_oryx_life"
    },
    channels: { web: "chan_web", app: "chan_app", callCentre: "chan_callcentre", brokerAlpha: "chan_brokeralpha", bankEmbed: "chan_bankembed" },
    customerId: "cust_fallback",
    consentId: "consent_fallback",
    quoteRequestId: "qr_fallback",
    caseId: "case_fallback",
    policyId: "pol_fallback",
    renewalPolicyId: "pol_fallback_renewal",
    issuedAt: T0,
    ...overrides
  };
}

describe("seedSettlement: ctx fallbacks and guardrails", () => {
  it("falls back to the literal 'seed' user when finance role users are missing from ctx.users", async () => {
    const client: Client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    const freshDb = drizzle(client) as unknown as CoreDb;
    await freshDb.insert(schema.ledgerPeriods).values({
      id: "per_fallback",
      tenantId: "t_fallback",
      code: MONTH_BEFORE,
      startAt: MONTH_MINUS_2,
      endAt: MONTH_MINUS_1 - 1,
      state: "hard_closed"
    });

    await seedSettlement(makeFallbackCtx({ db: freshDb }));

    const s = await freshDb
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, "t_fallback"), eq(schema.ledgerSettlements.state, "approved")));
    expect(s[0]!.approvedBy).toBe("user:seed");

    const paid = await freshDb
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, "t_fallback"), eq(schema.ledgerSettlements.state, "paid")));
    expect(paid[0]!.approvedBy).toBe("user:seed");

    const txns = await freshDb.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, "t_fallback"));
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) expect(t.actorId).toBe("seed");
  });

  it("throws a specific error when the ledger seed has not run (no period for the closed month)", async () => {
    const client: Client = createClient({ url: ":memory:" });
    for (const sql of statements()) await client.execute(sql);
    const freshDb = drizzle(client) as unknown as CoreDb;
    await expect(seedSettlement(makeFallbackCtx({ db: freshDb, tenantId: "t_no_period" }))).rejects.toThrow(
      /seed: no ledger period 2025-11; the ledger seed has to run first/
    );
  });
});


import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, id, schema } from "@lyra/db";
import { decide, hashObject, type Ctx } from "@lyra/core";
import { trialBalance } from "@lyra/ledger";
import {
  approveSettlement,
  disputeSettlement,
  getSettlement,
  paySettlement,
  reopenSettlement,
  runSettlement,
  settlementStatement,
  statementTable,
  totalsFor
} from "./engines/settlement.js";

// docs/19 §5 and §7. The money-out half of commission: what the channel earned,
// what clears the floor, who signs it off, and who releases the cash. These run
// against a real migrated SQLite engine because the parts that matter — the
// unique index that makes a re-run idempotent, the balance assertion inside
// `post` — are enforced by the database, not by this file.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;
const THIS_MONTH = "2026-06";
const LAST_MONTH = "2026-05";
const CHANNEL = "chn_alpha";
const REF = `channel:${CHANNEL}`;
/** A confirmed bank transfer — the proof `pay` now requires. */
const PAYMENT = { externalRef: "TRF-2026-0615-001", paidVia: "bank_transfer" as const };

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let ctx: Ctx;
/** A second person, for the dual control every settlement approval demands. */
let other: Ctx;

function ctxFor(db: Ctx["db"], tenantId: string, userId: string): Ctx {
  return {
    db,
    tenantId,
    // `*:*:*`, not `*`: the matcher compares segment by segment, so a bare
    // star grants nothing.
    actor: { kind: "user", id: userId, tenantId, grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: `req_${userId}`,
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  ctx = ctxFor(db, "t_test", "u_runner");
  other = ctxFor(db, "t_test", "u_approver");
});

/** AppError puts the specific cause in `detail`; the message is only the title. */
async function rejects(p: Promise<unknown>, detail: RegExp): Promise<void> {
  await expect(p).rejects.toThrow();
  try {
    await p;
  } catch (e) {
    expect((e as { detail?: string }).detail ?? String(e)).toMatch(detail);
  }
}

/* -------------------------------------------------------------- fixtures */

let seq = 0;

/** A partner whose revenue-share config is where the payout floor lives. */
async function partner(c: Ctx, minPayoutMinor: number, channelId = CHANNEL): Promise<string> {
  const partnerId = id("prt", NOW + seq++);
  await c.db.insert(schema.orbitPartners).values({
    id: partnerId,
    tenantId: c.tenantId,
    name: "Alpha Brokers",
    kind: "broker",
    revshareJson: JSON.stringify({ channelId, settlement: { minPayoutMinor } }),
    createdAt: NOW,
    updatedAt: NOW
  });
  return partnerId;
}

/** One earned commission line. `channelMinor` is the only number that settles. */
async function entry(
  c: Ctx,
  channelMinor: number,
  earnedAt: number,
  extra: Partial<typeof schema.distCommissionEntries.$inferInsert> = {}
): Promise<string> {
  const entryId = id("ce", NOW + seq++);
  await c.db.insert(schema.distCommissionEntries).values({
    id: entryId,
    tenantId: c.tenantId,
    // One policy per entry: dist_commission_entries_accrual_uq allows a single
    // accrual per (policy, kind).
    policyId: `pol_${entryId}`,
    providerId: "prv_1",
    channelId: CHANNEL,
    kind: "new_business",
    premiumMinor: channelMinor * 10,
    grossCommissionMinor: channelMinor * 2,
    channelCommissionMinor: channelMinor,
    netCommissionMinor: channelMinor,
    currency: "AED",
    earnedAt,
    state: "accrued",
    createdAt: earnedAt,
    updatedAt: earnedAt,
    ...extra
  });
  return entryId;
}

const run = (c: Ctx, period = THIS_MONTH) =>
  runSettlement(c, { counterpartyKind: "partner", counterpartyRef: REF, period });

/**
 * Take the outstanding approval as the *other* person. Gate throws on the first
 * call and creates the pending row; deciding it lets the second call through.
 */
async function signOff(policyKey: string, settlementId: string): Promise<void> {
  const [row] = await ctx.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.tenantId, ctx.tenantId),
        eq(schema.approvals.subjectRef, `settlement:${settlementId}`),
        eq(schema.approvals.policyKey, policyKey)
      )
    )
    .limit(1);
  if (!row) throw new Error(`no pending ${policyKey} approval for ${settlementId}`);
  await decide(other, row.id, "approved", "test");
}

/** Approve then pay, taking both signatures. The full happy path. */
async function settleFully(settlementId: string): Promise<void> {
  await rejects(approveSettlement(ctx, settlementId), /dist\.settlement_run/);
  await signOff("dist.settlement_run", settlementId);
  await approveSettlement(ctx, settlementId);

  await rejects(paySettlement(ctx, settlementId, PAYMENT), /ledger\.partner_settlement/);
  await signOff("ledger.partner_settlement", settlementId);
  await paySettlement(ctx, settlementId, PAYMENT);
}

async function hardClose(period: string): Promise<void> {
  await ctx.db.insert(schema.ledgerPeriods).values({
    id: id("per", NOW + seq++),
    tenantId: ctx.tenantId,
    code: period,
    startAt: Date.UTC(2026, 4, 1),
    endAt: Date.UTC(2026, 5, 1) - 1,
    state: "hard_closed"
  });
}

/* ------------------------------------------------------------ aggregation */

describe("aggregation", () => {
  it("sums the channel share of every unsettled entry in the period", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, 12_500, NOW - DAY);

    const { settlement, totals, entryCount } = await run(ctx);

    expect(entryCount).toBe(2);
    expect(totals).toMatchObject({ grossMinor: 42_500, adjustmentsMinor: 0, netMinor: 42_500 });
    expect(settlement).toMatchObject({ state: "draft", grossMinor: 42_500, netMinor: 42_500, currency: "AED" });
  });

  it("adds clawbacks as they are stored: negative entries, not special cases", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, -8_000, NOW - DAY, { kind: "clawback", grossCommissionMinor: -16_000, netCommissionMinor: -8_000 });

    const { totals } = await run(ctx);
    expect(totals.netMinor).toBe(22_000);
  });

  it("leaves out entries a previous settlement already claimed", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, 5_000, NOW - DAY, { channelSettlementId: "stl_other", state: "paid" });

    const { totals, entryCount } = await run(ctx);
    expect(entryCount).toBe(1);
    expect(totals.netMinor).toBe(30_000);
  });

  it("ignores entries written off — a decision, not a debt", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, 9_000, NOW - DAY, { state: "written_off" });

    const { totals } = await run(ctx);
    expect(totals.netMinor).toBe(30_000);
  });

  it("stops at the end of the period: next month's earnings are not this month's", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, 77_000, Date.UTC(2026, 6, 3));

    const { totals } = await run(ctx);
    expect(totals.netMinor).toBe(30_000);
  });

  it("refuses a period that is not YYYY-MM", async () => {
    await rejects(run(ctx, "2026-6"), /period must be YYYY-MM/);
    await rejects(run(ctx, "2026-13"), /period must be YYYY-MM/);
  });

  it("refuses money-in counterparties, which settle through a different recipe", async () => {
    await rejects(
      runSettlement(ctx, { counterpartyKind: "insurer", counterpartyRef: "provider:prv_1", period: THIS_MONTH }),
      /money in, not out/
    );
  });
});

/* ------------------------------------------------------------ idempotency */

describe("re-running a period", () => {
  it("does not double count", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);

    const first = await run(ctx);
    const second = await run(ctx);

    expect(second.settlement.id).toBe(first.settlement.id);
    expect(second.totals.netMinor).toBe(30_000);

    const rows = await ctx.db.select().from(schema.ledgerSettlements);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.netMinor).toBe(30_000);
  });

  it("picks up entries booked since the last run", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await run(ctx);
    await entry(ctx, 4_000, NOW - DAY);

    const { totals } = await run(ctx);
    expect(totals.netMinor).toBe(34_000);
  });

  it("will not restate a settlement that has already been approved", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    await approveSettlement(ctx, settlement.id);

    await entry(ctx, 100_000, NOW - DAY);
    const again = await run(ctx);
    expect(again.settlement.state).toBe("approved");
    expect(again.settlement.netMinor).toBe(30_000);
  });

  it("refuses to approve a draft whose entries changed since the run", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    // Booked between draft and approve: the draft's posted total would not
    // cover it, yet the old code stamped it payable anyway.
    await entry(ctx, 5_000, NOW - DAY);

    await rejects(approveSettlement(ctx, settlement.id), /re-run/);

    // Nothing posted, nothing stamped while the numbers disagreed.
    expect(await ctx.db.select().from(schema.ledgerJournalLines)).toHaveLength(0);
    const entries = await ctx.db.select().from(schema.distCommissionEntries);
    expect(entries.every((e) => e.channelSettlementId === null && e.state === "accrued")).toBe(true);

    // Re-draft picks the new entry up, and approve then pays the right total.
    const again = await run(ctx);
    expect(again.settlement.netMinor).toBe(35_000);
    await rejects(approveSettlement(ctx, again.settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", again.settlement.id);
    const after = await approveSettlement(ctx, again.settlement.id);
    expect(after.netMinor).toBe(35_000);

    const stamped = await ctx.db.select().from(schema.distCommissionEntries);
    expect(stamped.every((e) => e.channelSettlementId === settlement.id && e.state === "payable")).toBe(true);
  });

  it("a repeated payout posts once and pays once", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await settleFully(settlement.id);

    // The retry a flaky network produces. Same idempotency key, same txn.
    const paid = await getSettlement(ctx, settlement.id);
    await rejects(paySettlement(ctx, settlement.id, PAYMENT), /only an approved settlement can be paid/);

    const batches = await ctx.db.select().from(schema.ledgerJournalBatches);
    expect(batches).toHaveLength(2); // one accrual, one payout — not three
    const lines = await ctx.db
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.txnId, paid.txnId ?? ""));
    expect(lines).toHaveLength(2);
  });
});

/* ----------------------------------------------------------------- carry */

describe("the payout floor", () => {
  it("carries the balance forward instead of paying below the minimum", async () => {
    await partner(ctx, 50_000);
    await entry(ctx, 30_000, NOW - 2 * DAY);

    const { settlement, totals } = await run(ctx);

    expect(totals.grossMinor).toBe(30_000);
    expect(totals.carriedForwardMinor).toBe(30_000);
    expect(totals.netMinor).toBe(0);
    // The statement still has to add up: gross + adjustments === net.
    expect(totals.grossMinor + totals.adjustmentsMinor).toBe(totals.netMinor);
    expect(settlement.netMinor).toBe(0);
  });

  it("refuses to approve a carried period — there is nothing to pay", async () => {
    await partner(ctx, 50_000);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    await rejects(approveSettlement(ctx, settlement.id), /nothing to pay/);
  });

  it("sweeps the carry into the next period that clears the floor", async () => {
    await partner(ctx, 50_000);
    await entry(ctx, 30_000, Date.UTC(2026, 4, 20)); // May: under the floor
    const may = await run(ctx, LAST_MONTH);
    expect(may.totals.netMinor).toBe(0);

    await entry(ctx, 25_000, NOW - DAY); // June: on its own, also under
    const june = await run(ctx, THIS_MONTH);

    expect(june.totals.grossMinor).toBe(25_000);
    expect(june.totals.carryInMinor).toBe(30_000);
    expect(june.totals.netMinor).toBe(55_000);
    expect(june.totals.carriedForwardMinor).toBe(0);
    expect(june.entryCount).toBe(2);
  });

  it("carries a month the clawbacks pushed negative", async () => {
    const totals = totalsFor(
      [
        { channelCommissionMinor: 10_000, earnedAt: NOW, createdAt: NOW },
        { channelCommissionMinor: -14_000, earnedAt: NOW, createdAt: NOW }
      ] as never,
      THIS_MONTH,
      0
    );
    expect(totals.netMinor).toBe(0);
    expect(totals.carriedForwardMinor).toBe(-4_000);
    expect(totals.grossMinor + totals.adjustmentsMinor).toBe(totals.netMinor);
  });
});

/* ------------------------------------------------------------- approvals */

describe("approvals", () => {
  it("refuses to approve without the settlement approval", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    expect((await getSettlement(ctx, settlement.id)).state).toBe("draft");
    // Nothing posted while the question was open.
    expect(await ctx.db.select().from(schema.ledgerJournalLines)).toHaveLength(0);
  });

  it("refuses to pay without the payout approval, even once approved", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    await approveSettlement(ctx, settlement.id);

    // The approve signature is still inside its 24h window and must not be
    // spent twice: releasing cash is its own decision.
    await rejects(paySettlement(ctx, settlement.id, PAYMENT), /ledger\.partner_settlement/);
    expect((await getSettlement(ctx, settlement.id)).state).toBe("approved");
  });

  it("holds dual control: the person who ran the period cannot sign it off", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);

    const [row] = await ctx.db.select().from(schema.approvals);
    await rejects(decide(ctx, row?.id ?? "", "approved"), /approver must differ from the initiator/);
  });

  it("records who approved and which transaction accrued it", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    const after = await approveSettlement(ctx, settlement.id);

    expect(after.state).toBe("approved");
    expect(after.approvedBy).toBe("user:u_runner");
    expect(after.txnId).toBeTruthy();

    const entries = await ctx.db.select().from(schema.distCommissionEntries);
    expect(entries.every((e) => e.channelSettlementId === settlement.id && e.state === "payable")).toBe(true);
  });
});

/* --------------------------------------------------------- payout evidence */

// No PSP connector exists (docs/25 §7 — credential-gated, out of scope), so
// the v1 payout control is a human-confirmed bank/PSP reference: proof money
// actually left the building, not just an internal journal entry.
describe("the payout reference", () => {
  async function approvedSettlement(): Promise<string> {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    await approveSettlement(ctx, settlement.id);
    await rejects(paySettlement(ctx, settlement.id, PAYMENT), /ledger\.partner_settlement/);
    await signOff("ledger.partner_settlement", settlement.id);
    return settlement.id;
  }

  it("refuses to pay without an external reference", async () => {
    const settlementId = await approvedSettlement();
    await rejects(
      paySettlement(ctx, settlementId, { externalRef: "", paidVia: "bank_transfer" }),
      /externalRef is required/
    );
    await rejects(
      paySettlement(ctx, settlementId, { externalRef: "   ", paidVia: "bank_transfer" }),
      /externalRef is required/
    );
    expect((await getSettlement(ctx, settlementId)).state).toBe("approved");
  });

  it("refuses an unrecognised paidVia", async () => {
    const settlementId = await approvedSettlement();
    await rejects(
      paySettlement(ctx, settlementId, { externalRef: "TRF-1", paidVia: "cash" as never }),
      /paidVia must be one of/
    );
    expect((await getSettlement(ctx, settlementId)).state).toBe("approved");
  });

  it("persists the reference and hashes it into the audit trail", async () => {
    const settlementId = await approvedSettlement();
    const after = await paySettlement(ctx, settlementId, {
      externalRef: "TRF-2026-0615-001",
      paidVia: "bank_transfer"
    });

    expect(after.state).toBe("paid");
    expect(after.externalRef).toBe("TRF-2026-0615-001");
    expect(after.paidVia).toBe("bank_transfer");

    const stored = await getSettlement(ctx, settlementId);
    expect(stored.externalRef).toBe("TRF-2026-0615-001");
    expect(stored.paidVia).toBe("bank_transfer");

    const [row] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), eq(schema.auditLog.action, "ledger.settlement.pay")));
    expect(row?.afterHash).toBe(await hashObject(after));
  });

  it("still holds idempotency: a retry with the same key posts nothing twice", async () => {
    const settlementId = await approvedSettlement();
    await paySettlement(ctx, settlementId, PAYMENT);
    // The engine-level guard: the state machine itself, independent of the
    // route's Idempotency-Key header, still refuses a second pay call.
    await rejects(paySettlement(ctx, settlementId, PAYMENT), /only an approved settlement can be paid/);

    const batches = await ctx.db.select().from(schema.ledgerJournalBatches);
    expect(batches).toHaveLength(2); // one accrual, one payout — unchanged by the new field
  });
});

/* ---------------------------------------------------------------- periods */

describe("closed periods", () => {
  it("refuses to accrue into a hard-closed period", async () => {
    await hardClose(LAST_MONTH);
    await partner(ctx, 0);
    await entry(ctx, 30_000, Date.UTC(2026, 4, 20));
    const { settlement } = await run(ctx, LAST_MONTH);

    await rejects(approveSettlement(ctx, settlement.id), /hard closed/);
  });

  it("refuses to pay out of a hard-closed period, and burns no idempotency key", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, Date.UTC(2026, 4, 20));
    const { settlement } = await run(ctx, LAST_MONTH);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    await approveSettlement(ctx, settlement.id);

    // The month closes between signing off and paying.
    await ctx.db
      .update(schema.ledgerPeriods)
      .set({ state: "hard_closed" })
      .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, LAST_MONTH)));

    await rejects(paySettlement(ctx, settlement.id, PAYMENT), /hard closed/);
    expect((await getSettlement(ctx, settlement.id)).state).toBe("approved");

    // The refusal must not have left a failed RSHARE-SETL holding the key.
    const txns = await ctx.db.select().from(schema.ledgerTxns);
    expect(txns.map((t) => t.type)).toEqual(["RSHARE-ACCR"]);

    // Reopen and the payout still goes through on the same key.
    await ctx.db
      .update(schema.ledgerPeriods)
      .set({ state: "open" })
      .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, LAST_MONTH)));
    await rejects(paySettlement(ctx, settlement.id, PAYMENT), /ledger\.partner_settlement/);
    await signOff("ledger.partner_settlement", settlement.id);
    expect((await paySettlement(ctx, settlement.id, PAYMENT)).state).toBe("paid");
  });
});

/* ----------------------------------------------------------------- ledger */

describe("journal lines", () => {
  it("balance, in transaction and base currency, on every batch", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await settleFully(settlement.id);

    const batches = await ctx.db.select().from(schema.ledgerJournalBatches);
    expect(batches).toHaveLength(2);
    for (const b of batches) {
      expect(b.totalDebitMinor).toBe(b.totalCreditMinor);
      expect(b.baseTotalDebitMinor).toBe(b.baseTotalCreditMinor);
    }

    const lines = await ctx.db.select().from(schema.ledgerJournalLines);
    const side = (s: string) =>
      lines.filter((l) => l.side === s).reduce((n, l) => n + l.amountMinor, 0);
    expect(side("debit")).toBe(side("credit"));
    expect(side("debit")).toBe(60_000); // 30_000 accrued, 30_000 paid

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it("accrues the expense, then moves the payable to cash", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await settleFully(settlement.id);

    const lines = await ctx.db.select().from(schema.ledgerJournalLines);
    const net = new Map<string, number>();
    for (const l of lines) {
      net.set(l.accountCode, (net.get(l.accountCode) ?? 0) + (l.side === "debit" ? l.amountMinor : -l.amountMinor));
    }
    // Commission expense up, cash down, payable back to nil once paid.
    expect(net.get("5400")).toBe(30_000);
    expect(net.get("1000")).toBe(-30_000);
    expect(net.get("2100")).toBe(0);

    const entries = await ctx.db.select().from(schema.distCommissionEntries);
    expect(entries.every((e) => e.state === "paid")).toBe(true);
  });

  it("carries the settlement dimension on every line, so a payout is traceable", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await settleFully(settlement.id);

    const lines = await ctx.db.select().from(schema.ledgerJournalLines);
    for (const l of lines) {
      const dims = JSON.parse(l.dimsJson ?? "{}") as { settlement?: string; channel?: string };
      expect(dims.settlement).toBe(settlement.id);
      expect(dims.channel).toBe(CHANNEL);
    }
  });
});

/* -------------------------------------------------------------- lifecycle */

describe("disputes", () => {
  it("parks a draft and lets it back out again", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    expect((await disputeSettlement(ctx, settlement.id, "line 3 is not ours")).state).toBe("disputed");
    expect((await reopenSettlement(ctx, settlement.id, "resolved")).state).toBe("draft");
  });

  it("will not reopen a settlement whose accrual has posted", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await rejects(approveSettlement(ctx, settlement.id), /dist\.settlement_run/);
    await signOff("dist.settlement_run", settlement.id);
    await approveSettlement(ctx, settlement.id);
    await disputeSettlement(ctx, settlement.id, "they dispute the total");

    await rejects(reopenSettlement(ctx, settlement.id, "sorted"), /reverse/);
  });

  it("cannot dispute a settlement that has already been paid", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);
    await settleFully(settlement.id);

    await rejects(disputeSettlement(ctx, settlement.id, "too late"), /can no longer be disputed/);
  });
});

/* -------------------------------------------------------------- statement */

describe("remittance advice", () => {
  it("shows every line, its bucket, and the agreement it was priced under", async () => {
    const partnerId = await partner(ctx, 50_000);
    await ctx.db.insert(schema.distPartnerAgreements).values({
      id: "agr_1",
      tenantId: ctx.tenantId,
      partnerId,
      version: 3,
      state: "active",
      termsJson: JSON.stringify({ settlement: { minPayoutMinor: 10_000 } }),
      effectiveFrom: Date.UTC(2026, 0, 1),
      createdBy: "user:u_runner",
      createdAt: NOW,
      updatedAt: NOW
    });
    await entry(ctx, 30_000, Date.UTC(2026, 4, 20)); // carried in from May
    await run(ctx, LAST_MONTH);
    await entry(ctx, 25_000, NOW - DAY);

    const { settlement, terms } = await run(ctx, THIS_MONTH);
    // The agreement overrides the partner default, so June clears the floor.
    expect(terms).toMatchObject({ minPayoutMinor: 10_000, agreementId: "agr_1", agreementVersion: 3 });

    const { table, totals } = await statementTable(ctx, settlement);
    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.bucket).sort()).toEqual(["2026-06", "carried in"]);
    expect(totals.netMinor).toBe(55_000);
    expect(table.rows.every((r) => r.agreement === "v3")).toBe(true);
  });

  // A legacy row. `earnedAt` was unbounded before the write surfaces were, and
  // the period filter is `earned < endAt` — so every *past* instant is in scope,
  // including one no `Date` can hold. `new Date(-9e15).toISOString()` throws
  // RangeError, and the throw is inside the row map, so one unreadable cell took
  // the whole remittance advice down instead of rendering as unreadable.
  it("renders a line whose earned instant no Date can hold", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(ctx, 1_000, -9e15);

    const { settlement } = await run(ctx);
    const { table } = await statementTable(ctx, settlement);

    expect(table.rows).toHaveLength(2);
    expect(table.rows.map((r) => r.earnedOn)).toContain("unknown");
  });

  // Sighting 12 fixed the crash: `assertPayable` refuses to *draft* an insurer
  // settlement (money in, not out), but the seed carries three and the list
  // screen shows them, so the detail route opens one. Its ref is
  // `provider:{id}`, which `channelOf` rejected with a 400 that the web loader
  // inherited as a crash. docs/27 P2 is the next layer: once that no longer
  // crashes, the advice still had no lines at all, because nothing read the
  // provider dimension `dist_commission_entries` already carries.
  it("renders an insurer settlement as an empty advice when no entries name that provider", async () => {
    await ctx.db.insert(schema.ledgerSettlements).values({
      id: "setl_insurer",
      tenantId: ctx.tenantId,
      counterpartyKind: "insurer",
      counterpartyRef: "provider:prv_cedar",
      period: THIS_MONTH,
      grossMinor: 40_000,
      adjustmentsMinor: 0,
      netMinor: 40_000,
      currency: "AED",
      state: "paid",
      createdAt: NOW,
      updatedAt: NOW
    });
    const settlement = await getSettlement(ctx, "setl_insurer");

    const { table, totals, terms } = await statementTable(ctx, settlement);

    expect(table.rows).toEqual([]);
    // The stored total stands — it is money the insurer owes, computed against
    // the provider remittance.
    expect(totals.netMinor).toBe(40_000);
    expect(terms.agreementId).toBeNull();
  });

  it("renders the commission entries booked against that provider as the advice's lines", async () => {
    const PROVIDER = "prv_cedar_2";
    await ctx.db.insert(schema.ledgerSettlements).values({
      id: "setl_insurer_2",
      tenantId: ctx.tenantId,
      counterpartyKind: "insurer",
      counterpartyRef: `provider:${PROVIDER}`,
      period: THIS_MONTH,
      grossMinor: 45_000,
      adjustmentsMinor: 0,
      netMinor: 45_000,
      currency: "AED",
      state: "draft",
      createdAt: NOW,
      updatedAt: NOW
    });
    await entry(ctx, 12_000, NOW - 2 * DAY, {
      providerId: PROVIDER,
      grossCommissionMinor: 30_000,
      channelId: "chn_unrelated"
    });
    // A different provider's entry must not leak into this one's advice.
    await entry(ctx, 5_000, NOW - DAY, { providerId: "prv_other", grossCommissionMinor: 15_000 });
    // Already claimed by a different insurer settlement — excluded the same
    // way a channel settlement excludes an already-stamped entry.
    await entry(ctx, 9_000, NOW - DAY, {
      providerId: PROVIDER,
      grossCommissionMinor: 9_000,
      providerSettlementId: "stl_other_insurer"
    });

    const settlement = await getSettlement(ctx, "setl_insurer_2");
    const { table, totals } = await statementTable(ctx, settlement);

    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({ grossCommissionMinor: 30_000 });
    expect(totals.netMinor).toBe(45_000);
  });

  it("keeps the rendered advice and points the settlement at it", async () => {
    await partner(ctx, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    const { settlement } = await run(ctx);

    for (const format of ["pdf", "xlsx"] as const) {
      const result = await settlementStatement(ctx, settlement.id, format, undefined);
      expect(result.rendered.bytes.length).toBeGreaterThan(0);
      expect(result.filename).toContain(settlement.period);
      expect((await getSettlement(ctx, settlement.id)).statementFileId).toBe(result.fileId);
    }

    const files = await ctx.db.select().from(schema.files);
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.kind === "settlement_statement" && f.subjectRef === settlement.id)).toBe(true);
  });
});

/* ---------------------------------------------------------------- tenancy */

describe("tenancy", () => {
  it("never sees another tenant's entries or settlements", async () => {
    const foreign = ctxFor(ctx.db, "t_other", "u_other");
    await partner(ctx, 0);
    await partner(foreign, 0);
    await entry(ctx, 30_000, NOW - 2 * DAY);
    await entry(foreign, 999_000, NOW - 2 * DAY);

    const mine = await run(ctx);
    expect(mine.totals.netMinor).toBe(30_000);

    const theirs = await run(foreign);
    expect(theirs.totals.netMinor).toBe(999_000);
    expect(theirs.settlement.id).not.toBe(mine.settlement.id);

    // Same period, same counterparty ref, different tenant: two rows, no bleed.
    await rejects(getSettlement(foreign, mine.settlement.id), /settlement/);
    await rejects(approveSettlement(foreign, mine.settlement.id), /settlement/);
  });
});

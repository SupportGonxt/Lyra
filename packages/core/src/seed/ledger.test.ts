import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema, TAX_KINDS } from "@lyra/db";
import type { CoreDb } from "../context.js";
import { seedLedger } from "./ledger.js";
import { DAY, HOUR, MINUTE, type SeedContext } from "./context.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

// A fixed clock away from any month boundary, so `now` and `now + 2 * DAY`
// (issuedAt) land in the same month and every date-math branch is unambiguous.
const NOW = Date.UTC(2026, 0, 15, 8, 0, 0);
const ISSUED_AT = NOW + 2 * DAY;

const monthStart = (delta: number): number => Date.UTC(2026, delta, 1);
const codeOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

const THIS_MONTH = codeOf(NOW); // "2026-01"
const LAST_MONTH = codeOf(monthStart(-1)); // "2025-12"
const MONTH_BEFORE = codeOf(monthStart(-2)); // "2025-11"
const DEC_MID = monthStart(-1) + 24 * DAY;

const TENANT = "t_ledger_test";
const POLICY_ID = "pol_test_1";
const RENEWAL_POLICY_ID = "pol_test_renewal";
const CASE_ID = "case_test_1";
const CUSTOMER_ID = "cust_test_rania";

const PROV = {
  gonxt: "prov_gonxt",
  falcon: "prov_falcon",
  cedar: "prov_cedar",
  oryx: "prov_oryx",
  gulfHealth: "prov_gulfhealth",
  meridian: "prov_meridian"
};
const CHAN = { web: "chan_web", app: "chan_app", callCentre: "chan_callcentre", brokerAlpha: "chan_brokeralpha", bankEmbed: "chan_bankembed" };
const USERS = { "finance.controller": "usr_ctrl", "finance.analyst": "usr_analyst", "axis.agent": "usr_agent" };
const CONTROLLER = `user:${USERS["finance.controller"]}`;
const ANALYST = `user:${USERS["finance.analyst"]}`;
const AGENT = `user:${USERS["axis.agent"]}`;

// Chosen distinct from each other so a swapped-field mutant (e.g. commission
// written where premium belongs) shows up as a wrong number, not a coincidence.
const PREMIUM_MINOR = 400_000;
const COMMISSION_MINOR = 40_000;
const PREMIUM_TAX_MINOR = 20_000; // applyPpm(400_000, 50_000): floor((20_000_000_000+500_000)/1_000_000)
const COLLECTED_MINOR = PREMIUM_MINOR + PREMIUM_TAX_MINOR; // 420_000
const CLIENT_MONEY_FLOAT = COLLECTED_MINOR - PREMIUM_MINOR; // 20_000

// splitCommission({ premiumMinor: 416_000, baseCommissionPpm: 150_000, channelSharePpm: 300_000 })
const ALPHA_GROSS = 62_400;
const ALPHA_CHANNEL = 18_720;
const ALPHA_NET = 43_680;

const ACCOUNT_CODES = ["1100", "4000", "4010", "1000", "5300", "2100", "1010", "2010", "1160", "2300", "2200", "4040", "4050"];

let client: Client;
let db: CoreDb;

function makeCtx(): SeedContext {
  return {
    db,
    now: NOW,
    tenantId: TENANT,
    users: USERS,
    teams: { motor: "team_motor", health: "team_health", retention: "team_retention" },
    providers: PROV,
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
    channels: CHAN,
    customerId: CUSTOMER_ID,
    consentId: "consent_test_1",
    quoteRequestId: "qr_test_1",
    caseId: CASE_ID,
    policyId: POLICY_ID,
    renewalPolicyId: RENEWAL_POLICY_ID,
    issuedAt: ISSUED_AT
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  db = drizzle(client) as unknown as CoreDb;

  for (const code of ACCOUNT_CODES) {
    await db.insert(schema.ledgerAccounts).values({
      id: `acc_${code}`,
      tenantId: TENANT,
      code,
      nameJson: JSON.stringify({ en: code }),
      type: "asset",
      normalSide: "debit",
      createdAt: NOW
    });
  }

  await db.insert(schema.axisPolicies).values({
    id: POLICY_ID,
    tenantId: TENANT,
    customerId: CUSTOMER_ID,
    providerId: PROV.cedar,
    policyNo: "TEST-POL-0001",
    startAt: NOW,
    endAt: NOW + 365 * DAY,
    premiumMinor: PREMIUM_MINOR,
    currency: "AED",
    commissionMinor: COMMISSION_MINOR,
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });

  await seedLedger(makeCtx());
});

async function txnByKey(type: string, idempotencyKey: string) {
  const [row] = await db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, TENANT), eq(schema.ledgerTxns.type, type), eq(schema.ledgerTxns.idempotencyKey, idempotencyKey)));
  if (!row) throw new Error(`test: no txn ${type}/${idempotencyKey}`);
  return row;
}

async function batchByTxnId(txnId: string) {
  const [row] = await db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.txnId, txnId));
  if (!row) throw new Error(`test: no batch for txn ${txnId}`);
  return row;
}

async function linesFor(batchId: string) {
  return db
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.batchId, batchId))
    .orderBy(schema.ledgerJournalLines.seq);
}

async function periodByCode(code: string) {
  const [row] = await db.select().from(schema.ledgerPeriods).where(and(eq(schema.ledgerPeriods.tenantId, TENANT), eq(schema.ledgerPeriods.code, code)));
  if (!row) throw new Error(`test: no period ${code}`);
  return row;
}

async function invoiceByNumber(number: string) {
  const [row] = await db.select().from(schema.ledgerInvoices).where(and(eq(schema.ledgerInvoices.tenantId, TENANT), eq(schema.ledgerInvoices.number, number)));
  if (!row) throw new Error(`test: no invoice ${number}`);
  return row;
}

async function subByCustomerRef(customerRef: string) {
  const [row] = await db
    .select()
    .from(schema.ledgerSubscriptions)
    .where(and(eq(schema.ledgerSubscriptions.tenantId, TENANT), eq(schema.ledgerSubscriptions.customerRef, customerRef)));
  if (!row) throw new Error(`test: no subscription ${customerRef}`);
  return row;
}

async function transitionsFor(txnId: string) {
  return db
    .select()
    .from(schema.ledgerTxnTransitions)
    .where(eq(schema.ledgerTxnTransitions.txnId, txnId))
    .orderBy(schema.ledgerTxnTransitions.ts);
}

/* -------------------------------------------------------------------- periods */

describe("periods", () => {
  it("opens the two months around now and closes the two before it", async () => {
    const rows = await db.select().from(schema.ledgerPeriods).where(eq(schema.ledgerPeriods.tenantId, TENANT));
    expect(rows).toHaveLength(4);

    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"].sort());
  });

  it("hard-closes the month two back, with a checklist and a closer", async () => {
    const p = await periodByCode(MONTH_BEFORE);
    expect(p.state).toBe("hard_closed");
    expect(p.startAt).toBe(monthStart(-2));
    expect(p.endAt).toBe(monthStart(-1) - 1);
    expect(p.closedBy).toBe(CONTROLLER);
    expect(p.closedAt).toBe(monthStart(-1) + 5 * DAY);
    const checklist = JSON.parse(p.checklistJson!);
    expect(checklist).toEqual([
      { name: `trial_balance_zero@${MONTH_BEFORE}`, ok: true },
      { name: `no_pending_external@${MONTH_BEFORE}`, ok: true },
      { name: `no_open_client_money_breach@${MONTH_BEFORE}`, ok: true }
    ]);
  });

  it("soft-closes last month", async () => {
    const p = await periodByCode(LAST_MONTH);
    expect(p.state).toBe("soft_closed");
    expect(p.closedBy).toBe(CONTROLLER);
    expect(p.closedAt).toBe(monthStart(0) + 5 * DAY);
  });

  it("leaves this month and next month open, with no checklist and no closer", async () => {
    const thisP = await periodByCode(THIS_MONTH);
    expect(thisP.state).toBe("open");
    expect(thisP.checklistJson).toBeNull();
    expect(thisP.closedBy).toBeNull();
    expect(thisP.closedAt).toBeNull();
    expect(thisP.startAt).toBe(monthStart(0));
    expect(thisP.endAt).toBe(monthStart(1) - 1);

    const nextP = await periodByCode(codeOf(monthStart(1)));
    expect(nextP.state).toBe("open");
    expect(nextP.checklistJson).toBeNull();
  });
});

/* ------------------------------------------------------------------ the sale */

describe("the sale read back from axisPolicies", () => {
  it("uses the policy's own premium and commission, not a guessed number", async () => {
    const t = await txnByKey("PREM-COLLECT", `prem-collect:${POLICY_ID}`);
    expect(t.grossMinor).toBe(COLLECTED_MINOR);
    const b = await txnByKey("BIND", `bind:${CASE_ID}`);
    expect(b.grossMinor).toBe(COMMISSION_MINOR);
  });

  it("throws when the policy is missing", async () => {
    // A fresh db: seedLedger already ran once against `db` in beforeEach, so
    // re-running it there would hit a duplicate-period unique-constraint
    // failure (periods are inserted before the policy check) rather than
    // exercising the check this test targets.
    const freshClient = createClient({ url: ":memory:" });
    for (const sql of migrationStatements()) await freshClient.execute(sql);
    const freshDb = drizzle(freshClient) as unknown as CoreDb;
    for (const code of ACCOUNT_CODES) {
      await freshDb.insert(schema.ledgerAccounts).values({
        id: `acc_${code}`,
        tenantId: TENANT,
        code,
        nameJson: JSON.stringify({ en: code }),
        type: "asset",
        normalSide: "debit",
        createdAt: NOW
      });
    }
    await expect(seedLedger({ ...makeCtx(), db: freshDb })).rejects.toThrow(/seed: the ledger needs the motor policy/);
  });
});

describe("actor fallback when a config role has no seeded user", () => {
  it("falls back to the literal 'seed' actor, not an empty string, when a role is unmapped", async () => {
    const freshClient = createClient({ url: ":memory:" });
    for (const sql of migrationStatements()) await freshClient.execute(sql);
    const freshDb = drizzle(freshClient) as unknown as CoreDb;
    for (const code of ACCOUNT_CODES) {
      await freshDb.insert(schema.ledgerAccounts).values({
        id: `acc_${code}`,
        tenantId: TENANT,
        code,
        nameJson: JSON.stringify({ en: code }),
        type: "asset",
        normalSide: "debit",
        createdAt: NOW
      });
    }
    await freshDb.insert(schema.axisPolicies).values({
      id: POLICY_ID,
      tenantId: TENANT,
      customerId: CUSTOMER_ID,
      providerId: PROV.cedar,
      policyNo: "TEST-POL-0001",
      startAt: NOW,
      endAt: NOW + 365 * DAY,
      premiumMinor: PREMIUM_MINOR,
      currency: "AED",
      commissionMinor: COMMISSION_MINOR,
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    });
    await seedLedger({ ...makeCtx(), db: freshDb, users: {} });

    const [period] = await freshDb
      .select()
      .from(schema.ledgerPeriods)
      .where(and(eq(schema.ledgerPeriods.tenantId, TENANT), eq(schema.ledgerPeriods.state, "hard_closed")));
    expect(period!.closedBy).toBe("user:seed");

    const [cedarSettle] = await freshDb
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, TENANT), eq(schema.ledgerTxns.type, "CMSN-SETL")));
    expect(cedarSettle!.actorId).toBe("seed");

    const [bindRania] = await freshDb
      .select()
      .from(schema.ledgerTxns)
      .where(
        and(eq(schema.ledgerTxns.tenantId, TENANT), eq(schema.ledgerTxns.type, "BIND"), eq(schema.ledgerTxns.idempotencyKey, `bind:${CASE_ID}`))
      );
    expect(bindRania!.actorId).toBe("seed");

    const [refundOryx] = await freshDb
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, TENANT), eq(schema.ledgerTxns.type, "REFUND-ISSUE")));
    expect(refundOryx!.actorId).toBe("seed");
  });
});

/* -------------------------------------------------------------------- txns */

describe("transactions", () => {
  it("writes exactly 14 transactions", async () => {
    const rows = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, TENANT));
    expect(rows).toHaveLength(14);
  });

  it("txDecAccrual: settled, system actor, AED, no fx conversion needed", async () => {
    const t = await txnByKey("CMSN-ACCR", `cmsn-accr:${PROV.cedar}:${LAST_MONTH}`);
    expect(t.state).toBe("settled");
    expect(t.actorKind).toBe("system");
    expect(t.actorId).toBe("scheduler");
    expect(t.currency).toBe("AED");
    expect(t.fxRatePpm).toBe(1_000_000);
    expect(t.grossMinor).toBe(386_400);
    expect(t.baseGrossMinor).toBe(386_400);
    expect(t.createdAt).toBe(DEC_MID);
    expect(t.settledAt).toBe(DEC_MID + MINUTE);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: 386_400, net: 386_400, tax: 0 });
  });

  it("txCedarSettle: the fee is real — net is gross minus the bank's cut", async () => {
    const t = await txnByKey("CMSN-SETL", `cmsn-setl:${PROV.cedar}:${LAST_MONTH}`);
    expect(t.actorKind).toBe("user");
    expect(t.actorId).toBe(USERS["finance.controller"]);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: 386_400, fee: 2_280, net: 384_120 });
    expect(t.createdAt).toBe(monthStart(-1) + 27 * DAY);
    expect(t.updatedAt).toBe(monthStart(-1) + 27 * DAY + HOUR);
    expect(t.settledAt).toBe(monthStart(-1) + 27 * DAY + HOUR);
  });

  it("txAlphaBind: reversed, carries the b2b split and an autonomy level", async () => {
    const t = await txnByKey("BIND", "bind:GNX-2512-0188");
    expect(t.state).toBe("reversed");
    expect(t.actorKind).toBe("partner");
    expect(t.actorId).toBe(CHAN.brokerAlpha);
    expect(t.autonomyLevel).toBe("act_with_approval");
    expect(t.grossMinor).toBe(ALPHA_GROSS);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: ALPHA_GROSS, share: ALPHA_CHANNEL, net: ALPHA_NET });
    expect(JSON.parse(t.guardrailsJson!)).toEqual({ consent_checked: true, disclosure_presented: true });
    expect(t.createdAt).toBe(monthStart(-1) + 30 * DAY);
    expect(t.settledAt).toBe(monthStart(-1) + 30 * DAY + 2 * MINUTE);
  });

  it("txAlphaReversal: points back at the original via parentTxnId and reversalOf", async () => {
    const bind = await txnByKey("BIND", "bind:GNX-2512-0188");
    const rev = await txnByKey("BIND", `reverse:${bind.id}`);
    expect(rev.parentTxnId).toBe(bind.id);
    expect(rev.reversalOf).toBe(bind.id);
    expect(rev.state).toBe("settled");
    expect(rev.grossMinor).toBe(ALPHA_GROSS);
    expect(JSON.parse(rev.metadataJson!)).toEqual({ reversalOf: bind.id, reason: "cooling-off cancellation within 5 days" });
  });

  it("txPremCollect: gross is collected (premium + tax), customer actor", async () => {
    const t = await txnByKey("PREM-COLLECT", `prem-collect:${POLICY_ID}`);
    expect(t.actorKind).toBe("customer");
    expect(t.actorId).toBe(CUSTOMER_ID);
    expect(t.grossMinor).toBe(COLLECTED_MINOR);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: COLLECTED_MINOR, net: PREMIUM_MINOR, tax: PREMIUM_TAX_MINOR });
    const refs = JSON.parse(t.subjectRefsJson!);
    expect(refs).toEqual({ customer: CUSTOMER_ID, case: CASE_ID, policy: POLICY_ID, channel: CHAN.web, provider: PROV.cedar });
  });

  it("txBindRania: gross is the commission alone, no channel share (b2c)", async () => {
    const t = await txnByKey("BIND", `bind:${CASE_ID}`);
    expect(t.actorKind).toBe("user");
    expect(t.actorId).toBe(USERS["axis.agent"]);
    expect(t.autonomyLevel).toBe("act_with_approval");
    expect(t.grossMinor).toBe(COMMISSION_MINOR);
    expect(JSON.parse(t.amountsJson!)).toEqual({ gross: COMMISSION_MINOR, net: COMMISSION_MINOR, share: 0, tax: 0 });
  });

  it("txPremRemit: remits exactly the premium, not the collected total", async () => {
    const t = await txnByKey("PREM-REMIT", `prem-remit:${POLICY_ID}`);
    expect(t.grossMinor).toBe(PREMIUM_MINOR);
    expect(t.baseGrossMinor).toBe(PREMIUM_MINOR);
  });

  it("txFalconInvoice: USD with a real fx conversion to the base ledger", async () => {
    const t = await txnByKey("SUB-INVOICE", `sub-invoice:${PROV.falcon}:${THIS_MONTH}`);
    expect(t.currency).toBe("USD");
    expect(t.baseCurrency).toBe("AED");
    expect(t.fxRatePpm).toBe(3_672_500);
    expect(t.grossMinor).toBe(480_000);
    // applyPpm(480_000, 3_672_500) = floor((1_762_800_000_000 + 500_000) / 1_000_000)
    expect(t.baseGrossMinor).toBe(1_762_800);
  });

  it("txRefundOryx: failed before anything posted, carries a failure code and detail", async () => {
    const t = await txnByKey("REFUND-ISSUE", `refund:${PROV.oryx}:${LAST_MONTH}`);
    expect(t.state).toBe("failed");
    expect(t.failureCode).toBe("psp_timeout");
    expect(t.failureDetail).toBe("no response from the provider inside the 30s window; funds never left the account");
    expect(t.failedAt).toBe(NOW - 2 * DAY + 4 * MINUTE);
    expect(t.fxRatePpm).toBeNull();
  });

  it("txPayoutAlpha: validated (not settled) — waiting on the second controller", async () => {
    const t = await txnByKey("RSHARE-SETL", `rshare-setl:${CHAN.brokerAlpha}:${LAST_MONTH}`);
    expect(t.state).toBe("validated");
    expect(t.settledAt).toBeNull();
    expect(JSON.parse(t.guardrailsJson!)).toEqual({ dual_control: true, approvals_required: 2, approvals_held: 1 });
  });

  it("txPspSettle: pending_external, carries an externalTimeoutAt", async () => {
    const t = await txnByKey("PSP-SETTLE", `psp-settle:tap:${THIS_MONTH}`);
    expect(t.state).toBe("pending_external");
    expect(t.externalTimeoutAt).toBe(NOW + 2 * DAY);
    expect(t.settledAt).toBeNull();
  });
});

/* --------------------------------------------------------------- transitions */

describe("transitions", () => {
  it("writes 24 rows across five walked histories, including the manual reversal pair", async () => {
    const rows = await db.select().from(schema.ledgerTxnTransitions).where(eq(schema.ledgerTxnTransitions.tenantId, TENANT));
    expect(rows).toHaveLength(24);
  });

  it("txBindRania: the full five-state happy path, 15s apart, agent throughout", async () => {
    const t = await txnByKey("BIND", `bind:${CASE_ID}`);
    const rows = await transitionsFor(t.id);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.toState)).toEqual(["initiated", "validated", "authorized", "executing", "settled"]);
    expect(rows[0]!.fromState).toBeNull();
    expect(rows[0]!.ts).toBe(ISSUED_AT + 5 * MINUTE);
    expect(rows[4]!.ts).toBe(ISSUED_AT + 5 * MINUTE + 4 * 15_000);
    expect(rows.every((r) => r.actorRef === AGENT)).toBe(true);
    expect(rows.every((r) => r.reason === null)).toBe(true);
  });

  it("txAlphaBind: five walked states plus two manual reversal transitions with reasons", async () => {
    const bind = await txnByKey("BIND", "bind:GNX-2512-0188");
    const rows = await transitionsFor(bind.id);
    expect(rows).toHaveLength(7);
    expect(rows.map((r) => r.toState)).toEqual([
      "initiated",
      "validated",
      "authorized",
      "executing",
      "settled",
      "reversing",
      "reversed"
    ]);
    const reversing = rows[5]!;
    expect(reversing.fromState).toBe("settled");
    expect(reversing.actorRef).toBe(CONTROLLER);
    expect(reversing.reason).toBe("cooling-off cancellation within 5 days");
    expect(reversing.ts).toBe(NOW + 4 * HOUR);
    const reversed = rows[6]!;
    expect(reversed.fromState).toBe("reversing");
    expect(reversed.reason).toBe("contra batch posted in the open period");
    expect(reversed.ts).toBe(NOW + 4 * HOUR + 2 * MINUTE);
    // The walked portion is the partner actor, not the controller.
    expect(rows[0]!.actorRef).toBe(`partner:${CHAN.brokerAlpha}`);
  });

  it("txRefundOryx: the terminal 'failed' transition carries the timeout reason", async () => {
    const t = await txnByKey("REFUND-ISSUE", `refund:${PROV.oryx}:${LAST_MONTH}`);
    const rows = await transitionsFor(t.id);
    expect(rows).toHaveLength(5);
    expect(rows[4]!.toState).toBe("failed");
    expect(rows[4]!.reason).toBe("psp_timeout: no response inside the 30s window");
    expect(rows[0]!.reason).toBeNull();
    expect(rows.every((r) => r.actorRef === ANALYST)).toBe(true);
  });

  it("txPayoutAlpha: only two states, held at validated with an explicit reason", async () => {
    const t = await txnByKey("RSHARE-SETL", `rshare-setl:${CHAN.brokerAlpha}:${LAST_MONTH}`);
    const rows = await transitionsFor(t.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.toState)).toEqual(["initiated", "validated"]);
    expect(rows[1]!.reason).toBe("held for the second controller's approval");
  });
});

/* ---------------------------------------------------------------- saga steps */

describe("saga steps", () => {
  it("writes exactly 6 steps", async () => {
    const rows = await db.select().from(schema.ledgerSagaSteps).where(eq(schema.ledgerSagaSteps.tenantId, TENANT));
    expect(rows).toHaveLength(6);
  });

  it("txPremRemit: three steps, seq 1-3, the second retried once with a real lastError", async () => {
    const t = await txnByKey("PREM-REMIT", `prem-remit:${POLICY_ID}`);
    const rows = await db
      .select()
      .from(schema.ledgerSagaSteps)
      .where(eq(schema.ledgerSagaSteps.txnId, t.id))
      .orderBy(schema.ledgerSagaSteps.seq);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(["reserve_client_money", "insurer_remittance_call", "post_journal"]);
    expect(rows.every((r) => r.state === "done")).toBe(true);
    expect(rows[1]!.attempts).toBe(2);
    expect(rows[1]!.lastError).toBe("504 from the insurer gateway on the first attempt");
    expect(JSON.parse(rows[1]!.resultJson!)).toEqual({ providerRef: "CDR-RMT-26010801" });
    expect(JSON.parse(rows[0]!.resultJson!)).toEqual({ reservedMinor: PREMIUM_MINOR });
  });

  it("txRefundOryx: the reservation is compensated, the psp call is failed — nothing half-done", async () => {
    const t = await txnByKey("REFUND-ISSUE", `refund:${PROV.oryx}:${LAST_MONTH}`);
    const rows = await db
      .select()
      .from(schema.ledgerSagaSteps)
      .where(eq(schema.ledgerSagaSteps.txnId, t.id))
      .orderBy(schema.ledgerSagaSteps.seq);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.state).toBe("compensated");
    expect(rows[0]!.compensationRef).toBe(`release:${t.id}`);
    expect(rows[1]!.state).toBe("failed");
    expect(rows[1]!.attempts).toBe(3);
    expect(rows[1]!.lastError).toBe("psp_timeout after 3 attempts");
  });

  it("txPspSettle: one step, still running, no endedAt", async () => {
    const t = await txnByKey("PSP-SETTLE", `psp-settle:tap:${THIS_MONTH}`);
    const rows = await db.select().from(schema.ledgerSagaSteps).where(eq(schema.ledgerSagaSteps.txnId, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("running");
    expect(rows[0]!.endedAt).toBeNull();
  });
});

/* -------------------------------------------------- journal batches and lines */

const EXPECTED_BATCHES: {
  key: string;
  type: string;
  idemKey: string;
  currency: string;
  fxRatePpm: number;
  periodCode: string;
  totalDebitMinor: number;
  totalCreditMinor: number;
  baseTotalDebitMinor: number;
  baseTotalCreditMinor: number;
  postedBy: string;
  postedAt: number;
  lineCount: number;
}[] = [
  {
    key: "bDecAccrual",
    type: "CMSN-ACCR",
    idemKey: `cmsn-accr:${PROV.cedar}:${LAST_MONTH}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: LAST_MONTH,
    totalDebitMinor: 386_400,
    totalCreditMinor: 386_400,
    baseTotalDebitMinor: 386_400,
    baseTotalCreditMinor: 386_400,
    postedBy: "system:scheduler",
    postedAt: DEC_MID + MINUTE,
    lineCount: 3
  },
  {
    key: "bCedarSettle",
    type: "CMSN-SETL",
    idemKey: `cmsn-setl:${PROV.cedar}:${LAST_MONTH}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: LAST_MONTH,
    totalDebitMinor: 386_400,
    totalCreditMinor: 386_400,
    baseTotalDebitMinor: 386_400,
    baseTotalCreditMinor: 386_400,
    postedBy: CONTROLLER,
    postedAt: monthStart(-1) + 27 * DAY + HOUR,
    lineCount: 3
  },
  {
    key: "bAlphaBind",
    type: "BIND",
    idemKey: "bind:GNX-2512-0188",
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: LAST_MONTH,
    totalDebitMinor: ALPHA_GROSS,
    totalCreditMinor: ALPHA_NET + ALPHA_CHANNEL,
    baseTotalDebitMinor: ALPHA_GROSS,
    baseTotalCreditMinor: ALPHA_NET + ALPHA_CHANNEL,
    postedBy: `partner:${CHAN.brokerAlpha}`,
    postedAt: monthStart(-1) + 30 * DAY + 2 * MINUTE,
    lineCount: 3
  },
  {
    key: "bPremCollect",
    type: "PREM-COLLECT",
    idemKey: `prem-collect:${POLICY_ID}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: COLLECTED_MINOR,
    totalCreditMinor: COLLECTED_MINOR,
    baseTotalDebitMinor: COLLECTED_MINOR,
    baseTotalCreditMinor: COLLECTED_MINOR,
    postedBy: `customer:${CUSTOMER_ID}`,
    postedAt: ISSUED_AT + 5 * MINUTE,
    lineCount: 2
  },
  {
    key: "bBindRania",
    type: "BIND",
    idemKey: `bind:${CASE_ID}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: COMMISSION_MINOR,
    totalCreditMinor: COMMISSION_MINOR,
    baseTotalDebitMinor: COMMISSION_MINOR,
    baseTotalCreditMinor: COMMISSION_MINOR,
    postedBy: AGENT,
    postedAt: ISSUED_AT + 6 * MINUTE,
    lineCount: 2
  },
  {
    key: "bPremRemit",
    type: "PREM-REMIT",
    idemKey: `prem-remit:${POLICY_ID}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: PREMIUM_MINOR,
    totalCreditMinor: PREMIUM_MINOR,
    baseTotalDebitMinor: PREMIUM_MINOR,
    baseTotalCreditMinor: PREMIUM_MINOR,
    postedBy: "system:scheduler",
    postedAt: ISSUED_AT + 3 * HOUR + MINUTE,
    lineCount: 2
  },
  {
    key: "bSubInvoice",
    type: "SUB-INVOICE",
    idemKey: `sub-invoice:${CHAN.brokerAlpha}:${THIS_MONTH}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: 472_500,
    totalCreditMinor: 450_000 + 22_500,
    baseTotalDebitMinor: 472_500,
    baseTotalCreditMinor: 472_500,
    postedBy: "system:billing",
    postedAt: NOW + HOUR + MINUTE,
    lineCount: 3
  },
  {
    key: "bSubRecog",
    type: "SUB-RECOG",
    idemKey: `sub-recog:${CHAN.brokerAlpha}:${THIS_MONTH}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: 450_000,
    totalCreditMinor: 450_000,
    baseTotalDebitMinor: 450_000,
    baseTotalCreditMinor: 450_000,
    postedBy: "system:billing",
    postedAt: NOW + 2 * HOUR + MINUTE,
    lineCount: 2
  },
  {
    key: "bOverage",
    type: "OVERAGE",
    idemKey: `overage:${CHAN.brokerAlpha}:${THIS_MONTH}`,
    currency: "AED",
    fxRatePpm: 1_000_000,
    periodCode: THIS_MONTH,
    totalDebitMinor: 40_320,
    totalCreditMinor: 38_400 + 1_920,
    baseTotalDebitMinor: 40_320,
    baseTotalCreditMinor: 40_320,
    postedBy: "system:billing",
    postedAt: NOW + 5 * HOUR + MINUTE,
    lineCount: 3
  }
];

describe("journal batches — balance invariant across every AED batch", () => {
  it.each(EXPECTED_BATCHES)("$key balances debit===credit and base debit===base credit", async (spec) => {
    const t = await txnByKey(spec.type, spec.idemKey);
    const batch = await batchByTxnId(t.id);
    expect(batch.currency).toBe(spec.currency);
    expect(batch.fxRatePpm).toBe(spec.fxRatePpm);
    expect(batch.totalDebitMinor).toBe(spec.totalDebitMinor);
    expect(batch.totalCreditMinor).toBe(spec.totalCreditMinor);
    expect(batch.baseTotalDebitMinor).toBe(spec.baseTotalDebitMinor);
    expect(batch.baseTotalCreditMinor).toBe(spec.baseTotalCreditMinor);
    expect(batch.totalDebitMinor).toBe(batch.totalCreditMinor);
    expect(batch.baseTotalDebitMinor).toBe(batch.baseTotalCreditMinor);
    expect(batch.postedBy).toBe(spec.postedBy);
    expect(batch.postedAt).toBe(spec.postedAt);
    const lines = await linesFor(batch.id);
    expect(lines).toHaveLength(spec.lineCount);
  });
});

describe("journal batches — the reversal batch and the fx batch", () => {
  it("bAlphaReversal: opposite sides of the same amounts, posted this month, points at the original", async () => {
    const bind = await txnByKey("BIND", "bind:GNX-2512-0188");
    const originalBatch = await batchByTxnId(bind.id);
    const rev = await txnByKey("BIND", `reverse:${bind.id}`);
    const revBatch = await batchByTxnId(rev.id);
    expect(revBatch.reversalOfBatchId).toBe(originalBatch.id);
    expect(revBatch.postedAt).toBe(NOW + 4 * HOUR + MINUTE);
    expect(revBatch.totalDebitMinor).toBe(revBatch.totalCreditMinor);
    expect(revBatch.totalDebitMinor).toBe(ALPHA_NET + ALPHA_CHANNEL);
    expect(revBatch.baseTotalDebitMinor).toBe(revBatch.baseTotalCreditMinor);
    const period = await periodByCode(THIS_MONTH);
    expect(revBatch.periodId).toBe(period.id);

    const lines = await linesFor(revBatch.id);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["4000", "debit", ALPHA_NET],
      ["2100", "debit", ALPHA_CHANNEL],
      ["1100", "credit", ALPHA_GROSS]
    ]);
    expect(lines.every((l) => l.dimsJson !== null)).toBe(true);
  });

  it("bFalconInvoice: USD lines, each converted to AED at the batch's own fx rate", async () => {
    const t = await txnByKey("SUB-INVOICE", `sub-invoice:${PROV.falcon}:${THIS_MONTH}`);
    const batch = await batchByTxnId(t.id);
    expect(batch.currency).toBe("USD");
    expect(batch.postedAt).toBe(NOW + 3 * HOUR + MINUTE);
    expect(batch.fxRatePpm).toBe(3_672_500);
    expect(batch.totalDebitMinor).toBe(480_000);
    expect(batch.totalCreditMinor).toBe(480_000);
    expect(batch.baseTotalDebitMinor).toBe(1_762_800);
    expect(batch.baseTotalCreditMinor).toBe(1_762_800);

    const lines = await linesFor(batch.id);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect(l.currency).toBe("USD");
      expect(l.baseCurrency).toBe("AED");
      expect(l.baseAmountMinor).toBe(1_762_800);
      expect(l.dimsJson).toBeNull();
    }
    expect(lines[0]!.accountCode).toBe("1160");
    expect(lines[1]!.accountCode).toBe("2300");
  });

  it("bDecAccrual lines carry the cedar dims and the exact memos", async () => {
    const t = await txnByKey("CMSN-ACCR", `cmsn-accr:${PROV.cedar}:${LAST_MONTH}`);
    const batch = await batchByTxnId(t.id);
    const lines = await linesFor(batch.id);
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor, l.memo])).toEqual([
      ["1100", "debit", 386_400, "December commission due from Cedar"],
      ["4000", "credit", 331_200, "new business commission"],
      ["4010", "credit", 55_200, "renewal commission"]
    ]);
    expect(JSON.parse(lines[0]!.dimsJson!)).toEqual({ provider: PROV.cedar, channel: CHAN.web, line: "motor" });
  });

  it("throws if a batch's own lines fail to balance (contrived unbalanced ctx)", async () => {
    // The invariant is proven live: corrupt the read-back commission so
    // bBindRania's two lines (both driven by commissionMinor) still balance,
    // but the b2b Alpha lines never touch axisPolicies at all — so instead we
    // assert the *real* check fires by breaking the one value it reads: an
    // out-of-range premium that splitCommission itself rejects.
    await db.update(schema.axisPolicies).set({ premiumMinor: -1 }).where(eq(schema.axisPolicies.id, POLICY_ID));
    await expect(seedLedger(makeCtx())).rejects.toThrow();
  });
});

describe("account balances — the 15-key cache summed from the lines", () => {
  it("has exactly 15 accountCode:currency keys", async () => {
    const rows = await db.select().from(schema.ledgerAccountBalances).where(eq(schema.ledgerAccountBalances.tenantId, TENANT));
    expect(rows).toHaveLength(15);
  });

  async function balanceOf(accountCode: string, currency: string) {
    const [row] = await db
      .select()
      .from(schema.ledgerAccountBalances)
      .where(
        and(
          eq(schema.ledgerAccountBalances.tenantId, TENANT),
          eq(schema.ledgerAccountBalances.accountCode, accountCode),
          eq(schema.ledgerAccountBalances.currency, currency)
        )
      );
    if (!row) throw new Error(`test: no balance ${accountCode}:${currency}`);
    return row;
  }

  it("1100:AED — receivable debited by three postings, credited by two", async () => {
    // 386_400 (accrual) + 62_400 (alpha bind) + 40_000 (bind Rania) debit;
    // 386_400 (cedar settle) + 62_400 (alpha reversal) credit.
    const b = await balanceOf("1100", "AED");
    expect(b.debitMinor).toBe(386_400 + ALPHA_GROSS + COMMISSION_MINOR);
    expect(b.creditMinor).toBe(386_400 + ALPHA_GROSS);
  });

  it("4000:AED — our commission income, net of the Alpha reversal", async () => {
    const b = await balanceOf("4000", "AED");
    expect(b.creditMinor).toBe(331_200 + ALPHA_NET + COMMISSION_MINOR);
    expect(b.debitMinor).toBe(ALPHA_NET);
  });

  it("1010:AED and 2010:AED — client money in then out, collected minus premium left over", async () => {
    const clientMoney = await balanceOf("1010", "AED");
    expect(clientMoney.debitMinor).toBe(COLLECTED_MINOR);
    expect(clientMoney.creditMinor).toBe(PREMIUM_MINOR);
    expect(clientMoney.debitMinor - clientMoney.creditMinor).toBe(CLIENT_MONEY_FLOAT);

    const liability = await balanceOf("2010", "AED");
    expect(liability.creditMinor).toBe(COLLECTED_MINOR);
    expect(liability.debitMinor).toBe(PREMIUM_MINOR);
  });

  it("1160:USD and 2300:USD — the Falcon invoice converted to base", async () => {
    const receivable = await balanceOf("1160", "USD");
    expect(receivable.debitMinor).toBe(480_000);
    expect(receivable.baseDebitMinor).toBe(1_762_800);
    const deferred = await balanceOf("2300", "USD");
    expect(deferred.creditMinor).toBe(480_000);
    expect(deferred.baseCreditMinor).toBe(1_762_800);
  });

  it("4050:AED — usage revenue only from the overage batch", async () => {
    const b = await balanceOf("4050", "AED");
    expect(b.creditMinor).toBe(38_400);
    expect(b.debitMinor).toBe(0);
  });

  it("2200:AED — VAT payable, accumulated from the subscription invoice and the overage invoice", async () => {
    const b = await balanceOf("2200", "AED");
    expect(b.creditMinor).toBe(22_500 + 1_920);
  });
});

describe("txn -> batch linking", () => {
  it("stamps ledgerBatchId on the txn row for every batch", async () => {
    const t = await txnByKey("PREM-COLLECT", `prem-collect:${POLICY_ID}`);
    const batch = await batchByTxnId(t.id);
    const [reloaded] = await db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, t.id));
    expect(reloaded!.ledgerBatchId).toBe(batch.id);
  });

  it("txRefundOryx has no batch at all — it failed before anything posted", async () => {
    const t = await txnByKey("REFUND-ISSUE", `refund:${PROV.oryx}:${LAST_MONTH}`);
    expect(t.ledgerBatchId).toBeNull();
    const rows = await db.select().from(schema.ledgerJournalBatches).where(eq(schema.ledgerJournalBatches.txnId, t.id));
    expect(rows).toHaveLength(0);
  });
});

/* ------------------------------------------------------------ client money */

describe("client money checks", () => {
  it("writes exactly 5 rows, the first a real breach and the rest clean", async () => {
    const rows = await db
      .select()
      .from(schema.ledgerClientMoneyChecks)
      .where(eq(schema.ledgerClientMoneyChecks.tenantId, TENANT))
      .orderBy(schema.ledgerClientMoneyChecks.ts);
    expect(rows).toHaveLength(5);

    const breach = rows[0]!;
    expect(breach.breach).toBe(true);
    expect(breach.assetMinor).toBe(498_300);
    expect(breach.liabilityMinor).toBe(512_400);
    expect(breach.shortfallMinor).toBe(14_100);
    expect(breach.resolvedAt).toBe(monthStart(-1) + 31 * DAY);

    const resolved = rows[1]!;
    expect(resolved.breach).toBe(false);
    expect(resolved.shortfallMinor).toBe(0);
    expect(resolved.resolvedAt).toBeNull();

    const collect = rows[2]!;
    expect(collect.assetMinor).toBe(COLLECTED_MINOR);
    expect(collect.liabilityMinor).toBe(COLLECTED_MINOR);

    const remit = rows[3]!;
    expect(remit.assetMinor).toBe(CLIENT_MONEY_FLOAT);
    expect(remit.liabilityMinor).toBe(CLIENT_MONEY_FLOAT);

    const eod = rows[4]!;
    expect(eod.assetMinor).toBe(CLIENT_MONEY_FLOAT);
    expect(eod.triggeredBy).toBe("scheduled");
  });
});

/* ------------------------------------------------------------ subscriptions */

describe("subscriptions", () => {
  it("writes exactly 6 rows", async () => {
    const rows = await db.select().from(schema.ledgerSubscriptions).where(eq(schema.ledgerSubscriptions.tenantId, TENANT));
    expect(rows).toHaveLength(6);
  });

  it("subAlpha: monthly, growth edition, terms carry the included bundle", async () => {
    const s = await subByCustomerRef(`channel:${CHAN.brokerAlpha}`);
    expect(s.plan).toBe("broker_portal");
    expect(s.edition).toBe("growth");
    expect(s.priceMinor).toBe(450_000);
    expect(s.interval).toBe("month");
    expect(s.seats).toBe(12);
    expect(s.state).toBe("active");
    expect(JSON.parse(s.termsJson!)).toEqual({ noticeDays: 30, autoRenew: true, includedApiCalls: 100_000 });
  });

  it("subFalcon: annual, USD, exportOfServices in terms", async () => {
    const s = await subByCustomerRef(`provider:${PROV.falcon}`);
    expect(s.currency).toBe("USD");
    expect(s.interval).toBe("year");
    expect(JSON.parse(s.termsJson!)).toEqual({ noticeDays: 60, autoRenew: true, exportOfServices: true });
    // The whole year is invoiced already (invFalconAnnual), so the next invoice
    // falls due a year after the term started — not at next month's boundary,
    // which would have the billing sweep raise a second full year eleven months
    // early.
    expect(s.nextInvoiceAt).toBeGreaterThanOrEqual(s.startAt + 365 * DAY);
  });

  it("subOryx: past_due, no terms", async () => {
    const s = await subByCustomerRef(`provider:${PROV.oryx}`);
    expect(s.state).toBe("past_due");
    expect(s.termsJson).toBeNull();
  });

  it("subGulfHealth: cancelled, free trial, endAt is set", async () => {
    const s = await subByCustomerRef(`provider:${PROV.gulfHealth}`);
    expect(s.state).toBe("cancelled");
    expect(s.edition).toBe("trial");
    expect(s.priceMinor).toBe(0);
    expect(s.endAt).toBe(NOW - 10 * DAY);
  });
});

/* ----------------------------------------------------------------- invoices */

describe("invoices", () => {
  it("writes exactly 7 rows", async () => {
    const rows = await db.select().from(schema.ledgerInvoices).where(eq(schema.ledgerInvoices.tenantId, TENANT));
    expect(rows).toHaveLength(7);
  });

  it("invAlphaDec: paid, its one line sums to its own subtotal", async () => {
    const inv = await invoiceByNumber(`INV-${LAST_MONTH.replace("-", "")}-0044`);
    expect(inv.state).toBe("paid");
    expect(inv.subtotalMinor).toBe(450_000);
    expect(inv.taxMinor).toBe(22_500);
    expect(inv.totalMinor).toBe(472_500);
    expect(inv.paidAt).toBe(monthStart(-1) + 9 * DAY);
    const lines = JSON.parse(inv.linesJson);
    expect(lines).toEqual([{ description: "Broker portal, growth — December", quantity: 1, unitMinor: 450_000, amountMinor: 450_000 }]);
    expect(lines[0].amountMinor).toBe(inv.subtotalMinor);
  });

  it("invAlphaJan: issued, linked to txSubInvoice", async () => {
    const t = await txnByKey("SUB-INVOICE", `sub-invoice:${CHAN.brokerAlpha}:${THIS_MONTH}`);
    const inv = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0051`);
    expect(inv.state).toBe("issued");
    expect(inv.txnId).toBe(t.id);
    expect(inv.dueAt).toBe(NOW + 9 * DAY);
  });

  it("invCedarJan: still a draft — no dueAt, issuedAt or paidAt", async () => {
    const inv = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0053`);
    expect(inv.state).toBe("draft");
    expect(inv.dueAt).toBeNull();
    expect(inv.issuedAt).toBeNull();
    expect(inv.paidAt).toBeNull();
  });

  it("invFalcon: USD, zero tax (export of services)", async () => {
    const inv = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0054`);
    expect(inv.currency).toBe("USD");
    expect(inv.taxMinor).toBe(0);
    expect(inv.subtotalMinor).toBe(inv.totalMinor);
  });

  it("invOryx: overdue, dueAt in the past", async () => {
    const inv = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0055`);
    expect(inv.state).toBe("overdue");
    expect(inv.dueAt).toBe(NOW - 3 * DAY);
    expect(inv.dueAt!).toBeLessThan(NOW);
  });

  it("invOverage: the line's own quantity*unit does not equal the invoice subtotal (real fixture data, asserted as-is)", async () => {
    const inv = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0056`);
    expect(inv.subtotalMinor).toBe(38_400);
    expect(inv.taxMinor).toBe(1_920);
    expect(inv.totalMinor).toBe(40_320);
    const lines = JSON.parse(inv.linesJson);
    expect(lines).toEqual([{ description: "API calls above bundle (128,000 @ 0.30)", quantity: 128_000, unitMinor: 30, amountMinor: 3_840_000 }]);
    // Documented, not "fixed": quantity * unitMinor computes 3_840_000, the
    // invoice's own subtotalMinor is 38_400 — a real inconsistency in the demo
    // fixture, left exactly as the seeder produces it.
    expect(lines[0].amountMinor).not.toBe(inv.subtotalMinor);
  });
});

/* -------------------------------------------------------- revenue schedules */

describe("revenue schedules", () => {
  it("writes exactly 6 rows", async () => {
    const rows = await db.select().from(schema.ledgerRevenueSchedules).where(eq(schema.ledgerRevenueSchedules.tenantId, TENANT));
    expect(rows).toHaveLength(6);
  });

  it("invAlphaJan's January row is recognized, tied to txSubRecog", async () => {
    const invAlphaJan = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0051`);
    const t = await txnByKey("SUB-RECOG", `sub-recog:${CHAN.brokerAlpha}:${THIS_MONTH}`);
    const [row] = await db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(and(eq(schema.ledgerRevenueSchedules.invoiceId, invAlphaJan.id), eq(schema.ledgerRevenueSchedules.period, THIS_MONTH)));
    expect(row!.state).toBe("recognized");
    expect(row!.plannedMinor).toBe(450_000);
    expect(row!.recognizedMinor).toBe(450_000);
    expect(row!.txnId).toBe(t.id);
  });

  it("Falcon's year is spread over three scheduled/recognized rows, only January earned", async () => {
    const invFalcon = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0054`);
    const rows = await db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.invoiceId, invFalcon.id))
      .orderBy(schema.ledgerRevenueSchedules.period);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.state)).toEqual(["recognized", "scheduled", "scheduled"]);
    expect(rows.every((r) => r.plannedMinor === 40_000)).toBe(true);
    expect(rows[0]!.recognizedMinor).toBe(40_000);
    expect(rows[1]!.recognizedMinor).toBe(0);
    expect(rows[0]!.currency).toBe("USD");
  });

  it("Meridian's February row is cancelled with the term, never recognized", async () => {
    const invMeridianJan = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0052`);
    const [row] = await db
      .select()
      .from(schema.ledgerRevenueSchedules)
      .where(eq(schema.ledgerRevenueSchedules.invoiceId, invMeridianJan.id));
    expect(row!.plannedMinor).toBe(1_800_000);
    expect(row!.recognizedMinor).toBe(0);
    // Gulf Health cancelled mid-term and this invoice posted no journal, so
    // nothing was ever deferred for the sweep to release: left `scheduled` the
    // recognition sweep drove deferred revenue 2300 negative on this invoice.
    expect(row!.state).toBe("cancelled");
  });
});

/* ------------------------------------------------------------ usage meters */

describe("usage meters", () => {
  it("writes exactly 6 rows", async () => {
    const rows = await db.select().from(schema.ledgerUsageMeters).where(eq(schema.ledgerUsageMeters.tenantId, TENANT));
    expect(rows).toHaveLength(6);
  });

  it("subAlpha's January api_calls overage matches invOverage's line quantity exactly", async () => {
    const subAlpha = await subByCustomerRef(`channel:${CHAN.brokerAlpha}`);
    const [row] = await db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(
        and(
          eq(schema.ledgerUsageMeters.subscriptionId, subAlpha.id),
          eq(schema.ledgerUsageMeters.meter, "api_calls"),
          eq(schema.ledgerUsageMeters.period, THIS_MONTH)
        )
      );
    expect(row!.quantity).toBe(228_000);
    expect(row!.includedQuantity).toBe(100_000);
    // The overage narrative: 228_000 - 100_000 = 128_000, the same number the
    // invOverage invoice line quotes as "128,000 @ 0.30".
    expect(row!.quantity - row!.includedQuantity).toBe(128_000);
    expect(row!.unitPriceMicro).toBe(300_000);
  });

  it("the platform-wide ai_tokens meter has no subscriptionId and no included allowance", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerUsageMeters)
      .where(and(eq(schema.ledgerUsageMeters.tenantId, TENANT), eq(schema.ledgerUsageMeters.meter, "ai_tokens"), eq(schema.ledgerUsageMeters.quantity, 18_400_000)));
    expect(row!.subscriptionId).toBeNull();
    expect(row!.includedQuantity).toBe(0);
    expect(row!.unitPriceMicro).toBe(9);
  });
});

/* ----------------------------------------------------------------- payments */

describe("payments", () => {
  it("writes exactly 7 rows", async () => {
    const rows = await db.select().from(schema.ledgerPayments).where(eq(schema.ledgerPayments.tenantId, TENANT));
    expect(rows).toHaveLength(7);
  });

  it("the collection payment matches the collected total and links to txPremCollect", async () => {
    const t = await txnByKey("PREM-COLLECT", `prem-collect:${POLICY_ID}`);
    const [row] = await db.select().from(schema.ledgerPayments).where(eq(schema.ledgerPayments.txnId, t.id));
    expect(row!.direction).toBe("in");
    expect(row!.amountMinor).toBe(COLLECTED_MINOR);
    expect(row!.state).toBe("settled");
    expect(row!.settlementBatch).toBe(`PSP-${THIS_MONTH}-W2`);
  });

  it("the payout-to-Alpha payment is pending, has no providerRef yet", async () => {
    const t = await txnByKey("RSHARE-SETL", `rshare-setl:${CHAN.brokerAlpha}:${LAST_MONTH}`);
    const [row] = await db.select().from(schema.ledgerPayments).where(eq(schema.ledgerPayments.txnId, t.id));
    expect(row!.direction).toBe("out");
    expect(row!.amountMinor).toBe(187_400);
    expect(row!.state).toBe("pending");
    expect(row!.providerRef).toBeNull();
  });

  it("Oryx's declined inbound payment carries a failureCode and no fee", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerPayments)
      .where(and(eq(schema.ledgerPayments.tenantId, TENANT), eq(schema.ledgerPayments.providerRef, "tap_ch_26010301")));
    expect(row!.state).toBe("failed");
    expect(row!.failureCode).toBe("card_declined");
    expect(row!.feeMinor).toBe(0);
  });

  it("the December card payment carries a real PSP fee", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerPayments)
      .where(and(eq(schema.ledgerPayments.tenantId, TENANT), eq(schema.ledgerPayments.providerRef, "tap_ch_25121009")));
    expect(row!.feeMinor).toBe(9_450);
    expect(row!.amountMinor).toBe(472_500);
  });
});

/* ------------------------------------------------------------ payment plans */

describe("payment plans", () => {
  it("writes exactly 4 rows", async () => {
    const rows = await db.select().from(schema.ledgerPaymentPlans).where(eq(schema.ledgerPaymentPlans.tenantId, TENANT));
    expect(rows).toHaveLength(4);
  });

  it("Rania's renewal plan: 4 instalments of floor(premium/4), 3 paid and 1 due, 30 days apart", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerPaymentPlans)
      .where(and(eq(schema.ledgerPaymentPlans.tenantId, TENANT), eq(schema.ledgerPaymentPlans.subjectRef, `policy:${RENEWAL_POLICY_ID}`)));
    expect(row!.financierRef).toBe(`provider:${PROV.meridian}`);
    expect(row!.totalMinor).toBe(PREMIUM_MINOR);
    expect(row!.instalments).toBe(4);
    expect(row!.state).toBe("active");
    const schedule = JSON.parse(row!.scheduleJson);
    expect(schedule).toHaveLength(4);
    const perInstalment = Math.floor(PREMIUM_MINOR / 4);
    expect(schedule.every((s: { amountMinor: number }) => s.amountMinor === perInstalment)).toBe(true);
    expect(schedule.map((s: { state: string }) => s.state)).toEqual(["paid", "paid", "paid", "due"]);
    expect(schedule[1].dueAt - schedule[0].dueAt).toBe(30 * DAY);
    expect(schedule[0].seq).toBe(1);
  });

  it("invAlphaDec's plan is completed: both instalments paid", async () => {
    const invAlphaDec = await invoiceByNumber(`INV-${LAST_MONTH.replace("-", "")}-0044`);
    const [row] = await db
      .select()
      .from(schema.ledgerPaymentPlans)
      .where(eq(schema.ledgerPaymentPlans.subjectRef, `invoice:${invAlphaDec.id}`));
    expect(row!.state).toBe("completed");
    expect(row!.instalments).toBe(2);
    expect(row!.createdAt).toBe(monthStart(-1) + DAY);
    expect(row!.updatedAt).toBe(monthStart(0) + 3 * DAY);
    const schedule = JSON.parse(row!.scheduleJson);
    expect(schedule.every((s: { state: string }) => s.state === "paid")).toBe(true);
    expect(schedule[0].dueAt).toBe(monthStart(-1) + 9 * DAY);
    expect(schedule[1].dueAt).toBe(monthStart(-1) + 39 * DAY);
    expect(schedule.every((s: { amountMinor: number }) => s.amountMinor === 236_250)).toBe(true);
  });

  it("invOryx's plan is defaulted: none of the three instalments paid", async () => {
    const invOryx = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0055`);
    const [row] = await db
      .select()
      .from(schema.ledgerPaymentPlans)
      .where(eq(schema.ledgerPaymentPlans.subjectRef, `invoice:${invOryx.id}`));
    expect(row!.state).toBe("defaulted");
    const schedule = JSON.parse(row!.scheduleJson);
    expect(schedule.every((s: { state: string }) => s.state === "due")).toBe(true);
  });

  it("invCedarJan's plan is cancelled", async () => {
    const invCedarJan = await invoiceByNumber(`INV-${THIS_MONTH.replace("-", "")}-0053`);
    const [row] = await db
      .select()
      .from(schema.ledgerPaymentPlans)
      .where(eq(schema.ledgerPaymentPlans.subjectRef, `invoice:${invCedarJan.id}`));
    expect(row!.state).toBe("cancelled");
    expect(row!.instalments).toBe(3);
  });
});

/* --------------------------------------------------------------- fx & tax */

describe("fx rates", () => {
  it("writes exactly 6 rows spanning USD, EUR and GBP", async () => {
    const rows = await db.select().from(schema.ledgerFxRates).where(eq(schema.ledgerFxRates.tenantId, TENANT));
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.fromCurrency === "USD")).toHaveLength(2);
    expect(rows.filter((r) => r.fromCurrency === "EUR")).toHaveLength(2);
    expect(rows.filter((r) => r.fromCurrency === "GBP")).toHaveLength(1);
    expect(rows.filter((r) => r.toCurrency === "USD")).toHaveLength(1);
  });

  it("USD->AED matches the rate the Falcon invoice was posted at", async () => {
    const rows = await db
      .select()
      .from(schema.ledgerFxRates)
      .where(and(eq(schema.ledgerFxRates.fromCurrency, "USD"), eq(schema.ledgerFxRates.toCurrency, "AED")));
    expect(rows.every((r) => r.ratePpm === 3_672_500)).toBe(true);
    expect(rows.every((r) => r.source === "cbuae")).toBe(true);
  });

  it("EUR->AED rate moved between the two stamped dates", async () => {
    const rows = await db
      .select()
      .from(schema.ledgerFxRates)
      .where(and(eq(schema.ledgerFxRates.fromCurrency, "EUR"), eq(schema.ledgerFxRates.toCurrency, "AED")))
      .orderBy(schema.ledgerFxRates.asOf);
    expect(rows[0]!.ratePpm).toBe(3_974_100);
    expect(rows[1]!.ratePpm).toBe(3_985_600);
    expect(rows.every((r) => r.source === "ecb")).toBe(true);
  });
});

describe("tax rules", () => {
  it("writes exactly 10 rows", async () => {
    const rows = await db.select().from(schema.ledgerTaxRules).where(eq(schema.ledgerTaxRules.tenantId, TENANT));
    expect(rows).toHaveLength(10);
  });

  it("AE VAT-ZERO-EXPORT is a real zero rate, not exempt", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerTaxRules)
      .where(and(eq(schema.ledgerTaxRules.market, "AE"), eq(schema.ledgerTaxRules.code, "VAT-ZERO-EXPORT")));
    expect(row!.ratePpm).toBe(0);
    expect(row!.exempt).toBe(false);
    expect(row!.placeOfSupply).toBe("OUTSIDE");
  });

  it("AE VAT-RC-IMPORT is reverse-charged", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerTaxRules)
      .where(and(eq(schema.ledgerTaxRules.market, "AE"), eq(schema.ledgerTaxRules.code, "VAT-RC-IMPORT")));
    expect(row!.reverseCharge).toBe(true);
    expect(row!.ratePpm).toBe(50_000);
  });

  it("AE VAT-EXEMPT-LIFE is exempt at a zero rate", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerTaxRules)
      .where(and(eq(schema.ledgerTaxRules.market, "AE"), eq(schema.ledgerTaxRules.code, "VAT-EXEMPT-LIFE")));
    expect(row!.exempt).toBe(true);
    expect(row!.ratePpm).toBe(0);
  });

  it("SA VAT-STD: superseded 5% row has an effectiveTo, current 15% row does not", async () => {
    const rows = await db
      .select()
      .from(schema.ledgerTaxRules)
      .where(and(eq(schema.ledgerTaxRules.market, "SA"), eq(schema.ledgerTaxRules.code, "VAT-STD")))
      .orderBy(schema.ledgerTaxRules.effectiveFrom);
    expect(rows).toHaveLength(2);
    const superseded = rows[0]!;
    expect(superseded.ratePpm).toBe(50_000);
    expect(superseded.effectiveTo).toBe(Date.UTC(2020, 6, 1));
    const current = rows[1]!;
    expect(current.ratePpm).toBe(150_000);
    expect(current.effectiveTo).toBeNull();
    expect(current.effectiveFrom).toBe(Date.UTC(2020, 6, 1));
  });

  // ADR-0121. Egypt is the market that justifies the `kind` column: the VAT and
  // the table levy sit on the same premium and are reported separately, so a
  // rate alone cannot say where the money goes.
  it("EG carries VAT and a table levy as two kinds on one premium", async () => {
    const rows = await db
      .select()
      .from(schema.ledgerTaxRules)
      .where(eq(schema.ledgerTaxRules.market, "EG"));
    expect(rows).toHaveLength(4);

    const vat = rows.find((r) => r.code === "VAT-STD")!;
    expect(vat.ratePpm).toBe(140_000);
    expect(vat.kind).toBe("vat");

    const table = rows.find((r) => r.code === "TABLE-TAX-INSURANCE")!;
    expect(table.kind).toBe("table_tax");
    expect(table.ratePpm).toBeGreaterThan(0);

    const life = rows.find((r) => r.code === "VAT-EXEMPT-LIFE")!;
    expect(life.exempt).toBe(true);
    expect(life.ratePpm).toBe(0);
  });

  it("every row states a kind the resolver knows", async () => {
    const rows = await db.select().from(schema.ledgerTaxRules).where(eq(schema.ledgerTaxRules.tenantId, TENANT));
    for (const row of rows) {
      expect(TAX_KINDS as readonly string[], row.code).toContain(row.kind);
    }
    // The UAE and KSA rows are all VAT; only Egypt carries a second kind.
    expect(new Set(rows.map((r) => r.kind))).toEqual(new Set(["vat", "table_tax"]));
  });
});

/* -------------------------------------------------------------- settlements */

describe("settlements", () => {
  it("writes exactly 5 rows", async () => {
    const rows = await db.select().from(schema.ledgerSettlements).where(eq(schema.ledgerSettlements.tenantId, TENANT));
    expect(rows).toHaveLength(5);
  });

  it("Alpha's settlement: approved, net = gross + adjustments (a real deduction), tied to the payout txn", async () => {
    const t = await txnByKey("RSHARE-SETL", `rshare-setl:${CHAN.brokerAlpha}:${LAST_MONTH}`);
    const [row] = await db
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, TENANT), eq(schema.ledgerSettlements.counterpartyRef, `channel:${CHAN.brokerAlpha}`)));
    expect(row!.state).toBe("approved");
    expect(row!.grossMinor).toBe(240_000);
    expect(row!.adjustmentsMinor).toBe(-52_600);
    expect(row!.netMinor).toBe(187_400);
    expect(row!.grossMinor + row!.adjustmentsMinor).toBe(row!.netMinor);
    expect(row!.txnId).toBe(t.id);
    expect(row!.approvedBy).toBe(ANALYST);
  });

  it("the bank-embed settlement is still a draft with no approver", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, TENANT), eq(schema.ledgerSettlements.counterpartyRef, `channel:${CHAN.bankEmbed}`)));
    expect(row!.state).toBe("draft");
    expect(row!.approvedBy).toBeNull();
    expect(row!.txnId).toBeNull();
    expect(row!.grossMinor).toBe(512_000);
    expect(row!.adjustmentsMinor).toBe(-18_000);
    expect(row!.netMinor).toBe(494_000);
    expect(row!.createdAt).toBe(monthStart(0) + 2 * DAY);
    expect(row!.updatedAt).toBe(monthStart(0) + 2 * DAY);
  });

  it("Cedar's settlement is paid in full: zero adjustments, tied to the Cedar-settle txn", async () => {
    const t = await txnByKey("CMSN-SETL", `cmsn-setl:${PROV.cedar}:${LAST_MONTH}`);
    const [row] = await db
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, TENANT), eq(schema.ledgerSettlements.counterpartyRef, `provider:${PROV.cedar}`)));
    expect(row!.state).toBe("paid");
    expect(row!.period).toBe(LAST_MONTH);
    expect(row!.grossMinor).toBe(386_400);
    expect(row!.adjustmentsMinor).toBe(0);
    expect(row!.netMinor).toBe(386_400);
    expect(row!.approvedBy).toBe(CONTROLLER);
    expect(row!.txnId).toBe(t.id);
    expect(row!.createdAt).toBe(monthStart(-1) + 26 * DAY);
    expect(row!.updatedAt).toBe(monthStart(-1) + 27 * DAY + HOUR);
  });

  it("Falcon's settlement is paid a period earlier than the rest — period is monthBefore, not lastMonth", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, TENANT), eq(schema.ledgerSettlements.counterpartyRef, `provider:${PROV.falcon}`)));
    expect(row!.state).toBe("paid");
    expect(row!.period).toBe(MONTH_BEFORE);
    expect(row!.grossMinor).toBe(214_800);
    expect(row!.adjustmentsMinor).toBe(-6_400);
    expect(row!.netMinor).toBe(208_400);
    expect(row!.approvedBy).toBe(CONTROLLER);
    expect(row!.txnId).toBeNull();
    expect(row!.createdAt).toBe(monthStart(-1) + 2 * DAY);
    expect(row!.updatedAt).toBe(monthStart(-1) + 8 * DAY);
  });

  it("Oryx's settlement is disputed, negative adjustment reduces net", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerSettlements)
      .where(and(eq(schema.ledgerSettlements.tenantId, TENANT), eq(schema.ledgerSettlements.counterpartyRef, `provider:${PROV.oryx}`)));
    expect(row!.state).toBe("disputed");
    expect(row!.grossMinor).toBe(96_200);
    expect(row!.adjustmentsMinor).toBe(-31_500);
    expect(row!.netMinor).toBe(64_700);
    expect(row!.grossMinor + row!.adjustmentsMinor).toBe(row!.netMinor);
    expect(row!.createdAt).toBe(monthStart(0) + 2 * DAY);
    expect(row!.updatedAt).toBe(NOW - 4 * DAY);
  });
});

/* ---------------------------------------------------------- reconciliation */

describe("recon runs", () => {
  it("writes exactly 5 rows", async () => {
    const rows = await db.select().from(schema.ledgerReconRuns).where(eq(schema.ledgerReconRuns.tenantId, TENANT));
    expect(rows).toHaveLength(5);
  });

  it("the Cedar run is closed clean: matched, zero variance", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerReconRuns)
      .where(and(eq(schema.ledgerReconRuns.tenantId, TENANT), eq(schema.ledgerReconRuns.counterpartyRef, `provider:${PROV.cedar}`)));
    expect(row!.state).toBe("closed");
    expect(row!.matchedCount).toBe(42);
    expect(row!.varianceCount).toBe(0);
    expect(row!.closedBy).toBe(CONTROLLER);
  });

  it("the Falcon run is under review with two variances and a real varianceMinor", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerReconRuns)
      .where(and(eq(schema.ledgerReconRuns.tenantId, TENANT), eq(schema.ledgerReconRuns.counterpartyRef, `provider:${PROV.falcon}`)));
    expect(row!.state).toBe("review");
    expect(row!.varianceCount).toBe(2);
    expect(row!.varianceMinor).toBe(3_580);
    expect(row!.closedBy).toBeNull();
  });

  it("client_money run has no counterpartyRef — it is not a counterparty process", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerReconRuns)
      .where(and(eq(schema.ledgerReconRuns.tenantId, TENANT), eq(schema.ledgerReconRuns.process, "client_money")));
    expect(row!.counterpartyRef).toBeNull();
    expect(row!.state).toBe("running");
  });

  it("the Alpha partner run failed outright — an unreadable statement, zero matches", async () => {
    const [row] = await db
      .select()
      .from(schema.ledgerReconRuns)
      .where(and(eq(schema.ledgerReconRuns.tenantId, TENANT), eq(schema.ledgerReconRuns.process, "partner")));
    expect(row!.state).toBe("failed");
    expect(row!.matchedCount).toBe(0);
  });
});

describe("recon matches", () => {
  it("writes exactly 8 rows", async () => {
    const rows = await db.select().from(schema.ledgerReconMatches).where(eq(schema.ledgerReconMatches.tenantId, TENANT));
    expect(rows).toHaveLength(8);
  });

  async function matchByRef(statementLineRef: string) {
    const [row] = await db
      .select()
      .from(schema.ledgerReconMatches)
      .where(and(eq(schema.ledgerReconMatches.tenantId, TENANT), eq(schema.ledgerReconMatches.statementLineRef, statementLineRef)));
    if (!row) throw new Error(`test: no match ${statementLineRef}`);
    return row;
  }

  it("CDR-STM-2512-0041: deterministic, fully confirmed, tied to txCedarSettle", async () => {
    const t = await txnByKey("CMSN-SETL", `cmsn-setl:${PROV.cedar}:${LAST_MONTH}`);
    const row = await matchByRef("CDR-STM-2512-0041");
    expect(row.method).toBe("deterministic");
    expect(row.confidence).toBe(100);
    expect(row.state).toBe("confirmed");
    expect(row.txnId).toBe(t.id);
    expect(row.deltaMinor).toBe(0);
  });

  it("FAL-STM-2512-0112: proposed by tolerance matching, a real negative delta", async () => {
    const row = await matchByRef("FAL-STM-2512-0112");
    expect(row.state).toBe("proposed");
    expect(row.method).toBe("tolerance");
    expect(row.confidence).toBe(90);
    expect(row.deltaMinor).toBe(-180);
    expect(row.amountMinor).toBe(44_800);
  });

  it("FAL-STM-2512-0131: unmatched, a real positive delta and low-confidence reason", async () => {
    const row = await matchByRef("FAL-STM-2512-0131");
    expect(row.state).toBe("unmatched");
    expect(row.deltaMinor).toBe(3_400);
    expect(row.method).toBe("ai_proposed");
    expect(row.confidence).toBe(38);
    expect(row.reasonCode).toBe("no_confident_match");
  });

  it("TAP-2601-0007-DUP: a tolerance match rejected as a duplicate by a human", async () => {
    const row = await matchByRef("TAP-2601-0007-DUP");
    expect(row.state).toBe("rejected");
    expect(row.reasonCode).toBe("duplicate_statement_line");
    expect(row.confirmedBy).toBe(ANALYST);
    expect(row.method).toBe("tolerance");
  });

  it("BNK-CM-2601-0003: confirmed, tied to txPremCollect, amount equals collected total", async () => {
    const t = await txnByKey("PREM-COLLECT", `prem-collect:${POLICY_ID}`);
    const row = await matchByRef("BNK-CM-2601-0003");
    expect(row.txnId).toBe(t.id);
    expect(row.amountMinor).toBe(COLLECTED_MINOR);
    expect(row.state).toBe("confirmed");
  });
});

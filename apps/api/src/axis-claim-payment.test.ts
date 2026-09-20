import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/27 F23 / docs/specs/gap-axis-design.md §H task 8. Paying a claim is the
// one AXIS action that moves other people's money out of the door. Three things
// hold it: the gate can never be automated away, one idempotency key buys one
// payment, and the float we were funded is a hard ceiling on what we can pay.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const DAY = 86_400_000;
const exec = { waitUntil() {}, passThroughOnException() {} };
const RISK = { age: 34, sumInsuredMinor: 28_000_000, priorClaims: false, vehicleUse: "private", market: "AE" };

let env: Env;
let database: Db;
let seeded: SeedResult;
let token: string;
/** Funding the float is a ledger action; an AXIS lead holds no ledger permission. */
let controllerToken: string;
let productId: string;
let customerId: string;
let consentId: string;
let approvalSeq = 0;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  as: () => string = () => token
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as()}`, ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : await res.arrayBuffer()) as T };
}

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function login(local: string): Promise<string> {
  const res = ok(await call("POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" }));
  const issued = res.token as string;
  const verified = await call(
    "POST",
    "/v1/auth/mfa/verify",
    { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
    {},
    () => issued
  );
  expect(verified.status).toBe(200);
  return issued;
}

/** Each test automates every gate except the one it is about. */
async function autoApprove(...keys: string[]): Promise<void> {
  const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
  const policy = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
  await database
    .update(schema.tenants)
    .set({ policyJson: JSON.stringify({ ...policy, autoApprove: keys }) })
    .where(eq(schema.tenants.id, seeded.tenantId));
}

/**
 * A claim payment is a payout, so docs/19 §7 forbids the tenant automating it
 * and the only way past the gate is a real decision. Tests that are about the
 * posting rather than the gate grant one up front — a fresh one per payment,
 * because the approval is single-use.
 */
async function grantPayment(claimId: string, amountMinor: number): Promise<void> {
  await database.insert(schema.approvals).values({
    id: `apr_clm_pay_${++approvalSeq}`,
    tenantId: seeded.tenantId,
    subjectRef: `axis_claim_payment:${claimId}`,
    policyKey: "axis.claim_payment",
    module: "axis",
    requestedBy: "user:tester",
    requestedAt: Date.now(),
    decidedBy: "user:approver",
    decision: "approved",
    reason: "test fixture",
    contextJson: JSON.stringify({ amountMinor }),
    decidedAt: Date.now(),
    delegationId: null
  });
}

async function boundPolicy(policyNo: string, startAt: number) {
  const shopped = ok(
    await call("POST", "/v1/dist/quote-requests/shop", {
      productId,
      channelId: seeded.channels.web,
      customerId,
      consentId,
      inputs: RISK,
      currency: "AED"
    }),
    201
  );
  const quoted = (shopped.responses as any[]).filter((r) => r.state === "quoted");
  const best = quoted.slice().sort((a, b) => a.premiumMinor - b.premiumMinor)[0];
  expect(best, "the motor panel returned no quote to bind").toBeTruthy();
  ok(await call("POST", `/v1/dist/quote-requests/${shopped.request.id}/select`, { responseId: best.id }));
  const bound = ok(
    await call("POST", `/v1/axis/quote-responses/${best.id}/bind`, { policyNo, startAt, endAt: startAt + 365 * DAY }),
    201
  );
  return bound.policy.id as string;
}

async function openClaim(policyId: string, claimNo: string, amountMinor: number) {
  const claim = ok(
    await call("POST", "/v1/axis/claims", {
      policyId,
      customerId,
      claimNo,
      incidentAt: Date.now() - DAY,
      reportedAt: Date.now(),
      amountMinor,
      currency: "AED"
    }),
    201
  );
  return (claim.claim ?? claim).id as string;
}

/** Insurer funds the claim float before we pay anyone out of it. */
async function fundFloat(policyId: string, claimId: string, amountMinor: number) {
  return ok(
    await call(
      "POST",
      "/v1/ledger/txn/CLAIM-FUND",
      {
        idempotencyKey: `fund:${claimId}:${amountMinor}`,
        grossMinor: amountMinor,
        subjectRefs: { policy: policyId, claim: claimId },
        args: { amountMinor }
      },
      {},
      () => controllerToken
    ),
    201
  );
}

async function claimRow(claimId: string) {
  return (await database.select().from(schema.axisClaims).where(eq(schema.axisClaims.id, claimId)))[0]!;
}

async function paymentsOf(claimId: string) {
  return database.select().from(schema.axisClaimPayments).where(eq(schema.axisClaimPayments.claimId, claimId));
}

async function txnsFor(claimId: string, type: string) {
  const rows = await database
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, seeded.tenantId), eq(schema.ledgerTxns.type, type)));
  return rows.filter((t) => (t.subjectRefsJson ?? "").includes(claimId));
}

async function legsOf(batchId: string) {
  const legs = await database
    .select()
    .from(schema.ledgerJournalLines)
    .where(eq(schema.ledgerJournalLines.batchId, batchId));
  const debit = legs.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
  const credit = legs.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);
  return { legs, debit, credit };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  token = await login("omar.farouk");
  controllerToken = await login("faisal.omar");

  productId = (await database.select().from(schema.products).where(eq(schema.products.line, "motor")))[0]!.id;
  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
  consentId = customer.consentId!;
}, 120_000);

describe("AXIS claim payment (docs/27 F23)", () => {
  it("a claim payment cannot be auto-approved even on the tenant allowlist", async () => {
    // The tenant asks for it explicitly. docs/19 §7 says no: a payout of client
    // money is dual-control always, and `neverAutoApprove` means the allowlist
    // is not even consulted.
    await autoApprove("axis.bind", "axis.underwriting_referral", "axis.claim_payment", "ledger.claim_payment");
    const policyId = await boundPolicy("POL-CLMPAY-1", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-PAY-1", 400_00);
    await fundFloat(policyId, claimId, 400_00);

    const refused = await call("POST", `/v1/axis/claims/${claimId}/payments`, {
      kind: "indemnity",
      payeeKind: "claimant",
      payeeRef: `customer:${customerId}`,
      amountMinor: 250_00,
      method: "eft"
    });

    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("approval_required");

    // Refused means nothing happened: no payment record, no transaction, and
    // the claim's paid total untouched. An allowlist entry must not leave a
    // half-made payout behind for someone to find and finish.
    expect(await paymentsOf(claimId)).toHaveLength(0);
    expect(await txnsFor(claimId, "CLAIM-PAY")).toHaveLength(0);
    expect((await claimRow(claimId)).paidMinor).toBe(0);

    // It did raise the approval the handler now has to get decided.
    const pending = await database
      .select()
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.tenantId, seeded.tenantId),
          eq(schema.approvals.subjectRef, `axis_claim_payment:${claimId}`)
        )
      );
    expect(pending.map((a) => a.decision)).toEqual(["pending"]);
  });

  it("two payment requests with one idempotency key produce one ledger transaction", async () => {
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-CLMPAY-2", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-PAY-2", 900_00);
    await fundFloat(policyId, claimId, 900_00);
    await grantPayment(claimId, 900_00);

    const payload = {
      kind: "indemnity",
      payeeKind: "repairer",
      payeeRef: "vendor:garage-1",
      amountMinor: 600_00,
      method: "eft"
    };
    const key = { "idempotency-key": "clm-pay-2-once" };

    const first = ok(await call("POST", `/v1/axis/claims/${claimId}/payments`, payload, key), 201);
    const second = ok(await call("POST", `/v1/axis/claims/${claimId}/payments`, payload, key), 200, 201);

    // Same record, same money. A retried request is the same payment, not a
    // second one — the payee is not paid twice because a phone lost signal.
    expect(second.payment.id).toBe(first.payment.id);
    expect(second.txn.id).toBe(first.txn.id);
    expect(await paymentsOf(claimId)).toHaveLength(1);
    expect(await txnsFor(claimId, "CLAIM-PAY")).toHaveLength(1);
    expect((await claimRow(claimId)).paidMinor).toBe(600_00);

    // The posting drains client money rather than our own cash.
    const { legs, debit, credit } = await legsOf(first.txn.ledgerBatchId as string);
    expect(debit).toBe(credit);
    expect(legs.find((l) => l.accountCode === "2010" && l.side === "debit")?.amountMinor).toBe(600_00);
    expect(legs.find((l) => l.accountCode === "1010" && l.side === "credit")?.amountMinor).toBe(600_00);
  });

  it("paid total never exceeds funded float", async () => {
    // docs/19 §11 obligation eleven. Property, run over a spread of amounts:
    // whatever sequence of payments is attempted, the paid total for a claim
    // never rises above what the insurer funded. Paying out client money we do
    // not hold is the failure that closes a broker.
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-CLMPAY-3", Date.now() - 10 * DAY);
    const floatMinor = 1_000_00;

    // Deterministic pseudo-random amounts — a fixed seed keeps a failure
    // reproducible while still walking cases a hand-picked list would miss.
    let s = 0x2f6e2b1;
    const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) % 40 + 1) * 10_00;

    for (let round = 0; round < 6; round++) {
      const claimId = await openClaim(policyId, `CLM-PAY-3-${round}`, floatMinor);
      await fundFloat(policyId, claimId, floatMinor);

      let expected = 0;
      for (let attempt = 0; attempt < 4; attempt++) {
        const amountMinor = next();
        await grantPayment(claimId, amountMinor);
        const res = await call("POST", `/v1/axis/claims/${claimId}/payments`, {
          kind: "interim",
          payeeKind: "claimant",
          payeeRef: `customer:${customerId}`,
          amountMinor,
          method: "eft"
        });

        if (expected + amountMinor <= floatMinor) {
          expect(res.status, `funded payment of ${amountMinor} refused`).toBe(201);
          expected += amountMinor;
        } else {
          expect(res.status, `unfunded payment of ${amountMinor} allowed`).toBe(409);
          expect(String(res.body.detail ?? res.body.title)).toMatch(/float/i);
        }
        expect((await claimRow(claimId)).paidMinor).toBe(expected);
      }
      expect(expected).toBeLessThanOrEqual(floatMinor);
    }
  });
});

describe("AXIS claim recovery (docs/27 F23)", () => {
  it("recovery receipt splits the fee to 4090", async () => {
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-CLMREC-1", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-REC-1", 500_00);

    const opened = ok(
      await call("POST", `/v1/axis/claims/${claimId}/recoveries`, {
        kind: "subrogation",
        counterpartyRef: "insurer:third-party",
        expectedMinor: 300_00
      }),
      201
    );
    expect(opened.recovery.state).toBe("identified");

    const received = ok(
      await call("POST", `/v1/axis/recoveries/${opened.recovery.id}/receipt`, {
        amountMinor: 300_00,
        feeMinor: 30_00
      }),
      201
    );

    // Money in is not ours. The gross lands in client money whole; the handling
    // fee is recognised only in the transfer that takes it out of the client
    // account, because docs/19 §5.2 B refuses income in any batch that debits
    // client money. Design §B.4 wanted one batch — docs/19 wins.
    const receipt = await legsOf(received.txn.ledgerBatchId as string);
    expect(receipt.debit).toBe(receipt.credit);
    expect(receipt.legs.find((l) => l.accountCode === "1010" && l.side === "debit")?.amountMinor).toBe(300_00);
    expect(receipt.legs.find((l) => l.accountCode === "2010" && l.side === "credit")?.amountMinor).toBe(300_00);
    expect(receipt.legs.some((l) => l.accountCode === "4090")).toBe(false);

    const fee = await legsOf(received.feeTxn.ledgerBatchId as string);
    expect(fee.debit).toBe(fee.credit);
    expect(fee.legs.find((l) => l.accountCode === "2010" && l.side === "debit")?.amountMinor).toBe(30_00);
    expect(fee.legs.find((l) => l.accountCode === "1010" && l.side === "credit")?.amountMinor).toBe(30_00);
    expect(fee.legs.find((l) => l.accountCode === "1000" && l.side === "debit")?.amountMinor).toBe(30_00);
    expect(fee.legs.find((l) => l.accountCode === "4090" && l.side === "credit")?.amountMinor).toBe(30_00);

    expect(received.recovery.state).toBe("recovered");
    expect(received.recovery.recoveredMinor).toBe(300_00);
    expect(received.recovery.feeMinor).toBe(30_00);

    // The claim's net cost falls by the recovery — `incurred()` reads this.
    expect((await claimRow(claimId)).recoveredMinor).toBe(300_00);
  });
});

describe("AXIS claim money, read back (§D.3)", () => {
  it("a handler can read the payments and recoveries of one claim", async () => {
    // The claim screen shows what left and what is being chased. Without a read
    // side the desk can only see money by making more of it move.
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-CLMLIST-1", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-LIST-1", 900_00);
    const otherId = await openClaim(policyId, "CLM-LIST-2", 100_00);
    await fundFloat(policyId, claimId, 900_00);
    await grantPayment(claimId, 900_00);

    const paid = ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "indemnity", payeeKind: "repairer", payeeRef: "vendor:garage-2", amountMinor: 700_00, method: "eft" },
        { "idempotency-key": "clm-list-pay" }
      ),
      201
    );
    const opened = ok(
      await call("POST", `/v1/axis/claims/${claimId}/recoveries`, {
        kind: "salvage",
        counterpartyRef: "vendor:salvage-1",
        expectedMinor: 200_00
      }),
      201
    );

    const payments = ok(await call("GET", `/v1/axis/claims/${claimId}/payments`));
    const recoveries = ok(await call("GET", `/v1/axis/claims/${claimId}/recoveries`));

    expect(payments.data.map((p: any) => p.id)).toEqual([paid.payment.id]);
    expect(payments.total).toBe(1);
    expect(recoveries.data.map((r: any) => r.id)).toEqual([opened.recovery.id]);

    // One claim's money, not the desk's. A neighbouring claim reads empty.
    expect(ok(await call("GET", `/v1/axis/claims/${otherId}/payments`)).data).toEqual([]);
    expect(ok(await call("GET", `/v1/axis/claims/${otherId}/recoveries`)).data).toEqual([]);
  });
});

/**
 * docs/27 F23, the residue. The state machine, the reserve history and the
 * CLAIM-PAY recipe all shipped; what never did is the join between them.
 * `transitionClaim` refuses `settling` and `settled` in as many words —
 * "move a claim to settling by requesting a payment, not by transition" — and
 * `requestClaimPayment` then never touches `status`, so both states are
 * unreachable by any path and no claim can ever be settled. `settledMinor` is
 * the same defect in a column: three readers route through it (the reserve
 * advisor's comparables, the fraud scorer's history, customer-360's positions)
 * and nothing after FNOL has ever written it, so every one of them reasons
 * from a permanent null.
 */
describe("AXIS settlement is reachable (docs/27 F23)", () => {
  /**
   * reported -> triage -> assessing -> approved, the hops the desk takes by
   * hand. `approved` is dual-control always (`neverAutoApprove`), so the
   * decision is granted rather than automated — the same shape as
   * `grantPayment`, keyed on the state being moved to.
   */
  async function approveClaim(claimId: string): Promise<void> {
    for (const to of ["triage", "assessing", "approved"]) {
      await database.insert(schema.approvals).values({
        id: `apr_clm_hop_${++approvalSeq}`,
        tenantId: seeded.tenantId,
        subjectRef: `axis_claim_settlement:${claimId}:${to}`,
        policyKey: "axis.claim_settlement",
        module: "axis",
        requestedBy: "user:tester",
        requestedAt: Date.now(),
        decidedBy: "user:approver",
        decision: "approved",
        reason: "test fixture",
        // An approval covers at most the amount it was approved for, and a
        // claim hop is gated at the reserve (or the notified amount).
        contextJson: JSON.stringify({ claimId, to, amountMinor: 10_000_00 }),
        decidedAt: Date.now(),
        delegationId: null
      });
      ok(await call("POST", `/v1/axis/claims/${claimId}/transition`, { to }), 200);
    }
  }

  it("a payment moves an approved claim to settling, and a final payment settles it", async () => {
    await autoApprove("axis.bind", "axis.underwriting_referral", "axis.claim_settlement");
    const policyId = await boundPolicy("POL-CLMSET-1", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-SET-1", 800_00);
    await fundFloat(policyId, claimId, 800_00);
    await approveClaim(claimId);
    expect((await claimRow(claimId)).status).toBe("approved");

    // An interim payment is money in flight, not the end of the claim.
    await grantPayment(claimId, 300_00);
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "interim", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 300_00, method: "eft" },
        { "idempotency-key": "clm-set-1-interim" }
      ),
      201
    );
    const settling = await claimRow(claimId);
    expect(settling.status).toBe("settling");
    // Nothing is agreed while money is still in flight.
    expect(settling.settledMinor).toBeNull();

    // The final payment is the settlement: it ends the claim and freezes what
    // it settled for at the total actually paid.
    await grantPayment(claimId, 200_00);
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "final", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 200_00, method: "eft" },
        { "idempotency-key": "clm-set-1-final" }
      ),
      201
    );
    const settled = await claimRow(claimId);
    expect(settled.status).toBe("settled");
    expect(settled.paidMinor).toBe(500_00);
    expect(settled.settledMinor).toBe(500_00);
  });

  it("the settled figure is frozen: a later expense payment moves paid, not settled", async () => {
    // `settledMinor` answers "what did this claim settle for", which is a
    // historical fact. `paidMinor` keeps moving while the file is open — the
    // reserve advisor compares the two, so they may not be the same column.
    await autoApprove("axis.bind", "axis.underwriting_referral", "axis.claim_settlement");
    const policyId = await boundPolicy("POL-CLMSET-2", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-SET-2", 900_00);
    await fundFloat(policyId, claimId, 900_00);
    await approveClaim(claimId);

    await grantPayment(claimId, 400_00);
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "final", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 400_00, method: "eft" },
        { "idempotency-key": "clm-set-2-final" }
      ),
      201
    );
    expect((await claimRow(claimId)).settledMinor).toBe(400_00);

    await grantPayment(claimId, 50_00);
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "expense", payeeKind: "third_party", payeeRef: "vendor:assessor-1", amountMinor: 50_00, method: "eft" },
        { "idempotency-key": "clm-set-2-expense" }
      ),
      201
    );
    const after = await claimRow(claimId);
    expect(after.paidMinor).toBe(450_00);
    expect(after.settledMinor).toBe(400_00);
    expect(after.status).toBe("settled");
  });

  it("a payment on a claim that is not yet approved leaves the status alone", async () => {
    // The machine has no hop from `assessing` to `settling`, so an interim
    // payment made while the file is still being assessed must not invent one.
    await autoApprove("axis.bind", "axis.underwriting_referral", "axis.claim_settlement");
    const policyId = await boundPolicy("POL-CLMSET-3", Date.now() - 10 * DAY);
    const claimId = await openClaim(policyId, "CLM-SET-3", 600_00);
    await fundFloat(policyId, claimId, 600_00);
    ok(await call("POST", `/v1/axis/claims/${claimId}/transition`, { to: "triage" }), 200);
    ok(await call("POST", `/v1/axis/claims/${claimId}/transition`, { to: "assessing" }), 200);

    await grantPayment(claimId, 100_00);
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "interim", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 100_00, method: "eft" },
        { "idempotency-key": "clm-set-3-interim" }
      ),
      201
    );
    const row = await claimRow(claimId);
    expect(row.status).toBe("assessing");
    expect(row.paidMinor).toBe(100_00);
    expect(row.settledMinor).toBeNull();
  });
});

/**
 * docs/27 F24, the residue. FNOL does resolve cover before the claim exists —
 * `checkCoverage` pins the version, the limits and the excess and records
 * `coverageState` — and that answer then routed nowhere: no engine read the
 * column, so a claim recorded at notification as out of cover, lapsed at the
 * loss or cancelled at the loss could be paid like any other. A check whose
 * result nothing consults is the same defect as no check.
 *
 * Refused at the payment door rather than at FNOL, because a notification of
 * loss is always taken — the decision belongs where the money leaves. Ex gratia
 * is the deliberate exception the system already models, with a gate of its own
 * (`axis.claim_exgratia`), so paying anyway stays possible and stays a decision.
 */
describe("AXIS refuses to pay a claim that was not in cover (docs/27 F24)", () => {
  async function claimOutOfCover(policyId: string, claimNo: string, state: string): Promise<string> {
    const claimId = await openClaim(policyId, claimNo, 500_00);
    await database
      .update(schema.axisClaims)
      .set({ coverageState: state })
      .where(eq(schema.axisClaims.id, claimId));
    return claimId;
  }

  it("a payment on a claim out of cover is refused, naming the state", async () => {
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-COVER-1", Date.now() - 10 * DAY);

    for (const state of ["out_of_cover", "lapsed_at_loss", "cancelled_at_loss"]) {
      const claimId = await claimOutOfCover(policyId, `CLM-COVER-${state}`, state);
      await fundFloat(policyId, claimId, 500_00);
      await grantPayment(claimId, 200_00);

      const res = await call("POST", `/v1/axis/claims/${claimId}/payments`, {
        kind: "indemnity",
        payeeKind: "claimant",
        payeeRef: `customer:${customerId}`,
        amountMinor: 200_00,
        method: "eft"
      });
      expect(res.status, `${state} was paid`).toBe(409);
      expect(String(res.body.detail ?? res.body.title)).toContain(state);

      // Refused means nothing happened, the same as the approval refusal above.
      expect(await paymentsOf(claimId)).toHaveLength(0);
      expect((await claimRow(claimId)).paidMinor).toBe(0);
    }
  });

  it("ex gratia is the way to pay one anyway, and it is still a decision", async () => {
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-COVER-2", Date.now() - 10 * DAY);
    const claimId = await claimOutOfCover(policyId, "CLM-COVER-EXG", "out_of_cover");
    await fundFloat(policyId, claimId, 500_00);

    // Its own gate, not the indemnity one: an ex-gratia payment on a claim that
    // was never covered is precisely the payout a second pair of eyes is for.
    const ungated = await call("POST", `/v1/axis/claims/${claimId}/payments`, {
      kind: "ex_gratia",
      payeeKind: "claimant",
      payeeRef: `customer:${customerId}`,
      amountMinor: 100_00,
      method: "eft"
    });
    expect(ungated.status).toBe(403);
    expect(ungated.body.code).toBe("approval_required");

    await database.insert(schema.approvals).values({
      id: "apr_clm_exgratia_1",
      tenantId: seeded.tenantId,
      subjectRef: `axis_claim_payment:${claimId}`,
      policyKey: "axis.claim_exgratia",
      module: "axis",
      requestedBy: "user:tester",
      requestedAt: Date.now(),
      decidedBy: "user:approver",
      decision: "approved",
      reason: "goodwill",
      contextJson: JSON.stringify({ amountMinor: 100_00 }),
      decidedAt: Date.now(),
      delegationId: null
    });
    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "ex_gratia", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 100_00, method: "eft" },
        { "idempotency-key": "clm-cover-exgratia" }
      ),
      201
    );
    expect((await claimRow(claimId)).paidMinor).toBe(100_00);
  });

  it("an unresolved cover state does not block the desk", async () => {
    // `unknown` is what `checkCoverage` returns when no version answers — the
    // FNOL engine says in as many words that a human decides. Refusing here
    // would turn "we could not tell" into "no".
    await autoApprove("axis.bind", "axis.underwriting_referral");
    const policyId = await boundPolicy("POL-COVER-3", Date.now() - 10 * DAY);
    const claimId = await claimOutOfCover(policyId, "CLM-COVER-UNK", "unknown");
    await fundFloat(policyId, claimId, 500_00);
    await grantPayment(claimId, 150_00);

    ok(
      await call(
        "POST",
        `/v1/axis/claims/${claimId}/payments`,
        { kind: "indemnity", payeeKind: "claimant", payeeRef: `customer:${customerId}`, amountMinor: 150_00, method: "eft" },
        { "idempotency-key": "clm-cover-unknown" }
      ),
      201
    );
    expect((await claimRow(claimId)).paidMinor).toBe(150_00);
  });
});

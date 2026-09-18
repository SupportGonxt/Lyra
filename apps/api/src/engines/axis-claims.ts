import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  canClaimTransition,
  conflict,
  emit,
  gate,
  scoped,
  type ClaimState,
  type Ctx
} from "@lyra/core";
import { buildRecipe, runTxn } from "@lyra/ledger";
import { InstantMs } from "../http.js";

// docs/27 F23 / docs/specs/gap-axis-design.md §H task 8. Paying a claim is the
// only AXIS action that moves other people's money out of the door, so it is
// the only one that carries three locks at once: an approval the tenant cannot
// automate away, one payment per idempotency key, and a hard ceiling at what
// the insurer actually funded. Recoveries are the same money coming back.

type ClaimRow = typeof schema.axisClaims.$inferSelect;
type RecoveryRow = typeof schema.axisClaimRecoveries.$inferSelect;

/** Claims whose file is shut take no more money in either direction. */
const CLOSED_TO_MONEY = new Set(["closed", "withdrawn", "rejected"]);

function assertOpen(claim: ClaimRow, verb: string): void {
  if (CLOSED_TO_MONEY.has(claim.status)) {
    throw conflict(`claim ${claim.id} is ${claim.status} and cannot ${verb}`);
  }
}

/**
 * What the insurer has put behind this claim. Summed from settled CLAIM-FUND
 * transactions rather than a column, because a column is a second copy of the
 * ledger and the two drift the first time a funding is reversed.
 */
async function fundedFloat(ctx: Ctx, claimId: string): Promise<number> {
  const [row] = await ctx.db
    .select({ total: sql<number>`coalesce(sum(${schema.ledgerTxns.grossMinor}), 0)` })
    .from(schema.ledgerTxns)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.type, "CLAIM-FUND"),
        eq(schema.ledgerTxns.state, "settled"),
        sql`json_extract(${schema.ledgerTxns.subjectRefsJson}, '$.claim') = ${claimId}`
      )
    );
  return Number(row?.total ?? 0);
}

/**
 * Cover states in which the claim was, at the moment of the loss, not answered
 * by the contract — `checkCoverage` (engines/axis-fnol.ts) decides them before
 * the claim exists and snapshots the reasoning. `unknown` is deliberately not
 * here: it means no version answered and a human decides, so refusing on it
 * would turn "we could not tell" into "no" (docs/27 F24).
 */
const NOT_IN_COVER = new Set(["out_of_cover", "lapsed_at_loss", "cancelled_at_loss"]);

/**
 * Written as what must NOT pass rather than as a list of what may — the shape
 * dead-seam sightings 8 and 11 both arrived at. A cover state added later is
 * refused until someone decides it is payable, instead of silently paying.
 */
function assertInCover(claim: ClaimRow, kind: ClaimPaymentInput["kind"]): void {
  // Ex gratia is the deliberate exception: a goodwill payment on a claim that
  // was never covered is exactly what it is for, and it carries its own gate
  // (`axis.claim_exgratia`) rather than the indemnity one.
  if (kind === "ex_gratia") return;
  if (NOT_IN_COVER.has(claim.coverageState)) {
    throw conflict(
      `claim ${claim.id} was ${claim.coverageState} at the loss and cannot be paid as ${kind}; ` +
        `pay it ex gratia if that is the decision`
    );
  }
}

/* --------------------------------------------------------------- settlement */

/**
 * The part of the claim machine money owns. `transitionClaim` refuses
 * `settling` and `settled` by hand, in as many words, so that no claim can read
 * as paying without a payment behind it — which makes this the only place
 * either state is ever reached, and made both of them unreachable for as long
 * as the payment path did not take them (docs/27 F23).
 *
 * A payment on an approved claim puts it into `settling`; a `final` payment is
 * the settlement itself. Anything the machine has no hop for pays without
 * moving: there is no route from `assessing` to `settling`, and a payment may
 * not invent one.
 */
const SETTLEMENT_SPINE = ["settling", "settled"] as const;

export function settlementTarget(status: string, kind: ClaimPaymentInput["kind"]): ClaimState | null {
  const target = kind === "final" ? "settled" : "settling";
  if (status === target) return null;
  let at = status;
  for (const to of SETTLEMENT_SPINE) {
    if (at === target) break;
    if (at === to) continue;
    if (!canClaimTransition(at as ClaimState, to)) return null;
    at = to;
  }
  return at === status ? null : (at as ClaimState);
}

/* ------------------------------------------------------------------ payment */

export const ClaimPaymentBody = z.object({
  kind: z.enum(["indemnity", "expense", "interim", "final", "ex_gratia", "excess_refund"]),
  payeeKind: z.enum(["claimant", "repairer", "provider", "third_party", "insurer"]),
  payeeRef: z.string().min(1).max(200),
  amountMinor: z.number().int().positive(),
  method: z.enum(["eft", "cheque", "card", "insurer_direct"]).default("eft"),
  note: z.string().max(500).nullish()
});
export type ClaimPaymentInput = z.infer<typeof ClaimPaymentBody>;

export async function requestClaimPayment(ctx: Ctx, claim: ClaimRow, input: ClaimPaymentInput) {
  assertOpen(claim, "take a payment");
  // Before the ceiling and before the gate, for the same reason the ceiling is:
  // a payment that was never going to be allowed must not spend a decision.
  assertInCover(claim, input.kind);

  // Ceiling first: refusing after the approval is spent would burn a decision
  // on a payment that was never going to be allowed.
  const funded = await fundedFloat(ctx, claim.id);
  if (claim.paidMinor + input.amountMinor > funded) {
    throw conflict(
      `payment of ${input.amountMinor} exceeds the funded float ` +
        `(funded ${funded}, already paid ${claim.paidMinor})`
    );
  }

  // Gated here rather than inside `runTxn` so a refused payment leaves no
  // transaction row at all — an ex-gratia decision that was never taken must
  // not leave a half-made payout behind for someone to find and finish.
  const subjectRef = `axis_claim_payment:${claim.id}`;
  const policyKey = input.kind === "ex_gratia" ? "axis.claim_exgratia" : "axis.claim_payment";
  const approval = await gate(ctx, { policyKey, subjectRef, amountMinor: input.amountMinor });

  const paymentId = newId("clmp", ctx.now);
  const txn = await runTxn(
    ctx,
    {
      type: "CLAIM-PAY",
      idempotencyKey: `axis.claim_pay:${paymentId}`,
      currency: claim.currency,
      grossMinor: input.amountMinor,
      subjectRefs: { policy: claim.policyId, claim: claim.id, payment: paymentId }
    },
    {
      recipe: {
        lines: buildRecipe("CLAIM-PAY", { amountMinor: input.amountMinor, memo: `claim payment ${claim.claimNo}` }),
        currency: claim.currency
      },
      approvalSubjectRef: subjectRef,
      preApproved: true
    }
  );

  const payment: typeof schema.axisClaimPayments.$inferSelect = {
    id: paymentId,
    tenantId: ctx.tenantId,
    claimId: claim.id,
    kind: input.kind,
    payeeKind: input.payeeKind,
    payeeRef: input.payeeRef,
    payeeSealed: null,
    amountMinor: input.amountMinor,
    currency: claim.currency,
    method: input.method,
    txnId: txn.id,
    approvalId: approval?.id ?? null,
    state: "paid",
    failureCode: null,
    requestedBy: actorRef(ctx),
    requestedAt: ctx.now,
    paidAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisClaimPayments).values(payment);

  const paidMinor = claim.paidMinor + input.amountMinor;
  const to = settlementTarget(claim.status, input.kind);
  // `settledMinor` is what the claim settled for — a historical fact, frozen at
  // the total paid when it settles. `paidMinor` keeps moving after that (an
  // assessor's fee lands late), which is exactly why the two are separate
  // columns: the reserve advisor and the fraud scorer compare them.
  const settledMinor = to === "settled" ? paidMinor : claim.settledMinor;
  const after = {
    ...claim,
    paidMinor,
    settledMinor,
    ...(to ? { status: to } : {}),
    lastTxnId: txn.id,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.axisClaims)
    .set({
      paidMinor: after.paidMinor,
      settledMinor: after.settledMinor,
      ...(to ? { status: to } : {}),
      lastTxnId: txn.id,
      updatedAt: ctx.now
    })
    .where(scoped(ctx, schema.axisClaims, eq(schema.axisClaims.id, claim.id)));

  await audit(ctx, { action: "axis.claim.payment", subjectRef: claim.id, before: claim, after });
  if (to) {
    // Audited under the state's own action name because `stateOfAudit`
    // (@lyra/core lifecycle.ts) reads the trail to draw the claim's steps, and
    // a settlement reached by paying is still a step.
    await audit(ctx, { action: `axis.claim.${to}`, subjectRef: claim.id, before: claim, after });
    await emit(ctx, {
      module: "axis",
      type: `axis.claim.${to}`,
      subject: claim.id,
      data: {
        claimId: claim.id,
        policyId: claim.policyId,
        customerId: claim.customerId,
        from: claim.status,
        to,
        paymentId,
        settledMinor: after.settledMinor,
        currency: claim.currency
      }
    });
  }
  await emit(ctx, {
    module: "axis",
    type: "axis.claim.paid",
    subject: claim.id,
    data: {
      claimId: claim.id,
      policyId: claim.policyId,
      paymentId,
      kind: input.kind,
      amountMinor: input.amountMinor,
      currency: claim.currency,
      paidMinor: after.paidMinor
    }
  });
  return { payment, txn, claim: after };
}

/* ----------------------------------------------------------------- recovery */

export const RecoveryOpenBody = z.object({
  kind: z.enum(["subrogation", "salvage", "excess", "reinsurance", "third_party"]),
  counterpartyRef: z.string().max(200).nullish(),
  expectedMinor: z.number().int().nonnegative().default(0),
  nextActionAt: InstantMs.nullish(),
  /** 0-100 likelihood of recovering. AI-scored later; hand-set on open. */
  prospects: z.number().int().min(0).max(100).nullish()
});
export type RecoveryOpenInput = z.infer<typeof RecoveryOpenBody>;

export async function openRecovery(ctx: Ctx, claim: ClaimRow, input: RecoveryOpenInput) {
  assertOpen(claim, "open a recovery");

  const recoveryId = newId("rcv", ctx.now);
  const txn = await runTxn(ctx, {
    type: "RECOVERY-OPEN",
    idempotencyKey: `axis.recovery_open:${recoveryId}`,
    currency: claim.currency,
    subjectRefs: { policy: claim.policyId, claim: claim.id, recovery: recoveryId }
  });

  const recovery: RecoveryRow = {
    id: recoveryId,
    tenantId: ctx.tenantId,
    claimId: claim.id,
    kind: input.kind,
    counterpartyRef: input.counterpartyRef ?? null,
    expectedMinor: input.expectedMinor,
    recoveredMinor: 0,
    feeMinor: 0,
    currency: claim.currency,
    state: "identified",
    nextActionAt: input.nextActionAt ?? null,
    prospects: input.prospects ?? null,
    txnId: txn.id,
    approvalId: null,
    openedBy: actorRef(ctx),
    openedAt: ctx.now,
    closedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisClaimRecoveries).values(recovery);

  await audit(ctx, { action: "axis.claim.recovery_opened", subjectRef: claim.id, after: recovery });
  await emit(ctx, {
    module: "axis",
    type: "axis.claim.recovery_opened",
    subject: claim.id,
    data: { claimId: claim.id, recoveryId, kind: input.kind, expectedMinor: input.expectedMinor }
  });
  return { recovery, txn };
}

export const RecoveryReceiptBody = z.object({
  amountMinor: z.number().int().positive(),
  /** Our handling fee, kept out of the amount owed on to the insurer. */
  feeMinor: z.number().int().nonnegative().default(0),
  note: z.string().max(500).nullish()
});
export type RecoveryReceiptInput = z.infer<typeof RecoveryReceiptBody>;

export async function receiveRecovery(ctx: Ctx, recovery: RecoveryRow, input: RecoveryReceiptInput) {
  if (recovery.state === "written_off" || recovery.state === "abandoned") {
    throw conflict(`recovery ${recovery.id} is ${recovery.state}`);
  }
  const claim = await claimOf(ctx, recovery);

  if (input.feeMinor > input.amountMinor) throw conflict("recovery fee exceeds the amount recovered");
  const memo = `recovery ${recovery.kind} ${claim.claimNo}`;
  const seq = recovery.recoveredMinor + input.amountMinor;

  // Gross first, into client money. The fee cannot ride along in this batch:
  // docs/19 §5.2 B refuses income recognition in any batch that debits the
  // client-money asset, because the money is not ours until it leaves.
  const txn = await runTxn(
    ctx,
    {
      type: "RECOVERY-RECEIPT",
      idempotencyKey: `axis.recovery_receipt:${recovery.id}:${seq}`,
      currency: recovery.currency,
      grossMinor: input.amountMinor,
      subjectRefs: { policy: claim.policyId, claim: claim.id, recovery: recovery.id }
    },
    {
      recipe: {
        lines: buildRecipe("RECOVERY-RECEIPT", { amountMinor: input.amountMinor, memo }),
        currency: recovery.currency
      }
    }
  );

  // Then the handling fee out of client money into own funds — the one
  // legitimate route, and the only batch in which we recognise the income.
  const feeTxn =
    input.feeMinor > 0
      ? await runTxn(
          ctx,
          {
            type: "RECOVERY-FEE",
            idempotencyKey: `axis.recovery_fee:${recovery.id}:${seq}`,
            currency: recovery.currency,
            grossMinor: input.feeMinor,
            subjectRefs: { policy: claim.policyId, claim: claim.id, recovery: recovery.id }
          },
          {
            recipe: {
              lines: buildRecipe("RECOVERY-FEE", {
                amountMinor: input.feeMinor,
                grossMinor: input.feeMinor,
                memo: `${memo} fee`
              }),
              currency: recovery.currency
            }
          }
        )
      : null;

  const after: RecoveryRow = {
    ...recovery,
    recoveredMinor: recovery.recoveredMinor + input.amountMinor,
    feeMinor: recovery.feeMinor + input.feeMinor,
    state: "recovered",
    txnId: txn.id,
    closedAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.axisClaimRecoveries)
    .set({
      recoveredMinor: after.recoveredMinor,
      feeMinor: after.feeMinor,
      state: after.state,
      txnId: txn.id,
      closedAt: ctx.now,
      updatedAt: ctx.now
    })
    .where(scoped(ctx, schema.axisClaimRecoveries, eq(schema.axisClaimRecoveries.id, recovery.id)));

  // The claim's net cost falls by what came back — `incurred()` reads this.
  await ctx.db
    .update(schema.axisClaims)
    .set({ recoveredMinor: claim.recoveredMinor + input.amountMinor, updatedAt: ctx.now })
    .where(scoped(ctx, schema.axisClaims, eq(schema.axisClaims.id, claim.id)));

  await audit(ctx, { action: "axis.claim.recovery_received", subjectRef: claim.id, before: recovery, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.claim.recovery_received",
    subject: claim.id,
    data: {
      claimId: claim.id,
      recoveryId: recovery.id,
      amountMinor: input.amountMinor,
      feeMinor: input.feeMinor,
      currency: recovery.currency
    }
  });
  return { recovery: after, txn, feeTxn };
}

export const RecoveryWriteOffBody = z.object({
  reasonCode: z.string().min(1).max(64),
  note: z.string().max(500).nullish()
});
export type RecoveryWriteOffInput = z.infer<typeof RecoveryWriteOffBody>;

/** Pursuit abandoned. The outstanding expectation becomes a cost we carry. */
export async function writeOffRecovery(ctx: Ctx, recovery: RecoveryRow, input: RecoveryWriteOffInput) {
  if (recovery.state === "recovered" || recovery.state === "written_off") {
    throw conflict(`recovery ${recovery.id} is ${recovery.state}`);
  }
  const outstanding = recovery.expectedMinor - recovery.recoveredMinor;
  if (outstanding <= 0) throw conflict(`recovery ${recovery.id} has nothing outstanding to write off`);
  const claim = await claimOf(ctx, recovery);

  const subjectRef = `axis_recovery_writeoff:${recovery.id}`;
  const approval = await gate(ctx, { policyKey: "axis.recovery_writeoff", subjectRef, amountMinor: outstanding });

  const txn = await runTxn(
    ctx,
    {
      type: "RECOVERY-WRITEOFF",
      idempotencyKey: `axis.recovery_writeoff:${recovery.id}`,
      currency: recovery.currency,
      grossMinor: outstanding,
      subjectRefs: { policy: claim.policyId, claim: claim.id, recovery: recovery.id }
    },
    {
      recipe: {
        lines: buildRecipe("RECOVERY-WRITEOFF", { amountMinor: outstanding, memo: input.reasonCode }),
        currency: recovery.currency
      },
      approvalSubjectRef: subjectRef,
      preApproved: true
    }
  );

  const after: RecoveryRow = {
    ...recovery,
    state: "written_off",
    approvalId: approval?.id ?? null,
    txnId: txn.id,
    closedAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.axisClaimRecoveries)
    .set({
      state: after.state,
      approvalId: after.approvalId,
      txnId: txn.id,
      closedAt: ctx.now,
      updatedAt: ctx.now
    })
    .where(scoped(ctx, schema.axisClaimRecoveries, eq(schema.axisClaimRecoveries.id, recovery.id)));

  await audit(ctx, { action: "axis.claim.recovery_written_off", subjectRef: claim.id, before: recovery, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.claim.recovery_written_off",
    subject: claim.id,
    data: { claimId: claim.id, recoveryId: recovery.id, amountMinor: outstanding, reasonCode: input.reasonCode }
  });
  return { recovery: after, txn };
}

/* --------------------------------------------------------------- read side */

/** What has left, newest first — the panel §D.3 draws under the claim. */
export async function listClaimPayments(ctx: Ctx, claimId: string) {
  return ctx.db
    .select()
    .from(schema.axisClaimPayments)
    .where(scoped(ctx, schema.axisClaimPayments, eq(schema.axisClaimPayments.claimId, claimId)))
    .orderBy(desc(schema.axisClaimPayments.requestedAt));
}

/** What is being chased back, newest first. */
export async function listClaimRecoveries(ctx: Ctx, claimId: string) {
  return ctx.db
    .select()
    .from(schema.axisClaimRecoveries)
    .where(scoped(ctx, schema.axisClaimRecoveries, eq(schema.axisClaimRecoveries.claimId, claimId)))
    .orderBy(desc(schema.axisClaimRecoveries.openedAt));
}

async function claimOf(ctx: Ctx, recovery: RecoveryRow): Promise<ClaimRow> {
  const [claim] = await ctx.db
    .select()
    .from(schema.axisClaims)
    .where(scoped(ctx, schema.axisClaims, eq(schema.axisClaims.id, recovery.claimId)));
  if (!claim) throw conflict(`recovery ${recovery.id} points at a missing claim`);
  return claim;
}

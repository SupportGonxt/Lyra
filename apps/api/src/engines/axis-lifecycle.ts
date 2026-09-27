import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema, PaymentPlanJson } from "@lyra/db";
import {
  assertNotScreenedOut,
  actorRef,
  assertPolicyTransition,
  audit,
  badRequest,
  conflict,
  emit,
  gate,
  isPolicyState,
  quoteEndorsement,
  scoped,
  type Ctx,
  type Envelope
} from "@lyra/core";
import { autoApprovable, buildRecipe, runTxn } from "@lyra/ledger";
import { SWEEP_MAX } from "./sweep.js";
import { InstantMs } from "../http.js";

type PolicyRow = typeof schema.axisPolicies.$inferSelect;
type TxnRow = Awaited<ReturnType<typeof runTxn>>;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------ shared */
// docs/27 F5 part 2 / docs/specs/gap-axis-design.md §B.1. The ways cover stops.
// Cancellation and NTU are requests; inception, expiry and lapse are clock
// events the scheduler fires. All five are transactions rather than column
// writes, because `runTxn` is the only writer that gives an idempotent,
// audited, reversible state hop — a mis-fired sweep has to be undoable.

function hop(policy: PolicyRow, to: Parameters<typeof assertPolicyTransition>[1]): void {
  if (!isPolicyState(policy.status)) throw conflict(`policy is in unknown state ${policy.status}`);
  assertPolicyTransition(policy.status, to);
}

async function effectiveVersion(ctx: Ctx, policyId: string) {
  const [row] = await ctx.db
    .select()
    .from(schema.axisPolicyVersions)
    .where(
      scoped(
        ctx,
        schema.axisPolicyVersions,
        and(eq(schema.axisPolicyVersions.policyId, policyId), eq(schema.axisPolicyVersions.state, "effective"))
      )
    );
  return row;
}

/** One head write for every terminal hop, so the stamped columns stay together. */
async function stampHead(ctx: Ctx, policy: PolicyRow, stamp: Partial<PolicyRow>): Promise<PolicyRow> {
  const set = { ...stamp, updatedAt: ctx.now };
  await ctx.db
    .update(schema.axisPolicies)
    .set(set)
    .where(scoped(ctx, schema.axisPolicies, eq(schema.axisPolicies.id, policy.id)));
  return { ...policy, ...set };
}

/* ----------------------------------------------------------- cancellation */

export const CancelBody = z.object({
  /** Defaults to now. Forward-dating is normal: notice periods are contractual. */
  effectiveAt: InstantMs.optional(),
  reasonCode: z.string().min(1).max(64),
  /** `none` = forfeited premium: cover ends, the customer gets nothing back. */
  refundMethod: z.enum(["credit", "bank", "none"]).default("credit"),
  note: z.string().max(500).nullish()
});
export type CancelInput = z.infer<typeof CancelBody>;

/**
 * Pro-rata cancellation is an endorsement to a nil premium: the same arithmetic
 * decides what is unearned, so there is one pricing function for both rather
 * than a second one that can drift from it (§B.2).
 */
export async function priceCancellation(ctx: Ctx, policy: PolicyRow, input: CancelInput) {
  hop(policy, "cancelled");
  const current = await effectiveVersion(ctx, policy.id);
  if (!current) throw conflict("policy has no effective version to cancel");

  const effectiveAt = input.effectiveAt ?? ctx.now;
  // Equal to `effectiveFrom` would leave a zero-length interval, which §C.2
  // forbids — and cancelling a contract from its own start date is NTU, a
  // different verb with a different money story.
  if (effectiveAt <= current.effectiveFrom) {
    throw badRequest("cancelling from inception is not-taken-up; use POST /ntu");
  }
  if (effectiveAt >= policy.endAt) throw badRequest("effectiveAt must fall inside the remaining term");

  const quote = quoteEndorsement({
    current: { premiumMinor: current.premiumMinor, taxMinor: current.taxMinor, commissionMinor: current.commissionMinor },
    term: { startAt: policy.startAt, endAt: policy.endAt },
    effectiveFrom: effectiveAt,
    premiumMinor: 0
  });

  return {
    current,
    effectiveAt,
    quote,
    // Only the unearned share comes back; the days already on risk were earned.
    clawbackMinor: -quote.commissionChargeMinor,
    refundMinor: input.refundMethod === "none" ? 0 : quote.refundMinor
  };
}

export async function cancelPolicy(ctx: Ctx, policy: PolicyRow, input: CancelInput) {
  const { current, effectiveAt, clawbackMinor, refundMinor } = await priceCancellation(ctx, policy, input);
  const subjectRef = `axis_cancel:${policy.id}`;

  // Both gates run before the first write: settling the clawback and then
  // failing the refund approval would leave money posted against a contract
  // that is still on risk.
  await gate(ctx, { policyKey: "axis.cancel", subjectRef, amountMinor: refundMinor });
  if (refundMinor > 0) {
    if (!autoApprovable("REFUND-ISSUE") && ctx.policy.autoApprove.includes("ledger.refund")) {
      throw conflict("REFUND-ISSUE may not be auto-approved (docs/19 §7)");
    }
    await gate(ctx, { policyKey: "ledger.refund", subjectRef: `${subjectRef}:refund`, amountMinor: refundMinor });
  }

  // ponytail: a cancellation on the last day of the term claws nothing back, and
  // `buildRecipe` refuses a zero-value batch. No journal, no CANCEL row — the
  // status hop below still happens.
  let txn: TxnRow | null = null;
  if (clawbackMinor > 0) {
    txn = await runTxn(
      ctx,
      {
        type: "CANCEL",
        idempotencyKey: `axis.cancel:${policy.id}`,
        currency: policy.currency,
        grossMinor: refundMinor,
        subjectRefs: { policy: policy.id }
      },
      {
        recipe: { lines: buildRecipe("CANCEL", { amountMinor: clawbackMinor }), currency: policy.currency },
        approvalSubjectRef: subjectRef,
        preApproved: true
      }
    );
  }
  let refundTxn: TxnRow | null = null;
  if (refundMinor > 0) {
    refundTxn = await runTxn(
      ctx,
      {
        type: "REFUND-ISSUE",
        idempotencyKey: `axis.cancel.refund:${policy.id}`,
        currency: policy.currency,
        grossMinor: refundMinor,
        ...(txn ? { parentTxnId: txn.id } : {}),
        subjectRefs: { policy: policy.id }
      },
      {
        recipe: { lines: buildRecipe("REFUND-ISSUE", { amountMinor: refundMinor }), currency: policy.currency },
        approvalSubjectRef: `${subjectRef}:refund`,
        preApproved: true
      }
    );
  }

  // §C.2: cancellation truncates the effective version rather than appending
  // one. A cancellation version would be zero-length, and superseding this row
  // without a successor would leave the contract with no effective version.
  await ctx.db
    .update(schema.axisPolicyVersions)
    .set({ effectiveTo: effectiveAt, reasonCode: input.reasonCode, updatedAt: ctx.now })
    .where(scoped(ctx, schema.axisPolicyVersions, eq(schema.axisPolicyVersions.id, current.id)));

  const after = await stampHead(ctx, policy, {
    status: "cancelled",
    cancelledAt: ctx.now,
    cancelEffectiveAt: effectiveAt,
    cancelReasonCode: input.reasonCode,
    statusReason: input.note ?? input.reasonCode,
    ...(txn ? { lastTxnId: txn.id } : {})
  });

  await audit(ctx, { action: "axis.policy.cancel", subjectRef: policy.id, before: policy, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.cancelled",
    subject: policy.id,
    data: {
      policyId: policy.id,
      customerId: policy.customerId,
      effectiveAt,
      reasonCode: input.reasonCode,
      refundMinor,
      clawbackMinor,
      currency: policy.currency
    }
  });
  return { policy: after, txn, refundTxn, refundMinor, clawbackMinor, effectiveAt };
}

/* ------------------------------------------------------------- not taken up */

export const NtuBody = z.object({
  reasonCode: z.string().min(1).max(64),
  /** Premium already banked, if any. Comes straight back — nothing was earned. */
  collectedMinor: z.number().int().nonnegative().default(0),
  note: z.string().max(500).nullish()
});
export type NtuInput = z.infer<typeof NtuBody>;

/**
 * The contract never went on risk, so there is no pro-rata: the whole
 * commission is unearned and the whole collected premium goes back. The state
 * machine already refuses NTU on an `active` policy, so "before inception" needs
 * no second check here.
 */
export async function ntuPolicy(ctx: Ctx, policy: PolicyRow, input: NtuInput) {
  hop(policy, "ntu");

  const refundMinor = input.collectedMinor;
  if (refundMinor > 0) {
    if (!autoApprovable("REFUND-ISSUE") && ctx.policy.autoApprove.includes("ledger.refund")) {
      throw conflict("REFUND-ISSUE may not be auto-approved (docs/19 §7)");
    }
    await gate(ctx, { policyKey: "ledger.refund", subjectRef: `axis_ntu:${policy.id}:refund`, amountMinor: refundMinor });
  }

  // NTU itself moves no money — unwinding a contract is not a payment. What
  // already moved comes back as children, so each leg reverses on its own.
  const txn = await runTxn(
    ctx,
    {
      type: "NTU",
      idempotencyKey: `axis.ntu:${policy.id}`,
      currency: policy.currency,
      grossMinor: refundMinor,
      subjectRefs: { policy: policy.id }
    },
    { approvalSubjectRef: `axis_ntu:${policy.id}` }
  );

  let clawbackTxn: TxnRow | null = null;
  if (policy.commissionMinor > 0) {
    clawbackTxn = await runTxn(
      ctx,
      {
        type: "CMSN-CLAWBACK",
        idempotencyKey: `axis.ntu.clawback:${policy.id}`,
        currency: policy.currency,
        grossMinor: policy.commissionMinor,
        parentTxnId: txn.id,
        subjectRefs: { policy: policy.id }
      },
      {
        recipe: {
          lines: buildRecipe("CMSN-CLAWBACK", { amountMinor: policy.commissionMinor }),
          currency: policy.currency
        }
      }
    );
  }
  let refundTxn: TxnRow | null = null;
  if (refundMinor > 0) {
    refundTxn = await runTxn(
      ctx,
      {
        type: "REFUND-ISSUE",
        idempotencyKey: `axis.ntu.refund:${policy.id}`,
        currency: policy.currency,
        grossMinor: refundMinor,
        parentTxnId: txn.id,
        subjectRefs: { policy: policy.id }
      },
      {
        recipe: { lines: buildRecipe("REFUND-ISSUE", { amountMinor: refundMinor }), currency: policy.currency },
        approvalSubjectRef: `axis_ntu:${policy.id}:refund`,
        preApproved: true
      }
    );
  }

  // A contract that never started grows no version history: version 1 stays
  // exactly as issued, and the head status is what says it never took effect.
  const after = await stampHead(ctx, policy, {
    status: "ntu",
    cancelReasonCode: input.reasonCode,
    statusReason: input.note ?? input.reasonCode,
    lastTxnId: txn.id
  });

  await audit(ctx, { action: "axis.policy.ntu", subjectRef: policy.id, before: policy, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.ntu",
    subject: policy.id,
    data: {
      policyId: policy.id,
      customerId: policy.customerId,
      reasonCode: input.reasonCode,
      clawbackMinor: policy.commissionMinor,
      refundMinor,
      currency: policy.currency
    }
  });
  return { policy: after, txn, clawbackTxn, refundTxn };
}

/* ------------------------------------------------------------ reinstatement */

export const ReinstateBody = z.object({
  /** Premium collected to clear the arrears. Drives the commission re-accrual. */
  arrearsMinor: z.number().int().nonnegative().default(0),
  note: z.string().max(500).nullish()
});
export type ReinstateInput = z.infer<typeof ReinstateBody>;

export async function reinstatePolicy(ctx: Ctx, policy: PolicyRow, input: ReinstateInput) {
  await assertNotScreenedOut(ctx, policy.customerId);
  hop(policy, "active");

  // LAPSE reverses nothing (⊘), so reinstatement must not re-credit the full
  // term's commission — only the share the arrears payment earns.
  const commissionMinor =
    policy.premiumMinor > 0 ? Math.round((policy.commissionMinor * input.arrearsMinor) / policy.premiumMinor) : 0;

  // Gated here rather than inside `runTxn` so a refused reinstatement leaves no
  // transaction row at all: cover that is still off risk must look untouched.
  const subjectRef = `axis_reinstate:${policy.id}`;
  await gate(ctx, { policyKey: "axis.reinstate", subjectRef, amountMinor: input.arrearsMinor });

  let txn: TxnRow | null = null;
  if (commissionMinor > 0) {
    txn = await runTxn(
      ctx,
      {
        type: "REINSTATE",
        idempotencyKey: `axis.reinstate:${policy.id}:${policy.lapsedAt ?? 0}`,
        currency: policy.currency,
        grossMinor: input.arrearsMinor,
        subjectRefs: { policy: policy.id }
      },
      {
        recipe: { lines: buildRecipe("REINSTATE", { grossMinor: commissionMinor }), currency: policy.currency },
        approvalSubjectRef: subjectRef,
        preApproved: true
      }
    );
  }

  const after = await stampHead(ctx, policy, {
    status: "active",
    lapsedAt: null,
    statusReason: input.note ?? "reinstated",
    ...(txn ? { lastTxnId: txn.id } : {})
  });

  // The arrears that cured the lapse also cured the financing plan's dunning
  // streak. A plan left `defaulted` is out of the premium-financing sweep for
  // good, so cover would go back on risk with the remaining instalments
  // silently abandoned. Legacy rows carry a `policy:`-prefixed subjectRef.
  const planFilter = scoped(
    ctx,
    schema.ledgerPaymentPlans,
    and(
      inArray(schema.ledgerPaymentPlans.subjectRef, [policy.id, `policy:${policy.id}`]),
      eq(schema.ledgerPaymentPlans.state, "defaulted")
    )
  );
  // Read before the update: the prior missedStreak is the evidence of how many
  // refused attempts were forgiven, and it is gone the moment the row is reset.
  const revived = await ctx.db.select().from(schema.ledgerPaymentPlans).where(planFilter);
  await ctx.db
    .update(schema.ledgerPaymentPlans)
    .set({ state: "active", missedStreak: 0, updatedAt: ctx.now })
    .where(planFilter);

  await audit(ctx, { action: "axis.policy.reinstate", subjectRef: policy.id, before: policy, after });

  // The plan reset gets its own audit row, keyed on the plan. Folded into the
  // policy's row it would be invisible to anyone auditing the plan, which is
  // where the money is: the sweep resumes debiting this customer tomorrow.
  //
  // `missedPaymentId` on the already-`missed` schedule rows is deliberately NOT
  // cleared. It is not stale bookkeeping — it is what stops the sweep
  // re-counting those rows. The newest payment for each of them is still the
  // refused one, so a cleared stamp reads as a fresh miss on the very next tick
  // and re-defaults the plan this just revived.
  for (const plan of revived) {
    await audit(ctx, {
      action: "ledger.financing.plan.reinstate",
      subjectRef: plan.id,
      before: plan,
      after: {
        ...plan,
        state: "active",
        missedStreak: 0,
        updatedAt: ctx.now,
        reason: input.note ?? "reinstated",
        policyId: policy.id
      }
    });
  }
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.reinstated",
    subject: policy.id,
    data: {
      policyId: policy.id,
      customerId: policy.customerId,
      arrearsMinor: input.arrearsMinor,
      commissionMinor,
      currency: policy.currency
    }
  });
  return { policy: after, txn, commissionMinor };
}

/* ------------------------------------------------------------------- lapse */

export const LapseBody = z.object({
  /** Which instalment went unpaid — also the idempotency discriminator. */
  missedSeq: z.number().int().nonnegative().default(0),
  reason: z.string().min(1).max(200).default("instalment unpaid past grace")
});

export async function lapsePolicy(ctx: Ctx, policy: PolicyRow, missedSeq: number, reason: string) {
  hop(policy, "lapsed");
  const txn = await runTxn(ctx, {
    type: "LAPSE",
    idempotencyKey: `axis.lapse:${policy.id}:${missedSeq}`,
    currency: policy.currency,
    subjectRefs: { policy: policy.id }
  });

  const after = await stampHead(ctx, policy, { status: "lapsed", lapsedAt: ctx.now, statusReason: reason, lastTxnId: txn.id });

  await audit(ctx, { action: "axis.policy.lapse", subjectRef: policy.id, before: policy, after });
  const data = {
    policyId: policy.id,
    customerId: policy.customerId,
    missedSeq,
    reason,
    endAt: policy.endAt,
    currency: policy.currency
  };
  await emit(ctx, { module: "axis", type: "axis.policy.lapsed", subject: policy.id, data });
  // CLAUDE.md §6: ORBIT learns a renewal died from the bus, never from a call.
  await emit(ctx, { module: "axis", type: "orbit.renewal.lost", subject: policy.id, data });
  return { policy: after, txn };
}

/** Task 5's dunning sweep crossing DUNNING_LAPSE_THRESHOLD feeds the same
 * lapse cascade as a missed instalment on a plain payment plan — the event
 * bus is the only coupling to premium-financing.ts (CLAUDE.md §6). */
export async function onFinancingLapseDue(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as { policyId: string; planId: string; missedStreak: number; missedSeq: number };
  const [policy] = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(scoped(ctx, schema.axisPolicies, eq(schema.axisPolicies.id, data.policyId)));
  if (!policy) return; // policy already gone (deleted/merged) — nothing to lapse
  // POLICY_TRANSITIONS allows only active -> lapsed, so any other status makes
  // lapsePolicy throw a conflict the queue cannot resolve: consume() would burn
  // six retries and dead-letter an event whose work is genuinely moot
  // (cancelled, expired, or already lapsed by a concurrent path).
  if (policy.status !== "active") return;

  await lapsePolicy(ctx, policy, data.missedSeq, `premium financing plan ${data.planId}: ${data.missedStreak} consecutive missed instalments`);
}

/* ------------------------------------------------------------------ renewal */

export const RenewBody = z.object({
  /** Defaults to the prior number suffixed with the renewal sequence. */
  policyNo: z.string().min(1).max(64).optional(),
  /** Defaults to a term that starts the instant the prior one ends. */
  startAt: InstantMs.optional(),
  endAt: InstantMs.optional(),
  premiumMinor: z.number().int().nonnegative().optional(),
  taxMinor: z.number().int().nonnegative().optional(),
  feesMinor: z.number().int().nonnegative().optional(),
  commissionMinor: z.number().int().nonnegative().optional(),
  /** The introducer's share of the new term's commission. */
  channelMinor: z.number().int().nonnegative().default(0),
  /** Set when the renewal was re-shopped rather than rolled at the same price. */
  quoteResponseId: z.string().min(1).nullish(),
  terms: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(500).nullish()
});
export type RenewInput = z.infer<typeof RenewBody>;

/**
 * A renewal is a new contract, not an edit of the old one: a fresh head row
 * with its own version 1, pointing back at the term it replaces. Cover, claims
 * and money all belong to a term, so folding the next year into the same row
 * would make "what were we on risk for in March" unanswerable.
 *
 * The state machine refuses `bound -> renewed`, so a policy has to have gone on
 * risk (or run to term) before it can be renewed — nothing to renew otherwise.
 */
export async function renewPolicy(ctx: Ctx, prior: PolicyRow, input: RenewInput) {
  await assertNotScreenedOut(ctx, prior.customerId);
  hop(prior, "renewed");

  const startAt = input.startAt ?? prior.endAt;
  const endAt = input.endAt ?? startAt + (prior.endAt - prior.startAt);
  if (endAt <= startAt) throw badRequest("a renewal term must end after it starts");

  const premiumMinor = input.premiumMinor ?? prior.premiumMinor;
  const taxMinor = input.taxMinor ?? prior.taxMinor;
  const feesMinor = input.feesMinor ?? prior.feesMinor;
  const commissionMinor = input.commissionMinor ?? prior.commissionMinor;
  // Same reason as bind: RENEW posts a commission accrual and `buildRecipe`
  // refuses a batch of fewer than two lines.
  if (commissionMinor <= 0) {
    throw badRequest("cannot renew with no commission: RENEW posts a commission accrual");
  }
  const channelMinor = Math.min(Math.max(input.channelMinor, 0), commissionMinor);
  const renewalSeq = prior.renewalSeq + 1;

  const policyId = newId("pol", ctx.now);
  const txn = await runTxn(
    ctx,
    {
      type: "RENEW",
      // Keyed on the term being replaced: two calls renewing the same policy are
      // the same money movement, whatever number the successor is given.
      idempotencyKey: `axis.renew:${prior.id}`,
      currency: prior.currency,
      grossMinor: premiumMinor + taxMinor + feesMinor,
      subjectRefs: { policy: policyId, priorPolicy: prior.id }
    },
    {
      recipe: { lines: buildRecipe("RENEW", { grossMinor: commissionMinor, channelMinor }), currency: prior.currency },
      approvalSubjectRef: `axis_renew:${prior.id}`
    }
  );

  const versionId = newId("pver", ctx.now);
  const successor: PolicyRow = {
    ...prior,
    id: policyId,
    caseId: null,
    policyNo: input.policyNo ?? `${prior.policyNo}-R${renewalSeq}`,
    startAt,
    endAt,
    premiumMinor,
    taxMinor,
    feesMinor,
    grossMinor: premiumMinor + taxMinor + feesMinor,
    commissionMinor,
    currentVersionId: versionId,
    versionSeq: 1,
    renewedFromPolicyId: prior.id,
    renewalSeq,
    // A new term starts off risk, and carries none of the prior term's scars.
    status: "bound",
    inceptedAt: null,
    lapsedAt: null,
    cancelledAt: null,
    cancelReasonCode: null,
    cancelEffectiveAt: null,
    statusReason: input.note ?? "renewed",
    escrowBatchId: null,
    lastTxnId: txn.id,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisPolicies).values(successor);
  await ctx.db.insert(schema.axisPolicyVersions).values({
    id: versionId,
    tenantId: ctx.tenantId,
    policyId,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: startAt,
    effectiveTo: endAt,
    premiumMinor,
    taxMinor,
    feesMinor,
    commissionMinor,
    currency: prior.currency,
    premiumDeltaMinor: 0,
    termsJson: JSON.stringify(input.terms ?? {}),
    quoteResponseId: input.quoteResponseId ?? null,
    txnId: txn.id,
    state: "effective",
    issuedBy: actorRef(ctx),
    issuedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });

  const after = await stampHead(ctx, prior, {
    status: "renewed",
    statusReason: input.note ?? `renewed as ${successor.policyNo}`,
    lastTxnId: txn.id
  });

  await audit(ctx, { action: "axis.policy.renew", subjectRef: prior.id, before: prior, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.renewed",
    subject: policyId,
    data: {
      policyId,
      priorPolicyId: prior.id,
      customerId: prior.customerId,
      providerId: prior.providerId,
      productId: prior.productId,
      channelId: prior.channelId,
      policyNo: successor.policyNo,
      renewalSeq,
      startAt,
      endAt,
      premiumMinor,
      grossMinor: successor.grossMinor,
      commissionMinor,
      currency: prior.currency,
      txnId: txn.id
    }
  });
  return { policy: successor, prior: after, versionId, txn };
}

/* ----------------------------------------------------------------- the sweep */

/**
 * First instalment still unpaid past its grace window, if any.
 *
 * `PaymentPlanJson` (packages/db) rather than a shape local to this file, and
 * deliberately not the stricter `PaymentPlanWrite` the write door uses: a plan
 * seeded or migrated in from outside the API carries keys the write shape never
 * modelled, and refusing to read one means declining to lapse a policy that has
 * gone unpaid. Lenient and fail-open is safe here because nothing in this
 * function renders `dueAt` through `new Date()` — it only compares it to `now`.
 */
function missedInstalment(planJson: string | null, now: number): { seq: number; dueAt: number } | null {
  if (!planJson) return null;
  const parsed = PaymentPlanJson.safeParse(JSON.parse(planJson));
  if (!parsed.success || !parsed.data.lapseOnMissed) return null;
  const grace = parsed.data.graceDays * DAY_MS;
  const missed = parsed.data.instalments
    .filter((i) => i.state !== "paid" && i.state !== "waived" && i.dueAt + grace <= now)
    .sort((a, b) => a.dueAt - b.dueAt)[0];
  return missed ? { seq: missed.seq, dueAt: missed.dueAt } : null;
}

/**
 * The clock events, in the order the clock produces them: a policy bound in the
 * past incepts, then a policy whose instalment went unpaid past grace lapses,
 * then a policy that ran to term end expires. Each pass re-reads, so one tick
 * can walk a back-dated policy through more than one hop.
 *
 * Runs below the permission layer: the scheduler's actor holds no grants
 * (apps/api/src/index.ts), and a clock event is not somebody's request. One
 * policy's failure never stops the sweep.
 */
export async function sweepPolicyLifecycle(ctx: Ctx): Promise<{ incepted: number; lapsed: number; expired: number }> {
  const out = { incepted: 0, lapsed: 0, expired: 0 };

  const due = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(
      scoped(
        ctx,
        schema.axisPolicies,
        and(eq(schema.axisPolicies.status, "bound"), lte(schema.axisPolicies.startAt, ctx.now))
      )
    )
    // Earliest start first, capped (sweep.ts): incepting moves the status off
    // `bound`, so the overflow is simply next tick's head of queue.
    .orderBy(asc(schema.axisPolicies.startAt))
    .limit(SWEEP_MAX);
  for (const policy of due) {
    try {
      const txn = await runTxn(ctx, {
        type: "INCEPT",
        idempotencyKey: `axis.incept:${policy.id}`,
        currency: policy.currency,
        subjectRefs: { policy: policy.id }
      });
      const after = await stampHead(ctx, policy, { status: "active", inceptedAt: ctx.now, lastTxnId: txn.id });
      await audit(ctx, { action: "axis.policy.incept", subjectRef: policy.id, before: policy, after });
      await emit(ctx, {
        module: "axis",
        type: "axis.policy.incepted",
        subject: policy.id,
        data: { policyId: policy.id, customerId: policy.customerId, startAt: policy.startAt, endAt: policy.endAt }
      });
      out.incepted += 1;
    } catch (err) {
      console.error("incept failed", policy.id, err);
    }
  }

  const onRisk = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(
      scoped(
        ctx,
        schema.axisPolicies,
        and(eq(schema.axisPolicies.status, "active"), isNotNull(schema.axisPolicies.paymentPlanJson))
      )
    );
  // ponytail: the whole on-risk book, uncapped. Whether an instalment was
  // missed is inside paymentPlanJson, so unlike the two passes either side of
  // this one there is no predicate that leaves a checked-and-fine policy out of
  // the set — a cap here would starve everything past it forever. Bounding it
  // needs a `next_instalment_due_at` column to filter on (ADR-0050).
  for (const policy of onRisk) {
    try {
      const missed = missedInstalment(policy.paymentPlanJson, ctx.now);
      if (!missed) continue;
      await lapsePolicy(ctx, policy, missed.seq, "instalment unpaid past grace");
      out.lapsed += 1;
    } catch (err) {
      console.error("lapse failed", policy.id, err);
    }
  }

  const ended = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(
      scoped(
        ctx,
        schema.axisPolicies,
        and(
          inArray(schema.axisPolicies.status, ["active", "lapsed"]),
          lte(schema.axisPolicies.endAt, ctx.now)
        )
      )
    )
    // Earliest end first, capped: expiring moves the status to `expired`.
    .orderBy(asc(schema.axisPolicies.endAt))
    .limit(SWEEP_MAX);
  for (const policy of ended) {
    try {
      const txn = await runTxn(ctx, {
        type: "EXPIRE",
        idempotencyKey: `axis.expire:${policy.id}`,
        currency: policy.currency,
        subjectRefs: { policy: policy.id }
      });
      const after = await stampHead(ctx, policy, {
        status: "expired",
        statusReason: "term ended",
        lastTxnId: txn.id
      });
      await audit(ctx, { action: "axis.policy.expire", subjectRef: policy.id, before: policy, after });
      await emit(ctx, {
        module: "axis",
        type: "axis.policy.expired",
        subject: policy.id,
        data: { policyId: policy.id, customerId: policy.customerId, endAt: policy.endAt }
      });
      out.expired += 1;
    } catch (err) {
      console.error("expire failed", policy.id, err);
    }
  }

  return out;
}

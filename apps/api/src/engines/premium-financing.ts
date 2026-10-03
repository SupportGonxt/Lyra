import { asc, eq, inArray, like } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, badRequest, conflict, emit, notFound, scoped, type Ctx } from "@lyra/core";
import { buildRecipe, fxRateFor, premiumReceiptLines, reverseTxn, runTxn } from "@lyra/ledger";
import { SWEEP_MAX } from "./sweep.js";

// docs/27 group D — premium financing. Opening a plan itself moves no money
// (PLAN-CREATE is non-financial, docs/19 §4.2); the financing house's
// commission is a real receivable the moment the plan opens, so it posts as a
// chained FIN-CMSN transaction (docs/19 §5.2 A) rather than inside PLAN-CREATE.
//
// Collection is accrual-on-schedule, and non-payment is driven by a real
// signal — a failed `ledger_payments` row keyed `<planId>:<seq>`. See
// docs/decisions/ADR-0066-premium-financing-settlement-signal.md for what that
// means while nothing writes those rows yet.

export type PolicyRow = typeof schema.axisPolicies.$inferSelect;
export type PaymentPlanRow = typeof schema.ledgerPaymentPlans.$inferSelect;

export interface ScheduleRow {
  seq: number;
  dueAt: number;
  amountMinor: number;
  /** `"due"` is the legacy synonym of `"pending"` written by packages/core/src/seed/ledger.ts. */
  state: "pending" | "due" | "paid" | "missed";
  /**
   * The `ledger_payments` row that caused the miss on a `"missed"` row. A
   * missed instalment stays collectable (the financier re-presents the debit),
   * so the loop needs to tell "this failure again" from "a newer attempt" —
   * without it, one bounce is re-counted on every tick and lapses a customer.
   */
  missedPaymentId?: string | undefined;
}

export interface CreatePlanInput {
  financierRef?: string | undefined;
  totalMinor: number;
  currency: string;
  instalments: number;
  startAt: number;
  frequencyDays: number;
  commissionMinor: number;
  commissionTaxMinor?: number | undefined;
}

/**
 * Three consecutive refused attempts cascade into policy lapse. Attempts, not
 * instalments: three re-presentations of instalment 1 lapse the policy just as
 * three different instalments missed in a row do. Any collection resets it.
 */
export const DUNNING_LAPSE_THRESHOLD = 3;

/** Only a live policy has premium left to finance. */
const FINANCEABLE_POLICY_STATES = ["bound", "active"];

/**
 * A `missed` row is still collectable: the financier re-presents the debit and
 * it clears days later. Excluding it would drop the plan out of the sweep the
 * moment it goes quiet — with nothing uncollected left, the plan completes and
 * the re-presented debit is never posted. Real money in, silently unbooked.
 *
 * ponytail: no `written_off` state. A row nobody will ever collect is handled by
 * cancelling the plan (cancelPlan), which un-earns the commission with it. Add a
 * per-row write-off when a financier actually settles one instalment short.
 */
const uncollected = (state: ScheduleRow["state"]): boolean =>
  state === "pending" || state === "due" || state === "missed";

/**
 * The engine does not own `ledger_payments.state`, so it is an allowlist, not a
 * denylist: only these mean the money is with us. Anything else — `pending`, an
 * unrecognised state a future PSP intake introduces — leaves the row for the
 * next tick rather than silently becoming a client-money receipt.
 */
const PAID_STATES = new Set(["authorized", "captured", "settled"]);

/** The money is not with us and the customer's attempt is over: this is the miss. */
const MISS_STATES = new Set(["failed", "charged_back", "refunded"]);

/** Legacy plan rows carry a `policy:`-prefixed subjectRef; the ledger dims and
 *  the lapse consumer's policy lookup both need the bare id. */
const policyIdOf = (plan: PaymentPlanRow): string => plan.subjectRef.replace(/^policy:/, "");

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function buildSchedule(input: CreatePlanInput): ScheduleRow[] {
  // floor, not round: rounding *up* makes the remainder the last instalment
  // absorbs negative ({5, 10} gave a -4 row), and a negative or zero amount is
  // refused by buildRecipe on every tick forever. With floor and createPlan's
  // `totalMinor >= instalments` precondition the last row is provably
  // >= perInstalment >= 1.
  const perInstalment = Math.floor(input.totalMinor / input.instalments);
  return Array.from({ length: input.instalments }, (_, i) => ({
    seq: i + 1,
    dueAt: input.startAt + i * input.frequencyDays * 86_400_000,
    // The last instalment absorbs the rounding remainder, so the schedule sums
    // to exactly totalMinor — otherwise the financier is short-paid or over-paid
    // by up to (instalments - 1) minor units, silently, on every plan.
    amountMinor:
      i === input.instalments - 1
        ? input.totalMinor - perInstalment * (input.instalments - 1)
        : perInstalment,
    state: "pending" as const
  }));
}

export async function createPlan(
  ctx: Ctx,
  policy: PolicyRow,
  input: CreatePlanInput
): Promise<{ plan: PaymentPlanRow; txn: { id: string } }> {
  // A lapsed/cancelled/expired/draft policy has no premium to finance: opening a
  // plan would book a commission receivable and then collect instalments for
  // cover that does not exist.
  if (!FINANCEABLE_POLICY_STATES.includes(policy.status)) {
    throw conflict(`policy ${policy.id} is ${policy.status}; premium financing needs bound or active`);
  }

  // A policy is financed once. The route's idempotency key only dedupes the
  // *same* attempt: a client sending a fresh UUID per retry (the normal case),
  // or re-sending a key after IDEMPOTENCY_TTL_MS, would otherwise open a second
  // plan — booking the FIN-CMSN commission twice and then collecting the same
  // premium twice every tick on separate keys (CLAUDE.md #12). `completed` and
  // `cancelled` plans do not block a new one; a live plan does.
  const [existing] = await ctx.db
    .select({ id: schema.ledgerPaymentPlans.id })
    .from(schema.ledgerPaymentPlans)
    .where(
      scoped(
        ctx,
        schema.ledgerPaymentPlans,
        // Legacy rows carry the `policy:` prefix (see policyIdOf).
        inArray(schema.ledgerPaymentPlans.subjectRef, [policy.id, `policy:${policy.id}`]),
        inArray(schema.ledgerPaymentPlans.state, ["active", "defaulted"])
      )
    );
  if (existing) {
    throw conflict(`policy ${policy.id} already has financing plan ${existing.id}`);
  }

  // Everything that can refuse this plan happens here, before the first write.
  // A plan row is a live money-affecting record: the sweep collects it, and C3
  // makes it permanent. So nothing may be written until the whole plan is known
  // to be postable (CLAUDE.md #12).
  // The plan collects in its own currency against this policy's dim, and nothing
  // downstream reconciles the two: a ZAR policy carrying a USD plan would post
  // client-money receipts nobody can match back to the premium owed. Route input
  // is a trust boundary, so the equality is checked here rather than assumed.
  if (input.currency !== policy.currency) {
    throw badRequest(
      `plan currency ${input.currency} does not match policy currency ${policy.currency}`
    );
  }

  // Financing may cover more than bare premium (tax, fees), so the ceiling is the
  // policy's gross where one was computed and the premium otherwise — not premium
  // exactly. Without it a valid route call finances an arbitrary amount and the
  // instalment sweep over-collects for the life of the plan.
  const financeableMinor = Math.max(policy.grossMinor ?? 0, policy.premiumMinor);
  if (input.totalMinor > financeableMinor) {
    throw badRequest(
      `totalMinor ${input.totalMinor} exceeds financeable amount ${financeableMinor} for policy ${policy.id}`
    );
  }

  const fxRatePpm = await fxRateFor(ctx, input.currency);
  if (!fxRatePpm) {
    throw badRequest(`no fx rate supplied for ${input.currency} -> ${ctx.policy.currency}`);
  }

  // Every instalment has to be able to carry at least one minor unit, or
  // buildSchedule hands the last row a zero/negative amount that PREM-INSTALMENT
  // refuses on every tick for the life of the plan.
  if (input.totalMinor < input.instalments) {
    throw badRequest(
      `totalMinor ${input.totalMinor} cannot fund ${input.instalments} instalments of at least 1 minor unit`
    );
  }

  // The chained FIN-CMSN is part of opening the plan (docs/19 §5.2 A), and
  // buildRecipe refuses a zero gross — so a zero commission is not a plan we can
  // open, and finding that out after the insert is what orphaned live plans.
  if (input.commissionMinor <= 0) {
    throw badRequest(`commissionMinor must be positive; got ${input.commissionMinor}`);
  }

  const planId = newId("finplan", ctx.now);
  const schedule = buildSchedule(input);

  // Pure, writes nothing: built up here so a malformed recipe throws before any
  // transaction is opened rather than between the two writes.
  const commissionLines = buildRecipe("FIN-CMSN", {
    grossMinor: input.commissionMinor,
    taxMinor: input.commissionTaxMinor ?? 0,
    memo: `financing commission: plan ${planId}`,
    dims: { policy: policy.id }
  });

  const txn = await runTxn(ctx, {
    type: "PLAN-CREATE",
    idempotencyKey: `finance.plan_create:${planId}`,
    currency: input.currency,
    subjectRefs: { policy: policy.id, plan: planId }
  });

  await runTxn(
    ctx,
    {
      type: "FIN-CMSN",
      idempotencyKey: `finance.plan_commission:${planId}`,
      currency: input.currency,
      grossMinor: input.commissionMinor,
      parentTxnId: txn.id,
      subjectRefs: { policy: policy.id, plan: planId }
    },
    { recipe: { lines: commissionLines, currency: input.currency, fxRatePpm } }
  );

  // Last write, deliberately. A failure anywhere above leaves at most an orphan
  // non-financial PLAN-CREATE txn with no lines, which nothing sweeps and which
  // the deterministic `finance.plan_create:<planId>` key makes harmless — rather
  // than a live `active` plan collecting premium with no commission behind it.
  await ctx.db.insert(schema.ledgerPaymentPlans).values({
    id: planId,
    tenantId: ctx.tenantId,
    subjectRef: `policy:${policy.id}`,
    financierRef: input.financierRef ?? null,
    totalMinor: input.totalMinor,
    currency: input.currency,
    instalments: input.instalments,
    scheduleJson: JSON.stringify(schedule),
    state: "active",
    missedStreak: 0,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });

  const [plan] = await ctx.db
    .select()
    .from(schema.ledgerPaymentPlans)
    .where(scoped(ctx, schema.ledgerPaymentPlans, eq(schema.ledgerPaymentPlans.id, planId)));

  return { plan: plan!, txn: { id: txn.id } };
}

/**
 * The settlement signal for the instalments being collected this tick, if a
 * PSP/financier intake has written any: `ledger_payments.providerRef =
 * "<planId>:<seq>"` (ADR-0066). One scoped query, latest row per seq wins, so a
 * retry that succeeds supersedes an earlier failure. A settlement file imported
 * in one batch stamps every row with the same `created_at`, so the id breaks the
 * tie — otherwise the winner is whatever the scan happened to return last.
 */
async function paymentsBySeq(
  ctx: Ctx,
  refs: string[]
): Promise<Map<string, typeof schema.ledgerPayments.$inferSelect>> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerPayments)
    .where(scoped(ctx, schema.ledgerPayments, inArray(schema.ledgerPayments.providerRef, refs)))
    .orderBy(asc(schema.ledgerPayments.createdAt), asc(schema.ledgerPayments.id));
  return new Map(rows.map((r) => [r.providerRef ?? "", r]));
}

/**
 * A plan opened in error. C3 makes a live plan permanent for its policy, so
 * without a way out a single mistaken plan locks that contract out of financing
 * for good — this is the release valve, and the only reason C3 is safe.
 *
 * The commission was recognised the moment the plan opened, so cancelling
 * un-earns it: the FIN-CMSN is reversed rather than deleted, leaving both sides
 * in the ledger (docs/19 §7). Instalments already collected are real money that
 * arrived and stay posted.
 *
 * ponytail: cancels whole, not pro-rata. A part-collected plan that should
 * surrender only the unearned share of the commission needs a settlement figure
 * from the financier, which is a `written_off`/`surrendered` state and its own
 * recipe — build it when a financier asks for one.
 */
export async function cancelPlan(
  ctx: Ctx,
  plan: PaymentPlanRow,
  reason: string
): Promise<{ plan: PaymentPlanRow; reversalTxnId: string | null }> {
  if (plan.state !== "active" && plan.state !== "defaulted") {
    throw conflict(`plan ${plan.id} is ${plan.state}; only a live plan can be cancelled`);
  }

  // Deterministic key (see createPlan), so no reverse lookup by dimension.
  const [commission] = await ctx.db
    .select({ id: schema.ledgerTxns.id })
    .from(schema.ledgerTxns)
    .where(
      scoped(ctx, schema.ledgerTxns, eq(schema.ledgerTxns.idempotencyKey, `finance.plan_commission:${plan.id}`))
    );

  // Absent for a legacy orphan — a plan row that survived a failed chained
  // FIN-CMSN back when the row was written first. Nothing to un-earn, and
  // refusing here would leave exactly those rows unfixable.
  const reversal = commission ? await reverseTxn(ctx, commission.id, reason) : null;

  await ctx.db
    .update(schema.ledgerPaymentPlans)
    .set({ state: "cancelled", updatedAt: ctx.now })
    .where(scoped(ctx, schema.ledgerPaymentPlans, eq(schema.ledgerPaymentPlans.id, plan.id)));

  const after = { ...plan, state: "cancelled", updatedAt: ctx.now };
  await audit(ctx, {
    action: "ledger.financing.plan.cancel",
    subjectRef: plan.id,
    before: plan,
    after: { ...after, reason, reversalTxnId: reversal?.reversal.id ?? null }
  });

  return { plan: after, reversalTxnId: reversal?.reversal.id ?? null };
}

/** The one live plan on a policy, or a 404 — the cancel route's lookup. */
export async function livePlanOf(ctx: Ctx, policyId: string): Promise<PaymentPlanRow> {
  const [plan] = await ctx.db
    .select()
    .from(schema.ledgerPaymentPlans)
    .where(
      scoped(
        ctx,
        schema.ledgerPaymentPlans,
        // Same pair C3 checks: a legacy row may carry the bare policy id.
        inArray(schema.ledgerPaymentPlans.subjectRef, [policyId, `policy:${policyId}`]),
        inArray(schema.ledgerPaymentPlans.state, ["active", "defaulted"])
      )
    );
  if (!plan) throw notFound(`no live financing plan for policy ${policyId}`);
  return plan;
}

export async function payInstalment(ctx: Ctx, plan: PaymentPlanRow, now: number): Promise<void> {
  const schedule: ScheduleRow[] = JSON.parse(plan.scheduleJson);
  const policyId = policyIdOf(plan);
  const due = schedule.filter((row) => uncollected(row.state) && row.dueAt <= now);

  const previousMissedStreak = plan.missedStreak;
  let missedStreak = plan.missedStreak;
  let changed = false;

  if (due.length > 0) {
    // Pre-check before any row is touched: an unrateable currency is our fault,
    // not the customer's. Leave the whole plan for the next tick rather than
    // manufacturing misses out of an operator's missing rate.
    const fxRatePpm = await fxRateFor(ctx, plan.currency);
    if (!fxRatePpm) {
      console.error("premium-financing: no fx rate, plan left for the next tick", {
        planId: plan.id,
        error: `no fx rate supplied for ${plan.currency} -> ${ctx.policy.currency}`
      });
      return;
    }

    const payments = await paymentsBySeq(
      ctx,
      due.map((row) => `${plan.id}:${row.seq}`)
    );

    for (const row of due) {
      const payment = payments.get(`${plan.id}:${row.seq}`);

      if (payment && MISS_STATES.has(payment.state)) {
        // Already counted: the same refused attempt seen again on a later tick
        // is not a second miss. Only a *newer* payment row moves the streak.
        if (payment.id === row.missedPaymentId) continue;
        // The only thing that makes an instalment a miss: money that was
        // actually refused, clawed back or returned.
        row.state = "missed";
        row.missedPaymentId = payment.id;
        missedStreak += 1;
        changed = true;
        try {
          await runTxn(ctx, {
            type: "DUNNING",
            // Keyed by the payment, not the instalment: a financier re-presenting the
            // same instalment produces a new refused payment, which is a second
            // refused attempt and so a second dunning record. Keyed by seq alone the
            // second and third attempts replayed onto the first record, silently
            // under-recording exactly the escalation this table exists to evidence.
            // (`missedPaymentId` still guarantees one record per payment id.)
            idempotencyKey: `finance.dunning:${plan.id}:${row.seq}:${payment.id}`,
            currency: plan.currency,
            subjectRefs: { policy: policyId, plan: plan.id },
            metadata: {
              seq: row.seq,
              paymentId: payment.id,
              paymentState: payment.state,
              failureCode: payment.failureCode ?? null
            }
          });
        } catch (err) {
          // The dunning record is a note *about* the miss, not the miss itself:
          // failing to write it must not lose the streak that drives lapse.
          console.error("premium-financing: dunning record failed to post", {
            planId: plan.id,
            seq: row.seq,
            error: message(err)
          });
        }
        continue;
      }

      // Neither cash nor a closed attempt (an in-flight `pending` debit, or a
      // state this engine has never heard of): wait for the next tick.
      if (payment && !PAID_STATES.has(payment.state)) continue;

      try {
        // Clears the instalment's share of what the bind booked on 1200 for
        // this policy (premium-receipt.ts); a policy bound without premium
        // passing through us has nothing open and posts the plain receipt.
        const lines = await premiumReceiptLines(
          ctx,
          "PREM-INSTALMENT",
          {
            amountMinor: row.amountMinor,
            memo: `instalment ${row.seq}/${plan.instalments}: plan ${plan.id}`,
            dims: { policy: policyId }
          },
          plan.currency
        );
        await runTxn(
          ctx,
          {
            type: "PREM-INSTALMENT",
            idempotencyKey: `finance.instalment:${plan.id}:${row.seq}`,
            currency: plan.currency,
            grossMinor: row.amountMinor,
            subjectRefs: { policy: policyId, plan: plan.id }
          },
          { recipe: { lines, currency: plan.currency, fxRatePpm } }
        );
        row.state = "paid";
        delete row.missedPaymentId; // the miss is cured; don't leave it on the row
        // The streak counts *consecutive* misses, so any collection clears it:
        // a plan that pays after two misses starts again from zero rather than
        // lapsing on a miss months later. A collection later in this same tick
        // therefore cancels earlier misses in it — deliberate, and the reason
        // the crossing check below reads the final value, not a running one.
        missedStreak = 0;
        changed = true;
      } catch (err) {
        // Our own posting failure, not a customer default: the row stays
        // pending, the streak is untouched, no DUNNING is recorded, and the next
        // tick retries it under the same idempotency key.
        console.error("premium-financing: instalment failed to post, retrying next tick", {
          planId: plan.id,
          seq: row.seq,
          error: message(err)
        });
      }
    }
  }

  // Fire exactly once: only on the tick where the streak actually crosses the
  // threshold, not on every subsequent tick where it stays at or above it.
  const crossedThreshold =
    previousMissedStreak < DUNNING_LAPSE_THRESHOLD && missedStreak >= DUNNING_LAPSE_THRESHOLD;
  // A finished or defaulted plan has to leave the sweep's result set, or it is
  // re-read every tick forever and crowds newer plans out of the SWEEP_MAX
  // window (ADR-0050: a cap is only safe when a processed row leaves the set).
  const state = crossedThreshold
    ? "defaulted"
    : schedule.every((row) => row.state === "paid")
      ? "completed"
      : plan.state;

  if (!changed && state === plan.state) return; // nothing due, nothing to write

  await ctx.db
    .update(schema.ledgerPaymentPlans)
    .set({ scheduleJson: JSON.stringify(schedule), missedStreak, state, updatedAt: now })
    .where(scoped(ctx, schema.ledgerPaymentPlans, eq(schema.ledgerPaymentPlans.id, plan.id)));

  if (crossedThreshold) {
    const missedSeq = [...schedule].reverse().find((row) => row.state === "missed")?.seq ?? 0;
    await emit(ctx, {
      module: "ledger",
      type: "ledger.financing.lapse_due",
      subject: `plan:${plan.id}`,
      data: { policyId, planId: plan.id, missedStreak, missedSeq }
    });
  }
}

export async function sweepPremiumFinancing(ctx: Ctx): Promise<number> {
  const plans = await ctx.db
    .select()
    .from(schema.ledgerPaymentPlans)
    .where(
      scoped(
        ctx,
        schema.ledgerPaymentPlans,
        eq(schema.ledgerPaymentPlans.state, "active"),
        // `payment_plans` is shared: an instalment plan on an invoice or an order
        // is a legitimate row a sibling module may own. The discriminator is the
        // subject prefix, not `financierRef` — everything below is policy-shaped
        // (policyIdOf, the ledger `policy` dim, the lapse cascade), so a foreign
        // row swept here would post instalments against a policy id that does
        // not exist.
        like(schema.ledgerPaymentPlans.subjectRef, "policy:%")
      )
    )
    // ponytail: oldest-first, so the plan waiting longest is collected first if a
    // tenant ever exceeds SWEEP_MAX active plans. Cursor paging when one does.
    .orderBy(asc(schema.ledgerPaymentPlans.createdAt))
    .limit(SWEEP_MAX);

  for (const plan of plans) {
    // One plan's fully-caught failure (fx guard above) must not stop the rest
    // of this tenant's plans, or the rest of the tenant's cron tick.
    try {
      await payInstalment(ctx, plan, ctx.now);
    } catch (err) {
      console.error("premium-financing: sweep failed for plan", { planId: plan.id, error: message(err) });
    }
  }

  return plans.length;
}

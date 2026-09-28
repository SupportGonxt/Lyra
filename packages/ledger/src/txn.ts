import { and, eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  conflict,
  emit,
  gate,
  notFound,
  type Ctx
} from "@lyra/core";
import { post, reverse, type PostInput, type PostingLine } from "./posting.js";
import { TXN_PRECONDITIONS } from "./preconditions.js";
import { autoApprovable, canTransition, txnType, type ActorKind, type TxnState } from "./types.js";

// docs/19 §2, §3, §8. One envelope, one state machine, one place where a business
// action becomes money. Modules describe *what* happened (a recipe of lines);
// this file owns idempotency, approval, transitions, posting and compensation.

export interface TxnRow {
  id: string;
  tenantId: string;
  type: string;
  state: TxnState;
  idempotencyKey: string;
  correlationId: string | null;
  parentTxnId: string | null;
  reversalOf: string | null;
  currency: string;
  baseCurrency: string;
  grossMinor: number;
  baseGrossMinor: number;
  ledgerBatchId: string | null;
  failureCode: string | null;
  failureDetail: string | null;
}

export interface OpenTxnInput {
  type: string;
  /** Caller-supplied natural key: `bind:{caseId}`, `remit:{insurer}:{period}`. */
  idempotencyKey: string;
  currency?: string;
  baseCurrency?: string;
  grossMinor?: number;
  correlationId?: string;
  parentTxnId?: string;
  /** `{policy: "pol_1", customer: "cus_2"}` — what this transaction is about. */
  subjectRefs?: Record<string, string>;
  amounts?: Record<string, number>;
  guardrails?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  autonomyLevel?: string;
  actorKind?: ActorKind;
  externalTimeoutAt?: number;
}

function row(r: Record<string, unknown>): TxnRow {
  return r as unknown as TxnRow;
}

export async function getTxn(ctx: Ctx, txnId: string): Promise<TxnRow> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.id, txnId)))
    .limit(1);
  if (!rows[0]) throw notFound("transaction");
  return row(rows[0]);
}

async function findByKey(ctx: Ctx, type: string, key: string): Promise<TxnRow | undefined> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerTxns)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.type, type),
        eq(schema.ledgerTxns.idempotencyKey, key)
      )
    )
    .limit(1);
  return rows[0] ? row(rows[0]) : undefined;
}

/**
 * Create the envelope, or return the one that already exists for this key.
 * Idempotency lives on the (tenant, type, key) unique index rather than in an
 * application check, so two concurrent callers cannot both win.
 */
export async function openTxn(ctx: Ctx, input: OpenTxnInput): Promise<TxnRow> {
  const def = txnType(input.type);
  const existing = await findByKey(ctx, def.code, input.idempotencyKey);
  if (existing) return existing;

  const currency = input.currency ?? ctx.policy.currency;
  const values = {
    id: id("txn", ctx.now),
    tenantId: ctx.tenantId,
    type: def.code,
    version: 1,
    idempotencyKey: input.idempotencyKey,
    correlationId: input.correlationId ?? null,
    parentTxnId: input.parentTxnId ?? null,
    reversalOf: null,
    state: "initiated" as const,
    actorKind: input.actorKind ?? ctx.actor.kind,
    actorId: ctx.actor.id,
    autonomyLevel: input.autonomyLevel ?? ctx.policy.autonomyDefault,
    subjectRefsJson: input.subjectRefs ? JSON.stringify(input.subjectRefs) : null,
    currency,
    baseCurrency: input.baseCurrency ?? ctx.policy.currency,
    fxRatePpm: null,
    amountsJson: input.amounts ? JSON.stringify(input.amounts) : null,
    grossMinor: input.grossMinor ?? 0,
    baseGrossMinor: 0,
    ledgerBatchId: null,
    eventIdsJson: null,
    evidenceRefsJson: null,
    guardrailsJson: input.guardrails ? JSON.stringify(input.guardrails) : null,
    failureCode: null,
    failureDetail: null,
    externalTimeoutAt: input.externalTimeoutAt ?? null,
    metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    settledAt: null,
    failedAt: null
  };

  try {
    await ctx.db.insert(schema.ledgerTxns).values(values);
  } catch (err) {
    // Lost the race on the idempotency index: the winner's row is the answer.
    const won = await findByKey(ctx, def.code, input.idempotencyKey);
    if (!won) throw err;
    return won;
  }

  await writeTransition(ctx, values.id, null, "initiated", "opened");
  return row(values);
}

async function writeTransition(
  ctx: Ctx,
  txnId: string,
  from: TxnState | null,
  to: TxnState,
  reason?: string
): Promise<void> {
  await ctx.db.insert(schema.ledgerTxnTransitions).values({
    id: id("txt", ctx.now),
    tenantId: ctx.tenantId,
    txnId,
    fromState: from,
    toState: to,
    actorRef: actorRef(ctx),
    reason: reason ?? null,
    ts: ctx.now
  });
}

export interface TransitionOptions {
  reason?: string | undefined;
  failureCode?: string | undefined;
  failureDetail?: string | undefined;
}

/** The only writer of ledger_txns.state. An illegal hop is a 409, never a silent set. */
export async function transition(
  ctx: Ctx,
  txnId: string,
  to: TxnState,
  opts: TransitionOptions = {}
): Promise<TxnRow> {
  const current = await getTxn(ctx, txnId);
  if (current.state === to) return current;
  if (!canTransition(current.state, to)) {
    throw conflict(`transaction ${txnId} cannot move ${current.state} -> ${to}`);
  }

  const patch: Record<string, unknown> = { state: to, updatedAt: ctx.now };
  if (to === "settled") patch["settledAt"] = ctx.now;
  if (to === "failed" || to === "rejected" || to === "expired") {
    patch["failedAt"] = ctx.now;
    patch["failureCode"] = opts.failureCode ?? to;
    patch["failureDetail"] = opts.failureDetail ?? opts.reason ?? null;
  }

  await ctx.db
    .update(schema.ledgerTxns)
    .set(patch)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.id, txnId),
        // Optimistic guard: if another writer moved the state since our read,
        // this updates nothing rather than overwriting their transition.
        eq(schema.ledgerTxns.state, current.state)
      )
    );

  const after = await getTxn(ctx, txnId);
  if (after.state !== to) throw conflict(`transaction ${txnId} changed state concurrently`);

  await writeTransition(ctx, txnId, current.state, to, opts.reason);
  return after;
}

export interface Recipe {
  lines: readonly PostingLine[];
  currency?: string;
  baseCurrency?: string;
  fxRatePpm?: number;
  periodCode?: string;
  reason?: string;
}

export interface RunOptions {
  /** Non-financial types (⊘ in docs/19 §4) settle without a journal batch. */
  recipe?: Recipe | null;
  /** Subject the approval is recorded against; defaults to `txn:{id}`. */
  approvalSubjectRef?: string;
  /** Emitted after settlement, so downstream modules see a completed money move. */
  event?: { name: string; payload?: Record<string, unknown> };
  /** Skips the approval gate — for replaying an already-approved transaction. */
  preApproved?: boolean;
  /** The raw recipe arguments, for types with a ledger-state precondition. The
   *  built lines cannot answer "which fiscal year is this", so the args travel. */
  args?: Record<string, unknown>;
}

/**
 * `args.subjectRef` and the transaction's `subjectRefs` are supplied
 * separately by the caller (docs/ledger route), but only `subjectRefs` is what
 * actually lands on the ledger transaction. A precondition (e.g. AD-PLACEMENT's
 * disclosure gate) must judge the subject the transaction records against, not
 * some other subject the caller happens to also mention — otherwise the gate is
 * satisfiable by presenting a disclosure for an unrelated subject. If the
 * caller names a subjectRef, it must be one of the transaction's subjectRefs;
 * if it names none and there is exactly one, that one is authoritative.
 */
function reconcileSubjectRef(
  subjectRefs: Record<string, string> | undefined,
  args: Record<string, unknown>
): Record<string, unknown> {
  const values = subjectRefs ? Object.values(subjectRefs) : [];
  const claimed = args["subjectRef"];
  if (typeof claimed === "string") {
    if (values.length && !values.includes(claimed)) {
      throw conflict(`args.subjectRef "${claimed}" is not among this transaction's subjectRefs (${values.join(", ")})`);
    }
    return args;
  }
  // ponytail: only auto-fills the unambiguous single-subjectRef case; multiple
  // subjectRefs with no args.subjectRef is left to the precondition itself
  // (none of today's multi-subjectRef types has one) — revisit if that changes.
  return values.length === 1 ? { ...args, subjectRef: values[0] } : args;
}

/**
 * Drive one transaction from initiated to settled: validate, gate, authorize,
 * execute, post, settle. Any throw lands the transaction in `failed` with the
 * reason recorded, so a stuck transaction is always visible rather than absent.
 */
export async function runTxn(ctx: Ctx, input: OpenTxnInput, opts: RunOptions = {}): Promise<TxnRow> {
  const def = txnType(input.type);

  // Ledger-state preconditions run before the transaction is even opened. A
  // precondition is a "not yet" — the year still has an open month, an opening
  // balance already exists — and refusing it must leave no trace: opening first
  // would burn the idempotency key on a `failed` row, so the retry after the
  // months are closed would hit "already failed" forever.
  const precondition = TXN_PRECONDITIONS[def.code];
  if (precondition) {
    await precondition(ctx, reconcileSubjectRef(input.subjectRefs, opts.args ?? {}), {
      idempotencyKey: input.idempotencyKey
    });
  }

  const txn = await openTxn(ctx, input);

  // Replay: a settled transaction is returned untouched. This is what makes
  // "post the same bind twice" a no-op rather than a double entry.
  if (txn.state === "settled" || txn.state === "reversed" || txn.state === "adjusted") return txn;
  if (txn.state === "failed" || txn.state === "rejected" || txn.state === "expired") {
    throw conflict(`transaction ${txn.id} already ${txn.state}: ${txn.failureDetail ?? ""}`.trim());
  }

  try {
    let state = txn.state;
    if (state === "initiated") {
      if (def.financial && !opts.recipe?.lines.length) {
        throw badRequest(`${def.code} is a financial transaction and needs journal lines`);
      }
      if (!def.financial && opts.recipe?.lines.length) {
        throw badRequest(`${def.code} posts no journal; remove the recipe`);
      }
      await transition(ctx, txn.id, "validated");
      state = "validated";
    }

    if (state === "validated") {
      if (def.approval && !opts.preApproved) {
        // autoApprovable is the belt to the approval policy's braces: a payout or
        // client-money type is never auto-approved however the tenant is configured.
        if (!autoApprovable(def.code) && ctx.policy.autoApprove.includes(def.approval)) {
          throw conflict(`${def.code} may not be auto-approved (docs/19 §7)`);
        }
        await gate(ctx, {
          policyKey: def.approval,
          subjectRef: opts.approvalSubjectRef ?? `txn:${txn.id}`,
          ...(input.grossMinor !== undefined ? { amountMinor: input.grossMinor } : {})
        });
      }
      await transition(ctx, txn.id, "authorized");
      state = "authorized";
    }

    if (state === "authorized") {
      await transition(ctx, txn.id, "executing");
      state = "executing";
    }

    if (state === "executing" || state === "pending_external") {
      if (state === "pending_external") await transition(ctx, txn.id, "executing");
      if (def.financial && opts.recipe) {
        const p: PostInput = {
          txnId: txn.id,
          currency: opts.recipe.currency ?? txn.currency,
          baseCurrency: opts.recipe.baseCurrency ?? txn.baseCurrency,
          lines: opts.recipe.lines,
          ...(opts.recipe.fxRatePpm !== undefined ? { fxRatePpm: opts.recipe.fxRatePpm } : {}),
          ...(opts.recipe.periodCode ? { periodCode: opts.recipe.periodCode } : {}),
          ...(opts.recipe.reason ? { reason: opts.recipe.reason } : {})
        };
        const batch = await post(ctx, p);
        await ctx.db
          .update(schema.ledgerTxns)
          .set({ baseGrossMinor: batch.baseTotalMinor, updatedAt: ctx.now })
          .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.id, txn.id)));
      }
      await transition(ctx, txn.id, "settled");
    }
  } catch (err) {
    // An approval gate is a pause, not a failure. Burning the transaction here
    // would make the retry-with-approval hit "already failed" forever, so every
    // dual-control payout would be unpayable. The row stays in `validated` and
    // the retry resumes at the gate.
    if ((err as { code?: string }).code !== "approval_required") await failTxn(ctx, txn.id, err);
    throw err;
  }

  const settled = await getTxn(ctx, txn.id);
  await audit(ctx, {
    action: `ledger.txn.${def.code.toLowerCase()}`,
    subjectRef: `txn:${settled.id}`,
    after: { type: def.code, state: settled.state, grossMinor: settled.grossMinor, batch: settled.ledgerBatchId }
  });
  if (opts.event) {
    await emit(ctx, {
      module: "ledger",
      type: opts.event.name,
      subject: `txn:${settled.id}`,
      data: { type: def.code, txnId: settled.id, ...opts.event.payload }
    });
  }
  return settled;
}

/** Best-effort failure record: never let the reason for a failure be lost. */
async function failTxn(ctx: Ctx, txnId: string, err: unknown): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string }).code ?? "error";
  try {
    const current = await getTxn(ctx, txnId);
    if (canTransition(current.state, "failed")) {
      await transition(ctx, txnId, "failed", { failureCode: code, failureDetail: detail });
    }
  } catch {
    // The original error is the one the caller needs; swallow bookkeeping noise.
  }
}

/**
 * docs/19 §8. Reversal is a second transaction that contra-posts the first.
 * The original stays settled-then-reversed and its lines are never touched, so
 * an auditor can still see exactly what was booked and when it was undone.
 */
export async function reverseTxn(
  ctx: Ctx,
  txnId: string,
  reason: string,
  opts: { idempotencyKey?: string } = {}
): Promise<{ original: TxnRow; reversal: TxnRow }> {
  const original = await getTxn(ctx, txnId);
  if (original.state !== "settled") {
    throw conflict(`only a settled transaction can be reversed; ${txnId} is ${original.state}`);
  }

  await transition(ctx, txnId, "reversing", { reason });

  const reversal = await openTxn(ctx, {
    type: original.type,
    idempotencyKey: opts.idempotencyKey ?? `reverse:${txnId}`,
    currency: original.currency,
    baseCurrency: original.baseCurrency,
    grossMinor: original.grossMinor,
    correlationId: original.correlationId ?? txnId,
    parentTxnId: txnId,
    metadata: { reversalOf: txnId, reason }
  });

  await ctx.db
    .update(schema.ledgerTxns)
    .set({ reversalOf: txnId, updatedAt: ctx.now })
    .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.id, reversal.id)));

  try {
    if (original.ledgerBatchId) {
      await transition(ctx, reversal.id, "validated");
      await transition(ctx, reversal.id, "authorized");
      await transition(ctx, reversal.id, "executing");
      await reverse(ctx, original.ledgerBatchId, { txnId: reversal.id, reason });
      await transition(ctx, reversal.id, "settled");
    } else {
      await transition(ctx, reversal.id, "validated");
      await transition(ctx, reversal.id, "authorized");
      await transition(ctx, reversal.id, "executing");
      await transition(ctx, reversal.id, "settled");
    }
  } catch (err) {
    await failTxn(ctx, reversal.id, err);
    throw err;
  }

  const done = await transition(ctx, txnId, "reversed", { reason });
  await audit(ctx, {
    action: "ledger.txn.reverse",
    subjectRef: `txn:${txnId}`,
    before: { state: "settled" },
    after: { state: "reversed", reversalTxnId: reversal.id, reason }
  });

  return { original: done, reversal: await getTxn(ctx, reversal.id) };
}

/* -------------------------------------------------------------------- saga */

export interface SagaStep<T> {
  name: string;
  run: () => Promise<T>;
  /** Called in reverse order when a later step fails. */
  compensate?: (result: T) => Promise<void>;
}

/**
 * docs/19 §8: an external call that cannot be rolled back gets a compensating
 * action, not a database transaction. Steps are recorded so a half-finished saga
 * is inspectable in the transaction timeline rather than only in logs.
 */
export async function runSaga<T>(ctx: Ctx, txnId: string, steps: readonly SagaStep<T>[]): Promise<T[]> {
  const done: { step: SagaStep<T>; result: T }[] = [];

  for (const [i, step] of steps.entries()) {
    const stepId = id("sag", ctx.now);
    await ctx.db.insert(schema.ledgerSagaSteps).values({
      id: stepId,
      tenantId: ctx.tenantId,
      txnId,
      seq: i + 1,
      name: step.name,
      state: "running",
      requestHash: null,
      resultJson: null,
      compensationRef: null,
      attempts: 1,
      lastError: null,
      startedAt: ctx.now,
      endedAt: null
    });

    try {
      const result = await step.run();
      await ctx.db
        .update(schema.ledgerSagaSteps)
        .set({ state: "done", resultJson: JSON.stringify(result ?? null), endedAt: ctx.now })
        .where(eq(schema.ledgerSagaSteps.id, stepId));
      done.push({ step, result });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await ctx.db
        .update(schema.ledgerSagaSteps)
        .set({ state: "failed", lastError: detail, endedAt: ctx.now })
        .where(eq(schema.ledgerSagaSteps.id, stepId));
      await compensate(ctx, txnId, done);
      throw err;
    }
  }

  return done.map((d) => d.result);
}

async function compensate<T>(
  ctx: Ctx,
  txnId: string,
  done: readonly { step: SagaStep<T>; result: T }[]
): Promise<void> {
  for (let i = done.length - 1; i >= 0; i--) {
    const entry = done[i]!;
    if (!entry.step.compensate) continue;
    const where = and(
      eq(schema.ledgerSagaSteps.tenantId, ctx.tenantId),
      eq(schema.ledgerSagaSteps.txnId, txnId),
      eq(schema.ledgerSagaSteps.seq, i + 1)
    );
    await ctx.db.update(schema.ledgerSagaSteps).set({ state: "compensating" }).where(where);
    try {
      await entry.step.compensate(entry.result);
      await ctx.db.update(schema.ledgerSagaSteps).set({ state: "compensated" }).where(where);
    } catch (err) {
      // A failed compensation is an operational alarm, not a reason to hide the
      // original failure — record it and keep unwinding the rest.
      await ctx.db
        .update(schema.ledgerSagaSteps)
        .set({ state: "failed", lastError: `compensation failed: ${String(err)}` })
        .where(where);
    }
  }
}

/**
 * Sweep transactions whose provider never answered. Called by the scheduled
 * worker; `expired` is terminal, so a stuck transaction stops pretending to be
 * in flight and shows up on the exceptions queue.
 */
export async function expireStale(ctx: Ctx, limit = 200): Promise<string[]> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.state, "pending_external")))
    .limit(limit);

  const expired: string[] = [];
  for (const r of rows) {
    if (!r.externalTimeoutAt || r.externalTimeoutAt > ctx.now) continue;
    await transition(ctx, r.id, "expired", { reason: "external provider did not respond" });
    expired.push(r.id);
  }
  return expired;
}

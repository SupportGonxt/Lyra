import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { actorRef, audit, badRequest, conflict, emit, notFound, type Ctx } from "@lyra/core";
import { buildRecipe } from "./recipes.js";
import { runTxn } from "./txn.js";

// docs/19 §6 reconciliation. Three passes, in order, each only seeing what the
// previous one could not match:
//   1. deterministic — exact reference + exact amount. No judgement, no review.
//   2. tolerance     — amount within a per-process tolerance, reference intact.
//   3. ai_proposed   — everything left, proposed with a confidence score and
//                      never auto-confirmed. A human confirms or rejects.
// The engine lives here rather than behind a SaaS integration: reconciliation
// decides who gets paid, so its rules have to be readable and versioned with us.

export type ReconProcess = "insurer" | "psp" | "client_money" | "partner" | "media";
export type MatchMethod = "deterministic" | "tolerance" | "ai_proposed";

export interface StatementLine {
  /** Counterparty's own line reference; the join key when they give us one. */
  ref: string;
  amountMinor: number;
  currency: string;
  /** Their reference to our transaction, if any: policy number, txn id, invoice number. */
  ourRef?: string | undefined;
  postedAt?: number | undefined;
  description?: string | undefined;
}

export interface ReconInput {
  process: ReconProcess;
  period: string;
  currency: string;
  counterpartyRef?: string | undefined;
  statementFileId?: string | undefined;
  lines: readonly StatementLine[];
  /** Absolute minor-unit tolerance for pass 2. Zero disables the pass. */
  toleranceMinor?: number | undefined;
  /** Pass 3. Off unless a proposer is supplied — no silent AI in the money path. */
  propose?: MatchProposer | undefined;
}

/**
 * Pass 3 is injected rather than imported so the ledger keeps no dependency on
 * the model gateway; the API layer wires the real one in.
 */
export type MatchProposer = (
  unmatched: readonly StatementLine[],
  candidates: readonly ReconCandidate[]
) => Promise<readonly ProposedMatch[]>;

export interface ReconCandidate {
  txnId: string;
  type: string;
  amountMinor: number;
  currency: string;
  reference: string;
  postedAt: number;
}

export interface ProposedMatch {
  statementRef: string;
  txnId: string;
  /** 0–100. Below `AI_CONFIRM_FLOOR` the proposal is recorded but flagged weak. */
  confidence: number;
  reasonCode?: string | undefined;
}

/** Below this, a proposal is noise for a reviewer rather than help. */
export const AI_CONFIRM_FLOOR = 60;

const DEFAULT_TOLERANCE: Record<ReconProcess, number> = {
  // Insurer statements round premium tax; a few fils of drift is normal.
  insurer: 100,
  // PSPs net their fee, which we post separately, so the gap is wider.
  psp: 500,
  // Client money must be exact. A tolerance here would hide a shortfall.
  client_money: 0,
  partner: 100,
  media: 1_000
};

export interface ReconResult {
  runId: string;
  matched: number;
  variances: number;
  varianceMinor: number;
  unmatchedStatementRefs: string[];
  unmatchedTxnIds: string[];
  state: "review" | "closed";
}

function periodWindow(period: string): { from: number; to: number } {
  const [y, m] = period.split("-").map(Number);
  if (!y || !m) throw badRequest(`bad period ${period}`);
  // A statement for March routinely includes late February activity, so the
  // candidate window opens a month early rather than matching the period exactly.
  return { from: Date.UTC(y, m - 2, 1), to: Date.UTC(y, m + 1, 1) - 1 };
}

/** Our side of the reconciliation: settled transactions that could match. */
export async function candidates(ctx: Ctx, input: ReconInput): Promise<ReconCandidate[]> {
  const w = periodWindow(input.period);
  const t = schema.ledgerTxns;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.tenantId, ctx.tenantId),
        eq(t.currency, input.currency),
        gte(t.createdAt, w.from),
        lte(t.createdAt, w.to),
        sql`${t.state} in ('settled','pending_external')`
      )
    )
    .limit(20_000);

  const already = await ctx.db
    .select({ txnId: schema.ledgerReconMatches.txnId })
    .from(schema.ledgerReconMatches)
    .where(
      and(
        eq(schema.ledgerReconMatches.tenantId, ctx.tenantId),
        sql`${schema.ledgerReconMatches.state} in ('proposed','confirmed')`
      )
    );
  const taken = new Set(already.map((a) => a.txnId).filter(Boolean));

  return rows
    .filter((r) => !taken.has(r.id))
    .map((r) => ({
      txnId: r.id,
      type: r.type,
      amountMinor: r.grossMinor,
      currency: r.currency,
      reference: r.idempotencyKey,
      postedAt: r.createdAt
    }));
}

/**
 * Runs all three passes and records every outcome — matched, varied and
 * unmatched — as rows, because "we could not match it" is the finding a
 * reviewer needs, not an absence of data.
 */
export async function reconcile(ctx: Ctx, input: ReconInput): Promise<ReconResult> {
  if (!input.lines.length) throw badRequest("statement has no lines");
  const runId = id("rcr", ctx.now);
  const tolerance = input.toleranceMinor ?? DEFAULT_TOLERANCE[input.process];

  await ctx.db.insert(schema.ledgerReconRuns).values({
    id: runId,
    tenantId: ctx.tenantId,
    process: input.process,
    period: input.period,
    ...(input.counterpartyRef ? { counterpartyRef: input.counterpartyRef } : {}),
    ...(input.statementFileId ? { statementFileId: input.statementFileId } : {}),
    currency: input.currency,
    state: "running",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });

  const pool = await candidates(ctx, input);
  const byRef = new Map<string, ReconCandidate[]>();
  for (const c of pool) {
    const list = byRef.get(c.reference) ?? [];
    list.push(c);
    byRef.set(c.reference, list);
  }
  const consumed = new Set<string>();
  const rows: (typeof schema.ledgerReconMatches.$inferInsert)[] = [];
  const remaining: StatementLine[] = [];

  const record = (
    line: StatementLine,
    c: ReconCandidate | undefined,
    method: MatchMethod,
    state: "proposed" | "confirmed" | "unmatched",
    confidence?: number,
    reasonCode?: string
  ) => {
    rows.push({
      id: id("rcm", ctx.now),
      tenantId: ctx.tenantId,
      runId,
      statementLineRef: line.ref,
      ...(c ? { txnId: c.txnId } : {}),
      amountMinor: line.amountMinor,
      currency: line.currency,
      deltaMinor: c ? line.amountMinor - c.amountMinor : line.amountMinor,
      method,
      ...(confidence !== undefined ? { confidence } : {}),
      state,
      ...(reasonCode ? { reasonCode } : {}),
      // A deterministic match needs no human: exact reference and exact amount
      // is not a judgement call. Everything else waits for a reviewer.
      ...(state === "confirmed" ? { confirmedBy: "system:recon", confirmedAt: ctx.now } : {}),
      createdAt: ctx.now
    });
    if (c) consumed.add(c.txnId);
  };

  // pass 1 — exact
  const afterExact: StatementLine[] = [];
  for (const line of input.lines) {
    const c = (byRef.get(line.ourRef ?? "") ?? []).find(
      (x) => !consumed.has(x.txnId) && x.amountMinor === line.amountMinor
    );
    if (c) record(line, c, "deterministic", "confirmed", 100);
    else afterExact.push(line);
  }

  // pass 2 — same reference, amount within tolerance
  const afterTolerance: StatementLine[] = [];
  for (const line of afterExact) {
    const c =
      tolerance > 0
        ? (byRef.get(line.ourRef ?? "") ?? []).find(
            (x) => !consumed.has(x.txnId) && Math.abs(x.amountMinor - line.amountMinor) <= tolerance
          )
        : undefined;
    if (c) record(line, c, "tolerance", "proposed", 90, "within_tolerance");
    else afterTolerance.push(line);
  }

  // pass 3 — AI proposal over whatever is left, never auto-confirmed
  if (input.propose && afterTolerance.length) {
    const open = pool.filter((c) => !consumed.has(c.txnId));
    const proposals = await input.propose(afterTolerance, open);
    const byStatementRef = new Map(proposals.map((p) => [p.statementRef, p]));
    for (const line of afterTolerance) {
      const p = byStatementRef.get(line.ref);
      const c = p ? open.find((x) => x.txnId === p.txnId && !consumed.has(x.txnId)) : undefined;
      if (p && c && p.confidence >= AI_CONFIRM_FLOOR) {
        record(line, c, "ai_proposed", "proposed", p.confidence, p.reasonCode ?? "ai_match");
      } else {
        remaining.push(line);
        record(line, undefined, "ai_proposed", "unmatched", p?.confidence ?? 0, "no_confident_match");
      }
    }
  } else {
    for (const line of afterTolerance) {
      remaining.push(line);
      record(line, undefined, "deterministic", "unmatched", 0, "no_match");
    }
  }

  if (rows.length) await ctx.db.insert(schema.ledgerReconMatches).values(rows);
  // The deterministic pass confirms exact matches itself, so they never reach a
  // reviewer. Booking them here is what makes a clean statement post its money
  // (docs/27 F19); everything else waits for decideMatch.
  await settleRun(ctx, runId);

  const matched = rows.filter((r) => r.state !== "unmatched").length;
  const varied = rows.filter((r) => r.state !== "unmatched" && r.deltaMinor !== 0);
  const varianceMinor = varied.reduce((s, r) => s + Math.abs(r.deltaMinor ?? 0), 0);
  const unmatchedTxnIds = pool.filter((c) => !consumed.has(c.txnId)).map((c) => c.txnId);
  // Nothing to review only if every line matched exactly and nothing of ours
  // was left over — otherwise a human closes it.
  const state: "review" | "closed" =
    remaining.length === 0 && varied.length === 0 && unmatchedTxnIds.length === 0 ? "closed" : "review";

  await ctx.db
    .update(schema.ledgerReconRuns)
    .set({
      matchedCount: matched,
      varianceCount: varied.length + remaining.length + unmatchedTxnIds.length,
      varianceMinor,
      state,
      updatedAt: ctx.now,
      ...(state === "closed" ? { closedBy: "system:recon" } : {})
    })
    .where(eq(schema.ledgerReconRuns.id, runId));
  if (state === "closed") await announceCompleted(ctx, await reconSummary(ctx, runId));

  await audit(ctx, {
    action: "ledger.recon.run",
    subjectRef: `recon:${runId}`,
    after: {
      process: input.process,
      period: input.period,
      matched,
      variances: varied.length,
      varianceMinor,
      unmatched: remaining.length,
      ourUnmatched: unmatchedTxnIds.length
    }
  });

  return {
    runId,
    matched,
    variances: varied.length,
    varianceMinor,
    unmatchedStatementRefs: remaining.map((l) => l.ref),
    unmatchedTxnIds,
    state
  };
}

/* ----------------------------------------------- booking what was matched */

/**
 * docs/19 §6, insurer statement recon: the process's outputs are "matched,
 * variance, missing-both-ways queues; **`CMSN-SETL` postings**". docs/27 F19
 * found the last clause unimplemented — the engine updated match state and
 * moved no money, so a reconciled month left the commission receivable
 * untouched and the cash unrecorded.
 *
 * Three rules the shape has to respect.
 *
 * **Only the insurer process posts.** A client-money reconciliation proves
 * segregation and moves nothing of ours; a PSP or media recon has its own
 * economics and its own recipe. Booking a commission settlement for either
 * would be an invention.
 *
 * **The statement's amount is what clears, not ours.** A match inside tolerance
 * has a delta by definition, and the insurer paid what the insurer paid: the
 * shortfall stays on `1100` as the variance it is, for a controller to chase or
 * write off. A recon that closed the gap itself would be a recon that can never
 * report one.
 *
 * **`recon-setl:{matchId}` is the idempotency key.** A confirmation followed by
 * a run close, or a close run twice, posts exactly once — the key is the match,
 * and a match is confirmed once.
 */
async function bookMatchSettlement(
  ctx: Ctx,
  match: typeof schema.ledgerReconMatches.$inferSelect,
  process: ReconProcess
): Promise<string | null> {
  if (process !== "insurer") return null;
  if (match.settlementTxnId) return match.settlementTxnId;
  if (!match.txnId) return null; // nothing of ours was matched: no receivable to clear

  const txn = await runTxn(
    ctx,
    {
      type: "CMSN-SETL",
      idempotencyKey: `recon-setl:${match.id}`,
      currency: match.currency,
      grossMinor: match.amountMinor,
      correlationId: match.runId,
      subjectRefs: { reconMatch: match.id, accrual: match.txnId }
    },
    {
      recipe: {
        lines: buildRecipe("CMSN-SETL", {
          amountMinor: match.amountMinor,
          memo: `insurer statement ${match.statementLineRef ?? match.id}`,
          dims: { reconRun: match.runId, reconMatch: match.id }
        }),
        currency: match.currency
      },
      event: { name: "ledger.txn.cmsn-setl.settled" }
    }
  );

  await ctx.db
    .update(schema.ledgerReconMatches)
    .set({ settlementTxnId: txn.id })
    .where(
      and(eq(schema.ledgerReconMatches.tenantId, ctx.tenantId), eq(schema.ledgerReconMatches.id, match.id))
    );
  return txn.id;
}

/** The run's process, which decides whether a confirmed match books anything. */
async function processOf(ctx: Ctx, runId: string): Promise<ReconProcess> {
  const [r] = await ctx.db
    .select({ process: schema.ledgerReconRuns.process })
    .from(schema.ledgerReconRuns)
    .where(and(eq(schema.ledgerReconRuns.tenantId, ctx.tenantId), eq(schema.ledgerReconRuns.id, runId)))
    .limit(1);
  if (!r) throw notFound(`recon run ${runId}`);
  return r.process as ReconProcess;
}

/**
 * Book every confirmed match in a run that has not been booked yet. This is the
 * half `decideMatch` alone cannot cover: the deterministic pass confirms an
 * exact match itself and never reaches a reviewer, so a perfectly clean
 * statement would otherwise post nothing at all.
 */
export async function settleRun(ctx: Ctx, runId: string): Promise<string[]> {
  const process = await processOf(ctx, runId);
  if (process !== "insurer") return [];
  const rows = await ctx.db
    .select()
    .from(schema.ledgerReconMatches)
    .where(
      and(
        eq(schema.ledgerReconMatches.tenantId, ctx.tenantId),
        eq(schema.ledgerReconMatches.runId, runId),
        eq(schema.ledgerReconMatches.state, "confirmed"),
        isNull(schema.ledgerReconMatches.settlementTxnId)
      )
    );
  const booked: string[] = [];
  for (const m of rows) {
    const txnId = await bookMatchSettlement(ctx, m, process);
    if (txnId) booked.push(txnId);
  }
  return booked;
}

/** A reviewer's decision on one proposed match. Confirmations are audited individually. */
export async function decideMatch(
  ctx: Ctx,
  matchId: string,
  decision: "confirmed" | "rejected",
  reasonCode?: string
): Promise<void> {
  const found = await ctx.db
    .select()
    .from(schema.ledgerReconMatches)
    .where(and(eq(schema.ledgerReconMatches.tenantId, ctx.tenantId), eq(schema.ledgerReconMatches.id, matchId)))
    .limit(1);
  const m = found[0];
  if (!m) throw notFound(`recon match ${matchId}`);
  if (m.state === "confirmed" || m.state === "rejected") {
    throw conflict(`match ${matchId} is already ${m.state}`);
  }

  await ctx.db
    .update(schema.ledgerReconMatches)
    .set({
      state: decision,
      confirmedBy: actorRef(ctx),
      confirmedAt: ctx.now,
      ...(reasonCode ? { reasonCode } : {})
    })
    .where(eq(schema.ledgerReconMatches.id, matchId));

  // docs/27 F19. The confirmation is the money decision, so the posting happens
  // here rather than in a later sweep nobody would run: a match confirmed and
  // unbooked is a receivable that reads as settled and is not.
  const settlementTxnId =
    decision === "confirmed"
      ? await bookMatchSettlement(
          ctx,
          { ...m, state: decision, confirmedBy: actorRef(ctx), confirmedAt: ctx.now },
          await processOf(ctx, m.runId)
        )
      : null;

  await audit(ctx, {
    action: `ledger.recon.${decision}`,
    subjectRef: `recon_match:${matchId}`,
    before: { state: m.state, method: m.method, confidence: m.confidence },
    after: { state: decision, deltaMinor: m.deltaMinor, reasonCode, settlementTxnId }
  });
}

export interface ReconSummary {
  runId: string;
  process: string;
  period: string;
  state: string;
  matchedCount: number;
  varianceCount: number;
  varianceMinor: number;
  currency: string;
  open: number;
}

export async function reconSummary(ctx: Ctx, runId: string): Promise<ReconSummary> {
  const found = await ctx.db
    .select()
    .from(schema.ledgerReconRuns)
    .where(and(eq(schema.ledgerReconRuns.tenantId, ctx.tenantId), eq(schema.ledgerReconRuns.id, runId)))
    .limit(1);
  const r = found[0];
  if (!r) throw notFound(`recon run ${runId}`);

  const open = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.ledgerReconMatches)
    .where(
      and(
        eq(schema.ledgerReconMatches.tenantId, ctx.tenantId),
        eq(schema.ledgerReconMatches.runId, runId),
        sql`${schema.ledgerReconMatches.state} in ('proposed','unmatched')`
      )
    );

  return {
    runId,
    process: r.process,
    period: r.period,
    state: r.state,
    matchedCount: r.matchedCount,
    varianceCount: r.varianceCount,
    varianceMinor: r.varianceMinor,
    currency: r.currency,
    open: open[0]?.n ?? 0
  };
}

/**
 * A run closes only when nothing is left open. Forcing it past that would make
 * "closed" mean nothing, so there is no force flag here — reject the stragglers
 * with a reason instead.
 */
export async function closeRun(ctx: Ctx, runId: string): Promise<void> {
  const s = await reconSummary(ctx, runId);
  if (s.open > 0) throw conflict(`recon run ${runId} still has ${s.open} open matches`);
  // Nothing may be declared reconciled while a confirmed match is still unbooked.
  await settleRun(ctx, runId);
  await ctx.db
    .update(schema.ledgerReconRuns)
    .set({ state: "closed", closedBy: actorRef(ctx), updatedAt: ctx.now })
    .where(eq(schema.ledgerReconRuns.id, runId));
  await audit(ctx, { action: "ledger.recon.close", subjectRef: `recon:${runId}`, after: { ...s, state: "closed" } });
  // Re-closing a closed run books nothing new (settleRun is idempotent) and is
  // not a second completion.
  if (s.state !== "closed") await announceCompleted(ctx, { ...s, state: "closed" });
}

/**
 * A run reaching `closed` — on either path: the deterministic pass closing a
 * clean statement itself, or closeRun after review. The seeded ops webhook
 * subscribes to this; before it existed nothing said a reconciliation ended.
 */
async function announceCompleted(ctx: Ctx, s: ReconSummary): Promise<void> {
  await emit(ctx, {
    module: "ledger",
    type: "ledger.recon.completed",
    subject: `recon:${s.runId}`,
    data: {
      runId: s.runId,
      process: s.process,
      period: s.period,
      currency: s.currency,
      matchedCount: s.matchedCount,
      varianceCount: s.varianceCount,
      varianceMinor: s.varianceMinor
    }
  });
}

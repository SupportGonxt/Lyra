import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  conflict,
  emit,
  gate,
  require_,
  suspenseAccounts,
  tenantChartMap,
  type Ctx
} from "@lyra/core";
import { PAYABLE_AGING_ACCOUNTS, RECEIVABLE_AGING_ACCOUNTS } from "./reports.js";

// docs/19 §6. open → soft_closed (adjustments, reason required) → hard_closed
// (contra postings only). A period is created on first posting into it, so
// nobody has to remember to open next month.

/**
 * A check detail is read by the controller who has to clear it, and "1
 * transactions still waiting on a provider" reads as a bug in the ledger
 * rather than one stuck payment.
 */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export type PeriodState = "open" | "soft_closed" | "hard_closed";

export interface Period {
  id: string;
  code: string;
  startAt: number;
  endAt: number;
  state: PeriodState;
}

/**
 * UTC month. Financial periods do not move with a tenant's timezone.
 *
 * Fail-closed on an instant no `Date` can hold, rather than degrading to a
 * marker the way a renderer does: the return value names the period a batch
 * posts into, and a batch filed under a made-up period is worse than a batch
 * refused. Every caller passes `ctx.now` today, but `post()` takes a caller's
 * `postedAt` and this is exported — unguarded it threw a bare `RangeError:
 * Invalid time value` from the middle of a posting.
 */
export function periodCode(at: number): string {
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) throw badRequest(`not an instant a Date can hold: ${at}`);
  return new Date(at).toISOString().slice(0, 7);
}

function bounds(code: string): { startAt: number; endAt: number } {
  const [y, m] = code.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) throw badRequest(`bad period code ${code}`);
  return { startAt: Date.UTC(y, m - 1, 1), endAt: Date.UTC(y, m, 1) - 1 };
}

export async function ensurePeriod(ctx: Ctx, code: string): Promise<Period> {
  const where = and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, code));
  const found = await ctx.db.select().from(schema.ledgerPeriods).where(where).limit(1);
  if (found[0]) return found[0] as Period;

  const row = { id: id("per", ctx.now), tenantId: ctx.tenantId, code, ...bounds(code), state: "open" as const };
  try {
    await ctx.db.insert(schema.ledgerPeriods).values(row);
    return row;
  } catch {
    // Concurrent first posting into the same month; the unique index picked a winner.
    const again = await ctx.db.select().from(schema.ledgerPeriods).where(where).limit(1);
    if (!again[0]) throw conflict(`period ${code} lost a race and did not reappear`);
    return again[0] as Period;
  }
}

/**
 * Whether this batch may land in this period. `contra` marks a reversal batch,
 * which is the one thing a hard-closed period still accepts (docs/19 §6) —
 * an audit correction must never be blocked by the calendar.
 */
export function assertPostable(p: Period, opts: { contra?: boolean; reason?: string } = {}): void {
  if (p.state === "open") return;
  if (p.state === "hard_closed" && !opts.contra) {
    throw conflict(`period ${p.code} is hard closed; post a contra batch instead`);
  }
  if (p.state === "soft_closed" && !opts.contra && !opts.reason) {
    throw badRequest(`period ${p.code} is soft closed; an adjustment reason is required`);
  }
}

export interface CloseCheck {
  name: string;
  ok: boolean;
  detail?: string | undefined;
}

/**
 * The close checklist runs the invariants that must hold before a month is
 * frozen. It reads the balances table rather than re-summing lines; reports.ts
 * has the from-lines rebuild used to prove the two agree.
 */
export async function closeChecks(ctx: Ctx, code: string): Promise<CloseCheck[]> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerAccountBalances)
    .where(eq(schema.ledgerAccountBalances.tenantId, ctx.tenantId));

  const checks: CloseCheck[] = [];
  const byCurrency = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    const acc = byCurrency.get(r.currency) ?? { debit: 0, credit: 0 };
    acc.debit += r.baseDebitMinor;
    acc.credit += r.baseCreditMinor;
    byCurrency.set(r.currency, acc);
  }
  let debit = 0;
  let credit = 0;
  for (const v of byCurrency.values()) {
    debit += v.debit;
    credit += v.credit;
  }
  checks.push({
    name: "trial_balance_zero",
    ok: debit === credit,
    detail: debit === credit ? undefined : `base debits ${debit} vs credits ${credit}`
  });

  // A header that disagrees with its own lines is the fingerprint of a write
  // that landed in pieces. post() is atomic now (docs/19 §5), so this can only
  // catch damage that predates it — which is exactly the point: the month must
  // not freeze over a tear nobody has looked at.
  const debitLines = sql<number>`coalesce(sum(case when ${schema.ledgerJournalLines.side} = 'debit' then ${schema.ledgerJournalLines.amountMinor} else 0 end), 0)`;
  const creditLines = sql<number>`coalesce(sum(case when ${schema.ledgerJournalLines.side} = 'credit' then ${schema.ledgerJournalLines.amountMinor} else 0 end), 0)`;
  const torn = await ctx.db
    .select({ id: schema.ledgerJournalBatches.id })
    .from(schema.ledgerJournalBatches)
    .leftJoin(
      schema.ledgerJournalLines,
      and(
        eq(schema.ledgerJournalLines.tenantId, schema.ledgerJournalBatches.tenantId),
        eq(schema.ledgerJournalLines.batchId, schema.ledgerJournalBatches.id)
      )
    )
    .where(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId))
    .groupBy(schema.ledgerJournalBatches.id)
    .having(
      sql`${schema.ledgerJournalBatches.totalDebitMinor} <> ${debitLines} or ${schema.ledgerJournalBatches.totalCreditMinor} <> ${creditLines}`
    );
  checks.push({
    name: "batches_match_lines",
    ok: torn.length === 0,
    detail: torn.length
      ? `${plural(torn.length, "batch disagrees", "batches disagree")} with their lines: ${torn.map((t) => t.id).join(", ")}`
      : undefined
  });

  const unsettled = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.state, "pending_external")));
  const stuck = unsettled[0]?.n ?? 0;
  checks.push({
    name: "no_pending_external",
    ok: stuck === 0,
    detail: stuck ? `${plural(stuck, "transaction", "transactions")} still waiting on a provider` : undefined
  });

  const breaches = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.ledgerClientMoneyChecks)
    .where(
      and(
        eq(schema.ledgerClientMoneyChecks.tenantId, ctx.tenantId),
        eq(schema.ledgerClientMoneyChecks.breach, true),
        isNull(schema.ledgerClientMoneyChecks.resolvedAt)
      )
    );
  const open = breaches[0]?.n ?? 0;
  checks.push({
    name: "no_open_client_money_breach",
    ok: open === 0,
    detail: open ? `${plural(open, "client-money breach", "client-money breaches")} recorded` : undefined
  });

  // ADR-0083. Three checks docs/27 P2 named as missing, in the same
  // deterministic-and-global style as the four above.

  // subledger_ties_to_control: the receivable/payable open-item subledger
  // (reports.ts's own account sets) is summed directly from
  // ledger_journal_lines — the source of truth — and compared to the same
  // accounts' rows in ledger_account_balances, the incrementally maintained
  // cache trialBalance_zero already trusts. A mismatch means the cache has
  // drifted from the lines it is supposed to mirror (rebuildBalances is the
  // repair), never a difference the tenant's own subledger is allowed to hold.
  const controlledCodes = [...RECEIVABLE_AGING_ACCOUNTS, ...PAYABLE_AGING_ACCOUNTS] as const;
  const chartMap = await tenantChartMap(ctx);
  const lineSums = await ctx.db
    .select({
      accountCode: schema.ledgerJournalLines.accountCode,
      side: schema.ledgerJournalLines.side,
      total: sql<number>`coalesce(sum(${schema.ledgerJournalLines.baseAmountMinor}), 0)`
    })
    .from(schema.ledgerJournalLines)
    .where(
      and(
        eq(schema.ledgerJournalLines.tenantId, ctx.tenantId),
        inArray(schema.ledgerJournalLines.accountCode, [...controlledCodes])
      )
    )
    .groupBy(schema.ledgerJournalLines.accountCode, schema.ledgerJournalLines.side);
  const balanceSums = await ctx.db
    .select({
      accountCode: schema.ledgerAccountBalances.accountCode,
      debit: sql<number>`coalesce(sum(${schema.ledgerAccountBalances.baseDebitMinor}), 0)`,
      credit: sql<number>`coalesce(sum(${schema.ledgerAccountBalances.baseCreditMinor}), 0)`
    })
    .from(schema.ledgerAccountBalances)
    .where(
      and(
        eq(schema.ledgerAccountBalances.tenantId, ctx.tenantId),
        inArray(schema.ledgerAccountBalances.accountCode, [...controlledCodes])
      )
    )
    .groupBy(schema.ledgerAccountBalances.accountCode);

  const netSigned = (code: string, debit: number, credit: number): number =>
    (chartMap.get(code)?.normalSide ?? "debit") === "debit" ? debit - credit : credit - debit;
  const fromLines = (code: string): number => {
    const d = lineSums.find((r) => r.accountCode === code && r.side === "debit")?.total ?? 0;
    const c = lineSums.find((r) => r.accountCode === code && r.side === "credit")?.total ?? 0;
    return netSigned(code, Number(d), Number(c));
  };
  const fromControl = (code: string): number => {
    const row = balanceSums.find((r) => r.accountCode === code);
    return netSigned(code, Number(row?.debit ?? 0), Number(row?.credit ?? 0));
  };
  const untied = controlledCodes.filter((code) => fromLines(code) !== fromControl(code));
  checks.push({
    name: "subledger_ties_to_control",
    ok: untied.length === 0,
    detail: untied.length
      ? `${plural(untied.length, "account", "accounts")} where the subledger disagrees with its GL control balance: ${untied.join(", ")}`
      : undefined
  });

  // recon_complete: every reconciliation run touching the period being closed
  // must have reached recon.ts's own terminal state, `closed` — reused as-is,
  // no new status introduced.
  const openRuns = await ctx.db
    .select({ n: sql<number>`count(*)`, process: schema.ledgerReconRuns.process, counterpartyRef: schema.ledgerReconRuns.counterpartyRef })
    .from(schema.ledgerReconRuns)
    .where(
      and(
        eq(schema.ledgerReconRuns.tenantId, ctx.tenantId),
        eq(schema.ledgerReconRuns.period, code),
        ne(schema.ledgerReconRuns.state, "closed")
      )
    )
    .groupBy(schema.ledgerReconRuns.process, schema.ledgerReconRuns.counterpartyRef);
  const unresolvedRuns = openRuns.reduce((n, r) => n + Number(r.n), 0);
  checks.push({
    name: "recon_complete",
    ok: unresolvedRuns === 0,
    detail: unresolvedRuns
      ? `${plural(unresolvedRuns, "reconciliation run", "reconciliation runs")} for ${code} not yet closed: ${openRuns
          .map((r) => `${r.process}${r.counterpartyRef ? `/${r.counterpartyRef}` : ""}`)
          .join(", ")}`
      : undefined
  });

  // no_suspense_balance: a clearing/suspense account (ADR-0083 §3, e.g. 1300
  // PSP Clearing) must net to zero across currencies at the moment the month
  // is frozen — an outstanding balance there is an unexplained difference,
  // not a position anyone is meant to hold.
  const suspense = await suspenseAccounts(ctx);
  const outstandingSuspense: string[] = [];
  if (suspense.length) {
    const rows = await ctx.db
      .select()
      .from(schema.ledgerAccountBalances)
      .where(
        and(
          eq(schema.ledgerAccountBalances.tenantId, ctx.tenantId),
          inArray(
            schema.ledgerAccountBalances.accountCode,
            suspense.map((a) => a.code)
          )
        )
      );
    const byCode = new Map<string, { debit: number; credit: number }>();
    for (const r of rows) {
      const acc = byCode.get(r.accountCode) ?? { debit: 0, credit: 0 };
      acc.debit += r.baseDebitMinor;
      acc.credit += r.baseCreditMinor;
      byCode.set(r.accountCode, acc);
    }
    for (const a of suspense) {
      const b = byCode.get(a.code) ?? { debit: 0, credit: 0 };
      const net = a.normalSide === "debit" ? b.debit - b.credit : b.credit - b.debit;
      if (net !== 0) outstandingSuspense.push(`${a.code} (${net})`);
    }
  }
  checks.push({
    name: "no_suspense_balance",
    ok: outstandingSuspense.length === 0,
    detail: outstandingSuspense.length
      ? `suspense account balance outstanding: ${outstandingSuspense.join(", ")}`
      : undefined
  });

  return checks.map((c) => ({ ...c, name: `${c.name}@${code}` }));
}

/**
 * docs/27 F20. A forced close accepts a break the checklist found, so the one
 * thing an auditor will ask for is *which* break and *why* — and `force` was a
 * bare boolean off the request body with neither. Ten characters is the same
 * floor a manual journal's reason carries (recipes.ts AuthoredArgs): enough to
 * be a sentence, not enough to be a keystroke.
 */
export const FORCE_REASON_MIN = 10;

/** Soft close first, always: hard closing straight from open skips the checklist. */
export async function closePeriod(
  ctx: Ctx,
  code: string,
  to: "soft_closed" | "hard_closed",
  opts: { force?: boolean; reason?: string; preApproved?: boolean } = {}
): Promise<Period> {
  // Before anything is read: a force with no reason is not a request this
  // function can carry out, whoever is asking and whatever the month looks like.
  if (opts.force && (opts.reason ?? "").trim().length < FORCE_REASON_MIN) {
    throw badRequest(
      `forcing a close requires a reason of at least ${FORCE_REASON_MIN} characters naming the break being accepted`
    );
  }
  // Authorisation first: a seat that may not close the month should be told so
  // before it learns anything about the month's state.
  if (!opts.preApproved) {
    require_(ctx.actor, opts.force ? "ledger:periods:force_close" : "ledger:periods:close", {
      tenantId: ctx.tenantId,
      module: "ledger"
    });
  }
  const p = await ensurePeriod(ctx, code);
  if (p.state === "hard_closed") throw conflict(`period ${code} is already hard closed`);
  if (to === "hard_closed" && p.state !== "soft_closed") {
    throw conflict(`period ${code} must be soft closed before it is hard closed`);
  }

  const checks = await closeChecks(ctx, code);
  const failed = checks.filter((c) => !c.ok);
  // force exists for the genuine "known and accepted break" case; it is audited
  // with the failing checks so the override is never invisible.
  if (failed.length && !opts.force) {
    throw conflict(`close checks failed: ${failed.map((c) => c.name).join(", ")}`);
  }
  // A force over a clean month overrides nothing. Accepting it silently is how
  // `force: true` becomes the shape of every request: the caller learns it is
  // harmless, and the day it *isn't* harmless nobody notices. So it is refused.
  if (opts.force && !failed.length) {
    throw conflict(`period ${code} passes every close check; there is nothing to force`);
  }

  // docs/specs/gap-finance-design.md D10. The gate lives here rather than in the
  // route, because a close reached from a scheduler or a year-end run is the
  // same act as a close reached from a button. Forcing is its own policy: it
  // accepts a break the checklist found, which is a different decision from
  // signing off a clean month.
  if (!opts.preApproved) {
    await gate(ctx, {
      policyKey: opts.force ? "ledger.period_close_force" : "ledger.period_close",
      subjectRef: `period:${code}`,
      // The approver is being asked to accept specific breaks, so the request
      // they see names them — an approval screen showing only "force close May"
      // is asking for a signature on an unread document.
      ...(opts.force
        ? {
            context: {
              reason: opts.reason,
              overrode: failed.map((c) => c.name),
              detail: failed.map((c) => c.detail).filter(Boolean)
            }
          }
        : {})
    });
  }

  await ctx.db
    .update(schema.ledgerPeriods)
    .set({
      state: to,
      checklistJson: JSON.stringify(checks),
      stateReason: opts.force
        ? `forced: ${opts.reason} (overrode ${failed.map((c) => c.name).join(", ")})`
        : (opts.reason ?? null),
      closedBy: actorRef(ctx),
      closedAt: ctx.now
    })
    .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, code)));

  await audit(ctx, {
    action: "ledger.period.close",
    subjectRef: `period:${code}`,
    before: { state: p.state },
    after: {
      state: to,
      checks,
      forced: Boolean(opts.force),
      ...(opts.force ? { forceReason: opts.reason, overrode: failed.map((c) => c.name) } : {})
    }
  });
  // docs/30 Ledger gap 3: a signed-off month is news on the bus, not only in the audit log.
  await emit(ctx, {
    module: "ledger",
    type: "ledger.period.closed",
    subject: `period:${code}`,
    data: { code, from: p.state, to, forced: Boolean(opts.force) }
  });

  return { ...p, state: to };
}

/**
 * Reopen is a separate, higher-privilege act — never a side effect of posting.
 * docs/27 F20 reports it as ungated; the `ledger.period_reopen` policy below
 * closed that. What stayed missing is the same thing `force` was missing: a
 * month that was signed off and is now open again has to say why.
 */
export async function reopenPeriod(
  ctx: Ctx,
  code: string,
  opts: { reason?: string; preApproved?: boolean } = {}
): Promise<Period> {
  const p = await ensurePeriod(ctx, code);
  // An open period is already what the caller wants; nothing is being undone,
  // so there is nothing to justify.
  if (p.state === "open") return p;
  if ((opts.reason ?? "").trim().length < FORCE_REASON_MIN) {
    throw badRequest(
      `reopening a period requires a reason of at least ${FORCE_REASON_MIN} characters`
    );
  }
  if (!opts.preApproved) {
    require_(ctx.actor, "ledger:periods:reopen", { tenantId: ctx.tenantId, module: "ledger" });
    await gate(ctx, {
      policyKey: "ledger.period_reopen",
      subjectRef: `period:${code}`,
      context: { reason: opts.reason, from: p.state }
    });
  }
  await ctx.db
    .update(schema.ledgerPeriods)
    .set({ state: "open", stateReason: `reopened: ${opts.reason}`, closedBy: null, closedAt: null })
    .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), eq(schema.ledgerPeriods.code, code)));
  await audit(ctx, {
    action: "ledger.period.reopen",
    subjectRef: `period:${code}`,
    before: { state: p.state },
    after: { state: "open", reason: opts.reason }
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.period.reopened",
    subject: `period:${code}`,
    data: { code, from: p.state, reason: opts.reason }
  });
  return { ...p, state: "open" };
}

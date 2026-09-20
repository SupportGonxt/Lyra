import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { isoDay } from "@lyra/model-gateway";
import {
  actorRef,
  audit,
  badRequest,
  conflict,
  emit,
  gate,
  notFound,
  scoped,
  sha256Hex,
  type Ctx
} from "@lyra/core";
import { assertPostable, buildRecipe, ensurePeriod, runTxn, type ReportTable } from "@lyra/ledger";
import { render, type BrowserBinding, type ExportFormat, type Rendered } from "./export/render.js";
import { IsoMonth, monthRangeMs } from "../http.js";

// docs/19 §5 — what a channel earned becomes what a channel is paid.
//
// The shape of the month is: run (draft, arithmetic only), approve (the
// business signs the number and the expense is accrued), pay (a second
// signature moves cash). Nothing here writes a journal line directly; every
// money move runs a transaction type, which picks its recipe from RECIPES.
//
// Three rules the code below is built around and none of them bend:
//   * integers only — every amount is minor units, never a float;
//   * a re-run recomputes, it never accumulates, so running a period twice
//     pays it once;
//   * a balance below the payout floor is carried, never dropped: it leaves
//     as a negative adjustment on this settlement and arrives as opening
//     carry on the next, so `gross + adjustments === net` always holds.

/**
 * Kinds this engine settles: money the tenant owes outwards. `insurer` is the
 * mirror image — money in, collected by CMSN-SETL against a provider
 * remittance — and its recipes debit cash rather than credit it, so it is
 * refused here rather than half-handled.
 */
export const PAYABLE_KINDS = ["partner", "creator", "publisher"] as const;
export type PayableKind = (typeof PAYABLE_KINDS)[number];

/**
 * No PSP connector exists here (docs/25 §7 — credential-gated, out of scope).
 * The v1 payout control is a human-confirmed bank/PSP reference: proof money
 * actually left the building, checked before `paid` can be written at all.
 */
export const PAID_VIA = ["bank_transfer", "psp", "other"] as const;
export type PaidVia = (typeof PAID_VIA)[number];

export interface PaySettlementInput {
  /** Transfer confirmation number, PSP payout id, or similar. */
  externalRef: string;
  paidVia: PaidVia;
}

function assertPayment(input: PaySettlementInput): void {
  if (!input.externalRef?.trim()) throw badRequest("externalRef is required to mark a settlement paid");
  if (!(PAID_VIA as readonly string[]).includes(input.paidVia)) {
    throw badRequest(`paidVia must be one of ${PAID_VIA.join(", ")}`);
  }
}

/** Entry states that are no longer money: written off is a decision, not a debt. */
const EXCLUDED_ENTRY_STATE = "written_off";

export interface RunSettlementInput {
  counterpartyKind: string;
  /** `channel:{channelId}` — the dimension commission entries are booked against. */
  counterpartyRef: string;
  /** `YYYY-MM`. */
  period: string;
  currency?: string | undefined;
}

export type SettlementRow = typeof schema.ledgerSettlements.$inferSelect;
type EntryRow = typeof schema.distCommissionEntries.$inferSelect;

export interface SettlementTerms {
  /** Below this, the balance carries to the next period instead of paying out. */
  minPayoutMinor: number;
  agreementId: string | null;
  agreementVersion: number | null;
}

/* ------------------------------------------------------------------ inputs */

// One month validator and one bounds helper for the whole API, both in http.ts.
// This file used to carry its own pair; they drifted from the bordereaux pair
// on the month axis and agreed with it on the century bug, which is how a
// review round guards one and misses the other.
function assertPeriodCode(period: string): void {
  if (!IsoMonth.safeParse(period).success) throw badRequest(`period must be YYYY-MM, got ${period}`);
}

function monthBounds(period: string): { startAt: number; endAt: number } {
  const { start, end } = monthRangeMs(period);
  return { startAt: start, endAt: end };
}

function assertPayable(kind: string): PayableKind {
  if (!(PAYABLE_KINDS as readonly string[]).includes(kind)) {
    throw badRequest(
      `${kind} settlements are money in, not out; collect them with CMSN-SETL against the provider remittance`
    );
  }
  return kind as PayableKind;
}

/** The channel dimension a settlement aggregates. */
function channelOf(counterpartyRef: string): string {
  const channelId = counterpartyRef.startsWith("channel:") ? counterpartyRef.slice("channel:".length) : "";
  if (!channelId) throw badRequest(`counterpartyRef must be channel:{id}, got ${counterpartyRef}`);
  return channelId;
}

/** The provider dimension an insurer (money-in) settlement's ref names. */
function providerOf(counterpartyRef: string): string {
  const providerId = counterpartyRef.startsWith("provider:") ? counterpartyRef.slice("provider:".length) : "";
  if (!providerId) throw badRequest(`counterpartyRef must be provider:{id}, got ${counterpartyRef}`);
  return providerId;
}

/* ------------------------------------------------------------------- terms */

function readMinPayout(json: string | null): number | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as { settlement?: { minPayoutMinor?: unknown } };
    const value = parsed.settlement?.minPayoutMinor;
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The terms this period is priced under: the signed agreement first, the
 * partner's revenue-share config as the fallback for partners who predate
 * agreement versioning, zero when neither says.
 *
 * ponytail: partners are matched to a channel by scanning `revshare_json`,
 * because the link lives inside that JSON and there is no column to index. A
 * tenant has tens of partners, not thousands — add `orbit_partners.channel_id`
 * if that stops being true.
 */
export async function resolveTerms(ctx: Ctx, channelId: string): Promise<SettlementTerms> {
  const partners = await ctx.db
    .select({ id: schema.orbitPartners.id, revshareJson: schema.orbitPartners.revshareJson })
    .from(schema.orbitPartners)
    .where(scoped(ctx, schema.orbitPartners));

  const partner = partners.find((p) => {
    if (!p.revshareJson) return false;
    try {
      return (JSON.parse(p.revshareJson) as { channelId?: string }).channelId === channelId;
    } catch {
      return false;
    }
  });
  if (!partner) return { minPayoutMinor: 0, agreementId: null, agreementVersion: null };

  const [agreement] = await ctx.db
    .select()
    .from(schema.distPartnerAgreements)
    .where(
      scoped(
        ctx,
        schema.distPartnerAgreements,
        eq(schema.distPartnerAgreements.partnerId, partner.id),
        eq(schema.distPartnerAgreements.state, "active")
      )
    )
    .orderBy(sql`${schema.distPartnerAgreements.version} desc`)
    .limit(1);

  const fromAgreement = agreement ? readMinPayout(agreement.termsJson) : undefined;
  const fromPartner = readMinPayout(partner.revshareJson);
  return {
    minPayoutMinor: fromAgreement ?? fromPartner ?? 0,
    agreementId: agreement?.id ?? null,
    agreementVersion: agreement?.version ?? null
  };
}

/* ------------------------------------------------------------- aggregation */

async function findSettlement(
  ctx: Ctx,
  kind: string,
  counterpartyRef: string,
  period: string
): Promise<SettlementRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(schema.ledgerSettlements)
    .where(
      scoped(
        ctx,
        schema.ledgerSettlements,
        eq(schema.ledgerSettlements.counterpartyKind, kind),
        eq(schema.ledgerSettlements.counterpartyRef, counterpartyRef),
        eq(schema.ledgerSettlements.period, period)
      )
    )
    .limit(1);
  return row;
}

export async function getSettlement(ctx: Ctx, settlementId: string): Promise<SettlementRow> {
  const [row] = await ctx.db
    .select()
    .from(schema.ledgerSettlements)
    .where(scoped(ctx, schema.ledgerSettlements, eq(schema.ledgerSettlements.id, settlementId)))
    .limit(1);
  if (!row) throw notFound("settlement");
  return row;
}

/**
 * The entries a settlement is made of: everything booked to this channel that
 * has not already been paid out, up to the end of the period. Entries earned
 * before the period are the carry — a month whose balance sat under the floor
 * left them unstamped precisely so this query sweeps them up.
 *
 * Clawbacks are stored as their own negative entry (dist writes them that way),
 * so the sum needs no sign handling: adding them up is the adjustment.
 */
export async function settlementEntries(
  ctx: Ctx,
  settlement: Pick<SettlementRow, "id" | "counterpartyRef" | "period" | "currency">
): Promise<EntryRow[]> {
  const { endAt } = monthBounds(settlement.period);
  const earned = sql`coalesce(${schema.distCommissionEntries.earnedAt}, ${schema.distCommissionEntries.createdAt})`;
  return ctx.db
    .select()
    .from(schema.distCommissionEntries)
    .where(
      scoped(
        ctx,
        schema.distCommissionEntries,
        eq(schema.distCommissionEntries.channelId, channelOf(settlement.counterpartyRef)),
        eq(schema.distCommissionEntries.currency, settlement.currency),
        ne(schema.distCommissionEntries.state, EXCLUDED_ENTRY_STATE),
        or(
          isNull(schema.distCommissionEntries.channelSettlementId),
          eq(schema.distCommissionEntries.channelSettlementId, settlement.id)
        ),
        lt(earned, endAt)
      )
    )
    .orderBy(asc(schema.distCommissionEntries.createdAt), asc(schema.distCommissionEntries.id));
}

/**
 * The mirror of `settlementEntries` for the receivable side: everything the
 * given insurer owes us, keyed by `providerId` rather than `channelId` and
 * stamped on `providerSettlementId` rather than `channelSettlementId` — the
 * two columns `dist_commission_entries` already carries for exactly this
 * (docs/27 P2 "no producer statements for insurer-kind counterparties";
 * `PAYABLE_KINDS`'s own comment above named `providerSettlementId` as the
 * insurer mirror before anything read it). No `resolveTerms`: that resolves a
 * *channel's* partner agreement, and an insurer settlement has no channel.
 */
export async function providerSettlementEntries(
  ctx: Ctx,
  settlement: Pick<SettlementRow, "id" | "counterpartyRef" | "period" | "currency">
): Promise<EntryRow[]> {
  const { endAt } = monthBounds(settlement.period);
  const earned = sql`coalesce(${schema.distCommissionEntries.earnedAt}, ${schema.distCommissionEntries.createdAt})`;
  return ctx.db
    .select()
    .from(schema.distCommissionEntries)
    .where(
      scoped(
        ctx,
        schema.distCommissionEntries,
        eq(schema.distCommissionEntries.providerId, providerOf(settlement.counterpartyRef)),
        eq(schema.distCommissionEntries.currency, settlement.currency),
        ne(schema.distCommissionEntries.state, EXCLUDED_ENTRY_STATE),
        or(
          isNull(schema.distCommissionEntries.providerSettlementId),
          eq(schema.distCommissionEntries.providerSettlementId, settlement.id)
        ),
        lt(earned, endAt)
      )
    )
    .orderBy(asc(schema.distCommissionEntries.createdAt), asc(schema.distCommissionEntries.id));
}

function earnedAtOf(e: EntryRow): number {
  return e.earnedAt ?? e.createdAt;
}

export interface SettlementTotals {
  grossMinor: number;
  adjustmentsMinor: number;
  netMinor: number;
  /** What did not clear the floor and moves to the next period. 0 when paying out. */
  carriedForwardMinor: number;
  carryInMinor: number;
}

/**
 * Pure arithmetic over entries, in minor units. Split out so the carry rule is
 * testable without a database and impossible to reach around.
 */
export function totalsFor(entries: readonly EntryRow[], period: string, minPayoutMinor: number): SettlementTotals {
  const { startAt } = monthBounds(period);
  let grossMinor = 0;
  let carryInMinor = 0;
  for (const e of entries) {
    if (earnedAtOf(e) >= startAt) grossMinor += e.channelCommissionMinor;
    else carryInMinor += e.channelCommissionMinor;
  }

  let adjustmentsMinor = carryInMinor;
  let netMinor = grossMinor + carryInMinor;
  let carriedForwardMinor = 0;
  // The floor. Below it — including a month clawbacks pushed negative — nothing
  // is paid and the whole balance moves on. Carrying it out explicitly keeps
  // `gross + adjustments === net` true, so the statement still adds up.
  if (netMinor < minPayoutMinor) {
    carriedForwardMinor = netMinor;
    adjustmentsMinor = carryInMinor - netMinor;
    netMinor = 0;
  }
  return { grossMinor, adjustmentsMinor, netMinor, carriedForwardMinor, carryInMinor };
}

export interface RunResult {
  settlement: SettlementRow;
  totals: SettlementTotals;
  terms: SettlementTerms;
  entryCount: number;
}

/**
 * Draft a period's settlement. Idempotent on the unique index: a second run of
 * the same period recomputes from the same entries and rewrites the same
 * numbers, and a settlement that has already been approved is returned
 * untouched rather than silently restated behind its own posted accrual.
 */
export async function runSettlement(ctx: Ctx, input: RunSettlementInput): Promise<RunResult> {
  const kind = assertPayable(input.counterpartyKind);
  assertPeriodCode(input.period);
  const channelId = channelOf(input.counterpartyRef);
  const currency = input.currency ?? ctx.policy.currency;

  const existing = await findSettlement(ctx, kind, input.counterpartyRef, input.period);
  const terms = await resolveTerms(ctx, channelId);

  if (existing && existing.state !== "draft") {
    const entries = await settlementEntries(ctx, existing);
    return {
      settlement: existing,
      totals: totalsFor(entries, existing.period, terms.minPayoutMinor),
      terms,
      entryCount: entries.length
    };
  }

  const settlementId = existing?.id ?? newId("stl", ctx.now);
  const entries = await settlementEntries(ctx, {
    id: settlementId,
    counterpartyRef: input.counterpartyRef,
    period: input.period,
    currency
  });
  const totals = totalsFor(entries, input.period, terms.minPayoutMinor);

  const row: typeof schema.ledgerSettlements.$inferInsert = {
    id: settlementId,
    tenantId: ctx.tenantId,
    counterpartyKind: kind,
    counterpartyRef: input.counterpartyRef,
    period: input.period,
    grossMinor: totals.grossMinor,
    adjustmentsMinor: totals.adjustmentsMinor,
    netMinor: totals.netMinor,
    currency,
    statementFileId: existing?.statementFileId ?? null,
    state: "draft",
    approvedBy: null,
    txnId: null,
    createdAt: existing?.createdAt ?? ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db
    .insert(schema.ledgerSettlements)
    .values(row)
    .onConflictDoUpdate({
      target: [
        schema.ledgerSettlements.tenantId,
        schema.ledgerSettlements.counterpartyKind,
        schema.ledgerSettlements.counterpartyRef,
        schema.ledgerSettlements.period
      ],
      set: {
        grossMinor: row.grossMinor,
        adjustmentsMinor: row.adjustmentsMinor,
        netMinor: row.netMinor,
        currency: row.currency,
        updatedAt: row.updatedAt
      }
    });

  const settlement = await getSettlement(ctx, settlementId);
  await audit(ctx, {
    action: "ledger.settlement.run",
    subjectRef: settlement.id,
    before: existing,
    after: settlement
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.settlement.drafted",
    subject: settlement.id,
    data: {
      period: input.period,
      counterpartyRef: input.counterpartyRef,
      ...totals,
      minPayoutMinor: terms.minPayoutMinor,
      entries: entries.length
    }
  });
  return { settlement, totals, terms, entryCount: entries.length };
}

/* --------------------------------------------------------------- lifecycle */

/**
 * Refuse a closed month before opening a transaction rather than after. A throw
 * inside `runTxn` lands the transaction in `failed`, and a failed transaction
 * can never be retried — so a calendar problem would permanently burn the
 * settlement's idempotency key.
 */
async function assertPeriodAccepts(ctx: Ctx, settlement: SettlementRow, reason: string): Promise<string> {
  const period = await ensurePeriod(ctx, settlement.period);
  assertPostable(period, { reason });
  return period.code;
}

function dimsOf(settlement: SettlementRow): Record<string, string> {
  return {
    channel: channelOf(settlement.counterpartyRef),
    settlement: settlement.id,
    period: settlement.period
  };
}

/**
 * Sign off the number and accrue the expense. `dist.settlement_run` is the
 * gate: never auto-approved, always dual control, so the person who ran the
 * period is not the person who commits the tenant to paying it.
 */
export async function approveSettlement(ctx: Ctx, settlementId: string): Promise<SettlementRow> {
  const settlement = await getSettlement(ctx, settlementId);
  if (settlement.state !== "draft") throw conflict(`settlement ${settlementId} is ${settlement.state}, not draft`);
  if (settlement.netMinor <= 0) {
    throw conflict(`settlement ${settlementId} has nothing to pay; the balance carried to the next period`);
  }

  // The journal posts the draft's numbers, so the draft must still describe the
  // entry set being stamped. Entries booked (or terms changed) since the run
  // make the draft stale: refuse and re-draft, never pay one total while
  // stamping another (docs/19 §5, CLAUDE.md §12).
  const terms = await resolveTerms(ctx, channelOf(settlement.counterpartyRef));
  const entries = await settlementEntries(ctx, settlement);
  const totals = totalsFor(entries, settlement.period, terms.minPayoutMinor);
  if (
    totals.grossMinor !== settlement.grossMinor ||
    totals.adjustmentsMinor !== settlement.adjustmentsMinor ||
    totals.netMinor !== settlement.netMinor
  ) {
    throw conflict(
      `settlement ${settlementId} is stale: entries changed since the draft; re-run the period before approving`
    );
  }

  const memo = `settlement ${settlement.period} ${settlement.counterpartyRef}`;
  const periodCodeOf = await assertPeriodAccepts(ctx, settlement, memo);

  await gate(ctx, {
    policyKey: "dist.settlement_run",
    subjectRef: `settlement:${settlement.id}`,
    amountMinor: settlement.netMinor,
    context: { period: settlement.period, counterpartyRef: settlement.counterpartyRef }
  });

  const txn = await runTxn(
    ctx,
    {
      type: "RSHARE-ACCR",
      idempotencyKey: `rshare-accr:${settlement.id}`,
      currency: settlement.currency,
      grossMinor: settlement.netMinor,
      subjectRefs: { settlement: settlement.id, channel: channelOf(settlement.counterpartyRef) },
      amounts: { gross: settlement.grossMinor, adjustments: settlement.adjustmentsMinor, net: settlement.netMinor }
    },
    {
      recipe: {
        lines: buildRecipe("RSHARE-ACCR", {
          amountMinor: settlement.netMinor,
          memo,
          dims: dimsOf(settlement)
        }),
        currency: settlement.currency,
        periodCode: periodCodeOf,
        reason: memo
      },
      // The gate above already took the `dist.settlement_run` signature against
      // the settlement. Letting runTxn gate again on `txn:{id}` would ask a
      // second person for the same decision.
      preApproved: true,
      event: { name: "ledger.settlement.approved" }
    }
  );

  // Stamping the entries is what makes the next run of this channel skip them —
  // and what makes a carried period's entries, still unstamped, sweep forward.
  // Exactly the set the posted total was computed from, not a re-query: the
  // journal and the stamped set must describe the same money.
  for (const e of entries) {
    await ctx.db
      .update(schema.distCommissionEntries)
      .set({ channelSettlementId: settlement.id, state: "payable", txnId: txn.id, updatedAt: ctx.now })
      .where(and(eq(schema.distCommissionEntries.tenantId, ctx.tenantId), eq(schema.distCommissionEntries.id, e.id)));
  }

  const after = await setState(ctx, settlement, {
    state: "approved",
    approvedBy: actorRef(ctx),
    txnId: txn.id
  });
  await audit(ctx, {
    action: "ledger.settlement.approve",
    subjectRef: settlement.id,
    before: settlement,
    after
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.settlement.approved",
    subject: settlement.id,
    data: { netMinor: settlement.netMinor, txnId: txn.id, entries: entries.length }
  });
  return after;
}

/**
 * Move the cash. A second, separate approval (`ledger.partner_settlement`) —
 * approving the number and releasing the money are two decisions, and docs/19
 * §7 keeps them apart.
 */
export async function paySettlement(
  ctx: Ctx,
  settlementId: string,
  payment: PaySettlementInput
): Promise<SettlementRow> {
  assertPayment(payment);
  const settlement = await getSettlement(ctx, settlementId);
  if (settlement.state !== "approved") {
    throw conflict(`settlement ${settlementId} is ${settlement.state}; only an approved settlement can be paid`);
  }
  const memo = `payout ${settlement.period} ${settlement.counterpartyRef}`;
  const periodCodeOf = await assertPeriodAccepts(ctx, settlement, memo);

  await gate(ctx, {
    policyKey: "ledger.partner_settlement",
    subjectRef: `settlement:${settlement.id}`,
    amountMinor: settlement.netMinor,
    context: { period: settlement.period, counterpartyRef: settlement.counterpartyRef }
  });

  // Same key on a retry: `runTxn` returns the settled transaction untouched, so
  // a repeated payout posts nothing and pays nothing twice.
  const txn = await runTxn(
    ctx,
    {
      type: "RSHARE-SETL",
      idempotencyKey: `rshare-setl:${settlement.id}`,
      currency: settlement.currency,
      grossMinor: settlement.netMinor,
      subjectRefs: { settlement: settlement.id, channel: channelOf(settlement.counterpartyRef) },
      amounts: { net: settlement.netMinor }
    },
    {
      recipe: {
        lines: buildRecipe("RSHARE-SETL", {
          amountMinor: settlement.netMinor,
          memo,
          dims: dimsOf(settlement)
        }),
        currency: settlement.currency,
        periodCode: periodCodeOf,
        reason: memo
      },
      // Gated above on the payout policy. RSHARE-SETL's declared policy is
      // `dist.settlement_run`, which approve already took for this settlement.
      preApproved: true,
      event: { name: "ledger.settlement.paid" }
    }
  );

  await ctx.db
    .update(schema.distCommissionEntries)
    .set({ state: "paid", updatedAt: ctx.now })
    .where(
      and(
        eq(schema.distCommissionEntries.tenantId, ctx.tenantId),
        eq(schema.distCommissionEntries.channelSettlementId, settlement.id)
      )
    );

  const after = await setState(ctx, settlement, {
    state: "paid",
    txnId: txn.id,
    externalRef: payment.externalRef,
    paidVia: payment.paidVia
  });
  await audit(ctx, { action: "ledger.settlement.pay", subjectRef: settlement.id, before: settlement, after });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.settlement.paid",
    subject: settlement.id,
    data: { netMinor: settlement.netMinor, txnId: txn.id }
  });
  return after;
}

/** Park a settlement while the counterparty argues. The reason is the audit row. */
export async function disputeSettlement(ctx: Ctx, settlementId: string, reason: string): Promise<SettlementRow> {
  const settlement = await getSettlement(ctx, settlementId);
  if (settlement.state !== "draft" && settlement.state !== "approved") {
    throw conflict(`settlement ${settlementId} is ${settlement.state} and can no longer be disputed`);
  }
  const after = await setState(ctx, settlement, { state: "disputed", disputeReason: reason });
  await audit(ctx, {
    action: "ledger.settlement.dispute",
    subjectRef: settlement.id,
    before: settlement,
    after: { ...after, reason }
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.settlement.disputed",
    subject: settlement.id,
    data: { reason, from: settlement.state, netMinor: settlement.netMinor }
  });
  return after;
}

/**
 * Dispute resolved: back to draft so the period can be re-run against whatever
 * the argument changed. Only while nothing has posted — once an accrual exists,
 * the way back is a reversal, not an edit.
 */
export async function reopenSettlement(ctx: Ctx, settlementId: string, reason: string): Promise<SettlementRow> {
  const settlement = await getSettlement(ctx, settlementId);
  if (settlement.state !== "disputed") throw conflict(`settlement ${settlementId} is ${settlement.state}, not disputed`);
  if (settlement.txnId) {
    throw conflict(`settlement ${settlementId} has posted transaction ${settlement.txnId}; reverse it before reopening`);
  }
  const after = await setState(ctx, settlement, { state: "draft" });
  await audit(ctx, {
    action: "ledger.settlement.reopen",
    subjectRef: settlement.id,
    before: settlement,
    after: { ...after, reason }
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.settlement.reopened",
    subject: settlement.id,
    data: { reason }
  });
  return after;
}

async function setState(
  ctx: Ctx,
  settlement: SettlementRow,
  patch: Partial<typeof schema.ledgerSettlements.$inferInsert>
): Promise<SettlementRow> {
  await ctx.db
    .update(schema.ledgerSettlements)
    .set({ ...patch, updatedAt: ctx.now })
    .where(and(eq(schema.ledgerSettlements.tenantId, ctx.tenantId), eq(schema.ledgerSettlements.id, settlement.id)));
  return getSettlement(ctx, settlement.id);
}

/* ------------------------------------------------------- remittance advice */

const money = (key: string, label: string): ReportTable["columns"][number] => ({ key, label, kind: "money" });
const text = (key: string, label: string): ReportTable["columns"][number] => ({ key, label, kind: "text" });

/**
 * The remittance advice: every line that makes up the total, the agreement
 * version each was priced under, and the net. A counterparty who cannot see the
 * lines cannot check the number, so this is the statement, not a summary.
 */
export async function statementTable(
  ctx: Ctx,
  settlement: SettlementRow
): Promise<{ table: ReportTable; totals: Record<string, number>; terms: SettlementTerms }> {
  // docs/27 P2. Commission entries carry both dimensions — `channelId` for what
  // we owe out, `providerId` for what an insurer owes in — so an insurer
  // settlement is not an absence of lines, only a different key and a
  // different stamp column (`providerSettlementId`, sighting 11's comment
  // named it before anything read it). `resolveTerms` stays payable-only: it
  // resolves a *channel's* partner agreement, and an insurer settlement has no
  // channel to resolve one for.
  const payable = (PAYABLE_KINDS as readonly string[]).includes(settlement.counterpartyKind);
  const insurer = settlement.counterpartyKind === "insurer";
  const terms = payable
    ? await resolveTerms(ctx, channelOf(settlement.counterpartyRef))
    : { minPayoutMinor: 0, agreementId: null, agreementVersion: null };
  const entries = payable
    ? await settlementEntries(ctx, settlement)
    : insurer
      ? await providerSettlementEntries(ctx, settlement)
      : [];
  const { startAt } = monthBounds(settlement.period);
  const agreement = terms.agreementVersion === null ? "—" : `v${terms.agreementVersion}`;

  const table: ReportTable = {
    title: `Remittance advice ${settlement.period} — ${settlement.counterpartyRef}`,
    columns: [
      text("earnedOn", "Earned"),
      text("policyId", "Policy"),
      text("kind", "Kind"),
      text("bucket", "Bucket"),
      money("premiumMinor", "Premium"),
      money("grossCommissionMinor", "Gross commission"),
      money("channelCommissionMinor", "Channel share"),
      text("agreement", "Agreement")
    ],
    rows: entries.map((e) => ({
      earnedOn: isoDay(earnedAtOf(e)),
      policyId: e.policyId,
      kind: e.kind,
      bucket: earnedAtOf(e) >= startAt ? settlement.period : "carried in",
      premiumMinor: e.premiumMinor,
      grossCommissionMinor: e.grossCommissionMinor,
      channelCommissionMinor: e.channelCommissionMinor,
      agreement
    })),
    currency: settlement.currency,
    generatedAt: ctx.now
  };

  return {
    table,
    totals: {
      grossMinor: settlement.grossMinor,
      adjustmentsMinor: settlement.adjustmentsMinor,
      netMinor: settlement.netMinor
    },
    terms
  };
}

export interface StatementResult {
  rendered: Rendered;
  fileId: string;
  filename: string;
  settlement: SettlementRow;
}

/**
 * Render the advice and keep it: the bytes a counterparty was sent are evidence,
 * so the file id lands on the settlement and the settlement points at one file.
 */
export async function settlementStatement(
  ctx: Ctx,
  settlementId: string,
  format: ExportFormat,
  bucket: R2Bucket | undefined,
  browser?: BrowserBinding
): Promise<StatementResult> {
  const settlement = await getSettlement(ctx, settlementId);
  const { table, totals, terms } = await statementTable(ctx, settlement);
  const rendered = await render(
    format,
    table,
    {
      totals,
      meta: {
        "Requested by": actorRef(ctx),
        Period: settlement.period,
        Counterparty: settlement.counterpartyRef,
        Agreement: terms.agreementVersion === null ? "unversioned" : `v${terms.agreementVersion}`,
        State: settlement.state,
        Rows: String(table.rows.length)
      }
    },
    browser
  );

  const fileId = newId("file", ctx.now);
  const r2Key = `settlements/${ctx.tenantId}/${settlement.id}.${format}`;
  if (bucket) await bucket.put(r2Key, rendered.bytes, { httpMetadata: { contentType: rendered.contentType } });
  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "settlement_statement",
    subjectRef: settlement.id,
    sha256: await sha256Hex(rendered.bytes),
    sizeBytes: rendered.bytes.length,
    contentType: rendered.contentType,
    piiLevel: "none",
    createdAt: ctx.now,
    deletedAt: null
  });
  const after = await setState(ctx, settlement, { statementFileId: fileId });

  await audit(ctx, {
    action: "ledger.settlement.statement",
    subjectRef: settlement.id,
    after: { fileId, format, rows: table.rows.length }
  });

  return {
    rendered,
    fileId,
    filename: `remittance-${settlement.period}-${settlement.id}.${format}`,
    settlement: after
  };
}

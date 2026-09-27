import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  audit,
  badRequest,
  conflict,
  emit,
  assertNotScreenedOut,
  gate,
  moduleOn,
  notFound,
  quoteCommission,
  type Ctx,
  type Envelope
} from "@lyra/core";
import { isUniqueViolation } from "../crud.js";
import { one } from "../rows.js";

// Commission accrual: an issued policy turned into the three-way money view
// (gross from the underwriter, the channel's share, our net). This was the body
// of POST /v1/dist/commission-entries/accrue; it lives here so the bind can
// reach it too. There are exactly two doors and one path:
//
//   - the manual route (routes/dist.ts), a controller accruing by hand;
//   - `axis.policy.issued` (dispatch.ts), the bind itself.
//
// Both go through the `dist.commission_accrue` gate (CLAUDE.md §4) and the
// dist_commission_entries_accrual_uq index (one accrual per policy and kind).
// No journal is posted here, by either door: the ledger's RSHARE-ACCR / -SETL
// postings happen when the channel's settlement is approved and paid
// (engines/settlement.ts, docs/19 §5) — an accrual is the subledger row those
// read, exactly as it was when only the manual route wrote it.

export type AccrualKind = "new_business" | "renewal" | "endorsement" | "adjustment";

export interface AccrueInput {
  policyId: string;
  kind: AccrualKind;
  earnedOn: "issue" | "collection";
  taxMinor: number;
}

export type CommissionEntry = typeof schema.distCommissionEntries.$inferInsert;

/** What a commission is rated on: a bound policy, or (ADR-0094) a confirmed sale. */
interface Subject {
  /** The gate's subject, before `:kind` — what may be accrued once per kind. */
  ref: string;
  policyId: string | null;
  saleRef: string | null;
  offeringId: string;
  providerId: string;
  channelId: string;
  premiumMinor: number;
  currency: string;
}

/**
 * Rate, gate, insert, audit, announce — the one path both subjects take.
 * Derived from the subject and the rate in force rather than taken from the
 * caller, so a channel cannot post its own commission.
 */
async function book(ctx: Ctx, subject: Subject, input: Omit<AccrueInput, "policyId">): Promise<CommissionEntry> {
  const split = await quoteCommission(ctx, {
    offeringId: subject.offeringId,
    channelId: subject.channelId,
    premiumMinor: subject.premiumMinor
  });

  // Tax comes off the net share and can never exceed it: a taxMinor above
  // net is a caller error, and clamping it would hide that error inside a
  // silently wrong accrual.
  if (input.taxMinor > split.netMinor) {
    throw badRequest(`taxMinor (${input.taxMinor}) exceeds the net commission (${split.netMinor})`);
  }

  // The position is only knowable once the rate has been applied, so the
  // gate sits here: it is the commission that is approved, not the request.
  // Keyed by subject and kind, because that pair is what may exist once.
  // singleUse: false on this policy — the unique indexes below are the sole
  // arbiter of "exactly one execution"; gate() just needs to stay valid
  // across the whole race, not spend on first pass.
  await gate(ctx, {
    policyKey: "dist.commission_accrue",
    subjectRef: `${subject.ref}:${input.kind}`,
    amountMinor: split.grossMinor,
    context: { policyId: subject.policyId, saleRef: subject.saleRef, kind: input.kind, premiumMinor: subject.premiumMinor }
  });

  const row: CommissionEntry = {
    id: newId("ce", ctx.now),
    tenantId: ctx.tenantId,
    policyId: subject.policyId,
    saleRef: subject.saleRef,
    offeringId: subject.offeringId,
    providerId: subject.providerId,
    channelId: subject.channelId,
    rateId: split.rateId ?? null,
    kind: input.kind,
    premiumMinor: subject.premiumMinor,
    grossCommissionMinor: split.grossMinor,
    channelCommissionMinor: split.channelMinor,
    netCommissionMinor: split.netMinor - input.taxMinor,
    taxMinor: input.taxMinor,
    currency: subject.currency,
    earnedOn: input.earnedOn,
    earnedAt: input.earnedOn === "issue" ? ctx.now : null,
    state: "accrued",
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  try {
    await ctx.db.insert(schema.distCommissionEntries).values(row);
  } catch (e) {
    // dist_commission_entries_accrual_uq / _sale_uq — one accrual per
    // (policy or sale, kind). The index, not a pre-check, is the guard: two
    // submits racing a check-then-insert both pass the check, but only one
    // insert lands.
    if (isUniqueViolation(e)) throw conflict(`commission already accrued for this ${subject.policyId ? "policy" : "sale"} and kind`);
    throw e;
  }
  await audit(ctx, { action: "dist.commission.accrue", subjectRef: row.id, after: row });
  await emit(ctx, {
    module: "dist",
    type: "dist.commission.accrued",
    subject: row.id,
    data: { policyId: subject.policyId, saleRef: subject.saleRef, grossMinor: split.grossMinor, channelMinor: split.channelMinor }
  });
  return row;
}

export async function accrueCommission(ctx: Ctx, input: AccrueInput): Promise<CommissionEntry> {
  const policy = await one(ctx, schema.axisPolicies, input.policyId);
  if (!policy) throw notFound("policy");
  if (!policy.offeringId || !policy.channelId) throw badRequest("policy has no offering or channel to rate");
  return book(
    ctx,
    {
      ref: policy.id,
      policyId: policy.id,
      saleRef: null,
      offeringId: policy.offeringId,
      providerId: policy.providerId,
      channelId: policy.channelId,
      premiumMinor: policy.premiumMinor,
      currency: policy.currency
    },
    input
  );
}

/* ------------------------------------------------------------ the sale door */

export interface SaleInput {
  responseId: string;
  earnedOn: "issue" | "collection";
  taxMinor: number;
}

/**
 * ADR-0094: without AXIS nothing is ever bound, so the sale Distribution can
 * see is the quote the customer chose. Staff confirming it books the channel's
 * new-business commission, rated from that quote's offering and the
 * comparison's channel. With AXIS on the bind is the sale, and a second door
 * onto the same fact would accrue it twice.
 */
export async function accrueSale(ctx: Ctx, input: SaleInput): Promise<CommissionEntry> {
  if (moduleOn(ctx, "axis")) throw conflict("with AXIS on, the bind is the sale — commission accrues from the policy");
  const response = await one(ctx, schema.distQuoteResponses, input.responseId);
  if (!response) throw notFound("quote response");
  if (response.state !== "quoted" || response.premiumMinor === null) throw conflict("that response is not a quote");
  if (response.selectedAt === null) throw conflict("only the quote the customer chose can be sold");
  const request = await one(ctx, schema.distQuoteRequests, response.requestId);
  if (!request) throw notFound("quote request");
  await assertNotScreenedOut(ctx, request.customerId);

  const entry = await book(
    ctx,
    {
      ref: `sale:${response.id}`,
      policyId: null,
      saleRef: `quote_response:${response.id}`,
      offeringId: response.offeringId,
      providerId: response.providerId,
      channelId: request.channelId,
      premiumMinor: response.premiumMinor,
      currency: response.currency ?? request.currency
    },
    { kind: "new_business", earnedOn: input.earnedOn, taxMinor: input.taxMinor }
  );
  await ctx.db
    .update(schema.distQuoteResponses)
    .set({ soldAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(schema.distQuoteResponses.tenantId, ctx.tenantId), eq(schema.distQuoteResponses.id, response.id)));
  await emit(ctx, {
    module: "dist",
    type: "dist.sale.confirmed",
    subject: response.id,
    data: {
      requestId: request.id,
      offeringId: response.offeringId,
      providerId: response.providerId,
      channelId: request.channelId,
      customerId: request.customerId,
      premiumMinor: response.premiumMinor,
      commissionEntryId: entry.id
    }
  });
  return entry;
}

/* ------------------------------------------------------------ the bind door */

const BIND_KIND: AccrualKind = "new_business";

async function accrued(ctx: Ctx, policyId: string, kind: AccrualKind): Promise<boolean> {
  const rows = await ctx.db
    .select({ id: schema.distCommissionEntries.id })
    .from(schema.distCommissionEntries)
    .where(
      and(
        eq(schema.distCommissionEntries.tenantId, ctx.tenantId),
        eq(schema.distCommissionEntries.policyId, policyId),
        eq(schema.distCommissionEntries.kind, kind)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Accrue for a bind, idempotently. "Already accrued" and "waiting on the
 * approver" are both finished work for an event consumer — neither retries,
 * so neither lands in the DLQ. Anything else (no rate, no tax rule) is a real
 * failure and is left to throw: consume() retries it and dead-letters it where
 * an admin can see it.
 */
async function accrueForBind(ctx: Ctx, policyId: string): Promise<void> {
  if (await accrued(ctx, policyId, BIND_KIND)) return;
  try {
    await accrueCommission(ctx, { policyId, kind: BIND_KIND, earnedOn: "issue", taxMinor: 0 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "approval_required") return; // the approval queue owns it now
    // A racing delivery (or the manual route) won the unique index.
    if (code === "conflict" && /already accrued/.test((err as { detail?: string }).detail ?? "")) return;
    throw err;
  }
}

/** `axis.policy.issued`: a bound policy with a channel and an offering to rate accrues. */
export async function onPolicyIssuedAccrue(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as { policyId?: string };
  const policyId = data.policyId ?? envelope.subject;
  if (!policyId) return;
  const policy = await one(ctx, schema.axisPolicies, policyId);
  // A direct (channel-less) sale has no channel commission to accrue, and an
  // unrated policy has nothing to derive one from.
  if (!policy || !policy.channelId || !policy.offeringId) return;
  await accrueForBind(ctx, policy.id);
}

/**
 * `core.approval.decided` for an accrual the bind raised: the approver's
 * decision is what books it. Only approvals a system actor requested — the
 * manual route raises the same approval under a person's name, and booking
 * that one here would turn their retry into a 409 for an accrual they never
 * saw land.
 */
export async function onAccrualDecided(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as { approvalId?: string; decision?: string; policyKey?: string };
  if (data.policyKey !== "dist.commission_accrue" || data.decision !== "approved" || !data.approvalId) return;
  const approval = await one(ctx, schema.approvals, data.approvalId);
  if (!approval || !approval.requestedBy.startsWith("system:")) return;
  const [policyId, kind] = approval.subjectRef.split(":");
  if (!policyId || kind !== BIND_KIND) return;
  await accrueForBind(ctx, policyId);
}

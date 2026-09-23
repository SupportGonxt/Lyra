import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  audit,
  badRequest,
  conflict,
  emit,
  gate,
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

/**
 * Derived from the policy and the rate in force rather than taken from the
 * caller, so a channel cannot post its own commission.
 */
export async function accrueCommission(ctx: Ctx, input: AccrueInput): Promise<CommissionEntry> {
  const policy = await one(ctx, schema.axisPolicies, input.policyId);
  if (!policy) throw notFound("policy");
  if (!policy.offeringId || !policy.channelId) throw badRequest("policy has no offering or channel to rate");

  const split = await quoteCommission(ctx, {
    offeringId: policy.offeringId,
    channelId: policy.channelId,
    premiumMinor: policy.premiumMinor
  });

  // Tax comes off the net share and can never exceed it: a taxMinor above
  // net is a caller error, and clamping it would hide that error inside a
  // silently wrong accrual.
  if (input.taxMinor > split.netMinor) {
    throw badRequest(`taxMinor (${input.taxMinor}) exceeds the net commission (${split.netMinor})`);
  }

  // The position is only knowable once the rate has been applied, so the
  // gate sits here: it is the commission that is approved, not the request.
  // Keyed by policy and kind, because that pair is what may exist once.
  // singleUse: false on this policy — dist_commission_entries_accrual_uq
  // below is the sole arbiter of "exactly one execution"; gate() just
  // needs to stay valid across the whole race, not spend on first pass.
  await gate(ctx, {
    policyKey: "dist.commission_accrue",
    subjectRef: `${policy.id}:${input.kind}`,
    amountMinor: split.grossMinor,
    context: { policyId: policy.id, kind: input.kind, premiumMinor: policy.premiumMinor }
  });

  const row: CommissionEntry = {
    id: newId("ce", ctx.now),
    tenantId: ctx.tenantId,
    policyId: policy.id,
    offeringId: policy.offeringId,
    providerId: policy.providerId,
    channelId: policy.channelId,
    rateId: split.rateId ?? null,
    kind: input.kind,
    premiumMinor: policy.premiumMinor,
    grossCommissionMinor: split.grossMinor,
    channelCommissionMinor: split.channelMinor,
    netCommissionMinor: split.netMinor - input.taxMinor,
    taxMinor: input.taxMinor,
    currency: policy.currency,
    earnedOn: input.earnedOn,
    earnedAt: input.earnedOn === "issue" ? ctx.now : null,
    state: "accrued",
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  try {
    await ctx.db.insert(schema.distCommissionEntries).values(row);
  } catch (e) {
    // dist_commission_entries_accrual_uq — one accrual per (policy, kind).
    // The index, not a pre-check, is the guard: two submits racing a
    // check-then-insert both pass the check, but only one insert lands.
    if (isUniqueViolation(e)) throw conflict("commission already accrued for this policy and kind");
    throw e;
  }
  await audit(ctx, { action: "dist.commission.accrue", subjectRef: row.id, after: row });
  await emit(ctx, {
    module: "dist",
    type: "dist.commission.accrued",
    subject: row.id,
    data: { policyId: policy.id, grossMinor: split.grossMinor, channelMinor: split.channelMinor }
  });
  return row;
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

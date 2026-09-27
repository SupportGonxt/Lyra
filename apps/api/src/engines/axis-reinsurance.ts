import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  audit,
  emit,
  orderTreaties,
  planCessions,
  treatyApplies,
  type Ctx,
  type Envelope,
  type TreatyKind
} from "@lyra/core";
import { buildRecipe, runTxn } from "@lyra/ledger";
import { isUniqueViolation } from "../crud.js";
import { one } from "../rows.js";

// docs/30 AXIS 5, ADR-0106. Reinsurance cessions on the tenant's own
// underwriting. One path, two doors, the same shape as commission accrual:
//
//   - `axis.policy.issued` (dispatch.ts): the bind itself;
//   - `axis.approval.decided` for `axis.reinsurance_cession`: the approver's
//     decision posts the cession the bind raised.
//
// `cedePolicy` is idempotent at two levels: the (tenant, policy, treaty)
// unique index on axis_reinsurance_cessions is the one-cession-per-treaty
// guard, and RI-CEDE's idempotency key `axis.cede:{policy}:{treaty}` is the
// one-posting guard. A redelivered event finds both already spent.

export type CessionRow = typeof schema.axisReinsuranceCessions.$inferSelect;
type PolicyRow = typeof schema.axisPolicies.$inferSelect;

const POLICY_KEY = "axis.reinsurance_cession";

function positiveInt(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parsed(raw: string | null | undefined): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The sum insured a surplus treaty (or a limited quota share) measures against.
 * The contract's own terms first — what the policy says it covers — then the
 * rating inputs the chosen quote was priced on. Null when neither states one:
 * the planner then refuses to guess and says so.
 */
async function sumInsuredOf(ctx: Ctx, policy: PolicyRow): Promise<number | null> {
  if (policy.currentVersionId) {
    const version = await one(ctx, schema.axisPolicyVersions, policy.currentVersionId);
    const stated = positiveInt(parsed(version?.termsJson)["sumInsuredMinor"]);
    if (stated !== null) return stated;
    if (version?.quoteResponseId) {
      const response = await one(ctx, schema.distQuoteResponses, version.quoteResponseId);
      const request = response ? await one(ctx, schema.distQuoteRequests, response.requestId) : undefined;
      const priced = positiveInt(parsed(request?.inputsJson)["sumInsuredMinor"]);
      if (priced !== null) return priced;
    }
  }
  return null;
}

async function existing(ctx: Ctx, policyId: string, treatyId: string): Promise<CessionRow | undefined> {
  const rows = await ctx.db
    .select()
    .from(schema.axisReinsuranceCessions)
    .where(
      and(
        eq(schema.axisReinsuranceCessions.tenantId, ctx.tenantId),
        eq(schema.axisReinsuranceCessions.policyId, policyId),
        eq(schema.axisReinsuranceCessions.treatyId, treatyId)
      )
    )
    .limit(1);
  return rows[0];
}

/**
 * Post one cession as RI-CEDE, or leave it waiting on its approval. The
 * approval pauses the transaction in `validated` (txn.ts), so the retry after
 * the decision resumes the same transaction rather than opening a second.
 */
export async function postCession(ctx: Ctx, cession: CessionRow): Promise<CessionRow> {
  if (cession.state === "posted") return cession;
  const policy = await one(ctx, schema.axisPolicies, cession.policyId);
  if (!policy) return cession;

  let txn;
  try {
    txn = await runTxn(
      ctx,
      {
        type: "RI-CEDE",
        idempotencyKey: `axis.cede:${cession.policyId}:${cession.treatyId}`,
        currency: cession.currency,
        grossMinor: cession.cededPremiumMinor,
        subjectRefs: { policy: cession.policyId, cession: cession.id }
      },
      {
        recipe: {
          lines: buildRecipe("RI-CEDE", {
            cededPremiumMinor: cession.cededPremiumMinor,
            cedingCommissionMinor: cession.cedingCommissionMinor,
            // The 2000 leg nets the open item the bind raised (docs/27 F15), so
            // it carries the bind's own item and counterparty; the reinsurer's
            // legs are the reinsurer's.
            dims: {
              item: `policy:${policy.id}`,
              counterparty: `provider:${policy.providerId}`,
              policy: policy.id,
              treaty: cession.treatyId,
              cession: cession.id
            },
            reinsurerDims: { item: `cession:${cession.id}`, counterparty: `provider:${cession.reinsurerId}` }
          }),
          currency: cession.currency
        },
        approvalSubjectRef: `axis_cession:${cession.id}`
      }
    );
  } catch (err) {
    if ((err as { code?: string }).code === "approval_required") return cession; // the approval queue owns it now
    throw err;
  }

  const stamp = { state: "posted", txnId: txn.id, postedAt: ctx.now, updatedAt: ctx.now };
  await ctx.db
    .update(schema.axisReinsuranceCessions)
    .set(stamp)
    .where(and(eq(schema.axisReinsuranceCessions.tenantId, ctx.tenantId), eq(schema.axisReinsuranceCessions.id, cession.id)));
  const after = { ...cession, ...stamp };
  await audit(ctx, { action: "axis.reinsurance.cede", subjectRef: cession.id, before: cession, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.reinsurance.ceded",
    subject: cession.id,
    data: {
      policyId: cession.policyId,
      treatyId: cession.treatyId,
      reinsurerId: cession.reinsurerId,
      cededPremiumMinor: cession.cededPremiumMinor,
      cedingCommissionMinor: cession.cedingCommissionMinor,
      currency: cession.currency,
      txnId: txn.id
    }
  });
  return after;
}

/**
 * Plan and record every cession a policy owes, then post each. Only a policy
 * the tenant underwrites (`core_providers.is_internal`) cedes: on another
 * insurer's paper the premium is theirs, and so is the reinsurance.
 */
export async function cedePolicy(ctx: Ctx, policyId: string): Promise<CessionRow[]> {
  const policy = await one(ctx, schema.axisPolicies, policyId);
  if (!policy) return [];
  const provider = await one(ctx, schema.providers, policy.providerId);
  if (!provider?.isInternal) return [];
  const product = policy.productId ? await one(ctx, schema.products, policy.productId) : undefined;

  const active = await ctx.db
    .select()
    .from(schema.axisReinsuranceTreaties)
    .where(and(eq(schema.axisReinsuranceTreaties.tenantId, ctx.tenantId), eq(schema.axisReinsuranceTreaties.status, "active")));
  const treaties = orderTreaties(
    active.filter((t) => treatyApplies(t, { line: product?.line ?? null, currency: policy.currency, startAt: policy.startAt }))
  );
  if (!treaties.length) return [];

  const sumInsuredMinor = await sumInsuredOf(ctx, policy);
  const plan = planCessions({
    premiumMinor: policy.premiumMinor,
    sumInsuredMinor,
    treaties: treaties.map((t) => ({
      id: t.id,
      kind: t.kind as TreatyKind,
      cededSharePpm: t.cededSharePpm,
      limitMinor: t.limitMinor,
      retentionMinor: t.retentionMinor,
      lines: t.lines,
      cedingCommissionPpm: t.cedingCommissionPpm
    }))
  });

  for (const skip of plan.skipped.filter((s) => s.reason === "no_sum_insured")) {
    await emit(ctx, {
      module: "axis",
      type: "axis.reinsurance.unceded",
      subject: policy.id,
      data: { policyId: policy.id, treatyId: skip.treatyId, reason: skip.reason }
    });
  }

  const byId = new Map(treaties.map((t) => [t.id, t]));
  const out: CessionRow[] = [];
  for (const share of plan.cessions) {
    const treaty = byId.get(share.treatyId)!;
    let row = await existing(ctx, policy.id, treaty.id);
    if (!row) {
      const values: CessionRow = {
        id: newId("ric", ctx.now),
        tenantId: ctx.tenantId,
        policyId: policy.id,
        treatyId: treaty.id,
        reinsurerId: treaty.reinsurerId,
        kind: treaty.kind,
        currency: policy.currency,
        premiumMinor: policy.premiumMinor,
        sumInsuredMinor,
        cededPremiumMinor: share.cededPremiumMinor,
        cededSumInsuredMinor: share.cededSumInsuredMinor,
        cedingCommissionMinor: share.commissionMinor,
        netPayableMinor: share.netPayableMinor,
        retainedPremiumMinor: share.retainedPremiumMinor,
        state: "pending_approval",
        txnId: null,
        postedAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now
      };
      try {
        await ctx.db.insert(schema.axisReinsuranceCessions).values(values);
        await audit(ctx, { action: "axis.reinsurance.plan", subjectRef: values.id, after: values });
        row = values;
      } catch (err) {
        // A racing delivery won the unique index; its row is the cession.
        if (!isUniqueViolation(err)) throw err;
        row = await existing(ctx, policy.id, treaty.id);
        if (!row) throw err;
      }
    }
    out.push(await postCession(ctx, row));
  }
  return out;
}

/** `axis.policy.issued`. */
export async function onPolicyIssuedCede(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as { policyId?: string };
  const policyId = data.policyId ?? envelope.subject;
  if (!policyId) return;
  await cedePolicy(ctx, policyId);
}

/** `axis.approval.decided` for a cession: the decision is what posts it. */
export async function onCessionDecided(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as { approvalId?: string; decision?: string; policyKey?: string };
  if (data.policyKey !== POLICY_KEY || data.decision !== "approved" || !data.approvalId) return;
  const approval = await one(ctx, schema.approvals, data.approvalId);
  if (!approval?.subjectRef.startsWith("axis_cession:")) return;
  const cession = await one(ctx, schema.axisReinsuranceCessions, approval.subjectRef.slice("axis_cession:".length));
  if (cession) await postCession(ctx, cession);
}

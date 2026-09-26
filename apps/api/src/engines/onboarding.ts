import { and, desc, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  ONBOARDING_TEMPLATES,
  actorRef,
  audit,
  badRequest,
  conflict,
  emit,
  gate,
  notFound,
  type Ctx
} from "@lyra/core";
import { must } from "../rows.js";

// docs/05 §7 + docs/19 §7. Getting a counterparty live is the one process where
// "we meant to check that" costs a licence, so it is a generated checklist and a
// stage ladder rather than a status field somebody sets. Two rules carry the
// weight:
//
//   1. The steps are generated from a template at start, so the set is auditable
//      — nobody goes live by never creating the step they could not pass.
//   2. A stage is entered only when every required step gating it is done or
//      waived, and a waiver is an approval (`core.onboarding_waive`), never an
//      edit. Skipping diligence has to leave a name and a timestamp on it.

/* ------------------------------------------------------------------ types */

/** The ladder, in order. `suspended`/`terminated` sit outside it (see below). */
export const STAGES = [
  "prospect",
  "applied",
  "screening",
  "diligence",
  "agreement",
  "integration",
  "sandbox",
  "live"
] as const;
export type Stage = (typeof STAGES)[number];

const STAGE_INDEX: Record<string, number> = Object.fromEntries(STAGES.map((s, i) => [s, i]));

export type SubjectKind = "partner" | "channel" | "staff";
export type EvidenceKind = "file" | "screening" | "agreement" | "consent" | "verification" | "attestation";

/** States that satisfy a gate. `failed` deliberately does not. */
const CLEARED = new Set(["done", "waived"]);

type Step = typeof schema.onboardingSteps.$inferSelect;

/* ------------------------------------------------------------------ steps */

export interface StartInput {
  subjectKind: SubjectKind;
  subjectRef: string;
  template: string;
  /** Role key -> user id, so a generated step lands in somebody's queue. */
  owners?: Record<string, string> | undefined;
  /** Owner for every step the template does not name a role for (staff runs). */
  ownerRef?: string | undefined;
  dueAt?: number | undefined;
}

/**
 * Generate the checklist. Idempotent by construction: the unique index on
 * (tenant, subjectKind, subjectRef, key) means a re-run — a retried request, a
 * template gaining a step — inserts only what is missing and never resets the
 * state of work already done.
 */
export async function startOnboarding(ctx: Ctx, input: StartInput): Promise<Step[]> {
  const defs = ONBOARDING_TEMPLATES[input.template];
  if (!defs) throw badRequest(`unknown onboarding template ${input.template}`);

  const existing = await stepsFor(ctx, input.subjectKind, input.subjectRef);
  const have = new Set(existing.map((s) => s.key));
  const missing = defs.filter((d) => !have.has(d.key));

  const rows = missing.map((d, i) => ({
    id: newId("obs", ctx.now + i),
    tenantId: ctx.tenantId,
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    template: input.template,
    key: d.key,
    labelJson: JSON.stringify(d.labelJson),
    seq: d.seq,
    required: d.required,
    gatesStage: d.gatesStage,
    state: "pending",
    evidenceKind: d.evidenceKind,
    evidenceRef: null,
    ownerRef: (d.ownerRole && input.owners?.[d.ownerRole]) ?? input.ownerRef ?? null,
    dueAt: input.dueAt ?? null,
    notesJson: null,
    waivedApprovalId: null,
    decidedBy: null,
    decidedAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  }));

  if (rows.length) {
    await ctx.db.insert(schema.onboardingSteps).values(rows);
    await audit(ctx, {
      action: "core.onboarding.start",
      subjectRef: input.subjectRef,
      after: { template: input.template, added: rows.map((r) => r.key) }
    });
    await emit(ctx, {
      module: "core",
      type: "core.onboarding.started",
      subject: input.subjectRef,
      data: { subjectKind: input.subjectKind, template: input.template, steps: rows.length }
    });
  }

  return stepsFor(ctx, input.subjectKind, input.subjectRef);
}

export async function stepsFor(ctx: Ctx, subjectKind: string, subjectRef: string): Promise<Step[]> {
  return ctx.db
    .select()
    .from(schema.onboardingSteps)
    .where(
      and(
        eq(schema.onboardingSteps.tenantId, ctx.tenantId),
        eq(schema.onboardingSteps.subjectKind, subjectKind),
        eq(schema.onboardingSteps.subjectRef, subjectRef)
      )
    )
    .orderBy(schema.onboardingSteps.seq);
}

/** Required steps gating `stage` (or anything before it) that are not cleared. */
export function blockingSteps(steps: readonly Step[], stage: Stage): Step[] {
  const target = STAGE_INDEX[stage] ?? 0;
  return steps.filter(
    (s) => s.required && (STAGE_INDEX[s.gatesStage] ?? 0) <= target && !CLEARED.has(s.state)
  );
}

async function step(ctx: Ctx, stepId: string): Promise<Step> {
  return must(ctx, schema.onboardingSteps, stepId, "onboarding step");
}

async function moveStep(
  ctx: Ctx,
  row: Step,
  patch: Partial<Step>,
  action: string,
  event: string
): Promise<Step> {
  const after = { ...row, ...patch, decidedBy: actorRef(ctx), decidedAt: ctx.now, updatedAt: ctx.now };
  await ctx.db
    .update(schema.onboardingSteps)
    .set({
      state: after.state,
      evidenceRef: after.evidenceRef,
      notesJson: after.notesJson,
      waivedApprovalId: after.waivedApprovalId,
      decidedBy: after.decidedBy,
      decidedAt: after.decidedAt,
      updatedAt: after.updatedAt
    })
    .where(
      and(eq(schema.onboardingSteps.tenantId, ctx.tenantId), eq(schema.onboardingSteps.id, row.id))
    );
  await audit(ctx, { action, subjectRef: row.id, before: row, after });
  await emit(ctx, {
    module: "core",
    type: event,
    subject: row.id,
    data: {
      subjectKind: row.subjectKind,
      subjectRef: row.subjectRef,
      key: row.key,
      state: after.state,
      gatesStage: row.gatesStage
    }
  });
  return after;
}

/** A settled step is evidence; re-deciding it would erase who decided it. */
function assertOpen(row: Step): void {
  if (CLEARED.has(row.state)) throw conflict(`step ${row.key} is already ${row.state}`);
}

export async function completeStep(
  ctx: Ctx,
  stepId: string,
  input: { evidenceRef?: string | undefined; note?: string | undefined } = {}
): Promise<Step> {
  const row = await step(ctx, stepId);
  assertOpen(row);
  // A step that declares what proves it may not be closed on nothing. The one
  // exception is an attestation, whose evidence *is* the person attesting.
  const evidenceRef =
    input.evidenceRef ?? (row.evidenceKind === "attestation" ? actorRef(ctx) : null);
  if (row.evidenceKind && !evidenceRef) {
    throw badRequest(`step ${row.key} needs ${row.evidenceKind} evidence to be completed`);
  }
  return moveStep(
    ctx,
    row,
    { state: "done", evidenceRef, notesJson: input.note ? JSON.stringify({ note: input.note }) : row.notesJson },
    "core.onboarding.complete",
    "core.onboarding.step_completed"
  );
}

export async function failStep(ctx: Ctx, stepId: string, reason: string): Promise<Step> {
  const row = await step(ctx, stepId);
  assertOpen(row);
  return moveStep(
    ctx,
    row,
    { state: "failed", notesJson: JSON.stringify({ reason }) },
    "core.onboarding.fail",
    "core.onboarding.step_failed"
  );
}

/**
 * Skip a required step. Gated on `core.onboarding_waive` — dual control, never
 * auto-approvable — because this is the one move that lets a counterparty trade
 * without the proof the checklist exists to collect.
 */
export async function waiveStep(ctx: Ctx, stepId: string, reason: string): Promise<Step> {
  const row = await step(ctx, stepId);
  assertOpen(row);
  const approval = await gate(ctx, {
    policyKey: "core.onboarding_waive",
    subjectRef: row.id,
    context: { subjectKind: row.subjectKind, subjectRef: row.subjectRef, key: row.key, reason }
  });
  return moveStep(
    ctx,
    row,
    { state: "waived", notesJson: JSON.stringify({ reason }), waivedApprovalId: approval?.id ?? null },
    "core.onboarding.waive",
    "core.onboarding.step_waived"
  );
}

/* --------------------------------------------------------------- partners */

/**
 * One rung up the ladder. Refuses rather than skips: the caller is told which
 * step is blocking, because "cannot advance" without a name is a support ticket.
 *
 * `suspended`/`terminated` are not rungs — a paused partner keeps the stage its
 * diligence earned (docs: pausing must not mean re-onboarding), so they live in
 * `status` and this refuses while either is set.
 */
export async function advancePartner(ctx: Ctx, partnerId: string): Promise<{ stage: Stage; blocking: Step[] }> {
  const partner = await must(ctx, schema.orbitPartners, partnerId, "partner");
  if (partner.status === "terminated") throw conflict("partner is terminated");
  if (partner.status === "suspended") throw conflict("partner is suspended");

  const from = partner.stage as Stage;
  const idx = STAGE_INDEX[from];
  if (idx === undefined) throw conflict(`partner is in stage ${partner.stage}, which is not on the ladder`);
  const to = STAGES[idx + 1];
  if (!to) throw conflict("partner is already live");

  const steps = await stepsFor(ctx, "partner", partnerId);
  const blocking = blockingSteps(steps, to);
  if (blocking.length) {
    throw conflict(`cannot enter ${to}: ${blocking.map((s) => s.key).join(", ")} not done`);
  }

  // Going live is the consequential one: it switches a counterparty out of the
  // sandbox and into real money (CLAUDE.md §4).
  const approval = to === "live" ? await gate(ctx, { policyKey: "dist.partner_activate", subjectRef: partnerId }) : null;

  const patch =
    to === "live"
      ? { stage: to, status: "active", sandboxFlag: false, goLiveAt: ctx.now, updatedAt: ctx.now }
      : { stage: to, updatedAt: ctx.now };
  await ctx.db
    .update(schema.orbitPartners)
    .set(patch)
    .where(and(eq(schema.orbitPartners.tenantId, ctx.tenantId), eq(schema.orbitPartners.id, partnerId)));

  await audit(ctx, {
    action: "orbit.partner.advance",
    subjectRef: partnerId,
    before: { stage: from },
    after: { stage: to, approvalId: approval?.id ?? null }
  });
  await emit(ctx, {
    module: "orbit",
    type: to === "live" ? "orbit.partner.went_live" : "orbit.partner.stage_changed",
    subject: partnerId,
    // partnerId in the payload is what a partner journey enrols (orbit-journeys.ts).
    data: { partnerId, from, to }
  });
  return { stage: to, blocking: [] };
}

export async function suspendPartner(ctx: Ctx, partnerId: string, reason: string): Promise<void> {
  const partner = await must(ctx, schema.orbitPartners, partnerId, "partner");
  if (partner.status === "terminated") throw conflict("partner is terminated");
  await ctx.db
    .update(schema.orbitPartners)
    .set({ status: "suspended", suspendedAt: ctx.now, suspendedReason: reason, updatedAt: ctx.now })
    .where(and(eq(schema.orbitPartners.tenantId, ctx.tenantId), eq(schema.orbitPartners.id, partnerId)));
  await audit(ctx, {
    action: "orbit.partner.suspend",
    subjectRef: partnerId,
    before: { status: partner.status },
    after: { status: "suspended", reason }
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.partner.suspended",
    subject: partnerId,
    data: { reason, stage: partner.stage }
  });
}

/** Undo a suspension. The stage is untouched, so nothing is re-onboarded. */
export async function resumePartner(ctx: Ctx, partnerId: string): Promise<void> {
  const partner = await must(ctx, schema.orbitPartners, partnerId, "partner");
  if (partner.status !== "suspended") throw conflict(`partner is ${partner.status}, not suspended`);
  await ctx.db
    .update(schema.orbitPartners)
    .set({
      status: partner.goLiveAt ? "active" : "pending",
      suspendedAt: null,
      suspendedReason: null,
      updatedAt: ctx.now
    })
    .where(and(eq(schema.orbitPartners.tenantId, ctx.tenantId), eq(schema.orbitPartners.id, partnerId)));
  await audit(ctx, { action: "orbit.partner.resume", subjectRef: partnerId, after: { status: "active" } });
  await emit(ctx, { module: "orbit", type: "orbit.partner.resumed", subject: partnerId, data: { stage: partner.stage } });
}

export async function terminatePartner(ctx: Ctx, partnerId: string, reason: string): Promise<void> {
  const partner = await must(ctx, schema.orbitPartners, partnerId, "partner");
  if (partner.status === "terminated") throw conflict("partner is already terminated");
  await ctx.db
    .update(schema.orbitPartners)
    .set({
      stage: "terminated",
      status: "terminated",
      terminatedAt: ctx.now,
      suspendedReason: reason,
      updatedAt: ctx.now
    })
    .where(and(eq(schema.orbitPartners.tenantId, ctx.tenantId), eq(schema.orbitPartners.id, partnerId)));
  await audit(ctx, {
    action: "orbit.partner.terminate",
    subjectRef: partnerId,
    before: { stage: partner.stage, status: partner.status },
    after: { stage: "terminated", status: "terminated", reason }
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.partner.terminated",
    subject: partnerId,
    data: { reason, from: partner.stage }
  });
}

/* ------------------------------------------------------------- agreements */

type Agreement = typeof schema.distPartnerAgreements.$inferSelect;

export interface DraftInput {
  partnerId: string;
  kind?: string | undefined;
  terms: Record<string, unknown>;
  documentFileId?: string | undefined;
  effectiveFrom?: number | undefined;
}

/**
 * A new version, always. The terms in force on a sale date are what settles a
 * commission dispute two years later, so an agreement is superseded and never
 * edited — the same discipline as `dist_commission_rates`.
 */
export async function draftAgreement(ctx: Ctx, input: DraftInput): Promise<Agreement> {
  await must(ctx, schema.orbitPartners, input.partnerId, "partner");
  const [latest] = await ctx.db
    .select({ version: schema.distPartnerAgreements.version })
    .from(schema.distPartnerAgreements)
    .where(
      and(
        eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
        eq(schema.distPartnerAgreements.partnerId, input.partnerId)
      )
    )
    .orderBy(desc(schema.distPartnerAgreements.version))
    .limit(1);

  const row: typeof schema.distPartnerAgreements.$inferInsert = {
    id: newId("pag", ctx.now),
    tenantId: ctx.tenantId,
    partnerId: input.partnerId,
    version: (latest?.version ?? 0) + 1,
    kind: input.kind ?? "distribution",
    termsJson: JSON.stringify(input.terms),
    documentFileId: input.documentFileId ?? null,
    signedByUserId: null,
    signedByPartnerName: null,
    signedAt: null,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: null,
    state: "draft",
    supersedesId: null,
    approvalId: null,
    createdBy: actorRef(ctx),
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.distPartnerAgreements).values(row);
  await audit(ctx, { action: "dist.agreement.draft", subjectRef: row.id, after: row });
  await emit(ctx, {
    module: "dist",
    type: "dist.agreement.drafted",
    subject: row.id,
    data: { partnerId: input.partnerId, version: row.version, kind: row.kind }
  });
  return row as Agreement;
}

async function agreement(ctx: Ctx, agreementId: string): Promise<Agreement> {
  return must(ctx, schema.distPartnerAgreements, agreementId, "agreement");
}

export async function sendForSignature(ctx: Ctx, agreementId: string): Promise<Agreement> {
  const row = await agreement(ctx, agreementId);
  if (row.state !== "draft") throw conflict(`agreement is ${row.state}, not draft`);
  await ctx.db
    .update(schema.distPartnerAgreements)
    .set({ state: "pending_signature", updatedAt: ctx.now })
    .where(
      and(
        eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
        eq(schema.distPartnerAgreements.id, agreementId)
      )
    );
  await audit(ctx, {
    action: "dist.agreement.send",
    subjectRef: agreementId,
    before: { state: row.state },
    after: { state: "pending_signature" }
  });
  await emit(ctx, {
    module: "dist",
    type: "dist.agreement.sent_for_signature",
    subject: agreementId,
    data: { partnerId: row.partnerId, version: row.version }
  });
  return { ...row, state: "pending_signature", updatedAt: ctx.now };
}

/**
 * Countersign. The signature is the approval: `dist.agreement_sign` is dual
 * control and decided by `dist:agreements:sign`, which nobody holding
 * `dist:agreements:write` has — so the drafter raises it and someone else's
 * name goes on it. `signedByUserId` is the *decider*, not the caller, because
 * that is who actually bound the tenant.
 */
export async function signAgreement(
  ctx: Ctx,
  agreementId: string,
  input: { signedByPartnerName: string; effectiveFrom?: number | undefined }
): Promise<Agreement> {
  const row = await agreement(ctx, agreementId);
  if (row.signedAt) throw conflict("agreement is already signed");
  if (row.state !== "draft" && row.state !== "pending_signature") {
    throw conflict(`agreement is ${row.state} and cannot be signed`);
  }

  const approval = await gate(ctx, {
    policyKey: "dist.agreement_sign",
    subjectRef: agreementId,
    context: { partnerId: row.partnerId, version: row.version, kind: row.kind }
  });

  // Whatever governed until now stops governing at the moment this starts.
  const [prior] = await ctx.db
    .select()
    .from(schema.distPartnerAgreements)
    .where(
      and(
        eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
        eq(schema.distPartnerAgreements.partnerId, row.partnerId),
        eq(schema.distPartnerAgreements.state, "active")
      )
    )
    .orderBy(desc(schema.distPartnerAgreements.version))
    .limit(1);

  const effectiveFrom = input.effectiveFrom ?? ctx.now;
  if (prior) {
    await ctx.db
      .update(schema.distPartnerAgreements)
      .set({ state: "superseded", effectiveTo: effectiveFrom, updatedAt: ctx.now })
      .where(
        and(
          eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
          eq(schema.distPartnerAgreements.id, prior.id)
        )
      );
  }

  const signedByUserId = (approval?.decidedBy ?? actorRef(ctx)).replace(/^user:/, "");
  const signed: Agreement = {
    ...row,
    state: "active",
    signedAt: ctx.now,
    signedByUserId,
    signedByPartnerName: input.signedByPartnerName,
    effectiveFrom,
    supersedesId: prior?.id ?? null,
    approvalId: approval?.id ?? null,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.distPartnerAgreements)
    .set({
      state: signed.state,
      signedAt: signed.signedAt,
      signedByUserId: signed.signedByUserId,
      signedByPartnerName: signed.signedByPartnerName,
      effectiveFrom: signed.effectiveFrom,
      supersedesId: signed.supersedesId,
      approvalId: signed.approvalId,
      updatedAt: signed.updatedAt
    })
    .where(
      and(
        eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
        eq(schema.distPartnerAgreements.id, agreementId)
      )
    );

  await ctx.db
    .update(schema.orbitPartners)
    .set({ agreementId, updatedAt: ctx.now })
    .where(and(eq(schema.orbitPartners.tenantId, ctx.tenantId), eq(schema.orbitPartners.id, row.partnerId)));

  await audit(ctx, { action: "dist.agreement.sign", subjectRef: agreementId, before: row, after: signed });
  await emit(ctx, {
    module: "dist",
    type: "dist.agreement.signed",
    subject: agreementId,
    data: {
      partnerId: row.partnerId,
      version: row.version,
      supersedes: prior?.id ?? null,
      signedByUserId
    }
  });
  return signed;
}

/** Guard for a caller that hands us a subject kind from the wire. */
export function assertSubjectKind(value: string): SubjectKind {
  if (value === "partner" || value === "channel" || value === "staff") return value;
  throw notFound("subject kind");
}

// ponytail: signing does not auto-complete the `agreement_countersigned` step —
// the operator closes it with the agreement id as evidence. Add the link when a
// second engine needs to react to a signature.

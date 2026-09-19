import { and, desc, eq, gt, lte } from "drizzle-orm";
import { id as newId, schema, ScopeJson } from "@lyra/db";
import { approvalRequired, badRequest, conflict, forbidden, internal, notFound } from "./errors.js";
import { audit } from "./audit.js";
import { emit, type MODULES } from "./events.js";
import { actorRef, type CoreDb, type Ctx } from "./context.js";
import { can, permissionsForRole, type Actor, type Grant, type Permission, type Scope } from "./rbac.js";

// docs/19 §7 + docs/12 §4. One engine; AXIS and the ledger are the heavy users.

export type DualControl = "never" | "above_threshold" | "always";

export interface ApprovalPolicy {
  key: string;
  module: (typeof MODULES)[number];
  /** Permission a decider must hold. */
  decide: Permission;
  dualControl: DualControl;
  /** Minor units. At or above this, dual control applies when `above_threshold`. */
  defaultThresholdMinor?: number;
  /**
   * docs/19 §7: "No transaction type may be added to a tenant's auto-approve
   * allowlist if it debits client money, issues a payout, or crosses a
   * regulatory floor." These ignore `policy.autoApprove` entirely.
   */
  neverAutoApprove?: true;
  /**
   * Default true: a pass-through spends the approval, so a second attempt
   * asks again (one approval authorises exactly one execution). Set false
   * only when the action it gates already has its own DB-level uniqueness
   * guard downstream (a unique index) — there, the approval just needs to
   * exist and stay valid for the whole race window; the index, not gate(),
   * is what tells the single winner from the losers.
   */
  singleUse?: boolean;
}

function policy(p: ApprovalPolicy): ApprovalPolicy {
  return p;
}

/**
 * Validate a proposed `policy.autoApprove` allowlist, returning the reason it
 * may not be stored, or null.
 *
 * Every writer of the array routes through here, because the array is the one
 * documented way out of the approval gate and it has two doors: the settings
 * endpoint that owns it, and the generic tenant CRUD PATCH that replaces
 * `policyJson` wholesale. A guard on one of those is not a guard.
 *
 * Two rules. An unknown key sits in the array granting nothing — the readers
 * look policies up by exact key — so it is refused rather than stored as an
 * inert entry that reads like a permission. And a `neverAutoApprove` policy may
 * not be listed at all: docs/19 §7 puts a floor under any tenant setting, so no
 * payout, client-money movement or regulatory crossing is automatable. `gate()`
 * already declines to honour such an entry; refusing it on the way in means the
 * stored policy never claims something the engine will not do.
 */
export function autoApproveProblem(keys: readonly unknown[]): string | null {
  for (const key of keys) {
    if (typeof key !== "string") return "auto-approve entries must be approval policy keys";
    const p = APPROVAL_POLICIES[key];
    if (!p) return `unknown approval policy "${key}"`;
    if (p.neverAutoApprove) return `"${key}" may never be auto-approved (docs/19 §7)`;
  }
  return null;
}

export const APPROVAL_POLICIES: Record<string, ApprovalPolicy> = Object.fromEntries(
  [
    // money
    // docs/19 §7: "No transaction type may be added to a tenant's auto-approve
    // allowlist if it debits client money, **issues a payout**, or crosses a
    // regulatory floor." REFUND-ISSUE is `payout: true`, so this policy needed
    // the flag and did not have it — found by the obligation-6 property test
    // (docs/27 F22). Without it `autoApproveProblem` accepted "ledger.refund"
    // into a tenant's allowlist, and `runTxn`'s own belt then refused every
    // refund outright rather than gating it: two guards over the same rule
    // disagreeing, which is the shape that always resolves into a support ticket.
    policy({ key: "ledger.refund", module: "ledger", decide: "ledger:payments:refund", dualControl: "above_threshold", defaultThresholdMinor: 500_00, neverAutoApprove: true }),
    policy({ key: "ledger.payout", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.client_money_transfer", module: "ledger", decide: "ledger:client_money:transfer", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.partner_settlement", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.success_fee", module: "ledger", decide: "ledger:invoices:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.period_close", module: "ledger", decide: "ledger:periods:close", dualControl: "above_threshold" }),
    policy({ key: "ledger.manual_journal", module: "ledger", decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true }),
    // docs/27 F2, F3. These four rewrite a result that has already been
    // reported, so none of them has an amount a threshold could compare — the
    // gate is the act itself, and no tenant setting may automate it.
    policy({ key: "ledger.opening_balance", module: "ledger", decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.year_end_close", module: "ledger", decide: "ledger:periods:year_end", dualControl: "always", neverAutoApprove: true }),
    // A reconciliation write-off has no amount worth thresholding: it is small
    // by definition, and a difference small enough to write off unchecked is
    // exactly the size a leak is drawn in. The gate is the act, and the second
    // seat is the same one that posts a manual journal.
    policy({ key: "ledger.write_off", module: "ledger", decide: "ledger:journals:post", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.period_close_force", module: "ledger", decide: "ledger:periods:force_close", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.period_reopen", module: "ledger", decide: "ledger:periods:reopen", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.remit", module: "ledger", decide: "ledger:client_money:transfer", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.surplus", module: "ledger", decide: "ledger:payouts:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ledger.credit_note", module: "ledger", decide: "ledger:invoices:approve", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00, neverAutoApprove: true }),
    // operations
    policy({ key: "axis.case_issue", module: "axis", decide: "axis:cases:approve", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 }),
    policy({ key: "axis.price_match", module: "axis", decide: "axis:quotes:approve", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 }),
    policy({ key: "axis.claim_settlement", module: "axis", decide: "axis:claims:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "axis.escrow_release", module: "axis", decide: "axis:escrow:approve", dualControl: "always", neverAutoApprove: true }),
    // claims (design §A.3). Moving a reserve is a solvency figure, not cash, so a
    // threshold is enough. Paying a claim moves client money out of the door: it
    // is dual control always AND never auto-approved, so no tenant allowlist
    // entry can turn a payout into a one-click action (docs/19 §7).
    policy({ key: "axis.claim_reserve", module: "axis", decide: "axis:claims:reserve_approve", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 }),
    policy({ key: "axis.claim_payment", module: "axis", decide: "axis:claims:pay_approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "axis.claim_exgratia", module: "axis", decide: "axis:claims:pay_approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "axis.recovery_writeoff", module: "axis", decide: "axis:claims:recover", dualControl: "above_threshold", defaultThresholdMinor: 10_000_00 }),
    // policy lifecycle — a bind is a contract with a customer, so it is gated even
    // when small; the threshold only decides whether a second pair of eyes is needed.
    policy({ key: "axis.bind", module: "axis", decide: "axis:policies:create", dualControl: "above_threshold", defaultThresholdMinor: 250_000_00 }),
    policy({ key: "axis.bind_group", module: "axis", decide: "axis:policies:create", dualControl: "above_threshold", defaultThresholdMinor: 100_000_00 }),
    policy({ key: "axis.endorse", module: "axis", decide: "axis:policies:endorse", dualControl: "above_threshold", defaultThresholdMinor: 25_000_00 }),
    // Cancellation gives unearned premium back, so docs/19 §4.1 wants a second
    // pair of eyes whenever money moves: threshold 0 means "any amount at all".
    policy({ key: "axis.cancel", module: "axis", decide: "axis:policies:cancel", dualControl: "above_threshold", defaultThresholdMinor: 0 }),
    // Putting cover back on risk after a lapse is never routine and never
    // automatic — `dualControl: "always"` alone would still yield to a tenant
    // allowlist entry, so it carries `neverAutoApprove` too.
    policy({ key: "axis.reinstate", module: "axis", decide: "axis:policies:reinstate", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "axis.ntu", module: "axis", decide: "axis:policies:ntu", dualControl: "above_threshold", defaultThresholdMinor: 0 }),
    policy({ key: "axis.renew", module: "axis", decide: "axis:policies:renew", dualControl: "above_threshold", defaultThresholdMinor: 250_000_00 }),
    // underwriting referral: risk outside delegated authority (§A.4) — the approval queue IS the escalation path
    policy({ key: "axis.underwriting_referral", module: "axis", decide: "axis:policies:decide_referral", dualControl: "above_threshold", defaultThresholdMinor: 500_000_00 }),
    // distribution — commercial terms with a counterparty, so a second pair of eyes
    policy({ key: "dist.rate_change", module: "core", decide: "dist:rates:approve", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "dist.commission_adjust", module: "core", decide: "dist:commissions:adjust", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 }),
    // An accrual is a financial position, not a note: it books a receivable from
    // the underwriter and a payable to the channel (CLAUDE.md §4, §12), so it is
    // gated on the same terms as the reversal that undoes it.
    policy({
      key: "dist.commission_accrue",
      module: "core",
      decide: "dist:commissions:adjust",
      dualControl: "above_threshold",
      defaultThresholdMinor: 1_000_00,
      // dist_commission_entries_accrual_uq already guards one accrual per
      // (policy, kind); gate() consuming the approval on the first racer
      // would just spend it out from under the other concurrent submits.
      singleUse: false
    }),
    policy({ key: "dist.offering_publish", module: "core", decide: "dist:offerings:publish", dualControl: "never" }),
    policy({ key: "dist.settlement_run", module: "core", decide: "dist:commissions:settle", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "dist.partner_activate", module: "core", decide: "orbit:partners:certify", dualControl: "never" }),
    policy({ key: "dist.rshare_adjust", module: "core", decide: "dist:commissions:adjust", dualControl: "above_threshold", defaultThresholdMinor: 1_000_00 }),
    // Countersigning binds the tenant to commercial terms, so the person who
    // drafted them cannot be the one who signs: `dist:agreements:sign` is held
    // by nobody who holds `dist:agreements:write`.
    policy({ key: "dist.agreement_sign", module: "core", decide: "dist:agreements:sign", dualControl: "always", neverAutoApprove: true }),
    // Waiving a required onboarding step lets something go live unproven. It is
    // never auto-approvable — an allowlist that could skip diligence is the same
    // hole the checklist exists to close.
    // assertOpen() refuses to waive a step that isn't still pending, so the
    // approval doesn't need to be spent to stop a second waive — it just needs
    // to still say "approved" for the audit trail waivedApprovalId points at.
    policy({
      key: "core.onboarding_waive",
      module: "core",
      decide: "core:onboarding:waive",
      dualControl: "always",
      neverAutoApprove: true,
      singleUse: false
    }),
    // A delegation moves the authority to approve to somebody else for a window.
    // Consequential by definition (docs/06 §1), so it is itself approved.
    policy({ key: "core.delegation_grant", module: "core", decide: "core:delegations:write", dualControl: "never" }),
    // growth
    policy({ key: "signal.budget_move", module: "signal", decide: "signal:budget_moves:approve", dualControl: "never" }),
    policy({ key: "signal.campaign_launch", module: "signal", decide: "signal:campaigns:launch", dualControl: "never" }),
    policy({ key: "signal.creative_publish", module: "signal", decide: "signal:creatives:approve", dualControl: "never" }),
    policy({ key: "signal.budget_commit", module: "signal", decide: "signal:campaigns:launch", dualControl: "above_threshold", defaultThresholdMinor: 50_000_00 }),
    policy({ key: "signal.boost", module: "signal", decide: "signal:campaigns:update", dualControl: "never" }),
    policy({ key: "signal.creator_brief", module: "signal", decide: "signal:creatives:approve", dualControl: "never" }),
    // Outbound acquisition contact (engines/signal-outreach.ts). Consequential
    // by definition — it is a message to a person — so every send gates here
    // unless the tenant's auto_approve allowlist names this policy. Consent is
    // checked separately at runtime; the approval covers the *act of sending*,
    // not the permission to.
    policy({ key: "signal.outreach_send", module: "signal", decide: "signal:outreach:send", dualControl: "never" }),
    // retention & service. Both are ORBIT agent tools (engines/orbit-tools.ts)
    // and both reach a customer, so both gate: a renewal offer carries a price,
    // and a document send is an outbound message to a person. Same shape as
    // signal.outreach_send — the approval covers the act of sending, not the
    // permission to; consent and quiet hours are separate runtime floors.
    policy({ key: "orbit.renewal_offer", module: "orbit", decide: "orbit:renewals:approve", dualControl: "never" }),
    policy({ key: "orbit.document_send", module: "orbit", decide: "orbit:conversations:reply", dualControl: "never" }),
    // docs/modules/scout.md §4: "whitespace approvals (promote/park)" — a
    // product-strategy decision, same shape as dist.offering_publish.
    policy({ key: "scout.whitespace_promote", module: "scout", decide: "scout:whitespaces:promote", dualControl: "never" }),
    // governance
    policy({ key: "core.impersonate", module: "core", decide: "core:impersonate:use", dualControl: "always", neverAutoApprove: true }),
    // ADR-0028: a toggle can turn a capability on for every tenant at once; no
    // tenant policy may auto-approve it, since it isn't a tenant's to decide.
    policy({ key: "core.flag_toggle", module: "platform", decide: "admin:flags:write", dualControl: "always", neverAutoApprove: true }),
    // A mandate is delegated spending authority handed to an agent, so it is
    // issued under the same permission as a live credential.
    policy({ key: "core.mandate_register", module: "core", decide: "core:api_keys:create", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "core.unmasked_export", module: "core", decide: "analytics:exports:unmasked", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "compliance.erasure", module: "core", decide: "compliance:erasure:execute", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "compliance.legal_hold_release", module: "core", decide: "compliance:legal_holds:write", dualControl: "always", neverAutoApprove: true }),
    // ai
    policy({ key: "ai.autonomy_raise", module: "ai", decide: "ai:agents:write", dualControl: "always", neverAutoApprove: true }),
    policy({ key: "ai.prompt_publish", module: "ai", decide: "ai:prompts:write", dualControl: "never" }),
    policy({ key: "ai.budget_raise", module: "ai", decide: "ai:budgets:write", dualControl: "above_threshold" })
  ].map((p) => [p.key, p])
);

/** An approval is spent within this window; after it, ask again. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface ApprovalRow {
  id: string;
  tenantId: string;
  subjectRef: string;
  policyKey: string;
  module: string;
  requestedBy: string;
  requestedAt: number;
  decidedBy: string | null;
  decision: string;
  reason: string | null;
  contextJson: string | null;
  decidedAt: number | null;
  /** The delegation the decider acted under, when they held no permission of their own. */
  delegationId: string | null;
}

export interface GateInput {
  /**
   * The caller's own autonomy bound already cleared this amount (see
   * signal-autopilot's boundCheck). Auto-approves — unless the policy is
   * `neverAutoApprove`, which no bound may override.
   */
  withinBound?: boolean;
  policyKey: string;
  subjectRef: string;
  /** Drives threshold-based dual control. */
  amountMinor?: number;
  context?: Record<string, unknown>;
}

/**
 * docs/19 §11.6 — "every payout transaction has an approval with a distinct
 * approver above threshold". Exported so the obligation can be property-tested
 * against the policy table rather than against one hand-picked example
 * (docs/27 F22).
 */
export function needsDualControl(p: ApprovalPolicy, amountMinor: number | undefined): boolean {
  if (p.dualControl === "always") return true;
  if (p.dualControl === "never") return false;
  // Fail closed: an amount the caller could not state may be any amount.
  if (amountMinor == null) return true;
  return amountMinor >= (p.defaultThresholdMinor ?? 0);
}

/**
 * Gate a consequential action. Returns the approval that authorises it, or
 * `null` when the tenant has auto-approved this policy. Throws 403
 * approval_required when one must be obtained — creating the pending record
 * as a side effect so the UI has something to show.
 */
export async function gate(ctx: Ctx, input: GateInput): Promise<ApprovalRow | null> {
  const p = APPROVAL_POLICIES[input.policyKey];
  if (!p) throw internal(`unknown approval policy ${input.policyKey}`);

  // An autonomy bound is a standing grant the tenant configured (an autopilot
  // spend bound, say), so a call under it acts without asking. It is still
  // routed through here rather than around here: `neverAutoApprove` is a floor
  // no bound may undercut, and the decision lands in the audit trail either
  // way. Callers pass `withinBound` instead of skipping the gate entirely.
  if (input.withinBound && !p.neverAutoApprove) {
    await audit(ctx, {
      action: "core.approval.auto",
      subjectRef: input.subjectRef,
      after: { policyKey: p.key, amountMinor: input.amountMinor, withinBound: true }
    });
    return null;
  }

  if (!p.neverAutoApprove && ctx.policy.autoApprove.includes(p.key)) {
    await audit(ctx, {
      action: "core.approval.auto",
      subjectRef: input.subjectRef,
      after: { policyKey: p.key, amountMinor: input.amountMinor }
    });
    return null;
  }

  const existing = await ctx.db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.tenantId, ctx.tenantId),
        eq(schema.approvals.subjectRef, input.subjectRef),
        eq(schema.approvals.policyKey, p.key)
      )
    )
    .orderBy(desc(schema.approvals.requestedAt))
    .limit(1);

  const row = existing[0] as ApprovalRow | undefined;
  if (row?.decision === "approved" && row.decidedAt != null && ctx.now - row.decidedAt <= APPROVAL_TTL_MS) {
    // An approval covers at most the amount it was approved for, and it is
    // single-use: the pass-through spends it, so the next attempt asks again.
    const approvedFor = safeJson<{ amountMinor?: number | null }>(row.contextJson)?.amountMinor ?? 0;
    if ((input.amountMinor ?? 0) <= approvedFor) {
      if (p.singleUse === false) return row;
      await ctx.db
        .update(schema.approvals)
        .set({ decision: "consumed" })
        .where(and(eq(schema.approvals.tenantId, ctx.tenantId), eq(schema.approvals.id, row.id)));
      await audit(ctx, {
        action: "core.approval.consumed",
        subjectRef: input.subjectRef,
        after: { approvalId: row.id, policyKey: p.key, amountMinor: input.amountMinor ?? null }
      });
      return row;
    }
    // Approved for less than is now at stake: fall through and ask again.
  }
  if (row?.decision === "pending") throw approvalRequired(p.key, row.id);
  if (row?.decision === "rejected" && ctx.now - (row.decidedAt ?? 0) <= APPROVAL_TTL_MS) {
    throw approvalRequired(p.key, row.id);
  }

  const created: ApprovalRow = {
    id: newId("apr", ctx.now),
    tenantId: ctx.tenantId,
    subjectRef: input.subjectRef,
    policyKey: p.key,
    module: p.module,
    requestedBy: actorRef(ctx),
    requestedAt: ctx.now,
    decidedBy: null,
    decision: "pending",
    reason: null,
    contextJson: JSON.stringify({
      ...(input.context ?? {}),
      amountMinor: input.amountMinor ?? null,
      dualControl: needsDualControl(p, input.amountMinor)
    }),
    decidedAt: null,
    delegationId: null
  };
  await ctx.db.insert(schema.approvals).values(created);
  await audit(ctx, { action: "core.approval.requested", subjectRef: input.subjectRef, after: created });
  await emit(ctx, {
    module: p.module,
    type: `${p.module}.approval.requested`,
    subject: input.subjectRef,
    data: { approvalId: created.id, policyKey: p.key, amountMinor: input.amountMinor ?? null }
  });

  throw approvalRequired(p.key, created.id);
}

export async function decide(
  ctx: Ctx,
  approvalId: string,
  decision: "approved" | "rejected",
  reason?: string
): Promise<ApprovalRow> {
  const rows = await ctx.db
    .select()
    .from(schema.approvals)
    .where(and(eq(schema.approvals.tenantId, ctx.tenantId), eq(schema.approvals.id, approvalId)))
    .limit(1);
  const row = rows[0] as ApprovalRow | undefined;
  if (!row) throw notFound("approval");
  if (row.decision !== "pending") throw conflict(`already ${row.decision}`);

  const p = APPROVAL_POLICIES[row.policyKey];
  if (!p) throw internal(`unknown approval policy ${row.policyKey}`);

  const subject = { tenantId: ctx.tenantId, module: p.module };
  // A corrupt context fails closed to dual control rather than crashing —
  // or, worse, quietly waiving the second pair of eyes.
  const context = row.contextJson
    ? (safeJson<{ dualControl?: boolean; amountMinor?: number | null }>(row.contextJson) ?? { dualControl: true })
    : {};

  // Lacking the deciding permission is a refusal, not a request for another
  // approval: answering "approval_required" here would send the caller round a
  // loop that can never terminate. A live delegation is the one thing that
  // stands in for the permission, and the row records which one was spent.
  let delegationId: string | null = null;
  if (!can(ctx.actor, p.decide, subject)) {
    const held = await heldDelegation(ctx, {
      policyKey: row.policyKey,
      ...(context.amountMinor == null ? {} : { amountMinor: context.amountMinor })
    });
    if (!held) throw forbidden(p.decide);
    delegationId = held;
  }

  const decider = actorRef(ctx);
  if (context.dualControl && decider === row.requestedBy) {
    throw badRequest("dual control: the approver must differ from the initiator");
  }
  if (decision === "rejected" && !reason) throw badRequest("a rejection needs a reason");

  const decided: ApprovalRow = {
    ...row,
    decidedBy: decider,
    decision,
    reason: reason ?? null,
    decidedAt: ctx.now,
    delegationId
  };
  await ctx.db
    .update(schema.approvals)
    .set({ decidedBy: decider, decision, reason: reason ?? null, decidedAt: ctx.now, delegationId })
    .where(eq(schema.approvals.id, approvalId));

  await audit(ctx, {
    action: `core.approval.${decision}`,
    subjectRef: row.subjectRef,
    before: row,
    after: decided
  });
  await emit(ctx, {
    module: p.module,
    type: `${p.module}.approval.decided`,
    subject: row.subjectRef,
    data: { approvalId, decision, reason: reason ?? null, policyKey: p.key }
  });

  return decided;
}

/* -------------------------------------------------------------- delegation */

// docs/06 §4. Delegation lives here rather than beside the staff engine because
// `decide()` is the only place it means anything: a loan of authority that the
// deciding path cannot see is a row that grants nothing.

export interface DelegationScope {
  policyKeys?: readonly string[] | undefined;
  modules?: readonly string[] | undefined;
}

export interface ResolveInput {
  policyKey: string;
  /** Overrides the policy's own module when a caller scopes more narrowly. */
  module?: string | undefined;
  /** The amount at stake, checked against each delegation's ceiling. */
  amountMinor?: number | undefined;
  /** Ask about one delegator only. Omit to ask "who may decide this at all". */
  fromUserId?: string | undefined;
}

/**
 * A user's grants as login would expand them. The stored bundle wins over the
 * compiled ROLES table, because a tenant may author a custom role and a system
 * role's bundle is written at provisioning time.
 */
export async function grantsFor(db: CoreDb, tenantId: string, userId: string): Promise<Grant[]> {
  const [rows, [user]] = await Promise.all([
    db
      .select({
        key: schema.roles.key,
        permissionsJson: schema.roles.permissionsJson,
        scopeJson: schema.userRoles.scopeJson
      })
      .from(schema.userRoles)
      .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
      .where(and(eq(schema.userRoles.tenantId, tenantId), eq(schema.userRoles.userId, userId))),
    db.select({ providerId: schema.users.providerId }).from(schema.users).where(eq(schema.users.id, userId))
  ]);

  return rows.map((row) => {
    // A stored '[]' is a decision to strip the role and must stay empty;
    // only an unreadable bundle falls back to the compiled table.
    const stored = safeJson<string[]>(row.permissionsJson);
    const permissions = Array.isArray(stored) ? stored : [...permissionsForRole(row.key)];
    const storedScope = row.scopeJson ? (ScopeJson.parse(safeJson(row.scopeJson)) as Scope) : undefined;
    // ROLE-028: provider.viewer's row visibility is derived live from
    // core_users.providerId, not authored per-invite like teamIds — a provider
    // contact's identity doesn't change per role assignment. See ADR-0025.
    const scope =
      user?.providerId != null
        ? { ...storedScope, providerIds: [user.providerId] }
        : storedScope;
    return { roleKey: row.key, permissions, ...(scope ? { scope } : {}) };
  });
}

function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Every delegation that currently authorises this policy, as rows.
 *
 * Four rules, all of them load-bearing:
 *  - the window is checked here, so a row the expiry sweep has not reached yet
 *    is already inert;
 *  - a revoked or expired row resolves to nothing;
 *  - `maxAmountMinor` caps what may be decided under the delegation;
 *  - the delegate never gains a permission the delegator does not hold *now* —
 *    the delegator's live grants are re-read, so a mover that stripped their
 *    roles this morning silently narrows every delegation they left behind.
 *
 * Deliberately one hop. A→B and B→C are two independent loans of two different
 * people's authority; feeding a resolved delegate back in as a delegator would
 * make C an approver for A, which is precisely the chain a scoped delegation is
 * supposed to prevent.
 */
async function activeDelegations(
  ctx: Ctx,
  input: ResolveInput
): Promise<(typeof schema.delegations.$inferSelect)[]> {
  const policy = APPROVAL_POLICIES[input.policyKey];
  if (!policy) return [];

  const rows = await ctx.db
    .select()
    .from(schema.delegations)
    .where(
      and(
        eq(schema.delegations.tenantId, ctx.tenantId),
        eq(schema.delegations.status, "active"),
        lte(schema.delegations.startsAt, ctx.now),
        gt(schema.delegations.endsAt, ctx.now),
        input.fromUserId ? eq(schema.delegations.fromUserId, input.fromUserId) : undefined
      )
    );

  const module = input.module ?? policy.module;
  const holds = new Map<string, boolean>();
  const out: (typeof schema.delegations.$inferSelect)[] = [];

  for (const row of rows) {
    if (!inScope(row.scopeJson, input.policyKey, module)) continue;
    // Fail closed: a ceilinged delegation never covers an unstated amount.
    if (row.maxAmountMinor != null && (input.amountMinor == null || input.amountMinor > row.maxAmountMinor))
      continue;

    let held = holds.get(row.fromUserId);
    if (held === undefined) {
      held = can(await delegatorActor(ctx, row.fromUserId), policy.decide, {
        tenantId: ctx.tenantId,
        module: policy.module
      });
      holds.set(row.fromUserId, held);
    }
    if (held) out.push(row);
  }

  return out;
}

/** Who may currently decide this policy on somebody's behalf. */
export async function resolveDelegates(ctx: Ctx, input: ResolveInput): Promise<string[]> {
  const rows = await activeDelegations(ctx, input);
  return [...new Set(rows.map((r) => r.toUserId))];
}

/**
 * The delegation this actor may decide under, or null. Only a signed-in person
 * borrows authority: a scheduler or an API key has exactly the grants it was
 * issued with, and nobody delegates to a machine.
 */
export async function heldDelegation(ctx: Ctx, input: ResolveInput): Promise<string | null> {
  if (ctx.actor.kind !== "user") return null;
  const rows = await activeDelegations(ctx, input);
  return rows.find((r) => r.toUserId === ctx.actor.id)?.id ?? null;
}

function inScope(scopeJson: string | null, policyKey: string, module: string): boolean {
  if (!scopeJson) return true;
  let scope: DelegationScope;
  try {
    scope = JSON.parse(scopeJson) as DelegationScope;
  } catch {
    // An unreadable scope is not an open one.
    return false;
  }
  if (scope.policyKeys?.length && !scope.policyKeys.includes(policyKey)) return false;
  if (scope.modules?.length && !scope.modules.includes(module)) return false;
  return true;
}

/**
 * The delegator as `can()` sees them. `grantsFor` is the same expansion login
 * uses, so a delegation can never resolve to authority a login would not give.
 */
async function delegatorActor(ctx: Ctx, userId: string): Promise<Actor> {
  const grants = await grantsFor(ctx.db, ctx.tenantId, userId);
  return { kind: "user", id: userId, tenantId: ctx.tenantId, grants };
}

export async function pendingApprovals(ctx: Ctx, module?: string, limit = 100): Promise<ApprovalRow[]> {
  const where = module
    ? and(
        eq(schema.approvals.tenantId, ctx.tenantId),
        eq(schema.approvals.decision, "pending"),
        eq(schema.approvals.module, module)
      )
    : and(eq(schema.approvals.tenantId, ctx.tenantId), eq(schema.approvals.decision, "pending"));

  // F60: oldest first. The inbox is a work queue, and a cap that cuts off the
  // tail must drop the *newest* rows — the ones with the least waiting — never
  // the longest-waiting approvals, which a newest-first order silently lost
  // once a tenant held more than `limit` pending rows.
  return ctx.db
    .select()
    .from(schema.approvals)
    .where(where)
    .orderBy(schema.approvals.requestedAt)
    .limit(limit) as Promise<ApprovalRow[]>;
}

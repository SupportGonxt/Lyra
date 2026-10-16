import { and, eq } from "drizzle-orm";
import { requoteRenewal } from "./orbit-requote.js";
import type { Env } from "../env.js";
import { schema } from "@lyra/db";
import { audit, emit, type Ctx } from "@lyra/core";

// docs/02 §? "Workflows for multi-step, long-horizon jobs (renewal campaign
// over 30 days...)". `sweepRenewals` (renewals.ts) only raises a renewal row —
// nothing previously advanced it past `state: "scheduled"`. RenewalWorkflow
// (renewal-workflow.ts) is the durable driver; these are the plain, testable
// steps it calls at each stage.
//
// **This comment used to say the opposite of what the code now does**, and it is
// kept here in corrected form because the shape of the mistake is the lesson:
// it read *"No pricing/quote generation here — an auto_requote strategy only marks
// intent, the actual requote is out of scope until that engine exists (ponytail:
// real gap … nothing consumes `strategy` today either)."* Every clause of that was
// true when written and false now: `orbit-requote.ts` is the engine, `renewalDay0`
// below calls it, and `strategy` decides whether it does. A comment that admits a
// gap is worth having; a comment that admits one **after it is closed** is how a
// reader learns to trust prose over code.

const row = (ctx: Ctx, renewalId: string) =>
  ctx.db
    .select()
    .from(schema.orbitRenewals)
    .where(and(eq(schema.orbitRenewals.tenantId, ctx.tenantId), eq(schema.orbitRenewals.id, renewalId)));

/** Decided outside this campaign — a human (or a future auto-requote engine) already moved it on. */
const resolved = (state: string) => state === "accepted" || state === "lost";

/**
 * Day 0: open the renewal for action. `{done: true}` short-circuits the rest of the campaign.
 *
 * **And price it, when the strategy says to.** The comment at the head of this file
 * used to read *"No pricing/quote generation here — an auto_requote strategy only
 * marks intent … the actual requote is out of scope until that engine exists."* The
 * engine exists now (`orbit-requote.ts`), so intent becomes a number before the
 * customer is told the renewal is available — because an "offer" with no price is
 * exactly what this gap was.
 *
 * `env` is optional and its absence is the honest default: without a quoter binding
 * the campaign still runs, it just runs with no price, which is the behaviour that
 * shipped for two years. A **failed** re-quote does not stop the campaign either —
 * the panel being unreachable must not strand a renewal that a person can still
 * work — but it is audited, because a price that quietly failed to appear is how the
 * four comments this closes came to be true in the first place.
 */
export async function renewalDay0(ctx: Ctx, renewalId: string, env?: Env): Promise<{ done: boolean }> {
  const [current] = await row(ctx, renewalId);
  if (!current || current.state !== "scheduled") return { done: true };

  if (current.strategy === "auto_requote" && env) {
    try {
      await requoteRenewal(ctx, env, renewalId);
    } catch (error) {
      // Visible, not swallowed: the renewal still opens, and the reason it opened
      // without a price is on the trail.
      await audit(ctx, {
        action: "orbit.renewal.requote_failed",
        subjectRef: renewalId,
        after: { reason: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  const after = { ...current, state: "offered" as const, offeredAt: ctx.now, updatedAt: ctx.now };
  await ctx.db
    .update(schema.orbitRenewals)
    .set({ state: "offered", offeredAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.orbitRenewals.id, renewalId));
  await audit(ctx, { action: "orbit.renewal.offered", subjectRef: renewalId, before: current, after });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.offered",
    subject: renewalId,
    data: { policyRef: current.policyRef, customerId: current.customerId, strategy: current.strategy }
  });
  return { done: false };
}

/** Day 7: nudge if still undecided. */
export async function renewalDay7Followup(ctx: Ctx, renewalId: string): Promise<{ done: boolean }> {
  const [current] = await row(ctx, renewalId);
  if (!current || resolved(current.state)) return { done: true };

  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.followup_due",
    subject: renewalId,
    data: { policyRef: current.policyRef, customerId: current.customerId, ownerRef: current.ownerRef }
  });
  return { done: false };
}

/** Day 21: force the human desk — no auto path gets to ride silence all the way to expiry. */
export async function renewalDay21Escalate(ctx: Ctx, renewalId: string): Promise<{ done: boolean }> {
  const [current] = await row(ctx, renewalId);
  if (!current || resolved(current.state)) return { done: true };

  const after = { ...current, strategy: "human" as const, updatedAt: ctx.now };
  await ctx.db
    .update(schema.orbitRenewals)
    .set({ strategy: "human", updatedAt: ctx.now })
    .where(eq(schema.orbitRenewals.id, renewalId));
  await audit(ctx, { action: "orbit.renewal.escalated", subjectRef: renewalId, before: current, after });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.escalated",
    subject: renewalId,
    data: { policyRef: current.policyRef, customerId: current.customerId }
  });
  return { done: false };
}

/** Day 30: still nobody home — the campaign ends, the queue must not hold a renewal forever. */
export async function renewalExpireIfUndecided(ctx: Ctx, renewalId: string): Promise<void> {
  const [current] = await row(ctx, renewalId);
  if (!current || resolved(current.state)) return;

  const after = {
    ...current,
    state: "lost" as const,
    outcomeReason: "expired_no_response",
    decidedAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.orbitRenewals)
    .set({ state: "lost", outcomeReason: "expired_no_response", decidedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.orbitRenewals.id, renewalId));
  await audit(ctx, { action: "orbit.renewal.lost", subjectRef: renewalId, before: current, after });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.lost",
    subject: renewalId,
    data: { policyRef: current.policyRef, customerId: current.customerId, reason: "expired_no_response" }
  });
}

export interface RenewalWorkflowParams {
  tenantId: string;
  renewalId: string;
}

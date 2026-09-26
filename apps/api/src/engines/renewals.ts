import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { emit, type Ctx } from "@lyra/core";
import type { RenewalWorkflowParams } from "./renewal-campaign.js";

// docs/05 J-C3. A renewal is raised by a sweep, not by a person — `orbit:renewals`
// carries read and update and no create, so without this tick the retention desk
// has an empty queue for ever and the one-tap renewal journey never starts.

/** A policy enters the renewal queue this far ahead of its end date. */
const WINDOW_DAYS = 45;

const DAY_MS = 86_400_000;

/**
 * docs/modules/orbit.md §2.2 — "Nightly Workflow scores expiring policies
 * (churn model: features from spine + engagement)". A weighted, explainable
 * formula over signals ORBIT already has on file (policy tenure and claims
 * from the AXIS spine, conversation recency/sentiment from ORBIT itself) —
 * same shape as the momentum.ts sibling: a pure scoring fn, not a model.
 */
export interface ChurnInputs {
  /** Days since the policy started; a longer relationship churns less. */
  readonly tenureDays: number;
  /** Claims filed on this policy/customer; a heavy claimant is a renewal risk either way. */
  readonly claimsCount: number;
  /** Days since the customer's last conversation touch; null = no conversation on record. */
  readonly daysSinceLastContact: number | null;
  /** Most recent conversation sentiment, -100..100; null = no signal. */
  readonly lastSentiment: number | null;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** churnScore = tenure risk + claims risk + engagement risk, weighted onto 0-100. */
export function churnScore(inputs: ChurnInputs): number {
  // Full tenure risk under a month old; fades to none by 3 years.
  const tenureRisk = 40 * clamp((1095 - inputs.tenureDays) / (1095 - 30), 0, 1);
  const claimsRisk = Math.min(35, inputs.claimsCount * 15);
  // No conversation on record is an unknown, not a maximal, risk.
  const silenceRisk =
    inputs.daysSinceLastContact === null ? 10 : 20 * clamp(inputs.daysSinceLastContact / 180, 0, 1);
  const sentimentRisk =
    inputs.lastSentiment !== null && inputs.lastSentiment < 0
      ? 5 * clamp(-inputs.lastSentiment / 100, 0, 1)
      : 0;
  return Math.round(clamp(tenureRisk + claimsRisk + silenceRisk + sentimentRisk, 0, 100));
}

/** orbit_renewals.strategy values this sweep can pick: docs/modules/orbit.md §8 A/B, plus the third (consent-driven) value the schema reserves but this sweep does not assign. */
export type RenewalStrategy = "auto_requote" | "human";

/** FNV-1a over a string, folded to [0, 1) — sync, dependency-free, stable across runs. */
function stableUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0xffffffff;
}

/** A renewal already this risky goes straight to the human desk — no experimenting on a flight risk. */
const HIGH_RISK_FLOOR = 65;

/**
 * docs/modules/orbit.md §8 — "Renewal cohort A/B (auto vs control) instrumented
 * from day one." Split is a stable hash of a stable id (the policy ref, in
 * `sweepRenewals` below), not Math.random or Date.now, so the same policy
 * lands in the same cohort on every sweep re-run and every test run.
 */
export function assignCohort(id: string, score: number): RenewalStrategy {
  if (score >= HIGH_RISK_FLOOR) return "human";
  return stableUnit(id) < 0.5 ? "auto_requote" : "human";
}

/**
 * Insert a `scheduled` renewal for every active policy expiring inside the
 * window that does not have one yet. Idempotent: re-running inside the same
 * window is a no-op, so a missed cron tick costs nothing. `wf` starts the
 * day-0/7/21/30 campaign (renewal-workflow.ts) per row raised; unbound
 * on-prem (docs/02 WORKFLOWS=inline — no substitute driver, same no-op-when-
 * unbound idiom as every other optional binding here), the row just sits at
 * `state: "scheduled"` for a human to pick up.
 */
export async function sweepRenewals(ctx: Ctx, wf?: Workflow<RenewalWorkflowParams>): Promise<number> {
  const due = await ctx.db
    .select({
      id: schema.axisPolicies.id,
      customerId: schema.axisPolicies.customerId,
      endAt: schema.axisPolicies.endAt,
      startAt: schema.axisPolicies.startAt
    })
    .from(schema.axisPolicies)
    .where(
      and(
        eq(schema.axisPolicies.tenantId, ctx.tenantId),
        eq(schema.axisPolicies.status, "active"),
        gte(schema.axisPolicies.endAt, ctx.now),
        lte(schema.axisPolicies.endAt, ctx.now + WINDOW_DAYS * 86_400_000)
      )
    );
  if (!due.length) return 0;

  const existing = new Set(
    (
      await ctx.db
        .select({ policyRef: schema.orbitRenewals.policyRef })
        .from(schema.orbitRenewals)
        .where(
          and(
            eq(schema.orbitRenewals.tenantId, ctx.tenantId),
            // Dedupe per term, not per policy: last term's (now expired) renewal
            // must not suppress this term's forever. Only a renewal for a
            // still-future expiry counts as "already raised".
            gte(schema.orbitRenewals.expiryAt, ctx.now),
            inArray(
              schema.orbitRenewals.policyRef,
              due.map((p) => p.id)
            )
          )
        )
    ).map((r) => r.policyRef)
  );

  const pending = due.filter((p) => !existing.has(p.id));
  if (!pending.length) return 0;

  const customerIds = [...new Set(pending.map((p) => p.customerId))];

  const claims = await ctx.db
    .select({ customerId: schema.axisClaims.customerId })
    .from(schema.axisClaims)
    .where(and(eq(schema.axisClaims.tenantId, ctx.tenantId), inArray(schema.axisClaims.customerId, customerIds)));
  const claimsByCustomer = new Map<string, number>();
  for (const c of claims) claimsByCustomer.set(c.customerId, (claimsByCustomer.get(c.customerId) ?? 0) + 1);

  // Latest conversation touch per customer: same "order by desc, keep first
  // seen" idiom signal-suppression.ts uses for latest-consent-per-customer.
  const convos = await ctx.db
    .select({
      customerId: schema.orbitConversations.customerId,
      lastMessageAt: schema.orbitConversations.lastMessageAt,
      sentiment: schema.orbitConversations.sentiment
    })
    .from(schema.orbitConversations)
    .where(
      and(eq(schema.orbitConversations.tenantId, ctx.tenantId), inArray(schema.orbitConversations.customerId, customerIds))
    )
    .orderBy(desc(schema.orbitConversations.lastMessageAt));
  const latestByCustomer = new Map<string, { lastMessageAt: number | null; sentiment: number | null }>();
  for (const c of convos) {
    if (c.customerId && !latestByCustomer.has(c.customerId)) {
      latestByCustomer.set(c.customerId, { lastMessageAt: c.lastMessageAt, sentiment: c.sentiment });
    }
  }

  const rows = pending.map((p) => {
    const latest = latestByCustomer.get(p.customerId);
    const score = churnScore({
      tenureDays: Math.max(0, (ctx.now - p.startAt) / DAY_MS),
      claimsCount: claimsByCustomer.get(p.customerId) ?? 0,
      daysSinceLastContact: latest?.lastMessageAt != null ? (ctx.now - latest.lastMessageAt) / DAY_MS : null,
      lastSentiment: latest?.sentiment ?? null
    });
    return {
      id: newId("rnw", ctx.now),
      tenantId: ctx.tenantId,
      policyRef: p.id,
      customerId: p.customerId,
      expiryAt: p.endAt,
      churnScore: score,
      // Hash the policy id, not the freshly minted renewal id: the policy id
      // is stable and known before insert, so the same policy always maps to
      // the same cohort — a ulid's random suffix would not be.
      strategy: assignCohort(p.id, score),
      state: "scheduled",
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
  });

  await ctx.db.insert(schema.orbitRenewals).values(rows as never);
  // docs/04 §7 `orbit.renewal.due`: the fact that a renewal was raised. Journeys
  // (orbit-journeys.ts, which enrol `data.customerId`) and webhook subscribers
  // hear of it here or nowhere — the sweep is the only writer of these rows.
  for (const row of rows) {
    await emit(ctx, {
      module: "orbit",
      type: "orbit.renewal.due",
      subject: row.id,
      data: {
        policyRef: row.policyRef,
        customerId: row.customerId,
        expiryAt: row.expiryAt,
        strategy: row.strategy,
        // SIGNAL's churn-risk prospects (ADR-0091) hear the score here.
        churnScore: row.churnScore
      }
    });
  }
  if (wf) {
    for (const row of rows) {
      await wf.create({ params: { tenantId: ctx.tenantId, renewalId: row.id } });
    }
  }
  return rows.length;
}

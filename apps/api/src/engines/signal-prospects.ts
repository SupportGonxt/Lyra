import { and, eq, inArray, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { PROSPECT_CHURN_FLOOR, type Ctx, type Envelope } from "@lyra/core";

// ADR-0091. The identified people SIGNAL has a reason to talk to, filled from
// other modules' events — never by reading their tables (CLAUDE.md rule 6).
// A prospect is a fact about someone, not permission to contact them: outreach
// still runs consent, quiet hours, the weekly cap and the approval gate.

export const PROSPECT_REASONS = ["quote_expired", "churn_risk", "no_policy"] as const;
export type ProspectReason = (typeof PROSPECT_REASONS)[number];

/** orbit.renewal.due's churnScore is 0-100 (renewals.ts); below this a renewal is routine. */
export const CHURN_PROSPECT_FLOOR = PROSPECT_CHURN_FLOOR;

/** How much each reason says about intent: an expired quote was a hand raised. */
const BASE_SCORE: Record<Exclude<ProspectReason, "churn_risk">, number> = { quote_expired: 70, no_policy: 30 };

async function upsert(
  ctx: Ctx,
  customerId: string,
  reason: ProspectReason,
  score: number,
  evidence: Record<string, unknown>,
  sourceRef: string | null
): Promise<void> {
  await ctx.db
    .insert(schema.signalProspects)
    .values({
      id: newId("psp", ctx.now),
      tenantId: ctx.tenantId,
      customerId,
      reason,
      evidenceJson: JSON.stringify(evidence),
      score,
      state: "open",
      sourceRef,
      createdAt: ctx.now,
      updatedAt: ctx.now
    })
    .onConflictDoUpdate({
      target: [schema.signalProspects.tenantId, schema.signalProspects.customerId, schema.signalProspects.reason],
      // A fresh signal reopens a converted prospect (a new quote lapsed); a
      // withdrawn consent is never reopened by anything but the person.
      set: {
        evidenceJson: JSON.stringify(evidence),
        score,
        sourceRef,
        state: sql`case when ${schema.signalProspects.state} = 'suppressed' then 'suppressed' else 'open' end`,
        updatedAt: ctx.now
      }
    });
}

async function setState(ctx: Ctx, customerId: string, to: string, from: string[]): Promise<void> {
  await ctx.db
    .update(schema.signalProspects)
    .set({ state: to, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.signalProspects.tenantId, ctx.tenantId),
        eq(schema.signalProspects.customerId, customerId),
        inArray(schema.signalProspects.state, from)
      )
    );
}

export const markProspectsContacted = (ctx: Ctx, customerId: string) => setState(ctx, customerId, "contacted", ["open"]);
export const markProspectsResponded = (ctx: Ctx, customerId: string) =>
  setState(ctx, customerId, "responded", ["open", "contacted"]);

export async function onProspectSignal(ctx: Ctx, e: Envelope): Promise<void> {
  const d = e.data as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
  switch (e.type) {
    case "dist.quote.expired": {
      const customerId = str("customerId");
      if (!customerId) return; // anonymous shop: nobody identified
      await upsert(ctx, customerId, "quote_expired", BASE_SCORE.quote_expired, { productId: str("productId"), expiredAt: e.ts }, str("quoteRequestId"));
      return;
    }
    case "orbit.renewal.due": {
      const customerId = str("customerId");
      const score = typeof d.churnScore === "number" ? Math.round(d.churnScore) : null;
      if (!customerId || score === null || score < (ctx.policy.signalChurnProspectFloor ?? CHURN_PROSPECT_FLOOR)) return;
      await upsert(ctx, customerId, "churn_risk", score, { expiryAt: d.expiryAt ?? null }, str("policyRef"));
      return;
    }
    case "core.customers.created": {
      const customerId = str("id");
      if (customerId) await upsert(ctx, customerId, "no_policy", BASE_SCORE.no_policy, {}, null);
      return;
    }
    case "axis.policy.issued": {
      const customerId = str("customerId");
      if (customerId) await setState(ctx, customerId, "converted", ["open", "contacted", "responded"]);
      return;
    }
    case "core.consent.updated": {
      const customerId = str("customerId");
      const purposes = d.purposes as { marketing?: boolean } | undefined;
      if (customerId && purposes?.marketing === false) {
        await setState(ctx, customerId, "suppressed", ["open", "contacted", "responded", "converted"]);
      }
      return;
    }
  }
}

/** Open prospects per reason. Counts only — what a broad brief may show a model. */
export async function prospectCounts(ctx: Ctx): Promise<Partial<Record<ProspectReason, number>>> {
  const rows = await ctx.db
    .select({ reason: schema.signalProspects.reason, n: sql<number>`count(*)` })
    .from(schema.signalProspects)
    .where(and(eq(schema.signalProspects.tenantId, ctx.tenantId), eq(schema.signalProspects.state, "open")))
    .groupBy(schema.signalProspects.reason);
  return Object.fromEntries(rows.map((r) => [r.reason, r.n]));
}

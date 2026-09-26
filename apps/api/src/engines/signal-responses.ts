import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import type { Ctx, Envelope } from "@lyra/core";
import { markProspectsResponded } from "./signal-prospects.js";

// ADR-0091. What came back from a send, at every scale at once: each row names
// its campaign (broad), audience (niche) and person (individual). Fed by ORBIT's
// message events and SIGNAL's own sends and binds — never by reading ORBIT.

export const RESPONSE_KINDS = ["delivered", "read", "replied", "lead", "bind", "opted_out"] as const;
export type ResponseKind = (typeof RESPONSE_KINDS)[number];

/** A reply or opt-out this long after the send is not about the send. */
const CREDIT_WINDOW_MS = 14 * 86_400_000;

type OutreachRow = typeof schema.signalOutreach.$inferSelect;

/** One of each kind per send (unique index): a redelivered receipt counts once. */
export async function recordResponse(ctx: Ctx, outreach: OutreachRow, kind: ResponseKind, ref: string | null = null): Promise<void> {
  const [campaign] = await ctx.db
    .select({ audienceId: schema.signalCampaigns.audienceId })
    .from(schema.signalCampaigns)
    .where(and(eq(schema.signalCampaigns.tenantId, ctx.tenantId), eq(schema.signalCampaigns.id, outreach.campaignId)))
    .limit(1);
  await ctx.db
    .insert(schema.signalResponses)
    .values({
      id: newId("rsp", ctx.now),
      tenantId: ctx.tenantId,
      campaignId: outreach.campaignId,
      audienceId: campaign?.audienceId ?? null,
      customerId: outreach.customerId,
      outreachId: outreach.id,
      kind,
      ref,
      ts: ctx.now
    })
    .onConflictDoNothing();
}

/** The newest send to this person (optionally into this conversation) still inside the credit window. */
async function recentSend(ctx: Ctx, where: { customerId?: string; conversationId?: string }): Promise<OutreachRow | undefined> {
  const [row] = await ctx.db
    .select()
    .from(schema.signalOutreach)
    .where(
      and(
        eq(schema.signalOutreach.tenantId, ctx.tenantId),
        inArray(schema.signalOutreach.state, ["sent", "converted"]),
        gte(schema.signalOutreach.ts, ctx.now - CREDIT_WINDOW_MS),
        where.customerId ? eq(schema.signalOutreach.customerId, where.customerId) : undefined,
        where.conversationId ? eq(schema.signalOutreach.conversationId, where.conversationId) : undefined
      )
    )
    .orderBy(desc(schema.signalOutreach.ts))
    .limit(1);
  return row;
}

export async function onResponseSignal(ctx: Ctx, e: Envelope): Promise<void> {
  const d = e.data as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === "string" && d[k] ? (d[k] as string) : null);
  switch (e.type) {
    case "orbit.message.status": {
      const externalRef = str("externalRef");
      const status = str("status");
      if (!externalRef || (status !== "delivered" && status !== "read")) return;
      const [outreach] = await ctx.db
        .select()
        .from(schema.signalOutreach)
        .where(and(eq(schema.signalOutreach.tenantId, ctx.tenantId), eq(schema.signalOutreach.externalRef, externalRef)))
        .limit(1);
      if (outreach) await recordResponse(ctx, outreach, status, externalRef);
      return;
    }
    case "orbit.message.received": {
      const conversationId = str("conversationId");
      if (!conversationId) return;
      const outreach = await recentSend(ctx, { conversationId });
      if (!outreach) return;
      await recordResponse(ctx, outreach, "replied", str("messageId"));
      await markProspectsResponded(ctx, outreach.customerId);
      return;
    }
    case "core.consent.updated": {
      const customerId = str("customerId");
      if (!customerId || (d.purposes as { marketing?: boolean } | undefined)?.marketing !== false) return;
      const outreach = await recentSend(ctx, { customerId });
      if (outreach) await recordResponse(ctx, outreach, "opted_out", e.subject ?? null);
      return;
    }
  }
}

export type RollupLevel = "campaign" | "audience" | "customer";

const LEVEL_COLUMN = {
  campaign: schema.signalResponses.campaignId,
  audience: schema.signalResponses.audienceId,
  customer: schema.signalResponses.customerId
} as const;

/** Counts per kind, grouped by the chosen scale. `lead` is one per send, so it is the denominator. */
export async function responseRollup(
  ctx: Ctx,
  level: RollupLevel,
  since: number
): Promise<Array<{ key: string; counts: Partial<Record<ResponseKind, number>> }>> {
  const column = LEVEL_COLUMN[level];
  const rows = await ctx.db
    .select({ key: column, kind: schema.signalResponses.kind, n: sql<number>`count(*)` })
    .from(schema.signalResponses)
    .where(and(eq(schema.signalResponses.tenantId, ctx.tenantId), gte(schema.signalResponses.ts, since)))
    .groupBy(column, schema.signalResponses.kind)
    .orderBy(column);
  const out = new Map<string, Partial<Record<ResponseKind, number>>>();
  for (const r of rows) {
    if (!r.key) continue;
    const counts = out.get(r.key) ?? {};
    counts[r.kind as ResponseKind] = r.n;
    out.set(r.key, counts);
  }
  return [...out].map(([key, counts]) => ({ key, counts }));
}

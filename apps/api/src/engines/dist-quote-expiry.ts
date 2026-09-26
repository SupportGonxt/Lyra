import { and, inArray, isNotNull, lt, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { emit, type Ctx } from "@lyra/core";

const LIVE = ["open", "fanned_out", "complete"];

/**
 * Lapses every live comparative shop past its `expiresAt` and announces it as
 * `dist.quote.expired` — the hand someone raised and put down again, which
 * SIGNAL records as a prospect (ADR-0091). Idempotent: an expired row is not live.
 */
export async function expireQuoteRequests(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select({ id: schema.distQuoteRequests.id, customerId: schema.distQuoteRequests.customerId, productId: schema.distQuoteRequests.productId })
    .from(schema.distQuoteRequests)
    .where(
      and(
        eq(schema.distQuoteRequests.tenantId, ctx.tenantId),
        inArray(schema.distQuoteRequests.state, LIVE),
        isNotNull(schema.distQuoteRequests.expiresAt),
        lt(schema.distQuoteRequests.expiresAt, ctx.now)
      )
    );
  for (const r of due) {
    await ctx.db
      .update(schema.distQuoteRequests)
      .set({ state: "expired", updatedAt: ctx.now })
      .where(and(eq(schema.distQuoteRequests.id, r.id), inArray(schema.distQuoteRequests.state, LIVE)));
    await emit(ctx, {
      module: "dist",
      type: "dist.quote.expired",
      subject: r.id,
      data: { quoteRequestId: r.id, customerId: r.customerId, productId: r.productId }
    });
  }
  return due.length;
}

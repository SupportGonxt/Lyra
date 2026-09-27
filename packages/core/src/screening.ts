import { and, eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { conflict } from "./errors.js";
import type { Ctx } from "./context.js";

/**
 * docs/19 §4: a screening hit blocks, and clearing it is a person's
 * disposition. Asked by every door that binds cover or books a sale — here in
 * core because those doors live in different modules (CLAUDE.md §6) and must
 * all ask the same question.
 */
export async function assertNotScreenedOut(ctx: Ctx, customerId: string | null | undefined): Promise<void> {
  if (!customerId) return;
  const [block] = await ctx.db
    .select({ id: schema.screenings.id, kind: schema.screenings.kind })
    .from(schema.screenings)
    .where(
      and(
        eq(schema.screenings.tenantId, ctx.tenantId),
        eq(schema.screenings.subjectRef, `customer:${customerId}`),
        eq(schema.screenings.blocked, true)
      )
    )
    .limit(1);
  if (block) throw conflict(`the customer has a standing ${block.kind} screening hit (${block.id}); a compliance disposition must clear it first`);
}

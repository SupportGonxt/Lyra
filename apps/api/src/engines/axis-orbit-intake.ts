import { schema } from "@lyra/db";
import type { Ctx, Envelope } from "@lyra/core";

// docs/30 ORBIT 5, CLAUDE.md rule 6. ORBIT's agent used to insert AXIS rows
// itself, so ORBIT could not run without AXIS and AXIS could not tell who wrote
// its tables. ORBIT now announces what it needs; AXIS, when it is on, raises
// the row. The ids arrive minted, so a replayed event cannot raise a second one.

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** `orbit.quote.requested`: the agent's start_quote becomes an intake case. */
export async function onQuoteRequested(ctx: Ctx, e: Envelope): Promise<void> {
  const d = e.data as Record<string, unknown>;
  const caseId = str(d.caseId);
  const customerId = str(d.customerId);
  if (!caseId || !customerId) return;
  await ctx.db
    .insert(schema.axisCases)
    .values({
      id: caseId,
      tenantId: ctx.tenantId,
      ref: caseId,
      kind: "quote",
      customerId,
      productLine: str(d.productLine),
      channelId: str(d.channelId),
      status: "intake",
      ownerRef: e.actor,
      source: "agent",
      createdAt: e.ts,
      updatedAt: e.ts
    })
    .onConflictDoNothing();
}

/** `orbit.conversation.document` in collect mode on a case: AXIS's chase task. */
export async function onDocumentRequested(ctx: Ctx, e: Envelope): Promise<void> {
  const d = e.data as Record<string, unknown>;
  const caseId = str(d.caseId);
  const taskId = str(d.taskId);
  if (d.mode !== "collect" || !caseId || !taskId) return;
  await ctx.db
    .insert(schema.axisTasks)
    .values({
      id: taskId,
      tenantId: ctx.tenantId,
      caseId,
      type: "document_collect",
      titleKey: `axis.task.document_collect.${str(d.docType) ?? "document"}`,
      state: "open",
      createdBy: e.actor,
      createdAt: e.ts,
      updatedAt: e.ts
    })
    .onConflictDoNothing();
}

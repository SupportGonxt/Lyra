import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { forgetMemories, forgetNotes, refId, scoped, type Ctx, type Envelope } from "@lyra/core";

// docs/12 §3, docs/27 F34, ADR-0089. `forgetMemories` was named as the seam a
// DSAR runner would call and nothing called it, so a fulfilled erasure reached
// neither what the AI had concluded about the person nor what staff had written.
// This is that caller, and it covers both halves of per-record memory.
//
// It runs when a DSAR row is updated (generic CRUD emits
// `compliance.dsar-requests.updated`) and acts only on a *fulfilled erasure*
// with a known customer: fulfilment is the compliance officer's decision, and
// this makes the memory half of it true rather than making it for them. It
// does not erase the customer row, policies or ledger — those carry statutory
// retention (docs/12 §3) and are the officer's call, table by table.
//
// A customer's memories are held under three spellings in practice: the
// seed's `customer:cu_…`, a bare `cu_…`, and — for ORBIT runs — the id of each
// conversation with them, so all three are erased.

interface DsarUpdatedData {
  id?: string;
}

export async function onDsarUpdated(ctx: Ctx, envelope: Envelope): Promise<void> {
  const dsarId = (envelope.data as DsarUpdatedData).id ?? envelope.subject;
  if (!dsarId) return;
  const [dsar] = await ctx.db
    .select()
    .from(schema.dsarRequests)
    .where(scoped(ctx, schema.dsarRequests, eq(schema.dsarRequests.id, dsarId)))
    .limit(1);
  if (!dsar || dsar.type !== "erasure" || dsar.state !== "fulfilled" || !dsar.customerId) return;

  // Once per DSAR: an officer editing a fulfilled request afterwards must not
  // grow a second set of log rows claiming a second erasure happened.
  const logged = await ctx.db
    .select({ id: schema.erasureLog.id })
    .from(schema.erasureLog)
    .where(
      and(
        eq(schema.erasureLog.tenantId, ctx.tenantId),
        eq(schema.erasureLog.dsarId, dsar.id),
        eq(schema.erasureLog.tableName, "core_notes")
      )
    )
    .limit(1);
  if (logged.length) return;

  const customerId = dsar.customerId;
  const conversations = await ctx.db
    .select({ id: schema.orbitConversations.id })
    .from(schema.orbitConversations)
    .where(and(eq(schema.orbitConversations.tenantId, ctx.tenantId), eq(schema.orbitConversations.customerId, customerId)));
  const ids = [customerId, ...conversations.map((c) => c.id)];

  let memories = 0;
  for (const id of ids) {
    for (const spelling of new Set([id, `customer:${id}`, `conversation:${id}`])) {
      memories += await forgetMemories(ctx, spelling);
    }
  }

  const notes = { notes: 0, links: 0, redacted: 0 };
  const erased = new Set(ids);
  const sameRecord = (ref: string) => erased.has(refId(ref));
  for (const ref of [`customer:${customerId}`, ...conversations.map((c) => `conversation:${c.id}`)]) {
    const out = await forgetNotes(ctx, ref, sameRecord);
    notes.notes += out.notes;
    notes.links += out.links;
    notes.redacted += out.redacted;
  }

  const row = (tableName: string, rowsErased: number, rowsTombstoned = 0) => ({
    id: newId("ers", ctx.now),
    tenantId: ctx.tenantId,
    dsarId: dsar.id,
    tableName,
    rowsErased,
    rowsTombstoned,
    retainedReason: null,
    ts: ctx.now
  });
  // `rowsTombstoned` on core_notes counts other records' notes that were kept
  // with the erased person's links redacted out of them.
  await ctx.db
    .insert(schema.erasureLog)
    .values([
      row("core_memories", memories),
      row("core_notes", notes.notes, notes.redacted),
      row("core_links", notes.links)
    ]);
}

import { and, desc, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit } from "./audit.js";
import type { Ctx } from "./context.js";

// docs/16 H11 (compounding intelligence). `core_memories` existed as a table and
// nothing else: no writer, no reader, no rule about who may see what
// (docs/27 F34). Its own doc comment set the contract — "purpose-bound reads;
// erasure-linked" — so this is that contract made executable, and the shape of
// it is deliberately the opposite of a cache. A memory is a durable claim about
// a customer, and the interesting question is never "can we find it" but "may
// this call see it", which is why the selection rule is pure and evaluated
// (evals/memory-recall) rather than buried in a query builder.

/** Ordered least to most sensitive; the index is the comparison. */
export const SENSITIVITIES = ["low", "medium", "high"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export interface MemoryRow {
  id: string;
  subjectRef: string;
  kind: string;
  contentJson: string;
  provenance: string;
  sensitivity: string;
  purposesJson: string | null;
  expiry: number | null;
  createdAt: number;
}

export interface RecallOptions {
  /** The purpose of the call asking. A memory not bound to it is not returned. */
  purpose: string;
  now: number;
  /**
   * The most sensitive class this caller may see. Required rather than
   * defaulted: a default here is a decision about customer data that whoever
   * adds the next reader would inherit without making it.
   */
  maxSensitivity: Sensitivity;
  limit?: number;
}

/**
 * Rank a stored sensitivity. An unrecognised label ranks above the top of the
 * scale, so an unclassified memory is withheld rather than waved through —
 * fail closed is the whole reason this function is not a `WHERE` clause.
 */
function rank(sensitivity: string): number {
  const i = (SENSITIVITIES as readonly string[]).indexOf(sensitivity);
  return i === -1 ? SENSITIVITIES.length : i;
}

function boundTo(purposesJson: string | null, purpose: string): boolean {
  // Absent is not universal. A memory nobody bound to a purpose is one nobody
  // decided a use for, and the table's own comment says reads are purpose-bound
  // — reading "null means any" would make the binding optional in practice and
  // therefore absent in most rows within a release or two.
  if (!purposesJson) return false;
  try {
    const parsed: unknown = JSON.parse(purposesJson);
    return Array.isArray(parsed) && parsed.includes(purpose);
  } catch {
    // A malformed binding grants nothing, the same way orbitToolsFor treats a
    // malformed allowlist.
    return false;
  }
}

/**
 * The reads a given call may have, newest first. Pure: every rule that decides
 * whether a memory reaches a prompt is here, where the golden set can drive it.
 */
export function recallable<T extends MemoryRow>(rows: readonly T[], opts: RecallOptions): T[] {
  const ceiling = rank(opts.maxSensitivity);
  const kept = rows.filter(
    (r) =>
      (r.expiry == null || r.expiry > opts.now) &&
      boundTo(r.purposesJson, opts.purpose) &&
      rank(r.sensitivity) <= ceiling
  );
  kept.sort((a, b) => b.createdAt - a.createdAt);
  return opts.limit == null ? kept : kept.slice(0, opts.limit);
}

/**
 * Read a subject's memories for one purpose.
 *
 * Subject-scoped as well as tenant-scoped, for the reason docs/27 F9 gives
 * about vector recall: an ORBIT subject ref is a conversation, and a
 * tenant-only filter pulls another customer's history into a reply about this
 * one. That is a confidentiality breach, not a tenancy one, and no test that
 * only checks `tenantId` will ever see it.
 */
export async function recallMemories(ctx: Ctx, subjectRef: string, opts: RecallOptions): Promise<MemoryRow[]> {
  const rows = await ctx.db
    .select()
    .from(schema.memories)
    .where(and(eq(schema.memories.tenantId, ctx.tenantId), eq(schema.memories.subjectRef, subjectRef)))
    .orderBy(desc(schema.memories.createdAt))
    .limit(200);
  return recallable(rows as MemoryRow[], opts);
}

export interface RememberInput {
  subjectRef: string;
  kind: string;
  content: unknown;
  /** Where this claim came from: an agent run id, a document, a human. */
  provenance: string;
  /** Purposes that may read it back. An empty list stores a memory nothing reads. */
  purposes: string[];
  sensitivity?: Sensitivity;
  /** Absolute ms. A memory with no expiry outlives every reason it was written. */
  expiry?: number;
}

/**
 * Write a memory.
 *
 * Audited like any other write to customer data: a store the platform reasons
 * from is one Compliance has to be able to explain, and "where did the model
 * get that" is unanswerable if the writes are silent.
 */
export async function remember(ctx: Ctx, input: RememberInput): Promise<string> {
  const id = newId("mem", ctx.now);
  const row = {
    id,
    tenantId: ctx.tenantId,
    subjectRef: input.subjectRef,
    kind: input.kind,
    contentJson: JSON.stringify(input.content),
    provenance: input.provenance,
    sensitivity: input.sensitivity ?? "low",
    purposesJson: JSON.stringify(input.purposes),
    expiry: input.expiry ?? null,
    createdAt: ctx.now
  };
  await ctx.db.insert(schema.memories).values(row);
  await audit(ctx, {
    action: "core.memory.written",
    subjectRef: input.subjectRef,
    // The claim itself is not audited, only that one was made and why — the
    // audit log must not become a second copy of the memory store (docs/12 §4).
    after: { id, kind: input.kind, provenance: input.provenance, purposes: input.purposes }
  });
  return id;
}

/**
 * Erasure link (docs/12 §3). Deletes every memory held about a subject and
 * answers how many, which is what an erasure-log row records.
 *
 * Called by the erasure consumer (apps/api/src/engines/compliance-erasure.ts)
 * when an erasure DSAR is fulfilled, beside `forgetNotes` (notes.ts), which is
 * the same link for what staff wrote about the subject (ADR-0085).
 */
export async function forgetMemories(ctx: Ctx, subjectRef: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: schema.memories.id })
    .from(schema.memories)
    .where(and(eq(schema.memories.tenantId, ctx.tenantId), eq(schema.memories.subjectRef, subjectRef)));
  if (!rows.length) return 0;
  await ctx.db
    .delete(schema.memories)
    .where(and(eq(schema.memories.tenantId, ctx.tenantId), eq(schema.memories.subjectRef, subjectRef)));
  await audit(ctx, {
    action: "core.memory.erased",
    subjectRef,
    before: { count: rows.length }
  });
  return rows.length;
}

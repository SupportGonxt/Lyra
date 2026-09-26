import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { z } from "zod";
import { actorRef, type Ctx, type CoreDb } from "./context.js";
import { conflict, notFound } from "./errors.js";

// docs/04 §7. Transactional outbox out, inbox dedupe in, DLQ for what keeps failing.

// The five product modules plus the four cross-cutting ones. `dist`, `compliance`
// and `analytics` own tables and therefore emit events; leaving them out would
// have forced their events to masquerade as `core`.
export const MODULES = [
  "core",
  "dist",
  "axis",
  "orbit",
  "signal",
  "scout",
  "north",
  "ledger",
  "ai",
  "compliance",
  "analytics",
  "platform"
] as const;

export const Envelope = z.object({
  id: z.string(),
  ts: z.number().int(),
  tenant_id: z.string(),
  module: z.enum(MODULES),
  type: z.string(), // `axis.case.issued`
  actor: z.string(),
  subject: z.string().optional(),
  data: z.unknown(),
  v: z.literal(1)
});
export type Envelope = z.infer<typeof Envelope>;

export interface EmitInput {
  module: (typeof MODULES)[number];
  type: string;
  subject?: string;
  data: unknown;
}

/**
 * Queue an event. Call inside the same transaction as the state change it
 * describes — that is the whole point of the outbox.
 */
export async function emit(ctx: Ctx, input: EmitInput): Promise<Envelope> {
  const envelope: Envelope = Envelope.parse({
    id: newId("ev", ctx.now),
    ts: ctx.now,
    tenant_id: ctx.tenantId,
    module: input.module,
    type: input.type,
    actor: actorRef(ctx),
    ...(input.subject === undefined ? {} : { subject: input.subject }),
    data: input.data,
    v: 1
  });

  await ctx.db.insert(schema.eventOutbox).values({
    id: envelope.id,
    tenantId: ctx.tenantId,
    module: input.module,
    type: input.type,
    envelopeJson: JSON.stringify(envelope),
    publishedAt: null,
    attempts: 0,
    lastError: null,
    createdAt: ctx.now
  });

  return envelope;
}

export const MAX_ATTEMPTS = 5;

/**
 * Oldest-first batch of unpublished events, for the queue drainer (cron or DO).
 *
 * Rows that failed to publish MAX_ATTEMPTS times are dead-lettered first —
 * oldest-first with a batch limit means a head of poison rows would otherwise
 * starve every newer event forever. Same pattern as the inbox: dead visibly in
 * core_event_dlq for admin replay (docs/09), never silently dropped.
 */
export async function pendingOutbox(db: CoreDb, limit = 100, now = Date.now()): Promise<Envelope[]> {
  const poison = await db
    .select()
    .from(schema.eventOutbox)
    .where(and(isNull(schema.eventOutbox.publishedAt), gte(schema.eventOutbox.attempts, MAX_ATTEMPTS)));
  for (const row of poison) {
    await db.insert(schema.eventDlq).values({
      id: newId("dlq", now),
      tenantId: row.tenantId,
      type: row.type,
      consumer: "outbox.publish",
      envelopeJson: row.envelopeJson,
      error: (row.lastError ?? "publish failed").slice(0, 500),
      attempts: row.attempts,
      replayedAt: null,
      createdAt: now
    });
    // Stamp publishedAt so the row leaves the pending set exactly once; the DLQ
    // row is the durable record of what actually happened to it.
    await db
      .update(schema.eventOutbox)
      .set({ publishedAt: now })
      .where(eq(schema.eventOutbox.id, row.id));
  }

  const rows = await db
    .select({ envelopeJson: schema.eventOutbox.envelopeJson })
    .from(schema.eventOutbox)
    // The attempts guard is belt-and-braces against a dead-letter write failing
    // above; published_at IS NULL still matches core_event_outbox_drain_idx.
    .where(and(isNull(schema.eventOutbox.publishedAt), lt(schema.eventOutbox.attempts, MAX_ATTEMPTS)))
    .orderBy(schema.eventOutbox.createdAt)
    .limit(limit);
  return rows.map((r: { envelopeJson: string }) => Envelope.parse(JSON.parse(r.envelopeJson)));
}

export async function markPublished(db: CoreDb, ids: readonly string[], at: number): Promise<void> {
  for (const eventId of ids) {
    await db
      .update(schema.eventOutbox)
      .set({ publishedAt: at })
      .where(eq(schema.eventOutbox.id, eventId));
  }
}

export async function markPublishFailed(db: CoreDb, eventId: string, error: string): Promise<void> {
  await db
    .update(schema.eventOutbox)
    .set({ attempts: sql`${schema.eventOutbox.attempts} + 1`, lastError: error.slice(0, 500) })
    .where(eq(schema.eventOutbox.id, eventId));
}

export type ConsumeResult = "processed" | "duplicate" | "retry" | "dead";

/**
 * Run a handler exactly once per (event, consumer). Failures retry until
 * MAX_ATTEMPTS, then land in the DLQ for admin replay (docs/09).
 */
export async function consume(
  db: CoreDb,
  envelope: Envelope,
  consumer: string,
  handler: (e: Envelope) => Promise<void>,
  now: number
): Promise<ConsumeResult> {
  const existing = await db
    .select({ status: schema.eventInbox.status, attempts: schema.eventInbox.attempts })
    .from(schema.eventInbox)
    .where(and(eq(schema.eventInbox.id, envelope.id), eq(schema.eventInbox.consumer, consumer)))
    .limit(1);

  const prior = existing[0];
  if (prior?.status === "done") return "duplicate";
  if (prior?.status === "dead") return "dead";

  const attempts = (prior?.attempts ?? 0) + 1;

  try {
    await handler(envelope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const dead = attempts >= MAX_ATTEMPTS;
    await upsertInbox(db, envelope, consumer, dead ? "dead" : "failed", attempts, now);
    if (dead) {
      await db.insert(schema.eventDlq).values({
        id: newId("dlq", now),
        tenantId: envelope.tenant_id,
        type: envelope.type,
        consumer,
        envelopeJson: JSON.stringify(envelope),
        error: message.slice(0, 500),
        attempts,
        replayedAt: null,
        createdAt: now
      });
      return "dead";
    }
    return "retry";
  }

  await upsertInbox(db, envelope, consumer, "done", attempts, now);
  return "processed";
}

async function upsertInbox(
  db: CoreDb,
  envelope: Envelope,
  consumer: string,
  status: "done" | "failed" | "dead",
  attempts: number,
  now: number
): Promise<void> {
  await db
    .insert(schema.eventInbox)
    .values({
      id: envelope.id,
      tenantId: envelope.tenant_id,
      type: envelope.type,
      consumer,
      processedAt: now,
      attempts,
      status
    })
    .onConflictDoUpdate({
      target: [schema.eventInbox.id, schema.eventInbox.consumer],
      set: { processedAt: now, attempts, status }
    });
}

/** Admin replay: clears the inbox marker so the handler can run again. */
export async function replayDlq(
  ctx: Ctx,
  dlqId: string,
  handler: (e: Envelope) => Promise<void>
): Promise<ConsumeResult> {
  const rows = await ctx.db
    .select()
    .from(schema.eventDlq)
    .where(and(eq(schema.eventDlq.tenantId, ctx.tenantId), eq(schema.eventDlq.id, dlqId)))
    .limit(1);
  const row = rows[0];
  if (!row) return "duplicate";

  const envelope = Envelope.parse(JSON.parse(row.envelopeJson));
  await ctx.db
    .delete(schema.eventInbox)
    .where(and(eq(schema.eventInbox.id, envelope.id), eq(schema.eventInbox.consumer, row.consumer)));

  const result = await consume(ctx.db, envelope, row.consumer, handler, ctx.now);
  if (result === "processed") {
    await ctx.db
      .update(schema.eventDlq)
      .set({ replayedAt: ctx.now })
      .where(eq(schema.eventDlq.id, dlqId));
  }
  return result;
}

/** Housekeeping: published outbox rows older than the cutoff are dead weight. */
export async function pruneOutbox(db: CoreDb, before: number): Promise<void> {
  await db.delete(schema.eventOutbox).where(lt(schema.eventOutbox.publishedAt, before));
}

/**
 * docs/09 "replay from the admin console", docs/30 Admin 4. Re-queues a
 * dead-lettered event: its outbox row goes back to pending, and the dead
 * consumer's inbox mark is cleared so that consumer runs again — every
 * consumer that already succeeded holds `done` and skips it (consume() is
 * exactly-once per event and consumer). Webhook subscribers may see the
 * delivery again; `x-lyra-event-id` is what they dedupe on. Once per row.
 */
export async function replayDead(db: CoreDb, tenantId: string, dlqId: string, now: number): Promise<string> {
  const [row] = await db
    .select()
    .from(schema.eventDlq)
    .where(and(eq(schema.eventDlq.tenantId, tenantId), eq(schema.eventDlq.id, dlqId)))
    .limit(1);
  if (!row) throw notFound("dead-lettered event");
  if (row.replayedAt !== null) throw conflict("this event was already replayed");
  const envelope = Envelope.parse(JSON.parse(row.envelopeJson));

  if (row.consumer !== "outbox.publish") {
    await db
      .delete(schema.eventInbox)
      .where(and(eq(schema.eventInbox.id, envelope.id), eq(schema.eventInbox.consumer, row.consumer)));
  }
  const reset = await db
    .update(schema.eventOutbox)
    .set({ publishedAt: null, attempts: 0, lastError: null })
    .where(and(eq(schema.eventOutbox.tenantId, tenantId), eq(schema.eventOutbox.id, envelope.id)))
    .returning({ id: schema.eventOutbox.id });
  if (!reset.length) {
    await db.insert(schema.eventOutbox).values({
      id: envelope.id,
      tenantId,
      module: envelope.module,
      type: envelope.type,
      envelopeJson: row.envelopeJson,
      publishedAt: null,
      attempts: 0,
      lastError: null,
      createdAt: now
    });
  }
  await db.update(schema.eventDlq).set({ replayedAt: now }).where(eq(schema.eventDlq.id, row.id));
  return envelope.id;
}

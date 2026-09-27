import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { id, schema, type PolicyJson, type RetentionSchedule } from "@lyra/db";
import { audit, scoped, type Ctx } from "@lyra/core";

// docs/12 §3, docs/03 §Retention & residency, docs/30 Compliance 5. The
// retention schedule names four record classes: conversations (24m), files
// (7y for policy documents), ai_audit_log (7y) and consent (indefinite). The
// first three are purgeable classes here; consent is evidence kept for as long
// as the tenant exists, so no request can name it.
//
// One engine behind two doors: `POST /v1/compliance/retention/run` (a person,
// dry-run by default) and the nightly sweep (the tenant's own cadence). Both
// cut off at the later of the class floor and the tenant's policy, both honour
// every open legal hold, and both leave a run row and an audit entry.

type RetentionPolicy = PolicyJson["retention"];

interface Candidate {
  id: string;
  /** Refs a legal hold may name to freeze this row. */
  refs: string[];
  /** Object-store key to remove with the row (files only). */
  r2Key?: string;
}

interface RetentionClass {
  tableName: string;
  /** The regulatory minimum; policy may only keep data longer. */
  floorMonths: number;
  policyMonths(retention: RetentionPolicy): number;
  candidates(ctx: Ctx, cutoffAt: number, limit: number): Promise<Candidate[]>;
  purge(ctx: Ctx, rows: Candidate[], files: R2Bucket | undefined): Promise<void>;
}

export const RETENTION_CLASSES = {
  // docs/12 §3 "conversations 24m". The conversation row stays — QA scores,
  // handovers and deflections are keyed on it — and its content goes.
  messages: {
    tableName: "orbit_messages",
    floorMonths: 24,
    policyMonths: (r) => r.messagesMonths,
    async candidates(ctx, cutoffAt, limit) {
      const rows = await ctx.db
        .select({ id: schema.orbitMessages.id, conversationId: schema.orbitMessages.conversationId })
        .from(schema.orbitMessages)
        .where(scoped(ctx, schema.orbitMessages, lt(schema.orbitMessages.ts, cutoffAt)))
        .limit(limit);
      return rows.map((m) => ({ id: m.id, refs: [`conversation:${m.conversationId}`] }));
    },
    async purge(ctx, rows) {
      await ctx.db.delete(schema.orbitMessages).where(
        and(
          scoped(ctx, schema.orbitMessages),
          inArray(
            schema.orbitMessages.id,
            rows.map((r) => r.id)
          )
        )
      );
    }
  },
  // docs/03 "file retention (7y for policy docs)". The object goes and the row
  // becomes a tombstone (`deleted_at`), the platform's soft delete: whatever
  // still names the file id resolves a row that says it is gone, and `scoped()`
  // stops every reader seeing it.
  files: {
    tableName: "core_files",
    floorMonths: 84,
    policyMonths: (r) => r.filesYears * 12,
    async candidates(ctx, cutoffAt, limit) {
      const rows = await ctx.db
        .select({ id: schema.files.id, subjectRef: schema.files.subjectRef, r2Key: schema.files.r2Key })
        .from(schema.files)
        .where(scoped(ctx, schema.files, lt(schema.files.createdAt, cutoffAt)))
        .limit(limit);
      return rows.map((f) => ({
        id: f.id,
        refs: [`file:${f.id}`, ...(f.subjectRef ? [f.subjectRef] : [])],
        r2Key: f.r2Key
      }));
    },
    async purge(ctx, rows, files) {
      // A tombstone over an object still in the bucket would claim an erasure
      // that did not happen, so without the store there is no purge at all.
      if (!files) throw new Error("the object store is not bound; files cannot be purged");
      await files.delete(rows.flatMap((r) => (r.r2Key ? [r.r2Key] : [])));
      await ctx.db
        .update(schema.files)
        .set({ deletedAt: ctx.now })
        .where(
          and(
            scoped(ctx, schema.files),
            inArray(
              schema.files.id,
              rows.map((r) => r.id)
            )
          )
        );
    }
  },
  // docs/03 "ai_audit_log (7y)". Append-only for seven years, not forever; it
  // is not the hash-chained log (that is core_audit_log, anchored nightly).
  ai_audit: {
    tableName: "ai_audit_log",
    floorMonths: 84,
    policyMonths: (r) => r.aiAuditYears * 12,
    async candidates(ctx, cutoffAt, limit) {
      const rows = await ctx.db
        .select({ id: schema.aiAuditLog.id, subjectRef: schema.aiAuditLog.subjectRef })
        .from(schema.aiAuditLog)
        .where(scoped(ctx, schema.aiAuditLog, lt(schema.aiAuditLog.ts, cutoffAt)))
        .limit(limit);
      return rows.map((a) => ({ id: a.id, refs: a.subjectRef ? [a.subjectRef] : [] }));
    },
    async purge(ctx, rows) {
      await ctx.db.delete(schema.aiAuditLog).where(
        and(
          scoped(ctx, schema.aiAuditLog),
          inArray(
            schema.aiAuditLog.id,
            rows.map((r) => r.id)
          )
        )
      );
    }
  }
} satisfies Record<string, RetentionClass>;

export type RetentionClassKey = keyof typeof RETENTION_CLASSES;

export function isRetentionClass(key: string): key is RetentionClassKey {
  return Object.hasOwn(RETENTION_CLASSES, key);
}

/** ponytail: one batch per call, so a purge cannot time out or blow the SQL
 *  variable limit. Call again while `more` is true. */
export const RETENTION_BATCH = 500;

function monthsBefore(now: number, months: number): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

/**
 * Every ref an open hold freezes. A hold may name the record itself or the
 * person behind it; a customer hold reaches each of that customer's
 * conversations, because messages and AI calls are filed under those.
 */
async function heldRefs(ctx: Ctx): Promise<Set<string>> {
  const refs = new Set(
    (
      await ctx.db
        .select({ subjectRef: schema.legalHolds.subjectRef })
        .from(schema.legalHolds)
        .where(scoped(ctx, schema.legalHolds, isNull(schema.legalHolds.releasedAt)))
    ).map((h) => h.subjectRef)
  );
  const customers = [...refs].filter((r) => r.startsWith("customer:")).map((r) => r.slice("customer:".length));
  if (customers.length) {
    const conversations = await ctx.db
      .select({ id: schema.orbitConversations.id })
      .from(schema.orbitConversations)
      .where(scoped(ctx, schema.orbitConversations, inArray(schema.orbitConversations.customerId, customers)));
    for (const c of conversations) refs.add(`conversation:${c.id}`);
  }
  return refs;
}

export type RetentionRun = typeof schema.retentionRuns.$inferSelect;

export interface RetentionResult {
  dryRun: boolean;
  policyKey: RetentionClassKey;
  tableName: string;
  cutoffAt: number;
  retentionMonths: number;
  rowsAffected: number;
  rowsHeld: number;
  more: boolean;
  /** The row written, on a real run. */
  run?: RetentionRun;
}

export async function runRetention(
  ctx: Ctx,
  policyKey: RetentionClassKey,
  opts: { dryRun: boolean; files?: R2Bucket | undefined; batch?: number }
): Promise<RetentionResult> {
  const klass: RetentionClass = RETENTION_CLASSES[policyKey];
  const batch = opts.batch ?? RETENTION_BATCH;
  const retentionMonths = Math.max(klass.policyMonths(ctx.policy.retention), klass.floorMonths);
  const cutoffAt = monthsBefore(ctx.now, retentionMonths);

  const candidates = await klass.candidates(ctx, cutoffAt, batch);
  const holds = await heldRefs(ctx);
  const purge = candidates.filter((c) => !c.refs.some((ref) => holds.has(ref)));
  const rowsHeld = candidates.length - purge.length;
  const out = {
    dryRun: opts.dryRun,
    policyKey,
    tableName: klass.tableName,
    cutoffAt,
    retentionMonths,
    rowsAffected: purge.length,
    rowsHeld,
    more: candidates.length === batch
  };

  if (opts.dryRun) {
    await audit(ctx, {
      action: "compliance.retention.plan",
      subjectRef: `retention:${policyKey}`,
      after: { policyKey, cutoffAt, rowsAffected: purge.length, rowsHeld }
    });
    return out;
  }

  if (purge.length) await klass.purge(ctx, purge, opts.files);
  const run: RetentionRun = {
    id: id("ret", ctx.now),
    tenantId: ctx.tenantId,
    policyKey,
    tableName: klass.tableName,
    cutoffAt,
    rowsAffected: purge.length,
    rowsHeld,
    state: "done",
    error: null,
    startedAt: ctx.now,
    endedAt: ctx.now
  };
  await ctx.db.insert(schema.retentionRuns).values(run);
  await audit(ctx, { action: "compliance.retention.run", subjectRef: `retention:${policyKey}`, after: run });
  return { ...out, run };
}

const DAY = 86_400_000;
const CADENCE_MS: Record<Exclude<RetentionSchedule, "never">, number> = {
  daily: DAY,
  weekly: 7 * DAY,
  monthly: 30 * DAY
};
/** The nightly window is a quarter hour wide and ticks drift within it, so a
 *  run a few minutes short of a full period still counts as the next one. */
const CADENCE_SLACK = 3_600_000;

export function retentionDue(schedule: RetentionSchedule, lastRunAt: number | undefined, now: number): boolean {
  if (schedule === "never") return false;
  if (lastRunAt === undefined) return true;
  return now - lastRunAt >= CADENCE_MS[schedule] - CADENCE_SLACK;
}

/** Batches one class may take in a night before it waits for the next. */
const MAX_SWEEP_BATCHES = 20;

/**
 * The nightly half: every class whose cadence has come round, batch after
 * batch while it has more, each batch its own run row. A class that fails is
 * recorded as a failed run and the others still run. A tenant with no cadence
 * (the default) is never touched.
 */
export async function sweepRetention(
  ctx: Ctx,
  files: R2Bucket | undefined,
  opts: { batch?: number } = {}
): Promise<RetentionRun[]> {
  const schedule = ctx.policy.retention.schedule;
  if (schedule === "never") return [];
  const done: RetentionRun[] = [];
  for (const policyKey of Object.keys(RETENTION_CLASSES) as RetentionClassKey[]) {
    const [last] = await ctx.db
      .select({ startedAt: schema.retentionRuns.startedAt })
      .from(schema.retentionRuns)
      // A failed run is not the run the cadence owes: tomorrow tries again.
      .where(
        and(
          scoped(ctx, schema.retentionRuns),
          eq(schema.retentionRuns.policyKey, policyKey),
          eq(schema.retentionRuns.state, "done")
        )
      )
      .orderBy(desc(schema.retentionRuns.startedAt))
      .limit(1);
    if (!retentionDue(schedule, last?.startedAt, ctx.now)) continue;
    try {
      for (let i = 0; i < MAX_SWEEP_BATCHES; i++) {
        const result = await runRetention(ctx, policyKey, { dryRun: false, files, ...opts });
        if (result.run) done.push(result.run);
        // Stop when nothing is left, or when all that is left is held.
        if (!result.more || result.rowsAffected === 0) break;
      }
    } catch (err) {
      const klass = RETENTION_CLASSES[policyKey];
      const run: RetentionRun = {
        id: id("ret", ctx.now),
        tenantId: ctx.tenantId,
        policyKey,
        tableName: klass.tableName,
        cutoffAt: monthsBefore(ctx.now, Math.max(klass.policyMonths(ctx.policy.retention), klass.floorMonths)),
        rowsAffected: 0,
        rowsHeld: 0,
        state: "failed",
        error: err instanceof Error ? err.message : String(err),
        startedAt: ctx.now,
        endedAt: ctx.now
      };
      await ctx.db.insert(schema.retentionRuns).values(run);
      await audit(ctx, { action: "compliance.retention.failed", subjectRef: `retention:${policyKey}`, after: run });
      done.push(run);
    }
  }
  return done;
}

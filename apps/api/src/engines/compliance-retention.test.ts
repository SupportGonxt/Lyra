import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { RETENTION_CLASSES, retentionDue, runRetention, sweepRetention } from "./compliance-retention.js";

// docs/30 Compliance 5, docs/12 §3, docs/03 §Retention & residency. The
// retention schedule names four record classes: conversations/messages (24m),
// files (7y for policy documents), ai_audit_log (7y) and consent (indefinite).
// Each purgeable class is proven the same three ways — an expired row goes, a
// held one survives, a young one and another tenant's are untouched — and the
// nightly sweep runs only for a tenant that configured a cadence.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.UTC(2026, 8, 27, 2, 5);
const YEAR = 365 * 86_400_000;
const ANCIENT = NOW - 9 * YEAR; // past every floor
const RECENT = NOW - 30 * 86_400_000;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;

function ctxFor(tenantId: string, policy: Record<string, unknown> = {}, now = NOW): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: { kind: "system", id: "scheduler", tenantId, grants: [] },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse(policy),
    entitlements: EntitlementsJson.parse({})
  };
}

/** A Map is the whole of R2 the purge needs — delete, and a way to look. */
function bucket() {
  const objects = new Map<string, string>();
  return {
    objects,
    binding: {
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
      }
    } as unknown as R2Bucket
  };
}

async function hold(c: Ctx, subjectRef: string, releasedAt: number | null = null): Promise<void> {
  await c.db.insert(schema.legalHolds).values({
    id: `hold_${subjectRef}_${releasedAt ?? "open"}`,
    tenantId: c.tenantId,
    subjectRef,
    reason: "litigation",
    placedBy: "system:test",
    releasedAt,
    createdAt: ANCIENT
  });
}

async function conversation(c: Ctx, id: string, customerId: string | null = null): Promise<void> {
  await c.db.insert(schema.orbitConversations).values({
    id,
    tenantId: c.tenantId,
    customerId,
    channel: "web",
    state: "closed",
    lang: "en",
    createdAt: ANCIENT,
    updatedAt: ANCIENT
  });
}

async function message(c: Ctx, id: string, conversationId: string, ts: number): Promise<void> {
  await c.db.insert(schema.orbitMessages).values({ id, tenantId: c.tenantId, conversationId, role: "customer", content: id, ts });
}

async function file(c: Ctx, id: string, createdAt: number, subjectRef: string | null = null): Promise<void> {
  await c.db.insert(schema.files).values({
    id,
    tenantId: c.tenantId,
    r2Key: `files/${c.tenantId}/${id}`,
    kind: "policy_document",
    subjectRef,
    sha256: "0".repeat(64),
    createdAt
  });
}

async function aiCall(c: Ctx, id: string, ts: number, subjectRef: string | null = null): Promise<void> {
  await c.db.insert(schema.aiAuditLog).values({
    id,
    tenantId: c.tenantId,
    module: "orbit",
    purpose: "cx.reply",
    model: "m",
    provider: "p",
    tier: "fast",
    inputHash: "0".repeat(64),
    actorRef: "system:test",
    subjectRef,
    ts
  });
}

const ids = async (table: typeof schema.orbitMessages | typeof schema.aiAuditLog) =>
  (await drizzle(client).select({ id: table.id }).from(table)).map((r) => r.id);

async function liveFiles(): Promise<string[]> {
  const rows = await drizzle(client).select().from(schema.files);
  return rows.filter((r) => r.deletedAt === null).map((r) => r.id);
}

const runs = async (tenantId: string) =>
  drizzle(client).select().from(schema.retentionRuns).where(eq(schema.retentionRuns.tenantId, tenantId));

const audits = async (action: string) =>
  drizzle(client).select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
});

describe("the record classes", () => {
  it("names exactly the purgeable classes of the retention schedule, each with its floor", () => {
    // Consent is kept indefinitely (docs/03), so it is no class a purge can name.
    expect(Object.keys(RETENTION_CLASSES).sort()).toEqual(["ai_audit", "files", "messages"]);
    expect(RETENTION_CLASSES.messages.floorMonths).toBe(24);
    expect(RETENTION_CLASSES.files.floorMonths).toBe(84);
    expect(RETENTION_CLASSES.ai_audit.floorMonths).toBe(84);
  });

  it("never takes a cutoff below the floor, and follows a policy that keeps longer", async () => {
    const short = await runRetention(ctxFor("t_1", { retention: { messagesMonths: 1, filesYears: 1, aiAuditYears: 1 } }), "files", { dryRun: true });
    expect(short.retentionMonths).toBe(84);
    const long = await runRetention(ctxFor("t_1", { retention: { filesYears: 10 } }), "files", { dryRun: true });
    expect(long.retentionMonths).toBe(120);
    const ai = await runRetention(ctxFor("t_1", { retention: { aiAuditYears: 8 } }), "ai_audit", { dryRun: true });
    expect(ai.retentionMonths).toBe(96);
    const msgs = await runRetention(ctxFor("t_1", { retention: { messagesMonths: 36 } }), "messages", { dryRun: true });
    expect(msgs.retentionMonths).toBe(36);
  });
});

describe("messages", () => {
  it("purges expired messages, keeps held, young and foreign ones", async () => {
    const c = ctxFor("t_1");
    const other = ctxFor("t_2");
    await conversation(c, "cv_free");
    await conversation(c, "cv_held");
    await conversation(c, "cv_cust", "cu_held");
    await conversation(other, "cv_other");
    await message(c, "m_old", "cv_free", ANCIENT);
    await message(c, "m_young", "cv_free", RECENT);
    await message(c, "m_held", "cv_held", ANCIENT);
    await message(c, "m_cust", "cv_cust", ANCIENT);
    await message(other, "m_other", "cv_other", ANCIENT);
    await hold(c, "conversation:cv_held");
    await hold(c, "customer:cu_held");

    const out = await runRetention(c, "messages", { dryRun: false });
    expect(out.rowsAffected).toBe(1);
    expect(out.rowsHeld).toBe(2);
    expect((await ids(schema.orbitMessages)).sort()).toEqual(["m_cust", "m_held", "m_other", "m_young"]);
  });
});

describe("files", () => {
  it("removes the object and tombstones the row; held, young and foreign files stay", async () => {
    const c = ctxFor("t_1");
    const other = ctxFor("t_2");
    await file(c, "f_old", ANCIENT, "policy:pol_1");
    await file(c, "f_young", RECENT, "policy:pol_1");
    await file(c, "f_subject", ANCIENT, "policy:pol_held");
    await file(c, "f_self", ANCIENT);
    await file(other, "f_other", ANCIENT);
    await hold(c, "policy:pol_held");
    await hold(c, "file:f_self");
    // A released hold holds nothing.
    await hold(c, "policy:pol_1", ANCIENT + 1);
    const r2 = bucket();
    for (const id of ["f_old", "f_young", "f_subject", "f_self"]) r2.objects.set(`files/t_1/${id}`, id);
    r2.objects.set("files/t_2/f_other", "f_other");

    const out = await runRetention(c, "files", { dryRun: false, files: r2.binding });
    expect(out.tableName).toBe("core_files");
    expect(out.rowsAffected).toBe(1);
    expect(out.rowsHeld).toBe(2);
    expect((await liveFiles()).sort()).toEqual(["f_other", "f_self", "f_subject", "f_young"]);
    // A tombstone, not a hole: whatever points at the file still resolves a row.
    const [tomb] = await drizzle(client).select().from(schema.files).where(eq(schema.files.id, "f_old"));
    expect(tomb?.deletedAt).toBe(NOW);
    expect(r2.objects.has("files/t_1/f_old")).toBe(false);
    expect([...r2.objects.keys()].sort()).toEqual(["files/t_1/f_self", "files/t_1/f_subject", "files/t_1/f_young", "files/t_2/f_other"]);

    // Already tombstoned is already gone: a second run finds nothing.
    const again = await runRetention(c, "files", { dryRun: false, files: r2.binding });
    expect(again.rowsAffected).toBe(0);
  });

  it("refuses to tombstone a file whose object it cannot delete", async () => {
    const c = ctxFor("t_1");
    await file(c, "f_old", ANCIENT);
    await expect(runRetention(c, "files", { dryRun: false })).rejects.toThrow(/object store/);
    expect(await liveFiles()).toEqual(["f_old"]);
    // A plan touches nothing, so it needs no bucket.
    expect((await runRetention(c, "files", { dryRun: true })).rowsAffected).toBe(1);
  });
});

describe("ai_audit", () => {
  it("purges AI audit rows past their floor, keeps held, young and foreign ones", async () => {
    const c = ctxFor("t_1");
    const other = ctxFor("t_2");
    await conversation(c, "cv_cust", "cu_held");
    await aiCall(c, "ai_old", ANCIENT, "quote:q_1");
    await aiCall(c, "ai_bare", ANCIENT);
    await aiCall(c, "ai_floor", NOW - 5 * YEAR); // past 24m, inside the 7y floor
    await aiCall(c, "ai_held", ANCIENT, "claim:cl_1");
    await aiCall(c, "ai_cust", ANCIENT, "conversation:cv_cust");
    await aiCall(other, "ai_other", ANCIENT);
    await hold(c, "claim:cl_1");
    await hold(c, "customer:cu_held");

    const out = await runRetention(c, "ai_audit", { dryRun: false });
    expect(out.tableName).toBe("ai_audit_log");
    expect(out.rowsAffected).toBe(2);
    expect(out.rowsHeld).toBe(2);
    expect((await ids(schema.aiAuditLog)).sort()).toEqual(["ai_cust", "ai_floor", "ai_held", "ai_other"]);
  });
});

describe("a run", () => {
  it("writes a run row and an audit entry, and a plan writes neither run nor delete", async () => {
    const c = ctxFor("t_1");
    await aiCall(c, "ai_old", ANCIENT);
    const plan = await runRetention(c, "ai_audit", { dryRun: true });
    expect(plan.run).toBeUndefined();
    expect(await runs("t_1")).toEqual([]);
    expect(await ids(schema.aiAuditLog)).toEqual(["ai_old"]);
    expect((await audits("compliance.retention.plan")).length).toBe(1);

    const done = await runRetention(c, "ai_audit", { dryRun: false });
    expect(done.run?.state).toBe("done");
    const [row] = await runs("t_1");
    expect(row).toMatchObject({ policyKey: "ai_audit", tableName: "ai_audit_log", rowsAffected: 1, rowsHeld: 0 });
    const [entry] = await audits("compliance.retention.run");
    expect(entry).toMatchObject({ subjectRef: "retention:ai_audit", actorRef: "system:scheduler" });
  });
});

describe("retentionDue", () => {
  const DAY = 86_400_000;
  it("is never due without a configured cadence", () => {
    expect(retentionDue("never", undefined, NOW)).toBe(false);
  });
  it("is due on first run, and again once the cadence has passed", () => {
    for (const [cadence, days] of [["daily", 1], ["weekly", 7], ["monthly", 30]] as const) {
      expect(retentionDue(cadence, undefined, NOW)).toBe(true);
      expect(retentionDue(cadence, NOW - days * DAY + 2 * 3_600_000, NOW), cadence).toBe(false);
      // A tick a few minutes earlier than yesterday's still counts as a night later.
      expect(retentionDue(cadence, NOW - days * DAY + 10 * 60_000, NOW), cadence).toBe(true);
    }
  });
});

describe("sweepRetention", () => {
  it("does nothing for a tenant that never configured a cadence", async () => {
    const c = ctxFor("t_1");
    await aiCall(c, "ai_old", ANCIENT);
    expect(await sweepRetention(c, bucket().binding)).toEqual([]);
    expect(await runs("t_1")).toEqual([]);
    expect(await ids(schema.aiAuditLog)).toEqual(["ai_old"]);
  });

  it("runs every class once per cadence, respecting holds, and records each run", async () => {
    const c = ctxFor("t_1", { retention: { schedule: "weekly" } });
    await conversation(c, "cv_held");
    await message(c, "m_held", "cv_held", ANCIENT);
    await hold(c, "conversation:cv_held");
    await aiCall(c, "ai_old", ANCIENT);
    await file(c, "f_old", ANCIENT);
    const r2 = bucket();
    r2.objects.set("files/t_1/f_old", "x");

    const done = await sweepRetention(c, r2.binding);
    expect(done.map((r) => r.policyKey).sort()).toEqual(["ai_audit", "files", "messages"]);
    expect(done.every((r) => r.state === "done")).toBe(true);
    expect(await ids(schema.orbitMessages)).toEqual(["m_held"]);
    expect(await ids(schema.aiAuditLog)).toEqual([]);
    expect(await liveFiles()).toEqual([]);
    expect((await runs("t_1")).length).toBe(3);

    // The next night is inside the week: nothing runs, nothing is written.
    expect(await sweepRetention(ctxFor("t_1", { retention: { schedule: "weekly" } }, NOW + 86_400_000), r2.binding)).toEqual([]);
    expect((await runs("t_1")).length).toBe(3);
  });

  it("records a failed run for a class it cannot complete and carries on", async () => {
    const c = ctxFor("t_1", { retention: { schedule: "daily" } });
    await file(c, "f_old", ANCIENT);
    await aiCall(c, "ai_old", ANCIENT);
    const done = await sweepRetention(c, undefined);
    const byKey = Object.fromEntries(done.map((r) => [r.policyKey, r]));
    expect(byKey.files?.state).toBe("failed");
    expect(byKey.files?.error).toMatch(/object store/);
    expect(byKey.ai_audit?.state).toBe("done");
    expect(await liveFiles()).toEqual(["f_old"]);
    expect((await audits("compliance.retention.failed")).length).toBe(1);
  });

  it("keeps going past one batch while a class has more to purge", async () => {
    const c = ctxFor("t_1", { retention: { schedule: "daily" } });
    await conversation(c, "cv_1");
    for (let i = 0; i < 3; i++) await message(c, `m_${i}`, "cv_1", ANCIENT);
    const done = await sweepRetention(c, bucket().binding, { batch: 2 });
    const messages = done.filter((r) => r.policyKey === "messages");
    expect(messages.map((r) => r.rowsAffected)).toEqual([2, 1]);
    expect(await ids(schema.orbitMessages)).toEqual([]);
  });
});

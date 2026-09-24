import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { emit, readNote, remember, saveNote, type Ctx } from "@lyra/core";
import { drainOutbox } from "../dispatch.js";

// docs/12 §3, docs/27 F34, ADR-0089. `forgetMemories` was the erasure link with
// no caller: a fulfilled erasure DSAR reached no memory and no note. This is
// the caller, driven the way production drives it — the generic update of a
// DSAR row emits `compliance.dsar-requests.updated`, the drain consumes it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

let ctx: Ctx;
const NOW = 1_700_000_000_000;
const resolve = (ref: string) => (ref.includes(":") ? ref : ref.startsWith("cu_") ? `customer:${ref}` : `policy:${ref}`);

async function dsar(id: string, type: string, state: string, customerId: string | null) {
  await ctx.db.insert(schema.dsarRequests).values({
    id,
    tenantId: "t_1",
    customerId,
    subjectIdentifier: "layla@example.com",
    type,
    channel: "portal",
    state,
    dueAt: NOW + 1,
    createdAt: NOW,
    updatedAt: NOW
  });
  await emit(ctx, { module: "compliance", type: "compliance.dsar-requests.updated", subject: id, data: { id } });
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await ctx.db.insert(schema.orbitConversations).values({
    id: "con_1",
    tenantId: "t_1",
    customerId: "cu_1",
    channel: "whatsapp",
    createdAt: NOW,
    updatedAt: NOW
  } as never);
  const mem = (subjectRef: string) =>
    remember(ctx, { subjectRef, kind: "fact", content: { x: 1 }, provenance: "test", purposes: ["p"] });
  await mem("customer:cu_1");
  await mem("cu_1");
  await mem("con_1");
  await mem("customer:cu_2");
  await saveNote(ctx, { subjectRef: "customer:cu_1", bodyMd: "about Layla [[pol_1]]", version: 0, resolve });
  await saveNote(ctx, { subjectRef: "policy:pol_1", bodyMd: "held by [[cu_1|Layla Haddad]]", version: 0, resolve });
});

describe("erasure DSAR fulfilled", () => {
  it("forgets the customer's memories and notes, redacts links, and logs each table", async () => {
    await dsar("dsr_1", "erasure", "fulfilled", "cu_1");
    await drainOutbox(ctx);

    const memories = await ctx.db.select().from(schema.memories);
    expect(memories.map((m) => m.subjectRef)).toEqual(["customer:cu_2"]);
    expect(await readNote(ctx, "customer:cu_1")).toBeNull();
    expect((await readNote(ctx, "policy:pol_1"))?.bodyMd).toBe("held by […]");
    expect(await ctx.db.select().from(schema.links)).toEqual([]);

    const log = await ctx.db.select().from(schema.erasureLog).where(eq(schema.erasureLog.dsarId, "dsr_1"));
    const byTable = Object.fromEntries(log.map((r) => [r.tableName, r]));
    expect(byTable.core_memories?.rowsErased).toBe(3);
    expect(byTable.core_notes?.rowsErased).toBe(1);
    expect(byTable.core_notes?.rowsTombstoned).toBe(1);
    expect(byTable.core_links?.rowsErased).toBe(2);
  });

  it("does nothing for a DSAR that is not a fulfilled erasure", async () => {
    await dsar("dsr_2", "erasure", "in_progress", "cu_1");
    await dsar("dsr_3", "access", "fulfilled", "cu_1");
    await drainOutbox(ctx);
    expect(await ctx.db.select().from(schema.memories)).toHaveLength(4);
    expect(await readNote(ctx, "customer:cu_1")).not.toBeNull();
    expect(await ctx.db.select().from(schema.erasureLog)).toEqual([]);
  });

  it("logs once however many times the fulfilled row is updated", async () => {
    await dsar("dsr_1", "erasure", "fulfilled", "cu_1");
    await drainOutbox(ctx);
    await emit(ctx, { module: "compliance", type: "compliance.dsar-requests.updated", subject: "dsr_1", data: { id: "dsr_1" } });
    await drainOutbox(ctx);
    const log = await ctx.db.select().from(schema.erasureLog);
    expect(log.filter((r) => r.tableName === "core_notes")).toHaveLength(1);
  });
});

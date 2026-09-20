import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { forgetMemories, recallMemories, remember } from "./memory.js";
import { permissionsForRole, type Actor } from "./rbac.js";
import type { Ctx } from "./context.js";

// docs/27 F34. The selection rule itself is scored by evals/memory-recall
// (`recallable`, pure). These cover what an eval cannot reach: that the rows
// are really written, really tenant- and subject-scoped, and really erasable.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

function actor(): Actor {
  return {
    kind: "user",
    id: "u_1",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

let client: Client;
const NOW = 1_700_000_000_000;

function makeCtx(tenantId = "t_1"): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId,
    actor: { ...actor(), tenantId },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
});

describe("remember", () => {
  it("writes a row the same purpose can read back", async () => {
    const ctx = makeCtx();
    await remember(ctx, {
      subjectRef: "con_1",
      kind: "preference",
      content: { channel: "whatsapp" },
      provenance: "ai_run:air_1",
      purposes: ["conversation.reply"]
    });
    const got = await recallMemories(ctx, "con_1", {
      purpose: "conversation.reply",
      now: NOW,
      maxSensitivity: "low"
    });
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!.contentJson)).toEqual({ channel: "whatsapp" });
    expect(got[0]!.provenance).toBe("ai_run:air_1");
  });

  // "Where did the model get that" is unanswerable if the writes are silent.
  it("audits the write without copying the claim into the audit log", async () => {
    const ctx = makeCtx();
    await remember(ctx, {
      subjectRef: "con_1",
      kind: "preference",
      content: { secret: "prefers 7am calls" },
      provenance: "ai_run:air_1",
      purposes: ["conversation.reply"]
    });
    const rows = await ctx.db.select().from(schema.auditLog);
    const entry = rows.find((r) => r.action === "core.memory.written");
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toContain("7am");
  });
});

describe("recallMemories", () => {
  it("never returns another subject's memories", async () => {
    const ctx = makeCtx();
    const write = (subjectRef: string) =>
      remember(ctx, {
        subjectRef,
        kind: "preference",
        content: { subjectRef },
        provenance: "test",
        purposes: ["conversation.reply"]
      });
    await write("con_1");
    await write("con_2");
    const got = await recallMemories(ctx, "con_1", {
      purpose: "conversation.reply",
      now: NOW,
      maxSensitivity: "low"
    });
    expect(got.map((m) => m.subjectRef)).toEqual(["con_1"]);
  });

  it("never returns another tenant's memories for the same subject ref", async () => {
    await remember(makeCtx("t_2"), {
      subjectRef: "con_1",
      kind: "preference",
      content: {},
      provenance: "test",
      purposes: ["conversation.reply"]
    });
    const got = await recallMemories(makeCtx("t_1"), "con_1", {
      purpose: "conversation.reply",
      now: NOW,
      maxSensitivity: "low"
    });
    expect(got).toEqual([]);
  });
});

describe("forgetMemories", () => {
  it("erases a subject's memories and reports the count an erasure-log row needs", async () => {
    const ctx = makeCtx();
    for (const kind of ["preference", "claim"])
      await remember(ctx, { subjectRef: "con_1", kind, content: {}, provenance: "test", purposes: ["conversation.reply"] });
    await remember(ctx, {
      subjectRef: "con_2",
      kind: "preference",
      content: {},
      provenance: "test",
      purposes: ["conversation.reply"]
    });

    expect(await forgetMemories(ctx, "con_1")).toBe(2);
    expect(
      await recallMemories(ctx, "con_1", { purpose: "conversation.reply", now: NOW, maxSensitivity: "low" })
    ).toEqual([]);
    // The other subject is untouched: erasure is per subject, not per tenant.
    expect(
      await recallMemories(ctx, "con_2", { purpose: "conversation.reply", now: NOW, maxSensitivity: "low" })
    ).toHaveLength(1);
  });

  it("reports zero and writes no audit row when there is nothing to erase", async () => {
    const ctx = makeCtx();
    expect(await forgetMemories(ctx, "con_nothing")).toBe(0);
    const rows = await ctx.db.select().from(schema.auditLog);
    expect(rows.some((r) => r.action === "core.memory.erased")).toBe(false);
  });
});

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { FnolBody } from "./axis-fnol.js";
import { ORBIT_TOOL_DEFS, runOrbitTool } from "./orbit-tools.js";

// docs/27 F31: docs/modules/orbit.md §2.1 names eight tools in the agent's
// registry — "fetch policy, start quote, endorsement request, document
// send/collect, renewal offer, FNOL guidance script (guide-only; never
// adjudicate), book callback, human handover" — and ORBIT_TOOL_DEFS shipped the
// first three. These are the tests for the other five.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;

function actorWithRole(roleKey: string): Actor {
  return { kind: "agent", id: "cx", tenantId: "t_1", grants: [{ roleKey, permissions: permissionsForRole(roleKey) }] };
}

function makeCtx(roleKey = "orbit.lead"): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actorWithRole(roleKey),
    requestId: "req_1",
    now: 1_770_000_000_000,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

async function seedConversation(id = "cnv_1"): Promise<void> {
  await ctx.db.insert(schema.orbitConversations).values({
    id,
    tenantId: ctx.tenantId,
    customerId: "cus_1",
    channel: "whatsapp",
    state: "bot",
    lang: "en",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

async function seedRenewal(id = "rnw_1", patch: { state?: string } = {}): Promise<void> {
  await ctx.db.insert(schema.orbitRenewals).values({
    id,
    tenantId: ctx.tenantId,
    policyRef: "pol_1",
    customerId: "cus_1",
    expiryAt: ctx.now + 30 * 86_400_000,
    strategy: "auto_requote",
    state: patch.state ?? "scheduled",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

/** The whole tenant auto-approves, so a consequential tool's gate resolves instead of parking. */
function automated(policyKey: string): Ctx {
  return { ...ctx, policy: PolicyJson.parse({ autoApprove: [policyKey] }) };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = makeCtx();
});

describe("the registry", () => {
  it("ships the eight tools docs/modules/orbit.md §2.1 promises", () => {
    expect(ORBIT_TOOL_DEFS.map((t) => t.name).sort()).toEqual(
      [
        "book_callback",
        "create_endorsement_request",
        "fetch_policy",
        "fnol_guidance",
        "human_handover",
        "make_renewal_offer",
        "send_document",
        "start_quote"
      ].sort()
    );
  });

  it("marks the two tools that reach a customer or a price as consequential, and no others", () => {
    const consequential = ORBIT_TOOL_DEFS.filter((t) => t.consequential).map((t) => t.name).sort();
    expect(consequential).toEqual(["create_endorsement_request", "make_renewal_offer", "send_document"].sort());
  });
});

describe("send_document", () => {
  it("writes the request into the transcript and leaves a chase task when collecting", async () => {
    await seedConversation();
    await ctx.db.insert(schema.axisCases).values({
      id: "cas_1",
      tenantId: ctx.tenantId,
      ref: "cas_1",
      kind: "quote",
      customerId: "cus_1",
      status: "intake",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });

    const result = (await runOrbitTool(automated("orbit.document_send"), "send_document", {
      conversationId: "cnv_1",
      mode: "collect",
      docType: "mulkiya",
      caseId: "cas_1"
    })) as { taskId: string | null };

    const messages = await ctx.db.select().from(schema.orbitMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("agent_ai");
    const [task] = await ctx.db.select().from(schema.axisTasks);
    expect(task!.type).toBe("document_collect");
    expect(task!.caseId).toBe("cas_1");
    expect(result.taskId).toBe(task!.id);
  });

  it("raises no chase task when it is sending rather than collecting", async () => {
    await seedConversation();
    await runOrbitTool(automated("orbit.document_send"), "send_document", {
      conversationId: "cnv_1",
      mode: "send",
      docType: "policy_schedule"
    });
    expect(await ctx.db.select().from(schema.axisTasks)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(1);
  });

  it("parks on an approval rather than sending when the tenant has not automated it", async () => {
    await seedConversation();
    await expect(
      runOrbitTool(ctx, "send_document", { conversationId: "cnv_1", mode: "send", docType: "policy_schedule" })
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });
});

describe("make_renewal_offer", () => {
  it("moves the renewal to offered and records the price it offered", async () => {
    await seedRenewal();
    const result = (await runOrbitTool(automated("orbit.renewal_offer"), "make_renewal_offer", {
      renewalId: "rnw_1",
      premiumMinor: 1_200_00,
      currency: "AED"
    })) as { state: string };
    expect(result.state).toBe("offered");

    const [row] = await ctx.db
      .select()
      .from(schema.orbitRenewals)
      .where(and(eq(schema.orbitRenewals.tenantId, ctx.tenantId), eq(schema.orbitRenewals.id, "rnw_1")));
    expect(row!.state).toBe("offered");
    expect(row!.offeredAt).toBe(ctx.now);
    expect(JSON.parse(row!.requotesJson!)).toMatchObject({ premiumMinor: 1_200_00, currency: "AED" });
  });

  it("refuses to re-offer a renewal the customer already decided", async () => {
    await seedRenewal("rnw_done", { state: "accepted" });
    await expect(
      runOrbitTool(automated("orbit.renewal_offer"), "make_renewal_offer", {
        renewalId: "rnw_done",
        premiumMinor: 1_200_00,
        currency: "AED"
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("gates on approval by default — an offer carries a price", async () => {
    await seedRenewal();
    await expect(
      runOrbitTool(ctx, "make_renewal_offer", { renewalId: "rnw_1", premiumMinor: 1_200_00, currency: "AED" })
    ).rejects.toMatchObject({ code: "approval_required" });
    const [row] = await ctx.db.select().from(schema.orbitRenewals);
    expect(row!.state).toBe("scheduled");
  });
});

describe("fnol_guidance", () => {
  it("scripts the intake contract itself, so the script cannot drift from what registerFnol accepts", async () => {
    const result = (await runOrbitTool(ctx, "fnol_guidance", { productLine: "motor" })) as {
      collect: { field: string; required: boolean }[];
      adjudicates: boolean;
    };
    expect(result.adjudicates).toBe(false);
    // Derived from FnolBody, not a hand-kept list: every key of the real intake
    // schema is in the script, and `policyId` is the one that is not optional.
    const fields = result.collect.map((c) => c.field);
    expect(fields).toEqual(Object.keys(FnolBody.shape));
    expect(result.collect.find((c) => c.field === "policyId")!.required).toBe(true);
    expect(result.collect.find((c) => c.field === "description")!.required).toBe(false);
  });

  it("writes nothing — it is a script, not a notification", async () => {
    await runOrbitTool(ctx, "fnol_guidance", { productLine: "motor" });
    expect(await ctx.db.select().from(schema.axisClaims)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.orbitConversations)).toHaveLength(0);
  });
});

describe("book_callback", () => {
  it("queues the callback through the router so it lands in a team's queue", async () => {
    await ctx.db.insert(schema.orbitTeams).values({
      id: "otm_1",
      tenantId: ctx.tenantId,
      key: "cx",
      nameJson: JSON.stringify({ en: "CX" }),
      isDefault: true,
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    const result = (await runOrbitTool(ctx, "book_callback", {
      customerId: "cus_1",
      requestedAt: ctx.now + 3_600_000,
      reason: "renewal questions"
    })) as { conversationId: string; teamId: string | null };

    const [conversation] = await ctx.db
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.id, result.conversationId));
    expect(conversation!.channel).toBe("voice");
    expect(conversation!.state).toBe("human");
    expect(conversation!.intent).toBe("callback");
    expect(result.teamId).toBe("otm_1");
  });
});

describe("human_handover", () => {
  it("moves the conversation to a human, leaves the note and routes it", async () => {
    await seedConversation();
    await ctx.db.insert(schema.orbitTeams).values({
      id: "otm_1",
      tenantId: ctx.tenantId,
      key: "cx",
      nameJson: JSON.stringify({ en: "CX" }),
      isDefault: true,
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });

    await runOrbitTool(ctx, "human_handover", {
      conversationId: "cnv_1",
      summary: "Customer wants to add a driver; needs a person.",
      factsJson: { policyNo: "POL-1" }
    });

    const [conversation] = await ctx.db.select().from(schema.orbitConversations);
    expect(conversation!.state).toBe("human");
    expect(conversation!.teamId).toBe("otm_1");
    const [note] = await ctx.db.select().from(schema.orbitHandoverNotes);
    expect(note!.conversationId).toBe("cnv_1");
    expect(note!.generatedBy).toBe("ai");
    expect(note!.summary).toContain("add a driver");
  });

  it("is idempotent on a conversation a human already holds", async () => {
    await seedConversation();
    await runOrbitTool(ctx, "human_handover", { conversationId: "cnv_1", summary: "first" });
    await runOrbitTool(ctx, "human_handover", { conversationId: "cnv_1", summary: "second" });
    const notes = await ctx.db.select().from(schema.orbitHandoverNotes);
    expect(notes).toHaveLength(2);
    const [conversation] = await ctx.db.select().from(schema.orbitConversations);
    expect(conversation!.state).toBe("human");
  });
});

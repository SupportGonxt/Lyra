import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelOptinsJson, EntitlementsJson, PolicyJson, PurposesJson, id as newId, schema } from "@lyra/db";
import { emit, sealFields, seed, type Ctx, type Envelope } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import type { Env } from "../env.js";
import { drainOutbox } from "../dispatch.js";
import { AUTO_REPLY_POLICY, REPLY_WINDOW_MS, onInboundMessage } from "./orbit-auto-reply.js";

// docs/30 ORBIT 3, ADR-0098. Every case here is the one question the feature
// answers: given an inbound customer message, is the AI reply *sent*, *drafted*
// for a person, or not written at all — and does a send leave its audit trail.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "auto-reply-field-key";
const NOW = Date.UTC(2026, 5, 1, 9, 0, 0);

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let base: Ctx;
let tenantId: string;
const env = { FIELD_KEY } as unknown as Env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "orbit-auto-reply-test-password-2026" });
  tenantId = r.tenantId;
  base = {
    db,
    tenantId,
    // The consumer runs as a system actor with no grants, as the drain does.
    actor: { kind: "system", id: "scheduler", tenantId, grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

beforeEach(async () => {
  await base.db.delete(schema.orbitMessages);
  await base.db.delete(schema.orbitConversations);
  await base.db.delete(schema.aiRuns);
  await base.db.delete(schema.approvals);
  await base.db.delete(schema.eventOutbox);
  await base.db.delete(schema.eventInbox);
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: `wamid.${newId("w", NOW)}` }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

/** The two switches ADR-0098 requires, each settable on its own. */
async function configure(opts: { autonomy: string; allowlisted: boolean }): Promise<Ctx> {
  await base.db
    .update(schema.aiAgents)
    .set({ autonomyLevel: opts.autonomy, status: "active" })
    .where(and(eq(schema.aiAgents.tenantId, tenantId), eq(schema.aiAgents.key, "service")));
  return { ...base, policy: PolicyJson.parse({ autoApprove: opts.allowlisted ? [AUTO_REPLY_POLICY] : [] }) };
}

function gatewayWith(reply: string): Gateway & { stubCalls: () => number } {
  const stub = makeStub({ replies: [reply] });
  const gw = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
  return Object.assign(gw, { stubCalls: () => stub.calls.length });
}

/** A bot-held WhatsApp conversation from a consented customer whose newest message is theirs. */
async function inbound(opts: { state?: string; optedIn?: boolean; ageMs?: number } = {}): Promise<Envelope> {
  const customerId = newId("cus", NOW);
  await base.db.insert(schema.customers).values({
    id: customerId,
    tenantId,
    type: "person",
    nameJson: JSON.stringify({ en: "Amina Haddad" }),
    createdAt: NOW,
    updatedAt: NOW
  } as never);
  await base.db.insert(schema.consents).values({
    id: newId("cns", NOW),
    tenantId,
    customerId,
    purposesJson: JSON.stringify(PurposesJson.parse({})),
    channelOptinsJson: JSON.stringify(ChannelOptinsJson.parse({ whatsapp: opts.optedIn ?? true })),
    source: "agent",
    evidenceRef: null,
    ts: NOW - 3_600_000,
    expiry: null,
    version: 1
  });

  const connectorId = newId("ccn", NOW);
  const sealed = await sealFields(FIELD_KEY, { accessToken: "token-123" }, ["accessToken"]);
  await base.db.insert(schema.orbitChannelConnectors).values({
    id: connectorId,
    tenantId,
    provider: "whatsapp-cloud-api",
    transport: "whatsapp",
    label: "Main",
    secretsJson: JSON.stringify(sealed),
    configJson: JSON.stringify({ phoneNumberId: "pn_1" }),
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });

  const ts = NOW - (opts.ageMs ?? 30_000);
  const conversationId = newId("cnv", NOW);
  await base.db.insert(schema.orbitConversations).values({
    id: conversationId,
    tenantId,
    customerId,
    channel: "whatsapp",
    externalRef: "971500000001",
    connectorId,
    state: opts.state ?? "bot",
    lang: "en",
    lastMessageAt: ts,
    createdAt: ts,
    updatedAt: ts
  } as never);
  const messageId = newId("msg", NOW);
  await base.db.insert(schema.orbitMessages).values({
    id: messageId,
    tenantId,
    conversationId,
    role: "customer",
    modality: "text",
    content: "Do I need to send anything else?",
    externalRef: `wamid.in.${messageId}`,
    ts
  } as never);

  return emit(base, {
    module: "orbit",
    type: "orbit.message.received",
    subject: messageId,
    data: { conversationId, customerId, messageId }
  });
}

async function agentTurns(conversationId: string) {
  return base.db
    .select()
    .from(schema.orbitMessages)
    .where(
      and(
        eq(schema.orbitMessages.tenantId, tenantId),
        eq(schema.orbitMessages.conversationId, conversationId),
        eq(schema.orbitMessages.role, "agent_ai")
      )
    )
    .orderBy(desc(schema.orbitMessages.ts));
}

const conversationOf = (e: Envelope) => (e.data as { conversationId: string }).conversationId;
const CLEAN = "Nothing further is needed from you right now. If the team needs a document, we will ask you here first.";

async function auditActions(): Promise<string[]> {
  const rows = await base.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, tenantId));
  return rows.map((r) => r.action);
}

describe("onInboundMessage — the two switches", () => {
  it("drafts, and sends nothing, while the agent only suggests", async () => {
    const ctx = await configure({ autonomy: "suggest", allowlisted: true });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("drafted");

    const [turn] = await agentTurns(conversationOf(event));
    expect(turn!.content).toBe(CLEAN);
    expect(turn!.deliveryStatus).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drafts while the agent acts only with approval", async () => {
    const ctx = await configure({ autonomy: "act_with_approval", allowlisted: true });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("drafted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drafts when the agent may act but the tenant has not allowlisted the reply", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: false });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("drafted");
    expect(fetchMock).not.toHaveBeenCalled();
    // Nothing to release: a pending approval here would be a row no decision could act on.
    expect(await base.db.select().from(schema.approvals)).toHaveLength(0);
  });

  it("sends through the channel when both switches are on, as an AI turn carrying its audit id", async () => {
    const ctx = await configure({ autonomy: "act_within_limits", allowlisted: true });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("sent");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const turns = await agentTurns(conversationOf(event));
    expect(turns).toHaveLength(1);
    expect(turns[0]!.content).toBe(CLEAN);
    expect(turns[0]!.deliveryStatus).toBe("sent");
    expect(turns[0]!.aiAuditId).toMatch(/^aia_/);

    // The model call, the auto-approval and the send each leave a record.
    const [call] = await base.db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.id, turns[0]!.aiAuditId!));
    expect(call!.purpose).toBe("orbit.conversation.auto_reply");
    const actions = await auditActions();
    expect(actions).toContain("core.approval.auto");
    expect(actions).toContain("orbit.ai_reply.sent");

    const [run] = await base.db.select().from(schema.aiRuns);
    expect(run!.state).toBe("succeeded");
    expect(run!.trigger).toBe("event");
    expect(JSON.parse(run!.evidenceJson!)).toMatchObject({ delivery: "sent", held: null });
  });
});

describe("onInboundMessage — what holds a reply back for a person", () => {
  it("drafts a reply that claims something was done, and says why on the run", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith("I have cancelled your policy as requested.") }, event)).toBe(
      "drafted"
    );
    expect(fetchMock).not.toHaveBeenCalled();
    const [run] = await base.db.select().from(schema.aiRuns);
    expect(JSON.parse(run!.evidenceJson!)).toMatchObject({ delivery: "drafted", held: "action_claim" });
  });

  it("writes nothing at all for a number the context never gave", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound();
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith("Your renewal is 2650 AED.") }, event)).toBe("refused");
    expect(await agentTurns(conversationOf(event))).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drafts instead of sending to a customer who withdrew the channel", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound({ optedIn: false });
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("drafted");
    expect(fetchMock).not.toHaveBeenCalled();
    const [turn] = await agentTurns(conversationOf(event));
    expect(turn!.deliveryStatus).toBeNull();
  });

  it("drafts a reply to a message older than the real-time window", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound({ ageMs: REPLY_WINDOW_MS + 60_000 });
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("drafted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("onInboundMessage — when it does not answer at all", () => {
  it("leaves a conversation a person holds alone, without calling the model", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound({ state: "human" });
    const gateway = gatewayWith(CLEAN);
    expect(await onInboundMessage(ctx, { env, gateway }, event)).toBe("skipped");
    expect(gateway.stubCalls()).toBe(0);
  });

  it("does not answer a message something else already answered", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound();
    await base.db.insert(schema.orbitMessages).values({
      id: newId("msg", NOW),
      tenantId,
      conversationId: conversationOf(event),
      role: "agent_ai",
      modality: "text",
      content: "A knowledge-base answer.",
      ts: NOW - 1_000
    } as never);
    expect(await onInboundMessage(ctx, { env, gateway: gatewayWith(CLEAN) }, event)).toBe("skipped");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers one message once, however many times the event is delivered", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound();
    const deps = { env, gateway: gatewayWith(CLEAN) };
    const [first, second] = await Promise.all([onInboundMessage(ctx, deps, event), onInboundMessage(ctx, deps, event)]);
    expect([first, second].sort()).toEqual(["claimed", "sent"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("drainOutbox wiring", () => {
  it("consumes orbit.message.received and sends the reply when handed a gateway", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const event = await inbound();
    await drainOutbox(ctx, undefined, 100, { env, gateway: gatewayWith(CLEAN) });
    const turns = await agentTurns(conversationOf(event));
    expect(turns.map((t) => t.deliveryStatus)).toEqual(["sent"]);
  });

  it("stands down for a tenant that switched ORBIT off", async () => {
    const ctx = await configure({ autonomy: "autonomous", allowlisted: true });
    const off: Ctx = {
      ...ctx,
      policy: PolicyJson.parse({ autoApprove: [AUTO_REPLY_POLICY], moduleConfig: { orbit: { enabled: false, settings: {} } } })
    };
    const event = await inbound();
    await drainOutbox(off, undefined, 100, { env, gateway: gatewayWith(CLEAN) });
    expect(await agentTurns(conversationOf(event))).toHaveLength(0);
  });
});

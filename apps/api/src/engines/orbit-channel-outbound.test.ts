import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, ChannelOptinsJson, PolicyJson, PurposesJson, EntitlementsJson } from "@lyra/db";
import { sealFields, type Ctx } from "@lyra/core";
import { dispatchOutbound } from "./orbit-channel-outbound.js";
import { processChannelEvents } from "./orbit-channel-inbound.js";
import { sweepRouting } from "./orbit-routing.js";
import type { Env } from "../env.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-key";
const tenantId = "t_1";
const now = 1_700_000_000_000;

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
let env: Env;
let conversation: typeof schema.orbitConversations.$inferSelect;
let connector: typeof schema.orbitChannelConnectors.$inferSelect;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  ctx = {
    db,
    tenantId,
    actor: { kind: "system", id: "test", tenantId, grants: [] },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  env = { FIELD_KEY } as unknown as Env;

  const sealed = await sealFields(FIELD_KEY, { accessToken: "token-123" }, ["accessToken"]);
  connector = {
    id: "ccn_1",
    tenantId,
    provider: "whatsapp-cloud-api",
    transport: "whatsapp",
    label: "Main",
    secretsJson: JSON.stringify(sealed),
    configJson: JSON.stringify({ phoneNumberId: "pn_1" }),
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  await db.insert(schema.orbitChannelConnectors).values(connector);

  // A real, consented customer — most tests here exercise the send path, not
  // the consent gate itself, so the base fixture must not trip it. The two
  // dedicated consent tests below override customerId with their own rows.
  await db.insert(schema.customers).values({
    id: "cus_base",
    tenantId,
    type: "person",
    nameJson: JSON.stringify({ en: "Base Customer" }),
    createdAt: now,
    updatedAt: now
  });
  await db.insert(schema.consents).values({
    id: "cns_base",
    tenantId,
    customerId: "cus_base",
    purposesJson: JSON.stringify(PurposesJson.parse({})),
    channelOptinsJson: JSON.stringify(ChannelOptinsJson.parse({ whatsapp: true })),
    source: "web",
    evidenceRef: null,
    ts: now,
    expiry: null,
    version: 1
  });

  conversation = {
    id: "cnv_1",
    tenantId,
    customerId: "cus_base",
    channel: "whatsapp",
    externalRef: "97150",
    connectorId: "ccn_1",
    doId: null,
    state: "human",
    assigneeRef: null,
    teamId: null,
    csat: null,
    summary: null,
    lang: "en",
    intent: null,
    sentiment: null,
    firstResponseMs: null,
    lastMessageAt: now,
    closedAt: null,
    priority: 2,
    slaPolicyKey: null,
    requireSkillsJson: null,
    queuedAt: null,
    assignedAt: null,
    firstResponseDueAt: null,
    resolutionDueAt: null,
    frtBreachedAt: null,
    resolutionBreachedAt: null,
    reopenCount: 0,
    createdAt: now,
    updatedAt: now
  };
  await db.insert(schema.orbitConversations).values(conversation);
});

afterEach(() => vi.unstubAllGlobals());

describe("dispatchOutbound", () => {
  it("sends through the resolved adapter and records a message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.out.1" }] }), { status: 200 }))
    );
    const result = await dispatchOutbound(ctx, env, conversation, connector, "On our way!");
    expect(result.externalRef).toBe("wamid.out.1");

    const [message] = await ctx.db
      .select()
      .from(schema.orbitMessages)
      .where(eq(schema.orbitMessages.id, result.messageId));
    expect(message!.content).toBe("On our way!");
    expect(message!.externalRef).toBe("wamid.out.1");
    expect(message!.deliveryStatus).toBe("sent");
    expect(message!.role).toBe("agent_human");
  });

  it("opens the sealed connector secret before calling the provider", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, _init?: { headers?: Record<string, string> }) =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.out.2" }] }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    await dispatchOutbound(ctx, env, conversation, connector, "hello");
    expect(fetchMock.mock.calls[0]![1]?.headers?.Authorization).toBe("Bearer token-123");
  });

  it("throws when the conversation has no external address", async () => {
    const bare = { ...conversation, externalRef: null };
    await expect(dispatchOutbound(ctx, env, bare, connector, "hi")).rejects.toThrow();
  });

  // docs/12 §2: every outbound send checks consent at runtime. The adapter's
  // `consentChannel` is the seam that says which opt-in binds (ADR-0038).
  it("refuses to send to a customer who revoked the channel", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.nope" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await ctx.db.insert(schema.customers).values({
      id: "cus_1",
      tenantId,
      type: "person",
      nameJson: JSON.stringify({ en: "Amina" }),
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert(schema.consents).values({
      id: "cns_1",
      tenantId,
      customerId: "cus_1",
      purposesJson: JSON.stringify(PurposesJson.parse({})),
      channelOptinsJson: JSON.stringify(ChannelOptinsJson.parse({ whatsapp: false })),
      source: "web",
      evidenceRef: null,
      ts: now,
      expiry: null,
      version: 1
    });

    const withCustomer = { ...conversation, customerId: "cus_1" };
    await expect(dispatchOutbound(ctx, env, withCustomer, connector, "hi")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });

  it("sends to a customer who opted the channel in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.ok" }] }), { status: 200 }))
    );
    await ctx.db.insert(schema.customers).values({
      id: "cus_2",
      tenantId,
      type: "person",
      nameJson: JSON.stringify({ en: "Yusuf" }),
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert(schema.consents).values({
      id: "cns_2",
      tenantId,
      customerId: "cus_2",
      purposesJson: JSON.stringify(PurposesJson.parse({})),
      channelOptinsJson: JSON.stringify(ChannelOptinsJson.parse({ whatsapp: true })),
      source: "web",
      evidenceRef: null,
      ts: now,
      expiry: null,
      version: 1
    });

    // `marketing: false` — a reply is a service message, so the channel opt-in
    // alone is enough and the marketing purpose stays off.
    const result = await dispatchOutbound(ctx, env, { ...conversation, customerId: "cus_2" }, connector, "hi");
    expect(result.externalRef).toBe("wamid.ok");
  });

  // The regression guard for the journey as a whole: a customer messages in,
  // the reply must go out. Inbound records the channel opt-in the outbound gate
  // then checks.
  it("replies to a conversation created by a first-time inbound message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.reply" }] }), { status: 200 }))
    );

    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.in", handle: "97159", displayName: "Amina", text: "Hello", modality: "text", sentAt: now } }
    ]);
    const [inbound] = await ctx.db
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.externalRef, "97159"));

    const result = await dispatchOutbound(ctx, env, inbound!, connector, "On our way!");
    expect(result.externalRef).toBe("wamid.reply");
  });

  // Regression test for C2: the first human reply must stop the FRT clock, or
  // sweepRouting keeps treating an already-answered conversation as breached.
  it("stamps firstResponseMs and clears firstResponseDueAt on the first human reply, so a later sweep does not flag an FRT breach", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.first-reply" }] }), { status: 200 }))
    );
    const queuedAt = now - 5_000;
    const queued = { ...conversation, queuedAt, firstResponseDueAt: now - 1_000 };
    await ctx.db.update(schema.orbitConversations).set({ queuedAt, firstResponseDueAt: now - 1_000 }).where(eq(schema.orbitConversations.id, "cnv_1"));

    await dispatchOutbound(ctx, env, queued, connector, "On our way!");

    const [row] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.id, "cnv_1"));
    expect(row!.firstResponseMs).toBe(now - queuedAt);
    expect(row!.firstResponseDueAt).toBeNull();

    const result = await sweepRouting(ctx);
    expect(result.frtBreaches).toBe(0);

    const [afterSweep] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.id, "cnv_1"));
    expect(afterSweep!.frtBreachedAt).toBeNull();
    expect(afterSweep!.priority).toBe(2);
  });

  // A second human reply must not overwrite the first response time.
  it("does not overwrite firstResponseMs on a second reply", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }))
    );
    const already = { ...conversation, firstResponseMs: 12_345, firstResponseDueAt: null };
    await ctx.db.update(schema.orbitConversations).set({ firstResponseMs: 12_345, firstResponseDueAt: null }).where(eq(schema.orbitConversations.id, "cnv_1"));

    await dispatchOutbound(ctx, env, already, connector, "Following up");

    const [row] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.id, "cnv_1"));
    expect(row!.firstResponseMs).toBe(12_345);
  });

  // ADR-0098: an auto-reply goes out through this same path, and the transcript
  // must not later read as though a person wrote it.
  it("records an AI-authored send as agent_ai with its audit id, and leaves the first-response clock to a human", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.ai" }] }), { status: 200 }))
    );
    const result = await dispatchOutbound(ctx, env, conversation, connector, "A colleague will confirm.", {
      role: "agent_ai",
      aiAuditId: "aia_1"
    });
    const [message] = await ctx.db.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.id, result.messageId));
    expect(message!.role).toBe("agent_ai");
    expect(message!.aiAuditId).toBe("aia_1");
    expect(message!.deliveryStatus).toBe("sent");
    const [row] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.id, "cnv_1"));
    expect(row!.firstResponseMs).toBeNull();
  });

  it("records no message when the provider send fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    await expect(dispatchOutbound(ctx, env, conversation, connector, "hi")).rejects.toThrow();
    const rows = await ctx.db.select().from(schema.orbitMessages);
    expect(rows).toHaveLength(0);
  });

  // A client can create a conversation row directly with an arbitrary
  // externalRef and no customerId (e.g. via the generic conversations CRUD
  // resource) — that must not be a way to skip the consent gate.
  it("refuses to send when the conversation has no customerId and no matching channel identity", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.nope" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const noCustomer = { ...conversation, customerId: null, externalRef: "unlinked-number" };
    await expect(dispatchOutbound(ctx, env, noCustomer, connector, "hi")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves the customer via channel identity when the conversation has no customerId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.identity" }] }), { status: 200 }))
    );
    await ctx.db.insert(schema.customers).values({
      id: "cus_3",
      tenantId,
      type: "person",
      nameJson: JSON.stringify({ en: "Identity Customer" }),
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert(schema.consents).values({
      id: "cns_3",
      tenantId,
      customerId: "cus_3",
      purposesJson: JSON.stringify(PurposesJson.parse({})),
      channelOptinsJson: JSON.stringify(ChannelOptinsJson.parse({ whatsapp: true })),
      source: "web",
      evidenceRef: null,
      ts: now,
      expiry: null,
      version: 1
    });
    await ctx.db.insert(schema.orbitChannelIdentities).values({
      id: "cid_3",
      tenantId,
      connectorId: "ccn_1",
      handle: "97150",
      customerId: "cus_3",
      createdAt: now
    });

    const noCustomer = { ...conversation, customerId: null };
    const result = await dispatchOutbound(ctx, env, noCustomer, connector, "hi");
    expect(result.externalRef).toBe("wamid.identity");
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { schema, PolicyJson, EntitlementsJson } from "@lyra/db";
import { currentConsent, recordConsent, type Ctx } from "@lyra/core";
import { processChannelEvents, type ChannelConnectorRow } from "./orbit-channel-inbound.js";

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
const tenantId = "t_1";
const now = 1_700_000_000_000;

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
});

const connector: ChannelConnectorRow = {
  id: "ccn_1",
  tenantId,
  provider: "whatsapp-cloud-api",
  transport: "whatsapp",
  label: "Main WhatsApp",
  secretsJson: "{}",
  configJson: "{}",
  status: "active",
  createdAt: now,
  updatedAt: now
};

describe("processChannelEvents", () => {
  it("creates a customer, a conversation and a message for a first-time handle", async () => {
    const result = await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", displayName: "Amina", text: "Hello", modality: "text", sentAt: now } }
    ]);
    expect(result).toEqual({ processed: 1, skipped: 0 });

    const [identity] = await ctx.db
      .select()
      .from(schema.orbitChannelIdentities)
      .where(eq(schema.orbitChannelIdentities.handle, "97150"));
    expect(identity).toBeDefined();

    const [customer] = await ctx.db.select().from(schema.customers).where(eq(schema.customers.id, identity!.customerId));
    expect(JSON.parse(customer!.nameJson).en).toBe("Amina");

    const [conversation] = await ctx.db
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.customerId, identity!.customerId));
    expect(conversation!.connectorId).toBe("ccn_1");
    expect(conversation!.externalRef).toBe("97150");

    const [message] = await ctx.db.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.externalRef, "wamid.1"));
    expect(message!.content).toBe("Hello");
    expect(message!.conversationId).toBe(conversation!.id);
  });

  it("reuses the existing conversation for a returning handle", async () => {
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hi", modality: "text", sentAt: now } }
    ]);
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.2", handle: "97150", text: "Again", modality: "text", sentAt: now + 1000 } }
    ]);

    const conversations = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.tenantId, tenantId));
    expect(conversations).toHaveLength(1);

    const messages = await ctx.db.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.conversationId, conversations[0]!.id));
    expect(messages).toHaveLength(2);
  });

  it("de-dupes a redelivered webhook by externalRef", async () => {
    const event = {
      kind: "message" as const,
      message: { externalRef: "wamid.1", handle: "97150", text: "Hi", modality: "text" as const, sentAt: now }
    };
    const first = await processChannelEvents(ctx, connector, [event]);
    const second = await processChannelEvents(ctx, connector, [event]);
    expect(first).toEqual({ processed: 1, skipped: 0 });
    expect(second).toEqual({ processed: 0, skipped: 1 });
  });

  it("skips an ignored event without touching the database", async () => {
    const result = await processChannelEvents(ctx, connector, [{ kind: "ignored", why: "unsupported" }]);
    expect(result).toEqual({ processed: 0, skipped: 1 });
  });

  // A customer who opens the conversation has, by that act, opted in to being
  // replied to on that channel — otherwise the outbound consent gate 403s every
  // reply to a first-time inbound handle.
  it("grants the transport's channel opt-in for a first-time handle, and nothing else", async () => {
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hello", modality: "text", sentAt: now } }
    ]);

    const [identity] = await ctx.db
      .select()
      .from(schema.orbitChannelIdentities)
      .where(eq(schema.orbitChannelIdentities.handle, "97150"));

    const state = await currentConsent(ctx, identity!.customerId);
    expect(state?.channels.whatsapp).toBe(true);
    expect(state?.channels.email).toBe(false);
    expect(state?.purposes.marketing).toBe(false);
  });

  // Consent rows are immutable and the latest row wins, so re-granting on every
  // inbound message would silently resurrect a revoked opt-in.
  it("does not re-grant the channel for a handle whose customer revoked it", async () => {
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hi", modality: "text", sentAt: now } }
    ]);
    const [identity] = await ctx.db
      .select()
      .from(schema.orbitChannelIdentities)
      .where(eq(schema.orbitChannelIdentities.handle, "97150"));

    const revoking: Ctx = { ...ctx, now: now + 1000 };
    await recordConsent(revoking, { customerId: identity!.customerId, purposes: {}, channels: { whatsapp: false }, source: "portal" });

    const later: Ctx = { ...ctx, now: now + 2000 };
    await processChannelEvents(later, connector, [
      { kind: "message", message: { externalRef: "wamid.2", handle: "97150", text: "Again", modality: "text", sentAt: now + 2000 } }
    ]);

    const state = await currentConsent(later, identity!.customerId);
    expect(state?.channels.whatsapp).toBe(false);
  });

  it("updates a message's delivery status from a status receipt", async () => {
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hi", modality: "text", sentAt: now } }
    ]);
    await processChannelEvents(ctx, connector, [{ kind: "status", receipt: { externalRef: "wamid.1", status: "delivered", at: now + 500 } }]);

    const [message] = await ctx.db.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.externalRef, "wamid.1"));
    expect(message!.deliveryStatus).toBe("delivered");
  });
});

describe("processChannelEvents routing", () => {
  it("routes and assigns a new conversation when the tenant has a default team and an available agent", async () => {
    await ctx.db.insert(schema.orbitTeams).values({
      id: "otm_default",
      tenantId,
      key: "default",
      nameJson: "{}",
      isDefault: true,
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert(schema.orbitTeamMembers).values({ id: "tmm_1", tenantId, teamId: "otm_default", userId: "u_1", createdAt: now });
    await ctx.db.insert(schema.orbitAgentPresence).values({ id: "ap_1", tenantId, userId: "u_1", status: "available", activeCount: 0, updatedAt: now });

    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hello", modality: "text", sentAt: now } }
    ]);

    const [conversation] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.tenantId, tenantId));
    expect(conversation!.teamId).toBe("otm_default");
    expect(conversation!.assigneeRef).toBe("u_1");
  });

  // docs/27 F32: deflection is only deflection if something tries it on a real
  // inbound message. The hook is optional here for the same reason `signal` is
  // — the engine must stay callable with no AI wiring at all.
  it("offers each inbound customer message to the deflection hook, after the signal hook", async () => {
    const order: string[] = [];
    const deflected: { conversationId: string; text: string }[] = [];
    await processChannelEvents(
      ctx,
      connector,
      [{ kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "how do I renew?", modality: "text", sentAt: now } }],
      {
        signal: () => {
          order.push("signal");
          return Promise.resolve();
        },
        deflect: (conversationId, text) => {
          order.push("deflect");
          deflected.push({ conversationId, text });
          return Promise.resolve();
        }
      }
    );
    const [conversation] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.tenantId, tenantId));
    expect(deflected).toEqual([{ conversationId: conversation!.id, text: "how do I renew?" }]);
    // Language is what retrieval picks an article by, and `signal` is what sets
    // it — so deflection has to run second or it reads the previous language.
    expect(order).toEqual(["signal", "deflect"]);
  });

  it("does not offer a redelivered message to the deflection hook", async () => {
    const seen: string[] = [];
    const event = {
      kind: "message" as const,
      message: { externalRef: "wamid.1", handle: "97150", text: "hello", modality: "text" as const, sentAt: now }
    };
    const hook = { deflect: (_id: string, text: string) => { seen.push(text); return Promise.resolve(); } };
    await processChannelEvents(ctx, connector, [event], hook);
    await processChannelEvents(ctx, connector, [event], hook);
    expect(seen).toEqual(["hello"]);
  });

  it("leaves a conversation unrouted when the tenant has no team configured yet", async () => {
    await processChannelEvents(ctx, connector, [
      { kind: "message", message: { externalRef: "wamid.1", handle: "97150", text: "Hello", modality: "text", sentAt: now } }
    ]);
    const [conversation] = await ctx.db.select().from(schema.orbitConversations).where(eq(schema.orbitConversations.tenantId, tenantId));
    expect(conversation!.teamId).toBeNull();
    expect(conversation!.assigneeRef).toBeNull();
  });
});

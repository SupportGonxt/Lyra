import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@lyra/core";
import { schema, EntitlementsJson, PolicyJson, type Db } from "@lyra/db";
import { app } from "./index.js";
import { ctxFor } from "./auth.js";
import { dispatchOutbound } from "./engines/orbit-channel-outbound.js";
import type { Env } from "./env.js";

// docs/30 ORBIT 4, ADR-0099: the portal's web chat. A stranger with no session
// opens a conversation from the storefront, keeps it with a visitor token, and
// collects the replies staff send by polling. The tests that matter are what the
// token cannot do — read another tenant's thread, be recovered from the stored
// handle, post through the webhook door — and that the public door is throttled.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-key";
const exec = { waitUntil() {}, passThroughOnException() {} };
const now = 1_700_000_000_000;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let env: Env;
let database: Db;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  on: Env = env
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    on as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function tenant(id: string, slug: string, connector: "active" | "disabled" | null): Promise<void> {
  await database.insert(schema.tenants).values({
    id,
    slug,
    name: slug,
    status: "active",
    brandJson: JSON.stringify({ name: slug }),
    createdAt: now,
    updatedAt: now
  });
  if (!connector) return;
  await database.insert(schema.orbitChannelConnectors).values({
    id: `ccn_${slug}`,
    tenantId: id,
    provider: "lyra-webchat",
    transport: "web",
    label: "Web chat",
    secretsJson: "{}",
    configJson: "{}",
    status: connector,
    createdAt: now,
    updatedAt: now
  });
}

async function start(slug = "shop", text = "Is my car covered abroad?") {
  return call("POST", `/v1/portal/${slug}/chat/messages`, { name: "Amina", text });
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await tenant("t_shop", "shop", "active");
  await tenant("t_other", "other", "active");
  await tenant("t_quiet", "quiet", null);
  await tenant("t_off", "off", "disabled");
  env = { DB_CLIENT: database, FIELD_KEY, ENVIRONMENT: "development" } as unknown as Env;
}, 60_000);

describe("web chat availability", () => {
  it("is 404 for a tenant that has not set up web chat", async () => {
    expect((await call("GET", "/v1/portal/quiet/chat")).status).toBe(404);
    expect((await start("quiet")).status).toBe(404);
  });

  it("is 404 once an administrator disables the connector", async () => {
    expect((await call("GET", "/v1/portal/off/chat")).status).toBe(404);
    expect((await start("off")).status).toBe(404);
  });

  it("is an empty transcript for a visitor who has not written yet", async () => {
    const res = await call("GET", "/v1/portal/shop/chat");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [] });
  });

  it("the storefront says whether chat is open", async () => {
    expect((await call("GET", "/v1/portal/shop/site")).body.chat).toBe(true);
    expect((await call("GET", "/v1/portal/quiet/site")).body.chat).toBe(false);
    expect((await call("GET", "/v1/portal/off/site")).body.chat).toBe(false);
  });
});

describe("POST /v1/portal/:tenantSlug/chat/messages", () => {
  it("needs a name to start a conversation", async () => {
    const res = await call("POST", "/v1/portal/shop/chat/messages", { text: "hello" });
    expect(res.status).toBe(400);
  });

  it("starts an ORBIT conversation on the web channel and hands back a visitor token", async () => {
    const res = await start();
    expect(res.status).toBe(201);
    expect(res.body.visitorToken).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(res.body.messages).toEqual([
      expect.objectContaining({ from: "visitor", text: "Is my car covered abroad?" })
    ]);

    const handle = await sha256Hex(res.body.visitorToken);
    const [identity] = await database
      .select()
      .from(schema.orbitChannelIdentities)
      .where(eq(schema.orbitChannelIdentities.handle, handle));
    expect(identity?.connectorId).toBe("ccn_shop");
    const [conversation] = await database
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.customerId, identity!.customerId));
    expect(conversation).toMatchObject({ tenantId: "t_shop", channel: "web", connectorId: "ccn_shop", externalRef: handle });
    const [customer] = await database.select().from(schema.customers).where(eq(schema.customers.id, identity!.customerId));
    expect(JSON.parse(customer!.nameJson).en).toBe("Amina");
  });

  it("stores only a hash of the token, so reading the inbox never yields a visitor's credential", async () => {
    const { body } = await start();
    const rows = await database.select().from(schema.orbitChannelIdentities).where(eq(schema.orbitChannelIdentities.tenantId, "t_shop"));
    expect(rows.some((r) => r.handle === body.visitorToken)).toBe(false);
  });

  it("continues the same conversation for a returning token", async () => {
    const first = await start();
    const token = first.body.visitorToken as string;
    const second = await call("POST", "/v1/portal/shop/chat/messages", { text: "And in Oman?" }, { "x-lyra-visitor": token });
    expect(second.status).toBe(201);
    expect(second.body.visitorToken).toBe(token);
    expect(second.body.messages.map((m: { text: string }) => m.text)).toEqual(["Is my car covered abroad?", "And in Oman?"]);

    const handle = await sha256Hex(token);
    const conversations = await database
      .select()
      .from(schema.orbitConversations)
      .where(and(eq(schema.orbitConversations.tenantId, "t_shop"), eq(schema.orbitConversations.externalRef, handle)));
    expect(conversations).toHaveLength(1);
  });

  it("treats an unknown token as a new visitor, who must then give a name", async () => {
    const headers = { "x-lyra-visitor": "x".repeat(43) };
    expect((await call("POST", "/v1/portal/shop/chat/messages", { text: "hi" }, headers)).status).toBe(400);
    const res = await call("POST", "/v1/portal/shop/chat/messages", { text: "hi", name: "Omar" }, headers);
    expect(res.status).toBe(201);
    expect(res.body.visitorToken).not.toBe("x".repeat(43));
  });

  it("a token minted on one tenant opens nothing on another", async () => {
    const { body } = await start();
    const res = await call("GET", "/v1/portal/other/chat", undefined, { "x-lyra-visitor": body.visitorToken });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});

describe("replies reach the widget", () => {
  async function staffCtx() {
    return ctxFor(
      env,
      {
        tenantId: "t_shop",
        locale: "en",
        actor: { kind: "user", id: "us_agent", tenantId: "t_shop", grants: [] },
        policy: PolicyJson.parse({}),
        entitlements: EntitlementsJson.parse({})
      },
      Date.now()
    );
  }

  it("a reply sent through the channel seam is on the visitor's next poll, and a pending draft is not", async () => {
    const { body } = await start();
    const token = body.visitorToken as string;
    const handle = await sha256Hex(token);
    const [conversation] = await database
      .select()
      .from(schema.orbitConversations)
      .where(eq(schema.orbitConversations.externalRef, handle));
    const [connector] = await database
      .select()
      .from(schema.orbitChannelConnectors)
      .where(eq(schema.orbitChannelConnectors.id, "ccn_shop"));

    const ctx = await staffCtx();
    await dispatchOutbound(ctx, env, conversation!, connector!, "Yes, across the GCC.");
    // An AI draft awaiting a person's approval: no deliveryStatus (orbit-draft.ts).
    await database.insert(schema.orbitMessages).values({
      id: "omg_draft",
      tenantId: "t_shop",
      conversationId: conversation!.id,
      role: "agent_ai",
      modality: "text",
      content: "UNAPPROVED DRAFT",
      ts: Date.now() + 1
    });

    const res = await call("GET", "/v1/portal/shop/chat", undefined, { "x-lyra-visitor": token });
    expect(res.status).toBe(200);
    expect(res.body.messages.map((m: { from: string; text: string }) => [m.from, m.text])).toEqual([
      ["visitor", "Is my car covered abroad?"],
      ["agent", "Yes, across the GCC."]
    ]);
  });
});

describe("the webhook door", () => {
  it("refuses a line posted to the web chat connector's public webhook", async () => {
    const res = await call("POST", "/v1/channels/ccn_shop/webhook", { ref: "wc_x", handle: "h", text: "spoof", sentAt: now });
    expect(res.status).toBe(401);
  });
});

describe("abuse guard", () => {
  function counting(): Env {
    const store = new Map<string, string>();
    const kv = {
      async get(k: string) {
        return store.get(k) ?? null;
      },
      async put(k: string, v: string) {
        store.set(k, v);
      }
    };
    return { ...env, CACHE: kv } as unknown as Env;
  }

  it("throttles conversation starts per connecting IP", async () => {
    const on = counting();
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await call("POST", "/v1/portal/shop/chat/messages", { name: "Bot", text: `hi ${i}` }, headers, on)).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("throttles messages per visitor", async () => {
    const on = counting();
    const first = await call("POST", "/v1/portal/shop/chat/messages", { name: "Amina", text: "0" }, {}, on);
    const headers = { "x-lyra-visitor": first.body.visitorToken as string };
    let last = 0;
    for (let i = 1; i <= 30; i++) last = (await call("POST", "/v1/portal/shop/chat/messages", { text: String(i) }, headers, on)).status;
    expect(last).toBe(429);
  });

  it("refuses a message longer than a chat line", async () => {
    const res = await call("POST", "/v1/portal/shop/chat/messages", { name: "A", text: "x".repeat(2001) });
    expect(res.status).toBe(400);
  });
});

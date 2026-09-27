import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { hmacHex, sealFields } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "../index.js";
import type { Env } from "../env.js";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-key";
const exec = { waitUntil() {}, passThroughOnException() {} };
const tenantId = "t_1";
const now = 1_700_000_000_000;
const APP_SECRET = "whatsapp-app-secret";

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

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;

  await database.insert(schema.tenants).values({
    id: tenantId,
    slug: "t1",
    name: "T1",
    status: "active",
    createdAt: now,
    updatedAt: now
  });

  const sealed = await sealFields(
    FIELD_KEY,
    { appSecret: APP_SECRET, verifyToken: "verify-me", accessToken: "token" },
    ["appSecret", "verifyToken", "accessToken"]
  );
  await database.insert(schema.orbitChannelConnectors).values({
    id: "ccn_1",
    tenantId,
    provider: "whatsapp-cloud-api",
    transport: "whatsapp",
    label: "Main WhatsApp",
    secretsJson: JSON.stringify(sealed),
    configJson: JSON.stringify({ phoneNumberId: "pn_1" }),
    status: "active",
    createdAt: now,
    updatedAt: now
  });

  env = { DB_CLIENT: database, FIELD_KEY, ENVIRONMENT: "development" } as unknown as Env;
}, 60_000);

describe("GET /v1/channels/:connectorId/webhook", () => {
  it("echoes the challenge when the verify token matches", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_1/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"),
      env as never,
      exec as never
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("42");
  });

  it("is 401 when the verify token is wrong", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_1/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42"),
      env as never,
      exec as never
    );
    expect(res.status).toBe(401);
    // The detail matters: an unauthenticated 401 (mw.ts's public-path bypass
    // removed) looks identical to a rejected challenge, so status alone would
    // keep this test green for the wrong reason.
    expect(((await res.json()) as { detail?: string }).detail).toBe("challenge verification failed");
  });
});

describe("POST /v1/channels/:connectorId/webhook", () => {
  it("accepts a signed WhatsApp delivery and creates a message", async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "97150", profile: { name: "Amina" } }],
                messages: [{ from: "97150", id: "wamid.route.1", timestamp: "1700000000", type: "text", text: { body: "Hello" } }]
              }
            }
          ]
        }
      ]
    });
    const signature = `sha256=${await hmacHex(APP_SECRET, body)}`;
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_1/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body
      }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(200);

    const rows = await database.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.externalRef, "wamid.route.1"));
    expect(rows[0]!.content).toBe("Hello");
  });

  // docs/30 ORBIT 3, ADR-0098: "real time" cannot wait for the next cron drain,
  // so the webhook hands each received message to the reply consumer after it
  // has answered the provider — through the same `consume` the drain uses, so
  // the drain later sees a duplicate rather than answering twice.
  it("hands each received message to the reply consumer once the provider has its answer", async () => {
    // The kick stands down for a tenant that did not buy ORBIT, as the drain does.
    await database
      .update(schema.tenants)
      .set({ entitlementsJson: JSON.stringify({ modules: ["orbit"] }) })
      .where(eq(schema.tenants.id, tenantId));
    const pending: Promise<unknown>[] = [];
    const collecting = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} };
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "97151", profile: { name: "Omar" } }],
                messages: [{ from: "97151", id: "wamid.kick.1", timestamp: "1700000000", type: "text", text: { body: "Hi" } }]
              }
            }
          ]
        }
      ]
    });
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_1/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${await hmacHex(APP_SECRET, body)}` },
        body
      }),
      env as never,
      collecting as never
    );
    expect(res.status).toBe(200);
    expect(pending).toHaveLength(1);
    await Promise.all(pending);

    const [message] = await database.select().from(schema.orbitMessages).where(eq(schema.orbitMessages.externalRef, "wamid.kick.1"));
    const [received] = (await database.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "orbit.message.received")))
      .map((row) => JSON.parse(row.envelopeJson) as { id: string; subject: string })
      .filter((e) => e.subject === message!.id);
    const inbox = await database.select().from(schema.eventInbox).where(eq(schema.eventInbox.id, received!.id));
    expect(inbox.map((r) => [r.consumer, r.status])).toEqual([["orbit.auto_reply", "done"]]);
  });

  it("is 401 for a bad signature", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_1/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" },
        body: JSON.stringify({ entry: [] })
      }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(401);
    // Same reasoning as the challenge case: only the adapter's HMAC check
    // produces this detail, so the assertion pins the rejection to the
    // signature rather than to a missing session.
    expect(((await res.json()) as { detail?: string }).detail).toBe("bad whatsapp signature");
  });

  it("is 404 for an unknown connector", async () => {
    const res = await app.fetch(
      new Request("http://api.test/v1/channels/ccn_missing/webhook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(404);
  });
});

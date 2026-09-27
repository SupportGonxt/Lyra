import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema, EntitlementsJson, PolicyJson } from "@lyra/db";
import { consume, moduleEnabled, notFound, openFields, unauthorized, type ConnectorSecrets, type Ctx, type Envelope } from "@lyra/core";
import { ctxFor, db as rawDb, scheduledConfig } from "../auth.js";
import { AUTO_REPLY_CONSUMER } from "../dispatch.js";
import { onInboundMessage } from "../engines/orbit-auto-reply.js";
import { fieldKey } from "../env.js";
import { adapterFor } from "../engines/orbit-channel-adapters.js";
import { processChannelEvents } from "../engines/orbit-channel-inbound.js";
import { recordSignal } from "../engines/orbit-signal.js";
import { deflect } from "../engines/orbit-kb.js";
import { gatewayFor } from "../mw.js";
import type { App, Env } from "../env.js";

// A provider's webhook call carries no session — same reasoning as
// routes/portal.ts. The connector id in the URL resolves the tenant (never the
// body), the adapter's own signature check is the authentication, and the route
// builds its own system Ctx. Listed public-by-shape in mw.ts.

export const channelsRoutes = new Hono<App>();

/**
 * Connector row + its adapter, or a 404 that says nothing about other tenants.
 * Secrets are left sealed: `open()` is a separate step so a request that is
 * going to be refused (unknown provider, a provider with no challenge) never
 * unseals a credential it will not use.
 */
async function connectorFor(env: Env, connectorId: string) {
  const [connector] = await rawDb(env)
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(eq(schema.orbitChannelConnectors.id, connectorId), eq(schema.orbitChannelConnectors.status, "active"))
    );
  if (!connector) throw notFound("connector");
  return {
    connector,
    adapter: adapterFor(connector.provider),
    open: () => openFields(fieldKey(env), JSON.parse(connector.secretsJson) as ConnectorSecrets)
  };
}

/**
 * What every inbound customer line is offered once it is durable, whichever
 * door it came through — a provider webhook here, the portal's web chat
 * (routes/portal.ts, ADR-0099) there. One definition, so the two cannot drift.
 */
export function inboundHooks(env: Env, ctx: Ctx) {
  return {
    // Language + sentiment per inbound message (orbit-signal.ts): feeds
    // routing's sentimentBelow and the churn model's lastSentiment.
    signal: (conversationId: string, customerId: string | null, text: string) =>
      recordSignal(ctx, gatewayFor(env), conversationId, customerId, text),
    // docs/27 F32: try the knowledge base before a person is needed. `deflect`
    // itself decides nothing here — it answers only a conversation still on
    // the bot and only above its score floor, and logs the miss either way so
    // containment stays a real ratio.
    deflect: (conversationId: string, text: string) =>
      deflect(ctx, gatewayFor(env), env.VEC_KB, { conversationId, question: text }).then(() => undefined)
  };
}

// Subscription handshake (WhatsApp hub.challenge). Providers that don't do one
// have no `challenge` and get the same 404 as an unknown connector.
channelsRoutes.get("/:connectorId/webhook", async (c) => {
  const { adapter, open } = await connectorFor(c.env, c.req.param("connectorId"));
  if (!adapter.challenge) throw notFound("challenge");
  const secrets = await open();
  const echo = adapter.challenge(
    { rawBody: "", headers: c.req.raw.headers, query: new URL(c.req.url).searchParams },
    secrets
  );
  if (echo === null) throw unauthorized("challenge verification failed");
  return c.text(echo);
});

channelsRoutes.post("/:connectorId/webhook", async (c) => {
  const { connector, adapter, open } = await connectorFor(c.env, c.req.param("connectorId"));

  // Signature is computed over the bytes as sent, so the raw text is what the
  // adapter must see. Form-encoded providers (Mailgun) parse to fields first.
  const rawBody = c.req.header("content-type")?.includes("application/json")
    ? await c.req.text()
    : JSON.stringify(await c.req.parseBody());
  const req = { rawBody, headers: c.req.raw.headers, query: new URL(c.req.url).searchParams };

  const now = Date.now();
  await adapter.verify(req, await open(), now);
  const events = adapter.parse(req);

  const ctx = await ctxFor(
    c.env,
    {
      tenantId: connector.tenantId,
      locale: "en",
      actor: { kind: "system", id: "channel-webhook", tenantId: connector.tenantId, grants: [] },
      policy: PolicyJson.parse({}),
      entitlements: EntitlementsJson.parse({})
    },
    now
  );

  const received: Envelope[] = [];
  const result = await processChannelEvents(ctx, connector, events, {
    ...inboundHooks(c.env, ctx),
    received: (event) => void received.push(event)
  });
  await kickAutoReply(c, connector.tenantId, received);
  return c.json(result);
});

/**
 * docs/30 ORBIT 3, ADR-0098. The reply is an event consumer (rule 6), and the
 * drain would reach it on the next cron tick — minutes, which is not "real
 * time". So the consumer is run now, after the caller has its answer, through
 * the same `consume` and consumer name the drain uses: whichever runs second
 * sees a duplicate. Every inbound door calls this (provider webhooks and the
 * portal web chat, ADR-0099).
 */
export function kickAutoReply(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  tenantId: string,
  received: Envelope[]
): Promise<void> | undefined {
  if (!received.length) return undefined;
  const kick = replyNow(c.env, tenantId, received);
  let exec: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    exec = c.executionCtx;
  } catch {
    // No execution context (a direct call with no runtime): answer inline.
  }
  if (exec) {
    exec.waitUntil(kick);
    return undefined;
  }
  return kick;
}

async function replyNow(env: Env, tenantId: string, events: Envelope[]): Promise<void> {
  const now = Date.now();
  const ctx = await ctxFor(
    env,
    {
      tenantId,
      locale: "en",
      actor: { kind: "system", id: "orbit-auto-reply", tenantId, grants: [] },
      ...(await scheduledConfig(env, tenantId))
    },
    now
  );
  if (!moduleEnabled(ctx.policy, "orbit")) return;
  const deps = { env, gateway: gatewayFor(env) };
  for (const event of events) {
    // `consume` records a failure for the drain to retry; nothing here may
    // throw into a response that has already been sent.
    await consume(ctx.db, event, AUTO_REPLY_CONSUMER, (e) => onInboundMessage(ctx, deps, e).then(() => undefined), now).catch(
      (err: unknown) => console.error("orbit auto-reply kick failed", { tenantId, eventId: event.id, err: String(err) })
    );
  }
}

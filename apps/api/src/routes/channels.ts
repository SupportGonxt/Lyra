import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { schema, EntitlementsJson, PolicyJson } from "@lyra/db";
import { notFound, openFields, unauthorized, type ConnectorSecrets } from "@lyra/core";
import { ctxFor, db as rawDb } from "../auth.js";
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

  return c.json(
    await processChannelEvents(ctx, connector, events, {
      // Language + sentiment per inbound message (orbit-signal.ts): feeds
      // routing's sentimentBelow and the churn model's lastSentiment.
      signal: (conversationId, customerId, text) => recordSignal(ctx, gatewayFor(c.env), conversationId, customerId, text),
      // docs/27 F32: try the knowledge base before a person is needed. `deflect`
      // itself decides nothing here — it answers only a conversation still on
      // the bot and only above its score floor, and logs the miss either way so
      // containment stays a real ratio.
      deflect: (conversationId, text) =>
        deflect(ctx, gatewayFor(c.env), c.env.VEC_KB, { conversationId, question: text }).then(() => undefined)
    })
  );
});

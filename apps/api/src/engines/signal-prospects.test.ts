import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx, type Envelope } from "@lyra/core";
import { CHURN_PROSPECT_FLOOR, onProspectSignal, prospectCounts } from "./signal-prospects.js";
import { onResponseSignal, responseRollup } from "./signal-responses.js";
import { Hono } from "hono";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// Marketing's three scales (ADR-0091). Prospects are people other modules told
// SIGNAL about; responses are what came back, each row carrying its campaign,
// audience and person so it rolls up broad, niche and individual at once.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");

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
let n = 0;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

function event(type: string, data: Record<string, unknown>): Envelope {
  return { id: `evt_${++n}`, ts: NOW, tenant_id: "t_1", module: type.split(".")[0]!, type, actor: "system:test", subject: `sub_${n}`, data, v: 1 } as Envelope;
}

const prospects = () => ctx.db.select().from(schema.signalProspects);

describe("onProspectSignal", () => {
  it("records a customer whose quote expired, with the quote's facts as evidence", async () => {
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: "cus_1", productId: "prd_motor" }));
    const [p] = await prospects();
    expect(p).toMatchObject({ customerId: "cus_1", reason: "quote_expired", state: "open", sourceRef: "qr_1" });
    expect(JSON.parse(p!.evidenceJson)).toMatchObject({ productId: "prd_motor" });
  });

  it("skips an anonymous quote: there is nobody identified to talk to", async () => {
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: null, productId: "p" }));
    expect(await prospects()).toEqual([]);
  });

  it("records churn risk only at or above the floor", async () => {
    await onProspectSignal(ctx, event("orbit.renewal.due", { customerId: "cus_low", policyRef: "pol_1", churnScore: CHURN_PROSPECT_FLOOR - 1 }));
    await onProspectSignal(ctx, event("orbit.renewal.due", { customerId: "cus_high", policyRef: "pol_2", churnScore: 82 }));
    expect((await prospects()).map((p) => [p.customerId, p.reason, p.score])).toEqual([["cus_high", "churn_risk", 82]]);
  });

  it("reads the floor from tenant policy when the tenant set one", async () => {
    ctx = { ...ctx, policy: PolicyJson.parse({ signalChurnProspectFloor: 90 }) };
    await onProspectSignal(ctx, event("orbit.renewal.due", { customerId: "cus_high", policyRef: "pol_2", churnScore: 82 }));
    await onProspectSignal(ctx, event("orbit.renewal.due", { customerId: "cus_top", policyRef: "pol_3", churnScore: 95 }));
    expect((await prospects()).map((p) => p.customerId)).toEqual(["cus_top"]);
  });

  it("records a new customer as holding no policy, and converts every reason once one issues", async () => {
    await onProspectSignal(ctx, event("core.customers.created", { id: "cus_1" }));
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: "cus_1", productId: "p" }));
    await onProspectSignal(ctx, event("axis.policy.issued", { customerId: "cus_1", policyId: "pol_9" }));
    expect((await prospects()).map((p) => p.state)).toEqual(["converted", "converted"]);
  });

  it("is idempotent on (customer, reason): a second expiry refreshes, never duplicates, and reopens", async () => {
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: "cus_1", productId: "p" }));
    await onProspectSignal(ctx, event("axis.policy.issued", { customerId: "cus_1", policyId: "pol_1" }));
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_2", customerId: "cus_1", productId: "p" }));
    const rows = await prospects();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceRef: "qr_2", state: "open" });
  });

  it("suppresses on withdrawn marketing consent, and a later signal does not reopen it", async () => {
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: "cus_1", productId: "p" }));
    await onProspectSignal(ctx, event("core.consent.updated", { customerId: "cus_1", purposes: { marketing: false } }));
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_2", customerId: "cus_1", productId: "p" }));
    expect((await prospects()).map((p) => p.state)).toEqual(["suppressed"]);
  });

  it("counts open prospects per reason for the broad brief — aggregate only", async () => {
    for (const c of ["a", "b", "c"]) await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: `q${c}`, customerId: c, productId: "p" }));
    await onProspectSignal(ctx, event("core.customers.created", { id: "d" }));
    expect(await prospectCounts(ctx)).toEqual({ quote_expired: 3, no_policy: 1 });
  });
});

async function sent(id: string, opts: { campaignId?: string; customerId?: string; conversationId?: string; ts?: number } = {}) {
  await ctx.db.insert(schema.signalOutreach).values({
    id,
    tenantId: "t_1",
    campaignId: opts.campaignId ?? "cmp_1",
    customerId: opts.customerId ?? "cus_1",
    channel: "whatsapp",
    text: "hi",
    state: "sent",
    approvedBy: "auto",
    externalRef: `wamid_${id}`,
    conversationId: opts.conversationId ?? `cnv_${id}`,
    ts: opts.ts ?? NOW - 3600_000
  });
}

describe("onResponseSignal", () => {
  beforeEach(async () => {
    await ctx.db.insert(schema.signalCampaigns).values({
      id: "cmp_1",
      tenantId: "t_1",
      name: "Expired quotes",
      objective: "acq",
      audienceId: "aud_1",
      channelsJson: "[]",
      budgetJson: "{}",
      state: "live",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
  });

  it("a delivery receipt on the send's message id is a delivered response — once", async () => {
    await sent("otr_1");
    for (let i = 0; i < 2; i++) await onResponseSignal(ctx, event("orbit.message.status", { externalRef: "wamid_otr_1", status: "delivered" }));
    await onResponseSignal(ctx, event("orbit.message.status", { externalRef: "wamid_otr_1", status: "failed" }));
    const rows = await ctx.db.select().from(schema.signalResponses);
    expect(rows.map((r) => [r.kind, r.campaignId, r.audienceId, r.customerId])).toEqual([["delivered", "cmp_1", "aud_1", "cus_1"]]);
  });

  it("a customer message in the send's conversation is a reply, and the prospect has responded", async () => {
    await sent("otr_1");
    await onProspectSignal(ctx, event("dist.quote.expired", { quoteRequestId: "qr_1", customerId: "cus_1", productId: "p" }));
    await onResponseSignal(ctx, event("orbit.message.received", { conversationId: "cnv_otr_1", customerId: "cus_1" }));
    expect((await ctx.db.select().from(schema.signalResponses)).map((r) => r.kind)).toEqual(["replied"]);
    expect((await prospects())[0]!.state).toBe("responded");
  });

  it("a reply weeks after the send is not credited to it", async () => {
    await sent("otr_1", { ts: NOW - 30 * 86_400_000 });
    await onResponseSignal(ctx, event("orbit.message.received", { conversationId: "cnv_otr_1", customerId: "cus_1" }));
    expect(await ctx.db.select().from(schema.signalResponses)).toEqual([]);
  });

  it("withdrawn consent after a send is an opt-out on that send", async () => {
    await sent("otr_1");
    await onResponseSignal(ctx, event("core.consent.updated", { customerId: "cus_1", purposes: { marketing: false } }));
    expect((await ctx.db.select().from(schema.signalResponses)).map((r) => r.kind)).toEqual(["opted_out"]);
  });

  it("rolls up the same rows by campaign, audience and person", async () => {
    await sent("otr_1", { customerId: "cus_1" });
    await sent("otr_2", { customerId: "cus_2" });
    for (const id of ["otr_1", "otr_2"]) {
      await onResponseSignal(ctx, event("orbit.message.status", { externalRef: `wamid_${id}`, status: "read" }));
    }
    await onResponseSignal(ctx, event("orbit.message.received", { conversationId: "cnv_otr_2", customerId: "cus_2" }));

    expect(await responseRollup(ctx, "campaign", 0)).toEqual([{ key: "cmp_1", counts: { read: 2, replied: 1 } }]);
    expect(await responseRollup(ctx, "audience", 0)).toEqual([{ key: "aud_1", counts: { read: 2, replied: 1 } }]);
    const people = await responseRollup(ctx, "customer", 0);
    expect(people).toEqual([
      { key: "cus_1", counts: { read: 1 } },
      { key: "cus_2", counts: { read: 1, replied: 1 } }
    ]);
    const [row] = await ctx.db.select().from(schema.signalResponses).where(eq(schema.signalResponses.kind, "replied"));
    expect(row!.outreachId).toBe("otr_2");
  });
});

describe("GET /responses/rollup", () => {
  const call = async (permissions: string[], query: string) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    const res = await a.fetch(new Request(`http://api.test/responses/rollup${query}`));
    return { status: res.status, body: (await res.json()) as { data?: unknown } };
  };

  it("answers each scale, and refuses a reader without campaign access or an unknown level", async () => {
    await ctx.db.insert(schema.signalResponses).values({ id: "rsp_1", tenantId: "t_1", campaignId: "cmp_1", audienceId: "aud_1", customerId: "cus_1", outreachId: "otr_1", kind: "lead", ts: NOW });
    expect((await call(["signal:campaigns:read"], "?level=audience")).body.data).toEqual([{ key: "aud_1", counts: { lead: 1 } }]);
    expect((await call(["signal:campaigns:read"], "?level=customer")).body.data).toEqual([{ key: "cus_1", counts: { lead: 1 } }]);
    expect((await call([], "?level=campaign")).status).toBe(403);
    expect((await call(["signal:campaigns:read"], "?level=planet")).status).toBe(400);
  });
});

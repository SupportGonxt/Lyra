import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { notFound, permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import { creativeContextFor, planAudience, storedPlan } from "./signal-campaign-plan.js";
import type { App } from "../env.js";

// The other half of docs/modules/signal.md §2.1. A promoted whitespace arrives
// planned (scout-promote.ts); a campaign somebody typed is planned here, and
// either way the copy is written against the plan rather than against the brief
// alone. So what is tested is the round trip: plan a campaign, read the plan and
// the pool back out of the columns, and see both reach the copy prompt.
//
// Against a real libSQL book, like signal-audience.test.ts and for the same
// reason — the counts the planner argues from are the ones the database holds:
//
//   30 × lsm:7 + region:gauteng
//   25 × lsm:8 + region:gauteng
//
// so region=gauteng is 55 and lsm=7 is 30, which is what the audience reply
// below is allowed to cite.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let ctx: Ctx;
let tenantId: string;

const NOW = Date.UTC(2026, 0, 6, 8, 0, 0);
const OTHER_TENANT = "tn_other_plan";

function customers(tenant: string, prefix: string, spec: { n: number; tags: string[] }[]) {
  let i = 0;
  return spec.flatMap(({ n, tags }) =>
    Array.from({ length: n }, () => ({
      id: `cu_${prefix}_${i++}`,
      tenantId: tenant,
      type: "person",
      nameJson: JSON.stringify({ en: `Customer ${prefix}-${i}` }),
      kycStatus: "none",
      tagsJson: JSON.stringify(tags),
      locale: "en",
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW
    }))
  );
}

beforeAll(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "signal-campaign-plan-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "user",
      id: "u_1",
      tenantId,
      grants: [{ roleKey: "signal.lead", permissions: permissionsForRole("signal.lead") }]
    },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };

  await ctx.db.insert(schema.customers).values([
    ...customers(tenantId, "a", [
      { n: 30, tags: ["lsm:7", "region:gauteng"] },
      { n: 25, tags: ["lsm:8", "region:gauteng"] }
    ]),
    ...customers(OTHER_TENANT, "b", [{ n: 40, tags: ["lsm:9", "region:kzn"] }])
  ] as never);
}, 120_000);

function gatewayWith(script: Parameters<typeof makeStub>[0]): {
  stub: ReturnType<typeof makeStub>;
  gw: Gateway;
} {
  const stub = makeStub(script);
  return {
    stub,
    gw: new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } })
  };
}

/** Cites only cells the audience prompt showed it — anything else is dropped. */
const AUDIENCE = JSON.stringify({
  name: "Gauteng upper-middle push",
  summary: "Upper-middle households in Gauteng who are already on the book.",
  selections: [
    { axis: "lsm", value: "7", reason: "30 customers sit in this band, the largest single LSM cell." },
    { axis: "region", value: "gauteng", reason: "55 customers are in this region." }
  ]
});

/** Three real alternatives at three different odds. No figure appears anywhere
 *  but the probabilities, which are the model's own judgement and exempt — so
 *  this reply stays grounded whatever the fixture book happens to total. */
const PLAN = JSON.stringify({
  notes:
    "Demand for this line is moving and the book carries almost none of it. The pool is narrow, " +
    "so the options below trade reach against precision.",
  options: [
    {
      name: "Direct to the pool",
      angle: "Speak only to the band that already carries the most customers.",
      offer: "A quote in under a minute, priced for that band.",
      channels: ["email", "meta"],
      probability: 62,
      why: ["The pool is the largest single band on the book."],
      risk: "A pool this narrow burns out fast."
    },
    {
      name: "Intent capture",
      angle: "Buy the searches people already make and let demand come to the offer.",
      offer: "A quote for anyone already looking.",
      channels: ["google_search"],
      probability: 41,
      why: ["The demand exists before the campaign does."],
      risk: "Search cost rises with competitive pressure."
    },
    {
      name: "Broad build",
      angle: "Introduce the line to the rest of the book.",
      offer: "An introduction for customers who hold none.",
      channels: ["display"],
      probability: 27,
      why: ["Nobody on this book carries the cover yet."],
      risk: null
    }
  ]
});

const userPrompt = (stub: ReturnType<typeof makeStub>, call: number): string =>
  stub.calls[call]!.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

const rowsFor = async (tenant: string) => ({
  campaigns: await ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.tenantId, tenant)),
  audiences: await ctx.db.select().from(schema.signalAudiences).where(eq(schema.signalAudiences.tenantId, tenant)),
  audits: await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.tenantId, tenant)),
  events: await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, tenant)),
  ai: await ctx.db.select().from(schema.aiAuditLog).where(eq(schema.aiAuditLog.tenantId, tenant))
});

const campaignRow = async (id: string) =>
  (await ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.id, id)))[0]!;

let n = 0;
async function campaign(over: { audienceId?: string | null; planJson?: string | null } = {}): Promise<string> {
  const id = `cmp_plan_${n++}`;
  await ctx.db.insert(schema.signalCampaigns).values({
    id,
    tenantId,
    name: `Campaign ${id}`,
    objective: "acq",
    audienceId: over.audienceId ?? null,
    channelsJson: JSON.stringify([]),
    budgetJson: JSON.stringify({}),
    state: "draft",
    planJson: over.planJson ?? null,
    autonomyLevel: "act_with_approval",
    ownerRef: "u_1",
    createdAt: NOW,
    updatedAt: NOW
  });
  return id;
}

const STORED = {
  notes: "Narrow pool, moving demand.",
  options: [
    {
      name: "Direct to the pool",
      angle: "Speak only to the band that already carries the most customers.",
      offer: "A quote in under a minute.",
      channels: ["email", "meta"],
      probability: 62,
      why: ["The pool is the largest single band on the book."],
      risk: "Burns out fast."
    },
    {
      name: "Broad build",
      angle: "Introduce the line to the rest of the book.",
      offer: "An introduction for customers who hold none.",
      channels: ["display"],
      probability: 27,
      why: [],
      risk: null
    }
  ],
  recommended: "Direct to the pool",
  confidence: 100
};

describe("storedPlan", () => {
  it("reads the plan back off the column, string or hydrated", () => {
    for (const raw of [JSON.stringify(STORED), STORED]) {
      const plan = storedPlan(raw);
      expect(plan?.recommended).toBe("Direct to the pool");
      expect(plan?.confidence).toBe(100);
      expect(plan?.options.map((o) => o.probability)).toEqual([62, 27]);
      expect(plan?.options[0]?.channels).toEqual(["email", "meta"]);
    }
  });

  it("has nothing to show for a campaign nobody planned", () => {
    expect(storedPlan(null)).toBeNull();
    expect(storedPlan(undefined)).toBeNull();
    expect(storedPlan("{not json")).toBeNull();
    expect(storedPlan(JSON.stringify([STORED]))).toBeNull();
    expect(storedPlan({ ...STORED, options: [] })).toBeNull();
  });

  it("drops an option nobody could run rather than the whole plan", () => {
    // No channel is no spend, and a channel outside the planner's vocabulary is
    // one nobody can buy — either way that option goes and its sibling stays.
    const plan = storedPlan({
      ...STORED,
      options: [{ ...STORED.options[0], channels: ["carrier_pigeon"] }, STORED.options[1], { name: "" }]
    });
    expect(plan?.options.map((o) => o.name)).toEqual(["Broad build"]);
  });

  it("recommends an option that survived, whatever the stored name says", () => {
    const plan = storedPlan({ ...STORED, options: [{ ...STORED.options[0], channels: [] }, STORED.options[1]] });
    expect(plan?.recommended).toBe("Broad build");
  });

  it("says a figure it was not given is no figure at all", () => {
    const plan = storedPlan({
      ...STORED,
      confidence: "high",
      options: [{ ...STORED.options[0], probability: null, why: "lots" }]
    });
    expect(plan?.confidence).toBe(0);
    expect(plan?.options[0]?.probability).toBe(0);
    expect(plan?.options[0]?.why).toEqual([]);
  });
});

describe("POST /campaigns/:id/plan", () => {
  const app = (actor: Ctx["actor"], gw: Gateway): Hono<App> => {
    const a = new Hono<App>();
    a.onError(onError);
    a.notFound((c) => onError(notFound(c.req.path), c));
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor });
      c.set("gateway", gw);
      await next();
    });
    a.route("/", signalRoutes);
    return a;
  };

  const actorWith = (id: string, permissions: string[]): Ctx["actor"] => ({
    kind: "user",
    id,
    tenantId,
    grants: [{ roleKey: "test", permissions: permissions as Ctx["actor"]["grants"][number]["permissions"] }]
  });

  const post = async (a: Hono<App>, path: string, payload: unknown) => {
    const res = await a.fetch(
      new Request(`http://api.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      })
    );
    return { status: res.status, body: (await res.json()) as Record<string, never> };
  };

  it("refuses an actor without signal:campaigns:update, and writes nothing", async () => {
    const id = await campaign();
    const { stub, gw } = gatewayWith({ replies: [AUDIENCE, PLAN] });
    const before = await rowsFor(tenantId);

    const res = await post(app(actorWith("u_reader", ["signal:campaigns:read"]), gw), `/campaigns/${id}/plan`, {
      subject: "forbidden subject"
    });
    expect(res.status).toBe(403);

    expect(stub.calls).toHaveLength(0);
    const after = await rowsFor(tenantId);
    expect(after.audiences).toHaveLength(before.audiences.length);
    expect(after.ai).toHaveLength(before.ai.length);
    expect(after.events).toHaveLength(before.events.length);
    expect((await campaignRow(id)).planJson).toBeNull();
  });

  it("plans a campaign somebody typed, and gives it the pool it never had", async () => {
    const id = await campaign();
    const { stub, gw } = gatewayWith({ replies: [AUDIENCE, PLAN] });

    const res = await post(app(actorWith("u_marketer", ["signal:campaigns:update"]), gw), `/campaigns/${id}/plan`, {
      subject: "marine cover"
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: "ai" });

    // The audience was suggested first, so the plan was argued at a real pool.
    expect(stub.calls).toHaveLength(2);
    expect(userPrompt(stub, 1)).toContain("Audience band lsm=7: 30 customers");
    expect(userPrompt(stub, 1)).toContain("Campaign subject: marine cover");
    // Nothing measured stands behind a scenario, so no momentum line is invented.
    expect(userPrompt(stub, 1)).not.toContain("Demand momentum");

    const row = await campaignRow(id);
    expect(row.audienceId).toBeTruthy();
    const plan = storedPlan(row.planJson);
    expect(plan?.recommended).toBe("Direct to the pool");
    expect(plan?.options.map((o) => o.probability)).toEqual([62, 41, 27]);

    const { audits, events } = await rowsFor(tenantId);
    expect(audits.some((a) => a.action === "signal.campaign.planned")).toBe(true);
    expect(events.some((e) => e.type === "signal.campaign.planned")).toBe(true);
  });

  // ADR-0091: the broad brief argues from the people other modules reported,
  // counted — never from a person.
  it("argues from the prospects SIGNAL holds, as counts", async () => {
    const id = await campaign();
    for (const [n, reason] of [[1, "quote_expired"], [2, "quote_expired"], [3, "no_policy"]] as const) {
      await ctx.db.insert(schema.signalProspects).values({
        id: `psp_plan_${n}`,
        tenantId,
        customerId: `cus_plan_${n}`,
        reason,
        createdAt: ctx.now,
        updatedAt: ctx.now
      });
    }
    const { stub, gw } = gatewayWith({ replies: [AUDIENCE, PLAN] });
    await post(app(actorWith("u_marketer", ["signal:campaigns:update"]), gw), `/campaigns/${id}/plan`, { subject: "marine cover" });
    expect(userPrompt(stub, 1)).toContain("Identified people whose quote expired without being taken up: 2");
    expect(userPrompt(stub, 1)).toMatch(/Identified people known to us who hold no .+ yet: 1/);
    expect(userPrompt(stub, 1)).not.toContain("cus_plan_");
  });

  it("keeps a pool the campaign already has instead of proposing another", async () => {
    const first = await campaign();
    const seedCall = gatewayWith({ replies: [AUDIENCE, PLAN] });
    await post(app(actorWith("u_marketer", ["signal:campaigns:update"]), seedCall.gw), `/campaigns/${first}/plan`, {
      subject: "marine cover"
    });
    const audienceId = (await campaignRow(first)).audienceId!;

    const id = await campaign({ audienceId });
    const { stub, gw } = gatewayWith({ replies: [PLAN] });
    const res = await post(app(actorWith("u_marketer", ["signal:campaigns:update"]), gw), `/campaigns/${id}/plan`, {
      subject: "marine cover again"
    });

    expect(res.status).toBe(201);
    // One call, not two: the pool was not re-proposed.
    expect(stub.calls).toHaveLength(1);
    expect((await campaignRow(id)).audienceId).toBe(audienceId);
  });

  it("still plans when the model does not answer, at confidence 0", async () => {
    const id = await campaign();
    const { gw } = gatewayWith({ fail: new Error("provider down") });

    const res = await post(app(actorWith("u_marketer", ["signal:campaigns:update"]), gw), `/campaigns/${id}/plan`, {
      subject: "marine cover"
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: "fallback" });

    const plan = storedPlan((await campaignRow(id)).planJson);
    expect(plan?.confidence).toBe(0);
    expect(plan?.options.length).toBeGreaterThan(1);
  });

  it("refuses to plan another tenant's campaign", async () => {
    const id = await campaign();
    const { gw } = gatewayWith({ replies: [AUDIENCE, PLAN] });
    const a = new Hono<App>();
    a.onError(onError);
    a.notFound((c) => onError(notFound(c.req.path), c));
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, tenantId: OTHER_TENANT, actor: { ...actorWith("u_x", ["signal:campaigns:update"]), tenantId: OTHER_TENANT } });
      c.set("gateway", gw);
      await next();
    });
    a.route("/", signalRoutes);

    const res = await post(a, `/campaigns/${id}/plan`, { subject: "marine cover" });
    expect(res.status).toBe(404);
  });
});

describe("creative context", () => {
  const app = (gw: Gateway): Hono<App> => {
    const a = new Hono<App>();
    a.onError(onError);
    a.notFound((c) => onError(notFound(c.req.path), c));
    a.use("*", async (c, next) => {
      c.set("ctx", ctx);
      c.set("gateway", gw);
      await next();
    });
    a.route("/", signalRoutes);
    return a;
  };

  /** A campaign planned through the route, so the columns hold what the server
   *  actually writes rather than what this test imagines it writes. */
  async function planned(): Promise<string> {
    const id = await campaign();
    const { gw } = gatewayWith({ replies: [AUDIENCE, PLAN] });
    const res = await app(gw).fetch(
      new Request(`http://api.test/campaigns/${id}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "marine cover" })
      })
    );
    expect(res.status).toBe(201);
    return id;
  }

  it("rebuilds the pool and its reasons off the audience row", async () => {
    const row = await campaignRow(await planned());
    const audience = await planAudience(ctx, row.audienceId);
    expect(audience?.lsm).toEqual([7]);
    expect(audience?.reasons.map((r) => r.axis)).toContain("region");
    expect(audience?.reasons.find((r) => r.value === "gauteng")?.count).toBe(55);

    expect(await planAudience(ctx, null)).toBeNull();
    expect(await planAudience(ctx, "aud_does_not_exist")).toBeNull();
    // Another tenant's audience is not this tenant's pool.
    expect(await planAudience({ ...ctx, tenantId: OTHER_TENANT }, row.audienceId)).toBeNull();
  });

  it("flattens the plan and the pool to the lines the copy is written against", async () => {
    const lines = await creativeContextFor(ctx, await campaignRow(await planned()));
    expect(lines).toContain("Campaign approach: Direct to the pool");
    expect(lines.some((l) => l.startsWith("Offer: A quote in under a minute"))).toBe(true);
    expect(lines).toContain("LSM bands: 7");
    expect(lines.some((l) => l.startsWith("Audience band region=gauteng:"))).toBe(true);
  });

  it("has no context for a campaign nobody planned", async () => {
    expect(await creativeContextFor(ctx, await campaignRow(await campaign()))).toEqual([]);
  });

  it("writes copy against the plan, not the brief alone", async () => {
    const id = await planned();
    const { stub, gw } = gatewayWith({ replies: ["Variant one\nVariant two"] });
    const res = await app(gw).fetch(
      new Request("http://api.test/creatives/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignId: id, kind: "ad", brief: "Sell marine cover", locales: ["en"], count: 2 })
      })
    );
    expect(res.status).toBe(201);

    const prompt = userPrompt(stub, 0);
    expect(prompt).toContain("Campaign approach: Direct to the pool");
    expect(prompt).toContain("Written for: Upper-middle households in Gauteng");
    expect(prompt).toContain("Brief: Sell marine cover");
  });

  it("writes copy from the brief alone when there is no plan", async () => {
    const id = await campaign();
    const { stub, gw } = gatewayWith({ replies: ["Variant one"] });
    const res = await app(gw).fetch(
      new Request("http://api.test/creatives/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaignId: id, kind: "ad", brief: "Sell marine cover", locales: ["en"], count: 1 })
      })
    );
    expect(res.status).toBe(201);
    expect(userPrompt(stub, 0)).toContain("Brief: Sell marine cover");
    expect(userPrompt(stub, 0)).not.toContain("Campaign approach:");
  });
});

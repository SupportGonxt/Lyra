import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, recordConsent, type Ctx, type Envelope } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { advanceJourneyRuns, onJourneyEvent, triggerJourney } from "./orbit-journeys.js";

// docs/30 ORBIT gap 1: both active seeded journeys halted with
// `unknown_node_type` — renewal v2 on `agent`, onboarding on `survey` — and the
// partner journey carries a `wait_for` nothing executed. These are the tests
// that demand the three executors.

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

/** 2026-02-02T09:00:00Z — a Monday mid-morning, outside quiet hours in UTC. */
const NOON = 1_770_022_800_000;
const DAY = 86_400_000;
const ENV = { FIELD_KEY: "k".repeat(64), APP_ORIGIN: "https://app.test" };

function makeCtx(now = NOON): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: {
      kind: "system",
      id: "scheduler",
      tenantId: "t_1",
      grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
    },
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

const at = (now: number): Ctx => ({ ...ctx, now });

function gatewayWith(reply: string): Gateway {
  const stub = makeStub({ replies: [reply] });
  return new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
}

async function seedJourney(id: string, nodes: object[], edges: object[]): Promise<void> {
  await ctx.db.insert(schema.orbitJourneys).values({
    id,
    tenantId: ctx.tenantId,
    key: `k_${id}`,
    version: 1,
    nameJson: JSON.stringify({ en: "Journey" }),
    graphJson: JSON.stringify({ cooldownDays: 30, nodes, edges }),
    status: "active",
    createdBy: "user:noor",
    createdAt: ctx.now
  });
}

async function seedCustomer(id: string): Promise<void> {
  await ctx.db.insert(schema.customers).values({
    id,
    tenantId: ctx.tenantId,
    type: "person",
    nameJson: JSON.stringify({ en: "Test Customer" }),
    locale: "en",
    country: "AE",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

async function seedRenewalAgent(status = "active"): Promise<void> {
  await ctx.db.insert(schema.aiAgents).values({
    id: "agt_renewal",
    tenantId: ctx.tenantId,
    key: "renewal",
    module: "orbit",
    nameJson: JSON.stringify({ en: "Renewal agent" }),
    tier: "fast",
    autonomyLevel: "suggest",
    promptRef: "orbit.renewal",
    status,
    createdAt: ctx.now,
    updatedAt: ctx.now
  } as never);
  await ctx.db.insert(schema.aiPrompts).values({
    id: "prm_renewal",
    tenantId: ctx.tenantId,
    key: "orbit.renewal",
    version: 1,
    locale: "en",
    body: "You draft renewal outreach from the context given, for a person to approve.",
    status: "active",
    createdBy: "user:noor",
    createdAt: ctx.now
  });
}

async function run(customerId = "cus_1") {
  const [row] = await ctx.db
    .select()
    .from(schema.orbitJourneyRuns)
    .where(and(eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId), eq(schema.orbitJourneyRuns.customerId, customerId)));
  return row!;
}

const contextOf = async (customerId = "cus_1") => JSON.parse((await run(customerId)).contextJson ?? "{}") as Record<string, unknown>;

function envelope(type: string, customerId: string): Envelope {
  return {
    id: `evt_${type}_${customerId}`,
    ts: NOON,
    tenant_id: "t_1",
    module: "orbit",
    type,
    actor: "system:test",
    subject: customerId,
    data: { customerId },
    v: 1
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = makeCtx();
  await ctx.db.insert(schema.tenants).values({
    id: "t_1",
    slug: "acme",
    name: "Acme",
    status: "active",
    createdAt: NOON,
    updatedAt: NOON
  } as never);
  await seedCustomer("cus_1");
  await seedCustomer("cus_2");
});

/* ---------------------------------------------------------------- wait_for */

describe("advanceJourneyRuns — wait_for", () => {
  const nodes = (timeoutDays?: number) => [
    { key: "start", type: "trigger", on: "axis.policy.issued" },
    { key: "hold", type: "wait_for", event: "orbit.conversation.document", ...(timeoutDays ? { timeoutDays } : {}) },
    { key: "got_it", type: "end" },
    { key: "gave_up", type: "end" }
  ];
  const edges = [
    { from: "start", to: "hold" },
    { from: "hold", to: "got_it", when: "event" },
    { from: "hold", to: "gave_up", when: "timeout" }
  ];

  it("parks until the named event arrives for the same customer, then takes the event edge", async () => {
    await seedJourney("jrn_wf", nodes(10), edges);
    await triggerJourney(ctx, "jrn_wf", ["cus_1"]);
    const parked = await advanceJourneyRuns(ctx);
    expect(parked.waiting).toBe(1);
    expect((await run()).nextAt).toBe(NOON + 10 * DAY);

    await onJourneyEvent(at(NOON + DAY), envelope("orbit.conversation.document", "cus_1"));
    await advanceJourneyRuns(at(NOON + DAY));

    const done = await run();
    expect(done.state).toBe("done");
    expect(done.node).toBe("got_it");
  });

  it("is not woken by the same event for a different customer", async () => {
    await seedJourney("jrn_wf", nodes(10), edges);
    await triggerJourney(ctx, "jrn_wf", ["cus_1"]);
    await advanceJourneyRuns(ctx);

    await onJourneyEvent(at(NOON + DAY), envelope("orbit.conversation.document", "cus_2"));
    await advanceJourneyRuns(at(NOON + DAY));

    const still = await run();
    expect(still.state).toBe("waiting");
    expect(still.node).toBe("hold");
  });

  it("takes the timeout edge once the timeout passes with no event", async () => {
    await seedJourney("jrn_wf", nodes(10), edges);
    await triggerJourney(ctx, "jrn_wf", ["cus_1"]);
    await advanceJourneyRuns(ctx);

    await advanceJourneyRuns(at(NOON + 11 * DAY));
    const done = await run();
    expect(done.state).toBe("done");
    expect(done.node).toBe("gave_up");
  });

  it("halts with wait_for_expired after the 30-day ceiling when the node sets no timeout", async () => {
    await seedJourney("jrn_wf", nodes(), edges);
    await triggerJourney(ctx, "jrn_wf", ["cus_1"]);
    await advanceJourneyRuns(ctx);
    expect((await run()).nextAt).toBe(NOON + 30 * DAY);

    await advanceJourneyRuns(at(NOON + 31 * DAY));
    expect((await run()).state).toBe("halted");
    expect(await contextOf()).toMatchObject({ haltReason: "wait_for_expired" });
  });
});

/* ------------------------------------------------------------------ survey */

describe("advanceJourneyRuns — survey", () => {
  const nodes = [
    { key: "start", type: "trigger", on: "axis.policy.issued" },
    { key: "csat", type: "survey" },
    { key: "end", type: "end" }
  ];
  const edges = [
    { from: "start", to: "csat" },
    { from: "csat", to: "end" }
  ];

  it("posts the rating link for the run's own conversation, then carries on", async () => {
    await seedJourney("jrn_sv", nodes, edges);
    await triggerJourney(ctx, "jrn_sv", ["cus_1"]);
    const result = await advanceJourneyRuns(ctx, 200, { env: ENV });

    expect(result.sent).toBe(1);
    expect((await run()).state).toBe("done");
    const [conversation] = await ctx.db.select().from(schema.orbitConversations);
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    // The link rates this conversation, on this tenant's portal, and carries its token.
    expect(message!.content).toContain(`https://app.test/portal/acme/feedback/${conversation!.id}?token=`);
    expect(message!.conversationId).toBe(conversation!.id);
  });

  it("halts rather than sending a survey to a customer who withdrew consent", async () => {
    await seedJourney("jrn_sv", nodes, edges);
    await triggerJourney(ctx, "jrn_sv", ["cus_1"]);
    await recordConsent(ctx, { customerId: "cus_1", purposes: { marketing: false }, channels: {}, source: "portal" });
    await advanceJourneyRuns(ctx, 200, { env: ENV });
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
    expect(await contextOf()).toMatchObject({ haltReason: "consent_withdrawn" });
  });

  it("halts with survey_unavailable when it has no way to mint the link", async () => {
    await seedJourney("jrn_sv", nodes, edges);
    await triggerJourney(ctx, "jrn_sv", ["cus_1"]);
    await advanceJourneyRuns(ctx);
    expect(await contextOf()).toMatchObject({ haltReason: "survey_unavailable" });
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------- agent */

describe("advanceJourneyRuns — agent", () => {
  const draftNodes = [
    { key: "start", type: "trigger", on: "orbit.renewal.due" },
    { key: "draft_offer", type: "agent", agent: "renewal", approval: "orbit.outbound_send" },
    { key: "end", type: "end" }
  ];
  const edges = [
    { from: "start", to: "draft_offer" },
    { from: "draft_offer", to: "end" }
  ];

  it("writes a pending draft — never a send — and waits for a person to send it", async () => {
    await seedRenewalAgent();
    await seedJourney("jrn_ag", draftNodes, edges);
    await triggerJourney(ctx, "jrn_ag", ["cus_1"]);
    const gateway = gatewayWith("Your policy is coming up for renewal. Reply here and we will prepare your terms.");
    await advanceJourneyRuns(ctx, 200, { gateway });

    const [draft] = await ctx.db.select().from(schema.orbitMessages);
    expect(draft!.role).toBe("agent_ai");
    expect(draft!.deliveryStatus).toBeNull();
    expect(draft!.aiAuditId).toBeTruthy();
    expect((await run()).state).toBe("waiting");

    // Still unsent a day later: the run holds.
    await advanceJourneyRuns(at(NOON + DAY), 200, { gateway });
    expect((await run()).node).toBe("draft_offer");

    // A person approves it: the conversation view posts it again as queued.
    await ctx.db.insert(schema.orbitMessages).values({
      id: "omg_sent",
      tenantId: ctx.tenantId,
      conversationId: draft!.conversationId,
      role: "agent_ai",
      modality: "text",
      content: draft!.content,
      deliveryStatus: "queued",
      ts: NOON + 2 * DAY
    } as never);
    await advanceJourneyRuns(at(NOON + 2 * DAY + 3_600_000), 200, { gateway });

    expect((await run()).state).toBe("done");
    expect(await contextOf()).toMatchObject({ draftOutcome: "sent" });
  });

  it("carries on with outcome expired when nobody acts on the draft within seven days", async () => {
    await seedRenewalAgent();
    await seedJourney("jrn_ag", draftNodes, edges);
    await triggerJourney(ctx, "jrn_ag", ["cus_1"]);
    await advanceJourneyRuns(ctx, 200, { gateway: gatewayWith("Reply here and we will prepare your renewal terms.") });

    await advanceJourneyRuns(at(NOON + 8 * DAY), 200, {});
    expect((await run()).state).toBe("done");
    expect(await contextOf()).toMatchObject({ draftOutcome: "expired" });
  });

  it("halts and writes nothing when the draft states a number the context did not give it", async () => {
    await seedRenewalAgent();
    await seedJourney("jrn_ag", draftNodes, edges);
    await triggerJourney(ctx, "jrn_ag", ["cus_1"]);
    await advanceJourneyRuns(ctx, 200, { gateway: gatewayWith("Renew today for just 1500 AED.") });

    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
    expect(await contextOf()).toMatchObject({ haltReason: "draft_refused" });
  });

  it("halts with agent_unavailable when the agent is paused or there is no gateway", async () => {
    await seedRenewalAgent("paused");
    await seedJourney("jrn_ag", draftNodes, edges);
    await triggerJourney(ctx, "jrn_ag", ["cus_1"]);
    await advanceJourneyRuns(ctx, 200, { gateway: gatewayWith("Anything.") });
    expect(await contextOf()).toMatchObject({ haltReason: "agent_unavailable" });
  });

  it("an agent node with no approval records the renewal's churn score and carries on, no model involved", async () => {
    await ctx.db.insert(schema.orbitRenewals).values({
      id: "ren_1",
      tenantId: ctx.tenantId,
      customerId: "cus_1",
      policyRef: "POL-2201",
      churnScore: 72,
      strategy: "human",
      state: "scheduled",
      expiryAt: NOON + 45 * DAY,
      createdAt: NOON,
      updatedAt: NOON
    } as never);
    await seedJourney(
      "jrn_score",
      [
        { key: "start", type: "trigger", on: "orbit.renewal.due" },
        { key: "score_churn", type: "agent", agent: "renewal" },
        { key: "end", type: "end" }
      ],
      [
        { from: "start", to: "score_churn" },
        { from: "score_churn", to: "end" }
      ]
    );
    await triggerJourney(ctx, "jrn_score", ["cus_1"]);
    await advanceJourneyRuns(ctx);

    expect((await run()).state).toBe("done");
    expect(await contextOf()).toMatchObject({ churnScore: 72 });
  });
});

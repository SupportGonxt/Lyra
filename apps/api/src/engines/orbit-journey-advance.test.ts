import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, recordConsent, type Actor, type Ctx } from "@lyra/core";
import { advanceJourneyRuns, onJourneyEvent, triggerJourney } from "./orbit-journeys.js";

// docs/27 F30: `triggerJourney` wrote a run at `startNode()` and nothing ever
// moved it — `wait`, `send`, `branch` and `task` nodes were four documented
// node types with no executor, and `orbit_journey_runs.nextAt`/`state` were
// columns nothing read. These are the tests that demanded the advance step.

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

function actor(): Actor {
  return {
    kind: "system",
    id: "scheduler",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

function makeCtx(now = NOON): Ctx {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

function at(now: number): Ctx {
  return { ...ctx, now };
}

async function seedJourney(id: string, graph: object, patch: { status?: string } = {}): Promise<void> {
  await ctx.db.insert(schema.orbitJourneys).values({
    id,
    tenantId: ctx.tenantId,
    key: `k_${id}`,
    version: 1,
    nameJson: JSON.stringify({ en: "Journey" }),
    graphJson: JSON.stringify({ cooldownDays: 30, ...graph }),
    status: patch.status ?? "active",
    createdBy: "user:noor",
    createdAt: ctx.now
  });
}

async function seedCustomer(id: string, patch: { locale?: string; country?: string } = {}): Promise<void> {
  await ctx.db.insert(schema.customers).values({
    id,
    tenantId: ctx.tenantId,
    type: "person",
    nameJson: JSON.stringify({ en: "Test Customer" }),
    locale: patch.locale ?? "en",
    country: patch.country ?? "AE",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

async function run(customerId = "cus_1") {
  const [row] = await ctx.db
    .select()
    .from(schema.orbitJourneyRuns)
    .where(and(eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId), eq(schema.orbitJourneyRuns.customerId, customerId)));
  return row!;
}

const SEND_GRAPH = {
  nodes: [
    { key: "start", type: "trigger", on: "axis.policy.issued" },
    { key: "welcome", type: "send", channel: "email", templateKey: "welcome" },
    { key: "pause", type: "wait", hours: 48 },
    { key: "nudge", type: "send", channel: "email", templateKey: "nudge" },
    { key: "done", type: "end" }
  ],
  edges: [
    { from: "start", to: "welcome" },
    { from: "welcome", to: "pause" },
    { from: "pause", to: "nudge" },
    { from: "nudge", to: "done" }
  ]
};

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = makeCtx();
  await seedCustomer("cus_1");
});

describe("advanceJourneyRuns — send and wait", () => {
  it("sends the message the run is parked on, then parks on the wait node until it is due", async () => {
    await seedJourney("jrn_send", SEND_GRAPH);
    await triggerJourney(ctx, "jrn_send", ["cus_1"]);
    expect((await run()).node).toBe("welcome");

    const first = await advanceJourneyRuns(ctx);
    expect(first.sent).toBe(1);
    expect(first.waiting).toBe(1);

    const parked = await run();
    expect(parked.node).toBe("pause");
    expect(parked.state).toBe("waiting");
    expect(parked.nextAt).toBe(ctx.now + 48 * 3_600_000);

    // The send is a real transcript row on a real conversation, not a log line.
    const messages = await ctx.db.select().from(schema.orbitMessages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toContain("welcome");
    const conversations = await ctx.db.select().from(schema.orbitConversations);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.customerId).toBe("cus_1");
  });

  it("leaves a run parked while its wait is in the future and resumes it once due", async () => {
    await seedJourney("jrn_send", SEND_GRAPH);
    await triggerJourney(ctx, "jrn_send", ["cus_1"]);
    await advanceJourneyRuns(ctx);

    const early = await advanceJourneyRuns(at(ctx.now + 3_600_000));
    expect(early.advanced).toBe(0);
    expect((await run()).node).toBe("pause");

    const due = at(ctx.now + 49 * 3_600_000);
    const late = await advanceJourneyRuns(due);
    expect(late.sent).toBe(1);
    expect(late.completed).toBe(1);
    const finished = await run();
    expect(finished.state).toBe("done");
    expect(finished.node).toBe("done");
  });

  it("defers a send inside quiet hours instead of sending it", async () => {
    await seedJourney("jrn_send", SEND_GRAPH);
    await triggerJourney(ctx, "jrn_send", ["cus_1"]);
    // 22:00 UTC — inside the 20:00–08:00 floor.
    const night = at(NOON + 13 * 3_600_000);
    const result = await advanceJourneyRuns(night);
    expect(result.sent).toBe(0);
    expect(result.deferredQuietHours).toBe(1);
    const parked = await run();
    expect(parked.node).toBe("welcome");
    expect(parked.state).toBe("waiting");
    expect(parked.nextAt).toBeGreaterThan(night.now);
    expect(await ctx.db.select().from(schema.orbitMessages)).toHaveLength(0);
  });

  it("halts a run whose customer withdrew consent before the send", async () => {
    await seedJourney("jrn_send", SEND_GRAPH);
    await triggerJourney(ctx, "jrn_send", ["cus_1"]);
    await recordConsent(ctx, {
      customerId: "cus_1",
      purposes: { marketing: false },
      channels: {},
      source: "portal"
    });
    const result = await advanceJourneyRuns(ctx);
    expect(result.sent).toBe(0);
    expect(result.halted).toBe(1);
    const halted = await run();
    expect(halted.state).toBe("halted");
    expect(JSON.parse(halted.contextJson!)).toMatchObject({ haltReason: "consent_withdrawn" });
  });
});

describe("advanceJourneyRuns — branch", () => {
  const BRANCH_GRAPH = {
    nodes: [
      { key: "start", type: "trigger", on: "axis.policy.issued" },
      { key: "which", type: "branch", on: "attribute", attribute: "locale", equals: "ar" },
      { key: "arabic", type: "send", channel: "whatsapp", templateKey: "welcome_ar" },
      { key: "english", type: "send", channel: "email", templateKey: "welcome_en" },
      { key: "done", type: "end" }
    ],
    edges: [
      { from: "start", to: "which" },
      { from: "which", to: "arabic", when: "true" },
      { from: "which", to: "english", when: "false" },
      { from: "arabic", to: "done" },
      { from: "english", to: "done" }
    ]
  };

  it("takes the true edge when the customer attribute matches", async () => {
    await seedCustomer("cus_ar", { locale: "ar" });
    await seedJourney("jrn_branch", BRANCH_GRAPH);
    await triggerJourney(ctx, "jrn_branch", ["cus_ar"]);
    await advanceJourneyRuns(ctx);
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    expect(message!.content).toContain("welcome_ar");
    expect((await run("cus_ar")).state).toBe("done");
  });

  it("takes the false edge when it does not", async () => {
    await seedJourney("jrn_branch", BRANCH_GRAPH);
    await triggerJourney(ctx, "jrn_branch", ["cus_1"]);
    await advanceJourneyRuns(ctx);
    const [message] = await ctx.db.select().from(schema.orbitMessages);
    expect(message!.content).toContain("welcome_en");
  });
});

describe("advanceJourneyRuns — task", () => {
  const TASK_GRAPH = {
    nodes: [
      { key: "start", type: "trigger", on: "axis.case.status_changed" },
      { key: "chase", type: "task", title: "Chase the missing document", skills: ["docs"] },
      { key: "done", type: "end" }
    ],
    edges: [
      { from: "start", to: "chase" },
      { from: "chase", to: "done" }
    ]
  };

  it("queues a human task as a routed conversation and waits for it to close", async () => {
    await ctx.db.insert(schema.orbitTeams).values({
      id: "otm_1",
      tenantId: ctx.tenantId,
      key: "cx",
      nameJson: JSON.stringify({ en: "CX" }),
      isDefault: true,
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    await seedJourney("jrn_task", TASK_GRAPH);
    await triggerJourney(ctx, "jrn_task", ["cus_1"]);

    const first = await advanceJourneyRuns(ctx);
    expect(first.tasks).toBe(1);
    const parked = await run();
    expect(parked.state).toBe("waiting");
    const [task] = await ctx.db.select().from(schema.orbitConversations);
    expect(task!.state).toBe("human");
    // Routed through the F29 engine, so the task lands in a team queue.
    expect(task!.teamId).toBe("otm_1");
    expect(JSON.parse(task!.requireSkillsJson!)).toEqual(["docs"]);

    // Still open an hour later: the run does not move past it.
    const still = await advanceJourneyRuns(at(ctx.now + 2 * 3_600_000));
    expect(still.completed).toBe(0);
    expect((await run()).node).toBe("chase");

    await ctx.db
      .update(schema.orbitConversations)
      .set({ state: "closed", closedAt: ctx.now })
      .where(eq(schema.orbitConversations.id, task!.id));
    const after = await advanceJourneyRuns(at(ctx.now + 4 * 3_600_000));
    expect(after.completed).toBe(1);
    expect((await run()).state).toBe("done");
  });
});

describe("advanceJourneyRuns — graph defects", () => {
  it("halts rather than spinning on a cyclic graph", async () => {
    await seedJourney("jrn_loop", {
      nodes: [
        { key: "start", type: "trigger", on: "x" },
        { key: "a", type: "branch", on: "attribute", attribute: "locale", equals: "en" },
        { key: "b", type: "branch", on: "attribute", attribute: "locale", equals: "en" }
      ],
      edges: [
        { from: "start", to: "a" },
        { from: "a", to: "b", when: "true" },
        { from: "b", to: "a", when: "true" }
      ]
    });
    await triggerJourney(ctx, "jrn_loop", ["cus_1"]);
    const result = await advanceJourneyRuns(ctx);
    expect(result.halted).toBe(1);
    expect(JSON.parse((await run()).contextJson!)).toMatchObject({ haltReason: "step_limit" });
  });

  it("halts on a node type it does not know", async () => {
    await seedJourney("jrn_unknown", {
      nodes: [
        { key: "start", type: "trigger", on: "x" },
        { key: "weird", type: "telepathy" }
      ],
      edges: [{ from: "start", to: "weird" }]
    });
    await triggerJourney(ctx, "jrn_unknown", ["cus_1"]);
    const result = await advanceJourneyRuns(ctx);
    expect(result.halted).toBe(1);
    expect(JSON.parse((await run()).contextJson!)).toMatchObject({ haltReason: "unknown_node_type" });
  });
});

describe("onJourneyEvent", () => {
  const envelope = (type: string, data: Record<string, unknown>) => ({
    id: "evt_1",
    type,
    tenant_id: "t_1",
    module: "axis",
    subject: "pol_1",
    occurred_at: NOON,
    version: 1 as const,
    data
  });

  it("triggers every active journey whose trigger node names the event type", async () => {
    await seedJourney("jrn_welcome", SEND_GRAPH);
    await seedJourney("jrn_other", {
      nodes: [
        { key: "start", type: "trigger", on: "orbit.renewal.raised" },
        { key: "done", type: "end" }
      ],
      edges: [{ from: "start", to: "done" }]
    });

    await onJourneyEvent(ctx, envelope("axis.policy.issued", { customerId: "cus_1", policyId: "pol_1" }) as never);

    const runs = await ctx.db.select().from(schema.orbitJourneyRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.journeyId).toBe("jrn_welcome");
  });

  it("is a no-op for an event carrying no customer", async () => {
    await seedJourney("jrn_welcome", SEND_GRAPH);
    await onJourneyEvent(ctx, envelope("axis.policy.issued", { policyId: "pol_1" }) as never);
    expect(await ctx.db.select().from(schema.orbitJourneyRuns)).toHaveLength(0);
  });

  it("ignores a draft journey", async () => {
    await seedJourney("jrn_draft", SEND_GRAPH, { status: "draft" });
    await onJourneyEvent(ctx, envelope("axis.policy.issued", { customerId: "cus_1" }) as never);
    expect(await ctx.db.select().from(schema.orbitJourneyRuns)).toHaveLength(0);
  });
});

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { JOURNEY_NODE_TYPES, advanceJourneyRuns, triggerJourney } from "./orbit-journeys.js";

// docs/30 ORBIT gap 1. Both active seeded journeys halted with
// `unknown_node_type`: the seed authored node types the executor never knew,
// and nothing compared the two. The guard below is that comparison; the walk
// after it is the proof the two active journeys now run end to end.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 2026-02-02T09:00:00Z, a Monday morning: outside quiet hours. */
const NOON = 1_770_022_800_000;
const DAY = 86_400_000;
const ENV = { FIELD_KEY: "k".repeat(64), APP_ORIGIN: "https://app.test" };

let ctx: Ctx;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const { tenantId } = await seed(db, { password: "journey-seeded-test-2026" });
  ctx = {
    db,
    tenantId,
    actor: {
      kind: "system",
      id: "scheduler",
      tenantId,
      grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
    },
    requestId: "req_1",
    now: NOON,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}, 120_000);

const graphOf = (json: string) => JSON.parse(json) as { nodes: { key: string; type: string }[] };

describe("seeded journeys", () => {
  it("name only node types the executor runs", async () => {
    const journeys = await ctx.db.select().from(schema.orbitJourneys);
    expect(journeys.length).toBeGreaterThan(0);
    const unknown = journeys.flatMap((j) =>
      graphOf(j.graphJson)
        .nodes.filter((n) => !(JOURNEY_NODE_TYPES as readonly string[]).includes(n.type))
        .map((n) => `${j.key}:${n.key}:${n.type}`)
    );
    expect(unknown).toEqual([]);
  });

  it("run every active customer journey from trigger to end", async () => {
    const all = await ctx.db
      .select()
      .from(schema.orbitJourneys)
      .where(and(eq(schema.orbitJourneys.tenantId, ctx.tenantId), eq(schema.orbitJourneys.status, "active")));
    // Partner activation enrols partners, and runs are keyed by customer: it
    // cannot start until partner-keyed runs are specified (docs/27, docs/30).
    // Named here so a second exclusion cannot slip in unremarked.
    const PARTNER_JOURNEYS = ["broker_activation"];
    const active = all.filter((j) => !PARTNER_JOURNEYS.includes(j.key));
    expect(active.map((j) => j.key).sort()).toEqual(["onboarding_new_policy", "renewal_45d"]);

    // A clean slate: the seed parks historical runs mid-graph for the runs tab.
    await ctx.db.delete(schema.orbitJourneyRuns);
    const [customer] = await ctx.db.select().from(schema.customers).where(eq(schema.customers.tenantId, ctx.tenantId)).limit(1);
    const customerId = customer!.id;
    for (const journey of active) await triggerJourney(ctx, journey.id, [customerId]);

    const stub = makeStub({ replies: ["Your cover is coming up for renewal. Reply here and we will prepare your terms."] });
    const gateway = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });

    // Walk the clock a day at a time. Each day a person acts on whatever the
    // journeys left for them — sends a pending draft, closes a raised task —
    // exactly what the inbox would see.
    for (let day = 0; day <= 20; day++) {
      const now = NOON + day * DAY;
      await advanceJourneyRuns({ ...ctx, now }, 200, { env: ENV, gateway });

      const drafts = (await ctx.db.select().from(schema.orbitMessages)).filter(
        (m) => m.role === "agent_ai" && m.deliveryStatus === null && m.ts >= NOON
      );
      for (const draft of drafts) {
        await ctx.db.insert(schema.orbitMessages).values({
          id: `omg_sent_${draft.id}`,
          tenantId: ctx.tenantId,
          conversationId: draft.conversationId,
          role: "agent_ai",
          modality: "text",
          content: draft.content,
          deliveryStatus: "queued",
          ts: now + 60_000
        } as never);
        await ctx.db.update(schema.orbitMessages).set({ deliveryStatus: "sent" }).where(eq(schema.orbitMessages.id, draft.id));
      }
      const tasks = (await ctx.db.select().from(schema.orbitConversations)).filter(
        (c) => c.intent === "journey_task" && c.state !== "closed" && c.createdAt >= NOON
      );
      for (const task of tasks) {
        await ctx.db
          .update(schema.orbitConversations)
          .set({ state: "closed", closedAt: now })
          .where(eq(schema.orbitConversations.id, task.id));
      }
    }

    const runs = await ctx.db.select().from(schema.orbitJourneyRuns);
    expect(runs.map((r) => ({ state: r.state, halt: JSON.parse(r.contextJson ?? "{}").haltReason }))).toEqual(
      active.map(() => ({ state: "done", halt: undefined }))
    );
  });
});

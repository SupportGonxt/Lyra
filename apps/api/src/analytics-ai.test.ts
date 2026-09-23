import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { onError } from "./mw.js";
import { analyticsRoutes } from "./routes/analytics.js";
import type { App, Env } from "./env.js";

// ANL-009's operating half: the AI subsystem reported through the same semantic
// layer as every business table, so "what is AI costing, and is it any good"
// is a report a reader can build, save and schedule — not a bespoke endpoint
// per question. Driven through the real /v1/analytics/run handler.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
const DAY = 86_400_000;
const env = {} as unknown as Env;

let ctx: Ctx;

function actor(permissions: string[]): Ctx["actor"] {
  return { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "test", permissions }] };
}

function router(over: Partial<Ctx> = {}): Hono<App> {
  const app = new Hono<App>();
  app.onError(onError);
  app.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, ...over });
    await next();
  });
  app.route("/v1/analytics", analyticsRoutes);
  return app;
}

async function run(def: unknown, over: Partial<Ctx> = {}): Promise<{ status: number; body: any }> {
  const res = await router(over).fetch(
    new Request("http://api.test/v1/analytics/run", {
      method: "POST",
      body: JSON.stringify(def),
      headers: { "content-type": "application/json" }
    }),
    env as never
  );
  return { status: res.status, body: await res.json() };
}

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: actor(["*:*:*"]),
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seed();
});

const READ = ["analytics:reports:run"];

describe("AI datasets", () => {
  it("offers every AI dataset in the catalogue to a caller who may read it", async () => {
    const res = await router().fetch(new Request("http://api.test/v1/analytics/datasets"), env as never);
    const keys = ((await res.json()) as { data: { key: string }[] }).data.map((d) => d.key);
    expect(keys).toEqual(expect.arrayContaining(["aiRuns", "aiSpend", "aiSuggestions", "aiGuardrails", "aiEvals"]));
  });

  it("aiRuns: runs, tokens, cost and latency by module and state, tenant-scoped", async () => {
    const { status, body } = await run({
      dataset: "aiRuns",
      metrics: ["runs", "tokensIn", "costMicro", "latency", "failureRate"],
      dimensions: ["module"],
      sort: { field: "module", dir: "asc" }
    });
    expect(status).toBe(201);
    expect(body.rows).toEqual([
      { module: "axis", runs: 2, tokensIn: 300, costMicro: 3000, latency: 150, failureRate: 50 },
      { module: "orbit", runs: 1, tokensIn: 50, costMicro: 500, latency: 400, failureRate: 0 }
    ]);
  });

  it("aiRuns: buckets by day", async () => {
    const { body } = await run({ dataset: "aiRuns", metrics: ["runs"], grain: "day" });
    expect(body.rows).toEqual([
      { period: "2026-06-14", runs: 1 },
      { period: "2026-06-15", runs: 2 }
    ]);
  });

  it("aiSpend: calls, tokens, cost and refusal rate by purpose", async () => {
    const { status, body } = await run({
      dataset: "aiSpend",
      metrics: ["calls", "costMicro", "refusalRate"],
      dimensions: ["purpose"],
      sort: { field: "purpose", dir: "asc" }
    });
    expect(status).toBe(201);
    expect(body.rows).toEqual([
      { purpose: "draft", calls: 1, costMicro: 200, refusalRate: 0 },
      { purpose: "triage", calls: 2, costMicro: 700, refusalRate: 50 }
    ]);
  });

  it("aiSuggestions: shown, accepted and acceptance rate by module (an edit counts as a hit)", async () => {
    const { status, body } = await run({
      dataset: "aiSuggestions",
      metrics: ["shown", "accepted", "dismissed", "acceptanceRate"],
      dimensions: ["module"],
      sort: { field: "module", dir: "asc" }
    });
    expect(status).toBe(201);
    expect(body.rows).toEqual([
      { module: "axis", shown: 4, accepted: 1, dismissed: 1, acceptanceRate: 50 },
      { module: "orbit", shown: 1, accepted: 1, dismissed: 0, acceptanceRate: 100 }
    ]);
  });

  it("aiGuardrails: events and blocks by rule", async () => {
    const { status, body } = await run({
      dataset: "aiGuardrails",
      metrics: ["events", "blocks"],
      dimensions: ["rule"],
      sort: { field: "rule", dir: "asc" }
    });
    expect(status).toBe(201);
    expect(body.rows).toEqual([
      { rule: "injection", events: 1, blocks: 1 },
      { rule: "pii", events: 2, blocks: 0 }
    ]);
  });

  it("aiEvals: average score and pass rate by suite", async () => {
    const { status, body } = await run({
      dataset: "aiEvals",
      metrics: ["cases", "avgScore", "passRate"],
      dimensions: ["suite"],
      sort: { field: "suite", dir: "asc" }
    });
    expect(status).toBe(201);
    expect(body.rows).toEqual([
      { suite: "north", cases: 1, avgScore: 90, passRate: 100 },
      { suite: "triage", cases: 2, avgScore: 70, passRate: 50 }
    ]);
  });

  it("filters on a dimension like any other dataset", async () => {
    const { body } = await run({
      dataset: "aiRuns",
      metrics: ["runs"],
      filters: [{ field: "state", op: "eq", value: "succeeded" }]
    });
    expect(body.rows).toEqual([{ runs: 2 }]);
  });

  it("never counts another tenant's rows", async () => {
    for (const [dataset, metric] of [
      ["aiRuns", "runs"],
      ["aiSpend", "calls"],
      ["aiSuggestions", "shown"],
      ["aiGuardrails", "events"],
      ["aiEvals", "cases"]
    ] as const) {
      const { body } = await run({ dataset, metrics: [metric] });
      // t_other seeds 100 of each; none may leak into t_test's totals.
      expect(body.rows[0][metric], dataset).toBeLessThan(10);
    }
  });

  it.each([
    ["aiRuns", "runs", "ai:runs:read"],
    ["aiSpend", "calls", "ai:budgets:read"],
    ["aiSuggestions", "shown", "ai:runs:read"],
    ["aiGuardrails", "events", "ai:audit:read"],
    ["aiEvals", "cases", "ai:evals:read"]
  ])("%s is gated on %s", async (dataset, metric, permission) => {
    const denied = await run({ dataset, metrics: [metric] }, { actor: actor(READ) });
    expect(denied.status).toBe(403);
    const allowed = await run({ dataset, metrics: [metric] }, { actor: actor([...READ, permission]) });
    expect(allowed.status).toBe(201);

    const res = await router({ actor: actor(READ) }).fetch(new Request("http://api.test/v1/analytics/datasets"), env as never);
    const keys = ((await res.json()) as { data: { key: string }[] }).data.map((d) => d.key);
    expect(keys).not.toContain(dataset);
  });
});

/* -------------------------------------------------------------------- seeds */

async function seed(): Promise<void> {
  const run = (over: Partial<typeof schema.aiRuns.$inferInsert> & { id: string }) => ({
    tenantId: "t_test",
    agentKey: "triage",
    module: "axis",
    purpose: "triage",
    actorRef: "user:u_test",
    autonomyLevel: "suggest",
    state: "succeeded",
    inputHash: "h",
    tokensIn: 100,
    tokensOut: 50,
    costMicro: 1000,
    latencyMs: 100,
    startedAt: NOW,
    ...over
  });
  await ctx.db.insert(schema.aiRuns).values([
    run({ id: "r1", tokensIn: 100, costMicro: 1000, latencyMs: 100 }),
    run({ id: "r2", tokensIn: 200, costMicro: 2000, latencyMs: 200, state: "failed", startedAt: NOW - DAY }),
    run({ id: "r3", module: "orbit", agentKey: "draft", purpose: "draft", tokensIn: 50, costMicro: 500, latencyMs: 400 }),
    ...Array.from({ length: 100 }, (_, i) => run({ id: `ro${i}`, tenantId: "t_other" }))
  ]);

  const call = (over: Partial<typeof schema.aiAuditLog.$inferInsert> & { id: string }) => ({
    tenantId: "t_test",
    module: "axis",
    purpose: "triage",
    model: "m",
    provider: "p",
    tier: "fast",
    inputHash: "h",
    actorRef: "user:u_test",
    outcome: "ok",
    ts: NOW,
    ...over
  });
  await ctx.db.insert(schema.aiAuditLog).values([
    call({ id: "a1", costMicro: 300 }),
    call({ id: "a2", costMicro: 400, outcome: "refused" }),
    call({ id: "a3", purpose: "draft", module: "orbit", costMicro: 200 }),
    ...Array.from({ length: 100 }, (_, i) => call({ id: `ao${i}`, tenantId: "t_other" }))
  ]);

  const sug = (over: Partial<typeof schema.aiSuggestions.$inferInsert> & { id: string }) => ({
    tenantId: "t_test",
    surface: "chip",
    module: "axis",
    userId: "u_test",
    outcome: "shown",
    shownAt: NOW,
    ...over
  });
  await ctx.db.insert(schema.aiSuggestions).values([
    sug({ id: "s1", outcome: "accepted" }),
    sug({ id: "s2", outcome: "edited" }),
    sug({ id: "s3", outcome: "dismissed" }),
    sug({ id: "s4", outcome: "shown" }),
    sug({ id: "s5", module: "orbit", outcome: "accepted" }),
    ...Array.from({ length: 100 }, (_, i) => sug({ id: `so${i}`, tenantId: "t_other" }))
  ]);

  const trip = (over: Partial<typeof schema.aiGuardrailEvents.$inferInsert> & { id: string }) => ({
    tenantId: "t_test",
    rule: "pii",
    severity: "warn",
    ts: NOW,
    ...over
  });
  await ctx.db.insert(schema.aiGuardrailEvents).values([
    trip({ id: "g1" }),
    trip({ id: "g2", severity: "info" }),
    trip({ id: "g3", rule: "injection", severity: "block" }),
    ...Array.from({ length: 100 }, (_, i) => trip({ id: `go${i}`, tenantId: "t_other" }))
  ]);

  const ev = (over: Partial<typeof schema.aiEvals.$inferInsert> & { id: string }) => ({
    tenantId: "t_test",
    suite: "triage",
    caseKey: "c",
    agentKey: "triage",
    model: "m",
    score: 80,
    passed: true,
    thresholdScore: 70,
    ts: NOW,
    ...over
  });
  await ctx.db.insert(schema.aiEvals).values([
    ev({ id: "e1", score: 80, passed: true }),
    ev({ id: "e2", score: 60, passed: false }),
    ev({ id: "e3", suite: "north", score: 90, passed: true }),
    ...Array.from({ length: 100 }, (_, i) => ev({ id: `eo${i}`, tenantId: "t_other" }))
  ]);
}

import { Hono, type Context } from "hono";
import { and, desc, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { AgentAutonomy, id as newId, parseJson, schema, toJson, PolicyJson } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  conflict,
  flagEnabled,
  gate,
  notFound,
  recallMemories,
  remember,
  require_,
  MODULES,
  type Ctx
} from "@lyra/core";
import {
  AI_KILL_SWITCH,
  checkBudget,
  isKnownPurpose,
  offersTools,
  planRound,
  setLimits,
  type Gateway,
  type Message,
  type ToolCall
} from "@lyra/model-gateway";
import { body, intParam, MAX_INSTANT_MS } from "../http.js";
import { executeOrbitToolCalls, orbitToolsFor } from "../engines/orbit-tools.js";
import { embedQuery } from "../engines/vectorize.js";
import { agentByKey, activePrompt } from "../engines/ai-agent.js";
import { runCommandLoop } from "../engines/command-loop.js";
import { must } from "../rows.js";
import type { App } from "../env.js";

// docs/15. AI is a subsystem with a front door, not a feature bolted onto five
// modules. Everything here goes through the gateway, which means everything is
// budgeted, scrubbed, guardrailed and written to ai_audit_log — there is no
// second path to a model.

export const aiRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/* --------------------------------------------------------------- agent runs */

const RunBody = z.object({
  agentKey: z.string().min(1).max(64),
  purpose: z.string().min(1).max(64),
  subjectRef: z.string().max(200).optional(),
  locale: z.enum(["en", "ar"]).optional(),
  input: z.string().min(1).max(20_000),
  /** Extra context the surface already has, so the agent does not re-fetch it. */
  context: z.record(z.string(), z.unknown()).optional(),
  trigger: z.enum(["user", "event", "schedule", "api"]).default("user")
});

/**
 * Run a registered agent. The agent row carries the tier, the autonomy level and
 * the prompt reference, so raising a model or loosening autonomy is a data
 * change with an approval behind it — never a deploy.
 */
aiRoutes.post("/runs", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, RunBody);
  const agent = await agentByKey(ctx, input.agentKey);
  require_(ctx.actor, `${agent.module}:ai:invoke`, { tenantId: ctx.tenantId, module: agent.module });
  if (agent.status !== "active") throw badRequest(`agent ${agent.key} is ${agent.status}`);
  // docs/27 F40. `purpose` steers the output guardrail, so it is a safety input
  // arriving from the request body. The gateway still fails closed on anything
  // unknown; rejecting here means a typo is a 400 at the door rather than a
  // silently over-strict run the caller cannot explain.
  if (!isKnownPurpose(agent.module, input.purpose))
    throw badRequest(`purpose ${input.purpose} is not registered for module ${agent.module}`);

  const prompt = await activePrompt(ctx, agent.promptRef);
  const runId = newId("air", ctx.now);
  const started = ctx.now;

  await ctx.db.insert(schema.aiRuns).values({
    id: runId,
    tenantId: ctx.tenantId,
    agentKey: agent.key,
    module: agent.module,
    purpose: input.purpose,
    subjectRef: input.subjectRef ?? null,
    actorRef: actorRef(ctx),
    autonomyLevel: agent.autonomyLevel,
    trigger: input.trigger,
    state: "running",
    inputHash: "",
    startedAt: started
  });

  try {
    // docs/27 F9. VEC_CONVO metadata is written by the AgentRoom DO as
    // { tenantId, conversationId, role, text } (apps/agents AgentRoom), and an
    // ORBIT run's subjectRef IS the conversation id (apps/web conversation.tsx
    // calls /v1/ai/runs?subjectRef=<id>). A tenant-only filter therefore pulls
    // another customer's messages into a run about this one: not a tenancy
    // breach, a confidentiality one. No subjectRef, no recall — a tenant-wide
    // sweep is the thing we are removing, not the fallback.
    const recall =
      agent.module === "orbit" && input.subjectRef
        ? await embedQuery(ctx, c.get("gateway"), c.env.VEC_CONVO, {
            module: "orbit",
            purpose: "orbit.message.recall",
            text: input.input,
            topK: 5,
            filter: { tenantId: ctx.tenantId, conversationId: input.subjectRef }
          })
        : [];

    // docs/27 F34 / docs/16 H11. `core_memories` had no reader and no writer.
    // This is the reader: durable claims held about this subject, and only the
    // ones bound to the purpose of this call. Vector recall above answers "what
    // was said"; memory answers "what we concluded", which is the half that
    // survives a conversation ending.
    //
    // `medium` is this surface's ceiling, not a default — `recallMemories`
    // refuses to have one, because a default here is a decision about customer
    // data that the next caller would inherit without making it.
    const memories = input.subjectRef
      ? await recallMemories(ctx, input.subjectRef, {
          purpose: input.purpose,
          now: ctx.now,
          maxSensitivity: "medium",
          limit: 5
        })
      : [];

    const messages: Message[] = [
      { role: "system", content: prompt },
      {
        role: "user",
        content: [
          input.context ? `${input.input}\n\ncontext:\n${JSON.stringify(input.context)}` : input.input,
          recall.length
            ? `relevant past messages:\n${recall.map((m) => m.metadata?.role + ": " + m.metadata?.text).join("\n")}`
            : "",
          memories.length
            ? `what is already known about this subject:\n${memories.map((m) => `- ${m.kind}: ${m.contentJson}`).join("\n")}`
            : ""
        ]
          .filter(Boolean)
          .join("\n\n")
      }
    ];

    // docs/27 F33. This was two calls: one with tools, then — if the model
    // asked for any — a second with none. A model could look a policy up and
    // never act on what it read, because the only turn in which it could act
    // was the one it had already spent, and every transcript needing a second
    // dependent step was silently truncated into a summary of step one.
    //
    // It is now a real loop, bounded by the same `MAX_ROUNDS`/`offersTools`
    // rule the command loop uses (packages/model-gateway/src/agent-loop.ts,
    // evals/agent-loop). Each round is its own `gateway.complete`, so every one
    // is separately budgeted, scrubbed, guardrailed and audited — there is no
    // "loop call" that escapes the front door.
    const tools = agent.module === "orbit" ? orbitToolsFor(agent) : [];
    const allowed = new Set(tools.map((t) => t.name));
    const turns: Message[] = [...messages];
    const usage = { tokensIn: 0, tokensOut: 0, costMicro: 0 };
    let latencyMs = 0;
    let toolSeq = 0;
    const askedFor: ToolCall[] = [];

    const round = async (seq: number): Promise<Awaited<ReturnType<Gateway["complete"]>>> => {
      const res = await c.get("gateway").complete(ctx, {
        module: agent.module,
        purpose: input.purpose,
        tier: agent.tier as "fast" | "standard" | "reasoning",
        ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(tools.length && offersTools(seq) ? { tools } : {}),
        messages: turns
      });
      usage.tokensIn += res.usage.tokensIn;
      usage.tokensOut += res.usage.tokensOut;
      usage.costMicro += res.usage.costMicro;
      latencyMs += res.latencyMs;
      return res;
    };

    let seq = 0;
    let final = await round(seq);
    for (;;) {
      // A module with no registry (everything but ORBIT today) never loops: a
      // tool call echoed back by a model that was offered none is nothing this
      // route can execute, and looping on it would spend the tenant's budget
      // re-asking the same question.
      const step = tools.length ? planRound({ round: seq, toolCalls: final.toolCalls }) : ({ action: "answer" } as const);
      if (step.action !== "execute") break;
      askedFor.push(...final.toolCalls);
      // The registry executes, records one `ai_tool_calls` row per call and
      // gates the consequential ones (CLAUDE.md rule 4). `seq` continues across
      // rounds so the run's tool sequence stays a sequence.
      const results = await executeOrbitToolCalls(ctx, runId, final.toolCalls, allowed, toolSeq);
      toolSeq += final.toolCalls.length;
      turns.push({ role: "assistant", content: final.text }, ...results);
      seq += 1;
      final = await round(seq);
    }

    // A refusal is a successful run with a refusal outcome, not an error. The
    // operator needs to see that the guardrail fired, not a 500.
    const refused = final.finishReason === "refusal";

    await ctx.db
      .update(schema.aiRuns)
      .set({
        state: refused ? "refused" : "succeeded",
        inputHash: final.auditId,
        outputRef: final.auditId,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costMicro: usage.costMicro,
        latencyMs,
        evidenceJson: JSON.stringify({ flags: final.flags, model: final.model, provider: final.provider }),
        endedAt: ctx.now
      })
      .where(and(eq(schema.aiRuns.tenantId, ctx.tenantId), eq(schema.aiRuns.id, runId)));

    // …and the writer. A run that actually used tools reached a conclusion the
    // next run about this subject should not have to re-derive, which is what
    // H11's "compounding" means.
    //
    // Three deliberate narrowings, because a memory store fed model prose
    // uncritically compounds its mistakes as readily as its knowledge. Only
    // tool-using runs are remembered, so the claim rests on something the
    // platform actually did rather than on fluent text. Only unrefused ones —
    // a guardrail trip is the opposite of a fact worth keeping. And the memory
    // is bound to the purpose that produced it and nothing else, so widening
    // its reach is a deliberate edit rather than a side effect.
    if (!refused && askedFor.length && input.subjectRef) {
      await remember(ctx, {
        subjectRef: input.subjectRef,
        kind: `${agent.module}.run_conclusion`,
        content: { text: final.text.slice(0, 2000), tools: askedFor.map((t) => t.name) },
        provenance: `ai_run:${runId}`,
        purposes: [input.purpose],
        // Ninety days: long enough to be worth having, short enough that a
        // stale conclusion about a customer expires on its own rather than
        // waiting for someone to notice it.
        expiry: ctx.now + 90 * 24 * 60 * 60 * 1000
      });
    }

    return c.json(
      {
        runId,
        text: final.text,
        // Every tool the run asked for across every round, not only the first
        // round's — the response used to report `first.toolCalls` because that
        // was all a two-call path could have.
        toolCalls: askedFor,
        model: final.model,
        provider: final.provider,
        tier: final.tier,
        flags: final.flags,
        finishReason: final.finishReason,
        auditId: final.auditId,
        usage
      },
      201
    );
  } catch (err) {
    await ctx.db
      .update(schema.aiRuns)
      .set({
        state: "failed",
        errorCode: err instanceof Error ? err.message.slice(0, 120) : "error",
        endedAt: ctx.now
      })
      .where(and(eq(schema.aiRuns.tenantId, ctx.tenantId), eq(schema.aiRuns.id, runId)));
    throw err;
  }
});

/**
 * Explainability: the run, its model call and the guardrails that fired.
 *
 * Mounted at `/detail`, not at `/runs/:id`. Hand-written routes register before
 * the generated CRUD, so an enriched handler on the bare `:id` path shadows the
 * record endpoint every generic surface reads (record.tsx expects a flat row and
 * renders blank against a wrapper). The wrapper is a second view, so it gets a
 * second path.
 */
aiRoutes.get("/runs/:id/detail", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:runs:read", { tenantId: ctx.tenantId, module: "ai" });
  const run = await must(ctx, schema.aiRuns, c.req.param("id"), "ai run");

  const calls = await ctx.db
    .select()
    .from(schema.aiToolCalls)
    .where(and(eq(schema.aiToolCalls.tenantId, ctx.tenantId), eq(schema.aiToolCalls.runId, run.id)))
    .orderBy(schema.aiToolCalls.seq);

  const trail = run.outputRef
    ? (
        await ctx.db
          .select()
          .from(schema.aiAuditLog)
          .where(and(eq(schema.aiAuditLog.tenantId, ctx.tenantId), eq(schema.aiAuditLog.id, run.outputRef)))
          .limit(1)
      )[0]
    : undefined;

  // The audit row holds hashes, not content (docs/12 §7) — an explainability
  // view proves what happened without becoming a second copy of the prompt.
  return c.json({ run, toolCalls: calls, audit: trail ?? null });
});

/* -------------------------------------------------------------- suggestions */

/**
 * The feedback loop behind the ambient grammar (docs/15 §4): a suggestion that
 * is never accepted is a suggestion that should stop being shown.
 */
aiRoutes.post("/suggestions", async (c) => {
  const ctx = ctxOf(c);
  // Suggestion rows are the evidence behind "does this surface earn its place"
  // and behind /suggestions/acceptance. Ungated, any session in the tenant could
  // manufacture that evidence. Same permission the CRUD resource uses for the
  // suggestions table (resources.ts), so there is one answer per actor.
  require_(ctx.actor, "ai:suggestions:read", { tenantId: ctx.tenantId, module: "ai" });
  const input = await body(
    c,
    z.object({
      surface: z.enum(["ghost_text", "chip", "draft", "forecast", "filter"]),
      module: z.string().min(1).max(32),
      runId: z.string().optional(),
      subjectRef: z.string().optional(),
      contentRef: z.string().optional()
    })
  );
  const row = {
    id: newId("sug", ctx.now),
    tenantId: ctx.tenantId,
    userId: ctx.actor.id,
    outcome: "shown",
    shownAt: ctx.now,
    ...input,
    runId: input.runId ?? null,
    subjectRef: input.subjectRef ?? null,
    contentRef: input.contentRef ?? null
  };
  await ctx.db.insert(schema.aiSuggestions).values(row);
  return c.json(row, 201);
});

aiRoutes.post("/suggestions/:id/outcome", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:suggestions:read", { tenantId: ctx.tenantId, module: "ai" });
  const input = await body(
    c,
    z.object({
      outcome: z.enum(["accepted", "edited", "dismissed", "expired"]),
      editDistance: z.number().int().min(0).optional()
    })
  );
  await ctx.db
    .update(schema.aiSuggestions)
    .set({
      outcome: input.outcome,
      resolvedAt: ctx.now,
      ...(input.editDistance !== undefined ? { editDistance: input.editDistance } : {})
    })
    .where(
      and(
        eq(schema.aiSuggestions.tenantId, ctx.tenantId),
        eq(schema.aiSuggestions.id, c.req.param("id")),
        eq(schema.aiSuggestions.userId, ctx.actor.id)
      )
    );
  return c.body(null, 204);
});

/** Acceptance rate per surface — the number that decides whether a surface stays. */
aiRoutes.get("/suggestions/acceptance", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:runs:read", { tenantId: ctx.tenantId, module: "ai" });
  const sinceDays = intParam(c.req.query("days"), 30, { max: 3650 });
  const rows = await ctx.db
    .select({
      surface: schema.aiSuggestions.surface,
      module: schema.aiSuggestions.module,
      outcome: schema.aiSuggestions.outcome
    })
    .from(schema.aiSuggestions)
    .where(
      and(
        eq(schema.aiSuggestions.tenantId, ctx.tenantId),
        gte(schema.aiSuggestions.shownAt, ctx.now - sinceDays * 86_400_000)
      )
    );

  const by = new Map<string, { surface: string; module: string; shown: number; accepted: number; edited: number; dismissed: number }>();
  for (const r of rows) {
    const key = `${r.module}/${r.surface}`;
    const agg = by.get(key) ?? { surface: r.surface, module: r.module, shown: 0, accepted: 0, edited: 0, dismissed: 0 };
    agg.shown += 1;
    if (r.outcome === "accepted") agg.accepted += 1;
    if (r.outcome === "edited") agg.edited += 1;
    if (r.outcome === "dismissed") agg.dismissed += 1;
    by.set(key, agg);
  }
  return c.json({
    data: [...by.values()].map((a) => ({
      ...a,
      // An edit counts as a hit: the user kept the shape and changed the words.
      acceptanceRate: a.shown ? Math.round(((a.accepted + a.edited) / a.shown) * 100) : 0
    }))
  });
});

/* ------------------------------------------------------------------ budget */

aiRoutes.get("/budget", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:budgets:read", { tenantId: ctx.tenantId, module: "ai" });
  return c.json(await checkBudget(ctx, c.req.query("module") ?? "*"));
});

aiRoutes.post("/budget/limits", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:budgets:write", { tenantId: ctx.tenantId, module: "ai" });
  const input = await body(
    c,
    z.object({
      module: z.string().default("*"),
      tokensLimit: z.number().int().nonnegative().optional(),
      costMicroLimit: z.number().int().nonnegative().optional()
    })
  );
  // Raising a budget spends real money, so it goes through the same gate as
  // any other spending decision.
  await gate(ctx, {
    policyKey: "ai.budget_raise",
    subjectRef: `ai_budget:${input.module}`,
    ...(input.costMicroLimit !== undefined ? { amountMinor: Math.round(input.costMicroLimit / 10_000) } : {}),
    context: input
  });
  const { module, ...limits } = input;
  return c.json(await setLimits(ctx, limits, module));
});

/* ------------------------------------------------------------ kill switches */

// docs/12 §4: "Kill switches: per-agent, per-module, per-tenant, global — all
// one click, all logged, all tested monthly." Per-agent is the agent row below.
// The tenant and module tiers are set here and enforced in the gateway
// (packages/model-gateway/src/kill.ts), so a pause covers every caller — runs,
// rooms, engines, schedulers — not only the routes in this file. The global
// tier is ops-held in core_feature_flags and is read here so a tenant admin
// staring at a dead assistant can see it is not theirs to release.

async function globalKill(ctx: Ctx): Promise<boolean> {
  const [row] = await ctx.db
    .select()
    .from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, AI_KILL_SWITCH))
    .limit(1);
  return row ? flagEnabled(row, ctx.tenantId) : false;
}

aiRoutes.get("/kill-switches", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:agents:read", { tenantId: ctx.tenantId, module: "ai" });
  return c.json({
    global: await globalKill(ctx),
    tenant: ctx.policy.aiPaused,
    modules: ctx.policy.aiPausedModules
  });
});

async function setAiPaused(c: Context<App>, paused: boolean) {
  const ctx = ctxOf(c);
  // Same split as the per-agent switch: `ai:killswitch:use` is what compliance
  // holds so it can stop AI mid-incident, `ai:agents:write` is what it takes to
  // turn it back on — the party that pauses is not automatically the party that
  // decides the incident is over.
  require_(ctx.actor, paused ? "ai:killswitch:use" : "ai:agents:write", {
    tenantId: ctx.tenantId,
    module: "ai"
  });
  const input = await body(
    c,
    z.object({
      module: z.enum(MODULES).optional(),
      // A pause with no reason is an outage nobody can explain a week later.
      reason: paused ? z.string().min(3).max(500) : z.string().max(500).optional()
    })
  );

  const [row] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  if (!row) throw notFound("tenant");
  const before = parseJson(PolicyJson, row.policyJson);
  const modules = new Set(before.aiPausedModules);
  if (input.module) modules[paused ? "add" : "delete"](input.module);
  const after = input.module
    ? { ...before, aiPausedModules: [...modules] }
    : { ...before, aiPaused: paused };

  await ctx.db
    .update(schema.tenants)
    .set({ policyJson: toJson(PolicyJson, after), updatedAt: ctx.now })
    .where(eq(schema.tenants.id, ctx.tenantId));

  await audit(ctx, {
    action: `ai.${input.module ? "module" : "tenant"}.${paused ? "paused" : "resumed"}`,
    subjectRef: input.module ?? `tenants:${ctx.tenantId}`,
    before: { aiPaused: before.aiPaused, aiPausedModules: before.aiPausedModules },
    after: { aiPaused: after.aiPaused, aiPausedModules: after.aiPausedModules, reason: input.reason }
  });
  return c.body(null, 204);
}

aiRoutes.post("/pause", (c) => setAiPaused(c, true));
aiRoutes.post("/resume", (c) => setAiPaused(c, false));

/* ------------------------------------------------------------------- agents */

/** The kill switch. One row, immediate, audited — docs/15 §7 requires it reachable. */
aiRoutes.post("/agents/:key/pause", async (c) => {
  const ctx = ctxOf(c);
  // Stopping an agent is the killswitch, not an edit: compliance holds
  // `ai:agents:pause` precisely so they can pull it mid-incident without also
  // holding the write permission that would let them reconfigure the agent.
  require_(ctx.actor, "ai:agents:pause", { tenantId: ctx.tenantId, module: "ai" });
  const input = await body(c, z.object({ reason: z.string().min(3).max(500) }));
  const agent = await agentByKey(ctx, c.req.param("key"));
  await ctx.db
    .update(schema.aiAgents)
    .set({ status: "paused", pausedBy: actorRef(ctx), pausedReason: input.reason, updatedAt: ctx.now })
    .where(and(eq(schema.aiAgents.tenantId, ctx.tenantId), eq(schema.aiAgents.id, agent.id)));
  await audit(ctx, { action: "ai.agent.pause", subjectRef: agent.id, before: agent, after: input });
  return c.body(null, 204);
});

aiRoutes.post("/agents/:key/resume", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:agents:write", { tenantId: ctx.tenantId, module: "ai" });
  const agent = await agentByKey(ctx, c.req.param("key"));
  await ctx.db
    .update(schema.aiAgents)
    .set({ status: "active", pausedBy: null, pausedReason: null, updatedAt: ctx.now })
    .where(and(eq(schema.aiAgents.tenantId, ctx.tenantId), eq(schema.aiAgents.id, agent.id)));
  await audit(ctx, { action: "ai.agent.resume", subjectRef: agent.id, before: agent });
  return c.body(null, 204);
});

/**
 * Raising an agent's autonomy is the one AI change that can never be
 * self-service: it widens what the agent may do without asking (docs/15 §3).
 */
aiRoutes.post("/agents/:key/autonomy", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:agents:write", { tenantId: ctx.tenantId, module: "ai" });
  const input = await body(
    c,
    z.object({
      autonomyLevel: AgentAutonomy,
      reason: z.string().min(3).max(500)
    })
  );
  const agent = await agentByKey(ctx, c.req.param("key"));
  const approval = await gate(ctx, {
    policyKey: "ai.autonomy_raise",
    subjectRef: agent.id,
    context: { from: agent.autonomyLevel, to: input.autonomyLevel, reason: input.reason }
  });
  if (approval && approval.decision !== "approved") return c.json({ approval }, 202);

  await ctx.db
    .update(schema.aiAgents)
    .set({ autonomyLevel: input.autonomyLevel, updatedAt: ctx.now })
    .where(and(eq(schema.aiAgents.tenantId, ctx.tenantId), eq(schema.aiAgents.id, agent.id)));
  await audit(ctx, { action: "ai.agent.autonomy", subjectRef: agent.id, before: agent, after: input });
  return c.json({ ...agent, autonomyLevel: input.autonomyLevel });
});

/* -------------------------------------------------------------------- audit */

/** The AI audit trail, filterable. Hashes only — the content never lands here. */
aiRoutes.get("/audit", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:audit:read", { tenantId: ctx.tenantId, module: "ai" });
  const module = c.req.query("module");
  // Not `instantParam`: this endpoint's contract is that garbage falls back to
  // the default rather than 400 (see ai.test.ts "numeric query params survive
  // garbage input"). What it was missing is the ceiling — `intParam` clamps to
  // MAX_SAFE_INTEGER by default, which is past any instant a `Date` holds.
  const since = intParam(c.req.query("since"), ctx.now - 7 * 86_400_000, { max: MAX_INSTANT_MS });
  const rows = await ctx.db
    .select()
    .from(schema.aiAuditLog)
    .where(
      and(
        eq(schema.aiAuditLog.tenantId, ctx.tenantId),
        gte(schema.aiAuditLog.ts, since),
        ...(module ? [eq(schema.aiAuditLog.module, module)] : [])
      )
    )
    .orderBy(desc(schema.aiAuditLog.ts))
    .limit(intParam(c.req.query("limit"), 100, { min: 1, max: 500 }));
  return c.json({ data: rows });
});

/** Spend by module and purpose — what the BudgetMeter drills into. */
aiRoutes.get("/audit/spend", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:budgets:read", { tenantId: ctx.tenantId, module: "ai" });
  const since = ctx.now - intParam(c.req.query("days"), 30, { max: 3650 }) * 86_400_000;
  const rows = await ctx.db
    .select({
      module: schema.aiAuditLog.module,
      purpose: schema.aiAuditLog.purpose,
      model: schema.aiAuditLog.model,
      tokensIn: schema.aiAuditLog.tokensIn,
      tokensOut: schema.aiAuditLog.tokensOut,
      costMicro: schema.aiAuditLog.costMicro,
      outcome: schema.aiAuditLog.outcome
    })
    .from(schema.aiAuditLog)
    .where(and(eq(schema.aiAuditLog.tenantId, ctx.tenantId), gte(schema.aiAuditLog.ts, since)));

  const by = new Map<string, { module: string; purpose: string; calls: number; tokens: number; costMicro: number; errors: number }>();
  for (const r of rows) {
    const key = `${r.module}/${r.purpose}`;
    const agg = by.get(key) ?? { module: r.module, purpose: r.purpose, calls: 0, tokens: 0, costMicro: 0, errors: 0 };
    agg.calls += 1;
    agg.tokens += r.tokensIn + r.tokensOut;
    agg.costMicro += r.costMicro;
    if (r.outcome !== "ok") agg.errors += 1;
    by.set(key, agg);
  }
  const data = [...by.values()].sort((a, b) => b.costMicro - a.costMicro);
  return c.json({ data, totals: data.reduce((t, r) => ({ calls: t.calls + r.calls, tokens: t.tokens + r.tokens, costMicro: t.costMicro + r.costMicro }), { calls: 0, tokens: 0, costMicro: 0 }) });
});

/* ------------------------------------------------------------ command center */

/**
 * ADR-0073. The command loop's front door. Runs the bounded multi-round agent
 * over the unified registry; consequential tools become proposals, never
 * executions. The run row is written here (state machine identical to
 * /runs), the loop only computes.
 */
const CommandBody = z.object({
  agentKey: z.string().min(1).max(64),
  purpose: z.string().min(1).max(64),
  subjectRef: z.string().max(200).optional(),
  locale: z.enum(["en", "ar"]).optional(),
  input: z.string().min(1).max(20_000)
});

aiRoutes.post("/command/runs", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, CommandBody);
  const agent = await agentByKey(ctx, input.agentKey);
  require_(ctx.actor, `${agent.module}:ai:invoke`, { tenantId: ctx.tenantId, module: agent.module });
  if (agent.status !== "active") throw badRequest(`agent ${agent.key} is ${agent.status}`);
  // The loop is cross-module, so the purpose carries the agent's own module
  // prefix (`axis.command.center` for an axis agent) — the (module, purpose)
  // pair stays exact per the F40 rule.
  const purpose = input.purpose.endsWith(".command.center")
    ? input.purpose
    : `${agent.module}.command.center`;
  if (!isKnownPurpose(agent.module, purpose))
    throw badRequest(`purpose ${purpose} is not registered for module ${agent.module}`);

  const started = ctx.now;
  return commandRun(c, ctx, agent, { ...input, purpose }, started);
});

async function commandRun(
  c: Context<App>,
  ctx: Ctx,
  agent: { key: string; module: string; tier: string; toolsJson: string | null; autonomyLevel: string },
  input: { agentKey: string; purpose: string; subjectRef?: string | undefined; locale?: "en" | "ar" | undefined; input: string },
  started: number
) {
  try {
    const result = await runCommandLoop(ctx, c.get("gateway"), c.env, agent, {
      agentKey: input.agentKey,
      purpose: input.purpose,
      ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      input: input.input
    });

    await ctx.db.insert(schema.aiRuns).values({
      id: result.runId,
      tenantId: ctx.tenantId,
      agentKey: agent.key,
      module: agent.module,
      purpose: input.purpose,
      subjectRef: input.subjectRef ?? null,
      actorRef: actorRef(ctx),
      autonomyLevel: agent.autonomyLevel,
      trigger: "user",
      state: "succeeded",
      inputHash: result.auditId,
      outputRef: result.auditId,
      evidenceJson: JSON.stringify({ rounds: result.rounds, proposals: result.proposalIds }),
      tokensIn: result.usage.tokensIn,
      tokensOut: result.usage.tokensOut,
      costMicro: result.usage.costMicro,
      latencyMs: ctx.now - started,
      startedAt: started,
      endedAt: ctx.now
    });
    await audit(ctx, {
      action: "ai.command.run",
      subjectRef: result.runId,
      after: { rounds: result.rounds.length, proposals: result.proposalIds.length }
    });
    return c.json(result, 201);
  } catch (err) {
    await audit(ctx, {
      action: "ai.command.run_failed",
      subjectRef: input.agentKey,
      after: { error: err instanceof Error ? err.message.slice(0, 200) : "error" }
    });
    throw err;
  }
}

/** Pending proposals for the surface feed. */
aiRoutes.get("/command/proposals", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:command:read", { tenantId: ctx.tenantId, module: "ai" });
  const state = c.req.query("state") ?? "proposed";
  const rows = await ctx.db
    .select()
    .from(schema.aiCommandProposals)
    .where(and(eq(schema.aiCommandProposals.tenantId, ctx.tenantId), eq(schema.aiCommandProposals.state, state)))
    .orderBy(desc(schema.aiCommandProposals.createdAt))
    .limit(100);
  return c.json({ data: rows });
});

/** Dismiss a proposal — an explicit human decision, audited as such. */
aiRoutes.post("/command/proposals/:id/dismiss", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "ai:command:read", { tenantId: ctx.tenantId, module: "ai" });
  const id = c.req.param("id");
  const row = (
    await ctx.db
      .select()
      .from(schema.aiCommandProposals)
      .where(and(eq(schema.aiCommandProposals.tenantId, ctx.tenantId), eq(schema.aiCommandProposals.id, id)))
      .limit(1)
  )[0];
  if (!row) throw notFound("proposal");
  if (row.state !== "proposed") throw conflict(`proposal is ${row.state}`);
  await ctx.db
    .update(schema.aiCommandProposals)
    .set({ state: "dismissed", decidedBy: actorRef(ctx), decidedAt: ctx.now })
    .where(and(eq(schema.aiCommandProposals.tenantId, ctx.tenantId), eq(schema.aiCommandProposals.id, id)));
  await audit(ctx, { action: "ai.command.proposal_dismissed", subjectRef: id, before: { state: row.state }, after: { state: "dismissed" } });
  return c.body(null, 204);
});

/**
 * Action a proposal: execute it through the module's real engine function, so
 * the approval gate fires exactly once for an agent-raised and a desk-raised
 * change alike (the orbit-tools lesson — one execution path per action, never
 * a second one). The permission checked is the underlying module's, not
 * ai:command:read: acting on an endorsement is endorsing.
 */
aiRoutes.post("/command/proposals/:id/action", async (c) => {
  const ctx = ctxOf(c);
  const id = c.req.param("id");
  const row = (
    await ctx.db
      .select()
      .from(schema.aiCommandProposals)
      .where(and(eq(schema.aiCommandProposals.tenantId, ctx.tenantId), eq(schema.aiCommandProposals.id, id)))
      .limit(1)
  )[0];
  if (!row) throw notFound("proposal");
  if (row.state !== "proposed") throw conflict(`proposal is ${row.state}`);

  let result: unknown;
  switch (row.toolName) {
    case "create_endorsement_request": {
      // Same engine the desk route calls; axis.endorse gate fires inside.
      const { endorsePolicy } = await import("../engines/axis-endorse.js");
      const args = JSON.parse(row.argsJson) as { policyId?: string } & Record<string, unknown>;
      const policy = await must(ctx, schema.axisPolicies, args.policyId ?? row.subjectRef ?? "", "policies");
      require_(ctx.actor, "axis:policies:endorse", { tenantId: ctx.tenantId, module: "axis" });
      result = await endorsePolicy(ctx, policy, {
        changes: (args.changes ?? {}) as Record<string, never>,
        reason: typeof args.reason === "string" ? args.reason : null,
        ...(typeof args.premiumMinor === "number" ? { premiumMinor: args.premiumMinor } : {}),
        ...(typeof args.effectiveFrom === "number" ? { effectiveFrom: args.effectiveFrom } : {})
      });
      break;
    }
    default:
      throw badRequest(`no action path for tool ${row.toolName}`);
  }
  // The gate's own 403 (approval_required) is a *good* outcome here: the
  // proposal stays proposed and the surface links to the pending approval.

  await ctx.db
    .update(schema.aiCommandProposals)
    .set({ state: "actioned", decidedBy: actorRef(ctx), decidedAt: ctx.now })
    .where(and(eq(schema.aiCommandProposals.tenantId, ctx.tenantId), eq(schema.aiCommandProposals.id, id)));
  await audit(ctx, { action: "ai.command.proposal_actioned", subjectRef: id, before: { state: row.state }, after: { state: "actioned" } });
  return c.json({ ok: true, result }, 200);
});

import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  audit,
  badRequest,
  conflict,
  currentConsent,
  emit,
  inQuietHours,
  nextOpenAt,
  type Ctx,
  type Envelope
} from "@lyra/core";
import { must } from "../rows.js";
import { routeConversation } from "./orbit-routing.js";

// docs/05 §Journeys — "consent & quiet-hours & frequency caps baked in as
// unremovable floors", across every journey kind (welcome, doc-chase, renewal,
// win-back, NPS, dunning), not just marketing sends. This is the writer that
// was missing entirely: `orbitJourneys`/`orbitJourneyRuns` had CRUD and
// nothing that ever walked a graph.

interface JourneyNode {
  key: string;
  type: string;
  [k: string]: unknown;
}

interface JourneyEdge {
  from: string;
  to: string;
}

interface JourneyGraph {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  /**
   * Not a schema column: `orbit_journeys.graph_json` is freeform (docs/16
   * seam), so the cooldown floor lives inside it rather than forcing a
   * migration for one integer. Absent/0 = no cap.
   */
  cooldownDays?: number;
}

const DAY_MS = 86_400_000;

function parseGraph(raw: string): JourneyGraph {
  const g = JSON.parse(raw) as JourneyGraph;
  return {
    nodes: g.nodes ?? [],
    edges: g.edges ?? [],
    ...(g.cooldownDays === undefined ? {} : { cooldownDays: g.cooldownDays })
  };
}

/** The node a fresh run starts on: whatever the `trigger` node points to, or the first node if the graph has no edges. */
function startNode(graph: JourneyGraph): string {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (trigger) {
    const edge = graph.edges.find((e) => e.from === trigger.key);
    if (edge) return edge.to;
  }
  return graph.nodes[0]?.key ?? "start";
}

export interface TriggerJourneyResult {
  /** Customers a run was created or restarted for. */
  triggered: string[];
  /** Customers skipped: consent for marketing was explicitly withdrawn. */
  skippedConsent: string[];
  /** Customers skipped: an existing run is still inside the journey's cooldown window. */
  skippedCooldown: string[];
}

/**
 * Consent floor: reuses `currentConsent` from packages/core (not SIGNAL's
 * suppression-audience, which is a marketing-campaign construct and would be
 * a cross-module import outside `packages/core` — CLAUDE.md rule 6). A
 * customer with no consent row yet is not "withdrawn" — only an explicit
 * `purposes.marketing === false` is, matching the same convention
 * `signal-suppression.ts#onConsentUpdated` already uses for the same signal.
 */
async function consentWithdrawn(ctx: Ctx, customerId: string): Promise<boolean> {
  const state = await currentConsent(ctx, customerId);
  return state?.purposes.marketing === false;
}

/**
 * Given a journey and a cohort of customer ids, create (or, once the cooldown
 * has elapsed, restart) one `orbit_journey_runs` row per eligible customer.
 * The unique `(tenantId, journeyId, customerId)` index means there is
 * structurally never more than one row per pair; the cooldown decides whether
 * a second trigger inside the window is a no-op or a restart.
 */
export async function triggerJourney(
  ctx: Ctx,
  journeyId: string,
  customerIds: readonly string[]
): Promise<TriggerJourneyResult> {
  const journey = await must(ctx, schema.orbitJourneys, journeyId, "journey");
  if (journey.status !== "active") throw conflict(`journey is ${journey.status}, not active`);

  const graph = parseGraph(journey.graphJson);
  const node = startNode(graph);
  // ORB-051: frequency caps are an "unremovable floor", not an opt-in — an
  // active journey with no cooldownDays would silently mean "no cap" instead
  // of forcing the author to set one. The actual number stays theirs to pick;
  // what's non-negotiable is that there has to be one.
  if (!graph.cooldownDays || graph.cooldownDays <= 0) {
    throw badRequest("journey graph.cooldownDays must be a positive number of days — frequency caps are an unremovable floor (docs/17 ORB-051)");
  }
  const cooldownMs = graph.cooldownDays * DAY_MS;

  const triggered: string[] = [];
  const skippedConsent: string[] = [];
  const skippedCooldown: string[] = [];

  for (const customerId of customerIds) {
    if (await consentWithdrawn(ctx, customerId)) {
      skippedConsent.push(customerId);
      continue;
    }

    const [existing] = await ctx.db
      .select()
      .from(schema.orbitJourneyRuns)
      .where(
        and(
          eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId),
          eq(schema.orbitJourneyRuns.journeyId, journeyId),
          eq(schema.orbitJourneyRuns.customerId, customerId)
        )
      );

    if (existing) {
      if (cooldownMs > 0 && ctx.now - existing.updatedAt < cooldownMs) {
        skippedCooldown.push(customerId);
        continue;
      }
      await ctx.db
        .update(schema.orbitJourneyRuns)
        .set({ node, state: "running", contextJson: null, nextAt: null, updatedAt: ctx.now })
        .where(eq(schema.orbitJourneyRuns.id, existing.id));
    } else {
      await ctx.db.insert(schema.orbitJourneyRuns).values({
        id: newId("jrun", ctx.now),
        tenantId: ctx.tenantId,
        journeyId,
        customerId,
        node,
        state: "running",
        contextJson: null,
        nextAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now
      });
    }
    triggered.push(customerId);
  }

  if (triggered.length) {
    await audit(ctx, {
      action: "orbit.journey.triggered",
      subjectRef: journeyId,
      after: { triggered: triggered.length, skippedConsent: skippedConsent.length, skippedCooldown: skippedCooldown.length }
    });
    await emit(ctx, {
      module: "orbit",
      type: "orbit.journey.triggered",
      subject: journeyId,
      data: { journeyId, customerIds: triggered }
    });
  }

  return { triggered, skippedConsent, skippedCooldown };
}

/* ------------------------------------------------------------------ advance */

// docs/27 F30. `triggerJourney` above parked a run on `startNode()` and nothing
// ever moved it: `wait`, `send`, `branch` and `task` were four documented node
// types with no executor, and `orbit_journey_runs.state`/`nextAt` were columns
// only the trigger ever wrote. This is the step that walks them.
//
// The graph vocabulary, in one place because a journey author has nowhere else
// to read it:
//
//   { key, type: "trigger", on: "<event type>" }   entry; `on` is what
//                                                  onJourneyEvent matches
//   { key, type: "wait",   minutes | hours | days } park until elapsed
//   { key, type: "send",   channel?, templateKey, body? } one transcript turn
//   { key, type: "branch", on: "attribute"|"context", attribute|contextKey, equals }
//   { key, type: "task",   title, skills?, slaPolicyKey?, intent? } human work
//   { key, type: "end" }                            terminal
//
// Edges are `{ from, to, when? }`. A branch node takes the edge whose `when` is
// `"true"`/`"false"` for its own result, falling back to an unlabelled edge.

/** Ceiling on node transitions for one run in one tick. A graph that cycles halts rather than spinning the sweep. */
const MAX_STEPS = 25;

/** How often a run parked on a `task` node re-checks whether the human closed it. */
const TASK_POLL_MS = 60 * 60_000;

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Customer columns a `branch` node may read. An allowlist, not a lookup by name: a graph must not be able to name `nationalIdHash`. */
const BRANCH_ATTRIBUTES = ["locale", "country", "kycStatus", "type"] as const;
type BranchAttribute = (typeof BRANCH_ATTRIBUTES)[number];

/** What a run carries between ticks. Every key is written by the executor, never by an author. */
interface RunContext {
  /** The wait node this run is parked on, so a second visit knows the wait elapsed. */
  waitFrom?: string;
  /** The task node this run is parked on, and the queued conversation it waits to see closed. */
  taskNode?: string;
  taskConversationId?: string;
  /** The conversation `send` nodes write their turns to; one per run. */
  conversationId?: string;
  /** Why a halted run halted. Shown on the journey-runs tab; never cleared. */
  haltReason?: string;
  [k: string]: unknown;
}

export interface AdvanceResult {
  /** Runs this tick picked up and moved. */
  advanced: number;
  sent: number;
  tasks: number;
  waiting: number;
  completed: number;
  halted: number;
  deferredQuietHours: number;
}

function waitMs(node: JourneyNode): number {
  const minutes = typeof node.minutes === "number" ? node.minutes : 0;
  const hours = typeof node.hours === "number" ? node.hours : 0;
  const days = typeof node.days === "number" ? node.days : 0;
  return minutes * MINUTE_MS + hours * HOUR_MS + days * DAY_MS;
}

/** The edge out of `key`, preferring the one labelled for a branch result. */
function nextNode(graph: JourneyGraph, key: string, when?: "true" | "false"): string | null {
  const out = graph.edges.filter((e) => e.from === key);
  if (when) {
    const labelled = out.find((e) => (e as { when?: string }).when === when);
    if (labelled) return labelled.to;
  }
  const plain = out.find((e) => (e as { when?: string }).when === undefined);
  return plain?.to ?? null;
}

type CustomerRow = typeof schema.customers.$inferSelect;

function branchResult(node: JourneyNode, customer: CustomerRow | undefined, context: RunContext): boolean {
  const expected = node.equals;
  if (node.on === "context") {
    const key = typeof node.contextKey === "string" ? node.contextKey : "";
    return String(context[key] ?? "") === String(expected ?? "");
  }
  const attribute = typeof node.attribute === "string" ? node.attribute : "";
  if (!BRANCH_ATTRIBUTES.includes(attribute as BranchAttribute)) return false;
  const actual = customer ? customer[attribute as BranchAttribute] : undefined;
  return String(actual ?? "") === String(expected ?? "");
}

/**
 * Walk every run that is due, one graph step at a time, stopping at the first
 * node that has to wait for the world (a timer, a human, the end of quiet
 * hours). Called from the cron tick and from `POST /v1/orbit/journeys/sweep`.
 *
 * The floors docs/05 §Journeys calls unremovable are enforced here rather than
 * left to the author's graph: consent is re-checked at every send (a customer
 * who withdraws after being enrolled halts, they do not receive the rest of the
 * sequence) and quiet hours defer a send rather than dropping it. The frequency
 * cap is `triggerJourney`'s cooldown above.
 */
export async function advanceJourneyRuns(ctx: Ctx, limit = 200): Promise<AdvanceResult> {
  const result: AdvanceResult = {
    advanced: 0,
    sent: 0,
    tasks: 0,
    waiting: 0,
    completed: 0,
    halted: 0,
    deferredQuietHours: 0
  };

  const due = await ctx.db
    .select()
    .from(schema.orbitJourneyRuns)
    .where(
      and(
        eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId),
        inArray(schema.orbitJourneyRuns.state, ["running", "waiting"]),
        or(isNull(schema.orbitJourneyRuns.nextAt), lte(schema.orbitJourneyRuns.nextAt, ctx.now))
      )
    )
    // Oldest first, capped: a processed run either leaves the set (done/halted)
    // or gets a `nextAt` in the future, so the remainder is the next tick's
    // head of queue rather than starved work (ADR-0050).
    .orderBy(asc(schema.orbitJourneyRuns.updatedAt))
    .limit(limit);
  if (!due.length) return result;

  const graphs = new Map<string, JourneyGraph>();

  for (const runRow of due) {
    let graph = graphs.get(runRow.journeyId);
    if (!graph) {
      const [journey] = await ctx.db
        .select()
        .from(schema.orbitJourneys)
        .where(and(eq(schema.orbitJourneys.tenantId, ctx.tenantId), eq(schema.orbitJourneys.id, runRow.journeyId)));
      // A run whose journey was deleted underneath it halts rather than being
      // retried forever: there is no graph to read and no author to ask.
      if (!journey) {
        await halt(ctx, runRow.id, {}, "journey_missing");
        result.advanced++;
        result.halted++;
        continue;
      }
      graph = parseGraph(journey.graphJson);
      graphs.set(runRow.journeyId, graph);
    }

    const [customer] = await ctx.db
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, ctx.tenantId), eq(schema.customers.id, runRow.customerId)));

    const context: RunContext = runRow.contextJson ? (JSON.parse(runRow.contextJson) as RunContext) : {};
    let node = runRow.node;
    let steps = 0;

    for (;;) {
      if (steps++ >= MAX_STEPS) {
        await halt(ctx, runRow.id, context, "step_limit");
        result.halted++;
        break;
      }

      const current = graph.nodes.find((n) => n.key === node);
      if (!current) {
        await halt(ctx, runRow.id, context, "node_missing");
        result.halted++;
        break;
      }

      if (current.type === "trigger" || current.type === "branch") {
        const when = current.type === "branch" ? (branchResult(current, customer, context) ? "true" : "false") : undefined;
        const to = nextNode(graph, node, when);
        if (!to) {
          await finish(ctx, runRow.id, context, node);
          result.completed++;
          break;
        }
        node = to;
        continue;
      }

      if (current.type === "end") {
        await finish(ctx, runRow.id, context, node);
        result.completed++;
        break;
      }

      if (current.type === "wait") {
        if (context.waitFrom === node) {
          delete context.waitFrom;
          const to = nextNode(graph, node);
          if (!to) {
            await finish(ctx, runRow.id, context, node);
            result.completed++;
            break;
          }
          node = to;
          continue;
        }
        context.waitFrom = node;
        await park(ctx, runRow.id, context, node, ctx.now + waitMs(current));
        result.waiting++;
        break;
      }

      if (current.type === "send" || current.type === "message") {
        if (await consentWithdrawn(ctx, runRow.customerId)) {
          await halt(ctx, runRow.id, context, "consent_withdrawn");
          result.halted++;
          break;
        }
        if (inQuietHours(ctx.now, ctx.policy.timezone)) {
          // Deferred, never dropped: the node stays where it is and the run
          // wakes when the window opens. SIGNAL's outreach sender skips the
          // tick instead, which it can afford because a campaign send has
          // nothing sequenced behind it; a journey does.
          await park(ctx, runRow.id, context, node, nextOpenAt(ctx.now, ctx.policy.timezone));
          result.deferredQuietHours++;
          result.waiting++;
          break;
        }
        await sendJourneyTurn(ctx, runRow, context, current, customer);
        result.sent++;
        const to = nextNode(graph, node);
        if (!to) {
          await finish(ctx, runRow.id, context, node);
          result.completed++;
          break;
        }
        node = to;
        continue;
      }

      if (current.type === "task") {
        if (context.taskNode === node) {
          const [task] = await ctx.db
            .select({ state: schema.orbitConversations.state })
            .from(schema.orbitConversations)
            .where(
              and(
                eq(schema.orbitConversations.tenantId, ctx.tenantId),
                eq(schema.orbitConversations.id, context.taskConversationId ?? "")
              )
            );
          if (task && task.state !== "closed") {
            await park(ctx, runRow.id, context, node, ctx.now + TASK_POLL_MS);
            result.waiting++;
            break;
          }
          delete context.taskNode;
          delete context.taskConversationId;
          const to = nextNode(graph, node);
          if (!to) {
            await finish(ctx, runRow.id, context, node);
            result.completed++;
            break;
          }
          node = to;
          continue;
        }
        context.taskConversationId = await raiseTask(ctx, runRow, current);
        context.taskNode = node;
        result.tasks++;
        await park(ctx, runRow.id, context, node, ctx.now + TASK_POLL_MS);
        result.waiting++;
        break;
      }

      await halt(ctx, runRow.id, context, "unknown_node_type");
      result.halted++;
      break;
    }

    result.advanced++;
  }

  return result;
}

async function park(ctx: Ctx, runId: string, context: RunContext, node: string, nextAt: number): Promise<void> {
  await ctx.db
    .update(schema.orbitJourneyRuns)
    .set({ node, state: "waiting", contextJson: JSON.stringify(context), nextAt, updatedAt: ctx.now })
    .where(and(eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId), eq(schema.orbitJourneyRuns.id, runId)));
}

async function finish(ctx: Ctx, runId: string, context: RunContext, node: string): Promise<void> {
  await ctx.db
    .update(schema.orbitJourneyRuns)
    .set({ node, state: "done", contextJson: JSON.stringify(context), nextAt: null, updatedAt: ctx.now })
    .where(and(eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId), eq(schema.orbitJourneyRuns.id, runId)));
  await emit(ctx, { module: "orbit", type: "orbit.journey.completed", subject: runId, data: { runId, node } });
}

async function halt(ctx: Ctx, runId: string, context: RunContext, reason: string): Promise<void> {
  await ctx.db
    .update(schema.orbitJourneyRuns)
    .set({ state: "halted", contextJson: JSON.stringify({ ...context, haltReason: reason }), nextAt: null, updatedAt: ctx.now })
    .where(and(eq(schema.orbitJourneyRuns.tenantId, ctx.tenantId), eq(schema.orbitJourneyRuns.id, runId)));
  await audit(ctx, { action: "orbit.journey.halted", subjectRef: runId, after: { reason } });
  await emit(ctx, { module: "orbit", type: "orbit.journey.halted", subject: runId, data: { runId, reason } });
}

type RunRow = typeof schema.orbitJourneyRuns.$inferSelect;

/**
 * One journey turn in the customer's transcript, on a conversation the run
 * owns. This writes the turn and announces it; putting the text on a wire is
 * `orbit-channel-outbound.ts`'s job, off `orbit.journey.sent` — the sweep holds
 * no connector credentials, and an outbound send is gated where that engine
 * gates it rather than a second time here (CLAUDE.md rule 4).
 */
async function sendJourneyTurn(
  ctx: Ctx,
  runRow: RunRow,
  context: RunContext,
  node: JourneyNode,
  customer: CustomerRow | undefined
): Promise<void> {
  const channel = typeof node.channel === "string" ? node.channel : "email";
  if (!context.conversationId) {
    const conversationId = newId("cnv", ctx.now);
    await ctx.db.insert(schema.orbitConversations).values({
      id: conversationId,
      tenantId: ctx.tenantId,
      customerId: runRow.customerId,
      channel,
      state: "bot",
      lang: customer?.locale === "ar" ? "ar" : "en",
      intent: "journey",
      lastMessageAt: ctx.now,
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    context.conversationId = conversationId;
  }

  const templateKey = typeof node.templateKey === "string" ? node.templateKey : node.key;
  const body = typeof node.body === "string" ? node.body : templateKey;
  const messageId = newId("msg", ctx.now);
  await ctx.db.insert(schema.orbitMessages).values({
    id: messageId,
    tenantId: ctx.tenantId,
    conversationId: context.conversationId,
    role: "agent_ai",
    modality: "text",
    content: body,
    ts: ctx.now
  });
  await ctx.db
    .update(schema.orbitConversations)
    .set({ lastMessageAt: ctx.now, updatedAt: ctx.now })
    .where(
      and(
        eq(schema.orbitConversations.tenantId, ctx.tenantId),
        eq(schema.orbitConversations.id, context.conversationId)
      )
    );

  await audit(ctx, { action: "orbit.journey.sent", subjectRef: runRow.id, after: { node: node.key, channel, templateKey } });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.journey.sent",
    subject: runRow.id,
    data: {
      runId: runRow.id,
      journeyId: runRow.journeyId,
      customerId: runRow.customerId,
      conversationId: context.conversationId,
      messageId,
      node: node.key,
      channel,
      templateKey
    }
  });
}

/**
 * A `task` node is human work, and human work in ORBIT is a queued
 * conversation — so it is raised as one and handed to `routeConversation`
 * (engines/orbit-routing.ts), the module's one router. A journey task then gets
 * the same team, skill match, SLA clock and breach escalation an inbound
 * message gets, instead of a second queue nobody watches.
 */
async function raiseTask(ctx: Ctx, runRow: RunRow, node: JourneyNode): Promise<string> {
  const conversationId = newId("cnv", ctx.now);
  const skills = Array.isArray(node.skills) ? node.skills.filter((s): s is string => typeof s === "string") : [];
  await ctx.db.insert(schema.orbitConversations).values({
    id: conversationId,
    tenantId: ctx.tenantId,
    customerId: runRow.customerId,
    channel: "agent",
    state: "human",
    summary: typeof node.title === "string" ? node.title : node.key,
    intent: typeof node.intent === "string" ? node.intent : "journey_task",
    ...(skills.length ? { requireSkillsJson: JSON.stringify(skills) } : {}),
    ...(typeof node.slaPolicyKey === "string" ? { slaPolicyKey: node.slaPolicyKey } : {}),
    queuedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  await routeConversation(ctx, conversationId);
  await emit(ctx, {
    module: "orbit",
    type: "orbit.journey.task_raised",
    subject: runRow.id,
    data: { runId: runRow.id, journeyId: runRow.journeyId, conversationId, node: node.key }
  });
  return conversationId;
}

/**
 * The event-bus half (CLAUDE.md rule 6): a journey's `trigger` node names the
 * event type it starts on, and this is what matches it. Called from the outbox
 * drain (dispatch.ts) for every event, so a journey can be authored against any
 * envelope type without a code change — an allowlist of trigger types here
 * would mean a journey authored outside it silently never fires.
 *
 * `data.customerId` is the only cohort this reads. An event that does not name
 * a customer cannot enrol one, and guessing from `subject` would enrol the
 * wrong id the first time a module's subject is not a customer.
 */
export async function onJourneyEvent(ctx: Ctx, event: Envelope): Promise<void> {
  const customerId = (event.data as { customerId?: unknown } | undefined)?.customerId;
  if (typeof customerId !== "string" || !customerId) return;

  const journeys = await ctx.db
    .select()
    .from(schema.orbitJourneys)
    .where(and(eq(schema.orbitJourneys.tenantId, ctx.tenantId), eq(schema.orbitJourneys.status, "active")));

  for (const journey of journeys) {
    let graph: JourneyGraph;
    try {
      graph = parseGraph(journey.graphJson);
    } catch {
      continue;
    }
    if (!graph.nodes.some((n) => n.type === "trigger" && n.on === event.type)) continue;
    await triggerJourney(ctx, journey.id, [customerId]);
  }
}

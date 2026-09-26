import { and, count, eq, like } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { AppError, audit, badRequest, can, conflict, emit, gate, hashObject, notFound, require_, scoped, type Actor, type Ctx, type Permission } from "@lyra/core";
import { promptInstant, verdictFor, type Message, type ToolCall, type ToolDef } from "@lyra/model-gateway";
import { isInstantKey } from "../http.js";
import { endorsePolicy } from "./axis-endorse.js";
import { FnolBody } from "./axis-fnol.js";
import { routeConversation } from "./orbit-routing.js";

// docs/15. The seam between "the model wants X" and "X actually happened":
// ORBIT's agent gets tool defs from ORBIT_TOOL_DEFS and every call the model
// makes is dispatched through runOrbitTool, never executed inline in the AI
// route. Reads are direct scoped() queries (fetch_policy, the intake half of
// start_quote); the one action that touches contractual state
// (create_endorsement_request) calls the same endorsePolicy the desk's endpoint
// calls, so the axis.endorse gate fires once for either raiser and an
// agent-raised and desk-raised change of the same change-set share one approval
// record (CLAUDE.md rule 4, design §A.3).

export const ORBIT_TOOL_DEFS: ToolDef[] = [
  {
    name: "fetch_policy",
    description: "Look up an AXIS policy by id or policy number.",
    parameters: {
      type: "object",
      properties: {
        policyId: { type: "string" },
        policyNo: { type: "string" }
      }
    },
    consequential: false
  },
  {
    name: "start_quote",
    description: "Open a new AXIS quote case (intake) for a customer.",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        productLine: { type: "string" },
        channelId: { type: "string" }
      },
      required: ["customerId"]
    },
    consequential: false
  },
  {
    name: "create_endorsement_request",
    description:
      "Request a change to an existing policy. Contractual state, so this does not take effect until the request is approved.",
    parameters: {
      type: "object",
      properties: {
        policyId: { type: "string" },
        changes: { type: "object" },
        reason: { type: "string" },
        /** New full-term premium, not the delta: the endorsement prices itself. */
        premiumMinor: { type: "number" },
        effectiveFrom: { type: "number" }
      },
      required: ["policyId", "changes"]
    },
    consequential: true
  },
  // docs/modules/orbit.md §2.1 names eight tools; these five were the registry's
  // missing half (docs/27 F31). Each one does the thing the doc says and no
  // more: `fnol_guidance` reads a script and writes nothing, `book_callback`
  // and `human_handover` put work in the human queue through the module's one
  // router, and the two that reach a customer or a price gate first.
  {
    name: "send_document",
    description:
      "Send a document to the customer, or ask them for one. Reaches the customer, so it does not happen until the send is approved.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        mode: { type: "string", enum: ["send", "collect"] },
        docType: { type: "string" },
        caseId: { type: "string" },
        note: { type: "string" }
      },
      required: ["conversationId", "mode", "docType"]
    },
    consequential: true
  },
  {
    name: "make_renewal_offer",
    description: "Offer a renewal price to the customer. Pricing, so it does not take effect until approved.",
    parameters: {
      type: "object",
      properties: {
        renewalId: { type: "string" },
        premiumMinor: { type: "number" },
        currency: { type: "string" },
        note: { type: "string" }
      },
      required: ["renewalId", "premiumMinor", "currency"]
    },
    consequential: true
  },
  {
    name: "fnol_guidance",
    description:
      "The first-notification-of-loss script for a product line: what to ask the customer, in order. Guidance only — it never decides whether anything is covered.",
    parameters: {
      type: "object",
      properties: { productLine: { type: "string" } },
      required: ["productLine"]
    },
    consequential: false
  },
  {
    name: "book_callback",
    description: "Put a callback for this customer in the human queue at a time they asked for.",
    parameters: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        requestedAt: { type: "number" },
        reason: { type: "string" },
        skills: { type: "array", items: { type: "string" } }
      },
      required: ["customerId", "requestedAt"]
    },
    consequential: false
  },
  {
    name: "human_handover",
    description:
      "Hand this conversation to a person, with a summary of what has happened and what they should pick up.",
    parameters: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        summary: { type: "string" },
        factsJson: { type: "object" },
        skills: { type: "array", items: { type: "string" } }
      },
      required: ["conversationId", "summary"]
    },
    consequential: false
  }
];

/**
 * docs/27 F38. The approval policy behind each consequential tool. This was a
 * private constant in command-loop.ts, which is half the registry it needed to
 * be: the chat loop dispatched the same tools and consulted nothing. It lives
 * beside the defs now, and both executors read it, so adding a consequential
 * tool without naming its gate fails in both loops rather than in neither.
 *
 * A non-consequential tool has no entry and needs none.
 */
export const POLICY_FOR_TOOL: Record<string, string> = {
  create_endorsement_request: "axis.endorse",
  send_document: "orbit.document_send",
  make_renewal_offer: "orbit.renewal_offer"
};

const DEFS_BY_NAME = new Map(ORBIT_TOOL_DEFS.map((d) => [d.name, d]));

/**
 * How many approval decisions this tenant has recorded. Read either side of a
 * consequential tool call, the difference answers "did this call reach a gate"
 * — which `gate()` guarantees, because every path it can take writes one of
 * these rows (`core.approval.requested` / `.consumed` / `.auto`).
 */
async function approvalAudits(ctx: Ctx): Promise<number> {
  const rows = await ctx.db
    .select({ n: count() })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), like(schema.auditLog.action, "core.approval.%")));
  return rows[0]?.n ?? 0;
}

type ToolHandler = (ctx: Ctx, args: Record<string, unknown>) => Promise<unknown>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

async function fetchPolicy(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const policyId = str(args.policyId);
  const policyNo = str(args.policyNo);
  if (!policyId && !policyNo) throw badRequest("fetch_policy needs policyId or policyNo");
  // `orbit:ai:invoke` only authorizes running the agent, not this action —
  // same permission the human-facing GET /axis/policies route requires.
  require_(ctx.actor, "axis:policies:read", { tenantId: ctx.tenantId, module: "axis" });

  const rows = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(
      scoped(
        ctx,
        schema.axisPolicies,
        policyId ? eq(schema.axisPolicies.id, policyId) : eq(schema.axisPolicies.policyNo, policyNo!)
      )
    )
    .limit(1);
  const policy = rows[0];
  if (!policy) throw notFound("policy");
  return policy;
}

async function startQuote(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const customerId = str(args.customerId);
  if (!customerId) throw badRequest("start_quote needs customerId");
  require_(ctx.actor, "axis:cases:create", { tenantId: ctx.tenantId, module: "axis" });

  // CLAUDE.md rule 6: ORBIT asks and AXIS opens the case (engines/axis-orbit-intake.ts).
  // The id is minted here so the model can name the case before AXIS has heard.
  const caseId = newId("cas", ctx.now);
  await emit(ctx, {
    module: "orbit",
    type: "orbit.quote.requested",
    subject: caseId,
    data: { caseId, customerId, productLine: str(args.productLine) ?? null, channelId: str(args.channelId) ?? null }
  });
  return { caseId, status: "requested" };
}

async function createEndorsementRequest(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const policyId = str(args.policyId);
  if (!policyId) throw badRequest("create_endorsement_request needs policyId");
  const changes = args.changes && typeof args.changes === "object" ? (args.changes as Record<string, unknown>) : undefined;
  if (!changes || Object.keys(changes).length === 0) throw badRequest("create_endorsement_request needs changes");
  // The agent endorses with the grants of the human whose session it runs in:
  // it can only change a contract for someone who may change contracts, and the
  // approval gate still fires underneath (design §A.3).
  require_(ctx.actor, "axis:policies:endorse", { tenantId: ctx.tenantId, module: "axis" });
  const reason = str(args.reason) ?? null;

  const policyRows = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(scoped(ctx, schema.axisPolicies, eq(schema.axisPolicies.id, policyId)))
    .limit(1);
  const policy = policyRows[0];
  if (!policy) throw notFound("policy");

  // One endorsement path, not two. The subject-ref hash this used to build by
  // hand now lives in the endpoint, so a desk-raised and an agent-raised change
  // of the same change-set are one approval record rather than two.
  return endorsePolicy(ctx, policy, {
    changes,
    reason,
    ...(typeof args.premiumMinor === "number" ? { premiumMinor: args.premiumMinor } : {}),
    ...(typeof args.effectiveFrom === "number" ? { effectiveFrom: args.effectiveFrom } : {})
  });
}

/** The conversation a tool was handed, scoped and asserted to exist. */
async function conversationOf(ctx: Ctx, conversationId: string) {
  const [conversation] = await ctx.db
    .select()
    .from(schema.orbitConversations)
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conversationId)))
    .limit(1);
  if (!conversation) throw notFound("conversation");
  return conversation;
}

/**
 * Send a document to the customer, or ask them for one. Both halves are one
 * tool because docs/modules/orbit.md §2.1 registers one ("document
 * send/collect"): the difference is a direction, not a capability, and the
 * approval is the same act either way.
 *
 * The transcript turn is what the customer's channel picks up
 * (orbit-channel-outbound.ts), and a `collect` additionally leaves an
 * `axis_tasks` chase row against the case — without it, "we asked for the
 * mulkiya" lives only in a message nobody queries.
 */
async function sendDocument(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const conversationId = str(args.conversationId);
  const docType = str(args.docType);
  const mode = str(args.mode);
  if (!conversationId || !docType) throw badRequest("send_document needs conversationId and docType");
  if (mode !== "send" && mode !== "collect") throw badRequest("send_document mode must be send or collect");
  require_(ctx.actor, "orbit:conversations:reply", { tenantId: ctx.tenantId, module: "orbit" });

  const conversation = await conversationOf(ctx, conversationId);
  // The gate before the write, not after: a parked approval must not leave a
  // message in the customer's transcript that nobody approved.
  await gate(ctx, {
    policyKey: "orbit.document_send",
    subjectRef: `${conversationId}:${mode}:${docType}`,
    context: { conversationId, mode, docType }
  });

  const note = str(args.note);
  await ctx.db.insert(schema.orbitMessages).values({
    id: newId("msg", ctx.now),
    tenantId: ctx.tenantId,
    conversationId,
    role: "agent_ai",
    modality: "document",
    content: JSON.stringify({ mode, docType, ...(note ? { note } : {}) }),
    ts: ctx.now
  });
  await ctx.db
    .update(schema.orbitConversations)
    .set({ lastMessageAt: ctx.now, updatedAt: ctx.now })
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conversationId)));

  // The chase task is AXIS's to raise, on hearing the event below (rule 6).
  const caseId = str(args.caseId);
  const taskId = mode === "collect" && caseId ? newId("tsk", ctx.now) : null;

  await audit(ctx, {
    action: "orbit.document.requested",
    subjectRef: conversationId,
    after: { mode, docType, caseId: caseId ?? null, taskId }
  });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.conversation.document",
    subject: conversationId,
    data: { conversationId, customerId: conversation.customerId, mode, docType, caseId: caseId ?? null, taskId }
  });
  return { conversationId, mode, docType, taskId };
}

/** Renewal states a customer has already decided; an offer against one is a 409, not an overwrite. */
const DECIDED_RENEWAL_STATES = new Set(["accepted", "lost"]);

/**
 * Put a price in front of the customer. Gated (`orbit.renewal_offer`) because
 * it is pricing — CLAUDE.md rule 4's first named example — and the decided
 * states are refused rather than overwritten, the same terminal check
 * `renewal-campaign.ts` makes before it acts.
 */
async function makeRenewalOffer(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const renewalId = str(args.renewalId);
  const premiumMinor = args.premiumMinor;
  const currency = str(args.currency);
  if (!renewalId || typeof premiumMinor !== "number" || !Number.isInteger(premiumMinor) || premiumMinor < 0) {
    throw badRequest("make_renewal_offer needs renewalId and a non-negative integer premiumMinor");
  }
  if (!currency || currency.length !== 3) throw badRequest("make_renewal_offer needs a 3-letter currency");
  require_(ctx.actor, "orbit:renewals:update", { tenantId: ctx.tenantId, module: "orbit" });

  const [renewal] = await ctx.db
    .select()
    .from(schema.orbitRenewals)
    .where(scoped(ctx, schema.orbitRenewals, eq(schema.orbitRenewals.id, renewalId)))
    .limit(1);
  if (!renewal) throw notFound("renewal");
  if (DECIDED_RENEWAL_STATES.has(renewal.state)) throw conflict(`renewal is ${renewal.state}`);

  await gate(ctx, {
    policyKey: "orbit.renewal_offer",
    subjectRef: renewalId,
    amountMinor: premiumMinor,
    context: { renewalId, premiumMinor, currency }
  });

  const requotes = { premiumMinor, currency, offeredBy: `${ctx.actor.kind}:${ctx.actor.id}`, ...(str(args.note) ? { note: str(args.note) } : {}) };
  await ctx.db
    .update(schema.orbitRenewals)
    .set({ state: "offered", offeredAt: ctx.now, requotesJson: JSON.stringify(requotes), updatedAt: ctx.now })
    .where(scoped(ctx, schema.orbitRenewals, eq(schema.orbitRenewals.id, renewalId)));

  await audit(ctx, { action: "orbit.renewal.offered", subjectRef: renewalId, before: { state: renewal.state }, after: { state: "offered", premiumMinor, currency } });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.renewal.offered",
    subject: renewalId,
    data: { renewalId, customerId: renewal.customerId, policyRef: renewal.policyRef, premiumMinor, currency }
  });
  return { renewalId, state: "offered", premiumMinor, currency };
}

/**
 * The FNOL script, guide-only: docs/modules/orbit.md §2.1 is explicit that this
 * tool "never adjudicates". So it writes nothing and it does not answer whether
 * anything is covered — `axis-fnol.ts#checkCoverage` is the only thing that
 * does, behind the desk's own permission.
 *
 * The questions are read off `FnolBody` rather than kept as a list here,
 * because a hand-kept script is a copy of a contract and copies rot: a field
 * added to the intake schema is a question the agent must now ask, and this
 * way it becomes one with no second edit.
 */
function fnolGuidance(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const productLine = str(args.productLine);
  if (!productLine) throw badRequest("fnol_guidance needs productLine");
  require_(ctx.actor, "orbit:conversations:read", { tenantId: ctx.tenantId, module: "orbit" });

  const collect = Object.entries(FnolBody.shape).map(([field, schemaField]) => ({
    field,
    required: !schemaField.safeParse(undefined).success,
    type: schemaField.def.type
  }));
  return Promise.resolve({
    productLine,
    /** Load-bearing, not decoration: the model is told in the result, not only in the tool description, that this is not an adjudication. */
    adjudicates: false,
    collect
  });
}

/**
 * A callback is human work at a time the customer chose, and human work in
 * ORBIT is a queued conversation — raised on the `voice` channel and handed to
 * `routeConversation`, the module's one router, so it gets the same team,
 * skills and SLA clock as anything else in the queue.
 */
async function bookCallback(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const customerId = str(args.customerId);
  const requestedAt = args.requestedAt;
  if (!customerId || typeof requestedAt !== "number") throw badRequest("book_callback needs customerId and requestedAt");
  require_(ctx.actor, "orbit:conversations:assign", { tenantId: ctx.tenantId, module: "orbit" });

  const skills = Array.isArray(args.skills) ? args.skills.filter((s): s is string => typeof s === "string") : [];
  const conversationId = newId("cnv", ctx.now);
  await ctx.db.insert(schema.orbitConversations).values({
    id: conversationId,
    tenantId: ctx.tenantId,
    customerId,
    channel: "voice",
    state: "human",
    intent: "callback",
    summary: str(args.reason) ?? null,
    ...(skills.length ? { requireSkillsJson: JSON.stringify(skills) } : {}),
    queuedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  const routed = await routeConversation(ctx, conversationId);

  await audit(ctx, { action: "orbit.callback.booked", subjectRef: conversationId, after: { customerId, requestedAt, ...routed } });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.callback.booked",
    subject: conversationId,
    data: { conversationId, customerId, requestedAt, ...routed }
  });
  return { conversationId, requestedAt, ...routed };
}

/**
 * Hand the conversation to a person: the state flips to `human`, the note the
 * agent wrote lands in `orbit_handover_notes` (which is what the console's
 * handover panel reads), and the conversation goes back through the router so
 * it is queued to a team rather than left on nobody's desk.
 *
 * Idempotent by design rather than by guard — handing over twice is a second
 * note and the same state, which is what a person re-escalating expects.
 */
async function humanHandover(ctx: Ctx, args: Record<string, unknown>): Promise<unknown> {
  const conversationId = str(args.conversationId);
  const summary = str(args.summary);
  if (!conversationId || !summary) throw badRequest("human_handover needs conversationId and summary");
  require_(ctx.actor, "orbit:handover:write", { tenantId: ctx.tenantId, module: "orbit" });

  const conversation = await conversationOf(ctx, conversationId);
  const skills = Array.isArray(args.skills) ? args.skills.filter((s): s is string => typeof s === "string") : [];

  await ctx.db.insert(schema.orbitHandoverNotes).values({
    id: newId("hnd", ctx.now),
    tenantId: ctx.tenantId,
    conversationId,
    fromRef: `${ctx.actor.kind}:${ctx.actor.id}`,
    summary,
    factsJson: args.factsJson && typeof args.factsJson === "object" ? JSON.stringify(args.factsJson) : null,
    generatedBy: "ai",
    ts: ctx.now
  });
  await ctx.db
    .update(schema.orbitConversations)
    .set({
      state: "human",
      ...(skills.length ? { requireSkillsJson: JSON.stringify(skills) } : {}),
      queuedAt: conversation.queuedAt ?? ctx.now,
      updatedAt: ctx.now
    })
    .where(scoped(ctx, schema.orbitConversations, eq(schema.orbitConversations.id, conversationId)));
  const routed = await routeConversation(ctx, conversationId);

  await audit(ctx, { action: "orbit.conversation.handover", subjectRef: conversationId, after: { ...routed } });
  await emit(ctx, {
    module: "orbit",
    type: "orbit.conversation.handover",
    subject: conversationId,
    data: { conversationId, customerId: conversation.customerId, ...routed }
  });
  return { conversationId, state: "human", ...routed };
}

const HANDLERS: Record<string, ToolHandler> = {
  fetch_policy: fetchPolicy,
  start_quote: startQuote,
  create_endorsement_request: createEndorsementRequest,
  send_document: sendDocument,
  make_renewal_offer: makeRenewalOffer,
  fnol_guidance: fnolGuidance,
  book_callback: bookCallback,
  human_handover: humanHandover
};

export function isOrbitTool(name: string): boolean {
  return name in HANDLERS;
}

export async function runOrbitTool(ctx: Ctx, name: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = HANDLERS[name];
  if (!handler) throw notFound(`tool ${name}`);
  return handler(ctx, args);
}

/**
 * Execute every tool call the model asked for, record one `ai_tool_calls` row
 * each (outcome + approval id, never the raw content — docs/12 §4) and hand
 * back `role: tool` messages so the AI route can fold them into a follow-up
 * completion. A gated call never throws out of here: `approval_required`
 * becomes an `awaiting_approval` row and a tool result the model can react to,
 * so one blocked action does not fail the whole run.
 */
/**
 * The one place an ORBIT tool call becomes an `ai_tool_calls` row. Both
 * executors route through it: the chat loop here and the command loop in
 * command-loop.ts, which called `runOrbitTool` directly and so left its runs
 * with no tool audit at all while openapi.ts advertised the rows.
 */
export async function recordToolCall(
  ctx: Ctx,
  entry: {
    runId: string;
    seq: number;
    name: string;
    args: Record<string, unknown>;
    outcome: "ok" | "error" | "awaiting_approval";
    approvalId: string | null;
    result: unknown;
    durationMs: number;
  }
): Promise<void> {
  await ctx.db.insert(schema.aiToolCalls).values({
    id: newId("atc", ctx.now),
    tenantId: ctx.tenantId,
    runId: entry.runId,
    seq: entry.seq,
    tool: entry.name,
    argsHash: await hashObject(entry.args),
    argsRedactedJson: JSON.stringify(entry.args),
    consequential: ORBIT_TOOL_DEFS.find((d) => d.name === entry.name)?.consequential ?? false,
    approvalId: entry.approvalId,
    outcome: entry.outcome,
    resultHash: await hashObject(entry.result),
    durationMs: entry.durationMs,
    ts: ctx.now
  });
}

export async function executeOrbitToolCalls(
  ctx: Ctx,
  runId: string,
  toolCalls: ToolCall[],
  allowed: ReadonlySet<string>,
  /** Continues the run's tool-call sequence across rounds (docs/27 F33). */
  startSeq = 0
): Promise<Message[]> {
  const messages: Message[] = [];
  let seq = startSeq;
  for (const call of toolCalls) {
    const startedAt = Date.now();
    const approvalsBefore = DEFS_BY_NAME.get(call.name)?.consequential ? await approvalAudits(ctx) : 0;
    let outcome: "ok" | "error" | "awaiting_approval" = "ok";
    let approvalId: string | null = null;
    let result: unknown;
    try {
      // The model is only ever offered `orbitToolsFor(agent)` (ai.ts), but a
      // completion can echo back a tool call outside that set — an injected
      // instruction telling it to invent one, or a provider bug. Re-check the
      // same allowlist here so the executor, not the model's cooperation, is
      // what actually gates a consequential action (docs/02 §4).
      if (!allowed.has(call.name)) throw notFound(`tool ${call.name}`);
      // docs/27 F38. A consequential tool may only be dispatched when this
      // registry says which approval policy stands behind it. Today's one such
      // tool gates inside `endorsePolicy`, so the rule held by luck of
      // implementation — the *next* consequential tool anyone adds would have
      // executed unchecked with a truthful `consequential: true` beside it in
      // `ai_tool_calls`. An unregistered gate now refuses before the handler
      // runs, which is the direction a missing entry has to fail in.
      if (DEFS_BY_NAME.get(call.name)?.consequential && !POLICY_FOR_TOOL[call.name])
        throw new AppError(
          403,
          "ungated_consequential",
          `tool ${call.name} is consequential and has no registered approval policy`,
          "Register the tool's approval policy in POLICY_FOR_TOOL before an agent may call it."
        );
      result = await runOrbitTool(ctx, call.name, call.args);
    } catch (err) {
      if (err instanceof AppError && err.code === "approval_required") {
        outcome = "awaiting_approval";
        approvalId = (err.extras.approval_id as string | undefined) ?? null;
        result = { error: "approval_required", approvalId, policyKey: err.detail };
      } else {
        outcome = "error";
        result = { error: err instanceof Error ? err.message : "tool error" };
      }
    }
    // docs/27 F38, the second half. The registry check above stops a tool with
    // no declared gate; this catches a tool that has one and did not reach it.
    //
    // The signal is the gate's own audit trail, not a guess from tenant policy.
    // `gate()` writes a `core.approval.*` row on every path it takes —
    // requested, consumed, auto — so "did an approval decision happen while
    // this call ran" is directly observable, where "is there an approval id"
    // is not: three legitimate paths hand the caller nothing back. Counting
    // rather than joining on a request id because `core_audit_log` has no such
    // column; a concurrent approval elsewhere in the same tenant can therefore
    // mask an ungated call, which is why this is the *second* line and the
    // registry check is the first.
    const def = DEFS_BY_NAME.get(call.name);
    const verdict = def
      ? verdictFor(def, {
          outcome,
          approvalId,
          gateObserved: def.consequential ? (await approvalAudits(ctx)) > approvalsBefore : false
        })
      : outcome;
    if (verdict === "ungated_consequential") {
      outcome = "error";
      result = {
        error: "ungated_consequential",
        detail: `${call.name} changed contractual state without an approval; the result is withheld`
      };
    }
    await recordToolCall(ctx, {
      runId,
      seq: seq++,
      name: call.name,
      args: call.args,
      outcome,
      approvalId,
      result,
      durationMs: Date.now() - startedAt
    });
    // A tool result is prompt text, and an epoch instant is a 13-digit run —
    // which the scrubber's card rule eats whenever it passes Luhn, so
    // `fetch_policy` handed the model `"startAt":[[CARD_1]]` for a policy it had
    // just read successfully. Rendered by field *name*, never by magnitude: a
    // premium in fils is the same size as an instant and must stay a number.
    // One replacer here covers every tool, because every tool's result lands on
    // this line.
    const content = JSON.stringify(result, (key, value) =>
      typeof value === "number" && isInstantKey(key) ? promptInstant(value) : (value as unknown)
    );
    messages.push({ role: "tool", toolCallId: call.id, name: call.name, content });
  }
  return messages;
}

/**
 * Filters the registry down to what an agent is allowed to reach for.
 *
 * A null `tools_json` is an unconfigured column, not a grant of everything:
 * it used to hand an agent `create_endorsement_request` — a consequential tool
 * — because nobody had filled the field in. Absent config now means the
 * read-only subset; reaching a consequential tool takes an explicit listing.
 */
/** The permission each handler requires of the person the agent acts for. */
export const TOOL_PERMISSION: Record<string, Permission> = {
  fetch_policy: "axis:policies:read",
  start_quote: "axis:cases:create",
  create_endorsement_request: "axis:policies:endorse",
  send_document: "orbit:conversations:reply",
  make_renewal_offer: "orbit:renewals:update",
  fnol_guidance: "orbit:conversations:read",
  book_callback: "orbit:conversations:assign",
  human_handover: "orbit:handover:write"
};

export function orbitToolsFor(agent: { toolsJson: string | null }, actor?: Actor): ToolDef[] {
  let allow: string[] | null = null;
  if (agent.toolsJson) {
    try {
      const parsed: unknown = JSON.parse(agent.toolsJson);
      if (Array.isArray(parsed)) allow = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      // A malformed allowlist offers nothing rather than everything.
      allow = [];
    }
  }
  // @accept:SA: a tool the person may not run is never offered — on an
  // ORBIT-only tenant that is every AXIS tool, since entitledGrants removed them.
  const runnable = (name: string) => !actor || can(actor, TOOL_PERMISSION[name]!, { tenantId: actor.tenantId });
  return ORBIT_TOOL_DEFS.filter((t) => (allow ? allow.includes(t.name) : !t.consequential) && runnable(t.name));
}

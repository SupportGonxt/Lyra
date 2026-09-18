import { and, count, eq, like } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { AppError, badRequest, hashObject, notFound, require_, scoped, type Ctx } from "@lyra/core";
import { promptInstant, verdictFor, type Message, type ToolCall, type ToolDef } from "@lyra/model-gateway";
import { isInstantKey } from "../http.js";
import { endorsePolicy } from "./axis-endorse.js";

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
  create_endorsement_request: "axis.endorse"
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

  const caseId = newId("cas", ctx.now);
  // ponytail: id() is already unique per tenant, so the case reuses it as its
  // human-facing ref too. Swap in a real short-code generator (none exists
  // yet — seed.ts hardcodes its one ref) if agents start surfacing refs to
  // customers directly.
  const row = {
    id: caseId,
    tenantId: ctx.tenantId,
    ref: caseId,
    kind: "quote",
    customerId,
    productLine: str(args.productLine) ?? null,
    channelId: str(args.channelId) ?? null,
    status: "intake",
    ownerRef: `${ctx.actor.kind}:${ctx.actor.id}`,
    source: "agent",
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisCases).values(row);
  return row;
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

const HANDLERS: Record<string, ToolHandler> = {
  fetch_policy: fetchPolicy,
  start_quote: startQuote,
  create_endorsement_request: createEndorsementRequest
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
export function orbitToolsFor(agent: { toolsJson: string | null }): ToolDef[] {
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
  return ORBIT_TOOL_DEFS.filter((t) => (allow ? allow.includes(t.name) : !t.consequential));
}

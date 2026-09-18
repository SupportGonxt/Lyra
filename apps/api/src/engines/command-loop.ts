import { id as newId, schema } from "@lyra/db";
import { type Ctx } from "@lyra/core";
import { MAX_ROUNDS as LOOP_MAX_ROUNDS, offersTools, type Gateway, type Message, type ToolCall } from "@lyra/model-gateway";
import { POLICY_FOR_TOOL, isOrbitTool, recordToolCall, runOrbitTool } from "./orbit-tools.js";
import { toolsFor, type CommandToolDef } from "./command-tools.js";
import { embedQuery } from "./vectorize.js";
import type { Env } from "../env.js";

// ADR-0073. The command loop: a bounded multi-round agent over the unified
// registry. The one rule that cannot bend (CLAUDE.md rule 4): a consequential
// tool never executes here. It becomes an ai_command_proposals row — args,
// policy key, and the run's reasoning as the inspectable "why" — and the model
// sees `proposed:<id>` back. A human actions it later through the module's real
// path, where the approval gate fires exactly once.

/**
 * Hard ceiling on model rounds per run. A model that keeps asking for tools
 * gets its last answer instead of an open tab on the tenant's budget.
 *
 * Re-exported rather than declared: this loop and the ORBIT chat loop are the
 * same shape, and docs/27 F33 is what two copies of that shape drifting apart
 * looks like. The number and the "which rounds get tools" rule live together in
 * the gateway (src/agent-loop.ts) where the eval can reach them.
 */
export const MAX_ROUNDS = LOOP_MAX_ROUNDS;

/** docs/16 H2 / ADR-0049. The envelope decides which non-consequential tools
 *  auto-run; consequential tools propose under every level — no tenant setting
 *  may automate them (docs/19 §7's rule, applied to agents). */
export interface Envelope {
  level: "draft_only" | "assist" | "act_with_approval";
}

const ENVELOPE_LEVELS = ["draft_only", "assist", "act_with_approval"] as const;

export function envelopeFromPolicy(policyJson: string | null | undefined): Envelope {
  if (!policyJson) return { level: "draft_only" };
  try {
    const parsed = JSON.parse(policyJson) as { commandCenter?: { autonomy?: string } };
    const level = parsed.commandCenter?.autonomy;
    if (level && (ENVELOPE_LEVELS as readonly string[]).includes(level)) {
      return { level: level as Envelope["level"] };
    }
  } catch {
    // fall through to default
  }
  return { level: "draft_only" };
}

export interface LoopInput {
  agentKey: string;
  purpose: string;
  input: string;
  subjectRef?: string | undefined;
  locale?: "en" | "ar" | undefined;
}

export interface LoopRound {
  seq: number;
  toolCalls: { name: string; outcome: "ok" | "error" | "proposed"; proposalId?: string }[];
}

export interface LoopResult {
  runId: string;
  text: string;
  rounds: LoopRound[];
  proposalIds: string[];
  usage: { tokensIn: number; tokensOut: number; costMicro: number };
  finishReason: string;
  auditId: string;
}

interface ToolOutcome {
  outcome: "ok" | "error" | "proposed";
  result: unknown;
  proposalId?: string;
}

/** Consequential registry tools by name. */
const CONSEQUENTIAL = new Map<string, CommandToolDef>();

function primeConsequentialMap(defs: CommandToolDef[]): void {
  CONSEQUENTIAL.clear();
  for (const d of defs) if (d.consequential) CONSEQUENTIAL.set(d.name, d);
}

/**
 * Execute one tool call under the envelope. Reads run inline through their
 * handler (each checks its own permission); consequential calls become
 * proposals — never executed here, whatever the model asks for.
 */
/** Registry tools that write without being tagged consequential. The envelope
 *  gates these: a draft_only tenant's loop reads but does not write. */
const WRITES = new Set(["start_quote"]);

/** Exported for the audit test: the stub provider never emits a tool call, so
 *  the only way to exercise this path is to call it. */
export async function executeCall(
  ctx: Ctx,
  runId: string,
  seq: number,
  call: ToolCall,
  allow: ReadonlySet<string>,
  why: string,
  envelope: Envelope
): Promise<ToolOutcome> {
  const startedAt = Date.now();
  const outcome = await executeCallInner(ctx, runId, call, allow, why, envelope);
  // Same `ai_tool_calls` row the ORBIT chat loop writes. This loop used to call
  // runOrbitTool directly and audit nothing, so a command-center run left no
  // record of what it touched while openapi.ts documented one.
  await recordToolCall(ctx, {
    runId,
    seq,
    name: call.name,
    args: call.args,
    outcome: outcome.outcome === "proposed" ? "awaiting_approval" : outcome.outcome,
    approvalId: null,
    result: outcome.result,
    durationMs: Date.now() - startedAt
  });
  return outcome;
}

async function executeCallInner(
  ctx: Ctx,
  runId: string,
  call: ToolCall,
  allow: ReadonlySet<string>,
  why: string,
  envelope: Envelope
): Promise<ToolOutcome> {
  if (!allow.has(call.name)) {
    return { outcome: "error", result: `tool ${call.name} is not on this agent's allowlist` };
  }

  // Consequential → proposal. This branch is the whole point of the loop.
  if (CONSEQUENTIAL.has(call.name)) {
    const def = CONSEQUENTIAL.get(call.name)!;
    const proposalId = newId("cpr", ctx.now);
    await ctx.db.insert(schema.aiCommandProposals).values({
      id: proposalId,
      tenantId: ctx.tenantId,
      runId,
      module: def.module,
      toolName: call.name,
      subjectRef:
        typeof call.args.policyId === "string"
          ? call.args.policyId
          : typeof call.args.subjectRef === "string"
            ? call.args.subjectRef
            : null,
      policyKey: POLICY_FOR_TOOL[call.name] ?? null,
      argsJson: JSON.stringify(call.args),
      whyJson: JSON.stringify({ reason: why.slice(0, 2000) }),
      state: "proposed",
      createdAt: ctx.now
    });
    return {
      outcome: "proposed",
      proposalId,
      result: `proposed:${proposalId} — held for a human decision. Do not retry this call.`
    };
  }

  // Everything else today is either an ORBIT-handled read/write-through-gate
  // or a registry read. Both check permissions inside their handlers.
  try {
    let result: unknown;
    if (isOrbitTool(call.name)) {
      // Envelope gate (docs/16 H2, ADR-0049): below `assist`, the loop may only
      // read. `start_quote` writes a case — held back to draft_only tenants as
      // a proposal-shaped refusal rather than a silent write.
      if (WRITES.has(call.name) && envelope.level === "draft_only") {
        return {
          outcome: "error",
          result: `held: the tenant's autonomy envelope (${envelope.level}) lets this loop read but not write. Raise the envelope to run ${call.name}.`
        };
      }
      result = await runOrbitTool(ctx, call.name, call.args);
    } else {
      const { runCommandRead } = await import("./command-reads.js");
      result = await runCommandRead(ctx, call.name, call.args);
    }
    return { outcome: "ok", result };
  } catch (err) {
    return {
      outcome: "error",
      result: err instanceof Error ? err.message.slice(0, 300) : "tool error"
    };
  }
}

/**
 * Run the loop. Each round is its own gateway.complete call — separately
 * budgeted, scrubbed, guardrailed and audited by the gateway itself.
 */
export async function runCommandLoop(
  ctx: Ctx,
  gateway: Gateway,
  env: Env,
  agent: { key: string; module: string; tier: string; toolsJson: string | null },
  input: LoopInput
): Promise<LoopResult> {
  const defs = toolsFor(agent);
  primeConsequentialMap(defs);
  const allow = new Set(defs.map((d) => d.name));
  const runId = newId("air", ctx.now);
  // docs/16 H2 / ADR-0049: the envelope is tenant policy, not agent config —
  // one tenant-wide answer to "how much may the loop do without asking".
  const envelope: Envelope = {
    level: ctx.policy.commandCenter?.autonomy ?? "draft_only"
  };

  const messages: Message[] = [
    {
      role: "system",
      content:
        `You are the ${agent.key} agent at the tenant's command center. ` +
        "You may call tools to read across modules. Actions that change contracts, money or send anything outbound are never executed by you: they are proposed to a human, and you will see `proposed:<id>`. " +
        "When you have enough information, answer concisely and cite what you read."
    },
    { role: "user", content: input.input }
  ];

  // F52's first reader: recall from VEC_MARKET (the market-intelligence corpus
  // scout's harvester writes) so a run about one module can surface what the
  // tenant already knows from another. Tenant-filtered — never another
  // customer's signals. No index bound (dev, on-prem without Vectorize) means
  // no recall, same as embedQuery's own contract.
  const recall = await embedQuery(ctx, gateway, env.VEC_MARKET, {
    module: "ai",
    purpose: "command.center",
    text: input.input,
    topK: 5,
    filter: { tenantId: ctx.tenantId }
  }).catch(() => []);
  if (recall.length) {
    messages.splice(1, 0, {
      role: "user",
      // Corpus text, not the operator's words — a harvested page that says
      // "ignore previous instructions" must not inherit their authority.
      untrusted: true,
      content:
        "relevant prior intelligence:\n" +
        recall.map((m) => `- ${JSON.stringify(m.metadata ?? {}).slice(0, 200)}`).join("\n")
    });
  }

  const rounds: LoopRound[] = [];
  const proposalIds: string[] = [];
  let usage = { tokensIn: 0, tokensOut: 0, costMicro: 0 };

  const callOnce = async (): Promise<Awaited<ReturnType<Gateway["complete"]>>> => {
    const res = await gateway.complete(ctx, {
      module: "ai",
      purpose: input.purpose,
      tier: agent.tier as "fast" | "standard" | "reasoning",
      ...(input.subjectRef !== undefined ? { subjectRef: input.subjectRef } : {}),
      ...(input.locale !== undefined ? { locale: input.locale } : {}),
      messages,
      // docs/27 F33. This read `seq === 0`, so a loop advertised as bounded
      // multi-round could in fact take tools exactly once: rounds two through
      // six were toolless, and the model's only remaining move was to answer.
      // `offersTools` is the shared rule — every round but the terminator, which
      // stays toolless on purpose so the run always ends in prose.
      ...(offersTools(seq) ? { tools: defs.map(({ module: _m, ...def }) => def) } : {})
    });
    usage = {
      tokensIn: usage.tokensIn + res.usage.tokensIn,
      tokensOut: usage.tokensOut + res.usage.tokensOut,
      costMicro: usage.costMicro + res.usage.costMicro
    };
    return res;
  };

  let seq = 0;
  let toolSeq = 0;
  let last = await callOnce();

  while (last.toolCalls.length > 0 && seq < MAX_ROUNDS - 1) {
    seq += 1;
    const round: LoopRound = { seq, toolCalls: [] };

    for (const call of last.toolCalls) {
      const outcome = await executeCall(ctx, runId, toolSeq++, call, allow, last.text, envelope);
      if (outcome.proposalId) proposalIds.push(outcome.proposalId);
      round.toolCalls.push({
        name: call.name,
        outcome: outcome.outcome,
        ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {})
      });
      messages.push({ role: "assistant", content: last.text });
      messages.push({
        // docs/27 F37. A tool result is third-party text — a partner payload, a
        // harvested page, a row somebody else wrote — and this pushed it back as
        // an ordinary user turn, where the injection screen only warns. Laundered
        // provenance: the gateway blocks a jailbreak pattern in untrusted text
        // and warns about the same pattern from a signed-in human, and this
        // round-trip turned every one of these into the second kind. The ORBIT
        // executor already returns `role: "tool"`, which the gateway screens as
        // untrusted automatically; this loop formats its own, so it says so.
        role: "user",
        untrusted: true,
        content: `tool ${call.name} → ${JSON.stringify(outcome.result).slice(0, 4000)}`
      });
    }
    rounds.push(round);

    last = await callOnce();
  }

  return {
    runId,
    text: last.text,
    rounds,
    proposalIds,
    usage,
    finishReason: last.finishReason,
    auditId: last.auditId
  };
}

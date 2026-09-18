import type { ToolDef } from "./types.js";

// docs/27 F33 + F38. The agent loop's *policy*, separated from its execution.
//
// The execution lives in apps/api (engines/orbit-tools.ts, routes/ai.ts):
// permissions, database writes, approval records. None of that can be scored by
// an eval, and all of it is what a unit test ends up mocking — which is how
// "the loop is one round" and "consequential gates nothing" both stayed green
// for as long as they did. The two decisions that actually define the loop are
// pure, so they live here where evals/agent-loop can drive them directly:
//
//   planRound  — may the model take another turn, and does it get tools?
//   verdictFor — did a tool call that changed something pass a gate?

/**
 * Model rounds per run, including the final one. The last round is offered no
 * tools, so the model always gets a turn to answer with what it learned rather
 * than having its request dropped on the floor at the cap.
 *
 * Six matches the command loop's MAX_ROUNDS (ADR-0073), which faced the same
 * question first: a model that keeps asking for tools gets its last answer,
 * not an open tab on the tenant's budget.
 */
export const MAX_ROUNDS = 6;

/** Rounds that may actually execute tools: every round but the terminator. */
export const MAX_TOOL_ROUNDS = MAX_ROUNDS - 1;

export interface RoundState {
  /** 0-based index of the round that just completed. */
  round: number;
  /** What that round's completion asked for. */
  toolCalls: readonly { name: string }[];
}

export type LoopStep =
  | { action: "answer" }
  | { action: "execute" }
  | { action: "halt"; reason: "max_rounds" };

/**
 * Whether round `round` is offered the agent's tools.
 *
 * The terminator is toolless on purpose — it is the round that must produce
 * prose. What F33 found was not that a toolless call exists, but that it
 * arrived after exactly *one* tool round, so the model could look something up
 * and never act on what it read.
 */
export function offersTools(round: number): boolean {
  return round < MAX_TOOL_ROUNDS;
}

/** What happens after a completion returns. */
export function planRound(state: RoundState): LoopStep {
  if (state.toolCalls.length === 0) return { action: "answer" };
  if (state.round >= MAX_TOOL_ROUNDS) return { action: "halt", reason: "max_rounds" };
  return { action: "execute" };
}

/** What the executor observed when it ran a tool call. */
export interface ExecutedCall {
  outcome: "ok" | "error" | "awaiting_approval";
  /** The approval this call is held by, or ran under. */
  approvalId: string | null;
  /**
   * An approval decision was observed while this call ran — granted, consumed,
   * auto-approved under the tenant's allowlist, or newly requested.
   *
   * This exists because "no approval id" is not evidence of anything on its
   * own. `gate()` (packages/core/src/approvals.ts) has three legitimate paths
   * that leave the caller holding nothing: an auto-approve allowlist entry
   * (CLAUDE.md §4 permits exactly that), a standing autonomy bound, and an
   * approval it consumes internally and never hands back. Condemning those
   * would make the check fire on correct configurations, and a check that cries
   * wolf is a check somebody turns off.
   */
  gateObserved?: boolean;
}

export type ToolVerdict = "ok" | "error" | "awaiting_approval" | "ungated_consequential";

/**
 * docs/27 F38 / CLAUDE.md §4. `consequential: true` was written to
 * `ai_tool_calls` and read by nothing: the flag described the tool, and whether
 * an approval actually happened depended entirely on the handler remembering to
 * raise one. `create_endorsement_request` does (it routes through
 * `endorsePolicy`, which gates) — so the rule held by luck of implementation,
 * and the *second* consequential tool anyone adds would have executed
 * unchecked with a truthful `consequential: true` beside it in the audit log.
 *
 * This is the branch. A consequential call is acceptable only if it failed, is
 * held for an approval, carries the approval it ran under, or was seen to reach
 * a gate at all. Anything else is `ungated_consequential`: recorded as such and
 * never handed back to the model as a success.
 */
export function verdictFor(def: Pick<ToolDef, "consequential">, executed: ExecutedCall): ToolVerdict {
  if (executed.outcome !== "ok") return executed.outcome;
  if (!def.consequential) return "ok";
  if (executed.approvalId || executed.gateObserved) return "ok";
  return "ungated_consequential";
}

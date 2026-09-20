import { describe, expect, it } from "vitest";
import { MAX_ROUNDS, MAX_TOOL_ROUNDS, offersTools, planRound, verdictFor, type ExecutedCall, type RoundState } from "./agent-loop.js";

// docs/27 F33 + F38. This file was previously exercised only indirectly
// through apps/api integration tests that mock the database and the gateway
// — which is exactly how "the loop is one round" and "consequential gates
// nothing" both stayed green. planRound/offersTools/verdictFor are pure on
// purpose so they can be driven directly, at every boundary.

describe("MAX_ROUNDS / MAX_TOOL_ROUNDS", () => {
  it("is six rounds total, five of them tool-capable", () => {
    expect(MAX_ROUNDS).toBe(6);
    expect(MAX_TOOL_ROUNDS).toBe(5);
    expect(MAX_TOOL_ROUNDS).toBe(MAX_ROUNDS - 1);
  });
});

describe("offersTools", () => {
  it("offers tools to every round before the terminator", () => {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      expect(offersTools(round)).toBe(true);
    }
  });

  it("withholds tools from the terminator round and anything past it", () => {
    expect(offersTools(MAX_TOOL_ROUNDS)).toBe(false);
    expect(offersTools(MAX_TOOL_ROUNDS + 1)).toBe(false);
  });
});

describe("planRound", () => {
  const state = (round: number, toolCalls: readonly { name: string }[]): RoundState => ({ round, toolCalls });

  it("answers when the model asked for no tools, at any round", () => {
    expect(planRound(state(0, []))).toEqual({ action: "answer" });
    expect(planRound(state(MAX_TOOL_ROUNDS, []))).toEqual({ action: "answer" });
    expect(planRound(state(99, []))).toEqual({ action: "answer" });
  });

  it("executes when tools were requested before the terminator", () => {
    expect(planRound(state(0, [{ name: "fetch_policy" }]))).toEqual({ action: "execute" });
    expect(planRound(state(MAX_TOOL_ROUNDS - 1, [{ name: "fetch_policy" }]))).toEqual({ action: "execute" });
  });

  it("halts at the exact round the terminator is reached, tools still requested", () => {
    // Boundary: MAX_TOOL_ROUNDS itself must halt, not execute one more time.
    expect(planRound(state(MAX_TOOL_ROUNDS, [{ name: "fetch_policy" }]))).toEqual({
      action: "halt",
      reason: "max_rounds"
    });
  });

  it("halts past the terminator too, never executes again", () => {
    expect(planRound(state(MAX_TOOL_ROUNDS + 3, [{ name: "fetch_policy" }]))).toEqual({
      action: "halt",
      reason: "max_rounds"
    });
  });
});

describe("verdictFor", () => {
  const call = (over: Partial<ExecutedCall>): ExecutedCall => ({
    outcome: "ok",
    approvalId: null,
    ...over
  });

  it("passes through a non-ok outcome untouched, consequential or not", () => {
    expect(verdictFor({ consequential: true }, call({ outcome: "error" }))).toBe("error");
    expect(verdictFor({ consequential: false }, call({ outcome: "error" }))).toBe("error");
    expect(verdictFor({ consequential: true }, call({ outcome: "awaiting_approval" }))).toBe("awaiting_approval");
  });

  it("a non-consequential tool is always ok on success, with nothing gating it", () => {
    expect(verdictFor({ consequential: false }, call({ outcome: "ok", approvalId: null, gateObserved: false }))).toBe(
      "ok"
    );
  });

  it("a consequential tool that carries an approval id is ok", () => {
    expect(verdictFor({ consequential: true }, call({ outcome: "ok", approvalId: "apr_1", gateObserved: false }))).toBe(
      "ok"
    );
  });

  it("a consequential tool with no approval id but an observed gate is ok — the auto-approve/autonomy/internal-consumption paths", () => {
    expect(verdictFor({ consequential: true }, call({ outcome: "ok", approvalId: null, gateObserved: true }))).toBe(
      "ok"
    );
  });

  it("a consequential tool that succeeded with no approval id and no observed gate is ungated_consequential", () => {
    expect(
      verdictFor({ consequential: true }, call({ outcome: "ok", approvalId: null, gateObserved: false }))
    ).toBe("ungated_consequential");
    // gateObserved omitted entirely (undefined) must fail the same way as false.
    expect(verdictFor({ consequential: true }, call({ outcome: "ok", approvalId: null }))).toBe("ungated_consequential");
  });
});

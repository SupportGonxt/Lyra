import { describe, expect, it } from "vitest";
import { guardChunk, newStreamGuard, HOLDBACK, type StreamGuardState } from "./stream-guard.js";

// docs/27 F35. Exercised previously only through gateway.test.ts's four
// streaming (F35) integration cases, which is why the early-return-once-
// refused branch, the raw block-detection object literal, and the
// Math.max/Math.min holdback boundary all survived mutation — those cases
// only ever drive the "answer arrives fine" and "the whole answer is
// blocked from the first chunk" paths. Direct here.

const opts = { issued: new Set<string>() };

describe("newStreamGuard", () => {
  it("starts clean: nothing emitted, not refused", () => {
    expect(newStreamGuard()).toEqual({ emittedUpTo: 0, refused: false });
  });
});

describe("guardChunk — already refused", () => {
  it("returns the fixed refused step and touches nothing else, regardless of the new text", () => {
    const state: StreamGuardState = { emittedUpTo: 5, refused: true };
    const step = guardChunk(state, "whatever the model says now", true, opts);
    expect(step).toEqual({ emit: "", hits: [], refused: true });
    // Already-refused is a dead end: emittedUpTo must not move once blocked.
    expect(state.emittedUpTo).toBe(5);
  });
});

describe("guardChunk — a customer-facing regulated claim blocks", () => {
  it("flips the guard to refused and returns nothing further", () => {
    const state = newStreamGuard();
    const step = guardChunk(state, "We guarantee this claim is covered.", false, { ...opts, customerFacing: true });
    expect(step.refused).toBe(true);
    expect(step.emit).toBe("");
    expect(step.hits).toEqual([{ rule: "regulated_claim", severity: "block", detail: "guarantee" }]);
    expect(state.refused).toBe(true);
  });

  it("stays refused on the next call even mid-stream", () => {
    const state = newStreamGuard();
    guardChunk(state, "We guarantee this.", false, { ...opts, customerFacing: true });
    const second = guardChunk(state, "We guarantee this. More text arrives.", false, { ...opts, customerFacing: true });
    expect(second).toEqual({ emit: "", hits: [], refused: true });
  });
});

describe("guardChunk — a non-blocking hit still surfaces without refusing", () => {
  it("a regulated claim outside a customer-facing purpose is a warn, not a block", () => {
    const state = newStreamGuard();
    const step = guardChunk(state, "We guarantee this internally.", true, { ...opts, customerFacing: false });
    expect(step.refused).toBe(false);
    expect(step.hits).toEqual([{ rule: "regulated_claim", severity: "warn", detail: "guarantee" }]);
    // Not blocked, so the holdback rule still applies and (done) releases it all.
    expect(step.emit).toBe("We guarantee this internally.");
  });
});

describe("guardChunk — the holdback", () => {
  it("emits nothing while the accumulated text is within the holdback", () => {
    const state = newStreamGuard();
    const short = "a".repeat(HOLDBACK - 1);
    const step = guardChunk(state, short, false, opts);
    expect(step).toEqual({ emit: "", hits: [], refused: false });
    expect(state.emittedUpTo).toBe(0);
  });

  it("releases exactly the amount past the holdback, not the whole answer — the Math.max boundary", () => {
    const state = newStreamGuard();
    const accumulated = "a".repeat(HOLDBACK + 40); // 200 chars, HOLDBACK 160
    const step = guardChunk(state, accumulated, false, opts);
    // safeUpTo = max(0, 200 - 160) = 40, not min(0, 40) = 0.
    expect(step.emit).toBe("a".repeat(40));
    expect(state.emittedUpTo).toBe(40);
  });

  it("never re-emits text already released as the answer keeps growing", () => {
    const state: StreamGuardState = { emittedUpTo: 40, refused: false };
    const accumulated = "a".repeat(HOLDBACK + 90); // 250 chars total
    const step = guardChunk(state, accumulated, false, opts);
    // safeUpTo = max(40, 250 - 160=90) = 90; emit is exactly the new 50 chars.
    expect(step.emit.length).toBe(50);
    expect(state.emittedUpTo).toBe(90);
  });

  it("holds emittedUpTo steady rather than retreating when the tail shrinks the safe point — max, not min", () => {
    // A pathological case that only distinguishes Math.max from Math.min:
    // emittedUpTo is already ahead of accumulated.length - HOLDBACK.
    const state: StreamGuardState = { emittedUpTo: 100, refused: false };
    const accumulated = "a".repeat(150); // 150 - 160 = -10
    const step = guardChunk(state, accumulated, false, opts);
    expect(state.emittedUpTo).toBe(100); // stayed at 100, never dropped to -10
    expect(step.emit).toBe("");
  });

  it("on the final chunk, releases everything still held back regardless of the holdback", () => {
    const state: StreamGuardState = { emittedUpTo: 90, refused: false };
    const accumulated = "a".repeat(HOLDBACK + 90); // 250 chars
    const step = guardChunk(state, accumulated, true, opts);
    expect(step.emit.length).toBe(160); // the remaining 250 - 90
    expect(state.emittedUpTo).toBe(250);
    expect(step.refused).toBe(false);
  });
});

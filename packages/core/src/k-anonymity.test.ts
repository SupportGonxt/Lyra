import { describe, expect, it } from "vitest";
import { PolicyJson } from "@lyra/db";
import { checkKAnonymity, DEFAULT_K_FLOOR, kAnonymityFloor } from "./k-anonymity.js";

describe("checkKAnonymity", () => {
  it("suppresses a cell below the floor", () => {
    const result = checkKAnonymity(19, 20);
    expect(result).toEqual({ allowed: false, cellCount: 19, floor: 20 });
  });

  it("passes a cell exactly at the floor (boundary)", () => {
    const result = checkKAnonymity(20, 20);
    expect(result.allowed).toBe(true);
  });

  it("passes a cell above the floor", () => {
    expect(checkKAnonymity(21, 20).allowed).toBe(true);
  });

  it("honours a product-specific floor, not just the default", () => {
    expect(checkKAnonymity(41, 50).allowed).toBe(false); // Gulf Health cut from the seed narrative
    expect(checkKAnonymity(50, 50).allowed).toBe(true);
  });

  it("defaults to k=20 per docs/modules/scout.md §2.5", () => {
    expect(DEFAULT_K_FLOOR).toBe(20);
  });
});

// docs/27 P2: the floor was a plain constant (`scout.shared.ts` K_FLOOR = 20,
// every server call site's DEFAULT_K_FLOOR) with no tenant able to raise it —
// a stricter operator (or a smaller-panel one that wants a lower bar than the
// default protects, subject to the floor of 1) had no dial to turn.
describe("kAnonymityFloor", () => {
  it("falls through to the default when the tenant set no override", () => {
    expect(kAnonymityFloor(PolicyJson.parse({}), "scout")).toBe(DEFAULT_K_FLOOR);
  });

  it("honours a tenant's own floor for that module", () => {
    const policy = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: 50 } } } });
    expect(kAnonymityFloor(policy, "scout")).toBe(50);
  });

  it("does not let one module's override change another module's floor", () => {
    const policy = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: 50 } } } });
    expect(kAnonymityFloor(policy, "signal")).toBe(DEFAULT_K_FLOOR);
  });

  it("refuses to let a free-form settings blob lower re-identification protection with garbage", () => {
    const zero = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: 0 } } } });
    const negative = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: -5 } } } });
    const fractional = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: 2.5 } } } });
    const notANumber = PolicyJson.parse({ moduleConfig: { scout: { settings: { kAnonymityFloor: "20" } } } });
    for (const policy of [zero, negative, fractional, notANumber]) {
      expect(kAnonymityFloor(policy, "scout")).toBe(DEFAULT_K_FLOOR);
    }
  });
});

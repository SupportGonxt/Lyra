import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POLICY_TITLES_AR, policyTitle } from "./policy";

describe("policyTitle", () => {
  it("names a policy in the reader's language", () => {
    expect(policyTitle("axis.claim_payment", "axis", "ar")).toBe("دفع مطالبة");
    expect(policyTitle("axis.claim_payment", "axis", "ar-AE")).toBe("دفع مطالبة");
    expect(policyTitle("axis.ntu", "axis")).toBe("Not taken up");
  });

  it("falls back to the words of the key", () => {
    expect(policyTitle("axis.claim_payment", "axis")).toBe("Claim payment");
  });

  // The web may not import @lyra/core, so the policy keys are read from it as text.
  it("names every approval policy core declares in Arabic", () => {
    const core = readFileSync(new URL("../../../packages/core/src/approvals.ts", import.meta.url), "utf8");
    const keys = [...core.matchAll(/policy\(\{ key: "([^"]+)"/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(40);
    expect(keys.filter((key) => !(key in POLICY_TITLES_AR))).toEqual([]);
  });
});

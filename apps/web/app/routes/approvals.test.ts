import { describe, expect, it } from "vitest";
import { approvalsHeadline, labelsIn, policyTitle } from "./approvals";

// Every card in the queue was headed by the policy key as stored —
// `axis.claim_payment` — where the thing being approved belongs.

describe("policyTitle", () => {
  it("drops the module the card already names", () => {
    expect(policyTitle("axis.claim_payment", "axis")).toBe("Claim payment");
  });

  it("keeps a prefix that is not this row's module", () => {
    expect(policyTitle("ledger.refund", "axis")).toBe("Ledger refund");
  });

  it("reads a key with no prefix at all", () => {
    expect(policyTitle("payout_release", "core")).toBe("Payout release");
  });
});

describe("approvalsHeadline", () => {
  const l = labelsIn("en");

  it("reports the unread-only truth first, before anything else", () => {
    expect(approvalsHeadline("pending", 3, false, l)).toBe(l("headline.unavailable"));
  });

  it("keeps the screen's own intro for an empty, readable queue", () => {
    expect(approvalsHeadline("pending", 0, true, l)).toBe(l("intro"));
  });

  it("counts a pending queue", () => {
    expect(approvalsHeadline("pending", 5, true, l)).toBe("5 waiting on a decision.");
  });

  it("names the decision on a decided queue", () => {
    expect(approvalsHeadline("approved", 2, true, l)).toBe("2 decisions marked Approved.");
    expect(approvalsHeadline("rejected", 1, true, l)).toBe("1 decisions marked Rejected.");
  });

  it("keeps en/ar label parity for the new headline keys", () => {
    const en = labelsIn("en");
    const ar = labelsIn("ar");
    for (const key of ["headline.unavailable", "headline.pending", "headline.decided"]) {
      expect(en(key)).not.toBe(ar(key));
    }
  });
});

describe("contextTerm", () => {
  it("says a context key as words, not as camelCase", async () => {
    const { contextTerm } = await import("./approvals");
    const l = (key: string) => key;
    expect(contextTerm("requestedAmountMinor", l)).toBe("Requested amount");
    expect(contextTerm("reason", (key) => (key === "why.reason" ? "Reason given" : key))).toBe("Reason given");
  });
});

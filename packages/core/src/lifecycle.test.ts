import { describe, expect, it } from "vitest";
import {
  CASE_STATES,
  CASE_TRANSITIONS,
  CLAIM_STATES,
  CLAIM_TRANSITIONS,
  POLICY_STATES,
  POLICY_TRANSITIONS,
  assertCaseTransition,
  assertClaimTransition,
  assertPolicyTransition,
  canCaseTransition,
  canClaimTransition,
  canPolicyReach,
  canPolicyTransition,
  isCaseState,
  isClaimState,
  isPolicyState,
  quoteEndorsement,
  unearnedShareMinor
} from "./lifecycle.js";

describe("policy lifecycle", () => {
  it("refuses a hop from cancelled to active", () => {
    expect(canPolicyTransition("cancelled", "active")).toBe(false);
  });

  it("allows lapsed -> active for reinstatement", () => {
    expect(canPolicyTransition("lapsed", "active")).toBe(true);
  });

  it("keeps cancelled, renewed and ntu terminal", () => {
    for (const s of ["cancelled", "renewed", "ntu"] as const) {
      expect(POLICY_TRANSITIONS[s]).toEqual([]);
    }
  });

  it("never lets a policy go on risk without being bound first", () => {
    // draft -> active would skip BIND, which is the only financial hop.
    expect(canPolicyTransition("draft", "active")).toBe(false);
    expect(POLICY_TRANSITIONS.draft).toContain("bound");
    expect(POLICY_TRANSITIONS.bound).toContain("active");
  });

  it("canPolicyReach answers the rest of the contract's life, not just the next hop", () => {
    // The telemetry doorway asks "can this cover ever be on risk again?" before
    // discarding a batch it can never get back (`ingestBlocker`,
    // apps/api/src/engines/axis-endorse.ts). That is reachability, not one hop:
    // a draft reaches `active` through `bound`, and a lapse is cured by
    // `reinstatePolicy` over an unchanged term.
    for (const from of ["draft", "bound", "active", "lapsed"] as const) {
      expect(canPolicyReach(from, "active"), from).toBe(true);
    }
    // The true terminal set: nothing here has a path back on risk. `expired`
    // reaches only `renewed`, which is terminal — a renewal is a new contract.
    for (const from of ["cancelled", "expired", "renewed", "ntu"] as const) {
      expect(canPolicyReach(from, "active"), from).toBe(false);
    }
  });

  it("canPolicyReach terminates on the cycles the machine actually has", () => {
    // active -> lapsed -> active is a real cycle; an unguarded walk hangs on it.
    expect(canPolicyReach("active", "ntu")).toBe(false);
  });

  it("lists only known states as targets", () => {
    for (const from of POLICY_STATES) {
      for (const to of POLICY_TRANSITIONS[from]) {
        expect(POLICY_STATES).toContain(to);
        expect(from).not.toBe(to);
      }
    }
  });

  it("assertPolicyTransition throws conflict on an illegal hop and passes a legal one", () => {
    // conflict() carries the reason in `detail`; the message is the RFC 9457 title.
    expect(() => assertPolicyTransition("expired", "active")).toThrowError(
      expect.objectContaining({ status: 409, detail: "policy cannot move from expired to active" })
    );
    expect(() => assertPolicyTransition("expired", "renewed")).not.toThrow();
  });

  it("isPolicyState rejects a status the machine does not know", () => {
    expect(isPolicyState("active")).toBe(true);
    expect(isPolicyState("issued")).toBe(false);
  });
});

describe("claim lifecycle", () => {
  it("keeps reported as the initial state so seeded rows stay legal", () => {
    expect(POLICY_STATES).not.toContain("reported");
    expect(CLAIM_STATES[0]).toBe("reported");
    expect(canClaimTransition("reported", "triage")).toBe(true);
  });

  it("refuses to pay a claim that was never approved", () => {
    expect(canClaimTransition("assessing", "settling")).toBe(false);
    expect(canClaimTransition("approved", "settling")).toBe(true);
  });

  it("lets a failed payment fall back from settling to approved", () => {
    expect(canClaimTransition("settling", "approved")).toBe(true);
  });

  it("keeps withdrawn terminal and reopened reachable from closed", () => {
    expect(CLAIM_TRANSITIONS.withdrawn).toEqual([]);
    expect(canClaimTransition("closed", "reopened")).toBe(true);
  });

  it("lists only known states as targets", () => {
    for (const from of CLAIM_STATES) {
      for (const to of CLAIM_TRANSITIONS[from]) {
        expect(CLAIM_STATES).toContain(to);
        expect(from).not.toBe(to);
      }
    }
  });

  it("assertClaimTransition throws conflict on an illegal hop", () => {
    expect(() => assertClaimTransition("withdrawn", "assessing")).toThrowError(
      expect.objectContaining({ status: 409, detail: "claim cannot move from withdrawn to assessing" })
    );
  });

  it("isClaimState rejects an unknown status", () => {
    expect(isClaimState("settled")).toBe(true);
    expect(isClaimState("paid")).toBe(false);
  });
});

describe("case lifecycle", () => {
  it("keeps intake as the initial state and lets it move to quoting", () => {
    expect(CASE_STATES[0]).toBe("intake");
    expect(canCaseTransition("intake", "quoting")).toBe(true);
  });

  it("refuses to issue a case that never reached approval", () => {
    expect(canCaseTransition("review", "issued")).toBe(false);
    expect(canCaseTransition("approval", "issued")).toBe(true);
  });

  it("lets a stalled case fall back for more documents from review or awaiting_docs", () => {
    expect(canCaseTransition("review", "awaiting_docs")).toBe(true);
    expect(canCaseTransition("approval", "review")).toBe(true);
  });

  it("keeps issued and cancelled terminal, and lets a failed case retry from intake", () => {
    expect(CASE_TRANSITIONS.issued).toEqual([]);
    expect(CASE_TRANSITIONS.cancelled).toEqual([]);
    expect(canCaseTransition("failed", "intake")).toBe(true);
  });

  it("lists only known states as targets", () => {
    for (const from of CASE_STATES) {
      for (const to of CASE_TRANSITIONS[from]) {
        expect(CASE_STATES).toContain(to);
        expect(from).not.toBe(to);
      }
    }
  });

  it("assertCaseTransition throws conflict on an illegal hop", () => {
    expect(() => assertCaseTransition("issued", "intake")).toThrowError(
      expect.objectContaining({ status: 409, detail: "case cannot move from issued to intake" })
    );
  });

  it("isCaseState rejects an unknown status", () => {
    expect(isCaseState("review")).toBe(true);
    expect(isCaseState("paid")).toBe(false);
  });
});

// docs/27 F5 / design §C.2. The version stores the full-term delta so
// `Σ delta = head − v1` holds; the money that actually moves is the pro-rated
// share of it. Both numbers come out of one call so they cannot drift.
describe("quoteEndorsement", () => {
  const DAY = 86_400_000;
  const term = { startAt: 0, endAt: 100 * DAY };
  const current = { premiumMinor: 1_000_00, taxMinor: 0, commissionMinor: 200_00 };

  it("charges the remaining share of a full-term increase", () => {
    const q = quoteEndorsement({ current, term, effectiveFrom: 50 * DAY, premiumMinor: 1_200_00 });
    expect(q.proRataDays).toBe(50);
    expect(q.termDays).toBe(100);
    expect(q.premiumDeltaMinor).toBe(200_00);
    expect(q.chargeMinor).toBe(100_00);
    expect(q.commissionDeltaMinor).toBe(40_00);
    expect(q.commissionChargeMinor).toBe(20_00);
    expect(q.refundMinor).toBe(0);
  });

  it("turns a reduction into a refund, not a negative charge to collect", () => {
    const q = quoteEndorsement({ current, term, effectiveFrom: 50 * DAY, premiumMinor: 800_00 });
    expect(q.premiumDeltaMinor).toBe(-200_00);
    expect(q.chargeMinor).toBe(-100_00);
    expect(q.refundMinor).toBe(100_00);
  });

  it("moves no money when the change carries no price", () => {
    const q = quoteEndorsement({ current, term, effectiveFrom: 50 * DAY });
    expect(q.premiumDeltaMinor).toBe(0);
    expect(q.taxDeltaMinor).toBe(0);
    expect(q.commissionDeltaMinor).toBe(0);
    expect(q.chargeMinor).toBe(0);
    expect(q.refundMinor).toBe(0);
  });

  it("prices a mid-term change against a zero-premium contract without dividing by zero", () => {
    const q = quoteEndorsement({
      current: { premiumMinor: 0, taxMinor: 0, commissionMinor: 0 },
      term,
      effectiveFrom: 50 * DAY,
      premiumMinor: 100_00
    });
    expect(q.premiumDeltaMinor).toBe(100_00);
    expect(q.chargeMinor).toBe(50_00);
  });

  it("charges the whole term when the change back-dates to inception", () => {
    const q = quoteEndorsement({ current, term, effectiveFrom: 0, premiumMinor: 1_200_00 });
    expect(q.proRataDays).toBe(100);
    expect(q.chargeMinor).toBe(200_00);
  });
});

describe("unearnedShareMinor", () => {
  const DAY = 86_400_000;
  const term = { startAt: 0, endAt: 100 * DAY };

  it("claws back half the commission at the exact midpoint of the term", () => {
    expect(unearnedShareMinor(20_000, term, 50 * DAY)).toBe(10_000);
  });

  it("claws back everything cancelled at inception", () => {
    expect(unearnedShareMinor(20_000, term, 0)).toBe(20_000);
  });

  it("claws back nothing once the term has fully run", () => {
    expect(unearnedShareMinor(20_000, term, 100 * DAY)).toBe(0);
    expect(unearnedShareMinor(20_000, term, 150 * DAY)).toBe(0);
  });

  it("claws back nothing for a date before inception, clamped rather than negative", () => {
    expect(unearnedShareMinor(20_000, term, -10 * DAY)).toBe(20_000);
  });

  it("refuses a term whose end is not after its start", () => {
    expect(() => unearnedShareMinor(1, { startAt: 10, endAt: 10 }, 5)).toThrow();
  });
});

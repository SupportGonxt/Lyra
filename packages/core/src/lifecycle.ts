// docs/27 F5 / docs/specs/gap-axis-design.md §B. Contract and claim state
// machines. Lives in core, not in the API, because the routes and the
// schedulers in apps/agents both enforce it. Shape mirrors
// packages/ledger/src/types.ts TRANSITIONS + canTransition so there is one
// idiom for "legal hop" in the codebase.

import { conflict } from "./errors.js";

export const POLICY_STATES = [
  "draft", // priced, not yet bound
  "bound", // contract exists, inception in the future
  "active", // on risk
  "lapsed", // non-payment; reinstatable inside the grace window
  "cancelled", // terminated mid-term
  "expired", // ran to term end without renewal
  "renewed", // ran to term end and a successor term exists
  "ntu" // not taken up: unwound before it ever went on risk
] as const;
export type PolicyState = (typeof POLICY_STATES)[number];

/** Anything not listed is refused — no ad-hoc jumps. */
export const POLICY_TRANSITIONS: Record<PolicyState, readonly PolicyState[]> = {
  draft: ["bound", "ntu"],
  bound: ["active", "ntu", "cancelled"],
  active: ["lapsed", "cancelled", "expired", "renewed"],
  lapsed: ["active", "cancelled", "expired"],
  cancelled: [],
  expired: ["renewed"], // late renewal inside the grace window
  renewed: [],
  ntu: []
};

export function canPolicyTransition(from: PolicyState, to: PolicyState): boolean {
  return POLICY_TRANSITIONS[from].includes(to);
}

/**
 * Is `to` reachable from `from` in one hop or many?
 *
 * `canPolicyTransition` answers about the next hop; this answers about the rest
 * of the contract's life. A doorway whose refusal destroys something — the
 * telemetry ingest discards the batch on a 400 and a device drops its buffer —
 * may only refuse what is impossible forever, not what is impossible today
 * (`ingestBlocker`, apps/api/src/engines/axis-endorse.ts). Derived from
 * `POLICY_TRANSITIONS` rather than listed, so a new state is answered for by
 * editing the machine and nothing else.
 */
export function canPolicyReach(from: PolicyState, to: PolicyState): boolean {
  const seen = new Set<PolicyState>();
  const queue: PolicyState[] = [...POLICY_TRANSITIONS[from]];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (next === to) return true;
    // active -> lapsed -> active is a real cycle; without this the walk hangs.
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...POLICY_TRANSITIONS[next]);
  }
  return false;
}

export function isPolicyState(s: string): s is PolicyState {
  return (POLICY_STATES as readonly string[]).includes(s);
}

/** Throws 409 rather than returning false, for the route/scheduler call sites. */
export function assertPolicyTransition(from: PolicyState, to: PolicyState): void {
  if (!canPolicyTransition(from, to)) {
    throw conflict(`policy cannot move from ${from} to ${to}`);
  }
}

export const CLAIM_STATES = [
  "reported", // FNOL captured, coverage not yet confirmed (existing schema default)
  "triage", // coverage checked, severity + fraud scored
  "assessing",
  "awaiting_docs",
  "approved", // liability + quantum agreed
  "rejected",
  "settling", // payment authorized, money in flight
  "settled", // all indemnity paid
  "recovering", // subrogation/salvage open after settlement
  "closed",
  "reopened",
  "withdrawn"
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CLAIM_TRANSITIONS: Record<ClaimState, readonly ClaimState[]> = {
  reported: ["triage", "withdrawn"],
  triage: ["assessing", "rejected", "withdrawn"],
  assessing: ["awaiting_docs", "approved", "rejected", "withdrawn"],
  awaiting_docs: ["assessing", "withdrawn"],
  approved: ["settling"],
  settling: ["settled", "approved"], // back to approved if a payment fails
  settled: ["recovering", "closed", "reopened"],
  recovering: ["closed", "reopened"],
  rejected: ["reopened", "closed"],
  closed: ["reopened"],
  reopened: ["assessing"],
  withdrawn: []
};

export function canClaimTransition(from: ClaimState, to: ClaimState): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export function isClaimState(s: string): s is ClaimState {
  return (CLAIM_STATES as readonly string[]).includes(s);
}

export function assertClaimTransition(from: ClaimState, to: ClaimState): void {
  if (!canClaimTransition(from, to)) {
    throw conflict(`claim cannot move from ${from} to ${to}`);
  }
}

/**
 * docs/specs/gap-axis-design.md §D.9: an AXIS case's board lane IS its
 * status, so the board's assign-only reducer needs a real machine behind it
 * before it can also move a card. Mirrors CASE_STATES's schema comment
 * (packages/db/src/schema/axis.ts) and LANES's pipeline order in
 * apps/web/app/routes/axis-board.tsx (cancelled is a valid state but not a
 * lane, same as the board's own comment says).
 */
export const CASE_STATES = [
  "intake",
  "quoting",
  "awaiting_docs",
  "review",
  "approval",
  "issued",
  "failed",
  "cancelled"
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const CASE_TRANSITIONS: Record<CaseState, readonly CaseState[]> = {
  intake: ["quoting", "cancelled"],
  quoting: ["awaiting_docs", "review", "cancelled"],
  awaiting_docs: ["quoting", "review", "cancelled"],
  review: ["approval", "awaiting_docs", "failed", "cancelled"],
  approval: ["issued", "review", "failed", "cancelled"],
  issued: [],
  failed: ["intake"],
  cancelled: []
};

export function canCaseTransition(from: CaseState, to: CaseState): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export function isCaseState(s: string): s is CaseState {
  return (CASE_STATES as readonly string[]).includes(s);
}

export function assertCaseTransition(from: CaseState, to: CaseState): void {
  if (!canCaseTransition(from, to)) {
    throw conflict(`case cannot move from ${from} to ${to}`);
  }
}

/**
 * A policy version has its own tiny machine: an endorsement is a version
 * append, not a status hop on the contract (design §B.1).
 */
export const POLICY_VERSION_STATES = ["pending", "effective", "superseded", "voided"] as const;
export type PolicyVersionState = (typeof POLICY_VERSION_STATES)[number];

export const POLICY_VERSION_TRANSITIONS: Record<
  PolicyVersionState,
  readonly PolicyVersionState[]
> = {
  pending: ["effective", "voided"],
  effective: ["superseded"],
  superseded: [],
  voided: []
};

export function canPolicyVersionTransition(
  from: PolicyVersionState,
  to: PolicyVersionState
): boolean {
  return POLICY_VERSION_TRANSITIONS[from].includes(to);
}

/**
 * Pro-rata arithmetic for a mid-term change (design §D.4). Pure: the same
 * inputs price the same way in the preview endpoint, in the write endpoint and
 * in the cancellation path, so a desk never sees one number and gets charged
 * another.
 *
 * Deltas are stated for the **full term** — that is what §C.2's
 * `Σ premiumDeltaMinor = head.premium − v1.premium` invariant measures — while
 * the money that actually moves is the pro-rated slice of them.
 */
export interface EndorsementInput {
  /** The version being replaced. */
  current: { premiumMinor: number; taxMinor: number; commissionMinor: number };
  /** The whole term the contract runs for. */
  term: { startAt: number; endAt: number };
  effectiveFrom: number;
  /** New full-term premium. Absent means the change carries no price. */
  premiumMinor?: number | undefined;
}

export interface EndorsementQuote {
  proRataDays: number;
  termDays: number;
  /** Full-term, signed. */
  premiumDeltaMinor: number;
  taxDeltaMinor: number;
  commissionDeltaMinor: number;
  /** Pro-rated, signed: what the customer owes (+) or is owed (−). */
  chargeMinor: number;
  /** Pro-rated, signed: the commission difference the ENDORSE recipe posts. */
  commissionChargeMinor: number;
  /** `−chargeMinor` when the customer is owed money, else 0. */
  refundMinor: number;
}

const ENDORSE_DAY_MS = 86_400_000;

export function quoteEndorsement(input: EndorsementInput): EndorsementQuote {
  const { current, term } = input;
  const termDays = Math.max(1, Math.ceil((term.endAt - term.startAt) / ENDORSE_DAY_MS));
  const proRataDays = Math.min(
    termDays,
    Math.max(0, Math.ceil((term.endAt - input.effectiveFrom) / ENDORSE_DAY_MS))
  );
  const share = (full: number): number => Math.round((full * proRataDays) / termDays);

  const newPremium = input.premiumMinor ?? current.premiumMinor;
  // Tax and commission follow the premium at the rates the contract already
  // carries: an endorsement re-prices the risk, it does not renegotiate the
  // tax rate or the commission split.
  const ratio = current.premiumMinor > 0 ? newPremium / current.premiumMinor : 1;
  const premiumDeltaMinor = newPremium - current.premiumMinor;
  const taxDeltaMinor = Math.round(current.taxMinor * ratio) - current.taxMinor;
  const commissionDeltaMinor = Math.round(current.commissionMinor * ratio) - current.commissionMinor;
  const chargeMinor = share(premiumDeltaMinor + taxDeltaMinor);

  return {
    proRataDays,
    termDays,
    premiumDeltaMinor,
    taxDeltaMinor,
    commissionDeltaMinor,
    chargeMinor,
    commissionChargeMinor: share(commissionDeltaMinor),
    refundMinor: chargeMinor < 0 ? -chargeMinor : 0
  };
}

/**
 * docs/27 P2 "clawback posts but nothing computes what is clawable". Same day
 * math as `quoteEndorsement`'s `proRataDays`/`termDays`, extracted so a
 * clawback and an endorsement price the same term the same way: the days
 * already on risk were earned, only the remainder is unearned and clawable.
 *
 * Pure and clamped to `[0, amountMinor]` — a term that has already fully run
 * (`asOf >= term.endAt`) claws back nothing; one clawed back at inception
 * claws back all of it.
 */
export function unearnedShareMinor(amountMinor: number, term: { startAt: number; endAt: number }, asOf: number): number {
  if (term.endAt <= term.startAt) throw new Error("term.endAt must be after term.startAt");
  const termDays = Math.max(1, Math.ceil((term.endAt - term.startAt) / ENDORSE_DAY_MS));
  const remainingDays = Math.min(termDays, Math.max(0, Math.ceil((term.endAt - asOf) / ENDORSE_DAY_MS)));
  return Math.round((amountMinor * remainingDays) / termDays);
}

import { badRequest } from "./errors.js";
import { PPM } from "./commission.js";

// docs/30 AXIS 5, ADR-0106. Proportional reinsurance: what share of a policy's
// premium the tenant, as the underwriter, passes on to a reinsurer, and what
// ceding commission the reinsurer gives back for it.
//
// Pure, integer minor units, no database. The ledger posts only what this
// returns, so the rounding rule is decided once, here:
//
//   - every figure is rounded *down*. The ceded premium is what the reinsurer
//     is owed and the commission is income; neither is rounded up into
//     existence. The dust stays with the cedant as retained premium.
//   - the retained premium is the remainder, never its own calculation, so
//     ceded + retained is the premium for every input, by construction.
//   - the proportional step (premium × ceded risk ÷ risk) runs in BigInt:
//     minor-unit sums insured times minor-unit premiums leave 2^53 behind long
//     before either figure is implausible on its own.

export const TREATY_KINDS = ["quota_share", "surplus"] as const;
export type TreatyKind = (typeof TREATY_KINDS)[number];

export const TREATY_STATUSES = ["draft", "active", "closed"] as const;

export interface TreatyTerms {
  id: string;
  kind: TreatyKind;
  /** Quota share: the share of each risk ceded, in parts per million. */
  cededSharePpm?: number | null;
  /** Quota share, optional: the per-risk sum insured the share applies up to. */
  limitMinor?: number | null;
  /** Surplus: the cedant's line — the sum insured it keeps on every risk. */
  retentionMinor?: number | null;
  /** Surplus: capacity in multiples of the retention. */
  lines?: number | null;
  /** Given back by the reinsurer on what is ceded, in parts per million. */
  cedingCommissionPpm: number;
}

export interface CededShare {
  treatyId: string;
  cededPremiumMinor: number;
  /** Null when the policy states no sum insured (a quota share needs none). */
  cededSumInsuredMinor: number | null;
  commissionMinor: number;
  /** What the reinsurer is owed: ceded premium less its ceding commission. */
  netPayableMinor: number;
  /** The premium the cedant still holds after this treaty. */
  retainedPremiumMinor: number;
}

export type SkipReason = "no_sum_insured" | "nothing_to_cede";

export interface CessionPlan {
  premiumMinor: number;
  retainedPremiumMinor: number;
  cessions: CededShare[];
  skipped: { treatyId: string; reason: SkipReason }[];
}

export interface CessionInput {
  premiumMinor: number;
  sumInsuredMinor: number | null;
  /** Applied in this order, each to what the one before left retained (see `orderTreaties`). */
  treaties: readonly TreatyTerms[];
}

const wholeNonNeg = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const wholePos = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** ⌊a × b ÷ c⌋, exact for any safe-integer inputs. */
function mulDiv(a: number, b: number, c: number): number {
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}

/**
 * Why these terms cannot be a treaty, or null. Shared by the planner (which
 * refuses to cede against incoherent terms) and the write path (which refuses
 * to store them), so the two cannot disagree about what a treaty is.
 */
export function treatyProblem(
  t: Partial<TreatyTerms> & { effectiveFrom?: number | null; effectiveTo?: number | null }
): string | null {
  if (!TREATY_KINDS.includes(t.kind as TreatyKind)) return `kind must be one of ${TREATY_KINDS.join(", ")}`;
  if (t.kind === "quota_share") {
    if (!wholePos(t.cededSharePpm) || t.cededSharePpm > PPM) {
      return "a quota share needs cededSharePpm above 0 and at most 1000000";
    }
    if (t.limitMinor != null && !wholePos(t.limitMinor)) return "limitMinor, when stated, must be a positive whole amount";
  } else {
    if (!wholePos(t.retentionMinor)) return "a surplus treaty needs a positive retentionMinor";
    if (!wholePos(t.lines)) return "a surplus treaty needs at least one line (lines)";
  }
  if (!wholeNonNeg(t.cedingCommissionPpm) || t.cedingCommissionPpm > PPM) {
    return "cedingCommissionPpm must be between 0 and 1000000";
  }
  if (t.effectiveFrom != null && t.effectiveTo != null && t.effectiveTo <= t.effectiveFrom) {
    return "the effective period must end after it starts";
  }
  return null;
}

/** Priority first, then id: the same treaties always plan the same cessions. */
export function orderTreaties<T extends { id: string; priority: number }>(treaties: readonly T[]): T[] {
  return [...treaties].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Whether a treaty attaches to a policy. Risks-attaching on the policy's start
 * date, `[effectiveFrom, effectiveTo)`. A treaty with no product line covers
 * every line; a policy whose line is unknown is covered only by such a treaty.
 * Currency must match: the cession posts in the policy's currency, and a
 * treaty written in another has no rate this function could honestly apply.
 */
export function treatyApplies(
  treaty: { status: string; productLine: string | null; currency: string; effectiveFrom: number; effectiveTo: number },
  policy: { line: string | null; currency: string; startAt: number }
): boolean {
  return (
    treaty.status === "active" &&
    (treaty.productLine === null || treaty.productLine === policy.line) &&
    treaty.currency === policy.currency &&
    policy.startAt >= treaty.effectiveFrom &&
    policy.startAt < treaty.effectiveTo
  );
}

/** The part of the retained risk (and so of the retained premium) this treaty takes. */
function cededRisk(
  t: TreatyTerms,
  premiumMinor: number,
  siMinor: number | null
): { premium: number; si: number | null } | SkipReason {
  if (t.kind === "quota_share") {
    const share = t.cededSharePpm as number;
    if (t.limitMinor == null) {
      return { premium: mulDiv(premiumMinor, share, PPM), si: siMinor === null ? null : mulDiv(siMinor, share, PPM) };
    }
    if (siMinor === null) return "no_sum_insured";
    const si = mulDiv(Math.min(siMinor, t.limitMinor), share, PPM);
    return { premium: siMinor === 0 ? 0 : mulDiv(premiumMinor, si, siMinor), si };
  }
  if (siMinor === null) return "no_sum_insured";
  const retention = t.retentionMinor as number;
  const si = Math.min(Math.max(siMinor - retention, 0), (t.lines as number) * retention);
  return { premium: siMinor === 0 ? 0 : mulDiv(premiumMinor, si, siMinor), si };
}

export function planCessions(input: CessionInput): CessionPlan {
  if (!wholeNonNeg(input.premiumMinor)) throw badRequest("premium must be a non-negative whole number of minor units");
  if (input.sumInsuredMinor !== null && !wholeNonNeg(input.sumInsuredMinor)) {
    throw badRequest("sum insured must be a non-negative whole number of minor units");
  }

  let premium = input.premiumMinor;
  let si = input.sumInsuredMinor;
  const cessions: CededShare[] = [];
  const skipped: CessionPlan["skipped"] = [];

  for (const t of input.treaties) {
    const problem = treatyProblem(t);
    if (problem) throw badRequest(`treaty ${t.id}: ${problem}`);

    const taken = cededRisk(t, premium, si);
    if (typeof taken === "string") {
      skipped.push({ treatyId: t.id, reason: taken });
      continue;
    }
    if (taken.premium === 0) {
      skipped.push({ treatyId: t.id, reason: "nothing_to_cede" });
      continue;
    }
    const commissionMinor = mulDiv(taken.premium, t.cedingCommissionPpm, PPM);
    premium -= taken.premium;
    if (si !== null && taken.si !== null) si -= taken.si;
    cessions.push({
      treatyId: t.id,
      cededPremiumMinor: taken.premium,
      cededSumInsuredMinor: taken.si,
      commissionMinor,
      netPayableMinor: taken.premium - commissionMinor,
      retainedPremiumMinor: premium
    });
  }

  return { premiumMinor: input.premiumMinor, retainedPremiumMinor: premium, cessions, skipped };
}

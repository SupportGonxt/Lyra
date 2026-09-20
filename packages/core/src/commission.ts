import { and, eq, isNull, or, lte, gt, desc } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, notFound } from "./errors.js";
import { taxPpmOf, taxTreatment } from "./tax.js";
import type { Ctx } from "./context.js";

// The aggregator's money split. Three parties on every sale: the underwriter
// pays us commission, we pass a share to the channel that sold it, we keep the
// rest. All arithmetic is integer minor units; rates are ppm (12.5% = 125_000).

export const PPM = 1_000_000;

/** Round-half-up on integers — the same rule the statements use, so they reconcile. */
export function applyPpm(amountMinor: number, ppm: number): number {
  if (!Number.isSafeInteger(amountMinor)) throw badRequest("amount must be an integer minor amount");
  const sign = amountMinor < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(amountMinor) * ppm + PPM / 2) / PPM);
}

// ADR-0084. Depth beyond a flat rate: a ladder over the premium/volume of a
// single sale, a bonus once a producer crosses a cumulative period volume, and
// an override a second party earns on top. All three are optional and additive
// to the flat-rate shape above them — a caller that passes none of them gets
// exactly the arithmetic this file always had.

/** One band of a ladder. The last tier omits `uptoMinor` — open-ended. */
export interface CommissionTier {
  /** Cumulative amount up to which this rate applies, minor units. */
  uptoMinor?: number;
  ratePpm: number;
}

export interface VolumeBonusInput {
  /** Cumulative volume already earned in the period, before this sale. Caller-supplied: see ADR-0084. */
  priorVolumeMinor: number;
  /** Once prior + this sale crosses this cumulative volume, the bonus applies to the portion above it. */
  thresholdMinor: number;
  /** Extra rate, ppm of the portion of this sale above the threshold. */
  bonusPpm: number;
}

export interface CommissionOverrideInput {
  /** A second party's share of our gross commission, ppm — paid on top, not deducted from netMinor. */
  overridePpm: number;
}

/** A stored `dist_commission_rates.structure_json`, parsed. */
export interface CommissionStructure {
  tiers?: CommissionTier[];
  volumeBonus?: Omit<VolumeBonusInput, "priorVolumeMinor">;
  overridePpm?: number;
}

/**
 * The ladder's commission over `amountMinor`, banded from zero. Each band is
 * rounded with the same round-half-up `applyPpm` every other figure here uses.
 * The last tier must be open-ended: a ladder that stops short of the amount
 * would otherwise silently under-credit the tail rather than say so.
 */
export function tieredCommissionMinor(amountMinor: number, tiers: readonly CommissionTier[]): number {
  if (!tiers.length) throw badRequest("tiers must not be empty");
  let remaining = amountMinor;
  let from = 0;
  let total = 0;
  for (const [i, tier] of tiers.entries()) {
    if (tier.ratePpm < 0 || tier.ratePpm > PPM) throw badRequest("tier rate out of range");
    const isLast = i === tiers.length - 1;
    if (isLast && tier.uptoMinor !== undefined) {
      throw badRequest("the last tier must be open-ended (no uptoMinor)");
    }
    if (tier.uptoMinor !== undefined && tier.uptoMinor <= from) {
      throw badRequest("tier bands must be strictly increasing");
    }
    const bandWidth = tier.uptoMinor === undefined ? remaining : Math.min(remaining, tier.uptoMinor - from);
    if (bandWidth > 0) {
      total += applyPpm(bandWidth, tier.ratePpm);
      remaining -= bandWidth;
    }
    from = tier.uptoMinor ?? from;
    if (remaining <= 0) break;
  }
  return total;
}

/**
 * The bonus applies only to the slice of *this* sale that sits above the
 * threshold — a sale that alone crosses it is bonused only on the excess, one
 * already over it beforehand is bonused in full.
 */
export function volumeBonusMinor(amountMinor: number, bonus: VolumeBonusInput): number {
  if (bonus.bonusPpm < 0 || bonus.bonusPpm > PPM) throw badRequest("bonus rate out of range");
  const cumulativeAfter = bonus.priorVolumeMinor + amountMinor;
  if (cumulativeAfter <= bonus.thresholdMinor) return 0;
  const overThreshold = Math.min(amountMinor, cumulativeAfter - bonus.thresholdMinor);
  return applyPpm(overThreshold, bonus.bonusPpm);
}

/** Defensive: a malformed or absent `structure_json` resolves as flat, never a throw at read time. */
export function commissionStructureOf(json: string | null | undefined): CommissionStructure {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as CommissionStructure;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export interface CommissionInput {
  premiumMinor: number;
  /** What the underwriter pays us, ppm of premium. Ignored when `tiers` is given. */
  baseCommissionPpm: number;
  /** Share of *our commission* passed to the channel, ppm. 0 for b2c. */
  channelSharePpm?: number;
  /** Flat per-policy fee to the channel, on top of the share. */
  flatFeeMinor?: number;
  /** Tax withheld on our net commission (VAT on brokerage), ppm. */
  taxPpm?: number;
  /** ADR-0084. Replaces `baseCommissionPpm` when present. */
  tiers?: CommissionTier[];
  /** ADR-0084. Added on top of the (flat or tiered) base gross. */
  volumeBonus?: VolumeBonusInput;
  /** ADR-0084. A second party's cut of gross, reported, never deducted here. */
  override?: CommissionOverrideInput;
}

export interface CommissionSplit {
  /** Receivable from the underwriter. Includes any volume bonus. */
  grossMinor: number;
  /** Payable to the channel. */
  channelMinor: number;
  taxMinor: number;
  /** What we keep: gross - channel - tax. */
  netMinor: number;
  /** ADR-0084. Already included in grossMinor; broken out for the statement. */
  bonusMinor: number;
  /** ADR-0084. Ppm of grossMinor for a second party, on top — not subtracted from netMinor. */
  overrideMinor: number;
}

/**
 * A channel is never paid more than the underwriter pays us — a negative net is
 * a mis-configured rate, not a loss to absorb silently.
 */
export function splitCommission(input: CommissionInput): CommissionSplit {
  const { premiumMinor } = input;
  if (premiumMinor < 0) throw badRequest("premium must not be negative");

  let baseGrossMinor: number;
  if (input.tiers) {
    baseGrossMinor = tieredCommissionMinor(premiumMinor, input.tiers);
  } else {
    if (input.baseCommissionPpm < 0 || input.baseCommissionPpm > PPM) {
      throw badRequest("base commission out of range");
    }
    baseGrossMinor = applyPpm(premiumMinor, input.baseCommissionPpm);
  }

  const bonusMinor = input.volumeBonus ? volumeBonusMinor(premiumMinor, input.volumeBonus) : 0;
  const grossMinor = baseGrossMinor + bonusMinor;

  const sharePpm = input.channelSharePpm ?? 0;
  if (sharePpm < 0 || sharePpm > PPM) throw badRequest("channel share out of range");

  const channelMinor = applyPpm(grossMinor, sharePpm) + (input.flatFeeMinor ?? 0);
  if (channelMinor > grossMinor) throw badRequest("channel commission exceeds the commission received");

  const taxMinor = applyPpm(grossMinor - channelMinor, input.taxPpm ?? 0);
  const overrideMinor = input.override ? applyPpm(grossMinor, input.override.overridePpm) : 0;
  return {
    grossMinor,
    channelMinor,
    taxMinor,
    bonusMinor,
    overrideMinor,
    netMinor: grossMinor - channelMinor - taxMinor
  };
}

export interface RateQuery {
  channelId: string;
  offeringId?: string;
  productId?: string;
  line?: string;
  /** Sale date — a settlement re-derives the rate that applied then, not today's. */
  at?: number;
}

type RateRow = typeof schema.distCommissionRates.$inferSelect;

/** Most specific wins: offering > product > line > channel default. */
function specificity(r: RateRow): number {
  if (r.offeringId) return 3;
  if (r.productId) return 2;
  if (r.line) return 1;
  return 0;
}

/**
 * The rate in force for a sale. Overlapping rows are legal (a product override
 * inside a channel-wide default); the most specific one wins, ties broken by
 * the later effective_from.
 */
export async function resolveRate(ctx: Ctx, q: RateQuery): Promise<RateRow | null> {
  const at = q.at ?? ctx.now;
  const t = schema.distCommissionRates;
  const rows = await ctx.db
    .select()
    .from(t)
    .where(
      and(
        eq(t.tenantId, ctx.tenantId),
        eq(t.channelId, q.channelId),
        lte(t.effectiveFrom, at),
        or(isNull(t.effectiveTo), gt(t.effectiveTo, at))
      )
    )
    .orderBy(desc(t.effectiveFrom));

  const applicable = rows.filter(
    (r) =>
      (!r.offeringId || r.offeringId === q.offeringId) &&
      (!r.productId || r.productId === q.productId) &&
      (!r.line || r.line === q.line)
  );
  applicable.sort((a, b) => specificity(b) - specificity(a) || b.effectiveFrom - a.effectiveFrom);
  return applicable[0] ?? null;
}

/**
 * The split for a real sale: resolves the rate, falls back to the offering's own
 * base commission and the channel default, and stamps which rate row applied so
 * the entry stays reproducible after the rate changes.
 *
 * docs/27 F17. Tax is resolved the same way and stamped the same way. A caller
 * may *state* `taxPpm` — an insurer statement carries its own rate, a migration
 * restates history — and then `taxRuleId` is null because no rule was consulted.
 * A caller that states nothing gets the market rulepack's rate, or a refusal:
 * docs/19 §5.3 says tax is never inferred, and the zero this used to default to
 * was an inference.
 */
export async function quoteCommission(
  ctx: Ctx,
  args: {
    offeringId: string;
    channelId: string;
    premiumMinor: number;
    taxPpm?: number;
    /** Overrides the tenant's policy market for a cross-border supply. */
    taxMarket?: string;
    /** Rulepack code; defaults to `commission`. */
    taxCode?: string;
    /** ADR-0084: cumulative volume already earned this period, for the winning rate's volumeBonus, if any. */
    priorVolumeMinor?: number;
    at?: number;
  }
): Promise<
  CommissionSplit & { rateId: string | null; basePpm: number; sharePpm: number; taxRuleId: string | null }
> {
  const offering = (
    await ctx.db
      .select()
      .from(schema.distOfferings)
      .where(
        and(
          eq(schema.distOfferings.tenantId, ctx.tenantId),
          eq(schema.distOfferings.id, args.offeringId),
          isNull(schema.distOfferings.deletedAt)
        )
      )
      .limit(1)
  )[0];
  if (!offering) throw notFound("offering");

  const channel = (
    await ctx.db
      .select()
      .from(schema.distChannels)
      .where(
        and(
          eq(schema.distChannels.tenantId, ctx.tenantId),
          eq(schema.distChannels.id, args.channelId),
          isNull(schema.distChannels.deletedAt)
        )
      )
      .limit(1)
  )[0];
  if (!channel) throw notFound("channel");

  const rate = await resolveRate(ctx, {
    channelId: args.channelId,
    offeringId: args.offeringId,
    productId: offering.productId,
    ...(args.at !== undefined ? { at: args.at } : {})
  });

  const basePpm = rate?.baseCommissionPpm ?? offering.baseCommissionPpm;
  // ponytail: b2c channels have no share of their own, so the default is 0 — a
  // house channel keeping a "share" would double-count our own commission.
  const sharePpm = rate?.channelSharePpm ?? (channel.kind === "b2b" ? channel.defaultCommissionPpm ?? 0 : 0);

  // Stated beats resolved; nothing at all is refused, never assumed to be zero.
  const tax =
    args.taxPpm !== undefined
      ? { ppm: args.taxPpm, ruleId: null }
      : await (async () => {
          const t = await taxTreatment(ctx, {
            ...(args.taxMarket !== undefined ? { market: args.taxMarket } : {}),
            ...(args.taxCode !== undefined ? { code: args.taxCode } : {}),
            ...(args.at !== undefined ? { at: args.at } : {})
          });
          return { ppm: taxPpmOf(t), ruleId: t.ruleId };
        })();

  const structure = commissionStructureOf(rate?.structureJson);
  const split = splitCommission({
    premiumMinor: args.premiumMinor,
    baseCommissionPpm: basePpm,
    channelSharePpm: sharePpm,
    flatFeeMinor: rate?.flatFeeMinor ?? 0,
    taxPpm: tax.ppm,
    ...(structure.tiers ? { tiers: structure.tiers } : {}),
    ...(structure.volumeBonus
      ? { volumeBonus: { priorVolumeMinor: args.priorVolumeMinor ?? 0, ...structure.volumeBonus } }
      : {}),
    ...(structure.overridePpm !== undefined ? { override: { overridePpm: structure.overridePpm } } : {})
  });
  return { ...split, rateId: rate?.id ?? null, basePpm, sharePpm, taxRuleId: tax.ruleId };
}

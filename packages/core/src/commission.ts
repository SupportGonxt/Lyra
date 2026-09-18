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

export interface CommissionInput {
  premiumMinor: number;
  /** What the underwriter pays us, ppm of premium. */
  baseCommissionPpm: number;
  /** Share of *our commission* passed to the channel, ppm. 0 for b2c. */
  channelSharePpm?: number;
  /** Flat per-policy fee to the channel, on top of the share. */
  flatFeeMinor?: number;
  /** Tax withheld on our net commission (VAT on brokerage), ppm. */
  taxPpm?: number;
}

export interface CommissionSplit {
  /** Receivable from the underwriter. */
  grossMinor: number;
  /** Payable to the channel. */
  channelMinor: number;
  taxMinor: number;
  /** What we keep: gross - channel - tax. */
  netMinor: number;
}

/**
 * A channel is never paid more than the underwriter pays us — a negative net is
 * a mis-configured rate, not a loss to absorb silently.
 */
export function splitCommission(input: CommissionInput): CommissionSplit {
  const { premiumMinor, baseCommissionPpm } = input;
  if (premiumMinor < 0) throw badRequest("premium must not be negative");
  if (baseCommissionPpm < 0 || baseCommissionPpm > PPM) throw badRequest("base commission out of range");
  const sharePpm = input.channelSharePpm ?? 0;
  if (sharePpm < 0 || sharePpm > PPM) throw badRequest("channel share out of range");

  const grossMinor = applyPpm(premiumMinor, baseCommissionPpm);
  const channelMinor = applyPpm(grossMinor, sharePpm) + (input.flatFeeMinor ?? 0);
  if (channelMinor > grossMinor) throw badRequest("channel commission exceeds the commission received");

  const taxMinor = applyPpm(grossMinor - channelMinor, input.taxPpm ?? 0);
  return { grossMinor, channelMinor, taxMinor, netMinor: grossMinor - channelMinor - taxMinor };
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

  const split = splitCommission({
    premiumMinor: args.premiumMinor,
    baseCommissionPpm: basePpm,
    channelSharePpm: sharePpm,
    flatFeeMinor: rate?.flatFeeMinor ?? 0,
    taxPpm: tax.ppm
  });
  return { ...split, rateId: rate?.id ?? null, basePpm, sharePpm, taxRuleId: tax.ruleId };
}

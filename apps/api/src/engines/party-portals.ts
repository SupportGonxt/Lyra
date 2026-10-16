import {
  and,
  desc,
  eq
} from "drizzle-orm"
import { schema } from "@lyra/db";
import { checkKAnonymity, coverageOf, kAnonymityFloor, notFound, type Coverage, type Ctx, MONEY_STATES } from "@lyra/core";
import { activeSubscriberIds } from "../resources.js";

// The two external doors (docs: PORTALS-DESIGN-AND-AUDIT.md). A supplier
// (insurer) sees its panel position and what the tenant's data products owe it;
// a channel (broker/embed) sees its book and its own commission. Each view is
// assembled here so the filtering rules live in one place and the route stays a
// gate + a call.
//
// Two rules the assembly exists to hold:
//   - the k-anonymity floor. A bench row below the floor names one counterparty,
//     so it is dropped from the view entirely — never zeroed, which would read
//     as "you win nothing".
//   - one wall between the two sides of a sale. A channel sees
//     `channelCommissionMinor` (its share) and never the tenant's net or the
//     insurer's gross; a supplier sees the batch between it and the tenant and
//     never another provider's.

/** Settlement counterparty refs, built the way the engine builds them. */
const providerRef = (id: string) => `provider:${id}`;
const channelRef = (id: string) => `channel:${id}`;

function parseArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- supplier */

export interface SupplierPortalView {
  supplier: {
    id: string;
    name: string;
    kind: string;
    lines: string[];
    currency: string | null;
    panelStatus: string;
    settlementTerms: Record<string, unknown> | null;
  };
  /** Rows below the k-anonymity floor are absent, not zeroed. */
  position: {
    line: string;
    period: string;
    winRate: number | null;
    priceIndex: number | null;
    marketPriceIndex: number | null;
    volume: number;
    /** ADR-0127. The column's two facts, kept apart: `terms` is where our
     *  wording differs on a term, `reach` is the count of requests the panel
     *  answered and this provider never did. Null is "nothing recorded", which
     *  the page renders as its empty state — and a reach row is a fact, never
     *  an empty list, which is what `parseArray` used to make of both. */
    coverage: Coverage | null;
  }[];
  kAnonymityFloor: number;
  products: { id: string; name: string; delivery: string; aggregationMin: number; consentBasis: string }[];
  settlement: {
    currency: string | null;
    /** Money in, from the underwriter — the batch total across every state. */
    receivableMinor: number;
    batches: {
      id: string;
      period: string;
      grossMinor: number;
      adjustmentsMinor: number;
      netMinor: number;
      state: string;
      externalRef: string | null;
    }[];
  };
  /** Stated, not implied: ranking is declared and nobody pays for position. */
  ranking: { declared: true; payForPosition: false };
}

export async function supplierPortalView(ctx: Ctx, providerId: string): Promise<SupplierPortalView> {
  const [provider] = await ctx.db
    .select()
    .from(schema.providers)
    .where(and(eq(schema.providers.tenantId, ctx.tenantId), eq(schema.providers.id, providerId)))
    .limit(1);
  if (!provider) throw notFound("supplier");

  const floor = kAnonymityFloor(ctx.policy, "scout");
  const bench = await ctx.db
    .select()
    .from(schema.scoutPanelBench)
    .where(and(eq(schema.scoutPanelBench.tenantId, ctx.tenantId), eq(schema.scoutPanelBench.providerId, providerId)))
    .orderBy(desc(schema.scoutPanelBench.period));
  const position = bench
    .filter((row) => checkKAnonymity(row.volume, floor).allowed)
    .map((row) => ({
      line: row.line,
      period: row.period,
      winRate: row.winRate,
      priceIndex: row.ourPriceIdx,
      marketPriceIndex: row.marketPriceIdx,
      volume: row.volume,
      coverage: coverageOf(row.coverageGapsJson)
    }));

  // Published, and this provider is an active subscriber — the same pair of
  // rules resources.ts applies to a scoped provider.viewer's read.
  const published = await ctx.db
    .select()
    .from(schema.scoutDataProducts)
    .where(and(eq(schema.scoutDataProducts.tenantId, ctx.tenantId), eq(schema.scoutDataProducts.status, "published")));
  const products = published
    .filter((row) => activeSubscriberIds(row.subscribersJson).includes(providerId))
    .map((row) => ({
      id: row.id,
      name: row.name,
      delivery: row.delivery,
      aggregationMin: row.aggregationMin,
      consentBasis: row.consentBasis
    }));

  const batches = await ctx.db
    .select()
    .from(schema.ledgerSettlements)
    .where(
      and(
        eq(schema.ledgerSettlements.tenantId, ctx.tenantId),
        eq(schema.ledgerSettlements.counterpartyKind, "insurer"),
        eq(schema.ledgerSettlements.counterpartyRef, providerRef(providerId))
      )
    )
    .orderBy(desc(schema.ledgerSettlements.period));

  return {
    supplier: {
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      lines: parseArray(provider.linesJson),
      currency: provider.currency,
      panelStatus: provider.panelStatus,
      settlementTerms: parseObject(provider.settlementTermsJson)
    },
    position,
    kAnonymityFloor: floor,
    products,
    settlement: {
      currency: batches[0]?.currency ?? provider.currency,
      receivableMinor: batches.reduce((sum, row) => sum + row.netMinor, 0),
      batches: batches.map((row) => ({
        id: row.id,
        period: row.period,
        grossMinor: row.grossMinor,
        adjustmentsMinor: row.adjustmentsMinor,
        netMinor: row.netMinor,
        state: row.state,
        externalRef: row.externalRef
      }))
    },
    ranking: { declared: true, payForPosition: false }
  };
}

/* ----------------------------------------------------------------- channel */

/** The commission states a channel's money can be in, in the order money moves. */
// From `@lyra/core/portal` — one home for the vocabulary, so an engine and a screen
// cannot drift apart about which states exist. That drift is the sweep's PORTALS finding.

export interface ChannelPortalView {
  channel: {
    id: string;
    key: string;
    kind: string;
    name: Record<string, string>;
    medium: string;
    collectsPayment: string;
    currency: string | null;
    status: string;
    defaultCommissionPpm: number | null;
    settlementTerms: Record<string, unknown> | null;
  };
  totals: { entries: number; grossMinor: number; yourShareMinor: number; currency: string | null };
  /** The channel's own share, bucketed by where the money is. */
  money: Record<(typeof MONEY_STATES)[number], number>;
  book: {
    id: string;
    subjectRef: string | null;
    offeringId: string | null;
    kind: string;
    premiumMinor: number;
    yourShareMinor: number;
    currency: string;
    state: string;
    earnedAt: number | null;
  }[];
  settlements: {
    id: string;
    period: string;
    netMinor: number;
    currency: string;
    state: string;
    externalRef: string | null;
  }[];
  agreement: { kind: string; version: number; state: string; effectiveFrom: number | null; effectiveTo: number | null } | null;
}

export async function channelPortalView(ctx: Ctx, channelId: string): Promise<ChannelPortalView> {
  const [channel] = await ctx.db
    .select()
    .from(schema.distChannels)
    .where(and(eq(schema.distChannels.tenantId, ctx.tenantId), eq(schema.distChannels.id, channelId)))
    .limit(1);
  if (!channel) throw notFound("channel");

  const entries = await ctx.db
    .select()
    .from(schema.distCommissionEntries)
    .where(and(eq(schema.distCommissionEntries.tenantId, ctx.tenantId), eq(schema.distCommissionEntries.channelId, channelId)))
    .orderBy(desc(schema.distCommissionEntries.createdAt), desc(schema.distCommissionEntries.id));

  const money = Object.fromEntries(MONEY_STATES.map((state) => [state, 0])) as ChannelPortalView["money"];
  for (const row of entries) {
    if ((MONEY_STATES as readonly string[]).includes(row.state)) {
      money[row.state as (typeof MONEY_STATES)[number]] += row.channelCommissionMinor;
    }
  }

  const settlements = await ctx.db
    .select()
    .from(schema.ledgerSettlements)
    .where(
      and(
        eq(schema.ledgerSettlements.tenantId, ctx.tenantId),
        eq(schema.ledgerSettlements.counterpartyKind, "partner"),
        eq(schema.ledgerSettlements.counterpartyRef, channelRef(channelId))
      )
    )
    .orderBy(desc(schema.ledgerSettlements.period));

  // The signed agreement behind the channel's partner row, if it has one. A
  // channel with no partner (a b2c door) has no agreement to show.
  const agreements = channel.partnerId
    ? await ctx.db
        .select()
        .from(schema.distPartnerAgreements)
        .where(
          and(
            eq(schema.distPartnerAgreements.tenantId, ctx.tenantId),
            eq(schema.distPartnerAgreements.partnerId, channel.partnerId)
          )
        )
        .orderBy(desc(schema.distPartnerAgreements.version))
        .limit(1)
    : [];
  const agreement = agreements[0];

  return {
    channel: {
      id: channel.id,
      key: channel.key,
      kind: channel.kind,
      name: parseObject(channel.nameJson) as Record<string, string> | null ?? {},
      medium: channel.medium,
      collectsPayment: channel.collectsPayment,
      currency: channel.currency,
      status: channel.status,
      defaultCommissionPpm: channel.defaultCommissionPpm,
      settlementTerms: parseObject(channel.settlementTermsJson)
    },
    totals: {
      entries: entries.length,
      grossMinor: entries.reduce((sum, row) => sum + row.premiumMinor, 0),
      // `channelCommissionMinor` is the channel's own share. `net` (the tenant's
      // margin) and `gross` (the insurer receivable) never leave this engine.
      yourShareMinor: entries.reduce((sum, row) => sum + row.channelCommissionMinor, 0),
      currency: entries[0]?.currency ?? channel.currency
    },
    money,
    book: entries.slice(0, 50).map((row) => ({
      id: row.id,
      subjectRef: row.policyId ?? row.saleRef,
      offeringId: row.offeringId,
      kind: row.kind,
      premiumMinor: row.premiumMinor,
      yourShareMinor: row.channelCommissionMinor,
      currency: row.currency,
      state: row.state,
      earnedAt: row.earnedAt
    })),
    settlements: settlements.map((row) => ({
      id: row.id,
      period: row.period,
      netMinor: row.netMinor,
      currency: row.currency,
      state: row.state,
      externalRef: row.externalRef
    })),
    agreement: agreement
      ? {
          kind: agreement.kind,
          version: agreement.version,
          state: agreement.state,
          effectiveFrom: agreement.effectiveFrom,
          effectiveTo: agreement.effectiveTo
        }
      : null
  };
}

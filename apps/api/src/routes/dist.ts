import { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql, type AnyColumn } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  canonicalJson,
  conflict,
  emit,
  gate,
  notFound,
  require_,
  sha256Hex,
  unearnedShareMinor,
  withIdempotency,
  type Ctx
} from "@lyra/core";
import { body, created, listParams, InstantMs } from "../http.js";
import { one } from "../rows.js";
import type { QuoteOutcome } from "../engines/rating.js";
import { quoterFor } from "../engines/dist-quoter.js";
import { runShop } from "../engines/shop.js";
import { decideOffer, markSurfaced, proposeOffers } from "../engines/nbo.js";
import { qualifyReferral, settleReferral } from "../engines/referral-settlement.js";
import { accrueCommission } from "../engines/commission-accrual.js";
import type { App } from "../env.js";

// docs/05 §4-6. The aggregator's own verbs: shop a risk across the panel, show
// the customer the comparison, convert one line of it into a case, and keep the
// three-way commission straight. Generated CRUD covers the rows; this covers
// what happens to them.

export const distRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/* --------------------------------------------------------------- fan-out */

const ShopBody = z.object({
  productId: z.string().min(1),
  channelId: z.string().min(1),
  /** A shop is the start of a sale, and a sale needs someone to sell to: the
   *  bind refuses a request with no customer, so the shop refuses it first
   *  (docs/27, 2026-09-23). The portal names its visitor the same way. */
  customerId: z.string().min(1),
  consentId: z.string().optional(),
  caseId: z.string().optional(),
  /** The risk, in the product's rating inputs. */
  inputs: z.record(z.string(), z.unknown()),
  currency: z.string().length(3).default("ZAR")
});

/**
 * Comparative shop. One request, every eligible offering priced, one ranked
 * comparison back. Declines and errors are returned alongside the quotes,
 * because "six of nine underwriters would not touch this" is an answer the
 * operator needs and silently dropping them looks like a thin panel.
 */
distRoutes.post("/quote-requests/shop", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:quote_requests:create", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, ShopBody);

  return c.json(
    await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.shop", input, async () => {
      const channel = await one(ctx, schema.distChannels, input.channelId);
      if (!channel) throw notFound("channel");
      if (channel.status !== "active") throw conflict("channel is not active");

      // Passing a customer's details to third-party underwriters is data sharing
      // and needs a recorded basis. No consent, no fan-out (docs/12 §3).
      if (!input.consentId) throw badRequest("consentId is required when a customer is identified");
      const consent = await one(ctx, schema.consents, input.consentId);
      if (!consent || consent.customerId !== input.customerId) throw badRequest("consent does not match customer");
      const purposes = JSON.parse(consent.purposesJson) as { dataSharing?: boolean };
      if (!purposes.dataSharing) throw badRequest("consent does not permit sharing with providers");

      const { request, responses } = await runShop(ctx, {
        request: {
          id: newId("qr", ctx.now),
          tenantId: ctx.tenantId,
          caseId: input.caseId ?? null,
          customerId: input.customerId,
          channelId: input.channelId,
          productId: input.productId,
          inputsJson: JSON.stringify(input.inputs),
          consentId: input.consentId ?? null,
          currency: input.currency,
          expiresAt: ctx.now + 7 * 86_400_000,
          createdAt: ctx.now,
          updatedAt: ctx.now
        },
        channelKey: channel.key,
        inputs: input.inputs,
        quoter: quoterFor(c.env)
      });

      await audit(ctx, {
        action: "dist.quote_request.shop",
        subjectRef: request.id,
        after: { fanout: request.fanoutCount, quoted: responses.filter((r) => r.state === "quoted").length }
      });
      await emit(ctx, {
        module: "dist",
        type: "dist.quote_request.fanned_out",
        subject: request.id,
        data: { productId: input.productId, channelId: input.channelId, fanout: request.fanoutCount }
      });

      return { request, responses };
    }),
    201
  );
});

/** The comparison as the customer sees it: quotes ranked, declines summarised. */
distRoutes.get("/quote-requests/:id/comparison", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:quote_requests:read", { tenantId: ctx.tenantId, module: "dist" });
  const request = await one(ctx, schema.distQuoteRequests, c.req.param("id"));
  if (!request) throw notFound("quote request");

  const responses = await ctx.db
    .select()
    .from(schema.distQuoteResponses)
    .where(
      and(
        eq(schema.distQuoteResponses.tenantId, ctx.tenantId),
        eq(schema.distQuoteResponses.requestId, request.id)
      )
    );

  const offeringIds = responses.map((r) => r.offeringId);
  const offerings = offeringIds.length
    ? await ctx.db
        .select()
        .from(schema.distOfferings)
        .where(and(eq(schema.distOfferings.tenantId, ctx.tenantId), inArray(schema.distOfferings.id, offeringIds)))
    : [];
  const byOffering = new Map(offerings.map((o) => [o.id, o]));
  // docs/30 Distribution 5: a bound quote names its policy, so a revisit shows
  // the policy instead of offering the bind again (which the API refuses).
  const responseIds = responses.map((r) => r.id);
  const bound = responseIds.length
    ? await ctx.db
        .select({ responseId: schema.axisPolicyVersions.quoteResponseId, policyId: schema.axisPolicyVersions.policyId })
        .from(schema.axisPolicyVersions)
        .where(and(eq(schema.axisPolicyVersions.tenantId, ctx.tenantId), inArray(schema.axisPolicyVersions.quoteResponseId, responseIds)))
    : [];
  const policyOf = new Map(bound.map((b) => [b.responseId, b.policyId]));

  const quoted = responses
    .filter((r) => r.state === "quoted")
    .sort((a, b) => (a.priceRank ?? 99) - (b.priceRank ?? 99))
    .map((r) => ({
      ...r,
      // Commission is ours, not the customer's business; strip it unless the
      // caller is staff with the permission to see the margin.
      ...(canSeeMargin(ctx) ? {} : { commissionPpm: null, commissionMinor: null, channelCommissionMinor: null }),
      offering: byOffering.get(r.offeringId) ?? null,
      policyId: policyOf.get(r.id) ?? null
    }));

  return c.json({
    request,
    quotes: quoted,
    unavailable: responses
      .filter((r) => r.state !== "quoted")
      .map((r) => ({ offeringId: r.offeringId, providerId: r.providerId, state: r.state, reason: r.declineReason })),
    bestValue: quoted.slice().sort((a, b) => (b.valueScore ?? 0) - (a.valueScore ?? 0))[0]?.id ?? null
  });
});

/** Mark the comparison as shown to the customer — the timestamp is evidence. */
distRoutes.post("/quote-requests/:id/share", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:quote_requests:share", { tenantId: ctx.tenantId, module: "dist" });
  const request = await one(ctx, schema.distQuoteRequests, c.req.param("id"));
  if (!request) throw notFound("quote request");
  await ctx.db
    .update(schema.distQuoteRequests)
    .set({ sharedWithCustomerAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.id, request.id)));
  await audit(ctx, { action: "dist.quote_request.share", subjectRef: request.id });
  await emit(ctx, {
    module: "dist",
    type: "dist.quote_request.shared",
    subject: request.id,
    data: { customerId: request.customerId }
  });
  return c.body(null, 204);
});

/** The customer picks one. Everything downstream keys off this row. Its own
 *  verb since docs/27 F13: closing the sale is not the same authority as
 *  deciding what gets sent to a customer, and the AXIS desk does the first. */
distRoutes.post("/quote-requests/:id/select", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:quote_requests:select", { tenantId: ctx.tenantId, module: "dist" });
  const { responseId } = await body(c, z.object({ responseId: z.string().min(1) }));
  const request = await one(ctx, schema.distQuoteRequests, c.req.param("id"));
  if (!request) throw notFound("quote request");
  // F56: selecting a response converts the comparison — money-adjacent state
  // (docs/19), so it takes an idempotency key like every other consequential
  // write in this module. The converted-state guard lives *inside* the wrapper
  // so a same-key replay returns the stored result, while a fresh key against
  // an already-converted comparison is refused rather than double-converting.
  return c.json(
    await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.select", { requestId: request.id, responseId }, async () => {
      const current = await one(ctx, schema.distQuoteRequests, request.id);
      // Refuse only terminal states: a converted comparison must not convert
      // twice, and an expired/abandoned one must not be selected at all. A
      // request that is open, fanned_out or complete is still selectable.
      if (!current || current.state === "converted" || current.state === "expired" || current.state === "abandoned")
        throw conflict("that comparison is already decided");
      const rows = await ctx.db
        .select()
        .from(schema.distQuoteResponses)
        .where(
          and(
            eq(schema.distQuoteResponses.tenantId, ctx.tenantId),
            eq(schema.distQuoteResponses.id, responseId),
            eq(schema.distQuoteResponses.requestId, request.id)
          )
        )
        .limit(1);
      const response = rows[0];
      if (!response) throw notFound("quote response");
      if (response.state !== "quoted") throw conflict("that response is not a quote");
      if (response.validUntil !== null && response.validUntil < ctx.now) throw conflict("quote has expired");

      await ctx.db
        .update(schema.distQuoteResponses)
        .set({ selectedAt: ctx.now, updatedAt: ctx.now })
        .where(and(eq(schema.distQuoteResponses.tenantId, ctx.tenantId), eq(schema.distQuoteResponses.id, response.id)));
      await ctx.db
        .update(schema.distQuoteRequests)
        .set({ state: "converted", updatedAt: ctx.now })
        .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.id, request.id)));

      await audit(ctx, {
        action: "dist.quote_response.select",
        subjectRef: response.id,
        after: { premiumMinor: response.premiumMinor, offeringId: response.offeringId }
      });
      await emit(ctx, {
        module: "dist",
        type: "dist.quote_response.selected",
        subject: response.id,
        data: {
          requestId: request.id,
          offeringId: response.offeringId,
          providerId: response.providerId,
          premiumMinor: response.premiumMinor,
          customerId: request.customerId
        }
      });
      return { ...response, selectedAt: ctx.now };
    })
  );
});

/* ------------------------------------------------------------ commission */

const AccrueBody = z.object({
  policyId: z.string().min(1),
  kind: z.enum(["new_business", "renewal", "endorsement", "adjustment"]).default("new_business"),
  earnedOn: z.enum(["issue", "collection"]).default("issue"),
  taxMinor: z.number().int().min(0).default(0)
});

/**
 * Turn an issued policy into the three-way money view. Derived from the policy
 * and the rate in force rather than taken from the caller, so a channel cannot
 * post its own commission.
 */
distRoutes.post("/commission-entries/accrue", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:commissions:adjust", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, AccrueBody);

  return c.json(
    // engines/commission-accrual.ts: the same body the bind's
    // `axis.policy.issued` consumer runs, so the two doors cannot drift.
    await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.accrue", input, () => accrueCommission(ctx, input)),
    201
  );
});

const ClawbackBody = z.object({
  reason: z.string().min(3).max(500),
  /**
   * docs/27 P2 "clawback posts but nothing computes what is clawable". The
   * instant the clawback is priced as of — a mid-term cancellation, not "now"
   * if the request lags it. Defaults to now.
   */
  asOf: InstantMs.optional()
});

/**
 * What of an accrual is still clawable as of `asOf`: the unearned share of a
 * mid-term cancellation, proportional to the policy's remaining term — the
 * same day math `priceCancellation` (engines/axis-lifecycle.ts) already prices
 * a policy cancellation with, so a policy's own cancel and its commission
 * clawback never disagree about what "unearned" means.
 *
 * Every real commission entry's `policyId` is a live `axis_policies` row (the
 * column is `notNull`), so this resolves for every entry a live system posts.
 * The one case it falls through — no such policy — is a caller-supplied
 * `policyId` that names nothing on this tenant, and a full reversal is the
 * only honest answer to "prorate against what": there is no term to prorate.
 */
async function clawableAmounts(
  ctx: Ctx,
  entry: typeof schema.distCommissionEntries.$inferSelect,
  asOf: number
): Promise<{ premiumMinor: number; grossCommissionMinor: number; channelCommissionMinor: number; netCommissionMinor: number; taxMinor: number }> {
  const policy = await one(ctx, schema.axisPolicies, entry.policyId);
  if (!policy) {
    return {
      premiumMinor: entry.premiumMinor,
      grossCommissionMinor: entry.grossCommissionMinor,
      channelCommissionMinor: entry.channelCommissionMinor,
      netCommissionMinor: entry.netCommissionMinor,
      taxMinor: entry.taxMinor
    };
  }
  const term = { startAt: policy.startAt, endAt: policy.endAt };
  const unearned = (amountMinor: number): number => unearnedShareMinor(amountMinor, term, asOf);
  return {
    premiumMinor: unearned(entry.premiumMinor),
    grossCommissionMinor: unearned(entry.grossCommissionMinor),
    channelCommissionMinor: unearned(entry.channelCommissionMinor),
    netCommissionMinor: unearned(entry.netCommissionMinor),
    taxMinor: unearned(entry.taxMinor)
  };
}

/**
 * Reverse an accrual — or, when the underlying policy has a term to prorate
 * against, the unearned share of it. Never edits the original: a clawback is
 * its own entry pointing at what it reverses, so a statement reproduces to
 * the cent.
 */
distRoutes.post("/commission-entries/:id/clawback", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:commissions:adjust", { tenantId: ctx.tenantId, module: "dist" });
  const entryId = c.req.param("id");
  const { reason, asOf } = await body(c, ClawbackBody);
  const effectiveAt = asOf ?? ctx.now;

  // A reversal is money (CLAUDE.md §12), so it takes the same idempotency
  // wrapper as every other money route: a retried submit replays the stored
  // reversal instead of racing the state check and crediting it twice.
  const row = await withIdempotency(
    ctx,
    c.req.header("idempotency-key"),
    "dist.clawback",
    // The idempotency payload carries only what the caller stated, not the
    // resolved `effectiveAt` — a replay omitting `asOf` defaults to "now" both
    // times and must hash the same both times, or every replay of an
    // undated clawback would read as a payload mismatch and 409 instead of
    // replaying (asOf's own default is `ctx.now`, which moves).
    { entryId, reason, asOf },
    async () => {
      const entry = await one(ctx, schema.distCommissionEntries, entryId);
      if (!entry) throw notFound("commission entry");
      if (entry.reversalOf) throw conflict("cannot claw back a reversal");
      // Before the gate: an approval lives for 24h against (subject, policy), so
      // without this the same approval reverses the same accrual twice and credits
      // the reversal twice (CLAUDE.md §12).
      if (entry.state === "clawed_back") throw conflict("entry has already been clawed back");

      const clawable = await clawableAmounts(ctx, entry, effectiveAt);

      await gate(ctx, {
        policyKey: "dist.commission_adjust",
        subjectRef: entry.id,
        amountMinor: clawable.grossCommissionMinor,
        context: { reason, asOf: effectiveAt, fullAmountMinor: entry.grossCommissionMinor }
      });

      const reversal: typeof schema.distCommissionEntries.$inferInsert = {
        ...entry,
        id: newId("ce", ctx.now),
        kind: "clawback",
        premiumMinor: -clawable.premiumMinor,
        grossCommissionMinor: -clawable.grossCommissionMinor,
        channelCommissionMinor: -clawable.channelCommissionMinor,
        netCommissionMinor: -clawable.netCommissionMinor,
        taxMinor: -clawable.taxMinor,
        reversalOf: entry.id,
        providerSettlementId: null,
        channelSettlementId: null,
        state: "accrued",
        createdAt: ctx.now,
        updatedAt: ctx.now
      };
      await ctx.db.insert(schema.distCommissionEntries).values(reversal);
      await ctx.db
        .update(schema.distCommissionEntries)
        .set({ state: "clawed_back", updatedAt: ctx.now })
        .where(and(eq(schema.distCommissionEntries.tenantId, ctx.tenantId), eq(schema.distCommissionEntries.id, entry.id)));

      await audit(ctx, { action: "dist.commission.clawback", subjectRef: reversal.id, before: entry, after: reversal });
      await emit(ctx, {
        module: "dist",
        type: "dist.commission.clawed_back",
        subject: reversal.id,
        data: { reversalOf: entry.id, reason, unearnedOfMinor: entry.grossCommissionMinor, clawedBackMinor: clawable.grossCommissionMinor }
      });
      return reversal;
    }
  );
  return created(c, row as { id: string });
});

/* --------------------------------------------------------- referrals */

const QualifyReferralBody = z.object({
  referralRef: z.string().min(1).max(200),
  channelId: z.string().min(1).max(64).optional()
});

distRoutes.post("/referrals/qualify", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:commissions:adjust", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, QualifyReferralBody);
  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.referral.qualify", input, () =>
    qualifyReferral(ctx, input)
  );
  return c.json(out, 201);
});

const SettleReferralBody = z.object({
  referralRef: z.string().min(1).max(200),
  currency: z.string().length(3),
  grossMinor: z.number().int().positive(),
  channelMinor: z.number().int().nonnegative().optional()
});

distRoutes.post("/referrals/settle", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:commissions:settle", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(c, SettleReferralBody);
  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), "dist.referral.settle", input, () =>
    settleReferral(ctx, input)
  );
  return c.json(out, 201);
});

/** What each counterparty owes or is owed right now, from the entries alone. */
distRoutes.get("/commission-entries/statement", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:commissions:read", { tenantId: ctx.tenantId, module: "dist" });
  const { list, filters } = listParams(c);
  const e = schema.distCommissionEntries;

  const where = [eq(e.tenantId, ctx.tenantId)];
  if (filters.providerId) where.push(eq(e.providerId, filters.providerId));
  if (filters.channelId) where.push(eq(e.channelId, filters.channelId));
  if (filters.state) where.push(eq(e.state, filters.state));
  // The window applies to the column the statement orders by, so the page and
  // the range agree about what "the last N entries" means.
  if (list.from !== undefined) where.push(gte(e.createdAt, list.from));
  if (list.to !== undefined) where.push(lte(e.createdAt, list.to));

  const rows = await ctx.db.select().from(e).where(and(...where)).orderBy(desc(e.createdAt)).limit(list.limit);

  // Totals come from SQL over the whole matching set, never from the page: a
  // statement that silently totals the first N entries is a wrong statement.
  // Grouped by currency, because adding AED to USD produces a number that means
  // nothing (docs/22 §5.1).
  const sum = (col: AnyColumn) => sql<number>`coalesce(sum(${col}), 0)`;
  const grouped = await ctx.db
    .select({
      currency: e.currency,
      count: sql<number>`count(*)`,
      premiumMinor: sum(e.premiumMinor),
      receivableMinor: sum(e.grossCommissionMinor),
      payableMinor: sum(e.channelCommissionMinor),
      netMinor: sum(e.netCommissionMinor),
      taxMinor: sum(e.taxMinor)
    })
    .from(e)
    .where(and(...where))
    .groupBy(e.currency)
    .orderBy(e.currency);

  // SQLite drivers return aggregates as string or number depending on width.
  const totals = grouped.map((t) => ({
    currency: t.currency,
    count: Number(t.count),
    premiumMinor: Number(t.premiumMinor),
    receivableMinor: Number(t.receivableMinor),
    payableMinor: Number(t.payableMinor),
    netMinor: Number(t.netMinor),
    taxMinor: Number(t.taxMinor)
  }));

  return c.json({
    totals,
    count: totals.reduce((n, t) => n + t.count, 0),
    limit: list.limit,
    entries: rows
  });
});

/* ------------------------------------------------------------------- nbo */

distRoutes.post("/next-best-offers/propose", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:offers:read", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(
    c,
    z.object({
      customerId: z.string().min(1),
      channelId: z.string().optional(),
      anchorPolicyId: z.string().optional(),
      limit: z.number().int().min(1).max(10).optional()
    })
  );
  const startedAt = Date.now();
  const offers = await proposeOffers(ctx, input);

  // rules/v1 is still a model as far as docs/12 is concerned: it ranks offers
  // put in front of a customer, so the run is audited like any other and the id
  // goes back so the ✦ marker has a "why" to link to (CLAUDE.md §3, §11).
  const aiAuditId = newId("aia", ctx.now);
  await ctx.db.insert(schema.aiAuditLog).values({
    id: aiAuditId,
    tenantId: ctx.tenantId,
    module: "dist",
    purpose: "dist.nbo.propose",
    model: offers[0]?.model ?? "rules/v1",
    provider: "internal",
    tier: "fast",
    inputHash: await sha256Hex(canonicalJson(input)),
    outputHash: await sha256Hex(canonicalJson(offers.map((o) => [o.id, o.offeringId, o.score]))),
    latencyMs: Date.now() - startedAt,
    actorRef: actorRef(ctx),
    subjectRef: input.customerId,
    outcome: "ok",
    ts: ctx.now
  });

  return c.json({ data: offers, aiAuditId });
});

distRoutes.post("/next-best-offers/:id/surface", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:offers:surface", { tenantId: ctx.tenantId, module: "dist" });
  const offer = await one(ctx, schema.distNextBestOffers, c.req.param("id"));
  if (!offer) throw notFound("next best offer");
  // markSurfaced only moves `proposed`, so without this a caller surfacing a
  // dismissed offer was told 204 and nothing happened.
  if (offer.state !== "proposed") throw conflict(`offer is ${offer.state}, not proposed`);

  await markSurfaced(ctx, offer.id);
  await audit(ctx, {
    action: "dist.nbo.surface",
    subjectRef: offer.id,
    before: { state: offer.state },
    after: { state: "surfaced" }
  });
  await emit(ctx, {
    module: "dist",
    type: "dist.nbo.surfaced",
    subject: offer.id,
    data: { customerId: offer.customerId, offeringId: offer.offeringId, kind: offer.kind }
  });
  return c.body(null, 204);
});

distRoutes.post("/next-best-offers/:id/decide", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dist:offers:override", { tenantId: ctx.tenantId, module: "dist" });
  const input = await body(
    c,
    z.object({ decision: z.enum(["accepted", "dismissed"]), quoteRequestId: z.string().optional() })
  );
  await decideOffer(ctx, c.req.param("id"), input.decision, input.quoteRequestId);
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ util */

function canSeeMargin(ctx: Ctx): boolean {
  return ctx.actor.kind !== "customer";
}

export type { QuoteOutcome };

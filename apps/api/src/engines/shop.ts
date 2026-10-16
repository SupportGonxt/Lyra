import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, conflict, type Ctx } from "@lyra/core";
import { assertInputs, panelFor, quoteOne, rankOutcomes, type ProviderQuoter } from "./rating.js";

// The fan-out, once. Two callers price a risk against the panel: the operator's
// /v1/dist/quote-requests/shop and the public portal's self-serve quote (J-C1).
// They differ in who is allowed to ask and what comes back — not in how a shop
// runs — so the persistence of request + ranked responses lives here rather
// than being copied into the portal with its own drift.

export interface ShopArgs {
  /** The request row, minus the fields this function owns (fanout/responded/state/best*). */
  request: Omit<
    typeof schema.distQuoteRequests.$inferInsert,
    "fanoutCount" | "respondedCount" | "state" | "bestOfferingId" | "bestPremiumMinor"
  >;
  /** Panel eligibility is per channel key, not per channel id. */
  channelKey: string;
  inputs: Record<string, unknown>;
  quoter?: ProviderQuoter | undefined;
}

export interface ShopResult {
  request: typeof schema.distQuoteRequests.$inferSelect;
  responses: (typeof schema.distQuoteResponses.$inferSelect)[];
}

export async function runShop(ctx: Ctx, args: ShopArgs): Promise<ShopResult> {
  const panel = await panelFor(ctx, {
    productId: args.request.productId,
    channelKey: args.channelKey,
    at: ctx.now
  });
  if (!panel.length) throw conflict("no active offerings on the panel for this product");
  assertInputs(panel, args.inputs);

  const request = {
    ...args.request,
    fanoutCount: panel.length,
    respondedCount: 0,
    state: "fanned_out" as const
  } satisfies typeof schema.distQuoteRequests.$inferInsert;
  await ctx.db.insert(schema.distQuoteRequests).values(request);

  // Providers are independent, so the shop is as slow as the slowest one,
  // not the sum. quoteOne never rejects, so no allSettled is needed.
  const outcomes = await Promise.all(panel.map((entry) => quoteOne(ctx, entry, args.inputs, args.quoter)));
  const ranked = await rankOutcomes(ctx, outcomes, { channelId: args.request.channelId });

  const rows: (typeof schema.distQuoteResponses.$inferSelect)[] = [];
  for (const o of ranked) {
    const row: typeof schema.distQuoteResponses.$inferInsert = {
      id: newId("qs", ctx.now),
      tenantId: ctx.tenantId,
      requestId: request.id,
      offeringId: o.offeringId,
      providerId: o.providerId,
      state: o.state,
      premiumMinor: o.premiumMinor ?? null,
      taxMinor: o.taxMinor,
      feesMinor: o.feesMinor,
      currency: o.currency,
      commissionPpm: o.commission?.basePpm ?? null,
      commissionMinor: o.commission?.grossMinor ?? null,
      channelCommissionMinor: o.commission?.channelMinor ?? null,
      coverageJson: o.coverage ? JSON.stringify(o.coverage) : null,
      // ADR-0131. Both pricing paths compute this and it used to stop here — the
      // row was rebuilt from an explicit field list that omitted it, so the
      // decomposition never reached a reader at all. For a carrier-priced quote it
      // is the only record of the underwriter's line items that will ever exist.
      breakdownJson: o.breakdown?.length ? JSON.stringify(o.breakdown) : null,
      priceRank: o.priceRank ?? null,
      valueScore: o.valueScore ?? null,
      rationaleKey: o.priceRank === 1 ? "quote.rationale.cheapest" : null,
      declineReason: o.declineReason ?? null,
      latencyMs: o.latencyMs,
      validUntil: o.validUntil ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
    await ctx.db.insert(schema.distQuoteResponses).values(row);
    rows.push(row as typeof schema.distQuoteResponses.$inferSelect);
  }

  const best = rows.filter((r) => r.state === "quoted").sort((a, b) => (a.priceRank ?? 99) - (b.priceRank ?? 99))[0];
  const responded = rows.filter((r) => r.state === "quoted" || r.state === "declined").length;
  const state = responded === panel.length ? ("complete" as const) : ("fanned_out" as const);

  await ctx.db
    .update(schema.distQuoteRequests)
    .set({
      respondedCount: responded,
      bestOfferingId: best?.offeringId ?? null,
      bestPremiumMinor: best?.premiumMinor ?? null,
      state,
      updatedAt: ctx.now
    })
    .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.id, request.id)));

  // Recorded here, where every shop runs, so the portal's self-serve shop and
  // an operator's count the same: J-C1's "offers" step reads this action.
  await audit(ctx, {
    action: "dist.quote_request.shop",
    subjectRef: request.id,
    after: { fanout: request.fanoutCount, quoted: rows.filter((r) => r.state === "quoted").length }
  });

  // docs/modules/axis.md §2.3's live process map. The lifecycle steps are written
  // by the cases resource; these two are the quoting engine's own, and until now
  // only the *seed* wrote them — so the map showed `quote_fanout` and
  // `quotes_compared` for seeded cases and for nothing else. Here as well as in
  // the routes for the reason the header gives: both shops must count the same.
  //
  // Only when the shop names a case: without one there is no case timeline to
  // attach the step to, and a process event with no case is a row no reader can
  // use.
  if (request.caseId) {
    const latencies = rows.map((r) => r.latencyMs).filter((ms): ms is number => typeof ms === "number");
    // The step took as long as its **slowest** member — that is what a bottleneck
    // is, and a mean would hide the one provider that holds the panel up. Null
    // when no caller reported a latency, never zero: zero is a measurement.
    const slowest = latencies.length ? Math.max(...latencies) : null;
    const reached = rows.some((r) => r.state === "quoted" || r.state === "declined");
    const quoted = rows.filter((r) => r.state === "quoted").length;

    await ctx.db.insert(schema.axisProcessEvents).values([
      {
        id: newId("pev", ctx.now),
        tenantId: ctx.tenantId,
        caseId: request.caseId,
        step: "quote_fanout",
        actorRef: "agent:quoting",
        durationMs: slowest,
        // A fan-out that reached nobody (every provider errored or timed out) is
        // a failed step; one where every provider declined is a step that worked
        // and a risk nobody will write. Those are different facts.
        outcome: reached ? "ok" : "failed",
        ts: ctx.now
      },
      // A comparison of one is not a comparison, so this step exists only when
      // the panel actually gave a choice. Its duration is null rather than timed:
      // ranking is instantaneous, and a number there would be noise dressed as a
      // measurement.
      ...(quoted > 1
        ? [
            {
              id: newId("pev", ctx.now),
              tenantId: ctx.tenantId,
              caseId: request.caseId,
              step: "quotes_compared",
              actorRef: "agent:quoting",
              durationMs: null,
              outcome: "ok",
              ts: ctx.now
            }
          ]
        : [])
    ] as never);
  }

  return {
    request: {
      ...request,
      respondedCount: responded,
      bestOfferingId: best?.offeringId ?? null,
      bestPremiumMinor: best?.premiumMinor ?? null,
      state
    } as typeof schema.distQuoteRequests.$inferSelect,
    responses: rows
  };
}

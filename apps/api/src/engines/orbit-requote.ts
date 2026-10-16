import { and, eq } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { conflict, notFound, type Ctx } from "@lyra/core";
import { quoterFor } from "./dist-quoter.js";
import type { ProviderQuoter } from "./rating.js";
import { runShop } from "./shop.js";
import type { Env } from "../env.js";

// docs/modules/orbit.md's retention loop, and the four in-tree comments that
// admitted it did not exist:
//
//   renewal-campaign.ts  "No pricing/quote generation here — an auto_requote
//                         strategy only marks intent … the actual requote is out
//                         of scope until that engine exists"
//   orbit-save.tsx       "Nothing in the platform generates a re-quote today, so
//                         the offer recorded here is the fact that one was made,
//                         not its price"
//   renewal-desk.tsx     "No requote engine writes orbit_renewals.requotes_json
//                         yet"
//   portal…renewals…     "No price on this page: requotesJson is written by
//                         nothing yet"
//
// So `requotes_json` was written by exactly one thing — a person or the model
// hand-typing a premium into `make_renewal_offer` — and every downstream number
// (price-match authority, win/loss by price delta, uplift against a control arm)
// was defined against a price that did not exist. This is that engine.
//
// It re-quotes **the same risk**, and the risk is not guessed: the policy's own
// quote response names the request it was bound from, and that request holds the
// inputs the panel answered. Re-shopping a reconstruction would be pricing a
// different customer.

/** What `requotes_json` holds. Superset of what `make_renewal_offer` writes, so both are readable. */
export interface RenewalRequote {
  /** The best price the panel returned, or null when nothing quoted. */
  premiumMinor: number | null;
  currency: string;
  /** `engine:requote` when this was computed; a person's ref when typed. */
  offeredBy: string;
  /** The panel's answers, cheapest first. What makes this a re-quote rather than a figure. */
  quotes: { responseId: string; offeringId: string; providerId: string; premiumMinor: number }[];
  /** How many underwriters were asked and did not answer — a decline is information. */
  unanswered: number;
  at: number;
}

export interface RequoteResult {
  renewalId: string;
  requote: RenewalRequote;
}

/**
 * Re-shop a renewal's risk and record what the panel said.
 *
 * Returns `null` when the renewal cannot be re-quoted **at all** — no policy, no
 * originating request, nothing quoted. Null is the honest answer there and is
 * deliberately distinct from a requote whose `premiumMinor` is null (the panel was
 * asked and declined): **an absent row beats a zero**, and both beat a number
 * nobody underwrote.
 */
export async function requoteRenewal(
  ctx: Ctx,
  env: Env,
  renewalId: string,
  /**
   * The transport, injectable for the same reason `runShop`'s is: an engine that
   * hard-binds `quoterFor(env)` cannot be tested against a stub panel, so the only
   * way to prove it prices anything is to stand up real carriers. Found by trying
   * to write the round-trip test — which is what test-first is for.
   */
  quoter: ProviderQuoter = quoterFor(env)
): Promise<RequoteResult | null> {
  const [renewal] = await ctx.db
    .select()
    .from(schema.orbitRenewals)
    .where(and(eq(schema.orbitRenewals.tenantId, ctx.tenantId), eq(schema.orbitRenewals.id, renewalId)));
  if (!renewal) throw notFound("renewal");
  if (renewal.state === "accepted" || renewal.state === "lost") {
    throw conflict(`renewal is ${renewal.state}`);
  }

  const [policy] = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.id, renewal.policyRef)));
  if (!policy?.productId) return null;

  // The risk, from the request the policy was bound from. A missing chain is a
  // policy nobody can re-quote honestly, so it answers null rather than shopping
  // an invention.
  const [response] = await ctx.db
    .select({ requestId: schema.distQuoteResponses.requestId, currency: schema.distQuoteResponses.currency })
    .from(schema.distQuoteResponses)
    .innerJoin(schema.axisPolicyVersions, eq(schema.axisPolicyVersions.quoteResponseId, schema.distQuoteResponses.id))
    .where(and(eq(schema.axisPolicyVersions.tenantId, ctx.tenantId), eq(schema.axisPolicyVersions.policyId, policy.id)));
  if (!response) return null;

  const [request] = await ctx.db
    .select({ inputsJson: schema.distQuoteRequests.inputsJson, channelId: schema.distQuoteRequests.channelId })
    .from(schema.distQuoteRequests)
    .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.id, response.requestId)));
  if (!request) return null;

  const [channel] = await ctx.db
    .select({ key: schema.distChannels.key })
    .from(schema.distChannels)
    .where(and(eq(schema.distChannels.tenantId, ctx.tenantId), eq(schema.distChannels.id, policy.channelId ?? request.channelId)));
  if (!channel) return null;

  const currency = response.currency ?? policy.currency;
  const inputs = JSON.parse(request.inputsJson ?? "{}") as Record<string, unknown>;

  const { request: quoteRequest, responses } = await runShop(ctx, {
    request: {
      id: newId("qr", ctx.now),
      tenantId: ctx.tenantId,
      caseId: policy.caseId ?? null,
      customerId: policy.customerId,
      channelId: policy.channelId ?? request.channelId,
      productId: policy.productId,
      inputsJson: JSON.stringify(inputs),
      consentId: null,
      currency,
      expiresAt: ctx.now + 7 * 86_400_000,
      createdAt: ctx.now,
      updatedAt: ctx.now
    },
    channelKey: channel.key,
    inputs,
    quoter
  });

  const quoted = responses
    .filter((r) => r.state === "quoted" && r.premiumMinor !== null)
    .map((r) => ({
      responseId: r.id,
      offeringId: r.offeringId,
      providerId: r.providerId,
      premiumMinor: r.premiumMinor as number
    }))
    .sort((a, b) => a.premiumMinor - b.premiumMinor);

  const requote: RenewalRequote = {
    // Null, never zero: nothing quoted is not a price of nothing.
    premiumMinor: quoted[0]?.premiumMinor ?? null,
    currency: quoteRequest.currency,
    offeredBy: "engine:requote",
    quotes: quoted,
    unanswered: responses.length - quoted.length,
    at: ctx.now
  };

  await ctx.db
    .update(schema.orbitRenewals)
    .set({ requotesJson: JSON.stringify(requote), updatedAt: ctx.now })
    .where(and(eq(schema.orbitRenewals.tenantId, ctx.tenantId), eq(schema.orbitRenewals.id, renewalId)));

  return { renewalId, requote };
}

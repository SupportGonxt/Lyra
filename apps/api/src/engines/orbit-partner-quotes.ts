import { id as newId, schema } from "@lyra/db";
import { audit, conflict, emit, sha256Hex, type Ctx } from "@lyra/core";
import { must } from "../rows.js";

// docs/05 §Partner & Embedded Platform — "sandbox with mock quotes". A partner
// integration is a promise, not code we have: the one live adapter in the repo
// (`engines/dist-quoter.ts`) prices an offering on our own panel, not a
// partner's book — so every quote here is synthetic pricing, and the only
// thing that changes at go-live (`onboarding.ts#advancePartner`, gated on
// `dist.partner_activate` — reused here, not duplicated) is the `mode` label
// on the response and the txn log.

export interface PartnerQuoteInput {
  productLine: string;
  amountMinor: number;
  currency: string;
}

export interface PartnerQuoteResult {
  id: string;
  partnerId: string;
  mode: "sandbox" | "live";
  synthetic: boolean;
  quotedPremiumMinor: number;
  currency: string;
}

/** ponytail: flat synthetic rate — this proves the sandbox/live path, not a pricing engine. */
const SYNTHETIC_RATE = 0.04;

function mockPremium(amountMinor: number): number {
  return Math.round(amountMinor * SYNTHETIC_RATE);
}

export function revshareFor(revshareJson: string | null, premiumMinor: number): number {
  if (!revshareJson) return 0;
  try {
    const parsed = JSON.parse(revshareJson) as { pct?: number };
    return Math.round(premiumMinor * ((parsed.pct ?? 0) / 100));
  } catch {
    return 0;
  }
}

/**
 * Request a quote from an ORBIT embedded-distribution partner. While the
 * partner is in sandbox mode (`orbit_partners.sandboxFlag`), the response is
 * clearly-marked synthetic data — never a real integration call, because none
 * exists. Once `advancePartner` has flipped the partner to `live` (behind the
 * `dist.partner_activate` approval), the same synthetic pricing is returned
 * but marked `mode: "live"`, `synthetic: false`.
 */
export async function requestPartnerQuote(
  ctx: Ctx,
  partnerId: string,
  input: PartnerQuoteInput
): Promise<PartnerQuoteResult> {
  const partner = await must(ctx, schema.orbitPartners, partnerId, "partner");
  if (partner.status === "terminated" || partner.status === "suspended") {
    throw conflict(`partner is ${partner.status}`);
  }

  const sandbox = partner.sandboxFlag;
  const quotedPremiumMinor = mockPremium(input.amountMinor);
  const revshareCalcMinor = revshareFor(partner.revshareJson, quotedPremiumMinor);
  const id = newId("otx", ctx.now);
  const payloadHash = await sha256Hex(JSON.stringify(input));

  await ctx.db.insert(schema.orbitPartnerTxns).values({
    id,
    tenantId: ctx.tenantId,
    partnerId,
    kind: "quote",
    payloadHash,
    amountMinor: quotedPremiumMinor,
    currency: input.currency,
    revshareCalcMinor,
    settlementBatch: null,
    txnRef: null,
    ts: ctx.now
  });

  await audit(ctx, {
    action: "orbit.partner.quote",
    subjectRef: partnerId,
    after: { id, mode: sandbox ? "sandbox" : "live", synthetic: sandbox, quotedPremiumMinor }
  });
  // A partner journey waits for its first quote (seed/orbit.ts broker_activation).
  await emit(ctx, {
    module: "orbit",
    type: "orbit.partner.quoted",
    subject: partnerId,
    data: { partnerId, txnId: id, mode: sandbox ? "sandbox" : "live" }
  });

  return {
    id,
    partnerId,
    mode: sandbox ? "sandbox" : "live",
    synthetic: sandbox,
    quotedPremiumMinor,
    currency: input.currency
  };
}

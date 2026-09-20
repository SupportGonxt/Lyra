import { badRequest } from "@lyra/core";

// docs/19 §11.9: "Recognition schedules never recognise more than invoiced."
// docs/27 F22 counted that obligation among the four with no test at all, and
// the reason was that the rule lived nowhere a test could reach it — the split
// was four lines inside `sweepBilling`'s loop and the ceiling was nowhere.
//
// Both halves are here, pure, so a property test can hammer them: the schedule
// that is built, and the guard that refuses to release more than it.

/**
 * Straight-line split of an invoice across a term, in minor units.
 *
 * The remainder goes on the **first** period rather than the last, which is the
 * choice worth stating: a subscription cancelled mid-term has then already
 * recognised the rounding, so no final stub period exists to carry a residual
 * nobody will ever release. The sum is exactly `netMinor` by construction — not
 * approximately, and not "within a fils".
 */
export function straightLine(netMinor: number, periods: number): number[] {
  if (!Number.isSafeInteger(netMinor) || netMinor < 0) {
    throw badRequest(`recognition amount must be a non-negative integer minor amount, got ${netMinor}`);
  }
  if (!Number.isInteger(periods) || periods < 1) {
    throw badRequest(`recognition needs at least one period, got ${periods}`);
  }
  const share = Math.floor(netMinor / periods);
  const out = new Array<number>(periods).fill(share);
  out[0] = netMinor - share * (periods - 1);
  return out;
}

export interface RecognitionCheck {
  invoicedMinor: number;
  alreadyRecognisedMinor: number;
  amountMinor: number;
}

/** What would still be releasable after this one. Negative means over-recognition. */
export function recognitionHeadroom(c: RecognitionCheck): number {
  return c.invoicedMinor - c.alreadyRecognisedMinor - c.amountMinor;
}

/**
 * The ceiling, enforced. A schedule is a plan and plans get edited, replayed and
 * re-run; the invariant has to hold against the *ledger's* total, not against
 * the plan's own arithmetic, or a duplicated row recognises revenue twice and
 * the balance sheet carries negative deferred revenue.
 */
export function assertWithinInvoice(c: RecognitionCheck): void {
  if (c.amountMinor <= 0) throw badRequest("a recognition must release a positive amount");
  if (recognitionHeadroom(c) < 0) {
    throw badRequest(
      `recognising ${c.amountMinor} would take total recognition to ${c.alreadyRecognisedMinor + c.amountMinor}, above the ${c.invoicedMinor} invoiced (docs/19 §11.9)`
    );
  }
}

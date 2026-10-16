import { describe, expect, it } from "vitest";
import { buildRecipe, commissionAccrual } from "./recipes.js";
import type { PostingLine } from "./posting.js";

// ADR-0121 / docs/29 G1. Every tax leg used to credit `2200 Tax Payable`, so an
// insurance premium tax in the EU and an Egyptian table tax both landed in the
// VAT return's account. The liability is now the caller's to state, and the
// default is unchanged — which is what these two halves pin: routing works when
// stated, and nothing moves when it is not.

const sum = (ls: PostingLine[], side: string, code?: string): number =>
  ls.filter((l) => l.side === side && (!code || l.accountCode === code)).reduce((s, l) => s + l.amountMinor, 0);

describe("tax lands on the liability the caller names", () => {
  it("defaults to the VAT account, so an unstated tax behaves exactly as before", () => {
    const ls = commissionAccrual({ grossMinor: 15_000, channelMinor: 0, taxMinor: 750 });
    expect(sum(ls, "credit", "2200")).toBe(750);
  });

  it("posts a commission tax to a premium-tax account when the caller says so", () => {
    const ls = commissionAccrual({ grossMinor: 15_000, channelMinor: 0, taxMinor: 750, taxAccount: "2210" });
    expect(sum(ls, "credit", "2210")).toBe(750);
    expect(sum(ls, "credit", "2200")).toBe(0);
  });

  it("posts an Egyptian table tax beside the VAT rather than into it", () => {
    // The case the column exists for: one premium, two levies, two returns.
    const vat = commissionAccrual({ grossMinor: 15_000, channelMinor: 0, taxMinor: 750 });
    const table = commissionAccrual({ grossMinor: 15_000, channelMinor: 0, taxMinor: 19, taxAccount: "2220" });
    const both = [...vat, ...table];
    expect(sum(both, "credit", "2200")).toBe(750);
    expect(sum(both, "credit", "2220")).toBe(19);
  });

  // These go through the registry rather than the bare builder on purpose: the
  // POST body is what an operator actually sends, and the registry is what
  // applies the schema's defaults to it.
  it("routes an invoice's output tax and a credit note's adjustment the same way", () => {
    const invoice = buildRecipe("SUB-INVOICE", { netMinor: 1_000, taxMinor: 140, taxAccount: "2210" });
    const note = buildRecipe("CREDIT-NOTE", { netMinor: 1_000, taxMinor: 140, taxAccount: "2210" });
    expect(sum(invoice, "credit", "2210")).toBe(140);
    expect(sum(note, "debit", "2210")).toBe(140);
  });

  it("routes withholding tax away from VAT when a market withholds at source", () => {
    const ls = buildRecipe("PAYOUT-INSTRUCT", { amountMinor: 10_000, withholdingMinor: 500, withholdingAccount: "2220" });
    expect(sum(ls, "credit", "2220")).toBe(500);
    expect(sum(ls, "credit", "2200")).toBe(0);
    expect(sum(ls, "debit")).toBe(sum(ls, "credit"));
  });

  it("reaches the same account through the recipe registry a POST would use", () => {
    // The posting API validates `args` through the recipe's own schema, so this
    // is the contract an operator actually gets — not a package-internal one.
    const ls = buildRecipe("SUB-INVOICE", { netMinor: 1_000, taxMinor: 140, taxAccount: "2220" });
    expect(sum(ls, "credit", "2220")).toBe(140);
  });

  it("still refuses a tax leg the schema would not accept", () => {
    // `taxAccount` is a plain code string, but `taxMinor` is non-negative and a
    // negative tax is not a credit note — it is a bug.
    expect(() => buildRecipe("SUB-INVOICE", { netMinor: 1_000, taxMinor: -140 })).toThrow();
  });
});

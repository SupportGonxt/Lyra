import { describe, expect, it } from "vitest";
import { buildRecipe, bindPosting, clientMoneyReceipt, premiumBooked } from "./recipes.js";
import type { PostingLine } from "./posting.js";

// docs/27 F14: "Premium accounting is cash-basis only — `1200 Premium
// Receivable` appears once, as a chargeback default, and `2000 Insurer Payable`
// is never posted, so GWP is never a receivable."
//
// The shape this closes it with, in full:
//
//   BIND          Dr 1200 Premium Receivable   10,000   (the customer owes us)
//                   Cr 2000 Insurer Payable    10,000   (we owe the insurer)
//                 …plus the commission accrual of docs/19 §5.2 A
//   PREM-COLLECT  Dr 1010 Cash – Client Money  10,000   (the money arrives)
//                   Cr 1200 Premium Receivable 10,000   (the customer is square)
//                 Dr 2000 Insurer Payable      10,000   (the debt reclassifies…)
//                   Cr 2010 Client Money Liab  10,000   (…to a client-money one)
//
// The second entry is the one worth reading twice: it debits the client-money
// asset, so docs/19 §5.2 B forbids it crediting any income or expense account.
// It credits an *asset* (1200) and a *liability* (2010), which is why the
// receipt can clear the receivable without recognising a fils of revenue.

const sum = (ls: PostingLine[], side: string, code?: string): number =>
  ls
    .filter((l) => l.side === side && (!code || l.accountCode === code))
    .reduce((s, l) => s + l.amountMinor, 0);

const balanced = (ls: PostingLine[]): boolean => sum(ls, "debit") === sum(ls, "credit");

describe("GWP is a receivable at bind, not a cash event later", () => {
  it("books the customer receivable against the insurer payable", () => {
    const ls = premiumBooked({ gwpMinor: 10_000 });
    expect(ls).toEqual([
      expect.objectContaining({ accountCode: "1200", side: "debit", amountMinor: 10_000 }),
      expect.objectContaining({ accountCode: "2000", side: "credit", amountMinor: 10_000 })
    ]);
    expect(balanced(ls)).toBe(true);
  });

  it("a bind posts the premium legs and the commission accrual in one batch", () => {
    const ls = bindPosting({ gwpMinor: 100_000, grossMinor: 15_000, taxMinor: 750, incomeAccount: "4000", receivableAccount: "1100" });
    expect(sum(ls, "debit", "1200")).toBe(100_000);
    expect(sum(ls, "credit", "2000")).toBe(100_000);
    expect(sum(ls, "debit", "1100")).toBe(15_000);
    expect(sum(ls, "credit", "4000")).toBe(14_250);
    expect(sum(ls, "credit", "2200")).toBe(750);
    expect(balanced(ls)).toBe(true);
  });

  it("a bind that states no premium is the commission accrual it always was", () => {
    // Commission-only aggregation (docs/19 §5.2 A): the insurer collects, so no
    // premium ever passes through us and there is nothing to be owed.
    const ls = bindPosting({ grossMinor: 15_000, taxMinor: 750, incomeAccount: "4000", receivableAccount: "1100" });
    expect(ls.some((l) => l.accountCode === "1200" || l.accountCode === "2000")).toBe(false);
    expect(balanced(ls)).toBe(true);
  });

  it("every bind-family transaction type routes through it", () => {
    for (const code of ["BIND", "BIND-GROUP", "RENEW", "PARTNER-BIND", "AGENT-BIND", "REINSTATE"]) {
      const ls = buildRecipe(code, { gwpMinor: 50_000, grossMinor: 7_500, taxMinor: 375 });
      expect(sum(ls, "debit", "1200"), code).toBe(50_000);
      expect(sum(ls, "credit", "2000"), code).toBe(50_000);
      expect(balanced(ls), code).toBe(true);
    }
  });

  it("CMSN-ACCR stays a commission accrual — a standalone accrual books no premium", () => {
    // The receivable belongs to the transaction that created the contract. An
    // accrual raised on its own (a late statement, a corrected rate) must not
    // invent a second premium debt for the same policy.
    const ls = buildRecipe("CMSN-ACCR", { gwpMinor: 50_000, grossMinor: 7_500 });
    expect(ls.some((l) => l.accountCode === "1200")).toBe(false);
  });
});

describe("collecting the premium clears the receivable, it does not duplicate it", () => {
  it("still posts the plain client-money receipt when nothing is being cleared", () => {
    expect(clientMoneyReceipt({ amountMinor: 10_000 })).toEqual([
      expect.objectContaining({ accountCode: "1010", side: "debit", amountMinor: 10_000 }),
      expect.objectContaining({ accountCode: "2010", side: "credit", amountMinor: 10_000 })
    ]);
  });

  it("clears 1200 and reclassifies 2000 when the bind booked them", () => {
    const ls = clientMoneyReceipt({ amountMinor: 10_000, clearsReceivableAccount: "1200" });
    expect(sum(ls, "debit", "1010")).toBe(10_000);
    expect(sum(ls, "credit", "1200")).toBe(10_000);
    expect(sum(ls, "debit", "2000")).toBe(10_000);
    expect(sum(ls, "credit", "2010")).toBe(10_000);
    expect(balanced(ls)).toBe(true);
  });

  it("recognises no income in a batch that debits client money (docs/19 §5.2 B)", () => {
    const ls = clientMoneyReceipt({ amountMinor: 10_000, clearsReceivableAccount: "1200" });
    expect(ls.some((l) => l.side === "credit" && /^[45]/.test(l.accountCode))).toBe(false);
  });

  it("PREM-COLLECT and PREM-INSTALMENT both accept the clearing form", () => {
    for (const code of ["PREM-COLLECT", "PREM-INSTALMENT"]) {
      const ls = buildRecipe(code, { amountMinor: 10_000, clearsReceivableAccount: "1200" });
      expect(sum(ls, "credit", "1200"), code).toBe(10_000);
      expect(balanced(ls), code).toBe(true);
    }
  });
});

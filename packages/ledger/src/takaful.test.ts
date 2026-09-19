import { describe, expect, it } from "vitest";
import { account } from "@lyra/db";
import { buildRecipe, takafulSurplus } from "./recipes.js";
import { txnType, TXN_TYPES } from "./types.js";

// docs/16 H8, docs/27 F45. `SURPLUS-DIST` was a declared transaction type with
// an approval policy and a borrowed recipe — `expenseAccrual` into 5400 Partner
// Revenue Share / 2100 Partner Payable — and no caller anywhere. Both legs were
// wrong by a whole regime: a takaful surplus is not an expense the operator
// incurs, and the participants are not a distribution partner. It tested green
// because nothing posted one.

const sum = (lines: ReturnType<typeof takafulSurplus>, side: "debit" | "credit") =>
  lines.filter((l) => l.side === side).reduce((t, l) => t + l.amountMinor, 0);

describe("takafulSurplus", () => {
  it("moves the whole surplus out of the participants' fund", () => {
    const lines = takafulSurplus({
      surplusMinor: 1_000_00,
      participantShareBps: 10_000,
      fundAccount: "2040",
      payableAccount: "2050",
      operatorIncomeAccount: "4096"
    });
    expect(lines).toEqual([
      { accountCode: "2040", side: "debit", amountMinor: 100_000, memo: "surplus declared" },
      { accountCode: "2050", side: "credit", amountMinor: 100_000, memo: "participants' share" }
    ]);
    // The operator's leg is dropped, not written as zero: under wakala the
    // operator takes a fee and no surplus, and a zero line is noise.
    expect(lines).toHaveLength(2);
  });

  it("splits a mudaraba surplus between the participants and the operator", () => {
    const lines = takafulSurplus({
      surplusMinor: 1_000_00,
      participantShareBps: 7_000,
      fundAccount: "2040",
      payableAccount: "2050",
      operatorIncomeAccount: "4096"
    });
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["2040", "debit", 100_000],
      ["2050", "credit", 70_000],
      ["4096", "credit", 30_000]
    ]);
  });

  // CLAUDE.md §12: ledger invariants are not relaxed to make a test pass, and
  // this is the invariant the two-independent-roundings version would break.
  it.each([
    [1, 3_333],
    [7, 3_333],
    [99_999, 1],
    [100, 6_667],
    [12_345_678, 8_888],
    [3, 9_999]
  ])("balances for %i minor at %i bps, where two floors would not", (surplusMinor, participantShareBps) => {
    const lines = takafulSurplus({
      surplusMinor,
      participantShareBps,
      fundAccount: "2040",
      payableAccount: "2050",
      operatorIncomeAccount: "4096"
    });
    expect(sum(lines, "debit")).toBe(sum(lines, "credit"));
    expect(sum(lines, "debit")).toBe(surplusMinor);
  });

  it("gives the rounding dust to the operator, never to the participants", () => {
    // 3 minor at 50% is 1.5. Rounding a participant's entitlement up out of a
    // fund they collectively own is not the operator's to do, so the
    // participants take the floor and the operator takes what is left.
    const lines = takafulSurplus({
      surplusMinor: 3,
      participantShareBps: 5_000,
      fundAccount: "2040",
      payableAccount: "2050",
      operatorIncomeAccount: "4096"
    });
    expect(lines.find((l) => l.accountCode === "2050")?.amountMinor).toBe(1);
    expect(lines.find((l) => l.accountCode === "4096")?.amountMinor).toBe(2);
  });

  it("defaults to the participants keeping all of it", () => {
    // The wakala answer and the conservative one: an unconfigured product
    // distributes nothing to the operator rather than quietly taking a share.
    const lines = buildRecipe("SURPLUS-DIST", { surplusMinor: 500_00 });
    expect(lines.map((l) => l.accountCode)).toEqual(["2040", "2050"]);
    expect(lines[1]?.amountMinor).toBe(50_000);
  });

  it("refuses a share outside 0-100%", () => {
    expect(() => buildRecipe("SURPLUS-DIST", { surplusMinor: 100, participantShareBps: 10_001 })).toThrow();
    expect(() => buildRecipe("SURPLUS-DIST", { surplusMinor: 100, participantShareBps: -1 })).toThrow();
  });

  it("refuses a surplus of nothing, which is not a distribution", () => {
    expect(() => buildRecipe("SURPLUS-DIST", { surplusMinor: 0 })).toThrow();
  });
});

describe("the takaful accounts exist in the chart", () => {
  // The recipe names four codes; a code the chart does not carry posts to an
  // account no tenant was provisioned with, and `syncChartOfAccounts`
  // (packages/core/src/seed.ts) is what carries a new one to tenants that
  // already exist.
  it.each([
    ["2040", "liability", "credit"],
    ["2050", "liability", "credit"],
    ["4096", "income", "credit"]
  ])("%s is a %s account increasing on the %s", (code, type, normalSide) => {
    expect(account(code)).toMatchObject({ type, normalSide });
  });

  it("keeps the participants' fund out of the client-money invariant", () => {
    // The 1010 >= 2010 test is the CBUAE client-money rule. A tabarru' fund is
    // segregated under the takaful operator's own licence, and flagging it here
    // would make one regulatory test answer for two regimes — its own
    // segregation check is H8 LATER and needs an asset account first.
    expect(account("2040")).not.toHaveProperty("clientMoney");
  });
});

describe("SURPLUS-DIST stays gated however its recipe changes", () => {
  it("is financial, dual-controlled and never auto-approvable", () => {
    expect(txnType("SURPLUS-DIST")).toMatchObject({ financial: true, approval: "ledger.surplus" });
  });

  it("is not on any auto-approvable list by construction", () => {
    // `ledger.surplus` carries neverAutoApprove in approvals.ts; this asserts
    // the type still points at that policy and not at a laxer one.
    expect(TXN_TYPES["SURPLUS-DIST"]?.approval).toBe("ledger.surplus");
  });
});

import { describe, expect, it } from "vitest";
import { formatMoney } from "@lyra/ui";
import { LABELS, epochOf, labelIn, reportsHeadline } from "./ledger-reports";

// The reports screen's hero: the report's own name plus the one figure it
// already computed, never a made-up number. Denied falls back to the
// screen's static title so the nav still renders something sane.

describe("reportsHeadline", () => {
  const l = labelIn("en");

  it("falls back to the screen title when nothing loaded (denied)", () => {
    expect(reportsHeadline(null, l, "en")).toBe("Finance reports");
  });

  it("says a trial balance foots", () => {
    const report = {
      key: "trial-balance" as const,
      data: {
        currency: "ZAR",
        asOf: 0,
        rows: [],
        totalDebitMinor: 10_000,
        totalCreditMinor: 10_000,
        balanced: true
      }
    };
    expect(reportsHeadline(report, l, "en")).toBe("Trial balance balances.");
  });

  it("names the difference when a trial balance is out", () => {
    const report = {
      key: "trial-balance" as const,
      data: {
        currency: "ZAR",
        asOf: 0,
        rows: [],
        totalDebitMinor: 10_001,
        totalCreditMinor: 10_000,
        balanced: false
      }
    };
    expect(reportsHeadline(report, l, "en")).toBe(`Trial balance is out by ${formatMoney(1, "ZAR", "en")}.`);
  });

  it("nets a P&L", () => {
    const report = {
      key: "pnl" as const,
      data: {
        periodCode: "2026-08",
        currency: "ZAR",
        income: { label: "Revenue", rows: [], totalMinor: 0 },
        expense: { label: "Expense", rows: [], totalMinor: 0 },
        grossMarginMinor: 500000,
        marginPpm: 0
      }
    };
    expect(reportsHeadline(report, l, "en")).toBe(`Profit and loss nets ${formatMoney(500000, "ZAR", "en")}.`);
  });

  it("names the difference when a balance sheet does not balance", () => {
    const report = {
      key: "balance-sheet" as const,
      data: {
        asOf: 0,
        currency: "ZAR",
        assets: { label: "Assets", rows: [], totalMinor: 10_100 },
        liabilities: { label: "Liabilities", rows: [], totalMinor: 10_000 },
        equity: { label: "Equity", rows: [], totalMinor: 0 },
        currentYearUnpostedMinor: 0,
        equityMinor: 0,
        balanced: false
      }
    };
    expect(reportsHeadline(report, l, "en")).toBe(`Balance sheet is out by ${formatMoney(100, "ZAR", "en")}.`);
  });

  const agedRow = {
    counterparty: "INS-1",
    currency: "ZAR",
    currentMinor: 0,
    d30Minor: 0,
    d60Minor: 0,
    d90Minor: 0,
    olderMinor: 0,
    totalMinor: 0
  };
  const commissionRow = { dimension: "provider", value: "insurer-a", grossMinor: 0, channelShareMinor: 0, netMinor: 0, currency: "ZAR" };
  const cmRow = (breach: boolean) => ({ currency: "ZAR", assetMinor: 0, liabilityMinor: 0, surplusMinor: 0, breach, asOf: 0 });

  it("counts aged rows", () => {
    const report = { key: "aged" as const, data: { data: [agedRow, agedRow, agedRow] } };
    expect(reportsHeadline(report, l, "en")).toBe("Aged analysis: 3 rows.");
  });

  it("counts commission rows", () => {
    const report = { key: "commission" as const, data: { dimension: "provider", data: [commissionRow] } };
    expect(reportsHeadline(report, l, "en")).toBe("Commission statement: 1 row.");
  });

  it("flags client-money breaches by currency", () => {
    const report = { key: "client-money" as const, data: { data: [cmRow(true), cmRow(false)] } };
    expect(reportsHeadline(report, l, "en")).toBe("Client money check: 1 currency breach.");
  });

  it("says client money is clear when nothing breaches", () => {
    const report = { key: "client-money" as const, data: { data: [cmRow(false)] } };
    expect(reportsHeadline(report, l, "en")).toBe("Client money check is clear — no breach.");
  });
});

describe("cash flow (ADR-0090)", () => {
  const l = labelIn("en");
  const section = (totalMinor: number) => ({ rows: [], totalMinor });
  const cashFlow = (reconciled: boolean) => ({
    key: "cash-flow" as const,
    data: {
      from: 0,
      to: 1,
      currency: "AED",
      profitMinor: 1000,
      nonCashFxMinor: 0,
      operating: section(400),
      investing: section(0),
      financing: section(0),
      netIncreaseMinor: 400,
      fxEffectMinor: 0,
      openingCashMinor: 100,
      closingCashMinor: reconciled ? 500 : 900,
      restrictedCashMinor: 0,
      reconciled
    }
  });

  it("headlines the net change in cash", () => {
    expect(reportsHeadline(cashFlow(true), l, "en")).toBe(
      `Cash flow: cash rose by ${formatMoney(400, "AED", "en")}.`
    );
  });

  it("says so loudly when cash does not reconcile", () => {
    expect(reportsHeadline(cashFlow(false), l, "en")).toBe(
      `Cash flow is out by ${formatMoney(400, "AED", "en")}.`
    );
  });

  it("reads a window's start as the start of the day and its end as the end", () => {
    expect(epochOf("2026-06-01", "start")).toBe(Date.UTC(2026, 5, 1));
    expect(epochOf("2026-06-30")).toBe(Date.UTC(2026, 5, 30, 23, 59, 59, 999));
  });
});

describe("ledger-reports labelIn", () => {
  it("translates every English key into Arabic", () => {
    const missing = Object.keys(LABELS.en!).filter((key) => !(key in LABELS.ar!));
    expect(missing).toEqual([]);
  });
});

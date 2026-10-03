import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { formatMoney } from "@lyra/ui";
import { labelsIn, MoneyMapDiagram, Uncollected } from "./ledger-money-map";

// The finding this guards: a month of 510 binds (AED ~830k written) and no
// customer payment yet. The ledger held all of it on 1200 Premium Receivable
// and nothing on 1010, and the map, reading cash only, drew nothing. What has
// to reach the reader is the written figure and what is still owed on it.

const UNPAID = {
  periodCode: "2026-06",
  currency: "AED",
  asOf: 1,
  uncollectedMinor: 83_000_000,
  carriedMinor: 0,
  nodes: [
    { key: "premium-written", amountMinor: 83_000_000, drill: { accountCodes: ["1200"], side: "debit", txnTypes: ["BIND"] } },
    { key: "premium-cancelled", amountMinor: 0, drill: { accountCodes: ["1200"], side: "credit", txnTypes: ["BIND"] } },
    { key: "premium-collected", amountMinor: 0, drill: { accountCodes: ["1200"], side: "credit", txnTypes: ["PREM-COLLECT"] } },
    { key: "premium-due", amountMinor: 83_000_000 },
    { key: "premium-in", amountMinor: 0, drill: { accountCodes: ["1010"], side: "debit", txnTypes: ["PREM-COLLECT"] } }
  ],
  links: [{ from: "premium-written", to: "premium-due", amountMinor: 83_000_000 }]
};

function render(locale: "en" | "ar", map = UNPAID): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MoneyMapDiagram map={map} l={labelsIn(locale)} locale={locale} drilledNode={null} hrefFor={(key) => `?node=${key}`} />
    </MemoryRouter>
  );
}

describe("MoneyMapDiagram", () => {
  it("draws premium written and still due for a month nobody has paid yet", () => {
    const markup = render("en");
    expect(markup).toContain("Premium written");
    expect(markup).toContain("Still due from customers");
    expect(markup).toContain(formatMoney(83_000_000, "AED", "en"));
    expect(markup).not.toContain("Nothing was posted in this period");
    // Written opens its journal lines; the remainder has none to open.
    expect(markup).toContain('href="/?node=premium-written"');
    expect(markup).not.toContain('href="/?node=premium-due"');
  });

  it("names the nodes in Arabic and keeps the flow left to right", () => {
    const markup = render("ar");
    expect(markup).toContain(LABEL_AR("node.premium-written"));
    expect(markup).toContain(LABEL_AR("node.premium-due"));
    expect(markup).toMatch(/<section dir="ltr"/);
  });

  it("says nothing was posted when no node holds anything", () => {
    const markup = render("en", { ...UNPAID, uncollectedMinor: 0, nodes: UNPAID.nodes.map((n) => ({ ...n, amountMinor: 0 })) });
    expect(markup).toContain("Nothing was posted in this period");
  });
});

describe("Uncollected", () => {
  it("states what is still owed on the period's written premium", () => {
    const markup = renderToStaticMarkup(<Uncollected map={UNPAID} l={labelsIn("en")} />);
    expect(markup).toContain("Written, not yet collected");
    expect(markup).not.toContain("collected receivables written in an earlier period");
  });

  it("explains a negative remainder rather than drawing it", () => {
    const markup = renderToStaticMarkup(<Uncollected map={{ ...UNPAID, uncollectedMinor: -30_000 }} l={labelsIn("en")} />);
    expect(markup).toContain("collected receivables written in an earlier period");
  });
});

function LABEL_AR(key: string): string {
  return labelsIn("ar")(key);
}

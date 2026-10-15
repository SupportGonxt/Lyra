import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BudgetMap, channelColumns } from "./signal-studio";
import { channelLabel, labelsIn, rollByChannel, rollLtvMinor, type ChannelRoll, type SpendRow, type TouchRow } from "./signal.shared";

// docs/modules/signal.md §4.1: "Cockpit: CAC/LTV by channel". The screens showed
// acquisition cost as a single headline and the channel table carried spend,
// impressions and signs — so an operator could see that acquisition cost
// *something* without seeing which channel was buying customers above what they
// are worth, which is the only question the table exists to answer.
//
// The columns are functions over a row, so they are rendered rather than
// eyeballed: a channel that signed nobody must show a dash with a reason, never
// a cost of infinity and never a value of zero.

const l = labelsIn("en");
const locale = "en";
const currency = "AED";

const roll = (over: Partial<ChannelRoll> = {}): ChannelRoll => ({
  channel: "meta",
  spendMinor: 0,
  impressions: 0,
  clicks: 0,
  conversions: 0,
  binds: 0,
  valueMinor: 0,
  ...over
});

/** The cell a column renders for a row — the same path the table takes. */
function cell(key: string, row: ChannelRoll): string {
  const column = channelColumns(l, locale, currency).find((c) => c.key === key);
  if (!column) throw new Error(`no column ${key}`);
  return renderToStaticMarkup(<>{column.render(row)}</>);
}

describe("rollLtvMinor", () => {
  it("is the mean value of the signs a channel produced", () => {
    expect(rollLtvMinor({ binds: 2, valueMinor: 900_000 })).toBe(450_000);
  });

  it("is null rather than zero when it produced none", () => {
    // A mean of nothing is not zero: zero would read as "customers worth nothing".
    expect(rollLtvMinor({ binds: 0, valueMinor: 0 })).toBeNull();
  });
});

describe("the channel table", () => {
  it("shows cost and value per signup for a channel that signed somebody", () => {
    // Minor units in, major units rendered: 1 000 AED / 4 signs = 250 AED.
    expect(cell("cac", roll({ spendMinor: 100_000, binds: 4 }))).toContain("250");
    expect(cell("ltv", roll({ binds: 4, valueMinor: 2_000_000 }))).toContain("5,000");
  });

  it("shows the ratio, and marks a channel that loses money on every customer", () => {
    // 400 spend / 2 signs = 200 cost; 2 signs worth 100 each = 100 value. 0.5×.
    const losing = roll({ spendMinor: 40_000, binds: 2, valueMinor: 20_000 });
    expect(cell("ltvCac", losing)).toContain("0.5");
    expect(cell("ltvCac", losing)).toContain("text-danger");

    const winning = roll({ spendMinor: 40_000, binds: 2, valueMinor: 400_000 });
    expect(cell("ltvCac", winning)).toContain("text-success");
  });

  it("shows a dash with a reason, not a number, for a channel that signed nobody", () => {
    const nobody = roll({ spendMinor: 90_000 });
    for (const key of ["cac", "ltv", "ltvCac"]) {
      const rendered = cell(key, nobody);
      // The dash is aria-hidden and the reason travels beside it (NoData's rule).
      expect(rendered, key).toContain(l("cockpit.col.noBinds"));
    }
  });

  it("keeps the columns it already had", () => {
    const keys = channelColumns(l, locale, currency).map((c) => c.key);
    expect(keys).toEqual(["channel", "spend", "impressions", "clicks", "conversions", "binds", "cac", "ltv", "ltvCac"]);
  });
});

describe("rollByChannel", () => {
  it("joins the two ledgers on the channel string", () => {
    const spend: SpendRow[] = [
      { id: "s1", campaignId: null, channel: "meta", day: "2026-09-30", amountMinor: 100_000, currency: "AED", impressions: 10, clicks: 2, conversions: 1, source: "api", ts: 0 }
    ];
    const touches: TouchRow[] = [
      { id: "t1", customerId: null, anonId: null, touchType: "bind", channel: "meta", campaignId: null, creativeId: null, valueMinor: 300_000, currency: "AED", subjectRef: null, ts: 0 }
    ];
    const [meta] = rollByChannel(spend, touches);
    expect(meta).toMatchObject({ channel: "meta", spendMinor: 100_000, binds: 1, valueMinor: 300_000 });
    // And therefore a ratio the table can show: 3× the cost.
    expect(cell("ltvCac", meta!)).toContain("3.0");
  });
});

describe("the budget map", () => {
  const spendOf = (channel: string, amountMinor: number): SpendRow => ({
    id: `s_${channel}`,
    campaignId: null,
    channel,
    day: "2026-09-30",
    amountMinor,
    currency: "AED",
    impressions: 100,
    clicks: 5,
    conversions: 1,
    source: "api",
    ts: 0
  });

  const draw = (rolls: ChannelRoll[], plannedMinor: number) =>
    renderToStaticMarkup(<BudgetMap rolls={rolls} plannedMinor={plannedMinor} currency={currency} locale={locale} l={l} />);

  it("says which denominator its bars are measured against", () => {
    // The bar must never quietly measure something other than its label claims.
    // Minor units in, major units rendered: 750 + 250 = 1 000 AED of a 2 000 plan.
    const rolls = rollByChannel([spendOf("meta", 75_000), spendOf("google", 25_000)], []);
    const againstPlan = draw(rolls, 200_000);
    expect(againstPlan).toContain("1,000.00"); // spent
    expect(againstPlan).toContain("2,000.00"); // plan
    expect(againstPlan).toContain("50%");
    expect(againstPlan).toContain("spent of a");

    const ofActual = draw(rolls, 0);
    expect(ofActual).toContain("No plan is set");
    expect(ofActual).not.toContain("spent of a");
  });

  it("orders by weight, so the shape reads as the share", () => {
    // The biggest bar leads. The names are the app's own — a literal here would
    // be hard-coded English in a JSX file, which shell.test.ts refuses (rightly).
    const rows = rollByChannel([spendOf("meta", 10_000), spendOf("google", 90_000)], []);
    const html = renderToStaticMarkup(<BudgetMap rolls={rows} plannedMinor={0} currency={currency} locale={locale} l={l} />);
    const google = `>${channelLabel("google", locale)}<`;
    const meta = `>${channelLabel("meta", locale)}<`;
    expect(html.indexOf(google)).toBeGreaterThan(-1);
    expect(html.indexOf(google)).toBeLessThan(html.indexOf(meta));
    expect(html).toContain("90%");
  });

  it("draws nothing at all when no money was spent", () => {
    // An empty frame with a 0% bar reads as "we spent everything on nothing".
    const rows = rollByChannel([], []);
    expect(renderToStaticMarkup(<BudgetMap rolls={rows} plannedMinor={50_000} currency={currency} locale={locale} l={l} />)).toBe("");
  });
});

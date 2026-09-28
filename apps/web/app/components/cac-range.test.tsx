import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cacRange } from "@lyra/core/attribution-range";
import { CacMethod, CacRangeValue } from "./cac-range.js";
import { labelsIn } from "../routes/signal.shared.js";

// docs/17 SIG-057, ADR-0109: cost per acquisition is shown as a range with its
// method named — never the point on its own. The fixture is the API's own
// shape, produced by the very function GET /v1/signal/attribution/range answers
// with (sighting 1: a web type mirrors the server, not an assumption of it).

const en = labelsIn("en");
const ar = labelsIn("ar");
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("CacRangeValue", () => {
  it("shows both bounds and the point, never the point alone", () => {
    const range = cacRange({ spendMinor: 100_000, conversions: 10 })!;
    const out = text(renderToStaticMarkup(<CacRangeValue range={range} currency="AED" locale="en" l={en} />));
    expect(out).toContain("54.37");
    expect(out).toContain("208.54");
    expect(out).toContain("100.00");
    expect(out.indexOf("54.37")).toBeLessThan(out.indexOf("208.54"));
  });

  it("says there is no upper bound rather than printing one", () => {
    const range = cacRange({ spendMinor: 100_000, conversions: 2, creditLow: 0, creditHigh: 3 })!;
    const out = text(renderToStaticMarkup(<CacRangeValue range={range} currency="AED" locale="en" l={en} />));
    expect(out).toContain(en("attribution.unbounded"));
    expect(en("attribution.unbounded")).not.toBe("attribution.unbounded");
  });

  it("says there is nothing to price when nothing was acquired", () => {
    const out = text(renderToStaticMarkup(<CacRangeValue range={null} currency="AED" locale="en" l={en} />));
    expect(out).toBe(en("none"));
  });
});

describe("CacMethod", () => {
  it("discloses the method in a keyboard-reachable disclosure, in both languages", () => {
    for (const method of ["poisson_exact", "poisson_exact_credit_envelope"] as const) {
      const key = `attribution.method.${method}`;
      for (const l of [en, ar]) {
        expect(l(key)).not.toBe(key);
        expect(l(key, { pct: "95" })).toContain("95");
      }
    }
    const range = cacRange({ spendMinor: 100_000, conversions: 10, creditLow: 8, creditHigh: 12 })!;
    const html = renderToStaticMarkup(<CacMethod range={range} l={en} />);
    expect(html).toMatch(/^<details/);
    expect(html).toContain("<summary");
    expect(text(html)).toContain(en("attribution.method"));
    expect(text(html)).toContain(en("attribution.method.poisson_exact_credit_envelope", { pct: "95" }));
  });

  it("renders nothing when there is no range to explain", () => {
    expect(renderToStaticMarkup(<CacMethod range={null} l={en} />)).toBe("");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LABELS, NothingAtRisk, labelsIn, requoteOf } from "./orbit-save";

describe("an empty save queue", () => {
  // Role adoption: the retention seat opened its desk to "Nothing waiting on
  // us right now" while AXIS held terms expiring that month — the save queue
  // fills only once the expiry sweep raises a renewal. The empty queue now
  // points at where the expiring terms are, for a seat that may open them.
  const l = labelsIn("en");

  it("points at the expiring terms when the seat may open them", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NothingAtRisk, { l, door: true })));
    expect(html).toContain('href="/axis/renewals"');
    expect(html).toContain(l("noneQueue.door"));
    expect(html).toContain(l("noneBody"));
  });

  it("offers no door into a shell the seat cannot enter", () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(NothingAtRisk, { l, door: false })));
    expect(html).not.toContain("/axis/renewals");
  });

  it("words the door in Arabic too", () => {
    expect(LABELS.ar?.["noneQueue.door"]).toBeTruthy();
  });
});

describe("labelsIn", () => {
  it("lets the tenant's pack rename the agreement reference", () => {
    // The queue's second column is `policyRef`, which the pack owns; the desk
    // used to head it "Policy reference" on a retail tenant.
    expect(labelsIn("en", "retail-ecom")("policyRef")).toBe("Order reference");
    expect(labelsIn("ar", "retail-ecom")("policyRef")).toBe("مرجع الطلب");
  });

  it("keeps its own words, which no pack has an opinion on", () => {
    expect(labelsIn("en")("policyRef")).not.toBe("Order reference");
    expect(labelsIn("en")("customer")).toBeTruthy();
  });
});

/* ------------------ the re-quote price reaches the operator (ADR-0129) */

/**
 * The 2026-10-01 sweep's ORBIT finding: `requotesJson` was declared on the renewal
 * row and never rendered by any screen, while the notice above the desk told the
 * operator *"Nothing in the platform generates a re-quote today."* The engine writes
 * it; this is the reader.
 */
describe("requoteOf", () => {
  it("reads the engine's shape", () => {
    expect(requoteOf(JSON.stringify({ premiumMinor: 95_000, currency: "AED", offeredBy: "engine:requote" }))).toEqual({
      premiumMinor: 95_000,
      currency: "AED"
    });
  });

  it("reads the hand-typed shape too, because two writers survive", () => {
    // `make_renewal_offer` writes `{premiumMinor, currency, offeredBy}` with no panel
    // detail. Both carry the two fields the column needs, so both render.
    expect(requoteOf(JSON.stringify({ premiumMinor: 120_000, currency: "SAR", offeredBy: "user:u_1" }))).toEqual({
      premiumMinor: 120_000,
      currency: "SAR"
    });
  });

  it("carries a null price through rather than turning it into zero", () => {
    // The panel was asked and did not answer. **Null is not zero**, and a column that
    // printed 0 here would tell an operator a renewal is free.
    expect(requoteOf(JSON.stringify({ premiumMinor: null, currency: "AED", offeredBy: "engine:requote" }))).toEqual({
      premiumMinor: null,
      currency: "AED"
    });
  });

  it("answers null for anything it cannot state, rather than inventing a figure", () => {
    expect(requoteOf(null)).toBeNull();
    expect(requoteOf("")).toBeNull();
    expect(requoteOf("not json")).toBeNull();
    expect(requoteOf(JSON.stringify({ premiumMinor: 100 }))).toBeNull();
    expect(requoteOf(JSON.stringify({ currency: "AED" }))).toBeNull();
  });
});

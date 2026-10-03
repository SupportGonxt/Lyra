import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { LABELS, NothingAtRisk, labelsIn } from "./orbit-save";

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

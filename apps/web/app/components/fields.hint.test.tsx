import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FieldInput } from "./fields";
import { labelsFrom } from "../routes/detail-kit";
import type { FieldSpec } from "../modules/spec";

// Three field types are typed in units nothing on the screen states: `json`
// wants a literal document, and `rate`/`ratio` are both stored as parts per
// million but typed as a percentage and a multiplier respectively. Across the
// workspaces 434 spec fields carry 13 hints between them, so the explanation
// had to attach to the type rather than to each field.
//
// What this holds: the hint reaches the input in both languages, a field's own
// `hintKey` still wins, and the types that need no hint get none. The label
// resolver here is the real one, not a stub — the whole point is that the keys
// live in the shared catalogue and every workspace falls through to it.

const l = (locale: string) => labelsFrom({})(locale);

const render = (field: FieldSpec, locale = "en") =>
  renderToStaticMarkup(<FieldInput field={field} label={l(locale)} />);

describe("type hints on a spec field", () => {
  it("tells a person what a json field takes", () => {
    expect(render({ name: "scopeJson", type: "json" })).toContain("JSON");
  });

  it("says a rate is a percentage and a ratio is not", () => {
    expect(render({ name: "commissionPpm", type: "rate" })).toContain("percent");
    expect(render({ name: "fxPpm", type: "ratio" })).toContain("not a percentage");
  });

  it("says it in Arabic too", () => {
    const html = render({ name: "scopeJson", type: "json" }, "ar");
    expect(html).toContain("كائن");
    // The key itself never reaches a reader in either language.
    expect(html).not.toContain("field.hint.json");
  });

  it("lets a field's own hintKey win", () => {
    const html = renderToStaticMarkup(
      <FieldInput
        field={{ name: "scopeJson", type: "json", hintKey: "mine" }}
        label={(key) => (key === "mine" ? "Which tenants this key may read." : key)}
      />
    );
    expect(html).toContain("Which tenants this key may read.");
    expect(html).not.toContain("JSON —");
  });

  it("leaves the types whose label already says it alone", () => {
    // **`money` was in this assertion, and that was the bug.**
    //
    // It read *"`money` submits raw minor units and every such field is named
    // `…Minor`"* — true of the **name**, false of the **label** a person reads. So
    // the one test guarding this behaviour asserted that no unit words appear, while
    // this file's own fixture (`labelsFrom({})` above) resolved "premiumMinor" to the
    // field name — the single string that contains "Minor". The check confirmed the
    // premise using the premise.
    //
    // The 2026-10-01 sweep's WEB finding; verified end to end: a `<label>Subtotal</label>`
    // accepted `1575` and stored 1575 fils, rendered as AED 15.75.
    // **This line has now been wrong in both directions, which is why it carries a
    // reason.** It first asserted *no* hint, on the false premise that the field name
    // said the unit — that was the bug. It then asserted a hint, because the field
    // posted raw minor units and the only honest thing to do was say so. It asserts
    // none again now that the field renders a currency-aware `MoneyField`: a hint
    // saying "in minor units" beside an input that takes major units would be a second,
    // contradictory statement.
    //
    // The assertion that would actually guard this is "the currency renders beside the
    // input", which needs `MoneyField`'s DOM and is **owed** — a test about hints
    // cannot see a conversion, and that is how this defect survived in the first place.
    expect(render({ name: "premiumMinor", type: "money" })).not.toContain("hint");
    // A type whose label genuinely carries the unit — a plain word — still gets none.
    expect(render({ name: "name", type: "text" })).not.toContain("hint");
  });
});

/* ------------- the money input converts, which a hint test could not see */

/**
 * The 2026-10-01 sweep's WEB finding, and the reason it needs its own test: the
 * defect was a **missing conversion**, and every guard around it asserted things
 * about *hints* — so the check could not see the bug, and when I added a hint the
 * check went green while the money was still stored in the wrong unit.
 *
 * `MoneyField` is the seam: a visible control that speaks major units and a **hidden
 * input carrying the integer minor units** the API stores. So the assertion that can
 * see this is the hidden input existing beside the visible one — which is a property
 * of the markup and therefore visible to `renderToStaticMarkup`.
 */
describe("a spec money field converts rather than posting raw units", () => {
  it("renders the conversion seam, not a bare number input", () => {
    const html = render({ name: "subtotalMinor", type: "money" });
    // `MoneyField`'s contract: "a hidden input carries the integer minor units the API
    // and the ledger require, so no call site converts and no user types cents."
    expect(html).toContain('type="hidden"');
    expect(html).toContain('name="subtotalMinor"');
    // The visible control is still a number input, and that is correct: it takes
    // **major** units, so it must accept a decimal. What the old engine rendered,
    // beside it, was nothing — a single `step="1"` input that typed fils.
    expect(html).toContain('type="number"');
    // Two controls, not one: the visible major-unit field and the hidden minor carrier.
    expect((html.match(/<input/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

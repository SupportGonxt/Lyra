/**
 * A screen that sizes a control gets the size it asked for.
 *
 * `cn` joins class names; it does not resolve Tailwind conflicts (cn.ts). So
 * the `w-full` that used to live in `controlBase` shipped ahead of the caller's
 * class and won, and nine call sites across apps/web were passing widths that
 * did nothing — most visibly the module filter strip, which rendered one
 * full-width control per row and pushed the table below the fold.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field, Input, Select, Slider, Textarea } from "./primitives.js";

const classesOf = (markup: string) => (markup.match(/class="([^"]*)"/)?.[1] ?? "").split(" ");

describe("control width", () => {
  it("fills its column when the screen says nothing", () => {
    for (const markup of [
      renderToStaticMarkup(<Input aria-label="Reason" />),
      renderToStaticMarkup(<Textarea aria-label="Reason" />),
      renderToStaticMarkup(<Select aria-label="Status" options={[{ value: "a", label: "A" }]} />)
    ]) {
      expect(classesOf(markup)).toContain("w-full");
    }
  });

  it("yields the default when the screen brought a width of its own", () => {
    const sized = renderToStaticMarkup(<Input aria-label="Reason" className="w-56" />);
    expect(classesOf(sized)).toContain("w-56");
    expect(classesOf(sized)).not.toContain("w-full");

    // A flex child that grows is sized by its parent — same story.
    const grows = renderToStaticMarkup(<Input aria-label="Reason" className="flex-1" />);
    expect(classesOf(grows)).not.toContain("w-full");

    // max-w- is a ceiling, not a width: the control still needs to fill.
    const capped = renderToStaticMarkup(<Input aria-label="Reason" className="max-w-prose" />);
    expect(classesOf(capped)).toContain("w-full");
  });
});

/**
 * A filter whose "no filter" row is selected has to say so.
 *
 * The empty option travels to Radix under EMPTY_SENTINEL, but the value handed
 * to the Root did not — so "" matched no item, Radix read it as "nothing
 * chosen", and the trigger rendered the "…" placeholder. NORTH's anomaly queue
 * shipped that way: a "Show" filter whose only readable text was an ellipsis.
 */
describe("select placeholder", () => {
  const options = [
    { value: "", label: "Everything" },
    { value: "new", label: "Unowned" }
  ];

  it("reads back the empty row's label, not the placeholder", () => {
    const markup = renderToStaticMarkup(<Select aria-label="Show" defaultValue="" options={options} />);
    expect(markup).not.toContain("data-placeholder");
    expect(markup).not.toContain("…");
  });

  it("still shows the placeholder when no empty row exists", () => {
    const markup = renderToStaticMarkup(
      <Select aria-label="Show" defaultValue="" options={[{ value: "new", label: "Unowned" }]} />
    );
    expect(markup).toContain("data-placeholder");
  });

  // The sentinel is a rendering detail of the Radix tree; what the form posts
  // is the decoded value, and picking "Everything" has to clear the filter.
  it("submits the decoded value", () => {
    const markup = renderToStaticMarkup(<Select name="state" aria-label="Show" defaultValue="" options={options} />);
    expect(markup).toContain('name="state" value=""');
  });
});

/**
 * The comparison sliders (portal quote page). A price knob that only a mouse
 * can turn is not a price knob for most of the people who need one, so every
 * requirement here is an accessibility requirement rather than a nicety:
 * WCAG 2.2 AA wants it reachable by keyboard, announced as a value a person
 * recognises, and settable by typing when dragging is not on offer.
 */
describe("Slider", () => {
  const base = { min: 18, max: 99, value: 34, onValueChange: () => {}, numberLabel: "Age, exact value" };

  it("is a native range, so keyboard, touch and RTL come from the platform", () => {
    const markup = renderToStaticMarkup(<Slider aria-label="Age" {...base} />);
    expect(markup).toContain('type="range"');
    expect(markup).toContain('min="18"');
    expect(markup).toContain('max="99"');
    expect(markup).toContain('value="34"');
  });

  it("announces the value a person recognises, not the raw number", () => {
    const markup = renderToStaticMarkup(<Slider aria-label="Cover" {...base} valueText="AED 28,000" />);
    expect(markup).toContain('aria-valuetext="AED 28,000"');
  });

  it("always offers a typed fallback, labelled in its own right", () => {
    const markup = renderToStaticMarkup(<Slider aria-label="Age" {...base} />);
    expect(markup).toContain('type="number"');
    expect(markup).toContain('aria-label="Age, exact value"');
    // Both controls carry the same bounds: typing past the end is refused the
    // same way dragging past it is.
    expect(markup.match(/max="99"/g)!.length).toBe(2);
  });

  it("gives the Field's label to the range and never duplicates its id", () => {
    const markup = renderToStaticMarkup(
      <Field label="Age" id="age-field">
        <Slider {...base} />
      </Field>
    );
    expect(markup).toContain('for="age-field"');
    expect(markup.match(/id="age-field"/g)!.length).toBe(1);
    expect(markup).toContain('id="age-field-number"');
  });

  it("keeps a 44px target and a visible focus ring on both controls", () => {
    const markup = renderToStaticMarkup(<Slider aria-label="Age" {...base} />);
    expect(markup).toContain("h-11");
    expect(markup.match(/focus-visible:/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("Input adornments", () => {
  // "ZAR" under a fixed ps-9 overlapped the typed value (signal studio).
  it("reserves a text prefix's own width", () => {
    const html = renderToStaticMarkup(<Input prefix="ZAR" aria-label="Budget" />);
    expect(html).toContain("padding-inline-start:calc(3ch + 1.25rem)");
  });
});

describe("direction isolation", () => {
  // An email in an Arabic form sat right-aligned with its "@" moved.
  it("sets an email, url or phone input left to right", () => {
    expect(renderToStaticMarkup(<Input type="email" aria-label="Email" />)).toContain('dir="ltr"');
    expect(renderToStaticMarkup(<Input type="text" aria-label="Name" />)).not.toContain('dir="ltr"');
  });
});

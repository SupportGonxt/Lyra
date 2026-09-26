import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { designSvg } from "@lyra/ui";
import { DesignCanvas, designOf, keyEdit } from "./design-canvas";

// ST2: the studio's canvas editor. Dragging needs a pointer, so everything a
// keyboard can do is a pure function here (WCAG 2.2: every move a mouse makes,
// the keyboard makes too), and the rendered editor is checked for the controls
// a screen reader needs.

describe("keyEdit", () => {
  const still = { dx: 0, dy: 0, scale: 1 };
  it("nudges by 4 frame pixels, 20 with shift, in the direction pressed", () => {
    expect(keyEdit(still, "ArrowRight", false)).toEqual({ dx: 4, dy: 0, scale: 1 });
    expect(keyEdit(still, "ArrowUp", true)).toEqual({ dx: 0, dy: -20, scale: 1 });
  });
  it("grows and shrinks in steps, within half to double", () => {
    expect(keyEdit(still, "+", false)).toEqual({ dx: 0, dy: 0, scale: 1.05 });
    expect(keyEdit({ dx: 0, dy: 0, scale: 0.5 }, "-", false)).toEqual({ dx: 0, dy: 0, scale: 0.5 });
  });
  it("puts an element back with 0, and ignores every other key", () => {
    expect(keyEdit({ dx: 9, dy: 9, scale: 1.5 }, "0", false)).toEqual(still);
    expect(keyEdit(still, "a", false)).toBeNull();
  });
});

describe("designOf", () => {
  it("reads a stored design, and falls back to the default layout for anything else", () => {
    expect(designOf({ template: "quote", edits: { square: { cta: { dx: 1, dy: 2, scale: 1 } } } })).toEqual({
      template: "quote",
      edits: { square: { cta: { dx: 1, dy: 2, scale: 1 } } }
    });
    expect(designOf(null)).toEqual({ template: "spotlight", edits: {} });
    expect(designOf({ template: "collage" })).toEqual({ template: "spotlight", edits: {} });
  });
});

describe("DesignCanvas", () => {
  it("offers every element as a pressable choice and a size control, labelled", () => {
    const svg = designSvg({ template: "spotlight", format: "square", headline: "Hi", cta: "Go", brand: { name: "Acme" } });
    const html = renderToStaticMarkup(
      <DesignCanvas svg={svg} width={1080} height={1080} edits={{}} onChange={() => {}} l={(k) => k} />
    );
    for (const slot of ["headline", "body", "kicker", "cta", "brand"]) expect(html).toContain(`studio.slot.${slot}`);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('type="range"');
    expect(html).toContain("studio.canvasHint");
  });
});

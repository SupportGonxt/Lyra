/**
 * Every screen that opens on a Hero — /axis/bordereaux and the four journey
 * screens — had no <h1> at all: the title rendered as a Lede paragraph, so a
 * screen reader's heading list started at a card and the page had no name in
 * the outline (WCAG 2.2 1.3.1, 2.4.6). The Hero's title is the page's heading.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "./hero.js";

describe("Hero", () => {
  it("names the page with exactly one h1, holding its title", () => {
    const markup = renderToStaticMarkup(<Hero eyebrow="AXIS" title="Bordereaux" sub="The file between us" mod="axis" />);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>Bordereaux<\/h1>/);
  });
});

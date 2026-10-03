/**
 * /axis/bordereaux opens on a Hero and had no <h1>: the title rendered as a
 * Lede paragraph, so the page had no name in the outline (WCAG 2.2 1.3.1,
 * 2.4.6). `heading` makes the title the h1. It is opt-in because most Hero
 * screens already carry one (journey steps: JourneyHeader), and a second h1
 * fails the flagship journey's one-h1 check.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Hero } from "./hero.js";

describe("Hero", () => {
  it("names the page with exactly one h1, holding its title", () => {
    const markup = renderToStaticMarkup(<Hero eyebrow="AXIS" title="Bordereaux" sub="The file between us" mod="axis" heading />);
    expect(markup.match(/<h1\b/g)).toHaveLength(1);
    expect(markup).toMatch(/<h1[^>]*>Bordereaux<\/h1>/);
  });

  it("stays a lede, not a second h1, when the screen names itself", () => {
    expect(renderToStaticMarkup(<Hero eyebrow="AXIS" title="Bordereaux" mod="axis" />)).not.toMatch(/<h1\b/);
  });
});

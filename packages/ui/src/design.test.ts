import { describe, expect, it } from "vitest";
import { contrastRatio, designFindings, designSvg, FORMATS, TEMPLATES, type DesignInput } from "./design.js";

// The designer studio's engine (ST1). One brief, every layout, every size a
// network or inbox takes, from the tenant's own brand (CLAUDE.md §5) — the
// preview and the download are the same bytes.

const base: DesignInput = {
  template: "spotlight",
  format: "square",
  headline: "Cover in minutes & <no> paperwork",
  body: "Built for families who would rather be outside.",
  kicker: "Motor",
  cta: "Get a quote",
  brand: { name: "Acme Cover", accent: "#c8f163", accentContrast: "#0b0e13" }
};

const viewBox = (svg: string) => /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!.slice(1).map(Number);

describe("designSvg", () => {
  it("renders every template at every format, at that format's own size", () => {
    for (const template of TEMPLATES) {
      for (const [format, box] of Object.entries(FORMATS)) {
        const svg = designSvg({ ...base, template, format: format as DesignInput["format"] });
        expect(svg.startsWith("<svg"), `${template}/${format}`).toBe(true);
        expect(viewBox(svg), `${template}/${format}`).toEqual([box.w, box.h]);
        expect(svg, `${template}/${format}`).toContain("Acme Cover");
      }
    }
  });

  it("escapes tenant copy, so an ampersand or angle bracket cannot break the file", () => {
    const svg = designSvg(base);
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&lt;no&gt;");
    expect(svg).not.toContain("<no>");
  });

  it("carries the call to action on every template that has room for one", () => {
    for (const template of TEMPLATES) expect(designSvg({ ...base, template }), template).toContain("Get a quote");
  });

  it("sets Arabic right to left, anchored on the right", () => {
    const svg = designSvg({ ...base, headline: "تأمين في دقائق", locale: "ar" });
    expect(svg).toContain('direction="rtl"');
    // Logical anchoring: "start" under rtl is the right edge, so the headline
    // sits on the right half of the card, not hanging off it.
    const x = Number(/<text x="(\d+)" y="\d+" class="head"/.exec(svg)![1]);
    expect(x).toBeGreaterThan(540);
    expect(x).toBeLessThanOrEqual(1080);
  });

  it("uses the tenant's face and logo when the brand has them", () => {
    const svg = designSvg({ ...base, brand: { ...base.brand, font: "inter", logoHref: "https://cdn.example.test/mark.svg" } });
    expect(svg).toContain("Inter");
    expect(svg).toContain('href="https://cdn.example.test/mark.svg"');
  });

  it("places the image in the templates that frame one", () => {
    const svg = designSvg({ ...base, template: "split", imageHref: "https://cdn.example.test/hero.jpg" });
    expect(svg).toContain('href="https://cdn.example.test/hero.jpg"');
  });

  it("breaks a word longer than a line rather than running it off the frame", () => {
    const svg = designSvg({ ...base, headline: "x".repeat(60) });
    const lines = [...svg.matchAll(/class="head">([^<]*)</g)].map((m) => m[1]!.replace("…", ""));
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  });

  it("keeps a banner to one line of headline", () => {
    const svg = designSvg({ ...base, format: "leaderboard", headline: "A long headline that would wrap three times on a square card" });
    expect((svg.match(/class="head"/g) ?? []).length).toBe(1);
  });
});

describe("contrastRatio", () => {
  it("is WCAG's ratio", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("nope", "#ffffff")).toBeNull();
  });
});

describe("designFindings", () => {
  it("names the text a brand colour makes unreadable, and passes a legible design", () => {
    // A mid-grey accent under mid-grey text: every slot on the quote ground fails.
    expect(designFindings({ ...base, template: "quote", brand: { name: "Acme", accent: "#777777", accentContrast: "#8a8a8a" } }).map((f) => f.slot)).toEqual(["headline", "body", "kicker", "cta"]);
    expect(designFindings(base)).toEqual([]);
  });
});

describe("edits (ST2 canvas)", () => {
  const slot = (svg: string, name: string) => new RegExp(`<g data-slot="${name}"([^>]*)>`).exec(svg)?.[1] ?? "";

  it("wraps each element in a group the editor can grab", () => {
    const svg = designSvg(base);
    for (const name of ["headline", "body", "kicker", "cta", "brand"]) expect(svg, name).toContain(`<g data-slot="${name}"`);
  });

  it("moves and scales an element about its own origin, leaving the rest where they were", () => {
    const plain = designSvg(base);
    const moved = designSvg({ ...base, edits: { headline: { dx: 40, dy: -20, scale: 1.25 } } });
    expect(slot(moved, "headline")).toContain("translate(40 -20)");
    expect(slot(moved, "headline")).toContain("scale(1.25)");
    expect(slot(moved, "body")).toBe(slot(plain, "body"));
  });

  it("keeps an edit on the canvas and within a sane size", () => {
    const svg = designSvg({ ...base, edits: { cta: { dx: 99999, dy: -99999, scale: 40 } } });
    expect(slot(svg, "cta")).toContain("translate(1080 -1080)");
    expect(slot(svg, "cta")).toContain("scale(2)");
  });
});

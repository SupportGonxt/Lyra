import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { blocks, Markdown, safeHref } from "./markdown";

// ADR-0089. A note is text a person typed, rendered back to every colleague
// who opens the record — so the renderer's first job is to refuse to be an
// injection vector. It builds React elements, never an HTML string, which
// makes escaping structural rather than something each branch remembers.

const resolve = (ref: string, label?: string) =>
  ref === "cu_1" ? { text: label ?? "Falcon Freight", href: "/admin/customers/cu_1/360" } : { text: label ?? ref };

const html = (source: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Markdown source={source} link={resolve} />
    </MemoryRouter>
  );

describe("blocks", () => {
  it("splits headings, lists, quotes, code and paragraphs", () => {
    expect(blocks("# Title\n\npara one\nstill one\n\n- a\n- b\n\n1. x\n2. y\n\n> q\n\n```\ncode [[cu_1]]\n```")).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", lines: ["para one", "still one"] },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["x", "y"] },
      { kind: "quote", lines: ["q"] },
      { kind: "code", text: "code [[cu_1]]" }
    ]);
  });
});

describe("Markdown", () => {
  it("renders emphasis, code and headings below the page's own heading level", () => {
    const [strong, soft] = ["bold", "it"];
    const out = html(`## Renewal\n**${strong}** and *${soft}* and \`x < y\``);
    expect(out).toContain("<h4");
    expect(out).toContain(`<strong>${strong}</strong>`);
    expect(out).toContain(`<em>${soft}</em>`);
    expect(out).toContain("<code");
    expect(out).toContain("x &lt; y");
  });

  it("resolves a wikilink to the record's name and screen", () => {
    const out = html("Owned by [[cu_1]] and [[zz_9|someone]]");
    expect(out).toContain('href="/admin/customers/cu_1/360"');
    const name = "Falcon Freight";
    expect(out).toContain(`>${name}</a>`);
    // Unresolvable: the label as plain text, marked, never a link to nowhere.
    expect(out).toContain("someone");
    expect(out).not.toContain('href="zz_9"');
  });

  it("escapes HTML a person typed", () => {
    const out = html('<script>alert(1)</script> <img src=x onerror="alert(1)"> [[cu_1|<b>x</b>]]');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<b>x</b>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("refuses a link to anything but the web or mail", () => {
    const out = html("[a](javascript:alert(1)) [b](data:text/html,x) [c](https://example.com) [d](/axis/board) [e](//evil.test)");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("data:text");
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('rel="noreferrer noopener"');
    expect(out).toContain('href="/axis/board"');
    expect(out).not.toContain('href="//evil.test"');
  });
});

describe("safeHref", () => {
  it("allows http(s), mailto and same-site paths only", () => {
    expect(safeHref("https://a.b")).toBe("https://a.b");
    expect(safeHref("mailto:x@y.z")).toBe("mailto:x@y.z");
    expect(safeHref("/x")).toBe("/x");
    for (const bad of ["javascript:x", " JaVaScRiPt:x", "vbscript:x", "data:x", "//x", "/\\x", "x"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

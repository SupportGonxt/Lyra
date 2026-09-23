import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatWikilink, linkTargets, parseWikilinks, rewriteWikilinks } from "./wikilinks.js";

// ADR-0089. A note's links are derived from its text on every save, so this
// parser is the whole contract between what a person wrote and what the
// backlinks panel, the graph and the vault export say about it.

describe("parseWikilinks", () => {
  it("reads a bare ref and a labelled ref", () => {
    expect(parseWikilinks("see [[cu_1]] and [[policy:pol_2|Motor 2026]]")).toEqual([
      { ref: "cu_1", raw: "[[cu_1]]", index: 4 },
      { ref: "policy:pol_2", label: "Motor 2026", raw: "[[policy:pol_2|Motor 2026]]", index: 17 }
    ]);
  });

  it("trims the ref and the label, and treats an empty label as none", () => {
    expect(parseWikilinks("[[  cu_1  |  Falcon  ]] [[cu_2|   ]]").map(({ ref, label }) => ({ ref, label }))).toEqual([
      { ref: "cu_1", label: "Falcon" },
      { ref: "cu_2", label: undefined }
    ]);
  });

  it("keeps Arabic and other unicode labels whole", () => {
    const [link] = parseWikilinks("العميل [[customer:cu_9|فالكون للشحن]] مهم");
    expect(link?.label).toBe("فالكون للشحن");
    expect(link?.ref).toBe("customer:cu_9");
  });

  it("ignores malformed brackets", () => {
    for (const text of ["[[]]", "[[ ]]", "[[|label]]", "[[cu_1", "cu_1]]", "[cu_1]", "[[cu\n_1]]", "[[a|b\nc]]"]) {
      expect(parseWikilinks(text), text).toEqual([]);
    }
  });

  it("takes the innermost link when brackets nest", () => {
    expect(parseWikilinks("[[outer [[cu_1|inner]] tail]]").map((l) => l.ref)).toEqual(["cu_1"]);
  });

  it("does not read links inside inline code or fenced code", () => {
    const md = "a `[[cu_1]]` b\n```\n[[cu_2]]\n```\n[[cu_3]]";
    expect(parseWikilinks(md).map((l) => l.ref)).toEqual(["cu_3"]);
  });

  it("refuses a ref longer than a record ref can be", () => {
    expect(parseWikilinks(`[[${"x".repeat(201)}]]`)).toEqual([]);
  });
});

describe("linkTargets", () => {
  it("is each ref once, first label wins, in order of appearance", () => {
    expect(linkTargets("[[cu_2|B]] [[cu_1]] [[cu_2|again]] [[cu_1|late label]]")).toEqual([
      { ref: "cu_2", label: "B" },
      { ref: "cu_1", label: "late label" }
    ]);
  });
});

describe("rewriteWikilinks", () => {
  it("replaces each link and leaves the rest byte for byte", () => {
    const md = "x [[cu_1|A]] y `[[cu_1]]` z [[cu_2]]";
    expect(rewriteWikilinks(md, (l) => `<${l.ref}>`)).toBe("x <cu_1> y `[[cu_1]]` z <cu_2>");
  });
});

describe("formatWikilink", () => {
  it("strips the characters that would end the link early", () => {
    expect(formatWikilink("cu_1", "A [b] | c\nd `e`")).toBe("[[cu_1|A b c d e]]");
    expect(formatWikilink("cu_1")).toBe("[[cu_1]]");
  });
});

describe("wikilink properties", () => {
  const ref = fc.stringMatching(/^[a-z]{1,8}(:[a-z]{1,4})?_[A-Za-z0-9]{1,26}$/);
  // Any unicode, including Arabic, RTL marks and the bracket characters the
  // formatter must neutralise.
  const label = fc.string({ unit: "grapheme", maxLength: 40 });

  it("never throws on arbitrary text", () => {
    fc.assert(fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (text) => {
      parseWikilinks(text);
      linkTargets(text);
    }));
  });

  it("round-trips anything the picker writes", () => {
    fc.assert(
      fc.property(ref, label, (r, l) => {
        const [parsed, ...rest] = parseWikilinks(`note ${formatWikilink(r, l)} end`);
        expect(rest).toEqual([]);
        expect(parsed?.ref).toBe(r);
        const expected = l.replace(/[[\]|`\r\n]+/g, " ").replace(/\s+/g, " ").trim();
        expect(parsed?.label).toBe(expected || undefined);
      })
    );
  });

  it("rewriting every link to its own raw text is the identity", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (text) => {
        expect(rewriteWikilinks(text, (l) => l.raw)).toBe(text);
      })
    );
  });

  it("targets are unique", () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(ref, label), { maxLength: 10 }), (pairs) => {
        const md = pairs.map(([r, l]) => formatWikilink(r, l)).join(" ");
        const refs = linkTargets(md).map((t) => t.ref);
        expect(new Set(refs).size).toBe(refs.length);
        expect(new Set(refs)).toEqual(new Set(pairs.map(([r]) => r)));
      })
    );
  });
});

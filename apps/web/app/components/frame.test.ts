import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The frame contract, checked as text.
 *
 * A page layout is right when it is systematic, not when each screen was
 * nudged by hand — so the check is not "does this pixel look correct" (jsdom
 * has no layout and could not tell us) but "does every shell derive its frame
 * from the one scale". Two halves:
 *
 *   1. the scale itself resolves to the values horizon-1-shell.md §5 fixes;
 *   2. no owned shell writes a frame pixel, a viewport calc, or a physical
 *      direction of its own.
 *
 * Scope is every shell that renders the frame. `companion.tsx` is a panel
 * inside one, not a frame of its own, so it is not listed here.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../..");
const tokens = readFileSync(join(REPO, "packages/ui/src/tokens.css"), "utf8");

// One frame (ADR-0085): the module shells are wrappers that pass their screens
// to `Shell`, and are held to rendering no chrome of their own below.
const SHELLS = ["shell.tsx"];
const WRAPPERS = ["axis-shell.tsx", "north-shell.tsx", "orbit-shell.tsx", "scout-shell.tsx", "signal-shell.tsx"];
const OWNED = [...SHELLS, "module-shell.tsx", "meridian.tsx", "shift-clear.tsx"];

const source = (file: string) => readFileSync(join(HERE, file), "utf8");

/** First declaration of a token, which is the base (dark/narrow) one. */
function tokenValue(name: string, css = tokens): string | null {
  const match = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return match ? match[1]!.trim() : null;
}

/** The body of the first `@media <query>` block, brace-matched. */
function mediaBlock(query: string): string {
  const start = tokens.indexOf(`@media ${query}`);
  expect(start, `@media ${query} is declared`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = tokens.indexOf("{", start); i < tokens.length; i += 1) {
    if (tokens[i] === "{") depth += 1;
    else if (tokens[i] === "}") {
      depth -= 1;
      if (depth === 0) return tokens.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated @media ${query}`);
}

describe("frame scale (horizon-1-shell.md §5)", () => {
  // The three band heights the spec fixes exactly, plus the strip below.
  const bands: Array<[string, string]> = [
    ["chrome-top", "50px"],
    ["chrome-module", "38px"],
    ["chrome-meridian", "74px"],
    ["chrome-status", "28px"]
  ];

  it.each(bands)("--%s is %s", (name, value) => {
    expect(tokenValue(name)).toBe(value);
  });

  it("sizes the rail and the gutters from the same scale", () => {
    expect(tokenValue("rail-width")).toBe("196px");
    expect(tokenValue("gutter")).toBe("12px");
    expect(tokenValue("gutter-canvas")).toBe("16px");
    expect(tokenValue("gutter-rail")).toBe("12px");
    expect(tokenValue("stack-gap")).toBe("16px");
  });

  it("steps the gutters and the rail in the tokens, not in the shells", () => {
    // horizon-5-behaviour.md §5: the rail is 252px from 1240px up, 196px below.
    expect(mediaBlock("(min-width: 1240px)")).toContain("--rail-width: 252px");
    const roomy = mediaBlock("(min-width: 640px)");
    expect(roomy).toContain("--gutter: 16px");
    expect(roomy).toContain("--gutter-canvas: 24px");
  });

  it("keeps every frame value on the 4px grid bar the fixed band heights", () => {
    const fixed = new Set(["50px", "38px", "74px"]);
    const frame = /--(chrome-[a-z]+|rail-width|gutter[a-z-]*|stack-gap):\s*(\d+)px;/g;
    for (const [, name, px] of tokens.matchAll(frame)) {
      if (fixed.has(`${px}px`)) continue;
      expect(Number(px) % 4, `--${name}: ${px}px is off the 4px grid`).toBe(0);
    }
  });
});

describe("shell frames", () => {
  it.each(SHELLS)("%s fills the viewport exactly once", (file) => {
    const text = source(file);
    // One fixed-height root, nothing above it scrolls: the canvas is the only
    // vertical scroller, so there is no second scrollbar and the status strip
    // is a band rather than an overlay covering the last row.
    expect(text).toContain('className="lyra-field flex h-dvh flex-col overflow-hidden bg-bg text-text"');
    expect(text).toContain('className="flex min-h-0 flex-1 flex-col md:flex-row"');
    expect(text).toMatch(/lyra-vt-workspace[^"]*overflow-y-auto/);
    expect(text).not.toContain("sticky bottom-0");
    expect(text).not.toContain("min-h-screen");
  });

  it.each(SHELLS)("%s takes every frame dimension from a token", (file) => {
    const text = source(file);
    expect(text).not.toMatch(/100vh/);
    expect(text).not.toMatch(/\[50px\]/);
    expect(text).not.toMatch(/(?:^|[\s"':])(?:md|lg)?:?w-60\b/);
    expect(text).not.toMatch(/max-w-\[100rem\]/);
    expect(text).toMatch(/var\(--chrome-top\)/);
    expect(text).toMatch(/var\(--rail-width\)/);
    expect(text).toMatch(/var\(--gutter-canvas\)/);
  });
});

// Same list as packages/ui/src/ui.test.ts's RTL check, applied to the shells:
// that one only walks packages/ui/src, so apps/web's chrome was ungated.
describe("RTL: logical properties only", () => {
  const physical: Array<[string, RegExp]> = [
    ["margin-left / margin-right", /\b(?:margin|padding|border|inset|scroll-margin|scroll-padding)-(?:left|right)\b/],
    ["text-align: left|right", /text-align\s*:\s*(?:left|right)/],
    ["float", /\bfloat\s*:\s*(?:left|right)/],
    ["tw ml-/mr-/pl-/pr-", /(?:^|[\s"'`{-])(?:ml|mr|pl|pr)-/],
    ["tw left-/right-", /(?:^|[\s"'`{-])(?:left|right)-\d/],
    ["tw border-l/border-r", /(?:^|[\s"'`{-])border-[lr](?:\b|-)/],
    ["tw rounded-l/rounded-r/corner", /(?:^|[\s"'`{-])rounded-(?:l|r|tl|tr|bl|br)(?:\b|-)/],
    ["tw text-left/text-right", /(?:^|[\s"'`{-])text-(?:left|right)\b/],
    ["tw float-left/float-right", /(?:^|[\s"'`{-])float-(?:left|right)\b/]
  ];

  it.each(OWNED)("%s uses no physical-direction styling", (file) => {
    const text = source(file);
    for (const [label, pattern] of physical) {
      expect(pattern.test(text), `${file} uses ${label}`).toBe(false);
    }
  });
});

describe("module shells", () => {
  it.each(WRAPPERS)("%s renders through the one frame and draws no chrome", (file) => {
    const text = source(file);
    expect(text).toContain("<ModuleShell");
    expect(text).not.toMatch(/<(header|nav|main|footer)\b/);
  });
});

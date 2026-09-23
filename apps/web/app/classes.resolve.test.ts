import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { __unstable__loadDesignSystem } from "tailwindcss";
import { describe, expect, it } from "vitest";

// A Tailwind class that names no token compiles to nothing, silently: `text-11`
// (22 uses), `bg-raised`, `border-hairline`, `leading-body` and `font-600` all
// rendered as if absent — code blocks with no background, hairlines in
// currentColor. Typecheck, lint and unit tests cannot see it; only compiling
// the class can. This compiles every Tailwind-shaped token in the web app and
// the design system against the real stylesheet and fails on any that yields
// no CSS, and on any `var(--x)` inside a class that no stylesheet defines.

const APP = dirname(fileURLToPath(import.meta.url));
const UI = resolve(APP, "../../../packages/ui/src");
const require = createRequire(import.meta.url);

/** Utility roots this repo writes. A token on one of them must compile. */
const ROOT =
  /^-?(text|bg|border|rounded|font|leading|tracking|p[xytbse]?|m[xytbse]?|gap(-[xy])?|w|h|size|min-w|max-w|min-h|max-h|inset(-[xy])?|start|end|top|bottom|shadow|ring|outline|opacity|duration|ease|animate|grid-cols|col-span|z|translate-[xy]|scale(-[xy])?|fill|stroke|divide|space-[xy]|line-clamp|decoration|underline-offset|aspect|basis|order|delay|blur)-/;

/** Tokens that look like utilities but are something else, each with its reason. */
const NOT_UTILITIES: Record<string, string> = {
  "top-level": "prose in an explanatory string (axis-analytics, signal-analytics)",
  "top-priority": "a sort key (claims-desk)",
  "stroke-dasharray": "an SVG attribute name (components/shift.ts)",
  "ps-/pe-/ms-/me-/": "a doc comment listing logical-property prefixes (primitives.tsx)",
  "start-/end-/border-s/text-start": "a doc comment listing logical utilities (primitives.tsx)"
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** Every token in every plain string literal, variants stripped. */
function candidates(source: string): Set<string> {
  const out = new Set<string>();
  for (const match of source.matchAll(/"([^"\n]*)"|`([^`$]*)`/g)) {
    const literal = match[1] ?? match[2] ?? "";
    for (const token of literal.split(/\s+/)) {
      if (!token || /[<>{}";]/.test(token)) continue;
      const base = token.replace(/^!/, "").split(/:(?![^[]*\])/).at(-1) ?? "";
      if (ROOT.test(base)) out.add(token);
    }
  }
  return out;
}

async function designSystem() {
  const loadStylesheet = async (id: string, base: string) => {
    const path =
      id === "tailwindcss"
        ? require.resolve("tailwindcss/index.css")
        : id.startsWith("@lyra/ui/")
          ? join(UI, id.slice("@lyra/ui/".length))
          : resolve(base, id);
    return { path, base: dirname(path), content: readFileSync(path, "utf8") };
  };
  return __unstable__loadDesignSystem(readFileSync(join(APP, "app.css"), "utf8"), { base: APP, loadStylesheet });
}

describe("every Tailwind class compiles", () => {
  const sources = [...files(APP), ...files(UI)];

  it("scans both the app and the design system", () => {
    expect(sources.some((path) => path.startsWith(UI))).toBe(true);
    expect(sources.some((path) => path.endsWith("module.tsx"))).toBe(true);
  });

  it("yields CSS for every class token", async () => {
    const system = await designSystem();
    const dead: string[] = [];
    for (const path of sources) {
      const tokens = [...candidates(readFileSync(path, "utf8"))].filter((token) => !(token in NOT_UTILITIES));
      const css = system.candidatesToCss(tokens);
      tokens.forEach((token, index) => {
        if (!css[index]) dead.push(`${path.slice(APP.length - 3)}: ${token}`);
      });
    }
    expect(dead).toEqual([]);
  }, 60_000);

  // Eleven arbitrary sizes (8.5px to 40px) sat beside the scale, three of them
  // under 12px. A size is a token: text-12 … text-48.
  it("sizes type from the scale, never in raw pixels", () => {
    const raw = sources.flatMap((path) =>
      [...candidates(readFileSync(path, "utf8"))].filter((token) => /(^|:)text-\[[\d.]+(px|rem)\]$/.test(token)).map((token) => `${path.slice(APP.length - 3)}: ${token}`)
    );
    expect(raw).toEqual([]);
  });

  it("names only custom properties a stylesheet defines", () => {
    const sheets = [join(UI, "tokens.css"), join(APP, "app.css")].map((path) => readFileSync(path, "utf8")).join("\n");
    const defined = new Set([...sheets.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const missing: string[] = [];
    for (const path of sources) {
      for (const token of candidates(readFileSync(path, "utf8"))) {
        for (const m of token.matchAll(/var\((--[\w-]+)/g)) {
          if (!defined.has(m[1]!)) missing.push(`${path.slice(APP.length - 3)}: ${token}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

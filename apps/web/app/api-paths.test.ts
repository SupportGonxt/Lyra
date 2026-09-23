import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `apiFetch` resolves its path with `new URL(path, env.API_ORIGIN)`. A literal
// written "v1/signal/outreach/run" (signal-cockpit.tsx, until this guard) is a
// *relative* reference: it happens to land on /v1/… while API_ORIGIN is a bare
// origin, and silently lands somewhere else the day the origin carries a path
// — and it is spelled unlike the 370-odd calls beside it, so no grep for
// "/v1/signal/outreach" finds its caller. Every literal path handed to the API
// helpers is therefore held to "/v1/…", or to a named non-v1 route.
//
// The guard selects its own subjects by scanning source, so it partitions all
// of them (CLAUDE.md, "a guard that selects its own subjects must assert that
// it selected all of them"): every call it finds is either a literal it checks,
// or excluded for a named reason — and the leftover bucket must be empty.

const APP = fileURLToPath(new URL(".", import.meta.url));

/** The helpers in api.server.ts that take an API path as their first argument. */
const HELPERS = ["api", "apiFetch", "proxyFile"] as const;

/** Paths the API serves outside /v1, each with where it is declared. */
const NON_V1: Record<string, string> = {
  "/openapi.json": "apps/api/src/index.ts serves the spec at the root"
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

interface Call {
  helper: string;
  where: string;
  /** The first argument's source text, up to its first 80 characters. */
  arg: string;
}

/** Every `helper(` / `helper<…>(` call site — a word boundary, not a member access. */
function calls(file: string, source: string): Call[] {
  const out: Call[] = [];
  const pattern = new RegExp(`(?<![\\w.$])(${HELPERS.join("|")})\\s*(?=[<(])`, "g");
  for (const match of source.matchAll(pattern)) {
    let i = (match.index ?? 0) + match[0].length;
    if (source[i] === "<") {
      // Balance the generic argument; `=>` inside a function type is not a close.
      let depth = 0;
      for (; i < source.length; i++) {
        if (source[i] === "<") depth++;
        else if (source[i] === ">" && source[i - 1] !== "=" && --depth === 0) break;
      }
      i++;
    }
    while (/\s/.test(source[i] ?? "")) i++;
    if (source[i] !== "(") continue; // a type or a declaration, not a call
    i++;
    while (/\s/.test(source[i] ?? "")) i++;
    const line = source.slice(0, i).split("\n").length;
    out.push({ helper: match[1] ?? "", where: `${file.slice(APP.length).replace(/^\//, "")}:${line}`, arg: source.slice(i, i + 80) });
  }
  return out;
}

type Verdict = "checked" | "dynamic-head" | "expression" | "declaration";

function classify(arg: string): Verdict | "leftover" {
  const quote = arg[0];
  if (quote === '"' || quote === "'" || quote === "`") {
    const body = arg.slice(1);
    // `${tab.api}/…`: the head is a spec value the module specs already hold
    // to "/v1/…" (modules/spec.routes.test.ts); nothing to read here.
    if (quote === "`" && body.startsWith("${")) return "dynamic-head";
    if (body.startsWith("/v1/")) return "checked";
    const path = body.split(/[?`"']/)[0] ?? "";
    if (NON_V1[path]) return "checked";
    return "leftover";
  }
  // The helpers' own signatures (`api<T>(path: string, …)`) and re-exports.
  if (/^path\s*:/.test(arg)) return "declaration";
  // A variable or expression: its value is built elsewhere and is not a literal.
  return "expression";
}

describe("API path literals", () => {
  const found = sources(APP).flatMap((file) => calls(file, readFileSync(file, "utf8")));

  it("finds the call sites it is meant to guard", () => {
    // Not a floor: one known site per helper, so a scanner that stops matching
    // a helper fails here instead of passing everything by seeing nothing.
    for (const helper of HELPERS) expect(found.some((c) => c.helper === helper), helper).toBe(true);
    expect(found.some((c) => c.where.startsWith("routes/signal-cockpit.tsx"))).toBe(true);
  });

  it("every literal path starts with /v1/ or is a named non-v1 route, and nothing is unclassified", () => {
    const leftover = found.filter((c) => classify(c.arg) === "leftover").map((c) => `${c.where}  ${c.arg}`);
    expect(leftover).toEqual([]);
  });
});

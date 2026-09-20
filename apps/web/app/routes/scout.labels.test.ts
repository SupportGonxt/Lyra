import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LABELS } from "./scout.shared";
import { WS_LABELS } from "../components/whitespace-commentary";

// The guard `labelsIn` cannot be: it takes a `string`, and its miss path
// returns the key itself (scout.shared.ts), so a key in no catalogue renders as
// its own name on a live screen and TypeScript never says a word. That is
// sighting 10's shape (`common.choose` in staff.tsx) in a second catalogue —
// and this file exists because `/scout/admin` was printing `source.search`
// through it, six rows of raw key, while `adm.source.search` sat in the
// catalogue one segment away.
//
// Population: every non-test file under app/ that imports `labelsIn` from
// `scout.shared`, plus `scout.shared.ts` itself (its helpers return keys that
// nothing else spells). That is derived from the import graph rather than
// hand-listed, and the overlay check below fails if a second local catalogue
// appears — so the selection asserts that it selected all of its subjects
// rather than asserting a floor (CLAUDE.md).

const ROOT = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) ? [full] : [];
  });
}

const rel = (file: string): string => file.slice(ROOT.length + 1);

const sources = walk(ROOT).filter((file) => !/\.test\.tsx?$/.test(file));
const readers = sources.filter((file) => {
  if (file.endsWith(join("routes", "scout.shared.ts"))) return true;
  const src = readFileSync(file, "utf8");
  return /import\s*{[^}]*\blabelsIn\b[^}]*}\s*from\s*"[^"]*scout\.shared/.test(src);
});

/** The keys a SCOUT screen can resolve: the shared catalogue plus the one
 *  overlay that layers over it (`whitespace-commentary.tsx` merges its own
 *  table in front of `labelsIn`). A second overlay would be a second universe
 *  this guard does not know about — the overlay test below is what refuses one. */
const en = { ...LABELS.en!, ...WS_LABELS.en! };
const keys = Object.keys(en);
const namespaces = new Set(keys.map((key) => key.split(".")[0]!));

/** `l("key")` / `l('key')` — checkable in full. */
const STATIC = /\bl\(\s*["']([^"'`]+)["']/g;
/** `l(`prefix${…}`)` — only the literal head is knowable, and it is enough: a
 *  prefix no key starts with can never resolve, whatever the variable holds. */
const TEMPLATE = /\bl\(\s*`([^`$]*)\$\{/g;
/** Anything shaped like one of this catalogue's keys, wherever it is written —
 *  which is how a key handed to `l(verdict.key)` gets checked at the place it
 *  was spelled rather than the place it was rendered. */
const KEYISH = /["']([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)["']/g;

describe("the SCOUT label catalogue", () => {
  it("is read by the screens that render it", () => {
    expect(readers.map(rel)).toContain(join("routes", "scout-admin.tsx"));
    expect(readers.map(rel)).toContain(join("routes", "scout.shared.ts"));
  });

  it("has exactly one local overlay, and this guard folds it in", () => {
    const overlays = readers.filter((file) => /\bconst\s+\w*LABELS\b/.test(readFileSync(file, "utf8"))).map(rel);
    expect(overlays.sort()).toEqual([join("components", "whitespace-commentary.tsx"), join("routes", "scout.shared.ts")]);
  });

  it("holds every key its readers ask for by name", () => {
    const missing: string[] = [];
    for (const file of readers) {
      for (const match of readFileSync(file, "utf8").matchAll(STATIC)) {
        const key = match[1]!;
        if (!(key in en)) missing.push(`${rel(file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("holds keys under every prefix its readers build a key from", () => {
    const unreachable: string[] = [];
    for (const file of readers) {
      for (const [, prefix] of readFileSync(file, "utf8").matchAll(TEMPLATE)) {
        if (!prefix) continue;
        if (!keys.some((key) => key.startsWith(prefix))) unreachable.push(`${rel(file)}: ${prefix}…`);
      }
    }
    expect(unreachable).toEqual([]);
  });

  it("holds every key-shaped literal its readers write in a namespace it owns", () => {
    const missing: string[] = [];
    for (const file of readers) {
      for (const match of readFileSync(file, "utf8").matchAll(KEYISH)) {
        const key = match[1]!;
        if (!namespaces.has(key.split(".")[0]!)) continue; // not this catalogue's
        if (!(key in en)) missing.push(`${rel(file)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("says the same things in both languages", () => {
    expect(Object.keys(LABELS.ar!).sort()).toEqual(Object.keys(LABELS.en!).sort());
    expect(Object.keys(WS_LABELS.ar!).sort()).toEqual(Object.keys(WS_LABELS.en!).sort());
  });
});

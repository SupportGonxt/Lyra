import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The inbox renders a notification's `titleKey` through `notice.${titleKey}`
// (home.tsx), so a writer that emits a key with no label prints the raw key at
// the reader. That is the `nav.ai` sighting's exact shape — an i18n key that no
// guard could see, because the reference is a template literal rather than a
// literal argument to `t()`.
//
// This is the inverse guard: the API's writers are the source of truth for
// which keys exist, and every one of them must be labelled here.

// This file sits in apps/web/app/routes.
const API_SRC = join(import.meta.dirname, "..", "..", "..", "api", "src");
const HOME = join(import.meta.dirname, "home.tsx");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      tsFiles(path, out);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Every key the API can put in the **inbox**.
 *
 * Scoped to files that write `core_notifications`: `titleKey` is also used by
 * `axis_tasks`, whose screen renders it through `humanise()` rather than through
 * the catalogue, so an unscoped scan reports a task's key as a missing label —
 * a false positive that would train a reader to ignore this guard.
 */
export function notificationKeys(): string[] {
  const found = new Set<string>();
  for (const file of tsFiles(API_SRC)) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("schema.notifications")) continue;
    // A writer passing a literal...
    for (const match of source.matchAll(/titleKey:\s*"([^"]+)"/g)) found.add(match[1]!);
    // ...or naming a constant, whose value is the key.
    for (const match of source.matchAll(/const\s+\w*TITLE_KEY\w*\s*=\s*"([^"]+)"/g)) found.add(match[1]!);
  }
  return [...found].sort();
}

describe("the inbox's notice labels", () => {
  const home = readFileSync(HOME, "utf8");
  const keys = notificationKeys();

  it("finds the keys the API writes", () => {
    // If this ever empties, the scan broke and the rest of the file proves
    // nothing — a guard that selects its own subjects must say it selected them.
    expect(keys.length).toBeGreaterThan(3);
    expect(keys).toContain("north.alert.triggered");
  });

  it("labels every one of them, in both languages", () => {
    const missing = keys.filter((key) => !home.includes(`"notice.${key}":`));
    expect(missing).toEqual([]);
  });

  it("labels to a real phrase rather than to the key again", () => {
    for (const key of keys) {
      const en = new RegExp(`"notice\\.${key.replace(/\./g, "\\.")}":\\s*"([^"]+)"`);
      const match = home.match(en);
      expect(match?.[1], key).toBeTruthy();
      expect(match![1], key).not.toBe(key);
      expect(match![1]!.length, key).toBeGreaterThan(8);
    }
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_CURRENCY } from "./calendar";

// The ZAR drift, as a guard. ADR-0121 pinned the launch market to the UAE in AED
// and `calendar.ts` has carried `FALLBACK_CURRENCY = "AED"` ever since — but
// twenty sites across the web *bypassed* it with a hard-coded `"ZAR"`, so any
// screen where the currency was not yet known (no spend rows, no campaigns)
// rendered Rand on an AED deployment. The screen that sold the platform showed
// another market's money.
//
// The rule is the **shape**, not the code: a currency literal used as a
// *fallback* (`?? "ZAR"`, `|| "ZAR"`, `fallback = "ZAR"`) is the drift, because
// the platform's default belongs in one place. A currency code in a label or a
// specific integration is content and stays: the AI cost screens meter the
// platform's own provider spend and legitimately name USD.

const SRC = import.meta.dirname;

function files(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      files(path, out);
    } else if (/\.tsx?$/.test(entry) && !entry.includes(".test.")) {
      out.push(path);
    }
  }
  return out;
}

const CURRENCY = /^[A-Z]{3}$/;

/** The one file allowed to name the platform's default currency. */
const HOME = join(SRC, "calendar.ts");

/** Every site where a currency literal is used as a fallback rather than as content. */
export function fallbackLiterals(): { file: string; line: number; text: string }[] {
  const found: { file: string; line: number; text: string }[] = [];
  const patterns = [/\?\?\s*"([A-Z]{3})"/, /\|\|\s*"([A-Z]{3})"/, /fallback\s*=\s*"([A-Z]{3})"/, /currency\s*\?\?\s*"([A-Z]{3})"/];
  for (const file of files(SRC)) {
    if (file === HOME) continue;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match && CURRENCY.test(match[1]!)) found.push({ file: file.slice(SRC.length + 1), line: index + 1, text: line.trim() });
      }
    });
  }
  return found;
}

describe("the platform's default currency has one home", () => {
  it("is the launch market's currency", () => {
    // ADR-0121: the UAE, in dirhams. A different value here is a decision, and
    // this assertion is where it gets made deliberately.
    expect(FALLBACK_CURRENCY).toBe("AED");
  });

  it("is never bypassed by a fallback literal", () => {
    expect(fallbackLiterals()).toEqual([]);
  });

  it("is actually reached — the scan finds the files", () => {
    // A guard that selects its own subjects must say it selected them: an empty
    // scan would make the assertion above pass for the wrong reason.
    expect(files(SRC).length).toBeGreaterThan(100);
    expect(readFileSync(HOME, "utf8")).toContain("FALLBACK_CURRENCY");
  });
});

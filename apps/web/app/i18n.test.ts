import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  baseLocale,
  chosenLocale,
  formatLocaleFrom,
  langFor,
  localeFrom,
  moduleName,
  pseudoText,
  translator
} from "./i18n";
import { en } from "./i18n/en";
import { labelsIn } from "./routes/search-results";

const request = (headers: Record<string, string>) => new Request("https://lyra.test/", { headers });

describe("chosenLocale", () => {
  // The document's lang/dir (root.tsx) and the shell's strings (routes/workspace)
  // have to read the same locale, or a language switch renders an Arabic
  // document full of English. This helper is that shared source: what the user
  // explicitly picked, or nothing.
  it("is the cookie when it names a catalogue", () => {
    expect(chosenLocale(request({ cookie: "lyra_locale=ar" }))).toBe("ar");
  });

  it("is the pseudo locale, which has no catalogue of its own", () => {
    expect(chosenLocale(request({ cookie: "lyra_locale=pseudo" }))).toBe("pseudo");
  });

  it("is nothing when the cookie is absent or names a language we do not have", () => {
    expect(chosenLocale(request({}))).toBeUndefined();
    expect(chosenLocale(request({ cookie: "lyra_locale=tlh" }))).toBeUndefined();
  });
});

describe("localeFrom", () => {
  it("prefers the explicit choice over the browser's list", () => {
    expect(localeFrom(request({ cookie: "lyra_locale=ar", "accept-language": "en-GB,en" }))).toBe("ar");
  });

  it("falls back to Accept-Language, then English", () => {
    expect(localeFrom(request({ "accept-language": "ar-SA,ar;q=0.9" }))).toBe("ar");
    expect(localeFrom(request({ "accept-language": "fr-FR" }))).toBe("en");
  });

  // It stays region-free, and that is a contract rather than an oversight:
  // ~40 route-local label tables index on what this returns, so `ar-SA` here
  // would not render Saudi Arabic copy, it would miss `LABELS` and render
  // English. The region lives on `formatLocaleFrom`.
  it("names a language and never a region", () => {
    expect(localeFrom(request({ cookie: "lyra_locale=ar-SA" }))).toBe("ar");
  });
});

// docs/27 F42. Resolution stripped to the base subtag at the first step and
// never recovered it, so `ar-SA` — the tag a Riyadh browser actually sends —
// could not reach an `Intl` formatter, and Eastern Arabic-Indic digits were
// unreachable by construction. The digits themselves are pinned in
// packages/ui/src/ui.test.ts; this is the resolution half.
describe("formatLocaleFrom", () => {
  it("keeps the region the browser asked for", () => {
    expect(formatLocaleFrom(request({ "accept-language": "ar-SA,ar;q=0.9" }))).toBe("ar-SA");
    expect(formatLocaleFrom(request({ "accept-language": "en-GB,en;q=0.9" }))).toBe("en-GB");
  });

  it("keeps the region an explicit choice carries, ahead of the browser's", () => {
    expect(
      formatLocaleFrom(request({ cookie: "lyra_locale=ar-SA", "accept-language": "en-GB" }))
    ).toBe("ar-SA");
  });

  // The cookie only names a language. A reader whose browser is Saudi and whose
  // choice is Arabic gets Saudi Arabic, which is the common case and the one
  // the finding is about.
  it("takes the region from the browser when the choice agrees on the language", () => {
    expect(formatLocaleFrom(request({ cookie: "lyra_locale=ar", "accept-language": "ar-SA" }))).toBe(
      "ar-SA"
    );
  });

  // Direction is the script's property, the catalogue is the language's, and
  // only the numbers are the region's. All three have to keep agreeing.
  it("does not let a region drag the catalogue somewhere else", () => {
    expect(localeFrom(request({ "accept-language": "ar-SA" }))).toBe("ar");
    expect(translator("ar-SA")("common.save")).toBe(translator("ar")("common.save"));
    expect(translator("ar-SA")("common.save")).not.toBe(translator("en")("common.save"));
  });

  it("ignores a region the browser asked for in a language we do not have", () => {
    expect(formatLocaleFrom(request({ "accept-language": "fr-CA" }))).toBe("en");
  });

  // An unknown or malformed subtag reaches `Intl` on every render; a RangeError
  // there takes the whole route to the error boundary.
  it.each(["ar-ZZZZ", "ar-u-nu-latn", "ar-", "ar-1"])("degrades %s to the bare language", (tag) => {
    expect(formatLocaleFrom(request({ cookie: `lyra_locale=${tag}` }))).toBe("ar");
  });

  it("leaves the pseudo locale alone, since it has no region to have", () => {
    expect(formatLocaleFrom(request({ cookie: "lyra_locale=pseudo" }))).toBe("pseudo");
    expect(langFor(formatLocaleFrom(request({ cookie: "lyra_locale=pseudo" })))).toBe("en-x-pseudo");
  });
});

describe("baseLocale", () => {
  it.each([
    ["ar-SA", "ar"],
    ["AR-sa", "ar"],
    ["ar", "ar"],
    ["pseudo", "pseudo"],
    ["", ""]
  ])("reduces %s to %s", (tag, expected) => {
    expect(baseLocale(tag)).toBe(expected);
  });
});

describe("pseudo locale", () => {
  it("wraps every string so an untranslated one is visible on sight", () => {
    expect(translator("pseudo")("app.skipToContent")).toMatch(/^⟦.*⟧$/);
    expect(langFor("pseudo")).toBe("en-x-pseudo");
  });

  it("leaves real locales alone", () => {
    expect(pseudoText("en", "Search results")).toBe("Search results");
    expect(pseudoText("ar", "نتائج البحث")).toBe("نتائج البحث");
  });

  it("wraps route-local copy, which no catalogue and so no translator sees", () => {
    expect(pseudoText("pseudo", "Search results")).toMatch(/^⟦.*⟧$/);
  });

  it("reaches a route's own label table, or the detector is blind to it", () => {
    // A route table that fell through to English would be indistinguishable
    // from a hardcoded JSX literal — which is the one thing this locale exists
    // to catch. Placeholders stay intact so the label still interpolates.
    const l = labelsIn("pseudo");
    expect(l("title")).toMatch(/^⟦.*⟧$/);
    expect(l("count", { count: "3", areas: "2" })).toContain("3");
  });
});

// Cost explorer headed a column MODULE and listed the rollup's storage keys
// under it: "dist", "orbit", "core".
describe("moduleName", () => {
  it("gives the name the nav puts on the rail", () => {
    expect(moduleName(translator("en"), "orbit")).toBe("Conversations");
    expect(moduleName(translator("ar"), "orbit")).toBe("المحادثات");
  });

  it("maps the keys the nav spells differently, or has no rail entry for", () => {
    expect(moduleName(translator("en"), "dist")).toBe("Distribution");
    expect(moduleName(translator("en"), "core")).toBe("Shared services");
  });

  it("title-cases a module nobody has named yet rather than printing nav.x", () => {
    expect(moduleName(translator("en"), "atlas")).toBe("Atlas");
  });
});

// staff.tsx called t("common.default") and t("common.choose") against the shell
// translator; neither key was in any catalogue, so the invite form's two select
// placeholders rendered the literal key. Same shape as admin.status.active
// before it: TypeScript cannot see it because `t` takes a string.
//
// The ar catalogue is already held to en's key set by the `Messages` type, so
// this only has to check en. It scans source rather than exporting a registry:
// the bug is a lookup that never routes anywhere, and only the source shows it.
describe("shell catalogue covers every lookup", () => {
  const appDir = new URL("./", import.meta.url).pathname;
  const files = execFileSync("grep", ["-rl", "translator(", appDir], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".tsx") || (f.endsWith(".ts") && !f.endsWith(".test.ts")));

  it("scans the files that bind the shell translator", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has a key for every t(\"…\") in them", () => {
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      // Only the name this file binds `translator(...)` to — a route that binds
      // its own labelsFrom(LABELS) table to `t` resolves against that table, not
      // this catalogue, and is not this test's business.
      for (const [, name] of src.matchAll(/const (\w+) = translator\(/g)) {
        for (const [, key] of src.matchAll(new RegExp(`\\b${name}\\("([\\w.]+)"`, "g"))) {
          if (!(key! in en)) missing.push(`${file.replace(appDir, "")}: ${key}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

// Digits are the reader's region's (formatLocaleFrom): `ar` reads Latin, `ar-SA`
// Eastern Arabic. A catalogue string that hard-codes "١٥" beside an
// Intl-formatted "2,180" shows both systems in one sentence.
describe("catalogue digits", () => {
  it("never hard-codes Eastern Arabic numerals in a string", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = new URL(".", import.meta.url).pathname;
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !name.includes(".test.") ? [path] : [];
      });
    const offenders = walk(root).filter((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /[٠-٩]/.test(line))
    );
    expect(offenders).toEqual([]);
  });
});

describe("plural", () => {
  // "The autopilot moved budget 5 time(s)" headlined the cockpit, and its
  // Arabic copy printed both forms, "مرة (مرات)". 35 catalogue strings did.
  it("says an English count once, in the right number", async () => {
    const { plural } = await import("./i18n");
    expect(plural("moved {n} time(s)", { n: "1" }, "en")).toBe("moved {n} time");
    expect(plural("moved {n} time(s)", { n: "5" }, "en")).toBe("moved {n} times");
    expect(plural("{count} currency breach(es)", { count: "2" }, "en")).toBe("{count} currency breaches");
    expect(plural("{keys} live key(s) and {hooks} webhook(s)", { keys: "1", hooks: "3" }, "en")).toBe(
      "{keys} live key and {hooks} webhooks"
    );
  });

  it("picks one Arabic form instead of printing both", async () => {
    const { plural } = await import("./i18n");
    expect(plural("{n} مرة (مرات)", { n: "1" }, "ar")).toBe("{n} مرة");
    expect(plural("{n} مرة (مرات)", { n: "5" }, "ar")).toBe("{n} مرات");
    expect(plural("{n} مرة (مرات)", { n: "20" }, "ar")).toBe("{n} مرة");
  });

  it("leaves a template with no count alone", async () => {
    const { plural } = await import("./i18n");
    expect(plural("agent(s) are active.", {}, "en")).toBe("agent(s) are active.");
  });
});

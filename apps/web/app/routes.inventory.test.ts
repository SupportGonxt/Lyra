import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACES } from "./modules";

/**
 * `ui.md` §6 is "the full UI inventory — read it before changing a screen"
 * (CLAUDE.md § Reference), and its own heading promises "All N declared routes,
 * in manifest order". Nothing held it to that. It had drifted eight routes
 * behind routes.ts while still asserting a total — and the eight were not
 * obscure: `/center` is the command center, `/north/alerts` a rail destination,
 * and all four `/journey/*` screens, the exact screens of sighting 6, were
 * absent from the inventory that a reader is told to consult first.
 *
 * This is the same shape as `modules/spec.routes.test.ts` (a link with no
 * screen) and `routing.reachable.test.ts` (a screen with no link), one level
 * up: **a screen with no entry in the document that claims to list every
 * screen**. A doc asserting a count that nothing recomputes is a dead seam
 * whose reader is a person, and the cost lands on whoever trusts it.
 *
 * The check is deliberately mechanical — URL and route module, not prose. What
 * each screen *does* is still written by hand; what exists is not.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const ROUTES = readFileSync(join(import.meta.dirname, "routes.ts"), "utf8");
const UI_MD = readFileSync(join(ROOT, "ui.md"), "utf8");

/** Every route the manifest declares, as `url -> route module`. */
function declared(): Map<string, string> {
  const found = new Map<string, string>();
  for (const m of ROUTES.matchAll(
    /(?:route\("([^"]+)", "(routes\/[^"]+)"|index\("(routes\/[^"]+)")/g
  )) {
    if (m[3]) found.set("/", m[3]);
    else found.set(`/${m[1]}`, m[2]!);
  }
  return found;
}

/** Every row of the §6 table, same shape. */
function inventoried(): Map<string, string> {
  const section = UI_MD.slice(UI_MD.indexOf("## 6. Route index"), UI_MD.indexOf("## 7."));
  return new Map(
    [...section.matchAll(/^\| `([^`]+)` \| \[([^\]]+)\]/gm)].map((m) => [m[1]!, `routes/${m[2]}`])
  );
}

describe("ui.md §6 lists exactly the routes the manifest declares", () => {
  const real = declared();
  const doc = inventoried();

  it("parsed both sides", () => {
    // A regex that stopped matching would empty one side and pass everything
    // below by vacuity, which is the failure mode of a guard that reads source.
    expect(real.size).toBeGreaterThan(100);
    expect(doc.size).toBeGreaterThan(100);
  });

  it("has no screen missing from the inventory", () => {
    const missing = [...real].filter(([url]) => !doc.has(url)).map(([url, file]) => `${url} (${file})`);
    expect(missing, "routes.ts declares these and ui.md §6 does not list them").toEqual([]);
  });

  it("invents no screen the manifest does not declare", () => {
    const extra = [...doc].filter(([url]) => !real.has(url)).map(([url]) => url);
    expect(extra, "ui.md §6 lists these and routes.ts does not declare them").toEqual([]);
  });

  it("points every row at the route module that actually serves it", () => {
    const wrong = [...real]
      .filter(([url, file]) => doc.has(url) && doc.get(url) !== file)
      .map(([url, file]) => `${url}: routes.ts says ${file}, ui.md says ${doc.get(url)}`);
    expect(wrong).toEqual([]);
  });

  it("states the count it actually lists", () => {
    // The heading is the part a reader believes without checking, so it is the
    // part most worth pinning: it read "All 109 declared routes" over a table of
    // 109 rows while the manifest held 117.
    const claimed = UI_MD.slice(UI_MD.indexOf("## 6. Route index"), UI_MD.indexOf("## 7.")).match(
      /All (\d+) declared routes/
    );
    expect(claimed, "ui.md §6 no longer states a route count").not.toBeNull();
    expect(Number(claimed![1])).toBe(real.size);
  });
});

/**
 * §7 is the other half of the inventory: the 130 tabs `module.tsx` and
 * `record.tsx` render from the workspace specs, which §6 can only show as the
 * three generic `/:module/...` rows. Its per-workspace counts were right when
 * checked, and the point of pinning them is that nothing would have said so — a
 * tab added to a spec moves a number in two headings and adds a row to a table,
 * and neither the compiler nor any other test reads any of the three.
 */
describe("ui.md §7.1 counts the resource tabs the specs declare", () => {
  const section = UI_MD.slice(UI_MD.indexOf("### 7.1"));
  const perWorkspace = new Map(
    [...section.matchAll(/^#### `(\/[a-z]+)` — (\d+) tabs/gm)].map((m) => [m[1]!, Number(m[2])])
  );

  it("parsed the headings", () => {
    expect(perWorkspace.size).toBe(WORKSPACES.length);
  });

  it.each(WORKSPACES.map((w) => ({ path: w.path, tabs: w.tabs.length })))(
    "$path has the tab count ui.md prints",
    ({ path, tabs }) => {
      expect(perWorkspace.get(path), `ui.md §7.1 has no heading for ${path}`).toBe(tabs);
    }
  );

  it("states the total it actually lists", () => {
    // Printed twice — §1's overview line and §7.1's heading — and both are the
    // kind of number a reader takes on trust.
    const total = WORKSPACES.reduce((n, w) => n + w.tabs.length, 0);
    expect(UI_MD).toContain(`### 7.1 The ${total} resource tabs`);
    expect(UI_MD).toContain(`${total} resource tabs\n`);
  });

  it("names every tab the spec declares, in every workspace", () => {
    const missing: string[] = [];
    for (const w of WORKSPACES) {
      const head = section.indexOf(`#### \`${w.path}\` —`);
      const next = section.indexOf("\n#### ", head + 1);
      const table = section.slice(head, next < 0 ? undefined : next);
      const listed = new Set([...table.matchAll(/^\| `([\w-]+)` \|/gm)].map((m) => m[1]!));
      for (const tab of w.tabs) if (!listed.has(tab.key)) missing.push(`${w.path}/${tab.key}`);
    }
    expect(missing, "declared in a workspace spec, absent from its ui.md §7.1 table").toEqual([]);
  });
});

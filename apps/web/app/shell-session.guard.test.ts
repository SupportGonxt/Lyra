import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RouteConfigEntry } from "@react-router/dev/routes";
import routes from "./routes";

// `useShellData()` reads the loader of `routes/workspace` by route id. A screen
// rendered inside a module shell layout (axis-shell.tsx, orbit-shell.tsx, …)
// has no workspace route above it, so the hook answers `undefined` and every
// `?? default` behind it wins silently. The save desk read the tenant's domain
// pack that way and never once applied it — green in tests, which render the
// component without a router. Each shell exports its own session hook.

const APP = import.meta.dirname;

/** Files rendered under each layout, keyed by the layout's own file. */
function underLayouts(entries: readonly RouteConfigEntry[], layout: string | null = null): Array<[string, string]> {
  return entries.flatMap((entry) => {
    if (entry.children) return underLayouts(entry.children, entry.path ? layout : entry.file);
    return layout ? [[layout, entry.file] as [string, string]] : [];
  });
}

const placed = underLayouts(routes);
const moduleShells = placed.filter(([layout]) => layout !== "routes/workspace.tsx");

describe("a screen inside a module shell reads that shell's session", () => {
  it("finds the screens it is guarding", () => {
    // Every module shell layout contributes, so an empty list means the walk
    // above stopped recognising layouts, not that the tree is clean.
    const layouts = new Set(moduleShells.map(([layout]) => layout));
    expect([...layouts].sort()).toEqual(
      ["axis", "north", "orbit", "scout", "signal"].map((m) => `routes/${m}-shell.tsx`)
    );
  });

  it("never reaches for the workspace layout's data", () => {
    const offenders = moduleShells
      .filter(([, file]) => /\buseShellData\(/.test(readFileSync(join(APP, file), "utf8")))
      .map(([layout, file]) => `${file} (under ${layout})`);
    expect(offenders, "use the shell's own hook, e.g. useOrbitSessionData()").toEqual([]);
  });
});

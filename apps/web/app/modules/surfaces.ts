// Screen data behind /surface/:module/:screen (routes/surface.tsx) — the 66
// screens transcribed literally from the Lyra Constellation design pull
// (packages/ui/src/sections/types.ts's own header explains the contract).
//
// This is a standalone map, not `WorkspaceSpec.surfaces` (added to that type
// for API symmetry with the resource-tab shape, and a workspace is free to
// populate it later): four of the thirteen module keys the design file ships
// (`portals`, `mobile`, `system`, `hub`) have no matching entry in `WORKSPACES`
// at all — ORBIT's public portals and the phone gallery are not `/axis`-style
// record workspaces — so keying lookup off `WorkspaceSpec` would silently drop
// them. Keying off `ScreenModule` covers every screen the design file has.

import type { Screen, ScreenModule } from "@lyra/ui";
import raw from "./data/surfaces.json";

// The JSON is a plain literal transcription (docs/superpowers's design pull,
// see packages/ui/src/sections/types.ts) — cast once, at the one place it
// enters the type system, rather than re-declaring every field by hand.
const SURFACES = raw as unknown as Record<ScreenModule, Screen[]>;

export { SURFACES };

/** Every screen for a module, or `[]` for a module the design file never drew. */
export function surfacesFor(moduleId: string): readonly Screen[] {
  return SURFACES[moduleId as ScreenModule] ?? [];
}

/**
 * `surfaceFor("axis", "claims")` → the `axis-claims` screen, or undefined.
 * `slug` is accepted both bare (`"claims"`) and fully qualified
 * (`"axis-claims"`) since a route param and a direct id both show up in
 * practice — a screen simply isn't found rather than the loader crashing.
 */
export function surfaceFor(moduleId: string, slug: string): Screen | undefined {
  const screens = surfacesFor(moduleId);
  const qualified = `${moduleId}-${slug}`;
  return screens.find((screen) => screen.id === slug || screen.id === qualified);
}

/**
 * The design pull as a catalogue, grouped by each screen's own `group` — listed
 * on /design, not in the rail. These are fixture screens (routes/surface.tsx):
 * English literals over sample data, so they sit with the design reference
 * rather than beside the live workspaces every reader navigates.
 */
export function surfaceCatalogue(
  include: (module: string) => boolean
): { group: string; items: { href: string; label: string }[] }[] {
  const byGroup = new Map<string, { href: string; label: string }[]>();
  for (const [mod, screens] of Object.entries(SURFACES)) {
    if (!include(mod)) continue;
    for (const screen of screens) {
      if (!screen.nav) continue;
      const group = screen.group || mod;
      const list = byGroup.get(group) ?? [];
      list.push({ href: `/surface/${mod}/${screen.id}`, label: screen.nav });
      byGroup.set(group, list);
    }
  }
  return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
}

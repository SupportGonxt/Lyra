import type { Translate } from "../i18n";
import { workspaceFor } from "../modules";
import { AXIS_SCREENS, NORTH_SCREENS, ORBIT_SCREENS, SCOUT_SCREENS, SIGNAL_SCREENS, type ModuleScreen } from "../modules/screens";
import { labelsFor, visibleLinks, visibleTabs } from "../modules/spec";
import { labelKeyFor } from "../routing";

/**
 * The workspace menu the rail leads with (ADR-0085): one per workspace, the
 * same whichever way the reader came in. A module used to show its screens only
 * on the bespoke ones (/axis/board) and its record lists only on the generic
 * ones (/axis/cases); Ledger and Admin reached their screens through a row of
 * small links on the page. Now every screen of a workspace carries both: its
 * screens, and its records.
 */
export interface MenuEntry {
  href: string;
  label: string;
}

export interface WorkspaceMenu {
  label: string;
  /** The workspace's `--module-*` hue, or the tenant accent for a shared one. */
  accent: string;
  screens: MenuEntry[];
  records: MenuEntry[];
}

const MODULE_SCREENS: Record<string, readonly ModuleScreen[]> = {
  axis: AXIS_SCREENS,
  orbit: ORBIT_SCREENS,
  signal: SIGNAL_SCREENS,
  scout: SCOUT_SCREENS,
  north: NORTH_SCREENS
};

export function menuFor(
  pathname: string,
  permissions: readonly string[],
  t: Translate,
  locale: string,
  pack?: string
): WorkspaceMenu | null {
  const root = pathname.split("/")[1] ?? "";
  if (!root) return null;
  const spec = workspaceFor(`/${root}`);
  const module = MODULE_SCREENS[root];
  if (!spec && !module) return null;

  const held = new Set(permissions);
  const label = spec ? labelsFor(spec, locale, pack) : null;
  // A module's screens come from the table checked against each loader; a
  // shared workspace's from its spec's declared links (reports, tools).
  const screens: MenuEntry[] = module
    ? module
        .filter((screen) => !screen.permission || held.has(screen.permission))
        .map((screen) => ({ href: screen.href, label: t(labelKeyFor(screen.href)) }))
    : spec && label
      ? visibleLinks(spec, permissions).map((link) => ({ href: link.href, label: label(link.labelKey) }))
      : [];
  // A bespoke screen can sit at a list's own address (/north/anomalies); it is
  // listed once, as the screen.
  const taken = new Set(screens.map((screen) => screen.href));
  const records: MenuEntry[] =
    spec && label
      ? visibleTabs(spec, permissions)
          .map((tab) => ({ href: `${spec.path}/${tab.key}`, label: label(tab.key) }))
          .filter((entry) => !taken.has(entry.href))
      : [];
  if (!screens.length && !records.length) return null;

  return {
    label: t(labelKeyFor(`/${root}`)),
    accent: module ? `var(--module-${root})` : "var(--accent)",
    screens,
    records
  };
}

export interface SwitcherEntry extends MenuEntry {
  section: string | null;
  hue: string;
  current: boolean;
}

/**
 * The module switcher in the top bar: which workspace the reader is in, and
 * every one they may move to, under the rail's own headings. A module wears its
 * `--module-*` hue; a shared workspace (Ledger, Admin) the tenant accent.
 */
export function switcherFor(
  pathname: string,
  groups: readonly { heading: string | null; items: readonly MenuEntry[] }[]
): { current: { href: string; label: string; hue: string } | null; entries: SwitcherEntry[] } {
  const root = `/${pathname.split("/")[1] ?? ""}`;
  const hueOf = (href: string) => (MODULE_SCREENS[href.slice(1)] ? `var(--module-${href.slice(1)})` : "var(--accent)");
  const entries = groups.flatMap((group) =>
    group.items.map((item) => ({ ...item, section: group.heading, hue: hueOf(item.href), current: item.href === root }))
  );
  const here = entries.find((entry) => entry.current);
  return { current: here ? { href: here.href, label: here.label, hue: here.hue } : null, entries };
}

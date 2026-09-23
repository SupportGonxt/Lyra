import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useNavigation, useSearchParams, useSubmit } from "react-router";
import {
  Breadcrumbs,
  Menu,
  Skeleton,
  ToastProvider,
  isOpaqueRef,
  shortRef,
  type Crumb,
  type MenuItem
} from "@lyra/ui";
import type { Brand, NavItem } from "../api.server";
import type { Translate } from "../i18n";
import { workspaceFor } from "../modules";
import { humanise, labelsFor, visibleTabs } from "../modules/spec";
import { isRouted, labelKeyFor, landingFor } from "../routing";
import { ColdOpen } from "./cold-open";
import { Companion } from "./companion";
import { ConstellationMark } from "./mark";
import { Meridian } from "./meridian";
import { SearchPalette } from "./search";
import { PostureChips } from "./posture";
import type { Inbox } from "./shift";
import { ThemeToggle } from "./theme-toggle";

// The frame every workspace renders inside: a 50px top bar carrying the tenant
// lockup, the ask bar and the account controls, a labelled navigation sidebar
// beside the work, and a status strip under it.
//
// Horizon proportions (docs/superpowers/specs/2026-08-06-horizon-frontend-design.md):
// the chrome is thin and hairlined, the ask bar is the widest thing in the bar
// because asking is the first move on every screen, and depth is a line rather
// than a shadow.
//
// The sidebar is text-labelled, always. docs/07 §3 describes a rail that
// collapses to icons; that is overridden here by an explicit product decision —
// an icon-only rail costs every user a hover to read the nav and costs a
// screen-reader user the label outright. `item.icon` is carried through as a
// data attribute so a later icon pass can decorate the label without replacing
// it.
//
// Below the md breakpoint the sidebar becomes a horizontally scrollable strip
// under the header rather than an off-canvas drawer: the labels stay on screen,
// nothing has to be opened to find out where you are, and it needs no state.

/**
 * `Brand` (api.server.ts) carries the name, logo and palette; the typeface half
 * of the contract is `brandJson.font`, written by the settings screen and shaped
 * by BrandJson in packages/db/src/json.ts.
 */
export type TenantBrand = Brand & { font?: string };

/**
 * The typeface half of the tenant override contract (tokens.css §TENANT
 * OVERRIDE CONTRACT). `brand.font` is tenant-controlled text on its way into a
 * custom property, so it is never interpolated: it selects a stack from this
 * table or it selects nothing at all, and anything off the list leaves the
 * default token in place.
 *
 * A Map, not an object, so a key like `__proto__` cannot answer with something
 * inherited. Stacks keep the Arabic fallback tokens.css declares — dropping it
 * regresses RTL rendering to a font with no Arabic coverage.
 */
const FONT_STACKS = new Map<string, string>([
  ["archivo", '"Archivo", "IBM Plex Sans Arabic", system-ui, sans-serif'],
  ["instrument-sans", '"Instrument Sans", "IBM Plex Sans Arabic", system-ui, sans-serif'],
  ["space-grotesk", '"Space Grotesk", "IBM Plex Sans Arabic", system-ui, sans-serif'],
  ["inter", '"Inter", "IBM Plex Sans Arabic", system-ui, sans-serif'],
  ["ibm-plex-sans-arabic", '"IBM Plex Sans Arabic", "Instrument Sans", system-ui, sans-serif']
]);

/**
 * The five custom properties a tenant may re-map, and nothing else (docs/01 §6,
 * packages/ui/src/tokens.css). One typeface covers both roles because the
 * settings screen offers one and says so ("Applies to headings and body text
 * alike"). Exported for shell.brand.test.ts.
 */
export function brandStyle(brand: TenantBrand | null): React.CSSProperties {
  const palette = brand?.palette;
  const font = brand?.font === undefined ? undefined : FONT_STACKS.get(brand.font);
  return {
    ...(palette?.accent ? { "--accent": palette.accent } : {}),
    ...(palette?.accentHover ? { "--accent-hover": palette.accentHover } : {}),
    ...(palette?.accentContrast ? { "--accent-contrast": palette.accentContrast } : {}),
    ...(font ? { "--font-display": font, "--font-ui": font } : {})
  } as React.CSSProperties;
}

/**
 * The two names in the lockup: what the product is called here, and who is
 * being served. A tenant that never renamed the product has one name, not the
 * same word printed twice with a divider between it.
 */
export function lockupNames(
  brand: Pick<TenantBrand, "name"> | null,
  tenantName: string
): { product: string; tenant: string | null } {
  const product = brand?.name ?? tenantName;
  const same = product.trim().toLowerCase() === tenantName.trim().toLowerCase();
  return { product, tenant: same ? null : tenantName };
}

export interface ShellProps {
  t: Translate;
  nav: NavItem[];
  brand: Brand | null;
  /** Falls back to the tenant's own name; the product name is never a literal. */
  tenantName: string;
  actorName: string | null;
  /**
   * What today has asked of this actor, for the day strip and the shift block
   * at the top of the rail. Null when the inbox could not be read — both
   * surfaces then render nothing rather than an invented zero.
   */
  inbox?: Inbox | null;
  /** Every role key this actor holds, for the role pill (docs/07 §3 personas). */
  roles?: readonly string[];
  /** Expanded permission keys, for the chrome that is absent without them. */
  permissions?: readonly string[];
  /** Inside a module: its own screens, which lead the rail (ADR-0085). */
  section?: ShellSection;
  /** The day strip. NORTH's alone (ADR-0061, ADR-0085). */
  meridian?: boolean;
  /** For the words `t` cannot reach: a workspace's own tab names in a crumb. */
  locale?: string;
  children: React.ReactNode;
}

export interface ShellSection {
  label: string;
  /** The module's `--module-*` hue. */
  accent: string;
  items: Pick<NavItem, "href" | "labelKey">[];
}

/** One switchable view in the role pill: the role key, where that role lands,
 *  and whether it is the one being looked at now. */
export interface Profile {
  role: string;
  href: string;
  active: boolean;
}

/**
 * The profiles the pill offers. The design's role pill "switches the view, never
 * the permissions" — so a profile is nothing more than the workspace that role
 * lands on, and `landingFor` already refuses to name one the nav does not offer.
 *
 * A single-role actor gets no choices, and neither does one whose roles all land
 * on the same workspace: a menu with one destination is a menu that lies about
 * having an alternative.
 */
export function profilesFor(
  roles: readonly string[],
  nav: NavItem[],
  pathname: string
): Profile[] {
  const byHref = new Map<string, Profile>();
  for (const role of roles) {
    const href = landingFor([role], nav);
    if (byHref.has(href)) continue;
    byHref.set(href, {
      role,
      href,
      active: pathname === href || pathname.startsWith(`${href}/`)
    });
  }
  const profiles = [...byHref.values()];
  return profiles.length > 1 ? profiles : [];
}

/**
 * Product identity, not brand: the five modules own an accent (docs/07 §6), so
 * the marker beside a nav label tells you which workspace you are in before you
 * have read the word. Everything else uses the tenant accent.
 */
const MODULE_ACCENT: Record<string, string> = {
  "/axis": "var(--module-axis)",
  "/orbit": "var(--module-orbit)",
  "/signal": "var(--module-signal)",
  "/scout": "var(--module-scout)",
  "/north": "var(--module-north)"
};

/** Nav is grouped: a heading item carries no link of its own, only labelled
 *  children. Leaves (all in real, non-routed order) drop unrouted destinations
 *  the same way flat items always did. */
export function routedLeaves(item: NavItem): NavItem[] {
  if (item.heading) return (item.children ?? []).flatMap(routedLeaves);
  return isRouted(item.href) || item.href === "/" ? [item] : [];
}

/**
 * Where you are, when the nav highlight cannot say it. A module's own landing
 * page needs no trail — the rail is already pointing at it (docs/07 §3:
 * breadcrumbs only below module level) — so this answers with nothing until the
 * path goes deeper than a nav destination. Below that, the trail is the nav's
 * own ancestors plus what the path adds: a record id shortened the way every
 * other id on screen is, and a trailing screen name (`compare`, `audit-trail`)
 * said as words.
 */
export function crumbsFor(pathname: string, nav: NavItem[], t: Translate, locale = "en"): Crumb[] {
  const leaves = nav.flatMap(routedLeaves).filter((item) => item.href !== "/");
  const ancestors = leaves
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => a.href.length - b.href.length);
  const deepest = ancestors.at(-1);
  if (!deepest) return [];
  const rest = pathname.slice(deepest.href.length).split("/").filter(Boolean);
  if (!rest.length) return [];
  const spec = workspaceFor(deepest.href);
  // A workspace's list tab says where it is in its own eyebrow and heading
  // (module.tsx); a trail repeating both, one line above them, is noise.
  if (rest.length === 1 && spec?.tabs.some((entry) => entry.key === rest[0])) return [];
  return [
    ...ancestors.map((item) => ({ label: t(item.labelKey), href: item.href })),
    ...rest.map((segment, index) => {
      const href = `${deepest.href}/${rest.slice(0, index + 1).join("/")}`;
      // The rail's own catalogue first (`nav.axis/quote-desk`), then the
      // workspace's tab name — both translated and both the words the rail
      // uses. `humanise` was English in every locale.
      const key = labelKeyFor(href);
      const named = t(key) !== key ? t(key) : null;
      const tab = index === 0 && spec?.tabs.some((entry) => entry.key === segment) ? segment : null;
      if (named) return { label: named, href };
      if (tab && spec) return { label: labelsFor(spec, locale)(tab), href };
      return { label: isOpaqueRef(segment) ? shortRef(segment) : humanise(segment) };
    })
  ];
}

export function Shell({
  t,
  nav,
  brand,
  tenantName,
  actorName,
  inbox = null,
  roles = [],
  permissions = [],
  section,
  meridian = false,
  locale = "en",
  children
}: ShellProps) {
  const { product: productName, tenant: servedName } = lockupNames(brand, tenantName);
  // The API returns every item this actor may open, including modules whose
  // screens have not shipped yet (and headings whose one real destination
  // hasn't). Linking to an unrouted path would hand them a 404, so the shell
  // shows what it can actually open — headings with nothing left are dropped.
  const groups: { heading: NavItem | null; items: NavItem[] }[] = [];
  for (const item of nav) {
    if (item.heading) {
      const items = routedLeaves(item);
      if (items.length) groups.push({ heading: item, items });
    } else if (item.href === "/" || isRouted(item.href)) {
      groups.push({ heading: null, items: [item] });
    }
  }
  const home = groups.find((group) => !group.heading && group.items[0]?.href === "/")?.items[0] ?? null;
  const workspaces = groups.filter((group) => group.items[0]?.href !== "/");
  // The inbox is where a decision waiting on this reader lives (approvals).
  // It is pinned beside Home in every frame, with its count, instead of being
  // reachable only from a panel on the home screen.
  const mayInbox = permissions.includes("core:approvals:read");
  const inboxItem: NavItem | null = mayInbox ? { labelKey: "nav.inbox", href: "/approvals", icon: "inbox" } : null;
  const inboxCount = inbox?.counts?.approvals ?? inbox?.approvals.length ?? 0;
  const pinned = [home, inboxItem].filter((item): item is NavItem => item !== null);
  const sectionItems: NavItem[] = (section?.items ?? []).map((item) => ({ ...item, icon: "" }));
  const items = [...pinned, ...sectionItems, ...workspaces.flatMap((g) => g.items)];
  // Everything ⌘K can go to: the rail, and every tab of every workspace this
  // reader may read — "Trial balance", "Period close" — named "Tab · Workspace"
  // so two tabs called "Settings" are told apart. It knew only the rail's ~11.
  const destinations = [
    ...items.map((item) => ({ href: item.href, label: t(item.labelKey) })),
    ...workspaces
      .flatMap((group) => group.items)
      .flatMap((item) => {
        const spec = workspaceFor(item.href);
        if (!spec) return [];
        const label = labelsFor(spec, locale);
        return visibleTabs(spec, permissions).map((tab) => ({
          href: `${spec.path}/${tab.key}`,
          label: `${label(tab.key)} · ${t(item.labelKey)}`,
          deep: true
        }));
      })
  ];
  const logo = brand?.logo?.dark ?? brand?.logo?.light ?? brand?.logo?.mark;
  // The arrival is keyed on the path: React throws the old main away on every
  // navigation, so the entrance plays again instead of only on first paint.
  const { pathname } = useLocation();
  // What the status strip names. The nav has already decided which destinations
  // exist, so the longest matching href wins: /axis/quotes over /axis.
  const currentItem = items
    .filter((item) => (item.href === "/" ? pathname === "/" : pathname.startsWith(item.href)))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const crumbs = crumbsFor(pathname, nav, t, locale);
  const profiles = profilesFor(roles, nav, pathname);
  const navigate = useNavigate();
  const submit = useSubmit();
  // The rail is absent, not disabled, for an actor who cannot read agent runs —
  // the same rule the posture chips follow. It opens closed: the activity is
  // context, and the work is what the screen is for.
  const [companion, setCompanion] = useState(false);
  // Where the Meridian's playhead is parked. null while it follows now, which
  // is the only state in which the rail shows the live queue.
  // The replay position lives in the URL (?asOf=) so a NORTH screen read "as
  // of 10:09" is a link someone else can open at the same moment.
  const [searchParams, setSearchParams] = useSearchParams();
  const asOfParam = searchParams.get("asOf")?.trim();
  const initialAsOf = asOfParam && Number.isFinite(Number(asOfParam)) ? Number(asOfParam) : null;
  const scrub = (value: number | null) => {
    const next = new URLSearchParams(searchParams);
    if (value === null) next.delete("asOf");
    else next.set("asOf", String(value));
    setSearchParams(next, { replace: true });
  };
  const mayCompanion = permissions.includes("ai:runs:read");
  // docs/07 latency doctrine: a wait under 400ms is answered by holding still —
  // a skeleton that flashes reads as a fault. Past it the screen the actor asked
  // for is drawn as its shape while its data lands, so the wait has somewhere to
  // happen other than the screen they were leaving.
  const navigation = useNavigation();
  const settling =
    navigation.state === "loading" && (navigation.location?.pathname ?? pathname) !== pathname;
  const slow = useSettledFor(settling, 400);

  return (
    // The toast host lives above every workspace so any screen can say what
    // happened after the control that caused it has scrolled away (ADR-0051).
    // In-place `role="status"` notices stay the default: docs/15 asks for quiet
    // feedback beside the work, and AI never toasts for itself.
    <ToastProvider dismissLabel={t("common.dismiss")}>
      <div className="lyra-field flex h-dvh flex-col overflow-hidden bg-bg text-text" style={brandStyle(brand)}>
        {/* Mounted first in the tree but painted over everything (ADR-0055),
            and only ever on the client — the workspace below is complete and
            interactive whether or not this ever renders. */}
        <ColdOpen name={productName} />
        <a
          href="#workspace"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-13"
        >
          {t("app.skipToContent")}
        </a>

        {/* Opaque, not glass: docs/15 §3 bans blur outright — depth here comes
            from the surface being a step lighter than the field behind it, plus
            the hairline. `lyra-vt-chrome` holds the bar still while the workspace
            under it transitions, so navigation moves the content, not the frame. */}
        <header className="lyra-vt-chrome z-30 flex h-[var(--chrome-top)] shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-[var(--gutter)] sm:gap-3">
          <div className="flex shrink-0 items-center gap-2">
            <NavLink
              to="/"
              end
              className="flex shrink-0 items-center gap-[9px] rounded-md px-1 py-1 font-display text-13 text-text hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {logo ? (
                <img src={logo} alt={productName} className="h-6 w-auto" />
              ) : (
                <>
                  {/* A tenant with a logo gets its own; a tenant without one is
                      not left with a bare word. */}
                  <ConstellationMark className="shrink-0" />
                  {/* ponytail: the wide tracking is the display face's Latin
                      setting. Arabic is cursive — spacing it out pulls joined
                      letters apart — so the LTR variant carries it. */}
                  <span className="truncate font-semibold ltr:tracking-[0.15em]">{productName}</span>
                </>
              )}
            </NavLink>
            {/* Whose workspace this is, beside what it is called. Only when the
                two are different words (docs/07 §6: the brand renames the
                product, it does not replace the tenant). */}
            {servedName ? (
              <>
                <span aria-hidden="true" className="h-[15px] w-px shrink-0 bg-border-strong" />
                <span className="hidden max-w-[16ch] truncate font-ui text-12 text-muted sm:inline">
                  {servedName}
                </span>
              </>
            ) : null}
          </div>

          {/* ⌘K answers both halves of the design's two overlays: what is this,
              and where do I go. The destinations are the nav's own, so a place
              the rail cannot open is not offered here either (ADR-0031). */}
          <SearchPalette t={t} destinations={destinations} />

          <div className="ms-auto flex shrink-0 items-center gap-1">
            <PostureChips posture={inbox?.posture} t={t} />
            <ThemeToggle t={t} />
            {mayCompanion ? (
              <button
                type="button"
                aria-expanded={companion}
                aria-label={t(companion ? "companion.close" : "companion.open")}
                title={t(companion ? "companion.close" : "companion.open")}
                onClick={() => setCompanion((open) => !open)}
                className="hidden size-8 shrink-0 place-items-center rounded-md text-13 text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-expanded:text-accent lg:grid"
              >
                {/* The same ✦ every AI artifact carries (docs/15) — the rail is
                    where all of them are listed. */}
                <span aria-hidden="true">&#10022;</span>
              </button>
            ) : null}
            {/* The pill is the menu's trigger: it already says who is acting, so
                the account actions hang off it instead of spending header width
                as two flat controls (docs/ui.md §7.4). */}
            <Menu
              label={t("header.account")}
              items={accountMenuItems(
                t,
                (href) => void navigate(href),
                () => void submit(null, { method: "post", action: "/logout" }),
                profiles
              )}
              trigger={
                <button
                  type="button"
                  className="ms-1 flex items-center gap-2 rounded-orbit border border-border py-0.5 pe-2.5 ps-0.5 transition-colors duration-150 hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  title={actorName ? t("header.signedInAs", { name: actorName }) : t("header.account")}
                >
                  {/* Initials in the tenant accent, the name beside them: the pill
                      says who is acting before the menu is opened. Accent on
                      accent-contrast, not accent on a tint of itself — the tint's
                      ratio depends on the tenant's hue and a blue one landed at
                      4.24:1; --accent-contrast is AA-validated on save. */}
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-orbit bg-accent font-mono text-12 font-medium text-accent-contrast"
                  >
                    {actorName ? initialsOf(actorName) : "\u2022"}
                  </span>
                  {/* The design's pill states the role, not the name: the circle
                      already says who, and which hat they are wearing is the
                      thing that changes what the next screen shows. The name
                      stays on the tooltip and in the menu's own label. */}
                  {/* The person, in words. A role key (`axis.admin`) is a
                      permission bundle's id, not something a reader calls
                      themselves; which view they are in is the rail's job. */}
                  <span className="hidden max-w-40 truncate font-ui text-12 text-muted sm:inline">
                    {actorName ?? t("header.account")}
                  </span>
                  <span aria-hidden="true" className="text-12 text-subtle">
                    &#9662;
                  </span>
                </button>
              }
            />
          </div>
        </header>

        {/* Today, before the work: the strip is the first thing under the bar
            in the comp, and part of the chrome rather than of the canvas
            (horizon-1-shell.md §5.1 stacks it above the body split). Nothing
            here is sticky — the root does not scroll, so the bands hold still
            for free and only the canvas moves. */}
        {meridian ? (
          <Meridian t={t} inbox={inbox} accent={accentFor(pathname)} initialAsOf={initialAsOf} onScrub={scrub} />
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <nav
            aria-label={t("nav.primary")}
            className={[
              // Small screens: one scrollable row under the header, labels intact,
              // group headings dropped — there is no room for them in a strip.
              "flex min-h-[var(--chrome-module)] shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface-1 p-2 md:hidden"
            ].join(" ")}
          >
            {items.map((item) => (
              <NavItemLink
                key={item.href}
                item={item}
                t={t}
                badge={item === inboxItem && inboxCount > 0 ? inboxCount : undefined}
              />
            ))}
          </nav>

          <nav
            aria-label={t("nav.primary")}
            className="lyra-vt-rail hidden md:flex md:w-[var(--rail-width)] md:shrink-0 md:flex-col md:gap-0.5 md:overflow-y-auto md:border-e md:border-border md:p-[var(--gutter-rail)]"
          >
            {/* Pinned: where every reader starts and what is waiting on them. */}
            <ul className="mb-1 flex flex-col gap-0.5">
              {pinned.map((item) => (
                <li key={item.href}>
                  <NavItemLink
                    item={item}
                    t={t}
                    badge={item === inboxItem && inboxCount > 0 ? inboxCount : undefined}
                  />
                </li>
              ))}
            </ul>
            {/* Inside a module, its own screens come first — they are what the
                reader came here for (ADR-0085). */}
            {section && sectionItems.length ? (
              <div className="mb-1">
                <h2 className="eyebrow mb-1 mt-4 px-3">
                  {section.label}
                </h2>
                <ul className="flex flex-col gap-0.5">
                  {sectionItems.map((item) => (
                    <li key={item.href}>
                      <NavItemLink item={item} t={t} nested accent={section.accent} exact />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {workspaces.map((group, i) => (
              // Keyed by position: a heading's own `href` is "" (apps/api/src
              // /routes/me.ts) and `??` does not fall back on "", so every
              // heading group used to share the key "" — React then reused the
              // wrong group's DOM. Groups are derived fresh from `nav` on each
              // render, so index is stable for as long as the list is.
              <div key={i} className="mb-1">
                {group.heading ? (
                  <h2 className="eyebrow mb-1 mt-4 px-3">
                    {t(group.heading.labelKey)}
                  </h2>
                ) : null}
                <ul className="flex flex-col gap-0.5">
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <NavItemLink item={item} t={t} nested={Boolean(group.heading)} />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>

          <main
            key={pathname}
            id="workspace"
            tabIndex={-1}
            className="lyra-vt-workspace lyra-stagger mx-auto flex min-h-0 min-w-0 w-full max-w-[var(--measure-canvas)] flex-1 flex-col gap-[var(--stack-gap)] overflow-y-auto overflow-x-hidden p-[var(--gutter-canvas)]"
          >
            {/* Every screen carries the hue of the workspace it belongs to — the
                same 2px the rail draws beside the current item. Drawn once, here,
                so a screen never has to know which module it is inside. Shared
                surfaces (ledger, admin, settings) fall back to the accent. */}
            <span
              aria-hidden="true"
              className="h-0.5 w-full shrink-0 rounded-full"
              style={{ background: accentFor(pathname) }}
            />
            {/* Only below module level, and only when the path says more than the
                rail can: a record opened from a queue, or a screen hanging off
                one. At module level this renders nothing at all. */}
            {crumbs.length ? (
              <Breadcrumbs
                items={crumbs}
                label={t("nav.breadcrumb")}
                renderLink={({ href, className, children: text }) => (
                  <NavLink to={href} end className={className} viewTransition>
                    {text}
                  </NavLink>
                )}
              />
            ) : null}
            {slow ? <PageSkeleton label={t("common.loading")} /> : children}
          </main>

          {mayCompanion && companion ? <Companion t={t} /> : null}
        </div>

        {/* The status strip: who you are working inside, in the same mono the
            numbers use. The facts on it are decorative — every one is already
            announced by the lockup and the nav's current item — so `aria-hidden`
            sits on those spans rather than the footer, which would otherwise
            take the doctrine link out of the accessibility tree with them. */}
        <footer className="lyra-vt-status z-20 hidden h-[var(--chrome-status)] shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-[var(--gutter)] font-mono text-12 text-subtle sm:flex">
          <span aria-hidden="true" className="truncate">
            {productName}
          </span>
          {/* Off-nav surfaces (search, a record opened by url) have no current
              item. The strip then names the product only — it used to print
              "Primary", the nav landmark's aria-label. */}
          {currentItem ? (
            <span aria-hidden="true" className="flex min-w-0 items-center gap-2">
              <span className="text-border-strong">/</span>
              <span className="truncate">{t(currentItem.labelKey)}</span>
            </span>
          ) : null}
          {/* The one interactive thing down here, parked at the far end: the
              design system explaining itself (routes/design.tsx). */}
          <NavLink
            to="/design"
            className="ms-auto shrink-0 hover:text-text aria-[current=page]:text-text"
          >
            {t("nav.doctrine")}
          </NavLink>
        </footer>
      </div>
    </ToastProvider>
  );
}

/**
 * What the account control offers. A pure list so the menu's contents are
 * readable without a router: the two actions the header used to spend its width
 * on as flat controls (docs/ui.md §7.4).
 */
export function accountMenuItems(
  t: Translate,
  open: (href: string) => void,
  signOut: () => void,
  profiles: readonly Profile[] = []
): MenuItem[] {
  return [
    // The role key is the label, the way login.tsx already names a persona: a
    // profile is identified by the key its permissions are granted under, and
    // inventing a prose name per role would be a second vocabulary to keep true.
    ...profiles.map((profile) => ({
      id: `profile:${profile.role}`,
      // Named by the workspace it opens ("Operations"), which is what
      // switching a view means to the reader.
      label: t(labelKeyFor(profile.href)),
      shortcut: t(profile.active ? "header.viewing" : "header.viewAs"),
      disabled: profile.active,
      onSelect: () => open(profile.href)
    })),
    { id: "settings", label: t("header.settings"), onSelect: () => open("/settings") },
    { id: "signOut", label: t("header.signOut"), tone: "danger", onSelect: signOut }
  ];
}

/**
 * Two letters at most, from the first and last word of the name — the pill is
 * 24px and a third initial turns it into a smudge. Works the same in Arabic:
 * the split is on whitespace, not on script.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const first = [...(words[0] ?? "")][0] ?? "";
  const last = words.length > 1 ? ([...(words.at(-1) ?? "")][0] ?? "") : "";
  return (first + last).toLocaleUpperCase();
}

/** A module's screens carry the module's hue, not just its landing page. */
function accentFor(href: string): string {
  for (const [prefix, hue] of Object.entries(MODULE_ACCENT)) {
    if (href === prefix || href.startsWith(`${prefix}/`)) return hue;
  }
  return "var(--accent)";
}

function NavItemLink({
  item,
  t,
  nested,
  accent: hue,
  exact,
  badge
}: {
  item: NavItem;
  t: Translate;
  nested?: boolean;
  accent?: string;
  exact?: boolean;
  /** A count beside the label — what is waiting there. */
  badge?: number | undefined;
}) {
  const accent = hue ?? accentFor(item.href);
  return (
    <NavLink
      to={item.href}
      end={exact || item.href === "/"}
      // docs/15 §3: navigation runs through a view transition, so the frame
      // holds still and only the workspace changes. Browsers without the API
      // ignore this and navigate normally.
      viewTransition
      data-icon={item.icon}
      // The mobile strip scrolls sideways; the current item is scrolled into
      // it so the reader can see where they are without swiping to look.
      ref={(link) => {
        if (link?.getAttribute("aria-current") === "page") link.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }}
      className={({ isActive }) =>
        [
          "group flex shrink-0 items-center gap-2 rounded-md px-3 text-start font-ui transition-colors duration-150",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          nested ? "py-1.5 text-12" : "py-2 text-13",
          isActive
            ? "bg-surface-2 font-medium text-text"
            : "text-muted hover:bg-surface-2 hover:text-text"
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          {/* Which workspace, before the word is read: Horizon's 2px module
              hue bar. Decoration only — the label is the item, never a bar or
              an icon on its own. */}
          <span
            aria-hidden="true"
            className={[
              "h-4 w-0.5 shrink-0 rounded-orbit transition-opacity duration-150",
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50"
            ].join(" ")}
            style={{ background: accent }}
          />
          <span className="truncate">{t(item.labelKey)}</span>
          {badge ? (
            <span className="ms-auto rounded-orbit bg-accent px-1.5 font-mono text-12 tabular-nums text-accent-contrast">
              {badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

/** True once `active` has held for `ms` — nothing at all below that. */
export function useSettledFor(active: boolean, ms: number): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!active) {
      setLate(false);
      return;
    }
    const timer = setTimeout(() => setLate(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return late;
}

/**
 * The shape of a workspace screen: a title, a line of intent, and a body. It is
 * deliberately generic — the shell cannot know what is arriving, and a skeleton
 * that guesses wrong is a worse promise than one that only says "a screen".
 */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-6" role="status" aria-busy="true" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-3 w-96 max-w-full" />
      </div>
      <div aria-hidden="true" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-4/5" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

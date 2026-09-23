import { useState } from "react";
import {
  NavLink,
  useLocation,
  useNavigate,
  useNavigation,
  useSubmit
} from "react-router";
import {
  Breadcrumbs,
  Menu,
  ModuleSwitcher,
  ToastProvider,
  type LyraModule,
  type ModuleLink
} from "@lyra/ui";
import type { NavItem } from "../api.server";
import { translator, type Translate } from "../i18n";
import { labelKeyFor, moduleOf } from "../routing";
import type { SessionBootstrap } from "../session.server";
import { ColdOpen } from "./cold-open";
import { Companion } from "./companion";
import { ConstellationMark } from "./mark";
import { SearchPalette } from "./search";
import { PostureChips } from "./posture";
import { shiftFrom } from "./shift";
import { ShiftRail } from "./shift-rail";
import { ThemeToggle } from "./theme-toggle";
import {
  accountMenuItems,
  brandStyle,
  crumbsFor,
  initialsOf,
  lockupNames,
  PageSkeleton,
  profilesFor,
  useSettledFor
} from "./shell";

const SCOUT_ACCENT = "var(--module-scout)";

/**
 * SCOUT's own rail, compile-time known — the eight `scout/*` destinations the
 * design spec gives this shell (docs/superpowers/specs
 * /2026-08-16-scout-shell-fork-design.md §"Rail destinations").
 */
// Compile-time, not derived from session.nav: SCOUT's rail is fixed regardless
// of tenant config, same rationale as SIGNAL_NAV_PATHS/ORBIT_NAV_PATHS/AXIS_NAV_PATHS.
const SCOUT_NAV_PATHS = [
  "/scout/radar",
  "/scout/panel",
  "/scout/pricing",
  "/scout/experiments",
  "/scout/analytics",
  "/scout/data-products",
  "/scout/admin",
  "/scout/dev"
] as const;

type RailItem = Pick<NavItem, "href" | "labelKey">;

const SCOUT_NAV_ITEMS: RailItem[] = SCOUT_NAV_PATHS.map((href) => ({
  href,
  labelKey: labelKeyFor(href)
}));

/**
 * SCOUT's own shell: a scoped rail (only /scout/* destinations), the same
 * chrome primitives Shell/NorthShell/OrbitShell use (brandStyle, lockupNames,
 * crumbsFor, accountMenuItems, PageSkeleton — all imported, not
 * reimplemented), and the multi-role switcher when this actor's roles reach
 * more than one shell. No Meridian — ADR-0061 is explicit that Meridian is
 * NORTH-only.
 */
export function ScoutShell({
  session,
  children
}: {
  session: SessionBootstrap;
  children: React.ReactNode;
}) {
  const t = translator(session.locale, session.overrides);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [companion, setCompanion] = useState(false);

  const items = SCOUT_NAV_ITEMS;

  const { product: productName, tenant: servedName } = lockupNames(session.brand, session.tenantName);
  const logo = session.brand?.logo?.dark ?? session.brand?.logo?.light ?? session.brand?.logo?.mark;
  const crumbs = crumbsFor(pathname, session.nav, t);
  const profiles = profilesFor(session.roles, session.nav, pathname);
  const roleKey = profiles.find((profile) => profile.active)?.role ?? session.roles[0] ?? null;
  const mayCompanion = session.permissions.includes("ai:runs:read");
  const navigation = useNavigation();
  const settling =
    navigation.state === "loading" && (navigation.location?.pathname ?? pathname) !== pathname;
  const slow = useSettledFor(settling, 400);

  // A switcher exists to leave, so the shell you are already in is not a
  // destination. `availableShells` is workspace-shaped, not module-shaped — it
  // can hold "admin"/"ledger"/"settings", none of which are LyraModule — so
  // moduleOf() (routing.ts) both narrows the type and drops the non-modules,
  // instead of an unsound cast.
  const moduleLinks: ModuleLink[] = session.availableShells.flatMap((shell) => {
    if (shell === "scout") return [];
    const id: LyraModule | null = moduleOf(`/${shell}`);
    return id ? [{ id, label: t(`nav.${shell}`), href: `/${shell}` }] : [];
  });

  return (
    // The toast host lives above every workspace so any screen can say what
    // happened after the control that caused it has scrolled away (ADR-0051).
    <ToastProvider dismissLabel={t("common.dismiss")}>
      <div className="lyra-field flex h-dvh flex-col overflow-hidden bg-bg text-text" style={brandStyle(session.brand)}>
        <ColdOpen name={productName} />
        <a
          href="#workspace"
          className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:bg-surface-2 focus:px-3 focus:py-2 focus:text-13"
        >
          {t("app.skipToContent")}
        </a>

        <header className="lyra-vt-chrome z-30 flex h-[var(--chrome-top)] shrink-0 items-center gap-2 border-b border-border bg-surface-1 px-[var(--gutter)] sm:gap-3">
          <div className="flex shrink-0 items-center gap-2">
            <NavLink
              to="/scout/radar"
              className="flex shrink-0 items-center gap-[9px] rounded-md px-1 py-1 font-display text-13 text-text hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {logo ? (
                <img src={logo} alt={productName} className="h-6 w-auto" />
              ) : (
                <>
                  <ConstellationMark className="shrink-0" />
                  <span className="truncate font-semibold ltr:tracking-[0.15em]">{productName}</span>
                </>
              )}
            </NavLink>
            {servedName ? (
              <>
                <span aria-hidden="true" className="h-[15px] w-px shrink-0 bg-border-strong" />
                <span className="hidden max-w-[16ch] truncate font-ui text-12 text-muted sm:inline">
                  {servedName}
                </span>
              </>
            ) : null}
          </div>

          <SearchPalette
            t={t}
            destinations={items.map((item) => ({ href: item.href, label: t(item.labelKey) }))}
          />

          <div className="ms-auto flex shrink-0 items-center gap-1">
            <PostureChips posture={session.inbox?.posture} t={t} />
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
                <span aria-hidden="true">&#10022;</span>
              </button>
            ) : null}
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
                  title={
                    session.actorName
                      ? t("header.signedInAs", { name: session.actorName })
                      : t("header.account")
                  }
                >
                  <span
                    aria-hidden="true"
                    className="grid size-6 shrink-0 place-items-center rounded-orbit bg-accent font-mono text-12 font-medium text-accent-contrast"
                  >
                    {session.actorName ? initialsOf(session.actorName) : "•"}
                  </span>
                  <span className="hidden max-w-40 truncate font-mono text-12 text-muted sm:inline">
                    {roleKey ?? session.actorName ?? t("header.account")}
                  </span>
                  <span aria-hidden="true" className="text-12 text-subtle">
                    &#9662;
                  </span>
                </button>
              }
            />
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {/* ModuleSwitcher renders its own <nav aria-label="Modules">, so it is
              a sibling of the rail rather than a child of it — a <nav> inside a
              <nav> reads as two competing landmarks. Rendered twice for the
              same reason the rail is: the mobile copy is the only way a
              multi-shell actor on a small screen can leave this shell. */}
          {moduleLinks.length ? (
            <ModuleSwitcher
              modules={moduleLinks}
              current="scout"
              label={t("nav.group.modules")}
              className="shrink-0 border-b border-border bg-surface-1 p-2 md:hidden"
            />
          ) : null}
          <nav
            aria-label={t("nav.primary")}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface-1 p-2 md:hidden"
          >
            {items.map((item) => (
              <NavItemLink key={item.href} item={item} t={t} />
            ))}
          </nav>

          <div className="lyra-vt-rail hidden md:flex md:w-[var(--rail-width)] md:shrink-0 md:flex-col md:gap-2 md:overflow-y-auto md:border-e md:border-border md:p-[var(--gutter-rail)]">
            {moduleLinks.length ? (
              <ModuleSwitcher modules={moduleLinks} current="scout" label={t("nav.group.modules")} />
            ) : null}
            <ShiftRail t={t} shift={shiftFrom(session.inbox, session.names)} />
            <nav aria-label={t("nav.primary")}>
              <ul className="flex flex-col gap-0.5">
                {items.map((item) => (
                  <li key={item.href}>
                    <NavItemLink item={item} t={t} />
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <main
            key={pathname}
            id="workspace"
            tabIndex={-1}
            className="lyra-vt-workspace lyra-stagger mx-auto flex min-h-0 min-w-0 w-full max-w-[var(--measure-canvas)] flex-1 flex-col gap-[var(--stack-gap)] overflow-y-auto overflow-x-hidden p-[var(--gutter-canvas)]"
          >
            <span aria-hidden="true" className="h-0.5 w-full shrink-0 rounded-full" style={{ background: SCOUT_ACCENT }} />
            {crumbs.length ? <Breadcrumbs items={crumbs} label={t("nav.breadcrumb")} /> : null}
            {slow ? <PageSkeleton label={t("common.loading")} /> : children}
          </main>

          {mayCompanion && companion ? <Companion t={t} /> : null}
        </div>

        <footer className="lyra-vt-status z-20 hidden h-[var(--chrome-status)] shrink-0 items-center gap-2 border-t border-border bg-surface-1 px-[var(--gutter)] font-mono text-12 text-subtle sm:flex">
          <span aria-hidden="true" className="truncate">
            {productName}
          </span>
          <NavLink to="/design" className="ms-auto shrink-0 hover:text-text aria-[current=page]:text-text">
            {t("nav.doctrine")}
          </NavLink>
        </footer>
      </div>
    </ToastProvider>
  );
}

function NavItemLink({ item, t }: { item: RailItem; t: Translate }) {
  return (
    <NavLink
      to={item.href}
      viewTransition
      className={({ isActive }) =>
        [
          "group flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-start font-ui text-13 transition-colors duration-150",
          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          isActive ? "bg-surface-2 font-medium text-text" : "text-muted hover:bg-surface-2 hover:text-text"
        ].join(" ")
      }
    >
      {({ isActive }) => (
        <>
          <span
            aria-hidden="true"
            className={[
              "h-4 w-0.5 shrink-0 rounded-orbit transition-opacity duration-150",
              isActive ? "opacity-100" : "opacity-0 group-hover:opacity-50"
            ].join(" ")}
            style={{ background: SCOUT_ACCENT }}
          />
          <span className="truncate">{t(item.labelKey)}</span>
        </>
      )}
    </NavLink>
  );
}

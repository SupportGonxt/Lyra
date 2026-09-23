/**
 * Navigation — app shell, module switcher, rail, breadcrumbs, top bar.
 *
 * ══ HARD RULE ══════════════════════════════════════════════════════════════
 * Every navigation target renders a VISIBLE TEXT LABEL. `label` is a required
 * prop on every component in this file, icons are decorative (`aria-hidden`)
 * and optional, and there is deliberately NO `collapsed` / `iconOnly` /
 * `compact-rail` prop anywhere. An icon-only navigation variant is a bug, not
 * a feature — this overrides docs/07 §3's "collapsible to icons".
 * `src/ui.test.ts` fails the build if a label ever becomes optional here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Brand tokens, not brand strings (CLAUDE.md §5): TopBar takes the tenant's
 * name and mark as props. No product name is hard-coded in this package.
 */
import * as React from "react";
import { cn, focusRing } from "./cn.js";
import { Avatar, Badge } from "./primitives.js";
import { useUiText } from "./text.js";

export type LyraModule = "axis" | "orbit" | "signal" | "scout" | "north";

const moduleAccent: Record<LyraModule, string> = {
  axis: "bg-module-axis",
  orbit: "bg-module-orbit",
  signal: "bg-module-signal",
  scout: "bg-module-scout",
  north: "bg-module-north"
};

/* -------------------------------------------------------------------------- */
/* NavItem                                                                     */
/* -------------------------------------------------------------------------- */

export interface NavItemProps extends Omit<React.ComponentPropsWithRef<"a">, "children"> {
  /** Required and always rendered as visible text. There is no icon-only mode. */
  label: string;
  /** Decorative only. Never conveys meaning on its own. */
  icon?: React.ReactNode;
  active?: boolean;
  /** Module identity tint for the active indicator. */
  module?: LyraModule;
  /** Small trailing count/status, e.g. unread work. */
  badge?: React.ReactNode;
}

export function NavItem({ label, icon, active = false, module, badge, className, ...props }: NavItemProps) {
  return (
    <a
      {...props}
      {...(active ? { "aria-current": "page" as const } : {})}
      className={cn(
        "group relative flex min-h-10 items-center gap-3 rounded-md px-3 py-2 font-ui text-14",
        "transition-colors duration-150 ease-out",
        active ? "bg-surface-3 text-text" : "text-muted hover:bg-surface-2 hover:text-text",
        focusRing,
        className
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className={cn("absolute h-4 w-[3px] rounded-sm", module ? moduleAccent[module] : "bg-accent")}
          style={{ insetInlineStart: "-4px" }}
        />
      ) : null}
      {icon ? (
        <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {/* The label is unconditional — it has no `collapsed` branch. */}
      <span className="flex-1 truncate text-start">{label}</span>
      {badge ? <span className="shrink-0">{badge}</span> : null}
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* NavSection / NavRail                                                        */
/* -------------------------------------------------------------------------- */

export interface NavSectionProps {
  /** Required: section headings are visible, not tooltips. */
  label: string;
  children: React.ReactNode;
  className?: string;
}

export function NavSection({ label, children, className }: NavSectionProps) {
  const id = React.useId();
  return (
    <div className={cn("flex flex-col gap-1", className)} role="group" aria-labelledby={id}>
      <h2 id={id} className="px-3 py-2 font-ui text-12 uppercase tracking-[0.14em] text-subtle">
        {label}
      </h2>
      {children}
    </div>
  );
}

export interface NavRailProps extends Omit<React.ComponentPropsWithRef<"nav">, "children"> {
  /** Required: names the landmark for assistive tech. */
  label: string;
  children: React.ReactNode;
  /** Rendered above the nav — typically the ModuleSwitcher. */
  header?: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * The left rail. Fixed inline size; wide enough that labels always fit — the
 * rail does not collapse, so labels never have to be sacrificed.
 */
export function NavRail({ label, children, header, footer, className, ...props }: NavRailProps) {
  return (
    <nav
      {...props}
      aria-label={label}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-4 border-e border-border bg-surface-1 p-3 text-start",
        className
      )}
    >
      {header}
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto">{children}</div>
      {footer}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* ModuleSwitcher                                                              */
/* -------------------------------------------------------------------------- */

export interface ModuleLink {
  id: LyraModule;
  /** Required visible text — the module glyph never stands alone. */
  label: string;
  href: string;
  icon?: React.ReactNode;
  /** Unseen work in that module. */
  unread?: number;
  disabled?: boolean;
}

export interface ModuleSwitcherProps {
  modules: ModuleLink[];
  current?: LyraModule;
  /** Accessible name for the switcher landmark. */
  label?: string;
  className?: string;
}

export function ModuleSwitcher({
  modules,
  current,
  label,
  className
}: ModuleSwitcherProps) {
  const t = useUiText();
  return (
    <nav aria-label={label ?? t("modules")} className={cn("flex flex-col gap-1", className)}>
      {modules.map((m) => (
        <NavItem
          key={m.id}
          href={m.href}
          label={m.label}
          module={m.id}
          active={m.id === current}
          {...(m.icon ? { icon: m.icon } : {})}
          {...(m.disabled ? { "aria-disabled": true, tabIndex: -1 } : {})}
          {...(m.unread
            ? {
                badge: (
                  <Badge tone="accent" size="sm">
                    {m.unread}
                  </Badge>
                )
              }
            : {})}
        />
      ))}
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Breadcrumbs — only below module level (docs/07 §3)                          */
/* -------------------------------------------------------------------------- */

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({
  items,
  label,
  className,
  renderLink
}: {
  items: Crumb[];
  label?: string;
  className?: string;
  /**
   * The app's router link. A bare `<a>` reloads the whole document, losing the
   * view transition and every piece of client state on the way up a level.
   */
  renderLink?: (props: { href: string; className: string; children: React.ReactNode }) => React.ReactNode;
}) {
  const t = useUiText();
  return (
    <nav aria-label={label ?? t("breadcrumb")} className={className}>
      <ol className="flex flex-wrap items-center gap-2 font-ui text-12 text-subtle">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-2">
              {c.href && !last ? (
                renderLink ? (
                  renderLink({ href: c.href, className: cn("rounded-sm hover:text-text", focusRing), children: c.label })
                ) : (
                  <a href={c.href} className={cn("rounded-sm hover:text-text", focusRing)}>
                    {c.label}
                  </a>
                )
              ) : (
                <span {...(last ? { "aria-current": "page" as const, className: "text-muted" } : {})}>
                  {c.label}
                </span>
              )}
              {last ? null : (
                <span aria-hidden="true" className="text-border-strong">
                  /
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* TopBar                                                                      */
/* -------------------------------------------------------------------------- */

export interface TopBarProps {
  /** Tenant brand name from tenant config — never a hard-coded product name. */
  brandName: string;
  /** Tenant logo/mark element from tenant config. */
  brandMark?: React.ReactNode;
  /** Opens the CommandBar. Rendered with its label, never as a bare glyph. */
  onSearch?: () => void;
  searchLabel?: string;
  searchShortcut?: string;
  actions?: React.ReactNode;
  user?: { name: string; src?: string };
  className?: string;
}

export function TopBar({
  brandName,
  brandMark,
  onSearch,
  searchLabel,
  searchShortcut = "⌘K",
  actions,
  user,
  className
}: TopBarProps) {
  const t = useUiText();
  return (
    <header
      className={cn(
        "flex items-center gap-4 border-b border-border bg-surface-1 px-5 py-3 text-start",
        className
      )}
    >
      <div className="flex items-center gap-2 font-display text-14 font-medium text-text">
        {brandMark ? <span aria-hidden="true">{brandMark}</span> : null}
        <span>{brandName}</span>
      </div>
      {onSearch ? (
        <button
          type="button"
          onClick={onSearch}
          className={cn(
            "flex max-w-md flex-1 items-center gap-2 rounded-orbit border border-border bg-surface-2 px-3 py-1.5",
            "font-ui text-13 text-subtle hover:text-muted",
            focusRing
          )}
        >
          <span className="flex-1 text-start">{searchLabel ?? t("search")}</span>
          <kbd className="font-mono text-12 text-subtle">{searchShortcut}</kbd>
        </button>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex items-center gap-2">
        {actions}
        {user ? <Avatar name={user.name} {...(user.src ? { src: user.src } : {})} size="sm" /> : null}
      </div>
    </header>
  );
}

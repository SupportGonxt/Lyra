import { translator } from "../i18n";
import { labelKeyFor } from "../routing";
import type { SessionBootstrap } from "../session.server";
import { Shell } from "./shell";

import type { ModuleScreen } from "../modules/screens";

/**
 * A module's frame is the one frame (ADR-0085): the shared `Shell`, with the
 * module's own screens leading the rail. The screens a reader could only be
 * refused at are absent rather than offered.
 */
export function ModuleShell({
  session,
  module,
  screens,
  children
}: {
  session: SessionBootstrap;
  module: "axis" | "orbit" | "signal" | "scout" | "north";
  screens: readonly ModuleScreen[];
  children: React.ReactNode;
}) {
  const t = translator(session.locale, session.overrides);
  const held = new Set(session.permissions);
  return (
    <Shell
      t={t}
      nav={session.nav}
      brand={session.brand}
      tenantName={session.tenantName}
      actorName={session.actorName}
      inbox={session.inbox}
      roles={session.roles}
      permissions={session.permissions}
      section={{
        label: t(`nav.${module}`),
        accent: `var(--module-${module})`,
        items: visibleScreens(screens, held).map((screen) => ({ href: screen.href, labelKey: labelKeyFor(screen.href) }))
      }}
      meridian={module === "north"}
      locale={session.locale}
      aiPause={session.aiPause}
    >
      {children}
    </Shell>
  );
}

/** The screens this reader may use. Exported for the test. */
export function visibleScreens(screens: readonly ModuleScreen[], held: ReadonlySet<string>): ModuleScreen[] {
  return screens.filter((screen) => !screen.permission || held.has(screen.permission));
}

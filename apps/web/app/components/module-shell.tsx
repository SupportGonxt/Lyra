import { translator } from "../i18n";
import type { SessionBootstrap } from "../session.server";
import { Shell } from "./shell";

/**
 * A module's frame is the one frame (ADR-0085): the shared `Shell`, whose rail
 * leads with the workspace menu (components/menu.ts) exactly as it does on the
 * module's generic lists. What a module shell adds is only NORTH's Meridian.
 */
export function ModuleShell({
  session,
  module,
  children
}: {
  session: SessionBootstrap;
  module: "axis" | "orbit" | "signal" | "scout" | "north";
  children: React.ReactNode;
}) {
  return (
    <Shell
      t={translator(session.locale, session.overrides)}
      nav={session.nav}
      brand={session.brand}
      tenantName={session.tenantName}
      actorName={session.actorName}
      inbox={session.inbox}
      roles={session.roles}
      permissions={session.permissions}
      pack={session.domainPack}
      meridian={module === "north"}
      locale={session.locale}
      aiPause={session.aiPause}
    >
      {children}
    </Shell>
  );
}

import type { SessionBootstrap } from "../session.server";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085); its rail leads with SCOUT's menu (components/menu.ts). */
export function ScoutShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="scout">
      {children}
    </ModuleShell>
  );
}

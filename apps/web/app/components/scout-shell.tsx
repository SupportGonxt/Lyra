import type { SessionBootstrap } from "../session.server";
import { SCOUT_SCREENS } from "../modules/screens";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085), led by SCOUT's own screens (modules/screens.ts). */
export function ScoutShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="scout" screens={SCOUT_SCREENS}>
      {children}
    </ModuleShell>
  );
}

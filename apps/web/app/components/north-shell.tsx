import type { SessionBootstrap } from "../session.server";
import { NORTH_SCREENS } from "../modules/screens";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085), led by NORTH's own screens (modules/screens.ts). */
export function NorthShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="north" screens={NORTH_SCREENS}>
      {children}
    </ModuleShell>
  );
}

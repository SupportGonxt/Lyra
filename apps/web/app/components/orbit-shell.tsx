import type { SessionBootstrap } from "../session.server";
import { ORBIT_SCREENS } from "../modules/screens";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085), led by ORBIT's own screens (modules/screens.ts). */
export function OrbitShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="orbit" screens={ORBIT_SCREENS}>
      {children}
    </ModuleShell>
  );
}

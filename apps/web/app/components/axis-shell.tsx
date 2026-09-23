import type { SessionBootstrap } from "../session.server";
import { AXIS_SCREENS } from "../modules/screens";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085), led by AXIS's own screens (modules/screens.ts). */
export function AxisShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="axis" screens={AXIS_SCREENS}>
      {children}
    </ModuleShell>
  );
}

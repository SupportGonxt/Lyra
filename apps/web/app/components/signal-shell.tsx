import type { SessionBootstrap } from "../session.server";
import { SIGNAL_SCREENS } from "../modules/screens";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085), led by SIGNAL's own screens (modules/screens.ts). */
export function SignalShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="signal" screens={SIGNAL_SCREENS}>
      {children}
    </ModuleShell>
  );
}

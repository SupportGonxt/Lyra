import type { SessionBootstrap } from "../session.server";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085); its rail leads with SIGNAL's menu (components/menu.ts). */
export function SignalShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="signal">
      {children}
    </ModuleShell>
  );
}

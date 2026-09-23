import type { SessionBootstrap } from "../session.server";
import { ModuleShell } from "./module-shell";

/** The one frame (ADR-0085); its rail leads with ORBIT's menu (components/menu.ts). */
export function OrbitShell({ session, children }: { session: SessionBootstrap; children: React.ReactNode }) {
  return (
    <ModuleShell session={session} module="orbit">
      {children}
    </ModuleShell>
  );
}

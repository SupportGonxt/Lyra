import { data, Outlet, useLoaderData, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import { cloudflare } from "../context";
import { bootstrapSession, type SessionBootstrap } from "../session.server";
import { OrbitShell } from "../components/orbit-shell";
import { SessionRegion } from "../components/region";
import { sessionMeta } from "../title";

export const meta = sessionMeta;

// ORBIT's own layout: same bootstrap every other layout uses, but gated —
// an actor whose roles never resolve to "orbit" is real (bootstrapSession
// already proved that) and simply not entitled to this shell, so this
// throws 403, not 401 (docs/superpowers/specs
// /2026-08-16-orbit-shell-fork-design.md § Architecture).

export const ROUTE_ID = "routes/orbit-shell";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await bootstrapSession(context.get(cloudflare).env, request);
  if (!session.availableShells.includes("orbit")) throw data("", { status: 403 });
  return session;
}

/** Session data for any route rendered inside OrbitShell. */
export function useOrbitSessionData(): SessionBootstrap | undefined {
  return useRouteLoaderData<typeof loader>(ROUTE_ID);
}

export default function OrbitShellLayout() {
  const session = useLoaderData<typeof loader>();
  return (
    <SessionRegion session={session}>
      <OrbitShell session={session}>
        <Outlet />
      </OrbitShell>
    </SessionRegion>
  );
}

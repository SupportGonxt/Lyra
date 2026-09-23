import { data, Outlet, useLoaderData, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import { cloudflare } from "../context";
import { bootstrapSession, type SessionBootstrap } from "../session.server";
import { AxisShell } from "../components/axis-shell";
import { SessionRegion } from "../components/region";
import { sessionMeta } from "../title";

export const meta = sessionMeta;

// AXIS's own layout: same bootstrap every other layout uses, but gated —
// an actor whose roles never resolve to "axis" is real (bootstrapSession
// already proved that) and simply not entitled to this shell, so this
// throws 403, not 401 (docs/superpowers/specs
// /2026-08-16-axis-shell-fork-design.md § Routing).

export const ROUTE_ID = "routes/axis-shell";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await bootstrapSession(context.get(cloudflare).env, request);
  if (!session.availableShells.includes("axis")) throw data("", { status: 403 });
  return session;
}

/** Session data for any route rendered inside AxisShell. */
export function useAxisSessionData(): SessionBootstrap | undefined {
  return useRouteLoaderData<typeof loader>(ROUTE_ID);
}

export default function AxisShellLayout() {
  const session = useLoaderData<typeof loader>();
  return (
    <SessionRegion session={session}>
      <AxisShell session={session}>
        <Outlet />
      </AxisShell>
    </SessionRegion>
  );
}

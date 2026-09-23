import { data, Outlet, useLoaderData, useRouteLoaderData, type LoaderFunctionArgs } from "react-router";
import { cloudflare } from "../context";
import { bootstrapSession, type SessionBootstrap } from "../session.server";
import { ScoutShell } from "../components/scout-shell";
import { SessionRegion } from "../components/region";
import { sessionMeta } from "../title";

export const meta = sessionMeta;

// SCOUT's own layout: same bootstrap every other layout uses, but gated —
// an actor whose roles never resolve to "scout" is real (bootstrapSession
// already proved that) and simply not entitled to this shell, so this
// throws 403, not 401 (docs/superpowers/specs
// /2026-08-16-scout-shell-fork-design.md § Architecture).

export const ROUTE_ID = "routes/scout-shell";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const session = await bootstrapSession(context.get(cloudflare).env, request);
  if (!session.availableShells.includes("scout")) throw data("", { status: 403 });
  return session;
}

/** Session data for any route rendered inside ScoutShell. */
export function useScoutSessionData(): SessionBootstrap | undefined {
  return useRouteLoaderData<typeof loader>(ROUTE_ID);
}

export default function ScoutShellLayout() {
  const session = useLoaderData<typeof loader>();
  return (
    <SessionRegion session={session}>
      <ScoutShell session={session}>
        <Outlet />
      </ScoutShell>
    </SessionRegion>
  );
}

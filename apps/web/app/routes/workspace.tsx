import {
  Outlet,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
  type LoaderFunctionArgs
} from "react-router";
import { cloudflare } from "../context";
import { ErrorPanel } from "../components/error-panel";
import { Shell } from "../components/shell";
import { SessionRegion } from "../components/region";
import { DEFAULT_LOCALE, translator } from "../i18n";
import { bootstrapSession } from "../session.server";
import { sessionMeta } from "../title";

// Everything behind a session hangs off this layout. bootstrapSession() feeds
// the whole shell: actor, tenant brand, permissions and the nav the API
// already filtered for them. north-shell.tsx calls the same function for
// NORTH's own layout — see session.server.ts.

export const ROUTE_ID = "routes/workspace";

export async function loader({ request, context }: LoaderFunctionArgs) {
  return bootstrapSession(context.get(cloudflare).env, request);
}

export type ShellData = Awaited<ReturnType<typeof loader>>;

/** Shell data for any route rendered inside the layout. */
export function useShellData(): ShellData | undefined {
  return useRouteLoaderData<typeof loader>(ROUTE_ID);
}

// "Screen · Workspace · Product" — the product name is tenant configuration,
// never a literal (CLAUDE.md §5).
export const meta = sessionMeta;

/**
 * A screen inside the session that fails is still a screen. Without a boundary
 * here the nearest one is root's, which replaces the whole document: typing
 * `/north` as an agent who holds no NORTH role dropped the rail, the day strip
 * and the tenant's own brand, and read as a crash rather than a closed door.
 *
 * It has to survive its own layout's loader having failed — the boundary
 * renders for that case too, and there is then no shell to render. The bare
 * panel is the fallback; root's boundary stays the one for a dead document.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const shell = useShellData();
  const t = translator(shell?.locale ?? DEFAULT_LOCALE, shell?.overrides);
  const panel = <ErrorPanel error={error} t={t} className="mx-auto my-16" />;

  if (!shell) return <main className="mx-auto flex min-h-screen max-w-prose flex-col justify-center p-8">{panel}</main>;

  return (
    <SessionRegion session={shell}>
      <Shell
        t={t}
        nav={shell.nav}
        brand={shell.brand}
        tenantName={shell.tenantName}
        actorName={shell.actorName}
        inbox={shell.inbox}
        roles={shell.roles}
        permissions={shell.permissions}
        locale={shell.locale}
        pack={shell.domainPack}
        aiPause={shell.aiPause}
      >
        {panel}
      </Shell>
    </SessionRegion>
  );
}

export default function Workspace() {
  const shell = useLoaderData<typeof loader>();
  const t = translator(shell.locale, shell.overrides);

  return (
    // Every <DateTime> and <Money> below reads the tenant's calendar and zone
    // off this provider — the alternative is remembering a prop at 124 call
    // sites, and the five module shells mount the same component.
    <SessionRegion session={shell}>
      <Shell
        t={t}
        nav={shell.nav}
        brand={shell.brand}
        tenantName={shell.tenantName}
        actorName={shell.actorName}
        inbox={shell.inbox}
        roles={shell.roles}
        permissions={shell.permissions}
        locale={shell.locale}
        pack={shell.domainPack}
        aiPause={shell.aiPause}
      >
        <Outlet />
      </Shell>
    </SessionRegion>
  );
}

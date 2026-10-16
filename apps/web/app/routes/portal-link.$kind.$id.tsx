import { redirect, type LoaderFunctionArgs } from "react-router";
import { api, asRouteError } from "../api.server";
import { cloudflare } from "../context";

// docs: PORTALS-DESIGN-AND-AUDIT.md. A resource route, not a screen: staff open
// an insurer's or a channel's external portal by opening THIS, which mints the
// tokened link server-side — the session cookie never leaves the server, so the
// browser cannot call /v1/core or /v1/dist itself — and hands the browser over
// to the tenant-branded page.
//
// The API gates each mint on the permission that reads the row, so a seat
// without it is refused here rather than handed somebody else's link. It is the
// opener that keeps those two routes off the dead-seam list: a mint nothing
// calls is a mint nobody can use.

/** Which API resource mints each kind's link. */
const MINTERS: Record<string, string> = {
  supplier: "core/providers",
  channel: "dist/channels"
};

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const resource = MINTERS[params.kind!];
  if (!resource) throw new Response("not found", { status: 404 });

  const minted = await api<{ url: string }>(
    `/v1/${resource}/${encodeURIComponent(params.id!)}/portal-link`,
    { env, request }
  ).catch(asRouteError);
  return redirect(minted.url);
}

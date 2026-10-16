import type { LoaderFunctionArgs } from "react-router";
import { proxyFile } from "../api.server";
import { cloudflare } from "../context";

// A pure byte proxy: the browser can't read the session cookie (httpOnly), so
// a plain <a href> to apps/api would 401. This loader forwards the cookie
// server-side (api.server.ts's apiFetch) and streams the response straight
// through — same "server-side by design" shape as every other loader here.

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<Response> {
  const env = context.get(cloudflare).env;
  const caseId = params.id as string;
  const bundleId = params.bundleId as string;
  // The case id is **enforced**, not decorative. This route used to forward only
  // the bundle id to the compliance proxy, so the case scoping its own path
  // promised was never checked — any bundle could be pulled through any case's
  // URL. The AXIS route refuses a bundle whose recorded scope names another case
  // (docs/modules/axis.md §8 criterion 3).
  return proxyFile(
    `/v1/axis/cases/${encodeURIComponent(caseId)}/audit-bundle/${encodeURIComponent(bundleId)}/download`,
    { env, request },
    "application/zip"
  );
}

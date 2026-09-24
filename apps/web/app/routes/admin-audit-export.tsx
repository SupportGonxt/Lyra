import type { LoaderFunctionArgs } from "react-router";
import { proxyFile } from "../api.server";
import { cloudflare } from "../context";

// The audit chain as a CSV (docs/27 F59), streamed through the app so the
// session cookie authenticates it and the API audits the export itself
// (apps/api/src/routes/core.ts `/audit-log/export`). The list's search rides
// along, so what downloads is what the reader was looking at.
export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const env = context.get(cloudflare).env;
  const q = new URL(request.url).searchParams.get("q")?.trim();
  const query = q ? `?q=${encodeURIComponent(q)}` : "";
  return proxyFile(`/v1/core/audit-log/export${query}`, { env, request }, "text/csv");
}

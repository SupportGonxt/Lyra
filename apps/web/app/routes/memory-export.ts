import type { LoaderFunctionArgs } from "react-router";
import { proxyFile } from "../api.server";
import { cloudflare } from "../context";

// Streams the tenant's record notes as an Obsidian vault (ADR-0085). The API
// decides which notes this reader may take; this route only carries the bytes
// under the shared file-proxy headers, so a refusal arrives as its status.

export async function loader({ request, context }: LoaderFunctionArgs): Promise<Response> {
  const env = context.get(cloudflare).env;
  return proxyFile("/v1/core/notes/export", { env, request }, "application/zip");
}

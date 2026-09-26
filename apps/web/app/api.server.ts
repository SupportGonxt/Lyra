import { data } from "react-router";
import { ApiError, invalidFields, rejectedBy } from "./api-error";
import type { Problem } from "./api-error";
import type { Env } from "./env";
import type { Names } from "./names";

// The only way this app talks to apps/api. Server-side by design: every call
// the shell makes happens in a loader or an action, so the session cookie never
// has to be readable by script and the API origin never reaches the client
// bundle. A browser-side call would import this file into the client — the
// `.server` suffix makes that a build error instead of a leak.

// Moved to ./api-error so client-bundled kits can `instanceof` it; re-exported
// here so the 70-odd loader/action importers keep one import site.
export { ApiError, invalidFields, rejectedBy };
export type { Problem };

/**
 * For a loader that has nothing to render when the API says no: `await
 * api(…).catch(asRouteError)`.
 *
 * `api()` throws an `ApiError`, which React Router can only treat as a crash —
 * so a screen the actor simply may not read rendered "could not load this page"
 * with a 500 behind it. Rethrown as a route error, the boundary in root.tsx
 * reads the status and says the true thing: signed out, not permitted, or gone.
 * The request id travels as the error's data, which is the one thing support
 * needs. Anything that is not an `ApiError` is a real fault and is left alone.
 */
export function asRouteError(error: unknown): never {
  if (error instanceof ApiError) throw data(error.requestId, { status: error.status });
  throw error;
}

export interface ApiOptions {
  env: Env;
  /** The inbound request, so the caller's session cookie is forwarded. */
  request?: Request;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Raw response, for the few callers that need the headers (login relays cookies). */
export async function apiFetch(path: string, options: ApiOptions): Promise<Response> {
  const { env, request, method = "GET", body } = options;
  const headers = new Headers({ accept: "application/json", ...options.headers });
  if (body !== undefined) headers.set("content-type", "application/json");

  const cookie = request?.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  // Correlate the browser hop with the API hop; apps/api echoes its own id back.
  const inbound = request?.headers.get("x-request-id");
  if (inbound) headers.set("x-request-id", inbound);

  const response = await fetch(new URL(path, env.API_ORIGIN), {
    method,
    headers,
    // Belt and braces: the cookie header above is what actually authenticates a
    // server-to-server hop, but this keeps the call correct if it ever runs in
    // a browser context.
    credentials: "include",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(options.signal ? { signal: options.signal } : {})
  });

  if (!response.ok) throw await ApiError.from(response, path);
  return response;
}

/** Parsed JSON, or `undefined` for the 204s. */
export async function api<T>(path: string, options: ApiOptions): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/* ---------------------------------------------------------------- /v1/names */

/** Rendering side of the same contract; re-exported so loaders have one import. */
export type { Names } from "./names";

/**
 * Display names for the refs a list of rows carries, in one round trip. Rows
 * cross the API as ids (`customerId`, `assigneeRef`, `teamId`), so a screen that
 * renders them raw shows a person a ULID — call this in the loader and fall back
 * to `shortRef` for whatever comes back unresolved.
 *
 * Never throws: a name is decoration on a page that already loaded, and the API
 * omits any ref the actor may not read anyway. A failure means short refs, not
 * an error boundary.
 */
export async function names(refs: ReadonlyArray<string | null | undefined>, options: ApiOptions): Promise<Names> {
  const wanted = [...new Set(refs.filter((ref): ref is string => Boolean(ref)))].slice(0, 200);
  if (!wanted.length) return {};
  const body = await api<{ names: Record<string, string> }>(
    `/v1/names?refs=${encodeURIComponent(wanted.join(","))}`,
    options
  ).catch(() => null);
  return body?.names ?? {};
}

export interface DirectoryEntry {
  /** `user:us_…` / `team:tm_…` — exactly what an assignment field submits. */
  ref: string;
  name: string;
}

/**
 * Who this tenant's work can be assigned to (ADR-0047). The assignment fields
 * on the board, the exceptions queue, the claims desk, a handover and the
 * signal studio all take a ref, and a person cannot type a ULID — call this in
 * the loader and render a picker.
 *
 * Never throws, for the same reason `names` does not: an empty list degrades
 * the field to the text input it used to be rather than the whole screen to an
 * error boundary.
 */
export async function directory(
  options: ApiOptions,
  kind?: "user" | "team"
): Promise<DirectoryEntry[]> {
  const body = await api<{ entries: DirectoryEntry[] }>(
    `/v1/directory${kind ? `?kind=${kind}` : ""}`,
    options
  ).catch(() => null);
  return body?.entries ?? [];
}

/* ------------------------------------------------------------------- /v1/me */

export interface NavItem {
  /** i18n key — the API never sends display text (docs/07 §2). */
  labelKey: string;
  href: string;
  icon: string;
  /** A section label, not a link — `href`/`icon` are unused. */
  heading?: boolean;
  children?: NavItem[];
  /** A resource route answering a file: opened as a document, not client-routed. */
  download?: boolean;
}

/** The whitelabel contract, docs/01 §6. Everything optional: a tenant that
 *  overrides nothing renders the default Deep Field skin. */
export interface Brand {
  /** The product name this tenant sees. Hard-coding it is a bug (CLAUDE.md §5). */
  name?: string;
  logo?: { light?: string; dark?: string; mark?: string };
  palette?: { accent?: string; accentHover?: string; accentContrast?: string };
  /** BrandJson.font: the face a design names (packages/ui/src/design.ts). */
  font?: string;
}

export interface Me {
  actor: { kind: string; id: string };
  profile: { id: string; name: string; email: string; locale: string; status: string } | null;
  tenant: {
    id: string;
    slug: string;
    name: string;
    plan: string;
    region: string;
    status: string;
    brand: Brand | null;
  };
  locale: string;
  roles: string[];
  permissions: string[];
  entitlements: Record<string, unknown>;
  policy: Record<string, unknown>;
  nav: NavItem[];
  overrides: Record<string, string>;
}

/**
 * Everything the shell needs on first paint, in one round trip. There is no
 * /v1/me/nav or /v1/me/permissions — both arrive inside this body, already
 * filtered server-side by the actor's permissions.
 */
export function fetchMe(env: Env, request: Request): Promise<Me> {
  return api<Me>("/v1/me", { env, request });
}

/**
 * Security headers for a byte-proxy loader that streams an uploaded/generated
 * file straight through. `withHeaders` (apps/api/src/mw.ts) sets these for
 * every Hono response, but a route loader builds its own raw `Response` and
 * has to set them itself — dropping them combined with an inline
 * content-disposition on an attacker-controlled content-type is a
 * same-origin stored-XSS vector. Content-disposition defaults to attachment
 * and is only relaxed for the small set of types a browser renders safely,
 * regardless of what upstream (or an attacker-labelled upload) claims.
 */
const RENDER_SAFE_CONTENT_TYPE = /^image\//;

export function fileProxyHeaders(upstream: Response, fallbackContentType: string): Headers {
  const contentType = upstream.headers.get("content-type") ?? fallbackContentType;
  const renderSafe = RENDER_SAFE_CONTENT_TYPE.test(contentType) || contentType === "application/pdf";
  const upstreamDisposition = upstream.headers.get("content-disposition");
  // Forcing attachment (below) still shouldn't cost the browser the filename
  // upstream chose — only the render-safety decision is ours to override.
  const filename = upstreamDisposition?.match(/filename\*?=[^;]+/i)?.[0];
  const forcedDisposition = filename ? `attachment; ${filename}` : "attachment";
  return new Headers({
    "content-type": contentType,
    "content-disposition": renderSafe ? (upstreamDisposition ?? "inline") : forcedDisposition,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "x-frame-options": "DENY"
  });
}

/**
 * One file route's whole job: fetch the bytes and hand them back under the
 * headers above.
 *
 * The reason it exists is that `apiFetch` *throws* on a non-2xx, so every
 * caller that wrote `new Response(upstream.body, { status: upstream.status })`
 * had an unreachable error path — the API's 404 for a missing object became an
 * unhandled `ApiError` and the reader got "Unexpected Server Error", which is
 * what `/axis/documents/:id/file` served in production. Statuses are relayed
 * here instead, with no body, since a `Problem` JSON rendered under
 * `content-disposition: attachment` is not an error message anyone can read.
 */
export async function proxyFile(path: string, options: ApiOptions, fallbackContentType: string): Promise<Response> {
  try {
    const upstream = await apiFetch(path, options);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: fileProxyHeaders(upstream, fallbackContentType)
    });
  } catch (error) {
    if (error instanceof ApiError) return new Response(null, { status: error.status });
    throw error;
  }
}

/** Copy the API's Set-Cookie headers onto our own response, verbatim. */
export function relayCookies(from: Response, to: Headers): Headers {
  const cookies: string[] =
    typeof from.headers.getSetCookie === "function"
      ? from.headers.getSetCookie()
      : [from.headers.get("set-cookie") ?? ""].filter(Boolean);
  for (const cookie of cookies) to.append("set-cookie", cookie);
  return to;
}

/**
 * The session cookie, emptied. Only for the two paths that end a session with no
 * API response to relay — everything else uses `relayCookies` above, so the
 * attributes come from apps/api and cannot disagree. Here they can, and the one
 * that matters is `Domain`: clearing a domain-scoped cookie with a host-only
 * header leaves the real cookie in place and adds a second, empty one.
 */
export function clearedSessionCookie(env: Env): string {
  const domain = env.SESSION_COOKIE_DOMAIN ? `; Domain=${env.SESSION_COOKIE_DOMAIN}` : "";
  return `${env.SESSION_COOKIE}=; Path=/${domain}; HttpOnly; SameSite=Lax; Max-Age=0`;
}

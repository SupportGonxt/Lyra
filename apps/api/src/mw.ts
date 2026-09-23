import type { MiddlewareHandler } from "hono";
import { AppError, rememberRequest } from "@lyra/core";
import { Gateway } from "@lyra/model-gateway";
import { authenticate, ctxFor } from "./auth.js";
import { problem } from "./http.js";
import { simNow } from "./clock.js";
import type { App, Env } from "./env.js";

// Every request passes through the same four steps: clock, auth, ctx, gateway.
// Handlers below this file never see a raw binding, so there is no path that
// reaches the database without a tenant id attached.

/**
 * Routes reachable without credentials. Everything else authenticates.
 *
 * The `/v1/auth/mfa/*` routes are here because the caller holds a real session
 * that has deliberately not cleared the second-factor gate `authenticate`
 * applies — they resolve and check that session themselves (auth.ts §mfa).
 */
const PUBLIC = new Set([
  "/health",
  "/v1/auth/login",
  "/v1/auth/logout",
  "/v1/auth/mfa/enrol",
  "/v1/auth/mfa/enrol/confirm",
  "/v1/auth/mfa/verify",
  "/v1/auth/mfa/disable",
  // Demo persona sign-in. The routes themselves 404 outside a demo deployment
  // (auth.ts §demoOnly), so being listed here costs nothing in production.
  "/v1/auth/demo/personas",
  "/v1/auth/demo/login",
  "/v1/auth/demo/clock",
  "/v1/auth/demo/seed",
  "/v1/auth/demo/resync-roles",
  // J-X3: portal signup has no session to authenticate against yet — that is
  // the whole point of the route (routes/onboarding.ts §partner signup).
  "/v1/onboarding/partners/signup",
  // The reference underwriter (ADR-0072). It is a foreign carrier, not a LYRA
  // API: no tenant, no session, no data — a stateless price calculator over the
  // risk it is posted. Its own IP throttle is in routes/carrier-sandbox.ts.
  "/carrier-sandbox/quote",
  "/openapi.json"
]);

export const withContext: MiddlewareHandler<App> = async (c, next) => {
  const now = await simNow(c.env);
  c.set("startedAt", now);

  // `/v1/auth/sso/*`, `/v1/portal/*` and `/v1/channels/*` are public by shape
  // rather than by name: each carries a dynamic id segment (provider / tenant
  // slug / connector id) with no session to authenticate until the callback
  // runs, or the visitor is the point of the route (routes/portal.ts), or the
  // caller is a messaging provider whose signature is the credential
  // (routes/channels.ts).
  if (
    PUBLIC.has(c.req.path) ||
    c.req.path.startsWith("/v1/auth/sso/") ||
    c.req.path.startsWith("/v1/portal/") ||
    c.req.path.startsWith("/v1/channels/")
  ) {
    c.set("requestId", crypto.randomUUID());
    return next();
  }

  const auth = await authenticate(c.env, c.req.raw, now);
  const ctx = await ctxFor(
    c.env,
    auth,
    now,
    c.req.header("cf-connecting-ip"),
    c.req.header("user-agent")
  );
  c.set("ctx", ctx);
  c.set("requestId", ctx.requestId);
  c.set("gateway", gatewayFor(c.env));
  return next();
};

export function gatewayFor(env: Env): Gateway {
  return new Gateway({
    env: {
      ...(env.AI ? { AI: env.AI } : {}),
      ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
      ...(env.AI_GATEWAY_URL ? { AI_GATEWAY_URL: env.AI_GATEWAY_URL } : {}),
      ...(env.OPENAI_COMPAT_URL ? { OPENAI_COMPAT_URL: env.OPENAI_COMPAT_URL } : {}),
      ...(env.OPENAI_COMPAT_API_KEY ? { OPENAI_COMPAT_API_KEY: env.OPENAI_COMPAT_API_KEY } : {}),
      ...(env.TELEMETRY ? { TELEMETRY: env.TELEMETRY } : {})
    }
  });
}

/** Response headers that apply to every route, including error responses. */
export const withHeaders: MiddlewareHandler<App> = async (c, next) => {
  await next();
  const latencyMs = Date.now() - (c.get("startedAt") ?? Date.now());
  c.header("x-request-id", c.get("requestId") ?? "");
  c.header("x-response-time-ms", String(latencyMs));
  c.header("referrer-policy", "no-referrer");
  c.header("x-content-type-options", "nosniff");
  c.header("cache-control", "no-store");
  // docs/10 §6: security headers. This is a JSON API — no inline scripts/styles to
  // allow, so default-src 'none' plus frame-ancestors is the whole policy.
  c.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  c.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
  c.header("x-frame-options", "DENY");
  // docs/10 §2: request metrics half of TELEMETRY (AI-usage half is Gateway.writeAudit).
  c.env.TELEMETRY?.writeDataPoint({
    blobs: [c.req.method, c.req.routePath ?? c.req.path, String(c.res.status), c.get("ctx")?.tenantId ?? "anonymous"],
    doubles: [latencyMs],
    indexes: [c.get("ctx")?.tenantId ?? "anonymous"]
  });
};

/**
 * CORS for the first-party web app only. A wildcard origin plus credentials is
 * not a valid combination anyway, so there is nothing to loosen here later.
 */
export const withCors: MiddlewareHandler<App> = async (c, next) => {
  const origin = c.req.header("origin");
  const allowed = c.env.APP_ORIGIN;
  if (origin && allowed && origin === allowed) {
    c.header("access-control-allow-origin", origin);
    c.header("access-control-allow-credentials", "true");
    c.header("vary", "origin");
  }
  if (c.req.method === "OPTIONS") {
    c.header("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
    c.header("access-control-allow-headers", "content-type,authorization,idempotency-key,x-approval-id");
    c.header("access-control-max-age", "600");
    return c.body(null, 204);
  }
  return next();
};

export function onError(err: unknown, c: Parameters<typeof problem>[0]): Response {
  const res = problem(c, err);
  // The client only ever sees the generic 500 (toProblem never leaks internals),
  // so without this line an unexpected failure is invisible in Workers Logs too.
  // Anything that maps to a 4xx is a normal outcome and stays quiet.
  // 503 is excluded: it is a state we chose to be in (the AI kill switch,
  // docs/12 §4), not a failure to explain — and while a pause is on, every
  // call would log one.
  if (res.status >= 500 && res.status !== 503) {
    console.error(`unhandled ${c.req.method} ${c.req.path}:`, err instanceof Error ? err.stack : err);
  }
  return res;
}

const WRITES = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * When a gate stops a write (403 approval_required), keep the request on the
 * approval so the requester can finish it once approved instead of re-entering
 * the form (packages/core/src/approvals.ts `rememberRequest`). JSON and empty
 * bodies only: an upload is re-sent by the person, not replayed from a row.
 * Best effort — failing to remember never changes the refusal the caller gets.
 */
export const rememberStopped: MiddlewareHandler<App> = async (c, next) => {
  const ctx = c.get("ctx");
  const type = c.req.header("content-type") ?? "";
  if (!ctx || !WRITES.has(c.req.method) || (type && !type.includes("json"))) return next();
  const body = await c.req.raw.clone().text();
  await next();
  const err = c.error;
  if (!(err instanceof AppError) || err.code !== "approval_required") return;
  const approvalId = err.extras.approval_id;
  if (typeof approvalId !== "string") return;
  const url = new URL(c.req.url);
  await rememberRequest(ctx, approvalId, { method: c.req.method, path: url.pathname + url.search, body: body || null }).catch(
    () => undefined
  );
};

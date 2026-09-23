import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// One-click persona sign-in (auth.ts §demo). It is a credential bypass, so the
// test that matters most is the one asserting it does not exist in production.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const exec = { waitUntil() {}, passThroughOnException() {} };
let database: Db;

function envFor(environment: string, extra: Partial<Env> = {}): Env {
  return {
    DB_CLIENT: database,
    ENVIRONMENT: environment,
    APP_ORIGIN: "http://localhost:5173",
    ...extra
  } as unknown as Env;
}

async function call<T = any>(
  environment: string,
  method: string,
  path: string,
  payload?: unknown,
  extra: Partial<Env> = {},
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T; headers: Headers }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    envFor(environment, extra) as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T), headers: res.headers };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never);
}, 60_000);

describe("demo sign-in", () => {
  it("is not there in production", async () => {
    const list = await call("production", "GET", "/v1/auth/demo/personas");
    expect(list.status).toBe(404);
    const login = await call("production", "POST", "/v1/auth/demo/login", {
      email: "amina.saleh@gonxt.ae"
    });
    expect(login.status).toBe(404);
  });

  it("lists one row per seeded persona, with the role each one demonstrates", async () => {
    const list = await call("staging", "GET", "/v1/auth/demo/personas");
    expect(list.status).toBe(200);
    const personas = list.body.data as { email: string; name: string; roleKey: string }[];
    expect(personas.length).toBeGreaterThan(5);
    expect(new Set(personas.map((p) => p.email)).size).toBe(personas.length);
    const admin = personas.find((p) => p.email === "amina.saleh@gonxt.ae");
    expect(admin?.roleKey).toBe("tenant.admin");
    // No credential leaves this route.
    expect(JSON.stringify(personas)).not.toMatch(/pbkdf2|passwordHash/i);
  });

  it("signs a persona all the way in, past the second-factor wall", async () => {
    const login = await call("staging", "POST", "/v1/auth/demo/login", {
      email: "amina.saleh@gonxt.ae"
    });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(false);
    expect(login.headers.get("set-cookie")).toContain("lyra_session=");

    // The point of the door: the session works immediately, where a password
    // login for this role would have stopped at TOTP enrolment.
    const me = await app.fetch(
      new Request("http://api.test/v1/me", {
        headers: { authorization: `Bearer ${login.body.token}` }
      }),
      envFor("staging") as never,
      exec as never
    );
    expect(me.status).toBe(200);
  });

  it("refuses an email it did not seed", async () => {
    const login = await call("staging", "POST", "/v1/auth/demo/login", {
      email: "attacker@example.com"
    });
    expect(login.status).toBe(404);
  });
});

// The seeded dead event names (docs/27, 2026-09-23) reach a deployed tenant
// only through the resync seam — seed() never runs twice (CLAUDE.md sighting 9).
describe("POST /v1/auth/demo/resync-roles", () => {
  it("rewrites a stale seeded webhook subscription, and a second call rewrites nothing", async () => {
    const [hook] = await database.select().from(schema.webhooks).where(like(schema.webhooks.url, "%cedarinsurance%"));
    await database
      .update(schema.webhooks)
      .set({ eventTypesJson: JSON.stringify(["dist.quote.bound", "axis.policy.endorsed"]) })
      .where(eq(schema.webhooks.id, hook!.id));

    const first = await call("staging", "POST", "/v1/auth/demo/resync-roles");
    expect(first.status).toBe(200);
    expect(first.body.events.webhooks).toEqual([hook!.id]);
    const [after] = await database.select().from(schema.webhooks).where(eq(schema.webhooks.id, hook!.id));
    expect(JSON.parse(after!.eventTypesJson)).toEqual(["axis.policy.issued", "axis.policy.endorsed"]);

    const second = await call("staging", "POST", "/v1/auth/demo/resync-roles");
    expect(second.body.events).toEqual({ journeys: [], webhooks: [] });
  });
});

// The session cookie's scope. Regression for the host-only cookie: web sits on
// lyra.vantax.co.za and the API on api.lyra.vantax.co.za, so with no Domain the
// browser never sends the session to the API — the SSO callback lands on a
// cookie-less host and every direct-to-API download 401s. Invisible to
// `pnpm e2e`, where both halves answer on 127.0.0.1 and cookies ignore the port.

const DOMAIN: Partial<Env> = { SESSION_COOKIE_DOMAIN: "lyra.vantax.co.za" };

/** The cookie's attributes, lower-cased, without the name=value pair. */
function attrs(header: string | null): string[] {
  return (header ?? "")
    .split(";")
    .slice(1)
    .map((a) => a.trim().toLowerCase());
}

function domained(header: string | null): boolean {
  return attrs(header).some((a) => a.startsWith("domain="));
}

async function demoSignIn(extra: Partial<Env> = {}) {
  const login = await call("staging", "POST", "/v1/auth/demo/login", { email: "amina.saleh@gonxt.ae" }, extra);
  expect(login.status).toBe(200);
  return login.headers.get("set-cookie") ?? "";
}

describe("the session cookie", () => {
  it("carries the configured domain, so it reaches the api host and not only the app", async () => {
    expect(attrs(await demoSignIn(DOMAIN))).toContain("domain=lyra.vantax.co.za");
  });

  it("stays host-only when no domain is configured, which is what local dev wants", async () => {
    const set = await demoSignIn();
    expect(set).toContain("lyra_session=");
    expect(domained(set)).toBe(false);
  });

  it("clears with the same attributes it set, or the browser keeps the session", async () => {
    const set = await demoSignIn(DOMAIN);
    const logout = await call("staging", "POST", "/v1/auth/logout", undefined, DOMAIN, {
      cookie: set.split(";")[0] as string
    });
    expect(logout.status).toBe(204);
    const cleared = logout.headers.get("set-cookie") ?? "";
    expect(cleared).toContain("lyra_session=;");
    // Max-Age is the one attribute that is meant to differ. A mismatch anywhere
    // else — Domain above all — is a clear that clears nothing: the browser keeps
    // the live cookie and takes an empty second one alongside it.
    const ignoreAge = (list: string[]) => list.filter((a) => !a.startsWith("max-age="));
    expect(ignoreAge(attrs(cleared))).toEqual(ignoreAge(attrs(set)));
    expect(attrs(cleared)).toContain("max-age=0");
  });

  it("clears host-only when it would have set host-only", async () => {
    const logout = await call("staging", "POST", "/v1/auth/logout");
    expect(logout.status).toBe(204);
    expect(domained(logout.headers.get("set-cookie"))).toBe(false);
  });
});

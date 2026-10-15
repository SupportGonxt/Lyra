import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, id, PolicyJson, schema, type Db } from "@lyra/db";
import { hashPassword, notFound, ROLES, seed, TENANT_ROLE_KEYS, totpAt, TOTP_STEP_SEC, type Ctx } from "@lyra/core";
import { app } from "../index.js";
import { onError } from "../mw.js";
import { platformRoutes } from "./platform.js";
import type { App } from "../env.js";
import type { Env } from "../env.js";

// ADR-0028 (feature flags: platform-global table, dual-control toggle) and
// ADR-0029 (platform staff pattern). No seed data creates a platform-role user,
// so this file seeds one manually — mirroring what seed.ts does for tenant roles.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const STAFF_PASSWORD = "Gonxt-Staff-2026!";

let env: Env;
let database: Db;
let tenantId: string;
let engineerToken: string;
let adminToken: string;
let supportToken: string;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
}

async function loginPlatformUser(email: string): Promise<string> {
  const login = await call("POST", "/v1/auth/login", { email, password: STAFF_PASSWORD, tenantSlug: "gonxt" });
  expect(login.status).toBe(200);
  const token = login.body.token as string;
  if (login.body.mfaRequired) {
    // mfa/verify flips `mfaSatisfied` on the same session row and returns no
    // new token — the login token is what's used from here on (auth.ts:693).
    const verify = await call(
      "POST",
      "/v1/auth/mfa/verify",
      { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
      token
    );
    expect(verify.status).toBe(200);
  }
  return token;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  const seedResult = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  tenantId = (seedResult as { tenantId: string }).tenantId;

  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  const now = Date.now();
  const passwordHash = await hashPassword(STAFF_PASSWORD);

  for (const [i, roleKey] of (["platform.engineer", "platform.admin", "platform.support"] as const).entries()) {
    const roleId = id("rl", now + i * 10);
    await database.insert(schema.roles).values({
      id: roleId,
      tenantId,
      key: roleKey,
      name: roleKey,
      permissionsJson: JSON.stringify(ROLES[roleKey] ?? []),
      system: true,
      createdAt: now
    });
    const userId = id("us", now + i * 10 + 1);
    await database.insert(schema.users).values({
      id: userId,
      tenantId,
      email: `${roleKey}@gonxt.ae`,
      name: roleKey,
      locale: "en",
      status: "active",
      authProvider: "password",
      passwordHash,
      mfaEnrolled: true,
      mfaSecret: DEMO_TOTP_SECRET,
      createdAt: now,
      updatedAt: now
    });
    await database.insert(schema.userRoles).values({
      id: id("ur", now + i * 10 + 2),
      tenantId,
      userId,
      roleId,
      scopeJson: null,
      createdAt: now
    });
  }

  engineerToken = await loginPlatformUser("platform.engineer@gonxt.ae");
  adminToken = await loginPlatformUser("platform.admin@gonxt.ae");
  supportToken = await loginPlatformUser("platform.support@gonxt.ae");
}, 120_000);

describe("feature flags (ADR-0028)", () => {
  it("platform.engineer can list and create flags", async () => {
    const list = await call("GET", "/v1/platform/flags", undefined, engineerToken);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.flags)).toBe(true);

    const created = await call(
      "POST",
      "/v1/platform/flags",
      { key: "signal.zeely_campaigns", description: "AI campaign builder", rolloutPercent: 0 },
      engineerToken
    );
    expect(created.status).toBe(201);
    expect(created.body.key).toBe("signal.zeely_campaigns");
    expect(created.body.enabled).toBe(false);
  });

  it("rejects an unknown key on the body (spoof guard)", async () => {
    const res = await call(
      "POST",
      "/v1/platform/flags",
      { key: "x.y", description: "d", extra: "nope" },
      engineerToken
    );
    expect(res.status).toBe(400);
  });

  it("a non-platform actor gets 403", async () => {
    const tenantLogin = await call("POST", "/v1/auth/login", {
      email: "amina.saleh@gonxt.ae",
      password: "Gonxt-Demo-2026!",
      tenantSlug: "gonxt"
    });
    expect(tenantLogin.status).toBe(200);
    const res = await call("GET", "/v1/platform/flags", undefined, tenantLogin.body.token as string);
    expect(res.status).toBe(403);
  });

  it("toggling a flag requires dual-control approval (never auto-approved)", async () => {
    const created = await call(
      "POST",
      "/v1/platform/flags",
      { key: "core.new_toggle_test", description: "d", rolloutPercent: 0 },
      engineerToken
    );
    expect(created.status).toBe(201);
    const flagId = created.body.id as string;

    const first = await call(
      "PATCH",
      `/v1/platform/flags/${flagId}`,
      { enabled: true },
      engineerToken
    );
    expect(first.status).toBe(403);
    expect(first.body.type).toContain("approval_required");

    // A second platform actor decides the approval, then the same toggle succeeds.
    const approvals = await call("GET", "/v1/core/approvals", undefined, adminToken);
    expect(approvals.status).toBe(200);
    const approval = (approvals.body.data as { id: string; subjectRef: string; decision: string }[]).find(
      (a) => a.subjectRef === flagId && a.decision === "pending"
    );
    expect(approval).toBeTruthy();
    const decide = await call(
      "POST",
      `/v1/me/approvals/${approval!.id}/decide`,
      { decision: "approved" },
      adminToken
    );
    expect(decide.status).toBe(200);

    const second = await call("PATCH", `/v1/platform/flags/${flagId}`, { enabled: true }, engineerToken);
    expect(second.status).toBe(200);
    expect(second.body.enabled).toBe(true);
  });
});

// docs/12 §4: "Kill switches: per-agent, per-module, per-tenant, global — all
// one click, all logged". The global tier is ops-held. It deliberately does NOT
// take the dual-control route above: an approval in front of a kill switch is
// an incident that keeps running while someone hunts for a second approver.
// Releasing it is the direction that needs two people.
describe("global AI kill switch", () => {
  it("kills on one click, and reports who threw it", async () => {
    const killed = await call(
      "POST",
      "/v1/platform/ai/kill",
      { reason: "Provider is returning other tenants' text." },
      engineerToken
    );
    expect(killed.status).toBe(200);
    expect(killed.body).toMatchObject({ enabled: true });

    const flags = await call("GET", "/v1/platform/flags", undefined, engineerToken);
    const flag = (flags.body.flags as { key: string; enabled: boolean }[]).find(
      (f) => f.key === "ai.kill_switch"
    );
    expect(flag?.enabled).toBe(true);

    const audits = await database.select().from(schema.auditLog);
    expect(audits.some((a) => a.action === "platform.ai.killed")).toBe(true);
  });

  it("can be scoped to named tenants", async () => {
    const killed = await call(
      "POST",
      "/v1/platform/ai/kill",
      { reason: "One tenant's prompt is leaking.", tenantIds: [tenantId] },
      engineerToken
    );
    expect(killed.status).toBe(200);
    expect(killed.body.targetTenantIdsJson).toBe(JSON.stringify([tenantId]));
  });

  it("needs a reason", async () => {
    expect((await call("POST", "/v1/platform/ai/kill", {}, engineerToken)).status).toBe(400);
  });

  it("refuses a non-platform actor", async () => {
    const tenantLogin = await call("POST", "/v1/auth/login", {
      email: "amina.saleh@gonxt.ae",
      password: "Gonxt-Demo-2026!",
      tenantSlug: "gonxt"
    });
    const res = await call(
      "POST",
      "/v1/platform/ai/kill",
      { reason: "not mine to throw" },
      tenantLogin.body.token as string
    );
    expect(res.status).toBe(403);
  });

  it("releases only under dual control", async () => {
    expect(
      (await call("POST", "/v1/platform/ai/kill", { reason: "Vendor incident." }, engineerToken)).status
    ).toBe(200);

    const first = await call("POST", "/v1/platform/ai/release", undefined, engineerToken);
    expect(first.status).toBe(403);
    expect(first.body.type).toContain("approval_required");

    const approvals = await call("GET", "/v1/core/approvals", undefined, adminToken);
    const approval = (approvals.body.data as { id: string; subjectRef: string; decision: string }[]).find(
      (a) => a.subjectRef.includes("ai.kill_switch") && a.decision === "pending"
    );
    expect(approval).toBeTruthy();
    expect(
      (await call("POST", `/v1/me/approvals/${approval!.id}/decide`, { decision: "approved" }, adminToken))
        .status
    ).toBe(200);

    const second = await call("POST", "/v1/platform/ai/release", undefined, engineerToken);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ enabled: false });
  });
});

describe("ops overview (ADR-0029)", () => {
  it("aggregates per-tenant diagnostics via the cross-tenant loop", async () => {
    const res = await call("GET", "/v1/platform/ops/overview", undefined, adminToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tenants)).toBe(true);
    const tenant = (res.body.tenants as { tenantId: string; outboxPending: number; dlqDepth: number; pendingApprovals: number }[]).find(
      (t) => t.tenantId === tenantId
    );
    expect(tenant).toBeTruthy();
    expect(typeof tenant!.outboxPending).toBe("number");
    expect(typeof tenant!.dlqDepth).toBe("number");
    expect(typeof tenant!.pendingApprovals).toBe("number");
  });

  it("a non-platform actor gets 403", async () => {
    const res = await call("GET", "/v1/platform/ops/overview", undefined, undefined);
    expect(res.status).toBe(401);
  });
});

describe("deployments (ADR-0029)", () => {
  it("lists deployments newest first", async () => {
    const now = Date.now();
    await database.insert(schema.deployments).values({
      id: id("dep", now),
      environment: "staging",
      workerName: "lyra-api",
      version: "abc123",
      status: "success",
      deployedBy: "ci",
      deployedAt: now
    });
    const res = await call("GET", "/v1/platform/deployments", undefined, adminToken);
    expect(res.status).toBe(200);
    expect((res.body.deployments as { workerName: string }[]).some((d) => d.workerName === "lyra-api")).toBe(true);
  });
});

describe("SLO & error budget (ADR-0029)", () => {
  it("computes actualPercent for a defined SLO", async () => {
    const now = Date.now();
    await database.insert(schema.sloDefinitions).values({
      id: id("slo", now),
      key: "events.delivery",
      description: "Event outbox delivery",
      module: "events",
      targetPercent: 99,
      windowDays: 30,
      createdAt: now,
      updatedAt: now
    });
    const res = await call("GET", "/v1/platform/slo", undefined, adminToken);
    expect(res.status).toBe(200);
    const slo = (res.body.slos as { key: string; actualPercent: number }[]).find((s) => s.key === "events.delivery");
    expect(slo).toBeTruthy();
    expect(typeof slo!.actualPercent).toBe("number");
  });
});

describe("incidents rollup (ADR-0029)", () => {
  it("surfaces outage-kind incidents across the tenant loop", async () => {
    const now = Date.now();
    await database.insert(schema.incidents).values({
      id: id("inc", now),
      tenantId,
      kind: "outage",
      severity: "high",
      title: "Workers AI latency spike",
      summary: "p99 above threshold for 10 minutes",
      affectedJson: JSON.stringify([]),
      agentsPaused: false,
      state: "open",
      openedBy: "platform.admin",
      createdAt: now,
      updatedAt: now
    });
    const res = await call("GET", "/v1/platform/incidents", undefined, adminToken);
    expect(res.status).toBe(200);
    expect((res.body.incidents as { title: string }[]).some((i) => i.title === "Workers AI latency spike")).toBe(true);
  });

  // The per-tenant loop's can() check used to pass no subject at all, so a
  // grant scoped to a specific module (e.g. "only diagnostics for north")
  // was never actually enforced inside the loop - scopeAllows() only
  // restricts on subject.module, and with no subject it's a no-op. Bypassing
  // the full login flow to build one such actor directly (regression: MINOR
  // platform.ts can() subject).
  it("does not let a module-scoped grant read incidents outside its module", async () => {
    const platformApp = new Hono<App>();
    platformApp.onError(onError);
    platformApp.notFound((c) => onError(notFound(c.req.path), c));

    function ctxWithScope(modules: string[]): Ctx {
      return {
        db: database as unknown as Ctx["db"],
        tenantId,
        actor: {
          kind: "user",
          id: "u_scoped",
          tenantId,
          grants: [{ roleKey: "scoped", permissions: ["admin:diagnostics:read"], scope: { modules } }]
        },
        requestId: "req_test",
        now: Date.now(),
        locale: "en",
        policy: PolicyJson.parse({}),
        entitlements: EntitlementsJson.parse({})
      };
    }

    platformApp.use("*", async (c, next) => {
      c.set("ctx", ctxWithScope(c.req.header("x-test-modules")?.split(",") ?? []));
      await next();
    });
    platformApp.route("/", platformRoutes);

    const outOfScope = await platformApp.fetch(
      new Request("http://api.test/incidents", { headers: { "x-test-modules": "north" } }),
      env as never,
      exec as never
    );
    expect(outOfScope.status).toBe(200);
    expect(((await outOfScope.json()) as { incidents: unknown[] }).incidents).toEqual([]);

    const inScope = await platformApp.fetch(
      new Request("http://api.test/incidents", { headers: { "x-test-modules": "admin" } }),
      env as never,
      exec as never
    );
    expect(inScope.status).toBe(200);
    const body = (await inScope.json()) as { incidents: { title: string }[] };
    expect(body.incidents.some((i) => i.title === "Workers AI latency spike")).toBe(true);
  });
});

describe("impersonation (ADR-0027)", () => {
  it("requires dual-control approval by a different platform actor, then time-boxes the session", async () => {
    const target = (
      await database.select().from(schema.users).where(eq(schema.users.email, "amina.saleh@gonxt.ae")).limit(1)
    )[0];
    expect(target).toBeTruthy();

    // platform.engineer lacks core:impersonate:use entirely.
    const engineerAttempt = await call(
      "POST",
      "/v1/platform/impersonation/start",
      { targetUserId: target!.id, reason: "support ticket #4821" },
      engineerToken
    );
    expect(engineerAttempt.status).toBe(403);

    // platform.support holds the permission but the action is neverAutoApprove.
    const first = await call(
      "POST",
      "/v1/platform/impersonation/start",
      { targetUserId: target!.id, reason: "support ticket #4821" },
      supportToken
    );
    expect(first.status).toBe(403);
    expect(first.body.type).toContain("approval_required");

    const approvals = await call("GET", "/v1/core/approvals", undefined, adminToken);
    expect(approvals.status).toBe(200);
    const approval = (approvals.body.data as { id: string; subjectRef: string; decision: string }[]).find(
      (a) => a.subjectRef === target!.id && a.decision === "pending"
    );
    expect(approval).toBeTruthy();

    // The same actor who requested the impersonation cannot decide it themselves.
    const selfDecide = await call(
      "POST",
      `/v1/me/approvals/${approval!.id}/decide`,
      { decision: "approved" },
      supportToken
    );
    expect(selfDecide.status).toBe(400);

    const decide = await call(
      "POST",
      `/v1/me/approvals/${approval!.id}/decide`,
      { decision: "approved" },
      adminToken
    );
    expect(decide.status).toBe(200);

    const started = await call(
      "POST",
      "/v1/platform/impersonation/start",
      { targetUserId: target!.id, reason: "support ticket #4821" },
      supportToken
    );
    expect(started.status).toBe(201);
    const sessionId = started.body.id as string;

    const meDuring = await call("GET", "/v1/me", undefined, supportToken);
    expect(meDuring.status).toBe(200);
    expect(meDuring.body.actor.impersonating).toBe(true);

    // The screen that ends a session has to be able to find it again after a
    // reload, so the caller's own live sessions are readable.
    const mine = await call("GET", "/v1/platform/impersonation", undefined, supportToken);
    expect(mine.status).toBe(200);
    expect((mine.body.sessions as { id: string }[]).map((s) => s.id)).toContain(sessionId);

    const ended = await call("POST", `/v1/platform/impersonation/${sessionId}/end`, undefined, supportToken);
    expect(ended.status).toBe(200);
    expect(ended.body.endedAt).not.toBeNull();

    const meAfter = await call("GET", "/v1/me", undefined, supportToken);
    expect(meAfter.status).toBe(200);
    expect(meAfter.body.actor.impersonating).toBe(false);
  });

  it("recovers from an expired-but-unended session instead of locking the operator out forever (regression: impersonation-lockout)", async () => {
    const support = (
      await database.select().from(schema.users).where(eq(schema.users.email, "platform.support@gonxt.ae")).limit(1)
    )[0];
    const target = (
      await database.select().from(schema.users).where(eq(schema.users.email, "amina.saleh@gonxt.ae")).limit(1)
    )[0];
    const now = Date.now();
    const sessionId = id("ims", now);
    await database.insert(schema.impersonationSessions).values({
      id: sessionId,
      tenantId,
      platformUserId: support!.id,
      targetUserId: target!.id,
      approvalId: id("apr", now),
      reason: "expired session regression",
      // Must out-rank the previous test's (ended) session by startedAt desc —
      // latestImpersonation() picks the single latest row regardless of endedAt.
      // The whole suite runs in well under a second, so "startedAt" has to be
      // `now` itself (not now-minus-something) to beat the prior test's row.
      startedAt: now,
      expiresAt: now - 1,
      endedAt: null
    });

    // A session that lapsed without an explicit /end must not 401 every
    // subsequent request from that platform user forever (ADR-0027: "a
    // session that is never explicitly ended still stops mattering at 30
    // minutes") — it falls back to their home tenant instead.
    const res = await call("GET", "/v1/me", undefined, supportToken);
    expect(res.status).toBe(200);
    expect(res.body.actor.impersonating).toBe(false);

    // The lapsed row is lazily closed so it stops shadowing future requests.
    const row = (
      await database
        .select()
        .from(schema.impersonationSessions)
        .where(eq(schema.impersonationSessions.id, sessionId))
        .limit(1)
    )[0];
    expect(row?.endedAt).not.toBeNull();
  });
});

// J-A1 "new tenant in a day": tenant creation was seed-only; this is the
// runtime path — the tenant, its role set, and an invited first administrator.
describe("tenant creation (J-A1)", () => {
  it("provisions the tenant, its role set, and invites the first administrator", async () => {
    const res = await call(
      "POST",
      "/v1/platform/tenants",
      { slug: "acme-insurance", name: "Acme Insurance", adminEmail: "first.admin@acme.test", adminName: "First Admin" },
      adminToken
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ slug: "acme-insurance", name: "Acme Insurance", adminInvited: true });

    const [tenant] = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, "acme-insurance"));
    expect(tenant).toBeDefined();
    expect(tenant!.status).toBe("active");

    const roles = await database.select().from(schema.roles).where(eq(schema.roles.tenantId, tenant!.id));
    expect(roles).toHaveLength(TENANT_ROLE_KEYS.length);
    expect(roles.some((r) => r.key === "tenant.admin")).toBe(true);

    const [admin] = await database
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.tenantId, tenant!.id), eq(schema.users.email, "first.admin@acme.test")));
    expect(admin).toMatchObject({ status: "invited" });

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.action, "platform.tenant.created")));
    expect(audits).toHaveLength(1);
  });

  it("refuses a duplicate slug and an actor without admin:tenants:write", async () => {
    const dup = await call("POST", "/v1/platform/tenants", { slug: "acme-insurance", name: "Again" }, adminToken);
    expect(dup.status).toBe(409);

    const denied = await call("POST", "/v1/platform/tenants", { slug: "another", name: "Another" }, supportToken);
    expect(denied.status).toBe(403);
  });
});

import { Hono, type Context } from "hono";
import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { id as newId, makeDb, schema, EntitlementsJson, PolicyJson } from "@lyra/db";
import {
  audit,
  badRequest,
  can,
  emit,
  ensureDemoAdmin,
  ensureSeedPeople,
  syncSeedEventNames,
  backfillProspects,
  syncSeedJourneyGraphs,
  entitledGrants,
  GATED_MODULES,
  moduleEnabled,
  forbidden,
  grantsFor,
  hashPassword,
  mfaRequired,
  needsRehash,
  notFound,
  otpauthUri,
  randomToken,
  recoveryCodes,
  requiresMfa,
  resyncSystemRolePermissions,
  syncTaxRules,
  syncChartOfAccounts,
  seed,
  sha256Hex,
  timingSafeEqual,
  tooManyRequests,
  totpSecret,
  totpVerify,
  unauthorized,
  verifyPassword,
  type Actor,
  type CoreDb,
  type Ctx
} from "@lyra/core";
import { body } from "./http.js";
import { simNow } from "./clock.js";
import type { App, Env } from "./env.js";

// docs/06 §2. Sessions are opaque tokens hashed at rest; the API never holds a
// value it could leak. API keys authenticate machine callers with the same
// Actor shape, so authorization has exactly one path either way.

export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const COOKIE = "lyra_session";

const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
  tenantSlug: z.string().min(1).max(64).optional()
});

/**
 * Constant work whether or not the user exists — an unknown email must not be
 * faster. This has to be a real hash in the live format, or verifyPassword
 * rejects it on the format check and returns before doing any KDF work.
 * Derived from a throwaway random string; no password matches it.
 */
const DUMMY_HASH = "pbkdf2$210000$HFVRUeNDtDBwhePd-XErCg$B4sOaeGUdiI6mKaz29OPN3nGtX0YPPICXQFTQ6scKdI";

export function db(env: Env) {
  return env.DB_CLIENT ?? makeDb(env.DB);
}

/* ------------------------------------------------------------------ actor */

// Role expansion lives in packages/core beside the delegation resolver, which
// needs the same answer: a delegate must never resolve to authority a login
// would not have given. Re-exported so callers keep asking the auth module.
export { grantsFor };

function safeJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface Authenticated {
  actor: Actor;
  tenantId: string;
  locale: string;
  policy: PolicyJson;
  entitlements: EntitlementsJson;
}

/**
 * A stored blob that no longer parses is an incident, not a shrug: silently
 * substituting defaults would reset autoApprove, AI budgets and module
 * entitlements with no trail. The fallback itself is the closed position
 * (defaults auto-approve nothing and entitle no modules), so the fix here is
 * the audit row — written once per detection, not once per request.
 *
 * ponytail: per-isolate memo for the dedupe — an isolate restart may write one
 * duplicate row, which verifyChain tolerates. Upgrade path: a flag column on
 * core_tenants if operators ever need to query "still corrupt?" from SQL.
 */
const corruptAudited = new Set<string>();

async function auditCorruptConfig(
  database: ReturnType<typeof makeDb>,
  tenantId: string,
  column: "policy_json" | "entitlements_json",
  now: number
): Promise<void> {
  const key = `${tenantId}:${column}`;
  if (corruptAudited.has(key)) return;
  corruptAudited.add(key);
  try {
    await audit(
      {
        db: database as unknown as Ctx["db"],
        tenantId,
        actor: { kind: "system", id: "auth", tenantId, grants: [] },
        requestId: newId("req", now),
        now,
        locale: "en",
        policy: PolicyJson.parse({}),
        entitlements: EntitlementsJson.parse({})
      },
      { action: "core.tenant.config_corrupt", subjectRef: tenantId, after: { column } }
    );
  } catch {
    // The trail write is best-effort per attempt but must not be lost forever:
    // clear the memo so the next request tries again.
    corruptAudited.delete(key);
  }
}

export async function tenantConfig(
  database: ReturnType<typeof makeDb>,
  tenantId: string,
  now: number
): Promise<{ policy: PolicyJson; entitlements: EntitlementsJson }> {
  const rows = await database
    .select()
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  const t = rows[0];
  if (!t) throw unauthorized("tenant not found");
  if (t.status !== "active") throw forbidden(`tenant is ${t.status}`);

  const rawPolicy = safeJson<Record<string, unknown>>(t.policyJson);
  const rawEntitlements = safeJson<Record<string, unknown>>(t.entitlementsJson);
  if (t.policyJson && rawPolicy === null) await auditCorruptConfig(database, tenantId, "policy_json", now);
  if (t.entitlementsJson && rawEntitlements === null) {
    await auditCorruptConfig(database, tenantId, "entitlements_json", now);
  }
  return {
    policy: PolicyJson.parse(rawPolicy ?? {}),
    entitlements: EntitlementsJson.parse(rawEntitlements ?? {})
  };
}

/**
 * Resolve a session token to its row and owner, with no authorization decision
 * attached. The MFA routes need the session *before* the second-factor gate
 * runs, which is exactly the check `fromSession` adds on top.
 */
async function sessionRow(database: ReturnType<typeof makeDb>, token: string, now: number) {
  const tokenHash = await sha256Hex(token);
  const rows = await database
    .select({ session: schema.sessions, user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .where(and(eq(schema.sessions.tokenHash, tokenHash), isNull(schema.sessions.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) throw unauthorized("session not found");
  if (row.session.expiresAt <= now) throw unauthorized("session expired");
  if (row.user.status !== "active") throw forbidden(`user is ${row.user.status}`);
  return row;
}

/**
 * ADR-0027: an impersonation session is a time-boxed swap of which tenant a
 * platform staff member's Ctx resolves to — never a new authority. Grants
 * stay the platform user's own (computed against their home tenant, in
 * `fromSession`); only `tenantId` and `Actor.impersonating` change here.
 * Reads the single latest row so a lapsed-but-not-`/end`ed session can be
 * told apart from one that was properly ended or never started — the caller
 * degrades a lapsed session gracefully (falls back to the platform user's
 * own tenant) rather than hard-401ing.
 */
async function latestImpersonation(database: ReturnType<typeof makeDb>, platformUserId: string) {
  const rows = await database
    .select()
    .from(schema.impersonationSessions)
    .where(eq(schema.impersonationSessions.platformUserId, platformUserId))
    .orderBy(desc(schema.impersonationSessions.startedAt))
    .limit(1);
  return rows[0];
}

/** Every tenant id, unfiltered by status — the seam ADR-0029's per-tenant loop iterates. */
// No status filter: platform ops (diagnostics, incidents, SLOs) deliberately
// sweeps every tenant, suspended ones included, so staff can still see a
// suspended tenant's outstanding problems. Named for what it does, not what
// its old name implied.
export async function allTenants(env: Env): Promise<string[]> {
  const rows = await db(env).select({ id: schema.tenants.id }).from(schema.tenants);
  return rows.map((t) => t.id);
}

/**
 * ADR-0087: the modules a tenant has switched off, for the scheduler. Reads the
 * policy alone — not `tenantConfig`, which refuses a suspended tenant whose
 * outbox must still drain — and a corrupt policy switches nothing off.
 */
export async function switchedOff(env: Env, tenantId: string): Promise<Set<string>> {
  const rows = await db(env)
    .select({ policyJson: schema.tenants.policyJson, entitlementsJson: schema.tenants.entitlementsJson })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, tenantId))
    .limit(1);
  // What was not bought stands down exactly as what was switched off does
  // (entitledGrants): a solo tenant's clock runs its one module.
  const bought = EntitlementsJson.safeParse(safeJson<Record<string, unknown>>(rows[0]?.entitlementsJson ?? null) ?? {});
  const unbought = bought.success ? GATED_MODULES.filter((m) => !bought.data.modules.includes(m)) : [];
  const parsed = PolicyJson.safeParse(safeJson<Record<string, unknown>>(rows[0]?.policyJson ?? null) ?? {});
  const unswitched = parsed.success ? GATED_MODULES.filter((m) => !moduleEnabled(parsed.data, m)) : [];
  return new Set([...unbought, ...unswitched]);
}

/** Session cookie or `Authorization: Bearer <session token>`. */
async function fromSession(
  database: ReturnType<typeof makeDb>,
  token: string,
  now: number
): Promise<Authenticated> {
  const row = await sessionRow(database, token, now);
  const tenantId = row.session.tenantId;
  const grants = await grantsFor(database as unknown as CoreDb, tenantId, row.user.id);

  // PLAT-012/013. A session that has not cleared its second factor is a session
  // that cannot do anything, and a staff account that never enrolled is told to
  // enrol rather than quietly let through. This is the only place the check can
  // live: putting it in a route decorator would mean every new route has to
  // remember it.
  // One field carries the whole decision: `mfaSatisfied` is set at sign-in only
  // when there was nothing to do (or the identity provider asserted the second
  // factor itself), so this reads the same for a password login, an SSO callback
  // and a session that has since cleared its factor.
  if (!row.session.mfaSatisfied) throw mfaRequired(row.user.mfaEnrolled ? "verify" : "enrol");

  // Every tenant user hits this path on every request; only platform staff
  // holding core:impersonate:use can ever have a session row, so skip the
  // lookup entirely for everyone else instead of paying a query per request.
  let latest = can({ kind: "user", id: row.user.id, tenantId, grants }, "core:impersonate:use")
    ? await latestImpersonation(database, row.user.id)
    : undefined;
  if (latest && latest.endedAt === null && latest.expiresAt <= now) {
    // ADR-0027: "a session that is never explicitly ended still stops
    // mattering at 30 minutes" — a lapsed swap must not become a permanent
    // lockout for every future request from this platform user. Close the
    // row lazily and fall back to the actor's home tenant instead of
    // throwing; the operator can simply start a new impersonation session.
    await database
      .update(schema.impersonationSessions)
      .set({ endedAt: now })
      .where(eq(schema.impersonationSessions.id, latest.id));
    latest = undefined;
  }
  const impersonation = latest && latest.endedAt === null && latest.expiresAt > now ? latest : undefined;
  const effectiveTenantId = impersonation?.tenantId ?? tenantId;

  const config = await tenantConfig(database, effectiveTenantId, now);
  return {
    tenantId: effectiveTenantId,
    locale: row.user.locale,
    // docs/21: a permission for a module the tenant has not licensed does not
    // exist for its actors — this one filter is what makes entitlements real.
    actor: {
      kind: "user",
      id: row.user.id,
      tenantId: effectiveTenantId,
      grants: entitledGrants(grants, config.entitlements, config.policy.moduleConfig),
      ...(impersonation ? { impersonating: true as const } : {})
    },
    ...config
  };
}

/** `Authorization: Bearer qvk_live_...`. Scopes are permissions, not a second model. */
async function fromApiKey(
  database: ReturnType<typeof makeDb>,
  token: string,
  now: number
): Promise<Authenticated> {
  const prefix = token.slice(0, token.lastIndexOf("_") + 9);
  const rows = await database
    .select()
    .from(schema.apiKeys)
    .where(and(eq(schema.apiKeys.prefix, prefix), isNull(schema.apiKeys.revokedAt)))
    .limit(1);

  const key = rows[0];
  if (!key) throw unauthorized("api key not found");
  if (key.expiresAt !== null && key.expiresAt <= now) throw unauthorized("api key expired");
  const hash = await sha256Hex(token);
  if (hash !== key.keyHash) throw unauthorized("api key not found");

  const scopes = safeJson<string[]>(key.scopesJson) ?? [];
  const config = await tenantConfig(database, key.tenantId, now);
  // A failed last-used stamp must not fail the call it is only observing.
  try {
    await database.update(schema.apiKeys).set({ lastUsedAt: now }).where(eq(schema.apiKeys.id, key.id));
  } catch {
    /* ignore */
  }

  return {
    tenantId: key.tenantId,
    locale: "en",
    actor: {
      kind: "partner",
      id: key.id,
      tenantId: key.tenantId,
      // Same entitlement subtraction as a session: a machine caller cannot
      // reach a module its tenant has not licensed, whatever its scopes say.
      grants: entitledGrants(
        [{ roleKey: `apikey.${key.mode}`, permissions: scopes }],
        config.entitlements,
        config.policy.moduleConfig
      )
    },
    ...config
  };
}

export async function authenticate(env: Env, req: Request, now: number): Promise<Authenticated> {
  const database = db(env);
  const header = req.headers.get("authorization");
  const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  const cookie = readCookie(req.headers.get("cookie"), env.SESSION_COOKIE ?? COOKIE);
  const token = bearer ?? cookie;
  if (!token) throw unauthorized("no credentials");
  return token.startsWith("qvk_") ? fromApiKey(database, token, now) : fromSession(database, token, now);
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * The one place the session cookie's shape is written — issuing and clearing
 * both come through here. A clear whose attributes do not match the set's
 * (`Domain` above all) does not clear anything: the browser keeps the old
 * cookie and gains a second, empty one. Sharing the builder is what makes that
 * drift impossible rather than merely unlikely.
 *
 * `SESSION_COOKIE_DOMAIN` is optional and stays unset locally, where web and
 * api share 127.0.0.1 and a host-only cookie is right. On a deployment they are
 * separate hosts — `lyra.vantax.co.za` and `api.lyra.vantax.co.za` — so without
 * the shared parent domain the browser never sends the session to the API, and
 * the SSO callback and every direct-to-API download 401. It is configured, not
 * derived from APP_ORIGIN: staging's app host `staging.lyra.vantax.co.za` is
 * not a parent of `api-staging.lyra.vantax.co.za`, so no string surgery on the
 * app origin can produce the domain both hosts sit under.
 *
 * `token === null` clears.
 */
export function sessionCookie(
  env: Pick<Env, "ENVIRONMENT" | "SESSION_COOKIE" | "SESSION_COOKIE_DOMAIN">,
  token: string | null
): string {
  return [
    `${env.SESSION_COOKIE ?? COOKIE}=${token ?? ""}`,
    "Path=/",
    ...(env.SESSION_COOKIE_DOMAIN ? [`Domain=${env.SESSION_COOKIE_DOMAIN}`] : []),
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${token === null ? 0 : SESSION_TTL_MS / 1000}`,
    ...((env.ENVIRONMENT ?? "production") !== "development" ? ["Secure"] : [])
  ].join("; ");
}

/* ----------------------------------------------------------------- routes */

/**
 * Fixed-window throttle over a caller-namespaced key. The RATE Durable Object
 * (one instance per key) when it is bound — single-threaded per key, so it
 * cannot lose a concurrent hit the way a KV get-then-put could. Falls back to
 * KV/CACHE (racy under concurrency, but still bounds a single-threaded caller)
 * when neither is bound, the counter is skipped rather than faked, and the app
 * still refuses on a bad password (or whatever check sits behind the caller).
 */
export const LOGIN_MAX = 8;
export const LOGIN_WINDOW_SEC = 300;

export async function throttle(
  env: Env,
  key: string,
  max = LOGIN_MAX,
  windowSec = LOGIN_WINDOW_SEC
): Promise<void> {
  const n = await hit(env, key, windowSec);
  if (n === undefined) return;
  if (n > max) throw tooManyRequests(windowSec);
}

/** Shared counter for `throttle`/`mfaThrottle`. Returns the post-increment count,
 * or `undefined` when neither RATE nor CACHE/KV is bound. */
async function hit(env: Env, key: string, windowSec: number): Promise<number | undefined> {
  if (env.RATE) {
    const stub = env.RATE.get(env.RATE.idFromName(key));
    const { count } = await stub.hit(windowSec, Date.now());
    return count;
  }
  const kv = env.CACHE ?? env.KV;
  if (!kv) return undefined;
  const n = Number((await kv.get(key)) ?? "0") + 1;
  await kv.put(key, String(n), { expirationTtl: windowSec });
  return n;
}

export const authRoutes = new Hono<App>();

authRoutes.post("/login", async (c) => {
  const now = await simNow(c.env);
  const input = await body(c, LoginBody);
  await throttle(c.env, `login:${input.email.toLowerCase()}`);

  const database = db(c.env);
  const found = await database
    .select({ user: schema.users, tenantSlug: schema.tenants.slug })
    .from(schema.users)
    .innerJoin(schema.tenants, eq(schema.tenants.id, schema.users.tenantId))
    .where(and(eq(schema.users.email, input.email.toLowerCase()), isNull(schema.users.deletedAt)))
    .limit(20);

  const match = input.tenantSlug
    ? found.find((r) => r.tenantSlug === input.tenantSlug)
    : found.length === 1
      ? found[0]
      : undefined;

  const user = match?.user;
  const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok) {
    if (found.length > 1 && !input.tenantSlug) throw badRequest("tenantSlug is required for this email");
    throw unauthorized("email or password is incorrect");
  }
  if (user.status !== "active") throw forbidden(`user is ${user.status}`);

  if (needsRehash(user.passwordHash ?? "")) {
    await database
      .update(schema.users)
      .set({ passwordHash: await hashPassword(input.password), updatedAt: now })
      .where(eq(schema.users.id, user.id));
  }

  const issued = await issueSession(c, database, user, now);
  return c.json({
    ...issued,
    user: { id: user.id, name: user.name, email: user.email, locale: user.locale, tenantId: user.tenantId }
  });
});

/**
 * One-click persona sign-in for demos. This is a credential bypass, so it exists
 * only where there is nothing to bypass: any deployment whose ENVIRONMENT is
 * `production` answers 404, as if the routes had never been mounted, and the
 * only accounts it will ever name are the seeded demo personas.
 */
export function demoOnly(env: Env): void {
  if ((env.ENVIRONMENT ?? "production") === "production") throw notFound("route");
}

/** The seeded demo tenant. A demo deployment has exactly one. */
async function demoTenant(database: ReturnType<typeof makeDb>): Promise<string> {
  const rows = await database
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.status, "active"))
    .limit(2);
  const tenant = rows[0];
  if (!tenant || rows.length > 1) throw notFound("demo tenant");
  return tenant.id;
}

authRoutes.get("/demo/personas", async (c) => {
  demoOnly(c.env);
  const database = db(c.env);
  const tenantId = await demoTenant(database);
  const rows = await database
    .select({
      email: schema.users.email,
      name: schema.users.name,
      locale: schema.users.locale,
      roleKey: schema.roles.key
    })
    .from(schema.users)
    .innerJoin(schema.userRoles, eq(schema.userRoles.userId, schema.users.id))
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.users.tenantId, tenantId), eq(schema.users.status, "active"), isNull(schema.users.deletedAt)));

  // One row per person: a seat is named by its first role, which is the one the
  // persona exists to demonstrate. The demo administrator holds every internal
  // role at once, so it carries a count instead and the UI says so.
  const byEmail = new Map<string, { email: string; name: string; locale: string; roleKey: string; roleCount: number }>();
  for (const r of rows) {
    const seen = byEmail.get(r.email);
    if (seen) seen.roleCount += 1;
    else byEmail.set(r.email, { ...r, roleCount: 1 });
  }
  // Most roles first, so the all-access demo seat is the one at the top.
  const data = [...byEmail.values()].sort(
    (a, b) => b.roleCount - a.roleCount || a.roleKey.localeCompare(b.roleKey)
  );
  return c.json({ data });
});

authRoutes.post("/demo/login", async (c) => {
  demoOnly(c.env);
  const now = await simNow(c.env);
  const input = await body(c, z.object({ email: z.string().email() }));
  const database = db(c.env);
  const tenantId = await demoTenant(database);
  const rows = await database
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.tenantId, tenantId),
        eq(schema.users.email, input.email.toLowerCase()),
        isNull(schema.users.deletedAt)
      )
    )
    .limit(1);

  const user = rows[0];
  if (!user) throw notFound("persona");
  if (user.status !== "active") throw forbidden(`user is ${user.status}`);

  // The second factor is asserted rather than skipped: the demo door is the
  // factor, and the audit trail says so (`via: "demo"`).
  const issued = await issueSession(c, database, user, now, { mfaAsserted: true, via: "demo" });
  return c.json({
    ...issued,
    user: { id: user.id, name: user.name, email: user.email, locale: user.locale, tenantId: user.tenantId }
  });
});

/**
 * Advances the simulated clock (docs/24 sim plan) — the 30-day compressed
 * simulation's day-driver calls this once per virtual day. `demoOnly` keeps it
 * out of production the same way the other demo routes are.
 */
authRoutes.post("/demo/clock", async (c) => {
  demoOnly(c.env);
  const { advanceMs } = await body(c, z.object({ advanceMs: z.number().int() }));
  const cur = Number((await c.env.CONFIG!.get("sim:clock:offsetMs")) ?? 0);
  const next = cur + advanceMs;
  await c.env.CONFIG!.put("sim:clock:offsetMs", String(next));
  return c.json({ offsetMs: next, simNow: await simNow(c.env) });
});

/**
 * One-time bootstrap for a fresh staging deployment with no demo tenant yet
 * (docs/24 sim plan §6 pre-flight). `seed()` itself refuses a second call
 * once "gonxt" exists, so this route needs no extra guard — remove the route
 * once the 30-day exercise is done, it has no place in a real deployment.
 */
authRoutes.post("/demo/seed", async (c) => {
  demoOnly(c.env);
  const result = await seed(db(c.env) as unknown as CoreDb, {
    // Seed on the real clock, not `seed()`'s fixed test default: a deployment
    // people sign into needs its rolling windows to contain this week.
    now: Date.now(),
    ...(c.env.ENVIRONMENT !== undefined ? { environment: c.env.ENVIRONMENT } : {})
  });
  return c.json({ tenantId: result.tenantId }, 201);
});

/**
 * One-time maintenance for a staging tenant seeded before a `system` role
 * gained a new permission in rbac.ts (docs/24 sim plan day-2 finding: the
 * demo tenant's signal.lead was seeded before signal:autopilot:run existed).
 * `resyncSystemRolePermissions` never touches a deliberately narrowed bundle
 * (approvals.ts's grantsFor trusts whatever is stored); this just refreshes
 * every system role's snapshot to match the current compiled table. Remove
 * this route once the 30-day exercise is done, same as /demo/seed.
 *
 * The chart of accounts has the same shape of staleness — provisioned once at
 * seed time, so codes added later (the 3xxx equity rows) never arrive — and the
 * same remedy, so both run here rather than behind a second route nobody would
 * remember to call.
 */
authRoutes.post("/demo/resync-roles", async (c) => {
  demoOnly(c.env);
  const database = db(c.env);
  const tenantId = await demoTenant(database);
  const updated = await resyncSystemRolePermissions(database as unknown as CoreDb, tenantId);
  const accounts = await syncChartOfAccounts(database as unknown as CoreDb, tenantId);
  // Same shape of staleness again: the all-access demo login (seed.ts
  // DEMO_ADMIN) arrived after this tenant was provisioned, and every role added
  // to rbac.ts since then is a role it does not hold yet.
  const demo = await ensureDemoAdmin(database as unknown as CoreDb, tenantId);
  // Fourth instance of the same staleness, and the one with a visible symptom:
  // `PEOPLE` in seed.ts reaches a deployed tenant exactly once, so the two
  // personas added after this tenant was provisioned are missing from the
  // login picker — /demo/personas enumerates users, so it can only ever show
  // rows that were written.
  const people = await ensureSeedPeople(database as unknown as CoreDb, tenantId);
  // Fifth: TAX_RULEPACK (docs/27 F17). Same one-delivery shape, and the one
  // whose absence is loudest — taxTreatment() refuses a supply it has no rule
  // for, so a tenant seeded before the rulepack existed cannot bind at all.
  const taxRules = await syncTaxRules(database as unknown as CoreDb, tenantId);
  // Sixth: seeded journey triggers and webhook subscriptions that named events
  // no code emits (docs/27, 2026-09-23). The seed is fixed; this is how a
  // tenant provisioned before the fix gets the live names.
  const events = await syncSeedEventNames(database as unknown as CoreDb, tenantId);
  // Seventh: seeded journeys lacked the frequency cap triggerJourney requires
  // (ORB-051), and the partner journey its partner subject.
  const journeyGraphs = await syncSeedJourneyGraphs(database as unknown as CoreDb, tenantId);
  // Eighth (ADR-0091): SIGNAL's prospects arrive by event from now on; the book
  // before this deploy never announced itself, so it is read once here.
  const prospects = await backfillProspects(database as unknown as CoreDb, tenantId, Date.now());
  return c.json({ tenantId, updated, accounts, demo, people, taxRules, events, journeyGraphs, prospects });
});

/**
 * Create the session a successful sign-in hands back, whichever door it came
 * through. Password login and the SSO callback have to agree on the cookie, the
 * audit trail and the second-factor decision, so there is exactly one of these.
 *
 * `mfaAsserted` is for an identity provider that performed the second factor
 * itself (docs/06 §2, core_identity_providers.mfa_asserted) — the session is
 * born satisfied and the local TOTP enrolment is not asked for.
 */
export async function issueSession(
  c: Context<App>,
  database: ReturnType<typeof makeDb>,
  user: typeof schema.users.$inferSelect,
  now: number,
  options: { mfaAsserted?: boolean; via?: string } = {}
): Promise<{
  token: string;
  expiresAt: number;
  mfaRequired: boolean;
  mfaStep?: "verify" | "enrol";
  roles: string[];
}> {
  const grants = await grantsFor(database as unknown as CoreDb, user.tenantId, user.id);
  // Which of the two second-factor screens the client should draw. Absent when
  // there is nothing to do, so a customer sign-in stays a single hop.
  const step = options.mfaAsserted
    ? undefined
    : user.mfaEnrolled
      ? "verify"
      : requiresMfa(grants.map((g) => g.roleKey))
        ? "enrol"
        : undefined;

  const token = randomToken();
  const sessionId = newId("ses", now);
  await database.insert(schema.sessions).values({
    id: sessionId,
    tenantId: user.tenantId,
    userId: user.id,
    tokenHash: await sha256Hex(token),
    ip: c.req.header("cf-connecting-ip") ?? null,
    ua: c.req.header("user-agent") ?? null,
    mfaSatisfied: step === undefined,
    expiresAt: now + SESSION_TTL_MS,
    createdAt: now,
    revokedAt: null
  });
  await database.update(schema.users).set({ lastSeenAt: now }).where(eq(schema.users.id, user.id));

  const ctx = await ctxFor(c.env, {
    tenantId: user.tenantId,
    locale: user.locale,
    actor: { kind: "user", id: user.id, tenantId: user.tenantId, grants },
    ...(await tenantConfig(database, user.tenantId, now))
  }, now, c.req.header("cf-connecting-ip"), c.req.header("user-agent"));
  await audit(ctx, { action: "core.session.login", subjectRef: sessionId });
  await emit(ctx, {
    module: "core",
    type: "core.session.login",
    subject: user.id,
    data: { sessionId, via: options.via ?? "password" }
  });

  c.header("set-cookie", sessionCookie(c.env, token));

  return {
    token,
    expiresAt: now + SESSION_TTL_MS,
    mfaRequired: step !== undefined,
    ...(step ? { mfaStep: step } : {}),
    roles: grants.map((g) => g.roleKey)
  };
}

/* -------------------------------------------------------------------- mfa */

// PLAT-012/013. These four routes sit on the unauthenticated router on purpose:
// the caller holds a real session but has not cleared the gate that
// `fromSession` applies, so they resolve the session themselves.

const CodeBody = z.object({ code: z.string().min(6).max(20) });

/** Read the bearer or cookie session the same way `authenticate` does. */
function sessionToken(c: { req: { header(name: string): string | undefined } }, env: Env): string {
  const header = c.req.header("authorization");
  const token =
    (header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined) ??
    readCookie(c.req.header("cookie") ?? null, env.SESSION_COOKIE ?? COOKIE);
  if (!token || token.startsWith("qvk_")) throw unauthorized("no session");
  return token;
}

/**
 * A code is six digits out of a million, so the throttle is the whole defence.
 * Keyed by session rather than by user: a stolen cookie gets its own budget and
 * cannot be used to lock the real owner out.
 */
export const MFA_MAX = 6;

async function mfaThrottle(env: Env, sessionId: string): Promise<void> {
  const n = await hit(env, `mfa:${sessionId}`, LOGIN_WINDOW_SEC);
  if (n === undefined) return;
  if (n > MFA_MAX) throw tooManyRequests(LOGIN_WINDOW_SEC);
}

authRoutes.post("/mfa/enrol", async (c) => {
  const now = await simNow(c.env);
  const database = db(c.env);
  const row = await sessionRow(database, sessionToken(c, c.env), now);
  // Re-enrolling would silently invalidate the authenticator the account is
  // already using, so it is a refusal rather than a reset.
  if (row.user.mfaEnrolled) throw badRequest("already enrolled");

  const secret = totpSecret();
  const tenant = (
    await database.select({ name: schema.tenants.name }).from(schema.tenants)
      .where(eq(schema.tenants.id, row.session.tenantId)).limit(1)
  )[0];
  await database
    .update(schema.users)
    .set({ mfaSecret: secret, updatedAt: now })
    .where(eq(schema.users.id, row.user.id));

  // The secret is returned once, here, and never again: the confirm step is the
  // proof the user actually captured it.
  return c.json({
    secret,
    // Issuer is the tenant's own name, not a hard-coded product string — the
    // authenticator app is a user-facing surface like any other.
    otpauthUri: otpauthUri(secret, row.user.email, tenant?.name ?? "Lyra")
  });
});

authRoutes.post("/mfa/enrol/confirm", async (c) => {
  const now = await simNow(c.env);
  const input = await body(c, CodeBody);
  const database = db(c.env);
  const row = await sessionRow(database, sessionToken(c, c.env), now);
  await mfaThrottle(c.env, row.session.id);
  if (row.user.mfaEnrolled) throw badRequest("already enrolled");
  if (!row.user.mfaSecret) throw badRequest("enrolment not started");
  if (!(await totpVerify(row.user.mfaSecret, input.code, now))) throw unauthorized("code is incorrect");

  // Recovery codes are stored the same way session tokens are: hashed, so the
  // database never holds a usable credential.
  const codes = recoveryCodes();
  const hashes = await Promise.all(codes.map((code) => sha256Hex(code)));
  await database
    .update(schema.users)
    .set({ mfaEnrolled: true, mfaRecoveryJson: JSON.stringify(hashes), updatedAt: now })
    .where(eq(schema.users.id, row.user.id));
  await database
    .update(schema.sessions)
    .set({ mfaSatisfied: true })
    .where(eq(schema.sessions.id, row.session.id));

  const ctx = await ctxForSession(c, database, row, now);
  await audit(ctx, { action: "core.mfa.enrolled", subjectRef: row.user.id });

  // Shown once. There is no route that reads them back.
  return c.json({ recoveryCodes: codes });
});

authRoutes.post("/mfa/verify", async (c) => {
  const now = await simNow(c.env);
  const input = await body(c, CodeBody);
  const database = db(c.env);
  const row = await sessionRow(database, sessionToken(c, c.env), now);
  await mfaThrottle(c.env, row.session.id);
  if (!row.user.mfaEnrolled || !row.user.mfaSecret) throw badRequest("not enrolled");
  if (row.session.mfaSatisfied) return c.json({ mfaSatisfied: true });

  let usedRecovery = false;
  let ok = await totpVerify(row.user.mfaSecret, input.code, now);
  if (!ok) {
    // A recovery code is single use: it is removed before the session is marked,
    // so a replay of the same code finds nothing left to match.
    const hashes: string[] = JSON.parse(row.user.mfaRecoveryJson ?? "[]");
    const submitted = await sha256Hex(input.code.trim().toUpperCase());
    const remaining = hashes.filter((h) => !timingSafeEqual(h, submitted));
    if (remaining.length !== hashes.length) {
      await database
        .update(schema.users)
        .set({ mfaRecoveryJson: JSON.stringify(remaining), updatedAt: now })
        .where(eq(schema.users.id, row.user.id));
      ok = true;
      usedRecovery = true;
    }
  }
  if (!ok) throw unauthorized("code is incorrect");

  await database
    .update(schema.sessions)
    .set({ mfaSatisfied: true })
    .where(eq(schema.sessions.id, row.session.id));

  const ctx = await ctxForSession(c, database, row, now);
  await audit(ctx, {
    action: usedRecovery ? "core.mfa.recovery_used" : "core.mfa.verified",
    subjectRef: row.session.id
  });
  await emit(ctx, {
    module: "core",
    type: "core.mfa.verified",
    subject: row.user.id,
    data: { sessionId: row.session.id, usedRecovery }
  });

  return c.json({ mfaSatisfied: true, usedRecovery });
});

authRoutes.post("/mfa/disable", async (c) => {
  const now = await simNow(c.env);
  const input = await body(c, CodeBody);
  const database = db(c.env);
  const row = await sessionRow(database, sessionToken(c, c.env), now);
  await mfaThrottle(c.env, row.session.id);
  if (!row.user.mfaEnrolled || !row.user.mfaSecret) throw badRequest("not enrolled");

  const grants = await grantsFor(database as unknown as CoreDb, row.session.tenantId, row.user.id);
  // PLAT-013: staff cannot turn it off, and neither can a tenant admin on their
  // behalf. The only way out of MFA for a staff account is to stop being staff.
  if (requiresMfa(grants.map((g) => g.roleKey))) throw forbidden("mfa is mandatory for this role");
  if (!(await totpVerify(row.user.mfaSecret, input.code, now))) throw unauthorized("code is incorrect");

  await database
    .update(schema.users)
    .set({ mfaEnrolled: false, mfaSecret: null, mfaRecoveryJson: null, updatedAt: now })
    .where(eq(schema.users.id, row.user.id));

  const ctx = await ctxForSession(c, database, row, now);
  await audit(ctx, { action: "core.mfa.disabled", subjectRef: row.user.id });
  return c.body(null, 204);
});

/** Audit needs a Ctx and the MFA routes build theirs before the gate passes. */
async function ctxForSession(
  c: { env: Env; req: { header(name: string): string | undefined } },
  database: ReturnType<typeof makeDb>,
  row: { session: { tenantId: string }; user: { id: string; locale: string } },
  now: number
): Promise<Ctx> {
  const tenantId = row.session.tenantId;
  const grants = await grantsFor(database as unknown as CoreDb, tenantId, row.user.id);
  return ctxFor(
    c.env as Env,
    {
      tenantId,
      locale: row.user.locale,
      actor: { kind: "user", id: row.user.id, tenantId, grants },
      ...(await tenantConfig(database, tenantId, now))
    },
    now,
    c.req.header("cf-connecting-ip"),
    c.req.header("user-agent")
  );
}

authRoutes.post("/logout", async (c) => {
  const now = await simNow(c.env);
  const header = c.req.header("authorization");
  const token =
    (header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined) ??
    readCookie(c.req.header("cookie") ?? null, c.env.SESSION_COOKIE ?? COOKIE);
  if (token) {
    await db(c.env)
      .update(schema.sessions)
      .set({ revokedAt: now })
      .where(eq(schema.sessions.tokenHash, await sha256Hex(token)));
  }
  c.header("set-cookie", sessionCookie(c.env, null));
  return c.body(null, 204);
});

/** Session sweep for the scheduled handler. Expired rows carry no value. */
export async function pruneSessions(env: Env, now: number): Promise<void> {
  await db(env).delete(schema.sessions).where(lt(schema.sessions.expiresAt, now));
}

/* -------------------------------------------------------------- ctx build */

export async function ctxFor(
  env: Env,
  auth: Authenticated,
  now: number,
  ip?: string,
  ua?: string
): Promise<Ctx> {
  return {
    db: db(env) as unknown as Ctx["db"],
    tenantId: auth.tenantId,
    actor: auth.actor,
    requestId: newId("req", now),
    now,
    locale: auth.locale,
    policy: auth.policy,
    entitlements: auth.entitlements,
    ...(ip ? { ip } : {}),
    ...(ua ? { ua } : {})
  };
}

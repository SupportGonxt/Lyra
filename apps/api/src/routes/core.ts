import { Hono } from "hono";
import { and, asc, eq, gt, gte, isNull, like, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema, PolicyJson, toJson, parseJson, AutonomyLevel } from "@lyra/db";
import {
  actorRef,
  audit,
  APPROVAL_POLICIES,
  autoApproveProblem,
  badRequest,
  base32Encode,
  can,
  forbidden,
  isKnownPermission,
  notFound,
  require_,
  requiresMfa,
  scoped,
  sha256Hex,
  type Ctx,
  type Envelope
} from "@lyra/core";
import { LOGIN_MAX, LOGIN_WINDOW_SEC, MFA_MAX, SESSION_TTL_MS } from "../auth.js";
import { deliver } from "../dispatch.js";
import { body, created, InstantMs } from "../http.js";
import { must } from "../rows.js";
import type { App } from "../env.js";

// docs/06 §2. Everything about the core module that generated CRUD cannot do:
// minting an API key (the plaintext is shown once and never stored, so the
// client can neither supply `prefix` nor `keyHash` — exactly what a CRUD
// create would ask it for) and revoking one (generic CRUD delete only
// soft-deletes off a `deletedAt` column; api-keys has `revokedAt` instead).
// List and record still come from the generated resource in resources.ts.

export const coreRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/**
 * `.strict()` is the whole defence against a spoofed `tenantId` or `createdBy`:
 * both are server-derived, so a body carrying either is a 400 rather than a
 * silently ignored field. Same rule the generated CRUD applies to owned columns.
 */
const KeyBody = z
  .object({
    name: z.string().min(1).max(120),
    mode: z.enum(["test", "live"]).default("test"),
    scopes: z.array(z.string().min(3).max(120)).max(200).default([]),
    /** Epoch ms. A key with no expiry is a key nobody ever rotates. */
    expiresAt: InstantMs.positive().optional()
  })
  .strict();

/** 32 bytes of CSPRNG, base32 for the alphabet auth.ts can slice a prefix out of. */
const SECRET_BYTES = 32;

coreRoutes.post("/api-keys", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, KeyBody);
  // J-D1 (docs/06): a developer mints test keys; going live is dev.admin's
  // call. A live key needs `dev:keys_live:issue` whoever asks — core:*:* on a
  // tenant admin included. A test key takes either the key-admin grant or
  // the developer's own `dev:keys_test:issue`.
  const subject = { tenantId: ctx.tenantId, module: "core" };
  if (input.mode === "live") require_(ctx.actor, "dev:keys_live:issue", subject);
  else if (!can(ctx.actor, "dev:keys_test:issue", subject)) require_(ctx.actor, "core:api_keys:create", subject);
  if (input.expiresAt !== undefined && input.expiresAt <= ctx.now) throw badRequest("expiresAt is in the past");

  // A key may never be stronger than the person who minted it. Unknown strings
  // are rejected outright (a typo grants nothing but reads as if it does), and
  // every remaining scope has to be one the acting session actually holds —
  // `can()` is the same matcher authorization uses, wildcards included.
  for (const scope of input.scopes) {
    if (!isKnownPermission(scope)) throw badRequest(`unknown permission: ${scope}`);
    if (!can(ctx.actor, scope, { tenantId: ctx.tenantId })) throw forbidden(scope);
  }

  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  // base32, not base64url: auth.ts finds a presented key by
  // `token.slice(0, token.lastIndexOf("_") + 9)`, and a base64url `_` inside the
  // secret would move that boundary and make the key unverifiable. The alphabet
  // is also free of 0/1/8/O/I, so a key read off a screen survives the trip.
  const secret = base32Encode(bytes);
  const prefix = `qvk_${input.mode}_${secret.slice(0, 8)}`;
  const plaintext = `qvk_${input.mode}_${secret}`;
  // SHA-256, no KDF: this is 256 bits of machine-generated entropy, not a
  // user-chosen password, so there is no dictionary to slow an attacker down
  // over — and verification happens on every API call. The digest covers the
  // whole plaintext including the prefix, which is what auth.ts hashes back.
  const keyHash = await sha256Hex(plaintext);

  const row = {
    id: newId("key", ctx.now),
    tenantId: ctx.tenantId,
    name: input.name,
    prefix,
    keyHash,
    mode: input.mode,
    scopesJson: JSON.stringify(input.scopes),
    createdBy: actorRef(ctx),
    lastUsedAt: null,
    expiresAt: input.expiresAt ?? null,
    revokedAt: null,
    createdAt: ctx.now
  };
  await ctx.db.insert(schema.apiKeys).values(row);
  // `after` is the stored row: it holds the hash, never the plaintext. The
  // plaintext exists only in the response below — not in a log, not in an
  // error, not in a column.
  await audit(ctx, { action: "core.api-keys.create", subjectRef: `api-keys:${row.id}`, after: row });

  // `keyHash` is a `secretColumns` entry on the generated resource, so no read
  // path returns it; the mint must agree or it becomes the one way to get it.
  const { keyHash: _hash, ...safe } = row;
  return created(c, { ...safe, key: plaintext });
});

// Same structural problem as create, the other direction: `core_api_keys` has
// `revokedAt`, not `deletedAt`, so generic CRUD's delete (which only takes the
// soft-delete branch off a `deletedAt` column) would hard-delete the row.
// That destroys the audit trail a revoked credential is supposed to leave
// behind. Mounted before CRUD, this shadows that delete and revokes instead —
// same shape as meRoutes' session revoke in routes/me.ts.
coreRoutes.delete("/api-keys/:id", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:api_keys:revoke", { tenantId: ctx.tenantId, module: "core" });
  const rowId = c.req.param("id");
  await must(ctx, schema.apiKeys, rowId, "api-keys");
  await ctx.db
    .update(schema.apiKeys)
    .set({ revokedAt: ctx.now })
    .where(and(eq(schema.apiKeys.tenantId, ctx.tenantId), eq(schema.apiKeys.id, rowId)));
  await audit(ctx, { action: "core.api-keys.revoke", subjectRef: `api-keys:${rowId}` });
  return c.body(null, 204);
});

/* ------------------------------------------------------------- webhooks */

// Same structural problem as the key: `core_webhooks.secret` is notNull with no
// default, so the generated create asks the caller to type the signing secret it
// is then verified against. Mounted before CRUD, this shadows that create and
// generates the secret instead — the admin form never offered the field.

const WebhookBody = z
  .object({
    url: z.string().url().max(2000),
    // Same leaf the generated create uses for a `*Json` column, so the admin
    // form's json field posts unchanged: an array, or the text of one.
    eventTypesJson: z.union([z.array(z.string().min(1).max(120)).max(200), z.string().max(10_000)])
  })
  .strict();

// Stored in plaintext, unlike the API key, and deliberately: dispatch.ts HMACs
// every delivery with it and the SDK verifies with the same shared secret, so
// a digest here would leave nothing able to sign. `secretColumns: ["secret"]`
// on the resource keeps it off every read path and out of audit images.
function mintWebhookSecret(): string {
  const bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return `whsec_${base32Encode(bytes)}`;
}

coreRoutes.post("/webhooks", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:webhooks:write", { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, WebhookBody);

  const secret = mintWebhookSecret();
  const row = {
    id: newId("whk", ctx.now),
    tenantId: ctx.tenantId,
    url: input.url,
    eventTypesJson: typeof input.eventTypesJson === "string" ? input.eventTypesJson : JSON.stringify(input.eventTypesJson),
    secret,
    status: "active",
    createdAt: ctx.now
  };
  await ctx.db.insert(schema.webhooks).values(row);

  // Strip before auditing, not after: the API key could audit its whole row
  // because the row held a hash. This one holds the secret itself.
  const { secret: _secret, ...safe } = row;
  await audit(ctx, { action: "core.webhooks.create", subjectRef: `webhooks:${row.id}`, after: safe });
  // Event types go back as they came, parsed — the read path hydrates the column
  // too, so the mint's shape matches the record the client fetches next.
  return created(c, { ...safe, eventTypesJson: input.eventTypesJson, secret });
});

// docs/10 §6: "webhook secrets rotation UI". Generic CRUD's PATCH already lets
// a tenant set the secret to a value of their own choosing (resources.ts) —
// this is the other case, a fresh CSPRNG secret on demand, same mint the
// create route uses, so a receiver stuck accepting an old leaked secret has a
// one-click way off it without deleting and recreating the endpoint.
coreRoutes.post("/webhooks/:id/rotate", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:webhooks:write", { tenantId: ctx.tenantId, module: "core" });
  const rowId = c.req.param("id");
  const before = await must(ctx, schema.webhooks, rowId, "webhooks");
  const secret = mintWebhookSecret();
  await ctx.db
    .update(schema.webhooks)
    .set({ secret })
    .where(and(eq(schema.webhooks.tenantId, ctx.tenantId), eq(schema.webhooks.id, rowId)));
  await audit(ctx, { action: "core.webhooks.rotate", subjectRef: `webhooks:${rowId}` });
  const { secret: _before, ...safe } = before;
  return c.json({ ...safe, secret });
});

// docs/20 developer console "webhook tester". Reuses the real delivery path
// (dispatch.ts `deliver`) with a hand-built envelope rather than a queued
// event, so the receiver gets the exact signature scheme production events
// use, without waiting on the outbox or leaving a fake row behind for it.
coreRoutes.post("/webhooks/:id/test", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:webhooks:read", { tenantId: ctx.tenantId, module: "core" });
  const rowId = c.req.param("id");
  const hook = await must(ctx, schema.webhooks, rowId, "webhooks");

  const envelope: Envelope = {
    id: newId("ev", ctx.now),
    ts: ctx.now,
    tenant_id: ctx.tenantId,
    module: "core",
    type: "core.webhooks.test",
    actor: actorRef(ctx),
    data: { message: "This is a test event from the developer console." },
    v: 1
  };
  const result = await deliver(ctx, hook, envelope, 1);
  await audit(ctx, { action: "core.webhooks.test", subjectRef: `webhooks:${rowId}`, after: result });
  return c.json(result);
});

/**
 * docs/25 admin_security ("SSO, sessions, network and rate limits"). Read-only
 * on purpose: MFA is a platform floor — packages/core rbac.ts `requiresMfa`,
 * "the rule is the platform's and no tenant policy switch turns it off" — and
 * session lifetime and the login throttle are estate-wide constants. So there
 * is no tenant policy row to edit here, and inventing one would only offer a
 * way to weaken the floor. What a tenant admin needs instead is the truth
 * about what is enforced and who is currently outside it; the remedies already
 * exist elsewhere (enrol via the MFA flow, revoke via staff suspend/offboard).
 */
coreRoutes.get("/security-posture", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:settings:read", { tenantId: ctx.tenantId, module: "core" });
  // Naming an individual as unprotected is user data, not a policy fact, so the
  // list rides on the permission that would show those people anyway. Without
  // it the counts still render — the screen degrades, it does not 403.
  const mayNameUsers = can(ctx.actor, "core:users:read", { tenantId: ctx.tenantId });

  const memberships = await ctx.db
    .select({
      userId: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      status: schema.users.status,
      authProvider: schema.users.authProvider,
      mfaEnrolled: schema.users.mfaEnrolled,
      roleKey: schema.roles.key
    })
    .from(schema.users)
    .leftJoin(
      schema.userRoles,
      and(eq(schema.userRoles.userId, schema.users.id), eq(schema.userRoles.tenantId, ctx.tenantId))
    )
    .leftJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(and(eq(schema.users.tenantId, ctx.tenantId), isNull(schema.users.deletedAt)));

  // One row per membership arrives; fold to one entry per person carrying every
  // role key, because `requiresMfa` decides on the whole set (any internal role
  // means the floor applies) and not role by role.
  const people = new Map<
    string,
    { email: string; name: string; status: string; authProvider: string; mfaEnrolled: boolean; roleKeys: string[] }
  >();
  for (const row of memberships) {
    const entry = people.get(row.userId) ?? {
      email: row.email,
      name: row.name,
      status: row.status,
      authProvider: row.authProvider,
      mfaEnrolled: row.mfaEnrolled,
      roleKeys: []
    };
    if (row.roleKey) entry.roleKeys.push(row.roleKey);
    people.set(row.userId, entry);
  }

  let required = 0;
  let enrolled = 0;
  let exempt = 0;
  const gaps: Array<{ userId: string; email: string; name: string; roleKeys: string[]; authProvider: string }> = [];
  for (const [userId, person] of people) {
    // A suspended account cannot sign in, so counting it as a gap would make the
    // number impossible to ever clear.
    if (person.status === "suspended") continue;
    if (!requiresMfa(person.roleKeys)) {
      exempt += 1;
      continue;
    }
    required += 1;
    if (person.mfaEnrolled) {
      enrolled += 1;
      continue;
    }
    if (mayNameUsers) {
      gaps.push({
        userId,
        email: person.email,
        name: person.name,
        roleKeys: person.roleKeys,
        authProvider: person.authProvider
      });
    }
  }

  const live = await ctx.db
    .select({ userId: schema.sessions.userId, createdAt: schema.sessions.createdAt, mfaSatisfied: schema.sessions.mfaSatisfied })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.tenantId, ctx.tenantId),
        isNull(schema.sessions.revokedAt),
        gt(schema.sessions.expiresAt, ctx.now)
      )
    );

  const providers = await ctx.db
    .select({
      id: schema.identityProviders.id,
      name: schema.identityProviders.name,
      kind: schema.identityProviders.kind,
      emailDomain: schema.identityProviders.emailDomain,
      enabled: schema.identityProviders.enabled,
      mfaAsserted: schema.identityProviders.mfaAsserted,
      defaultRoleKey: schema.identityProviders.defaultRoleKey
    })
    .from(schema.identityProviders)
    .where(eq(schema.identityProviders.tenantId, ctx.tenantId));

  return c.json({
    mfa: {
      // The floor, restated where the admin is looking at it.
      policy: "internal-roles-always",
      tenantConfigurable: false,
      required,
      enrolled,
      exempt,
      gaps,
      gapsWithheld: !mayNameUsers && required > enrolled
    },
    sessions: {
      ttlHours: SESSION_TTL_MS / 3_600_000,
      tenantConfigurable: false,
      live: live.length,
      users: new Set(live.map((s) => s.userId)).size,
      // A live session that never satisfied MFA is a pre-verification stub, not
      // an authenticated seat — worth showing separately rather than hiding.
      unverified: live.filter((s) => !s.mfaSatisfied).length,
      oldestStartedAt: live.reduce<number | null>((min, s) => (min === null || s.createdAt < min ? s.createdAt : min), null)
    },
    limits: {
      // Fixed-window counters in auth.ts, not tenant policy.
      loginMax: LOGIN_MAX,
      loginWindowSec: LOGIN_WINDOW_SEC,
      mfaMax: MFA_MAX,
      tenantConfigurable: false
    },
    sso: {
      providers,
      // PLAT-013 rides on the provider too: an enabled IdP that cannot assert a
      // second factor covers a domain the floor then cannot reach.
      gaps: providers.filter((p) => p.enabled && !p.mfaAsserted)
    },
    // No IP allowlist exists anywhere in the platform, and a screen that showed
    // an empty one would read as "configured to allow everything". Say what is
    // true instead: the control is not offered.
    network: { ipAllowlist: "unsupported" }
  });
});

/* ------------------------------------------------------------- position */

// The 360 screen's Position card needs real sums, not the first CRUD page
// added up client-side. SQL SUM grouped by currency; a permission the actor
// lacks nulls that field on every line — null reads "may not see", 0 would
// read "nothing there". axis_policies/axis_claims carry no deletedAt, so
// there is no soft-delete branch to mirror; the customer row itself is
// soft-delete-checked by `must`.
coreRoutes.get("/customers/:id/position", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:customers:read", { tenantId: ctx.tenantId, module: "core" });
  const id = c.req.param("id");
  const customer = await must(ctx, schema.customers, id, "customers");

  const mayPolicies = can(ctx.actor, "axis:policies:read", { tenantId: ctx.tenantId });
  const mayClaims = can(ctx.actor, "axis:claims:read", { tenantId: ctx.tenantId });

  const policyAgg = mayPolicies
    ? await ctx.db
        .select({
          currency: schema.axisPolicies.currency,
          premiumMinor: sql<number>`coalesce(sum(${schema.axisPolicies.premiumMinor}), 0)`,
          commissionMinor: sql<number>`coalesce(sum(${schema.axisPolicies.commissionMinor}), 0)`
        })
        .from(schema.axisPolicies)
        .where(scoped(ctx, schema.axisPolicies, eq(schema.axisPolicies.customerId, id)))
        .groupBy(schema.axisPolicies.currency)
    : [];
  const claimAgg = mayClaims
    ? await ctx.db
        .select({
          currency: schema.axisClaims.currency,
          settledMinor: sql<number>`coalesce(sum(${schema.axisClaims.settledMinor}), 0)`
        })
        .from(schema.axisClaims)
        .where(scoped(ctx, schema.axisClaims, eq(schema.axisClaims.customerId, id)))
        .groupBy(schema.axisClaims.currency)
    : [];

  interface Line {
    currency: string;
    premiumMinor: number | null;
    commissionMinor: number | null;
    settledMinor: number | null;
  }
  const byCurrency = new Map<string, Line>();
  const line = (currency: string): Line => {
    const found = byCurrency.get(currency) ?? {
      currency,
      premiumMinor: mayPolicies ? 0 : null,
      commissionMinor: mayPolicies ? 0 : null,
      settledMinor: mayClaims ? 0 : null
    };
    byCurrency.set(currency, found);
    return found;
  };
  for (const row of policyAgg) {
    const entry = line(row.currency);
    entry.premiumMinor = Number(row.premiumMinor);
    entry.commissionMinor = Number(row.commissionMinor);
  }
  for (const row of claimAgg) line(row.currency).settledMinor = Number(row.settledMinor);

  // Neither axis permission held: byCurrency is empty and `positions: []` would
  // make the UI fall back to client-side sums, rendering 0 for withheld money.
  // Emit one line so every field is explicitly null (withheld), not absent.
  if (byCurrency.size === 0) line("AED");

  const positions = [...byCurrency.values()].sort((a, b) => (b.premiumMinor ?? 0) - (a.premiumMinor ?? 0));
  return c.json({
    positions,
    ltvMinor: customer.ltvCached ?? 0,
    currency: positions[0]?.currency ?? "AED"
  });
});

// Per-module configuration (docs/05 module independence). Each module gets its
// own enabled flag, autonomy override, model tier and free-form settings, so a
// tenant can run SIGNAL standalone with aggressive autonomy while keeping AXIS
// conservative. Absent keys fall through to the tenant-wide defaults — the
// resolver is moduleSettings() in packages/core, the single reader every module
// routes through.
const MODULES = ["axis", "orbit", "signal", "scout", "north", "ledger", "dist"] as const;

coreRoutes.get("/modules/config", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:settings:read", { tenantId: ctx.tenantId, module: "core" });
  const data = MODULES.map((m) => ({
    module: m,
    ...(ctx.policy.moduleConfig[m] ?? { enabled: true, settings: {} })
  }));
  return c.json({ data });
});

const ModuleConfigBody = z
  .object({
    enabled: z.boolean().optional(),
    autonomy: AutonomyLevel.optional(),
    modelTier: z.string().max(64).optional(),
    settings: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

coreRoutes.patch("/modules/:module/config", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:settings:update", { tenantId: ctx.tenantId, module: "core" });
  const module = c.req.param("module");
  if (!(MODULES as readonly string[]).includes(module)) throw badRequest(`unknown module ${module}`);
  const input = await body(c, ModuleConfigBody);

  const [row] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  if (!row) throw notFound("tenant");
  const before = parseJson(PolicyJson, row.policyJson);
  const own = before.moduleConfig[module] ?? { enabled: true, settings: {} };
  const after = {
    ...before,
    moduleConfig: {
      ...before.moduleConfig,
      [module]: {
        enabled: input.enabled ?? own.enabled,
        ...(input.autonomy !== undefined ? { autonomy: input.autonomy } : own.autonomy !== undefined ? { autonomy: own.autonomy } : {}),
        ...(input.modelTier !== undefined ? { modelTier: input.modelTier } : own.modelTier !== undefined ? { modelTier: own.modelTier } : {}),
        settings: { ...own.settings, ...(input.settings ?? {}) }
      }
    }
  };

  await ctx.db
    .update(schema.tenants)
    .set({ policyJson: toJson(PolicyJson, after), updatedAt: ctx.now })
    .where(eq(schema.tenants.id, ctx.tenantId));

  await audit(ctx, {
    action: "core.module.config_updated",
    subjectRef: `module:${module}`,
    before: { module: before.moduleConfig[module] ?? null },
    after: { module: after.moduleConfig[module] }
  });
  return c.json({ module, config: after.moduleConfig[module] });
});

// The tenant's auto-approve allowlist (CLAUDE.md convention 4, docs/19 §7).
// Until this endpoint it had five readers and one writer — the seed — so an
// operator could not change it at runtime at all. What may go in the array is
// `autoApproveProblem`'s call, shared with the tenant CRUD path that can also
// reach it (packages/core/src/approvals.ts).
const AutoApproveBody = z
  .object({
    add: z.array(z.string().max(128)).max(64).optional(),
    remove: z.array(z.string().max(128)).max(64).optional()
  })
  .strict();

/**
 * The audit chain as evidence (docs/27 F59). `core:audit:export` was granted to
 * the administrator and the compliance officer and asked for by nothing, so the
 * hash-chained log could be paged through and never taken away. Oldest first,
 * with every hash, so a reader can re-walk the chain outside LYRA. `q` narrows
 * by action prefix-or-substring, `from`/`to` by instant; capped so one request
 * cannot drag seven years of rows through a Worker.
 */
const AUDIT_EXPORT_CAP = 50_000;
const AUDIT_COLUMNS = ["ts", "action", "actorRef", "subjectRef", "ip", "beforeHash", "afterHash", "prevHash", "chainHash"] as const;

coreRoutes.get("/audit-log/export", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:audit:export", { tenantId: ctx.tenantId, module: "core" });
  const q = c.req.query("q")?.trim();
  const instant = (raw: string | undefined) => (raw && /^\d+$/.test(raw) ? Number(raw) : undefined);
  const from = instant(c.req.query("from"));
  const to = instant(c.req.query("to"));
  const a = schema.auditLog;
  const rows = await ctx.db
    .select()
    .from(a)
    .where(
      and(
        eq(a.tenantId, ctx.tenantId),
        q ? like(a.action, `%${q.replace(/[%_]/g, "")}%`) : undefined,
        from !== undefined ? gte(a.ts, from) : undefined,
        to !== undefined ? lte(a.ts, to) : undefined
      )
    )
    .orderBy(asc(a.ts))
    .limit(AUDIT_EXPORT_CAP);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    AUDIT_COLUMNS.join(","),
    ...rows.map((row) => AUDIT_COLUMNS.map((col) => esc(row[col])).join(","))
  ];
  await audit(ctx, { action: "core.audit.exported", subjectRef: `tenant:${ctx.tenantId}`, after: { rows: rows.length, q, from, to } });
  return c.body(`\uFEFF${lines.join("\r\n")}\r\n`, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="audit-log-${ctx.tenantId}.csv"`
  });
});

coreRoutes.get("/settings/auto-approve", (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:settings:read", { tenantId: ctx.tenantId, module: "core" });
  const policies = Object.values(APPROVAL_POLICIES).map((p) => ({
    key: p.key,
    module: p.module,
    automatable: !p.neverAutoApprove
  }));
  return c.json({ autoApprove: ctx.policy.autoApprove, policies });
});

coreRoutes.patch("/settings/auto-approve", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:settings:update", { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, AutoApproveBody);

  const problem = autoApproveProblem(input.add ?? []);
  if (problem) throw badRequest(problem);

  const [row] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1);
  if (!row) throw notFound("tenant");
  const before = parseJson(PolicyJson, row.policyJson);

  const removing = new Set(input.remove ?? []);
  const autoApprove = [
    ...new Set([...before.autoApprove.filter((k) => !removing.has(k)), ...(input.add ?? [])])
  ].sort();
  const after = { ...before, autoApprove };

  await ctx.db
    .update(schema.tenants)
    .set({ policyJson: toJson(PolicyJson, after), updatedAt: ctx.now })
    .where(eq(schema.tenants.id, ctx.tenantId));

  await audit(ctx, {
    action: "core.auto_approve.updated",
    subjectRef: `tenant:${ctx.tenantId}`,
    before: { autoApprove: before.autoApprove },
    after: { autoApprove }
  });
  return c.json({ autoApprove });
});

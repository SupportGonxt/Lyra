import { Hono } from "hono";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@lyra/db";
import {
  APPROVAL_POLICIES,
  audit,
  badRequest,
  can,
  decide,
  readyToFinish,
  expand,
  hashPassword,
  heldDelegation,
  notFound,
  pendingApprovals,
  recordLensUsage,
  resetLens,
  resolveLens,
  verifyPassword,
  type Ctx
} from "@lyra/core";
import { periodCode } from "@lyra/ledger";
import { body } from "../http.js";
import { must } from "../rows.js";
import type { App } from "../env.js";

// Everything the shell needs on first paint: who the caller is, what they may
// do, and what is waiting for them. One round trip, because a login that fans
// out to six endpoints before it can draw a nav is a slow login.

export const meRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

meRoutes.get("/", async (c) => {
  const ctx = ctxOf(c);
  // core_tenants is the one table with no tenant_id of its own, so it does not
  // go through the scoped helper.
  const tenant = (
    await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId)).limit(1)
  )[0];
  if (!tenant) throw notFound("tenant");

  const grants = ctx.actor.grants.map((g) => g.roleKey);
  const permissions = [...new Set(ctx.actor.grants.flatMap((g) => expand(g.permissions)))].sort();

  let profile: { id: string; name: string; email: string; locale: string; status: string } | null = null;
  if (ctx.actor.kind === "user") {
    const user = await must(ctx, schema.users, ctx.actor.id, "user");
    profile = {
      id: user.id,
      name: user.name,
      email: user.email,
      locale: user.locale,
      status: user.status
    };
  }

  return c.json({
    actor: { kind: ctx.actor.kind, id: ctx.actor.id, impersonating: ctx.actor.impersonating ?? false },
    profile,
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
      region: tenant.region,
      status: tenant.status,
      brand: safe(tenant.brandJson)
    },
    locale: ctx.locale,
    roles: grants,
    permissions,
    entitlements: ctx.entitlements,
    policy: ctx.policy,
    // The nav is derived from permissions, not stored: a role change takes
    // effect on the next request rather than the next deploy.
    nav: navFor(ctx),
    // A tenant admin's per-key i18n customisations, layered over the static
    // CATALOGUES by apps/web/app/i18n.ts's translator() at render time.
    overrides: await localeOverridesFor(ctx)
  });
});

async function localeOverridesFor(ctx: Ctx): Promise<Record<string, string>> {
  const rows = await ctx.db
    .select({ key: schema.localeOverrides.key, value: schema.localeOverrides.value })
    .from(schema.localeOverrides)
    .where(and(eq(schema.localeOverrides.tenantId, ctx.tenantId), eq(schema.localeOverrides.locale, ctx.locale)));
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

const ProfileBody = z.object({
  name: z.string().min(1).max(120).optional(),
  locale: z.enum(["en", "ar"]).optional()
});

meRoutes.patch("/", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has a profile");
  const input = await body(c, ProfileBody);
  const before = await must(ctx, schema.users, ctx.actor.id, "user");

  await ctx.db
    .update(schema.users)
    .set({ ...input, updatedAt: ctx.now })
    .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, ctx.actor.id)));
  // Neither the audit image nor the response may carry the whole user row: it
  // holds `passwordHash`, `mfaSecret` and `mfaRecoveryJson`, and an audit row is
  // readable with `core:audit:read`. Only the two editable fields matter here.
  const was = { name: before.name, locale: before.locale };
  await audit(ctx, { action: "core.user.update_self", subjectRef: ctx.actor.id, before: was, after: input });
  return c.json({
    id: before.id,
    name: input.name ?? before.name,
    email: before.email,
    locale: input.locale ?? before.locale,
    status: before.status,
    updatedAt: ctx.now
  });
});

const PasswordBody = z.object({
  current: z.string().min(1),
  next: z.string().min(12).max(200)
});

meRoutes.post("/password", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has a password");
  const input = await body(c, PasswordBody);
  const user = await must(ctx, schema.users, ctx.actor.id, "user");

  if (!(await verifyPassword(input.current, user.passwordHash))) {
    // Deliberately not a 401: the session is valid, the claim about the old
    // password is not.
    throw badRequest("current password is incorrect");
  }
  if (input.next === input.current) throw badRequest("new password must differ from the current one");

  await ctx.db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(input.next), updatedAt: ctx.now })
    .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, user.id)));

  // Every other session dies. A password change that leaves the attacker's
  // session alive has changed nothing.
  await ctx.db
    .update(schema.sessions)
    .set({ revokedAt: ctx.now })
    .where(
      and(
        eq(schema.sessions.tenantId, ctx.tenantId),
        eq(schema.sessions.userId, user.id),
        isNull(schema.sessions.revokedAt)
      )
    );

  await audit(ctx, { action: "core.user.password_change", subjectRef: user.id });
  return c.body(null, 204);
});

/** Sessions the caller can see and kill — the "where am I signed in" panel. */
meRoutes.get("/sessions", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") return c.json({ data: [] });
  const rows = await ctx.db
    .select({
      id: schema.sessions.id,
      ip: schema.sessions.ip,
      ua: schema.sessions.ua,
      createdAt: schema.sessions.createdAt,
      expiresAt: schema.sessions.expiresAt,
      revokedAt: schema.sessions.revokedAt
    })
    .from(schema.sessions)
    .where(and(eq(schema.sessions.tenantId, ctx.tenantId), eq(schema.sessions.userId, ctx.actor.id)))
    .orderBy(desc(schema.sessions.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

meRoutes.delete("/sessions/:id", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has sessions");
  await ctx.db
    .update(schema.sessions)
    .set({ revokedAt: ctx.now })
    .where(
      and(
        eq(schema.sessions.tenantId, ctx.tenantId),
        eq(schema.sessions.userId, ctx.actor.id),
        eq(schema.sessions.id, c.req.param("id"))
      )
    );
  await audit(ctx, { action: "core.session.revoke", subjectRef: c.req.param("id") });
  return c.body(null, 204);
});

/** The caller's work queue: approvals they can decide, unread notifications. */
meRoutes.get("/inbox", async (c) => {
  const ctx = ctxOf(c);
  // The permission to decide comes from the policy, not from the module name:
  // there is no `axis:approval:decide` in the vocabulary, so deriving one would
  // filter every approval out and leave the queue permanently empty. A delegate
  // holding no permission of their own still needs this row to show up here —
  // otherwise `decide()` would accept a decision the inbox never offered.
  // F60: the queue pages by keyset (requestedAt, id) instead of stopping at a
  // cap. The cursor is the last *raw* row read, so a page the permission filter
  // thinned out still hands on to the next one.
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 100);
  const rawCursor = c.req.query("cursor");
  let after: { requestedAt: number; id: string } | undefined;
  if (rawCursor) {
    const dot = rawCursor.indexOf(".");
    const requestedAt = Number(rawCursor.slice(0, dot));
    if (dot < 1 || !Number.isSafeInteger(requestedAt) || !rawCursor.slice(dot + 1)) {
      throw badRequest("cursor is not one this endpoint issued", { cursor: "invalid" });
    }
    after = { requestedAt, id: rawCursor.slice(dot + 1) };
  }
  const pending = await pendingApprovals(ctx, undefined, limit, after);
  const last = pending.at(-1);
  const cursor = pending.length === limit && last ? `${last.requestedAt}.${last.id}` : null;
  const decidable = await Promise.all(
    pending.map(async (a) => {
      const p = APPROVAL_POLICIES[a.policyKey];
      if (!p) return null;
      if (can(ctx.actor, p.decide, { tenantId: ctx.tenantId, module: p.module })) return a;
      const context = a.contextJson ? (JSON.parse(a.contextJson) as { amountMinor?: number | null }) : {};
      const held = await heldDelegation(ctx, {
        policyKey: a.policyKey,
        module: p.module,
        ...(context.amountMinor == null ? {} : { amountMinor: context.amountMinor })
      });
      return held ? a : null;
    })
  );
  const approvals = decidable.filter((a): a is NonNullable<typeof a> => a !== null);
  const notifications = await ctx.db
    .select()
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.tenantId, ctx.tenantId),
        eq(schema.notifications.userId, ctx.actor.id),
        isNull(schema.notifications.readAt)
      )
    )
    .orderBy(desc(schema.notifications.createdAt))
    .limit(50);
  // The shell's shift ring needs a denominator: a ring fed only by what is
  // still open can never say anything but "nothing done". This is the other
  // half — what this actor has already cleared today.
  //
  // ponytail: UTC day boundary. No tenant carries a timezone yet (BrandJson /
  // PolicyJson in packages/db/src/json.ts); when one does, offset here.
  const dayStart = ctx.now - (ctx.now % 86_400_000);
  const cleared = await ctx.db
    .select({ id: schema.approvals.id })
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.tenantId, ctx.tenantId),
        eq(schema.approvals.decidedBy, ctx.actor.id),
        gte(schema.approvals.decidedAt, dayStart)
      )
    );
  return c.json({
    approvals,
    cursor,
    notifications,
    counts: {
      approvals: approvals.length,
      notifications: notifications.length,
      clearedToday: cleared.length
    },
    posture: await posture(ctx)
  });
});

/**
 * The two facts the header chips state: how much client money is held right
 * now, and whether this month's ledger is still open. Both ride on the inbox
 * because the shell already fetches it — a chip is not worth two more round
 * trips before first paint.
 *
 * Each half is null when the caller may not read it, and the chip is then
 * absent rather than empty: docs/07 §3 says a closed door is not shown as a
 * disabled one.
 */
async function posture(ctx: Ctx): Promise<{
  clientMoney: { heldMinor: number; currency: string; breach: boolean } | null;
  period: { code: string; state: string } | null;
}> {
  const scope = { tenantId: ctx.tenantId, module: "ledger" };
  // ponytail: the newest check row, not a fresh balance sweep. `post()` writes
  // one on every posting that touches client money (packages/ledger/src/
  // posting.ts), so the latest row is the position as of the last movement.
  const check = can(ctx.actor, "ledger:client_money:read", scope)
    ? (
        await ctx.db
          .select()
          .from(schema.ledgerClientMoneyChecks)
          .where(eq(schema.ledgerClientMoneyChecks.tenantId, ctx.tenantId))
          .orderBy(desc(schema.ledgerClientMoneyChecks.ts))
          .limit(1)
      )[0]
    : undefined;
  const period = can(ctx.actor, "ledger:periods:read", scope)
    ? (
        await ctx.db
          .select()
          .from(schema.ledgerPeriods)
          .where(
            and(
              eq(schema.ledgerPeriods.tenantId, ctx.tenantId),
              eq(schema.ledgerPeriods.code, periodCode(ctx.now))
            )
          )
          .limit(1)
      )[0]
    : undefined;
  return {
    clientMoney: check
      ? { heldMinor: check.assetMinor, currency: check.currency, breach: check.breach }
      : null,
    // No row yet means nothing has posted this month, which is an open period —
    // `ensurePeriod` creates it lazily on the first posting.
    period: can(ctx.actor, "ledger:periods:read", scope)
      ? { code: periodCode(ctx.now), state: period?.state ?? "open" }
      : null
  };
}

/**
 * Decide an approval from the inbox. Without this an approval-gated action —
 * a price match, a payout, an unmasked export — can be raised over the API but
 * never cleared, so the flow dead-ends. The permission check, the dual-control
 * rule and the audit row all live in `decide()`; this is only the transport.
 */
meRoutes.post("/approvals/:id/decide", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, z.object({ decision: z.enum(["approved", "rejected"]), reason: z.string().max(2000).optional() }));
  const row = await decide(ctx, c.req.param("id"), input.decision, input.reason);
  return c.json(row);
});

/** Requests this actor raised, now approved and waiting for them to finish. */
meRoutes.get("/approvals/ready", async (c) => {
  const ctx = ctxOf(c);
  return c.json({ data: await readyToFinish(ctx) });
});

meRoutes.post("/notifications/:id/read", async (c) => {
  const ctx = ctxOf(c);
  await ctx.db
    .update(schema.notifications)
    .set({ readAt: ctx.now })
    .where(
      and(
        eq(schema.notifications.tenantId, ctx.tenantId),
        eq(schema.notifications.userId, ctx.actor.id),
        eq(schema.notifications.id, c.req.param("id"))
      )
    );
  return c.body(null, 204);
});

/* ------------------------------------------------------------------ lens */
// docs/15 §5. The lens is per-user, so only a user actor has one — an agent,
// partner or system credential has no `core_users` row for it to key on.

function rolesOf(ctx: Ctx): string[] {
  return ctx.actor.grants.map((g) => g.roleKey);
}

/** The lens in force for the caller right now: their own if ever written, else the role default. */
meRoutes.get("/lens", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has a lens");
  const resolved = await resolveLens(ctx, ctx.actor.id, rolesOf(ctx));
  return c.json(resolved);
});

const LensUsageBody = z.object({ key: z.string().min(1).max(120) });

/** Learned adaptation: the caller interacted with `key` (a view, filter or pin). */
meRoutes.post("/lens/usage", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has a lens");
  const input = await body(c, LensUsageBody);
  const lens = await recordLensUsage(ctx, ctx.actor.id, rolesOf(ctx), input.key);
  return c.json(lens);
});

/** Discards learned adaptation and reverts the caller to their role's default lens. */
meRoutes.post("/lens/reset", async (c) => {
  const ctx = ctxOf(c);
  if (ctx.actor.kind !== "user") throw badRequest("only a user has a lens");
  const lens = await resetLens(ctx, ctx.actor.id, rolesOf(ctx));
  return c.json(lens);
});

/* ------------------------------------------------------------------- nav */

export interface NavItem {
  /** i18n key. A hard-coded English label in a nav is a bug (docs/07 §2). */
  labelKey: string;
  href: string;
  icon: string;
  /** A section label (e.g. "Modules"), not a link — `href`/`icon` are unused. */
  heading?: boolean;
  children?: NavItem[];
}

type NavSpec = NavItem & { permission?: string; children?: NavSpec[] };

/**
 * Nav items always carry a text label — `labelKey` is required and `icon` is
 * decoration beside it, never instead of it. An icon-only rail costs every user
 * a hover to read and a screen-reader user the label entirely.
 *
 * Grouped so the rail reads as sections rather than one flat list. A heading
 * with no visible children (every child permission-filtered out) is dropped
 * by `filterNav` rather than left as a lonely label.
 */
const NAV: NavSpec[] = [
  // Home is ungated: every signed-in actor has somewhere to land, and a nav
  // whose first item is missing reads as a broken app rather than a scoped one.
  { labelKey: "nav.home", href: "/", icon: "home" },
  {
    labelKey: "nav.group.modules",
    href: "",
    icon: "",
    heading: true,
    children: [
      { labelKey: "nav.axis", href: "/axis", icon: "shield", permission: "axis:cases:read" },
      { labelKey: "nav.orbit", href: "/orbit", icon: "orbit", permission: "orbit:conversations:read" },
      { labelKey: "nav.signal", href: "/signal", icon: "megaphone", permission: "signal:campaigns:read" },
      { labelKey: "nav.scout", href: "/scout", icon: "radar", permission: "scout:signals:read" },
      { labelKey: "nav.north", href: "/north", icon: "compass", permission: "north:metrics:read" }
    ]
  },
  {
    labelKey: "nav.group.records",
    href: "",
    icon: "",
    heading: true,
    children: [
      {
        labelKey: "nav.distribution",
        href: "/distribution",
        icon: "network",
        permission: "dist:quote_requests:read"
      },
      { labelKey: "nav.ledger", href: "/ledger", icon: "ledger", permission: "ledger:txns:read" },
      { labelKey: "nav.analytics", href: "/analytics", icon: "chart", permission: "analytics:reports:read" },
      { labelKey: "nav.compliance", href: "/compliance", icon: "scale", permission: "compliance:dsar:read" }
    ]
  },
  {
    labelKey: "nav.group.platform",
    href: "",
    icon: "",
    heading: true,
    children: [
      { labelKey: "nav.admin", href: "/admin", icon: "settings", permission: "core:users:read" },
      // Platform staff (ADR-0029): every platform.* role holds this permission
      // (directly or via platform.admin's wildcard) and no tenant role does, so
      // it is a clean, already-existing gate for a cross-tenant workspace. The
      // route itself lands in a later phase; `isRouted()` keeps this hidden
      // from the rendered rail until then (apps/web/app/routing.ts).
      { labelKey: "nav.platform", href: "/platform", icon: "gauge", permission: "admin:diagnostics:read" }
    ]
  }
];

/** Permission-filters items and children, stripping `permission` and dropping
 * any heading whose children all got filtered out. */
function filterNav(items: NavSpec[], ctx: Ctx): NavItem[] {
  const out: NavItem[] = [];
  for (const { permission, children, ...item } of items) {
    if (permission && !can(ctx.actor, permission, { tenantId: ctx.tenantId })) continue;
    const filteredChildren = children ? filterNav(children, ctx) : undefined;
    if (item.heading && (!filteredChildren || filteredChildren.length === 0)) continue;
    out.push(filteredChildren ? { ...item, children: filteredChildren } : item);
  }
  return out;
}

function navFor(ctx: Ctx): NavItem[] {
  return filterNav(NAV, ctx);
}

function safe(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

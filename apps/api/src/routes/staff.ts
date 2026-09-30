import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@lyra/db";
import { require_,
  requireAny, type Ctx } from "@lyra/core";
import { body, created, InstantMs, listParams } from "../http.js";
import {
  changeRoles,
  expireDelegations,
  grantDelegation,
  inviteStaff,
  listStaff,
  offboardStaff,
  revokeDelegation,
  startStaffOnboarding
} from "../engines/staff.js";
import type { App } from "../env.js";

// docs/06 §4. The back office's own verbs. Generated CRUD can already read a
// user row; none of what follows is a row edit — joining, moving and leaving
// each touch permissions, credentials and other people's work at once, so they
// are one transaction with one audit entry rather than four PATCHes an operator
// might do three of.

export const staffRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/**
 * `.strict()` on every body: `tenantId`, `status` and `createdBy` are derived
 * from the session and an unknown key is a spoof attempt, not a typo.
 */
const InviteBody = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(200),
    locale: z.string().min(2).max(10).optional(),
    roleKeys: z.array(z.string().min(1).max(64)).min(1).max(20),
    teamIds: z.array(z.string().min(1)).max(20).optional(),
    managerId: z.string().min(1).optional(),
    dueAt: InstantMs.optional()
  })
  .strict();

/** Joiner: account, roles, teams and the checklist that has to clear. */
staffRoutes.post("/invitations", async (c) => {
  const ctx = ctxOf(c);
  requireAny(ctx.actor, ["core:users:create"], { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, InviteBody);
  const out = await inviteStaff(ctx, input);
  return created(c, { ...out.user, steps: out.steps });
});

/** Re-run the joiner checklist for an account that already exists. */
staffRoutes.post("/users/:id/onboarding", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, z.object({ ownerRef: z.string().optional(), dueAt: InstantMs.optional() }).strict());
  const steps = await startStaffOnboarding(ctx, c.req.param("id"), input);
  return c.json({ steps });
});

const RolesBody = z
  .object({
    add: z.array(z.string().min(1).max(64)).max(20).optional(),
    remove: z.array(z.string().min(1).max(64)).max(20).optional(),
    reason: z.string().min(3).max(500)
  })
  .strict();

/** Mover. Refused outright if it would grant something the caller lacks. */
staffRoutes.post("/users/:id/roles", async (c) => {
  const ctx = ctxOf(c);
  requireAny(ctx.actor, ["core:roles:assign"], { tenantId: ctx.tenantId, module: "core" });
  return c.json(await changeRoles(ctx, c.req.param("id"), await body(c, RolesBody)));
});

const OffboardBody = z
  .object({
    lastDay: InstantMs,
    reassignTo: z.string().min(1),
    reason: z.string().max(500).optional()
  })
  .strict();

/** Leaver. Every credential dies, every open item gets a named owner. */
staffRoutes.post("/users/:id/offboard", async (c) => {
  const ctx = ctxOf(c);
  requireAny(ctx.actor, ["core:users:update"], { tenantId: ctx.tenantId, module: "core" });
  return c.json(await offboardStaff(ctx, c.req.param("id"), await body(c, OffboardBody)));
});

/**
 * The person picker every assignment surface needs. Id and display name only:
 * a dropdown is not a reason to hand out the staff directory.
 */
staffRoutes.get("/users", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:users:read", { tenantId: ctx.tenantId, module: "core" });
  const { list } = listParams(c);
  return c.json({ data: await listStaff(ctx, list.q, list.limit) });
});

/* -------------------------------------------------------------- delegation */

const DelegationBody = z
  .object({
    fromUserId: z.string().min(1).optional(),
    toUserId: z.string().min(1),
    reason: z.enum(["leave", "travel", "cover", "offboarding"]),
    scope: z
      .object({
        policyKeys: z.array(z.string().min(1).max(64)).max(50).optional(),
        modules: z.array(z.string().min(1).max(32)).max(20).optional()
      })
      .strict()
      .optional(),
    maxAmountMinor: z.number().int().positive().optional(),
    currency: z.string().length(3).optional(),
    startsAt: InstantMs,
    endsAt: InstantMs
  })
  .strict();

/** Gated on `core.delegation_grant`: 403 + approval_id until it is approved. */
staffRoutes.post("/delegations", async (c) => {
  const ctx = ctxOf(c);
  requireAny(ctx.actor, ["core:delegations:write"], { tenantId: ctx.tenantId, module: "core" });
  return created(c, await grantDelegation(ctx, await body(c, DelegationBody)));
});

staffRoutes.get("/delegations", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:delegations:read", { tenantId: ctx.tenantId, module: "core" });
  const { list } = listParams(c);
  const status = c.req.query("status");
  const rows = await ctx.db
    .select()
    .from(schema.delegations)
    .where(
      and(
        eq(schema.delegations.tenantId, ctx.tenantId),
        status ? eq(schema.delegations.status, status) : undefined
      )
    )
    .orderBy(desc(schema.delegations.createdAt))
    .limit(list.limit);
  return c.json({ data: rows });
});

staffRoutes.post("/delegations/:id/revoke", async (c) => {
  const ctx = ctxOf(c);
  requireAny(ctx.actor, ["core:delegations:write"], { tenantId: ctx.tenantId, module: "core" });
  const input = await body(c, z.object({ reason: z.string().max(500).optional() }).strict());
  return c.json(await revokeDelegation(ctx, c.req.param("id"), input.reason));
});

/**
 * The sweep, exposed so the scheduled tick has something to call and an
 * operator can prove it works without waiting for cron.
 */
staffRoutes.post("/delegations/expire", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:delegations:write", { tenantId: ctx.tenantId, module: "core" });
  return c.json({ expired: await expireDelegations(ctx) });
});

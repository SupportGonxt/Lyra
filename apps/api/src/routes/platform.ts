import { Hono } from "hono";
import { and, desc, eq, gte, isNull } from "drizzle-orm";
import { z } from "zod";
import { id, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  can,
  conflict,
  forbidden,
  gate,
  notFound,
  require_,
  ROLES,
  syncChartOfAccounts,
  syncTaxRules,
  TENANT_ROLE_KEYS,
  type CoreDb,
  type Ctx
} from "@lyra/core";
import { AI_KILL_SWITCH } from "@lyra/model-gateway";
import { body, created } from "../http.js";
import { allTenants } from "../auth.js";
import type { App } from "../env.js";

// ADR-0028: the one global (non-tenant-scoped) table in the schema — a flag
// gates a capability for tenants that haven't signed up yet. No scoped()/
// assertTenant() here on purpose; there is no tenant to scope against.

export const platformRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

platformRoutes.get("/flags", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:flags:read");
  const flags = await ctx.db.select().from(schema.featureFlags);
  return c.json({ flags });
});

const CreateFlagBody = z
  .object({
    key: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    targetTenantIds: z.array(z.string().min(1)).max(500).optional()
  })
  .strict();

platformRoutes.post("/flags", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:flags:write");
  const input = await body(c, CreateFlagBody);
  const row = {
    id: id("flg", ctx.now),
    key: input.key,
    description: input.description,
    enabled: false,
    rolloutPercent: input.rolloutPercent ?? 0,
    targetTenantIdsJson: input.targetTenantIds ? JSON.stringify(input.targetTenantIds) : null,
    updatedBy: actorRef(ctx),
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.featureFlags).values(row);
  await audit(ctx, { action: "platform.flag.created", subjectRef: row.id, after: row });
  return created(c, row);
});

const CreateTenantBody = z
  .object({
    slug: z
      .string()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "slug is lowercase letters, digits and hyphens"),
    name: z.string().min(1).max(200),
    plan: z.string().min(1).max(60).optional(),
    region: z.string().min(1).max(60).optional(),
    adminEmail: z.string().email().max(200).optional(),
    adminName: z.string().min(1).max(200).optional()
  })
  .strict();

/**
 * J-A1 "new tenant in a day" (docs/06 §2). Tenant creation was seed-only — this
 * is the runtime counterpart: the platform provisions the tenant, writes the
 * same role set the seed writes (docs/06 §1), and invites its first
 * administrator. Nothing here binds a policy or moves money.
 */
platformRoutes.post("/tenants", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:tenants:write");
  const input = await body(c, CreateTenantBody);

  const [taken] = await ctx.db
    .select({ id: schema.tenants.id })
    .from(schema.tenants)
    .where(eq(schema.tenants.slug, input.slug))
    .limit(1);
  if (taken) throw conflict(`tenant slug "${input.slug}" is already taken`);

  const now = ctx.now;
  const tenantId = id("tn", now);
  await ctx.db.insert(schema.tenants).values({
    id: tenantId,
    slug: input.slug,
    name: input.name,
    plan: input.plan ?? "standard",
    region: input.region ?? "auto",
    status: "active",
    createdAt: now,
    updatedAt: now
  });

  // The role set every tenant gets (docs/06 §1): the bundles rbac.ts owns, so a
  // fresh tenant is usable the moment it exists and no runtime path invents a
  // permission the catalogue does not hold.
  const roleIds: Record<string, string> = {};
  let roleSeq = 0;
  for (const key of TENANT_ROLE_KEYS) {
    const roleId = id("rl", now + roleSeq++);
    roleIds[key] = roleId;
    await ctx.db.insert(schema.roles).values({
      id: roleId,
      tenantId,
      key,
      name: key,
      permissionsJson: JSON.stringify(ROLES[key] ?? []),
      system: true,
      createdAt: now
    });
  }

  let adminUserId: string | null = null;
  if (input.adminEmail) {
    adminUserId = id("usr", now);
    await ctx.db.insert(schema.users).values({
      id: adminUserId,
      tenantId,
      email: input.adminEmail,
      name: input.adminName ?? input.adminEmail,
      locale: "en",
      status: "invited",
      authProvider: "password",
      mfaEnrolled: false,
      createdAt: now,
      updatedAt: now
    });
    await ctx.db.insert(schema.userRoles).values({
      id: id("ur", now),
      tenantId,
      userId: adminUserId,
      roleId: roleIds["tenant.admin"]!,
      createdAt: now
    });
    await audit(ctx, {
      action: "platform.tenant.admin_invited",
      subjectRef: tenantId,
      after: { tenantId, userId: adminUserId, email: input.adminEmail }
    });
  }

  // **Provision what a tenant needs to function, not merely to exist.**
  //
  // This route wrote a tenant row, its role set and its first admin — and nothing
  // else. A real tenant created in production therefore could not trade:
  //
  //   - **no chart of accounts** — the ledger has no accounts to post to, so no
  //     commission accrual and no settlement;
  //   - **no tax rulepack** — `taxTreatment()` refuses every supply it has no rule
  //     for, so the tenant cannot shop or bind at all (the same refusal that makes
  //     six of the client's nine markets wait, §52).
  //
  // The only backfill was `/v1/auth/demo/resync-roles`, which is **`demoOnly`** *and*
  // hard-wired to `demoTenant()` — so it could not reach a real tenant in production
  // by either route. "New tenant in a day" was true of the row and false of the
  // workspace.
  //
  // Both calls are the seed's own functions and both are idempotent, so a tenant
  // provisioned here is provisioned exactly the way every other tenant is — no second
  // code path to drift.
  //
  // **Not provisioned: authorisations.** A licence number is the tenant's own
  // statement and the platform must never invent one (ADR-0125), so a tenant records
  // its own before it can bind. That is a data task, not a defect.
  const accounts = await syncChartOfAccounts(ctx.db as unknown as CoreDb, tenantId);
  const taxRules = await syncTaxRules(ctx.db as unknown as CoreDb, tenantId, { now });

  await audit(ctx, {
    action: "platform.tenant.created",
    subjectRef: tenantId,
    after: {
      id: tenantId,
      slug: input.slug,
      name: input.name,
      roles: TENANT_ROLE_KEYS.length,
      adminUserId,
      accounts: accounts.length,
      taxRules: taxRules.length
    }
  });
  return created(c, {
    id: tenantId,
    slug: input.slug,
    name: input.name,
    adminInvited: adminUserId !== null,
    // Named in the response so a provisioner can see the workspace is *usable*, not
    // just that the row exists.
    provisioned: { accounts: accounts.length, taxRules: taxRules.length }
  });
});

const PatchFlagBody = z
  .object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    targetTenantIds: z.array(z.string().min(1)).max(500).optional()
  })
  .strict();

platformRoutes.patch("/flags/:id", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:flags:write");
  const input = await body(c, PatchFlagBody);
  const flagId = c.req.param("id");
  const rows = await ctx.db.select().from(schema.featureFlags).where(eq(schema.featureFlags.id, flagId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound("flag");

  // Only a change to `enabled` is the toggle ADR-0028 gates — a capability
  // going live for every tenant at once, never a rollout-percent nudge.
  if (input.enabled !== undefined && input.enabled !== row.enabled) {
    await gate(ctx, { policyKey: "core.flag_toggle", subjectRef: flagId });
  }

  const patch = {
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.rolloutPercent !== undefined ? { rolloutPercent: input.rolloutPercent } : {}),
    ...(input.targetTenantIds !== undefined ? { targetTenantIdsJson: JSON.stringify(input.targetTenantIds) } : {}),
    updatedBy: actorRef(ctx),
    updatedAt: ctx.now
  };
  await ctx.db.update(schema.featureFlags).set(patch).where(eq(schema.featureFlags.id, flagId));
  const updated = { ...row, ...patch };
  await audit(ctx, { action: "platform.flag.updated", subjectRef: flagId, before: row, after: updated });
  return c.json(updated);
});

/* ------------------------------------------------- global AI kill switch */

// docs/12 §4: "Kill switches: per-agent, per-module, per-tenant, global — all
// one click, all logged". This is the widest tier: one row in the flags table
// (AI_KILL_SWITCH), read by the gateway in front of every model call. It gets
// its own pair of routes rather than the PATCH above because the toggle there
// is dual-controlled, and an approval queue in front of a kill switch means the
// incident keeps running while someone hunts for a second approver. Killing is
// one click; releasing keeps the dual control.

const KillBody = z
  .object({
    reason: z.string().min(3).max(500),
    /** Empty means every tenant; a list narrows the kill to those tenants. */
    tenantIds: z.array(z.string().min(1)).max(500).optional()
  })
  .strict();

async function killSwitchRow(ctx: Ctx) {
  const rows = await ctx.db
    .select()
    .from(schema.featureFlags)
    .where(eq(schema.featureFlags.key, AI_KILL_SWITCH))
    .limit(1);
  return rows[0];
}

platformRoutes.post("/ai/kill", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:flags:write");
  const input = await body(c, KillBody);
  const patch = {
    enabled: true,
    rolloutPercent: 100,
    targetTenantIdsJson: input.tenantIds?.length ? JSON.stringify(input.tenantIds) : null,
    updatedBy: actorRef(ctx),
    updatedAt: ctx.now
  };

  // The row is created on first use, so ops never has to remember to seed it
  // before the day it is needed.
  const before = await killSwitchRow(ctx);
  const row = before
    ? { ...before, ...patch }
    : {
        ...patch,
        id: id("flg", ctx.now),
        key: AI_KILL_SWITCH,
        description: "Global AI kill switch (docs/12 §4). Enabled = all model calls refused."
      };
  if (before) {
    await ctx.db.update(schema.featureFlags).set(patch).where(eq(schema.featureFlags.id, before.id));
  } else {
    await ctx.db.insert(schema.featureFlags).values(row);
  }

  await audit(ctx, {
    action: "platform.ai.killed",
    subjectRef: AI_KILL_SWITCH,
    ...(before ? { before } : {}),
    after: { ...row, reason: input.reason }
  });
  return c.json(row);
});

platformRoutes.post("/ai/release", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:flags:write");
  const before = await killSwitchRow(ctx);
  if (!before) throw notFound("flag");
  // Turning AI back on for everyone is the consequential direction, and it is
  // the same decision `core.flag_toggle` already governs.
  await gate(ctx, { policyKey: "core.flag_toggle", subjectRef: AI_KILL_SWITCH });

  const patch = { enabled: false, updatedBy: actorRef(ctx), updatedAt: ctx.now };
  await ctx.db.update(schema.featureFlags).set(patch).where(eq(schema.featureFlags.id, before.id));
  const row = { ...before, ...patch };
  await audit(ctx, { action: "platform.ai.released", subjectRef: AI_KILL_SWITCH, before, after: row });
  return c.json(row);
});

/**
 * ADR-0029: a fresh per-tenant identity for the cross-tenant read loop below.
 * `can()` checks `subject.tenantId === actor.tenantId` first, so the actor's
 * `tenantId` has to move with the loop, not just `ctx.tenantId` — otherwise
 * every entity-scoped permission check would compare against the platform
 * user's home tenant instead of the tenant being read. This is deliberately
 * lighter than `ctxFor()`: these routes never touch `ctx.policy`/
 * `ctx.entitlements`, so there is no need to re-fetch tenant config per tenant
 * (which would also throw on a suspended tenant instead of just skipping it).
 */
function scopedToTenant(ctx: Ctx, tenantId: string): Ctx {
  return { ...ctx, tenantId, actor: { ...ctx.actor, tenantId } };
}

platformRoutes.get("/ops/overview", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:diagnostics:read");
  const tenants: { tenantId: string; outboxPending: number; dlqDepth: number; pendingApprovals: number }[] = [];
  let lastSnapshotAt: number | null = null;

  for (const tenantId of await allTenants(c.env)) {
    const tctx = scopedToTenant(ctx, tenantId);
    if (!can(tctx.actor, "admin:diagnostics:read", { tenantId, module: "admin" })) continue;

    const outbox = await tctx.db
      .select({ id: schema.eventOutbox.id })
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, tenantId), isNull(schema.eventOutbox.publishedAt)));
    const dlq = await tctx.db
      .select({ id: schema.eventDlq.id })
      .from(schema.eventDlq)
      .where(and(eq(schema.eventDlq.tenantId, tenantId), isNull(schema.eventDlq.replayedAt)));
    const approvalsPending = await tctx.db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.decision, "pending")));
    const latestSnapshot = await tctx.db
      .select({ ts: schema.northSnapshots.ts })
      .from(schema.northSnapshots)
      .where(eq(schema.northSnapshots.tenantId, tenantId))
      .orderBy(desc(schema.northSnapshots.ts))
      .limit(1);

    tenants.push({
      tenantId,
      outboxPending: outbox.length,
      dlqDepth: dlq.length,
      pendingApprovals: approvalsPending.length
    });
    const ts = latestSnapshot[0]?.ts;
    if (ts !== undefined && (lastSnapshotAt === null || ts > lastSnapshotAt)) lastSnapshotAt = ts;
  }

  return c.json({ tenants, lastSnapshotAt });
});

/** module -> table read for the SLO's success/total counts over its window (ADR-0029). */
async function sloCounts(ctx: Ctx, module: string, windowStart: number): Promise<{ success: number; total: number }> {
  if (module === "events") {
    const rows = await ctx.db
      .select({ published: schema.eventOutbox.publishedAt })
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, ctx.tenantId), gte(schema.eventOutbox.createdAt, windowStart)));
    return { success: rows.filter((r) => r.published !== null).length, total: rows.length };
  }
  if (module === "webhooks") {
    const rows = await ctx.db
      .select({ status: schema.webhookDeliveries.status })
      .from(schema.webhookDeliveries)
      .where(
        and(eq(schema.webhookDeliveries.tenantId, ctx.tenantId), gte(schema.webhookDeliveries.createdAt, windowStart))
      );
    return { success: rows.filter((r) => r.status === "delivered").length, total: rows.length };
  }
  const rows = await ctx.db
    .select({ outcome: schema.aiAuditLog.outcome })
    .from(schema.aiAuditLog)
    .where(and(eq(schema.aiAuditLog.tenantId, ctx.tenantId), gte(schema.aiAuditLog.ts, windowStart)));
  return { success: rows.filter((r) => r.outcome === "ok").length, total: rows.length };
}

platformRoutes.get("/slo", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:diagnostics:read");
  const definitions = await ctx.db.select().from(schema.sloDefinitions);
  const tenantIds = await allTenants(c.env);

  const slos = [];
  for (const def of definitions) {
    const windowStart = ctx.now - def.windowDays * 24 * 60 * 60 * 1000;
    let success = 0;
    let total = 0;
    for (const tenantId of tenantIds) {
      const tctx = scopedToTenant(ctx, tenantId);
      if (!can(tctx.actor, "admin:diagnostics:read", { tenantId, module: "admin" })) continue;
      const counts = await sloCounts(tctx, def.module, windowStart);
      success += counts.success;
      total += counts.total;
    }
    const actualPercent = total === 0 ? 100 : Math.round((success / total) * 10000) / 100;
    slos.push({ ...def, actualPercent, burnPercent: Math.max(0, def.targetPercent - actualPercent) });
  }
  return c.json({ slos });
});

// The operator's own live sessions. Without this an "end impersonation"
// control cannot find the session id again after a reload, and the swap only
// clears when auth.ts starts 401ing on expiry.
platformRoutes.get("/impersonation", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:impersonate:use");
  const sessions = await ctx.db
    .select()
    .from(schema.impersonationSessions)
    .where(
      and(
        eq(schema.impersonationSessions.platformUserId, ctx.actor.id),
        isNull(schema.impersonationSessions.endedAt)
      )
    )
    .orderBy(desc(schema.impersonationSessions.startedAt));
  return c.json({ sessions });
});

const StartImpersonationBody = z
  .object({
    targetUserId: z.string().min(1),
    reason: z.string().min(1).max(500)
  })
  .strict();

const IMPERSONATION_DURATION_MS = 30 * 60 * 1000;

platformRoutes.post("/impersonation/start", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:impersonate:use");
  const input = await body(c, StartImpersonationBody);

  // The target is looked up cross-tenant by primary key on purpose: the
  // permission gating this whole route is itself the cross-tenant authority
  // (ADR-0027), and there is no tenant to scope the lookup against yet.
  const targets = await ctx.db.select().from(schema.users).where(eq(schema.users.id, input.targetUserId)).limit(1);
  const target = targets[0];
  if (!target) throw notFound("user");

  const approval = await gate(ctx, {
    policyKey: "core.impersonate",
    subjectRef: input.targetUserId,
    context: { reason: input.reason }
  });
  // `gate` only returns non-null once a second platform actor has approved —
  // `core.impersonate`'s `neverAutoApprove` guarantees it is never null here.
  if (!approval) throw notFound("approval");

  const row = {
    id: id("ims", ctx.now),
    tenantId: target.tenantId,
    platformUserId: ctx.actor.id,
    targetUserId: target.id,
    approvalId: approval.id,
    reason: input.reason,
    startedAt: ctx.now,
    expiresAt: ctx.now + IMPERSONATION_DURATION_MS,
    endedAt: null
  };
  await ctx.db.insert(schema.impersonationSessions).values(row);
  await audit(ctx, { action: "platform.impersonation.started", subjectRef: target.id, after: row });
  return created(c, row);
});

platformRoutes.post("/impersonation/:id/end", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:impersonate:use");
  const sessionId = c.req.param("id");
  const rows = await ctx.db
    .select()
    .from(schema.impersonationSessions)
    .where(eq(schema.impersonationSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  if (!row) throw notFound("impersonation session");
  if (row.platformUserId !== ctx.actor.id) throw forbidden("not your impersonation session");
  if (row.endedAt !== null) throw conflict("already ended");

  const updated = { ...row, endedAt: ctx.now };
  await ctx.db
    .update(schema.impersonationSessions)
    .set({ endedAt: ctx.now })
    .where(eq(schema.impersonationSessions.id, sessionId));
  await audit(ctx, { action: "platform.impersonation.ended", subjectRef: row.targetUserId, before: row, after: updated });
  return c.json(updated);
});

platformRoutes.get("/incidents", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:diagnostics:read");
  const rows = [];
  for (const tenantId of await allTenants(c.env)) {
    const tctx = scopedToTenant(ctx, tenantId);
    if (!can(tctx.actor, "admin:diagnostics:read", { tenantId, module: "admin" })) continue;
    const found = await tctx.db
      .select()
      .from(schema.incidents)
      .where(and(eq(schema.incidents.tenantId, tenantId), eq(schema.incidents.kind, "outage")));
    rows.push(...found);
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return c.json({ incidents: rows });
});

platformRoutes.get("/deployments", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "admin:diagnostics:read");
  const deployments = await ctx.db.select().from(schema.deployments).orderBy(desc(schema.deployments.deployedAt));
  return c.json({ deployments });
});

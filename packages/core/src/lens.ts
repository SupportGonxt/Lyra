import { eq } from "drizzle-orm";
import { id as newId, LensJson, parseJson, schema, toJson } from "@lyra/db";
import { audit } from "./audit.js";
import { scoped, type Ctx } from "./context.js";

// docs/15 §5. A Lens = role default workspace + learned personal adaptation.
// One row per (tenant, user) in `core_lenses`; no row means "still on the role
// default" — resolveLens materializes that default without ever writing it, so
// a user who never touched their lens leaves no row to migrate, export or erase.

/**
 * Role key or role prefix -> workspace slug, for the roles where the module
 * prefix is not itself the workspace. Mirrors apps/web/app/routing.ts's
 * `HOME_BY_ROLE_PREFIX` (duplicated rather than imported: packages/core may not
 * depend on an app). Unlike that table — which only picks a page guaranteed to
 * be in the nav — this one may name a specific workspace a whole prefix does
 * not otherwise get, which is why `tenant.compliance` has its own entry above
 * the generic `tenant` one.
 */
const WORKSPACE_BY_ROLE: Record<string, string> = {
  "tenant.compliance": "compliance"
};
const WORKSPACE_BY_ROLE_PREFIX: Record<string, string> = {
  tenant: "admin",
  platform: "admin",
  dev: "admin",
  partner: "distribution",
  provider: "scout",
  customer: "settings",
  finance: "ledger"
};

/** The tenant default workspace for a set of role keys: first role that resolves wins. */
export function defaultWorkspaceForRoles(roles: readonly string[]): string {
  for (const role of roles) {
    const exact = WORKSPACE_BY_ROLE[role];
    if (exact) return exact;
    const prefix = role.split(".")[0] ?? "";
    if (WORKSPACE_BY_ROLE_PREFIX[prefix]) return WORKSPACE_BY_ROLE_PREFIX[prefix];
    // Module roles (axis.agent, orbit.lead, north.exec, ...): the prefix already
    // is the workspace, so there is no table to maintain for the common case.
    if (prefix) return prefix;
  }
  // No role at all resolves to anything: NORTH Today is the platform's neutral home.
  return "north";
}

/**
 * Every workspace this actor's roles resolve to, not just the first that
 * matches (defaultWorkspaceForRoles's "first role wins" rule collapses a
 * multi-role actor down to one destination). Same three lookups per role —
 * exact key, then prefix table, then the bare prefix itself — but every
 * role's resolution is kept, not just the first role that had one. Powers
 * NorthShell's multi-role switcher (docs/superpowers/specs
 * /2026-08-15-north-shell-fork-design.md §5): an actor holding both
 * `axis.agent` and `north.exec` can reach both shells.
 */
export function availableShellsForRoles(roles: readonly string[]): string[] {
  const found = new Set<string>();
  for (const role of roles) {
    // ADR-0054: orbit.retention finishes the AXIS renewal desk itself
    // (rbac.ts grants it axis:policies:renew), so it needs the AXIS shell
    // too, not just its own. A narrow, named exception, not a generic
    // "any foreign permission implies a shell" rule — north.exec also holds
    // cross-module axis:* reads but must stay 403'd on /axis/* (axis-shell.spec.ts).
    // Checked first and added unconditionally (no continue) so it can't be
    // silently shadowed by a future WORKSPACE_BY_ROLE_PREFIX["orbit"] entry's
    // own continue — orbit.retention still falls through below to also pick
    // up its own workspace exactly as before.
    if (role === "orbit.retention") found.add("axis");
    // ADR-0105: the finance controller reconciles a provider's inbound
    // bordereau, which lives on /axis/bordereaux. The same kind of named
    // exception, for the same reason: the grant is useless without the door.
    if (role === "finance.controller") found.add("axis");
    const exact = WORKSPACE_BY_ROLE[role];
    if (exact) {
      found.add(exact);
      continue;
    }
    const prefix = role.split(".")[0] ?? "";
    const mapped = WORKSPACE_BY_ROLE_PREFIX[prefix];
    if (mapped) {
      found.add(mapped);
      continue;
    }
    if (prefix) found.add(prefix);
  }
  return found.size ? [...found] : ["north"];
}

/** The role default lens: no pins, no hidden items, comfortable density, nothing learned yet. */
export function defaultLensFor(roles: readonly string[]): LensJson {
  return LensJson.parse({ workspace: defaultWorkspaceForRoles(roles) });
}

export interface ResolvedLens {
  lens: LensJson;
  /** True while the user has never had a lens row written — still on the role default. */
  isDefault: boolean;
}

/**
 * Default-workspace routing: the lens in force for this user right now. A
 * stored row always wins over the role default, however stale its role-implied
 * workspace has become — that staleness is exactly what personal adaptation
 * (and reset) is for, not something resolution silently corrects.
 */
export async function resolveLens(ctx: Ctx, userId: string, roles: readonly string[]): Promise<ResolvedLens> {
  const rows = await ctx.db
    .select()
    .from(schema.lenses)
    .where(scoped(ctx, schema.lenses, eq(schema.lenses.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) return { lens: defaultLensFor(roles), isDefault: true };
  return { lens: parseJson(LensJson, row.lensJson), isDefault: false };
}

/** Hard cap on any one weight — a power user's history stays a small JSON blob
 *  rather than an ever-growing counter. Not a decay curve, just a ceiling. */
export const MAX_LENS_WEIGHT = 100;

/**
 * Learned adaptation: one observed interaction with a view/filter/pin nudges
 * its weight up by exactly one, capped at MAX_LENS_WEIGHT. Deterministic, no
 * ML — this is frecency-by-counter, the same "not a recommendation system"
 * scope docs/15 §5 describes for pins, ⌘K and the module rail. Creates the row
 * on first use (starting from the role default) so the very first observed
 * interaction is the one that stops the lens being virtual.
 */
export async function recordLensUsage(
  ctx: Ctx,
  userId: string,
  roles: readonly string[],
  key: string
): Promise<LensJson> {
  const current = await resolveLens(ctx, userId, roles);
  const nextWeight = Math.min(MAX_LENS_WEIGHT, (current.lens.weights[key] ?? 0) + 1);
  const next = LensJson.parse({
    ...current.lens,
    weights: { ...current.lens.weights, [key]: nextWeight }
  });

  await ctx.db
    .insert(schema.lenses)
    .values({
      id: newId("lns", ctx.now),
      tenantId: ctx.tenantId,
      userId,
      lensJson: toJson(LensJson, next),
      updatedAt: ctx.now
    })
    .onConflictDoUpdate({
      target: [schema.lenses.tenantId, schema.lenses.userId],
      set: { lensJson: toJson(LensJson, next), updatedAt: ctx.now }
    });

  return next;
}

/**
 * Reset: discard learned adaptation, hand the user back the tenant/role
 * default. Deletes the stored row rather than overwriting it with the default
 * JSON — resolveLens already treats "no row" as the default, so a reset stays
 * correct even if the role default's definition changes later. Always
 * audited, even when there was nothing stored to discard: the reset was still
 * requested and acted on.
 */
export async function resetLens(ctx: Ctx, userId: string, roles: readonly string[]): Promise<LensJson> {
  const rows = await ctx.db
    .select()
    .from(schema.lenses)
    .where(scoped(ctx, schema.lenses, eq(schema.lenses.userId, userId)))
    .limit(1);
  const before = rows[0] ? parseJson(LensJson, rows[0].lensJson) : null;
  const after = defaultLensFor(roles);

  if (rows[0]) {
    await ctx.db.delete(schema.lenses).where(scoped(ctx, schema.lenses, eq(schema.lenses.userId, userId)));
  }
  await audit(ctx, { action: "core.lens.reset", subjectRef: userId, before, after });
  return after;
}

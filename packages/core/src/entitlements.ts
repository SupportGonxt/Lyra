import type { EntitlementsJson, PolicyJson } from "@lyra/db";
import { moduleEnabled } from "./module-config.js";
import { schema } from "@lyra/db";
import { forbidden } from "./errors.js";
import { scoped, type Ctx } from "./context.js";
import type { Grant } from "./rbac.js";

// docs/21. Entitlements say what a tenant bought; RBAC says what a person may
// do inside that. Enforcement is subtraction: a permission for a module the
// tenant has not licensed simply does not exist for its actors, so every
// require_/can() check and the /v1/me nav fall out of one filter.

/** The switchable modules — exactly the EntitlementsJson.modules enum. Core,
 * dist, ledger, ai, analytics and compliance are the platform itself, never gated. */
export const GATED_MODULES = ["axis", "orbit", "signal", "scout", "north"] as const;

/**
 * Whether a tenant can use a module now: it bought it and has not switched it
 * off (ADR-0087). The platform (core, dist, ledger, …) is never gated. The
 * question an engine asks when a sibling module's data may simply not exist.
 */
export function moduleOn(ctx: { entitlements: EntitlementsJson; policy: PolicyJson }, module: string): boolean {
  if (!(GATED_MODULES as readonly string[]).includes(module)) return true;
  return ctx.entitlements.modules.includes(module as (typeof GATED_MODULES)[number]) && moduleEnabled(ctx.policy, module);
}

/**
 * Drop permissions belonging to modules the tenant is not entitled to, or has
 * switched off itself (`policy.moduleConfig[m].enabled === false`, set by
 * PATCH /v1/core/modules/:module/config — ADR-0087). One subtraction for both:
 * what was bought and what is turned on answer the same question, so a
 * switched-off module refuses its routes and leaves the nav exactly as an
 * unlicensed one does, and core staying ungated is what lets it be turned
 * back on. Literal module prefixes only: a wildcard-module grant (`*:*:*`) is
 * platform staff acting across tenants and stays whole.
 */
export function entitledGrants(
  grants: readonly Grant[],
  entitlements: EntitlementsJson,
  moduleConfig: Readonly<Record<string, { enabled?: boolean }>> = {}
): Grant[] {
  const off = GATED_MODULES.filter(
    (m) => !entitlements.modules.includes(m) || moduleConfig[m]?.enabled === false
  );
  if (off.length === 0) return [...grants];
  return grants.map((g) => ({
    ...g,
    permissions: g.permissions.filter((p) => !off.some((m) => p.startsWith(`${m}:`)))
  }));
}

/**
 * Refuse to create one more user when the tenant's seats are all taken.
 * Call before inserting into core_users; counts live (non-deleted) users.
 */
export async function assertSeatAvailable(ctx: Ctx): Promise<void> {
  const rows = await ctx.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(scoped(ctx, schema.users))
    .limit(ctx.entitlements.seats);
  if (rows.length >= ctx.entitlements.seats) {
    throw forbidden(`seat limit reached (${ctx.entitlements.seats} seats)`);
  }
}

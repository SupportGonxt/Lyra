import { and, desc, eq, inArray } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx, Purposes } from "@lyra/core";

// Current consent and suppression as SIGNAL's scorers need them: one map for a
// whole book, not one query per person. Shared by the lookalike expansion
// (ADR-0113), which reads every customer, and the outreach resolver, which
// re-checks a lookalike's members at send time — two callers, one reading of
// "current", so a lookalike cannot be built on one definition of consent and
// sent on another.
//
// "Current" is the same rule packages/core/src/consent.ts `currentConsent`
// applies per person: the newest row wins, and an expired row grants nothing.

const CHUNK = 90;

/**
 * Each customer's current purposes; a customer with no row, or whose newest row
 * has expired, maps to null. `customerIds` narrows the read; omitted, it is the
 * whole tenant.
 *
 * ponytail: the whole-tenant read is O(consent history) in JS, the same scan
 * `refreshSuppressionAudience` does. Upgrade path is a materialized
 * latest-consent-per-customer table if it shows up in a profile.
 */
export async function currentPurposes(ctx: Ctx, customerIds?: readonly string[]): Promise<Map<string, Purposes | null>> {
  const select = () =>
    ctx.db
      .select({
        customerId: schema.consents.customerId,
        purposesJson: schema.consents.purposesJson,
        expiry: schema.consents.expiry
      })
      .from(schema.consents);
  const rows: { customerId: string; purposesJson: string; expiry: number | null }[] = [];
  if (customerIds === undefined) {
    rows.push(...(await select().where(eq(schema.consents.tenantId, ctx.tenantId)).orderBy(desc(schema.consents.ts))));
  } else {
    // D1 binds at most 100 parameters per statement.
    for (let i = 0; i < customerIds.length; i += CHUNK) {
      rows.push(
        ...(await select()
          .where(and(eq(schema.consents.tenantId, ctx.tenantId), inArray(schema.consents.customerId, customerIds.slice(i, i + CHUNK))))
          .orderBy(desc(schema.consents.ts)))
      );
    }
  }
  const out = new Map<string, Purposes | null>();
  for (const row of rows) {
    if (out.has(row.customerId)) continue;
    out.set(row.customerId, row.expiry != null && row.expiry <= ctx.now ? null : parsePurposes(row.purposesJson));
  }
  return out;
}

/** Customers on SIGNAL's own suppression: a prospect suppressed by withdrawn consent (ADR-0091). */
export async function suppressedCustomerIds(ctx: Ctx): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ customerId: schema.signalProspects.customerId })
    .from(schema.signalProspects)
    .where(and(eq(schema.signalProspects.tenantId, ctx.tenantId), eq(schema.signalProspects.state, "suppressed")));
  return new Set(rows.map((r) => r.customerId));
}

/** A consent row's purposes; anything unreadable grants nothing. */
function parsePurposes(raw: string): Purposes | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Purposes) : null;
  } catch {
    return null;
  }
}

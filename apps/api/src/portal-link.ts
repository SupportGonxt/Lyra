import { eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, hmacHex, type Ctx } from "@lyra/core";
import { fieldKey, type Env } from "./env.js";

// The hosted renewal and feedback pages (routes/portal.ts) open on a derived
// credential: an HMAC over kind, tenant and row, keyed by FIELD_KEY. One module
// mints it for every sender — the staff route that hands a link to a person and
// the journey `survey` node that posts one into a conversation — so the two can
// never disagree about what a valid link looks like.

export type PortalLinkKind = "renewal" | "feedback";

/** The credential in a renewal/feedback link. */
export async function portalLinkToken(
  env: Pick<Env, "FIELD_KEY">,
  kind: PortalLinkKind,
  tenantId: string,
  rowId: string
): Promise<string> {
  return hmacHex(fieldKey(env), `portal-link.v1:${kind}:${tenantId}:${rowId}`);
}

/** The whole hosted link for one row. The slug, not the id, is what the portal routes key on. */
export async function portalLink(
  ctx: Ctx,
  env: Pick<Env, "FIELD_KEY" | "APP_ORIGIN">,
  kind: PortalLinkKind,
  rowId: string
): Promise<string> {
  // `tenants` is the scoping table itself, so it is read by primary key rather
  // than through withTenant's filter.
  const [tenant] = await ctx.db
    .select({ slug: schema.tenants.slug })
    .from(schema.tenants)
    .where(eq(schema.tenants.id, ctx.tenantId))
    .limit(1);
  if (!tenant) throw badRequest("tenant");
  const token = await portalLinkToken(env, kind, ctx.tenantId, rowId);
  const path = kind === "renewal" ? `renewals/${rowId}` : `feedback/${rowId}`;
  return `${env.APP_ORIGIN}/portal/${tenant.slug}/${path}?token=${token}`;
}

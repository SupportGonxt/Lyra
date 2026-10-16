import { and, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, type Ctx, type Envelope } from "@lyra/core";

// The consumer for `signal.creative.flagged` (engines/signal-creative.ts).
//
// Until this existed the event had no subscriber: a generated variant the
// pre-flight flagged went into the approvals queue and the bus carried an
// announcement nobody read. `signal-dev.tsx` listed it as "emitted: true" and
// that was the whole truth — the same shape as `north.alert.triggered` before
// `north-alert-notify.ts`, found the same way.
//
// Delivery is the in-app inbox (`core_notifications`) — the path NORTH's rules,
// DSAR acknowledgements, schedule failures and the anomaly guard all use.
// CLAUDE.md §13: no mail or chat service is added to fill this gap.
//
// A flagged variant is not an emergency, so nothing here is eager: one notice
// per creative per reviewer, and a second re-flag of the same variant says
// nothing new to the person who has already been told and not yet acted.

const KIND = "review";
const TITLE_KEY = "signal.creative.flagged";

/**
 * Holds `signal:creatives:approve` (rbac.ts) — the people who can clear a
 * flagged variant or block it. The publish route deliberately asks for
 * `signal:creatives:publish` instead, so these are the reviewers and not the
 * publishers: telling the person who cannot decide is how a queue stalls.
 */
const REVIEWER_ROLE = "tenant.compliance";

interface FlaggedData {
  creativeId?: string;
  campaignId?: string | null;
  rules?: string[];
}

/** Everyone in this tenant holding the reviewer role. Empty when nobody does. */
async function reviewers(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(
      and(
        eq(schema.userRoles.tenantId, ctx.tenantId),
        eq(schema.roles.tenantId, ctx.tenantId),
        eq(schema.roles.key, REVIEWER_ROLE)
      )
    );
  return [...new Set(rows.map((row) => row.userId))];
}

export async function onCreativeFlagged(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as FlaggedData;
  const creativeId = data.creativeId ?? envelope.subject;
  if (!creativeId) return;

  const recipients = await reviewers(ctx);
  // A tenant with no compliance seat is a tenant that cannot clear a variant.
  // Notifying nobody is the honest outcome; the audit row is where it shows.
  if (!recipients.length) {
    await audit(ctx, {
      action: "signal.creative.flagged_unnotified",
      subjectRef: `signal_creative:${creativeId}`,
      after: { reason: "no reviewer", role: REVIEWER_ROLE, rules: data.rules ?? [] }
    });
    return;
  }

  // Already told about this variant: the inbox is a queue, not a log.
  const already = await ctx.db
    .select({ userId: schema.notifications.userId })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.tenantId, ctx.tenantId),
        eq(schema.notifications.titleKey, TITLE_KEY),
        eq(schema.notifications.subjectRef, creativeId),
        inArray(schema.notifications.userId, recipients)
      )
    );
  const told = new Set(already.map((row) => row.userId));
  const fresh = recipients.filter((userId) => !told.has(userId));
  if (!fresh.length) return;

  // Rule 7: a key and its parameters, never a rendered sentence.
  const params = { creativeId, campaignId: data.campaignId ?? null, rules: data.rules ?? [] };
  await ctx.db.insert(schema.notifications).values(
    fresh.map((userId) => ({
      id: newId("ntf", ctx.now),
      tenantId: ctx.tenantId,
      userId,
      kind: KIND,
      titleKey: TITLE_KEY,
      paramsJson: JSON.stringify(params),
      subjectRef: creativeId,
      readAt: null,
      createdAt: ctx.now
    }))
  );
  await audit(ctx, {
    action: "signal.creative.flagged_notified",
    subjectRef: `signal_creative:${creativeId}`,
    after: { notified: fresh.length, role: REVIEWER_ROLE, rules: params.rules }
  });
}

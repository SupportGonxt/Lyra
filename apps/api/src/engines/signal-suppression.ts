import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { id as newId, schema, PurposesJson, parseJson } from "@lyra/db";
import { audit, actorRef, SUPPRESSION_AUDIENCE_NAME, type Ctx, type Envelope } from "@lyra/core";

// docs/25 M4 SIGNAL row — "suppression propagation test": a consumer wired to
// core.consent.updated that refreshes the suppression audience and cascades to
// live campaign membership. Runs inline off the outbox drain (dispatch.ts), so
// consent withdrawal -> suppression is one drain tick, not a 15-minute cron.

/** The seed writes this row too, so the name comes from @lyra/core and there is
 *  exactly one literal for it. */
export { SUPPRESSION_AUDIENCE_NAME } from "@lyra/core";

interface ConsentUpdatedData {
  customerId: string;
  purposes?: { marketing?: boolean };
}

/**
 * ponytail: suppression here is consent-only (purposes.marketing === false).
 * The seed's suppression audience also covers complaints and open claims
 * (AXIS case/claim state) — those are a different event's job to add once
 * AXIS emits one; wiring a second cause into the same audience is the upgrade
 * path, not a reason to block this one.
 */
export async function onConsentUpdated(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as ConsentUpdatedData;
  if (data.purposes?.marketing !== false) return; // only withdrawal suppresses

  const audienceId = await findOrCreateSuppressionAudience(ctx);
  const size = await refreshSuppressionAudience(ctx, audienceId);

  for (const campaignId of await liveCampaignsExcluding(ctx, audienceId)) {
    await audit(ctx, {
      action: "signal.suppression.propagated",
      subjectRef: `signal_campaign:${campaignId}`,
      after: { customerId: data.customerId, audienceId, sizeCached: size }
    });
  }
}

async function findOrCreateSuppressionAudience(ctx: Ctx): Promise<string> {
  const existing = await ctx.db
    .select({ id: schema.signalAudiences.id })
    .from(schema.signalAudiences)
    .where(
      and(
        eq(schema.signalAudiences.tenantId, ctx.tenantId),
        eq(schema.signalAudiences.name, SUPPRESSION_AUDIENCE_NAME)
      )
    )
    .limit(1);
  if (existing[0]) return existing[0].id;

  const id = newId("aud", ctx.now);
  await ctx.db.insert(schema.signalAudiences).values({
    id,
    tenantId: ctx.tenantId,
    name: SUPPRESSION_AUDIENCE_NAME,
    definitionJson: JSON.stringify({
      any: [{ field: "consent.marketing", op: "eq", value: false }]
    }),
    sizeCached: 0,
    refreshPolicy: "hourly",
    consentPurposes: "none",
    createdBy: actorRef(ctx),
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  return id;
}

/**
 * ponytail: recomputed from ground truth (latest consent row per customer) on
 * every withdrawal instead of incremented — replay-safe with no counter to
 * keep in sync. O(n) over the tenant's consent history; upgrade path is a
 * materialized "latest consent per customer" table if that scan ever shows up
 * in a profile.
 */
async function refreshSuppressionAudience(ctx: Ctx, audienceId: string): Promise<number> {
  const rows = await ctx.db
    .select({ customerId: schema.consents.customerId, purposesJson: schema.consents.purposesJson })
    .from(schema.consents)
    .where(eq(schema.consents.tenantId, ctx.tenantId))
    .orderBy(desc(schema.consents.ts));

  const latestByCustomer = new Map<string, string>();
  for (const row of rows) {
    if (!latestByCustomer.has(row.customerId)) latestByCustomer.set(row.customerId, row.purposesJson);
  }

  let size = 0;
  for (const purposesJson of latestByCustomer.values()) {
    if (parseJson(PurposesJson, purposesJson).marketing === false) size++;
  }

  await ctx.db
    .update(schema.signalAudiences)
    .set({ sizeCached: size, lastRefreshedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(schema.signalAudiences.id, audienceId));
  return size;
}

/** Live campaigns that target the suppression audience directly, or exclude it. */
async function liveCampaignsExcluding(ctx: Ctx, suppressionAudienceId: string): Promise<string[]> {
  const campaigns = await ctx.db
    .select({ id: schema.signalCampaigns.id, audienceId: schema.signalCampaigns.audienceId })
    .from(schema.signalCampaigns)
    .where(
      and(
        eq(schema.signalCampaigns.tenantId, ctx.tenantId),
        eq(schema.signalCampaigns.state, "live"),
        isNull(schema.signalCampaigns.deletedAt)
      )
    );

  const audienceIds = [
    ...new Set(campaigns.map((c) => c.audienceId).filter((id): id is string => id != null))
  ];
  const referencing = new Set<string>([suppressionAudienceId]);
  if (audienceIds.length) {
    const audiences = await ctx.db
      .select({ id: schema.signalAudiences.id, definitionJson: schema.signalAudiences.definitionJson })
      .from(schema.signalAudiences)
      .where(
        and(eq(schema.signalAudiences.tenantId, ctx.tenantId), inArray(schema.signalAudiences.id, audienceIds))
      );
    for (const a of audiences) {
      let excludeAudienceId: unknown;
      try {
        excludeAudienceId = JSON.parse(a.definitionJson)?.excludeAudienceId;
      } catch {
        continue;
      }
      if (excludeAudienceId === suppressionAudienceId) referencing.add(a.id);
    }
  }

  return campaigns.filter((c) => c.audienceId && referencing.has(c.audienceId)).map((c) => c.id);
}

/* ---------------------------------------------------- the suppression floor */

// docs/modules/signal.md §2.2: "suppression lists always applied (recent
// purchasers, do-not-contact, complainers)". Consent was the only one wired:
// the file above says so in its own words, and the seed's suppression audience
// advertises all three. So a UAE marketing team's first send would have emailed
// people who bought last week and people with an open regulated complaint — the
// two most reliable ways to turn a legitimate campaign into a complaint.
//
// This is a *floor*, not an audience rule, and that is deliberate: consent, the
// frequency cap and quiet hours are floors too. A tenant can build any audience
// it likes; none of them may reach someone this function suppresses.

/** Days after a purchase during which marketing is suppressed. */
export const PURCHASER_WINDOW_DAYS = 30;
/** Days after a complaint is resolved during which marketing is suppressed. */
export const COMPLAINER_WINDOW_DAYS = 30;

export type SuppressionReason = "recent_purchaser" | "complainer";

export interface SuppressionWindows {
  purchaserDays: number;
  complainerDays: number;
}

/** The windows this tenant runs, from `moduleConfig.signal.settings.suppression`. */
export function suppressionWindows(settings: Record<string, unknown>): SuppressionWindows {
  const raw = settings.suppression;
  const bag = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const days = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 3650 ? value : fallback;
  return {
    purchaserDays: days(bag.purchaserDays, PURCHASER_WINDOW_DAYS),
    complainerDays: days(bag.complainerDays, COMPLAINER_WINDOW_DAYS)
  };
}

/** Whether a purchase that landed at `boundAt` still suppresses contact. */
export function purchaseSuppresses(boundAt: number, now: number, windows: SuppressionWindows): boolean {
  return now - boundAt <= windows.purchaserDays * 86_400_000;
}

/**
 * Whether a complaint suppresses contact. An **open** complaint always does —
 * whatever its age — because marketing to somebody mid-complaint is the case
 * that becomes a regulator's letter. A resolved one suppresses for the window.
 */
export function complaintSuppresses(
  complaint: { state: string; resolvedAt: number | null },
  now: number,
  windows: SuppressionWindows
): boolean {
  if (complaint.resolvedAt === null) return true;
  return now - complaint.resolvedAt <= windows.complainerDays * 86_400_000;
}

const CLOSED_COMPLAINT_STATES = new Set(["resolved", "closed"]);

export interface SuppressionFloor {
  /** Customer id → why they are suppressed. First reason wins; the order is stable. */
  byCustomer: Map<string, SuppressionReason>;
  counts: { recent_purchaser: number; complainer: number };
  windows: SuppressionWindows;
}

/**
 * The customers a marketing send may not touch, for reasons other than consent.
 *
 * Reads two facts the platform already holds: a bind touch
 * (`signal_attribution_events.touch_type = 'bind'`) is a purchase, and an
 * `axis_complaints` row is a regulated complaint with a state and a resolution
 * date. Nothing here is inferred, and nothing is guessed from a case's `kind`.
 */
export async function suppressionFloor(
  ctx: Ctx,
  settings: Record<string, unknown> = {},
  customerIds?: readonly string[]
): Promise<SuppressionFloor> {
  const windows = suppressionWindows(settings);
  const byCustomer = new Map<string, SuppressionReason>();

  const scoped = customerIds && customerIds.length > 0 ? [...customerIds] : null;
  // D1 binds at most 100 parameters per statement.
  const chunks: (readonly string[] | null)[] = scoped
    ? Array.from({ length: Math.ceil(scoped.length / 90) }, (_, i) => scoped.slice(i * 90, i * 90 + 90))
    : [null];

  for (const chunk of chunks) {
    // Two predicates, not one: an `inArray` carries its own table reference, so
    // reusing the attribution one on the complaints query filters on a column
    // that is not in that FROM.
    const withinPurchases = chunk ? inArray(schema.signalAttributionEvents.customerId, chunk as string[]) : undefined;
    const withinComplaints = chunk ? inArray(schema.axisComplaints.customerId, chunk as string[]) : undefined;
    const purchases = await ctx.db
      .select({ customerId: schema.signalAttributionEvents.customerId, ts: schema.signalAttributionEvents.ts })
      .from(schema.signalAttributionEvents)
      .where(
        and(
          eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
          eq(schema.signalAttributionEvents.touchType, "bind"),
          gte(schema.signalAttributionEvents.ts, ctx.now - windows.purchaserDays * 86_400_000),
          ...(withinPurchases ? [withinPurchases] : [])
        )
      );
    for (const row of purchases) {
      if (row.customerId && !byCustomer.has(row.customerId)) byCustomer.set(row.customerId, "recent_purchaser");
    }

    const complaints = await ctx.db
      .select({
        customerId: schema.axisComplaints.customerId,
        state: schema.axisComplaints.state,
        resolvedAt: schema.axisComplaints.resolvedAt
      })
      .from(schema.axisComplaints)
      .where(
        and(
          eq(schema.axisComplaints.tenantId, ctx.tenantId),
          // An open complaint is unbounded in age; a resolved one is only
          // relevant inside its window, so the SQL filter takes both.
          or(
            sql`${schema.axisComplaints.resolvedAt} is null`,
            gte(schema.axisComplaints.resolvedAt, ctx.now - windows.complainerDays * 86_400_000)
          ),
          ...(withinComplaints ? [withinComplaints] : [])
        )
      );
    for (const row of complaints) {
      if (!row.customerId) continue;
      if (CLOSED_COMPLAINT_STATES.has(row.state) && row.resolvedAt === null) continue;
      if (!complaintSuppresses({ state: row.state, resolvedAt: row.resolvedAt }, ctx.now, windows)) continue;
      // A purchaser who also has an open complaint is a complainer first: that
      // is the fact an operator needs to see.
      byCustomer.set(row.customerId, "complainer");
    }
  }

  const counts = { recent_purchaser: 0, complainer: 0 };
  for (const reason of byCustomer.values()) counts[reason] += 1;
  return { byCustomer, counts, windows };
}

import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { cacRange, type CacRange, type Ctx, type Envelope } from "@lyra/core";
import { alias } from "drizzle-orm/sqlite-core";

// The acquisition funnel. `signal_attribution_events` was a dead seam: the
// table existed and north-snapshotter read it for CAC, but nothing ever wrote
// a row — so every funnel metric answered zero. This engine is the writer.
//
// Two write paths:
//   1. Public tracking — the pixel/SDK posts impression|click|visit touches
//      through the portal route (routes/portal.ts), keyed by anonId so a
//      visitor who never identifies still counts.
//   2. Event consumption — when AXIS issues a policy (`axis.policy.issued`),
//      the most recent attributed lead for that customer becomes a `bind`
//      touch, closing the funnel and giving SIGNAL a conversion to credit.
//
// Attribution is last-touch: the newest lead/click before the bind wins.
// That is the simplest model that answers "which campaign bought this
// customer", and it is what the budget autopilot's CAC window already assumes.

export type TouchType = "impression" | "click" | "visit" | "lead" | "bind";

/** Record one touch. Public tracking and event consumers both route here. */
export async function recordTouch(
  ctx: Ctx,
  touch: {
    touchType: TouchType;
    channel: string;
    campaignId?: string | null;
    creativeId?: string | null;
    customerId?: string | null;
    anonId?: string | null;
    valueMinor?: number | null;
    currency?: string | null;
    subjectRef?: string | null;
  }
): Promise<string> {
  const id = newId("att", ctx.now);
  await ctx.db.insert(schema.signalAttributionEvents).values({
    id,
    tenantId: ctx.tenantId,
    customerId: touch.customerId ?? null,
    anonId: touch.anonId ?? null,
    touchType: touch.touchType,
    channel: touch.channel,
    campaignId: touch.campaignId ?? null,
    creativeId: touch.creativeId ?? null,
    valueMinor: touch.valueMinor ?? null,
    currency: touch.currency ?? null,
    subjectRef: touch.subjectRef ?? null,
    ts: ctx.now
  });
  return id;
}

/**
 * When a policy is issued, close the funnel: find the most recent attributed
 * lead for that customer and stamp a `bind` touch carrying the policy's value.
 * Returns the bind touch id, or null when the customer has no attributed lead
 * (an organic bind — SIGNAL gets no credit, which is the honest answer).
 */
export async function onBindIssued(ctx: Ctx, event: Envelope): Promise<string | null> {
  const data = event.data as { policyId?: string; customerId?: string; premiumMinor?: number; currency?: string };
  const customerId = data.customerId;
  if (!customerId) return null;

  // Last-touch: the newest lead for this customer, regardless of campaign, is
  // the one the bind is credited to. A customer with no lead row was organic.
  const [lead] = await ctx.db
    .select()
    .from(schema.signalAttributionEvents)
    .where(
      and(
        eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
        eq(schema.signalAttributionEvents.customerId, customerId),
        eq(schema.signalAttributionEvents.touchType, "lead")
      )
    )
    .orderBy(desc(schema.signalAttributionEvents.ts))
    .limit(1);

  if (!lead) return null;

  return recordTouch(ctx, {
    touchType: "bind",
    channel: lead.channel,
    campaignId: lead.campaignId,
    creativeId: lead.creativeId,
    customerId,
    anonId: lead.anonId,
    valueMinor: data.premiumMinor ?? null,
    currency: data.currency ?? null,
    subjectRef: data.policyId ?? null
  });
}

/** Funnel counts per campaign for a window — what the measurement screen reads. */
export async function funnelByCampaign(
  ctx: Ctx,
  since: number,
  until: number
): Promise<
  Array<{
    campaignId: string | null;
    channel: string;
    impressions: number;
    clicks: number;
    visits: number;
    leads: number;
    binds: number;
    valueMinor: number;
  }>
> {
  const rows = await ctx.db
    .select({
      campaignId: schema.signalAttributionEvents.campaignId,
      channel: schema.signalAttributionEvents.channel,
      touchType: schema.signalAttributionEvents.touchType,
      n: sql<number>`count(*)`,
      value: sql<number>`coalesce(sum(${schema.signalAttributionEvents.valueMinor}), 0)`
    })
    .from(schema.signalAttributionEvents)
    .where(
      and(
        eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
        gte(schema.signalAttributionEvents.ts, since),
        sql`${schema.signalAttributionEvents.ts} < ${until}`
      )
    )
    .groupBy(
      schema.signalAttributionEvents.campaignId,
      schema.signalAttributionEvents.channel,
      schema.signalAttributionEvents.touchType
    );

  const byKey = new Map<
    string,
    { campaignId: string | null; channel: string; impressions: number; clicks: number; visits: number; leads: number; binds: number; valueMinor: number }
  >();
  for (const row of rows) {
    const key = `${row.campaignId ?? "organic"}:${row.channel}`;
    const agg =
      byKey.get(key) ??
      { campaignId: row.campaignId, channel: row.channel, impressions: 0, clicks: 0, visits: 0, leads: 0, binds: 0, valueMinor: 0 };
    if (row.touchType === "impression") agg.impressions += row.n;
    else if (row.touchType === "click") agg.clicks += row.n;
    else if (row.touchType === "visit") agg.visits += row.n;
    else if (row.touchType === "lead") agg.leads += row.n;
    else if (row.touchType === "bind") {
      agg.binds += row.n;
      agg.valueMinor += row.value;
    }
    byKey.set(key, agg);
  }
  return [...byKey.values()];
}

export interface AcquisitionCostRange {
  since: number;
  until: number;
  channel: string | null;
  currency: string | null;
  spendMinor: number;
  /** Binds credited last-touch — the reporting model, and the range's point. */
  binds: number;
  /** Null when nothing was acquired: there is no acquisition to price. */
  range: CacRange | null;
}

/**
 * docs/17 SIG-057, ADR-0109: what an acquisition cost, as an interval with its
 * method named. Same basis as NORTH's `cost_per_acquisition` — spend over
 * attributed `bind` touches in the window — so the range's point is that
 * metric exactly.
 *
 * For one channel the credit is model-dependent, and the envelope names it:
 * the fewest binds any single-credit model gives the channel are its
 * last-touch binds whose customer touched no other channel first; the most are
 * every bind whose customer touched it at all before binding. For SIGNAL as a
 * whole every model credits every bind, so the envelope collapses.
 */
export async function acquisitionCostRange(
  ctx: Ctx,
  window: { since: number; until: number; channel?: string | null; currency?: string | null }
): Promise<AcquisitionCostRange> {
  const channel = window.channel ?? null;
  const currency = window.currency ?? null;
  // The bind row is aliased `b` and named by that alias in raw SQL: drizzle
  // renders a column inside a select field unqualified, so `${column}` in the
  // correlated subquery would resolve to the inner `p` and compare the scan
  // against itself — true for every row.
  const touches = alias(schema.signalAttributionEvents, "b");
  const spend = schema.signalSpend;

  // A prior non-bind touch by the same customer, at or before this bind.
  const prior = (extra: ReturnType<typeof sql>) =>
    sql<number>`exists (select 1 from signal_attribution_events p
      where p.tenant_id = b.tenant_id and p.customer_id = b.customer_id
        and p.touch_type <> 'bind' and p.ts <= b.ts and ${extra})`;

  const [spent, binds] = await Promise.all([
    ctx.db
      .select({ v: sql<number>`coalesce(sum(${spend.amountMinor}), 0)` })
      .from(spend)
      .where(
        and(
          eq(spend.tenantId, ctx.tenantId),
          gte(spend.ts, window.since),
          lt(spend.ts, window.until),
          channel === null ? undefined : eq(spend.channel, channel),
          currency === null ? undefined : eq(spend.currency, currency)
        )
      )
      .then((rows) => rows[0]?.v ?? 0),
    ctx.db
      .select({
        channel: touches.channel,
        mixed: prior(sql`p.channel <> b.channel`),
        touched: prior(sql`p.channel = ${channel ?? ""}`)
      })
      .from(touches)
      .where(and(eq(touches.tenantId, ctx.tenantId), eq(touches.touchType, "bind"), gte(touches.ts, window.since), lt(touches.ts, window.until)))
  ]);

  const credited = channel === null ? binds : binds.filter((bind) => bind.channel === channel);
  const creditLow = channel === null ? binds.length : credited.filter((bind) => !bind.mixed).length;
  const creditHigh = channel === null ? binds.length : binds.filter((bind) => bind.channel === channel || bind.touched).length;
  return {
    since: window.since,
    until: window.until,
    channel,
    currency,
    spendMinor: spent,
    binds: credited.length,
    range: cacRange({ spendMinor: spent, conversions: credited.length, creditLow, creditHigh })
  };
}

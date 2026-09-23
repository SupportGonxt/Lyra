import { and, eq, inArray } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, type Ctx, type Envelope } from "@lyra/core";

// The consumer for `north.alert.triggered` (north-snapshotter.ts). Until this
// existed the event had no subscriber and a rule's `notifyChannelRef` was never
// read, so a threshold an analyst set up told nobody anything.
//
// Delivery is the in-app inbox (core_notifications) — the same path DSAR
// acknowledgements, stale-key nudges and schedule failures use. CLAUDE.md §13:
// no email or chat service is added to fill this gap; a `slack:`-style ref is
// unresolvable here and falls back like an empty one, and the audit row says so.
//
// `notifyChannelRef` grammar, the refs this codebase already speaks:
//   user:<userId>   that user, if they belong to this tenant
//   role:<roleKey>  every holder of that role in this tenant
//   anything else   → the fallback role, the people who author alert rules

const KIND = "alert";
const TITLE_KEY = "north.alert.triggered";
/** Holds `north:alerts:write` (rbac.ts) — whoever can set a rule is told when it fires. */
const FALLBACK_ROLE = "north.analyst";

interface AlertTriggeredData {
  ruleId?: string;
  metricKey?: string;
  value?: number;
  thresholdValue?: number;
  operator?: string;
  grain?: string;
  period?: string;
}

async function holdersOf(ctx: Ctx, roleKey: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .where(
      and(
        eq(schema.userRoles.tenantId, ctx.tenantId),
        eq(schema.roles.tenantId, ctx.tenantId),
        eq(schema.roles.key, roleKey)
      )
    );
  return [...new Set(rows.map((r) => r.userId))];
}

async function tenantUser(ctx: Ctx, userId: string): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, userId)))
    .limit(1);
  return rows.map((r) => r.id);
}

/** Who the ref names, resolved inside this tenant. Empty when it names no one reachable. */
export async function recipientsOf(ctx: Ctx, ref: string | null): Promise<string[]> {
  if (!ref) return [];
  const at = ref.indexOf(":");
  const kind = at > 0 ? ref.slice(0, at) : "";
  const value = at > 0 ? ref.slice(at + 1) : "";
  if (!value) return [];
  if (kind === "user") return tenantUser(ctx, value);
  if (kind === "role") return holdersOf(ctx, value);
  return [];
}

export async function onAlertTriggered(ctx: Ctx, envelope: Envelope): Promise<void> {
  const data = envelope.data as AlertTriggeredData;
  const ruleId = data.ruleId ?? envelope.subject;
  if (!ruleId) return;

  const [rule] = await ctx.db
    .select()
    .from(schema.northAlertRules)
    .where(and(eq(schema.northAlertRules.tenantId, ctx.tenantId), eq(schema.northAlertRules.id, ruleId)))
    .limit(1);
  // Deleted or switched off between the snapshot and the drain: the analyst's
  // latest word wins.
  if (!rule || !rule.enabled) return;

  const named = await recipientsOf(ctx, rule.notifyChannelRef);
  const fellBack = named.length === 0;
  const recipients = fellBack ? await holdersOf(ctx, FALLBACK_ROLE) : named;
  if (!recipients.length) return;

  // The snapshotter re-evaluates open periods every run, so a breach on
  // today's number fires nightly (and on every manual run). One notice per
  // rule per period per person: the inbox is not a log.
  const period = data.period ?? "";
  const already = await ctx.db
    .select({ userId: schema.notifications.userId, paramsJson: schema.notifications.paramsJson })
    .from(schema.notifications)
    .where(
      and(
        eq(schema.notifications.tenantId, ctx.tenantId),
        eq(schema.notifications.titleKey, TITLE_KEY),
        eq(schema.notifications.subjectRef, rule.id),
        inArray(schema.notifications.userId, recipients)
      )
    );
  const told = new Set(
    already
      .filter((n) => {
        try {
          const p = JSON.parse(n.paramsJson ?? "{}") as { period?: string; grain?: string };
          return (p.period ?? "") === period && (p.grain ?? "") === (data.grain ?? "");
        } catch {
          return false;
        }
      })
      .map((n) => n.userId)
  );
  const fresh = recipients.filter((u) => !told.has(u));
  if (!fresh.length) return;

  // Rule 7: a key and its parameters, never a sentence.
  const params = {
    metricKey: data.metricKey ?? rule.metricKey,
    operator: data.operator ?? rule.operator,
    value: data.value ?? null,
    thresholdValue: data.thresholdValue ?? rule.thresholdValue,
    grain: data.grain ?? rule.windowGrain,
    period
  };
  await ctx.db.insert(schema.notifications).values(
    fresh.map((userId) => ({
      id: newId("ntf", ctx.now),
      tenantId: ctx.tenantId,
      userId,
      kind: KIND,
      titleKey: TITLE_KEY,
      paramsJson: JSON.stringify(params),
      subjectRef: rule.id,
      readAt: null,
      createdAt: ctx.now
    }))
  );
  await audit(ctx, {
    action: "north.alert.notified",
    subjectRef: `north_alert_rule:${rule.id}`,
    after: {
      notified: fresh.length,
      period,
      ...(fellBack ? { fallbackRole: FALLBACK_ROLE, unresolvedRef: rule.notifyChannelRef } : {})
    }
  });
}

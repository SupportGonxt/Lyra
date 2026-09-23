import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx } from "./context.js";

/**
 * Journey health (docs/06 §3): each documented journey as a funnel read from
 * the audit log, which already records every step append-only and hash-chained
 * — so nothing new is instrumented and nothing can be back-filled to flatter a
 * number. A step counts the audit rows whose action is one of its actions.
 *
 * Every action string below was found in live code, not in seed data
 * (2026-09-23 research, file:line per action). Journeys the log cannot see —
 * a push opened, an SDK snippet read — are left out rather than approximated.
 * Counts are tenant-level: a step is "how many times this happened", not a
 * per-subject cohort, because the same record carries different subject-ref
 * shapes in different writers.
 */
export interface JourneyFunnel {
  id: string;
  /** The role the journey is written for (docs/06 §2). */
  persona: string;
  steps: { key: string; actions: readonly string[] }[];
}

export const JOURNEY_FUNNELS: readonly JourneyFunnel[] = [
  { id: "J-C1", persona: "customer", steps: [
    { key: "lead", actions: ["dist.quote_requests.create"] },
    { key: "offers", actions: ["dist.quote_request.shop"] },
    { key: "accepted", actions: ["dist.quote_requests.accept", "dist.quote_response.select"] },
    { key: "issued", actions: ["axis.policy.bind", "axis.policy.document_issued"] }
  ] },
  { id: "J-C2", persona: "customer", steps: [
    { key: "asked", actions: ["orbit.conversation.signal"] },
    { key: "rated", actions: ["orbit.conversation.rated"] }
  ] },
  { id: "J-C3", persona: "customer", steps: [
    { key: "offered", actions: ["orbit.renewal.offered"] },
    { key: "accepted", actions: ["orbit.renewal.accepted"] },
    { key: "renewed", actions: ["axis.policy.renew"] }
  ] },
  { id: "J-C4", persona: "customer", steps: [
    { key: "requested", actions: ["compliance.dsar-requests.create"] },
    { key: "acknowledged", actions: ["compliance.dsar.acknowledged"] },
    { key: "worked", actions: ["compliance.dsar-requests.update"] }
  ] },
  { id: "J-O1", persona: "axis.agent", steps: [
    { key: "failed", actions: ["axis.case.failed"] },
    { key: "assisted", actions: ["ai.command.run"] },
    { key: "cleared", actions: ["axis.case.review", "axis.case.issued", "axis.case.cancelled", "axis.cases.bulk_close"] }
  ] },
  { id: "J-O2", persona: "axis.lead", steps: [
    { key: "census", actions: ["axis.documents.upload", "axis.cases.import"] },
    { key: "normalised", actions: ["axis.documents.extract"] },
    { key: "quoted", actions: ["dist.quote_request.shop", "axis.quote.capture"] },
    { key: "bound", actions: ["axis.policy.bind_group"] }
  ] },
  { id: "J-O3", persona: "finance.controller", steps: [
    { key: "run", actions: ["ledger.recon.run"] },
    { key: "matched", actions: ["ledger.recon.confirmed", "ledger.recon.rejected"] },
    { key: "evidence", actions: ["ledger.recon.evidence.export"] },
    { key: "closed", actions: ["ledger.recon.close", "ledger.period.close"] }
  ] },
  { id: "J-X1", persona: "orbit.agent", steps: [
    { key: "escalated", actions: ["orbit.conversation.handover"] },
    { key: "worked", actions: ["orbit.macro.applied", "orbit.handover-notes.create", "orbit.callback.booked"] },
    { key: "scored", actions: ["orbit.qa-scores.create", "orbit.qa.sweep"] }
  ] },
  { id: "J-X2", persona: "orbit.retention", steps: [
    { key: "offered", actions: ["orbit.renewal.offered"] },
    { key: "saved", actions: ["orbit.renewal.accepted"] }
  ] },
  { id: "J-X3", persona: "partner.developer", steps: [
    { key: "signed_up", actions: ["orbit.partners.create"] },
    { key: "checklist", actions: ["core.onboarding.complete"] },
    { key: "mock_quote", actions: ["orbit.partner.quote"] },
    { key: "live", actions: ["orbit.partner.advance"] },
    { key: "first_bind", actions: ["orbit.partner.bind"] }
  ] },
  { id: "J-M1", persona: "signal.lead", steps: [
    { key: "planned", actions: ["signal.campaigns.create", "signal.campaign.planned"] },
    { key: "measured", actions: ["signal.autopilot.evaluated"] }
  ] },
  { id: "J-M2", persona: "signal.lead", steps: [
    { key: "proposed", actions: ["signal.budget_move.created"] },
    { key: "revised", actions: ["signal.budget-moves.update"] }
  ] },
  { id: "J-P1", persona: "scout.lead", steps: [
    { key: "promoted", actions: ["scout.whitespace.promoted"] },
    { key: "experiment", actions: ["scout.scout-experiments.create"] },
    { key: "verdict", actions: ["scout.whitespace.verdict"] }
  ] },
  { id: "J-P2", persona: "scout.lead", steps: [
    { key: "benched", actions: ["scout.bench.sweep"] },
    { key: "pack", actions: ["scout.negotiation_pack.export"] },
    { key: "rate", actions: ["dist.commission-rates.create"] }
  ] },
  { id: "J-E2", persona: "north.exec", steps: [
    { key: "assembled", actions: ["north.boardpack.generate", "north.boardpacks.create"] },
    { key: "read", actions: ["north.boardpack.download"] }
  ] },
  { id: "J-E3", persona: "north.exec", steps: [
    { key: "asked", actions: ["north.scenarios.create"] },
    { key: "revisited", actions: ["north.scenarios.update"] }
  ] },
  { id: "J-A2", persona: "tenant.admin", steps: [
    { key: "invited", actions: ["core.staff.invite"] },
    { key: "roles", actions: ["core.staff.roles_changed", "core.user-roles.create"] }
  ] },
  { id: "J-A3", persona: "module admin", steps: [
    { key: "paused", actions: ["ai.module.paused", "ai.tenant.paused", "ai.agent.pause", "signal.autopilot.paused"] },
    { key: "resumed", actions: ["ai.module.resumed", "ai.tenant.resumed", "ai.agent.resume", "signal.autopilot.resumed"] }
  ] },
  { id: "J-D1", persona: "dev.developer", steps: [
    { key: "key", actions: ["core.api-keys.create"] },
    { key: "webhook", actions: ["core.webhooks.create"] },
    { key: "tested", actions: ["core.webhooks.test"] }
  ] },
  { id: "J-CO1", persona: "tenant.compliance", steps: [
    { key: "exported", actions: ["compliance.evidence.export"] },
    { key: "delivered", actions: ["compliance.evidence.download"] }
  ] }
];

export type JourneyStatus = "flowing" | "stalled" | "quiet";

export interface JourneyHealth {
  id: string;
  persona: string;
  steps: { key: string; count: number }[];
  /** Last step over first, or null when nobody started. */
  completion: number | null;
  status: JourneyStatus;
  /** Completions (last step) per week across the window, oldest first. */
  weekly: number[];
}

const WEEK = 7 * 86_400_000;

export async function journeyHealth(ctx: Ctx, { days }: { days: number }): Promise<JourneyHealth[]> {
  const since = ctx.now - days * 86_400_000;
  const weeks = Math.max(1, Math.ceil(days / 7));
  const actions = [...new Set(JOURNEY_FUNNELS.flatMap((j) => j.steps.flatMap((s) => s.actions)))];
  const rows = await ctx.db
    .select({
      action: schema.auditLog.action,
      // Weeks counted back from now, so the last bucket is always this week.
      week: sql<number>`cast((${ctx.now} - ${schema.auditLog.ts}) / ${WEEK} as integer)`,
      n: sql<number>`count(*)`
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.tenantId, ctx.tenantId),
        gte(schema.auditLog.ts, since),
        inArray(schema.auditLog.action, actions)
      )
    )
    .groupBy(schema.auditLog.action, sql`2`);

  const total = new Map<string, number>();
  const byWeek = new Map<string, number[]>();
  for (const row of rows) {
    total.set(row.action, (total.get(row.action) ?? 0) + Number(row.n));
    const series = byWeek.get(row.action) ?? Array.from({ length: weeks }, () => 0);
    const index = weeks - 1 - Number(row.week);
    if (index >= 0) series[index] = (series[index] ?? 0) + Number(row.n);
    byWeek.set(row.action, series);
  }

  return JOURNEY_FUNNELS.map((journey) => {
    const steps = journey.steps.map((step) => ({
      key: step.key,
      count: step.actions.reduce((sum, action) => sum + (total.get(action) ?? 0), 0)
    }));
    const first = steps[0]!.count;
    const last = steps.at(-1)!.count;
    const finish = journey.steps.at(-1)!.actions;
    const weekly = Array.from({ length: weeks }, (_, i) =>
      finish.reduce((sum, action) => sum + (byWeek.get(action)?.[i] ?? 0), 0)
    );
    return {
      id: journey.id,
      persona: journey.persona,
      steps,
      completion: first ? Math.min(1, last / first) : null,
      status: !first ? "quiet" : last ? "flowing" : "stalled",
      weekly
    };
  });
}

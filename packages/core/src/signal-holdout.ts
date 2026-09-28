import { and, eq, gte, lt, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx } from "./context.js";

// docs/17 SIG-046, docs/modules/signal.md §7 KPI "autopilot uplift vs
// frozen-budget holdout", ADR-0110. Lives in core, not in the SIGNAL engine,
// because two modules read it: SIGNAL's `GET /v1/signal/holdout/readout` and
// NORTH's `autopilot_uplift_bps` (CLAUDE.md §6 — shared reads go through core,
// the same way journey-health.ts serves NORTH from other modules' rows).

export interface HoldoutComparison {
  readonly actedCacMinor: number;
  readonly holdoutCacMinor: number;
  readonly actedConversions: number;
  readonly holdoutConversions: number;
  /** Basis points the acted-on cohort's CAC beats the holdout's; 0 if either side has no conversions. */
  readonly upliftBps: number;
}

/**
 * docs/modules/signal.md §7 KPI: "autopilot uplift vs frozen-budget holdout".
 * A comparison over caller-supplied cohorts, not an experiment-management
 * system — the caller decides which spend rows are the frozen-budget holdout
 * and which the autopilot acted on.
 */
export function compareHoldout(
  acted: readonly { amountMinor: number; conversions: number }[],
  holdout: readonly { amountMinor: number; conversions: number }[]
): HoldoutComparison {
  const sum = (rows: readonly { amountMinor: number; conversions: number }[]) =>
    rows.reduce((a, r) => ({ spend: a.spend + r.amountMinor, conversions: a.conversions + r.conversions }), {
      spend: 0,
      conversions: 0
    });
  const a = sum(acted);
  const h = sum(holdout);
  const actedCacMinor = a.conversions > 0 ? Math.round(a.spend / a.conversions) : 0;
  const holdoutCacMinor = h.conversions > 0 ? Math.round(h.spend / h.conversions) : 0;
  const upliftBps =
    actedCacMinor > 0 && holdoutCacMinor > 0
      ? Math.round(((holdoutCacMinor - actedCacMinor) / holdoutCacMinor) * 10_000)
      : 0;
  return { actedCacMinor, holdoutCacMinor, actedConversions: a.conversions, holdoutConversions: h.conversions, upliftBps };
}

/** Autonomy levels the autopilot acts on — the eligible set the sweep filters to, and the readout's "acted" cohort. */
export const AUTOPILOT_LEVELS = ["act", "act_with_approval"] as const;

export interface HoldoutCohort {
  /** Campaigns designated into this cohort, whether or not they spent in the window. */
  readonly campaigns: number;
  readonly spendMinor: number;
  /** Attributed `bind` touches — one contract each, the basis `cost_per_acquisition` counts. */
  readonly conversions: number;
  /** Null when the cohort bought nothing: no acquisition to price. */
  readonly cacMinor: number | null;
}

export interface HoldoutReadout {
  /**
   * `no_holdout`: nothing designated. `no_conversions`: a side bought nothing.
   * `no_spend`: a side's acquisitions cost nothing in the window. In each there
   * is no uplift to state.
   */
  readonly status: "ok" | "no_holdout" | "no_conversions" | "no_spend";
  readonly since: number;
  readonly until: number;
  readonly acted: HoldoutCohort;
  readonly holdout: HoldoutCohort;
  /** `compareHoldout`'s figure, or null when `status` is not `ok` — never a fabricated 0. */
  readonly upliftBps: number | null;
}

type CohortRow = { amountMinor: number; conversions: number };

/**
 * docs/17 SIG-046, ADR-0110: autopilot uplift against the frozen-budget
 * holdout, over real spend and attributed binds in [since, until). The acted
 * cohort is every non-holdout campaign on an autonomy level the autopilot acts
 * on; a campaign it may not touch is in neither side, because nothing about
 * its budget says anything about the autopilot. The single reader behind both
 * `GET /v1/signal/holdout/readout` and NORTH's `autopilot_uplift_bps`.
 */
export async function holdoutReadout(ctx: Ctx, since: number, until: number): Promise<HoldoutReadout> {
  const campaigns = await ctx.db
    .select({ id: schema.signalCampaigns.id, holdout: schema.signalCampaigns.holdout, autonomyLevel: schema.signalCampaigns.autonomyLevel })
    .from(schema.signalCampaigns)
    .where(eq(schema.signalCampaigns.tenantId, ctx.tenantId));
  const side = new Map<string, "acted" | "holdout">();
  for (const c of campaigns) {
    if (c.holdout) side.set(c.id, "holdout");
    else if ((AUTOPILOT_LEVELS as readonly string[]).includes(c.autonomyLevel)) side.set(c.id, "acted");
  }

  const [spend, binds] = await Promise.all([
    ctx.db
      .select({ campaignId: schema.signalSpend.campaignId, v: sql<number>`coalesce(sum(${schema.signalSpend.amountMinor}), 0)` })
      .from(schema.signalSpend)
      .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), gte(schema.signalSpend.ts, since), lt(schema.signalSpend.ts, until)))
      .groupBy(schema.signalSpend.campaignId),
    ctx.db
      .select({ campaignId: schema.signalAttributionEvents.campaignId, n: sql<number>`count(*)` })
      .from(schema.signalAttributionEvents)
      .where(
        and(
          eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
          eq(schema.signalAttributionEvents.touchType, "bind"),
          gte(schema.signalAttributionEvents.ts, since),
          lt(schema.signalAttributionEvents.ts, until)
        )
      )
      .groupBy(schema.signalAttributionEvents.campaignId)
  ]);

  const rows: Record<"acted" | "holdout", CohortRow[]> = { acted: [], holdout: [] };
  for (const r of spend) {
    const s = r.campaignId ? side.get(r.campaignId) : undefined;
    if (s) rows[s].push({ amountMinor: Number(r.v), conversions: 0 });
  }
  for (const r of binds) {
    const s = r.campaignId ? side.get(r.campaignId) : undefined;
    if (s) rows[s].push({ amountMinor: 0, conversions: Number(r.n) });
  }

  const cmp = compareHoldout(rows.acted, rows.holdout);
  const cohort = (key: "acted" | "holdout", cacMinor: number, conversions: number): HoldoutCohort => {
    const spendMinor = rows[key].reduce((a, r) => a + r.amountMinor, 0);
    return {
      campaigns: [...side.values()].filter((v) => v === key).length,
      spendMinor,
      conversions,
      // compareHoldout reports 0 for "no conversions" and for "no spend"; neither is a price.
      cacMinor: conversions > 0 && spendMinor > 0 ? cacMinor : null
    };
  };
  const acted = cohort("acted", cmp.actedCacMinor, cmp.actedConversions);
  const holdout = cohort("holdout", cmp.holdoutCacMinor, cmp.holdoutConversions);
  const status: HoldoutReadout["status"] =
    holdout.campaigns === 0
      ? "no_holdout"
      : acted.conversions === 0 || holdout.conversions === 0
        ? "no_conversions"
        : acted.spendMinor === 0 || holdout.spendMinor === 0
          ? "no_spend"
          : "ok";
  return { status, since, until, acted, holdout, upliftBps: status === "ok" ? cmp.upliftBps : null };
}


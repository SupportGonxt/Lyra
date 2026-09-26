import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lte, lt, ne, notInArray, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { earnedBetween, emit, isClosedPeriod, periodBounds, periodOf, previousPeriod, type Ctx } from "@lyra/core";
// docs/27 F49 / spec §E.2: NORTH's money metrics are adapters over the
// ledger's own reports. packages/ledger is a shared package, not another
// module, so this is not the cross-module import CLAUDE.md §6 forbids — and it
// is the reason NORTH contains no SQL against ledger_journal_lines.
import { commissionByDimension, expenseMovementMinor, type CommissionByDimension } from "@lyra/ledger";

// docs/modules/north.md §2.2/§3 — Snapshotter (nightly) + Anomaly Hunter
// (post-snapshot). ADR-0024: a typed compute function per metric, not a
// generic executor over `north_metrics.definition_sql_ref` (that field is
// documentation-only shorthand, not parseable SQL).

const DAY_MS = 86_400_000;
/** Money metrics store minor units; ai_audit_log.cost_micro is 1e-6 of a major unit. */
const MICRO_PER_MINOR = 10_000;

interface Period {
  grain: "day" | "month";
  /** YYYY-MM-DD or YYYY-MM */
  period: string;
  since: number;
  until: number;
  /**
   * Has the whole window elapsed? An open period is a partial observation —
   * the month-to-date row is rewritten every night — so it is written and
   * displayed but is never an anomaly subject and never a baseline (docs/27
   * F48, spec §F.2).
   */
  closed: boolean;
}

function monthPeriod(period: string, now: number): Period {
  const bounds = periodBounds("month", period);
  const closed = isClosedPeriod("month", period, now);
  // An open month is measured up to now; a closed one is measured whole, so
  // the last run of a month and the first run of the next agree on its total.
  return { grain: "month", period, since: bounds.since, until: closed ? bounds.until : now, closed };
}

/**
 * Yesterday as a day period, plus the month yesterday fell in, plus the
 * current month when that is a different one.
 *
 * The month is keyed off *yesterday* rather than off now for the reason F48
 * exists: on the 1st, the month that just ended has never been snapshotted
 * whole, so nothing could ever detect against it. Keying off yesterday gives
 * it exactly one closed write, on the first run after it ended, and the new
 * month-to-date row is written beside it for the Today screen.
 */
function periodsFor(now: number): Period[] {
  const yesterdayStart = Math.floor(now / DAY_MS) * DAY_MS - DAY_MS;
  const yesterdayMonth = periodOf("month", yesterdayStart);
  const thisMonth = periodOf("month", now);
  return [
    { grain: "day", period: periodOf("day", yesterdayStart), since: yesterdayStart, until: yesterdayStart + DAY_MS, closed: true },
    monthPeriod(yesterdayMonth, now),
    ...(thisMonth === yesterdayMonth ? [] : [monthPeriod(thisMonth, now)])
  ];
}

type Compute = (ctx: Ctx, p: Period) => Promise<number | null>;

async function countPolicies(ctx: Ctx, p: Period): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.axisPolicies)
    .where(
      and(eq(schema.axisPolicies.tenantId, ctx.tenantId), gte(schema.axisPolicies.createdAt, p.since), lt(schema.axisPolicies.createdAt, p.until))
    );
  return row?.n ?? 0;
}

const policiesIssued: Compute = async (ctx, p) => (p.grain === "day" ? countPolicies(ctx, p) : null);

const quoteToBindRate: Compute = async (ctx, p) => {
  const [issued, [completedReq]] = await Promise.all([
    countPolicies(ctx, p),
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.distQuoteRequests)
      .where(
        and(
          eq(schema.distQuoteRequests.tenantId, ctx.tenantId),
          eq(schema.distQuoteRequests.state, "complete"),
          gte(schema.distQuoteRequests.createdAt, p.since),
          lt(schema.distQuoteRequests.createdAt, p.until)
        )
      )
  ]);
  const denom = completedReq?.n ?? 0;
  return denom > 0 ? Math.round((issued / denom) * 10_000) : null;
};

const panelResponseRate: Compute = async (ctx, p) => {
  const [row] = await ctx.db
    .select({
      responded: sql<number>`coalesce(sum(${schema.distQuoteRequests.respondedCount}), 0)`,
      fanout: sql<number>`coalesce(sum(${schema.distQuoteRequests.fanoutCount}), 0)`
    })
    .from(schema.distQuoteRequests)
    .where(
      and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), gte(schema.distQuoteRequests.createdAt, p.since), lt(schema.distQuoteRequests.createdAt, p.until))
    );
  const fanout = row?.fanout ?? 0;
  return fanout > 0 ? Math.round(((row?.responded ?? 0) / fanout) * 10_000) : null;
};

/** ponytail: p95 via ORDER BY + LIMIT/OFFSET — fine at this volume, revisit if a tenant's daily quote-response count gets huge. */
const quoteLatencyP95: Compute = async (ctx, p) => {
  const rows = await ctx.db
    .select({ latencyMs: schema.distQuoteResponses.latencyMs })
    .from(schema.distQuoteResponses)
    .where(
      and(
        eq(schema.distQuoteResponses.tenantId, ctx.tenantId),
        isNotNull(schema.distQuoteResponses.latencyMs),
        gte(schema.distQuoteResponses.createdAt, p.since),
        lt(schema.distQuoteResponses.createdAt, p.until)
      )
    )
    .orderBy(schema.distQuoteResponses.latencyMs);
  if (!rows.length) return null;
  const idx = Math.min(rows.length - 1, Math.ceil(rows.length * 0.95) - 1);
  return rows[idx]!.latencyMs as number;
};

/**
 * Gross written premium, and deliberately *not* read from the ledger (ADR-0082,
 * docs/27 F49). For a broker, premium is not revenue: it lands in segregated
 * client money (1010 debit / 2010 credit) and leaves again on remittance, so no
 * general-ledger account's balance is GWP and inventing one to satisfy a
 * tie-out would be worse than the operational sum. It stays a production
 * figure from the policy table; what is missing — and is recorded as the open
 * half of F49 rather than pretended away — is the periodic reconciliation
 * against premium collected, and the board/investor filter that would keep an
 * unreconciled figure out of a pack.
 */
const gwp: Compute = async (ctx, p) => {
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(sum(${schema.axisPolicies.premiumMinor}), 0)` })
    .from(schema.axisPolicies)
    .where(
      and(eq(schema.axisPolicies.tenantId, ctx.tenantId), gte(schema.axisPolicies.createdAt, p.since), lt(schema.axisPolicies.createdAt, p.until))
    );
  return row?.v ?? 0;
};

/**
 * Our share of the commission, from the general ledger (docs/27 F49).
 *
 * It summed `axis_policies.commission_minor` over policies *created* in the
 * window, which is three wrong things at once: gross of the channel's share
 * (a credit to 2100, invisible to that sum), blind to every clawback (a contra
 * batch that changes no policy row), and tied to nothing a CFO can reconcile —
 * so the briefing narrated a figure that could not be traced to the trial
 * balance, and `verifyNumericClaims` faithfully confirmed the prose matched it.
 *
 * `commissionByDimension` is the ledger's own reader of those accounts;
 * reversals are debits to the same ones and net out by construction. NORTH
 * writes no SQL against journal lines — packages/ledger is the only place that
 * reads them.
 */
const commissionSlices = async (ctx: Ctx, p: Period): Promise<CommissionByDimension[]> => {
  const rows = await commissionByDimension(ctx, "channel", { window: { from: p.since, to: p.until } });
  // A snapshot is one integer in the metric's currency, and this metric's
  // currency is the tenant's base. A line posted in another currency is not
  // summable into it without an fx opinion NORTH does not own.
  return rows.filter((row) => row.currency === ctx.policy.currency);
};

const netCommission: Compute = async (ctx, p) => (await commissionSlices(ctx, p)).reduce((sum, row) => sum + row.netMinor, 0);

/** Point-in-time gauge: "as of now", not scoped to the period window. */
const activePolicies: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.status, "active")));
  return row?.n ?? 0;
};

/** SIGNAL media spend booked in the window — the numerator every acquisition-cost metric divides. */
async function signalSpendMinor(ctx: Ctx, p: Period): Promise<number> {
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(sum(${schema.signalSpend.amountMinor}), 0)` })
    .from(schema.signalSpend)
    .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), gte(schema.signalSpend.ts, p.since), lt(schema.signalSpend.ts, p.until)));
  return row?.v ?? 0;
}

const cacPerPolicy: Compute = async (ctx, p) => {
  const [spend, issued] = await Promise.all([signalSpendMinor(ctx, p), countPolicies(ctx, p)]);
  return issued > 0 ? Math.round(spend / issued) : null;
};

const brokerChannelShare: Compute = async (ctx, p) => {
  const rows = await ctx.db
    .select({ premiumMinor: schema.axisPolicies.premiumMinor, channelId: schema.axisPolicies.channelId })
    .from(schema.axisPolicies)
    .where(
      and(eq(schema.axisPolicies.tenantId, ctx.tenantId), gte(schema.axisPolicies.createdAt, p.since), lt(schema.axisPolicies.createdAt, p.until))
    );
  if (!rows.length) return null;
  const channelIds = [...new Set(rows.map((r) => r.channelId).filter((c): c is string => !!c))];
  const b2bIds = channelIds.length
    ? new Set(
        (
          await ctx.db
            .select({ id: schema.distChannels.id })
            .from(schema.distChannels)
            .where(and(eq(schema.distChannels.tenantId, ctx.tenantId), eq(schema.distChannels.kind, "b2b")))
        ).map((c) => c.id)
      )
    : new Set<string>();
  let total = 0;
  let b2b = 0;
  for (const r of rows) {
    total += r.premiumMinor;
    if (r.channelId && b2bIds.has(r.channelId)) b2b += r.premiumMinor;
  }
  return total > 0 ? Math.round((b2b / total) * 10_000) : null;
};

const aiCostPerCase: Compute = async (ctx, p) => {
  const [costMicro, [caseCount]] = await Promise.all([
    ctx.db
      .select({ v: sql<number>`coalesce(sum(${schema.aiAuditLog.costMicro}), 0)` })
      .from(schema.aiAuditLog)
      .where(and(eq(schema.aiAuditLog.tenantId, ctx.tenantId), gte(schema.aiAuditLog.ts, p.since), lt(schema.aiAuditLog.ts, p.until)))
      .then((r) => r[0]?.v ?? 0),
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.axisCases)
      .where(and(eq(schema.axisCases.tenantId, ctx.tenantId), gte(schema.axisCases.createdAt, p.since), lt(schema.axisCases.createdAt, p.until)))
  ]);
  const cases = caseCount?.n ?? 0;
  return cases > 0 ? Math.round(costMicro / MICRO_PER_MINOR / cases) : null;
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** docs/specs/gap-axis-design.md §F: earned premium, pro-rata over each overlapping version's term. */
async function earnedPremiumForPeriod(ctx: Ctx, p: Period): Promise<number> {
  const rows = await ctx.db
    .select({
      effectiveFrom: schema.axisPolicyVersions.effectiveFrom,
      effectiveTo: schema.axisPolicyVersions.effectiveTo,
      premiumMinor: schema.axisPolicyVersions.premiumMinor
    })
    .from(schema.axisPolicyVersions)
    .where(
      and(
        eq(schema.axisPolicyVersions.tenantId, ctx.tenantId),
        ne(schema.axisPolicyVersions.state, "voided"),
        lt(schema.axisPolicyVersions.effectiveFrom, p.until),
        gt(schema.axisPolicyVersions.effectiveTo, p.since)
      )
    );
  return rows.reduce((sum, v) => sum + earnedBetween(v, p.since, p.until), 0);
}

const grossWrittenPremium: Compute = async (ctx, p) => {
  const [row] = await ctx.db
    .select({
      v: sql<number>`coalesce(sum(${schema.axisPolicyVersions.premiumMinor} + ${schema.axisPolicyVersions.taxMinor} + ${schema.axisPolicyVersions.feesMinor}), 0)`
    })
    .from(schema.axisPolicyVersions)
    .where(
      and(
        eq(schema.axisPolicyVersions.tenantId, ctx.tenantId),
        ne(schema.axisPolicyVersions.state, "voided"),
        gte(schema.axisPolicyVersions.effectiveFrom, p.since),
        lt(schema.axisPolicyVersions.effectiveFrom, p.until)
      )
    );
  return row?.v ?? 0;
};

const netWrittenPremium: Compute = async (ctx, p) => {
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(sum(${schema.axisPolicyVersions.premiumMinor}), 0)` })
    .from(schema.axisPolicyVersions)
    .where(
      and(
        eq(schema.axisPolicyVersions.tenantId, ctx.tenantId),
        ne(schema.axisPolicyVersions.state, "voided"),
        gte(schema.axisPolicyVersions.effectiveFrom, p.since),
        lt(schema.axisPolicyVersions.effectiveFrom, p.until)
      )
    );
  return row?.v ?? 0;
};

const lossRatio: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const [claimsRow, earned] = await Promise.all([
    ctx.db
      .select({
        v: sql<number>`coalesce(sum(${schema.axisClaims.paidMinor} + ${schema.axisClaims.reserveMinor} - ${schema.axisClaims.recoveredMinor}), 0)`
      })
      .from(schema.axisClaims)
      .where(
        and(
          eq(schema.axisClaims.tenantId, ctx.tenantId),
          isNotNull(schema.axisClaims.incidentAt),
          gte(schema.axisClaims.incidentAt, p.since),
          lt(schema.axisClaims.incidentAt, p.until)
        )
      )
      .then((r) => r[0]?.v ?? 0),
    earnedPremiumForPeriod(ctx, p)
  ]);
  return earned > 0 ? Math.round((claimsRow / earned) * 10_000) : null;
};

/** Expense over earned premium. The numerator is the ledger's, read through the ledger's own report (F49). */
const expenseRatio: Compute = async (ctx, p) => {
  const [expense, earned] = await Promise.all([
    expenseMovementMinor(ctx, { from: p.since, to: p.until }),
    earnedPremiumForPeriod(ctx, p)
  ]);
  return earned > 0 ? Math.round((expense / earned) * 10_000) : null;
};

/** §F: "computed from the two snapshots, not re-queried" — reads already-written rows, run after loss_ratio/expense_ratio (see sort in runSnapshotter). */
const combinedRatio: Compute = async (ctx, p) => {
  const rows = await ctx.db
    .select({ metricKey: schema.northSnapshots.metricKey, value: schema.northSnapshots.value })
    .from(schema.northSnapshots)
    .where(
      and(
        eq(schema.northSnapshots.tenantId, ctx.tenantId),
        eq(schema.northSnapshots.grain, p.grain),
        eq(schema.northSnapshots.period, p.period),
        eq(schema.northSnapshots.dimsHash, ""),
        inArray(schema.northSnapshots.metricKey, ["loss_ratio", "expense_ratio"])
      )
    );
  const loss = rows.find((r) => r.metricKey === "loss_ratio")?.value;
  const expense = rows.find((r) => r.metricKey === "expense_ratio")?.value;
  return loss !== undefined && expense !== undefined ? loss + expense : null;
};

const renewalRetention: Compute = async (ctx, p) => {
  const [renewed, expiring] = await Promise.all([
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.axisPolicies)
      .where(
        and(
          eq(schema.axisPolicies.tenantId, ctx.tenantId),
          isNotNull(schema.axisPolicies.renewedFromPolicyId),
          gte(schema.axisPolicies.createdAt, p.since),
          lt(schema.axisPolicies.createdAt, p.until)
        )
      )
      .then((r) => r[0]?.n ?? 0),
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.axisPolicies)
      .where(
        and(eq(schema.axisPolicies.tenantId, ctx.tenantId), gte(schema.axisPolicies.endAt, p.since), lt(schema.axisPolicies.endAt, p.until))
      )
      .then((r) => r[0]?.n ?? 0)
  ]);
  return expiring > 0 ? Math.round((renewed / expiring) * 10_000) : null;
};

const quoteHitRate: Compute = async (ctx, p) => {
  const [bound, requested] = await Promise.all([
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.ledgerTxns)
      .where(
        and(
          eq(schema.ledgerTxns.tenantId, ctx.tenantId),
          eq(schema.ledgerTxns.type, "BIND"),
          gte(schema.ledgerTxns.createdAt, p.since),
          lt(schema.ledgerTxns.createdAt, p.until)
        )
      )
      .then((r) => r[0]?.n ?? 0),
    ctx.db
      .select({ n: sql<number>`count(*)` })
      .from(schema.distQuoteRequests)
      .where(
        and(
          eq(schema.distQuoteRequests.tenantId, ctx.tenantId),
          gte(schema.distQuoteRequests.createdAt, p.since),
          lt(schema.distQuoteRequests.createdAt, p.until)
        )
      )
      .then((r) => r[0]?.n ?? 0)
  ]);
  return requested > 0 ? Math.round((bound / requested) * 10_000) : null;
};

const avgHandlingTimeClaims: Compute = async (ctx, p) => {
  const rows = await ctx.db
    .select({ reportedAt: schema.axisClaims.reportedAt, closedAt: schema.axisClaims.closedAt })
    .from(schema.axisClaims)
    .where(
      and(
        eq(schema.axisClaims.tenantId, ctx.tenantId),
        isNotNull(schema.axisClaims.closedAt),
        gte(schema.axisClaims.closedAt, p.since),
        lt(schema.axisClaims.closedAt, p.until)
      )
    );
  return median(rows.map((r) => r.closedAt! - r.reportedAt));
};

const avgHandlingTimeCases: Compute = async (ctx, p) => {
  const rows = await ctx.db
    .select({ createdAt: schema.axisCases.createdAt, closedAt: schema.axisCases.closedAt })
    .from(schema.axisCases)
    .where(
      and(
        eq(schema.axisCases.tenantId, ctx.tenantId),
        isNotNull(schema.axisCases.closedAt),
        gte(schema.axisCases.closedAt, p.since),
        lt(schema.axisCases.closedAt, p.until)
      )
    );
  return median(rows.map((r) => r.closedAt! - r.createdAt));
};

const reserveAdequacy: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const claims = await ctx.db
    .select({ id: schema.axisClaims.id, reportedAt: schema.axisClaims.reportedAt, paidMinor: schema.axisClaims.paidMinor })
    .from(schema.axisClaims)
    .where(
      and(
        eq(schema.axisClaims.tenantId, ctx.tenantId),
        isNotNull(schema.axisClaims.closedAt),
        gte(schema.axisClaims.closedAt, p.since),
        lt(schema.axisClaims.closedAt, p.until)
      )
    );
  if (!claims.length) return null;

  // One batched pass over the reserve history for every closed claim, instead
  // of a lookup per claim (the old N+1). The per-claim deadline differs
  // (reportedAt + 30d), so the query takes the widest window and the loop
  // below applies each claim's own cutoff, keeping the newest reserve at or
  // before it.
  const ids = claims.map((c) => c.id);
  const earliestReport = Math.min(...claims.map((c) => c.reportedAt));
  const latestDeadline = Math.max(...claims.map((c) => c.reportedAt)) + 30 * DAY_MS;
  const history = await ctx.db
    .select({
      claimId: schema.axisClaimReserves.claimId,
      amountMinor: schema.axisClaimReserves.amountMinor,
      setAt: schema.axisClaimReserves.setAt
    })
    .from(schema.axisClaimReserves)
    .where(
      and(
        eq(schema.axisClaimReserves.tenantId, ctx.tenantId),
        inArray(schema.axisClaimReserves.claimId, ids),
        eq(schema.axisClaimReserves.head, "indemnity"),
        // Widest window that can contain any claim's relevant reserves; the
        // per-claim cutoff below applies each claim's own report+30d exactly.
        gte(schema.axisClaimReserves.setAt, earliestReport),
        lte(schema.axisClaimReserves.setAt, latestDeadline)
      )
    )
    .orderBy(desc(schema.axisClaimReserves.setAt));

  const latestByClaim = new Map<string, number>();
  const byId = new Map(claims.map((c) => [c.id, c]));
  for (const r of history) {
    const claim = byId.get(r.claimId);
    if (!claim || r.setAt > claim.reportedAt + 30 * DAY_MS) continue;
    if (!latestByClaim.has(r.claimId)) latestByClaim.set(r.claimId, r.amountMinor);
  }

  let reserveAt30 = 0;
  let finalPaid = 0;
  for (const claim of claims) {
    finalPaid += claim.paidMinor;
    reserveAt30 += latestByClaim.get(claim.id) ?? 0;
  }
  return finalPaid > 0 ? Math.round((reserveAt30 / finalPaid) * 10_000) : null;
};

const slaBreachRate: Compute = async (ctx, p) => {
  const [cases, claims] = await Promise.all([
    ctx.db
      .select({ slaDueAt: schema.axisCases.slaDueAt, closedAt: schema.axisCases.closedAt })
      .from(schema.axisCases)
      .where(
        and(
          eq(schema.axisCases.tenantId, ctx.tenantId),
          isNotNull(schema.axisCases.closedAt),
          gte(schema.axisCases.closedAt, p.since),
          lt(schema.axisCases.closedAt, p.until)
        )
      ),
    ctx.db
      .select({ slaDueAt: schema.axisClaims.slaDueAt, closedAt: schema.axisClaims.closedAt })
      .from(schema.axisClaims)
      .where(
        and(
          eq(schema.axisClaims.tenantId, ctx.tenantId),
          isNotNull(schema.axisClaims.closedAt),
          gte(schema.axisClaims.closedAt, p.since),
          lt(schema.axisClaims.closedAt, p.until)
        )
      )
  ]);
  const closed = [...cases, ...claims];
  if (!closed.length) return null;
  const breached = closed.filter((c) => c.slaDueAt !== null && c.closedAt! > c.slaDueAt).length;
  return Math.round((breached / closed.length) * 10_000);
};

/** Point-in-time gauge: "as of now", not scoped to the period window. */
const openClaimCount: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.axisClaims)
    .where(
      and(
        eq(schema.axisClaims.tenantId, ctx.tenantId),
        isNull(schema.axisClaims.closedAt),
        notInArray(schema.axisClaims.status, ["withdrawn", "rejected"])
      )
    );
  return row?.n ?? 0;
};

/** Point-in-time gauge: "as of now", not scoped to the period window. */
const outstandingReserve: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(sum(${schema.axisClaims.reserveMinor}), 0)` })
    .from(schema.axisClaims)
    .where(eq(schema.axisClaims.tenantId, ctx.tenantId));
  return row?.v ?? 0;
};

/**
 * SCOUT -> NORTH: of the gaps raised this month, the share the business
 * decided to act on. Same mixed-cohort window `quote_to_bind_rate` uses —
 * promoted-in-period over raised-in-period, not a cohort followed forward.
 */
const whitespacePromotionRate: Compute = async (ctx, p) => {
  if (p.grain !== "month") return null;
  const [row] = await ctx.db
    .select({
      raised: sql<number>`count(*)`,
      promoted: sql<number>`sum(case when ${schema.scoutWhitespaces.promotedAt} is not null then 1 else 0 end)`
    })
    .from(schema.scoutWhitespaces)
    .where(
      and(eq(schema.scoutWhitespaces.tenantId, ctx.tenantId), gte(schema.scoutWhitespaces.createdAt, p.since), lt(schema.scoutWhitespaces.createdAt, p.until))
    );
  const raised = row?.raised ?? 0;
  return raised > 0 ? Math.round(((row?.promoted ?? 0) / raised) * 10_000) : null;
};

/**
 * SIGNAL -> NORTH: what the spend brought back, as bp of itself (30,000 = 3x).
 * Only a `bind` touch carries realised value; spend with no bind against it is
 * a real zero, spend of nothing is not a ratio at all.
 */
const campaignReturnOnSpend: Compute = async (ctx, p) => {
  const [spent, returned] = await Promise.all([
    signalSpendMinor(ctx, p),
    ctx.db
      .select({ v: sql<number>`coalesce(sum(${schema.signalAttributionEvents.valueMinor}), 0)` })
      .from(schema.signalAttributionEvents)
      .where(
        and(
          eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
          eq(schema.signalAttributionEvents.touchType, "bind"),
          gte(schema.signalAttributionEvents.ts, p.since),
          lt(schema.signalAttributionEvents.ts, p.until)
        )
      )
      .then((r) => r[0]?.v ?? 0)
  ]);
  return spent > 0 ? Math.round((returned / spent) * 10_000) : null;
};

/* ------------------------------------------- unit economics of acquisition */

/** Attributed touches of one type in the window. One `bind` row is one contract, the same basis `campaign_return_on_spend` values. */
async function attributedTouches(ctx: Ctx, p: Period, touchType: string): Promise<number> {
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)` })
    .from(schema.signalAttributionEvents)
    .where(
      and(
        eq(schema.signalAttributionEvents.tenantId, ctx.tenantId),
        eq(schema.signalAttributionEvents.touchType, touchType),
        gte(schema.signalAttributionEvents.ts, p.since),
        lt(schema.signalAttributionEvents.ts, p.until)
      )
    );
  return row?.n ?? 0;
}

/**
 * Commission that actually accrued in the window: `earned_at` is when an entry
 * became ours, so an entry earned on collection and not yet collected is
 * deliberately absent rather than counted early. Net, not gross — gross is the
 * underwriter's cheque, net is what survives the channel's share and tax.
 * A clawback copies the original's `earned_at`, so a reversal nets against the
 * month the sale was booked in rather than inventing a negative month.
 */
async function commissionAccruedMinor(ctx: Ctx, p: Period): Promise<number> {
  const [row] = await ctx.db
    .select({ v: sql<number>`coalesce(sum(${schema.distCommissionEntries.netCommissionMinor}), 0)` })
    .from(schema.distCommissionEntries)
    .where(
      and(
        eq(schema.distCommissionEntries.tenantId, ctx.tenantId),
        isNotNull(schema.distCommissionEntries.earnedAt),
        gte(schema.distCommissionEntries.earnedAt, p.since),
        lt(schema.distCommissionEntries.earnedAt, p.until)
      )
    );
  return row?.v ?? 0;
}

/**
 * What one lead costs. Spend with no lead against it is not an infinitely
 * expensive lead — there is no lead to price, so the month has no figure.
 */
const costPerLead: Compute = async (ctx, p) => {
  const [spend, leads] = await Promise.all([signalSpendMinor(ctx, p), attributedTouches(ctx, p, "lead")]);
  return leads > 0 ? Math.round(spend / leads) : null;
};

/**
 * What one acquisition costs. Unlike `cac_per_policy`, which spreads spend over
 * every contract the business wrote, this divides only by the contracts SIGNAL
 * is credited with — so it answers "what did the media buy", not "what did the
 * whole book cost". Nothing attributed means nothing to price.
 */
const costPerAcquisition: Compute = async (ctx, p) => {
  const [spend, binds] = await Promise.all([signalSpendMinor(ctx, p), attributedTouches(ctx, p, "bind")]);
  return binds > 0 ? Math.round(spend / binds) : null;
};

/**
 * Revenue per contract written. Commission earned in the month over contracts
 * bound in it — the same mixed-cohort window `quote_to_bind_rate` uses, not a
 * cohort followed forward. A month that bound nothing still collects commission
 * off the back book, and dividing that by zero contracts would be a fiction.
 */
const commissionPerPolicy: Compute = async (ctx, p) => {
  const [commission, bound] = await Promise.all([commissionAccruedMinor(ctx, p), countPolicies(ctx, p)]);
  return bound > 0 ? Math.round(commission / bound) : null;
};

/**
 * A period LTV proxy against `cost_per_acquisition`: the same commission over
 * the distinct customers who took a contract this month, so a customer who
 * bought twice counts once. Not a true lifetime value — no cohort is followed
 * past the month — which is why it is named per-customer revenue, not LTV.
 */
const revenuePerCustomer: Compute = async (ctx, p) => {
  const [commission, [row]] = await Promise.all([
    commissionAccruedMinor(ctx, p),
    ctx.db
      .select({ n: sql<number>`count(distinct ${schema.axisPolicies.customerId})` })
      .from(schema.axisPolicies)
      .where(
        and(eq(schema.axisPolicies.tenantId, ctx.tenantId), gte(schema.axisPolicies.createdAt, p.since), lt(schema.axisPolicies.createdAt, p.until))
      )
  ]);
  const customers = row?.n ?? 0;
  return customers > 0 ? Math.round(commission / customers) : null;
};

/**
 * ADR-0024: registered metric keys only. `claims_leakage` is deliberately
 * absent — its "assessed should have paid" side has no matching schema
 * field anywhere, so there's nothing to compute without guessing.
 */
export const REGISTRY: Record<string, Compute> = {
  policies_issued: policiesIssued,
  quote_to_bind_rate: quoteToBindRate,
  panel_response_rate: panelResponseRate,
  quote_latency_p95: quoteLatencyP95,
  gwp,
  net_commission: netCommission,
  active_policies: activePolicies,
  cac_per_policy: cacPerPolicy,
  broker_channel_share: brokerChannelShare,
  ai_cost_per_case: aiCostPerCase,
  gross_written_premium: grossWrittenPremium,
  net_written_premium: netWrittenPremium,
  loss_ratio: lossRatio,
  expense_ratio: expenseRatio,
  combined_ratio: combinedRatio,
  renewal_retention: renewalRetention,
  quote_hit_rate: quoteHitRate,
  avg_handling_time_claims: avgHandlingTimeClaims,
  avg_handling_time_cases: avgHandlingTimeCases,
  reserve_adequacy: reserveAdequacy,
  sla_breach_rate: slaBreachRate,
  open_claim_count: openClaimCount,
  outstanding_reserve: outstandingReserve,
  whitespace_promotion_rate: whitespacePromotionRate,
  campaign_return_on_spend: campaignReturnOnSpend,
  cost_per_lead: costPerLead,
  cost_per_acquisition: costPerAcquisition,
  commission_per_policy: commissionPerPolicy,
  revenue_per_customer: revenuePerCustomer
};

/** Same move/threshold basis every unit family uses for a naive, seasonal-unaware anomaly flag (ADR-0024). */
function anomalyThresholdBp(unit: string): number {
  return unit === "percent" || unit === "ratio" ? 500 : 1_500;
}

/* ---------------------------------------------------------- driver analysis */

/** Same key shape seed.ts writes, so seeded and computed slices share one key space. */
const dimsHashOf = (dims: Record<string, string>): string =>
  Object.entries(dims)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

interface Slice {
  key: string;
  value: number;
}

/**
 * Sum the same policy rows the grand total sums, grouped by one dimension.
 * Rows with no value for that dimension are left out on purpose: a single
 * "unassigned" bucket explains nothing, and a driver list should only claim
 * the part of a move it can actually attribute.
 */
const policiesBy =
  (column: typeof schema.axisPolicies.channelId, value: ReturnType<typeof sql<number>>) =>
  async (ctx: Ctx, p: Period): Promise<Slice[]> => {
    const rows = await ctx.db
      .select({ key: column, value })
      .from(schema.axisPolicies)
      .where(
        and(
          eq(schema.axisPolicies.tenantId, ctx.tenantId),
          isNotNull(column),
          gte(schema.axisPolicies.createdAt, p.since),
          lt(schema.axisPolicies.createdAt, p.until)
        )
      )
      .groupBy(column);
    return rows.map((row) => ({ key: String(row.key), value: Number(row.value ?? 0) }));
  };

/**
 * Metrics whose movement decomposes additively. Without these the anomaly card
 * can say a number moved but never which channel moved it. Ratios are
 * deliberately absent: a ratio's parts don't sum to the whole, so decomposing
 * one needs a stated method, not a group-by.
 */
const SLICED: Record<string, { dimension: string; slice: (ctx: Ctx, p: Period) => Promise<Slice[]> }> = {
  policies_issued: { dimension: "channel", slice: policiesBy(schema.axisPolicies.channelId, sql<number>`count(*)`) },
  gwp: {
    dimension: "channel",
    slice: policiesBy(schema.axisPolicies.channelId, sql<number>`coalesce(sum(${schema.axisPolicies.premiumMinor}), 0)`)
  },
  // Sliced from the same ledger call the grand total sums, keyed by the
  // `channel` dimension stamped on the journal line — the same key space the
  // policy-table slices use, since both hold a dist_channels id.
  net_commission: {
    dimension: "channel",
    slice: async (ctx, p) =>
      (await commissionSlices(ctx, p))
        .filter((row) => row.value !== "unattributed")
        .map((row) => ({ key: row.value, value: row.netMinor }))
  }
};

/** ponytail: a card shows a handful of bars; the long tail is noise. */
const MAX_DRIVERS = 5;

interface Driver {
  dimension: string;
  key: string;
  contributionBps: number;
}

/** Each dimension value's share of the grand-total move, in bp of the prior total — same basis as the anomaly's magnitude. */
function driversOf(dimension: string, prior: Map<string, number>, current: Slice[], prevTotal: number): Driver[] {
  const drivers: Driver[] = [];
  const seen = new Set<string>();
  const push = (key: string, delta: number): void => {
    const contributionBps = Math.round((delta / Math.abs(prevTotal)) * 10_000);
    if (contributionBps !== 0) drivers.push({ dimension, key, contributionBps });
  };
  for (const slice of current) {
    const key = slice.key;
    seen.add(key);
    push(key, slice.value - (prior.get(key) ?? 0));
  }
  // A value that vanished moved the total too.
  for (const [key, value] of prior) {
    if (!seen.has(key)) push(key, -value);
  }
  return drivers.sort((a, b) => Math.abs(b.contributionBps) - Math.abs(a.contributionBps)).slice(0, MAX_DRIVERS);
}

function breaches(operator: string, value: number, threshold: number): boolean {
  switch (operator) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    case "eq":
      return value === threshold;
    default:
      return false; // unknown operator: don't guess
  }
}

/**
 * Write today's snapshots for every registered metric, then flag anomalies
 * against the immediately preceding period of the same grain. Idempotent:
 * upserts by the `(tenant, metric, grain, period, dims_hash)` unique index,
 * so a missed or repeated nightly tick costs nothing.
 */
export async function runSnapshotter(ctx: Ctx): Promise<{ written: number; anomalies: number; alertsTriggered: number }> {
  const unsortedMetrics = await ctx.db
    .select()
    .from(schema.northMetrics)
    .where(eq(schema.northMetrics.tenantId, ctx.tenantId));
  // combined_ratio reads loss_ratio/expense_ratio's just-written rows (§F), so it must run last.
  const metrics = unsortedMetrics
    .slice()
    .sort((a, b) => (a.key === "combined_ratio" ? 1 : 0) - (b.key === "combined_ratio" ? 1 : 0));

  const rules = await ctx.db
    .select()
    .from(schema.northAlertRules)
    .where(and(eq(schema.northAlertRules.tenantId, ctx.tenantId), eq(schema.northAlertRules.enabled, true)));

  let written = 0;
  let anomalies = 0;
  let alertsTriggered = 0;

  for (const metric of metrics) {
    const compute = REGISTRY[metric.key];
    if (!compute) continue; // unregistered metric: skip, don't guess (ADR-0024)

    for (const p of periodsFor(ctx.now)) {
      if (p.grain !== metric.grain) continue;
      const value = await compute(ctx, p);
      if (value === null) continue;

      const rows = await ctx.db
        .select({ id: schema.northSnapshots.id, value: schema.northSnapshots.value, dimsHash: schema.northSnapshots.dimsHash })
        .from(schema.northSnapshots)
        .where(
          and(
            eq(schema.northSnapshots.tenantId, ctx.tenantId),
            eq(schema.northSnapshots.metricKey, metric.key),
            eq(schema.northSnapshots.grain, p.grain),
            eq(schema.northSnapshots.period, p.period)
          )
        );
      const existing = rows.find((row) => row.dimsHash === "");

      if (existing) {
        await ctx.db
          .update(schema.northSnapshots)
          .set({ value, ts: ctx.now })
          .where(eq(schema.northSnapshots.id, existing.id));
      } else {
        await ctx.db.insert(schema.northSnapshots).values({
          id: newId("snp", ctx.now),
          tenantId: ctx.tenantId,
          metricKey: metric.key,
          grain: p.grain,
          period: p.period,
          dimsHash: "",
          value,
          ts: ctx.now
        });
      }
      // `written` counts grand totals; the slices below are the same numbers cut up.
      written++;

      // Dimensional slices of the same number, so an anomaly can name what moved.
      const sliced = SLICED[metric.key];
      let current: Slice[] = [];
      if (sliced) {
        const written = new Map(rows.filter((row) => row.dimsHash !== "").map((row) => [row.dimsHash, row]));
        current = await sliced.slice(ctx, p);
        for (const slice of current) {
          const dims = { [sliced.dimension]: slice.key };
          const hash = dimsHashOf(dims);
          const before = written.get(hash);
          if (before) {
            await ctx.db
              .update(schema.northSnapshots)
              .set({ value: slice.value, ts: ctx.now })
              .where(eq(schema.northSnapshots.id, before.id));
          } else {
            await ctx.db.insert(schema.northSnapshots).values({
              id: newId("snp", ctx.now),
              tenantId: ctx.tenantId,
              metricKey: metric.key,
              grain: p.grain,
              period: p.period,
              dimsJson: JSON.stringify(dims),
              dimsHash: hash,
              value: slice.value,
              ts: ctx.now
            });
          }
        }
      }

      for (const rule of rules) {
        if (rule.metricKey !== metric.key || rule.windowGrain !== p.grain) continue;
        if (!breaches(rule.operator, value, rule.thresholdValue)) continue;
        await emit(ctx, {
          module: "north",
          type: "north.alert.triggered",
          subject: rule.id,
          data: { ruleId: rule.id, metricKey: metric.key, value, thresholdValue: rule.thresholdValue, operator: rule.operator, grain: p.grain, period: p.period }
        });
        alertsTriggered++;
      }

      // Anomaly detection, against the period that actually precedes this one
      // (docs/27 F48). It ran against `existing` — the previous *write of this
      // very period* — which meant day grain never fired at all (a day is
      // written once) and every money metric fired a false critical on the
      // first night of every month, when a fresh month-to-date collapses
      // against a full prior month. An open period is neither subject nor
      // baseline; the prior period is closed by construction, since a closed
      // period's predecessor has also fully elapsed.
      if (!p.closed) continue;
      const priorRows = await ctx.db
        .select({ value: schema.northSnapshots.value, dimsHash: schema.northSnapshots.dimsHash })
        .from(schema.northSnapshots)
        .where(
          and(
            eq(schema.northSnapshots.tenantId, ctx.tenantId),
            eq(schema.northSnapshots.metricKey, metric.key),
            eq(schema.northSnapshots.grain, p.grain),
            eq(schema.northSnapshots.period, previousPeriod(p.grain, p.period))
          )
        );
      const prior = new Map<string, number>();
      if (sliced) {
        const prefix = `${sliced.dimension}=`;
        for (const row of priorRows) {
          if (row.dimsHash.startsWith(prefix)) prior.set(row.dimsHash.slice(prefix.length), row.value);
        }
      }

      const prevValue = priorRows.find((row) => row.dimsHash === "")?.value;
      if (prevValue !== undefined && prevValue !== 0) {
        const magnitudeBp = Math.round(((value - prevValue) / Math.abs(prevValue)) * 10_000);
        if (Math.abs(magnitudeBp) >= anomalyThresholdBp(metric.unit)) {
          const [openAnomaly] = await ctx.db
            .select({ id: schema.northAnomalies.id })
            .from(schema.northAnomalies)
            .where(
              and(
                eq(schema.northAnomalies.tenantId, ctx.tenantId),
                eq(schema.northAnomalies.metricKey, metric.key),
                eq(schema.northAnomalies.window, p.period),
                eq(schema.northAnomalies.state, "new")
              )
            );
          if (!openAnomaly) {
            const drivers = sliced ? driversOf(sliced.dimension, prior, current, prevValue) : [];
            await ctx.db.insert(schema.northAnomalies).values({
              id: newId("anm", ctx.now),
              tenantId: ctx.tenantId,
              metricKey: metric.key,
              window: p.period,
              magnitude: magnitudeBp,
              expected: prevValue,
              actual: value,
              state: "new",
              driverAnalysisJson: JSON.stringify({ method: "dimensional_delta", baseline: "prior_period", drivers }),
              detectedAt: ctx.now
            });
            anomalies++;
          }
        }
      }
    }
  }

  return { written, anomalies, alertsTriggered };
}

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { runSnapshotter } from "./north-snapshotter.js";

// ADR-0024 + docs/modules/north.md §2.2/§3: north_snapshots had no real
// writer, only seed.ts fixtures. This covers the Snapshotter actually
// computing values from live rows, upserting idempotently, and the Anomaly
// Hunter flagging a big swing between two runs.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const DAY = 86_400_000;

let client: Client;
let ctx: Ctx;

function actor(): Actor {
  return {
    kind: "system",
    id: "scheduler",
    tenantId: "t_1",
    grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }]
  };
}

async function makeCtx(now: number): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

// Yesterday (UTC) at noon, so the "day" period the snapshotter computes lands
// squarely inside yesterday's UTC day regardless of when this test runs.
const NOW = Math.floor(Date.now() / DAY) * DAY + 12 * 3_600_000;
const YESTERDAY_MID = NOW - DAY;
// Mirrors north-snapshotter.ts's own monthStart derivation, so month-grain
// fixtures land inside the exact [monthStart, NOW) window it computes.
const MONTH_START = new Date(new Date(NOW).toISOString().slice(0, 7) + "-01T00:00:00.000Z").getTime();

async function seedMetric(key: string, grain: "day" | "month"): Promise<void> {
  await ctx.db.insert(schema.northMetrics).values({
    id: `mtr_${key}`,
    tenantId: ctx.tenantId,
    key,
    nameJson: JSON.stringify({ en: key, ar: key }),
    definitionSqlRef: key,
    unit: "count",
    grain,
    owner: "test",
    targetJson: JSON.stringify({}),
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

async function seedProviderAndCustomer(): Promise<void> {
  await ctx.db.insert(schema.providers).values({
    id: "prov_1",
    tenantId: ctx.tenantId,
    name: "Test Insurer",
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  await ctx.db.insert(schema.customers).values({
    id: "cu_1",
    tenantId: ctx.tenantId,
    nameJson: JSON.stringify({ first: "Amina" }),
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx(NOW);
});

describe("runSnapshotter: policies_issued", () => {
  it("counts only policies created inside yesterday's UTC day", async () => {
    await seedMetric("policies_issued", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      {
        id: "pol_yesterday",
        tenantId: ctx.tenantId,
        customerId: "cu_1",
        providerId: "prov_1",
        policyNo: "P-1",
        startAt: YESTERDAY_MID,
        endAt: YESTERDAY_MID + 365 * DAY,
        premiumMinor: 10_000,
        currency: "AED",
        status: "active",
        createdAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "pol_today",
        tenantId: ctx.tenantId,
        customerId: "cu_1",
        providerId: "prov_1",
        policyNo: "P-2",
        startAt: NOW,
        endAt: NOW + 365 * DAY,
        premiumMinor: 10_000,
        currency: "AED",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "policies_issued")));
    expect(row!.value).toBe(1);
  });
});

describe("runSnapshotter idempotency", () => {
  it("upserts instead of duplicating on a second run", async () => {
    await seedMetric("policies_issued", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID,
      endAt: YESTERDAY_MID + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID,
      updatedAt: YESTERDAY_MID
    });

    await runSnapshotter(ctx);
    await runSnapshotter(ctx);

    const rows = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "policies_issued")));
    expect(rows.length).toBe(1);
    expect(rows[0]!.value).toBe(1);
  });
});

describe("runSnapshotter: unregistered metric", () => {
  it("skips a metric key with no compute function instead of guessing", async () => {
    await seedMetric("claims_leakage", "month");

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);

    const rows = await ctx.db.select().from(schema.northSnapshots);
    expect(rows.length).toBe(0);
  });
});

describe("runSnapshotter: alert rules", () => {
  it("emits an event when a fresh snapshot breaches an enabled rule's threshold", async () => {
    await seedMetric("policies_issued", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID,
      endAt: YESTERDAY_MID + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID,
      updatedAt: YESTERDAY_MID
    });
    await ctx.db.insert(schema.northAlertRules).values({
      id: "nar_1",
      tenantId: ctx.tenantId,
      metricKey: "policies_issued",
      operator: "gte",
      thresholdValue: 1,
      windowGrain: "day",
      notifyChannelRef: null,
      enabled: true,
      createdAt: ctx.now,
      updatedAt: ctx.now
    });

    const result = await runSnapshotter(ctx);
    expect(result.alertsTriggered).toBe(1);

    const events = await ctx.db.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.tenantId, ctx.tenantId));
    const fired = events.filter((e) => e.type === "north.alert.triggered");
    expect(fired.length).toBe(1);
    const data = JSON.parse(fired[0]!.envelopeJson).data;
    expect(data).toMatchObject({ ruleId: "nar_1", metricKey: "policies_issued", value: 1, thresholdValue: 1, operator: "gte" });
  });

  it("does not fire a disabled rule", async () => {
    await seedMetric("policies_issued", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID,
      endAt: YESTERDAY_MID + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID,
      updatedAt: YESTERDAY_MID
    });
    await ctx.db.insert(schema.northAlertRules).values({
      id: "nar_1",
      tenantId: ctx.tenantId,
      metricKey: "policies_issued",
      operator: "gte",
      thresholdValue: 1,
      windowGrain: "day",
      notifyChannelRef: null,
      enabled: false,
      createdAt: ctx.now,
      updatedAt: ctx.now
    });

    const result = await runSnapshotter(ctx);
    expect(result.alertsTriggered).toBe(0);
  });
});

// docs/27 F48. Every test here pins ctx.now to a fixed calendar date rather
// than deriving it from the wall clock: the behaviour under test is *which
// period is compared against which*, and a suite that runs differently on the
// 1st of a month cannot hold that.
describe("runSnapshotter: anomaly detection", () => {
  const MAR_1 = Date.UTC(2026, 2, 1);
  const MAR_2 = Date.UTC(2026, 2, 2);
  const MAR_3 = Date.UTC(2026, 2, 3);
  const FEB_1 = Date.UTC(2026, 1, 1);
  const NIGHTLY = 2 * 3_600_000; // the 02:00 UTC backup window index.ts runs in

  const policy = (id: string, premiumMinor: number, at: number, channelId?: string) => ({
    id,
    tenantId: "t_1",
    customerId: "cu_1",
    providerId: "prov_1",
    policyNo: id,
    ...(channelId ? { channelId } : {}),
    startAt: at,
    endAt: at + 365 * DAY,
    premiumMinor,
    currency: "AED",
    status: "active" as const,
    createdAt: at,
    updatedAt: at
  });

  it("fires at day grain against the day before — the grain that could never fire at all", async () => {
    await seedMetric("policies_issued", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values(policy("pol_quiet", 1_000, MAR_1 + 6 * 3_600_000));

    // Night of the 2nd: yesterday is 2026-03-01, one policy.
    ctx.now = MAR_2 + NIGHTLY;
    expect((await runSnapshotter(ctx)).anomalies).toBe(0); // nothing to compare against yet

    await ctx.db
      .insert(schema.axisPolicies)
      .values([2, 3, 4, 5, 6, 7].map((n) => policy(`pol_busy_${n}`, 1_000, MAR_2 + n * 3_600_000)));

    // Night of the 3rd: yesterday is 2026-03-02, six policies against one.
    ctx.now = MAR_3 + NIGHTLY;
    expect((await runSnapshotter(ctx)).anomalies).toBe(1);

    const [anomaly] = await ctx.db
      .select()
      .from(schema.northAnomalies)
      .where(and(eq(schema.northAnomalies.tenantId, ctx.tenantId), eq(schema.northAnomalies.metricKey, "policies_issued")));
    expect(anomaly!.window).toBe("2026-03-02");
    expect(anomaly!.expected).toBe(1);
    expect(anomaly!.actual).toBe(6);
    expect(anomaly!.magnitude).toBe(50_000);
    expect(JSON.parse(anomaly!.driverAnalysisJson ?? "null")?.baseline).toBe("prior_period");
  });

  it("does not cry wolf at a month's fresh month-to-date row", async () => {
    await seedMetric("gwp", "month");
    await seedProviderAndCustomer();

    await ctx.db.insert(schema.axisPolicies).values(policy("pol_day1", 1_000, MAR_1 + 3_600_000));
    ctx.now = MAR_1 + 12 * 3_600_000;
    await runSnapshotter(ctx);

    // Day two of the month adds ten thousand times day one. Month-to-date
    // against yesterday's month-to-date is a 10 000x move; against the actual
    // prior period it is not a comparison that exists yet.
    await ctx.db.insert(schema.axisPolicies).values(policy("pol_day2", 10_000_000, MAR_2 + 3_600_000));
    ctx.now = MAR_2 + 12 * 3_600_000;
    const result = await runSnapshotter(ctx);

    expect(result.anomalies).toBe(0);
    const [mtd] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.period, "2026-03")));
    expect(mtd!.value).toBe(10_001_000); // still written — the Today screen reads it
    expect(await ctx.db.select().from(schema.northAnomalies)).toHaveLength(0);
  });

  it("fires at month grain once, on the first run after the month closed", async () => {
    await seedMetric("gwp", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      policy("pol_jan", 10_000_000, Date.UTC(2026, 0, 14)),
      policy("pol_feb", 1_000_000, Date.UTC(2026, 1, 14))
    ]);

    // Night of 1 February: January is over, February is one hour old.
    ctx.now = FEB_1 + NIGHTLY;
    expect((await runSnapshotter(ctx)).anomalies).toBe(0);

    // Night of 1 March: February has closed and is 90% down on January.
    ctx.now = MAR_1 + NIGHTLY;
    expect((await runSnapshotter(ctx)).anomalies).toBe(1);

    const [anomaly] = await ctx.db.select().from(schema.northAnomalies);
    expect(anomaly!.window).toBe("2026-02");
    expect(anomaly!.expected).toBe(10_000_000);
    expect(anomaly!.actual).toBe(1_000_000);
    expect(anomaly!.magnitude).toBe(-9_000);

    // And not again the next night: the same closed month, already flagged.
    ctx.now = MAR_2 + NIGHTLY;
    expect((await runSnapshotter(ctx)).anomalies).toBe(0);
  });

  it("decomposes the closed month's swing into the channel that caused it", async () => {
    await seedMetric("gwp", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      policy("pol_web_jan", 1_000_000, Date.UTC(2026, 0, 10), "ch_web"),
      policy("pol_brk_jan", 1_000_000, Date.UTC(2026, 0, 11), "ch_broker"),
      policy("pol_web_feb", 1_000_000, Date.UTC(2026, 1, 10), "ch_web"),
      policy("pol_brk_feb", 11_000_000, Date.UTC(2026, 1, 11), "ch_broker")
    ]);

    ctx.now = FEB_1 + NIGHTLY; // closes January: 2m, evenly split
    await runSnapshotter(ctx);
    ctx.now = MAR_1 + NIGHTLY; // closes February: 12m, broker alone moved
    await runSnapshotter(ctx);

    const [anomaly] = await ctx.db.select().from(schema.northAnomalies);
    const analysis = JSON.parse(anomaly!.driverAnalysisJson ?? "null") as {
      baseline: string;
      drivers: Array<{ dimension: string; key: string; contributionBps: number }>;
    };
    expect(analysis.baseline).toBe("prior_period");
    expect(analysis.drivers[0]).toEqual({ dimension: "channel", key: "ch_broker", contributionBps: 50_000 });
    // The decomposition has to add up to the move it explains.
    const total = analysis.drivers.reduce((sum, d) => sum + d.contributionBps, 0);
    expect(total).toBe(anomaly!.magnitude);

    // The slices are kept as their own snapshot rows, keyed the way seed.ts keys them.
    const slices = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(
        and(
          eq(schema.northSnapshots.tenantId, ctx.tenantId),
          eq(schema.northSnapshots.dimsHash, "channel=ch_broker"),
          eq(schema.northSnapshots.period, "2026-02")
        )
      );
    expect(slices).toHaveLength(1);
    expect(slices[0]!.value).toBe(11_000_000);
    expect(JSON.parse(slices[0]!.dimsJson ?? "null")).toEqual({ channel: "ch_broker" });
  });

  it("closes the month that ended even when the run is the first of a new month", async () => {
    await seedMetric("gwp", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      policy("pol_feb", 5_000_000, Date.UTC(2026, 1, 20)),
      policy("pol_mar", 7_000, MAR_1 + 3_600_000)
    ]);

    // 1 March, an hour after the month's first contract: yesterday is 28
    // February, so this one run has both months to write.
    ctx.now = MAR_1 + 2 * 3_600_000;
    await runSnapshotter(ctx);

    const rows = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.dimsHash, "")));
    // February is written whole, not left at whatever the last run inside it saw.
    expect(rows.find((r) => r.period === "2026-02")!.value).toBe(5_000_000);
    expect(rows.find((r) => r.period === "2026-03")!.value).toBe(7_000);
  });
});

describe("runSnapshotter: loss_ratio", () => {
  it("loss ratio is null at day grain and a basis-point integer at month grain", async () => {
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: MONTH_START,
      endAt: NOW + 365 * DAY,
      premiumMinor: 100_000,
      currency: "AED",
      status: "active",
      createdAt: MONTH_START,
      updatedAt: MONTH_START
    });
    await ctx.db.insert(schema.axisPolicyVersions).values({
      id: "polv_1",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      versionSeq: 1,
      reason: "issue",
      effectiveFrom: MONTH_START,
      effectiveTo: NOW,
      premiumMinor: 100_000,
      currency: "AED",
      termsJson: "{}",
      issuedBy: "user:test",
      issuedAt: MONTH_START,
      createdAt: MONTH_START,
      updatedAt: MONTH_START
    });
    await ctx.db.insert(schema.axisClaims).values({
      id: "clm_1",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      customerId: "cu_1",
      claimNo: "C-1",
      incidentAt: MONTH_START + DAY,
      reportedAt: MONTH_START + DAY,
      currency: "AED",
      paidMinor: 20_000,
      reserveMinor: 5_000,
      createdAt: MONTH_START + DAY,
      updatedAt: MONTH_START + DAY
    });

    // Day grain: the metric's own compute function returns null for
    // anything but month grain, so nothing is written.
    await seedMetric("loss_ratio", "day");
    const dayResult = await runSnapshotter(ctx);
    expect(dayResult.written).toBe(0);

    // Month grain: (paid + reserve - recovered) / earned premium, in bp.
    await ctx.db.update(schema.northMetrics).set({ grain: "month" }).where(eq(schema.northMetrics.key, "loss_ratio"));
    const monthResult = await runSnapshotter(ctx);
    expect(monthResult.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "loss_ratio")));
    expect(row!.grain).toBe("month");
    expect(row!.value).toBe(2_500);
  });
});

describe("runSnapshotter: renewal_retention", () => {
  it("retention counts a renewed term once", async () => {
    await seedMetric("renewal_retention", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      {
        id: "pol_prior_renewed",
        tenantId: ctx.tenantId,
        customerId: "cu_1",
        providerId: "prov_1",
        policyNo: "P-PRIOR-1",
        startAt: MONTH_START - 365 * DAY,
        endAt: NOW - DAY,
        premiumMinor: 10_000,
        currency: "AED",
        status: "expired",
        createdAt: MONTH_START - 365 * DAY,
        updatedAt: MONTH_START - 365 * DAY
      },
      {
        id: "pol_prior_lapsed",
        tenantId: ctx.tenantId,
        customerId: "cu_1",
        providerId: "prov_1",
        policyNo: "P-PRIOR-2",
        startAt: MONTH_START - 365 * DAY,
        endAt: NOW - DAY,
        premiumMinor: 10_000,
        currency: "AED",
        status: "lapsed",
        createdAt: MONTH_START - 365 * DAY,
        updatedAt: MONTH_START - 365 * DAY
      },
      {
        id: "pol_renewal",
        tenantId: ctx.tenantId,
        customerId: "cu_1",
        providerId: "prov_1",
        policyNo: "P-RENEWED-1",
        startAt: NOW - DAY,
        endAt: NOW + 365 * DAY,
        premiumMinor: 10_000,
        currency: "AED",
        status: "active",
        renewedFromPolicyId: "pol_prior_renewed",
        createdAt: NOW - DAY,
        updatedAt: NOW - DAY
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "renewal_retention")));
    // 1 renewed / 2 expiring prior terms = 5000 bp.
    expect(row!.value).toBe(5_000);
  });
});

describe("runSnapshotter: reserve_adequacy", () => {
  it("reserve adequacy uses the 30-day reserve, not the current one", async () => {
    await seedMetric("reserve_adequacy", "month");
    await seedProviderAndCustomer();
    const reportedAt = MONTH_START - 90 * DAY;
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: reportedAt - 30 * DAY,
      endAt: NOW + 365 * DAY,
      premiumMinor: 100_000,
      currency: "AED",
      status: "active",
      createdAt: reportedAt - 30 * DAY,
      updatedAt: reportedAt - 30 * DAY
    });
    await ctx.db.insert(schema.axisClaims).values({
      id: "clm_1",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      customerId: "cu_1",
      claimNo: "C-1",
      reportedAt,
      currency: "AED",
      paidMinor: 40_000,
      closedAt: NOW - DAY,
      createdAt: reportedAt,
      updatedAt: NOW - DAY
    });
    await ctx.db.insert(schema.axisClaimReserves).values([
      {
        id: "acr_1",
        tenantId: ctx.tenantId,
        claimId: "clm_1",
        seq: 1,
        amountMinor: 50_000,
        deltaMinor: 50_000,
        currency: "AED",
        basis: "assessor",
        setBy: "user:test",
        setAt: reportedAt + 5 * DAY,
        createdAt: reportedAt + 5 * DAY
      },
      {
        id: "acr_2",
        tenantId: ctx.tenantId,
        claimId: "clm_1",
        seq: 2,
        amountMinor: 40_000,
        previousMinor: 50_000,
        deltaMinor: -10_000,
        currency: "AED",
        basis: "assessor",
        setBy: "user:test",
        setAt: reportedAt + 28 * DAY,
        createdAt: reportedAt + 28 * DAY
      },
      {
        id: "acr_3",
        tenantId: ctx.tenantId,
        claimId: "clm_1",
        seq: 3,
        amountMinor: 10_000,
        previousMinor: 40_000,
        deltaMinor: -30_000,
        currency: "AED",
        basis: "closure",
        setBy: "user:test",
        setAt: reportedAt + 45 * DAY,
        createdAt: reportedAt + 45 * DAY
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "reserve_adequacy")));
    // 40,000 reserve-at-30-days / 40,000 final paid = 10,000 bp, not the
    // 10,000-minor "current" reserve set at closure.
    expect(row!.value).toBe(10_000);
  });
});

describe("runSnapshotter: combined_ratio", () => {
  it("sums the loss_ratio and expense_ratio snapshots written in the same run", async () => {
    await ctx.db.insert(schema.northMetrics).values([
      { id: "mtr_loss_ratio", tenantId: ctx.tenantId, key: "loss_ratio", nameJson: "{}", definitionSqlRef: "x", unit: "ratio", grain: "month", owner: "test", targetJson: "{}", createdAt: ctx.now, updatedAt: ctx.now },
      { id: "mtr_expense_ratio", tenantId: ctx.tenantId, key: "expense_ratio", nameJson: "{}", definitionSqlRef: "x", unit: "ratio", grain: "month", owner: "test", targetJson: "{}", createdAt: ctx.now, updatedAt: ctx.now },
      { id: "mtr_combined_ratio", tenantId: ctx.tenantId, key: "combined_ratio", nameJson: "{}", definitionSqlRef: "x", unit: "ratio", grain: "month", owner: "test", targetJson: "{}", createdAt: ctx.now, updatedAt: ctx.now }
    ]);
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: MONTH_START,
      endAt: NOW + 365 * DAY,
      premiumMinor: 100_000,
      currency: "AED",
      status: "active",
      createdAt: MONTH_START,
      updatedAt: MONTH_START
    });
    await ctx.db.insert(schema.axisPolicyVersions).values({
      id: "polv_1",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      versionSeq: 1,
      reason: "issue",
      effectiveFrom: MONTH_START,
      effectiveTo: NOW,
      premiumMinor: 100_000,
      currency: "AED",
      termsJson: "{}",
      issuedBy: "user:test",
      issuedAt: MONTH_START,
      createdAt: MONTH_START,
      updatedAt: MONTH_START
    });
    await ctx.db.insert(schema.axisClaims).values({
      id: "clm_1",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      customerId: "cu_1",
      claimNo: "C-1",
      incidentAt: MONTH_START + DAY,
      reportedAt: MONTH_START + DAY,
      currency: "AED",
      paidMinor: 20_000,
      reserveMinor: 5_000,
      createdAt: MONTH_START + DAY,
      updatedAt: MONTH_START + DAY
    });
    // 5xxx expense account, 15,000 debit — expense_ratio = 15,000 / 100,000 = 1,500 bp.
    await ctx.db.insert(schema.ledgerJournalLines).values({
      id: "ljl_1",
      tenantId: ctx.tenantId,
      batchId: "batch_1",
      txnId: "txn_1",
      seq: 1,
      accountCode: "5100",
      side: "debit",
      amountMinor: 15_000,
      currency: "AED",
      baseAmountMinor: 15_000,
      baseCurrency: "AED",
      postedAt: MONTH_START + DAY
    });

    const result = await runSnapshotter(ctx);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "combined_ratio")));
    // loss_ratio 2,500 bp + expense_ratio 1,500 bp = 4,000 bp, from rows written earlier in this same run.
    expect(row!.value).toBe(4_000);
    expect(result.written).toBeGreaterThanOrEqual(3);
  });
});

// docs/27 F49: the briefing narrates net commission, and `verifyNumericClaims`
// confirms the prose matches the snapshot. It did. The bug was in the number:
// a sum of `axis_policies.commission_minor` is gross of the channel's share,
// blind to every clawback, and ties to nothing in the trial balance.
describe("runSnapshotter: net_commission reads the ledger", () => {
  const FEB_14 = Date.UTC(2026, 1, 14);
  const MAR_1 = Date.UTC(2026, 2, 1);

  const jline = (id: string, code: string, side: "debit" | "credit", amountMinor: number, postedAt: number, channel?: string) => ({
    id,
    tenantId: "t_1",
    batchId: `b_${id}`,
    txnId: `tx_${id}`,
    seq: 1,
    accountCode: code,
    side,
    amountMinor,
    currency: "AED",
    baseAmountMinor: amountMinor,
    baseCurrency: "AED",
    ...(channel ? { dimsJson: JSON.stringify({ channel }) } : {}),
    postedAt
  });

  beforeEach(async () => {
    await seedMetric("net_commission", "month");
    await seedProviderAndCustomer();
    // The figure the old compute would have returned: gross, un-clawed-back.
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      channelId: "ch_web",
      startAt: FEB_14,
      endAt: FEB_14 + 365 * DAY,
      premiumMinor: 1_000_000,
      commissionMinor: 900_000,
      currency: "AED",
      status: "active",
      createdAt: FEB_14,
      updatedAt: FEB_14
    });
  });

  it("is our share of the commission, net of the channel's and net of a clawback", async () => {
    await ctx.db.insert(schema.ledgerJournalLines).values([
      jline("c1", "1100", "debit", 100_000, FEB_14, "ch_web"),
      jline("c2", "4000", "credit", 70_000, FEB_14, "ch_web"),
      jline("c3", "2100", "credit", 30_000, FEB_14, "ch_web"), // the channel's 30%, never ours
      // Cooling-off cancellation, posted as a contra batch a week later.
      jline("c4", "4000", "debit", 20_000, FEB_14 + 7 * DAY, "ch_web"),
      jline("c5", "2100", "debit", 8_000, FEB_14 + 7 * DAY, "ch_web")
    ]);

    ctx.now = MAR_1 + 2 * 3_600_000;
    await runSnapshotter(ctx);

    const rows = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "net_commission")));
    const february = rows.find((r) => r.period === "2026-02" && r.dimsHash === "");
    expect(february!.value).toBe(50_000); // 70,000 earned less 20,000 clawed back
  });

  it("decomposes by the channel the ledger line was stamped with", async () => {
    await ctx.db.insert(schema.ledgerJournalLines).values([
      jline("w1", "4000", "credit", 40_000, FEB_14, "ch_web"),
      jline("b1", "4000", "credit", 60_000, FEB_14, "ch_broker"),
      jline("b2", "2100", "credit", 25_000, FEB_14, "ch_broker")
    ]);

    ctx.now = MAR_1 + 2 * 3_600_000;
    await runSnapshotter(ctx);

    const slices = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(
        and(
          eq(schema.northSnapshots.tenantId, ctx.tenantId),
          eq(schema.northSnapshots.metricKey, "net_commission"),
          eq(schema.northSnapshots.period, "2026-02")
        )
      );
    expect(slices.find((s) => s.dimsHash === "channel=ch_web")!.value).toBe(40_000);
    expect(slices.find((s) => s.dimsHash === "channel=ch_broker")!.value).toBe(60_000);
    // The slices are the grand total cut up, so they have to add back to it.
    expect(slices.find((s) => s.dimsHash === "")!.value).toBe(100_000);
  });

  it("a month the ledger recorded no commission in is a zero, not the policy table's opinion", async () => {
    ctx.now = MAR_1 + 2 * 3_600_000;
    await runSnapshotter(ctx);

    const [february] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(
        and(
          eq(schema.northSnapshots.tenantId, ctx.tenantId),
          eq(schema.northSnapshots.metricKey, "net_commission"),
          eq(schema.northSnapshots.period, "2026-02"),
          eq(schema.northSnapshots.dimsHash, "")
        )
      );
    expect(february!.value).toBe(0);
  });
});
describe("runSnapshotter: gross_written_premium / net_written_premium", () => {
  it("sums premium+tax+fees for gross, premium only for net, filtered by effectiveFrom in period", async () => {
    await seedMetric("gross_written_premium", "day");
    await seedMetric("net_written_premium", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID,
      endAt: YESTERDAY_MID + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID,
      updatedAt: YESTERDAY_MID
    });
    await ctx.db.insert(schema.axisPolicyVersions).values([
      {
        id: "polv_yesterday",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        versionSeq: 1,
        reason: "issue",
        effectiveFrom: YESTERDAY_MID,
        effectiveTo: YESTERDAY_MID + 365 * DAY,
        premiumMinor: 10_000,
        taxMinor: 500,
        feesMinor: 200,
        currency: "AED",
        termsJson: "{}",
        issuedBy: "user:test",
        issuedAt: YESTERDAY_MID,
        createdAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "polv_voided",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        versionSeq: 2,
        reason: "cancellation",
        effectiveFrom: YESTERDAY_MID,
        effectiveTo: YESTERDAY_MID + 365 * DAY,
        premiumMinor: 999_999,
        taxMinor: 999_999,
        feesMinor: 999_999,
        currency: "AED",
        termsJson: "{}",
        state: "voided",
        issuedBy: "user:test",
        issuedAt: YESTERDAY_MID,
        createdAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "polv_today",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        versionSeq: 3,
        reason: "endorsement",
        effectiveFrom: NOW,
        effectiveTo: NOW + 365 * DAY,
        premiumMinor: 1_000_000,
        taxMinor: 1_000_000,
        feesMinor: 1_000_000,
        currency: "AED",
        termsJson: "{}",
        issuedBy: "user:test",
        issuedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(2);

    const rows = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(eq(schema.northSnapshots.tenantId, ctx.tenantId));
    expect(rows.find((r) => r.metricKey === "gross_written_premium")!.value).toBe(10_700);
    expect(rows.find((r) => r.metricKey === "net_written_premium")!.value).toBe(10_000);
  });
});

describe("runSnapshotter: quote_hit_rate", () => {
  it("divides BIND txns created in period by quote requests created in period", async () => {
    await seedMetric("quote_hit_rate", "day");
    const quoteRequestBase = {
      tenantId: ctx.tenantId,
      channelId: "chan_1",
      productId: "prod_1",
      inputsJson: "{}",
      currency: "AED",
      updatedAt: YESTERDAY_MID
    };
    await ctx.db.insert(schema.distQuoteRequests).values([
      { ...quoteRequestBase, id: "qr_1", createdAt: YESTERDAY_MID },
      { ...quoteRequestBase, id: "qr_2", createdAt: YESTERDAY_MID },
      { ...quoteRequestBase, id: "qr_3", createdAt: YESTERDAY_MID },
      { ...quoteRequestBase, id: "qr_4", createdAt: YESTERDAY_MID },
      { ...quoteRequestBase, id: "qr_today", createdAt: NOW, updatedAt: NOW }
    ]);
    await ctx.db.insert(schema.ledgerTxns).values([
      {
        id: "txn_bind",
        tenantId: ctx.tenantId,
        type: "BIND",
        idempotencyKey: "idem_bind",
        actorKind: "system",
        actorId: "scheduler",
        currency: "AED",
        baseCurrency: "AED",
        createdAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "txn_other",
        tenantId: ctx.tenantId,
        type: "CMSN-ACCR",
        idempotencyKey: "idem_other",
        actorKind: "system",
        actorId: "scheduler",
        currency: "AED",
        baseCurrency: "AED",
        createdAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "quote_hit_rate")));
    // 1 BIND / 4 requests created yesterday = 2,500 bp.
    expect(row!.value).toBe(2_500);
  });
});

describe("runSnapshotter: avg_handling_time_claims", () => {
  it("takes the median closedAt - reportedAt over claims closed in period", async () => {
    await seedMetric("avg_handling_time_claims", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID - 365 * DAY,
      endAt: NOW + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID - 365 * DAY,
      updatedAt: YESTERDAY_MID - 365 * DAY
    });
    await ctx.db.insert(schema.axisClaims).values([
      {
        id: "clm_1",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-1",
        reportedAt: YESTERDAY_MID - 2 * DAY,
        closedAt: YESTERDAY_MID,
        currency: "AED",
        createdAt: YESTERDAY_MID - 2 * DAY,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "clm_2",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-2",
        reportedAt: YESTERDAY_MID - 6 * DAY,
        closedAt: YESTERDAY_MID,
        currency: "AED",
        createdAt: YESTERDAY_MID - 6 * DAY,
        updatedAt: YESTERDAY_MID
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "avg_handling_time_claims")));
    // median of 2 days and 6 days = 4 days, in ms.
    expect(row!.value).toBe(4 * DAY);
  });
});

describe("runSnapshotter: avg_handling_time_cases", () => {
  it("takes the median closedAt - createdAt over cases closed in period", async () => {
    await seedMetric("avg_handling_time_cases", "day");
    await ctx.db.insert(schema.axisCases).values([
      {
        id: "case_1",
        tenantId: ctx.tenantId,
        ref: "CASE-1",
        kind: "quote",
        createdAt: YESTERDAY_MID - DAY,
        closedAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "case_2",
        tenantId: ctx.tenantId,
        ref: "CASE-2",
        kind: "quote",
        createdAt: YESTERDAY_MID - 3 * DAY,
        closedAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "avg_handling_time_cases")));
    // median of 1 day and 3 days = 2 days, in ms.
    expect(row!.value).toBe(2 * DAY);
  });
});

describe("runSnapshotter: sla_breach_rate", () => {
  it("counts cases and claims closed past their slaDueAt", async () => {
    await seedMetric("sla_breach_rate", "day");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisCases).values([
      {
        id: "case_ontime",
        tenantId: ctx.tenantId,
        ref: "CASE-1",
        kind: "quote",
        slaDueAt: YESTERDAY_MID + DAY,
        createdAt: YESTERDAY_MID - DAY,
        closedAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      },
      {
        id: "case_breached",
        tenantId: ctx.tenantId,
        ref: "CASE-2",
        kind: "quote",
        slaDueAt: YESTERDAY_MID - DAY,
        createdAt: YESTERDAY_MID - 3 * DAY,
        closedAt: YESTERDAY_MID,
        updatedAt: YESTERDAY_MID
      }
    ]);
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: YESTERDAY_MID - 365 * DAY,
      endAt: NOW + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: YESTERDAY_MID - 365 * DAY,
      updatedAt: YESTERDAY_MID - 365 * DAY
    });
    await ctx.db.insert(schema.axisClaims).values({
      id: "clm_breached",
      tenantId: ctx.tenantId,
      policyId: "pol_1",
      customerId: "cu_1",
      claimNo: "C-1",
      reportedAt: YESTERDAY_MID - 3 * DAY,
      slaDueAt: YESTERDAY_MID - DAY,
      closedAt: YESTERDAY_MID,
      currency: "AED",
      createdAt: YESTERDAY_MID - 3 * DAY,
      updatedAt: YESTERDAY_MID
    });

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "sla_breach_rate")));
    // 2 breached (1 case + 1 claim) / 3 closed total = 6,667 bp.
    expect(row!.value).toBe(6_667);
  });
});

describe("runSnapshotter: open_claim_count / outstanding_reserve", () => {
  it("point-in-time gauges ignore the period window and current status/reserve", async () => {
    await seedMetric("open_claim_count", "month");
    await seedMetric("outstanding_reserve", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values({
      id: "pol_1",
      tenantId: ctx.tenantId,
      customerId: "cu_1",
      providerId: "prov_1",
      policyNo: "P-1",
      startAt: MONTH_START - 365 * DAY,
      endAt: NOW + 365 * DAY,
      premiumMinor: 10_000,
      currency: "AED",
      status: "active",
      createdAt: MONTH_START - 365 * DAY,
      updatedAt: MONTH_START - 365 * DAY
    });
    await ctx.db.insert(schema.axisClaims).values([
      {
        id: "clm_open",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-1",
        reportedAt: MONTH_START - 365 * DAY,
        reserveMinor: 5_000,
        currency: "AED",
        status: "assessing",
        createdAt: MONTH_START - 365 * DAY,
        updatedAt: MONTH_START - 365 * DAY
      },
      {
        id: "clm_withdrawn",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-2",
        reportedAt: MONTH_START - 365 * DAY,
        reserveMinor: 1_000,
        currency: "AED",
        status: "withdrawn",
        createdAt: MONTH_START - 365 * DAY,
        updatedAt: MONTH_START - 365 * DAY
      },
      {
        id: "clm_closed",
        tenantId: ctx.tenantId,
        policyId: "pol_1",
        customerId: "cu_1",
        claimNo: "C-3",
        reportedAt: MONTH_START - 365 * DAY,
        closedAt: MONTH_START - 100 * DAY,
        reserveMinor: 2_000,
        currency: "AED",
        status: "settled",
        createdAt: MONTH_START - 365 * DAY,
        updatedAt: MONTH_START - 100 * DAY
      }
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(2);

    const rows = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(eq(schema.northSnapshots.tenantId, ctx.tenantId));
    // Only clm_open has no closedAt and a non-excluded status.
    expect(rows.find((r) => r.metricKey === "open_claim_count")!.value).toBe(1);
    // Sums reserveMinor across all claims regardless of status/closedAt: 5,000 + 1,000 + 2,000.
    expect(rows.find((r) => r.metricKey === "outstanding_reserve")!.value).toBe(8_000);
  });
});

// NORTH saw AXIS and the ledger but neither end of the demand loop: SCOUT
// found the gaps and SIGNAL spent against them, and the board pack could see
// neither the pipeline nor what came back. These two close it.
describe("runSnapshotter: whitespace_promotion_rate", () => {
  const ws = (id: string, over: Record<string, unknown>) => ({
    id,
    tenantId: ctx.tenantId,
    description: id,
    createdAt: MONTH_START,
    updatedAt: MONTH_START,
    ...over
  });

  it("divides whitespaces promoted in period by whitespaces raised in period", async () => {
    await seedMetric("whitespace_promotion_rate", "month");
    await ctx.db.insert(schema.scoutWhitespaces).values([
      ws("ws_1", { promotedAt: MONTH_START + 1 }),
      ws("ws_2", {}),
      ws("ws_3", {}),
      ws("ws_4", {}),
      // Raised before this month: neither side of the ratio counts it.
      ws("ws_old", { createdAt: MONTH_START - DAY, updatedAt: MONTH_START - DAY, promotedAt: MONTH_START - DAY })
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "whitespace_promotion_rate")));
    // 1 promoted / 4 raised this month = 2,500 bp.
    expect(row!.value).toBe(2_500);
  });

  it("writes nothing for a month that raised no candidate at all", async () => {
    await seedMetric("whitespace_promotion_rate", "month");
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });

  it("is a month metric — the day period computes nothing", async () => {
    await seedMetric("whitespace_promotion_rate", "day");
    await ctx.db.insert(schema.scoutWhitespaces).values([ws("ws_1", { createdAt: YESTERDAY_MID, updatedAt: YESTERDAY_MID, promotedAt: YESTERDAY_MID })]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });
});

describe("runSnapshotter: campaign_return_on_spend", () => {
  const spendRow = (id: string, amountMinor: number, ts: number) => ({
    id,
    tenantId: ctx.tenantId,
    campaignId: "cmp_1",
    channel: "email",
    day: new Date(ts).toISOString().slice(0, 10),
    amountMinor,
    currency: "AED",
    ts
  });
  const touch = (id: string, over: Record<string, unknown>) => ({
    id,
    tenantId: ctx.tenantId,
    touchType: "bind",
    channel: "email",
    campaignId: "cmp_1",
    currency: "AED",
    ts: MONTH_START + 1,
    ...over
  });

  it("divides the value attributed to binds by the spend that bought them", async () => {
    await seedMetric("campaign_return_on_spend", "month");
    await ctx.db.insert(schema.signalSpend).values([
      spendRow("sp_1", 40_000, MONTH_START + 1),
      // Spent last month: outside the window, so it cannot dilute this month.
      spendRow("sp_old", 999_000, MONTH_START - DAY)
    ]);
    await ctx.db.insert(schema.signalAttributionEvents).values([
      touch("at_1", { valueMinor: 90_000 }),
      touch("at_2", { valueMinor: 30_000 }),
      // A click carries no bind value, and a bind without one cannot be counted.
      touch("at_click", { touchType: "click", valueMinor: 500_000 }),
      touch("at_novalue", { valueMinor: null }),
      touch("at_old", { valueMinor: 500_000, ts: MONTH_START - DAY })
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);

    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "campaign_return_on_spend")));
    // 120,000 attributed / 40,000 spent = 3x, as 30,000 bp.
    expect(row!.value).toBe(30_000);
  });

  it("writes nothing for a month with attribution but no spend to divide by", async () => {
    await seedMetric("campaign_return_on_spend", "month");
    await ctx.db.insert(schema.signalAttributionEvents).values([touch("at_1", { valueMinor: 90_000 })]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });

  it("writes a zero for spend that bought no bind — that is a result, not a gap", async () => {
    await seedMetric("campaign_return_on_spend", "month");
    await ctx.db.insert(schema.signalSpend).values([spendRow("sp_1", 40_000, MONTH_START + 1)]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);
    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, "campaign_return_on_spend")));
    expect(row!.value).toBe(0);
  });
});

// The unit economics of acquisition: what a lead costs, what a bound contract
// costs, and what the book pays back per contract and per customer. The spend
// numerator is the one campaign_return_on_spend divides by, so a window that
// drifted here would disagree with a metric on the same board.
describe("runSnapshotter: acquisition unit economics", () => {
  const spendRow = (id: string, amountMinor: number, ts: number) => ({
    id,
    tenantId: ctx.tenantId,
    campaignId: "cmp_1",
    channel: "google_search",
    day: new Date(ts).toISOString().slice(0, 10),
    amountMinor,
    currency: "AED",
    ts
  });
  const touch = (id: string, touchType: string, ts: number, over: Record<string, unknown> = {}) => ({
    id,
    tenantId: ctx.tenantId,
    touchType,
    channel: "google_search",
    campaignId: "cmp_1",
    ts,
    ...over
  });
  const policy = (id: string, customerId: string, createdAt: number) => ({
    id,
    tenantId: ctx.tenantId,
    customerId,
    providerId: "prov_1",
    policyNo: id,
    startAt: createdAt,
    endAt: createdAt + 365 * DAY,
    premiumMinor: 400_000,
    currency: "AED",
    status: "active",
    createdAt,
    updatedAt: createdAt
  });
  const entry = (id: string, policyId: string, netMinor: number, earnedAt: number | null, kind = "new_business") => ({
    id,
    tenantId: ctx.tenantId,
    policyId,
    providerId: "prov_1",
    channelId: "chn_1",
    kind,
    premiumMinor: 400_000,
    grossCommissionMinor: netMinor,
    netCommissionMinor: netMinor,
    currency: "AED",
    earnedOn: earnedAt === null ? "collection" : "issue",
    earnedAt,
    state: "accrued",
    createdAt: earnedAt ?? MONTH_START,
    updatedAt: earnedAt ?? MONTH_START
  });

  const valueOf = async (metricKey: string): Promise<number | undefined> => {
    const [row] = await ctx.db
      .select()
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.metricKey, metricKey)));
    return row?.value;
  };

  it("cost_per_lead divides the month's spend by the leads attributed in it", async () => {
    await seedMetric("cost_per_lead", "month");
    await ctx.db.insert(schema.signalSpend).values([
      spendRow("sp_1", 30_000, MONTH_START),
      spendRow("sp_2", 10_000, MONTH_START + DAY),
      // The day before the month opened: outside the window.
      spendRow("sp_old", 999_000, MONTH_START - DAY)
    ]);
    await ctx.db.insert(schema.signalAttributionEvents).values([
      // Exactly on the opening instant — the window is [monthStart, now).
      touch("at_1", "lead", MONTH_START),
      touch("at_2", "lead", MONTH_START + 1),
      touch("at_3", "lead", MONTH_START + 2),
      touch("at_4", "lead", MONTH_START + 3),
      // One millisecond before it: last month's lead, and not this month's cost.
      touch("at_old", "lead", MONTH_START - 1),
      // A click is interest, not a lead.
      touch("at_click", "click", MONTH_START + 4)
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);
    // 40,000 spent / 4 leads = AED 100 a lead, in minor units.
    expect(await valueOf("cost_per_lead")).toBe(10_000);
  });

  it("cost_per_lead writes nothing for a month whose spend produced no lead", async () => {
    await seedMetric("cost_per_lead", "month");
    await ctx.db.insert(schema.signalSpend).values([spendRow("sp_1", 40_000, MONTH_START)]);
    await ctx.db.insert(schema.signalAttributionEvents).values([touch("at_click", "click", MONTH_START + 1)]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });

  it("cost_per_acquisition divides the same spend by the binds attributed in it", async () => {
    await seedMetric("cost_per_acquisition", "month");
    await ctx.db.insert(schema.signalSpend).values([
      spendRow("sp_1", 40_000, MONTH_START),
      spendRow("sp_old", 999_000, MONTH_START - DAY)
    ]);
    await ctx.db.insert(schema.signalAttributionEvents).values([
      touch("at_1", "bind", MONTH_START, { valueMinor: 448_000, currency: "AED" }),
      // A bind whose value nobody filled in is still an acquisition the spend bought.
      touch("at_2", "bind", MONTH_START + 1),
      touch("at_lead", "lead", MONTH_START + 2),
      touch("at_old", "bind", MONTH_START - 1, { valueMinor: 448_000, currency: "AED" })
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);
    // 40,000 spent / 2 binds = AED 200 an acquisition.
    expect(await valueOf("cost_per_acquisition")).toBe(20_000);
  });

  it("cost_per_acquisition writes nothing for a month whose spend bound nothing", async () => {
    await seedMetric("cost_per_acquisition", "month");
    await ctx.db.insert(schema.signalSpend).values([spendRow("sp_1", 40_000, MONTH_START)]);
    await ctx.db.insert(schema.signalAttributionEvents).values([touch("at_lead", "lead", MONTH_START + 1)]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });

  it("commission_per_policy nets the clawback against the month the entry was earned in", async () => {
    await seedMetric("commission_per_policy", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([
      policy("pol_a", "cu_1", MONTH_START),
      policy("pol_b", "cu_1", MONTH_START + DAY),
      // Bound one millisecond before the month: neither its contract nor its commission is this month's.
      policy("pol_old", "cu_1", MONTH_START - 1)
    ]);
    await ctx.db.insert(schema.distCommissionEntries).values([
      entry("ce_a", "pol_a", 90_000, MONTH_START),
      entry("ce_b", "pol_b", 50_000, MONTH_START + DAY),
      // A clawback carries the original's earnedAt, so it reduces the month it was booked in.
      entry("ce_claw", "pol_a", -20_000, MONTH_START + 2 * DAY, "clawback"),
      // Earned on collection and not yet collected: nothing has accrued.
      entry("ce_pending", "pol_b", 70_000, null, "endorsement"),
      entry("ce_old", "pol_old", 400_000, MONTH_START - 1)
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);
    // (90,000 + 50,000 - 20,000) accrued / 2 contracts bound = 60,000.
    expect(await valueOf("commission_per_policy")).toBe(60_000);
  });

  it("commission_per_policy writes nothing for a month that bound no contract", async () => {
    await seedMetric("commission_per_policy", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([policy("pol_old", "cu_1", MONTH_START - 1)]);
    // Commission still trickles in off last month's book; there is no contract to divide it by.
    await ctx.db.insert(schema.distCommissionEntries).values([entry("ce_a", "pol_old", 90_000, MONTH_START + 1)]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });

  it("revenue_per_customer divides the same commission by distinct customers, not by contracts", async () => {
    await seedMetric("revenue_per_customer", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.customers).values([
      { id: "cu_2", tenantId: ctx.tenantId, nameJson: JSON.stringify({ first: "Rania" }), createdAt: ctx.now, updatedAt: ctx.now },
      { id: "cu_3", tenantId: ctx.tenantId, nameJson: JSON.stringify({ first: "Omar" }), createdAt: ctx.now, updatedAt: ctx.now }
    ]);
    await ctx.db.insert(schema.axisPolicies).values([
      // Two contracts, one customer — the denominator counts her once.
      policy("pol_a", "cu_1", MONTH_START),
      policy("pol_b", "cu_1", MONTH_START + DAY),
      policy("pol_c", "cu_2", MONTH_START + 2 * DAY),
      // A customer whose only contract predates the month is not this month's.
      policy("pol_old", "cu_3", MONTH_START - 1)
    ]);
    await ctx.db.insert(schema.distCommissionEntries).values([
      entry("ce_a", "pol_a", 90_000, MONTH_START),
      entry("ce_b", "pol_b", 50_000, MONTH_START + DAY),
      entry("ce_c", "pol_c", 40_000, MONTH_START + 2 * DAY)
    ]);

    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(1);
    // 180,000 accrued / 2 distinct customers = 90,000.
    expect(await valueOf("revenue_per_customer")).toBe(90_000);
  });

  it("revenue_per_customer writes nothing for a month no customer took a contract in", async () => {
    await seedMetric("revenue_per_customer", "month");
    await seedProviderAndCustomer();
    await ctx.db.insert(schema.axisPolicies).values([policy("pol_old", "cu_1", MONTH_START - 1)]);
    await ctx.db.insert(schema.distCommissionEntries).values([entry("ce_a", "pol_old", 90_000, MONTH_START + 1)]);
    const result = await runSnapshotter(ctx);
    expect(result.written).toBe(0);
  });
});

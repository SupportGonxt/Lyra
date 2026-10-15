import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, ne } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, id as newId, schema, type Db } from "@lyra/db";
import { permissionsForRole, seed, type Ctx, type SeedResult } from "@lyra/core";
import { runSnapshotter } from "./engines/north-snapshotter.js";

// docs/30 §0's last genuinely dead event: **`north.anomaly.detected`**.
//
// The name was in the spec and in the subscribers and in no emitter — the
// snapshotter wrote a `north_anomalies` row and announced it to nobody, so a
// journey, webhook or alert waiting on an anomaly could never fire. It emits now,
// and this file is the test that was owed when the fix landed.
//
// What it pins, and why each half matters:
//   - an anomaly **is** announced, with the figures a consumer needs;
//   - an anomaly that is **already open** is not announced again — re-detecting
//     it is not a new event, and a second envelope would fire a subscriber twice
//     for one thing happening.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const DAY = 86_400_000;

let database: Db;
let seeded: SeedResult;

const outbox = () =>
  database
    .select()
    .from(schema.eventOutbox)
    .where(and(eq(schema.eventOutbox.tenantId, seeded.tenantId), eq(schema.eventOutbox.type, "north.anomaly.detected")));

function ctxFor(now: number): Ctx {
  return {
    db: database as never,
    tenantId: seeded.tenantId,
    actor: { kind: "system", id: "scheduler", tenantId: seeded.tenantId, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_snap",
    now,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  } as unknown as Ctx;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(stmt);
  }
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });

  // One metric, so the fixture is about the anomaly path rather than about every
  // registered compute in the tree. `policies_issued` is a plain day-grain count
  // of `axis_policies`, which is easy to drive and impossible to misread.
  await database.delete(schema.northMetrics).where(and(eq(schema.northMetrics.tenantId, seeded.tenantId), ne(schema.northMetrics.key, "policies_issued")));
  const [metric] = await database.select().from(schema.northMetrics).where(eq(schema.northMetrics.key, "policies_issued"));
  expect(metric?.grain).toBe("day");
}, 120_000);

describe("north.anomaly.detected", () => {
  it("announces a detected anomaly once, with the figures a consumer needs", async () => {
    const now = Date.UTC(2026, 5, 15, 9);
    const yesterdayStart = Math.floor(now / DAY) * DAY - DAY;
    const dayBefore = yesterdayStart - DAY;

    // The prior day's snapshot is the baseline: 100 policies. The threshold for a
    // count is 1_500bp, so yesterday's 200 is a 100% move — unambiguously over.
    await database.insert(schema.northSnapshots).values({
      id: newId("snp", dayBefore),
      tenantId: seeded.tenantId,
      metricKey: "policies_issued",
      grain: "day",
      period: "2026-06-13",
      dimsHash: "",
      value: 100,
      ts: dayBefore,
      closed: 1
    } as never);

    for (let i = 0; i < 200; i += 1) {
      await database.insert(schema.axisPolicies).values({
        id: newId("pol", yesterdayStart + i),
        tenantId: seeded.tenantId,
        customerId: `cust_anomaly_${i}`,
        providerId: "prov_test",
        productId: "prd_test",
        offeringId: "off_test",
        channelId: "chn_test",
        policyNo: `ANOM-${i}`,
        startAt: yesterdayStart,
        endAt: yesterdayStart + 365 * DAY,
        premiumMinor: 100_000,
        taxMinor: 0,
        feesMinor: 0,
        grossMinor: 100_000,
        currency: "AED",
        commissionMinor: 1_000,
        status: "active",
        createdAt: yesterdayStart + 1,
        updatedAt: yesterdayStart + 1
      } as never);
    }

    const first = await runSnapshotter(ctxFor(now));
    expect(first.anomalies).toBeGreaterThanOrEqual(1);

    const events = await outbox();
    expect(events).toHaveLength(1);
    // The outbox stores the whole envelope, so the figures sit under `data`.
    const envelope = JSON.parse(String(events[0]!.envelopeJson)) as {
      subject?: string;
      data?: Record<string, unknown>;
    };
    const payload = envelope.data ?? {};
    expect(payload.anomalyId).toBeTruthy();
    // The subject is the anomaly itself, so a consumer can act without unwrapping.
    expect(envelope.subject).toBe(payload.anomalyId);
    expect(payload.metricKey).toBe("policies_issued");
    // The magnitude is the fact a consumer acts on; a bare notification would
    // make every subscriber go and look it up.
    expect(Number(payload.magnitudeBp)).toBeGreaterThanOrEqual(1_500);

    // Second run, same open anomaly: the row is already there, so there is
    // nothing new to announce. This is the whole reason the emit sits inside the
    // `!openAnomaly` branch.
    await runSnapshotter(ctxFor(now));
    expect(await outbox()).toHaveLength(1);
  });
});

/* ------------------------------------ a headline figure counts one currency */

/**
 * `gwp` summed every policy's premium regardless of currency and the NORTH screen
 * rendered the total as *"AED 1,234,567.00"* — while the commission reader beside
 * it **dropped** every non-AED row. A broker writing in nine MENA markets holds
 * nine currencies in `axis_policies` (`routes/axis.ts` stamps each policy with the
 * quote's currency and never checks it against the tenant's own), so the module
 * whose whole job is being right about a number was wrong in both directions at
 * once.
 *
 * The metric now states one currency and counts only that currency. **Filtering
 * makes the figure true, not complete** — the per-market cut that reports the
 * excluded rows is the follow-up, and this test pins the half that exists so the
 * assertion cannot quietly drift back.
 */
describe("a money metric counts one currency", () => {
  it("leaves a foreign-currency policy out of the functional-currency figure", async () => {
    const now = Date.UTC(2026, 8, 15, 9);
    const yesterdayStart = Math.floor(now / DAY) * DAY - DAY;

    // Put the metric back: the anomaly fixture deletes every metric but one.
    await database.insert(schema.northMetrics).values({
      id: newId("mtr", now),
      tenantId: seeded.tenantId,
      key: "gwp",
      nameJson: JSON.stringify({ en: "Gross written premium", ar: "إجمالي الأقساط المكتتبة" }),
      definitionSqlRef: "sql/metrics/gwp.sql",
      unit: "money",
      currency: "AED",
      grain: "day",
      direction: "up",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now
    } as never);

    const policy = (currency: string, premiumMinor: number, i: number) => ({
      id: newId("pol", yesterdayStart + i),
      tenantId: seeded.tenantId,
      customerId: `cust_ccy_${i}`,
      providerId: "prov_test",
      productId: "prd_test",
      offeringId: "off_test",
      channelId: "chn_test",
      policyNo: `CCY-${currency}-${i}`,
      startAt: yesterdayStart,
      endAt: yesterdayStart + 365 * DAY,
      premiumMinor,
      taxMinor: 0,
      feesMinor: 0,
      grossMinor: premiumMinor,
      currency,
      commissionMinor: 1_000,
      status: "active",
      createdAt: yesterdayStart + 1,
      updatedAt: yesterdayStart + 1
    });

    await database.insert(schema.axisPolicies).values([
      policy("AED", 1_000_000, 900),
      // Nine hundred times the AED premium, and in a currency the tenant does not
      // report in. Before the fix this made the AED headline a hundred times too
      // large, with nothing on screen saying so.
      policy("SAR", 900_000_000, 901)
    ] as never);

    await runSnapshotter(ctxFor(now));

    const [row] = await database
      .select({ value: schema.northSnapshots.value, currency: schema.northMetrics.currency })
      .from(schema.northSnapshots)
      .innerJoin(schema.northMetrics, eq(schema.northMetrics.key, schema.northSnapshots.metricKey))
      .where(and(eq(schema.northSnapshots.metricKey, "gwp"), eq(schema.northSnapshots.period, "2026-09-14")));

    expect(row).toBeTruthy();
    // The AED premium and the 200 AED policies the anomaly test wrote — never the
    // SAR one, however large it is.
    expect(row!.value).toBeLessThan(900_000_000);
    expect(row!.currency).toBe("AED");
  });
});

/* ------------------------------- the crown: a market cut with a null bucket */

/**
 * ADR-0128. `gwp` filters to the functional currency, which makes the figure
 * **true**; it does not make it **complete**, because an executive still cannot
 * see the markets she is not being shown. `gwp_by_market` is the cut — and the
 * requirement the ADR records is that policies with **no market on file** land in
 * a *named* bucket rather than being dropped, because those are the placements
 * nobody can attribute, which is information rather than noise.
 */
describe("gwp_by_market cuts the headline and names what it cannot attribute", () => {
  it("writes a series per market, and an `unrecorded` bucket rather than dropping rows", async () => {
    const now = Date.UTC(2026, 11, 15, 9);
    const yesterdayStart = Math.floor(now / DAY) * DAY - DAY;

    await database.insert(schema.northMetrics).values({
      id: newId("mtr", now),
      tenantId: seeded.tenantId,
      key: "gwp_by_market",
      nameJson: JSON.stringify({ en: "GWP by market", ar: "إجمالي الأقساط حسب السوق" }),
      definitionSqlRef: "sql/metrics/gwp_by_market.sql",
      unit: "money",
      currency: "AED",
      grain: "month",
      direction: "up",
      sensitivity: "internal",
      createdAt: now,
      updatedAt: now
    } as never);

    const policy = (market: string | null, i: number) => ({
      id: newId("pol", yesterdayStart + i),
      tenantId: seeded.tenantId,
      customerId: `cust_mkt_${i}`,
      providerId: "prov_test",
      productId: "prd_test",
      offeringId: "off_test",
      channelId: "chn_test",
      policyNo: `MKT-${i}`,
      startAt: yesterdayStart,
      endAt: yesterdayStart + 365 * DAY,
      premiumMinor: 1_000,
      taxMinor: 0,
      feesMinor: 0,
      grossMinor: 1_000,
      currency: "AED",
      commissionMinor: 10,
      market,
      status: "active",
      createdAt: yesterdayStart + 1,
      updatedAt: yesterdayStart + 1
    });

    // One attributable placement and one that predates the column — the null the
    // ADR insists is bucketed rather than lost.
    await database.insert(schema.axisPolicies).values([policy("AE", 700), policy(null, 701)] as never);

    // The month period, which is where a month-grain money metric lands.
    await runSnapshotter(ctxFor(now));

    const rows = await database
      .select({ dimsHash: schema.northSnapshots.dimsHash, value: schema.northSnapshots.value })
      .from(schema.northSnapshots)
      .where(and(eq(schema.northSnapshots.tenantId, seeded.tenantId), eq(schema.northSnapshots.metricKey, "gwp_by_market")));

    const keys = rows.map((row) => row.dimsHash).sort();
    expect(keys).toContain("market=AE");
    // The bucket, named. A cut that dropped this row would hide the placements
    // nobody can attribute — the ones a nine-market broker most needs to see.
    expect(keys).toContain("market=unrecorded");
  });
});

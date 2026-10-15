import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx } from "@lyra/core";
import { Gateway } from "@lyra/model-gateway";
import {
  ALETHEIA_METRIC_MAP,
  aletheiaInsightsUrl,
  findingsFrom,
  gatherSentinelInput,
  marketMetrics,
  runAletheiaSentinel
} from "./aletheia-sentinel.js";

// A7: the half of the SCOUT sentinel that needs Aletheia. Without it the watch
// only knows what *moved*; it cannot say whether a value is out of band for a
// business this size, because its only baseline is the tenant's own recent
// history. Gated on ALETHEIA_URL like the ingest, so the nightly tick is
// identical whether or not the engine is deployed.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";
const DAY = 86_400_000;

let client: Client;
let ctx: Ctx;

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: TENANT,
    actor: { kind: "system", id: "scheduler", tenantId: TENANT, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

const gateway = () => new Gateway({ env: {}, providers: {} });
const ENV = { ALETHEIA_URL: "https://aletheia.test", ALETHEIA_TOKEN: "tok", VEC_MARKET: undefined } as unknown as Parameters<typeof runAletheiaSentinel>[2];

/** A fetch that answers with a fixed reply and records what it was sent. */
function stubFetch(reply: unknown, init: { ok?: boolean; status?: number; throws?: boolean } = {}) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({
      url: String(url),
      body: options?.body ? JSON.parse(String(options.body)) : null,
      headers: (options?.headers ?? {}) as Record<string, string>
    });
    if (init.throws) throw new Error("connection refused");
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => reply
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const finding = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  function: "pricing",
  title: "Price erosion ahead of the market",
  description: "Realised price has fallen while the market index held.",
  money_at_stake: 12000,
  unit: "revenue",
  severity: "warn",
  action: "Re-price the motor panel",
  ...over
});

describe("the endpoint", () => {
  it("is null without ALETHEIA_URL, so the tick is a no-op rather than an error", () => {
    expect(aletheiaInsightsUrl({ ALETHEIA_URL: undefined } as never, "t_1")).toBeNull();
    expect(aletheiaInsightsUrl({ ALETHEIA_URL: "https://a.test/" } as never, "t 1")).toBe("https://a.test/api/t%201/insights");
  });
});

describe("marketMetrics", () => {
  it("groups by Aletheia's business function and KPI names, converting minor units", () => {
    // LYRA holds money in minor units; Aletheia's benchmarks are in currency
    // units, so an unconverted CAC reads as a hundredfold overrun.
    const metrics = marketMetrics({ cacPerPolicyMinor: 250_00, ltvToCac: 3.2, panelWinPct: 41 });
    expect(metrics.marketing?.customer_acquisition_cost).toBe(250);
    expect(metrics.marketing?.ltv_cac_ratio).toBe(3.2);
    expect(metrics.sales?.win_rate).toBe(41);
  });

  it("names only KPIs Aletheia's functions actually define", () => {
    // It *skips* a KPI it does not know, so an invented name produces a
    // confident empty answer rather than an error.
    const known: Record<string, string[]> = {
      marketing: ["customer_acquisition_cost", "customer_lifetime_value", "ltv_cac_ratio", "mql_to_sql_conversion", "marketing_roi"],
      sales: ["win_rate", "pipeline_coverage", "quota_attainment", "average_deal_size", "sales_cycle_length", "customer_churn_rate"],
      pricing: ["gross_margin", "price_erosion", "discount_rate", "price_realization", "price_variance"],
      customer_service: ["csat", "net_promoter_score", "first_contact_resolution", "escalation_rate"]
    };
    for (const spec of Object.values(ALETHEIA_METRIC_MAP)) {
      expect(known[spec.fn], spec.fn).toContain(spec.kpi);
    }
  });

  it("omits what was not measured rather than sending a fabricated zero", () => {
    // A zero is a real, extreme reading to a benchmark engine.
    expect(marketMetrics({})).toEqual({});
    expect(marketMetrics({ cacPerPolicyMinor: 250_00 }).sales).toBeUndefined();
    expect(marketMetrics({ panelWinPct: Number.NaN })).toEqual({});
  });
});

describe("findingsFrom", () => {
  it("reads a finding and drops one missing what makes it a signal", () => {
    const parsed = findingsFrom({ findings: [finding(), { title: "no id" }, { id: "f-2", severity: "invented" }, null, "junk"] });
    expect(parsed).toEqual([
      {
        id: "f-1",
        function: "pricing",
        title: "Price erosion ahead of the market",
        description: "Realised price has fallen while the market index held.",
        moneyAtStake: 12000,
        unit: "revenue",
        severity: "warn",
        action: "Re-price the motor panel"
      }
    ]);
  });

  it("is empty for anything that is not a findings envelope", () => {
    expect(findingsFrom(null)).toEqual([]);
    expect(findingsFrom("nope")).toEqual([]);
    expect(findingsFrom({ findings: "nope" })).toEqual([]);
    expect(findingsFrom({ error: "unknown tenant" })).toEqual([]);
  });
});

describe("runAletheiaSentinel", () => {
  it("stands down without a URL, and does not call out", async () => {
    const { calls, fetchImpl } = stubFetch({ findings: [finding()] });
    const result = await runAletheiaSentinel(ctx, gateway(), { ALETHEIA_URL: undefined } as never, { panelWinPct: 40 }, { fetch: fetchImpl });
    expect(result.standDown).toBe("no-endpoint");
    expect(result.recorded).toBe(0);
    expect(calls).toEqual([]);
  });

  it("stands down when the caller measured nothing", async () => {
    const { calls, fetchImpl } = stubFetch({ findings: [finding()] });
    const result = await runAletheiaSentinel(ctx, gateway(), ENV, {}, { fetch: fetchImpl });
    expect(result.standDown).toBe("no-metrics");
    expect(calls).toEqual([]);
  });

  it("records a finding as a market signal, weighted by severity", async () => {
    const { calls, fetchImpl } = stubFetch({ findings: [finding(), finding({ id: "f-2", severity: "neg" })] });
    const result = await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12 }, { fetch: fetchImpl });

    expect(calls[0]!.url).toBe("https://aletheia.test/api/t_1/insights");
    expect(calls[0]!.body).toEqual({ metrics: { sales: { win_rate: 12 } } });
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");

    expect(result).toMatchObject({ asked: 1, findings: 2, recorded: 2, duplicates: 0, errors: [] });
    const rows = await ctx.db.select().from(schema.scoutSignals).where(eq(schema.scoutSignals.tenantId, TENANT));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.source === "model")).toBe(true);
    // The ref is prefixed: a bare finding id could collide with a feed item's.
    expect(rows.map((row) => row.sourceRef).sort()).toEqual(["aletheia:f-1", "aletheia:f-2"]);
    expect(rows.map((row) => row.weight).sort()).toEqual([3, 5]);
    expect(JSON.parse(rows[0]!.payloadJson)).toMatchObject({ severity: "warn", moneyAtStake: 12000 });
  });

  it("writes nothing the second time, because the harvester dedupes on the ref", async () => {
    const { fetchImpl } = stubFetch({ findings: [finding()] });
    await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12 }, { fetch: fetchImpl });
    const again = await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12 }, { fetch: fetchImpl });
    expect(again.recorded).toBe(0);
    expect(again.duplicates).toBe(1);
    expect(await ctx.db.select().from(schema.scoutSignals)).toHaveLength(1);
  });

  it("names an error rather than taking the nightly tick with it", async () => {
    const throws = stubFetch(null, { throws: true });
    const down = await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12 }, { fetch: throws.fetchImpl });
    expect(down.recorded).toBe(0);
    expect(down.errors[0]).toContain("connection refused");

    const bad = stubFetch({ findings: [] }, { ok: false, status: 503 });
    const refused = await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12 }, { fetch: bad.fetchImpl });
    expect(refused.errors).toEqual(["aletheia answered 503"]);
    expect(await ctx.db.select().from(schema.scoutSignals)).toHaveLength(0);
  });

  it("records an audit row naming what was asked and what came back", async () => {
    const { fetchImpl } = stubFetch({ findings: [finding()] });
    await runAletheiaSentinel(ctx, gateway(), ENV, { panelWinPct: 12, cacPerPolicyMinor: 30_000 }, { fetch: fetchImpl });
    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, TENANT), eq(schema.auditLog.action, "scout.aletheia.sentinel_run")));
    expect(audited).toHaveLength(1);
  });
});

describe("gatherSentinelInput", () => {
  it("measures the tenant's own figures and leaves out what it cannot measure", async () => {
    // Two binds worth 400 000 minor, 100 000 minor of spend → CAC 50 000 minor,
    // LTV:CAC 4. No complaints, so no escalation rate.
    await ctx.db.insert(schema.signalSpend).values({
      id: "spd_1", tenantId: TENANT, campaignId: null, channel: "meta", day: "2026-09-30",
      amountMinor: 100_000, currency: "AED", impressions: 0, clicks: 0, conversions: 0, source: "api", ts: NOW - DAY
    });
    for (const k of [1, 2]) {
      await ctx.db.insert(schema.signalAttributionEvents).values({
        id: `ate_${k}`, tenantId: TENANT, customerId: `cus_${k}`, touchType: "bind", channel: "meta",
        valueMinor: 200_000, currency: "AED", ts: NOW - DAY
      });
    }
    const input = await gatherSentinelInput(ctx);
    expect(input.cacPerPolicyMinor).toBe(50_000);
    expect(input.ltvToCac).toBe(4);
    expect(input.complaintsPerThousand).toBeUndefined();
  });

  it("omits the cost metrics entirely when nothing was sold", async () => {
    // A CAC with no denominator is not zero, it is unknown.
    await ctx.db.insert(schema.signalSpend).values({
      id: "spd_1", tenantId: TENANT, campaignId: null, channel: "meta", day: "2026-09-30",
      amountMinor: 100_000, currency: "AED", impressions: 0, clicks: 0, conversions: 0, source: "api", ts: NOW - DAY
    });
    const input = await gatherSentinelInput(ctx);
    expect(input.cacPerPolicyMinor).toBeUndefined();
    expect(input.ltvToCac).toBeUndefined();
  });
});

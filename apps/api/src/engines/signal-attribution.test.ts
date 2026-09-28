import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { cacRange, permissionsForRole, type Actor, type Ctx, type Envelope } from "@lyra/core";
import { acquisitionCostRange, funnelByCampaign, onBindIssued, recordTouch } from "./signal-attribution.js";

// The acquisition funnel writer. `signal_attribution_events` was a dead seam —
// north-snapshotter read it for CAC and nothing wrote to it, so every funnel
// metric answered zero. These tests pin the two write paths (public tracking
// and the axis.policy.issued consumer) and the last-touch bind credit.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

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

async function makeCtx(now = 1_700_000_000_000): Promise<Ctx> {
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

function issuedEvent(customerId: string, policyId = "pol_1"): Envelope {
  return {
    id: "evt_1",
    ts: ctx.now,
    tenant_id: ctx.tenantId,
    module: "axis",
    type: "axis.policy.issued",
    actor: "system:queue",
    subject: policyId,
    data: { policyId, customerId, premiumMinor: 120_000_00, currency: "AED" },
    v: 1
  };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

describe("recordTouch", () => {
  it("writes a tenant-scoped touch row", async () => {
    const id = await recordTouch(ctx, { touchType: "click", channel: "meta", campaignId: "cmp_1", anonId: "anon_9" });
    const [row] = await ctx.db.select().from(schema.signalAttributionEvents).where(eq(schema.signalAttributionEvents.id, id));
    expect(row?.tenantId).toBe("t_1");
    expect(row?.touchType).toBe("click");
    expect(row?.anonId).toBe("anon_9");
    expect(row?.customerId).toBeNull();
  });
});

describe("onBindIssued", () => {
  it("credits the bind to the customer's most recent attributed lead", async () => {
    await recordTouch(ctx, { touchType: "lead", channel: "google", campaignId: "cmp_old", customerId: "cus_1" });
    ctx = await makeCtx(ctx.now + 60_000);
    await recordTouch(ctx, { touchType: "lead", channel: "meta", campaignId: "cmp_new", customerId: "cus_1" });

    const bindId = await onBindIssued(ctx, issuedEvent("cus_1"));
    expect(bindId).not.toBeNull();

    const [bind] = await ctx.db
      .select()
      .from(schema.signalAttributionEvents)
      .where(eq(schema.signalAttributionEvents.id, bindId!));
    expect(bind?.touchType).toBe("bind");
    expect(bind?.campaignId).toBe("cmp_new");
    expect(bind?.channel).toBe("meta");
    expect(bind?.valueMinor).toBe(120_000_00);
    expect(bind?.subjectRef).toBe("pol_1");
  });

  it("returns null for a customer with no attributed lead — organic, no credit", async () => {
    expect(await onBindIssued(ctx, issuedEvent("cus_organic"))).toBeNull();
    const rows = await ctx.db.select().from(schema.signalAttributionEvents);
    expect(rows).toHaveLength(0);
  });

  it("carries the lead's ad click ids onto the bind, so the bind can be reported to that platform (SIG-032)", async () => {
    await recordTouch(ctx, { touchType: "lead", channel: "google_search", customerId: "cus_1", gclid: "G1", fbclid: "F1" });
    const bindId = await onBindIssued(ctx, issuedEvent("cus_1"));
    const [bind] = await ctx.db.select().from(schema.signalAttributionEvents).where(eq(schema.signalAttributionEvents.id, bindId!));
    expect([bind?.gclid, bind?.fbclid]).toEqual(["G1", "F1"]);
  });

  it("falls back to the newest click id the same visitor carried before they became a lead", async () => {
    await recordTouch(ctx, { touchType: "click", channel: "google_search", anonId: "anon_1", gclid: "G_old" });
    ctx = await makeCtx(ctx.now + 1_000);
    await recordTouch(ctx, { touchType: "visit", channel: "google_search", anonId: "anon_1", gclid: "G_new" });
    await recordTouch(ctx, { touchType: "click", channel: "google_search", anonId: "anon_other", gclid: "G_someone_else" });
    await recordTouch(ctx, { touchType: "lead", channel: "google_search", customerId: "cus_1", anonId: "anon_1" });
    const bindId = await onBindIssued(ctx, issuedEvent("cus_1"));
    const [bind] = await ctx.db.select().from(schema.signalAttributionEvents).where(eq(schema.signalAttributionEvents.id, bindId!));
    expect([bind?.gclid, bind?.fbclid]).toEqual(["G_new", null]);
  });

  it("is tenant-scoped: another tenant's lead is not credited", async () => {
    await recordTouch(ctx, { touchType: "lead", channel: "meta", campaignId: "cmp_1", customerId: "cus_1" });
    const other = { ...(await makeCtx()), tenantId: "t_2" };
    expect(await onBindIssued(other, issuedEvent("cus_1"))).toBeNull();
  });
});

describe("funnelByCampaign", () => {
  it("aggregates touches per campaign and channel", async () => {
    await recordTouch(ctx, { touchType: "impression", channel: "meta", campaignId: "cmp_1" });
    await recordTouch(ctx, { touchType: "impression", channel: "meta", campaignId: "cmp_1" });
    await recordTouch(ctx, { touchType: "click", channel: "meta", campaignId: "cmp_1" });
    await recordTouch(ctx, { touchType: "lead", channel: "meta", campaignId: "cmp_1", customerId: "cus_1" });
    await onBindIssued(ctx, issuedEvent("cus_1"));

    const funnel = await funnelByCampaign(ctx, ctx.now - 1000, ctx.now + 1000);
    expect(funnel).toHaveLength(1);
    expect(funnel[0]).toMatchObject({
      campaignId: "cmp_1",
      channel: "meta",
      impressions: 2,
      clicks: 1,
      leads: 1,
      binds: 1,
      valueMinor: 120_000_00
    });
  });

  it("excludes touches outside the window", async () => {
    await recordTouch(ctx, { touchType: "click", channel: "meta", campaignId: "cmp_1" });
    const funnel = await funnelByCampaign(ctx, ctx.now + 1000, ctx.now + 2000);
    expect(funnel).toHaveLength(0);
  });
});

// docs/17 SIG-057, ADR-0109: cost per acquisition as a range, method named.
describe("acquisitionCostRange", () => {
  let n = 0;
  async function spend(channel: string, amountMinor: number, currency = "AED", at = ctx.now): Promise<void> {
    await ctx.db.insert(schema.signalSpend).values({
      id: `spd_${++n}`,
      tenantId: ctx.tenantId,
      campaignId: `cmp_${n}`,
      channel,
      day: "2023-11-14",
      amountMinor,
      currency,
      ts: at
    });
  }
  /** A customer's journey: earlier touches on `path`, the bind credited last-touch. */
  async function journey(customerId: string, path: string[]): Promise<void> {
    for (const channel of path) {
      await recordTouch(ctx, { touchType: "lead", channel, campaignId: `cmp_${channel}`, customerId });
      ctx = await makeCtx(ctx.now + 1_000);
    }
    await onBindIssued(ctx, issuedEvent(customerId, `pol_${customerId}`));
  }

  it("prices the whole of SIGNAL with the exact Poisson interval and no credit envelope", async () => {
    await spend("meta", 60_000);
    await spend("google", 40_000);
    for (let i = 0; i < 10; i++) await journey(`cus_${i}`, [i % 2 ? "meta" : "google"]);

    const out = await acquisitionCostRange(ctx, { since: 0, until: ctx.now + 1 });
    expect(out.spendMinor).toBe(100_000);
    expect(out.binds).toBe(10);
    expect(out.channel).toBeNull();
    expect(out.range).toEqual(cacRange({ spendMinor: 100_000, conversions: 10 }));
    expect(out.range?.method).toBe("poisson_exact");
  });

  it("widens a channel's range to every model's credit: exclusive binds below, any-touch binds above", async () => {
    await spend("meta", 50_000);
    await spend("google", 50_000);
    await journey("cus_a", ["meta"]); // meta only: meta under every model
    await journey("cus_b", ["google", "meta"]); // last touch meta, first touch google
    await journey("cus_c", ["meta", "google"]); // last touch google, but meta touched it
    await journey("cus_d", ["google"]); // never touched meta

    const out = await acquisitionCostRange(ctx, { since: 0, until: ctx.now + 1, channel: "meta" });
    expect(out.spendMinor).toBe(50_000);
    expect(out.binds).toBe(2);
    expect(out.channel).toBe("meta");
    expect(out.range?.conversions).toEqual({ low: 1, point: 2, high: 3 });
    expect(out.range).toEqual(cacRange({ spendMinor: 50_000, conversions: 2, creditLow: 1, creditHigh: 3 }));
    expect(out.range?.method).toBe("poisson_exact_credit_envelope");
  });

  it("does not let a touch after the bind claim credit for it", async () => {
    await spend("meta", 10_000);
    await journey("cus_a", ["meta"]);
    ctx = await makeCtx(ctx.now + 1_000);
    await recordTouch(ctx, { touchType: "lead", channel: "google", campaignId: "cmp_g", customerId: "cus_a" });

    const meta = await acquisitionCostRange(ctx, { since: 0, until: ctx.now + 1, channel: "meta" });
    expect(meta.range?.conversions).toEqual({ low: 1, point: 1, high: 1 });
    const google = await acquisitionCostRange(ctx, { since: 0, until: ctx.now + 1, channel: "google" });
    expect(google.binds).toBe(0);
    expect(google.range).toBeNull();
  });

  it("answers no range for spend that bought nothing", async () => {
    await spend("meta", 10_000);
    const out = await acquisitionCostRange(ctx, { since: 0, until: ctx.now + 1 });
    expect(out).toMatchObject({ spendMinor: 10_000, binds: 0, range: null });
  });

  it("reads one currency when asked, and only this tenant's rows inside the window", async () => {
    await spend("meta", 10_000, "AED");
    await spend("meta", 99_000, "USD");
    await spend("meta", 77_000, "AED", ctx.now - 10_000_000);
    await journey("cus_a", ["meta"]);
    const other = { ...ctx, tenantId: "t_2" };
    await recordTouch(other, { touchType: "bind", channel: "meta", customerId: "cus_x" });

    const out = await acquisitionCostRange(ctx, { since: ctx.now - 5_000_000, until: ctx.now + 1, currency: "AED" });
    expect(out.spendMinor).toBe(10_000);
    expect(out.binds).toBe(1);
    expect(out.currency).toBe("AED");
  });

  describe("GET /attribution/range", () => {
    const get = async (permissions: string[], query = "") => {
      const a = new Hono<App>();
      a.onError(onError);
      a.use("*", async (c, next) => {
        c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
        await next();
      });
      a.route("/", signalRoutes);
      const res = await a.fetch(new Request(`http://api.test/attribution/range${query}`));
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    it("answers an attribution reader with the range and the method key, and refuses anyone else", async () => {
      await spend("meta", 100_000);
      for (let i = 0; i < 10; i++) await journey(`cus_${i}`, ["meta"]);

      expect((await get([])).status).toBe(403);
      const ok = await get(["signal:attribution:read"], `?since=0&until=${ctx.now + 1}&channel=meta&currency=AED`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ channel: "meta", currency: "AED", spendMinor: 100_000, binds: 10 });
      expect(ok.body.range).toMatchObject({
        low: 5_437,
        point: 10_000,
        high: 20_854,
        method: "poisson_exact",
        methodKey: "attribution.method.poisson_exact",
        confidence: 0.95
      });
    });

    it("defaults to the trailing 30 days and names no range when nothing bound", async () => {
      await spend("meta", 5_000, "AED", ctx.now - 31 * 86_400_000);
      const ok = await get(["signal:attribution:read"]);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ since: ctx.now - 30 * 86_400_000, until: ctx.now, channel: null, spendMinor: 0, binds: 0, range: null });
    });

    it("refuses a window that is not one", async () => {
      expect((await get(["signal:attribution:read"], "?since=abc")).status).toBe(400);
      expect((await get(["signal:attribution:read"], "?since=10&until=5")).status).toBe(400);
    });
  });
});

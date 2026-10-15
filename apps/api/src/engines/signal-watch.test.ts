import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { permissionsForRole, type Ctx } from "@lyra/core";
import {
  MIN_BASELINE_DAYS,
  WATCH_MIN_AMOUNT_MINOR,
  detectSilentSpend,
  detectSpendSpikes,
  detectTrackingBreaks,
  latestDay,
  median,
  runSpendWatch,
  type DailySpend
} from "./signal-watch.js";

// docs/modules/signal.md §2.3: "Anomaly guard: spend spike auto-pauses and
// alerts" / "tracking breakage auto-pauses and alerts". What existed answered a
// different question — it compared a *proposed budget move* to past moves and
// returned silently — so a runaway spend or a broken pixel kept running until a
// human happened to look. These pin both halves: the detectors, and the fact
// that firing one actually stops the campaign and says so.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-10-01T09:00:00Z");
const TENANT = "t_1";
const DAY = 86_400_000;

const day = (back: number) => new Date(NOW - back * DAY).toISOString().slice(0, 10);

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

const row = (over: Partial<DailySpend> = {}): DailySpend => ({
  campaignId: "cmp_1",
  channel: "meta",
  day: day(0),
  amountMinor: 10_000,
  impressions: 1000,
  clicks: 20,
  ...over
});

/** A steady history plus one day under test. */
const history = (amountMinor: number, days = 7, extra: Partial<DailySpend> = {}) =>
  Array.from({ length: days }, (_, i) => row({ day: day(i + 1), amountMinor, ...extra }));

describe("median", () => {
  it("handles odd, even and empty sets", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3); // rounds 2.5 up
    expect(median([])).toBe(0);
  });
});

describe("detectSpendSpikes", () => {
  it("flags a day several times its own trailing median, and says by how much", () => {
    const spikes = detectSpendSpikes([...history(10_000), row({ amountMinor: 45_000 })]);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ channel: "meta", amountMinor: 45_000, baselineMinor: 10_000, multiple: 4.5 });
  });

  it("leaves an ordinary variation alone", () => {
    expect(detectSpendSpikes([...history(10_000), row({ amountMinor: 25_000 })])).toEqual([]);
  });

  it("does not call a channel's first day a spike", () => {
    // Two days of history is not a baseline; it is a channel starting.
    const spikes = detectSpendSpikes([
      row({ day: day(1), amountMinor: 1000 }),
      row({ day: day(2), amountMinor: 1000 }),
      row({ amountMinor: 90_000 })
    ]);
    expect(spikes).toEqual([]);
    expect(MIN_BASELINE_DAYS).toBeGreaterThan(2);
  });

  it("skips a series that has never spent before", () => {
    // Zero baseline: Infinity× is not a multiple anybody can act on.
    expect(detectSpendSpikes([...history(0), row({ amountMinor: 500_000 })])).toEqual([]);
  });

  it("ignores amounts too small to stop a campaign over", () => {
    const tiny = WATCH_MIN_AMOUNT_MINOR - 1;
    expect(detectSpendSpikes([...history(tiny / 4), row({ amountMinor: tiny })])).toEqual([]);
  });

  it("baselines each campaign and channel on its own history", () => {
    // A big channel's history must not mask a small channel's spike, which is
    // exactly what one account-wide baseline would do.
    const rows = [
      ...history(500_000, 7, { channel: "google_search" }),
      ...history(2_000, 7, { channel: "display" }),
      row({ channel: "display", amountMinor: 40_000 })
    ];
    const spikes = detectSpendSpikes(rows);
    expect(spikes.map((s) => s.channel)).toEqual(["display"]);
  });

  it("is quiet on a tenant with no spend at all", () => {
    expect(detectSpendSpikes([])).toEqual([]);
    expect(latestDay([])).toBeNull();
  });
});

describe("detectTrackingBreaks", () => {
  it("flags spend that produced no delivery", () => {
    const breaks = detectTrackingBreaks([row({ amountMinor: 60_000, impressions: 0, clicks: 0 })]);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({ channel: "meta", impressions: 0, clicks: 0 });
  });

  it("does not flag a day that delivered", () => {
    expect(detectTrackingBreaks([row({ amountMinor: 60_000, impressions: 4000, clicks: 0 })])).toEqual([]);
  });

  it("ignores a cost too small to be a fault", () => {
    expect(detectTrackingBreaks([row({ amountMinor: 100, impressions: 0, clicks: 0 })])).toEqual([]);
  });
});

describe("detectSilentSpend", () => {
  it("flags money still leaving a campaign we believe is paused", () => {
    const silent = detectSilentSpend([row({ amountMinor: 30_000 })], new Map([["cmp_1", "paused"]]));
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ campaignId: "cmp_1", channel: "meta" });
  });

  it("leaves a live campaign alone, because it is supposed to spend", () => {
    expect(detectSilentSpend([row({ amountMinor: 30_000 })], new Map([["cmp_1", "live"]]))).toEqual([]);
  });

  it("only looks at the newest day, not at older spend", () => {
    // Yesterday's large charge is history; only a paused campaign still billing
    // *now* is a fault.
    const rows = [row({ day: day(3), amountMinor: 30_000 }), row({ day: day(0), amountMinor: 100 })];
    expect(detectSilentSpend(rows, new Map([["cmp_1", "paused"]]))).toEqual([]);
  });
});

/* ----------------------------------------------------------------- acting */

async function campaign(id: string, state: string) {
  await ctx.db.insert(schema.signalCampaigns).values({
    id,
    tenantId: TENANT,
    name: id,
    objective: "acq",
    channelsJson: JSON.stringify(["meta"]),
    budgetJson: JSON.stringify({ currency: "AED" }),
    state,
    autonomyLevel: "act",
    ownerRef: "user:1",
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function spend(campaignId: string | null, over: Partial<{ day: string; amountMinor: number; impressions: number; clicks: number; channel: string }> = {}) {
  const dayValue = over.day ?? dateAt(0)();
  await ctx.db.insert(schema.signalSpend).values({
    id: `spd_${campaignId}_${over.channel ?? "meta"}_${dayValue}`,
    tenantId: TENANT,
    campaignId,
    channel: over.channel ?? "meta",
    day: dayValue,
    amountMinor: over.amountMinor ?? 10_000,
    currency: "AED",
    impressions: over.impressions ?? 1000,
    clicks: over.clicks ?? 20,
    conversions: 0,
    source: "api",
    ts: NOW - 1000
  });
}

// The DB rows use YYYY-MM-DD like the detectors do.
const dateAt = (back: number) => () => day(back);

describe("runSpendWatch", () => {
  it("stops a campaign whose spend has run away, and says why", async () => {
    await campaign("cmp_spike", "live");
    for (let i = 1; i <= 5; i += 1) await spend("cmp_spike", { day: day(i), amountMinor: 10_000 });
    await spend("cmp_spike", { day: day(0), amountMinor: 80_000 });

    const result = await runSpendWatch(ctx);

    expect(result.spikes).toBe(1);
    expect(result.paused).toEqual([{ campaignId: "cmp_spike", kind: "spend_spike", channels: ["meta"] }]);
    const [row_] = await ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.id, "cmp_spike"));
    expect(row_!.state).toBe("paused");

    // The audit row is the record (it stores hashes, not payloads — a tamper
    // chain, not a data store), so the *why* is asserted on the announcement.
    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, TENANT), eq(schema.auditLog.action, "signal.campaign.paused_by_guard")));
    expect(audited).toHaveLength(1);
    expect(audited[0]!.subjectRef).toBe("signal_campaign:cmp_spike");

    const announced = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, TENANT), eq(schema.eventOutbox.type, "signal.anomaly.detected")));
    expect(announced).toHaveLength(1);
    expect(JSON.parse(announced[0]!.envelopeJson)).toMatchObject({
      data: { campaignId: "cmp_spike", kinds: ["spend_spike"], action: "paused" }
    });
  });

  it("stops a campaign whose tracking has broken", async () => {
    // The failure is the *absence* of delivery, which a detector reading only
    // spend would call a normal day.
    await campaign("cmp_break", "live");
    await spend("cmp_break", { day: day(0), amountMinor: 60_000, impressions: 0, clicks: 0 });

    const result = await runSpendWatch(ctx);
    expect(result.breaks).toBe(1);
    expect(result.paused[0]).toMatchObject({ campaignId: "cmp_break", kind: "tracking_break" });
  });

  it("carries every reason into one pause rather than writing twice", async () => {
    await campaign("cmp_both", "live");
    for (let i = 1; i <= 5; i += 1) await spend("cmp_both", { day: day(i), amountMinor: 10_000 });
    // A spike on one channel and a break on another, same campaign.
    await spend("cmp_both", { day: day(0), channel: "meta", amountMinor: 80_000 });
    await spend("cmp_both", { day: day(0), channel: "display", amountMinor: 60_000, impressions: 0, clicks: 0 });

    const result = await runSpendWatch(ctx);
    expect(result.paused).toHaveLength(1);
    expect(result.paused[0]!.channels.sort()).toEqual(["display", "meta"]);

    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "signal.campaign.paused_by_guard"));
    expect(audited).toHaveLength(1);
    const [announced] = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(eq(schema.eventOutbox.type, "signal.anomaly.detected"));
    expect((JSON.parse(announced!.envelopeJson) as { data: { kinds: string[] } }).data.kinds.sort()).toEqual([
      "spend_spike",
      "tracking_break"
    ]);
  });

  it("does not write again for a campaign it already stopped", async () => {
    await campaign("cmp_paused", "paused");
    for (let i = 1; i <= 5; i += 1) await spend("cmp_paused", { day: day(i), amountMinor: 10_000 });
    await spend("cmp_paused", { day: day(0), amountMinor: 80_000 });

    const result = await runSpendWatch(ctx);
    expect(result.paused).toEqual([]);
    expect(result.alreadyPaused).toBe(1);
    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "signal.campaign.paused_by_guard"));
    expect(audited).toHaveLength(0);
  });

  it("reports silent spend on a paused campaign without acting, because it is already stopped", async () => {
    await campaign("cmp_silent", "paused");
    await spend("cmp_silent", { day: day(0), amountMinor: 25_000 });

    const result = await runSpendWatch(ctx);
    expect(result.silent).toBe(1);
    expect(result.paused).toEqual([]);
    const audited = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "signal.anomaly.silent_spend"));
    expect(audited).toHaveLength(1);
  });

  it("does nothing at all on a tenant with no spend", async () => {
    await campaign("cmp_quiet", "live");
    const result = await runSpendWatch(ctx);
    expect(result).toEqual({ paused: [], spikes: 0, breaks: 0, silent: 0, alreadyPaused: 0 });
    const [row_] = await ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.id, "cmp_quiet"));
    expect(row_!.state).toBe("live");
  });

  it("never stops a campaign it has no authority over", async () => {
    // Named campaign ids, so a spend row pointing at another tenant's campaign
    // cannot pause it.
    await ctx.db.insert(schema.signalCampaigns).values({
      id: "cmp_other",
      tenantId: "t_2",
      name: "other",
      objective: "acq",
      channelsJson: JSON.stringify(["meta"]),
      budgetJson: "{}",
      state: "live",
      autonomyLevel: "act",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
    const result = await runSpendWatch(ctx);
    expect(result.paused).toEqual([]);
    const [other] = await ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.id, "cmp_other"));
    expect(other!.state).toBe("live");
  });
});

describe("the alert", () => {
  it("puts a notice in the inbox of whoever runs campaigns", async () => {
    // "Auto-pauses and alerts" is two halves; stopping the spend without telling
    // anybody is the half this platform already had too much of.
    await campaign("cmp_spike", "live");
    for (let i = 1; i <= 5; i += 1) await spend("cmp_spike", { day: day(i), amountMinor: 10_000 });
    await spend("cmp_spike", { day: day(0), amountMinor: 80_000 });

    const roleId = "rol_lead";
    await ctx.db.insert(schema.roles).values({
      id: roleId,
      tenantId: TENANT,
      key: "signal.lead",
      name: "Growth lead",
      permissionsJson: JSON.stringify(["signal:campaigns:update"]),
      createdAt: NOW
    });
    await ctx.db.insert(schema.users).values({
      id: "usr_lead",
      tenantId: TENANT,
      name: "Noor",
      email: "noor@test.example",
      locale: "en",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW
    });
    await ctx.db.insert(schema.userRoles).values({ id: "ur_1", tenantId: TENANT, userId: "usr_lead", roleId, createdAt: NOW });

    await runSpendWatch(ctx);

    const notes = await ctx.db.select().from(schema.notifications);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ userId: "usr_lead", kind: "alert", titleKey: "signal.anomaly.detected", subjectRef: "signal_campaign:cmp_spike" });
    // Rule 7: a key and its parameters, never a rendered sentence.
    expect(JSON.parse(notes[0]!.paramsJson!)).toMatchObject({ campaignId: "cmp_spike", kinds: ["spend_spike"] });
  });

  it("tells nobody when nobody holds the role, and still stops the campaign", async () => {
    await campaign("cmp_spike", "live");
    for (let i = 1; i <= 5; i += 1) await spend("cmp_spike", { day: day(i), amountMinor: 10_000 });
    await spend("cmp_spike", { day: day(0), amountMinor: 80_000 });

    const result = await runSpendWatch(ctx);
    expect(result.paused).toHaveLength(1);
    expect(await ctx.db.select().from(schema.notifications)).toEqual([]);
  });
});

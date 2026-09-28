import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { AUTOPILOT_LEVELS, compareHoldout, holdoutReadout } from "./signal-holdout.js";
import type { Ctx } from "./context.js";

// docs/17 SIG-046, docs/modules/signal.md §7 KPI "autopilot uplift vs
// frozen-budget holdout", ADR-0110. One reader behind SIGNAL's readout route
// and NORTH's `autopilot_uplift_bps`, so it lives where both may import it.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;
const SINCE = NOW - 30 * DAY_MS;
const UNTIL = NOW + 1;

let client: Client;
let ctx: Ctx;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) await client.execute(statement);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function campaign(opts: { id: string; autonomyLevel?: string; holdout?: boolean; tenantId?: string }) {
  await ctx.db.insert(schema.signalCampaigns).values({
    id: opts.id,
    tenantId: opts.tenantId ?? ctx.tenantId,
    name: opts.id,
    objective: "acq",
    channelsJson: "[]",
    budgetJson: "{}",
    state: "live",
    autonomyLevel: opts.autonomyLevel ?? "act",
    holdout: opts.holdout ?? false,
    ownerRef: "user:noor",
    createdAt: NOW,
    updatedAt: NOW
  });
}

let n = 0;
async function spendRow(campaignId: string | null, channel: string, amountMinor: number, ts = NOW, tenantId = ctx.tenantId) {
  await ctx.db.insert(schema.signalSpend).values({
    id: `spd_${n++}`,
    tenantId,
    campaignId,
    channel,
    day: `2023-11-${String(n).padStart(2, "0")}`,
    amountMinor,
    currency: "AED",
    ts
  });
}

async function bind(campaignId: string | null, ts: number, touchType = "bind", tenantId = ctx.tenantId) {
  await ctx.db.insert(schema.signalAttributionEvents).values({
    id: `atr_${n++}`,
    tenantId,
    touchType,
    channel: "web",
    campaignId,
    ts
  });
}

describe("AUTOPILOT_LEVELS", () => {
  it("is exactly the autonomy levels the budget autopilot acts on", () => {
    expect(AUTOPILOT_LEVELS).toEqual(["act", "act_with_approval"]);
  });
});

describe("compareHoldout", () => {
  it("reports uplift when the acted-on cohort beats the frozen-budget holdout", () => {
    const result = compareHoldout([{ amountMinor: 100_000, conversions: 20 }], [{ amountMinor: 100_000, conversions: 10 }]);
    expect(result).toEqual({ actedCacMinor: 5_000, holdoutCacMinor: 10_000, actedConversions: 20, holdoutConversions: 10, upliftBps: 5_000 });
  });

  it("reports negative uplift when the autopilot bought dearer than the holdout", () => {
    expect(compareHoldout([{ amountMinor: 150_000, conversions: 10 }], [{ amountMinor: 100_000, conversions: 10 }]).upliftBps).toBe(-5_000);
  });

  it("sums rows per side and states 0 when either side has no conversions", () => {
    const result = compareHoldout(
      [
        { amountMinor: 30_000, conversions: 0 },
        { amountMinor: 0, conversions: 3 }
      ],
      [{ amountMinor: 50_000, conversions: 0 }]
    );
    expect(result).toEqual({ actedCacMinor: 10_000, holdoutCacMinor: 0, actedConversions: 3, holdoutConversions: 0, upliftBps: 0 });
    expect(compareHoldout([], [{ amountMinor: 1, conversions: 1 }]).upliftBps).toBe(0);
  });
});

describe("holdoutReadout", () => {
  it("says so when no campaign is designated holdout", async () => {
    await campaign({ id: "cmp_acted" });
    await spendRow("cmp_acted", "google_search", 100_000);
    await bind("cmp_acted", NOW - DAY_MS);
    const r = await holdoutReadout(ctx, SINCE, UNTIL);
    expect(r).toMatchObject({ status: "no_holdout", since: SINCE, until: UNTIL, upliftBps: null });
    expect(r.holdout).toEqual({ campaigns: 0, spendMinor: 0, conversions: 0, cacMinor: null });
    expect(r.acted).toEqual({ campaigns: 1, spendMinor: 100_000, conversions: 1, cacMinor: 100_000 });
  });

  it("compares CAC of autopilot-acted spend against the frozen holdout over attributed binds", async () => {
    await campaign({ id: "cmp_acted" });
    await campaign({ id: "cmp_approval", autonomyLevel: "act_with_approval" });
    await campaign({ id: "cmp_frozen", holdout: true });
    // An autonomy level the autopilot never acts on is in neither cohort.
    await campaign({ id: "cmp_manual", autonomyLevel: "draft" });
    // Another tenant's campaign of the same id must not be read.
    await campaign({ id: "cmp_other", tenantId: "t_2", holdout: true });
    await spendRow("cmp_acted", "google_search", 60_000);
    await spendRow("cmp_approval", "meta", 40_000);
    await spendRow("cmp_frozen", "google_search", 100_000);
    await spendRow("cmp_manual", "google_search", 999_000);
    await spendRow(null, "google_search", 999_000); // unattributed spend belongs to neither
    await spendRow("cmp_frozen", "google_search", 999_000, UNTIL); // until is exclusive
    await spendRow("cmp_frozen", "meta", 999_000, SINCE - 1);
    await spendRow("cmp_frozen", "email", 999_000, NOW, "t_2");
    for (let i = 0; i < 20; i++) await bind("cmp_acted", NOW - DAY_MS - i);
    for (let i = 0; i < 10; i++) await bind("cmp_frozen", NOW - DAY_MS - i);
    await bind("cmp_frozen", SINCE); // since is inclusive
    await bind("cmp_manual", NOW - DAY_MS);
    await bind("cmp_frozen", SINCE - 1);
    await bind("cmp_frozen", UNTIL);
    await bind("cmp_frozen", NOW, "lead");
    await bind("cmp_frozen", NOW, "bind", "t_2");
    await bind(null, NOW);

    const r = await holdoutReadout(ctx, SINCE, UNTIL);
    expect(r.status).toBe("ok");
    expect(r.acted).toEqual({ campaigns: 2, spendMinor: 100_000, conversions: 20, cacMinor: 5_000 });
    expect(r.holdout).toEqual({ campaigns: 1, spendMinor: 100_000, conversions: 11, cacMinor: 9_091 });
    expect(r.upliftBps).toBe(4_500);
  });

  it("reports no uplift, not zero, when a side bought nothing", async () => {
    await campaign({ id: "cmp_acted" });
    await campaign({ id: "cmp_frozen", holdout: true });
    await spendRow("cmp_acted", "google_search", 60_000);
    await spendRow("cmp_frozen", "google_search", 100_000);
    await bind("cmp_acted", NOW - DAY_MS);
    const r = await holdoutReadout(ctx, SINCE, UNTIL);
    expect(r.status).toBe("no_conversions");
    expect(r.holdout.cacMinor).toBeNull();
    expect(r.upliftBps).toBeNull();

    await bind("cmp_frozen", NOW - DAY_MS);
    await ctx.db.delete(schema.signalAttributionEvents).where(eq(schema.signalAttributionEvents.campaignId, "cmp_acted"));
    expect((await holdoutReadout(ctx, SINCE, UNTIL)).status).toBe("no_conversions");
  });

  it("reports no uplift when a side bought acquisitions with no spend in the window — a zero CAC is not a win", async () => {
    await campaign({ id: "cmp_acted" });
    await campaign({ id: "cmp_frozen", holdout: true });
    await spendRow("cmp_frozen", "google_search", 100_000);
    await bind("cmp_acted", NOW - DAY_MS);
    await bind("cmp_frozen", NOW - DAY_MS);
    const r = await holdoutReadout(ctx, SINCE, UNTIL);
    expect(r.status).toBe("no_spend");
    expect(r.acted.cacMinor).toBeNull();
    expect(r.holdout.cacMinor).toBe(100_000);
    expect(r.upliftBps).toBeNull();

    // The same with the sides swapped.
    await ctx.db.delete(schema.signalSpend);
    await spendRow("cmp_acted", "google_search", 100_000);
    expect((await holdoutReadout(ctx, SINCE, UNTIL)).status).toBe("no_spend");
  });
});

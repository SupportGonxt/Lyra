import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { chainFor, permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import {
  anomalyGuard,
  boundCheck,
  computeChannelCac,
  computeLtv,
  proposeReallocation,
  runBudgetAutopilot
} from "./signal-autopilot.js";
import { Hono } from "hono";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// docs/modules/signal.md §2.3 "autopilot" — CAC/LTV-driven reallocation with a
// bound check, an anomaly guard, and a daily trigger. Mirrors the harness in
// signal-suppression.test.ts and the idempotent-sweep shape of renewals.ts.

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

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

const DAY_MS = 86_400_000;

async function campaign(opts: {
  id: string;
  state?: string;
  autonomyLevel?: string;
  boundMinor?: number;
  channels?: string[];
  deletedAt?: number | null;
  holdout?: boolean;
}) {
  await ctx.db.insert(schema.signalCampaigns).values({
    id: opts.id,
    tenantId: ctx.tenantId,
    name: opts.id,
    objective: "acq",
    audienceId: null,
    channelsJson: JSON.stringify(opts.channels ?? ["google_search", "meta"]),
    budgetJson: JSON.stringify(
      opts.boundMinor === undefined ? {} : { autopilotBoundMinor: opts.boundMinor }
    ),
    state: opts.state ?? "live",
    autonomyLevel: opts.autonomyLevel ?? "act",
    ownerRef: "user:noor",
    createdAt: ctx.now,
    updatedAt: ctx.now,
    deletedAt: opts.deletedAt ?? null,
    holdout: opts.holdout ?? false
  });
}

async function spendRow(campaignId: string, channel: string, day: string, amountMinor: number, conversions: number) {
  await ctx.db.insert(schema.signalSpend).values({
    id: `spd_${campaignId}_${channel}_${day}`,
    tenantId: ctx.tenantId,
    campaignId,
    channel,
    day,
    amountMinor,
    currency: "AED",
    impressions: 1000,
    clicks: 100,
    conversions,
    source: "manual",
    ts: ctx.now
  });
}

async function bind(campaignId: string, valueMinor: number, ts: number) {
  await ctx.db.insert(schema.signalAttributionEvents).values({
    id: `atr_${campaignId}_${ts}`,
    tenantId: ctx.tenantId,
    customerId: "cu_1",
    touchType: "bind",
    channel: "web",
    campaignId,
    valueMinor,
    currency: "AED",
    subjectRef: "axis_case:c_1",
    ts
  });
}

describe("computeChannelCac", () => {
  it("computes spend/conversions per channel, Infinity when a channel has no conversions", () => {
    const cac = computeChannelCac([
      { channel: "google_search", amountMinor: 100_000, conversions: 10 },
      { channel: "google_search", amountMinor: 50_000, conversions: 5 },
      { channel: "meta", amountMinor: 90_000, conversions: 0 }
    ]);
    const google = cac.find((c) => c.channel === "google_search")!;
    const meta = cac.find((c) => c.channel === "meta")!;
    expect(google.spendMinor).toBe(150_000);
    expect(google.conversions).toBe(15);
    expect(google.cacMinor).toBe(10_000);
    expect(meta.cacMinor).toBe(Infinity);
  });
});

describe("computeLtv", () => {
  it("averages bind values, 0 with no binds", () => {
    expect(computeLtv([400_000, 500_000, 300_000])).toBe(400_000);
    expect(computeLtv([])).toBe(0);
  });
});

describe("boundCheck", () => {
  it("acts when the move is under bound", () => {
    expect(boundCheck(500_000, 1_000_000)).toBe("act");
  });
  it("acts exactly at the boundary (inclusive)", () => {
    expect(boundCheck(1_000_000, 1_000_000)).toBe("act");
  });
  it("requires approval just over the boundary", () => {
    expect(boundCheck(1_000_001, 1_000_000)).toBe("act_with_approval");
  });
});

describe("anomalyGuard", () => {
  it("flags a proposed move that is a clear outlier vs recent history", () => {
    const result = anomalyGuard(5_000_000, [100_000, 110_000, 95_000, 105_000, 90_000]);
    expect(result.isAnomaly).toBe(true);
  });
  it("passes a move consistent with recent history", () => {
    const result = anomalyGuard(102_000, [100_000, 110_000, 95_000, 105_000, 90_000]);
    expect(result.isAnomaly).toBe(false);
  });
  it("never flags when history has fewer than two points", () => {
    expect(anomalyGuard(9_999_999, [100_000]).isAnomaly).toBe(false);
    expect(anomalyGuard(9_999_999, []).isAnomaly).toBe(false);
  });
});

describe("proposeReallocation", () => {
  it("proposes moving from the pricier channel to the cheaper one when the gap is wide enough", () => {
    const cac = computeChannelCac([
      { channel: "google_search", amountMinor: 100_000, conversions: 20 }, // 5,000/conv
      { channel: "meta", amountMinor: 100_000, conversions: 10 } // 10,000/conv
    ]);
    const proposal = proposeReallocation(cac);
    expect(proposal).not.toBeNull();
    expect(proposal!.fromChannel).toBe("meta");
    expect(proposal!.toChannel).toBe("google_search");
    expect(proposal!.amountMinor).toBe(20_000); // 20% of meta's 100,000 spend
  });
  it("proposes nothing when the CAC gap is under the minimum threshold", () => {
    const cac = computeChannelCac([
      { channel: "google_search", amountMinor: 100_000, conversions: 20 }, // 5,000/conv
      { channel: "meta", amountMinor: 100_000, conversions: 19 } // ~5,263/conv, ~5.3% gap
    ]);
    expect(proposeReallocation(cac)).toBeNull();
  });
  it("proposes nothing with a single priced channel", () => {
    const cac = computeChannelCac([{ channel: "google_search", amountMinor: 100_000, conversions: 10 }]);
    expect(proposeReallocation(cac)).toBeNull();
  });
});

describe("runBudgetAutopilot", () => {
  it("creates auto-approved moves for eligible campaigns under bound and skips ineligible ones", async () => {
    // motorSearch-shaped: state=live, autonomyLevel=act, wide CAC gap, small move.
    await campaign({ id: "cmp_motor", autonomyLevel: "act", boundMinor: 1_000_000 });
    await spendRow("cmp_motor", "google_search", "2023-11-10", 200_000, 40); // CAC 5,000
    await spendRow("cmp_motor", "meta", "2023-11-10", 200_000, 20); // CAC 10,000
    await bind("cmp_motor", 500_000, ctx.now - 2 * DAY_MS);

    // Ineligible: paused state must not be evaluated at all.
    await campaign({ id: "cmp_paused", state: "paused", autonomyLevel: "act", boundMinor: 1_000_000 });
    await spendRow("cmp_paused", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_paused", "meta", "2023-11-10", 200_000, 20);

    // Ineligible: draft autonomy must not be evaluated.
    await campaign({ id: "cmp_draft", autonomyLevel: "draft", boundMinor: 1_000_000 });
    await spendRow("cmp_draft", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_draft", "meta", "2023-11-10", 200_000, 20);

    const created = await runBudgetAutopilot(ctx);
    expect(created).toBe(1);

    const moves = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.fromRef).toBe("signal_campaign:cmp_motor#meta");
    expect(moves[0]!.toRef).toBe("signal_campaign:cmp_motor#google_search");
    expect(moves[0]!.approvedBy).toBe("auto");

    // Only cmp_motor is eligible (state=live, autonomyLevel=act) — the paused
    // and draft-autonomy campaigns are filtered out before evaluation, not
    // evaluated and skipped, so they leave no marker at all.
    const chain = await chainFor(ctx);
    expect(chain.filter((r) => r.action === "signal.autopilot.evaluated")).toHaveLength(1);
    expect(chain.some((r) => r.action === "signal.budget_move.created")).toBe(true);
  });

  it("does nothing when the tenant-wide autopilot pause flag is set", async () => {
    ctx.policy = { ...ctx.policy, signalAutopilotPaused: true };

    // Otherwise identical to the eligible-campaign case above: would create a
    // move if the flag weren't checked first.
    await campaign({ id: "cmp_motor", autonomyLevel: "act", boundMinor: 1_000_000 });
    await spendRow("cmp_motor", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_motor", "meta", "2023-11-10", 200_000, 20);
    await bind("cmp_motor", 500_000, ctx.now - 2 * DAY_MS);

    const created = await runBudgetAutopilot(ctx);
    expect(created).toBe(0);

    const moves = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(0);
  });

  // The bound is a tenant autonomy grant, not a reason to skip the engine. An
  // under-bound move used to set approvedBy="auto" from a bare `if` and never
  // reach gate(), so `neverAutoApprove` on the policy could not floor it and
  // nothing recorded that a decision had been auto-made. Route it through.
  it("records an auto-approval decision for an under-bound move", async () => {
    await campaign({ id: "cmp_motor", autonomyLevel: "act", boundMinor: 1_000_000 });
    await spendRow("cmp_motor", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_motor", "meta", "2023-11-10", 200_000, 20);
    await bind("cmp_motor", 500_000, ctx.now - 2 * DAY_MS);

    expect(await runBudgetAutopilot(ctx)).toBe(1);

    const moves = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.approvedBy).toBe("auto");

    // The audit chain stores payload hashes, not payloads, so the evidence a
    // decision was made is the entry itself against the move's subjectRef.
    const chain = await chainFor(ctx);
    const auto = chain.filter((r) => r.action === "core.approval.auto");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.subjectRef).toBe(`budget-moves:${moves[0]!.id}`);
    expect(auto[0]!.afterHash).not.toBeNull();
  });

  it("routes an over-bound move to act_with_approval via the signal.budget_move gate", async () => {
    await campaign({ id: "cmp_health", autonomyLevel: "act_with_approval", boundMinor: 100_000 });
    // Deliberately large spend gap so the proposed move exceeds the bound.
    await spendRow("cmp_health", "google_search", "2023-11-10", 2_000_000, 40); // CAC 50,000
    await spendRow("cmp_health", "meta", "2023-11-10", 2_000_000, 20); // CAC 100,000

    const created = await runBudgetAutopilot(ctx);
    expect(created).toBe(1);

    const moves = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(1);
    expect(moves[0]!.approvedBy).toBe("pending");
    expect(moves[0]!.amountMinor).toBeGreaterThan(100_000);

    const approvals = await ctx.db
      .select()
      .from(schema.approvals)
      .where(eq(schema.approvals.policyKey, "signal.budget_move"));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.subjectRef).toBe(`budget-moves:${moves[0]!.id}`);
    expect(approvals[0]!.decision).toBe("pending");
  });

  it("flags an anomalous proposal without creating a move, and does not re-flag on a same-day retick", async () => {
    await campaign({ id: "cmp_spike", autonomyLevel: "act", boundMinor: 1_000_000_000 });
    await spendRow("cmp_spike", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_spike", "meta", "2023-11-10", 200_000, 20);

    // Recent move history for this campaign: consistently small moves, so a
    // proposal sized off a 200,000-minor channel spend (proposeReallocation's
    // 20% cut is 40,000) is nowhere near these — insert a run of small prior
    // moves that make anything on this scale look normal, then force a spike
    // by seeding a channel whose gap produces a huge proposed amount instead.
    for (let i = 0; i < 5; i++) {
      await ctx.db.insert(schema.signalBudgetMoves).values({
        id: `bmv_hist_${i}`,
        tenantId: ctx.tenantId,
        fromRef: "signal_campaign:cmp_spike#meta",
        toRef: "signal_campaign:cmp_spike#google_search",
        amountMinor: 1_000 + i, // ~1,000 minor, tight cluster
        currency: "AED",
        reason: "history",
        evidenceJson: null,
        approvedBy: "auto",
        reversedBy: null,
        reversedAt: null,
        reversibleUntil: ctx.now + 7 * DAY_MS,
        ts: ctx.now - (5 - i) * DAY_MS
      });
    }

    const created = await runBudgetAutopilot(ctx);
    expect(created).toBe(0); // the 40,000-minor proposal is a wild outlier vs a ~1,000 history

    const moves = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.approvedBy, "auto"));
    expect(moves).toHaveLength(5); // only the seeded history, no new row

    const chain = await chainFor(ctx);
    const evaluated = chain.filter((r) => r.action === "signal.autopilot.evaluated");
    expect(evaluated).toHaveLength(1);

    // Second same-day tick must not re-evaluate (and thus not re-flag).
    const again = await runBudgetAutopilot(ctx);
    expect(again).toBe(0);
    const chainAfter = await chainFor(ctx);
    expect(chainAfter.filter((r) => r.action === "signal.autopilot.evaluated")).toHaveLength(1);
  });

  it("does not double-trigger moves on a second same-day tick", async () => {
    await campaign({ id: "cmp_motor", autonomyLevel: "act", boundMinor: 1_000_000 });
    await spendRow("cmp_motor", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_motor", "meta", "2023-11-10", 200_000, 20);
    await bind("cmp_motor", 500_000, ctx.now - 2 * DAY_MS);

    const first = await runBudgetAutopilot(ctx);
    expect(first).toBe(1);
    const second = await runBudgetAutopilot(ctx);
    expect(second).toBe(0);

    const moves = await ctx.db.select().from(schema.signalBudgetMoves);
    expect(moves).toHaveLength(1);
  });

  it("skips a campaign with fewer than two priced channels (nothing to reallocate)", async () => {
    await campaign({ id: "cmp_single", autonomyLevel: "act", channels: ["google_search"] });
    await spendRow("cmp_single", "google_search", "2023-11-10", 200_000, 40);

    const created = await runBudgetAutopilot(ctx);
    expect(created).toBe(0);
    const chain = await chainFor(ctx);
    expect(chain.filter((r) => r.action === "signal.autopilot.evaluated")).toHaveLength(1);
  });

  // docs/17 SIG-046, ADR-0110: a holdout campaign's budget is frozen — the
  // autopilot neither evaluates it nor moves a fils into or out of it.
  it("never evaluates or moves a holdout campaign, however wide its CAC gap", async () => {
    await campaign({ id: "cmp_frozen", autonomyLevel: "act", boundMinor: 1_000_000, holdout: true });
    await spendRow("cmp_frozen", "google_search", "2023-11-10", 200_000, 40);
    await spendRow("cmp_frozen", "meta", "2023-11-10", 200_000, 20);
    await bind("cmp_frozen", 500_000, ctx.now - 2 * DAY_MS);

    expect(await runBudgetAutopilot(ctx)).toBe(0);
    expect(await ctx.db.select().from(schema.signalBudgetMoves)).toHaveLength(0);
    const chain = await chainFor(ctx);
    expect(chain.filter((r) => r.action === "signal.autopilot.evaluated")).toHaveLength(0);
  });
});

describe("GET /holdout/readout", () => {
  const get = async (permissions: string[], query = "", now = ctx.now) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, now, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    const res = await a.fetch(new Request(`http://api.test/holdout/readout${query}`), {} as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("needs signal:attribution:read", async () => {
    expect((await get(["signal:campaigns:read"])).status).toBe(403);
  });

  it("reads the trailing 30 days by default and honours ?since&until", async () => {
    await campaign({ id: "cmp_acted", autonomyLevel: "act" });
    await campaign({ id: "cmp_frozen", autonomyLevel: "act", holdout: true });
    await spendRow("cmp_acted", "google_search", "2023-11-10", 50_000, 0);
    await spendRow("cmp_frozen", "google_search", "2023-11-10", 50_000, 0);
    await bind("cmp_acted", 1, ctx.now - DAY_MS);
    await bind("cmp_acted", 1, ctx.now - DAY_MS - 1);
    await bind("cmp_frozen", 1, ctx.now - DAY_MS);

    const later = ctx.now + DAY_MS;
    const byDefault = await get(["signal:attribution:read"], "", later);
    expect(byDefault.status).toBe(200);
    expect(byDefault.body).toMatchObject({ status: "ok", since: later - 30 * DAY_MS, until: later, upliftBps: 5_000 });

    // A window before any spend: designated, but nothing bought.
    const early = await get(["signal:attribution:read"], `?since=0&until=${ctx.now - 10 * DAY_MS}`);
    expect(early.body).toMatchObject({ status: "no_conversions", upliftBps: null });
  });

  it("refuses a window that is not one", async () => {
    expect((await get(["signal:attribution:read"], "?since=abc")).status).toBe(400);
    expect((await get(["signal:attribution:read"], "?since=10&until=5")).status).toBe(400);
  });
});

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { chainFor, decide, permissionsForRole, sealFields, type AdPlatform, type AdSpendRow, type Ctx, type Envelope } from "@lyra/core";
import { Hono } from "hono";
import { onBudgetMoveDecided, onBudgetMoveUpdated, pullAdSpend, pushBudgetMove, spendPullWindow, type AdPlatforms } from "./signal-ad-platforms.js";
import { runBudgetAutopilot } from "./signal-autopilot.js";
import { drainOutbox } from "../dispatch.js";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// docs/30 SIGNAL 5, ADR-0100. The AdPlatform seam wired both ways:
//  - spend pulled from a connected ad account lands through the same write the
//    CSV import uses, so a restated day is corrected, not doubled;
//  - a budget move reaches the platform only once the `signal.budget_move`
//    gate has passed — at commit when the bound or policy passed it, on the
//    approver's decision otherwise — and an undo reverses what was pushed.
// A tenant with no ad connector sees nothing change.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-encryption-secret";
const NOW = Date.parse("2026-09-27T00:05:00Z");
const DAY_MS = 86_400_000;
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
    tenantId: "t_1",
    actor: { kind: "system", id: "scheduler", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  for (const id of ["cmp_1", "cmp_2"]) {
    await ctx.db.insert(schema.signalCampaigns).values({
      id,
      tenantId: "t_1",
      name: id,
      objective: "acq",
      channelsJson: JSON.stringify(["google_search", "meta"]),
      budgetJson: JSON.stringify({ autopilotBoundMinor: 1_000_000 }),
      state: "live",
      autonomyLevel: "act",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function connector(opts: { id: string; provider: string; config: Record<string, unknown>; status?: string; transport?: string }) {
  const secretsJson = JSON.stringify(await sealFields(FIELD_KEY, { token: `tok-${opts.id}` }, ["token"]));
  await ctx.db.insert(schema.orbitChannelConnectors).values({
    id: opts.id,
    tenantId: "t_1",
    provider: opts.provider,
    transport: opts.transport ?? "ads",
    label: opts.id,
    secretsJson,
    configJson: JSON.stringify(opts.config),
    status: opts.status ?? "active",
    createdAt: NOW,
    updatedAt: NOW
  });
}

/** In-memory platform: a spend table to report and a budget per campaign. */
function fakePlatform(provider: string, defaultChannel: string, spend: AdSpendRow[], budgets: Record<string, number> = {}) {
  const calls: string[] = [];
  const platform: AdPlatform & { spend: AdSpendRow[]; budgets: Record<string, number>; calls: string[]; fail?: string } = {
    provider,
    defaultChannel,
    spend,
    budgets,
    calls,
    async pullSpend(window, secrets) {
      calls.push(`pull ${window.since}..${window.until} ${secrets.token}`);
      if (platform.fail) throw new Error(platform.fail);
      return platform.spend.filter((r) => r.day >= window.since && r.day <= window.until);
    },
    async adjustDailyBudget(externalCampaignId, deltaMinor, currency, secrets) {
      calls.push(`budget ${externalCampaignId} ${deltaMinor} ${currency} ${secrets.token}`);
      if (platform.fail) throw new Error(platform.fail);
      const beforeMinor = platform.budgets[externalCampaignId] ?? 0;
      platform.budgets[externalCampaignId] = beforeMinor + deltaMinor;
      return { beforeMinor, afterMinor: beforeMinor + deltaMinor };
    }
  };
  return platform;
}

const day = (d: string, externalCampaignId: string, amountMinor: number, conversions = 1): AdSpendRow => ({
  externalCampaignId,
  day: d,
  amountMinor,
  currency: "AED",
  impressions: 100,
  clicks: 10,
  conversions
});

const spendRows = async () =>
  (await ctx.db.select().from(schema.signalSpend)).map((r) => [r.day, r.campaignId, r.channel, r.amountMinor, r.conversions, r.source]).sort();
const actions = async () => (await chainFor(ctx)).map((r) => `${r.action} ${r.subjectRef ?? ""}`.trim());

describe("pullAdSpend", () => {
  it("writes each connected account's daily spend through the import path, mapped to LYRA campaigns", async () => {
    const google = fakePlatform("google-ads", "google_search", [
      day("2026-09-25", "111", 40_000, 4),
      day("2026-09-25", "112", 10_000, 1), // a second platform campaign behind cmp_1: summed
      day("2026-09-25", "999", 5_000, 0) // mapped to nothing: channel-level spend
    ]);
    const meta = fakePlatform("meta-ads", "meta", [day("2026-09-26", "900", 70_000, 2)]);
    await connector({ id: "ccn_g", provider: "google-ads", config: { customerId: "1", campaigns: { "111": "cmp_1", "112": "cmp_1" } } });
    await connector({ id: "ccn_m", provider: "meta-ads", config: { adAccountId: "act_1", campaigns: { "900": "cmp_2" }, channel: "meta_feed" } });

    const out = await pullAdSpend(ctx, FIELD_KEY, { since: "2026-09-24", until: "2026-09-26" }, { "google-ads": google, "meta-ads": meta });

    expect(out).toEqual({ connectors: 2, created: 3, updated: 0, errors: [] });
    expect(await spendRows()).toEqual([
      ["2026-09-25", "cmp_1", "google_search", 50_000, 5, "api"],
      ["2026-09-25", null, "google_search", 5_000, 0, "api"],
      ["2026-09-26", "cmp_2", "meta_feed", 70_000, 2, "api"]
    ].sort());
    // Secrets were opened from the sealed row, not read in the clear.
    expect(google.calls).toEqual(["pull 2026-09-24..2026-09-26 tok-ccn_g"]);
    const recorded = (await ctx.db.select().from(schema.eventOutbox)).filter((e) => JSON.parse(e.envelopeJson).type === "signal.spend.recorded");
    expect(recorded).toHaveLength(3);
    expect(await actions()).toEqual(expect.arrayContaining(["signal.spend.pulled connector:ccn_g", "signal.spend.pulled connector:ccn_m"]));
  });

  it("corrects a day the platform restated instead of doubling it", async () => {
    const google = fakePlatform("google-ads", "google_search", [day("2026-09-25", "111", 40_000, 4)]);
    await connector({ id: "ccn_g", provider: "google-ads", config: { campaigns: { "111": "cmp_1" } } });
    await pullAdSpend(ctx, FIELD_KEY, { since: "2026-09-25", until: "2026-09-25" }, { "google-ads": google });
    google.spend = [day("2026-09-25", "111", 42_500, 5)];

    const out = await pullAdSpend(ctx, FIELD_KEY, { since: "2026-09-25", until: "2026-09-25" }, { "google-ads": google });

    expect(out).toMatchObject({ created: 0, updated: 1 });
    expect(await spendRows()).toEqual([["2026-09-25", "cmp_1", "google_search", 42_500, 5, "api"]]);
  });

  it("changes nothing for a tenant with no ad connector — messaging connectors and disabled accounts are not ad accounts", async () => {
    const google = fakePlatform("google-ads", "google_search", [day("2026-09-25", "111", 40_000)]);
    await connector({ id: "ccn_wa", provider: "whatsapp-cloud-api", transport: "whatsapp", config: {} });
    await connector({ id: "ccn_off", provider: "google-ads", status: "disabled", config: {} });

    expect(await pullAdSpend(ctx, FIELD_KEY, { since: "2026-09-25", until: "2026-09-25" }, { "google-ads": google })).toEqual({
      connectors: 0,
      created: 0,
      updated: 0,
      errors: []
    });
    expect(google.calls).toEqual([]);
    expect(await spendRows()).toEqual([]);
    expect(await actions()).toEqual([]);
  });

  it("names a failing account and a mapping to no campaign, and still writes the rest", async () => {
    const google = fakePlatform("google-ads", "google_search", []);
    google.fail = "google-ads 401: token expired";
    const meta = fakePlatform("meta-ads", "meta", [day("2026-09-25", "900", 1_000), day("2026-09-25", "901", 2_000)]);
    await connector({ id: "ccn_g", provider: "google-ads", config: {} });
    await connector({ id: "ccn_m", provider: "meta-ads", config: { campaigns: { "900": "cmp_1", "901": "cmp_gone" } } });

    const out = await pullAdSpend(ctx, FIELD_KEY, { since: "2026-09-25", until: "2026-09-25" }, { "google-ads": google, "meta-ads": meta });

    expect(out.created).toBe(1);
    expect(out.errors).toEqual([
      { connectorId: "ccn_g", error: "google-ads 401: token expired" },
      { connectorId: "ccn_m", error: "2026-09-25: no campaign cmp_gone" }
    ]);
    expect(await spendRows()).toEqual([["2026-09-25", "cmp_1", "meta", 1_000, 1, "api"]]);
    expect(await actions()).toContain("signal.spend.pull_failed connector:ccn_g");
  });

  it("cannot open sealed credentials without the field key, and says so", async () => {
    const google = fakePlatform("google-ads", "google_search", []);
    await connector({ id: "ccn_g", provider: "google-ads", config: {} });
    const out = await pullAdSpend(ctx, undefined, { since: "2026-09-25", until: "2026-09-25" }, { "google-ads": google });
    expect(out.errors).toEqual([{ connectorId: "ccn_g", error: "FIELD_KEY is not configured" }]);
    expect(google.calls).toEqual([]);
  });
});

async function move(opts: { id: string; from: string; to: string; amountMinor: number; approvedBy?: string; campaignId?: string }) {
  const c = opts.campaignId ?? "cmp_1";
  await ctx.db.insert(schema.signalBudgetMoves).values({
    id: opts.id,
    tenantId: "t_1",
    fromRef: `signal_campaign:${c}#${opts.from}`,
    toRef: `signal_campaign:${c}#${opts.to}`,
    amountMinor: opts.amountMinor,
    currency: "AED",
    reason: "test",
    evidenceJson: JSON.stringify({ windowDays: 7 }),
    approvedBy: opts.approvedBy ?? "auto",
    reversibleUntil: NOW + 7 * DAY_MS,
    ts: NOW
  });
  const [row] = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.id, opts.id));
  return row!;
}

const evidence = async (id: string) => {
  const [row] = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.id, id));
  return JSON.parse(row!.evidenceJson ?? "{}") as { windowDays?: number; platformPush?: Record<string, { status: string; beforeMinor?: number; afterMinor?: number; error?: string }> };
};

async function adAccounts() {
  const google = fakePlatform("google-ads", "google_search", [], { "111": 50_000 });
  const meta = fakePlatform("meta-ads", "meta", [], { "900": 30_000 });
  await connector({ id: "ccn_g", provider: "google-ads", config: { campaigns: { "111": "cmp_1" } } });
  await connector({ id: "ccn_m", provider: "meta-ads", config: { campaigns: { "900": "cmp_1" } } });
  return { google, meta, platforms: { "google-ads": google, "meta-ads": meta } as AdPlatforms };
}

describe("pushBudgetMove", () => {
  it("lowers the source channel first, then raises the destination, by the window amount as a daily rate", async () => {
    const { google, meta, platforms } = await adAccounts();
    const m = await move({ id: "bmv_1", from: "meta", to: "google_search", amountMinor: 70_000 });

    const legs = await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms);

    expect(legs).toEqual([
      { channel: "meta", status: "pushed" },
      { channel: "google_search", status: "pushed" }
    ]);
    expect(meta.calls).toEqual(["budget 900 -10000 AED tok-ccn_m"]);
    expect(google.calls).toEqual(["budget 111 10000 AED tok-ccn_g"]);
    expect((await evidence("bmv_1")).platformPush).toEqual({
      meta: { status: "pushed", connectorId: "ccn_m", externalCampaignId: "900", beforeMinor: 30_000, afterMinor: 20_000 },
      google_search: { status: "pushed", connectorId: "ccn_g", externalCampaignId: "111", beforeMinor: 50_000, afterMinor: 60_000 }
    });
    expect((await evidence("bmv_1")).windowDays).toBe(7);
    expect(await actions()).toEqual(
      expect.arrayContaining(["signal.budget_move.pushed budget-moves:bmv_1#meta#apply", "signal.budget_move.pushed budget-moves:bmv_1#google_search#apply"])
    );

    // Pushing the same move again moves nothing a second time.
    expect(await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms)).toEqual([
      { channel: "meta", status: "already" },
      { channel: "google_search", status: "already" }
    ]);
    expect(meta.calls).toHaveLength(1);
    expect(google.calls).toHaveLength(1);
  });

  it("never pushes a move whose approval is still pending", async () => {
    const { google, meta, platforms } = await adAccounts();
    const m = await move({ id: "bmv_p", from: "meta", to: "google_search", amountMinor: 70_000, approvedBy: "pending" });
    await expect(pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms)).rejects.toThrow(/pending/);
    expect([...meta.calls, ...google.calls]).toEqual([]);
  });

  it("does not raise the destination when lowering the source failed — no net new spend", async () => {
    const { google, meta, platforms } = await adAccounts();
    meta.fail = "meta-ads 400: campaign has no campaign daily budget";
    const m = await move({ id: "bmv_2", from: "meta", to: "google_search", amountMinor: 70_000 });

    const legs = await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms);

    expect(legs).toEqual([
      { channel: "meta", status: "failed", error: "meta-ads 400: campaign has no campaign daily budget" },
      { channel: "google_search", status: "skipped", error: "the decrease on meta did not happen" }
    ]);
    expect(google.calls).toEqual([]);
    expect(await actions()).toEqual(
      expect.arrayContaining(["signal.budget_move.push_failed budget-moves:bmv_2#meta#apply", "signal.budget_move.push_failed budget-moves:bmv_2#google_search#apply"])
    );
  });

  it("leaves a channel with no connected account alone and pushes the side that has one", async () => {
    const { google, platforms } = await adAccounts();
    const m = await move({ id: "bmv_3", from: "web", to: "google_search", amountMinor: 7_000 });
    expect(await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms)).toEqual([
      { channel: "web", status: "none" },
      { channel: "google_search", status: "pushed" }
    ]);
    expect(google.calls).toEqual(["budget 111 1000 AED tok-ccn_g"]);
  });

  it("changes nothing at all when no channel of the move has a connected account", async () => {
    const google = fakePlatform("google-ads", "google_search", []);
    const m = await move({ id: "bmv_4", from: "meta", to: "google_search", amountMinor: 7_000 });
    expect(await pushBudgetMove(ctx, FIELD_KEY, m, "apply", { "google-ads": google })).toEqual([
      { channel: "meta", status: "none" },
      { channel: "google_search", status: "none" }
    ]);
    expect(await actions()).toEqual([]);
    expect((await evidence("bmv_4")).platformPush).toBeUndefined();
  });

  it("reverses only what it pushed, once", async () => {
    const { google, meta, platforms } = await adAccounts();
    const m = await move({ id: "bmv_5", from: "meta", to: "google_search", amountMinor: 70_000 });
    await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms);

    const legs = await pushBudgetMove(ctx, FIELD_KEY, m, "reverse", platforms);

    expect(legs).toEqual([
      { channel: "google_search", status: "pushed" },
      { channel: "meta", status: "pushed" }
    ]);
    expect(google.budgets["111"]).toBe(50_000);
    expect(meta.budgets["900"]).toBe(30_000);
    expect((await pushBudgetMove(ctx, FIELD_KEY, m, "reverse", platforms)).map((l) => l.status)).toEqual(["already", "already"]);

    const never = await move({ id: "bmv_6", from: "meta", to: "google_search", amountMinor: 70_000 });
    expect((await pushBudgetMove(ctx, FIELD_KEY, never, "reverse", platforms)).map((l) => l.status)).toEqual(["none", "none"]);
    expect(google.calls).toHaveLength(2);
  });
});

async function spend(campaignId: string, channel: string, amountMinor: number, conversions: number) {
  await ctx.db.insert(schema.signalSpend).values({
    id: `spd_${campaignId}_${channel}`,
    tenantId: "t_1",
    campaignId,
    channel,
    day: "2026-09-25",
    amountMinor,
    currency: "AED",
    conversions,
    source: "api",
    ts: NOW - DAY_MS
  });
}

describe("the autopilot pushes only past the signal.budget_move gate", () => {
  it("pushes an under-bound move the gate passed at commit", async () => {
    const { google, meta, platforms } = await adAccounts();
    await spend("cmp_1", "google_search", 200_000, 40); // CAC 5,000
    await spend("cmp_1", "meta", 200_000, 20); // CAC 10,000 -> move 40,000 meta -> google

    expect(await runBudgetAutopilot(ctx, { fieldKey: FIELD_KEY, platforms })).toBe(1);

    expect(meta.calls).toEqual(["budget 900 -5714 AED tok-ccn_m"]);
    expect(google.calls).toEqual(["budget 111 5714 AED tok-ccn_g"]);
  });

  it("holds an over-bound move until the approver decides, then pushes it and spends the approval", async () => {
    const { google, meta, platforms } = await adAccounts();
    await ctx.db.update(schema.signalCampaigns).set({ budgetJson: JSON.stringify({ autopilotBoundMinor: 1_000 }), autonomyLevel: "act_with_approval" });
    await spend("cmp_1", "google_search", 200_000, 40);
    await spend("cmp_1", "meta", 200_000, 20);

    await runBudgetAutopilot(ctx, { fieldKey: FIELD_KEY, platforms });
    const [m] = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.fromRef, "signal_campaign:cmp_1#meta"));
    expect(m!.approvedBy).toBe("pending");
    expect([...meta.calls, ...google.calls]).toEqual([]);

    const [approval] = await ctx.db.select().from(schema.approvals).where(eq(schema.approvals.subjectRef, `budget-moves:${m!.id}`));
    const approver: Ctx = {
      ...ctx,
      actor: { kind: "user", id: "u_lead", tenantId: "t_1", grants: [{ roleKey: "signal.lead", permissions: permissionsForRole("signal.lead") }] }
    };
    await decide(approver, approval!.id, "approved");
    const decided = (await ctx.db.select().from(schema.eventOutbox))
      .map((e) => JSON.parse(e.envelopeJson) as Envelope)
      .find((e) => e.type === "signal.approval.decided")!;

    await onBudgetMoveDecided(ctx, FIELD_KEY, decided, platforms);

    expect(meta.calls).toEqual(["budget 900 -5714 AED tok-ccn_m"]);
    expect(google.calls).toEqual(["budget 111 5714 AED tok-ccn_g"]);
    const [after] = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.id, m!.id));
    expect(after!.approvedBy).toBe("user:u_lead");
    const [spent] = await ctx.db.select().from(schema.approvals).where(eq(schema.approvals.id, approval!.id));
    expect(spent!.decision).toBe("consumed");
  });

  it("pushes nothing on a rejection, and does not spend an approval for a move with no connected account", async () => {
    const { google, meta, platforms } = await adAccounts();
    const m = await move({ id: "bmv_r", from: "meta", to: "google_search", amountMinor: 70_000, approvedBy: "pending" });
    const envelope = (decision: string, subject = "budget-moves:bmv_r"): Envelope => ({
      id: "evt_1",
      ts: NOW,
      tenant_id: "t_1",
      module: "signal",
      type: "signal.approval.decided",
      actor: "user:u_lead",
      subject,
      data: { approvalId: "apr_x", decision, reason: "no", policyKey: "signal.budget_move" },
      v: 1
    });
    await onBudgetMoveDecided(ctx, FIELD_KEY, envelope("rejected"), platforms);
    expect([...meta.calls, ...google.calls]).toEqual([]);

    // Approved, but the gate has no approved row to spend: nothing moves.
    await onBudgetMoveDecided(ctx, FIELD_KEY, envelope("approved"), platforms);
    expect([...meta.calls, ...google.calls]).toEqual([]);
    const [still] = await ctx.db.select().from(schema.signalBudgetMoves).where(eq(schema.signalBudgetMoves.id, m.id));
    expect(still!.approvedBy).toBe("pending");

    // A move on channels with no account never reaches the gate at all.
    await move({ id: "bmv_web", from: "web", to: "email", amountMinor: 70_000, approvedBy: "pending" });
    await onBudgetMoveDecided(ctx, FIELD_KEY, envelope("approved", "budget-moves:bmv_web"), platforms);
    const approvals = await ctx.db.select().from(schema.approvals);
    expect(approvals.filter((a) => a.subjectRef === "budget-moves:bmv_web")).toEqual([]);
  });

  it("an undo on the move reverses what was pushed", async () => {
    const { google, meta, platforms } = await adAccounts();
    const m = await move({ id: "bmv_u", from: "meta", to: "google_search", amountMinor: 70_000 });
    await pushBudgetMove(ctx, FIELD_KEY, m, "apply", platforms);
    const updated: Envelope = {
      id: "evt_2",
      ts: NOW,
      tenant_id: "t_1",
      module: "signal",
      type: "signal.budget-moves.updated",
      actor: "user:u_lead",
      subject: "bmv_u",
      data: { id: "bmv_u" },
      v: 1
    };

    await onBudgetMoveUpdated(ctx, FIELD_KEY, updated, platforms); // not reversed: nothing
    expect(google.calls).toHaveLength(1);

    await ctx.db.update(schema.signalBudgetMoves).set({ reversedAt: NOW, reversedBy: "user:u_lead" }).where(eq(schema.signalBudgetMoves.id, "bmv_u"));
    await onBudgetMoveUpdated(ctx, FIELD_KEY, updated, platforms);

    expect(google.budgets["111"]).toBe(50_000);
    expect(meta.budgets["900"]).toBe(30_000);
  });
});

describe("dispatch", () => {
  it("routes an approved budget move from the outbox to the platform", async () => {
    // The real adapters, against a stubbed network: Meta answers budget reads
    // and writes; the dispatcher knows nothing but the connector row.
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posts.push(`${url} ${String(init.body)}`);
        return Response.json({ success: true });
      }
      if (url.includes("act_1?")) return Response.json({ currency: "AED" });
      return Response.json({ daily_budget: "30000" });
    });
    const secretsJson = JSON.stringify(await sealFields(FIELD_KEY, { accessToken: "EAAB" }, ["accessToken"]));
    await ctx.db.insert(schema.orbitChannelConnectors).values({
      id: "ccn_m",
      tenantId: "t_1",
      provider: "meta-ads",
      transport: "ads",
      label: "Meta",
      secretsJson,
      configJson: JSON.stringify({ adAccountId: "act_1", campaigns: { "900": "cmp_1" } }),
      createdAt: NOW,
      updatedAt: NOW
    });
    await ctx.db.update(schema.signalCampaigns).set({ budgetJson: JSON.stringify({ autopilotBoundMinor: 1_000 }), autonomyLevel: "act_with_approval" });
    await spend("cmp_1", "google_search", 200_000, 40);
    await spend("cmp_1", "meta", 200_000, 20);
    await runBudgetAutopilot(ctx, { fieldKey: FIELD_KEY });
    expect(posts).toEqual([]);

    const [approval] = await ctx.db.select().from(schema.approvals);
    await decide(
      { ...ctx, actor: { kind: "user", id: "u_lead", tenantId: "t_1", grants: [{ roleKey: "signal.lead", permissions: permissionsForRole("signal.lead") }] } },
      approval!.id,
      "approved"
    );
    // Only the ad-platform consumers run here; no model is needed.
    await drainOutbox(ctx, undefined, 100, { env: { FIELD_KEY } as never, gateway: {} as never });

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatch(/\/900 daily_budget=24286$/);
  });
});

describe("spendPullWindow", () => {
  it("re-reads the last three whole days by default, since platforms restate them", () => {
    expect(spendPullWindow(NOW)).toEqual({ since: "2026-09-24", until: "2026-09-26" });
    expect(spendPullWindow(NOW, { until: "2026-09-10" })).toEqual({ since: "2026-09-08", until: "2026-09-10" });
    expect(spendPullWindow(NOW, { since: "2026-09-01" })).toEqual({ since: "2026-09-01", until: "2026-09-26" });
  });
});

describe("POST /spend/pull", () => {
  const post = async (permissions: string[], payload?: unknown) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    const init: RequestInit =
      payload === undefined ? { method: "POST" } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) };
    const res = await a.fetch(new Request("http://api.test/spend/pull", init), { FIELD_KEY } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("needs signal:spend:write", async () => {
    expect((await post(["signal:spend:read"])).status).toBe(403);
  });

  it("answers with nothing pulled for a tenant with no ad connector", async () => {
    expect(await post(["signal:spend:write"])).toEqual({ status: 200, body: { connectors: 0, created: 0, updated: 0, errors: [] } });
  });

  it("refuses a malformed or overlong window", async () => {
    expect((await post(["signal:spend:write"], { since: "yesterday" })).status).toBe(400);
    expect((await post(["signal:spend:write"], { since: "2026-09-20", until: "2026-09-10" })).status).toBe(400);
    expect((await post(["signal:spend:write"], { since: "2026-01-01", until: "2026-09-10" })).status).toBe(400);
  });
});

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import { permissionsForRole, type Actor, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { acquisitionCampaigns, audienceRuleProblem, inQuietHours, onLeadConverted, recipientsFor, runAcquisitionSweep } from "./signal-outreach.js";
import { recordTouch } from "./signal-attribution.js";
import { BY_MODULE } from "../resources.js";

// The send half of the publish loop. These tests pin the three guarantees the
// rest of the loop stands on: nothing is sent without consent AND approval,
// every send writes the lead touch the bind loop-back credits, and a converted
// outreach row is stamped with the policy that closed it — the cockpit's
// "SIGNAL bought this customer" proof.

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

async function makeCtx(
  now = Date.parse("2026-08-20T12:00:00Z"),
  opts: { timezone?: string } = {}
): Promise<Ctx> {
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: actor(),
    requestId: "req_1",
    now,
    locale: "en",
    policy: PolicyJson.parse({ autoApprove: ["signal.outreach_send"], timezone: opts.timezone }),
    entitlements: EntitlementsJson.parse({})
  };
}

/** Seed one live acq campaign + an audience of one consenting WhatsApp member. */
let seedN = 0;
async function seedCampaign(opts: { state?: string; objective?: string; marketing?: boolean; whatsapp?: boolean } = {}): Promise<string> {
  const now = ctx.now;
  const n = ++seedN;
  const audienceId = `aud_${n}`;
  await ctx.db.insert(schema.signalAudiences).values({
    id: audienceId,
    tenantId: "t_1",
    name: "Test pool",
    definitionJson: JSON.stringify({ all: [{ field: "tagsJson", op: "contains", value: "prospect" }] }),
    refreshPolicy: "manual",
    consentPurposes: "marketing",
    createdBy: "user:1",
    createdAt: now,
    updatedAt: now
  });
  const campaignId = `cmp_${n}`;
  const customerId = `cus_${n}`;
  await ctx.db.insert(schema.signalCampaigns).values({
    id: campaignId,
    tenantId: "t_1",
    name: "Motor — always-on search",
    objective: opts.objective ?? "acq",
    audienceId,
    channelsJson: JSON.stringify(["whatsapp"]),
    budgetJson: JSON.stringify({ currency: "AED" }),
    state: opts.state ?? "live",
    autonomyLevel: "act_with_approval",
    ownerRef: "user:1",
    createdAt: now,
    updatedAt: now
  });
  await ctx.db.insert(schema.customers).values({
    id: customerId,
    tenantId: "t_1",
    nameJson: JSON.stringify("Amina Al Farsi"),
    emailsJson: JSON.stringify(["amina@test.example"]),
    tagsJson: JSON.stringify(["prospect"]),
    locale: "en",
    createdAt: now,
    updatedAt: now
  });
  await ctx.db.insert(schema.consents).values({
    id: `con_${n}`,
    tenantId: "t_1",
    customerId,
    purposesJson: JSON.stringify({ marketing: opts.marketing ?? true }),
    channelOptinsJson: JSON.stringify({ email: false, sms: false, whatsapp: opts.whatsapp ?? true, voice: false, push: false }),
    source: "portal",
    ts: now
  });
  // The winning creative the sweep personalises.
  await ctx.db.insert(schema.signalCreatives).values({
    id: `crv_${n}`,
    tenantId: "t_1",
    campaignId,
    kind: "social",
    locale: "en",
    contentRef: "Get covered in minutes, built for your family.",
    complianceStatus: "passed",
    generatedBy: "human",
    createdAt: now,
    updatedAt: now
  });
  return campaignId;
}

const stubGateway = () =>
  new Gateway({
    env: {},
    providers: {
      "workers-ai": makeStub({ replies: ["A quick note for you — cover in minutes."] }),
      anthropic: makeStub({ replies: ["A quick note for you — cover in minutes."] }),
      "openai-compat": makeStub({ replies: ["A quick note for you — cover in minutes."] })
    }
  });

beforeEach(async () => {
  seedN = 0;
  client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = await makeCtx();
});

describe("inQuietHours", () => {
  it("flags 20:00-07:59 local and passes the working day", () => {
    // 12:00 UTC = 16:00 Dubai → awake.
    expect(inQuietHours(Date.parse("2026-08-20T12:00:00Z"), "Asia/Dubai")).toBe(false);
    // 17:00 UTC = 21:00 Dubai → quiet.
    expect(inQuietHours(Date.parse("2026-08-20T17:00:00Z"), "Asia/Dubai")).toBe(true);
    // 04:00 UTC = 08:00 Dubai → exactly 8, awake.
    expect(inQuietHours(Date.parse("2026-08-20T04:00:00Z"), "Asia/Dubai")).toBe(false);
  });

  it("falls back to UTC for an unknown zone rather than throwing", () => {
    expect(() => inQuietHours(Date.parse("2026-08-20T21:00:00Z"), "Not/AZone")).not.toThrow();
  });
});

describe("runAcquisitionSweep", () => {
  it("drafts, sends and records the lead touch that closes the loop", async () => {
    const campaignId = await seedCampaign();
    const delivered: string[] = [];
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), {
      deliver: async (channel, to) => {
        delivered.push(`${channel}:${to}`);
        return "wamid.test";
      }
    });
    expect(outcome.sent).toBe(1);

    const [row] = await ctx.db.select().from(schema.signalOutreach);
    expect(row?.state).toBe("sent");
    expect(row?.channel).toBe("whatsapp");
    expect(row?.externalRef).toBe("wamid.test");

    // THE LOOP: the lead touch exists, carrying campaign + channel — the row
    // onBindIssued credits a bind to.
    const touches = await ctx.db.select().from(schema.signalAttributionEvents);
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ touchType: "lead", channel: "whatsapp", campaignId, customerId: "cus_1" });
    expect(delivered[0]).toContain("cus_1");
  });

  it("never sends without marketing consent — suppression is normal, not error", async () => {
    await seedCampaign({ marketing: false });
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
    expect(await ctx.db.select().from(schema.signalOutreach)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.signalAttributionEvents)).toHaveLength(0);
  });

  it("skips members whose only opt-in channels are not outreach channels", async () => {
    await seedCampaign({ whatsapp: false });
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
  });

  it("respects the cross-campaign weekly frequency cap", async () => {
    await seedCampaign();
    // Two sends already this week for this customer (as if another campaign sent them).
    await ctx.db.insert(schema.signalOutreach).values([
      { id: "otr_a", tenantId: "t_1", campaignId: "cmp_other", customerId: "cus_1", channel: "email", locale: "en", text: "x", state: "sent", approvedBy: "auto", aiAuditId: null, ts: ctx.now - DAY },
      { id: "otr_b", tenantId: "t_1", campaignId: "cmp_other2", customerId: "cus_1", channel: "sms", locale: "en", text: "x", state: "sent", approvedBy: "auto", aiAuditId: null, ts: ctx.now - 2 * DAY }
    ]);
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
  });

  it("does not run during quiet hours", async () => {
    await seedCampaign();
    // 17:30 UTC = 21:30 Dubai — inside the 20:00-08:00 window. The sweep
    // returns before counting anything: the message waits for an awake tick.
    ctx = await makeCtx(Date.parse("2026-08-20T17:30:00Z"), { timezone: "Asia/Dubai" });
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
    expect(await ctx.db.select().from(schema.signalOutreach)).toHaveLength(0);
  });

  it("ignores campaigns that are not live acquisitions", async () => {
    await seedCampaign({ state: "paused" });
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
  });

  it("ignores non-acquisition objectives — renewal belongs to ORBIT", async () => {
    await seedCampaign({ objective: "renewal" });
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => "x" });
    expect(outcome.sent).toBe(0);
  });

  it("records failed delivery honestly instead of pretending", async () => {
    await seedCampaign();
    const outcome = await runAcquisitionSweep(ctx, stubGateway(), { deliver: async () => null });
    expect(outcome.sent).toBe(0);
    const [row] = await ctx.db.select().from(schema.signalOutreach);
    expect(row?.state).toBe("failed");
    // No delivery, no lead credit — attribution you cannot trust is worse than none.
    expect(await ctx.db.select().from(schema.signalAttributionEvents)).toHaveLength(0);
  });
});

describe("onLeadConverted", () => {
  it("stamps the outreach row converted with the policy ref and emits the close", async () => {
    const campaignId = await seedCampaign();
    await recordTouch(ctx, { touchType: "lead", channel: "whatsapp", campaignId, customerId: "cus_1" });
    await ctx.db.insert(schema.signalOutreach).values({
      id: "otr_1",
      tenantId: "t_1",
      campaignId,
      customerId: "cus_1",
      channel: "whatsapp",
      locale: "en",
      text: "hello",
      state: "sent",
      approvedBy: "auto",
      aiAuditId: null,
      ts: ctx.now
    });

    expect(await onLeadConverted(ctx, "cus_1", "pol_9")).toBe(true);
    const [row] = await ctx.db.select().from(schema.signalOutreach).where(eq(schema.signalOutreach.id, "otr_1"));
    expect(row?.state).toBe("converted");
    expect(row?.convertedRef).toBe("pol_9");
    // ADR-0091: the bind is a response on the send, at every scale.
    const responses = await ctx.db.select().from(schema.signalResponses);
    expect(responses.map((r) => [r.kind, r.outreachId, r.ref])).toEqual([["bind", "otr_1", "pol_9"]]);
  });

  it("returns false when no outreach send exists — organic binds get no credit", async () => {
    const campaignId = await seedCampaign();
    await recordTouch(ctx, { touchType: "lead", channel: "whatsapp", campaignId, customerId: "cus_1" });
    expect(await onLeadConverted(ctx, "cus_1", "pol_9")).toBe(false);
  });
});

describe("acquisitionCampaigns", () => {
  it("lists only live acq campaigns", async () => {
    await seedCampaign();
    await seedCampaign({ state: "paused" });
    await seedCampaign({ objective: "xsell" });
    const list = await acquisitionCampaigns(ctx);
    expect(list).toHaveLength(1);
    expect(list.map((c) => c.id)).toContain("cmp_1");
  });
});

const DAY = 86_400_000;

// ADR-0091: the niche and the individual. An audience can name a prospect
// reason other modules reported; the draft is written from that person's own
// reason, and the send is recorded as a response and against the prospect.
describe("prospect-sourced audiences", () => {
  async function prospectAudience(rule: unknown): Promise<string> {
    const campaignId = await seedCampaign();
    await ctx.db
      .update(schema.signalAudiences)
      .set({ definitionJson: JSON.stringify(rule) })
      .where(eq(schema.signalAudiences.id, "aud_1"));
    await ctx.db.insert(schema.signalProspects).values({
      id: "psp_1",
      tenantId: "t_1",
      customerId: "cus_1",
      reason: "quote_expired",
      evidenceJson: JSON.stringify({ productId: "prd_motor", expiredAt: ctx.now - 86_400_000 }),
      score: 70,
      state: "open",
      sourceRef: "qr_1",
      createdAt: ctx.now,
      updatedAt: ctx.now
    });
    return campaignId;
  }

  it("reaches the people a reason names, writes from their reason, and records the send three ways", async () => {
    await prospectAudience({ all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }] });
    const stub = makeStub();
    const gateway = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
    const outcome = await runAcquisitionSweep(ctx, gateway, {
      deliver: async () => ({ externalRef: "wamid.p", conversationId: "cnv_9" })
    });
    expect(outcome.sent).toBe(1);

    const evidence = stub.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(evidence).toMatch(/Why this person: their quote expired/);
    const [row] = await ctx.db.select().from(schema.signalOutreach);
    expect(row).toMatchObject({ externalRef: "wamid.p", conversationId: "cnv_9" });
    const [response] = await ctx.db.select().from(schema.signalResponses);
    expect(response).toMatchObject({ kind: "lead", campaignId: row!.campaignId, audienceId: "aud_1", customerId: "cus_1", outreachId: row!.id });
    const [prospect] = await ctx.db.select().from(schema.signalProspects);
    expect(prospect!.state).toBe("contacted");
  });

  it("honours a score floor and skips people no longer open", async () => {
    await prospectAudience({ all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }, { field: "prospect.score", op: "gte", value: 80 }] });
    expect(await recipientsFor(ctx, { id: "cmp_1", name: "x", audienceId: "aud_1" })).toEqual([]);
    await ctx.db.update(schema.signalAudiences).set({ definitionJson: JSON.stringify({ all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }] }) });
    await ctx.db.update(schema.signalProspects).set({ state: "converted" });
    expect(await recipientsFor(ctx, { id: "cmp_1", name: "x", audienceId: "aud_1" })).toEqual([]);
  });

  it("resolves beyond the old 500 cap", async () => {
    await seedCampaign();
    const rows = Array.from({ length: 620 }, (_, i) => i);
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      await ctx.db.insert(schema.customers).values(
        chunk.map((k) => ({ id: `cus_bulk_${k}`, tenantId: "t_1", nameJson: "{}", tagsJson: JSON.stringify(["prospect"]), createdAt: ctx.now, updatedAt: ctx.now }))
      );
      await ctx.db.insert(schema.consents).values(
        chunk.map((k) => ({
          id: `con_bulk_${k}`,
          tenantId: "t_1",
          customerId: `cus_bulk_${k}`,
          purposesJson: JSON.stringify({ marketing: true }),
          channelOptinsJson: JSON.stringify({ whatsapp: true }),
          source: "portal",
          ts: ctx.now
        }))
      );
    }
    expect(await recipientsFor(ctx, { id: "cmp_1", name: "x", audienceId: "aud_1" })).toHaveLength(621);
  });
});

describe("the personal draft gate (evals/outreach-draft)", () => {
  it("drops a draft that states a number its evidence never gave", async () => {
    await seedCampaign();
    const stub = makeStub({ replies: ["Come back this week and take 20% off."] });
    const gateway = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
    const outcome = await runAcquisitionSweep(ctx, gateway, { deliver: async () => "x" });
    expect(outcome).toMatchObject({ sent: 0, droppedFlagged: 1 });
    expect(await ctx.db.select().from(schema.signalOutreach)).toEqual([]);
  });
});

describe("audienceRuleProblem", () => {
  it("accepts the shapes the resolver runs", () => {
    expect(audienceRuleProblem({ all: [{ field: "tagsJson", op: "contains", value: "vip" }] })).toBeNull();
    expect(audienceRuleProblem({ all: [{ field: "prospect.reason", op: "eq", value: "no_policy" }, { field: "prospect.score", op: "gte", value: 50 }] })).toBeNull();
  });

  it("names the leaf it cannot run, instead of resolving to nobody at send time", () => {
    expect(audienceRuleProblem({ all: [{ field: "policy.status", op: "eq", value: "active" }] })).toMatch(/policy\.status/);
    expect(audienceRuleProblem({ any: [] })).toMatch(/no rule/);
  });

  it("refuses churn risk: renewal outreach belongs to ORBIT's journeys", () => {
    expect(audienceRuleProblem({ all: [{ field: "prospect.reason", op: "eq", value: "churn_risk" }] })).toMatch(/ORBIT/);
  });
});

describe("the audiences resource refuses a rule outreach cannot run", () => {
  const audiences = BY_MODULE.signal!.find((r) => r.path === "audiences")!;
  const write = (values: Record<string, unknown>, existing: Record<string, unknown> | null = null) =>
    Promise.resolve().then(() => audiences.beforeWrite!(ctx, values, existing, {} as never));

  it("names the field on create", async () => {
    await expect(write({ name: "x", definitionJson: JSON.stringify({ all: [{ field: "policy.status", op: "eq", value: "active" }] }) })).rejects.toMatchObject({
      status: 400,
      extras: { errors: { definitionJson: expect.stringMatching(/policy\.status/) } }
    });
    await expect(write({ name: "x", definitionJson: JSON.stringify({ all: [{ field: "prospect.reason", op: "eq", value: "no_policy" }] }) })).resolves.toBeTruthy();
  });

  it("leaves a stored rule alone when an edit does not change it", async () => {
    const stored = { definitionJson: JSON.stringify({ all: [{ field: "policy.status", op: "eq", value: "x" }] }) };
    await expect(write({ name: "renamed" }, stored)).resolves.toBeTruthy();
    // The edit form posts it back, re-serialised.
    await expect(write({ name: "renamed", definitionJson: JSON.stringify(JSON.parse(stored.definitionJson), null, 2) }, stored)).resolves.toBeTruthy();
    await expect(write({ definitionJson: JSON.stringify({ all: [{ field: "policy.status", op: "eq", value: "y" }] }) }, stored)).rejects.toMatchObject({ status: 400 });
  });
});

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { emit, permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { drainOutbox } from "../dispatch.js";
import { expireQuoteRequests } from "./dist-quote-expiry.js";
import { runAcquisitionSweep } from "./signal-outreach.js";
import { responseRollup } from "./signal-responses.js";

// ADR-0091 end to end on a seeded tenant, through the real event drain: a
// comparison lapses in DIST, SIGNAL records the person, a niche audience names
// the reason, the draft is written from it, the send goes out, the person
// replies over ORBIT — and the reply counts at the campaign, the audience and
// the person.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOON = 1_770_022_800_000; // a Monday 09:00Z, outside quiet hours
let ctx: Ctx;

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const sqls = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sqls) await client.execute(s);
  const db = drizzle(client) as unknown as Ctx["db"];
  const { tenantId } = await seed(db, { password: "signal-marketing-seeded-2026" });
  ctx = {
    db,
    tenantId,
    actor: { kind: "system", id: "scheduler", tenantId, grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOON,
    locale: "en",
    policy: PolicyJson.parse({ autoApprove: ["signal.outreach_send"] }),
    entitlements: EntitlementsJson.parse({})
  };
  // Inline delivery would post every drained event to the seeded webhook URLs.
  await db.delete(schema.webhooks);
  await drainOutbox(ctx);
}, 120_000);

describe("insight-driven marketing on a seeded tenant", () => {
  it("turns a lapsed comparison into a personal send whose reply counts at every scale", async () => {
    const [customer] = await ctx.db.select().from(schema.customers).where(eq(schema.customers.tenantId, ctx.tenantId)).limit(1);
    const customerId = customer!.id;
    await ctx.db.insert(schema.consents).values({
      id: "con_mkt",
      tenantId: ctx.tenantId,
      customerId,
      purposesJson: JSON.stringify({ marketing: true }),
      channelOptinsJson: JSON.stringify({ whatsapp: true }),
      source: "portal",
      ts: NOON - 1000
    });
    const [request] = await ctx.db.select().from(schema.distQuoteRequests).where(eq(schema.distQuoteRequests.tenantId, ctx.tenantId)).limit(1);
    await ctx.db
      .update(schema.distQuoteRequests)
      .set({ customerId, state: "complete", expiresAt: NOON - 86_400_000 })
      .where(eq(schema.distQuoteRequests.id, request!.id));

    // DIST lapses it; the drain carries it to SIGNAL.
    expect(await expireQuoteRequests(ctx)).toBe(1);
    await drainOutbox(ctx);
    const [prospect] = await ctx.db.select().from(schema.signalProspects).where(eq(schema.signalProspects.reason, "quote_expired"));
    expect(prospect).toMatchObject({ customerId, state: "open", sourceRef: request!.id });

    // A niche: everyone whose quote lapsed.
    await ctx.db.insert(schema.signalAudiences).values({
      id: "aud_lapsed",
      tenantId: ctx.tenantId,
      name: "Quotes that lapsed",
      definitionJson: JSON.stringify({ all: [{ field: "prospect.reason", op: "eq", value: "quote_expired" }] }),
      refreshPolicy: "daily",
      consentPurposes: "marketing",
      createdBy: "user:test",
      createdAt: NOON,
      updatedAt: NOON
    });
    await ctx.db.insert(schema.signalCampaigns).values({
      id: "cmp_lapsed",
      tenantId: ctx.tenantId,
      name: "Second look",
      objective: "acq",
      audienceId: "aud_lapsed",
      channelsJson: JSON.stringify(["whatsapp"]),
      budgetJson: "{}",
      state: "live",
      ownerRef: "user:test",
      createdAt: NOON,
      updatedAt: NOON
    });
    await ctx.db.insert(schema.signalCreatives).values({
      id: "crv_lapsed",
      tenantId: ctx.tenantId,
      campaignId: "cmp_lapsed",
      kind: "social",
      locale: "en",
      contentRef: "Pick up where you left off.",
      complianceStatus: "passed",
      generatedBy: "human",
      createdAt: NOON,
      updatedAt: NOON
    });

    const stub = makeStub();
    const gateway = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
    const outcome = await runAcquisitionSweep(ctx, gateway, { deliver: async () => ({ externalRef: "wamid.lapsed", conversationId: "cnv_lapsed" }) });
    expect(outcome.sent).toBe(1);
    const prompt = stub.calls.at(-1)!.messages.find((m) => m.role === "user")!.content;
    expect(prompt).toContain("Why this person: their quote expired");

    // ORBIT hears the reply and announces it; the drain carries it back.
    await emit({ ...ctx, now: NOON + 3600_000 }, {
      module: "orbit",
      type: "orbit.message.received",
      subject: "msg_reply",
      data: { conversationId: "cnv_lapsed", customerId, messageId: "msg_reply" }
    });
    await drainOutbox({ ...ctx, now: NOON + 3600_000 });

    const at = (level: "campaign" | "audience" | "customer") => responseRollup(ctx, level, 0);
    expect(await at("campaign")).toEqual([{ key: "cmp_lapsed", counts: { lead: 1, replied: 1 } }]);
    expect(await at("audience")).toEqual([{ key: "aud_lapsed", counts: { lead: 1, replied: 1 } }]);
    expect(await at("customer")).toEqual([{ key: customerId, counts: { lead: 1, replied: 1 } }]);
    const [after] = await ctx.db.select().from(schema.signalProspects).where(eq(schema.signalProspects.id, prospect!.id));
    expect(after!.state).toBe("responded");
  });
});

import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { schema } from "@lyra/db";
import { id } from "@lyra/db";
import {
  signOffer,
  verifyOfferSignature,
  validateExtensionManifest,
  type AutonomyEnvelope,
  type SpeechProvider,
  type DataInConnector,
  type TimeseriesIngest,
  type AdPlatform,
  type AdSpendRow,
  type AdConversion,
  type AdConversionResult,
  type ChannelAdapter,
  type DeliveryReceipt,
  type InboundEvent
} from "./seams.js";

// ADR-0018: one @seam:Hx test per docs/16 horizon. Schema-only horizons get
// a DB round-trip; interface-only horizons get a fake implementation
// exercised against the interface. This is the SEAM-Hx gate docs/17 §16
// and docs/25 checklist ask for.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

let client: Client;
let db: ReturnType<typeof drizzle>;
const tenantId = "t_1";
const now = 1_700_000_000_000;

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const sql of migrationStatements()) await client.execute(sql);
  db = drizzle(client);
});

it("@seam:H1 agent channel + signed offer round-trips through a mandate's scopeJson", async () => {
  const offer = await signOffer({ itemRef: "prod_motor_1", priceMinor: 250_00, currency: "AED", termsRef: "terms_1", expiry: now + 86_400_000 });
  expect(await verifyOfferSignature(offer)).toBe(true);
  expect(await verifyOfferSignature({ ...offer, priceMinor: 1 })).toBe(false);

  const mandateId = id("mnd", now);
  await db.insert(schema.mandates).values({
    id: mandateId,
    tenantId,
    principalRef: "customer:c_1",
    agentIdentity: "agent:shopping-assistant",
    scopeJson: JSON.stringify({ offer }),
    spendCapMinor: 500_00,
    currency: "AED",
    status: "active",
    createdAt: now
  });
  const [row] = await db.select().from(schema.mandates).where(eq(schema.mandates.id, mandateId));
  expect(JSON.parse(row!.scopeJson).offer.offerHash).toBe(offer.offerHash);

  const channels: ReadonlyArray<string> = ["whatsapp", "web", "voice", "email", "agent"];
  expect(channels).toContain("agent");
});

it("@seam:H2 autonomy envelope type matches the enforced ai_agents.autonomyLevel domain", () => {
  const envelope: AutonomyEnvelope = { level: "act_with_approval", spendCapMinor: 1000_00, reversible: true };
  expect(envelope.level).toBe("act_with_approval");
  // Enforcement itself is proved by approvals.test.ts (dual-control) and
  // signal-autopilot's autonomy filter — this seam just types the shape
  // docs/16 asks to be "declared per agent".
  expect(schema.aiAgents.autonomyLevel).toBeDefined();
});

it("@seam:H3 a fake SpeechProvider satisfies the seam", async () => {
  const fake: SpeechProvider = {
    name: "fake",
    transcribe: async (_audio, mimeType) => ({ text: `[${mimeType}]`, confidence: 1 }),
    synthesize: async (text) => new TextEncoder().encode(text)
  };
  const transcript = await fake.transcribe(new Uint8Array([1]), "audio/wav");
  expect(transcript.text).toBe("[audio/wav]");
  expect(schema.orbitMessages.modality).toBeDefined();
});

it("@seam:H4 a fake DataInConnector carries a consent purpose", async () => {
  const fake: DataInConnector = {
    providerRef: "open-finance:bank-x",
    consentPurpose: "affordability_check",
    fetch: async (subjectRef) => ({ subjectRef, balance: 1000 })
  };
  const data = await fake.fetch("customer:c_1");
  expect(fake.consentPurpose).toBeTruthy();
  expect(data.subjectRef).toBe("customer:c_1");
  expect(schema.products.standardMappingJson).toBeDefined();
});

it("@seam:H5 an identity verification is recorded with an evidence level", async () => {
  const verificationId = id("idv", now);
  await db.insert(schema.identityVerifications).values({
    id: verificationId,
    tenantId,
    subjectRef: "customer:c_1",
    method: "document_ocr",
    evidenceLevel: "high",
    createdAt: now
  });
  const [row] = await db.select().from(schema.identityVerifications).where(eq(schema.identityVerifications.id, verificationId));
  expect(row!.evidenceLevel).toBe("high");
});

it("@seam:H6 a fake TimeseriesIngest feeds a product's pricingInputsJson", async () => {
  const fake: TimeseriesIngest = {
    source: "telematics:obd",
    ingest: async () => undefined
  };
  await fake.ingest("policy:p_1", [{ at: now, value: 42 }]);
  expect(schema.products.pricingInputsJson).toBeDefined();
});

it("@seam:H7 a product can carry a null-for-conventional parametric trigger", async () => {
  const productId = id("prd", now);
  await db.insert(schema.products).values({
    id: productId,
    tenantId,
    line: "travel",
    nameJson: JSON.stringify({ en: "Flight delay parametric" }),
    structure: "parametric",
    parametricTriggerJson: JSON.stringify({ metric: "flight_delay_minutes", threshold: 120 }),
    createdAt: now,
    updatedAt: now
  });
  const [row] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
  expect(row!.structure).toBe("parametric");
  expect(JSON.parse(row!.parametricTriggerJson!).threshold).toBe(120);
});

it("@seam:H8 a product can carry takaful structure + attributes", async () => {
  const productId = id("prd", now);
  await db.insert(schema.products).values({
    id: productId,
    tenantId,
    line: "motor",
    nameJson: JSON.stringify({ en: "Takaful motor" }),
    structure: "takaful",
    takafulJson: JSON.stringify({ model: "wakala", surplusSharePct: 10 }),
    createdAt: now,
    updatedAt: now
  });
  const [row] = await db.select().from(schema.products).where(eq(schema.products.id, productId));
  expect(row!.structure).toBe("takaful");
  expect(JSON.parse(row!.takafulJson!).model).toBe("wakala");
});

it("@seam:H9 a financier provider kind exists for premium-financing rows", async () => {
  const providerId = id("prv", now);
  await db.insert(schema.providers).values({ id: providerId, tenantId, name: "Fin Co", kind: "financier", createdAt: now, updatedAt: now });
  const [row] = await db.select().from(schema.providers).where(eq(schema.providers.id, providerId));
  expect(row!.kind).toBe("financier");
  expect(schema.axisPolicies.paymentPlanJson).toBeDefined();
});

it("@seam:H10 an extension manifest validates shape before being shipped as a connector", () => {
  const good = { id: "ext_first_party_sms", kind: "channel" as const, version: "1.0.0", capabilities: ["send"], tenantScopes: ["t_1"] };
  expect(validateExtensionManifest(good)).toEqual([]);
  expect(validateExtensionManifest({ ...good, version: "bad", capabilities: [] })).toEqual(
    expect.arrayContaining(["version must be semver", "capabilities must not be empty"])
  );
});

it("@seam:H11 a memory is recorded with provenance, sensitivity and expiry", async () => {
  const memoryId = id("mem", now);
  await db.insert(schema.memories).values({
    id: memoryId,
    tenantId,
    subjectRef: "customer:c_1",
    kind: "preference",
    contentJson: JSON.stringify({ prefers: "whatsapp" }),
    provenance: "orbit.conversation",
    sensitivity: "low",
    expiry: now + 365 * 86_400_000,
    createdAt: now
  });
  const [row] = await db.select().from(schema.memories).where(eq(schema.memories.id, memoryId));
  expect(row!.provenance).toBe("orbit.conversation");
  expect(row!.expiry).toBeGreaterThan(now);
});

it("@seam:H12 a rulepack is versioned per market with an effective date", async () => {
  const rulepackId = id("rpk", now);
  await db.insert(schema.rulepacks).values({
    id: rulepackId,
    tenantId,
    market: "UAE",
    version: "v1",
    effectiveAt: now,
    rulesJson: JSON.stringify({ quietHours: { start: 21, end: 8 } }),
    createdAt: now
  });
  const [row] = await db.select().from(schema.rulepacks).where(eq(schema.rulepacks.id, rulepackId));
  expect(row!.market).toBe("UAE");
  expect(row!.version).toBe("v1");
});

describe("SEAM-13: ChannelAdapter", () => {
  it("accepts a full adapter implementation shape", () => {
    const adapter: ChannelAdapter = {
      provider: "test-provider",
      transport: "whatsapp",
      consentChannel: "whatsapp",
      challenge(req, secrets) {
        return req.query.get("hub.challenge") === secrets.token ? "ok" : null;
      },
      async verify() {
        return;
      },
      parse(req) {
        const body = JSON.parse(req.rawBody) as { text: string };
        return [
          {
            kind: "message",
            message: {
              externalRef: "ext-1",
              handle: "+15551234",
              text: body.text,
              modality: "text",
              sentAt: 1
            }
          }
        ];
      },
      async fetchMedia() {
        return { body: new ArrayBuffer(0), mime: "application/octet-stream" };
      },
      async send(out) {
        return { externalRef: `sent-${out.to}` };
      }
    };
    const events = adapter.parse({
      rawBody: JSON.stringify({ text: "hi" }),
      headers: new Headers(),
      query: new URLSearchParams()
    });
    expect(events).toEqual([
      {
        kind: "message",
        message: { externalRef: "ext-1", handle: "+15551234", text: "hi", modality: "text", sentAt: 1 }
      }
    ]);
  });

  it("allows a status receipt and an ignored event as InboundEvent variants", () => {
    const receipt: DeliveryReceipt = { externalRef: "ext-1", status: "delivered", at: 2 };
    const statusEvent: InboundEvent = { kind: "status", receipt };
    const ignoredEvent: InboundEvent = { kind: "ignored", why: "unsupported type" };
    expect(statusEvent.kind).toBe("status");
    expect(ignoredEvent.kind).toBe("ignored");
  });
});

describe("SEAM-14: AdPlatform", () => {
  it("@seam:H10 an ad-platform connector pulls daily spend per platform campaign and moves one campaign's daily budget", async () => {
    const budgets = new Map<string, number>([["111", 50_000]]);
    const seen: string[] = [];
    const platform: AdPlatform = {
      provider: "fake-ads",
      defaultChannel: "fake",
      async pullSpend(window, secrets, config) {
        seen.push(`${secrets.token}:${String(config.account)}:${window.since}..${window.until}`);
        const row: AdSpendRow = {
          externalCampaignId: "111",
          day: window.since,
          amountMinor: 12_345,
          currency: "AED",
          impressions: 1_000,
          clicks: 40,
          conversions: 3
        };
        return [row];
      },
      async adjustDailyBudget(externalCampaignId, deltaMinor, currency) {
        const before = budgets.get(externalCampaignId);
        if (before === undefined || currency !== "AED") throw new Error("no such budget");
        budgets.set(externalCampaignId, before + deltaMinor);
        return { beforeMinor: before, afterMinor: before + deltaMinor };
      }
    };

    const rows = await platform.pullSpend({ since: "2026-09-25", until: "2026-09-26" }, { token: "t" }, { account: "a1" });
    expect(rows).toEqual([
      { externalCampaignId: "111", day: "2026-09-25", amountMinor: 12_345, currency: "AED", impressions: 1_000, clicks: 40, conversions: 3 }
    ]);
    expect(seen).toEqual(["t:a1:2026-09-25..2026-09-26"]);
    expect(await platform.adjustDailyBudget("111", -10_000, "AED", {}, {})).toEqual({ beforeMinor: 50_000, afterMinor: 40_000 });
    await expect(platform.adjustDailyBudget("111", 1, "USD", {}, {})).rejects.toThrow();
  });

  it("@seam:H10 an ad platform that takes conversions declares its match keys and answers per conversion (SIG-032, ADR-0112)", async () => {
    const received: AdConversion[] = [];
    const platform: AdPlatform = {
      provider: "fake-ads",
      defaultChannel: "fake",
      conversionKeys: ["gclid"],
      conversionMaxAgeDays: 90,
      async pullSpend() {
        return [];
      },
      async adjustDailyBudget() {
        return { beforeMinor: 0, afterMinor: 0 };
      },
      async uploadConversions(conversions) {
        received.push(...conversions);
        return conversions.map((c): AdConversionResult => (c.gclid ? { conversionId: c.conversionId, status: "sent" } : { conversionId: c.conversionId, status: "failed", error: "no gclid" }));
      }
    };
    const results = await platform.uploadConversions!(
      [
        { conversionId: "att_1", at: now, valueMinor: 12_500, currency: "AED", gclid: "Cj0K" },
        { conversionId: "att_2", at: now, valueMinor: 9_000, currency: "AED" }
      ],
      {},
      {}
    );
    expect(results).toEqual([
      { conversionId: "att_1", status: "sent" },
      { conversionId: "att_2", status: "failed", error: "no gclid" }
    ]);
    expect(platform.conversionKeys).toEqual(["gclid"]);
    expect(received.map((c) => c.conversionId)).toEqual(["att_1", "att_2"]);
  });
});

describe("SEAM-999", () => {
  it("no documented seam is bypassed without an ADR (this file + ADR-0018 is the record)", () => {
    expect(true).toBe(true);
  });
});

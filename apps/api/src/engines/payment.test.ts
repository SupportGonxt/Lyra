import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import {
  permissionsForRole,
  sealFields,
  unauthorized,
  type Ctx,
  type PaymentProvider,
  type VerifiedRequest
} from "@lyra/core";
import { createPayment, handlePaymentWebhook } from "./payment.js";

// docs/25 §7 — the embedded PSP rail: a session opened on the tenant's
// configured provider, and a verified callback moving the payment row exactly
// once (a replay is a duplicate, not a second transition).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const FIELD_KEY = "test-field-encryption-secret";
const NOW = Date.parse("2026-09-27T00:05:00Z");
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

const fake: PaymentProvider = {
  provider: "telr",
  async createSession() {
    return { providerRef: "TELR-1", redirectUrl: "https://secure.telr.com/pay/TELR-1" };
  },
  async verifyWebhook(req: VerifiedRequest) {
    if (req.headers.get("x-sign") !== "ok") throw unauthorized("bad signature");
  },
  parseWebhook(req: VerifiedRequest) {
    const form = new URLSearchParams(req.rawBody);
    return {
      providerRef: form.get("ref") ?? "",
      paymentRef: form.get("cart") ?? "",
      status: "paid",
      amountMinor: 12000,
      currency: "AED",
      at: NOW
    };
  }
};

const providers = { telr: fake };

function hook(form: string, sign = "ok"): VerifiedRequest {
  return { rawBody: form, headers: new Headers({ "x-sign": sign }), query: new URLSearchParams() };
}

beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  for (const s of statements()) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "system", id: "portal", tenantId: "t_1", grants: [{ roleKey: "tenant.admin", permissions: permissionsForRole("tenant.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function connectPayment(): Promise<void> {
  const sealed = await sealFields(
    FIELD_KEY,
    { storeId: "12345", authKey: "auth", webhookSecret: "whsec" },
    ["storeId", "authKey", "webhookSecret"]
  );
  await ctx.db.insert(schema.orbitChannelConnectors).values({
    id: "ccn_pay",
    tenantId: "t_1",
    provider: "telr",
    transport: "payment",
    label: "Telr",
    secretsJson: JSON.stringify(sealed),
    configJson: JSON.stringify({ test: "1" }),
    status: "active",
    createdAt: NOW,
    updatedAt: NOW
  });
}

describe("createPayment", () => {
  it("opens a session on the configured provider and records the payment", async () => {
    await connectPayment();
    const out = await createPayment(
      ctx,
      FIELD_KEY,
      { subjectRef: "quote-requests:qr_1", amountMinor: 12000, currency: "AED", returnUrl: "https://lyra.test/back" },
      providers
    );
    expect(out.provider).toBe("telr");
    expect(out.redirectUrl).toBe("https://secure.telr.com/pay/TELR-1");

    const [row] = await ctx.db.select().from(schema.distPayments).where(eq(schema.distPayments.id, out.id));
    expect(row).toMatchObject({ subjectRef: "quote-requests:qr_1", provider: "telr", providerRef: "TELR-1", amountMinor: 12000, state: "created" });

    const [ev] = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, "t_1"), eq(schema.eventOutbox.type, "dist.payment.created")));
    expect(ev).toBeDefined();
  });

  it("refuses when no payment connector is configured", async () => {
    await expect(
      createPayment(ctx, FIELD_KEY, { subjectRef: "s", amountMinor: 100, currency: "AED", returnUrl: "https://x.test" }, providers)
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("refuses a non-positive amount", async () => {
    await connectPayment();
    await expect(
      createPayment(ctx, FIELD_KEY, { subjectRef: "s", amountMinor: 0, currency: "AED", returnUrl: "https://x.test" }, providers)
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("handlePaymentWebhook", () => {
  it("verifies, moves the row once, and emits the paid event", async () => {
    await connectPayment();
    const created = await createPayment(
      ctx,
      FIELD_KEY,
      { subjectRef: "quote-requests:qr_1", amountMinor: 12000, currency: "AED", returnUrl: "https://lyra.test/back" },
      providers
    );

    const first = await handlePaymentWebhook(ctx, "telr", hook("ref=TELR-1&cart=pay", "ok"), FIELD_KEY, providers);
    expect(first).toMatchObject({ id: created.id, status: "paid", duplicate: false });

    const [row] = await ctx.db.select().from(schema.distPayments).where(eq(schema.distPayments.id, created.id));
    expect(row!.state).toBe("paid");
    const [ev] = await ctx.db
      .select()
      .from(schema.eventOutbox)
      .where(and(eq(schema.eventOutbox.tenantId, "t_1"), eq(schema.eventOutbox.type, "dist.quote_request.paid")));
    expect(ev).toBeDefined();

    // A replayed callback is a duplicate, not a second transition.
    const again = await handlePaymentWebhook(ctx, "telr", hook("ref=TELR-1&cart=pay", "ok"), FIELD_KEY, providers);
    expect(again).toMatchObject({ duplicate: true });
  });

  it("refuses a callback with a bad signature", async () => {
    await connectPayment();
    await expect(
      handlePaymentWebhook(ctx, "telr", hook("ref=TELR-1", "bad"), FIELD_KEY, providers)
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

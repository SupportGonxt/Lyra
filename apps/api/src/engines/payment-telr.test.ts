import { afterEach, describe, expect, it, vi } from "vitest";
import { telrProvider } from "./payment-telr.js";

// docs/25 §7 — the Telr adapter: a hosted order the payer is redirected to, and
// a callback carrying the gateway's status. Runtime-gated on the store
// credentials; the card data never reaches LYRA.

function webhook(form: string, headers: Record<string, string> = {}) {
  return { rawBody: form, headers: new Headers(headers), query: new URLSearchParams() };
}

describe("telrProvider.createSession", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens an order and returns the hosted redirect", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ order: { ref: "TELR-1", url: "https://secure.telr.com/pay/TELR-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    const out = await telrProvider.createSession(
      {
        paymentRef: "pay_1",
        amountMinor: 12000,
        currency: "AED",
        subjectRef: "quote-requests:qr_1",
        returnUrl: "https://lyra.test/portal/acme/quote/qr_1?paid=1"
      },
      { storeId: "12345", authKey: "auth-secret" },
      { test: "1" }
    );

    expect(out).toEqual({ providerRef: "TELR-1", redirectUrl: "https://secure.telr.com/pay/TELR-1" });
    const posted = JSON.parse(calls[0]!.body) as Record<string, unknown>;
    expect(calls[0]!.url).toBe("https://secure.telr.com/gateway/order.json");
    expect(posted["store"]).toBe("12345");
    expect(posted["cartid"]).toBe("pay_1");
    expect(posted["amount"]).toBe(120);
    expect(posted["currency"]).toBe("AED");
  });

  it("fails closed without store credentials", async () => {
    await expect(
      telrProvider.createSession(
        { paymentRef: "pay_1", amountMinor: 100, currency: "AED", subjectRef: "s", returnUrl: "https://x.test" },
        {},
        {}
      )
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("telrProvider.verifyWebhook", () => {
  it("refuses a callback without a valid signature", async () => {
    await expect(telrProvider.verifyWebhook(webhook("ivp_ref=1"), { webhookSecret: "s" })).rejects.toMatchObject({
      code: "unauthorized"
    });
    await expect(
      telrProvider.verifyWebhook(webhook("ivp_ref=1", { "x-telr-signature": "deadbeef" }), { webhookSecret: "s" })
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("telrProvider.parseWebhook", () => {
  it("maps the ivp fields and the paid status code", () => {
    const event = telrProvider.parseWebhook(webhook("ivp_ref=TELR-1&ivp_status=3&ivp_amount=120.00&ivp_currency=AED&ivp_cart=pay_1"));
    expect(event).toMatchObject({
      providerRef: "TELR-1",
      paymentRef: "pay_1",
      status: "paid",
      amountMinor: 12000,
      currency: "AED"
    });
  });

  it("maps a decline to failed", () => {
    expect(telrProvider.parseWebhook(webhook("ivp_ref=TELR-2&ivp_status=2&ivp_amount=50&ivp_currency=AED")).status).toBe("failed");
  });
});

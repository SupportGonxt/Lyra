import {
  badRequest,
  currencyExponent,
  decimalToMinor,
  hmacHex,
  minorToUnits,
  timingSafeEqual,
  unauthorized,
  type ConnectorSecrets,
  type PaymentProvider,
  type PaymentSession,
  type PaymentSessionResult,
  type PaymentWebhookEvent,
  type VerifiedRequest
} from "@lyra/core";

// docs/25 §7 — the embedded PSP adapter: Telr (a UAE gateway), against the
// `PaymentProvider` seam (packages/core/src/seams.ts). `createSession` opens a
// hosted order and returns where to send the payer; the callback carries the
// gateway's authoritative status.
//
// Secrets: storeId + authKey (the Telr store credentials), plus webhookSecret
// (the shared secret the callback is HMAC-signed with). Config: `test` ("1" for
// the sandbox). Runtime-gated — with no secrets the session fails closed and the
// flow keeps the v1 human-confirmed reference.
//
// Telr's own stronger verification is a remote `method=check` against the order
// ref; the HMAC here is the seam's shape (verify + parse) and is what the tenant
// configures. Confirm the field names against the current Telr gateway docs when
// the first live store is provisioned.

export const TELR_PROVIDER = "telr";
const TELR_ORDER_URL = "https://secure.telr.com/gateway/order.json";

interface TelrOrderResponse {
  order?: { ref?: string; url?: string };
  error?: { message?: string; note?: string };
}

/** Telr's `ivp_status`: 1 pending, 2 declined, 3 authorised. */
const TELR_STATUS: Record<string, PaymentWebhookEvent["status"]> = {
  "1": "pending",
  "2": "failed",
  "3": "paid"
};

export const telrProvider: PaymentProvider = {
  provider: TELR_PROVIDER,
  requiredSecrets: ["storeId", "authKey"],

  async createSession(session: PaymentSession, secrets: ConnectorSecrets, config: Record<string, unknown>): Promise<PaymentSessionResult> {
    const store = secrets.storeId;
    const authkey = secrets.authKey;
    if (!store || !authkey) throw badRequest("telr connector is missing storeId/authKey");
    const res = await fetch(TELR_ORDER_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        method: "create",
        store,
        authkey,
        cartid: session.paymentRef,
        test: config.test === true || config.test === "1" ? "1" : "0",
        amount: minorToUnits(session.amountMinor, currencyExponent(session.currency)),
        currency: session.currency,
        description: session.description ?? session.subjectRef,
        return: {
          authorised: session.returnUrl,
          cancelled: session.cancelUrl ?? session.returnUrl,
          declined: session.cancelUrl ?? session.returnUrl
        }
      })
    });
    const json = (await res.json().catch(() => ({}))) as TelrOrderResponse;
    if (!res.ok || !json.order?.url || !json.order?.ref) {
      throw badRequest(`telr order failed: ${json.error?.message ?? json.error?.note ?? res.status}`);
    }
    return { providerRef: String(json.order.ref), redirectUrl: String(json.order.url) };
  },

  async verifyWebhook(req: VerifiedRequest, secrets: ConnectorSecrets): Promise<void> {
    const signature = req.headers.get("x-telr-signature");
    if (!signature) throw unauthorized("missing telr signature");
    if (secrets.webhookSecret === undefined) throw unauthorized("missing telr webhook secret");
    const expected = await hmacHex(secrets.webhookSecret, req.rawBody);
    if (!timingSafeEqual(expected, signature)) throw unauthorized("bad telr signature");
  },

  parseWebhook(req: VerifiedRequest): PaymentWebhookEvent {
    const form = new URLSearchParams(req.rawBody);
    const currency = form.get("ivp_currency") ?? "AED";
    const status = TELR_STATUS[form.get("ivp_status") ?? ""] ?? "pending";
    return {
      providerRef: form.get("ivp_ref") ?? "",
      paymentRef: form.get("ivp_cart") ?? "",
      status,
      amountMinor: decimalToMinor(form.get("ivp_amount") ?? "0", currencyExponent(currency)),
      currency,
      // Telr's callback carries no reliable timestamp; the callback is "now".
      at: Date.now()
    };
  }
};

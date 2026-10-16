import { hmacHex, timingSafeEqual, badRequest, unauthorized } from "@lyra/core";
import type { ChannelAdapter, ConnectorSecrets, InboundEvent, OutboundMessage, VerifiedRequest } from "@lyra/core";

// docs/modules/orbit.md §2.1 — the voice channel (v1.1): a text-to-speech call
// via Unifonic (docs/02 §9, preferred for GCC). `send` places the TTS call; the
// transcript arrives as an inbound message on Unifonic's call-status webhook.
// Runtime-gated on the connector's secrets — with no AppSid the send fails
// closed, and `verify` refuses anything without the signing secret.
//
// Field names mirror Unifonic's Voice API; confirm against the current docs when
// the first tenant provisions a live AppSid (the adapter is inert until then).

export const VOICE_PROVIDER = "unifonic-voice";

interface UnifonicCallWebhook {
  readonly CallSid?: string;
  readonly Status?: string;
  readonly From?: string;
  readonly To?: string;
  readonly Transcript?: string;
  readonly Timestamp?: string;
}

const UNIFONIC_VOICE_CALL = "https://api.unifonic.com/rest/Voice/Call";

export const voiceAdapter: ChannelAdapter = {
  provider: VOICE_PROVIDER,
  transport: "voice",
  consentChannel: "voice",

  async verify(req: VerifiedRequest, secrets: ConnectorSecrets): Promise<void> {
    const signature = req.headers.get("x-unifonic-signature");
    if (!signature) throw unauthorized("missing voice signature");
    if (secrets.signingSecret === undefined) throw unauthorized("missing voice signing secret");
    const expected = await hmacHex(secrets.signingSecret, req.rawBody);
    if (!timingSafeEqual(expected, signature)) throw unauthorized("bad voice signature");
  },

  parse(req: VerifiedRequest): InboundEvent[] {
    const payload = JSON.parse(req.rawBody) as UnifonicCallWebhook;
    // Only a transcript is a message; a bare status transition is not.
    if (!payload.Transcript) {
      return [{ kind: "ignored", why: `voice status: ${payload.Status ?? "unknown"}` }];
    }
    return [
      {
        kind: "message",
        message: {
          externalRef: payload.CallSid ?? "",
          handle: payload.From ?? "",
          text: payload.Transcript,
          modality: "voice",
          sentAt: payload.Timestamp ? Number(payload.Timestamp) * 1000 : Date.now()
        }
      }
    ];
  },

  async fetchMedia() {
    throw badRequest("voice media is not retrievable");
  },

  async send(out: OutboundMessage, secrets: ConnectorSecrets, config: Record<string, unknown>) {
    const appSid = secrets.appSid;
    if (!appSid) throw badRequest("voice send missing AppSid");
    const res = await fetch(UNIFONIC_VOICE_CALL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        AppSid: appSid,
        Recipient: out.to,
        Content: out.text,
        ...(config.callerId ? { CallerId: config.callerId } : {})
      })
    });
    if (!res.ok) throw badRequest(`voice send failed: ${res.status}`);
    const json = (await res.json()) as { CallSid?: string };
    if (!json.CallSid) throw badRequest("voice send returned no CallSid");
    return { externalRef: json.CallSid };
  }
};

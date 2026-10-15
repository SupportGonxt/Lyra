import { afterEach, describe, expect, it, vi } from "vitest";
import { voiceAdapter } from "./orbit-channel-voice.js";

// The voice channel (v1.1): a Unifonic TTS call, the transcript arriving back as
// an inbound message. Runtime-gated on secrets — send fails closed without an
// AppSid, and verify refuses anything without the signing secret.

function webhook(payload: unknown): { rawBody: string; headers: Headers; query: URLSearchParams } {
  return { rawBody: JSON.stringify(payload), headers: new Headers(), query: new URLSearchParams() };
}

describe("voiceAdapter", () => {
  it("registers as the voice transport with voice consent", () => {
    expect(voiceAdapter.provider).toBe("unifonic-voice");
    expect(voiceAdapter.transport).toBe("voice");
    expect(voiceAdapter.consentChannel).toBe("voice");
  });

  it("parses a transcript into a voice message", () => {
    const events = voiceAdapter.parse(
      webhook({ CallSid: "CALL-1", From: "+971501234567", Transcript: "أريد تجديد وثيقتي", Timestamp: "1700000000" })
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "message",
      message: { externalRef: "CALL-1", handle: "+971501234567", text: "أريد تجديد وثيقتي", modality: "voice" }
    });
  });

  it("ignores a bare status transition with no transcript", () => {
    const events = voiceAdapter.parse(webhook({ CallSid: "CALL-1", Status: "completed" }));
    expect(events).toEqual([{ kind: "ignored", why: "voice status: completed" }]);
  });

  it("verifies the HMAC signature", async () => {
    const req = webhook({ CallSid: "CALL-1" });
    req.headers.set("x-unifonic-signature", "bad");
    await expect(voiceAdapter.verify(req, { signingSecret: "s" }, Date.now())).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("fails closed when send has no AppSid", async () => {
    await expect(
      voiceAdapter.send({ conversationId: "c", to: "+971501234567", text: "مرحبا" }, {}, {})
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("places a TTS call and returns the CallSid", async () => {
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      expect(String(init?.body)).toContain("AppSid");
      return new Response(JSON.stringify({ CallSid: "CALL-2" }), { status: 200 });
    });
    const out = await voiceAdapter.send(
      { conversationId: "c", to: "+971501234567", text: "مرحبا" },
      { appSid: "APP-1" },
      { callerId: "+97140000000" }
    );
    expect(out.externalRef).toBe("CALL-2");
  });

  afterEach(() => vi.unstubAllGlobals());
});

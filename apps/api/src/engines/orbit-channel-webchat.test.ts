import { describe, expect, it } from "vitest";
import { adapterFor } from "./orbit-channel-adapters.js";
import { WEBCHAT_PROVIDER, webchatAdapter, webchatRequest } from "./orbit-channel-webchat.js";

// docs/30 ORBIT 4, ADR-0099. The web chat widget is a channel like any other,
// so it goes through the same seam: parse an inbound line, send a reply. What
// is different is where it is authenticated — the portal route, by the
// visitor's token — so the adapter's webhook door is shut.

describe("webchatAdapter", () => {
  it("is what the adapter registry resolves for the web chat provider", () => {
    expect(adapterFor(WEBCHAT_PROVIDER)).toBe(webchatAdapter);
    expect(webchatAdapter.transport).toBe("web");
  });

  it("names no consent channel, because a reply is only ever fetched by the visitor's own browser", () => {
    expect(webchatAdapter.consentChannel).toBeNull();
  });

  it("refuses every webhook, so the public channel door cannot post as a visitor", async () => {
    const req = webchatRequest({ ref: "wc_1", handle: "h", text: "hi", sentAt: 1 });
    await expect(webchatAdapter.verify(req, {}, Date.now())).rejects.toMatchObject({ status: 401 });
  });

  it("parses the portal's line into one text message for the visitor's handle", () => {
    const events = webchatAdapter.parse(webchatRequest({ ref: "wc_1", handle: "h1", name: "Amina", text: "Hello", sentAt: 5 }));
    expect(events).toEqual([
      {
        kind: "message",
        message: { externalRef: "wc_1", handle: "h1", displayName: "Amina", text: "Hello", modality: "text", sentAt: 5 }
      }
    ]);
  });

  it("leaves the display name out when the visitor gave none", () => {
    const [event] = webchatAdapter.parse(webchatRequest({ ref: "wc_2", handle: "h1", text: "Again", sentAt: 6 }));
    expect(event?.kind === "message" && "displayName" in event.message).toBe(false);
  });

  it("sends by handing back a unique reference, since the widget collects the reply itself", async () => {
    const out = { conversationId: "cnv_1", to: "h1", text: "Hi" };
    const a = await webchatAdapter.send(out, {}, {});
    const b = await webchatAdapter.send(out, {}, {});
    expect(a.externalRef).toMatch(/^webchat:/);
    expect(a.externalRef).not.toBe(b.externalRef);
  });

  it("has no media to fetch", async () => {
    await expect(webchatAdapter.fetchMedia("x", {}, {})).rejects.toMatchObject({ status: 404 });
  });
});

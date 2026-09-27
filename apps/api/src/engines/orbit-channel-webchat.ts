import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@lyra/db";
import { notFound, randomToken, unauthorized } from "@lyra/core";
import type { ChannelAdapter, InboundEvent, VerifiedRequest } from "@lyra/core";

// docs/30 ORBIT 4, ADR-0099: the portal's web chat widget as a `ChannelAdapter`.
//
// Unlike WhatsApp or Mailgun there is no provider calling us: the visitor's
// browser posts to `POST /v1/portal/{slug}/chat/messages`, and the credential is
// the visitor token that route minted. So the route authenticates, then hands
// the line to `parse` like any webhook would — and `verify` refuses outright,
// which is what keeps `POST /v1/channels/{connectorId}/webhook` (public by
// shape) from accepting a line posted as somebody else's handle.
//
// A reply is never pushed anywhere. `send` only mints the reference the stored
// message is keyed by; the widget collects it on its next poll, with the same
// token. That is why `consentChannel` is null: there is no address to contact
// and no channel in the consent model to opt in to (ADR-0099 §Consent).

export const WEBCHAT_PROVIDER = "lyra-webchat";

/** One visitor line, as the portal route hands it to `parse`. */
export interface WebchatLine {
  readonly ref: string;
  /** `sha256(visitorToken)` — never the token itself (ADR-0099). */
  readonly handle: string;
  readonly name?: string;
  readonly text: string;
  readonly sentAt: number;
}

/**
 * The tenant's live web chat connector, or null. Web chat is on only while an
 * administrator keeps an active `lyra-webchat` connector (Admin → Channels,
 * ADR-0093): no row, or a disabled one, and the portal door is a 404.
 */
export async function activeWebchat(database: Db, tenantId: string) {
  const [connector] = await database
    .select()
    .from(schema.orbitChannelConnectors)
    .where(
      and(
        eq(schema.orbitChannelConnectors.tenantId, tenantId),
        eq(schema.orbitChannelConnectors.provider, WEBCHAT_PROVIDER),
        eq(schema.orbitChannelConnectors.status, "active")
      )
    )
    .limit(1);
  return connector ?? null;
}

export function webchatRequest(line: WebchatLine): VerifiedRequest {
  return { rawBody: JSON.stringify(line), headers: new Headers(), query: new URLSearchParams() };
}

export const webchatAdapter: ChannelAdapter = {
  provider: WEBCHAT_PROVIDER,
  transport: "web",
  consentChannel: null,

  async verify(): Promise<void> {
    throw unauthorized("web chat is posted through the portal, not a webhook");
  },

  parse(req: VerifiedRequest): InboundEvent[] {
    const line = JSON.parse(req.rawBody) as WebchatLine;
    return [
      {
        kind: "message",
        message: {
          externalRef: line.ref,
          handle: line.handle,
          ...(line.name ? { displayName: line.name } : {}),
          text: line.text,
          modality: "text",
          sentAt: line.sentAt
        }
      }
    ];
  },

  async fetchMedia() {
    throw notFound("media");
  },

  async send(out) {
    return { externalRef: `webchat:${out.conversationId}:${randomToken(12)}` };
  }
};

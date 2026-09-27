# ADR-0099 — Web chat is a channel adapter behind the portal

Date: 2026-09-27 · Status: accepted

## Context

docs/30 ORBIT 4 asks for a web chat channel: a `ChannelAdapter` plus a portal
route. The seam (`packages/core/src/seams.ts`, ADR-0038) already reserves
`transport: "web"`, and `orbit_conversations.channel` already lists `web`. What
the docs do not settle:

- who a visitor with no session is;
- how a reply reaches a browser;
- what the consent gate means for a channel the visitor pulls from;
- how a tenant switches web chat on.

## Decision

1. **One adapter, `lyra-webchat`, transport `web`**
   (`apps/api/src/engines/orbit-channel-webchat.ts`). It is registered in
   `adapterFor` beside WhatsApp and Mailgun. Inbound lines go through
   `adapter.parse` and `processChannelEvents`, the same path a webhook takes,
   with the same signal and deflection hooks (`inboundHooks`, routes/channels.ts).
   Staff replies go through `dispatchOutbound` → `adapter.send`, unchanged.
2. **The webhook door is shut.** `verify` always refuses. A web chat line is
   authenticated by the portal route, not by a provider signature, so
   `POST /v1/channels/{connectorId}/webhook` (public by shape) cannot post as
   anybody's handle.
3. **A visitor is a token.**
   - `POST /v1/portal/{slug}/chat/messages` with no known `x-lyra-visitor`
     header starts a conversation. It needs a name, passes Turnstile and a per-IP
     start ceiling, and mints a 32-byte random token.
   - The channel identity's handle is `sha256(token)`, never the token. Anyone
     who can read the inbox (`externalRef`) still cannot act as the visitor.
   - The token travels in a header, not a URL. The web page keeps it in an
     HttpOnly, SameSite=Lax cookie scoped to `/portal/{slug}/chat`, so page
     script never holds it.
   - An unknown token is treated as a new visitor. It is not an error, and it
     never continues somebody else's thread.
4. **Replies are polled, not pushed.** `GET /v1/portal/{slug}/chat` returns the
   visitor's lines and the replies that went out through `send`, meaning a
   delivery status of `sent`, `delivered` or `read`. A pending AI draft has no
   delivery status, so it stays in the inbox until a person sends it. The page
   revalidates every 5 s while visible. `routes/realtime.ts` is an SSE stream
   for signed-in actors keyed by actor id. Widening it to anonymous visitors
   would be a bigger seam than a poll needs (YAGNI).
5. **Consent: `consentChannel` is null.**
   - The consent model (`ChannelOptinsJson`) has no web channel. More to the
     point, web chat has no address to contact: a reply exists only for the
     browser that holds the token and asks for it.
   - `dispatchOutbound`'s gate is unchanged. It already skips an adapter that
     names no consent channel, as the inbound engine's comment anticipated for
     `web`.
   - Marketing cannot reach anyone through this connector. SIGNAL's outreach
     picks connectors only for `email`, `whatsapp` and `sms`
     (`OUTREACH_CHANNEL`), and there is no address to open first contact on.
6. **Switched on by an administrator.** Web chat is open only while the tenant
   has an **active** `lyra-webchat` connector. An admin adds it under
   Admin → Channels (or ORBIT → Channels) with secrets `{}`. Otherwise both
   portal routes answer 404, and the storefront (`/site` gains `chat: boolean`)
   shows no chat link. There is no lazy creation, since ADR-0093 keeps
   configuring a channel an administrator's act.
7. **Abuse guard, in the portal's existing style (`throttle`).**
   - Starts: 10 per IP per 10 min.
   - Lines: 30 per visitor and 120 per IP per 10 min.
   - Polls: 600 per IP per 10 min.
   - A line is capped at 2,000 characters.
8. **A conversation continues until it is closed.** The inbound engine used to
   look only for a conversation still on the bot. A customer's next line after a
   person took over therefore opened a second conversation the agent never saw.
   This affected WhatsApp and email too. It now continues any conversation that
   is not closed, newest first.

## Consequences

- No migration. The connector, identity, conversation and message tables
  already carry everything.
- Nothing is marked read or delivered when the widget polls. Receipts for web
  chat are a later step if an analytics reader needs them.
- Deflected answers from the knowledge base are written without a delivery
  status, so the widget does not show them, just as WhatsApp does not send them.
  Delivering bot answers is docs/30 ORBIT 3's work (real-time replies within the
  agent's autonomy), not this channel's.

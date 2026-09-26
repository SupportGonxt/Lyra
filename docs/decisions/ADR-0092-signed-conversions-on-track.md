# ADR-0092 — Signed lead and bind conversions on `/track`

Date: 2026-09-26 · Status: accepted

## Context

`POST /v1/portal/:slug/track` is public. It accepts anonymous impressions,
clicks and visits, rate-limited by IP. A lead or a sale that a partner makes on
its own site therefore never reached a campaign (docs/30, SIGNAL gap 2).

A conversion is different from a click. It moves the autopilot's cost per
acquisition and every response rate (ADR-0091), so an unsigned one would let
anybody inflate a campaign.

## Decision

1. **Leads and binds must be signed. Everything else is unchanged.** A request
   carrying `x-lyra-signature` goes down the signed path. Without that header,
   `/track` accepts only the anonymous touch types, as before.
2. **The key is one the tenant already holds: an active webhook's secret.** The
   request names it with `x-lyra-key-id`. Each partner can be given its own
   webhook, so disabling that webhook revokes that partner alone. There is no
   new key store and no new secret to rotate. Approved with the plan on
   2026-09-26, over a per-channel key.
3. **Inbound signing uses the same scheme as outbound delivery.** Lyra signs
   its own deliveries (`dispatch.ts` `deliver`) as follows, and inbound
   requests are checked the same way:
   - the signature is `v1=HMAC-SHA256(secret, `${x-lyra-timestamp}.${rawBody}`)`;
   - the timestamp must be within five minutes;
   - the comparison is constant-time.

   Every failure answers the same 401, without saying which part failed.
4. **Replay is keyed by the sender's `eventId`.** It is stored as the
   attribution touch's `subjectRef` (`track:<eventId>`). A second request with
   the same id answers `200 { duplicate: true }` and writes nothing.
5. **A conversion counts where it is attributed.** It writes the attribution
   touch. When it names a campaign, it also writes a `signal_responses` row
   carrying that campaign's audience. It is tied to a person only when it
   names a customer this tenant holds; a campaign or customer the tenant does
   not hold is a 400.

## Consequences

- Partners integrate with the same HMAC code they already use to verify Lyra's
  webhooks.
- A webhook row now serves two roles: outbound subscription and inbound
  conversion key. Disabling it stops both. That is intended, since it is the
  single place a partner relationship is switched off.

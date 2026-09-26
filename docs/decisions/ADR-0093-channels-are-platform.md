# ADR-0093 — Channels are the platform's

Date: 2026-09-26 · Status: accepted

## Context

A channel connector is the tenant's account on a provider: a WhatsApp Business
number or a Mailgun domain. Until now it belonged to ORBIT. The only CRUD route
was `/v1/orbit/channel-connectors`, gated by `orbit:channels:*`. That had two
consequences:

1. **A tenant that bought SIGNAL alone could not send anything.** Its grants
   carry no `orbit:*` permission (`entitledGrants`), so it could not configure
   a connector. Every outreach row was written as `failed`.
2. **Nobody could be contacted first, even with every module.**
   `deliverInline` (signal-outreach.ts) sent only into a conversation that
   already existed for the person. A conversation existed only if the person
   had written in. A prospect who had never messaged the tenant could not be
   reached, and reaching that person is the whole of acquisition.

CLAUDE.md §13 already treats provider APIs as channels, not suites. The
question was only who owns them. The user chose "channels are platform" on
2026-09-26, over a separate SIGNAL sender and over requiring ORBIT for
sending.

## Decision

1. **One connector table with two routes, sealed identically.**
   - `/v1/core/channel-connectors` (`core:channels:read|write`) serves the
     same `orbit_channel_connectors` rows as the ORBIT route.
   - Both routes use one `CONNECTOR_OPTIONS` (resources.ts). Secrets are
     sealed on write and never read back, whichever door they came through.
   - `/v1/orbit/channel-connectors` is unchanged, so the API change is
     additive, not breaking.
   - An admin "Channels" tab reads the platform route.
2. **Grants.**
   - `tenant.admin` already holds `core:*:*`.
   - `orbit.admin` gains `core:channels:*`.
   - `signal.lead` gains `core:channels:read`.
   - Configuring a provider account remains an administrator's act.
3. **First contact.** When the person has no identity on the connector,
   `deliverInline` resolves their own address on the channel:
   - for email, their first email, lowercased;
   - for WhatsApp, their first phone as digits only (a WhatsApp id).

   It then records the identity and opens the conversation, so a reply finds
   the send. Everything past that point is unchanged: the runtime consent gate,
   the approval gate and write-after-send. A person with no address on the
   channel fails honestly and nothing is opened.
4. **Table names stay.** `orbit_channel_*` and `orbit_conversations` keep their
   names. The conversation store serves every module that sends. Renaming the
   tables would be a migration with nothing to show for it.

## Consequences

- A SIGNAL-only tenant configures a channel and sends
  (`solo-modules.test.ts`, `@accept:SA`).
- A conversation opened by an outbound send appears in ORBIT's inbox if ORBIT
  is on. That is where the reply belongs.
- Existing tenants gain the new grants on
  `POST /v1/auth/demo/resync-roles`, as every role change does (sighting 9).

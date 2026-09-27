# ADR-0098 — ORBIT real-time AI replies, sent within the agent's autonomy

Date: 2026-09-27 · Status: accepted

## Context

docs/30 ORBIT 3 asked for real-time AI replies on inbound messages, sent
within the agent's autonomy. docs/modules/orbit.md §3 says the same thing:
"CX Agent | inbound msg | standard | sends within journey policy".

Until now an inbound message got an AI reply in only two ways, and neither was
a sent AI answer:

- The cron sweep (`sweepConversationDrafts`) wrote a *draft* on the next tick,
  5 to 15 minutes later.
- The knowledge base could deflect with an article.

`orbit.message.received` was already emitted. SIGNAL's response tracker and
journeys consumed it; no reply did.

CLAUDE.md sets the constraints:

- Rule 4: an outbound send is consequential.
- Rule 6: events over calls.
- Rule 11: never auto-send outside autonomy policy.
- Rule 15: build to the `AutonomyEnvelope` seam.

## Decision

1. **One consumer.** `onInboundMessage` (`apps/api/src/engines/orbit-auto-reply.ts`)
   is the consumer of `orbit.message.received`, under the consumer name
   `orbit.auto_reply`. It answers a message only when all of these hold:
   - the conversation is still on the bot (`state = "bot"`), so nothing
     answers over a person;
   - the message is still the newest in the conversation. A deflection, a
     human reply or a later message means it is no longer the question;
   - the tenant's `service` agent exists and is active.
2. **Two switches, both required.** The reply is *sent* only when both hold:
   - the agent's own autonomy is `act_within_limits` or `autonomous`
     (`autonomyPermitsSend`, on the `AGENT_AUTONOMY` ladder; any value not on
     the ladder fails closed). Raising autonomy is itself dual-controlled
     (`ai.autonomy_raise`);
   - the tenant has the new approval policy `orbit.ai_reply` on its
     `auto_approve` allowlist. The send still calls `gate()`, which honours the
     allowlist and writes `core.approval.auto`. The engine calls `gate()` only
     after both switches say yes: a pending approval would have nothing to
     release, because the draft already has its own approve/discard path.

   The seed leaves `service` at `suggest`, so no tenant sends until an
   administrator changes both switches.
3. **Otherwise it drafts, now.** If either switch is off, the same reply is
   written as the pending draft the sweep would have written (a background
   draft, docs/15 §4.3). It is written immediately rather than on the next tick.
4. **A stricter gate before a send.** `checkAutoReply` (`packages/core`) runs
   before any send. It is scored by `packages/model-gateway/evals/orbit-auto-reply`
   (recall 1.0, false-positive rate 0). A reply is refused if it:
   - is empty or longer than 1200 characters;
   - is not written in the conversation's language;
   - states a number the context lines do not contain (the same groundedness
     floor as the draft);
   - claims an action was completed, in English or Arabic. The replier has no
     tool that acts, so such a claim is false by construction;
   - fails the guarantee/superlative pre-flight that SIGNAL creatives pass.

   A call carrying any guardrail flag other than `pii_*` or
   `provider_fallback` is held too. Anything held, including a send that throws
   (consent withdrawn, connector down, provider error), falls back to a draft.
   The run's `evidenceJson` records `delivery` and `held`.
5. **The existing outbound path.** The send goes through `dispatchOutbound`, so
   it passes the same consent gate and uses write-after-send.
   `dispatchOutbound` gains an `author` argument, so the row is `agent_ai` and
   carries the model call's `aiAuditId`. The conversation view already renders
   such a row with the ✦ and its "why" (`aiSentNote`). An AI answer does not
   stop the first-response SLA clock, which measures a human response.
6. **Audit.** Each send leaves three records:
   - the model call in `ai_audit_log`, under its own purpose
     `orbit.conversation.auto_reply` (customer-facing);
   - `core.approval.auto` from `gate()`;
   - `orbit.ai_reply.sent`, naming the message, the message it answers, the
     agent and its autonomy level.

   The `ai_runs` row has `trigger: "event"`.
7. **Real time.** The drain reaches the event only on the cron tick, which is
   minutes away. So the webhook (`routes/channels.ts`) runs the same consumer
   after it has answered the provider, through `executionCtx.waitUntil`:
   - it uses the same `consume()` and consumer name, so the drain later sees a
     duplicate, or retries a kick that failed;
   - it runs under the tenant's own policy and entitlements (`scheduledConfig`),
     because the webhook's own context carries a default policy with an empty
     allowlist.

   The consumer's first write is the `ai_runs` row with a fixed id,
   `air_in_<messageId>`. That id is the claim: a second concurrent delivery
   loses on the primary key and answers `claimed`.
8. **Freshness.** A reply to a message older than 30 minutes (`REPLY_WINDOW_MS`)
   is drafted, never sent. By then the conversation may have moved on without
   us.

## Consequences

- **docs/15 §4.** This is not ghost text, which "never auto-sends". It is an L2
  action recorded for the quiet ledger (pattern 9). The row carries the ✦, and
  its "why" is the audit id. docs/15 §4.10 keeps irreversible domains at L1 "by
  design", and a sent message cannot be recalled. This ADR accepts that only
  for a reply that fails every rule in decision 4. Anything that could change
  money or contractual state still goes through the gated ORBIT tools, which
  this replier cannot call.
- **Quiet hours** are not applied. They are a floor on outreach (journeys,
  SIGNAL). This is an answer to a customer who wrote seconds ago, and the human
  reply path does not apply them either.
- **A remaining race.** The cron draft sweep can still draft for a conversation
  whose auto-reply is in flight in the same instant. The result is one
  redundant draft beside a sent reply, never two sends.

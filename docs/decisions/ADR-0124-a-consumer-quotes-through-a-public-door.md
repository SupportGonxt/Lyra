# ADR-0124 — A consumer quotes through a public door that captures its own basis

**Status:** accepted (2026-10-01)
**Supersedes:** nothing. **Amends:** nothing. **Depends on:** ADR-0075 (the market dimension), ADR-0121
(tax identity and the launch market), docs/12 §3 (broker-regulation controls).
**Touches:** `apps/api/src/mw.ts` (the `PUBLIC` allowlist), `apps/api/src/routes/dist.ts`,
`packages/core/src/consent.ts`.

## Context

The client's product is a consumer comparison: a visitor enters their details, sees ranked offers from
several underwriters, and buys online with instant issuance. `docs/modules/dist.md` and the shop engine
already do the hard part — fan-out to the panel, real prices, ranked comparison, disclosure, bind.

**What does not exist is a door for the consumer.** `POST /v1/dist/quote-requests/shop` requires a staff seat
(`dist:quote_requests:create`) *and*, when a customer is identified, a **consent record** — because *"passing
a customer's details to third-party underwriters is data sharing and needs a recorded basis. No consent, no
fan-out"* (`routes/dist.ts:86`).

That is not an obstacle to be worked around; it is the control that makes the platform lawful to operate in
the UAE. So the question is not *how do we let an anonymous visitor shop* — it is **who is the actor, and
where does the basis come from?**

Two wrong answers, both available:

1. **Expose the staff endpoint publicly.** Handing `dist:quote_requests:create` to an anonymous reader. It
   would work on the first request and be indefensible on the second.
2. **Let the visitor shop without consent.** The visitor has not been asked yet, so there is nothing on
   file — and the fan-out shares their details with underwriters the moment it fires. This is the control the
   route exists to enforce.

## Decision

**A public door — `POST /v1/dist/public/quote-start` — that captures its own lawful basis as part of the
request, then calls the same engine.** It sits under `dist` because the engine does, and `public` is in the
path so no reader mistakes it for a staff route.

### The actor

The request is authorised as a **customer-scoped actor**, not staff: `{ kind: "customer" }` with no grants.
It reaches exactly the operations a consumer needs and can never reach a staff operation, because it holds no
permission that names one. Nothing in the platform's RBAC is widened.

### The basis is captured, not assumed

The visitor's consent is created **in the same transaction** as the quote request, with
`source: "web"` and the purposes the form actually presented. This is deliberately not an "implied consent"
shortcut: the route writes a `core_consents` row naming what was agreed, and `announceConsent` fires so the
suppression audience learns about it exactly as it does for an agent-entered consent (docs/30 §2's first
Compliance item).

**A request that does not carry the consent statement is refused.** The field is required, and the refusal
names it — the same shape as the existing `consentId is required when a customer is identified`.

### What the consumer may never see

The comparison strips commission unless the caller is staff (`canSeeMargin`, `routes/dist.ts:170`). A
customer-scoped actor holds no staff permission, so **the margin is stripped by construction rather than by a
branch in this route** — which is the only version of it that will still be true after the next refactor.

### Abuse is bounded at the door, not at the engine

The engine fans out to real underwriters, so a public door is a way to spend the panel's goodwill and the
tenant's money. The route is **rate-limited** with the existing `throttle` helper (`auth.ts:435`), keyed by
the caller's address, before any fan-out.

## Consequences

- **A consumer funnel becomes possible without weakening tenancy, consent or approval.** The two controls the
  route exists to enforce stay enforced; they gain a second, lawful entry point.
- The public surface is **one route**, listed in `mw.ts`'s `PUBLIC` allowlist with a comment saying why —
  which is the same discipline as `/v1/onboarding/partners/signup`, whose own comment explains that an
  anonymous signup must not be handed the power to mint keys.
- **It does not replace the client's front-end.** Per `YALLACOMPARE-COMPARISON.md` §5, a working conversion
  machine is not replaced by a platform programme; this is the API behind it.
- **Not decided here:** whether the consumer surface is a screen in `apps/web` at all, and in which of the
  client's nine markets it opens. The first is a design question with the coverage matrix as its natural
  companion; the second needs them, because a public door in an ungoverned market would quote under a market
  the platform cannot tax (ADR-0121, `operating-model.ts`).

# ADR-0091 — Marketing at three scales: prospects and responses by event

Date: 2026-09-26 · Status: accepted

## Context

The product owner asked for marketing that uses the rest of the system's
insights to make campaigns and content, and stores what comes back at three
scales: broad, niche, and one identified person. Before this, SIGNAL read only
customer tags. It had no idea who had let a quote lapse, whose renewal was at
risk, or who held no contract. The only per-person record was
`signal_outreach`. Replies and receipts landed in ORBIT and never found their
way back to the send. CLAUDE.md rule 6 forbids reading another module's tables,
and docs/27 F62 is already open because NORTH does exactly that.

## Decision

1. **Prospects are written by events and nothing else.** `signal_prospects`
   holds one row per (customer, reason). A new event added `reason` to the
   events that already existed:
   - `dist.quote.expired` gives `quote_expired`. It comes from a new DIST
     sweep: `expired` was a declared quote-request state that nothing wrote.
   - `orbit.renewal.due` gives `churn_risk`. The event now carries
     `churnScore`, and a prospect is recorded only at or above
     `PROSPECT_CHURN_FLOOR = 60`.
   - `core.customers.created` gives `no_policy`. The portal and a stranger
     writing in over a channel now emit it too, as CRUD always did.

   `axis.policy.issued` converts a prospect. Withdrawn marketing consent
   suppresses it, and nothing but the person reopens it. The one read of
   other modules' tables is `backfillProspects`. It runs once, in the resync,
   for the book as it stood before SIGNAL listened. It is seed code (core),
   the same kind of code as the other resync backfills.
2. **A prospect is not permission.** Outreach still applies consent twice,
   quiet hours, the cross-campaign weekly cap and the `signal.outreach_send`
   approval.
3. **Churn risk stays with ORBIT.** Renewal outreach belongs to the journeys.
   An audience rule naming `churn_risk` is refused. The reason is still
   counted in the broad brief.
4. **Niche audiences are rules the resolver can run.** A rule can combine:
   - tags (`tagsJson contains`);
   - a prospect reason (`prospect.reason eq`);
   - a score floor (`prospect.score gte`);
   - suppression's own `consent.marketing eq false`.

   Leaves are intersected under `all` and joined under `any`. Any other rule
   used to resolve to nobody at send time, silently. Now the audiences
   resource refuses it when a person writes it. Stored rules are left alone
   until someone changes the rule itself. The 500 cap is gone: the resolver
   pages, and consent lookups are chunked under D1's parameter limit.
5. **Individual content is written from one fact.** The draft sees one line
   of evidence: the person's newest reason, in words, with its date. It sees
   nothing else from the prospect row, and nothing about anyone else. The
   draft must pass `checkOutreachDraft` (core), which checks groundedness and
   runs the compliance pre-flight. The engine's own comment had promised the
   groundedness half, but it never ran. This is eval-first:
   `evals/outreach-draft`.
6. **The broad brief argues from counts.** The campaign plan's evidence gains
   prospect counts per reason. It never names a person.
7. **One response table, three groupings.** `signal_responses` rows name the
   campaign, the audience and the person. Each send writes a `lead` row, which
   is the denominator. The other kinds come from:
   - `delivered` and `read`: the new `orbit.message.status` event, matched on
     the provider message id;
   - `replied`: the new `orbit.message.received` event, matched on the
     conversation the send now records, within 14 days;
   - `bind`: the existing loop-back;
   - `opted_out`: a consent withdrawal within 14 days of a send.

   The table has one row per kind per send, so a redelivered receipt counts
   once. `GET /v1/signal/responses/rollup?level=campaign|audience|customer`
   and the cockpit panel read it.

## Consequences

- The resync (`POST /v1/auth/demo/resync-roles`) must run after deploy, so
  that a tenant provisioned earlier gets its prospects (`prospects` in the
  response).
- There is no `quote_abandoned` reason. Nothing in the system knows that a
  shop was abandoned rather than simply left to expire.
- Prospects are deterministic, not AI output, so their tab carries no ✦. The
  ✦ stays on the draft, where the model wrote something.
- Seeded demo data has no responses until outreach actually sends. The panel
  says so rather than showing invented numbers.

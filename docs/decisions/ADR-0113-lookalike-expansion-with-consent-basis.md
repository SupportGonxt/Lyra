# ADR-0113 — Lookalike expansion scores on pack axes and keeps the strictest consent basis

Date: 2026-09-28 · Status: accepted

Context: docs/17 §SIG-028 (lookalike expansion with consent basis preserved),
§SIG-034 (protected attributes excluded from targeting and scoring models),
§SIG-026 (suppression always applied); docs/modules/signal.md §2.2; ADR-0069,
ADR-0071 (targeting axes are the domain pack's), ADR-0091 (audience rules the
resolver can run), ADR-0100 (the ad-platform seam).

## Context

SIGNAL could build an audience from a rule (tags, prospect reason, prospect
score; ADR-0091) or from an AI-proposed pool over k-anonymous counts
(SIG-025). It could not grow an audience into the people who resemble it.
docs/modules/signal.md §2.2 names "lookalike scoring via embeddings". It does
not say which people may be scored, what the result may be used for, or how
SIG-034 holds for a scoring model.

## Decision

1. **Similarity is share-weighted overlap on the pack's targetable axes, not
   an embedding.** `seedProfile` (`packages/core/src/lookalike.ts:113`) counts
   the seed's `axis:value` cells through `countAttributes`, and drops any cell
   under the tenant's k-anonymity floor. `similarity` (`:130`) scores a person
   0..1000: for each profile axis, the share of the seed that carries the
   person's best value on it, averaged over the axes. Each member row keeps
   the cells it matched, which is the per-person "why".
   - Why not embeddings: an embedding over a person's attributes can bring a
     protected attribute back through a correlated one, and no test could show
     that it did not. Overlap on declared axes can be shown. Axes come from
     the pack (ADR-0069), and `PROTECTED_AXES`
     (`packages/core/src/targeting.ts:55`) is removed before any cell exists.
     `lookalike.test.ts` proves two things. Adding every protected tag to a
     person never changes their score. A seed that shares a protected axis
     yields exactly the members a clean seed would.
   - docs/modules/signal.md §2.2 is updated to say this.
2. **Only people who consented to marketing and profiling are read or
   returned.** `LOOKALIKE_PURPOSES` (`lookalike.ts:34`) applies to both sides:
   - a seed member without both purposes is not read into the profile;
   - a candidate without both is not scored. A similarity score is profiling.
   An expired consent row grants nothing. This is the same rule as
   `currentConsent` in `packages/core/src/consent.ts`, applied to the whole
   book at once in `apps/api/src/engines/signal-consent.ts`.
3. **Suppression always applies, and the seed is never returned.** Candidates
   are skipped when they are erased (`deletedAt`), are on SIGNAL's suppression
   (a prospect in state `suppressed`), or are in the seed. Every exclusion is
   counted by reason and stored on the audience's definition.
4. **The new audience inherits the strictest basis its members share.**
   `consentBasis` (`lookalike.ts:98`) is the intersection of the purposes the
   *returned* members granted. It is written to `consentPurposes`, for
   example `marketing,profiling,dataSharing`. Three rules protect it:
   - The audiences resource refuses any edit to it
     (`lookalikeWriteProblem`, `apps/api/src/engines/signal-lookalike.ts:167`).
   - It refuses a hand-written lookalike rule, because only expansion fills
     the member table.
   - The outreach resolver re-checks every member against *current* consent
     at send time (`lookalikeMemberIds`,
     `apps/api/src/engines/signal-outreach.ts:250`). A member who withdraws a
     purpose after the expansion drops out from then on.
5. **Membership is a snapshot table.** A ranked top-N cannot be written as a
   rule over tags. `signal_audience_members` (migration `signal_lookalikes`)
   holds one row per member with its score and matched cells. The audience's
   rule is the single leaf `lookalike.member eq true`, which
   `audienceRuleProblem` accepts. Lookalikes use `refreshPolicy: manual`: to
   refresh one, expand the seed again.
6. **Refusals, not degraded output.** Each of these is a 409:
   - fewer consented seed members than the floor, because that profile
     describes a handful of named people;
   - no shared cell at or above the floor;
   - nobody alike.
   `size` is 1..5000 and is never clamped. The seed can be any audience the
   resolver runs, including another lookalike.
7. **Surface.** The route is `POST /v1/signal/audiences/:id/lookalike`
   (`signal:audiences:create`). It is not consequential: an audience is a
   definition, and a send still passes consent and `signal.outreach_send`.
   - On the web it is a declared record action on the audiences tab, labelled
     "Expand as lookalike". It takes a size, and its hint states the consent
     rule.
   - A new generic `ActionSpec.opensCreated` makes the record screen open the
     audience the API answered with. Its size and consent purposes are that
     record's own columns.
   - The action is audited and emitted as `signal.audience.expanded`.
   - The result is deterministic, not model output, so it carries no ✦.

## Not built: pushing a seed to an ad platform's lookalike

The optional second tier sends a seed's hashed identifiers to a platform's
custom-audience API (Google Customer Match, Meta custom audiences) so the
platform builds its own lookalike. It was **not** built. The consent rule is
decided here so the build does not have to reopen it:
- a member is exported only when their current consent covers
  `marketing`, `profiling`, `dataSharing` (a third party receives the data)
  and `crossBorder` (both platforms process outside the tenant's region);
- the export is refused with that reason when fewer than the floor qualify.

The `AdPlatform` seam (`packages/core/src/seams.ts`) gains a method for it only
when an adapter implements it. A declared method with no adapter would be a
dead seam.

## Consequences

- The book is read in full on each expansion: every customer's tags, every
  consent row, every suppressed prospect. That is O(book) in the worker, the
  same trade `refreshSuppressionAudience` and `attributeCounts` already make.
  The upgrade path is a materialised latest-consent table.
- A customer tagged only on non-pack axes (`vip`, `portal-lead`) can never be
  a lookalike. That is correct under SIG-034, but it means a tenant that has
  not tagged pack axes gets `no_profile`.
- Equal axis weights are a simplification. A learned weight per axis would go
  inside `similarity`, fed only cells that `seedProfile` has already
  filtered.
- Rows written to `signal_audience_members` are not removed when a customer
  is erased, but the resolver joins on `deletedAt` and never returns them.
  The erasure engine (`compliance-erasure.ts`) does not yet sweep SIGNAL
  tables. That gap existed before this change and is shared with
  `signal_outreach`.

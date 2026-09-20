# ADR-0084 — Tiered rates, volume bonuses and overrides are one reserved column, not three

**Date:** 2026-09-20
**Status:** Accepted
**Builds on:** docs/16 (build to the seams), CLAUDE.md §15, `packages/core/src/commission.ts`
**Closes:** docs/27-feature-gap-register.md P2 "Commission is flat-rate only"

## Context

`splitCommission` and `quoteCommission` (`packages/core/src/commission.ts`) took
exactly one shape of rate: a flat `baseCommissionPpm` applied to the whole
premium. Three real-world shapes were missing, all named in docs/27:

- **Ladders/tiers** — different rate bands over cumulative premium or volume
  (10% on the first 100k, 12% above).
- **Volume bonuses** — an extra rate once a producer crosses a cumulative
  volume threshold in a period.
- **Overrides** — a second party (an agency principal over a sub-agent)
  earning a percentage on top of the base commission for business under them.

`dist_commission_rates` is the effective-dated row `resolveRate` already picks
the most specific of (docs comment at the top of `packages/db/src/schema/dist.ts`
§commissionRates). Extending it is the natural seam: a new column beside
`baseCommissionPpm`, not a parallel rates table, because resolution (channel >
offering > product > line, most-specific-wins, effective-dated) already applies
to whichever row wins and would otherwise have to be re-implemented for a
second table.

## Decision

One nullable column, `dist_commission_rates.structure_json`:

```ts
{
  tiers?: { uptoMinor?: number; ratePpm: number }[]; // last tier omits uptoMinor (open-ended)
  volumeBonus?: { priorVolumeMinor: number; thresholdMinor: number; bonusPpm: number };
  overridePpm?: number;
}
```

Null (the default, and every row before this ADR) means "flat" — exactly the
one case the code handled before. `commissionStructureOf` parses it
defensively (a malformed value is `{}`, never a throw at read time — a rate
resolves, it does not 500 a quote).

Three pure functions carry the arithmetic, all in `packages/core/src/commission.ts`
beside `splitCommission` they extend:

- `tieredCommissionMinor(amountMinor, tiers)` — bands from zero, each rounded
  with the same round-half-up `applyPpm` every other commission figure uses.
  The last tier must be open-ended (no `uptoMinor`); a ladder that does not
  cover the full amount is refused rather than silently under-crediting the
  tail.
- `volumeBonusMinor(amountMinor, bonus)` — the bonus rate applies only to the
  slice of *this* sale that falls above `priorVolumeMinor + amountMinor >
  thresholdMinor`, so a sale that alone crosses the threshold is not bonused
  in full and one that was already over it before this sale is bonused in
  full.
- `splitCommission` takes `tiers` and `volumeBonus` as optional fields
  alongside the existing `baseCommissionPpm`; when `tiers` is given it
  replaces the flat rate for computing the gross, and `volumeBonus`'s result
  is added on top and reported separately as `bonusMinor` (included in
  `grossMinor`, so a channel's percentage share still applies to it).
  `override` is reported as `overrideMinor`, ppm of `grossMinor`, and is
  **not** subtracted from `netMinor` — CLAUDE.md's own three-way split
  (underwriter → us → channel) is unchanged; the override is a fourth party's
  claim on the same gross, for a settlement to post as its own line, not a
  silent reduction of what the existing two parties already agreed to.

`quoteCommission` resolves `structureJson` off whichever rate row wins
(same specificity order as `baseCommissionPpm` today) and passes `tiers`/
`override` through automatically. `volumeBonus.priorVolumeMinor` stays
**caller-supplied**: computing the true cumulative volume already sold in a
period is a period-aggregation query (docs/27's settlement engine already has
one shape of this in `settlementEntries`), and duplicating it inside a
per-sale quote would be a second, divergent source of the same number. A
caller that knows the period total (a nightly job, a settlement run) passes
it; one that does not gets `bonusMinor: 0`, never a silently wrong bonus.

## Consequences

- Every existing row (`structureJson: null`) and every existing call site is
  unaffected — `splitCommission`'s existing tests, which never pass `tiers` or
  `volumeBonus`, are byte-for-byte the same after this change.
- A ladder or override is configured the same way a plain rate is today: a new
  `dist_commission_rates` row, effective-dated, most-specific-wins. No new
  admin surface in this pass — docs/22 gets a note that the CRUD form's
  `structureJson` field is JSON until a dedicated ladder editor is designed.
- Reserved for the future, per docs/16: `overridePpm`'s *recipient* (which
  party, on which account) is not modelled here — this ADR computes the
  amount; posting it is a settlement-engine decision for whoever wires an
  override-settlement kind, the same way `channelMinor`'s recipient is the
  channel already resolved by `resolveRate`.

# ADR-0128 — A contract records the market it was placed in

**Status:** accepted (2026-10-01)
**Depends on:** ADR-0075 (the market dimension), ADR-0121 (tax identity), ADR-0125 (the authorisation register).
**Touches:** `packages/db/migrations/0055_numerous_tag.sql` (was `0059_policy_market.sql`), `packages/db/src/schema/axis.ts`,
`apps/api/src/routes/axis.ts`.

## Context

Two findings met here.

**The AXIS one:** `axis_policies` could place a risk anywhere and record **nowhere** which market it was
placed under. A broker licensed in nine MENA markets cannot answer *any* per-market question from its own
book — not the regulator, not the tax jurisdiction, not the money.

**The NORTH one:** `gwp` summed every policy regardless of currency and the screen rendered the total as
*"AED 1,234,567.00"*, while an adjacent commission reader *dropped* every non-AED row. Filtering to the
functional currency made that figure **true** (item 4's first half) but not **complete**: an executive still
cannot see the markets she is not being shown. The cut that would show her needs a market on the row, and the
row does not have one.

Currency is not a substitute. `AED` is a currency, not a market, and USD policies are written in every one of
the nine.

## Decision

**`axis_policies.market` — nullable — written at bind from `taxMarketOf(ctx)`.**

### Three choices inside that

1. **Nullable, with no default.** A `NOT NULL DEFAULT 'AE'` would write an invented market onto every existing
   row. That is precisely the failure ADR-0121's `taxMarketOf` had to be corrected for: it answered `AE` for a
   tenant that had stated nothing, so six of the client's nine countries would have had UAE treatment applied
   silently. A contract with no market on file is a **fact** — *"we do not know where this was written"* — and
   a default would look like a fact and be wrong.
2. **Written from the same statement the licence check reads.** `enforceAuthorisation` asks
   `taxMarketOf(ctx)` whether a licence covers the placement; the bind now stamps the same value on the policy.
   The licence that permitted the placement and the market recorded on it therefore **cannot disagree**, which
   is a property of the code rather than a convention someone has to maintain.
3. **A column, not a dimension derived at read time.** The alternative was to infer the market from the
   currency or from the authorisation register at query time; both are inferences, and an executive figure
   built on an inference cannot be defended. The fact belongs on the row.

## Consequences

- **Item 4's per-market cut becomes possible**: `gwp` and the other money metrics can slice by the policy's
  own market using the `dimsJson`/`dimsHash` capacity that already exists (`north_snapshots`), rather than by
  currency as a proxy. **That work is not done here** — this ADR supplies the fact it needs.
- Existing rows keep a null market; a metric cut by market must therefore have a **named** bucket for
  *"market not recorded"* rather than dropping them, or the cut reintroduces the incompleteness it exists to
  fix. That is a requirement on the next change, recorded here so it is not discovered later.
- A per-market figure becomes answerable for tax (`taxMarket` on the tenant) and for trading (the market on
  the contract) as two separate statements, which is the distinction a nine-country broker needs and a
  one-market one never notices.

## Note on migration numbers (2026-10-16)

This record named a migration file that **no longer exists**. Six migrations — 0055 to 0060 — were hand-written
and **never entered drizzle's journal**, so `drizzle-kit migrate` skipped all of them while unit tests, which
execute every `.sql` directly, passed. CI found it: the e2e setup died with
`SqliteError: table ledger_accounts has no column named client_money_pair`.

They are now one generated, journaled migration, **`0055_numerous_tag.sql`**, carrying their schema changes and
the data backfill. The decisions recorded here are unchanged; only the artefact that implements them moved. See
`MODULE-AUDIT.md` §58.

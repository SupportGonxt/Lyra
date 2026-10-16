# ADR-0127 — A coverage gap and a coverage term are two facts, not one column

**Status:** accepted (2026-10-01)
**Note:** renumbered from 0126 — a concurrent change to the ledger claimed that number first, and
its migration cites it. The number is a filename; the decision is the content.
**Supersedes:** nothing. **Amends:** nothing. **Depends on:** ADR-0095 (the coverage comparison basis).
**Touches:** `packages/core/src/bench.ts`, `packages/core/src/coverage.ts` (new),
`apps/api/src/engines/scout-bench.ts`, `apps/api/src/engines/scout-wording.ts`,
`apps/api/src/engines/party-portals.ts`, `apps/api/src/routes/scout.ts`,
`apps/api/src/engines/export/negotiation-pack.ts`, `apps/web/app/routes/scout.shared.ts`,
`apps/web/app/routes/scout-panel.tsx`, `apps/web/app/routes/portal.$tenantSlug.suppliers.$id.tsx`.

## Context

`scout_panel_bench.coverage_gaps_json` is one column carrying **two different facts in four different
shapes**, written by two producers and read by four readers that each guessed:

| Producer | Writes |
|---|---|
| `bench.ts` `CoverageGaps` (`scout-bench.ts:92`) | `{ unquotedRequests: number, declined: number }` — an object of **counts** |
| `seed/scout.ts:452` | an **array** of term objects: `{ term, ours: false, panelMedian: true, note }` — **booleans** |
| `seed/scout.ts:454` | an array again, but `{ term, oursMinor: 50000, panelMedianMinor: 100000, note }` — **money** |

Readers, each assuming something different:

- `scout.shared.ts:219` — `asJson<unknown[]>(row.coverageGapsJson, []).length` **assumes an array**. Against
  the builder's object `.length` is `undefined`, so the reduce yields **`NaN`**, which is what the panel
  screen renders for "Wording gaps" the moment the nightly Bench Builder rewrites a cell.
- `party-portals.ts:25-33` — `parseArray` keeps only **strings**, so both real shapes parse to `[]` and the
  supplier portal renders **"None"** for every carrier.
- `routes/scout.ts:378-389` — the negotiation pack's select **omits the column entirely**, so the pack the
  screen advertises as carrying "the wording gaps" has no such column.
- `scout-data-product.ts:186-196` — refuses any source but `dist_quote_requests`, so the seeded
  *"Motor coverage-gap map"* product **cannot be delivered by its own deliver route**.

The rows already in every tenant's database are in all four shapes. That is the constraint that decides the
answer.

## Decision

**Split the two facts, give each one shape, and route every reader through one accessor that tolerates what
is already stored.**

```ts
type Coverage =
  | { kind: "reach"; unquotedRequests: number; declined: number }
  | { kind: "terms"; terms: CoverageTerm[] };

interface CoverageTerm {
  term: string;
  /** Our position, and the panel's, in the *same* units — see below. */
  ours: CoverPosition;
  panelMedian: CoverPosition;
  note?: string;
  /** Set only when a wording diff produced this term (ADR-0123). */
  changedAt?: number;
  direction?: "added" | "removed";
}
```

### Four decisions inside that

1. **`kind` discriminates, so a reader cannot read the wrong fact by accident.** "The panel did not answer us
   on this line" and "our wording differs on this term" are not the same claim, and a column that holds both
   is how a count came to be read as a list.
2. **A term's position is a term, not a boolean or a number.** The seed's two shapes disagree about whether
   `ours` is `false` or `50_000` — a coverage position can be *absent*, *included*, *worse than the median*,
   *better*, or *a stated figure*. One shape: `{ present: boolean; minor?: number; note?: string }`. The
   money and the boolean were never alternatives; the boolean was a lossy encoding of the money.
3. **`coverageOf(json)` normalises on read, including the legacy shapes.** Every reader routes through it, and
   it maps all four historical forms to the union — the builder's object → `reach`, an array of booleans →
   `terms` with `present`, an array of `*Minor` → `terms` with `minor`. **A row written last month renders
   correctly without a migration**, because the alternative is a data migration that has to guess at shapes
   nobody documented.
4. **Every reader is changed in the same commit**, because a seam is only a seam if the callers route through
   it. `scout.shared.ts`, `party-portals.ts`, the negotiation pack and the data-product refusal all move to
   `coverageOf`, and a test asserts no file reads `coverageGapsJson` directly except the accessor.

## Consequences

- The panel screen stops rendering `NaN`, the supplier portal stops rendering "None", the negotiation pack
  gains the column its own copy already promises, and the data product either gains a builder or is refused
  **where it is listed** rather than when Deliver is pressed.
- `scout-wording.ts` — built under ADR-0123 and **called by no screen** — becomes one of the two producers
  it was always meant to be: a diff's terms land on the affected bench rows.
- The column keeps its name. Renaming it would be cleaner and would break every stored row's home for no
  reader's benefit; the contract lives in the type and the accessor, which is where a reader looks.
- **Not decided here:** whether the panel benchmark should be exportable as a data product at all (that is
  `scout-data-product.ts`'s refusal list, a commercial decision), and whether a coverage term should carry
  the wording span it came from (it should, once the matrix in `PLATFORM-ENHANCEMENT-STRATEGY.md` §2 exists).

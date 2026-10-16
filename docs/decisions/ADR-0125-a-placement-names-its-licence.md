# ADR-0125 — A placement names the market and the licence it was made under

**Status:** accepted (2026-10-15)
**Supersedes:** nothing. **Amends:** nothing. **Touches:** `axis_authorisations`
(migration `0057_tenant_authorisations`), `packages/core/src/operating-model.ts`,
`packages/core/src/rbac.ts`, `packages/core/src/seed/authorisations.ts`,
`apps/api/src/resources.ts`, `apps/api/src/routes/axis.ts`,
`apps/web/app/modules/axis.ts`, `packages/sdk/src/generated.ts` (regenerated),
`ui.md` §1/§7.1.

## Context

`packages/core/src/operating-model.ts` holds the operating model the client
actually runs: nine markets they operate in, `MARKETS` (`:50`) with the one
launch market `AE`, and `REGULATORS` (`:123`) with the two licence numbers they
publish — the UAE Central Bank's `"20"` and the DHA's `"BRK-00045"`. It was a
dead seam in the exact shape CLAUDE.md calls the recurring defect: **no route,
engine or screen read it.** Its only caller was its own test
(`operating-model.test.ts`), and `regulatorsForProductLine` (`:148`) — the join
between a product line and the licence that carries it — could only ever be
called with a key no route held.

The consequence is a compliance fact the platform could not state. AXIS binds a
policy (`apps/api/src/routes/axis.ts` `bindPolicy`, `:864`), asserts the state
transition, the underwriting authority and the sanctions screen, writes a BIND
transaction and emits `axis.policy.issued` — and records nowhere which market or
which licence the risk was placed under. A broker licensed in nine countries
could place a risk in any of them with the platform indifferent.

Two questions had no home, and they are different questions:

1. **What does the platform know?** Which markets exist, which regulator
   licenses which, what number it issued, what each licence is for. That is
   `operating-model.ts`, and it is the client's own statement.
2. **What does *this tenant* hold?** A platform-wide `REGULATORS` entry says the
   client publishes a number somewhere; it does not say the tenant operating in
   front of us is licensed for this class of business today. Those are different
   claims, and conflating them is how a licensed-in-one-market broker gets to
   place a risk in nine.

## Decision

### 1. The tenant-owned half is a table: `axis_authorisations`

`packages/db/src/schema/axis.ts:736`, migration
`packages/db/migrations/0055_numerous_tag.sql` (was `0057_tenant_authorisations.sql`). One row is one licence
the tenant holds: `market` (ISO alpha-2), `regulatorKey`, `licenceNumber`,
`scope`, `productLinesJson`, `validFrom`, `validTo` (nullable),
`evidenceFileId` (nullable), `status` (`active|suspended|expired`).

`licenceNumber` is `NOT NULL`. A row without a number is not an authorisation —
the register's whole purpose is to name the licence — and CLAUDE.md's guardrail
("do not invent regulatory claims") is better served by a seed that skips a
regulator with `licenceNumber: null` than by a row that says nothing.

`validTo` and `evidenceFileId` are the only nullable columns. Null `validTo`
means **no expiry is on file**, which is not the same as never expiring; the
enforcement treats it as open-ended and a renewal PATCHes it.
`axis_authorisations_licence_uq` (`tenant_id`, `regulator_key`,
`licence_number`) is one row per licence per tenant, so the register cannot
contradict itself about one number.

### 2. `productLinesJson` holds operating-model line keys, and the bridge is explicit

This is the judgement this ADR exists to record. There are two product-line
vocabularies in the tree and nothing joined them:

- `core_products.line` (docs/03) — the **tenant's catalogue**:
  `motor|health|travel|home|life|sme|card|loan|account`
  (`packages/db/src/schema/core.ts:182`).
- `PRODUCT_LINES` (`operating-model.ts:200`) — the **platform's classes of
  business**: `car_insurance`, `health_insurance`, …, `car_loans`; the grain a
  licence is written at and the key `regulatorsForProductLine` takes.

The register stores the class of business (`ProductLineKey`), because that is
what a licence covers and because it lets the seed **derive** each regulator's
covered lines from `regulatorsForProductLine` instead of restating them.
`CATALOGUE_PRODUCT_LINES` (`operating-model.ts:239`) and `productLineOf`
(`:248`) are the one bridge, and they cover only the five readings that are
unambiguous: `motor → car_insurance`, `health → health_insurance`,
`travel → travel_insurance`, `home → home_insurance`, `life → life_insurance`.

They deliberately stop there. `sme` is a segment rather than a class;
`card`, `loan` and `account` are lending lines with no class of business on
file. All four answer `null`, and `null` is read by the bind seam as "no licence
can be matched" — a refusal, never a guess. That preserves the same rule
`RegulatorDef.licenceNumber` follows: **absent with a status, not
plausible-looking.** A partial map with no fallback was chosen over a total map
with invented rows.

### 3. `RegulatorDef["scope"]` gains a runtime list

`REGULATOR_SCOPES` (`operating-model.ts:100`) is the runtime source of truth and
`RegulatorScope` is derived from it. A type union cannot validate a write door,
and a hand-typed second list in the API would go stale the first time a scope is
added. `RegulatorDef.scope` (`:108`) now references the derived type, so the
union and the list cannot drift.

### 4. The seed reads the definitions rather than re-typing them

`packages/core/src/seed/authorisations.ts:23`, called from `seed.ts:1738`. For
each `REGULATORS` entry with a number on file it finds the markets whose
`MARKETS[].regulators` names it and derives the covered lines from
`regulatorsForProductLine`. Nothing is re-typed: the two numbers, the scopes and
the market all come off the definitions, so a line whose scope changes moves the
register with it. `validFrom` is the seed clock — the date the platform recorded
it. `REGULATORS` states no effective date and an invented one would be a
regulatory claim.

### 5. The register is generated CRUD, kept by the compliance officer

`apps/api/src/resources.ts:806`, `r("authorisations", …, "aut", "axis",
rw("axis:authorisations"))`, so the permissions are `axis:authorisations:read`
and `axis:authorisations:write` (`rbac.ts:181`). The write door validates what
the column types cannot say (`resources.ts:806-860`): `scope` against
`REGULATOR_SCOPES`, `status` against the three states, the lines against
`PRODUCT_LINES`, at least one line, `validTo` after `validFrom`, and the market
normalised to upper case so a lower-case row is not a licence that exists and
never matches.

Read rides `readsOf("axis")` (`rbac.ts:419`, and again for `axis.lead` at
`:437`), so every AXIS reader — the desk
that must know what it may place under — holds it. **Write is held by
`tenant.compliance` and `axis.admin`** (`rbac.ts:412`): the officer who answers
to the regulator keeps the register, and the desk owner. `axis.lead` may bind
and may not edit the register, which is the separation CLAUDE.md §12 is about;
`tenant.admin` holds the read through `axis:*:read` and not the write.

### 6. The bind seam refuses, and the refusal is named

`enforceAuthorisation` (`routes/axis.ts:806`), called from `bindPolicy`
(`:876`) after `enforceUnderwritingAuthority` and before any money moves. The
market is `taxMarketOf(ctx)` (`tax.ts:87`) — the tenant's own statement, or the
declared launch default (`ADR-0121`) — and the line is the product's own
`core_products.line` through `productLineOf`. A row counts when
`status === "active"`, `validFrom <= now`, and `validTo` is null or in the
future; the covered lines are the row's own `productLinesJson`.

The refusal is a **400 with `code: "authorisation_required"`** and a `reason`
discriminator (`:792`): `none_on_file`, `expired`, `suspended`, `not_yet_valid`,
carrying `market` and `product_line` in the problem body. `expired` is distinct
from `none_on_file` because "we let this lapse" and "we never held this" are
different conversations with a regulator, and the detail names the expiry date.
The check does **not** fall back to `MARKETS[].status`: a market the platform
marks `licensed` says the client holds a licence somewhere, not that this tenant
holds one here.

## Consequences

- A risk can no longer be placed under a market and a class of business the
  tenant has no live licence for, and the refusal says which of the four
  situations it is. This is the feature; the seeded tenant holds both UAE
  licences, so the existing bind paths are unaffected (`apps/api/src/axis-bind.test.ts`).
- The operating model has readers in production code: the seed
  (`REGULATORS`, `MARKETS`, `PRODUCT_LINES`, `regulatorsForProductLine`), the
  resource's validator (`PRODUCT_LINES`, `REGULATOR_SCOPES`) and the seam
  (`productLineOf`).
- **Only the UAE has anything seeded, so every other market's register starts
  empty.** `REGULATORS` carries numbers for two UAE regulators and nothing for
  SA or EG (`operating-model.ts:50-60`), so an SA or EG tenant is refused until it
  registers its own licences through the tab — which the resource permits, and
  which is the behaviour the feature is for. That is the honest state of the
  source: a refusal rather than a silent placement.
- A tenant whose catalogue uses `sme`, `card`, `loan` or `account` cannot bind
  those lines: `productLineOf` answers `null` and the seam refuses with
  `none_on_file` and a detail saying the line is not one the model names. Adding
  a reading to `CATALOGUE_PRODUCT_LINES` is the fix when the product owner
  states what those lines are; guessing it here would have been the invented
  claim this ADR exists to avoid.
- `validFrom` is enforced, so an authorisation recorded with a future start date
  refuses with `not_yet_valid` rather than being ignored.

## What this does NOT do — recorded, not implied

1. **Nothing backfills an existing tenant.** The seed is a provisioning-time
   delivery, which is CLAUDE.md sighting 9's shape exactly: `seed()` refuses a
   second call once the tenant exists (`seed.ts:618`), so a tenant provisioned
   before `0057` holds no authorisation and **its next bind is refused**. The
   existing backfill seam is `POST /v1/auth/demo/resync-roles` — role
   permissions, chart of accounts, demo admin and `ensureSeedPeople` (`10f858f`)
   — which is where the next `ensureSeed…` beside them belongs; this ADR adds the
   register but not the backfill,
   because a backfill has to decide what to do with a tenant that has since
   edited its own rows and that is a separate, deliberate decision.
2. **`bindGroup` is not gated.** `engines/group-commission.ts` binds a group
   scheme without passing through `bindPolicy`, so a group medical placement is
   not checked. Out of scope for this slice and named here so it is not read as
   covered.
3. **The register records an evidence file id and has no upload door.**
   `evidenceFileId` is excused in `spec.form-kinds.test.ts` as "an upload, not a
   pick"; the tab offers it as a typed field, so a certificate reference is
   whatever the officer types. Attaching the licence certificate is a file-upload
   surface this slice does not add.
4. **`scope` is not used by the enforcement.** It is validated and displayed, and
   the seam matches on market and line alone. Two licences of different scopes
   covering the same line would each satisfy the check; making scope
   authoritative needs a product decision about which licence a placement is
   booked against, which is the same question as choosing a regulator per policy.
5. **`MARKETS` does not carry a licence**, so a market declared `ungoverned`
   (`SA`, `EG`) is not distinguishable from one the tenant simply has not
   registered. The register is the answer to the second; the first stays a
   platform statement about the client, not about the tenant.
6. **No screen shows which authorisation a bound policy used.** The policy row
   does not carry the authorisation id, so the enforcement is point-in-time: a
   licence later suspended does not retroactively label the policies bound under
   it. Recording that would be a column on `axis_policies` and a decision about
   re-checking on renewal.

## Verification

`packages/core/src/operating-model.test.ts` (13) — the runtime scope list, the
five catalogue readings and the four `null`s, and that every mapping points at a
line the model knows and has a licence. `packages/core/src/seed/authorisations.test.ts`
(5) — the two numbers and no third, the market and scope taken from the
definitions, the lines derived, and no invented expiry.
`apps/api/src/axis-authorisations.test.ts` (9) — the register as seeded, the
success when a row is live, and the four refusals (`none_on_file`, `expired`,
wrong line, `suspended`), the write door's five rejections, and the 403 for a
seat that is not the compliance officer. The refusal tests were run red against
the seam with the enforcement call removed before landing.

`pnpm --filter @lyra/db test` 36/36, `@lyra/core` 1251/1251, `@lyra/api`
2381/2381, `@lyra/web` 2679/2679, `pnpm typecheck` 9/9,
`pnpm --filter @lyra/web build` clean.

`packages/sdk/src/generated.ts` was regenerated (`pnpm --filter @lyra/sdk
generate`) because this ADR adds API surface, and `sdk.test.ts` holds the
committed file byte-equal to `openapi()`. Its contract test was **already red in
this working tree before this change** — 28 of the 33 operations it reported
missing belong to endpoints that exist only in uncommitted work here
(`/v1/signal/brand-kits`, `/v1/north/metric-definitions`, the portal and platform
routes) and are absent from `HEAD`. Regeneration is whole-document, so those 28
came with it; `@lyra/sdk` is now 16/16.

## Note on migration numbers (2026-10-16)

This record named a migration file that **no longer exists**. Six migrations — 0055 to 0060 — were hand-written
and **never entered drizzle's journal**, so `drizzle-kit migrate` skipped all of them while unit tests, which
execute every `.sql` directly, passed. CI found it: the e2e setup died with
`SqliteError: table ledger_accounts has no column named client_money_pair`.

They are now one generated, journaled migration, **`0055_numerous_tag.sql`**, carrying their schema changes and
the data backfill. The decisions recorded here are unchanged; only the artefact that implements them moved. See
`MODULE-AUDIT.md` §58.

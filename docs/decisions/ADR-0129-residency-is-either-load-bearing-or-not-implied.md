# ADR-0129 — Residency: make `dbBinding` load-bearing, or stop implying it

**Status:** **accepted (2026-10-16) — Option B taken: both columns deleted.**
`docs/29-global-launch-readiness.md` §G4 classifies the underlying finding **P0** and states that either outcome
requires an ADR. This is that ADR, and the outcome is recorded at the foot of this file.

**Decision.** `region` and `dbBinding` are removed — from the schema, the create-tenant request, the `me`
response, and the generated SDK type — by generated, journaled migration `0056_shallow_warlock`
(`packages/db/migrations/`). Option A (making `dbBinding` load-bearing in `withTenant`) was not taken: it is a
resolution layer on the one function every query in the product routes through, and **no client contract in hand
requires residency.** `docs/29`'s own framing is explicit that shipping the middle state is worse than either
outcome, and the middle state is what was removed.
**Depends on:** ADR-0010 (the on-prem stack), ADR-0121 (tax identity), ADR-0125 (the authorisation register).
**Touches:** `packages/db/src/schema/core.ts:13-14`, `apps/api/src/routes/me.ts:68`,
`apps/api/src/routes/platform.ts:109`, `packages/sdk/src/generated.ts:1231`.
**Source:** this record adds no regulatory claim of its own. Every legal characterisation below is quoted from
`docs/29` §G4, which is the pack's compliance source (CLAUDE.md: *"Do not invent regulatory claims; compliance copy
comes from docs/12 only"*).

## Context

`core_tenants` carries two residency-shaped columns:

```ts
region: text("region").notNull().default("auto"),
dbBinding: text("db_binding"),
```

**Exactly one line in the product reads either.** `apps/api/src/routes/me.ts:68` returns `region` to the client:

```ts
region: tenant.region,
```

`region` is written once, at tenant creation (`platform.ts:109`, `region: input.region ?? "auto"`). `dbBinding`
appears in the schema, in the generated SDK type (`packages/sdk/src/generated.ts:1231`) — **and nowhere else.** Not
in the seed, not in the tenant creator, not in a query. There is no query router and no binding resolution.

So the platform can **display a residency commitment it does not keep**, and its published SDK advertises a
per-tenant database binding that routes nothing. `docs/29` §G4 states the consequence, and the characterisation is
theirs rather than this record's:

> *"Under GDPR that is the transfer question (Art. 44-49 and the Schrems II transfer impact assessment); under
> India DPDP, PIPL and several Gulf sector rules it is a hard localisation requirement. A tenant told 'your data
> stays in the EU' whose rows sit in the default D1 is a contractual breach and, if it is in a DPA, a notifiable
> one."*

**Why this is in scope for a nine-market launch.** YallaCompare operates across nine MENA markets. The moment a
client's procurement asks *where does our data live*, the honest answer today is a column, not a mechanism — and
`dbBinding` makes the gap worse than a plain absence, because it reads as an implemented capability.

`docs/29` §G4 is explicit that the current state is the worst available:

> *"Two acceptable outcomes, both requiring an ADR: make `dbBinding` load-bearing in `withTenant` so the region
> actually routes, or delete both columns and stop implying the capability. Shipping the current middle state is
> the worst of the three."*

## The two outcomes

### Option A — make `dbBinding` load-bearing

Route tenant data by binding: `withTenant` resolves `tenant.dbBinding` to a database and every query goes through
it, so a tenant's rows physically sit where its `region` says.

- **Buys:** a residency commitment the platform can keep, and a genuine sovereign-deployment story per tenant.
- **Costs:** a resolution layer on the hottest path in the product — every query in every module; a migration
  strategy per binding; a cross-tenant reporting path that NORTH and LEDGER both rely on; and the failure mode
  that a mis-set binding puts a tenant's data somewhere it should not be, silently.
- **Sizing:** not a schema change. It is a change to the one function every query routes through
  (`withTenant`, CLAUDE.md §1), which is the definition of a high-blast-radius edit.

### Option B — delete both columns

Remove `region` and `dbBinding`, and the SDK type with them, so the platform stops implying a capability it does
not have.

- **Buys:** the absence becomes honest. No screen, no SDK field and no `me` response can promise residency the
  platform does not deliver, which is what makes this the **safe** option rather than merely the cheap one.
- **Costs:** removing a documented seam. CLAUDE.md §15 says reserved seams are load-bearing and that removing one
  requires an ADR — this record is that ADR, and **the seam being reserved is not a reason to keep a false
  promise**.
- **Sizing:** a forward-only migration, an SDK regeneration, and the `me.ts` reader. Bounded.

## What this record does not decide

- **Which option.** It records that a choice must be made before any market outside the UAE is sold, and it does
  not presume the answer.
- **Whether residency is a product requirement at all.** If no client contract requires it, Option B is strictly
  better than the status quo and the question is closed cheaply.
- **The adjacent §G4 items**, which are separate work and separately unbuilt: no subprocessor register, no SCC/TIA
  record, **no per-purpose lawful basis field** (`grep lawfulBasis` returns nothing across `packages/`), and
  therefore no Art. 30 record of processing. `core_consents` holds purposes per customer, which is
  **consent-as-basis only** — it cannot express legitimate interest or contractual necessity, which `docs/29` notes
  is what most underwriting processing actually runs on.

## What was done, and how it was verified

```
schema          packages/db/src/schema/core.ts      both columns removed
migration       0056_shallow_warlock.sql            generated, journaled (57 entries)
the only reader apps/api/src/routes/me.ts:68        `region` field removed
the writer      apps/api/src/routes/platform.ts     `region` gone from the body and the insert
seed            packages/core/src/seed.ts           `region: "auto"` removed
SDK             packages/sdk/src/generated.ts       regenerated; `dbBinding` no longer published
```

**Verified by running, against a libsql server that already held the pre-change schema:**

```
drizzle-kit migrate  → [✓] migrations applied successfully!
__drizzle_migrations → 57
region present       → false
db_binding present   → false
```

The migration was **generated, not hand-written** — the lesson from `MODULE-AUDIT.md` §58, where six hand-written
migrations never entered drizzle's journal and the real runner skipped all of them while unit tests passed.

`pnpm typecheck` 0 · `pnpm lint` 0 · `@lyra/api` 2 399 tests · `@lyra/db` 36 tests.

**Reversal, if residency ever becomes a requirement:** restore it as a **working mechanism** and say in a
superseding ADR what enforces it — a region that routes, not a field that displays. One trap the removal leaves
behind: `region` appears in `docs/03-data-model.md`'s column list, which now describes a table that has changed.

## Consequences of leaving it as it was

The status quo is a decision too, and it is the one `docs/29` names as worst: the platform keeps advertising a
capability it does not have, and a client who reads `region` in the API response — or `dbBinding` in the SDK — has
been told something untrue by the product rather than by a person.

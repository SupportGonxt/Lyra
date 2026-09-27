# ADR-0106 — Reinsurance treaties and cessions: proportional, on the tenant's own paper, posted as a payable reclassification

**Date:** 2026-09-27
**Status:** Accepted — with two accounting choices flagged for the product owner (§5)
**Builds on:** docs/19 (§1, §4, §5.1, §7, §11), docs/modules/axis.md, ADR-0083
(chart of accounts is tenant data), docs/27 F14 (premium booked at bind), F15
(open items), CLAUDE.md §4 (human in the loop), §12 (transaction integrity)
**Closes:** docs/30 AXIS 5 — "Reinsurance treaties and cessions (missing)"

## Context

AXIS could bind, endorse, cancel and settle claims on a policy the tenant
underwrites itself (`core_providers.is_internal`, seeded as "GONXT
Underwriting"), but it had no notion of passing part of that risk to a
reinsurer. Nothing described a treaty, nothing computed a cession, and the
ledger had no account a reinsurer's share could land in.

Two facts about the existing ledger shape the decision:

1. **Premium is never revenue here.** `premiumBooked` (packages/ledger
   recipes.ts, docs/27 F14) books gross written premium as Dr 1200 Premium
   Receivable / Cr 2000 Insurer Payable at bind, *also* for internal
   underwriting. The income statement carries commission, not premium.
2. **docs/19 §5.1 has no reinsurance accounts.** The chart is tenant data
   (ADR-0083) seeded from `CHART_OF_ACCOUNTS`; adding a default account is a
   row there plus `syncChartOfAccounts` for tenants already provisioned.

## Decision

### 1. Scope: proportional treaties, on internal underwriting only

Two treaty kinds, `quota_share` and `surplus`, in a new tenant table
`axis_reinsurance_treaties`: reinsurer (a `core_providers` row that is **not**
internal), optional product line (null = every line), currency, the kind's
terms, ceding commission rate, priority, `[effectiveFrom, effectiveTo)` and
`draft|active|closed`.

A cession is made only for a policy whose provider is internal. On another
insurer's paper the premium is theirs and so is its reinsurance; ceding it on
our books would record a transaction we are not party to.

Non-proportional covers (excess of loss, stop loss) are out of scope: they
cede no share of a policy's premium, they price per layer, and they recover
against claims — a different transaction family.

### 2. The arithmetic is pure, in core, in minor units

`packages/core/src/reinsurance.ts` — `planCessions`, `treatyProblem`,
`treatyApplies`, `orderTreaties`:

- **Quota share**: `ceded = ⌊premium × share⌋`; with a per-risk `limitMinor`,
  the share applies to `min(SI, limit)` and the premium follows the ceded sum
  insured proportionally.
- **Surplus**: `cededSI = min(max(SI − retention, 0), lines × retention)`;
  ceded premium is `⌊premium × cededSI ÷ SI⌋`. Excess above capacity stays
  with the cedant.
- **Several treaties** apply in `priority` then `id` order, each to what the
  one before left retained (premium *and* sum insured).
- **Rounding**: every figure is floored; the retained premium is the
  remainder, never its own calculation, so ceded + retained = premium for
  every input. The proportional step runs in BigInt (minor-unit SI × premium
  leaves 2^53 behind). Commission is floored off the ceded premium; the
  reinsurer's payable is the remainder.
- **No sum insured**: a surplus treaty, or a quota share with a limit, cannot
  measure the risk. It cedes nothing and the engine emits
  `axis.reinsurance.unceded` — a risk that may sit above retention uncovered is
  a fact for somebody to act on, not a silent no-op. The sum insured is read
  from the effective version's `termsJson.sumInsuredMinor`, else from the
  rating inputs of the quote the policy was bound from.

`treatyProblem` is the one validator: the planner refuses incoherent terms and
the CRUD `beforeWrite` refuses to store them, checked against the merged row
so a partial PATCH cannot leave a treaty the planner would reject.

### 3. When: on `axis.policy.issued`, idempotent twice over

`engines/axis-reinsurance.ts` consumes `axis.policy.issued` (dispatch.ts,
AXIS on). One row per (policy, treaty) in `axis_reinsurance_cessions` — the
unique index is the one-cession guard — and each posts as an `RI-CEDE`
transaction keyed `axis.cede:{policy}:{treaty}` — the one-posting guard. A
redelivered event, a racing delivery or a manual re-run finds both spent. A
cession snapshots its amounts; a later edit to the treaty changes only future
cessions.

### 4. Posting: `RI-CEDE`, a new recipe, gated

```
RI-CEDE   Dr 2000 Insurer Payable            ceded premium
            Cr 2060 Reinsurance Payable        ceded − ceding commission
            Cr 4097 Reinsurance Ceding Commission   ceding commission
```

- Balanced by construction (the payable leg is the remainder); zero legs are
  dropped like every other recipe; client-money and equity accounts are
  refused even if passed as arguments.
- The 2000 leg carries the bind's own `item: policy:{id}` and counterparty, so
  it nets the open item the bind raised; the 2060/4097 legs carry
  `item: cession:{id}` and the reinsurer as counterparty (`reinsurerDims`).
- Gate: new approval policy `axis.reinsurance_cession`, decided by
  `axis:reinsurance:approve`, dual control above 100,000.00. It is not a payout
  and not client money (nothing leaves the business when a cession is
  booked), so a tenant may put it on its auto-approve allowlist, as docs/19 §7
  allows for a system-derived commission accrual. Otherwise the approval
  pauses the transaction in `validated` and the `axis.approval.decided` (`decide()` announces `${module}.approval.decided`)
  consumer posts it.
- Permissions: `axis:reinsurance:read|write|approve`. `axis.admin` holds all
  three (`axis:*:*`), agents and leads read (`readsOf("axis")`), the finance
  controller reads and approves — the second seat beside the AXIS
  administrator.
- Property tests: RI-CEDE joins the catalogue-wide obligations 1 and 3 (the
  generators fit it), and `packages/ledger/src/reinsurance.test.ts` adds its
  own: every cession balances, debits 2000 by exactly the ceded premium,
  splits it exactly into 2060 + 4097 and never touches client money; across a
  whole plan, what comes off the insurer payable plus what is retained is the
  policy's premium.

### 5. The two accounting choices the product owner should confirm

These are the most conservative choices consistent with docs/19 as written.
Neither can be settled from the docs; both are a product/accounting decision.

**(a) The cession reclassifies a payable; it does not expense premium.** An
insurer reporting under IFRS 17 would show ceded premium as a reinsurance
expense against insurance revenue. This ledger recognises no premium revenue
at all (fact 1 above), so debiting a "premium ceded" expense would put a cost
on the P&L against income that was never there — every cession would read as
a loss. Reclassifying Dr 2000 / Cr 2060 keeps the P&L exactly as honest as it
already is, and the only P&L effect is the ceding commission. **If the tenant
is a licensed insurer that must recognise GWP as revenue, the right fix is
upstream (BIND posting premium revenue for internal underwriting), and RI-CEDE
then becomes Dr 5xxx premium ceded / Cr 2060 / Cr 4097.** That is a change to
BIND, not to this recipe, and is not made here.

**(b) Two new default accounts, and the ceding commission is recognised in
full at cession.** `2060 Reinsurance Payable` (liability) and
`4097 Reinsurance Ceding Commission` (income) are added to
`CHART_OF_ACCOUNTS`; `syncChartOfAccounts` backfills them on
`/v1/auth/demo/resync-roles`. The commission is recognised at cession, the same
way CMSN-ACCR recognises commission at bind — not deferred over the cover
period. No tax leg: tax is never inferred in code (docs/19 §5.3) and no
rulepack yet says how a ceding commission is taxed.

## Not built (follow-ups)

- **Settlement with the reinsurer** (Dr 2060 / Cr 1000): a payout, so it needs
  its own type with `payout: true`, `neverAutoApprove`, and a statement — the
  shape of RSHARE-SETL. Nothing pays 2060 down yet.
- **Reversal on cancellation / NTU / endorsement**: `reverseTxn` reverses an
  RI-CEDE correctly (tested), but nothing calls it when a ceded policy is
  cancelled or re-priced. A mid-term premium change does not re-cede.
- **Claims recoveries** from the reinsurer on ceded losses.
- **Bordereaux to the reinsurer**: the cessions table is the data such a
  report would read.
- Domain packs: reinsurance nouns are insurance-only by nature and have no
  retail-pack mapping.

## Consequences

- A tenant underwriting its own product can hold treaties and see, per policy,
  what was ceded, retained and earned in commission, with every figure posted
  through a balanced, idempotent, gated ledger transaction.
- Two tabs on the AXIS workspace: `reinsurance-treaties` (create/edit, search)
  and `reinsurance-cessions` (read-only). ui.md §7.1 counts them.
- `axis_reinsurance_cessions` is read-only over HTTP: a hand-written cession
  would be a hand-written journal without RI-CEDE's gate.

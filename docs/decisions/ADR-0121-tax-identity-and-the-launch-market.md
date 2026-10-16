# ADR-0121 — A tax knows which tax it is, and the market is the UAE

**Status:** accepted (2026-10-01)
**Supersedes:** nothing. **Amends:** ADR-0075 (`policy.taxMarket`), docs/29 G1 and G2.
**Touches:** `ledger_tax_rules`, `ledger_accounts`, `TAX_RULEPACK`, `packages/core/src/tax.ts`,
`packages/core/src/seams.ts`, `packages/ledger/src/recipes.ts`.

## Context

docs/29 G1 recorded that the tree had two tax models and the wrong one won: a rich
`ledger_tax_rules` table (market, code, rate, place of supply, reverse charge, exempt, dated) that
nothing read, and a bare `taxPpm` that everything posted. F17 closed the reachability half —
`packages/core/src/tax.ts` now resolves a rule and **refuses** a supply it has no rule for, and
`TAX_RULEPACK` is the compiled default a tenant is provisioned with.

What survived F17 is the sharper half of G1, and it is a *shape* problem rather than a plumbing one:

> "A single `taxPpm` on a rate table can hold a number but cannot say **which tax it is**."

Three consequences in the code as it stood:

1. Every tax leg credited `2200 Tax Payable` — `commissionAccrual`, `invoiceRaised`, `creditNote`,
   `payout` (`packages/ledger/src/recipes.ts:87,489,537,468`). There is exactly one tax liability in
   the chart (`packages/db/src/chart-of-accounts.ts`), so an insurance premium tax and a VAT are the
   same balance.
2. Egypt levies VAT on general insurance **and** a table levy on the same premium. Two returns, one
   account, and no way to tell the lines apart — which is precisely the market this platform is
   built to expand into after the UAE.
3. G2's recommendation was never taken: a market whose answer is not a row in a table (US sales tax
   is a function of destination, nexus and product class; Brazil layers three taxes on one invoice)
   had nowhere to plug in.

## Decision

### 1. The rule carries a `kind`

`ledger_tax_rules.kind` — `vat | premium_tax | table_tax | stamp_duty | none`, default `vat`
(migration `0051_overjoyed_nomad`). The vocabulary is defined once, in
`packages/db/src/tax-rulepack.ts` (`TAX_KINDS`/`TaxKind`), and imported by the resolver, so a kind the
resolver accepts can never be one the rulepack cannot express.

`TaxTreatment` carries it, and `taxAccountOf(kind)` maps it to the liability the money belongs on:
`vat → 2200`, `premium_tax → 2210`, `table_tax → 2220`. `stamp_duty` and any kind without a
dedicated account share 2200 — the default chart carries an account only where a market this product
ships for needs one, and ADR-0083 already lets a tenant add accounts.

Two accounts were added (`2210 Insurance Premium Tax Payable`, `2220 Table Tax Payable`) and
`syncChartOfAccounts` backfills them into existing tenants the way it always has.

### 2. The liability is the caller's to state

Every tax leg takes an account — `taxAccount` on the commission, invoice and credit-note recipes,
`withholdingAccount` on payout — defaulting to `2200` and validated through the recipe's own schema.
This is deliberately **not** inferred at posting time: only the caller knows which rule produced the
number, and the ledger package's builders stay pure. The args travel through the existing posting
API (`POST /v1/ledger/postings` validates `args` with the recipe schema), so the capability is
reachable the day it ships rather than behind a new endpoint.

### 3. Tax resolution goes through a provider seam

`TaxProvider` in `packages/core/src/seams.ts` (G2's "established place"), with
`TAX_PROVIDERS`/`taxProviderFor` in `packages/core/src/tax.ts`. The table is a provider — always
installed, and what every tenant gets — which is what keeps the seam load-bearing instead of a
declaration nothing calls. A tenant names another one in `policy.taxProvider`, and an unknown key is
**refused** rather than silently falling back to the table: a tenant that installed a US provider and
then lost it must not quietly tax Illinois at the UAE's 5%.

`policy.taxProvider` had to be added to `PolicyJson` to make this reachable at all: zod strips
unknown keys, so a policy naming a provider was being silently dropped. `policy.taxMarket`
(ADR-0075) was already declared and is unchanged.

### 4. The market is the UAE, and the sequence is stated

The launch market is **UAE, AED**, and the compiled rulepack now covers **AE, SA and EG** so the
expansion path is load (a rulepack is data, not a release): KSA at 15%, Egypt at 14% with life cover
outside the charge.

The workspace briefs this work was commissioned from quoted Rand and spelled the business
"Yellacompare"; the code is GCC/AED throughout (`DEFAULT_TAX_MARKET = "AE"`, `policy.currency`
default `AED`, CBUAE/PDPL/Arabic in the compliance rulepacks). The briefs are the drift; the code is
the decision. Egyptian and Saudi rows are therefore seeded as *forward* markets, not as the launch
market.

**The Egyptian table levy's rate is seeded at 1 250 ppm (0.125%) as a shape, not as a statement of
law.** It is the tenant's to confirm against its own adviser before the first Egyptian invoice, and
editing it is a rulepack change. The row exists so that "two levies on one premium" is exercised by
real data rather than only by a test.

## What this does NOT do — recorded, not implied

1. **Nothing resolves a rule and then states the account.** `quoteCommission` returns `taxRuleId`
   (`packages/core/src/commission.ts:364`) and the accrual engine records `taxMinor`
   (`apps/api/src/engines/commission-accrual.ts:104`) — but no caller of `POST /v1/ledger/postings`
   yet passes `taxAccount` from a resolved `kind`. The wiring exists on both ends; the join is not
   made. Until it is, an Egyptian tenant's ledger still needs the account stated by hand.
2. **`taxRuleId` itself is produced and read by nobody.** It is typed
   (`packages/core/src/commission.ts:294`), returned (`:364`) and asserted in a test
   (`packages/core/src/tax.test.ts`) while no production caller reads it — the dead-seam shape this
   repo hunts. Not introduced here; recorded here because this ADR is where a reader will look.
3. **`taxMarket` has no screen.** It is declared in `PolicyJson` (`packages/db/src/json.ts:122`) and
   read by `taxMarketOf` (`packages/core/src/tax.ts`), but it appears nowhere in `apps/web/app`, so
   every tenant is on the UAE default and the jurisdiction dimension is only settable by PATCHing
   the tenant row. The KSA/Egypt rulepacks are therefore loadable but not selectable from the
   product yet.
4. **The platform's own subscription invoices post no tax.** `billing.ts:308,682` build
   `SUB-INVOICE` with `netMinor` alone, so `taxMinor` defaults to 0 on every subscription invoice.
   Unrelated to this ADR and left alone.
5. **US/Brazil are still unmodelled.** The seam is the place to put them; no provider is written,
   and `TAX_PROVIDERS` contains exactly one entry.

## Consequences

- A VAT, an insurance premium tax and a table levy can coexist on one premium and reach three
  different liability accounts, which is the minimum an audit in any of these markets needs.
- A market outside the VAT shape can be added by writing a provider and naming it in policy — with
  no change to `ledger_tax_rules`, which is the point.
- Every existing tenant and every existing posting path is unchanged: the column defaults to `vat`
  and every recipe arg defaults to `2200`.
- The next market is a rulepack row plus, where the shape does not fit, one provider.

## Verification

`packages/core/src/tax.test.ts` (16) — kind resolution, the account map, the unknown-kind default,
and the provider refusal. `packages/ledger/src/tax-account.test.ts` (7) — stated vs default account
on all four legs, and the same through the recipe registry a POST would use.
`packages/db` 29/29, `packages/ledger` 280/280, `packages/core` full suite, `apps/api` 2167/2167.

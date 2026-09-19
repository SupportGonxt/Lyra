# 19 — Transaction Specification & Ledger

Every meaningful thing Lyra does is a **transaction**: an atomic, idempotent,
auditable state change with defined preconditions, side effects, events and a
reversal path. Money-bearing transactions additionally post **double-entry
journal lines**. This document is the transaction contract for the whole
platform — implement it once in `packages/ledger` + `packages/core/txn` and
every module inherits it.

## 1. Principles (invariants — enforced by property tests, §11)

1. **Idempotent by construction.** Every transaction carries a client-supplied
   or system-derived `idempotency_key`. Replay returns the original result and
   posts nothing new.
2. **Immutable history.** Posted journal lines and completed transactions are
   never mutated or deleted. Corrections are new contra transactions that
   reference the original (`reversal_of`).
3. **Double-entry always balances.** Sum of debits equals sum of credits within
   every journal batch, in transaction currency and in tenant base currency.
4. **Money moves only on an approved instruction.** Every outbound movement has
   an approval record; above tenant thresholds the approver must differ from the
   initiator (dual control).
5. **Client money is sacred.** Segregated accounts can never fund operating
   activity. No journal may debit a client-money asset to credit income or
   operating expense.
6. **Events are consequences, not the record.** State lives in the transaction
   and ledger; events notify. Consumers are idempotent.
7. **Sagas over distributed transactions.** Multi-system flows (provider API +
   payment + issuance) are compensating sagas with explicit rollback steps.
8. **Every transaction is explainable.** Actor (human or agent), autonomy level,
   inputs, decision reasoning where AI was involved, and evidence refs are
   retained for the regulatory retention period.
9. **Currency discipline.** Amounts are integer minor units with an explicit
   currency; FX rate and base-currency amount are stamped at posting time.
10. **No silent partial success.** A transaction is `settled` only when all of
    its obligations are complete; anything else is an explicit failure state.

## 2. Transaction envelope (common schema)

```
txn_id            ULID, immutable
tenant_id         required on every transaction
type              catalogue code (§4), e.g. "BIND", "RSHARE-SETL"
version           schema version of this type
idempotency_key   unique per (tenant, type, key); 24h+ retention
correlation_id    saga / business-process grouping
parent_txn_id     for child transactions (instalments, adjustments)
reversal_of       set when this transaction reverses another
state             see §3
actor             {kind: user|agent|partner|system|customer, id, autonomy_level}
subject_refs      {customer_id?, case_id?, policy_id?, partner_id?, campaign_id?...}
currency          ISO-4217; base_currency + fx_rate + base_amount stamped
amounts           {gross, net, tax, fee, commission, share...} minor units
approvals[]       {policy_key, requested_by, decided_by, decision, reason, ts}
ledger_batch_id   set once posted (null for non-financial transactions)
event_ids[]       emitted events
evidence_refs[]   files, statements, screenshots, provider payloads (hashed)
guardrails        {consent_checked, disclosure_presented, sanctions_screened...}
created_at, updated_at, settled_at, failed_at
metadata          type-specific payload (schema-validated)
```

## 3. Canonical state machine

```
initiated → validated → authorized → executing → settled
                │            │           │
                ├────────────┴───────────┴──→ failed  (terminal, reason coded)
                │
                └──→ rejected (precondition/approval denied, terminal)

settled → reversing → reversed        (contra posted, original intact)
settled → adjusting → adjusted        (delta contra + new posting)
executing → pending_external          (awaiting provider/PSP/partner callback)
pending_external → executing | failed | expired
```

Rules: `authorized` requires all `approvals[]` satisfied. `pending_external`
carries a timeout and a compensation step. Only `settled` transactions may be
reversed or adjusted. `failed` and `rejected` never post journal lines.

## 4. Transaction catalogue

Non-financial transactions are marked ⊘ (no journal); all others post.

### 4.1 Distribution lifecycle
| Code | Transaction | Trigger | Money | Approval | Key events |
|---|---|---|---|---|---|
| `QUOTE-REQ` | Quote request captured | intake (web, chat, partner, agent) | ⊘ | none | `axis.case.created` |
| `QUOTE-PANEL` | Panel quoted (fan-out result set) | quoting agent completes | ⊘ | none | `axis.quote.added` |
| `QUOTE-PRESENT` | Ranked offers presented to customer | UI/API render | ⊘ | none | `disclosure.presented` |
| `BIND` | Policy bound & issued | customer accepts + payment authorized | ✓ | policy-gated | `axis.policy.issued` |
| `BIND-GROUP` | Group scheme bound (census-based) | proposal accepted | ✓ | dual control | `axis.policy.issued` |
| `ENDORSE` | Mid-term amendment (MTA) | customer/ops request | ✓ if premium delta | if refund/discount | `axis.policy.endorsed` |
| `CANCEL` | Cancellation (pro-rata or short-period) | request or non-payment | ✓ | dual control if refund | `axis.policy.cancelled` |
| `LAPSE` | Non-renewal / expiry without action | scheduler | ⊘ | none | `orbit.renewal.lost` |
| `REINSTATE` | Policy reinstated after lapse | ops + insurer confirm | ✓ | dual control | `axis.policy.reinstated` |
| `RENEW` | Renewal bound | acceptance of renewal offer | ✓ | policy-gated | `orbit.renewal.accepted` |
| `FNOL-REGISTER` | First notification of loss recorded (guidance only) | customer contact | ⊘ | none | `orbit.fnol.registered` |
| `CLAIM-SYNC` | Claim status mirrored from insurer | provider webhook/poll | ⊘ | none | `claim.status.updated` |
| `PARAM-TRIGGER` | Parametric index condition met (dual-source confirmed) | oracle connectors | ⊘ | none | `product.param.triggered` |

### 4.1b Claims
The claim's own state hops post no journal — a reserve is a memorandum figure,
not a ledger balance. The money legs do: the insurer funds a float, we pay out
of it, and recoveries come back the other way. `CLAIM-PAY` is the one AXIS type
that is both a payout and client money, so no tenant allowlist can make it
auto-approvable (§7).

| Code | Transaction | Trigger | Journal | Approval | Event |
|---|---|---|---|---|---|
| `CLAIM-RESERVE` | Reserve set or moved | handler estimate | ⊘ | above threshold | `axis.claim.reserved` |
| `CLAIM-APPROVE` | Settlement approved | adjuster decision | ⊘ | dual control | `axis.claim.approved` |
| `CLAIM-DECLINE` | Claim declined | adjuster decision | ⊘ | dual control | `axis.claim.declined` |
| `CLAIM-CLOSE` | File closed | no further activity | ⊘ | none | `axis.claim.closed` |
| `CLAIM-REOPEN` | File reopened | new evidence | ⊘ | dual control | `axis.claim.reopened` |
| `CLAIM-FUND` | Insurer funds the claim float | insurer transfer | ✓ | none (client money) | `axis.claim.funded` |
| `CLAIM-PAY` | Payment out of the float | approved settlement | ✓ | dual control, never auto | `axis.claim.paid` |
| `RECOVERY-OPEN` | Recovery pursued | subrogation/salvage identified | ⊘ | none | `axis.claim.recovery_opened` |
| `RECOVERY-RECEIPT` | Third-party money received, gross | counterparty pays | ✓ | none (client money) | `axis.claim.recovery_received` |
| `RECOVERY-FEE` | Handling fee drawn out of client money | follows the receipt | ✓ | none (client money) | — |
| `RECOVERY-REMIT` | Net recovery paid on to the insurer | remittance run | ✓ | none (client money) | — |
| `RECOVERY-WRITEOFF` | Pursuit abandoned | handler decision | ✓ | above threshold | `axis.claim.recovery_written_off` |

A recovery is two transactions, never one. The gross lands in client money
(`1010` Dr / `2010` Cr) and only the transfer out recognises our fee
(`2010` Dr / `1010` Cr / `1000` Dr / `4090` Cr) — §5.2 B and obligation 3 forbid
crediting income in any batch that debits the client-money asset.

### 4.2 Money in
| Code | Transaction | Notes |
|---|---|---|
| `PREM-COLLECT` | Premium received from customer | Client-money entries when broker-collected (§5.B) |
| `PREM-INSTALMENT` | Scheduled instalment received | Child of `PLAN-CREATE`; dunning on failure |
| `DEPOSIT-TAKE` | Deposit / holding payment | Refundable liability until bind or expiry |
| `PSP-SETTLE` | Payment processor settles a batch to us | Clears PSP clearing account; fees recognised |
| `CHARGEBACK` | Card chargeback raised | Reverses collection; opens dispute case |
| `CHARGEBACK-WIN` | Dispute resolved in our favour | Re-posts original economics |

### 4.3 Money out
| Code | Transaction | Notes |
|---|---|---|
| `PREM-REMIT` | Premium remitted to insurer (net of commission) | Client money → insurer payable settled |
| `REFUND-ISSUE` | Refund to customer | Dual control; traces to `CANCEL`/`ENDORSE` |
| `PAYOUT-INSTRUCT` | Payout instruction (e.g. parametric, on-behalf) | Never auto-approved above threshold |
| `RSHARE-SETL` | Partner revenue-share settlement | Batch, statement attached |
| `CREATOR-PAYOUT` | Creator/influencer payment | Deliverable-verified |
| `SUPPLIER-PAY` | Media/supplier invoice payment | Matches `MEDIA-SPEND` accruals |

### 4.4 Earnings & accruals
| Code | Transaction | Notes |
|---|---|---|
| `CMSN-ACCR` | Commission earned (accrual at bind/renew) | Receivable from insurer |
| `CMSN-SETL` | Commission received per insurer statement | Reconciled, variances flagged |
| `CMSN-CLAWBACK` | Commission reversed (early cancellation) | Contra; never edits original |
| `FEE-BROK` | Brokerage/advisory fee earned | Group & SME lines |
| `FEE-SERVICE` | Service/concierge fee earned | Guidance services only |
| `REFERRAL-QUAL` | Referral qualified (lead/approval event) | Per partner definition |
| `REFERRAL-SETL` | Referral revenue settled | Statement reconciliation |
| `FIN-CMSN` | Financing commission earned | From financier |
| `RSHARE-ACCR` | Partner share accrued on a bind | Expense + payable |
| `AD-PLACEMENT` | Sponsored placement revenue earned | Requires `DISCLOSURE-PRESENT` |
| `SURPLUS-DIST` | Takaful surplus distribution recorded | Structure-specific |

### 4.5 Subscriptions, usage & platform billing
| Code | Transaction | Notes |
|---|---|---|
| `SUB-CREATE` | Subscription created (whitelabel, membership, data product) | Terms, term dates, price book |
| `SUB-INVOICE` | Invoice issued | Deferred revenue + tax |
| `SUB-RECOG` | Revenue recognised for the period | Straight-line or usage-based |
| `SUB-CHANGE` | Upgrade/downgrade with proration | Delta contra + new schedule |
| `SUB-CANCEL` | Subscription cancelled | Recognition stops; refunds if due |
| `USAGE-METER` | Metered usage recorded (API calls, AI tokens, seats, posts, binds) | Feeds overage |
| `OVERAGE` | Overage charge computed | Threshold-based |
| `SUCCESS-FEE` | Success fee computed from a verified metric | **Requires NORTH-verified metric snapshot** |
| `DUNNING` | Dunning step executed on failed payment | Journey-driven, consent-aware |
| `CREDIT-NOTE` | Credit issued | Dual control |

### 4.6 Client money & escrow
| Code | Transaction | Notes |
|---|---|---|
| `CM-RECEIPT` | Receipt into segregated client account | Liability recognised simultaneously |
| `CM-TRANSFER` | Permitted transfer (commission entitlement out) | Only after entitlement crystallises |
| `CM-RECON` | Client-money reconciliation performed | Evidence bundle; variance states |
| `RECON-WRITEOFF` | Residual reconciliation difference written off | Dual control always; **never** touches client money — a shortfall there is `CM-BREACH-FLAG`, not a write-off |
| `CM-BREACH-FLAG` | Segregation shortfall detected | **Hard alarm**, blocks further transfers |

### 4.7 Partner & embedded
| Code | Transaction | Notes |
|---|---|---|
| `PARTNER-ONBOARD` | Partner activated (sandbox → live) | Certification evidence |
| `PARTNER-QUOTE` | Quote served through partner API | ⊘ metered |
| `PARTNER-BIND` | Bind originated by a partner | Attribution + `RSHARE-ACCR` |
| `RSHARE-ADJUST` | Dispute adjustment | Reason-coded, dual control |
| `EXT-INSTALL` | Marketplace extension installed | Scope consent recorded |
| `EXT-RSHARE` | Extension revenue share | Publisher payable |

### 4.8 Marketing & content commerce
| Code | Transaction | Notes |
|---|---|---|
| `MEDIA-COMMIT` | Ad spend committed to a channel | Budget bound check |
| `MEDIA-SPEND` | Actual spend recorded from channel API | Reconciled to invoice |
| `BUDGET-MOVE` | Autonomous or approved reallocation | Within envelope or approved |
| `PUBLISH` | Content published to a channel | ⊘; per-platform result recorded |
| `BOOST` | Organic post promoted (paid) | Spend + attribution |
| `CREATOR-BRIEF` | Creator engagement contracted | Deliverables, disclosure terms |
| `CREATOR-VERIFY` | Deliverable verified | Gates payout |

### 4.9 Data products & AI
| Code | Transaction | Notes |
|---|---|---|
| `DPROD-SUB` | Data-product subscription created | Consent basis recorded |
| `DPROD-DELIVER` | Delivery executed (API/report) | k-anonymity check enforced pre-send |
| `AI-CALL` | Model invocation metered | ⊘ ledger-optional; COGS accrual daily |
| `AI-BUDGET-STOP` | Budget ceiling reached | ⊘ hard stop + alert |

### 4.10 Identity, consent & compliance
| Code | Transaction | Notes |
|---|---|---|
| `CONSENT-GRANT` / `CONSENT-WITHDRAW` | Consent state change | ⊘ immutable ledger row; propagates < 15 min |
| `KYC-VERIFY` | Identity verification performed | ⊘ evidence level recorded |
| `SANCTIONS-SCREEN` | Screening executed | ⊘ hit → case + block |
| `DISCLOSURE-PRESENT` | Required disclosure shown | ⊘ snapshot of criteria/wording |
| `APPROVAL-DECISION` | Approval granted/denied | ⊘ dual-control evidence |
| `DSAR-FULFIL` | Access/erasure request fulfilled | ⊘ completeness proof |
| `AUDIT-EXPORT` | Evidence bundle exported | ⊘ hash manifest |

### 4.11 Agentic commerce
| Code | Transaction | Notes |
|---|---|---|
| `MANDATE-REGISTER` | Delegated authority registered for an AI buyer | Scope, spend cap, expiry, verification |
| `AGENT-QUOTE` | Signed machine-readable offer issued | ⊘ signature retained |
| `AGENT-BIND` | Bind executed under a mandate | Mandate validity + cap enforced |
| `MANDATE-REVOKE` | Mandate revoked | ⊘ immediate effect |

## 5. Ledger design

### 5.1 Chart of accounts (tenant-scoped, extensible)
**Assets** `1000` Cash–Operating · `1010` Cash–Client Money (segregated) ·
`1100` Commission Receivable · `1150` Financier Receivable · `1155` Recovery
Receivable · `1160` Trade Receivable · `1200` Premium Receivable · `1300` PSP
Clearing.
**Liabilities** `2000` Insurer Payable · `2010` Client Money Liability ·
`2100` Partner/Publisher Payable · `2150` Creator Payable · `2200` Tax Payable ·
`2250` Accrued Expenses · `2300` Deferred Revenue · `2350` Customer Deposits ·
`2400` Refunds Payable.
**Income** `4000` Commission–New · `4010` Commission–Renewal · `4020` Brokerage
Fees · `4030` Referral · `4040` Subscription · `4045` Membership · `4050` Usage ·
`4060` Data Products · `4070` Advertising · `4075` Marketplace · `4080`
Financing Commission · `4090` Service Fees.
**Expense / contra** `5000` Commission Clawback (contra-income) · `5100` Media
Spend · `5150` Creator Spend · `5200` AI & Inference COGS · `5300` Payment
Processing Fees · `5400` Partner Revenue Share · `5450` Recovery Written Off ·
`5500` Reconciliation Write-Off (both directions: a residual given up is a
debit, one the counterparty overpaid is a credit, so the period's net
difference is one figure).

### 5.2 Worked entries (the flows that must be exactly right)

**A. Commission-only aggregator (insurer collects premium)**
```
BIND / CMSN-ACCR      Dr 1100 Commission Receivable      1,000
                        Cr 4000 Commission–New              950
                        Cr 2200 Tax Payable                  50
CMSN-SETL             Dr 1000 Cash–Operating             1,000
                        Cr 1100 Commission Receivable     1,000
CMSN-CLAWBACK         Dr 5000 Clawback                     400
(early cancellation)    Cr 1100 Commission Receivable       400
```

**B. Broker collects premium (client money — CBUAE-critical)**
```
CM-RECEIPT            Dr 1010 Cash–Client Money         10,000
                        Cr 2010 Client Money Liability   10,000
PREM-REMIT            Dr 2010 Client Money Liability     9,000
                        Cr 1010 Cash–Client Money         9,000
CM-TRANSFER           Dr 2010 Client Money Liability     1,000
(entitlement crystallised) Cr 1010 Cash–Client Money      1,000
                      Dr 1000 Cash–Operating             1,000
                        Cr 4000 Commission–New              950
                        Cr 2200 Tax Payable                  50
```
> Invariant: `1010` balance ≥ `2010` balance at every instant. Any journal
> debiting `1010` to credit `4xxx`/`5xxx` directly is rejected at post time.

**C. Partner-originated bind with revenue share**
```
PARTNER-BIND/CMSN-ACCR Dr 1100                            1,000
                         Cr 4000                             950
                         Cr 2200                              50
RSHARE-ACCR             Dr 5400 Partner Revenue Share       300
                         Cr 2100 Partner Payable             300
RSHARE-SETL             Dr 2100 Partner Payable             300
                         Cr 1000 Cash–Operating              300
```

**D. Whitelabel subscription + usage overage**
```
SUB-INVOICE           Dr 1160 Trade Receivable          12,600
                        Cr 2300 Deferred Revenue         12,000
                        Cr 2200 Tax Payable                 600
SUB-RECOG (monthly)   Dr 2300 Deferred Revenue           1,000
                        Cr 4040 Subscription Revenue      1,000
OVERAGE               Dr 1160                               210
                        Cr 4050 Usage Revenue               200
                        Cr 2200                              10
```

**E. Premium financing (pay-monthly)**
```
PLAN-CREATE           (no journal; schedule created)
FIN-CMSN              Dr 1150 Financier Receivable         150
                        Cr 4080 Financing Commission        143
                        Cr 2200                               7
PREM-INSTALMENT       Dr 1010 / Cr 2010  (if we collect on behalf)
DUNNING               (⊘ non-financial; may trigger CANCEL)
```

**F. Data product delivery**
```
DPROD-SUB → SUB-INVOICE (as D, income 4060)
DPROD-DELIVER         (⊘ ledger; k-anonymity gate must pass or delivery fails)
```

**G. Media spend & AI cost (unit economics)**
```
MEDIA-SPEND           Dr 5100 Media Spend                5,000
                        Cr 2250 Accrued Expenses          5,000
AI-CALL (daily roll)  Dr 5200 AI & Inference COGS           80
                        Cr 2250 Accrued Expenses              80
```
These two feed cost-per-case / per-conversation / per-brief telemetry (NFR-013).

### 5.3 Multi-currency, tax, periods
- Post in transaction currency; stamp `fx_rate` and base amount. Revaluation job
  for open receivables/payables at period end.
- Tax treatment per market rulepack (`docs/16` H12): rate, place of supply,
  reverse charge, exemption flags. Tax is never inferred in code.
- Periods: open → soft-close (adjustments allowed with reason) → hard-close
  (contra-only). Close checklist in §6.4.

## 6. Reconciliation, settlement & close

| Process | Sources matched | Outputs |
|---|---|---|
| **Insurer statement recon** | `CMSN-ACCR` vs insurer statement lines | matched, variance, missing-both-ways queues; `CMSN-SETL` postings |
| **PSP settlement recon** | `PREM-COLLECT`/`PSP-SETTLE` vs processor payout file | fee recognition, clearing account to zero |
| **Client-money recon** | `1010` bank statement vs `2010` obligations | segregation proof, `CM-BREACH-FLAG` if short |
| **Partner statement recon** | `RSHARE-ACCR` vs partner-reported volumes | disputes → `RSHARE-ADJUST` |
| **Media recon** | `MEDIA-SPEND` vs channel invoices | accrual true-up |
| **Period close** | all of the above + revaluation + recognition | signed close pack, immutable snapshot |

Matching engine: deterministic keys first (policy no., reference), then
tolerance-based amount/date matching, then AI-proposed matches which a human
confirms — proposals are never auto-posted. Match rate is a tracked KPI.

## 7. Approvals, autonomy & money

| Money movement | Default autonomy | Approval |
|---|---|---|
| Commission accrual (system-derived) | L2 | none |
| Refund ≤ tenant threshold | L1 | single approver |
| Refund > threshold, any payout | L1 | dual control, approver ≠ initiator |
| Partner settlement batch | L1 | finance approval + statement attached |
| Budget move within bounds | L2 | none (logged, reversible window) |
| Budget move beyond bounds | L1 | marketing lead approval |
| Client-money transfer | L1 | dual control, always |
| Success fee | L1 | verified metric snapshot + both parties' sign-off |

No transaction type may be added to a tenant's auto-approve allowlist if it
debits client money, issues a payout, or crosses a regulatory floor.

## 8. Sagas & compensation (worked example: `BIND`)

```
1 reserve quote (provider)        ↔ compensate: release reservation
2 authorize payment (PSP)         ↔ compensate: void/refund authorization
3 issue policy (provider)         ↔ compensate: request cancellation
4 post CM-RECEIPT / CMSN-ACCR     ↔ compensate: contra transactions
5 deliver documents (channel)     ↔ compensate: retract + notify
6 emit axis.policy.issued         (idempotent consumers)
```
Rules: steps are individually idempotent; the saga log is durable; a stalled
saga alerts rather than silently expiring; partial success is impossible —
either `settled` or fully compensated with a reason code.

## 9. APIs & events

- `POST /v1/txn/{type}` with `Idempotency-Key`; returns transaction resource.
- `GET /v1/txn/{id}` full envelope incl. journal lines and approvals.
- `POST /v1/txn/{id}/reverse` / `/adjust` with reason code (permissioned).
- `GET /v1/ledger/journal`, `/accounts/{code}/balance`, `/trial-balance`,
  `/recon/{process}`, `/periods/{id}/close`.
- Every transaction emits `txn.{type}.{state}`; ledger emits
  `ledger.batch.posted`. Webhooks carry the same envelopes.

## 10. Transaction UI (see docs/22 for full design)

Ledger Explorer (immutable journal — no edit affordances anywhere), Money Map
(premium in → insurer out → commission retained → partner share), Transaction
Detail (state-machine timeline, journal lines, approvals, evidence, reversal
control), Reconciliation Workbench (statement / system / variance three-pane),
Settlement Runs, Period Close checklist. Money is always shown with currency
and base-currency equivalent; posted entries render in a distinct "sealed"
treatment so immutability is visible, not merely enforced.

## 11. Test obligations (property-based, always-on)

1. Every journal batch balances in both currencies (fuzz all transaction types).
2. `1010` ≥ `2010` after any random sequence of client-money transactions.
3. No journal debits client-money assets to credit income/expense.
4. Replaying any transaction with the same idempotency key posts nothing new.
5. Reversal of any settled transaction returns net-zero economics and leaves the
   original intact.
6. Every payout transaction has an approval with a distinct approver above
   threshold.
7. Random saga interruption at any step ends `settled` or fully compensated.
8. Trial balance equals sum of all journal lines at any point in time.
9. Recognition schedules never recognise more than invoiced.
10. `SUCCESS-FEE` cannot post without a verified metric snapshot reference.
11. A claim float never goes negative — for any claim, Σ `CLAIM-PAY` ≤ Σ
    `CLAIM-FUND` plus opening float, under any random ordering of payments.

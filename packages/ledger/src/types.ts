// docs/19 §2–§4. The transaction envelope, the state machine and the catalogue.
// The catalogue is data, not code paths: a new transaction type is a row here
// plus a recipe in recipes.ts, never a new branch in the engine.

export const TXN_STATES = [
  "initiated",
  "validated",
  "authorized",
  "executing",
  "pending_external",
  "settled",
  "reversing",
  "reversed",
  "adjusting",
  "adjusted",
  "failed",
  "rejected",
  "expired"
] as const;
export type TxnState = (typeof TXN_STATES)[number];

/** docs/19 §3. Anything not listed is rejected — no ad-hoc state jumps. */
export const TRANSITIONS: Record<TxnState, readonly TxnState[]> = {
  initiated: ["validated", "rejected", "failed"],
  validated: ["authorized", "rejected", "failed"],
  authorized: ["executing", "failed", "rejected"],
  executing: ["settled", "pending_external", "failed"],
  pending_external: ["executing", "failed", "expired"],
  settled: ["reversing", "adjusting"],
  reversing: ["reversed", "failed"],
  reversed: [],
  adjusting: ["adjusted", "failed"],
  adjusted: ["reversing"],
  failed: [],
  rejected: [],
  expired: []
};

export function canTransition(from: TxnState, to: TxnState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type ActorKind = "user" | "agent" | "partner" | "system" | "customer";

export interface TxnTypeDef {
  code: string;
  /** false = ⊘ in docs/19 §4: the transaction is real, it just posts no journal. */
  financial: boolean;
  /** Approval policy key from packages/core/approvals, or null when none applies. */
  approval: string | null;
  /** Moves money out of the business — never auto-approved above threshold. */
  payout?: true;
  /** Touches segregated client money: dual control always (docs/19 §7). */
  clientMoney?: true;
}

/** docs/19 §4, complete. Codes are stable API surface (`POST /v1/txn/{type}`). */
export const TXN_TYPES: Record<string, TxnTypeDef> = def([
  // 4.1 distribution lifecycle
  ["QUOTE-REQ", false, null],
  ["QUOTE-PANEL", false, null],
  ["QUOTE-PRESENT", false, null],
  ["BIND", true, "axis.bind"],
  ["BIND-GROUP", true, "axis.bind_group"],
  ["ENDORSE", true, "axis.endorse"],
  // A telemetry-driven mid-term price change is an endorsement: same pricing
  // path, same recipe, same gate. Its own code exists only so the ledger can
  // tell an underwriter-initiated change from a sensor-initiated one, which is
  // the first question asked when a customer disputes a premium (docs/27 F5).
  ["UBI-REPRICE", true, "axis.endorse"],
  // Inception, expiry, lapse and NTU move no money, but they are transactions
  // rather than column writes because `runTxn` is the only writer that produces
  // a reversible, idempotent, audited state hop — and a mis-fired scheduler has
  // to be reversible (design §B.1).
  ["INCEPT", false, null],
  ["EXPIRE", false, null],
  ["NTU", false, "axis.ntu"],
  ["CANCEL", true, "axis.cancel"],
  ["LAPSE", false, null],
  ["REINSTATE", true, "axis.reinstate"],
  // Renewal used to borrow `axis.bind`'s gate; its own key lets the renewal
  // threshold move without touching new business (design §B.3).
  ["RENEW", true, "axis.renew"],
  ["FNOL-REGISTER", false, null],
  ["CLAIM-SYNC", false, null],
  ["PARAM-TRIGGER", false, null],
  // Usage/sensor points arriving against a contract. Posts no journal — raw
  // telemetry is an input to a price, not a balance — but it is a transaction
  // so a replayed batch is idempotent and an ingest is auditable back to the
  // reprice it caused (H6 seam, docs/16).
  ["TELEM-INGEST", false, null],

  // 4.1b claims (design §B.3). The claim's own state hops post no journal — the
  // reserve is a memorandum figure, not a ledger balance — but the money legs
  // do: the insurer funds a float, we pay out of it, and recoveries come back
  // the other way. CLAIM-PAY is the one AXIS type that is both a payout and
  // client money, so it can never be auto-approved however a tenant is set up.
  ["CLAIM-RESERVE", false, "axis.claim_reserve"],
  ["CLAIM-APPROVE", false, "axis.claim_settlement"],
  ["CLAIM-DECLINE", false, "axis.claim_settlement"],
  ["CLAIM-CLOSE", false, null],
  ["CLAIM-REOPEN", false, "axis.claim_settlement"],
  ["CLAIM-FUND", true, null, { clientMoney: true }],
  ["CLAIM-PAY", true, "axis.claim_payment", { payout: true, clientMoney: true }],
  ["RECOVERY-OPEN", false, null],
  ["RECOVERY-RECEIPT", true, null, { clientMoney: true }],
  ["RECOVERY-REMIT", true, null, { clientMoney: true }],
  ["RECOVERY-WRITEOFF", true, "axis.recovery_writeoff"],
  ["RECOVERY-FEE", true, null, { clientMoney: true }],

  // 4.2 money in
  ["PREM-COLLECT", true, null],
  // Opening a financing plan moves no money itself — it's the FIN-CMSN txn
  // chained off it (via parentTxnId) that posts the commission.
  ["PLAN-CREATE", false, null],
  ["PREM-INSTALMENT", true, null],
  ["DEPOSIT-TAKE", true, null],
  ["PSP-SETTLE", true, null],
  ["CHARGEBACK", true, null],
  ["CHARGEBACK-WIN", true, null],

  // 4.3 money out
  ["PREM-REMIT", true, "ledger.remit", { payout: true, clientMoney: true }],
  ["REFUND-ISSUE", true, "ledger.refund", { payout: true }],
  ["PAYOUT-INSTRUCT", true, "ledger.payout", { payout: true }],
  ["RSHARE-SETL", true, "dist.settlement_run", { payout: true }],
  ["CREATOR-PAYOUT", true, "ledger.payout", { payout: true }],
  ["SUPPLIER-PAY", true, "ledger.payout", { payout: true }],

  // 4.4 earnings & accruals
  ["CMSN-ACCR", true, null],
  ["CMSN-SETL", true, null],
  ["CMSN-CLAWBACK", true, null],
  ["FEE-BROK", true, null],
  ["FEE-SERVICE", true, null],
  ["REFERRAL-QUAL", false, null],
  ["REFERRAL-SETL", true, null],
  ["FIN-CMSN", true, null],
  ["RSHARE-ACCR", true, null],
  ["AD-PLACEMENT", true, null],
  ["SURPLUS-DIST", true, "ledger.surplus"],

  // 4.4b manual & structural (docs/27 F2, F3). The three entries a controller
  // cannot operate without, and the only ones whose lines are authored rather
  // than derived from a business event — which is exactly why all three are
  // dual-controlled and none may ever be auto-approved.
  ["MANUAL-JRNL", true, "ledger.manual_journal"],
  // Opening balances legitimately carry a client-account balance on day one,
  // so the type is flagged: no tenant setting can auto-approve it.
  ["OPEN-BAL", true, "ledger.opening_balance", { clientMoney: true }],
  ["YEAR-END-CLOSE", true, "ledger.year_end_close"],
  // docs/19 §5.3 / docs/27 F18. Period-end revaluation of open foreign-currency
  // balances. System-derived from the rate table and the ledger's own lines —
  // nobody states the number — so it is ungated for the same reason a commission
  // accrual is (docs/19 §7, "commission accrual (system-derived): none").
  ["FX-REVAL", true, null],

  // 4.5 subscriptions, usage & platform billing
  ["SUB-CREATE", false, null],
  ["SUB-INVOICE", true, null],
  ["SUB-RECOG", true, null],
  ["SUB-CHANGE", true, null],
  ["SUB-CANCEL", true, null],
  ["USAGE-METER", false, null],
  ["OVERAGE", true, null],
  ["SUCCESS-FEE", true, "ledger.success_fee"],
  ["DUNNING", false, null],
  ["CREDIT-NOTE", true, "ledger.credit_note", { payout: true }],

  // 4.6 client money & escrow
  ["CM-RECEIPT", true, null, { clientMoney: true }],
  ["CM-TRANSFER", true, "ledger.client_money_transfer", { clientMoney: true }],
  ["CM-RECON", false, null],
  // A write-off makes a difference disappear, which is also what concealment
  // looks like — so it is dual control always and may never be auto-approved,
  // on the same footing as a manual journal (docs/19 §7, docs/27 thin screens).
  // It may not touch client money: the recipe refuses those accounts outright,
  // because a client-money shortfall is a breach to escalate, not a residual.
  ["RECON-WRITEOFF", true, "ledger.write_off"],
  ["CM-BREACH-FLAG", false, null],

  // 4.7 partner & embedded
  ["PARTNER-ONBOARD", false, "dist.partner_activate"],
  ["PARTNER-QUOTE", false, null],
  ["PARTNER-BIND", true, null],
  ["RSHARE-ADJUST", true, "dist.rshare_adjust"],
  ["EXT-INSTALL", false, null],
  ["EXT-RSHARE", true, null],

  // 4.8 marketing & content commerce
  ["MEDIA-COMMIT", false, "signal.budget_commit"],
  ["MEDIA-SPEND", true, null],
  ["BUDGET-MOVE", false, "signal.budget_move"],
  ["PUBLISH", false, null],
  ["BOOST", true, "signal.boost"],
  ["CREATOR-BRIEF", false, "signal.creator_brief"],
  ["CREATOR-VERIFY", false, null],

  // 4.9 data products & AI
  ["DPROD-SUB", false, null],
  ["DPROD-DELIVER", false, null],
  ["AI-CALL", false, null],
  ["AI-BUDGET-STOP", false, null],

  // 4.10 identity, consent & compliance
  ["CONSENT-GRANT", false, null],
  ["CONSENT-WITHDRAW", false, null],
  ["KYC-VERIFY", false, null],
  ["SANCTIONS-SCREEN", false, null],
  ["DISCLOSURE-PRESENT", false, null],
  ["APPROVAL-DECISION", false, null],
  ["DSAR-FULFIL", false, null],
  ["AUDIT-EXPORT", false, null],

  // 4.11 agentic commerce
  ["MANDATE-REGISTER", false, "core.mandate_register"],
  ["AGENT-QUOTE", false, null],
  ["AGENT-BIND", true, null],
  ["MANDATE-REVOKE", false, null]
]);

type Tuple = [string, boolean, string | null, Partial<TxnTypeDef>?];

function def(rows: Tuple[]): Record<string, TxnTypeDef> {
  const out: Record<string, TxnTypeDef> = {};
  for (const [code, financial, approval, extra] of rows) {
    out[code] = { code, financial, approval, ...extra };
  }
  return out;
}

export function txnType(code: string): TxnTypeDef {
  const t = TXN_TYPES[code];
  if (!t) throw new Error(`unknown transaction type ${code}`);
  return t;
}

/**
 * docs/19 §7: no tenant may auto-approve a type that touches client money or
 * pays money out. Enforced here so a settings screen cannot open a hole.
 */
export function autoApprovable(code: string): boolean {
  const t = txnType(code);
  return !t.payout && !t.clientMoney;
}

import { and, eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { applyPpm, splitCommission } from "../commission.js";
import { DAY, HOUR, MINUTE, accountByCode, type SeedContext } from "./context.js";
import { dayIntoMonth, monthKey, monthName, monthStart as utcMonthStart } from "./period.js";

// docs/19 — the money the rest of the demo implies. Axis sells Rania Haddad a
// motor policy; that sale is not real until the premium sits in client money,
// the commission is accrued against Cedar and the insurer has been remitted.
// This seeder writes that money story, plus the platform's own billing, so
// every finance screen opens on a book that balances instead of an empty table.
//
// Two rules shape everything below and neither bends for convenience:
// every batch balances (debits === credits, in txn currency and in base), and
// client money is segregated (1010 never falls below 2010).

/** A posting line before it is expanded into a row; `side` carries the sign. */
interface SeedLine {
  code: string;
  side: "debit" | "credit";
  amountMinor: number;
  memo: string;
  dims?: Record<string, string>;
}

interface SeedBatch {
  batchId: string;
  txnId: string;
  currency: string;
  /** Rate from batch currency to AED. 1:1 for the AED book. */
  fxRatePpm: number;
  periodCode: string;
  postedBy: string;
  postedAt: number;
  reversalOfBatchId?: string;
  lines: readonly SeedLine[];
}

export async function seedLedger(ctx: SeedContext): Promise<void> {
  const { db, tenantId, now, issuedAt } = ctx;
  const BASE = "AED";

  // Ids are minted off the seed clock, never Date.now(), so a re-seed of the
  // same tenant produces the same ordering.
  let seq = 0;
  const nid = (prefix: string): string => id(prefix, now + seq++);

  const controller = `user:${ctx.users["finance.controller"] ?? "seed"}`;
  const analyst = `user:${ctx.users["finance.analyst"] ?? "seed"}`;
  const agent = `user:${ctx.users["axis.agent"] ?? "seed"}`;

  /* ---------------------------------------------------------------- periods */
  // Periods are created on first posting in production; the seed opens the three
  // months its batches land in so the close screen has an open month, a month
  // waiting on adjustments and a frozen one.
  const monthStart = (delta: number): number => utcMonthStart(now, delta);
  // "N days into the current open month" (docs: dayIntoMonth) — never the
  // closed months above, whose arithmetic is already comfortably in the past.
  const dayIn = (days: number): number => dayIntoMonth(now, 0, days);
  const thisMonth = monthKey(now);
  const lastMonth = monthKey(now, -1);
  const monthBefore = monthKey(now, -2);
  // Memos and invoice lines name their month in prose, and a statement that
  // says December while the period chip beside it says 2026-07 is a bug report.
  const thisMonthName = monthName(now);
  const lastMonthName = monthName(now, -1);

  const checklist = (code: string): string =>
    JSON.stringify([
      { name: `trial_balance_zero@${code}`, ok: true },
      { name: `no_pending_external@${code}`, ok: true },
      { name: `no_open_client_money_breach@${code}`, ok: true }
    ]);

  const periodIds: Record<string, string> = {};
  // Next month is opened too: the sale is issued at `now + 2 days`, which lands in
  // the following month whenever the seed clock sits near a month end, and a batch
  // with no period to belong to is a NOT NULL violation.
  for (const [delta, state] of [
    [-2, "hard_closed"],
    [-1, "soft_closed"],
    [0, "open"],
    [1, "open"]
  ] as const) {
    const code = monthKey(now, delta);
    const periodId = nid("per");
    periodIds[code] = periodId;
    await db.insert(schema.ledgerPeriods).values({
      id: periodId,
      tenantId,
      code,
      startAt: monthStart(delta),
      endAt: monthStart(delta + 1) - 1,
      state,
      checklistJson: state === "open" ? null : checklist(code),
      closePackFileId: null,
      closedBy: state === "open" ? null : controller,
      closedAt: state === "open" ? null : monthStart(delta + 1) + 5 * DAY
    });
  }

  /* ------------------------------------------------ the sale, read not guessed */
  // The commission the ledger accrues has to be the commission Axis wrote on the
  // policy — reading it back is how the two stay equal when the core seed's
  // premium changes.
  const [policy] = await db
    .select({ premiumMinor: schema.axisPolicies.premiumMinor, commissionMinor: schema.axisPolicies.commissionMinor })
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, tenantId), eq(schema.axisPolicies.id, ctx.policyId)))
    .limit(1);
  if (!policy) throw new Error("seed: the ledger needs the motor policy the core seed writes");

  const premiumMinor = policy.premiumMinor;
  const premiumTaxMinor = applyPpm(premiumMinor, 50_000); // 5% VAT, AE standard rate
  const collectedMinor = premiumMinor + premiumTaxMinor;
  const commissionMinor = policy.commissionMinor; // b2c web: gross === net, no channel share

  // Alpha Brokers' December bind: the same shape, but a b2b channel takes 30%.
  const ALPHA_PREMIUM = 416_000;
  const alpha = splitCommission({ premiumMinor: ALPHA_PREMIUM, baseCommissionPpm: 150_000, channelSharePpm: 300_000 });

  /* ------------------------------------------ the contracts behind the money */
  // Every commission figure on these books is some contract's commission, and
  // that contract is a row: NORTH counts policies and sums their premium, the
  // P&L sums the accruals, and a reader comparing the two must find the same
  // book (seed/north-book.ts). Last month's accrual run is Cedar's statement
  // for these five web sales — four new, one renewal — at Cedar Motor
  // Essential's 12.5%; the accrual and the settlement that clears it are summed
  // from them rather than typed beside them. The run accrues them, so none of
  // them carries a BIND as well: that would put the same commission on the P&L
  // twice.
  //
  // Ids come off their own clock offset so the ledger rows below keep theirs.
  let bookSeq = 0;
  const bookId = (prefix: string): string => id(prefix, now - 100_000 + bookSeq++);
  const yymm = lastMonth.slice(2, 4) + lastMonth.slice(5, 7);
  const CEDAR_PPM = 125_000;
  const cedarBook = [
    { no: `CDR-MOT-${yymm}-410226`, premiumMinor: 600_000, day: 2, renewal: false },
    { no: `CDR-MOT-${yymm}-410391`, premiumMinor: 700_800, day: 7, renewal: false },
    { no: `CDR-MOT-${yymm}-410557`, premiumMinor: 648_000, day: 12, renewal: false },
    { no: `CDR-MOT-${yymm}-410702`, premiumMinor: 700_800, day: 16, renewal: false },
    { no: `CDR-MOT-${yymm}-388140`, premiumMinor: 441_600, day: 20, renewal: true }
  ].map((p) => ({
    ...p,
    id: bookId("pol"),
    versionId: bookId("pver"),
    at: monthStart(-1) + p.day * DAY + 10 * HOUR,
    commissionMinor: applyPpm(p.premiumMinor, CEDAR_PPM)
  }));
  const cedarNewMinor = cedarBook.filter((p) => !p.renewal).reduce((n, p) => n + p.commissionMinor, 0);
  const cedarRenewalMinor = cedarBook.filter((p) => p.renewal).reduce((n, p) => n + p.commissionMinor, 0);
  const cedarAccruedMinor = cedarNewMinor + cedarRenewalMinor;
  const CEDAR_BANK_FEE = 2_280;

  // The Alpha bind is a contract too, cancelled inside its cooling-off window:
  // the reversal below is its cancellation, so the policy is stamped with it.
  const alphaPolicy = {
    id: bookId("pol"),
    versionId: bookId("pver"),
    no: `FLC-MOT-${yymm}-552907`,
    at: monthStart(-1) + 30 * DAY,
    cancelledAt: now + 4 * HOUR
  };

  const contract = (p: {
    id: string;
    versionId: string;
    no: string;
    providerId: string;
    offeringId: string;
    channelId: string;
    premiumMinor: number;
    commissionMinor: number;
    at: number;
    renewalSeq?: number;
    cancelledAt?: number;
  }) => ({
    policy: {
      id: p.id,
      tenantId,
      customerId: ctx.customerId,
      providerId: p.providerId,
      productId: ctx.products.motor,
      offeringId: p.offeringId,
      channelId: p.channelId,
      policyNo: p.no,
      startAt: p.at,
      endAt: p.at + 365 * DAY,
      premiumMinor: p.premiumMinor,
      currency: BASE,
      commissionMinor: p.commissionMinor,
      currentVersionId: p.versionId,
      versionSeq: 1,
      renewalSeq: p.renewalSeq ?? 0,
      ...(p.cancelledAt === undefined
        ? { status: "active" }
        : { status: "cancelled", cancelledAt: p.cancelledAt, cancelEffectiveAt: p.at, cancelReasonCode: "cooling_off" }),
      createdAt: p.at,
      updatedAt: p.cancelledAt ?? p.at
    },
    // A bind always writes version 1 (routes/axis.ts `bindPolicy`).
    version: {
      id: p.versionId,
      tenantId,
      policyId: p.id,
      versionSeq: 1,
      reason: "issue",
      effectiveFrom: p.at,
      effectiveTo: p.at + 365 * DAY,
      premiumMinor: p.premiumMinor,
      taxMinor: 0,
      feesMinor: 0,
      commissionMinor: p.commissionMinor,
      currency: BASE,
      premiumDeltaMinor: 0,
      termsJson: JSON.stringify({ excessMinor: 100_000 }),
      state: "effective",
      issuedBy: agent,
      issuedAt: p.at,
      createdAt: p.at,
      updatedAt: p.at
    }
  });
  const contracts = [
    ...cedarBook.map((p) =>
      contract({
        ...p,
        providerId: ctx.providers.cedar,
        offeringId: ctx.offerings.cedarMotor,
        channelId: ctx.channels.web,
        renewalSeq: p.renewal ? 1 : 0
      })
    ),
    contract({
      ...alphaPolicy,
      providerId: ctx.providers.falcon,
      offeringId: ctx.offerings.falconMotor,
      channelId: ctx.channels.brokerAlpha,
      premiumMinor: ALPHA_PREMIUM,
      commissionMinor: alpha.grossMinor
    })
  ];
  await db.insert(schema.axisPolicies).values(contracts.map((c) => c.policy));
  await db.insert(schema.axisPolicyVersions).values(contracts.map((c) => c.version));

  /* ----------------------------------------------------------- transactions */
  const txDecAccrual = nid("txn");
  const txCedarSettle = nid("txn");
  const txAlphaBind = nid("txn");
  const txAlphaReversal = nid("txn");
  const txPremCollect = nid("txn");
  const txBindRania = nid("txn");
  const txPremRemit = nid("txn");
  const txSubInvoice = nid("txn");
  const txSubRecog = nid("txn");
  const txFalconInvoice = nid("txn");
  const txOverage = nid("txn");
  const txRefundOryx = nid("txn");
  const txPayoutAlpha = nid("txn");
  const txPspSettle = nid("txn");

  const decMid = monthStart(-1) + 24 * DAY;
  const saleRefs = JSON.stringify({
    customer: ctx.customerId,
    case: ctx.caseId,
    policy: ctx.policyId,
    channel: ctx.channels.web,
    provider: ctx.providers.cedar
  });

  await db.insert(schema.ledgerTxns).values([
    {
      // December's book accrued in one run: what Cedar owes us for the month.
      id: txDecAccrual,
      tenantId,
      type: "CMSN-ACCR",
      idempotencyKey: `cmsn-accr:${ctx.providers.cedar}:${lastMonth}`,
      correlationId: `book:${lastMonth}`,
      state: "settled",
      actorKind: "system",
      actorId: "scheduler",
      subjectRefsJson: JSON.stringify({ provider: ctx.providers.cedar, period: lastMonth, policies: cedarBook.map((p) => p.id) }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: cedarAccruedMinor, net: cedarAccruedMinor, tax: 0 }),
      grossMinor: cedarAccruedMinor,
      baseGrossMinor: cedarAccruedMinor,
      createdAt: decMid,
      updatedAt: decMid + MINUTE,
      settledAt: decMid + MINUTE
    },
    {
      // Cedar paid it, less the bank's handling fee — the receivable clears.
      id: txCedarSettle,
      tenantId,
      type: "CMSN-SETL",
      idempotencyKey: `cmsn-setl:${ctx.providers.cedar}:${lastMonth}`,
      correlationId: `book:${lastMonth}`,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["finance.controller"] ?? "seed",
      subjectRefsJson: JSON.stringify({ provider: ctx.providers.cedar, period: lastMonth }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: cedarAccruedMinor, fee: CEDAR_BANK_FEE, net: cedarAccruedMinor - CEDAR_BANK_FEE }),
      grossMinor: cedarAccruedMinor,
      baseGrossMinor: cedarAccruedMinor,
      createdAt: monthStart(-1) + 27 * DAY,
      updatedAt: monthStart(-1) + 27 * DAY + HOUR,
      settledAt: monthStart(-1) + 27 * DAY + HOUR
    },
    {
      // A bind through Alpha Brokers that the customer cancelled inside the
      // cooling-off window: settled, then reversed. The original is never edited.
      id: txAlphaBind,
      tenantId,
      type: "BIND",
      idempotencyKey: "bind:GNX-2512-0188",
      correlationId: "sale:GNX-2512-0188",
      state: "reversed",
      actorKind: "partner",
      actorId: ctx.channels.brokerAlpha,
      autonomyLevel: "act_with_approval",
      subjectRefsJson: JSON.stringify({ case: "GNX-2512-0188", policy: alphaPolicy.id, channel: ctx.channels.brokerAlpha, provider: ctx.providers.falcon }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: alpha.grossMinor, share: alpha.channelMinor, net: alpha.netMinor }),
      grossMinor: alpha.grossMinor,
      baseGrossMinor: alpha.grossMinor,
      guardrailsJson: JSON.stringify({ consent_checked: true, disclosure_presented: true }),
      createdAt: monthStart(-1) + 30 * DAY,
      updatedAt: now + 4 * HOUR,
      settledAt: monthStart(-1) + 30 * DAY + 2 * MINUTE
    },
    {
      // The reversal is its own transaction pointing back at the original.
      id: txAlphaReversal,
      tenantId,
      type: "BIND",
      idempotencyKey: `reverse:${txAlphaBind}`,
      correlationId: "sale:GNX-2512-0188",
      parentTxnId: txAlphaBind,
      reversalOf: txAlphaBind,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["finance.controller"] ?? "seed",
      subjectRefsJson: JSON.stringify({ case: "GNX-2512-0188", policy: alphaPolicy.id, channel: ctx.channels.brokerAlpha }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      grossMinor: alpha.grossMinor,
      baseGrossMinor: alpha.grossMinor,
      metadataJson: JSON.stringify({ reversalOf: txAlphaBind, reason: "cooling-off cancellation within 5 days" }),
      createdAt: now + 4 * HOUR,
      updatedAt: now + 4 * HOUR + MINUTE,
      settledAt: now + 4 * HOUR + MINUTE
    },
    {
      // Rania's card payment. Her money, held segregated until Cedar is paid.
      id: txPremCollect,
      tenantId,
      type: "PREM-COLLECT",
      idempotencyKey: `prem-collect:${ctx.policyId}`,
      correlationId: `sale:${ctx.caseId}`,
      state: "settled",
      actorKind: "customer",
      actorId: ctx.customerId,
      subjectRefsJson: saleRefs,
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: collectedMinor, net: premiumMinor, tax: premiumTaxMinor }),
      grossMinor: collectedMinor,
      baseGrossMinor: collectedMinor,
      createdAt: issuedAt + 4 * MINUTE,
      updatedAt: issuedAt + 5 * MINUTE,
      settledAt: issuedAt + 5 * MINUTE
    },
    {
      // Commission is earned on issue (the offering says so), so it accrues the
      // moment the policy exists — not when Cedar eventually pays.
      id: txBindRania,
      tenantId,
      type: "BIND",
      idempotencyKey: `bind:${ctx.caseId}`,
      correlationId: `sale:${ctx.caseId}`,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["axis.agent"] ?? "seed",
      autonomyLevel: "act_with_approval",
      subjectRefsJson: saleRefs,
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: commissionMinor, net: commissionMinor, share: 0, tax: 0 }),
      grossMinor: commissionMinor,
      baseGrossMinor: commissionMinor,
      guardrailsJson: JSON.stringify({ consent_checked: true, disclosure_presented: true, approval: "issue" }),
      createdAt: issuedAt + 5 * MINUTE,
      updatedAt: issuedAt + 6 * MINUTE,
      settledAt: issuedAt + 6 * MINUTE
    },
    {
      // Same-day remittance of the premium to Cedar. The VAT stays in client
      // money until Cedar issues its tax invoice, which is why 1010 keeps a float.
      id: txPremRemit,
      tenantId,
      type: "PREM-REMIT",
      idempotencyKey: `prem-remit:${ctx.policyId}`,
      correlationId: `sale:${ctx.caseId}`,
      state: "settled",
      actorKind: "system",
      actorId: "scheduler",
      subjectRefsJson: saleRefs,
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      grossMinor: premiumMinor,
      baseGrossMinor: premiumMinor,
      createdAt: issuedAt + 3 * HOUR,
      updatedAt: issuedAt + 3 * HOUR + MINUTE,
      settledAt: issuedAt + 3 * HOUR + MINUTE
    },
    {
      // The platform billing its own partners — Lyra runs on Lyra (docs/20).
      id: txSubInvoice,
      tenantId,
      type: "SUB-INVOICE",
      idempotencyKey: `sub-invoice:${ctx.channels.brokerAlpha}:${thisMonth}`,
      state: "settled",
      actorKind: "system",
      actorId: "billing",
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: 472_500, net: 450_000, tax: 22_500 }),
      grossMinor: 472_500,
      baseGrossMinor: 472_500,
      createdAt: now + HOUR,
      updatedAt: now + HOUR + MINUTE,
      settledAt: now + HOUR + MINUTE
    },
    {
      // January's share of that subscription moves out of deferred revenue.
      id: txSubRecog,
      tenantId,
      type: "SUB-RECOG",
      idempotencyKey: `sub-recog:${ctx.channels.brokerAlpha}:${thisMonth}`,
      state: "settled",
      actorKind: "system",
      actorId: "billing",
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      grossMinor: 450_000,
      baseGrossMinor: 450_000,
      createdAt: now + 2 * HOUR,
      updatedAt: now + 2 * HOUR + MINUTE,
      settledAt: now + 2 * HOUR + MINUTE
    },
    {
      // Falcon buys the data feed annually in dollars: the one non-AED posting,
      // so the per-currency statement and the fx table both have work to do.
      id: txFalconInvoice,
      tenantId,
      type: "SUB-INVOICE",
      idempotencyKey: `sub-invoice:${ctx.providers.falcon}:${thisMonth}`,
      state: "settled",
      actorKind: "system",
      actorId: "billing",
      currency: "USD",
      baseCurrency: BASE,
      fxRatePpm: 3_672_500,
      amountsJson: JSON.stringify({ gross: 480_000, net: 480_000, tax: 0 }),
      grossMinor: 480_000,
      baseGrossMinor: applyPpm(480_000, 3_672_500),
      createdAt: now + 3 * HOUR,
      updatedAt: now + 3 * HOUR + MINUTE,
      settledAt: now + 3 * HOUR + MINUTE
    },
    {
      // Metered API calls above Alpha's included bundle, billed as usage revenue.
      id: txOverage,
      tenantId,
      type: "OVERAGE",
      idempotencyKey: `overage:${ctx.channels.brokerAlpha}:${thisMonth}`,
      state: "settled",
      actorKind: "system",
      actorId: "billing",
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: 40_320, net: 38_400, tax: 1_920 }),
      grossMinor: 40_320,
      baseGrossMinor: 40_320,
      createdAt: now + 5 * HOUR,
      updatedAt: now + 5 * HOUR + MINUTE,
      settledAt: now + 5 * HOUR + MINUTE
    },
    {
      // A refund the PSP never confirmed: it failed before anything was posted,
      // which is exactly why nothing was posted. No batch, no half-written money.
      id: txRefundOryx,
      tenantId,
      type: "REFUND-ISSUE",
      idempotencyKey: `refund:${ctx.providers.oryx}:${lastMonth}`,
      state: "failed",
      actorKind: "user",
      actorId: ctx.users["finance.analyst"] ?? "seed",
      subjectRefsJson: JSON.stringify({ provider: ctx.providers.oryx }),
      currency: BASE,
      baseCurrency: BASE,
      grossMinor: 99_750,
      baseGrossMinor: 99_750,
      failureCode: "psp_timeout",
      failureDetail: "no response from the provider inside the 30s window; funds never left the account",
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY + 4 * MINUTE,
      failedAt: now - 2 * DAY + 4 * MINUTE
    },
    {
      // Alpha's December revenue share, held at `validated` because a payout is
      // consequential and the second controller has not approved it yet.
      id: txPayoutAlpha,
      tenantId,
      type: "RSHARE-SETL",
      idempotencyKey: `rshare-setl:${ctx.channels.brokerAlpha}:${lastMonth}`,
      state: "validated",
      actorKind: "user",
      actorId: ctx.users["finance.analyst"] ?? "seed",
      autonomyLevel: "act_with_approval",
      subjectRefsJson: JSON.stringify({ channel: ctx.channels.brokerAlpha, period: lastMonth }),
      currency: BASE,
      baseCurrency: BASE,
      grossMinor: 187_400,
      baseGrossMinor: 187_400,
      guardrailsJson: JSON.stringify({ dual_control: true, approvals_required: 2, approvals_held: 1 }),
      createdAt: now - HOUR,
      updatedAt: now - HOUR + MINUTE
    },
    {
      // Waiting on the PSP's settlement file. `pending_external` is a state, not
      // an error — and the close checklist for January will refuse to sign until
      // it clears.
      id: txPspSettle,
      tenantId,
      type: "PSP-SETTLE",
      idempotencyKey: `psp-settle:tap:${thisMonth}`,
      state: "pending_external",
      actorKind: "system",
      actorId: "scheduler",
      currency: BASE,
      baseCurrency: BASE,
      grossMinor: 472_500,
      baseGrossMinor: 472_500,
      externalTimeoutAt: now + 2 * DAY,
      createdAt: now - 6 * HOUR,
      updatedAt: now - 6 * HOUR + MINUTE
    }
  ]);

  /* ----------------------------------------------------- state-machine history */
  const transitions: (typeof schema.ledgerTxnTransitions.$inferInsert)[] = [];
  const walk = (
    txnId: string,
    actor: string,
    startAt: number,
    stepMs: number,
    states: readonly string[],
    reasons: Record<string, string> = {}
  ): void => {
    for (let i = 0; i < states.length; i++) {
      const to = states[i]!;
      transitions.push({
        id: nid("txt"),
        tenantId,
        txnId,
        fromState: i === 0 ? null : states[i - 1]!,
        toState: to,
        actorRef: actor,
        reason: reasons[to] ?? null,
        ts: startAt + i * stepMs
      });
    }
  };

  // The happy path, in full, on the transaction the demo talks about.
  walk(txBindRania, agent, issuedAt + 5 * MINUTE, 15_000, [
    "initiated",
    "validated",
    "authorized",
    "executing",
    "settled"
  ]);
  // Settled in December, undone in January: the timeline an auditor reads.
  walk(txAlphaBind, `partner:${ctx.channels.brokerAlpha}`, monthStart(-1) + 30 * DAY, 30_000, [
    "initiated",
    "validated",
    "authorized",
    "executing",
    "settled"
  ]);
  transitions.push(
    {
      id: nid("txt"),
      tenantId,
      txnId: txAlphaBind,
      fromState: "settled",
      toState: "reversing",
      actorRef: controller,
      reason: "cooling-off cancellation within 5 days",
      ts: now + 4 * HOUR
    },
    {
      id: nid("txt"),
      tenantId,
      txnId: txAlphaBind,
      fromState: "reversing",
      toState: "reversed",
      actorRef: controller,
      reason: "contra batch posted in the open period",
      ts: now + 4 * HOUR + 2 * MINUTE
    }
  );
  walk(txAlphaReversal, controller, now + 4 * HOUR, 20_000, [
    "initiated",
    "validated",
    "authorized",
    "executing",
    "settled"
  ]);
  // A failure is a terminal state with a cause, not a gap in the history.
  walk(
    txRefundOryx,
    analyst,
    now - 2 * DAY,
    60_000,
    ["initiated", "validated", "authorized", "executing", "failed"],
    { failed: "psp_timeout: no response inside the 30s window" }
  );
  walk(txPayoutAlpha, analyst, now - HOUR, 30_000, ["initiated", "validated"], {
    validated: "held for the second controller's approval"
  });
  await db.insert(schema.ledgerTxnTransitions).values(transitions);

  /* ------------------------------------------------------------- saga steps */
  await db.insert(schema.ledgerSagaSteps).values([
    {
      id: nid("sag"),
      tenantId,
      txnId: txPremRemit,
      seq: 1,
      name: "reserve_client_money",
      state: "done",
      requestHash: "sha256:9f1c",
      resultJson: JSON.stringify({ reservedMinor: premiumMinor }),
      attempts: 1,
      startedAt: issuedAt + 3 * HOUR,
      endedAt: issuedAt + 3 * HOUR + 2_000
    },
    {
      id: nid("sag"),
      tenantId,
      txnId: txPremRemit,
      seq: 2,
      name: "insurer_remittance_call",
      state: "done",
      requestHash: "sha256:2ab7",
      resultJson: JSON.stringify({ providerRef: "CDR-RMT-26010801" }),
      attempts: 2,
      lastError: "504 from the insurer gateway on the first attempt",
      startedAt: issuedAt + 3 * HOUR + 3_000,
      endedAt: issuedAt + 3 * HOUR + 41_000
    },
    {
      id: nid("sag"),
      tenantId,
      txnId: txPremRemit,
      seq: 3,
      name: "post_journal",
      state: "done",
      attempts: 1,
      startedAt: issuedAt + 3 * HOUR + 42_000,
      endedAt: issuedAt + 3 * HOUR + 43_000
    },
    {
      // The refund saga: the funds were reserved, the PSP call died, so the
      // reservation was compensated back. Nothing hit the ledger either way.
      id: nid("sag"),
      tenantId,
      txnId: txRefundOryx,
      seq: 1,
      name: "reserve_refund_funds",
      state: "compensated",
      requestHash: "sha256:c40e",
      compensationRef: `release:${txRefundOryx}`,
      attempts: 1,
      startedAt: now - 2 * DAY + MINUTE,
      endedAt: now - 2 * DAY + 5 * MINUTE
    },
    {
      id: nid("sag"),
      tenantId,
      txnId: txRefundOryx,
      seq: 2,
      name: "psp_refund_request",
      state: "failed",
      requestHash: "sha256:71d3",
      attempts: 3,
      lastError: "psp_timeout after 3 attempts",
      startedAt: now - 2 * DAY + 2 * MINUTE,
      endedAt: now - 2 * DAY + 4 * MINUTE
    },
    {
      // Still turning: the PSP settlement file has not arrived.
      id: nid("sag"),
      tenantId,
      txnId: txPspSettle,
      seq: 1,
      name: "await_settlement_file",
      state: "running",
      attempts: 1,
      startedAt: now - 6 * HOUR
    }
  ]);

  /* ---------------------------------------------------------------- batches */
  const bDecAccrual = nid("bat");
  const bCedarSettle = nid("bat");
  const bAlphaBind = nid("bat");
  const bAlphaReversal = nid("bat");
  const bPremCollect = nid("bat");
  const bBindRania = nid("bat");
  const bPremRemit = nid("bat");
  const bSubInvoice = nid("bat");
  const bSubRecog = nid("bat");
  const bFalconInvoice = nid("bat");
  const bOverage = nid("bat");

  const cedarDims = { provider: ctx.providers.cedar, channel: ctx.channels.web, line: "motor" };
  const alphaDims = { provider: ctx.providers.falcon, channel: ctx.channels.brokerAlpha, line: "motor" };

  const batches: readonly SeedBatch[] = [
    {
      batchId: bDecAccrual,
      txnId: txDecAccrual,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: lastMonth,
      postedBy: "system:scheduler",
      postedAt: decMid + MINUTE,
      lines: [
        { code: "1100", side: "debit", amountMinor: cedarAccruedMinor, memo: `${lastMonthName} commission due from Cedar`, dims: cedarDims },
        { code: "4000", side: "credit", amountMinor: cedarNewMinor, memo: "new business commission", dims: cedarDims },
        { code: "4010", side: "credit", amountMinor: cedarRenewalMinor, memo: "renewal commission", dims: cedarDims }
      ]
    },
    {
      batchId: bCedarSettle,
      txnId: txCedarSettle,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: lastMonth,
      postedBy: controller,
      postedAt: monthStart(-1) + 27 * DAY + HOUR,
      lines: [
        { code: "1000", side: "debit", amountMinor: cedarAccruedMinor - CEDAR_BANK_FEE, memo: "Cedar remittance received", dims: cedarDims },
        { code: "5300", side: "debit", amountMinor: CEDAR_BANK_FEE, memo: "bank handling fee", dims: cedarDims },
        { code: "1100", side: "credit", amountMinor: cedarAccruedMinor, memo: `${lastMonthName} receivable cleared`, dims: cedarDims }
      ]
    },
    {
      batchId: bAlphaBind,
      txnId: txAlphaBind,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: lastMonth,
      postedBy: `partner:${ctx.channels.brokerAlpha}`,
      postedAt: monthStart(-1) + 30 * DAY + 2 * MINUTE,
      lines: [
        { code: "1100", side: "debit", amountMinor: alpha.grossMinor, memo: "commission on GNX-2512-0188", dims: alphaDims },
        { code: "4000", side: "credit", amountMinor: alpha.netMinor, memo: "our share of the commission", dims: alphaDims },
        { code: "2100", side: "credit", amountMinor: alpha.channelMinor, memo: "Alpha Brokers' 30% share", dims: alphaDims }
      ]
    },
    {
      // A contra batch, not an edit: same amounts, opposite sides, posted in the
      // period that is still open.
      batchId: bAlphaReversal,
      txnId: txAlphaReversal,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: thisMonth,
      postedBy: controller,
      postedAt: now + 4 * HOUR + MINUTE,
      reversalOfBatchId: bAlphaBind,
      lines: [
        { code: "4000", side: "debit", amountMinor: alpha.netMinor, memo: "reversal: cooling-off cancellation", dims: alphaDims },
        { code: "2100", side: "debit", amountMinor: alpha.channelMinor, memo: "reversal: Alpha's share clawed back", dims: alphaDims },
        { code: "1100", side: "credit", amountMinor: alpha.grossMinor, memo: "reversal: receivable withdrawn", dims: alphaDims }
      ]
    },
    {
      // Rania's money enters segregated client money and nowhere near income.
      batchId: bPremCollect,
      txnId: txPremCollect,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: monthKey(issuedAt),
      postedBy: `customer:${ctx.customerId}`,
      postedAt: issuedAt + 5 * MINUTE,
      lines: [
        { code: "1010", side: "debit", amountMinor: collectedMinor, memo: "premium received for CDR-MOT-2601-778201", dims: cedarDims },
        { code: "2010", side: "credit", amountMinor: collectedMinor, memo: "held on behalf of the customer", dims: cedarDims }
      ]
    },
    {
      batchId: bBindRania,
      txnId: txBindRania,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: monthKey(issuedAt),
      postedBy: agent,
      postedAt: issuedAt + 6 * MINUTE,
      lines: [
        { code: "1100", side: "debit", amountMinor: commissionMinor, memo: "commission earned on issue", dims: cedarDims },
        { code: "4000", side: "credit", amountMinor: commissionMinor, memo: "b2c sale: no channel share", dims: cedarDims }
      ]
    },
    {
      batchId: bPremRemit,
      txnId: txPremRemit,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: monthKey(issuedAt),
      postedBy: "system:scheduler",
      postedAt: issuedAt + 3 * HOUR + MINUTE,
      lines: [
        { code: "2010", side: "debit", amountMinor: premiumMinor, memo: "obligation to the customer discharged", dims: cedarDims },
        { code: "1010", side: "credit", amountMinor: premiumMinor, memo: "premium remitted to Cedar", dims: cedarDims }
      ]
    },
    {
      batchId: bSubInvoice,
      txnId: txSubInvoice,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: thisMonth,
      postedBy: "system:billing",
      postedAt: now + HOUR + MINUTE,
      lines: [
        { code: "1160", side: "debit", amountMinor: 472_500, memo: "INV-2026-0051 Alpha Brokers portal" },
        { code: "2300", side: "credit", amountMinor: 450_000, memo: `${thisMonthName} subscription, not yet earned` },
        { code: "2200", side: "credit", amountMinor: 22_500, memo: "VAT at 5%" }
      ]
    },
    {
      batchId: bSubRecog,
      txnId: txSubRecog,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: thisMonth,
      postedBy: "system:billing",
      postedAt: now + 2 * HOUR + MINUTE,
      lines: [
        { code: "2300", side: "debit", amountMinor: 450_000, memo: `${thisMonthName} portion earned` },
        { code: "4040", side: "credit", amountMinor: 450_000, memo: "subscription revenue recognised" }
      ]
    },
    {
      batchId: bFalconInvoice,
      txnId: txFalconInvoice,
      currency: "USD",
      fxRatePpm: 3_672_500,
      periodCode: thisMonth,
      postedBy: "system:billing",
      postedAt: now + 3 * HOUR + MINUTE,
      lines: [
        { code: "1160", side: "debit", amountMinor: 480_000, memo: "INV-2026-0054 Falcon data feed, annual" },
        { code: "2300", side: "credit", amountMinor: 480_000, memo: "deferred over twelve months" }
      ]
    },
    {
      batchId: bOverage,
      txnId: txOverage,
      currency: BASE,
      fxRatePpm: 1_000_000,
      periodCode: thisMonth,
      postedBy: "system:billing",
      postedAt: now + 5 * HOUR + MINUTE,
      lines: [
        { code: "1160", side: "debit", amountMinor: 40_320, memo: "INV-2026-0056 API calls above bundle" },
        { code: "4050", side: "credit", amountMinor: 38_400, memo: "usage revenue" },
        { code: "2200", side: "credit", amountMinor: 1_920, memo: "VAT at 5%" }
      ]
    }
  ];

  // Every code posted to must exist in the chart the core seed wrote — a typo
  // here would otherwise surface as a silently orphaned balance row.
  for (const code of new Set(batches.flatMap((b) => b.lines.map((l) => l.code)))) {
    await accountByCode(ctx, code);
  }

  interface Bal {
    debitMinor: number;
    creditMinor: number;
    baseDebitMinor: number;
    baseCreditMinor: number;
  }
  const balances = new Map<string, Bal>();

  for (const batch of batches) {
    const lines = batch.lines.map((l, i) => ({
      id: nid("jln"),
      tenantId,
      batchId: batch.batchId,
      txnId: batch.txnId,
      seq: i + 1,
      accountCode: l.code,
      side: l.side,
      amountMinor: l.amountMinor,
      currency: batch.currency,
      baseAmountMinor: applyPpm(l.amountMinor, batch.fxRatePpm),
      baseCurrency: BASE,
      memo: l.memo,
      dimsJson: l.dims ? JSON.stringify(l.dims) : null,
      postedAt: batch.postedAt
    }));

    const sum = (side: string, key: "amountMinor" | "baseAmountMinor"): number =>
      lines.filter((l) => l.side === side).reduce((n, l) => n + l[key], 0);
    const debit = sum("debit", "amountMinor");
    const credit = sum("credit", "amountMinor");
    const baseDebit = sum("debit", "baseAmountMinor");
    const baseCredit = sum("credit", "baseAmountMinor");
    // The invariant, asserted rather than assumed: a seed that ships an
    // unbalanced batch would fail the ledger's own property tests later, in a
    // place that says nothing about where the bad number came from.
    if (debit !== credit || baseDebit !== baseCredit) {
      throw new Error(`seed: batch ${batch.batchId} does not balance (${debit}/${credit}, base ${baseDebit}/${baseCredit})`);
    }

    const periodId = periodIds[batch.periodCode];
    if (!periodId) throw new Error(`seed: no ledger period ${batch.periodCode}`);

    await db.insert(schema.ledgerJournalBatches).values({
      id: batch.batchId,
      tenantId,
      txnId: batch.txnId,
      periodId,
      currency: batch.currency,
      baseCurrency: BASE,
      fxRatePpm: batch.fxRatePpm,
      totalDebitMinor: debit,
      totalCreditMinor: credit,
      baseTotalDebitMinor: baseDebit,
      baseTotalCreditMinor: baseCredit,
      reversalOfBatchId: batch.reversalOfBatchId ?? null,
      postedBy: batch.postedBy,
      postedAt: batch.postedAt
    });
    await db.insert(schema.ledgerJournalLines).values(lines);

    for (const l of lines) {
      const key = `${l.accountCode}:${l.currency}`;
      const b = balances.get(key) ?? { debitMinor: 0, creditMinor: 0, baseDebitMinor: 0, baseCreditMinor: 0 };
      if (l.side === "debit") {
        b.debitMinor += l.amountMinor;
        b.baseDebitMinor += l.baseAmountMinor;
      } else {
        b.creditMinor += l.amountMinor;
        b.baseCreditMinor += l.baseAmountMinor;
      }
      balances.set(key, b);
    }
  }

  // Balances are a cache of the lines, so they are summed from the lines rather
  // than typed out — the two can never disagree.
  await db.insert(schema.ledgerAccountBalances).values(
    [...balances].map(([key, b]) => {
      const [accountCode, currency] = key.split(":") as [string, string];
      return { id: nid("bal"), tenantId, accountCode, currency, ...b, updatedAt: now + 6 * HOUR };
    })
  );

  // Batch and transaction point at each other; the list screens read the txn.
  for (const batch of batches) {
    await db
      .update(schema.ledgerTxns)
      .set({ ledgerBatchId: batch.batchId })
      .where(and(eq(schema.ledgerTxns.tenantId, tenantId), eq(schema.ledgerTxns.id, batch.txnId)));
  }

  /* ------------------------------------------------------------ client money */
  // 1010 ≥ 2010 at every point in time. The one breach on record is December's,
  // and it is closed — an open breach would (correctly) block the month's close.
  // ponytail: the December figures predate the opening balances this seed posts,
  // so they read as history rather than reconciling to the lines above.
  const clientMoneyFloat = collectedMinor - premiumMinor;
  await db.insert(schema.ledgerClientMoneyChecks).values([
    {
      id: nid("cmc"),
      tenantId,
      assetMinor: 498_300,
      liabilityMinor: 512_400,
      currency: BASE,
      shortfallMinor: 14_100,
      breach: true,
      triggeredBy: "scheduled",
      resolvedAt: monthStart(-1) + 31 * DAY,
      ts: monthStart(-1) + 30 * DAY + 6 * HOUR
    },
    {
      id: nid("cmc"),
      tenantId,
      assetMinor: 512_400,
      liabilityMinor: 512_400,
      currency: BASE,
      shortfallMinor: 0,
      breach: false,
      triggeredBy: "scheduled",
      resolvedAt: null,
      ts: monthStart(-1) + 31 * DAY + HOUR
    },
    {
      id: nid("cmc"),
      tenantId,
      assetMinor: collectedMinor,
      liabilityMinor: collectedMinor,
      currency: BASE,
      shortfallMinor: 0,
      breach: false,
      triggeredBy: txPremCollect,
      resolvedAt: null,
      ts: issuedAt + 5 * MINUTE
    },
    {
      id: nid("cmc"),
      tenantId,
      assetMinor: clientMoneyFloat,
      liabilityMinor: clientMoneyFloat,
      currency: BASE,
      shortfallMinor: 0,
      breach: false,
      triggeredBy: txPremRemit,
      resolvedAt: null,
      ts: issuedAt + 3 * HOUR + MINUTE
    },
    {
      id: nid("cmc"),
      tenantId,
      assetMinor: clientMoneyFloat,
      liabilityMinor: clientMoneyFloat,
      currency: BASE,
      shortfallMinor: 0,
      breach: false,
      triggeredBy: "scheduled",
      resolvedAt: null,
      ts: issuedAt + DAY
    }
  ]);

  /* ------------------------------------------------------------ subscriptions */
  const subAlpha = nid("sub");
  const subMeridian = nid("sub");
  const subCedar = nid("sub");
  const subFalcon = nid("sub");
  const subOryx = nid("sub");
  const subGulfHealth = nid("sub");

  // `nextInvoiceAt` is next month's first day, not each subscription's own
  // anniversary: the billing sweep runs against seeded data and catches up every
  // period between that date and the clock, and the invoices below already cover
  // the months up to now — so anything earlier would raise them a second time.
  //
  // Except the annual one: its priceMinor is a whole year and that year is
  // already invoiced, so next month's boundary would bill a second full year
  // eleven months early (migration 0026 makes the same distinction).
  await db.insert(schema.ledgerSubscriptions).values([
    {
      // The distribution partners pay for the portal they sell through.
      id: subAlpha,
      tenantId,
      customerRef: `channel:${ctx.channels.brokerAlpha}`,
      plan: "broker_portal",
      edition: "growth",
      priceMinor: 450_000,
      currency: BASE,
      interval: "month",
      seats: 12,
      startAt: now - 300 * DAY,
      nextInvoiceAt: monthStart(1),
      state: "active",
      termsJson: JSON.stringify({ noticeDays: 30, autoRenew: true, includedApiCalls: 100_000 }),
      createdAt: now - 300 * DAY,
      updatedAt: now - 30 * DAY
    },
    {
      id: subMeridian,
      tenantId,
      customerRef: `channel:${ctx.channels.bankEmbed}`,
      plan: "embedded",
      edition: "enterprise",
      priceMinor: 1_800_000,
      currency: BASE,
      interval: "month",
      seats: 40,
      startAt: now - 180 * DAY,
      nextInvoiceAt: monthStart(1),
      state: "active",
      termsJson: JSON.stringify({ noticeDays: 90, autoRenew: true, slaMinutes: 15 }),
      createdAt: now - 180 * DAY,
      updatedAt: now - 30 * DAY
    },
    {
      id: subCedar,
      tenantId,
      customerRef: `provider:${ctx.providers.cedar}`,
      plan: "insurer_portal",
      edition: "standard",
      priceMinor: 120_000,
      currency: BASE,
      interval: "month",
      seats: 6,
      startAt: now - 240 * DAY,
      nextInvoiceAt: monthStart(1),
      state: "active",
      createdAt: now - 240 * DAY,
      updatedAt: now - 30 * DAY
    },
    {
      // Falcon buys data, annually, in dollars.
      id: subFalcon,
      tenantId,
      customerRef: `provider:${ctx.providers.falcon}`,
      plan: "data_feed",
      edition: "standard",
      priceMinor: 480_000,
      currency: "USD",
      interval: "year",
      seats: 3,
      startAt: now - 20 * DAY,
      nextInvoiceAt: now - 20 * DAY + 365 * DAY,
      state: "active",
      termsJson: JSON.stringify({ noticeDays: 60, autoRenew: true, exportOfServices: true }),
      createdAt: now - 20 * DAY,
      updatedAt: now - 20 * DAY
    },
    {
      // Oryx's card failed, so the subscription is past due rather than cancelled
      // — the dunning run has three more attempts before it suspends access.
      id: subOryx,
      tenantId,
      customerRef: `provider:${ctx.providers.oryx}`,
      plan: "insurer_portal",
      edition: "standard",
      priceMinor: 95_000,
      currency: BASE,
      interval: "month",
      seats: 4,
      startAt: now - 150 * DAY,
      nextInvoiceAt: monthStart(1),
      state: "past_due",
      createdAt: now - 150 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: subGulfHealth,
      tenantId,
      customerRef: `provider:${ctx.providers.gulfHealth}`,
      plan: "insurer_portal",
      edition: "trial",
      priceMinor: 0,
      currency: BASE,
      interval: "month",
      seats: 2,
      startAt: now - 90 * DAY,
      endAt: now - 10 * DAY,
      state: "cancelled",
      createdAt: now - 90 * DAY,
      updatedAt: now - 10 * DAY
    }
  ]);

  /* ----------------------------------------------------------------- invoices */
  const invAlphaDec = nid("inv");
  const invAlphaJan = nid("inv");
  const invMeridianJan = nid("inv");
  const invCedarJan = nid("inv");
  const invFalcon = nid("inv");
  const invOryx = nid("inv");
  const invOverage = nid("inv");

  const line = (description: string, quantity: number, unitMinor: number) => ({
    description,
    quantity,
    unitMinor,
    amountMinor: quantity * unitMinor
  });

  await db.insert(schema.ledgerInvoices).values([
    {
      id: invAlphaDec,
      tenantId,
      number: `INV-${lastMonth.replace("-", "")}-0044`,
      customerRef: `channel:${ctx.channels.brokerAlpha}`,
      subscriptionId: subAlpha,
      subtotalMinor: 450_000,
      taxMinor: 22_500,
      totalMinor: 472_500,
      currency: BASE,
      linesJson: JSON.stringify([line(`Broker portal, growth — ${lastMonthName}`, 1, 450_000)]),
      state: "paid",
      dueAt: monthStart(0) - DAY,
      issuedAt: monthStart(-1) + DAY,
      paidAt: monthStart(-1) + 9 * DAY,
      createdAt: monthStart(-1) + DAY,
      updatedAt: monthStart(-1) + 9 * DAY
    },
    {
      id: invAlphaJan,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0051`,
      customerRef: `channel:${ctx.channels.brokerAlpha}`,
      subscriptionId: subAlpha,
      subtotalMinor: 450_000,
      taxMinor: 22_500,
      totalMinor: 472_500,
      currency: BASE,
      linesJson: JSON.stringify([line(`Broker portal, growth — ${thisMonthName}`, 1, 450_000)]),
      state: "issued",
      dueAt: now + 9 * DAY,
      issuedAt: now + HOUR,
      txnId: txSubInvoice,
      createdAt: now + HOUR,
      updatedAt: now + HOUR
    },
    {
      id: invMeridianJan,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0052`,
      customerRef: `channel:${ctx.channels.bankEmbed}`,
      subscriptionId: subMeridian,
      subtotalMinor: 1_800_000,
      taxMinor: 90_000,
      totalMinor: 1_890_000,
      currency: BASE,
      linesJson: JSON.stringify([line(`Embedded distribution, enterprise — ${thisMonthName}`, 1, 1_800_000)]),
      state: "issued",
      dueAt: now + 24 * DAY,
      issuedAt: now + HOUR,
      createdAt: now + HOUR,
      updatedAt: now + HOUR
    },
    {
      // Still a draft: finance holds insurer-portal invoices until the seat count
      // is confirmed on the first working day.
      id: invCedarJan,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0053`,
      customerRef: `provider:${ctx.providers.cedar}`,
      subscriptionId: subCedar,
      subtotalMinor: 120_000,
      taxMinor: 6_000,
      totalMinor: 126_000,
      currency: BASE,
      linesJson: JSON.stringify([line(`Insurer portal, standard — ${thisMonthName}`, 1, 120_000)]),
      state: "draft",
      createdAt: now + HOUR,
      updatedAt: now + HOUR
    },
    {
      // Zero-rated: an export of services outside the GCC VAT net.
      id: invFalcon,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0054`,
      customerRef: `provider:${ctx.providers.falcon}`,
      subscriptionId: subFalcon,
      subtotalMinor: 480_000,
      taxMinor: 0,
      totalMinor: 480_000,
      currency: "USD",
      linesJson: JSON.stringify([line("Market data feed — twelve months", 1, 480_000)]),
      state: "issued",
      dueAt: now + 27 * DAY,
      issuedAt: now + 3 * HOUR,
      txnId: txFalconInvoice,
      createdAt: now + 3 * HOUR,
      updatedAt: now + 3 * HOUR
    },
    {
      id: invOryx,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0055`,
      customerRef: `provider:${ctx.providers.oryx}`,
      subscriptionId: subOryx,
      subtotalMinor: 95_000,
      taxMinor: 4_750,
      totalMinor: 99_750,
      currency: BASE,
      linesJson: JSON.stringify([line(`Insurer portal, standard — ${thisMonthName}`, 1, 95_000)]),
      state: "overdue",
      dueAt: now - 3 * DAY,
      issuedAt: now - 18 * DAY,
      createdAt: now - 18 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: invOverage,
      tenantId,
      number: `INV-${thisMonth.replace("-", "")}-0056`,
      customerRef: `channel:${ctx.channels.brokerAlpha}`,
      subscriptionId: subAlpha,
      subtotalMinor: 38_400,
      taxMinor: 1_920,
      totalMinor: 40_320,
      currency: BASE,
      linesJson: JSON.stringify([line("API calls above bundle (128,000 @ 0.30)", 128_000, 30)]),
      state: "issued",
      dueAt: now + 14 * DAY,
      issuedAt: now + 5 * HOUR,
      txnId: txOverage,
      createdAt: now + 5 * HOUR,
      updatedAt: now + 5 * HOUR
    }
  ]);

  /* -------------------------------------------------------- revenue schedules */
  // Nothing is recognised before it is earned: January is done, the rest of
  // Falcon's year sits in deferred revenue waiting its month.
  await db.insert(schema.ledgerRevenueSchedules).values([
    {
      id: nid("rev"),
      tenantId,
      invoiceId: invAlphaJan,
      accountCode: "4040",
      period: thisMonth,
      plannedMinor: 450_000,
      recognizedMinor: 450_000,
      currency: BASE,
      txnId: txSubRecog,
      state: "recognized"
    },
    {
      id: nid("rev"),
      tenantId,
      invoiceId: invAlphaDec,
      accountCode: "4040",
      period: lastMonth,
      plannedMinor: 450_000,
      recognizedMinor: 450_000,
      currency: BASE,
      state: "recognized"
    },
    {
      id: nid("rev"),
      tenantId,
      invoiceId: invFalcon,
      accountCode: "4060",
      period: thisMonth,
      plannedMinor: 40_000,
      recognizedMinor: 40_000,
      currency: "USD",
      state: "recognized"
    },
    {
      id: nid("rev"),
      tenantId,
      invoiceId: invFalcon,
      accountCode: "4060",
      period: monthKey(now, 1),
      plannedMinor: 40_000,
      recognizedMinor: 0,
      currency: "USD",
      state: "scheduled"
    },
    {
      id: nid("rev"),
      tenantId,
      invoiceId: invFalcon,
      accountCode: "4060",
      period: monthKey(now, 2),
      plannedMinor: 40_000,
      recognizedMinor: 0,
      currency: "USD",
      state: "scheduled"
    },
    {
      // invMeridianJan (Meridian, not Gulf Health) carries no `txnId` at all —
      // it was never posted, so there is nothing in 2300 for a recognition to
      // release. Left `scheduled` it stayed due, and the sweep would have
      // released 1,800,000 out of deferred revenue this invoice never
      // deferred, taking 2300 negative on its own invoice the moment February
      // closed. `cancelled` says so.
      id: nid("rev"),
      tenantId,
      invoiceId: invMeridianJan,
      accountCode: "4040",
      period: monthKey(now, 1),
      plannedMinor: 1_800_000,
      recognizedMinor: 0,
      currency: BASE,
      state: "cancelled"
    }
  ]);

  /* ------------------------------------------------------------ usage meters */
  await db.insert(schema.ledgerUsageMeters).values([
    {
      id: nid("usg"),
      tenantId,
      subscriptionId: subAlpha,
      meter: "api_calls",
      period: thisMonth,
      quantity: 228_000,
      includedQuantity: 100_000,
      // The 128,000 units over the bundle are the 38,400 the OVERAGE transaction
      // above already invoiced (under its own `overage:{channel}:{month}` key).
      // Without this the billing sweep would recompute and bill them again.
      overageInvoicedQuantity: 128_000,
      unitPriceMicro: 300_000,
      updatedAt: now + 5 * HOUR
    },
    {
      id: nid("usg"),
      tenantId,
      subscriptionId: subAlpha,
      meter: "api_calls",
      period: lastMonth,
      quantity: 94_100,
      includedQuantity: 100_000,
      unitPriceMicro: 300_000,
      updatedAt: monthStart(0) - HOUR
    },
    {
      id: nid("usg"),
      tenantId,
      subscriptionId: subAlpha,
      meter: "seats",
      period: thisMonth,
      quantity: 12,
      includedQuantity: 10,
      unitPriceMicro: 25_000_000,
      updatedAt: now + 5 * HOUR
    },
    {
      id: nid("usg"),
      tenantId,
      subscriptionId: subMeridian,
      meter: "binds",
      period: thisMonth,
      quantity: 214,
      includedQuantity: 500,
      unitPriceMicro: 1_500_000,
      updatedAt: now + 5 * HOUR
    },
    {
      id: nid("usg"),
      tenantId,
      subscriptionId: subMeridian,
      meter: "ai_tokens",
      period: thisMonth,
      quantity: 4_120_000,
      includedQuantity: 2_000_000,
      unitPriceMicro: 12,
      updatedAt: now + 5 * HOUR
    },
    {
      // Platform-wide inference, not billed to any one subscription — it is the
      // number the AI COGS line is checked against.
      id: nid("usg"),
      tenantId,
      subscriptionId: null,
      meter: "ai_tokens",
      period: thisMonth,
      quantity: 18_400_000,
      includedQuantity: 0,
      unitPriceMicro: 9,
      updatedAt: now + 5 * HOUR
    }
  ]);

  /* ----------------------------------------------------------------- payments */
  await db.insert(schema.ledgerPayments).values([
    {
      id: nid("pay"),
      tenantId,
      txnId: txPremCollect,
      direction: "in",
      method: "card",
      providerRef: "tap_ch_26010801",
      providerToken: "tok_visa_4242",
      amountMinor: collectedMinor,
      currency: BASE,
      feeMinor: 0,
      state: "settled",
      settlementBatch: `PSP-${thisMonth}-W2`,
      createdAt: issuedAt + 4 * MINUTE,
      updatedAt: issuedAt + 5 * MINUTE
    },
    {
      id: nid("pay"),
      tenantId,
      txnId: txPremRemit,
      direction: "out",
      method: "bank",
      providerRef: "CDR-RMT-26010801",
      amountMinor: premiumMinor,
      currency: BASE,
      feeMinor: 0,
      state: "settled",
      createdAt: issuedAt + 3 * HOUR,
      updatedAt: issuedAt + 3 * HOUR + MINUTE
    },
    {
      id: nid("pay"),
      tenantId,
      direction: "in",
      method: "card",
      providerRef: "tap_ch_25121009",
      providerToken: "tok_mc_5100",
      amountMinor: 472_500,
      currency: BASE,
      feeMinor: 9_450,
      state: "settled",
      settlementBatch: `PSP-${lastMonth}-W2`,
      createdAt: monthStart(-1) + 9 * DAY,
      updatedAt: monthStart(-1) + 11 * DAY
    },
    {
      // The failed one. Oryx's card was declined, which is why their invoice is
      // overdue and their subscription past due — one fact, three screens.
      id: nid("pay"),
      tenantId,
      direction: "in",
      method: "card",
      providerRef: "tap_ch_26010301",
      providerToken: "tok_visa_1881",
      amountMinor: 99_750,
      currency: BASE,
      feeMinor: 0,
      state: "failed",
      failureCode: "card_declined",
      createdAt: now - 3 * DAY,
      updatedAt: now - 3 * DAY + MINUTE
    },
    {
      id: nid("pay"),
      tenantId,
      txnId: txRefundOryx,
      direction: "out",
      method: "card",
      providerRef: "tap_rf_26010401",
      amountMinor: 99_750,
      currency: BASE,
      feeMinor: 0,
      state: "failed",
      failureCode: "psp_timeout",
      createdAt: now - 2 * DAY,
      updatedAt: now - 2 * DAY + 4 * MINUTE
    },
    {
      // Waiting on the second controller, so it has not left the account.
      id: nid("pay"),
      tenantId,
      txnId: txPayoutAlpha,
      direction: "out",
      method: "bank",
      amountMinor: 187_400,
      currency: BASE,
      feeMinor: 0,
      state: "pending",
      createdAt: now - HOUR,
      updatedAt: now - HOUR
    },
    {
      id: nid("pay"),
      tenantId,
      direction: "in",
      method: "bank",
      providerRef: "MER-TT-26010502",
      amountMinor: 1_890_000,
      currency: BASE,
      feeMinor: 0,
      state: "captured",
      createdAt: now - 20 * HOUR,
      updatedAt: now - 19 * HOUR
    }
  ]);

  /* ------------------------------------------------------------ payment plans */
  const instalments = (count: number, firstAt: number, amountMinor: number, paid: number) =>
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        seq: i + 1,
        dueAt: firstAt + i * 30 * DAY,
        amountMinor,
        state: i < paid ? "paid" : "due"
      }))
    );

  await db.insert(schema.ledgerPaymentPlans).values([
    {
      // Rania's renewal, financed by Meridian across four months.
      id: nid("ppl"),
      tenantId,
      subjectRef: `policy:${ctx.renewalPolicyId}`,
      financierRef: `provider:${ctx.providers.meridian}`,
      totalMinor: premiumMinor,
      currency: BASE,
      instalments: 4,
      scheduleJson: instalments(4, now - 90 * DAY, Math.floor(premiumMinor / 4), 3),
      state: "active",
      createdAt: now - 100 * DAY,
      updatedAt: now - 10 * DAY
    },
    {
      id: nid("ppl"),
      tenantId,
      subjectRef: `invoice:${invAlphaDec}`,
      totalMinor: 472_500,
      currency: BASE,
      instalments: 2,
      scheduleJson: instalments(2, monthStart(-1) + 9 * DAY, 236_250, 2),
      state: "completed",
      createdAt: monthStart(-1) + DAY,
      updatedAt: dayIn(3)
    },
    {
      id: nid("ppl"),
      tenantId,
      subjectRef: `invoice:${invOryx}`,
      totalMinor: 99_750,
      currency: BASE,
      instalments: 3,
      scheduleJson: instalments(3, now - 18 * DAY, 33_250, 0),
      state: "defaulted",
      createdAt: now - 18 * DAY,
      updatedAt: now - 3 * DAY
    },
    {
      id: nid("ppl"),
      tenantId,
      subjectRef: `invoice:${invCedarJan}`,
      totalMinor: 126_000,
      currency: BASE,
      instalments: 3,
      scheduleJson: instalments(3, now + 14 * DAY, 42_000, 0),
      state: "cancelled",
      createdAt: now - DAY,
      updatedAt: now - HOUR
    }
  ]);

  /* --------------------------------------------------------------- fx & tax */
  // Rates are stamped onto postings, never fetched at read time, so the history
  // has to be here for a re-run of December's statement to produce December's
  // numbers.
  const asOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
  await db.insert(schema.ledgerFxRates).values([
    { id: nid("fx"), tenantId, fromCurrency: "USD", toCurrency: BASE, ratePpm: 3_672_500, asOf: asOf(monthStart(0) - DAY), source: "cbuae" },
    { id: nid("fx"), tenantId, fromCurrency: "USD", toCurrency: BASE, ratePpm: 3_672_500, asOf: asOf(now), source: "cbuae" },
    { id: nid("fx"), tenantId, fromCurrency: BASE, toCurrency: "USD", ratePpm: 272_294, asOf: asOf(now), source: "cbuae" },
    { id: nid("fx"), tenantId, fromCurrency: "EUR", toCurrency: BASE, ratePpm: 3_974_100, asOf: asOf(monthStart(0) - DAY), source: "ecb" },
    { id: nid("fx"), tenantId, fromCurrency: "EUR", toCurrency: BASE, ratePpm: 3_985_600, asOf: asOf(now), source: "ecb" },
    { id: nid("fx"), tenantId, fromCurrency: "GBP", toCurrency: BASE, ratePpm: 4_612_300, asOf: asOf(now), source: "ecb" }
  ]);

  // Tax treatment comes from the rulepack, never inferred at posting time.
  await db.insert(schema.ledgerTaxRules).values([
    {
      id: nid("tax"),
      tenantId,
      market: "AE",
      code: "VAT-STD",
      ratePpm: 50_000,
      placeOfSupply: "AE",
      reverseCharge: false,
      exempt: false,
      effectiveFrom: Date.UTC(2018, 0, 1)
    },
    {
      // Services billed outside the GCC — Falcon's data feed rides this rule.
      id: nid("tax"),
      tenantId,
      market: "AE",
      code: "VAT-ZERO-EXPORT",
      ratePpm: 0,
      placeOfSupply: "OUTSIDE",
      reverseCharge: false,
      exempt: false,
      effectiveFrom: Date.UTC(2018, 0, 1)
    },
    {
      // Imported inference: we account for the VAT on the provider's behalf.
      id: nid("tax"),
      tenantId,
      market: "AE",
      code: "VAT-RC-IMPORT",
      ratePpm: 50_000,
      placeOfSupply: "AE",
      reverseCharge: true,
      exempt: false,
      effectiveFrom: Date.UTC(2018, 0, 1)
    },
    {
      id: nid("tax"),
      tenantId,
      market: "AE",
      code: "VAT-EXEMPT-LIFE",
      ratePpm: 0,
      placeOfSupply: "AE",
      reverseCharge: false,
      exempt: true,
      effectiveFrom: Date.UTC(2018, 0, 1)
    },
    {
      // Superseded when the market moved from 5% to 15%; kept so a restatement
      // of an old period still uses the rate that applied then.
      id: nid("tax"),
      tenantId,
      market: "SA",
      code: "VAT-STD",
      ratePpm: 50_000,
      placeOfSupply: "SA",
      reverseCharge: false,
      exempt: false,
      effectiveFrom: Date.UTC(2018, 0, 1),
      effectiveTo: Date.UTC(2020, 6, 1)
    },
    {
      id: nid("tax"),
      tenantId,
      market: "SA",
      code: "VAT-STD",
      ratePpm: 150_000,
      placeOfSupply: "SA",
      reverseCharge: false,
      exempt: false,
      effectiveFrom: Date.UTC(2020, 6, 1)
    }
  ]);

  /* -------------------------------------------------------------- settlements */
  await db.insert(schema.ledgerSettlements).values([
    {
      // Approved but not yet paid: the second signature is the thing standing
      // between this row and the bank.
      id: nid("stl"),
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: `channel:${ctx.channels.brokerAlpha}`,
      period: lastMonth,
      grossMinor: 240_000,
      adjustmentsMinor: -52_600,
      netMinor: 187_400,
      currency: BASE,
      state: "approved",
      approvedBy: analyst,
      txnId: txPayoutAlpha,
      createdAt: dayIn(2),
      updatedAt: now - HOUR
    },
    {
      id: nid("stl"),
      tenantId,
      counterpartyKind: "insurer",
      counterpartyRef: `provider:${ctx.providers.cedar}`,
      period: lastMonth,
      grossMinor: cedarAccruedMinor,
      adjustmentsMinor: 0,
      netMinor: cedarAccruedMinor,
      currency: BASE,
      state: "paid",
      approvedBy: controller,
      txnId: txCedarSettle,
      createdAt: monthStart(-1) + 26 * DAY,
      updatedAt: monthStart(-1) + 27 * DAY + HOUR
    },
    {
      // Still a draft: the bank's own statement has not been loaded, so the
      // adjustments column is provisional.
      id: nid("stl"),
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: `channel:${ctx.channels.bankEmbed}`,
      period: lastMonth,
      grossMinor: 512_000,
      adjustmentsMinor: -18_000,
      netMinor: 494_000,
      currency: BASE,
      state: "draft",
      createdAt: dayIn(2),
      updatedAt: dayIn(2)
    },
    {
      id: nid("stl"),
      tenantId,
      counterpartyKind: "insurer",
      counterpartyRef: `provider:${ctx.providers.falcon}`,
      period: monthBefore,
      grossMinor: 214_800,
      adjustmentsMinor: -6_400,
      netMinor: 208_400,
      currency: BASE,
      state: "paid",
      approvedBy: controller,
      createdAt: monthStart(-1) + 2 * DAY,
      updatedAt: monthStart(-1) + 8 * DAY
    },
    {
      // Oryx disputes a clawback on three cancelled policies; nothing moves until
      // the evidence bundle is agreed.
      id: nid("stl"),
      tenantId,
      counterpartyKind: "insurer",
      counterpartyRef: `provider:${ctx.providers.oryx}`,
      period: lastMonth,
      grossMinor: 96_200,
      adjustmentsMinor: -31_500,
      netMinor: 64_700,
      currency: BASE,
      state: "disputed",
      createdAt: dayIn(2),
      updatedAt: now - 4 * DAY
    }
  ]);

  /* ---------------------------------------------------------- reconciliation */
  const runCedar = nid("rcr");
  const runFalcon = nid("rcr");
  const runPsp = nid("rcr");
  const runClientMoney = nid("rcr");
  const runAlpha = nid("rcr");

  await db.insert(schema.ledgerReconRuns).values([
    {
      id: runCedar,
      tenantId,
      process: "insurer",
      period: lastMonth,
      counterpartyRef: `provider:${ctx.providers.cedar}`,
      matchedCount: 42,
      varianceCount: 0,
      varianceMinor: 0,
      currency: BASE,
      state: "closed",
      closedBy: controller,
      createdAt: dayIn(1),
      updatedAt: dayIn(2)
    },
    {
      id: runFalcon,
      tenantId,
      process: "insurer",
      period: lastMonth,
      counterpartyRef: `provider:${ctx.providers.falcon}`,
      matchedCount: 28,
      varianceCount: 2,
      varianceMinor: 3_580,
      currency: BASE,
      state: "review",
      createdAt: dayIn(1),
      updatedAt: now - 5 * HOUR
    },
    {
      id: runPsp,
      tenantId,
      process: "psp",
      period: thisMonth,
      counterpartyRef: "psp:tap",
      matchedCount: 61,
      varianceCount: 1,
      varianceMinor: 9_450,
      currency: BASE,
      state: "review",
      createdAt: now - 6 * HOUR,
      updatedAt: now - 2 * HOUR
    },
    {
      id: runClientMoney,
      tenantId,
      process: "client_money",
      period: thisMonth,
      matchedCount: 12,
      varianceCount: 0,
      varianceMinor: 0,
      currency: BASE,
      state: "running",
      createdAt: now - 30 * MINUTE,
      updatedAt: now - 30 * MINUTE
    },
    {
      // The partner statement arrived as a scanned image the parser could not
      // read; the run failed rather than guessing at the numbers.
      id: runAlpha,
      tenantId,
      process: "partner",
      period: lastMonth,
      counterpartyRef: `channel:${ctx.channels.brokerAlpha}`,
      matchedCount: 0,
      varianceCount: 0,
      varianceMinor: 0,
      currency: BASE,
      state: "failed",
      createdAt: dayIn(1),
      updatedAt: dayIn(1) + MINUTE
    }
  ]);

  // Deterministic matches confirm themselves; anything the AI proposed waits for
  // a human, however confident it was (docs/19 §6).
  await db.insert(schema.ledgerReconMatches).values([
    {
      id: nid("rcm"),
      tenantId,
      runId: runCedar,
      statementLineRef: "CDR-STM-2512-0041",
      txnId: txCedarSettle,
      amountMinor: cedarAccruedMinor,
      currency: BASE,
      deltaMinor: 0,
      method: "deterministic",
      confidence: 100,
      state: "confirmed",
      confirmedBy: "system:recon",
      confirmedAt: dayIn(1),
      createdAt: dayIn(1)
    },
    {
      id: nid("rcm"),
      tenantId,
      runId: runFalcon,
      statementLineRef: "FAL-STM-2512-0112",
      amountMinor: 44_800,
      currency: BASE,
      deltaMinor: -180,
      method: "tolerance",
      confidence: 90,
      state: "proposed",
      createdAt: dayIn(1)
    },
    {
      id: nid("rcm"),
      tenantId,
      runId: runFalcon,
      statementLineRef: "FAL-STM-2512-0119",
      amountMinor: 12_600,
      currency: BASE,
      deltaMinor: 0,
      method: "ai_proposed",
      confidence: 74,
      state: "proposed",
      reasonCode: "narrative_match",
      createdAt: dayIn(1)
    },
    {
      // The unmatched line: a credit on the statement with nothing behind it.
      id: nid("rcm"),
      tenantId,
      runId: runFalcon,
      statementLineRef: "FAL-STM-2512-0131",
      amountMinor: 3_400,
      currency: BASE,
      deltaMinor: 3_400,
      method: "ai_proposed",
      confidence: 38,
      state: "unmatched",
      reasonCode: "no_confident_match",
      createdAt: dayIn(1)
    },
    {
      id: nid("rcm"),
      tenantId,
      runId: runPsp,
      statementLineRef: "TAP-2601-0007",
      txnId: txPspSettle,
      amountMinor: 472_500,
      currency: BASE,
      deltaMinor: 0,
      method: "deterministic",
      confidence: 100,
      state: "confirmed",
      confirmedBy: "system:recon",
      confirmedAt: now - 5 * HOUR,
      createdAt: now - 6 * HOUR
    },
    {
      id: nid("rcm"),
      tenantId,
      runId: runPsp,
      statementLineRef: "TAP-2601-0011",
      amountMinor: 9_450,
      currency: BASE,
      deltaMinor: 9_450,
      method: "deterministic",
      confidence: 100,
      state: "unmatched",
      reasonCode: "no_match",
      createdAt: now - 6 * HOUR
    },
    {
      // The provider sent the same file twice; a human rejected the duplicate
      // rather than letting a second match post.
      id: nid("rcm"),
      tenantId,
      runId: runPsp,
      statementLineRef: "TAP-2601-0007-DUP",
      amountMinor: 472_500,
      currency: BASE,
      deltaMinor: 0,
      method: "tolerance",
      confidence: 88,
      state: "rejected",
      reasonCode: "duplicate_statement_line",
      confirmedBy: analyst,
      confirmedAt: now - 2 * HOUR,
      createdAt: now - 6 * HOUR
    },
    {
      id: nid("rcm"),
      tenantId,
      runId: runClientMoney,
      statementLineRef: "BNK-CM-2601-0003",
      txnId: txPremCollect,
      amountMinor: collectedMinor,
      currency: BASE,
      deltaMinor: 0,
      method: "deterministic",
      confidence: 100,
      state: "confirmed",
      confirmedBy: "system:recon",
      confirmedAt: now - 29 * MINUTE,
      createdAt: now - 30 * MINUTE
    }
  ]);
}

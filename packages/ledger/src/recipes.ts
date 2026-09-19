import { z } from "zod";
import { account } from "@lyra/db";
import { badRequest, splitCommission } from "@lyra/core";
import type { PostingLine, Side } from "./posting.js";

// docs/19 §5.2 A–G. A recipe turns a business fact into journal lines and does
// nothing else — no database, no state, no side effects — so every posting shape
// in the system is unit-testable in isolation and readable in one screen.
//
// The aggregator model runs through all of these: we earn commission from an
// underwriter, owe a share of it to the channel that produced the business, and
// hold the customer's premium as client money in between.

const Pos = z.number().int().positive();
const NonNeg = z.number().int().nonnegative();
const Ppm = z.number().int().nonnegative();
const Dims = z.record(z.string(), z.union([z.string(), z.number()])).optional();
const Memo = z.string().max(200).optional();

export type RecipeArgs = Record<string, unknown>;
export type RecipeBuilder = (args: never) => PostingLine[];

function line(
  accountCode: string,
  side: Side,
  amountMinor: number,
  memo?: string,
  dims?: Record<string, string | number>
): PostingLine {
  return { accountCode, side, amountMinor, ...(memo ? { memo } : {}), ...(dims ? { dims } : {}) };
}

/** Drop zero-value legs: a zero line is noise in the journal, not information. */
function lines(...ls: (PostingLine | null)[]): PostingLine[] {
  return ls.filter((l): l is PostingLine => l !== null && l.amountMinor > 0);
}

/* ------------------------------------------------- A. commission earnings */

const CommissionArgs = z.object({
  /** Explicit split, or premium + rates for the engine to compute. */
  grossMinor: Pos.optional(),
  channelMinor: NonNeg.optional(),
  taxMinor: NonNeg.optional(),
  premiumMinor: Pos.optional(),
  baseCommissionPpm: Ppm.optional(),
  channelSharePpm: Ppm.optional(),
  taxPpm: Ppm.optional(),
  flatFeeMinor: NonNeg.optional(),
  /** 4000 new, 4010 renewal, 4020 brokerage, 4030 referral, 4070 ads, 4075 marketplace. */
  incomeAccount: z.string().default("4000"),
  /** 1100 commission receivable, 1150 financier, 1160 trade. */
  receivableAccount: z.string().default("1100"),
  memo: Memo,
  dims: Dims
});
export type CommissionArgs = z.infer<typeof CommissionArgs>;

/**
 * docs/19 §5.2 A extended for the channel leg: the underwriter owes us the gross
 * commission, of which the B2B channel's share is a liability from the moment we
 * earn it — never revenue we recognise and later pay away.
 */
export function commissionAccrual(a: CommissionArgs): PostingLine[] {
  const split =
    a.grossMinor !== undefined
      ? {
          grossMinor: a.grossMinor,
          channelMinor: a.channelMinor ?? 0,
          taxMinor: a.taxMinor ?? 0,
          netMinor: a.grossMinor - (a.channelMinor ?? 0) - (a.taxMinor ?? 0)
        }
      : splitCommission({
          premiumMinor: required(a.premiumMinor, "premiumMinor"),
          baseCommissionPpm: required(a.baseCommissionPpm, "baseCommissionPpm"),
          ...(a.channelSharePpm !== undefined ? { channelSharePpm: a.channelSharePpm } : {}),
          ...(a.taxPpm !== undefined ? { taxPpm: a.taxPpm } : {}),
          ...(a.flatFeeMinor !== undefined ? { flatFeeMinor: a.flatFeeMinor } : {})
        });

  if (split.netMinor < 0) throw badRequest("commission split leaves negative net income");
  return lines(
    line(a.receivableAccount, "debit", split.grossMinor, a.memo ?? "commission earned", a.dims),
    line(a.incomeAccount, "credit", split.netMinor, "our share", a.dims),
    line("2100", "credit", split.channelMinor, "channel share payable", a.dims),
    line("2200", "credit", split.taxMinor, "tax on commission", a.dims)
  );
}

const SettleArgs = z.object({
  amountMinor: Pos,
  receivableAccount: z.string().default("1100"),
  cashAccount: z.string().default("1000"),
  feeMinor: NonNeg.default(0),
  memo: Memo,
  dims: Dims
});

/** Cash arrives from the insurer or PSP; the receivable clears, fees are expensed. */
export function receivableSettlement(a: z.infer<typeof SettleArgs>): PostingLine[] {
  return lines(
    line(a.cashAccount, "debit", a.amountMinor - a.feeMinor, a.memo ?? "settlement received", a.dims),
    line("5300", "debit", a.feeMinor, "processing fee", a.dims),
    line(a.receivableAccount, "credit", a.amountMinor, a.memo ?? "receivable cleared", a.dims)
  );
}

const ClawbackArgs = z.object({
  amountMinor: Pos,
  receivableAccount: z.string().default("1100"),
  channelMinor: NonNeg.default(0),
  memo: Memo,
  dims: Dims
});

/**
 * A cancelled policy takes the commission back. The channel's share comes back
 * with it — the payable is reduced rather than a new receivable created, because
 * we net it against the channel's next settlement.
 */
export function commissionClawback(a: z.infer<typeof ClawbackArgs>): PostingLine[] {
  return lines(
    line("5000", "debit", a.amountMinor - a.channelMinor, a.memo ?? "commission clawed back", a.dims),
    line("2100", "debit", a.channelMinor, "channel share recovered", a.dims),
    line(a.receivableAccount, "credit", a.amountMinor, a.memo ?? "clawback", a.dims)
  );
}

/* ---------------------------------------------------------- B. client money */

const ClientMoneyArgs = z.object({ amountMinor: Pos, memo: Memo, dims: Dims });

/** Premium collected on the insurer's behalf. Ours to hold, never ours to spend. */
export function clientMoneyReceipt(a: z.infer<typeof ClientMoneyArgs>): PostingLine[] {
  return lines(
    line("1010", "debit", a.amountMinor, a.memo ?? "premium received", a.dims),
    line("2010", "credit", a.amountMinor, a.memo ?? "held for insurer", a.dims)
  );
}

/** Premium paid over to the underwriter; the liability and the cash leave together. */
export function premiumRemittance(a: z.infer<typeof ClientMoneyArgs>): PostingLine[] {
  return lines(
    line("2010", "debit", a.amountMinor, a.memo ?? "remitted to insurer", a.dims),
    line("1010", "credit", a.amountMinor, a.memo ?? "remitted to insurer", a.dims)
  );
}

const TransferArgs = CommissionArgs.extend({ amountMinor: Pos });

/**
 * docs/19 §5.2 B: the only legitimate route from client money to own funds. The
 * transfer and the income recognition are one batch so the two can never drift —
 * money leaves the client account exactly as commission is recognised.
 */
export function clientMoneyTransfer(a: z.infer<typeof TransferArgs>): PostingLine[] {
  const earned = commissionAccrual({ ...a, receivableAccount: "1000" });
  const moved = earned
    .filter((l) => l.side === "debit" && l.accountCode === "1000")
    .reduce((s, l) => s + l.amountMinor, 0);
  if (moved !== a.amountMinor) {
    throw badRequest(`transfer amount ${a.amountMinor} does not equal commission earned ${moved}`);
  }
  return [
    line("2010", "debit", a.amountMinor, a.memo ?? "commission drawn from client money", a.dims),
    line("1010", "credit", a.amountMinor, a.memo ?? "commission drawn from client money", a.dims),
    ...earned
  ];
}

/* ------------------------------------------------------------ B2. claims */

// Funding a claim float and paying out of it are client-money moves in both
// directions, so they reuse the premium shapes rather than clone two identical
// lines: CLAIM-FUND is `clientMoneyReceipt`, CLAIM-PAY is `premiumRemittance`.
// Only the memo differs, and the memo is the caller's to pass.

// Recovered money arrives into client money gross and is owed onward to the
// insurer; our handling fee is drawn out afterwards by RECOVERY-FEE, which is
// `clientMoneyTransfer` pointed at 4090. Design §B.4 wanted the fee split
// inside the receipt itself, but docs/19 §5.2 B forbids recognising income in
// any batch that debits the client-money asset — the money is not ours until
// it has left the client account, and the transfer is what makes it leave.
// RECOVERY-RECEIPT is therefore plain `clientMoneyReceipt`.

const RecoveryArgs = z.object({
  amountMinor: Pos,
  receivableAccount: z.string().default("1155"),
  memo: Memo,
  dims: Dims
});

/** Pursuit abandoned: the receivable we raised comes off as a cost. */
export function recoveryWriteOff(a: z.infer<typeof RecoveryArgs>): PostingLine[] {
  return lines(
    line("5450", "debit", a.amountMinor, a.memo ?? "recovery written off", a.dims),
    line(a.receivableAccount, "credit", a.amountMinor, "recovery receivable cleared", a.dims)
  );
}

/* ------------------------------------------ C. partner & channel settlement */

const AccrualArgs = z.object({
  amountMinor: Pos,
  expenseAccount: z.string().default("5400"),
  payableAccount: z.string().default("2100"),
  memo: Memo,
  dims: Dims
});

/** Rev share, media, creator and supplier costs all accrue the same way. */
export function expenseAccrual(a: z.infer<typeof AccrualArgs>): PostingLine[] {
  return lines(
    line(a.expenseAccount, "debit", a.amountMinor, a.memo ?? "accrued", a.dims),
    line(a.payableAccount, "credit", a.amountMinor, a.memo ?? "accrued", a.dims)
  );
}

const PayoutArgs = z.object({
  amountMinor: Pos,
  payableAccount: z.string().default("2100"),
  cashAccount: z.string().default("1000"),
  withholdingMinor: NonNeg.default(0),
  memo: Memo,
  dims: Dims
});

/** Money out to a counterparty; withholding tax stays behind as a liability. */
export function payout(a: z.infer<typeof PayoutArgs>): PostingLine[] {
  return lines(
    line(a.payableAccount, "debit", a.amountMinor, a.memo ?? "settled", a.dims),
    line("2200", "credit", a.withholdingMinor, "withholding tax", a.dims),
    line(a.cashAccount, "credit", a.amountMinor - a.withholdingMinor, a.memo ?? "paid", a.dims)
  );
}

/* -------------------------------------------- D. subscriptions & platform */

const InvoiceArgs = z.object({
  netMinor: Pos,
  taxMinor: NonNeg.default(0),
  /** 2300 when the revenue is still deferred, an income account when earned now. */
  creditAccount: z.string().default("2300"),
  receivableAccount: z.string().default("1160"),
  memo: Memo,
  dims: Dims
});

export function invoiceRaised(a: z.infer<typeof InvoiceArgs>): PostingLine[] {
  return lines(
    line(a.receivableAccount, "debit", a.netMinor + a.taxMinor, a.memo ?? "invoice raised", a.dims),
    line(a.creditAccount, "credit", a.netMinor, a.memo ?? "invoice raised", a.dims),
    line("2200", "credit", a.taxMinor, "output tax", a.dims)
  );
}

const RecogniseArgs = z.object({
  amountMinor: Pos,
  incomeAccount: z.string().default("4040"),
  deferredAccount: z.string().default("2300"),
  memo: Memo,
  dims: Dims
});

/** Monthly release of deferred revenue; the schedule lives in ledger_revenue_schedules. */
export function revenueRecognition(a: z.infer<typeof RecogniseArgs>): PostingLine[] {
  return lines(
    line(a.deferredAccount, "debit", a.amountMinor, a.memo ?? "revenue recognised", a.dims),
    line(a.incomeAccount, "credit", a.amountMinor, a.memo ?? "revenue recognised", a.dims)
  );
}

const CreditNoteArgs = z.object({
  netMinor: Pos,
  taxMinor: NonNeg.default(0),
  debitAccount: z.string().default("2300"),
  receivableAccount: z.string().default("1160"),
  memo: Memo,
  dims: Dims
});

/** A credit note is a contra invoice, not a deletion of the original. */
export function creditNote(a: z.infer<typeof CreditNoteArgs>): PostingLine[] {
  return lines(
    line(a.debitAccount, "debit", a.netMinor, a.memo ?? "credit note", a.dims),
    line("2200", "debit", a.taxMinor, "tax adjustment", a.dims),
    line(a.receivableAccount, "credit", a.netMinor + a.taxMinor, a.memo ?? "credit note", a.dims)
  );
}

/* --------------------------------------------------- money in, money back */

const DepositArgs = z.object({
  amountMinor: Pos,
  cashAccount: z.string().default("1000"),
  liabilityAccount: z.string().default("2350"),
  memo: Memo,
  dims: Dims
});

export function depositTaken(a: z.infer<typeof DepositArgs>): PostingLine[] {
  return lines(
    line(a.cashAccount, "debit", a.amountMinor, a.memo ?? "deposit taken", a.dims),
    line(a.liabilityAccount, "credit", a.amountMinor, a.memo ?? "customer deposit", a.dims)
  );
}

const RefundArgs = z.object({
  amountMinor: Pos,
  liabilityAccount: z.string().default("2400"),
  cashAccount: z.string().default("1000"),
  memo: Memo,
  dims: Dims
});

export function refundPaid(a: z.infer<typeof RefundArgs>): PostingLine[] {
  return lines(
    line(a.liabilityAccount, "debit", a.amountMinor, a.memo ?? "refund paid", a.dims),
    line(a.cashAccount, "credit", a.amountMinor, a.memo ?? "refund paid", a.dims)
  );
}

const ChargebackArgs = z.object({
  amountMinor: Pos,
  feeMinor: NonNeg.default(0),
  cashAccount: z.string().default("1000"),
  receivableAccount: z.string().default("1200"),
  memo: Memo,
  dims: Dims
});

/**
 * The bank has taken the money back, so the customer owes it again and the
 * scheme fee is ours. Winning the dispute reverses only the receivable leg —
 * the fee is rarely returned, so it is not assumed back.
 */
export function chargeback(a: z.infer<typeof ChargebackArgs>): PostingLine[] {
  return lines(
    line(a.receivableAccount, "debit", a.amountMinor, a.memo ?? "chargeback raised", a.dims),
    line("5300", "debit", a.feeMinor, "chargeback fee", a.dims),
    line(a.cashAccount, "credit", a.amountMinor + a.feeMinor, a.memo ?? "chargeback debited", a.dims)
  );
}

export function chargebackWon(a: z.infer<typeof ChargebackArgs>): PostingLine[] {
  return lines(
    line(a.cashAccount, "debit", a.amountMinor, a.memo ?? "chargeback recovered", a.dims),
    line(a.receivableAccount, "credit", a.amountMinor, a.memo ?? "chargeback recovered", a.dims)
  );
}

/* --------------------------------- G. reconciliation write-off (docs/27) */

const WriteOffArgs = z.object({
  amountMinor: Pos,
  /**
   * Which way the residual runs, stated rather than inferred from a sign: a
   * signed amount inverts silently when a caller flips an operand, and the two
   * directions post to opposite sides of the same two accounts.
   *
   * `shortfall` — the counterparty paid less than we booked and we are giving
   * up the rest, so the balance clears against the write-off expense.
   * `surplus`   — they paid more, so the same expense is credited back.
   */
  direction: z.enum(["shortfall", "surplus"]),
  /** The account carrying the residual: 1100 commission receivable, 1300 PSP clearing, 2100 payable. */
  clearingAccount: z.string().regex(/^\d{4}$/, "account code is four digits").default("1100"),
  writeOffAccount: z.string().regex(/^5\d{3}$/, "a write-off lands in an expense account").default("5500"),
  /** A write-off has no business event behind it; the reason is the only thing an auditor can read. */
  reason: z.string().min(10).max(500),
  dims: Dims
});
export type WriteOffArgs = z.infer<typeof WriteOffArgs>;

/**
 * docs/27 "thin screens": reconciliation leaves residual differences — a few
 * fils of premium tax rounding, a PSP fee booked to the cent — and without an
 * instrument for them a run can never reach nothing-left-open, so it can never
 * close. This is that instrument and nothing more: two lines, balanced by
 * construction, against one named clearing account.
 *
 * It refuses the two things a write-off must never be able to do. Client money
 * is segregated (CBUAE): a shortfall there is a reportable breach to escalate,
 * not a difference to make disappear, and writing it off would leave 1010 < 2010
 * with the journal saying it was fine. Equity moves only at the year-end close.
 * The same two refusals `manualJournal` makes, for the same reasons.
 */
export function reconWriteOff(a: WriteOffArgs): PostingLine[] {
  for (const code of [a.clearingAccount, a.writeOffAccount]) {
    if (account(code)?.clientMoney) {
      throw badRequest(
        `a write-off may not touch client money account ${code}; a client-money difference is a breach to escalate`
      );
    }
    if (code.startsWith("3")) {
      throw badRequest(`a write-off may not touch equity account ${code}; use YEAR-END-CLOSE`);
    }
  }
  if (!account(a.clearingAccount)) throw badRequest(`unknown account ${a.clearingAccount}`);
  if (!account(a.writeOffAccount)) throw badRequest(`unknown account ${a.writeOffAccount}`);

  const [debit, credit] =
    a.direction === "shortfall"
      ? [a.writeOffAccount, a.clearingAccount]
      : [a.clearingAccount, a.writeOffAccount];
  return lines(
    line(debit, "debit", a.amountMinor, a.reason, a.dims),
    line(credit, "credit", a.amountMinor, a.reason, a.dims)
  );
}

/* ------------------------------- H. manual & structural entries (F2, F3) */

const AuthoredLine = z.object({
  accountCode: z.string().regex(/^\d{4}$/, "account code is four digits"),
  side: z.enum(["debit", "credit"]),
  amountMinor: Pos,
  memo: Memo,
  dims: Dims
});

const AuthoredArgs = z.object({
  lines: z.array(AuthoredLine).min(2),
  /** A hand-written entry has no business event behind it; the reason is the
   *  only thing an auditor can read. Ten characters is the floor for "why". */
  reason: z.string().min(10).max(500),
  dims: Dims
});
export type AuthoredArgs = z.infer<typeof AuthoredArgs>;

/** Authored lines are the one shape whose balance nothing upstream guarantees. */
function assertBalanced(ls: PostingLine[], what: string): void {
  const debit = ls.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
  const credit = ls.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);
  if (debit !== credit) {
    throw badRequest(`${what} does not balance: debits ${debit} ≠ credits ${credit}`);
  }
}

function authored(a: AuthoredArgs): PostingLine[] {
  return a.lines.map((l) =>
    line(l.accountCode, l.side, l.amountMinor, l.memo ?? a.reason, l.dims ?? a.dims)
  );
}

/**
 * docs/27 F2. The one instrument that can express any entry — accrual, reclass,
 * correction — and therefore the one that must not be able to express the two
 * things it would quietly destroy: segregated client money (CBUAE), and equity,
 * which only the year-end close may move.
 */
export function manualJournal(a: AuthoredArgs): PostingLine[] {
  for (const l of a.lines) {
    if (account(l.accountCode)?.clientMoney) {
      throw badRequest(`a manual journal may not touch client money account ${l.accountCode}`);
    }
    if (l.accountCode.startsWith("3")) {
      throw badRequest(`a manual journal may not touch equity account ${l.accountCode}; use YEAR-END-CLOSE`);
    }
  }
  const built = authored(a);
  assertBalanced(built, "manual journal");
  return built;
}

/**
 * docs/27 F3. A broker migrating onto Lyra genuinely arrives with a client
 * account balance and share capital, so the opening balance is the one authored
 * entry allowed to state both — which is why it is once-per-tenant
 * (`firstPeriodOnly` in preconditions.ts) rather than merely dual-controlled.
 */
export function openingBalance(a: AuthoredArgs): PostingLine[] {
  const built = authored(a);
  assertBalanced(built, "opening balance");
  return built;
}

const YearEndArgs = z.object({
  /** One leg per income/expense account, on the side that zeroes it. */
  closingLines: z.array(AuthoredLine).min(1),
  retainedEarningsAccount: z.string().regex(/^3\d{3}$/, "retained earnings must be an equity account").default("3100"),
  fiscalYear: z.number().int().min(2000).max(2200),
  memo: Memo,
  dims: Dims
});
export type YearEndArgs = z.infer<typeof YearEndArgs>;

/**
 * docs/27 F3. The residual is computed here rather than passed in: a caller
 * that could state retained earnings could state the wrong number, and the
 * balance sheet would carry it forever. The entry balances by construction.
 */
export function yearEndClose(a: YearEndArgs): PostingLine[] {
  for (const l of a.closingLines) {
    if (!/^[45]/.test(l.accountCode)) {
      throw badRequest(`year-end close may only close income and expense accounts, not ${l.accountCode}`);
    }
  }
  const closing = a.closingLines.map((l) =>
    line(l.accountCode, l.side, l.amountMinor, l.memo ?? `close ${a.fiscalYear}`, l.dims ?? a.dims)
  );
  const debit = closing.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
  const credit = closing.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);
  const net = debit - credit;
  const memo = `retained earnings ${a.fiscalYear}`;
  return lines(
    ...closing,
    net > 0 ? line(a.retainedEarningsAccount, "credit", net, memo, a.dims) : null,
    net < 0 ? line(a.retainedEarningsAccount, "debit", -net, memo, a.dims) : null
  );
}

/* ------------------------------------------------------------ the registry */

interface RecipeSpec {
  schema: z.ZodType;
  build: (args: never) => PostingLine[];
  /** Defaults folded in before validation, so `POST /v1/txn/BIND` needs no account codes. */
  defaults?: Record<string, unknown>;
}

function spec<S extends z.ZodType>(
  schema: S,
  build: (args: z.output<S>) => PostingLine[],
  defaults?: Record<string, unknown>
): RecipeSpec {
  return { schema, build: build as (args: never) => PostingLine[], ...(defaults ? { defaults } : {}) };
}

/**
 * Every financial transaction code in docs/19 §4 maps to exactly one recipe.
 * The generic `POST /v1/txn/{type}` endpoint validates against this table, so a
 * new transaction type is a row here — never a new branch in the engine.
 */
export const RECIPES: Record<string, RecipeSpec> = {
  // distribution lifecycle
  BIND: spec(CommissionArgs, commissionAccrual, { incomeAccount: "4000" }),
  "BIND-GROUP": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4000" }),
  RENEW: spec(CommissionArgs, commissionAccrual, { incomeAccount: "4010" }),
  ENDORSE: spec(CommissionArgs, commissionAccrual, { incomeAccount: "4000" }),
  // Deliberately identical to ENDORSE: a telemetry-driven reprice is an
  // endorsement that posts to the same income account. The row exists because
  // every financial type needs one for `POST /v1/txn/{type}`, and identical
  // rows are the point — the two codes differ in provenance, not in posting.
  "UBI-REPRICE": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4000" }),
  REINSTATE: spec(CommissionArgs, commissionAccrual, { incomeAccount: "4010" }),
  CANCEL: spec(ClawbackArgs, commissionClawback),
  "PARTNER-BIND": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4075" }),
  "AGENT-BIND": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4000" }),

  // claims (design §B.4)
  "CLAIM-FUND": spec(ClientMoneyArgs, clientMoneyReceipt),
  "CLAIM-PAY": spec(ClientMoneyArgs, premiumRemittance),
  "RECOVERY-RECEIPT": spec(ClientMoneyArgs, clientMoneyReceipt),
  "RECOVERY-REMIT": spec(ClientMoneyArgs, premiumRemittance),
  "RECOVERY-WRITEOFF": spec(RecoveryArgs, recoveryWriteOff),
  "RECOVERY-FEE": spec(TransferArgs, clientMoneyTransfer, { incomeAccount: "4090" }),

  // money in
  "PREM-COLLECT": spec(ClientMoneyArgs, clientMoneyReceipt),
  "PREM-INSTALMENT": spec(ClientMoneyArgs, clientMoneyReceipt),
  "CM-RECEIPT": spec(ClientMoneyArgs, clientMoneyReceipt),
  "DEPOSIT-TAKE": spec(DepositArgs, depositTaken),
  "PSP-SETTLE": spec(SettleArgs, receivableSettlement, { receivableAccount: "1300" }),
  CHARGEBACK: spec(ChargebackArgs, chargeback),
  "CHARGEBACK-WIN": spec(ChargebackArgs, chargebackWon),

  // money out
  "PREM-REMIT": spec(ClientMoneyArgs, premiumRemittance),
  "CM-TRANSFER": spec(TransferArgs, clientMoneyTransfer),
  "REFUND-ISSUE": spec(RefundArgs, refundPaid),
  "PAYOUT-INSTRUCT": spec(PayoutArgs, payout),
  "RSHARE-SETL": spec(PayoutArgs, payout, { payableAccount: "2100" }),
  "CREATOR-PAYOUT": spec(PayoutArgs, payout, { payableAccount: "2150" }),
  "SUPPLIER-PAY": spec(PayoutArgs, payout, { payableAccount: "2250" }),

  // earnings & accruals
  "CMSN-ACCR": spec(CommissionArgs, commissionAccrual),
  "CMSN-SETL": spec(SettleArgs, receivableSettlement),
  "CMSN-CLAWBACK": spec(ClawbackArgs, commissionClawback),
  "FEE-BROK": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4020", receivableAccount: "1160" }),
  "FEE-SERVICE": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4090", receivableAccount: "1160" }),
  "REFERRAL-SETL": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4030", receivableAccount: "1160" }),
  "FIN-CMSN": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4080", receivableAccount: "1150" }),
  "AD-PLACEMENT": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4070", receivableAccount: "1160" }),
  "EXT-RSHARE": spec(CommissionArgs, commissionAccrual, { incomeAccount: "4075", receivableAccount: "1160" }),
  "RSHARE-ACCR": spec(AccrualArgs, expenseAccrual),
  "RSHARE-ADJUST": spec(AccrualArgs, expenseAccrual),
  "SURPLUS-DIST": spec(AccrualArgs, expenseAccrual, { expenseAccount: "5400", payableAccount: "2100" }),

  // subscriptions & platform billing
  "SUB-INVOICE": spec(InvoiceArgs, invoiceRaised),
  "SUB-RECOG": spec(RecogniseArgs, revenueRecognition),
  "SUB-CHANGE": spec(InvoiceArgs, invoiceRaised),
  "SUB-CANCEL": spec(CreditNoteArgs, creditNote),
  OVERAGE: spec(InvoiceArgs, invoiceRaised, { creditAccount: "4050" }),
  "SUCCESS-FEE": spec(InvoiceArgs, invoiceRaised, { creditAccount: "4090" }),
  "CREDIT-NOTE": spec(CreditNoteArgs, creditNote),

  // marketing & content
  "MEDIA-SPEND": spec(AccrualArgs, expenseAccrual, { expenseAccount: "5100", payableAccount: "2250" }),
  BOOST: spec(AccrualArgs, expenseAccrual, { expenseAccount: "5100", payableAccount: "2250" }),

  // reconciliation
  "RECON-WRITEOFF": spec(WriteOffArgs, reconWriteOff),

  // manual & structural (docs/27 F2, F3)
  "MANUAL-JRNL": spec(AuthoredArgs, manualJournal),
  "OPEN-BAL": spec(AuthoredArgs, openingBalance),
  "YEAR-END-CLOSE": spec(YearEndArgs, yearEndClose)
};

/**
 * One argument of a recipe, flat enough to render as an input. The schema stays
 * private — this is the shape of the question, not the shape of the validation.
 */
export interface ArgField {
  name: string;
  /** `integer` is a whole number: minor units, parts-per-million, a count. */
  kind: "integer" | "text";
  required: boolean;
  /** What the recipe posts to if the operator says nothing. */
  default?: string | number;
  /** A closed set the answer must come from: the UI offers these and nothing else. */
  options?: string[];
}

/**
 * The recipe's arguments as a field list, so `POST /v1/ledger/txn-types` can
 * publish them and the UI can ask for money in a money field instead of asking
 * a controller to hand-type JSON (docs/ui.md §7 P3-16).
 *
 * Kind and optionality are probed through `safeParse` rather than read off zod
 * internals: the answer is then whatever the schema actually accepts, and it
 * survives a zod upgrade.
 *
 * A probe only ever answers with the samples it was shown, which is how a field
 * a recipe *requires* can drop out of the list entirely and leave a type nothing
 * can post. Two shapes did: an enum (`"sample text"` is not one of its members)
 * and a pattern-constrained string (`clearingAccount` is four digits). So the
 * probe list carries the field's own default and its own members — `options` is
 * a public accessor, not an internal — and the UI renders a closed set as a
 * picker rather than as free text.
 */
function memberOptions(field: z.ZodType): string[] | null {
  const raw = (field as unknown as { options?: unknown }).options;
  return Array.isArray(raw) && raw.length > 0 && raw.every((v) => typeof v === "string")
    ? (raw as string[])
    : null;
}

export function argFields(code: string): ArgField[] {
  const s = RECIPES[code];
  if (!s) return [];
  const shape = (s.schema as unknown as { shape: Record<string, z.ZodType> }).shape;
  return Object.entries(shape).flatMap(([name, field]) => {
    // Dimensions are free-form analysis tags, not a question with an answer.
    if (name === "dims") return [];
    const blank = field.safeParse(undefined);
    const options = memberOptions(field);
    const declared = s.defaults?.[name] ?? (blank.success ? blank.data : undefined);
    // The text probe has to clear a minimum length: a one-character sample would
    // report an auditable-reason field as unrenderable rather than as text.
    const samples = ["sample text", ...(options ?? []), ...(typeof declared === "string" ? [declared] : [])];
    // `1` is not a fiscal year: a bounded integer refuses it and would drop out
    // of the list, so the probe carries a number inside the ranges this file
    // actually declares as well.
    const numbers = [1, 2026, ...(typeof declared === "number" ? [declared] : [])];
    const kind = numbers.some((sample) => field.safeParse(sample).success)
      ? "integer"
      : samples.some((sample) => field.safeParse(sample).success)
        ? "text"
        : null;
    if (!kind) return [];
    return [
      {
        name,
        kind,
        required: !blank.success,
        ...(typeof declared === "string" || typeof declared === "number" ? { default: declared } : {}),
        ...(options ? { options } : {})
      } satisfies ArgField
    ];
  });
}

/** Validate and build. The only entry point the API layer needs. */
export function buildRecipe(code: string, args: RecipeArgs): PostingLine[] {
  const s = RECIPES[code];
  if (!s) throw badRequest(`no posting recipe for transaction type ${code}`);
  const parsed = s.schema.safeParse({ ...s.defaults, ...args });
  if (!parsed.success) {
    const errors = Object.fromEntries(
      parsed.error.issues.map((i) => [i.path.join(".") || "_", i.message])
    );
    throw badRequest(`invalid arguments for ${code}`, errors);
  }
  const built = s.build(parsed.data as never);
  if (built.length < 2) throw badRequest(`recipe ${code} produced fewer than two lines`);
  return built;
}

function required<T>(v: T | undefined, name: string): T {
  if (v === undefined) throw badRequest(`${name} is required`);
  return v;
}

import { and, eq, sql } from "drizzle-orm";
import {
  CLIENT_MONEY_ACCOUNT,
  CLIENT_MONEY_LIABILITY_ACCOUNT,
  account,
  atomically,
  id,
  schema,
  type Write
} from "@lyra/db";
import { PPM, actorRef, applyPpm, badRequest, conflict, type Ctx } from "@lyra/core";
import { assertPostable, ensurePeriod, periodCode } from "./periods.js";

// docs/19 §5. The double-entry engine. Every financial transaction in the system
// posts through here — there is no second path that writes ledger_journal_lines.
//
// Three rules are enforced at post time rather than in a nightly job, because a
// ledger that is briefly wrong is a ledger nobody trusts:
//   1. the batch balances in transaction *and* base currency,
//   2. no batch debits segregated client money to credit income or expense,
//   3. client-money assets never fall below client-money liabilities.
//
// All three are decided before anything is written, because the write itself is
// a single atomic batch (docs/19 §5, the `atomically` seam in @lyra/db). A post
// therefore lands whole or not at all: no header without its lines, no balance
// bump without the lines it summarises.

export type Side = "debit" | "credit";

export interface PostingLine {
  accountCode: string;
  side: Side;
  /** Positive minor units; `side` carries the sign. */
  amountMinor: number;
  memo?: string;
  /** Reporting dimensions: provider, partner, channel, campaign, product. */
  dims?: Record<string, string | number>;
  /** Pre-computed base amount; otherwise derived from `fxRatePpm`. */
  baseAmountMinor?: number;
}

export interface PostInput {
  txnId: string;
  currency: string;
  baseCurrency?: string;
  /** Rate to base, parts per million. 1_000_000 = same currency. */
  fxRatePpm?: number;
  lines: readonly PostingLine[];
  /** Defaults to the period containing `postedAt`. */
  periodCode?: string;
  /** Set on reversal batches; the one thing a hard-closed period still accepts. */
  reversalOfBatchId?: string;
  /** Required to post into a soft-closed period. */
  reason?: string;
  postedAt?: number;
}

export interface PostedBatch {
  batchId: string;
  periodId: string;
  totalMinor: number;
  baseTotalMinor: number;
  lineCount: number;
}

function assertAmount(n: number, what: string): void {
  if (!Number.isInteger(n)) throw badRequest(`${what} must be integer minor units, got ${n}`);
  if (n <= 0) throw badRequest(`${what} must be positive; use the opposite side, not a negative amount`);
  if (!Number.isSafeInteger(n)) throw badRequest(`${what} exceeds safe integer range`);
}

/**
 * FX rounding leaves a residual: converting each line independently can put the
 * base debits a unit or two away from the base credits. We place the whole
 * residual on the largest line of the heavier side — largest because a one-unit
 * nudge distorts it least in relative terms, and one line because spreading it
 * makes every line's base amount un-reproducible from its own source amount.
 */
function balanceBase(lines: { side: Side; baseAmountMinor: number }[]): void {
  const total = (s: Side) => lines.filter((l) => l.side === s).reduce((a, l) => a + l.baseAmountMinor, 0);
  const diff = total("debit") - total("credit");
  if (diff === 0) return;

  const heavy: Side = diff > 0 ? "debit" : "credit";
  let target: { side: Side; baseAmountMinor: number } | undefined;
  for (const l of lines) {
    if (l.side === heavy && (!target || l.baseAmountMinor > target.baseAmountMinor)) target = l;
  }
  if (!target) throw badRequest("cannot balance base currency: no line on the heavier side");
  const adjusted = target.baseAmountMinor - Math.abs(diff);
  if (adjusted <= 0) throw badRequest("fx residual exceeds the line it would be absorbed by");
  target.baseAmountMinor = adjusted;
}

const INCOME_OR_EXPENSE = /^[45]/;

/** An error plus every `cause` under it, flattened to text for matching. */
function chain(err: unknown): string {
  let out = "";
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    out += ` ${String(e)}`;
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * docs/19 §5.2 B: client money is a pass-through, never a revenue source. The
 * check is on the client-money *asset* — CM-TRANSFER legitimately debits the
 * 2010 liability to move an earned commission into own funds.
 */
function assertClientMoneyShape(lines: readonly PostingLine[]): void {
  const debitsClientMoney = lines.some((l) => {
    const a = account(l.accountCode);
    return l.side === "debit" && Boolean(a?.clientMoney) && a?.type === "asset";
  });
  if (!debitsClientMoney) return;
  const bad = lines.find((l) => l.side === "credit" && INCOME_OR_EXPENSE.test(l.accountCode));
  if (bad) {
    throw badRequest(
      `a batch debiting client money may not credit ${bad.accountCode}; transfer to own funds first (CM-TRANSFER)`
    );
  }
}

/**
 * The tenant's rate from `from` to its reporting currency, parts per million, or
 * undefined when it has none on file.
 *
 * `ledger_fx_rates` is where a tenant's rates live, and until now nothing read
 * them: every caller had to hand `post()` a rate it had no way to know, so any
 * transaction in a currency other than the tenant's default was refused outright
 * (subscriptions, overages and data-product deliveries all bill in their own
 * contract's currency). Resolving it here rather than in each caller means the
 * rate is found once, on the one path that needs it.
 *
 * ponytail: newest row wins. A back-dated posting wanting the rate of its own
 * value date filters on `as_of <= postedAt` — add that when back-dating exists.
 */
export async function fxRateFor(ctx: Ctx, from: string, to?: string): Promise<number | undefined> {
  const base = to ?? ctx.policy.currency;
  if (from === base) return PPM;
  const [row] = await ctx.db
    .select({ ratePpm: schema.ledgerFxRates.ratePpm })
    .from(schema.ledgerFxRates)
    .where(
      and(
        eq(schema.ledgerFxRates.tenantId, ctx.tenantId),
        eq(schema.ledgerFxRates.fromCurrency, from),
        eq(schema.ledgerFxRates.toCurrency, base)
      )
    )
    .orderBy(sql`${schema.ledgerFxRates.asOf} desc`)
    .limit(1);
  return row?.ratePpm;
}

export async function post(ctx: Ctx, input: PostInput): Promise<PostedBatch> {
  if (input.lines.length < 2) throw badRequest("a journal batch needs at least two lines");

  const postedAt = input.postedAt ?? ctx.now;
  const baseCurrency = input.baseCurrency ?? ctx.policy.currency;
  const fxRatePpm = input.fxRatePpm ?? (await fxRateFor(ctx, input.currency, baseCurrency));
  if (!fxRatePpm) throw badRequest(`no fx rate supplied for ${input.currency} -> ${baseCurrency}`);
  if (fxRatePpm <= 0) throw badRequest("fx rate must be positive");

  const prepared = input.lines.map((l, i) => {
    assertAmount(l.amountMinor, `line ${i} amount`);
    if (!account(l.accountCode)) throw badRequest(`unknown account ${l.accountCode}`);
    const base = l.baseAmountMinor ?? applyPpm(l.amountMinor, fxRatePpm);
    assertAmount(base, `line ${i} base amount`);
    return { ...l, baseAmountMinor: base };
  });

  const debit = prepared.filter((l) => l.side === "debit").reduce((a, l) => a + l.amountMinor, 0);
  const credit = prepared.filter((l) => l.side === "credit").reduce((a, l) => a + l.amountMinor, 0);
  if (debit !== credit) throw badRequest(`batch does not balance: debits ${debit} vs credits ${credit}`);
  if (debit === 0) throw badRequest("a journal batch may not be all zeroes");

  balanceBase(prepared);
  assertClientMoneyShape(prepared);

  const code = input.periodCode ?? periodCode(postedAt);
  const period = await ensurePeriod(ctx, code);
  assertPostable(period, {
    ...(input.reversalOfBatchId ? { contra: true as const } : {}),
    ...(input.reason ? { reason: input.reason } : {})
  });

  const baseDebit = prepared.filter((l) => l.side === "debit").reduce((a, l) => a + l.baseAmountMinor, 0);
  // Summed rather than copied from the debit side: balanceBase() has just made
  // the two equal, and a header that cannot disagree with itself proves nothing.
  const baseCredit = prepared.filter((l) => l.side === "credit").reduce((a, l) => a + l.baseAmountMinor, 0);
  const batchId = id("bat", postedAt);

  const deltas = aggregate(prepared);
  // Decided against the position this batch *would* leave behind, so a breach
  // refuses the write instead of being discovered after it.
  const cmCheck = await clientMoneyCheck(ctx, input.currency, input.txnId, postedAt, deltas);

  const writes: Write[] = [
    ctx.db.insert(schema.ledgerJournalBatches).values({
      id: batchId,
      tenantId: ctx.tenantId,
      txnId: input.txnId,
      periodId: period.id,
      currency: input.currency,
      baseCurrency,
      fxRatePpm,
      totalDebitMinor: debit,
      totalCreditMinor: credit,
      baseTotalDebitMinor: baseDebit,
      baseTotalCreditMinor: baseCredit,
      reversalOfBatchId: input.reversalOfBatchId ?? null,
      postedBy: actorRef(ctx),
      postedAt
    }),

    ctx.db.insert(schema.ledgerJournalLines).values(
      prepared.map((l, i) => ({
        id: id("jln", postedAt),
        tenantId: ctx.tenantId,
        batchId,
        txnId: input.txnId,
        seq: i + 1,
        accountCode: l.accountCode,
        side: l.side,
        amountMinor: l.amountMinor,
        currency: input.currency,
        baseAmountMinor: l.baseAmountMinor,
        baseCurrency,
        memo: l.memo ?? null,
        dimsJson: l.dims ? JSON.stringify(l.dims) : null,
        postedAt
      }))
    ),

    ...balanceWrites(ctx, input.currency, deltas, postedAt),
    ...(cmCheck ? [ctx.db.insert(schema.ledgerClientMoneyChecks).values(cmCheck)] : []),

    ctx.db
      .update(schema.ledgerTxns)
      .set({ ledgerBatchId: batchId, fxRatePpm, updatedAt: postedAt })
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.id, input.txnId)))
  ];

  // The unique index on (tenant, txn) is what makes replay post nothing new:
  // a second post() for the same transaction is a conflict, not a duplicate batch.
  try {
    await atomically(ctx.db, writes);
  } catch (err) {
    // Drivers wrap: the text that names the constraint is on a `cause` a level
    // or two down ("Failed query: insert into …" is all the outer message says).
    if (/ledger_batches_txn_uq|unique/i.test(chain(err))) {
      throw conflict(`transaction ${input.txnId} already has a posted batch`);
    }
    throw err;
  }

  return {
    batchId,
    periodId: period.id,
    totalMinor: debit,
    baseTotalMinor: baseDebit,
    lineCount: prepared.length
  };
}

interface Delta {
  debit: number;
  credit: number;
  baseDebit: number;
  baseCredit: number;
}

/** The batch's net effect per account. One upsert per account, not per line. */
function aggregate(
  lines: readonly { accountCode: string; side: Side; amountMinor: number; baseAmountMinor: number }[]
): Map<string, Delta> {
  const agg = new Map<string, Delta>();
  for (const l of lines) {
    const a = agg.get(l.accountCode) ?? { debit: 0, credit: 0, baseDebit: 0, baseCredit: 0 };
    if (l.side === "debit") {
      a.debit += l.amountMinor;
      a.baseDebit += l.baseAmountMinor;
    } else {
      a.credit += l.amountMinor;
      a.baseCredit += l.baseAmountMinor;
    }
    agg.set(l.accountCode, a);
  }
  return agg;
}

/**
 * Running balances are a cache of the lines, maintained in the same write so a
 * report never has to re-sum a year of journal. reports.ts rebuilds from lines
 * to prove the cache agrees — which only means anything because these statements
 * ride in the same batch as the lines they summarise.
 */
function balanceWrites(ctx: Ctx, currency: string, agg: Map<string, Delta>, at: number): Write[] {
  const writes: Write[] = [];
  for (const [accountCode, a] of agg) {
    writes.push(
      ctx.db
        .insert(schema.ledgerAccountBalances)
        .values({
          id: id("bal", at),
          tenantId: ctx.tenantId,
          accountCode,
          currency,
          debitMinor: a.debit,
          creditMinor: a.credit,
          baseDebitMinor: a.baseDebit,
          baseCreditMinor: a.baseCredit,
          updatedAt: at
        })
        .onConflictDoUpdate({
          target: [
            schema.ledgerAccountBalances.tenantId,
            schema.ledgerAccountBalances.accountCode,
            schema.ledgerAccountBalances.currency
          ],
          set: {
            debitMinor: sql`${schema.ledgerAccountBalances.debitMinor} + ${a.debit}`,
            creditMinor: sql`${schema.ledgerAccountBalances.creditMinor} + ${a.credit}`,
            baseDebitMinor: sql`${schema.ledgerAccountBalances.baseDebitMinor} + ${a.baseDebit}`,
            baseCreditMinor: sql`${schema.ledgerAccountBalances.baseCreditMinor} + ${a.baseCredit}`,
            updatedAt: at
          }
        })
    );
  }
  return writes;
}

export interface Balance {
  accountCode: string;
  currency: string;
  debitMinor: number;
  creditMinor: number;
  baseDebitMinor: number;
  baseCreditMinor: number;
  /** Signed by the account's normal side: positive means "as expected". */
  balanceMinor: number;
}

export async function balanceOf(ctx: Ctx, accountCode: string, currency: string): Promise<Balance> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerAccountBalances)
    .where(
      and(
        eq(schema.ledgerAccountBalances.tenantId, ctx.tenantId),
        eq(schema.ledgerAccountBalances.accountCode, accountCode),
        eq(schema.ledgerAccountBalances.currency, currency)
      )
    )
    .limit(1);

  const r = rows[0] ?? {
    debitMinor: 0,
    creditMinor: 0,
    baseDebitMinor: 0,
    baseCreditMinor: 0
  };
  const normal = account(accountCode)?.normalSide ?? "debit";
  const signed = normal === "debit" ? r.debitMinor - r.creditMinor : r.creditMinor - r.debitMinor;
  return {
    accountCode,
    currency,
    debitMinor: r.debitMinor,
    creditMinor: r.creditMinor,
    baseDebitMinor: r.baseDebitMinor,
    baseCreditMinor: r.baseCreditMinor,
    balanceMinor: signed
  };
}

/** A delta applied to a balance, signed by that account's normal side. */
function signedDelta(accountCode: string, agg: Map<string, Delta>): number {
  const d = agg.get(accountCode);
  if (!d) return 0;
  return (account(accountCode)?.normalSide ?? "debit") === "debit"
    ? d.debit - d.credit
    : d.credit - d.debit;
}

/**
 * docs/19 §5.2 B, the invariant the regulator actually cares about: the money we
 * hold for clients (asset 1010) is never less than what we owe them (liability
 * 2010). Checked on every posting rather than nightly, and recorded either way
 * so the compliance evidence exists without a separate job.
 *
 * The position tested is the one the batch *would* leave behind, so a breach
 * refuses the write rather than being found after it. On a breach the evidence
 * row is written on its own and then the post is rejected — the alarm has to
 * outlive the batch it stopped, so it cannot ride inside it.
 *
 * Returns the row to include in the batch, or null when there is no client
 * money in this currency at all and nothing worth recording.
 */
export async function clientMoneyCheck(
  ctx: Ctx,
  currency: string,
  triggeredBy: string,
  at: number,
  agg: Map<string, Delta>
): Promise<typeof schema.ledgerClientMoneyChecks.$inferInsert | null> {
  const asset = (await balanceOf(ctx, CLIENT_MONEY_ACCOUNT, currency)).balanceMinor
    + signedDelta(CLIENT_MONEY_ACCOUNT, agg);
  const liability = (await balanceOf(ctx, CLIENT_MONEY_LIABILITY_ACCOUNT, currency)).balanceMinor
    + signedDelta(CLIENT_MONEY_LIABILITY_ACCOUNT, agg);
  if (asset === 0 && liability === 0) return null;

  // docs/19 §11.11 (docs/27 F22). The shortfall test below compares the two
  // balances against *each other*, and that is not the same question as whether
  // either of them is possible. Paying out of a float nobody funded moves both
  // by the same amount — `CLAIM-PAY` is Dr 2010 / Cr 1010 — so asset and
  // liability go negative together, stay equal, and the segregation check sees
  // nothing wrong. A bank account cannot hold less than nothing, so the second
  // question has to be asked separately: this is what stops a claim float going
  // negative, and it was the property test that found it.
  if (asset < 0) {
    const row = {
      id: id("cmc", at),
      tenantId: ctx.tenantId,
      assetMinor: asset,
      liabilityMinor: liability,
      currency,
      shortfallMinor: -asset,
      breach: true,
      triggeredBy,
      resolvedAt: null,
      ts: at
    };
    await ctx.db.insert(schema.ledgerClientMoneyChecks).values(row);
    throw conflict(
      `client money account would go to ${asset} ${currency}: there is nothing in the float to pay out of`
    );
  }

  const shortfall = liability - asset;
  const breach = shortfall > 0;
  const row = {
    id: id("cmc", at),
    tenantId: ctx.tenantId,
    assetMinor: asset,
    liabilityMinor: liability,
    currency,
    shortfallMinor: breach ? shortfall : 0,
    breach,
    triggeredBy,
    resolvedAt: null,
    ts: at
  };
  if (!breach) return row;

  await ctx.db.insert(schema.ledgerClientMoneyChecks).values(row);
  throw conflict(
    `client money shortfall of ${shortfall} ${currency}: asset ${asset} < liability ${liability}`
  );
}

/**
 * Reversal is a new contra batch, never an edit: posted lines are immutable.
 * Sides are flipped and base amounts copied so the pair nets to exactly zero
 * even when the original carried an FX residual.
 */
export async function reverse(
  ctx: Ctx,
  batchId: string,
  opts: { txnId: string; reason: string; postedAt?: number }
): Promise<PostedBatch> {
  const batches = await ctx.db
    .select()
    .from(schema.ledgerJournalBatches)
    .where(
      and(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId), eq(schema.ledgerJournalBatches.id, batchId))
    )
    .limit(1);
  const batch = batches[0];
  if (!batch) throw badRequest(`no journal batch ${batchId}`);

  const already = await ctx.db
    .select({ id: schema.ledgerJournalBatches.id })
    .from(schema.ledgerJournalBatches)
    .where(
      and(
        eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId),
        eq(schema.ledgerJournalBatches.reversalOfBatchId, batchId)
      )
    )
    .limit(1);
  if (already[0]) throw conflict(`batch ${batchId} is already reversed by ${already[0].id}`);

  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(
      and(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId), eq(schema.ledgerJournalLines.batchId, batchId))
    )
    .orderBy(schema.ledgerJournalLines.seq);

  return post(ctx, {
    txnId: opts.txnId,
    currency: batch.currency,
    baseCurrency: batch.baseCurrency,
    fxRatePpm: batch.fxRatePpm,
    reversalOfBatchId: batchId,
    reason: opts.reason,
    ...(opts.postedAt !== undefined ? { postedAt: opts.postedAt } : {}),
    lines: lines.map((l) => ({
      accountCode: l.accountCode,
      side: (l.side === "debit" ? "credit" : "debit") as Side,
      amountMinor: l.amountMinor,
      baseAmountMinor: l.baseAmountMinor,
      memo: `reversal of ${batchId}: ${opts.reason}`
    }))
  });
}

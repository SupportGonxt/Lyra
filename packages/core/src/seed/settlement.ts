import { and, eq, sql } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { splitCommission } from "../commission.js";
import { DAY, HOUR, type SeedContext } from "./context.js";
import { dayIntoMonth } from "./period.js";

// docs/19 §5 — the payout side of the commission story the ledger seed tells.
// Axis sells, dist accrues what the channel earned, and this seeder pays it:
// one month settled and out the door, one month signed but waiting on the
// second signature, this month still being drafted, and one the counterparty
// is arguing about.
//
// The rules that shape it are the engine's, not the seed's: every batch
// balances in txn and base currency, entries that have been paid carry a
// `channel_settlement_id` and entries that have not are the next run's carry.

interface SeedLine {
  code: string;
  side: "debit" | "credit";
  amountMinor: number;
  memo: string;
  dims: Record<string, string>;
}

interface SeedBatch {
  batchId: string;
  txnId: string;
  periodCode: string;
  postedBy: string;
  postedAt: number;
  lines: readonly SeedLine[];
}

/** One line of earned commission, before it becomes rows. */
interface EntrySpec {
  /** The sale this commission was earned on. The seeder mints the policy row. */
  policyNo: string;
  productId: string;
  providerId: string;
  offeringId: string;
  kind: string;
  premiumMinor: number;
  baseCommissionPpm: number;
  channelSharePpm: number;
  earnedAt: number;
}

export async function seedSettlement(ctx: SeedContext): Promise<void> {
  const { db, tenantId, now } = ctx;
  const BASE = "AED";

  let seq = 0;
  const nid = (prefix: string): string => id(prefix, now + seq++);

  const controller = `user:${ctx.users["finance.controller"] ?? "seed"}`;
  const analyst = `user:${ctx.users["finance.analyst"] ?? "seed"}`;

  const monthStart = (delta: number): number => {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1);
  };
  // "N days into the current open month" (docs: dayIntoMonth) — never the
  // closed months above, whose arithmetic is already comfortably in the past.
  const dayIn = (days: number): number => dayIntoMonth(now, 0, days);
  const codeOf = (at: number): string => new Date(at).toISOString().slice(0, 7);
  const thisMonth = codeOf(now);
  const monthBefore = codeOf(monthStart(-2)); // hard closed by the ledger seed

  // Periods belong to the ledger seed; a settlement seed that minted its own
  // would collide with the unique index rather than reuse the closed month it
  // needs. Reading them back is also the assertion that it ran first.
  const periodRows = await db
    .select({ id: schema.ledgerPeriods.id, code: schema.ledgerPeriods.code })
    .from(schema.ledgerPeriods)
    .where(eq(schema.ledgerPeriods.tenantId, tenantId));
  const periodIds = new Map(periodRows.map((p) => [p.code, p.id]));
  const periodId = (code: string): string => {
    const found = periodIds.get(code);
    if (!found) throw new Error(`seed: no ledger period ${code}; the ledger seed has to run first`);
    return found;
  };

  const alpha = `channel:${ctx.channels.brokerAlpha}`;
  const bank = `channel:${ctx.channels.bankEmbed}`;

  /* ----------------------------------------------------------- the earnings */
  // Four buckets of commission entries. The settlement totals below are summed
  // from these, never typed in, so the statement and the settlement agree by
  // construction rather than by proofreading.
  const paidEntries: EntrySpec[] = [
    {
      policyNo: "CDR-MOT-2511-901447",
      productId: ctx.products.motor,
      providerId: ctx.providers.cedar,
      offeringId: ctx.offerings.cedarMotor,
      kind: "new_business",
      premiumMinor: 412_000,
      baseCommissionPpm: 150_000,
      channelSharePpm: 300_000,
      earnedAt: monthStart(-2) + 6 * DAY
    },
    {
      policyNo: "FLC-MOT-2511-664902",
      productId: ctx.products.motor,
      providerId: ctx.providers.falcon,
      offeringId: ctx.offerings.falconMotor,
      kind: "renewal",
      premiumMinor: 288_000,
      baseCommissionPpm: 120_000,
      channelSharePpm: 300_000,
      earnedAt: monthStart(-2) + 17 * DAY
    }
  ];

  const approvedEntries: EntrySpec[] = [
    {
      policyNo: "GLF-HLT-2511-330815",
      productId: ctx.products.health,
      providerId: ctx.providers.gulfHealth,
      offeringId: ctx.offerings.gulfHealth,
      kind: "new_business",
      premiumMinor: 640_000,
      baseCommissionPpm: 180_000,
      channelSharePpm: 400_000,
      earnedAt: monthStart(-2) + 9 * DAY
    }
  ];

  const draftEntries: EntrySpec[] = [
    {
      policyNo: "CDR-MOP-2601-772350",
      productId: ctx.products.motor,
      providerId: ctx.providers.cedar,
      offeringId: ctx.offerings.cedarMotorPlus,
      kind: "new_business",
      // The open month has to clear Alpha's AED 500 minimum payout (their
      // agreement, seed/onboarding.ts), because the engine re-applies that floor
      // when the settlement is approved: under it, the month pays nothing and
      // carries forward, so a smaller draft is one no controller could sign off.
      premiumMinor: 1_248_000,
      baseCommissionPpm: 150_000,
      channelSharePpm: 350_000,
      earnedAt: dayIn(3)
    },
    {
      policyNo: "ORX-MOT-2601-518064",
      productId: ctx.products.motor,
      providerId: ctx.providers.oryx,
      offeringId: ctx.offerings.oryxMotor,
      kind: "renewal",
      premiumMinor: 496_000,
      baseCommissionPpm: 130_000,
      channelSharePpm: 350_000,
      earnedAt: dayIn(8)
    }
  ];

  const disputedEntries: EntrySpec[] = [
    {
      policyNo: "GNX-TRV-2601-140973",
      productId: ctx.products.travel,
      providerId: ctx.providers.gonxt,
      offeringId: ctx.offerings.gonxtTravel,
      kind: "new_business",
      premiumMinor: 348_000,
      baseCommissionPpm: 160_000,
      channelSharePpm: 400_000,
      earnedAt: dayIn(5)
    }
  ];

  const stlPaid = nid("stl");
  const stlApproved = nid("stl");
  const stlDraft = nid("stl");
  const stlDisputed = nid("stl");

  const txAccrual = nid("txn");
  const txPayout = nid("txn");
  const txBankAccrual = nid("txn");

  interface Bucket {
    settlementId: string;
    channelId: string;
    specs: readonly EntrySpec[];
    /** null while the settlement has not been signed off — the run's carry. */
    stamp: string | null;
    state: string;
    txnId: string | null;
  }

  const buckets: Bucket[] = [
    {
      settlementId: stlPaid,
      channelId: ctx.channels.brokerAlpha,
      specs: paidEntries,
      stamp: stlPaid,
      state: "paid",
      txnId: txPayout
    },
    {
      settlementId: stlApproved,
      channelId: ctx.channels.bankEmbed,
      specs: approvedEntries,
      stamp: stlApproved,
      state: "payable",
      txnId: txBankAccrual
    },
    { settlementId: stlDraft, channelId: ctx.channels.brokerAlpha, specs: draftEntries, stamp: null, state: "accrued", txnId: null },
    {
      settlementId: stlDisputed,
      channelId: ctx.channels.bankEmbed,
      specs: disputedEntries,
      stamp: null,
      state: "disputed",
      txnId: null
    }
  ];

  const channelTotal = new Map<string, number>();
  const entries: (typeof schema.distCommissionEntries.$inferInsert)[] = [];
  const policies: (typeof schema.axisPolicies.$inferInsert)[] = [];
  const versions: (typeof schema.axisPolicyVersions.$inferInsert)[] = [];
  for (const bucket of buckets) {
    let total = 0;
    for (const spec of bucket.specs) {
      const split = splitCommission({
        premiumMinor: spec.premiumMinor,
        baseCommissionPpm: spec.baseCommissionPpm,
        channelSharePpm: spec.channelSharePpm
      });
      total += split.channelMinor;
      // Each earning gets its own policy. Reusing the core story's two would
      // show one policy number six times on a remittance advice, and pinning a
      // commission on `renewalPolicyId` would make the renewal-window policy
      // already-accrued — it has to stay clean, because it is the one policy an
      // accrual can still be posted against (apps/api/src/dist.test.ts).
      const policyId = nid("pol");
      const versionId = nid("pver");
      policies.push({
        id: policyId,
        tenantId,
        customerId: ctx.customerId,
        providerId: spec.providerId,
        productId: spec.productId,
        offeringId: spec.offeringId,
        channelId: bucket.channelId,
        policyNo: spec.policyNo,
        startAt: spec.earnedAt,
        endAt: spec.earnedAt + 365 * DAY,
        premiumMinor: spec.premiumMinor,
        currency: BASE,
        commissionMinor: split.grossMinor,
        status: "active",
        currentVersionId: versionId,
        versionSeq: 1,
        createdAt: spec.earnedAt,
        updatedAt: spec.earnedAt
      });
      // A bind always writes version 1 (routes/axis.ts `bindPolicy`), and every
      // mid-term verb reads it: without a schedule these policies are on risk
      // but cannot be endorsed or cancelled — "policy has no effective version".
      versions.push({
        id: versionId,
        tenantId,
        policyId,
        versionSeq: 1,
        reason: "issue",
        effectiveFrom: spec.earnedAt,
        effectiveTo: spec.earnedAt + 365 * DAY,
        premiumMinor: spec.premiumMinor,
        taxMinor: 0,
        feesMinor: 0,
        commissionMinor: split.grossMinor,
        currency: BASE,
        premiumDeltaMinor: 0,
        termsJson: JSON.stringify({ excessMinor: 100_000 }),
        state: "effective",
        issuedBy: analyst,
        issuedAt: spec.earnedAt,
        createdAt: spec.earnedAt,
        updatedAt: spec.earnedAt
      });
      entries.push({
        id: nid("ce"),
        tenantId,
        policyId,
        offeringId: spec.offeringId,
        providerId: spec.providerId,
        channelId: bucket.channelId,
        rateId: null,
        kind: spec.kind,
        premiumMinor: spec.premiumMinor,
        grossCommissionMinor: split.grossMinor,
        channelCommissionMinor: split.channelMinor,
        netCommissionMinor: split.netMinor,
        taxMinor: split.taxMinor,
        currency: BASE,
        earnedOn: "issue",
        earnedAt: spec.earnedAt,
        reversalOf: null,
        providerSettlementId: null,
        channelSettlementId: bucket.stamp,
        txnId: bucket.txnId,
        state: bucket.state,
        createdAt: spec.earnedAt,
        updatedAt: spec.earnedAt + HOUR
      });
    }
    channelTotal.set(bucket.settlementId, total);
  }
  await db.insert(schema.axisPolicies).values(policies);
  await db.insert(schema.axisPolicyVersions).values(versions);
  await db.insert(schema.distCommissionEntries).values(entries);

  const netOf = (settlementId: string): number => channelTotal.get(settlementId) ?? 0;

  /* ----------------------------------------------------------- transactions */
  const accrualAt = monthStart(-1) + 2 * DAY;
  const payoutAt = monthStart(-1) + 11 * DAY;

  await db.insert(schema.ledgerTxns).values([
    {
      id: txAccrual,
      tenantId,
      type: "RSHARE-ACCR",
      idempotencyKey: `rshare-accr:${stlPaid}`,
      correlationId: `settlement:${stlPaid}`,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["finance.controller"] ?? "seed",
      subjectRefsJson: JSON.stringify({ settlement: stlPaid, channel: ctx.channels.brokerAlpha }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: netOf(stlPaid), adjustments: 0, net: netOf(stlPaid) }),
      grossMinor: netOf(stlPaid),
      baseGrossMinor: netOf(stlPaid),
      createdAt: accrualAt,
      updatedAt: accrualAt + HOUR,
      settledAt: accrualAt + HOUR
    },
    {
      // The second signature, and the money leaving. Alpha Brokers' month is
      // closed on both sides of the book.
      id: txPayout,
      tenantId,
      type: "RSHARE-SETL",
      idempotencyKey: `rshare-setl:${stlPaid}`,
      correlationId: `settlement:${stlPaid}`,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["finance.controller"] ?? "seed",
      subjectRefsJson: JSON.stringify({ settlement: stlPaid, channel: ctx.channels.brokerAlpha }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ net: netOf(stlPaid) }),
      grossMinor: netOf(stlPaid),
      baseGrossMinor: netOf(stlPaid),
      createdAt: payoutAt,
      updatedAt: payoutAt + HOUR,
      settledAt: payoutAt + HOUR
    },
    {
      // Meridian's accrual is posted; the payout is not. The payable sitting on
      // 2100 is exactly what the second approval is holding back.
      id: txBankAccrual,
      tenantId,
      type: "RSHARE-ACCR",
      idempotencyKey: `rshare-accr:${stlApproved}`,
      correlationId: `settlement:${stlApproved}`,
      state: "settled",
      actorKind: "user",
      actorId: ctx.users["finance.analyst"] ?? "seed",
      subjectRefsJson: JSON.stringify({ settlement: stlApproved, channel: ctx.channels.bankEmbed }),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      amountsJson: JSON.stringify({ gross: netOf(stlApproved), adjustments: 0, net: netOf(stlApproved) }),
      grossMinor: netOf(stlApproved),
      baseGrossMinor: netOf(stlApproved),
      createdAt: accrualAt,
      updatedAt: accrualAt + HOUR,
      settledAt: accrualAt + HOUR
    }
  ]);

  /* --------------------------------------------------------------- journals */
  // The same lines the recipes produce: RSHARE-ACCR debits 5400 and credits
  // 2100; RSHARE-SETL debits 2100 and credits 1000. No withholding on either,
  // so the payout is two lines rather than three.
  const dims = (settlementId: string, channelId: string, period: string): Record<string, string> => ({
    channel: channelId,
    settlement: settlementId,
    period
  });

  const batches: SeedBatch[] = [
    {
      batchId: nid("bat"),
      txnId: txAccrual,
      periodCode: monthBefore,
      postedBy: controller,
      postedAt: accrualAt + HOUR,
      lines: [
        {
          code: "5400",
          side: "debit",
          amountMinor: netOf(stlPaid),
          memo: `settlement ${monthBefore} ${alpha}`,
          dims: dims(stlPaid, ctx.channels.brokerAlpha, monthBefore)
        },
        {
          code: "2100",
          side: "credit",
          amountMinor: netOf(stlPaid),
          memo: `settlement ${monthBefore} ${alpha}`,
          dims: dims(stlPaid, ctx.channels.brokerAlpha, monthBefore)
        }
      ]
    },
    {
      batchId: nid("bat"),
      txnId: txPayout,
      periodCode: monthBefore,
      postedBy: controller,
      postedAt: payoutAt + HOUR,
      lines: [
        {
          code: "2100",
          side: "debit",
          amountMinor: netOf(stlPaid),
          memo: `payout ${monthBefore} ${alpha}`,
          dims: dims(stlPaid, ctx.channels.brokerAlpha, monthBefore)
        },
        {
          code: "1000",
          side: "credit",
          amountMinor: netOf(stlPaid),
          memo: `payout ${monthBefore} ${alpha}`,
          dims: dims(stlPaid, ctx.channels.brokerAlpha, monthBefore)
        }
      ]
    },
    {
      batchId: nid("bat"),
      txnId: txBankAccrual,
      periodCode: monthBefore,
      postedBy: analyst,
      postedAt: accrualAt + HOUR,
      lines: [
        {
          code: "5400",
          side: "debit",
          amountMinor: netOf(stlApproved),
          memo: `settlement ${monthBefore} ${bank}`,
          dims: dims(stlApproved, ctx.channels.bankEmbed, monthBefore)
        },
        {
          code: "2100",
          side: "credit",
          amountMinor: netOf(stlApproved),
          memo: `settlement ${monthBefore} ${bank}`,
          dims: dims(stlApproved, ctx.channels.bankEmbed, monthBefore)
        }
      ]
    }
  ];

  const balances = new Map<string, { debitMinor: number; creditMinor: number }>();

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
      currency: BASE,
      baseAmountMinor: l.amountMinor, // the AED book, 1:1
      baseCurrency: BASE,
      memo: l.memo,
      dimsJson: JSON.stringify(l.dims),
      postedAt: batch.postedAt
    }));

    const sum = (side: string): number =>
      lines.filter((l) => l.side === side).reduce((n, l) => n + l.amountMinor, 0);
    const debit = sum("debit");
    const credit = sum("credit");
    // Asserted, not assumed: an unbalanced seed batch fails the ledger's own
    // property tests later, somewhere that says nothing about where it came from.
    if (debit !== credit) throw new Error(`seed: batch ${batch.batchId} does not balance (${debit}/${credit})`);

    await db.insert(schema.ledgerJournalBatches).values({
      id: batch.batchId,
      tenantId,
      txnId: batch.txnId,
      periodId: periodId(batch.periodCode),
      currency: BASE,
      baseCurrency: BASE,
      fxRatePpm: 1_000_000,
      totalDebitMinor: debit,
      totalCreditMinor: credit,
      baseTotalDebitMinor: debit,
      baseTotalCreditMinor: credit,
      reversalOfBatchId: null,
      postedBy: batch.postedBy,
      postedAt: batch.postedAt
    });
    await db.insert(schema.ledgerJournalLines).values(lines);
    await db
      .update(schema.ledgerTxns)
      .set({ ledgerBatchId: batch.batchId })
      .where(and(eq(schema.ledgerTxns.tenantId, tenantId), eq(schema.ledgerTxns.id, batch.txnId)));

    for (const l of lines) {
      const b = balances.get(l.accountCode) ?? { debitMinor: 0, creditMinor: 0 };
      if (l.side === "debit") b.debitMinor += l.amountMinor;
      else b.creditMinor += l.amountMinor;
      balances.set(l.accountCode, b);
    }
  }

  // The ledger seed already wrote balance rows for 1000/2100/5400, so these add
  // to what is there rather than replacing it — the cache has to keep agreeing
  // with the sum of the lines, including the ones posted above.
  for (const [accountCode, b] of balances) {
    await db
      .insert(schema.ledgerAccountBalances)
      .values({
        id: nid("bal"),
        tenantId,
        accountCode,
        currency: BASE,
        debitMinor: b.debitMinor,
        creditMinor: b.creditMinor,
        baseDebitMinor: b.debitMinor,
        baseCreditMinor: b.creditMinor,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [
          schema.ledgerAccountBalances.tenantId,
          schema.ledgerAccountBalances.accountCode,
          schema.ledgerAccountBalances.currency
        ],
        set: {
          debitMinor: sql`${schema.ledgerAccountBalances.debitMinor} + ${b.debitMinor}`,
          creditMinor: sql`${schema.ledgerAccountBalances.creditMinor} + ${b.creditMinor}`,
          baseDebitMinor: sql`${schema.ledgerAccountBalances.baseDebitMinor} + ${b.debitMinor}`,
          baseCreditMinor: sql`${schema.ledgerAccountBalances.baseCreditMinor} + ${b.creditMinor}`,
          updatedAt: now
        }
      });
  }

  /* -------------------------------------------------------------- the rows */
  await db.insert(schema.ledgerSettlements).values([
    {
      // Closed month, closed settlement: accrued, approved, paid, and the
      // entries behind it carry its id.
      id: stlPaid,
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: alpha,
      period: monthBefore,
      grossMinor: netOf(stlPaid),
      adjustmentsMinor: 0,
      netMinor: netOf(stlPaid),
      currency: BASE,
      statementFileId: null,
      state: "paid",
      approvedBy: analyst,
      txnId: txPayout,
      createdAt: accrualAt,
      updatedAt: payoutAt + HOUR
    },
    {
      // Signed off, expense accrued, cash not yet moved. The `ledger.partner_settlement`
      // approval is the only thing between this row and the bank.
      id: stlApproved,
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: bank,
      period: monthBefore,
      grossMinor: netOf(stlApproved),
      adjustmentsMinor: 0,
      netMinor: netOf(stlApproved),
      currency: BASE,
      statementFileId: null,
      state: "approved",
      approvedBy: controller,
      txnId: txBankAccrual,
      createdAt: accrualAt,
      updatedAt: accrualAt + HOUR
    },
    {
      // The open month, still accumulating. Nothing has posted, so re-running it
      // is free.
      id: stlDraft,
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: alpha,
      period: thisMonth,
      grossMinor: netOf(stlDraft),
      adjustmentsMinor: 0,
      netMinor: netOf(stlDraft),
      currency: BASE,
      statementFileId: null,
      state: "draft",
      approvedBy: null,
      txnId: null,
      createdAt: dayIn(9),
      updatedAt: now - 2 * HOUR
    },
    {
      // Meridian reads the travel commission differently. Nothing posted, so
      // resolving the argument puts it back to draft and the month re-runs.
      id: stlDisputed,
      tenantId,
      counterpartyKind: "partner",
      counterpartyRef: bank,
      period: thisMonth,
      grossMinor: netOf(stlDisputed),
      adjustmentsMinor: 0,
      netMinor: netOf(stlDisputed),
      currency: BASE,
      statementFileId: null,
      state: "disputed",
      approvedBy: null,
      txnId: null,
      createdAt: dayIn(9),
      updatedAt: now - 6 * HOUR
    }
  ]);
}

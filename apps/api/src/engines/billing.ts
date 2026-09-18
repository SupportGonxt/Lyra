import { and, asc, eq, gt, isNull, lt, lte, sql } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { buildRecipe, fxRateFor, runTxn, straightLine } from "@lyra/ledger";
import { audit, emit, scoped, type Ctx } from "@lyra/core";
import { SWEEP_MAX } from "./sweep.js";

/** `INV-YYYYMMDD-<last6ofId>`, mirrors axis-fnol.ts's claimNumber() shape. */
export function invoiceNumber(invoiceId: string, now: number): string {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `INV-${stamp}-${invoiceId.slice(-6).toUpperCase()}`;
}

export interface RecordUsageArgs {
  subscriptionId: string;
  meter: string;
  period: string;
  delta: number;
  includedQuantity?: number;
  unitPriceMicro?: number;
  idempotencyKey: string;
}

/** Upserts the period's usage-meter row and posts a non-financial USAGE-METER txn. */
export async function recordUsage(
  ctx: Ctx,
  args: RecordUsageArgs
): Promise<{ meterId: string; quantity: number }> {
  const meterRow = scoped(
    ctx,
    schema.ledgerUsageMeters,
    eq(schema.ledgerUsageMeters.subscriptionId, args.subscriptionId),
    eq(schema.ledgerUsageMeters.meter, args.meter),
    eq(schema.ledgerUsageMeters.period, args.period)
  );

  const [existing] = await ctx.db
    .select({ id: schema.ledgerUsageMeters.id })
    .from(schema.ledgerUsageMeters)
    .where(meterRow);

  // The row is created empty and the quantity is added only after the
  // transaction settles. A zero-quantity meter states no usage, so a runTxn
  // that throws below leaves nothing to reconcile — whereas incrementing first
  // recorded usage the caller could never see, behind an idempotency key now
  // stuck in `failed` and so unretryable forever.
  if (!existing) {
    await ctx.db
      .insert(schema.ledgerUsageMeters)
      .values({
        id: newId("usg", ctx.now),
        tenantId: ctx.tenantId,
        subscriptionId: args.subscriptionId,
        meter: args.meter,
        period: args.period,
        quantity: 0,
        includedQuantity: args.includedQuantity ?? 0,
        unitPriceMicro: args.unitPriceMicro ?? 0,
        updatedAt: ctx.now
      })
      .onConflictDoNothing();
  }

  // The idempotency key already burned means this exact call happened before
  // (runTxn's own openTxn would just replay the settled row) — the guard here
  // is for *our* side effect, the quantity increment, which runTxn's replay
  // does not know about. Read before runTxn opens the row it would then find.
  const [priorTxn] = await ctx.db
    .select({ id: schema.ledgerTxns.id })
    .from(schema.ledgerTxns)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.type, "USAGE-METER"),
        eq(schema.ledgerTxns.idempotencyKey, args.idempotencyKey)
      )
    );
  const alreadyApplied = !!priorTxn;

  // Non-financial (⊘ in packages/ledger/src/types.ts): a meter tick moves no
  // money, so no recipe — it exists so usage has a transaction of its own to
  // key idempotency and audit off.
  await runTxn(
    ctx,
    {
      type: "USAGE-METER",
      idempotencyKey: args.idempotencyKey,
      grossMinor: 0,
      subjectRefs: { subscriptionId: args.subscriptionId, meter: args.meter, period: args.period }
    },
    {}
  );

  if (!alreadyApplied) {
    // One statement, not read-then-write: two concurrent ticks on the same
    // meter both read the same quantity and the later write loses the earlier
    // increment.
    await ctx.db
      .update(schema.ledgerUsageMeters)
      .set({ quantity: sql`${schema.ledgerUsageMeters.quantity} + ${args.delta}`, updatedAt: ctx.now })
      .where(meterRow);
  }

  const [meter] = await ctx.db.select().from(schema.ledgerUsageMeters).where(meterRow);
  const meterId = meter?.id ?? existing?.id ?? "";
  const quantity = meter?.quantity ?? 0;

  if (!alreadyApplied) {
    // No "billing" entry in MODULES (packages/core/src/events.ts) — usage
    // metering lives in the ledger domain alongside settlement.ts, which
    // emits its "ledger.settlement.*" events under module "ledger" too.
    await emit(ctx, {
      module: "ledger",
      type: "ledger.usage.recorded",
      subject: args.subscriptionId,
      data: { meterId, subscriptionId: args.subscriptionId, meter: args.meter, period: args.period, quantity }
    });
  }

  return { meterId, quantity };
}

function currentPeriod(now: number): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * A calendar month, not 30 days. A fixed constant drifts the billing anniversary
 * a day or two every cycle and lands two due dates inside one calendar month
 * twice a year — and `currentPeriod()` is the invoice's idempotency key, so that
 * collision is a billing period silently skipped. Day-of-month is clamped to the
 * target month's length, and the clamp is lossy because the result is the next
 * cursor: a 31st anniversary stepped through February becomes the 28th and stays
 * the 28th thereafter. That costs a customer nothing (still one invoice per
 * calendar month) but the anniversary does drift earlier once per month-end
 * subscription. Anchoring on the original start date would fix it — a stored
 * anchor, not a change here.
 */
function addMonths(ts: number, months: number): number {
  const d = new Date(ts);
  const day = d.getUTCDate();
  const target = new Date(ts);
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.getTime();
}

interface InvoiceOnceArgs {
  customerRef: string;
  subscriptionId?: string | null;
  netMinor: number;
  currency: string;
  lines: { description: string; amountMinor: number }[];
}

/**
 * The invoice row for a settled journal transaction, written once however many
 * times we are called.
 *
 * `runTxn` is idempotent — a replay returns the settled transaction and posts no
 * second journal — but a `newId()` invoice behind it is not, and neither is the
 * revenue schedule that hangs off that new id (the schedule's unique index is on
 * `invoiceId`, which was fresh every time). One retry, or two due dates inside
 * one calendar month, therefore billed the customer twice and recognised the
 * revenue twice for a single AR posting. The transaction is the natural key, so
 * the invoice is looked up by it and the schedule ids stay stable across replays.
 */
async function invoiceOnce(
  ctx: Ctx,
  txnId: string | undefined,
  args: InvoiceOnceArgs
): Promise<{ invoiceId: string; created: boolean }> {
  const [prior] = txnId
    ? await ctx.db
        .select({ id: schema.ledgerInvoices.id })
        .from(schema.ledgerInvoices)
        .where(scoped(ctx, schema.ledgerInvoices, eq(schema.ledgerInvoices.txnId, txnId)))
    : [];
  if (prior) return { invoiceId: prior.id, created: false };

  const invoiceId = newId("inv", ctx.now);
  await ctx.db.insert(schema.ledgerInvoices).values({
    id: invoiceId,
    tenantId: ctx.tenantId,
    number: invoiceNumber(invoiceId, ctx.now),
    customerRef: args.customerRef,
    subscriptionId: args.subscriptionId ?? null,
    subtotalMinor: args.netMinor,
    totalMinor: args.netMinor,
    currency: args.currency,
    linesJson: JSON.stringify(args.lines),
    state: "issued",
    issuedAt: ctx.now,
    txnId: txnId ?? null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  });
  return { invoiceId, created: true };
}

async function raiseInvoices(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select()
    .from(schema.ledgerSubscriptions)
    .where(
      scoped(
        ctx,
        schema.ledgerSubscriptions,
        eq(schema.ledgerSubscriptions.state, "active"),
        lte(schema.ledgerSubscriptions.nextInvoiceAt, ctx.now)
      )
    )
    .orderBy(asc(schema.ledgerSubscriptions.nextInvoiceAt))
    .limit(SWEEP_MAX);

  let count = 0;
  for (const sub of due) {
    // One subscription's failure is one subscription's problem. Every sweep for
    // every tenant runs inside a single try in the cron handler (index.ts), so a
    // throw from here used to take out that tenant's remaining jobs — autopilot,
    // due schedules, delegation expiry, backups — on every tick, forever.
    try {
      count += await invoiceSubscription(ctx, sub);
    } catch (err) {
      console.error(`billing: subscription ${sub.id} could not be invoiced`, err);
    }
  }
  return count;
}

/**
 * How many periods one subscription may catch up on in a single tick.
 *
 * The catch-up loop bills every period between `nextInvoiceAt` and the clock, and
 * `SWEEP_MAX` bounds rows, not periods per row — one badly back-dated import
 * (years of them) would post its whole history in one Worker invocation. Capped,
 * the row still leaves its own result set each tick (its `nextInvoiceAt` advances
 * a year), so the remainder is simply the next tick's work (ADR-0050).
 */
const CATCHUP_MAX = 12;

async function invoiceSubscription(ctx: Ctx, sub: typeof schema.ledgerSubscriptions.$inferSelect): Promise<number> {
  // `interval` is the contract's own cycle (schema ledger.ts): an annual
  // subscription's priceMinor is the whole year, so billing it monthly was a
  // 12x overcharge.
  const months = sub.interval === "year" ? 12 : 1;
  const netMinor = sub.priceMinor;
  let cursor = sub.nextInvoiceAt ?? ctx.now;
  let count = 0;

  // `nextInvoiceAt` is a stored, nullable column, so it holds whatever was
  // written before the API bounded it. The catch-up guard below (`cursor <=
  // ctx.now`) filters large positives and NaN but not large negatives, and
  // `currentPeriod` of one of those is `"NaN-NaN"`: it became the invoice's
  // idempotency key, the revenue schedule's period, and the value written back
  // to `nextInvoiceAt`. A key that is not the period it claims to be does not
  // match on the next tick, so the same period bills a second time — this is
  // the one place in the sweep where degrading beats proceeding. Skipped and
  // logged, like the missing-FX-rate case above, and the cursor is left alone
  // so the row still shows up next tick for whoever fixes it.
  if (!Number.isFinite(cursor) || Math.abs(cursor) > 8.64e15) {
    console.error(`billing: subscription ${sub.id} has a nextInvoiceAt no Date can hold (${cursor}); skipped`);
    return 0;
  }

  // A subscription bills in its own contract's currency, which need not be the
  // one the tenant reports in. Resolve the rate *before* opening the transaction:
  // posting without one is refused, a refused post fails the transaction, and a
  // failed transaction burns `sub-invoice:{sub}:{period}` for good (txn.ts's
  // "already failed") — the period could then never be billed, by cron or by
  // hand. Refusing early leaves no trace, exactly as txn.ts's own preconditions
  // do.
  const fxRatePpm = await fxRateFor(ctx, sub.currency);
  if (!fxRatePpm) {
    console.error(
      `billing: subscription ${sub.id} bills in ${sub.currency} but the tenant has no ${sub.currency} -> ${ctx.policy.currency} rate; skipped`
    );
    return 0;
  }

  // Advance from the anniversary the subscription is actually owed from, not
  // from the clock, and step one period at a time — a sweep that ran late (or
  // not at all, through an outage) then bills the periods it missed instead of
  // skipping them, and the row still leaves this result set in one tick
  // (ADR-0050).
  for (let periods = 0; cursor <= ctx.now && periods < CATCHUP_MAX; periods++) {
    const period = currentPeriod(cursor);
    const at = cursor;
    cursor = addMonths(cursor, months);

    // A zero-price plan has no invoice to raise — `invoiceRaised` requires a
    // positive net, and letting it throw would burn the key and abort the
    // sweep for every tenant behind this one.
    if (netMinor <= 0) continue;

    const txn = await runTxn(
      ctx,
      {
        type: "SUB-INVOICE",
        idempotencyKey: `sub-invoice:${sub.id}:${period}`,
        currency: sub.currency,
        grossMinor: netMinor,
        subjectRefs: { subscriptionId: sub.id, customerRef: sub.customerRef }
      },
      { recipe: { lines: buildRecipe("SUB-INVOICE", { netMinor }), currency: sub.currency, fxRatePpm } }
    );

    const { invoiceId, created } = await invoiceOnce(ctx, txn?.id, {
      customerRef: sub.customerRef,
      subscriptionId: sub.id,
      netMinor,
      currency: sub.currency,
      lines: [{ description: `${sub.plan} subscription`, amountMinor: netMinor }]
    });

    // Straight-line recognition: the invoice defers the whole term into 2300
    // and each period releases its share. The first period carries the
    // integer-division remainder so the twelve rows sum to exactly the invoice.
    const plan = straightLine(netMinor, months);
    for (let i = 0; i < months; i++) {
      await ctx.db
        .insert(schema.ledgerRevenueSchedules)
        .values({
          id: newId("sch", ctx.now),
          tenantId: ctx.tenantId,
          invoiceId,
          accountCode: "2300",
          period: currentPeriod(addMonths(at, i)),
          plannedMinor: plan[i] as number,
          currency: sub.currency,
          state: "scheduled"
        })
        .onConflictDoNothing();
    }

    if (!created) continue;
    await emit(ctx, {
      module: "ledger",
      type: "ledger.invoice.raised",
      subject: invoiceId,
      data: { subscriptionId: sub.id, netMinor, currency: sub.currency, txnId: txn?.id }
    });
    count++;
  }

  await ctx.db
    .update(schema.ledgerSubscriptions)
    .set({ nextInvoiceAt: cursor, updatedAt: ctx.now })
    .where(scoped(ctx, schema.ledgerSubscriptions, eq(schema.ledgerSubscriptions.id, sub.id)));
  return count;
}

async function applyOverages(ctx: Ctx): Promise<number> {
  const meters = await ctx.db
    .select({
      id: schema.ledgerUsageMeters.id,
      subscriptionId: schema.ledgerUsageMeters.subscriptionId,
      meter: schema.ledgerUsageMeters.meter,
      period: schema.ledgerUsageMeters.period,
      quantity: schema.ledgerUsageMeters.quantity,
      includedQuantity: schema.ledgerUsageMeters.includedQuantity,
      invoicedQuantity: schema.ledgerUsageMeters.overageInvoicedQuantity,
      unitPriceMicro: schema.ledgerUsageMeters.unitPriceMicro,
      customerRef: schema.ledgerSubscriptions.customerRef,
      currency: schema.ledgerSubscriptions.currency
    })
    .from(schema.ledgerUsageMeters)
    // The subscription is the only place the customer and the currency exist —
    // the meter has neither. An inner join also drops meters with no
    // subscription (the platform's own usage counters), which have nobody to
    // invoice and were previously billed to customerRef "unknown" in USD.
    .innerJoin(
      schema.ledgerSubscriptions,
      and(
        eq(schema.ledgerSubscriptions.id, schema.ledgerUsageMeters.subscriptionId),
        eq(schema.ledgerSubscriptions.tenantId, ctx.tenantId)
      )
    )
    .where(
      scoped(
        ctx,
        schema.ledgerUsageMeters,
        isNull(schema.ledgerUsageMeters.overageInvoicedAt),
        // Every predicate here is one a billing run clears, so a row it selects
        // always leaves its own result set (ADR-0050): unpriced meters and
        // fully-invoiced overage are excluded rather than fetched and skipped,
        // which is what used to wedge the head of an oldest-first window.
        gt(schema.ledgerUsageMeters.unitPriceMicro, 0),
        sql`${schema.ledgerUsageMeters.includedQuantity} + ${schema.ledgerUsageMeters.overageInvoicedQuantity} < ${schema.ledgerUsageMeters.quantity}`
      )
    )
    .orderBy(asc(schema.ledgerUsageMeters.updatedAt))
    .limit(SWEEP_MAX);

  let count = 0;
  for (const meter of meters) {
    // One meter's failure is one meter's problem — same reasoning as
    // raiseInvoices: every sweep for every tenant runs inside a single try in
    // the cron handler (index.ts), so an uncaught throw here used to take out
    // that tenant's remaining jobs on every tick, forever.
    try {
      // Bill the units not yet billed, not the whole overage: usage keeps
      // arriving after the allowance is crossed, and one invoice per period at
      // the moment of crossing left the rest of the period free.
      const billedUnits = meter.includedQuantity + meter.invoicedQuantity;
      const overageUnits = meter.quantity - billedUnits;
      const netMinor = Math.ceil((overageUnits * meter.unitPriceMicro) / 1_000_000);
      const currency = meter.currency;
      const invoicedQuantity = meter.invoicedQuantity + overageUnits;

      // Resolve the rate *before* claiming the units, same as
      // invoiceSubscription: claiming first and refusing to post second would
      // satisfy the selection predicate, so the row would leave the result set
      // with those units billed to nobody, ever.
      const fxRatePpm = await fxRateFor(ctx, currency);
      if (!fxRatePpm) {
        console.error(
          `billing: meter ${meter.id} bills in ${currency} but the tenant has no ${currency} -> ${ctx.policy.currency} rate; skipped`
        );
        continue;
      }

      // Claim the units before billing them, the way recordUsage creates its
      // meter before settling the usage transaction. Billing first left a
      // window: the OVERAGE transaction settled, the worker died, and because
      // the idempotency key is the *cumulative* unit count, the retry — by then
      // seeing more usage — computed a different key, so it billed a second
      // transaction covering the units the first one already charged for.
      //
      // ponytail: a crash between this write and the posting below bills those
      // units never. Under-billing a customer is recoverable and visible in the
      // meter; double-charging is neither.
      await ctx.db
        .update(schema.ledgerUsageMeters)
        .set({
          overageInvoicedQuantity: invoicedQuantity,
          // Closed only once the period itself is over. Stamping it on the
          // first crossing is what stopped the rest of the period from ever
          // being billed.
          overageInvoicedAt: meter.period < currentPeriod(ctx.now) ? ctx.now : null,
          updatedAt: ctx.now
        })
        .where(scoped(ctx, schema.ledgerUsageMeters, eq(schema.ledgerUsageMeters.id, meter.id)));

      const txn = await runTxn(
        ctx,
        {
          type: "OVERAGE",
          // The cumulative unit count, so a replayed tick is a no-op while a
          // tick that finds new usage gets its own transaction.
          idempotencyKey: `overage:${meter.id}:${invoicedQuantity}`,
          currency,
          grossMinor: netMinor,
          subjectRefs: { subscriptionId: meter.subscriptionId ?? "", meter: meter.meter, period: meter.period }
        },
        { recipe: { lines: buildRecipe("OVERAGE", { netMinor }), currency, fxRatePpm } }
      );

      // No revenue schedule: the OVERAGE recipe credits usage revenue 4050 on
      // the invoice itself (recipes.ts), so there is nothing deferred to
      // release. Scheduling it here recognised the same usage a second time out
      // of 2300, which was never credited for it.
      const { invoiceId, created } = await invoiceOnce(ctx, txn?.id, {
        customerRef: meter.customerRef,
        subscriptionId: meter.subscriptionId,
        netMinor,
        currency,
        lines: [{ description: `${meter.meter} overage (${overageUnits} units)`, amountMinor: netMinor }]
      });

      if (!created) continue;
      await emit(ctx, {
        module: "ledger",
        type: "ledger.overage.applied",
        subject: invoiceId,
        data: { meterId: meter.id, netMinor, txnId: txn?.id }
      });
      count++;
    } catch (err) {
      console.error(`billing: meter ${meter.id} could not be billed for overage`, err);
    }
  }
  return count;
}

async function postRecognitions(ctx: Ctx): Promise<number> {
  const period = currentPeriod(ctx.now);
  const due = await ctx.db
    .select()
    .from(schema.ledgerRevenueSchedules)
    .where(
      scoped(
        ctx,
        schema.ledgerRevenueSchedules,
        eq(schema.ledgerRevenueSchedules.state, "scheduled"),
        lt(schema.ledgerRevenueSchedules.period, period)
      )
    )
    .orderBy(asc(schema.ledgerRevenueSchedules.period))
    .limit(SWEEP_MAX);

  let count = 0;
  for (const row of due) {
    // One schedule row's failure is one row's problem — same reasoning as
    // raiseInvoices/applyOverages. Unisolated, rows process asc(period), so an
    // uncaught throw here would wedge the head of the window and block every
    // later recognition for the tenant, forever (ADR-0050-style starvation).
    try {
      const idempotencyKey = `sub-recog:${row.id}`;
      // A schedule row's `accountCode` is the income line the release belongs
      // to (4050 usage, 4060 data products, 4090 success fees); only the
      // deferred revenue liability 2300 has to be mapped, and it maps to
      // subscription revenue. Collapsing everything to 4040 misstated the
      // revenue lines this engine exists to keep apart.
      const incomeAccount = row.accountCode === "2300" ? "4040" : row.accountCode;

      // Resolve the rate before posting, same as invoiceSubscription /
      // applyOverages: a refused post here would burn `idempotencyKey` for
      // good, wedging this row at the head of the asc(period) window forever.
      const fxRatePpm = await fxRateFor(ctx, row.currency);
      if (!fxRatePpm) {
        console.error(
          `billing: revenue schedule ${row.id} recognizes in ${row.currency} but the tenant has no ${row.currency} -> ${ctx.policy.currency} rate; skipped`
        );
        continue;
      }

      // docs/19 §11.9 (docs/27 F22): a release may never take total recognition
      // above what was invoiced. The ceiling is read from the ledger's own rows
      // rather than from this row's plan — a schedule is a plan, and plans get
      // edited, duplicated and re-run, so the plan cannot be its own limit.
      const [invoice] = await ctx.db
        // subtotal, not total: only the net is deferred, the tax went to 2200.
        .select({ netMinor: schema.ledgerInvoices.subtotalMinor })
        .from(schema.ledgerInvoices)
        .where(scoped(ctx, schema.ledgerInvoices, eq(schema.ledgerInvoices.id, row.invoiceId)))
        .limit(1);
      const [already] = await ctx.db
        .select({ total: sql<number>`coalesce(sum(${schema.ledgerRevenueSchedules.recognizedMinor}), 0)` })
        .from(schema.ledgerRevenueSchedules)
        .where(
          scoped(
            ctx,
            schema.ledgerRevenueSchedules,
            eq(schema.ledgerRevenueSchedules.invoiceId, row.invoiceId),
            eq(schema.ledgerRevenueSchedules.state, "recognized")
          )
        );

      const txn = await runTxn(
        ctx,
        {
          type: "SUB-RECOG",
          idempotencyKey,
          currency: row.currency,
          grossMinor: row.plannedMinor,
          subjectRefs: { invoiceId: row.invoiceId }
        },
        {
          recipe: {
            lines: buildRecipe("SUB-RECOG", {
              amountMinor: row.plannedMinor,
              incomeAccount,
              ...(invoice ? { invoicedMinor: invoice.netMinor } : {}),
              alreadyRecognisedMinor: Number(already?.total ?? 0)
            }),
            currency: row.currency,
            fxRatePpm
          }
        }
      );

      await ctx.db
        .update(schema.ledgerRevenueSchedules)
        .set({ state: "recognized", recognizedMinor: row.plannedMinor, txnId: txn?.id })
        .where(scoped(ctx, schema.ledgerRevenueSchedules, eq(schema.ledgerRevenueSchedules.id, row.id)));

      await emit(ctx, {
        module: "ledger",
        type: "ledger.revenue.recognized",
        subject: row.id,
        data: { invoiceId: row.invoiceId, amountMinor: row.plannedMinor, txnId: txn?.id }
      });
      count++;
    } catch (err) {
      console.error(`billing: revenue schedule ${row.id} could not be recognized`, err);
    }
  }
  return count;
}

export interface SubscribeToDataProductArgs {
  dataProductId: string;
  subscriberRef: string;
  idempotencyKey: string;
}

/** DPROD-SUB (⊘): subscribing a partner to a data product posts no journal. */
export async function subscribeToDataProduct(
  ctx: Ctx,
  args: SubscribeToDataProductArgs
): Promise<{ txnId: string | undefined }> {
  const txn = await runTxn(
    ctx,
    {
      type: "DPROD-SUB",
      idempotencyKey: args.idempotencyKey,
      currency: "USD",
      grossMinor: 0,
      subjectRefs: { dataProductId: args.dataProductId, subscriberRef: args.subscriberRef }
    },
    {}
  );

  await audit(ctx, {
    action: "ledger.dprod.subscribed",
    subjectRef: args.dataProductId,
    before: null,
    after: { subscriberRef: args.subscriberRef }
  });
  // No "billing" entry in MODULES (packages/core/src/events.ts) — data-product
  // billing lives in the ledger domain, same as usage/settlement events above.
  await emit(ctx, {
    module: "ledger",
    type: "ledger.dprod.subscribed",
    subject: args.dataProductId,
    data: { subscriberRef: args.subscriberRef, ...(txn ? { txnId: txn.id } : {}) }
  });

  return { txnId: txn?.id };
}

export interface DeliverDataProductArgs {
  dataProductId: string;
  subscriberRef: string;
  cellCount: number;
  netMinor: number;
  idempotencyKey: string;
}

/**
 * DPROD-DELIVER (⊘, gated by TXN_PRECONDITIONS on k-anonymity) chained into the
 * F2 money legs per spec D2: same SUB-INVOICE/SUB-RECOG recipes, incomeAccount
 * "4060" passed only at the SUB-RECOG call site (InvoiceArgs has no such field).
 */
export async function deliverDataProduct(
  ctx: Ctx,
  args: DeliverDataProductArgs
): Promise<{ deliverTxnId: string | undefined; invoiceId: string; scheduleId: string }> {
  const deliverTxn = await runTxn(
    ctx,
    {
      type: "DPROD-DELIVER",
      idempotencyKey: args.idempotencyKey,
      currency: "USD",
      grossMinor: 0,
      subjectRefs: { dataProductId: args.dataProductId, subscriberRef: args.subscriberRef }
    },
    { args: { dataProductId: args.dataProductId, cellCount: args.cellCount } }
  );

  // The tenant's own reporting currency, not a literal-coded one: the data
  // product schema (scout.ts) carries no per-product currency, so this is the
  // only correct source (same as the other billing paths). Since it's always
  // the posting base currency, fxRateFor trivially resolves — no guard needed.
  const currency = ctx.policy.currency;
  const period = currentPeriod(ctx.now);

  const invoiceTxn = await runTxn(
    ctx,
    {
      type: "SUB-INVOICE",
      idempotencyKey: `${args.idempotencyKey}:invoice`,
      currency,
      grossMinor: args.netMinor,
      subjectRefs: { dataProductId: args.dataProductId, subscriberRef: args.subscriberRef },
      ...(deliverTxn ? { parentTxnId: deliverTxn.id } : {})
    },
    { recipe: { lines: buildRecipe("SUB-INVOICE", { netMinor: args.netMinor }), currency } }
  );

  const { invoiceId } = await invoiceOnce(ctx, invoiceTxn?.id, {
    customerRef: args.subscriberRef,
    netMinor: args.netMinor,
    currency,
    lines: [{ description: `data product ${args.dataProductId} delivery`, amountMinor: args.netMinor }]
  });

  const recogTxn = await runTxn(
    ctx,
    {
      type: "SUB-RECOG",
      idempotencyKey: `${args.idempotencyKey}:recog`,
      currency,
      grossMinor: args.netMinor,
      subjectRefs: { dataProductId: args.dataProductId, invoiceId },
      ...(deliverTxn ? { parentTxnId: deliverTxn.id } : {})
    },
    {
      recipe: {
        lines: buildRecipe("SUB-RECOG", { amountMinor: args.netMinor, incomeAccount: "4060" }),
        currency
      }
    }
  );

  // Idempotent through the schedule's own unique index on (tenant, invoice,
  // period, accountCode), which only bites now that the invoice id is stable
  // across replays — a fresh invoice id per call made every retry a new row.
  const scheduleWhere = scoped(
    ctx,
    schema.ledgerRevenueSchedules,
    eq(schema.ledgerRevenueSchedules.invoiceId, invoiceId),
    eq(schema.ledgerRevenueSchedules.period, period),
    eq(schema.ledgerRevenueSchedules.accountCode, "4060")
  );
  await ctx.db
    .insert(schema.ledgerRevenueSchedules)
    .values({
      id: newId("sch", ctx.now),
      tenantId: ctx.tenantId,
      invoiceId,
      accountCode: "4060",
      period,
      plannedMinor: args.netMinor,
      recognizedMinor: args.netMinor,
      currency,
      txnId: recogTxn?.id,
      state: "recognized"
    })
    .onConflictDoNothing();
  const [schedule] = await ctx.db
    .select({ id: schema.ledgerRevenueSchedules.id })
    .from(schema.ledgerRevenueSchedules)
    .where(scheduleWhere);
  const scheduleId = schedule?.id ?? "";

  await audit(ctx, {
    action: "ledger.dprod.delivered",
    subjectRef: args.dataProductId,
    before: null,
    after: { subscriberRef: args.subscriberRef, netMinor: args.netMinor, invoiceId }
  });
  await emit(ctx, {
    module: "ledger",
    type: "ledger.dprod.delivered",
    subject: args.dataProductId,
    data: {
      subscriberRef: args.subscriberRef,
      invoiceId,
      netMinor: args.netMinor,
      ...(deliverTxn ? { txnId: deliverTxn.id } : {})
    }
  });

  return { deliverTxnId: deliverTxn?.id, invoiceId, scheduleId };
}

/** Bounded-bite sweep (ADR-0050): invoices due subscriptions, applies pending overages, posts due recognitions. */
export async function sweepBilling(
  ctx: Ctx
): Promise<{ invoicesRaised: number; overagesApplied: number; recognitionsPosted: number }> {
  const invoicesRaised = await raiseInvoices(ctx);
  const overagesApplied = await applyOverages(ctx);
  const recognitionsPosted = await postRecognitions(ctx);
  return { invoicesRaised, overagesApplied, recognitionsPosted };
}

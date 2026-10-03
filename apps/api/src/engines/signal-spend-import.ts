import { and, asc, eq, isNull } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { AppError, audit, badRequest, conflict, emit, type Ctx } from "@lyra/core";
import { buildRecipe, fxRateFor, reverseTxn, runTxn } from "@lyra/ledger";
import { parseCsv, type RowError } from "./axis-case-import.js";

// docs/30 SIGNAL gap 1. Spend actuals from an ad-platform export (CSV). The
// same per-line honesty as the case import: every line is written or named in
// `errors`. A (campaign, channel, day) already held is corrected, not doubled —
// platforms restate yesterday, and the autopilot's CAC must see the restatement.

const REQUIRED = ["day", "channel", "amountMinor", "currency"] as const;
const COUNTS = ["impressions", "clicks", "conversions"] as const;

export interface SpendImportResult {
  created: number;
  updated: number;
  errors: RowError[];
}

const wholeOrZero = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return 0;
  return /^\d+$/.test(v) ? Number(v) : null;
};

export function realDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export async function importSpend(ctx: Ctx, csv: string): Promise<SpendImportResult> {
  const { header, rows, parseErrors } = parseCsv(csv);
  const missing = REQUIRED.find((c) => !header.includes(c));
  if (missing && !parseErrors.length) return { created: 0, updated: 0, errors: [{ line: 1, ref: null, error: `missing column ${missing}` }] };
  const out: SpendImportResult = { created: 0, updated: 0, errors: [...parseErrors] };
  if (missing) return out;

  const campaigns = new Set(
    (await ctx.db.select({ id: schema.signalCampaigns.id }).from(schema.signalCampaigns).where(eq(schema.signalCampaigns.tenantId, ctx.tenantId))).map(
      (c) => c.id
    )
  );

  for (const { line, cells } of rows) {
    const fail = (error: string) => out.errors.push({ line, ref: cells.day || null, error });
    const campaignId = cells.campaignId || null;
    const amount = cells.amountMinor ?? "";
    if (!realDay(cells.day ?? "")) { fail("day must be a real YYYY-MM-DD date"); continue; }
    if (campaignId && !campaigns.has(campaignId)) { fail(`no campaign ${campaignId}`); continue; }
    if (!cells.channel) { fail("channel is required"); continue; }
    if (!/^\d+$/.test(amount)) { fail("amountMinor must be a whole number of minor units, 0 or more"); continue; }
    if (!/^[A-Z]{3}$/.test(cells.currency ?? "")) { fail("currency must be a 3-letter ISO code"); continue; }
    const counts = Object.fromEntries(COUNTS.map((k) => [k, wholeOrZero(cells[k])])) as Record<(typeof COUNTS)[number], number | null>;
    const bad = COUNTS.find((k) => counts[k] === null);
    if (bad) { fail(`${bad} must be a whole number, 0 or more`); continue; }

    let outcome: Awaited<ReturnType<typeof recordSpend>>;
    try {
      outcome = await recordSpend(
        ctx,
        {
          campaignId,
          channel: cells.channel,
          day: cells.day!,
          amountMinor: Number(amount),
          currency: cells.currency!,
          impressions: counts.impressions!,
          clicks: counts.clicks!,
          conversions: counts.conversions!
        },
        "import"
      );
    } catch (err) {
      // A line the ledger refused (no FX rate, a closed month, a currency
      // change) is named, not written: spend the P&L never saw is not spend
      // this table may claim.
      fail(spendRefusal(err));
      continue;
    }
    if (outcome !== "unchanged") out[outcome]++;
  }
  await audit(ctx, { action: "signal.spend.imported", subjectRef: "signal_spend:import", after: { created: out.created, updated: out.updated, errors: out.errors.length } });
  return out;
}

export interface SpendLine {
  campaignId: string | null;
  channel: string;
  day: string;
  amountMinor: number;
  currency: string;
  impressions: number;
  clicks: number;
  conversions: number;
}

export type SpendSource = "import" | "api" | "manual";

/** Why a spend write was refused, as a per-line error: an AppError's detail, not its status title. */
export const spendRefusal = (err: unknown): string =>
  err instanceof AppError ? (err.detail ?? err.message) : err instanceof Error ? err.message : String(err);

/**
 * How a write meets a (campaign, channel, day) already held. `upsert` corrects
 * it — a platform restating yesterday; `create` refuses it (409), which is what
 * `POST /v1/signal/spend` has always answered; `ifAbsent` leaves it alone — the
 * demo tick's second run on the same day.
 */
export type SpendWriteMode = "upsert" | "create" | "ifAbsent";

type SpendRow = typeof schema.signalSpend.$inferSelect;

/**
 * The one write every spend actual goes through — a CSV line above, a pulled
 * ad-platform day (signal-ad-platforms.ts), a hand-keyed row
 * (`POST`/`PATCH /v1/signal/spend`), the demo tick — so each corrects a
 * restated (campaign, channel, day) rather than doubling it, each announces
 * it, and each reaches the ledger as MEDIA-SPEND (docs/19 §4.8, §5 G).
 * Nothing else inserts or updates signal_spend; `signal-spend.guard.test.ts`
 * holds the tree to that.
 *
 * The ledger goes first. A refused accrual (no FX rate, a hard-closed month)
 * leaves no row behind claiming spend the P&L never saw; a row write that
 * fails after its accrual settled is healed by the retry, which finds the
 * chain already at the new amount and posts nothing.
 */
export async function recordSpend(
  ctx: Ctx,
  line: SpendLine,
  source: SpendSource,
  mode: SpendWriteMode = "upsert"
): Promise<"created" | "updated" | "unchanged"> {
  const { campaignId, channel, day, ...measures } = line;
  const values = { ...measures, source, ts: ctx.now };
  // Looked up rather than upserted: a null campaign is distinct to SQLite's
  // unique index, so ON CONFLICT would never fire for channel-level spend.
  const [held] = await ctx.db
    .select()
    .from(schema.signalSpend)
    .where(
      and(
        eq(schema.signalSpend.tenantId, ctx.tenantId),
        campaignId ? eq(schema.signalSpend.campaignId, campaignId) : isNull(schema.signalSpend.campaignId),
        eq(schema.signalSpend.channel, channel),
        eq(schema.signalSpend.day, day)
      )
    )
    .limit(1);
  if (held && mode === "ifAbsent") return "unchanged";
  if (held && mode === "create") throw conflict("spend already exists");

  const id = held?.id ?? newId("spd", ctx.now);
  await accrueSpend(ctx, line, id, held);
  if (held) {
    await ctx.db.update(schema.signalSpend).set(values).where(eq(schema.signalSpend.id, id));
  } else {
    await ctx.db.insert(schema.signalSpend).values({ id, tenantId: ctx.tenantId, campaignId, channel, day, ...values });
  }
  // The same announcement a CRUD write makes (resources.ts spend afterWrite).
  await emit(ctx, {
    module: "signal",
    type: "signal.spend.recorded",
    subject: id,
    data: { campaignId, channel, day, amountMinor: line.amountMinor, currency: line.currency, conversions: line.conversions }
  });
  return held ? "updated" : "created";
}

/* ------------------------------------------------------------ the accrual */

const MEDIA_SPEND = "MEDIA-SPEND";

/**
 * A spend row's ledger identity: its natural key, not its id. A retry that
 * re-mints the row id (the insert failed after the accrual settled) still
 * finds the chain it already posted.
 */
export const spendCorrelation = (l: Pick<SpendLine, "campaignId" | "channel" | "day">): string =>
  `signal.spend:${l.campaignId ?? "-"}:${l.channel}:${l.day}`;

interface ChainTxn {
  id: string;
  state: string;
  grossMinor: number;
  currency: string;
  amountsJson: string | null;
}

/** What the chain inherited: the row's amount before the seam first booked it. */
function floorOf(t: ChainTxn): number {
  try {
    const floor = (JSON.parse(t.amountsJson ?? "{}") as { floor?: unknown }).floor;
    return typeof floor === "number" ? floor : 0;
  } catch {
    return 0;
  }
}

/**
 * Brings the ledger to the row's new amount. Per row, the chain is every
 * MEDIA-SPEND opened under `spendCorrelation` — reversal transactions
 * excluded, they carry `reversal_of` — and what it has booked is
 * `floor + Σ gross of the settled ones`.
 *
 * - Raised: the positive delta posts as a new MEDIA-SPEND.
 * - Lowered: the newest settled accruals are reversed (docs/19 §1.2: a contra
 *   transaction carrying `reversal_of`, the original intact) until what is
 *   booked is at or below the new amount, and any remainder is booked fresh.
 *   The recipe is positive-only and stays that way.
 * - Unchanged: nothing, which is what makes a re-import a no-op.
 *
 * The idempotency key is the row's identity, its position in the chain and
 * the amount: two concurrent writes of the same restatement collapse into one
 * posting, while 100 → 50 → 100 still posts the second 100 — a key of identity
 * and amount alone would replay the first one, already reversed, as a no-op.
 *
 * `floor` is for a row written before this seam existed. Seeded history is
 * carried by the seed's own monthly MEDIA-SPEND, so the seam treats such a row
 * as booked elsewhere: it accrues only what moves from there, and cannot
 * reverse below it, having no accrual of its own left to contra. That case is
 * audited for the media recon (docs/19 §6) rather than forced.
 */
async function accrueSpend(ctx: Ctx, line: SpendLine, rowId: string, held: SpendRow | undefined): Promise<void> {
  const correlationId = spendCorrelation(line);
  const chain: ChainTxn[] = await ctx.db
    .select({
      id: schema.ledgerTxns.id,
      state: schema.ledgerTxns.state,
      grossMinor: schema.ledgerTxns.grossMinor,
      currency: schema.ledgerTxns.currency,
      amountsJson: schema.ledgerTxns.amountsJson
    })
    .from(schema.ledgerTxns)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.type, MEDIA_SPEND),
        eq(schema.ledgerTxns.correlationId, correlationId),
        isNull(schema.ledgerTxns.reversalOf)
      )
    )
    .orderBy(asc(schema.ledgerTxns.createdAt), asc(schema.ledgerTxns.id));

  const floor = chain[0] ? floorOf(chain[0]) : (held?.amountMinor ?? 0);
  const bookedIn = chain[0]?.currency ?? (floor > 0 ? held?.currency : undefined);
  if (bookedIn && bookedIn !== line.currency) {
    throw badRequest(`this spend is booked in ${bookedIn}; a row's currency cannot change once accrued`);
  }

  const live = chain.filter((t) => t.state === "settled");
  let booked = floor + live.reduce((n, t) => n + t.grossMinor, 0);
  if (booked === line.amountMinor) return;

  const reason = `signal spend restated: ${correlationId} ${booked} -> ${line.amountMinor}`;
  while (booked > line.amountMinor && live.length) {
    const newest = live.pop()!;
    await reverseTxn(ctx, newest.id, reason);
    booked -= newest.grossMinor;
  }
  if (booked > line.amountMinor) {
    await audit(ctx, {
      action: "signal.spend.accrual_floor",
      subjectRef: rowId,
      before: { bookedMinor: booked },
      after: { amountMinor: line.amountMinor, floorMinor: floor, correlationId }
    });
    return;
  }
  if (booked === line.amountMinor) return;

  const deltaMinor = line.amountMinor - booked;
  const fxRatePpm = await fxRateFor(ctx, line.currency);
  if (!fxRatePpm) throw badRequest(`no fx rate on file for ${line.currency} -> ${ctx.policy.currency}; spend cannot be accrued`);
  const dims: Record<string, string> = { ...(line.campaignId ? { campaign: line.campaignId } : {}), channel: line.channel };
  await runTxn(
    ctx,
    {
      type: MEDIA_SPEND,
      idempotencyKey: `${correlationId}:${chain.length + 1}:${line.amountMinor}`,
      correlationId,
      currency: line.currency,
      grossMinor: deltaMinor,
      subjectRefs: { spend: rowId, ...(line.campaignId ? { campaign: line.campaignId } : {}) },
      amounts: { gross: deltaMinor, net: deltaMinor, tax: 0, floor, row: line.amountMinor }
    },
    {
      recipe: {
        lines: buildRecipe(MEDIA_SPEND, { amountMinor: deltaMinor, memo: `Media spend ${line.channel} ${line.day}`, dims }),
        currency: line.currency,
        fxRatePpm
      }
    }
  );
}

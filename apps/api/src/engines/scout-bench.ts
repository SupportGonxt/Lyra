import { eq, gte } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { buildPanelBench, emit, scoped, type BenchQuote, type BenchRow, type Ctx } from "@lyra/core";

// docs/modules/scout.md §2.3 / §3 "Bench Builder | nightly | fast | no". Until
// now `scout_panel_bench` held seed rows only (docs/27 F51): the screen that
// reads it, the negotiation-pack PDF that bakes it into evidence and the
// provider-facing k-anonymity gate were all standing on a fixture. This is the
// builder — the same continuous benchmark from AXIS/dist quote outcomes the
// spec describes, computed by `buildPanelBench` (packages/core/src/bench.ts)
// and upserted here.

/** Twelve months of outcomes: the window §8 clause 1 names for cold start. */
export const BENCH_LOOKBACK_MS = 365 * 86_400_000;

/** Answers read per sweep. A cell is a provider x line x month, so this is
 *  months x panel x lines of rows at most — far below `MAX_PAGE`'s concerns. */
export const BENCH_MAX_QUOTES = 5_000;

export interface BenchSweepReport {
  readonly quotes: number;
  readonly cells: number;
  readonly created: number;
  readonly updated: number;
  readonly periods: string[];
}

/**
 * Rebuild every bench cell the window covers.
 *
 * Idempotent: a cell is keyed (tenant, provider, line, period) and updated in
 * place, so running nightly and running twice in one night produce the same
 * table. Rows outside the window are left alone — an old month is history, not
 * something this sweep is entitled to blank.
 *
 * Emits `scout.bench.updated` (docs/modules/scout.md §6) once per sweep that
 * changed something, not once per row: a hundred cells moving is one bench
 * update, and a subscriber that wants the detail reads the rows.
 */
export async function sweepPanelBench(ctx: Ctx): Promise<BenchSweepReport> {
  const answers = await ctx.db
    .select({
      requestId: schema.distQuoteResponses.requestId,
      providerId: schema.distQuoteResponses.providerId,
      line: schema.products.line,
      state: schema.distQuoteResponses.state,
      premiumMinor: schema.distQuoteResponses.premiumMinor,
      selectedAt: schema.distQuoteResponses.selectedAt,
      createdAt: schema.distQuoteResponses.createdAt
    })
    .from(schema.distQuoteResponses)
    .innerJoin(schema.distQuoteRequests, eq(schema.distQuoteRequests.id, schema.distQuoteResponses.requestId))
    .innerJoin(schema.products, eq(schema.products.id, schema.distQuoteRequests.productId))
    .where(scoped(ctx, schema.distQuoteResponses, gte(schema.distQuoteResponses.createdAt, ctx.now - BENCH_LOOKBACK_MS)))
    .limit(BENCH_MAX_QUOTES);

  if (!answers.length) return { quotes: 0, cells: 0, created: 0, updated: 0, periods: [] };

  const rows = buildPanelBench(answers as readonly BenchQuote[]);

  const held = await ctx.db
    .select({
      id: schema.scoutPanelBench.id,
      providerId: schema.scoutPanelBench.providerId,
      line: schema.scoutPanelBench.line,
      period: schema.scoutPanelBench.period
    })
    .from(schema.scoutPanelBench)
    .where(scoped(ctx, schema.scoutPanelBench));
  const idOf = new Map(held.map((row) => [cellKey(row), row.id]));

  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const values = {
      ourPriceIdx: row.ourPriceIdx,
      marketPriceIdx: row.marketPriceIdx,
      winRate: row.winRate,
      volume: row.volume,
      coverageGapsJson: JSON.stringify(row.coverageGaps),
      updatedAt: ctx.now
    };
    const id = idOf.get(cellKey(row));
    if (id) {
      updated += 1;
      await ctx.db
        .update(schema.scoutPanelBench)
        .set(values)
        .where(scoped(ctx, schema.scoutPanelBench, eq(schema.scoutPanelBench.id, id)));
      continue;
    }
    created += 1;
    await ctx.db.insert(schema.scoutPanelBench).values({
      id: newId("pnb", ctx.now),
      tenantId: ctx.tenantId,
      providerId: row.providerId,
      line: row.line,
      period: row.period,
      ...values
    } as never);
  }

  if (created + updated > 0) {
    await emit(ctx, {
      module: "scout",
      type: "scout.bench.updated",
      subject: "panel-bench",
      data: { cells: rows.length, created, updated, periods: periodsOf(rows) }
    });
  }

  return { quotes: answers.length, cells: rows.length, created, updated, periods: periodsOf(rows) };
}

const cellKey = (row: { providerId: string; line: string; period: string }): string =>
  `${row.providerId}\u0000${row.line}\u0000${row.period}`;

const periodsOf = (rows: readonly BenchRow[]): string[] => [...new Set(rows.map((one) => one.period))].sort();

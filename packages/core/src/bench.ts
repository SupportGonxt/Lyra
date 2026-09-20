// docs/modules/scout.md §2.3 "Panel & price intelligence" / §3 "Bench Builder |
// nightly | fast" — the arithmetic the nightly builder runs, pure and testable
// here so the engine in apps/api owns only the reads and the upsert. Every
// number below comes from the tenant's own panel answers (dist_quote_responses):
// LYRA holds no market feed, and inventing one would be the third-party
// integration ADR-0078 refuses to make silently.

/** One provider answer in one comparative shop, as the builder needs it. */
export interface BenchQuote {
  readonly requestId: string;
  readonly providerId: string;
  /** core_products.line — the same grouping key the whitespace sweep uses. */
  readonly line: string;
  readonly state: string; // pending|quoted|declined|referred|timeout|error
  readonly premiumMinor: number | null;
  /** Non-null when this answer is the one the customer took. */
  readonly selectedAt: number | null;
  readonly createdAt: number;
}

export interface BenchRow {
  readonly providerId: string;
  readonly line: string;
  /** YYYY-MM, UTC. */
  readonly period: string;
  /** This provider's median premium indexed to the panel median, basis points
   *  (10000 = exactly at the panel median). Null when nothing was priced. */
  readonly ourPriceIdx: number | null;
  /** The baseline the index is taken against, in the same basis points. */
  readonly marketPriceIdx: number | null;
  /** 0-100 — selected answers over answers this provider actually quoted. */
  readonly winRate: number | null;
  /** Answers this provider gave in the cell, whatever their state. This is the
   *  cell the k-anonymity floor gates on (resources.ts `rowVisible`). */
  readonly volume: number;
  readonly coverageGaps: CoverageGaps;
}

/** Where a provider is absent rather than expensive — the other half of a
 *  negotiation pack's story. */
export interface CoverageGaps {
  /** Requests the panel answered on this line that this provider never did. */
  readonly unquotedRequests: number;
  /** Requests it answered with a decline. */
  readonly declined: number;
}

/** UTC YYYY-MM. Local time would move a month boundary per deployment. */
export function benchPeriod(at: number): string {
  return new Date(at).toISOString().slice(0, 7);
}

const MARKET_BASELINE = 10_000;

/** Median of a non-empty sorted-on-the-fly list; even lengths take the mean of
 *  the middle pair, so two answers do not silently become the cheaper one. */
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/**
 * Build one bench row per provider x line x period seen in `quotes`.
 *
 * Price index: the provider's median priced answer over the panel's median for
 * the same line and period, in basis points. `marketPriceIdx` is therefore
 * always the baseline today — it is stored rather than assumed so that a real
 * market feed (ADR-0078, LATER) can write a different baseline into the same
 * column and every reader, including the negotiation pack, keeps working.
 *
 * ponytail: panel median is a proxy for "the market", not a measurement of it —
 * it is the only price evidence a broker holds. Same limitation
 * `competitionByCategory` (scout-whitespace.ts) documents for competition.
 *
 * Deterministic and total: the same quotes in any order produce the same rows,
 * which is what lets the engine upsert instead of append.
 */
export function buildPanelBench(quotes: readonly BenchQuote[]): BenchRow[] {
  const cells = new Map<string, { providerId: string; line: string; period: string; rows: BenchQuote[] }>();
  // line|period -> every priced answer the panel gave, and every request it saw.
  const panelPrices = new Map<string, number[]>();
  const panelRequests = new Map<string, Set<string>>();
  const answeredBy = new Map<string, Set<string>>(); // provider|line|period -> requestIds

  for (const q of quotes) {
    const period = benchPeriod(q.createdAt);
    const market = `${q.line}\u0000${period}`;
    const cellKey = `${q.providerId}\u0000${market}`;

    const cell = cells.get(cellKey);
    if (cell) cell.rows.push(q);
    else cells.set(cellKey, { providerId: q.providerId, line: q.line, period, rows: [q] });

    const requests = panelRequests.get(market) ?? new Set<string>();
    requests.add(q.requestId);
    panelRequests.set(market, requests);

    const mine = answeredBy.get(cellKey) ?? new Set<string>();
    mine.add(q.requestId);
    answeredBy.set(cellKey, mine);

    if (q.state === "quoted" && q.premiumMinor !== null) {
      const prices = panelPrices.get(market) ?? [];
      prices.push(q.premiumMinor);
      panelPrices.set(market, prices);
    }
  }

  const out: BenchRow[] = [];
  for (const [cellKey, cell] of cells) {
    const market = `${cell.line}\u0000${cell.period}`;
    const quoted = cell.rows.filter((q) => q.state === "quoted");
    const priced = quoted.flatMap((q) => (q.premiumMinor === null ? [] : [q.premiumMinor]));
    const ours = median(priced);
    const panel = median(panelPrices.get(market) ?? []);

    const won = quoted.filter((q) => q.selectedAt !== null).length;
    const seen = panelRequests.get(market)?.size ?? 0;
    const answered = answeredBy.get(cellKey)?.size ?? 0;

    out.push({
      providerId: cell.providerId,
      line: cell.line,
      period: cell.period,
      ourPriceIdx: ours !== null && panel !== null && panel > 0 ? Math.round((ours / panel) * MARKET_BASELINE) : null,
      marketPriceIdx: panel !== null && panel > 0 ? MARKET_BASELINE : null,
      winRate: quoted.length ? Math.round((won / quoted.length) * 100) : null,
      volume: cell.rows.length,
      coverageGaps: {
        unquotedRequests: Math.max(0, seen - answered),
        declined: cell.rows.filter((q) => q.state === "declined").length
      }
    });
  }

  // Stable order so two runs over the same data write the same rows in the same
  // sequence — the property the engine's idempotency test asserts.
  return out.sort(
    (a, b) =>
      a.period.localeCompare(b.period) || a.line.localeCompare(b.line) || a.providerId.localeCompare(b.providerId)
  );
}

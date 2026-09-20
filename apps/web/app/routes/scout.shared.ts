import { vocabulary } from "../modules/vocabulary";
import { pseudoText } from "../i18n";
import { asJson } from "../json.js";

// The five bespoke SCOUT screens share one labeller and one set of derivations,
// for the same reason signal.shared.ts exists: the radar, the panel view, the
// price benchmarks, the experiment board and the pricing analytics all read the
// same four tables (scout_clusters, scout_whitespaces, scout_panel_bench,
// scout_experiments) and would otherwise each grow their own copy of "what does
// a price index mean".
//
// Labels are local rather than app/i18n: those catalogues are shared across
// agents and these words belong to these screens. Keys are namespaced by screen
// (`radar.*`, `panel.*`, `price.*`, `xp.*`, `an.*`); the unnamespaced ones are
// shared by all five. `insurer` deliberately goes through the domain pack
// (CLAUDE.md §14) — a bench row's counterparty is a supplier outside insurance.
//
// Nothing here invents a number. The panel bench stores basis points against
// the panel median (10000 = median, see packages/core/src/seed/scout.ts) and win
// rate as whole percent; every roll-up below is a volume weighting of those two
// columns, and a null column stays null rather than becoming a zero.

/* ------------------------------------------------------------- permissions */

/** The exact strings the SCOUT handlers call require_() with. */
export const PERM = {
  clustersRead: "scout:clusters:read",
  signalsRead: "scout:signals:read",
  whitespacesRead: "scout:whitespaces:read",
  /** Promote *and* the whitespace sweep *and* the negotiation pack. */
  whitespacesPromote: "scout:whitespaces:promote",
  panelRead: "scout:panel_bench:read",
  /** The Bench Builder sweep — rewriting the bench is not implied by reading it. */
  panelBuild: "scout:panel_bench:build",
  experimentsRead: "scout:experiments:read",
  experimentsCreate: "scout:experiments:create",
  experimentsDecide: "scout:experiments:decide",
  dataProductsRead: "scout:data_products:read",
  /** Publish *and* suspend — resources.ts gates every update on this one. */
  dataProductsPublish: "scout:data_products:publish",
  exportCreate: "analytics:exports:create"
} as const;

/** packages/core/src/k-anonymity.ts DEFAULT_K_FLOOR — resources.ts hides any
 *  bench cut below it, so a thin period is absent rather than wrong.
 *
 * docs/27 P2: the server-side gates (resources.ts panel-bench visibility,
 * scout-whitespace.ts, scout-promote.ts) now resolve a tenant's own floor
 * through `kAnonymityFloor(ctx.policy, "scout")`
 * (packages/core/src/k-anonymity.ts), read from
 * `moduleConfig.scout.settings.kAnonymityFloor` — the same per-module settings
 * seam every other tenant-configurable knob goes through (module-config.ts),
 * changeable with the existing `PATCH /v1/modules/scout/config`. This constant
 * still mirrors the *default* for the screens below: none of them currently
 * reads the resolved tenant value over the wire, so a tenant with a
 * configured override sees enforcement at their own floor but this display
 * still shows 20. Wiring the display through requires the API to expose the
 * resolved number (there is no reader for it today) — left as a follow-on
 * rather than folded in here, since every consumer below is a label or a
 * client-side warning and the enforcement itself no longer has this defect. */
export const K_FLOOR = 20;

/* ------------------------------------------------------------------ shapes */

/** apps/api/src/crud.ts list envelope. */
export interface Page<T> {
  data: T[];
  cursor?: string;
  total?: number;
}

// The four row shapes below mirror what generic CRUD returns for
// `clusters`, `whitespaces`, `panel-bench` and `scout-experiments` — see
// apps/api/src/resources.ts (SCOUT) and `hydrate()` in apps/api/src/crud.ts,
// which parses every `*Json` column before the response is serialised.

export interface ClusterRow {
  id: string;
  theme: string;
  summary: string | null;
  momentumScore: number;
  size: number;
  firstSeen: number;
  lastSeen: number;
  /** Already parsed on the wire — see `jsonOf`. */
  trailJson: unknown;
  updatedAt: number;
}

export interface WhitespaceRow {
  id: string;
  description: string;
  category: string | null;
  clusterId: string | null;
  /** Already parsed on the wire — see `jsonOf`. */
  evidenceRefsJson: unknown;
  demandEstimate: number | null;
  competitionScore: number | null;
  status: string;
  owner: string | null;
  promotedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PanelRow {
  id: string;
  providerId: string;
  line: string;
  period: string;
  /** Basis points against the panel median; 10000 is the median. */
  ourPriceIdx: number | null;
  marketPriceIdx: number | null;
  /** Whole percent of the requests this row was quoted into. */
  winRate: number | null;
  volume: number;
  /** Already parsed on the wire — see `jsonOf`. */
  coverageGapsJson: unknown;
  updatedAt: number;
}

export interface ExperimentRow {
  id: string;
  whitespaceId: string;
  landingRef: string | null;
  /** Already parsed on the wire — see `jsonOf`. */
  trafficPlanJson: unknown;
  /** Already parsed on the wire — see `jsonOf`. */
  resultsJson: unknown;
  state: string;
  startedAt: number | null;
  concludedAt: number | null;
  createdAt: number;
}

/** RFC 9457 plus the two extras apps/api adds on an approval gate. */
export interface Problemish {
  title: string;
  status: number;
  code?: string;
  detail?: string;
  policy_key?: string;
}

/* ----------------------------------------------------------------- plumbing */

/** A withheld read must not blank the page: one 403 costs one panel. */
export async function safe<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

export const emptyPage = <T,>(): Page<T> => ({ data: [] });

/** One key per load, so a double-submitted form is one write. */
export function mintKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export { asJson };

/* ---------------------------------------------------------- panel roll-ups */

/** Volume-weighted mean of a nullable column; null when nothing is priced. */
export function weighted(rows: readonly PanelRow[], pick: (row: PanelRow) => number | null): number | null {
  let sum = 0;
  let mass = 0;
  for (const row of rows) {
    const value = pick(row);
    // A weight of zero would silently drop a real row, so an unpriced or
    // zero-volume cut is excluded rather than counted as the mean.
    if (value === null || row.volume <= 0) continue;
    sum += value * row.volume;
    mass += row.volume;
  }
  return mass > 0 ? Math.round(sum / mass) : null;
}

/** `YYYY-MM` sorts lexically, which is the whole reason the column is text. */
export function latestPeriod(rows: readonly PanelRow[]): string | null {
  return rows.reduce<string | null>((best, row) => (best === null || row.period > best ? row.period : best), null);
}

export function inPeriod(rows: readonly PanelRow[], period: string | null): PanelRow[] {
  return period === null ? [] : rows.filter((row) => row.period === period);
}

export interface ProviderRoll {
  providerId: string;
  volume: number;
  /** 0–1 of the period's total volume. */
  share: number;
  winRate: number | null;
  ourIdx: number | null;
  marketIdx: number | null;
  lines: string[];
  /** Terms where our wording differs from the panel median. */
  gaps: number;
}

export function rollByProvider(rows: readonly PanelRow[]): ProviderRoll[] {
  const total = rows.reduce((sum, row) => sum + row.volume, 0);
  const groups = new Map<string, PanelRow[]>();
  for (const row of rows) groups.set(row.providerId, [...(groups.get(row.providerId) ?? []), row]);
  return [...groups.entries()]
    .map(([providerId, own]) => ({
      providerId,
      volume: own.reduce((sum, row) => sum + row.volume, 0),
      share: total > 0 ? own.reduce((sum, row) => sum + row.volume, 0) / total : 0,
      winRate: weighted(own, (row) => row.winRate),
      ourIdx: weighted(own, (row) => row.ourPriceIdx),
      marketIdx: weighted(own, (row) => row.marketPriceIdx),
      lines: [...new Set(own.map((row) => row.line))].sort(),
      gaps: own.reduce((sum, row) => sum + asJson<unknown[]>(row.coverageGapsJson, []).length, 0)
    }))
    .sort((a, b) => b.volume - a.volume);
}

/** Percent above (positive) or below (negative) the panel median. */
export function deltaPct(ourIdx: number | null, marketIdx: number | null): number | null {
  if (ourIdx === null || marketIdx === null || marketIdx === 0) return null;
  return ((ourIdx - marketIdx) / marketIdx) * 100;
}

/** Two points of index is inside the noise of a median over four quotes. */
export const AT_MARKET_PCT = 2;

/** Label key for where a cut sits, and the tone that carries it. */
export function positionOf(pct: number | null): { key: string; tone: "success" | "neutral" | "danger" } {
  if (pct === null) return { key: "panel.unpriced", tone: "neutral" };
  if (pct <= -AT_MARKET_PCT) return { key: "panel.cheaper", tone: "success" };
  if (pct >= AT_MARKET_PCT) return { key: "panel.dearer", tone: "danger" };
  return { key: "panel.atMarket", tone: "neutral" };
}

/** Basis points as the index the analysts quote: 9420 → "0.94". */
export function indexText(bp: number | null, locale = "en"): string | null {
  return bp === null ? null : (bp / 10_000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* --------------------------------------------------------- price benchmarks */

export interface LineBench {
  line: string;
  volume: number;
  ourIdx: number | null;
  marketIdx: number | null;
  pct: number | null;
}

export function rollByLine(rows: readonly PanelRow[]): LineBench[] {
  const groups = new Map<string, PanelRow[]>();
  for (const row of rows) groups.set(row.line, [...(groups.get(row.line) ?? []), row]);
  return [...groups.entries()]
    .map(([line, own]) => {
      const ourIdx = weighted(own, (row) => row.ourPriceIdx);
      const marketIdx = weighted(own, (row) => row.marketPriceIdx);
      return {
        line,
        volume: own.reduce((sum, row) => sum + row.volume, 0),
        ourIdx,
        marketIdx,
        pct: deltaPct(ourIdx, marketIdx)
      };
    })
    .sort((a, b) => b.volume - a.volume);
}

export interface Loss {
  providerId: string;
  line: string;
  pct: number;
  volume: number;
}

/** The provider × line cuts sitting above the median, dearest first. */
export function losses(rows: readonly PanelRow[]): Loss[] {
  return rows
    .flatMap((row) => {
      const pct = deltaPct(row.ourPriceIdx, row.marketPriceIdx);
      return pct === null || pct <= 0 ? [] : [{ providerId: row.providerId, line: row.line, pct, volume: row.volume }];
    })
    .sort((a, b) => b.pct - a.pct);
}

/* ------------------------------------------------------ pricing analytics */

export interface Elasticity {
  providerId: string;
  line: string;
  fromPeriod: string;
  toPeriod: string;
  /** Change in our index, in percent of the median. */
  idxPct: number;
  /** Change in win rate, in percentage points. */
  winDelta: number;
  /** Win-rate points gained per percent of price cut. Null when price held. */
  ratio: number | null;
}

/**
 * Two consecutive periods of the same provider × line is the only elasticity
 * this data can support — there is no experiment that moved price on purpose,
 * so this is an observation, not a measured curve. A cut with one period is
 * omitted rather than compared against itself.
 */
export function elasticities(rows: readonly PanelRow[]): Elasticity[] {
  const groups = new Map<string, PanelRow[]>();
  for (const row of rows) {
    const key = `${row.providerId}\0${row.line}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: Elasticity[] = [];
  for (const own of groups.values()) {
    const priced = own
      .filter((row) => row.ourPriceIdx !== null && row.marketPriceIdx !== null && row.winRate !== null)
      .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
    if (priced.length < 2) continue;
    const before = priced[priced.length - 2]!;
    const after = priced[priced.length - 1]!;
    const idxPct = deltaPct(after.ourPriceIdx, before.ourPriceIdx);
    if (idxPct === null) continue;
    const winDelta = after.winRate! - before.winRate!;
    out.push({
      providerId: after.providerId,
      line: after.line,
      fromPeriod: before.period,
      toPeriod: after.period,
      idxPct,
      winDelta,
      // A price that did not move cannot explain a win rate that did.
      ratio: Math.abs(idxPct) < 0.01 ? null : winDelta / -idxPct
    });
  }
  return out.sort((a, b) => Math.abs(b.winDelta) - Math.abs(a.winDelta));
}

/** Volume share of the priced cuts that sit at or below the panel median. */
export function adequacy(rows: readonly PanelRow[]): { atOrBelow: number; priced: number } {
  let atOrBelow = 0;
  let priced = 0;
  for (const row of rows) {
    const pct = deltaPct(row.ourPriceIdx, row.marketPriceIdx);
    if (pct === null) continue;
    priced += row.volume;
    if (pct <= 0) atOrBelow += row.volume;
  }
  return { atOrBelow, priced };
}

/* --------------------------------------------------------------- radar */

/** A whitespace placed on the quadrant. Both axes are 0–100 percentages. */
export interface Dot {
  id: string;
  label: string;
  /** Openness of the market: 100 − competition score. */
  fit: number;
  /** The linked cluster's momentum. */
  momentum: number;
  /** Evidence references behind it — the dot's area. */
  evidence: number;
  status: string;
  selected: boolean;
}

export interface EvidenceBlob {
  refs?: string[];
  demandEstimate?: { unit?: string; method?: string; confidence?: string; note?: string };
}

export function evidenceOf(row: WhitespaceRow): EvidenceBlob {
  return asJson<EvidenceBlob>(row.evidenceRefsJson, {});
}

const clamp = (value: number): number => Math.max(0, Math.min(100, value));

/**
 * Only clustered whitespace can be plotted: the vertical axis is the cluster's
 * momentum and there is no second source for it, so an unlinked row would have
 * to be placed at a momentum nobody measured. Those rows are counted instead
 * (see `unplotted`) so the screen never quietly drops one.
 */
export function dots(
  whitespaces: readonly WhitespaceRow[],
  clusters: readonly ClusterRow[],
  selectedId: string | null
): Dot[] {
  const byId = new Map(clusters.map((cluster) => [cluster.id, cluster]));
  return whitespaces.flatMap((row) => {
    const cluster = row.clusterId === null ? undefined : byId.get(row.clusterId);
    if (!cluster || row.competitionScore === null) return [];
    return [
      {
        id: row.id,
        label: cluster.theme,
        fit: clamp(100 - row.competitionScore),
        momentum: clamp(cluster.momentumScore),
        evidence: evidenceOf(row).refs?.length ?? 0,
        status: row.status,
        selected: row.id === selectedId
      }
    ];
  });
}

export function unplotted(whitespaces: readonly WhitespaceRow[], clusters: readonly ClusterRow[]): number {
  const plotted = new Set(dots(whitespaces, clusters, null).map((dot) => dot.id));
  return whitespaces.filter((row) => !plotted.has(row.id)).length;
}

/** Dot diameter in pixels, from the count of evidence references. */
export function dotSize(evidence: number): number {
  return 14 + Math.min(4, evidence) * 6;
}

/* ----------------------------------------------------------- experiments */

export interface Plan {
  channels?: string[];
  dailyCapMinor?: number;
  currency?: string;
  maxDays?: number;
  stopRule?: string;
  bannerKey?: string;
}

export interface Results {
  visits?: number;
  quoteStarts?: number;
  waitlist?: number;
  qualifiedDemandBps?: number;
  verdict?: string;
  note?: string;
  interim?: boolean;
  spentMinor?: number;
  replicationOf?: string;
}

export const planOf = (row: ExperimentRow): Plan => asJson<Plan>(row.trafficPlanJson, {});
export const resultsOf = (row: ExperimentRow): Results => asJson<Results>(row.resultsJson, {});

/** The states `scout:experiments:decide` may move a row to. */
export const DECISIONS = ["running", "concluded", "abandoned"] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * The verdict pill. There is no numeric success gate on the row — the plan's
 * `stopRule` is prose — so a running experiment reads as running, never as
 * "on track" or "behind" against a threshold nothing stores.
 * ponytail: add `xp.onTrack` when scout_experiments carries a numeric gate.
 */
export function verdictKey(row: ExperimentRow): { key: string; tone: "success" | "warning" | "neutral" | "danger" } {
  const verdict = resultsOf(row).verdict;
  if (row.state === "abandoned") return { key: "xp.parked", tone: "neutral" };
  if (row.state === "concluded" && verdict === "supported") return { key: "xp.supported", tone: "success" };
  if (row.state === "concluded" && verdict === "did_not_replicate") return { key: "xp.notReplicated", tone: "warning" };
  if (row.state === "concluded") return { key: "xp.concluded", tone: "neutral" };
  if (row.state === "running") return { key: "xp.running", tone: "success" };
  return { key: "xp.draft", tone: "neutral" };
}

/* --------------------------------------------------------------- labels */

export type Label = (key: string, vars?: Record<string, string>) => string;

/** Exported for `scout.labels.test.ts`, which holds every reader of this
 *  catalogue to the keys it actually contains — `labelsIn` cannot, because a
 *  miss returns the key itself. */
export const LABELS: Record<string, Record<string, string>> = {
  en: {
    /* shared */
    none: "—",
    insurer: "Carrier",
    line: "Line",
    period: "Period",
    volume: "Volume",
    share: "Share",
    winRate: "Win rate",
    priceIndex: "Price index",
    marketIndex: "Market index",
    position: "Position",
    status: "Status",
    owner: "Owner",
    /* scout_whitespaces.status */
    "status.candidate": "Candidate",
    "status.validating": "Validating",
    "status.validated": "Validated",
    "status.promoted": "Promoted",
    "status.parked": "Parked",
    why: "Why",
    evidence: "Evidence",
    method: "Method",
    confidence: "Confidence",
    kFloor: "Thin cuts withheld",
    kFloorWhy:
      "A bench cut below {k} quotes names the one counterparty behind it, so the API withholds it rather than serving it thin.",
    xlsx: "Excel",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    approvalTitle: "Queued for approval",
    approvalBody: "This change needs an approval under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.bad_intent": "That form did not say what it wanted to do.",
    "problem.whitespace_required": "Pick a theme on the radar first.",
    "problem.state_required": "Choose one of the three decisions.",
    "problem.format_required": "Choose a file format.",
    "problem.dataset_required": "Choose what to export.",
    "problem.experiment_required": "That experiment is missing.",
    "problem.transition_required": "A card cannot move there from where it is.",
    "problem.product_required": "That data product is missing.",
    "problem.floor_too_low":
      "The suppression floor on that cut is below the module's k-anonymity floor, so it cannot be published from here.",

    /* radar */
    "radar.title": "Radar",
    "radar.lede": "Whitespace read off our own signals, clusters and panel data — nothing bought in.",
    "radar.axisX": "Fit with distribution strength →",
    "radar.axisY": "Vertical axis = demand momentum · dot size = evidence volume · choose a theme for its dossier",
    "radar.pursue": "Pursue",
    "radar.park": "Park",
    "radar.empty": "No clustered whitespace yet. Run a sweep.",
    "radar.empty.body": "A sweep reads the market and groups what it finds into themes. Nothing appears here until one runs.",
    "radar.unplotted": "{n} unclustered",
    "radar.unplottedWhy":
      "Momentum is the cluster's, so a whitespace with no cluster has no vertical position and is left off the quadrant.",
    "radar.dossier": "Dossier",
    "radar.demand": "Demand estimate",
    "radar.competition": "Competition",
    "radar.momentum": "Momentum 90d",
    "radar.signals": "Cluster size",
    "radar.pick": "Choose a theme to read its dossier.",
    "radar.pick.body": "The dossier holds the evidence behind a theme, and the moves already taken on it.",
    "radar.summaryWhy": "Cluster summary written by the clusterer over {n} signals.",
    "radar.sweep": "Run the whitespace sweep",
    "radar.sweepHint": "Re-reads the last quarter of quotes and rewrites the candidate list.",
    "radar.swept": "{n} candidates written.",
    "radar.experiment": "Spin up an experiment",
    "radar.experimentHint": "Creates a draft experiment against this theme. Nothing goes live until you start it.",
    "radar.created": "Draft experiment created.",
    "radar.openBoard": "Experiment board",
    "radar.openCard": "Open the whitespace card",
    "radar.headlinePursue": "{n} whitespace themes are worth pursuing right now.",
    "radar.headlinePlotted": "{n} whitespace themes are plotted on the radar.",
    "radar.headlineUnplotted": "{n} signals have not clustered into a theme yet.",

    /* whitespace card */
    "wsp.title": "Whitespace card",
    "wsp.lede": "The whole case for one theme: what was observed, what it is estimated to be worth, what has been tried, and every move anyone has made on it.",
    "wsp.missing": "No whitespace with that reference on this board.",
    "wsp.missing.body": "It may have been merged into another theme, or the link may be stale. Open the radar to find it.",
    "wsp.openRadar": "Back to the radar",
    "wsp.draftCreative": "Draft creative for this",
    "wsp.case": "The case",
    "wsp.promotedOn": "Promoted",
    "wsp.experiments": "Experiments",
    "wsp.experimentsHint": "Every bounded test run against this theme, newest first.",
    "wsp.noExperiments": "Nothing has been tested against this theme yet.",
    "wsp.noExperiments.body": "Run an experiment from the radar to put a number behind this theme before promoting it.",
    "wsp.flags": "Regulatory flags",
    "wsp.flagsHint":
      "Items the circular feed raised on this cluster and who has to read them. A flag records that an item appeared — never what it requires.",
    "wsp.noFlags": "No regulatory items raised on this cluster.",
    "wsp.noFlags.body": "Nothing here needs a compliance review. Flags appear when a rule touches this cluster.",
    "wsp.decisions": "Decision log",
    "wsp.decisionsHint": "Every write against this card, from the audit log. Append-only.",
    "wsp.noDecisions": "No moves recorded yet.",
    "wsp.noDecisions.body": "Nobody has promoted, parked or rejected this theme yet. Every move is recorded here.",
    "wsp.decisionsWithheld": "Reading the audit log needs the audit permission.",
    "wsp.decisionsWithheld.body": "Ask an administrator for the audit permission to see who moved this card and when.",
    "wsp.move": "Move this card",
    "wsp.moveHint": "Promoting or parking a card is an approved change, so it queues for a second pair of eyes.",
    "wsp.moveDenied": "Moving a card needs the promote permission.",
    "wsp.noMoves": "This card is in a state with nowhere to move.",
    "wsp.noMoves.body": "Move it from an earlier state, or reopen it, to make the next step available.",
    "wsp.target": "Move to",
    "wsp.ownerHint": "Who carries it from here. Leave as-is to keep the current owner.",
    "wsp.moved": "Moved to {status}.",
    "wsp.ledeBoth": "{flags} regulatory flags and {experiments} experiments recorded against this theme.",
    "wsp.ledeFlags": "{flags} regulatory flags recorded against this theme.",
    "wsp.ledeExperiments": "{experiments} experiments recorded against this theme.",

    /* panel */
    "panel.title": "Panel intelligence",
    "panel.lede": "Where each carrier sits on price and conversion, for {period}.",
    "panel.empty": "No bench rows for this period.",
    "panel.empty.body": "The bench holds the competitors SCOUT is watching. Nothing was collected for this period — pick another, or add a competitor in SCOUT admin.",
    "panel.lines": "Lines",
    "panel.gaps": "Wording gaps",
    "panel.cheaper": "Below the median",
    "panel.atMarket": "At the median",
    "panel.dearer": "Above the median",
    "panel.unpriced": "No price to index",
    "panel.pack": "Build the negotiation pack",
    "panel.packHint": "Volume delivered, competitive index and the wording gaps, as a PDF.",
    "panel.packDenied": "The pack quotes counterparty numbers, so it needs the promote permission.",
    "panel.rebuild": "Rebuild the bench",
    "panel.rebuildHint":
      "Recomputes every counterparty x line x month cell from this workspace's own quote outcomes. It runs nightly; this is the same pass on demand, and running it twice writes the same numbers.",
    "panel.rebuilt": "{cells} cells rebuilt, {created} of them new.",
    "panel.rebuildDenied": "Rewriting the bench is a separate permission from reading it.",
    "panel.openPricing": "Price benchmarks",
    "panel.headlineCheaper": "{n} of {total} carriers are priced below the median.",
    "panel.headlineCount": "{n} carriers are on the bench for this period.",

    /* price benchmarks */
    "price.title": "Price benchmarks",
    "price.lede": "Our quoted price against the panel median, by line, for {period}.",
    "price.byLine": "Index against the median",
    "price.losing": "Where we lose",
    "price.note":
      "The index is our quoted price over the median of the panel's own responses to the same request. It is not an industry price survey.",
    "price.above": "{pct}% above",
    "price.below": "{pct}% below",
    "price.empty": "Nothing priced in this period.",
    "price.empty.body": "Pricing is recorded when a cut is quoted. Widen the period, or quote something, to compare.",
    "price.allBelow": "Every priced cut sits at or below the median.",
    "price.allBelow.body": "Nothing is priced above the market, so there is no premium to explain.",
    "price.headlineLosses": "{n} of {lines} lines are losing to the panel this period.",
    "price.headlineCount": "{n} lines are on the bench for this period.",

    /* experiments */
    "xp.title": "Experiments",
    "xp.lede": "Every promoted whitespace runs as a bounded experiment with a written stop rule.",
    "xp.experiment": "Experiment",
    "xp.since": "Live since",
    "xp.gate": "Stop rule",
    "xp.quotes": "Quote starts",
    "xp.waitlist": "Waitlist",
    "xp.verdict": "Verdict",
    "xp.draft": "Draft",
    "xp.running": "Running",
    "xp.concluded": "Concluded",
    "xp.supported": "Supported",
    "xp.notReplicated": "Did not replicate",
    "xp.parked": "Parked",
    "xp.interim": "Interim read",
    "xp.cap": "{amount} {currency} a day, {days} days at most",
    "xp.noPlan": "No plan recorded",
    "xp.footnote":
      "Parked is not failed — the evidence stays attached so the theme can be re-opened when the market moves.",
    "xp.decide": "Record a decision",
    "xp.decideHint": "Concluding an experiment is a decision about a build, so it is logged against you.",
    "xp.pick": "Experiment",
    "xp.newState": "Decision",
    "xp.decided": "Decision recorded.",
    "xp.empty": "No experiments yet.",
    "xp.empty.body": "An experiment tests one pricing or placement change against the current one. Start one to see it measured here.",
    "xp.openRadar": "Radar",
    "xp.headlineRunning": "{n} of {total} experiments are running right now.",
    "xp.headlineCount": "{n} experiments are on the board.",

    /* analytics */
    "an.title": "Pricing analytics",
    "an.lede": "Elasticity, win rate and price adequacy across the whole bench.",
    "an.periods": "Periods on the bench",
    "an.winRate": "Blended win rate",
    "an.adequacy": "Volume at or below the median",
    "an.index": "Blended index",
    "an.pricedVolume": "Priced volume",
    "an.elasticity": "Observed elasticity",
    "an.elasticityHint":
      "Win-rate points moved per percent of price moved, between the last two periods of each cut. Observed, not measured: no experiment moved these prices on purpose.",
    "an.move": "Price move",
    "an.winMove": "Win-rate move",
    "an.ratio": "Points per percent",
    "an.window": "Periods",
    "an.held": "Price held",
    "an.empty": "Fewer than two periods on the bench, so there is nothing to compare.",
    "an.empty.body": "Comparison needs a before and an after. Once a second period is benched, the movement between them appears here.",
    "an.export": "Export",
    "an.exportHint": "Rendered by the platform's own report engine, with its own masking rules.",
    "an.dataset": "Table",
    "an.format": "Format",
    "an.whitespaces": "Whitespace pipeline",
    "an.signals": "Signal volume",
    "an.clusters": "Signal clusters",
    "an.experiments": "Experiments",
    "an.dataProducts": "Data products",
    "an.exportReady": "Ready.",
    "an.exportQueued": "Queued.",
    "an.download": "Download",
    "an.benchNotExportable": "The bench itself is not exportable",
    "an.benchNotExportableWhy":
      "The report engine has no price-bench table registered, so the index and win-rate figures above cannot be rendered as a file. The negotiation pack is the export that carries them.",
    "an.openPanel": "Panel intelligence",
    "an.headlineAdequacy": "{pct}% of priced volume sits at or below the median, across {periods} periods.",
    "an.headlineCount": "{n} periods are on the bench.",

    /* data products */
    "dtp.title": "Data products",
    "dtp.lede":
      "Insight packaged and sold back to the panel. Every cut names its consent basis and the floor below which its cells are suppressed.",
    "dtp.empty": "No data product has been defined yet.",
    "dtp.empty.body": "A data product packages a dataset for someone else to consume. Define the first one to start.",
    "dtp.monitor": "K-anonymity monitor",
    "dtp.monitorHint": "The floor is the promise. A cut that can name one counterparty is flagged however high its floor.",
    "dtp.published": "Published",
    "dtp.floor": "Module floor",
    "dtp.subscribing": "Subscribing carriers",
    "dtp.flagged": "Flagged",
    "dtp.catalogue": "Catalogue",
    "dtp.catalogueHint": "Most recently changed first.",
    "dtp.cutHint": "The cut as the builder defined it — not recomputed here.",
    "dtp.source": "Source",
    "dtp.window": "Window",
    "dtp.dimensions": "Dimensions",
    "dtp.measures": "Measures",
    "dtp.consent": "Consent basis",
    "dtp.k": "k ≥ {floor}",
    "dtp.kHint": "Cells below this count are suppressed, not rounded.",
    "dtp.cadence": "Rebuilds {cadence}.",
    "dtp.noCadence": "No rebuild cadence set.",
    "dtp.buildFailed": "The last build did not complete",
    "dtp.subscribers": "Subscribers",
    "dtp.subscribersHint": "Read from the product's own subscriber list, suspensions included.",
    "dtp.noSubscribers": "Nobody subscribes to this product yet.",
    "dtp.noSubscribers.body": "Nobody is receiving it. Add a subscriber to start delivering cuts to them.",
    "dtp.active": "Active",
    "dtp.suspendedOn": "Suspended",
    "dtp.deliveries": "Delivery log",
    "dtp.deliveriesHint": "Cuts of this product rendered by the platform's report engine.",
    "dtp.noDeliveries": "No cut of this product has been rendered yet.",
    "dtp.noDeliveries.body": "Nothing has been produced yet. A cut is rendered on the product's schedule, or on demand.",
    "dtp.move": "Change status",
    "dtp.moveHint": "Publishing exposes the cut to its subscribers. Suspending withdraws it without deleting it.",
    "dtp.moveDenied": "Publishing a data product needs the SCOUT publish permission.",
    "dtp.noMoves": "This product has no status left to move to.",
    "dtp.noMoves.body": "It is in a final state. Reopen it from an earlier stage to make the next step available.",
    "dtp.target": "New status",
    "dtp.moved": "Moved to {status}.",
    "dtp.status.draft": "Draft",
    "dtp.status.published": "Published",
    "dtp.status.suspended": "Suspended",
    "dtp.delivery.api": "API feed",
    "dtp.delivery.report": "Report",
    "dtp.refresh.fresh": "Last built",
    "dtp.refresh.stale": "Stale since",
    "dtp.refresh.never_run": "Never built.",
    "dtp.refresh.halted": "Halted at",
    "dtp.warn.belowFloor": "Floor below the module minimum",
    "dtp.warnWhy.belowFloor": "This cut suppresses below the module's floor of {floor}, so thin cells could reach a subscriber.",
    "dtp.warn.singleCounterparty": "Keyed on one counterparty",
    "dtp.warnWhy.singleCounterparty":
      "Every cell of a cut keyed on the carrier names that carrier, whatever the floor is set to.",
    "dtp.warn.staleFeed": "Published on a feed that is not building",
    "dtp.warnWhy.staleFeed": "Subscribers are reading a cut older than its own cadence claims.",
    "dtp.openRadar": "Back to the radar",
    "dtp.headlineFlagged": "{n} of {total} data products are flagged for review.",
    "dtp.headlinePublished": "{n} of {total} data products are published.",

    /* screen 6 — SCOUT admin */
    "adm.title": "SCOUT settings",
    "adm.lede":
      "What governs the module, and where each number lives. Some of these are tenant settings; the rest are the module's own code, and this screen says which is which rather than pretending otherwise.",
    "adm.sources": "Signal sources",
    "adm.sourcesHint":
      "Counted from the signals themselves. A source with nothing in the last {days} days reads as quiet, whether it stopped or never started.",
    "adm.live": "Ingesting",
    "adm.quiet": "Quiet",
    "adm.neverIngested": "Never ingested",
    "adm.noConnectors": "No source fetches from outside yet",
    "adm.noConnectorsWhy":
      "Every adapter listed above reads what this workspace already holds, or takes what an integrator fed it. Search trends, review sites, news and regulatory feeds are third-party services: each needs a recorded decision before it is switched on, and the adapters plug into the same registry when it is. Crawl politeness, robots handling and per-source credentials travel with the adapter, not with a setting on this screen.",
    "adm.floors": "Suppression floors",
    "adm.floorsHint": "The k-anonymity guarantee behind every data product and every panel benchmark.",
    "adm.defaultFloor": "Module floor",
    "adm.defaultFloorWhy":
      "Compiled into the module, not a tenant setting: cuts below it are suppressed before a reader sees them. Changing it is a code change with an ADR, so it cannot drift per tenant.",
    "adm.overrides": "Products with their own floor",
    "adm.noOverrides": "Every data product uses the module floor.",
    "adm.thresholds": "SCOUT policy thresholds",
    "adm.thresholdsHint": "Versioned in the compliance threshold store. A change is a new version, never an edit.",
    "adm.version": "v{version}",
    "adm.dualControl": "Dual control",
    "adm.setBy": "Set by {who},",
    "adm.noThresholds": "SCOUT has no policy threshold set",
    "adm.noThresholdsWhy":
      "Whitespace detection compares each category against the panel's own mean rather than a fixed number, so there is no momentum threshold to tune. Nothing else in the module reads a numeric limit.",
    "adm.approvals": "Approval gates",
    "adm.approvalsHint":
      "Promoting a whitespace to a validated opportunity is the module's one gated move; publishing a data product carries the same permission check.",
    "adm.pending": "{count} awaiting a decision.",
    "adm.headlinePending": "{n} SCOUT changes are awaiting a decision.",
    "adm.headlineQuiet": "{n} signal sources have gone quiet.",
    "adm.noApprovals": "No SCOUT change has been sent for approval.",
    "adm.noApprovals.body": "Threshold and guardrail edits queue here for a second pair of eyes. Nothing on this screen has been changed yet.",
    "adm.noLibrary": "Hypothesis templates are not stored",
    "adm.noLibraryWhy":
      "Experiments are written against a whitespace row rather than instantiated from a library, so there is no template set to edit. Copy an experiment that worked instead.",
    "adm.openProducts": "Open the data products",
    "adm.source.search": "Search demand",
    "adm.source.quotes": "Quote flow",
    "adm.source.abandonment": "Abandonment",
    "adm.source.reviews": "Reviews",
    "adm.source.news": "News",
    "adm.source.regulatory": "Regulatory",
    "adm.registry": "Registered adapters",
    "adm.registryHint":
      "What can arrive, as the module declares it. An adapter marked outside LYRA fetches from a third party; none does today.",
    "adm.adapterInternal": "Reads rows LYRA already holds",
    "adm.adapterExternal": "Fetches from outside LYRA",
    "adm.watch": "Competitor and regulatory watch",
    "adm.watchHint":
      "Each watched subject's last {days} days scored against the {days} before them. A reading, not a record — nothing here is stored.",
    "adm.watchNone": "Nothing is being watched yet",
    "adm.watchNone.body":
      "News, review and regulatory signals appear here once they are ingested. Feed one through the signals API, or open the developer screen for the shape it takes.",
    "adm.watchCount": "{n} observations",
    "adm.watchNew": "New to the watch",
    "adm.watchDelta": "{pct}% against the window before",
    "watch.kind.competitor": "Competitor",
    "watch.kind.regulatory": "Regulatory",
    "watch.severity.urgent": "Moving fast",
    "watch.severity.attention": "Worth a look",
    "watch.severity.info": "Steady",

    /* dev */
    "dev.title": "SCOUT for integrators",
    "dev.lede":
      "The two SCOUT calls that are not plain CRUD, run against this tenant's own data so what you see here is what your key returns.",
    "dev.similar": "Nearest signals",
    "dev.similarWhy":
      "Every ingested signal is embedded into the market index. This asks that index which stored signals sit closest to a phrase — the check to run before ingesting, to see whether the harvester already holds it.",
    "dev.text": "Phrase",
    "dev.textHint": "Up to {max} characters. The endpoint embeds it; it is not stored.",
    "dev.topK": "Neighbours",
    "dev.topKHint": "A whole number from 1 to {max}.",
    "dev.run": "Find neighbours",
    "dev.matchesCaption": "Stored signals nearest the phrase, closest first.",
    "dev.col.signal": "Signal",
    "dev.col.source": "Source",
    "dev.col.observed": "Observed",
    "dev.col.score": "Distance",
    "dev.noMatches": "Nothing near that phrase",
    "dev.noMatchesWhy":
      "Either the index holds nothing like it, or the signals it matched have since been deleted — a match without a row is dropped rather than served as a bare id.",
    "dev.raw": "Raw response",
    "dev.ran.similar": "Query ran against the live index.",
    "dev.ran.diff": "Wording compared.",
    "dev.diff": "Wording differ",
    "dev.diffWhy":
      "The same word-level comparison the panel bench uses to show what a carrier changed between two versions of a wording. Paste plain text — extracting text from a PDF is not done here (ADR-0016).",
    "dev.textA": "Before",
    "dev.textB": "After",
    "dev.diffRun": "Compare",
    "dev.diffCounts": "{added} words added · {removed} removed · {kept} unchanged.",
    "dev.curl": "The same calls from your own client",
    "dev.curlWhy": "Bearer authentication with an API key; the tenant comes from the key, never from the body.",
    "dev.ingestWhy":
      "Ingesting is not offered on this screen: writing a signal needs scout:signals:ingest, which belongs to a harvester key rather than to a person signed in here. The contract is:",
    "dev.keys": "Mint the key in the developer portal — it is never shown here.",
    "dev.noEvents": "SCOUT publishes no events",
    "dev.noEventsWhy":
      "Nothing in this module emits onto the event bus, so there is no topic to subscribe a webhook to. Poll the reads, or subscribe to the module that acts on a promoted opportunity.",
    "dev.openRadar": "Open the radar",
    "dev.openPanel": "Open the panel bench",
    "problem.both_texts": "Both versions of the wording are needed to compare them.",
    "problem.text_required": "Type a phrase to search for.",
    "problem.text_too_long": "That phrase is longer than the endpoint accepts.",
    "problem.bad_topk": "Neighbours must be a whole number from 1 to 20."
  },
  ar: {
    /* shared */
    none: "—",
    insurer: "شركة التأمين",
    line: "خط الأعمال",
    period: "الفترة",
    volume: "الحجم",
    share: "الحصة",
    winRate: "معدل الفوز",
    priceIndex: "مؤشر السعر",
    marketIndex: "مؤشر السوق",
    position: "الموقع",
    status: "الحالة",
    owner: "المسؤول",
    /* scout_whitespaces.status */
    "status.candidate": "مرشحة",
    "status.validating": "قيد التحقق",
    "status.validated": "مُثبتة",
    "status.promoted": "معتمدة",
    "status.parked": "موقوفة",
    why: "السبب",
    evidence: "الأدلة",
    method: "الطريقة",
    confidence: "درجة الثقة",
    kFloor: "الفئات القليلة محجوبة",
    kFloorWhy: "الفئة التي تقل عن {k} عرض سعر تكشف الطرف الوحيد خلفها، لذا تحجبها الواجهة بدل تقديمها ناقصة.",
    xlsx: "إكسل",
    pdf: "بي دي إف",
    csv: "ملف مفصول بفواصل",
    json: "جيسون",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "هذا التغيير يحتاج موافقة بموجب سياسة {policy}. هو في الانتظار ولم يُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.bad_intent": "لم يحدد هذا النموذج ما يريد فعله.",
    "problem.whitespace_required": "اختر فكرة من الرادار أولًا.",
    "problem.state_required": "اختر واحدًا من القرارات الثلاثة.",
    "problem.format_required": "اختر صيغة الملف.",
    "problem.dataset_required": "اختر ما تريد تصديره.",
    "problem.experiment_required": "هذه التجربة غير موجودة.",
    "problem.transition_required": "لا يمكن نقل البطاقة إلى تلك الحالة من حالتها الراهنة.",
    "problem.product_required": "هذا المنتج المعرفي غير موجود.",
    "problem.floor_too_low": "حد الإخفاء في هذا التقطيع أقل من حد إخفاء الهوية للوحدة، لذا لا يمكن نشره من هنا.",

    /* radar */
    "radar.title": "الرادار",
    "radar.lede": "فرص غير مخدومة مستخلصة من إشاراتنا وعناقيدنا وبيانات قائمة الجهات المسعّرة — لا شيء مُشترى من الخارج.",
    "radar.axisX": "الملاءمة مع قوة التوزيع ←",
    "radar.axisY": "المحور الرأسي = زخم الطلب · حجم النقطة = كمية الأدلة · اختر فكرة لعرض ملفها",
    "radar.pursue": "تابع",
    "radar.park": "أوقف",
    "radar.empty": "لا توجد فرص معنقدة بعد. شغّل عملية المسح.",
    "radar.empty.body": "تقرأ عملية المسح السوق وتجمع ما تجده في أفكار. لا يظهر شيء هنا قبل تشغيلها.",
    "radar.unplotted": "{n} بلا عنقود",
    "radar.unplottedWhy": "الزخم يأتي من العنقود، فالفرصة بلا عنقود ليس لها موضع رأسي وتُترك خارج المخطط.",
    "radar.dossier": "الملف",
    "radar.demand": "تقدير الطلب",
    "radar.competition": "المنافسة",
    "radar.momentum": "الزخم ٩٠ يومًا",
    "radar.signals": "حجم العنقود",
    "radar.pick": "اختر فكرة لقراءة ملفها.",
    "radar.pick.body": "يحوي الملف الأدلة خلف الفكرة والخطوات المتخذة عليها.",
    "radar.summaryWhy": "ملخص العنقود كتبته أداة التجميع العنقودي من {n} إشارة.",
    "radar.sweep": "شغّل مسح الفرص",
    "radar.sweepHint": "يعيد قراءة عروض الربع الأخير ويكتب قائمة المرشحات من جديد.",
    "radar.swept": "تمت كتابة {n} مرشحًا.",
    "radar.experiment": "أنشئ تجربة",
    "radar.experimentHint": "ينشئ تجربة مسودة على هذه الفكرة. لا شيء ينطلق قبل أن تبدأها.",
    "radar.created": "تم إنشاء تجربة مسودة.",
    "radar.openBoard": "لوحة التجارب",
    "radar.openCard": "فتح بطاقة الفرصة",
    "radar.headlinePursue": "{n} من فرص الفراغ التسويقي تستحق المتابعة الآن.",
    "radar.headlinePlotted": "{n} من فرص الفراغ التسويقي مرسومة على الرادار.",
    "radar.headlineUnplotted": "{n} إشارة لم تتجمع في فكرة بعد.",

    /* whitespace card */
    "wsp.title": "بطاقة الفرصة",
    "wsp.lede": "الملف الكامل لفرصة واحدة: ما رُصد، وما تقدير قيمته، وما جُرّب، وكل خطوة اتخذها أحد بشأنه.",
    "wsp.missing": "لا توجد فرصة بهذا المرجع على هذه اللوحة.",
    "wsp.missing.body": "ربما دُمجت في فرصة أخرى، أو الرابط قديم. افتح الرادار للعثور عليها.",
    "wsp.openRadar": "العودة إلى الرادار",
    "wsp.draftCreative": "اكتب محتوى لهذه الفرصة",
    "wsp.case": "الملف",
    "wsp.promotedOn": "اعتُمدت",
    "wsp.experiments": "التجارب",
    "wsp.experimentsHint": "كل اختبار محدود جرى على هذه الفرصة، الأحدث أولاً.",
    "wsp.noExperiments": "لم يُختبر شيء على هذه الفرصة بعد.",
    "wsp.noExperiments.body": "شغّل تجربة من الرادار لتضع رقماً خلف هذه الفرصة قبل ترقيتها.",
    "wsp.flags": "تنبيهات تنظيمية",
    "wsp.flagsHint":
      "البنود التي رصدها موجز التعاميم على هذه المجموعة ومَن عليه قراءتها. التنبيه يسجّل ظهور البند فقط، لا ما يقتضيه.",
    "wsp.noFlags": "لا بنود تنظيمية على هذه المجموعة.",
    "wsp.noFlags.body": "لا شيء هنا يحتاج مراجعة امتثال. تظهر البنود عندما تمسّ قاعدة هذه المجموعة.",
    "wsp.decisions": "سجل القرارات",
    "wsp.decisionsHint": "كل تعديل على هذه البطاقة، من سجل التدقيق. للإضافة فقط.",
    "wsp.noDecisions": "لم تُسجّل أي خطوة بعد.",
    "wsp.noDecisions.body": "لم يرقِّ أحد هذه الفرصة أو يؤجلها أو يرفضها بعد. تُسجَّل كل خطوة هنا.",
    "wsp.decisionsWithheld": "قراءة سجل التدقيق تحتاج صلاحية التدقيق.",
    "wsp.decisionsWithheld.body": "اطلب من المسؤول صلاحية التدقيق لترى من نقل هذه البطاقة ومتى.",
    "wsp.move": "نقل البطاقة",
    "wsp.moveHint": "اعتماد البطاقة أو إيقافها تغيير خاضع للموافقة، لذا ينتظر مراجعة ثانية.",
    "wsp.moveDenied": "نقل البطاقة يحتاج صلاحية الاعتماد.",
    "wsp.noMoves": "هذه البطاقة في حالة لا نقل منها.",
    "wsp.noMoves.body": "انقلها من حالة أسبق، أو أعد فتحها، لتتاح الخطوة التالية.",
    "wsp.target": "النقل إلى",
    "wsp.ownerHint": "من يتولاها من هنا. اتركه كما هو للإبقاء على المسؤول الحالي.",
    "wsp.moved": "نُقلت إلى {status}.",
    "wsp.ledeBoth": "{flags} تنبيهًا تنظيميًا و{experiments} تجربة مسجلة على هذه الفكرة.",
    "wsp.ledeFlags": "{flags} تنبيهًا تنظيميًا مسجلة على هذه الفكرة.",
    "wsp.ledeExperiments": "{experiments} تجربة مسجلة على هذه الفكرة.",

    /* panel */
    "panel.title": "معلومات قائمة الجهات المسعّرة",
    "panel.lede": "موقع كل شركة تأمين من حيث السعر والتحويل، لفترة {period}.",
    "panel.empty": "لا توجد صفوف مقارنة لهذه الفترة.",
    "panel.empty.body": "تضم القائمة المنافسين الذين يراقبهم سكاوت. لم يُجمع شيء لهذه الفترة — اختر فترة أخرى أو أضف منافساً في إدارة سكاوت.",
    "panel.lines": "خطوط الأعمال",
    "panel.gaps": "فروق الصياغة",
    "panel.cheaper": "أقل من الوسيط",
    "panel.atMarket": "عند الوسيط",
    "panel.dearer": "أعلى من الوسيط",
    "panel.unpriced": "لا سعر للمقارنة",
    "panel.pack": "أنشئ ملف التفاوض",
    "panel.packHint": "الحجم المحوّل ومؤشر المنافسة وفروق الصياغة، في ملف بي دي إف.",
    "panel.packDenied": "الملف يذكر أرقام الأطراف الأخرى، لذا يحتاج صلاحية الترقية.",
    "panel.rebuild": "أعد بناء المقارنة",
    "panel.rebuildHint":
      "يعيد حساب كل خلية طرف × خط × شهر من نتائج التسعير في مساحة العمل نفسها. يعمل ليليًا، وهذا المرور نفسه عند الطلب، وتشغيله مرتين يكتب الأرقام ذاتها.",
    "panel.rebuilt": "أُعيد بناء {cells} خلية، {created} منها جديدة.",
    "panel.rebuildDenied": "إعادة كتابة المقارنة صلاحية منفصلة عن قراءتها.",
    "panel.openPricing": "مقاييس السعر",
    "panel.headlineCheaper": "{n} من أصل {total} شركة تأمين مسعّرة دون الوسيط.",
    "panel.headlineCount": "{n} شركة تأمين على القائمة لهذه الفترة.",

    /* price benchmarks */
    "price.title": "مقاييس السعر",
    "price.lede": "سعرنا المعروض مقابل وسيط قائمة الجهات المسعّرة، بحسب خط الأعمال، لفترة {period}.",
    "price.byLine": "المؤشر مقابل الوسيط",
    "price.losing": "أين نخسر",
    "price.note": "المؤشر هو سعرنا المعروض مقسومًا على وسيط ردود الجهات المسعّرة على الطلب نفسه. وهو ليس مسحًا لأسعار السوق.",
    "price.above": "{pct}٪ أعلى",
    "price.below": "{pct}٪ أقل",
    "price.empty": "لا شيء مُسعّر في هذه الفترة.",
    "price.empty.body": "يُسجَّل التسعير عند تسعير فئة. وسّع الفترة أو سعّر شيئاً للمقارنة.",
    "price.allBelow": "كل الفئات المُسعّرة عند الوسيط أو أقل منه.",
    "price.allBelow.body": "لا شيء مُسعّر فوق السوق، فلا علاوة تحتاج تفسيراً.",
    "price.headlineLosses": "{n} من أصل {lines} خط أعمال يخسر أمام قائمة الجهات المسعّرة هذه الفترة.",
    "price.headlineCount": "{n} خط أعمال على القائمة لهذه الفترة.",

    /* experiments */
    "xp.title": "التجارب",
    "xp.lede": "كل فرصة مرقّاة تُدار كتجربة محدودة لها قاعدة توقف مكتوبة.",
    "xp.experiment": "التجربة",
    "xp.since": "تعمل منذ",
    "xp.gate": "قاعدة التوقف",
    "xp.quotes": "بدايات العرض",
    "xp.waitlist": "قائمة الانتظار",
    "xp.verdict": "الحكم",
    "xp.draft": "مسودة",
    "xp.running": "جارية",
    "xp.concluded": "منتهية",
    "xp.supported": "مدعومة",
    "xp.notReplicated": "لم تتكرر",
    "xp.parked": "موقوفة",
    "xp.interim": "قراءة مؤقتة",
    "xp.cap": "{amount} {currency} يوميًا، {days} يومًا كحد أقصى",
    "xp.noPlan": "لا خطة مسجلة",
    "xp.footnote": "الإيقاف ليس فشلًا — تبقى الأدلة مرفقة ليُعاد فتح الفكرة عندما يتغير السوق.",
    "xp.decide": "سجّل قرارًا",
    "xp.decideHint": "إنهاء تجربة هو قرار بشأن بناء منتج، لذا يُسجَّل باسمك.",
    "xp.pick": "التجربة",
    "xp.newState": "القرار",
    "xp.decided": "تم تسجيل القرار.",
    "xp.empty": "لا توجد تجارب بعد.",
    "xp.empty.body": "تختبر التجربة تغييراً واحداً في التسعير أو الموضع مقابل الحالي. ابدأ واحدة لترى قياسها هنا.",
    "xp.openRadar": "الرادار",
    "xp.headlineRunning": "{n} من أصل {total} تجربة تعمل الآن.",
    "xp.headlineCount": "{n} تجربة على اللوحة.",

    /* analytics */
    "an.title": "تحليلات التسعير",
    "an.lede": "المرونة ومعدل الفوز وكفاية السعر على كامل قائمة الجهات المسعّرة.",
    "an.periods": "الفترات على القائمة",
    "an.winRate": "معدل الفوز المدمج",
    "an.adequacy": "الحجم عند الوسيط أو أقل",
    "an.index": "المؤشر المدمج",
    "an.pricedVolume": "الحجم المُسعّر",
    "an.elasticity": "المرونة المرصودة",
    "an.elasticityHint":
      "نقاط معدل الفوز مقابل كل نقطة مئوية من تغير السعر، بين آخر فترتين لكل فئة. مرصودة لا مقيسة: لا تجربة حرّكت هذه الأسعار عن قصد.",
    "an.move": "تغير السعر",
    "an.winMove": "تغير معدل الفوز",
    "an.ratio": "نقاط لكل بالمئة",
    "an.window": "الفترات",
    "an.held": "السعر ثابت",
    "an.empty": "أقل من فترتين على القائمة، فلا شيء للمقارنة.",
    "an.empty.body": "تحتاج المقارنة إلى فترة سابقة ولاحقة. بمجرد إضافة فترة ثانية، تظهر الحركة بينهما هنا.",
    "an.export": "تصدير",
    "an.exportHint": "يُنتجه محرك التقارير في المنصة، بقواعد الحجب الخاصة به.",
    "an.dataset": "الجدول",
    "an.format": "الصيغة",
    "an.whitespaces": "مسار الفرص",
    "an.signals": "حجم الإشارات",
    "an.clusters": "تجمعات الإشارات",
    "an.experiments": "التجارب",
    "an.dataProducts": "منتجات البيانات",
    "an.exportReady": "جاهز.",
    "an.exportQueued": "في الانتظار.",
    "an.download": "تنزيل",
    "an.benchNotExportable": "جدول المقارنة نفسه غير قابل للتصدير",
    "an.benchNotExportableWhy":
      "محرك التقارير لا يسجّل جدول مقارنة الأسعار، لذا لا يمكن إخراج أرقام المؤشر ومعدل الفوز أعلاه كملف. ملف التفاوض هو التصدير الذي يحملها.",
    "an.openPanel": "معلومات قائمة الجهات المسعّرة",
    "an.headlineAdequacy": "{pct}٪ من الحجم المُسعّر عند الوسيط أو أقل، عبر {periods} فترة.",
    "an.headlineCount": "{n} فترة على القائمة.",

    /* data products */
    "dtp.title": "المنتجات المعرفية",
    "dtp.lede": "رؤى مُعبّأة وتُباع لقائمة الجهات المسعّرة. كل تقطيع يذكر أساس الموافقة والحد الذي تُخفى دونه الخانات.",
    "dtp.empty": "لم يُعرَّف أي منتج معرفي بعد.",
    "dtp.empty.body": "يحزم المنتج المعرفي مجموعة بيانات ليستهلكها طرف آخر. عرّف أول واحد للبدء.",
    "dtp.monitor": "مراقب إخفاء الهوية",
    "dtp.monitorHint": "الحد هو الوعد. أي تقطيع يمكنه تسمية طرف واحد يُعلَّم مهما ارتفع حده.",
    "dtp.published": "منشور",
    "dtp.floor": "حد الوحدة",
    "dtp.subscribing": "الجهات المشتركة",
    "dtp.flagged": "مُعلَّم",
    "dtp.catalogue": "الفهرس",
    "dtp.catalogueHint": "الأحدث تغييرًا أولًا.",
    "dtp.cutHint": "التقطيع كما عرّفه المُنشئ — لا يُعاد حسابه هنا.",
    "dtp.source": "المصدر",
    "dtp.window": "النافذة",
    "dtp.dimensions": "الأبعاد",
    "dtp.measures": "المقاييس",
    "dtp.consent": "أساس الموافقة",
    "dtp.k": "ك ≥ {floor}",
    "dtp.kHint": "الخانات دون هذا العدد تُخفى ولا تُقرَّب.",
    "dtp.cadence": "يُعاد بناؤه {cadence}.",
    "dtp.noCadence": "لا وتيرة إعادة بناء محددة.",
    "dtp.buildFailed": "آخر بناء لم يكتمل",
    "dtp.subscribers": "المشتركون",
    "dtp.subscribersHint": "مقروء من قائمة مشتركي المنتج نفسها، بما فيها التعليقات.",
    "dtp.noSubscribers": "لا أحد مشترك في هذا المنتج بعد.",
    "dtp.noSubscribers.body": "لا أحد يستلمه. أضف مشتركاً لتبدأ تسليم النسخ إليه.",
    "dtp.active": "نشط",
    "dtp.suspendedOn": "معلَّق",
    "dtp.deliveries": "سجل التسليم",
    "dtp.deliveriesHint": "نسخ من هذا المنتج أنتجها محرك التقارير في المنصة.",
    "dtp.noDeliveries": "لم تُنتج أي نسخة من هذا المنتج بعد.",
    "dtp.noDeliveries.body": "لم يُنتج شيء بعد. تُنتج النسخة وفق جدول المنتج أو عند الطلب.",
    "dtp.move": "تغيير الحالة",
    "dtp.moveHint": "النشر يكشف التقطيع لمشتركيه. التعليق يسحبه دون حذفه.",
    "dtp.moveDenied": "نشر منتج معرفي يحتاج صلاحية النشر في سكاوت.",
    "dtp.noMoves": "لا حالة أخرى ينتقل إليها هذا المنتج.",
    "dtp.noMoves.body": "إنه في حالة نهائية. أعد فتحه من مرحلة أسبق لتتاح الخطوة التالية.",
    "dtp.target": "الحالة الجديدة",
    "dtp.moved": "انتقل إلى {status}.",
    "dtp.status.draft": "مسودة",
    "dtp.status.published": "منشور",
    "dtp.status.suspended": "معلَّق",
    "dtp.delivery.api": "تغذية برمجية",
    "dtp.delivery.report": "تقرير",
    "dtp.refresh.fresh": "آخر بناء",
    "dtp.refresh.stale": "متقادم منذ",
    "dtp.refresh.never_run": "لم يُبنَ قط.",
    "dtp.refresh.halted": "توقف عند",
    "dtp.warn.belowFloor": "الحد أقل من حد الوحدة",
    "dtp.warnWhy.belowFloor": "هذا التقطيع يخفي دون حد الوحدة البالغ {floor}، فقد تصل خانات رقيقة إلى مشترك.",
    "dtp.warn.singleCounterparty": "مُفهرس على طرف واحد",
    "dtp.warnWhy.singleCounterparty": "كل خانة في تقطيع مُفهرس على الجهة المسعّرة تسمي تلك الجهة مهما كان الحد.",
    "dtp.warn.staleFeed": "منشور على تغذية لا تُبنى",
    "dtp.warnWhy.staleFeed": "المشتركون يقرؤون تقطيعًا أقدم مما تدّعيه وتيرته.",
    "dtp.openRadar": "العودة إلى الرادار",
    "dtp.headlineFlagged": "{n} من أصل {total} منتج معرفي مُعلَّم للمراجعة.",
    "dtp.headlinePublished": "{n} من أصل {total} منتج معرفي منشور.",

    /* الشاشة ٦ — إعدادات سكاوت */
    "adm.title": "إعدادات سكاوت",
    "adm.lede":
      "ما الذي يحكم الوحدة، وأين يعيش كل رقم. بعضها إعدادات للمستأجر، وبقيتها في شفرة الوحدة نفسها، وهذه الشاشة تقول أيّها أيّ.",
    "adm.sources": "مصادر الإشارات",
    "adm.sourcesHint":
      "محسوبة من الإشارات ذاتها. مصدر بلا شيء خلال {days} يومًا يُقرأ هادئًا، سواء توقف أم لم يبدأ أصلًا.",
    "adm.live": "يستقبل",
    "adm.quiet": "هادئ",
    "adm.neverIngested": "لم يستقبل قط",
    "adm.noConnectors": "لا مصدر يجلب من الخارج بعد",
    "adm.noConnectorsWhy":
      "كل موصل في الأعلى يقرأ ما تملكه مساحة العمل أصلًا أو يأخذ ما يرسله المُكامِل. اتجاهات البحث ومواقع المراجعات وخلاصات الأخبار والتنظيم خدمات طرف ثالث: لكل منها قرار مسجَّل قبل تشغيله، وتتصل بالسجل نفسه عند تشغيلها. أدب الزحف ومعالجة robots وبيانات الاعتماد تسافر مع الموصل لا مع إعداد في هذه الشاشة.",
    "adm.floors": "حدود الكبت",
    "adm.floorsHint": "ضمان إخفاء الهوية خلف كل منتج معرفي وكل مقارنة لوحة.",
    "adm.defaultFloor": "حد الوحدة",
    "adm.defaultFloorWhy":
      "مُدمج في الوحدة لا إعدادًا للمستأجر: ما دونه يُكبت قبل أن يراه قارئ. تغييره تغيير شفرة بقرار معماري، فلا ينحرف بين المستأجرين.",
    "adm.overrides": "منتجات لها حدّها الخاص",
    "adm.noOverrides": "كل منتج معرفي يستخدم حد الوحدة.",
    "adm.thresholds": "حدود سياسة سكاوت",
    "adm.thresholdsHint": "مُصدَّرة في مخزن حدود الامتثال. التغيير نسخة جديدة، لا تعديل.",
    "adm.version": "ن{version}",
    "adm.dualControl": "رقابة مزدوجة",
    "adm.setBy": "ضبطها {who}،",
    "adm.noThresholds": "لا حد سياسة مضبوطًا لسكاوت",
    "adm.noThresholdsWhy":
      "كشف الفجوات يقارن كل فئة بمتوسط اللوحة نفسه لا برقم ثابت، فلا حدّ زخم يُضبط. ولا شيء آخر في الوحدة يقرأ حدًا عدديًا.",
    "adm.approvals": "بوابات الموافقة",
    "adm.approvalsHint":
      "ترقية فجوة إلى فرصة مُتحقَّقة هي الخطوة المحكومة الوحيدة في الوحدة؛ ونشر منتج معرفي يحمل التحقق ذاته من الصلاحية.",
    "adm.pending": "{count} بانتظار قرار.",
    "adm.headlinePending": "{n} تغييرًا في سكاوت بانتظار قرار.",
    "adm.headlineQuiet": "{n} مصدر إشارات أصبح هادئًا.",
    "adm.noApprovals": "لم يُرسل أي تغيير في سكاوت للموافقة.",
    "adm.noApprovals.body": "تنتظر تعديلات الحدود والضوابط هنا مراجعة ثانية. لم يُغيَّر شيء في هذه الشاشة بعد.",
    "adm.noLibrary": "قوالب الفرضيات غير مخزَّنة",
    "adm.noLibraryWhy":
      "التجارب تُكتب على صف فجوة لا تُنشأ من مكتبة، فلا مجموعة قوالب تُحرَّر. انسخ تجربة نجحت بدلًا من ذلك.",
    "adm.openProducts": "افتح المنتجات المعرفية",
    "adm.source.search": "طلب البحث",
    "adm.source.quotes": "مسار التسعير",
    "adm.source.abandonment": "التخلي عن الطلب",
    "adm.source.reviews": "المراجعات",
    "adm.source.news": "الأخبار",
    "adm.source.regulatory": "تنظيمي",
    "adm.registry": "الموصلات المسجَّلة",
    "adm.registryHint":
      "ما الذي يمكن أن يصل، كما تعلنه الوحدة. الموصل المعلَّم بأنه خارج ليرا يجلب من طرف ثالث، ولا موصل كذلك اليوم.",
    "adm.adapterInternal": "يقرأ صفوفًا تملكها ليرا أصلًا",
    "adm.adapterExternal": "يجلب من خارج ليرا",
    "adm.watch": "مراقبة المنافسين والتنظيم",
    "adm.watchHint":
      "كل موضوع مراقَب: آخر {days} يومًا مقيسة على {days} يومًا قبلها. قراءة لا سجل — لا يُخزَّن شيء هنا.",
    "adm.watchNone": "لا شيء تحت المراقبة بعد",
    "adm.watchNone.body":
      "تظهر هنا إشارات الأخبار والمراجعات والتنظيم بعد استقبالها. أرسل واحدة عبر واجهة الإشارات، أو افتح شاشة المطوِّر لترى شكلها.",
    "adm.watchCount": "{n} ملاحظة",
    "adm.watchNew": "جديد على المراقبة",
    "adm.watchDelta": "{pct}٪ مقابل النافذة السابقة",
    "watch.kind.competitor": "منافس",
    "watch.kind.regulatory": "تنظيمي",
    "watch.severity.urgent": "يتحرك بسرعة",
    "watch.severity.attention": "يستحق النظر",
    "watch.severity.info": "مستقر",

    /* dev */
    "dev.title": "سكاوت للمطوِّرين",
    "dev.lede":
      "نداءا سكاوت اللذان ليسا عمليات سجلات عادية، يعملان على بيانات هذا المستأجر نفسها، فما تراه هنا هو ما يُعيده مفتاحك.",
    "dev.similar": "أقرب الإشارات",
    "dev.similarWhy":
      "كل إشارة مُستقبَلة تُضمَّن في فهرس السوق. هذا يسأل الفهرس أي الإشارات المخزَّنة أقرب إلى عبارة — الفحص قبل الإرسال، لترى إن كان الحاصد يملكها أصلًا.",
    "dev.text": "العبارة",
    "dev.textHint": "حتى {max} حرفًا. تُضمَّن في المتجه ولا تُخزَّن.",
    "dev.topK": "عدد الجيران",
    "dev.topKHint": "عدد صحيح من 1 إلى {max}.",
    "dev.run": "ابحث عن الجيران",
    "dev.matchesCaption": "الإشارات المخزَّنة الأقرب إلى العبارة، الأقرب أولًا.",
    "dev.col.signal": "الإشارة",
    "dev.col.source": "المصدر",
    "dev.col.observed": "لوحظت",
    "dev.col.score": "المسافة",
    "dev.noMatches": "لا شيء قريب من تلك العبارة",
    "dev.noMatchesWhy":
      "إما أن الفهرس لا يحمل ما يشبهها، أو أن الإشارات المطابِقة حُذفت منذ ذلك الحين — المطابقة بلا صف تُسقَط ولا تُقدَّم كمعرِّف مجرد.",
    "dev.raw": "الاستجابة الخام",
    "dev.ran.similar": "نُفِّذ الاستعلام على الفهرس الحي.",
    "dev.ran.diff": "قُورنت الصياغة.",
    "dev.diff": "مقارِن الصياغات",
    "dev.diffWhy":
      "المقارنة الكلمية نفسها التي تستخدمها منصة اللوحة لإظهار ما غيّرته شركة التأمين بين نسختين من صياغة. الصق نصًا عاديًا — استخراج النص من ملف PDF غير متاح هنا (ADR-0016).",
    "dev.textA": "قبل",
    "dev.textB": "بعد",
    "dev.diffRun": "قارن",
    "dev.diffCounts": "{added} كلمة مضافة · {removed} محذوفة · {kept} دون تغيير.",
    "dev.curl": "النداءان نفسهما من عميلك",
    "dev.curlWhy": "استيثاق بحامل مفتاح واجهة برمجة؛ المستأجر يأتي من المفتاح لا من جسم الطلب أبدًا.",
    "dev.ingestWhy":
      "الإرسال غير متاح في هذه الشاشة: كتابة إشارة تتطلب scout:signals:ingest، وهي صلاحية مفتاح حاصد لا شخص مسجَّل دخوله هنا. العقد هو:",
    "dev.keys": "أنشئ المفتاح في بوابة المطوِّرين — لا يُعرض هنا أبدًا.",
    "dev.noEvents": "سكاوت لا تنشر أحداثًا",
    "dev.noEventsWhy":
      "لا شيء في هذه الوحدة يبثّ على ناقل الأحداث، فلا موضوع يُشترك فيه خطاف الويب. استعلم القراءات دوريًا، أو اشترك في الوحدة التي تتصرف بناءً على فرصة مُرقّاة.",
    "dev.openRadar": "افتح الرادار",
    "dev.openPanel": "افتح منصة اللوحة",
    "problem.both_texts": "المقارنة تحتاج نسختي الصياغة كلتيهما.",
    "problem.text_required": "اكتب عبارة للبحث عنها.",
    "problem.text_too_long": "تلك العبارة أطول مما يقبله النداء.",
    "problem.bad_topk": "عدد الجيران عدد صحيح من 1 إلى 20."
  }
};

/** The catalogue, for the parity test. */
export const LABEL_KEYS = LABELS;

export function labelsIn(locale: string, pack?: string): Label {
  const table = LABELS[locale] ?? LABELS.en!;
  const fallback = LABELS.en!;
  const word = vocabulary(pack, locale);
  return (key, vars) => {
    const text = pseudoText(locale, word(key) ?? table[key] ?? fallback[key] ?? key);
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole) : text;
  };
}

/** A refusal in the reader's language when we have words for that code. */
export function explain(problem: Problemish, l: Label): Problemish {
  const key = problem.code ? `problem.${problem.code}` : "";
  return key && LABELS.en![key] ? { ...problem, title: l(key) } : problem;
}

/** Every action below answers in this shape, so one `<Gate>` covers all five. */
export interface Refusal {
  problem: Problemish;
  done: null;
}

export function refuse(code: string, status = 400): Refusal {
  return { problem: { title: code, status, code }, done: null };
}

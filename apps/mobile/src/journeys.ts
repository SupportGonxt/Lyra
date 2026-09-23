// The reasoning behind the journey screens, kept out of the screens themselves
// so it can be tested without a renderer. Everything here is pure: it takes API
// rows and answers what to show. Nothing decides what is *allowed* — the API
// owns permissions, approvals and audit (CLAUDE.md rules 3, 4).

import type { Me, Row } from "./api";
import { baseOf } from "./i18n";
import { humanize } from "./rows";

/* ------------------------------------------------------------------- brief */

export interface Highlight {
  metricKey: string;
  period: string;
  value: number;
  deltaBps: number | null;
}

/**
 * The briefing being read: the one asked for, else the newest in the reader's
 * language, else the newest at all. A port of the web's `chosen(rows, id,
 * locale)` (apps/web/app/routes/north-shared.tsx), so the two surfaces never
 * disagree about which briefing "today's" means.
 *
 * NORTH narrates per locale and the rows arrive newest-first, so `rows[0]` was
 * "newest in any language": a tenant narrating in en and ar handed an English
 * reader whichever was generated last. `locale` is the reader's, not the row's;
 * it is compared by base language because the session's locale can carry a
 * region (`en-AE`) while a briefing row records the bare language.
 */
export function chosenBriefing(
  rows: readonly Row[] | null,
  id: string | null,
  locale: string
): Row | null {
  if (!rows?.length) return null;
  if (id) return rows.find((row) => row.id === id) ?? rows[0]!;
  const reader = baseOf(locale);
  return (
    rows.find((row) => typeof row.locale === "string" && baseOf(row.locale) === reader) ??
    rows[0]!
  );
}

/**
 * `narrativeRef` as prose, or nothing. A port of the web's `narrative()`
 * (apps/web/app/routes/north-shared.tsx): rows seeded before f506bf7 hold a
 * storage key like `briefings/<tenant>/<id>.md`, and no bucket was ever bound
 * to hold that object — printing it shows a filename as a briefing.
 */
export function briefNarrative(ref: unknown): string | null {
  if (typeof ref !== "string" || !ref) return null;
  return /^[\w/-]+\.md$/.test(ref) ? null : ref;
}

/** The permission the API gates an anomaly PATCH on — the same one the web's
 *  /north/anomalies screen checks before offering its close actions. */
export const ANOMALY_ASSIGN = "north:anomalies:assign";

/** Whether to offer "Take it on". The API still decides; this only avoids
 *  offering a button whose press is certain to be refused. */
export function canTakeAnomaly(permissions: readonly string[] | null | undefined): boolean {
  return (permissions ?? []).includes(ANOMALY_ASSIGN);
}

/**
 * The name a taken anomaly is signed with (`explainedBy`), so the next reader
 * knows who took it: the reader's display name, else their email, else the
 * actor id. The web asks the reader to type it; a phone already knows it.
 */
export function anomalyOwner(
  me: Pick<Me, "actor" | "profile"> | null | undefined
): string | null {
  if (!me) return null;
  const name = me.profile?.name?.trim();
  if (name) return name;
  const email = me.profile?.email?.trim();
  if (email) return email;
  return me.actor.id || null;
}

/** `highlights_json` as rows. Unparseable JSON shows as no highlights rather
 *  than as a crashed screen — a bad column must not cost the whole briefing. */
export function highlightsOf(json: unknown): Highlight[] {
  if (typeof json !== "string" || !json.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const h = item as Partial<Highlight>;
    if (typeof h.metricKey !== "string" || typeof h.value !== "number") return [];
    return [
      {
        metricKey: h.metricKey,
        period: typeof h.period === "string" ? h.period : "",
        value: h.value,
        deltaBps: typeof h.deltaBps === "number" ? h.deltaBps : null
      }
    ];
  });
}

/**
 * The anomaly worth interrupting a read for: unowned, and the largest deviation
 * of those. Anything explained or actioned is already somebody's job.
 */
export function unownedAnomaly(rows: readonly Row[] | null): Row | null {
  const open = (rows ?? []).filter((row) => row.state === "new" && !row.explainedBy);
  if (!open.length) return null;
  return open.reduce((worst, row) => (magnitudeOf(row) > magnitudeOf(worst) ? row : worst));
}

const magnitudeOf = (row: Row): number =>
  typeof row.magnitude === "number" ? Math.abs(row.magnitude) : 0;

/** Basis points as a signed percentage: 250 → "+2.5%". */
export function bps(value: number | null): string | null {
  if (value === null) return null;
  const pct = value / 100;
  return `${value > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

/** Today in the API's date form (YYYY-MM-DD), in the device's own timezone —
 *  an executive asking for "today" means their today, not UTC's. */
export function todayIso(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/* --------------------------------------------------------------- approvals */

/**
 * What an approval is about, for someone holding a phone. `policyKey` is the
 * only field every approval carries, and it reads as a machine string
 * ("signal.budget.move"), so it becomes words. The subject reference is shown
 * separately as the thing being decided.
 */
export function approvalTitle(row: Row): string {
  const key = typeof row.policyKey === "string" ? row.policyKey : "";
  return key ? key.split(".").map(humanize).join(" · ") : humanize(String(row.id ?? ""));
}

/** The amount an approval turns on, when its context carries one — the single
 *  number a deciding user needs before they can answer. */
export function approvalAmountMinor(row: Row): number | null {
  if (typeof row.contextJson !== "string") return null;
  try {
    const context = JSON.parse(row.contextJson) as { amountMinor?: unknown };
    return typeof context.amountMinor === "number" ? context.amountMinor : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- threads */

/** A conversation's messages oldest-first — the order a thread is read in.
 *  The API sorts by id, which is not the same as by timestamp for messages
 *  written in the same millisecond by different writers. */
export function threadOrder(rows: readonly Row[]): Row[] {
  return [...rows].sort((a, b) => tsOf(a) - tsOf(b));
}

const tsOf = (row: Row): number => (typeof row.ts === "number" ? row.ts : 0);

/** True when the message came from the customer, which is the side of the
 *  thread that gets the plain (not accented) bubble. */
export function isInbound(row: Row): boolean {
  return row.role === "customer";
}

/* ------------------------------------------------------------------- queue */

/** The case states that still owe somebody work (apps/web/app/routes/
 *  axis-exceptions.tsx STUCK_CASE_STATUSES). Issued, failed and cancelled
 *  cases are nobody's queue. */
export const OPEN_CASE_STATUSES = ["intake", "quoting", "awaiting_docs", "review", "approval"] as const;

export type CaseSeverity = "breach" | "urgent" | "due" | "normal";

/**
 * How loudly one case reads, matching the web queue exactly
 * (axis-exceptions.tsx `severityOf`) so the two surfaces never rank the same
 * case differently. The deadline beats the label: a `normal` case past its SLA
 * is worse than an `urgent` one due tomorrow.
 */
export function caseSeverity(
  row: Readonly<Record<string, unknown>>,
  now: number,
  soonMs = 24 * 60 * 60 * 1000
): CaseSeverity {
  const due = typeof row.slaDueAt === "number" ? row.slaDueAt : null;
  if (due !== null && due < now) return "breach";
  if (row.priority === "urgent") return "urgent";
  if (due !== null && due - now <= soonMs) return "due";
  return "normal";
}

const SEVERITY_RANK: Record<CaseSeverity, number> = { breach: 0, urgent: 1, due: 2, normal: 3 };

/** Worst first, then earliest deadline, then oldest. Total and deterministic. */
export function byCaseSeverity(now: number) {
  return (a: Row, b: Row): number => {
    const rank = SEVERITY_RANK[caseSeverity(a, now)] - SEVERITY_RANK[caseSeverity(b, now)];
    if (rank !== 0) return rank;
    const due = numberOr(a.slaDueAt, Number.MAX_SAFE_INTEGER) - numberOr(b.slaDueAt, Number.MAX_SAFE_INTEGER);
    return due !== 0 ? due : numberOr(a.createdAt, 0) - numberOr(b.createdAt, 0);
  };
}

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === "number" ? value : fallback;

/** The queue in reading order — and, on the SLA tab, only the cases a deadline
 *  is actually pressing on. */
export function queueOrder(rows: readonly Row[] | null, now: number, slaOnly = false): Row[] {
  const kept = (rows ?? []).filter(
    (row) => !slaOnly || caseSeverity(row, now) === "breach" || caseSeverity(row, now) === "due"
  );
  return kept.sort(byCaseSeverity(now));
}

/** A deadline as one coarse unit of time, signed by which side of now it is on.
 *  Precision nobody acts on is noise, so hours and days is as fine as it goes. */
export function dueIn(slaDueAt: unknown, now: number): { overdue: boolean; hours: number } | null {
  if (typeof slaDueAt !== "number") return null;
  const delta = slaDueAt - now;
  return { overdue: delta < 0, hours: Math.max(1, Math.round(Math.abs(delta) / 3_600_000)) };
}

/* ---------------------------------------------------------------- renewals */

/** The renewal states still open to influence. Accepted and lost are history —
 *  the phone tab is for the ones a call can still change. */
export const OPEN_RENEWAL_STATES = ["scheduled", "offered"] as const;

/** Whole days from `now` until `at`, negative once it has passed
 *  (apps/web/app/routes/orbit-shared.ts `daysUntil`). */
export function daysUntil(at: unknown, now: number): number | null {
  if (typeof at !== "number" || !at) return null;
  return Math.ceil((at - now) / 86_400_000);
}

export type Urgency = "gone" | "now" | "soon" | "later";

/** How loudly a renewal reads, matching the web board (orbit-pipeline.tsx
 *  `urgency`) so a card is never hot on one surface and calm on the other. */
export function urgencyOf(days: number | null): Urgency {
  if (days === null) return "later";
  if (days < 0) return "gone";
  if (days <= 7) return "now";
  if (days <= 30) return "soon";
  return "later";
}

/** Renewals in calling order: soonest expiry first, and an expired one before a
 *  renewal with no date at all. Churn risk breaks the tie — of two policies
 *  expiring the same day, ring the one more likely to walk. */
export function renewalOrder(rows: readonly Row[] | null, now: number): Row[] {
  return [...(rows ?? [])].sort((a, b) => {
    const left = daysUntil(a.expiryAt, now);
    const right = daysUntil(b.expiryAt, now);
    if (left !== right) return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
    return numberOr(b.churnScore, -1) - numberOr(a.churnScore, -1);
  });
}

/* --------------------------------------------------------------- campaigns */

/** The campaign's `budgetJson`, as the autopilot reads it (apps/web/app/routes/
 *  signal.shared.ts `Budget`). Every field is optional: a draft campaign is
 *  allowed to have no numbers in it yet. */
export interface CampaignBudget {
  dailyMinor?: number;
  capMinor?: number;
  totalMinor?: number;
  currency?: string;
}

/** The budget whatever shape the column arrived in — crud.ts hydrate() parses
 *  `*Json` columns, except when the stored text would not parse. */
export function budgetOf(row: Readonly<Record<string, unknown>>): CampaignBudget {
  const raw = row.budgetJson;
  if (raw && typeof raw === "object") return raw as CampaignBudget;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as CampaignBudget) : {};
  } catch {
    return {};
  }
}

/** The plan the actuals are measured against, mirroring the web budget screen
 *  (signal.shared.ts `plannedMinor`) so the two surfaces never disagree about
 *  whether a campaign is overspending. */
export function plannedMinor(budget: CampaignBudget, days: number): number {
  if (typeof budget.capMinor === "number") return budget.capMinor;
  if (typeof budget.totalMinor === "number") return budget.totalMinor;
  if (typeof budget.dailyMinor === "number") return budget.dailyMinor * Math.max(days, 1);
  return 0;
}

export type Pacing = "over" | "hot" | "on" | "cold" | "unplanned";

/** Spend against plan as one word. `unplanned` is not a failure — a campaign
 *  with no ceiling has nothing to pace against, and saying "0%" would be a
 *  lie about a number nobody set. */
export function pacingOf(spentMinor: number, planned: number): { ratio: number | null; state: Pacing } {
  if (planned <= 0) return { ratio: null, state: "unplanned" };
  const ratio = spentMinor / planned;
  if (ratio > 1) return { ratio, state: "over" };
  if (ratio >= 0.9) return { ratio, state: "hot" };
  if (ratio >= 0.5) return { ratio, state: "on" };
  return { ratio, state: "cold" };
}

/** Spend rows totalled per campaign. Rows the importer could not attribute to a
 *  campaign are counted by nobody rather than by everybody. */
export function spendByCampaign(rows: readonly Row[] | null): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of rows ?? []) {
    const id = typeof row.campaignId === "string" ? row.campaignId : null;
    if (!id) continue;
    totals[id] = (totals[id] ?? 0) + (typeof row.amountMinor === "number" ? row.amountMinor : 0);
  }
  return totals;
}

/** How near the front of a marketer's morning each state belongs. Money is
 *  moving on the first three; the rest are waiting on a person. */
const STATE_RANK: Record<string, number> = {
  live: 0,
  paused: 1,
  scheduled: 2,
  review: 3,
  draft: 4,
  ended: 5
};

const stateRank = (row: Row): number =>
  STATE_RANK[typeof row.state === "string" ? row.state : ""] ?? 4;

/**
 * Campaigns in reading order: what is spending first, then whatever is nearest
 * its ceiling inside that. `budgetOnly` is the budget tab — a campaign with no
 * plan has nothing for that tab to say, and it ranks purely by exposure.
 */
export function campaignOrder(
  rows: readonly Row[] | null,
  spent: Record<string, number>,
  days: number,
  budgetOnly = false
): Row[] {
  const ratio = (row: Row): number =>
    pacingOf(spent[row.id] ?? 0, plannedMinor(budgetOf(row), days)).ratio ?? -1;
  const kept = (rows ?? []).filter(
    (row) => row.state !== "ended" && (!budgetOnly || plannedMinor(budgetOf(row), days) > 0)
  );
  return kept.sort((a, b) => {
    if (!budgetOnly) {
      const state = stateRank(a) - stateRank(b);
      if (state !== 0) return state;
    }
    const pace = ratio(b) - ratio(a);
    if (pace !== 0) return pace;
    return String(a.name ?? a.id).localeCompare(String(b.name ?? b.id));
  });
}

/** The currency a total is honest in: the one most campaigns are budgeted in.
 *  Minor units from two currencies added together are true in neither. */
export function mainCurrency(rows: readonly Row[] | null, fallback = "ZAR"): string {
  const tally = new Map<string, number>();
  for (const row of rows ?? []) {
    const code = budgetOf(row).currency;
    if (typeof code === "string" && code) tally.set(code, (tally.get(code) ?? 0) + 1);
  }
  let best = fallback;
  let seen = 0;
  for (const [code, count] of tally) {
    if (count > seen) {
      best = code;
      seen = count;
    }
  }
  return best;
}

/** Minor units as money in the reader's own digits and separators. */
export function moneyText(locale: string, currency: string, minor: number): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(minor / 100);
}

/* ------------------------------------------------------------------- scout */

/** Clusters loudest first: momentum is what the radar ranks on, and a big
 *  cluster breaks the tie because it took more evidence to build. */
export function clusterOrder(rows: readonly Row[] | null): Row[] {
  return [...(rows ?? [])].sort((a, b) => {
    const momentum = numberOr(b.momentumScore, -1) - numberOr(a.momentumScore, -1);
    if (momentum !== 0) return momentum;
    const size = numberOr(b.size, -1) - numberOr(a.size, -1);
    if (size !== 0) return size;
    return String(a.theme ?? a.id).localeCompare(String(b.theme ?? b.id));
  });
}

const clamp100 = (value: number): number => Math.max(0, Math.min(100, value));

/** A whitespace placed on the web radar's two axes (scout.shared.ts `dots`):
 *  openness of the market across, the linked cluster's momentum up. `plotted`
 *  is false for the rows that screen counts instead of drawing — no cluster
 *  means no momentum anybody measured, and inventing one would be a lie. */
export interface Opportunity {
  fit: number | null;
  momentum: number | null;
  evidence: number;
  plotted: boolean;
  /** Rank key: the two axes multiplied, so a dot needs both to lead. */
  score: number;
}

export function opportunityOf(row: Row, clustersById: ReadonlyMap<string, Row>): Opportunity {
  const cluster = typeof row.clusterId === "string" ? clustersById.get(row.clusterId) : undefined;
  const competition = typeof row.competitionScore === "number" ? row.competitionScore : null;
  const evidence = refsOf(row).length;
  if (!cluster || competition === null) {
    return { fit: competition === null ? null : clamp100(100 - competition), momentum: null, evidence, plotted: false, score: -1 };
  }
  const fit = clamp100(100 - competition);
  const momentum = clamp100(numberOr(cluster.momentumScore, 0));
  return { fit, momentum, evidence, plotted: true, score: (fit * momentum) / 100 };
}

/** The evidence references behind a whitespace (`evidenceRefsJson.refs`). */
function refsOf(row: Row): string[] {
  const raw = row.evidenceRefsJson;
  const blob: unknown = typeof raw === "string" ? tryParse(raw) : raw;
  if (!blob || typeof blob !== "object") return [];
  const refs = (blob as { refs?: unknown }).refs;
  return Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function byId(rows: readonly Row[] | null): Map<string, Row> {
  return new Map((rows ?? []).map((row) => [row.id, row]));
}

/** Whitespaces best-bet first. The ones the radar cannot plot sink to the
 *  bottom rather than vanish — someone still has to link them to a cluster. */
export function whitespaceOrder(rows: readonly Row[] | null, clusters: readonly Row[] | null): Row[] {
  const index = byId(clusters);
  return [...(rows ?? [])].sort(
    (a, b) => opportunityOf(b, index).score - opportunityOf(a, index).score
  );
}

/** `YYYY-MM` sorts lexically, which is the whole reason the column is text. */
export function latestPeriod(rows: readonly Row[] | null): string | null {
  return (rows ?? []).reduce<string | null>((best, row) => {
    const period = typeof row.period === "string" ? row.period : null;
    return period !== null && (best === null || period > best) ? period : best;
  }, null);
}

export interface PanelRoll {
  providerId: string;
  volume: number;
  /** 0–1 of the period's total volume. */
  share: number;
  winRate: number | null;
  ourIdx: number | null;
  marketIdx: number | null;
  lines: string[];
}

/** One period's bench rows rolled up per provider, biggest book first —
 *  mirroring scout.shared.ts `rollByProvider`. Every average is weighted by
 *  volume, and a column nobody priced stays null rather than becoming a zero. */
export function rollByProvider(rows: readonly Row[] | null, period: string | null): PanelRoll[] {
  const scoped = (rows ?? []).filter((row) => period !== null && row.period === period);
  const total = scoped.reduce((sum, row) => sum + numberOr(row.volume, 0), 0);
  const groups = new Map<string, Row[]>();
  for (const row of scoped) {
    const provider = typeof row.providerId === "string" ? row.providerId : "";
    groups.set(provider, [...(groups.get(provider) ?? []), row]);
  }
  return [...groups.entries()]
    .map(([providerId, own]) => {
      const volume = own.reduce((sum, row) => sum + numberOr(row.volume, 0), 0);
      return {
        providerId,
        volume,
        share: total > 0 ? volume / total : 0,
        winRate: weighted(own, "winRate"),
        ourIdx: weighted(own, "ourPriceIdx"),
        marketIdx: weighted(own, "marketPriceIdx"),
        lines: [...new Set(own.map((row) => String(row.line ?? "")).filter(Boolean))].sort()
      };
    })
    .sort((a, b) => b.volume - a.volume);
}

function weighted(rows: readonly Row[], key: string): number | null {
  let sum = 0;
  let mass = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number") continue;
    sum += value * numberOr(row.volume, 0);
    mass += numberOr(row.volume, 0);
  }
  return mass > 0 ? Math.round(sum / mass) : null;
}

/** Percent above (positive) or below (negative) the panel median. */
export function deltaPct(ourIdx: number | null, marketIdx: number | null): number | null {
  if (ourIdx === null || marketIdx === null || marketIdx === 0) return null;
  return ((ourIdx - marketIdx) / marketIdx) * 100;
}

/** Two points of index is inside the noise of a median over four quotes. */
export const AT_MARKET_PCT = 2;

export type PricePosition = "unpriced" | "cheaper" | "dearer" | "atMarket";

/** Where our cut sits against the panel, as one word (scout.shared.ts
 *  `positionOf`) — so a provider is never dear on the desk and fine on a phone. */
export function positionOf(pct: number | null): PricePosition {
  if (pct === null) return "unpriced";
  if (pct <= -AT_MARKET_PCT) return "cheaper";
  if (pct >= AT_MARKET_PCT) return "dearer";
  return "atMarket";
}

/** Basis points as the index the analysts quote: 9420 → "0.94". */
export function indexText(bp: number | null, locale = "en"): string | null {
  return bp === null
    ? null
    : (bp / 10_000).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ------------------------------------------------------------- attribution */

/** The channels SIGNAL names, mirrored from apps/web/app/routes/signal.shared.ts
 *  `SIGNAL_CHANNELS`. Slugs are not i18n keys — the API invents new ones as
 *  networks are added — so an unknown slug is titled rather than dropped. */
const CHANNEL_NAMES: Record<string, { en: string; ar: string }> = {
  google_search: { en: "Google Search", ar: "بحث Google" },
  bing_search: { en: "Bing Search", ar: "بحث Bing" },
  meta: { en: "Facebook", ar: "فيسبوك" },
  instagram: { en: "Instagram", ar: "إنستغرام" },
  youtube: { en: "YouTube", ar: "يوتيوب" },
  email: { en: "Email", ar: "البريد الإلكتروني" },
  whatsapp: { en: "WhatsApp", ar: "واتساب" },
  sms: { en: "SMS", ar: "رسالة نصية" },
  push: { en: "Push", ar: "إشعار" }
};

export function channelLabel(slug: string, locale = "en"): string {
  const known = CHANNEL_NAMES[slug];
  if (known) return locale.startsWith("ar") ? known.ar : known.en;
  return humanize(slug);
}

/** An attribution touch that says a customer was actually won. */
const BIND = "bind";

export interface ChannelRoll {
  channel: string;
  spendMinor: number;
  clicks: number;
  binds: number;
  valueMinor: number;
}

/** Money spent per channel against customers won there (signal.shared.ts
 *  `rollByChannel`). Biggest spend first: the question this tab answers is
 *  "where is the money going", and the answer starts at the top. */
export function rollByChannel(spend: readonly Row[] | null, touches: readonly Row[] | null): ChannelRoll[] {
  const rolls = new Map<string, ChannelRoll>();
  const at = (channel: string): ChannelRoll => {
    let roll = rolls.get(channel);
    if (!roll) {
      roll = { channel, spendMinor: 0, clicks: 0, binds: 0, valueMinor: 0 };
      rolls.set(channel, roll);
    }
    return roll;
  };
  for (const row of spend ?? []) {
    const roll = at(String(row.channel ?? ""));
    roll.spendMinor += numberOr(row.amountMinor, 0);
    roll.clicks += numberOr(row.clicks, 0);
  }
  for (const touch of touches ?? []) {
    if (touch.touchType !== BIND) continue;
    const roll = at(String(touch.channel ?? ""));
    roll.binds += 1;
    roll.valueMinor += numberOr(touch.valueMinor, 0);
  }
  return [...rolls.values()].sort((a, b) => b.spendMinor - a.spendMinor);
}

/** What one customer cost. Null when nothing was won — spend with no binds is
 *  not an infinite cost, it is a number nobody can compute yet. */
export function cacMinor(spendMinor: number, binds: number): number | null {
  return binds > 0 ? Math.round(spendMinor / binds) : null;
}

/** Mean contract value of a won customer (signal.shared.ts `ltvMinor`). */
export function ltvMinor(touches: readonly Row[] | null): number | null {
  const binds = (touches ?? []).filter((touch) => touch.touchType === BIND);
  if (binds.length === 0) return null;
  return Math.round(binds.reduce((sum, touch) => sum + numberOr(touch.valueMinor, 0), 0) / binds.length);
}

/** LTV:CAC as a plain multiple. Below 1 the channel loses money per customer. */
export function ltvToCac(ltv: number | null, cac: number | null): number | null {
  if (ltv === null || cac === null || cac === 0) return null;
  return ltv / cac;
}

/** A ratio as "2.4×" in the reader's digits — `toFixed` always writes Latin. */
export function multipleText(locale: string, value: number): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}×`;
}

/* ------------------------------------------------------------------- north */

const DECISION_RANK: Record<string, number> = { open: 0, reviewed: 1, reversed: 2 };

/** Decisions in the order a governance conversation walks them: the ones still
 *  open first, soonest review date at the top and an overdue review above a
 *  future one. A decision nobody set a date on sits under the dated ones — it
 *  is open, but nothing says it is due. Closed decisions keep the same order
 *  underneath so the tab still reads as a record.
 *
 *  There is no web route for decisions (only north-brief.tsx), so this rule is
 *  authored here rather than mirrored. */
export function decisionOrder(rows: readonly Row[] | null, now: number): Row[] {
  return [...(rows ?? [])].sort((a, b) => {
    const state = (DECISION_RANK[String(a.status ?? "")] ?? 3) - (DECISION_RANK[String(b.status ?? "")] ?? 3);
    if (state !== 0) return state;
    const left = daysUntil(a.reviewAt, now);
    const right = daysUntil(b.reviewAt, now);
    if (left !== right) return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
    return String(a.title ?? a.id).localeCompare(String(b.title ?? b.id));
  });
}

/** How many options were on the table, from `optionsJson`. Zero means the row
 *  recorded a call without recording the alternatives — worth showing as
 *  nothing rather than as "0 options", which the screen decides. */
export function optionCount(row: Row): number {
  const parsed = typeof row.optionsJson === "string" ? tryParse(row.optionsJson) : null;
  if (Array.isArray(parsed)) return parsed.length;
  const options = parsed && typeof parsed === "object" ? (parsed as { options?: unknown }).options : null;
  return Array.isArray(options) ? options.length : 0;
}

const PACK_RANK: Record<string, number> = { distributed: 0, final: 1, review: 2, draft: 3 };

/** Board packs newest period first — a pack is named by the period it covers,
 *  and "2026-Q2" sorts correctly as text. Two packs for one period are ranked
 *  by how finished they are, so the distributed one is the one you reach for. */
export function boardpackOrder(rows: readonly Row[] | null): Row[] {
  return [...(rows ?? [])].sort((a, b) => {
    const period = String(b.period ?? "").localeCompare(String(a.period ?? ""));
    if (period !== 0) return period;
    return (PACK_RANK[String(a.status ?? "")] ?? 4) - (PACK_RANK[String(b.status ?? "")] ?? 4);
  });
}

/** How many sections a pack carries, from `sectionsJson` — the one number that
 *  says whether a generated pack actually has anything in it. */
export function sectionCount(row: Row): number {
  const parsed = typeof row.sectionsJson === "string" ? tryParse(row.sectionsJson) : null;
  if (Array.isArray(parsed)) return parsed.length;
  const sections = parsed && typeof parsed === "object" ? (parsed as { sections?: unknown }).sections : null;
  return Array.isArray(sections) ? sections.length : 0;
}

/* ------------------------------------------------------------------- audit */

/** Whole hours since an audit row was written (`core_audit_log.ts`, epoch ms),
 *  or `null` when the row carries no usable timestamp. A row written in the
 *  future — clock skew between a worker and a phone — reads as 0 rather than
 *  as a negative age nobody can act on. */
export function hoursSince(ts: unknown, now: number): number | null {
  const at = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(at) || at <= 0) return null;
  return Math.max(0, Math.floor((now - at) / 3_600_000));
}

/* ------------------------------------------------------------------- money */

/** Where a transaction stands, for the controller whose morning it is. The
 *  ledger has thirteen states (packages/db/src/schema/ledger.ts); a phone tab
 *  needs to know only whether someone has to do something about this one. */
export type TxnStanding = "broken" | "stalled" | "waiting" | "moving" | "done";

/** A transaction the ledger gave up on is broken; one waiting on a bank is
 *  normal until the deadline the ledger itself stamped passes, after which
 *  nobody is coming and a person has to chase it. Settled and reversed money
 *  has arrived somewhere and is nobody's morning. */
export function txnStanding(row: Row, now: number): TxnStanding {
  const state = String(row.state ?? "");
  if (state === "failed" || state === "rejected") return "broken";
  if (state === "pending_external") {
    const deadline = row.externalTimeoutAt;
    return typeof deadline === "number" && deadline > 0 && deadline <= now ? "stalled" : "waiting";
  }
  if (state === "settled" || state === "reversed" || state === "adjusted" || state === "expired") return "done";
  return "moving";
}

const TXN_RANK: Record<TxnStanding, number> = { broken: 0, stalled: 1, waiting: 2, moving: 2, done: 3 };

/** Money worst first, and settled money not at all — the tab exists to name
 *  what still owes someone a decision. Within a standing the oldest goes
 *  first: an in-flight transaction only gets more worrying the longer it
 *  stays in flight. */
export function txnOrder(rows: readonly Row[] | null, now: number): Row[] {
  return [...(rows ?? [])]
    .filter((row) => txnStanding(row, now) !== "done")
    .sort((a, b) => {
      const rank = TXN_RANK[txnStanding(a, now)] - TXN_RANK[txnStanding(b, now)];
      if (rank !== 0) return rank;
      return numberOr(a.createdAt, Number.MAX_SAFE_INTEGER) - numberOr(b.createdAt, Number.MAX_SAFE_INTEGER);
    });
}

/* ---------------------------------------------------------------- requests */

/** Where a data-subject request stands. Unlike everything else on the phone,
 *  a DSAR's clock is statutory (docs/12): `dueAt` is a legal deadline, not a
 *  service target, so the date outranks the workflow state. */
export type DsarStanding = "late" | "due" | "open" | "closed";

/** The DSAR states still owing the subject an answer
 *  (packages/db/src/schema/compliance.ts). */
export const OPEN_DSAR_STATES = ["received", "verifying", "in_progress", "awaiting_legal"] as const;

/** Fulfilled, refused and expired requests are records. An open one reads off
 *  the same day-count scale renewals use (`urgencyOf`), so "3 days left" means
 *  the same thing everywhere in the app rather than growing a second scale. */
export function dsarStanding(row: Row, now: number): DsarStanding {
  if (!OPEN_DSAR_STATES.includes(String(row.state ?? "") as (typeof OPEN_DSAR_STATES)[number])) return "closed";
  const urgency = urgencyOf(daysUntil(row.dueAt, now));
  if (urgency === "gone") return "late";
  if (urgency === "now") return "due";
  return "open";
}

/** DSARs by the deadline the law set — soonest first, overdue at the top,
 *  closed ones last so the queue reads as work rather than as history. */
export function dsarOrder(rows: readonly Row[] | null, now: number): Row[] {
  return [...(rows ?? [])].sort((a, b) => {
    const closed = Number(dsarStanding(a, now) === "closed") - Number(dsarStanding(b, now) === "closed");
    if (closed !== 0) return closed;
    const left = daysUntil(a.dueAt, now);
    const right = daysUntil(b.dueAt, now);
    return (left ?? Number.MAX_SAFE_INTEGER) - (right ?? Number.MAX_SAFE_INTEGER);
  });
}

/* ----------------------------------------------------------------- capture */

/** The document types AXIS accepts (apps/api/src/routes/axis.ts DOC_TYPES).
 *  Sending anything else is a 400, so the screen offers exactly these. */
export const DOC_TYPES = ["eid", "mulkiya", "census", "medical", "tradelicense", "other"] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** A captured file's content type from its uri, since the picker does not
 *  always report one. Unknown extensions fall back to JPEG — what every phone
 *  camera on both platforms actually produces. */
export function contentTypeOf(uri: string): string {
  const ext = uri.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "heic" || ext === "heif") return "image/heic";
  if (ext === "webp") return "image/webp";
  if (ext === "pdf") return "application/pdf";
  return "image/jpeg";
}

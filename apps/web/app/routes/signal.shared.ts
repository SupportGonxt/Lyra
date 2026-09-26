import { formatInstant, instantOf } from "@lyra/ui";
import { vocabulary } from "../modules/vocabulary";
import { pseudoText } from "../i18n";

// The bespoke SIGNAL screens share one labeller and one set of
// derivations, for the same reason ledger.shared.ts exists: the cockpit, the
// studio, the budget bounds, the growth numbers, the audience value view, the
// experiments and the answer-engine coverage all read the same four ledgers
// (spend, attribution, campaigns, budget moves) and would otherwise each grow
// their own copy of CAC.
//
// Labels are local rather than app/i18n: those catalogues are shared across
// agents and these words belong to these screens. Keys are namespaced by screen
// (`cockpit.*`, `studio.*`, `budget.*`, `growth.*`, `aud.*`, `aeo.*`, `exp.*`);
// the unnamespaced ones are shared by all seven.
//
// The API has no CAC/LTV endpoint — the autopilot computes both internally
// (apps/api/src/engines/signal-autopilot.ts) and exposes neither — so the
// helpers below derive them from the spend ledger and the attribution touches.

/* ------------------------------------------------------------- permissions */

/** The exact strings the SIGNAL handlers call require_() with. */
export const PERM = {
  campaignsRead: "signal:campaigns:read",
  campaignsCreate: "signal:campaigns:create",
  campaignsUpdate: "signal:campaigns:update",
  creativesRead: "signal:creatives:read",
  creativesGenerate: "signal:creatives:generate",
  creativesApprove: "signal:creatives:approve",
  audiencesRead: "signal:audiences:read",
  audiencesEstimate: "signal:audiences:estimate",
  experimentsRead: "signal:experiments:read",
  experimentsCreate: "signal:experiments:create",
  experimentsDecide: "signal:experiments:decide",
  movesRead: "signal:budget_moves:read",
  movesApprove: "signal:budget_moves:approve",
  aeoRead: "signal:aeo:read",
  aeoWrite: "signal:aeo:write",
  attributionRead: "signal:attribution:read",
  spendRead: "signal:spend:read",
  outreachRead: "signal:outreach:read",
  outreachSend: "signal:outreach:send",
  autopilotPause: "signal:autopilot:pause",
  autopilotRun: "signal:autopilot:run",
  exportCreate: "analytics:exports:create"
} as const;

/* ------------------------------------------------------------------- shapes */

/**
 * GET /v1/signal/responses/rollup — mirrors `responseRollup` in
 * apps/api/src/engines/signal-responses.ts: counts per response kind, grouped
 * by campaign, audience or person (ADR-0091).
 */
export type ResponseRollup = Array<{ key: string; counts: Partial<Record<string, number>> }>;

export interface ScaleRow {
  key: string;
  name: string | null;
  sent: number;
  read: number;
  replied: number;
  /** Replies per send, whole percent; null when nothing was sent to divide by. */
  replyPct: number | null;
  binds: number;
  optedOut: number;
}

/** One scale's rollup as rows to compare: named, rated, biggest first. */
export function scaleRows(rollup: ResponseRollup, names: Record<string, string>, top = Infinity): ScaleRow[] {
  return rollup
    .map(({ key, counts }) => {
      const n = (k: string) => counts[k] ?? 0;
      const sent = n("lead");
      return {
        key,
        name: names[key] ?? null,
        sent,
        read: n("read"),
        replied: n("replied"),
        replyPct: sent ? Math.round((n("replied") / sent) * 100) : null,
        binds: n("bind"),
        optedOut: n("opted_out")
      };
    })
    .sort((a, b) => b.sent - a.sent || b.replied - a.replied)
    .slice(0, top);
}

/** apps/api/src/crud.ts list envelope. */
export interface Page<T> {
  data: T[];
  cursor?: string;
  total?: number;
}

export interface SpendRow {
  id: string;
  campaignId: string | null;
  channel: string;
  /** `YYYY-MM-DD` — the identity of the row, not a timestamp. */
  day: string;
  amountMinor: number;
  currency: string;
  impressions: number;
  clicks: number;
  conversions: number;
  source: string;
  ts: number;
}

export interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  audienceId: string | null;
  /** crud.ts hydrate() returns `*Json` columns parsed, so these arrive as
   *  objects — except when the stored text was unparseable, hence `unknown`. */
  channelsJson: unknown;
  budgetJson: unknown;
  /** The three ranked options the campaign was planned against. Absent on every
   *  campaign started by hand — only a promoted whitespace plans first. */
  planJson?: unknown;
  /** Absent until the compliance pass has run over the campaign at least once. */
  guardrailChecksJson?: unknown;
  state: string;
  autonomyLevel: string;
  startAt: number | null;
  endAt: number | null;
  ownerRef: string | null;
}

export interface CreativeRow {
  id: string;
  campaignId: string | null;
  kind: string;
  locale: string;
  contentRef: string;
  variantGroup: string | null;
  complianceStatus: string;
  complianceNotesJson: unknown;
  performanceJson: unknown;
  generatedBy: string;
  aiAuditId: string | null;
  /** DesignJson (packages/db/src/json.ts), hydrated by crud.ts; null = the default layout. */
  designJson?: unknown;
  createdAt: number;
}

export interface MoveRow {
  id: string;
  fromRef: string;
  toRef: string;
  amountMinor: number;
  currency: string;
  reason: string;
  evidenceJson: unknown;
  approvedBy: string | null;
  reversedBy: string | null;
  reversedAt: number | null;
  reversibleUntil: number | null;
  ts: number;
}

export interface TouchRow {
  id: string;
  customerId: string | null;
  anonId: string | null;
  touchType: string;
  channel: string;
  campaignId: string | null;
  creativeId: string | null;
  valueMinor: number | null;
  currency: string | null;
  subjectRef: string | null;
  ts: number;
}

/** Mirrors packages/db/src/schema/signal.ts `signal_outreach` — the acquisition
 *  outreach ledger the cockpit's loop panel reads. */
export interface OutreachRow {
  id: string;
  campaignId: string;
  customerId: string;
  channel: string;
  locale: string;
  text: string;
  state: string; // pending_approval|sent|failed|converted
  approvedBy: string;
  externalRef: string | null;
  convertedRef: string | null;
  aiAuditId: string | null;
  ts: number;
  updatedAt: number | null;
}

export interface AudienceRow {
  id: string;
  name: string;
  definitionJson: unknown;
  sizeCached: number | null;
  refreshPolicy: string;
  consentPurposes: string | null;
  lastRefreshedAt: number | null;
}

export interface AeoRow {
  id: string;
  queryCluster: string;
  locale: string;
  contentRef: string;
  citationsCheckJson: unknown;
  freshness: number | null;
  citedByJson: unknown;
  status: string;
  updatedAt: number;
}

export interface ExperimentRow {
  id: string;
  campaignId: string | null;
  hypothesis: string;
  variantsJson: unknown;
  metric: string;
  minSample: number | null;
  /** draft | running | concluded | abandoned (packages/db/src/schema/signal.ts). */
  state: string;
  resultJson: unknown;
  concludedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** One arm of a test. `splitBps` is its share of traffic, 10 000 = all of it. */
export interface Variant {
  key: string;
  label?: string;
  creativeId?: string;
  splitBps?: number;
}

/**
 * What was written when the test stopped. Two shapes live in this column: a
 * measured stop carries samples and rates, an abandoned one carries the reason
 * it never got there. Every field is optional because both are the same column.
 */
export interface ExperimentResult {
  verdict?: string;
  winner?: string | null;
  samples?: Record<string, number>;
  rateBps?: Record<string, number>;
  upliftBps?: number;
  probabilityToBeatControlBps?: number;
  stoppedBy?: string;
  note?: string;
  /** Abandoned tests only. */
  reason?: string;
  reachableShareBps?: number;
  abandonedBy?: string;
}

/** The campaign's `budgetJson`, as the autopilot reads it. */
export interface Budget {
  dailyMinor?: number;
  capMinor?: number;
  totalMinor?: number;
  currency?: string;
  /** The most the autopilot may move in one decision without asking. */
  autopilotBoundMinor?: number;
}

/** What a screen renders when the outcome was a refusal it can explain. */
export interface Problemish {
  title: string;
  status: number;
  code?: string;
  detail?: string;
  policy_key?: string;
}

/* ------------------------------------------------------------------ plumbing */

/**
 * A read whose permission the actor may not hold. One withheld tab must not
 * blank a cockpit that has five others to show, so a 403/404 reads as absence.
 */
export async function safe<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

/** Per-load key so a double submit is one write (docs/19 §idempotency). */
export function mintKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

/**
 * A `*Json` column as the API hands it over: already parsed by crud.ts
 * hydrate(), or still a string when the stored text would not parse. Both are
 * read here so one bad row cannot throw a whole screen.
 */
export function asJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || parsed === undefined ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** The campaign's budget, whatever shape the column came back in. */
export function budgetOf(campaign: CampaignRow): Budget {
  return asJson<Budget>(campaign.budgetJson, {});
}

/**
 * The places a campaign can run. Slugs are what the API and the seed store
 * (`google_search`, `meta`); the label is what a person reads. Unknown slugs
 * are still rendered — an importer may know a channel this list does not —
 * so this is a display catalogue, not a validation whitelist.
 *
 * ponytail: two locales inline. Move to the domain pack when a tenant sells
 * through a channel that needs its own naming.
 */
export const SIGNAL_CHANNELS: ReadonlyArray<{ slug: string; en: string; ar: string }> = [
  { slug: "google_search", en: "Google Search", ar: "بحث Google" },
  { slug: "bing_search", en: "Bing Search", ar: "بحث Bing" },
  { slug: "meta", en: "Facebook", ar: "فيسبوك" },
  { slug: "instagram", en: "Instagram", ar: "إنستغرام" },
  { slug: "tiktok", en: "TikTok", ar: "تيك توك" },
  { slug: "snapchat", en: "Snapchat", ar: "سناب شات" },
  { slug: "youtube", en: "YouTube", ar: "يوتيوب" },
  { slug: "email", en: "Email", ar: "البريد الإلكتروني" },
  { slug: "whatsapp", en: "WhatsApp", ar: "واتساب" },
  { slug: "sms", en: "SMS", ar: "رسالة نصية" },
  { slug: "push", en: "Push", ar: "إشعار" }
];

/** `quote_start_rate` → "Quote Start Rate". A slug nobody named is still words. */
export function humanise(slug: string): string {
  return slug.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A channel slug as a person reads it — `google_search` → "Google Search". */
export function channelLabel(slug: string, locale = "en"): string {
  const known = SIGNAL_CHANNELS.find((channel) => channel.slug === slug);
  if (known) return locale.startsWith("ar") ? known.ar : known.en;
  return humanise(slug);
}

/**
 * Where a budget move came from or went to. The autopilot stores an endpoint as
 * `signal_campaign:cmp_01KE…#google_search` — the campaign, then the channel
 * inside it — and the moves table printed exactly that on both sides of the
 * arrow, twice per row. `names` is campaign id → campaign name; a campaign the
 * caller did not load falls back to the channel alone, which is still a place a
 * person recognises.
 */
export function moveEndpoint(ref: string, names: Record<string, string>, locale = "en"): string {
  const [target = "", channel] = ref.split("#");
  const id = target.includes(":") ? target.slice(target.indexOf(":") + 1) : target;
  const campaign = names[id];
  const place = channel ? channelLabel(channel, locale) : "";
  if (campaign && place) return `${campaign} · ${place}`;
  return campaign || place || ref;
}

export function channelsOf(campaign: CampaignRow): string[] {
  const raw = asJson<unknown>(campaign.channelsJson, []);
  if (Array.isArray(raw)) return raw.map((entry) => String(entry)).filter(Boolean);
  // Written by some importers as `{ channels: [...] }`.
  const nested = (raw as { channels?: unknown }).channels;
  return Array.isArray(nested) ? nested.map((entry) => String(entry)).filter(Boolean) : [];
}

/* ------------------------------------------------------------- derivations */

export interface ChannelRoll {
  channel: string;
  spendMinor: number;
  impressions: number;
  clicks: number;
  conversions: number;
  /** Attribution touches of type `bind` — the acquisition the spend bought. */
  binds: number;
  valueMinor: number;
}

const BIND = "bind";

export function totalSpendMinor(rows: readonly SpendRow[], currency?: string): number {
  return rows
    .filter((row) => !currency || row.currency === currency)
    .reduce((sum, row) => sum + (row.amountMinor || 0), 0);
}

/**
 * The currency a screen totals in: the one most of its campaigns are budgeted
 * in. Minor units from two currencies added together make a number that is true
 * in neither — the budget screen headed a ZAR 60,000 ceiling over a table of
 * AED campaigns — so every total here is scoped to this one and each row keeps
 * its own.
 */
export function mainCurrency(campaigns: readonly CampaignRow[], fallback = "ZAR"): string {
  const tally = new Map<string, number>();
  for (const campaign of campaigns) {
    const code = budgetOf(campaign).currency;
    if (code) tally.set(code, (tally.get(code) ?? 0) + 1);
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

/** Spend and outcome side by side per channel. The join is the channel string:
 *  both ledgers are written by the same importers against the same names. */
export function rollByChannel(
  spend: readonly SpendRow[],
  touches: readonly TouchRow[]
): ChannelRoll[] {
  const rolls = new Map<string, ChannelRoll>();
  const at = (channel: string): ChannelRoll => {
    let roll = rolls.get(channel);
    if (!roll) {
      roll = { channel, spendMinor: 0, impressions: 0, clicks: 0, conversions: 0, binds: 0, valueMinor: 0 };
      rolls.set(channel, roll);
    }
    return roll;
  };
  for (const row of spend) {
    const roll = at(row.channel);
    roll.spendMinor += row.amountMinor || 0;
    roll.impressions += row.impressions || 0;
    roll.clicks += row.clicks || 0;
    roll.conversions += row.conversions || 0;
  }
  for (const touch of touches) {
    if (touch.touchType !== BIND) continue;
    const roll = at(touch.channel);
    roll.binds += 1;
    roll.valueMinor += touch.valueMinor || 0;
  }
  return [...rolls.values()].sort((a, b) => b.spendMinor - a.spendMinor);
}

/** Spend per acquisition. `null` when nothing converted: a CAC of infinity is
 *  a number the screen would render as money, and zero is a lie. */
export function cacMinor(spendMinor: number, binds: number): number | null {
  return binds > 0 ? Math.round(spendMinor / binds) : null;
}

/** Mean value of a bind. The ledger's `valueMinor` is the contract value, which
 *  is the only lifetime signal SIGNAL has without reaching into AXIS. */
export function ltvMinor(touches: readonly TouchRow[]): number | null {
  const binds = touches.filter((touch) => touch.touchType === BIND);
  if (binds.length === 0) return null;
  return Math.round(binds.reduce((sum, touch) => sum + (touch.valueMinor || 0), 0) / binds.length);
}

/** LTV:CAC as a plain multiple. Below 1 the channel loses money per customer. */
export function ltvToCac(ltv: number | null, cac: number | null): number | null {
  if (ltv === null || cac === null || cac === 0) return null;
  return ltv / cac;
}

/** A ratio as "2.4×" in the reader's digits — `toFixed` always writes Latin ones. */
export function multipleText(locale: string, value: number): string {
  const nf = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${nf.format(value)}×`;
}

/** The plan the actuals are measured against, over `days` of the window. */
export function plannedMinor(budget: Budget, days: number): number {
  if (typeof budget.capMinor === "number") return budget.capMinor;
  if (typeof budget.totalMinor === "number") return budget.totalMinor;
  if (typeof budget.dailyMinor === "number") return budget.dailyMinor * Math.max(days, 1);
  return 0;
}

/** Ascending daily totals — the shape <Sparkline> wants. */
export function dailySpend(rows: readonly SpendRow[]): Array<{ day: string; amountMinor: number }> {
  const days = new Map<string, number>();
  for (const row of rows) days.set(row.day, (days.get(row.day) ?? 0) + (row.amountMinor || 0));
  return [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, amountMinor]) => ({ day, amountMinor }));
}

/**
 * The cockpit's headline: an autopilot move outranks a plan overrun, which
 * outranks activity, which outranks quiet — "what changed while you were
 * away" is what an operator wants first. Arithmetic over counts the loader
 * already computed, so the caller adds no ✦ (docs/15 §11: the mark is for
 * text an agent produced, and a move's own `reason` is a template the
 * autopilot engine fills in — apps/api/src/engines/signal-autopilot.ts —
 * not a model-gateway call).
 */
export function cockpitHeadline(
  l: Label,
  input: { movesCount: number; planPct: number; runningCount: number }
): string {
  if (input.movesCount > 0) return l("cockpit.answer.moved", { n: String(input.movesCount) });
  if (input.planPct > 100) return l("cockpit.answer.overPlan", { n: String(input.planPct) });
  if (input.runningCount > 0) return l("cockpit.answer.running", { n: String(input.runningCount) });
  return l("cockpit.answer.quiet");
}

/**
 * The studio's headline: which of the five steps this campaign is on, named
 * after it — "The words" reads as an answer where the static title did not.
 * No campaign yet keeps the plain title; there is nothing to report.
 */
export function studioHeadline(l: Label, campaign: CampaignRow | null, step: number): string {
  if (!campaign) return l("studio.title");
  return `${campaign.name} · ${l(`studio.step${step}`)}`;
}

/**
 * The audience-value headline: an audience losing money outranks a leader to
 * report — that's the one that needs a decision — which outranks nothing
 * measured yet.
 */
export function audValueHeadline(l: Label, locale: string, input: { best: AudienceValue | null; losing: number }): string {
  if (input.losing > 0) return l("aud.answer.losing", { n: String(input.losing) });
  if (input.best && input.best.multiple !== null) {
    return l("aud.answer.best", {
      name: input.best.audience.name,
      multiple: multipleText(locale, input.best.multiple)
    });
  }
  return l("aud.answer.none");
}

/** The answer-engines headline: a page going stale outranks the citation share. */
export function aeoHeadline(l: Label, input: { staleCount: number; published: number; citationSharePct: number }): string {
  if (input.staleCount > 0) return l("aeo.staleWarning", { n: String(input.staleCount) });
  if (input.published > 0) return l("aeo.answer.share", { pct: String(input.citationSharePct) });
  return l("aeo.answer.none");
}

/** The experiments headline: a decided winner outranks one still running. */
export function expHeadline(l: Label, input: { won: number; running: number }): string {
  if (input.won > 0) return l("exp.answer.won", { n: String(input.won) });
  if (input.running > 0) return l("exp.answer.running", { n: String(input.running) });
  return l("exp.none");
}

/** The budget headline: headroom or overspend, in the campaigns' own currency. */
export function budgetHeadline(l: Label, locale: string, input: { headroomMinor: number; currency: string }): string {
  const amount = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: input.currency,
    maximumFractionDigits: 0
  }).format(Math.abs(input.headroomMinor) / 100);
  return input.headroomMinor < 0 ? l("budget.answer.over", { amount }) : l("budget.answer.under", { amount });
}

/** The analytics headline: LTV:CAC as the one number that says whether growth pays. */
export function growthHeadline(l: Label, locale: string, ratio: number | null): string {
  return ratio === null ? l("growth.answer.none") : l("growth.answer.ratio", { multiple: multipleText(locale, ratio) });
}

/** The admin headline: `adminFaults().length` — nothing stranded reuses that empty state's own title. */
export function adminHeadline(l: Label, faultCount: number): string {
  return faultCount === 0 ? l("admin.readyTitle") : l("admin.answer.faults", { n: String(faultCount) });
}

/** The dev headline: what this role can read, and how many endpoints are listening for it. */
export function devHeadline(l: Label, input: { readable: number; hooks: number }): string {
  return input.readable === 0
    ? l("dev.denied")
    : l("dev.answer.ready", { n: String(input.readable), hooks: String(input.hooks) });
}

/** The windows every SIGNAL screen offers. 7 is a week's noise, 90 is a quarter. */
export const WINDOWS = [7, 30, 90] as const;

/** `?days=` as one of the offered windows. Anything else is a month. */
export function windowDays(raw: string | null): number {
  const days = Number(raw);
  return WINDOWS.some((allowed) => allowed === days) ? days : 30;
}

/**
 * The `YYYY-MM` a touch landed in. `toISOString` throws `RangeError` on a
 * stored instant no `Date` can hold, and that throw happens inside `cohorts()`
 * during the growth screen's render — so one bad touch row took the page.
 * Degrades to the same dash the rest of the app shows: a visible junk cohort,
 * sorting last, rather than no screen at all.
 */
export function monthOf(ts: number): string {
  return formatInstant(ts, (at) => at.toISOString().slice(0, 7));
}

export interface Cohort {
  /** `YYYY-MM` of the customer's first bind. */
  month: string;
  size: number;
  /** How many of them came back in a later month. */
  retained: number;
}

/**
 * Retention from the touch ledger alone: a cohort is the month a customer first
 * bound, and it is retained if that customer has any touch in a later month.
 * ponytail: a coarse definition (any touch, not a second bind) because binds are
 * rare enough in a young tenant that the strict version is all zeros. Tighten it
 * when AXIS exposes contract renewals per customer.
 */
export function cohorts(touches: readonly TouchRow[]): Cohort[] {
  // `monthOf`'s dash is for display. It sorts above every `YYYY-MM`, so
  // comparing it here marked a customer retained off a touch nobody could date
  // — a wrong number that looks right, which is worse than the crash the dash
  // replaced. An undateable touch is not evidence, so it is not counted.
  const dateable = touches.filter((touch) => instantOf(touch.ts) !== null);
  const first = new Map<string, string>();
  for (const touch of dateable) {
    if (!touch.customerId || touch.touchType !== BIND) continue;
    const month = monthOf(touch.ts);
    const known = first.get(touch.customerId);
    if (!known || month < known) first.set(touch.customerId, month);
  }
  const later = new Set<string>();
  for (const touch of dateable) {
    if (!touch.customerId) continue;
    const start = first.get(touch.customerId);
    if (start && monthOf(touch.ts) > start) later.add(touch.customerId);
  }
  const rolls = new Map<string, Cohort>();
  for (const [customerId, month] of first) {
    const cohort = rolls.get(month) ?? { month, size: 0, retained: 0 };
    cohort.size += 1;
    if (later.has(customerId)) cohort.retained += 1;
    rolls.set(month, cohort);
  }
  return [...rolls.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

export interface AeoRoll {
  total: number;
  published: number;
  stale: number;
  /** Pages an answer engine was actually observed citing. */
  cited: number;
  clusters: number;
  /** Cited as a share of published, 0–100. */
  citationSharePct: number;
}

export function aeoCoverage(pages: readonly AeoRow[]): AeoRoll {
  const published = pages.filter((page) => page.status === "published");
  const cited = pages.filter((page) => citationsOf(page).length > 0);
  return {
    total: pages.length,
    published: published.length,
    stale: pages.filter((page) => page.status === "stale").length,
    cited: cited.length,
    clusters: new Set(pages.map((page) => page.queryCluster)).size,
    citationSharePct: published.length === 0 ? 0 : Math.round((cited.length / published.length) * 100)
  };
}

/**
 * The engines quoting an answer page, as a person names them. `citedByJson` is
 * written by the crawler as a list, and has arrived as bare names, as
 * `{engines:[…]}`, and as sighting records — `{engine, firstSeen, lastSeen}` —
 * which the QUOTED BY column rendered as `[object Object]`. Read all three,
 * trust none.
 */
export function citationsOf(page: AeoRow): string[] {
  const raw = asJson<unknown>(page.citedByJson, []);
  const list = Array.isArray(raw) ? raw : ((raw as { engines?: unknown }).engines ?? []);
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (typeof entry === "string") return entry;
      const record = entry as { engine?: unknown; name?: unknown };
      const named = record?.engine ?? record?.name;
      return typeof named === "string" ? named : "";
    })
    .filter(Boolean)
    .map(engineName);
}

/**
 * Answer engines spell themselves; `humanise` would give "Chatgpt". Anything
 * unknown falls back to title case, which is still a name and not a slug.
 */
const ENGINE_NAMES: Record<string, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  copilot: "Copilot",
  claude: "Claude",
  google_ai_overviews: "Google AI Overviews",
  google_sge: "Google AI Overviews",
  grok: "Grok"
};

export function engineName(slug: string): string {
  return (
    ENGINE_NAMES[slug] ??
    slug
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

/** A page nobody re-verified inside the window is answering from old facts. */
export function isStale(page: AeoRow, now: number, days = 30): boolean {
  if (page.status === "stale") return true;
  if (!page.freshness) return page.status === "published";
  return now - page.freshness > days * 86_400_000;
}

export interface AudienceValue {
  audience: AudienceRow;
  campaigns: number;
  spendMinor: number;
  binds: number;
  valueMinor: number;
  cacMinor: number | null;
  ltvMinor: number | null;
  multiple: number | null;
  /** Binds as a share of the cached audience size, 0–100. */
  conversionPct: number;
}

/**
 * Value per audience. Attribution rows carry a campaign, not an audience, so
 * the campaign is the join: an audience is worth what the campaigns aimed at it
 * bound, and costs what they spent.
 */
export function audienceValue(
  audiences: readonly AudienceRow[],
  campaigns: readonly CampaignRow[],
  spend: readonly SpendRow[],
  touches: readonly TouchRow[]
): AudienceValue[] {
  return audiences
    .map((audience) => {
      const own = campaigns.filter((campaign) => campaign.audienceId === audience.id);
      const ids = new Set(own.map((campaign) => campaign.id));
      const spendMinor = totalSpendMinor(spend.filter((row) => row.campaignId && ids.has(row.campaignId)));
      const mine = touches.filter((touch) => touch.campaignId && ids.has(touch.campaignId));
      const binds = mine.filter((touch) => touch.touchType === BIND);
      const cac = cacMinor(spendMinor, binds.length);
      const ltv = ltvMinor(mine);
      return {
        audience,
        campaigns: own.length,
        spendMinor,
        binds: binds.length,
        valueMinor: binds.reduce((sum, touch) => sum + (touch.valueMinor || 0), 0),
        cacMinor: cac,
        ltvMinor: ltv,
        multiple: ltvToCac(ltv, cac),
        conversionPct:
          audience.sizeCached && audience.sizeCached > 0
            ? Math.round((binds.length / audience.sizeCached) * 10_000) / 100
            : 0
      };
    })
    .sort((a, b) => b.valueMinor - a.valueMinor);
}

/** docs/19: reversing a move is only honest inside the window the move promised. */
export function isReversible(move: MoveRow, now: number): boolean {
  if (move.reversedAt) return false;
  return move.reversibleUntil === null || move.reversibleUntil > now;
}

/** apps/api/src/resources.ts CAMPAIGN_TRANSITIONS — the client mirrors it so the
 *  form only offers states the API will accept. `draft -> live` is legal (J-M1). */
export const CAMPAIGN_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["review", "scheduled", "live", "ended"],
  review: ["draft", "scheduled", "live", "ended"],
  scheduled: ["review", "live", "ended"],
  live: ["paused", "ended"],
  paused: ["live", "ended"],
  ended: []
};

export function nextStates(state: string): readonly string[] {
  return CAMPAIGN_TRANSITIONS[state] ?? [];
}

/** Compliance has to have cleared a variant before the campaign can carry it. */
export function isPublishable(creative: CreativeRow): boolean {
  return creative.complianceStatus === "passed";
}

/** A campaign with no cleared creative has nothing to say when it goes live. */
export function canLaunch(campaign: CampaignRow, creatives: readonly CreativeRow[]): boolean {
  if (!nextStates(campaign.state).includes("live")) return false;
  return creatives.some((creative) => creative.campaignId === campaign.id && isPublishable(creative));
}

/* --------------------------------------------------------------- experiments */

/** The arms of a test. The column holds a bare array; a wrapped `{variants:[…]}`
 *  is read too so a hand-written row does not render an empty test. */
export function variantsOf(row: ExperimentRow): Variant[] {
  const raw = asJson<unknown>(row.variantsJson, []);
  const list = Array.isArray(raw) ? raw : ((raw as { variants?: unknown }).variants ?? []);
  return Array.isArray(list) ? (list as Variant[]) : [];
}

export function resultOf(row: ExperimentRow): ExperimentResult | null {
  if (row.resultJson === null || row.resultJson === undefined) return null;
  const parsed = asJson<ExperimentResult | null>(row.resultJson, null);
  return parsed && typeof parsed === "object" ? parsed : null;
}

/** How many observations the stop was called on, across every arm. */
export function samplesSeen(result: ExperimentResult | null): number {
  return Object.values(result?.samples ?? {}).reduce((sum, n) => sum + (Number.isFinite(n) ? n : 0), 0);
}

/** Progress towards `minSample`, 0-100. Null when nobody set a target. */
export function samplePct(row: ExperimentRow): number | null {
  if (!row.minSample) return null;
  const seen = samplesSeen(resultOf(row));
  return Math.min(100, Math.round((seen / row.minSample) * 100));
}

/** A test only ever moves forward. Mirrors what the decide form may offer;
 *  the API takes any state, so this is the client's own discipline. */
export const EXPERIMENT_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["running", "abandoned"],
  running: ["concluded", "abandoned"],
  concluded: [],
  abandoned: []
};

export function nextExperimentStates(state: string): readonly string[] {
  return EXPERIMENT_TRANSITIONS[state] ?? [];
}

/** 95% probability-to-beat-control, in basis points: the line a sequential test
 *  has to cross before a stop counts as a decision rather than a peek. */
export const DECISION_BOUNDARY_BPS = 9_500;

export function crossedBoundary(result: ExperimentResult | null): boolean {
  const p = result?.probabilityToBeatControlBps;
  return typeof p === "number" && p >= DECISION_BOUNDARY_BPS;
}

/** won -> success, lost -> danger, abandoned -> neutral, still open -> info. */
export function verdictTone(row: ExperimentRow): "success" | "danger" | "warning" | "neutral" | "info" {
  const verdict = resultOf(row)?.verdict;
  if (verdict === "won") return "success";
  if (verdict === "lost") return "danger";
  if (verdict === "inconclusive") return "warning";
  if (verdict === "abandoned") return "neutral";
  return "info";
}

/** `quote_start_rate` -> its label, or title-case when this pack never named it. */
export function metricLabel(slug: string, l: Label): string {
  const key = `exp.metric.${slug}`;
  const named = l(key);
  return named === key ? humanise(slug) : named;
}

/* --------------------------------------------------------------------- admin */

/** `signal_campaigns.guardrail_checks_json`, as the compliance pass writes it. */
export interface Guardrails {
  suppressionAudienceApplied?: boolean;
  frequencyCapPerWeek?: number;
  quietHours?: { from?: string; to?: string; tz?: string };
  brandKit?: string;
  bannedClaims?: string;
  checkedAt?: number;
}

/**
 * A campaign that has not been checked has no record at all, not an empty one —
 * so this returns null rather than `{}` and the admin screen can tell "checked,
 * clean" apart from "never checked".
 */
export function guardrailsOf(campaign: CampaignRow): Guardrails | null {
  const bag = asJson<Guardrails | null>(campaign.guardrailChecksJson, null);
  return bag && typeof bag === "object" && !Array.isArray(bag) ? bag : null;
}

/* ------------------------------------------------------------- campaign plan */

/**
 * Mirrors `CampaignOption`/`CampaignPlan` in
 * packages/model-gateway/src/campaign-plan.ts. The web may not import the
 * gateway, so this is a structural copy and the fixtures below it are written
 * in the shape the server actually sends — `apps/api/src/engines/scout-promote.ts`
 * stringifies the gateway type straight into `plan_json`, and crud.ts hydrate()
 * parses it back out again.
 */
export interface PlanOption {
  name: string;
  angle: string;
  offer: string;
  /** Slugs from CAMPAIGN_CHANNELS — rendered through channelLabel(). */
  channels: string[];
  /** The model's own 0-100 estimate that this option meets the objective. */
  probability: number;
  why: string[];
  risk: string | null;
}

export interface CampaignPlan {
  notes: string;
  /** Highest probability first, as the parser sorted them. */
  options: PlanOption[];
  recommended: string;
  /** Share of the model's options that survived validation. 0 = the
   *  deterministic fallback, i.e. nobody argued this. */
  confidence: number;
}

/** An option is only worth showing if it says what to do and where. */
function planOption(raw: unknown): PlanOption | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const channels = Array.isArray(o.channels) ? o.channels.filter((c): c is string => typeof c === "string") : [];
  if (typeof o.name !== "string" || !o.name || typeof o.angle !== "string" || !channels.length) return null;
  return {
    name: o.name,
    angle: o.angle,
    offer: typeof o.offer === "string" ? o.offer : "",
    channels,
    probability: typeof o.probability === "number" && Number.isFinite(o.probability) ? o.probability : 0,
    why: Array.isArray(o.why) ? o.why.filter((w): w is string => typeof w === "string") : [],
    risk: typeof o.risk === "string" ? o.risk : null
  };
}

/**
 * The plan behind a campaign, or null when there is nothing to show.
 *
 * Tolerant on purpose: a stored plan is a year-old row written by a model, and
 * one malformed option must cost that option rather than the screen. Null when
 * no option survives — an empty option list is not a plan, and the card that
 * would render it says nothing.
 */
export function planOf(campaign: CampaignRow): CampaignPlan | null {
  const bag = asJson<Record<string, unknown> | null>(campaign.planJson, null);
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const options = (Array.isArray(bag.options) ? bag.options : []).map(planOption).filter((o): o is PlanOption => o !== null);
  if (!options.length) return null;
  const recommended = typeof bag.recommended === "string" && options.some((o) => o.name === bag.recommended)
    ? bag.recommended
    : options[0]!.name;
  return {
    notes: typeof bag.notes === "string" ? bag.notes : "",
    options,
    recommended,
    confidence: typeof bag.confidence === "number" && Number.isFinite(bag.confidence) ? bag.confidence : 0
  };
}

/** One band the pool was cut on, and why the model cut it there. */
export interface PoolReason {
  axis: string;
  value: string;
  reason: string;
  /** Customers on the book in that band. 0 when the row predates counting. */
  count: number;
}

export interface AudiencePool {
  summary: string;
  estimatedReach: number;
  reasons: PoolReason[];
}

/**
 * The pool behind an audience the model proposed, off `definitionJson.targeting`.
 *
 * Mirror of `planAudience` in apps/api/src/engines/signal-campaign-plan.ts —
 * same column, same tolerance, so the bands the copy was written for are the
 * bands the screen names. Null for an audience somebody wrote by hand: it has a
 * rule but nobody argued it, and inventing a reason would put words in a human's
 * mouth.
 */
export function poolOf(audience: AudienceRow): AudiencePool | null {
  const def = asJson<Record<string, unknown>>(audience.definitionJson, {});
  const t = def.targeting;
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const bag = t as Record<string, unknown>;
  const reasons = (Array.isArray(bag.reasons) ? bag.reasons : []).flatMap((raw): PoolReason[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const r = raw as Record<string, unknown>;
    if (typeof r.axis !== "string" || typeof r.value !== "string" || typeof r.reason !== "string") return [];
    return [
      {
        axis: r.axis,
        value: r.value,
        reason: r.reason,
        count: typeof r.count === "number" && Number.isFinite(r.count) ? r.count : 0
      }
    ];
  });
  if (!reasons.length) return null;
  return {
    summary: typeof bag.summary === "string" ? bag.summary : audience.name,
    estimatedReach:
      typeof bag.estimatedReach === "number" && Number.isFinite(bag.estimatedReach)
        ? bag.estimatedReach
        : (audience.sizeCached ?? 0),
    reasons
  };
}

/** Colour by the model's own odds — the reader should see 62% and 27% differently. */
export function probabilityTone(probability: number): "success" | "warning" | "neutral" {
  if (probability >= 60) return "success";
  if (probability >= 35) return "warning";
  return "neutral";
}

/** States in which a campaign is already reaching people, so its checks bind now. */
export const REACHING_STATES: readonly string[] = ["scheduled", "live"];

/** The autonomy levels that spend without asking (packages/db/src/json.ts). */
const UNSUPERVISED: readonly string[] = ["act", "act_and_report"];

/** The audience this one subtracts before it sends. */
export function excludedAudienceId(audience: AudienceRow): string | null {
  const def = asJson<Record<string, unknown>>(audience.definitionJson, {});
  return typeof def.excludeAudienceId === "string" && def.excludeAudienceId ? def.excludeAudienceId : null;
}

/**
 * The audiences that exist to be subtracted: one that asks for no consent
 * purpose at all, or one another audience already excludes. Either way it is a
 * suppression source and must not itself be required to carry an exclusion.
 */
export function suppressionIds(audiences: readonly AudienceRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of audiences) {
    if (row.consentPurposes === "none") ids.add(row.id);
    const excluded = excludedAudienceId(row);
    if (excluded) ids.add(excluded);
  }
  return ids;
}

/* ------------------------------------------------------- opportunity → words */

/**
 * A SCOUT whitespace, read over the wire by the studio. Declared here rather
 * than imported from scout.shared so SIGNAL's screens keep no compile-time
 * dependency on another module's UI (CLAUDE.md §6) — the coupling is one HTTP
 * read, the same as any other consumer of the API.
 */
export interface OpportunityRow {
  id: string;
  description: string;
  category?: string | null;
  demandEstimate?: number | null;
  competitionScore?: number | null;
}

/**
 * The brief the studio opens with when it was reached from an opportunity.
 * SCOUT could say "here is an unserved segment" and the marketer then retyped
 * it into a brief by hand, which is where the demand and competition numbers
 * fell out of the ask. It is a prefill, not a lock: the field stays editable.
 */
export function briefFromOpportunity(row: OpportunityRow, l: Label): string {
  const facts = [
    row.category ? `${l("category")}: ${row.category}` : "",
    typeof row.demandEstimate === "number" ? `${l("demand")}: ${row.demandEstimate}` : "",
    typeof row.competitionScore === "number" ? `${l("competition")}: ${row.competitionScore}/100` : ""
  ].filter(Boolean);
  return [row.description, facts.join(" · ")].filter(Boolean).join("\n\n");
}

/**
 * The first sentence carries the card; the rest is the supporting line. A
 * variant is one line of prose (apps/api/src/engines/signal-creative.ts parses
 * one per line), so this is the only split available without asking the model
 * for structure it was never told to produce.
 */
export function splitCopy(text: string): { headline: string; body: string } {
  const trimmed = text.trim();
  // Arabic full stop and question mark included: an `ar` variant breaks on its
  // own punctuation, not on the Latin set.
  const at = trimmed.search(/[.!?؟۔](\s|$)/);
  if (at <= 0 || at >= trimmed.length - 2) return { headline: trimmed, body: "" };
  return { headline: trimmed.slice(0, at + 1), body: trimmed.slice(at + 1).trim() };
}

/**
 * What is wrong when the campaign, guardrail and audience config are read
 * together. Each of these is invisible in the per-table list an admin would
 * otherwise be editing, and each lets a send reach somebody it should not or
 * lets an agent spend with no ceiling.
 */
export function adminFaults(input: {
  campaigns: readonly CampaignRow[];
  audiences: readonly AudienceRow[];
}): Array<{ key: string; ref: string }> {
  const faults: Array<{ key: string; ref: string }> = [];

  for (const campaign of input.campaigns) {
    const guardrails = guardrailsOf(campaign);
    if (REACHING_STATES.includes(campaign.state)) {
      if (!guardrails) faults.push({ key: "admin.fault.unchecked", ref: campaign.name });
      else {
        if (guardrails.bannedClaims && guardrails.bannedClaims !== "pass") {
          faults.push({ key: "admin.fault.bannedClaims", ref: campaign.name });
        }
        if (guardrails.brandKit && guardrails.brandKit !== "pass") {
          faults.push({ key: "admin.fault.brandKit", ref: campaign.name });
        }
        if (guardrails.suppressionAudienceApplied === false) {
          faults.push({ key: "admin.fault.noSuppressionApplied", ref: campaign.name });
        }
      }
    }
    if (UNSUPERVISED.includes(campaign.autonomyLevel) && !budgetOf(campaign).autopilotBoundMinor) {
      faults.push({ key: "admin.fault.unbounded", ref: campaign.name });
    }
  }

  const suppression = suppressionIds(input.audiences);
  if (input.audiences.length > 0 && suppression.size === 0) {
    faults.push({ key: "admin.fault.noSuppressionSource", ref: "" });
  }
  for (const audience of input.audiences) {
    if (suppression.has(audience.id)) continue;
    if (!excludedAudienceId(audience)) faults.push({ key: "admin.fault.noExclusion", ref: audience.name });
  }
  return faults;
}

/* -------------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    /* shared */
    approvalTitle: "Waiting for an approver",
    approvalBody: "This change needs a second pair of eyes under policy {policy}. It is queued, not lost.",
    approvalLink: "Open approvals",
    save: "Save",
    cancel: "Cancel",
    saved: "Saved",
    channel: "Channel",
    campaign: "Campaign",
    spend: "Spend",
    plan: "Plan",
    binds: "Signed",
    value: "Value",
    clicks: "Clicks",
    impressions: "Impressions",
    conversions: "Conversions",
    cac: "Cost per acquisition",
    ltv: "Value per customer",
    multiple: "Value to cost",
    state: "State",
    reason: "Reason",
    amount: "Amount",
    when: "When",
    none: "Not enough data yet",
    noPermission: "Your role does not include this view.",
    why: "Why",
    audience: "Audience",
    autonomy: "Autonomy",
    bound: "Per-move ceiling",
    days: "{n} days",
    confirm: "I understand this changes what the agents may spend",

    /* cockpit */
    "cockpit.title": "Growth cockpit",
    "cockpit.lede": "What the money bought this window, and what the agents changed while you were away.",
    "cockpit.answer.moved": "The autopilot moved budget {n} time(s) this window.",
    "cockpit.answer.overPlan": "Spend is {n}% over plan this window.",
    "cockpit.answer.running": "{n} campaign(s) running, nothing moved yet.",
    "cockpit.answer.quiet": "Nothing running and nothing moved this window.",
    "cockpit.spendToDate": "Spent this window",
    "cockpit.againstPlan": "Against plan",
    "cockpit.pipeline": "Pipeline by channel",
    "cockpit.pipelineCaption": "Spend, clicks and signings per channel over the window",
    "cockpit.loop": "Acquisition loop",
    "cockpit.loopCaption": "Messages sent, leads raised and policies bound per campaign — the loop from spend to customer",
    "cockpit.loopSends": "Sent",
    "cockpit.loopLeads": "Leads",
    "cockpit.runOutreach": "Run outreach now",
    "cockpit.noLoop": "No outreach has been sent in this window yet.",
    "cockpit.noLoop.body": "Nothing has gone out to a customer here. The loop fills once a campaign starts sending.",
    "cockpit.scales": "What came back",
    "cockpit.scalesCaption": "Replies, reads and signings from every send, counted per campaign, per audience and per person",
    "cockpit.scale.campaign": "Campaigns",
    "cockpit.scale.audience": "Audiences",
    "cockpit.scale.customer": "People",
    "cockpit.read": "Read",
    "cockpit.replied": "Replied",
    "cockpit.replyRate": "Reply rate",
    "cockpit.optedOut": "Opted out",
    "cockpit.signed": "Signed",
    "cockpit.noResponses": "Nothing has come back in this window yet.",
    "cockpit.noResponses.body": "Replies, reads and opt-outs land here once outreach has been sent.",
    "cockpit.closedLoop": "A {channel} message for {campaign} became a policy:",
    "cockpit.liveCampaigns": "Running now",
    "cockpit.liveCaption": "Campaigns in a live or paused state",
    "cockpit.changesToday": "What the agents changed",
    "cockpit.changesCaption": "Budget moves the autopilot made, newest first",
    "cockpit.noChanges": "The autopilot has not moved anything in this window.",
    "cockpit.noChanges.body": "No budget or bid has been shifted. The autopilot records every move it makes here.",
    "cockpit.noCampaigns": "Nothing is running.",
    "cockpit.noCampaigns.body": "No campaign is live. Launch one from the studio to start reaching people.",
    "cockpit.startOne": "Open the campaign studio",
    "cockpit.autopilot": "Autopilot",
    "cockpit.pause": "Pause the autopilot",
    "cockpit.resume": "Resume the autopilot",
    "cockpit.runNow": "Look for a move now",
    "cockpit.paused": "Paused",
    "cockpit.running": "Running",
    "cockpit.adjusted": "The autopilot made {n} move(s).",
    "cockpit.movedBy": "Moved by",
    "cockpit.trend": "Daily spend",
    "cockpit.autopilotWhy":
      "The autopilot compares cost per acquisition across channels over the last seven days and moves budget toward the cheaper one, inside each campaign's per-move ceiling.",
    "cockpit.openBudget": "Budget and bounds",
    "cockpit.openAnalytics": "Growth analytics",

    /* studio */
    "studio.title": "Campaign studio",
    "studio.lede": "Say what you want and who it is for. The model drafts the words, you edit them, then you launch.",
    "studio.step1": "The goal",
    "studio.step2": "The words",
    "studio.step3": "Review",
    "studio.step4": "Launch",
    "studio.step5": "Live",
    "studio.name": "What is this campaign called",
    "studio.objective": "What is it for",
    "studio.audienceHint": "Who it reaches. Leave empty to reach everyone.",
    "studio.audienceAll": "Everyone",
    "studio.channels": "Where it runs",
    "studio.channelsHint": "Tick every place this campaign may buy. The autopilot moves budget between the ones you tick.",
    "studio.daily": "Daily budget",
    "studio.boundHint": "The most the autopilot may move between channels in one decision.",
    "studio.owner": "Who owns it",
    "studio.ownerPick": "Choose a colleague or team",
    "studio.create": "Start the campaign",
    "studio.created": "Draft created. Now give the model a brief.",
    "studio.pool": "Who it goes to, and why",
    "studio.poolReach": "About {n} people on the book",
    "studio.poolWhy": "Each band below was chosen from the book itself. The count is how many customers sit in it.",
    "studio.plan": "How the model would run this",
    "studio.planHint": "Three ways to spend, ranked by its own chance of success. The drafts below are written for the recommended one.",
    "studio.planRecommended": "Recommended",
    "studio.planOffer": "The offer",
    "studio.planRisk": "What would sink it",
    "studio.planNone": "Nothing has been argued for this campaign yet",
    "studio.planNoneHint": "Say what it is selling and the model will draft three ways to spend, each with its own chance of working. The drafts you generate afterwards are written for the one it recommends.",
    "studio.planSubject": "What is this campaign selling?",
    "studio.planSubjectHint": "A line of cover, or the scenario you have in mind.",
    "studio.planAction": "Plan it",
    "studio.planning": "Planning...",
    "studio.planConfidence": "{n}% of the options it drafted survived checking.",
    "studio.planFallback": "The model did not answer. These options were derived from the demand figures alone.",
    "studio.brief": "Tell the model what to say",
    "studio.briefHint": "The offer, the tone, anything that must appear. The draft is yours to edit.",
    "studio.kind": "What kind of content",
    "studio.count": "How many variants",
    "studio.locales": "Languages",
    "studio.generate": "Draft the content",
    "studio.generating": "Drafting",
    "studio.generated": "{n} draft(s) ready to read.",
    "studio.variants": "Drafts",
    "studio.noVariants": "No drafts yet. Give the model a brief above.",
    "studio.noVariants.body": "Describe what you want to say and the model drafts variants you can compare here.",
    "studio.editVariant": "Edit this draft",
    "studio.approve": "Clear this draft",
    "studio.approved": "Cleared",
    "studio.blockedNote": "Compliance blocked this draft. Edit it or discard it.",
    "studio.discard": "Discard",
    "studio.launch": "Launch the campaign",
    "studio.launchHint": "Going live spends money. It is recorded, and it may need an approver.",
    "studio.launchBlocked": "Clear at least one draft before launching.",
    "studio.launched": "The campaign is live.",
    "studio.whyDraft": "Drafted from your brief, the audience definition and the compliance rules for this content type.",
    "studio.art": "How it will look",
    "studio.artHint": "The cleared words on your own brand. Download the frame you need.",
    "studio.template": "Layout",
    "studio.template.spotlight": "Spotlight",
    "studio.template.split": "Image and words",
    "studio.template.quote": "Quote",
    "studio.template.offer": "Offer",
    "studio.template.clean": "Clean",
    "studio.format.square": "Feed (1:1)",
    "studio.format.portrait": "Feed (4:5)",
    "studio.format.story": "Story (9:16)",
    "studio.format.landscape": "Link card",
    "studio.format.display": "Ad slot",
    "studio.format.leaderboard": "Banner",
    "studio.format.email": "Email header",
    "studio.ctaDefault": "Find out more",
    "studio.svg": "Download SVG",
    "studio.edit": "Edit",
    "studio.canvasElement": "Element to adjust",
    "studio.canvasHint": "Drag an element, or select it and use the arrow keys (Shift for bigger steps), + and − to resize, 0 to put it back.",
    "studio.canvasSize": "Size",
    "studio.save": "Save design",
    "studio.reset": "Reset this size",
    "studio.done": "Done",
    "studio.saved": "Design saved.",
    "studio.png": "Download PNG",
    "studio.contrast": "The {slot} is hard to read on your brand colour ({ratio}:1; it needs {required}:1). Pick another layout or adjust the colour.",
    "studio.slot.headline": "headline",
    "studio.slot.body": "body text",
    "studio.slot.kicker": "small heading",
    "studio.slot.cta": "button",
    "studio.fromOpportunity": "From an opportunity Market found",
    "studio.image": "Generate an image",
    "studio.imageHint": "Describe the scene. The model drafts a hero image for this campaign.",
    "studio.imagePrompt": "What should the image show?",
    "studio.imageGenerate": "Generate image",
    "studio.imageGenerating": "Generating…",
    "studio.imageGenerated": "New image ready below.",
    "studio.imageAlt": "AI-generated campaign image",
    category: "Category",
    demand: "Estimated demand",
    competition: "Competition",
    "studio.pickCampaign": "Or continue a draft",
    "studio.open": "Open",
    "studio.performance": "How it is doing",
    "studio.performanceCaption": "Spend and outcome per channel since launch",
    "studio.noSpend": "No spend recorded yet.",
    "studio.noSpend.body": "Nothing has cost anything yet. Spend appears once a variant is put behind a live campaign.",
    "studio.newCampaign": "Start a new one",
    "studio.complianceNote": "Compliance note",
    "studio.pause": "Pause it",

    /* audience value */
    "aud.title": "Audiences and value",
    "aud.lede": "What each audience is worth against what it costs to reach.",
    "aud.caption": "Value, cost and conversion per audience",
    "aud.size": "Size",
    "aud.reach": "Campaigns aimed here",
    "aud.conversion": "Conversion",
    "aud.best": "Best value to cost",
    "aud.worst": "Losing money",
    "aud.totalValue": "Total value signed",
    "aud.unmeasured": "No campaign has aimed at this audience yet.",
    "aud.unmeasured.body": "Value is measured from the campaigns that targeted an audience. Aim one at this audience and its return appears here.",
    "aud.thin": "Too few signings to trust this number.",
    "aud.openAudiences": "Manage audiences",
    "aud.answer.best": "{name} leads at {multiple}.",
    "aud.answer.losing": "{n} audience(s) are costing more than they return.",
    "aud.answer.none": "Not enough signings yet to say what pays.",
    "aud.suggestTitle": "Suggest an audience",
    "aud.suggestLede": "The model sees only aggregate counts above the k-anonymity floor and proposes a rule over them — never a customer row.",
    "aud.suggestSubject": "Subject",
    "aud.suggestAction": "Suggest audience",
    "aud.suggestedPool": "Proposed pool by attribute",
    "aud.suggestedPoolX": "share of the book",
    "aud.suggestedPoolY": "count shown to the model",
    "aud.suggestedReach": "Estimated reach",
    "aud.suggestedConfidence": "Confidence",
    "aud.suggestedSource": "Source",
    "aud.sourceAi": "Model",
    "aud.sourceFallback": "Deterministic fallback",
    "aud.why": "Why these",

    /* answer engines */
    "aeo.title": "Answer engines",
    "aeo.lede": "Which questions you answer, and whether the engines are quoting you.",
    "aeo.caption": "Answer pages by cluster, freshness and citations",
    "aeo.coverage": "Clusters covered",
    "aeo.publishedPages": "Published",
    "aeo.citedPages": "Cited",
    "aeo.share": "Citation share",
    "aeo.stalePages": "Needs re-checking",
    "aeo.cluster": "Question cluster",
    "aeo.citedBy": "Quoted by",
    "aeo.freshness": "Last verified",
    "aeo.never": "Never",
    "aeo.markStale": "Flag for re-checking",
    "aeo.publish": "Publish",
    "aeo.retire": "Retire",
    "aeo.noPages": "No answer pages yet.",
    "aeo.noPages.body": "An answer page is what an assistant quotes when someone asks about your product. None has been published yet.",
    "aeo.openPages": "Manage answer pages",
    "aeo.answer.share": "{pct}% of citations trace back to you.",
    "aeo.answer.none": "No answer pages published yet.",
    "aeo.staleWarning": "{n} published page(s) have not been verified in 30 days.",

    /* experiments */
    "exp.title": "Experiments",
    "exp.lede": "Every test we ran, what it was for, and what it decided.",
    "exp.caption": "Experiments by state, with the metric each one moves",
    "exp.runningNow": "Running now",
    "exp.decidedCount": "Decided",
    "exp.wonCount": "Won",
    "exp.hypothesis": "Hypothesis",
    "exp.metric": "Metric",
    "exp.state": "State",
    "exp.arms": "Arms",
    "exp.sample": "Sample",
    "exp.verdict": "Verdict",
    "exp.concluded": "Stopped",
    "exp.open": "Open",
    "exp.none": "No experiments yet.",
    "exp.none.body": "An experiment splits spend between two creatives or audiences and reports which won. Start one to see it here.",
    "exp.pending": "Still open",
    "exp.noWinner": "No single arm",
    "exp.noTarget": "No target set",
    "exp.state.draft": "Draft",
    "exp.state.running": "Running",
    "exp.state.concluded": "Concluded",
    "exp.state.abandoned": "Abandoned",
    "exp.verdict.won": "Won",
    "exp.verdict.lost": "Lost",
    "exp.verdict.inconclusive": "Inconclusive",
    "exp.verdict.abandoned": "Dropped",
    "exp.detail": "The test in detail",
    "exp.variants": "The arms of this test",
    "exp.variant": "Arm",
    "exp.split": "Traffic share",
    "exp.rate": "Rate",
    "exp.samples": "Observations",
    "exp.control": "Control",
    "exp.winner": "Winner",
    "exp.uplift": "Uplift on control",
    "exp.probability": "Probability it beats control",
    "exp.boundary": "Stopping line at 95%",
    "exp.crossed": "Crossed the line — read this as a decision.",
    "exp.notCrossed": "Short of the line — read this as a lean, not a decision.",
    "exp.stoppedBy": "Stopped by",
    "exp.note": "What we did about it",
    "exp.reason": "Why it was dropped",
    "exp.reach": "Audience it could reach",
    "exp.progress": "Towards {n} observations",
    "exp.noReading": "No reading yet — it is still collecting.",
    "exp.chart": "Sequential test",
    "exp.chartHint": "The reading at the stop, not the path to it: interim snapshots are not kept.",
    "exp.decide": "Record the decision",
    "exp.decideHint":
      "Moving a test out of running writes the verdict with it. Stopping without one leaves the log unreadable later.",
    "exp.newState": "Move it to",
    "exp.verdictField": "Verdict",
    "exp.winnerField": "Which arm won",
    "exp.noteField": "Note for the log",
    "exp.decideSaved": "Decision recorded.",
    "exp.new": "Start a test",
    "exp.newHint": "Two arms, one metric, and the number of observations you will not stop before.",
    "exp.hypothesisField": "What you expect to happen",
    "exp.metricField": "Metric it moves",
    "exp.minSampleField": "Do not stop before",
    "exp.campaignField": "Campaign (optional)",
    "exp.controlField": "Control arm",
    "exp.challengerField": "Challenger arm",
    "exp.create": "Start it",
    "exp.created": "Test created as a draft.",
    "exp.unattached": "No campaign",
    "exp.metric.quote_start_rate": "Quote start rate",
    "exp.metric.click_to_bind_rate": "Click-to-bind rate",
    "exp.metric.renewal_accept_rate": "Renewal acceptance rate",
    "exp.metric.aeo_citation_share": "Answer-engine citation share",
    "exp.answer.won": "{n} test(s) have already paid off.",
    "exp.answer.running": "{n} test(s) running now.",

    /* budget */
    "budget.title": "Budget and bounds",
    "budget.lede": "The ceiling on the spend, and how far the agents may move it without asking.",
    "budget.ceiling": "Ceiling",
    "budget.used": "Spent",
    "budget.perCampaign": "Per campaign",
    "budget.caption": "Daily budget, per-move ceiling and autonomy per campaign",
    "budget.setBounds": "Change the bounds",
    "budget.boundsSaved": "Bounds updated.",
    "budget.daily": "Daily budget",
    "budget.autonomyHint": "Ask first, act then tell, or act alone.",
    "budget.moves": "Moves made",
    "budget.movesCaption": "Every budget move, who allowed it and whether it can still be undone",
    "budget.reverse": "Undo this move",
    "budget.reversed": "Undone",
    "budget.reverseWindow": "Can be undone until",
    "budget.reverseHint": "Undoing a move puts the money back where it came from. It is recorded.",
    "budget.noMoves": "No moves yet.",
    "budget.noMoves.body": "Every shift between campaigns is recorded here, whether you made it or the autopilot did.",
    "budget.expired": "The window to undo this has closed.",
    "budget.pickCampaign": "Which campaign",
    "budget.headroom": "Headroom",
    "budget.overspend": "Over plan",
    "budget.autoApproved": "Inside its bounds",
    "budget.needsApproval": "Needed an approver",
    "budget.answer.over": "{amount} over plan for this window.",
    "budget.answer.under": "{amount} of headroom left this window.",

    /* analytics */
    "growth.title": "Growth analytics",
    "growth.lede": "Cost, value and where the customers actually came from.",
    "growth.blended": "Blended cost per acquisition",
    "growth.blendedLtv": "Blended value per customer",
    "growth.ratio": "Value to cost",
    "growth.ratioHint": "Three or better is a business that can afford to grow.",
    "growth.attribution": "Where they came from",
    "growth.attributionCaption": "Spend, signings and cost per acquisition by channel",
    "growth.cohorts": "Coming back",
    "growth.cohortsCaption": "Customers by the month they first signed, and how many returned",
    "growth.cohort": "First signed",
    "growth.size": "Customers",
    "growth.retained": "Came back",
    "growth.retention": "Return rate",
    "growth.export": "Export",
    "growth.exportHint": "The spend ledger for this window, as a file.",
    "growth.format": "Format",
    "growth.exportReady": "Your file is ready",
    "growth.download": "Download",
    "growth.exportQueued": "Building your file. Reload in a moment.",
    "growth.window": "Window",
    "growth.last7": "Last 7 days",
    "growth.last30": "Last 30 days",
    "growth.last90": "Last 90 days",
    "growth.noCohorts": "No cohort has enough history yet.",
    "growth.noCohorts.body": "A cohort needs customers acquired in a period and time since to measure. Widen the window.",
    "growth.noSpend": "No spend recorded in this window.",
    "growth.noSpend.body": "Nothing has been spent in this window. Widen the window, or start a campaign to see cost against return.",
    "growth.efficiency": "Cost per click",
    "growth.answer.ratio": "{multiple} value for every unit spent.",
    "growth.answer.none": "Not enough binds yet to price the return.",
    /* option values, so a screen never renders a raw enum */
    xlsx: "Excel",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    // packages/db/src/json.ts AutonomyLevel, namespaced because `draft` is also
    // a campaign state and the two mean different things.
    "autonomy.suggest": "Suggest only",
    "autonomy.draft": "Draft, do not send",
    "autonomy.act_with_approval": "Act with approval",
    "autonomy.act": "Act alone",
    "autonomy.act_and_report": "Act and report",
    acq: "Winning new customers",
    renewal: "Keeping customers",
    xsell: "Selling more to customers",
    draft: "Draft",
    review: "In review",
    scheduled: "Scheduled",
    live: "Live",
    paused: "Paused",
    ended: "Ended",
    ad: "Advert",
    lp: "Landing page",
    email: "Email",
    social: "Social post",
    video_script: "Video script",
    image: "Image",
    pending: "Not checked yet",
    passed: "Cleared",
    flagged: "Flagged",
    blocked: "Blocked",
    published: "Published",
    stale: "Needs re-checking",
    retired: "Retired",
    "locale.en": "English",
    "locale.ar": "Arabic",

    /* refusals — the screen's own validation, keyed by the code the action
       returned so the actor reads a sentence and the log keeps the code */
    "problem.bad_intent": "That control sent something this screen does not do.",
    "problem.campaign_required": "Choose a campaign first.",
    "problem.budget_required": "Give a daily budget.",
    "problem.bound_required": "Give a per-move ceiling.",
    "problem.bound_over_daily": "The per-move ceiling cannot exceed the daily budget.",
    "problem.autonomy_required": "Choose how much the agents may do on their own.",
    "problem.confirm_required": "Tick the confirmation before changing the bounds.",
    "problem.move_required": "Pick the move to undo.",
    "problem.actor_required": "An undo has to be recorded against a person.",
    "problem.name_required": "Give the campaign a name.",
    "problem.objective_required": "Say what the campaign is for.",
    "problem.owner_required": "Name who owns this campaign.",
    "problem.channels_required": "Pick at least one place for it to run.",
    "problem.brief_required": "Write at least a sentence for the model to work from.",
    "problem.kind_required": "Choose what kind of content to draft.",
    "problem.creative_required": "That draft is no longer on this screen. Reload it.",
    "problem.content_required": "A draft cannot be saved empty.",
    "problem.status_required": "Choose the state to move the page to.",
    "problem.page_required": "Pick an answer page first.",
    "problem.format_required": "Choose a file format.",
    "problem.experiment_required": "Pick a test first.",
    "problem.state_required": "Choose the state to move the test to.",
    "problem.verdict_required": "Record the verdict when you stop a test.",
    "problem.hypothesis_required": "Write what you expect to happen.",
    "problem.metric_required": "Say which metric is being measured.",
    "problem.arms_required": "Name both arms.",
    "problem.resource_required": "Choose which records to read.",
    "problem.limit_required": "Ask for between one and a hundred rows.",
    "problem.hook_required": "Pick the endpoint to ping.",
    "problem.subject_required": "Say what the audience is for.",

    /* admin */
    "admin.title": "Marketing admin",
    "admin.lede": "The brand, the claims, the ceilings and the lists everything sent from here is checked against.",
    "admin.denied": "Your role does not include the Marketing settings.",
    "admin.readyTitle": "Nothing is stranded.",
    "admin.readyBody": "Every running campaign passed its checks, every agent that spends has a ceiling, and every audience subtracts a suppression list.",
    "admin.fault.unchecked": "Reaching people without ever having passed the brand and claims checks.",
    "admin.fault.bannedClaims": "Running with a claims check that did not pass.",
    "admin.fault.brandKit": "Running with a brand check that did not pass.",
    "admin.fault.noSuppressionApplied": "Running without the suppression list subtracted.",
    "admin.fault.unbounded": "The agents may act on this one, and no per-move ceiling stops them.",
    "admin.fault.noSuppressionSource": "No suppression list exists, so nothing is being held back.",
    "admin.fault.noExclusion": "This audience subtracts no suppression list.",
    "admin.answer.faults": "{n} thing(s) need attention.",
    "admin.brandTitle": "Brand kit",
    "admin.brandLede": "The name, mark and colour every draft is written and rendered in.",
    "admin.brandName": "Product name",
    "admin.brandAccent": "Accent colour",
    "admin.brandLogos": "Marks supplied",
    "admin.brandDefault": "Platform default",
    "admin.brandEdit": "Edit the brand kit",
    "admin.brandHint": "Settings owns this, and checks the accent for readable contrast before it saves.",
    "admin.guardTitle": "Guardrails and banned claims",
    "admin.guardLede": "What each campaign was checked against, and when it was last checked.",
    "admin.guardCaption": "Guardrail checks per campaign",
    "admin.guardEmpty": "No campaign yet.",
    "admin.guardEmpty.body": "Guardrails apply per campaign, so this fills once the first one exists.",
    "admin.guardNone": "Never checked",
    "admin.claims": "Claims",
    "admin.brandCheck": "Brand",
    "admin.suppressionApplied": "Suppression",
    "admin.cap": "Frequency cap",
    "admin.capValue": "{n} per week",
    "admin.quiet": "Quiet hours",
    "admin.checkedAt": "Last checked",
    "admin.pass": "Pass",
    "admin.fail": "Fail",
    "admin.applied": "Applied",
    "admin.notApplied": "Not applied",
    "admin.boundsTitle": "Budget bounds and approvals",
    "admin.boundsLede": "How far the agents may go alone, and what waits for a person.",
    "admin.boundsCaption": "Daily budget, per-move ceiling and autonomy per campaign",
    "admin.boundsEmpty": "No campaign yet.",
    "admin.boundsEmpty.body": "Spend bounds are set per campaign, so this fills once the first one exists.",
    "admin.noBound": "No ceiling",
    "admin.paused": "Autopilot is paused for the whole tenant.",
    "admin.running": "Autopilot is running.",
    "admin.boundsEdit": "Change the bounds",
    "admin.policyTitle": "Approval thresholds",
    "admin.policyLede": "The decisions Marketing cannot take alone, and who is allowed to take them.",
    "admin.policyCaption": "Marketing approval policies",
    "admin.policyKey": "Decision",
    "admin.policyDecide": "Approver needs",
    "admin.policyDual": "Second pair of eyes",
    "admin.policyThreshold": "Above",
    "admin.policyAuto": "Auto-approved by this tenant",
    "admin.dual.never": "Not required",
    "admin.dual.above_threshold": "Above the threshold",
    "admin.dual.always": "Always",
    "admin.policy.signal.budget_move": "Move budget between campaigns",
    "admin.policy.signal.campaign_launch": "Launch a campaign",
    "admin.policy.signal.creative_publish": "Publish a creative",
    "admin.policy.signal.budget_commit": "Commit spend",
    "admin.policy.signal.boost": "Boost a running campaign",
    "admin.policy.signal.creator_brief": "Send a creator brief",
    "admin.policyEdit": "Open approvals",
    "admin.suppressionTitle": "Suppression sources",
    "admin.suppressionLede": "Who is held back from every send, and which audiences subtract them.",
    "admin.suppressionCaption": "Audiences, their consent basis and the list each one subtracts",
    "admin.suppressionEmpty": "No audience yet.",
    "admin.suppressionEmpty.body": "Suppression keeps an audience out of a campaign. Build an audience first, then exclude it here.",
    "admin.audienceName": "Audience",
    "admin.consent": "Consent basis",
    "admin.excludes": "Subtracts",
    "admin.isSuppression": "Suppression list",
    "admin.size": "Size",
    "admin.refresh": "Refreshed",
    "admin.suppressionEdit": "Edit audiences",
    "admin.discTitle": "Disclosure wordings",
    "admin.discLede": "The wordings presented to customers, per line and channel. The log is what was shown, and cannot be edited after the fact.",
    "admin.discCaption": "Disclosure wordings in use",
    "admin.discEmpty": "No disclosure has been presented yet.",
    "admin.discEmpty.body": "Disclosures are recorded the moment one is shown to a customer, so nothing appears until outreach starts.",
    "admin.discKey": "Wording",
    "admin.discLocale": "Language",
    "admin.discChannel": "Channel",
    "admin.discCount": "Times presented",
    "admin.discEdit": "Open the disclosure log",
    "admin.gapTitle": "Not configured here yet",
    "admin.gapLede": "Two things the spec asks of this screen have nowhere to be stored yet, so this screen does not pretend to hold them.",
    "admin.gapChannels": "Channel connections. Ad-account OAuth is not modelled — campaigns name their channels as slugs and spend is recorded against them, but no credential is held.",
    "admin.gapUtm": "UTM schema. Campaign links are tagged by whoever builds them; there is no tenant-wide pattern to enforce.",

    /* dev */
    "dev.title": "Marketing dev",
    "dev.kicker": "The integrator's bench",
    "dev.lede":
      "Read what SIGNAL actually stores, ping a webhook endpoint, and move a day of sandbox spend. Nothing here is a mock — every console calls the endpoint your code will call.",
    "dev.readTitle": "Read console",
    "dev.readLede":
      "Every SIGNAL record is a REST list under /v1/signal. Pick one and see exactly what your code gets back. Only the resources your role may read are offered.",
    "dev.resource": "Records",
    "dev.limit": "Rows",
    "dev.limitHint": "Between 1 and 100.",
    "dev.read": "Read the records",
    "dev.rows": "Rows returned",
    "dev.raw": "Response body",
    "dev.readEmpty": "That list is empty for this tenant. Nothing is broken — nothing has been written yet.",
    "dev.readEmpty.body": "Use the writers on this page, or the API, to put the first row in.",
    "dev.res.audiences": "Audiences",
    "dev.res.campaigns": "Campaigns",
    "dev.res.creatives": "Creatives",
    "dev.res.signal-experiments": "Experiments",
    "dev.res.budget-moves": "Budget moves",
    "dev.res.aeo-pages": "Answer pages",
    "dev.res.attribution-events": "Attribution touches",
    "dev.res.spend": "Spend ledger",
    "dev.pixelTitle": "Checking whether a touch landed",
    "dev.pixelLede":
      "There is no browser pixel or tag to install. SIGNAL records a touch server-side when a module event says one happened — a bind writes one in the same request — so the way to debug attribution is to read the touches back. The ledger is append-only and has no ingest route, so nothing outside the platform can post to it.",
    "dev.feedTitle": "Catalogue feeds",
    "dev.feedLede":
      "Answer pages are the catalogue SIGNAL publishes, and the console above reads them. They are served behind tenant authentication, so there is no anonymous feed URL to hand an ad platform yet.",
    "dev.curlTitle": "The same call from your code",
    "dev.curlLede": "The console above sends exactly this. Mint the key in the developer portal — it is never shown here.",
    "dev.keysOpen": "Open the developer portal",
    "dev.hooksTitle": "Webhook tester",
    "dev.hooksLede":
      "Endpoints subscribed to a SIGNAL event. A test ping is a signed delivery to the same URL your production traffic uses, and reports what came back.",
    "dev.hooksEmpty": "No endpoint subscribes to a Marketing event yet.",
    "dev.hooksEmpty.body": "Subscribe an endpoint to have Marketing events pushed to your systems as they happen.",
    "dev.hookUrl": "Endpoint",
    "dev.hookEvents": "Events",
    "dev.hookStatus": "State",
    "dev.hookCaption": "Endpoints subscribed to a Marketing event",
    "dev.hookTest": "Send a test ping",
    "dev.pingOk": "Delivered — {status}",
    "dev.pingFailed": "Not delivered",
    "dev.topicsTitle": "Events Marketing publishes",
    "dev.topicsLede":
      "Subscribe by name. The ones marked planned are named by the module spec, but nothing emits them yet — subscribing is not an error, the endpoint will simply never fire.",
    "dev.topicLive": "emitted",
    "dev.topicPlanned": "planned",
    "dev.sandboxTitle": "Sandbox ad platform",
    "dev.sandboxLede":
      "No live ad account is connected. This writes one day of synthetic spend across the running campaigns' channels, exactly as a platform sync would, so the cockpit, the bounds and the autopilot have something to read. Never available in production.",
    "dev.sandboxRun": "Tick a day of spend",
    "dev.sandboxDone": "{inserted} spend rows written.",
    "dev.denied": "Your role does not include reading Marketing records. Ask a tenant administrator for Marketing access.",
    "dev.saved.read": "Read.",
    "dev.saved.ping": "Ping sent.",
    "dev.saved.tick": "Sandbox ticked.",
    "dev.answer.ready": "{n} resource(s) you can read, {hooks} webhook(s) listening."
  },
  ar: {
    /* shared */
    approvalTitle: "بانتظار الموافقة",
    approvalBody: "هذا التغيير يحتاج مراجعة ثانية وفق السياسة {policy}. طلبك في قائمة الانتظار ولم يُفقد.",
    approvalLink: "فتح الموافقات",
    save: "حفظ",
    cancel: "إلغاء",
    saved: "تم الحفظ",
    channel: "القناة",
    campaign: "الحملة",
    spend: "الإنفاق",
    plan: "الخطة",
    binds: "التعاقدات",
    value: "القيمة",
    clicks: "النقرات",
    impressions: "مرات الظهور",
    conversions: "التحويلات",
    cac: "تكلفة الاستحواذ",
    ltv: "القيمة لكل عميل",
    multiple: "القيمة مقابل التكلفة",
    state: "الوضع",
    reason: "السبب",
    amount: "المبلغ",
    when: "الوقت",
    none: "لا توجد بيانات كافية بعد",
    noPermission: "دورك لا يشمل هذه الشاشة.",
    why: "السبب",
    audience: "الجمهور",
    autonomy: "الاستقلالية",
    bound: "سقف الحركة الواحدة",
    days: "{n} يوم",
    confirm: "أفهم أن هذا يغيّر حدود إنفاق الوكلاء",

    /* cockpit */
    "cockpit.title": "مركز قيادة النمو",
    "cockpit.lede": "ماذا حقّق الإنفاق في هذه الفترة، وما غيّره الوكلاء في غيابك.",
    "cockpit.answer.moved": "حرّك الطيار الآلي الميزانية {n} مرة (مرات) في هذه الفترة.",
    "cockpit.answer.overPlan": "الإنفاق يتجاوز الخطة بنسبة {n}٪ في هذه الفترة.",
    "cockpit.answer.running": "{n} حملة (حملات) تعمل الآن، ولم يُنفَّذ أي تحويل بعد.",
    "cockpit.answer.quiet": "لا شيء يعمل ولم يُنفَّذ أي تحويل في هذه الفترة.",
    "cockpit.spendToDate": "المنفق في هذه الفترة",
    "cockpit.againstPlan": "مقابل الخطة",
    "cockpit.pipeline": "المسار حسب القناة",
    "cockpit.pipelineCaption": "الإنفاق والنقرات والتعاقدات لكل قناة خلال الفترة",
    "cockpit.loop": "حلقة اكتساب العملاء",
    "cockpit.loopCaption": "الرسائل المُرسلة والعملاء المحتملون وثائق التأمين المُبرمة لكل حملة — الحلقة من الإنفاق إلى العميل",
    "cockpit.loopSends": "أُرسلت",
    "cockpit.loopLeads": "عملاء محتملون",
    "cockpit.runOutreach": "تشغيل التواصل الآن",
    "cockpit.noLoop": "لم تُرسل رسائل تواصل في هذه الفترة بعد.",
    "cockpit.noLoop.body": "لم يُرسل شيء إلى أي عميل هنا. تمتلئ الحلقة عندما تبدأ حملة بالإرسال.",
    "cockpit.scales": "ما الذي عاد",
    "cockpit.scalesCaption": "الردود والقراءات والتعاقدات من كل رسالة، لكل حملة ولكل جمهور ولكل شخص",
    "cockpit.scale.campaign": "الحملات",
    "cockpit.scale.audience": "الجماهير",
    "cockpit.scale.customer": "الأشخاص",
    "cockpit.read": "قُرئت",
    "cockpit.replied": "ردود",
    "cockpit.replyRate": "معدل الرد",
    "cockpit.optedOut": "ألغوا الاشتراك",
    "cockpit.signed": "تعاقدات",
    "cockpit.noResponses": "لم يعد شيء في هذه الفترة بعد.",
    "cockpit.noResponses.body": "تظهر الردود والقراءات وإلغاءات الاشتراك هنا بعد إرسال الرسائل.",
    "cockpit.closedLoop": "رسالة عبر {channel} لحملة {campaign} أصبحت وثيقة:",
    "cockpit.liveCampaigns": "تعمل الآن",
    "cockpit.liveCaption": "الحملات المباشرة أو المتوقفة مؤقتًا",
    "cockpit.changesToday": "ما غيّره الوكلاء",
    "cockpit.changesCaption": "تحويلات الميزانية التي نفّذها الطيار الآلي، الأحدث أولًا",
    "cockpit.noChanges": "لم ينفّذ الطيار الآلي أي تحويل في هذه الفترة.",
    "cockpit.noChanges.body": "لم يُنقل أي ميزانية أو عرض سعر. يسجّل الطيار الآلي كل خطوة ينفّذها هنا.",
    "cockpit.noCampaigns": "لا شيء يعمل حاليًا.",
    "cockpit.noCampaigns.body": "لا توجد حملة نشطة. أطلق واحدة من الاستوديو لتبدأ الوصول إلى الناس.",
    "cockpit.startOne": "افتح استوديو الحملات",
    "cockpit.autopilot": "الطيار الآلي",
    "cockpit.pause": "إيقاف الطيار الآلي مؤقتًا",
    "cockpit.resume": "استئناف الطيار الآلي",
    "cockpit.runNow": "ابحث عن تحويل الآن",
    "cockpit.paused": "متوقف مؤقتًا",
    "cockpit.running": "يعمل",
    "cockpit.adjusted": "نفّذ الطيار الآلي {n} تحويلًا.",
    "cockpit.movedBy": "نفّذه",
    "cockpit.trend": "الإنفاق اليومي",
    "cockpit.autopilotWhy":
      "يقارن الطيار الآلي تكلفة الاستحواذ بين القنوات خلال آخر سبعة أيام ويحوّل الميزانية نحو الأرخص، داخل سقف الحركة الواحدة لكل حملة.",
    "cockpit.openBudget": "الميزانية والحدود",
    "cockpit.openAnalytics": "تحليلات النمو",

    /* studio */
    "studio.title": "استوديو الحملات",
    "studio.lede": "قل ما تريد ولمن. النموذج يكتب المسودة، وأنت تحرّرها ثم تطلق الحملة.",
    "studio.step1": "الهدف",
    "studio.step2": "المحتوى",
    "studio.step3": "المراجعة",
    "studio.step4": "الإطلاق",
    "studio.step5": "مباشرة",
    "studio.name": "ما اسم هذه الحملة",
    "studio.objective": "ما الغرض منها",
    "studio.audienceHint": "من تصل إليه. اتركه فارغًا للوصول إلى الجميع.",
    "studio.audienceAll": "الجميع",
    "studio.channels": "أين تعمل",
    "studio.channelsHint": "اختر كل مكان يمكن للحملة الشراء فيه. ينقل الطيار الآلي الميزانية بين ما تختاره.",
    "studio.daily": "الميزانية اليومية",
    "studio.boundHint": "أقصى مبلغ يحوّله الطيار الآلي بين القنوات في قرار واحد.",
    "studio.owner": "من المسؤول عنها",
    "studio.ownerPick": "اختر زميلاً أو فريقاً",
    "studio.create": "ابدأ الحملة",
    "studio.created": "أُنشئت المسودة. أعطِ النموذج الآن موجزًا.",
    "studio.pool": "إلى مَن تصل، ولماذا",
    "studio.poolReach": "نحو {n} شخص في القاعدة",
    "studio.poolWhy": "اختير كل نطاق أدناه من القاعدة نفسها. والعدد هو كم عميلاً يقع فيه.",
    "studio.plan": "كيف يقترح النموذج تنفيذها",
    "studio.planHint": "ثلاث طرق للإنفاق، مرتّبة بحسب احتمال نجاحها في تقدير النموذج. المسودات أدناه مكتوبة للخيار المُوصى به.",
    "studio.planRecommended": "الخيار المُوصى به",
    "studio.planOffer": "العرض",
    "studio.planRisk": "ما قد يُفشلها",
    "studio.planNone": "لم يُقترح بعد أي أسلوب لهذه الحملة",
    "studio.planNoneHint": "حدّد ما تبيعه الحملة وسيصوغ النموذج ثلاث طرق للإنفاق، لكل منها احتمال نجاحها. وستُكتب المسودات بعد ذلك للخيار المُوصى به.",
    "studio.planSubject": "ماذا تبيع هذه الحملة؟",
    "studio.planSubjectHint": "خط تغطية، أو السيناريو الذي تفكر فيه.",
    "studio.planAction": "اقترح الخطة",
    "studio.planning": "جارٍ الاقتراح...",
    "studio.planConfidence": "نجت {n}% من الخيارات التي صاغها النموذج من التحقق.",
    "studio.planFallback": "لم يستجب النموذج. اشتُقّت هذه الخيارات من أرقام الطلب وحدها.",
    "studio.brief": "أخبر النموذج بما يقوله",
    "studio.briefHint": "العرض والنبرة وكل ما يجب أن يظهر. المسودة لك لتحرّرها.",
    "studio.kind": "نوع المحتوى",
    "studio.count": "عدد النسخ",
    "studio.locales": "اللغات",
    "studio.generate": "اكتب المحتوى",
    "studio.generating": "جارٍ الكتابة",
    "studio.generated": "{n} مسودة جاهزة للقراءة.",
    "studio.variants": "المسودات",
    "studio.noVariants": "لا مسودات بعد. أعطِ النموذج موجزًا أعلاه.",
    "studio.noVariants.body": "صِف ما تريد قوله ويصوغ النموذج بدائل تقارنها هنا.",
    "studio.editVariant": "حرّر هذه المسودة",
    "studio.approve": "اعتمد هذه المسودة",
    "studio.approved": "معتمدة",
    "studio.blockedNote": "حجب الامتثال هذه المسودة. حرّرها أو استبعدها.",
    "studio.discard": "استبعاد",
    "studio.launch": "أطلق الحملة",
    "studio.launchHint": "الإطلاق يصرف مالًا. يُسجَّل الأمر وقد يحتاج موافقًا.",
    "studio.launchBlocked": "اعتمد مسودة واحدة على الأقل قبل الإطلاق.",
    "studio.launched": "الحملة مباشرة الآن.",
    "studio.whyDraft": "كُتبت من موجزك وتعريف الجمهور وقواعد الامتثال لهذا النوع من المحتوى.",
    "studio.art": "كيف ستبدو",
    "studio.artHint": "الكلمات المعتمدة على هويتك. نزّل المقاس الذي تحتاجه.",
    "studio.template": "التخطيط",
    "studio.template.spotlight": "تسليط",
    "studio.template.split": "صورة وكلمات",
    "studio.template.quote": "اقتباس",
    "studio.template.offer": "عرض",
    "studio.template.clean": "بسيط",
    "studio.format.square": "منشور (1:1)",
    "studio.format.portrait": "منشور (4:5)",
    "studio.format.story": "قصة (9:16)",
    "studio.format.landscape": "بطاقة رابط",
    "studio.format.display": "مساحة إعلانية",
    "studio.format.leaderboard": "شريط",
    "studio.format.email": "ترويسة بريد",
    "studio.ctaDefault": "اعرف المزيد",
    "studio.svg": "تنزيل SVG",
    "studio.edit": "تعديل",
    "studio.canvasElement": "العنصر المراد ضبطه",
    "studio.canvasHint": "اسحب العنصر، أو حدده واستخدم مفاتيح الأسهم (مع Shift لخطوات أكبر)، و+ و− لتغيير الحجم، و0 لإعادته.",
    "studio.canvasSize": "الحجم",
    "studio.save": "حفظ التصميم",
    "studio.reset": "إعادة هذا المقاس",
    "studio.done": "تم",
    "studio.saved": "حُفظ التصميم.",
    "studio.png": "تنزيل PNG",
    "studio.contrast": "يصعب قراءة {slot} على لون هويتك ({ratio}:1، والمطلوب {required}:1). اختر تخطيطًا آخر أو عدّل اللون.",
    "studio.slot.headline": "العنوان",
    "studio.slot.body": "النص",
    "studio.slot.kicker": "العنوان الصغير",
    "studio.slot.cta": "الزر",
    "studio.fromOpportunity": "من فرصة رصدها السوق",
    "studio.image": "توليد صورة",
    "studio.imageHint": "صِف المشهد. يُعِدّ النموذج صورة رئيسية لهذه الحملة.",
    "studio.imagePrompt": "بم تظهر الصورة؟",
    "studio.imageGenerate": "توليد الصورة",
    "studio.imageGenerating": "جارٍ التوليد…",
    "studio.imageGenerated": "صورة جديدة جاهزة أدناه.",
    "studio.imageAlt": "صورة حملة مولَّدة بالذكاء الاصطناعي",
    category: "الفئة",
    demand: "الطلب المقدَّر",
    competition: "المنافسة",
    "studio.pickCampaign": "أو أكمل مسودة قائمة",
    "studio.open": "فتح",
    "studio.performance": "كيف تسير",
    "studio.performanceCaption": "الإنفاق والنتيجة لكل قناة منذ الإطلاق",
    "studio.noSpend": "لم يُسجَّل أي إنفاق بعد.",
    "studio.noSpend.body": "لم يكلّف شيء بعد. يظهر الإنفاق عند وضع بديل خلف حملة نشطة.",
    "studio.newCampaign": "ابدأ حملة جديدة",
    "studio.complianceNote": "ملاحظة الامتثال",
    "studio.pause": "أوقفها مؤقتًا",

    /* audience value */
    "aud.title": "الجماهير والقيمة",
    "aud.lede": "قيمة كل جمهور مقابل تكلفة الوصول إليه.",
    "aud.caption": "القيمة والتكلفة ومعدل التحويل لكل جمهور",
    "aud.size": "الحجم",
    "aud.reach": "حملات موجّهة إليه",
    "aud.conversion": "التحويل",
    "aud.best": "أفضل قيمة مقابل التكلفة",
    "aud.worst": "يخسر مالًا",
    "aud.totalValue": "إجمالي القيمة المتعاقدة",
    "aud.unmeasured": "لم توجّه أي حملة إلى هذا الجمهور بعد.",
    "aud.unmeasured.body": "تُقاس القيمة من الحملات التي استهدفت جمهوراً. وجّه حملة إلى هذا الجمهور ليظهر عائدها هنا.",
    "aud.thin": "التعاقدات أقل من أن يُعتمد عليها.",
    "aud.openAudiences": "إدارة الجماهير",
    "aud.answer.best": "{name} يتصدّر بمعدّل {multiple}.",
    "aud.answer.losing": "{n} جمهور يكلّف أكثر مما يعيد.",
    "aud.answer.none": "لا تعاقدات كافية بعد لمعرفة ما يُجدي.",
    "aud.suggestTitle": "اقتراح جمهور",
    "aud.suggestLede": "لا يرى النموذج سوى أعداد إجمالية فوق حد إخفاء الهوية ويقترح قاعدة عليها — لا يرى أي سجل عميل أبدًا.",
    "aud.suggestSubject": "الموضوع",
    "aud.suggestAction": "اقتراح الجمهور",
    "aud.suggestedPool": "المجموعة المقترحة حسب السمة",
    "aud.suggestedPoolX": "حصة من قاعدة العملاء",
    "aud.suggestedPoolY": "العدد الذي عُرض على النموذج",
    "aud.suggestedReach": "الوصول المقدّر",
    "aud.suggestedConfidence": "الثقة",
    "aud.suggestedSource": "المصدر",
    "aud.sourceAi": "النموذج",
    "aud.sourceFallback": "احتياطي حتمي",
    "aud.why": "لماذا هذه",

    /* answer engines */
    "aeo.title": "محرّكات الإجابة",
    "aeo.lede": "أي الأسئلة تجيب عنها، وهل تنقل عنك المحرّكات.",
    "aeo.caption": "صفحات الإجابات حسب المجموعة والحداثة والاقتباسات",
    "aeo.coverage": "المجموعات المغطّاة",
    "aeo.publishedPages": "منشورة",
    "aeo.citedPages": "مُقتبسة",
    "aeo.share": "نسبة الاقتباس",
    "aeo.stalePages": "تحتاج تحققًا",
    "aeo.cluster": "مجموعة الأسئلة",
    "aeo.citedBy": "نقل عنها",
    "aeo.freshness": "آخر تحقق",
    "aeo.never": "أبدًا",
    "aeo.markStale": "علّمها للتحقق",
    "aeo.publish": "نشر",
    "aeo.retire": "سحب",
    "aeo.noPages": "لا صفحات إجابات بعد.",
    "aeo.noPages.body": "صفحة الإجابة هي ما يقتبسه المساعد حين يسأل أحدهم عن منتجك. لم تُنشر أي صفحة بعد.",
    "aeo.openPages": "إدارة صفحات الإجابات",
    "aeo.answer.share": "{pct}% من الاقتباسات ترجع إليك.",
    "aeo.answer.none": "لا صفحات إجابات منشورة بعد.",
    "aeo.staleWarning": "{n} صفحة منشورة لم تُتحقّق منها خلال 30 يومًا.",

    /* experiments */
    "exp.title": "التجارب",
    "exp.lede": "كل اختبار أجريناه، وغرضه، وما انتهى إليه.",
    "exp.caption": "التجارب حسب الحالة والمقياس الذي تحرّكه",
    "exp.runningNow": "تعمل الآن",
    "exp.decidedCount": "محسومة",
    "exp.wonCount": "رابحة",
    "exp.hypothesis": "الفرضية",
    "exp.metric": "المقياس",
    "exp.state": "الحالة",
    "exp.arms": "الأذرع",
    "exp.sample": "العيّنة",
    "exp.verdict": "الحكم",
    "exp.concluded": "توقّفت",
    "exp.open": "فتح",
    "exp.none": "لا توجد تجارب بعد.",
    "exp.none.body": "تقسم التجربة الإنفاق بين تصميمين أو جمهورين وتُبلغ عن الفائز. ابدأ واحدة لتظهر هنا.",
    "exp.pending": "ما زالت مفتوحة",
    "exp.noWinner": "لا ذراع فائزة",
    "exp.noTarget": "لا هدف محدّد",
    "exp.state.draft": "مسودة",
    "exp.state.running": "قيد التشغيل",
    "exp.state.concluded": "منتهية",
    "exp.state.abandoned": "متروكة",
    "exp.verdict.won": "ربحت",
    "exp.verdict.lost": "خسرت",
    "exp.verdict.inconclusive": "غير حاسمة",
    "exp.verdict.abandoned": "أُسقطت",
    "exp.detail": "تفاصيل الاختبار",
    "exp.variants": "أذرع هذا الاختبار",
    "exp.variant": "الذراع",
    "exp.split": "حصة الزيارات",
    "exp.rate": "المعدّل",
    "exp.samples": "المشاهدات",
    "exp.control": "الضابطة",
    "exp.winner": "الفائز",
    "exp.uplift": "الفارق عن الضابطة",
    "exp.probability": "احتمال تفوّقها على الضابطة",
    "exp.boundary": "خط التوقّف عند 95٪",
    "exp.crossed": "تجاوزت الخط — اقرأها قرارًا.",
    "exp.notCrossed": "دون الخط — اقرأها ميلًا لا قرارًا.",
    "exp.stoppedBy": "أوقفها",
    "exp.note": "ما فعلناه بناءً عليها",
    "exp.reason": "سبب تركها",
    "exp.reach": "الجمهور الذي يمكن بلوغه",
    "exp.progress": "من أصل {n} مشاهدة",
    "exp.noReading": "لا قراءة بعد — ما زالت تجمع.",
    "exp.chart": "الاختبار التتابعي",
    "exp.chartHint": "القراءة عند التوقّف لا مسارها: اللقطات المرحلية لا تُحفظ.",
    "exp.decide": "سجّل القرار",
    "exp.decideHint": "إخراج الاختبار من التشغيل يكتب الحكم معه. التوقّف دون حكم يترك السجل غير مفهوم لاحقًا.",
    "exp.newState": "انقله إلى",
    "exp.verdictField": "الحكم النهائي",
    "exp.winnerField": "الذراع الفائزة",
    "exp.noteField": "ملاحظة للسجل",
    "exp.decideSaved": "سُجّل القرار.",
    "exp.new": "ابدأ اختبارًا",
    "exp.newHint": "ذراعان، ومقياس واحد، وعدد مشاهدات لن تتوقّف قبله.",
    "exp.hypothesisField": "ما تتوقّع حدوثه",
    "exp.metricField": "المقياس الذي تحرّكه",
    "exp.minSampleField": "لا تتوقّف قبل",
    "exp.campaignField": "الحملة (اختياري)",
    "exp.controlField": "اسم الذراع الضابطة",
    "exp.challengerField": "اسم الذراع المنافسة",
    "exp.create": "ابدأها",
    "exp.created": "أُنشئ الاختبار كمسودة.",
    "exp.unattached": "بلا حملة",
    "exp.metric.quote_start_rate": "معدّل بدء التسعير",
    "exp.metric.click_to_bind_rate": "معدّل التحوّل من نقرة إلى تعاقد",
    "exp.metric.renewal_accept_rate": "معدّل قبول التجديد",
    "exp.metric.aeo_citation_share": "نسبة الاقتباس في محرّكات الإجابة",
    "exp.answer.won": "{n} تجربة أثبتت جدواها بالفعل.",
    "exp.answer.running": "{n} تجربة تعمل الآن.",

    /* budget */
    "budget.title": "الميزانية والحدود",
    "budget.lede": "سقف الإنفاق، وإلى أي حد يحرّكه الوكلاء دون سؤال.",
    "budget.ceiling": "السقف",
    "budget.used": "المنفق",
    "budget.perCampaign": "لكل حملة",
    "budget.caption": "الميزانية اليومية وسقف الحركة والاستقلالية لكل حملة",
    "budget.setBounds": "تغيير الحدود",
    "budget.boundsSaved": "تم تحديث الحدود.",
    "budget.daily": "الميزانية اليومية",
    "budget.autonomyHint": "يسأل أولًا، أو ينفّذ ثم يبلّغ، أو ينفّذ وحده.",
    "budget.moves": "التحويلات المنفّذة",
    "budget.movesCaption": "كل تحويل ميزانية، ومن أجازه، وهل ما زال قابلًا للعكس",
    "budget.reverse": "اعكس هذا التحويل",
    "budget.reversed": "معكوس",
    "budget.reverseWindow": "قابل للعكس حتى",
    "budget.reverseHint": "عكس التحويل يعيد المال إلى مصدره. يُسجَّل الأمر.",
    "budget.noMoves": "لا تحويلات بعد.",
    "budget.noMoves.body": "يُسجَّل هنا كل تحويل بين الحملات، سواء نفّذته أنت أو الطيار الآلي.",
    "budget.expired": "انتهت مدة عكس هذا التحويل.",
    "budget.pickCampaign": "أي حملة",
    "budget.headroom": "المتبقي",
    "budget.overspend": "تجاوز الخطة",
    "budget.autoApproved": "داخل حدوده",
    "budget.needsApproval": "احتاج موافقًا",
    "budget.answer.over": "{amount} تجاوزًا للخطة في هذه الفترة.",
    "budget.answer.under": "{amount} متبقٍّ في هذه الفترة.",

    /* analytics */
    "growth.title": "تحليلات النمو",
    "growth.lede": "التكلفة والقيمة ومن أين جاء العملاء فعلًا.",
    "growth.blended": "متوسط تكلفة الاستحواذ",
    "growth.blendedLtv": "متوسط القيمة لكل عميل",
    "growth.ratio": "القيمة مقابل التكلفة",
    "growth.ratioHint": "ثلاثة أو أكثر يعني عملًا يقدر على النمو.",
    "growth.attribution": "من أين جاؤوا",
    "growth.attributionCaption": "الإنفاق والتعاقدات وتكلفة الاستحواذ حسب القناة",
    "growth.cohorts": "العائدون",
    "growth.cohortsCaption": "العملاء حسب شهر أول تعاقد، وكم منهم عاد",
    "growth.cohort": "أول تعاقد",
    "growth.size": "العملاء",
    "growth.retained": "عادوا",
    "growth.retention": "نسبة العودة",
    "growth.export": "تصدير",
    "growth.exportHint": "سجل الإنفاق لهذه الفترة، كملف.",
    "growth.format": "الصيغة",
    "growth.exportReady": "ملفك جاهز",
    "growth.download": "تنزيل",
    "growth.exportQueued": "جارٍ بناء الملف. أعد التحميل بعد لحظات.",
    "growth.window": "الفترة",
    "growth.last7": "آخر 7 أيام",
    "growth.last30": "آخر 30 يومًا",
    "growth.last90": "آخر 90 يومًا",
    "growth.noCohorts": "لا توجد مجموعة لها سجل كافٍ بعد.",
    "growth.noCohorts.body": "تحتاج المجموعة إلى عملاء مكتسبين في فترة ووقت كافٍ بعدها للقياس. وسّع الفترة.",
    "growth.noSpend": "لا إنفاق مسجّل في هذه الفترة.",
    "growth.noSpend.body": "لم يُنفق شيء في هذه الفترة. وسّع الفترة، أو ابدأ حملة لترى التكلفة مقابل العائد.",
    "growth.efficiency": "تكلفة النقرة",
    "growth.answer.ratio": "{multiple} قيمة مقابل كل وحدة تُنفق.",
    "growth.answer.none": "لا تعاقدات كافية بعد لتقدير العائد.",
    xlsx: "إكسل",
    pdf: "بي دي إف",
    csv: "سي إس في",
    json: "جيسون",
    "autonomy.suggest": "يقترح فقط",
    "autonomy.draft": "يكتب مسودة دون إرسال",
    "autonomy.act_with_approval": "ينفّذ بموافقة",
    "autonomy.act": "ينفّذ وحده",
    "autonomy.act_and_report": "ينفّذ ويبلّغ",
    acq: "استقطاب عملاء جدد",
    renewal: "الحفاظ على العملاء",
    xsell: "بيع المزيد للعملاء",
    draft: "مسودة",
    review: "قيد المراجعة",
    scheduled: "مجدولة",
    live: "مباشرة",
    paused: "متوقفة مؤقتًا",
    ended: "منتهية",
    ad: "إعلان",
    lp: "صفحة هبوط",
    email: "بريد إلكتروني",
    social: "منشور اجتماعي",
    video_script: "نص فيديو",
    image: "صورة",
    pending: "لم تُفحص بعد",
    passed: "معتمدة",
    flagged: "مُعلَّمة",
    blocked: "محظورة",
    published: "منشورة",
    stale: "تحتاج تحققًا",
    retired: "مسحوبة",
    "locale.en": "الإنجليزية",
    "locale.ar": "العربية",

    /* refusals */
    "problem.bad_intent": "أرسل هذا الزر أمرًا لا تنفّذه هذه الشاشة.",
    "problem.campaign_required": "اختر حملة أولًا.",
    "problem.budget_required": "أدخل ميزانية يومية.",
    "problem.bound_required": "أدخل سقفًا للحركة الواحدة.",
    "problem.bound_over_daily": "سقف الحركة الواحدة لا يجوز أن يتجاوز الميزانية اليومية.",
    "problem.autonomy_required": "حدّد ما يجوز للوكلاء فعله وحدهم.",
    "problem.confirm_required": "علّم خانة التأكيد قبل تغيير الحدود.",
    "problem.move_required": "اختر التحويل المطلوب عكسه.",
    "problem.actor_required": "لا بد من تسجيل العكس باسم شخص.",
    "problem.name_required": "أعطِ الحملة اسمًا.",
    "problem.objective_required": "بيّن الغرض من الحملة.",
    "problem.owner_required": "حدّد المسؤول عن هذه الحملة.",
    "problem.channels_required": "اختر مكانًا واحدًا على الأقل لتشغيلها.",
    "problem.brief_required": "اكتب جملة على الأقل ليعمل النموذج عليها.",
    "problem.kind_required": "اختر نوع المحتوى المطلوب كتابته.",
    "problem.creative_required": "هذه المسودة لم تبقَ على الشاشة. أعد التحميل.",
    "problem.content_required": "لا يمكن حفظ مسودة فارغة.",
    "problem.status_required": "اختر الوضع الذي تنقل الصفحة إليه.",
    "problem.page_required": "اختر صفحة إجابة أولًا.",
    "problem.format_required": "اختر صيغة الملف.",
    "problem.experiment_required": "اختر اختبارًا أولًا.",
    "problem.state_required": "اختر الحالة التي تنقل الاختبار إليها.",
    "problem.verdict_required": "سجّل الحكم عند إيقاف الاختبار.",
    "problem.hypothesis_required": "اكتب ما تتوقّع حدوثه.",
    "problem.metric_required": "حدّد المقياس المقاس.",
    "problem.arms_required": "سمِّ الذراعين.",
    "problem.resource_required": "اختر السجلات المطلوب قراءتها.",
    "problem.limit_required": "اطلب بين صف واحد ومئة صف.",
    "problem.hook_required": "اختر نقطة النهاية المطلوب اختبارها.",
    "problem.subject_required": "بيّن الغرض من هذا الجمهور.",

    /* admin */
    "admin.title": "إدارة Marketing",
    "admin.lede": "العلامة والادعاءات والسقوف والقوائم التي يُقاس عليها كل ما يُرسل من هنا.",
    "admin.denied": "دورك لا يشمل إعدادات Marketing.",
    "admin.readyTitle": "لا شيء معطّل.",
    "admin.readyBody": "كل حملة تعمل اجتازت فحوصها، ولكل وكيل ينفق سقف، وكل جمهور يطرح قائمة استبعاد.",
    "admin.fault.unchecked": "تصل إلى الناس دون أن تجتاز فحص العلامة والادعاءات ولو مرة.",
    "admin.fault.bannedClaims": "تعمل وفحص الادعاءات لم يُجتَز.",
    "admin.fault.brandKit": "تعمل وفحص العلامة لم يُجتَز.",
    "admin.fault.noSuppressionApplied": "تعمل دون طرح قائمة الاستبعاد.",
    "admin.fault.unbounded": "الوكلاء يتصرفون فيها بلا سقف لكل حركة يوقفهم.",
    "admin.fault.noSuppressionSource": "لا توجد قائمة استبعاد، فلا أحد يُستبعد.",
    "admin.fault.noExclusion": "هذا الجمهور لا يطرح أي قائمة استبعاد.",
    "admin.answer.faults": "{n} أمر يحتاج انتباهًا.",
    "admin.brandTitle": "هوية العلامة",
    "admin.brandLede": "الاسم والشعار واللون الذي تُكتب وتُعرض به كل المسودات.",
    "admin.brandName": "اسم المنتج",
    "admin.brandAccent": "لون التمييز",
    "admin.brandLogos": "الشعارات المتوفرة",
    "admin.brandDefault": "الافتراضي للمنصة",
    "admin.brandEdit": "تحرير هوية العلامة",
    "admin.brandHint": "الإعدادات تملك هذا، وتتحقق من تباين اللون قبل الحفظ.",
    "admin.guardTitle": "الضوابط والادعاءات الممنوعة",
    "admin.guardLede": "ما فُحصت عليه كل حملة، ومتى كان آخر فحص.",
    "admin.guardCaption": "فحوص الضوابط لكل حملة",
    "admin.guardEmpty": "لا توجد حملة بعد.",
    "admin.guardEmpty.body": "تُطبَّق الضوابط لكل حملة، فتمتلئ هذه القائمة عند وجود أول حملة.",
    "admin.guardNone": "لم تُفحص قط",
    "admin.claims": "الادعاءات",
    "admin.brandCheck": "العلامة",
    "admin.suppressionApplied": "الاستبعاد",
    "admin.cap": "سقف التكرار",
    "admin.capValue": "{n} أسبوعيًا",
    "admin.quiet": "ساعات الهدوء",
    "admin.checkedAt": "آخر فحص",
    "admin.pass": "اجتاز",
    "admin.fail": "لم يجتز",
    "admin.applied": "مطبّق",
    "admin.notApplied": "غير مطبّق",
    "admin.boundsTitle": "حدود الميزانية والموافقات",
    "admin.boundsLede": "إلى أي مدى يمضي الوكلاء وحدهم، وما الذي ينتظر إنسانًا.",
    "admin.boundsCaption": "الميزانية اليومية وسقف الحركة ومستوى الاستقلالية لكل حملة",
    "admin.boundsEmpty": "لا توجد حملة بعد.",
    "admin.boundsEmpty.body": "تُحدَّد حدود الإنفاق لكل حملة، فتمتلئ هذه القائمة عند وجود أول حملة.",
    "admin.noBound": "بلا سقف",
    "admin.paused": "الطيار الآلي متوقف للمستأجر بأكمله.",
    "admin.running": "الطيار الآلي يعمل.",
    "admin.boundsEdit": "تغيير الحدود",
    "admin.policyTitle": "عتبات الموافقة",
    "admin.policyLede": "القرارات التي لا تتخذها Marketing وحدها، ومن يحق له اتخاذها.",
    "admin.policyCaption": "سياسات موافقة Marketing",
    "admin.policyKey": "القرار",
    "admin.policyDecide": "صلاحية المُوافِق",
    "admin.policyDual": "مراجعة ثانية",
    "admin.policyThreshold": "فوق",
    "admin.policyAuto": "يوافقت عليه هذه المؤسسة تلقائيًا",
    "admin.dual.never": "غير مطلوبة",
    "admin.dual.above_threshold": "فوق العتبة",
    "admin.dual.always": "دائمًا",
    "admin.policy.signal.budget_move": "نقل ميزانية بين الحملات",
    "admin.policy.signal.campaign_launch": "إطلاق حملة",
    "admin.policy.signal.creative_publish": "نشر مادة إبداعية",
    "admin.policy.signal.budget_commit": "الالتزام بإنفاق",
    "admin.policy.signal.boost": "تعزيز حملة قائمة",
    "admin.policy.signal.creator_brief": "إرسال موجز لصانع محتوى",
    "admin.policyEdit": "فتح الموافقات",
    "admin.suppressionTitle": "مصادر الاستبعاد",
    "admin.suppressionLede": "من يُستبعد من كل إرسال، وأي الجماهير تطرحهم.",
    "admin.suppressionCaption": "الجماهير وأساس الموافقة والقائمة التي يطرحها كل منها",
    "admin.suppressionEmpty": "لا يوجد جمهور بعد.",
    "admin.suppressionEmpty.body": "يمنع الاستبعاد جمهوراً من حملة. أنشئ جمهوراً أولاً ثم استبعده هنا.",
    "admin.audienceName": "الجمهور",
    "admin.consent": "أساس الموافقة",
    "admin.excludes": "يطرح",
    "admin.isSuppression": "قائمة استبعاد",
    "admin.size": "الحجم",
    "admin.refresh": "آخر تحديث",
    "admin.suppressionEdit": "تحرير الجماهير",
    "admin.discTitle": "صيغ الإفصاح",
    "admin.discLede": "الصيغ المعروضة على العملاء لكل خط وقناة. السجل هو ما عُرض فعلًا، ولا يُعدّل لاحقًا.",
    "admin.discCaption": "صيغ الإفصاح المستخدمة",
    "admin.discEmpty": "لم يُعرض أي إفصاح بعد.",
    "admin.discEmpty.body": "تُسجَّل الإفصاحات لحظة عرضها على العميل، فلا يظهر شيء قبل بدء التواصل.",
    "admin.discKey": "الصيغة",
    "admin.discLocale": "اللغة",
    "admin.discChannel": "القناة",
    "admin.discCount": "مرات العرض",
    "admin.discEdit": "فتح سجل الإفصاح",
    "admin.gapTitle": "غير مهيّأ هنا بعد",
    "admin.gapLede": "أمران تطلبهما المواصفة من هذه الشاشة لا مكان لتخزينهما بعد، فلا تدّعي الشاشة أنها تحفظهما.",
    "admin.gapChannels": "ربط القنوات. لا يوجد نموذج لتفويض حسابات الإعلانات — الحملات تسمي قنواتها كرموز ويُسجَّل الإنفاق عليها، لكن لا يُحفظ أي اعتماد.",
    "admin.gapUtm": "مخطط UTM. تُوسم روابط الحملات بمن يبنيها، ولا يوجد نمط موحّد على مستوى المؤسسة يُفرض.",

    /* dev */
    "dev.title": "مطوّرو Marketing",
    "dev.kicker": "منضدة المتكامِل",
    "dev.lede":
      "اقرأ ما يخزّنه SIGNAL فعلًا، واختبر نقطة ويب هوك، وحرّك يومًا من إنفاق بيئة التجربة. لا شيء هنا محاكاة — كل وحدة تنادي نفس نقطة النهاية التي سينادينها كودك.",
    "dev.readTitle": "وحدة القراءة",
    "dev.readLede":
      "كل سجل في SIGNAL قائمة REST تحت /v1/signal. اختر واحدة وشاهد ما سيعود إلى كودك بالضبط. لا تُعرض إلا السجلات التي يسمح دورك بقراءتها.",
    "dev.resource": "السجلات",
    "dev.limit": "عدد الصفوف",
    "dev.limitHint": "بين 1 و100.",
    "dev.read": "اقرأ السجلات",
    "dev.rows": "الصفوف المُعادة",
    "dev.raw": "جسم الاستجابة",
    "dev.readEmpty": "هذه القائمة فارغة لهذه المؤسسة. لا شيء معطّل — لم يُكتب شيء بعد.",
    "dev.readEmpty.body": "استخدم أدوات الكتابة في هذه الصفحة أو الواجهة البرمجية لإدخال أول سجل.",
    "dev.res.audiences": "الجماهير",
    "dev.res.campaigns": "الحملات",
    "dev.res.creatives": "المواد الإبداعية",
    "dev.res.signal-experiments": "الاختبارات",
    "dev.res.budget-moves": "تحويلات الميزانية",
    "dev.res.aeo-pages": "صفحات الإجابة",
    "dev.res.attribution-events": "لمسات الإسناد",
    "dev.res.spend": "سجل الإنفاق",
    "dev.pixelTitle": "التحقق من وصول لمسة",
    "dev.pixelLede":
      "لا يوجد بكسل أو وسم يُركّب في المتصفح. يسجّل SIGNAL اللمسة على الخادم حين يقول حدث وحدة إنها وقعت — الربط يكتب واحدة في النداء نفسه — فطريقة تتبّع الإسناد هي قراءة اللمسات. السجل للإلحاق فقط ولا منفذ إدخال له، فلا شيء خارج المنصة يستطيع الكتابة فيه.",
    "dev.feedTitle": "تغذيات الكتالوج",
    "dev.feedLede":
      "صفحات الإجابة هي الكتالوج الذي ينشره SIGNAL، والوحدة أعلاه تقرأها. تُقدَّم خلف مصادقة المؤسسة، فلا يوجد بعد رابط تغذية مجهول يُسلَّم لمنصة إعلانات.",
    "dev.curlTitle": "النداء نفسه من كودك",
    "dev.curlLede": "الوحدة أعلاه ترسل هذا بالضبط. أصدر المفتاح من بوابة المطوّرين — لا يُعرض هنا أبدًا.",
    "dev.keysOpen": "افتح بوابة المطوّرين",
    "dev.hooksTitle": "اختبار الويب هوك",
    "dev.hooksLede":
      "نقاط النهاية المشتركة في حدث من SIGNAL. الاختبار تسليم موقّع إلى نفس الرابط الذي يستقبل حركة الإنتاج، ويُبلّغ بما عاد منه.",
    "dev.hooksEmpty": "لا نقطة نهاية مشتركة في حدث من Marketing بعد.",
    "dev.hooksEmpty.body": "اشترك بنقطة نهاية لتُدفع إليها أحداث Marketing فور وقوعها.",
    "dev.hookUrl": "نقطة النهاية",
    "dev.hookEvents": "الأحداث",
    "dev.hookStatus": "الحالة",
    "dev.hookCaption": "نقاط النهاية المشتركة في حدث من Marketing",
    "dev.hookTest": "أرسل اختبارًا",
    "dev.pingOk": "وصل — {status}",
    "dev.pingFailed": "لم يصل",
    "dev.topicsTitle": "الأحداث التي ينشرها Marketing",
    "dev.topicsLede":
      "اشترك بالاسم. المعلَّمة بـ«مخطّط لها» تسمّيها مواصفة الوحدة لكن لا شيء يطلقها بعد — الاشتراك بها ليس خطأ، لكن نقطة النهاية لن تُنادى.",
    "dev.topicLive": "يُطلق",
    "dev.topicPlanned": "مخطّط له",
    "dev.sandboxTitle": "منصة إعلانات تجريبية",
    "dev.sandboxLede":
      "لا حساب إعلانات حقيقي مربوط. هذا يكتب يومًا من الإنفاق الاصطناعي على قنوات الحملات العاملة، تمامًا كما تفعل مزامنة المنصة، ليجد المركز والحدود والطيّار الآلي ما يقرأونه. غير متاح في الإنتاج أبدًا.",
    "dev.sandboxRun": "حرّك يوم إنفاق",
    "dev.sandboxDone": "كُتب {inserted} صفًا من الإنفاق.",
    "dev.denied": "لا يشمل دورك قراءة سجلات Marketing. اطلب من مدير المؤسسة صلاحية Marketing.",
    "dev.saved.read": "تمت القراءة.",
    "dev.saved.ping": "أُرسل الاختبار.",
    "dev.saved.tick": "حُرّكت بيئة التجربة.",
    "dev.answer.ready": "{n} مورد يمكنك قراءته، و{hooks} واجهة استدعاء تستمع."
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

/**
 * The labeller for every SIGNAL screen. The domain pack answers first (CLAUDE.md
 * §14) so a retail tenant's nouns land here too, then the local table, then the
 * key itself — a missing label renders as its key rather than as nothing.
 */
export function labelsIn(locale: string, pack?: string): Label {
  const table = LABELS[locale] ?? LABELS.en!;
  const fallback = LABELS.en!;
  const word = vocabulary(pack, locale);
  return (key, vars) => {
    const text = pseudoText(locale, word(key) ?? table[key] ?? fallback[key] ?? key);
    return vars ? text.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole) : text;
  };
}

/** The keys the label table answers, for the parity test. */
export const LABEL_KEYS = LABELS;

/**
 * A refusal with a sentence in front of it. The action returns machine codes so
 * the tests and the log can assert on them; `Gate` renders `title`, so the title
 * is swapped for the actor's language when this screen knows the code. Anything
 * from the API keeps its own title.
 */
export function explain(problem: Problemish, l: Label): Problemish {
  const key = problem.code ? `problem.${problem.code}` : "";
  return key && LABELS.en![key] ? { ...problem, title: l(key) } : problem;
}

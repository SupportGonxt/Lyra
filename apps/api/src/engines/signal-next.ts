import { and, desc, eq, gte } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { METRIC_TOUCHES } from "./signal-experiment.js";

// docs/modules/signal.md §4.1 and the module's own brief: SIGNAL is meant to be
// *aware* and to *suggest*, not to be a set of forms that wait. Until this file
// the operator had to know which of eleven tabs to open and what to look for
// when they got there.
//
// The shape is deliberate. `suggestNext` is a **pure function over a gathered
// snapshot** — no database, no clock — so every rule is unit-tested against a
// fixture rather than against a seeded world, and the reading and the reasoning
// can never drift. `gatherNext` is the only part that queries.
//
// Two properties each suggestion must have, because a suggestion without them is
// nagging:
//   - **`why` names the figures that produced it.** "No bound is set" is an
//     assertion; "campaign X has been live 12 days with no autopilot bound, so
//     the autopilot is using its 1 000 AED default" is a reading.
//   - **`action` goes where the work is**, with the permission that screen
//     gates on, so a suggestion is never a door into a 403.

export type SuggestionKind =
  | "whitespace"
  | "creative"
  | "publish"
  | "budget"
  | "audience"
  | "experiment"
  | "aeo"
  | "spend"
  | "governance";

export type Urgency = "now" | "soon" | "when-you-can";

export interface Suggestion {
  /** Stable id — `rule:subject` — so a dismissal can be remembered later. */
  key: string;
  kind: SuggestionKind;
  urgency: Urgency;
  /** The action, in the imperative. */
  title: string;
  /** The reading behind it, with the figures that produced it. */
  why: string;
  /** The raw figures, for a screen that wants to show its work. */
  evidence: Record<string, unknown>;
  /** Where to do it, and the permission that screen needs. */
  action: { href: string; labelKey: string; permission: string } | null;
}

const URGENCY_ORDER: Record<Urgency, number> = { now: 0, soon: 1, "when-you-can": 2 };

/** The freshness window a published answer page is given before it needs re-checking. */
export const AEO_STALE_DAYS = 30;

/** Days a campaign may run unbounded before it is worth saying so. */
export const UNBOUNDED_GRACE_DAYS = 3;

/** Samples a query needs before "we are never cited" is a finding rather than noise. */
export const AEO_LOSING_MIN_SAMPLES = 3;

/* ------------------------------------------------------------------ input */

export interface NextCampaign {
  id: string;
  name: string;
  state: string;
  budgetJson: string;
  audienceId: string | null;
  holdout: boolean;
  startAt: number | null;
}
export interface NextCreative {
  id: string;
  campaignId: string | null;
  locale: string;
  complianceStatus: string;
}
export interface NextPublish {
  creativeId: string;
  status: string;
}
export interface NextWhitespace {
  id: string;
  description: string;
  status: string;
  demandEstimate: number | null;
}
export interface NextAeoPage {
  id: string;
  queryCluster: string;
  status: string;
  /** Null when the page was published without a freshness stamp — which is why
   *  the stale rule treats it as due rather than as fresh. */
  freshness: number | null;
}
export interface NextCitation {
  pageId: string | null;
  cited: boolean;
}
export interface NextAudience {
  id: string;
  name: string;
  consentPurposes: string;
  sizeCached: number | null;
}
export interface NextExperiment {
  id: string;
  hypothesis: string;
  metric: string;
  state: string;
}

export interface NextInput {
  now: number;
  campaigns: readonly NextCampaign[];
  creatives: readonly NextCreative[];
  publishes: readonly NextPublish[];
  whitespaces: readonly NextWhitespace[];
  aeoPages: readonly NextAeoPage[];
  citations: readonly NextCitation[];
  audiences: readonly NextAudience[];
  experiments: readonly NextExperiment[];
  /** Days in the window spend was read over; null when nothing was recorded. */
  spendDaysWithData: number;
  /** Configured `aeo` assistants — with none, citation share cannot be measured. */
  assistants: number;
  /** Whether the tenant has a brand kit on file. */
  kitConfigured: boolean;
}

/* ------------------------------------------------------------------ rules */

function budgetOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const live = (campaigns: readonly NextCampaign[]) => campaigns.filter((c) => c.state === "live");

const STUDIO = { href: "/signal/studio", labelKey: "signal.next.openStudio", permission: "signal:campaigns:update" };
const BUDGET = { href: "/signal/budget", labelKey: "signal.next.openBudget", permission: "signal:budget_moves:read" };
const AEO = { href: "/signal/answer-engines", labelKey: "signal.next.openAeo", permission: "signal:aeo:read" };
const AUDIENCES = { href: "/signal/audiences", labelKey: "signal.next.openAudiences", permission: "signal:audiences:read" };
const EXPERIMENTS = { href: "/signal/experiments", labelKey: "signal.next.openExperiments", permission: "signal:experiments:read" };
const ADMIN = { href: "/signal/admin", labelKey: "signal.next.openAdmin", permission: "signal:campaigns:read" };

/**
 * What to do next, worst first.
 *
 * Ordered by urgency and then by `key`, so the order is stable between two reads
 * of the same data — a list that reshuffles itself every time an operator looks
 * at it teaches them to ignore it.
 */
export function suggestNext(input: NextInput): Suggestion[] {
  const out: Suggestion[] = [];
  const running = live(input.campaigns);
  const days = (at: number | null) => (at === null ? 0 : Math.max(0, Math.floor((input.now - at) / 86_400_000)));

  /* --------------------------------------------------- whitespace (SCOUT) */
  // A validated opportunity with no campaign behind it is the one SIGNAL signal
  // that is purely upside: SCOUT has already done the work of arguing it.
  const campaignNames = new Set(input.campaigns.map((c) => c.name));
  for (const w of input.whitespaces) {
    if (w.status !== "validated") continue;
    if (campaignNames.has(w.description)) continue;
    out.push({
      key: `whitespace:${w.id}`,
      kind: "whitespace",
      urgency: "now",
      title: `Plan a campaign for "${w.description}"`,
      why:
        `SCOUT validated this opportunity${w.demandEstimate !== null ? ` with a demand estimate of ${w.demandEstimate}` : ""} and no campaign names it yet. ` +
        "A validated whitespace is the cheapest demand there is: somebody else already proved it exists.",
      evidence: { whitespaceId: w.id, demandEstimate: w.demandEstimate, category: null },
      action: STUDIO
    });
  }

  /* ------------------------------------------------------- creatives */
  for (const campaign of running) {
    const mine = input.creatives.filter((c) => c.campaignId === campaign.id);
    const passed = mine.filter((c) => c.complianceStatus === "passed");
    if (mine.length === 0 || passed.length === 0) {
      out.push({
        key: `creative:unpublishable:${campaign.id}`,
        kind: "creative",
        urgency: "now",
        title: `"${campaign.name}" is live with nothing it can publish`,
        why:
          mine.length === 0
            ? `The campaign has run ${days(campaign.startAt)} days with no creative at all, so every impression it buys lands on nothing.`
            : `All ${mine.length} of its variants are ${[...new Set(mine.map((c) => c.complianceStatus))].join("/")}, and only a passed variant can be published.`,
        evidence: { campaignId: campaign.id, creatives: mine.length, passed: passed.length },
        action: STUDIO
      });
    }
  }

  const flagged = input.creatives.filter((c) => c.complianceStatus === "flagged");
  if (flagged.length) {
    out.push({
      key: "creative:flagged",
      kind: "creative",
      urgency: "soon",
      title: `${flagged.length} variant${flagged.length === 1 ? "" : "s"} waiting on a compliance decision`,
      why:
        "A flagged variant is neither publishable nor dead: a reviewer has to clear it or block it. Until then it is a generation that cost money and is doing nothing.",
      evidence: { flagged: flagged.length },
      action: STUDIO
    });
  }

  /* --------------------------------------------------------- publishing */
  // The publish path exists (signal-publish.ts); a passed variant nobody placed
  // is the last mile of the acceptance criterion, not a completed job.
  const placedOk = new Set(input.publishes.filter((p) => p.status === "published").map((p) => p.creativeId));
  const readyToPublish = input.creatives.filter((c) => c.complianceStatus === "passed" && !placedOk.has(c.id));
  const liveIds = new Set(running.map((c) => c.id));
  const publishableNow = readyToPublish.filter((c) => c.campaignId !== null && liveIds.has(c.campaignId));
  if (publishableNow.length) {
    out.push({
      key: "publish:ready",
      kind: "publish",
      urgency: "soon",
      title: `${publishableNow.length} cleared variant${publishableNow.length === 1 ? "" : "s"} not on any platform`,
      why:
        "Cleared copy that has not been published is finished work sitting still. Publishing creates the ad paused, so nothing spends until somebody turns it on.",
      evidence: { cleared: publishableNow.length },
      action: STUDIO
    });
  }

  /* -------------------------------------------------------------- budget */
  for (const campaign of running) {
    if (campaign.holdout) continue;
    const budget = budgetOf(campaign.budgetJson);
    const bound = budget.autopilotBoundMinor;
    const age = days(campaign.startAt);
    if (typeof bound !== "number" && age >= UNBOUNDED_GRACE_DAYS) {
      out.push({
        key: `budget:unbounded:${campaign.id}`,
        kind: "budget",
        urgency: "soon",
        title: `Set an autopilot bound on "${campaign.name}"`,
        why:
          `Live ${age} days with no \`autopilotBoundMinor\`, so the autopilot falls back to its 1 000 AED default and may move money on a campaign nobody bounded on purpose.`,
        evidence: { campaignId: campaign.id, daysLive: age, defaultBoundMinor: 100_000 },
        action: BUDGET
      });
    }
  }

  /* --------------------------------------------------------- governance */
  // Consent is the one audience property that can invalidate a campaign after it
  // is running, so a mismatch is `now` rather than a note.
  const byId = new Map(input.audiences.map((a) => [a.id, a]));
  for (const campaign of running) {
    const audience = campaign.audienceId ? byId.get(campaign.audienceId) : undefined;
    if (!audience) continue;
    const purposes = audience.consentPurposes.split(",").map((p) => p.trim().toLowerCase());
    if (!purposes.includes("marketing")) {
      out.push({
        key: `audience:consent:${campaign.id}`,
        kind: "audience",
        urgency: "now",
        title: `"${campaign.name}" targets an audience without marketing consent`,
        why:
          `Audience "${audience.name}" is built on ${audience.consentPurposes || "no purposes"}, which does not include marketing. ` +
          "The send gate re-checks consent per person, so the campaign will draft and then drop — spend with no contact.",
        evidence: { campaignId: campaign.id, audienceId: audience.id, purposes: audience.consentPurposes },
        action: AUDIENCES
      });
    }
  }

  if (running.length > 0 && !input.kitConfigured) {
    out.push({
      key: "governance:no-kit",
      kind: "governance",
      urgency: "when-you-can",
      title: "Configure the brand kit and banned claims",
      why:
        `${running.length} campaign${running.length === 1 ? "" : "s"} are live with no brand kit on file, so the pre-flight runs on its built-in rules alone and every launch records ` +
        "`brandKit: not-configured`. The built-ins never stop running; what is missing is the tenant's own list.",
      evidence: { liveCampaigns: running.length },
      action: ADMIN
    });
  }

  /* -------------------------------------------------------------- insights */
  if (running.some((c) => !c.holdout) && input.spendDaysWithData === 0) {
    out.push({
      key: "spend:missing",
      kind: "spend",
      urgency: "soon",
      title: "No ad spend recorded, so CAC has no denominator",
      why:
        "Acquisition cost is spend divided by the policies it won. With no spend on file the autopilot and the cockpit are reading a cost of nothing, and every efficiency claim is unfalsifiable.",
      evidence: { liveCampaigns: running.length },
      action: ADMIN
    });
  }

  /* ----------------------------------------------------------- experiments */
  for (const experiment of input.experiments) {
    if (experiment.state !== "running") continue;
    if (METRIC_TOUCHES[experiment.metric]) continue;
    out.push({
      key: `experiment:uncountable:${experiment.id}`,
      kind: "experiment",
      urgency: "soon",
      title: "An experiment cannot conclude on its metric",
      why:
        `"${experiment.hypothesis}" is running on metric \`${experiment.metric}\`, which this engine cannot count ` +
        `(it counts ${Object.keys(METRIC_TOUCHES).join(", ")}). It will stay running forever, so the test is a standing cost with no answer.`,
      evidence: { experimentId: experiment.id, metric: experiment.metric },
      action: EXPERIMENTS
    });
  }

  /* ------------------------------------------------------------------ AEO */
  const pages = input.aeoPages.filter((p) => p.status === "published");
  if (pages.length > 0 && input.assistants === 0) {
    out.push({
      key: "aeo:no-assistant",
      kind: "aeo",
      urgency: "soon",
      title: "Answer-engine share is unmeasured",
      why:
        `${pages.length} answer page${pages.length === 1 ? " is" : "s are"} published but no assistant is connected, so nothing samples what the assistants actually answer. ` +
        "Citation share reads zero because nobody asked, which is a different fact from being uncited.",
      evidence: { publishedPages: pages.length, assistants: input.assistants },
      action: AEO
    });
  }

  const stale = pages.filter((p) => p.freshness === null || input.now - p.freshness > AEO_STALE_DAYS * 86_400_000);
  if (stale.length) {
    out.push({
      key: "aeo:stale",
      kind: "aeo",
      urgency: "when-you-can",
      title: `${stale.length} answer page${stale.length === 1 ? "" : "s"} past the freshness window`,
      why:
        `Published more than ${AEO_STALE_DAYS} days ago. An answer engine weighs recency, so a stale page is one that was cited and now is not.`,
      evidence: { stalePages: stale.length },
      action: AEO
    });
  }

  const samplesByPage = new Map<string, { sampled: number; cited: number }>();
  for (const c of input.citations) {
    if (!c.pageId) continue;
    const bucket = samplesByPage.get(c.pageId) ?? { sampled: 0, cited: 0 };
    bucket.sampled += 1;
    if (c.cited) bucket.cited += 1;
    samplesByPage.set(c.pageId, bucket);
  }
  for (const page of pages) {
    const bucket = samplesByPage.get(page.id);
    if (!bucket || bucket.sampled < AEO_LOSING_MIN_SAMPLES || bucket.cited > 0) continue;
    out.push({
      key: `aeo:losing:${page.id}`,
      kind: "aeo",
      urgency: "soon",
      title: `Losing the answer box for "${page.queryCluster}"`,
      why:
        `Sampled ${bucket.sampled} times and cited none. Either the page does not answer the question the assistant is asked, or somebody else's does it better.`,
      evidence: { pageId: page.id, queryCluster: page.queryCluster, sampled: bucket.sampled },
      action: AEO
    });
  }

  return out.sort(
    (a, b) => URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency] || a.key.localeCompare(b.key)
  );
}

/* ---------------------------------------------------------------- gather */

/** The window spend is read over when deciding whether CAC has a denominator. */
export const SPEND_WINDOW_DAYS = 30;

/** Reads the tenant's actual state and hands it to the rules. The only querying
 *  half, so `suggestNext` itself never touches a database. */
export async function gatherNext(ctx: Ctx, opts: { kitConfigured: boolean; assistants: number }): Promise<NextInput> {
  const since = ctx.now - SPEND_WINDOW_DAYS * 86_400_000;
  const [campaigns, creatives, publishes, whitespaces, aeoPages, audiences, experiments] = await Promise.all([
    ctx.db.select().from(schema.signalCampaigns).where(eq(schema.signalCampaigns.tenantId, ctx.tenantId)),
    ctx.db
      .select({ id: schema.signalCreatives.id, campaignId: schema.signalCreatives.campaignId, locale: schema.signalCreatives.locale, complianceStatus: schema.signalCreatives.complianceStatus })
      .from(schema.signalCreatives)
      .where(eq(schema.signalCreatives.tenantId, ctx.tenantId)),
    ctx.db
      .select({ creativeId: schema.signalCreativePublishes.creativeId, status: schema.signalCreativePublishes.status })
      .from(schema.signalCreativePublishes)
      .where(eq(schema.signalCreativePublishes.tenantId, ctx.tenantId)),
    // Only the statuses the rules act on, so an operator's candidate list does
    // not turn into a wall of suggestions nobody can use yet.
    ctx.db
      .select({ id: schema.scoutWhitespaces.id, description: schema.scoutWhitespaces.description, status: schema.scoutWhitespaces.status, demandEstimate: schema.scoutWhitespaces.demandEstimate })
      .from(schema.scoutWhitespaces)
      .where(and(eq(schema.scoutWhitespaces.tenantId, ctx.tenantId), eq(schema.scoutWhitespaces.status, "validated"))),
    ctx.db
      .select({ id: schema.signalAeoPages.id, queryCluster: schema.signalAeoPages.queryCluster, status: schema.signalAeoPages.status, freshness: schema.signalAeoPages.freshness })
      .from(schema.signalAeoPages)
      .where(eq(schema.signalAeoPages.tenantId, ctx.tenantId)),
    ctx.db
      .select({ id: schema.signalAudiences.id, name: schema.signalAudiences.name, consentPurposes: schema.signalAudiences.consentPurposes, sizeCached: schema.signalAudiences.sizeCached })
      .from(schema.signalAudiences)
      .where(eq(schema.signalAudiences.tenantId, ctx.tenantId)),
    ctx.db
      .select({ id: schema.signalExperiments.id, hypothesis: schema.signalExperiments.hypothesis, metric: schema.signalExperiments.metric, state: schema.signalExperiments.state })
      .from(schema.signalExperiments)
      .where(eq(schema.signalExperiments.tenantId, ctx.tenantId))
  ]);

  const citations = await ctx.db
    .select({ pageId: schema.signalAeoCitations.pageId, cited: schema.signalAeoCitations.cited })
    .from(schema.signalAeoCitations)
    .where(eq(schema.signalAeoCitations.tenantId, ctx.tenantId));

  const spendRows = await ctx.db
    .select({ day: schema.signalSpend.day })
    .from(schema.signalSpend)
    .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), gte(schema.signalSpend.ts, since)))
    .orderBy(desc(schema.signalSpend.day));

  return {
    now: ctx.now,
    campaigns,
    creatives,
    publishes,
    whitespaces,
    aeoPages,
    citations,
    audiences,
    experiments,
    spendDaysWithData: new Set(spendRows.map((r) => r.day)).size,
    assistants: opts.assistants,
    kitConfigured: opts.kitConfigured
  };
}

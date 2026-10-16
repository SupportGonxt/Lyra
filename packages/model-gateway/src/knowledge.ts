import { DEFAULT_PACK, promptNouns, type PromptNouns } from "./vocabulary.js";

// CLAUDE.md rule 14 / docs/21 §3, the *knowledge* half. `vocabulary.ts` gives a
// prompt three nouns; this gives it the facts. Everything here is one sentence
// the model may rely on, with where it came from and when it was true — because
// a fact without a source is a rumour and a fact without a date is a trap.
//
// Two rules this file exists to keep:
//
//  1. **Never invent a regulatory claim** (CLAUDE.md guardrails). Every
//     compliance statement below is either this platform's *own* product rule
//     (quiet hours, the frequency cap, disclosure presence — things this code
//     enforces) or a rate that is literally a row in the tenant's own compiled
//     tax rulepack. Nothing here asserts law from memory; where a rate is the
//     tenant's to confirm, the statement says so.
//  2. **Knowledge is context, not evidence.** These facts are attached to a
//     prompt so a model reasons in the right world. They are deliberately NOT
//     added to a call's grounding evidence: a campaign plan may quote a policy's
//     premium because the call gave it that number, and may not quote 5% VAT as
//     though the tenant's data said so. `knowledgeBlock` returns prose for the
//     prompt's context section and never touches `verifyGroundedness`.

/** What kind of knowledge a fact is, so a caller can take a subset. */
export type KnowledgeKind = "market" | "product" | "money" | "compliance" | "method" | "metric";

export interface KnowledgeFact {
  /** Stable id, `section.subject.detail` — the key a caller selects by. */
  key: string;
  kind: KnowledgeKind;
  /** One sentence the model may state or reason from. */
  statement: string;
  /** Where this came from: the tenant's own config, this platform's own rule, or a compiled table. */
  source: string;
  /** When it was true, YYYY-MM-DD. */
  asOf: string;
  /** ISO-3166 alpha-2 markets this applies to; empty means everywhere. */
  markets: readonly string[];
}

export interface KnowledgePack {
  key: string;
  /** The pack's own version, so a prompt can cite which world it reasoned in. */
  version: string;
  nouns: PromptNouns;
  facts: readonly KnowledgeFact[];
}

const ASOF = "2026-10-01";

/**
 * The Gulf pack: the world this platform actually ships into. The market and
 * tax statements are read off the tenant's own configuration and the compiled
 * rulepack (`packages/db/src/tax-rulepack.ts`), not from memory; the method and
 * money statements describe how an insurance aggregator works and how this
 * platform does the work, which is what a model needs to write a media plan or
 * a brief that is not generic.
 */
const GULF_FACTS: readonly KnowledgeFact[] = [
  /* ------------------------------------------------------------- market */
  {
    key: "market.uae.currency",
    kind: "market",
    statement: "The UAE launch market bills in AED, and money is stored in fils (integer minor units).",
    source: "tenant policy default `currency` (packages/db/src/json.ts)",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "market.uae.regulator",
    kind: "market",
    statement:
      "Insurance distribution in the UAE is supervised by the Central Bank of the UAE (CBUAE), and the tenant's own compliance rulepack governs what its copy may say.",
    source: "compliance rulepack, market AE (packages/core/src/seed/admin.ts)",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "market.uae.vat",
    kind: "market",
    statement: "VAT on brokerage and agency services supplied in the UAE is 5%.",
    source: "compiled tax rulepack, AE `commission` 50 000 ppm (packages/db/src/tax-rulepack.ts)",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "market.uae.languages",
    kind: "market",
    statement:
      "UAE customers are served in Arabic and English; Arabic creative is written natively rather than translated, and Arabic copy is subject to the same claims rules as English.",
    source: "tenant policy default `locales` [en, ar] and the pre-flight's Arabic rules",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "market.ksa.vat",
    kind: "market",
    statement: "Saudi Arabia levies VAT at 15%, raised from 5% on 1 July 2020 — a restatement of an older period uses the rate that applied then.",
    source: "compiled tax rulepack, SA rows dated to 2020-07-01 (packages/db/src/tax-rulepack.ts)",
    asOf: ASOF,
    markets: ["SA"]
  },
  {
    key: "market.egypt.vat",
    kind: "market",
    statement:
      "Egypt levies VAT at 14%, life cover sits outside the charge, and a table levy applies to general insurance premiums alongside the VAT; the levy's rate is the tenant's to confirm with its own adviser before the first Egyptian invoice.",
    source: "compiled tax rulepack, EG rows, and ADR-0121's explicit caveat",
    asOf: ASOF,
    markets: ["EG"]
  },
  {
    key: "market.sequence",
    kind: "market",
    statement: "The launch market is the UAE in AED; Saudi Arabia and then Egypt follow, and both rulepacks are already loadable data rather than a release.",
    source: "ADR-0121 (market decision, 2026-10-01)",
    asOf: ASOF,
    markets: []
  },

  /* ------------------------------------------------------------ product */
  {
    key: "product.aggregator.model",
    kind: "product",
    statement:
      "A comparison site prices one risk across every insurer on its panel and ranks the results, so the customer sees a market rather than a quote.",
    source: "platform method — the comparative shop (apps/api/src/engines/shop.ts)",
    asOf: ASOF,
    markets: []
  },
  {
    key: "product.lines",
    kind: "product",
    statement:
      "UAE aggregators typically distribute motor, home, travel, health and life cover; the lines actually on sale are the tenant's own catalogue, never assumed.",
    source: "tenant catalogue `dist_offerings`; lines named here are the market's, not the tenant's",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "product.quote",
    kind: "product",
    statement: "A quote carries a premium, an excess, a benefit schedule and a validity date; a premium alone is not an offer.",
    source: "platform method — `dist_quote_responses` (packages/db/src/schema/dist.ts)",
    asOf: ASOF,
    markets: []
  },
  {
    key: "product.rank",
    kind: "product",
    statement: "Ranking is declared and auditable: no provider pays for position, and any commercial arrangement is disclosed.",
    source: "platform rule — docs/modules/axis.md §2.1, enforced on the comparison screen",
    asOf: ASOF,
    markets: []
  },

  /* -------------------------------------------------------------- money */
  {
    key: "money.commission.split",
    kind: "money",
    statement:
      "The aggregator earns commission from the underwriter: gross commission is receivable from the insurer, the introducing channel's share is payable to that channel, and what remains after tax is the aggregator's net commission.",
    source: "platform model — `dist_commission_entries` and packages/core/src/commission.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "money.aggregator.streams",
    kind: "money",
    statement:
      "A comparison business earns on distribution (commission per policy) and increasingly on aggregated market data sold back to insurers, which is why data products carry a k-anonymity floor.",
    source: "platform model — commission accrual plus SCOUT data products",
    asOf: ASOF,
    markets: []
  },
  {
    key: "money.unit-economics",
    kind: "money",
    statement:
      "Acquisition cost is what it costs to win a policy and lifetime value is the commission that policy is expected to earn; the ratio, not the absolute figure, decides where spend moves.",
    source: "platform method — the budget autopilot (apps/api/src/engines/signal-autopilot.ts)",
    asOf: ASOF,
    markets: []
  },
  {
    key: "money.settlement",
    kind: "money",
    statement:
      "Commission moves accrued → invoiced → received → payable → paid, and a clawback reverses an entry without ever mutating the original.",
    source: "platform model — `dist_commission_entries.state` and `reversal_of`",
    asOf: ASOF,
    markets: []
  },

  /* --------------------------------------------------------- compliance */
  {
    key: "compliance.disclosure",
    kind: "compliance",
    statement:
      "A product line's mandatory disclosure is the tenant's own wording and must appear in the copy verbatim; the platform appends it and hard-blocks copy that lacks it.",
    source: "platform rule — ADR-0108, packages/core/src/signal-compliance.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.banned-claims",
    kind: "compliance",
    statement:
      "Never state a guarantee of acceptance, and never make an unqualified market superlative ('cheapest', 'best in the market') without a source for it.",
    source: "platform rule — the pre-flight's built-in checks (packages/core/src/signal-compliance.ts)",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.house-rules",
    kind: "compliance",
    statement:
      "The tenant's brand kit extends the pre-flight with its own required phrases, forbidden words and banned claims; a tenant can add rules but can never switch the built-in ones off.",
    source: "platform rule — `signal_brand_kits` and ADR-0121-era pre-flight",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.quiet-hours",
    kind: "compliance",
    statement: "No outbound marketing contact is sent between 20:00 and 08:00 in the tenant's own time zone.",
    source: "platform floor — packages/core/src/quiet-hours.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.frequency",
    kind: "compliance",
    statement: "A customer receives at most two outbound marketing contacts in any week, across every campaign.",
    source: "platform rule — FREQUENCY_CAP_PER_WEEK (apps/api/src/engines/signal-outreach.ts)",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.consent",
    kind: "compliance",
    statement:
      "Marketing contact requires a marketing consent on file, and the audience's own consent purposes are re-checked at send time rather than at list-build time.",
    source: "platform rule — packages/core/src/signal-compliance.ts and engines/signal-consent.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.advice",
    kind: "compliance",
    statement: "Regulated advice is given by a licensed human; the platform drafts and assembles, and a person advises.",
    source: "compliance rulepack, `advice.regulatedAdviceRequiresLicensedHuman`",
    asOf: ASOF,
    markets: ["AE"]
  },
  {
    key: "compliance.anonymity",
    kind: "compliance",
    statement:
      "Any aggregated market figure is published only above a k-anonymity floor; a cell below it is withheld entirely rather than shown thin or zeroed.",
    source: "platform rule — packages/core/src/k-anonymity.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "compliance.outreach-first-contact",
    kind: "compliance",
    statement:
      "A first-contact message is a draft: it passes grounding, the pre-flight, the consent gate and an approval before it is sent, and nothing is auto-sent outside the tenant's autonomy policy.",
    source: "platform rule — ADR-0091 and engines/signal-outreach.ts",
    asOf: ASOF,
    markets: []
  },

  /* ------------------------------------------------------------ method */
  {
    key: "method.media-plan",
    kind: "method",
    statement:
      "A media plan is a choice: this audience, these channels, this budget, at a stated chance of working, for reasons a human can argue with. The thing approved is the choice, not the copy.",
    source: "platform method — docs/modules/signal.md §2.1 and the campaign plan prompt",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.creative",
    kind: "method",
    statement:
      "Write variants against a chosen angle and a specific audience, never against a bare category noun; a variant that could be posted by any competitor is not a variant.",
    source: "platform method — the creative brief and the campaign plan's chosen option",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.attribution",
    kind: "method",
    statement:
      "Attribution reports a range and never false precision: a channel's contribution is bounded by the evidence, and the honest answer is often 'between these two numbers'.",
    source: "platform method — apps/api/src/engines/signal-attribution.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.experiment",
    kind: "method",
    statement:
      "A test needs a hypothesis, one metric, a stopping rule and a recorded conclusion; nothing wins by eyeball, and a test that cannot conclude is a cost with no answer.",
    source: "platform method — docs/modules/signal.md §2.5 and engines/signal-experiment.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.aeo",
    kind: "method",
    statement:
      "Answer-engine visibility is measured by sampling what assistants actually answer for a target query and whether they cite us — not by how many pages were published.",
    source: "platform method — engines/signal-aeo-monitor.ts and J-M3",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.renewal",
    kind: "method",
    statement:
      "A renewal is a retention event before it is a marketing one: the platform scores churn risk, and only a renewal genuinely at risk becomes a prospect for outreach.",
    source: "platform method — ADR-0091 and engines/signal-prospects.ts",
    asOf: ASOF,
    markets: []
  },
  {
    key: "method.publish",
    kind: "method",
    statement:
      "Publishing places an ad on the platform's account paused; a human turns it on where the money is spent. The platform creates the object, it does not start the spend.",
    source: "platform method — engines/signal-publish.ts",
    asOf: ASOF,
    markets: []
  },

  /* ----------------------------------------------------------- metrics */
  {
    key: "metric.cac",
    kind: "metric",
    statement: "Acquisition cost is media spend divided by the policies it won, and is reported as a range rather than a point.",
    source: "platform method — engines/signal-attribution.ts `acquisitionCostRange`",
    asOf: ASOF,
    markets: []
  },
  {
    key: "metric.win-rate",
    kind: "metric",
    statement: "An insurer's win rate is the share of quotes it won on a given line and period, weighted by volume rather than averaged per row.",
    source: "platform method — `scout_panel_bench.win_rate`",
    asOf: ASOF,
    markets: []
  },
  {
    key: "metric.price-index",
    kind: "metric",
    statement: "A price index is basis points against the market, where 10 000 is parity, so 10 400 reads as 4% above market.",
    source: "platform method — `scout_panel_bench.our_price_idx`",
    asOf: ASOF,
    markets: []
  },
  {
    key: "metric.citation-share",
    kind: "metric",
    statement:
      "Citation share is the proportion of sampled queries where an assistant cited us, counted per query and per assistant; a week nobody sampled is not a week of zero citations.",
    source: "platform method — engines/signal-aeo-monitor.ts `aeoWeeks`",
    asOf: ASOF,
    markets: []
  },
  {
    key: "metric.holdout",
    kind: "metric",
    statement: "Autopilot uplift is measured against a frozen-budget holdout, so 'the autopilot helped' is a comparison rather than a claim.",
    source: "platform method — packages/core/src/signal-holdout.ts",
    asOf: ASOF,
    markets: []
  }
];

/**
 * The default pack: the method and platform rules that hold anywhere, without a
 * market's rates. A tenant on an unregistered pack reasons with this rather than
 * with nothing.
 */
const GENERIC_FACTS: readonly KnowledgeFact[] = GULF_FACTS.filter(
  (f) => f.markets.length === 0 || f.key.startsWith("compliance.") || f.key.startsWith("method.")
);

export const KNOWLEDGE_PACKS: ReadonlyMap<string, KnowledgePack> = new Map<string, KnowledgePack>([
  [
    DEFAULT_PACK,
    { key: DEFAULT_PACK, version: ASOF, nouns: promptNouns(DEFAULT_PACK), facts: GENERIC_FACTS }
  ],
  [
    "insurance-gulf",
    { key: "insurance-gulf", version: ASOF, nouns: promptNouns("insurance-gulf"), facts: GULF_FACTS }
  ]
]);

/**
 * The pack a prompt reasons in. An unknown or missing key degrades to the
 * default, the same posture `promptNouns` takes and for the same reason: a
 * prompt with no world in it writes generic copy, and generic is the failure.
 */
export function knowledgePack(pack: string | undefined): KnowledgePack {
  return KNOWLEDGE_PACKS.get(pack ?? DEFAULT_PACK) ?? KNOWLEDGE_PACKS.get(DEFAULT_PACK)!;
}

/** The facts of a pack, optionally narrowed to markets and/or kinds. */
export function knowledgeFacts(
  pack: string | undefined,
  filter: { markets?: readonly string[]; kinds?: readonly KnowledgeKind[] } = {}
): readonly KnowledgeFact[] {
  const all = knowledgePack(pack).facts;
  return all.filter((f) => {
    if (filter.kinds && !filter.kinds.includes(f.kind)) return false;
    // A market-scoped fact is in scope when the caller did not narrow at all, or
    // named that market. A fact scoped to nowhere always applies.
    if (!filter.markets || f.markets.length === 0) return true;
    return f.markets.some((m) => filter.markets!.includes(m));
  });
}

/** How many facts a prompt block may carry. A block is context, not a corpus:
 *  an unbounded one would spend the call's budget on encyclopaedia. */
export const KNOWLEDGE_BLOCK_MAX = 24;

/**
 * The block a prompt carries, rendered deterministically (facts sorted by key,
 * so the same pack produces byte-identical context and an eval can be diffed).
 *
 * Deliberately *not* a list of numbers a caller's evidence could be confused
 * with: the block is prose for the prompt's context section, and nothing here
 * is added to `verifyGroundedness`, so a model cannot cite a knowledge fact as
 * though the tenant's own data had stated it.
 */
export function knowledgeBlock(
  pack: string | undefined,
  filter: { markets?: readonly string[]; kinds?: readonly KnowledgeKind[]; max?: number } = {}
): string {
  const facts = knowledgeFacts(pack, filter)
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key))
    .slice(0, filter.max ?? KNOWLEDGE_BLOCK_MAX);
  if (!facts.length) return "";
  const lines = facts.map((f) => `- ${f.statement}`);
  return [
    `What you know about this business (pack ${knowledgePack(pack).key}, ${knowledgePack(pack).version}).`,
    "These are context, not this call's data: never present one as a figure from the evidence you were given.",
    ...lines
  ].join("\n");
}

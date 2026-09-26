import { targetingPack, verifyGroundedness } from "@lyra/core";
import { parseJsonObject } from "./parse.js";
import type { DemographicReason } from "./audience-brief.js";
import type { PromptNouns } from "./vocabulary.js";

// docs/modules/signal.md §2.1 — a campaign is not a brief plus twenty lines of
// copy. It is a decision to spend money one way rather than another, and the
// thing a human actually approves is the *choice*: this angle at this audience
// through these channels, at a stated chance of working, for stated reasons.
//
// So the model is asked for three plans, not one. Each carries its own
// probability of success and the sentences that argue it, and the reasoning it
// did before choosing is kept as notes rather than thrown away — the copy
// generator then writes *against* the chosen option instead of against a bare
// category noun, which is the whole reason the copy can be specific to a
// demographic at all.
//
// Same doctrine as audience-brief.ts, and for the same reason: the model does
// not get to state a number the evidence did not give it. `why` lines are scored
// per option, so one hallucinated figure sinks its own option rather than the
// plan. Its own probability is exempt — that figure is the model's judgement,
// not a fact it is restating.

/**
 * Channels a plan may name.
 *
 * ponytail: a flat allow-list, not the `Channel` seam (packages/core/src/seams.ts)
 * — that seam is about *delivering* a message to a customer, and this is a media
 * plan naming where spend goes. The day SIGNAL actually buys media through a
 * connector, this list becomes that connector's registry and the literal here
 * goes away. Until then an invented channel would be a plan nobody can execute.
 */
export const CAMPAIGN_CHANNELS = [
  "google_search",
  "bing_search",
  "meta",
  "instagram",
  "youtube",
  "tiktok",
  "display",
  "email",
  "sms",
  "whatsapp",
  "push",
  "radio",
  "ooh",
  "partner"
] as const;

export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export interface CampaignOption {
  /** Short internal name for the approach, <= 80 chars. */
  name: string;
  /** The strategic idea — what this option does differently, <= 300 chars. */
  angle: string;
  /** What is actually put in front of the audience, <= 200 chars. */
  offer: string;
  /** Where the spend goes. Never empty: an option with no runnable channel is dropped. */
  channels: CampaignChannel[];
  /** The model's own 0-100 estimate that this option meets the objective. */
  probability: number;
  /** Why that probability, grounded in the evidence. Never empty. */
  why: string[];
  /** What would sink it, in one sentence. Null when the model did not say. */
  risk: string | null;
}

export interface CampaignPlan {
  /** What the model made of the demand, the book and the pool before choosing —
   *  the inspectable "why" CLAUDE.md rule 11 requires beside every AI artifact. */
  notes: string;
  /** Surviving options, highest probability first. */
  options: CampaignOption[];
  /** `options[0].name` — the option the copy is written against unless a human picks another. */
  recommended: string;
  /** Share of the model's options that survived validation, 0-100. */
  confidence: number;
}

/** The audience half of the evidence — what `suggestTargeting` proposed, so the
 *  plan is argued at a real pool rather than at "customers". */
export interface PlanAudience {
  name: string;
  summary: string;
  estimatedReach: number;
  /** Bands on the pack's affluence scale. Field name frozen — see the
   *  `ponytail:` note on TargetingProposal.lsm in audience-brief.ts. */
  lsm: number[];
  reasons: readonly DemographicReason[];
  /** The tenant's domain pack, which names the scale those bands are on.
   *  Omitted reads as the default pack, so a ZA pool still says "LSM". */
  pack?: string;
}

/**
 * The pool's affluence bands, named after the scale the *pack* uses — "LSM
 * bands: 7, 8" on a ZA book, "Income quintile bands: 4, 5" on a Gulf one. No
 * bands, no line: a "none" line invites the model to reason about an absence.
 */
function affluenceBandLine(audience: PlanAudience, tail: string): string[] {
  const label = targetingPack(audience.pack).affluence?.label;
  return label && audience.lsm.length ? [`${label} ${tail}: ${audience.lsm.join(", ")}`] : [];
}

export interface CampaignPlanEvidence {
  /** Whitespace category, or the scenario somebody typed. */
  subject: string;
  /** acq|renewal|xsell — what the campaign is for. */
  objective: string;
  /** The one-line proposition from the whitespace brief; null for a bare scenario. */
  proposition: string | null;
  /** 0-100 demand momentum; null when the subject is a scenario with nothing measured. */
  momentum: number | null;
  /** Demand signals behind the subject; null for the same reason. */
  signalCount: number | null;
  /** 0-100 share of the book already covered on this line; null when unknown. */
  coverage: number | null;
  /** 0-100 competitive pressure; null when unmeasured. */
  competitionScore: number | null;
  /** Customers on the tenant's book. */
  bookSize: number;
  /** The proposed pool. Null when the tenant has nothing above the k-anonymity floor. */
  audience: PlanAudience | null;
  /**
   * ADR-0091: identified people SIGNAL holds a reason for, counted per reason
   * (quote_expired, no_policy, churn_risk). Counts only — never a person.
   */
  prospects?: Partial<Record<string, number>> | null;
}

/** JSON schema handed to `ModelRequest.responseSchema`. */
export function campaignPlanSchema(): Record<string, unknown> {
  return {
    name: "signal_campaign_plan",
    schema: {
      type: "object",
      properties: {
        notes: { type: "string" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              angle: { type: "string" },
              offer: { type: "string" },
              channels: { type: "array", items: { type: "string", enum: [...CAMPAIGN_CHANNELS] } },
              probability: { type: "integer", minimum: 0, maximum: 100 },
              why: { type: "array", items: { type: "string" } },
              risk: { type: "string" }
            },
            required: ["name", "angle", "offer", "channels", "probability", "why"]
          }
        }
      },
      required: ["notes", "options"]
    }
  };
}

/**
 * The evidence, one fact per line — the pool `verifyGroundedness` scores every
 * reply against, so prompt and gate cannot drift apart.
 *
 * Null facts are omitted rather than written as "unknown": a "not measured" line
 * invites the model to reason about the absence, and a scenario has no measured
 * demand to reason about.
 */
export function campaignPlanEvidenceLines(ev: CampaignPlanEvidence, nouns: PromptNouns): string[] {
  const a = ev.audience;
  return [
    `Campaign subject: ${ev.subject}`,
    `Objective: ${ev.objective}`,
    ...(ev.proposition ? [`Proposition from the market brief: ${ev.proposition}`] : []),
    ...(ev.momentum === null ? [] : [`Demand momentum score (0-100): ${ev.momentum}`]),
    ...(ev.signalCount === null ? [] : [`Demand signals behind this subject: ${ev.signalCount}`]),
    ...(ev.coverage === null ? [] : [`Share of the book already holding this line (%): ${ev.coverage}`]),
    ...(ev.competitionScore === null ? [] : [`Competitive pressure score (0-100): ${ev.competitionScore}`]),
    `Customers in the book: ${ev.bookSize}`,
    ...prospectLines(ev.prospects, nouns),
    `Spend buys ${nouns.contracts}; every figure below counts customers, not ${nouns.contracts}.`,
    ...(a
      ? [
          `Audience: ${a.name}`,
          `Audience summary: ${a.summary}`,
          `Reachable customers in this audience: ${a.estimatedReach}`,
          ...affluenceBandLine(a, "bands in the pool"),
          ...a.reasons.map((r) => `Audience band ${r.axis}=${r.value}: ${r.count} customers. ${r.reason}`)
        ]
      : ["No audience pool has been proposed yet; plan for the whole book."])
  ];
}

function prospectLines(prospects: CampaignPlanEvidence["prospects"], nouns: PromptNouns): string[] {
  if (!prospects) return [];
  const said: Record<string, string> = {
    quote_expired: "people whose quote expired without being taken up",
    no_policy: `people known to us who hold no ${nouns.contract} yet`,
    churn_risk: "customers at risk of not renewing (reached by retention journeys, not this campaign)"
  };
  return Object.entries(prospects)
    .filter(([reason, n]) => said[reason] && typeof n === "number" && n > 0)
    .map(([reason, n]) => `Identified ${said[reason]}: ${n}`);
}

export function campaignPlanMessages(
  ev: CampaignPlanEvidence,
  nouns: PromptNouns
): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content:
        `You plan ${nouns.domain} marketing campaigns. You are given the demand behind a subject and ` +
        "the audience pool it would be aimed at, as aggregate counts — you never see a person. " +
        "Reply with JSON only, matching the schema: notes, then exactly three options. " +
        "Notes are your reading of the demand, the pool and the risk, in at most six sentences: " +
        "what is actually happening here and what a marketer should worry about. " +
        "Each option is a genuinely different way to spend the money — a different angle, offer and " +
        "channel mix, not the same idea reworded. Give each one a probability from 0 to 100 that it " +
        "meets the objective, and make the three probabilities differ: if two approaches are equally " +
        "likely to work, one of them is not a real alternative. " +
        `Channels must come from this list: ${CAMPAIGN_CHANNELS.join(", ")}. An option naming a channel ` +
        "outside it is discarded. " +
        "Every option needs why: one sentence per line saying what in the evidence makes that " +
        "probability the right one, citing only numbers the evidence below gave you. Do not restate " +
        "your own probability in the why lines. An option with no reasons is discarded. " +
        "Write the offer for the audience described below — speak to what that group is actually " +
        "buying, never to a generic customer. " +
        "Never plan against race, ethnicity, nationality, national origin, residency status, " +
        "religion, belief, health, disability, gender, sex, sexual orientation, politics, union " +
        "membership or criminal record. " +
        "A human funds this. You propose it and say how sure you are."
    },
    { role: "user", content: campaignPlanEvidenceLines(ev, nouns).join("\n") }
  ];
}

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

/**
 * Parses one model reply. Never throws.
 *
 * Null when the reply is unusable rather than merely thin: notes missing or
 * ungrounded, `options` not a non-empty array, or every option rejected. An
 * individual option is *dropped* — bad channel, missing angle or offer, a
 * probability that is not an integer 0-100, no usable `why`, or a `why` line
 * citing a number the evidence never gave it — and `confidence` reports how much
 * of the reply that cost, so a human sees a plan at 33 for what it is.
 */
export function parseCampaignPlan(
  reply: string,
  ev: CampaignPlanEvidence,
  nouns: PromptNouns
): CampaignPlan | null {
  const parsed = parseJsonObject(reply) ?? {};

  const notes = text(parsed.notes, 1200);
  const proposed = parsed.options;
  if (notes === null || !Array.isArray(proposed) || proposed.length === 0) return null;

  const lines = campaignPlanEvidenceLines(ev, nouns);
  if (!verifyGroundedness(notes, lines).ok) return null;

  const options: CampaignOption[] = [];
  for (const raw of proposed) {
    const option = parseOption(raw, lines);
    if (!option) continue;
    if (options.some((o) => o.name.toLowerCase() === option.name.toLowerCase())) continue;
    options.push(option);
  }
  if (options.length === 0) return null;

  // Highest probability first: the recommendation is the model's own ranking
  // made explicit, so the UI never has to re-derive which plan it meant.
  options.sort((a, b) => b.probability - a.probability);

  return {
    notes,
    options,
    recommended: options[0]!.name,
    confidence: Math.round((options.length / proposed.length) * 100)
  };
}

function parseOption(raw: unknown, lines: string[]): CampaignOption | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const name = text(o.name, 80);
  const angle = text(o.angle, 300);
  const offer = text(o.offer, 200);
  if (name === null || angle === null || offer === null) return null;

  const probability = o.probability;
  if (typeof probability !== "number" || !Number.isInteger(probability) || probability < 0 || probability > 100) {
    return null;
  }

  const channels = (Array.isArray(o.channels) ? o.channels : [])
    .flatMap((c) => (typeof c === "string" ? [c.trim().toLowerCase()] : []))
    .filter((c): c is CampaignChannel => (CAMPAIGN_CHANNELS as readonly string[]).includes(c))
    .filter((c, i, all) => all.indexOf(c) === i);
  if (channels.length === 0) return null;

  // The probability is the model's own judgement, so it is allowed to appear in
  // its own argument; every other number has to come from the evidence.
  const pool = [...lines, String(probability)];
  const why = (Array.isArray(o.why) ? o.why : [])
    .flatMap((w) => {
      const line = text(w, 300);
      return line && verifyGroundedness(line, pool).ok ? [line] : [];
    })
    .filter((w, i, all) => all.indexOf(w) === i);
  if (why.length === 0) return null;

  const risk = text(o.risk, 300);
  return { name, angle, offer, channels, probability, why, risk: risk && verifyGroundedness(risk, pool).ok ? risk : null };
}

/**
 * The plan used when the model is unreachable, slow or ungrounded.
 *
 * Deterministic and arithmetic-only — three real alternatives derived from the
 * evidence, at probabilities that fall out of momentum and coverage rather than
 * out of judgement. It is a dull plan and it is meant to be: docs/15 §4, AI
 * drafts and does not gate, so a promotion never fails for want of a model, and
 * confidence 0 says plainly that nothing chose this.
 */
export function fallbackCampaignPlan(ev: CampaignPlanEvidence, nouns: PromptNouns): CampaignPlan {
  const momentum = ev.momentum ?? 50;
  const headroom = 100 - (ev.coverage ?? 0);
  const reach = ev.audience?.estimatedReach ?? ev.bookSize;
  const pool = ev.audience ? `the proposed pool of ${reach} customers` : `the whole book of ${ev.bookSize} customers`;

  // Bounded to 10..90: a deterministic guess is never a near-certainty and never
  // a write-off, and a probability of 0 or 100 would read as a measurement.
  const clamp = (n: number): number => Math.max(10, Math.min(90, Math.round(n)));
  const base = clamp((momentum + headroom) / 2);

  const options: CampaignOption[] = [
    {
      name: `${ev.subject} — direct to the pool`,
      angle: `Speak only to ${pool}, on the single strongest attribute in it.`,
      offer: `The ${nouns.contract} priced for the band that already carries the most customers.`,
      channels: ["email", "meta"],
      probability: base,
      why: [`Demand momentum sits at ${momentum} against ${reach} reachable customers.`],
      risk: "A pool this narrow burns out fast; the frequency cap matters more than the budget."
    },
    {
      name: `${ev.subject} — intent capture`,
      angle: "Buy the searches people already make, and let the demand come to the offer.",
      offer: `A quote in under a minute for anyone already looking for this ${nouns.contract}.`,
      channels: ["google_search", "bing_search"],
      probability: clamp(base - 12),
      why: [`Momentum of ${momentum} means the demand exists before the campaign does.`],
      risk: "Search cost rises with competitive pressure, which nobody here controls."
    },
    {
      name: `${ev.subject} — broad build`,
      angle: `Reach beyond the pool to the rest of the ${ev.bookSize} customers on the book.`,
      offer: `An introduction to the ${nouns.contract} for customers who hold none.`,
      channels: ["display", "youtube"],
      probability: clamp(base - 25),
      why: [`${ev.bookSize} customers are on the book and ${reach} of them are in the proposed pool.`],
      risk: "Reach without a matched audience converts worst; treat it as a floor, not a plan."
    }
  ];

  return {
    notes:
      `No model planned this campaign. These three options are derived from the evidence alone: ` +
      `momentum ${momentum} on ${nouns.contracts} against ${reach} reachable customers, ` +
      `and they are ranked by size of the audience each one can actually reach. ` +
      `Read them as a starting point and rewrite the one you fund.`,
    options,
    recommended: options[0]!.name,
    confidence: 0
  };
}

/**
 * The plan, folded into the sentences a copy prompt can carry.
 *
 * This is why the plan exists: the creative generator is handed the chosen
 * option's angle and offer and the bands the audience is made of, so the copy is
 * written for a specific group of people about a specific idea, rather than for
 * "customers" about a category noun.
 */
export function creativeContextLines(plan: CampaignPlan, optionName: string, audience: PlanAudience | null): string[] {
  const option = plan.options.find((o) => o.name === optionName) ?? plan.options[0];
  if (!option) return [];
  return [
    `Campaign approach: ${option.name}`,
    `Angle: ${option.angle}`,
    `Offer: ${option.offer}`,
    `Channels: ${option.channels.join(", ")}`,
    `Planner's notes: ${plan.notes}`,
    ...(audience
      ? [
          `Written for: ${audience.summary}`,
          ...affluenceBandLine(audience, "bands"),
          ...audience.reasons.map((r) => `Audience band ${r.axis}=${r.value}: ${r.reason}`)
        ]
      : [])
  ];
}

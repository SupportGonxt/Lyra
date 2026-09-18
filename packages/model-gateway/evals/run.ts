import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkInput, checkOutput, blocked } from "../src/guardrails.js";
import { fallbackChain } from "../src/models.js";
import { MAX_ROUNDS, MAX_TOOL_ROUNDS, offersTools, planRound, verdictFor } from "../src/agent-loop.js";
import { EXTRACTION_FIELDS, normalizeField, parseExtraction, parseVisionExtraction } from "../src/extract.js";
import { parseTriage } from "../src/triage.js";
import { parseReserve } from "../src/reserve.js";
import { parseFraud } from "../src/fraud.js";
import { parseSla } from "../src/sla.js";
import { parseUbi } from "../src/ubi.js";
import { parseWhitespaceBrief, type WhitespaceEvidence } from "../src/whitespace-brief.js";
import { parseAudienceProposal, type AudienceEvidence } from "../src/audience-brief.js";
import { CAMPAIGN_CHANNELS, parseCampaignPlan, type CampaignPlanEvidence } from "../src/campaign-plan.js";
import { promptNouns } from "../src/vocabulary.js";
import { aggregateCxScore, cxRubricSummary } from "../src/cx-judge.js";
import {
  verifyNumericClaims,
  verifyGroundedness,
  checkCompliance as checkSignalCompliance,
  PROTECTED_AXES,
  type BriefingSnapshot
} from "@lyra/core";
import { loadCases, loadThresholds, metric, metricOk, type Metric } from "./harness.js";
import { LIVE_SCORERS } from "./live.js";

// docs/13 §3 (Eval-driven development): the golden set + threshold is the
// failing test for model/guardrail behaviour. One task = one directory under
// evals/ with cases.jsonl + thresholds.json; `pnpm eval` runs every task it
// finds a scorer for and fails the gate on any missed threshold.

const EVALS_DIR = dirname(fileURLToPath(import.meta.url));

interface InjectionCase {
  id: string;
  text: string;
  expectHit: boolean;
}

interface InjectionThresholds {
  recallMin: number;
  falsePositiveMax: number;
}

async function scoreInjection(dir: string): Promise<Metric[]> {
  const cases = await loadCases<InjectionCase>(dir);
  const thresholds = await loadThresholds<InjectionThresholds>(dir);
  const positives = cases.filter((c) => c.expectHit);
  const negatives = cases.filter((c) => !c.expectHit);

  const truePositives = positives.filter((c) => checkInput(c.text).length > 0).length;
  const falsePositives = negatives.filter((c) => checkInput(c.text).length > 0).length;

  return [
    metric("recall", positives.length ? truePositives / positives.length : 1, { min: thresholds.recallMin }),
    metric("falsePositiveRate", negatives.length ? falsePositives / negatives.length : 0, {
      max: thresholds.falsePositiveMax
    })
  ];
}

interface ComplianceCase {
  id: string;
  text: string;
  customerFacing: boolean;
  issued: string[];
  expectBlock: boolean;
  expectRule: string | null;
}

interface ComplianceThresholds {
  hardBlockRecallMin: number;
  falsePositiveMax: number;
  ruleMatchMin: number;
}

async function scoreCompliance(dir: string): Promise<Metric[]> {
  const cases = await loadCases<ComplianceCase>(dir);
  const thresholds = await loadThresholds<ComplianceThresholds>(dir);
  const blockCases = cases.filter((c) => c.expectBlock);
  const cleanCases = cases.filter((c) => !c.expectBlock);
  const ruleCases = cases.filter((c) => c.expectRule);

  const results = cases.map((c) => ({
    case: c,
    hits: checkOutput({ text: c.text, issued: new Set(c.issued), customerFacing: c.customerFacing })
  }));

  const correctlyBlocked = results.filter((r) => r.case.expectBlock && blocked(r.hits)).length;
  const falseBlocks = results.filter((r) => !r.case.expectBlock && blocked(r.hits)).length;
  const ruleMatches = results.filter(
    (r) => r.case.expectRule && r.hits.some((h) => h.rule === r.case.expectRule)
  ).length;

  return [
    metric("hardBlockRecall", blockCases.length ? correctlyBlocked / blockCases.length : 1, {
      min: thresholds.hardBlockRecallMin
    }),
    metric("falsePositiveRate", cleanCases.length ? falseBlocks / cleanCases.length : 0, {
      max: thresholds.falsePositiveMax
    }),
    metric("ruleMatchRate", ruleCases.length ? ruleMatches / ruleCases.length : 1, { min: thresholds.ruleMatchMin })
  ];
}

interface ArabicGuardrailCase {
  id: string;
  /** Which floor this case exercises: `checkInput` (pre-flight) or `checkOutput` (post-flight). */
  surface: "input" | "output";
  text: string;
  /** input cases only: provenance, which is what decides warn vs block. */
  untrusted?: boolean;
  /** output cases only. */
  customerFacing?: boolean;
  expectBlock: boolean;
  expectRule: string | null;
}

interface ArabicGuardrailThresholds {
  blockRecallMin: number;
  falsePositiveMax: number;
  ruleMatchMin: number;
}

/**
 * docs/27 F41 / docs/16 H12. The guardrail floors were six English regexes, so
 * the half of the product that ships in Arabic had no floor at all — an Arabic
 * "نضمن" (we guarantee) reached a customer where its English twin was blocked.
 *
 * Scored as one set across both floors on purpose: the finding is not "the
 * regulated-claim rule is weak", it is "the rule set is monolingual", and the
 * jailbreak list had already been half-fixed while the regulated list had not.
 * A pooled Arabic metric is what fails when either half regresses.
 */
async function scoreArabicGuardrails(dir: string): Promise<Metric[]> {
  const cases = await loadCases<ArabicGuardrailCase>(dir);
  const thresholds = await loadThresholds<ArabicGuardrailThresholds>(dir);

  const results = cases.map((c) => ({
    case: c,
    hits:
      c.surface === "input"
        ? checkInput(c.text, c.untrusted === undefined ? {} : { untrusted: c.untrusted })
        : checkOutput({
            text: c.text,
            issued: new Set<string>(),
            ...(c.customerFacing === undefined ? {} : { customerFacing: c.customerFacing })
          })
  }));

  const blockCases = results.filter((r) => r.case.expectBlock);
  const cleanCases = results.filter((r) => !r.case.expectBlock);
  const ruleCases = results.filter((r) => r.case.expectRule);

  return [
    metric("blockRecall", blockCases.length ? blockCases.filter((r) => blocked(r.hits)).length / blockCases.length : 1, {
      min: thresholds.blockRecallMin
    }),
    metric(
      "falsePositiveRate",
      cleanCases.length ? cleanCases.filter((r) => r.hits.length > 0).length / cleanCases.length : 0,
      { max: thresholds.falsePositiveMax }
    ),
    metric(
      "ruleMatchRate",
      ruleCases.length ? ruleCases.filter((r) => r.hits.some((h) => h.rule === r.case.expectRule)).length / ruleCases.length : 1,
      { min: thresholds.ruleMatchMin }
    )
  ];
}

interface LoopCase {
  id: string;
  kind: "loop";
  note: string;
  /** What the model asks for in each round, in order. */
  script: string[][];
  /**
   * A provider that returns tool calls in a round it was offered no tools for.
   * Rare, real, and the only way `planRound`'s halt branch is reached — the
   * executor's allowlist re-check (orbit-tools.ts) exists for the same reason.
   */
  echoesUnofferedTools?: boolean;
  expectModelRounds: number;
  expectExecuted: string[];
  expectHalted: boolean;
}

interface GateCase {
  id: string;
  kind: "gate";
  note: string;
  tool: string;
  consequential: boolean;
  executed: { outcome: "ok" | "error" | "awaiting_approval"; approvalId: string | null; gateObserved?: boolean };
  expectVerdict: string;
}

interface AgentLoopThresholds {
  loopAccuracyMin: number;
  toolRoundsMin: number;
  gateAccuracyMin: number;
  ungatedConsequentialMax: number;
}

/**
 * docs/27 F33 + F38. The agent loop was one tool round-trip: a completion, its
 * tool calls executed, then a second completion offered no tools at all. The
 * model could look a policy up and never act on what it read, and every
 * transcript that needed a second dependent step was silently truncated. In the
 * same loop, `consequential: true` was written to `ai_tool_calls` and branched
 * on by nothing.
 *
 * Both are decisions, not model outputs, so the golden set drives them directly
 * (`planRound`, `verdictFor` in src/agent-loop.ts). Scoring them here rather
 * than only in an API unit test is the point: an API test mocks the gateway and
 * the database, which is precisely how a loop that could not loop and a flag
 * that gated nothing both stayed green.
 *
 * `toolRounds` is the metric that fails against the old shape and cannot be
 * satisfied by a transcript that happens to fit in one round — it reads the
 * loop's own ceiling.
 */
async function scoreAgentLoop(dir: string): Promise<Metric[]> {
  const cases = await loadCases<LoopCase | GateCase>(dir);
  const thresholds = await loadThresholds<AgentLoopThresholds>(dir);

  const loops = cases.filter((c): c is LoopCase => c.kind === "loop");
  const gates = cases.filter((c): c is GateCase => c.kind === "gate");

  let loopHits = 0;
  for (const c of loops) {
    const executed: string[] = [];
    let round = 0;
    let halted = false;
    for (;;) {
      // The loop only ever sees tool calls it offered tools for.
      const asked = offersTools(round) || c.echoesUnofferedTools ? (c.script[round] ?? []) : [];
      const step = planRound({ round, toolCalls: asked.map((name) => ({ name })) });
      round += 1;
      if (step.action === "answer") break;
      if (step.action === "halt") {
        halted = true;
        break;
      }
      executed.push(...asked);
      if (round >= MAX_ROUNDS) {
        halted = true;
        break;
      }
    }
    const ok =
      round === c.expectModelRounds &&
      halted === c.expectHalted &&
      JSON.stringify(executed) === JSON.stringify(c.expectExecuted);
    if (ok) loopHits += 1;
    else
      console.log(
        `    ${c.id}: rounds ${round}/${c.expectModelRounds} halted ${halted}/${c.expectHalted} executed [${executed.join(", ")}] want [${c.expectExecuted.join(", ")}]`
      );
  }

  const verdicts = gates.map((c) => ({
    case: c,
    verdict: verdictFor({ consequential: c.consequential }, c.executed)
  }));
  for (const v of verdicts) {
    if (v.verdict !== v.case.expectVerdict) console.log(`    ${v.case.id}: ${v.verdict} want ${v.case.expectVerdict}`);
  }

  return [
    metric("loopAccuracy", loops.length ? loopHits / loops.length : 1, { min: thresholds.loopAccuracyMin }),
    metric("toolRounds", MAX_TOOL_ROUNDS, { min: thresholds.toolRoundsMin }),
    metric(
      "gateAccuracy",
      verdicts.length ? verdicts.filter((v) => v.verdict === v.case.expectVerdict).length / verdicts.length : 1,
      { min: thresholds.gateAccuracyMin }
    ),
    metric(
      "ungatedConsequentialEscapes",
      // Counted separately from gateAccuracy because it is the only direction
      // that lets a contract change unnoticed: mistaking a gated call for an
      // ungated one is a false alarm someone will chase, while the reverse is
      // an endorsement the tenant never agreed to.
      verdicts.filter((v) => v.case.expectVerdict === "ungated_consequential" && v.verdict !== "ungated_consequential")
        .length,
      { max: thresholds.ungatedConsequentialMax }
    )
  ];
}

interface FallbackCase {
  id: string;
  note: string;
  tier: "fast" | "standard" | "reasoning";
  onPrem?: boolean;
  needsTools?: boolean;
  modelKey?: string;
  overrides?: Record<string, string>;
  /** Providers whose credentials/bindings this deployment actually has. */
  configured: string[];
  expectKeys: string[];
}

interface FallbackThresholds {
  chainAccuracyMin: number;
  crossProviderCoverageMin: number;
  residencyBreachMax: number;
  sameProviderRepeatMax: number;
}

/**
 * docs/27 F36. `gateway.complete` retried three times against the identical
 * provider and the identical model, which answers a blip and nothing else: a
 * provider outage, a model deprecation or a regional 5xx took the whole
 * platform's AI down three times in a row and then gave up.
 *
 * The golden set is the routing decision, not a model's words, so it scores
 * `fallbackChain` directly. Four metrics, because "does it fall back" is not
 * the only thing that can go wrong:
 *   - chainAccuracy: the chain is exactly what the case expects.
 *   - crossProviderCoverage: every cloud case reaches a second *provider*.
 *     A chain of two Anthropic models is the defect with more steps.
 *   - residencyBreach: an on-prem tenant never gets a cloud link, whatever is
 *     configured and whatever the tenant override says (CLAUDE.md §3, ADR-0075).
 *   - sameProviderRepeat: no provider appears twice in one chain.
 */
async function scoreProviderFallback(dir: string): Promise<Metric[]> {
  const cases = await loadCases<FallbackCase>(dir);
  const thresholds = await loadThresholds<FallbackThresholds>(dir);

  const results = cases.map((c) => {
    const chain = fallbackChain(c.tier, {
      ...(c.onPrem === undefined ? {} : { onPrem: c.onPrem }),
      ...(c.needsTools === undefined ? {} : { needsTools: c.needsTools }),
      ...(c.modelKey === undefined ? {} : { modelKey: c.modelKey }),
      ...(c.overrides === undefined ? {} : { overrides: c.overrides as Record<"fast" | "standard" | "reasoning", string> }),
      configured: c.configured as never
    });
    return { case: c, chain };
  });

  const cloud = results.filter((r) => !r.case.onPrem && r.case.configured.length > 1);
  const onPrem = results.filter((r) => r.case.onPrem);

  const exact = results.filter((r) => JSON.stringify(r.chain.map((d) => d.key)) === JSON.stringify(r.case.expectKeys));
  const crossed = cloud.filter((r) => new Set(r.chain.map((d) => d.provider)).size > 1);
  const breaches = onPrem.filter((r) => r.chain.some((d) => d.provider !== "openai-compat"));
  const repeats = results.filter((r) => new Set(r.chain.map((d) => d.provider)).size !== r.chain.length);

  for (const r of results) {
    if (JSON.stringify(r.chain.map((d) => d.key)) !== JSON.stringify(r.case.expectKeys)) {
      console.log(`    ${r.case.id}: got [${r.chain.map((d) => d.key).join(", ")}] want [${r.case.expectKeys.join(", ")}]`);
    }
  }

  return [
    metric("chainAccuracy", results.length ? exact.length / results.length : 1, { min: thresholds.chainAccuracyMin }),
    metric("crossProviderCoverage", cloud.length ? crossed.length / cloud.length : 1, {
      min: thresholds.crossProviderCoverageMin
    }),
    metric("residencyBreaches", breaches.length, { max: thresholds.residencyBreachMax }),
    metric("sameProviderRepeats", repeats.length, { max: thresholds.sameProviderRepeatMax })
  ];
}

interface AxisCase {
  id: string;
  docType: string;
  locale: string;
  /** The model's structured reply — what `parseExtraction` (src/extract.ts) actually parses. */
  text: string;
  expected: Record<string, string>;
}

interface AxisThresholds {
  fieldAccuracyMin: number;
}

// docs/modules/axis.md §8: "EID + mulkiya extraction >= 95% field accuracy on
// test set (both languages)". No live model call here (evals stay
// deterministic/CI-safe, docs/13 §4) — cases.jsonl bakes in canned model
// replies (clean, code-fenced, missing/whitespace/case-noise) and this scores
// the exact `parseExtraction` the /documents/:id/extract route runs.
//
// Scored per locale, never pooled: docs/13 §3.3 reads "field-F1 >= 0.95 (ar+en
// separately)" precisely because a pooled number lets a strong English set
// carry a failing Arabic one. Whatever locales the cases carry become metrics —
// adding a third language adds its own gate rather than diluting the other two.
// Splitting them exposed exactly that: the authored failure modes (an omitted
// field, a transposed digit) sat only in the English cases, so a clean Arabic
// set was carrying English past the bar. Keep the sets symmetric — every
// failure mode one locale carries, the other carries too, or the parity number
// measures the golden set rather than the extractor.
async function scoreAxis(dir: string): Promise<Metric[]> {
  const cases = await loadCases<AxisCase>(dir);
  const thresholds = await loadThresholds<AxisThresholds>(dir);

  const tally = new Map<string, { correct: number; total: number }>();
  for (const c of cases) {
    const fields = EXTRACTION_FIELDS[c.docType] ?? Object.keys(c.expected);
    const { values } = parseExtraction(c.text, fields);
    const t = tally.get(c.locale) ?? { correct: 0, total: 0 };
    for (const field of fields) {
      t.total += 1;
      if (normalizeField(values[field] ?? null) === normalizeField(c.expected[field] ?? null)) t.correct += 1;
    }
    tally.set(c.locale, t);
  }

  return [...tally.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, t]) =>
      metric(`fieldAccuracy.${locale}`, t.total ? t.correct / t.total : 1, {
        min: thresholds.fieldAccuracyMin
      })
    );
}

interface AxisVisionCase {
  id: string;
  docType: string;
  /** The doc type actually on the rendered page — equal to docType except in the routing cases below. */
  actualDocType: string;
  locale: string;
  /** The model's structured reply — what `parseVisionExtraction` (src/extract.ts) actually parses. */
  text: string;
  expected: Record<string, string | null>;
}

interface AxisVisionThresholds {
  fieldAccuracyMin: number;
  pageRoutingAccuracyMin: number;
  hallucinatedFieldRateMax: number;
}

// docs/specs/gap-axis-design.md §G.5: fieldAccuracyMin carries over from
// scoreAxis but is now measured through parseVisionExtraction end-to-end from
// the image, not from supplied text. The route never asks the model to
// classify the doc type (apps/api/src/routes/axis.ts picks `before.docType`
// off the DB row before the call) — so pageRoutingAccuracy is scored as
// correct abstention: when docType != actualDocType (an intake mis-tag), every
// field must come back null rather than fabricate a match. hallucinatedFieldRate
// covers the partial-evidence guard in parseVisionExtraction (a value missing
// its page or bbox is forced null) — full-fabrication (a wrong value with
// complete, self-consistent evidence) has no ground truth to check
// deterministically and is left to the live eval (evals/live.ts).
async function scoreAxisVision(dir: string): Promise<Metric[]> {
  const cases = await loadCases<AxisVisionCase>(dir);
  const thresholds = await loadThresholds<AxisVisionThresholds>(dir);

  const tally = new Map<string, { correct: number; total: number }>();
  let hallucinated = 0;
  let nullOpportunities = 0;
  let mismatched = 0;
  let routedCorrectly = 0;

  for (const c of cases) {
    const fields = EXTRACTION_FIELDS[c.docType] ?? Object.keys(c.expected);
    const { values } = parseVisionExtraction(c.text, fields);

    if (c.docType === c.actualDocType) {
      const t = tally.get(c.locale) ?? { correct: 0, total: 0 };
      for (const field of fields) {
        t.total += 1;
        if (normalizeField(values[field]?.value ?? null) === normalizeField(c.expected[field] ?? null)) {
          t.correct += 1;
        }
      }
      tally.set(c.locale, t);
    } else {
      mismatched += 1;
      if (fields.every((field) => values[field]?.value === null)) routedCorrectly += 1;
    }

    for (const field of fields) {
      if (c.expected[field] !== null) continue;
      nullOpportunities += 1;
      if (values[field]?.value !== null) hallucinated += 1;
    }
  }

  const metrics = [...tally.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([locale, t]) =>
      metric(`fieldAccuracy.${locale}`, t.total ? t.correct / t.total : 1, { min: thresholds.fieldAccuracyMin })
    );

  metrics.push(
    metric("pageRoutingAccuracy", mismatched ? routedCorrectly / mismatched : 1, {
      min: thresholds.pageRoutingAccuracyMin
    })
  );
  metrics.push(
    metric("hallucinatedFieldRate", nullOpportunities ? hallucinated / nullOpportunities : 0, {
      max: thresholds.hallucinatedFieldRateMax
    })
  );

  return metrics;
}

interface FnolTriageCase {
  id: string;
  /** The model's structured reply — what `parseTriage` (src/triage.ts) actually parses. */
  text: string;
  expected: { perilCode: string | null; causeCode: string | null; complexity: string | null };
}

interface FnolTriageThresholds {
  fieldAccuracyMin: number;
}

const TRIAGE_FIELDS = ["perilCode", "causeCode", "complexity"] as const;

// docs/specs/gap-axis-design.md §G.1. No live model call (deterministic/CI-safe,
// docs/13 §4) — cases.jsonl bakes in canned model replies (clean, code-fenced,
// missing field, invalid enum value) and this scores the exact `parseTriage`
// that `triageFnol` (apps/api/src/engines/axis-fnol.ts) runs in production.
async function scoreFnolTriage(dir: string): Promise<Metric[]> {
  const cases = await loadCases<FnolTriageCase>(dir);
  const thresholds = await loadThresholds<FnolTriageThresholds>(dir);

  let correct = 0;
  let total = 0;
  for (const c of cases) {
    const triage = parseTriage(c.text);
    for (const field of TRIAGE_FIELDS) {
      total += 1;
      if (normalizeField(triage[field]) === normalizeField(c.expected[field])) correct += 1;
    }
  }

  return [metric("fieldAccuracy", total ? correct / total : 1, { min: thresholds.fieldAccuracyMin })];
}

interface ReserveCase {
  id: string;
  /** The model's structured reply — what `parseReserve` (src/reserve.ts) actually parses. */
  text: string;
  /** Ground truth the recommendation is scored against — what the claim actually settled for. */
  actualSettledMinor: number;
}

interface ReserveThresholds {
  medianAbsPctErrorMax: number;
  bandCoverageMin: number;
  overReserveBiasMax: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The shared shape of `unexplainedIndicatorRate` (scoreFraud) and
 * `unexplainedFactorRate` (scoreUbi): how much of a parser's drop behaviour the
 * golden set did not ask for, over every candidate the parser saw.
 *
 * Two decisions are baked in, both learned the hard way:
 *
 * 1. The denominator is *candidates* (`kept + dropped`), not the parser's kept
 *    array. Neither parser can leave an unevidenced item in its kept array by
 *    construction, so a rate measured against that array is a permanent zero that
 *    would not move if the drop guard were deleted outright.
 * 2. The numerator is `|dropped - expected|`, not raw drops. With a threshold of
 *    0.0, raw drops make the gate unsatisfiable for any golden set that actually
 *    contains an unevidenced item — so the set carries none, and the zero is
 *    vacuous again. This form pins the count exactly: a parser that stops
 *    dropping and one that starts over-dropping both fail.
 *
 * HISTORY: scoreFraud's metric used form (2) only from commit 9f231ab
 * ("fix(model-gateway): stop parsers throwing on valid non-object JSON", which
 * also added fraud-61..64). Before that its numerator was raw
 * `droppedIndicatorCount` over a golden set carrying no unevidenced indicator at
 * all — a structural zero. The gate is strictly stronger now, but a reading of
 * `unexplainedIndicatorRate` from before that commit is not the same measurement.
 * It lives in one function so the two rates cannot drift apart again.
 */
function unexplainedDropRate(rows: { kept: number; dropped: number; expected: number }[]): number {
  let candidates = 0;
  let unaccounted = 0;
  for (const r of rows) {
    unaccounted += Math.abs(r.dropped - r.expected);
    candidates += r.kept + r.dropped;
  }
  return candidates ? unaccounted / candidates : 0;
}

// docs/specs/gap-axis-design.md §G.3. No live model call (deterministic/CI-safe,
// docs/13 §4) — cases.jsonl bakes in canned model replies (clean, code-fenced,
// missing band, inverted band, extra properties, wrong types) plus each case's
// actual settled amount, scoring the exact `parseReserve` that
// `recommendReserve` (apps/api/src/engines/axis-reserve-advisor.ts) runs in production.
async function scoreReserve(dir: string): Promise<Metric[]> {
  const cases = await loadCases<ReserveCase>(dir);
  const thresholds = await loadThresholds<ReserveThresholds>(dir);

  const pctErrors: number[] = [];
  const biases: number[] = [];
  let bandedCases = 0;
  let covered = 0;

  for (const c of cases) {
    const rec = parseReserve(c.text);
    if (rec.recommendedMinor !== null && c.actualSettledMinor > 0) {
      pctErrors.push(Math.abs(rec.recommendedMinor - c.actualSettledMinor) / c.actualSettledMinor);
      biases.push((rec.recommendedMinor - c.actualSettledMinor) / c.actualSettledMinor);
    }
    if (rec.band) {
      bandedCases += 1;
      if (c.actualSettledMinor >= rec.band[0] && c.actualSettledMinor <= rec.band[1]) covered += 1;
    }
  }

  return [
    metric("medianAbsPctError", pctErrors.length ? median(pctErrors) : 1, { max: thresholds.medianAbsPctErrorMax }),
    metric("bandCoverage", bandedCases ? covered / bandedCases : 0, { min: thresholds.bandCoverageMin }),
    metric("overReserveBias", biases.length ? biases.reduce((a, b) => a + b, 0) / biases.length : 0, {
      max: thresholds.overReserveBiasMax
    })
  ];
}

interface FraudCase {
  id: string;
  text: string;
  expectFraud: boolean;
  cohort: string;
  /** Indicators the case deliberately leaves unevidenced; absent means none. */
  expectDroppedIndicators?: number;
}

interface FraudThresholds {
  precisionAtTop10Min: number;
  recallMin: number;
  unexplainedIndicatorRateMax: number;
  maxScoreDeltaByProtectedProxy: number;
}

// docs/specs/gap-axis-design.md §G.2. Mirrors apps/api/src/engines/axis-fraud-scorer.ts's
// SIU_REFERRAL_THRESHOLD — recall is measured at the same cutoff production uses to
// open a referral, not at some other cutoff that would score a different behaviour.
const SIU_REFERRAL_THRESHOLD = 60;

// No live model call (docs/13 §4) — cases.jsonl bakes in canned model replies plus
// each case's ground truth, scoring the exact `parseFraud` that
// scoreAndReferClaim (apps/api/src/engines/axis-fraud-scorer.ts) runs in production.
async function scoreFraud(dir: string): Promise<Metric[]> {
  const cases = await loadCases<FraudCase>(dir);
  const thresholds = await loadThresholds<FraudThresholds>(dir);

  const scored = cases.map((c) => ({ case: c, result: parseFraud(c.text) }));

  const top10 = [...scored].sort((a, b) => b.result.score - a.result.score).slice(0, 10);
  const precisionAtTop10 = top10.length ? top10.filter((s) => s.case.expectFraud).length / top10.length : 0;

  const positives = scored.filter((s) => s.case.expectFraud);
  const referred = positives.filter((s) => s.result.score >= SIU_REFERRAL_THRESHOLD).length;
  const recall = positives.length ? referred / positives.length : 1;

  // Definition, and the commit its numerator changed on, are on unexplainedDropRate.
  const unexplainedIndicatorRate = unexplainedDropRate(
    scored.map(({ case: c, result }) => ({
      kept: result.indicators.length,
      dropped: result.droppedIndicatorCount,
      expected: c.expectDroppedIndicators ?? 0
    }))
  );

  const metrics = [
    metric("precisionAtTop10", precisionAtTop10, { min: thresholds.precisionAtTop10Min }),
    metric("recall", recall, { min: thresholds.recallMin }),
    metric("unexplainedIndicatorRate", unexplainedIndicatorRate, { max: thresholds.unexplainedIndicatorRateMax })
  ];

  // Fairness is a claim about equal treatment of otherwise-similar claims, not
  // about whether genuinely fraudulent claims score high — so it's measured on
  // the clean cohort only (mirrors scoreCxQuality's "only when >=2 groups" gate).
  const byCohort = new Map<string, number[]>();
  for (const { case: c, result } of scored) {
    if (c.expectFraud) continue;
    byCohort.set(c.cohort, [...(byCohort.get(c.cohort) ?? []), result.score]);
  }
  const cohorts = [...byCohort.entries()].sort(([a], [b]) => a.localeCompare(b));
  if (cohorts.length >= 2) {
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    const means = cohorts.map(([, scores]) => mean(scores));
    const delta = Math.max(...means) - Math.min(...means);
    metrics.push(metric("maxScoreDeltaByProtectedProxy", delta, { max: thresholds.maxScoreDeltaByProtectedProxy }));
  }

  return metrics;
}

interface SlaCase {
  id: string;
  text: string;
  expectBreach: boolean;
  /** Hours remaining until the case's actual SLA deadline at the moment the prediction fired. */
  hoursToBreachAtPrediction: number;
}

interface SlaThresholds {
  aucMin: number;
  calibrationErrorMax: number;
  leadTimeMedianHoursMin: number;
}

// docs/specs/gap-axis-design.md §G.4 — same alert cutoff a Prioritiser/Chaser
// would eventually key off of; scored here purely to compute lead time.
const BREACH_ALERT_THRESHOLD = 50;

// No live model call (docs/13 §4), same as scoreFraud/scoreReserve — cases.jsonl
// bakes in canned model replies plus ground truth, scoring the exact `parseSla`
// that predictSlaBreach (apps/api/src/engines/axis-sla-sentinel.ts) runs in production.
async function scoreSla(dir: string): Promise<Metric[]> {
  const cases = await loadCases<SlaCase>(dir);
  const thresholds = await loadThresholds<SlaThresholds>(dir);

  const scored = cases.map((c) => ({ case: c, result: parseSla(c.text) }));

  const positives = scored.filter((s) => s.case.expectBreach);
  const negatives = scored.filter((s) => !s.case.expectBreach);
  let concordant = 0;
  for (const p of positives) {
    for (const n of negatives) {
      if (p.result.breachProbability > n.result.breachProbability) concordant += 1;
      else if (p.result.breachProbability === n.result.breachProbability) concordant += 0.5;
    }
  }
  const total = positives.length * negatives.length;
  const auc = total ? concordant / total : 1;

  const byPrediction = [...scored].sort((a, b) => a.result.breachProbability - b.result.breachProbability);
  const bucketSize = Math.max(1, Math.ceil(byPrediction.length / 10));
  const bucketErrors: number[] = [];
  for (let i = 0; i < byPrediction.length; i += bucketSize) {
    const bucket = byPrediction.slice(i, i + bucketSize);
    const meanPredicted = bucket.reduce((sum, s) => sum + s.result.breachProbability, 0) / bucket.length / 100;
    const observedBreachRate = bucket.filter((s) => s.case.expectBreach).length / bucket.length;
    bucketErrors.push(Math.abs(meanPredicted - observedBreachRate));
  }
  const calibrationError = bucketErrors.length ? bucketErrors.reduce((a, b) => a + b, 0) / bucketErrors.length : 0;

  const leadTimes = positives
    .filter((s) => s.result.breachProbability >= BREACH_ALERT_THRESHOLD)
    .map((s) => s.case.hoursToBreachAtPrediction);
  const leadTimeMedianHours = leadTimes.length ? median(leadTimes) : 0;

  return [
    metric("auc", auc, { min: thresholds.aucMin }),
    metric("calibrationError", calibrationError, { max: thresholds.calibrationErrorMax }),
    metric("leadTimeMedianHours", leadTimeMedianHours, { min: thresholds.leadTimeMedianHoursMin })
  ];
}

interface UbiCase {
  id: string;
  text: string;
  /** The sign the parsed delta must carry. */
  expectDirection: "up" | "down" | "flat";
  /** Factors the case deliberately leaves unevidenced; absent means none. */
  expectDroppedFactors?: number;
}

interface UbiThresholds {
  directionAccuracyMin: number;
  unexplainedFactorRateMax: number;
}

// docs/superpowers/specs/2026-08-16-revenue-lines-full-build-design.md (Group E).
// No live model call (deterministic/CI-safe, docs/13 §4) — cases.jsonl bakes in
// canned model replies (clean up/down/flat, code-fenced, unevidenced factors,
// out-of-range deltas, garbage, and replies carrying fields parseUbi does not
// model) and scores the exact `parseUbi` the UBI-REPRICE engine runs before it
// proposes a price change. See the note above the return for why there is no
// fairness metric here, unlike its sibling scorers.
async function scoreUbi(dir: string): Promise<Metric[]> {
  const cases = await loadCases<UbiCase>(dir);
  const thresholds = await loadThresholds<UbiThresholds>(dir);

  const scored = cases.map((c) => ({ case: c, result: parseUbi(c.text) }));

  const sign = (ppm: number): UbiCase["expectDirection"] => (ppm > 0 ? "up" : ppm < 0 ? "down" : "flat");
  const correct = scored.filter((s) => sign(s.result.premiumDeltaPpm) === s.case.expectDirection).length;

  // Definition on unexplainedDropRate; shared verbatim with scoreFraud.
  const unexplainedFactorRate = unexplainedDropRate(
    scored.map(({ case: c, result }) => ({
      kept: result.factors.length,
      dropped: result.droppedFactorCount,
      expected: c.expectDroppedFactors ?? 0
    }))
  );

  // NO FAIRNESS METRIC HERE, deliberately. scoreFraud and scoreCxQuality carry a
  // by-cohort spread gate; this scorer used to as well (maxDeltaPpmByProtectedProxy,
  // over ubi-18/ubi-19 — two canned replies identical but for a postcodeBand and a
  // driverAgeBand). It was removed because it could only ever report 0: parseUbi is
  // handed one string, reads six named fields off it and ignores the rest, so no
  // parser, prompt or model change could have moved that number. Reporting it as a
  // passing fairness gate claimed a guarantee this scorer does not measure.
  //
  // Where the two real controls live instead:
  //   - Exclusion (docs/12 §4, "pricing-adjacent models exclude protected
  //     attributes") is enforced at the input boundary — `UbiContext` (src/ubi.ts)
  //     carries only series keys, totals, point counts, baselines and a window, so
  //     no protected attribute or proxy reaches the model to be priced on.
  //   - That parseUbi stays blind to a proxy the model volunteers anyway is a purity
  //     invariant, unit-tested in src/ubi.test.ts ("never reads a protected proxy").
  // docs/12 §4 assigns proxy detection itself to a quarterly audit with logged
  // findings and remediation owners — a review control, not a parser filter. Adding
  // one here would mean this package deciding which factor codes name a protected
  // attribute, which docs/12 does not define and CLAUDE.md forbids us inventing.
  return [
    metric("directionAccuracy", cases.length ? correct / cases.length : 1, {
      min: thresholds.directionAccuracyMin
    }),
    metric("unexplainedFactorRate", unexplainedFactorRate, {
      max: thresholds.unexplainedFactorRateMax
    })
  ];
}

interface CxQualityCase {
  id: string;
  locale: string;
  context: string[];
  reply: string;
  /** One entry per judge run — `CX_JUDGE_SAMPLES` of them (docs/13 §3.4). */
  judgeReplies: string[];
  /** Absent means true. false for a reply the rubric must mark down (ADR-0074). */
  expectPass?: boolean;
}

interface CxQualityThresholds {
  rubricMin: number;
  parityGapMax: number;
  /** Ceiling the marked-down replies must stay under. */
  rejectMax: number;
  /** Fraction of samples that must produce a usable score at all. */
  scoredMin: number;
}

// docs/13 §3.3: "CX quality rubric >= 4.2/5 (ar+en separately — parity gap
// <= 0.2)". Scores the exact judge in packages/model-gateway/src/cx-judge.ts.
// The judge replies are canned for the same reason the axis model replies are:
// a gate that calls a live model is not a gate. That makes this task a parser
// regression and nothing more — it cannot see a prompt edit or a model swap.
// `live-cx-quality` in evals/live.ts is the other half, running the same rubric
// through a real judge; and docs/12 §4's weekly re-score over sampled
// production conversations is the third, which is ops.
async function scoreCxQuality(dir: string): Promise<Metric[]> {
  const cases = await loadCases<CxQualityCase>(dir);
  const thresholds = await loadThresholds<CxQualityThresholds>(dir);

  // Same aggregation the live task uses (`cxRubricSummary`), so the two halves
  // of the CX gate cannot drift apart on the arithmetic — they differ only in
  // where the score came from.
  const summary = cxRubricSummary(
    cases.map((c) => ({
      locale: c.locale,
      score: aggregateCxScore(c.judgeReplies),
      expectPass: c.expectPass !== false
    }))
  );

  const metrics = summary.perLocale.map(([locale, value]) =>
    metric(`rubric.${locale}`, value, { min: thresholds.rubricMin })
  );

  // The gap is only meaningful between two languages; with one locale in the
  // set there is no parity claim to make, so the metric stays off rather than
  // reporting a flattering zero.
  if (summary.parityGap) {
    const [a, b, gap] = summary.parityGap;
    metrics.push(metric(`parityGap.${a}-${b}`, gap, { max: thresholds.parityGapMax }));
  }

  // ADR-0074. Without a reject side this task gated the mean and nothing else:
  // the accuracy cap could be deleted and every metric here would stay green.
  if (summary.worstReject !== null) {
    metrics.push(metric("reject", summary.worstReject, { max: thresholds.rejectMax }));
  }

  // A judge that stops returning parseable scores would otherwise show up as a
  // suspiciously good run over the handful of samples that still worked.
  metrics.push(metric("scoredRate", summary.scoredRate, { min: thresholds.scoredMin }));
  return metrics;
}

interface NorthCase {
  id: string;
  snapshot: BriefingSnapshot;
  text: string;
  expectOk: boolean;
}

interface NorthThresholds {
  recallMin: number;
  falsePositiveMax: number;
}

// docs/15 §4 inspectability gate for NORTH briefings: every number the model
// writes must trace back to the snapshot. Scores the exact `verifyNumericClaims`
// packages/core/src/narrator-verify.ts exports — the same function
// apps/api/src/engines/narrator.ts runs post-generation, so this eval and
// production share one implementation (docs/13 §3, no scorer duplicate).
async function scoreNorth(dir: string): Promise<Metric[]> {
  const cases = await loadCases<NorthCase>(dir);
  const thresholds = await loadThresholds<NorthThresholds>(dir);
  const violations = cases.filter((c) => !c.expectOk);
  const clean = cases.filter((c) => c.expectOk);

  const caught = violations.filter((c) => !verifyNumericClaims(c.text, c.snapshot).ok).length;
  const falseFlags = clean.filter((c) => !verifyNumericClaims(c.text, c.snapshot).ok).length;

  return [
    metric("recall", violations.length ? caught / violations.length : 1, { min: thresholds.recallMin }),
    metric("falsePositiveRate", clean.length ? falseFlags / clean.length : 0, { max: thresholds.falsePositiveMax })
  ];
}

interface SignalCase {
  id: string;
  text: string;
  expectFlag: boolean;
  expectRule: string | null;
}

interface SignalThresholds {
  hardBlockRecallMin: number;
  falsePositiveMax: number;
}

// docs/modules/signal.md §2.1 Compliance Pre-flight: scores the exact
// `checkCompliance` packages/core/src/signal-compliance.ts exports — the same
// function apps/api/src/engines/signal-creative.ts runs per generated variant,
// so this eval and production share one implementation (docs/13 §3).
async function scoreSignal(dir: string): Promise<Metric[]> {
  const cases = await loadCases<SignalCase>(dir);
  const thresholds = await loadThresholds<SignalThresholds>(dir);
  const flagged = cases.filter((c) => c.expectFlag);
  const clean = cases.filter((c) => !c.expectFlag);

  const caught = flagged.filter((c) => checkSignalCompliance(c.text).status === "flagged").length;
  const falseFlags = clean.filter((c) => checkSignalCompliance(c.text).status === "flagged").length;

  return [
    metric("hardBlockRecall", flagged.length ? caught / flagged.length : 1, { min: thresholds.hardBlockRecallMin }),
    metric("falsePositiveRate", clean.length ? falseFlags / clean.length : 0, { max: thresholds.falsePositiveMax })
  ];
}

interface GroundednessCase {
  id: string;
  contextLines: string[];
  text: string;
  expectOk: boolean;
}
interface GroundednessThresholds {
  recallMin: number;
  falsePositiveMax: number;
}

/**
 * The gate for any surface whose rule is "state no number the context did not
 * give you". Two golden sets run through it: AXIS's case copilot
 * (routes/axis.ts) and ORBIT's reply drafter (engines/orbit-draft.ts), both of
 * which call verifyGroundedness over their own context lines before a human
 * ever sees the text — one scorer, because it is one function being scored.
 */
async function scoreGroundedness(dir: string): Promise<Metric[]> {
  const cases = await loadCases<GroundednessCase>(dir);
  const thresholds = await loadThresholds<GroundednessThresholds>(dir);
  const violations = cases.filter((c) => !c.expectOk);
  const clean = cases.filter((c) => c.expectOk);
  const caught = violations.filter((c) => !verifyGroundedness(c.text, c.contextLines).ok).length;
  const falseFlags = clean.filter((c) => !verifyGroundedness(c.text, c.contextLines).ok).length;
  return [
    metric("recall", violations.length ? caught / violations.length : 1, { min: thresholds.recallMin }),
    metric("falsePositiveRate", clean.length ? falseFlags / clean.length : 0, { max: thresholds.falsePositiveMax })
  ];
}

interface WhitespaceBriefCase {
  id: string;
  evidence: WhitespaceEvidence;
  text: string;
  /** Whether `parseWhitespaceBrief` should return a brief at all. */
  expectParsed: boolean;
  /** Present only on cases that parse. */
  expectObjective?: string;
  expectConfidence?: number;
  /** Marks a case rejected specifically for stating a number the evidence lacked. */
  ungrounded?: boolean;
}
interface WhitespaceBriefThresholds {
  parseRateMin: number;
  ungroundedAcceptMax: number;
  objectiveAccuracyMin: number;
  confidenceAccuracyMin: number;
}

/**
 * SCOUT whitespace -> SIGNAL brief (src/whitespace-brief.ts). Canned replies, no
 * live call, same posture as scoreReserve/scoreSla.
 *
 * `ungroundedAcceptRate` is the one that matters: a brief that states an invented
 * demand figure gets persisted, shown with a ✦ and then generates creative copy
 * off the invention, so the max is 0 and never moves.
 */
async function scoreWhitespaceBrief(dir: string): Promise<Metric[]> {
  const cases = await loadCases<WhitespaceBriefCase>(dir);
  const thresholds = await loadThresholds<WhitespaceBriefThresholds>(dir);
  const nouns = promptNouns(undefined);

  const scored = cases.map((c) => ({ case: c, brief: parseWhitespaceBrief(c.text, c.evidence, nouns) }));
  const parsedAsExpected = scored.filter((s) => (s.brief !== null) === s.case.expectParsed).length;
  const ungrounded = scored.filter((s) => s.case.ungrounded);
  const ungroundedAccepted = ungrounded.filter((s) => s.brief !== null).length;

  const withObjective = scored.filter((s) => s.case.expectObjective !== undefined);
  const objectiveHits = withObjective.filter((s) => s.brief?.objective === s.case.expectObjective).length;
  const withConfidence = scored.filter((s) => s.case.expectConfidence !== undefined);
  const confidenceHits = withConfidence.filter((s) => s.brief?.confidence === s.case.expectConfidence).length;

  return [
    metric("parseRate", cases.length ? parsedAsExpected / cases.length : 0, { min: thresholds.parseRateMin }),
    metric("ungroundedAcceptRate", ungrounded.length ? ungroundedAccepted / ungrounded.length : 0, {
      max: thresholds.ungroundedAcceptMax
    }),
    metric("objectiveAccuracy", withObjective.length ? objectiveHits / withObjective.length : 0, {
      min: thresholds.objectiveAccuracyMin
    }),
    metric("confidenceAccuracy", withConfidence.length ? confidenceHits / withConfidence.length : 0, {
      min: thresholds.confidenceAccuracyMin
    })
  ];
}

interface AudienceProposalCase {
  id: string;
  evidence: AudienceEvidence;
  text: string;
  /** Whether `parseAudienceProposal` should return a proposal at all. */
  expectParsed: boolean;
  /** Present only on cases that parse: the accepted cells as `axis=value`. */
  expectDemographics?: string[];
  expectReach?: number;
  expectConfidence?: number;
  /** Marks a case rejected specifically for stating a number the evidence lacked. */
  ungrounded?: boolean;
}
interface AudienceProposalThresholds {
  parseRateMin: number;
  ungroundedAcceptMax: number;
  protectedAcceptMax: number;
  demographicAccuracyMin: number;
  reasonCoverageMin: number;
  confidenceAccuracyMin: number;
}

/**
 * SIGNAL targeting proposal (src/audience-brief.ts). Canned replies, no live
 * call, same posture as scoreWhitespaceBrief.
 *
 * Two of these gates are not quality measures and do not move. `protectedAcceptRate`
 * is SIG-034: one protected axis surviving into a rule is a campaign that targets
 * on religion or health, so the max is 0 over every case, not only the ones that
 * try it. `reasonCoverage` is the same kind of gate for a different reason — an
 * unexplained band is one a human cannot approve, and a proposal that reaches the
 * approver with a bare `lsm=7` and no "why" has failed even if the pick was good.
 */
async function scoreAudienceProposal(dir: string): Promise<Metric[]> {
  const cases = await loadCases<AudienceProposalCase>(dir);
  const thresholds = await loadThresholds<AudienceProposalThresholds>(dir);
  const nouns = promptNouns(undefined);

  const scored = cases.map((c) => ({ case: c, out: parseAudienceProposal(c.text, c.evidence, nouns) }));
  const parsedAsExpected = scored.filter((s) => (s.out !== null) === s.case.expectParsed).length;

  const ungrounded = scored.filter((s) => s.case.ungrounded);
  const ungroundedAccepted = ungrounded.filter((s) => s.out !== null).length;

  const parsed = scored.filter((s) => s.out !== null);
  const leaked = parsed.filter((s) =>
    (s.out?.demographics ?? []).some((d) => (PROTECTED_AXES as readonly string[]).includes(d.axis))
  ).length;
  const reasoned = parsed.filter((s) => {
    const out = s.out!;
    return (
      out.reasons.length === out.demographics.length &&
      out.reasons.every((r) => r.reason.trim().length > 0) &&
      out.demographics.every((d) => out.reasons.some((r) => r.axis === d.axis && r.value === d.value))
    );
  }).length;

  const withDemographics = scored.filter((s) => s.case.expectDemographics !== undefined);
  const demographicHits = withDemographics.filter((s) => {
    const got = (s.out?.demographics ?? []).map((d) => `${d.axis}=${d.value}`);
    const want = s.case.expectDemographics ?? [];
    const setMatch = got.length === want.length && want.every((w) => got.includes(w));
    return setMatch && (s.case.expectReach === undefined || s.out?.estimatedReach === s.case.expectReach);
  }).length;

  const withConfidence = scored.filter((s) => s.case.expectConfidence !== undefined);
  const confidenceHits = withConfidence.filter((s) => s.out?.confidence === s.case.expectConfidence).length;

  return [
    metric("parseRate", cases.length ? parsedAsExpected / cases.length : 0, { min: thresholds.parseRateMin }),
    metric("ungroundedAcceptRate", ungrounded.length ? ungroundedAccepted / ungrounded.length : 0, {
      max: thresholds.ungroundedAcceptMax
    }),
    metric("protectedAcceptRate", parsed.length ? leaked / parsed.length : 0, {
      max: thresholds.protectedAcceptMax
    }),
    metric("demographicAccuracy", withDemographics.length ? demographicHits / withDemographics.length : 0, {
      min: thresholds.demographicAccuracyMin
    }),
    metric("reasonCoverage", parsed.length ? reasoned / parsed.length : 0, { min: thresholds.reasonCoverageMin }),
    metric("confidenceAccuracy", withConfidence.length ? confidenceHits / withConfidence.length : 0, {
      min: thresholds.confidenceAccuracyMin
    })
  ];
}

interface CampaignPlanCase {
  id: string;
  text: string;
  evidence: CampaignPlanEvidence;
  expectParsed: boolean;
  ungrounded?: boolean;
  expectOptions?: number;
  expectRecommended?: string;
  expectProbabilities?: number[];
  expectConfidence?: number;
}

interface CampaignPlanThresholds {
  parseRateMin: number;
  ungroundedAcceptMax: number;
  optionAccuracyMin: number;
  rankingAccuracyMin: number;
  channelValidityMin: number;
  whyCoverageMin: number;
  confidenceAccuracyMin: number;
}

/**
 * The gate on the three-option campaign plan (src/campaign-plan.ts).
 *
 * A plan is what a human funds, so the failure that matters is not a clumsy
 * option — it is a *confident* one. Three of these thresholds are therefore not
 * quality measures and do not move:
 *
 * `ungroundedAcceptRate` — the model may not argue a probability from a figure
 * nobody measured. Its own probability is its judgement and is exempt; every
 * other number has to trace back to the evidence.
 * `channelValidity` — a plan naming a channel the tenant cannot buy is a plan
 * nobody can run, however good the idea reads.
 * `whyCoverage` — an option with a probability and no reasons is a number with
 * nothing behind it, and an approver cannot argue with it.
 *
 * `rankingAccuracy` is the one that keeps the *rest* of the system honest: the
 * copy generator writes against `recommended`, so if ranking and recommendation
 * ever disagree, the campaign that ships is not the campaign that was approved.
 */
async function scoreCampaignPlan(dir: string): Promise<Metric[]> {
  const cases = await loadCases<CampaignPlanCase>(dir);
  const thresholds = await loadThresholds<CampaignPlanThresholds>(dir);
  const nouns = promptNouns(undefined);

  const scored = cases.map((c) => ({ case: c, out: parseCampaignPlan(c.text, c.evidence, nouns) }));
  const parsedAsExpected = scored.filter((s) => (s.out !== null) === s.case.expectParsed).length;

  const ungrounded = scored.filter((s) => s.case.ungrounded);
  const ungroundedAccepted = ungrounded.filter((s) => s.out !== null).length;

  const parsed = scored.filter((s) => s.out !== null);

  const expected = scored.filter((s) => s.case.expectOptions !== undefined);
  const optionHits = expected.filter((s) => {
    const out = s.out;
    if (!out || out.options.length !== s.case.expectOptions) return false;
    const wantProbs = s.case.expectProbabilities;
    const wantName = s.case.expectRecommended;
    return (
      (wantProbs === undefined ||
        (out.options.length === wantProbs.length && out.options.every((o, i) => o.probability === wantProbs[i]))) &&
      (wantName === undefined || out.recommended === wantName)
    );
  }).length;

  const ranked = parsed.filter((s) => {
    const out = s.out!;
    const descending = out.options.every((o, i) => i === 0 || o.probability <= out.options[i - 1]!.probability);
    return descending && out.recommended === out.options[0]!.name;
  }).length;

  const channelClean = parsed.filter((s) =>
    s.out!.options.every(
      (o) => o.channels.length > 0 && o.channels.every((c) => (CAMPAIGN_CHANNELS as readonly string[]).includes(c))
    )
  ).length;

  const whyCovered = parsed.filter((s) =>
    s.out!.options.every((o) => o.why.length > 0 && o.why.every((w) => w.trim().length > 0))
  ).length;

  const withConfidence = scored.filter((s) => s.case.expectConfidence !== undefined);
  const confidenceHits = withConfidence.filter((s) => s.out?.confidence === s.case.expectConfidence).length;

  return [
    metric("parseRate", cases.length ? parsedAsExpected / cases.length : 0, { min: thresholds.parseRateMin }),
    metric("ungroundedAcceptRate", ungrounded.length ? ungroundedAccepted / ungrounded.length : 0, {
      max: thresholds.ungroundedAcceptMax
    }),
    metric("optionAccuracy", expected.length ? optionHits / expected.length : 0, {
      min: thresholds.optionAccuracyMin
    }),
    metric("rankingAccuracy", parsed.length ? ranked / parsed.length : 0, { min: thresholds.rankingAccuracyMin }),
    metric("channelValidity", parsed.length ? channelClean / parsed.length : 0, {
      min: thresholds.channelValidityMin
    }),
    metric("whyCoverage", parsed.length ? whyCovered / parsed.length : 0, { min: thresholds.whyCoverageMin }),
    metric("confidenceAccuracy", withConfidence.length ? confidenceHits / withConfidence.length : 0, {
      min: thresholds.confidenceAccuracyMin
    })
  ];
}

const SCORERS: Record<string, (dir: string) => Promise<Metric[]>> = {
  injection: scoreInjection,
  "creative-image": scoreInjection,
  compliance: scoreCompliance,
  "provider-fallback": scoreProviderFallback,
  "agent-loop": scoreAgentLoop,
  "guardrails-ar": scoreArabicGuardrails,
  axis: scoreAxis,
  "axis-vision": scoreAxisVision,
  "axis-copilot": scoreGroundedness,
  "orbit-draft": scoreGroundedness,
  "axis-fnol-triage": scoreFnolTriage,
  "axis-reserve": scoreReserve,
  "axis-fraud": scoreFraud,
  "axis-sla": scoreSla,
  "ubi-reprice": scoreUbi,
  "cx-quality": scoreCxQuality,
  north: scoreNorth,
  signal: scoreSignal,
  "scout-whitespace": scoreWhitespaceBrief,
  "signal-audience": scoreAudienceProposal,
  "campaign-plan": scoreCampaignPlan,
  // The commentary a hover shows is `verifyGroundedness` over the candidate's own
  // evidence lines — the same function axis-copilot/orbit-draft are gated on, so
  // the same scorer, not a third copy of it.
  "scout-commentary": scoreGroundedness,
  // ADR-0073: the command loop's answers are gated on the same rule — state no
  // number the tool results did not give you, and never claim a proposal was
  // executed. The context lines are the loop's tool results verbatim.
  "command-center": scoreGroundedness
};

async function main(): Promise<void> {
  const tasks = (await readdir(EVALS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const live = process.env["LYRA_EVAL_LIVE"] === "1";

  let failed = false;

  for (const task of tasks) {
    const isLive = Boolean(LIVE_SCORERS[task]);
    if (isLive && !live) {
      console.log(`\n${task}\n  skipped: live eval, run \`pnpm eval:live\` (LYRA_EVAL_LIVE=1)`);
      continue;
    }
    const scorer = SCORERS[task] ?? LIVE_SCORERS[task];
    if (!scorer) {
      // docs/27 F10: a golden set nobody scores is worse than no golden set —
      // it reads as coverage. An unregistered directory fails the gate.
      console.error(`\n${task}\n  FAIL no scorer registered in evals/run.ts or evals/live.ts`);
      failed = true;
      continue;
    }
    console.log(`\n${task}`);
    let metrics: Metric[];
    try {
      metrics = await scorer(join(EVALS_DIR, task));
    } catch (err) {
      // Includes "live requested but no credentials": with the flag on, a run
      // that cannot reach a model is a failure, never a silent pass.
      console.error(`  FAIL ${(err as Error).message}`);
      failed = true;
      continue;
    }
    for (const m of metrics) {
      const ok = metricOk(m);
      if (!ok) failed = true;
      const bound = m.min > -Infinity ? `>= ${m.min}` : `<= ${m.max}`;
      console.log(`  ${ok ? "PASS" : "FAIL"} ${m.name} = ${m.value.toFixed(3)} (need ${bound})`);
    }
  }

  if (failed) {
    console.error("\neval gate: FAILED");
    process.exit(1);
  }
  console.log("\neval gate: passed");
}

main();

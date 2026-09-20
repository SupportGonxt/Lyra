import { and, desc, eq, gte, inArray, like } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, type Ctx } from "@lyra/core";
import { blocked, checkInput, checkOutput } from "@lyra/model-gateway";

// docs/12 §4 ("drift monitors sample production weekly; Arabic/English parity
// is a tracked metric, not an aspiration") and docs/13 §3.5 ("Production
// drift: weekly sampled re-scores; regression opens an incident with the
// failing samples attached"). Both sentences stood with nothing behind them:
// docs/27 F47. The eval suite scores a golden set that never changes, which
// answers "is the code still right" and says nothing at all about whether the
// model, the prompts and the traffic have moved since the week it was written.
//
// What this sweep is, precisely, matters more than what it samples.
//
// Production has no labels. There is no ground truth against which a sampled
// reply is correct, so a re-score cannot report accuracy and a threshold from
// docs/13 §3.3 ("compliance classifier recall >= 0.98") cannot be applied to
// it — that number is a property of a labelled set. What production does have
// is a *rate*: the share of sampled output that trips no blocking guardrail.
// A rate is meaningless as a level and highly meaningful as a movement, so the
// gate here is movement. A week that scores materially below the last recorded
// week fails; the first week for a locale records the baseline and passes.
// Calling this "recall" would be the kind of borrowed number docs/29 was
// written about.
//
// The scorers are the deterministic ones the eval suite already gates on —
// `checkOutput` for what we said, `checkInput` for what was said to us — and
// deliberately nothing that calls a model. A monitor that spends an inference
// per sample, per tenant, per week, to watch inference costs is a cost spiral,
// and the two gates that decide whether a sentence may reach a customer are
// exactly the two that need no model to run.
//
// The result lands in `ai_evals`, the table the eval scoreboard already reads
// (seed/admin.ts writes the CI rows, resources.ts exposes them at
// /v1/ai/evals), so a drift regression shows up beside the suite it drifted
// from with no new screen and no new table. A failing row *is* the incident
// record docs/13 asks for, and `detailJson` carries the message ids of the
// samples that tripped — the "failing samples attached" half, which is the
// half that makes it actionable rather than alarming.

/** Suites are prefixed so a drift row can never be mistaken for a CI eval row. */
export const DRIFT_SUITE_PREFIX = "drift.";

/** The window each run samples, and — see `weekOf` — the cadence itself. */
export const DRIFT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Samples per suite per run, newest first. */
export const DRIFT_SAMPLE = 100;

/**
 * Points of clean-rate a locale may lose against its own last recorded week
 * before the row is written `passed: false`.
 *
 * Five, not zero: these rates are computed over at most `DRIFT_SAMPLE`
 * messages, so a single extra trip in a 40-message week moves the number 2.5
 * points on its own. A monitor that opens an incident for sampling noise is a
 * monitor somebody turns off.
 */
export const DRIFT_TOLERANCE = 5;

/**
 * Below this many samples a locale is recorded but never failed. A 3-message
 * week whose rate "fell" from 100 to 67 has not drifted, it has had a quiet
 * week — and for a bilingual product that is the normal state of the smaller
 * locale, which is precisely the one the parity metric exists to watch.
 */
export const DRIFT_MIN_SAMPLE = 10;

export interface DriftScore {
  suite: string;
  locale: string;
  /** Share of samples tripping no blocking guardrail, 0-100. */
  score: number;
  sampled: number;
  /** The prior week's score for this suite+locale, or null on the first run. */
  baseline: number | null;
  passed: boolean;
  /** Refs of the samples that tripped, with the rule each tripped. */
  failing: Array<{ ref: string; rule: string }>;
}

/** The epoch week an instant falls in — the run's identity, so a cron that
 *  fires every few minutes still produces exactly one run per week. */
function weekOf(now: number): number {
  return Math.floor(now / DRIFT_WINDOW_MS);
}

/**
 * Re-score a sample of this tenant's production AI traffic and record one
 * `ai_evals` row per suite per locale. Returns the scores written, or an empty
 * array when this week's run already happened.
 *
 * Idempotent on the week, not on the tick: `caseKey` ends in the epoch week, so
 * a second call inside the same week finds its own row and does nothing. That
 * is the same shape as every other sweep on the cron tick — a missed tick costs
 * latency and nothing else — with the addition that a *repeated* tick must not
 * cost a second row, because the row is the baseline the next week compares to.
 */
export async function sweepAiDrift(ctx: Ctx): Promise<DriftScore[]> {
  const week = weekOf(ctx.now);
  const since = ctx.now - DRIFT_WINDOW_MS;

  const [already] = await ctx.db
    .select({ id: schema.aiEvals.id })
    .from(schema.aiEvals)
    .where(
      and(
        eq(schema.aiEvals.tenantId, ctx.tenantId),
        like(schema.aiEvals.suite, `${DRIFT_SUITE_PREFIX}%`),
        like(schema.aiEvals.caseKey, `%:w${week}`)
      )
    )
    .limit(1);
  if (already) return [];

  // `lang` is the conversation's own language as ORBIT stored it, not a
  // resolved locale: this groups by what was actually written, which is the
  // only thing a parity claim can honestly be made about.
  const turns = await ctx.db
    .select({
      id: schema.orbitMessages.id,
      role: schema.orbitMessages.role,
      content: schema.orbitMessages.content,
      auditId: schema.orbitMessages.aiAuditId,
      lang: schema.orbitConversations.lang
    })
    .from(schema.orbitMessages)
    .innerJoin(
      schema.orbitConversations,
      and(
        eq(schema.orbitConversations.id, schema.orbitMessages.conversationId),
        eq(schema.orbitConversations.tenantId, ctx.tenantId)
      )
    )
    .where(and(eq(schema.orbitMessages.tenantId, ctx.tenantId), gte(schema.orbitMessages.ts, since)))
    .orderBy(desc(schema.orbitMessages.ts))
    .limit(DRIFT_SAMPLE * 4);

  const authored = turns.filter((t) => t.role === "agent_ai").slice(0, DRIFT_SAMPLE);
  const inbound = turns.filter((t) => t.role === "customer").slice(0, DRIFT_SAMPLE);
  if (!authored.length && !inbound.length) return [];

  const scores = [
    // What we said. `customerFacing: true` on purpose: these are turns that
    // reached, or were drafted to reach, a customer, and severity is a property
    // of provenance (guardrails.ts) — scoring them as internal would report a
    // warn where production would have blocked.
    ...score(`${DRIFT_SUITE_PREFIX}compliance`, authored, (text) => {
      const hits = checkOutput({ text, issued: new Set(), customerFacing: true });
      // Only a block counts against the rate. A warn is information the
      // guardrail row already carries; folding it in here would make the score
      // move for reasons production did not act on.
      return blocked(hits) ? (hits.find((h) => h.severity === "block")?.rule ?? "blocked") : null;
    }),
    // What was said to us. A rise in trips is either a real campaign against
    // the assistant or a pattern that started over-matching; both are things
    // the week they started is worth knowing.
    ...score(`${DRIFT_SUITE_PREFIX}injection`, inbound, (text) => checkInput(text)[0]?.rule ?? null)
  ];

  const model = await modelOf(ctx, authored.map((t) => t.auditId));

  const rows = [];
  for (const s of scores) {
    const baseline = await priorScore(ctx, s.suite, s.locale, week);
    s.baseline = baseline;
    // A floor of 0 rather than a negative threshold: `thresholdScore` is what
    // the row claims it had to clear, and a row claiming it had to clear -3 is
    // not readable by the person the scoreboard is for.
    const floor = baseline === null ? 0 : Math.max(0, baseline - DRIFT_TOLERANCE);
    s.passed = s.sampled < DRIFT_MIN_SAMPLE || baseline === null || s.score >= floor;
    rows.push({
      id: newId("evl", ctx.now + rows.length),
      tenantId: ctx.tenantId,
      suite: s.suite,
      caseKey: `${s.locale}:w${week}`,
      agentKey: "drift-monitor",
      model,
      score: s.score,
      passed: s.passed,
      thresholdScore: floor,
      detailJson: JSON.stringify({
        sampled: s.sampled,
        baseline: s.baseline,
        windowStart: since,
        // The "failing samples attached" of docs/13 §3.5. Refs, never the text:
        // a customer's own words are not audit-scoreboard content, and the
        // message id resolves to them for anyone who may read them.
        failing: s.failing.slice(0, 20),
        ...(s.sampled < DRIFT_MIN_SAMPLE ? { note: "sample below DRIFT_MIN_SAMPLE; recorded, not gated" } : {})
      }),
      gitSha: null,
      ts: ctx.now
    });
  }

  if (!rows.length) return [];
  await ctx.db.insert(schema.aiEvals).values(rows);

  await audit(ctx, {
    action: "ai.drift.sweep",
    subjectRef: `ai_evals:drift:w${week}`,
    after: {
      week,
      scored: scores.map((s) => ({
        suite: s.suite,
        locale: s.locale,
        score: s.score,
        sampled: s.sampled,
        baseline: s.baseline,
        passed: s.passed
      }))
    }
  });

  return scores;
}

/** One `DriftScore` per locale present in `samples`. `trip` returns the rule a
 *  sample broke, or null when it is clean. */
function score(
  suite: string,
  samples: ReadonlyArray<{ id: string; content: string; lang: string }>,
  trip: (text: string) => string | null
): DriftScore[] {
  const byLocale = new Map<string, DriftScore>();
  for (const sample of samples) {
    const locale = sample.lang;
    const entry = byLocale.get(locale) ?? {
      suite,
      locale,
      score: 0,
      sampled: 0,
      baseline: null,
      passed: true,
      failing: []
    };
    entry.sampled += 1;
    const rule = trip(sample.content);
    if (rule) entry.failing.push({ ref: sample.id, rule });
    byLocale.set(locale, entry);
  }
  for (const entry of byLocale.values()) {
    entry.score = Math.round(((entry.sampled - entry.failing.length) / entry.sampled) * 100);
  }
  // Sorted so a run's rows are stable across ticks and across databases — an
  // unordered Map iteration would make two identical weeks read differently.
  return [...byLocale.values()].sort((a, b) => a.locale.localeCompare(b.locale));
}

/** The most recent score recorded for this suite+locale before this week. */
async function priorScore(ctx: Ctx, suite: string, locale: string, week: number): Promise<number | null> {
  const [prior] = await ctx.db
    .select({ score: schema.aiEvals.score, caseKey: schema.aiEvals.caseKey })
    .from(schema.aiEvals)
    .where(
      and(
        eq(schema.aiEvals.tenantId, ctx.tenantId),
        eq(schema.aiEvals.suite, suite),
        like(schema.aiEvals.caseKey, `${locale}:w%`)
      )
    )
    .orderBy(desc(schema.aiEvals.ts))
    .limit(1);
  // Guard against comparing this week to itself if a partial run ever lands:
  // the caller's `already` check covers the whole sweep, this covers the row.
  if (!prior || prior.caseKey === `${locale}:w${week}`) return null;
  return prior.score;
}

/**
 * Which model produced the sampled turns, since "thresholds gate
 * provider/model changes" (docs/12 §4) is unanswerable from a score that does
 * not say what it scored. One model is named; a mixed week says so rather than
 * picking a winner, because the whole point of the column is that a reader can
 * tell whether a swap explains the movement.
 */
async function modelOf(ctx: Ctx, auditIds: ReadonlyArray<string | null>): Promise<string> {
  const ids = auditIds.filter((v): v is string => Boolean(v));
  if (!ids.length) return "unknown";
  const rows = await ctx.db
    .select({ model: schema.aiAuditLog.model })
    .from(schema.aiAuditLog)
    .where(and(eq(schema.aiAuditLog.tenantId, ctx.tenantId), inArray(schema.aiAuditLog.id, ids)));
  const distinct = [...new Set(rows.map((r) => r.model))].sort();
  if (!distinct.length) return "unknown";
  return distinct.length === 1 ? distinct[0]! : `mixed:${distinct.join(",")}`.slice(0, 200);
}

import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { schema } from "@lyra/db";
import { audit, badRequest, emit, notFound, type Ctx } from "@lyra/core";
import { one } from "../rows.js";

// docs/30 SIGNAL 4. An experiment's readout: per arm, how many were exposed
// and how many converted; per variant, the probability it beats control. The
// verdict waits for the minimum sample on every arm, then needs the answer to
// be clear (≥95% one way, ≤5% the other) — below that it keeps running.

export interface Arm {
  samples: number;
  conversions: number;
}

export interface Readout {
  verdict: "running" | "won" | "lost";
  winner: string | null;
  samples: Record<string, number>;
  rateBps: Record<string, number>;
  /** The best variant's rate minus control's, in basis points. */
  upliftBps: number;
  /** The best variant's probability of beating control, in basis points. */
  probabilityToBeatControlBps: number;
  stoppedBy: "min_sample_and_confidence" | null;
}

const CLEAR = 0.95;

/** Φ, via Abramowitz–Stegun 7.1.26 (error under 1.5e-7). */
function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** P(variant's rate > control's), normal approximation to the two proportions. */
export function probabilityToBeat(control: Arm, variant: Arm): number {
  if (control.samples <= 0 || variant.samples <= 0) return 0.5;
  const pc = control.conversions / control.samples;
  const pv = variant.conversions / variant.samples;
  const se = Math.sqrt((pc * (1 - pc)) / control.samples + (pv * (1 - pv)) / variant.samples);
  if (se === 0) return pv > pc ? 1 : pv < pc ? 0 : 0.5;
  return normalCdf((pv - pc) / se);
}

const bps = (arm: Arm) => (arm.samples > 0 ? Math.round((arm.conversions / arm.samples) * 10_000) : 0);

/** Arms keyed by variant key; `control` is the baseline every other arm is read against. */
export function readout(arms: Record<string, Arm>, minSample: number): Readout {
  const control = arms.control ?? { samples: 0, conversions: 0 };
  const variants = Object.keys(arms).filter((k) => k !== "control");
  const chances = variants.map((k) => ({ key: k, p: probabilityToBeat(control, arms[k]!) }));
  const best = chances.reduce<{ key: string; p: number } | null>((a, c) => (!a || c.p > a.p ? c : a), null);
  const ready = Object.values(arms).every((a) => a.samples >= minSample);
  const verdict = !ready || !best ? "running" : best.p >= CLEAR ? "won" : chances.every((c) => c.p <= 1 - CLEAR) ? "lost" : "running";
  return {
    verdict,
    winner: verdict === "won" ? best!.key : null,
    samples: Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, a.samples])),
    rateBps: Object.fromEntries(Object.entries(arms).map(([k, a]) => [k, bps(a)])),
    upliftBps: best ? bps(arms[best.key]!) - bps(control) : 0,
    probabilityToBeatControlBps: best ? Math.round(best.p * 10_000) : 5_000,
    stoppedBy: verdict === "running" ? null : "min_sample_and_confidence"
  };
}

/* ------------------------------------------------------- from attribution */

/**
 * What an experiment's metric counts: the touch that exposes a person to an
 * arm, and the touch that converts them. A metric not listed here is one the
 * engine cannot read, and says so rather than guess.
 */
export const METRIC_TOUCHES: Record<string, { exposure: string; conversion: string }> = {
  click_through_rate: { exposure: "impression", conversion: "click" },
  quote_start_rate: { exposure: "visit", conversion: "lead" },
  click_to_bind_rate: { exposure: "click", conversion: "bind" }
};

type Experiment = typeof schema.signalExperiments.$inferSelect;

function variantsOf(exp: Experiment): { key: string; creativeId: string }[] {
  try {
    const parsed = JSON.parse(exp.variantsJson) as { key?: unknown; creativeId?: unknown }[];
    return parsed.filter((v): v is { key: string; creativeId: string } => typeof v.key === "string" && typeof v.creativeId === "string");
  } catch {
    return [];
  }
}

/**
 * Each arm counted from attribution touches on its own creative since the
 * experiment began: touches, not distinct people — the same unit `/track`
 * records, so a restated count cannot drift from what attribution shows.
 */
async function readExperiment(ctx: Ctx, exp: Experiment): Promise<Readout> {
  const touches = METRIC_TOUCHES[exp.metric];
  if (!touches) throw badRequest(`metric ${exp.metric} is not one the experiment engine can count`, { metric: "unsupported" });
  const variants = variantsOf(exp);
  if (!variants.some((v) => v.key === "control")) throw badRequest("an experiment needs a control variant with a creative");
  const t = schema.signalAttributionEvents;
  const rows = await ctx.db
    .select({ creativeId: t.creativeId, touchType: t.touchType, n: sql<number>`count(*)` })
    .from(t)
    .where(
      and(
        eq(t.tenantId, ctx.tenantId),
        gte(t.ts, exp.createdAt),
        inArray(t.creativeId, variants.map((v) => v.creativeId)),
        inArray(t.touchType, [touches.exposure, touches.conversion])
      )
    )
    .groupBy(t.creativeId, t.touchType);
  const count = (creativeId: string, touchType: string) =>
    Number(rows.find((r) => r.creativeId === creativeId && r.touchType === touchType)?.n ?? 0);
  const arms = Object.fromEntries(
    variants.map((v) => {
      const samples = count(v.creativeId, touches.exposure);
      return [v.key, { samples, conversions: Math.min(samples, count(v.creativeId, touches.conversion)) }];
    })
  );
  return readout(arms, exp.minSample ?? 0);
}

export async function experimentReadout(ctx: Ctx, id: string): Promise<Readout> {
  const exp = await one(ctx, schema.signalExperiments, id);
  if (!exp) throw notFound("experiment");
  return readExperiment(ctx, exp);
}

/**
 * Nightly: every running experiment whose answer is now clear is concluded,
 * its readout stored, and `signal.experiment.concluded` announced. One that
 * cannot be read (an unsupported metric, no control) is left running for a
 * person to settle — the sweep never concludes on a guess.
 */
export async function concludeExperiments(ctx: Ctx): Promise<{ concluded: number }> {
  const running = await ctx.db
    .select()
    .from(schema.signalExperiments)
    .where(and(eq(schema.signalExperiments.tenantId, ctx.tenantId), eq(schema.signalExperiments.state, "running")));
  let concluded = 0;
  for (const exp of running) {
    let result: Readout;
    try {
      result = await readExperiment(ctx, exp);
    } catch {
      continue;
    }
    if (result.verdict === "running") continue;
    await ctx.db
      .update(schema.signalExperiments)
      .set({ state: "concluded", resultJson: JSON.stringify(result), concludedAt: ctx.now, updatedAt: ctx.now })
      .where(and(eq(schema.signalExperiments.tenantId, ctx.tenantId), eq(schema.signalExperiments.id, exp.id)));
    await audit(ctx, { action: "signal.experiment.conclude", subjectRef: exp.id, after: result });
    await emit(ctx, {
      module: "signal",
      type: "signal.experiment.concluded",
      subject: exp.id,
      data: { experimentId: exp.id, campaignId: exp.campaignId, verdict: result.verdict, winner: result.winner }
    });
    concluded++;
  }
  return { concluded };
}

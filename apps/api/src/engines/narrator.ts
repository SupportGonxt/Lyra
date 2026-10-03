import { and, desc, eq, isNull } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import {
  displayValue,
  extractNumbers,
  previousPeriod,
  verifyNumericClaims,
  type BriefingSnapshot,
  type Ctx,
  type SnapshotMetric,
  type Unit
} from "@lyra/core";
import type { Gateway, ModelResponse } from "@lyra/model-gateway";
import { composeTemplateBrief, TEMPLATE_LOCALES, type TemplateMetric } from "./north-brief-template.js";

// docs/03 §NORTH J-E1. The morning briefing for `date` doesn't exist until this
// runs — the seed leaves `{2026-01-06, exec, en}` free for exactly this call.
// Read-only against the semantic layer (north_metrics + north_snapshots),
// never a module's hot tables, per the schema's own header comment.
//
// The numeric-claims verifier (displayValue/extractNumbers/verifyNumericClaims)
// lives in packages/core/src/narrator-verify.ts, not here — it's pure and
// DB-free, so packages/model-gateway/evals/north scores the exact same
// function instead of a duplicate. Re-exported below so nothing importing
// from this module needs to change.

export { displayValue, extractNumbers, verifyNumericClaims, type BriefingSnapshot, type SnapshotMetric, type Unit };

async function snapshotValue(
  ctx: Ctx,
  metricKey: string,
  grain: "day" | "month",
  period: string
): Promise<number | null> {
  const [row] = await ctx.db
    .select({ value: schema.northSnapshots.value })
    .from(schema.northSnapshots)
    .where(
      and(
        eq(schema.northSnapshots.tenantId, ctx.tenantId),
        eq(schema.northSnapshots.metricKey, metricKey),
        eq(schema.northSnapshots.grain, grain),
        eq(schema.northSnapshots.period, period),
        eq(schema.northSnapshots.dimsHash, "") // grand total only, never a dimensional split
      )
    )
    .limit(1);
  return row ? row.value : null;
}

/** A localised metric name: the reader's language, else English, else null. */
function nameIn(nameJson: string, locale: string): string | null {
  try {
    const names = JSON.parse(nameJson) as Record<string, unknown>;
    const picked = names[locale] ?? names.en;
    return typeof picked === "string" && picked.trim() ? picked : null;
  } catch {
    return null;
  }
}

/**
 * The numbers a briefing for `date` can narrate: for a day-grain metric that is
 * the most recently closed day (nightly rollup means `date` itself has no row
 * yet); for a month-grain metric that is the month `date` falls in, which is
 * the month-to-date figure rewritten every night. Each carries the prior
 * comparable period for a delta, when one exists. Names are in `locale`.
 */
export async function buildSnapshot(ctx: Ctx, date: string, locale = "en"): Promise<BriefingSnapshot> {
  const metricRows = await ctx.db
    .select()
    .from(schema.northMetrics)
    .where(eq(schema.northMetrics.tenantId, ctx.tenantId));

  const metrics: SnapshotMetric[] = [];
  for (const m of metricRows) {
    const grain = m.grain === "week" ? null : (m.grain as "day" | "month"); // ponytail: no metric seeds week grain yet
    if (!grain) continue;
    const period = grain === "month" ? date.slice(0, 7) : previousPeriod("day", date);
    const value = await snapshotValue(ctx, m.key, grain, period);
    if (value === null) continue; // nothing rolled up for this metric yet — not narratable

    const prior = previousPeriod(grain, period);
    const previousValue = await snapshotValue(ctx, m.key, grain, prior);
    const deltaBps =
      previousValue !== null && previousValue !== 0
        ? Math.round(((value - previousValue) / previousValue) * 10_000)
        : null;

    metrics.push({
      metricKey: m.key,
      name: nameIn(m.nameJson, locale) ?? m.key,
      unit: m.unit as Unit,
      currency: m.currency,
      grain,
      period,
      value,
      previousPeriod: previousValue !== null ? prior : null,
      previousValue,
      deltaBps
    });
  }
  return { tenantId: ctx.tenantId, date, metrics };
}

function formatDisplay(m: SnapshotMetric): string {
  const v = displayValue(m);
  switch (m.unit) {
    case "percent":
    case "ratio":
      return `${v.toFixed(1)}%`;
    case "money":
      return `${m.currency ?? ""} ${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
    case "duration_ms":
      return `${Math.round(v)}ms`;
    default:
      return `${Math.round(v)}`;
  }
}

function metricLine(m: SnapshotMetric): string {
  const delta =
    m.deltaBps === null
      ? ""
      : ` (${m.deltaBps >= 0 ? "up" : "down"} ${Math.abs(m.deltaBps / 100).toFixed(1)}% vs ${m.previousPeriod})`;
  return `- ${m.name} for ${m.period}: ${formatDisplay(m)}${delta}`;
}

// ponytail: mirrors the "briefing" agent's prompt in packages/core/src/seed.ts
// (module north) rather than reading ai_prompts at runtime — keeps this engine
// testable without a seeded catalogue. Reconcile from one source if they drift.
const SYSTEM_PROMPT =
  "You write an executive briefing from the metrics given. Lead with what changed and by how much, " +
  "then what is likely driving it, then the decision it calls for. Every number must come from the " +
  "input. Where a movement has no explanation in the data, say so instead of guessing.";

export function buildPrompt(snapshot: BriefingSnapshot): { system: string; user: string } {
  const lines = snapshot.metrics.map(metricLine).join("\n");
  return {
    system: SYSTEM_PROMPT,
    user: `Metrics for the briefing dated ${snapshot.date}:\n${lines}\n\nWrite the briefing now.`
  };
}

export interface GenerateBriefingOptions {
  date: string;
  audience?: string;
  locale?: string;
}

export interface GenerateBriefingResult {
  id: string;
  date: string;
  audience: string;
  locale: string;
  status: "review" | "draft";
  narrativeRef: string;
  mismatches: number[];
  /** The ai_audit_log row behind a model-written brief; null for a template one. */
  auditId: string | null;
  /** "ai" when the narrator wrote it, "template" when the fixed template did (docs/15: only "ai" carries ✦). */
  generatedBy: "ai" | "template";
}

/**
 * The language the narrator's prompt is written in, and the only one the
 * NORTH eval (packages/model-gateway/evals/north) measures. Any other locale
 * gets the template, in that locale, rather than English prose stored under a
 * locale it is not in — an Arabic narration needs its eval case first
 * (CLAUDE.md "AI features are eval-first").
 */
const MODEL_LOCALE = "en";

/** The three metrics that moved most, kept beside the prose for the brief screen's card. */
function highlightsOf(snapshot: BriefingSnapshot) {
  return [...snapshot.metrics]
    .filter((m) => m.deltaBps !== null)
    .sort((a, b) => Math.abs(b.deltaBps!) - Math.abs(a.deltaBps!))
    .slice(0, 3)
    .map((m) => ({ metricKey: m.metricKey, period: m.period, value: m.value, deltaBps: m.deltaBps }));
}

/** The model's answer, or null when there is no usable one: unconfigured, failed, refused or empty. */
async function narrate(ctx: Ctx, gateway: Gateway, snapshot: BriefingSnapshot): Promise<ModelResponse | null> {
  const { system, user } = buildPrompt(snapshot);
  try {
    const res = await gateway.complete(ctx, {
      module: "north",
      purpose: "briefing.generate",
      tier: "reasoning",
      subjectRef: snapshot.date,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    });
    // A kill switch or budget refusal comes back as a response, not a throw —
    // storing its text as the morning brief would be worse than the template.
    if (res.finishReason === "refusal" || res.finishReason === "error" || !res.text.trim()) return null;
    return res;
  } catch (err) {
    console.warn("briefing narrator unavailable, writing the template brief", {
      tenantId: ctx.tenantId,
      date: snapshot.date,
      err: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

/**
 * Snapshot -> generate (packages/model-gateway, reasoning tier, module "north" —
 * CLAUDE.md rule 3) -> verify -> persist. A briefing with an unverifiable claim
 * still lands in `north_briefings` (status stays "draft", never "review") so the
 * attempt is inspectable rather than silently dropped; it is never auto-published
 * either way (`approvedBy` is always null here — rule 4, publishing is a human's
 * job, not this engine's).
 *
 * J-E1: with no usable model answer — none configured, the call failed, the
 * gateway refused — the brief is still written, from the template
 * (`templateBriefing`), so "the 7am read" never depends on a provider.
 */
export async function generateBriefing(
  ctx: Ctx,
  gateway: Gateway,
  opts: GenerateBriefingOptions
): Promise<GenerateBriefingResult> {
  const audience = opts.audience ?? "exec";
  const locale = opts.locale ?? "en";
  if (locale !== MODEL_LOCALE) return templateBriefing(ctx, { date: opts.date, audience, locale });

  const snapshot = await buildSnapshot(ctx, opts.date);
  const res = await narrate(ctx, gateway, snapshot);
  if (!res) return templateBriefing(ctx, { date: opts.date, audience, locale });

  const verification = verifyNumericClaims(res.text, snapshot);
  const status = verification.ok ? "review" : "draft";

  const id = newId("brf", ctx.now);
  // ponytail: narrativeRef is stored as the generated text itself, not an R2 key —
  // nothing in this codebase renders real R2 bytes yet (see analyticsExports'
  // fileId: null in packages/core/src/seed/analytics.ts). Swap for a real upload
  // + key the day something writes bytes to R2 for real.
  await ctx.db.insert(schema.northBriefings).values({
    id,
    tenantId: ctx.tenantId,
    date: opts.date,
    audience,
    locale,
    narrativeRef: res.text,
    highlightsJson: JSON.stringify(highlightsOf(snapshot)),
    anomaliesJson: null,
    status,
    generatedBy: "ai",
    aiAuditId: res.auditId,
    approvedBy: null,
    publishedAt: null,
    createdAt: ctx.now
  });

  return {
    id,
    date: opts.date,
    audience,
    locale,
    status,
    narrativeRef: res.text,
    mismatches: verification.mismatches,
    auditId: res.auditId,
    generatedBy: "ai"
  };
}

/**
 * The brief with no model: the same snapshot, in `locale`, plus the open
 * anomalies nobody owns yet, through the fixed template
 * (engines/north-brief-template.ts). Its figures are copied from stored values,
 * so it is review-ready by construction; a person still publishes it.
 */
export async function templateBriefing(
  ctx: Ctx,
  opts: { date: string; audience: string; locale: string }
): Promise<GenerateBriefingResult> {
  const [snapshot, metricRows, anomalyRows] = await Promise.all([
    buildSnapshot(ctx, opts.date, opts.locale),
    ctx.db.select().from(schema.northMetrics).where(eq(schema.northMetrics.tenantId, ctx.tenantId)),
    ctx.db
      .select()
      .from(schema.northAnomalies)
      .where(
        and(
          eq(schema.northAnomalies.tenantId, ctx.tenantId),
          eq(schema.northAnomalies.state, "new"),
          isNull(schema.northAnomalies.explainedBy)
        )
      )
      .orderBy(desc(schema.northAnomalies.detectedAt))
      .limit(50)
  ]);

  const metrics = new Map<string, TemplateMetric>(
    metricRows.map((m) => [
      m.key,
      { name: nameIn(m.nameJson, opts.locale) ?? m.key, unit: m.unit as Unit, currency: m.currency }
    ])
  );
  const narrativeRef = composeTemplateBrief({ snapshot, anomalies: anomalyRows, metrics, locale: opts.locale });

  const id = newId("brf", ctx.now);
  await ctx.db.insert(schema.northBriefings).values({
    id,
    tenantId: ctx.tenantId,
    date: opts.date,
    audience: opts.audience,
    locale: opts.locale,
    narrativeRef,
    highlightsJson: JSON.stringify(highlightsOf(snapshot)),
    anomaliesJson: JSON.stringify(
      anomalyRows.map((a) => ({ id: a.id, metricKey: a.metricKey, window: a.window, magnitude: a.magnitude }))
    ),
    status: "review",
    generatedBy: "template",
    aiAuditId: null,
    approvedBy: null,
    publishedAt: null,
    createdAt: ctx.now
  });

  return {
    id,
    date: opts.date,
    audience: opts.audience,
    locale: opts.locale,
    status: "review",
    narrativeRef,
    mismatches: [],
    auditId: null,
    generatedBy: "template"
  };
}

/**
 * The languages the nightly brief is written in: the tenant's own
 * (`policy.locales`, en + ar unless it says otherwise), limited to those the
 * template has a catalogue for, and English when that leaves nothing.
 */
export function briefLocales(locales: readonly string[] | undefined): string[] {
  const known = [...new Set(locales ?? [])].filter((l) => (TEMPLATE_LOCALES as readonly string[]).includes(l));
  return known.length ? known : ["en"];
}

/**
 * docs/30 NORTH gap 1 / J-E1 "the 7am read": the day's exec brief, written in
 * the nightly window just after the snapshot that closed yesterday, so it is
 * dated today and narrates yesterday (the seed's own rows have this shape).
 * Once per (tenant, exec, locale, date) — a held row is skipped without asking
 * the model again, and the unique key backs that up. Never published here.
 * Returns the briefs written this call; empty when every one already existed.
 */
export async function nightlyBriefing(ctx: Ctx, gateway: Gateway): Promise<GenerateBriefingResult[]> {
  const date = new Date(ctx.now).toISOString().slice(0, 10);
  const written: GenerateBriefingResult[] = [];
  for (const locale of briefLocales(ctx.policy?.locales)) {
    const [held] = await ctx.db
      .select({ id: schema.northBriefings.id })
      .from(schema.northBriefings)
      .where(
        and(
          eq(schema.northBriefings.tenantId, ctx.tenantId),
          eq(schema.northBriefings.date, date),
          eq(schema.northBriefings.audience, "exec"),
          eq(schema.northBriefings.locale, locale)
        )
      )
      .limit(1);
    if (held) continue;
    written.push(await generateBriefing(ctx, gateway, { date, audience: "exec", locale }));
  }
  return written;
}

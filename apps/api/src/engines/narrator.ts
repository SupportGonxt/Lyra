import { and, eq } from "drizzle-orm";
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
import type { Gateway } from "@lyra/model-gateway";

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

/**
 * The numbers a briefing for `date` can narrate: for a day-grain metric that is
 * the most recently closed day (nightly rollup means `date` itself has no row
 * yet); for a month-grain metric that is the month `date` falls in, which is
 * the month-to-date figure rewritten every night. Each carries the prior
 * comparable period for a delta, when one exists.
 */
export async function buildSnapshot(ctx: Ctx, date: string): Promise<BriefingSnapshot> {
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
      name: (JSON.parse(m.nameJson) as { en: string }).en,
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
  status: "review" | "draft";
  narrativeRef: string;
  mismatches: number[];
  auditId: string;
}

/**
 * Snapshot -> generate (packages/model-gateway, reasoning tier, module "north" —
 * CLAUDE.md rule 3) -> verify -> persist. A briefing with an unverifiable claim
 * still lands in `north_briefings` (status stays "draft", never "review") so the
 * attempt is inspectable rather than silently dropped; it is never auto-published
 * either way (`approvedBy` is always null here — rule 4, publishing is a human's
 * job, not this engine's).
 */
export async function generateBriefing(
  ctx: Ctx,
  gateway: Gateway,
  opts: GenerateBriefingOptions
): Promise<GenerateBriefingResult> {
  const audience = opts.audience ?? "exec";
  const locale = opts.locale ?? "en";

  const snapshot = await buildSnapshot(ctx, opts.date);
  const { system, user } = buildPrompt(snapshot);
  const res = await gateway.complete(ctx, {
    module: "north",
    purpose: "briefing.generate",
    tier: "reasoning",
    subjectRef: opts.date,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const verification = verifyNumericClaims(res.text, snapshot);

  const highlights = [...snapshot.metrics]
    .filter((m) => m.deltaBps !== null)
    .sort((a, b) => Math.abs(b.deltaBps!) - Math.abs(a.deltaBps!))
    .slice(0, 3)
    .map((m) => ({ metricKey: m.metricKey, period: m.period, value: m.value, deltaBps: m.deltaBps }));

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
    highlightsJson: JSON.stringify(highlights),
    anomaliesJson: null,
    status: verification.ok ? "review" : "draft",
    generatedBy: "ai",
    aiAuditId: res.auditId,
    approvedBy: null,
    publishedAt: null,
    createdAt: ctx.now
  });

  return {
    id,
    status: verification.ok ? "review" : "draft",
    narrativeRef: res.text,
    mismatches: verification.mismatches,
    auditId: res.auditId
  };
}

/**
 * docs/30 NORTH gap 1: yesterday's exec brief, written in the nightly window
 * beside the snapshot. Once per date — the row's unique key says so, and a
 * second run returns null without asking the model again. Never published here.
 */
export async function nightlyBriefing(ctx: Ctx, gateway: Gateway): Promise<GenerateBriefingResult | null> {
  const date = new Date(ctx.now - 86_400_000).toISOString().slice(0, 10);
  const [held] = await ctx.db
    .select({ id: schema.northBriefings.id })
    .from(schema.northBriefings)
    .where(
      and(
        eq(schema.northBriefings.tenantId, ctx.tenantId),
        eq(schema.northBriefings.date, date),
        eq(schema.northBriefings.audience, "exec"),
        eq(schema.northBriefings.locale, "en")
      )
    )
    .limit(1);
  if (held) return null;
  return generateBriefing(ctx, gateway, { date });
}

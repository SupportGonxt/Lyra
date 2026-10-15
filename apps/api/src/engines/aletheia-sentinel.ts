import { and, eq, gte } from "drizzle-orm";
import { schema } from "@lyra/db";
import { audit, type Ctx } from "@lyra/core";
import type { Env } from "../env.js";
import { harvestSignals } from "./scout-ingest.js";
import type { Gateway } from "@lyra/model-gateway";

// A7, docs/30 SCOUT gap: the sentinel half that needs Aletheia.
//
// What exists without it is the rule-based watch (`scout-watch.ts`), which
// compares a window of signals to the window before it. That finds what *moved*;
// it cannot say whether a value is out of band for a business this size, because
// the only baseline it has is the tenant's own recent history. Aletheia's
// findings engine has exactly that baseline — per business function, per KPI,
// by size band — so this adapter asks it, and turns an out-of-band reading into
// a `scout_signals` row like any other observation.
//
// Gated on ALETHEIA_URL, like the ingest: with no Aletheia deployed this is a
// no-op that returns `standDown`, never an error, so the nightly tick is
// identical whether the engine is present or not.
//
// The findings arrive as signals, not as a special case. That is the point of
// routing through the harvester: the Clusterer, the whitespace candidates and
// the watch all consume `scout_signals`, so an Aletheia finding is a first-class
// market observation the day it lands rather than a parallel pipeline.

/** Aletheia's finding, as its `/insights` endpoint returns it. */
export interface SentinelFinding {
  id: string;
  function: string;
  title: string;
  description: string;
  moneyAtStake: number;
  unit: string;
  severity: "neg" | "warn" | "accent" | "pos";
  action: string;
}

export interface SentinelResult {
  /** `no-endpoint` when ALETHEIA_URL is unset — the honest answer, not an error. */
  standDown?: "no-endpoint" | "no-metrics";
  asked: number;
  findings: number;
  recorded: number;
  duplicates: number;
  errors: string[];
}

/** How heavy an Aletheia finding is as a signal: a negative one is the loudest. */
const SEVERITY_WEIGHT: Record<SentinelFinding["severity"], number> = { neg: 5, warn: 3, accent: 1, pos: 1 };

/**
 * LYRA's own figures, in Aletheia's vocabulary.
 *
 * The mapping is deliberately small and one-directional: every entry names a
 * business function and a KPI that Aletheia's `BUSINESS_FUNCTIONS` actually
 * defines, because it **skips a KPI it does not know** — a name invented here
 * would produce a confident empty answer rather than an error.
 *
 * `scale` exists for the one conversion that is not a rename: LYRA holds money
 * in minor units and Aletheia's benchmarks are in currency units, so sending
 * minor units would read as a hundredfold overrun.
 */
export const ALETHEIA_METRIC_MAP = {
  /** Spend per bind. */
  cacPerPolicyMinor: { fn: "marketing", kpi: "customer_acquisition_cost", scale: 0.01 },
  /** Value of a bind over what it cost. Unitless, so no scale. */
  ltvToCac: { fn: "marketing", kpi: "ltv_cac_ratio", scale: 1 },
  /** Quotes that became binds, as a percentage. */
  quoteToBindPct: { fn: "marketing", kpi: "mql_to_sql_conversion", scale: 1 },
  /** Panel quotes that won. */
  panelWinPct: { fn: "sales", kpi: "win_rate", scale: 1 },
  /** 100 minus renewal retention: the share of due policies that left. */
  churnPct: { fn: "sales", kpi: "customer_churn_rate", scale: 1 },
  /** How far the market price moved, as a percentage. */
  priceErosionPct: { fn: "pricing", kpi: "price_erosion", scale: 1 },
  /** Complaints per thousand policies. */
  complaintsPerThousand: { fn: "customer_service", kpi: "escalation_rate", scale: 1 }
} as const;

export type SentinelMetricKey = keyof typeof ALETHEIA_METRIC_MAP;

/**
 * What the caller measured. Every field is optional because a tenant that has
 * not sold anything has no CAC — and a fabricated zero is a reading Aletheia
 * would score as a real, extreme value.
 */
export type SentinelInput = Partial<Record<SentinelMetricKey, number>>;

export function aletheiaInsightsUrl(env: Pick<Env, "ALETHEIA_URL">, tenantId: string): string | null {
  if (!env.ALETHEIA_URL) return null;
  return `${env.ALETHEIA_URL.replace(/\/$/, "")}/api/${encodeURIComponent(tenantId)}/insights`;
}

/**
 * The metrics, grouped the way Aletheia's engine reads them —
 * `{ businessFunction: { KPI: value } }` — skipping anything the caller could
 * not measure.
 */
export function marketMetrics(input: SentinelInput): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, spec] of Object.entries(ALETHEIA_METRIC_MAP) as [SentinelMetricKey, (typeof ALETHEIA_METRIC_MAP)[SentinelMetricKey]][]) {
    const raw = input[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const value = raw * spec.scale;
    // Two decimals: Aletheia's benchmarks are coarse, and more precision would
    // be a claim about measurement the caller did not make.
    (out[spec.fn] ??= {})[spec.kpi] = Math.round(value * 100) / 100;
  }
  return out;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Aletheia's reply, read defensively.
 *
 * The response is somebody else's JSON over the network: a finding missing its
 * id or severity is dropped rather than coerced, because a signal with a made-up
 * weight is worse than a missing one — it would be indistinguishable from a real
 * observation in the Clusterer.
 */
export function findingsFrom(reply: unknown): SentinelFinding[] {
  if (!reply || typeof reply !== "object") return [];
  const raw = (reply as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];
  const out: SentinelFinding[] = [];
  for (const one of raw) {
    if (!one || typeof one !== "object") continue;
    const f = one as Record<string, unknown>;
    if (typeof f.id !== "string" || !f.id) continue;
    const severity = typeof f.severity === "string" && f.severity in SEVERITY_WEIGHT ? (f.severity as SentinelFinding["severity"]) : null;
    if (!severity) continue;
    out.push({
      id: f.id,
      function: typeof f.function === "string" ? f.function : "",
      title: typeof f.title === "string" ? f.title : "",
      description: typeof f.description === "string" ? f.description : "",
      moneyAtStake: num(f.money_at_stake),
      unit: typeof f.unit === "string" ? f.unit : "",
      severity,
      action: typeof f.action === "string" ? f.action : ""
    });
  }
  return out;
}

/**
 * Ask Aletheia what is out of band, and record what it says as market signals.
 *
 * `sourceRef` is `aletheia:<finding id>`, so a second run over the same findings
 * writes nothing — the harvester dedupes on (source, sourceRef), which is what
 * makes this safe to run nightly and by hand.
 */
export async function runAletheiaSentinel(
  ctx: Ctx,
  gateway: Gateway,
  env: Pick<Env, "ALETHEIA_URL" | "ALETHEIA_TOKEN" | "VEC_MARKET">,
  input: SentinelInput,
  opts: { fetch?: typeof fetch } = {}
): Promise<SentinelResult> {
  const url = aletheiaInsightsUrl(env, ctx.tenantId);
  const base = { asked: 0, findings: 0, recorded: 0, duplicates: 0, errors: [] as string[] };
  if (!url) return { standDown: "no-endpoint", ...base };

  const metrics = marketMetrics(input);
  const asked = Object.values(metrics).reduce((sum, kpis) => sum + Object.keys(kpis).length, 0);
  if (asked === 0) return { standDown: "no-metrics", ...base };

  const send = opts.fetch ?? fetch;
  let reply: unknown;
  try {
    const response = await send(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.ALETHEIA_TOKEN ? { authorization: `Bearer ${env.ALETHEIA_TOKEN}` } : {})
      },
      body: JSON.stringify({ metrics })
    });
    if (!response.ok) return { ...base, asked, errors: [`aletheia answered ${response.status}`] };
    reply = await response.json();
  } catch (error) {
    // A sentinel that throws takes the nightly tick with it. The stand-down is
    // recorded by the caller; here the reason is named and the run ends.
    return { ...base, asked, errors: [error instanceof Error ? error.message : String(error)] };
  }

  const findings = findingsFrom(reply);
  if (!findings.length) return { ...base, asked };

  const fed = findings.map((finding) => ({
    source: "model" as const,
    // Prefixed, because a bare finding id could collide with a feed item's ref.
    sourceRef: `aletheia:${finding.id}`,
    payload: {
      function: finding.function,
      title: finding.title,
      description: finding.description,
      moneyAtStake: finding.moneyAtStake,
      unit: finding.unit,
      severity: finding.severity,
      action: finding.action,
      methodology: "aletheia findings engine: KPI outside its size-band benchmark"
    },
    observedAt: ctx.now,
    weight: SEVERITY_WEIGHT[finding.severity]
  }));

  const report = await harvestSignals(ctx, gateway, env as Env, { fed, fedOnly: true, lookbackMs: 86_400_000 });

  await audit(ctx, {
    action: "scout.aletheia.sentinel_run",
    subjectRef: `tenant:${ctx.tenantId}`,
    after: { asked, findings: findings.length, ingested: report.ingested, duplicates: report.duplicates }
  });

  return { asked, findings: findings.length, recorded: report.ingested, duplicates: report.duplicates, errors: [] };
}

/* ------------------------------------------------------------------ gather */

/** Days of history the input is measured over. */
export const SENTINEL_WINDOW_DAYS = 30;

/**
 * The tenant's own figures for the metrics above, measured over the window.
 *
 * Read from what the platform already holds: binds and their values from the
 * attribution ledger, spend from the ad ledger, complaints from AXIS. A metric
 * whose denominator is zero is **left out** rather than sent as zero.
 */
export async function gatherSentinelInput(ctx: Ctx): Promise<SentinelInput> {
  const since = ctx.now - SENTINEL_WINDOW_DAYS * 86_400_000;
  const [spend, touches, complaints] = await Promise.all([
    ctx.db
      .select({ amountMinor: schema.signalSpend.amountMinor })
      .from(schema.signalSpend)
      .where(and(eq(schema.signalSpend.tenantId, ctx.tenantId), gte(schema.signalSpend.ts, since))),
    ctx.db
      .select({ touchType: schema.signalAttributionEvents.touchType, valueMinor: schema.signalAttributionEvents.valueMinor })
      .from(schema.signalAttributionEvents)
      .where(and(eq(schema.signalAttributionEvents.tenantId, ctx.tenantId), gte(schema.signalAttributionEvents.ts, since))),
    ctx.db
      .select({ id: schema.axisComplaints.id })
      .from(schema.axisComplaints)
      .where(and(eq(schema.axisComplaints.tenantId, ctx.tenantId), gte(schema.axisComplaints.receivedAt, since)))
  ]);

  const spendMinor = spend.reduce((sum, row) => sum + row.amountMinor, 0);
  const binds = touches.filter((row) => row.touchType === "bind");
  const valueMinor = binds.reduce((sum, row) => sum + (row.valueMinor ?? 0), 0);

  const input: SentinelInput = {};
  const cacMinor = binds.length > 0 ? spendMinor / binds.length : null;
  if (cacMinor !== null) input.cacPerPolicyMinor = cacMinor;
  const ltvMinor = binds.length > 0 ? valueMinor / binds.length : null;
  if (cacMinor !== null && ltvMinor !== null && cacMinor > 0) input.ltvToCac = ltvMinor / cacMinor;
  if (complaints.length > 0) input.complaintsPerThousand = complaints.length;
  return input;
}

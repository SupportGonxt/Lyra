import {
  Card,
  EmptyState,
  GuardrailNotice,
  Money,
  Table,
  type Column
} from "@lyra/ui";
import type { LoaderFunctionArgs } from "react-router";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { moduleName, pseudoText, translator } from "../i18n";
import { humanise } from "../modules/spec";
import { useShellData } from "./workspace";
import { useLoaderData } from "react-router";

// docs/10 §6 / docs/17 ADM-025: "cost explorer per tenant (AI, storage, egress)
// with unit-cost drift alerting". AI + media come from
// GET /v1/analytics/unit-economics (analytics_unit_economics, rolled nightly
// from ai_runs + ledger 5100/5200). Storage and egress come from
// GET /v1/analytics/usage — storage is derived from core_files.size_bytes at
// read time, egress from analytics_egress_days, incremented at the R2
// download seams (see apps/api/src/engines/egress.ts).

/* --------------------------------------------------------------- constants */

const COST_CURRENCY = "USD";
/** How many prior days form the baseline a "today" figure is judged against. */
export const DRIFT_BASELINE_DAYS = 7;
/** A unit costing 25% more than its trailing baseline is a drift worth a look. */
export const DRIFT_THRESHOLD_PCT = 25;

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Cost explorer",
    intro:
      "Cost per outcome, by module and unit — what AI and media spend actually cost against the work it produced.",
    "table.title": "Unit economics",
    "table.window": "Most recent days first, across every module and unit tracked.",
    "table.module": "Module",
    "table.unit": "Unit",
    "table.day": "Day",
    "table.volume": "Volume",
    "table.costPerUnit": "Cost per unit",
    "table.margin": "Margin",
    "table.denied": "You do not have permission to read analytics reports, so this screen is hidden.",
    "drift.title": "Unit cost is drifting",
    "drift.reason": `One or more units now cost ${DRIFT_THRESHOLD_PCT}% or more above their ${DRIFT_BASELINE_DAYS}-day baseline:`,
    "usage.title": "Storage and egress",
    "usage.window": "Storage is what this tenant holds right now; egress is bytes downloaded over the last 30 days.",
    "usage.storage": "Stored",
    "usage.egress": "Egress, last 30 days",
    "headline.drifting": `unit(s) costing ${DRIFT_THRESHOLD_PCT}% or more above their ${DRIFT_BASELINE_DAYS}-day baseline.`,
    "headline.onTrack": `No unit is drifting above its ${DRIFT_BASELINE_DAYS}-day baseline.`,
    "headline.none": "No cost data has rolled up yet."
  },
  ar: {
    title: "مستكشف التكلفة",
    intro: "التكلفة مقابل كل نتيجة، حسب الوحدة والوسيلة — ما كلفه الذكاء الاصطناعي والوسائط فعليًا مقابل العمل الناتج.",
    "table.title": "اقتصاديات الوحدة",
    "table.window": "الأيام الأحدث أولًا، عبر كل وحدة ونوع مُتابَع.",
    "table.module": "الوحدة",
    "table.unit": "النوع",
    "table.day": "اليوم",
    "table.volume": "الحجم",
    "table.costPerUnit": "التكلفة لكل وحدة",
    "table.margin": "الهامش",
    "table.denied": "لا تملك صلاحية الاطلاع على تقارير التحليلات، لذا هذه الشاشة مخفية.",
    "drift.title": "تكلفة الوحدة في ارتفاع",
    "drift.reason": `وحدة واحدة أو أكثر تكلف الآن ${DRIFT_THRESHOLD_PCT}% أو أكثر فوق خط الأساس لـ ${DRIFT_BASELINE_DAYS} أيام:`,
    "usage.title": "التخزين والنقل الخارج",
    "usage.window": "التخزين هو ما تحتفظ به هذه المؤسسة الآن؛ والنقل الخارجي هو البايتات المُنزَّلة خلال آخر 30 يومًا.",
    "usage.storage": "المُخزَّن",
    "usage.egress": "النقل الخارج، آخر 30 يومًا",
    "headline.drifting": `وحدة (أو أكثر) تكلف الآن ${DRIFT_THRESHOLD_PCT}% أو أكثر فوق خط الأساس لـ ${DRIFT_BASELINE_DAYS} أيام.`,
    "headline.onTrack": `لا توجد وحدة تتجاوز خط الأساس لـ ${DRIFT_BASELINE_DAYS} أيام.`,
    "headline.none": "لم تُجمَّع بيانات التكلفة بعد."
  }
};

type Label = (key: string, fallback?: string) => string;

function labeller(locale: string): Label {
  return (key, fallback) =>
    pseudoText(locale, LABELS[locale]?.[key] ?? LABELS["en"]?.[key] ?? fallback ?? key);
}

/* ------------------------------------------------------------------ shapes */

export interface UnitEconRow {
  id: string;
  day: string;
  module: string;
  unit: string;
  volume: number;
  aiCostMicro: number;
  mediaCostMicro: number;
  humanMinutes: number;
  revenueMinor: number;
  currency: string;
  updatedAt: number;
  costMinor: number;
  costPerUnitMinor: number | null;
  marginMinor: number;
}

export interface Drift {
  module: string;
  unit: string;
  day: string;
  latestMinor: number;
  baselineMinor: number;
  deltaPct: number;
}

export interface Usage {
  storageBytes: number;
  egressDays: Array<{ day: string; bytes: number }>;
}

/* ------------------------------------------------------------------ helpers */

/** Rows for one (module, unit), newest day first — the shape the API already sorts in. */
export function groupByUnit(rows: readonly UnitEconRow[]): Map<string, UnitEconRow[]> {
  const groups = new Map<string, UnitEconRow[]>();
  for (const row of rows) {
    const key = `${row.module}/${row.unit}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

/**
 * The latest day's cost-per-unit against the trailing baseline. `null` when
 * there isn't enough history to have a baseline, or the latest/every baseline
 * day never priced a unit (volume was zero, so cost-per-unit is undefined).
 */
export function driftFor(module: string, unit: string, rowsNewestFirst: readonly UnitEconRow[]): Drift | null {
  const latest = rowsNewestFirst[0];
  if (!latest || latest.costPerUnitMinor === null) return null;
  const baseline = rowsNewestFirst
    .slice(1, 1 + DRIFT_BASELINE_DAYS)
    .map((r) => r.costPerUnitMinor)
    .filter((v): v is number => v !== null);
  if (!baseline.length) return null;
  const baselineMinor = Math.round(baseline.reduce((sum, v) => sum + v, 0) / baseline.length);
  if (baselineMinor <= 0) return null;
  const deltaPct = Math.round(((latest.costPerUnitMinor - baselineMinor) / baselineMinor) * 100);
  return { module, unit, day: latest.day, latestMinor: latest.costPerUnitMinor, baselineMinor, deltaPct };
}

/** Every (module, unit) whose cost has drifted past the threshold, worst first. */
export function driftingUnits(rows: readonly UnitEconRow[], thresholdPct = DRIFT_THRESHOLD_PCT): Drift[] {
  const drifts: Drift[] = [];
  for (const [key, group] of groupByUnit(rows)) {
    const [module, unit] = key.split("/") as [string, string];
    const drift = driftFor(module, unit, group);
    if (drift && drift.deltaPct >= thresholdPct) drifts.push(drift);
  }
  return drifts.sort((a, b) => b.deltaPct - a.deltaPct);
}

/** 30-day egress total — the API already returns at most 30 daily rows, newest first. */
export function egressTotal(usage: Usage | null): number {
  return usage?.egressDays.reduce((sum, d) => sum + d.bytes, 0) ?? 0;
}

/** "1.4 MB" — locale-aware, one decimal above bytes. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const nf = new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 });
  return `${nf.format(value)} ${units[unit]}`;
}

/** One true line for the hero: denied, drifting, empty, or on track — in that
 *  order, since a denied read makes the rest of the sentence moot. */
export function costHeadline(rows: readonly UnitEconRow[] | null, drifts: readonly Drift[], L: Label): string {
  if (rows === null) return L("table.denied");
  if (drifts.length > 0) return `${drifts.length} ${L("headline.drifting")}`;
  if (rows.length === 0) return L("headline.none");
  return L("headline.onTrack");
}

async function readable<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const [rows, usage] = await Promise.all([
    readable(api<{ data: UnitEconRow[] }>("/v1/analytics/unit-economics", { env, request })),
    readable(api<{ data: Usage }>("/v1/analytics/usage", { env, request }))
  ]);
  return { rows: rows?.data ?? null, usage: usage?.data ?? null };
}

/* --------------------------------------------------------------- the screen */

export default function CostExplorer() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const L = labeller(locale);
  const nf = new Intl.NumberFormat(locale);

  const rows = loaded.rows ?? [];
  const drifts = loaded.rows ? driftingUnits(loaded.rows) : [];

  const columns: Array<Column<UnitEconRow>> = [
    // The table headed a column MODULE and listed "dist", "orbit", "axis" down
    // it — the keys the rollup is stored under, not the names on the rail.
    { key: "module", header: L("table.module"), render: (row) => moduleName(t, row.module) },
    { key: "unit", header: L("table.unit"), render: (row) => humanise(row.unit) },
    { key: "day", header: L("table.day"), render: (row) => row.day },
    { key: "volume", header: L("table.volume"), numeric: true, render: (row) => nf.format(row.volume) },
    {
      key: "costPerUnitMinor",
      header: L("table.costPerUnit"),
      numeric: true,
      render: (row) =>
        row.costPerUnitMinor === null ? (
          "—"
        ) : (
          <Money amountMinor={row.costPerUnitMinor} currency={row.currency || COST_CURRENCY} locale={locale} />
        )
    },
    {
      key: "marginMinor",
      header: L("table.margin"),
      numeric: true,
      render: (row) => <Money amountMinor={row.marginMinor} currency={row.currency || COST_CURRENCY} locale={locale} />
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{L("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{costHeadline(loaded.rows, drifts, L)}</p>
      </header>

      {drifts.length > 0 ? (
        <GuardrailNotice
          tone="warning"
          title={L("drift.title")}
          reason={
            <div className="flex flex-col gap-1">
              <p>{L("drift.reason")}</p>
              <ul className="flex flex-col gap-0.5">
                {drifts.map((drift) => (
                  <li key={`${drift.module}/${drift.unit}`} className="text-13">
                    {moduleName(t, drift.module)} · {humanise(drift.unit)}: +{drift.deltaPct}%
                  </li>
                ))}
              </ul>
            </div>
          }
        />
      ) : null}

      {loaded.usage ? (
        <Card title={L("usage.title")} description={L("usage.window")}>
          <dl className="flex flex-wrap gap-x-10 gap-y-3">
            <div className="flex flex-col gap-0.5">
              <dt className="font-ui text-12 text-subtle">{L("usage.storage")}</dt>
              <dd className="font-mono text-18 tabular-nums text-text">{formatBytes(loaded.usage.storageBytes, locale)}</dd>
            </div>
            <div className="flex flex-col gap-0.5">
              <dt className="font-ui text-12 text-subtle">{L("usage.egress")}</dt>
              <dd className="font-mono text-18 tabular-nums text-text">{formatBytes(egressTotal(loaded.usage), locale)}</dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <Card title={L("table.title")} description={L("table.window")}>
        {loaded.rows === null ? (
          <p className="max-w-prose font-ui text-13 text-subtle">{L("table.denied")}</p>
        ) : (
          <Table
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            caption={`${L("table.title")} — ${L("table.window")}`}
            density="compact"
            empty={<EmptyState title={t("common.empty.title")} body={t("common.empty.body")} />}
          />
        )}
      </Card>
    </div>
  );
}

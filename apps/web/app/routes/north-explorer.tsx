import type * as React from "react";
import {
  Form,
  Link,
  useLoaderData,
  useNavigation,
  type LoaderFunctionArgs
} from "react-router";
import { Button, Card, DateTime, EmptyState, Field, LineChart, Select, Stat, Table } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { useNorthSessionData } from "./north-shell";
import {
  MetricValue,
  labelsFrom,
  metricName,
  metricText,
  parsed,
  pct,
  readable,
  type Labels,
  type Metric,
  type Page,
  type Snapshot
} from "./north-shared";

/**
 * Mirrors what `GET /v1/north/forecast` answers with — apps/api/src/routes/north.ts,
 * built by packages/core/src/north-forecast.ts. Every field here exists there;
 * `reason` is present only when `points` is empty.
 */
/**
 * One row of `north_metric_definitions`, written by the metrics resource when a
 * definition actually changed. `changedAt` is the date the annotation is drawn
 * from.
 */
interface DefinitionChange {
  id: string;
  metricKey: string;
  definitionSqlRef: string;
  changedAt: number;
  changedBy: string;
}

interface Forecast {
  points: { period: string; p10: number; p50: number; p90: number }[];
  fit: {
    method: string;
    alphaPpm: number;
    betaPpm: number;
    phiPpm: number;
    intervalSource: "empirical" | "default";
    observations: number;
    lastObserved: string | null;
  };
  reason?: string;
}

// Metric Explorer (docs/modules/north.md §4 screen 2): one metric, its series,
// and the definition it was computed from. The semantic layer is the only
// source — the screen reads north_snapshots through the snapshots resource and
// never composes a number of its own.

/* --------------------------------------------------------------- constants */

export const PERM = { read: "north:snapshots:read" } as const;

const WINDOW = 90;
// The list API's ceiling (MAX_PAGE, apps/api/src/http.ts:186). Asking past it
// is a 400, not a truncated page — `limit=${WINDOW * 4}` was 360 and this
// screen answered HTTP 500 to every reader because of it.
const MAX_PAGE = 200;
const GRAINS = ["day", "week", "month"] as const;
/**
 * Six periods ahead: a half-year of months or most of a week of days — far
 * enough to plan against, near enough that the band still means something.
 */
const HORIZON = 6;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Metric explorer",
    kicker: "One metric, its series, and the definition behind it",
    intro:
      // This sentence once promised more than the screen did — "change the
      // definition and the change shows here as an annotation" — while nothing
      // marked the series and nothing recorded *when* a definition changed. Both
      // are now true: the history exists (`north_metric_definitions`, written only
      // when the value actually differs), and the **chart itself** marks the period
      // each change landed in, with the series table naming the date. The promise
      // and the implementation have met.
      "Every point is a closed snapshot from the semantic layer. Change the definition and the moment it changed is marked on the series, not silently restated.",
    metric: "Metric",
    grain: "Grain",
    day: "Daily",
    week: "Weekly",
    month: "Monthly",
    apply: "Show series",
    "series.title": "Series",
    "series.caption": "Snapshot values for the selected metric, oldest first",
    "series.period": "Period",
    "series.value": "Value",
    "series.change": "Change",
    "series.taken": "Snapshot taken",
    "definition.changed": "Definition changed",
    "series.none.title": "No snapshots for this metric yet",
    "breakdown.title": "Breakdown",
    "breakdown.caption":
      "This metric is measured per dimension, so it has no single line to draw. One row per dimension per period.",
    "breakdown.dimension": "Dimension",
    "breakdown.period": "Period",
    "breakdown.value": "Value",
    "series.none.body":
      "The snapshotter writes a row when the period closes. Run it from NORTH dev if you need one before the nightly window.",
    "forecast.title": "What the next periods look like",
    "forecast.caption": "Projected value per period, with the range the fit puts around it",
    "forecast.period": "Period",
    "forecast.low": "Low (p10)",
    "forecast.mid": "Projected (p50)",
    "forecast.high": "High (p90)",
    "forecast.method": "Method",
    "forecast.params": "Fitted",
    "forecast.band.empirical": "Range measured from holdout error",
    "forecast.band.default": "Range is the default width — too little history to measure one",
    "forecast.basis": "Projected from {count} closed periods, the last of them {last}",
    "forecast.none": "Not enough closed history to project from yet. The projection needs at least four closed periods.",
    "stat.latest": "Latest",
    "stat.periods": "Periods held",
    "stat.change": "Change on prior",
    "definition.title": "How this metric is defined",
    "definition.sql": "Computed from",
    "definition.owner": "Owner",
    "definition.sensitivity": "Sensitivity",
    "definition.direction": "Better when",
    "definition.target": "Target",
    "definition.unset": "Not recorded",
    "definition.edit": "Edit this definition in Insight admin",
    up: "Rising",
    down: "Falling",
    public: "Public",
    internal: "Internal",
    restricted: "Restricted",
    "metrics.none.title": "No metrics are registered",
    "metrics.none.body": "A tenant administrator registers metrics in Insight admin before anything can be explored.",
    denied: "You do not have permission to read snapshots. Ask a tenant administrator for Insight metric access."
  },
  ar: {
    title: "مستكشف المؤشرات",
    kicker: "مؤشر واحد، وسلسلته، والتعريف الذي وراءه",
    intro: "كل نقطة لقطة مغلقة من الطبقة الدلالية. غيّر التعريف وستُعلَّم لحظة تغيّره على السلسلة، لا يُعاد صياغتها بصمت.",
    metric: "المؤشر",
    grain: "التفصيل",
    day: "يومي",
    week: "أسبوعي",
    month: "شهري",
    apply: "اعرض السلسلة",
    "series.title": "السلسلة",
    "series.caption": "قيم اللقطات للمؤشر المحدد، من الأقدم إلى الأحدث",
    "series.period": "الفترة",
    "series.value": "القيمة",
    "series.change": "التغير",
    "series.taken": "وقت اللقطة",
    "definition.changed": "تغيّر التعريف",
    "series.none.title": "لا توجد لقطات لهذا المؤشر بعد",
    "breakdown.title": "التفصيل",
    "breakdown.caption": "يُقاس هذا المؤشر حسب بُعد، فلا يوجد خط واحد لرسمه. صف لكل بُعد في كل فترة.",
    "breakdown.dimension": "البُعد",
    "breakdown.period": "الفترة",
    "breakdown.value": "القيمة",
    "series.none.body": "يكتب المُلقِط صفاً عند إغلاق الفترة. شغّله من قسم تطوير التحليلات التنفيذية إذا احتجت لقطة قبل النافذة الليلية.",
    "forecast.title": "كيف تبدو الفترات القادمة",
    "forecast.caption": "القيمة المتوقعة لكل فترة، مع المدى الذي يضعه النموذج حولها",
    "forecast.period": "الفترة",
    "forecast.low": "الأدنى (p10)",
    "forecast.mid": "المتوقع (p50)",
    "forecast.high": "الأعلى (p90)",
    "forecast.method": "الطريقة",
    "forecast.params": "المعاملات",
    "forecast.band.empirical": "المدى مقيس من خطأ فترة الاختبار",
    "forecast.band.default": "المدى هو العرض الافتراضي — التاريخ أقصر من أن يُقاس منه",
    "forecast.basis": "متوقع من {count} فترة مغلقة، آخرها {last}",
    "forecast.none": "لا يوجد تاريخ مغلق كافٍ للتوقع بعد. يحتاج التوقع إلى أربع فترات مغلقة على الأقل.",
    "stat.latest": "الأحدث",
    "stat.periods": "عدد الفترات",
    "stat.change": "التغير عن السابق",
    "definition.title": "كيف يُعرَّف هذا المؤشر",
    "definition.sql": "محسوب من",
    "definition.owner": "المسؤول",
    "definition.sensitivity": "الحساسية",
    "definition.direction": "الأفضل عندما",
    "definition.target": "المستهدف",
    "definition.unset": "غير مسجل",
    "definition.edit": "عدّل هذا التعريف في إدارة التحليلات التنفيذية",
    up: "يرتفع",
    down: "ينخفض",
    public: "عام",
    internal: "داخلي",
    restricted: "مقيد",
    "metrics.none.title": "لا توجد مؤشرات مسجلة",
    "metrics.none.body": "يسجّل مدير المؤسسة المؤشرات في إدارة التحليلات التنفيذية قبل أن يكون هناك ما يُستكشف.",
    denied: "لا تملك صلاحية قراءة اللقطات. اطلب من مدير المؤسسة صلاحية مؤشرات التحليلات التنفيذية."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ----------------------------------------------------------------- helpers */

/**
 * Basis-point change of the last snapshot on the one before it. `null` when
 * there is no prior, or when the prior was zero and a ratio would be infinite.
 */
export function deltaBps(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const last = values[values.length - 1]!;
  const prior = values[values.length - 2]!;
  if (prior === 0) return null;
  return Math.round(((last - prior) / Math.abs(prior)) * 10_000);
}

/**
 * The direction a hero can headline the metric's latest move with. `null`
 * when there is nothing to report yet — fewer than two snapshots, or no
 * change at all — so the headline falls back to naming the metric instead of
 * guessing a trend that isn't there.
 */
export function headlineDirection(values: readonly number[]): "up" | "down" | null {
  const bps = deltaBps(values);
  if (!bps) return null;
  return bps > 0 ? "up" : "down";
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const url = new URL(request.url);

  const metrics = (await readable(api<Page<Metric>>("/v1/north/metrics?limit=200", opts)))?.data ?? [];
  const asked = url.searchParams.get("metric");
  const metric = metrics.find((row) => row.key === asked) ?? metrics[0] ?? null;
  const grain = GRAINS.find((one) => one === url.searchParams.get("grain")) ?? metric?.grain ?? "day";
  // ?asOf=<epoch-ms> replays the series as of a past moment (Meridian's
  // replay mode) — an upper time bound on the snapshots query.
  const asOf = url.searchParams.get("asOf")?.trim();
  // A non-numeric ?asOf= is not a moment — replay stays off rather than
  // sending `&to=NaN` upstream.
  const to = asOf && Number.isFinite(Number(asOf)) ? `&to=${encodeURIComponent(asOf)}` : "";

  // Newest first, then flipped for the chart: a tenant with more history than
  // WINDOW wants the recent end of it, not the first 90 periods it ever had.
  // Dimensional rows (dims_hash != "") are slices of a period, not extra
  // points, and the list API can't exclude them — an empty filter value is
  // dropped — so over-fetch and drop them here.
  const page = metric
    ? await readable(
        api<Page<Snapshot>>(
          `/v1/north/snapshots?metricKey=${encodeURIComponent(metric.key)}&grain=${grain}&sort=period&order=desc&limit=${MAX_PAGE}${to}`,
          opts
        )
      )
    : { data: [] as Snapshot[] };
  const snapshots = page ? page.data.filter((row) => !row.dimsHash).slice(0, WINDOW).reverse() : null;
  // ...and the dimensional rows are kept rather than discarded.
  //
  // The 2026-10-01 sweep's NORTH work made the market cut a **metric**
  // (`gwp_by_market`), which writes **only** dimensional rows. This filter drops
  // exactly those, so the market metric appeared in the picker and rendered
  // "No snapshots for this metric yet" — a money figure with no reader at all.
  //
  // A dims row is not an extra point on a line (which is why the chart still gets
  // only the undimensioned ones: `LineChart` is single-series). It is a **row of a
  // breakdown**, and a breakdown is read as a table.
  const slices = page ? page.data.filter((row) => !!row.dimsHash).slice(0, MAX_PAGE) : [];

  // The projection (docs/27 F50). `north:forecasts:read` is its own permission,
  // deliberately not implied by `north:snapshots:read` — a forward-looking
  // number is a different disclosure from a recorded one — so a reader who
  // lacks it loses this card and keeps the screen, which is what readable() is
  // for. Week grain has no forecast: the endpoint projects the two grains the
  // snapshotter writes.
  const forecast =
    metric && grain !== "week"
      ? ((await readable(
          api<Forecast>(
            `/v1/north/forecast?metricKey=${encodeURIComponent(metric.key)}&grain=${grain}&horizon=${HORIZON}`,
            opts
          )
        )) ?? null)
      : null;

  // The definition's history (docs/modules/north.md §8: "a metric definition
  // change shows as a chart annotation from the change date"). Readable, so a
  // reader who lacks `north:metrics:read` loses the annotation and keeps the
  // series — the same taper as the forecast card.
  const definitionChanges = metric
    ? ((await readable(
        api<Page<DefinitionChange>>(
          `/v1/north/metric-definitions?metricKey=${encodeURIComponent(metric.key)}&sort=changedAt&order=desc&limit=50`,
          opts
        )
      ))?.data ?? [])
    : [];

  return { metrics, metric, grain, snapshots, slices, forecast, definitionChanges };
}

/* --------------------------------------------------------------- the screen */

export default function NorthExplorer() {
  const { metrics, metric, grain, snapshots, slices, forecast, definitionChanges } = useLoaderData<typeof loader>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";

  const rows = snapshots ?? [];
  const values = rows.map((row) => row.value);
  const direction = headlineDirection(values);
  const change = pct(deltaBps(values), locale);
  const target = parsed<{ value?: number } | null>(metric?.targetJson, null);

  // Where each definition change landed in the series: the **first snapshot taken
  // at or after** the change. A snapshot taken before it was computed from the
  // old definition, so marking it would put the annotation on the wrong period —
  // and one period can carry only the most recent change, because a second mark
  // on the same row says nothing a reader can act on.
  const changeAt = new Map<string, DefinitionChange>();
  for (const change of definitionChanges) {
    const landed = rows.find((row) => row.ts >= change.changedAt);
    if (landed && !changeAt.has(landed.id)) changeAt.set(landed.id, change);
  }
  // The same landing period, as a position in the series, so the chart can mark
  // it from the change date. Chart and table are derived from one map, so they
  // cannot disagree about when the definition changed.
  const chartMarks = rows
    .map((row, index) => (changeAt.has(row.id) ? { index, label: l("definition.changed") } : null))
    .filter((mark): mark is { index: number; label: string } => mark !== null);

  const shown = (value: number) => (
    <MetricValue value={value} unit={metric?.unit ?? "count"} currency={metric?.currency ?? null} locale={locale} />
  );

  // The headline narrates the actual series rather than repeating the kicker:
  // the metric's name plus which way its last two snapshots moved, when there
  // are enough of them to say so. This is arithmetic on real snapshot values
  // (deltaBps above), not a model call, so it carries no ✦ mark.
  const headline =
    metric && direction ? (
      <>
        {metricName(metric, locale)} {l(direction)} {change}
      </>
    ) : metric ? (
      metricName(metric, locale)
    ) : (
      l("title")
    );

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="eyebrow">{l("kicker")}</span>
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        {metric ? (
          <Link
            to={`/north/admin?metric=${encodeURIComponent(metric.id)}`}
            className="w-fit font-ui text-13 text-accent underline"
          >
            {l("definition.edit")}
          </Link>
        ) : null}
      </header>

      {metrics.length === 0 ? (
        <EmptyState title={l("metrics.none.title")} body={l("metrics.none.body")} />
      ) : (
        <>
          {/* A GET form: the chosen metric and grain live in the URL, so a
              series a person is reading can be sent to somebody else. */}
          <Form method="get" className="flex flex-wrap items-end gap-4">
            <Field label={l("metric")}>
              <Select
                name="metric"
                defaultValue={metric?.key ?? ""}
                aria-label={l("metric")}
                options={metrics.map((row) => ({ value: row.key, label: metricName(row, locale) }))}
              />
            </Field>
            <Field label={l("grain")}>
              <Select
                name="grain"
                defaultValue={grain}
                aria-label={l("grain")}
                options={GRAINS.map((one) => ({ value: one, label: l(one) }))}
              />
            </Field>
            <Button type="submit" disabled={busy}>
              {l("apply")}
            </Button>
          </Form>

          {snapshots === null ? (
            <Card><p className="font-ui text-13 text-subtle">{l("denied")}</p></Card>
          ) : rows.length === 0 && slices.length > 0 ? (
            // A dimensioned metric, read as a breakdown. It has **no single line to
            // draw** — `LineChart` is single-series, and one line through nine markets
            // would mean nothing — so the reader is a table rather than an empty state.
            // Before this the market metric rendered "No snapshots for this metric yet"
            // because the loader dropped exactly the rows it writes.
            <Card title={l("breakdown.title")} description={l("breakdown.caption")}>
              <Table
                caption={l("breakdown.title")}
                rowKey={(row) => `${row.period}:${row.dimension}`}
                columns={[
                  { key: "period", header: l("breakdown.period"), render: (row) => row.period },
                  { key: "dimension", header: l("breakdown.dimension"), render: (row) => row.dimension },
                  { key: "value", header: l("breakdown.value"), numeric: true, render: (row) => row.value }
                ]}
                rows={[...slices]
                  // Newest first, and within a period the dimensions in a stable order,
                  // so the same market does not move between refreshes.
                  .sort((a, b) => b.period.localeCompare(a.period) || a.dimsHash.localeCompare(b.dimsHash))
                  .map((row) => ({
                    period: row.period,
                    dimension: row.dimsHash,
                    value: shown(row.value)
                  }))}
              />
            </Card>
          ) : rows.length === 0 ? (
            <EmptyState title={l("series.none.title")} body={l("series.none.body")} />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <Stat label={l("stat.latest")} value={shown(values[values.length - 1]!)} />
                <Stat label={l("stat.periods")} value={String(rows.length)} />
                <Stat label={l("stat.change")} value={change ?? "—"} />
              </div>

              <Card>
                <LineChart
                  values={values}
                  label={metric ? metricName(metric, locale) : l("series.title")}
                  xLabels={rows.map((row) => row.period)}
                  annotations={chartMarks}
                  format={(value) => metricText(value, metric?.unit ?? "count", metric?.currency ?? null, locale)}
                />
              </Card>

              <Card>
                <Table
                  caption={l("series.caption")}
                  rows={[...rows].reverse()}
                  rowKey={(row) => row.id}
                  columns={[
                    {
                      key: "period",
                      header: l("series.period"),
                      render: (row) =>
                        changeAt.has(row.id) ? (
                          // The annotation docs/modules/north.md §8 asks for, on
                          // the period the definition changed in. A chart mark
                          // would need `LineChart` to grow one; a marked row is
                          // what the table can carry today, and it names the date
                          // rather than implying it.
                          <span className="flex flex-col">
                            <span>{row.period}</span>
                            <span className="font-ui text-12 text-accent">
                              {l("definition.changed")} <DateTime value={changeAt.get(row.id)!.changedAt} locale={locale} />
                            </span>
                          </span>
                        ) : (
                          row.period
                        )
                    },
                    { key: "value", header: l("series.value"), numeric: true, render: (row) => shown(row.value) },
                    {
                      key: "taken",
                      header: l("series.taken"),
                      render: (row) => <DateTime value={row.ts} locale={locale} />
                    }
                  ]}
                />
              </Card>
            </>
          )}

          {/* Arithmetic, not a model (packages/core/src/north-forecast.ts), so no
              marker: docs/15's mark is for what a model wrote, and marking a
              damped Holt fit would make the mark mean less. The parameters
              below are the inspectable "why" instead. */}
          {forecast ? (
            <Card>
              <h2 className="mb-3 section-title">{l("forecast.title")}</h2>
              {forecast.points.length === 0 ? (
                <p className="font-ui text-13 text-subtle">{l("forecast.none")}</p>
              ) : (
                <>
                  <Table
                    caption={l("forecast.caption")}
                    rows={forecast.points}
                    rowKey={(row) => row.period}
                    columns={[
                      { key: "period", header: l("forecast.period"), render: (row) => row.period },
                      { key: "p10", header: l("forecast.low"), numeric: true, render: (row) => shown(row.p10) },
                      { key: "p50", header: l("forecast.mid"), numeric: true, render: (row) => shown(row.p50) },
                      { key: "p90", header: l("forecast.high"), numeric: true, render: (row) => shown(row.p90) }
                    ]}
                  />
                  <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Definition term={l("forecast.method")} value={forecast.fit.method} mono />
                    <Definition
                      term={l("forecast.params")}
                      value={`\u03b1 ${ppm(forecast.fit.alphaPpm)} \u00b7 \u03b2 ${ppm(forecast.fit.betaPpm)} \u00b7 \u03c6 ${ppm(forecast.fit.phiPpm)}`}
                      mono
                    />
                  </dl>
                  <p className="mt-3 font-ui text-13 text-subtle">
                    {l(forecast.fit.intervalSource === "empirical" ? "forecast.band.empirical" : "forecast.band.default")}
                  </p>
                  {forecast.fit.lastObserved ? (
                    <p className="eyebrow mt-1">
                      {l("forecast.basis", { count: String(forecast.fit.observations), last: forecast.fit.lastObserved })}
                    </p>
                  ) : null}
                </>
              )}
            </Card>
          ) : null}

          {metric ? (
            <Card>
              <h2 className="mb-3 section-title">{l("definition.title")}</h2>
              <dl className="grid gap-3 sm:grid-cols-2">
                <Definition term={l("definition.sql")} value={metric.definitionSqlRef ?? l("definition.unset")} mono />
                <Definition term={l("definition.owner")} value={metric.owner ?? l("definition.unset")} />
                <Definition term={l("definition.sensitivity")} value={l(metric.sensitivity)} />
                <Definition term={l("definition.direction")} value={l(metric.direction)} />
                <Definition
                  term={l("definition.target")}
                  value={
                    typeof target?.value === "number" ? shown(target.value) : l("definition.unset")
                  }
                />
              </dl>
              <p className="eyebrow mt-3">{metric.key}</p>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A fitted parameter as a person reads it: 0.35, not 350000. */
export const ppm = (value: number): string => (value / 1_000_000).toFixed(2);

function Definition({ term, value, mono = false }: { term: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow">{term}</dt>
      <dd className={mono ? "font-mono text-12 text-text" : "font-ui text-13 text-text"}>{value}</dd>
    </div>
  );
}

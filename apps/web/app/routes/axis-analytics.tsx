import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  GuardrailNotice,
  KPIWall,
  ProgressBar,
  Select,
  Stat,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { axis } from "../modules/axis";
import { labelsFor, optionLabel } from "../modules/spec";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { labelsFrom } from "./detail-kit";

// Four operational numbers: how much work came in, how much of it went wrong,
// how long a case takes end to end, and how often the promised date was met.
//
// The first two come from the platform's own semantic layer — `POST
// /v1/analytics/run` over the registered `cases` dataset — so they are exact,
// tenant-scoped and exportable by the same pipeline every other report uses.
//
// The last two do not. `DATASETS.cases` (apps/api/src/engines/report.ts) exposes
// no `closed_at` or `sla_due_at`, so cycle time and SLA attainment cannot be
// aggregated by the report engine at all; they are computed here over one page of
// recent cases. That ceiling is named in the UI, not hidden — see SAMPLE below.

/** apps/api/src/routes/analytics.ts ExportBody.format. */
const FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/** apps/api/src/engines/report.ts DATASETS.cases. */
const DATASET = "cases";

export const PERM = {
  cases: "axis:cases:read",
  run: "analytics:reports:run",
  export: "analytics:exports:create"
} as const;

export const WINDOWS = [7, 30, 90, 365] as const;

/**
 * The statuses that mean the work did not flow: a case sitting in one of these
 * needed a person the process did not plan for.
 */
export const EXCEPTION_STATUSES = ["failed", "rejected", "cancelled", "awaiting_docs"] as const;

/**
 * ponytail: cycle time and SLA attainment are computed over one page of the most
 * recent cases (MAX_PAGE in apps/api/src/crud.ts), not the whole window. The
 * upgrade is a `closed_at`/`sla_due_at` pair on DATASETS.cases — with those, both
 * figures become metrics and this sampling disappears.
 */
export const SAMPLE = 200;

const DAY_MS = 86_400_000;

export function windowDays(raw: string | null): number {
  const asked = Number(raw);
  return WINDOWS.some((days) => days === asked) ? asked : 30;
}

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Operations analytics",
    xlsx: "Excel (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    intro:
      "What came in, what went wrong, how long it took and whether the promised date held. Throughput and exceptions are queried; the two duration figures are sampled — the card says which.",
    window: "Window",
    days: "{n} days",
    "stat.throughput": "Cases opened",
    "stat.exceptions": "Exception rate",
    "stat.cycle": "Median cycle time",
    "stat.sla": "SLA attainment",
    "unit.days": "{n}d",
    "unit.hours": "{n}h",
    "byPeriod.title": "Throughput",
    "byPeriod.caption": "Cases opened per day in the selected window",
    "byPeriod.period": "Day",
    "byPeriod.cases": "Cases",
    "byStatus.title": "Where the work is",
    "byStatus.caption": "Cases in the window by status",
    "byStatus.status": "Status",
    "byStatus.cases": "Cases",
    "byStatus.share": "Share",
    "byStatus.exception": "Exception",
    "duration.title": "How long a case takes",
    "duration.caption": "Cycle time and SLA attainment over the sampled cases",
    "duration.closed": "Cases closed in the sample",
    "duration.median": "Median",
    "duration.p90": "Slowest tenth (p90)",
    "duration.slaMeasured": "Cases with a promised date",
    "duration.slaMet": "Closed on or before it",
    "sample.title": "These two figures are a sample",
    "sample.reason":
      "The reporting layer has no closed-at or due-at column on cases, so cycle time and SLA attainment are computed over the last {n} cases rather than the whole window. Throughput and the exception rate above are queried in full.",
    "export.title": "Export",
    "export.intro":
      "Rendered by the platform's own export pipeline over the same dataset, with PII masked on the way out.",
    "export.format": "Format",
    "export.submit": "Export",
    "export.download": "Download",
    "export.rows": "{n} rows",
    "export.failed": "The export did not render: {error}",
    "empty.title": "Nothing to measure yet",
    "empty.body": "No case was opened in this window.",
    "problem.bad_intent": "The form did not carry an action this screen knows.",
    "problem.format_required": "Pick a file format to export.",
    "problem.hidden": "You do not have the reporting permission this screen needs.",
    "headline.clear": "No case was opened in this window",
    "headline.exceptions": "{pct}% of cases hit an exception in this window",
    "headline.normal": "{opened} cases opened, running clean",
    "headline.open": "Open the exception queue"
  },
  ar: {
    title: "تحليلات العمليات",
    xlsx: "إكسل (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    intro:
      "ما وصل، وما تعطّل، وكم استغرق، وهل التُزم بالتاريخ الموعود. الإنتاجية والاستثناءات مستعلَمة، أما رقما المدة فمُعتمدان على عيّنة — والبطاقة تقول أيّهما.",
    window: "النطاق الزمني",
    days: "{n} يومًا",
    "stat.throughput": "حالات مفتوحة",
    "stat.exceptions": "نسبة الاستثناءات",
    "stat.cycle": "وسيط زمن الدورة",
    "stat.sla": "الالتزام بمستوى الخدمة",
    "unit.days": "{n} ي",
    "unit.hours": "{n} س",
    "byPeriod.title": "الإنتاجية",
    "byPeriod.caption": "الحالات المفتوحة يوميًا في النطاق المحدد",
    "byPeriod.period": "اليوم",
    "byPeriod.cases": "الحالات",
    "byStatus.title": "موضع العمل",
    "byStatus.caption": "حالات النطاق حسب الوضع",
    "byStatus.status": "الوضع",
    "byStatus.cases": "الحالات",
    "byStatus.share": "النسبة",
    "byStatus.exception": "استثناء",
    "duration.title": "كم تستغرق الحالة",
    "duration.caption": "زمن الدورة والالتزام بمستوى الخدمة على الحالات المُعيَّنة",
    "duration.closed": "حالات مُغلقة في العيّنة",
    "duration.median": "الوسيط",
    "duration.p90": "الأبطأ عُشرًا (p90)",
    "duration.slaMeasured": "حالات لها تاريخ موعود",
    "duration.slaMet": "أُغلقت في موعدها أو قبله",
    "sample.title": "هذان الرقمان عيّنة",
    "sample.reason":
      "طبقة التقارير لا تملك عمود الإغلاق أو الاستحقاق على الحالات، لذا يُحسب زمن الدورة والالتزام على آخر {n} حالة لا على النطاق كله. أما الإنتاجية ونسبة الاستثناءات أعلاه فمستعلَمتان بالكامل.",
    "export.title": "التصدير",
    "export.intro": "يُصدر عبر خط تصدير المنصة نفسه على البيانات ذاتها، مع إخفاء البيانات الشخصية عند الخروج.",
    "export.format": "الصيغة",
    "export.submit": "تصدير",
    "export.download": "تنزيل",
    "export.rows": "{n} صفًا",
    "export.failed": "لم يُنجز التصدير: {error}",
    "empty.title": "لا شيء لقياسه بعد",
    "empty.body": "لم تُفتح أي حالة في هذا النطاق.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "problem.format_required": "اختر صيغة ملف للتصدير.",
    "problem.hidden": "لا تملك صلاحية التقارير التي تحتاجها هذه الشاشة.",
    "headline.clear": "لم تُفتح أي حالة في هذا النطاق",
    "headline.exceptions": "{pct}٪ من الحالات واجهت استثناءً في هذا النطاق",
    "headline.normal": "فُتحت {opened} حالة، والسير سليم",
    "headline.open": "افتح قائمة الاستثناءات"
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- shapes */

/** apps/api/src/routes/analytics.ts POST /run response (a ReportTable + runId). */
export interface RunTable {
  columns: { key: string; label: string; kind: string }[];
  rows: Record<string, unknown>[];
  totals?: Record<string, number>;
}

export interface CaseRow {
  id: string;
  status: string;
  slaDueAt: number | null;
  closedAt: number | null;
  createdAt: number;
}

export interface StatusRow {
  status: string;
  cases: number;
  share: number;
  exception: boolean;
}

export interface PeriodRow {
  period: string;
  cases: number;
}

interface ExportRow {
  id: string;
  format: string;
  state: string;
  rowCount: number | null;
  error: string | null;
}

/* ---------------------------------------------------------------- helpers */

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export const isException = (status: string): boolean =>
  EXCEPTION_STATUSES.some((bad) => bad === status);

/** The status breakdown, biggest pile first, with each pile's share of the window. */
export function statusRows(table: RunTable | null): StatusRow[] {
  const rows = (table?.rows ?? []).map((row) => ({
    status: text(row["status"]) || "unknown",
    cases: num(row["cases"])
  }));
  const total = rows.reduce((sum, row) => sum + row.cases, 0);
  return rows
    .map((row) => ({
      ...row,
      share: total > 0 ? row.cases / total : 0,
      exception: isException(row.status)
    }))
    .sort((a, b) => b.cases - a.cases);
}

export const totalCases = (rows: StatusRow[]): number => rows.reduce((sum, row) => sum + row.cases, 0);

/** Share of the window's cases that stalled. 0 when there was no work at all. */
export function exceptionRate(rows: StatusRow[]): number {
  const total = totalCases(rows);
  if (total === 0) return 0;
  return rows.filter((row) => row.exception).reduce((sum, row) => sum + row.cases, 0) / total;
}

/** The day-grained series, oldest first, so a chart or table reads left to right. */
export function periodRows(table: RunTable | null): PeriodRow[] {
  return (table?.rows ?? [])
    .map((row) => ({ period: text(row["period"]), cases: num(row["cases"]) }))
    .filter((row) => row.period !== "")
    .sort((a, b) => a.period.localeCompare(b.period));
}

/** Nearest-rank percentile over a sorted list. `q` is 0–1. */
export function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface CycleStats {
  closed: number;
  medianMs: number | null;
  p90Ms: number | null;
}

/**
 * Time from opened to closed, over the cases that actually closed. An open case
 * has no cycle time yet — counting its age so far would drag the median toward
 * whatever is currently in flight.
 */
export function cycleStats(cases: CaseRow[]): CycleStats {
  const spans = cases
    .filter((row) => typeof row.closedAt === "number" && row.closedAt >= row.createdAt)
    .map((row) => row.closedAt! - row.createdAt)
    .sort((a, b) => a - b);
  return { closed: spans.length, medianMs: percentile(spans, 0.5), p90Ms: percentile(spans, 0.9) };
}

export interface SlaStats {
  measured: number;
  met: number;
  rate: number | null;
}

/**
 * Attainment over the cases that had a promised date and reached an end. A case
 * with no deadline was never promised anything, and counting it as met would
 * flatter the number; an open case past its date is already a breach, so it
 * counts against.
 */
export function slaStats(cases: CaseRow[], now: number): SlaStats {
  const dated = cases.filter((row) => typeof row.slaDueAt === "number");
  const judged = dated.filter((row) => typeof row.closedAt === "number" || row.slaDueAt! < now);
  const met = judged.filter(
    (row) => typeof row.closedAt === "number" && row.closedAt <= row.slaDueAt!
  ).length;
  return { measured: judged.length, met, rate: judged.length > 0 ? met / judged.length : null };
}

/** One coarse unit — an operations number nobody reads to the millisecond. */
export function durationIn(ms: number | null, l: Label): string {
  if (ms === null) return "—";
  return ms >= DAY_MS
    ? l("unit.days", { n: String(Math.round(ms / DAY_MS)) })
    : l("unit.hours", { n: String(Math.max(1, Math.round(ms / 3_600_000))) });
}

export const asPercent = (share: number | null, locale: string): string =>
  share === null
    ? "—"
    : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(share);

/** Above this an exception rate is worth calling out by itself, not just tabled. */
export const EXCEPTION_ALERT = 0.2;

// Arithmetic on counts the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11).
export function headlineFor(counts: { opened: number; exceptionRate: number }, l: Label): string {
  if (counts.opened === 0) return l("headline.clear");
  if (counts.exceptionRate >= EXCEPTION_ALERT)
    return l("headline.exceptions", { pct: String(Math.round(counts.exceptionRate * 100)) });
  return l("headline.normal", { opened: String(counts.opened) });
}

async function safe<T>(call: Promise<T>, fallback: T): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

/** The definition both the on-screen numbers and the export file are built from. */
export function definitionFor(from: number, to: number, grain: "none" | "day") {
  return {
    dataset: DATASET,
    metrics: ["cases", "value"],
    dimensions: grain === "day" ? [] : ["status"],
    grain,
    from,
    to
  };
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const days = windowDays(new URL(request.url).searchParams.get("days"));
  const to = Date.now();
  const from = to - days * DAY_MS;

  const [byStatus, byPeriod, sample] = await Promise.all([
    safe(
      api<RunTable>("/v1/analytics/run", {
        ...opts,
        method: "POST",
        body: { ...definitionFor(from, to, "none"), totals: true }
      }),
      null
    ),
    safe(
      api<RunTable>("/v1/analytics/run", {
        ...opts,
        method: "POST",
        body: { ...definitionFor(from, to, "day"), totals: false }
      }),
      null
    ),
    // The duration figures. `closedAt` and `slaDueAt` exist on the row but not in
    // the dataset, so they are read as rows and reduced here.
    safe(
      api<{ data: CaseRow[] }>(
        `/v1/axis/cases?from=${from}&to=${to}&sort=createdAt&order=desc&limit=${SAMPLE}`,
        opts
      ),
      { data: [] as CaseRow[] }
    )
  ]);

  return {
    days,
    from,
    to,
    now: Date.now(),
    apiOrigin: env.API_ORIGIN,
    byStatus,
    byPeriod,
    hidden: byStatus === null && byPeriod === null,
    sample: sample.data
  };
}

/* ----------------------------------------------------------------- action */

export interface Refusal {
  title: string;
  status: number;
  code?: string;
  detail?: string;
}

export interface ActionResult {
  problem: Refusal | null;
  exported: ExportRow | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const format = String(form.get("format") ?? "");

  if (String(form.get("intent") ?? "") !== "export")
    return { problem: { title: "bad_intent", status: 400, code: "bad_intent" }, exported: null };
  if (!FORMATS.some((allowed) => allowed === format))
    return { problem: { title: "format_required", status: 400, code: "format_required" }, exported: null };

  const days = windowDays(String(form.get("days") ?? ""));
  const to = Date.now();

  try {
    // The platform's own pipeline: it renders xlsx and PDF, masks PII and audits
    // the download. A second spreadsheet writer in the web app would do none of it.
    const exported = await api<ExportRow>("/v1/analytics/exports", {
      env,
      request,
      method: "POST",
      body: {
        format,
        // The window belongs inside the definition — the top-level from/to are
        // only merged for saved reports (analytics.ts §exports).
        definition: definitionFor(to - days * DAY_MS, to, "none"),
        totals: true
      }
    });
    return { problem: null, exported };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, exported: null };
    throw error;
  }
}

export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/**
 * A case status as the desk says it. The rollup comes back keyed the way the
 * table stores it — `quoting`, `failed` — and the breakdown printed exactly
 * that under a STATUS heading. AXIS already writes these labels for its own
 * screens (modules/axis.ts `status.*`, en and ar); this reads the same table.
 */
export function statusLabel(status: string, locale: string, pack?: string): string {
  return optionLabel(labelsFor(axis, locale, pack), "status", status);
}

/* -------------------------------------------------------------- the screen */

export default function AxisAnalytics() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const statusName = (status: string) => statusLabel(status, locale, shell?.domainPack);
  const held = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";

  const statuses = statusRows(loaded.byStatus);
  const periods = periodRows(loaded.byPeriod);
  const opened = totalCases(statuses);
  const cycle = cycleStats(loaded.sample);
  const sla = slaStats(loaded.sample, loaded.now);
  const exported = result?.exported ?? null;
  const rate = exceptionRate(statuses);
  const headline = headlineFor({ opened, exceptionRate: rate }, l);

  const statusColumns: Column<StatusRow>[] = [
    {
      key: "status",
      header: l("byStatus.status"),
      render: (row) => (
        <span className="flex items-center gap-2">
          <span className="font-ui text-13 text-text">{statusName(row.status)}</span>
          {row.exception ? (
            <Badge tone="danger" size="sm">
              {l("byStatus.exception")}
            </Badge>
          ) : null}
        </span>
      )
    },
    { key: "cases", header: l("byStatus.cases"), numeric: true, render: (row) => row.cases },
    {
      key: "share",
      header: l("byStatus.share"),
      render: (row) => (
        <ProgressBar
          value={Math.round(row.share * 100)}
          tone={row.exception ? "danger" : "accent"}
          label={`${statusName(row.status)}: ${asPercent(row.share, locale)}`}
        />
      )
    }
  ];

  const periodColumns: Column<PeriodRow>[] = [
    { key: "period", header: l("byPeriod.period"), render: (row) => row.period },
    { key: "cases", header: l("byPeriod.cases"), numeric: true, render: (row) => row.cases }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{headline}</h1>
          <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
          {rate >= EXCEPTION_ALERT ? (
            <Link to="/axis/exceptions" className="w-fit font-ui text-13 text-accent underline">
              {l("headline.open")}
            </Link>
          ) : null}
        </div>
        <nav aria-label={l("window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link
              key={days}
              to={`/axis/analytics?days=${days}`}
              aria-current={loaded.days === days ? "page" : undefined}
            >
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>
                {l("days", { n: String(days) })}
              </Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {loaded.hidden ? (
        <GuardrailNotice tone="info" title={l("problem.hidden")} reason={l("export.intro")} />
      ) : null}

      <KPIWall>
        <Stat label={l("stat.throughput")} value={opened} />
        <Stat label={l("stat.exceptions")} value={asPercent(exceptionRate(statuses), locale)} />
        <Stat label={l("stat.cycle")} value={durationIn(cycle.medianMs, l)} />
        <Stat label={l("stat.sla")} value={asPercent(sla.rate, locale)} />
      </KPIWall>

      <Card title={l("byStatus.title")}>
        <Table
          columns={statusColumns}
          rows={statuses}
          rowKey={(row) => row.status}
          caption={l("byStatus.caption")}
          captionHidden
          empty={<EmptyState title={l("empty.title")} body={l("empty.body")} />}
        />
      </Card>

      <Card title={l("byPeriod.title")}>
        <Table
          columns={periodColumns}
          rows={periods}
          rowKey={(row) => row.period}
          caption={l("byPeriod.caption")}
          captionHidden
          density="compact"
          empty={<EmptyState title={l("empty.title")} body={l("empty.body")} />}
        />
      </Card>

      <Card title={l("duration.title")} description={l("duration.caption")}>
        <div className="flex flex-col gap-4">
          <GuardrailNotice
            tone="info"
            title={l("sample.title")}
            reason={l("sample.reason", { n: String(SAMPLE) })}
          />
          <dl className="grid gap-4 sm:grid-cols-2">
            {[
              [l("duration.closed"), String(cycle.closed)],
              [l("duration.median"), durationIn(cycle.medianMs, l)],
              [l("duration.p90"), durationIn(cycle.p90Ms, l)],
              [l("duration.slaMeasured"), String(sla.measured)],
              [l("duration.slaMet"), `${sla.met} · ${asPercent(sla.rate, locale)}`]
            ].map(([term, value]) => (
              <div key={term} className="flex flex-col gap-1">
                <dt className="eyebrow">{term}</dt>
                <dd className="font-mono text-16 tabular-nums text-text">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Card>

      {held.has(PERM.export) ? (
        <Card title={l("export.title")} description={l("export.intro")}>
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="export" />
            <input type="hidden" name="days" value={loaded.days} />
            <Field label={l("export.format")} className="w-40">
              <Select
                name="format"
                defaultValue="xlsx"
                options={FORMATS.map((format) => ({ value: format, label: l(format) }))}
              />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("export.submit")}
            </Button>
            {exported && exported.state === "ready" ? (
              <span className="flex items-center gap-3">
                <Button asChild variant="primary">
                  <a
                    href={`${loaded.apiOrigin}/v1/analytics/exports/${exported.id}/download`}
                    rel="noopener"
                  >
                    {l("export.download")}
                  </a>
                </Button>
                <span className="font-ui text-12 text-subtle">
                  {l("export.rows", { n: String(exported.rowCount ?? 0) })}
                </span>
              </span>
            ) : null}
            {exported && exported.state !== "ready" ? (
              <span role="status" className="font-ui text-12 text-danger">
                {l("export.failed", { error: exported.error ?? exported.state })}
              </span>
            ) : null}
          </Form>
        </Card>
      ) : null}
    </div>
  );
}

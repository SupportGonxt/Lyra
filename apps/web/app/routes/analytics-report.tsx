import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, DateTime, EmptyState, Field, Select, Table, type Column } from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import type { DatasetInfo } from "../analytics-def";
import { Cell, FieldInput, toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { asJson } from "../json.js";
import { bodyFrom, type FieldSpec, type Row } from "../modules/spec";
import { refsIn } from "../names";
import { labelsFrom } from "./detail-kit";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// One saved report: what it asks the warehouse, the window you want it over,
// the figures it returned and a file to take away. The result table is built
// from the columns the run itself declares, so a report defined tomorrow —
// new dataset, new metrics — renders here without a code change.
//
// Runs are synchronous at the API (POST .../run returns the rows). The run row
// the loader reads is therefore history, not a result: it says when the report
// last ran and whether it worked, never what the numbers were. This screen
// shows figures only for a run it just triggered, which is the honest thing —
// yesterday's total dressed as today's is the bug this avoids.

/** ANALYTICS registry, apps/api/src/resources.ts — the gates on every call below. */
const PERM = {
  read: "analytics:reports:read",
  run: "analytics:reports:run",
  export: "analytics:exports:create",
  download: "analytics:exports:download"
} as const;

/** ExportBody.format, apps/api/src/routes/analytics.ts. No other value is accepted. */
const FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/** Run states that mean "no figures yet", not "no figures ever". */
const PENDING = new Set(["queued", "running"]);

export type ReportStatus = "running" | "ranNow" | "inProgress" | "lastFailed" | "stale" | "neverRun";

/**
 * Which line the status paragraph shows. Pure so the branch order — a run in
 * flight beats a fresh result beats history — is a one-line test, not an
 * inspection of the JSX.
 */
export function reportStatus(
  running: boolean,
  ran: boolean,
  pending: boolean,
  lastRunState: string | null
): ReportStatus {
  if (running) return "running";
  if (ran) return "ranNow";
  if (pending) return "inProgress";
  if (lastRunState === "failed") return "lastFailed";
  if (lastRunState) return "stale";
  return "neverRun";
}

/**
 * The overrides POST /reports/:id/run accepts, as spec fields so `FieldInput`
 * and `bodyFrom` do the rendering and the coercion. Only those a report's own
 * definition declares are offered: a report with no window has no window to ask
 * about.
 * ponytail: structured `filters` are omitted — editing a filter tree belongs to
 * the report builder, not to the screen that runs one.
 */
const PARAMS: readonly FieldSpec[] = [
  { name: "from", type: "date" },
  { name: "to", type: "date" },
  {
    name: "grain",
    type: "select",
    options: ["none", "day", "week", "month", "quarter", "year"]
  },
  { name: "limit", type: "number" }
];

/** POST /exports takes no grain — it re-runs the definition's own bucketing. */
const EXPORT_PARAMS = PARAMS.filter((field) => field.name !== "grain");

/**
 * `GET /v1/analytics/reports/:id` as `reportView()` sends it — see
 * apps/api/src/routes/analytics.ts. The route is hand-written, so crud.ts
 * `hydrate()` never touches its `*Json` columns and `definitionJson` arrives as
 * text; `reportView()` parses the two localised ones itself and sends
 * `name`/`description` beside them, `description` only when it has one.
 */
export interface ReportRow {
  id: string;
  key: string;
  module: string;
  name: Record<string, string>;
  description?: Record<string, string>;
  definitionJson: string;
  piiLevel: string;
  scope: string;
  updatedAt: number;
}

interface Definition {
  dataset?: string;
  metrics?: string[];
  dimensions?: string[];
  grain?: string;
  from?: number;
  to?: number;
  limit?: number;
  [key: string]: unknown;
}

interface RunRow {
  id: string;
  state: string;
  rowCount: number | null;
  truncated: boolean;
  durationMs: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

/** The run response: RunResult plus the id the API persisted it under. */
interface RunResult {
  runId: string;
  title: string;
  columns: { key: string; label: string; kind: "text" | "money" | "date" | "number" }[];
  rows: Row[];
  currency?: string;
  generatedAt: number;
  rowCount: number;
  truncated: boolean;
  totals?: Record<string, number>;
}

/** POST /exports returns the whole analytics_exports row (apps/api §exports). */
interface ExportRow {
  id: string;
  format: string;
  /** queued|rendering|ready|failed|expired. Rendering is synchronous inside the
   *  POST, so what comes back is already final — there is nothing to poll. */
  state: string;
  rowCount: number | null;
  sizeBytes: number | null;
  piiMasked: boolean;
  expiresAt: number | null;
  error: string | null;
}

/** How much run history to show. Enough to spot a report that fails nightly. */
const RUN_HISTORY = 8;

/** This screen's own vocabulary. The shared catalogue belongs to another owner. */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    report: "Report",
    parameters: "Parameters",
    from: "From",
    to: "To",
    grain: "Bucket by",
    limit: "Row limit",
    none: "No bucketing",
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
    year: "Year",
    run: "Run report",
    runStatus: "Run status",
    running: "Running the report…",
    ranNow: "Ran just now.",
    neverRun: "This report has not been run yet.",
    lastRunAt: "Last run",
    inProgress: "A run is still in progress. No figures are shown until it finishes.",
    lastFailed: "The last run failed.",
    stale: "Figures are not kept between visits. Run the report to see them.",
    noPermissionRun: "You may read this report but not run it.",
    results: "Results",
    totals: "Totals",
    truncated: "Cut off at the row limit — narrow the window or export the full set.",
    generated: "Generated",
    definition: "Definition",
    dataset: "Dataset",
    metrics: "Metrics",
    dimensions: "Dimensions",
    export: "Export",
    format: "Format",
    exportReady: "Export ready",
    xlsx: "Excel (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    denied: "You do not have permission to read this report.",
    "state.queued": "Queued",
    "state.running": "Running",
    "state.done": "Done",
    "state.failed": "Failed",
    "state.rendering": "Rendering",
    "state.ready": "Ready",
    history: "Recent runs",
    "col.started": "Started",
    "col.state": "State",
    "col.rows": "Rows",
    "col.duration": "Duration",
    "col.error": "Reason",
    ms: "ms",
    kb: "KB",
    piiTitle: "This report reads personal data",
    "pii.low": "Identifying columns come back pseudonymised unless your role may see them, and exports are masked the same way.",
    "pii.high":
      "It reaches direct identifiers. Every download is written to the audit log, exports are masked by default, and an unmasked copy needs a written reason plus a second approver — ask an administrator rather than working around it.",
    exportFailed: "The export could not be written.",
    expires: "Link expires",
    masked: "Masked",
    unmasked: "Unmasked",
    exportGone: "This file is no longer downloadable."
  },
  ar: {
    report: "تقرير",
    parameters: "المعايير",
    from: "من",
    to: "إلى",
    grain: "التجميع حسب",
    limit: "حد الصفوف",
    none: "بدون تجميع",
    day: "يوم",
    week: "أسبوع",
    month: "شهر",
    quarter: "ربع سنة",
    year: "سنة",
    run: "تشغيل التقرير",
    runStatus: "حالة التشغيل",
    running: "جارٍ تشغيل التقرير…",
    ranNow: "تم التشغيل الآن.",
    neverRun: "لم يتم تشغيل هذا التقرير بعد.",
    lastRunAt: "آخر تشغيل",
    inProgress: "لا يزال التشغيل جاريًا. لن تظهر الأرقام حتى ينتهي.",
    lastFailed: "فشل التشغيل الأخير.",
    stale: "لا يتم الاحتفاظ بالأرقام بين الزيارات. شغّل التقرير لعرضها.",
    noPermissionRun: "يمكنك قراءة هذا التقرير لكن ليس تشغيله.",
    results: "النتائج",
    totals: "الإجماليات",
    truncated: "تم القطع عند حد الصفوف — ضيّق النطاق أو صدّر المجموعة كاملة.",
    generated: "تم الإنشاء",
    definition: "التعريف",
    dataset: "مجموعة البيانات",
    metrics: "المقاييس",
    dimensions: "الأبعاد",
    export: "تصدير",
    format: "الصيغة",
    exportReady: "التصدير جاهز",
    xlsx: "إكسل (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    denied: "ليس لديك إذن لقراءة هذا التقرير.",
    "state.queued": "في الانتظار",
    "state.running": "قيد التشغيل",
    "state.done": "مكتمل",
    "state.failed": "فشل",
    "state.rendering": "قيد الإنشاء",
    "state.ready": "جاهز",
    history: "عمليات التشغيل الأخيرة",
    "col.started": "بدأ في",
    "col.state": "الحالة",
    "col.rows": "الصفوف",
    "col.duration": "المدة",
    "col.error": "السبب",
    ms: "مللي ثانية",
    kb: "كيلوبايت",
    piiTitle: "هذا التقرير يقرأ بيانات شخصية",
    "pii.low": "تعود الأعمدة المعرِّفة مستعارة ما لم يكن لدورك إذن رؤيتها، والتصدير مُقنَّع بالطريقة نفسها.",
    "pii.high":
      "يصل إلى معرِّفات مباشرة. كل تنزيل يُسجَّل في سجل التدقيق، والتصدير مُقنَّع افتراضيًا، والنسخة غير المقنَّعة تتطلب سببًا مكتوبًا وموافقة شخص ثانٍ — راجع المسؤول بدل الالتفاف على ذلك.",
    exportFailed: "تعذّر إنشاء ملف التصدير.",
    expires: "ينتهي الرابط",
    masked: "مُقنَّع",
    unmasked: "غير مُقنَّع",
    exportGone: "لم يعد هذا الملف قابلًا للتنزيل."
  }
};

// Local table, then detail-kit's SHARED, then `common.*` — the same chain every
// screen uses. A hand-rolled table cannot answer a key it never wrote down, and
// these screens build keys from enum values (docs/ui.md §7 P3-14).
const labelsIn = labelsFrom(LABELS);

/** The wire row as the screen reads it: the server's own parse of the localised
 *  columns, and this side's parse of the one it left as text. */
export function reportOf(row: ReportRow) {
  return {
    id: row.id,
    key: row.key,
    name: row.name ?? {},
    description: row.description ?? {},
    definition: asJson<Definition>(row.definitionJson, {}),
    piiLevel: row.piiLevel,
    updatedAt: row.updatedAt
  };
}

/** A per-locale JSON column (`nameJson`), read the way the actor reads. */
function textIn(bag: Record<string, string>, locale: string, fallback: string): string {
  return bag[locale] ?? bag.en ?? fallback;
}

/** The registry's own words for a dataset's measures and splits (GET /v1/analytics/datasets). */
export function fieldLabels(ds: DatasetInfo | undefined): Record<string, string> {
  return Object.fromEntries([...(ds?.dimensions ?? []), ...(ds?.metrics ?? [])].map((f) => [f.key, f.label]));
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const reportId = params.id ?? "";

  // The shell's bootstrap is not readable from a child loader, so this screen
  // asks for its own copy — and then makes only the calls the actor may make.
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    run: held.has(PERM.run),
    export: held.has(PERM.export),
    download: held.has(PERM.download)
  };
  const shut = { reportId, may, apiOrigin: env.API_ORIGIN, report: null, runs: [] as RunRow[], fields: {} as Record<string, string> };
  if (!held.has(PERM.read)) return shut;

  let row: ReportRow;
  try {
    row = await api<ReportRow>(`/v1/analytics/reports/${reportId}`, { env, request });
  } catch (error) {
    // `analytics:reports:read` gets you the catalogue; the report's own
    // `requiredPermission` gets you its contents (apps/api §readableReport). So
    // a 403 here is a normal outcome for a real actor, not a broken screen.
    if (error instanceof ApiError && error.status === 403) return shut;
    throw error;
  }

  // No "runs for this report" route exists; the generic resource does it, newest
  // first. History is the only place this screen can say a report has been
  // failing every night — a single latest row hides exactly that.
  const runs = await api<{ data: RunRow[] }>(
    `/v1/analytics/report-runs?reportId=${encodeURIComponent(reportId)}&sort=startedAt&order=desc&limit=${RUN_HISTORY}`,
    { env, request }
  ).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 403) return { data: [] as RunRow[] };
    throw error;
  });

  const report = reportOf(row);
  // Labels are a nicety: a reader the catalogue refuses still gets the report.
  const catalogue = await api<{ data: DatasetInfo[] }>("/v1/analytics/datasets", { env, request }).catch(() => ({ data: [] }));
  const fields = fieldLabels(catalogue.data.find((d) => d.key === report.definition.dataset));

  return {
    reportId,
    may,
    apiOrigin: env.API_ORIGIN,
    report,
    runs: runs.data,
    fields
  };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const reportId = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const overrides = bodyFrom(PARAMS, form);

  try {
    if (intent === "run") {
      const ran = await api<RunResult>(`/v1/analytics/reports/${reportId}/run`, {
        env,
        request,
        method: "POST",
        body: { ...overrides, totals: true }
      });
      // docs/30 Analytics 4: a split by channel or owner reads as names, not ids.
      return { problem: null, ran, exported: null, resolved: await names(refsIn(ran.rows), { env, request }) };
    }
    if (intent === "export") {
      const format = String(form.get("format") ?? "");
      if (!FORMATS.some((allowed) => allowed === format)) {
        return { problem: { title: "unknown format", status: 400 }, ran: null, exported: null };
      }
      const exported = await api<ExportRow>("/v1/analytics/exports", {
        env,
        request,
        method: "POST",
        body: { reportId, format, ...bodyFrom(EXPORT_PARAMS, form), totals: true }
      });
      return { problem: null, ran: null, exported };
    }
    return { problem: { title: "unknown intent", status: 400 }, ran: null, exported: null };
  } catch (error) {
    // A refused run or a PDF the API will not write for a non-Latin report is
    // information: keep the actor here with their window intact.
    if (error instanceof ApiError) return { problem: error.problem, ran: null, exported: null };
    throw error;
  }
}

export default function AnalyticsReport() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const submitting = String(navigation.formData?.get("intent") ?? "");

  const report = loaded.report;
  if (!report) return <EmptyState title={l("denied")} body={t("error.forbidden")} />;

  const name = textIn(report.name, locale, report.key);
  const description = textIn(report.description, locale, "");
  const definition = report.definition;
  const ran = result?.ran ?? null;
  const resolved = result && "resolved" in result ? result.resolved : {};
  const exported = result?.exported ?? null;
  const runs = loaded.runs;
  const lastRun = runs[0] ?? null;
  const pending = Boolean(lastRun && PENDING.has(lastRun.state));
  const status = reportStatus(busy && submitting === "run", Boolean(ran), pending, lastRun?.state ?? null);

  // The window inputs a report actually has. Anything it does not declare is
  // not the actor's to override.
  const params = PARAMS.filter((field) => definition[field.name] !== undefined);
  const defaults: Row = { ...definition };

  const columns: Array<Column<Row>> = (ran?.columns ?? []).map((column) => ({
    key: column.key,
    header: column.label,
    numeric: column.kind === "money" || column.kind === "number",
    render: (row: Row) => (
      <Cell
        column={{ name: column.key, type: column.kind, currencyFrom: "__currency" }}
        row={row}
        locale={locale}
        label={l}
        resolved={resolved}
      />
    )
  }));
  // The result carries one currency for the whole table; Cell reads it per row,
  // which is what makes a money column render as money rather than a number.
  const rows: Row[] = (ran?.rows ?? []).map((row, index) => ({
    ...row,
    __currency: ran?.currency ?? "",
    __key: String(index)
  }));
  const totalsRow: Row = { ...(ran?.totals ?? {}), __currency: ran?.currency ?? "" };

  // History, not results: a run row records that the report ran, never what it
  // returned. Its value is the pattern — a nightly report that fails every night
  // is invisible in a single latest-state line.
  const runColumns: Array<Column<RunRow>> = [
    {
      key: "startedAt",
      header: l("col.started"),
      render: (row) => <DateTime value={row.startedAt} locale={locale} precision="minute" />
    },
    {
      key: "state",
      header: l("col.state"),
      render: (row) => (
        <Badge tone={toneFor(row.state)} size="sm" dot>
          {l(`state.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "rowCount",
      header: l("col.rows"),
      numeric: true,
      render: (row) =>
        row.rowCount === null ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="tabular-nums">
            {row.rowCount}
            {row.truncated ? "+" : ""}
          </span>
        )
    },
    {
      key: "durationMs",
      header: l("col.duration"),
      numeric: true,
      render: (row) =>
        row.durationMs === null ? (
          <span className="text-subtle">—</span>
        ) : (
          <span className="tabular-nums">{`${row.durationMs} ${l("ms")}`}</span>
        )
    },
    {
      key: "error",
      header: l("col.error"),
      render: (row) =>
        row.error ? (
          <span className="text-danger">{row.error}</span>
        ) : (
          <span className="text-subtle">—</span>
        )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{name}</h1>
          <p role="status" aria-live="polite" className="font-ui text-13 text-muted">
            {status === "running" ? (
              l("running")
            ) : status === "ranNow" && ran ? (
              <>
                {l("ranNow")} {t("common.rows", { count: String(ran.rowCount) })} ·{" "}
                <DateTime value={ran.generatedAt} locale={locale} precision="minute" />
              </>
            ) : status === "inProgress" ? (
              l("inProgress")
            ) : (status === "lastFailed" || status === "stale") && lastRun ? (
              <>
                {status === "lastFailed" ? l("lastFailed") : l("stale")}{" "}
                <Badge tone={toneFor(lastRun.state)} size="sm" dot>
                  {l(`state.${lastRun.state}`)}
                </Badge>{" "}
                {l("lastRunAt")}{" "}
                <DateTime value={lastRun.startedAt} locale={locale} precision="minute" />
              </>
            ) : (
              l("neverRun")
            )}
          </p>
          {description ? <p className="font-ui text-13 text-muted">{description}</p> : null}
        </div>
      </header>

      <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-3">
        {(
          [
            ["dataset", definition.dataset ?? "—"],
            ["metrics", (definition.metrics ?? []).map((key) => loaded.fields[key] ?? l(key)).join(", ") || "—"],
            ["dimensions", (definition.dimensions ?? []).map((key) => loaded.fields[key] ?? l(key)).join(", ") || "—"]
          ] as const
        ).map(([key, value]) => (
          <div key={key} className="flex flex-col gap-1">
            <dt className="font-ui text-12 text-subtle">{l(key)}</dt>
            <dd className="font-ui text-13 text-text">{value}</dd>
          </div>
        ))}
      </dl>

      {/* The PII level is a property of the report, not of this run: say it
          before anyone presses export, not in the audit log afterwards. */}
      {report.piiLevel === "none" ? null : (
        <div
          role="note"
          className={
            report.piiLevel === "high"
              ? "flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 p-4"
              : "flex flex-col gap-1 rounded-lg border border-border p-4"
          }
        >
          <p className="font-ui text-13 font-medium text-text">{l("piiTitle")}</p>
          <p className="max-w-prose font-ui text-13 text-muted">{l(`pii.${report.piiLevel}`)}</p>
        </div>
      )}

      {result?.problem ? <Problem problem={result.problem} /> : null}

      {loaded.may.run || loaded.may.export ? (
        <Form method="post" className="flex flex-col gap-4 rounded-lg border border-border p-4">
          <h2 className="eyebrow">{l("parameters")}</h2>
          {params.length ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {params.map((field) => (
                <FieldInput key={field.name} field={field} row={defaults} label={l} />
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            {loaded.may.run ? (
              <Button type="submit" name="intent" value="run" loading={busy && submitting === "run"}>
                {l("run")}
              </Button>
            ) : null}
            {loaded.may.export ? (
              <>
                <Field label={l("format")} className="w-48">
                  <Select
                    name="format"
                    defaultValue="xlsx"
                    options={FORMATS.map((format) => ({ value: format, label: l(format) }))}
                  />
                </Field>
                <Button
                  type="submit"
                  name="intent"
                  value="export"
                  variant="secondary"
                  loading={busy && submitting === "export"}
                >
                  {l("export")}
                </Button>
              </>
            ) : null}
          </div>
          {!loaded.may.run ? (
            <p className="font-ui text-12 text-subtle">{l("noPermissionRun")}</p>
          ) : null}
        </Form>
      ) : null}

      {exported ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-border bg-surface-1 p-3">
          <span className="font-ui text-13 text-text">
            {exported.state === "ready" ? l("exportReady") : l("export")} · {l(exported.format)}
          </span>
          <Badge tone={toneFor(exported.state)} size="sm" dot>
            {l(`state.${exported.state}`)}
          </Badge>
          <Badge tone={exported.piiMasked ? "neutral" : "warning"} size="sm">
            {exported.piiMasked ? l("masked") : l("unmasked")}
          </Badge>
          {exported.rowCount === null ? null : (
            <span className="font-ui text-12 tabular-nums text-subtle">
              {t("common.rows", { count: String(exported.rowCount) })}
            </span>
          )}
          {exported.sizeBytes === null ? null : (
            <span className="font-ui text-12 tabular-nums text-subtle">
              {Math.max(1, Math.round(exported.sizeBytes / 1024))} {l("kb")}
            </span>
          )}
          {exported.expiresAt === null ? null : (
            <span className="font-ui text-12 text-subtle">
              {l("expires")}{" "}
              <DateTime value={exported.expiresAt} locale={locale} precision="minute" />
            </span>
          )}
          {exported.state === "failed" ? (
            <span role="alert" className="font-ui text-12 text-danger">
              {l("exportFailed")} {exported.error ?? ""}
            </span>
          ) : null}
          {exported.state === "expired" ? (
            <span className="font-ui text-12 text-subtle">{l("exportGone")}</span>
          ) : null}
          {exported.state === "ready" && loaded.may.download ? (
            // The API streams the file with its own content-disposition; a
            // spreadsheet writer in the browser would be a second implementation
            // of a thing that already exists server-side.
            // ponytail: straight to the API origin, so a cookie scoped to the web
            // host will not ride along — add a web-origin proxy route when the
            // session stops being same-site.
            <Button asChild variant="secondary" size="sm">
              <a
                href={`${loaded.apiOrigin}/v1/analytics/exports/${exported.id}/download`}
                rel="noopener"
              >
                {l("download")}
              </a>
            </Button>
          ) : null}
        </div>
      ) : null}

      {ran && !pending ? (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(row) => String(row.__key)}
          caption={`${name} — ${l("results")}`}
          density="compact"
          stickyHeader
          empty={<EmptyState title={t("common.empty.title")} body={t("common.empty.filtered")} />}
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
              <span className="font-ui text-12 tabular-nums text-subtle">
                {t("common.rows", { count: String(ran.rowCount) })}
                {ran.truncated ? ` · ${l("truncated")}` : ""}
              </span>
              {ran.totals ? (
                <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                  <dt className="font-ui text-12 text-subtle">
                    {l("totals")}
                  </dt>
                  {ran.columns
                    .filter((column) => ran.totals && column.key in ran.totals)
                    .map((column) => (
                      <dd key={column.key} className="font-ui text-13 tabular-nums text-text">
                        <span className="me-2 text-subtle">{column.label}</span>
                        <Cell
                          column={{
                            name: column.key,
                            type: column.kind,
                            currencyFrom: "__currency"
                          }}
                          row={totalsRow}
                          locale={locale}
                          label={l}
                        />
                      </dd>
                    ))}
                </dl>
              ) : null}
            </div>
          }
        />
      ) : (
        <EmptyState
          title={l("results")}
          body={pending ? l("inProgress") : lastRun ? l("stale") : l("neverRun")}
        />
      )}

      {runs.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="eyebrow">{l("history")}</h2>
          <Table
            columns={runColumns}
            rows={runs}
            rowKey={(row) => row.id}
            caption={`${name} — ${l("history")}`}
            density="compact"
            empty={<EmptyState title={l("history")} body={l("neverRun")} />}
          />
        </section>
      ) : null}
    </div>
  );
}

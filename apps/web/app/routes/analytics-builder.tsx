import * as React from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AgentBadge,
  Button,
  Checkbox,
  DonutChart,
  EmptyState,
  Field,
  Input,
  LineChart,
  Select,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import {
  FILTER_OPS,
  FILTER_ROWS,
  GRAINS,
  VALUELESS,
  builderHref,
  dayOf,
  decodeDef,
  defFromParams,
  encodeDef,
  fitToDataset,
  type DatasetInfo,
  type ReportDefinition
} from "../analytics-def";
import { Cell } from "../components/fields";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import type { Row } from "../modules/spec";
import { refsIn, type Names } from "../names";
import { labelsFrom } from "./detail-kit";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// The report builder (docs/09, docs/17 ANL-009): pick a dataset, its metrics
// and dimensions, a time grain, filters and a sort, and see the figures before
// deciding to keep them. Everything the builder knows about arrives from
// GET /v1/analytics/datasets — the same registry the API writes SQL from — so a
// dataset registered tomorrow is buildable here without a code change.
//
// The definition is the URL (`?def=`, analytics-def.ts). A build is therefore a
// link: the AI operations dashboard opens its figures here, and the ask bar
// hands its compiled question over the same way. The preview runs only when the
// link says `run=1` — a definition someone else (or a model) wrote is loaded
// for the reader to read and edit, never run on their behalf (docs/15).

/** ANALYTICS registry, packages/core/src/rbac.ts — the gates on every call below. */
const PERM = {
  run: "analytics:reports:run",
  write: "analytics:reports:write",
  schedule: "analytics:schedules:write"
} as const;

/** ScheduleBody.format, apps/api/src/routes/analytics.ts. */
export const FORMATS = ["pdf", "xlsx", "csv", "json"] as const;

/** A cadence the reader picks, and the cron the scheduler is handed for it. */
export const CADENCES: Record<string, string> = {
  daily: "0 6 * * *",
  weekly: "0 6 * * 1",
  monthly: "0 6 1 * *"
};

const LIMITS = ["25", "100", "500", "1000", "5000"] as const;

/** The run response: RunResult (apps/api/src/engines/report.ts) + `runId`, `totals`. */
export interface RunResult {
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

interface Refusal {
  title: string;
  status: number;
  detail?: string;
  requestId?: string;
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Report builder",
    intro: "Choose what to count and how to split it, preview the figures, then keep the ones worth keeping.",
    build: "Build",
    dataset: "Dataset",
    metrics: "Measures",
    dimensions: "Split by",
    grain: "Time bucket",
    none: "No bucketing",
    day: "Day",
    week: "Week",
    month: "Month",
    quarter: "Quarter",
    year: "Year",
    from: "From",
    to: "To",
    filterField: "Field",
    filterOp: "Test",
    filterValue: "Value",
    anyField: "No filter",
    "op.eq": "is",
    "op.neq": "is not",
    "op.in": "is one of (comma separated)",
    "op.gt": "is more than",
    "op.gte": "is at least",
    "op.lt": "is less than",
    "op.lte": "is at most",
    "op.contains": "contains",
    "op.is_null": "is empty",
    "op.not_null": "is not empty",
    sort: "Sort by",
    defaultSort: "The engine's order",
    period: "Period",
    dir: "Direction",
    desc: "Largest first",
    asc: "Smallest first",
    limit: "Row limit",
    preview: "Preview",
    pickMetric: "Pick at least one measure to preview.",
    notRun: "Nothing has run yet. Preview to see the figures — a shared or suggested build is never run for you.",
    results: "Preview",
    totals: "Totals",
    truncated: "Cut off at the row limit — narrow the window or raise the limit.",
    unavailable: "That link names a dataset you cannot report on, so the builder opened on one you can.",
    shareLink: "Link to this build",
    save: "Save as report",
    reportName: "Report name",
    scope: "Who sees it",
    tenant: "Everyone who may read the data",
    personal: "Only me",
    cadence: "Deliver it",
    once: "Don't schedule",
    daily: "Every day at 06:00",
    weekly: "Every Monday at 06:00",
    monthly: "On the 1st at 06:00",
    format: "File",
    recipients: "Recipients (emails, comma separated)",
    saved: "Saved.",
    scheduled: "Scheduled.",
    openReport: "Open the report",
    noRun: "You may read reports but not build them.",
    ask: "Ask in words",
    askPlaceholder: "e.g. AI spend by purpose over the last 30 days",
    askButton: "Compile",
    askLoad: "Load into the builder",
    "ask.outside": "The data you can report on does not cover that question. Nothing was guessed.",
    "ask.unclear": "That did not compile into a report. Try naming what to count and how to split it.",
    by: "by",
    since: "since",
    until: "until",
    xlsx: "Excel (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    "dataset.policies": "Cover in force",
    "dataset.quotes": "Quote requests",
    "dataset.quoteResponses": "Quote responses",
    "dataset.commissions": "Commission entries",
    "dataset.cases": "Work items",
    "dataset.transactions": "Ledger transactions",
    "dataset.aiRuns": "AI runs",
    "dataset.aiSpend": "AI calls and spend",
    "dataset.aiSuggestions": "AI suggestions",
    "dataset.aiGuardrails": "AI guardrail events",
    "dataset.aiEvals": "AI evaluations",
    "dataset.conversations": "Conversations",
    "dataset.campaigns": "Campaigns",
    "dataset.spend": "Campaign spend",
    "dataset.signals": "Market signals",
    "dataset.whitespaces": "Whitespaces",
    "dataset.clusters": "Signal clusters",
    "dataset.experiments": "Experiments",
    "dataset.dataProducts": "Data products",
    "dataset.boardpacks": "Board packs",
    "dataset.decisions": "Decisions"
  },
  ar: {
    title: "منشئ التقارير",
    intro: "اختر ما تريد عدّه وكيف تقسّمه، واطّلع على الأرقام، ثم احتفظ بما يستحق.",
    build: "البناء",
    dataset: "مجموعة البيانات",
    metrics: "المقاييس",
    dimensions: "التقسيم حسب",
    grain: "الفترة الزمنية",
    none: "بدون تجميع",
    day: "يوم",
    week: "أسبوع",
    month: "شهر",
    quarter: "ربع سنة",
    year: "سنة",
    from: "من",
    to: "إلى",
    filterField: "الحقل",
    filterOp: "الشرط",
    filterValue: "القيمة",
    anyField: "بدون تصفية",
    "op.eq": "يساوي",
    "op.neq": "لا يساوي",
    "op.in": "أحد القيم (مفصولة بفواصل)",
    "op.gt": "أكبر من",
    "op.gte": "لا يقل عن",
    "op.lt": "أصغر من",
    "op.lte": "لا يزيد عن",
    "op.contains": "يحتوي على",
    "op.is_null": "فارغ",
    "op.not_null": "غير فارغ",
    sort: "الترتيب حسب",
    defaultSort: "ترتيب المحرك",
    period: "الفترة",
    dir: "الاتجاه",
    desc: "الأكبر أولًا",
    asc: "الأصغر أولًا",
    limit: "حد الصفوف",
    preview: "معاينة",
    pickMetric: "اختر مقياسًا واحدًا على الأقل للمعاينة.",
    notRun: "لم يُشغَّل شيء بعد. عاين لترى الأرقام — البناء المشترك أو المقترح لا يُشغَّل نيابةً عنك.",
    results: "المعاينة",
    totals: "الإجماليات",
    truncated: "تم القطع عند حد الصفوف — ضيّق النطاق أو ارفع الحد.",
    unavailable: "يشير هذا الرابط إلى مجموعة بيانات لا يمكنك إعداد تقارير عنها، فتم فتح المنشئ على مجموعة متاحة لك.",
    shareLink: "رابط هذا البناء",
    save: "حفظ كتقرير",
    reportName: "اسم التقرير",
    scope: "من يراه",
    tenant: "كل من يحق له قراءة البيانات",
    personal: "أنا فقط",
    cadence: "التسليم",
    once: "بدون جدولة",
    daily: "كل يوم الساعة 06:00",
    weekly: "كل اثنين الساعة 06:00",
    monthly: "في اليوم الأول الساعة 06:00",
    format: "الملف",
    recipients: "المستلمون (عناوين بريد مفصولة بفواصل)",
    saved: "تم الحفظ.",
    scheduled: "تمت الجدولة.",
    openReport: "فتح التقرير",
    noRun: "يمكنك قراءة التقارير لكن ليس إنشاءها.",
    ask: "اسأل بالكلمات",
    askPlaceholder: "مثال: إنفاق الذكاء الاصطناعي حسب الغرض خلال آخر 30 يومًا",
    askButton: "تحويل",
    askLoad: "تحميل في المنشئ",
    "ask.outside": "البيانات التي يمكنك إعداد تقارير عنها لا تغطي هذا السؤال. لم يُخمَّن شيء.",
    "ask.unclear": "لم يتحول السؤال إلى تقرير. جرّب تسمية ما تريد عدّه وكيف تقسّمه.",
    by: "حسب",
    since: "منذ",
    until: "حتى",
    xlsx: "إكسل (.xlsx)",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    "dataset.policies": "التغطيات السارية",
    "dataset.quotes": "طلبات عروض الأسعار",
    "dataset.quoteResponses": "ردود عروض الأسعار",
    "dataset.commissions": "قيود العمولات",
    "dataset.cases": "بنود العمل",
    "dataset.transactions": "معاملات الدفتر",
    "dataset.aiRuns": "تشغيلات الذكاء الاصطناعي",
    "dataset.aiSpend": "استدعاءات الذكاء الاصطناعي وإنفاقه",
    "dataset.aiSuggestions": "اقتراحات الذكاء الاصطناعي",
    "dataset.aiGuardrails": "أحداث ضوابط الذكاء الاصطناعي",
    "dataset.aiEvals": "تقييمات الذكاء الاصطناعي",
    "dataset.conversations": "المحادثات",
    "dataset.campaigns": "الحملات",
    "dataset.spend": "إنفاق الحملات",
    "dataset.signals": "إشارات السوق",
    "dataset.whitespaces": "الفرص غير المخدومة",
    "dataset.clusters": "مجموعات الإشارات",
    "dataset.experiments": "التجارب",
    "dataset.dataProducts": "منتجات البيانات",
    "dataset.boardpacks": "حزم مجلس الإدارة",
    "dataset.decisions": "القرارات"
  }
};

const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ pure */

export type Chart =
  | { kind: "line"; metric: string; values: number[]; xLabels: string[] }
  | { kind: "donut"; metric: string; slices: { name: string; value: number }[] };

/**
 * The one picture a run earns, or none. A grain alone draws the first measure
 * over time; one split and no grain draws its shares. Anything else — a grand
 * total, a period beside a split, two splits — would draw a shape that means
 * nothing, so the table stands alone.
 */
export function chartFor(run: RunResult): Chart | null {
  const text = run.columns.filter((c) => c.kind === "text" || c.kind === "date");
  const figure = run.columns.find((c) => c.kind === "number" || c.kind === "money");
  if (!figure || text.length !== 1) return null;
  const axis = text[0]!;
  const values = run.rows.map((row) => Number(row[figure.key]) || 0);
  if (axis.key === "period") {
    return { kind: "line", metric: figure.key, values, xLabels: run.rows.map((row) => String(row.period ?? "")) };
  }
  if (values.some((v) => v < 0)) return null;
  return {
    kind: "donut",
    metric: figure.key,
    slices: run.rows.map((row, i) => ({ name: String(row[axis.key] ?? "—"), value: values[i]! }))
  };
}

/** A key `ReportBody.key` accepts (`^[a-z0-9_.-]+$`), unique per save. */
export function reportKey(name: string, now: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "report"}-${now.toString(36)}`;
}

/** POST /v1/analytics/schedules for the save form, or null when none was asked for. */
export function scheduleBody(form: FormData, reportId: string, name: Record<string, string>, locale: string) {
  const cron = CADENCES[String(form.get("cadence") ?? "")];
  if (!cron) return null;
  const recipients = String(form.get("recipients") ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const format = String(form.get("format") ?? "pdf");
  return {
    reportId,
    name,
    cron,
    format: FORMATS.some((f) => f === format) ? format : "pdf",
    recipients,
    locale: locale === "ar" ? "ar" : "en"
  };
}

/**
 * A definition read back as short phrases — what the ask bar shows under its ✦
 * so the reader checks the compilation before loading it (docs/15 §4.6: "the
 * compilation shown, so trust builds").
 */
export function describeDef(
  def: ReportDefinition,
  l: (key: string) => string,
  names: { metric: (key: string) => string; dimension: (key: string) => string }
): string[] {
  const parts = [l(`dataset.${def.dataset}`), def.metrics.map(names.metric).join(", ")];
  if (def.dimensions?.length) parts.push(`${l("by")} ${def.dimensions.map(names.dimension).join(", ")}`);
  if (def.grain && def.grain !== "none") parts.push(l(def.grain));
  if (def.from !== undefined) parts.push(`${l("since")} ${dayOf(def.from)}`);
  if (def.to !== undefined) parts.push(`${l("until")} ${dayOf(def.to)}`);
  for (const f of def.filters ?? []) {
    const value = f.value === undefined ? "" : ` ${Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}`;
    parts.push(`${names.dimension(f.field)} ${l(`op.${f.op}`)}${value}`);
  }
  if (def.sort) {
    const field = def.sort.field === "period" ? l("period") : names.metric(def.sort.field);
    parts.push(`${l("sort")} ${field}, ${l(def.sort.dir)}`);
  }
  if (def.limit !== undefined) parts.push(`${l("limit")} ${def.limit}`);
  return parts;
}

/** Reason codes, packages/model-gateway/src/analytics-ask.ts `AskRefusal`. */
const OUTSIDE = new Set(["refused", "unknown_dataset", "unknown_metric", "unknown_dimension"]);

/**
 * A refused ask, as the screen words it: "outside" what the reader's data
 * covers, or "unclear" as a question. The model's own prose never reaches the
 * page — it is one language and unverified. Any other problem is not a
 * refusal and stays a Problem.
 */
export function askProblem(problem: { status: number; code?: string; reason?: unknown; title: string }): "outside" | "unclear" | null {
  if (problem.status !== 422 || problem.code !== "ask_refused") return null;
  return OUTSIDE.has(String(problem.reason)) ? "outside" : "unclear";
}

/** Everything but a signed-out reader's 401 is information for this screen. */
function refusalOf(error: unknown): Refusal {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) {
    return {
      title: error.problem.title,
      status: error.status,
      ...(error.problem.detail ? { detail: error.problem.detail } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {})
    };
  }
  throw error;
}

/* ---------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = { run: held.has(PERM.run), write: held.has(PERM.write), schedule: held.has(PERM.schedule) };
  const email = me.profile?.email ?? "";
  const empty = { may, email, datasets: [] as DatasetInfo[], def: null, run: null, problem: null, unavailable: false, resolved: {} as Names };
  if (!may.run) return empty;

  const { data: datasets } = await api<{ data: DatasetInfo[] }>("/v1/analytics/datasets", { env, request });
  const find = (key: string) => datasets.find((d) => d.key === key);

  let def: ReportDefinition | null;
  if (url.searchParams.has("dataset")) {
    // The builder form, submitted. A complete build moves to its canonical
    // link, so what the address bar shows is always the thing to share.
    const posted = defFromParams(url.searchParams);
    const ds = posted ? find(posted.dataset) : undefined;
    def = posted && ds ? fitToDataset(posted, ds) : posted;
    if (def && ds && def.metrics.length) {
      throw redirect(builderHref(def, { run: url.searchParams.get("run") === "1" }));
    }
  } else {
    def = decodeDef(url.searchParams.get("def"));
  }

  const ds = def ? find(def.dataset) : undefined;
  const unavailable = Boolean(def && !ds);
  const first = datasets[0];
  if (!ds) def = first ? { dataset: first.key, metrics: [] } : null;
  else def = fitToDataset(def!, ds);

  let run: RunResult | null = null;
  let problem: Refusal | null = null;
  if (def && def.metrics.length && url.searchParams.get("run") === "1") {
    try {
      run = await api<RunResult>("/v1/analytics/run", {
        env,
        request,
        method: "POST",
        body: { ...def, totals: true }
      });
    } catch (error) {
      problem = refusalOf(error);
    }
  }
  // docs/30 Analytics 4: a split by channel or owner reads as names, not ids.
  const resolved = run ? await names(refsIn(run.rows), { env, request }) : {};
  return { may, email, datasets, def, run, problem, unavailable, resolved };
}

/* ---------------------------------------------------------------- action */

/** What the ask bar received: a compiled definition and its why. */
export interface Asked {
  definition: ReportDefinition;
  why: string;
  auditId: string;
}

export interface ActionResult {
  intent: "save" | "ask" | null;
  problem: Refusal | null;
  saved: { id: string } | null;
  scheduled: boolean;
  asked: Asked | null;
  refused: "outside" | "unclear" | null;
}

const NONE: ActionResult = { intent: null, problem: null, saved: null, scheduled: false, asked: null, refused: null };

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const locale = String(form.get("locale") ?? "en");

  if (intent === "ask") {
    const question = String(form.get("question") ?? "").trim();
    const asking = { ...NONE, intent: "ask" as const };
    if (question.length < 3) return { ...asking, refused: "unclear" };
    try {
      const asked = await api<Asked>("/v1/analytics/ask", { env, request, method: "POST", body: { question } });
      return { ...asking, asked };
    } catch (error) {
      if (error instanceof ApiError) {
        const refused = askProblem(error.problem as Parameters<typeof askProblem>[0]);
        if (refused) return { ...asking, refused };
      }
      return { ...asking, problem: refusalOf(error) };
    }
  }

  if (intent === "save") {
    const saving = { ...NONE, intent: "save" as const };
    const def = decodeDef(String(form.get("def") ?? ""));
    const title = String(form.get("name") ?? "").trim();
    if (!def || !title) return { ...saving, problem: { title: "name_required", status: 400 } };
    const name = { [locale === "ar" ? "ar" : "en"]: title };
    let saved: { id: string };
    try {
      saved = await api<{ id: string }>("/v1/analytics/reports", {
        env,
        request,
        method: "POST",
        body: {
          key: reportKey(title, Date.now()),
          module: "analytics",
          name,
          definition: def,
          scope: String(form.get("scope") ?? "") === "personal" ? "personal" : "tenant"
        }
      });
    } catch (error) {
      return { ...saving, problem: refusalOf(error) };
    }
    const schedule = scheduleBody(form, saved.id, name, locale);
    if (schedule) {
      try {
        await api("/v1/analytics/schedules", { env, request, method: "POST", body: schedule });
      } catch (error) {
        // The report exists; say the schedule did not, and keep the link.
        return { ...saving, saved, problem: refusalOf(error) };
      }
    }
    return { ...saving, saved, scheduled: Boolean(schedule) };
  }
  return { ...NONE, problem: { title: "unknown intent", status: 400 } };
}

/* ---------------------------------------------------------------- screen */

export default function AnalyticsBuilder() {
  const loaded = useLoaderData<typeof loader>();
  const acted = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);

  if (!loaded.may.run || !loaded.def) {
    return <EmptyState title={l("title")} body={loaded.may.run ? t("common.empty.title") : l("noRun")} />;
  }
  const def = loaded.def;
  const ds = loaded.datasets.find((d) => d.key === def.dataset);
  const run = loaded.run;
  const busy = navigation.state !== "idle";

  /** The registry's English label, unless this screen or the pack says it better. */
  const named = (key: string, fallback: string) => {
    const said = l(key);
    return said === key ? fallback : said;
  };
  const datasetName = (key: string) => named(`dataset.${key}`, key);
  const metricName = (key: string) => named(key, ds?.metrics.find((m) => m.key === key)?.label ?? key);
  const dimensionName = (key: string) => named(key, ds?.dimensions.find((d) => d.key === key)?.label ?? key);

  const token = def.metrics.length ? encodeDef(def) : null;
  const chart = run ? chartFor(run) : null;
  const rows: Row[] = (run?.rows ?? []).map((row, i) => ({ ...row, __currency: run?.currency ?? "", __key: String(i) }));
  const metricOrDim = (key: string, label: string) => (key === "period" ? l("period") : named(key, label));
  const columns: Array<Column<Row>> = (run?.columns ?? []).map((column) => ({
    key: column.key,
    header: metricOrDim(column.key, column.label),
    numeric: column.kind === "money" || column.kind === "number",
    render: (row: Row) => (
      <Cell column={{ name: column.key, type: column.kind, currencyFrom: "__currency" }} row={row} locale={locale} label={l} resolved={loaded.resolved} />
    )
  }));
  const totalsRow: Row = { ...(run?.totals ?? {}), __currency: run?.currency ?? "" };
  const figureLabel = chart ? metricName(chart.metric) : "";

  const filterRows = [...(def.filters ?? [])];
  while (filterRows.length < FILTER_ROWS) filterRows.push({ field: "", op: "eq" });

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{l("title")}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
        </div>
        {token ? (
          <Link to={builderHref(def, { run: true })} className="font-ui text-13 text-accent underline-offset-2 hover:underline">
            {l("shareLink")}
          </Link>
        ) : null}
      </header>

      {loaded.unavailable ? (
        <p role="status" className="font-ui text-13 text-muted">
          {l("unavailable")}
        </p>
      ) : null}
      <AskBar locale={locale} datasets={loaded.datasets} l={l} named={named} acted={acted ?? null} busy={busy} />

      {loaded.problem ? <Problem problem={loaded.problem} /> : null}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {/* Data first (ui.md §4.1): the preview holds the fold, the form sits beside it. */}
        <section aria-label={l("results")} className="flex min-w-0 flex-col gap-4">
          {run ? (
            <>
              {chart?.kind === "line" ? (
                <LineChart values={chart.values} xLabels={chart.xLabels} label={figureLabel} className="rounded-md border border-border p-3" />
              ) : chart?.kind === "donut" ? (
                <DonutChart slices={chart.slices} label={figureLabel} className="rounded-md border border-border p-3" />
              ) : null}
              <Table
                columns={columns}
                rows={rows}
                rowKey={(row) => String(row.__key)}
                caption={`${datasetName(def.dataset)} — ${l("results")}`}
                density="compact"
                stickyHeader
                empty={<EmptyState title={t("common.empty.title")} body={t("common.empty.filtered")} />}
                footer={
                  <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
                    <span className="font-ui text-12 tabular-nums text-subtle">
                      {t("common.rows", { count: String(run.rowCount) })}
                      {run.truncated ? ` · ${l("truncated")}` : ""}
                    </span>
                    {run.totals ? (
                      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
                        <dt className="font-ui text-12 text-subtle">{l("totals")}</dt>
                        {run.columns
                          .filter((c) => run.totals && c.key in run.totals)
                          .map((c) => (
                            <dd key={c.key} className="font-ui text-13 tabular-nums text-text">
                              <span className="me-2 text-subtle">{metricOrDim(c.key, c.label)}</span>
                              <Cell column={{ name: c.key, type: c.kind, currencyFrom: "__currency" }} row={totalsRow} locale={locale} label={l} />
                            </dd>
                          ))}
                      </dl>
                    ) : null}
                  </div>
                }
              />
            </>
          ) : (
            <EmptyState title={l("results")} body={def.metrics.length ? l("notRun") : l("pickMetric")} />
          )}

          {token && loaded.may.write ? (
            <SaveForm token={token} locale={locale} email={loaded.email} may={loaded.may} l={l} busy={busy} acted={acted ?? null} />
          ) : null}
        </section>

        <Form method="get" className="flex flex-col gap-4 rounded-md border border-border p-4 xl:sticky xl:top-4" aria-label={l("build")}>
          <Field label={l("dataset")}>
            <Select
              name="dataset"
              defaultValue={def.dataset}
              options={loaded.datasets.map((d) => ({ value: d.key, label: datasetName(d.key) }))}
              // A dataset switch changes every other choice on the form, so it
              // reloads onto the new dataset rather than posting stale keys.
              onValueChange={(value) => navigate(`/analytics/builder?dataset=${encodeURIComponent(value)}`)}
            />
          </Field>

          {ds ? (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="eyebrow mb-1">{l("metrics")}</legend>
                {ds.metrics.map((m) => (
                  <Checkbox key={m.key} name="metric" value={m.key} label={metricName(m.key)} defaultChecked={def.metrics.includes(m.key)} />
                ))}
              </fieldset>

              {ds.dimensions.length ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="eyebrow mb-1">{l("dimensions")}</legend>
                  {ds.dimensions.map((d) => (
                    <Checkbox
                      key={d.key}
                      name="dimension"
                      value={d.key}
                      label={dimensionName(d.key)}
                      defaultChecked={(def.dimensions ?? []).includes(d.key)}
                    />
                  ))}
                </fieldset>
              ) : null}

              <Field label={l("grain")}>
                <Select name="grain" defaultValue={def.grain ?? "none"} options={GRAINS.map((g) => ({ value: g, label: l(g) }))} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label={l("from")}>
                  <Input type="date" name="from" defaultValue={dayOf(def.from)} />
                </Field>
                <Field label={l("to")}>
                  <Input type="date" name="to" defaultValue={dayOf(def.to)} />
                </Field>
              </div>

              {ds.dimensions.length ? (
                <fieldset className="flex flex-col gap-3">
                  <legend className="eyebrow mb-1">{l("filters")}</legend>
                  {filterRows.map((f, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr] gap-2">
                      <Field label={l("filterField")} labelHidden>
                        <Select
                          name={`f${i}.field`}
                          defaultValue={f.field}
                          placeholder={l("anyField")}
                          options={[{ value: "", label: l("anyField") }, ...ds.dimensions.map((d) => ({ value: d.key, label: dimensionName(d.key) }))]}
                        />
                      </Field>
                      <Field label={l("filterOp")} labelHidden>
                        <Select name={`f${i}.op`} defaultValue={f.op} options={FILTER_OPS.map((op) => ({ value: op, label: l(`op.${op}`) }))} />
                      </Field>
                      <Field label={l("filterValue")} labelHidden className="col-span-2">
                        <Input
                          name={`f${i}.value`}
                          defaultValue={f.value === undefined || VALUELESS.has(f.op) ? "" : Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}
                        />
                      </Field>
                    </div>
                  ))}
                </fieldset>
              ) : null}

              <div className="grid grid-cols-2 gap-3">
                <Field label={l("sort")}>
                  <Select
                    name="sort"
                    defaultValue={def.sort?.field ?? ""}
                    placeholder={l("defaultSort")}
                    options={[
                      { value: "", label: l("defaultSort") },
                      ...(def.grain ? [{ value: "period", label: l("period") }] : []),
                      ...ds.metrics.map((m) => ({ value: m.key, label: metricName(m.key) })),
                      ...ds.dimensions.map((d) => ({ value: d.key, label: dimensionName(d.key) }))
                    ]}
                  />
                </Field>
                <Field label={l("dir")}>
                  <Select
                    name="dir"
                    defaultValue={def.sort?.dir ?? "desc"}
                    options={[
                      { value: "desc", label: l("desc") },
                      { value: "asc", label: l("asc") }
                    ]}
                  />
                </Field>
              </div>
              <Field label={l("limit")}>
                <Select name="limit" defaultValue={String(def.limit ?? 100)} options={LIMITS.map((n) => ({ value: n, label: n }))} />
              </Field>
            </>
          ) : null}

          <Button type="submit" name="run" value="1" loading={busy && navigation.formMethod === "GET"}>
            {l("preview")}
          </Button>
        </Form>
      </div>
    </div>
  );
}

function SaveForm({
  token,
  locale,
  email,
  may,
  l,
  busy,
  acted
}: {
  token: string;
  locale: string;
  email: string;
  may: { schedule: boolean };
  l: (key: string) => string;
  busy: boolean;
  acted: ActionResult | null;
}) {
  const [cadence, setCadence] = React.useState("");
  const result = acted?.intent === "save" ? acted : null;
  return (
    <Form method="post" className="flex flex-col gap-3 rounded-md border border-border p-4">
      <h2 className="eyebrow">{l("save")}</h2>
      <input type="hidden" name="intent" value="save" />
      <input type="hidden" name="def" value={token} />
      <input type="hidden" name="locale" value={locale} />
      {result?.problem ? <Problem problem={result.problem} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-text">
          {l("saved")} {result.scheduled ? l("scheduled") : ""}{" "}
          <Link to={`/analytics/report/${result.saved.id}`} className="text-accent underline-offset-2 hover:underline">
            {l("openReport")}
          </Link>
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={l("reportName")} required>
          <Input name="name" required maxLength={120} />
        </Field>
        <Field label={l("scope")}>
          <Select
            name="scope"
            defaultValue="tenant"
            options={[
              { value: "tenant", label: l("tenant") },
              { value: "personal", label: l("personal") }
            ]}
          />
        </Field>
      </div>
      {may.schedule ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={l("cadence")}>
            <Select
              name="cadence"
              defaultValue=""
              onValueChange={setCadence}
              options={[
                { value: "", label: l("once") },
                ...Object.keys(CADENCES).map((c) => ({ value: c, label: l(c) }))
              ]}
            />
          </Field>
          {cadence ? (
            <>
              <Field label={l("format")}>
                <Select name="format" defaultValue="pdf" options={FORMATS.map((f) => ({ value: f, label: l(f) }))} />
              </Field>
              <Field label={l("recipients")}>
                <Input name="recipients" defaultValue={email} required />
              </Field>
            </>
          ) : null}
        </div>
      ) : null}
      <div>
        <Button type="submit" variant="secondary" loading={busy}>
          {l("save")}
        </Button>
      </div>
    </Form>
  );
}

/**
 * Ask in words (docs/05, ADR-0088). docs/15 §4.6 "semantic everything": the
 * question is compiled to a visible, editable definition — shown here as quiet
 * ghost text under the one ✦, its why a hover away — and loaded into the
 * builder only when the reader chooses to. Loading does not run it; the reader
 * presses Preview. Never a modal, never an auto-run.
 */
function AskBar({
  locale,
  datasets,
  l,
  named,
  acted,
  busy
}: {
  locale: string;
  datasets: DatasetInfo[];
  l: (key: string) => string;
  named: (key: string, fallback: string) => string;
  acted: ActionResult | null;
  busy: boolean;
}) {
  const result = acted?.intent === "ask" ? acted : null;
  const asked = result?.asked ?? null;
  const ds = asked ? datasets.find((d) => d.key === asked.definition.dataset) : undefined;
  const phrases = asked
    ? describeDef(asked.definition, (key) => (key.startsWith("dataset.") ? named(key, key.slice(8)) : l(key)), {
        metric: (key) => named(key, ds?.metrics.find((m) => m.key === key)?.label ?? key),
        dimension: (key) => named(key, ds?.dimensions.find((d) => d.key === key)?.label ?? key)
      })
    : [];
  return (
    <section aria-label={l("ask")} className="flex flex-col gap-2">
      <Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="ask" />
        <input type="hidden" name="locale" value={locale} />
        <Field label={l("ask")} className="min-w-0 flex-1">
          <Input name="question" required minLength={3} maxLength={500} placeholder={l("askPlaceholder")} />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {l("askButton")}
        </Button>
      </Form>
      {result?.problem ? <Problem problem={result.problem} /> : null}
      {result?.refused ? (
        <p role="status" className="font-ui text-13 text-muted">
          {l(`ask.${result.refused}`)}
        </p>
      ) : null}
      {asked ? (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-dashed border-border p-3">
          <AgentBadge why={<p className="max-w-prose font-ui text-13">{asked.why}</p>} />
          <span className="min-w-0 flex-1 font-ui text-13 text-subtle">{phrases.join(" · ")}</span>
          <Link to={builderHref(asked.definition)} className="font-ui text-13 text-accent underline-offset-2 hover:underline">
            {l("askLoad")}
          </Link>
        </div>
      ) : null}
    </section>
  );
}

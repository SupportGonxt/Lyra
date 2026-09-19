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
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  KPIWall,
  Select,
  Stat,
  Table
} from "@lyra/ui";
import { api, asRouteError, fetchMe, type Problem as ProblemShape } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { ORBIT, labelsFrom, refusal, safe, type Label, type Labels, type Page } from "./orbit-shared";
import { localeFrom, pseudoText } from "../i18n";

// Customer analytics for ORBIT. Two different machines feed this screen and it
// says which is which:
//
//   * the counts at the top are read straight off the list endpoints with
//     `count=true&limit=1`, because the registered `conversations` dataset
//     (apps/api/src/engines/report.ts DATASETS) carries exactly one metric — a
//     row count — and no CSAT, handover or renewal metric at all;
//   * the breakdown and the export go through the platform's report engine
//     (POST /v1/analytics/run, POST /v1/analytics/exports), so the xlsx/PDF
//     rendering and the PII masking are the ones the rest of the platform uses.
//
// Containment is therefore an approximation and is labelled as one on screen.

/** apps/api/src/routes/analytics.ts ExportBody.format. */
const FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/** apps/api/src/engines/report.ts DATASETS.conversations. */
const DATASET = "conversations";
const DIMENSIONS = ["channel", "state", "assigneeRef"] as const;
const GRAINS = ["none", "day", "week", "month"] as const;
const WINDOWS = [7, 30, 90] as const;

export type Dimension = (typeof DIMENSIONS)[number];
export type Grain = (typeof GRAINS)[number];

export interface RunTable {
  runId: string;
  title: string;
  columns: Array<{ key: string; label: string; kind: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  generatedAt: number;
}

interface ExportRow {
  id: string;
  format: string;
  state: string;
  rowCount: number | null;
  error: string | null;
}

interface Closed {
  id: string;
  csat: number | null;
  sentiment: number | null;
  closedAt: number | null;
}

interface Scored {
  score: number;
}

/* ------------------------------------------------------------------ numbers */

export function windowDays(raw: string | null): number {
  const days = Number(raw);
  return WINDOWS.some((allowed) => allowed === days) ? days : 30;
}

/** Share of conversations the agent finished without pulling a human in. */
export function containment(conversations: number, handovers: number): number | null {
  if (conversations <= 0) return null;
  return Math.max(0, 1 - handovers / conversations);
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

export function meanOf(values: Array<number | null | undefined>): number | null {
  const real = values.filter((value): value is number => typeof value === "number");
  if (real.length === 0) return null;
  return real.reduce((total, value) => total + value, 0) / real.length;
}

/** The one number worth leading with: containment for the selected window, or a no-data note. */
export function analyticsHeadline(containmentRatio: number | null, days: number, l: Label): string {
  if (containmentRatio === null) return l("headlineNoData", { n: String(days) });
  return l("headlineContainment", { n: String(Math.round(containmentRatio * 100)), days: String(days) });
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Customer analytics",
    lede: "How much the agent handled alone, how often a human took over, how customers felt, and how many stayed.",
    headlineContainment: "{n}% contained without a human, last {days} days",
    headlineNoData: "No conversations in the last {n} days",
    window: "Window",
    days: "Last {n} days",
    containment: "Containment",
    containmentHint: "Conversations the agent closed alone",
    handover: "Handover rate",
    handoverHint: "Conversations a human took over",
    csat: "CSAT",
    csatHint: "Average of the last 100 closed conversations",
    retention: "Retention",
    retentionHint: "Renewals accepted out of those decided",
    quality: "Quality score",
    conversations: "Conversations",
    handovers: "Handovers",
    accepted: "Renewals saved",
    lost: "Renewals lost",
    approxLabel: "How this is worked out",
    approxBody:
      "There is no containment metric in the reporting engine, so this is one minus handover notes over conversations in the window. A conversation handed over twice counts twice, which pushes containment down rather than up.",
    csatWhy: "How CSAT is sampled",
    csatWhyBody:
      "CSAT is averaged over the most recent 100 closed conversations that recorded a score, not over the whole window. Conversations without a score are left out entirely.",
    breakdown: "Breakdown",
    breakdownBody: "Runs the reporting engine over the conversations dataset. Group by a dimension, a period, or both.",
    dimension: "Group by",
    grain: "Period",
    run: "Run",
    running: "Running",
    none: "No period",
    day: "Day",
    week: "Week",
    month: "Month",
    channel: "Channel",
    state: "State",
    assigneeRef: "Assignee",
    period: "Period",
    rows: "{n} rows",
    truncated: "Truncated at the row ceiling.",
    generated: "Run at",
    noRun: "Nothing run yet",
    noRunBody: "Pick a grouping and run it. Grouping by month is the cohort view.",
    exportTitle: "Export",
    exportBody: "The platform export pipeline renders the same definition to a spreadsheet or a PDF.",
    format: "Format",
    export: "Export",
    xlsx: "Excel",
    pdf: "PDF",
    csv: "CSV",
    json: "JSON",
    exportReady: "Export ready.",
    exportQueued: "Export queued.",
    openConsole: "Live console",
    openSave: "Save desk",
    openQuality: "Conversation quality",
    noData: "No data",
    unknownIntent: "That control is not available.",
    badDimension: "Pick a grouping the dataset knows.",
    badGrain: "Pick a period the dataset knows.",
    badFormat: "Pick an export format.",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "تحليلات العملاء",
    lede: "ما أنجزه الوكيل وحده، وعدد مرات تدخّل موظف، ومشاعر العملاء، وعدد من بقي منهم.",
    headlineContainment: "احتواء {n}٪ دون تدخل بشري، آخر {days} يوم",
    headlineNoData: "لا محادثات خلال آخر {n} يوم",
    window: "المدة",
    days: "آخر {n} يومًا",
    containment: "الاكتفاء الذاتي",
    containmentHint: "محادثات أغلقها الوكيل وحده",
    handover: "نسبة التحويل",
    handoverHint: "محادثات تولّاها موظف",
    csat: "رضا العملاء",
    csatHint: "معدل آخر ١٠٠ محادثة مغلقة",
    retention: "الاستبقاء",
    retentionHint: "التجديدات المقبولة من بين المحسومة",
    quality: "درجة الجودة",
    conversations: "المحادثات",
    handovers: "التحويلات",
    accepted: "تجديدات محفوظة",
    lost: "تجديدات مفقودة",
    approxLabel: "كيف حُسب هذا",
    approxBody:
      "لا يوجد مقياس للاكتفاء الذاتي في محرك التقارير، لذا هذا واحد ناقص عدد مذكرات التحويل على عدد المحادثات في المدة. المحادثة المحوّلة مرتين تُحسب مرتين، فتخفض النسبة ولا ترفعها.",
    csatWhy: "كيف تُؤخذ عيّنة الرضا",
    csatWhyBody:
      "يُحسب المعدل على آخر ١٠٠ محادثة مغلقة سجّلت درجة رضا، لا على المدة كاملة. المحادثات بلا درجة تُستثنى.",
    breakdown: "التفصيل",
    breakdownBody: "يشغّل محرك التقارير على بيانات المحادثات. جمّع بحسب بُعد أو فترة أو كليهما.",
    dimension: "التجميع بحسب",
    grain: "الفترة",
    run: "شغّل",
    running: "جارٍ التشغيل",
    none: "بلا فترة",
    day: "يوم",
    week: "أسبوع",
    month: "شهر",
    channel: "القناة",
    state: "الحالة",
    assigneeRef: "المسؤول",
    period: "الفترة",
    rows: "{n} صفًا",
    truncated: "تم القطع عند سقف الصفوف.",
    generated: "وقت التشغيل",
    noRun: "لم يُشغَّل شيء بعد",
    noRunBody: "اختر تجميعًا وشغّله. التجميع بحسب الشهر هو عرض الأفواج.",
    exportTitle: "التصدير",
    exportBody: "خط التصدير في المنصة يحوّل التعريف نفسه إلى جدول أو ملف PDF.",
    format: "الصيغة",
    export: "صدّر",
    xlsx: "إكسل",
    pdf: "بي دي إف",
    csv: "سي إس في",
    json: "جيسون",
    exportReady: "التصدير جاهز.",
    exportQueued: "التصدير في الانتظار.",
    openConsole: "لوحة المحادثات الحية",
    openSave: "مكتب الاستبقاء",
    openQuality: "جودة المحادثات",
    noData: "لا بيانات",
    unknownIntent: "هذا الإجراء غير متاح.",
    badDimension: "اختر تجميعًا يعرفه المصدر.",
    badGrain: "اختر فترة يعرفها المصدر.",
    badFormat: "اختر صيغة التصدير.",
    approvalLink: "افتح الموافقات"
  }
};

export function labelsIn(locale: string): Label {
  return labelsFrom(LABELS, locale);
}

/** Our own name for a report column, falling back to the engine's English one. */
export function headerFor(key: string, engineLabel: string, locale: string): string {
  return pseudoText(locale, LABELS[locale]?.[key] ?? LABELS.en?.[key] ?? engineLabel);
}

/* ------------------------------------------------------------------ loader */

const none = <T,>(): Page<T> => ({ data: [], total: 0 });

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const days = windowDays(new URL(request.url).searchParams.get("days"));
  const from = Date.now() - days * 86_400_000;
  const head = "limit=1&count=true";

  // Every figure is a count over a window; `from` applies to the sort column, so
  // each one sorts by the timestamp it wants to measure.
  const [conversations, handovers, closed, accepted, lost, scores] = await Promise.all([
    held.has(ORBIT.conversations)
      ? safe(() => api<Page<never>>(`/v1/orbit/conversations?sort=createdAt&from=${from}&${head}`, opts), none())
      : Promise.resolve(none()),
    held.has(ORBIT.handovers)
      ? safe(() => api<Page<never>>(`/v1/orbit/handover-notes?sort=ts&from=${from}&${head}`, opts), none())
      : Promise.resolve(none()),
    held.has(ORBIT.conversations)
      ? safe(
          () =>
            api<Page<Closed>>("/v1/orbit/conversations?state=closed&sort=closedAt&order=desc&limit=100", opts),
          none<Closed>()
        )
      : Promise.resolve(none<Closed>()),
    held.has(ORBIT.renewals)
      ? safe(
          () => api<Page<never>>(`/v1/orbit/renewals?state=accepted&sort=decidedAt&from=${from}&${head}`, opts),
          none()
        )
      : Promise.resolve(none()),
    held.has(ORBIT.renewals)
      ? safe(() => api<Page<never>>(`/v1/orbit/renewals?state=lost&sort=decidedAt&from=${from}&${head}`, opts), none())
      : Promise.resolve(none()),
    held.has(ORBIT.qa)
      ? safe(() => api<Page<Scored>>(`/v1/orbit/qa-scores?sort=ts&order=desc&from=${from}&limit=100`, opts), none<Scored>())
      : Promise.resolve(none<Scored>())
  ]);

  const total = conversations.total ?? 0;
  const handed = handovers.total ?? 0;
  const won = accepted.total ?? 0;
  const gone = lost.total ?? 0;

  return {
    locale: localeFrom(request),
    apiOrigin: env.API_ORIGIN,
    days,
    from,
    may: { run: held.has(ORBIT.reportRun), export: held.has(ORBIT.exportCreate) },
    conversations: total,
    handovers: handed,
    accepted: won,
    lost: gone,
    containment: containment(total, handed),
    handoverRate: ratio(handed, total),
    retention: ratio(won, won + gone),
    csat: meanOf(closed.data.map((row) => row.csat)),
    // The conversation-signal engine (orbit-signal.ts) writes this per inbound
    // message; averaged here so the trend is visible without opening a thread.
    sentiment: meanOf(closed.data.map((row) => row.sentiment)),
    quality: meanOf(scores.data.map((row) => row.score))
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  error: string | null;
  table: RunTable | null;
  exported: ExportRow | null;
}

const nothing: ActionResult = { problem: null, error: null, table: null, exported: null };

/** The definition both the run and the export share, so they cannot drift. */
export function definitionOf(input: { dimension: Dimension; grain: Grain; from: number; to: number }) {
  return {
    dataset: DATASET,
    metrics: ["conversations"],
    dimensions: [input.dimension],
    ...(input.grain === "none" ? {} : { grain: input.grain }),
    from: input.from,
    to: input.to,
    sort: { field: "conversations", dir: "desc" as const },
    limit: 200
  };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "run" && intent !== "export") return { ...nothing, error: "unknownIntent" };

  const dimension = String(form.get("dimension") ?? "") as Dimension;
  const grain = String(form.get("grain") ?? "none") as Grain;
  if (!DIMENSIONS.includes(dimension)) return { ...nothing, error: "badDimension" };
  if (!GRAINS.includes(grain)) return { ...nothing, error: "badGrain" };

  const days = windowDays(String(form.get("days") ?? ""));
  const to = Date.now();
  const definition = definitionOf({ dimension, grain, from: to - days * 86_400_000, to });

  try {
    if (intent === "run") {
      const table = await api<RunTable>("/v1/analytics/run", { env, request, method: "POST", body: definition });
      return { ...nothing, table };
    }
    const format = String(form.get("format") ?? "");
    if (!FORMATS.some((allowed) => allowed === format)) return { ...nothing, error: "badFormat" };
    const exported = await api<ExportRow>("/v1/analytics/exports", {
      env,
      request,
      method: "POST",
      headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
      body: { format, definition, totals: true }
    });
    return { ...nothing, exported };
  } catch (error) {
    return { ...nothing, problem: refusal(error) };
  }
}

/* --------------------------------------------------------------- component */

export default function CustomerAnalytics() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state !== "idle";
  const table = result?.table ?? null;
  const exported = result?.exported ?? null;

  const percent = (value: number | null) =>
    value === null
      ? l("noData")
      : new Intl.NumberFormat(loaded.locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
  // A bare "4" under a heading reading CSAT is not a number anyone can act on:
  // the survey is 1-5 (packages/core/src/seed/orbit.ts) and the QA rubric is
  // 0-100, so the scale rides with the value.
  const outOf = (value: number | null, max: number) =>
    value === null ? l("noData") : `${Math.round(value)} / ${max}`;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {analyticsHeadline(loaded.containment, loaded.days, l)}
          </h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("lede")}</p>
        </div>
        <nav aria-label={l("window")} className="flex items-center gap-2">
          {WINDOWS.map((days) => (
            <Link
              key={days}
              to={`/orbit/analytics?days=${days}`}
              aria-current={loaded.days === days ? "page" : undefined}
            >
              <Badge tone={loaded.days === days ? "accent" : "neutral"}>{l("days", { n: String(days) })}</Badge>
            </Link>
          ))}
        </nav>
      </header>

      {result?.error ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{l(result.error)}</p>
        </div>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <KPIWall>
        <Stat label={l("containment")} value={percent(loaded.containment)} hint={l("containmentHint")} />
        <Stat label={l("handover")} value={percent(loaded.handoverRate)} hint={l("handoverHint")} />
        <Stat label={l("csat")} value={outOf(loaded.csat, 5)} hint={l("csatHint")} />
        <Stat label={l("retention")} value={percent(loaded.retention)} hint={l("retentionHint")} />
      </KPIWall>

      <Card padded={false}>
        <dl className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">
          <Counted term={l("conversations")} value={loaded.conversations} locale={loaded.locale} />
          <Counted term={l("handovers")} value={loaded.handovers} locale={loaded.locale} />
          <Counted term={l("accepted")} value={loaded.accepted} locale={loaded.locale} />
          <Counted term={l("lost")} value={loaded.lost} locale={loaded.locale} />
        </dl>
        <div className="flex flex-wrap gap-4 border-t border-line px-6 py-4">
          <EvidenceLink
            sourceLabel={l("approxLabel")}
            source={<p className="max-w-prose font-ui text-13 text-muted">{l("approxBody")}</p>}
          >
            <span className="font-ui text-12 text-subtle">{l("containment")}</span>
          </EvidenceLink>
          <EvidenceLink
            sourceLabel={l("csatWhy")}
            source={<p className="max-w-prose font-ui text-13 text-muted">{l("csatWhyBody")}</p>}
          >
            <span className="font-ui text-12 text-subtle">{l("csat")}</span>
          </EvidenceLink>
          <span className="font-ui text-12 text-subtle" title={l("sentimentWhy")
}>
            {l("sentiment")}:{" "}
            {loaded.sentiment === null
              ? "—"
              : `${loaded.sentiment > 0 ? "+" : ""}${Math.round(loaded.sentiment
)}`}
          </span>
          <span className="font-ui text-12 text-subtle">
            {l("quality")}: {outOf(loaded.quality, 100)}
          </span>
        </div>
      </Card>

      {loaded.may.run || loaded.may.export ? (
        <Card title={l("breakdown")} description={l("breakdownBody")}>
          <div className="flex flex-wrap items-end gap-6">
            {loaded.may.run ? (
              <Form method="post" replace className="flex flex-wrap items-end gap-4">
                <input type="hidden" name="intent" value="run" />
                <input type="hidden" name="days" value={String(loaded.days)} />
                <Field label={l("dimension")} required>
                  <Select
                    name="dimension"
                    defaultValue="channel"
                    options={DIMENSIONS.map((key) => ({ value: key, label: l(key) }))}
                  />
                </Field>
                <Field label={l("grain")} required>
                  <Select
                    name="grain"
                    defaultValue="none"
                    options={GRAINS.map((key) => ({ value: key, label: l(key) }))}
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy}>
                  {busy ? l("running") : l("run")}
                </Button>
              </Form>
            ) : null}

            {loaded.may.export ? (
              <Form method="post" replace className="flex flex-wrap items-end gap-4">
                <input type="hidden" name="intent" value="export" />
                <input type="hidden" name="days" value={String(loaded.days)} />
                <input type="hidden" name="dimension" value="channel" />
                <input type="hidden" name="grain" value="month" />
                <Field label={l("format")} required>
                  <Select
                    name="format"
                    defaultValue="xlsx"
                    options={FORMATS.map((format) => ({ value: format, label: l(format) }))}
                  />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy}>
                  {l("export")}
                </Button>
              </Form>
            ) : null}
          </div>

          {exported ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="font-ui text-13 text-text">
                {exported.state === "ready" ? l("exportReady") : l("exportQueued")}
              </span>
              <Badge tone={exported.state === "ready" ? "success" : "neutral"} size="sm" dot>
                {l(exported.format)}
              </Badge>
              {exported.error ? (
                <span role="alert" className="font-ui text-12 text-danger">
                  {exported.error}
                </span>
              ) : null}
              {exported.state === "ready" ? (
                // ponytail: straight to the API origin, as signal-analytics.tsx and
                // analytics-report.tsx do — the API streams its own filename.
                <Button asChild variant="secondary" size="sm">
                  <a href={`${loaded.apiOrigin}/v1/analytics/exports/${exported.id}/download`} rel="noopener">
                    {l("download")}
                  </a>
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6">
            {table === null ? (
              <EmptyState title={l("noRun")} body={l("noRunBody")} />
            ) : (
              <>
                <Table
                  caption={l("breakdown")}
                  rows={table.rows}
                  rowKey={(row) => table.columns.map((column) => String(row[column.key] ?? "")).join("/")}
                  density="compact"
                  columns={table.columns.map((column) => ({
                    key: column.key,
                    header: headerFor(column.key, column.label, loaded.locale),
                    numeric: column.kind === "number" || column.kind === "money",
                    render: (row: Record<string, unknown>) => {
                      const cell = row[column.key];
                      if (cell === null || cell === undefined || cell === "") return "—";
                      return typeof cell === "number" ? cell.toLocaleString(loaded.locale) : String(cell);
                    }
                  }))}
                />
                <p className="mt-3 font-ui text-12 text-subtle">
                  {l("rows", { n: String(table.rowCount) })} · {l("generated")}{" "}
                  <DateTime value={table.generatedAt} locale={loaded.locale} />
                  {table.truncated ? ` · ${l("truncated")}` : ""}
                </p>
              </>
            )}
          </div>
        </Card>
      ) : null}

      <footer className="flex flex-wrap gap-4">
        <Link to="/orbit/console" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("openConsole")}
        </Link>
        <Link to="/orbit/save" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("openSave")}
        </Link>
        <Link to="/orbit/quality" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("openQuality")}
        </Link>
      </footer>
    </div>
  );
}

function Counted({ term, value, locale }: { term: string; value: number; locale: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="font-mono text-22 tabular-nums text-text">{value.toLocaleString(locale)}</dd>
    </div>
  );
}

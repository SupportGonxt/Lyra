import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, EmptyState } from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import type { DatasetInfo } from "../analytics-def";
import { DashboardEditor, type ReportChoice } from "../components/dashboard-editor";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { filtersFromForm, layoutOf, type Layout, type TileSpec } from "../dashboard-layout";
import { asJson } from "../json.js";
import { labelsIn as builderLabels } from "./analytics-builder";
import { labelsFrom } from "./detail-kit";
import { Gate } from "./module";
import { useShellData } from "./workspace";

// docs/30 Analytics 5. The tile editor for one dashboard: add a tile from a
// saved report or from a dataset and measure (the builder's own form reader,
// `tileFromChoice`), remove, reorder by button or Alt+Arrow, resize on the
// twelve-column grid, and set the dashboard's filters — a date range and
// dimension filters every tile inherits at render.
//
// It saves through the door that already exists: generic CRUD's
// `PATCH /v1/analytics/dashboards/:id` under `analytics:dashboards:write`, whose
// `beforeWrite` holds the layout to the same schema and registry checks the
// module router's POST uses (`checkDashboardLayout`). This screen never decides
// what a valid layout is; it only builds one.

export const PERM = {
  read: "analytics:dashboards:read",
  write: "analytics:dashboards:write",
  reports: "analytics:reports:read"
} as const;

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Edit tiles",
    intro: "Arrange what this dashboard shows. Filters below apply to every tile whose data has that field.",
    denied: "You cannot edit dashboards",
    deniedBody: "Editing a dashboard needs {permission}.",
    missing: "This dashboard is not available to you.",
    malformed: "The stored layout could not be read, so the editor starts empty. Saving replaces it.",
    tiles: "Tiles",
    reorderHint: "Move a tile with its arrow buttons, or focus it and press Alt with the up or down arrow (Alt+Home and Alt+End for either end).",
    noTiles: "No tiles yet. Add one below.",
    preview: "Layout preview on the twelve-column grid",
    viz: "Shown as",
    "viz.number": "Figure",
    "viz.line": "Line over time",
    "viz.bar": "Bars",
    "viz.table": "Table",
    "viz.donut": "Share of the whole",
    "viz.list": "List",
    width: "Width",
    widthOf: "{n} of {of} columns",
    moveUp: "Move {title} up",
    moveDown: "Move {title} down",
    removeTile: "Remove {title}",
    remove: "Remove",
    moved: "{title} moved to position {position} of {count}.",
    fromReport: "From the saved report {name}",
    addTile: "Add a tile",
    source: "Draw it from",
    fromDataset: "A dataset and measure",
    fromSaved: "A saved report",
    report: "Saved report",
    dataset: "Dataset",
    measure: "Measure",
    splitBy: "Split by",
    noSplit: "No split",
    grain: "Time bucket",
    "grain.none": "No bucketing",
    "grain.day": "Day",
    "grain.week": "Week",
    "grain.month": "Month",
    "grain.quarter": "Quarter",
    "grain.year": "Year",
    tileTitle: "Tile title (optional)",
    errPick: "Pick a measure, or a saved report, first.",
    errFull: "This dashboard already holds the most tiles it can.",
    filtersHint: "A tile whose data has no such field is drawn unfiltered, and says so.",
    range: "Date range",
    "range.none": "Each tile's own dates",
    "range.last": "Last {days} days",
    "range.fixed": "Fixed dates",
    from: "From",
    to: "To",
    filterField: "Field",
    filterOp: "Test",
    filterValue: "Value",
    anyField: "No filter",
    noFilterable: "Add a tile first; filters are drawn from the fields its data has.",
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
    saveLayout: "Save layout",
    backToDashboard: "Back to the dashboard",
    unreadable: "The tile list could not be read. Reload the editor and try again."
  },
  ar: {
    title: "تحرير البطاقات",
    intro: "رتّب ما تعرضه هذه اللوحة. تنطبق عوامل التصفية أدناه على كل بطاقة تحتوي بياناتها على ذلك الحقل.",
    denied: "لا يمكنك تحرير لوحات المعلومات",
    deniedBody: "يتطلب تحرير اللوحة الصلاحية {permission}.",
    missing: "هذه اللوحة غير متاحة لك.",
    malformed: "تعذّرت قراءة التخطيط المحفوظ، لذا يبدأ المحرر فارغًا. الحفظ يستبدله.",
    tiles: "البطاقات",
    reorderHint: "حرّك البطاقة بأزرار الأسهم، أو ركّز عليها واضغط Alt مع السهم لأعلى أو لأسفل (Alt+Home وAlt+End للطرفين).",
    noTiles: "لا توجد بطاقات بعد. أضف واحدة أدناه.",
    preview: "معاينة التخطيط على شبكة من اثني عشر عمودًا",
    viz: "العرض",
    "viz.number": "رقم",
    "viz.line": "خط عبر الزمن",
    "viz.bar": "أشرطة",
    "viz.table": "جدول",
    "viz.donut": "الحصة من الكل",
    "viz.list": "قائمة",
    width: "العرض بالأعمدة",
    widthOf: "{n} من {of} أعمدة",
    moveUp: "نقل {title} لأعلى",
    moveDown: "نقل {title} لأسفل",
    removeTile: "إزالة {title}",
    remove: "إزالة",
    moved: "نُقلت {title} إلى الموضع {position} من {count}.",
    fromReport: "من التقرير المحفوظ {name}",
    addTile: "إضافة بطاقة",
    source: "المصدر",
    fromDataset: "مجموعة بيانات ومقياس",
    fromSaved: "تقرير محفوظ",
    report: "التقرير المحفوظ",
    dataset: "مجموعة البيانات",
    measure: "المقياس",
    splitBy: "التقسيم حسب",
    noSplit: "بدون تقسيم",
    grain: "الفترة الزمنية",
    "grain.none": "بدون تجميع",
    "grain.day": "يوم",
    "grain.week": "أسبوع",
    "grain.month": "شهر",
    "grain.quarter": "ربع سنة",
    "grain.year": "سنة",
    tileTitle: "عنوان البطاقة (اختياري)",
    errPick: "اختر مقياسًا أو تقريرًا محفوظًا أولًا.",
    errFull: "تحتوي هذه اللوحة بالفعل على أقصى عدد من البطاقات.",
    filtersHint: "البطاقة التي لا تحتوي بياناتها على هذا الحقل تُعرض دون تصفية، وتذكر ذلك.",
    range: "النطاق الزمني",
    "range.none": "تواريخ كل بطاقة",
    "range.last": "آخر {days} يومًا",
    "range.fixed": "تواريخ محددة",
    from: "من",
    to: "إلى",
    filterField: "الحقل",
    filterOp: "الشرط",
    filterValue: "القيمة",
    anyField: "بدون تصفية",
    noFilterable: "أضف بطاقة أولًا؛ تُستمد عوامل التصفية من حقول بياناتها.",
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
    saveLayout: "حفظ التخطيط",
    backToDashboard: "العودة إلى اللوحة",
    unreadable: "تعذّرت قراءة قائمة البطاقات. أعد تحميل المحرر وحاول مرة أخرى."
  }
};
export const labelsIn = labelsFrom(LABELS);

/** The list row: where the name, the row rule and the stored layout live. */
interface DashboardRow {
  id: string;
  key: string;
  nameJson: unknown;
  layoutJson: unknown;
}

/** GET /v1/analytics/reports, as far as the add form needs it. */
interface ReportRow {
  id: string;
  key: string;
  name: Record<string, string>;
  definitionJson: string;
}

/** A saved report as the add form offers it: its name in the reader's language and its dataset. */
export function reportChoices(rows: ReportRow[], locale: string): ReportChoice[] {
  return rows.map((row) => {
    const def = asJson<{ dataset?: unknown }>(row.definitionJson, {});
    return {
      id: row.id,
      name: row.name[locale] ?? row.name.en ?? row.key,
      dataset: typeof def.dataset === "string" ? def.dataset : null
    };
  });
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const dashboardId = params.id ?? "";
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const none = { denied: false, name: null as string | null, id: dashboardId, layout: { tiles: [] } as Layout, malformed: false, datasets: [] as DatasetInfo[], reports: [] as ReportChoice[] };
  if (!held.has(PERM.write) || !held.has(PERM.read)) return { ...none, denied: true };

  // The list is the gate, as on the dashboard itself: one this reader cannot
  // see is not theirs to edit, and the PATCH would refuse it anyway.
  const listed = await api<{ data: DashboardRow[] }>("/v1/analytics/dashboards", { env, request });
  const row = listed.data.find((entry) => entry.id === dashboardId);
  if (!row) return none;

  const bag = asJson<Record<string, string>>(row.nameJson, {});
  const name = bag[me.locale] ?? bag.en ?? row.key;
  const stored = layoutOf(row.layoutJson);
  const [{ data: datasets }, reports] = await Promise.all([
    api<{ data: DatasetInfo[] }>("/v1/analytics/datasets", { env, request }),
    held.has(PERM.reports)
      ? api<{ data: ReportRow[] }>("/v1/analytics/reports?limit=200", { env, request }).then((r) => reportChoices(r.data, me.locale))
      : Promise.resolve([] as ReportChoice[])
  ]);
  return { ...none, name, layout: stored ?? { tiles: [] }, malformed: !stored, datasets, reports };
}

export type ActionResult = { problem: Problem | null; error: string | null };

export async function action({ request, params, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const dashboardId = params.id ?? "";
  const form = await request.formData();
  const tiles = asJson<TileSpec[] | null>(String(form.get("tiles") ?? ""), null);
  if (!Array.isArray(tiles)) return { problem: null, error: "unreadable" };
  const filters = filtersFromForm(form);
  const layout: Layout = filters ? { tiles, filters } : { tiles };
  try {
    await api(`/v1/analytics/dashboards/${encodeURIComponent(dashboardId)}`, {
      env,
      request,
      method: "PATCH",
      body: { layoutJson: layout }
    });
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, error: null };
    throw error;
  }
  throw redirect(`/analytics/dashboard/${encodeURIComponent(dashboardId)}`);
}

export default function AnalyticsDashboardEdit() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const busy = useNavigation().state !== "idle";
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const b = builderLabels(locale, shell?.domainPack);
  const t = translator(locale);

  if (loaded.denied) return <EmptyState title={l("denied")} body={l("deniedBody", { permission: PERM.write })} />;
  if (!loaded.name) return <EmptyState title={l("missing")} body={t("error.notFound")} />;

  // The builder's dataset names, so a dataset reads the same on both screens.
  const datasetName = (key: string) => {
    const said = b(`dataset.${key}`);
    return said === `dataset.${key}` ? key : said;
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="eyebrow">{loaded.name}</p>
          <h1 className="page-title">{l("title")}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
        </div>
        <Link to={`/analytics/dashboard/${loaded.id}`} className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("backToDashboard")}
        </Link>
      </header>

      {loaded.malformed ? (
        <p role="status" className="font-ui text-13 text-warning">
          {l("malformed")}
        </p>
      ) : null}
      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <Form method="post" className="flex flex-col gap-6">
        <DashboardEditor initial={loaded.layout} datasets={loaded.datasets} reports={loaded.reports} l={l} datasetName={datasetName} />
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            {l("saveLayout")}
          </Button>
        </div>
      </Form>
    </div>
  );
}

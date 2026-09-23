import type { ReactNode } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { EmptyState, LineChart, Money, Stat, Table, type Column } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { builderHref, type ReportDefinition } from "../analytics-def";
import { cloudflare } from "../context";
import { moduleName, translator } from "../i18n";
import type { Row } from "../modules/spec";
import { labelsFrom } from "./detail-kit";
import { useShellData } from "./workspace";

// The AI operations dashboard (docs/17 ANL-009's operating half, ADR-0087):
// is AI any good here, what does it cost, how much of it runs and how fast,
// and are the evals holding. Every figure is one definition over the AI
// datasets (apps/api/src/engines/report.ts), run through POST /v1/analytics/run
// — the same endpoint and the same definitions the report builder runs — so
// each figure opens in the builder exactly as it was drawn, for the reader to
// split, filter or save. There is no bespoke endpoint behind this screen.
//
// A panel the reader may not see (each AI dataset carries its own gate) is
// absent, not zero: a 4xx other than 401 blanks that panel and leaves the rest
// standing (CLAUDE.md sighting 8 — "what must NOT be swallowed").

/** The run response the screen reads: RunResult rows (apps/api/src/engines/report.ts). */
export interface PanelResult {
  rows: Row[];
}

export const PANELS = [
  "quality",
  "spend",
  "guardrails",
  "evals",
  "costByDay",
  "costByModule",
  "costByPurpose",
  "runsByDay",
  "runsByModule",
  "evalsByDay",
  "evalsBySuite"
] as const;
export type PanelKey = (typeof PANELS)[number];
export type Panels = Record<PanelKey, PanelResult | null>;

const WINDOWS = [7, 30, 90] as const;
const DAY_MS = 86_400_000;

/** ai_audit_log / ai_runs cost is micro-units of the provider's USD bill. */
const COST_CURRENCY = "USD";

export function windowDays(raw: string | null): number {
  const n = Number(raw);
  return (WINDOWS as readonly number[]).includes(n) ? n : 30;
}

/** Micro-units to minor units: 1,000,000 micro = 1 major = 100 minor. */
export function microToMinor(micro: number): number {
  return Math.round(micro / 10_000);
}

/** Every figure on the screen, as the definition it is drawn from. */
export function panelDefinitions(from: number): Record<PanelKey, ReportDefinition> {
  return {
    quality: { dataset: "aiSuggestions", metrics: ["shown", "acceptanceRate"], from },
    spend: { dataset: "aiSpend", metrics: ["calls", "costMicro", "refusalRate", "latency"], from },
    guardrails: { dataset: "aiGuardrails", metrics: ["events", "blocks"], from },
    evals: { dataset: "aiEvals", metrics: ["cases", "avgScore", "passRate"], from },
    costByDay: { dataset: "aiSpend", metrics: ["costMicro", "calls"], grain: "day", from },
    costByModule: {
      dataset: "aiSpend",
      metrics: ["costMicro", "calls", "refusalRate"],
      dimensions: ["module"],
      sort: { field: "costMicro", dir: "desc" },
      from
    },
    costByPurpose: {
      dataset: "aiSpend",
      metrics: ["costMicro", "calls", "latency"],
      dimensions: ["purpose"],
      sort: { field: "costMicro", dir: "desc" },
      limit: 10,
      from
    },
    runsByDay: { dataset: "aiRuns", metrics: ["runs", "latency"], grain: "day", from },
    runsByModule: {
      dataset: "aiRuns",
      metrics: ["runs", "latency", "failureRate", "refusalRate"],
      dimensions: ["module"],
      sort: { field: "runs", dir: "desc" },
      from
    },
    evalsByDay: { dataset: "aiEvals", metrics: ["avgScore", "passRate"], grain: "day", from },
    evalsBySuite: {
      dataset: "aiEvals",
      metrics: ["avgScore", "passRate", "cases"],
      dimensions: ["suite"],
      sort: { field: "passRate", dir: "asc" },
      from
    }
  };
}

/** The builder, opened on a figure's own definition and run — the reader asked to look. */
export function figureHref(def: ReportDefinition): string {
  return builderHref(def, { run: true });
}

export interface Kpis {
  acceptanceRate: number | null;
  shown: number | null;
  refusalRate: number | null;
  calls: number | null;
  costMinor: number | null;
  latency: number | null;
  blocks: number | null;
  events: number | null;
  passRate: number | null;
  avgScore: number | null;
}

/** The headline figures from the four total panels; null where there is no figure. */
export function kpisOf(panels: Partial<Panels>): Kpis {
  const read = (panel: PanelKey, key: string): number | null => {
    const value = panels[panel]?.rows[0]?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const cost = read("spend", "costMicro");
  return {
    acceptanceRate: read("quality", "acceptanceRate"),
    shown: read("quality", "shown"),
    refusalRate: read("spend", "refusalRate"),
    calls: read("spend", "calls"),
    costMinor: cost === null ? null : microToMinor(cost),
    latency: read("spend", "latency"),
    blocks: read("guardrails", "blocks"),
    events: read("guardrails", "events"),
    passRate: read("evals", "passRate"),
    avgScore: read("evals", "avgScore")
  };
}

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "AI operations",
    intro: "Whether AI is earning its place: how often its suggestions are kept, what it costs, how much of it runs and how fast, and whether the evals hold.",
    window: "Window",
    days: "{n} days",
    acceptance: "Suggestions kept",
    acceptanceHint: "{n} shown",
    refusals: "Refused calls",
    refusalsHint: "{n} calls",
    blocks: "Guardrail blocks",
    blocksHint: "{n} events",
    passRate: "Eval pass rate",
    passRateHint: "average score {n}",
    cost: "AI cost",
    latency: "Average latency",
    ms: "{n} ms",
    costOverTime: "Cost per day",
    runsOverTime: "Runs per day",
    latencyOverTime: "Run latency per day (ms)",
    scoreOverTime: "Average eval score per day",
    byModule: "Cost by module",
    byPurpose: "Top purposes by cost",
    runsByModule: "Runs by module",
    bySuite: "Eval suites, weakest first",
    openInBuilder: "Open in the builder",
    hidden: "Hidden: your roles do not include this data.",
    quiet: "Nothing in this window.",
    noRun: "You may not run reports, so this screen has nothing to show you.",
    "col.module": "Module",
    "col.purpose": "Purpose",
    "col.suite": "Suite",
    "col.cost": "Cost",
    "col.calls": "Calls",
    "col.runs": "Runs",
    "col.latency": "Latency (ms)",
    "col.failureRate": "Failed %",
    "col.refusalRate": "Refused %",
    "col.avgScore": "Average score",
    "col.passRate": "Pass %",
    "col.cases": "Cases"
  },
  ar: {
    title: "عمليات الذكاء الاصطناعي",
    intro: "هل يستحق الذكاء الاصطناعي مكانه: كم مرة تُعتمد اقتراحاته، وكم يكلّف، وكم يعمل وبأي سرعة، وهل تصمد التقييمات.",
    window: "الفترة",
    days: "{n} يومًا",
    acceptance: "الاقتراحات المعتمدة",
    acceptanceHint: "{n} معروضة",
    refusals: "الاستدعاءات المرفوضة",
    refusalsHint: "{n} استدعاء",
    blocks: "حظر الضوابط",
    blocksHint: "{n} حدث",
    passRate: "نسبة نجاح التقييمات",
    passRateHint: "متوسط الدرجة {n}",
    cost: "تكلفة الذكاء الاصطناعي",
    latency: "متوسط زمن الاستجابة",
    ms: "{n} مللي ثانية",
    costOverTime: "التكلفة اليومية",
    runsOverTime: "التشغيلات اليومية",
    latencyOverTime: "زمن استجابة التشغيل يوميًا (مللي ثانية)",
    scoreOverTime: "متوسط درجة التقييم يوميًا",
    byModule: "التكلفة حسب الوحدة",
    byPurpose: "أعلى الأغراض تكلفة",
    runsByModule: "التشغيلات حسب الوحدة",
    bySuite: "مجموعات التقييم، الأضعف أولًا",
    openInBuilder: "فتح في المنشئ",
    hidden: "مخفي: أدوارك لا تشمل هذه البيانات.",
    quiet: "لا شيء في هذه الفترة.",
    noRun: "لا يمكنك تشغيل التقارير، لذا لا تعرض هذه الشاشة شيئًا لك.",
    "col.module": "الوحدة",
    "col.purpose": "الغرض",
    "col.suite": "المجموعة",
    "col.cost": "التكلفة",
    "col.calls": "الاستدعاءات",
    "col.runs": "التشغيلات",
    "col.latency": "زمن الاستجابة (مللي ثانية)",
    "col.failureRate": "الفاشلة %",
    "col.refusalRate": "المرفوضة %",
    "col.avgScore": "متوسط الدرجة",
    "col.passRate": "النجاح %",
    "col.cases": "الحالات"
  }
};

const labelsIn = labelsFrom(LABELS);

/* ---------------------------------------------------------------- loader */

/** A panel the reader may not see is null; a signed-out 401 and any 5xx still throw. */
async function panel(call: Promise<PanelResult>): Promise<PanelResult | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401) return null;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const days = windowDays(new URL(request.url).searchParams.get("days"));
  const me = await fetchMe(env, request);
  const may = new Set(me.permissions).has("analytics:reports:run");
  const from = Date.now() - days * DAY_MS;
  const defs = panelDefinitions(from);
  if (!may) return { may, days, defs, panels: null };

  const results = await Promise.all(
    PANELS.map((key) =>
      panel(api<PanelResult>("/v1/analytics/run", { env, request, method: "POST", body: { ...defs[key], totals: false } }))
    )
  );
  const panels = Object.fromEntries(PANELS.map((key, i) => [key, results[i] ?? null])) as Panels;
  return { may, days, defs, panels };
}

/* ---------------------------------------------------------------- screen */

export default function AiAnalytics() {
  const { may, days, defs, panels } = useLoaderData<typeof loader>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const nf = new Intl.NumberFormat(locale);
  const say = (key: string, n: number | null) => l(key, { n: n === null ? "—" : nf.format(n) });

  if (!may || !panels) return <EmptyState title={l("title")} body={l("noRun")} />;
  const k = kpisOf(panels);
  const pct = (n: number | null) => (n === null ? "—" : `${nf.format(n)}%`);

  const series = (key: PanelKey, metric: string, title: string, transform: (n: number) => number = (n) => n) => {
    const rows = panels[key]?.rows ?? null;
    return (
      <Panel title={title} href={figureHref(defs[key])} l={l} hidden={rows === null}>
        {rows && rows.length ? (
          <LineChart
            values={rows.map((row) => transform(Number(row[metric]) || 0))}
            xLabels={rows.map((row) => String(row.period ?? ""))}
            label={title}
            format={(n) => nf.format(n)}
          />
        ) : (
          <p className="font-ui text-13 text-subtle">{l("quiet")}</p>
        )}
      </Panel>
    );
  };

  const cost = (row: Row) => <Money amountMinor={microToMinor(Number(row.costMicro) || 0)} currency={COST_CURRENCY} locale={locale} />;
  const num = (key: string) => (row: Row) => (row[key] === null || row[key] === undefined ? "—" : nf.format(Number(row[key])));
  const table = (key: PanelKey, title: string, columns: Array<Column<Row>>) => {
    const rows = panels[key]?.rows ?? null;
    return (
      <Panel title={title} href={figureHref(defs[key])} l={l} hidden={rows === null}>
        {rows && rows.length ? (
          <Table columns={columns} rows={rows} rowKey={(row) => JSON.stringify(row)} caption={title} density="compact" />
        ) : (
          <p className="font-ui text-13 text-subtle">{l("quiet")}</p>
        )}
      </Panel>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">{l("title")}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
        </div>
        <nav aria-label={l("window")} className="flex gap-2">
          {WINDOWS.map((n) => (
            <Link
              key={n}
              to={`/admin/ai/analytics?days=${n}`}
              aria-current={n === days ? "page" : undefined}
              className={
                n === days
                  ? "rounded-md border border-accent px-2 py-1 font-ui text-13 text-accent"
                  : "rounded-md border border-border px-2 py-1 font-ui text-13 text-muted hover:text-text"
              }
            >
              {l("days", { n: nf.format(n) })}
            </Link>
          ))}
        </nav>
      </header>

      {/* Data in the top half (ui.md §4.1): the six headline figures, each a link to the query behind it. */}
      <div className="grid grid-cols-2 gap-4 rounded-md border border-border p-4 md:grid-cols-3 xl:grid-cols-6">
        <Figure href={figureHref(defs.quality)}>
          <Stat label={l("acceptance")} value={pct(k.acceptanceRate)} hint={say("acceptanceHint", k.shown)} />
        </Figure>
        <Figure href={figureHref(defs.spend)}>
          <Stat label={l("refusals")} value={pct(k.refusalRate)} hint={say("refusalsHint", k.calls)} />
        </Figure>
        <Figure href={figureHref(defs.guardrails)}>
          <Stat label={l("blocks")} value={k.blocks === null ? "—" : nf.format(k.blocks)} hint={say("blocksHint", k.events)} />
        </Figure>
        <Figure href={figureHref(defs.evals)}>
          <Stat label={l("passRate")} value={pct(k.passRate)} hint={say("passRateHint", k.avgScore)} />
        </Figure>
        <Figure href={figureHref(defs.spend)}>
          <Stat
            label={l("cost")}
            value={k.costMinor === null ? "—" : <Money amountMinor={k.costMinor} currency={COST_CURRENCY} locale={locale} />}
          />
        </Figure>
        <Figure href={figureHref(defs.spend)}>
          <Stat label={l("latency")} value={k.latency === null ? "—" : say("ms", k.latency)} />
        </Figure>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {series("costByDay", "costMicro", l("costOverTime"), microToMinor)}
        {series("runsByDay", "runs", l("runsOverTime"))}
        {series("runsByDay", "latency", l("latencyOverTime"))}
        {series("evalsByDay", "avgScore", l("scoreOverTime"))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {table("costByModule", l("byModule"), [
          { key: "module", header: l("col.module"), render: (row) => moduleName(t, String(row.module ?? "")) },
          { key: "costMicro", header: l("col.cost"), numeric: true, render: cost },
          { key: "calls", header: l("col.calls"), numeric: true, render: num("calls") },
          { key: "refusalRate", header: l("col.refusalRate"), numeric: true, render: num("refusalRate") }
        ])}
        {table("costByPurpose", l("byPurpose"), [
          { key: "purpose", header: l("col.purpose"), render: (row) => String(row.purpose ?? "—") },
          { key: "costMicro", header: l("col.cost"), numeric: true, render: cost },
          { key: "calls", header: l("col.calls"), numeric: true, render: num("calls") },
          { key: "latency", header: l("col.latency"), numeric: true, render: num("latency") }
        ])}
        {table("runsByModule", l("runsByModule"), [
          { key: "module", header: l("col.module"), render: (row) => moduleName(t, String(row.module ?? "")) },
          { key: "runs", header: l("col.runs"), numeric: true, render: num("runs") },
          { key: "latency", header: l("col.latency"), numeric: true, render: num("latency") },
          { key: "failureRate", header: l("col.failureRate"), numeric: true, render: num("failureRate") },
          { key: "refusalRate", header: l("col.refusalRate"), numeric: true, render: num("refusalRate") }
        ])}
        {table("evalsBySuite", l("bySuite"), [
          { key: "suite", header: l("col.suite"), render: (row) => String(row.suite ?? "—") },
          { key: "avgScore", header: l("col.avgScore"), numeric: true, render: num("avgScore") },
          { key: "passRate", header: l("col.passRate"), numeric: true, render: num("passRate") },
          { key: "cases", header: l("col.cases"), numeric: true, render: num("cases") }
        ])}
      </div>
    </div>
  );
}

/** A headline figure is a link to the query that produced it (ui.md §5 Drill-down). */
function Figure({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link to={href} className="rounded-md p-1 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent">
      <span data-stat>{children}</span>
    </Link>
  );
}

function Panel({
  title,
  href,
  l,
  hidden,
  children
}: {
  title: string;
  href: string;
  l: (key: string) => string;
  hidden: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-4">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="font-ui text-12 font-medium uppercase tracking-[0.14em] text-subtle">{title}</h2>
        {hidden ? null : (
          <Link to={href} className="font-ui text-12 text-accent underline-offset-2 hover:underline">
            {l("openInBuilder")}
          </Link>
        )}
      </header>
      {hidden ? <p className="font-ui text-13 text-subtle">{l("hidden")}</p> : children}
    </section>
  );
}

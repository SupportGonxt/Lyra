import { AgentBadge, Hero, ScreenState, cn, renderSection, hueVar, type HeroChip, type Section } from "@lyra/ui";
import { useLocation, type LoaderFunctionArgs } from "react-router";
import { api, asRouteError } from "../api.server";
import { cloudflare } from "../context";
import {
  JourneyContinue,
  JourneyHeader,
  JourneyNav,
  counted,
  dayOf,
  journeyLabels,
  lineName,
  stepHref
} from "../components/journey-nav";
import { translator, DEFAULT_LOCALE } from "../i18n";
import { humanise } from "../modules/spec";
import { tag, type Label } from "./detail-kit";
import { chosen, metricName, metricText, narrative, parsed, pct, readable, type Metric, type Page } from "./north-shared";
import { useShellData } from "./workspace";

interface BriefingRow {
  id: string;
  date: string;
  audience: string;
  locale: string;
  narrativeRef: string;
  highlightsJson: unknown;
  status: string;
  /** "ai" for a briefing the narrator wrote (packages/db/src/schema/north.ts). */
  generatedBy?: string;
  createdAt: number;
}

/**
 * One entry of `highlightsJson`, mirroring `Highlight` in
 * apps/web/app/routes/north-brief.tsx — which in turn mirrors what
 * apps/api/src/engines/narrator.ts writes. `note` is the sentence a reader
 * wants here; north-brief renders the figure and its delta instead, so it has
 * no field for it.
 *
 * This screen used to declare the column as `string[]` and filter for strings,
 * which matched nothing the server has ever sent: every briefing read zero
 * highlights. Third sighting of the assumed-contract bug (see CLAUDE.md on
 * whitespace-commentary and labelsFrom) — hence the comment naming the file
 * this type mirrors.
 */
interface Highlight {
  metricKey: string;
  period: string;
  value: number;
  deltaBps: number | null;
  note?: string;
}

const BRIEFING_HISTORY_LIMIT = 12;
const METRICS_LIMIT = 200;

const LABELS = {
  en: {
    title: "What the latest briefing says",
    heroEyebrow: "Briefing",
    // A briefing has no product-line column and the list has no such filter
    // (packages/db/src/schema/north.ts, apps/api/src/crud.ts), so the line the
    // previous step chose is carried, not applied — and the screen says so.
    ledeLine: "Briefings cover the whole book and are not split by product line, so this is the latest one for {audience}, read with {line} in mind.",
    lede: "The latest briefing for {audience}, with {highlights}.",
    "highlight.one": "{n} highlight",
    "highlight.other": "{n} highlights",
    highlights: "Highlights",
    status: "Status",
    audience: "Audience",
    language: "Language",
    date: "Date",
    written: "Written {date}",
    trend: "Highlights per briefing",
    briefing: "Briefing",
    narrative: "Narrative",
    "status.published": "Published",
    why: "Written by the briefing agent from this business's metric snapshots. Every figure in it was checked against the metric layer before the briefing was saved, and a person approves it before it is published.",
    emptyTitle: "No briefing yet",
    emptyBody: "Insight has not written a briefing yet — generate one from the briefing screen first.",
    continue: "See where the market has gaps"
  },
  ar: {
    title: "ما يقوله أحدث موجز",
    heroEyebrow: "الموجز",
    ledeLine: "تغطي الموجزات المحفظة كاملة ولا تُقسَّم حسب خط المنتج، لذا هذا أحدث موجز لـ{audience}، يُقرأ مع وضع {line} في الاعتبار.",
    lede: "أحدث موجز لـ{audience}، وفيه {highlights}.",
    "highlight.zero": "لا أبرز نقاط",
    "highlight.one": "نقطة بارزة واحدة",
    "highlight.two": "نقطتان بارزتان",
    "highlight.few": "{n} نقاط بارزة",
    "highlight.many": "{n} نقطة بارزة",
    "highlight.other": "{n} نقطة بارزة",
    highlights: "أبرز النقاط",
    status: "الحالة",
    audience: "الجمهور",
    language: "اللغة",
    date: "التاريخ",
    written: "كُتب في {date}",
    trend: "أبرز النقاط في كل موجز",
    briefing: "الموجز",
    narrative: "السرد",
    "status.published": "منشور",
    why: "كتبه وكيل الموجزات من لقطات مؤشرات هذا العمل. رُوجع كل رقم فيه مقابل طبقة المؤشرات قبل حفظ الموجز، ويعتمده شخص قبل نشره.",
    emptyTitle: "لا يوجد موجز بعد",
    emptyBody: "لم تكتب التحليلات التنفيذية موجزًا بعد — أنشئ واحدًا من شاشة الموجز أولًا.",
    continue: "اطّلع على فجوات السوق"
  }
};

export const labelsIn = journeyLabels(LABELS);

export function highlightsOf(row: BriefingRow | null | undefined): Highlight[] {
  const list = parsed<unknown>(row?.highlightsJson, []);
  if (!Array.isArray(list)) return [];
  return list.filter((h): h is Highlight => typeof h === "object" && h !== null && "metricKey" in h);
}

/** The sentence under the heading. Never claims a product-line filter exists. */
export function lede(
  l: Label,
  { productLine, audience, highlights, locale }: { productLine: string; audience: string; highlights: number; locale: string }
): string {
  const who = tag(l, "audience", audience);
  return productLine
    ? l("ledeLine", { audience: who, line: lineName(l, productLine) })
    : l("lede", { audience: who, highlights: counted(l, "highlight", highlights, locale) });
}

/**
 * The Hero's chips. Hero counts every chip *value* up from zero, so the date
 * rides in a chip's detail — a value of `2026-08-12` animated through 0-08-12.
 */
export function heroChips(l: Label, briefing: BriefingRow, highlights: number, locale: string): HeroChip[] {
  return [
    { label: l("highlights"), value: new Intl.NumberFormat(locale).format(highlights), hue: hueVar("north") },
    {
      label: l("status"),
      value: tag(l, "status", briefing.status),
      hue: hueVar("north"),
      detail: l("written", { date: dayOf(briefing.date, locale) })
    },
    {
      label: l("audience"),
      value: tag(l, "audience", briefing.audience),
      hue: hueVar("north"),
      detail: `${l("language")}: ${l(`lang.${briefing.locale}`)}`
    }
  ];
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const productLine = url.searchParams.get("productLine") ?? "";
  // Carried back from a later step, so walking back lands on the briefing that
  // step was reading rather than whichever is newest.
  const briefingId = url.searchParams.get("briefingId") ?? "";
  // Outside the module shells by design, so an unpermitted reader reaches this
  // loader and only the API refuses. asRouteError turns that into the boundary's
  // "not permitted"; without it production served 500 to tenant.compliance.
  const [page, metrics] = await Promise.all([
    api<{ data: BriefingRow[] }>(`/v1/north/briefings?limit=${BRIEFING_HISTORY_LIMIT}&sort=createdAt&order=desc`, {
      env,
      request
    }).catch(asRouteError),
    // Names and units for the highlights. A reader who may read briefings but
    // not metric definitions still gets the briefing, with humanised keys.
    readable(api<Page<Metric>>(`/v1/north/metrics?limit=${METRICS_LIMIT}`, { env, request }))
  ]);
  // The pick happens in the component: which briefing is readable depends on
  // the reader's locale, and the shell knows that, the loader does not.
  const history = [...page.data].reverse();
  return { briefings: page.data, productLine, briefingId, history, metrics: metrics?.data ?? [] };
}

export default function JourneyNorth({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { briefings, productLine, briefingId, history, metrics } = loaderData;
  const shell = useShellData();
  const locale = shell?.locale ?? DEFAULT_LOCALE;
  const pack = shell?.domainPack;
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, pack);
  const { search } = useLocation();

  const briefing = chosen(briefings, briefingId || null, locale);

  const highlights = highlightsOf(briefing);
  const prose = narrative(briefing?.narrativeRef);
  const byKey = new Map(metrics.map((metric) => [metric.key, metric]));

  const trendCounts = history.map((row) => highlightsOf(row).length);
  const maxTrend = Math.max(1, ...trendCounts);

  const trend: Section = {
    kind: "spark",
    title: l("trend"),
    items: history.map((row, i) => ({
      h: `${Math.max(6, Math.round(((trendCounts[i] ?? 0) / maxTrend) * 100))}%`,
      hue: hueVar("north"),
      label: trendCounts[i] ?? 0
    })),
    from: history[0] ? dayOf(history[0].date, locale) : "",
    mid: history[Math.floor(history.length / 2)] ? dayOf(history[Math.floor(history.length / 2)]!.date, locale) : "",
    to: history[history.length - 1] ? dayOf(history[history.length - 1]!.date, locale) : ""
  };

  const kv: Section = {
    kind: "kv",
    title: l("briefing"),
    items: briefing
      ? [
          { label: l("date"), value: dayOf(briefing.date, locale), hue: "var(--text)", font: "" },
          { label: l("audience"), value: tag(l, "audience", briefing.audience), hue: "var(--text)", font: "" },
          { label: l("status"), value: tag(l, "status", briefing.status), hue: hueVar("north"), font: "" },
          { label: l("language"), value: l(`lang.${briefing.locale}`), hue: "var(--text)", font: "" }
        ]
      : []
  };

  const text: Section = {
    kind: "text",
    title: l("narrative"),
    items: prose ? [{ body: prose }] : []
  };

  const notes: Section = {
    kind: "notes",
    title: l("highlights"),
    items: highlights.map((h) => {
      const metric = byKey.get(h.metricKey);
      const figure = metric ? metricText(h.value, metric.unit, metric.currency, locale) : null;
      const delta = pct(h.deltaBps, locale);
      return {
        hue: hueVar("north"),
        label: metric ? metricName(metric, locale) : humanise(h.metricKey),
        body: h.note ?? [figure, delta].filter(Boolean).join(" · ")
      };
    })
  };

  return (
    <div className="flex flex-col gap-6 pb-12">
      <JourneyNav current="north" locale={locale} pack={pack} t={t} />
      <JourneyHeader step="north" title={l("title")} locale={locale} pack={pack} />
      {/* The briefing's facts and its trend sit beside the hero on a wide
          screen rather than under it, so the first figures are in the first
          screen; narrower, they follow the narrative. */}
      <div
        className={cn(
          "grid items-start gap-6",
          briefing ? "xl:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]" : ""
        )}
      >
        <div className="flex min-w-0 flex-col gap-6">
          <Hero
            eyebrow={l("heroEyebrow")}
            title={
              briefing
                ? lede(l, { productLine, audience: briefing.audience, highlights: highlights.length, locale })
                : l("emptyTitle")
            }
            mod="north"
            {...(briefing ? { hero: { chips: heroChips(l, briefing, highlights.length, locale) } } : {})}
          />
          <ScreenState state={briefing ? "ready" : "empty"} title={l("emptyTitle")} body={l("emptyBody")}>
            <div className="flex flex-col gap-5">
              {prose ? (
                <div className="flex flex-col gap-2">
                  {briefing?.generatedBy === "ai" ? (
                    <div>
                      <AgentBadge agent={l("agentKey.briefing")} why={<p className="text-13">{l("why")}</p>} />
                    </div>
                  ) : null}
                  {renderSection(text, "north")}
                </div>
              ) : null}
              {highlights.length > 0 ? <div>{renderSection(notes, "north")}</div> : null}
            </div>
          </ScreenState>
        </div>
        {briefing ? (
          <div className="flex min-w-0 flex-col gap-5">
            <div>{renderSection(kv, "north")}</div>
            {history.length > 1 ? <div>{renderSection(trend, "north")}</div> : null}
          </div>
        ) : null}
      </div>
      {briefing ? (
        <JourneyContinue to={stepHref("scout", search, { briefingId: briefing.id })} label={l("continue")} />
      ) : null}
    </div>
  );
}

import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, EmptyState, KPIWall, Panel, Sparkline, Stat, type BadgeTone } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { useNorthSessionData } from "./north-shell";
import { labelsFrom, readable, type Labels } from "./north-shared";

// Journey health (docs/06 §3): "every journey has an analytics funnel, an
// owner and a target … journey health surfaces in NORTH". Nothing measured one
// until the funnels were read from the audit log (packages/core/src/
// journey-health.ts). Arithmetic on recorded rows, not a model — no ✦.

/** Mirrors packages/core/src/journey-health.ts `JourneyHealth`. */
export interface JourneyRow {
  id: string;
  persona: string;
  steps: { key: string; count: number }[];
  completion: number | null;
  status: "flowing" | "stalled" | "quiet";
  weekly: number[];
}

export const WINDOWS = [7, 30, 90] as const;

/** Where each journey's work happens, so a stalled funnel is one press from its screen. */
export const JOURNEY_HOME: Record<string, string> = {
  "J-C1": "/distribution/quote-requests",
  "J-C2": "/orbit/console",
  "J-C3": "/axis/renewals",
  "J-C4": "/compliance",
  "J-O1": "/axis/exceptions",
  "J-O2": "/axis/quote-desk",
  "J-O3": "/ledger/recon",
  "J-X1": "/orbit/console",
  "J-X2": "/orbit/save",
  "J-X3": "/orbit/partners",
  "J-M1": "/signal/studio",
  "J-M2": "/signal/budget",
  "J-P1": "/scout/radar",
  "J-P2": "/scout/panel",
  "J-E2": "/north/board",
  "J-E3": "/north/whatif",
  "J-A2": "/admin/staff",
  "J-A3": "/admin/ai/console",
  "J-D1": "/admin/developer",
  "J-CO1": "/compliance"
};

const ORDER = { stalled: 0, flowing: 1, quiet: 2 } as const;

/** Stalled first (something needs a person), then the weakest flowing, then quiet. */
export function ranked(rows: readonly JourneyRow[]): JourneyRow[] {
  return [...rows].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || (a.completion ?? 1) - (b.completion ?? 1) || a.id.localeCompare(b.id)
  );
}

export function statusTone(status: JourneyRow["status"]): BadgeTone {
  return status === "stalled" ? "warning" : status === "flowing" ? "success" : "neutral";
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const asked = Number(new URL(request.url).searchParams.get("days"));
  const days = WINDOWS.find((w) => w === asked) ?? 30;
  const page = await readable(api<{ data: JourneyRow[] }>(`/v1/north/journeys?days=${days}`, { env, request }));
  return { days, journeys: page ? ranked(page.data) : null };
}

const LABELS: Labels = {
  en: {
    kicker: "Journey health",
    "headline.stalled": "{count} journeys started and never finished",
    "headline.stalled.one": "1 journey started and never finished",
    "headline.flowing": "Every journey people started, they finished",
    "headline.quiet": "No journey has moved in this window",
    intro:
      "Each journey the platform is built around, as a funnel read from the audit log: how many times each step happened in the window. Counts, not cohorts — a step is what was done, by anyone.",
    denied: "Journey health needs NORTH's metrics.",
    "window.7": "7 days",
    "window.30": "30 days",
    "window.90": "90 days",
    measured: "Journeys measured",
    flowing: "Flowing",
    stalled: "Stalled",
    quiet: "Quiet",
    "status.flowing": "Flowing",
    "status.stalled": "Stalled",
    "status.quiet": "Quiet",
    completion: "{pct} finish",
    trend: "Finishes per week",
    open: "Open where it happens",
    empty: "Nothing recorded yet",
    "empty.body": "Journeys appear here as people work through them.",
    "J-C1": "Get covered",
    "J-C2": "Get help",
    "J-C3": "Renew in one tap",
    "J-C4": "Exercise privacy rights",
    "J-O1": "Clear exceptions",
    "J-O2": "Group bid",
    "J-O3": "Month-end reconciliation",
    "J-X1": "Catch a handover",
    "J-X2": "Save desk",
    "J-X3": "Partner integration",
    "J-M1": "Campaign in a day",
    "J-M2": "Budget morning",
    "J-P1": "Radar quarterly",
    "J-P2": "Panel negotiation",
    "J-E2": "Board Thursday",
    "J-E3": "What-if",
    "J-A2": "New teammate",
    "J-A3": "Incident pause",
    "J-D1": "First API call",
    "J-CO1": "Regulator request",
    "step.lead": "Asked",
    "step.offers": "Offers shown",
    "step.accepted": "Accepted",
    "step.issued": "Issued",
    "step.asked": "Asked",
    "step.rated": "Rated",
    "step.offered": "Offered",
    "step.renewed": "Renewed",
    "step.requested": "Requested",
    "step.acknowledged": "Acknowledged",
    "step.worked": "Worked",
    "step.failed": "Failed",
    "step.assisted": "Assisted",
    "step.cleared": "Cleared",
    "step.census": "Census in",
    "step.normalised": "Normalised",
    "step.quoted": "Quoted",
    "step.bound": "Bound",
    "step.run": "Run",
    "step.matched": "Matched",
    "step.evidence": "Evidence",
    "step.closed": "Closed",
    "step.escalated": "Escalated",
    "step.scored": "Scored",
    "step.saved": "Saved",
    "step.signed_up": "Signed up",
    "step.checklist": "Checklist",
    "step.mock_quote": "Mock quote",
    "step.live": "Live",
    "step.first_bind": "First bind",
    "step.planned": "Planned",
    "step.measured": "Measured",
    "step.proposed": "Proposed",
    "step.revised": "Revised",
    "step.promoted": "Promoted",
    "step.experiment": "Experiment",
    "step.verdict": "Verdict",
    "step.benched": "Benchmarked",
    "step.pack": "Pack",
    "step.rate": "Rate set",
    "step.assembled": "Assembled",
    "step.read": "Read",
    "step.revisited": "Revisited",
    "step.invited": "Invited",
    "step.roles": "Roles given",
    "step.paused": "Paused",
    "step.resumed": "Resumed",
    "step.key": "Key issued",
    "step.webhook": "Webhook",
    "step.tested": "Tested",
    "step.exported": "Exported",
    "step.delivered": "Delivered"
  },
  ar: {
    kicker: "صحة الرحلات",
    "headline.stalled": "{count} رحلات بدأت ولم تكتمل",
    "headline.stalled.one": "رحلة واحدة بدأت ولم تكتمل",
    "headline.flowing": "كل رحلة بدأها الناس أكملوها",
    "headline.quiet": "لم تتحرك أي رحلة في هذه الفترة",
    intro:
      "كل رحلة بُنيت المنصة حولها، في صورة مسار تحويل مقروء من سجل التدقيق: كم مرة حدثت كل خطوة خلال الفترة. أعداد لا مجموعات — الخطوة هي ما أُنجز، أيًّا كان منجزها.",
    denied: "صحة الرحلات تتطلب مؤشرات الرؤى.",
    "window.7": "7 أيام",
    "window.30": "30 يومًا",
    "window.90": "90 يومًا",
    measured: "رحلات مقاسة",
    flowing: "تتقدم",
    stalled: "متوقفة",
    quiet: "هادئة",
    "status.flowing": "تتقدم",
    "status.stalled": "متوقفة",
    "status.quiet": "هادئة",
    completion: "{pct} اكتمال",
    trend: "الإكمالات أسبوعيًا",
    open: "افتح موضع العمل",
    empty: "لا شيء مسجّل بعد",
    "empty.body": "تظهر الرحلات هنا حين يعمل الناس عليها.",
    "J-C1": "الحصول على تغطية",
    "J-C2": "طلب المساعدة",
    "J-C3": "التجديد بضغطة",
    "J-C4": "ممارسة حقوق الخصوصية",
    "J-O1": "معالجة الاستثناءات",
    "J-O2": "عطاء جماعي",
    "J-O3": "مطابقة نهاية الشهر",
    "J-X1": "استلام تحويل المحادثة",
    "J-X2": "مكتب الاستبقاء",
    "J-X3": "تكامل الشركاء",
    "J-M1": "حملة في يوم",
    "J-M2": "صباح الميزانية",
    "J-P1": "مراجعة الرادار الفصلية",
    "J-P2": "التفاوض مع الجهات",
    "J-E2": "خميس المجلس",
    "J-E3": "ماذا لو",
    "J-A2": "زميل جديد",
    "J-A3": "إيقاف عند حادث",
    "J-D1": "أول استدعاء للواجهة",
    "J-CO1": "طلب جهة تنظيمية",
    "step.lead": "طلب",
    "step.offers": "عُرضت العروض",
    "step.accepted": "قُبل",
    "step.issued": "صدر",
    "step.asked": "سأل",
    "step.rated": "قيّم",
    "step.offered": "عُرض",
    "step.renewed": "جُدّد",
    "step.requested": "طُلب",
    "step.acknowledged": "أُقرّ",
    "step.worked": "عولج",
    "step.failed": "تعثّر",
    "step.assisted": "بمساعدة",
    "step.cleared": "أُنجز",
    "step.census": "استُلم الكشف",
    "step.normalised": "وُحّد",
    "step.quoted": "سُعّر",
    "step.bound": "رُبط",
    "step.run": "شُغّل",
    "step.matched": "طوبق",
    "step.evidence": "الأدلة",
    "step.closed": "أُقفل",
    "step.escalated": "صُعّد",
    "step.scored": "قُيّم",
    "step.saved": "استُبقي",
    "step.signed_up": "سجّل",
    "step.checklist": "قائمة التحقق",
    "step.mock_quote": "تسعير تجريبي",
    "step.live": "مباشر",
    "step.first_bind": "أول ربط",
    "step.planned": "خُطّط",
    "step.measured": "قيس",
    "step.proposed": "اقتُرح",
    "step.revised": "عُدّل",
    "step.promoted": "رُقّي",
    "step.experiment": "تجربة",
    "step.verdict": "الحكم",
    "step.benched": "قورن",
    "step.pack": "الحزمة",
    "step.rate": "حُدّد السعر",
    "step.assembled": "جُمع",
    "step.read": "قُرئ",
    "step.revisited": "رُوجع",
    "step.invited": "دُعي",
    "step.roles": "مُنحت الأدوار",
    "step.paused": "أُوقف",
    "step.resumed": "استؤنف",
    "step.key": "صدر المفتاح",
    "step.webhook": "خطاف ويب",
    "step.tested": "اختُبر",
    "step.exported": "صُدّر",
    "step.delivered": "سُلّم"
  }
};

export const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

export function headline(rows: readonly JourneyRow[], l: (key: string, vars?: Record<string, string>) => string): string {
  const stalled = rows.filter((row) => row.status === "stalled").length;
  if (stalled === 1) return l("headline.stalled.one");
  if (stalled > 1) return l("headline.stalled", { count: String(stalled) });
  return rows.some((row) => row.status === "flowing") ? l("headline.flowing") : l("headline.quiet");
}

export default function NorthJourneys() {
  const { days, journeys } = useLoaderData<typeof loader>();
  const shell = useNorthSessionData();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const percent = (value: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(value);

  if (journeys === null) return <EmptyState title={l("kicker")} body={l("denied")} />;
  const count = (status: JourneyRow["status"]) => journeys.filter((row) => row.status === status).length;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <span className="eyebrow">{l("kicker")}</span>
          <h1 className="page-title">{headline(journeys, l)}</h1>
          <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        </div>
        <nav aria-label={l("kicker")} className="flex gap-1">
          {WINDOWS.map((window) => (
            <Link
              key={window}
              to={`?days=${window}`}
              aria-current={window === days ? "page" : undefined}
              className="rounded-orbit border border-border px-3 py-1 font-ui text-12 text-muted hover:text-text aria-[current=page]:border-accent-line aria-[current=page]:bg-accent/10 aria-[current=page]:text-accent"
            >
              {l(`window.${window}`)}
            </Link>
          ))}
        </nav>
      </header>

      <KPIWall>
        <Stat label={l("measured")} value={number(journeys.length)} />
        <Stat label={l("flowing")} value={number(count("flowing"))} />
        <Stat label={l("stalled")} value={number(count("stalled"))} />
        <Stat label={l("quiet")} value={number(count("quiet"))} />
      </KPIWall>

      {journeys.length === 0 ? (
        <EmptyState title={l("empty")} body={l("empty.body")} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {journeys.map((journey) => {
            const first = journey.steps[0]?.count ?? 0;
            return (
              <li key={journey.id}>
                <Panel className="h-full">
                  <div className="flex flex-col gap-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="font-mono text-12 text-subtle">{journey.id}</span>
                        <h2 className="section-title">{l(journey.id)}</h2>
                      </div>
                      <Badge tone={statusTone(journey.status)} size="sm" dot>
                        {l(`status.${journey.status}`)}
                      </Badge>
                    </div>

                    {/* The funnel: each step's count, and a bar as wide as its
                        share of the first step — the drop is the story. */}
                    <ol className="flex flex-col gap-1.5">
                      {journey.steps.map((step) => (
                        <li key={step.key} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2">
                          <span className="truncate font-ui text-12 text-muted">{l(`step.${step.key}`)}</span>
                          <span className="h-2 overflow-hidden rounded-orbit bg-surface-3" aria-hidden="true">
                            <span
                              className="block h-full rounded-orbit bg-accent"
                              style={{ width: `${first ? Math.min(100, (step.count / first) * 100) : 0}%` }}
                            />
                          </span>
                          <span className="text-end font-mono text-12 tabular-nums text-text">{number(step.count)}</span>
                        </li>
                      ))}
                    </ol>

                    <div className="flex items-end justify-between gap-4">
                      <div className="flex flex-col gap-1">
                        <span className="font-ui text-13 text-text">
                          {journey.completion === null ? "—" : l("completion", { pct: percent(journey.completion) })}
                        </span>
                        <Link
                          to={JOURNEY_HOME[journey.id] ?? "/"}
                          className="whitespace-nowrap font-ui text-12 text-accent underline underline-offset-4"
                        >
                          {l("open")}
                        </Link>
                      </div>
                      <Sparkline values={journey.weekly} label={`${l(journey.id)} — ${l("trend")}`} className="h-7 w-32 shrink-0" />
                    </div>
                  </div>
                </Panel>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

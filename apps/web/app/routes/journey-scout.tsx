import { AgentBadge, Badge, Hero, ScreenState, cn, focusRing, renderSection, hueVar, type Section } from "@lyra/ui";
import { Link, useLocation, type LoaderFunctionArgs } from "react-router";
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
import { tag, type Label } from "./detail-kit";
import { readable } from "./north-shared";
import { useShellData } from "./workspace";

/**
 * One element of GET /v1/scout/whitespaces/commentary — mirrors
 * `WhitespaceCommentary` in apps/api/src/engines/scout-whitespace.ts (the same
 * payload components/whitespace-commentary.tsx reads).
 */
interface WhitespaceCommentary {
  whitespaceId: string;
  category: string | null;
  status: string;
  commentary: string | null;
  why: string[];
  /** Null when the sentence is the deterministic fallback — no ✦ then. */
  ai: { marker: string; auditId: string; model: string; provider: string; tier: string; at: number } | null;
  suppressed: boolean;
}

/** The fields of a `north_briefings` row this step says anything about. */
interface BriefingRef {
  id: string;
  date: string;
  audience: string;
}

interface CategoryGroup {
  key: string;
  count: number;
}

const COMMENTARY_LIMIT = 50;
const CHOICES = 12;

const LABELS = {
  en: {
    title: "Where the market has gaps",
    heroEyebrow: "Open whitespace",
    "item.one": "{n} open whitespace item",
    "item.other": "{n} open whitespace items",
    "grouping.one": "{n} grouping",
    "grouping.other": "{n} groupings",
    lede: "{items} across {groupings}.",
    ledeLine: "{items}, those filed under {line} first.",
    ledeNoMatch: "{items}. None is filed under {line}, so they are ranked as they came.",
    fromBriefing: "Carried from the {date} briefing for {audience}.",
    open: "Open whitespace",
    share: "{pct} of open whitespace",
    byStatus: "Uncategorised, {status}",
    radar: "Whitespace opportunity by grouping",
    xlab: "Rarer, so more opportunity",
    ylab: "Commentary coverage",
    choose: "Choose a gap to act on",
    chooseHint: "The campaign in the next step is drafted against the one you choose.",
    chosen: "Chosen",
    matches: "Matches {line}",
    why: "Why this is whitespace",
    model: "Model: {model}",
    noCommentary: "No commentary on this one yet.",
    "status.candidate": "Candidate",
    "status.validating": "Validating",
    "status.validated": "Validated",
    "status.parked": "Parked",
    emptyTitle: "No whitespace yet",
    emptyBody: "Market has not surfaced any whitespace with commentary yet.",
    continue: "Draft a campaign for {subject}"
  },
  ar: {
    title: "أين توجد فجوات السوق",
    heroEyebrow: "الفراغ السوقي المفتوح",
    "item.zero": "لا عناصر فراغ سوقي مفتوحة",
    "item.one": "عنصر فراغ سوقي مفتوح واحد",
    "item.two": "عنصرا فراغ سوقي مفتوحان",
    "item.few": "{n} عناصر فراغ سوقي مفتوحة",
    "item.many": "{n} عنصر فراغ سوقي مفتوح",
    "item.other": "{n} عنصر فراغ سوقي مفتوح",
    "grouping.zero": "لا مجموعات",
    "grouping.one": "مجموعة واحدة",
    "grouping.two": "مجموعتان",
    "grouping.few": "{n} مجموعات",
    "grouping.many": "{n} مجموعة",
    "grouping.other": "{n} مجموعة",
    lede: "{items} عبر {groupings}.",
    ledeLine: "{items}، وأولها ما يندرج تحت {line}.",
    ledeNoMatch: "{items}. لا شيء منها يندرج تحت {line}، لذا رُتّبت كما وردت.",
    fromBriefing: "منقول من موجز {date} لـ{audience}.",
    open: "الفراغ السوقي المفتوح",
    share: "{pct} من الفراغ السوقي المفتوح",
    byStatus: "غير مصنّف، {status}",
    radar: "فرص الفراغ السوقي حسب المجموعة",
    xlab: "أندر، أي فرصة أكبر",
    ylab: "تغطية التعليقات",
    choose: "اختر فجوة للعمل عليها",
    chooseHint: "تُصاغ الحملة في الخطوة التالية بناءً على ما تختاره.",
    chosen: "المختار",
    matches: "يطابق {line}",
    why: "لماذا يُعدّ هذا فراغًا سوقيًا",
    model: "النموذج: {model}",
    noCommentary: "لا يوجد تعليق على هذا بعد.",
    "status.candidate": "مرشّح",
    "status.validating": "قيد التحقق",
    "status.validated": "متحقَّق منه",
    "status.parked": "مؤجَّل",
    emptyTitle: "لا يوجد فراغ سوقي بعد",
    emptyBody: "لم يُظهر السوق أي فراغ سوقي مع تعليق بعد.",
    continue: "صِغ حملة لـ{subject}"
  }
};

export const labelsIn = journeyLabels(LABELS);

export function matchesLine(category: string | null, productLine: string): boolean {
  if (!category || !productLine) return false;
  const a = category.toLowerCase();
  const b = productLine.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/** The carried product line's whitespace first; otherwise the order the API gave. */
export function rankForLine<T extends Pick<WhitespaceCommentary, "category">>(rows: T[], productLine: string): T[] {
  return [...rows].sort(
    (a, b) => Number(matchesLine(b.category, productLine)) - Number(matchesLine(a.category, productLine))
  );
}

/** The whitespace the reader chose (`?whitespaceId=`), else the top-ranked one. */
export function pickWhitespace<T extends Pick<WhitespaceCommentary, "whitespaceId">>(rows: T[], id: string): T | null {
  return rows.find((row) => row.whitespaceId === id) ?? rows[0] ?? null;
}

function groupKey(row: WhitespaceCommentary): string {
  return row.category ?? `status:${row.status}`;
}

function groupLabel(l: Label, key: string): string {
  return key.startsWith("status:") ? l("byStatus", { status: tag(l, "status", key.slice("status:".length)) }) : key;
}

function groupByCategory(rows: WhitespaceCommentary[]): CategoryGroup[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = groupKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const productLine = url.searchParams.get("productLine") ?? "";
  const briefingId = url.searchParams.get("briefingId") ?? "";
  const chosenId = url.searchParams.get("whitespaceId") ?? "";
  // Outside the module shells by design, so an unpermitted reader reaches this
  // loader and only the API refuses. asRouteError turns that into the boundary's
  // "not permitted"; without it production served 500 to north.exec.
  const [page, briefing] = await Promise.all([
    api<{ data: WhitespaceCommentary[] }>(`/v1/scout/whitespaces/commentary?limit=${COMMENTARY_LIMIT}`, {
      env,
      request
    }).catch(asRouteError),
    // The briefing the previous step handed over. A reader who may read
    // whitespace but not briefings still walks on; the line just goes unsaid.
    briefingId
      ? readable(api<BriefingRef>(`/v1/north/briefings/${encodeURIComponent(briefingId)}`, { env, request }))
      : Promise.resolve(null)
  ]);
  const rows = rankForLine(
    page.data.filter((r) => !r.suppressed),
    productLine
  );
  return { rows, productLine, chosenId, briefing };
}

export default function JourneyScout({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { rows, productLine, chosenId, briefing } = loaderData;
  const shell = useShellData();
  const locale = shell?.locale ?? DEFAULT_LOCALE;
  const pack = shell?.domainPack;
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, pack);
  const { search } = useLocation();
  const chosen = pickWhitespace(rows, chosenId);
  const groups = groupByCategory(rows);
  const maxCount = Math.max(1, ...groups.map((g) => g.count));
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat(locale);
  const items = counted(l, "item", rows.length, locale);
  const anyMatch = rows.some((row) => matchesLine(row.category, productLine));
  const line = productLine ? lineName(l, productLine) : "";

  const lede = [
    productLine
      ? l(anyMatch ? "ledeLine" : "ledeNoMatch", { items, line })
      : l("lede", { items, groupings: counted(l, "grouping", groups.length, locale) }),
    briefing ? l("fromBriefing", { date: dayOf(briefing.date, locale), audience: tag(l, "audience", briefing.audience) }) : ""
  ]
    .filter(Boolean)
    .join(" ");

  const quadrant: Section = {
    kind: "radar",
    title: l("radar"),
    xlab: l("xlab"),
    ylab: l("ylab"),
    items: groups.map((g) => {
      const inCategory = rows.filter((r) => groupKey(r) === g.key);
      const covered = inCategory.filter((r) => r.commentary).length;
      const rarity = 100 - Math.round((g.count / maxCount) * 100);
      const coverage = Math.round((covered / g.count) * 100);
      return {
        label: `${groupLabel(l, g.key)} (${num.format(g.count)})`,
        x: `${Math.min(92, Math.max(4, rarity))}%`,
        y: `${Math.min(92, Math.max(4, coverage))}%`,
        size: `${Math.max(14, Math.round((g.count / maxCount) * 40))}px`,
        trail: hueVar("scout"),
        hue: hueVar("scout")
      };
    })
  };

  const subject = chosen ? (chosen.category ?? groupLabel(l, groupKey(chosen))) : "";

  return (
    <div className="flex flex-col gap-6 pb-12">
      <JourneyNav current="scout" locale={locale} pack={pack} t={t} />
      <JourneyHeader step="scout" title={l("title")} locale={locale} pack={pack} />
      {/* The gaps to choose from sit beside the hero and its radar on a wide
          screen rather than under both, so the list this step exists for is in
          the first screen; narrower, it follows the radar as before. */}
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,28rem)]">
        <div className="flex min-w-0 flex-col gap-6">
          <Hero
            eyebrow={l("heroEyebrow")}
            title={lede}
            mod="scout"
            {...(rows.length > 0
              ? {
                  hero: {
                    chips: [
                      { label: l("open"), value: num.format(rows.length), hue: hueVar("scout") },
                      ...groups.map((g) => ({
                        label: groupLabel(l, g.key),
                        value: num.format(g.count),
                        hue: hueVar("scout"),
                        detail: l("share", { pct: pct.format(g.count / rows.length) })
                      }))
                    ]
                  }
                }
              : {})}
          />
          {groups.length > 1 ? <div>{renderSection(quadrant, "scout")}</div> : null}
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <ScreenState state={rows.length === 0 ? "empty" : "ready"} title={l("emptyTitle")} body={l("emptyBody")}>
            <div className="flex flex-col gap-5">
              <section aria-labelledby="journey-scout-choose" className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h2 id="journey-scout-choose" className="section-title">
                    {l("choose")}
                  </h2>
                  <p className="text-13 text-subtle">{l("chooseHint")}</p>
                </div>
                <ul className="flex flex-col gap-2">
                  {rows.slice(0, CHOICES).map((row) => {
                    const here = row.whitespaceId === chosen?.whitespaceId;
                    return (
                      <li key={row.whitespaceId}>
                        <Link
                          to={stepHref("scout", search, { whitespaceId: row.whitespaceId })}
                          replace
                          preventScrollReset
                          aria-current={here ? "true" : undefined}
                          className={cn(
                            "flex flex-col gap-1 rounded-md border p-3 text-start",
                            focusRing,
                            here ? "border-accent-line bg-accent-soft" : "border-border bg-surface-1 hover:bg-surface-2"
                          )}
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="text-14 font-medium text-text">{groupLabel(l, groupKey(row))}</span>
                            <Badge tone="neutral" size="sm">
                              {tag(l, "status", row.status)}
                            </Badge>
                            {matchesLine(row.category, productLine) ? (
                              <Badge tone="accent" size="sm">
                                {l("matches", { line })}
                              </Badge>
                            ) : null}
                            {here ? (
                              <Badge tone="success" size="sm">
                                {l("chosen")}
                              </Badge>
                            ) : null}
                          </span>
                          <span className="text-13 text-subtle">{row.commentary ?? l("noCommentary")}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>

              {chosen && chosen.why.length > 0 ? (
                <section aria-labelledby="journey-scout-why" className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 id="journey-scout-why" className="section-title">
                      {l("why")}
                    </h2>
                    {chosen.ai ? (
                      <AgentBadge
                        agent={l("agentKey.discovery")}
                        why={
                          <div className="flex flex-col gap-1 text-13">
                            <ul className="flex flex-col gap-1">
                              {chosen.why.map((reason, i) => (
                                <li key={i}>{reason}</li>
                              ))}
                            </ul>
                            <p className="text-subtle">{l("model", { model: chosen.ai.model })}</p>
                          </div>
                        }
                      />
                    ) : null}
                  </div>
                  <ol className="flex flex-col gap-1">
                    {chosen.why.map((reason, i) => (
                      <li key={i} className="text-13 text-text">
                        {reason}
                      </li>
                    ))}
                  </ol>
                </section>
              ) : null}
            </div>
          </ScreenState>
        </div>
      </div>
      {chosen ? (
        <JourneyContinue
          to={stepHref("signal", search, { whitespaceId: chosen.whitespaceId, subject })}
          label={l("continue", { subject })}
        />
      ) : null}
    </div>
  );
}

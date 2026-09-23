import { Hero, ScreenState, formatMoney, renderSection, hueVar, type Section } from "@lyra/ui";
import { useLocation, type LoaderFunctionArgs } from "react-router";
import { api, asRouteError } from "../api.server";
import { cloudflare } from "../context";
import {
  JourneyContinue,
  JourneyHeader,
  JourneyNav,
  counted,
  journeyLabels,
  lineName,
  stepHref
} from "../components/journey-nav";
import { translator, DEFAULT_LOCALE } from "../i18n";
import type { Label } from "./detail-kit";
import { useShellData } from "./workspace";

interface CaseRow {
  id: string;
  ref: string;
  productLine: string;
  status: string;
  priority: string;
  valueMinor: number;
  currency: string;
}

interface ProductLineTotal {
  productLine: string;
  total: number;
  count: number;
  currency: string;
}

const CASES_LIMIT = 200;
const HERO_GROUPS = 6;

const LABELS = {
  en: {
    title: "What the business is trading, line by line",
    heroEyebrow: "The open case book",
    "case.one": "{n} case",
    "case.other": "{n} cases",
    "productLine.one": "{n} product line",
    "productLine.other": "{n} product lines",
    summary: "{cases} across {lines}.",
    total: "Total book value",
    totalMixed: "Book value in {currency}",
    share: "{cases}, {pct} of book value",
    bars: "Book value by product line",
    emptyTitle: "No cases yet",
    emptyBody: "Operations has no open cases to group yet.",
    continue: "See the insight on {line}"
  },
  ar: {
    title: "ما يتداوله العمل، خطًا بخط",
    heroEyebrow: "دفتر الحالات المفتوحة",
    "case.zero": "لا حالات",
    "case.one": "حالة واحدة",
    "case.two": "حالتان",
    "case.few": "{n} حالات",
    "case.many": "{n} حالة",
    "case.other": "{n} حالة",
    "productLine.zero": "لا خطوط منتجات",
    "productLine.one": "خط منتج واحد",
    "productLine.two": "خطا منتج",
    "productLine.few": "{n} خطوط منتجات",
    "productLine.many": "{n} خط منتج",
    "productLine.other": "{n} خط منتج",
    summary: "{cases} عبر {lines}.",
    total: "إجمالي قيمة المحفظة",
    totalMixed: "قيمة المحفظة بعملة {currency}",
    share: "{cases}، {pct} من قيمة المحفظة",
    bars: "قيمة المحفظة حسب خط المنتج",
    emptyTitle: "لا توجد حالات بعد",
    emptyBody: "لا توجد لدى العمليات حالات مفتوحة لتجميعها بعد.",
    continue: "اطّلع على الرؤى بشأن {line}"
  }
};

export const labelsIn = journeyLabels(LABELS);

export function groupByProductLine(cases: CaseRow[]): ProductLineTotal[] {
  const byLine = new Map<string, ProductLineTotal>();
  for (const c of cases) {
    const line = c.productLine || "unassigned";
    const existing = byLine.get(line);
    if (existing) {
      existing.total += c.valueMinor;
      existing.count += 1;
    } else {
      byLine.set(line, { productLine: line, total: c.valueMinor, count: 1, currency: c.currency });
    }
  }
  return [...byLine.values()].sort((a, b) => b.total - a.total);
}

/**
 * The book's value in the leading line's currency. Two currencies are never
 * summed into one figure; `mixed` says the headline leaves some lines out.
 */
export function bookValue(lines: ProductLineTotal[]): { total: number; currency: string; mixed: boolean } | null {
  const top = lines[0];
  if (!top) return null;
  const same = lines.filter((line) => line.currency === top.currency);
  return {
    total: same.reduce((sum, line) => sum + line.total, 0),
    currency: top.currency,
    mixed: same.length !== lines.length
  };
}

/** "12 cases across 3 product lines." in the reader's plural forms. */
export function summary(l: Label, cases: number, lines: number, locale: string): string {
  return l("summary", { cases: counted(l, "case", cases, locale), lines: counted(l, "productLine", lines, locale) });
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  // A journey route sits outside the module shells on purpose, so every signed-in
  // reader reaches this loader and the API is the only thing that says no. Without
  // asRouteError an ApiError is a crash: production served 500 "could not build the
  // page" to north.exec and tenant.compliance on /journey/axis.
  const page = await api<{ data: CaseRow[] }>(
    `/v1/axis/cases?limit=${CASES_LIMIT}&sort=valueMinor&order=desc`,
    { env, request }
  ).catch(asRouteError);
  const lines = groupByProductLine(page.data);
  return { lines, caseCount: page.data.length };
}

export default function JourneyAxis({ loaderData }: { loaderData: Awaited<ReturnType<typeof loader>> }) {
  const { lines, caseCount } = loaderData;
  const shell = useShellData();
  const locale = shell?.locale ?? DEFAULT_LOCALE;
  const pack = shell?.domainPack;
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, pack);
  const { search } = useLocation();
  const top = lines[0] ?? null;
  const maxTotal = top?.total ?? 1;
  const book = bookValue(lines);
  const pct = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const shareOf = (line: ProductLineTotal) =>
    book && line.currency === book.currency && book.total > 0 ? line.total / book.total : null;

  const bars: Section = {
    kind: "bars",
    title: l("bars"),
    items: lines.map((line) => ({
      label: lineName(l, line.productLine),
      value: formatMoney(line.total, line.currency, locale),
      w: `${Math.max(4, Math.round((line.total / maxTotal) * 100))}%`,
      hue: hueVar("axis"),
      note: counted(l, "case", line.count, locale)
    }))
  };

  return (
    <div className="flex flex-col gap-6 pb-12">
      <JourneyNav current="axis" locale={locale} pack={pack} t={t} />
      <JourneyHeader step="axis" title={l("title")} locale={locale} pack={pack} />
      <Hero
        eyebrow={l("heroEyebrow")}
        title={summary(l, caseCount, lines.length, locale)}
        mod="axis"
        {...(book
          ? {
              hero: {
                chips: [
                  {
                    label: book.mixed ? l("totalMixed", { currency: book.currency }) : l("total"),
                    value: formatMoney(book.total, book.currency, locale),
                    hue: hueVar("axis")
                  },
                  ...lines.slice(0, HERO_GROUPS).map((line) => {
                    const share = shareOf(line);
                    const cases = counted(l, "case", line.count, locale);
                    return {
                      label: lineName(l, line.productLine),
                      value: formatMoney(line.total, line.currency, locale),
                      hue: hueVar("axis"),
                      detail: share === null ? cases : l("share", { cases, pct: pct.format(share) })
                    };
                  })
                ]
              }
            }
          : {})}
      />
      <ScreenState state={lines.length === 0 ? "empty" : "ready"} title={l("emptyTitle")} body={l("emptyBody")}>
        <div className="flex flex-col gap-5">
          <div>{renderSection(bars, "axis")}</div>
        </div>
      </ScreenState>
      {top ? (
        <JourneyContinue
          to={stepHref("north", search, { productLine: top.productLine })}
          label={l("continue", { line: lineName(l, top.productLine) })}
        />
      ) : null}
    </div>
  );
}

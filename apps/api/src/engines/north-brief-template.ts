import { displayValue, type BriefingSnapshot, type SnapshotMetric, type Unit } from "@lyra/core";

// J-E1, docs/06 "the 7am read". The morning brief must exist every morning,
// including on a deployment with no model (local, on-prem) and through a
// provider outage. This is the floor under the narrator (engines/narrator.ts):
// a fixed template over the same snapshot the model would have read, plus the
// open anomalies. Every figure is read straight off a stored value, so there is
// nothing for verifyNumericClaims to catch; and it is not an AI artifact, so the
// row says `generatedBy: "template"` and the screen gives it no ✦ (docs/15).
//
// Pure and DB-free: narrator.ts reads the rows, this writes the words. The
// template nouns are generic ("metric", "anomaly", "period") on purpose —
// industry nouns arrive only through the tenant's own metric names
// (CLAUDE.md §14).

export const TEMPLATE_LOCALES = ["en", "ar"] as const;
export type TemplateLocale = (typeof TEMPLATE_LOCALES)[number];

/** The catalogue a brief is written from: the locale's own, else English. */
export function templateLocale(locale: string): TemplateLocale {
  return (TEMPLATE_LOCALES as readonly string[]).includes(locale) ? (locale as TemplateLocale) : "en";
}

export interface TemplateMetric {
  name: string;
  unit: Unit;
  currency: string | null;
}

export interface TemplateAnomaly {
  metricKey: string;
  window: string;
  magnitude: number;
  expected: number | null;
  actual: number | null;
}

type Key =
  | "lead"
  | "leadFlat"
  | "none"
  | "metric"
  | "metricDelta"
  | "up"
  | "down"
  | "anomaliesNone"
  | "anomaliesCount"
  | "anomaly"
  | "anomalyUnknown";

// Phrased so no count needs a plural form — Arabic has six, and a template
// that guesses one is wrong for most numbers.
const STRINGS: Record<TemplateLocale, Record<Key, string>> = {
  en: {
    lead: "The largest move was {metric}: {value} for {period}, {direction} {change} on the period before.",
    leadFlat: "Metrics closed for this brief: {count}. None has a prior period to compare against yet.",
    none: "No metric has closed for this date yet, so there is nothing to report.",
    metric: "{metric} for {period}: {value}, with no prior period to compare.",
    metricDelta: "{metric} for {period}: {value}, {direction} {change} on {previous}.",
    up: "up",
    down: "down",
    anomaliesNone: "No anomaly is open.",
    anomaliesCount: "Open anomalies waiting for an owner: {count}.",
    anomaly: "{metric} over {window}: expected {expected}, actual {actual}.",
    anomalyUnknown: "{metric} over {window}: a deviation of {change}."
  },
  ar: {
    lead: "أكبر تحرك كان في {metric}: {value} عن {period}، {direction} {change} مقارنة بالفترة السابقة.",
    leadFlat: "مؤشرات أُغلقت لهذه الإحاطة: {count}. لا يملك أيٌّ منها فترة سابقة للمقارنة بعد.",
    none: "لم يُغلق أي مؤشر لهذا التاريخ بعد، فلا شيء يُبلَّغ عنه.",
    metric: "{metric} عن {period}: {value}، بلا فترة سابقة للمقارنة.",
    metricDelta: "{metric} عن {period}: {value}، {direction} {change} مقارنة بـ {previous}.",
    up: "بارتفاع",
    down: "بانخفاض",
    anomaliesNone: "لا يوجد انحراف مفتوح.",
    anomaliesCount: "انحرافات مفتوحة بانتظار مسؤول: {count}.",
    anomaly: "{metric} خلال {window}: المتوقع {expected}، والفعلي {actual}.",
    anomalyUnknown: "{metric} خلال {window}: انحراف بنسبة {change}."
  }
};

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/** A stored value as a reader writes it in `locale`: minor units and basis points never reach the prose. */
export function formatValue(raw: number, unit: Unit, currency: string | null, locale: string): string {
  const v = displayValue({ unit, value: raw });
  switch (unit) {
    case "percent":
    case "ratio":
      return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(v / 100);
    case "money":
      if (currency) {
        try {
          return new Intl.NumberFormat(locale, {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          }).format(v);
        } catch {
          // An unrecognised code is stored data, not a reason to lose the brief.
        }
      }
      return new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
    case "duration_ms":
      return new Intl.NumberFormat(locale, { style: "unit", unit: "millisecond", maximumFractionDigits: 0 }).format(v);
    default:
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(v);
  }
}

/** A day (YYYY-MM-DD) or month (YYYY-MM) period in the reader's calendar words; anything else as stored. */
export function formatPeriod(period: string, locale: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const at = Date.parse(`${period}T00:00:00Z`);
    if (Number.isFinite(at)) return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at);
  }
  if (/^\d{4}-\d{2}$/.test(period)) {
    const at = Date.parse(`${period}-01T00:00:00Z`);
    if (Number.isFinite(at)) {
      return new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", timeZone: "UTC" }).format(at);
    }
  }
  return period;
}

function change(bps: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(Math.abs(bps) / 10_000);
}

export interface ComposeInput {
  snapshot: BriefingSnapshot;
  /** Open, unowned anomalies; the three largest are named. */
  anomalies: readonly TemplateAnomaly[];
  /** Every metric definition by key, with its name already in `locale`. */
  metrics: ReadonlyMap<string, TemplateMetric>;
  locale: string;
}

/**
 * The brief as paragraphs separated by a blank line — the shape the brief
 * screen splits on (`paragraphs()`), with the lead sentence first so it can
 * headline the page.
 */
export function composeTemplateBrief({ snapshot, anomalies, metrics, locale }: ComposeInput): string {
  const s = STRINGS[templateLocale(locale)];
  const n = (value: number) => new Intl.NumberFormat(locale).format(value);
  const direction = (bps: number) => (bps >= 0 ? s.up : s.down);
  const value = (m: SnapshotMetric) => formatValue(m.value, m.unit, m.currency, locale);

  const moved = snapshot.metrics
    .filter((m) => m.deltaBps !== null)
    .sort((a, b) => Math.abs(b.deltaBps!) - Math.abs(a.deltaBps!));
  const top = moved[0];

  const lead = top
    ? fill(s.lead, {
        metric: top.name,
        value: value(top),
        period: formatPeriod(top.period, locale),
        direction: direction(top.deltaBps!),
        change: change(top.deltaBps!, locale)
      })
    : snapshot.metrics.length
      ? fill(s.leadFlat, { count: n(snapshot.metrics.length) })
      : s.none;

  const body = snapshot.metrics
    .map((m) =>
      m.deltaBps === null || m.previousPeriod === null
        ? fill(s.metric, { metric: m.name, period: formatPeriod(m.period, locale), value: value(m) })
        : fill(s.metricDelta, {
            metric: m.name,
            period: formatPeriod(m.period, locale),
            value: value(m),
            direction: direction(m.deltaBps),
            change: change(m.deltaBps, locale),
            previous: formatPeriod(m.previousPeriod, locale)
          })
    )
    .join(" ");

  const named = [...anomalies].sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude)).slice(0, 3);
  const open = anomalies.length
    ? [
        fill(s.anomaliesCount, { count: n(anomalies.length) }),
        ...named.map((a) => {
          const metric = metrics.get(a.metricKey);
          const vars = { metric: metric?.name ?? a.metricKey, window: formatPeriod(a.window, locale) };
          return a.expected !== null && a.actual !== null && metric
            ? fill(s.anomaly, {
                ...vars,
                expected: formatValue(a.expected, metric.unit, metric.currency, locale),
                actual: formatValue(a.actual, metric.unit, metric.currency, locale)
              })
            : fill(s.anomalyUnknown, { ...vars, change: change(a.magnitude, locale) });
        })
      ].join(" ")
    : s.anomaliesNone;

  return [lead, body, open].filter(Boolean).join("\n\n");
}

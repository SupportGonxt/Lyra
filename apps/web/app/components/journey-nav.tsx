import { Link, useLocation } from "react-router";
import { Button, cn, focusRing, hueVar } from "@lyra/ui";
import type { Translate } from "../i18n";
import { humanise } from "../modules/spec";
import { labelsFrom, type Label } from "../routes/detail-kit";

// The flagship demo journey (Operations -> Insight -> Market -> Marketing, the
// AXIS/NORTH/SCOUT/SIGNAL modules, docs/28 §2) is four real, API-backed routes
// (routes/journey-*.tsx), not fixture screens. This is the chrome all four
// share: where you are, a way back to any step with the context intact, the
// one page heading, and the link forward carrying what each step refined.
//
// Steps are named the way the module rail names them (`nav.axis` … in the
// shell catalogue): a reader never sees a module codename anywhere else, so
// the journey must not be the one place that prints "AXIS".

export const STEPS = ["axis", "north", "scout", "signal"] as const;
export type JourneyStep = (typeof STEPS)[number];

/**
 * Each step's address, written out whole: routing.reachable.test.ts holds every
 * `/journey/*` claim in HIDDEN_ROUTES to a literal link somewhere in the app,
 * and a path assembled from `/journey/${step}` is one no guard can see.
 */
const PATHS: Record<JourneyStep, string> = {
  axis: "/journey/axis",
  north: "/journey/north",
  scout: "/journey/scout",
  signal: "/journey/signal"
};

/**
 * What the journey learns hop by hop, in the order it learns it: Operations
 * names a product line, Insight a briefing, Market a whitespace and the subject
 * the campaign is about. Every link inside the journey carries all of it, so a
 * reader who steps back to Market from Marketing lands on the whitespace they
 * chose rather than on the default.
 */
export const CONTEXT_KEYS = ["productLine", "briefingId", "whitespaceId", "subject"] as const;
export type ContextKey = (typeof CONTEXT_KEYS)[number];

type Labels = Record<string, Record<string, string>>;

const JOURNEY: Labels = {
  en: {
    "step.axis": "Operations",
    "step.axis.detail": "Transactions",
    "step.north": "Insight",
    "step.north.detail": "Briefing",
    "step.scout": "Market",
    "step.scout.detail": "Whitespace",
    "step.signal": "Marketing",
    "step.signal.detail": "Campaign",
    stepOf: "Step {n} of {total}",
    // Product lines are tenant data; these are the ones a reader is most likely
    // to meet, and anything else is humanised rather than printed as a slug.
    "line.motor": "Motor",
    "line.home": "Home",
    "line.health": "Health",
    "line.travel": "Travel",
    "line.life": "Life",
    "line.unassigned": "No product line",
    // Who a briefing is written for (north_briefings.audience); two steps say it.
    "audience.exec": "Executives",
    "audience.board": "The board",
    "audience.investor": "Investors"
  },
  ar: {
    "step.axis": "العمليات",
    "step.axis.detail": "المعاملات",
    "step.north": "التحليلات التنفيذية",
    "step.north.detail": "الموجز",
    "step.scout": "السوق",
    "step.scout.detail": "الفراغ السوقي",
    "step.signal": "التسويق",
    "step.signal.detail": "الحملة",
    stepOf: "الخطوة {n} من {total}",
    "line.motor": "السيارات",
    "line.home": "المنازل",
    "line.health": "الصحة",
    "line.travel": "السفر",
    "line.life": "الحياة",
    "line.unassigned": "بلا خط منتج",
    "audience.exec": "التنفيذيون",
    "audience.board": "مجلس الإدارة",
    "audience.investor": "المستثمرون"
  }
};

/**
 * A journey route's resolver: its own table first, then the journey's shared
 * words, then everything `labelsFrom` already falls through to (the domain
 * pack, the shared detail vocabulary, the `common.*` catalogue).
 */
export function journeyLabels(own: Labels) {
  const merged: Labels = {};
  for (const locale of new Set([...Object.keys(JOURNEY), ...Object.keys(own)])) {
    merged[locale] = { ...JOURNEY[locale], ...own[locale] };
  }
  return labelsFrom(merged);
}

/** The journey's context out of a query string, empty values dropped. */
export function journeyContext(search: string | URLSearchParams): URLSearchParams {
  const from = typeof search === "string" ? new URLSearchParams(search) : search;
  const out = new URLSearchParams();
  for (const key of CONTEXT_KEYS) {
    const value = from.get(key);
    if (value) out.set(key, value);
  }
  return out;
}

/**
 * The address of one step, carrying the current context. `set` refines it on
 * the way: a value replaces what was carried, `null` or "" drops it.
 */
export function stepHref(
  step: JourneyStep,
  search: string | URLSearchParams,
  set: Partial<Record<ContextKey, string | null>> = {}
): string {
  const context = journeyContext(search);
  for (const key of CONTEXT_KEYS) {
    if (!(key in set)) continue;
    const value = set[key];
    if (value) context.set(key, value);
    else context.delete(key);
  }
  // Re-emit in the documented order so the same context is the same URL.
  const ordered = journeyContext(context).toString();
  return `${PATHS[step]}${ordered ? `?${ordered}` : ""}`;
}

/**
 * A count in words. Arabic has six plural forms (zero, one, two, few, many,
 * other) where English has two, so a count is never `thing${n === 1 ? "" :
 * "s"}`: the table carries `<key>.<form>` for whichever forms its language
 * has, `{n}` is the number in the reader's digits, and a missing form falls
 * back to `other`.
 */
export function counted(l: Label, key: string, n: number, locale: string): string {
  const vars = { n: new Intl.NumberFormat(locale).format(n) };
  const exact = `${key}.${new Intl.PluralRules(locale).select(n)}`;
  const text = l(exact, vars);
  return text === exact ? l(`${key}.other`, vars) : text;
}

/** A product line as a reader says it. */
export function lineName(l: Label, line: string): string {
  const key = `line.${line || "unassigned"}`;
  const word = l(key);
  return word === key ? humanise(line) : word;
}

/** A date column (`YYYY-MM-DD`) in the reader's calendar words. */
export function dayOf(date: string, locale: string): string {
  const at = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return date;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at);
}

/** An arrow that points the way the reading goes, and is not read aloud. */
function Onward() {
  return (
    <span aria-hidden="true" className="inline-block rtl:-scale-x-100">
      →
    </span>
  );
}

export function JourneyNav({
  current,
  locale,
  pack,
  t
}: {
  current: JourneyStep;
  locale: string;
  pack?: string | undefined;
  t: Translate;
}) {
  const { search } = useLocation();
  const l = journeyLabels({})(locale, pack);
  return (
    <nav aria-label={t("journey.demoLabel")}>
      <ol className="flex flex-wrap items-center gap-2">
        {STEPS.map((step, i) => {
          const here = step === current;
          return (
            <li key={step} className="flex items-center gap-2">
              {i > 0 ? (
                <span className="text-subtle">
                  <Onward />
                </span>
              ) : null}
              <Link
                to={stepHref(step, search)}
                aria-current={here ? "step" : undefined}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-orbit border px-3 py-1 text-12",
                  focusRing,
                  here ? "border-accent-line bg-accent-soft text-text" : "border-border text-subtle hover:text-text"
                )}
                style={here ? { borderColor: hueVar(step) } : undefined}
              >
                <span className="font-medium">{l(`step.${step}`)}</span>
                <span className="text-subtle">· {l(`step.${step}.detail`)}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * The one `<h1>` a journey step has. The Hero below it speaks in the lede
 * voice (a `<p>`), so without this the page had no heading at all.
 */
export function JourneyHeader({
  step,
  title,
  locale,
  pack
}: {
  step: JourneyStep;
  title: string;
  locale: string;
  pack?: string | undefined;
}) {
  const l = journeyLabels({})(locale, pack);
  const n = new Intl.NumberFormat(locale);
  return (
    <header className="flex flex-col gap-1">
      <p className="eyebrow">
        {l("stepOf", { n: n.format(STEPS.indexOf(step) + 1), total: n.format(STEPS.length) })} · {l(`step.${step}`)}
      </p>
      <h1 className="page-title">{title}</h1>
    </header>
  );
}

export function JourneyContinue({ to, label }: { to: string; label: string }) {
  return (
    <div className="flex justify-end">
      <Button asChild variant="primary">
        <Link to={to}>
          {label} <Onward />
        </Link>
      </Button>
    </div>
  );
}

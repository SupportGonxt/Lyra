/**
 * Formatters. ponytail: `Intl` already knows every currency's minor units,
 * every calendar and every locale — no formatting dependency is warranted.
 */
import * as React from "react";
import { cn } from "./cn.js";
import { Input } from "./primitives.js";
import { uiText, useUiCalendar, useUiLocale, useUiTimeZone, type CalendarPreference } from "./text.js";

/** Minor-unit exponent for a currency (AED/USD → 2, JPY → 0, KWD → 3). */
function minorUnits(currency: string, locale: string): number {
  return (
    new Intl.NumberFormat(locale, { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

/** The currency's own symbol, for the inline-start edge of a money control. */
function currencySymbol(currency: string, locale: string): string {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency }).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? currency;
}

/**
 * `"500.55"` → `50055`, in the currency's own precision (JPY has none, KWD has
 * three). Returns null for anything that is not a plain decimal number, so a
 * half-typed field submits nothing rather than a wrong amount.
 *
 * The decimal is split and padded rather than multiplied: `12.34 * 100` is
 * 1233.9999999999998 in binary floating point, and money that rounds by
 * accident is money the ledger cannot explain.
 */
export function minorFromMajor(value: string, currency: string, locale = "en"): number | null {
  const text = value.trim();
  if (!/^-?\d+(?:\.\d*)?$|^-?\.\d+$/.test(text)) return null;
  const digits = minorUnits(currency, locale);
  const negative = text.startsWith("-");
  const [whole = "", fraction = ""] = text.replace("-", "").split(".");
  // Extra fraction digits are cut, not rounded: nobody agreed to the cent that
  // rounding up would invent.
  const padded = `${fraction}${"0".repeat(digits)}`.slice(0, digits);
  const minor = Number(whole || "0") * 10 ** digits + Number(padded || "0");
  return negative ? -minor : minor;
}

/** `50000` → `"500"`, the amount as a person would say it out loud. */
export function majorFromMinor(minor: number, currency: string, locale = "en"): string {
  const digits = minorUnits(currency, locale);
  if (digits === 0) return String(minor);
  const text = (Math.abs(minor) / 10 ** digits).toFixed(digits).replace(/\.?0+$/, "");
  return minor < 0 ? `-${text}` : text;
}

/**
 * `2500000` in AED → `"AED 25,000.00"`. Same rendering `<Money>` does, without
 * an element around it — an SVG `<text>` cannot hold a `<span>`, and the money
 * map's node labels were dividing by a hard-coded 100 and printing no currency
 * at all.
 */
export function formatMoney(amountMinor: number, currency: string, locale = "en"): string {
  const value = amountMinor / 10 ** minorUnits(currency, locale);
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
}

export interface MoneyFieldProps
  extends Omit<
    React.ComponentPropsWithRef<"input">,
    "name" | "defaultValue" | "value" | "prefix" | "size" | "type"
  > {
  /** The field the form submits, in minor units — `dailyMinor`, `amountMinor`. */
  name: string;
  currency: string;
  locale?: string;
  /** Starting amount, in minor units, as the API stores it. */
  defaultMinor?: number;
}

/**
 * A money input that speaks the way money is spoken. The visible control takes
 * rands or dirhams; a hidden input carries the integer minor units the API and
 * the ledger require, so no call site converts and no user types cents.
 */
export function MoneyField({
  name,
  currency,
  locale: explicitLocale,
  defaultMinor,
  className,
  ...props
}: MoneyFieldProps) {
  const inherited = useUiLocale();
  const locale = explicitLocale ?? inherited;
  const [text, setText] = React.useState(
    defaultMinor === undefined ? "" : majorFromMinor(defaultMinor, currency, locale)
  );
  const minor = minorFromMajor(text, currency, locale);
  const digits = minorUnits(currency, locale);

  return (
    <>
      <Input
        {...props}
        type="number"
        inputMode="decimal"
        step={digits === 0 ? 1 : 10 ** -digits}
        value={text}
        onChange={(event) => setText(event.target.value)}
        prefix={currencySymbol(currency, locale)}
        className={className}
      />
      <input type="hidden" name={name} value={minor === null ? "" : String(minor)} />
    </>
  );
}

export interface MoneyProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  /** Integer minor units, matching @lyra/ledger's `amountMinor`. */
  amountMinor: number;
  currency: string;
  locale?: string;
  /**
   * Base-currency equivalent. docs/22 §5.1: money never renders as a bare
   * number — when the transaction currency is not the base currency, both are
   * shown together.
   */
  baseMinor?: number;
  baseCurrency?: string;
  /** Force an explicit + on positives (deltas, adjustments). */
  signed?: boolean;
  /** Colour positive/negative with ion/flare. Off for ledger columns. */
  toned?: boolean;
}

export function Money({
  amountMinor,
  currency,
  locale: explicitLocale,
  baseMinor,
  baseCurrency,
  signed = false,
  toned = false,
  className,
  ...props
}: MoneyProps) {
  // Unset means "whatever the document is in" — a formatter that silently
  // defaults to English is how an Arabic screen ends up with Latin digits.
  const inherited = useUiLocale();
  const locale = explicitLocale ?? inherited;
  const format = (minor: number, code: string) => {
    const text = formatMoney(minor, code, locale);
    return signed && minor > 0 ? `+${text}` : text;
  };

  const showBase =
    baseMinor !== undefined && baseCurrency !== undefined && baseCurrency !== currency;

  return (
    <span
      {...props}
      className={cn(
        "tabular-nums",
        toned && (amountMinor < 0 ? "text-danger" : amountMinor > 0 ? "text-success" : undefined),
        className
      )}
    >
      {format(amountMinor, currency)}
      {showBase ? (
        <span className="ms-1.5 text-12 text-subtle">
          ({format(baseMinor, baseCurrency)})
        </span>
      ) : null}
    </span>
  );
}

/**
 * A storage key that escaped into the interface: `us_01KE953T07XY8ZQK4M2N6VJH3B`,
 * or `user:us_…` / `scout_cluster:clu_…` with a scope on the front. Twenty-six base-32 characters are
 * unreadable, unmemorable, and wide enough to burst a card.
 */
const OPAQUE_REF =
  /^(?:([a-z][a-z0-9_.-]*):)?([a-z][a-z0-9]*_)([0-9a-hjkmnp-tv-z]{16,})(:[a-z0-9-]+)?$/i;

/**
 * Head and tail of an opaque ref — enough to match one against a log line —
 * and anything that is not one (a case number, an email, a name) untouched, so
 * this is safe to wrap around a field that is only sometimes an id.
 *
 * ponytail: shortening, not resolution. When an endpoint starts returning the
 * display name behind a ref, render the name and demote this to its subtitle.
 */
/** Whether a string is one of those keys, so a loader can ask what it is called. */
export function isOpaqueRef(value: string): boolean {
  return OPAQUE_REF.test(value.trim());
}

export function shortRef(value: string): string {
  const match = OPAQUE_REF.exec(value.trim());
  if (!match) return value;
  const [, scope, prefix, body, tail] = match;
  return `${scope ? `${scope}:` : ""}${prefix}${body!.slice(0, 4)}…${body!.slice(-4)}${tail ?? ""}`;
}

export interface RefProps extends Omit<React.ComponentPropsWithRef<"span">, "children"> {
  value: string | null | undefined;
  /** Shown when there is no ref at all. */
  fallback?: string;
}

/** An identifier, shortened when it is opaque, with the whole value on hover. */
export function Ref({ value, fallback = "—", className, title, ...props }: RefProps) {
  const short = value ? shortRef(value) : fallback;
  return (
    <span
      {...props}
      title={title ?? (value && short !== value ? value : undefined)}
      className={cn("font-mono", className)}
    >
      {short}
    </span>
  );
}

/** What a date field can actually hold: an instant, or nothing — a nullable
 *  column (`axis_claims.incident_at`, `scout_whitespaces.promoted_at`) sends
 *  `null` on the wire, and every reader of one degrades to the same dash. */
export type Instant = Date | string | number | null | undefined;

export type DateTimePrecision = "day" | "time" | "minute" | "second";

export interface DateTimeProps extends Omit<React.ComponentPropsWithRef<"time">, "dateTime"> {
  value: Instant;
  locale?: string;
  timeZone?: string;
  precision?: DateTimePrecision;
  /** Overrides the tenant's own preference (UiCalendarProvider). */
  calendar?: CalendarPreference;
  /** Render "3 hours ago" instead of an absolute stamp; title keeps the exact value. */
  relative?: boolean;
}

const precisionOptions: Record<DateTimePrecision, Intl.DateTimeFormatOptions> = {
  day: { year: "numeric", month: "short", day: "2-digit" },
  // The clock alone, for a surface that has already said which day it means —
  // the day strip in the shell labels its dots with nothing but the hour.
  time: { hour: "2-digit", minute: "2-digit" },
  minute: { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  second: {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }
};

const relativeSteps: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.35],
  ["month", 12],
  ["year", Number.POSITIVE_INFINITY]
];

/**
 * The absolute stamp, split out so the Hijri rendering is testable without a
 * DOM: `islamic-umalqura` is the Saudi civil calendar, and an ICU upgrade that
 * shifted a date by a day would otherwise be invisible until a customer saw it.
 */
export function formatDate(
  date: Date,
  options: {
    locale: string;
    precision?: DateTimePrecision | undefined;
    calendar?: "islamic-umalqura" | undefined;
    timeZone?: string | undefined;
  }
): string {
  return new Intl.DateTimeFormat(options.locale, {
    ...precisionOptions[options.precision ?? "minute"],
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
    ...(options.calendar ? { calendar: options.calendar } : {})
  }).format(date);
}

/** What a cell shows when it has nothing renderable in it — see `NoData`. */
const DASH = "—";

/**
 * `value` as a `Date`, or `null` when no `Date` can hold it (ECMA-262 bounds a
 * `Date` to ±8.64e15 ms from the epoch). The API bounds every write surface
 * now, but rows written before those bounds landed are still in the tables, and
 * `Intl.DateTimeFormat.format` and `toISOString` both throw `RangeError` on the
 * Invalid Date such a row makes. A throw inside a render takes the whole route
 * to the error boundary, so one unreadable field costs the page.
 */
export function instantOf(value: Instant): Date | null {
  // `null` explicitly, before `new Date`: `new Date(null)` is the epoch, so a
  // nullable column with nothing in it would render "01 Jan 1970" — a date the
  // reader has no way to tell from a real one. Nullable is the common case
  // (`incident_at`, `promoted_at`, `deleted_at`), so the guard belongs here
  // rather than in a `?? Number.NaN` at every call site.
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * An instant as text, degraded to the dash rather than thrown — the same guard
 * `DateTime` uses, for the renderers that cannot be a component: a lede
 * sentence and a form's input value need a string, and the portal screens pass
 * `Intl` options `formatDate` does not carry (`dateStyle`). Route a date
 * through here and it inherits the guard; hand-roll `new Date(x)` beside an
 * `Intl` formatter and it does not.
 *
 * ponytail: the bare dash, not the `sr-only` explanation `DateTime` renders —
 * a string cannot carry an element into its caller's sentence, and this
 * function has no locale to pick the words in. Upgrade path is a
 * caller-supplied fallback argument the day a screen needs to say why.
 */
export function formatInstant(value: Instant, render: (date: Date) => string): string {
  const date = instantOf(value);
  return date === null ? DASH : render(date);
}

function relativeText(date: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  let delta = (date.getTime() - Date.now()) / 1000;
  for (const [unit, size] of relativeSteps) {
    if (Math.abs(delta) < size) return rtf.format(Math.round(delta), unit);
    delta /= size;
  }
  return rtf.format(Math.round(delta), "year");
}

export function DateTime({
  value,
  locale: explicitLocale,
  timeZone,
  precision = "minute",
  calendar: explicitCalendar,
  relative = false,
  className,
  ...props
}: DateTimeProps) {
  const inherited = useUiLocale();
  const inheritedCalendar = useUiCalendar();
  const inheritedZone = useUiTimeZone();
  const locale = explicitLocale ?? inherited;
  const preference = explicitCalendar ?? inheritedCalendar;
  // Never unpinned: an unpinned formatter reads the host's zone, and the host
  // is a UTC Worker on one pass and a reader's laptop on the next. See
  // UiTimeZoneProvider — that mismatch error-boundaries the entire route.
  const zone = timeZone ?? inheritedZone;

  // An instant no `Date` can hold (`instantOf`) — degrade to the same dash an
  // empty cell uses rather than throwing the route away.
  //
  // The dash is `aria-hidden` for `NoData`'s reason: punctuation standing in
  // for content is read as "dash" or as silence, and neither says a date was
  // expected. So the reason goes in an `sr-only` span beside it, exactly as
  // `NoData` does — an `aria-label` on this bare `<span>` would not do it, that
  // is a name-prohibited role in ARIA 1.2. The words are kit chrome, from the
  // kit's own catalogue in this date's locale (text.tsx), not the caller's job.
  const date = instantOf(value);
  if (date === null) {
    // `title` after the spread, as `NoData` does: any `title` the caller passed
    // describes a date that is not being rendered, so the reason wins.
    const reason = uiText(locale)("dateUnavailable");
    return (
      <span {...props} title={reason} className={cn("text-subtle tabular-nums", className)}>
        <span aria-hidden="true">{DASH}</span>
        <span className="sr-only absolute h-px w-px overflow-hidden">{reason}</span>
      </span>
    );
  }

  const format = (calendar?: "islamic-umalqura") =>
    formatDate(date, { locale, precision, calendar, timeZone: zone });

  // "dual" reads Gregorian, with the Hijri date one hover away: Gulf contracts
  // cite both, but a table of two calendars per cell is unreadable.
  const absolute = preference === "islamic-umalqura" ? format("islamic-umalqura") : format();
  const hijri = preference === "dual" ? format("islamic-umalqura") : null;
  const title = relative ? absolute : (hijri ?? props.title);

  return (
    <time
      {...props}
      // The zone is pinned above, but `relative` also reads the clock, and the
      // server's clock is a network hop older than the browser's — "6 seconds
      // ago" against "8 seconds ago" is a mismatch too. Suppressing it keeps
      // the server's wording for one paint instead of losing the page.
      suppressHydrationWarning={relative}
      dateTime={date.toISOString()}
      title={relative && hijri ? `${absolute} · ${hijri}` : title}
      // A timestamp is one unit: "Sep 25, 2026, 07:09 / PM" broke across two
      // lines in every narrow table column.
      className={cn("whitespace-nowrap tabular-nums", className)}
    >
      {relative ? relativeText(date, locale) : absolute}
    </time>
  );
}

/**
 * A cell with nothing in it yet. Screens spelled the reason out in full inside
 * every empty cell — "Not enough data yet" across five columns and eleven rows
 * on the audience-value table, wrapping each one four lines deep and crowding
 * out the numbers that do exist. The dash is the cell; the reason stays one
 * hover (or one screen reader) away.
 */
export function NoData({
  reason,
  className,
  ...props
}: { reason: string } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span {...props} title={reason} className={cn("text-subtle", className)}>
      <span aria-hidden="true">{DASH}</span>
      <span className="sr-only absolute h-px w-px overflow-hidden">{reason}</span>
    </span>
  );
}

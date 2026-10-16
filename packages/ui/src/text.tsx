/**
 * Kit chrome — the words the design system says on its own behalf: "Approve",
 * the audit-trail headers, an empty table's fallback line. They are not the
 * app's copy (that lives in apps/web/app/i18n) and they are not the caller's
 * problem: 98 Table call sites will never all remember to pass a translated
 * empty state, so the kit carries its own catalogue and reads one locale off a
 * provider at the document root.
 *
 * Every one of these is still overridable per call — a prop wins over the
 * catalogue. The catalogue is what happens when nobody passes anything.
 *
 * ponytail: two locales, plain objects, `{slot}` interpolation. No ICU runtime
 * until a kit string needs a plural or an inline date; add a locale by adding a
 * column.
 */
import * as React from "react";

const en = {
  // Table / Pagination / AuditTrail
  empty: "Nothing here yet.",
  pagination: "Pagination",
  rows: "Rows",
  previous: "Previous",
  next: "Next",
  auditTrail: "Audit trail",
  when: "When",
  actor: "Actor",
  action: "Action",
  target: "Target",
  detail: "Detail",
  // DateTime, degraded. A stored instant no `Date` can hold renders as the same
  // dash an empty cell uses; the dash is `aria-hidden`, so this is what is left
  // to say a date was expected and is not readable.
  dateUnavailable: "Date unavailable",
  // Timeline
  waiting: "Waiting",
  done: "Done",
  // StateFlow / PostingFlow (docs/19 process flows)
  flowNow: "Now",
  outOfMachine: "Not a documented state: {states}",
  valueFlow: "Value moving",
  debits: "Debits",
  credits: "Credits",
  balanced: "Both sides agree",
  unbalanced: "The two sides do not agree",
  // Ambient AI (docs/15)
  aiGenerated: "AI-generated",
  draftedBy: "Drafted by {agent}",
  whyDrafted: "Why this was drafted",
  accept: "Accept",
  discard: "Discard",
  confidence: "Model confidence",
  evidence: "Evidence",
  aiBudget: "AI budget",
  tokens: "tokens",
  percentLabel: "{label}: {value} percent",
  budgetUsage: "{label}: {value} percent of {limit} {unit} used",
  resets: "Resets",
  budgetExhausted:
    "Budget exhausted — agent runs are paused until the window resets or the cap is raised.",
  pendingApproval: "Pending approval",
  requestedBy: "Requested by {who}",
  approve: "Approve",
  reject: "Reject",
  confirmApprove: "Confirm approve",
  confirmReject: "Confirm reject",
  cancel: "Cancel",
  approveIsFinal: "Approving is final and takes effect immediately.",
  rejectIsFinal: "Rejecting is final and cannot be undone.",
  // Overlay + navigation chrome (Dialog, Drawer, Toast, CommandBar, nav landmarks)
  close: "Close",
  dismiss: "Dismiss",
  modules: "Modules",
  breadcrumb: "Breadcrumb",
  search: "Search",
  commandSearch: "Search entities, actions, docs…",
  commandPalette: "Command palette",
  commandEmpty: "No matches."
} as const;

export type KitKey = keyof typeof en;

const ar: Record<KitKey, string> = {
  empty: "لا شيء هنا بعد.",
  pagination: "التنقّل بين الصفحات",
  rows: "الصفوف",
  previous: "السابق",
  next: "التالي",
  auditTrail: "سجل التدقيق",
  when: "الوقت",
  actor: "المنفّذ",
  action: "الإجراء",
  target: "الهدف",
  detail: "التفاصيل",
  dateUnavailable: "التاريخ غير متاح",
  waiting: "قيد الانتظار",
  done: "تم",
  flowNow: "الآن",
  outOfMachine: "حالة غير موثّقة: {states}",
  valueFlow: "حركة القيمة",
  debits: "مدين",
  credits: "دائن",
  balanced: "الطرفان متساويان",
  unbalanced: "الطرفان غير متساويين",
  aiGenerated: "من إنشاء الذكاء الاصطناعي",
  draftedBy: "صاغها {agent}",
  whyDrafted: "سبب هذه المسودة",
  accept: "قبول",
  discard: "تجاهل",
  confidence: "ثقة النموذج",
  evidence: "الأدلة",
  aiBudget: "ميزانية الذكاء الاصطناعي",
  tokens: "رمزًا",
  percentLabel: "{label}: {value} بالمئة",
  budgetUsage: "{label}: {value} بالمئة من {limit} {unit} مستهلكة",
  resets: "تتجدد",
  budgetExhausted: "استُنفدت الميزانية — تشغيل الوكلاء متوقف حتى تتجدد النافذة أو يُرفع الحد.",
  pendingApproval: "بانتظار الموافقة",
  requestedBy: "بطلب من {who}",
  approve: "موافقة",
  reject: "رفض",
  confirmApprove: "تأكيد الموافقة",
  confirmReject: "تأكيد الرفض",
  cancel: "إلغاء",
  approveIsFinal: "الموافقة نهائية وتُنفَّذ فورًا.",
  rejectIsFinal: "الرفض نهائي ولا يمكن التراجع عنه.",
  close: "إغلاق",
  dismiss: "إغلاق الإشعار",
  modules: "الوحدات",
  breadcrumb: "مسار التنقّل",
  search: "بحث",
  commandSearch: "ابحث في السجلات والإجراءات والمستندات…",
  commandPalette: "لوحة الأوامر",
  commandEmpty: "لا نتائج مطابقة."
};

export const KIT_TEXT: Record<string, Record<KitKey, string>> = { en, ar };

export type KitText = (key: KitKey, vars?: Record<string, string | number>) => string;

/** Locale, then English, then the key itself — `{slot}` filled from `vars`. */
export function uiText(locale: string): KitText {
  // "ar-AE" is Arabic. Region subtags change formatting, never the catalogue.
  const table = KIT_TEXT[locale.split("-")[0] ?? "en"] ?? en;
  return (key, vars) => {
    const raw = table[key] ?? en[key];
    return vars
      ? raw.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
      : raw;
  };
}

const LocaleContext = React.createContext<string>("en");

/**
 * Wrap the document once. Everything below it — kit chrome, `<Money>`,
 * `<DateTime>` — picks the locale up without a prop being threaded through
 * five layers of screen.
 */
export function UiTextProvider({ locale, children }: { locale: string; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useUiLocale(): string {
  return React.useContext(LocaleContext);
}

/**
 * The currency a tenant's money is **counted in** — the functional currency, not a
 * row's.
 *
 * This exists because the spec-driven write path had no currency at all: `FieldSpec`
 * carried none, so a `MoneyField` could not be rendered and every money input posted
 * raw minor units under a label that named no unit — `1575` stored 1575 fils and
 * displayed as AED 15.75 (the 2026-10-01 sweep's WEB finding, recovered from a
 * truncated result).
 *
 * Defaulted to `AED` for the same reason `apps/web/app/calendar.ts` does: ADR-0121
 * records the launch market, so a fallback here applies a decision rather than making
 * one. A row that disagrees states its own currency through `FieldSpec.currencyFrom`
 * — that is a policy priced in SAR by an AED tenant — and only those rows need it,
 * because a **form** edits one row for one tenant where a **list** can mix currencies.
 */
const CurrencyContext = React.createContext<string>("AED");

export function UiCurrencyProvider({ currency, children }: { currency: string; children: React.ReactNode }) {
  return <CurrencyContext.Provider value={currency}>{children}</CurrencyContext.Provider>;
}

export function useUiCurrency(): string {
  return React.useContext(CurrencyContext);
}

/**
 * Which calendar a tenant reckons dates in. "dual" is the Gulf business
 * convention — a contract cites the Gregorian date and the Hijri one beside it —
 * so it is a rendering choice, not a third calendar.
 */
export type CalendarPreference = "gregorian" | "islamic-umalqura" | "dual";

const CalendarContext = React.createContext<CalendarPreference>("gregorian");

/**
 * Tenant policy, not document chrome: the locale is known before there is a
 * session (login renders in Arabic), the calendar is not. Mounted inside the
 * shell so every `<DateTime>` below it inherits without 124 call sites growing
 * a prop.
 */
export function UiCalendarProvider({
  calendar,
  children
}: {
  calendar: CalendarPreference;
  children: React.ReactNode;
}) {
  return <CalendarContext.Provider value={calendar}>{children}</CalendarContext.Provider>;
}

export function useUiCalendar(): CalendarPreference {
  return React.useContext(CalendarContext);
}

const TimeZoneContext = React.createContext<string>("UTC");

/**
 * Which zone every `<DateTime>` below renders in. The default is UTC and that
 * is load-bearing, not a placeholder: the server pass and the browser's first
 * pass have to produce the same characters, and a Worker runs in UTC while its
 * reader does not. An unpinned formatter puts "07:07" in the HTML and "05:07"
 * in the hydration, which React 19 treats as a mismatch and answers by
 * throwing the whole route to the error boundary.
 *
 * So: UTC on both first passes, then the reader's own zone once mounted. The
 * swap is a state change, not a hydration, so React re-renders it happily.
 * `timeZone` overrides both — that is the seam for a tenant-configured zone.
 */
export function UiTimeZoneProvider({
  timeZone,
  children
}: {
  timeZone?: string | undefined;
  children: React.ReactNode;
}) {
  const [local, setLocal] = React.useState<string | null>(null);
  React.useEffect(() => {
    setLocal(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
  }, []);
  return (
    <TimeZoneContext.Provider value={timeZone ?? local ?? "UTC"}>{children}</TimeZoneContext.Provider>
  );
}

export function useUiTimeZone(): string {
  return React.useContext(TimeZoneContext);
}

export function useUiText(): KitText {
  return uiText(React.useContext(LocaleContext));
}

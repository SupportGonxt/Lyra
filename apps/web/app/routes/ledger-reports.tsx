import {
  data,
  Form,
  Link,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  DatePicker,
  DateTime,
  EmptyState,
  Field,
  formatMoney,
  Input,
  KPIWall,
  Money,
  Stat,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import type { Env } from "../env";
import { translator, type Translate } from "../i18n";
import { labelsFrom, ReportDownloads } from "./detail-kit";
import { useShellData } from "./workspace";

// The finance reporting surface: six reports from /v1/ledger/reports, one route.
// The report is a URL segment and its parameters are a GET form, so every figure
// a controller looks at has an address they can send to their auditor.
//
// Nothing here computes money. The API sums the journal and this file renders
// what it sends — a screen that re-derives a total is a second source of truth
// (docs/19 §9), and the first thing to disagree with the ledger.

/* -------------------------------------------------------------- the contract */

// Shapes as apps/api returns them (packages/ledger/src/reports.ts). Declared
// locally because the web app does not depend on @lyra/ledger — if these drift,
// the contract test on the API side is what should fail, not a build here.

interface TrialBalanceRow {
  accountCode: string;
  name: string;
  type: string;
  normalSide: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
}

interface TrialBalance {
  currency: string;
  asOf: number;
  periodCode?: string;
  rows: TrialBalanceRow[];
  totalDebitMinor: number;
  totalCreditMinor: number;
  balanced: boolean;
}

interface Section {
  label: string;
  rows: Array<{ accountCode: string; name: string; amountMinor: number }>;
  totalMinor: number;
}

interface Pnl {
  periodCode: string;
  currency: string;
  income: Section;
  expense: Section;
  grossMarginMinor: number;
  marginPpm: number;
}

interface BalanceSheet {
  asOf: number;
  currency: string;
  assets: Section;
  liabilities: Section;
  /** Posted 3xxx accounts. Empty until the tenant's first year-end close. */
  equity: Section;
  currentYearUnpostedMinor: number;
  equityMinor: number;
  balanced: boolean;
}

interface AgedRow {
  counterparty: string;
  currency: string;
  currentMinor: number;
  d30Minor: number;
  d60Minor: number;
  d90Minor: number;
  olderMinor: number;
  totalMinor: number;
}

interface CommissionRow {
  dimension: string;
  value: string;
  grossMinor: number;
  channelShareMinor: number;
  netMinor: number;
  currency: string;
}

interface ClientMoneyRow {
  currency: string;
  assetMinor: number;
  liabilityMinor: number;
  surplusMinor: number;
  breach: boolean;
  asOf: number;
}

interface BordereauxRow {
  policyNo: string;
  providerId: string;
  customerId: string;
  currency: string;
  premiumMinor: number;
  commissionMinor: number;
  kind: string;
  earnedAt: number;
  startAt: number;
  endAt: number;
}

/** Discriminated so the view switch narrows without a cast per branch. */
type Report =
  | { key: "trial-balance"; data: TrialBalance }
  | { key: "pnl"; data: Pnl }
  | { key: "balance-sheet"; data: BalanceSheet }
  | { key: "aged"; data: { data: AgedRow[] } }
  | { key: "commission"; data: { dimension: string; data: CommissionRow[] } }
  | { key: "client-money"; data: { data: ClientMoneyRow[] } }
  | { key: "bordereaux"; data: { data: BordereauxRow[] } };

type ReportKey = Report["key"];

/* --------------------------------------------------------------- the reports */

/** Read permissions, copied from apps/api/src/routes/ledger.ts §reports. */
const JOURNALS = "ledger:journals:read";
const CLIENT_MONEY = "ledger:client_money:read";

type ParamKind = "month" | "date" | "text";

interface ReportSpec {
  permission: string;
  /** Exactly the query keys the endpoint reads. Anything else is decoration. */
  params: Array<{ name: string; kind: ParamKind }>;
}

const REPORTS: Record<ReportKey, ReportSpec> = {
  "trial-balance": {
    permission: JOURNALS,
    params: [
      { name: "period", kind: "month" },
      { name: "asOf", kind: "date" },
      { name: "currency", kind: "text" }
    ]
  },
  pnl: { permission: JOURNALS, params: [{ name: "period", kind: "month" }] },
  "balance-sheet": { permission: JOURNALS, params: [{ name: "asOf", kind: "date" }] },
  aged: {
    permission: JOURNALS,
    params: [
      { name: "accounts", kind: "text" },
      { name: "asOf", kind: "date" }
    ]
  },
  commission: {
    permission: JOURNALS,
    params: [
      { name: "by", kind: "text" },
      { name: "period", kind: "month" }
    ]
  },
  "client-money": { permission: CLIENT_MONEY, params: [{ name: "currency", kind: "text" }] },
  bordereaux: {
    permission: JOURNALS,
    params: [
      { name: "providerId", kind: "text" },
      { name: "period", kind: "month" }
    ]
  }
};

const ORDER = Object.keys(REPORTS) as ReportKey[];

/** The reports whose rows name an account, and so can drill into one. */
const LINKED = new Set<ReportKey>(["trial-balance", "pnl", "balance-sheet"]);

function isReport(key: string): key is ReportKey {
  return Object.hasOwn(REPORTS, key);
}

// Downloads go to `GET /v1/ledger/reports/:report/export`, which re-runs the
// same report function this screen reads and serialises it through the shared
// export renderer. The nav and the format list live in detail-kit
// (`ReportDownloads`) because the account statement and the money map are
// downloads of the same kind against the same route.

/* ------------------------------------------------------------------- strings */

// This screen owns its own strings: the shared catalogue (i18n/en.ts, ar.ts) is
// another author's file. Generic words still come from `translator`, so "Apply"
// is the same word here as on every list.
export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Finance reports",
    "headline.balanced": "{name} balances.",
    "headline.outBy": "{name} is out by {amount}.",
    "headline.pnl": "{name} nets {amount}.",
    "headline.count": "{name}: {count} row(s).",
    "headline.cmBreach": "{name}: {count} currency breach(es).",
    "headline.cmClear": "{name} is clear — no breach.",
    "report.trial-balance": "Trial balance",
    "report.pnl": "Profit and loss",
    "report.balance-sheet": "Balance sheet",
    "report.aged": "Aged analysis",
    "report.commission": "Commission statement",
    "report.client-money": "Client money check",
    "report.bordereaux": "Bordereaux",
    params: "Report parameters",
    "param.period": "Period",
    "param.asOf": "As at",
    "param.currency": "Currency",
    "param.accounts": "Accounts",
    "param.by": "Group by",
    "param.providerId": "Provider",
    "hint.period": "Month, e.g. 2026-07",
    "hint.asOf": "Includes everything posted up to the end of that day",
    "hint.currency": "ISO code, e.g. AED",
    "hint.accounts": "Account codes, comma separated",
    "hint.by": "A dimension stamped on the journal line, e.g. provider",
    "hint.providerId": "Leave blank for every provider",
    asOf: "As at",
    "col.account": "Account",
    "col.name": "Name",
    "col.type": "Type",
    "col.normalSide": "Normal side",
    "side.debit": "Debit",
    "side.credit": "Credit",
    // The five account types, rendered from `row.type`. A missing key here
    // shows the reader the raw enum.
    "type.asset": "Asset",
    "type.liability": "Liability",
    "type.equity": "Equity",
    "type.income": "Income",
    "type.expense": "Expense",
    "col.debit": "Debit",
    "col.credit": "Credit",
    "col.balance": "Balance",
    "col.amount": "Amount",
    "col.currency": "Currency",
    "col.total": "Total",
    "col.status": "Status",
    "tb.totalDebit": "Total debits",
    "tb.totalCredit": "Total credits",
    "tb.difference": "Difference",
    "tb.balanced": "Debits equal credits",
    "tb.unbalanced.title": "This trial balance does not foot",
    "tb.unbalanced.body":
      "Debits and credits differ by the amount shown. The journal is the truth and the balances table is a cache: rebuild the balances and review the batches posted in this window before anyone relies on these figures.",
    "pnl.income": "Revenue",
    "pnl.expense": "Cost of revenue and operating",
    "pnl.margin": "Gross margin",
    "pnl.marginPct": "Margin",
    "bs.assets": "Assets",
    "bs.liabilities": "Liabilities",
    "bs.equity": "Equity",
    "bs.unbalanced.title": "This balance sheet does not balance",
    "bs.unbalanced.body":
      "Assets do not equal liabilities plus equity. The difference is shown; equity is read from the journal, so the gap is in the postings.",
    "bs.equity.posted": "Posted equity",
    "bs.equity.unposted": "Current year (not yet closed)",
    "bs.equity.unposted.hint": "This year's result still sits in income and expense. The year-end close moves it into retained earnings.",
    "aged.counterparty": "Counterparty",
    "aged.current": "0–30 days",
    "aged.d30": "31–60 days",
    "aged.d60": "61–90 days",
    "aged.d90": "91–120 days",
    "aged.older": "Over 120 days",
    "commission.dimension": "Dimension",
    "commission.value": "Value",
    "commission.gross": "Gross",
    "commission.channelShare": "Channel share",
    "commission.net": "Net",
    "cm.asset": "Client bank",
    "cm.liability": "Owed to clients",
    "cm.surplus": "Surplus or shortfall",
    "cm.breach": "Short",
    "cm.ok": "Whole",
    "cm.breachTitle": "Client money is short",
    "cm.breachBody":
      "The client bank position is below what is owed to clients. This is a reportable breach: escalate it today, before the next remittance run.",
    "bord.policy": "Policy",
    "bord.provider": "Provider",
    "bord.earned": "Earned",
    "bord.term": "Term",
    "bord.premium": "Premium",
    "bord.commission": "Commission",
    "bord.kind": "Kind",
    "denied.title": "You cannot open this report",
    // `download*` moved to detail-kit's SHARED table: the account statement and
    // the money map offer the same four formats against the same export route.
    "denied.body": "It needs a permission your role does not hold. An administrator can grant it."
  },
  ar: {
    title: "التقارير المالية",
    "headline.balanced": "{name} متوازن.",
    "headline.outBy": "{name} يختلف بمقدار {amount}.",
    "headline.pnl": "صافي {name}: {amount}.",
    "headline.count": "{name}: {count} صف.",
    "headline.cmBreach": "{name}: {count} تجاوز في العملة.",
    "headline.cmClear": "{name} سليم — لا تجاوز.",
    "report.trial-balance": "ميزان المراجعة",
    "report.pnl": "الأرباح والخسائر",
    "report.balance-sheet": "الميزانية العمومية",
    "report.aged": "أعمار الأرصدة",
    "report.commission": "كشف العمولات",
    "report.client-money": "فحص أموال العملاء",
    "report.bordereaux": "كشف تفصيلي (بوردرو)",
    params: "معايير التقرير",
    "param.period": "الفترة",
    "param.asOf": "كما في",
    "param.currency": "العملة",
    "param.accounts": "الحسابات",
    "param.by": "التجميع حسب",
    "param.providerId": "المزود",
    "hint.period": "الشهر، مثال 2026-07",
    "hint.asOf": "يشمل كل ما رُحِّل حتى نهاية ذلك اليوم",
    "hint.currency": "رمز العملة، مثال AED",
    "hint.accounts": "أرقام الحسابات مفصولة بفواصل",
    "hint.by": "بُعد مسجَّل على قيد اليومية، مثال provider",
    "hint.providerId": "اتركه فارغًا لكل مزود",
    asOf: "كما في",
    "col.account": "الحساب",
    "col.name": "الاسم",
    "col.type": "النوع",
    "col.normalSide": "الطبيعة",
    "side.debit": "مدين",
    "side.credit": "دائن",
    "type.asset": "أصل",
    "type.liability": "التزام",
    "type.equity": "حقوق ملكية",
    "type.income": "إيراد",
    "type.expense": "مصروف",
    "col.debit": "مدين",
    "col.credit": "دائن",
    "col.balance": "الرصيد",
    "col.amount": "المبلغ",
    "col.currency": "العملة",
    "col.total": "الإجمالي",
    "col.status": "الحالة",
    "tb.totalDebit": "إجمالي المدين",
    "tb.totalCredit": "إجمالي الدائن",
    "tb.difference": "الفرق",
    "tb.balanced": "المدين يساوي الدائن",
    "tb.unbalanced.title": "ميزان المراجعة غير متوازن",
    "tb.unbalanced.body":
      "المدين والدائن يختلفان بالمبلغ الظاهر. دفتر اليومية هو المصدر وجدول الأرصدة نسخة مشتقة: أعد بناء الأرصدة وراجع الدفعات المرحَّلة في هذه الفترة قبل الاعتماد على هذه الأرقام.",
    "pnl.income": "الإيرادات",
    "pnl.expense": "التكاليف والمصروفات التشغيلية",
    "pnl.margin": "الهامش الإجمالي",
    "pnl.marginPct": "نسبة الهامش",
    "bs.assets": "الأصول",
    "bs.liabilities": "الالتزامات",
    "bs.equity": "حقوق الملكية",
    "bs.unbalanced.title": "الميزانية العمومية غير متوازنة",
    "bs.unbalanced.body":
      "الأصول لا تساوي الالتزامات مضافًا إليها حقوق الملكية. الفرق ظاهر أدناه، وحقوق الملكية مقروءة من اليومية، لذا الخلل في القيود.",
    "bs.equity.posted": "حقوق الملكية المسجلة",
    "bs.equity.unposted": "نتيجة السنة الجارية (قبل الإقفال)",
    "bs.equity.unposted.hint": "نتيجة هذه السنة ما زالت في الإيرادات والمصروفات. إقفال نهاية السنة ينقلها إلى الأرباح المحتجزة.",
    "aged.counterparty": "الطرف المقابل",
    "aged.current": "0–30 يومًا",
    "aged.d30": "31–60 يومًا",
    "aged.d60": "61–90 يومًا",
    "aged.d90": "91–120 يومًا",
    "aged.older": "أكثر من 120 يومًا",
    "commission.dimension": "البُعد",
    "commission.value": "القيمة",
    "commission.gross": "الإجمالي",
    "commission.channelShare": "حصة القناة",
    "commission.net": "الصافي",
    "cm.asset": "بنك أموال العملاء",
    "cm.liability": "المستحق للعملاء",
    "cm.surplus": "الفائض أو العجز",
    "cm.breach": "عجز",
    "cm.ok": "مكتمل",
    "cm.breachTitle": "أموال العملاء ناقصة",
    "cm.breachBody":
      "رصيد بنك أموال العملاء أقل من المستحق لهم. هذا خرق واجب الإبلاغ: صعِّده اليوم قبل دورة التحويل التالية.",
    "bord.policy": "الوثيقة",
    "bord.provider": "المزود",
    "bord.earned": "تاريخ الاستحقاق",
    "bord.term": "المدة",
    "bord.premium": "القسط",
    "bord.commission": "العمولة",
    "bord.kind": "النوع",
    "denied.title": "لا يمكنك فتح هذا التقرير",
    "denied.body": "يتطلب صلاحية لا يملكها دورك. يمكن للمسؤول منحها."
  }
};

type Label = (key: string, vars?: Record<string, string>) => string;

// Local table, then detail-kit's SHARED, then `common.*` — the same chain every
// screen uses. This screen builds keys from enum values, and a hand-rolled table
// cannot answer one it never wrote down (docs/ui.md §7 P3-14).
export const labelIn = labelsFrom(LABELS);

// Hero headline: the report's own name plus the one figure it already
// computed — never a fabricated number. No ✦, this is not an agent's finding
// (CLAUDE.md §11). Null (a denied load) falls back to the screen's static
// title; the nav below still lets an actor pick a report they do hold.
export function reportsHeadline(report: Report | null, l: Label, locale: string): string {
  if (!report) return l("title");
  const name = l(`report.${report.key}`);
  switch (report.key) {
    case "trial-balance": {
      const { balanced, totalDebitMinor, totalCreditMinor, currency } = report.data;
      return balanced
        ? l("headline.balanced", { name })
        : l("headline.outBy", {
            name,
            amount: formatMoney(Math.abs(totalDebitMinor - totalCreditMinor), currency, locale)
          });
    }
    case "pnl": {
      const { grossMarginMinor, currency } = report.data;
      return l("headline.pnl", { name, amount: formatMoney(grossMarginMinor, currency, locale) });
    }
    case "balance-sheet": {
      const { balanced, assets, liabilities, equity, currency } = report.data;
      const difference = assets.totalMinor - (liabilities.totalMinor + equity.totalMinor);
      return balanced
        ? l("headline.balanced", { name })
        : l("headline.outBy", { name, amount: formatMoney(Math.abs(difference), currency, locale) });
    }
    case "aged":
      return l("headline.count", { name, count: String(report.data.data.length) });
    case "commission":
      return l("headline.count", { name, count: String(report.data.data.length) });
    case "client-money": {
      const breached = report.data.data.filter((row) => row.breach).length;
      return breached > 0
        ? l("headline.cmBreach", { name, count: String(breached) })
        : l("headline.cmClear", { name });
    }
    case "bordereaux":
      return l("headline.count", { name, count: String(report.data.data.length) });
  }
}

/* -------------------------------------------------------------------- loader */

const DAY_END = "T23:59:59.999Z";

/**
 * `asOf` crosses the wire as epoch milliseconds; the picker speaks ISO dates.
 * A date-only value means the end of that day — the API filters `postedAt <=
 * asOf`, so UTC midnight would silently drop everything posted on the day the
 * report is headed with.
 */
function epochOf(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}${DAY_END}` : raw);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Account code → account id, so a figure on a statement can be opened as the
 * record it was summed from. The report payloads carry no ids (packages/ledger
 * §reports) and the chart is the only place the mapping exists.
 *
 * ponytail: the first 200 codes, which is the CRUD page ceiling. A larger chart
 * loses links past the cut, never figures — paginate here when a tenant has one.
 */
async function accountIndex(env: Env, request: Request): Promise<Record<string, string>> {
  try {
    const page = await api<{ data: Array<{ id: string; code: string }> }>(
      "/v1/ledger/accounts?limit=200&sort=code&order=asc",
      { env, request }
    );
    return Object.fromEntries(page.data.map((account) => [account.code, account.id]));
  } catch (error) {
    // Reading the report does not imply reading the chart: a role gated out of
    // `ledger:accounts:read` gets the numbers without the links, not an error.
    if (error instanceof ApiError && error.status === 403) return {};
    throw error;
  }
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const key = params.report ?? "";
  if (!isReport(key)) throw data("report", { status: 404 });
  const spec = REPORTS[key];
  const env = context.get(cloudflare).env;
  const incoming = new URL(request.url).searchParams;

  const query = new URLSearchParams();
  for (const param of spec.params) {
    const raw = incoming.get(param.name)?.trim();
    if (!raw) continue;
    if (param.kind === "date") {
      const at = epochOf(raw);
      if (at !== null) query.set(param.name, String(at));
    } else {
      query.set(param.name, raw);
    }
  }

  // The API would refuse the call anyway; asking first means a 403 never
  // reaches the audit log as a failed read the actor did not intend.
  // A 401 here is the session expiring — the workspace layout owns that redirect.
  const me = await fetchMe(env, request);
  if (!me.permissions.includes(spec.permission)) {
    return { key, denied: true as const, permission: spec.permission };
  }

  const [payload, accounts] = await Promise.all([
    api<Report["data"]>(`/v1/ledger/reports/${key}?${query.toString()}`, { env, request }),
    // Only the three statements that print account codes have anything to link.
    LINKED.has(key) ? accountIndex(env, request) : Promise.resolve({})
  ]);
  return {
    key,
    denied: false as const,
    report: { key, data: payload } as Report,
    accounts,
    // The file is the answer to the same question the screen is showing, so the
    // link carries the query the loader normalised — not the raw address bar.
    // Straight to the API origin. That only works because the session cookie is
    // scoped to the parent domain both hosts share (SESSION_COOKIE_DOMAIN, see
    // apps/api/src/auth.ts sessionCookie) — a host-only cookie would 401 here.
    // Same trade as the analytics download.
    // Ends on a separator so the view only has to name the format.
    exportUrl: `${env.API_ORIGIN}/v1/ledger/reports/${key}/export?${query.toString()}${query.size ? "&" : ""}`
  };
}

/* ---------------------------------------------------------------------- view */

export default function LedgerReports() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelIn(locale);
  const spec = REPORTS[loaded.key];
  const busy = navigation.state !== "idle";
  const parameterised = spec.params.some((param) => searchParams.get(param.name));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {reportsHeadline(loaded.denied ? null : loaded.report, l, locale)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("title")}</p>
        </div>
      </header>

      <nav aria-label={t("common.tabs")}>
        <ul className="flex flex-wrap gap-1">
          {ORDER.map((key) => {
            const current = key === loaded.key;
            return (
              <li key={key}>
                <Link
                  to={`/ledger/reports/${key}`}
                  aria-current={current ? "page" : undefined}
                  className={
                    current
                      ? "inline-flex h-8 items-center rounded-md bg-surface-2 px-3 font-ui text-13 text-text"
                      : "inline-flex h-8 items-center rounded-md px-3 font-ui text-13 text-subtle hover:bg-surface-2 hover:text-text"
                  }
                >
                  {l(`report.${key}`)}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <Form
        key={loaded.key}
        method="get"
        aria-label={l("params")}
        className="flex flex-wrap items-end gap-3"
      >
        {spec.params.map((param) => (
          <Field
            key={param.name}
            label={l(`param.${param.name}`)}
            hint={l(`hint.${param.name}`)}
            className="w-52"
          >
            {param.kind === "date" ? (
              <DatePicker name={param.name} defaultValue={searchParams.get(param.name) ?? ""} />
            ) : (
              <Input
                type={param.kind === "month" ? "month" : "text"}
                name={param.name}
                defaultValue={searchParams.get(param.name) ?? ""}
                {...(param.name === "currency" ? { maxLength: 3 } : {})}
              />
            )}
          </Field>
        ))}
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
        {parameterised ? (
          <Button asChild variant="ghost">
            <Link to={`/ledger/reports/${loaded.key}`}>{t("common.clear")}</Link>
          </Button>
        ) : null}
      </Form>

      {loaded.denied ? null : <ReportDownloads url={loaded.exportUrl} l={l} />}

      {loaded.denied ? (
        <EmptyState title={l("denied.title")} body={l("denied.body")} />
      ) : (
        <ReportView report={loaded.report} accounts={loaded.accounts} locale={locale} l={l} t={t} />
      )}
    </div>
  );
}

interface ViewProps {
  locale: string;
  l: Label;
  t: Translate;
  /** Account code → id. Empty when the actor may not read the chart. */
  accounts: Record<string, string>;
}

/**
 * The drill-through. A code the chart knows becomes the account record; a code
 * it does not stays plain text rather than a link into a 404 — a statement is
 * still readable without its links, and never with broken ones.
 */
function AccountCode({ code, accounts }: { code: string; accounts: Record<string, string> }) {
  const id = accounts[code];
  if (!id) return <span className="font-mono text-12">{code}</span>;
  return (
    <Link
      to={`/ledger/accounts/${id}`}
      className="rounded-sm font-mono text-12 text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
    >
      {code}
    </Link>
  );
}

function ReportView({ report, ...rest }: ViewProps & { report: Report }) {
  switch (report.key) {
    case "trial-balance":
      return <TrialBalanceView tb={report.data} {...rest} />;
    case "pnl":
      return <PnlView pnl={report.data} {...rest} />;
    case "balance-sheet":
      return <BalanceSheetView bs={report.data} {...rest} />;
    case "aged":
      return <AgedView rows={report.data.data} {...rest} />;
    case "commission":
      return <CommissionView dimension={report.data.dimension} rows={report.data.data} {...rest} />;
    case "client-money":
      return <ClientMoneyView rows={report.data.data} {...rest} />;
    case "bordereaux":
      return <BordereauxView rows={report.data.data} {...rest} />;
  }
}

/**
 * A statement that does not foot is the most important number on the page, so
 * it gets the loudest treatment on it — never a quiet flag beside the totals.
 */
function Discrepancy({
  title,
  body,
  amountMinor,
  currency,
  locale
}: {
  title: string;
  body: string;
  amountMinor: number;
  currency: string;
  locale: string;
}) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-5">
      <p className="section-title">{title}</p>
      <Money
        amountMinor={amountMinor}
        currency={currency}
        locale={locale}
        signed
        className="font-mono text-28 font-medium tabular-nums text-danger"
      />
      <p className="max-w-prose font-ui text-13 text-muted">{body}</p>
    </div>
  );
}

function Empty({ t }: { t: ViewProps["t"] }) {
  return <EmptyState title={t("common.empty.title")} body={t("common.empty.body")} />;
}

/** Money column, inline-end aligned and tabular by way of `numeric` (Table §th/td). */
function moneyColumn<T>(
  key: string,
  header: string,
  amount: (row: T) => number,
  currency: (row: T) => string,
  locale: string
): Column<T> {
  return {
    key,
    header,
    numeric: true,
    render: (row) => <Money amountMinor={amount(row)} currency={currency(row)} locale={locale} />
  };
}

/* --------------------------------------------------------------- 1. trial balance */

function TrialBalanceView({ tb, accounts, locale, l, t }: ViewProps & { tb: TrialBalance }) {
  const currency = tb.currency;
  const difference = tb.totalDebitMinor - tb.totalCreditMinor;
  const of = () => currency;

  const columns: Array<Column<TrialBalanceRow>> = [
    {
      key: "accountCode",
      header: l("col.account"),
      render: (row) => <AccountCode code={row.accountCode} accounts={accounts} />
    },
    { key: "name", header: l("col.name"), render: (row) => row.name },
    { key: "type", header: l("col.type"), render: (row) => l(`type.${row.type}`) },
    {
      key: "normalSide",
      header: l("col.normalSide"),
      // Which side leaves this account with a positive balance — the difference
      // between a credit balance that is correct and one that is a mispost.
      render: (row) => <span className="text-subtle">{l(`side.${row.normalSide}`)}</span>
    },
    moneyColumn("debit", l("col.debit"), (row) => row.debitMinor, of, locale),
    moneyColumn("credit", l("col.credit"), (row) => row.creditMinor, of, locale),
    moneyColumn("balance", l("col.balance"), (row) => row.balanceMinor, of, locale)
  ];

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <AsOf value={tb.asOf} locale={locale} l={l} />
        {tb.periodCode ? (
          <p className="font-ui text-13 text-subtle">
            {l("param.period")} <span className="tabular-nums text-text">{tb.periodCode}</span>
          </p>
        ) : null}
      </div>
      <KPIWall>
        <Stat
          label={l("tb.totalDebit")}
          value={<Money amountMinor={tb.totalDebitMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("tb.totalCredit")}
          value={<Money amountMinor={tb.totalCreditMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("tb.difference")}
          value={<Money amountMinor={difference} currency={currency} locale={locale} signed />}
          hint={tb.balanced ? l("tb.balanced") : undefined}
        />
      </KPIWall>

      {tb.balanced ? null : (
        <Discrepancy
          title={l("tb.unbalanced.title")}
          body={l("tb.unbalanced.body")}
          amountMinor={difference}
          currency={currency}
          locale={locale}
        />
      )}

      <Table
        columns={columns}
        rows={tb.rows}
        rowKey={(row) => row.accountCode}
        caption={`${l("title")} — ${l("report.trial-balance")}`}
        density="compact"
        empty={<Empty t={t} />}
      />
    </section>
  );
}

/* ------------------------------------------------------------------- 2. p&l */

function SectionTable({
  section,
  title,
  currency,
  accounts,
  locale,
  l,
  t
}: ViewProps & { section: Section; title: string; currency: string }) {
  const columns: Array<Column<Section["rows"][number]>> = [
    {
      key: "accountCode",
      header: l("col.account"),
      render: (row) => <AccountCode code={row.accountCode} accounts={accounts} />
    },
    { key: "name", header: l("col.name"), render: (row) => row.name },
    moneyColumn("amount", l("col.amount"), (row) => row.amountMinor, () => currency, locale)
  ];

  return (
    <section className="flex flex-col gap-3">
      <h2 className="eyebrow">{title}</h2>
      <Table
        columns={columns}
        rows={section.rows}
        rowKey={(row) => row.accountCode}
        caption={title}
        density="compact"
        empty={<Empty t={t} />}
        footer={
          <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
            <span className="font-ui text-12 text-subtle">{l("col.total")}</span>
            <Money
              amountMinor={section.totalMinor}
              currency={currency}
              locale={locale}
              className="font-ui text-14 font-medium text-text"
            />
          </div>
        }
      />
    </section>
  );
}

function PnlView({ pnl, accounts, locale, l, t }: ViewProps & { pnl: Pnl }) {
  const currency = pnl.currency;
  return (
    <section className="flex flex-col gap-6">
      <p className="font-ui text-13 text-subtle">
        {l("param.period")}: <span className="tabular-nums text-text">{pnl.periodCode}</span>
      </p>
      <KPIWall>
        <Stat
          label={l("pnl.income")}
          value={<Money amountMinor={pnl.income.totalMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("pnl.expense")}
          value={<Money amountMinor={pnl.expense.totalMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("pnl.margin")}
          value={<Money amountMinor={pnl.grossMarginMinor} currency={currency} locale={locale} signed />}
        />
        <Stat
          label={l("pnl.marginPct")}
          // A ratio, not money: percent formatting is the honest rendering.
          value={new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
            pnl.marginPpm / 1_000_000
          )}
        />
      </KPIWall>
      <SectionTable
        section={pnl.income}
        title={l("pnl.income")}
        currency={currency}
        accounts={accounts}
        locale={locale}
        l={l}
        t={t}
      />
      <SectionTable
        section={pnl.expense}
        title={l("pnl.expense")}
        currency={currency}
        accounts={accounts}
        locale={locale}
        l={l}
        t={t}
      />
    </section>
  );
}

/* --------------------------------------------------------- 3. balance sheet */

function BalanceSheetView({ bs, accounts, locale, l, t }: ViewProps & { bs: BalanceSheet }) {
  const currency = bs.currency;
  const difference = bs.assets.totalMinor - (bs.liabilities.totalMinor + bs.equityMinor);
  return (
    <section className="flex flex-col gap-6">
      <AsOf value={bs.asOf} locale={locale} l={l} />
      <KPIWall>
        <Stat
          label={l("bs.assets")}
          value={<Money amountMinor={bs.assets.totalMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("bs.liabilities")}
          value={<Money amountMinor={bs.liabilities.totalMinor} currency={currency} locale={locale} />}
        />
        <Stat
          label={l("bs.equity")}
          value={<Money amountMinor={bs.equityMinor} currency={currency} locale={locale} />}
        />
        {/* The year's result is not equity until the year is closed, so it is
            named rather than folded in silently (docs/27 F3). */}
        {bs.currentYearUnpostedMinor === 0 ? null : (
          <Stat
            label={l("bs.equity.unposted")}
            value={<Money amountMinor={bs.currentYearUnpostedMinor} currency={currency} locale={locale} />}
            hint={l("bs.equity.unposted.hint")}
          />
        )}
      </KPIWall>

      {bs.balanced ? null : (
        <Discrepancy
          title={l("bs.unbalanced.title")}
          body={l("bs.unbalanced.body")}
          amountMinor={difference}
          currency={currency}
          locale={locale}
        />
      )}

      {/* Grid gap and column flow are writing-mode aware, so Arabic reorders
          assets and liabilities without a single physical property. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <SectionTable
          section={bs.assets}
          title={l("bs.assets")}
          currency={currency}
          accounts={accounts}
          locale={locale}
          l={l}
          t={t}
        />
        <SectionTable
          section={bs.liabilities}
          title={l("bs.liabilities")}
          currency={currency}
          accounts={accounts}
          locale={locale}
          l={l}
          t={t}
        />
        {bs.equity.rows.length === 0 ? null : (
          <SectionTable
            section={bs.equity}
            title={l("bs.equity.posted")}
            currency={currency}
            accounts={accounts}
            locale={locale}
            l={l}
            t={t}
          />
        )}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- 4. aged */

function AgedView({ rows, locale, l, t }: ViewProps & { rows: AgedRow[] }) {
  const currency = (row: AgedRow) => row.currency;
  const columns: Array<Column<AgedRow>> = [
    { key: "counterparty", header: l("aged.counterparty"), render: (row) => row.counterparty },
    { key: "currency", header: l("col.currency"), render: (row) => row.currency },
    moneyColumn("current", l("aged.current"), (row) => row.currentMinor, currency, locale),
    moneyColumn("d30", l("aged.d30"), (row) => row.d30Minor, currency, locale),
    moneyColumn("d60", l("aged.d60"), (row) => row.d60Minor, currency, locale),
    moneyColumn("d90", l("aged.d90"), (row) => row.d90Minor, currency, locale),
    moneyColumn("older", l("aged.older"), (row) => row.olderMinor, currency, locale),
    moneyColumn("total", l("col.total"), (row) => row.totalMinor, currency, locale)
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.counterparty}|${row.currency}`}
      caption={`${l("title")} — ${l("report.aged")}`}
      density="compact"
      empty={<Empty t={t} />}
      footer={
        <span className="font-ui text-12 tabular-nums text-subtle">
          {t("common.rows", { count: String(rows.length) })}
        </span>
      }
    />
  );
}

/* ----------------------------------------------------------- 5. commission */

function CommissionView({
  dimension,
  rows,
  locale,
  l,
  t
}: ViewProps & { dimension: string; rows: CommissionRow[] }) {
  const currency = (row: CommissionRow) => row.currency;
  const columns: Array<Column<CommissionRow>> = [
    { key: "value", header: l("commission.value"), render: (row) => row.value },
    { key: "currency", header: l("col.currency"), render: (row) => row.currency },
    moneyColumn("gross", l("commission.gross"), (row) => row.grossMinor, currency, locale),
    moneyColumn("channel", l("commission.channelShare"), (row) => row.channelShareMinor, currency, locale),
    moneyColumn("net", l("commission.net"), (row) => row.netMinor, currency, locale)
  ];
  return (
    <section className="flex flex-col gap-3">
      <p className="font-ui text-13 text-subtle">
        {l("commission.dimension")}: <span className="text-text">{dimension}</span>
      </p>
      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.value}|${row.currency}`}
        caption={`${l("title")} — ${l("report.commission")}`}
        density="compact"
        empty={<Empty t={t} />}
        footer={
          <span className="font-ui text-12 tabular-nums text-subtle">
            {t("common.rows", { count: String(rows.length) })}
          </span>
        }
      />
    </section>
  );
}

/* ------------------------------------------------------------ 6. bordereaux */
// docs/27 P2. Outbound only (see the API-side note beside `bordereauxRows`):
// the per-policy premium/commission listing an insurer expects from us, one
// row per commission entry rather than a settlement-grain total.

function BordereauxView({ rows, locale, l, t }: ViewProps & { rows: BordereauxRow[] }) {
  const currency = (row: BordereauxRow) => row.currency;
  const columns: Array<Column<BordereauxRow>> = [
    { key: "policyNo", header: l("bord.policy"), render: (row) => row.policyNo },
    { key: "providerId", header: l("bord.provider"), render: (row) => row.providerId },
    {
      key: "earnedAt",
      header: l("bord.earned"),
      render: (row) => <DateTime value={row.earnedAt} locale={locale} />
    },
    {
      key: "term",
      header: l("bord.term"),
      render: (row) => (
        <>
          <DateTime value={row.startAt} locale={locale} /> – <DateTime value={row.endAt} locale={locale} />
        </>
      )
    },
    moneyColumn("premium", l("bord.premium"), (row) => row.premiumMinor, currency, locale),
    moneyColumn("commission", l("bord.commission"), (row) => row.commissionMinor, currency, locale),
    { key: "kind", header: l("bord.kind"), render: (row) => row.kind }
  ];
  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.policyNo}|${row.earnedAt}`}
      caption={`${l("title")} — ${l("report.bordereaux")}`}
      density="compact"
      empty={<Empty t={t} />}
      footer={
        <span className="font-ui text-12 tabular-nums text-subtle">
          {t("common.rows", { count: String(rows.length) })}
        </span>
      }
    />
  );
}

/* --------------------------------------------------------- 7. client money */

function ClientMoneyView({ rows, locale, l, t }: ViewProps & { rows: ClientMoneyRow[] }) {
  const currency = (row: ClientMoneyRow) => row.currency;
  const short = rows.filter((row) => row.breach);
  const columns: Array<Column<ClientMoneyRow>> = [
    { key: "currency", header: l("col.currency"), render: (row) => row.currency },
    moneyColumn("asset", l("cm.asset"), (row) => row.assetMinor, currency, locale),
    moneyColumn("liability", l("cm.liability"), (row) => row.liabilityMinor, currency, locale),
    moneyColumn("surplus", l("cm.surplus"), (row) => row.surplusMinor, currency, locale),
    {
      key: "status",
      header: l("col.status"),
      render: (row) => (
        <Badge tone={row.breach ? "danger" : "success"} size="sm" dot>
          {row.breach ? l("cm.breach") : l("cm.ok")}
        </Badge>
      )
    }
  ];
  return (
    <section className="flex flex-col gap-6">
      {rows[0] ? <AsOf value={rows[0].asOf} locale={locale} l={l} /> : null}

      {short.map((row) => (
        <Discrepancy
          key={row.currency}
          title={`${l("cm.breachTitle")} — ${row.currency}`}
          body={l("cm.breachBody")}
          amountMinor={row.surplusMinor}
          currency={row.currency}
          locale={locale}
        />
      ))}

      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.currency}
        caption={`${l("title")} — ${l("report.client-money")}`}
        density="compact"
        empty={<Empty t={t} />}
      />
    </section>
  );
}

function AsOf({ value, locale, l }: { value: number; locale: string; l: Label }) {
  return (
    <p className="font-ui text-13 text-subtle">
      {l("asOf")} <DateTime value={value} locale={locale} precision="minute" className="text-text" />
    </p>
  );
}

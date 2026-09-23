import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AGENT_MARK,
  AgentBadge,
  Badge,
  Button,
  Card,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  Money,
  Ref,
  Sparkline,
  Stat,
  Table,
  Timeline,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe, names, type Names, type Problem } from "../api.server";
import { who } from "../names";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { humanise } from "../modules/spec";
import {
  Entry,
  Facts,
  Header,
  labelsFrom,
  nameOf,
  rowsOf,
  safe,
  sumBy,
  tag,
  type Label,
  type Page
} from "./detail-kit";
import { Gate } from "./staff";
import { useShellData } from "./workspace";
import { FALLBACK_CURRENCY } from "../calendar";

// One customer, everything the platform holds on them: what they bought, what
// they claimed, who they talked to, what they consented to, what they are worth
// and what to offer next. Every panel is its own scoped read — an actor holding
// only core:customers:read still gets a usable screen, just a shorter one.

/* --------------------------------------------------------------- contract */

export interface Customer {
  id: string;
  type: string;
  nameJson?: unknown;
  emailsJson?: unknown;
  phonesJson?: unknown;
  kycStatus: string;
  tagsJson?: unknown;
  riskFlagsJson?: unknown;
  ltvCached?: number | null;
  locale?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PolicyRow {
  id: string;
  policyNo: string;
  status: string;
  premiumMinor: number;
  commissionMinor: number;
  currency: string;
  startAt: number;
  endAt: number;
}

export interface ClaimRow {
  id: string;
  claimNo: string;
  status: string;
  amountMinor?: number | null;
  settledMinor?: number | null;
  currency: string;
  reportedAt: number;
}

export interface ConversationRow {
  id: string;
  channel: string;
  state: string;
  intent?: string | null;
  csat?: number | null;
  lastMessageAt?: number | null;
}

export interface ConsentRow {
  id: string;
  source: string;
  purposesJson?: unknown;
  version: number;
  ts: number;
  expiry?: number | null;
}

export interface FileRow {
  id: string;
  kind: string;
  contentType?: string | null;
  piiLevel: string;
  createdAt: number;
}

export interface OfferRow {
  id: string;
  kind: string;
  offeringId: string;
  score: number;
  expectedValueMinor?: number | null;
  currency?: string | null;
  reasonKey: string;
  state: string;
  model?: string | null;
}

export interface QuoteRequestRow {
  id: string;
  productId: string;
  state: string;
  bestPremiumMinor?: number | null;
  currency: string;
  createdAt: number;
}

export interface CaseSummaryRow {
  id: string;
  ref: string;
  kind: string;
  productLine?: string | null;
  status: string;
  priority: string;
  slaDueAt?: number | null;
  valueMinor?: number | null;
  currency?: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

export interface PositionLine {
  currency: string;
  premiumMinor: number | null;
  commissionMinor: number | null;
  settledMinor: number | null;
}

export interface PositionResponse {
  positions: PositionLine[];
  ltvMinor: number;
  currency: string;
}

/** JSON columns arrive as unknown; only an array of strings earns chips. Deduped: chipList keys on the value, and a repeat collides. */
export function chips(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === "string"))];
}

export const PERM = {
  read: "core:customers:read",
  policies: "axis:policies:read",
  claims: "axis:claims:read",
  cases: "axis:cases:read",
  audit: "core:audit:read",
  conversations: "orbit:conversations:read",
  consents: "core:consents:read",
  files: "core:files:read",
  offers: "dist:offers:read",
  surface: "dist:offers:surface",
  decide: "dist:offers:override",
  quotes: "dist:quote_requests:read"
} as const;

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Customer",
    intro: "Everything on file: cover held, claims made, conversations, consent and what to offer next.",
    back: "Back to customers",
    heroLede: "{type} customer · {kyc}",
    profileTitle: "Profile",
    type: "Type",
    kyc: "Identity check",
    locale: "Language",
    tags: "Tags",
    riskFlags: "Risk flags",
    since: "Customer since",
    positionTitle: "Position",
    positionHint: "Derived from the cover and claims on this screen, not from a ledger balance.",
    premiumWritten: "Premium written",
    commissionEarned: "Commission earned",
    claimsSettled: "Claims settled",
    lifetimeValue: "Lifetime value",
    policiesCaption: "Every agreement issued to this customer.",
    claimsCaption: "Every claim reported against their cover.",
    conversationsTitle: "Conversations",
    conversationsCaption: "Every thread with this customer.",
    quotesTitle: "Shopping",
    quotesCaption: "Comparative quote requests raised for this customer.",
    consentsTitle: "Consent",
    consentsCaption: "The permissions on file, newest first.",
    documentsTitle: "Documents",
    documentsCaption: "Files filed against this customer.",
    // A section on a 360 is empty for a reason the reader can act on: nothing
    // has happened yet, or the thing that would create a row lives on another
    // screen. Each body names which, and the card's own "Open" link is the
    // action — so these say where the row comes from, not "no data".
    nonePolicies: "This customer holds no cover yet. A bound quote becomes their first agreement.",
    noneClaims: "No claim has been reported against their cover.",
    noneCases: "Nothing is in flight. Quoting, underwriting and renewal work appears here while it is open.",
    noneConversations: "No one has spoken with this customer through Conversations yet.",
    noneQuotes: "They have not been quoted. Raise a comparative request to shop the market for them.",
    noneConsents: "No permissions are on file. Consent is recorded when the customer grants it.",
    noneDocuments: "No files are attached to this customer.",
    offersTitle: "Next best offer",
    offersCaption: "Ranked suggestions, with the signals behind each one.",
    offerWhy: "Why this",
    colCommission: "Commission",
    colTerm: "Term",
    colAmount: "Claimed",
    colSettled: "Settled",
    colReported: "Reported",
    colChannel: "Channel",
    colIntent: "Intent",
    colCsat: "Satisfaction",
    colLastMessage: "Last message",
    colProduct: "Product",
    colRaised: "Raised",
    colSource: "Source",
    colPurposes: "Purposes",
    colVersion: "Version",
    colGranted: "Granted",
    colExpiry: "Expires",
    colFormat: "Format",
    colFiled: "Filed",
    colScore: "Propensity",
    colValue: "Expected value",
    casesTitle: "Cases",
    casesCaption: "Work in flight for this customer: quoting, underwriting, renewals.",
    activityTitle: "Activity",
    activityCaption: "Who touched this record, newest first.",
    colProductLine: "Product line",
    colPriority: "Priority",
    colSla: "SLA due",
    colCaseValue: "Value",
    positionHintLedger: "Summed on the server from every agreement and claim on record.",
    surface: "Show to customer",
    surfaced: "Offer shown to the customer.",
    dismissed: "Offer dismissed.",
    offerRequired: "Pick an offer first."
  },
  ar: {
    title: "العميل",
    intro: "كل ما هو مسجّل: التغطية القائمة، المطالبات، المحادثات، الموافقات، وما يُعرض تاليًا.",
    back: "العودة إلى العملاء",
    heroLede: "عميل {type} · {kyc}",
    profileTitle: "الملف",
    type: "النوع",
    kyc: "التحقق من الهوية",
    locale: "اللغة",
    tags: "الوسوم",
    riskFlags: "مؤشرات الخطر",
    since: "عميل منذ",
    positionTitle: "الوضع المالي",
    positionHint: "مستخرج من التغطية والمطالبات في هذه الشاشة، وليس من رصيد دفتري.",
    premiumWritten: "الأقساط المكتتبة",
    commissionEarned: "العمولة المحققة",
    claimsSettled: "المطالبات المسددة",
    lifetimeValue: "القيمة الإجمالية",
    policiesCaption: "كل وثيقة صادرة لهذا العميل.",
    claimsCaption: "كل مطالبة مسجّلة على تغطيته.",
    conversationsTitle: "المحادثات",
    conversationsCaption: "كل محادثة مع هذا العميل.",
    quotesTitle: "طلبات الأسعار",
    quotesCaption: "طلبات المقارنة المفتوحة لهذا العميل.",
    consentsTitle: "الموافقات",
    consentsCaption: "الأذونات المسجّلة، الأحدث أولًا.",
    documentsTitle: "المستندات",
    documentsCaption: "الملفات المرفقة بهذا العميل.",
    nonePolicies: "لا يملك هذا العميل أي تغطية بعد. أول اتفاقية له تنشأ من عرض سعر مرتبط.",
    noneClaims: "لم تُسجَّل أي مطالبة على تغطيته.",
    noneCases: "لا يوجد عمل جارٍ. تظهر هنا أعمال التسعير والاكتتاب والتجديد ما دامت مفتوحة.",
    noneConversations: "لم يتحدث أحد مع هذا العميل عبر Conversations بعد.",
    noneQuotes: "لم يُسعَّر بعد. افتح طلب مقارنة لاستطلاع السوق له.",
    noneConsents: "لا توجد أذونات مسجّلة. تُسجَّل الموافقة عندما يمنحها العميل.",
    noneDocuments: "لا توجد ملفات مرفقة بهذا العميل.",
    offersTitle: "العرض الأنسب",
    offersCaption: "اقتراحات مرتبة، مع الإشارات التي بُنيت عليها.",
    offerWhy: "سبب الاقتراح",
    colCommission: "العمولة",
    colTerm: "المدة",
    colAmount: "المطلوب",
    colSettled: "المسدد",
    colReported: "تاريخ الإبلاغ",
    colChannel: "القناة",
    colIntent: "الغرض",
    colCsat: "الرضا",
    colLastMessage: "آخر رسالة",
    colProduct: "المنتج",
    colRaised: "تاريخ الطلب",
    colSource: "المصدر",
    colPurposes: "الأغراض",
    colVersion: "الإصدار",
    colGranted: "تاريخ المنح",
    colExpiry: "تاريخ الانتهاء",
    colFormat: "الصيغة",
    colFiled: "تاريخ الإيداع",
    colScore: "احتمال الشراء",
    colValue: "القيمة المتوقعة",
    casesTitle: "الحالات",
    casesCaption: "الأعمال الجارية لهذا العميل: التسعير، الاكتتاب، التجديدات.",
    activityTitle: "النشاط",
    activityCaption: "من تعامل مع هذا السجل، الأحدث أولًا.",
    colProductLine: "خط المنتج",
    colPriority: "الأولوية",
    colSla: "موعد اتفاقية الخدمة",
    colCaseValue: "القيمة",
    positionHintLedger: "محسوب على الخادم من كل الوثائق والمطالبات المسجّلة.",
    surface: "إظهار للعميل",
    surfaced: "تم إظهار العرض للعميل.",
    dismissed: "تم استبعاد العرض.",
    offerRequired: "اختر عرضًا أولًا."
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the customer's name: what kind of customer this is and
 * where their identity check stands — the two facts a desk reads first, no ✦
 * (arithmetic on the loaded record, not a model finding, CLAUDE.md §11). */
export function customerLede(customer: Pick<Customer, "type" | "kycStatus">, l: Label): string {
  return l("heroLede", { type: tag(l, "type", customer.type), kyc: tag(l, "kycStatus", customer.kycStatus) });
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const options = { env, request };
  const may = {
    read: held.has(PERM.read),
    surface: held.has(PERM.surface),
    decide: held.has(PERM.decide)
  };

  const empty = {
    customer: null as Customer | null,
    policies: [] as PolicyRow[],
    claims: [] as ClaimRow[],
    cases: [] as CaseSummaryRow[],
    activity: [] as AuditRow[],
    names: {} as Names,
    position: null as PositionResponse | null,
    conversations: [] as ConversationRow[],
    quotes: [] as QuoteRequestRow[],
    consents: [] as ConsentRow[],
    documents: [] as FileRow[],
    offers: [] as OfferRow[],
    may,
    idempotencyKey: crypto.randomUUID()
  };

  if (!may.read) return { ...empty, may: { ...may, read: false } };

  const scope = `?customerId=${encodeURIComponent(id)}&limit=50`;
  const [customer, policies, claims, cases, activity, position, conversations, quotes, consents, documents, offers] =
    await Promise.all([
      safe(() => api<Customer>(`/v1/core/customers/${id}`, options), null),
      held.has(PERM.policies)
        ? safe(() => api<Page<PolicyRow>>(`/v1/axis/policies${scope}`, options), null)
        : null,
      held.has(PERM.claims)
        ? safe(() => api<Page<ClaimRow>>(`/v1/axis/claims${scope}`, options), null)
        : null,
      held.has(PERM.cases)
        ? safe(() => api<Page<CaseSummaryRow>>(`/v1/axis/cases${scope}`, options), null)
        : null,
      // Generated CRUD audits with the row's own id as subjectRef (crud.ts),
      // and core_audit_log has no createdAt — order on ts explicitly.
      held.has(PERM.audit)
        ? safe(
            () =>
              api<Page<AuditRow>>(
                `/v1/core/audit-log?subjectRef=${encodeURIComponent(id)}&limit=20&sort=ts&order=desc`,
                options
              ),
            null
          )
        : null,
      safe(() => api<PositionResponse>(`/v1/core/customers/${id}/position`, options), null),
      held.has(PERM.conversations)
        ? safe(() => api<Page<ConversationRow>>(`/v1/orbit/conversations${scope}`, options), null)
        : null,
      held.has(PERM.quotes)
        ? safe(() => api<Page<QuoteRequestRow>>(`/v1/dist/quote-requests${scope}`, options), null)
        : null,
      held.has(PERM.consents)
        ? safe(() => api<Page<ConsentRow>>(`/v1/core/consents${scope}`, options), null)
        : null,
      // Files hang off a subject reference rather than a column (core_files).
      held.has(PERM.files)
        ? safe(
            () =>
              api<Page<FileRow>>(
                `/v1/core/files?subjectRef=${encodeURIComponent(`customer:${id}`)}&limit=50`,
                options
              ),
            null
          )
        : null,
      held.has(PERM.offers)
        ? safe(() => api<Page<OfferRow>>(`/v1/dist/next-best-offers${scope}`, options), null)
        : null
    ]);

  // The activity timeline attributes each entry to an actor ref; without a name
  // the customer's own history reads as a column of ULIDs.
  const resolved = await names(rowsOf(activity).map((row) => row.actorRef), options);

  return {
    ...empty,
    names: resolved,
    customer,
    policies: rowsOf(policies),
    claims: rowsOf(claims),
    cases: rowsOf(cases),
    activity: rowsOf(activity),
    position,
    conversations: rowsOf(conversations),
    quotes: rowsOf(quotes),
    consents: rowsOf(consents),
    documents: rowsOf(documents),
    offers: rowsOf(offers)
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const nothing = { done: null as string | null, problem: null as Problem | null, error: null as string | null };

  if (intent !== "surface" && intent !== "dismiss") {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }

  const offerId = String(form.get("offerId") ?? "").trim();
  if (!offerId) return { ...nothing, error: "offerRequired" };

  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { "idempotency-key": key } : undefined;
  try {
    if (intent === "surface") {
      // Consequential: this puts a priced offer in front of a customer (docs/15).
      await api<void>(`/v1/dist/next-best-offers/${offerId}/surface`, {
        env,
        request,
        method: "POST",
        ...(headers ? { headers } : {})
      });
      return { ...nothing, done: "surfaced" };
    }
    await api<void>(`/v1/dist/next-best-offers/${offerId}/decide`, {
      env,
      request,
      method: "POST",
      body: { decision: "dismissed" },
      ...(headers ? { headers } : {})
    });
    return { ...nothing, done: "dismissed" };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function Customer360() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);
  const tenantCurrency = shell?.currency ?? FALLBACK_CURRENCY;
  const busy = navigation.state !== "idle";
  const chipList = (values: string[], tone?: "danger") =>
    values.length === 0 ? (
      <span>—</span>
    ) : (
      <span className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} size="sm" {...(tone ? { tone } : {})}>
            {value}
          </Badge>
        ))}
      </span>
    );

  if (!loaded.may.read || !loaded.customer) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("title")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const customer = loaded.customer;
  const currency = loaded.policies[0]?.currency ?? loaded.claims[0]?.currency ?? tenantCurrency;
  const premium = sumBy(loaded.policies, (row) => row.premiumMinor);
  const commission = sumBy(loaded.policies, (row) => row.commissionMinor);
  const settled = sumBy(loaded.claims, (row) => row.settledMinor);

  const policyColumns: Array<Column<PolicyRow>> = [
    {
      key: "policyNo",
      header: l("policyNo"),
      render: (row) => (
        <Link to={`/axis/policies/${row.id}/detail`} className="font-mono text-12 text-accent hover:underline">
          {row.policyNo}
        </Link>
      )
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "premiumMinor",
      header: l("premiumMinor"),
      numeric: true,
      render: (row) => <Money amountMinor={row.premiumMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "commissionMinor",
      header: l("colCommission"),
      numeric: true,
      render: (row) => <Money amountMinor={row.commissionMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "endAt",
      header: l("colTerm"),
      render: (row) => <DateTime value={row.endAt} locale={locale} precision="day" />
    }
  ];

  const claimColumns: Array<Column<ClaimRow>> = [
    {
      key: "claimNo",
      header: l("claimNo"),
      render: (row) => (
        <Link to={`/axis/claims/${row.id}/detail`} className="font-mono text-12 text-accent hover:underline">
          {row.claimNo}
        </Link>
      )
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "amountMinor",
      header: l("colAmount"),
      numeric: true,
      render: (row) => <Money amountMinor={row.amountMinor ?? 0} currency={row.currency} locale={locale} />
    },
    {
      key: "settledMinor",
      header: l("colSettled"),
      numeric: true,
      render: (row) => <Money amountMinor={row.settledMinor ?? 0} currency={row.currency} locale={locale} />
    },
    {
      key: "reportedAt",
      header: l("colReported"),
      render: (row) => <DateTime value={row.reportedAt} locale={locale} precision="day" />
    }
  ];

  const caseColumns: Array<Column<CaseSummaryRow>> = [
    {
      key: "ref",
      header: l("colRef"),
      render: (row) => (
        <Link to={`/axis/cases/${row.id}/detail`} className="font-mono text-12 text-accent hover:underline">
          {row.ref}
        </Link>
      )
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    { key: "kind", header: l("colKind"), render: (row) => <span className="font-ui text-12">{tag(l, "kind", row.kind)}</span> },
    {
      key: "productLine",
      header: l("colProductLine"),
      render: (row) => <span className="font-ui text-12">{row.productLine ?? "—"}</span>
    },
    { key: "priority", header: l("colPriority"), render: (row) => <Badge size="sm">{tag(l, "priority", row.priority)}</Badge> },
    {
      key: "slaDueAt",
      header: l("colSla"),
      render: (row) => (row.slaDueAt ? <DateTime value={row.slaDueAt} locale={locale} precision="day" /> : <span>—</span>)
    },
    {
      key: "valueMinor",
      header: l("colCaseValue"),
      numeric: true,
      render: (row) =>
        row.valueMinor != null ? (
          <Money amountMinor={row.valueMinor} currency={row.currency ?? tenantCurrency} locale={locale} />
        ) : (
          <span>—</span>
        )
    }
  ];

  const conversationColumns: Array<Column<ConversationRow>> = [
    {
      key: "channel",
      header: l("colChannel"),
      render: (row) => (
        <Link to={`/orbit/conversations/${row.id}/thread`} className="font-ui text-12 text-accent hover:underline">
          {tag(l, "channel", row.channel)}
        </Link>
      )
    },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    { key: "intent", header: l("colIntent"), render: (row) => <span className="font-ui text-12">{row.intent ?? "—"}</span> },
    { key: "csat", header: l("colCsat"), numeric: true, render: (row) => <span className="tabular-nums">{row.csat ?? "—"}</span> },
    {
      key: "lastMessageAt",
      header: l("colLastMessage"),
      render: (row) =>
        row.lastMessageAt ? <DateTime value={row.lastMessageAt} locale={locale} precision="minute" /> : <span>—</span>
    }
  ];

  const quoteColumns: Array<Column<QuoteRequestRow>> = [
    { key: "productId", header: l("colProduct"), render: (row) => <Ref value={row.productId} className="text-12" /> },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    {
      key: "bestPremiumMinor",
      header: l("bestPremiumMinor"),
      numeric: true,
      render: (row) => <Money amountMinor={row.bestPremiumMinor ?? 0} currency={row.currency} locale={locale} />
    },
    {
      key: "createdAt",
      header: l("colRaised"),
      render: (row) => <DateTime value={row.createdAt} locale={locale} precision="day" />
    },
    {
      key: "open",
      header: l("open"),
      render: (row) => (
        <Link
          to={`/distribution/quote-requests/${row.id}/compare`}
          // Twenty links all named "Open" are twenty identical stops in a screen
          // reader's link list. The name has to say which one this is.
          aria-label={`${l("open")}: ${row.productId}`}
          className="font-ui text-12 text-accent hover:underline"
        >
          {l("open")}
        </Link>
      )
    }
  ];

  const consentColumns: Array<Column<ConsentRow>> = [
    { key: "source", header: l("colSource"), render: (row) => <Badge size="sm">{tag(l, "source", row.source)}</Badge> },
    {
      key: "purposesJson",
      header: l("colPurposes"),
      render: (row) => chipList(chips(row.purposesJson))
    },
    { key: "version", header: l("colVersion"), numeric: true, render: (row) => <span className="tabular-nums">{row.version}</span> },
    { key: "ts", header: l("colGranted"), render: (row) => <DateTime value={row.ts} locale={locale} precision="day" /> },
    {
      key: "expiry",
      header: l("colExpiry"),
      render: (row) => (row.expiry ? <DateTime value={row.expiry} locale={locale} precision="day" /> : <span>—</span>)
    }
  ];

  const fileColumns: Array<Column<FileRow>> = [
    { key: "kind", header: l("colKind"), render: (row) => <span className="font-ui text-12">{tag(l, "kind", row.kind)}</span> },
    { key: "contentType", header: l("colFormat"), render: (row) => <span className="font-mono text-12">{row.contentType ?? "—"}</span> },
    {
      key: "piiLevel",
      header: l("colSensitivity"),
      render: (row) => <Badge size="sm">{tag(l, "piiLevel", row.piiLevel)}</Badge>
    },
    { key: "createdAt", header: l("colFiled"), render: (row) => <DateTime value={row.createdAt} locale={locale} precision="day" /> }
  ];

  const csatPoints = [...loaded.conversations]
    .filter((row) => typeof row.csat === "number")
    .sort((a, b) => (a.lastMessageAt ?? 0) - (b.lastMessageAt ?? 0))
    .map((row) => row.csat as number);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{nameOf(customer.nameJson, locale, customer.id)}</h1>
          <p className="font-ui text-13 text-muted">{customerLede(customer, l)}</p>
          <Link to="/admin/customers" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("profileTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "kycStatus", customer.kycStatus)}
          </Badge>
        }
      >
        <Facts>
          <Entry term={l("type")}>{tag(l, "type", customer.type)}</Entry>
          <Entry term={l("kyc")}>{tag(l, "kycStatus", customer.kycStatus)}</Entry>
          <Entry term={l("locale")}>{customer.locale ?? "—"}</Entry>
          <Entry term={l("tags")}>{chipList(chips(customer.tagsJson))}</Entry>
          <Entry term={l("riskFlags")}>{chipList(chips(customer.riskFlagsJson), "danger")}</Entry>
          <Entry term={l("since")}>
            <DateTime value={customer.createdAt} locale={locale} precision="day" />
          </Entry>
        </Facts>
      </Card>

      <Card title={l("positionTitle")}>
        {loaded.position && loaded.position.positions.length > 0 ? (
          <>
            <div className="flex flex-col gap-4">
              {loaded.position.positions.map((line) => (
                <div key={line.currency} className="grid grid-cols-2 gap-6 md:grid-cols-3">
                  <Stat
                    label={l("premiumWritten")}
                    value={
                      line.premiumMinor === null ? (
                        <span>—</span>
                      ) : (
                        <Money amountMinor={line.premiumMinor} currency={line.currency} locale={locale} />
                      )
                    }
                  />
                  <Stat
                    label={l("commissionEarned")}
                    value={
                      line.commissionMinor === null ? (
                        <span>—</span>
                      ) : (
                        <Money amountMinor={line.commissionMinor} currency={line.currency} locale={locale} />
                      )
                    }
                  />
                  <Stat
                    label={l("claimsSettled")}
                    value={
                      line.settledMinor === null ? (
                        <span>—</span>
                      ) : (
                        <Money amountMinor={line.settledMinor} currency={line.currency} locale={locale} />
                      )
                    }
                  />
                </div>
              ))}
              <Stat
                label={l("lifetimeValue")}
                value={
                  <Money amountMinor={loaded.position.ltvMinor} currency={loaded.position.currency} locale={locale} />
                }
              />
            </div>
            <p className="mt-3 font-ui text-12 text-subtle">{l("positionHintLedger")}</p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-6 md:grid-cols-4">
              <Stat label={l("premiumWritten")} value={<Money amountMinor={premium} currency={currency} locale={locale} />} />
              <Stat
                label={l("commissionEarned")}
                value={<Money amountMinor={commission} currency={currency} locale={locale} />}
              />
              <Stat label={l("claimsSettled")} value={<Money amountMinor={settled} currency={currency} locale={locale} />} />
              <Stat
                label={l("lifetimeValue")}
                value={<Money amountMinor={customer.ltvCached ?? 0} currency={currency} locale={locale} />}
              />
            </div>
            <p className="mt-3 font-ui text-12 text-subtle">{l("positionHint")}</p>
          </>
        )}
      </Card>

      {loaded.offers.length > 0 ? (
        <Card title={l("offersTitle")} actions={<AgentBadge size="sm" why={l("offersCaption")} />}>
          <p className="mb-3 font-ui text-12 text-subtle">{l("offersCaption")}</p>
          <ul className="flex flex-col gap-3">
            {loaded.offers.map((offer) => (
              <OfferCard
                key={offer.id}
                offer={offer}
                locale={locale}
                l={l}
                may={loaded.may}
                idempotencyKey={loaded.idempotencyKey}
                tenantCurrency={tenantCurrency}
                busy={busy}
              />
            ))}
          </ul>
          {result?.error ? (
            <p role="alert" className="mt-3 font-ui text-13 text-danger">
              {l(result.error)}
            </p>
          ) : null}
          {result?.done ? <p className="mt-3 font-ui text-13 text-success">{l(result.done)}</p> : null}
          {result?.problem ? <Gate problem={result.problem} l={l} /> : null}
        </Card>
      ) : null}

      <LinkedCard title={l("policies")} href="/axis/policies" open={l("open")}>
        <Table
          caption={l("policiesCaption")}
          columns={policyColumns}
          rows={loaded.policies}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("nonePolicies")} />}
        />
      </LinkedCard>

      <LinkedCard title={l("claims")} href="/axis/claims" open={l("open")}>
        <Table
          caption={l("claimsCaption")}
          columns={claimColumns}
          rows={loaded.claims}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneClaims")} />}
        />
      </LinkedCard>

      <LinkedCard title={l("casesTitle")} href="/axis/cases" open={l("open")}>
        <Table
          caption={l("casesCaption")}
          columns={caseColumns}
          rows={loaded.cases}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneCases")} />}
        />
      </LinkedCard>

      {loaded.activity.length > 0 ? (
        <Card title={l("activityTitle")}>
          <Timeline
            label={l("activityCaption")}
            locale={locale}
            events={loaded.activity.map((row) => ({
              id: row.id,
              // ponytail: audit actions are an open set of `module.resource.verb`
              // codes — humanise beats a label table nobody maintains; add
              // `action.*` keys per-code if a translated verb ever matters.
              title: humanise(row.action),
              at: row.ts,
              actor: who(row.actorRef, loaded.names) ?? ""
            }))}
          />
        </Card>
      ) : null}

      <LinkedCard title={l("conversationsTitle")} href="/orbit/conversations" open={l("open")}>
        {csatPoints.length >= 2 ? (
          <div className="p-4">
            <Sparkline values={csatPoints} label={l("colCsat")} />
          </div>
        ) : null}
        <Table
          caption={l("conversationsCaption")}
          columns={conversationColumns}
          rows={loaded.conversations}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneConversations")} />}
        />
      </LinkedCard>

      <LinkedCard title={l("quotesTitle")} href="/distribution/quote-requests" open={l("open")}>
        <Table
          caption={l("quotesCaption")}
          columns={quoteColumns}
          rows={loaded.quotes}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneQuotes")} />}
        />
      </LinkedCard>

      <LinkedCard title={l("consentsTitle")}>
        <Table
          caption={l("consentsCaption")}
          columns={consentColumns}
          rows={loaded.consents}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneConsents")} />}
        />
      </LinkedCard>

      <LinkedCard title={l("documentsTitle")}>
        <Table
          caption={l("documentsCaption")}
          columns={fileColumns}
          rows={loaded.documents}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneDocuments")} />}
        />
      </LinkedCard>
    </div>
  );
}

function LinkedCard({
  title,
  href,
  open,
  children
}: {
  title: string;
  /** List route for "see all"; rendered in the Card's actions slot. */
  href?: string;
  /** The shared `open` label — LinkedCard sits outside the component, so it is passed in. */
  open?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      title={title}
      padded={false}
      actions={
        href && open ? (
          <Link
            to={href}
            aria-label={`${open} · ${title}`}
            className="font-ui text-12 text-accent underline-offset-2 hover:underline"
          >
            {open}
          </Link>
        ) : undefined
      }
    >
      {children}
    </Card>
  );
}

function OfferCard({
  offer,
  locale,
  l,
  may,
  idempotencyKey,
  tenantCurrency,
  busy
}: {
  offer: OfferRow;
  locale: string;
  l: Label;
  may: { surface: boolean; decide: boolean };
  idempotencyKey: string;
  tenantCurrency: string;
  busy: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line p-3">
      <div className="flex flex-col gap-1">
        <span className="font-ui text-13 text-text">
          {tag(l, "kind", offer.kind)} {AGENT_MARK}
        </span>
        <span className="font-ui text-12 text-muted">{tag(l, "reason", offer.reasonKey)}</span>
        <Ref value={offer.offeringId} className="text-12 text-subtle" />
      </div>
      <div className="flex items-center gap-4">
        <ConfidenceMeter value={offer.score / 100} label={l("colScore")} className="w-32" />
        <Stat
          label={l("colValue")}
          value={
            <Money amountMinor={offer.expectedValueMinor ?? 0} currency={offer.currency ?? tenantCurrency} locale={locale} />
          }
        />
        <Badge size="sm">{tag(l, "state", offer.state)}</Badge>
        {may.surface && offer.state === "proposed" ? (
          <Form method="post">
            <input type="hidden" name="intent" value="surface" />
            <input type="hidden" name="offerId" value={offer.id} />
            <input type="hidden" name="idempotencyKey" value={`${idempotencyKey}:${offer.id}:surface`} />
            <Button type="submit" size="sm" variant="secondary" loading={busy}>
              {l("surface")}
            </Button>
          </Form>
        ) : null}
        {may.decide ? (
          <Form method="post">
            <input type="hidden" name="intent" value="dismiss" />
            <input type="hidden" name="offerId" value={offer.id} />
            <input type="hidden" name="idempotencyKey" value={`${idempotencyKey}:${offer.id}:dismiss`} />
            <Button type="submit" size="sm" variant="ghost" loading={busy}>
              {l("dismiss")}
            </Button>
          </Form>
        ) : null}
      </div>
    </li>
  );
}

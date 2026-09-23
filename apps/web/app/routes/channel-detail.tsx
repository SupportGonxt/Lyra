import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { Badge, Card, DateTime, EmptyState, Money, Ref, Stat, Table, type Column } from "@lyra/ui";
import { api, fetchMe, names } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import {
  Entry,
  Facts,
  Header,
  Payload,
  labelsFrom,
  nameOf,
  percentOf,
  rowsOf,
  safe,
  sumBy,
  tag,
  type Label,
  type Page
} from "./detail-kit";
import { useShellData } from "./workspace";
import { FALLBACK_CURRENCY } from "../calendar";

// One distribution channel: what it may sell, what it is paid, how much it is
// actually asking for, and where its money stands. Read-only — rate changes and
// partner activation are gated writes that already live on their own screens
// (ponytail: no action(), /distribution/commission-rates owns the rate change).

/* --------------------------------------------------------------- contract */

export interface Channel {
  id: string;
  key: string;
  kind: string;
  nameJson?: unknown;
  partnerId?: string | null;
  medium: string;
  collectsPayment: string;
  settlementTermsJson?: unknown;
  defaultCommissionPpm?: number | null;
  currency?: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface OfferingRow {
  id: string;
  productId: string;
  providerId: string;
  code: string;
  nameJson?: unknown;
  currency: string;
  status: string;
  baseCommissionPpm: number;
  channelKeysJson?: unknown;
}

export interface RateRow {
  id: string;
  offeringId?: string | null;
  productId?: string | null;
  line?: string | null;
  channelSharePpm: number;
  baseCommissionPpm?: number | null;
  flatFeeMinor: number;
  currency?: string | null;
  earnedOn: string;
  clawbackDays: number;
  effectiveFrom: number;
  effectiveTo?: number | null;
}

export interface QuoteRequestRow {
  id: string;
  productId: string;
  state: string;
  fanoutCount: number;
  respondedCount: number;
  bestPremiumMinor?: number | null;
  currency: string;
  createdAt: number;
}

export interface SettlementRow {
  id: string;
  period: string;
  grossMinor: number;
  adjustmentsMinor: number;
  netMinor: number;
  currency: string;
  state: string;
  updatedAt: number;
}

export const PERM = {
  read: "dist:channels:read",
  offerings: "dist:offerings:read",
  rates: "dist:rates:read",
  quotes: "dist:quote_requests:read",
  settlements: "dist:commissions:read"
} as const;

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    noneOfferings: "No version has been made available on this channel. Restrict one to this channel from its product record.",
    noneRates: "No commission rate is set, so nothing this channel sells will earn them anything yet.",
    noneQuotes: "This channel has not quoted anyone yet.",
    noneSettlements: "Nothing has been settled with this channel. A statement appears once a period closes.",
    intro: "What this channel may sell, what it is paid, what it is asking for, and where its money stands.",
    back: "Back to the channels",
    heroLede: "{kind} · {medium} · {status} · {n} live requests",
    profileTitle: "The channel",
    medium: "Arrives by",
    collects: "Takes the money",
    partner: "Partner",
    defaultShare: "Default share",
    kind: "Kind",
    termsTitle: "Settlement terms",
    offeringsTitle: "What it sells",
    offeringsCaption: "Versions this channel is allowed to distribute.",
    offeringsAll: "Nothing restricts a version to this channel, so it may sell all of them.",
    ratesTitle: "Commission",
    ratesCaption: "Every rate agreed with this channel. Rates are never edited — a change is a new row.",
    quotesTitle: "Demand",
    quotesCaption: "The most recent shopping requests that arrived through this channel.",
    settlementsTitle: "Money",
    settlementsCaption: "Every settlement run for this channel, newest first.",
    openQuotes: "Live requests",
    unsettled: "Awaiting payout",
    settledOut: "Paid out",
    colOffering: "Version",
    colScope: "Applies to",
    colShare: "Channel share",
    colFlatFee: "Flat fee",
    colEarnedOn: "Earned on",
    colClawback: "Clawback window",
    colEffective: "From",
    colFanout: "Asked",
    colResponded: "Answered",
    colPeriod: "Period",
    colGross: "Gross",
    colAdjustments: "Adjustments",
    colNet: "Net",
    scopeAll: "Everything",
    days: "{count} days",
    unnamed: "Unnamed",
    "kind.b2c": "Direct",
    "kind.b2b": "Partner",
    "medium.web": "Website",
    "medium.app": "Mobile app",
    "medium.portal": "Partner portal",
    "medium.api": "Interface",
    "medium.branch": "Branch",
    "medium.call_centre": "Call centre",
    "medium.embed": "Embedded",
    "collectsPayment.us": "We do",
    "collectsPayment.partner": "The partner does",
    "collectsPayment.underwriter": "The underwriter does",
    "earnedOn.issue": "Issue",
    "earnedOn.collection": "Collection"
  },
  ar: {
    noneOfferings: "لم يُتَح أي إصدار على هذه القناة. اقصر إصداراً على هذه القناة من سجل المنتج.",
    noneRates: "لم تُحدَّد نسبة عمولة، لذا لن يكسب هذا المنفذ شيئاً مما يبيعه بعد.",
    noneQuotes: "لم يسعّر هذا المنفذ لأحد بعد.",
    noneSettlements: "لم تُسوَّ أي مبالغ مع هذا المنفذ. يظهر الكشف بعد إقفال فترة.",
    intro: "ما تبيعه هذه القناة، وما تحصل عليه، وما تطلبه، وموقف مستحقاتها.",
    back: "العودة إلى القنوات",
    heroLede: "{kind} · {medium} · {status} · {n} طلب قائم",
    profileTitle: "القناة",
    medium: "طريقة الوصول",
    collects: "من يحصّل المبلغ",
    partner: "الشريك",
    defaultShare: "الحصة الافتراضية",
    kind: "النوع",
    termsTitle: "شروط التسوية",
    offeringsTitle: "ما تبيعه",
    offeringsCaption: "الإصدارات المسموح لهذه القناة بتوزيعها.",
    offeringsAll: "لا إصدار يقصر البيع على قناة معيّنة، لذا تستطيع بيعها كلها.",
    ratesTitle: "العمولة",
    ratesCaption: "كل نسبة متفق عليها مع هذه القناة. النسب لا تُعدّل، والتغيير سجل جديد.",
    quotesTitle: "الطلب",
    quotesCaption: "أحدث طلبات التسعير الواردة عبر هذه القناة.",
    settlementsTitle: "المستحقات",
    settlementsCaption: "كل تسوية نُفّذت لهذه القناة، الأحدث أولًا.",
    openQuotes: "طلبات قائمة",
    unsettled: "بانتظار الصرف",
    settledOut: "المصروف",
    colOffering: "الإصدار",
    colScope: "نطاق التطبيق",
    colShare: "حصة القناة",
    colFlatFee: "أجر ثابت",
    colEarnedOn: "تُستحق عند",
    colClawback: "مدة الاسترداد",
    colEffective: "يبدأ من",
    colFanout: "المطلوب",
    colResponded: "المُجاب",
    colPeriod: "الفترة",
    colGross: "الإجمالي",
    colAdjustments: "التسويات",
    colNet: "الصافي",
    scopeAll: "كل شيء",
    days: "{count} يومًا",
    unnamed: "بلا اسم",
    "kind.b2c": "مباشر",
    "kind.b2b": "شريك",
    "medium.web": "الموقع",
    "medium.app": "التطبيق",
    "medium.portal": "بوابة الشريك",
    "medium.api": "واجهة برمجية",
    "medium.branch": "الفرع",
    "medium.call_centre": "مركز الاتصال",
    "medium.embed": "مدمجة",
    "collectsPayment.us": "نحن",
    "collectsPayment.partner": "الشريك",
    "collectsPayment.underwriter": "جهة الاكتتاب",
    "earnedOn.issue": "الإصدار",
    "earnedOn.collection": "التحصيل"
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the channel's name: what kind of channel it is, how it
 * reaches customers, and how many quote requests are live right now — no ✦,
 * arithmetic on loaded rows, not a model finding (CLAUDE.md §11). */
export function channelLede(
  channel: Pick<Channel, "kind" | "medium" | "status">,
  openQuotes: number,
  l: Label
): string {
  return l("heroLede", {
    kind: tag(l, "kind", channel.kind),
    medium: tag(l, "medium", channel.medium),
    status: tag(l, "status", channel.status),
    n: String(openQuotes)
  });
}

/** A version is restricted to this channel only if its allow-list names it. */
export function sellsFor(key: string, offerings: readonly OfferingRow[]): OfferingRow[] {
  return offerings.filter(
    (offering) => Array.isArray(offering.channelKeysJson) && offering.channelKeysJson.includes(key)
  );
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const options = { env, request };

  const empty = {
    channel: null as Channel | null,
    offerings: [] as OfferingRow[],
    unrestricted: false,
    rates: [] as RateRow[],
    quotes: [] as QuoteRequestRow[],
    settlements: [] as SettlementRow[],
    named: {} as Record<string, string>
  };

  if (!held.has(PERM.read)) return empty;
  const [channel, offeringPage, rates, quotes, settlements] = await Promise.all([
    safe(() => api<Channel>(`/v1/dist/channels/${id}`, options), null),
    // There is no `?channelId=` on offerings: the allow-list is a JSON column,
    // so the filtering happens here, on the channel's key.
    held.has(PERM.offerings) ? safe(() => api<Page<OfferingRow>>("/v1/dist/offerings?limit=100", options), null) : null,
    held.has(PERM.rates)
      ? safe(
          () =>
            api<Page<RateRow>>(`/v1/dist/commission-rates?channelId=${id}&sort=effectiveFrom&order=desc&limit=50`, options),
          null
        )
      : null,
    held.has(PERM.quotes)
      ? safe(
          () =>
            api<Page<QuoteRequestRow>>(
              `/v1/dist/quote-requests?channelId=${id}&sort=createdAt&order=desc&limit=50`,
              options
            ),
          null
        )
      : null,
    held.has(PERM.settlements)
      ? safe(
          () =>
            api<Page<SettlementRow>>(
              `/v1/ledger/settlements?counterpartyRef=${encodeURIComponent(`channel:${id}`)}&sort=period&order=desc&limit=25`,
              options
            ),
          null
        )
      : null
  ]);
  if (!channel) return empty;

  const all = rowsOf(offeringPage);
  const mine = sellsFor(channel.key, all);
  const quoteRows = rowsOf(quotes);
  // Both tables show what is being sold. A product's name belongs in the cell;
  // its id belongs in the link.
  const named = await names(
    [...mine.map((row) => row.productId), ...quoteRows.map((row) => row.productId)],
    options
  ).catch(() => ({}) as Record<string, string>);
  return {
    ...empty,
    channel,
    offerings: mine,
    unrestricted: all.length > 0 && mine.length === 0,
    rates: rowsOf(rates),
    quotes: quoteRows,
    settlements: rowsOf(settlements),
    named
  };
}

/* --------------------------------------------------------------- component */

export default function ChannelDetail() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);

  if (!loaded.channel) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("profileTitle")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const channel = loaded.channel;
  const currency = channel.currency ?? loaded.settlements[0]?.currency ?? shell?.currency ?? FALLBACK_CURRENCY;
  const open = loaded.quotes.filter((row) => row.state === "open" || row.state === "fanned_out").length;
  const unsettled = sumBy(
    loaded.settlements.filter((row) => row.state !== "paid"),
    (row) => row.netMinor
  );
  const paid = sumBy(
    loaded.settlements.filter((row) => row.state === "paid"),
    (row) => row.netMinor
  );

  const offeringColumns: Array<Column<OfferingRow>> = [
    {
      key: "code",
      header: l("colOffering"),
      render: (row) => (
        <span className="flex flex-col">
          <span className="font-ui text-12 text-text">{nameOf(row.nameJson, locale, l("unnamed"))}</span>
          <span className="font-mono text-12 text-subtle">{row.code}</span>
        </span>
      )
    },
    {
      key: "productId",
      header: l("colScope"),
      render: (row) => (
        <Link to={`/admin/products/${row.productId}/detail`} className="font-ui text-12 text-accent hover:underline">
          {loaded.named[row.productId] ?? <Ref value={row.productId} />}
        </Link>
      )
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "baseCommissionPpm",
      header: l("colShare"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{percentOf(row.baseCommissionPpm, locale)}</span>
    }
  ];

  const rateColumns: Array<Column<RateRow>> = [
    {
      key: "offeringId",
      header: l("colScope"),
      render: (row) => (
        <Ref value={row.offeringId ?? row.productId ?? row.line} className="text-12" fallback={l("scopeAll")} />
      )
    },
    {
      key: "channelSharePpm",
      header: l("colShare"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{percentOf(row.channelSharePpm, locale)}</span>
    },
    {
      key: "flatFeeMinor",
      header: l("colFlatFee"),
      numeric: true,
      render: (row) => <Money amountMinor={row.flatFeeMinor} currency={row.currency ?? currency} locale={locale} />
    },
    {
      key: "earnedOn",
      header: l("colEarnedOn"),
      render: (row) => <span className="font-ui text-12">{tag(l, "earnedOn", row.earnedOn)}</span>
    },
    {
      key: "clawbackDays",
      header: l("colClawback"),
      numeric: true,
      render: (row) => <span className="font-ui text-12">{l("days", { count: String(row.clawbackDays) })}</span>
    },
    {
      key: "effectiveFrom",
      header: l("colEffective"),
      render: (row) => <DateTime value={row.effectiveFrom} locale={locale} precision="day" />
    }
  ];

  const quoteColumns: Array<Column<QuoteRequestRow>> = [
    {
      key: "productId",
      header: l("colScope"),
      render: (row) => (
        <Link to={`/admin/products/${row.productId}/detail`} className="font-ui text-12 text-accent hover:underline">
          {loaded.named[row.productId] ?? <Ref value={row.productId} />}
        </Link>
      )
    },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    {
      key: "fanoutCount",
      header: l("colFanout"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{row.fanoutCount}</span>
    },
    {
      key: "respondedCount",
      header: l("colResponded"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{row.respondedCount}</span>
    },
    {
      key: "bestPremiumMinor",
      header: l("bestPremiumMinor"),
      numeric: true,
      render: (row) =>
        row.bestPremiumMinor != null ? (
          <Money amountMinor={row.bestPremiumMinor} currency={row.currency} locale={locale} />
        ) : (
          <span>—</span>
        )
    },
    {
      key: "createdAt",
      header: l("colCreated"),
      render: (row) => <DateTime value={row.createdAt} locale={locale} precision="day" />
    }
  ];

  const settlementColumns: Array<Column<SettlementRow>> = [
    {
      key: "period",
      header: l("colPeriod"),
      render: (row) => (
        <Link to={`/ledger/settlements/${row.id}`} className="font-mono text-12 text-accent hover:underline">
          {row.period}
        </Link>
      )
    },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    {
      key: "grossMinor",
      header: l("colGross"),
      numeric: true,
      render: (row) => <Money amountMinor={row.grossMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "adjustmentsMinor",
      header: l("colAdjustments"),
      numeric: true,
      render: (row) => <Money amountMinor={row.adjustmentsMinor} currency={row.currency} locale={locale} signed toned />
    },
    {
      key: "netMinor",
      header: l("colNet"),
      numeric: true,
      render: (row) => <Money amountMinor={row.netMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "updatedAt",
      header: l("colUpdated"),
      render: (row) => <DateTime value={row.updatedAt} locale={locale} precision="day" />
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{nameOf(channel.nameJson, locale, channel.key)}</h1>
          <p className="font-ui text-13 text-muted">{channelLede(channel, open, l)}</p>
          <Link to="/distribution/channels" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("profileTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "status", channel.status)}
          </Badge>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-6 md:grid-cols-3">
          <Stat label={l("openQuotes")} value={<span className="font-mono text-13">{open}</span>} />
          <Stat label={l("unsettled")} value={<Money amountMinor={unsettled} currency={currency} locale={locale} />} />
          <Stat label={l("settledOut")} value={<Money amountMinor={paid} currency={currency} locale={locale} />} />
        </div>
        <Facts>
          <Entry term={l("kind")}>{tag(l, "kind", channel.kind)}</Entry>
          <Entry term={l("medium")}>{tag(l, "medium", channel.medium)}</Entry>
          <Entry term={l("collects")}>{tag(l, "collectsPayment", channel.collectsPayment)}</Entry>
          <Entry term={l("partner")}>{channel.partnerId ?? "—"}</Entry>
          <Entry term={l("defaultShare")}>
            {channel.defaultCommissionPpm != null ? percentOf(channel.defaultCommissionPpm, locale) : "—"}
          </Entry>
          <Entry term={l("colCurrency")}>{channel.currency ?? "—"}</Entry>
        </Facts>
      </Card>

      <Card title={l("termsTitle")}>
        <Payload value={channel.settlementTermsJson} />
      </Card>

      <Card title={l("offeringsTitle")} padded={false}>
        <Table
          caption={l("offeringsCaption")}
          columns={offeringColumns}
          rows={loaded.offerings}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={loaded.unrestricted ? l("offeringsAll") : l("noneOfferings")} />}
        />
      </Card>

      <Card title={l("ratesTitle")} padded={false}>
        <Table
          caption={l("ratesCaption")}
          columns={rateColumns}
          rows={loaded.rates}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneRates")} />}
        />
      </Card>

      <Card title={l("quotesTitle")} padded={false}>
        <Table
          caption={l("quotesCaption")}
          columns={quoteColumns}
          rows={loaded.quotes}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneQuotes")} />}
        />
      </Card>

      <Card title={l("settlementsTitle")} padded={false}>
        <Table
          caption={l("settlementsCaption")}
          columns={settlementColumns}
          rows={loaded.settlements}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneSettlements")} />}
        />
      </Card>
    </div>
  );
}

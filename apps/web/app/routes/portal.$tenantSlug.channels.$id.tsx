import { Link, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { Badge, DateTime, EmptyState, Money, Panel, Stat, Table, Eyebrow, type Column } from "@lyra/ui";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { cloudflare } from "../context";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";
import { MONEY_LADDER } from "@lyra/core/portal";

// docs: PORTALS-DESIGN-AND-AUDIT.md §2. The channel's door: the book it wrote,
// the commission that is its own, where that money is, and the agreement behind
// it. Opens on a link the tenant mints (`GET /v1/dist/channels/:id/portal-link`)
// — no session, the token is the credential, a wrong one is a 404.
//
// The wall this page holds: it shows `channelCommissionMinor` and nothing else.
// The tenant's net margin and the insurer's gross receivable are the other two
// sides of the same sale and are not the channel's business — so they are absent
// from the payload entirely, not merely unrendered here.

interface ChannelView {
  channel: {
    id: string;
    key: string;
    kind: string;
    name: Record<string, string>;
    medium: string;
    collectsPayment: string;
    currency: string | null;
    status: string;
    defaultCommissionPpm: number | null;
    settlementTerms: Record<string, unknown> | null;
  };
  totals: { entries: number; grossMinor: number; yourShareMinor: number; currency: string | null };
  money: Record<string, number>;
  book: {
    id: string;
    subjectRef: string | null;
    offeringId: string | null;
    kind: string;
    premiumMinor: number;
    yourShareMinor: number;
    currency: string;
    state: string;
    earnedAt: number | null;
  }[];
  settlements: { id: string; period: string; netMinor: number; currency: string; state: string; externalRef: string | null }[];
  agreement: { kind: string; version: number; state: string; effectiveFrom: number | null; effectiveTo: number | null } | null;
}

/** The money ladder, in the order money moves. Only stages a channel can act on
 *  are shown; `written_off` is the tenant's decision, not theirs. */
// From `@lyra/core/portal`, so the ladder and the engine's `MONEY_STATES` are two
// views of one vocabulary rather than three lists that drift. The **subpath**, not
// the barrel: `@lyra/core`'s index re-exports `seed.js`, which reaches `@lyra/db`'s
// root and the `D1Database` Workers global a web bundle does not have.
const LADDER = MONEY_LADDER;

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "channel.kicker": "Channel partner",
    "channel.intro": "Your book, what it earned, and where that money is. Read-only.",
    "channel.back": "Back to the site",
    "channel.denied.title": "This link is no longer valid",
    "channel.denied.body":
      "Portal links are issued per channel and expire quietly rather than loudly. Ask your contact at the business for a fresh one.",
    "channel.book.title": "Your book",
    "channel.book.lede": "Written through this channel.",
    "channel.metric.policies": "Entries",
    "channel.metric.gross": "Gross written",
    "channel.metric.share": "Your commission",
    "channel.metric.settled": "Settled to date",
    "channel.money.title": "Where your money is",
    "channel.money.lede": "Each line is what your share is worth at that stage.",
    "channel.money.accrued": "Accrued",
    "channel.money.invoiced": "Invoiced",
    "channel.money.received": "Received",
    "channel.money.payable": "Payable to you",
    "channel.money.paid": "Paid",
    "channel.money.clawed_back": "Clawed back",
    // The engine's `MONEY_STATES` carries eight; this table carried six, so a
    // `disputed` entry — seeded today on the Meridian Bank embed channel — rendered
    // the literal key `channel.money.disputed` **to an external partner**
    // (`labelsIn` falls back to the key). `written_off` was the same defect with no
    // seed producing it, which is why the sweep found one and not two.
    "channel.money.disputed": "In dispute",
    "channel.money.written_off": "Written off",
    "channel.money.none": "Nothing outstanding",
    "channel.entries.title": "Recent entries",
    "channel.entries.empty.title": "Nothing yet",
    "channel.entries.empty.body": "Your first bind through this channel shows up here.",
    "channel.col.reference": "Reference",
    "channel.col.kind": "Type",
    "channel.col.premium": "Premium",
    "channel.col.share": "Your share",
    "channel.col.state": "State",
    "channel.col.earned": "Earned",
    "channel.kind.new_business": "New business",
    "channel.kind.renewal": "Renewal",
    "channel.kind.endorsement": "Endorsement",
    "channel.kind.clawback": "Clawback",
    "channel.kind.adjustment": "Adjustment",
    "channel.settlements.title": "Settlements",
    "channel.settlements.empty.title": "No settlement yet",
    "channel.settlements.empty.body": "A batch appears once a period closes on the commission you earned.",
    "channel.col.period": "Period",
    "channel.col.net": "Net",
    "channel.col.batchState": "State",
    "channel.col.proof": "Payment reference",
    "channel.state.draft": "Draft",
    "channel.state.approved": "Approved",
    "channel.state.paid": "Paid",
    "channel.state.disputed": "In dispute",
    "channel.agreement.title": "Your agreement",
    "channel.agreement.none.title": "No agreement on file",
    "channel.agreement.none.body": "Your contact sets the commercial terms up on the staff side.",
    "channel.agreement.kind": "Type",
    "channel.agreement.version": "Version",
    "channel.agreement.state": "State",
    "channel.agreement.from": "In force from",
    "channel.agreement.to": "In force to",
    "channel.agreement.open": "Open-ended"
  },
  ar: {
    "channel.kicker": "شريك التوزيع",
    "channel.intro": "دفترك، وما حققه، وأين توجد هذه الأموال. للقراءة فقط.",
    "channel.back": "العودة إلى الموقع",
    "channel.denied.title": "هذا الرابط لم يعد صالحًا",
    "channel.denied.body": "تُصدر روابط البوابة لكل قناة وتنتهي بهدوء. اطلب رابطًا جديدًا من جهة اتصالك.",
    "channel.book.title": "دفترك",
    "channel.book.lede": "مكتتب عبر هذه القناة.",
    "channel.metric.policies": "القيود",
    "channel.metric.gross": "إجمالي المكتتب",
    "channel.metric.share": "عمولتك",
    "channel.metric.settled": "المسوّى حتى الآن",
    "channel.money.title": "أين توجد أموالك",
    "channel.money.lede": "كل سطر هو قيمة حصتك في تلك المرحلة.",
    "channel.money.accrued": "مستحقة",
    "channel.money.invoiced": "مفوترة",
    "channel.money.received": "مستلمة",
    "channel.money.payable": "مستحقة الدفع لك",
    "channel.money.paid": "مدفوعة",
    "channel.money.clawed_back": "مستردة",
    "channel.money.disputed": "متنازع عليها",
    "channel.money.written_off": "مشطوبة",
    "channel.money.none": "لا مستحقات",
    "channel.entries.title": "قيود حديثة",
    "channel.entries.empty.title": "لا شيء بعد",
    "channel.entries.empty.body": "أول إصدار عبر هذه القناة يظهر هنا.",
    "channel.col.reference": "المرجع",
    "channel.col.kind": "النوع",
    "channel.col.premium": "القسط",
    "channel.col.share": "حصتك",
    "channel.col.state": "الحالة",
    "channel.col.earned": "تاريخ الاستحقاق",
    "channel.kind.new_business": "أعمال جديدة",
    "channel.kind.renewal": "تجديد",
    "channel.kind.endorsement": "ملحق",
    "channel.kind.clawback": "استرداد",
    "channel.kind.adjustment": "تسوية",
    "channel.settlements.title": "التسويات",
    "channel.settlements.empty.title": "لا تسوية بعد",
    "channel.settlements.empty.body": "تظهر الدفعة عند إغلاق فترة على العمولة التي حققتها.",
    "channel.col.period": "الفترة",
    "channel.col.net": "الصافي",
    "channel.col.batchState": "الحالة",
    "channel.col.proof": "مرجع الدفع",
    "channel.state.draft": "مسودة",
    "channel.state.approved": "معتمدة",
    "channel.state.paid": "مدفوعة",
    "channel.state.disputed": "متنازع عليها",
    "channel.agreement.title": "اتفاقك",
    "channel.agreement.none.title": "لا اتفاق محفوظ",
    "channel.agreement.none.body": "جهة اتصالك تضبط الشروط التجارية من جانب الموظفين.",
    "channel.agreement.kind": "النوع",
    "channel.agreement.version": "الإصدار",
    "channel.agreement.state": "الحالة",
    "channel.agreement.from": "ساري من",
    "channel.agreement.to": "ساري حتى",
    "channel.agreement.open": "مفتوح"
  }
};

export function labelsIn(locale: string): (key: string, vars?: Record<string, string>) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  const fallback = LABELS[DEFAULT_LOCALE]!;
  return (key, vars) => {
    const raw = table?.[key] ?? fallback[key] ?? key;
    const text = pseudoText(locale, raw);
    if (!vars) return text;
    return Object.entries(vars).reduce((out, [name, value]) => out.replaceAll(`{${name}}`, value), text);
  };
}

/** The channel's own name in the reader's language, falling back to what the
 *  tenant stored. A b2b channel seeded en-only still names itself on `ar`. */
export function channelName(name: Record<string, string> | null | undefined, locale: string): string {
  const names = name ?? {};
  return names[locale] ?? names[DEFAULT_LOCALE] ?? Object.values(names)[0] ?? "";
}

/** How full each stage's bar is, against the money the ladder accounts for.
 *  Exported so the bar maths is tested rather than eyeballed. */
export function ladderShares(money: Record<string, number>): { total: number; shares: Record<string, number> } {
  const total = LADDER.reduce((sum, state) => sum + Math.max(0, money[state] ?? 0), 0);
  const shares: Record<string, number> = {};
  for (const state of LADDER) {
    const amount = Math.max(0, money[state] ?? 0);
    shares[state] = total > 0 ? Math.round((amount / total) * 100) : 0;
  }
  return { total, shares };
}

interface SiteResponse {
  tenant: { name: string; brand: Brand };
}

type Loaded = { locale: string; tenantSlug: string; tenant: SiteResponse["tenant"] } &
  ({ ok: true; view: ChannelView } | { ok: false });

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<Loaded> {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const site = await api<SiteResponse>(`/v1/portal/${tenantSlug}/site`, { env, request }).catch(asRouteError);
  const base = { locale: localeFrom(request), tenantSlug, tenant: site.tenant };

  try {
    const view = await api<ChannelView>(
      `/v1/portal/${tenantSlug}/channels/${encodeURIComponent(params.id!)}?token=${encodeURIComponent(token)}`,
      { env, request }
    );
    return { ...base, ok: true, view };
  } catch (error) {
    // Same rule as the insurer's door: a stale link is a state with a page, not
    // a fault with a stack.
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return { ...base, ok: false };
    throw asRouteError(error);
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  {
    title:
      loaded?.ok ? `${loaded.tenant.name} — ${channelName(loaded.view.channel.name, loaded.locale)}` : (loaded?.tenant.name ?? "")
  }
];

export default function PortalChannel() {
  const loaded = useLoaderData<typeof loader>();
  const { locale, tenantSlug, tenant } = loaded;
  const l = labelsIn(locale);
  const logo = tenant.brand.logo?.light ?? tenant.brand.logo?.mark;

  // Same rule as the insurer's door: the message is the heading, so a reader
  // hears why the page is there before whose page it is. The intro paragraph
  // describes a book this reader cannot see, so it stays out of this state.
  if (!loaded.ok) {
    return (
      <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
        <div className="lyra-enter mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
          <header className="flex items-center gap-3">
            {logo ? <img src={logo} alt={tenant.name} className="h-10 w-auto" /> : null}
            <div className="flex flex-col gap-1">
              <Eyebrow>{l("channel.kicker")}</Eyebrow>
              <p className="font-ui text-13 text-muted">{tenant.name}</p>
            </div>
          </header>
          <Panel>
            <div className="flex flex-col gap-3">
              <h1 className="page-title">{l("channel.denied.title")}</h1>
              <p className="max-w-prose font-ui text-14 leading-body text-muted">{l("channel.denied.body")}</p>
              <Link to={`/portal/${tenantSlug}`} className="w-fit font-ui text-13 text-accent underline">
                {l("channel.back")}
              </Link>
            </div>
          </Panel>
        </div>
      </main>
    );
  }

  const view = loaded.view;
  const header = (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3">
        {logo ? <img src={logo} alt={tenant.name} className="h-10 w-auto" /> : null}
        <div className="flex flex-col gap-1">
          <Eyebrow>{l("channel.kicker")}</Eyebrow>
          <h1 className="page-title">{channelName(view.channel.name, locale)}</h1>
          <p className="font-ui text-13 text-muted">{l("channel.intro")}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        {view.agreement ? (
          <Badge tone={view.agreement.state === "active" ? "success" : "neutral"}>{l(`channel.state.${view.agreement.state}`)}</Badge>
        ) : null}
        <Link to={`/portal/${tenantSlug}`} className="font-ui text-13 text-accent underline">
          {l("channel.back")}
        </Link>
      </div>
    </header>
  );

  const money = (minor: number, currency: string | null) =>
    currency ? <Money amountMinor={minor} currency={currency} locale={locale} /> : "—";
  const currency = view.totals.currency ?? view.channel.currency;
  const { total, shares } = ladderShares(view.money);

  const entryColumns: Column<ChannelView["book"][number]>[] = [
    {
      key: "reference",
      header: l("channel.col.reference"),
      render: (row) => <span className="font-mono text-12">{row.subjectRef ?? row.id}</span>
    },
    { key: "kind", header: l("channel.col.kind"), render: (row) => l(`channel.kind.${row.kind}`) },
    { key: "premium", header: l("channel.col.premium"), numeric: true, render: (row) => money(row.premiumMinor, row.currency) },
    { key: "share", header: l("channel.col.share"), numeric: true, render: (row) => money(row.yourShareMinor, row.currency) },
    {
      key: "state",
      header: l("channel.col.state"),
      render: (row) => (
        <Badge
          tone={row.state === "paid" ? "success" : row.state === "clawed_back" ? "danger" : row.state === "disputed" ? "warning" : "neutral"}
        >
          {l(`channel.money.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "earned",
      header: l("channel.col.earned"),
      render: (row) => (row.earnedAt === null ? "—" : <DateTime value={row.earnedAt} precision="day" locale={locale} />)
    }
  ];

  const settlementColumns: Column<ChannelView["settlements"][number]>[] = [
    { key: "period", header: l("channel.col.period"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
    { key: "net", header: l("channel.col.net"), numeric: true, render: (row) => money(row.netMinor, row.currency) },
    {
      key: "state",
      header: l("channel.col.batchState"),
      render: (row) => (
        <Badge tone={row.state === "paid" ? "success" : row.state === "disputed" ? "danger" : row.state === "approved" ? "accent" : "neutral"}>
          {l(`channel.state.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "proof",
      header: l("channel.col.proof"),
      render: (row) => (row.externalRef ? <span className="font-mono text-12">{row.externalRef}</span> : "—")
    }
  ];

  const agreement = view.agreement;

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="lyra-enter mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        {header}

        <Panel eyebrow={l("channel.book.title")} lede={l("channel.book.lede")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={l("channel.metric.policies")} value={view.totals.entries} />
            <Stat label={l("channel.metric.gross")} value={money(view.totals.grossMinor, currency)} />
            <Stat label={l("channel.metric.share")} value={money(view.totals.yourShareMinor, currency)} />
            <Stat label={l("channel.metric.settled")} value={money(view.money.paid ?? 0, currency)} />
          </div>
        </Panel>

        <Panel eyebrow={l("channel.money.title")} lede={l("channel.money.lede")}>
          {total > 0 ? (
            <ul className="flex flex-col gap-3">
              {LADDER.map((state) => (
                <li key={state} className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="font-ui text-13 text-muted">{l(`channel.money.${state}`)}</span>
                    <span className="font-mono text-14 tabular-nums text-text">{money(view.money[state] ?? 0, currency)}</span>
                  </div>
                  {/* A bar, not a chart: the one question this answers is "how
                      much of my money is sitting where", and a proportion you
                      can see beats a second number you have to divide. */}
                  <div className="h-1 w-full overflow-hidden rounded-orbit bg-surface-2">
                    <div className="h-1 rounded-orbit bg-accent" style={{ width: `${shares[state] ?? 0}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="font-ui text-14 text-subtle">{l("channel.money.none")}</p>
          )}
        </Panel>

        <Panel eyebrow={l("channel.entries.title")} padded={false}>
          {view.book.length ? (
            <Table columns={entryColumns} rows={view.book} rowKey={(row) => row.id} caption={l("channel.entries.title")} />
          ) : (
            <div className="p-4">
              <EmptyState title={l("channel.entries.empty.title")} body={l("channel.entries.empty.body")} />
            </div>
          )}
        </Panel>

        <Panel eyebrow={l("channel.settlements.title")}>
          {view.settlements.length ? (
            <Table columns={settlementColumns} rows={view.settlements} rowKey={(row) => row.id} caption={l("channel.settlements.title")} />
          ) : (
            <EmptyState title={l("channel.settlements.empty.title")} body={l("channel.settlements.empty.body")} />
          )}
        </Panel>

        <Panel eyebrow={l("channel.agreement.title")}>
          {agreement ? (
            <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("channel.agreement.kind")}</dt>
                <dd className="font-ui text-14 text-text">{agreement.kind}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("channel.agreement.version")}</dt>
                <dd className="font-mono text-14 text-text">v{agreement.version}</dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("channel.agreement.from")}</dt>
                <dd className="font-ui text-14 text-text">
                  {agreement.effectiveFrom === null ? "—" : <DateTime value={agreement.effectiveFrom} precision="day" locale={locale} />}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="font-ui text-12 text-subtle">{l("channel.agreement.to")}</dt>
                <dd className="font-ui text-14 text-text">
                  {agreement.effectiveTo === null ? (
                    l("channel.agreement.open")
                  ) : (
                    <DateTime value={agreement.effectiveTo} precision="day" locale={locale} />
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <EmptyState title={l("channel.agreement.none.title")} body={l("channel.agreement.none.body")} />
          )}
        </Panel>
      </div>
    </main>
  );
}

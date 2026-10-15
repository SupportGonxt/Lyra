import { Link, useLoaderData, type LoaderFunctionArgs, type MetaFunction } from "react-router";
import { Badge, EmptyState, Money, Panel, Stat, Table, Eyebrow, type Column } from "@lyra/ui";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { cloudflare } from "../context";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";

// docs: PORTALS-DESIGN-AND-AUDIT.md §1. The insurer's door: its panel position,
// the data it subscribes to, and the settlement between it and the tenant.
//
// Opens on a link the tenant mints (`GET /v1/core/providers/:id/portal-link`),
// so there is no session and no password — the token in the URL is the whole
// credential, and the API answers 404 to a wrong one, another tenant's row or an
// unknown id alike. Read-only: nothing on this page writes.
//
// Two things the design gets right on purpose:
//   - a bench row below the tenant's k-anonymity floor is *absent*, not shown as
//     zero. A zeroed row reads "you win nothing here", which is the opposite of
//     what it means, and the page states the floor so the gap is legible;
//   - a link that no longer works is a *state*, not a crash. A forwarded or
//     truncated URL lands on a branded page that names the problem and offers
//     the one useful action, instead of the app's generic error panel.

/** ADR-0127. A hand-mirror of `Coverage` (packages/core/src/coverage.ts) as
 *  apps/api/src/engines/party-portals.ts serialises it. @lyra/web does not
 *  depend on @lyra/core in its manifest, so the type is mirrored here beside
 *  the name of the file it mirrors — the seam CLAUDE.md sighting 1 describes. */
type SupplierPosition = { present: boolean; minor?: number; note?: string };
type SupplierCoverage =
  | { kind: "reach"; unquotedRequests: number; declined: number }
  | { kind: "terms"; terms: { term: string; ours: SupplierPosition; panelMedian: SupplierPosition; note?: string }[] };

interface SupplierView {
  supplier: {
    id: string;
    name: string;
    kind: string;
    lines: string[];
    currency: string | null;
    panelStatus: string;
    settlementTerms: Record<string, unknown> | null;
  };
  position: {
    line: string;
    period: string;
    winRate: number | null;
    priceIndex: number | null;
    marketPriceIndex: number | null;
    volume: number;
    /** Mirrors `Coverage` in apps/api/src/engines/party-portals.ts, which is
     *  `Coverage` from packages/core/src/coverage.ts (ADR-0127): the two facts
     *  the column carried, now discriminated by `kind`. */
    coverage: SupplierCoverage | null;
  }[];
  kAnonymityFloor: number;
  products: { id: string; name: string; delivery: string; aggregationMin: number; consentBasis: string }[];
  settlement: {
    currency: string | null;
    receivableMinor: number;
    batches: { id: string; period: string; grossMinor: number; adjustmentsMinor: number; netMinor: number; state: string; externalRef: string | null }[];
  };
  ranking: { declared: boolean; payForPosition: boolean };
}

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "supplier.kicker": "Insurer portal",
    "supplier.intro": "How this panel sees you, and the settlement between us. Read-only.",
    "supplier.back": "Back to the site",
    "supplier.denied.title": "This link is no longer valid",
    "supplier.denied.body":
      "Links are issued per insurer and expire quietly rather than loudly. Ask your contact at the business for a fresh one.",
    "supplier.position.title": "Your panel position",
    "supplier.position.lede": "Ranking is declared and auditable. Nobody pays for position.",
    "supplier.metric.winRate": "Win rate",
    "supplier.metric.priceIndex": "Price vs market",
    "supplier.metric.volume": "Quotes priced",
    "supplier.metric.lines": "Lines on panel",
    "supplier.none": "Not enough yet",
    "supplier.byLine.title": "Where you win and lose",
    "supplier.byLine.empty.title": "Nothing benchmarked yet",
    "supplier.byLine.empty.body": "We have not benchmarked your lines in this period. It shows up here once the quotes are in.",
    "supplier.col.line": "Line",
    "supplier.col.period": "Period",
    "supplier.col.winRate": "Win rate",
    "supplier.col.price": "Price index",
    "supplier.col.volume": "Volume",
    "supplier.col.gaps": "Coverage gaps",
    "supplier.gaps.none": "None",
    "supplier.gaps.reach": "{unquoted} never quoted, {declined} declined",
    "supplier.products.title": "Data you subscribe to",
    "supplier.products.body": "Every figure is aggregated above a published floor, so no individual customer is identifiable.",
    "supplier.products.empty.title": "No subscriptions yet",
    "supplier.products.empty.body": "Your contact publishes these packs; ask them which ones fit the lines you write.",
    "supplier.products.floor": "Aggregated above {n}",
    "supplier.products.delivery": "Delivered as {how}",
    "supplier.delivery.api": "API",
    "supplier.delivery.report": "scheduled report",
    "supplier.settlement.title": "Settlement between us",
    "supplier.settlement.lede": "What is receivable on this book.",
    "supplier.settlement.receivable": "Net receivable",
    "supplier.settlement.empty.title": "No settlement yet",
    "supplier.settlement.empty.body": "A settlement appears once a period closes on the commission this book earned.",
    "supplier.col.batch": "Period",
    "supplier.col.gross": "Gross",
    "supplier.col.adjustments": "Adjustments",
    "supplier.col.net": "Net",
    "supplier.col.state": "State",
    "supplier.col.proof": "Payment reference",
    "supplier.state.draft": "Draft",
    "supplier.state.approved": "Approved",
    "supplier.state.paid": "Paid",
    "supplier.state.disputed": "In dispute",
    "supplier.panel.active": "On panel",
    "supplier.panel.paused": "Paused",
    "supplier.panel.inactive": "Off panel",
    "supplier.ranking.title": "About these numbers",
    "supplier.ranking.body":
      "Ranking is declared and auditable, and no provider pays for position. Any cell below the aggregation floor of {n} is withheld rather than shown thin."
  },
  ar: {
    "supplier.kicker": "بوابة شركة التأمين",
    "supplier.intro": "كيف ترى هذه اللجنة أداءك، والتسوية بيننا. للقراءة فقط.",
    "supplier.back": "العودة إلى الموقع",
    "supplier.denied.title": "هذا الرابط لم يعد صالحًا",
    "supplier.denied.body": "تُصدر الروابط لكل شركة تأمين وتنتهي بهدوء. اطلب رابطًا جديدًا من جهة اتصالك.",
    "supplier.position.title": "موقعك على اللجنة",
    "supplier.position.lede": "الترتيب معلن وقابل للتدقيق. ولا أحد يدفع مقابل الموقع.",
    "supplier.metric.winRate": "نسبة الفوز",
    "supplier.metric.priceIndex": "السعر مقابل السوق",
    "supplier.metric.volume": "عروض مسعّرة",
    "supplier.metric.lines": "خطوط على اللجنة",
    "supplier.none": "لا يكفي بعد",
    "supplier.byLine.title": "أين تفوز وأين تخسر",
    "supplier.byLine.empty.title": "لا قياس مرجعي بعد",
    "supplier.byLine.empty.body": "لم نقِس خطوطك في هذه الفترة. تظهر هنا بعد ورود العروض.",
    "supplier.col.line": "الخط",
    "supplier.col.period": "الفترة",
    "supplier.col.winRate": "نسبة الفوز",
    "supplier.col.price": "مؤشر السعر",
    "supplier.col.volume": "الحجم",
    "supplier.col.gaps": "فجوات التغطية",
    "supplier.gaps.none": "لا شيء",
    "supplier.gaps.reach": "{unquoted} بدون عرض سعر، و{declined} مرفوضة",
    "supplier.products.title": "البيانات المشترك بها",
    "supplier.products.body": "كل رقم مُجمَّع فوق حد منشور، فلا يمكن التعرف على أي عميل بمفرده.",
    "supplier.products.empty.title": "لا اشتراكات بعد",
    "supplier.products.empty.body": "جهة الاتصال تنشر هذه الحزم؛ اسألها أيها يناسب الخطوط التي تكتتبها.",
    "supplier.products.floor": "مُجمَّع فوق {n}",
    "supplier.products.delivery": "التسليم عبر {how}",
    "supplier.delivery.api": "واجهة برمجية",
    "supplier.delivery.report": "تقرير مجدول",
    "supplier.settlement.title": "التسوية بيننا",
    "supplier.settlement.lede": "ما يستحق على هذا الدفتر.",
    "supplier.settlement.receivable": "صافي المستحق",
    "supplier.settlement.empty.title": "لا تسوية بعد",
    "supplier.settlement.empty.body": "تظهر التسوية عند إغلاق فترة على العمولة التي حققها هذا الدفتر.",
    "supplier.col.batch": "الفترة",
    "supplier.col.gross": "الإجمالي",
    "supplier.col.adjustments": "التسويات",
    "supplier.col.net": "الصافي",
    "supplier.col.state": "الحالة",
    "supplier.col.proof": "مرجع الدفع",
    "supplier.state.draft": "مسودة",
    "supplier.state.approved": "معتمدة",
    "supplier.state.paid": "مدفوعة",
    "supplier.state.disputed": "متنازع عليها",
    "supplier.panel.active": "على اللجنة",
    "supplier.panel.paused": "متوقفة",
    "supplier.panel.inactive": "خارج اللجنة",
    "supplier.ranking.title": "عن هذه الأرقام",
    "supplier.ranking.body":
      "الترتيب معلن وقابل للتدقيق، ولا يدفع أي مزود مقابل الموقع. أي خلية دون حد التجميع {n} تُحجب بدل عرضها ناقصة."
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

interface SiteResponse {
  tenant: { name: string; brand: Brand };
}

type Loaded = { locale: string; tenantSlug: string; tenant: SiteResponse["tenant"] } & (
  | { ok: true; view: SupplierView }
  | { ok: false }
);

export async function loader({ request, params, context }: LoaderFunctionArgs): Promise<Loaded> {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const site = await api<SiteResponse>(`/v1/portal/${tenantSlug}/site`, { env, request }).catch(asRouteError);
  const base = { locale: localeFrom(request), tenantSlug, tenant: site.tenant };

  try {
    const view = await api<SupplierView>(
      `/v1/portal/${tenantSlug}/suppliers/${encodeURIComponent(params.id!)}?token=${encodeURIComponent(token)}`,
      { env, request }
    );
    return { ...base, ok: true, view };
  } catch (error) {
    // A wrong, missing or expired token is the one failure this page expects,
    // and it deserves a page rather than a stack: the tenant's own brand, the
    // reason, and the single action that fixes it. Anything else is a fault and
    // still belongs to the error boundary.
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return { ...base, ok: false };
    throw asRouteError(error);
  }
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded?.ok ? `${loaded.tenant.name} — ${loaded.view.supplier.name}` : (loaded?.tenant.name ?? "") }
];

/** Basis points against market (10 000 = parity) as a readable percent. */
export function priceVsMarket(index: number | null): number | null {
  if (index === null) return null;
  return Math.round((index - 10_000) / 100);
}

/** A signed percent, the way the index columns read it. */
export function signedPercent(value: number | null): string | null {
  return value === null ? null : `${value > 0 ? "+" : ""}${value}%`;
}

/**
 * The coverage column as text, or null for the empty state (ADR-0127).
 *
 * The column held two facts and the page rendered one word — "None" — for
 * both, because `parseArray` kept only strings and neither shape is one. A
 * `terms` fact lists the terms where our wording differs; a `reach` fact states
 * the counts of requests the panel answered and this provider never did. An
 * empty term list is genuinely "none": it is the fact "we differ on nothing",
 * which is a different claim from a null column.
 */
export function coverageText(
  coverage: SupplierView["position"][number]["coverage"],
  l: (key: string, vars?: Record<string, string>) => string
): string | null {
  if (coverage === null) return null;
  if (coverage.kind === "reach") {
    return l("supplier.gaps.reach", {
      unquoted: String(coverage.unquotedRequests),
      declined: String(coverage.declined)
    });
  }
  return coverage.terms.length ? coverage.terms.map((one) => one.term).join(", ") : null;
}

export default function PortalSupplier() {
  const loaded = useLoaderData<typeof loader>();
  const { locale, tenantSlug, tenant } = loaded;
  const l = labelsIn(locale);
  const logo = tenant.brand.logo?.light ?? tenant.brand.logo?.mark;

  // A stale link is still a page in the tenant's own brand, but the *message* is
  // the heading — a screen reader hears why the page is there before it hears
  // whose page it is. The intro paragraph would be a lie here (it describes a
  // position the reader cannot see), so it is not rendered.
  if (!loaded.ok) {
    return (
      <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
        <div className="lyra-enter mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
          <header className="flex items-center gap-3">
            {logo ? <img src={logo} alt={tenant.name} className="h-10 w-auto" /> : null}
            <div className="flex flex-col gap-1">
              <Eyebrow>{l("supplier.kicker")}</Eyebrow>
              <p className="font-ui text-13 text-muted">{tenant.name}</p>
            </div>
          </header>
          <Panel>
            <div className="flex flex-col gap-3">
              <h1 className="page-title">{l("supplier.denied.title")}</h1>
              <p className="max-w-prose font-ui text-14 leading-body text-muted">{l("supplier.denied.body")}</p>
              <Link to={`/portal/${tenantSlug}`} className="w-fit font-ui text-13 text-accent underline">
                {l("supplier.back")}
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
          <Eyebrow>{l("supplier.kicker")}</Eyebrow>
          <h1 className="page-title">{view.supplier.name}</h1>
          <p className="font-ui text-13 text-muted">{l("supplier.intro")}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Badge
          tone={view.supplier.panelStatus === "active" ? "success" : view.supplier.panelStatus === "paused" ? "warning" : "neutral"}
        >
          {l(`supplier.panel.${view.supplier.panelStatus}`)}
        </Badge>
        <Link to={`/portal/${tenantSlug}`} className="font-ui text-13 text-accent underline">
          {l("supplier.back")}
        </Link>
      </div>
    </header>
  );

  const money = (minor: number, currency: string | null) =>
    currency ? <Money amountMinor={minor} currency={currency} locale={locale} /> : "—";

  // Volume-weighted, because a line with nine quotes should not count as much as
  // one with nine hundred when the two are averaged into one headline.
  const withWin = view.position.filter((row) => row.winRate !== null);
  const winVolume = withWin.reduce((sum, row) => sum + row.volume, 0);
  const weightedWin = winVolume ? Math.round(withWin.reduce((sum, row) => sum + (row.winRate ?? 0) * row.volume, 0) / winVolume) : null;
  const totalVolume = view.position.reduce((sum, row) => sum + row.volume, 0);
  const priced = view.position.map((row) => priceVsMarket(row.priceIndex)).filter((value): value is number => value !== null);
  const averagePrice = priced.length ? Math.round(priced.reduce((sum, value) => sum + value, 0) / priced.length) : null;

  const positionColumns: Column<SupplierView["position"][number]>[] = [
    { key: "line", header: l("supplier.col.line"), render: (row) => row.line },
    { key: "period", header: l("supplier.col.period"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
    {
      key: "winRate",
      header: l("supplier.col.winRate"),
      numeric: true,
      render: (row) => (row.winRate === null ? "—" : `${row.winRate}%`)
    },
    {
      key: "price",
      header: l("supplier.col.price"),
      numeric: true,
      // Priced above market is the insurer's problem, not their win, so the tone
      // reads the way the business reads it (docs/01 §3).
      render: (row) => {
        const delta = priceVsMarket(row.priceIndex);
        const text = signedPercent(delta);
        if (text === null) return "—";
        return <span className={delta! > 0 ? "text-danger" : "text-success"}>{text}</span>;
      }
    },
    { key: "volume", header: l("supplier.col.volume"), numeric: true, render: (row) => row.volume },
    {
      key: "gaps",
      header: l("supplier.col.gaps"),
      // The two facts in the column render as themselves (ADR-0127): a `terms`
      // fact lists the terms, a `reach` fact states the counts, and only a null
      // column — nothing recorded — is the empty state. `parseArray` answered
      // "None" for both shapes here because neither produced a string.
      render: (row) => {
        const text = coverageText(row.coverage, l);
        return text === null ? <span className="text-subtle">{l("supplier.gaps.none")}</span> : text;
      }
    }
  ];

  const batchColumns: Column<SupplierView["settlement"]["batches"][number]>[] = [
    { key: "period", header: l("supplier.col.batch"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
    { key: "gross", header: l("supplier.col.gross"), numeric: true, render: (row) => money(row.grossMinor, view.settlement.currency) },
    { key: "adjustments", header: l("supplier.col.adjustments"), numeric: true, render: (row) => money(row.adjustmentsMinor, view.settlement.currency) },
    { key: "net", header: l("supplier.col.net"), numeric: true, render: (row) => money(row.netMinor, view.settlement.currency) },
    {
      key: "state",
      header: l("supplier.col.state"),
      render: (row) => (
        <Badge tone={row.state === "paid" ? "success" : row.state === "disputed" ? "danger" : row.state === "approved" ? "accent" : "neutral"}>
          {l(`supplier.state.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "proof",
      header: l("supplier.col.proof"),
      render: (row) => (row.externalRef ? <span className="font-mono text-12">{row.externalRef}</span> : "—")
    }
  ];

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="lyra-enter mx-auto flex w-full max-w-5xl flex-col gap-6 p-6">
        {header}

        <Panel eyebrow={l("supplier.position.title")} lede={l("supplier.position.lede")}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* Stat already sets the figure in Archivo 700 tabular, so the value
                goes in bare — a Figure wrapped in it would render two text
                treatments and stop the wall lining up on the decimal. */}
            <Stat label={l("supplier.metric.winRate")} value={weightedWin === null ? l("supplier.none") : `${weightedWin}%`} />
            <Stat label={l("supplier.metric.priceIndex")} value={averagePrice === null ? l("supplier.none") : signedPercent(averagePrice)!} />
            <Stat label={l("supplier.metric.volume")} value={totalVolume} />
            <Stat label={l("supplier.metric.lines")} value={view.supplier.lines.length} />
          </div>
        </Panel>

        <Panel eyebrow={l("supplier.byLine.title")} padded={false}>
          {view.position.length ? (
            <Table
              columns={positionColumns}
              rows={view.position}
              rowKey={(row) => `${row.line}:${row.period}`}
              caption={l("supplier.byLine.title")}
            />
          ) : (
            <div className="p-4">
              <EmptyState title={l("supplier.byLine.empty.title")} body={l("supplier.byLine.empty.body")} />
            </div>
          )}
        </Panel>

        <Panel eyebrow={l("supplier.products.title")} lede={l("supplier.products.body")}>
          {view.products.length ? (
            <ul className="flex flex-col divide-y divide-border">
              {view.products.map((product) => (
                <li key={product.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <span className="font-ui text-14 font-medium text-text">{product.name}</span>
                  <span className="font-ui text-12 text-subtle">
                    {l("supplier.products.floor", { n: String(product.aggregationMin) })} ·{" "}
                    {l("supplier.products.delivery", { how: l(`supplier.delivery.${product.delivery}`) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={l("supplier.products.empty.title")} body={l("supplier.products.empty.body")} />
          )}
        </Panel>

        <Panel eyebrow={l("supplier.settlement.title")} lede={l("supplier.settlement.lede")}>
          {view.settlement.batches.length ? (
            <div className="flex flex-col gap-4">
              <Stat label={l("supplier.settlement.receivable")} value={money(view.settlement.receivableMinor, view.settlement.currency)} />
              <Table columns={batchColumns} rows={view.settlement.batches} rowKey={(row) => row.id} caption={l("supplier.settlement.title")} />
            </div>
          ) : (
            <EmptyState title={l("supplier.settlement.empty.title")} body={l("supplier.settlement.empty.body")} />
          )}
        </Panel>

        <Panel eyebrow={l("supplier.ranking.title")}>
          <p className="font-ui text-14 leading-body text-muted">{l("supplier.ranking.body", { n: String(view.kAnonymityFloor) })}</p>
        </Panel>
      </div>
    </main>
  );
}

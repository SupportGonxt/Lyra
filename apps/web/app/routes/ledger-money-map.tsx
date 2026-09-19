import { Form, Link, useLoaderData, useNavigation, useSearchParams, type LoaderFunctionArgs } from "react-router";
import {
  Badge,
  Button,
  DateTime,
  EmptyState,
  Field,
  Input,
  Money,
  Stat,
  Table,
  formatMoney,
  type Column
} from "@lyra/ui";
import { api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { labelsFrom, ReportDownloads, safe, type Label } from "./detail-kit";
import { useShellData } from "./workspace";

// docs/22 §1.2 — the Money Map. "Sankey of value flow for a period: premium in
// → insurer remittance → commission retained → partner share → tax → net.
// Nodes are clickable to filtered journals. Client-money segregation shown as a
// distinct, always-visible bar."
//
// Nothing here computes money. Every figure is a number the ledger summed from
// journal lines (packages/ledger/src/money-map.ts); this file lays them out.
// Clicking a node opens the lines that add up to it, which is why the drill
// runs server-side against the same descriptor the node was summed with — a
// second filter written here would be a second story about the same money.

/* -------------------------------------------------------------- the contract */

// Shapes as apps/api returns them. Declared locally: the web app does not
// depend on @lyra/ledger, and the API's own contract test is what should fail
// if these drift.

interface MoneyMapNode {
  key: string;
  amountMinor: number;
  drill?: { accountCodes: string[]; side: string; txnTypes: string[] };
}

interface MoneyMap {
  periodCode: string;
  currency: string;
  asOf: number;
  nodes: MoneyMapNode[];
  links: Array<{ from: string; to: string; amountMinor: number }>;
  carriedMinor: number;
}

interface MoneyMapLine {
  txnId: string;
  seq: number;
  txnType: string;
  accountCode: string;
  side: string;
  amountMinor: number;
  baseAmountMinor: number;
  currency: string;
  memo: string | null;
  postedAt: number;
}

interface Drilled {
  node: string;
  periodCode: string;
  currency: string;
  totalMinor: number;
  lines: MoneyMapLine[];
}

interface ClientMoneyRow {
  currency: string;
  assetMinor: number;
  liabilityMinor: number;
  surplusMinor: number;
  breach: boolean;
  asOf: number;
}

const JOURNALS = "ledger:journals:read";
const CLIENT_MONEY = "ledger:client_money:read";

/* -------------------------------------------------------------- the diagram */

/** Left to right, the order the money actually moves. */
const COLUMNS: readonly (readonly string[])[] = [
  ["premium-in"],
  ["insurer-remittance", "commission-retained", "still-held"],
  ["partner-share", "tax", "net"]
];

export interface LaidOutNode {
  key: string;
  amountMinor: number;
  x: number;
  y: number;
  height: number;
  drillable: boolean;
}

export interface LaidOutLink {
  from: string;
  to: string;
  amountMinor: number;
  path: string;
  width: number;
}

const NODE_WIDTH = 14;
const NODE_GAP = 18;

/**
 * ponytail: hand-rolled bezier ribbons, same call the process map makes — no
 * chart library for six nodes.
 *
 * One scale for the whole diagram (pixels per minor unit, set by the tallest
 * column) so a ribbon's thickness is comparable across columns. Without it the
 * tax sliver would render as wide as the premium it came out of.
 */
export function layoutMap(map: MoneyMap, width: number, height: number): {
  nodes: LaidOutNode[];
  links: LaidOutLink[];
} {
  const amount = (key: string): number =>
    Math.max(0, map.nodes.find((n) => n.key === key)?.amountMinor ?? 0);
  const present = COLUMNS.map((column) => column.filter((key) => amount(key) > 0));
  const tallest = Math.max(
    1,
    ...present.map((column) => column.reduce((sum, key) => sum + amount(key), 0))
  );
  const columnCount = present.length;
  const columnWidth = columnCount > 1 ? (width - NODE_WIDTH) / (columnCount - 1) : 0;

  const positioned = new Map<string, LaidOutNode>();
  present.forEach((column, index) => {
    const gaps = Math.max(0, column.length - 1) * NODE_GAP;
    const scale = (height - gaps) / tallest;
    let y = 0;
    for (const key of column) {
      const nodeHeight = Math.max(3, amount(key) * scale);
      positioned.set(key, {
        key,
        amountMinor: amount(key),
        x: index * columnWidth,
        y,
        height: nodeHeight,
        drillable: Boolean(map.nodes.find((n) => n.key === key)?.drill)
      });
      y += nodeHeight + NODE_GAP;
    }
  });

  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const links: LaidOutLink[] = [];
  for (const link of map.links) {
    const source = positioned.get(link.from);
    const target = positioned.get(link.to);
    if (!source || !target || link.amountMinor <= 0) continue;
    // A ribbon is as thick as the node face it leaves, so the faces are used up
    // exactly: what flows out of a node equals what the node holds.
    const ribbon = Math.min(source.height, (link.amountMinor / source.amountMinor) * source.height);
    const sourceY = source.y + (outOffset.get(link.from) ?? 0);
    const targetY = target.y + (inOffset.get(link.to) ?? 0);
    outOffset.set(link.from, (outOffset.get(link.from) ?? 0) + ribbon);
    inOffset.set(link.to, (inOffset.get(link.to) ?? 0) + ribbon);

    const x1 = source.x + NODE_WIDTH;
    const x2 = target.x;
    const midX = (x1 + x2) / 2;
    const top = `M ${x1} ${sourceY} C ${midX} ${sourceY}, ${midX} ${targetY}, ${x2} ${targetY}`;
    const bottom =
      `L ${x2} ${targetY + ribbon} C ${midX} ${targetY + ribbon}, ${midX} ${sourceY + ribbon}, ` +
      `${x1} ${sourceY + ribbon} Z`;
    links.push({ ...link, path: `${top} ${bottom}`, width: ribbon });
  }

  return { nodes: [...positioned.values()], links };
}

/* ------------------------------------------------------------------ strings */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Money map",
    intro:
      "Where a period's money went: premium in, what the insurer took, what was kept, and how the kept part split. Every node opens the journal lines that add up to it.",
    "param.period": "Period",
    "param.currency": "Currency",
    "hint.period": "Month, e.g. 2026-07",
    "hint.currency": "ISO code, e.g. AED",
    "node.premium-in": "Premium in",
    "node.insurer-remittance": "Insurer remittance",
    "node.commission-retained": "Commission retained",
    "node.still-held": "Still held for clients",
    "node.partner-share": "Partner share",
    "node.tax": "Tax",
    "node.net": "Net to the business",
    "headline.breach": "{count} currency breach(es) in client money.",
    "headline.net": "{node} for {period}: {amount}.",
    carried: "Carried out of the period",
    carriedNegative:
      "Negative: this period paid out premium it collected earlier. Ordinary, and not a client-money breach — the segregation bar below is what says whether client money is whole.",
    "seg.title": "Client money segregation",
    "seg.asset": "Cash held",
    "seg.liability": "Owed to clients",
    "seg.margin": "Margin",
    "seg.breach": "Short",
    "seg.ok": "Whole",
    "seg.denied": "Your role cannot read the client-money position, so the segregation bar is hidden. The map above is unaffected.",
    "breach.title": "Client money is short",
    "breach.body":
      "Cash held is below what is owed to clients. This is a reportable breach: escalate it today, before the next remittance run.",
    "lines.title": "Journal lines behind this node",
    "lines.total": "These lines total",
    "lines.close": "Close",
    "lines.none": "No lines in this period",
    "lines.none.body": "A line is written when something is posted. Close a period, or post an entry, to see them.",
    "col.postedAt": "Posted",
    "col.txnType": "Transaction",
    "col.txnId": "Transaction id",
    "col.account": "Account",
    "col.side": "Side",
    "col.amount": "Amount",
    "col.memo": "Memo",
    "side.debit": "Debit",
    "side.credit": "Credit",
    "denied.title": "You cannot open the money map",
    "denied.body": "It needs a permission your role does not hold. An administrator can grant it.",
    empty: "Nothing was posted in this period",
    "empty.body": "Nothing moved, so there is no map to draw. Pick a period with activity.",
  },
  ar: {
    title: "خريطة الأموال",
    intro:
      "إلى أين ذهبت أموال الفترة: الأقساط الواردة، وما أخذه المؤمِّن، وما احتُفظ به، وكيف انقسم المحتفظ به. كل عقدة تفتح قيود اليومية التي تكوِّنه.",
    "param.period": "الفترة",
    "param.currency": "العملة",
    "hint.period": "الشهر، مثال 2026-07",
    "hint.currency": "رمز العملة، مثال AED",
    "node.premium-in": "الأقساط الواردة",
    "node.insurer-remittance": "التحويل إلى المؤمِّن",
    "node.commission-retained": "العمولة المحتجزة",
    "node.still-held": "محتفظ به للعملاء",
    "node.partner-share": "حصة الشريك",
    "node.tax": "الضريبة",
    "node.net": "الصافي للمنشأة",
    "headline.breach": "{count} تجاوزًا في أموال العملاء.",
    "headline.net": "{node} لفترة {period}: {amount}.",
    carried: "المرحَّل خارج الفترة",
    carriedNegative:
      "سالب: دفعت هذه الفترة أقساطًا حُصِّلت قبلها. هذا اعتيادي وليس خرقًا لأموال العملاء — شريط الفصل أدناه هو ما يحدد سلامتها.",
    "seg.title": "فصل أموال العملاء",
    "seg.asset": "النقد المحتفظ به",
    "seg.liability": "المستحق للعملاء",
    "seg.margin": "الهامش",
    "seg.breach": "عجز",
    "seg.ok": "مكتمل",
    "seg.denied": "لا يسمح دورك بقراءة وضع أموال العملاء، لذا أُخفي شريط الفصل. الخريطة أعلاه غير متأثرة.",
    "breach.title": "أموال العملاء ناقصة",
    "breach.body":
      "النقد المحتفظ به أقل من المستحق للعملاء. هذا خرق واجب الإبلاغ: صعِّده اليوم قبل دورة التحويل التالية.",
    "lines.title": "قيود اليومية خلف هذه العقدة",
    "lines.total": "إجمالي هذه القيود",
    "lines.close": "إغلاق",
    "lines.none": "لا توجد قيود في هذه الفترة",
    "lines.none.body": "يُكتب القيد عند ترحيل شيء. أقفل فترة أو رحّل قيداً لتراها.",
    "col.postedAt": "تاريخ الترحيل",
    "col.txnType": "المعاملة",
    "col.txnId": "معرّف المعاملة",
    "col.account": "الحساب",
    "col.side": "الطرف",
    "col.amount": "المبلغ",
    "col.memo": "البيان",
    "side.debit": "مدين",
    "side.credit": "دائن",
    "denied.title": "لا يمكنك فتح خريطة الأموال",
    "denied.body": "تتطلب صلاحية لا يملكها دورك. يمكن للمسؤول منحها.",
    empty: "لم يُرحَّل شيء في هذه الفترة",
    "empty.body": "لم يتحرك شيء، فلا خريطة تُرسم. اختر فترة فيها نشاط.",
  }
};

export const labelsIn = labelsFrom(LABELS);

// Hero headline: a client-money breach outranks everything (docs/22 §1.2 puts
// the flag above the fold), otherwise the map's own net node said back. No ✦,
// this is not an agent's finding (CLAUDE.md §11) — both numbers are the
// loader's. Nothing posted this period leaves no net node; the empty state
// below the header already says so, so the headline reuses that copy.
export function moneyMapHeadline(
  map: MoneyMap,
  breached: readonly { currency: string }[],
  l: Label,
  locale: string
): string {
  if (breached.length > 0) return l("headline.breach", { count: String(breached.length) });
  const net = map.nodes.find((node) => node.key === "net");
  if (!net) return l("empty");
  return l("headline.net", {
    node: l("node.net"),
    period: map.periodCode,
    amount: formatMoney(net.amountMinor, map.currency, locale)
  });
}

/* ------------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const incoming = new URL(request.url).searchParams;
  const period = (incoming.get("period") ?? "").trim();
  const currency = (incoming.get("currency") ?? "").trim().toUpperCase();
  const node = (incoming.get("node") ?? "").trim();

  const me = await fetchMe(env, request);
  if (!me.permissions.includes(JOURNALS)) return { denied: true as const };

  const query = new URLSearchParams();
  if (period) query.set("period", period);
  if (currency) query.set("currency", currency);

  const [map, clientMoney, drilled] = await Promise.all([
    api<MoneyMap>(`/v1/ledger/reports/value-flow?${query}`, { env, request }),
    // The bar is always on the page, but reading it is its own permission — a
    // role without it gets the map and a line saying why the bar is missing,
    // not a 403 for the whole screen.
    me.permissions.includes(CLIENT_MONEY)
      ? safe(
          () =>
            api<{ data: ClientMoneyRow[] }>(
              `/v1/ledger/reports/client-money${currency ? `?currency=${currency}` : ""}`,
              { env, request }
            ),
          { data: [] as ClientMoneyRow[] }
        )
      : Promise.resolve(null),
    node
      ? api<Drilled>(`/v1/ledger/reports/value-flow/lines?${query}&node=${encodeURIComponent(node)}`, {
          env,
          request
        }).catch(() => null)
      : Promise.resolve(null)
  ]);

  return {
    denied: false as const,
    map,
    clientMoney: clientMoney?.data ?? null,
    drilled,
    // The same period and currency the map was read with, so the file and the
    // diagram are one answer. Ends on a separator: the view names the format.
    exportUrl: `${env.API_ORIGIN}/v1/ledger/reports/value-flow/export?${query.toString()}${query.size ? "&" : ""}`
  };
}

/* --------------------------------------------------------------------- view */

const WIDTH = 880;
const HEIGHT = 380;

/** Node fill: the two that are not the aggregator's own money read as transit. */
function fillFor(key: string): string {
  if (key === "insurer-remittance" || key === "still-held") return "var(--vega-600)";
  if (key === "tax") return "var(--solar-500)";
  if (key === "net") return "var(--ion-500)";
  return "var(--accent)";
}

export default function LedgerMoneyMap() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (loaded.denied) {
    return <EmptyState title={l("denied.title")} body={l("denied.body")} />;
  }

  const map = loaded.map;
  const laid = layoutMap(map, WIDTH, HEIGHT);
  const breached = (loaded.clientMoney ?? []).filter((row) => row.breach);
  const drilled = loaded.drilled;

  /** The address of this screen with one parameter changed, filters kept. */
  const withNode = (key: string | null): string => {
    const next = new URLSearchParams(searchParams);
    if (key) next.set("node", key);
    else next.delete("node");
    return `?${next.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      {/* docs/22 §1.2: the breach flag sits above everything else on the page. */}
      {breached.length ? (
        <section
          data-flag="CM-BREACH-FLAG"
          role="alert"
          className="rounded-lg border border-danger bg-danger/10 p-4"
        >
          <h2 className="font-ui text-14 font-medium text-danger">{l("breach.title")}</h2>
          <p className="mt-1 max-w-prose font-ui text-13 text-text">{l("breach.body")}</p>
          <ul className="mt-2 flex flex-wrap gap-4">
            {breached.map((row) => (
              <li key={row.currency} className="font-mono text-13 tabular-nums text-text">
                {row.currency} <Money amountMinor={row.surplusMinor} currency={row.currency} signed />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {moneyMapHeadline(map, breached, l, locale)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("intro")}</p>
        </div>
      </header>

      <Form method="get" aria-label={l("title")} className="flex flex-wrap items-end gap-3">
        <Field label={l("param.period")} hint={l("hint.period")} className="w-52">
          <Input type="month" name="period" defaultValue={searchParams.get("period") ?? map.periodCode} />
        </Field>
        <Field label={l("param.currency")} hint={l("hint.currency")} className="w-32">
          <Input name="currency" maxLength={3} defaultValue={searchParams.get("currency") ?? ""} />
        </Field>
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
      </Form>

      <ReportDownloads url={loaded.exportUrl} l={l} />

      {laid.nodes.length === 0 ? (
        <EmptyState title={l("empty")} body={l("empty.body")} />
      ) : (
        // The diagram reads left to right in both locales: the ribbons are a
        // flow of time and money, not a line of text, and mirroring them would
        // put the insurer's money before the premium that paid it.
        <section dir="ltr" className="rounded-lg border border-border bg-surface-1 p-4">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT + 28}`} role="img" aria-label={l("title")} className="h-[420px] w-full">
            {laid.links.map((link) => (
              <path key={`${link.from}-${link.to}`} d={link.path} fill="var(--accent)" opacity={0.16} />
            ))}
            {laid.nodes.map((node) => {
              const face = (
                <g>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={NODE_WIDTH}
                    height={node.height}
                    rx={2}
                    fill={fillFor(node.key)}
                  />
                  <text x={node.x + NODE_WIDTH + 8} y={node.y + 12} className="fill-text font-ui text-12">
                    {l(`node.${node.key}`)}
                  </text>
                  <text
                    x={node.x + NODE_WIDTH + 8}
                    y={node.y + 26}
                    className="fill-subtle font-mono text-12 tabular-nums"
                  >
                    {formatMoney(node.amountMinor, map.currency, locale)}
                  </text>
                </g>
              );
              return node.drillable ? (
                <Link
                  key={node.key}
                  to={withNode(node.key)}
                  aria-current={drilled?.node === node.key ? "true" : undefined}
                  className="outline-none [&:focus-visible>g>rect]:stroke-accent [&:focus-visible>g>rect]:stroke-2 [&:hover>g>rect]:opacity-80"
                >
                  {face}
                </Link>
              ) : (
                <g key={node.key}>{face}</g>
              );
            })}
          </svg>
        </section>
      )}

      <section className="flex flex-wrap items-start gap-8">
        <Stat
          label={l("carried")}
          value={<Money amountMinor={map.carriedMinor} currency={map.currency} signed />}
        />
        {map.carriedMinor < 0 ? (
          <p className="max-w-prose font-ui text-13 text-subtle">{l("carriedNegative")}</p>
        ) : null}
      </section>

      <Segregation rows={loaded.clientMoney} label={l} />

      {drilled ? <Lines drilled={drilled} label={l} locale={locale} closeTo={withNode(null)} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------- segregation bar */

/**
 * Always on the page (docs/22 §1.2), one row per currency: cash held, what is
 * owed, and the margin between them. The bar turns `flare-500` the moment the
 * margin is negative — the same condition the API stamps as `breach`.
 */
function Segregation({ rows, label }: { rows: ClientMoneyRow[] | null; label: Label }) {
  if (rows === null) {
    return (
      <section className="rounded-lg border border-border bg-surface-1 p-4">
        <h2 className="font-ui text-14 font-medium text-text">{label("seg.title")}</h2>
        <p className="mt-1 max-w-prose font-ui text-13 text-subtle">{label("seg.denied")}</p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-surface-1 p-4">
      <h2 className="font-ui text-14 font-medium text-text">{label("seg.title")}</h2>
      <ul className="mt-3 flex flex-col gap-4">
        {rows.map((row) => {
          const scale = Math.max(row.assetMinor, row.liabilityMinor, 1);
          return (
            <li key={row.currency} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-3 font-ui text-13">
                <span className="font-medium text-text">{row.currency}</span>
                <span className="text-subtle">
                  {label("seg.asset")} <Money amountMinor={row.assetMinor} currency={row.currency} />
                </span>
                <span className="text-subtle">
                  {label("seg.liability")}{" "}
                  <Money amountMinor={row.liabilityMinor} currency={row.currency} />
                </span>
                <span className="text-subtle">
                  {label("seg.margin")}{" "}
                  <Money amountMinor={row.surplusMinor} currency={row.currency} signed />
                </span>
                <Badge tone={row.breach ? "danger" : "success"}>
                  {label(row.breach ? "seg.breach" : "seg.ok")}
                </Badge>
              </div>
              {/* Two stacked tracks: cash held over what is owed. Reading the
                  overhang is the whole job, so they share one scale. */}
              <div className="flex flex-col gap-1">
                <div className="h-3 w-full rounded-sm bg-surface-2">
                  <div
                    className="h-3 rounded-sm bg-accent"
                    style={{ width: `${(row.assetMinor / scale) * 100}%` }}
                  />
                </div>
                <div className="h-3 w-full rounded-sm bg-surface-2">
                  <div
                    className={row.breach ? "h-3 rounded-sm bg-flare-500" : "h-3 rounded-sm bg-vega-600"}
                    style={{ width: `${(row.liabilityMinor / scale) * 100}%` }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------- drilled lines */

function Lines({
  drilled,
  label,
  locale,
  closeTo
}: {
  drilled: Drilled;
  label: Label;
  locale: string;
  closeTo: string;
}) {
  const columns: Array<Column<MoneyMapLine>> = [
    {
      key: "postedAt",
      header: label("col.postedAt"),
      render: (row) => <DateTime value={row.postedAt} locale={locale} precision="minute" />
    },
    { key: "txnType", header: label("col.txnType"), render: (row) => row.txnType },
    { key: "txnId", header: label("col.txnId"), render: (row) => row.txnId },
    { key: "accountCode", header: label("col.account"), render: (row) => row.accountCode },
    { key: "side", header: label("col.side"), render: (row) => label(`side.${row.side}`) },
    {
      key: "amountMinor",
      header: label("col.amount"),
      numeric: true,
      render: (row) => <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
    },
    { key: "memo", header: label("col.memo"), render: (row) => row.memo ?? "—" }
  ];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-ui text-14 font-medium text-text">
          {label("lines.title")} — {label(`node.${drilled.node}`)}
        </h2>
        <div className="flex items-center gap-4 font-ui text-13 text-subtle">
          <span>
            {label("lines.total")}{" "}
            <Money amountMinor={drilled.totalMinor} currency={drilled.currency} />
          </span>
          <Button asChild variant="ghost">
            <Link to={closeTo}>{label("lines.close")}</Link>
          </Button>
        </div>
      </div>
      <Table
        columns={columns}
        rows={drilled.lines}
        rowKey={(row) => `${row.txnId}:${row.seq}`}
        caption={`${label("lines.title")} — ${label(`node.${drilled.node}`)}`}
        density="compact"
        empty={<EmptyState title={label("lines.none")} body={label("lines.none.body")} />}
      />
    </section>
  );
}

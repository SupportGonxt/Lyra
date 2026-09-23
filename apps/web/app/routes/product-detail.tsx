import { Form, Link, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Badge, Button, Card, DateTime, EmptyState, Field, Input, Money, Ref, Stat, Table, type Column } from "@lyra/ui";
import { ApiError, api, fetchMe, names, type Problem as ProblemBody } from "../api.server";
import { usePending } from "../components/pending";
import { Problem } from "./module";
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
  policyKeyOf,
  rowsOf,
  safe,
  tag,
  type Label,
  type Page
} from "./detail-kit";
import { useShellData } from "./workspace";
import { MemoryPanel } from "../components/memory-panel";

// One product definition: what it covers, what prices it, which underwriter
// versions exist, and which channels are allowed to sell them. The generic
// record screen owns the edit form (/admin/products/:id); the one write here is
// the Shariah lane, which the CRUD refuses on purpose (routes/compliance.ts).

/* --------------------------------------------------------------- contract */

export interface Product {
  id: string;
  line: string;
  nameJson?: unknown;
  providerId?: string | null;
  termsRef?: string | null;
  status: string;
  structure: string;
  takafulJson?: unknown;
  parametricTriggerJson?: unknown;
  standardMappingJson?: unknown;
  pricingInputsJson?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface OfferingRow {
  id: string;
  providerId: string;
  code: string;
  nameJson?: unknown;
  currency: string;
  pricingMode: string;
  ratingInputsJson?: unknown;
  coverageJson?: unknown;
  baseCommissionPpm: number;
  minPremiumMinor?: number | null;
  channelKeysJson?: unknown;
  status: string;
  effectiveFrom: number;
  effectiveTo?: number | null;
}

export interface ChannelRow {
  id: string;
  key: string;
  kind: string;
  nameJson?: unknown;
  status: string;
  defaultCommissionPpm?: number | null;
}

export const PERM = {
  read: "core:products:read",
  offerings: "dist:offerings:read",
  channels: "dist:channels:read",
  shariahSubmit: "compliance:shariah:read",
  shariahCertify: "compliance:shariah:certify"
} as const;

/** What the Shariah lane offers next for a product in `state`. */
export function shariahStep(state: string | undefined): "submit" | "certify" | "resubmit" {
  if (state === "submitted") return "certify";
  if (state === "certified") return "resubmit";
  return "submit";
}

type ShariahResult = { done: string | null; queued: boolean; problem: ProblemBody | null };

export async function action({ request, params, context }: ActionFunctionArgs): Promise<ShariahResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const productId = params.id as string;
  const text = (name: string) => String(form.get(name) ?? "").trim();
  try {
    if (intent === "shariah-submit") {
      await api("/v1/compliance/shariah/submit", { env, request, method: "POST", body: { productId } });
    } else if (intent === "shariah-certify") {
      const expires = text("expiresAt");
      const expiresAt = expires ? Date.parse(`${expires}T00:00:00Z`) : NaN;
      await api("/v1/compliance/shariah/certify", {
        env,
        request,
        method: "POST",
        body: {
          productId,
          boardRef: text("boardRef"),
          fatwaRef: text("fatwaRef"),
          ...(Number.isFinite(expiresAt) ? { expiresAt } : {})
        }
      });
    } else {
      return { done: null, queued: false, problem: null };
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Certification is dual control: "a second person must approve" is the
    // expected first answer, and it is a result rather than a failure.
    if (policyKeyOf(error.problem) !== null) return { done: intent, queued: true, problem: null };
    return { done: null, queued: false, problem: error.problem };
  }
  return { done: intent, queued: false, problem: null };
}

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    intro: "What this covers, what prices it, and who is allowed to sell it.",
    back: "Back to the catalogue",
    heroLede: "{line} · {status} · {n} versions",
    definitionTitle: "Definition",
    line: "Line",
    structure: "Structure",
    provider: "Owning underwriter",
    terms: "Wording reference",
    versionCount: "Versions",
    channelCount: "Distributing",
    pricingTitle: "Rating inputs",
    pricingCaption: "What a price for this product has to be told before it can be quoted.",
    coverTitle: "Cover components",
    coverCaption: "The limits and benefits each underwriter version carries.",
    takafulTitle: "Takaful terms",
    takafulCaption: "How this fund is run, and what the Shariah board has said about it.",
    takafulModel: "Structure",
    takafulFee: "Wakala fee",
    takafulShare: "Participants' share of surplus",
    takafulFund: "Risk fund",
    takafulRuling: "Shariah ruling",
    takafulBoard: "Board",
    takafulFatwa: "Ruling reference",
    takafulCertified: "Ruled on",
    takafulExpires: "Under review again",
    takafulLapsed: "This ruling has lapsed, so no surplus may be distributed until the board rules again.",
    takafulNotCertified: "No current ruling, so no surplus may be distributed from this fund.",
    "takafulModel.wakala": "Wakala — fee-based, participants keep the surplus",
    "takafulModel.mudaraba": "Mudaraba — the operator shares in the surplus",
    "takafulModel.hybrid": "Hybrid — a fee and a share of the surplus",
    "takafulState.draft": "Not submitted",
    "takafulState.submitted": "With the board",
    "takafulState.certified": "Certified",
    "takafulState.withdrawn": "Withdrawn",
    shariahSubmit: "Send to the Shariah board",
    shariahResubmit: "Send revised terms to the board",
    shariahResubmitNote: "Sending again clears this ruling: the board certified the terms it was shown.",
    shariahCertify: "Record the board's ruling",
    shariahBoardRef: "Board reference",
    shariahFatwaRef: "Ruling reference",
    shariahExpires: "Review again on",
    shariahSubmitted: "Sent to the board. The ruling is recorded here once it is given.",
    shariahQueued: "Waiting for a second person. The ruling is recorded once it is approved; finish it from your inbox.",
    shariahCertified: "Ruling recorded.",
    parametricTitle: "Parametric trigger",
    mappingTitle: "Standard mapping",
    versionsTitle: "Underwriter versions",
    versionsCaption: "Every underwriter version of this product, and the commission it pays.",
    channelsTitle: "Sold through",
    channelsCaption: "Channels allowed to distribute a version of this product.",
    noneVersions: "No version of this product exists yet. A version is what a customer actually buys.",
    noneChannels: "No version restricts itself to a channel, and none is on sale, so nothing can be sold yet.",
    channelsAll: "Every channel may sell this: no version restricts it.",
    "channelsAll.body": "Restrict a version to a channel from its own record if you want to narrow that.",
    colOffering: "Version",
    colProvider: "Underwriter",
    colPricing: "Priced by",
    colCommission: "Commission",
    colEffective: "From",
    colChannel: "Channel",
    colChannelKind: "Kind",
    colDefaultShare: "Default share",
    unnamed: "Unnamed",
    "line.motor": "Motor",
    "line.health": "Health",
    "line.travel": "Travel",
    "line.home": "Home",
    "line.life": "Life",
    "line.sme": "Small business",
    "line.card": "Card",
    "line.loan": "Loan",
    "line.account": "Account",
    "structure.conventional": "Conventional",
    "structure.takaful": "Takaful",
    "structure.parametric": "Parametric",
    "pricingMode.api": "Live interface",
    "pricingMode.table": "Rate table",
    "pricingMode.manual": "By hand",
    "pricingMode.referral": "Referral",
    "kind.b2c": "Direct",
    "kind.b2b": "Partner"
  },
  ar: {
    intro: "ما يغطّيه هذا المنتج، وما يحدّد سعره، ومن يحق له بيعه.",
    back: "العودة إلى الكتالوج",
    heroLede: "{line} · {status} · {n} إصدارات",
    definitionTitle: "التعريف",
    line: "الخط",
    structure: "البنية",
    provider: "جهة الاكتتاب المالكة",
    terms: "مرجع الصيغة",
    versionCount: "الإصدارات",
    channelCount: "قنوات التوزيع",
    pricingTitle: "مدخلات التسعير",
    pricingCaption: "ما يجب معرفته قبل إمكانية تسعير هذا المنتج.",
    coverTitle: "عناصر التغطية",
    coverCaption: "الحدود والمزايا في كل إصدار من إصدارات جهات الاكتتاب.",
    takafulTitle: "أحكام التكافل",
    takafulCaption: "كيف يُدار هذا الصندوق، وما قالته هيئة الرقابة الشرعية بشأنه.",
    takafulModel: "الهيكل",
    takafulFee: "أجرة الوكالة",
    takafulShare: "حصة المشتركين من الفائض",
    takafulFund: "صندوق المخاطر",
    takafulRuling: "الحكم الشرعي",
    takafulBoard: "الهيئة",
    takafulFatwa: "مرجع الفتوى",
    takafulCertified: "تاريخ الحكم",
    takafulExpires: "يُعاد النظر فيه",
    takafulLapsed: "انتهت صلاحية هذا الحكم، فلا يجوز توزيع أي فائض حتى تصدر الهيئة حكمًا جديدًا.",
    takafulNotCertified: "لا يوجد حكم ساري، فلا يجوز توزيع أي فائض من هذا الصندوق.",
    "takafulModel.wakala": "وكالة — بأجر، ويحتفظ المشتركون بالفائض",
    "takafulModel.mudaraba": "مضاربة — يشارك المشغّل في الفائض",
    "takafulModel.hybrid": "مختلط — أجر وحصة من الفائض",
    "takafulState.draft": "لم يُقدَّم",
    "takafulState.submitted": "لدى الهيئة",
    "takafulState.certified": "معتمد",
    "takafulState.withdrawn": "مسحوب",
    shariahSubmit: "إرسال إلى هيئة الرقابة الشرعية",
    shariahResubmit: "إرسال الأحكام المعدّلة إلى الهيئة",
    shariahResubmitNote: "الإرسال من جديد يلغي هذا الحكم: فالهيئة أجازت الأحكام التي عُرضت عليها.",
    shariahCertify: "تسجيل حكم الهيئة",
    shariahBoardRef: "مرجع الهيئة",
    shariahFatwaRef: "مرجع الحكم",
    shariahExpires: "المراجعة القادمة في",
    shariahSubmitted: "أُرسلت إلى الهيئة. يُسجَّل الحكم هنا عند صدوره.",
    shariahQueued: "بانتظار شخص ثانٍ. يُسجَّل الحكم بعد الموافقة؛ أكمله من صندوق الوارد.",
    shariahCertified: "سُجِّل الحكم.",
    parametricTitle: "محرّك التعويض البارامتري",
    mappingTitle: "الربط المعياري",
    versionsTitle: "إصدارات جهات الاكتتاب",
    versionsCaption: "كل إصدار لهذا المنتج، والعمولة التي يدفعها.",
    channelsTitle: "قنوات البيع",
    channelsCaption: "القنوات المسموح لها بتوزيع إصدار من هذا المنتج.",
    noneVersions: "لا يوجد إصدار من هذا المنتج بعد. الإصدار هو ما يشتريه العميل فعلاً.",
    noneChannels: "لا إصدار يقيّد نفسه بقناة، ولا شيء معروض للبيع، فلا يمكن بيع شيء بعد.",
    channelsAll: "كل القنوات تستطيع بيع هذا المنتج: لا إصدار يقيّده.",
    "channelsAll.body": "قيّد إصداراً بقناة من سجله الخاص إن أردت تضييق ذلك.",
    colOffering: "الإصدار",
    colProvider: "جهة الاكتتاب",
    colPricing: "طريقة التسعير",
    colCommission: "العمولة",
    colEffective: "يبدأ من",
    colChannel: "القناة",
    colChannelKind: "النوع",
    colDefaultShare: "الحصة الافتراضية",
    unnamed: "بلا اسم",
    "line.motor": "المركبات",
    "line.health": "الصحي",
    "line.travel": "السفر",
    "line.home": "المنازل",
    "line.life": "الحياة",
    "line.sme": "المنشآت الصغيرة",
    "line.card": "البطاقات",
    "line.loan": "التمويل",
    "line.account": "الحسابات",
    "structure.conventional": "تقليدية",
    "structure.takaful": "تكافلية",
    "structure.parametric": "بارامترية",
    "pricingMode.api": "واجهة مباشرة",
    "pricingMode.table": "جدول أسعار",
    "pricingMode.manual": "يدويًا",
    "pricingMode.referral": "بالإحالة",
    "kind.b2c": "مباشر",
    "kind.b2b": "شريك"
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the product's name: its line of business, its status, and
 * how many underwriter versions exist to price it — no ✦, arithmetic on
 * loaded rows, not a model finding (CLAUDE.md §11). */
export function productLede(product: Pick<Product, "line" | "status">, versionCount: number, l: Label): string {
  return l("heroLede", { line: tag(l, "line", product.line), status: tag(l, "status", product.status), n: String(versionCount) });
}

/** The channel keys a version restricts itself to; empty means unrestricted. */
export function channelKeysOf(offerings: readonly OfferingRow[]): string[] {
  const keys = new Set<string>();
  for (const offering of offerings) {
    if (!Array.isArray(offering.channelKeysJson)) continue;
    for (const key of offering.channelKeysJson) if (typeof key === "string") keys.add(key);
  }
  return [...keys];
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const options = { env, request };

  const empty = {
    product: null as Product | null,
    offerings: [] as OfferingRow[],
    channels: [] as ChannelRow[],
    unrestricted: false,
    may: { submit: held.has(PERM.shariahSubmit), certify: held.has(PERM.shariahCertify) },
    named: {} as Record<string, string>,
    now: Date.now()
  };

  if (!held.has(PERM.read)) return empty;
  const [product, offeringPage] = await Promise.all([
    safe(() => api<Product>(`/v1/core/products/${id}`, options), null),
    held.has(PERM.offerings)
      ? safe(() => api<Page<OfferingRow>>(`/v1/dist/offerings?productId=${id}&limit=50`, options), null)
      : null
  ]);
  if (!product) return empty;

  // Which channels distribute it is not a column anywhere: it is the union of
  // the `channelKeysJson` allow-lists on this product's versions, resolved
  // against the channel register. No list means no restriction.
  const offerings = rowsOf(offeringPage);
  const keys = channelKeysOf(offerings);
  const channels =
    held.has(PERM.channels) && keys.length > 0
      ? await safe(
          () => api<Page<ChannelRow>>(`/v1/dist/channels?key=${encodeURIComponent(keys.join(","))}&limit=50`, options),
          null
        )
      : null;

  const named = await names(
    offerings.map((row) => row.providerId),
    options
  ).catch(() => ({}) as Record<string, string>);

  return {
    ...empty,
    product,
    named,
    offerings,
    channels: rowsOf(channels),
    unrestricted: offerings.length > 0 && keys.length === 0,
    // Server clock, not the browser's: whether a Shariah ruling has lapsed is
    // the same question the API's own precondition answers, and two clocks
    // would let the screen and the ledger disagree about a certificate.
    now: Date.now()
  };
}

/* --------------------------------------------------------------- component */

export default function ProductDetail() {
  const loaded = useLoaderData<typeof loader>();
  const shell = useShellData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);

  if (!loaded.product) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("definitionTitle")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const product = loaded.product;

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
      key: "providerId",
      header: l("colProvider"),
      render: (row) => (
        <span className="font-ui text-12">{loaded.named[row.providerId] ?? <Ref value={row.providerId} />}</span>
      )
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "pricingMode",
      header: l("colPricing"),
      render: (row) => <span className="font-ui text-12">{tag(l, "pricingMode", row.pricingMode)}</span>
    },
    {
      key: "baseCommissionPpm",
      header: l("colCommission"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{percentOf(row.baseCommissionPpm, locale)}</span>
    },
    {
      key: "minPremiumMinor",
      header: l("minPremiumMinor"),
      numeric: true,
      render: (row) =>
        row.minPremiumMinor != null ? (
          <Money amountMinor={row.minPremiumMinor} currency={row.currency} locale={locale} />
        ) : (
          <span>—</span>
        )
    },
    {
      key: "effectiveFrom",
      header: l("colEffective"),
      render: (row) => <DateTime value={row.effectiveFrom} locale={locale} precision="day" />
    }
  ];

  const channelColumns: Array<Column<ChannelRow>> = [
    {
      key: "key",
      header: l("colChannel"),
      render: (row) => (
        <Link to={`/distribution/channels/${row.id}/detail`} className="text-accent hover:underline">
          {nameOf(row.nameJson, locale, row.key)}
        </Link>
      )
    },
    { key: "kind", header: l("colChannelKind"), render: (row) => <span className="font-ui text-12">{tag(l, "kind", row.kind)}</span> },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "defaultCommissionPpm",
      header: l("colDefaultShare"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{percentOf(row.defaultCommissionPpm, locale)}</span>
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{nameOf(product.nameJson, locale, product.id)}</h1>
          <p className="font-ui text-13 text-muted">{productLede(product, loaded.offerings.length, l)}</p>
          <Link to="/admin/products" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("definitionTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "status", product.status)}
          </Badge>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-6 md:grid-cols-3">
          <Stat label={l("line")} value={<span className="font-ui text-13">{tag(l, "line", product.line)}</span>} />
          <Stat label={l("versionCount")} value={<span className="font-mono text-13">{loaded.offerings.length}</span>} />
          <Stat
            label={l("channelCount")}
            value={<span className="font-mono text-13">{loaded.unrestricted ? "—" : loaded.channels.length}</span>}
          />
        </div>
        <Facts>
          <Entry term={l("structure")}>{tag(l, "structure", product.structure)}</Entry>
          <Entry term={l("provider")}>{product.providerId ?? "—"}</Entry>
          <Entry term={l("terms")}>{product.termsRef ?? "—"}</Entry>
        </Facts>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={l("pricingTitle")} description={l("pricingCaption")}>
          <Payload value={product.pricingInputsJson} />
        </Card>
        <Card title={l("coverTitle")} description={l("coverCaption")}>
          <Payload value={loaded.offerings.map((offering) => ({ [offering.code]: offering.coverageJson ?? {} }))} />
        </Card>
      </div>

      {product.structure === "takaful" ? (
        <TakafulCard value={product.takafulJson} l={l} locale={locale} now={loaded.now} may={loaded.may} />
      ) : null}

      {product.structure === "parametric" ? (
        <Card title={l("parametricTitle")}>
          <Payload value={product.parametricTriggerJson} />
        </Card>
      ) : null}

      <Card title={l("versionsTitle")} padded={false}>
        <Table
          caption={l("versionsCaption")}
          columns={offeringColumns}
          rows={loaded.offerings}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneVersions")} />}
        />
      </Card>

      <Card title={l("channelsTitle")} padded={false}>
        <Table
          caption={l("channelsCaption")}
          columns={channelColumns}
          rows={loaded.channels}
          rowKey={(row) => row.id}
          empty={
            loaded.unrestricted ? (
              <EmptyState title={l("channelsAll")} body={l("channelsAll.body")} />
            ) : (
              <EmptyState title={l("none")} body={l("noneChannels")} />
            )
          }
        />
      </Card>

      <Card title={l("mappingTitle")}>
        <Payload value={product.standardMappingJson} />
      </Card>

      {/* The record's memory (ADR-0089), last: below everything the record
          itself shows, loaded after it, so it never pushes the record down. */}
      <MemoryPanel
        subject={product.id}
        t={t}
        locale={locale}
        permissions={shell?.permissions ?? []}
      />
    </div>
  );
}

/* ------------------------------------------------------------- takaful H8 */

/**
 * docs/16 H8, docs/27 F45. This card existed and printed `takafulJson` raw,
 * which was honest while the column held free-form JSON and nothing acted on
 * it. Now that a surplus distribution is refused on what this says
 * (packages/ledger/src/preconditions.ts), the reader has to be able to see the
 * thing that refuses them — a lapsed ruling is the difference between a fund
 * that may distribute and one that may not, and a JSON dump does not say so.
 *
 * "certified" is deliberately not the headline. A ruling whose `expiresAt` has
 * passed is still `state: "certified"` in the column, and a screen that reads
 * the state alone tells a reader they may distribute when the API will refuse
 * them — the same question, answered twice, differently.
 */
function TakafulCard({
  value,
  l,
  locale,
  now,
  may
}: {
  value: unknown;
  l: Label;
  locale: string;
  now: number;
  may: { submit: boolean; certify: boolean };
}) {
  const result = useActionData<typeof action>();
  const pending = usePending();
  const takaful = (value && typeof value === "object" ? value : {}) as {
    model?: string;
    wakalaFeeBps?: number;
    participantShareBps?: number;
    fundRef?: string;
    shariah?: { state?: string; boardRef?: string; fatwaRef?: string; certifiedAt?: number; expiresAt?: number };
  };
  const shariah = takaful.shariah ?? {};
  const bps = (v: number | undefined) =>
    new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format((v ?? 0) / 10_000);
  const lapsed = shariah.state === "certified" && shariah.expiresAt !== undefined && shariah.expiresAt <= now;
  const current = shariah.state === "certified" && !lapsed;

  return (
    <Card title={l("takafulTitle")} description={l("takafulCaption")}>
      <div className="flex flex-col gap-4">
        <Facts>
          <Entry term={l("takafulModel")}>{l(`takafulModel.${takaful.model ?? "wakala"}`)}</Entry>
          <Entry term={l("takafulFee")}>{bps(takaful.wakalaFeeBps)}</Entry>
          <Entry term={l("takafulShare")}>{bps(takaful.participantShareBps)}</Entry>
          {takaful.fundRef ? (
            <Entry term={l("takafulFund")}>
              <Ref value={takaful.fundRef} />
            </Entry>
          ) : null}
        </Facts>
        <Facts>
          <Entry term={l("takafulRuling")}>
            <Badge tone={current ? "success" : lapsed ? "warning" : "neutral"}>
              {l(`takafulState.${shariah.state ?? "draft"}`)}
            </Badge>
          </Entry>
          {shariah.boardRef ? (
            <Entry term={l("takafulBoard")}>
              <Ref value={shariah.boardRef} />
            </Entry>
          ) : null}
          {shariah.fatwaRef ? <Entry term={l("takafulFatwa")}>{shariah.fatwaRef}</Entry> : null}
          {shariah.certifiedAt ? (
            <Entry term={l("takafulCertified")}>
              <DateTime value={shariah.certifiedAt} precision="day" />
            </Entry>
          ) : null}
          {shariah.expiresAt ? (
            <Entry term={l("takafulExpires")}>
              <DateTime value={shariah.expiresAt} precision="day" />
            </Entry>
          ) : null}
        </Facts>
        {current ? null : (
          <p className="font-ui text-13 text-muted">{lapsed ? l("takafulLapsed") : l("takafulNotCertified")}</p>
        )}
        <ShariahLane step={shariahStep(shariah.state)} may={may} l={l} result={result} pending={pending} />
      </div>
    </Card>
  );
}

/** The next move in the Shariah lane, for whoever may make it. */
function ShariahLane({
  step,
  may,
  l,
  result,
  pending
}: {
  step: ReturnType<typeof shariahStep>;
  may: { submit: boolean; certify: boolean };
  l: Label;
  result: ShariahResult | undefined;
  pending: (intent: string) => boolean;
}) {
  const said = result?.queued
    ? l("shariahQueued")
    : result?.done === "shariah-submit"
      ? l("shariahSubmitted")
      : result?.done === "shariah-certify"
        ? l("shariahCertified")
        : null;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      {said ? (
        <p role="status" className={`font-ui text-13 ${result?.queued ? "text-warning" : "text-success"}`}>
          {said}
        </p>
      ) : null}
      {result?.problem ? <Problem problem={result.problem} /> : null}
      {step === "certify" && may.certify ? (
        <Form method="post" className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={l("shariahBoardRef")} required>
              <Input name="boardRef" required maxLength={200} />
            </Field>
            <Field label={l("shariahFatwaRef")} required>
              <Input name="fatwaRef" required maxLength={200} />
            </Field>
            <Field label={l("shariahExpires")}>
              <Input name="expiresAt" type="date" />
            </Field>
          </div>
          <div>
            <Button type="submit" name="intent" value="shariah-certify" loading={pending("shariah-certify")}>
              {l("shariahCertify")}
            </Button>
          </div>
        </Form>
      ) : null}
      {step !== "certify" && may.submit ? (
        <Form method="post" className="flex flex-col gap-2">
          {step === "resubmit" ? <p className="font-ui text-12 text-subtle">{l("shariahResubmitNote")}</p> : null}
          <div>
            <Button
              type="submit"
              variant={step === "resubmit" ? "secondary" : "primary"}
              name="intent"
              value="shariah-submit"
              loading={pending("shariah-submit")}
            >
              {step === "resubmit" ? l("shariahResubmit") : l("shariahSubmit")}
            </Button>
          </div>
        </Form>
      ) : null}
    </div>
  );
}

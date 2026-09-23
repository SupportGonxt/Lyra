import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Hero,
  Input,
  ScreenState,
  Select,
  Table,
  formatMoney,
  hueVar,
  renderSection,
  type Column,
  type Section
} from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { useAxisSessionData } from "./axis-shell";
import { Entry, Facts, Header, labelsFrom, rowsOf, safe, tag, type Label, type Page } from "./detail-kit";
import { Gate } from "./staff";

// docs/27 §E. A bordereau is the periodic reconciliation file between us and
// a provider/channel/partner: what we say happened this period vs what they
// say happened. Outbound is generated straight from our own ledger data
// (no raw lines needed); inbound needs the counterparty's raw lines, matched
// against our records by a reconcile pass. Neither writes a row directly —
// both go through apps/api/src/engines/axis-bordereaux.ts, which is why the
// register itself is read-only CRUD (apps/api/src/resources.ts).

export interface BordereauRow {
  id: string;
  direction: string;
  counterpartyKind: string;
  counterpartyId: string;
  kind: string;
  period: string;
  currency: string;
  lineCount: number;
  grossPremiumMinor: number;
  commissionMinor: number;
  claimsPaidMinor: number;
  reserveMinor: number;
  varianceMinor: number;
  state: string;
  createdAt: number;
  updatedAt: number;
}

export interface BordereauLineRow {
  id: string;
  bordereauId: string;
  lineNo: number;
  externalRef: string | null;
  riskRef: string | null;
  grossPremiumMinor: number;
  commissionMinor: number;
  claimsPaidMinor: number;
  reserveMinor: number;
  currency: string;
  matchState: string;
  varianceMinor: number;
  createdAt: number;
  updatedAt: number;
}

export const PERM = {
  read: "axis:bordereaux:read",
  generate: "axis:bordereaux:generate",
  reconcile: "axis:bordereaux:reconcile"
} as const;

export const DIRECTIONS = ["inbound", "outbound"] as const;
export const COUNTERPARTY_KINDS = ["provider", "channel", "partner"] as const;
export const BORDEREAU_KINDS = ["premium", "claims", "combined"] as const;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const REGISTER_LIMIT = 100;
const LINES_LIMIT = 200;

/* -------------------------------------------------------------------- i18n */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Bordereaux",
    intro: "The periodic reconciliation file between us and each provider, channel and partner.",
    back: "Back to the register",
    deniedTitle: "Not visible to you",
    registerTitle: "Register",
    registerCaption: "Every bordereau generated this tenant, most recent period first.",
    noLines: "No lines on this bordereau.",
    "noLines.body": "This bordereau reports no risks — it was generated for a period with nothing to report.",
    noneYet: "No bordereaux generated yet.",
    "noneYet.body": "A bordereau is generated when a period closes, or on demand from the register above.",
    colPeriod: "Period",
    colDirection: "Direction",
    colCounterparty: "Counterparty",
    colState: "State",
    colLines: "Lines",
    colGross: "Gross premium",
    colVariance: "Variance",
    varianceByCounterpartyTitle: "Gross premium by counterparty",
    generateTitle: "Generate",
    generateIntro: "Outbound recomputes from the ledger every call. Inbound is one-shot per period.",
    directionLabel: "Direction",
    counterpartyKindLabel: "Counterparty kind",
    counterpartyIdLabel: "Counterparty",
    kindLabel: "Kind",
    periodLabel: "Period (YYYY-MM)",
    currencyLabel: "Currency",
    linesLabel: "Raw lines (JSON array, inbound only)",
    linesHint: "Each line needs at least externalRef and grossPremiumMinor.",
    generateSubmit: "Generate",
    generateDone: "Bordereau generated.",
    directionRequired: "Choose inbound or outbound.",
    counterpartyKindRequired: "Choose a counterparty kind.",
    counterpartyIdRequired: "Name the counterparty.",
    kindRequired: "Choose premium, claims or combined.",
    periodRequired: "Period must be a real calendar month, YYYY-MM.",
    linesRequired: "Inbound needs at least one valid line, as a JSON array.",
    selectedTitle: "Selected bordereau",
    selectedCaption: "Totals as last generated or reconciled.",
    noneSelected: "Pick a bordereau from the register to see its lines.",
    "noneSelected.body": "Each bordereau lists the risks it reports. Pick one to read its lines.",
    kvGross: "Gross premium",
    kvCommission: "Commission",
    kvClaimsPaid: "Claims paid",
    kvReserve: "Reserve",
    kvVariance: "Variance",
    kvLines: "Lines",
    varianceTitle: "Line variance",
    varianceSub: "Counterparty's reported gross premium less our own record, per line.",
    linesTitle: "Lines",
    linesCaption: "Every line on the selected bordereau.",
    colLineNo: "Line #",
    colExternalRef: "Policy ref",
    colRiskRef: "Risk ref",
    colMatchState: "Match",
    colLineGross: "Gross premium",
    colLineVariance: "Variance",
    reconcileTitle: "Reconcile",
    reconcileIntro: "Match this bordereau's lines against our own policies by policy number.",
    reconcileSubmit: "Reconcile",
    reconcileDone: "Bordereau reconciled.",
    bordereauRequired: "No bordereau to reconcile.",
    "direction.inbound": "Inbound",
    "direction.outbound": "Outbound",
    "counterpartyKind.provider": "Provider",
    "counterpartyKind.channel": "Channel",
    "counterpartyKind.partner": "Partner",
    "bordereauKind.premium": "Premium",
    "bordereauKind.claims": "Claims",
    "bordereauKind.combined": "Combined",
    "state.generated": "Generated",
    "state.sent": "Sent",
    "state.acknowledged": "Acknowledged",
    "state.matched": "Matched",
    "state.variance": "Variance",
    "matchState.unmatched": "Unmatched",
    "matchState.matched": "Matched",
    "matchState.variance": "Variance",
    "matchState.missing_ours": "Missing on our side",
    "matchState.missing_theirs": "Missing on theirs"
  },
  ar: {
    title: "قوائم التسوية",
    intro: "ملف التسوية الدوري بيننا وبين كل مزوّد أو قناة أو شريك.",
    back: "العودة إلى السجل",
    deniedTitle: "غير مرئي لك",
    registerTitle: "السجل",
    registerCaption: "كل قائمة تسوية أُنشئت لهذا المستأجر، الأحدث فترة أولًا.",
    noLines: "لا توجد بنود في قائمة التسوية هذه.",
    "noLines.body": "لا تبلّغ هذه القائمة عن أي مخاطر — أُنشئت لفترة لا شيء فيها للإبلاغ.",
    noneYet: "لم تُنشأ أي قائمة تسوية بعد.",
    "noneYet.body": "تُنشأ قائمة التسوية عند إقفال فترة، أو عند الطلب من السجل أعلاه.",
    colPeriod: "الفترة",
    colDirection: "الاتجاه",
    colCounterparty: "الطرف المقابل",
    colState: "الحالة",
    colLines: "البنود",
    colGross: "إجمالي القسط",
    colVariance: "الفرق",
    varianceByCounterpartyTitle: "إجمالي القسط حسب الطرف المقابل",
    generateTitle: "إنشاء",
    generateIntro: "الصادر يُعاد حسابه من السجل في كل مرة. الوارد يُنشأ مرة واحدة لكل فترة.",
    directionLabel: "الاتجاه",
    counterpartyKindLabel: "نوع الطرف المقابل",
    counterpartyIdLabel: "الطرف المقابل",
    kindLabel: "النوع",
    periodLabel: "الفترة (YYYY-MM)",
    currencyLabel: "العملة",
    linesLabel: "البنود الخام (مصفوفة JSON، للوارد فقط)",
    linesHint: "كل بند يحتاج على الأقل externalRef و grossPremiumMinor.",
    generateSubmit: "إنشاء",
    generateDone: "تم إنشاء قائمة التسوية.",
    directionRequired: "اختر واردًا أو صادرًا.",
    counterpartyKindRequired: "اختر نوع الطرف المقابل.",
    counterpartyIdRequired: "حدّد الطرف المقابل.",
    kindRequired: "اختر قسطًا أو مطالبات أو مجمّعًا.",
    periodRequired: "يجب أن تكون الفترة شهرًا تقويميًا حقيقيًا بصيغة YYYY-MM.",
    linesRequired: "الوارد يحتاج بندًا صالحًا واحدًا على الأقل، كمصفوفة JSON.",
    selectedTitle: "قائمة التسوية المحددة",
    selectedCaption: "الإجماليات كما آخر إنشاء أو تسوية.",
    noneSelected: "اختر قائمة تسوية من السجل لعرض بنودها.",
    "noneSelected.body": "تُدرج كل قائمة تسوية المخاطر التي تبلّغ عنها. اختر واحدة لقراءة بنودها.",
    kvGross: "إجمالي القسط",
    kvCommission: "العمولة",
    kvClaimsPaid: "المطالبات المدفوعة",
    kvReserve: "الاحتياطي",
    kvVariance: "الفرق",
    kvLines: "البنود",
    varianceTitle: "فرق البنود",
    varianceSub: "إجمالي القسط الذي أبلغ عنه الطرف المقابل ناقص سجلّنا، لكل بند.",
    linesTitle: "البنود",
    linesCaption: "كل بند في قائمة التسوية المحددة.",
    colLineNo: "#",
    colExternalRef: "مرجع الوثيقة",
    colRiskRef: "مرجع الخطر",
    colMatchState: "المطابقة",
    colLineGross: "إجمالي القسط",
    colLineVariance: "الفرق",
    reconcileTitle: "تسوية",
    reconcileIntro: "طابق بنود قائمة التسوية هذه مع وثائقنا برقم الوثيقة.",
    reconcileSubmit: "تسوية",
    reconcileDone: "تمت تسوية قائمة التسوية.",
    bordereauRequired: "لا توجد قائمة تسوية لتسويتها.",
    "direction.inbound": "وارد",
    "direction.outbound": "صادر",
    "counterpartyKind.provider": "مزوّد",
    "counterpartyKind.channel": "قناة",
    "counterpartyKind.partner": "شريك",
    "bordereauKind.premium": "قسط",
    "bordereauKind.claims": "مطالبات",
    "bordereauKind.combined": "مجمّع",
    "state.generated": "أُنشئت",
    "state.sent": "أُرسلت",
    "state.acknowledged": "أُقرّت",
    "state.matched": "مطابقة",
    "state.variance": "فرق",
    "matchState.unmatched": "غير مطابق",
    "matchState.matched": "مطابق",
    "matchState.variance": "فرق",
    "matchState.missing_ours": "مفقود لدينا",
    "matchState.missing_theirs": "مفقود لديهم"
  }
};

export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const selectedId = url.searchParams.get("id");
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const options = { env, request };
  const may = {
    read: held.has(PERM.read),
    generate: held.has(PERM.generate),
    reconcile: held.has(PERM.reconcile)
  };

  const empty = {
    bordereaux: [] as BordereauRow[],
    selected: null as BordereauRow | null,
    lines: [] as BordereauLineRow[],
    may,
    idempotencyKey: crypto.randomUUID()
  };

  if (!may.read) return empty;

  const page = await safe(
    () => api<Page<BordereauRow>>(`/v1/axis/bordereaux?limit=${REGISTER_LIMIT}&sort=period&order=desc`, options),
    null
  );
  const bordereaux = rowsOf(page);
  if (!selectedId) return { ...empty, bordereaux };

  const [selected, linesPage] = await Promise.all([
    safe(() => api<BordereauRow>(`/v1/axis/bordereaux/${encodeURIComponent(selectedId)}`, options), null),
    safe(
      () =>
        api<Page<BordereauLineRow>>(
          `/v1/axis/bordereau-lines?bordereauId=${encodeURIComponent(selectedId)}&limit=${LINES_LIMIT}`,
          options
        ),
      null
    )
  ]);

  return { ...empty, bordereaux, selected, lines: rowsOf(linesPage) };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const nothing = {
    done: null as string | null,
    problem: null as Problem | null,
    error: null as string | null,
    data: null as unknown
  };

  const text = (name: string) => String(form.get(name) ?? "").trim();

  let path: string;
  let body: Record<string, unknown>;
  let suffix: string;
  let done: string;

  if (intent === "generate") {
    const direction = text("direction");
    if (!(DIRECTIONS as readonly string[]).includes(direction)) return { ...nothing, error: "directionRequired" };
    const counterpartyKind = text("counterpartyKind");
    if (!(COUNTERPARTY_KINDS as readonly string[]).includes(counterpartyKind)) {
      return { ...nothing, error: "counterpartyKindRequired" };
    }
    const counterpartyId = text("counterpartyId");
    if (!counterpartyId) return { ...nothing, error: "counterpartyIdRequired" };
    const kind = text("kind");
    if (!(BORDEREAU_KINDS as readonly string[]).includes(kind)) return { ...nothing, error: "kindRequired" };
    const period = text("period");
    if (!ISO_MONTH.test(period)) return { ...nothing, error: "periodRequired" };
    const currency = text("currency") || "AED";

    // Outbound is built server-side straight from the ledger; only inbound
    // needs the counterparty's raw rows, and only a period nobody has
    // imported yet — the engine throws conflict() on a second inbound call
    // (apps/api/src/engines/axis-bordereaux.ts), which the API surfaces as a
    // Problem here rather than this form re-deriving that rule.
    let lines: unknown[] = [];
    if (direction === "inbound") {
      const raw = text("lines");
      try {
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return { ...nothing, error: "linesRequired" };
        lines = parsed;
      } catch {
        return { ...nothing, error: "linesRequired" };
      }
      if (lines.length === 0) return { ...nothing, error: "linesRequired" };
    }

    path = `/v1/axis/bordereaux`;
    body = { direction, counterpartyKind, counterpartyId, kind, period, currency, lines };
    suffix = `generate:${direction}:${counterpartyId}:${kind}:${period}`;
    done = "generateDone";
  } else if (intent === "reconcile") {
    const bordereauId = text("bordereauId");
    if (!bordereauId) return { ...nothing, error: "bordereauRequired" };
    path = `/v1/axis/bordereaux/${bordereauId}/reconcile`;
    body = {};
    suffix = `reconcile:${bordereauId}`;
    done = "reconcileDone";
  } else {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    const data = await api<unknown>(path, {
      env,
      request,
      method: "POST",
      ...(key ? { headers: { "idempotency-key": `${key}:${suffix}` } } : {}),
      body
    });
    return { ...nothing, done, data };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

function money(minor: number, currency: string, locale: string): string {
  return formatMoney(minor, currency, locale);
}

/** 50% is zero variance. A positive line (counterparty overstated vs our
 * record) grows the band to the right of centre; a negative line grows it
 * left. Scaled against the largest absolute variance on this bordereau and
 * capped so the band never runs off its track. */
function bandOf(varianceMinor: number, scaleMinor: number): { bandL: string; bandW: string } {
  const pct = Math.min(45, Math.round((Math.abs(varianceMinor) / scaleMinor) * 45));
  return varianceMinor >= 0 ? { bandL: "50%", bandW: `${pct}%` } : { bandL: `${50 - pct}%`, bandW: `${pct}%` };
}

function hueForMatch(matchState: string): string {
  if (matchState === "matched") return "var(--success)";
  if (matchState === "variance") return "var(--warning)";
  return "var(--danger)";
}

export default function AxisBordereaux() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (!loaded.may.read) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("title")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const { bordereaux, selected, lines } = loaded;
  const maxGross = Math.max(1, ...bordereaux.map((b) => b.grossPremiumMinor));

  const grossByCounterparty: Section = {
    kind: "bars",
    title: l("varianceByCounterpartyTitle"),
    items: bordereaux.map((b) => ({
      label: `${b.counterpartyId} — ${b.period}`,
      value: money(b.grossPremiumMinor, b.currency, locale),
      w: `${Math.max(4, Math.round((b.grossPremiumMinor / maxGross) * 100))}%`,
      hue: hueVar("axis"),
      note: `${tag(l, "direction", b.direction)} · ${tag(l, "bordereauKind", b.kind)}`
    }))
  };

  const registerColumns: Array<Column<BordereauRow>> = [
    { key: "period", header: l("colPeriod"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
    { key: "direction", header: l("colDirection"), render: (row) => <Badge size="sm">{tag(l, "direction", row.direction)}</Badge> },
    { key: "counterpartyId", header: l("colCounterparty"), render: (row) => <span className="font-ui text-12">{row.counterpartyId}</span> },
    { key: "kind", header: l("colKind"), render: (row) => tag(l, "bordereauKind", row.kind) },
    { key: "state", header: l("colState"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    { key: "lineCount", header: l("colLines"), numeric: true, render: (row) => <span className="font-mono text-12">{row.lineCount}</span> },
    {
      key: "grossPremiumMinor",
      header: l("colGross"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{money(row.grossPremiumMinor, row.currency, locale)}</span>
    },
    {
      key: "varianceMinor",
      header: l("colVariance"),
      numeric: true,
      render: (row) => (
        <span className="font-mono text-12" style={{ color: row.varianceMinor === 0 ? undefined : hueForMatch("variance") }}>
          {money(row.varianceMinor, row.currency, locale)}
        </span>
      )
    }
  ];

  const kv: Section | null = selected
    ? {
        kind: "kv",
        title: l("selectedTitle"),
        items: [
          { label: l("kvGross"), value: money(selected.grossPremiumMinor, selected.currency, locale), hue: hueVar("axis"), font: "" },
          { label: l("kvCommission"), value: money(selected.commissionMinor, selected.currency, locale), hue: hueVar("axis"), font: "" },
          { label: l("kvClaimsPaid"), value: money(selected.claimsPaidMinor, selected.currency, locale), hue: hueVar("axis"), font: "" },
          { label: l("kvReserve"), value: money(selected.reserveMinor, selected.currency, locale), hue: hueVar("axis"), font: "" },
          {
            label: l("kvVariance"),
            value: money(selected.varianceMinor, selected.currency, locale),
            hue: selected.varianceMinor === 0 ? "var(--success)" : "var(--warning)",
            font: ""
          },
          { label: l("kvLines"), value: String(selected.lineCount), hue: hueVar("axis"), font: "" }
        ]
      }
    : null;

  const scaleMinor = Math.max(1, ...lines.map((line) => Math.abs(line.varianceMinor)));
  const bands: Section | null = selected
    ? {
        kind: "bands",
        title: l("varianceTitle"),
        sub: l("varianceSub"),
        items: lines.map((line) => ({
          label: line.riskRef ?? line.externalRef ?? `#${line.lineNo}`,
          value: money(line.varianceMinor, selected.currency, locale),
          hue: hueForMatch(line.matchState),
          midL: "50%",
          note: `${tag(l, "matchState", line.matchState)}${line.externalRef ? ` · ${line.externalRef}` : ""}`,
          ...bandOf(line.varianceMinor, scaleMinor)
        }))
      }
    : null;

  const lineColumns: Array<Column<BordereauLineRow>> = [
    { key: "lineNo", header: l("colLineNo"), numeric: true, render: (row) => <span className="font-mono text-12">{row.lineNo}</span> },
    { key: "externalRef", header: l("colExternalRef"), render: (row) => row.externalRef ?? "—" },
    { key: "riskRef", header: l("colRiskRef"), render: (row) => row.riskRef ?? "—" },
    { key: "matchState", header: l("colMatchState"), render: (row) => <Badge size="sm">{tag(l, "matchState", row.matchState)}</Badge> },
    {
      key: "grossPremiumMinor",
      header: l("colLineGross"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{money(row.grossPremiumMinor, row.currency, locale)}</span>
    },
    {
      key: "varianceMinor",
      header: l("colLineVariance"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{money(row.varianceMinor, row.currency, locale)}</span>
    }
  ];

  return (
    <div className="flex flex-col gap-6 pb-12">
      <Hero
        eyebrow="AXIS"
        title={l("title")}
        sub={l("intro")}
        mod="axis"
        hero={{
          chips: bordereaux.slice(0, 6).map((b) => ({
            label: `${b.counterpartyId} · ${b.period}`,
            value: money(b.grossPremiumMinor, b.currency, locale),
            hue: hueVar("axis"),
            detail: `${tag(l, "state", b.state)} — ${tag(l, "direction", b.direction)}`
          }))
        }}
      />
      {/* ScreenState's "empty" branch replaces its children outright, so only
          the register (which genuinely has nothing to show) sits inside it —
          the generate form must stay reachable even with zero bordereaux, or
          nobody could ever create the first one. */}
      <ScreenState state={bordereaux.length === 0 ? "empty" : "ready"} title={l("noneYet")} body={l("noneYet")}>
        <div className="flex flex-col gap-5">
          <div>{renderSection(grossByCounterparty, "axis")}</div>

          <Card title={l("registerTitle")} description={l("registerCaption")} padded={false}>
            <Table
              caption={l("registerCaption")}
              columns={registerColumns}
              rows={bordereaux}
              rowKey={(row) => row.id}
              onRowActivate={(row) => {
                window.location.href = `/axis/bordereaux?id=${encodeURIComponent(row.id)}`;
              }}
              empty={<EmptyState title={l("noneYet")} body={l("noneYet.body")} />}
            />
          </Card>
        </div>
      </ScreenState>

      {loaded.may.generate ? (
        <Card title={l("generateTitle")} description={l("generateIntro")}>
          <GenerateForm idempotencyKey={loaded.idempotencyKey} l={l} busy={busy} />
        </Card>
      ) : null}

      {selected ? (
        <>
          <Card title={l("selectedTitle")} description={l("selectedCaption")}>
            <Facts>
              <Entry term={l("colPeriod")}>{selected.period}</Entry>
              <Entry term={l("colDirection")}>{tag(l, "direction", selected.direction)}</Entry>
              <Entry term={l("colCounterparty")}>{selected.counterpartyId}</Entry>
              <Entry term={l("colState")}>{tag(l, "state", selected.state)}</Entry>
            </Facts>
            {kv ? <div className="mt-4">{renderSection(kv, "axis")}</div> : null}
            {loaded.may.reconcile ? (
              <Form method="post" className="mt-4 flex items-center gap-3 border-t border-border pt-4">
                <input type="hidden" name="intent" value="reconcile" />
                <input type="hidden" name="bordereauId" value={selected.id} />
                <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                <p className="font-ui text-12 text-muted">{l("reconcileIntro")}</p>
                <Button type="submit" loading={busy}>
                  {l("reconcileSubmit")}
                </Button>
              </Form>
            ) : null}
          </Card>

          {bands ? <div>{renderSection(bands, "axis")}</div> : null}

          <Card title={l("linesTitle")} description={l("linesCaption")} padded={false}>
            <Table
              caption={l("linesCaption")}
              columns={lineColumns}
              rows={lines}
              rowKey={(row) => row.id}
              empty={<EmptyState title={l("noLines")} body={l("noLines.body")} />}
            />
          </Card>
        </>
      ) : bordereaux.length > 0 ? (
        <EmptyState title={l("noneSelected")} body={l("noneSelected.body")} />
      ) : null}

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(result.done)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}
    </div>
  );
}

function GenerateForm({ idempotencyKey, l, busy }: { idempotencyKey: string; l: Label; busy: boolean }) {
  return (
    <Form method="post" className="flex flex-wrap items-end gap-4">
      <input type="hidden" name="intent" value="generate" />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("directionLabel")}
        <Select
          name="direction"
          defaultValue="outbound"
          options={DIRECTIONS.map((value) => ({ value, label: tag(l, "direction", value) }))}
        />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("counterpartyKindLabel")}
        <Select
          name="counterpartyKind"
          defaultValue="provider"
          options={COUNTERPARTY_KINDS.map((value) => ({ value, label: tag(l, "counterpartyKind", value) }))}
        />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("counterpartyIdLabel")}
        <Input name="counterpartyId" className="w-40" required />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("kindLabel")}
        <Select
          name="kind"
          defaultValue="premium"
          options={BORDEREAU_KINDS.map((value) => ({ value, label: tag(l, "bordereauKind", value) }))}
        />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("periodLabel")}
        <Input name="period" placeholder="2026-08" className="w-28" required />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("currencyLabel")}
        <Input name="currency" defaultValue="AED" className="w-20" />
      </label>
      <label className="flex w-full flex-col gap-1 font-ui text-12 text-muted">
        {l("linesLabel")}
        <textarea
          name="lines"
          rows={3}
          placeholder='[{"externalRef":"POL-1","grossPremiumMinor":100000}]'
          className="w-full rounded-md border border-border bg-surface-1 p-2 font-mono text-12"
        />
        <span className="text-12 text-subtle">{l("linesHint")}</span>
      </label>
      <Button type="submit" loading={busy}>
        {l("generateSubmit")}
      </Button>
    </Form>
  );
}

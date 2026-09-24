import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Money,
  PageHeader,
  Select,
  Table,
  type BadgeTone,
  type Column,
  type FlowMachine,
  type FlowVisit
} from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import { refOptions } from "../refs.server";
import { RefPicker, type RefOption } from "../components/ref-picker";
import { WorkLayout } from "../components/work-layout";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { who } from "../names";
import { Gate } from "./module";
import { useShellData } from "./workspace";
import { labelsFrom, type Label } from "./detail-kit";

// Running a payout period, docs/19 §5. Drafting is arithmetic: it prices the
// entries a period earned and writes a settlement row, and that is all — no
// accrual, no payment, no journal line. Money moves only when two different
// people sign, which is why this screen never shows one button labelled "pay":
// approving the number (`dist:commissions:settle`) and releasing it
// (`ledger:payouts:approve`) are separate grants and separate screens' worth of
// consequence (CLAUDE.md §12).

/* --------------------------------------------------------------- contract */

/** Exactly as apps/api/src/openapi.ts spells them on these routes. */
export const PERM = {
  read: "dist:commissions:read",
  settle: "dist:commissions:settle",
  pay: "ledger:payouts:approve"
} as const;

/**
 * The kinds a payout can be run for. `insurer` is money in, not out — the engine
 * refuses it — so it is not offered here (apps/api/src/engines/settlement.ts).
 */
export const PAYABLE_KINDS = ["partner", "creator", "publisher"] as const;

export const SETTLEMENT_STATES = ["draft", "approved", "paid", "disputed"] as const;

/** `ledger_settlements`, as the API returns it. */
export interface Settlement {
  id: string;
  counterpartyKind: string;
  counterpartyRef: string;
  period: string;
  grossMinor: number;
  adjustmentsMinor: number;
  netMinor: number;
  currency: string;
  statementFileId: string | null;
  state: string;
  approvedBy: string | null;
  txnId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunResult {
  settlement: Settlement;
  totals: {
    grossMinor: number;
    adjustmentsMinor: number;
    netMinor: number;
    carriedForwardMinor: number;
    carryInMinor: number;
  };
  terms: { minPayoutMinor: number; agreementId: string | null; agreementVersion: number | null };
  entryCount: number;
}

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/;

/* ---------------------------------------------------------------- helpers */

/** The reference the engine demands: a settlement is run for one channel. */
export function refFor(channelId: string | null | undefined): string | null {
  const id = (channelId ?? "").trim();
  return id ? `channel:${id}` : null;
}

/**
 * State tones. The shared `toneFor` knows none of these words, so every state
 * would render the same grey chip — and a disputed payout that looks like a
 * draft is a defect, not a style choice. Entry states are here too because the
 * statement lines carry them.
 */
const TONES: Record<string, BadgeTone> = {
  draft: "info",
  approved: "warning",
  paid: "success",
  disputed: "danger",
  accrued: "info",
  invoiced: "accent",
  received: "accent",
  payable: "warning",
  clawed_back: "danger",
  written_off: "danger"
};

export function settlementTone(state: string): BadgeTone {
  return TONES[state] ?? "neutral";
}

/* ------------------------------------------------------------------- flow */

/**
 * The payout machine as apps/api/src/engines/settlement.ts enforces it: a draft
 * approves or is disputed, an approved settlement pays or is disputed, a dispute
 * reopens as a draft, and paid is the end. `settlement.test.ts` pins it against
 * that engine; the diagram may draw this and nothing else.
 */
export const SETTLEMENT_FLOW: FlowMachine = {
  transitions: {
    draft: ["approved", "disputed"],
    approved: ["paid", "disputed"],
    paid: [],
    disputed: ["draft"]
  },
  spine: ["draft", "approved", "paid"],
  exits: ["disputed"]
};

/**
 * What a settlement row can honestly say about its own past. The engine will
 * not pay what was not approved, so a paid settlement's approval is a fact even
 * though the row carries no history — but only its drafting and its last change
 * carry a timestamp, and the inferred middle carries none.
 *
 * ponytail: derived from four columns because `ledger_settlements` keeps no
 * transition log. Read the log instead the day the engine writes one — a
 * reopened settlement's earlier lap is invisible here.
 */
export function settlementVisits(
  settlement: Pick<Settlement, "state" | "createdAt" | "updatedAt" | "approvedBy">
): FlowVisit[] {
  const spine = SETTLEMENT_FLOW.spine;
  const reached = spine.indexOf(settlement.state);
  const path = reached >= 0 ? spine.slice(0, reached + 1) : [spine[0] as string, settlement.state];
  const approvedAt = path.indexOf("approved");
  return path.map((state, i) => ({
    state,
    tone: settlementTone(state),
    // The two instants the row actually holds. Everything between them is known
    // to have happened, not known to have happened *when*.
    ...(i === 0 ? { at: settlement.createdAt } : {}),
    ...(i === path.length - 1 && i > 0 ? { at: settlement.updatedAt } : {}),
    ...(settlement.approvedBy && approvedAt >= 0 && i >= approvedAt
      ? { actor: settlement.approvedBy }
      : {})
  }));
}

/** `125_000` ppm is 12.5%. A rate rendered as its raw integer is a bug. */
export function percentFromPpm(ppm: number, locale = "en"): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(ppm / 1_000_000);
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The API's own bounds, checked here so a typo is not a round trip. */
export function reasonError(raw: string | null | undefined): "reasonRequired" | "reasonTooLong" | null {
  const reason = (raw ?? "").trim();
  if (reason.length < REASON_MIN) return "reasonRequired";
  if (reason.length > REASON_MAX) return "reasonTooLong";
  return null;
}

export interface Transition {
  intent: "approve" | "pay" | "dispute" | "reopen";
  /** The grant the API checks. Named on screen: the two signatures differ. */
  permission: string;
  /** The API requires a reason of 3–500 characters. */
  reason: boolean;
  /** Consequential: confirm in page before posting (never a native confirm). */
  confirm: boolean;
}

/**
 * The transitions the state machine allows *and* this actor holds. Withholding
 * is absence, not a disabled button. The API re-checks all of it.
 */
export function transitionsFor(
  settlement: Pick<Settlement, "state" | "netMinor" | "txnId">,
  held: ReadonlySet<string>
): Transition[] {
  const out: Transition[] = [];
  const settle = held.has(PERM.settle);
  const state = settlement.state;

  // A period below the payout floor has a zero net and carries forward; the
  // engine answers 409 rather than posting a nothing.
  if (settle && state === "draft" && settlement.netMinor > 0) {
    out.push({ intent: "approve", permission: PERM.settle, reason: false, confirm: false });
  }
  if (held.has(PERM.pay) && state === "approved") {
    out.push({ intent: "pay", permission: PERM.pay, reason: false, confirm: true });
  }
  if (settle && (state === "draft" || state === "approved")) {
    out.push({ intent: "dispute", permission: PERM.settle, reason: true, confirm: true });
  }
  // Reopening restates a period, so it is only offered while nothing has posted.
  if (settle && state === "disputed" && settlement.txnId === null) {
    out.push({ intent: "reopen", permission: PERM.settle, reason: true, confirm: true });
  }
  return out;
}

export interface QueueGroup {
  state: string;
  currency: string;
  count: number;
  netMinor: number;
}

/** The queue's totals: one row per state and currency, because adding AED to
 *  ZAR produces a number that means nothing (docs/22 §5.1). */
export function queueGroups(rows: readonly Settlement[]): QueueGroup[] {
  const groups = new Map<string, QueueGroup>();
  for (const row of rows) {
    const key = `${row.state}|${row.currency}`;
    const group = groups.get(key) ?? { state: row.state, currency: row.currency, count: 0, netMinor: 0 };
    group.count += 1;
    group.netMinor += row.netMinor;
    groups.set(key, group);
  }
  const order = (state: string) => {
    const at = (SETTLEMENT_STATES as readonly string[]).indexOf(state);
    return at === -1 ? SETTLEMENT_STATES.length : at;
  };
  return [...groups.values()].sort(
    (a, b) => order(a.state) - order(b.state) || a.currency.localeCompare(b.currency)
  );
}

/**
 * The queue's one-line summary: how many settlements, and how many of those
 * are sitting on the second-signature step. Falls back to the static intro
 * when the queue is empty — there is nothing real to count yet.
 */
export function queueHeadline(groups: readonly QueueGroup[], l: Label): string {
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  if (total === 0) return l("intro");
  const awaiting = groups.filter((group) => group.state === "approved").reduce((sum, group) => sum + group.count, 0);
  return awaiting > 0
    ? l("queueHeadline.awaiting", { count: String(total), awaiting: String(awaiting) })
    : l("queueHeadline.count", { count: String(total) });
}

export interface PeriodContext {
  counterpartyKind?: string;
  channelId?: string;
  period?: string;
}

/** The context in the URL, keeping only what both the queue filter and the run
 *  form can honour. A kind the engine refuses is not a choice. */
export function filtersFrom(url: URL): PeriodContext {
  const out: PeriodContext = {};
  const kind = (url.searchParams.get("counterpartyKind") ?? "").trim();
  if ((PAYABLE_KINDS as readonly string[]).includes(kind)) out.counterpartyKind = kind;
  const channelId = (url.searchParams.get("channelId") ?? "").trim();
  if (channelId) out.channelId = channelId;
  const period = (url.searchParams.get("period") ?? "").trim();
  if (MONTH.test(period)) out.period = period;
  return out;
}

/* ----------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Commission settlement",
    intro:
      "Draft what a channel earned in a period, then hand the number on. Drafting is arithmetic — nothing is accrued and no money moves. Approving the number and releasing the payment are two decisions, held by two different people.",
    deniedTitle: "You cannot read settlements",
    "queueHeadline.count": "{count} settlements in the queue.",
    "queueHeadline.awaiting": "{count} settlements in the queue, {awaiting} awaiting a second signature.",
    runTitle: "Draft a period",
    runIntro:
      "Redrafting a period that is still a draft replaces its figures. Once it is approved, a redraft returns it untouched.",
    counterpartyKind: "Counterparty type",
    channelId: "Channel",
    channelIdHint: "The channel identifier; the settlement is run for channel:{example}.",
    period: "Period",
    periodHint: "The calendar month being settled.",
    currency: "Currency",
    currencyHint: "Optional. Defaults to the currency the entries were written in.",
    run: "Draft this period",
    filters: "Counterparty and period",
    apply: "Show this queue",
    clear: "Show every counterparty",
    "kind.partner": "Partner",
    "kind.creator": "Creator",
    "kind.publisher": "Publisher",
    // Not draftable here (PAYABLE_KINDS) but rows carry it: money in from a
    // carrier is settled the same way and shows up in this queue.
    "kind.insurer": "Insurer",
    "state.approved": "Approved, awaiting payment",
    draftedTitle: "Drafted",
    draftedBody: "{count} commission entries priced. Nothing has posted yet.",
    draftedNet: "Net for this period",
    openDrafted: "Open this settlement",
    queueTitle: "Settlement queue",
    queueCaption: "Settlements by state, with the net each state holds",
    queueEmpty: "Nothing waiting to settle.",
    "queueEmpty.body": "Settlements are drafted when a period closes and commission is due. Close a period in the ledger to fill this queue.",
    listCaption: "Settlements matching this counterparty and period",
    colCounterparty: "Counterparty",
    colPeriod: "Period",
    colGross: "Gross",
    colAdjustments: "Adjustments",
    colNet: "Net",
    colState: "State",
    colCreated: "Drafted",
    openFor: "Open the {period} settlement for {counterparty}",
    groupCount: "{count} settlements",
    emptyTitle: "No settlement here yet",
    emptyBody: "Nothing has been drafted for this counterparty and period. Draft it above.",
    periodInvalid: "Enter the month as YYYY-MM, for example 2026-06.",
    channelRequired: "Name the channel this settlement is for.",
    awaitingSecond: "Waiting for a second signature",
    twoSignatures:
      "Approving accrues what is owed. Releasing it pays. The two are different permissions on purpose."
  },
  ar: {
    title: "تسوية العمولات",
    intro:
      "احسب ما استحقته القناة في الفترة ثم أحِل الرقم. الحساب مجرد حساب — لا استحقاق ولا تحويل أموال. الموافقة على الرقم وصرف الدفعة قراران يتخذهما شخصان مختلفان.",
    deniedTitle: "لا يمكنك عرض التسويات",
    "queueHeadline.count": "{count} تسوية في قائمة الانتظار.",
    "queueHeadline.awaiting": "{count} تسوية في قائمة الانتظار، {awaiting} بانتظار توقيع ثانٍ.",
    runTitle: "احسب فترة",
    runIntro: "إعادة حساب فترة لا تزال مسودة تستبدل أرقامها. وبعد الموافقة عليها تُعاد الفترة كما هي دون تغيير.",
    counterpartyKind: "نوع الطرف المقابل",
    channelId: "القناة",
    channelIdHint: "معرّف القناة؛ تُحسب التسوية للمرجع channel:{example}.",
    period: "الفترة",
    periodHint: "الشهر الميلادي الذي تجري تسويته.",
    currency: "العملة",
    currencyHint: "اختياري. القيمة الافتراضية هي عملة القيود نفسها.",
    run: "احسب هذه الفترة",
    filters: "الطرف المقابل والفترة",
    apply: "اعرض هذه القائمة",
    clear: "اعرض كل الأطراف",
    "kind.partner": "شريك",
    "kind.creator": "صانع محتوى",
    "kind.publisher": "ناشر",
    "kind.insurer": "شركة تأمين",
    "state.approved": "موافَق عليها، بانتظار الصرف",
    draftedTitle: "تم الحساب",
    draftedBody: "تم تسعير {count} قيد عمولة. لم يُرحّل شيء بعد.",
    draftedNet: "الصافي لهذه الفترة",
    openDrafted: "افتح هذه التسوية",
    queueTitle: "قائمة التسويات",
    queueCaption: "التسويات بحسب الحالة، مع صافي كل حالة",
    queueEmpty: "لا يوجد شيء بانتظار التسوية.",
    "queueEmpty.body": "تُصاغ التسويات عند إقفال فترة واستحقاق العمولة. أقفل فترة في دفتر الأستاذ لتمتلئ هذه القائمة.",
    listCaption: "التسويات المطابقة لهذا الطرف المقابل وهذه الفترة",
    colCounterparty: "الطرف المقابل",
    colPeriod: "الفترة",
    colGross: "الإجمالي",
    colAdjustments: "التسويات",
    colNet: "الصافي",
    colState: "الحالة",
    colCreated: "تاريخ الحساب",
    openFor: "افتح تسوية {period} للطرف {counterparty}",
    groupCount: "{count} تسوية",
    emptyTitle: "لا توجد تسوية هنا بعد",
    emptyBody: "لم تُحسب أي فترة لهذا الطرف المقابل. احسبها من الأعلى.",
    periodInvalid: "أدخل الشهر بالصيغة YYYY-MM، مثل 2026-06.",
    channelRequired: "حدّد القناة التي تخصها هذه التسوية.",
    awaitingSecond: "في انتظار توقيع ثانٍ",
    twoSignatures: "الموافقة تسجّل ما هو مستحق، والصرف يدفعه. وهما صلاحيتان مختلفتان بقصد."
  }
};

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

/** This month, as the API spells a period. */
function thisMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const filters = filtersFrom(new URL(request.url));
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = { read: held.has(PERM.read), settle: held.has(PERM.settle), pay: held.has(PERM.pay) };
  // Minted per render, not per click: a double submit is then the same run
  // twice, which the API deduplicates (CLAUDE.md §12).
  const idempotencyKey = crypto.randomUUID();
  const shut = {
    may: { ...may, read: false },
    filters,
    settlements: [] as Settlement[],
    resolved: {} as Record<string, string>,
    channels: [] as RefOption[],
    idempotencyKey
  };

  if (!may.read) return shut;

  // Both boxes wanted `ch_01KE…` typed in from memory. The channel list is
  // short and named; an actor who cannot read it keeps the plain box.
  const channels = await refOptions("/v1/dist/channels?sort=name&order=asc&limit=200", env, request);

  const query = new URLSearchParams({ limit: "100" });
  if (filters.counterpartyKind) query.set("counterpartyKind", filters.counterpartyKind);
  const ref = refFor(filters.channelId);
  if (ref) query.set("counterpartyRef", ref);
  if (filters.period) query.set("period", filters.period);

  try {
    const page = await api<{ data: Settlement[] }>(`/v1/ledger/settlements?${query.toString()}`, { env, request });
    // A settlement carries `channel:ch_…` / `provider:pv_…` and no name for it,
    // so the COUNTERPARTY column was a queue of ULIDs (ADR-0048).
    const resolved = await names(page.data.map((one) => one.counterpartyRef), { env, request });
    return { may, filters, settlements: page.data, resolved, channels, idempotencyKey };
  } catch (error) {
    // A grant can be revoked between /v1/me and this call; that is a notice,
    // never a blank screen.
    if (error instanceof ApiError && error.status === 403) return { ...shut, channels };
    throw error;
  }
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const nothing = { problem: null, error: null as string | null, run: null as RunResult | null };

  if (String(form.get("intent") ?? "") !== "run") {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }

  const period = String(form.get("period") ?? "").trim();
  if (!MONTH.test(period)) return { ...nothing, error: "periodInvalid" };
  const counterpartyRef = refFor(String(form.get("channelId") ?? ""));
  if (!counterpartyRef) return { ...nothing, error: "channelRequired" };
  const kind = String(form.get("counterpartyKind") ?? "").trim();
  const currency = String(form.get("currency") ?? "").trim().toUpperCase();
  const key = String(form.get("idempotencyKey") ?? "");

  try {
    const drafted = await api<RunResult>("/v1/settlement/runs", {
      env,
      request,
      method: "POST",
      ...(key ? { headers: { "idempotency-key": key } } : {}),
      body: {
        counterpartyKind: (PAYABLE_KINDS as readonly string[]).includes(kind) ? kind : PAYABLE_KINDS[0],
        counterpartyRef,
        period,
        ...(currency.length === 3 ? { currency } : {})
      }
    });
    return { ...nothing, run: drafted };
  } catch (error) {
    // "no agreement", a period already paid and a refused permission are all
    // answers, not crashes: they belong beside the form.
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function SettlementPeriod() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const location = useLocation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (!loaded.may.read) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const groups = queueGroups(loaded.settlements);
  const drafted = result?.run ?? null;
  const context = loaded.filters;

  const columns: Array<Column<Settlement>> = [
    {
      key: "counterpartyRef",
      header: l("colCounterparty"),
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-13 text-text">{who(row.counterpartyRef, loaded.resolved)}</span>
          <span className="font-ui text-12 text-subtle">{l(`kind.${row.counterpartyKind}`)}</span>
        </span>
      )
    },
    { key: "period", header: l("colPeriod"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
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
      render: (row) => (
        <Money amountMinor={row.adjustmentsMinor} currency={row.currency} locale={locale} signed toned />
      )
    },
    {
      key: "netMinor",
      header: l("colNet"),
      numeric: true,
      render: (row) => <Money amountMinor={row.netMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "state",
      header: l("colState"),
      render: (row) => (
        <span className="flex flex-col items-start gap-0.5">
          <Badge tone={settlementTone(row.state)} size="sm" dot>
            {l(`state.${row.state}`)}
          </Badge>
          {row.state === "approved" ? (
            <span className="font-ui text-12 text-subtle">{l("awaitingSecond")}</span>
          ) : null}
        </span>
      )
    },
    {
      key: "open",
      header: t("common.actions"),
      render: (row) => (
        // Text, not a chevron: a link a screen reader can only announce as
        // "link" is not a navigation affordance.
        <Link
          to={`/ledger/settlements/${row.id}`}
          aria-label={l("openFor", {
            period: row.period,
            counterparty: who(row.counterpartyRef, loaded.resolved) ?? row.counterpartyRef
          })}
          className="font-ui text-12 text-accent underline-offset-2 hover:underline"
        >
          {l("open")}
        </Link>
      )
    }
  ];

  // What is waiting, before anything that drafts more: the register leads and
  // the run composer sits beside it (WorkLayout), or alone when there is none.
  const register = (
    <div aria-busy={busy} className="flex flex-col gap-4">
      <Card title={l("queueTitle")} padded={false}>
        <Table
          caption={l("queueCaption")}
          density="compact"
          rowKey={(group) => `${group.state}|${group.currency}`}
          rows={groups}
          empty={<EmptyState title={l("queueEmpty")} body={l("queueEmpty.body")} />}
          columns={[
            {
              key: "state",
              header: l("colState"),
              render: (group) => (
                <Badge tone={settlementTone(group.state)} size="sm" dot>
                  {l(`state.${group.state}`)}
                </Badge>
              )
            },
            {
              key: "count",
              header: t("common.rows"),
              render: (group) => l("groupCount", { count: String(group.count) })
            },
            {
              key: "netMinor",
              header: l("colNet"),
              numeric: true,
              render: (group) => (
                <Money amountMinor={group.netMinor} currency={group.currency} locale={locale} />
              )
            }
          ]}
        />
      </Card>

      {loaded.settlements.length === 0 ? (
        <EmptyState title={l("emptyTitle")} body={l("emptyBody")} />
      ) : (
        <Table
          caption={l("listCaption")}
          columns={columns}
          rows={loaded.settlements}
          rowKey={(row) => row.id}
          rowState={(row) => (row.state === "paid" ? "sealed" : row.state === "draft" ? "draft" : undefined)}
        />
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={l("title")} title={queueHeadline(groups, l)} description={l("intro")} />

      <Form method="get" className="flex flex-wrap items-end gap-3" aria-label={l("filters")}>
        <Field label={l("counterpartyKind")}>
          <Select
            name="counterpartyKind"
            defaultValue={context.counterpartyKind ?? ""}
            placeholder={t("common.all")}
            options={[
              { value: "", label: t("common.all") },
              ...PAYABLE_KINDS.map((kind) => ({ value: kind, label: l(`kind.${kind}`) }))
            ]}
          />
        </Field>
        <Field label={l("channelId")}>
          <RefPicker
            name="channelId"
            options={loaded.channels}
            defaultValue={context.channelId ?? ""}
            className="w-56"
          />
        </Field>
        <Field label={l("period")}>
          <Input type="month" name="period" defaultValue={context.period ?? ""} />
        </Field>
        <Button type="submit" variant="secondary" size="sm" loading={busy}>
          {l("apply")}
        </Button>
        {Object.keys(context).length > 0 ? (
          <Button asChild variant="ghost" size="sm">
            <Link to={location.pathname}>{l("clear")}</Link>
          </Button>
        ) : null}
      </Form>

      {/* The register first, the run composer beside it: a controller opens
          this screen to see what is waiting, and drafts a period second. */}
      {loaded.may.settle || drafted || result?.error || result?.problem ? (
        <WorkLayout
          aside={
            <>
              {loaded.may.settle ? (
                <Card title={l("runTitle")} description={l("runIntro")}>
                  <Form method="post" className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="intent" value="run" />
                    <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                    <Field label={l("counterpartyKind")} required>
                      <Select
                        name="counterpartyKind"
                        defaultValue={context.counterpartyKind ?? PAYABLE_KINDS[0]}
                        options={PAYABLE_KINDS.map((kind) => ({ value: kind, label: l(`kind.${kind}`) }))}
                      />
                    </Field>
                    <Field label={l("channelId")} required hint={l("channelIdHint", { example: "…" })}>
                      <RefPicker
                        name="channelId"
                        options={loaded.channels}
                        defaultValue={context.channelId ?? ""}
                        className="w-56"
                      />
                    </Field>
                    <Field label={l("period")} required hint={l("periodHint")}>
                      <Input type="month" name="period" required defaultValue={context.period ?? thisMonth()} />
                    </Field>
                    <Field label={l("currency")} hint={l("currencyHint")}>
                      <Input name="currency" maxLength={3} pattern="[A-Za-z]{3}" className="w-24" />
                    </Field>
                    <Button type="submit" loading={busy}>
                      {l("run")}
                    </Button>
                  </Form>

                  <p className="mt-3 font-ui text-12 text-subtle">{l("twoSignatures")}</p>
                </Card>
              ) : null}

              {result?.error ? (
                <p role="alert" className="font-ui text-13 text-danger">
                  {l(result.error)}
                </p>
              ) : null}
              {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

              {drafted ? (
                <Card
                  title={l("draftedTitle")}
                  description={l("draftedBody", { count: String(drafted.entryCount) })}
                  actions={
                    <Badge tone={settlementTone(drafted.settlement.state)} size="sm" dot>
                      {l(`state.${drafted.settlement.state}`)}
                    </Badge>
                  }
                >
                  <p className="flex flex-wrap items-baseline gap-2" role="status">
                    <span className="font-ui text-12 text-subtle">{l("draftedNet")}</span>
                    <Money
                      amountMinor={drafted.settlement.netMinor}
                      currency={drafted.settlement.currency}
                      locale={locale}
                      className="font-ui text-22"
                    />
                  </p>
                  <Button asChild variant="secondary" size="sm" className="mt-3">
                    <Link to={`/ledger/settlements/${drafted.settlement.id}`}>{l("openDrafted")}</Link>
                  </Button>
                </Card>
              ) : null}
            </>
          }
        >
          {register}
        </WorkLayout>
      ) : (
        register
      )}
    </div>
  );
}

/**
 * A refusal, and the gate behind it if there is one. A policy key is a system
 * string: it is quoted inside a sentence, never handed to a person on its own.
 */
// The notice itself now lives beside <Problem> in module.tsx, because the
// generic record screen needs it too. Re-exported here for existing callers.
export { Gate };

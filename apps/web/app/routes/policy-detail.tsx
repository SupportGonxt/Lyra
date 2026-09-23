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
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  Input,
  Money,
  MoneyField,
  Ref,
  Stat,
  StateFlow,
  Table,
  formatInstant,
  formatMoney,
  hueVar,
  renderSection,
  type Column,
  type FlowMachine,
  type FlowVisit,
  type Section
} from "@lyra/ui";
import { ApiError, api, fetchMe, names, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import {
  Entry,
  Facts,
  Header,
  Payload,
  labelsFrom,
  percentOf,
  rowsOf,
  safe,
  tag,
  type Label,
  type Page
} from "./detail-kit";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { MemoryPanel } from "../components/memory-panel";

// One agreement: what it covers, what it costs, what has been claimed against
// it, the paper behind it, and its own version history. Endorse, cancel and
// renew each price on their own screen before they write. Reprice and premium
// financing live here instead: each is one API call with nothing to preview,
// so pricing and writing are the same step. A reprice can still come back as
// an approval refusal rather than a done banner (CLAUDE.md §4) — the API
// gates it exactly when the telemetry-driven premium actually moves.

/* --------------------------------------------------------------- contract */

export interface Policy {
  id: string;
  caseId?: string | null;
  customerId: string;
  providerId: string;
  productId?: string | null;
  offeringId?: string | null;
  channelId?: string | null;
  policyNo: string;
  startAt: number;
  endAt: number;
  premiumMinor: number;
  currency: string;
  commissionMinor: number;
  docsJson?: unknown;
  escrowBatchId?: string | null;
  paymentPlanJson?: unknown;
  status: string;
  createdAt: number;
  updatedAt: number;
}

export interface ClaimRow {
  id: string;
  claimNo: string;
  status: string;
  /** `axis_claims.incident_at` is nullable — a claim registered before the loss
   *  date is established has none. `DateTime` renders the dash for it. */
  incidentAt: number | null;
  amountMinor?: number | null;
  settledMinor?: number | null;
  currency: string;
}

export interface EntryRow {
  id: string;
  kind: string;
  premiumMinor: number;
  grossCommissionMinor: number;
  netCommissionMinor: number;
  currency: string;
  earnedAt?: number | null;
  state: string;
}

export interface FileRow {
  id: string;
  kind: string;
  contentType?: string | null;
  piiLevel: string;
  createdAt: number;
}

/** One row of `axis_policy_versions` — this contract's own history (F5). */
export interface VersionRow {
  id: string;
  versionSeq: number;
  endorsementNo?: string | null;
  reason?: string | null;
  reasonCode?: string | null;
  effectiveFrom: number;
  effectiveTo?: number | null;
  premiumMinor: number;
  premiumDeltaMinor: number;
  currency: string;
  state: string;
  issuedAt?: number | null;
  createdAt: number;
}

export const PERM = {
  read: "axis:policies:read",
  endorse: "axis:policies:endorse",
  cancel: "axis:policies:cancel",
  renew: "axis:policies:renew",
  finance: "axis:policies:finance",
  claims: "axis:claims:read",
  commissions: "dist:commissions:read",
  files: "core:files:read",
  audit: "core:audit:read"
} as const;

/** One instalment of a premium financing plan, as `plan.scheduleJson` holds it
 *  — mirrors `ScheduleRow` in apps/api/src/engines/premium-financing.ts. */
export interface ScheduleRow {
  seq: number;
  dueAt: number;
  amountMinor: number;
  state: "pending" | "due" | "paid" | "missed";
  missedPaymentId?: string | undefined;
}

/** One line of the tenant's audit trail, as /v1/core/audit-log returns it. */
export interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

/**
 * Mirrors POLICY_TRANSITIONS in packages/core/src/lifecycle.ts. The web app
 * cannot import @lyra/core (same reason claim-detail.tsx and case-detail.tsx
 * restate their machines), and the API refuses a hop this map would wrongly
 * allow, so drift is caught where it matters rather than shipped as a wrong
 * diagram.
 */
export const POLICY_TRANSITIONS: Record<string, readonly string[]> = {
  draft: ["bound", "ntu"],
  bound: ["active", "ntu", "cancelled"],
  active: ["lapsed", "cancelled", "expired", "renewed"],
  lapsed: ["active", "cancelled", "expired"],
  cancelled: [],
  expired: ["renewed"], // late renewal inside the grace window
  renewed: [],
  ntu: []
};

/**
 * The flow the diagram draws. The spine is the life of an agreement that goes
 * well: quoted into a draft, bound, incepted, and renewed at term. Every other
 * ending — never taken up, lapsed for non-payment, cancelled, or run out
 * without renewal — is an exit, so a live agreement is never told it is pending
 * its own expiry. `lapsed` still offers reinstatement because the machine
 * documents `lapsed → active`, and `expired` still offers a late renewal.
 * `flowPlan` refuses a spine whose consecutive pair is not a documented edge of
 * `POLICY_TRANSITIONS`, so this literal cannot drift from the machine above
 * without a test failing.
 */
export const POLICY_FLOW: FlowMachine = {
  transitions: POLICY_TRANSITIONS,
  spine: ["draft", "bound", "active", "renewed"],
  exits: ["ntu", "lapsed", "cancelled", "expired"]
};

/**
 * The policy trail records *verbs*, not states: engines/axis-lifecycle.ts writes
 * `axis.policy.cancel` for the hop that lands on `cancelled`, and `incept` and
 * `reinstate` both land on `active`. So a state has to be read off the verb.
 * Anything that changes an agreement without moving it — an endorsement, an
 * issued document, a referral, a broker fee — is not a hop and is dropped
 * rather than guessed at. `draft` is absent on purpose: routes/axis.ts inserts a
 * draft with no audit row of its own (the bind that follows writes the first
 * one), so no trail can ever claim it.
 */
const STATE_OF_VERB: Record<string, string> = {
  bind: "bound",
  bind_group: "bound",
  incept: "active",
  reinstate: "active",
  lapse: "lapsed",
  cancel: "cancelled",
  expire: "expired",
  renew: "renewed",
  ntu: "ntu"
};

export function stateOfAudit(action: string): string | null {
  const prefix = "axis.policy.";
  if (!action.startsWith(prefix)) return null;
  return STATE_OF_VERB[action.slice(prefix.length)] ?? null;
}

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    noneClaims: "No claim has been reported against this agreement.",
    noneVersions: "This agreement has not been endorsed or renewed since it was issued.",
    noneEntries: "Nothing has been posted to the ledger against this agreement yet.",
    noneDocuments: "No files are attached to this agreement.",
    intro: "What is covered, what it costs, what has been claimed against it, and the paper behind it.",
    back: "Back to the register",
    heroLede: "{status} · {from} – {to}",
    coverTitle: "The agreement",
    term: "Term",
    holder: "Held by",
    provider: "Underwritten by",
    product: "Product",
    offering: "Variant",
    channel: "Sold through",
    caseRef: "Work item",
    commission: "Commission",
    escrow: "Escrow batch",
    paymentPlanTitle: "Payment plan",
    docsTitle: "Schedule and wording",
    claimsCaption: "Every claim reported against this agreement.",
    flowTitle: "Where it stands",
    flowLabel: "Agreement lifecycle",
    historyTitle: "Endorsement history",
    historyCaption: "Every version of this agreement, newest first.",
    moneyTitle: "Commission trail",
    moneyCaption: "What this agreement earned, and any reversal against it.",
    documentsTitle: "Documents",
    documentsCaption: "Files filed against this agreement.",
    actionsTitle: "Change this agreement",
    actionsIntro:
      "Each of these prices before it writes, and each leaves a version behind. Nothing here edits this agreement in place.",
    endorseLink: "Endorse",
    cancelLink: "Cancel",
    renewLink: "Renew",
    repriceTitle: "Reprice from telemetry",
    repriceIntro: "Recomputes the premium from the driving data on file. Prices before it writes, and may need sign-off.",
    repriceSubmit: "Reprice now",
    repriceDone: "Reprice complete.",
    repriceCompareTitle: "Premium before and after",
    repricePrevious: "Previous premium",
    repriceNew: "New premium",
    repriceNoChangeTitle: "No change",
    repriceNoChange: "Telemetry found nothing worth repricing for.",
    financeTitle: "Premium financing plan",
    financeIntro: "Splits the premium into instalments through a financier. One plan per agreement.",
    financeFinancier: "Financier",
    financeTotal: "Total financed",
    financeInstalments: "Instalments",
    financeStart: "First instalment",
    financeFrequency: "Days between instalments",
    financeCommission: "Financier commission",
    financeCommissionTax: "Commission tax",
    financeSubmit: "Create plan",
    financeDone: "Financing plan created.",
    financeCurrencyRequired: "Choose the currency being financed.",
    financeAmountRequired: "Total and commission must be positive amounts, and any tax may not be negative.",
    financeScheduleRequired: "Instalments and the gap between them must be positive, and the first instalment needs a real date.",
    financeScheduleTitle: "Instalment schedule",
    "instalmentState.pending": "Pending",
    "instalmentState.due": "Due",
    "instalmentState.paid": "Paid",
    "instalmentState.missed": "Missed",
    colVersion: "Version",
    colReason: "Reason",
    colEffective: "Effective",
    colDelta: "Change",
    colClaimAmount: "Claimed",
    colSettled: "Settled",
    colIncident: "Incident",
    colEarnedAt: "Earned",
    colGross: "Gross",
    colNet: "Net",
    colFormat: "Format",
    colFiled: "Filed"
  },
  ar: {
    noneClaims: "لم تُسجَّل أي مطالبة على هذه الاتفاقية.",
    noneVersions: "لم تُعدَّل هذه الاتفاقية أو تُجدَّد منذ إصدارها.",
    noneEntries: "لم يُرحَّل شيء إلى الدفاتر على هذه الاتفاقية بعد.",
    noneDocuments: "لا توجد ملفات مرفقة بهذه الاتفاقية.",
    intro: "ما هو مغطّى، وتكلفته، والمطالبات المسجّلة عليه، والمستندات المرتبطة به.",
    back: "العودة إلى السجل",
    heroLede: "{status} · من {from} إلى {to}",
    coverTitle: "الاتفاقية",
    term: "المدة",
    holder: "صاحب التغطية",
    provider: "جهة الاكتتاب",
    product: "المنتج",
    offering: "الصيغة",
    channel: "قناة البيع",
    caseRef: "بند العمل",
    commission: "العمولة",
    escrow: "دفعة الضمان",
    paymentPlanTitle: "خطة السداد",
    docsTitle: "الجدول والصيغة",
    claimsCaption: "كل مطالبة مسجّلة على هذه الاتفاقية.",
    flowTitle: "موضعها الآن",
    flowLabel: "دورة حياة الاتفاقية",
    historyTitle: "سجل التعديلات",
    historyCaption: "كل إصدار من هذه الاتفاقية، الأحدث أولًا.",
    moneyTitle: "مسار العمولة",
    moneyCaption: "ما حققته هذه الاتفاقية، وأي عكس مسجّل عليها.",
    documentsTitle: "المستندات",
    documentsCaption: "الملفات المرفقة بهذه الاتفاقية.",
    actionsTitle: "تغيير هذه الاتفاقية",
    actionsIntro: "كل إجراء هنا يسعّر قبل أن يكتب، ويترك إصدارًا جديدًا. لا شيء منها يعدّل هذه الاتفاقية في مكانها.",
    endorseLink: "تعديل",
    cancelLink: "إلغاء",
    renewLink: "تجديد",
    repriceTitle: "إعادة التسعير من بيانات القيادة",
    repriceIntro: "يعيد احتساب القسط من بيانات القيادة المسجّلة. يسعّر قبل أن يكتب، وقد يحتاج موافقة.",
    repriceSubmit: "إعادة التسعير الآن",
    repriceDone: "اكتملت إعادة التسعير.",
    repriceCompareTitle: "القسط قبل وبعد",
    repricePrevious: "القسط السابق",
    repriceNew: "القسط الجديد",
    repriceNoChangeTitle: "لا تغيير",
    repriceNoChange: "لم تجد بيانات القيادة ما يستحق إعادة التسعير من أجله.",
    financeTitle: "خطة تمويل القسط",
    financeIntro: "تقسّم القسط إلى دفعات عبر جهة تمويل. خطة واحدة لكل اتفاقية.",
    financeFinancier: "جهة التمويل",
    financeTotal: "المبلغ الممول",
    financeInstalments: "عدد الدفعات",
    financeStart: "الدفعة الأولى",
    financeFrequency: "الأيام بين الدفعات",
    financeCommission: "عمولة جهة التمويل",
    financeCommissionTax: "ضريبة العمولة",
    financeSubmit: "إنشاء الخطة",
    financeDone: "تم إنشاء خطة التمويل.",
    financeCurrencyRequired: "اختر عملة التمويل.",
    financeAmountRequired: "يجب أن يكون المبلغ الإجمالي والعمولة قيمتين موجبتين، وألا تكون الضريبة سالبة.",
    financeScheduleRequired: "يجب أن يكون عدد الدفعات والفاصل بينها موجبين، وأن يكون تاريخ الدفعة الأولى تاريخًا حقيقيًا.",
    financeScheduleTitle: "جدول الدفعات",
    "instalmentState.pending": "قيد الانتظار",
    "instalmentState.due": "مستحقة",
    "instalmentState.paid": "مسددة",
    "instalmentState.missed": "متأخرة",
    colVersion: "الإصدار",
    colReason: "السبب",
    colEffective: "سريان",
    colDelta: "الفرق",
    colClaimAmount: "المطلوب",
    colSettled: "المسدد",
    colIncident: "تاريخ الحادث",
    colEarnedAt: "تاريخ التحقق",
    colGross: "الإجمالي",
    colNet: "الصافي",
    colFormat: "الصيغة",
    colFiled: "تاريخ الإيداع"
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the policy number: its status and its cover term — is it
 * still running, and until when — no ✦, formatting of the loaded record's
 * own dates, not a model finding (CLAUDE.md §11). */
export function policyLede(policy: Pick<Policy, "status" | "startAt" | "endAt">, l: Label, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
  return l("heroLede", {
    status: tag(l, "status", policy.status),
    from: formatInstant(policy.startAt, fmt.format),
    to: formatInstant(policy.endAt, fmt.format)
  });
}

/** A date input gives "2026-08-04"; the schema wants epoch millis. Mirrors
 *  `epochOf` in policy-cancel.tsx. */
function epochOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* ------------------------------------------------------------------ action */

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = params.id ?? String(form.get("id") ?? "");
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

  if (intent === "reprice") {
    // Empty body: the engine reads the policy's own unpriced telemetry
    // exposure, same as apps/api/src/routes/axis.ts's /reprice route.
    path = `/v1/axis/policies/${id}/reprice`;
    body = {};
    suffix = "reprice";
    done = "repriceDone";
  } else if (intent === "finance-plan") {
    const currency = text("currency");
    if (!currency) return { ...nothing, error: "financeCurrencyRequired" };

    const totalMinor = Number(text("totalMinor"));
    const commissionMinor = Number(text("commissionMinor"));
    const rawTax = text("commissionTaxMinor");
    const commissionTaxMinor = rawTax === "" ? undefined : Number(rawTax);
    if (
      !Number.isInteger(totalMinor) ||
      totalMinor <= 0 ||
      !Number.isInteger(commissionMinor) ||
      commissionMinor <= 0 ||
      (commissionTaxMinor !== undefined && (!Number.isInteger(commissionTaxMinor) || commissionTaxMinor < 0))
    ) {
      return { ...nothing, error: "financeAmountRequired" };
    }

    const instalments = Number(text("instalments"));
    const frequencyDays = Number(text("frequencyDays"));
    const startAt = epochOf(text("startAt"));
    if (
      !Number.isInteger(instalments) ||
      instalments <= 0 ||
      !Number.isInteger(frequencyDays) ||
      frequencyDays <= 0 ||
      startAt === null ||
      startAt <= 0
    ) {
      return { ...nothing, error: "financeScheduleRequired" };
    }

    const financierRef = text("financierRef");
    path = `/v1/axis/policies/${id}/premium-financing-plan`;
    body = {
      totalMinor,
      currency,
      instalments,
      startAt,
      frequencyDays,
      commissionMinor,
      ...(financierRef ? { financierRef } : {}),
      ...(commissionTaxMinor !== undefined ? { commissionTaxMinor } : {})
    };
    // Two plans in one page load would be an error anyway (one plan per
    // policy), but the total still keys the write like every other action.
    suffix = `finance-plan:${totalMinor}`;
    done = "financeDone";
  } else {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    // A reprice is gated by whatever policy_key axis-endorse.ts's gate()
    // names when the telemetry-driven premium actually moves; a 403 with
    // approval_required is the normal answer here, not an error to hide.
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

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const options = { env, request };
  const may = {
    read: held.has(PERM.read),
    endorse: held.has(PERM.endorse),
    cancel: held.has(PERM.cancel),
    renew: held.has(PERM.renew),
    financing: held.has(PERM.finance)
  };

  const empty = {
    policy: null as Policy | null,
    claims: [] as ClaimRow[],
    entries: [] as EntryRow[],
    documents: [] as FileRow[],
    versions: [] as VersionRow[],
    trail: [] as AuditRow[],
    named: {} as Record<string, string>,
    may,
    idempotencyKey: crypto.randomUUID()
  };

  if (!may.read) return empty;
  const policy = await safe(() => api<Policy>(`/v1/axis/policies/${id}`, options), null);
  if (!policy) return empty;

  const [claims, entries, documents, versions, trail, named] = await Promise.all([
    held.has(PERM.claims)
      ? safe(() => api<Page<ClaimRow>>(`/v1/axis/claims?policyId=${id}&limit=50`, options), null)
      : null,
    held.has(PERM.commissions)
      ? safe(() => api<Page<EntryRow>>(`/v1/dist/commission-entries?policyId=${id}&limit=50`, options), null)
      : null,
    held.has(PERM.files)
      ? safe(
          () =>
            api<Page<FileRow>>(
              `/v1/core/files?subjectRef=${encodeURIComponent(`policies:${id}`)}&limit=50`,
              options
            ),
          null
        )
      : null,
    // This agreement's own versions (F5). The old query asked for every other
    // contract the same holder owns, which is a different question entirely.
    safe(() => api<Page<VersionRow>>(`/v1/axis/policies/${id}/versions`, options), null),
    // The state hops, so the flow can say when each one happened and who did it.
    // The versions above are a different history: they record what the paper
    // said, not where the agreement stood.
    held.has(PERM.audit)
      ? safe(
          () =>
            api<Page<AuditRow>>(
              `/v1/core/audit-log?subjectRef=${encodeURIComponent(id)}&sort=ts&order=desc&limit=25`,
              options
            ),
          null
        )
      : null,
    // Everything this agreement points at, named in one call: a person reads
    // "Amina Haddad", not `cu_01KE…`.
    names(
      [policy.customerId, policy.providerId, policy.productId, policy.channelId].filter(
        (ref): ref is string => Boolean(ref)
      ),
      options
    ).catch(() => ({}) as Record<string, string>)
  ]);

  return {
    ...empty,
    policy,
    claims: rowsOf(claims),
    entries: rowsOf(entries),
    documents: rowsOf(documents),
    versions: rowsOf(versions),
    trail: rowsOf(trail),
    named
  };
}

/* --------------------------------------------------------------- component */

/** The reprice API returns only the new premium and the ppm delta that
 *  produced it (apps/api/src/engines/telematics.ts's `repriceFromTelemetry`),
 *  or `{ repriced: false }` when telemetry found nothing worth repricing for. */
function asRepriceData(
  data: unknown
): { repriced: boolean; premiumMinor?: number | undefined; premiumDeltaPpm?: number | undefined } | null {
  if (!data || typeof data !== "object" || !("repriced" in data)) return null;
  const d = data as { repriced: unknown; premiumMinor?: unknown; premiumDeltaPpm?: unknown };
  if (typeof d.repriced !== "boolean") return null;
  return {
    repriced: d.repriced,
    premiumMinor: typeof d.premiumMinor === "number" ? d.premiumMinor : undefined,
    premiumDeltaPpm: typeof d.premiumDeltaPpm === "number" ? d.premiumDeltaPpm : undefined
  };
}

/** `POST .../premium-financing-plan` returns `{ plan, txn }` (apps/api/src/
 *  engines/premium-financing.ts's `createPlan`); the schedule is JSON on the
 *  plan row rather than a separate resource. */
function asFinanceData(data: unknown): { plan: { scheduleJson: string; currency: string } } | null {
  if (!data || typeof data !== "object" || !("plan" in data)) return null;
  const d = data as { plan: unknown };
  if (!d.plan || typeof d.plan !== "object") return null;
  const plan = d.plan as { scheduleJson?: unknown; currency?: unknown };
  if (typeof plan.scheduleJson !== "string" || typeof plan.currency !== "string") return null;
  return { plan: { scheduleJson: plan.scheduleJson, currency: plan.currency } };
}

export default function PolicyDetail() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (!loaded.policy) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("policyId")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const policy = loaded.policy;

  const repriceData = asRepriceData(result?.data);
  const repriceSection: Section | null =
    repriceData && repriceData.repriced && repriceData.premiumMinor !== undefined && repriceData.premiumDeltaPpm !== undefined
      ? (() => {
          // ponytail: the reprice response carries only the new premium and the
          // ppm delta that produced it — the previous premium below is derived
          // for display only, never read off any ledger row.
          const newMinor = repriceData.premiumMinor as number;
          const deltaPpm = repriceData.premiumDeltaPpm as number;
          const previousMinor = Math.round(newMinor / (1 + deltaPpm / 1_000_000));
          const maxMinor = Math.max(1, previousMinor, newMinor);
          return {
            kind: "bars",
            title: l("repriceCompareTitle"),
            items: [
              {
                label: l("repricePrevious"),
                value: formatMoney(previousMinor, policy.currency, locale),
                w: `${Math.max(4, Math.round((previousMinor / maxMinor) * 100))}%`,
                hue: "var(--text)",
                note: ""
              },
              {
                label: l("repriceNew"),
                value: formatMoney(newMinor, policy.currency, locale),
                w: `${Math.max(4, Math.round((newMinor / maxMinor) * 100))}%`,
                hue: hueVar("axis"),
                note: percentOf(deltaPpm, locale)
              }
            ]
          } satisfies Section;
        })()
      : repriceData
        ? {
            kind: "callout",
            title: l("repriceNoChangeTitle"),
            items: [{ code: "—", hue: hueVar("axis"), body: l("repriceNoChange") }]
          }
        : null;

  const financeData = asFinanceData(result?.data);
  const financeSchedule: ScheduleRow[] = (() => {
    if (!financeData) return [];
    try {
      return JSON.parse(financeData.plan.scheduleJson) as ScheduleRow[];
    } catch {
      return [];
    }
  })();
  const financeSection: Section | null =
    financeData && financeSchedule.length > 0
      ? {
          kind: "steps",
          title: l("financeScheduleTitle"),
          items: financeSchedule.map((row) => ({
            code: String(row.seq).padStart(2, "0"),
            dot: hueVar("axis"),
            title: formatInstant(row.dueAt, (date) =>
              new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)
            ),
            money: formatMoney(row.amountMinor, financeData.plan.currency, locale),
            note: tag(l, "instalmentState", row.state),
            hue: hueVar("axis")
          }))
        }
      : null;

  // Ascending, because the trail arrives newest-first and a flow reads forwards.
  // The trail is capped at 25 rows and is withheld without `core:audit:read`, so
  // these are the hops this actor can see — never a claim that there were no
  // others. `flowPlan` draws the current state and what is still owed either
  // way, so an agreement with no visible history is still honestly placed.
  const visits: FlowVisit[] = [...loaded.trail].reverse().flatMap((row) => {
    const state = stateOfAudit(row.action);
    return state ? [{ state, at: row.ts, actor: row.actorRef }] : [];
  });

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
      key: "incidentAt",
      header: l("colIncident"),
      render: (row) => <DateTime value={row.incidentAt} locale={locale} precision="day" />
    },
    {
      key: "amountMinor",
      header: l("colClaimAmount"),
      numeric: true,
      render: (row) => <Money amountMinor={row.amountMinor ?? 0} currency={row.currency} locale={locale} />
    },
    {
      key: "settledMinor",
      header: l("colSettled"),
      numeric: true,
      render: (row) => <Money amountMinor={row.settledMinor ?? 0} currency={row.currency} locale={locale} />
    }
  ];

  const versionColumns: Array<Column<VersionRow>> = [
    {
      key: "versionSeq",
      header: l("colVersion"),
      render: (row) => (
        <span className="font-mono text-12 text-text">{row.endorsementNo ?? `#${row.versionSeq}`}</span>
      )
    },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    {
      key: "reason",
      header: l("colReason"),
      render: (row) => <span className="font-ui text-12">{row.reason ?? tag(l, "reasonCode", row.reasonCode)}</span>
    },
    {
      key: "premiumMinor",
      header: l("premiumMinor"),
      numeric: true,
      render: (row) => <Money amountMinor={row.premiumMinor} currency={row.currency} locale={locale} />
    },
    {
      key: "premiumDeltaMinor",
      header: l("colDelta"),
      numeric: true,
      render: (row) => (
        <Money amountMinor={row.premiumDeltaMinor} currency={row.currency} locale={locale} signed toned />
      )
    },
    {
      key: "effectiveFrom",
      header: l("colEffective"),
      render: (row) => <DateTime value={row.effectiveFrom} locale={locale} precision="day" />
    }
  ];

  const entryColumns: Array<Column<EntryRow>> = [
    { key: "kind", header: l("colKind"), render: (row) => <span className="font-ui text-12">{tag(l, "kind", row.kind)}</span> },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    {
      key: "grossCommissionMinor",
      header: l("colGross"),
      numeric: true,
      render: (row) => <Money amountMinor={row.grossCommissionMinor} currency={row.currency} locale={locale} signed toned />
    },
    {
      key: "netCommissionMinor",
      header: l("colNet"),
      numeric: true,
      render: (row) => <Money amountMinor={row.netCommissionMinor} currency={row.currency} locale={locale} signed toned />
    },
    {
      key: "earnedAt",
      header: l("colEarnedAt"),
      render: (row) =>
        row.earnedAt ? <DateTime value={row.earnedAt} locale={locale} precision="day" /> : <span>—</span>
    }
  ];

  const fileColumns: Array<Column<FileRow>> = [
    { key: "kind", header: l("colDocument"), render: (row) => <span className="font-ui text-12">{tag(l, "kind", row.kind)}</span> },
    {
      key: "contentType",
      header: l("colFormat"),
      render: (row) => <span className="font-mono text-12">{row.contentType ?? "—"}</span>
    },
    {
      key: "piiLevel",
      header: l("colSensitivity"),
      render: (row) => <Badge size="sm">{tag(l, "piiLevel", row.piiLevel)}</Badge>
    },
    {
      key: "createdAt",
      header: l("colFiled"),
      render: (row) => <DateTime value={row.createdAt} locale={locale} precision="day" />
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="font-serif text-22 leading-[1.2] text-text">{`${l("policyId")} ${policy.policyNo}`}</h1>
          <p className="font-ui text-13 text-muted">{policyLede(policy, l, locale)}</p>
          <Link to="/axis/policies" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("coverTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "status", policy.status)}
          </Badge>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-6 md:grid-cols-3">
          <Stat
            label={l("premiumMinor")}
            value={<Money amountMinor={policy.premiumMinor} currency={policy.currency} locale={locale} />}
          />
          <Stat
            label={l("commission")}
            value={<Money amountMinor={policy.commissionMinor} currency={policy.currency} locale={locale} />}
          />
          <Stat
            label={l("term")}
            value={
              <span className="font-ui text-13">
                <DateTime value={policy.startAt} locale={locale} precision="day" />
                {" — "}
                <DateTime value={policy.endAt} locale={locale} precision="day" />
              </span>
            }
          />
        </div>
        <Facts>
          <Entry term={l("holder")}>
            <Link to={`/admin/customers/${policy.customerId}/360`} className="text-accent hover:underline">
              {loaded.named[policy.customerId] ?? <Ref value={policy.customerId} />}
            </Link>
          </Entry>
          <Entry term={l("provider")}>{loaded.named[policy.providerId] ?? <Ref value={policy.providerId} />}</Entry>
          <Entry term={l("product")}>
            {policy.productId ? (
              <Link to={`/admin/products/${policy.productId}/detail`} className="text-accent hover:underline">
                {loaded.named[policy.productId] ?? <Ref value={policy.productId} />}
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("offering")}>{policy.offeringId ? <Ref value={policy.offeringId} /> : "—"}</Entry>
          <Entry term={l("channel")}>
            {policy.channelId ? (
              <Link to={`/distribution/channels/${policy.channelId}/detail`} className="text-accent hover:underline">
                {loaded.named[policy.channelId] ?? <Ref value={policy.channelId} />}
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("caseRef")}>
            {policy.caseId ? (
              <Link to={`/axis/cases/${policy.caseId}/detail`} className="text-accent hover:underline">
                <Ref value={policy.caseId} />
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("escrow")}>{policy.escrowBatchId ? <Ref value={policy.escrowBatchId} /> : "—"}</Entry>
        </Facts>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title={l("docsTitle")}>
          <Payload value={policy.docsJson} />
        </Card>
        <Card title={l("paymentPlanTitle")}>
          <Payload value={policy.paymentPlanJson} />
        </Card>
      </div>

      {loaded.may.endorse || loaded.may.cancel || loaded.may.renew ? (
        <Card title={l("actionsTitle")} description={l("actionsIntro")}>
          <div className="flex flex-wrap gap-3">
            {loaded.may.endorse ? (
              <Button asChild variant="primary">
                <Link to={`/axis/policies/${policy.id}/endorse`}>{l("endorseLink")}</Link>
              </Button>
            ) : null}
            {loaded.may.cancel ? (
              <Button asChild variant="ghost">
                <Link to={`/axis/policies/${policy.id}/cancel`}>{l("cancelLink")}</Link>
              </Button>
            ) : null}
            {loaded.may.renew ? (
              <Button asChild variant="ghost">
                <Link to="/axis/renewals">{l("renewLink")}</Link>
              </Button>
            ) : null}
          </div>
        </Card>
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

      {loaded.may.endorse ? (
        <Card title={l("repriceTitle")} description={l("repriceIntro")}>
          <Form method="post" className="flex items-center gap-3">
            <input type="hidden" name="intent" value="reprice" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <Button type="submit" loading={busy}>
              {l("repriceSubmit")}
            </Button>
          </Form>
          {repriceSection ? <div className="mt-3">{renderSection(repriceSection, "axis")}</div> : null}
        </Card>
      ) : null}

      {loaded.may.financing ? (
        <Card title={l("financeTitle")} description={l("financeIntro")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="finance-plan" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeFinancier")}
              <Input name="financierRef" className="w-40" />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeTotal")}
              <MoneyField name="totalMinor" currency={policy.currency} locale={locale} required className="w-40" />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeInstalments")}
              <Input name="instalments" type="number" min={1} step={1} defaultValue={12} className="w-24" required />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeStart")}
              <Input name="startAt" type="date" required />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeFrequency")}
              <Input name="frequencyDays" type="number" min={1} step={1} defaultValue={30} className="w-24" required />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeCommission")}
              <MoneyField name="commissionMinor" currency={policy.currency} locale={locale} required className="w-40" />
            </label>
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("financeCommissionTax")}
              <MoneyField name="commissionTaxMinor" currency={policy.currency} locale={locale} className="w-40" />
            </label>
            <Button type="submit" loading={busy}>
              {l("financeSubmit")}
            </Button>
          </Form>
          {financeSection ? <div className="mt-3">{renderSection(financeSection, "axis")}</div> : null}
        </Card>
      ) : null}

      <Card title={l("flowTitle")}>
        <StateFlow
          machine={POLICY_FLOW}
          visits={visits}
          current={policy.status}
          label={l("flowLabel")}
          labelFor={(state) => tag(l, "status", state)}
          locale={locale}
        />
      </Card>

      <Card title={l("claims")} padded={false}>
        <Table
          caption={l("claimsCaption")}
          columns={claimColumns}
          rows={loaded.claims}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneClaims")} />}
        />
      </Card>

      <Card title={l("historyTitle")} padded={false}>
        <Table
          caption={l("historyCaption")}
          columns={versionColumns}
          rows={loaded.versions}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneVersions")} />}
        />
      </Card>

      <Card title={l("moneyTitle")} padded={false}>
        <Table
          caption={l("moneyCaption")}
          columns={entryColumns}
          rows={loaded.entries}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneEntries")} />}
        />
      </Card>

      <Card title={l("documentsTitle")} padded={false}>
        <Table
          caption={l("documentsCaption")}
          columns={fileColumns}
          rows={loaded.documents}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneDocuments")} />}
        />
      </Card>

      {/* The record's memory (ADR-0085), last: below everything the record
          itself shows, loaded after it, so it never pushes the record down. */}
      <MemoryPanel
        subject={policy.id}
        t={t}
        locale={locale}
        permissions={shell?.permissions ?? []}
      />
    </div>
  );
}

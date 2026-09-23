import * as React from "react";
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
  Select,
  Stat,
  StateFlow,
  Table,
  formatMoney,
  hueVar,
  renderSection,
  type Column,
  type FlowMachine,
  type FlowVisit,
  type Section
} from "@lyra/ui";
import { ApiError, api, fetchMe, names, type Problem } from "../api.server";
import { ConfirmButton } from "../components/confirm";
import { RefPicker, type RefOption } from "../components/ref-picker";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { humanise } from "../modules/spec";
import { Entry, Facts, Header, Payload, labelsFrom, rowsOf, safe, tag, type Label, type Page } from "./detail-kit";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { MemoryPanel } from "../components/memory-panel";

// One claim: what was reported, what cover answered for it, what it is reserved
// at, what has left through the ledger, and what is being chased back.
//
// Three writes, kept apart on purpose (docs/specs/gap-axis-design.md §D.3):
//   reserve         — appends a movement with a basis, never overwrites the
//                     estimate, so the desk keeps its own history
//   transition      — a declared hop from `CLAIM_TRANSITIONS`, so the screen
//                     cannot offer a move the state machine refuses
//   request-payment — money leaves through the ledger, never through a PATCH
// The last two go through the `axis.claim_settlement` gate
// (apps/api/src/resources.ts), so both surface the approval path instead of
// pretending the write landed (CLAUDE.md §4, §12).

/* --------------------------------------------------------------- contract */

export interface Claim {
  id: string;
  policyId: string;
  customerId: string;
  caseId?: string | null;
  claimNo: string;
  incidentAt?: number | null;
  reportedAt: number;
  amountMinor?: number | null;
  settledMinor?: number | null;
  currency: string;
  status: string;
  fnolJson?: unknown;
  assessorRef?: string | null;
  /** The cover snapshot taken at notification — §D.3's coverage panel. */
  policyVersionId?: string | null;
  coverageState?: string | null;
  coverageCheckedAt?: number | null;
  excessMinor?: number | null;
  reserveMinor?: number | null;
  paidMinor?: number | null;
  recoveredMinor?: number | null;
  fraudScore?: number | null;
  siuState?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ReserveRow {
  id: string;
  seq: number;
  head: string;
  amountMinor: number;
  previousMinor: number;
  basis: string;
  rationale?: string | null;
  approvalId?: string | null;
  setBy: string;
  setAt: number;
}

export interface PaymentRow {
  id: string;
  kind: string;
  payeeKind: string;
  payeeRef: string;
  amountMinor: number;
  currency: string;
  method: string;
  state: string;
  requestedAt: number;
  paidAt?: number | null;
}

export interface RecoveryRow {
  id: string;
  kind: string;
  counterpartyRef?: string | null;
  expectedMinor: number;
  recoveredMinor: number;
  currency: string;
  state: string;
  nextActionAt?: number | null;
  openedAt: number;
}

export interface PolicyRef {
  id: string;
  policyNo: string;
  status: string;
  premiumMinor: number;
  currency: string;
  startAt: number;
  endAt: number;
}

export interface DocumentRow {
  id: string;
  docType: string;
  status: string;
  extractionConfidence?: number | null;
  verifiedAt?: number | null;
  createdAt: number;
}

export interface ApprovalRow {
  id: string;
  policyKey: string;
  decision: string;
  requestedBy: string;
  requestedAt: number;
  decidedAt?: number | null;
  reason?: string | null;
}

export interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

export const PERM = {
  read: "axis:claims:read",
  update: "axis:claims:update",
  reserve: "axis:claims:reserve",
  pay: "axis:claims:pay",
  siu: "axis:siu:write",
  recover: "axis:claims:recover",
  policy: "axis:policies:read",
  documents: "axis:documents:read",
  approvals: "core:approvals:read",
  audit: "core:audit:read"
} as const;

/**
 * Mirrors packages/core/src/lifecycle.ts. The web app cannot import @lyra/core
 * (same reason approvals.tsx restates the approval states). Drift is caught by
 * the API, which refuses a hop this map would wrongly allow.
 */
export const CLAIM_TRANSITIONS: Record<string, readonly string[]> = {
  reported: ["triage", "withdrawn"],
  triage: ["assessing", "rejected", "withdrawn"],
  assessing: ["awaiting_docs", "approved", "rejected", "withdrawn"],
  awaiting_docs: ["assessing", "withdrawn"],
  approved: ["settling"],
  settling: ["settled", "approved"],
  settled: ["recovering", "closed", "reopened"],
  recovering: ["closed", "reopened"],
  rejected: ["reopened", "closed"],
  closed: ["reopened"],
  reopened: ["assessing"],
  withdrawn: []
};

/**
 * The flow the diagram draws. The spine is the path a claim takes when it is
 * paid and closed; `rejected` and `withdrawn` are how it ends instead, so they
 * are exits rather than steps a live claim is told it is pending. `flowPlan`
 * refuses a spine whose consecutive pair is not a documented edge of
 * `CLAIM_TRANSITIONS`, so this literal cannot drift away from the machine
 * above without the test failing.
 */
export const CLAIM_FLOW: FlowMachine = {
  transitions: CLAIM_TRANSITIONS,
  spine: ["reported", "triage", "assessing", "approved", "settling", "settled", "closed"],
  exits: ["rejected", "withdrawn"]
};

/**
 * A state change as the audit trail records it: engines/axis-claim-lifecycle.ts
 * writes `axis.claim.${to}`, and engines/axis-fnol.ts writes
 * `axis.claim.registered` for the `reported` state a claim is born in. Every
 * other action on the trail (a reserve, a payment, a recovery) is not a
 * transition, so it is not a step — it returns null and is dropped.
 */
export function stateOfAudit(action: string): string | null {
  if (action === "axis.claim.registered") return "reported";
  const state = action.startsWith("axis.claim.") ? action.slice("axis.claim.".length) : action;
  return state in CLAIM_TRANSITIONS ? state : null;
}

/**
 * The hops this screen may offer. `settling` and `settled` are reached by
 * requesting a payment — the API refuses them as transitions, so offering them
 * would be a dead end the desk discovers only after submitting.
 */
export function hopsFor(status: string): readonly string[] {
  return (CLAIM_TRANSITIONS[status] ?? []).filter((to) => to !== "settling" && to !== "settled");
}

/**
 * Outcomes that end the claim against the claimant. They are offered like any
 * other hop but marked as destructive and asked about before they are sent
 * (CLAUDE.md §4).
 *
 * ponytail: restated in claims-desk.tsx beside its own copy of
 * `CLAIM_TRANSITIONS`, which is duplicated there for the same reason — the web
 * app cannot import @lyra/core, and a route module importing another route
 * module drags that route's server code into the client bundle. One shared home
 * when a third screen wants it.
 */
export const ADVERSE_HOPS = ["rejected", "withdrawn", "closed"] as const;

export const isAdverseHop = (to: string): boolean => (ADVERSE_HOPS as readonly string[]).includes(to);

/**
 * What is being held for this claim, or null when nobody has priced it.
 * `amountMinor` is the claimant's notified figure and stands in until the desk
 * posts its first reserve movement; with neither, the claim is unpriced and the
 * summary has to say so rather than print a zero.
 */
export function reserveOf(claim: Pick<Claim, "reserveMinor" | "amountMinor">): number | null {
  return claim.reserveMinor ?? claim.amountMinor ?? null;
}

/** Where a reserve sits. Mirrors RESERVE_HEADS in the claims engine. */
export const RESERVE_HEADS = ["indemnity", "expense", "recovery"] as const;

/**
 * Why the reserve moved. `ai_recommended` is deliberately absent: a person
 * typing into this form is not the model, and the basis is what the audit
 * reads back (docs/15 — an AI artifact carries its own marker and its own why).
 */
export const RESERVE_BASES = ["assessor", "desk_estimate", "insurer_advised", "closure"] as const;

export const PAY_KINDS = ["indemnity", "expense", "interim", "final", "ex_gratia", "excess_refund"] as const;
export const PAYEE_KINDS = ["claimant", "repairer", "provider", "third_party", "insurer"] as const;
export const PAY_METHODS = ["eft", "cheque", "card", "insurer_direct"] as const;

/** Mirrors RecoveryOpenBody.kind in engines/axis-claims.ts. */
export const RECOVERY_KINDS = ["subrogation", "salvage", "excess", "reinsurance", "third_party"] as const;

/**
 * A payee is a namespaced ref (`customer:cu_01KE…`, `vendor:garage-1`), so the
 * box cannot become a plain picker. The one payee a desk reaches for most is
 * the claimant, and the claim already knows who that is — offer them by name
 * and leave every other payee to the typed ref.
 */
export function payeeOptions(customerId: string, holder: string | null): RefOption[] {
  return holder ? [{ id: `customer:${customerId}`, label: holder }] : [];
}

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    intro: "What was reported, what it is reserved at, the paper behind it, and who signed off.",
    back: "Back to the register",
    heroLede: "{status} · {incurred} incurred",
    fnolTitle: "First notice",
    fnolCaption: "The report as it was taken, unedited.",
    summaryTitle: "The claim",
    reserved: "Reserved",
    unpriced: "Not yet priced",
    settled: "Settled",
    reportedAt: "Reported",
    incidentAt: "Incident",
    assessor: "Assessor",
    holder: "Claimant",
    against: "Claimed against",
    caseRef: "Work item",
    reserveTitle: "Reserve",
    reserveIntro: "Say what the claim is now worth and why. Each figure is added to the history; nothing is written over.",
    reserveHead: "Head",
    reserveAmount: "Reserve after this movement",
    reserveBasis: "Basis",
    reserveRationale: "Why",
    reserveSubmit: "Add the reserve",
    reserveDone: "The reserve was added.",
    reserveRequired: "Enter the reserve as an amount of zero or more.",
    basisRequired: "Choose what the figure is based on.",
    hopTitle: "Move the claim",
    hopIntro: "Only the moves the claim can legally make are offered. Settlement is reached by requesting a payment.",
    outcome: "Move to",
    hopReason: "Note",
    hopSubmit: "Move the claim",
    hopConfirm:
      "{outcome} ends {ref} against the claimant. It is recorded against your name and the claimant is told. Continue?",
    transitionDone: "The claim was moved.",
    outcomeRequired: "Choose a move the claim can make from where it stands.",
    noHops: "This claim has nowhere left to go.",
    payTitle: "Payment",
    payIntro: "A payment leaves through the ledger and is held until it is approved. Nothing is paid from this screen.",
    payKind: "Kind",
    payPayeeKind: "Paid to",
    payPayeeRef: "Payee",
    payPayeeHint: "Name, or vendor:garage-1",
    payAmount: "Amount",
    payMethod: "Method",
    paySubmit: "Request the payment",
    paymentDone: "The payment was requested.",
    payRequired: "Name a payee and enter the amount as a whole number above zero.",
    coverageTitle: "Cover at the loss",
    coverageCaption: "The version of the contract that answered for this incident.",
    coverageStateLabel: "Cover",
    coverageVersion: "Version in force",
    coverageChecked: "Checked",
    excess: "Excess",
    fraud: "Fraud score",
    siu: "Investigation",
    incurred: "Incurred",
    paid: "Paid",
    recovered: "Recovered",
    reservesTitle: "Reserve history",
    reservesCaption: "Every movement of this claim's reserve, newest first.",
    paymentsTitle: "Payments",
    paymentsCaption: "What has left on this claim, newest first.",
    recoveriesTitle: "Recoveries",
    recoveriesCaption: "What is being chased back, newest first.",
    colSeq: "#",
    colHead: "Head",
    colBasis: "Basis",
    colMovement: "From → to",
    colPayee: "Payee",
    colExpected: "Expected",
    colRecovered: "Recovered",
    colMethod: "Method",
    fraudScoreSubmit: "Score for fraud",
    fraudScoreDone: "The claim was scored.",
    fraudScoreNone: "Not enough history to score yet.",
    fraudReasonsTitle: "Why this score",
    reserveRecSubmit: "Recommend a reserve",
    reserveRecDone: "A recommended reserve was added.",
    reserveRecNone: "No recommendation could be made.",
    reserveRecTitle: "AI-recommended reserve",
    reserveRecPrevious: "Previous reserve",
    reserveRecRecommended: "Recommended reserve",
    reserveRecConfidence: "Confidence",
    recoveriesMixTitle: "Recoveries by kind",
    recoveryOpenTitle: "Open a recovery",
    recoveryOpenIntro: "Start chasing money back on this claim.",
    recoveryKind: "Kind",
    recoveryCounterparty: "Counterparty",
    recoveryCounterpartyHint: "Name, or vendor:garage-1",
    recoveryExpected: "Expected",
    recoveryOpenSubmit: "Open the recovery",
    recoveryOpenDone: "The recovery was opened.",
    recoveryKindRequired: "Choose what is being recovered.",
    recoveryExpectedRequired: "Enter the expected amount as zero or more.",
    recoveryReceiptAmount: "Amount received",
    recoveryReceiptFee: "Fee",
    recoveryReceiptNote: "Note",
    recoveryReceiptSubmit: "Record receipt",
    recoveryReceiptDone: "The recovery was recorded as received.",
    recoveryReceiptRequired: "Name the recovery and enter the amount as a whole number above zero.",
    recoveryWriteOffReason: "Reason code",
    recoveryWriteOffNote: "Note",
    recoveryWriteOffSubmit: "Write off",
    recoveryWriteOffDone: "The recovery was written off.",
    recoveryWriteOffRequired: "Name the recovery and a reason code.",
    "status.triage": "Triage",
    "status.settling": "Settling",
    "status.recovering": "Recovering",
    "status.closed": "Closed",
    "status.reopened": "Reopened",
    "basis.assessor": "Assessor",
    "basis.desk_estimate": "Desk estimate",
    "basis.insurer_advised": "Insurer advised",
    "basis.closure": "Closure",
    "basis.ai_recommended": "Suggested",
    "basis.formula": "Formula",
    "head.indemnity": "Indemnity",
    "head.expense": "Expense",
    "head.recovery": "Recovery",
    "kind.indemnity": "Indemnity",
    "kind.expense": "Expense",
    "kind.interim": "Interim",
    "kind.final": "Final",
    "kind.ex_gratia": "Goodwill",
    "kind.excess_refund": "Excess refund",
    "kind.subrogation": "Subrogation",
    "kind.salvage": "Salvage",
    "kind.excess": "Excess",
    "kind.reinsurance": "Reinsurance",
    "kind.third_party": "Third party",
    "payee.claimant": "Claimant",
    "payee.repairer": "Repairer",
    "payee.provider": "Provider",
    "payee.third_party": "Third party",
    "payee.insurer": "Insurer",
    "method.eft": "Transfer",
    "method.cheque": "Cheque",
    "method.card": "Card",
    "method.insurer_direct": "Paid by insurer",
    "state.requested": "Requested",
    "state.failed": "Failed",
    "state.reversed": "Reversed",
    "state.identified": "Identified",
    "state.pursuing": "Being chased",
    "state.agreed": "Agreed",
    "state.recovered": "Recovered",
    "coverage.in_force": "On risk",
    "coverage.not_yet_incepted": "Not yet started",
    "coverage.lapsed_at_loss": "Lapsed at the loss",
    "coverage.cancelled_at_loss": "Cancelled at the loss",
    "coverage.out_of_cover": "Outside cover",
    "coverage.unknown": "Not checked",
    "siu.referred": "Referred",
    "siu.clearing": "Being cleared",
    "siu.substantiated": "Substantiated",
    documentsTitle: "Documents",
    documentsCaption: "Evidence filed on the work item behind this claim.",
    approvalsTitle: "Sign-off",
    approvalsCaption: "Every approval raised against this claim.",
    historyTitle: "Trail",
    historyCaption: "Every change recorded against this claim, newest first.",
    flowTitle: "Where it is",
    flowLabel: "Claim lifecycle",
    colConfidence: "Confidence",
    colVerified: "Verified",
    colPolicyKey: "Rule",
    colReason: "Note",
    colAction: "Change",
    noPolicy: "You can't see the cover this claim sits on.",
    noCase: "No work item is attached, so there is no evidence to show.",
    // Each panel is empty for its own reason, and on a claim the reason is
    // usually a step nobody has taken yet. Name the step, not the absence.
    noneReserves: "Nothing is set aside for this claim yet. Post a reserve to hold the expected cost against it.",
    nonePayments: "Nothing has been paid on this claim.",
    noneRecoveries: "Nothing is being recovered. Open a recovery when another party owes part of this loss.",
    noneApprovals: "Nothing on this claim has needed an approval so far.",
    noneHistory: "Nothing has changed on this claim since it was reported.",
    noneDocuments: "No evidence has been attached to the work item behind this claim.",
    noHopsBody: "Every move from here is either blocked or already taken — the flow below shows where it stands."
  },
  ar: {
    intro: "ما تم الإبلاغ عنه، والمبلغ المحتجز، والمستندات المرتبطة، ومن اعتمده.",
    back: "العودة إلى السجل",
    heroLede: "{status} · متكبد {incurred}",
    fnolTitle: "الإشعار الأول",
    fnolCaption: "البلاغ كما استُلم، دون تعديل.",
    summaryTitle: "المطالبة",
    reserved: "المحتجز",
    unpriced: "لم تُسعَّر بعد",
    settled: "المسدد",
    reportedAt: "تاريخ الإبلاغ",
    incidentAt: "تاريخ الحادث",
    assessor: "المُقيّم",
    holder: "المطالِب",
    against: "مقدّمة على",
    caseRef: "بند العمل",
    reserveTitle: "الاحتياطي",
    reserveIntro: "حدّد قيمة المطالبة الآن وسبب ذلك. كل رقم يُضاف إلى السجل، ولا يُستبدل أي رقم سابق.",
    reserveHead: "البند",
    reserveAmount: "الاحتياطي بعد هذه الحركة",
    reserveBasis: "الأساس",
    reserveRationale: "السبب",
    reserveSubmit: "إضافة الاحتياطي",
    reserveDone: "تمت إضافة الاحتياطي.",
    reserveRequired: "أدخل الاحتياطي كمبلغ صفر أو أكثر.",
    basisRequired: "اختر الأساس الذي بُني عليه الرقم.",
    hopTitle: "تحريك المطالبة",
    hopIntro: "تُعرض الحركات المسموح بها فقط. التسوية تتم بطلب دفعة.",
    outcome: "الانتقال إلى",
    hopReason: "ملاحظة",
    hopSubmit: "تحريك المطالبة",
    hopConfirm: "{outcome} يُنهي {ref} ضد المطالِب. يُسجَّل باسمك ويُبلَّغ المطالِب. هل تريد المتابعة؟",
    transitionDone: "تم تحريك المطالبة.",
    outcomeRequired: "اختر حركة متاحة من الوضع الحالي للمطالبة.",
    noHops: "لا توجد حركة متاحة لهذه المطالبة.",
    payTitle: "الدفع",
    payIntro: "الدفعة تخرج عبر دفتر الأستاذ وتبقى معلّقة حتى الموافقة. لا يتم الدفع من هذه الشاشة.",
    payKind: "النوع",
    payPayeeKind: "جهة الدفع",
    payPayeeRef: "المستفيد",
    payPayeeHint: "الاسم، أو vendor:garage-1",
    payAmount: "المبلغ",
    payMethod: "الوسيلة",
    paySubmit: "طلب الدفع",
    paymentDone: "تم طلب الدفع.",
    payRequired: "حدّد المستفيد وأدخل المبلغ كرقم صحيح أكبر من صفر.",
    coverageTitle: "التغطية وقت الحادث",
    coverageCaption: "نسخة العقد التي كانت سارية على هذا الحادث.",
    coverageStateLabel: "التغطية",
    coverageVersion: "النسخة السارية",
    coverageChecked: "تاريخ التحقق",
    excess: "التحمّل",
    fraud: "مؤشر الاحتيال",
    siu: "التحقيق",
    incurred: "المتكبد",
    paid: "المدفوع",
    recovered: "المسترد",
    reservesTitle: "سجل الاحتياطي",
    reservesCaption: "كل حركة على احتياطي هذه المطالبة، الأحدث أولًا.",
    paymentsTitle: "المدفوعات",
    paymentsCaption: "ما تم صرفه على هذه المطالبة، الأحدث أولًا.",
    recoveriesTitle: "الاستردادات",
    recoveriesCaption: "ما يجري استرداده، الأحدث أولًا.",
    colSeq: "التسلسل",
    colHead: "البند",
    colBasis: "الأساس",
    colMovement: "من ← إلى",
    colPayee: "المستفيد",
    colExpected: "المتوقع",
    colRecovered: "المسترد",
    colMethod: "الوسيلة",
    fraudScoreSubmit: "تقييم الاحتيال",
    fraudScoreDone: "تم تقييم المطالبة.",
    fraudScoreNone: "لا يوجد سجل كافٍ للتقييم بعد.",
    fraudReasonsTitle: "سبب هذا التقييم",
    reserveRecSubmit: "اقتراح احتياطي",
    reserveRecDone: "تمت إضافة احتياطي مقترح.",
    reserveRecNone: "تعذر تقديم اقتراح.",
    reserveRecTitle: "الاحتياطي المقترح بالذكاء الاصطناعي",
    reserveRecPrevious: "الاحتياطي السابق",
    reserveRecRecommended: "الاحتياطي المقترح",
    reserveRecConfidence: "الثقة",
    recoveriesMixTitle: "الاستردادات حسب النوع",
    recoveryOpenTitle: "فتح استرداد",
    recoveryOpenIntro: "ابدأ مطاردة الأموال على هذه المطالبة.",
    recoveryKind: "النوع",
    recoveryCounterparty: "الطرف الآخر",
    recoveryCounterpartyHint: "اسم، أو vendor:garage-1",
    recoveryExpected: "المتوقع",
    recoveryOpenSubmit: "فتح الاسترداد",
    recoveryOpenDone: "تم فتح الاسترداد.",
    recoveryKindRequired: "اختر ما الذي يجري استرداده.",
    recoveryExpectedRequired: "أدخل المبلغ المتوقع صفرًا أو أكثر.",
    recoveryReceiptAmount: "المبلغ المستلم",
    recoveryReceiptFee: "الرسوم",
    recoveryReceiptNote: "ملاحظة",
    recoveryReceiptSubmit: "تسجيل الاستلام",
    recoveryReceiptDone: "تم تسجيل استلام الاسترداد.",
    recoveryReceiptRequired: "حدد الاسترداد وأدخل المبلغ كعدد صحيح أكبر من صفر.",
    recoveryWriteOffReason: "رمز السبب",
    recoveryWriteOffNote: "ملاحظة",
    recoveryWriteOffSubmit: "شطب",
    recoveryWriteOffDone: "تم شطب الاسترداد.",
    recoveryWriteOffRequired: "حدد الاسترداد ورمز السبب.",
    "status.triage": "الفرز",
    "status.settling": "قيد التسوية",
    "status.recovering": "قيد الاسترداد",
    "status.closed": "مغلقة",
    "status.reopened": "أُعيد فتحها",
    "basis.assessor": "المُقيّم",
    "basis.desk_estimate": "تقدير المكتب",
    "basis.insurer_advised": "إفادة شركة التأمين",
    "basis.closure": "الإغلاق",
    "basis.ai_recommended": "مقترح",
    "basis.formula": "معادلة",
    "head.indemnity": "التعويض",
    "head.expense": "المصروفات",
    "head.recovery": "الاسترداد",
    "kind.indemnity": "تعويض",
    "kind.expense": "مصروف",
    "kind.interim": "دفعة مؤقتة",
    "kind.final": "دفعة نهائية",
    "kind.ex_gratia": "دفعة ودّية",
    "kind.excess_refund": "ردّ التحمّل",
    "kind.subrogation": "الحلول",
    "kind.salvage": "الخردة",
    "kind.excess": "التحمّل",
    "kind.reinsurance": "إعادة التأمين",
    "kind.third_party": "طرف ثالث",
    "payee.claimant": "المطالِب",
    "payee.repairer": "الورشة",
    "payee.provider": "مقدّم الخدمة",
    "payee.third_party": "طرف ثالث",
    "payee.insurer": "شركة التأمين",
    "method.eft": "تحويل",
    "method.cheque": "شيك",
    "method.card": "بطاقة",
    "method.insurer_direct": "دفع مباشر من شركة التأمين",
    "state.requested": "مطلوبة",
    "state.failed": "فشلت",
    "state.reversed": "عُكست",
    "state.identified": "محددة",
    "state.pursuing": "قيد المتابعة",
    "state.agreed": "متفق عليها",
    "state.recovered": "مستردة",
    "coverage.in_force": "سارية",
    "coverage.not_yet_incepted": "لم تبدأ بعد",
    "coverage.lapsed_at_loss": "منقضية وقت الحادث",
    "coverage.cancelled_at_loss": "ملغاة وقت الحادث",
    "coverage.out_of_cover": "خارج التغطية",
    "coverage.unknown": "لم يتم التحقق",
    "siu.referred": "محالة",
    "siu.clearing": "قيد التصفية",
    "siu.substantiated": "مثبتة",
    documentsTitle: "المستندات",
    documentsCaption: "الأدلة المرفقة ببند العمل الخاص بهذه المطالبة.",
    approvalsTitle: "الموافقات",
    approvalsCaption: "كل موافقة طُلبت على هذه المطالبة.",
    historyTitle: "السجل",
    historyCaption: "كل تغيير مسجّل على هذه المطالبة، الأحدث أولًا.",
    flowTitle: "موضعها الآن",
    flowLabel: "دورة حياة المطالبة",
    colConfidence: "درجة الثقة",
    colVerified: "تاريخ التوثيق",
    colPolicyKey: "القاعدة",
    colReason: "ملاحظة",
    colAction: "التغيير",
    noPolicy: "لا يمكنك الاطلاع على التغطية المرتبطة بهذه المطالبة.",
    noCase: "لا يوجد بند عمل مرتبط، لذا لا توجد أدلة لعرضها.",
    noneReserves: "لم يُخصَّص شيء لهذه المطالبة بعد. سجّل احتياطياً لحجز التكلفة المتوقعة عليها.",
    nonePayments: "لم يُدفع أي مبلغ على هذه المطالبة.",
    noneRecoveries: "لا يوجد استرداد جارٍ. افتح استرداداً عندما يتحمل طرف آخر جزءاً من هذه الخسارة.",
    noneApprovals: "لم تحتج أي خطوة في هذه المطالبة إلى موافقة حتى الآن.",
    noneHistory: "لم يتغير شيء في هذه المطالبة منذ الإبلاغ عنها.",
    noneDocuments: "لم تُرفق أي أدلة ببند العمل المرتبط بهذه المطالبة.",
    noHopsBody: "كل انتقال من هنا إما محجوب أو تم بالفعل — المسار أدناه يوضح الوضع الحالي."
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the claim number: its status and what it has cost so far —
 * reserved plus paid less recovered, the same figure the summary Stat shows.
 * No ✦ (arithmetic and formatting on the loaded record, not a model finding,
 * CLAUDE.md §11). */
export function claimLede(
  claim: Pick<Claim, "status">,
  incurredMinor: number,
  currency: string,
  l: Label,
  locale: string
): string {
  return l("heroLede", { status: tag(l, "status", claim.status), incurred: formatMoney(incurredMinor, currency, locale) });
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
    update: held.has(PERM.update),
    reserve: held.has(PERM.reserve),
    pay: held.has(PERM.pay),
    siu: held.has(PERM.siu),
    recover: held.has(PERM.recover)
  };

  const empty = {
    claim: null as Claim | null,
    policy: null as PolicyRef | null,
    documents: [] as DocumentRow[],
    approvals: [] as ApprovalRow[],
    trail: [] as AuditRow[],
    reserves: [] as ReserveRow[],
    payments: [] as PaymentRow[],
    recoveries: [] as RecoveryRow[],
    may,
    holder: null as string | null,
    idempotencyKey: crypto.randomUUID()
  };

  if (!may.read) return empty;
  const claim = await safe(() => api<Claim>(`/v1/axis/claims/${id}`, options), null);
  if (!claim) return empty;

  // Evidence hangs off the work item, not the claim, so that read needs the
  // claim first. The rest of the fan-out is independent.
  const [policy, documents, approvals, trail, reserves, payments, recoveries, named] = await Promise.all([
    held.has(PERM.policy) ? safe(() => api<PolicyRef>(`/v1/axis/policies/${claim.policyId}`, options), null) : null,
    held.has(PERM.documents) && claim.caseId
      ? safe(
          () => api<Page<DocumentRow>>(`/v1/axis/documents?caseId=${encodeURIComponent(claim.caseId!)}&limit=50`, options),
          null
        )
      : null,
    held.has(PERM.approvals)
      ? safe(
          () =>
            api<Page<ApprovalRow>>(
              `/v1/core/approvals?subjectRef=${encodeURIComponent(`claims:${id}`)}&limit=25`,
              options
            ),
          null
        )
      : null,
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
    // The claim's own money. Each panel degrades on its own so a desk that may
    // see the claim but not its payments still gets the claim.
    safe(() => api<Page<ReserveRow>>(`/v1/axis/claims/${id}/reserves?limit=25`, options), null),
    safe(() => api<Page<PaymentRow>>(`/v1/axis/claims/${id}/payments`, options), null),
    safe(() => api<Page<RecoveryRow>>(`/v1/axis/claims/${id}/recoveries`, options), null),
    names([claim.customerId], options).catch(() => ({}) as Record<string, string>)
  ]);

  return {
    ...empty,
    claim,
    policy,
    documents: rowsOf(documents),
    approvals: rowsOf(approvals),
    trail: rowsOf(trail),
    reserves: rowsOf(reserves),
    payments: rowsOf(payments),
    recoveries: rowsOf(recoveries),
    holder: named[claim.customerId] ?? null
  };
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

  if (intent === "reserve") {
    const head = text("head") || "indemnity";
    const raw = text("amountMinor");
    const amountMinor = Number(raw);
    if (!(RESERVE_HEADS as readonly string[]).includes(head)) return { ...nothing, error: "reserveRequired" };
    if (raw === "" || !Number.isInteger(amountMinor) || amountMinor < 0) {
      return { ...nothing, error: "reserveRequired" };
    }
    const basis = text("basis");
    if (!(RESERVE_BASES as readonly string[]).includes(basis)) return { ...nothing, error: "basisRequired" };
    const rationale = text("rationale");
    path = `/v1/axis/claims/${id}/reserves`;
    body = { head, amountMinor, basis, ...(rationale ? { rationale } : {}) };
    // Two reserves in one page load are a normal afternoon, so the key carries
    // what it would write. A per-intent suffix alone would replay the first.
    suffix = `reserve:${head}:${amountMinor}`;
    done = "reserveDone";
  } else if (intent === "transition") {
    const to = text("to");
    if (!hopsFor(text("from")).includes(to)) return { ...nothing, error: "outcomeRequired" };
    const reason = text("reason");
    path = `/v1/axis/claims/${id}/transition`;
    body = { to, ...(reason ? { reason } : {}) };
    suffix = `transition:${to}`;
    done = "transitionDone";
  } else if (intent === "request-payment") {
    const raw = text("amountMinor");
    const amountMinor = Number(raw);
    const payeeRef = text("payeeRef");
    const payeeKind = text("payeeKind");
    if (raw === "" || !Number.isInteger(amountMinor) || amountMinor <= 0 || !payeeRef) {
      return { ...nothing, error: "payRequired" };
    }
    if (!(PAYEE_KINDS as readonly string[]).includes(payeeKind)) return { ...nothing, error: "payRequired" };
    const kind = text("kind") || "indemnity";
    const method = text("method") || "eft";
    path = `/v1/axis/claims/${id}/payments`;
    body = { kind, payeeKind, payeeRef, amountMinor, method };
    suffix = `payment:${amountMinor}`;
    done = "paymentDone";
  } else if (intent === "fraud-score") {
    path = `/v1/axis/claims/${id}/fraud-score`;
    body = {};
    suffix = "fraud-score";
    done = "fraudScoreDone";
  } else if (intent === "reserve-recommendation") {
    path = `/v1/axis/claims/${id}/reserve-recommendation`;
    body = {};
    suffix = "reserve-recommendation";
    done = "reserveRecDone";
  } else if (intent === "recovery-open") {
    const kind = text("kind");
    if (!(RECOVERY_KINDS as readonly string[]).includes(kind)) return { ...nothing, error: "recoveryKindRequired" };
    const counterpartyRef = text("counterpartyRef");
    const rawExpected = text("expectedMinor");
    const expectedMinor = rawExpected === "" ? 0 : Number(rawExpected);
    if (!Number.isInteger(expectedMinor) || expectedMinor < 0) return { ...nothing, error: "recoveryExpectedRequired" };
    path = `/v1/axis/claims/${id}/recoveries`;
    body = { kind, ...(counterpartyRef ? { counterpartyRef } : {}), expectedMinor };
    suffix = `recovery-open:${kind}`;
    done = "recoveryOpenDone";
  } else if (intent === "recovery-receipt") {
    const recoveryId = text("recoveryId");
    const raw = text("amountMinor");
    const amountMinor = Number(raw);
    if (!recoveryId || raw === "" || !Number.isInteger(amountMinor) || amountMinor <= 0) {
      return { ...nothing, error: "recoveryReceiptRequired" };
    }
    const rawFee = text("feeMinor");
    const feeMinor = rawFee === "" ? 0 : Number(rawFee);
    if (!Number.isInteger(feeMinor) || feeMinor < 0) return { ...nothing, error: "recoveryReceiptRequired" };
    const note = text("note");
    path = `/v1/axis/recoveries/${recoveryId}/receipt`;
    body = { amountMinor, feeMinor, ...(note ? { note } : {}) };
    suffix = `recovery-receipt:${recoveryId}:${amountMinor}`;
    done = "recoveryReceiptDone";
  } else if (intent === "recovery-writeoff") {
    const recoveryId = text("recoveryId");
    const reasonCode = text("reasonCode");
    if (!recoveryId || !reasonCode) return { ...nothing, error: "recoveryWriteOffRequired" };
    const note = text("note");
    path = `/v1/axis/recoveries/${recoveryId}/writeoff`;
    body = { reasonCode, ...(note ? { note } : {}) };
    suffix = `recovery-writeoff:${recoveryId}`;
    done = "recoveryWriteOffDone";
  } else {
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  }

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    // A hop and a payment are gated by `axis.claim_settlement`, and a large
    // reserve by `axis.claim_reserve`; a 403 with `approval_required` is the
    // normal answer here, not an error to hide.
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

/**
 * The hop form. The outcome is state rather than an uncontrolled `defaultValue`
 * because the button beside it has to know whether the hop being sent ends the
 * claim against the claimant, and swap itself for one that asks first.
 */
function HopForm({
  claim,
  hops,
  idempotencyKey,
  l,
  busy
}: {
  claim: Pick<Claim, "status" | "claimNo">;
  hops: readonly string[];
  idempotencyKey: string;
  l: Label;
  busy: boolean;
}) {
  const [to, setTo] = React.useState(hops[0] ?? "");
  const outcome = tag(l, "status", to);

  return (
    <Form method="post" className="flex flex-wrap items-end gap-4">
      <input type="hidden" name="intent" value="transition" />
      <input type="hidden" name="from" value={claim.status} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("outcome")}
        <Select
          name="to"
          value={to}
          onValueChange={setTo}
          options={hops.map((value) => ({ value, label: tag(l, "status", value) }))}
        />
      </label>
      <label className="flex flex-col gap-1 font-ui text-12 text-muted">
        {l("hopReason")}
        <Input name="reason" className="w-56" />
      </label>
      {isAdverseHop(to) ? (
        <ConfirmButton
          type="submit"
          variant="danger"
          loading={busy}
          message={l("hopConfirm", { outcome, ref: claim.claimNo })}
        >
          {l("hopSubmit")}
        </ConfirmButton>
      ) : (
        <Button type="submit" loading={busy}>
          {l("hopSubmit")}
        </Button>
      )}
    </Form>
  );
}

export default function ClaimDetail() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (!loaded.claim) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("claimNo")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const claim = loaded.claim;

  const documentColumns: Array<Column<DocumentRow>> = [
    {
      key: "docType",
      header: l("colDocument"),
      render: (row) => <span className="font-ui text-12">{tag(l, "docType", row.docType)}</span>
    },
    { key: "status", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "status", row.status)}</Badge> },
    {
      key: "extractionConfidence",
      header: l("colConfidence"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{row.extractionConfidence ?? "—"}</span>
    },
    {
      key: "verifiedAt",
      header: l("colVerified"),
      render: (row) => (row.verifiedAt ? <DateTime value={row.verifiedAt} locale={locale} precision="day" /> : <span>—</span>)
    }
  ];

  const approvalColumns: Array<Column<ApprovalRow>> = [
    { key: "policyKey", header: l("colPolicyKey"), render: (row) => humanise(row.policyKey) },
    {
      key: "decision",
      header: l("colOutcome"),
      render: (row) => <Badge size="sm">{tag(l, "decision", row.decision)}</Badge>
    },
    { key: "requestedBy", header: l("colWho"), render: (row) => <Ref value={row.requestedBy} className="text-12" /> },
    {
      key: "requestedAt",
      header: l("colWhen"),
      render: (row) => <DateTime value={row.requestedAt} locale={locale} precision="minute" />
    },
    { key: "reason", header: l("colReason"), render: (row) => <span className="font-ui text-12">{row.reason ?? "—"}</span> }
  ];

  const money = (amountMinor: number) => (
    <Money amountMinor={amountMinor} currency={claim.currency} locale={locale} />
  );

  // What the claim has cost so far: what is still held for it, plus what has
  // left, less what has come back. An unpriced claim has incurred whatever has
  // actually moved — but its reserve is not a zero, it is unknown (`reserveOf`).
  const reserveMinor = reserveOf(claim);
  const paidMinor = claim.paidMinor ?? 0;
  const recoveredMinor = claim.recoveredMinor ?? 0;
  const incurredMinor = (reserveMinor ?? 0) + paidMinor - recoveredMinor;

  const hops = hopsFor(claim.status);

  const reserveColumns: Array<Column<ReserveRow>> = [
    { key: "seq", header: l("colSeq"), numeric: true, render: (row) => <span className="font-mono text-12">{row.seq}</span> },
    { key: "setAt", header: l("colWhen"), render: (row) => <DateTime value={row.setAt} locale={locale} precision="minute" /> },
    { key: "head", header: l("colHead"), render: (row) => tag(l, "head", row.head) },
    {
      key: "amountMinor",
      header: l("colMovement"),
      numeric: true,
      render: (row) => (
        <span className="font-mono text-12">
          {money(row.previousMinor)} → {money(row.amountMinor)}
        </span>
      )
    },
    { key: "basis", header: l("colBasis"), render: (row) => <Badge size="sm">{tag(l, "basis", row.basis)}</Badge> },
    { key: "rationale", header: l("colReason"), render: (row) => <span className="font-ui text-12">{row.rationale ?? "—"}</span> },
    { key: "setBy", header: l("colWho"), render: (row) => <Ref value={row.setBy} className="text-12" /> }
  ];

  const paymentColumns: Array<Column<PaymentRow>> = [
    { key: "requestedAt", header: l("colWhen"), render: (row) => <DateTime value={row.requestedAt} locale={locale} precision="minute" /> },
    { key: "kind", header: l("colKind"), render: (row) => tag(l, "kind", row.kind) },
    {
      key: "payeeRef",
      header: l("colPayee"),
      render: (row) => (
        <span className="font-ui text-12">
          {tag(l, "payee", row.payeeKind)} · <Ref value={row.payeeRef} className="text-12" />
        </span>
      )
    },
    { key: "amountMinor", header: l("colAmount"), numeric: true, render: (row) => money(row.amountMinor) },
    { key: "method", header: l("colMethod"), render: (row) => tag(l, "method", row.method) },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm" dot>{tag(l, "state", row.state)}</Badge> }
  ];

  const recoveryColumns: Array<Column<RecoveryRow>> = [
    { key: "openedAt", header: l("colWhen"), render: (row) => <DateTime value={row.openedAt} locale={locale} precision="day" /> },
    { key: "kind", header: l("colKind"), render: (row) => tag(l, "kind", row.kind) },
    {
      key: "counterpartyRef",
      header: l("colPayee"),
      render: (row) => (row.counterpartyRef ? <Ref value={row.counterpartyRef} className="text-12" /> : <span>—</span>)
    },
    { key: "expectedMinor", header: l("colExpected"), numeric: true, render: (row) => money(row.expectedMinor) },
    { key: "recoveredMinor", header: l("colRecovered"), numeric: true, render: (row) => money(row.recoveredMinor) },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm" dot>{tag(l, "state", row.state)}</Badge> }
  ];

  if (loaded.may.recover) {
    recoveryColumns.push({
      key: "actions",
      header: l("recoveryReceiptSubmit"),
      render: (row) => (
        <div className="flex flex-col gap-2">
          <Form method="post" className="flex items-center gap-1">
            <input type="hidden" name="intent" value="recovery-receipt" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <input type="hidden" name="recoveryId" value={row.id} />
            <MoneyField name="amountMinor" currency={row.currency} locale={locale} required className="w-28" />
            <Button type="submit" size="sm" loading={busy}>
              {l("recoveryReceiptSubmit")}
            </Button>
          </Form>
          <Form method="post" className="flex items-center gap-1">
            <input type="hidden" name="intent" value="recovery-writeoff" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <input type="hidden" name="recoveryId" value={row.id} />
            <Input name="reasonCode" placeholder={l("recoveryWriteOffReason")} className="w-28" />
            <ConfirmButton
              type="submit"
              variant="danger"
              size="sm"
              loading={busy}
              message={l("recoveryWriteOffSubmit")}
            >
              {l("recoveryWriteOffSubmit")}
            </ConfirmButton>
          </Form>
        </div>
      )
    });
  }

  function asFraudScoreData(data: unknown): { score: number; referral: { reasonsJson: string; state: string } | null } | null {
    if (!data || typeof data !== "object" || !("score" in data)) return null;
    const d = data as { score: unknown; referral: unknown };
    if (typeof d.score !== "number") return null;
    const referral =
      d.referral && typeof d.referral === "object" && "reasonsJson" in d.referral && "state" in d.referral
        ? (d.referral as { reasonsJson: string; state: string })
        : null;
    return { score: d.score, referral };
  }

  function asReserveRecData(
    data: unknown
  ): { amountMinor: number; head: string; basis: string; rationale: string | null } | null {
    if (!data || typeof data !== "object" || !("amountMinor" in data) || !("head" in data)) return null;
    const d = data as { amountMinor: unknown; head: unknown; basis: unknown; rationale: unknown };
    if (typeof d.amountMinor !== "number" || typeof d.head !== "string" || typeof d.basis !== "string") return null;
    return { amountMinor: d.amountMinor, head: d.head, basis: d.basis, rationale: typeof d.rationale === "string" ? d.rationale : null };
  }

  const fraudData = asFraudScoreData(result?.data);
  const reserveRecData = asReserveRecData(result?.data);

  const fraudReasons: string[] = (() => {
    if (!fraudData?.referral) return [];
    try {
      const parsed = JSON.parse(fraudData.referral.reasonsJson) as Array<{ indicator?: string; weight?: number }>;
      return parsed.map((r) => `${r.indicator ?? "?"} (${r.weight ?? 0})`);
    } catch {
      return [];
    }
  })();

  const fraudSection: Section | null = fraudData
    ? {
        kind: "callout",
        title: l("fraudReasonsTitle"),
        items:
          fraudReasons.length > 0
            ? fraudReasons.map((reason, i) => ({ code: String(i + 1).padStart(2, "0"), hue: hueVar("axis"), body: reason }))
            : [{ code: String(fraudData.score), hue: hueVar("axis"), body: l("fraudScoreNone") }]
      }
    : null;

  const reserveRecSection: Section | null = reserveRecData
    ? {
        kind: "kv",
        title: l("reserveRecTitle"),
        items: [
          { label: l("reserveHead"), value: tag(l, "head", reserveRecData.head), hue: hueVar("axis"), font: "" },
          {
            label: l("reserveRecRecommended"),
            value: formatMoney(reserveRecData.amountMinor, claim.currency, locale),
            hue: hueVar("axis"),
            font: ""
          },
          { label: l("reserveBasis"), value: tag(l, "basis", reserveRecData.basis), hue: "var(--text)", font: "" },
          ...(reserveRecData.rationale
            ? [{ label: l("reserveRationale"), value: reserveRecData.rationale, hue: "var(--text)", font: "" }]
            : [])
        ]
      }
    : null;

  const recoveriesBarsSection: Section = (() => {
    const byKind = new Map<string, { count: number; total: number }>();
    for (const row of loaded.recoveries) {
      const cur = byKind.get(row.kind) ?? { count: 0, total: 0 };
      cur.count += 1;
      cur.total += row.recoveredMinor;
      byKind.set(row.kind, cur);
    }
    const entries = [...byKind.entries()];
    const maxTotal = Math.max(1, ...entries.map(([, v]) => v.total));
    return {
      kind: "bars",
      title: l("recoveriesMixTitle"),
      items: entries.map(([kind, v]) => ({
        label: tag(l, "kind", kind),
        value: formatMoney(v.total, claim.currency, locale),
        w: `${Math.max(4, Math.round((v.total / maxTotal) * 100))}%`,
        hue: hueVar("axis"),
        note: `${v.count} case${v.count === 1 ? "" : "s"}`
      }))
    };
  })();

  // Ascending, because the trail arrives newest-first and a flow reads forwards.
  // The trail is capped at 25 rows and is withheld without `core:audit:read`, so
  // these are the transitions this actor can see — never a claim that there were
  // no others. `flowPlan` draws the current state and what is still owed either
  // way, so a claim with no visible history is still honestly placed.
  const visits: FlowVisit[] = [...loaded.trail].reverse().flatMap((row) => {
    const state = stateOfAudit(row.action);
    return state ? [{ state, at: row.ts, actor: row.actorRef }] : [];
  });

  const trailColumns: Array<Column<AuditRow>> = [
    { key: "action", header: l("colAction"), render: (row) => humanise(row.action) },
    { key: "actorRef", header: l("colWho"), render: (row) => <Ref value={row.actorRef} className="text-12" /> },
    { key: "ts", header: l("colWhen"), render: (row) => <DateTime value={row.ts} locale={locale} precision="minute" /> }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{`${l("claimNo")} ${claim.claimNo}`}</h1>
          <p className="font-ui text-13 text-muted">{claimLede(claim, incurredMinor, claim.currency, l, locale)}</p>
          <Link to="/axis/claims" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("summaryTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "status", claim.status)}
          </Badge>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-6 md:grid-cols-4">
          <Stat label={l("incurred")} value={money(incurredMinor)} />
          <Stat label={l("reserved")} value={reserveMinor === null ? l("unpriced") : money(reserveMinor)} />
          <Stat label={l("paid")} value={money(paidMinor)} />
          <Stat label={l("recovered")} value={money(recoveredMinor)} />
          <Stat label={l("reportedAt")} value={<DateTime value={claim.reportedAt} locale={locale} precision="day" />} />
        </div>
        <Facts>
          <Entry term={l("incidentAt")}>
            {claim.incidentAt ? <DateTime value={claim.incidentAt} locale={locale} precision="day" /> : "—"}
          </Entry>
          <Entry term={l("holder")}>
            <Link to={`/admin/customers/${claim.customerId}/360`} className="text-accent hover:underline">
              {loaded.holder ?? <Ref value={claim.customerId} />}
            </Link>
          </Entry>
          <Entry term={l("against")}>
            {loaded.policy ? (
              <Link to={`/axis/policies/${claim.policyId}/detail`} className="text-accent hover:underline">
                {loaded.policy.policyNo}
              </Link>
            ) : (
              l("noPolicy")
            )}
          </Entry>
          <Entry term={l("caseRef")}>
            {claim.caseId ? (
              <Link to={`/axis/cases/${claim.caseId}/detail`} className="text-accent hover:underline">
                <Ref value={claim.caseId} />
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("assessor")}>{claim.assessorRef ?? "—"}</Entry>
        </Facts>
      </Card>

      <Card title={l("fnolTitle")} description={l("fnolCaption")}>
        <Payload value={claim.fnolJson} />
      </Card>

      <Card title={l("coverageTitle")} description={l("coverageCaption")}>
        <Facts>
          <Entry term={l("coverageStateLabel")}>
            <Badge size="sm" dot>
              {tag(l, "coverage", claim.coverageState ?? "unknown")}
            </Badge>
          </Entry>
          <Entry term={l("coverageVersion")}>
            {claim.policyVersionId ? (
              <Link to={`/axis/policies/${claim.policyId}/detail`} className="text-accent hover:underline">
                <Ref value={claim.policyVersionId} className="text-12" />
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("coverageChecked")}>
            {claim.coverageCheckedAt ? (
              <DateTime value={claim.coverageCheckedAt} locale={locale} precision="minute" />
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("excess")}>{claim.excessMinor == null ? "—" : money(claim.excessMinor)}</Entry>
          <Entry term={l("fraud")}>
            <span className="font-mono text-12">{claim.fraudScore ?? "—"}</span>
          </Entry>
          <Entry term={l("siu")}>{claim.siuState ? tag(l, "siu", claim.siuState) : "—"}</Entry>
        </Facts>
        {loaded.may.siu ? (
          <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
            <Form method="post" className="flex items-center gap-3">
              <input type="hidden" name="intent" value="fraud-score" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <Button type="submit" loading={busy}>
                {l("fraudScoreSubmit")}
              </Button>
            </Form>
            {fraudSection ? <div>{renderSection(fraudSection, "axis")}</div> : null}
          </div>
        ) : null}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {loaded.may.reserve ? (
          <Card title={l("reserveTitle")} description={l("reserveIntro")}>
            <Form method="post" className="flex flex-wrap items-end gap-4">
              <input type="hidden" name="intent" value="reserve" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("reserveHead")}
                <Select
                  name="head"
                  defaultValue="indemnity"
                  options={RESERVE_HEADS.map((value) => ({ value, label: tag(l, "head", value) }))}
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("reserveAmount")}
                <MoneyField name="amountMinor" currency={claim.currency} locale={locale} required className="w-40" />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("reserveBasis")}
                <Select
                  name="basis"
                  defaultValue="desk_estimate"
                  options={RESERVE_BASES.map((value) => ({ value, label: tag(l, "basis", value) }))}
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("reserveRationale")}
                <Input name="rationale" className="w-56" />
              </label>
              <Button type="submit" loading={busy}>
                {l("reserveSubmit")}
              </Button>
            </Form>
            <Form method="post" className="mt-3 flex items-center gap-3 border-t border-border pt-3">
              <input type="hidden" name="intent" value="reserve-recommendation" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <Button type="submit" variant="secondary" loading={busy}>
                {l("reserveRecSubmit")}
              </Button>
            </Form>
            {reserveRecSection ? <div className="mt-3">{renderSection(reserveRecSection, "axis")}</div> : null}
          </Card>
        ) : null}

        {loaded.may.update ? (
          <Card title={l("hopTitle")} description={l("hopIntro")}>
            {hops.length === 0 ? (
              <EmptyState title={l("noHops")} body={l("noHopsBody")} />
            ) : (
              <HopForm claim={claim} hops={hops} idempotencyKey={loaded.idempotencyKey} l={l} busy={busy} />
            )}
          </Card>
        ) : null}

        {loaded.may.pay ? (
          <Card title={l("payTitle")} description={l("payIntro")}>
            <Form method="post" className="flex flex-wrap items-end gap-4">
              <input type="hidden" name="intent" value="request-payment" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("payKind")}
                <Select
                  name="kind"
                  defaultValue="indemnity"
                  options={PAY_KINDS.map((value) => ({ value, label: tag(l, "kind", value) }))}
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("payPayeeKind")}
                <Select
                  name="payeeKind"
                  defaultValue="claimant"
                  options={PAYEE_KINDS.map((value) => ({ value, label: tag(l, "payee", value) }))}
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("payPayeeRef")}
                <RefPicker
                  name="payeeRef"
                  options={payeeOptions(claim.customerId, loaded.holder)}
                  placeholder={l("payPayeeHint")}
                  required
                  className="w-56"
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("payAmount")}
                <MoneyField name="amountMinor" currency={claim.currency} locale={locale} required className="w-40" />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("payMethod")}
                <Select
                  name="method"
                  defaultValue="eft"
                  options={PAY_METHODS.map((value) => ({ value, label: tag(l, "method", value) }))}
                />
              </label>
              <Button type="submit" variant="primary" loading={busy}>
                {l("paySubmit")}
              </Button>
            </Form>
          </Card>
        ) : null}
      </div>

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {/* The failure was announced and the success was not: a reserve that saved
          said so only in colour, which a screen reader never reaches. */}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(result.done)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <Card title={l("reservesTitle")} padded={false}>
        <Table
          caption={l("reservesCaption")}
          columns={reserveColumns}
          rows={loaded.reserves}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneReserves")} />}
        />
      </Card>

      <Card title={l("paymentsTitle")} padded={false}>
        <Table
          caption={l("paymentsCaption")}
          columns={paymentColumns}
          rows={loaded.payments}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("nonePayments")} />}
        />
      </Card>

      <Card title={l("recoveriesTitle")} padded={false}>
        {loaded.recoveries.length > 0 ? (
          <div className="px-6 pt-6">{renderSection(recoveriesBarsSection, "axis")}</div>
        ) : null}
        <Table
          caption={l("recoveriesCaption")}
          columns={recoveryColumns}
          rows={loaded.recoveries}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneRecoveries")} />}
        />
        {loaded.may.recover ? (
          <div className="border-t border-border px-6 py-4">
            <p className="eyebrow mb-3">{l("recoveryOpenTitle")}</p>
            <Form method="post" className="flex flex-wrap items-end gap-4">
              <input type="hidden" name="intent" value="recovery-open" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("recoveryKind")}
                <Select
                  name="kind"
                  defaultValue={RECOVERY_KINDS[0]}
                  options={RECOVERY_KINDS.map((value) => ({ value, label: tag(l, "kind", value) }))}
                />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("recoveryCounterparty")}
                <Input name="counterpartyRef" placeholder={l("recoveryCounterpartyHint")} className="w-56" />
              </label>
              <label className="flex flex-col gap-1 font-ui text-12 text-muted">
                {l("recoveryExpected")}
                <MoneyField name="expectedMinor" currency={claim.currency} locale={locale} className="w-40" />
              </label>
              <Button type="submit" loading={busy}>
                {l("recoveryOpenSubmit")}
              </Button>
            </Form>
          </div>
        ) : null}
      </Card>

      <Card title={l("documentsTitle")} padded={false}>
        <Table
          caption={l("documentsCaption")}
          columns={documentColumns}
          rows={loaded.documents}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={claim.caseId ? l("noneDocuments") : l("noCase")} />}
        />
      </Card>

      <Card title={l("approvalsTitle")} padded={false}>
        <Table
          caption={l("approvalsCaption")}
          columns={approvalColumns}
          rows={loaded.approvals}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneApprovals")} />}
        />
      </Card>

      <Card title={l("flowTitle")}>
        <StateFlow
          machine={CLAIM_FLOW}
          visits={visits}
          current={claim.status}
          label={l("flowLabel")}
          labelFor={(state) => tag(l, "status", state)}
          locale={locale}
        />
      </Card>

      <Card title={l("historyTitle")} padded={false}>
        <Table
          caption={l("historyCaption")}
          columns={trailColumns}
          rows={loaded.trail}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneHistory")} />}
        />
      </Card>

      {/* The record's memory (ADR-0089), last: below everything the record
          itself shows, loaded after it, so it never pushes the record down. */}
      <MemoryPanel
        subject={claim.id}
        t={t}
        locale={locale}
        permissions={shell?.permissions ?? []}
      />
    </div>
  );
}

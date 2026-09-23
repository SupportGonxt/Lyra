import { useState } from "react";
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
  AgentBadge,
  Badge,
  Button,
  Card,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  Field,
  GhostText,
  Money,
  Ref,
  Select,
  Skeleton,
  Stat,
  StateFlow,
  Table,
  Textarea,
  formatInstant,
  type Column,
  type FlowMachine,
  type FlowVisit
} from "@lyra/ui";
import { ApiError, api, fetchMe, names, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { humanise } from "../modules/spec";
import { Entry, Facts, Header, Payload, labelsFrom, rowsOf, safe, tag, type Label, type Page } from "./detail-kit";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";

// One AXIS work item: where it stands, the steps that got it there, what is
// waiting on sign-off, and the two transitions the API actually owns — move the
// case on (`PATCH /v1/axis/cases/:id`) and verify a document
// (`POST /v1/axis/documents/:id/verify`). Nothing here invents a transition.

/* --------------------------------------------------------------- contract */

export interface Case {
  id: string;
  ref: string;
  kind: string;
  customerId?: string | null;
  productLine?: string | null;
  channelId?: string | null;
  quoteRequestId?: string | null;
  status: string;
  slaDueAt?: number | null;
  ownerRef?: string | null;
  teamId?: string | null;
  priority: string;
  source: string;
  riskScore?: number | null;
  valueMinor?: number | null;
  currency?: string | null;
  metaJson?: unknown;
  closedAt?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface EventRow {
  id: string;
  step: string;
  actorRef: string;
  durationMs?: number | null;
  outcome?: string | null;
  ts: number;
}

export interface DocumentRow {
  id: string;
  docType: string;
  status: string;
  extractionConfidence?: number | null;
  verifiedAt?: number | null;
  createdAt: number;
}

export interface CaseApprovalRow {
  id: string;
  subjectRef: string;
  policyKey: string;
  decision: string;
  ts: number;
}

export interface TaskRow {
  id: string;
  type: string;
  titleKey: string;
  assigneeRef?: string | null;
  state: string;
  dueAt?: number | null;
}

/** One line of the tenant's audit trail, as /v1/core/audit-log returns it. */
export interface AuditRow {
  id: string;
  action: string;
  actorRef: string;
  ts: number;
}

export const PERM = {
  read: "axis:cases:read",
  update: "axis:cases:update",
  documents: "axis:documents:read",
  verify: "axis:documents:verify",
  approvals: "axis:cases:approve",
  events: "axis:metrics:read",
  tasks: "axis:tasks:read",
  export: "compliance:evidence:export",
  download: "compliance:evidence:read",
  copilot: "axis:cases:read",
  audit: "core:audit:read"
} as const;

/** The case state machine as apps/db declares it (axis_cases.status). */
export const STATES = [
  "intake",
  "quoting",
  "awaiting_docs",
  "review",
  "approval",
  "issued",
  "failed",
  "cancelled"
] as const;

/**
 * Mirrors CASE_TRANSITIONS in packages/core/src/lifecycle.ts. The web app cannot
 * import @lyra/core (same reason claim-detail.tsx restates the claim machine),
 * and the API refuses a hop this map would wrongly allow, so drift is caught
 * where it matters rather than shipped as a wrong diagram.
 */
export const CASE_TRANSITIONS: Record<string, readonly string[]> = {
  intake: ["quoting", "cancelled"],
  quoting: ["awaiting_docs", "review", "cancelled"],
  awaiting_docs: ["quoting", "review", "cancelled"],
  review: ["approval", "awaiting_docs", "failed", "cancelled"],
  approval: ["issued", "review", "failed", "cancelled"],
  issued: [],
  failed: ["intake"],
  cancelled: []
};

/**
 * The flow the diagram draws. The spine is the path a work item takes when it
 * is quoted, reviewed, signed off and issued; `failed` and `cancelled` are how
 * it ends instead, so they are exits rather than steps a live case is told it
 * is pending. `awaiting_docs` is a real state but a detour off the spine, so it
 * appears when the case is in it and not before. `flowPlan` refuses a spine
 * whose consecutive pair is not a documented edge of `CASE_TRANSITIONS`, so
 * this literal cannot drift away from the machine above without a test failing.
 */
export const CASE_FLOW: FlowMachine = {
  transitions: CASE_TRANSITIONS,
  spine: ["intake", "quoting", "review", "approval", "issued"],
  exits: ["failed", "cancelled"]
};

/**
 * A state change as the audit trail records it: engines/axis-case-lifecycle.ts
 * writes `axis.case.${to}` on every hop it allows. Nothing else on the trail is
 * a transition — a document verify, a copilot answer, the `axis.cases.create`
 * the generic resource writes (whose status is whatever the caller posted, not
 * necessarily `intake`) — so those return null and are dropped rather than
 * guessed at.
 */
export function stateOfAudit(action: string): string | null {
  const prefix = "axis.case.";
  if (!action.startsWith(prefix)) return null;
  const state = action.slice(prefix.length);
  return state in CASE_TRANSITIONS ? state : null;
}

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    noneEvents: "Nothing has happened on this work item since it was opened.",
    noneDocuments: "No files are attached. Evidence uploaded against this item appears here.",
    noneApprovals: "No step on this item has needed a decision so far.",
    noneTasks: "No task is outstanding. Tasks appear here when a step needs someone to act.",
    intro: "Where this work item stands, the steps behind it, and what is still waiting on someone.",
    back: "Back to the queue",
    heroLede: "{status} · {priority} priority",
    heroLedeDue: "{status} · {priority} priority · due {due}",
    standingTitle: "Where it stands",
    value: "Value",
    sla: "Due",
    risk: "Risk score",
    owner: "Owner",
    team: "Team",
    priority: "Priority",
    source: "Came from",
    kind: "Kind",
    productLine: "Product line",
    holder: "Customer",
    channel: "Channel",
    quoteRequest: "Shopping request",
    closedAt: "Closed",
    metaTitle: "Case data",
    exportTitle: "Audit export",
    exportIntro: "Build a regulator-ready evidence bundle of everything recorded on this work item.",
    exportSubmit: "Build the bundle",
    exported: "The bundle is ready.",
    copilotTitle: "Ask the case copilot",
    copilotPlaceholder: "Ask a question about this case…",
    copilotSubmit: "Ask",
    copilotEmpty: "Ask a question and the answer will appear here, grounded in this case's own facts.",
    copilotThinking: "Reading this case…",
    copilotWhyGrounded: "Checked against this case's own recorded facts. No unsupported claims found.",
    copilotWhyFlagged: "Checked against this case's own recorded facts. {count} possible unsupported claims flagged for review.",
    moveTitle: "Move it on",
    moveIntro: "Set where the work item stands. The state machine is the record; nothing else moves it.",
    moveTo: "Move to",
    moveSubmit: "Move the work item",
    moved: "The work item was moved.",
    stateRequired: "Choose a state to move to.",
    eventsTitle: "Steps",
    eventsCaption: "Every step recorded on this work item, newest first.",
    flowTitle: "Where it is",
    flowLabel: "Work item lifecycle",
    documentsTitle: "Documents",
    documentsCaption: "Evidence filed on this work item. Verifying one is a decision, and it is recorded.",
    verify: "Verify",
    verified: "The document was verified.",
    documentRequired: "Pick a document to verify.",
    colVerified: "Verified",
    questionRequired: "Type a question first.",
    approvalsTitle: "Sign-off",
    approvalsCaption: "Every approval raised while working this item.",
    tasksTitle: "Work",
    tasksCaption: "Tasks opened against this work item.",
    colStep: "Step",
    colDuration: "Took",
    colConfidence: "Confidence",
    colPolicyKey: "Rule",
    colSubject: "Subject",
    colTask: "Task",
    colAssignee: "With",
    colDue: "Due",
    "state.in_progress": "In progress",
    "state.blocked": "Blocked",
    "state.done": "Done",
    "state.cancelled": "Cancelled",
    "source.web": "Website",
    "source.orbit": "Conversation",
    "source.partner": "Partner",
    "source.import": "Import",
    "source.api": "Interface",
    "source.agent": "Automation",
    "kind.quote": "Pricing",
    "kind.bind": "Sale",
    "kind.endorse": "Endorsement",
    "kind.renewal_ops": "Renewal work",
    "kind.group_medical": "Group medical",
    "kind.kyc": "Identity check",
    "kind.claim": "Claim"
  },
  ar: {
    noneEvents: "لم يحدث شيء في بند العمل هذا منذ فتحه.",
    noneDocuments: "لا توجد ملفات مرفقة. تظهر هنا الأدلة المرفوعة على هذا البند.",
    noneApprovals: "لم تحتج أي خطوة في هذا البند إلى قرار حتى الآن.",
    noneTasks: "لا توجد مهمة معلّقة. تظهر المهام هنا عندما تحتاج خطوة إلى من ينفّذها.",
    intro: "موقف بند العمل، والخطوات التي أوصلته، وما لا يزال بانتظار أحد.",
    back: "العودة إلى قائمة العمل",
    heroLede: "{status} · أولوية {priority}",
    heroLedeDue: "{status} · أولوية {priority} · الاستحقاق {due}",
    standingTitle: "الموقف",
    value: "القيمة",
    sla: "الاستحقاق",
    risk: "درجة الخطر",
    owner: "المسؤول",
    team: "الفريق",
    priority: "الأولوية",
    source: "المصدر",
    kind: "النوع",
    productLine: "خط المنتج",
    holder: "العميل",
    channel: "القناة",
    quoteRequest: "طلب التسعير",
    closedAt: "تاريخ الإغلاق",
    metaTitle: "بيانات البند",
    exportTitle: "تصدير للتدقيق",
    exportIntro: "إنشاء حزمة أدلة جاهزة للجهة الرقابية بكل ما هو مسجّل على بند العمل هذا.",
    exportSubmit: "إنشاء الحزمة",
    exported: "الحزمة جاهزة.",
    copilotTitle: "اسأل مساعد الحالة",
    copilotPlaceholder: "اطرح سؤالًا حول هذه الحالة…",
    copilotSubmit: "اسأل",
    copilotEmpty: "اطرح سؤالًا وستظهر الإجابة هنا، مستندة إلى وقائع هذه الحالة.",
    copilotThinking: "جارٍ قراءة الحالة…",
    copilotWhyGrounded: "تم التحقق منها مقابل وقائع هذه الحالة المسجّلة. لا توجد ادعاءات غير مدعومة.",
    copilotWhyFlagged: "تم التحقق منها مقابل وقائع هذه الحالة المسجّلة. تم رصد {count} ادعاء محتمل غير مدعوم يستحق المراجعة.",
    moveTitle: "تحريك البند",
    moveIntro: "حدّد موقف بند العمل. آلة الحالات هي السجل، ولا شيء آخر يحرّكه.",
    moveTo: "الانتقال إلى",
    moveSubmit: "تحريك بند العمل",
    moved: "تم تحريك بند العمل.",
    stateRequired: "اختر الحالة المطلوبة.",
    eventsTitle: "الخطوات",
    eventsCaption: "كل خطوة مسجّلة على بند العمل، الأحدث أولًا.",
    flowTitle: "موضعه الآن",
    flowLabel: "دورة حياة بند العمل",
    documentsTitle: "المستندات",
    documentsCaption: "الأدلة المرفقة بهذا البند. توثيق المستند قرار، ويُسجّل.",
    verify: "توثيق",
    verified: "تم توثيق المستند.",
    documentRequired: "اختر مستندًا للتوثيق.",
    colVerified: "موثّق",
    questionRequired: "اكتب سؤالًا أولًا.",
    approvalsTitle: "الموافقات",
    approvalsCaption: "كل موافقة طُلبت أثناء العمل على هذا البند.",
    tasksTitle: "المهام",
    tasksCaption: "المهام المفتوحة على بند العمل.",
    colStep: "الخطوة",
    colDuration: "المدة",
    colConfidence: "درجة الثقة",
    colPolicyKey: "القاعدة",
    colSubject: "الموضوع",
    colTask: "المهمة",
    colAssignee: "المسؤول",
    colDue: "الاستحقاق",
    "state.in_progress": "قيد التنفيذ",
    "state.blocked": "متعثرة",
    "state.done": "منجزة",
    "state.cancelled": "ملغاة",
    "source.web": "الموقع",
    "source.orbit": "محادثة",
    "source.partner": "شريك",
    "source.import": "استيراد",
    "source.api": "واجهة برمجية",
    "source.agent": "أتمتة",
    "kind.quote": "تسعير",
    "kind.bind": "بيع",
    "kind.endorse": "تعديل",
    "kind.renewal_ops": "أعمال التجديد",
    "kind.group_medical": "طبي جماعي",
    "kind.kyc": "التحقق من الهوية",
    "kind.claim": "مطالبة"
  }
};

export const labelsIn = labelsFrom(LABELS);

/** The line under the case ref: its status and priority, and the SLA due date
 * when there is one to show. No ✦ (read straight off the loaded record, not a
 * model finding, CLAUDE.md §11). */
export function caseLede(workItem: Pick<Case, "status" | "priority" | "slaDueAt">, l: Label, locale: string): string {
  const status = tag(l, "status", workItem.status);
  const priority = tag(l, "priority", workItem.priority);
  if (!workItem.slaDueAt) return l("heroLede", { status, priority });
  const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" });
  return l("heroLedeDue", { status, priority, due: formatInstant(workItem.slaDueAt, fmt.format) });
}

/**
 * The copilot's answer region, and the wait before it. A model round trip is
 * the one pause on this screen a person sits through in place — no navigation
 * happens, so the shell's own progress bar never shows — and docs/15 gives a
 * screen 400ms before it owes the *shape* of what is coming. Three ghost lines
 * of prose plus the confidence bar is that shape; the pulse is decoration, the
 * live region is what a screen reader hears.
 */
export function CopilotAnswer({
  pending,
  l,
  answer,
  confidence,
  mismatches
}: {
  pending: boolean;
  l: Label;
  answer?: string | null | undefined;
  confidence?: number | null | undefined;
  mismatches?: unknown[] | null | undefined;
}) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (pending) {
    return (
      <div className="mt-4 flex flex-col gap-3" aria-live="polite" aria-busy="true">
        <span className="font-ui text-12 text-subtle">{l("copilotThinking")}</span>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-2 w-40" />
      </div>
    );
  }
  if (!answer || dismissed === answer) return null;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <AgentBadge
          size="sm"
          why={
            mismatches && mismatches.length > 0
              ? l("copilotWhyFlagged", { count: String(mismatches.length) })
              : l("copilotWhyGrounded")
          }
        />
        {/* An answer, not a draft: there is nothing to accept it into, so
            it offers only to go away. */}
        <GhostText text={answer} onDiscard={() => setDismissed(answer)} />
      </div>
      <ConfidenceMeter value={confidence ?? 0} />
    </div>
  );
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
    verify: held.has(PERM.verify),
    export: held.has(PERM.export),
    copilot: held.has(PERM.copilot)
  };

  const empty = {
    workItem: null as Case | null,
    events: [] as EventRow[],
    trail: [] as AuditRow[],
    documents: [] as DocumentRow[],
    approvals: [] as CaseApprovalRow[],
    tasks: [] as TaskRow[],
    named: {} as Record<string, string>,
    may,
    idempotencyKey: crypto.randomUUID()
  };

  if (!may.read) return empty;
  const scope = `?caseId=${encodeURIComponent(id)}&limit=50`;
  const [workItem, events, trail, documents, approvals, tasks] = await Promise.all([
    safe(() => api<Case>(`/v1/axis/cases/${id}`, options), null),
    held.has(PERM.events)
      ? safe(() => api<Page<EventRow>>(`/v1/axis/process-events${scope}&sort=ts&order=desc`, options), null)
      : null,
    // The state hops, which the process-event steps are not: those are mining
    // step names (`quote_fanout`, `documents_requested`), not case states.
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
    held.has(PERM.documents) ? safe(() => api<Page<DocumentRow>>(`/v1/axis/documents${scope}`, options), null) : null,
    held.has(PERM.approvals)
      ? safe(() => api<Page<CaseApprovalRow>>(`/v1/axis/case-approvals${scope}`, options), null)
      : null,
    held.has(PERM.tasks) ? safe(() => api<Page<TaskRow>>(`/v1/axis/tasks${scope}`, options), null) : null
  ]);

  if (!workItem) return empty;
  // The case points at a holder, a channel, an owner and a team. Name them in
  // one call so the facts read as people and places, not as refs.
  const named = await names(
    [workItem.customerId, workItem.channelId, workItem.ownerRef, workItem.teamId].filter(
      (ref): ref is string => Boolean(ref)
    ),
    options
  ).catch(() => ({}) as Record<string, string>);
  return {
    ...empty,
    workItem,
    named,
    events: rowsOf(events),
    trail: rowsOf(trail),
    documents: rowsOf(documents),
    approvals: rowsOf(approvals),
    tasks: rowsOf(tasks)
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = params.id ?? String(form.get("id") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const nothing = {
    done: null as string | null,
    problem: null as Problem | null,
    error: null as string | null,
    bundleId: null as string | null,
    answer: null as string | null,
    confidence: null as number | null,
    mismatches: null as number[] | null
  };
  // The loader mints one key per page load, but the hidden field carrying it
  // is shared by four forms (move/verify/export/copilot). Suffixing with the
  // intent keeps a same-page retry of one action idempotent without letting a
  // second, different action on the same load collide with it under the
  // same key.
  const headers = key ? { headers: { "idempotency-key": `${key}:${intent}` } } : {};

  try {
    if (intent === "move") {
      const status = String(form.get("status") ?? "");
      if (!(STATES as readonly string[]).includes(status)) return { ...nothing, error: "stateRequired" };
      await api<Case>(`/v1/axis/cases/${id}`, { env, request, method: "PATCH", ...headers, body: { status } });
      return { ...nothing, done: "moved" };
    }
    if (intent === "verify") {
      const documentId = String(form.get("documentId") ?? "").trim();
      if (!documentId) return { ...nothing, error: "documentRequired" };
      await api<unknown>(`/v1/axis/documents/${documentId}/verify`, { env, request, method: "POST", ...headers });
      return { ...nothing, done: "verified" };
    }
    if (intent === "export") {
      const bundle = await api<{ id: string }>("/v1/compliance/evidence-bundles/export", {
        env,
        request,
        method: "POST",
        ...headers,
        body: { purpose: "internal", subjectRef: id }
      });
      return { ...nothing, done: "exported", bundleId: bundle.id };
    }
    if (intent === "copilot") {
      const question = String(form.get("question") ?? "").trim();
      if (!question) return { ...nothing, error: "questionRequired" };
      const locale = String(form.get("locale") ?? "en");
      const result = await api<{ answer: string; confidence: number; mismatches: number[]; auditId: string }>(
        `/v1/axis/cases/${id}/copilot`,
        { env, request, method: "POST", ...headers, body: { question, locale } }
      );
      return { ...nothing, done: "answered", answer: result.answer, confidence: result.confidence, mismatches: result.mismatches };
    }
    return { ...nothing, problem: { title: "unknown intent", status: 400 } };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function CaseDetail() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  if (!loaded.workItem) {
    return (
      <div className="flex flex-col gap-6">
        <Header title={l("colRef")} intro={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const workItem = loaded.workItem;

  // Ascending, because the trail arrives newest-first and a flow reads forwards.
  // The trail is capped at 25 rows and is withheld without `core:audit:read`, so
  // these are the hops this actor can see — never a claim that there were no
  // others. `flowPlan` draws the current state and what is still owed either
  // way, so a case with no visible history is still honestly placed.
  const visits: FlowVisit[] = [...loaded.trail].reverse().flatMap((row) => {
    const state = stateOfAudit(row.action);
    return state ? [{ state, at: row.ts, actor: row.actorRef }] : [];
  });

  const eventColumns: Array<Column<EventRow>> = [
    { key: "step", header: l("colStep"), render: (row) => <span className="font-ui text-12">{tag(l, "step", row.step)}</span> },
    {
      key: "outcome",
      header: l("colOutcome"),
      render: (row) => (row.outcome ? <Badge size="sm">{tag(l, "outcome", row.outcome)}</Badge> : <span>—</span>)
    },
    { key: "actorRef", header: l("colWho"), render: (row) => <Ref value={row.actorRef} className="text-12" /> },
    {
      key: "durationMs",
      header: l("colDuration"),
      numeric: true,
      render: (row) => <span className="font-mono text-12">{row.durationMs ?? "—"}</span>
    },
    { key: "ts", header: l("colWhen"), render: (row) => <DateTime value={row.ts} locale={locale} precision="minute" /> }
  ];

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
      render: (row) =>
        row.verifiedAt ? (
          <DateTime value={row.verifiedAt} locale={locale} precision="day" />
        ) : loaded.may.verify ? (
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <input type="hidden" name="documentId" value={row.id} />
            <Button type="submit" size="sm" variant="ghost" loading={busy}>
              {l("verify")}
            </Button>
          </Form>
        ) : (
          <span>—</span>
        )
    }
  ];

  const approvalColumns: Array<Column<CaseApprovalRow>> = [
    { key: "policyKey", header: l("colPolicyKey"), render: (row) => humanise(row.policyKey) },
    {
      key: "decision",
      header: l("colOutcome"),
      render: (row) => <Badge size="sm">{tag(l, "decision", row.decision)}</Badge>
    },
    { key: "subjectRef", header: l("colSubject"), render: (row) => <Ref value={row.subjectRef} className="text-12" /> },
    { key: "ts", header: l("colWhen"), render: (row) => <DateTime value={row.ts} locale={locale} precision="minute" /> }
  ];

  const taskColumns: Array<Column<TaskRow>> = [
    { key: "titleKey", header: l("colTask"), render: (row) => <span className="font-ui text-12">{tag(l, "titleKey", row.titleKey)}</span> },
    { key: "state", header: l("colStatus"), render: (row) => <Badge size="sm">{tag(l, "state", row.state)}</Badge> },
    { key: "assigneeRef", header: l("colAssignee"), render: (row) => <Ref value={row.assigneeRef} className="text-12" /> },
    {
      key: "dueAt",
      header: l("colDue"),
      render: (row) => (row.dueAt ? <DateTime value={row.dueAt} locale={locale} precision="day" /> : <span>—</span>)
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{workItem.ref}</h1>
          <p className="font-ui text-13 text-muted">{caseLede(workItem, l, locale)}</p>
          <Link to="/axis/cases" className="w-fit font-ui text-13 text-accent underline">
            {l("back")}
          </Link>
        </div>
      </header>

      <Card
        title={l("standingTitle")}
        actions={
          <Badge size="sm" dot>
            {tag(l, "status", workItem.status)}
          </Badge>
        }
      >
        <div className="mb-4 grid grid-cols-2 gap-6 md:grid-cols-3">
          <Stat
            label={l("value")}
            value={
              workItem.valueMinor != null && workItem.currency ? (
                <Money amountMinor={workItem.valueMinor} currency={workItem.currency} locale={locale} />
              ) : (
                <span className="font-ui text-13">—</span>
              )
            }
          />
          <Stat
            label={l("sla")}
            value={
              workItem.slaDueAt ? (
                <DateTime value={workItem.slaDueAt} locale={locale} precision="minute" />
              ) : (
                <span className="font-ui text-13">—</span>
              )
            }
          />
          <Stat label={l("risk")} value={<span className="font-mono text-13">{workItem.riskScore ?? "—"}</span>} />
        </div>
        <Facts>
          <Entry term={l("kind")}>{tag(l, "kind", workItem.kind)}</Entry>
          <Entry term={l("priority")}>{tag(l, "priority", workItem.priority)}</Entry>
          <Entry term={l("source")}>{tag(l, "source", workItem.source)}</Entry>
          <Entry term={l("owner")}>
            {workItem.ownerRef ? (loaded.named[workItem.ownerRef] ?? <Ref value={workItem.ownerRef} />) : "—"}
          </Entry>
          <Entry term={l("team")}>
            {workItem.teamId ? (loaded.named[workItem.teamId] ?? <Ref value={workItem.teamId} />) : "—"}
          </Entry>
          <Entry term={l("productLine")}>{workItem.productLine ?? "—"}</Entry>
          <Entry term={l("holder")}>
            {workItem.customerId ? (
              <Link to={`/admin/customers/${workItem.customerId}/360`} className="text-accent hover:underline">
                {loaded.named[workItem.customerId] ?? <Ref value={workItem.customerId} />}
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("channel")}>
            {workItem.channelId ? (
              <Link to={`/distribution/channels/${workItem.channelId}/detail`} className="text-accent hover:underline">
                {loaded.named[workItem.channelId] ?? <Ref value={workItem.channelId} />}
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("quoteRequest")}>
            {workItem.quoteRequestId ? (
              <Link
                to={`/distribution/quote-requests/${workItem.quoteRequestId}/compare`}
                className="text-accent hover:underline"
              >
                <Ref value={workItem.quoteRequestId} />
              </Link>
            ) : (
              "—"
            )}
          </Entry>
          <Entry term={l("closedAt")}>
            {workItem.closedAt ? <DateTime value={workItem.closedAt} locale={locale} precision="minute" /> : "—"}
          </Entry>
        </Facts>
      </Card>

      {loaded.may.update ? (
        <Card title={l("moveTitle")} description={l("moveIntro")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="move" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <label className="flex flex-col gap-1 font-ui text-12 text-muted">
              {l("moveTo")}
              <Select
                name="status"
                defaultValue={workItem.status}
                options={STATES.map((value) => ({ value, label: tag(l, "status", value) }))}
              />
            </label>
            <Button type="submit" variant="primary" loading={busy}>
              {l("moveSubmit")}
            </Button>
          </Form>
        </Card>
      ) : null}

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.done ? <p className="font-ui text-13 text-success">{l(result.done)}</p> : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <Card title={l("flowTitle")}>
        <StateFlow
          machine={CASE_FLOW}
          visits={visits}
          current={workItem.status}
          label={l("flowLabel")}
          labelFor={(state) => tag(l, "status", state)}
          locale={locale}
        />
      </Card>

      <Card title={l("eventsTitle")} padded={false}>
        <Table
          caption={l("eventsCaption")}
          columns={eventColumns}
          rows={loaded.events}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneEvents")} />}
        />
      </Card>

      <Card title={l("documentsTitle")} padded={false}>
        <Table
          caption={l("documentsCaption")}
          columns={documentColumns}
          rows={loaded.documents}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneDocuments")} />}
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

      <Card title={l("tasksTitle")} padded={false}>
        <Table
          caption={l("tasksCaption")}
          columns={taskColumns}
          rows={loaded.tasks}
          rowKey={(row) => row.id}
          empty={<EmptyState title={l("none")} body={l("noneTasks")} />}
        />
      </Card>

      <Card title={l("metaTitle")}>
        <Payload value={workItem.metaJson} />
      </Card>

      {loaded.may.export ? (
        <Card title={l("exportTitle")} description={l("exportIntro")}>
          <Form method="post" className="flex flex-wrap items-center gap-4">
            <input type="hidden" name="intent" value="export" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <Button type="submit" variant="secondary" loading={busy}>
              {l("exportSubmit")}
            </Button>
            {result?.done === "exported" && result.bundleId ? (
              <a
                href={`/axis/cases/${workItem.id}/evidence-bundles/${result.bundleId}/download`}
                className="font-ui text-13 text-accent underline-offset-2 hover:underline"
              >
                {l("download")}
              </a>
            ) : null}
          </Form>
        </Card>
      ) : null}

      {loaded.may.copilot ? (
        // Ambient, not modal (CLAUDE.md rule 11, docs/15 §4): the copilot sits
        // in the page beside the facts it answers from, so the case stays
        // readable while a question is asked and the answer arrives as ghost
        // text. A drawer would have covered the evidence the answer cites.
        <Card title={l("copilotTitle")} description={l("copilotEmpty")}>
          <Form method="post" replace className="flex flex-col items-start gap-3">
            <input type="hidden" name="intent" value="copilot" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <input type="hidden" name="locale" value={locale} />
            <Field label={l("copilotPlaceholder")} labelHidden required className="w-full">
              <Textarea name="question" placeholder={l("copilotPlaceholder")} rows={3} required />
            </Field>
            <Button type="submit" disabled={busy}>
              {l("copilotSubmit")}
            </Button>
          </Form>
          <CopilotAnswer
            pending={busy && navigation.formData?.get("intent") === "copilot"}
            l={l}
            answer={result?.done === "answered" ? result.answer : undefined}
            confidence={result?.confidence}
            mismatches={result?.mismatches}
          />
        </Card>
      ) : null}
    </div>
  );
}

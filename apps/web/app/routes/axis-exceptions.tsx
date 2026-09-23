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
  EmptyState,
  Field,
  KPIWall,
  Money,
  Select,
  Stat,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, directory, names } from "../api.server";
import { HeroStat, useFocus } from "../components/hero";
import { who } from "../names";
import { humanise } from "../modules/spec";
import { cloudflare } from "../context";
import { labelsFrom, type Label } from "./detail-kit";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";

// The work that is stuck. Every AXIS list can be filtered to one resource's bad
// state, but nobody's morning is "open six tabs and filter each one": an
// operator wants a single queue of everything waiting on a person, worst first.
//
// There is no exceptions endpoint and there needs to be none — every bucket
// below is one existing CRUD list with an exact-match column filter
// (apps/api/src/crud.ts), read in parallel and merged here.

/* --------------------------------------------------------------- contract */

/** The gates the API applies to the lists and writes this screen uses. */
export const PERM = {
  cases: "axis:cases:read",
  caseWrite: "axis:cases:update",
  documents: "axis:documents:read",
  tasks: "axis:tasks:read",
  taskWrite: "axis:tasks:write",
  escrow: "axis:escrow:read",
  complaints: "axis:complaints:read"
} as const;

/** Complaints states still open for regulatory-clock purposes (docs/27 §D.6). */
const OPEN_COMPLAINT_STATES = ["received", "investigating", "awaiting_customer", "escalated"] as const;

/** Rows per bucket. A queue longer than this is a staffing problem, not a UI one. */
const PER_BUCKET = 25;

/**
 * A case in one of these is waiting on a human by definition: `failed` needs a
 * decision, `approval` an approver, `awaiting_docs` chasing, `review` reviewing.
 * `intake` and `quoting` are work in flight and belong on the board, not here.
 */
export const STUCK_CASE_STATUSES = ["failed", "approval", "awaiting_docs", "review"] as const;

export type Severity = "breach" | "urgent" | "due" | "normal";

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Exception queue",
    intro:
      "Everything waiting on a person, worst first. Each row opens the record that is stuck; the only decisions taken from this screen are taking ownership and reopening a blocked task.",
    "bucket.cases": "Cases needing a decision",
    "bucket.documents": "Documents rejected",
    "bucket.tasks": "Tasks blocked",
    "bucket.escrow": "Escrow batches with a variance",
    "bucket.complaints": "Complaints past their regulatory deadline",
    "stat.total": "Open exceptions",
    "stat.breached": "Past their deadline",
    "stat.urgent": "Marked urgent",
    "stat.oldest": "Oldest",
    "sev.breach": "Overdue",
    "sev.urgent": "Urgent",
    "sev.due": "Due soon",
    "sev.normal": "Waiting",
    unassigned: "Nobody",
    "empty.title": "Nothing is stuck",
    "empty.body": "No case, document, task or escrow batch is waiting on a person right now.",
    // Horizon's opening move: the screen says what the state of play is before
    // showing a single number. Count-free like home.tsx's `answer` (docs/15
    // §4) — Arabic has five plural forms, and the count is one row below on
    // the KPI wall regardless.
    "headline.clear": "Nothing is waiting on a person right now.",
    "headline.breached": "Something has missed its deadline.",
    "headline.urgent": "Nothing has missed its deadline, but something is urgent.",
    "headline.waiting": "Something is waiting on a person.",
    "headline.open": "Open the worst case: {ref}",
    "denied.title": "Partly hidden",
    "denied.body":
      "Some queues are missing from this page because your roles do not include their read permission.",
    "claim.title": "Take ownership",
    "claim.intro": "Put a reference on a stuck case so it stops being nobody's.",
    "claim.case": "Case",
    "claim.owner": "Owner",
    "claim.pick": "Choose a colleague or team",
    "claim.submit": "Assign",
    "done.claim": "Ownership updated.",
    "done.unblock": "Task reopened.",
    "unblock.submit": "Reopen",
    days: "d",
    hours: "h",
    minutes: "m",
    "problem.bad_intent": "The form did not carry an action this screen knows.",
    "problem.missing_case": "Name both the case and the owner before assigning it.",
    "problem.missing_task": "No task was named."
  },
  ar: {
    title: "قائمة انتظار الاستثناءات",
    intro:
      "كل ما ينتظر شخصًا، الأسوأ أولًا. كل سطر يفتح السجل المتعطل؛ القرارات الوحيدة من هذه الشاشة هي تولّي المسؤولية وإعادة فتح مهمة متعطلة.",
    "bucket.cases": "حالات تنتظر قرارًا",
    "bucket.documents": "مستندات مرفوضة",
    "bucket.tasks": "مهام متعطلة",
    "bucket.escrow": "دفعات ضمان بها فرق",
    "bucket.complaints": "شكاوى تجاوزت موعدها التنظيمي",
    "stat.total": "استثناءات مفتوحة",
    "stat.breached": "تجاوزت موعدها",
    "stat.urgent": "عاجلة",
    "stat.oldest": "الأقدم",
    "sev.breach": "متأخرة",
    "sev.urgent": "عاجلة",
    "sev.due": "قريبة الاستحقاق",
    "sev.normal": "بالانتظار",
    unassigned: "بلا مسؤول",
    "empty.title": "لا شيء متعطل",
    "empty.body": "لا توجد حالة أو مستند أو مهمة أو دفعة ضمان تنتظر شخصًا الآن.",
    "headline.clear": "لا شيء ينتظر شخصًا الآن.",
    "headline.breached": "هناك ما تجاوز موعده النهائي.",
    "headline.urgent": "لم يتجاوز أي شيء موعده النهائي، لكن هناك ما هو عاجل.",
    "headline.waiting": "هناك ما ينتظر شخصًا.",
    "headline.open": "افتح أسوأ حالة: {ref}",
    "denied.title": "معروض جزئيًا",
    "denied.body": "بعض الطوابير غائبة عن هذه الصفحة لأن أدوارك لا تتضمن صلاحية قراءتها.",
    "claim.title": "تولّي المسؤولية",
    "claim.intro": "اربط مرجعًا بحالة متعطلة حتى تتوقف عن كونها بلا مسؤول.",
    "claim.case": "الحالة",
    "claim.owner": "المسؤول",
    "claim.pick": "اختر زميلاً أو فريقاً",
    "claim.submit": "تعيين",
    "done.claim": "تم تحديث المسؤول.",
    "done.unblock": "أُعيد فتح المهمة.",
    "unblock.submit": "إعادة فتح",
    days: "ي",
    hours: "س",
    minutes: "د",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "problem.missing_case": "حدّد الحالة والمسؤول قبل التعيين.",
    "problem.missing_task": "لم تُحدَّد أي مهمة."
  }
};

export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- shapes */

export interface CaseRow {
  id: string;
  ref: string;
  kind: string;
  status: string;
  priority: string;
  ownerRef: string | null;
  slaDueAt: number | null;
  createdAt: number;
}

export interface DocumentRow {
  id: string;
  caseId: string;
  docType: string;
  status: string;
  createdAt: number;
}

export interface TaskRow {
  id: string;
  caseId: string | null;
  titleKey: string;
  state: string;
  assigneeRef: string | null;
  dueAt: number | null;
}

export interface EscrowRow {
  id: string;
  period: string;
  providerId: string;
  status: string;
  expectedMinor: number;
  receivedMinor: number;
  currency: string;
}

export interface ComplaintRow {
  id: string;
  ref: string;
  caseId: string | null;
  ownerRef: string | null;
  dueAt: number;
}

/** The five queues this screen shows, in the order it shows them. */
export interface Buckets {
  cases: CaseRow[];
  documents: DocumentRow[];
  tasks: TaskRow[];
  escrow: EscrowRow[];
  complaints: ComplaintRow[];
}

const NO_ROWS: Buckets = { cases: [], documents: [], tasks: [], escrow: [], complaints: [] };

/** Rows across every queue — what `stat.total` prints. */
export function countIn(buckets: Buckets): number {
  return (
    buckets.cases.length +
    buckets.documents.length +
    buckets.tasks.length +
    buckets.escrow.length +
    buckets.complaints.length
  );
}

/**
 * The queues one hero figure counted. `breached` spans two of them — a case past
 * its deadline, plus every complaint, since the loader only asks for late ones —
 * so its drill-down keeps both and empties the other three rather than leaving
 * unrelated rows on screen under a figure that never counted them. Each figure
 * is `countIn(exceptionFocus(…))`, so the number and the rows are one call.
 */
export function exceptionFocus(buckets: Buckets, focus: string | null, now: number): Buckets {
  if (focus === "breached")
    return {
      ...NO_ROWS,
      cases: buckets.cases.filter((row) => severityOf(row, now) === "breach"),
      complaints: buckets.complaints
    };
  if (focus === "urgent")
    return { ...NO_ROWS, cases: buckets.cases.filter((row) => row.priority === "urgent") };
  return buckets;
}

/* ---------------------------------------------------------------- helpers */

/**
 * How loudly one stuck case should read. The deadline beats the label: a
 * `normal` case three days past its SLA is a worse problem than an `urgent` one
 * due tomorrow. `soonMs` is the "due soon" window, a day by default.
 */
export function severityOf(
  row: { priority?: string; slaDueAt?: number | null },
  now: number,
  soonMs = 24 * 60 * 60 * 1000
): Severity {
  const due = row.slaDueAt;
  if (typeof due === "number" && due < now) return "breach";
  if (row.priority === "urgent") return "urgent";
  if (typeof due === "number" && due - now <= soonMs) return "due";
  return "normal";
}

const RANK: Record<Severity, number> = { breach: 0, urgent: 1, due: 2, normal: 3 };

const TONE: Record<Severity, BadgeTone> = {
  breach: "danger",
  urgent: "warning",
  due: "info",
  normal: "neutral"
};

/** Worst first, then earliest deadline, then oldest. Total and deterministic. */
export function bySeverity(now: number) {
  return (a: CaseRow, b: CaseRow): number => {
    const rank = RANK[severityOf(a, now)] - RANK[severityOf(b, now)];
    if (rank !== 0) return rank;
    const due = (a.slaDueAt ?? Number.MAX_SAFE_INTEGER) - (b.slaDueAt ?? Number.MAX_SAFE_INTEGER);
    return due !== 0 ? due : a.createdAt - b.createdAt;
  };
}

/**
 * The one sentence the screen opens with, before a single number. Count-free
 * like home.tsx's `answer` (docs/15 §4) — Arabic has five plural forms, and
 * the count is one row below on the KPI wall regardless. Arithmetic on counts
 * the caller already has, not an agent, so it never carries the ✦ mark
 * (CLAUDE.md §11).
 */
export function headlineFor(counts: { total: number; breached: number; urgent: number }, l: Label): string {
  if (counts.total === 0) return l("headline.clear");
  if (counts.breached) return l("headline.breached");
  if (counts.urgent) return l("headline.urgent");
  return l("headline.waiting");
}

/** Elapsed time as one coarse unit. Precision nobody acts on is noise. */
export function ageIn(ms: number, l: Label): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}${l("days")}`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}${l("hours")}`;
  return `${minutes}${l("minutes")}`;
}

/** A withheld list is absent, not an error: the rest of the queue still loads. */
async function safe<T>(call: Promise<T>, fallback: T): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const none = { data: [] as never[] };

  // `a,b` is the API's own "either" filter grammar; sorting by the deadline
  // server-side means the rows that matter arrive inside the page limit.
  const now = Date.now();

  const [cases, documents, tasks, escrow, complaints] = await Promise.all([
    safe(
      api<{ data: CaseRow[] }>(
        `/v1/axis/cases?status=${STUCK_CASE_STATUSES.join(",")}&sort=slaDueAt&order=asc&limit=${PER_BUCKET}`,
        opts
      ),
      none
    ),
    safe(api<{ data: DocumentRow[] }>(`/v1/axis/documents?status=rejected&limit=${PER_BUCKET}`, opts), none),
    safe(
      api<{ data: TaskRow[] }>(`/v1/axis/tasks?state=blocked&sort=dueAt&order=asc&limit=${PER_BUCKET}`, opts),
      none
    ),
    safe(api<{ data: EscrowRow[] }>(`/v1/axis/escrow-batches?status=variance&limit=${PER_BUCKET}`, opts), none),
    // `to=` bounds the sort column (crud.ts), which is `dueAt` here — every row
    // returned is already past its regulatory deadline, so no client-side
    // severity check is needed for this bucket.
    safe(
      api<{ data: ComplaintRow[] }>(
        `/v1/axis/complaints?state=${OPEN_COMPLAINT_STATES.join(",")}&to=${now}&sort=dueAt&order=asc&limit=${PER_BUCKET}`,
        opts
      ),
      none
    )
  ]);

  // Rejected documents and breached complaints point at a case by id, and a
  // complaint names its owner by ref — an exceptions queue that lists ULIDs is
  // a queue nobody can triage. `who` falls back to the short ref per row.
  const resolved = await names(
    [
      ...cases.data.map((row) => row.ownerRef),
      ...documents.data.map((row) => row.caseId),
      // A blocked task named its holder `user:us_01KE…FMN` and a variance batch
      // named the carrier it is owed from `pv_01KE…BGZGV`.
      ...tasks.data.map((row) => row.assigneeRef),
      ...escrow.data.map((row) => row.providerId),
      ...complaints.data.flatMap((row) => [row.caseId, row.ownerRef])
    ],
    opts
  );

  // Claiming an exception took a typed `user:us_…`, which nobody knows
  // (ADR-0047) — the picker reads the same directory the board's does.
  const assignees = await directory(opts);

  return {
    // One server clock for the whole page: severity recomputed per component
    // would drift between a badge and the count printed beside it.
    now,
    names: resolved,
    assignees,
    cases: cases.data,
    documents: documents.data,
    tasks: tasks.data,
    escrow: escrow.data,
    complaints: complaints.data
  };
}

/* ----------------------------------------------------------------- action */

export interface Refusal {
  title: string;
  status: number;
  code?: string;
  detail?: string;
}

export interface ActionResult {
  problem: Refusal | null;
  done: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // One key per submission, so a double-click is one write (docs/19 §3).
  const headers = { "idempotency-key": crypto.randomUUID() };

  try {
    if (intent === "claim") {
      const id = String(form.get("caseId") ?? "").trim();
      const ownerRef = String(form.get("ownerRef") ?? "").trim();
      if (!id || !ownerRef) return refuse("missing_case");
      await api(`/v1/axis/cases/${encodeURIComponent(id)}`, {
        env,
        request,
        method: "PATCH",
        headers,
        body: { ownerRef }
      });
      return { problem: null, done: "claim" };
    }

    if (intent === "unblock") {
      const id = String(form.get("taskId") ?? "").trim();
      if (!id) return refuse("missing_task");
      await api(`/v1/axis/tasks/${encodeURIComponent(id)}`, {
        env,
        request,
        method: "PATCH",
        headers,
        body: { state: "open" }
      });
      return { problem: null, done: "unblock" };
    }
  } catch (error) {
    // A refusal is information: an approval gate belongs on the screen that
    // asked for the write, not in an error boundary.
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }

  return refuse("bad_intent");
}

/** Codes this screen can phrase; anything else keeps the API's own wording. */
export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/* -------------------------------------------------------------- the screen */

export default function AxisExceptions() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const held = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const now = loaded.now;

  const all: Buckets = {
    cases: [...loaded.cases].sort(bySeverity(now)),
    documents: loaded.documents,
    tasks: loaded.tasks,
    escrow: loaded.escrow,
    complaints: loaded.complaints
  };
  // Each figure is the size of the very set its own link shows, so clicking one
  // cannot land on a different number of rows than the tile printed.
  const { focus, href } = useFocus({ breached: 1, urgent: 1 });
  const shown = exceptionFocus(all, focus, now);
  const total = countIn(all);
  const breached = countIn(exceptionFocus(all, "breached", now));
  const urgent = countIn(exceptionFocus(all, "urgent", now));
  const cases = shown.cases;
  const oldest = all.cases.reduce((min, row) => Math.min(min, row.createdAt), now);

  // A queue the actor cannot fully see is stated, not silently short.
  const hidden = [PERM.cases, PERM.documents, PERM.tasks, PERM.escrow, PERM.complaints].some((p) => !held.has(p));

  const headline = headlineFor({ total, breached, urgent }, l);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
        {cases[0] ? (
          <Link
            to={`/axis/cases/${cases[0].id}`}
            className="w-fit font-ui text-13 text-accent underline"
          >
            {l("headline.open", { ref: cases[0].ref })}
          </Link>
        ) : null}
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`done.${result.done}`)}
        </p>
      ) : null}

      {/* The total is every queue, so it doubles as the way back to all of them.
          The oldest figure is an age, not a set of rows, so it is not a link. */}
      <KPIWall>
        <HeroStat label={l("stat.total")} value={total} to={href(null)} active={focus === null} />
        <HeroStat
          label={l("stat.breached")}
          value={breached}
          to={href("breached")}
          active={focus === "breached"}
        />
        <HeroStat label={l("stat.urgent")} value={urgent} to={href("urgent")} active={focus === "urgent"} />
        <Stat label={l("stat.oldest")} value={total ? ageIn(now - oldest, l) : "—"} />
      </KPIWall>

      {hidden ? (
        <div role="status" className="rounded-md border border-border bg-surface-2 p-3">
          <p className="font-ui text-13 font-medium text-text">{l("denied.title")}</p>
          <p className="font-ui text-12 text-muted">{l("denied.body")}</p>
        </div>
      ) : null}

      {countIn(shown) === 0 ? <EmptyState title={l("empty.title")} body={l("empty.body")} /> : null}

      {cases.length ? (
        <Card title={l("bucket.cases")}>
          <ul className="flex flex-col divide-y divide-border">
            {cases.map((row) => {
              const severity = severityOf(row, now);
              return (
                <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Link
                    to={`/axis/cases/${row.id}`}
                    className="font-mono text-12 text-accent underline underline-offset-2"
                  >
                    {row.ref}
                  </Link>
                  <Badge tone={TONE[severity]} size="sm" dot>
                    {l(`sev.${severity}`)}
                  </Badge>
                  <span className="font-ui text-12 text-subtle">{who(row.ownerRef, loaded.names) ?? l("unassigned")}</span>
                  <span className="ms-auto font-ui text-12 tabular-nums text-subtle">
                    {ageIn(now - row.createdAt, l)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {shown.documents.length ? (
        <Card title={l("bucket.documents")}>
          <ul className="flex flex-col divide-y divide-border">
            {shown.documents.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link
                  to={`/axis/documents/${row.id}`}
                  className="font-mono text-12 text-accent underline underline-offset-2"
                >
                  {humanise(row.docType)}
                </Link>
                <Link to={`/axis/cases/${row.caseId}`} className="font-ui text-12 text-subtle">
                  {who(row.caseId, loaded.names)}
                </Link>
                <span className="ms-auto font-ui text-12 tabular-nums text-subtle">
                  {ageIn(now - row.createdAt, l)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {shown.tasks.length ? (
        <Card title={l("bucket.tasks")}>
          <ul className="flex flex-col divide-y divide-border">
            {shown.tasks.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link
                  to={`/axis/tasks/${row.id}`}
                  className="font-ui text-12 text-accent underline underline-offset-2"
                >
                  {humanise(row.titleKey)}
                </Link>
                <span className="font-ui text-12 text-subtle">
                  {who(row.assigneeRef, loaded.names) ?? l("unassigned")}
                </span>
                {held.has(PERM.taskWrite) ? (
                  <Form method="post" className="ms-auto">
                    <input type="hidden" name="intent" value="unblock" />
                    <input type="hidden" name="taskId" value={row.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant="ghost"
                      loading={busy}
                      aria-label={`${l("unblock.submit")}: ${humanise(row.titleKey)}`}
                    >
                      {l("unblock.submit")}
                    </Button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {shown.escrow.length ? (
        <Card title={l("bucket.escrow")}>
          <ul className="flex flex-col divide-y divide-border">
            {shown.escrow.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link
                  to={`/axis/escrow-batches/${row.id}`}
                  className="font-mono text-12 text-accent underline underline-offset-2"
                >
                  {row.period}
                </Link>
                <span className="font-ui text-12 text-subtle">{who(row.providerId, loaded.names)}</span>
                <span className="ms-auto font-mono text-12 tabular-nums text-warning">
                  <Money
                    amountMinor={row.receivedMinor - row.expectedMinor}
                    currency={row.currency}
                    signed
                  />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {shown.complaints.length ? (
        <Card title={l("bucket.complaints")}>
          <ul className="flex flex-col divide-y divide-border">
            {shown.complaints.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 py-2">
                <span className="font-mono text-12 text-text">{row.ref}</span>
                <Badge tone={TONE.breach} size="sm" dot>
                  {l("sev.breach")}
                </Badge>
                {row.caseId ? (
                  <Link to={`/axis/cases/${row.caseId}`} className="font-ui text-12 text-subtle">
                    {who(row.caseId, loaded.names)}
                  </Link>
                ) : null}
                <span className="font-ui text-12 text-subtle">
                  {who(row.ownerRef, loaded.names) ?? l("unassigned")}
                </span>
                <span className="ms-auto font-ui text-12 tabular-nums text-subtle">
                  {ageIn(now - row.dueAt, l)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {held.has(PERM.caseWrite) && cases.length ? (
        <Card title={l("claim.title")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="claim" />
            <Field label={l("claim.case")} className="w-64">
              <Select name="caseId" options={cases.map((row) => ({ value: row.id, label: row.ref }))} />
            </Field>
            <Field label={l("claim.owner")} hint={l("claim.intro")} className="w-64">
              <Select
                name="ownerRef"
                placeholder={l("claim.pick")}
                options={loaded.assignees.map((one) => ({ value: one.ref, label: one.name }))}
              />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("claim.submit")}
            </Button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}

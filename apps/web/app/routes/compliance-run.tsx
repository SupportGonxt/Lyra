import {
  data,
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
  DatePicker,
  DateTime,
  EmptyState,
  Field,
  Input,
  Ref,
  Select,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { refOptions } from "../refs.server";
import { cloudflare } from "../context";
import { RequestId } from "./module";
import { useShellData } from "./workspace";
import { RefPicker, type RefOption } from "../components/ref-picker";
import { labelsFrom } from "./detail-kit";

// The three compliance capabilities that are runs rather than forms (docs/12
// §3–§5, ADR-0002): a screening is a question put to a provider, an evidence
// bundle is files gathered and hashed, a retention purge is a deletion. Their
// rows carry hashes and counts the server computes, so this screen asks for the
// question and shows the answer — it never types a hash into a record.
//
// Nothing here decides anything. The API owns the permission, the hash, the
// cutoff and the audit row; a screen that recomputed any of them would be a
// second, unaudited version of the evidence.

type RunKind = "screening" | "evidence" | "retention";

/** Permissions, copied from apps/api/src/routes/compliance.ts. */
const RUNS: Record<RunKind, { permission: string; endpoint: string }> = {
  screening: { permission: "compliance:screenings:run", endpoint: "/v1/compliance/screenings/run" },
  evidence: { permission: "compliance:evidence:export", endpoint: "/v1/compliance/evidence-bundles/export" },
  retention: { permission: "compliance:retention:run", endpoint: "/v1/compliance/retention/run" }
};

const ORDER = Object.keys(RUNS) as RunKind[];

function isRunKind(key: string): key is RunKind {
  return Object.hasOwn(RUNS, key);
}

const SCREENING_KINDS = ["sanctions", "pep", "adverse_media", "fraud"] as const;
const PURPOSES = ["regulator", "audit", "dispute", "internal"] as const;
/** The one class apps/api will purge today. It refuses the others with a 400. */
const POLICY_KEYS = ["messages"] as const;

/* ------------------------------------------------------------- the payloads */

// Shapes as apps/api/src/routes/compliance.ts returns them — that file is what
// these three mirror, and it is what to re-read before changing one. Declared
// locally because the web app does not depend on the API's types; if these
// drift, the API's own contract test is what should fail rather than a build
// here — which is exactly why a field the server never sends can sit in one of
// these for months, so mirror the response, not the shape you expected.

interface ScreeningHit {
  listRef: string;
  matchedName: string;
  matchPct: number;
  note: string;
  stub?: boolean;
}

interface Screening {
  id: string;
  subjectRef: string;
  kind: string;
  provider: string;
  queryHash: string;
  result: "clear" | "hit" | "inconclusive";
  blocked: boolean;
  caseRef: string | null;
  ts: number;
  hits: ScreeningHit[];
}

interface ManifestFile {
  path: string;
  sizeBytes: number;
  sha256: string;
}

interface Bundle {
  id: string;
  purpose: string;
  state: string;
  bundleHash: string;
  fileId: string | null;
  requestedBy: string;
  deliveredTo: string | null;
  createdAt: number;
  manifest: { files: ManifestFile[]; truncated: boolean };
}

/**
 * Mirrors the two answers of `POST /v1/compliance/retention/run` in
 * apps/api/src/routes/compliance.ts §retention. The preview answers `dryRun:
 * true` with `retentionMonths`; the purge answers the stored `retention_runs`
 * row, which carries `state` and *no `dryRun` key at all*. So "did it delete?"
 * is `dryRun !== true` — `dryRun === false` is a branch the server can never
 * take, and `dryRun?: true` is what makes writing it a type error.
 */
interface RetentionResult {
  dryRun?: true;
  policyKey: string;
  tableName: string;
  cutoffAt: number;
  retentionMonths?: number;
  rowsAffected: number;
  rowsHeld: number;
  state?: string;
  more: boolean;
}

/* ------------------------------------------------------------------ strings */

// This screen owns its strings: the shared catalogue is another surface's file,
// and three runs that only exist here have no business widening it.
const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Compliance runs",
    "run.screening": "Screening",
    "run.evidence": "Evidence bundle",
    "run.retention": "Retention",
    "intro.screening":
      "Puts a name or a customer on file to the configured screening provider and records the answer with the hash of the question that was asked.",
    "intro.evidence":
      "Gathers the audit and AI audit entries in scope into one archive, hashes every file in it, and records the hash of the archive that was handed over.",
    "intro.retention":
      "Deletes conversation messages older than this tenant's retention period. Preview first: the preview counts what would go and what a legal hold is keeping.",
    "field.subject": "Name",
    "hint.subject": "The name to screen, as it is written on the document",
    "field.customerId": "Customer",
    "hint.customerId": "The customer on file, if the subject is one. Overrides the name.",
    "placeholder.customer": "Search by name",
    "field.kind": "Screening type",
    "field.purpose": "Purpose",
    "field.subjectRef": "Subject",
    "hint.subjectRef": "Narrow to one subject reference, e.g. customer:cus_… . Leave blank for everything in the window.",
    "field.from": "From",
    "field.to": "To",
    "field.deliveredTo": "Prepared for",
    "hint.deliveredTo": "Who asked for the bundle. Recorded on the row; nothing is sent from here.",
    "field.policyKey": "Record class",
    "kind.sanctions": "Sanctions",
    "kind.pep": "Politically exposed person",
    "kind.adverse_media": "Adverse media",
    "kind.fraud": "Fraud",
    "purpose.regulator": "Regulator request",
    "purpose.internal": "Internal review",
    "class.messages": "Conversation messages",
    "action.screening": "Run screening",
    "action.evidence": "Build bundle",
    "action.retention": "Preview",
    "action.purge": "Delete permanently",
    "stub.title": "No screening provider is configured",
    "stub.body":
      "This result was produced by the built-in stub, which consults no watchlist. It is a record that a screening was requested, and it is not a sanctions, politically-exposed-person or adverse-media check. Connecting a provider is a procurement decision, not a setting.",
    "result.screening": "Screening result",
    "result.clear": "Clear",
    "result.hit": "Hit",
    "result.inconclusive": "Inconclusive",
    blocked: "Blocked",
    "blocked.body": "A hit blocks the subject until a compliance officer records a disposition against the screening.",
    subject: "Subject",
    provider: "Provider",
    queryHash: "Query hash",
    "queryHash.hint": "The hash of the question that was asked. It is what makes this row evidence of that question.",
    hits: "Matches",
    "col.listRef": "List",
    "col.matchedName": "Matched name",
    "col.matchPct": "Match",
    "col.note": "Note",
    "result.evidence": "Bundle",
    "result.evidenceEmpty": "No files were captured in this run.",
    "result.evidenceEmpty.body": "This check passed on data alone — it read records rather than documents, so there was nothing to attach.",
    bundleHash: "Bundle hash",
    "bundleHash.hint": "sha256 of the archive, manifest included. Quote it with the bundle.",
    "col.path": "File",
    "col.size": "Size",
    "col.sha256": "sha256",
    download: "Download bundle",
    "state.ready": "Ready",
    "state.failed": "Failed",
    "state.done": "Done",
    "bundle.failed": "The archive could not be stored, so there is nothing to hand over. Try again; if it repeats, the file store is unavailable.",
    truncated: "This bundle hit the row ceiling and does not cover the whole window. Narrow the window and export again.",
    "result.retention.plan": "Preview",
    "result.retention.run": "Purge",
    cutoffAt: "Cutoff",
    "cutoffAt.hint": "Computed from this tenant's retention policy and the regulatory floor. It cannot be set here.",
    retentionMonths: "Retention period",
    months: "months",
    rowsAffected: "Rows to delete",
    rowsAffectedDone: "Rows deleted",
    rowsHeld: "Rows kept by a legal hold",
    tableName: "Table",
    more: "More rows are past the cutoff than one run covers. Run it again until nothing is left.",
    "purge.title": "This deletes the rows",
    "purge.body": "Deletion is permanent and there is no second approval behind this button. The count above is what will go.",
    "denied.title": "You cannot start this run",
    "denied.body": "It needs a permission your role does not hold. An administrator can grant it.",
    "empty.hits": "The provider returned no matches.",
    when: "When",
    problem: "The run did not happen",
    "headline.screening.clear": "No matches. Clear to proceed.",
    "headline.screening.hit": "A match was found. The subject is blocked.",
    "headline.screening.inconclusive": "The result was inconclusive.",
    "headline.evidenceReady": "Bundle built, {count} files.",
    "headline.evidenceFailed": "The archive could not be stored.",
    "headline.retentionPlan": "{count} rows would be deleted.",
    "headline.retentionDone": "{count} rows deleted."
  },
  ar: {
    title: "عمليات الامتثال",
    "run.screening": "الفحص",
    "run.evidence": "حزمة الأدلة",
    "run.retention": "الاحتفاظ",
    "intro.screening":
      "يعرض اسمًا أو عميلًا مسجَّلًا على مزود الفحص المُهيأ ويسجّل الإجابة مع بصمة السؤال الذي طُرح.",
    "intro.evidence":
      "يجمع قيود التدقيق وتدقيق الذكاء الاصطناعي ضمن النطاق في أرشيف واحد، ويحسب بصمة كل ملف فيه، ويسجّل بصمة الأرشيف الذي سُلِّم.",
    "intro.retention":
      "يحذف رسائل المحادثات الأقدم من مدة الاحتفاظ لدى هذه المؤسسة. اعرض المعاينة أولًا: تُحصي ما سيُحذف وما يحتفظ به التجميد القانوني.",
    "field.subject": "الاسم",
    "hint.subject": "الاسم المراد فحصه كما هو مكتوب في الوثيقة",
    "field.customerId": "العميل",
    "hint.customerId": "العميل المسجَّل إن كان الموضوع عميلًا. يُقدَّم على الاسم.",
    "placeholder.customer": "ابحث بالاسم",
    "field.kind": "نوع الفحص",
    "field.purpose": "الغرض",
    "field.subjectRef": "الموضوع",
    "hint.subjectRef": "حصر النتيجة بمرجع واحد، مثال customer:cus_… . اتركه فارغًا لتشمل كل ما في الفترة.",
    "field.from": "من",
    "field.to": "إلى",
    "field.deliveredTo": "أُعدّت لصالح",
    "hint.deliveredTo": "من طلب الحزمة. يُسجَّل في السجل، ولا يُرسل شيء من هنا.",
    "field.policyKey": "صنف السجلات",
    "kind.sanctions": "العقوبات",
    "kind.pep": "شخصية سياسية بارزة",
    "kind.adverse_media": "تغطية إعلامية سلبية",
    "kind.fraud": "الاحتيال",
    "purpose.regulator": "طلب من الجهة الرقابية",
    "purpose.internal": "مراجعة داخلية",
    "class.messages": "رسائل المحادثات",
    "action.screening": "تشغيل الفحص",
    "action.evidence": "إنشاء الحزمة",
    "action.retention": "معاينة",
    "action.purge": "حذف نهائي",
    "stub.title": "لا يوجد مزود فحص مُهيأ",
    "stub.body":
      "نتجت هذه النتيجة عن المكوّن المدمج المؤقت الذي لا يراجع أي قائمة. هي سجل بأن فحصًا قد طُلب، وليست فحص عقوبات ولا شخصيات سياسية بارزة ولا تغطية إعلامية سلبية. ربط مزود حقيقي قرار تعاقدي لا إعداد في النظام.",
    "result.screening": "نتيجة الفحص",
    "result.clear": "خالٍ",
    "result.hit": "تطابق",
    "result.inconclusive": "غير حاسم",
    blocked: "محظور",
    "blocked.body": "التطابق يحظر الموضوع إلى أن يسجّل مسؤول الامتثال تصرفًا على الفحص.",
    subject: "الموضوع",
    provider: "المزود",
    queryHash: "بصمة الاستعلام",
    "queryHash.hint": "بصمة السؤال الذي طُرح، وهي ما يجعل هذا السجل دليلًا على ذلك السؤال.",
    hits: "التطابقات",
    "col.listRef": "القائمة",
    "col.matchedName": "الاسم المطابق",
    "col.matchPct": "نسبة التطابق",
    "col.note": "ملاحظة",
    "result.evidence": "الحزمة",
    "result.evidenceEmpty": "لم يتم التقاط أي ملفات في هذا التشغيل.",
    "result.evidenceEmpty.body": "اجتاز هذا الفحص بالبيانات وحدها — قرأ سجلات لا مستندات، فلم يكن هناك ما يُرفق.",
    bundleHash: "بصمة الحزمة",
    "bundleHash.hint": "بصمة sha256 للأرشيف بما فيه قائمة المحتويات. اذكرها مع الحزمة.",
    "col.path": "الملف",
    "col.size": "الحجم",
    "col.sha256": "sha256",
    download: "تنزيل الحزمة",
    "state.ready": "جاهزة",
    "state.failed": "فشل",
    "state.done": "تم",
    "bundle.failed": "تعذّر تخزين الأرشيف، فلا شيء لتسليمه. أعد المحاولة، وإن تكرر فمخزن الملفات غير متاح.",
    truncated: "بلغت الحزمة الحد الأقصى للصفوف ولا تغطي الفترة كاملة. ضيّق الفترة وأعد التصدير.",
    "result.retention.plan": "المعاينة",
    "result.retention.run": "الحذف",
    cutoffAt: "تاريخ القطع",
    "cutoffAt.hint": "يُحتسب من سياسة الاحتفاظ لدى المؤسسة والحد التنظيمي الأدنى، ولا يمكن تحديده هنا.",
    retentionMonths: "مدة الاحتفاظ",
    months: "شهرًا",
    rowsAffected: "صفوف ستُحذف",
    rowsAffectedDone: "صفوف حُذفت",
    rowsHeld: "صفوف يحفظها التجميد القانوني",
    tableName: "الجدول",
    more: "الصفوف التي تجاوزت تاريخ القطع أكثر مما تغطيه دورة واحدة. أعد التشغيل حتى لا يبقى شيء.",
    "purge.title": "هذا يحذف الصفوف",
    "purge.body": "الحذف نهائي ولا توجد موافقة ثانية خلف هذا الزر. العدد أعلاه هو ما سيُحذف.",
    "denied.title": "لا يمكنك بدء هذه العملية",
    "denied.body": "تتطلب صلاحية لا يملكها دورك. يمكن للمسؤول منحها.",
    "empty.hits": "لم يُرجع المزود أي تطابق.",
    when: "التاريخ",
    problem: "لم تُنفَّذ العملية",
    "headline.screening.clear": "لا تطابق. يمكن المتابعة.",
    "headline.screening.hit": "عُثر على تطابق. الموضوع محظور.",
    "headline.screening.inconclusive": "النتيجة غير حاسمة.",
    "headline.evidenceReady": "تم إنشاء الحزمة، {count} ملف.",
    "headline.evidenceFailed": "تعذّر تخزين الأرشيف.",
    "headline.retentionPlan": "سيُحذف {count} صف.",
    "headline.retentionDone": "حُذف {count} صف."
  }
};

type Label = (key: string, vars?: Record<string, string>) => string;

// Local table, then detail-kit's SHARED, then `common.*` — the same chain every
// screen uses. This screen builds keys from enum values, and a hand-rolled table
// cannot answer one it never wrote down (docs/ui.md §7 P3-14).
const labelIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------- loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const kind = params.kind ?? "";
  if (!isRunKind(kind)) throw data("run", { status: 404 });
  const env = context.get(cloudflare).env;

  // Asked before the form is drawn: an action the actor cannot take is absent
  // here, not a button that 403s. A 401 is the session expiring, and the
  // workspace layout owns that redirect.
  const me = await fetchMe(env, request);
  const allowed = ORDER.filter((key) => me.permissions.includes(RUNS[key].permission));

  // The screening's subject is usually someone already on file, and the box
  // that asked for them wanted a `cu_01KE…` typed in by hand. An actor whose
  // role cannot read customers gets no list and keeps the plain box.
  const customers: RefOption[] =
    kind === "screening" && allowed.includes(kind)
      ? await refOptions("/v1/core/customers?sort=createdAt&order=desc&limit=100", env, request)
      : [];

  return {
    kind,
    allowed,
    customers,
    denied: !allowed.includes(kind),
    // The download is a plain link to the API, same trade as the finance
    // reports: no second copy of the archive passes through this app.
    apiOrigin: env.API_ORIGIN
  };
}

/* ------------------------------------------------------------------- action */

const DAY_END = "T23:59:59.999Z";

function epochOf(raw: string, endOfDay = false): number | undefined {
  if (!raw) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}${endOfDay ? DAY_END : "T00:00:00.000Z"}` : raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function text(form: FormData, name: string): string {
  return String(form.get(name) ?? "").trim();
}

type ActionResult =
  | { kind: "screening"; problem: null; screening: Screening }
  | { kind: "evidence"; problem: null; bundle: Bundle }
  | { kind: "retention"; problem: null; retention: RetentionResult }
  | {
      kind: RunKind;
      problem: { title: string; status: number; detail?: string; requestId?: string };
      screening?: never;
    };

/**
 * The one line a just-finished run adds to the header. Nothing to say before a
 * run, and nothing to add once the problem card below already carries a
 * failure — this only speaks for a result the API actually returned.
 */
export function runHeadline(fresh: ActionResult | undefined, l: Label): string | null {
  if (!fresh || fresh.problem) return null;
  if (fresh.kind === "screening") return l(`headline.screening.${fresh.screening.result}`);
  if (fresh.kind === "evidence") {
    return fresh.bundle.state === "failed"
      ? l("headline.evidenceFailed")
      : l("headline.evidenceReady", { count: String(fresh.bundle.manifest.files.length) });
  }
  // Same test the result card makes (`planned`), for the same reason: the purge
  // response omits `dryRun` rather than setting it false.
  return fresh.retention.dryRun
    ? l("headline.retentionPlan", { count: String(fresh.retention.rowsAffected) })
    : l("headline.retentionDone", { count: String(fresh.retention.rowsAffected) });
}

export async function action({ request, params, context }: ActionFunctionArgs): Promise<ActionResult> {
  const kind = params.kind ?? "";
  if (!isRunKind(kind)) throw data("run", { status: 404 });
  const env = context.get(cloudflare).env;
  const form = await request.formData();

  let payload: Record<string, unknown>;
  if (kind === "screening") {
    const customerId = text(form, "customerId");
    const name = text(form, "subject");
    payload = {
      kind: text(form, "kind") || "sanctions",
      ...(customerId ? { customerId } : {}),
      ...(name ? { name } : {})
    };
  } else if (kind === "evidence") {
    const subjectRef = text(form, "subjectRef");
    const deliveredTo = text(form, "deliveredTo");
    const from = epochOf(text(form, "from"));
    const to = epochOf(text(form, "to"), true);
    payload = {
      purpose: text(form, "purpose") || "audit",
      ...(subjectRef ? { subjectRef } : {}),
      ...(deliveredTo ? { deliveredTo } : {}),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to })
    };
  } else {
    // The cutoff is never sent: apps/api derives it from the tenant's policy and
    // the floor, so a purge window is not something a browser gets to choose.
    payload = { policyKey: text(form, "policyKey") || "messages", dryRun: text(form, "confirm") !== "purge" };
  }

  try {
    const result = await api<Screening | Bundle | RetentionResult>(RUNS[kind].endpoint, {
      env,
      request,
      method: "POST",
      body: payload
    });
    if (kind === "screening") return { kind, problem: null, screening: result as Screening };
    if (kind === "evidence") return { kind, problem: null, bundle: result as Bundle };
    return { kind, problem: null, retention: result as RetentionResult };
  } catch (error) {
    // Only what the API said. Nothing on this screen claims a run that did not
    // happen, and a failed run has already been refused server-side.
    if (error instanceof ApiError) return { kind, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------------- view */

export default function ComplianceRun() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelIn(locale);
  const busy = navigation.state !== "idle";
  const fresh = result && result.kind === loaded.kind ? result : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4">
        <h1 className="page-title">{l("title")}</h1>
        {loaded.allowed.length > 1 ? (
          <nav aria-label={l("title")}>
            <ul className="flex flex-wrap gap-1">
              {loaded.allowed.map((key) => {
                const current = key === loaded.kind;
                return (
                  <li key={key}>
                    <Link
                      to={`/compliance/run/${key}`}
                      aria-current={current ? "page" : undefined}
                      className={[
                        "inline-flex h-8 items-center rounded-md px-3 font-ui text-13",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                        current ? "bg-surface-2 text-text" : "text-subtle hover:bg-surface-2 hover:text-text"
                      ].join(" ")}
                    >
                      {l(`run.${key}`)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        ) : null}
        <p className="max-w-prose font-ui text-13 text-muted">
          {runHeadline(fresh, l) ?? l(`intro.${loaded.kind}`)}
        </p>
      </header>

      {loaded.denied ? (
        <EmptyState title={l("denied.title")} body={l("denied.body")} />
      ) : (
        <>
          <Form method="post" aria-label={l(`run.${loaded.kind}`)} className="flex flex-wrap items-end gap-3">
            {loaded.kind === "screening" ? (
              <ScreeningFields l={l} customers={loaded.customers} />
            ) : null}
            {loaded.kind === "evidence" ? <EvidenceFields l={l} /> : null}
            {loaded.kind === "retention" ? <RetentionFields l={l} /> : null}
            <Button type="submit" loading={busy}>
              {l(`action.${loaded.kind}`)}
            </Button>
          </Form>

          {fresh?.problem ? (
            <div role="alert" className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/10 p-4">
              <p className="section-title">{l("problem")}</p>
              <p className="max-w-prose font-ui text-13 text-muted">
                {fresh.problem.detail ?? fresh.problem.title}
              </p>
              <RequestId id={fresh.problem.requestId} />
            </div>
          ) : null}

          {fresh && !fresh.problem && fresh.kind === "screening" ? (
            <ScreeningResult screening={fresh.screening} locale={locale} l={l} />
          ) : null}
          {fresh && !fresh.problem && fresh.kind === "evidence" ? (
            <BundleResult bundle={fresh.bundle} apiOrigin={loaded.apiOrigin} locale={locale} l={l} />
          ) : null}
          {fresh && !fresh.problem && fresh.kind === "retention" ? (
            <RetentionResultView result={fresh.retention} locale={locale} l={l} busy={busy} />
          ) : null}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- forms */

function options(values: readonly string[], l: Label, prefix = ""): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: l(`${prefix}${value}`) === `${prefix}${value}` ? value : l(`${prefix}${value}`) }));
}

function ScreeningFields({ l, customers }: { l: Label; customers: RefOption[] }) {
  return (
    <>
      <Field label={l("field.subject")} hint={l("hint.subject")} className="w-64">
        <Input name="subject" maxLength={200} />
      </Field>
      <Field label={l("field.customerId")} hint={l("hint.customerId")} className="w-56">
        <RefPicker name="customerId" options={customers} placeholder={l("placeholder.customer")} />
      </Field>
      <Field label={l("field.kind")} className="w-52">
        <Select name="kind" defaultValue="sanctions" options={options(SCREENING_KINDS, l, "kind.")} />
      </Field>
    </>
  );
}

function EvidenceFields({ l }: { l: Label }) {
  return (
    <>
      <Field label={l("field.purpose")} className="w-48">
        <Select name="purpose" defaultValue="regulator" options={options(PURPOSES, l, "purpose.")} />
      </Field>
      <Field label={l("field.subjectRef")} hint={l("hint.subjectRef")} className="w-64">
        <Input name="subjectRef" maxLength={200} />
      </Field>
      <Field label={l("field.from")} className="w-44">
        <DatePicker name="from" />
      </Field>
      <Field label={l("field.to")} className="w-44">
        <DatePicker name="to" />
      </Field>
      <Field label={l("field.deliveredTo")} hint={l("hint.deliveredTo")} className="w-56">
        <Input name="deliveredTo" maxLength={200} />
      </Field>
    </>
  );
}

function RetentionFields({ l }: { l: Label }) {
  return (
    <Field label={l("field.policyKey")} className="w-56">
      <Select name="policyKey" defaultValue="messages" options={options(POLICY_KEYS, l, "class.")} />
    </Field>
  );
}

/* ------------------------------------------------------------------ results */

/** A hash is long, and a hash that overflows its container is a hash nobody can
 *  copy. It wraps, in a monospace face, wherever it appears. */
function Hash({ value }: { value: string }) {
  return <span className="break-all font-mono text-12 text-text">{value}</span>;
}

function Facts({ rows }: { rows: Array<{ label: string; value: React.ReactNode; hint?: string }> }) {
  return (
    <dl className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-col gap-1">
          <dt className="font-ui text-12 text-subtle">{row.label}</dt>
          <dd className="font-ui text-14 text-text">{row.value}</dd>
          {row.hint ? <p className="max-w-prose font-ui text-12 text-muted">{row.hint}</p> : null}
        </div>
      ))}
    </dl>
  );
}

function ScreeningResult({ screening, locale, l }: { screening: Screening; locale: string; l: Label }) {
  const tone = screening.result === "hit" ? "danger" : screening.result === "clear" ? "success" : "warning";
  const columns: Array<Column<ScreeningHit>> = [
    { key: "listRef", header: l("col.listRef"), render: (hit) => <span className="font-mono text-12">{hit.listRef}</span> },
    { key: "matchedName", header: l("col.matchedName"), render: (hit) => hit.matchedName },
    { key: "matchPct", header: l("col.matchPct"), numeric: true, render: (hit) => `${hit.matchPct}%` },
    { key: "note", header: l("col.note"), render: (hit) => <span className="text-muted">{hit.note}</span> }
  ];

  return (
    <section className="flex flex-col gap-4">
      {/* Said before the result is read, not after: a "clear" nobody qualifies
          is the one thing this screen must never imply. */}
      <div role="note" className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 p-4">
        <p className="section-title">{l("stub.title")}</p>
        <p className="max-w-prose font-ui text-13 text-muted">{l("stub.body")}</p>
      </div>

      <Card title={l("result.screening")}>
        <Facts
          rows={[
            {
              label: l("result.screening"),
              value: (
                <Badge tone={tone} dot>
                  {l(`result.${screening.result}`)}
                </Badge>
              )
            },
            { label: l("subject"), value: <Ref value={screening.subjectRef} className="text-12" /> },
            { label: l("provider"), value: screening.provider },
            { label: l("queryHash"), value: <Hash value={screening.queryHash} />, hint: l("queryHash.hint") },
            { label: l("when"), value: <DateTime value={screening.ts} locale={locale} precision="minute" /> }
          ]}
        />
      </Card>

      {screening.blocked ? (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-danger/40 bg-danger/10 p-4">
          <p className="section-title">{l("blocked")}</p>
          <p className="max-w-prose font-ui text-13 text-muted">{l("blocked.body")}</p>
        </div>
      ) : null}

      <Table
        columns={columns}
        rows={screening.hits}
        rowKey={(hit) => `${hit.listRef}|${hit.matchedName}`}
        caption={l("hits")}
        density="compact"
        empty={<EmptyState title={l("hits")} body={l("empty.hits")} />}
      />
    </section>
  );
}

function BundleResult({
  bundle,
  apiOrigin,
  locale,
  l
}: {
  bundle: Bundle;
  apiOrigin: string;
  locale: string;
  l: Label;
}) {
  const columns: Array<Column<ManifestFile>> = [
    { key: "path", header: l("col.path"), render: (file) => <span className="font-mono text-12">{file.path}</span> },
    {
      key: "size",
      header: l("col.size"),
      numeric: true,
      render: (file) => new Intl.NumberFormat(locale).format(file.sizeBytes)
    },
    { key: "sha256", header: l("col.sha256"), render: (file) => <Hash value={file.sha256} /> }
  ];

  return (
    <section className="flex flex-col gap-4">
      <Card title={l("result.evidence")}>
        <Facts
          rows={[
            {
              label: l("result.evidence"),
              value: (
                <Badge tone={bundle.state === "ready" ? "success" : "danger"} dot>
                  {l(`state.${bundle.state}`)}
                </Badge>
              )
            },
            { label: l("bundleHash"), value: <Hash value={bundle.bundleHash} />, hint: l("bundleHash.hint") },
            { label: l("field.purpose"), value: bundle.purpose },
            ...(bundle.deliveredTo ? [{ label: l("field.deliveredTo"), value: bundle.deliveredTo }] : []),
            { label: l("when"), value: <DateTime value={bundle.createdAt} locale={locale} precision="minute" /> }
          ]}
        />
      </Card>

      {bundle.state === "ready" ? (
        <div>
          <Button asChild variant="secondary">
            {/* Straight to the API: the archive is the evidence and it does not
                get copied through a second process on the way out. */}
            <a href={`${apiOrigin}/v1/compliance/evidence-bundles/${bundle.id}/download`} rel="noopener" download>
              {l("download")}
            </a>
          </Button>
        </div>
      ) : (
        <p role="alert" className="max-w-prose font-ui text-13 text-danger">
          {l("bundle.failed")}
        </p>
      )}

      {bundle.manifest.truncated ? (
        <p role="status" className="max-w-prose rounded-md border border-warning/40 bg-warning/10 p-3 font-ui text-13 text-text">
          {l("truncated")}
        </p>
      ) : null}

      <Table
        columns={columns}
        rows={bundle.manifest.files}
        rowKey={(file) => file.path}
        caption={l("result.evidence")}
        density="compact"
        empty={<EmptyState title={l("result.evidenceEmpty")} body={l("result.evidenceEmpty.body")} />}
      />
    </section>
  );
}

function RetentionResultView({
  result,
  locale,
  l,
  busy
}: {
  result: RetentionResult;
  locale: string;
  l: Label;
  busy: boolean;
}) {
  const planned = result.dryRun === true;
  return (
    <section className="flex flex-col gap-4">
      <Card title={planned ? l("result.retention.plan") : l("result.retention.run")}>
        <Facts
          rows={[
            { label: l("tableName"), value: <span className="font-mono text-12">{result.tableName}</span> },
            {
              label: l("cutoffAt"),
              value: <DateTime value={result.cutoffAt} locale={locale} precision="day" />,
              hint: l("cutoffAt.hint")
            },
            ...(result.retentionMonths
              ? [{ label: l("retentionMonths"), value: `${result.retentionMonths} ${l("months")}` }]
              : []),
            {
              label: planned ? l("rowsAffected") : l("rowsAffectedDone"),
              value: <span className="tabular-nums">{result.rowsAffected}</span>
            },
            { label: l("rowsHeld"), value: <span className="tabular-nums">{result.rowsHeld}</span> }
          ]}
        />
      </Card>

      {result.more ? (
        <p role="status" className="max-w-prose rounded-md border border-warning/40 bg-warning/10 p-3 font-ui text-13 text-text">
          {l("more")}
        </p>
      ) : null}

      {planned && result.rowsAffected > 0 ? (
        // The second step, and the only one that deletes. It carries the count
        // it was planned against, so nobody presses it having read a different
        // number — and it is a separate submit, never a checkbox on the first.
        <Form
          method="post"
          className="flex flex-col gap-2 rounded-lg border border-danger/40 bg-danger/10 p-4"
          aria-label={l("purge.title")}
        >
          <p className="section-title">{l("purge.title")}</p>
          <p className="max-w-prose font-ui text-13 text-muted">{l("purge.body")}</p>
          <input type="hidden" name="policyKey" value={result.policyKey} />
          <input type="hidden" name="confirm" value="purge" />
          <div>
            <Button type="submit" variant="danger" loading={busy}>
              {l("action.purge")}
            </Button>
          </div>
        </Form>
      ) : null}
    </section>
  );
}

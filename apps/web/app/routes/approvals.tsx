import { useState, type ReactNode } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AGENT_MARK,
  Badge,
  Button,
  Card,
  DateTime,
  EmptyState,
  Field,
  Money,
  Select,
  Textarea
} from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import { toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { asJson } from "../json.js";
import { moduleName, translator, type Translate } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { WORKSPACES } from "../modules";
import { humanise } from "../modules/spec";
import { policyTitle } from "../policy";
import { labelsFrom, type Label } from "./detail-kit";
import { ShiftClear } from "../components/shift-clear";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { who, type Names } from "../names";

// The human-in-the-loop queue (CLAUDE.md §4). Everything consequential the
// platform tried to do and could not do alone lands here: one card per request,
// the rule that stopped it, and two buttons. Nothing on this screen decides
// anything by itself — the decision is a POST, and what renders afterwards is
// whatever the API said came back.

/** Mirrors packages/core/src/approvals.ts. The web app cannot import @lyra/core. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const STATES = ["pending", "approved", "rejected"] as const;
type State = (typeof STATES)[number];

/** Context keys rendered as their own field; the rest are the "why" list. */
// `resume`/`completedAt` are the kept request and its finish time (core
// approvals `rememberRequest`) — machinery, not a reason to decide.
const OWN_FIELD = new Set(["amountMinor", "currency", "dualControl", "expiresAt", "resume", "completedAt"]);

interface ApprovalRow {
  id: string;
  subjectRef: string;
  policyKey: string;
  module: string;
  requestedBy: string;
  requestedAt: number;
  decidedBy: string | null;
  decision: string;
  reason: string | null;
  /** A string from /v1/me/inbox, already parsed by the CRUD list. Take both. */
  contextJson: string | Record<string, unknown> | null;
  decidedAt: number | null;
}

interface AiRun {
  id: string;
  agentKey: string;
  approvalId: string | null;
}

/** A malformed context is a data bug. Losing it must not lose the approval. */
function contextOf(row: ApprovalRow): Record<string, unknown> {
  return asJson<Record<string, unknown>>(row.contextJson, {});
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * `subjectRef` is `<resource>:<rowId>` for a change to a record and
 * `<resource>:new:<hash>` for one that would create it (apps/api/src/crud.ts).
 * The resource is the API's own path segment, which is exactly the last segment
 * of a spec's `api` — so the record route can be rebuilt from it. Anything that
 * does not resolve stays plain text: a link that 404s is worse than none.
 */
/**
 * A context key as the approver reads it: this screen's own word when it has
 * one (`why.<key>`), else the key said as words — never `requestedAmountMinor`
 * uppercased by the term style.
 */
export function contextTerm(key: string, l: (key: string) => string): string {
  const own = l(`why.${key}`);
  return own === `why.${key}` ? humanise(key.replace(/Minor$/, "")) : own;
}

export function subjectOf(subjectRef: string): { text: string; href: string | null; unborn: boolean } {
  const first = subjectRef.indexOf(":");
  if (first < 0) return { text: subjectRef, href: null, unborn: false };
  const resource = subjectRef.slice(0, first);
  const rest = subjectRef.slice(first + 1);
  if (rest.startsWith("new:")) return { text: resource, href: null, unborn: true };

  for (const workspace of WORKSPACES) {
    for (const tab of workspace.tabs) {
      if (tab.api.endsWith(`/${resource}`)) {
        return {
          text: rest,
          href: `/${workspace.path}/${tab.key}/${encodeURIComponent(rest)}`,
          unborn: false
        };
      }
    }
  }
  // A hand-written engine (dist, ledger) names subjects its own way, and those
  // have no generic record screen to point at. Said as words rather than as the
  // stored ref: `ai_budget:signal` is "AI budget signal" on a screen, not a
  // colon-joined key a reader has to decode.
  return { text: `${humanise(resource)} ${rest}`, href: null, unborn: false };
}

/** A panel the actor may not read is missing, not fatal. 401 is the session's
 *  business and stays thrown, so the layout can send them to sign in. */
async function soft<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) return null;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const state: State = STATES.find((s) => s === url.searchParams.get("state")) ?? "pending";
  const cursor = url.searchParams.get("cursor") ?? "";

  // /v1/me a second time: the layout keeps neither the tenant's base currency
  // nor the raw permission list, and an amount rendered without its currency is
  // not money (docs/22 §5.1).
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const baseCurrency = typeof me.policy.currency === "string" ? me.policy.currency : null;
  const canReadDecided = held.has("core:approvals:read");

  let rows: ApprovalRow[] = [];
  let next: string | null = null;
  let readable = true;

  if (state === "pending") {
    // The inbox is the only endpoint that answers "waiting for THIS actor": it
    // keeps the rows whose policy names a permission this actor holds. The CRUD
    // list would hand back every pending row in the tenant instead.
    const inbox = await soft(api<{ approvals: ApprovalRow[] }>("/v1/me/inbox", { env, request }));
    readable = inbox !== null;
    rows = inbox?.approvals ?? [];
  } else if (canReadDecided) {
    const page = await soft(
      api<{ data: ApprovalRow[]; cursor?: string }>(
        `/v1/core/approvals?decision=${state}&sort=requestedAt&order=desc&limit=25` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        { env, request }
      )
    );
    readable = page !== null;
    rows = page?.data ?? [];
    next = page?.cursor ?? null;
  } else {
    // Asked for a state this actor cannot read — by typing the query string, or
    // by holding the permission when the page loaded and losing it since.
    readable = false;
  }

  // Which of these an agent produced, in one call rather than one per row: the
  // list filter takes a comma-separated set as an OR. A refusal here costs the
  // run link and nothing else, so it must not cost the queue.
  const runs: Record<string, { id: string; agentKey: string }> = {};
  if (rows.length && held.has("ai:runs:read")) {
    const ids = rows.map((row) => row.id).join(",");
    const page = await soft(
      api<{ data: AiRun[] }>(
        `/v1/ai/runs?approvalId=${encodeURIComponent(ids)}&limit=${rows.length}`,
        { env, request }
      )
    );
    for (const run of page?.data ?? []) {
      if (run.approvalId) runs[run.approvalId] = { id: run.id, agentKey: run.agentKey };
    }
  }

  // `${kind}:${id}`, exactly as packages/core/src/approvals.ts writes it into
  // `requestedBy` — so "did I raise this?" is a string comparison and not a guess.
  const actorRef = `${me.actor.kind}:${me.actor.id}`;

  const items = rows.map((row) => {
    const ctx = contextOf(row);
    return {
      id: row.id,
      subject: subjectOf(row.subjectRef),
      /** Dual control refuses a decision by the initiator. Saying so before the
       *  press beats a 400 after it. */
      selfRaised: row.requestedBy === actorRef,
      policyKey: row.policyKey,
      module: row.module,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      decision: row.decision,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      reason: row.reason,
      amountMinor: typeof ctx.amountMinor === "number" ? ctx.amountMinor : null,
      currency: typeof ctx.currency === "string" ? ctx.currency : baseCurrency,
      dualControl: ctx.dualControl === true,
      /**
       * core_approvals has no expiry column. What lapses is the authority a
       * decision grants: `gate()` re-asks once a decision is older than
       * APPROVAL_TTL_MS. A pending request does not lapse, so it shows no
       * deadline rather than a countdown we would be inventing.
       */
      expiresAt:
        typeof ctx.expiresAt === "number"
          ? ctx.expiresAt
          : row.decidedAt
            ? row.decidedAt + APPROVAL_TTL_MS
            : null,
      // The rule's own detail — thresholds, the quoted reason, what changed.
      // Whatever the gate recorded is what the approver gets to read.
      why: Object.entries(ctx)
        .filter(([key]) => !OWN_FIELD.has(key))
        .map(([key, value]) => ({
          key,
          text: display(value),
          minor: key.endsWith("Minor") && typeof value === "number" ? value : null
        })),
      // An agent-raised request is marked even when the actor cannot open the
      // run: the ✦ comes from who asked, the link from the run lookup.
      agentRaised: row.requestedBy.startsWith("agent:") || Boolean(runs[row.id]),
      run: runs[row.id] ?? null
    };
  });

  // What this reader asked for, somebody approved, and is theirs to finish —
  // one press instead of finding the screen and typing it all again.
  const readyRows = (await soft(api<{ data: ApprovalRow[] }>("/v1/me/approvals/ready", { env, request })))?.data ?? [];
  const ready = readyRows.map((row) => ({
    id: row.id,
    policyKey: row.policyKey,
    module: row.module,
    subject: subjectOf(row.subjectRef),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt
  }));

  // Who raised it and who decided it are `${kind}:${id}` refs, which rendered
  // as ULIDs at the one person on the platform whose job is to judge them.
  const resolved = await names(
    [...rows, ...readyRows].flatMap((row) => [row.requestedBy, row.decidedBy]),
    { env, request }
  );

  return { state, items, cursor: next, canReadDecided, readable, resolved, ready };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const reason = String(form.get("reason") ?? "").trim();

  if (id && intent === "finish") {
    try {
      await api(`/v1/me/approvals/${encodeURIComponent(id)}/finish`, { env, request, method: "POST" });
      return { id, problem: null, decided: null, finished: id };
    } catch (error) {
      if (error instanceof ApiError) return { id, problem: error.problem, decided: null };
      throw error;
    }
  }

  if (!id || (intent !== "approve" && intent !== "reject")) {
    return { id, problem: { title: "unknown intent", status: 400 }, decided: null };
  }

  try {
    // The single decision endpoint. Permission, dual control, the rejection
    // reason rule and the audit row all live behind it — this posts one
    // approval at a time because that is all the API offers, and a bulk
    // decision this screen faked would be a decision nobody made.
    const row = await api<ApprovalRow>(`/v1/me/approvals/${encodeURIComponent(id)}/decide`, {
      env,
      request,
      method: "POST",
      body: {
        decision: intent === "approve" ? "approved" : "rejected",
        ...(reason ? { reason } : {})
      }
    });
    // Only what came back is reported. A decision is irreversible, so the
    // screen never claims one the API has not confirmed.
    return { id, problem: null, decided: { id: row.id, decision: row.decision } };
  } catch (error) {
    if (error instanceof ApiError) return { id, problem: error.problem, decided: null };
    throw error;
  }
}

/**
 * This screen owns its strings: the shared catalogue in app/i18n belongs to
 * another surface, and a queue that only exists here has no business widening
 * it. Same discipline as the catalogue — no literal reaches the markup.
 */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Approvals",
    intro:
      "Actions that need a person before they take effect. A decision is final and is written to the audit log.",
    state: "State",
    "state.pending": "Awaiting decision",
    "state.rejected": "Rejected",
    queue: "Requests",
    jump: "Requests by area",
    rule: "Rule",
    module: "Area",
    subject: "Subject",
    requestedBy: "Requested by",
    requested: "Requested",
    amount: "Amount",
    expires: "Authority expires",
    expiresOnDecision: "Set when decided",
    why: "Why this needs approval",
    control: "Approvers",
    dualControl: "Two people: whoever raised this may not decide it.",
    singleControl: "One approver.",
    reason: "Reason",
    reasonHint: "Required to reject, kept with the decision in the audit log.",
    reasonRequired: "Say why you are rejecting this.",
    approve: "Approve",
    reject: "Reject",
    confirmReject: "Reject this request? A decision cannot be undone.",
    decidedBy: "Decided by",
    decidedAt: "Decided",
    agent: "Raised by an agent",
    openRun: "Open the run",
    openRecord: "Open the record",
    subjectNew: "No record yet — once approved, the person who asked finishes it with one press.",
    readyTitle: "Approved — ready for you to finish",
    readyBody: "Somebody approved what you asked for. Finishing sends it exactly as you entered it; the checks run again.",
    readyBy: "Approved by {who}",
    finish: "Finish",
    finished: "Done — it went through.",
    selfRaised: "You raised this request, and this rule needs a second person to decide it.",
    noPermission: "Decisions across the tenant are not yours to read, so this list stays empty.",
    unavailable: "The queue could not be read just now.",
    emptyDecided: "No decisions in this state yet.",
    clearEyebrow: "Shift clear",
    clearHead: "Nothing is waiting on you.",
    clearBody:
      "Every request that needed your decision has one. Anything raised from here — by a person or by an agent — lands on this screen the moment it is raised, and the rail keeps the count while you work elsewhere.",
    clearAfter: "A decision is final and is kept in the audit log, so an empty queue is a closed day, not a cleared one.",
    figCleared: "Decided today",
    figWaiting: "Still waiting",
    figNotices: "Notices",
    clearDecided: "See what you decided",
    announceApproved: "Approved. The action may now proceed.",
    announceRejected: "Rejected. The action will not proceed.",
    "headline.unavailable": "This queue could not be read just now.",
    "headline.pending": "{count} waiting on a decision.",
    "headline.decided": "{count} decisions marked {state}."
  },
  ar: {
    title: "الموافقات",
    intro: "إجراءات تحتاج قرار شخص قبل تنفيذها. القرار نهائي ويُسجَّل في سجل التدقيق.",
    state: "الحالة",
    "state.pending": "بانتظار القرار",
    "state.rejected": "مرفوض",
    queue: "الطلبات",
    jump: "الطلبات حسب المجال",
    rule: "القاعدة",
    module: "المجال",
    subject: "الموضوع",
    requestedBy: "طلبها",
    requested: "تاريخ الطلب",
    amount: "المبلغ",
    expires: "تنتهي الصلاحية",
    expiresOnDecision: "تُحدَّد عند القرار",
    why: "سبب طلب الموافقة",
    control: "الموافقون",
    dualControl: "شخصان: لا يجوز لمن طلبها أن يقرّرها.",
    singleControl: "موافق واحد.",
    reason: "السبب",
    reasonHint: "مطلوب عند الرفض، ويُحفظ مع القرار في سجل التدقيق.",
    reasonRequired: "اذكر سبب الرفض.",
    approve: "الموافقة",
    reject: "الرفض",
    confirmReject: "هل تريد رفض هذا الطلب؟ لا يمكن التراجع عن القرار.",
    decidedBy: "قرّرها",
    decidedAt: "تاريخ القرار",
    agent: "طلبها وكيل ذكاء اصطناعي",
    openRun: "فتح سجل التشغيل",
    openRecord: "فتح السجل",
    subjectNew: "لا يوجد سجل بعد — بعد الموافقة يُكمله صاحب الطلب بضغطة واحدة.",
    readyTitle: "تمت الموافقة — جاهز لتُكمله",
    readyBody: "وافق أحدهم على ما طلبته. الإكمال يرسله تمامًا كما أدخلته، وتُعاد الفحوص.",
    readyBy: "وافق عليه {who}",
    finish: "إكمال",
    finished: "تم — نُفِّذ الطلب.",
    selfRaised: "أنت من طلب هذا، وهذه القاعدة تتطلب شخصًا ثانيًا ليقرّر.",
    noPermission: "قرارات المؤسسة ليست من صلاحيتك للاطلاع، لذلك تبقى هذه القائمة فارغة.",
    unavailable: "تعذّرت قراءة قائمة الطلبات الآن.",
    emptyDecided: "لا قرارات في هذه الحالة بعد.",
    clearEyebrow: "انتهت النوبة",
    clearHead: "لا شيء بانتظارك.",
    clearBody:
      "كل طلب كان يحتاج قرارك صار له قرار. وأي طلب جديد — من شخص أو من وكيل ذكاء اصطناعي — يظهر على هذه الشاشة فور رفعه، والشريط الجانبي يعرض العدد بينما تعمل في مكان آخر.",
    clearAfter: "القرار نهائي ويُحفظ في سجل التدقيق، فالقائمة الفارغة تعني يومًا مغلقًا لا يومًا مؤجلًا.",
    figCleared: "قرارات اليوم",
    figWaiting: "قيد الانتظار",
    figNotices: "الإشعارات",
    clearDecided: "اطّلع على قراراتك",
    announceApproved: "تمت الموافقة. يمكن تنفيذ الإجراء الآن.",
    announceRejected: "تم الرفض. لن يُنفَّذ الإجراء.",
    "headline.unavailable": "تعذّرت قراءة قائمة الطلبات الآن.",
    "headline.pending": "{count} بانتظار القرار.",
    "headline.decided": "{count} قرار بحالة {state}."
  }
};

/**
 * The hero lede: one true count, nothing invented. `readable` covers both the
 * "not my permission" and "the API refused" cases the loader already folds
 * together — the queue has one honest thing to say either way. An empty,
 * readable queue keeps the screen's own intro; `ShiftClear` below is where the
 * good news actually gets said.
 */
export function approvalsHeadline(state: State, count: number, readable: boolean, l: Label): string {
  if (!readable) return l("headline.unavailable");
  if (count === 0) return l("intro");
  return state === "pending"
    ? l("headline.pending", { count: String(count) })
    : l("headline.decided", { count: String(count), state: l(`state.${state}`) });
}

// Hand-rolling `LABELS[locale] ?? LABELS.en` skips the shared catalogue, so a
// state this screen never wrote down — `state.approved`, which SHARED says —
// reached the filter dropdown as a bare key (docs/ui.md §7 P3-14).
export const labelsIn = labelsFrom(LABELS);

export default function Approvals() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const deciding = navigation.formData?.get("id");
  const items = loaded.items;
  // Arabic reads Eastern Arabic digits; a figure printed with String() would not.
  const count = (value: number) => new Intl.NumberFormat(locale).format(value);
  // One group per area, in the order the queue already lists them, so the
  // jump list at the top reads as the queue's own table of contents.
  const groups = [...new Set(items.map((item) => item.module))].map((module) => ({
    module,
    items: items.filter((item) => item.module === module)
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">
          {approvalsHeadline(loaded.state, items.length, loaded.readable, l)}
        </p>
      </header>

      {result && "finished" in result && result.finished ? (
        <p role="status" className="rounded-md border border-success/40 bg-success/10 px-3 py-2 font-ui text-13 text-text">
          {l("finished")}
        </p>
      ) : null}

      {loaded.ready.length ? (
        <Card title={l("readyTitle")} description={l("readyBody")}>
          <ul className="flex flex-col divide-y divide-border">
            {loaded.ready.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-ui text-14 text-text">{policyTitle(row.policyKey, row.module, locale)}</span>
                  <span className="font-ui text-12 text-subtle">
                    {row.subject.text}
                    {row.decidedBy ? ` · ${l("readyBy").replace("{who}", who(row.decidedBy, loaded.resolved) ?? row.decidedBy)}` : ""}
                  </span>
                </div>
                <Form method="post">
                  <input type="hidden" name="id" value={row.id} />
                  <Button type="submit" name="intent" value="finish" loading={busy && deciding === row.id}>
                    {l("finish")}
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Form method="get" className="flex flex-wrap items-center gap-2">
        <Select
          name="state"
          className="w-auto min-w-48"
          aria-label={l("state")}
          defaultValue={loaded.state}
          options={STATES.filter(
            // Decided rows come from the tenant-wide list, which is gated. An
            // option that can only 403 is not offered.
            (state) => state === "pending" || loaded.canReadDecided
          ).map((state) => ({ value: state, label: l(`state.${state}`) }))}
        />
        <Button type="submit" variant="secondary" loading={busy}>
          {t("common.apply")}
        </Button>
        {searchParams.get("state") || searchParams.get("cursor") ? (
          <Button asChild variant="ghost">
            <Link to="/approvals">{t("common.clear")}</Link>
          </Button>
        ) : null}
      </Form>

      {/* The confirmed outcome, announced once the API has answered. */}
      <p role="status" aria-live="polite" className="font-ui text-13 text-success">
        {result?.decided
          ? result.decided.decision === "approved"
            ? l("announceApproved")
            : l("announceRejected")
          : ""}
      </p>

      {/* A refusal belongs beside the request it refused; this catches only the
          orphan — a decision on a row that is no longer in the list. */}
      {result?.problem && !items.some((item) => item.id === result.id) ? (
        <Problem problem={result.problem} />
      ) : null}

      {items.length === 0 && loaded.readable && loaded.state === "pending" ? (
        // The one empty list on the platform that is an achievement.
        <ShiftClear
          eyebrow={l("clearEyebrow")}
          head={l("clearHead")}
          body={l("clearBody")}
          after={l("clearAfter")}
          figures={
            shell?.inbox
              ? [
                  { label: l("figCleared"), value: count(shell.inbox.counts.clearedToday) },
                  { label: l("figWaiting"), value: count(shell.inbox.counts.approvals) },
                  { label: l("figNotices"), value: count(shell.inbox.counts.notifications) }
                ]
              : []
          }
        >
          {loaded.canReadDecided ? (
            <Button asChild variant="secondary">
              <Link to="/approvals?state=approved">{l("clearDecided")}</Link>
            </Button>
          ) : null}
        </ShiftClear>
      ) : items.length === 0 ? (
        <EmptyState
          title={t("common.empty.title")}
          body={
            // A readable, empty pending queue never reaches here — it is the
            // shift-clear screen above.
            !loaded.readable
              ? loaded.state === "pending"
                ? l("unavailable")
                : l("noPermission")
              : l("emptyDecided")
          }
        />
      ) : (
        <>
          {/* A queue is several screens tall once a few areas are waiting, so
              it opens on its own contents: each area, how many, and a jump to
              it. */}
          <nav aria-label={l("jump")}>
            <ul className="flex flex-wrap gap-2">
              {groups.map((group) => (
                <li key={group.module}>
                  <a
                    href={`#area-${group.module}`}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-border px-3 font-ui text-13 text-text hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {moduleName(t, group.module)}
                    <span className="font-mono text-12 tabular-nums text-subtle">{count(group.items.length)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          {/* One list per area, each named "Requests — <area>": the items of
              every list are requests and nothing else, so a count of them is
              a count of what is waiting. */}
          <div className="flex flex-col gap-6">
            {groups.map((group) => (
              <section
                key={group.module}
                id={`area-${group.module}`}
                aria-labelledby={`area-${group.module}-title`}
                className="flex scroll-mt-4 flex-col gap-3"
              >
                <h2 id={`area-${group.module}-title`} className="flex items-center gap-2 font-ui text-14 text-text">
                  {moduleName(t, group.module)}
                  <span className="font-mono text-12 tabular-nums text-subtle">{count(group.items.length)}</span>
                </h2>
                <ul aria-label={`${l("queue")} — ${moduleName(t, group.module)}`} className="flex flex-col gap-3">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <ApprovalCard
                        item={item}
                        locale={locale}
                        l={l}
                        t={t}
                        busy={busy}
                        deciding={deciding}
                        resolved={loaded.resolved}
                        problem={result?.id === item.id ? (result.problem ?? null) : null}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </>
      )}

      <div className="flex justify-between gap-2">
        <span className="font-ui text-12 tabular-nums text-subtle">
          {t("common.rows", { count: String(items.length) })}
        </span>
        {loaded.cursor ? (
          <Button asChild variant="secondary" size="sm">
            <Link to={`?state=${loaded.state}&cursor=${encodeURIComponent(loaded.cursor)}`}>
              {t("common.next")}
            </Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

type Item = Awaited<ReturnType<typeof loader>>["items"][number];

// Said in one place (app/policy.ts) because the shell's shift rail says it too;
// re-exported here so the screens that already read it from this route keep
// working.
export { policyTitle };

function ApprovalCard({
  item,
  locale,
  l,
  t,
  busy,
  deciding,
  resolved,
  problem
}: {
  item: Item;
  locale: string;
  l: (key: string) => string;
  t: Translate;
  busy: boolean;
  deciding: FormDataEntryValue | null | undefined;
  resolved: Names;
  problem: { title: string; detail?: string } | null;
}) {
  const pending = item.decision === "pending";
  const mine = deciding === item.id;
  // Dual control refuses the initiator's own decision (packages/core §decide).
  // The buttons go, the evidence stays: they still need to read it to know who
  // to chase.
  const blocked = pending && item.dualControl && item.selfRaised;
  const [reason, setReason] = useState("");
  const [needsReason, setNeedsReason] = useState(false);

  return (
    <Card
      elevation="flat"
      title={policyTitle(item.policyKey, item.module, locale)}
      description={item.subject.text}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {item.agentRaised ? (
            // The single ✦ (docs/01 §7). ponytail: AgentBadge carries its own
            // English copy, so the marker is used with a label from the table
            // above rather than shipping "AI-generated" into an Arabic page.
            <Badge tone="accent" size="sm">
              <span aria-hidden="true">{AGENT_MARK}</span>
              <span>{l("agent")}</span>
            </Badge>
          ) : null}
          <Badge tone={toneFor(item.decision)} size="sm" dot>
            {l(`state.${item.decision}`)}
          </Badge>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <Entry term={l("module")}>{moduleName(t, item.module)}</Entry>
          {/* What is actually being changed. A create has no row to open yet,
              and a hand-written engine's subject has no generic screen — both
              say so rather than offering a link that goes nowhere. */}
          <Entry term={l("subject")}>
            {item.subject.unborn ? (
              <span className="text-subtle">{l("subjectNew")}</span>
            ) : item.subject.href ? (
              <Link
                to={item.subject.href}
                className="font-mono text-12 break-all text-accent underline-offset-2 hover:underline"
              >
                {item.subject.text}
              </Link>
            ) : (
              <span className="font-mono text-12 break-all">{item.subject.text}</span>
            )}
          </Entry>
          <Entry term={l("requestedBy")}>
            <span>{who(item.requestedBy, resolved)}</span>
          </Entry>
          <Entry term={l("amount")}>
            {item.amountMinor === null ? (
              "—"
            ) : item.currency ? (
              <Money amountMinor={item.amountMinor} currency={item.currency} locale={locale} />
            ) : (
              // No currency anywhere is a gap in the request, not a licence to
              // print a bare number as money (docs/22 §5.1).
              <span className="tabular-nums">{item.amountMinor}</span>
            )}
          </Entry>
          <Entry term={l("requested")}>
            <DateTime value={item.requestedAt} locale={locale} precision="minute" />
          </Entry>
          <Entry term={l("expires")}>
            {item.expiresAt === null ? (
              l("expiresOnDecision")
            ) : (
              <DateTime value={item.expiresAt} locale={locale} precision="minute" />
            )}
          </Entry>
          <Entry term={l("control")}>
            {item.dualControl ? l("dualControl") : l("singleControl")}
          </Entry>
          {item.decidedBy ? (
            <Entry term={l("decidedBy")}>
              <span>{who(item.decidedBy, resolved)}</span>
            </Entry>
          ) : null}
          {item.decidedAt ? (
            <Entry term={l("decidedAt")}>
              <DateTime value={item.decidedAt} locale={locale} precision="minute" />
            </Entry>
          ) : null}
          {item.reason ? <Entry term={l("reason")}>{item.reason}</Entry> : null}
        </dl>

        {item.why.length ? (
          <section className="rounded-md border border-border bg-surface-2 p-3">
            <h3 className="font-ui text-12 text-subtle">{l("why")}</h3>
            <dl className="mt-2 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
              {item.why.map((entry) => (
                <Entry key={entry.key} term={contextTerm(entry.key, l)}>
                  {entry.minor !== null && item.currency ? (
                    <Money amountMinor={entry.minor} currency={item.currency} locale={locale} />
                  ) : (
                    entry.text
                  )}
                </Entry>
              ))}
            </dl>
          </section>
        ) : null}

        {item.run ? (
          <p className="font-ui text-12">
            <Link
              to={`/admin/ai/console?run=${encodeURIComponent(item.run.id)}`}
              className="text-accent underline-offset-2 hover:underline"
            >
              {l("openRun")} — <span className="font-mono">{item.run.agentKey}</span>
            </Link>
          </p>
        ) : null}

        {/* The API's own words, on the request that earned them. */}
        {problem ? <Problem problem={problem} /> : null}

        {blocked ? (
          <p role="note" className="border-t border-border pt-3 font-ui text-13 text-subtle">
            {l("selfRaised")}
          </p>
        ) : pending ? (
          <Form
            method="post"
            className="grid gap-3 border-t border-border pt-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end"
          >
            <input type="hidden" name="id" value={item.id} />
            <Field
              label={l("reason")}
              hint={l("reasonHint")}
              {...(needsReason && !reason.trim() ? { error: l("reasonRequired") } : {})}
            >
              {/* Not `required`: the field is optional for an approval, and only
                  the reject path needs it. The rule still lives in the API — the
                  check above is a courtesy, not a copy that could drift. */}
              <Textarea
                name="reason"
                rows={2}
                maxLength={2000}
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value)}
              />
            </Field>
            <div className="flex flex-wrap gap-2 lg:pb-6">
              <Button type="submit" name="intent" value="approve" loading={mine} disabled={busy}>
                {l("approve")}
              </Button>
              {/* Both rules the API applies to a rejection, asked before the
                  round trip rather than instead of it: the reason it requires,
                  and the fact that nothing undoes this afterwards. */}
              <ConfirmButton
                type="submit"
                name="intent"
                value="reject"
                variant="danger"
                loading={mine}
                disabled={busy}
                message={l("confirmReject")}
                guard={() => {
                  setNeedsReason(!reason.trim());
                  return reason.trim().length > 0;
                }}
              >
                {l("reject")}
              </ConfirmButton>
            </div>
          </Form>
        ) : null}
      </div>
      <span className="sr-only">{t("common.id")}: {item.id}</span>
    </Card>
  );
}

function Entry({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="font-ui text-13 text-text">{children}</dd>
    </div>
  );
}

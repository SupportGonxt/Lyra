import { useEffect, useId, useState, type ReactNode } from "react";
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
  AgentBadge,
  Badge,
  Button,
  Card,
  cn,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  EvidenceLink,
  Field,
  focusRing,
  GhostText,
  GuardrailNotice,
  Ref,
  Select,
  Textarea,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, directory, fetchMe, type ApiOptions } from "../api.server";
import { whoIs } from "../people";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { optionLabel } from "../modules/spec";
import { labelsFrom } from "./detail-kit";
import { Problem } from "./module";
import { useOrbitSessionData } from "./orbit-shell";
import { MemoryPanel } from "../components/memory-panel";

// One conversation, read and replied to. ORBIT has no hand-written router: the
// whole surface is the generated CRUD in apps/api/src/crud.ts, so this screen is
// built out of list filters on `conversationId` and one POST to
// /v1/orbit/messages. Nothing here calls an endpoint that does not exist.
//
// A reply leaves the tenant, which makes it consequential (CLAUDE.md §4). The
// API does not gate message creation today, so the honest thing to report is the
// delivery status the row comes back with — "queued", never "sent" — and to show
// an approval notice verbatim if the API ever starts answering 403.

interface Page<T> {
  data: T[];
  cursor?: string;
  total?: number;
}

interface Conversation {
  id: string;
  customerId: string | null;
  channel: string;
  state: string;
  assigneeRef: string | null;
  teamId: string | null;
  summary: string | null;
  lang: string | null;
  intent: string | null;
  /** -100..100 (packages/db schema/orbit.ts), not a word. */
  sentiment: number | null;
  csat: number | null;
  lastMessageAt: number | null;
  closedAt: number | null;
  createdAt: number;
}

interface Message {
  id: string;
  conversationId: string;
  role: string; // customer|agent_ai|agent_human|system
  modality: string;
  content: string | null;
  aiAuditId: string | null;
  deliveryStatus: string | null; // queued|sent|delivered|read|failed
  ts: number;
}

interface HandoverNote {
  id: string;
  fromRef: string | null;
  toRef: string | null;
  summary: string | null;
  generatedBy: string;
  acceptedBy: string | null;
  ts: number;
}

interface QaScore {
  id: string;
  rubricKey: string;
  score: number;
  flagsJson: unknown;
  scoredBy: string | null;
  disputedBy: string | null;
  ts: number;
}

/** Mirrors `packages/db/src/schema/orbit.ts` `macros` — the columns the picker needs. */
interface Macro {
  id: string;
  key: string;
  nameJson: unknown;
  category: string | null;
}

interface AiRun {
  id: string;
  agentKey: string;
  purpose: string;
  outputRef: string | null;
  confidence: number | null; // 0-100
  evidenceJson: unknown;
  autonomyLevel: string;
  startedAt: number;
}

interface Customer {
  id: string;
  nameJson: unknown;
}

/** Permission strings, copied from the ORBIT registry in apps/api/src/resources.ts. */
const CAN = {
  reply: "orbit:messages:send",
  assign: "orbit:conversations:assign",
  handover: "orbit:handover:read",
  handoverWrite: "orbit:handover:write",
  qa: "orbit:qa:read",
  customer: "core:customers:read",
  audit: "ai:audit:read"
} as const;

/** One request's worth of thread. `?pages=N` walks the keyset cursor backwards. */
const PAGE = 50;
const MAX_PAGES = 10;

/**
 * A side panel the actor may not read is missing, not fatal: the loader cannot
 * see permissions, so it asks and accepts "no" as an answer.
 */
async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const id = params.id;
  if (!id) throw data("conversation", { status: 404 });
  const env = context.get(cloudflare).env;

  const conversation = await api<Conversation>(`/v1/orbit/conversations/${id}`, { env, request });
  const pages = Math.min(
    MAX_PAGES,
    Math.max(1, Math.trunc(Number(new URL(request.url).searchParams.get("pages") ?? "1")) || 1)
  );

  const [thread, customer, handovers, scores, macros] = await Promise.all([
    olderFirst(id, pages, env, request),
    conversation.customerId
      ? optional(
          api<Customer>(`/v1/core/customers/${conversation.customerId}`, { env, request })
        )
      : Promise.resolve(null),
    optional(
      api<Page<HandoverNote>>(`/v1/orbit/handover-notes?conversationId=${id}&sort=ts&order=desc`, {
        env,
        request
      })
    ),
    optional(
      api<Page<QaScore>>(`/v1/orbit/qa-scores?conversationId=${id}&sort=ts&order=desc`, {
        env,
        request
      })
    ),
    // docs/27 F32. `optional` because an agent without `orbit:macros:read` still
    // gets the whole screen, minus the picker — a canned reply is a
    // convenience, not part of reading a conversation.
    optional(api<Page<Macro>>(`/v1/orbit/macros?status=active&sort=key&limit=100`, { env, request }))
  ]);

  const messages = thread.rows;
  // An AI turn that was drafted but never dispatched has no delivery status —
  // schema/orbit.ts calls aiAuditId "a drafted/sent AI turn". Only a *trailing*
  // one is still a suggestion: an undispatched AI row with human turns after it
  // is history, not an offer.
  //
  // Messages are immutable (apps/api/src/resources.ts), so approving a draft
  // posts a second row rather than updating this one, and the original stays
  // behind forever. Anything already dispatched under the same audit id — or the
  // same words — is that approval, and retires the draft.
  const dispatched = new Set(
    messages.filter((m) => m.deliveryStatus).map((m) => m.aiAuditId ?? m.content ?? "")
  );
  const last = messages[messages.length - 1];
  const draft =
    last &&
    last.role === "agent_ai" &&
    !last.deliveryStatus &&
    !dispatched.has(last.aiAuditId ?? last.content ?? "")
      ? last
      : null;

  // The confidence and evidence live on the run that produced the draft, matched
  // through the audit id the message carries.
  const runs = draft?.aiAuditId
    ? await optional(
        api<Page<AiRun>>(`/v1/ai/runs?subjectRef=${id}&sort=startedAt&order=desc&limit=10`, {
          env,
          request
        })
      )
    : null;
  const run = runs?.data.find((r) => r.outputRef && r.outputRef === draft?.aiAuditId) ?? null;

  // Handing a conversation on took a typed `user:us_…` — the one field where a
  // ULID is least excusable, because the agent doing it is mid-chat (ADR-0047).
  const assignees = await directory({ env, request });

  return {
    conversation,
    assignees,
    messages: messages.filter((m) => m.id !== draft?.id),
    draft,
    run,
    pages,
    hasOlder: thread.older,
    denied: thread.denied,
    customerName: nameOf(customer?.nameJson),
    handovers: handovers?.data ?? null,
    scores: scores?.data ?? null,
    macros: macros?.data ?? []
  };
}

/**
 * The thread, oldest first, walked backwards through the keyset cursor. A list
 * request caps at 200 rows (apps/api/src/http.ts), so "read the whole history"
 * is not a bigger `limit` — it is more pages, and the newest page has to be the
 * one that is always present.
 */
async function olderFirst(
  id: string,
  pages: number,
  env: ApiOptions["env"],
  request: Request
): Promise<{ rows: Message[]; older: boolean; denied: boolean }> {
  const rows: Message[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pages; page += 1) {
    const query = new URLSearchParams({
      conversationId: id,
      sort: "ts",
      order: "desc",
      limit: String(PAGE)
    });
    if (cursor) query.set("cursor", cursor);
    try {
      const body = await api<Page<Message>>(`/v1/orbit/messages?${query.toString()}`, { env, request });
      rows.push(...(body.data ?? []));
      cursor = body.cursor;
    } catch (error) {
      // Reading the conversation and reading its messages are separate grants;
      // losing the second one leaves a readable header, not a broken page.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        return { rows: rows.reverse(), older: false, denied: true };
      }
      throw error;
    }
    if (!cursor) break;
  }

  return { rows: rows.reverse(), older: Boolean(cursor), denied: false };
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const id = params.id;
  if (!id) throw data("conversation", { status: 404 });
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "reply");
  const content = String(form.get("content") ?? "").trim();

  try {
    if (intent === "reply" || intent === "approve") {
      if (!content) return { problem: null, sent: null, done: null };
      const message = await api<Message>("/v1/orbit/messages", {
        env,
        request,
        // A send that runs twice is a customer reading the same thing twice; the
        // CRUD router honours this header, so a retry or a double click is free.
        headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
        method: "POST",
        body: {
          conversationId: id,
          // An approved draft stays an AI turn and keeps its audit id: who wrote
          // the words does not change because a human let them through.
          role: intent === "approve" ? "agent_ai" : "agent_human",
          content,
          ...(intent === "approve" && form.get("aiAuditId")
            ? { aiAuditId: String(form.get("aiAuditId")) }
            : {}),
          // `ts` is a serverColumn (apps/api/src/resources.ts) — the CRUD
          // schema excludes it entirely and `fixed` fills it from ctx.now;
          // sending it here trips the `.strict()` schema as an unknown key.
          deliveryStatus: "queued"
        }
      });
      return {
        problem: null,
        sent: { id: message.id, status: message.deliveryStatus },
        done: intent === "approve" ? "done.approve" : null
      };
    }

    // Assignment and handover both need to know who is asking, and the browser
    // is not allowed to say — the shell ships permissions, never an actor id.
    if (intent === "assign" || intent === "handover") {
      const me = await fetchMe(env, request);
      if (intent === "assign") {
        await api(`/v1/orbit/conversations/${id}`, {
          env,
          request,
          method: "PATCH",
          // Taking a conversation is also taking it off the bot.
          body: { assigneeRef: me.actor.id, state: "human" }
        });
        return { problem: null, sent: null, done: "done.assign" };
      }
      const summary = String(form.get("summary") ?? "").trim();
      if (!summary) return { problem: null, sent: null, done: null };
      await api("/v1/orbit/handover-notes", {
        env,
        request,
        method: "POST",
        body: {
          conversationId: id,
          fromRef: me.actor.id,
          ...(form.get("toRef") ? { toRef: String(form.get("toRef")) } : {}),
          summary,
          generatedBy: "human",
          ts: Date.now()
        }
      });
      return { problem: null, sent: null, done: "done.handover" };
    }

    // docs/27 F32. The wording lives on the macro, so the browser posts a key
    // and never the text: an agent cannot edit a canned reply on its way out,
    // and the API renders it in the conversation's own language.
    if (intent === "macro") {
      const macroKey = String(form.get("macroKey") ?? "");
      if (!macroKey) return { problem: null, sent: null, done: null };
      await api(`/v1/orbit/conversations/${id}/macro`, {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
        body: { macroKey }
      });
      return { problem: null, sent: null, done: "done.macro" };
    }

    if (intent === "close" || intent === "reopen") {
      const closing = intent === "close";
      await api(`/v1/orbit/conversations/${id}`, {
        env,
        request,
        method: "PATCH",
        body: closing
          ? { state: "closed", closedAt: Date.now() }
          : { state: "human", closedAt: null }
      });
      return { problem: null, sent: null, done: closing ? "done.close" : "done.reopen" };
    }

    return { problem: { title: "unknown intent", status: 400 }, sent: null, done: null };
  } catch (error) {
    // A rejected write is information, not a crash: keep the actor on the page
    // with their input intact and show what the API objected to — including an
    // approval gate, which must never read as "delivered".
    if (error instanceof ApiError) return { problem: error.problem, sent: null, done: null };
    throw error;
  }
}

/**
 * This screen may not touch the shared catalogue, so its own vocabulary lives
 * here. Anything generic still comes from `translator(locale)`.
 * ponytail: fold these into i18n/en.ts once that file has an owner again.
 */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    conversation: "Conversation",
    thread: "Messages",
    customer: "Customer",
    channel: "Channel",
    state: "State",
    inbound: "From customer",
    outbound: "To customer",
    internal: "Internal",
    "role.customer": "Customer",
    "role.agent_ai": "AI agent",
    "role.agent_human": "Agent",
    "role.system": "System",
    "channel.whatsapp": "WhatsApp",
    "channel.web": "Web",
    "channel.voice": "Voice",
    "channel.email": "Email",
    "channel.agent": "Agent",
    "state.bot": "Bot",
    "state.human": "Human",
    "delivery.queued": "Queued for delivery",
    "delivery.sent": "Sent",
    "delivery.delivered": "Delivered",
    "delivery.read": "Read",
    "delivery.failed": "Delivery failed",
    "delivery.none": "Not dispatched",
    reply: "Reply",
    replyHint: "Sending a reply leaves the tenant and is recorded in the audit log.",
    send: "Send reply",
    macro: "Canned reply",
    macroHint: "Sent in this conversation's language, word for word, under your name.",
    macroSend: "Send canned reply",
    "done.macro": "Canned reply sent.",
    noReply: "You do not hold the permission to reply in this conversation.",
    empty: "No messages yet.",
    "empty.body": "This customer reached out on a channel but no message has been recorded — the first reply or inbound message will open the thread.",
    denied: "You can see this conversation but not its messages.",
    older: "Load older messages",
    start: "This is the start of the conversation.",
    queued: "Reply queued for delivery. It has not left yet.",
    approvalTitle: "This reply needs approval before it can be sent",
    audit: "Audit record",
    aiSentNote: "An agent wrote this turn. The audit record holds the prompt and the evidence.",
    context: "Customer context",
    openCustomer: "Open the customer record",
    intent: "Intent",
    lang: "Language",
    sentiment: "Sentiment",
    csat: "Customer satisfaction",
    assignee: "Assigned to",
    unassigned: "Nobody",
    team: "Team",
    started: "Started",
    lastMessage: "Last message",
    closedAt: "Closed",
    assign: "Assign to me",
    close: "Close conversation",
    reopen: "Reopen conversation",
    handoverAdd: "Hand this over",
    handoverTo: "Hand to",
    handoverPick: "Choose a colleague or team",
    handoverSummary: "What the next person needs to know",
    handoverSave: "Save handover note",
    "done.assign": "This conversation is now assigned to you and taken off the bot.",
    "done.close": "Conversation closed.",
    "done.reopen": "Conversation reopened and returned to a human.",
    "done.handover": "Handover note saved.",
    "done.approve": "Draft approved and queued as an AI turn. It has not left yet.",
    draft: "Suggested reply",
    agent: "Assistant",
    draftNote: "Drafted, not sent. Approve it as it stands, move it into the composer to edit, or discard it.",
    approve: "Approve and queue",
    approveHint: "Approving queues these exact words as an AI turn and keeps the audit trail with them.",
    accept: "Use this draft",
    dismiss: "Dismiss draft",
    why: "Why this draft",
    evidence: "What it was based on",
    autonomy: "Autonomy",
    handover: "Handover notes",
    qa: "Quality scores",
    generatedBy: "Written by",
    accepted: "Accepted by",
    rubric: "Rubric",
    score: "Score",
    disputed: "Disputed",
    none: "None recorded."
  },
  ar: {
    conversation: "محادثة",
    thread: "الرسائل",
    customer: "العميل",
    channel: "القناة",
    state: "الحالة",
    inbound: "من العميل",
    outbound: "إلى العميل",
    internal: "داخلي",
    "role.customer": "العميل",
    "role.agent_ai": "وكيل ذكي",
    "role.agent_human": "موظف",
    "role.system": "النظام",
    "channel.whatsapp": "واتساب",
    "channel.web": "الويب",
    "channel.voice": "مكالمة صوتية",
    "channel.email": "البريد الإلكتروني",
    "channel.agent": "وكيل",
    "state.bot": "آلي",
    "state.human": "بشري",
    "delivery.queued": "في انتظار الإرسال",
    "delivery.sent": "أُرسلت",
    "delivery.delivered": "تم التسليم",
    "delivery.read": "مقروءة",
    "delivery.failed": "فشل الإرسال",
    "delivery.none": "لم تُرسل",
    reply: "الرد",
    replyHint: "إرسال الرد يخرج من المنصة ويُسجَّل في سجل التدقيق.",
    send: "إرسال الرد",
    macro: "رد جاهز",
    macroHint: "يُرسل بلغة هذه المحادثة كما هو وباسمك.",
    macroSend: "إرسال الرد الجاهز",
    "done.macro": "أُرسل الرد الجاهز.",
    noReply: "لا تملك صلاحية الرد في هذه المحادثة.",
    empty: "لا توجد رسائل بعد.",
    "empty.body": "تواصل هذا العميل عبر قناة دون تسجيل أي رسالة — أول رد أو رسالة واردة تفتح الخيط.",
    denied: "يمكنك رؤية هذه المحادثة دون رسائلها.",
    older: "تحميل الرسائل الأقدم",
    start: "هذه بداية المحادثة.",
    queued: "أُضيف الرد إلى قائمة الإرسال. لم يُرسل بعد.",
    approvalTitle: "هذا الرد يحتاج موافقة قبل إرساله",
    audit: "سجل التدقيق",
    aiSentNote: "كتب وكيل ذكي هذه الرسالة. سجل التدقيق يحتوي على التوجيه والأدلة.",
    context: "بيانات العميل",
    openCustomer: "فتح سجل العميل",
    intent: "الغرض",
    lang: "اللغة",
    sentiment: "المشاعر",
    csat: "رضا العميل",
    assignee: "مكلّف بها",
    unassigned: "لا أحد",
    team: "الفريق",
    started: "بدأت",
    lastMessage: "آخر رسالة",
    closedAt: "أُغلقت",
    assign: "إسنادها إليّ",
    close: "إغلاق المحادثة",
    reopen: "إعادة فتح المحادثة",
    handoverAdd: "تسليم المحادثة",
    handoverTo: "التسليم إلى",
    handoverPick: "اختر زميلاً أو فريقاً",
    handoverSummary: "ما يحتاج الشخص التالي معرفته",
    handoverSave: "حفظ ملاحظة التسليم",
    "done.assign": "أُسندت إليك هذه المحادثة وخرجت من وضع الرد الآلي.",
    "done.close": "أُغلقت المحادثة.",
    "done.reopen": "أُعيد فتح المحادثة وأُسندت إلى موظف.",
    "done.handover": "حُفظت ملاحظة التسليم.",
    "done.approve": "اعتُمدت المسودة وأُضيفت إلى قائمة الإرسال كرد آلي. لم تُرسل بعد.",
    draft: "رد مقترح",
    agent: "المساعد",
    draftNote: "مسودة لم تُرسل. اعتمدها كما هي، أو انقلها إلى صندوق الرد لتعديلها، أو تجاهلها.",
    approve: "موافقة وإضافة للإرسال",
    approveHint: "الموافقة تضيف هذا النص كما هو إلى قائمة الإرسال كرد آلي مع الاحتفاظ بسجل التدقيق.",
    accept: "استخدام المسودة",
    dismiss: "تجاهل المسودة",
    why: "سبب هذه المسودة",
    evidence: "المصادر المستخدمة",
    autonomy: "مستوى الاستقلالية",
    handover: "ملاحظات التسليم",
    qa: "درجات الجودة",
    generatedBy: "كتبها",
    accepted: "اعتمدها",
    rubric: "المعيار",
    score: "الدرجة",
    disputed: "مُعترض عليها",
    none: "لا يوجد."
  }
};

const labelsIn = labelsFrom(LABELS);

/** Customer names are `{ en, ar }` — or masked strings, when the actor lacks core:pii:view. */
function nameOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const first = record.en ?? Object.values(record)[0];
    if (typeof first === "string") return first;
  }
  return null;
}

const DELIVERY_TONE: Record<string, BadgeTone> = {
  queued: "warning",
  sent: "info",
  delivered: "success",
  read: "success",
  failed: "danger"
};

/** The roles this build has words for; anything else is echoed as it arrived. */
const ROLES = new Set(["customer", "agent_ai", "agent_human", "system"]);

export default function ConversationThread() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useOrbitSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const held = new Set(shell?.permissions ?? []);
  const t = translator(locale);
  // Through the shared catalogue, not this table alone: a conversation can be
  // `closed` as well as bot|human (packages/db/src/schema/orbit.ts), and that
  // word is one the platform already says (docs/ui.md §7 P3-14).
  const l = labelsIn(locale, shell?.domainPack);

  const busy = navigation.state !== "idle";
  const conversation = loaded.conversation;
  const canReply = held.has(CAN.reply);

  const [content, setContent] = useState("");
  const [dismissed, setDismissed] = useState(false);
  // A fresh key per attempt: stable through re-renders and through SSR, new the
  // moment a send succeeds, so the next reply is a new message rather than a
  // deduplicated repeat of the last one.
  const composerId = useId();
  const [attempt, setAttempt] = useState(0);
  const sent = result?.sent ?? null;
  useEffect(() => {
    if (!sent) return;
    setContent("");
    setAttempt((n) => n + 1);
  }, [sent]);

  const draft = dismissed ? null : loaded.draft;
  const run = loaded.run;
  const problem = result?.problem ?? null;
  const done = result?.done ?? null;
  const needsApproval = Boolean(problem?.type?.endsWith("approval_required"));
  const closed = conversation.state === "closed";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            to="/orbit/conversations"
            className="w-fit font-ui text-12 text-subtle underline-offset-2 hover:underline"
          >
            {t("common.back")}
          </Link>
          <h1 className="font-serif text-22 leading-[1.2] text-text">
            {loaded.customerName ?? l("conversation")}
          </h1>
          <p className="flex flex-wrap items-center gap-2 font-ui text-12 text-subtle">
            <Badge tone="neutral">{l(`channel.${conversation.channel}`)}</Badge>
            <Badge tone={conversation.state === "closed" ? "neutral" : "accent"}>
              {l(`state.${conversation.state}`)}
            </Badge>
            <Ref value={conversation.id} />
          </p>
          {conversation.summary ? (
            <p className="max-w-prose font-ui text-13 text-muted">{conversation.summary}</p>
          ) : null}
        </div>
      </header>

      {held.has(CAN.assign) ? (
        <div className="flex flex-wrap items-center gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="assign" />
            <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={closed}>
              {l("assign")}
            </Button>
          </Form>
          <Form method="post">
            <input type="hidden" name="intent" value={closed ? "reopen" : "close"} />
            <Button type="submit" variant="ghost" size="sm" loading={busy}>
              {closed ? l("reopen") : l("close")}
            </Button>
          </Form>
        </div>
      ) : null}

      {sent ? (
        <p role="status" className="font-ui text-13 text-muted">
          {/* What the row actually says, not what the actor hopes it says. */}
          {deliveryLabel(sent.status, l)}
        </p>
      ) : null}

      {done ? (
        <p role="status" className="font-ui text-13 text-muted">
          {l(done)}
        </p>
      ) : null}

      {needsApproval && problem ? (
        <GuardrailNotice
          title={l("approvalTitle")}
          reason={problem.detail ?? problem.title}
          tone="warning"
        />
      ) : problem ? (
        <Problem problem={problem} />
      ) : null}

      <Card title={l("context")} padded>
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <Fact term={l("customer")}>
            {conversation.customerId ? (
              held.has(CAN.customer) ? (
                <Link
                  to={`/admin/customers/${conversation.customerId}`}
                  title={l("openCustomer")}
                  className="underline-offset-2 hover:underline"
                >
                  {loaded.customerName ?? conversation.customerId}
                </Link>
              ) : (
                (loaded.customerName ?? conversation.customerId)
              )
            ) : null}
          </Fact>
          <Fact term={l("assignee")}>
            {conversation.assigneeRef
              ? (whoIs(loaded.assignees, conversation.assigneeRef) ?? <Ref value={conversation.assigneeRef} />)
              : l("unassigned")}
          </Fact>
          <Fact term={l("channel")}>{l(`channel.${conversation.channel}`)}</Fact>
          <Fact term={l("team")}>
            {whoIs(loaded.assignees, conversation.teamId) ?? <Ref value={conversation.teamId} />}
          </Fact>
          <Fact term={l("intent")}>{conversation.intent}</Fact>
          <Fact term={l("lang")}>{conversation.lang}</Fact>
          <Fact term={l("sentiment")}>
            {conversation.sentiment === null ? null : (
              <span className="tabular-nums">{conversation.sentiment}</span>
            )}
          </Fact>
          {/* CSAT is the customer's own verdict — shown only once they have given one. */}
          <Fact term={l("csat")}>
            {conversation.csat === null ? null : (
              <span className="tabular-nums">{conversation.csat}</span>
            )}
          </Fact>
          <Fact term={l("started")}>
            <DateTime value={conversation.createdAt} locale={locale} precision="minute" />
          </Fact>
          <Fact term={l("lastMessage")}>
            {conversation.lastMessageAt === null ? null : (
              <DateTime value={conversation.lastMessageAt} locale={locale} precision="minute" />
            )}
          </Fact>
          <Fact term={l("closedAt")}>
            {conversation.closedAt === null ? null : (
              <DateTime value={conversation.closedAt} locale={locale} precision="minute" />
            )}
          </Fact>
        </dl>
      </Card>

      {loaded.denied ? (
        <GuardrailNotice title={l("thread")} reason={l("denied")} tone="warning" />
      ) : loaded.messages.length === 0 && !draft ? (
        <EmptyState title={l("empty")} body={l("empty.body")} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-ui text-12 text-subtle">
            {loaded.hasOlder ? (
              // Paging is a link, not a button: the page it lands on is a real
              // address, so a reload or a shared URL keeps the same history.
              <Link
                to={`?pages=${loaded.pages + 1}`}
                preventScrollReset
                className="underline-offset-2 hover:underline"
              >
                {l("older")}
              </Link>
            ) : (
              l("start")
            )}
          </p>
          <ol
            aria-label={l("thread")}
            // Replies land at the end of the list after the loader revalidates;
            // announcing additions only keeps a screen reader out of the archive.
            aria-live="polite"
            aria-relevant="additions"
            className="flex flex-col gap-3"
          >
            {loaded.messages.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                locale={locale}
                l={l}
                canAudit={held.has(CAN.audit)}
              />
            ))}
          </ol>
        </div>
      )}

      {draft?.content ? (
        <section
          aria-label={l("draft")}
          className="flex flex-col gap-3 rounded-lg border border-dashed border-border p-4"
        >
          <div className="flex flex-wrap items-center gap-3">
            <AgentBadge
              agent={run ? optionLabel(l, "agentKey", run.agentKey) : l("agent")}
              why={
                <div className="flex flex-col gap-2 text-start">
                  <span className="font-ui text-13 text-muted">{l("draftNote")}</span>
                  {run ? (
                    <span className="font-ui text-12 text-subtle">
                      {optionLabel(l, "purpose", run.purpose)} · {l("autonomy")}:{" "}
                      {optionLabel(l, "autonomy", run.autonomyLevel)}
                    </span>
                  ) : null}
                </div>
              }
            />
            {run?.evidenceJson ? (
              <EvidenceLink
                sourceLabel={l("evidence")}
                source={
                  <pre
                    tabIndex={0}
                    className={cn(
                      "max-w-xs overflow-x-auto font-mono text-12 text-muted",
                      focusRing
                    )}
                  >
                    {JSON.stringify(run.evidenceJson, null, 2)}
                  </pre>
                }
              >
                {l("evidence")}
              </EvidenceLink>
            ) : null}
            {draft.aiAuditId && held.has(CAN.audit) ? (
              <Link
                to={`/admin/ai-audit-log/${draft.aiAuditId}`}
                className="font-ui text-12 text-subtle underline-offset-2 hover:underline"
              >
                {l("audit")}
              </Link>
            ) : null}
          </div>

          {typeof run?.confidence === "number" ? (
            <ConfidenceMeter value={run.confidence / 100} className="max-w-xs" />
          ) : null}

          {/* Ghost text, never a modal and never sent on its own: accepting only
              moves the words into the composer the human has to submit, and
              approving is a second, explicit click that queues them verbatim. */}
          <GhostText
            text={draft.content}
            onAccept={() => setContent(draft.content ?? "")}
            onDiscard={() => setDismissed(true)}
          />

          {canReply ? (
            <Form method="post" className="flex flex-col gap-2">
              <input type="hidden" name="intent" value="approve" />
              <input type="hidden" name="content" value={draft.content} />
              {draft.aiAuditId ? (
                <input type="hidden" name="aiAuditId" value={draft.aiAuditId} />
              ) : null}
              <input type="hidden" name="nonce" value={`${composerId}:draft:${draft.id}`} />
              <div className="flex">
                <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={closed}>
                  {l("approve")}
                </Button>
              </div>
              <p className="max-w-prose font-ui text-12 text-subtle">{l("approveHint")}</p>
            </Form>
          ) : null}
        </section>
      ) : null}

      {/* docs/27 F32. The picker posts a key, never the wording: a canned reply
          is wording somebody approved, and an agent editing it on the way out
          would make the macro library a suggestion rather than a standard. The
          API renders it in this conversation's own language. */}
      {canReply && loaded.macros.length > 0 ? (
        <Form method="post" className="flex flex-col gap-2">
          <input type="hidden" name="intent" value="macro" />
          <input type="hidden" name="nonce" value={`${composerId}:macro:${attempt}`} />
          <Field label={l("macro")} hint={l("macroHint")}>
            <Select
              name="macroKey"
              defaultValue={loaded.macros[0]!.key}
              options={loaded.macros.map((macro) => ({
                value: macro.key,
                label: nameOf(macro.nameJson) ?? macro.key
              }))}
            />
          </Field>
          <div className="flex">
            <Button type="submit" variant="secondary" size="sm" loading={busy} disabled={closed}>
              {l("macroSend")}
            </Button>
          </div>
        </Form>
      ) : null}

      {canReply ? (
        <Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="nonce" value={`${composerId}:${attempt}`} />
          <Field label={l("reply")} hint={l("replyHint")}>
            <Textarea
              name="content"
              rows={4}
              value={content}
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </Field>
          <div className="flex">
            <Button type="submit" loading={busy} disabled={content.trim().length === 0}>
              {l("send")}
            </Button>
          </div>
        </Form>
      ) : (
        <p className="font-ui text-13 text-subtle">{l("noReply")}</p>
      )}

      {held.has(CAN.handover) && loaded.handovers ? (
        <Card title={l("handover")} padded>
          {loaded.handovers.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("none")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {loaded.handovers.map((note) => (
                <li key={note.id} className="flex flex-col gap-1 border-s border-border ps-3">
                  <span className="font-ui text-13 text-text">{note.summary ?? ""}</span>
                  <span className="font-ui text-12 text-subtle">
                    {l("generatedBy")}: {l(`role.agent_${note.generatedBy}`)}
                    {note.acceptedBy ? ` · ${l("accepted")}: ${note.acceptedBy}` : ""} ·{" "}
                    <DateTime value={note.ts} locale={locale} precision="minute" />
                  </span>
                </li>
              ))}
            </ul>
          )}
          {held.has(CAN.handoverWrite) ? (
            <Form method="post" className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="intent" value="handover" />
              <Field label={l("handoverTo")}>
                <Select
                  name="toRef"
                  placeholder={l("handoverPick")}
                  options={loaded.assignees.map((one) => ({ value: one.ref, label: one.name }))}
                />
              </Field>
              <Field label={l("handoverSummary")}>
                <Textarea name="summary" rows={3} required />
              </Field>
              <div className="flex">
                <Button type="submit" variant="secondary" size="sm" loading={busy}>
                  {l("handoverSave")}
                </Button>
              </div>
            </Form>
          ) : null}
        </Card>
      ) : null}

      {held.has(CAN.qa) && loaded.scores ? (
        <Card title={l("qa")} padded>
          {loaded.scores.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("none")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {loaded.scores.map((score) => (
                <li key={score.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-ui text-13 text-text">
                    {l("rubric")}: {score.rubricKey}
                  </span>
                  <Badge tone={score.score >= 70 ? "success" : "warning"}>
                    {l("score")}: {score.score}
                  </Badge>
                  {score.disputedBy ? <Badge tone="danger">{l("disputed")}</Badge> : null}
                  <span className="font-ui text-12 text-subtle">
                    <DateTime value={score.ts} locale={locale} precision="minute" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {/* The record's memory (ADR-0085), last: below everything the record
          itself shows, loaded after it, so it never pushes the record down. */}
      <MemoryPanel
        subject={conversation.id}
        t={t}
        locale={locale}
        permissions={shell?.permissions ?? []}
      />
    </div>
  );
}

/** A term/value pair that stays out of the way when there is no value. */
function Fact({ term, children }: { term: string; children?: ReactNode }) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className="flex flex-col gap-0.5 border-s border-border ps-3">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className={empty ? "font-ui text-13 text-subtle" : "font-ui text-13 text-text"}>
        {empty ? "—" : children}
      </dd>
    </div>
  );
}

/**
 * Delivery status, said the way the API said it. A status this build has never
 * heard of is echoed raw rather than translated into a guess — reporting "sent"
 * for a row that only reached the queue is the one lie this screen must not tell.
 */
export function deliveryLabel(status: string | null, l: (key: string) => string): string {
  if (status === null) return l("delivery.none");
  return status in DELIVERY_TONE ? l(`delivery.${status}`) : status;
}

/**
 * Direction is not a column: it is the `role` on the message. Customer turns are
 * inbound, everything else is outbound. Both carry a written label and sit on
 * their own side, so the difference survives a monochrome screen (WCAG 2.2 AA:
 * colour is never the only carrier).
 */
function MessageRow({
  message,
  locale,
  l,
  canAudit
}: {
  message: Message;
  locale: string;
  l: (key: string) => string;
  canAudit: boolean;
}) {
  const inbound = message.role === "customer";
  const system = message.role === "system";
  const direction = inbound ? l("inbound") : system ? l("internal") : l("outbound");
  const status = message.deliveryStatus;

  return (
    <li
      className={
        inbound
          ? "me-auto max-w-prose rounded-lg border border-border bg-surface-1 p-3 text-start"
          : "ms-auto max-w-prose rounded-lg border border-accent/40 bg-surface-2 p-3 text-start"
      }
    >
      <p className="flex flex-wrap items-center gap-2 font-ui text-12 text-subtle">
        <span>{direction}</span>
        <Badge tone={inbound ? "neutral" : "accent"} size="sm">
          {/* A role this build has not shipped a word for still names itself. */}
          {ROLES.has(message.role) ? l(`role.${message.role}`) : message.role}
        </Badge>
        <DateTime value={message.ts} locale={locale} precision="minute" />
        {!inbound ? (
          <Badge tone={status ? (DELIVERY_TONE[status] ?? "neutral") : "neutral"} size="sm">
            {deliveryLabel(status, l)}
          </Badge>
        ) : null}
        {message.aiAuditId ? (
          <>
            <AgentBadge
              why={<span className="font-ui text-13 text-muted">{l("aiSentNote")}</span>}
            />
            {canAudit ? (
              <Link
                to={`/admin/ai-audit-log/${message.aiAuditId}`}
                className="underline-offset-2 hover:underline"
              >
                {l("audit")}
              </Link>
            ) : null}
          </>
        ) : null}
      </p>
      <p className="mt-1 whitespace-pre-wrap font-ui text-13 text-text">{message.content ?? ""}</p>
      {/* ponytail: attachments and redactions arrive as JSON columns; render them
          when a channel actually sends one. */}
    </li>
  );
}

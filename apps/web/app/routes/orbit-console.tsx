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
  DateTime,
  EmptyState,
  Table,
  hueVar,
  renderSection,
  type BadgeTone,
  type Column,
  type Section
} from "@lyra/ui";
import { FOCUS, HeroStat, HeroWall, lensOf, useFocus, type Lens } from "../components/hero";
import { api, asRouteError, fetchMe, names, type Names, type Problem as ProblemShape } from "../api.server";
import { who } from "../names";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { ORBIT, labelsFrom, orbitPortals, refusal, safe, type Label, type Labels, type Page } from "./orbit-shared";
import { localeFrom } from "../i18n";

// The operator's view of the room: who the agent is holding, who a human is
// holding, and how long anybody has been waiting on a reply.
//
// ponytail: this is a snapshot with an explicit refresh, not a stream.
// apps/api/src/routes/realtime.ts serves SSE scoped to one actor's own queue
// (pullForActor), which a loader cannot subscribe to — and a fake stream that
// polls behind the user's back is worse than a button they can see. Upgrade
// path: a tenant-scoped realtime topic, then this renders the same list from it.

/* --------------------------------------------------------------- contract */

export interface LiveConversation {
  id: string;
  customerId: string | null;
  channel: string;
  state: string;
  assigneeRef: string | null;
  teamId: string | null;
  intent: string | null;
  sentiment: number | null;
  summary: string | null;
  lang: string | null;
  firstResponseMs: number | null;
  lastMessageAt: number | null;
  createdAt: number;
}

export interface HandoverNote {
  id: string;
  conversationId: string | null;
  fromRef: string | null;
  toRef: string | null;
  generatedBy: string | null;
  acceptedBy: string | null;
  ts: number;
}

/** Past this, a waiting customer is the thing to look at first. */
export const SLOW_MS = 15 * 60_000;

/** How long since anybody said anything on this conversation. */
export function waitingMs(row: LiveConversation, now: number): number {
  return Math.max(0, now - (row.lastMessageAt ?? row.createdAt));
}

/**
 * What the wall's one drillable figure counts. Both queues are filtered through
 * this same predicate while it is focused, so "waiting over 15 minutes: 4" can
 * only ever open onto those four rows. `now` is the loader's snapshot, so the
 * figure and the list read one clock rather than two.
 */
export function lensesAt(now: number): Record<string, Lens<LiveConversation>> {
  return { waiting: (row) => waitingMs(row, now) >= SLOW_MS };
}

export function waitLabel(ms: number, l: Label): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return l("waitMinutes", { n: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return l("waitHours", { n: String(hours) });
  return l("waitDays", { n: String(Math.floor(hours / 24)) });
}

/** Whoever has waited longest — the one conversation an operator opens first. */
export function mostUrgent(rows: LiveConversation[], now: number): LiveConversation | null {
  return rows.reduce<LiveConversation | null>(
    (worst, row) => (!worst || waitingMs(row, now) > waitingMs(worst, now) ? row : worst),
    null
  );
}

/**
 * The one sentence the console opens with. Arithmetic on the two queues and
 * the wait-clock already on the KPI wall — no ✦, this is not an agent's
 * finding (CLAUDE.md §11).
 */
export function consoleHeadline(botCount: number, humanCount: number, waitingLong: number, l: Label): string {
  if (waitingLong > 0) return l("headlineOverdue", { n: String(waitingLong) });
  if (botCount > 0) return l("headlineAgent", { n: String(botCount) });
  if (humanCount > 0) return l("headlineHuman", { n: String(humanCount) });
  return l("headlineClear");
}

/** Sentiment is −100…100 from the runtime; three buckets is all an operator reads. */
export function moodTone(sentiment: number | null): BadgeTone {
  if (sentiment === null) return "neutral";
  if (sentiment <= -25) return "danger";
  if (sentiment >= 25) return "success";
  // A neutral customer is not a warning: amber means "needs attention".
  return "neutral";
}

export function moodKey(sentiment: number | null): string {
  if (sentiment === null) return "moodUnknown";
  if (sentiment <= -25) return "moodNegative";
  if (sentiment >= 25) return "moodPositive";
  return "moodNeutral";
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Live console",
    lede: "A snapshot of every open conversation. Refresh to pull the current state.",
    headlineOverdue: "{n} have been waiting over 15 minutes.",
    headlineAgent: "The agent is holding {n} conversations.",
    headlineHuman: "Your team is holding {n} conversations.",
    headlineClear: "Nothing is open right now.",
    refresh: "Refresh",
    asOf: "As of",
    active: "Open conversations",
    handledByAgent: "Held by the agent",
    handledByHuman: "Held by a person",
    waitingLong: "Waiting over 15 minutes",
    heroAll: "Show everything",
    agentQueue: "Agent is answering",
    agentQueueBody: "The AI agent holds these. Take one over and it moves to your name.",
    humanQueue: "People are answering",
    humanQueueBody: "Already with a person. Waiting time is since the last message either way.",
    recentHandovers: "Recent handovers",
    recentHandoversBody: "Every take-over writes a note the next person can read.",
    customer: "Customer",
    channel: "Channel",
    intent: "Intent",
    mood: "Mood",
    waiting: "Waiting",
    assignee: "With",
    lastMessage: "Last message",
    act: "Action",
    take: "Take over",
    taking: "Taking over",
    tookIt: "That conversation is yours now.",
    openThread: "Open thread",
    from: "From",
    to: "To",
    when: "When",
    written: "Note written by",
    whyWritten: "The agent summarised the conversation so the person taking it over starts read-in.",
    noneAgent: "Nothing is waiting on the agent.",
    noneHuman: "Nobody is holding a conversation.",
    noneHandovers: "No handovers yet.",
    noneBody: "Refresh once a conversation opens.",
    moodPositive: "Positive",
    moodNeutral: "Neutral",
    moodNegative: "Negative",
    moodUnknown: "Unread",
    waitMinutes: "{n} min",
    waitHours: "{n} h",
    waitDays: "{n} d",
    unassigned: "Unassigned",
    unnamedCustomer: "Unnamed customer",
    whatsapp: "WhatsApp",
    web: "Web",
    voice: "Voice",
    email: "Email",
    agent: "Agent channel",
    unknownIntent: "That control is not available.",
    missingConversation: "Pick a conversation first.",
    approvalLink: "Open approvals",
    portalsTitle: "Public portals",
    portalsBody: "Send a customer straight to one of the tenant's self-serve pages.",
    portalStorefront: "Storefront",
    portalRegister: "Self-registration",
    portalPartners: "Partner sign-up"
  },
  ar: {
    title: "لوحة المتابعة الحية",
    lede: "لمحة عن كل محادثة مفتوحة. حدّث الصفحة لجلب الحالة الحالية.",
    headlineOverdue: "{n} ينتظرون منذ أكثر من 15 دقيقة.",
    headlineAgent: "الوكيل الذكي يحمل {n} محادثة.",
    headlineHuman: "فريقك يحمل {n} محادثة.",
    headlineClear: "لا شيء مفتوح الآن.",
    refresh: "تحديث",
    asOf: "حتى",
    active: "المحادثات المفتوحة",
    handledByAgent: "بيد الوكيل الذكي",
    handledByHuman: "بيد موظف",
    waitingLong: "انتظار أكثر من 15 دقيقة",
    heroAll: "إظهار الكل",
    agentQueue: "الوكيل الذكي يجيب",
    agentQueueBody: "الوكيل الذكي يحمل هذه المحادثات. تولَّ واحدة فتنتقل إلى اسمك.",
    humanQueue: "الموظفون يجيبون",
    humanQueueBody: "مع موظف بالفعل. مدة الانتظار محسوبة من آخر رسالة في الحالتين.",
    recentHandovers: "التسليمات الأخيرة",
    recentHandoversBody: "كل تولٍّ يكتب ملاحظة يقرأها من يأتي بعدك.",
    customer: "العميل",
    channel: "القناة",
    intent: "الغرض",
    mood: "المزاج",
    waiting: "الانتظار",
    assignee: "لدى",
    lastMessage: "آخر رسالة",
    act: "إجراء",
    take: "تولَّ المحادثة",
    taking: "جارٍ التولي",
    tookIt: "المحادثة لك الآن.",
    openThread: "افتح المحادثة",
    from: "من",
    to: "إلى",
    when: "الوقت",
    written: "كاتب الملاحظة",
    whyWritten: "لخّص الوكيل الذكي المحادثة ليبدأ من يستلمها وهو مطّلع عليها.",
    noneAgent: "لا شيء ينتظر الوكيل الذكي.",
    noneHuman: "لا أحد يحمل محادثة.",
    noneHandovers: "لا تسليمات بعد.",
    noneBody: "حدّث الصفحة بعد فتح محادثة.",
    moodPositive: "إيجابي",
    moodNeutral: "محايد",
    moodNegative: "سلبي",
    moodUnknown: "غير مقروء",
    waitMinutes: "{n} دقيقة",
    waitHours: "{n} ساعة",
    waitDays: "{n} يوم",
    unassigned: "غير مُسند",
    unnamedCustomer: "عميل بلا اسم",
    whatsapp: "واتساب",
    web: "الويب",
    voice: "صوت",
    email: "البريد الإلكتروني",
    agent: "قناة الوكيل",
    unknownIntent: "هذا الإجراء غير متاح.",
    missingConversation: "اختر محادثة أولًا.",
    approvalLink: "افتح الموافقات",
    portalsTitle: "البوابات العامة",
    portalsBody: "وجّه العميل مباشرة إلى إحدى صفحات الخدمة الذاتية الخاصة بالمؤسسة.",
    portalStorefront: "واجهة المتجر",
    portalRegister: "التسجيل الذاتي",
    portalPartners: "تسجيل الشركاء"
  }
};

export function labelsIn(locale: string): Label {
  return labelsFrom(LABELS, locale);
}

/* ------------------------------------------------------------------ loader */

const LIVE = "sort=lastMessageAt&order=desc&limit=50&count=true";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const empty: Page<LiveConversation> = { data: [], total: 0 };

  const [bot, human, handovers] = await Promise.all([
    held.has(ORBIT.conversations)
      ? safe(() => api<Page<LiveConversation>>(`/v1/orbit/conversations?state=bot&${LIVE}`, opts), empty)
      : Promise.resolve(empty),
    held.has(ORBIT.conversations)
      ? safe(() => api<Page<LiveConversation>>(`/v1/orbit/conversations?state=human&${LIVE}`, opts), empty)
      : Promise.resolve(empty),
    held.has(ORBIT.handovers)
      ? safe(
          () => api<Page<HandoverNote>>("/v1/orbit/handover-notes?sort=ts&order=desc&limit=10", opts),
          { data: [] } as Page<HandoverNote>
        )
      : Promise.resolve({ data: [] } as Page<HandoverNote>)
  ]);

  // Rows carry refs and no display text, so a triage screen would otherwise
  // list ULIDs where the customer's name belongs. One batch call for every ref
  // on the page; anything the API leaves unresolved falls back to a short ref.
  const live = [...bot.data, ...human.data];
  const resolved = await names(
    [
      ...live.flatMap((row) => [row.customerId, row.assigneeRef, row.teamId]),
      ...handovers.data.flatMap((note) => [note.fromRef, note.toRef])
    ],
    opts
  );

  return {
    locale: localeFrom(request),
    now: Date.now(),
    nonce: crypto.randomUUID(),
    may: { read: held.has(ORBIT.conversations), take: held.has(ORBIT.assign) },
    tenantSlug: me.tenant.slug,
    bot,
    human,
    handovers: handovers.data,
    names: resolved,
    // A handover names a conversation, and a conversation has no name of its own
    // — the customer on it is what an operator is looking for.
    customerOf: Object.fromEntries(live.map((row) => [row.id, row.customerId])) as Record<string, string | null>
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  took: string | null;
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "take") {
    return { problem: { title: "unknown_intent", status: 400 }, took: null };
  }
  const id = String(form.get("id") ?? "");
  if (!id) return { problem: { title: "missing_conversation", status: 400 }, took: null };

  try {
    // The shell ships permissions, never an actor id — so ask who this is
    // before writing an assignee (same reason as routes/conversation.tsx).
    const me = await fetchMe(env, request);
    await api(`/v1/orbit/conversations/${id}`, {
      env,
      request,
      method: "PATCH",
      headers: { "idempotency-key": String(form.get("nonce") ?? crypto.randomUUID()) },
      body: { assigneeRef: me.actor.id, state: "human" }
    });
    return { problem: null, took: id };
  } catch (error) {
    return { problem: refusal(error), took: null };
  }
}

/** `orbitPortals`'s three keys, each to the label naming it. */
const PORTAL_LABEL_KEY: Record<string, string> = {
  storefront: "portalStorefront",
  register: "portalRegister",
  partners: "portalPartners"
};

/* --------------------------------------------------------------- component */

export default function OrbitConsole() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state === "submitting";
  const LENSES = lensesAt(loaded.now);
  const { focus, href } = useFocus(LENSES);
  const live = [...loaded.bot.data, ...loaded.human.data];
  // Counted through the same lens the queues below are filtered by, never a
  // second `.filter` that could drift from it.
  const waitingLong = lensOf(live, LENSES, "waiting").length;
  const urgent = mostUrgent(live, loaded.now);
  const portals = orbitPortals(loaded.tenantSlug);
  const portalSection: Section = {
    kind: "kv",
    title: l("portalsTitle"),
    items: portals.map((p) => ({ label: l(PORTAL_LABEL_KEY[p.key]!), value: p.path, hue: hueVar("orbit"), font: "" }))
  };

  const problemMessage: Record<string, string> = {
    unknown_intent: l("unknownIntent"),
    missing_conversation: l("missingConversation")
  };
  const local = result?.problem ? problemMessage[result.problem.title] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {consoleHeadline(
              loaded.bot.total ?? loaded.bot.data.length,
              loaded.human.total ?? loaded.human.data.length,
              waitingLong,
              l
            )}
          </h1>
          <p className="font-ui text-13 text-muted">{l("lede")}</p>
          {urgent ? (
            <Link
              to={`/orbit/conversations/${urgent.id}/thread`}
              className="w-fit font-ui text-13 text-accent underline"
            >
              {l("openThread")}
            </Link>
          ) : null}
        </div>
        <Form method="get" replace className="flex items-center gap-3">
          {/* A GET form submits its fields as the whole query, so without this a
              refresh would silently drop the lens the reader drilled into. */}
          {focus ? <input type="hidden" name={FOCUS} value={focus} /> : null}
          <span className="font-ui text-12 text-subtle">
            {l("asOf")} <DateTime value={loaded.now} locale={loaded.locale} precision="minute" />
          </span>
          <Button type="submit" variant="secondary" size="sm">
            {l("refresh")}
          </Button>
        </Form>
      </header>

      {local ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{local}</p>
        </div>
      ) : null}
      {result?.problem && !local ? <Gate problem={result.problem} l={l} /> : null}
      {result?.took ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l("tookIt")}</p>
        </div>
      ) : null}

      <HeroWall focus={focus} allLabel={l("heroAll")}>
        {/* No door: this is two server counts added together, and neither page
            below holds all the rows it stands for. */}
        <HeroStat
          label={l("active")}
          value={String((loaded.bot.total ?? loaded.bot.data.length) + (loaded.human.total ?? loaded.human.data.length))}
        />
        {/* One state, one endpoint, one declared filter (modules/orbit.ts): the
            list route counts the same rows this figure came from. */}
        <HeroStat
          label={l("handledByAgent")}
          value={String(loaded.bot.total ?? loaded.bot.data.length)}
          to="/orbit/conversations?state=bot"
        />
        <HeroStat
          label={l("handledByHuman")}
          value={String(loaded.human.total ?? loaded.human.data.length)}
          to="/orbit/conversations?state=human"
        />
        <HeroStat
          label={l("waitingLong")}
          value={String(waitingLong)}
          live={waitingLong > 0}
          to={href("waiting")}
          active={focus === "waiting"}
        />
      </HeroWall>

      <div className="flex flex-col gap-2">
        <p className="font-ui text-12 text-subtle">{l("portalsBody")}</p>
        {renderSection(portalSection, "orbit")}
        <div className="flex flex-wrap gap-4">
          {portals.map((p) => (
            <Link key={p.key} to={p.path} className="font-ui text-13 text-accent underline underline-offset-2">
              {l(PORTAL_LABEL_KEY[p.key]!)}
            </Link>
          ))}
        </div>
      </div>

      <Card title={l("agentQueue")} description={l("agentQueueBody")}>
        <Queue
          rows={lensOf(loaded.bot.data, LENSES, focus)}
          resolved={loaded.names}
          l={l}
          locale={loaded.locale}
          now={loaded.now}
          nonce={loaded.nonce}
          takeable={loaded.may.take}
          busy={busy}
          emptyTitle={l("noneAgent")}
        />
      </Card>

      <Card title={l("humanQueue")} description={l("humanQueueBody")}>
        <Queue
          rows={lensOf(loaded.human.data, LENSES, focus)}
          resolved={loaded.names}
          l={l}
          locale={loaded.locale}
          now={loaded.now}
          nonce={loaded.nonce}
          takeable={false}
          busy={busy}
          emptyTitle={l("noneHuman")}
        />
      </Card>

      {/* Handovers are not conversations and the focused figure did not count
          them, so while a lens is on they would be rows on screen that the
          figure above disowns. Gone until the reader shows everything again. */}
      {focus ? null : (
        <Card title={l("recentHandovers")} description={l("recentHandoversBody")}>
          {loaded.handovers.length === 0 ? (
            <EmptyState title={l("noneHandovers")} body={l("noneBody")} />
          ) : (
            <Table
              caption={l("recentHandovers")}
              rows={loaded.handovers}
              rowKey={(row) => row.id}
              density="compact"
              columns={[
                {
                  key: "conversationId",
                  header: l("customer"),
                  render: (row) =>
                    row.conversationId ? (
                      <Link
                        to={`/orbit/conversations/${row.conversationId}/thread`}
                        className="font-ui text-12 text-accent underline underline-offset-2"
                      >
                        {who(loaded.customerOf[row.conversationId], loaded.names) ?? l("unnamedCustomer")}
                      </Link>
                    ) : (
                      <span className="text-subtle">{l("unassigned")}</span>
                    )
                },
                { key: "fromRef", header: l("from"), render: (row) => who(row.fromRef, loaded.names) ?? "—" },
                { key: "toRef", header: l("to"), render: (row) => who(row.toRef, loaded.names) ?? "—" },
                {
                  key: "generatedBy",
                  header: l("written"),
                  // ponytail: AgentBadge ships its own English chrome (packages/ui);
                  // translating the primitive is a @lyra/ui change, not a screen change.
                  render: (row) =>
                    row.generatedBy?.startsWith("agent:") ? (
                      <AgentBadge agent={row.generatedBy.slice("agent:".length)} why={l("whyWritten")} />
                    ) : (
                      <span className="font-ui text-12 text-muted">{row.generatedBy ?? "—"}</span>
                    )
                },
                {
                  key: "ts",
                  header: l("when"),
                  render: (row) => <DateTime value={row.ts} locale={loaded.locale} relative />
                }
              ] satisfies Column<HandoverNote>[]}
            />
          )}
        </Card>
      )}
    </div>
  );
}

function Queue({
  rows,
  resolved,
  l,
  locale,
  now,
  nonce,
  takeable,
  busy,
  emptyTitle
}: {
  rows: LiveConversation[];
  resolved: Names;
  l: Label;
  locale: string;
  now: number;
  nonce: string;
  takeable: boolean;
  busy: boolean;
  emptyTitle: string;
}) {
  if (rows.length === 0) return <EmptyState title={emptyTitle} body={l("noneBody")} />;

  const columns: Column<LiveConversation>[] = [
    {
      key: "customerId",
      header: l("customer"),
      render: (row) => (
        <div className="flex flex-col">
          <Link
            to={`/orbit/conversations/${row.id}/thread`}
            className="font-ui text-13 text-accent underline underline-offset-2"
          >
            {who(row.customerId, resolved) ?? l("unnamedCustomer")}
          </Link>
          {row.summary ? <span className="font-ui text-12 text-subtle">{row.summary}</span> : null}
        </div>
      )
    },
    { key: "channel", header: l("channel"), render: (row) => <Badge tone="neutral">{l(row.channel)}</Badge> },
    { key: "intent", header: l("intent"), render: (row) => row.intent ?? "—" },
    {
      key: "sentiment",
      header: l("mood"),
      render: (row) => <Badge tone={moodTone(row.sentiment)}>{l(moodKey(row.sentiment))}</Badge>
    },
    {
      key: "waiting",
      header: l("waiting"),
      numeric: true,
      render: (row) => {
        const ms = waitingMs(row, now);
        return (
          <span className={ms >= SLOW_MS ? "font-ui text-13 font-medium text-danger" : "font-ui text-13 text-text"}>
            {waitLabel(ms, l)}
          </span>
        );
      }
    },
    {
      key: "assigneeRef",
      header: l("assignee"),
      render: (row) =>
        who(row.assigneeRef, resolved) ?? <span className="font-ui text-12 text-subtle">{l("unassigned")}</span>
    },
    {
      key: "lastMessageAt",
      header: l("lastMessage"),
      render: (row) => <DateTime value={row.lastMessageAt ?? row.createdAt} locale={locale} relative />
    }
  ];

  if (takeable) {
    columns.push({
      key: "act",
      header: l("act"),
      render: (row) => (
        <Form method="post" replace>
          <input type="hidden" name="intent" value="take" />
          <input type="hidden" name="id" value={row.id} />
          <input type="hidden" name="nonce" value={`${nonce}:${row.id}`} />
          <Button type="submit" variant="secondary" size="sm" disabled={busy}>
            {busy ? l("taking") : l("take")}
          </Button>
        </Form>
      )
    });
  }

  return <Table caption={l("title")} rows={rows} rowKey={(row) => row.id} columns={columns} density="compact" />;
}

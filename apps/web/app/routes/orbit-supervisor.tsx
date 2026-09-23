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
  Field,
  Select,
  Table,
  Textarea,
  type BadgeTone
} from "@lyra/ui";
import { FOCUS, HeroStat, HeroWall, lensOf, useFocus, type Lens } from "../components/hero";
import { api, asRouteError, fetchMe, names, type Names, type Problem as ProblemShape } from "../api.server";
import { who } from "../names";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { ORBIT, labelsFrom, refusal, safe, type Label, type Labels, type Page } from "./orbit-shared";
import { SLOW_MS, waitLabel, waitingMs, type LiveConversation } from "./orbit-console";
import { containment } from "./orbit-analytics";
import { localeFrom } from "../i18n";

// docs/modules/orbit.md §4 screen 2 — the Supervisor Wall. The room from one
// step back: how much is open, how long the worst of it has waited, how much
// the agent is still holding alone, who is on shift, and which conversations
// have blown an SLA. Then the two things a supervisor can do about it without
// taking the conversation off the person handling it: barge (say something to
// the customer) and whisper (leave a private note for the assignee).
//
// ponytail: a snapshot with an explicit refresh, same as orbit-console and for
// the same reason — apps/api/src/routes/realtime.ts serves SSE scoped to one
// actor's own queue (pullForActor), which a loader cannot subscribe to, and a
// wall that polls behind the supervisor's back is worse than a button they can
// see. Upgrade path is the same: a tenant-scoped realtime topic.
//
// ponytail: barge posts through /conversations/:id/reply — the one place
// ChannelAdapter.send() is called from — so the customer really hears it, and
// whisper writes an orbit_handover_notes row (generatedBy "human"), which is
// already the internal, never-customer-facing channel between two people on one
// conversation. No new table for either. Known ceiling: orbit_messages has no
// author column, so a barge reads as "a person" in the transcript and the
// supervisor's identity lives only in the audit log. Add the column when a
// transcript has to name who spoke.

/* --------------------------------------------------------------- contract */

/** The conversation row with the SLA columns the console does not read. */
export interface SupervisedConversation extends LiveConversation {
  priority: number | null;
  queuedAt: number | null;
  firstResponseDueAt: number | null;
  resolutionDueAt: number | null;
  frtBreachedAt: number | null;
  resolutionBreachedAt: number | null;
}

export interface Presence {
  id: string;
  userId: string | null;
  status: string;
  activeCount: number | null;
  updatedAt: number | null;
}

/* ------------------------------------------------------------------ alerts */

export type AlertKind = "resolution" | "frt" | "due";

export interface Alert {
  row: SupervisedConversation;
  kind: AlertKind;
}

/** Worst first. A missed resolution outranks a missed first reply, which
 *  outranks a deadline that has passed but nothing has stamped yet. */
const RANK: Record<AlertKind, number> = { resolution: 0, frt: 1, due: 2 };

export const ALERT_TONE: Record<AlertKind, BadgeTone> = {
  resolution: "danger",
  frt: "warning",
  due: "info"
};

export function alertOf(row: SupervisedConversation, now: number): AlertKind | null {
  if (row.resolutionBreachedAt) return "resolution";
  if (row.frtBreachedAt) return "frt";
  // A due time already past that carries no breach stamp: sweepRouting stamps
  // on the cron tick, so the wall sees a breach a few minutes before the row
  // admits to one. Showing it is the whole point of a live board.
  if ((row.firstResponseDueAt ?? Infinity) < now) return "due";
  if ((row.resolutionDueAt ?? Infinity) < now) return "due";
  return null;
}

/**
 * The wall's one drillable figure: an open conversation that has missed
 * something. Same predicate `alertsFrom` triages by, so the figure and the
 * alerts table can never disagree on what counts as breached.
 */
export function lensesAt(now: number): Record<string, Lens<SupervisedConversation>> {
  return { breached: (row) => alertOf(row, now) !== null };
}

export function alertsFrom(rows: readonly SupervisedConversation[], now: number): Alert[] {
  return rows
    .flatMap((row) => {
      const kind = alertOf(row, now);
      return kind ? [{ row, kind }] : [];
    })
    .sort(
      (a, b) =>
        RANK[a.kind] - RANK[b.kind] ||
        (a.row.queuedAt ?? a.row.createdAt) - (b.row.queuedAt ?? b.row.createdAt)
    );
}

export interface Staffing {
  available: number;
  away: number;
  offline: number;
  /** Conversations the roster is holding between them, per their own counters. */
  holding: number;
}

export function staffing(rows: readonly Presence[]): Staffing {
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  return {
    available: count("available"),
    away: count("away"),
    offline: count("offline"),
    holding: rows.reduce((sum, row) => sum + (row.activeCount ?? 0), 0)
  };
}

export const PRESENCE_TONE: Record<string, BadgeTone> = {
  available: "success",
  away: "warning",
  offline: "neutral"
};

/** What the wall is for, in one line: worst first, same order as the alerts table. */
export function supervisorHeadline(openCount: number, alertCount: number, waitingLong: number, l: Label): string {
  if (alertCount > 0) return l("headlineBreach", { n: String(alertCount) });
  if (waitingLong > 0) return l("headlineWaiting", { n: String(waitingLong) });
  if (openCount > 0) return l("headlineOpen", { n: String(openCount) });
  return l("headlineClear");
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Supervisor wall",
    lede: "The room from one step back. Refresh to pull the current state.",
    refresh: "Refresh",
    asOf: "As of",
    headlineBreach: "{n} conversations have missed a deadline",
    headlineWaiting: "{n} conversations waiting over 15 minutes",
    headlineOpen: "{n} conversations open, nothing overdue",
    headlineClear: "Nothing open right now",

    openNow: "Open now",
    heroAll: "Show everything",
    heldByAgent: "Held by the agent",
    contained: "Agent containment",
    containedHint: "Share of what is open that no person has had to touch",
    waitingLong: "Waiting over 15 minutes",
    breached: "Past an SLA",

    alerts: "Needs a supervisor",
    alertsBody: "Every open conversation that has missed a deadline, worst first.",
    noAlerts: "Nothing has missed a deadline.",
    noAlertsBody: "Refresh once something slips.",
    customer: "Customer",
    channel: "Channel",
    breach: "Breach",
    waiting: "Waiting",
    due: "Due",
    assignee: "With",
    openThread: "Open thread",
    "kind.resolution": "Resolution missed",
    "kind.frt": "First reply missed",
    "kind.due": "Deadline passed",

    roster: "On shift",
    rosterBody: "Presence as each agent last set it, and how many they are holding.",
    noRoster: "Nobody has set their presence.",
    noRosterBody: "An agent marks themselves available from their own console.",
    agentName: "Agent",
    presence: "Presence",
    holding: "Holding",
    since: "Since",
    "presence.available": "Available",
    "presence.away": "Away",
    "presence.offline": "Offline",

    stepIn: "Step in",
    stepInBody:
      "Barge and the customer hears it on their own channel. Whisper and only the person handling the conversation reads it.",
    pick: "Conversation",
    pickNone: "Pick a conversation",
    text: "What to say",
    textHint: "A barge is sent as it is written. A whisper is never shown to the customer.",
    barge: "Barge",
    whisper: "Whisper",
    barged: "Sent to the customer.",
    whispered: "The person handling it will see your note.",
    noneOpen: "No conversation is open to step into.",
    noneOpenBody: "Refresh once one comes in.",

    unassigned: "Unassigned",
    unnamedCustomer: "Unnamed customer",
    unknownIntent: "That control is not available.",
    missingConversation: "Pick a conversation first.",
    missingText: "Write something to send first.",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "لوحة المشرف",
    lede: "الغرفة من خطوة إلى الوراء. حدّث الصفحة لجلب الحالة الحالية.",
    refresh: "تحديث",
    asOf: "حتى",
    headlineBreach: "{n} محادثة فاتها موعد",
    headlineWaiting: "{n} محادثة تنتظر أكثر من ١٥ دقيقة",
    headlineOpen: "{n} محادثة مفتوحة، لا شيء متأخر",
    headlineClear: "لا شيء مفتوح الآن",

    openNow: "مفتوح الآن",
    heroAll: "إظهار الكل",
    heldByAgent: "بيد الوكيل الذكي",
    contained: "اكتفاء الوكيل الذاتي",
    containedHint: "نسبة المفتوح الذي لم يضطر أي موظف للتدخل فيه",
    waitingLong: "انتظار أكثر من ١٥ دقيقة",
    breached: "تجاوز اتفاقية الخدمة",

    alerts: "يحتاج تدخّل مشرف",
    alertsBody: "كل محادثة مفتوحة فاتها موعد، الأسوأ أولًا.",
    noAlerts: "لم يفت أي موعد.",
    noAlertsBody: "حدّث الصفحة عند حدوث تأخير.",
    customer: "العميل",
    channel: "القناة",
    breach: "التجاوز",
    waiting: "الانتظار",
    due: "الموعد",
    assignee: "لدى",
    openThread: "افتح المحادثة",
    "kind.resolution": "فات موعد الإغلاق",
    "kind.frt": "فات موعد أول رد",
    "kind.due": "انقضى الموعد",

    roster: "على المناوبة",
    rosterBody: "الحضور كما ضبطه كل موظف، وعدد المحادثات التي يحملها.",
    noRoster: "لم يضبط أحد حضوره.",
    noRosterBody: "يضبط الموظف حضوره من لوحته الخاصة.",
    agentName: "الموظف",
    presence: "الحضور",
    holding: "يحمل",
    since: "منذ",
    "presence.available": "متاح",
    "presence.away": "بعيد",
    "presence.offline": "غير متصل",

    stepIn: "تدخّل",
    stepInBody: "المقاطعة يسمعها العميل على قناته. الهمسة يقرأها من يتولى المحادثة وحده.",
    pick: "المحادثة",
    pickNone: "اختر محادثة",
    text: "ما تريد قوله",
    textHint: "تُرسل المقاطعة كما كُتبت. الهمسة لا تُعرض على العميل أبدًا.",
    barge: "قاطِع",
    whisper: "اهمس",
    barged: "أُرسلت إلى العميل.",
    whispered: "سيرى من يتولى المحادثة ملاحظتك.",
    noneOpen: "لا محادثة مفتوحة للتدخل فيها.",
    noneOpenBody: "حدّث الصفحة عند ورود محادثة.",

    unassigned: "غير مُسند",
    unnamedCustomer: "عميل بلا اسم",
    unknownIntent: "هذا الإجراء غير متاح.",
    missingConversation: "اختر محادثة أولًا.",
    missingText: "اكتب نصًا للإرسال أولًا.",
    approvalLink: "افتح الموافقات"
  }
};

export function labelsIn(locale: string): Label {
  return labelsFrom(LABELS, locale);
}

/* ------------------------------------------------------------------ loader */

const OPEN = "sort=queuedAt&order=asc&limit=100&count=true";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const noConversations: Page<SupervisedConversation> = { data: [], total: 0 };
  const noPresence: Page<Presence> = { data: [] };

  const list = (state: string) =>
    held.has(ORBIT.conversations)
      ? safe(
          () => api<Page<SupervisedConversation>>(`/v1/orbit/conversations?state=${state}&${OPEN}`, opts),
          noConversations
        )
      : Promise.resolve(noConversations);

  const [bot, human, presence] = await Promise.all([
    list("bot"),
    list("human"),
    held.has(ORBIT.presence)
      ? safe(() => api<Page<Presence>>("/v1/orbit/agent-presence?limit=100", opts), noPresence)
      : Promise.resolve(noPresence)
  ]);

  const open = [...bot.data, ...human.data];
  const resolved: Names = await names(
    [...open.flatMap((row) => [row.customerId, row.assigneeRef]), ...presence.data.map((row) => row.userId)],
    opts
  );

  const openCount = (bot.total ?? bot.data.length) + (human.total ?? human.data.length);

  return {
    locale: localeFrom(request),
    now: Date.now(),
    may: {
      read: held.has(ORBIT.conversations),
      barge: held.has(ORBIT.send),
      whisper: held.has(ORBIT.handoverWrite)
    },
    open,
    presence: presence.data,
    counts: {
      open: openCount,
      bot: bot.total ?? bot.data.length,
      // A conversation a person is holding is a conversation the agent did not
      // contain. Over a window that is handover notes over conversations
      // (routes/orbit-analytics.tsx); on a live board it is simply who holds
      // what right now.
      contained: containment(openCount, human.total ?? human.data.length)
    },
    names: resolved
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  done: "barge" | "whisper" | null;
}

const fail = (title: string): ActionResult => ({ problem: { title, status: 400 }, done: null });

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "barge" && intent !== "whisper") return fail("unknown_intent");

  const id = String(form.get("id") ?? "");
  if (!id) return fail("missing_conversation");
  const text = String(form.get("text") ?? "").trim();
  if (!text) return fail("missing_text");

  try {
    if (intent === "barge") {
      await api(`/v1/orbit/conversations/${id}/reply`, { env, request, method: "POST", body: { text } });
      return { problem: null, done: "barge" };
    }

    // The note is addressed to whoever is holding the conversation, so read the
    // assignee rather than trusting a hidden field the page rendered minutes ago.
    const [me, conversation] = await Promise.all([
      fetchMe(env, request),
      api<SupervisedConversation>(`/v1/orbit/conversations/${id}`, { env, request })
    ]);
    await api("/v1/orbit/handover-notes", {
      env,
      request,
      method: "POST",
      body: {
        conversationId: id,
        fromRef: me.actor.id,
        toRef: conversation.assigneeRef ?? me.actor.id,
        summary: text,
        generatedBy: "human"
      }
    });
    return { problem: null, done: "whisper" };
  } catch (error) {
    return { problem: refusal(error), done: null };
  }
}

/* --------------------------------------------------------------- component */

export default function OrbitSupervisor() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state === "submitting";

  const LENSES = lensesAt(loaded.now);
  const { focus, href } = useFocus(LENSES);
  // Lensed, then ranked: the table lists exactly what the figure counted.
  const alerts = alertsFrom(lensOf(loaded.open, LENSES, "breached"), loaded.now);
  const staff = staffing(loaded.presence);
  const waitingLong = loaded.open.filter((row) => waitingMs(row, loaded.now) >= SLOW_MS).length;
  const nameOf = (row: SupervisedConversation) =>
    who(row.customerId, loaded.names) ?? l("unnamedCustomer");

  const problemMessage: Record<string, string> = {
    unknown_intent: l("unknownIntent"),
    missing_conversation: l("missingConversation"),
    missing_text: l("missingText")
  };
  const local = result?.problem ? problemMessage[result.problem.title] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">
            {supervisorHeadline(loaded.counts.open, alerts.length, waitingLong, l)}
          </h1>
          <p className="font-ui text-13 text-muted">{l("lede")}</p>
          {alerts[0] ? (
            <Link
              to={`/orbit/conversations/${alerts[0].row.id}/thread`}
              className="w-fit font-ui text-13 text-accent underline"
            >
              {l("openThread")}
            </Link>
          ) : null}
        </div>
        <Form method="get" replace className="flex items-center gap-3">
          {/* A GET form submits its fields as the whole query, so without this a
              refresh would drop the lens the reader drilled into. */}
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
      {result?.done ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l(result.done === "barge" ? "barged" : "whispered")}</p>
        </div>
      ) : null}

      <HeroWall focus={focus} allLabel={l("heroAll")}>
        {/* No door: a server count across every state, of which this screen
            holds one capped page. */}
        <HeroStat label={l("openNow")} value={String(loaded.counts.open)} />
        {/* One state, one endpoint, one declared filter (modules/orbit.ts). */}
        <HeroStat
          label={l("heldByAgent")}
          value={String(loaded.counts.bot)}
          to="/orbit/conversations?state=bot"
        />
        {/* No door: a ratio has no rows. */}
        <HeroStat
          label={l("contained")}
          value={loaded.counts.contained === null ? "—" : `${Math.round(loaded.counts.contained * 100)}%`}
          hint={l("containedHint")}
        />
        {/* No door: the console counts this over 100 rows per state and this
            wall over 50, so the two figures are not the same set. */}
        <HeroStat label={l("waitingLong")} value={String(waitingLong)} live={waitingLong > 0} />
        <HeroStat
          label={l("breached")}
          value={String(alerts.length)}
          live={alerts.length > 0}
          to={href("breached")}
          active={focus === "breached"}
        />
      </HeroWall>

      <Card title={l("alerts")} description={l("alertsBody")}>
        {alerts.length === 0 ? (
          <EmptyState title={l("noAlerts")} body={l("noAlertsBody")} />
        ) : (
          <Table
            caption={l("alerts")}
            rows={alerts}
            rowKey={(alert) => alert.row.id}
            density="compact"
            columns={[
              {
                key: "customer",
                header: l("customer"),
                render: (alert) => (
                  <Link
                    to={`/orbit/conversations/${alert.row.id}/thread`}
                    className="font-ui text-12 text-accent underline underline-offset-2"
                  >
                    {nameOf(alert.row)}
                  </Link>
                )
              },
              {
                key: "kind",
                header: l("breach"),
                render: (alert) => <Badge tone={ALERT_TONE[alert.kind]}>{l(`kind.${alert.kind}`)}</Badge>
              },
              { key: "channel", header: l("channel"), render: (alert) => alert.row.channel },
              {
                key: "waiting",
                header: l("waiting"),
                render: (alert) => waitLabel(waitingMs(alert.row, loaded.now), l)
              },
              {
                key: "due",
                header: l("due"),
                render: (alert) =>
                  alert.row.firstResponseDueAt ? (
                    <DateTime
                      value={alert.row.firstResponseDueAt}
                      locale={loaded.locale}
                      precision="minute"
                    />
                  ) : (
                    "—"
                  )
              },
              {
                key: "assignee",
                header: l("assignee"),
                render: (alert) =>
                  who(alert.row.assigneeRef, loaded.names) ?? (
                    <span className="text-subtle">{l("unassigned")}</span>
                  )
              }
            ]}
          />
        )}
      </Card>

      {/* Neither the roster nor the step-in picker is a breached conversation,
          so while the lens is on they are rows the figure above disowns. Back
          on "show everything". */}
      {focus ? null : (
        <>
          <Card title={l("roster")} description={l("rosterBody")}>
            <div className="mb-4 flex flex-wrap gap-4">
              <Badge tone="success">
                {l("presence.available")} {staff.available}
              </Badge>
              <Badge tone="warning">
                {l("presence.away")} {staff.away}
              </Badge>
              <Badge tone="neutral">
                {l("presence.offline")} {staff.offline}
              </Badge>
              <Badge tone="info">
                {l("holding")} {staff.holding}
              </Badge>
            </div>
            {loaded.presence.length === 0 ? (
              <EmptyState title={l("noRoster")} body={l("noRosterBody")} />
            ) : (
              <Table
                caption={l("roster")}
                rows={loaded.presence}
                rowKey={(row) => row.id}
                density="compact"
                columns={[
                  {
                    key: "userId",
                    header: l("agentName"),
                    render: (row) => who(row.userId, loaded.names) ?? "—"
                  },
                  {
                    key: "status",
                    header: l("presence"),
                    render: (row) => (
                      <Badge tone={PRESENCE_TONE[row.status] ?? "neutral"}>{l(`presence.${row.status}`)}</Badge>
                    )
                  },
                  { key: "activeCount", header: l("holding"), render: (row) => String(row.activeCount ?? 0) },
                  {
                    key: "updatedAt",
                    header: l("since"),
                    render: (row) =>
                      row.updatedAt ? (
                        <DateTime value={row.updatedAt} locale={loaded.locale} precision="minute" />
                      ) : (
                        "—"
                      )
                  }
                ]}
              />
            )}
          </Card>

          {loaded.may.barge || loaded.may.whisper ? (
            <Card title={l("stepIn")} description={l("stepInBody")}>
              {loaded.open.length === 0 ? (
                <EmptyState title={l("noneOpen")} body={l("noneOpenBody")} />
              ) : (
                <Form method="post" className="flex flex-col gap-4">
                  <Field label={l("pick")} className="max-w-md">
                    <Select
                      name="id"
                      placeholder={l("pickNone")}
                      options={loaded.open.map((row) => ({
                        value: row.id,
                        label: `${nameOf(row)} — ${row.channel}`
                      }))}
                    />
                  </Field>
                  <Field label={l("text")} hint={l("textHint")}>
                    <Textarea name="text" rows={3} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    {loaded.may.barge ? (
                      <Button type="submit" name="intent" value="barge" variant="primary" loading={busy}>
                        {l("barge")}
                      </Button>
                    ) : null}
                    {loaded.may.whisper ? (
                      <Button type="submit" name="intent" value="whisper" variant="secondary" loading={busy}>
                        {l("whisper")}
                      </Button>
                    ) : null}
                  </div>
                </Form>
              )}
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

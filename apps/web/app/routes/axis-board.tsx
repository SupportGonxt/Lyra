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
  GuardrailNotice,
  Money,
  Ref,
  Select,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, directory, names } from "../api.server";
import { who } from "../names";
import { cloudflare } from "../context";
import { labelsFrom } from "./detail-kit";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { jsonOf } from "../json.js";

// Where the work is, laid out as the pipeline it actually is. The cases tab can
// sort and filter but it cannot answer "is anything piling up before approval",
// which is the only question a production board exists to answer.
//
// Deliberately NOT a drag-and-drop board for the lanes themselves: a card never
// jumps to an arbitrary column by drag. It moves only through the per-card
// transition control, which calls `POST /v1/axis/cases/:id/transition`
// (axis-case-lifecycle.ts) — the same state machine and approval gate
// (CLAUDE.md §12) the case detail screen uses. `ownerRef` is the one field this
// board still writes directly, because ownership is not workflow state.

/* --------------------------------------------------------------- contract */

export const PERM = {
  read: "axis:cases:read",
  write: "axis:cases:update"
} as const;

/**
 * Pipeline order, left to right — the order docs/03 §AXIS gives the status
 * column, not alphabetical. `cancelled` is off the board: a cancelled case is
 * not work in progress and a column of them would grow forever.
 */
export const LANES = [
  "intake",
  "quoting",
  "awaiting_docs",
  "review",
  "approval",
  "issued",
  "failed"
] as const;

export type Lane = (typeof LANES)[number];

/**
 * Mirrors `CASE_TRANSITIONS` in packages/core/src/lifecycle.ts. This app
 * cannot import @lyra/core, so the state machine's shape is copied here for
 * the transition control's legal-next-states menu; the server is still the
 * one place that enforces it (axis-case-lifecycle.ts, docs/specs/gap-axis-design.md §D.9).
 */
const CASE_TRANSITIONS: Record<string, readonly string[]> = {
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
 * Cards fetched for the whole board. `MAX_PAGE` in apps/api/src/crud.ts is 200,
 * so this is one page: enough to see a pile-up, and the lane counts below carry
 * the true depth for anything past it.
 */
const BOARD_PAGE = 200;

/**
 * Above this many open cards a lane is congested. Not a tenant setting yet.
 * ponytail: one global number, move it to tenant policy when a tenant disagrees.
 */
export const WIP_WARN = 12;

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Production board",
    intro:
      "Every open case in pipeline order. A lane that turns amber is holding more work than it should. Open a card to act on it — this board reports, it does not move work.",
    "lane.intake": "Intake",
    "lane.quoting": "Quoting",
    "lane.awaiting_docs": "Awaiting documents",
    "lane.review": "Review",
    "lane.approval": "Approval",
    "lane.issued": "Issued",
    "lane.failed": "Failed",
    "state.cancelled": "Cancelled",
    "wip.count": "{open} open",
    "wip.congested": "Holding {open}, above the {limit} this lane should carry",
    // AXIS-008's explainable ordering: the card names its own rank factors —
    // value, risk and SLA pressure, each 0-100 — so the order to work the lane
    // in is a claim a reader can check, not an oracle.
    "rank.why": "Value {value} · Risk {risk} · SLA {sla}",
    "rank.title": "Why this order",
    overflow: "and {more} more",
    unassigned: "Nobody",
    "sev.breach": "Overdue",
    "sev.due": "Due soon",
    "sev.urgent": "Urgent",
    "readonly.title": "Only two edits happen from this board",
    "readonly.reason":
      "Ownership can be set here, and a card can move to a legal next state through its own control — both are audited, guarded edits. There is no free drag between lanes and no way to set an arbitrary status.",
    "readonly.action": "Open the case list",
    "empty.title": "The board is empty",
    "empty.body": "No open case is in any pipeline lane right now.",
    "assign.title": "Assign a case",
    "assign.intro": "Ownership is not workflow state, so it can be set from here.",
    "assign.case": "Case",
    "assign.owner": "Owner",
    "assign.pick": "Choose a colleague or team",
    "assign.submit": "Assign",
    "done.assign": "Ownership updated.",
    "done.transition": "Case moved.",
    "transition.to": "Move to",
    "transition.submit": "Move",
    "problem.bad_intent": "The form did not carry an action this screen knows.",
    "problem.missing_owner": "Name both the case and the owner before assigning it.",
    "problem.missing_target": "Choose the state to move this case to.",
    "headline.clear": "The board is empty",
    "headline.breached": "{count} cases are past their deadline",
    "headline.congested": "{count} lanes are holding more than they should",
    "headline.moving": "Every lane is moving",
    "headline.open": "Open the most urgent case — {ref}"
  },
  ar: {
    title: "لوحة الإنتاج",
    intro:
      "كل حالة مفتوحة بترتيب مسار العمل. المسار الذي يتحول إلى الكهرماني يحمل عملًا أكثر مما ينبغي. افتح البطاقة للتعامل معها — هذه اللوحة تُبلّغ ولا تنقل العمل.",
    "lane.intake": "الاستلام",
    "lane.quoting": "التسعير",
    "lane.awaiting_docs": "بانتظار المستندات",
    "lane.review": "المراجعة",
    "lane.approval": "الموافقة",
    "lane.issued": "أُصدرت",
    "lane.failed": "فشلت",
    "state.cancelled": "ملغاة",
    "wip.count": "{open} مفتوحة",
    "wip.congested": "يحمل {open}، أكثر من {limit} المسموح لهذا المسار",
    "rank.why": "القيمة {value} · المخاطرة {risk} · الموعد {sla}",
    "rank.title": "لماذا هذا الترتيب",
    overflow: "و{more} غيرها",
    unassigned: "بلا مسؤول",
    "sev.breach": "متأخرة",
    "sev.due": "قريبة الاستحقاق",
    "sev.urgent": "عاجلة",
    "readonly.title": "تعديلان فقط من هذه اللوحة",
    "readonly.reason":
      "يمكن تحديد المسؤول من هنا، ويمكن نقل البطاقة إلى حالة تالية مسموحة عبر عنصر التحكم الخاص بها — كلاهما تعديل مُدقَّق ومحكوم. لا سحب حر بين المسارات ولا طريقة لتحديد حالة عشوائية.",
    "readonly.action": "فتح قائمة الحالات",
    "empty.title": "اللوحة فارغة",
    "empty.body": "لا توجد حالة مفتوحة في أي مسار الآن.",
    "assign.title": "تعيين حالة",
    "assign.intro": "المسؤولية ليست حالة مسار عمل، لذا يمكن تحديدها من هنا.",
    "assign.case": "الحالة",
    "assign.owner": "المسؤول",
    "assign.pick": "اختر زميلاً أو فريقاً",
    "assign.submit": "تعيين",
    "done.assign": "تم تحديث المسؤول.",
    "done.transition": "تم نقل الحالة.",
    "transition.to": "الانتقال إلى",
    "transition.submit": "نقل",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "problem.missing_owner": "حدّد الحالة والمسؤول قبل التعيين.",
    "problem.missing_target": "اختر الحالة التي تريد نقل هذه الحالة إليها.",
    "headline.clear": "اللوحة فارغة",
    "headline.breached": "{count} حالة تجاوزت موعدها النهائي",
    "headline.congested": "{count} مسارات تحمل أكثر مما ينبغي",
    "headline.moving": "كل مسار يتحرك بسلاسة",
    "headline.open": "افتح الحالة الأكثر إلحاحاً — {ref}"
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

export const labelsIn = labelsFrom(LABELS);

/* ----------------------------------------------------------------- shapes */

export interface BoardCase {
  id: string;
  ref: string;
  kind: string;
  status: string;
  priority: string;
  ownerRef: string | null;
  valueMinor: number | null;
  riskScore: number | null;
  currency: string | null;
  slaDueAt: number | null;
  createdAt: number;
}

export interface LaneView {
  lane: Lane;
  /** Every card the API returned for this lane, in the order it should be worked. */
  cards: BoardCase[];
  /** The lane's true depth, which can exceed `cards.length`. */
  open: number;
  congested: boolean;
  /** The WIP threshold that produced `congested`, tenant override or `WIP_WARN`. */
  warnAt: number;
}

/* ---------------------------------------------------------------- helpers */

/**
 * Split one flat page of cases into lanes, worst-first inside each. `counts`
 * carries the API's own totals so a lane that overflowed the page still shows
 * its real depth instead of the truncated one. `warnAt` is the tenant's
 * per-lane override from `axis_ops_policies` key `axis.board` (§D.9); a lane
 * missing from it falls back to `WIP_WARN`.
 */
export function laneViews(
  cases: BoardCase[],
  now: number,
  counts: Partial<Record<Lane, number>> = {},
  warnAt: Partial<Record<Lane, number>> = {}
): LaneView[] {
  return LANES.map((lane) => {
    const cards = cases.filter((row) => row.status === lane).sort(byUrgency(now));
    const open = counts[lane] ?? cards.length;
    const limit = warnAt[lane] ?? WIP_WARN;
    return { lane, cards, open, congested: open > limit, warnAt: limit };
  });
}

// value × risk × SLA, each normalized 0..1, weights in axis_ops_policies
export function priorityScore(c: BoardCase, now: number, w = WEIGHTS): number {
  const value = Math.min(1, (c.valueMinor ?? 0) / w.valueCapMinor);
  const risk = (c.riskScore ?? 50) / 100;
  const sla =
    c.slaDueAt == null
      ? 0.5
      : c.slaDueAt <= now
        ? 1
        : Math.max(0, 1 - (c.slaDueAt - now) / w.slaHorizonMs);
  return w.value * value + w.risk * risk + w.sla * sla;
}
export const WEIGHTS = { value: 0.4, risk: 0.2, sla: 0.4, valueCapMinor: 5_000_00, slaHorizonMs: 72 * 3_600_000 };

/** Highest priority first; ties break on the earliest deadline, then oldest — the order to work a lane in. */
export function byUrgency(now: number) {
  return (a: BoardCase, b: BoardCase): number => {
    const score = priorityScore(b, now) - priorityScore(a, now);
    if (score !== 0) return score;
    const due = (a.slaDueAt ?? Number.MAX_SAFE_INTEGER) - (b.slaDueAt ?? Number.MAX_SAFE_INTEGER);
    return due !== 0 ? due : a.createdAt - b.createdAt;
  };
}

export const isLate = (row: { slaDueAt?: number | null }, now: number): boolean =>
  typeof row.slaDueAt === "number" && row.slaDueAt < now;

// Arithmetic on counts the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11).
export function headlineFor(
  counts: { total: number; breached: number; congested: number },
  l: Label
): string {
  if (counts.total === 0) return l("headline.clear");
  if (counts.breached > 0) return l("headline.breached", { count: String(counts.breached) });
  if (counts.congested > 0) return l("headline.congested", { count: String(counts.congested) });
  return l("headline.moving");
}

/** What to shout about one card, or nothing. Overdue outranks the priority flag. */
export function flagOf(
  row: BoardCase,
  now: number,
  soonMs = 24 * 60 * 60 * 1000
): { key: string; tone: BadgeTone } | null {
  if (isLate(row, now)) return { key: "sev.breach", tone: "danger" };
  if (row.priority === "urgent") return { key: "sev.urgent", tone: "warning" };
  if (typeof row.slaDueAt === "number" && row.slaDueAt - now <= soonMs)
    return { key: "sev.due", tone: "info" };
  return null;
}

async function safe<T>(call: Promise<T>, fallback: T): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

/**
 * The tenant's per-lane WIP override, `axis_ops_policies` key `axis.board`
 * (docs/specs/gap-axis-design.md §D.9): `{ wipWarn: { quoting: 12, ... } }`.
 * Absent row, a 403/404, or malformed JSON all resolve to `{}`, which leaves
 * every lane on `WIP_WARN`.
 */
async function boardWipWarn(
  opts: Parameters<typeof api>[1]
): Promise<Partial<Record<Lane, number>>> {
  // `valueJson` arrives already parsed — see `jsonOf`. Reading it as text and
  // parsing again threw on every tenant that had set an override, and the
  // `catch` turned that into "no override", silently.
  const got = await safe(
    api<{ data: Array<{ valueJson: unknown }> }>(`/v1/axis/ops-policies?key=axis.board&limit=1`, opts),
    { data: [] as Array<{ valueJson: unknown }> }
  );
  const row = got.data[0];
  if (!row) return {};
  const parsed = jsonOf(row.valueJson);
  if (!parsed || typeof parsed !== "object") return {};
  const wipWarn = (parsed as { wipWarn?: unknown }).wipWarn;
  if (!wipWarn || typeof wipWarn !== "object") return {};
  const out: Partial<Record<Lane, number>> = {};
  for (const lane of LANES) {
    const value = (wipWarn as Record<string, unknown>)[lane];
    if (typeof value === "number" && Number.isFinite(value)) out[lane] = value;
  }
  return out;
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const lanes = LANES.join(",");

  // One list call for the cards and one for the true depths. `count=true`
  // returns the total behind the page, which is what a WIP number has to mean —
  // a count of the rows that fit on screen would always look healthy.
  const [page, totals, wipWarn] = await Promise.all([
    safe(
      api<{ data: BoardCase[] }>(
        `/v1/axis/cases?status=${lanes}&sort=slaDueAt&order=asc&limit=${BOARD_PAGE}`,
        opts
      ),
      { data: [] as BoardCase[] }
    ),
    Promise.all(
      LANES.map(async (lane) => {
        const got = await safe(
          api<{ total?: number }>(`/v1/axis/cases?status=${lane}&count=true&limit=1`, opts),
          {}
        );
        return [lane, got.total ?? 0] as const;
      })
    ),
    boardWipWarn(opts)
  ]);

  // Owner is a `user:us_…` ref with no display text, so the card footer read a
  // ULID where a colleague's name belongs.
  const resolved = await names(page.data.map((card) => card.ownerRef), opts);
  // The assign form took a typed `user:us_…`, which nobody knows (ADR-0047).
  const assignees = await directory(opts);

  return {
    now: Date.now(),
    names: resolved,
    assignees,
    cases: page.data,
    counts: Object.fromEntries(totals) as Partial<Record<Lane, number>>,
    wipWarn
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
  const id = String(form.get("caseId") ?? "").trim();

  // The board offers exactly two writes: `assign` (owner) and `transition`
  // (state machine + approval gate, axis-case-lifecycle.ts). Anything else —
  // a free-form status drag included — has no state machine behind it and
  // must stay refused.
  if (intent === "assign") {
    const ownerRef = String(form.get("ownerRef") ?? "").trim();
    if (!id || !ownerRef) return refuse("missing_owner");

    try {
      await api(`/v1/axis/cases/${encodeURIComponent(id)}`, {
        env,
        request,
        method: "PATCH",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { ownerRef }
      });
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }

    return { problem: null, done: "assign" };
  }

  if (intent === "transition") {
    const to = String(form.get("to") ?? "").trim();
    if (!id || !to) return refuse("missing_target");

    try {
      await api(`/v1/axis/cases/${encodeURIComponent(id)}/transition`, {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: { to }
      });
    } catch (error) {
      if (error instanceof ApiError) return { problem: error.problem, done: null };
      throw error;
    }

    return { problem: null, done: "transition" };
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

export default function AxisBoard() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const l = labelsIn(shell?.locale ?? "en", shell?.domainPack);
  const held = new Set(shell?.permissions ?? []);
  const busy = navigation.state !== "idle";
  const now = loaded.now;

  const lanes = laneViews(loaded.cases, now, loaded.counts, loaded.wipWarn);
  const total = lanes.reduce((sum, lane) => sum + lane.open, 0);
  const breached = lanes.reduce(
    (sum, lane) => sum + lane.cards.filter((card) => isLate(card, now)).length,
    0
  );
  const congested = lanes.filter((lane) => lane.congested).length;
  const worst = lanes.flatMap((lane) => lane.cards).sort(byUrgency(now))[0];
  const headline = headlineFor({ total, breached, congested }, l);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-serif text-22 leading-[1.2] text-text">{headline}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
        {worst ? (
          <Link to={`/axis/cases/${worst.id}`} className="w-fit font-ui text-13 text-accent underline">
            {l("headline.open", { ref: worst.ref })}
          </Link>
        ) : null}
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {result?.done ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`done.${result.done}`)}
        </p>
      ) : null}

      <GuardrailNotice
        title={l("readonly.title")}
        reason={l("readonly.reason")}
        tone="info"
        action={
          <Button asChild size="sm" variant="ghost">
            <Link to="/axis/cases">{l("readonly.action")}</Link>
          </Button>
        }
      />

      {total === 0 ? (
        <EmptyState title={l("empty.title")} body={l("empty.body")} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {lanes.map((lane) => (
            <section
              key={lane.lane}
              aria-label={l(`lane.${lane.lane}`)}
              className="flex flex-col gap-2 rounded-lg border border-border bg-surface-1 p-3"
            >
              <header className="flex items-baseline justify-between gap-2">
                <h2 className="font-ui text-13 font-medium text-text">{l(`lane.${lane.lane}`)}</h2>
                <Badge tone={lane.congested ? "warning" : "neutral"} size="sm">
                  {lane.open}
                </Badge>
              </header>
              <p className="font-ui text-12 text-subtle">
                {lane.congested
                  ? l("wip.congested", { open: String(lane.open), limit: String(lane.warnAt) })
                  : l("wip.count", { open: String(lane.open) })}
              </p>

              <ul className="flex flex-col gap-2">
                {lane.cards.map((card) => {
                  const flag = flagOf(card, now);
                  const nextStates = CASE_TRANSITIONS[card.status] ?? [];
                  return (
                    <li key={card.id} className="flex flex-col gap-1">
                      <Link
                        to={`/axis/cases/${card.id}`}
                        className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-2 hover:border-accent-line"
                      >
                        <span className="flex items-center justify-between gap-2">
                          <Ref value={card.ref} className="text-12 text-accent" />
                          {flag ? (
                            <Badge tone={flag.tone} size="sm" dot>
                              {l(flag.key)}
                            </Badge>
                          ) : null}
                        </span>
                        <span className="font-ui text-12 text-muted">{card.kind}</span>
                        {/* AXIS-008's explainable ordering: the three factors
                            behind this card's place in the lane, restated as
                            0-100 so the order is checkable at a glance. */}
                        {(() => {
                          const score = priorityScore(card, now);
                          const value = Math.round(Math.min(1, (card.valueMinor ?? 0) / WEIGHTS.valueCapMinor) * 100);
                          const risk = Math.round(((card.riskScore ?? 50) / 100) * 100);
                          const sla = Math.round(
                            ((card.slaDueAt == null
                              ? 0.5
                              : card.slaDueAt <= now
                                ? 1
                                : Math.max(0, 1 - (card.slaDueAt - now) / WEIGHTS.slaHorizonMs)) * 100)
                          );
                          return (
                            <span
                              className="font-mono text-12 text-subtle"
                              title={l("rank.title")}
                            >
                              {l("rank.why", {
                                value: String(value),
                                risk: String(risk),
                                sla: String(sla)
                              })}
                              {" · "}
                              {Math.round(score * 100)}
                            </span>
                          );
                        })()}
                        <span className="flex items-center justify-between gap-2 font-ui text-12 text-subtle">
                          <span>{who(card.ownerRef, loaded.names) ?? l("unassigned")}</span>
                          {card.valueMinor !== null && card.currency ? (
                            <Money
                              amountMinor={card.valueMinor}
                              currency={card.currency}
                              locale={shell?.locale ?? "en"}
                            />
                          ) : null}
                        </span>
                      </Link>
                      {held.has(PERM.write) && nextStates.length ? (
                        <Form method="post" className="flex items-center gap-2">
                          <input type="hidden" name="intent" value="transition" />
                          <input type="hidden" name="caseId" value={card.id} />
                          <Select
                            name="to"
                            aria-label={l("transition.to")}
                            options={nextStates.map((state) => ({
                              value: state,
                              label: (LANES as readonly string[]).includes(state)
                                ? l(`lane.${state}`)
                                : l("state.cancelled")
                            }))}
                          />
                          <Button type="submit" size="sm" variant="ghost" loading={busy}>
                            {l("transition.submit")}
                          </Button>
                        </Form>
                      ) : null}
                    </li>
                  );
                })}
              </ul>

              {lane.open > lane.cards.length ? (
                <p className="font-ui text-12 text-subtle">
                  {l("overflow", { more: String(lane.open - lane.cards.length) })}
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}

      {held.has(PERM.write) && loaded.cases.length ? (
        <Card title={l("assign.title")}>
          <Form method="post" className="flex flex-wrap items-end gap-4">
            <input type="hidden" name="intent" value="assign" />
            <Field label={l("assign.case")} className="w-64">
              <Select
                name="caseId"
                options={loaded.cases.map((row) => ({ value: row.id, label: row.ref }))}
              />
            </Field>
            <Field label={l("assign.owner")} hint={l("assign.intro")} className="w-64">
              <Select
                name="ownerRef"
                placeholder={l("assign.pick")}
                options={loaded.assignees.map((one) => ({ value: one.ref, label: one.name }))}
              />
            </Field>
            <Button type="submit" variant="secondary" loading={busy}>
              {l("assign.submit")}
            </Button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}

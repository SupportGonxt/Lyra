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
  AutoGrid,
  Badge,
  Button,
  DateTime,
  EmptyState,
  Field,
  Input,
  Panel,
  Provenance,
  Table,
  Textarea,
  type Column
} from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import { ConfirmButton } from "../components/confirm";
import { WorkLayout } from "../components/work-layout";
import {
  labelsFrom,
  parsed,
  readable,
  refuse,
  refused,
  type ActionResult,
  type Labels,
  type Page
} from "./north-shared";

// Decisions (docs/modules/north.md §4 screen 6, §2.6): the register of what was
// decided, by whom, against which options — and the queue of the ones whose
// review date has come round.
//
// NORTH nags; it does not decide. The outcome review is written by a person
// here, because closing a decision is a claim about whether it worked, and
// nobody but the owner gets to make that claim.

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:decisions:read",
  write: "north:decisions:write"
} as const;

const PAGE = 100;
const DAY = 86_400_000;
/** A fortnight's warning: long enough to gather the evidence the review needs. */
const SOON = 14 * DAY;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Decisions",
    kicker: "What was decided, and what it did",
    intro:
      "Every significant call, the options it was weighed against, and the date somebody promised to look again. NORTH raises the ones that are due; the verdict is yours to write.",
    "headline.overdue": "{count} decision reviews are overdue.",
    "headline.due": "{count} decision reviews are due.",
    "headline.soon": "{count} decision reviews are coming up.",
    "headline.clear": "Nothing is due for review.",
    "queue.title": "Open",
    "queue.body": "Open decisions, soonest review first.",
    "log.title": "The log",
    "log.caption": "Every recorded decision, with its owner, review date and outcome",
    "state.overdue": "Review overdue",
    "state.due": "Review due",
    "state.soon": "Review coming up",
    "card.owner": "Owner",
    "card.review": "Review",
    "card.context": "Context",
    "card.recorded": "Recorded",
    "card.chosen": "Chosen",
    "card.undated": "No review date",
    "card.options": "Options weighed",
    "card.options.none": "No options were recorded against this decision.",
    "outcome.title": "Outcome",
    "col.title": "Decision",
    "col.owner": "Owner",
    "col.review": "Review",
    "col.status": "Status",
    "col.chosen": "Chosen",
    // Statuses, not verbs: the shared catalogue's `open` is the action
    // ("Open" a record) and reads فتح in Arabic, where this column means
    // مفتوح — the state a decision is still in.
    "status.open": "Open",
    "status.reviewed": "Reviewed",
    "status.reversed": "Reversed",
    "record.eyebrow": "Record a decision",
    "record.lede": "One line on what was decided, who owns it, and when it gets looked at again.",
    "record.title": "Decision",
    "record.title.hint": "What was decided, in a sentence somebody outside the room can read.",
    "record.owner": "Owner",
    "record.owner.hint": "The person who answers for it at the review.",
    "record.review": "Review date",
    "record.review.hint": "When to look again. Leave empty only if there is genuinely nothing to check.",
    "record.context": "Context reference",
    "record.context.hint": "A briefing, anomaly or scenario this came out of. Optional.",
    "record.options": "Options weighed",
    "record.options.hint": "One per line. What else was on the table matters as much as what won.",
    "record.submit": "Record it",
    "close.chosen": "What was chosen",
    "close.chosen.hint": "The option that was taken, in its own words.",
    "close.note": "What happened",
    "close.note.hint": "The outcome review. What the numbers did, and whether the call held.",
    "close.reviewed": "Close as reviewed",
    "close.reversed": "Close as reversed",
    "close.confirm": "Close this decision? The outcome is recorded against it and the decision leaves the open list. Reopening is not something this screen can do.",
    "none.title": "Nothing decided yet",
    "none.body": "No decision has been recorded. The first one to log is the one you are about to argue about again.",
    denied: "You do not have permission to read the decision log. Ask a tenant administrator for Insight decision access.",
    "saved.recorded": "Decision recorded.",
    "saved.reviewed": "Outcome recorded — decision closed as reviewed.",
    "saved.reversed": "Outcome recorded — decision closed as reversed.",
    approvalTitle: "Queued for approval",
    approvalBody: "This write needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_id": "That decision could not be identified.",
    "problem.missing_title": "Say what was decided — a log line with no decision in it helps nobody.",
    "problem.missing_owner": "Put a name to it. A decision nobody owns has nobody to answer at the review.",
    "problem.missing_chosen": "Say which option was taken before closing it.",
    "problem.missing_note": "Write the outcome. Closing a decision without one loses the only thing worth keeping.",
    "problem.bad_date": "That review date could not be read.",
    "problem.bad_intent": "That form did not carry a recognised action."
  },
  ar: {
    title: "القرارات",
    kicker: "ما تقرّر، وما الذي فعله",
    intro:
      "كل قرار مهم، والخيارات التي وُزن أمامها، والتاريخ الذي وعد فيه أحدهم بالمراجعة. نورث يذكّر بما حان موعده؛ والحكم عليك أن تكتبه.",
    "headline.overdue": "{count} مراجعات قرارات متأخرة.",
    "headline.due": "{count} مراجعات قرارات مستحقة الآن.",
    "headline.soon": "{count} مراجعات قرارات تقترب.",
    "headline.clear": "لا شيء يستحق المراجعة الآن.",
    "queue.title": "المفتوحة",
    "queue.body": "القرارات المفتوحة، الأقرب موعداً أولاً.",
    "log.title": "السجل",
    "log.caption": "كل قرار مسجَّل، مع مسؤوله وتاريخ مراجعته ونتيجته",
    "state.overdue": "المراجعة متأخرة",
    "state.due": "المراجعة مستحقة",
    "state.soon": "المراجعة قريبة",
    "card.owner": "المسؤول",
    "card.review": "المراجعة",
    "card.context": "السياق",
    "card.recorded": "سُجِّل",
    "card.chosen": "المختار",
    "card.undated": "بلا تاريخ مراجعة",
    "card.options": "الخيارات الموزونة",
    "card.options.none": "لم تُسجَّل خيارات مع هذا القرار.",
    "outcome.title": "النتيجة",
    "col.title": "القرار",
    "col.owner": "المسؤول",
    "col.review": "المراجعة",
    "col.status": "الحالة",
    "col.chosen": "المختار",
    "status.open": "مفتوح",
    "status.reviewed": "مُراجَع",
    "status.reversed": "معكوس",
    "record.eyebrow": "سجّل قراراً",
    "record.lede": "سطر واحد عمّا تقرّر، ومن يملكه، ومتى يُعاد النظر فيه.",
    "record.title": "القرار",
    "record.title.hint": "ما تقرّر، بجملة يفهمها من لم يحضر الاجتماع.",
    "record.owner": "المسؤول",
    "record.owner.hint": "من يجيب عنه في المراجعة.",
    "record.review": "تاريخ المراجعة",
    "record.review.hint": "متى يُعاد النظر. اتركه فارغاً فقط إن لم يكن هناك ما يُراجع فعلاً.",
    "record.context": "مرجع السياق",
    "record.context.hint": "إحاطة أو حالة شاذة أو سيناريو نشأ عنه القرار. اختياري.",
    "record.options": "الخيارات الموزونة",
    "record.options.hint": "خيار في كل سطر. ما كان مطروحاً لا يقلّ أهمية عمّا فاز.",
    "record.submit": "سجّله",
    "close.chosen": "ما الذي اختير",
    "close.chosen.hint": "الخيار الذي اتُّخذ، بكلماته.",
    "close.note": "ماذا حدث",
    "close.note.hint": "مراجعة النتيجة. ماذا فعلت الأرقام، وهل صمد القرار.",
    "close.reviewed": "أغلقه كمُراجَع",
    "close.reversed": "أغلقه كمعكوس",
    "close.confirm": "هل تريد إغلاق هذا القرار؟ ستُسجَّل النتيجة عليه وسيغادر قائمة القرارات المفتوحة. إعادة الفتح ليست شيئاً تستطيع هذه الشاشة فعله.",
    "none.title": "لا قرارات بعد",
    "none.body": "لم يُسجَّل أي قرار. أول ما يُسجَّل هو ما ستختلفون عليه مرة أخرى.",
    denied: "لا تملك صلاحية قراءة سجل القرارات. اطلب من مدير المؤسسة صلاحية قرارات التحليلات التنفيذية.",
    "saved.recorded": "سُجِّل القرار.",
    "saved.reviewed": "سُجِّلت النتيجة — أُغلق القرار كمُراجَع.",
    "saved.reversed": "سُجِّلت النتيجة — أُغلق القرار كمعكوس.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "تحتاج هذه الكتابة موافقة بموجب سياسة {policy}. هي في الانتظار ولم تُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_id": "تعذّر تحديد هذا القرار.",
    "problem.missing_title": "قل ما الذي تقرّر — سطر سجل بلا قرار لا يفيد أحداً.",
    "problem.missing_owner": "ضع اسماً عليه. القرار بلا مالك لا يجد من يجيب في المراجعة.",
    "problem.missing_chosen": "قل أي خيار اتُّخذ قبل الإغلاق.",
    "problem.missing_note": "اكتب النتيجة. إغلاق القرار بدونها يُفقد الشيء الوحيد الجدير بالحفظ.",
    "problem.bad_date": "تعذّر قراءة تاريخ المراجعة.",
    "problem.bad_intent": "لم يحمل هذا النموذج إجراءً معروفاً."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface Decision {
  id: string;
  title: string;
  contextRef: string | null;
  optionsJson: unknown;
  chosen: string | null;
  owner: string;
  reviewAt: number | null;
  outcomeReviewJson: unknown;
  status: string;
  createdAt: number;
  updatedAt: number;
}

interface Outcome {
  note?: string;
  by?: string;
  at?: number;
}

export interface DecisionOption {
  key: string;
  label: string;
}

/* ----------------------------------------------------------------- helpers */

/**
 * How loudly the queue should nag. A closed decision never nags, and neither
 * does an undated one — there is no date to be late for, so it sits in the open
 * list unbadged rather than pretending to be urgent.
 */
export function queueState(
  decision: Pick<Decision, "status" | "reviewAt">,
  now: number
): "overdue" | "due" | "soon" | null {
  if (decision.status !== "open" || typeof decision.reviewAt !== "number") return null;
  const delta = decision.reviewAt - now;
  if (delta < -DAY) return "overdue";
  if (delta <= 0) return "due";
  return delta <= SOON ? "soon" : null;
}

/**
 * `options_json` holds two vintages: the seed writes `{key, label, costMinor}`
 * objects (packages/core/src/seed.ts), while this screen writes what somebody
 * typed. Cost belongs to the decision engine, not to the register, so it is not
 * rendered — the log records what was weighed, not what it was priced at.
 */
export function readOptions(raw: unknown): DecisionOption[] {
  const rows = parsed<unknown>(raw, null);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (typeof row === "string") {
      const label = row.trim();
      return label ? [{ key: label, label }] : [];
    }
    if (!row || typeof row !== "object") return [];
    const one = row as Record<string, unknown>;
    const label = typeof one.label === "string" ? one.label : typeof one.key === "string" ? one.key : null;
    if (!label) return [];
    return [{ key: typeof one.key === "string" ? one.key : label, label }];
  });
}

/** One typed line per option, keyed so a later reader can reference one. */
export function optionsFrom(text: string): DecisionOption[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""), label }));
}

const TONE: Record<"overdue" | "due" | "soon", "danger" | "warning" | "info"> = {
  overdue: "danger",
  due: "warning",
  soon: "info"
};

/**
 * How the open queue tallies by urgency — the same read `queueState` gives
 * each card, rolled up for the header's headline.
 */
export function dueCounts(
  open: Pick<Decision, "status" | "reviewAt">[],
  now: number
): Record<"overdue" | "due" | "soon", number> {
  return open.reduce(
    (acc, decision) => {
      const state = queueState(decision, now);
      if (state) acc[state] += 1;
      return acc;
    },
    { overdue: 0, due: 0, soon: 0 } as Record<"overdue" | "due" | "soon", number>
  );
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const page = await readable(
    api<Page<Decision>>(`/v1/north/decisions?sort=reviewAt&order=asc&limit=${PAGE}`, { env, request })
  );
  return {
    decisions: page?.data ?? null,
    // Fixed on the server so the queue reads the same before and after hydration.
    now: Date.now(),
    idempotencyKey: crypto.randomUUID()
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { headers: { "idempotency-key": key } } : {};

  if (intent === "record") {
    const title = String(form.get("title") ?? "").trim();
    const owner = String(form.get("owner") ?? "").trim();
    if (!title) return refuse("missing_title");
    if (!owner) return refuse("missing_owner");

    const day = String(form.get("reviewAt") ?? "").trim();
    // `<input type="date">` yields "2026-09-12"; read it as UTC midnight so the
    // stored instant does not move with whoever is typing.
    const reviewAt = day ? Date.parse(`${day}T00:00:00Z`) : null;
    if (reviewAt !== null && Number.isNaN(reviewAt)) return refuse("bad_date");

    const contextRef = String(form.get("contextRef") ?? "").trim();
    const options = optionsFrom(String(form.get("options") ?? ""));
    try {
      await api("/v1/north/decisions", {
        env,
        request,
        method: "POST",
        ...headers,
        body: {
          title,
          owner,
          reviewAt,
          contextRef: contextRef || null,
          optionsJson: options.length > 0 ? options : null
        }
      });
    } catch (error) {
      return refused(error);
    }
    return { problem: null, saved: "recorded" };
  }

  const status = intent === "reviewed" || intent === "reversed" ? intent : null;
  if (!status) return refuse("bad_intent");

  const id = String(form.get("id") ?? "").trim();
  const chosen = String(form.get("chosen") ?? "").trim();
  const note = String(form.get("note") ?? "").trim();
  const owner = String(form.get("owner") ?? "").trim();
  if (!id) return refuse("missing_id");
  if (!chosen) return refuse("missing_chosen");
  // The outcome is the whole point of the review date; closing without one
  // turns the register back into a list of dates nobody kept.
  if (!note) return refuse("missing_note");

  try {
    await api(`/v1/north/decisions/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      ...headers,
      body: { status, chosen, outcomeReviewJson: { note, by: owner, at: Date.now() } }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: status };
}

/* --------------------------------------------------------------- the screen */

export default function NorthDecisions() {
  const { decisions, now, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const canWrite = new Set(shell?.permissions ?? []).has(PERM.write);

  // An approval hold is a state, not a failure, so it goes to Gate untranslated
  // and everything else gets this screen's own copy for the refusal code.
  const shown =
    result?.problem && result.problem.code !== "approval_required"
      ? {
          title: l(`problem.${result.problem.code ?? ""}`),
          status: result.problem.status,
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : (result?.problem ?? null);

  const rows = decisions ?? [];
  // The API sorts by reviewAt ascending, which puts the undated ones first in
  // SQLite. They are the least urgent thing on the screen, so they go last.
  const open = rows
    .filter((row) => row.status === "open")
    .sort((a, b) => (a.reviewAt ?? Number.POSITIVE_INFINITY) - (b.reviewAt ?? Number.POSITIVE_INFINITY));

  // The headline narrates today's queue rather than repeating the title above
  // it. It's arithmetic over `queueState` — the same read each card below
  // performs — not an agent's judgement, so it carries no ✦ (CLAUDE.md §11
  // reserves the mark for AI-authored text).
  const counts = dueCounts(open, now);
  const headline = counts.overdue
    ? l("headline.overdue", { count: String(counts.overdue) })
    : counts.due
      ? l("headline.due", { count: String(counts.due) })
      : counts.soon
        ? l("headline.soon", { count: String(counts.soon) })
        : l("headline.clear");

  const columns: Column<Decision>[] = [
    { key: "title", header: l("col.title"), render: (row) => row.title },
    { key: "owner", header: l("col.owner"), render: (row) => row.owner },
    {
      key: "reviewAt",
      header: l("col.review"),
      render: (row) =>
        typeof row.reviewAt === "number" ? (
          <DateTime value={row.reviewAt} locale={locale} precision="day" />
        ) : (
          <span className="text-subtle">—</span>
        )
    },
    {
      key: "status",
      header: l("col.status"),
      render: (row) => <Badge tone={row.status === "open" ? "neutral" : "success"}>{l(`status.${row.status}`)}</Badge>
    },
    { key: "chosen", header: l("col.chosen"), render: (row) => row.chosen ?? <span className="text-subtle">—</span> }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="eyebrow">{l("kicker")}</span>
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        {open.length > 0 ? (
          <Link to="/approvals" className="w-fit font-ui text-13 text-accent underline">
            {l("approvalLink")}
          </Link>
        ) : null}
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`saved.${result.saved}`)}
        </p>
      ) : null}

      {decisions === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : (
        <WorkLayout
          aside={
            canWrite ? (
              <Panel module="north" eyebrow={l("record.eyebrow")} lede={l("record.lede")}>
                <Form method="post" className="flex flex-col gap-3">
                  <input type="hidden" name="intent" value="record" />
                  <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                  <Field label={l("record.title")} hint={l("record.title.hint")}>
                    <Input name="title" required aria-label={l("record.title")} />
                  </Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={l("record.owner")} hint={l("record.owner.hint")}>
                      <Input name="owner" required aria-label={l("record.owner")} />
                    </Field>
                    <Field label={l("record.review")} hint={l("record.review.hint")}>
                      <Input type="date" name="reviewAt" aria-label={l("record.review")} />
                    </Field>
                  </div>
                  <Field label={l("record.context")} hint={l("record.context.hint")}>
                    <Input name="contextRef" aria-label={l("record.context")} />
                  </Field>
                  <Field label={l("record.options")} hint={l("record.options.hint")}>
                    <Textarea name="options" rows={3} aria-label={l("record.options")} />
                  </Field>
                  <div>
                    <Button type="submit" disabled={busy}>
                      {l("record.submit")}
                    </Button>
                  </div>
                </Form>
              </Panel>
            ) : null
          }
        >
          {open.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="section-title">{l("queue.title")}</h2>
              <p className="font-ui text-13 text-subtle">{l("queue.body")}</p>
              <AutoGrid min="24rem">
                {open.map((decision) => (
                  <DecisionCard
                    key={decision.id}
                    decision={decision}
                    now={now}
                    locale={locale}
                    l={l}
                    busy={busy}
                    canWrite={canWrite}
                    idempotencyKey={idempotencyKey}
                  />
                ))}
              </AutoGrid>
            </section>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="section-title">{l("log.title")}</h2>
            {rows.length === 0 ? (
              <EmptyState title={l("none.title")} body={l("none.body")} />
            ) : (
              <Table columns={columns} rows={rows} rowKey={(row) => row.id} caption={l("log.caption")} />
            )}
          </section>
        </WorkLayout>
      )}
    </div>
  );
}

function DecisionCard({
  decision,
  now,
  locale,
  l,
  busy,
  canWrite,
  idempotencyKey
}: {
  decision: Decision;
  now: number;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
  busy: boolean;
  canWrite: boolean;
  idempotencyKey: string;
}) {
  const state = queueState(decision, now);
  const options = readOptions(decision.optionsJson);
  const outcome = parsed<Outcome | null>(decision.outcomeReviewJson, null);

  return (
    <Panel
      module="north"
      eyebrow={decision.title}
      actions={state ? <Badge tone={TONE[state]} dot>{l(`state.${state}`)}</Badge> : null}
    >
      <div className="flex flex-col gap-4">
        <Provenance
          rows={[
            { label: l("card.owner"), value: decision.owner },
            {
              label: l("card.review"),
              value:
                typeof decision.reviewAt === "number" ? (
                  <DateTime value={decision.reviewAt} locale={locale} precision="day" />
                ) : (
                  l("card.undated")
                )
            },
            { label: l("card.recorded"), value: <DateTime value={decision.createdAt} locale={locale} precision="day" /> },
            ...(decision.contextRef ? [{ label: l("card.context"), value: decision.contextRef, mono: true }] : []),
            ...(decision.chosen ? [{ label: l("card.chosen"), value: decision.chosen }] : [])
          ]}
        />

        <section className="flex flex-col gap-2">
          <h3 className="eyebrow">{l("card.options")}</h3>
          {options.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("card.options.none")}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {options.map((option) => (
                <li key={option.key} className="font-ui text-13 text-text">
                  {option.label}
                </li>
              ))}
            </ul>
          )}
        </section>

        {outcome?.note ? (
          <section className="flex flex-col gap-1">
            <h3 className="eyebrow">{l("outcome.title")}</h3>
            <p className="font-ui text-13 text-text">{outcome.note}</p>
          </section>
        ) : null}

        {canWrite ? (
          <Form method="post" className="flex flex-col gap-3 border-t border-border pt-3">
            <input type="hidden" name="id" value={decision.id} />
            <input type="hidden" name="owner" value={decision.owner} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Field label={l("close.chosen")} hint={l("close.chosen.hint")}>
              <Input name="chosen" defaultValue={decision.chosen ?? ""} aria-label={l("close.chosen")} />
            </Field>
            <Field label={l("close.note")} hint={l("close.note.hint")}>
              <Textarea name="note" rows={3} aria-label={l("close.note")} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <ConfirmButton
                type="submit"
                name="intent"
                value="reviewed"
                disabled={busy}
                message={l("close.confirm")}
              >
                {l("close.reviewed")}
              </ConfirmButton>
              <ConfirmButton
                type="submit"
                name="intent"
                value="reversed"
                variant="secondary"
                disabled={busy}
                message={l("close.confirm")}
              >
                {l("close.reversed")}
              </ConfirmButton>
            </div>
          </Form>
        ) : null}
      </div>
    </Panel>
  );
}

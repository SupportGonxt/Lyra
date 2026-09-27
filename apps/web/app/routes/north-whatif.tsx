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
  DateTime,
  EmptyState,
  Field,
  Input,
  Money,
  Panel,
  Provenance,
  Table,
  Textarea
} from "@lyra/ui";
import { api, type ApiOptions } from "../api.server";
import { ApiError } from "../api-error";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { FALLBACK_CURRENCY } from "../calendar";
import { useNorthSessionData } from "./north-shell";
import { WorkLayout } from "../components/work-layout";
import {
  labelsFrom,
  parsed,
  readable,
  refuse,
  refused,
  MetricValue,
  metricText,
  pct,
  type ActionResult,
  type Labels,
  type MetricUnit,
  type Page
} from "./north-shared";

// Scenarios (docs/modules/north.md §4 screen 4): the ask bar, the assumptions
// the answer rests on, and the saved library.
//
// §2.4's guardrail is that a simulation always shows its assumption provenance
// and a confidence band — no point estimate without a range. The scenario
// engine (docs/30 NORTH 4, ADR-0103; apps/api/src/engines/north-scenario.ts)
// answers a scenario whose assumptions name a driver — `metric`, `changeBps`,
// `horizonMonths` (or `horizonDays`) — with the metric's own forecast band and
// the same band shifted. Saving asks it at once; "Compute" asks again against
// newer snapshots. Assumptions it cannot read are named back, line by line.
// A stored result no engine produced (older rows) still renders, with the plain
// warning that it is a point estimate with no band behind it — the screen does
// not invent a range for it. Arithmetic, not a model: no ✦ (CLAUDE.md §11).

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:scenarios:read",
  run: "north:scenarios:run"
} as const;

const PAGE = 50;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Scenarios",
    kicker: "What if — asked once, kept for the next person who asks it",
    "link.brief": "The Brief",
    intro:
      "A scenario is a question plus the assumptions it rests on. Both are stored so the answer can be argued with later, which is the only kind of answer worth keeping.",
    "ask.title": "Ask a what-if",
    "ask.question": "The question",
    "ask.question.hint": "Plain words. “What if we move a fifth of the motor book onto the panel?”",
    "ask.assumptions": "Assumptions",
    "ask.assumptions.hint":
      "One per line, as name: value. To have it computed, name a metric, a changeBps (1000 is +10%, -500 is −5%) and a horizonMonths — horizonDays for a daily metric. A value ending Minor is money in minor units, Bps basis points, Ppm parts per million, Ms milliseconds.",
    "ask.author": "Asked by",
    "ask.author.hint": "Recorded against the scenario so the next reader knows whose question it was.",
    "ask.submit": "Save the question",
    "ask.note":
      "Saving records the question and its assumptions, then computes it: the metric's own forecast band, and the same band with the change applied. Assumptions the computation does not read stay on the scenario, marked as unused.",
    "library.title": "Saved scenarios",
    "library.caption": "Every scenario asked in this tenant, most recent first",
    "library.question": "Question",
    "library.author": "Asked by",
    "library.asked": "Asked",
    "library.result": "Result",
    "library.open": "Open",
    "result.yes": "Answered",
    "result.computed": "Computed",
    "result.no": "Unanswered",
    "detail.assumptions": "What it assumes",
    "detail.result": "What it answers",
    "detail.result.none":
      "Nothing has answered this yet. The question and its assumptions are stored; computing it projects the metric they name.",
    "detail.shared": "Shared with",
    "detail.run": "Model run",
    "detail.unset": "Not recorded",
    "detail.point":
      "These are point estimates. No confidence band was stored with them, so read them as a single line through a range nobody has measured.",
    "run.submit": "Compute",
    "run.again": "Compute again from the latest figures",
    "run.needs": "It could not be computed from these assumptions:",
    "need.missing": "{name} is missing.",
    "need.unknown": "{name} names no metric this tenant keeps.",
    "need.unsupported_grain": "{name} is kept at a grain nothing projects yet — only daily and monthly metrics.",
    "need.not_integer": "{name} must be a whole number.",
    "need.out_of_range": "{name} is outside what the engine projects: a change of −100% to +1000%, a horizon of 1 to 36.",
    "answer.metric": "Metric",
    "answer.change": "Change applied",
    "answer.horizon": "Projected",
    "horizon.month": "{count} months",
    "horizon.day": "{count} days",
    "answer.asOf": "Projected from",
    "answer.observations": "Closed periods read",
    "answer.band": "Band",
    "band.empirical": "Measured from how the forecast missed on held-out periods",
    "band.default": "The default ±25%, widening with distance — too little history to measure one",
    "answer.ignored": "Stated but not used",
    "answer.computed": "Computed",
    "answer.caption": "The forecast as it stands, and with the change applied, per period",
    "col.period": "Period",
    "col.baseline": "As it stands",
    "col.scenario": "With the change",
    "col.delta": "Difference",
    "answer.range": "{p10} to {p90}",
    "answer.none":
      "There is no baseline to shift: {metric} has {count} closed periods on record and a projection needs at least four. Nothing has been estimated in their place.",
    "answer.note":
      "Every figure is the middle of a range: the band beneath it runs from the 10th to the 90th percentile of the metric's own forecast. The change is applied as stated; the uncertainty is the baseline's.",
    "none.title": "No scenarios have been asked",
    "none.body": "The first question somebody writes down is the first one anybody else can argue with.",
    denied: "You do not have permission to read scenarios. Ask a tenant administrator for Insight scenario access.",
    saved: "Scenario saved.",
    ran: "Scenario computed.",
    approvalTitle: "Queued for approval",
    approvalBody: "Saving this scenario needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_question": "Write the question out — a scenario without one cannot be argued with later.",
    "problem.missing_author": "Put your name to it.",
    "problem.missing_scenario": "Choose a scenario to compute.",
    "problem.bad_assumptions":
      "Assumptions are read one per line as name: value. One of these lines carried no name."
  },
  ar: {
    title: "السيناريوهات",
    kicker: "ماذا لو — يُسأل مرة، ويبقى لمن يسأل بعدك",
    "link.brief": "الموجز",
    intro:
      "السيناريو سؤال مع الافتراضات التي يقوم عليها. كلاهما محفوظ حتى يمكن مناقشة الإجابة لاحقاً، وهي وحدها الإجابة التي تستحق الحفظ.",
    "ask.title": "اطرح سؤال ماذا لو",
    "ask.question": "السؤال",
    "ask.question.hint": "بكلمات بسيطة. «ماذا لو نقلنا خُمس محفظة المركبات إلى اللجنة؟»",
    "ask.assumptions": "الافتراضات",
    "ask.assumptions.hint":
      "افتراض في كل سطر بصيغة الاسم: القيمة. ليُحسب، اذكر metric وchangeBps (‏1000 تعني ‎+10%‎، و‎-500‎ تعني ‎−5%‎) وhorizonMonths — أو horizonDays لمؤشر يومي. القيمة المنتهية بـ Minor مبلغ بالوحدات الصغرى، وBps نقاط أساس، وPpm أجزاء من مليون، وMs مللي ثانية.",
    "ask.author": "السائل",
    "ask.author.hint": "يُسجَّل مع السيناريو ليعرف القارئ التالي صاحب السؤال.",
    "ask.submit": "احفظ السؤال",
    "ask.note":
      "الحفظ يسجّل السؤال وافتراضاته ثم يحسبه: نطاق التوقع للمؤشر نفسه، والنطاق ذاته بعد تطبيق التغيير. الافتراضات التي لا يقرؤها الحساب تبقى مع السيناريو معلَّمة بأنها غير مستخدمة.",
    "library.title": "السيناريوهات المحفوظة",
    "library.caption": "كل سيناريو طُرح في هذه المؤسسة، الأحدث أولاً",
    "library.question": "السؤال",
    "library.author": "السائل",
    "library.asked": "وقت الطرح",
    "library.result": "النتيجة",
    "library.open": "افتح",
    "result.yes": "مُجاب",
    "result.computed": "محسوب",
    "result.no": "بلا إجابة",
    "detail.assumptions": "ما يفترضه",
    "detail.result": "ما يجيب به",
    "detail.result.none":
      "لم يُجب أحد عن هذا بعد. السؤال وافتراضاته محفوظة، وحسابه يُسقط المؤشر الذي تذكره.",
    "detail.shared": "مشارَك مع",
    "detail.run": "تشغيل النموذج",
    "detail.unset": "غير مسجل",
    "detail.point": "هذه تقديرات نقطية. لم يُحفظ معها نطاق ثقة، فاقرأها كخط واحد داخل مدى لم يقسه أحد.",
    "run.submit": "احسب",
    "run.again": "أعد الحساب من أحدث الأرقام",
    "run.needs": "تعذّر الحساب من هذه الافتراضات:",
    "need.missing": "{name} غير موجود.",
    "need.unknown": "{name} لا يسمّي مؤشراً تحتفظ به هذه المؤسسة.",
    "need.unsupported_grain": "{name} محفوظ بدرجة تفصيل لا يُسقطها شيء بعد — المؤشرات اليومية والشهرية فقط.",
    "need.not_integer": "{name} يجب أن يكون عدداً صحيحاً.",
    "need.out_of_range": "{name} خارج ما يُسقطه المحرك: تغيير من ‎−100%‎ إلى ‎+1000%‎، وأفق من 1 إلى 36.",
    "answer.metric": "المؤشر",
    "answer.change": "التغيير المطبَّق",
    "answer.horizon": "مدى الإسقاط",
    "horizon.month": "{count} شهراً",
    "horizon.day": "{count} يوماً",
    "answer.asOf": "أُسقط ابتداءً من",
    "answer.observations": "الفترات المغلقة المقروءة",
    "answer.band": "النطاق",
    "band.empirical": "مقيس من أخطاء التوقع على فترات محجوزة",
    "band.default": "النطاق الافتراضي ±25% يتّسع مع البُعد — التاريخ أقصر من أن يُقاس منه نطاق",
    "answer.ignored": "مذكور وغير مستخدم",
    "answer.computed": "حُسب",
    "answer.caption": "التوقع كما هو، ومع تطبيق التغيير، لكل فترة",
    "col.period": "الفترة",
    "col.baseline": "كما هو",
    "col.scenario": "مع التغيير",
    "col.delta": "الفرق",
    "answer.range": "من {p10} إلى {p90}",
    "answer.none":
      "لا يوجد أساس يُزاح: لدى {metric} ‏{count} فترات مغلقة مسجّلة، والإسقاط يحتاج أربعاً على الأقل. لم يُقدَّر شيء بدلاً منها.",
    "answer.note":
      "كل رقم هو وسط نطاق: النطاق تحته من المئين العاشر إلى التسعين لتوقع المؤشر نفسه. التغيير مطبَّق كما ذُكر؛ وعدم اليقين هو عدم يقين الأساس.",
    "none.title": "لم تُطرح أي سيناريوهات",
    "none.body": "أول سؤال يكتبه أحد هو أول سؤال يستطيع غيره مناقشته.",
    denied: "لا تملك صلاحية قراءة السيناريوهات. اطلب من مدير المؤسسة صلاحية سيناريوهات التحليلات التنفيذية.",
    saved: "حُفظ السيناريو.",
    ran: "حُسب السيناريو.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "حفظ هذا السيناريو يحتاج موافقة بموجب سياسة {policy}. هو في الانتظار ولم يُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_question": "اكتب السؤال — السيناريو بلا سؤال لا يمكن مناقشته لاحقاً.",
    "problem.missing_author": "ضع اسمك عليه.",
    "problem.missing_scenario": "اختر سيناريو لحسابه.",
    "problem.bad_assumptions": "تُقرأ الافتراضات سطراً سطراً بصيغة الاسم: القيمة. أحد هذه السطور بلا اسم."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface Scenario {
  id: string;
  question: string;
  // `*Json` columns: objects from the generic CRUD, text from a module route.
  // Read with parsed() (north-shared), never JSON.parse().
  assumptionsJson: unknown;
  resultJson: unknown;
  sharedWithJson: unknown;
  modelRunRef: string | null;
  author: string;
  createdAt: number;
}

interface Band {
  p10: number;
  p50: number;
  p90: number;
}

/**
 * What the scenario engine stores in `resultJson`. Mirrors `StoredScenarioResult`
 * in apps/api/src/engines/north-scenario.ts (itself `ScenarioResult` from
 * packages/core/src/north-scenario.ts plus unit, currency and computedAt) —
 * only the fields this screen reads.
 */
export interface ScenarioAnswer {
  method: "baseline_shift";
  metricKey: string;
  grain: "day" | "month";
  changeBps: number;
  horizon: number;
  points: { period: string; baseline: Band; scenario: Band; delta: Band }[];
  fit: { observations: number; intervalSource: "empirical" | "default"; lastObserved: string | null };
  ignored: string[];
  reason?: "insufficient_history";
  unit: MetricUnit;
  currency: string | null;
  computedAt: number;
}

/** One assumption the engine could not read, and why — the 422's `errors` map. */
export interface Need {
  name: string;
  reason: string;
}

type WhatIfResult = ActionResult & { ran?: string; needs?: Need[] };

/* ----------------------------------------------------------------- helpers */

/**
 * What a stored figure is denominated in, taken from the name it is stored
 * under. Scenario results are model output — the keys are whatever the question
 * needed — so there is no registry to look a unit up in, and a bare integer is
 * unreadable: `gwpDeltaMinor: 18600000` is money, `volumeUpliftBps: 1200` is
 * twelve percent, and printing either as itself is a defect.
 */
export function unitOf(key: string): "money" | "bps" | "ppm" | "ms" | "count" {
  if (key.endsWith("Minor")) return "money";
  if (key.endsWith("Bps")) return "bps";
  if (key.endsWith("Ppm")) return "ppm";
  if (key.endsWith("Ms")) return "ms";
  return "count";
}

const ACRONYMS = new Set(["gwp", "sla", "api", "cac", "ltv", "roi", "kpi", "p95"]);

/**
 * `gwpDeltaMinor` → `GWP delta`. The unit suffix is dropped because the value
 * beside it is already rendered in that unit, and the words are split rather
 * than looked up: these keys come from the model, so no label map can hold them.
 */
export function humanKey(key: string): string {
  const words = key
    .replace(/(Minor|Bps|Ppm|Ms)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean)
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.toLowerCase()));
  const first = words[0];
  if (!first) return key;
  return [ACRONYMS.has(first.toLowerCase()) ? first : first[0]!.toUpperCase() + first.slice(1), ...words.slice(1)].join(
    " "
  );
}

/**
 * `name: value` per line into the object the scenario stores. A value that
 * reads as a number is stored as one, so `horizonMonths: 6` does not come back
 * as the string "6" and sort like text. Blank lines are skipped; a line with no
 * name is a refusal, not a silently dropped assumption.
 */
export function readAssumptions(text: string): Record<string, string | number> | null {
  const out: Record<string, string | number> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const at = trimmed.indexOf(":");
    const name = at === -1 ? "" : trimmed.slice(0, at).trim();
    if (!name) return null;
    const raw = trimmed.slice(at + 1).trim();
    const asNumber = Number(raw.replace(/[_,\s]/g, ""));
    out[name] = raw !== "" && Number.isFinite(asNumber) ? asNumber : raw;
  }
  return out;
}

/**
 * The engine's answer, or null for anything else in `resultJson` — nothing, or
 * a figure stored by hand before there was an engine, which has no band and is
 * rendered as the point estimate it is.
 */
export function answerOf(raw: unknown): ScenarioAnswer | null {
  const value = parsed<Partial<ScenarioAnswer> | null>(raw, null);
  if (!value || value.method !== "baseline_shift" || !Array.isArray(value.points) || !value.fit) return null;
  return value as ScenarioAnswer;
}

/**
 * Which assumptions stopped the engine, from its 422. Only the keys and the
 * reason codes cross: the wording is this screen's, in the reader's language
 * (CLAUDE.md §7), the way `rejectedBy` treats a 400's field map.
 */
export function needsOf(error: unknown): Need[] | null {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.problem.errors) return null;
  return Object.entries(error.problem.errors).map(([name, reason]) => ({ name, reason }));
}

/** Ask the engine; an unreadable-assumptions refusal is an answer to show, not a failure. */
async function compute(
  id: string,
  args: Pick<ApiOptions, "env" | "request">
): Promise<{ needs: Need[] } | { problem: ActionResult["problem"] } | null> {
  try {
    await api(`/v1/north/scenarios/${encodeURIComponent(id)}/run`, { ...args, method: "POST" });
    return null;
  } catch (error) {
    const needs = needsOf(error);
    if (needs) return { needs };
    return { problem: refused(error).problem };
  }
}

/**
 * The hero's headline: whichever scenario is open, in its own words. A
 * stored question is the one thing on this screen that is never generic.
 * Not AI-authored text, so no ✦ (CLAUDE.md §11): a person typed this
 * question, nothing summarised it.
 */
export function headlineFor(open: { question: string } | null, l: (key: string) => string): string {
  return open?.question ?? l("title");
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);

  const page = await readable(
    api<Page<Scenario>>(`/v1/north/scenarios?sort=createdAt&order=desc&limit=${PAGE}`, { env, request })
  );
  const scenarios = page?.data ?? null;
  const asked = url.searchParams.get("id");
  const open = scenarios?.find((row) => row.id === asked) ?? scenarios?.[0] ?? null;

  return { scenarios, open, idempotencyKey: crypto.randomUUID() };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs): Promise<WhatIfResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();

  // "Compute" on a stored scenario: ask the engine again, against whatever
  // snapshots have closed since.
  if (form.get("intent") === "run") {
    const id = String(form.get("id") ?? "").trim();
    if (!id) return refuse("missing_scenario");
    const outcome = await compute(id, { env, request });
    if (!outcome) return { problem: null, saved: "run", ran: id };
    return "needs" in outcome ? { problem: null, saved: null, ran: id, needs: outcome.needs } : { problem: outcome.problem, saved: null, ran: id };
  }

  const question = String(form.get("question") ?? "").trim();
  const author = String(form.get("author") ?? "").trim();
  if (!question) return refuse("missing_question");
  if (!author) return refuse("missing_author");

  const assumptions = readAssumptions(String(form.get("assumptions") ?? ""));
  if (!assumptions) return refuse("bad_assumptions");

  const key = String(form.get("idempotencyKey") ?? "");
  let created: { id: string };
  try {
    created = await api<{ id: string }>("/v1/north/scenarios", {
      env,
      request,
      method: "POST",
      ...(key ? { headers: { "idempotency-key": key } } : {}),
      // No resultJson and no modelRunRef: the engine is the one writer of an
      // answer, and the API drops either if sent.
      body: { question, author, assumptionsJson: assumptions }
    });
  } catch (error) {
    return refused(error);
  }

  // Ask and answer in one step (docs/modules/north.md §2.4). The question is
  // saved whatever the engine says: assumptions it cannot read are named back
  // beside the stored scenario, not turned into a failed save.
  const outcome = await compute(created.id, { env, request });
  if (!outcome) return { problem: null, saved: "scenario", ran: created.id };
  return "needs" in outcome
    ? { problem: null, saved: "scenario", ran: created.id, needs: outcome.needs }
    : { problem: outcome.problem, saved: "scenario", ran: created.id };
}

/* --------------------------------------------------------------- the screen */

export default function NorthWhatIf() {
  const { scenarios, open, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);
  const currency = shell?.currency ?? FALLBACK_CURRENCY;

  const shown =
    result?.problem && result.problem.code !== "approval_required"
      ? {
          title: l(`problem.${result.problem.code ?? ""}`),
          status: result.problem.status,
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : (result?.problem ?? null);

  // The register first, the composer beside it (WorkLayout): the stored
  // scenario and the library are what a reader came for, the ask form is what
  // they might add to it.
  const composer = held.has(PERM.run) ? (
    <Panel module="north" eyebrow={l("ask.title")} lede={l("ask.note")}>
      <Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
        <Field label={l("ask.question")} hint={l("ask.question.hint")}>
          <Input name="question" required aria-label={l("ask.question")} />
        </Field>
        <Field label={l("ask.assumptions")} hint={l("ask.assumptions.hint")}>
          <Textarea name="assumptions" rows={4} aria-label={l("ask.assumptions")} />
        </Field>
        <Field label={l("ask.author")} hint={l("ask.author.hint")}>
          <Input name="author" required defaultValue={shell?.actorName ?? ""} aria-label={l("ask.author")} />
        </Field>
        <div>
          <Button type="submit" disabled={busy}>
            {l("ask.submit")}
          </Button>
        </div>
      </Form>
    </Panel>
  ) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <span className="eyebrow">{l("kicker")}</span>
          <Link
            to="/north/brief"
            className="font-ui text-12 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {l("link.brief")}
          </Link>
        </div>
        {/* The headline narrates whichever scenario is open rather than
            repeating the "Scenarios" eyebrow — see headlineFor() above. */}
        <h1 className="page-title">{headlineFor(open, l)}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(result.saved === "run" ? "ran" : "saved")}
        </p>
      ) : null}

      <WorkLayout aside={composer}>
        {scenarios === null ? (
          <Panel>
            <p className="font-ui text-13 text-subtle">{l("denied")}</p>
          </Panel>
        ) : scenarios.length === 0 ? (
          <EmptyState title={l("none.title")} body={l("none.body")} />
        ) : (
          <>
            {open ? (
              <ScenarioDetail
                scenario={open}
                locale={locale}
                currency={currency}
                l={l}
                canRun={held.has(PERM.run)}
                busy={busy}
                // Only the scenario the engine was just asked about; the
                // needs of another one do not belong under this question.
                needs={result?.ran === open.id ? (result.needs ?? null) : null}
              />
            ) : null}

            <Panel eyebrow={l("library.title")}>
              <Table
                caption={l("library.caption")}
                rows={scenarios}
                rowKey={(row) => row.id}
                columns={[
                  {
                    key: "question",
                    header: l("library.question"),
                    // The library is the navigation: the URL carries which
                    // scenario is open, so a question can be sent to somebody.
                    render: (row) => (
                      <a className="text-text underline decoration-border underline-offset-4" href={`?id=${row.id}`}>
                        {row.question}
                      </a>
                    )
                  },
                  { key: "author", header: l("library.author"), render: (row) => row.author },
                  {
                    key: "asked",
                    header: l("library.asked"),
                    render: (row) => <DateTime value={row.createdAt} locale={locale} />
                  },
                  {
                    key: "result",
                    header: l("library.result"),
                    render: (row) => {
                      // Computed by the engine, stored by hand before there was
                      // one, or not answered at all — three different claims.
                      if (answerOf(row.resultJson)) return <Badge tone="success">{l("result.computed")}</Badge>;
                      const answered = Object.keys(parsed<Record<string, unknown>>(row.resultJson, {})).length > 0;
                      return (
                        <Badge tone={answered ? "neutral" : "warning"}>{l(answered ? "result.yes" : "result.no")}</Badge>
                      );
                    }
                  }
                ]}
              />
            </Panel>
          </>
        )}
      </WorkLayout>
    </div>
  );
}

function ScenarioDetail({
  scenario,
  locale,
  currency,
  l,
  canRun,
  busy,
  needs
}: {
  scenario: Scenario;
  locale: string;
  currency: string;
  l: (key: string, vars?: Record<string, string>) => string;
  canRun: boolean;
  busy: boolean;
  needs: Need[] | null;
}) {
  const assumptions = parsed<Record<string, unknown>>(scenario.assumptionsJson, {});
  const computed = answerOf(scenario.resultJson);
  const answer = computed ? {} : parsed<Record<string, unknown>>(scenario.resultJson, {});
  const shared = parsed<string[]>(scenario.sharedWithJson, []);
  // A currency named in the assumptions beats the tenant default: the question
  // may have been asked about a book denominated in something else.
  const money = typeof assumptions.currency === "string" ? assumptions.currency : currency;
  const figures = Object.entries(answer).filter(([, value]) => typeof value === "number");
  const prose = Object.entries(answer).filter(([, value]) => typeof value === "string");

  return (
    // The page heading is already this question; the panel names who asked it.
    <Panel module="north" eyebrow={scenario.author}>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">{l("detail.assumptions")}</h2>
          <Provenance
            rows={[
              ...Object.entries(assumptions).map(([key, value]) => ({
                label: humanKey(key),
                value: <Value name={key} value={value} currency={money} locale={locale} />,
                mono: true
              })),
              { label: l("detail.run"), value: scenario.modelRunRef ?? l("detail.unset"), mono: true },
              ...(shared.length ? [{ label: l("detail.shared"), value: shared.join(" · ") }] : [])
            ]}
          />
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">{l("detail.result")}</h2>
          {computed ? (
            <ComputedAnswer answer={computed} locale={locale} l={l} />
          ) : figures.length === 0 && prose.length === 0 ? (
            <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("detail.result.none")}</p>
          ) : (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                {figures.map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-1">
                    <dt className="eyebrow">{humanKey(key)}</dt>
                    <dd className="font-mono text-16 tabular-nums text-text">
                      <Value name={key} value={value} currency={money} locale={locale} />
                    </dd>
                  </div>
                ))}
              </dl>
              {prose.map(([key, value]) => (
                <p key={key} className="max-w-[var(--measure-prose)] font-ui text-13 text-text">
                  {String(value)}
                </p>
              ))}
              {/* docs/modules/north.md §2.4: no point estimate without a range.
                  A figure stored before the engine existed has no band, so the
                  screen says so rather than drawing one it does not have. */}
              <p className="max-w-[var(--measure-prose)] font-ui text-12 text-subtle">{l("detail.point")}</p>
            </>
          )}

          {needs?.length ? (
            <div className="flex flex-col gap-1">
              <p className="font-ui text-13 text-text">{l("run.needs")}</p>
              <ul className="flex list-disc flex-col gap-1 ps-5 font-ui text-13 text-text">
                {needs.map((need) => (
                  <li key={need.name}>{l(`need.${need.reason}`, { name: need.name })}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {canRun ? (
            <Form method="post">
              <input type="hidden" name="intent" value="run" />
              <input type="hidden" name="id" value={scenario.id} />
              <Button type="submit" variant="secondary" disabled={busy}>
                {l(computed ? "run.again" : "run.submit")}
              </Button>
            </Form>
          ) : null}
        </section>
      </div>
    </Panel>
  );
}

/**
 * The engine's answer: what it read, what it left alone, and per period the
 * baseline band beside the shifted one. A band, never a lone number (§2.4).
 */
function ComputedAnswer({
  answer,
  locale,
  l
}: {
  answer: ScenarioAnswer;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const figure = (value: number) => (
    <MetricValue value={value} unit={answer.unit} currency={answer.currency} locale={locale} />
  );
  const text = (value: number) => metricText(value, answer.unit, answer.currency, locale);
  const band = (b: Band) => (
    <span className="flex flex-col items-end gap-0.5">
      <span className="text-text">{figure(b.p50)}</span>
      <span className="text-12 text-subtle">
        {l("answer.range", { p10: text(b.p10), p90: text(b.p90) })}
      </span>
    </span>
  );
  const count = new Intl.NumberFormat(locale);

  return (
    <div className="flex flex-col gap-3">
      <Provenance
        rows={[
          { label: l("answer.metric"), value: answer.metricKey, mono: true },
          { label: l("answer.change"), value: pct(answer.changeBps, locale) ?? "0%", mono: true },
          {
            label: l("answer.horizon"),
            value: l(`horizon.${answer.grain}`, { count: count.format(answer.horizon) })
          },
          { label: l("answer.asOf"), value: answer.fit.lastObserved ?? l("detail.unset"), mono: true },
          { label: l("answer.observations"), value: count.format(answer.fit.observations), mono: true },
          { label: l("answer.band"), value: l(`band.${answer.fit.intervalSource}`) },
          ...(answer.ignored.length ? [{ label: l("answer.ignored"), value: answer.ignored.join(" · "), mono: true }] : []),
          { label: l("answer.computed"), value: <DateTime value={answer.computedAt} locale={locale} /> }
        ]}
      />
      {answer.points.length === 0 ? (
        // Too little history is an answer, not a zero: say so, show nothing.
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-text">
          {l("answer.none", { metric: answer.metricKey, count: count.format(answer.fit.observations) })}
        </p>
      ) : (
        <>
          <Table
            caption={l("answer.caption")}
            rows={answer.points}
            rowKey={(row) => row.period}
            columns={[
              { key: "period", header: l("col.period"), render: (row) => <span className="font-mono">{row.period}</span> },
              { key: "baseline", header: l("col.baseline"), numeric: true, render: (row) => band(row.baseline) },
              { key: "scenario", header: l("col.scenario"), numeric: true, render: (row) => band(row.scenario) },
              { key: "delta", header: l("col.delta"), numeric: true, render: (row) => band(row.delta) }
            ]}
          />
          <p className="max-w-[var(--measure-prose)] font-ui text-12 text-subtle">{l("answer.note")}</p>
        </>
      )}
    </div>
  );
}

/** One stored figure in whatever unit its name says it is. */
function Value({
  name,
  value,
  currency,
  locale
}: {
  name: string;
  value: unknown;
  currency: string;
  locale: string;
}) {
  if (typeof value !== "number") return <>{String(value)}</>;
  const unit = unitOf(name);
  if (unit === "money") return <Money amountMinor={value} currency={currency} locale={locale} />;
  const format =
    unit === "bps" || unit === "ppm"
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" })
      : unit === "ms"
        ? new Intl.NumberFormat(locale, { style: "unit", unit: "second", maximumFractionDigits: 2, signDisplay: "exceptZero" })
        : new Intl.NumberFormat(locale);
  const scaled = unit === "bps" ? value / 10_000 : unit === "ppm" ? value / 1_000_000 : unit === "ms" ? value / 1_000 : value;
  return <span className="tabular-nums">{format.format(scaled)}</span>;
}

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
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { FALLBACK_CURRENCY } from "../calendar";
import { useNorthSessionData } from "./north-shell";
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

// Scenarios (docs/modules/north.md §4 screen 4): the ask bar, the assumptions
// the answer rests on, and the saved library.
//
// §2.4's guardrail is that a simulation always shows its assumption provenance
// and a confidence band — no point estimate without a range. Nothing in the API
// composes an answer yet (apps/api/src/engines holds the snapshotter and the
// board pack, no scenario engine), so this screen saves the question and its
// assumptions, renders a stored result where one exists, and says plainly that
// a stored figure is a point estimate with no band behind it. It does not
// invent a range to satisfy the guardrail — a fabricated band is worse than a
// missing one.

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
      "One per line, as name: value. A value ending Minor is money in minor units, Bps basis points, Ppm parts per million, Ms milliseconds.",
    "ask.author": "Asked by",
    "ask.author.hint": "Recorded against the scenario so the next reader knows whose question it was.",
    "ask.submit": "Save the question",
    "ask.note":
      "Saving records the question and its assumptions. No engine computes the answer yet, so the result stays empty until somebody fills it in.",
    "library.title": "Saved scenarios",
    "library.caption": "Every scenario asked in this tenant, most recent first",
    "library.question": "Question",
    "library.author": "Asked by",
    "library.asked": "Asked",
    "library.result": "Result",
    "library.open": "Open",
    "result.yes": "Answered",
    "result.no": "Unanswered",
    "detail.assumptions": "What it assumes",
    "detail.result": "What it answers",
    "detail.result.none":
      "Nothing has answered this yet. The question and its assumptions are stored; the result is empty because no engine has run against them.",
    "detail.shared": "Shared with",
    "detail.run": "Model run",
    "detail.unset": "Not recorded",
    "detail.point":
      "These are point estimates. No confidence band was stored with them, so read them as a single line through a range nobody has measured.",
    "none.title": "No scenarios have been asked",
    "none.body": "The first question somebody writes down is the first one anybody else can argue with.",
    denied: "You do not have permission to read scenarios. Ask a tenant administrator for NORTH scenario access.",
    saved: "Scenario saved.",
    approvalTitle: "Queued for approval",
    approvalBody: "Saving this scenario needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_question": "Write the question out — a scenario without one cannot be argued with later.",
    "problem.missing_author": "Put your name to it.",
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
      "افتراض في كل سطر بصيغة الاسم: القيمة. القيمة المنتهية بـ Minor مبلغ بالوحدات الصغرى، وBps نقاط أساس، وPpm أجزاء من مليون، وMs مللي ثانية.",
    "ask.author": "السائل",
    "ask.author.hint": "يُسجَّل مع السيناريو ليعرف القارئ التالي صاحب السؤال.",
    "ask.submit": "احفظ السؤال",
    "ask.note":
      "الحفظ يسجّل السؤال وافتراضاته. لا يوجد محرك يحسب الإجابة بعد، لذا تبقى النتيجة فارغة حتى يملأها أحد.",
    "library.title": "السيناريوهات المحفوظة",
    "library.caption": "كل سيناريو طُرح في هذا المستأجر، الأحدث أولاً",
    "library.question": "السؤال",
    "library.author": "السائل",
    "library.asked": "وقت الطرح",
    "library.result": "النتيجة",
    "library.open": "افتح",
    "result.yes": "مُجاب",
    "result.no": "بلا إجابة",
    "detail.assumptions": "ما يفترضه",
    "detail.result": "ما يجيب به",
    "detail.result.none":
      "لم يُجب أحد عن هذا بعد. السؤال وافتراضاته محفوظة، والنتيجة فارغة لأن لا محرك عمل عليها.",
    "detail.shared": "مشارَك مع",
    "detail.run": "تشغيل النموذج",
    "detail.unset": "غير مسجل",
    "detail.point": "هذه تقديرات نقطية. لم يُحفظ معها نطاق ثقة، فاقرأها كخط واحد داخل مدى لم يقسه أحد.",
    "none.title": "لم تُطرح أي سيناريوهات",
    "none.body": "أول سؤال يكتبه أحد هو أول سؤال يستطيع غيره مناقشته.",
    denied: "لا تملك صلاحية قراءة السيناريوهات. اطلب من مدير المستأجر صلاحية سيناريوهات نورث.",
    saved: "حُفظ السيناريو.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "حفظ هذا السيناريو يحتاج موافقة بموجب سياسة {policy}. هو في الانتظار ولم يُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_question": "اكتب السؤال — السيناريو بلا سؤال لا يمكن مناقشته لاحقاً.",
    "problem.missing_author": "ضع اسمك عليه.",
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
 * The hero's headline: whichever scenario is open, in its own words. A
 * stored question is the one thing on this screen that is never generic —
 * unlike the answer, which the action() above refuses to compute, so there
 * is no delta to narrate with yet. Not AI-authored text, so no ✦ (CLAUDE.md
 * §11): a person typed this question, nothing summarised it.
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

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();

  const question = String(form.get("question") ?? "").trim();
  const author = String(form.get("author") ?? "").trim();
  if (!question) return refuse("missing_question");
  if (!author) return refuse("missing_author");

  const assumptions = readAssumptions(String(form.get("assumptions") ?? ""));
  if (!assumptions) return refuse("bad_assumptions");

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    await api("/v1/north/scenarios", {
      env,
      request,
      method: "POST",
      ...(key ? { headers: { "idempotency-key": key } } : {}),
      // No resultJson and no modelRunRef: nothing has run, and an empty object
      // would read on the next screen as an answer of zero.
      body: { question, author, assumptionsJson: assumptions }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: "scenario" };
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
          {l("saved")}
        </p>
      ) : null}

      {held.has(PERM.run) ? (
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
      ) : null}

      {scenarios === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : scenarios.length === 0 ? (
        <EmptyState title={l("none.title")} body={l("none.body")} />
      ) : (
        <>
          {open ? <ScenarioDetail scenario={open} locale={locale} currency={currency} l={l} /> : null}

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
    </div>
  );
}

function ScenarioDetail({
  scenario,
  locale,
  currency,
  l
}: {
  scenario: Scenario;
  locale: string;
  currency: string;
  l: (key: string, vars?: Record<string, string>) => string;
}) {
  const assumptions = parsed<Record<string, unknown>>(scenario.assumptionsJson, {});
  const answer = parsed<Record<string, unknown>>(scenario.resultJson, {});
  const shared = parsed<string[]>(scenario.sharedWithJson, []);
  // A currency named in the assumptions beats the tenant default: the question
  // may have been asked about a book denominated in something else.
  const money = typeof assumptions.currency === "string" ? assumptions.currency : currency;
  const figures = Object.entries(answer).filter(([, value]) => typeof value === "number");
  const prose = Object.entries(answer).filter(([, value]) => typeof value === "string");

  return (
    <Panel module="north" eyebrow={scenario.author} lede={scenario.question}>
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
          {figures.length === 0 && prose.length === 0 ? (
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
                  Nothing stores a band, so the screen says so rather than
                  drawing one it does not have. */}
              <p className="max-w-[var(--measure-prose)] font-ui text-12 text-subtle">{l("detail.point")}</p>
            </>
          )}
        </section>
      </div>
    </Panel>
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

import * as React from "react";
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
  AGENT_MARK,
  Badge,
  BudgetMeter,
  Button,
  Card,
  Checkbox,
  EmptyState,
  EvidenceLink,
  Field,
  GuardrailNotice,
  Input,
  Money,
  ProgressBar,
  Select,
  Table,
  type Column,
  type SelectOption
} from "@lyra/ui";
import { ApiError, api } from "../api.server";
import { cloudflare } from "../context";
import { moduleName, pseudoText, translator } from "../i18n";
import { humanise } from "../modules/spec";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// The ceiling on what the agents may spend, and the only screen that can move
// it: `POST /v1/ai/budget/limits` (apps/api/src/routes/ai.ts) had no caller
// anywhere in the product, so a tenant could watch the meter fill and do
// nothing about it.
//
// The AI console (/admin/ai/console) reads the same budget and is the operating
// view — agents, runs, guardrails. This screen is the control: today's ceiling
// per module, the form that changes it, and what the spend actually bought.

/* --------------------------------------------------------------- constants */

/** The exact string `POST /v1/ai/budget/limits` calls require_() with. */
export const SET_LIMITS_PERMISSION = "ai:budgets:write";

/** `module` defaults to `*` in the handler's zod schema: the whole tenant. */
export const ALL_MODULES = "*";

/**
 * cost_micro is micro-USD (packages/model-gateway/src/models.ts). Money crosses
 * this file in exactly two shapes: micro on the wire, minor units for <Money>.
 * Rounded up like the gateway's own costing, so a call that really cost
 * something never renders as free.
 */
const COST_CURRENCY = "USD";
const MICRO_PER_MAJOR = 1_000_000;
const MICRO_PER_MINOR = 10_000;
const minorOf = (costMicro: number): number => Math.ceil(costMicro / MICRO_PER_MINOR);

const ACCEPTANCE_DAYS = 30;
/** Enough rows to hold several days of per-module budgets without paging. */
const BUDGET_ROWS = 200;

/* ------------------------------------------------------------------ labels */

// This screen owns its vocabulary. apps/web/app/i18n/{en,ar}.ts is the shell's
// catalogue; `common.*` is reused through translator(locale) and everything
// budget-specific lives here.
const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Spending ceilings",
    intro:
      "What the agents are allowed to spend today, and the control that changes it. A ceiling of zero means no ceiling.",
    "ledger.title": "Today's ceilings",
    "ledger.window": "Window",
    "ledger.tokens": "Tokens",
    "ledger.cost": "Cost",
    "ledger.set": "Change this ceiling",
    "ledger.stopped": "Stopped",
    "ledger.uncapped": "No ceiling",
    "ledger.spent": "Spent",
    "ledger.none.title": "No budget has been set",
    "ledger.none.body":
      "Nothing has been metered for this tenant yet, so there is no window to show. Setting a ceiling creates today's window.",
    "ledger.denied":
      "You do not have permission to read AI budgets, so the figures on this screen are hidden. Ask a tenant administrator for AI budget access.",
    "uncapped.title": "Spending is uncapped",
    "uncapped.reason":
      "Both ceilings are zero for at least one module, which the gateway reads as unlimited. Agent runs will not be stopped by budget.",
    "form.title": "Set a ceiling",
    "form.intro": "Applies to today's window. Leave a field blank to keep the ceiling it already has.",
    "form.module": "Applies to",
    "form.module.hint": "A module ceiling is metered separately from the tenant-wide one.",
    "form.tokens": "Daily token ceiling",
    "form.tokens.hint": "Zero removes the ceiling.",
    "form.cost": "Daily cost ceiling",
    "form.cost.hint": "In whole currency, to two decimal places. Zero removes the ceiling.",
    "form.current": "Now",
    "form.confirm":
      "I understand this changes what the agents may spend, and that raising it is recorded against my name.",
    "form.submit": "Set ceiling",
    "form.saved": "Ceiling updated.",
    "form.denied.title": "Read-only",
    "form.denied.reason":
      "Changing an AI spending ceiling needs the ai:budgets:write permission, which your roles do not carry. The figures above stay visible.",
    "approval.title": "Waiting for approval",
    "approval.reason":
      "Raising an AI spending ceiling is approval-gated. The request has been recorded and takes effect once someone else approves it.",
    "approval.link": "Open approvals",
    "acceptance.title": "What the spend bought",
    "acceptance.window": "Suggestions shown in the last 30 days, and how often people kept them.",
    "acceptance.surface": "Surface",
    "acceptance.module": "Asked by",
    "acceptance.shown": "Shown",
    "acceptance.accepted": "Accepted",
    "acceptance.edited": "Edited",
    "acceptance.dismissed": "Dismissed",
    "acceptance.rate": "Kept",
    "acceptance.why": "How this is counted",
    "acceptance.whyBody":
      "An edited suggestion counts as kept: the reader took the shape and changed the words.",
    "acceptance.denied": "You do not have permission to read suggestion outcomes.",
    "module.all": "All modules",
    "unit.tokens": "tokens",
    "problem.confirm_required": "Tick the confirmation before changing a ceiling.",
    "problem.invalid_amount": "A ceiling must be a number that is zero or more.",
    "problem.nothing_to_set": "Set at least one of the two ceilings.",
    "problem.bad_intent": "That form did not carry a recognised action.",
    "headline.stopped": "module(s) have stopped agents on budget today.",
    "headline.none": "No budget has been set for this tenant yet.",
    "headline.uncapped": "At least one module has no ceiling today.",
    "headline.onTrack": "Every module is within its ceiling today.",
    "headline.consoleLink": "See what's stopped in the AI console"
  },
  ar: {
    title: "حدود الإنفاق",
    intro: "ما يُسمح للوكلاء بإنفاقه اليوم، والتحكم الذي يغيّره. الحد صفر يعني بلا حد.",
    "ledger.title": "حدود اليوم",
    "ledger.window": "النافذة",
    "ledger.tokens": "الرموز",
    "ledger.cost": "التكلفة",
    "ledger.set": "تغيير هذا الحد",
    "ledger.stopped": "موقوف",
    "ledger.uncapped": "بلا حد",
    "ledger.spent": "المنفق",
    "ledger.none.title": "لم تُضبط أي ميزانية",
    "ledger.none.body":
      "لم يُقَس أي استهلاك لهذه المؤسسة بعد، فلا توجد نافذة لعرضها. ضبط حد ينشئ نافذة اليوم.",
    "ledger.denied":
      "لا تملك صلاحية الاطلاع على ميزانيات الذكاء الاصطناعي، لذا أُخفيت الأرقام. اطلب الصلاحية من مسؤول المؤسسة.",
    "uncapped.title": "الإنفاق بلا سقف",
    "uncapped.reason":
      "كلا الحدين صفر لوحدة واحدة على الأقل، وهو ما تقرأه البوابة كغير محدود. لن تُوقف تشغيلات الوكلاء بسبب الميزانية.",
    "form.title": "ضبط حد",
    "form.intro": "ينطبق على نافذة اليوم. اترك الحقل فارغًا للإبقاء على الحد الحالي.",
    "form.module": "ينطبق على",
    "form.module.hint": "حد الوحدة يُقاس بمعزل عن الحد العام للمستأجر.",
    "form.tokens": "الحد اليومي للرموز",
    "form.tokens.hint": "الصفر يزيل الحد.",
    "form.cost": "الحد اليومي للتكلفة",
    "form.cost.hint": "بالعملة الكاملة، بمنزلتين عشريتين. الصفر يزيل الحد.",
    "form.current": "الحالي",
    "form.confirm": "أفهم أن هذا يغيّر ما يجوز للوكلاء إنفاقه، وأن رفعه يُسجَّل باسمي.",
    "form.submit": "ضبط الحد",
    "form.saved": "تم تحديث الحد.",
    "form.denied.title": "للقراءة فقط",
    "form.denied.reason":
      "تغيير حد إنفاق الذكاء الاصطناعي يتطلب صلاحية ai:budgets:write وهي غير متاحة لأدوارك. تبقى الأرقام أعلاه ظاهرة.",
    "approval.title": "بانتظار الموافقة",
    "approval.reason":
      "رفع حد إنفاق الذكاء الاصطناعي يمر بموافقة. سُجِّل الطلب ويسري بعد موافقة شخص آخر.",
    "approval.link": "فتح الموافقات",
    "acceptance.title": "ماذا اشترى الإنفاق",
    "acceptance.window": "الاقتراحات المعروضة في آخر ٣٠ يومًا، وكم مرة أبقاها الناس.",
    "acceptance.surface": "السطح",
    "acceptance.module": "الطالب",
    "acceptance.shown": "معروضة",
    "acceptance.accepted": "مقبولة",
    "acceptance.edited": "معدّلة",
    "acceptance.dismissed": "مرفوضة",
    "acceptance.rate": "أُبقيت",
    "acceptance.why": "كيف يُحتسب هذا",
    "acceptance.whyBody": "الاقتراح المعدّل يُحتسب مقبولًا: أخذ القارئ الشكل وغيّر الكلمات.",
    "acceptance.denied": "لا تملك صلاحية الاطلاع على نتائج الاقتراحات.",
    "module.all": "كل الوحدات",
    "unit.tokens": "رمز",
    "problem.confirm_required": "علّم خانة التأكيد قبل تغيير أي حد.",
    "problem.invalid_amount": "يجب أن يكون الحد رقمًا يساوي صفرًا أو أكثر.",
    "problem.nothing_to_set": "اضبط أحد الحدين على الأقل.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً معروفًا.",
    "headline.stopped": "وحدة (أو أكثر) أوقفت وكلاءها بسبب الميزانية اليوم.",
    "headline.none": "لم تُضبط أي ميزانية لهذه المؤسسة بعد.",
    "headline.uncapped": "وحدة واحدة على الأقل بلا حد اليوم.",
    "headline.onTrack": "كل وحدة ضمن حدها اليوم.",
    "headline.consoleLink": "اطّلع على الموقوف في لوحة الذكاء الاصطناعي"
  }
};

type Label = (key: string, fallback?: string) => string;

/** Locale first, English next, then whatever the API actually said. */
function labeller(locale: string): Label {
  return (key, fallback) =>
    pseudoText(locale, LABELS[locale]?.[key] ?? LABELS["en"]?.[key] ?? fallback ?? key);
}

/* ------------------------------------------------------------------ shapes */

export interface BudgetRow {
  id: string;
  day: string;
  module: string;
  tokensUsed: number;
  costMicroUsed: number;
  tokensLimit: number;
  costMicroLimit: number;
  stoppedAt: number | null;
  updatedAt: number;
}

interface BudgetCheck {
  ok: boolean;
  usedPct: number;
  reason?: "tokens" | "cost";
  state: BudgetRow;
}

interface Acceptance {
  module: string;
  surface: string;
  shown: number;
  accepted: number;
  edited: number;
  dismissed: number;
  acceptanceRate: number;
}

/* ------------------------------------------------------------------ helpers */

/**
 * Whether the actor may move a ceiling. The control is absent when they may
 * not, never disabled — a dead button teaches nothing (docs/22 §5.4).
 */
export function canSetLimits(permissions: readonly string[]): boolean {
  return permissions.includes(SET_LIMITS_PERMISSION);
}

/**
 * A typed ceiling in major units → the integer the API wants.
 * `undefined` means the field was left blank (keep the current ceiling);
 * `null` means it was filled in with something that is not a ceiling.
 */
export function limitFrom(raw: string, scale: number): number | undefined | null {
  const text = raw.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * scale);
}

/**
 * The budget rows belonging to one window. Budgets are per (day, module) and
 * arrive newest-first; only the newest day is "now", and `*` leads because it
 * is the ceiling every module is also measured against.
 *
 * No rows at all is the honest empty state: nothing has ever been metered.
 */
export function ceilingsFor(rows: readonly BudgetRow[] | null, day?: string): BudgetRow[] {
  if (!rows?.length) return [];
  const window = day ?? rows.reduce((latest, r) => (r.day > latest ? r.day : latest), rows[0]!.day);
  return rows
    .filter((r) => r.day === window)
    .sort((a, b) =>
      a.module === b.module ? 0 : a.module === ALL_MODULES ? -1 : b.module === ALL_MODULES ? 1 : a.module < b.module ? -1 : 1
    );
}

/** Zero is not a small ceiling: the gateway reads it as "do not stop them". */
const uncapped = (row: BudgetRow): boolean => row.tokensLimit === 0 && row.costMicroLimit === 0;

/** One true line for the hero: a module actually stopped outranks merely
 *  being uncapped, which outranks "nothing set up yet". */
export function budgetHeadline(ceilings: readonly BudgetRow[], L: Label): string {
  const stopped = ceilings.filter((row) => row.stoppedAt !== null).length;
  if (stopped > 0) return `${stopped} ${L("headline.stopped")}`;
  if (ceilings.length === 0) return L("headline.none");
  if (ceilings.some(uncapped)) return L("headline.uncapped");
  return L("headline.onTrack");
}

/* ------------------------------------------------------------------ loader */

/**
 * A section the actor may not read is absent, not an error — the API is the
 * authority on what they may see, so a 403 renders as a notice and the rest of
 * the screen still loads.
 */
async function readable<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };

  const [budget, budgets, acceptance] = await Promise.all([
    // Reads today's tenant-wide window, creating it if the tenant has never run
    // an agent — which is what makes the form's "now" figures real.
    readable(api<BudgetCheck>("/v1/ai/budget", opts)),
    readable(api<{ data: BudgetRow[] }>(`/v1/ai/budgets?sort=day&order=desc&limit=${BUDGET_ROWS}`, opts)),
    readable(api<{ data: Acceptance[] }>(`/v1/ai/suggestions/acceptance?days=${ACCEPTANCE_DAYS}`, opts))
  ]);

  return {
    budget,
    budgets: budgets?.data ?? null,
    acceptance: acceptance?.data ?? null
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: { title: string; status: number; code?: string; detail?: string; requestId?: string } | null;
  /** The module whose ceiling was just written, for the confirmation line. */
  saved: string | null;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  saved: null
});

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  if (String(form.get("intent") ?? "") !== "set-limits") return refuse("bad_intent");

  // Consequential (CLAUDE.md §4): the browser asked for an explicit
  // confirmation and this re-checks it rather than trusting the markup that
  // carried it. The API's approval gate is the real control; this only stops an
  // accidental ceiling change from ever reaching it.
  if (form.get("confirm") !== "on") return refuse("confirm_required");

  const module = String(form.get("module") ?? "").trim() || ALL_MODULES;
  const tokensLimit = limitFrom(String(form.get("tokensLimit") ?? ""), 1);
  const costMicroLimit = limitFrom(String(form.get("costLimit") ?? ""), MICRO_PER_MAJOR);
  if (tokensLimit === null || costMicroLimit === null) return refuse("invalid_amount");
  if (tokensLimit === undefined && costMicroLimit === undefined) return refuse("nothing_to_set");

  try {
    await api("/v1/ai/budget/limits", {
      env,
      request,
      method: "POST",
      body: {
        module,
        ...(tokensLimit === undefined ? {} : { tokensLimit }),
        ...(costMicroLimit === undefined ? {} : { costMicroLimit })
      }
    });
  } catch (error) {
    // A refused write is information: an approval_required 403 belongs next to
    // the form it was refused for, not in an error boundary.
    if (error instanceof ApiError) return { problem: error.problem, saved: null };
    throw error;
  }
  return { problem: null, saved: module };
}

/* --------------------------------------------------------------- the screen */

export default function AiBudget() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();
  const tokensRef = React.useRef<HTMLInputElement>(null);

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const L = labeller(locale);
  const nf = new Intl.NumberFormat(locale);
  const busy = navigation.state !== "idle";
  const mayWrite = canSetLimits(shell?.permissions ?? []);

  const ceilings = ceilingsFor(loaded.budgets, loaded.budget?.state.day);
  const [module, setModule] = React.useState(ALL_MODULES);
  const selected = ceilings.find((row) => row.module === module);

  // `module.<key>` is not in any label table, so every ceiling row printed its
  // storage key — "dist", "orbit", "core" — under a heading reading Module.
  const moduleLabel = (key: string): string =>
    key === ALL_MODULES ? L("module.all") : moduleName(t, key);

  const moduleOptions: SelectOption[] = [
    { value: ALL_MODULES, label: L("module.all") },
    ...ceilings
      .filter((row) => row.module !== ALL_MODULES)
      .map((row) => ({ value: row.module, label: moduleLabel(row.module) }))
  ];

  /** Picking a row aims the form at it and puts the cursor in the first field. */
  const aimAt = (key: string): void => {
    setModule(key);
    tokensRef.current?.focus();
  };

  const approvalPending = result?.problem?.code === "approval_required";
  const shownProblem =
    result?.problem && !approvalPending
      ? {
          title: L(`problem.${result.problem.code ?? ""}`, result.problem.title),
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : null;

  const acceptanceColumns: Array<Column<Acceptance>> = [
    {
      key: "surface",
      header: L("acceptance.surface"),
      // docs/15: one ✦ per AI artifact, and the "why" one interaction away.
      render: (row) => (
        <EvidenceLink
          sourceLabel={L("acceptance.why")}
          source={<p className="max-w-xs font-ui text-12 text-muted">{L("acceptance.whyBody")}</p>}
        >
          <span aria-hidden="true">{AGENT_MARK}</span>{" "}
          {humanise(row.surface)}
        </EvidenceLink>
      )
    },
    { key: "module", header: L("acceptance.module"), render: (row) => moduleLabel(row.module) },
    { key: "shown", header: L("acceptance.shown"), numeric: true, render: (row) => nf.format(row.shown) },
    {
      key: "accepted",
      header: L("acceptance.accepted"),
      numeric: true,
      render: (row) => nf.format(row.accepted)
    },
    { key: "edited", header: L("acceptance.edited"), numeric: true, render: (row) => nf.format(row.edited) },
    {
      key: "dismissed",
      header: L("acceptance.dismissed"),
      numeric: true,
      render: (row) => nf.format(row.dismissed)
    },
    {
      key: "acceptanceRate",
      header: L("acceptance.rate"),
      render: (row) => (
        <div className="flex min-w-24 items-center gap-2">
          <ProgressBar
            value={row.acceptanceRate}
            tone={row.acceptanceRate >= 50 ? "success" : row.acceptanceRate >= 20 ? "accent" : "neutral"}
            label={`${row.surface}: ${row.acceptanceRate}%`}
            className="flex-1"
          />
          <span className="w-10 shrink-0 text-end font-ui text-12 tabular-nums text-muted">
            {row.acceptanceRate}%
          </span>
        </div>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{L("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{budgetHeadline(ceilings, L)}</p>
        {ceilings.some((row) => row.stoppedAt !== null) ? (
          <Link
            to="/admin/ai/console"
            className="w-fit font-ui text-13 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {L("headline.consoleLink")}
          </Link>
        ) : null}
      </header>

      {/* An uncapped tenant is the finding an operator came here to act on, so
          it is stated before the meters that would render it as an empty bar. */}
      {ceilings.some(uncapped) ? (
        <GuardrailNotice tone="warning" title={L("uncapped.title")} reason={L("uncapped.reason")} />
      ) : null}

      {approvalPending ? (
        <GuardrailNotice
          tone="info"
          title={L("approval.title")}
          reason={L("approval.reason")}
          action={
            <Link
              to="/approvals"
              className="font-ui text-13 text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {L("approval.link")}
            </Link>
          }
        />
      ) : null}

      {shownProblem ? <Problem problem={shownProblem} /> : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        {/* ---------------------------------------------------------- ledger */}
        <Card
          title={L("ledger.title")}
          {...(loaded.budget ? { description: `${L("ledger.window")} · ${loaded.budget.state.day}` } : {})}
        >
          {loaded.budgets === null ? (
            <p className="max-w-prose font-ui text-13 text-subtle">{L("ledger.denied")}</p>
          ) : ceilings.length === 0 ? (
            <EmptyState title={L("ledger.none.title")} body={L("ledger.none.body")} />
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {ceilings.map((row) => (
                <li key={row.id} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate font-ui text-14 font-medium text-text">
                        {moduleLabel(row.module)}
                      </span>
                      {row.stoppedAt ? (
                        <Badge tone="danger" size="sm">
                          {L("ledger.stopped")}
                        </Badge>
                      ) : uncapped(row) ? (
                        <Badge tone="warning" size="sm">
                          {L("ledger.uncapped")}
                        </Badge>
                      ) : null}
                    </div>
                    {mayWrite ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => aimAt(row.module)}
                        aria-label={`${L("ledger.set")}: ${moduleLabel(row.module)}`}
                      >
                        {L("ledger.set")}
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <BudgetMeter
                      label={L("ledger.tokens")}
                      used={row.tokensUsed}
                      limit={row.tokensLimit}
                      unit={L("unit.tokens")}
                      locale={locale}
                    />
                    <div className="flex flex-col gap-1.5">
                      <BudgetMeter
                        label={L("ledger.cost")}
                        used={minorOf(row.costMicroUsed)}
                        limit={minorOf(row.costMicroLimit)}
                        currency={COST_CURRENCY}
                        locale={locale}
                      />
                      {/* The meter is the shape of the number; money is read as money. */}
                      <p className="font-ui text-12 text-subtle">
                        {L("ledger.spent")}{" "}
                        <Money
                          amountMinor={minorOf(row.costMicroUsed)}
                          currency={COST_CURRENCY}
                          locale={locale}
                          className="text-text"
                        />
                        {row.costMicroLimit > 0 ? (
                          <>
                            {" / "}
                            <Money
                              amountMinor={minorOf(row.costMicroLimit)}
                              currency={COST_CURRENCY}
                              locale={locale}
                            />
                          </>
                        ) : null}
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* ------------------------------------------------------------ form */}
        <aside className="lg:sticky lg:top-6">
          {mayWrite ? (
            <Card title={L("form.title")} description={L("form.intro")}>
              <Form method="post" className="flex flex-col gap-4">
                <input type="hidden" name="intent" value="set-limits" />

                <Field label={L("form.module")} hint={L("form.module.hint")}>
                  <Select
                    name="module"
                    options={moduleOptions}
                    value={module}
                    onValueChange={setModule}
                  />
                </Field>

                {/* Remounting on the selected module reseeds both defaults with
                    that module's current ceiling. */}
                <Field
                  label={L("form.tokens")}
                  hint={
                    selected
                      ? `${L("form.current")} ${nf.format(selected.tokensLimit)}`
                      : L("form.tokens.hint")
                  }
                >
                  <Input
                    key={`tokens-${module}`}
                    ref={tokensRef}
                    name="tokensLimit"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    defaultValue={selected ? String(selected.tokensLimit) : ""}
                  />
                </Field>

                <Field
                  label={L("form.cost")}
                  hint={
                    selected ? (
                      <span>
                        {L("form.current")}{" "}
                        <Money
                          amountMinor={minorOf(selected.costMicroLimit)}
                          currency={COST_CURRENCY}
                          locale={locale}
                        />
                      </span>
                    ) : (
                      L("form.cost.hint")
                    )
                  }
                >
                  <Input
                    key={`cost-${module}`}
                    name="costLimit"
                    type="number"
                    min={0}
                    step="0.01"
                    inputMode="decimal"
                    suffix={<span className="font-ui text-12 text-subtle">{COST_CURRENCY}</span>}
                    defaultValue={
                      selected ? (selected.costMicroLimit / MICRO_PER_MAJOR).toFixed(2) : ""
                    }
                  />
                </Field>

                <Checkbox name="confirm" label={L("form.confirm")} />

                <Button type="submit" variant="primary" disabled={busy}>
                  {busy ? t("common.working") : L("form.submit")}
                </Button>

                {result?.saved ? (
                  <p role="status" className="font-ui text-13 text-success">
                    {L("form.saved")} {moduleLabel(result.saved)}
                  </p>
                ) : null}
              </Form>
            </Card>
          ) : (
            <GuardrailNotice
              tone="info"
              title={L("form.denied.title")}
              reason={L("form.denied.reason")}
            />
          )}
        </aside>
      </div>

      {/* ------------------------------------------------------------ bought */}
      <Card title={L("acceptance.title")} description={L("acceptance.window")}>
        {loaded.acceptance === null ? (
          <p className="max-w-prose font-ui text-13 text-subtle">{L("acceptance.denied")}</p>
        ) : (
          <Table
            columns={acceptanceColumns}
            rows={loaded.acceptance}
            rowKey={(row) => `${row.module}/${row.surface}`}
            caption={`${L("acceptance.title")} — ${L("acceptance.window")}`}
            density="compact"
            empty={<EmptyState title={t("common.empty.title")} body={t("common.empty.body")} />}
          />
        )}
      </Card>
    </div>
  );
}

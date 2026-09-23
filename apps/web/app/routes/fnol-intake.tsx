import {
  Form,
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
  Field,
  GuardrailNotice,
  Input,
  MoneyField,
  Select,
  Textarea,
  type BadgeTone
} from "@lyra/ui";
import { ApiError, api, names } from "../api.server";
import { who, type Names } from "../names";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";
import { labelsFrom } from "./detail-kit";

// FNOL taken from a third party has no customer file to open yet — so this
// screen deliberately prefetches nothing about the claimant, only the caller's
// own in-force policies to pick from. Cover is checked before anything is
// written; an out-of-cover answer is not a dead end, because refusing to
// record a notification is a conduct failure (docs/27 F24, gap-axis-design §D.1).

export const PERM = { register: "axis:claims:register" } as const;

const PAGE = 200;

/* ----------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "New claim (FNOL)",
    intro:
      "Check cover before writing anything. An out-of-cover answer still gets registered, flagged for review — refusing to record a notification is a conduct failure.",
    "field.incidentAt": "Date of loss",
    "field.peril": "Peril",
    "field.cause": "Cause",
    "field.description": "What happened",
    "field.amount": "Estimated amount",
    "field.contact": "Contact",
    "field.channel": "Reported via",
    "hint.policy": "The policy the loss happened under.",
    "hint.cause": "How it happened, in a few words — burst geyser, rear-ended, storm damage.",
    "hint.amount": "What the claimant says it is worth. Not a reserve.",
    "hint.contact": "Phone number or email for whoever reported it.",
    "channel.phone": "Phone",
    "channel.email": "Email",
    "channel.whatsapp": "WhatsApp",
    "channel.web": "Web form",
    "channel.branch": "In person",
    "channel.broker": "Intermediary",
    "checkCover.submit": "Check cover",
    "register.submit": "Register claim",
    "guardrail.title": "No cover found for that date",
    "guardrail.registerAnyway": "Register anyway, flag for review",
    "coverage.title": "Coverage check",
    "coverageState.in_force": "In force",
    "coverageState.not_yet_incepted": "Not yet incepted",
    "coverageState.lapsed_at_loss": "Lapsed at loss",
    "coverageState.cancelled_at_loss": "Cancelled at loss",
    "coverageState.out_of_cover": "Out of cover",
    "coverageState.unknown": "Unknown",
    "peril.fire": "Fire",
    "peril.theft": "Theft",
    "peril.collision": "Collision",
    "peril.weather": "Weather",
    "peril.liability": "Liability",
    "peril.other": "Other",
    "done.check-cover": "Cover checked.",
    "done.register": "Claim {claimNo} registered.",
    "problem.missing_policy": "Pick a policy first.",
    "problem.missing_date": "Date of loss is required.",
    "problem.bad_amount": "Estimated amount has to be a number.",
    "problem.bad_intent": "The form did not carry an action this screen recognises.",
    "headline.none": "No active policy is available to claim against",
    "headline.ready": "{count} active policies ready to pick from"
  },
  ar: {
    title: "بلاغ حادث جديد",
    intro:
      "تحقّق من التغطية قبل تسجيل أي شيء. البلاغ خارج التغطية يُسجَّل أيضًا ويُوسَم للمراجعة — رفض تسجيل بلاغ هو إخلال بواجب السلوك.",
    "field.incidentAt": "تاريخ الحادث",
    "field.peril": "الخطر",
    "field.cause": "السبب",
    "field.description": "ماذا حدث",
    "field.amount": "المبلغ التقديري",
    "field.contact": "جهة الاتصال",
    "field.channel": "قناة البلاغ",
    "hint.policy": "الوثيقة التي وقع الحادث تحتها.",
    "hint.cause": "كيف وقع الحادث بكلمات قليلة — انفجار سخّان، اصطدام خلفي، ضرر عاصفة.",
    "hint.amount": "ما يقدّره المطالِب. ليس احتياطيًا.",
    "hint.contact": "رقم هاتف أو بريد لمن أبلغ.",
    "channel.phone": "هاتف",
    "channel.email": "بريد إلكتروني",
    "channel.whatsapp": "واتساب",
    "channel.web": "نموذج الويب",
    "channel.branch": "حضور شخصي",
    "channel.broker": "وسيط",
    "checkCover.submit": "تحقّق من التغطية",
    "register.submit": "سجّل المطالبة",
    "guardrail.title": "لا توجد تغطية لهذا التاريخ",
    "guardrail.registerAnyway": "سجّل رغم ذلك، وسِمه للمراجعة",
    "coverage.title": "نتيجة التحقّق",
    "coverageState.in_force": "سارية",
    "coverageState.not_yet_incepted": "لم تبدأ بعد",
    "coverageState.lapsed_at_loss": "منتهية وقت الحادث",
    "coverageState.cancelled_at_loss": "ملغاة وقت الحادث",
    "coverageState.out_of_cover": "خارج التغطية",
    "coverageState.unknown": "غير معروفة",
    "peril.fire": "حريق",
    "peril.theft": "سرقة",
    "peril.collision": "تصادم",
    "peril.weather": "طقس",
    "peril.liability": "مسؤولية",
    "peril.other": "أخرى",
    "done.check-cover": "تم التحقّق من التغطية.",
    "done.register": "سُجِّلت المطالبة {claimNo}.",
    "problem.missing_policy": "اختر وثيقة أولًا.",
    "problem.missing_date": "تاريخ الحادث مطلوب.",
    "problem.bad_amount": "المبلغ التقديري يجب أن يكون رقمًا.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة.",
    "headline.none": "لا توجد وثيقة سارية للمطالبة بموجبها",
    "headline.ready": "{count} وثيقة سارية جاهزة للاختيار"
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/** Static: no peril catalogue exists in the schema, and the domain pack does
 * not rename these (checked against modules/vocabulary.ts). */
const PERILS = ["fire", "theft", "collision", "weather", "liability", "other"] as const;

/** `FnolBody.channel` is a free string; these are the ones a desk actually
 * types, and a person picking "Phone" beats a person typing "phone " (§14 keeps
 * the words in the label table, not here). */
const CHANNELS = ["phone", "email", "whatsapp", "web", "branch", "broker"] as const;

/* ----------------------------------------------------------------- shapes */

export type CoverageState =
  | "in_force"
  | "not_yet_incepted"
  | "lapsed_at_loss"
  | "cancelled_at_loss"
  | "out_of_cover"
  | "unknown";

export interface Coverage {
  coverageState: CoverageState;
  policyVersionId: string | null;
  versionSeq: number | null;
  limits: unknown;
  excessMinor: number;
  warnings: string[];
}

export interface PolicyOption {
  id: string;
  policyNo: string;
  customerId: string;
  status: string;
  startAt: number;
  endAt: number;
}

/* ---------------------------------------------------------------- helpers */

async function safe<T>(call: Promise<T>, fallback: T): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

// Arithmetic on a count the caller already has, not an agent, so it never
// carries the ✦ mark (CLAUDE.md §11). There is no queue here to summarise —
// this is an intake form — so the one real thing worth saying up front is
// whether there is a policy to register the claim against at all.
export function headlineFor(policyCount: number, l: Label): string {
  return policyCount === 0 ? l("headline.none") : l("headline.ready", { count: String(policyCount) });
}

/** A date input gives "2026-08-04"; the schema wants epoch millis. */
export function epochOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const policies = await safe(
    api<{ data: PolicyOption[] }>(
      `/v1/axis/policies?status=active,bound&sort=policyNo&order=asc&limit=${PAGE}`,
      { env, request }
    ),
    { data: [] as PolicyOption[] }
  );
  const named = await names(
    policies.data.map((policy) => policy.customerId),
    { env, request }
  );
  return { policies: policies.data, named };
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
  coverage?: Coverage;
  claimId?: string;
  claimNo?: string;
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null
});

/**
 * The `POST /v1/axis/claims` body. Pure so the validation can be tested
 * without a request: every branch here is a refusal the operator has to read.
 * `amountMinor` is the real `FnolBody` field — the design doc's prose calls it
 * `notifiedMinor`, which does not exist in the schema.
 */
export function fnolFrom(form: FormData): { body: Record<string, unknown> } | { code: string } {
  const policyId = String(form.get("policyId") ?? "").trim();
  const incidentAt = epochOf(String(form.get("incidentAt") ?? ""));
  if (!policyId) return { code: "missing_policy" };
  if (incidentAt === null) return { code: "missing_date" };

  const rawAmount = String(form.get("amountMinor") ?? "").trim();
  let amountMinor: number | null = null;
  if (rawAmount) {
    amountMinor = Number(rawAmount);
    if (!Number.isFinite(amountMinor)) return { code: "bad_amount" };
  }

  return {
    body: {
      policyId,
      incidentAt,
      perilCode: String(form.get("perilCode") ?? "").trim() || null,
      causeCode: String(form.get("causeCode") ?? "").trim() || null,
      description: String(form.get("description") ?? "").trim() || null,
      amountMinor,
      contact: String(form.get("contact") ?? "").trim() || null,
      channel: String(form.get("channel") ?? "").trim() || null
    }
  };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "check-cover") {
      const policyId = String(form.get("policyId") ?? "").trim();
      const incidentAt = epochOf(String(form.get("incidentAt") ?? ""));
      if (!policyId) return refuse("missing_policy");
      if (incidentAt === null) return refuse("missing_date");

      // Read-only: runs before anything is written, so no idempotency key.
      const coverage = await api<Coverage>("/v1/axis/claims/coverage-check", {
        env,
        request,
        method: "POST",
        body: { policyId, incidentAt }
      });
      return { problem: null, done: "check-cover", coverage };
    }

    if (intent === "register") {
      const built = fnolFrom(form);
      if ("code" in built) return refuse(built.code);

      const out = await api<{ claim: { id: string; claimNo: string } }>("/v1/axis/claims", {
        env,
        request,
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
        body: built.body
      });
      return { problem: null, done: "register", claimId: out.claim.id, claimNo: out.claim.claimNo };
    }
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, done: null };
    throw error;
  }

  return refuse("bad_intent");
}

/** Codes this screen can phrase; anything else keeps the API's own wording. */
export function phrase(problem: Refusal, l: Label): Refusal {
  const key = `problem.${problem.code ?? ""}`;
  const text = l(key);
  return text === key ? problem : { ...problem, title: text };
}

/**
 * The picker used to submit a ULID a person had to type, and offered
 * `POL-000123 — cu_01KE953T…` to read. A policy is chosen by its number and
 * the person it belongs to; the id stays the value because that is what the
 * API takes.
 */
export function policyChoices(
  policies: readonly PolicyOption[],
  named: Names
): Array<{ value: string; label: string }> {
  return policies.map((policy) => {
    const customer = who(policy.customerId, named);
    return { value: policy.id, label: customer ? `${policy.policyNo} — ${customer}` : policy.policyNo };
  });
}

/* ---------------------------------------------------------------- render */

const COVERAGE_TONE: Record<CoverageState, BadgeTone> = {
  in_force: "success",
  not_yet_incepted: "warning",
  lapsed_at_loss: "danger",
  cancelled_at_loss: "danger",
  out_of_cover: "danger",
  unknown: "neutral"
};

export default function FnolIntake() {
  const { policies, named } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const shell = useAxisSessionData();
  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  const coverage = result?.coverage;
  const registerable = coverage?.coverageState === "in_force";
  const headline = headlineFor(policies.length, l);

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{headline}</h1>
        <p className="max-w-prose font-ui text-13 text-subtle">{l("intro")}</p>
      </header>

      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}
      {result?.done === "register" ? (
        <Card className="p-4">{l("done.register", { claimNo: result.claimNo ?? "" })}</Card>
      ) : null}

      <Form method="post" id="fnol-form" className="space-y-4">
        <div className="flex flex-wrap gap-4">
          <Field label={l("policyId")} hint={l("hint.policy")} required className="min-w-72 flex-1">
            <Select name="policyId" options={policyChoices(policies, named)} placeholder={l("choose")} />
          </Field>

          <Field label={l("field.incidentAt")} required className="min-w-56 flex-1">
            <DatePicker name="incidentAt" required />
          </Field>
        </div>

        <div className="flex flex-wrap gap-4">
          <Field label={l("field.peril")} className="min-w-56 flex-1">
            <Select
              name="perilCode"
              options={PERILS.map((code) => ({ value: code, label: l(`peril.${code}`) }))}
              placeholder={l("choose")}
            />
          </Field>

          <Field label={l("field.cause")} hint={l("hint.cause")} className="min-w-72 flex-1">
            <Input name="causeCode" />
          </Field>
        </div>

        <Field label={l("field.description")}>
          <Textarea name="description" />
        </Field>

        <div className="flex flex-wrap gap-4">
          <Field label={l("field.amount")} hint={l("hint.amount")} className="min-w-56 flex-1">
            <MoneyField name="amountMinor" currency={shell?.currency ?? "ZAR"} locale={locale} />
          </Field>

          <Field label={l("field.contact")} hint={l("hint.contact")} className="min-w-56 flex-1">
            <Input name="contact" />
          </Field>

          <Field label={l("field.channel")} className="min-w-56 flex-1">
            <Select
              name="channel"
              options={CHANNELS.map((code) => ({ value: code, label: l(`channel.${code}`) }))}
              placeholder={l("choose")}
            />
          </Field>
        </div>

        <Button type="submit" name="intent" value="check-cover" loading={busy}>
          {l("checkCover.submit")}
        </Button>
      </Form>

      {coverage ? (
        <Card className="space-y-2 p-4">
          <h2 className="font-medium">{l("coverage.title")}</h2>
          <Badge tone={COVERAGE_TONE[coverage.coverageState]}>{l(`coverageState.${coverage.coverageState}`)}</Badge>
          {coverage.warnings.map((warning) => (
            <p key={warning} className="text-sm text-muted">
              {warning}
            </p>
          ))}

          {registerable ? (
            <Button type="submit" name="intent" value="register" form="fnol-form" loading={busy}>
              {l("register.submit")}
            </Button>
          ) : (
            <GuardrailNotice
              tone="warning"
              title={l("guardrail.title")}
              reason={l(`coverageState.${coverage.coverageState}`)}
              action={
                <Button type="submit" name="intent" value="register" form="fnol-form" loading={busy}>
                  {l("guardrail.registerAnyway")}
                </Button>
              }
            />
          )}
        </Card>
      ) : null}
    </div>
  );
}

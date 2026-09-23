import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, Card, Checkbox, DatePicker, EmptyState, Field, GuardrailNotice, Money, MoneyField, Textarea } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { labelsFrom } from "./detail-kit";
import { policyLede, type Policy } from "./policy-detail";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";

// A mid-term change is priced before it is written (§B.1): preview calls the
// pricing engine and writes nothing; confirm writes exactly the changeset the
// preview priced. Neither call carries a client idempotency key — the API
// keys the write off policy id + changeset hash server-side.

export const PERM = { read: "axis:policies:read", endorse: "axis:policies:endorse" } as const;

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Endorse {noun}",
    intro: "Price the change first. Nothing is written until you confirm what was priced.",
    back: "Back to the {noun}",
    heroLede: "{status} · {from} – {to}",
    "field.changes": "Changes (JSON)",
    "field.changesHint": "An object of the fields changing, e.g. {\"sumInsuredMinor\": 5000000}.",
    "field.effectiveFrom": "Effective from",
    "field.premiumMinor": "New premium",
    "field.reason": "Reason",
    "preview.submit": "Price this change",
    "quote.proRataDays": "Pro-rata days",
    "quote.chargeMinor": "Charge",
    "quote.refundMinor": "Refund",
    "quote.premiumDeltaMinor": "Premium change",
    "quote.taxDeltaMinor": "Tax change",
    "quote.commissionDeltaMinor": "Commission change",
    referralNotice: "This change also needs a referral before it can be confirmed.",
    "confirm.confirm": "I have checked the figures above and want this change written.",
    "confirm.submit": "Confirm the endorsement",
    blockedTitle: "This {noun} cannot be endorsed",
    blockedReason: "Only a bound or active {noun} can be endorsed.",
    blockedTermEnded: "This {noun}'s term has ended, so there is no cover left to change. Renew it instead.",
    deniedTitle: "You cannot read this {noun}",
    missingTitle: "No such {noun}",
    missingBody: "It may have been written under another tenant, or the link is stale.",
    approvalTitle: "This endorsement needs an approval first",
    approvalBody: "Policy {policy} holds this change for a second pair of eyes. It is written once someone approves it.",
    doneTitle: "Endorsement written",
    doneBody: "The {noun} is now at version {versionSeq}.",
    doneLink: "Back to the {noun}",
    "problem.missing_changes": "Describe at least one change first.",
    "problem.bad_changes": "Changes has to be a JSON object of the fields changing.",
    "problem.bad_intent": "The form did not carry an action this screen recognises."
  },
  ar: {
    title: "تعديل {noun}",
    intro: "سعّر التغيير أولًا. لا يُكتب شيء حتى تؤكد ما تم تسعيره.",
    back: "العودة إلى {noun}",
    heroLede: "{status} · من {from} إلى {to}",
    "field.changes": "التغييرات (JSON)",
    "field.changesHint": "كائن بالحقول المتغيرة، مثل {\"sumInsuredMinor\": 5000000}.",
    "field.effectiveFrom": "سارٍ من",
    "field.premiumMinor": "القسط الجديد",
    "field.reason": "السبب",
    "preview.submit": "سعّر هذا التغيير",
    "quote.proRataDays": "أيام التناسب",
    "quote.chargeMinor": "الرسم",
    "quote.refundMinor": "الاسترداد",
    "quote.premiumDeltaMinor": "تغيّر القسط",
    "quote.taxDeltaMinor": "تغيّر الضريبة",
    "quote.commissionDeltaMinor": "تغيّر العمولة",
    referralNotice: "يحتاج هذا التغيير أيضًا إلى إحالة قبل تأكيده.",
    "confirm.confirm": "راجعت الأرقام أعلاه وأريد كتابة هذا التغيير.",
    "confirm.submit": "تأكيد التعديل",
    blockedTitle: "لا يمكن تعديل {noun}",
    blockedReason: "يمكن تعديل {noun} السارية أو الملزمة فقط.",
    blockedTermEnded: "انتهت مدة {noun}، فلم تبقَ تغطية يمكن تعديلها. جدّدها بدلًا من ذلك.",
    deniedTitle: "لا يمكنك قراءة {noun}",
    missingTitle: "لا يوجد سجل بهذا المعرف ({noun})",
    missingBody: "قد تكون مكتوبة تحت مستأجر آخر، أو أن الرابط قديم.",
    approvalTitle: "يحتاج هذا التعديل إلى موافقة أولًا",
    approvalBody: "سياسة {policy} تحتجز هذا التغيير لمراجعة ثانية. يُكتب بعد موافقة صاحب الصلاحية.",
    doneTitle: "تمت كتابة التعديل",
    doneBody: "أصبح {noun} الآن عند الإصدار {versionSeq}.",
    doneLink: "العودة إلى {noun}",
    "problem.missing_changes": "صف تغييرًا واحدًا على الأقل أولًا.",
    "problem.bad_changes": "يجب أن تكون التغييرات كائن JSON بالحقول المتغيرة.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة."
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

const base = labelsFrom(LABELS);

/**
 * `{noun}` is the record's industry name, supplied by the active domain pack
 * rather than written into the strings above (CLAUDE.md §14). `{policy}` in
 * `approvalBody` stays the *governance* policy — a platform word the pack must
 * not rename. Same shape as policy-cancel.tsx.
 */
export function labelsIn(locale: string, pack?: string): Label {
  const l = base(locale, pack);
  const noun = l("policyId").toLocaleLowerCase(locale);
  return (key, vars) => l(key, { noun, ...vars });
}

/* ----------------------------------------------------------------- shapes */

export interface EndorseQuote {
  proRataDays: number;
  termDays: number;
  premiumDeltaMinor: number;
  taxDeltaMinor: number;
  commissionDeltaMinor: number;
  chargeMinor: number;
  commissionChargeMinor: number;
  refundMinor: number;
  needsApproval: boolean;
  needsReferral: boolean;
}

/* ---------------------------------------------------------------- helpers */

/** A date input gives "2026-08-04"; the schema wants epoch millis. */
export function epochOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Why this cover cannot be endorsed, as a label key, or `null` if it can.
 *
 * A deliberate second copy of `endorsementBlocker`
 * (`apps/api/src/engines/axis-endorse.ts`), which stays the authority: the API
 * refuses on both conditions whatever this screen says, and `apps/web` cannot
 * import from `apps/api`. Keep the two in step — a screen that knows only half
 * the rule offers a form the API answers with a 409, and the desk reads that as
 * the product being broken.
 *
 * The term half matters on its own because nothing moves a policy off `active`
 * the instant its term runs out; a cover past `endAt` is still on risk by status
 * and still unendorsable. Half-open, like every other window here: `endAt`
 * itself is outside the term.
 */
export function blockedReason(
  policy: { status: string; endAt: number },
  now: number = Date.now()
): string | null {
  if (policy.status !== "bound" && policy.status !== "active") return "blockedReason";
  return now >= policy.endAt ? "blockedTermEnded" : null;
}

/**
 * The `changes` field, pure so its refusals can be tested without a request.
 * Empty input refuses rather than pricing nothing; anything that is not a
 * JSON object (an array, a scalar, malformed JSON) refuses too.
 */
export function changesFrom(form: FormData): { changes: Record<string, unknown> } | { code: string } {
  const raw = String(form.get("changes") ?? "");
  if (!raw) return { code: "missing_changes" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { code: "bad_changes" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { code: "bad_changes" };
  return { changes: parsed as Record<string, unknown> };
}

/** The optional fields, each omitted from the request body when not given. */
function extrasFrom(form: FormData) {
  const reason = String(form.get("reason") ?? "").trim() || null;
  const effectiveFrom = epochOf(String(form.get("effectiveFrom") ?? ""));
  const rawPremium = String(form.get("premiumMinor") ?? "").trim();
  const premiumMinor = rawPremium ? Number(rawPremium) : null;
  return { reason, effectiveFrom, premiumMinor };
}

function bodyFrom(changes: Record<string, unknown>, extras: ReturnType<typeof extrasFrom>) {
  return {
    changes,
    ...(extras.reason ? { reason: extras.reason } : {}),
    ...(extras.effectiveFrom !== null ? { effectiveFrom: extras.effectiveFrom } : {}),
    ...(extras.premiumMinor !== null ? { premiumMinor: extras.premiumMinor } : {})
  };
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  // F55: `may.endorse` is the actor's real permission, not an assumption that
  // "the read worked, so endorse is on". Reading a policy and endorsing it are
  // different grants; the button must reflect the latter or the actor only
  // discovers the gate when the POST itself 403s.
  let mayEndorse = false;
  try {
    const me = await fetchMe(env, request);
    mayEndorse = new Set(me.permissions).has(PERM.endorse);
  } catch (error) {
    // An unresolvable actor cannot hold the endorse grant — degrade to false
    // rather than throwing past the guard below. Non-API failures rethrow.
    if (!(error instanceof ApiError)) throw error;
  }
  try {
    const policy = await api<Policy>(`/v1/axis/policies/${id}`, { env, request });
    return { policy, notFound: false, may: { read: true, endorse: mayEndorse } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { policy: null, notFound: true, may: { read: true, endorse: mayEndorse } };
    }
    if (error instanceof ApiError && error.status === 403) {
      return { policy: null, notFound: false, may: { read: false, endorse: false } };
    }
    throw error;
  }
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
  preview?: EndorseQuote;
  changes?: Record<string, unknown>;
  reason?: string | null;
  effectiveFrom?: number | null;
  premiumMinor?: number | null;
  policy?: { id: string; versionSeq: number };
  version?: { id: string };
  txn?: { id: string };
}

const refuse = (code: string, status = 400): ActionResult => ({
  problem: { title: code, status, code },
  done: null
});

export async function action({ request, context, params }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "preview") {
      const built = changesFrom(form);
      if ("code" in built) return refuse(built.code);
      const extras = extrasFrom(form);

      // Read-only pricing call: runs before anything is written, so no idempotency key.
      const preview = await api<EndorseQuote>(`/v1/axis/policies/${id}/endorse/preview`, {
        env,
        request,
        method: "POST",
        body: bodyFrom(built.changes, extras)
      });
      return { problem: null, done: "preview", preview, changes: built.changes, ...extras };
    }

    if (intent === "confirm") {
      const built = changesFrom(form);
      if ("code" in built) return refuse(built.code);
      const extras = extrasFrom(form);

      // The API keys idempotency off policy id + changeset hash server-side.
      const out = await api<{ policy: { id: string; versionSeq: number }; version: { id: string }; txn: { id: string } }>(
        `/v1/axis/policies/${id}/endorse`,
        { env, request, method: "POST", body: bodyFrom(built.changes, extras) }
      );
      return { problem: null, done: "confirm", policy: out.policy, version: out.version, txn: out.txn };
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

/* ---------------------------------------------------------------- render */

export default function PolicyEndorse() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  const policy = loaded.policy;

  if (!policy) {
    return (
      <Shell l={l}>
        <EmptyState
          title={loaded.notFound ? l("missingTitle") : l("deniedTitle")}
          body={loaded.notFound ? l("missingBody") : undefined}
        />
      </Shell>
    );
  }

  if (result?.done === "confirm") {
    return (
      <Shell l={l} policy={policy} locale={locale}>
        <EmptyState
          title={l("doneTitle")}
          body={l("doneBody", { versionSeq: String(result.policy?.versionSeq ?? "") })}
          action={
            <Button asChild>
              <Link to={`/axis/policies/${policy.id}/detail`}>{l("doneLink")}</Link>
            </Button>
          }
        />
      </Shell>
    );
  }

  const blocked = blockedReason(policy);
  if (blocked) {
    return (
      <Shell l={l} policy={policy} locale={locale}>
        <GuardrailNotice title={l("blockedTitle")} reason={l(blocked)} />
      </Shell>
    );
  }

  const preview = result?.done === "preview" ? result.preview : undefined;

  return (
    <Shell l={l} policy={policy} locale={locale}>
      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}

      <Form method="post" id="endorse-form" className="flex max-w-2xl flex-col gap-4">
        <input type="hidden" name="intent" value="preview" />
        <Field label={l("field.changes")} required hint={l("field.changesHint")}>
          <Textarea name="changes" rows={3} required defaultValue={JSON.stringify(result?.changes ?? {})} />
        </Field>
        <Field label={l("field.effectiveFrom")}>
          <DatePicker name="effectiveFrom" />
        </Field>
        <Field label={l("field.premiumMinor")}>
          <MoneyField name="premiumMinor" currency={policy.currency} locale={locale} />
        </Field>
        <Field label={l("field.reason")}>
          <Textarea name="reason" rows={2} defaultValue={result?.reason ?? ""} />
        </Field>
        <div>
          <Button type="submit" name="intent" value="preview" loading={busy}>
            {l("preview.submit")}
          </Button>
        </div>
      </Form>

      {preview ? (
        <Card className="flex flex-col gap-3 p-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 sm:grid-cols-3">
            <Facet term={l("quote.proRataDays")}>{preview.proRataDays}</Facet>
            <Facet term={l("quote.premiumDeltaMinor")}>
              <Money amountMinor={preview.premiumDeltaMinor} currency={policy.currency} locale={locale} signed />
            </Facet>
            <Facet term={l("quote.taxDeltaMinor")}>
              <Money amountMinor={preview.taxDeltaMinor} currency={policy.currency} locale={locale} signed />
            </Facet>
            <Facet term={l("quote.commissionDeltaMinor")}>
              <Money amountMinor={preview.commissionDeltaMinor} currency={policy.currency} locale={locale} signed />
            </Facet>
            <Facet term={l("quote.chargeMinor")}>
              <Money amountMinor={preview.chargeMinor} currency={policy.currency} locale={locale} />
            </Facet>
            <Facet term={l("quote.refundMinor")}>
              <Money amountMinor={preview.refundMinor} currency={policy.currency} locale={locale} />
            </Facet>
          </dl>

          {preview.needsReferral ? <GuardrailNotice title={l("referralNotice")} reason={null} /> : null}

          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="confirm" />
            <input type="hidden" name="changes" value={JSON.stringify(result?.changes ?? {})} />
            <input type="hidden" name="reason" value={result?.reason ?? ""} />
            <input type="hidden" name="effectiveFrom" value={result?.effectiveFrom ? String(result.effectiveFrom) : ""} />
            <input type="hidden" name="premiumMinor" value={result?.premiumMinor ? String(result.premiumMinor) : ""} />
            <Checkbox name="confirm" required label={l("confirm.confirm")} />
            <div>
              <Button type="submit" loading={busy} disabled={preview.needsReferral}>
                {l("confirm.submit")}
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}
    </Shell>
  );
}

/**
 * The not-found/denied branch has no policy to identify — it keeps the old
 * generic title. Every other branch has already loaded the real policy, so its
 * hero names it directly, matching policy-detail.tsx's pattern.
 */
function Shell({
  l,
  policy,
  locale,
  children
}: {
  l: Label;
  policy?: Pick<Policy, "id" | "policyNo" | "status" | "startAt" | "endAt"> | null;
  locale?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      {policy ? (
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="page-title">{`${l("policyId")} ${policy.policyNo}`}</h1>
            <p className="font-ui text-13 text-muted">{policyLede(policy, l, locale ?? "en")}</p>
            <Link to={`/axis/policies/${policy.id}/detail`} className="w-fit font-ui text-13 text-accent underline">
              {l("back")}
            </Link>
          </div>
        </header>
      ) : (
        <header className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold">{l("title")}</h1>
          <p className="text-sm text-muted">{l("intro")}</p>
        </header>
      )}
      {children}
    </div>
  );
}

function Facet({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="font-ui text-12 text-subtle">{term}</dt>
      <dd className="font-ui text-13 text-text">{children}</dd>
    </div>
  );
}

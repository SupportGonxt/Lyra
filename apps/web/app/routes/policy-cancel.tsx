import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Button, Card, Checkbox, DatePicker, EmptyState, Field, Money, Select, Textarea } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { labelsFrom } from "./detail-kit";
import { policyLede, type Policy } from "./policy-detail";
import { Gate } from "./staff";
import { useAxisSessionData } from "./axis-shell";

// Cancellation is priced before it is written (§B.2/§D.5): preview quotes the
// refund and clawback and writes nothing; confirm writes exactly what the
// preview priced. Neither call carries a client idempotency key — the API
// derives its own from the policy id server-side, same as endorse.

export const PERM = { read: "axis:policies:read", cancel: "axis:policies:cancel" } as const;

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Cancel {noun}",
    intro: "Price the cancellation first. Nothing is written until you confirm what was priced.",
    back: "Back to the {noun}",
    heroLede: "{status} · {from} – {to}",
    "field.reasonCode": "Reason",
    "field.refundMethod": "Refund method",
    "field.refundMethod.credit": "Credit note",
    "field.refundMethod.bank": "Bank transfer",
    "field.refundMethod.none": "None — premium forfeited",
    "field.note": "Note",
    "field.effectiveAt": "Effective from",
    "preview.submit": "Price this cancellation",
    "quote.proRataDays": "Pro-rata days",
    "quote.refundMinor": "Refund",
    "quote.clawbackMinor": "Commission clawback",
    "confirm.confirm": "I have checked the figures above and want this cancellation written.",
    "confirm.submit": "Confirm the cancellation",
    blockedTitle: "This {noun} cannot be cancelled",
    blockedReason: "Only a bound or active {noun} can be cancelled.",
    deniedTitle: "You cannot read this {noun}",
    missingTitle: "No such {noun}",
    missingBody: "It may have been written under another tenant, or the link is stale.",
    approvalTitle: "This cancellation needs an approval first",
    approvalBody: "Policy {policy} holds this refund for a second pair of eyes. It is written once someone approves it.",
    doneTitle: "Cancellation written",
    doneBody: "The {noun} is now cancelled.",
    doneLink: "Back to the {noun}",
    "problem.missing_reason": "Give a reason for the cancellation first.",
    "problem.bad_intent": "The form did not carry an action this screen recognises."
  },
  ar: {
    title: "إلغاء {noun}",
    intro: "سعّر الإلغاء أولًا. لا يُكتب شيء حتى تؤكد ما تم تسعيره.",
    back: "العودة إلى {noun}",
    heroLede: "{status} · من {from} إلى {to}",
    "field.reasonCode": "السبب",
    "field.refundMethod": "طريقة الاسترداد",
    "field.refundMethod.credit": "إشعار دائن",
    "field.refundMethod.bank": "تحويل بنكي",
    "field.refundMethod.none": "لا شيء — القسط غير مسترد",
    "field.note": "ملاحظة",
    "field.effectiveAt": "ساري من",
    "preview.submit": "سعّر هذا الإلغاء",
    "quote.proRataDays": "أيام التناسب",
    "quote.refundMinor": "الاسترداد",
    "quote.clawbackMinor": "استرجاع العمولة",
    "confirm.confirm": "راجعت الأرقام أعلاه وأريد كتابة هذا الإلغاء.",
    "confirm.submit": "تأكيد الإلغاء",
    blockedTitle: "لا يمكن إلغاء {noun}",
    blockedReason: "يمكن إلغاء {noun} السارية أو الملزمة فقط.",
    deniedTitle: "لا يمكنك قراءة {noun}",
    missingTitle: "لا يوجد سجل بهذا المعرف ({noun})",
    missingBody: "قد تكون مكتوبة تحت مستأجر آخر، أو أن الرابط قديم.",
    approvalTitle: "يحتاج هذا الإلغاء إلى موافقة أولًا",
    approvalBody: "سياسة {policy} تحتجز هذا الاسترداد لمراجعة ثانية. يُكتب بعد موافقة صاحب الصلاحية.",
    doneTitle: "تمت كتابة الإلغاء",
    doneBody: "{noun} الآن ملغاة.",
    doneLink: "العودة إلى {noun}",
    "problem.missing_reason": "أدخل سببًا للإلغاء أولًا.",
    "problem.bad_intent": "لم يحمل النموذج إجراءً تعرفه هذه الشاشة."
  }
};

export type Label = (key: string, vars?: Record<string, string>) => string;

const base = labelsFrom(LABELS);

/**
 * `{noun}` is the record's industry name, supplied by the active domain pack
 * rather than written into the strings above (CLAUDE.md §14) — the same screen
 * cancels a policy for an insurer and an order for a retailer. English wants it
 * lower-case mid-sentence and every use above is mid-sentence; Arabic has no
 * case, so lowering is a no-op there.
 *
 * `{policy}` stays the *governance* policy in `approvalBody` — a platform word,
 * not an industry one, which is why the pack must not touch it.
 */
export function labelsIn(locale: string, pack?: string): Label {
  const l = base(locale, pack);
  const noun = l("policyId").toLocaleLowerCase(locale);
  return (key, vars) => l(key, { noun, ...vars });
}

/* ----------------------------------------------------------------- shapes */

export interface CancelQuote {
  effectiveAt: number;
  refundMinor: number;
  clawbackMinor: number;
  proRataDays: number;
  currency: string;
}

/* ---------------------------------------------------------------- helpers */

/** A date input gives "2026-08-04"; the schema wants epoch millis. */
export function epochOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** Only a bound or active policy is cancellable — mirrors the engine's own gate. */
export function blockedReason(policy: { status: string }): string | null {
  return policy.status === "bound" || policy.status === "active" ? null : "blockedReason";
}

/** The optional fields, each omitted from the request body when not given. */
function extrasFrom(form: FormData) {
  const reasonCode = String(form.get("reasonCode") ?? "").trim();
  const refundMethod = String(form.get("refundMethod") ?? "credit").trim() || "credit";
  const note = String(form.get("note") ?? "").trim() || null;
  const effectiveAt = epochOf(String(form.get("effectiveAt") ?? ""));
  return { reasonCode, refundMethod, note, effectiveAt };
}

function bodyFrom(extras: ReturnType<typeof extrasFrom>) {
  return {
    reasonCode: extras.reasonCode,
    refundMethod: extras.refundMethod,
    ...(extras.effectiveAt !== null ? { effectiveAt: extras.effectiveAt } : {}),
    ...(extras.note ? { note: extras.note } : {})
  };
}

/* ----------------------------------------------------------------- loader */

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  // F55: same fix as policy-endorse — `may.cancel` is the actor's real grant,
  // not an assumption from a successful read.
  let mayCancel = false;
  try {
    const me = await fetchMe(env, request);
    mayCancel = new Set(me.permissions).has(PERM.cancel);
  } catch (error) {
    // An unresolvable actor cannot hold the cancel grant — degrade to false
    // rather than throwing past the guard below. Non-API failures rethrow.
    if (!(error instanceof ApiError)) throw error;
  }
  try {
    const policy = await api<Policy>(`/v1/axis/policies/${id}`, { env, request });
    return { policy, notFound: false, may: { read: true, cancel: mayCancel } };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return { policy: null, notFound: true, may: { read: true, cancel: mayCancel } };
    }
    if (error instanceof ApiError && error.status === 403) {
      return { policy: null, notFound: false, may: { read: false, cancel: false } };
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
  preview?: CancelQuote;
  reasonCode?: string;
  refundMethod?: string;
  note?: string | null;
  effectiveAt?: number | null;
  policy?: { id: string; status: string };
  txn?: { id: string } | null;
  refundTxn?: { id: string } | null;
  refundMinor?: number;
  clawbackMinor?: number;
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
      const extras = extrasFrom(form);
      if (!extras.reasonCode) return refuse("missing_reason");

      // Read-only pricing call: runs before anything is written, so no idempotency key.
      const preview = await api<CancelQuote>(`/v1/axis/policies/${id}/cancel/preview`, {
        env,
        request,
        method: "POST",
        body: bodyFrom(extras)
      });
      return { problem: null, done: "preview", preview, ...extras };
    }

    if (intent === "confirm") {
      const extras = extrasFrom(form);
      if (!extras.reasonCode) return refuse("missing_reason");

      // The API derives its own idempotency key from the policy id server-side.
      const out = await api<{
        policy: { id: string; status: string };
        txn: { id: string } | null;
        refundTxn: { id: string } | null;
        refundMinor: number;
        clawbackMinor: number;
        effectiveAt: number;
      }>(`/v1/axis/policies/${id}/cancel`, { env, request, method: "POST", body: bodyFrom(extras) });
      return {
        problem: null,
        done: "confirm",
        policy: out.policy,
        txn: out.txn,
        refundTxn: out.refundTxn,
        refundMinor: out.refundMinor,
        clawbackMinor: out.clawbackMinor,
        effectiveAt: out.effectiveAt
      };
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

const REFUND_METHODS = ["credit", "bank", "none"] as const;

export default function PolicyCancel() {
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
          body={l("doneBody")}
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
        <EmptyState title={l("blockedTitle")} body={l(blocked)} />
      </Shell>
    );
  }

  const preview = result?.done === "preview" ? result.preview : undefined;

  return (
    <Shell l={l} policy={policy} locale={locale}>
      {result?.problem ? <Gate problem={phrase(result.problem, l)} l={l} /> : null}

      <Form method="post" id="cancel-form" className="flex max-w-2xl flex-col gap-4">
        <input type="hidden" name="intent" value="preview" />
        <Field label={l("field.reasonCode")} required>
          <Textarea name="reasonCode" rows={2} required defaultValue={result?.reasonCode ?? ""} />
        </Field>
        <Field label={l("field.refundMethod")}>
          <Select
            name="refundMethod"
            defaultValue={result?.refundMethod ?? "credit"}
            options={REFUND_METHODS.map((method) => ({ value: method, label: l(`field.refundMethod.${method}`) }))}
          />
        </Field>
        <Field label={l("field.effectiveAt")}>
          <DatePicker name="effectiveAt" />
        </Field>
        <Field label={l("field.note")}>
          <Textarea name="note" rows={2} defaultValue={result?.note ?? ""} />
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
            <Facet term={l("quote.refundMinor")}>
              <Money amountMinor={preview.refundMinor} currency={preview.currency} locale={locale} />
            </Facet>
            <Facet term={l("quote.clawbackMinor")}>
              <Money amountMinor={preview.clawbackMinor} currency={preview.currency} locale={locale} />
            </Facet>
          </dl>

          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="confirm" />
            <input type="hidden" name="reasonCode" value={result?.reasonCode ?? ""} />
            <input type="hidden" name="refundMethod" value={result?.refundMethod ?? "credit"} />
            <input type="hidden" name="note" value={result?.note ?? ""} />
            <input type="hidden" name="effectiveAt" value={result?.effectiveAt ? String(result.effectiveAt) : ""} />
            <Checkbox name="confirm" required label={l("confirm.confirm")} />
            <div>
              <Button type="submit" loading={busy}>
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
            <h1 className="font-serif text-22 leading-[1.2] text-text">{`${l("policyId")} ${policy.policyNo}`}</h1>
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

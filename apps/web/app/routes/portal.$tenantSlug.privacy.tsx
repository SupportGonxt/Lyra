import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Button, Card, Field, Input, RadioGroup, Textarea, formatInstant } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";
import { Turnstile } from "../components/turnstile";

// J-C4 "Exercise privacy rights" (docs/06), public half. Same door as the
// comparison site next to it: no session, nothing but the tenant slug in the
// URL, so every string is either tenant brand data or this file's bilingual
// copy. ADR-0042 supersedes ADR-0041's staff-only intake.
//
// Verification is deliberately absent from this page. docs/12 names no
// verification method and `IdentityVerifier` has no implementation, so asking
// a stranger to upload an ID here would collect high-PII documents against no
// defined standard. The request is recorded unverified; staff verify before
// anything is packaged or erased.

const RIGHTS = ["access", "erasure", "rectification", "portability", "objection", "restriction"] as const;

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "privacy.title": "Your privacy rights",
    "privacy.intro":
      "Ask to see, correct, or delete the personal data held about you. We will confirm your identity before we act on the request.",
    "privacy.type": "What would you like to do?",
    "privacy.type.access": "See the data held about me",
    "privacy.type.erasure": "Delete my data",
    "privacy.type.rectification": "Correct something that is wrong",
    "privacy.type.portability": "Get a copy I can take elsewhere",
    "privacy.type.objection": "Object to how my data is used",
    "privacy.type.restriction": "Restrict how my data is used",
    "privacy.email": "Email address you deal with us on",
    "privacy.name": "Full name (optional)",
    "privacy.details": "Anything that helps us find your records, or what needs correcting (optional)",
    "privacy.submit": "Send request",
    "privacy.working": "Sending…",
    "privacy.success.title": "Request received",
    "privacy.success.body":
      "Keep this reference. We will contact you on this email address to confirm your identity, then respond by {due}.",
    "privacy.success.reference": "Reference",
    "privacy.error.validation": "Check the highlighted fields and try again.",
    "privacy.error.throttled": "Too many requests from this address — try again later.",
    "privacy.error.challenge": "The security check did not pass. Reload the page and try again.",
    "privacy.error.generic": "Something went wrong. Please try again.",
    "privacy.back": "Back to products"
  },
  ar: {
    "privacy.title": "حقوقك في الخصوصية",
    "privacy.intro":
      "اطلب الاطلاع على بياناتك الشخصية أو تصحيحها أو حذفها. سنتحقق من هويتك قبل تنفيذ الطلب.",
    "privacy.type": "ما الذي ترغب في فعله؟",
    "privacy.type.access": "الاطلاع على البيانات المحفوظة عني",
    "privacy.type.erasure": "حذف بياناتي",
    "privacy.type.rectification": "تصحيح معلومة غير صحيحة",
    "privacy.type.portability": "الحصول على نسخة يمكنني نقلها",
    "privacy.type.objection": "الاعتراض على طريقة استخدام بياناتي",
    "privacy.type.restriction": "تقييد استخدام بياناتي",
    "privacy.email": "البريد الإلكتروني الذي تتعامل معنا به",
    "privacy.name": "الاسم الكامل (اختياري)",
    "privacy.details": "أي معلومة تساعدنا في العثور على سجلاتك، أو ما يحتاج إلى تصحيح (اختياري)",
    "privacy.submit": "إرسال الطلب",
    "privacy.working": "جارٍ الإرسال…",
    "privacy.success.title": "تم استلام الطلب",
    "privacy.success.body":
      "احتفظ بهذا الرقم المرجعي. سنتواصل معك على هذا البريد للتحقق من هويتك، ثم نرد عليك بحلول {due}.",
    "privacy.success.reference": "الرقم المرجعي",
    "privacy.error.validation": "تحقق من الحقول المحددة وحاول مرة أخرى.",
    "privacy.error.throttled": "طلبات كثيرة من هذا العنوان — حاول لاحقًا.",
    "privacy.error.challenge": "لم يجتز فحص الأمان. أعد تحميل الصفحة وحاول مرة أخرى.",
    "privacy.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "privacy.back": "العودة إلى المنتجات"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

interface SiteResponse {
  tenant: { name: string; brand: Brand };
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const site = await api<SiteResponse>(`/v1/portal/${tenantSlug}/site`, { env, request }).catch(asRouteError);
  return {
    locale: localeFrom(request),
    tenantSlug,
    tenant: site.tenant,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? `${loaded.tenant.name} — privacy` : "" }
];

type ActionData = { ok: true; reference: string; dueAt: number } | { ok: false; errorKey: string };

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();

  try {
    const created = await api<{ reference: string; dueAt: number }>(`/v1/portal/${tenantSlug}/privacy-requests`, {
      env,
      method: "POST",
      body: {
        type: String(form.get("type") ?? ""),
        email: String(form.get("email") ?? "").trim(),
        ...(form.get("name") ? { name: String(form.get("name")).trim() } : {}),
        ...(form.get("details") ? { details: String(form.get("details")).trim() } : {}),
        ...(form.get("cf-turnstile-response")
          ? { turnstileToken: String(form.get("cf-turnstile-response")) }
          : {})
      }
    });
    return { ok: true, reference: created.reference, dueAt: created.dueAt } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const errorKey =
      error.status === 429
        ? "privacy.error.throttled"
        : error.status === 403
          ? "privacy.error.challenge"
          : error.status === 400
            ? "privacy.error.validation"
            : "privacy.error.generic";
    return { ok: false, errorKey } satisfies ActionData;
  }
}

export default function PortalPrivacy() {
  const { locale, tenantSlug, tenant, turnstileSiteKey } = useLoaderData<typeof loader>();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const l = labeller(locale);
  const busy = navigation.state !== "idle";

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="lyra-enter mx-auto max-w-2xl p-6">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-3">
            {tenant.brand.logo?.light ?? tenant.brand.logo?.mark ? (
              <img
                src={tenant.brand.logo?.light ?? tenant.brand.logo?.mark}
                alt={tenant.name}
                className="h-10 w-auto"
              />
            ) : null}
            <div className="flex flex-col gap-1">
              <h1 className="page-title">{l("privacy.title")}</h1>
              <p className="font-ui text-13 text-muted">{l("privacy.intro")}</p>
              <a className="w-fit font-ui text-13 text-accent underline" href={`/portal/${tenantSlug}`}>
                {l("privacy.back")}
              </a>
            </div>
          </div>
        </header>

        {result?.ok ? (
          <Card title={l("privacy.success.title")}>
            <p role="status" className="text-14">
              {l("privacy.success.body").replace(
                "{due}",
                formatInstant(result.dueAt, new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format)
              )}
            </p>
            <p className="mt-3 text-13 text-muted">
              {l("privacy.success.reference")}: <code className="font-mono">{result.reference}</code>
            </p>
          </Card>
        ) : (
          <Form method="post" className="flex flex-col gap-5">
            {result?.errorKey ? (
              <p role="alert" className="text-13 text-danger">
                {l(result.errorKey)}
              </p>
            ) : null}

            <div className="flex flex-col gap-2">
              <p className="font-ui text-13 font-medium text-muted">{l("privacy.type")}</p>
              <RadioGroup
                name="type"
                required
                defaultValue="access"
                label={l("privacy.type")}
                options={RIGHTS.map((right) => ({ value: right, label: l(`privacy.type.${right}`) }))}
              />
            </div>

            <Field label={l("privacy.email")} id="privacy-email">
              <Input name="email" type="email" autoComplete="email" required />
            </Field>
            <Field label={l("privacy.name")} id="privacy-name">
              <Input name="name" autoComplete="name" />
            </Field>
            <Field label={l("privacy.details")} id="privacy-details">
              <Textarea name="details" rows={4} />
            </Field>

            <Turnstile siteKey={turnstileSiteKey} locale={locale} />

            <Button type="submit" variant="primary" loading={busy}>
              {busy ? l("privacy.working") : l("privacy.submit")}
            </Button>
          </Form>
        )}

        <p className="mt-8 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("privacy.back")}
          </a>
        </p>
      </div>
    </main>
  );
}

import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Badge, Button, Card, Checkbox, Field, Input, Textarea } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { optionLabel } from "../modules/spec";
import { brandStyle } from "../components/shell";
import { Turnstile } from "../components/turnstile";

// The public comparison site (yallacompare-style, docs/decisions/ADR-0030). No
// session, no tenant-scoped caller — a lead can land here from an ad with
// nothing but the tenant's slug in the URL, so every string on the page is
// either the tenant's own brand data or this file's bilingual copy; there is
// no shared workspace catalogue to borrow from and no `:module` spec to route
// through.

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "portal.intro": "Compare products and get a quote in minutes.",
    "portal.introCount": "{n} products to compare — get a quote in minutes.",
    "portal.empty": "No products are available for comparison right now.",
    "portal.quote": "Get a quote",
    "portal.form.name": "Full name",
    "portal.form.email": "Email",
    "portal.form.phone": "Phone (optional)",
    "portal.form.message": "Anything we should know? (optional)",
    "portal.form.consent": "I agree to be contacted about this quote.",
    "portal.form.submit": "Request quote",
    "portal.form.working": "Sending…",
    "portal.form.success": "Thanks — we've received your request and will be in touch.",
    "portal.form.error.validation": "Check the highlighted fields and try again.",
    "portal.form.error.throttled": "Too many requests from this email — try again later.",
    "portal.form.error.challenge": "The security check did not pass. Reload the page and try again.",
    "portal.form.error.generic": "Something went wrong. Please try again.",
    "portal.privacy": "Your privacy rights",
    "portal.partners": "Partner with us",
    "portal.register": "Create an account",
    "portal.quick": "Quick quote — three details, real prices.",
    "portal.slow": "Leave your details and a specialist prices this one for you.",
    "portal.form.age": "Your age",
    "portal.form.sumInsured": "Value to insure",
    "portal.form.priorClaims": "I have claimed in the last 3 years.",
    "portal.form.tripDays": "Trip length (days)",
    "portal.form.winterSports": "Include winter sports.",
    "line.motor": "Motor",
    "line.health": "Health",
    "line.travel": "Travel",
    "line.home": "Home",
    "line.life": "Life",
    "line.sme": "SME",
    "line.card": "Card",
    "line.loan": "Loan",
    "line.account": "Account"
  },
  ar: {
    "portal.intro": "قارن المنتجات واحصل على عرض سعر خلال دقائق.",
    "portal.introCount": "{n} منتج للمقارنة — احصل على عرض سعر خلال دقائق.",
    "portal.empty": "لا توجد منتجات متاحة للمقارنة حاليًا.",
    "portal.quote": "احصل على عرض سعر",
    "portal.form.name": "الاسم الكامل",
    "portal.form.email": "البريد الإلكتروني",
    "portal.form.phone": "الهاتف (اختياري)",
    "portal.form.message": "هل هناك ما تود إخبارنا به؟ (اختياري)",
    "portal.form.consent": "أوافق على التواصل معي بخصوص هذا العرض.",
    "portal.form.submit": "طلب عرض سعر",
    "portal.form.working": "جارٍ الإرسال…",
    "portal.form.success": "شكرًا — استلمنا طلبك وسنتواصل معك قريبًا.",
    "portal.form.error.validation": "تحقق من الحقول المحددة وحاول مرة أخرى.",
    "portal.form.error.throttled": "طلبات كثيرة من هذا البريد — حاول لاحقًا.",
    "portal.form.error.challenge": "لم يجتز فحص الأمان. أعد تحميل الصفحة وحاول مرة أخرى.",
    "portal.form.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "portal.privacy": "حقوقك في الخصوصية",
    "portal.partners": "كن شريكًا معنا",
    "portal.register": "إنشاء حساب",
    "portal.quick": "عرض سعر سريع — ثلاث معلومات وأسعار حقيقية.",
    "portal.slow": "اترك بياناتك وسيقوم مختص بتسعير هذا المنتج لك.",
    "portal.form.age": "عمرك",
    "portal.form.sumInsured": "القيمة المراد تأمينها",
    "portal.form.priorClaims": "قدمت مطالبة خلال آخر 3 سنوات.",
    "portal.form.tripDays": "مدة الرحلة (أيام)",
    "portal.form.winterSports": "تضمين الرياضات الشتوية.",
    "line.motor": "السيارات",
    "line.health": "الصحة",
    "line.travel": "السفر",
    "line.home": "المنزل",
    "line.life": "الحياة",
    "line.sme": "الشركات الصغيرة",
    "line.card": "البطاقات",
    "line.loan": "القروض",
    "line.account": "الحسابات"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

/**
 * The hero's one line of narration. Real arithmetic on the catalogue the
 * loader just fetched — no ✦, this is not an agent's finding (CLAUDE.md
 * §11) — falling back to the plain invitation when there is nothing to
 * count yet (the empty state below already explains why).
 */
export function portalLede(l: (key: string) => string, productCount: number): string {
  if (productCount <= 0) return l("portal.intro");
  return l("portal.introCount").replace("{n}", String(productCount));
}

/**
 * J-C1's "3-field quick quote". The rating inputs a panel wants are per line
 * (packages/core seed: motor bands on age, travel on trip length), and the
 * public site is the one surface that has to ask for them in plain words. A
 * line that isn't listed still captures a lead — a takaful or referral panel
 * answers out of band, so there is nothing to ask for in the browser.
 */
type QuickField =
  | { name: string; labelKey: string; kind: "number"; min: number; max: number }
  | { name: string; labelKey: string; kind: "money" }
  | { name: string; labelKey: string; kind: "bool" };

const QUICK: Record<string, QuickField[]> = {
  motor: [
    { name: "age", labelKey: "portal.form.age", kind: "number", min: 18, max: 99 },
    { name: "sumInsuredMinor", labelKey: "portal.form.sumInsured", kind: "money" },
    { name: "priorClaims", labelKey: "portal.form.priorClaims", kind: "bool" }
  ],
  home: [
    { name: "sumInsuredMinor", labelKey: "portal.form.sumInsured", kind: "money" },
    { name: "priorClaims", labelKey: "portal.form.priorClaims", kind: "bool" }
  ],
  travel: [
    { name: "tripDays", labelKey: "portal.form.tripDays", kind: "number", min: 1, max: 365 },
    { name: "winterSports", labelKey: "portal.form.winterSports", kind: "bool" }
  ]
};

interface Product {
  id: string;
  line: string;
  name: string;
  providerName: string | null;
}

/** Mirrors `GET /v1/portal/{tenantSlug}/site` — apps/api/src/routes/portal.ts §site. */
interface SiteResponse {
  tenant: { name: string; brand: Brand; domainPack?: string };
  products: Product[];
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const site = await api<SiteResponse>(`/v1/portal/${tenantSlug}/site`, { env, request }).catch(asRouteError);
  return {
    locale: localeFrom(request),
    tenantSlug,
    site,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded?.site.tenant.name ?? "" }
];

type ActionData = {
  productId: string;
  ok: boolean;
  errorKey?: string;
};

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  const productId = String(form.get("productId") ?? "");
  const line = String(form.get("line") ?? "");

  // Money is entered in major units — nobody types fils — so it is converted
  // here rather than asking a member of the public to think in minor units.
  const inputs: Record<string, unknown> = {};
  for (const field of QUICK[line] ?? []) {
    const raw = form.get(field.name);
    if (field.kind === "bool") inputs[field.name] = raw === "on";
    else if (raw !== null && String(raw) !== "") {
      const value = Number(raw);
      if (Number.isFinite(value)) inputs[field.name] = field.kind === "money" ? Math.round(value * 100) : value;
    }
  }

  try {
    const created = await api<{ quoteRequestId: string; token?: string }>(`/v1/portal/${tenantSlug}/leads`, {
      env,
      method: "POST",
      body: {
        productId,
        name: String(form.get("name") ?? "").trim(),
        email: String(form.get("email") ?? "").trim(),
        ...(form.get("phone") ? { phone: String(form.get("phone")).trim() } : {}),
        ...(form.get("message") ? { message: String(form.get("message")).trim() } : {}),
        consent: form.get("consent") === "on",
        ...(Object.keys(inputs).length ? { inputs } : {}),
        ...(form.get("cf-turnstile-response")
          ? { turnstileToken: String(form.get("cf-turnstile-response")) }
          : {})
      }
    });
    // A token means the panel priced in-session: take the visitor straight to
    // the comparison. Without one the answer is "a human will call", which is
    // the older lead behaviour and stays on this page.
    if (created.token) {
      return redirect(
        `/portal/${tenantSlug}/quotes/${created.quoteRequestId}?token=${encodeURIComponent(created.token)}`
      );
    }
    return { productId, ok: true } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const errorKey =
      error.status === 429
        ? "portal.form.error.throttled"
        : error.status === 403
          ? "portal.form.error.challenge"
          : error.status === 400
            ? "portal.form.error.validation"
            : "portal.form.error.generic";
    return { productId, ok: false, errorKey } satisfies ActionData;
  }
}

export default function Portal() {
  const { locale, tenantSlug, site, turnstileSiteKey } = useLoaderData<typeof loader>();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const l = labeller(locale);
  const busy = navigation.state !== "idle";

  return (
    // The storefront is the one screen a stranger sees first, and it was the
    // one rendering on flat --bg with no arrival: the same star field and rise
    // the workspace uses (app.css), nothing bespoke.
    <main style={brandStyle(site.tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-4xl p-6">
        <header className="lyra-enter mb-8 flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-center gap-3">
            {site.tenant.brand.logo?.light ?? site.tenant.brand.logo?.mark ? (
              <img
                src={site.tenant.brand.logo?.light ?? site.tenant.brand.logo?.mark}
                alt={site.tenant.name}
                className="h-10 w-auto"
              />
            ) : null}
            <div className="flex flex-col gap-1">
              {/* A stranger reads the offer at arm's length: the storefront gets
                  the display step, not a workspace title's. */}
              <h1 className="font-serif text-36 leading-[1.15] text-text">{site.tenant.name}</h1>
              <p className="font-ui text-16 text-muted">{portalLede(l, site.products.length)}</p>
            </div>
          </div>
        </header>

        {site.products.length === 0 ? (
          <p className="text-14 text-muted">{l("portal.empty")}</p>
        ) : (
          <div className="lyra-stagger grid gap-4 sm:grid-cols-2">
            {site.products.map((product) => {
              const submitted = result?.productId === product.id ? result : undefined;
              return (
                <Card
                  key={product.id}
                  title={product.name}
                  description={product.providerName ?? undefined}
                  actions={
                    <Badge tone="accent">{optionLabel(l, "line", product.line)}</Badge>
                  }
                >
                  {submitted?.ok ? (
                    <p role="status" className="text-13 text-success">
                      {l("portal.form.success")}
                    </p>
                  ) : (
                    <>
                      {/* The promise used to live inside the form, where you
                          only read it after deciding to open it. It is the
                          reason to open it, so it sits above the control —
                          outside <details>, which requires <summary> first. */}
                      {/* A line without rating fields still takes the lead —
                          say so, rather than leaving the card silent about
                          what "get a quote" will actually do. */}
                      <p className="mb-3 text-13 text-muted">
                        {l(QUICK[product.line] ? "portal.quick" : "portal.slow")}
                      </p>
                      <details>
                        <summary className="inline-flex cursor-pointer select-none items-center gap-2 text-13 font-medium text-accent underline-offset-4 marker:content-none hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                          <span aria-hidden="true">→</span>
                          {l("portal.quote")}
                        </summary>
                        <Form method="post" className="mt-4 flex flex-col gap-3">
                          <input type="hidden" name="productId" value={product.id} />
                          <input type="hidden" name="line" value={product.line} />
                          {QUICK[product.line] ? (
                            <>
                              {QUICK[product.line]!.map((field) =>
                                field.kind === "bool" ? (
                                  <Checkbox key={field.name} name={field.name} label={l(field.labelKey)} />
                                ) : (
                                  <Field
                                    key={field.name}
                                    label={l(field.labelKey)}
                                    id={`${field.name}-${product.id}`}
                                  >
                                    <Input
                                      name={field.name}
                                      type="number"
                                      inputMode="numeric"
                                      required
                                      {...(field.kind === "number" ? { min: field.min, max: field.max } : { min: 1 })}
                                    />
                                  </Field>
                                )
                              )}
                            </>
                          ) : null}
                          {submitted?.errorKey ? (
                            <p role="alert" className="text-13 text-danger">
                              {l(submitted.errorKey)}
                            </p>
                          ) : null}
                          <Field label={l("portal.form.name")} id={`name-${product.id}`}>
                            <Input name="name" autoComplete="name" required />
                          </Field>
                          <Field label={l("portal.form.email")} id={`email-${product.id}`}>
                            <Input name="email" type="email" autoComplete="email" required />
                          </Field>
                          <Field label={l("portal.form.phone")} id={`phone-${product.id}`}>
                            <Input name="phone" type="tel" autoComplete="tel" />
                          </Field>
                          <Field label={l("portal.form.message")} id={`message-${product.id}`}>
                            <Textarea name="message" rows={3} />
                          </Field>
                          <Checkbox name="consent" required label={l("portal.form.consent")} />
                          <Turnstile siteKey={turnstileSiteKey} locale={locale} />
                          <Button type="submit" variant="primary" loading={busy}>
                            {busy ? l("portal.form.working") : l("portal.form.submit")}
                          </Button>
                          </Form>
                      </details>
                    </>
                  )}
                </Card>
              );
            })}
          </div>
        )}

        {/* J-C4's door has to be findable from the public site, or the right is
            theoretical. */}
        <footer className="mt-10 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}/privacy`}>
            {l("portal.privacy")}
          </a>
          {/* Same reason for J-X3: a partner who cannot find the sign-up door
              is a partner who emails someone instead. */}
          <a className="text-accent underline" href={`/portal/${tenantSlug}/partners`}>
            {l("portal.partners")}
          </a>
          {/* And the customer's own door. It creates a pending record and grants
              nothing, so it belongs beside the other two rather than dressed up
              as a sign-in. */}
          <a className="text-accent underline" href={`/portal/${tenantSlug}/register`}>
            {l("portal.register")}
          </a>
        </footer>
      </div>
    </main>
  );
}

import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Badge, Button, Card, EmptyState, Field, Input, Money, Select, Stat, Table, formatInstant } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";

// docs/modules/orbit.md §4 screen 5 — the Partner Portal, J-X3 "portal signup
// -> sandbox key -> mock quote in <30 min". Public door, same shape as the
// comparison site and the privacy intake next to it: no session, nothing but
// the tenant slug in the URL, every string either tenant brand data or this
// file's bilingual copy.
//
// ponytail: the whole screen is two POSTs and no session store. Signup mints
// the sandbox key (apps/api/src/routes/onboarding.ts) and hands back the
// plaintext exactly once; from then on the key IS the credential, so the
// status console asks the partner to paste it and we call the API with
// `Authorization: Bearer qvk_test_...` server-side. Nothing is kept between
// requests — no cookie, no KV, no partner session table to build and secure.
//
// ponytail: only what the sandbox key's own scopes can read is shown, and
// nothing more. SANDBOX_SCOPES is orbit:partners:read + dist:offerings:read +
// dist:quote_requests:read|create, so the partner sees their own record, their
// own usage and settlement rows, and their catalogue. Onboarding checklist
// steps need core:onboarding:read, which an anonymous signup deliberately does
// not get — the stage from the partner row is what stands in for them here.
// Upgrade path: add the checklist read to the scope list and render the same
// steps /onboarding/:kind/:ref shows staff.
//
// Stage never moves from this page. `orbit_partners` has no generic update
// (apps/api/src/resources.ts) — going live runs through
// POST /v1/onboarding/partners/:id/advance behind orbit:partners:update, so a
// partner cannot self-activate from the outside.

/** What a signup can call itself. Free text at the API (docs/21: the noun is
 *  the tenant's, not ours), a short list here so the form stays a form. */
const KINDS = ["aggregator", "bank", "broker", "retailer", "platform"] as const;

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "partners.title": "Partner integration",
    "partners.intro":
      "Sign up, get a sandbox key, and make your first call. Nothing you do here touches live business — the key is test-only until we move you live together.",
    "partners.signup": "Create a sandbox account",
    "partners.company": "Company name",
    "partners.kind": "What kind of business are you?",
    "partners.kind.aggregator": "Comparison or aggregator site",
    "partners.kind.bank": "Bank",
    "partners.kind.broker": "Broker",
    "partners.kind.retailer": "Retailer",
    "partners.kind.platform": "Software platform",
    "partners.contactName": "Your name (optional)",
    "partners.contactEmail": "Work email address",
    "partners.legal.title": "Legal identity (optional)",
    "partners.legal.note":
      "Only needed before we can pay you commission. Leave it blank now and add it when you go live.",
    "partners.legalName": "Registered legal name",
    "partners.registrationNo": "Company registration number",
    "partners.taxId": "Tax number",
    "partners.country": "Country of registration (2-letter code)",
    "partners.submit": "Create sandbox account",
    "partners.working": "Creating…",
    "partners.key.title": "Your sandbox key",
    "partners.key.warning": "Copy this now. It is shown once and we cannot show it to you again.",
    "partners.key.lost": "Lost it? Sign up again with a different email, or ask your contact to issue a new one.",
    "partners.key.partnerId": "Partner ID",
    "partners.key.stage": "Stage",
    "partners.key.next": "Try it — paste the key below, or run this from a terminal:",
    "partners.console.title": "Sandbox console",
    "partners.console.body":
      "Paste your sandbox key to check that it works and to see what your account has done so far. The key is used for this one request and never stored.",
    "partners.console.key": "Sandbox key",
    "partners.console.id": "Partner ID",
    "partners.console.run": "Check my account",
    "partners.console.running": "Checking…",
    "partners.console.ok": "The key works. Here is what the API answered.",
    "partners.quote.title": "Your first quote",
    "partners.quote.body":
      "Price a test case with your sandbox key. The number that comes back is made up — a working call, not a real price.",
    "partners.quote.line": "Which product line?",
    "partners.quote.amount": "Amount, in the smallest unit of the currency",
    "partners.quote.currency": "Currency (three letters)",
    "partners.quote.run": "Get a test quote",
    "partners.quote.running": "Pricing…",
    "partners.quote.result": "Quoted",
    "partners.quote.synthetic": "Made-up number, sandbox only",
    "partners.quote.ref": "Quote reference",
    "partners.quote.suspended": "This account cannot quote right now. Please contact us.",
    "partners.status.title": "Account",
    "partners.status.name": "Name",
    "partners.status.sandbox": "Sandbox only",
    "partners.status.live": "Live",
    "partners.catalogue": "Products you can quote",
    "partners.catalogue.none": "Nothing published yet",
    "partners.catalogue.noneBody": "Your contact publishes the catalogue before you can request quotes.",
    "partners.usage.title": "Usage and settlement",
    "partners.usage.body": "Every quote, bind and refund your key has made, and what is owed on it.",
    "partners.usage.calls": "Transactions",
    "partners.usage.gross": "Gross written",
    "partners.usage.revshare": "Your share",
    "partners.usage.unsettled": "Not yet settled",
    "partners.usage.none": "No activity yet",
    "partners.usage.noneBody": "Your first quote through the API shows up here.",
    "partners.usage.kind": "Event",
    "partners.usage.amount": "Amount",
    "partners.usage.share": "Share",
    "partners.usage.batch": "Settlement",
    "partners.usage.pending": "Pending",
    "partners.usage.when": "When",
    "partners.stage.prospect": "Prospect",
    "partners.stage.onboarding": "Onboarding",
    "partners.stage.sandbox": "Sandbox",
    "partners.stage.live": "Live",
    "partners.stage.suspended": "Suspended",
    "partners.error.validation": "Check the highlighted fields and try again.",
    "partners.error.throttled": "We already created an account for that email today. Check your inbox.",
    "partners.error.tenant": "This sign-up link is not open right now.",
    "partners.error.key": "That key or partner ID was not accepted. Check both and try again.",
    "partners.error.generic": "Something went wrong. Please try again.",
    "partners.back": "Back to products"
  },
  ar: {
    "partners.title": "تكامل الشركاء",
    "partners.intro":
      "سجّل، واحصل على مفتاح تجريبي، ونفّذ أول طلب. لا شيء هنا يمس الأعمال الحقيقية — المفتاح تجريبي فقط حتى ننتقل بك إلى الإنتاج معًا.",
    "partners.signup": "إنشاء حساب تجريبي",
    "partners.company": "اسم الشركة",
    "partners.kind": "ما نوع نشاطك؟",
    "partners.kind.aggregator": "موقع مقارنة أو تجميع",
    "partners.kind.bank": "بنك",
    "partners.kind.broker": "وسيط",
    "partners.kind.retailer": "متجر تجزئة",
    "partners.kind.platform": "منصة برمجية",
    "partners.contactName": "اسمك (اختياري)",
    "partners.contactEmail": "بريد العمل الإلكتروني",
    "partners.legal.title": "الهوية القانونية (اختياري)",
    "partners.legal.note":
      "مطلوبة فقط قبل أن نتمكن من دفع العمولة. اتركها فارغة الآن وأضفها عند الانتقال إلى الإنتاج.",
    "partners.legalName": "الاسم القانوني المسجل",
    "partners.registrationNo": "رقم السجل التجاري",
    "partners.taxId": "الرقم الضريبي",
    "partners.country": "بلد التسجيل (رمز من حرفين)",
    "partners.submit": "إنشاء الحساب التجريبي",
    "partners.working": "جارٍ الإنشاء…",
    "partners.key.title": "مفتاحك التجريبي",
    "partners.key.warning": "انسخه الآن. يُعرض مرة واحدة ولا يمكننا عرضه مجددًا.",
    "partners.key.lost": "فقدته؟ سجّل ببريد آخر، أو اطلب من جهة الاتصال إصدار مفتاح جديد.",
    "partners.key.partnerId": "معرّف الشريك",
    "partners.key.stage": "المرحلة",
    "partners.key.next": "جرّبه — الصق المفتاح أدناه، أو نفّذ هذا من الطرفية:",
    "partners.console.title": "لوحة التجربة",
    "partners.console.body":
      "الصق مفتاحك التجريبي للتأكد من عمله ولرؤية نشاط حسابك. يُستخدم المفتاح لهذا الطلب فقط ولا يُحفظ.",
    "partners.console.key": "المفتاح التجريبي",
    "partners.console.id": "معرّف الشريك",
    "partners.console.run": "افحص حسابي",
    "partners.console.running": "جارٍ الفحص…",
    "partners.console.ok": "المفتاح يعمل. هذا ما ردّت به الواجهة.",
    "partners.quote.title": "أول تسعير لك",
    "partners.quote.body": "سعّر حالة تجريبية بمفتاحك. الرقم العائد غير حقيقي — طلب ناجح، لا سعر فعلي.",
    "partners.quote.line": "أي خط منتجات؟",
    "partners.quote.amount": "المبلغ، بأصغر وحدة للعملة",
    "partners.quote.currency": "العملة (ثلاثة أحرف)",
    "partners.quote.run": "احصل على تسعير تجريبي",
    "partners.quote.running": "جارٍ التسعير…",
    "partners.quote.result": "السعر",
    "partners.quote.synthetic": "رقم غير حقيقي، للتجربة فقط",
    "partners.quote.ref": "مرجع التسعير",
    "partners.quote.suspended": "لا يمكن لهذا الحساب التسعير حاليًا. تواصل معنا.",
    "partners.status.title": "الحساب",
    "partners.status.name": "الاسم",
    "partners.status.sandbox": "تجريبي فقط",
    "partners.status.live": "مباشر",
    "partners.catalogue": "المنتجات المتاحة للتسعير",
    "partners.catalogue.none": "لم يُنشر شيء بعد",
    "partners.catalogue.noneBody": "تنشر جهة الاتصال الكتالوج قبل أن تتمكن من طلب التسعير.",
    "partners.usage.title": "الاستخدام والتسوية",
    "partners.usage.body": "كل تسعير وإصدار واسترداد نفّذه مفتاحك، وما يستحق عليه.",
    "partners.usage.calls": "المعاملات",
    "partners.usage.gross": "إجمالي المكتتب",
    "partners.usage.revshare": "حصتك",
    "partners.usage.unsettled": "لم تُسوَّ بعد",
    "partners.usage.none": "لا نشاط بعد",
    "partners.usage.noneBody": "أول تسعير عبر الواجهة يظهر هنا.",
    "partners.usage.kind": "الحدث",
    "partners.usage.amount": "المبلغ",
    "partners.usage.share": "الحصة",
    "partners.usage.batch": "التسوية",
    "partners.usage.pending": "قيد الانتظار",
    "partners.usage.when": "التاريخ",
    "partners.stage.prospect": "مرشّح",
    "partners.stage.onboarding": "قيد التأهيل",
    "partners.stage.sandbox": "تجريبي",
    "partners.stage.live": "مباشر",
    "partners.stage.suspended": "موقوف",
    "partners.error.validation": "تحقق من الحقول المحددة وحاول مرة أخرى.",
    "partners.error.throttled": "أنشأنا حسابًا لهذا البريد اليوم. راجع بريدك.",
    "partners.error.tenant": "رابط التسجيل هذا غير متاح حاليًا.",
    "partners.error.key": "لم يُقبل المفتاح أو المعرّف. تحقق منهما وحاول مرة أخرى.",
    "partners.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "partners.back": "العودة إلى المنتجات"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

export interface PartnerTxn {
  id: string;
  kind: string;
  amountMinor: number;
  currency: string;
  revshareCalcMinor: number;
  settlementBatch: string | null;
  ts: number;
}

export interface Totals {
  calls: number;
  grossMinor: number;
  revshareMinor: number;
  unsettledMinor: number;
  currency: string | null;
}

/**
 * What the partner is owed and what is still outstanding. A refund is a
 * negative event in the ledger's eyes but arrives here as its own row, so it
 * subtracts rather than counting twice.
 *
 * ponytail: one currency. A partner trading in two would need the totals split
 * per currency — the rows carry it, so `currency` is null the moment they
 * disagree and the caller shows the table without a headline sum.
 */
export function usageTotals(rows: readonly PartnerTxn[]): Totals {
  const currencies = new Set(rows.map((row) => row.currency));
  const sign = (row: PartnerTxn) => (row.kind === "refund" ? -1 : 1);
  return {
    calls: rows.length,
    grossMinor: rows.reduce((sum, row) => sum + sign(row) * row.amountMinor, 0),
    revshareMinor: rows.reduce((sum, row) => sum + sign(row) * row.revshareCalcMinor, 0),
    unsettledMinor: rows
      .filter((row) => !row.settlementBatch)
      .reduce((sum, row) => sum + sign(row) * row.revshareCalcMinor, 0),
    currency: currencies.size === 1 ? [...currencies][0]! : null
  };
}

/** The first call, ready to paste. The key is the partner's own, so it goes in
 *  verbatim — a placeholder here is one more thing to get wrong. */
export function firstCall(origin: string, key: string): string {
  return `curl -H "Authorization: Bearer ${key}" \\\n  ${origin}/v1/dist/offerings`;
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
    apiOrigin: env.API_ORIGIN
  };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? `${loaded.tenant.name} — partners` : "" }
];

interface Partner {
  id: string;
  name: string;
  kind: string;
  stage: string;
  sandboxFlag: boolean;
}

interface SignupResponse extends Partner {
  sandboxKey: string;
}

/** Mirrors `dist_offerings` (packages/db/src/schema/dist.ts) as GET /v1/dist
 *  /offerings returns it. There is no flat `name` column and never was — the
 *  catalogue name is per-locale, and `apps/api/src/crud.ts` hydrate()s any
 *  `*Json` column into an object before it reaches the wire. */
interface Offering {
  id: string;
  nameJson: Record<string, string>;
}

/** Tenant locale, then the default, then whatever the pack actually has: a
 *  catalogue seeded en-only still names itself on the Arabic portal. */
function offeringName(offering: Offering, locale: string): string {
  const names = offering.nameJson ?? {};
  return names[locale] ?? names[DEFAULT_LOCALE] ?? Object.values(names)[0] ?? "";
}

/** What POST /v1/orbit/partners/:id/quotes answers with — see
 *  apps/api/src/engines/orbit-partner-quotes.ts. `synthetic` is the engine's own
 *  word for "this price is invented", and it is shown rather than hidden. */
export interface SandboxQuote {
  id: string;
  mode: string;
  synthetic: boolean;
  quotedPremiumMinor: number;
  currency: string;
}

type ActionData =
  | { ok: "signup"; partner: Partner; sandboxKey: string }
  | { ok: "status"; partner: Partner; txns: PartnerTxn[]; offerings: Offering[] }
  | { ok: "quote"; quote: SandboxQuote }
  | { ok: false; errorKey: string };

/**
 * The amount the quote API will accept, or null if the box does not hold one.
 * `<input type="number">` is a text box a determined visitor can put anything
 * in, and the API wants a positive integer of minor units — so the string is
 * rejected here rather than sent as a NaN the API answers with a 400.
 */
export function amountMinorFrom(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value > 0 ? value : null;
}

function signupError(status: number): string {
  if (status === 429) return "partners.error.throttled";
  if (status === 404) return "partners.error.tenant";
  if (status === 400) return "partners.error.validation";
  return "partners.error.generic";
}

/**
 * Which label an API failure earns. The bearer-key hops share one rule: 401,
 * 403 and 404 are all "that key or id was not accepted" — the API refuses a
 * missing row and another tenant's row identically, and so must this page, or
 * the copy would tell a stranger which ids exist.
 */
export function actionError(intent: string, status: number): string {
  // Anything that is not one of the two key-bearing intents took the signup
  // path, including a missing intent — same fallback as the action itself.
  if (intent !== "status" && intent !== "quote") return signupError(status);
  if (status === 401 || status === 403 || status === 404) return "partners.error.key";
  if (intent === "quote" && status === 409) return "partners.quote.suspended";
  if (intent === "quote" && status === 400) return "partners.error.validation";
  return "partners.error.generic";
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "status") {
      const key = String(form.get("key") ?? "").trim();
      const id = String(form.get("id") ?? "").trim();
      if (!key || !id) return { ok: false, errorKey: "partners.error.validation" } satisfies ActionData;
      // No `request`: the partner's key authenticates this hop, and forwarding
      // a visitor cookie into a bearer call would be two identities on one call.
      const opts = { env, headers: { authorization: `Bearer ${key}` } };
      const [partner, txns, offerings] = await Promise.all([
        api<Partner>(`/v1/orbit/partners/${id}`, opts),
        api<{ data: PartnerTxn[] }>(`/v1/orbit/partner-txns?partnerId=${id}&sort=ts&order=desc&limit=50`, opts),
        api<{ data: Offering[] }>("/v1/dist/offerings?limit=10", opts)
      ]);
      return { ok: "status", partner, txns: txns.data, offerings: offerings.data } satisfies ActionData;
    }

    if (intent === "quote") {
      const key = String(form.get("key") ?? "").trim();
      const id = String(form.get("id") ?? "").trim();
      const productLine = String(form.get("productLine") ?? "").trim();
      const amountMinor = amountMinorFrom(String(form.get("amountMinor") ?? ""));
      const currency = String(form.get("currency") ?? "")
        .trim()
        .toUpperCase();
      if (!key || !id || !productLine || amountMinor === null || currency.length !== 3) {
        return { ok: false, errorKey: "partners.error.validation" } satisfies ActionData;
      }
      // ponytail: no idempotency key. The call logs a sandbox quote and moves no
      // money, so a double-tap costing one extra log row is cheaper than minting
      // and threading a key through a public form. Add one if this ever prices
      // live business.
      const quote = await api<SandboxQuote>(`/v1/orbit/partners/${id}/quotes`, {
        env,
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: { productLine, amountMinor, currency }
      });
      return { ok: "quote", quote } satisfies ActionData;
    }

    // An optional field left blank must not travel as "": the API's schema
    // takes `.min(1)` on every one of these, so an empty box would be a 400
    // rather than an omission.
    const optional = (name: string) => {
      const value = String(form.get(name) ?? "").trim();
      return value ? { [name]: value } : {};
    };
    const created = await api<SignupResponse>("/v1/onboarding/partners/signup", {
      env,
      method: "POST",
      body: {
        tenantSlug,
        companyName: String(form.get("companyName") ?? "").trim(),
        contactEmail: String(form.get("contactEmail") ?? "").trim(),
        ...optional("contactName"),
        ...optional("legalName"),
        ...optional("registrationNo"),
        ...optional("taxId"),
        ...optional("country"),
        kind: String(form.get("kind") ?? "")
      }
    });
    const { sandboxKey, ...partner } = created;
    return { ok: "signup", partner, sandboxKey } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { ok: false, errorKey: actionError(intent, error.status) } satisfies ActionData;
  }
}

export default function PortalPartners() {
  const { locale, tenantSlug, tenant, apiOrigin } = useLoaderData<typeof loader>();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const l = labeller(locale);
  const busy = navigation.state !== "idle";
  const submitting = navigation.formData?.get("intent");

  const signed = result && result.ok === "signup" ? result : null;
  const status = result && result.ok === "status" ? result : null;
  const quoted = result && result.ok === "quote" ? result : null;
  const totals = status ? usageTotals(status.txns) : null;
  const stage = (value: string) => l(`partners.stage.${value}`);
  const money = (minor: number, currency: string | null) =>
    currency ? <Money amountMinor={minor} currency={currency} locale={locale} /> : "—";

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="lyra-enter mx-auto max-w-3xl p-6">
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
              <h1 className="page-title">{l("partners.title")}</h1>
              <p className="font-ui text-13 text-muted">{l("partners.intro")}</p>
              <a className="w-fit font-ui text-13 text-accent underline" href={`/portal/${tenantSlug}`}>
                {l("partners.back")}
              </a>
            </div>
          </div>
        </header>

        {result && result.ok === false ? (
          <p role="alert" className="mb-6 text-13 text-danger">
            {l(result.errorKey)}
          </p>
        ) : null}

        {signed ? (
          <Card title={l("partners.key.title")} className="mb-8">
            <p role="alert" className="text-14 font-medium text-warning">
              {l("partners.key.warning")}
            </p>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-13">{signed.sandboxKey}</pre>
            <p className="mt-2 text-12 text-muted">{l("partners.key.lost")}</p>
            <dl className="mt-4 grid grid-cols-2 gap-3 text-13">
              <div>
                <dt className="text-muted">{l("partners.key.partnerId")}</dt>
                <dd className="font-mono">{signed.partner.id}</dd>
              </div>
              <div>
                <dt className="text-muted">{l("partners.key.stage")}</dt>
                <dd>{stage(signed.partner.stage)}</dd>
              </div>
            </dl>
            <p className="mt-4 text-13">{l("partners.key.next")}</p>
            <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12">
              {firstCall(apiOrigin, signed.sandboxKey)}
            </pre>
          </Card>
        ) : null}

        {signed ? null : (
          <Card title={l("partners.signup")} className="mb-8">
            <Form method="post" className="flex flex-col gap-5">
              <input type="hidden" name="intent" value="signup" />
              <Field label={l("partners.company")} id="partners-company" required>
                <Input name="companyName" required minLength={2} maxLength={200} autoComplete="organization" />
              </Field>
              <Field label={l("partners.kind")} id="partners-kind" required>
                <Select
                  name="kind"
                  defaultValue="aggregator"
                  options={KINDS.map((kind) => ({ value: kind, label: l(`partners.kind.${kind}`) }))}
                />
              </Field>
              <Field label={l("partners.contactName")} id="partners-contact-name">
                <Input name="contactName" autoComplete="name" maxLength={200} />
              </Field>
              <Field label={l("partners.contactEmail")} id="partners-contact-email" required>
                <Input name="contactEmail" type="email" required autoComplete="email" />
              </Field>
              {/* A fieldset, so a screen reader announces "Legal identity"
                  before each of the four and the note is read once rather than
                  never. Every box here is optional and the API keeps only what
                  is offered — commission cannot be paid to a trading name, but
                  it is not owed on the day a sandbox key is issued either. */}
              <fieldset className="flex flex-col gap-5 border-0 p-0">
                <legend className="font-ui text-14 font-medium text-text">{l("partners.legal.title")}</legend>
                <p className="font-ui text-13 text-muted">{l("partners.legal.note")}</p>
                <Field label={l("partners.legalName")} id="partners-legal-name">
                  <Input name="legalName" maxLength={200} autoComplete="organization" />
                </Field>
                <Field label={l("partners.registrationNo")} id="partners-registration-no">
                  <Input name="registrationNo" maxLength={80} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label={l("partners.taxId")} id="partners-tax-id">
                  <Input name="taxId" maxLength={80} autoComplete="off" spellCheck={false} />
                </Field>
                <Field label={l("partners.country")} id="partners-country">
                  {/* ISO 3166-1 alpha-2, upper-cased server-side. The pattern
                      keeps "United Arab Emirates" out of a two-character column
                      before the round trip rather than after it. */}
                  <Input
                    name="country"
                    maxLength={2}
                    pattern="[A-Za-z]{2}"
                    autoComplete="country"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="w-24"
                  />
                </Field>
              </fieldset>
              <Button type="submit" variant="primary" loading={busy && submitting === "signup"}>
                {busy && submitting === "signup" ? l("partners.working") : l("partners.submit")}
              </Button>
            </Form>
          </Card>
        )}

        <Card title={l("partners.console.title")} description={l("partners.console.body")} className="mb-8">
          <Form method="post" className="flex flex-col gap-5">
            <input type="hidden" name="intent" value="status" />
            <Field label={l("partners.console.key")} id="partners-key" required>
              <Input name="key" type="password" required autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={l("partners.console.id")} id="partners-id" required>
              <Input
                name="id"
                required
                autoComplete="off"
                spellCheck={false}
                defaultValue={signed?.partner.id ?? status?.partner.id ?? ""}
              />
            </Field>
            <Button type="submit" loading={busy && submitting === "status"}>
              {busy && submitting === "status" ? l("partners.console.running") : l("partners.console.run")}
            </Button>
          </Form>
        </Card>

        <Card title={l("partners.quote.title")} description={l("partners.quote.body")} className="mb-8">
          <Form method="post" className="flex flex-col gap-5">
            <input type="hidden" name="intent" value="quote" />
            <Field label={l("partners.console.key")} id="partners-quote-key" required>
              <Input name="key" type="password" required autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={l("partners.console.id")} id="partners-quote-id" required>
              <Input
                name="id"
                required
                autoComplete="off"
                spellCheck={false}
                defaultValue={signed?.partner.id ?? status?.partner.id ?? ""}
              />
            </Field>
            <Field label={l("partners.quote.line")} id="partners-quote-line" required>
              <Input
                name="productLine"
                required
                maxLength={120}
                autoComplete="off"
                defaultValue={status?.offerings[0] ? offeringName(status.offerings[0], locale) : ""}
              />
            </Field>
            <Field label={l("partners.quote.amount")} id="partners-quote-amount" required>
              <Input name="amountMinor" type="number" required min={1} step={1} inputMode="numeric" />
            </Field>
            <Field label={l("partners.quote.currency")} id="partners-quote-currency" required>
              <Input
                name="currency"
                required
                minLength={3}
                maxLength={3}
                autoComplete="off"
                spellCheck={false}
                className="uppercase"
              />
            </Field>
            <Button type="submit" loading={busy && submitting === "quote"}>
              {busy && submitting === "quote" ? l("partners.quote.running") : l("partners.quote.run")}
            </Button>
          </Form>

          {quoted ? (
            <dl className="mt-6 grid grid-cols-2 gap-3 border-t border-border pt-4 text-13">
              <div>
                <dt className="text-muted">{l("partners.quote.result")}</dt>
                <dd role="status" className="flex flex-wrap items-center gap-2">
                  <Money
                    amountMinor={quoted.quote.quotedPremiumMinor}
                    currency={quoted.quote.currency}
                    locale={locale}
                  />
                  {quoted.quote.synthetic ? <Badge tone="warning">{l("partners.quote.synthetic")}</Badge> : null}
                </dd>
              </div>
              <div>
                <dt className="text-muted">{l("partners.quote.ref")}</dt>
                <dd className="font-mono">{quoted.quote.id}</dd>
              </div>
            </dl>
          ) : null}
        </Card>

        {status && totals ? (
          <>
            <Card title={l("partners.status.title")} className="mb-8">
              <p role="status" className="text-13 text-muted">
                {l("partners.console.ok")}
              </p>
              <dl className="mt-4 grid grid-cols-2 gap-3 text-13">
                <div>
                  <dt className="text-muted">{l("partners.status.name")}</dt>
                  <dd>{status.partner.name}</dd>
                </div>
                <div>
                  <dt className="text-muted">{l("partners.key.stage")}</dt>
                  <dd className="flex items-center gap-2">
                    {stage(status.partner.stage)}
                    <Badge tone={status.partner.sandboxFlag ? "warning" : "success"}>
                      {status.partner.sandboxFlag ? l("partners.status.sandbox") : l("partners.status.live")}
                    </Badge>
                  </dd>
                </div>
              </dl>

              <h3 className="mt-6 font-ui text-13 font-medium text-muted">{l("partners.catalogue")}</h3>
              {status.offerings.length === 0 ? (
                <p className="mt-2 text-13 text-muted">{l("partners.catalogue.noneBody")}</p>
              ) : (
                <ul className="mt-2 flex flex-wrap gap-2">
                  {status.offerings.map((offering) => (
                    <li key={offering.id}>
                      <Badge tone="neutral">{offeringName(offering, locale)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card title={l("partners.usage.title")} description={l("partners.usage.body")}>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label={l("partners.usage.calls")} value={totals.calls} />
                <Stat label={l("partners.usage.gross")} value={money(totals.grossMinor, totals.currency)} />
                <Stat label={l("partners.usage.revshare")} value={money(totals.revshareMinor, totals.currency)} />
                <Stat label={l("partners.usage.unsettled")} value={money(totals.unsettledMinor, totals.currency)} />
              </div>
              <div className="mt-5">
                <Table
                  caption={l("partners.usage.title")}
                  density="compact"
                  rows={status.txns}
                  rowKey={(row) => row.id}
                  empty={<EmptyState title={l("partners.usage.none")} body={l("partners.usage.noneBody")} />}
                  columns={[
                    { key: "kind", header: l("partners.usage.kind"), render: (row) => row.kind },
                    {
                      key: "amount",
                      header: l("partners.usage.amount"),
                      numeric: true,
                      render: (row) => <Money amountMinor={row.amountMinor} currency={row.currency} locale={locale} />
                    },
                    {
                      key: "share",
                      header: l("partners.usage.share"),
                      numeric: true,
                      render: (row) => (
                        <Money amountMinor={row.revshareCalcMinor} currency={row.currency} locale={locale} />
                      )
                    },
                    {
                      key: "batch",
                      header: l("partners.usage.batch"),
                      render: (row) =>
                        row.settlementBatch ?? <span className="text-muted">{l("partners.usage.pending")}</span>
                    },
                    {
                      key: "when",
                      header: l("partners.usage.when"),
                      render: (row) =>
                        formatInstant(row.ts, new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format)
                    }
                  ]}
                />
              </div>
            </Card>
          </>
        ) : null}

        <p className="mt-8 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("partners.back")}
          </a>
        </p>
      </div>
    </main>
  );
}

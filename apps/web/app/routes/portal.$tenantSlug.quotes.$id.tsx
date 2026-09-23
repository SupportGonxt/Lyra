import { useEffect, useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Badge, Button, Card, Checkbox, Field, Money, Slider, formatInstant } from "@lyra/ui";
import { cloudflare } from "../context";
import type { ReactNode } from "react";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";
import { vocabulary } from "../modules/vocabulary";

// J-C1 "Get covered", customer half (docs/06). The visitor has no session — the
// one-time token in the URL is the whole credential — so this page never shows
// anything the API would not hand a stranger holding that link: no commission,
// no provider scoring, no decline reasons. What it does show is the ranking
// criterion, because a comparison that hides how it sorted is the thing the
// journey is written against.
//
// There is no payment step. No PSP connector exists (apps/api engines/settlement
// §7) and binding cover is `consequential: true` (CLAUDE.md §4), so the last
// thing the customer does here is send documents; a human approves issuance.
// ADR-0043.
//
// The sliders re-price through POST .../reprice, which runs the same panel the
// stored comparison ran and writes nothing (docs/19 §2 — an indicative price is
// not a transaction). No arithmetic happens in this file: the browser moves a
// number, the underwriters price it.

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "quote.title": "Your quotes",
    "quote.intro": "Prices are held for you. Keep this link — it is the only way back to this comparison.",
    "quote.rankedBy": "{n} offer(s), ranked by total price, cheapest first.",
    "quote.total": "Total payable",
    "quote.premium": "Premium",
    "quote.tax": "Tax",
    "quote.fees": "Fees",
    "quote.cheapest": "Cheapest",
    "quote.excess": "Excess",
    "quote.agencyRepair": "Agency repair",
    "quote.roadside": "Roadside assistance",
    "quote.included": "Included",
    "quote.notIncluded": "Not included",
    "quote.validUntil": "Held until",
    "quote.choose": "Choose this cover",
    "quote.choosing": "Saving…",
    "quote.chosen": "Chosen",
    "quote.referred": "{n} more underwriter(s) are quoting by hand. We will email you when they answer.",
    "quote.empty": "No underwriter could price this online. We will call you.",
    "quote.expired": "These prices have expired. Please start a new quote.",
    "quote.accepted.title": "Next: send your documents",
    "quote.accepted.body":
      "Nothing is bound yet. Upload your ID and licence and one of our people will check the cover and confirm it with you.",
    "quote.upload": "Document (JPEG, PNG, HEIC or PDF, up to 10MB)",
    "quote.upload.submit": "Upload document",
    "quote.upload.working": "Uploading…",
    "quote.upload.done": "Received. Upload another if you have one.",
    "quote.upload.error.type": "That file type is not accepted.",
    "quote.error.generic": "Something went wrong. Please try again.",
    "quote.back": "Back to products",
    "quote.criteria.title": "Change your details, see every price move",
    "quote.criteria.note":
      "Move a detail and the same underwriters price it again. Prices shown that way are indicative: nothing is held at them and nothing is bound.",
    "quote.criteria.none": "This cover is priced on details we cannot ask for on this page.",
    "quote.exact": "{label}, exact value",
    "quote.reprice.working": "Pricing…",
    "quote.reprice.error": "We could not price that. Your held prices below are unchanged.",
    "quote.indicative": "Indicative — not an offer, not held for you.",
    "quote.reset": "Back to your held prices",
    "quote.compare.caption": "Products side by side, one row per detail",
    "quote.product": "Product",
    "quote.provider": "Insurer",
    "quote.chooseColumn": "Your choice",
    "criterion.age": "Driver age",
    "criterion.sumInsuredMinor": "Value to insure",
    "criterion.priorClaims": "I have claimed in the last 3 years",
    "criterion.tripDays": "Trip length (days)",
    "criterion.winterSports": "Include winter sports"
  },
  ar: {
    "quote.title": "عروض الأسعار الخاصة بك",
    "quote.intro": "الأسعار محجوزة لك. احتفظ بهذا الرابط — فهو الطريقة الوحيدة للعودة إلى هذه المقارنة.",
    "quote.rankedBy": "{n} عرض(عروض)، مرتبة حسب السعر الإجمالي، الأرخص أولًا.",
    "quote.total": "الإجمالي المستحق",
    "quote.premium": "القسط",
    "quote.tax": "الضريبة",
    "quote.fees": "الرسوم",
    "quote.cheapest": "الأرخص",
    "quote.excess": "التحمل",
    "quote.agencyRepair": "إصلاح الوكالة",
    "quote.roadside": "المساعدة على الطريق",
    "quote.included": "مشمول",
    "quote.notIncluded": "غير مشمول",
    "quote.validUntil": "محجوز حتى",
    "quote.choose": "اختر هذه التغطية",
    "quote.choosing": "جارٍ الحفظ…",
    "quote.chosen": "تم الاختيار",
    "quote.referred": "هناك {n} شركة تأمين تسعّر يدويًا. سنراسلك عند ورود ردها.",
    "quote.empty": "لم تتمكن أي شركة من التسعير عبر الإنترنت. سنتصل بك.",
    "quote.expired": "انتهت صلاحية هذه الأسعار. يرجى بدء طلب جديد.",
    "quote.accepted.title": "الخطوة التالية: أرسل مستنداتك",
    "quote.accepted.body":
      "لم يتم إصدار الوثيقة بعد. حمّل هويتك ورخصتك وسيتحقق أحد موظفينا من التغطية ويؤكدها معك.",
    "quote.upload": "مستند (JPEG أو PNG أو HEIC أو PDF، حتى ١٠ ميغابايت)",
    "quote.upload.submit": "رفع المستند",
    "quote.upload.working": "جارٍ الرفع…",
    "quote.upload.done": "تم الاستلام. ارفع مستندًا آخر إن وجد.",
    "quote.upload.error.type": "نوع الملف غير مقبول.",
    "quote.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "quote.back": "العودة إلى المنتجات",
    "quote.criteria.title": "غيّر بياناتك وشاهد كل سعر يتحرك",
    "quote.criteria.note":
      "حرّك أي تفصيل وتعيد شركات التأمين نفسها التسعير. الأسعار الظاهرة بهذه الطريقة استرشادية: لا تُحجز ولا تُلزم أحدًا.",
    "quote.criteria.none": "تُسعّر هذه التغطية على تفاصيل لا يمكننا سؤالك عنها في هذه الصفحة.",
    "quote.exact": "{label}، القيمة الدقيقة",
    "quote.reprice.working": "جارٍ التسعير…",
    "quote.reprice.error": "تعذّر التسعير. أسعارك المحجوزة أدناه لم تتغير.",
    "quote.indicative": "استرشادي — ليس عرضًا وغير محجوز لك.",
    "quote.reset": "العودة إلى أسعارك المحجوزة",
    "quote.compare.caption": "المنتجات جنبًا إلى جنب، صف لكل تفصيل",
    "quote.product": "المنتج",
    "quote.provider": "شركة التأمين",
    "quote.chooseColumn": "اختيارك",
    "criterion.age": "عمر السائق",
    "criterion.sumInsuredMinor": "القيمة المراد تأمينها",
    "criterion.priorClaims": "قدمت مطالبة خلال آخر ٣ سنوات",
    "criterion.tripDays": "مدة الرحلة (أيام)",
    "criterion.winterSports": "تضمين الرياضات الشتوية"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

/**
 * The ranking line under the hero title. Real count off the comparison the
 * loader just fetched, not shown at all once there is nothing to rank — the
 * empty state below already says why.
 */
export function quoteRankingLede(l: (key: string) => string, offerCount: number): string | null {
  return offerCount > 0 ? l("quote.rankedBy").replace("{n}", String(offerCount)) : null;
}

interface Offer {
  offeringId: string;
  name: string;
  providerName: string | null;
  premiumMinor: number;
  taxMinor: number;
  feesMinor: number;
  totalMinor: number;
  currency: string;
  coverage: Record<string, unknown> | null;
  rank: number | null;
  validUntil: number | null;
}

/**
 * One movable rating input. Mirrors `Criterion` in apps/api/src/engines/rating.ts,
 * shipped on the comparison by apps/api/src/routes/portal.ts §criteriaOf — the
 * panel derives these from its own rate tables, so this page never decides what
 * is adjustable.
 */
interface Criterion {
  field: string;
  kind: "number" | "money" | "boolean";
  min: number;
  max: number;
  step: number;
}

/** Mirrors the body of `GET /v1/portal/{tenantSlug}/quote-requests/{id}` —
 *  apps/api/src/routes/portal.ts §comparison. */
interface Comparison {
  state: string;
  currency: string;
  rankedBy: "total_price";
  acceptedOfferingId: string | null;
  referredCount: number;
  criteria: Criterion[];
  inputs: Record<string, unknown>;
  offers: Offer[];
}

/** Mirrors the body of `POST /v1/portal/{tenantSlug}/quote-requests/{id}/reprice` —
 *  apps/api/src/routes/portal.ts. `indicative` is the server saying it in the
 *  payload, not this page saying it in copy. */
interface Reprice {
  indicative: true;
  currency: string;
  rankedBy: "total_price";
  referredCount: number;
  criteria: Criterion[];
  inputs: Record<string, number | boolean>;
  offers: Offer[];
}

/** Mirrors `tenant` on `GET /v1/portal/{tenantSlug}/site` — same file, §site. */
interface SiteTenant {
  name: string;
  brand: Brand;
  domainPack?: string;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const [site, comparison] = await Promise.all([
    api<{ tenant: SiteTenant }>(`/v1/portal/${tenantSlug}/site`, { env, request }),
    api<Comparison>(
      `/v1/portal/${tenantSlug}/quote-requests/${params.id}?token=${encodeURIComponent(token)}`,
      { env, request }
    )
  ]).catch(asRouteError);
  return { locale: localeFrom(request), tenantSlug, tenant: site.tenant, comparison };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? `${loaded.tenant.name} — quotes` : "" }
];

type ActionData =
  | { intent: "accept" | "document"; ok: boolean; errorKey?: string }
  | { intent: "reprice"; ok: boolean; errorKey?: string; result?: Reprice };

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const raw = form.get("intent");
  const intent = raw === "document" || raw === "reprice" ? raw : "accept";

  try {
    if (intent === "reprice") {
      // The values are the visitor's own knobs, JSON-encoded so booleans survive
      // a form post. The server drops anything it does not rate on and clamps
      // every number, so this is a pass-through and not a validation site.
      const inputs = JSON.parse(String(form.get("inputs") ?? "{}")) as Record<string, number | boolean>;
      const result = await api<Reprice>(`/v1/portal/${tenantSlug}/quote-requests/${params.id}/reprice`, {
        env,
        method: "POST",
        body: { token, inputs }
      });
      return { intent, ok: true, result } satisfies ActionData;
    }
    if (intent === "accept") {
      await api(`/v1/portal/${tenantSlug}/quote-requests/${params.id}/accept`, {
        env,
        method: "POST",
        body: { token, offeringId: String(form.get("offeringId") ?? "") }
      });
    } else {
      // Multipart, so it cannot go through `api()` (JSON only). The file is
      // streamed straight back out rather than buffered into a JSON envelope.
      const upload = new FormData();
      upload.append("token", token);
      upload.append("file", form.get("file") as Blob);
      const response = await fetch(
        new URL(`/v1/portal/${tenantSlug}/quote-requests/${params.id}/documents`, env.API_ORIGIN),
        { method: "POST", body: upload }
      );
      if (!response.ok) throw await ApiError.from(response, "documents");
    }
    return { intent, ok: true } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) {
      // A malformed knob payload is this page's own bug, not the visitor's; the
      // held prices below stay on screen either way.
      if (intent === "reprice" && error instanceof SyntaxError) {
        return { intent, ok: false, errorKey: "quote.reprice.error" } satisfies ActionData;
      }
      throw error;
    }
    const errorKey =
      intent === "reprice"
        ? "quote.reprice.error"
        : error.status === 409
          ? "quote.expired"
          : error.status === 400 && intent === "document"
            ? "quote.upload.error.type"
            : "quote.error.generic";
    return { intent, ok: false, errorKey } satisfies ActionData;
  }
}

/** An em dash is the same mark in both locales, so it is a constant and not a
 *  copy key — an i18n table whose Arabic row is a copy of its English one is a
 *  translation nobody did. */
const NONE = "—";

/** Minor units are an accounting detail; nobody drags a slider in fils. */
const MINOR = 100;

/**
 * The criterion values the visitor starts from, in the server's own units. Only
 * criteria appear — `inputs` is already filtered server-side, and a value the
 * comparison did not carry falls back to the middle of the declared range so the
 * knob has somewhere to be.
 */
export function initialValues(criteria: Criterion[], inputs: Record<string, unknown>): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const c of criteria) {
    const value = inputs[c.field];
    if (c.kind === "boolean") out[c.field] = value === true;
    else if (typeof value === "number" && Number.isFinite(value)) out[c.field] = value;
    else out[c.field] = Math.round((c.min + c.max) / 2);
  }
  return out;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-3 pe-4 text-start text-13 font-normal text-muted">
        {label}
      </th>
      {children}
    </tr>
  );
}

/** A coverage row is drawn only when at least one product answers it — an
 *  all-empty row is a row that teaches nothing. */
function hasCoverage(offers: Offer[], key: string): boolean {
  return offers.some((o) => o.coverage && o.coverage[key] !== undefined);
}

export default function PortalQuotes() {
  const { locale, tenantSlug, tenant, comparison } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const reprice = useFetcher<ActionData>();
  const l = labeller(locale);
  // Domain-pack nouns before this file's own copy (CLAUDE.md §14): a tenant
  // whose pack calls the counterparty a supplier must not read "insurer" here.
  const pack = vocabulary(tenant.domainPack, locale);
  const noun = (packKey: string, labelKey: string) => pack(packKey) ?? l(labelKey);
  const token = searchParams.get("token") ?? "";
  const busy = navigation.state !== "idle";
  const accepted = comparison.acceptedOfferingId;

  const [values, setValues] = useState(() => initialValues(comparison.criteria, comparison.inputs));
  const held = useMemo(() => JSON.stringify(initialValues(comparison.criteria, comparison.inputs)), [comparison]);
  const submit = reprice.submit;
  const moved = JSON.stringify(values) !== held;

  // Debounced: a drag fires an event per pixel, and each one is a full panel
  // run on the server. The knob stays live the whole time — only the request
  // waits. Every timer is cleared on change, so the last position is the one
  // that gets priced.
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => {
      submit({ intent: "reprice", token, inputs: JSON.stringify(values) }, { method: "post" });
    }, 400);
    return () => clearTimeout(timer);
  }, [values, moved, token, submit]);

  const priced = reprice.data?.intent === "reprice" && reprice.data.ok ? reprice.data.result : undefined;
  const repriceError = reprice.data?.intent === "reprice" && !reprice.data.ok ? reprice.data.errorKey : undefined;
  // Indicative only while the knobs are actually away from the held risk:
  // dragging back to where you started is back to the real comparison.
  const indicative = moved && Boolean(priced);
  const offers = indicative && priced ? priced.offers : comparison.offers;
  const referredCount = indicative && priced ? priced.referredCount : comparison.referredCount;
  const rankingLede = quoteRankingLede(l, offers.length);
  const pricing = reprice.state !== "idle";

  const money = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency: comparison.currency,
        maximumFractionDigits: 0
      }),
    [locale, comparison.currency]
  );
  const count = useMemo(() => new Intl.NumberFormat(locale), [locale]);

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-4xl p-6">
        <header className="lyra-enter mb-8 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h1 className="page-title">{l("quote.title")}</h1>
            <p className="font-ui text-13 text-muted">{l("quote.intro")}</p>
            {/* Declared criteria, visible — J-C1's own wording. */}
            {rankingLede ? <p className="font-ui text-13 text-muted">{rankingLede}</p> : null}
            <a className="w-fit font-ui text-13 text-accent underline" href={`/portal/${tenantSlug}`}>
              {l("quote.back")}
            </a>
          </div>
        </header>

        {result?.errorKey ? (
          <p role="alert" className="mb-4 text-13 text-danger">
            {l(result.errorKey)}
          </p>
        ) : null}

        {/* The knobs. Drawn only when the panel actually rates on something a
            person can move — an empty set says so rather than showing a strip
            of controls that change nothing. */}
        <Card className="mb-6" title={l("quote.criteria.title")}>
          <p className="text-13 text-muted">{l("quote.criteria.note")}</p>
          {comparison.criteria.length === 0 ? (
            <p className="mt-4 text-13 text-muted">{l("quote.criteria.none")}</p>
          ) : (
            <div className="mt-4 flex flex-col gap-4">
              {comparison.criteria.map((criterion) => {
                const label = l(`criterion.${criterion.field}`);
                const value = values[criterion.field];
                if (criterion.kind === "boolean") {
                  return (
                    <Checkbox
                      key={criterion.field}
                      label={label}
                      checked={value === true}
                      onCheckedChange={(next) =>
                        setValues((prev) => ({ ...prev, [criterion.field]: next === true }))
                      }
                    />
                  );
                }
                // Money is rated in minor units and lived in major ones. The
                // conversion is presentational and one-way-symmetric: what goes
                // back to the panel is minor units again.
                const scale = criterion.kind === "money" ? MINOR : 1;
                const shown = Math.round((typeof value === "number" ? value : criterion.min) / scale);
                return (
                  <Field key={criterion.field} label={label} id={`criterion-${criterion.field}`}>
                    <Slider
                      min={Math.round(criterion.min / scale)}
                      max={Math.round(criterion.max / scale)}
                      step={Math.max(1, Math.round(criterion.step / scale))}
                      value={shown}
                      numberLabel={l("quote.exact").replace("{label}", label)}
                      valueText={criterion.kind === "money" ? money.format(shown) : count.format(shown)}
                      onValueChange={(next) =>
                        setValues((prev) => ({ ...prev, [criterion.field]: next * scale }))
                      }
                    />
                  </Field>
                );
              })}
            </div>
          )}
          <p role="status" className="mt-4 text-13 text-muted">
            {pricing ? l("quote.reprice.working") : indicative ? l("quote.indicative") : null}
          </p>
          {repriceError ? (
            <p role="alert" className="mt-1 text-13 text-danger">
              {l(repriceError)}
            </p>
          ) : null}
          {moved ? (
            <Button
              type="button"
              variant="secondary"
              className="mt-3"
              onClick={() => setValues(JSON.parse(held) as Record<string, number | boolean>)}
            >
              {l("quote.reset")}
            </Button>
          ) : null}
        </Card>

        {offers.length === 0 ? (
          <p className="text-14 text-muted">{l("quote.empty")}</p>
        ) : (
          // Row-wise: one row per criterion so the same fact is on the same line
          // across every product. Wide on a desktop, scrolled sideways on a
          // phone — the row labels are what stay readable either way.
          <div className="overflow-x-auto" aria-busy={pricing}>
            <table className="w-full min-w-[540px] border-collapse text-14">
              <caption className="sr-only">{l("quote.compare.caption")}</caption>
              <thead>
                <tr>
                  <th scope="row" className="py-3 pe-4 text-start text-13 font-normal text-muted">
                    {l("quote.product")}
                  </th>
                  {offers.map((offer) => (
                    <th key={offer.offeringId} scope="col" className="min-w-[160px] py-3 pe-4 text-start">
                      <span className="font-ui text-14 font-medium text-text">{offer.name}</span>
                      {offer.rank === 1 ? (
                        <span className="ms-2 align-middle">
                          <Badge tone="accent">{l("quote.cheapest")}</Badge>
                        </span>
                      ) : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <Row label={noun("insurer", "quote.provider")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4 text-13 text-muted">
                      {offer.providerName ?? NONE}
                    </td>
                  ))}
                </Row>
                <Row label={l("quote.total")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4">
                      <span className="page-title">
                        <Money amountMinor={offer.totalMinor} currency={offer.currency} locale={locale} />
                      </span>
                    </td>
                  ))}
                </Row>
                <Row label={noun("premiumMinor", "quote.premium")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4 text-13">
                      <Money amountMinor={offer.premiumMinor} currency={offer.currency} locale={locale} />
                    </td>
                  ))}
                </Row>
                <Row label={l("quote.tax")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4 text-13">
                      <Money amountMinor={offer.taxMinor} currency={offer.currency} locale={locale} />
                    </td>
                  ))}
                </Row>
                <Row label={l("quote.fees")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4 text-13">
                      <Money amountMinor={offer.feesMinor} currency={offer.currency} locale={locale} />
                    </td>
                  ))}
                </Row>
                {hasCoverage(offers, "excessMinor") ? (
                  <Row label={l("quote.excess")}>
                    {offers.map((offer) => (
                      <td key={offer.offeringId} className="py-3 pe-4 text-13">
                        {typeof offer.coverage?.excessMinor === "number" ? (
                          <Money
                            amountMinor={offer.coverage.excessMinor as number}
                            currency={offer.currency}
                            locale={locale}
                          />
                        ) : (
                          NONE
                        )}
                      </td>
                    ))}
                  </Row>
                ) : null}
                {(["agencyRepair", "roadside"] as const).map((key) =>
                  hasCoverage(offers, key) ? (
                    <Row key={key} label={l(`quote.${key}`)}>
                      {offers.map((offer) => (
                        <td key={offer.offeringId} className="py-3 pe-4 text-13">
                          {typeof offer.coverage?.[key] === "boolean"
                            ? offer.coverage[key]
                              ? l("quote.included")
                              : l("quote.notIncluded")
                            : NONE}
                        </td>
                      ))}
                    </Row>
                  ) : null
                )}
                <Row label={l("quote.validUntil")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4 text-13 text-muted">
                      {/* An indicative price is held for nobody, and saying
                          otherwise is the one lie this page must not tell. */}
                      {indicative
                        ? l("quote.indicative")
                        : offer.validUntil
                          ? formatInstant(
                              offer.validUntil,
                              new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format
                            )
                          : NONE}
                    </td>
                  ))}
                </Row>
                <Row label={l("quote.chooseColumn")}>
                  {offers.map((offer) => (
                    <td key={offer.offeringId} className="py-3 pe-4">
                      {/* Nothing is choosable while the knobs are away from the
                          held risk: accepting would bind the stored price, not
                          the one on screen. */}
                      {indicative ? (
                        <span className="text-13 text-muted">{l("quote.indicative")}</span>
                      ) : accepted === offer.offeringId ? (
                        <span className="text-13 text-success">{l("quote.chosen")}</span>
                      ) : (
                        <Form method="post">
                          <input type="hidden" name="intent" value="accept" />
                          <input type="hidden" name="token" value={token} />
                          <input type="hidden" name="offeringId" value={offer.offeringId} />
                          <Button type="submit" variant={accepted ? "secondary" : "primary"} loading={busy}>
                            {busy ? l("quote.choosing") : l("quote.choose")}
                          </Button>
                        </Form>
                      )}
                    </td>
                  ))}
                </Row>
              </tbody>
            </table>
          </div>
        )}

        {referredCount > 0 ? (
          <p className="mt-4 text-13 text-muted">{l("quote.referred").replace("{n}", String(referredCount))}</p>
        ) : null}

        {accepted ? (
          <Card className="mt-8" title={l("quote.accepted.title")}>
            <p className="text-14">{l("quote.accepted.body")}</p>
            {result?.intent === "document" && result.ok ? (
              <p role="status" className="mt-3 text-13 text-success">
                {l("quote.upload.done")}
              </p>
            ) : null}
            <Form method="post" encType="multipart/form-data" className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="intent" value="document" />
              <input type="hidden" name="token" value={token} />
              <Field label={l("quote.upload")} id="quote-file">
                <input
                  id="quote-file"
                  type="file"
                  name="file"
                  required
                  accept="image/jpeg,image/png,image/heic,image/webp,application/pdf"
                  className="text-13"
                />
              </Field>
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? l("quote.upload.working") : l("quote.upload.submit")}
              </Button>
            </Form>
          </Card>
        ) : null}

        <footer className="mt-10 border-t border-border pt-4 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("quote.back")}
          </a>
        </footer>
      </div>
    </main>
  );
}

import { Fragment, type ReactNode } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AgentBadge,
  Badge,
  Button,
  Card,
  cn,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  Field,
  focusRing,
  GuardrailNotice,
  Input,
  Money,
  Ref,
  shortRef
} from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem as ApiProblem } from "../api.server";
import { toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { pseudoText, translator } from "../i18n";
import { jsonOf } from "../json.js";
import { vocabulary } from "../modules/vocabulary";
import { Problem } from "./module";
import { useShellData } from "./workspace";

// One requirement, shopped to every eligible offering, answered side by side.
// The generic list/record pair cannot render this: the interesting axis is the
// offering, not the row, so the table is transposed — attributes down the side,
// one column per offer — and the whole point is that the differences between
// two columns are visible without opening anything.

/* --------------------------------------------------------------- contract */

/** Permission strings exactly as apps/api spells them: the DIST registry in
 *  apps/api/src/resources.ts, plus the share and select handlers in
 *  apps/api/src/routes/dist.ts. Since docs/27 F13 those are two verbs —
 *  sending a comparison out is not the same authority as closing on one. */
const PERM = {
  shop: "dist:quote_requests:create",
  share: "dist:quote_requests:share",
  select: "dist:quote_requests:select",
  commissions: "dist:commissions:read",
  offersRead: "dist:offers:read",
  offersDecide: "dist:offers:override",
  bind: "axis:policies:bind"
} as const;

/** A calendar day as the API's instant: midnight UTC. */
function dayStart(value: FormDataEntryValue | null): number {
  const day = String(value ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00Z`) : NaN;
}

interface QuoteRequest {
  id: string;
  productId: string;
  channelId: string;
  customerId: string | null;
  consentId: string | null;
  caseId: string | null;
  inputsJson: Record<string, unknown>;
  currency: string;
  state: string;
  fanoutCount: number | null;
  respondedCount: number | null;
  sharedWithCustomerAt: number | null;
  expiresAt: number | null;
  createdAt: number;
}

interface Offering {
  id: string;
  providerId: string;
  code: string;
  /** `{"en":"…","ar":"…"}` — the offering names itself, we never do. */
  nameJson: string;
  currency: string;
}

interface Quote {
  id: string;
  offeringId: string;
  providerId: string;
  state: string;
  premiumMinor: number | null;
  taxMinor: number | null;
  feesMinor: number | null;
  currency: string;
  commissionPpm: number | null;
  commissionMinor: number | null;
  channelCommissionMinor: number | null;
  coverageJson: string | null;
  priceRank: number | null;
  valueScore: number | null;
  rationaleKey: string | null;
  validUntil: number | null;
  selectedAt: number | null;
  offering: Offering | null;
}

interface Unavailable {
  offeringId: string;
  providerId: string;
  state: string;
  reason: string | null;
}

interface Comparison {
  request: QuoteRequest;
  quotes: Quote[];
  unavailable: Unavailable[];
  bestValue: string | null;
}

interface Offer {
  id: string;
  kind: string;
  offeringId: string | null;
  score: number | null;
  expectedValueMinor: number | null;
  currency: string | null;
  reasonKey: string | null;
  /** Already parsed on the wire — see `jsonOf`. */
  reasonJson: unknown;
  model: string | null;
  state: string;
  suppressReason: string | null;
  expiresAt: number | null;
}

/* ------------------------------------------------------------------ labels */

// This screen owns its own vocabulary rather than adding keys to the shared
// catalogue: a bespoke route is the one place where a local table is cheaper
// than a shell-wide one. `common.*` still comes from the catalogue.
const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Quote comparison",
    detail: "Detail",
    provider: "Provider",
    price: "Price",
    tax: "Tax",
    fees: "Fees",
    total: "Total payable",
    validUntil: "Valid until",
    commission: "Commission",
    commissionRate: "Commission rate",
    channelShare: "Channel share",
    differs: "Differs",
    bestValue: "Best value",
    selected: "Selected",
    select: "Select",
    choose: "Choose",
    selectConsequence:
      "Selecting records the customer's choice, writes it to the audit trail and closes this comparison as converted. Tenant policy may require an approval before it stands.",
    share: "Share with customer",
    sharedAt: "Shared with customer",
    reshop: "Re-shop the panel",
    reshopHint: "Prices the same requirement again across every eligible offering, as a new comparison.",
    region: "Offer comparison — scroll sideways for more offers",
    responded: "{responded} of {fanout} responded",
    expires: "Comparison expires",
    expired: "Expired",
    expiredBody: "This comparison is past its expiry. Prices are indicative only — re-shop the panel for a fresh answer.",
    quoteExpired: "This price has lapsed",
    emptyTitle: "No quotes to compare",
    emptyBody: "Nothing on the panel returned a price for this request.",
    emptyWaitingTitle: "Nothing has come back yet",
    emptyWaitingBody:
      "The requirement went out to {fanout} on the panel and none of them has answered. Answers land here as they arrive.",
    emptySilentTitle: "The panel was never asked",
    emptySilentBody: "This request has no responses at all, not even a decline. Re-shop it to send the requirement out.",
    awaitingTitle: "Still out with the panel",
    awaitingBody: "Asked, no answer yet. These may still turn into a price.",
    unavailableTitle: "Did not quote",
    unavailableBody: "Answered, but with no price. The reason each one gave is the panel's quality signal.",
    reason: "Reason",
    "done.share": "Marked as shared with the customer.",
    "done.select": "Selection recorded and the comparison closed as converted.",
    "done.bind": "Issued.",
    openPolicy: "Open what was issued",
    bindTitle: "Issue from the selected quote",
    bindBody: "The selected quote becomes what the customer holds. Price, provider and product come from the quote itself; give it a number and a term.",
    bindNoCustomer: "This comparison has no customer, so it can be priced but not sold. Shop it again for a named customer to issue it.",
    "bind.policyNo": "Policy number",
    startAt: "Starts",
    endAt: "Ends",
    bindSubmit: "Issue",
    "done.accepted": "Interest recorded against this suggestion.",
    "done.dismissed": "Suggestion dismissed. It will not be shown again.",
    approvalRef: "Approval {id}",
    approvalOpen: "Open approvals",
    offersTitle: "Suggested next",
    offerEvidence: "Why this was suggested",
    matchScore: "Match score",
    noScore: "No score was recorded for this suggestion.",
    expectedValue: "Expected value",
    noExpectedValue: "No expected value was recorded.",
    offerExpires: "Suggestion expires",
    suppressed: "Held back",
    "suppress.no_consent": "Held back — the customer has not consented to being offered this.",
    "suppress.frequency_cap": "Held back — this customer has already been offered enough for now.",
    "suppress.not_eligible": "Held back — the customer does not qualify for this offering.",
    "suppress.agent_declined": "Held back — an agent has already declined it on their behalf.",
    accept: "Accept",
    offerNote: "Accepting records interest only — nothing is bought and no shop starts.",
    "kind.cross_sell": "Cross-sell",
    "kind.upsell": "Upsell",
    "kind.renewal": "Renewal",
    "kind.bundle": "Bundle",
    "kind.top_up": "Top-up",
    "quote.rationale.cheapest": "Lowest price",
    "nbo.reason.renewal_due": "Renewal falls due",
    "nbo.reason.upgrade_available": "An upgrade is available",
    "nbo.reason.complements_cover": "Complements what they already hold",
    "nbo.reason.bundle_fit": "Fits an existing bundle",
    "state.fanned_out": "Sent out",
    "state.complete": "Complete",
    "state.converted": "Converted",
    "state.pending": "Pending",
    "state.declined": "Declined",
    "state.referred": "Referred",
    "state.timeout": "Timed out",
    "state.error": "Error",
    "state.suppressed": "Held back",
    "state.quoted": "Quoted"
  },
  ar: {
    title: "مقارنة العروض",
    detail: "البند",
    provider: "المزوّد",
    price: "السعر",
    tax: "الضريبة",
    fees: "الرسوم",
    total: "الإجمالي المستحق",
    validUntil: "صالح حتى",
    commission: "العمولة",
    commissionRate: "معدل العمولة",
    channelShare: "حصة القناة",
    differs: "يختلف",
    bestValue: "أفضل قيمة",
    selected: "مختار",
    select: "اختيار",
    choose: "الاختيار",
    selectConsequence:
      "الاختيار يسجّل قرار العميل ويكتبه في سجل التدقيق ويغلق هذه المقارنة كمحوّلة. قد تشترط سياسة المؤسسة موافقة قبل اعتماده.",
    share: "مشاركة مع العميل",
    sharedAt: "تمت المشاركة مع العميل",
    reshop: "إعادة طلب العروض",
    reshopHint: "يعيد تسعير المتطلب نفسه لدى كل عرض مؤهل، كمقارنة جديدة.",
    region: "مقارنة العروض — مرّر جانبيًا لعرض المزيد",
    responded: "{responded} من {fanout} استجابوا",
    expires: "تنتهي صلاحية المقارنة",
    expired: "منتهية الصلاحية",
    expiredBody: "انتهت صلاحية هذه المقارنة. الأسعار استرشادية فقط — أعد طلب العروض للحصول على إجابة حديثة.",
    quoteExpired: "انتهت صلاحية هذا السعر",
    emptyTitle: "لا توجد عروض للمقارنة",
    emptyBody: "لم تُرجع أي جهة في قائمة الجهات المسعّرة سعرًا لهذا الطلب.",
    emptyWaitingTitle: "لم تصل أي إجابة بعد",
    emptyWaitingBody: "أُرسل المتطلب إلى {fanout} في قائمة الجهات المسعّرة ولم يجب أحد. تظهر الإجابات هنا فور وصولها.",
    emptySilentTitle: "لم تُسأل القائمة إطلاقًا",
    emptySilentBody: "لا يحمل هذا الطلب أي استجابة، ولا حتى رفضًا. أعد طلب العروض لإرسال المتطلب.",
    awaitingTitle: "ما زالت لدى القائمة",
    awaitingBody: "سُئلت ولم تجب بعد. قد تتحول إلى سعر لاحقًا.",
    unavailableTitle: "لم تقدّم عرضًا",
    unavailableBody: "أجابت دون سعر. السبب الذي ذكرته كل جهة هو مؤشر جودة القائمة.",
    reason: "السبب",
    "done.share": "سُجّلت المشاركة مع العميل.",
    "done.select": "سُجّل الاختيار وأُغلقت المقارنة كمحوّلة.",
    "done.bind": "تم الإصدار.",
    openPolicy: "فتح ما صدر",
    bindTitle: "الإصدار من العرض المختار",
    bindBody: "يصبح العرض المختار ما يحمله العميل. السعر والجهة والمنتج من العرض نفسه؛ أدخل رقمًا ومدة.",
    bindNoCustomer: "لا عميل لهذه المقارنة، فيمكن تسعيرها لا بيعها. أعد طلب العروض لعميل محدد لإصدارها.",
    "bind.policyNo": "رقم الوثيقة",
    startAt: "تبدأ",
    endAt: "تنتهي",
    bindSubmit: "إصدار",
    "done.accepted": "سُجّل الاهتمام بهذا الاقتراح.",
    "done.dismissed": "تم تجاهل الاقتراح ولن يُعرض ثانية.",
    approvalRef: "الموافقة {id}",
    approvalOpen: "فتح الموافقات",
    offersTitle: "مقترحات تالية",
    offerEvidence: "سبب الاقتراح",
    matchScore: "درجة الملاءمة",
    noScore: "لم تُسجَّل درجة لهذا الاقتراح.",
    expectedValue: "القيمة المتوقعة",
    noExpectedValue: "لم تُسجَّل قيمة متوقعة.",
    offerExpires: "ينتهي الاقتراح",
    suppressed: "موقوف",
    "suppress.no_consent": "موقوف — لم يوافق العميل على تلقي هذا العرض.",
    "suppress.frequency_cap": "موقوف — بلغ هذا العميل حدّ العروض المسموح بها حاليًا.",
    "suppress.not_eligible": "موقوف — العميل غير مؤهل لهذا العرض.",
    "suppress.agent_declined": "موقوف — رفضه موظف نيابة عن العميل.",
    accept: "قبول",
    offerNote: "القبول يسجّل الاهتمام فقط — لا شراء ولا طلب عروض جديد.",
    "kind.cross_sell": "بيع تكميلي",
    "kind.upsell": "ترقية",
    "kind.renewal": "تجديد",
    "kind.bundle": "حزمة",
    "kind.top_up": "تعزيز",
    "quote.rationale.cheapest": "أقل سعر",
    "nbo.reason.renewal_due": "التجديد مستحق",
    "nbo.reason.upgrade_available": "ترقية متاحة",
    "nbo.reason.complements_cover": "يكمّل ما لديه بالفعل",
    "nbo.reason.bundle_fit": "يناسب حزمة قائمة",
    "state.fanned_out": "أُرسل",
    "state.complete": "مكتمل",
    "state.converted": "محوّل",
    "state.pending": "قيد الانتظار",
    "state.declined": "مرفوض",
    "state.referred": "محال",
    "state.timeout": "انتهت المهلة",
    "state.error": "خطأ",
    "state.suppressed": "موقوف",
    "state.quoted": "مسعّر"
  }
};

/** Past its expiry the API refuses a selection (routes/dist.ts returns 409) — pulled
 *  out of the component so the header and the button read the same clock. */
export function requestExpired(expiresAt: number | null, now: number): boolean {
  return expiresAt !== null && expiresAt <= now;
}

/**
 * Pack, local catalogue, English fallback, then the raw key — same contract as
 * detail-kit's labelsFrom. The pack goes first (CLAUDE.md §14): a bespoke route
 * with its own table is still the tenant's vocabulary, not insurance's.
 */
export function labeller(locale: string, pack?: string) {
  const packed = vocabulary(pack, locale);
  const table = LABELS[locale] ?? LABELS.en ?? {};
  const fallback = LABELS.en ?? {};
  return (key: string, vars?: Record<string, string>): string => {
    const raw = pseudoText(locale, packed(key) ?? table[key] ?? fallback[key] ?? key);
    return vars ? raw.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match) : raw;
  };
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";

  // The shell's copy of the actor's permissions only exists in the browser, and
  // two decisions here are server-side: whether margin data may leave this
  // loader at all, and whether the suggestion list is fetched. One /v1/me hop
  // buys both, and it is the same call the layout already makes.
  const [me, comparison] = await Promise.all([
    fetchMe(env, request),
    api<Comparison>(`/v1/dist/quote-requests/${id}/comparison`, { env, request })
  ]);
  const held = new Set(me.permissions);
  const commission = held.has(PERM.commissions);

  let offers: Offer[] = [];
  const customerId = comparison.request.customerId;
  if (customerId && held.has(PERM.offersRead)) {
    const query = new URLSearchParams({
      customerId,
      // Held-back suggestions are shown, not hidden: the reason a suggestion did
      // not surface is the part an agent has to be able to answer for.
      state: "proposed,surfaced,suppressed",
      sort: "score",
      order: "desc",
      limit: "5"
    });
    // A grant can be revoked between /v1/me and this call, and the panel is a
    // side dish — it must never take the comparison down with it.
    try {
      const page = await api<{ data: Offer[] }>(`/v1/dist/next-best-offers?${query.toString()}`, {
        env,
        request
      });
      offers = page.data ?? [];
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }

  return {
    // Expiry is decided on the server so the first paint and the hydration agree.
    now: Date.now(),
    // F56: consequential writes (select, offer decide) carry an idempotency key.
    // One per page load, then made unique per offer+intent in the form so two
    // different decisions never share a key.
    idempotencyKey: crypto.randomUUID(),
    request: comparison.request,
    // The API already strips commission for customer actors; staff without the
    // commission permission get the same treatment before the payload ships.
    quotes: commission
      ? comparison.quotes
      : comparison.quotes.map((quote) => ({
          ...quote,
          commissionPpm: null,
          commissionMinor: null,
          channelCommissionMinor: null
        })),
    unavailable: comparison.unavailable,
    bestValue: comparison.bestValue,
    offers,
    can: {
      commission,
      shop: held.has(PERM.shop),
      share: held.has(PERM.share),
      select: held.has(PERM.select),
      decide: held.has(PERM.offersDecide),
      bind: held.has(PERM.bind)
    }
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  // What the write actually did, echoed back so the page can say so out loud
  // instead of leaving the operator to infer it from a changed table.
  let done: string | null = null;
  let policyId: string | null = null;

  // F56: every consequential write here carries an idempotency key, unique per
  // intent and target so two different decisions in one page load never share
  // one. The base key comes from the loader; the suffix makes it per-write.
  const baseKey = String(form.get("idempotencyKey") ?? "");

  try {
    if (intent === "share") {
      await api(`/v1/dist/quote-requests/${id}/share`, { env, request, method: "POST" });
      done = "done.share";
    } else if (intent === "select") {
      const responseId = String(form.get("responseId") ?? "");
      await api(`/v1/dist/quote-requests/${id}/select`, {
        env,
        request,
        method: "POST",
        body: { responseId },
        ...(baseKey ? { headers: { "idempotency-key": `${baseKey}:${responseId}:select` } } : {})
      });
      done = "done.select";
    } else if (intent === "bind") {
      // The sale: the selected quote becomes the policy. The API holds it for
      // approval where policy says so (axis.bind); that answer is a gate, shown
      // beside this form like every other one on the page.
      const responseId = String(form.get("responseId") ?? "");
      const bound = await api<{ policy: { id: string } }>(`/v1/axis/quote-responses/${encodeURIComponent(responseId)}/bind`, {
        env,
        request,
        method: "POST",
        body: {
          policyNo: String(form.get("policyNo") ?? "").trim(),
          startAt: dayStart(form.get("startAt")),
          endAt: dayStart(form.get("endAt"))
        },
        ...(baseKey ? { headers: { "idempotency-key": `${baseKey}:${responseId}:bind` } } : {})
      });
      policyId = bound.policy.id;
      done = "done.bind";
    } else if (intent === "offer") {
      const decision = String(form.get("decision") ?? "");
      const offerId = String(form.get("offerId") ?? "");
      await api(`/v1/dist/next-best-offers/${offerId}/decide`, {
        env,
        request,
        method: "POST",
        body: { decision, ...(decision === "accepted" ? { quoteRequestId: id } : {}) },
        ...(baseKey ? { headers: { "idempotency-key": `${baseKey}:${offerId}:${decision}` } } : {})
      });
      done = decision === "accepted" ? "done.accepted" : "done.dismissed";
    } else if (intent === "shop") {
      // A shop always mints a new quote request, so re-shopping means reading
      // this one's inputs back and following the new id.
      const current = await api<QuoteRequest>(`/v1/dist/quote-requests/${id}`, { env, request });
      const fresh = await api<{ request: { id: string } }>("/v1/dist/quote-requests/shop", {
        env,
        request,
        method: "POST",
        body: {
          productId: current.productId,
          channelId: current.channelId,
          ...(current.customerId ? { customerId: current.customerId } : {}),
          ...(current.consentId ? { consentId: current.consentId } : {}),
          ...(current.caseId ? { caseId: current.caseId } : {}),
          currency: current.currency,
          inputs: current.inputsJson
        }
      });
      // Not a path.replace() on request.url: single-fetch actions post to the
      // `.data` URL, so its pathname ends in "compare.data" and the swap
      // silently no-ops, redirecting back to a URL no route matches.
      return redirect(`/distribution/quote-requests/${fresh.request.id}/compare`);
    } else {
      return { problem: { title: "unknown intent", status: 400 }, done: null, policyId: null, intent };
    }
  } catch (error) {
    // A rejected write is information, not a crash: an expired quote, a missing
    // consent or an approval gate all belong on this page, next to the offer.
    if (error instanceof ApiError) return { problem: error.problem, done: null, policyId: null, intent };
    throw error;
  }
  return { problem: null, done, policyId, intent };
}

/* --------------------------------------------------------------- component */

export default function QuoteCompare() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  // A refused issue is shown inside the issue form, at the foot of a long page,
  // rather than at the top where its reader cannot see it.
  const bindProblem = result?.intent === "bind" ? (result.problem ?? null) : null;
  const problem = bindProblem ? null : (result?.problem ?? null);
  const done = result?.done ?? null;
  const shell = useShellData();
  const navigation = useNavigation();
  const location = useLocation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const L = labeller(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";

  const request = loaded.request;
  const quotes = loaded.quotes;
  const gate = approvalOf(problem);
  // `/distribution/quote-requests/:id/compare` → the list this came from,
  // without this file needing to know what the workspace calls itself.
  const listPath = location.pathname.replace(/\/[^/]+\/compare\/?$/, "");

  const attributes = attributesFor(quotes, { locale, L, t, commission: loaded.can.commission });
  const alreadySelected = quotes.some((quote) => quote.selectedAt !== null);
  const chosen = quotes.find((quote) => quote.selectedAt !== null && quote.premiumMinor !== null) ?? null;
  // Past its expiry the API refuses a selection (routes/dist.ts returns 409), so
  // the button says so up front rather than letting the click find out.
  const expired = requestExpired(request.expiresAt, loaded.now);
  const closed = alreadySelected || expired || request.state === "converted";
  // Two different silences: still out with the panel, versus answered with a no.
  const awaiting = loaded.unavailable.filter((entry) => entry.state === "pending");
  const refused = loaded.unavailable.filter((entry) => entry.state !== "pending");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link to={listPath} className="w-fit font-ui text-12 text-subtle underline-offset-2 hover:underline">
            {t("common.back")}
          </Link>
          <h1 className="page-title">{L("title")}</h1>
          <p className="flex flex-wrap items-center gap-2 font-ui text-12 text-subtle">
            <Ref value={request.id} />
            <Badge tone={toneFor(request.state)} size="sm" dot>
              {L(`state.${request.state}`)}
            </Badge>
            <span>
              {L("responded", {
                responded: String(request.respondedCount ?? quotes.length),
                fanout: String(request.fanoutCount ?? quotes.length)
              })}
            </span>
            {request.expiresAt !== null ? (
              <span>
                {expired ? L("expired") : L("expires")} ·{" "}
                <DateTime value={request.expiresAt} locale={locale} precision="minute" />
              </span>
            ) : null}
            {request.sharedWithCustomerAt ? (
              <span>
                {L("sharedAt")} · <DateTime value={request.sharedWithCustomerAt} locale={locale} precision="minute" />
              </span>
            ) : null}
          </p>
        </div>
      </header>

      {expired ? <GuardrailNotice title={L("expired")} reason={L("expiredBody")} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        {loaded.can.share ? (
          <Form method="post">
            <input type="hidden" name="intent" value="share" />
            <Button type="submit" variant="secondary" size="sm" loading={busy}>
              {L("share")}
            </Button>
          </Form>
        ) : null}
        {loaded.can.shop ? (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="shop" />
            <Button type="submit" variant="ghost" size="sm" loading={busy}>
              {L("reshop")}
            </Button>
            <span className="font-ui text-12 text-subtle">{L("reshopHint")}</span>
          </Form>
        ) : null}
      </div>

      {gate ? (
        <GuardrailNotice
          title={L("approvalTitle")}
          reason={
            <span className="flex flex-col gap-1">
              <span>{L("approvalBody", { policy: gate.policyKey })}</span>
              {gate.approvalId ? (
                <span className="font-mono text-12">{L("approvalRef", { id: gate.approvalId })}</span>
              ) : null}
            </span>
          }
          action={
            <Button asChild variant="secondary" size="sm">
              <Link to="/approvals">{L("approvalOpen")}</Link>
            </Button>
          }
        />
      ) : problem ? (
        <Problem problem={problem} />
      ) : done ? (
        // The write landed; say which one, because none of these actions is
        // obvious from the redrawn table alone.
        <p role="status" className="rounded-md border border-border bg-surface-2 p-3 font-ui text-13 text-text">
          {L(done)}
          {result?.policyId ? (
            <>
              {" "}
              <Link to={`/axis/policies/${result.policyId}`} className="text-accent underline underline-offset-4">
                {L("openPolicy")}
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      {quotes.length === 0 ? (
        refused.length ? (
          <EmptyState title={L("emptyTitle")} body={L("emptyBody")} />
        ) : awaiting.length || (request.fanoutCount ?? 0) > 0 ? (
          <EmptyState
            title={L("emptyWaitingTitle")}
            body={L("emptyWaitingBody", { fanout: String(request.fanoutCount ?? awaiting.length) })}
          />
        ) : (
          <EmptyState title={L("emptySilentTitle")} body={L("emptySilentBody")} />
        )
      ) : (
        <div className="flex flex-col gap-2">
          {/* A comparison that does not fit the viewport scrolls sideways, and a
              scrollable region needs a name and a tab stop to be reachable
              without a mouse (WCAG 2.2 AA).
              ponytail: hand-rolled table rather than <Table>, which is row-per-
              record; here the records are the columns. */}
          <div
            role="region"
            aria-label={L("region")}
            tabIndex={0}
            className={cn("overflow-x-auto rounded-lg border border-border bg-surface-1", focusRing)}
          >
            <table className="w-full min-w-[44rem] border-collapse text-start">
              <caption className="sr-only">{L("region")}</caption>
              <thead>
                <tr className="border-b border-border">
                  {/* The row labels stay put while the provider columns scroll
                      under them — without this, the fourth provider is a column
                      of numbers with nothing saying what they measure.
                      `start-0` not `left-0`: the sticky edge follows dir. */}
                  <th
                    scope="col"
                    className="sticky start-0 z-20 bg-surface-1 p-3 text-start font-ui text-12 text-subtle"
                  >
                    {L("detail")}
                  </th>
                  {quotes.map((quote) => (
                    <th key={quote.id} scope="col" className="min-w-52 p-3 text-start align-top">
                      <span className="flex flex-col gap-1">
                        <span className="font-ui text-14 text-text">{offeringName(quote, locale)}</span>
                        <Ref value={quote.providerId} className="text-12 text-subtle" />
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={toneFor(quote.state)} size="sm" dot>
                            {L(`state.${quote.state}`)}
                          </Badge>
                          {quote.rationaleKey ? (
                            <Badge tone="success" size="sm">
                              {L(quote.rationaleKey)}
                            </Badge>
                          ) : null}
                          {loaded.bestValue === quote.id ? (
                            <Badge tone="info" size="sm">
                              {L("bestValue")}
                            </Badge>
                          ) : null}
                          {quote.selectedAt ? (
                            <Badge tone="accent" size="sm">
                              {L("selected")}
                            </Badge>
                          ) : null}
                          {quote.validUntil !== null && quote.validUntil <= loaded.now ? (
                            <Badge tone="danger" size="sm">
                              {L("quoteExpired")}
                            </Badge>
                          ) : null}
                        </span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {attributes.map((attribute) => {
                  const differs =
                    quotes.length > 1 && new Set(quotes.map((quote) => attribute.stamp(quote))).size > 1;
                  return (
                    <tr key={attribute.key} className="border-b border-border/60">
                      <th
                        scope="row"
                        className="sticky start-0 z-10 bg-surface-1 p-3 text-start align-top font-ui text-12 font-normal text-subtle"
                      >
                        <span className="flex flex-wrap items-center gap-2">
                          {attribute.label}
                          {/* What decides a sale is where the columns disagree. */}
                          {differs ? (
                            <Badge tone="warning" size="sm">
                              {L("differs")}
                            </Badge>
                          ) : null}
                        </span>
                      </th>
                      {quotes.map((quote) => (
                        <td key={quote.id} className="p-3 align-top font-ui text-13 text-text">
                          {attribute.cell(quote) ?? <span className="text-subtle">—</span>}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              {loaded.can.select ? (
                <tfoot>
                  <tr>
                    <th
                      scope="row"
                      className="sticky start-0 z-10 bg-surface-1 p-3 text-start font-ui text-12 font-normal text-subtle"
                    >
                      {L("choose")}
                    </th>
                    {quotes.map((quote) => (
                      <td key={quote.id} className="p-3 align-top">
                        <Form method="post">
                          <input type="hidden" name="intent" value="select" />
                          <input type="hidden" name="responseId" value={quote.id} />
                          <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                          <Button
                            type="submit"
                            size="sm"
                            variant={quote.selectedAt ? "ghost" : "primary"}
                            loading={busy}
                            disabled={closed}
                            aria-label={`${L("select")} — ${offeringName(quote, locale)}`}
                          >
                            {quote.selectedAt ? L("selected") : L("select")}
                          </Button>
                        </Form>
                      </td>
                    ))}
                  </tr>
                </tfoot>
              ) : null}
            </table>
          </div>
          {loaded.can.select ? (
            // Say what the click actually does before it is clicked: it is
            // audited, it converts the request, and policy may hold it for
            // approval (CLAUDE.md §4).
            <p className="font-ui text-12 text-subtle">{L("selectConsequence")}</p>
          ) : null}
          {chosen && loaded.can.bind && result?.done !== "done.bind" ? (
            <BindPanel
              quote={chosen}
              customer={request.customerId}
              L={L}
              busy={busy}
              idempotencyKey={loaded.idempotencyKey}
              problem={bindProblem}
            />
          ) : null}
        </div>
      )}

      {awaiting.length ? (
        <PanelSection id="awaiting-heading" title={L("awaitingTitle")} body={L("awaitingBody")} entries={awaiting} L={L} />
      ) : null}

      {refused.length ? (
        <PanelSection
          id="unavailable-heading"
          title={L("unavailableTitle")}
          body={L("unavailableBody")}
          entries={refused}
          L={L}
        />
      ) : null}

      {loaded.offers.length ? (
        <section aria-labelledby="offers-heading" className="flex flex-col gap-3">
          <h2 id="offers-heading" className="eyebrow">
            {L("offersTitle")}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {loaded.offers.map((offer) => (
              <OfferCard
                key={offer.id}
                offer={offer}
                locale={locale}
                L={L}
                canDecide={loaded.can.decide}
                busy={busy}
                idempotencyKey={loaded.idempotencyKey}
              />
            ))}
          </div>
          <p className="font-ui text-12 text-subtle">{L("offerNote")}</p>
        </section>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * The half of the panel that returned no price, grouped by the answer it gave.
 * The count per state is the number an aggregator actually manages by — six
 * timeouts and six declines are the same row count and completely different
 * problems.
 */
function PanelSection({
  id,
  title,
  body,
  entries,
  L
}: {
  id: string;
  title: string;
  body: string;
  entries: Unavailable[];
  L: (key: string, vars?: Record<string, string>) => string;
}) {
  const states = [...new Set(entries.map((entry) => entry.state))];
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="eyebrow">
          {title}
        </h2>
        <p className="max-w-prose font-ui text-12 text-subtle">{body}</p>
      </div>
      <div className="flex flex-col gap-3">
        {states.map((state) => {
          const rows = entries.filter((entry) => entry.state === state);
          return (
            <div key={state} className="flex flex-col gap-1">
              <Badge tone={toneFor(state)} size="sm" dot className="self-start">
                <span className="tabular-nums">
                  {L(`state.${state}`)} · {rows.length}
                </span>
              </Badge>
              <ul className="flex flex-col gap-1 border-s border-border ps-3">
                {rows.map((entry, index) => (
                  <li
                    key={`${entry.offeringId}:${index}`}
                    className="flex flex-wrap items-baseline gap-x-2 font-ui text-13 text-text"
                  >
                    <Ref value={entry.providerId} className="text-12 text-subtle" />
                    {entry.reason ? (
                      <span className="min-w-0 break-words text-subtle">
                        {L("reason")}: {entry.reason}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * One suggestion, in the ambient grammar (docs/15 §4): a quiet card carrying the
 * single ✦ with its "why" one interaction away, a confidence reading, and two
 * explicit buttons. Nothing here applies itself.
 */
function OfferCard({
  offer,
  locale,
  L,
  canDecide,
  busy,
  idempotencyKey
}: {
  offer: Offer;
  locale: string;
  L: (key: string, vars?: Record<string, string>) => string;
  canDecide: boolean;
  busy: boolean;
  idempotencyKey: string;
}) {
  const evidence = jsonObject(offer.reasonJson);
  return (
    <Card
      elevation="flat"
      title={L(`kind.${offer.kind}`)}
      description={offer.reasonKey ? L(offer.reasonKey) : null}
      actions={
        <AgentBadge
          {...(offer.model ? { agent: offer.model } : {})}
          why={
            <div className="flex flex-col gap-2">
              <span className="font-ui text-13 text-text">
                {offer.reasonKey ? L(offer.reasonKey) : L("offerEvidence")}
              </span>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-ui text-12 text-subtle">
                {Object.entries(evidence).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{humanize(key)}</dt>
                    <dd className="font-mono text-12 text-text">{String(value)}</dd>
                  </Fragment>
                ))}
                {offer.offeringId ? (
                  <Fragment>
                    <dt>{L("detail")}</dt>
                    <dd className="font-mono text-12 text-text">{shortRef(offer.offeringId)}</dd>
                  </Fragment>
                ) : null}
              </dl>
            </div>
          }
        />
      }
    >
      <div className="flex flex-col gap-3">
        <Badge tone={toneFor(offer.state)} size="sm" dot className="self-start">
          {L(`state.${offer.state}`)}
        </Badge>
        {/* A missing score is not a zero score — a meter at 0% would read as a
            confident "no fit" for something the model never rated. */}
        {offer.score === null ? (
          <p className="font-ui text-12 text-subtle">{L("noScore")}</p>
        ) : (
          <ConfidenceMeter value={offer.score / 100} label={L("matchScore")} />
        )}
        {offer.expectedValueMinor !== null && offer.currency ? (
          <p className="font-ui text-13 text-text">
            {L("expectedValue")}:{" "}
            <Money amountMinor={offer.expectedValueMinor} currency={offer.currency} locale={locale} />
          </p>
        ) : (
          <p className="font-ui text-12 text-subtle">{L("noExpectedValue")}</p>
        )}
        {offer.expiresAt !== null ? (
          <p className="font-ui text-12 text-subtle">
            {L("offerExpires")} · <DateTime value={offer.expiresAt} locale={locale} precision="minute" />
          </p>
        ) : null}
        {offer.suppressReason ? (
          // Held back is a decision the customer or the policy made, and the
          // agent has to be able to say which — so it is shown, not filtered out.
          <p className="flex flex-wrap items-baseline gap-2 font-ui text-12 text-subtle">
            <Badge tone="warning" size="sm">
              {L("suppressed")}
            </Badge>
            <span className="min-w-0">{L(`suppress.${offer.suppressReason}`)}</span>
          </p>
        ) : null}
        {canDecide && !offer.suppressReason ? (
          <Form method="post" className="flex flex-wrap gap-2">
            <input type="hidden" name="intent" value="offer" />
            <input type="hidden" name="offerId" value={offer.id} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Button type="submit" name="decision" value="accepted" variant="secondary" size="sm" loading={busy}>
              {L("accept")}
            </Button>
            <Button type="submit" name="decision" value="dismissed" variant="ghost" size="sm" loading={busy}>
              {L("dismiss")}
            </Button>
          </Form>
        ) : null}
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------- utils */

interface Attribute {
  key: string;
  label: string;
  cell: (quote: Quote) => ReactNode;
  /** Comparable form of the cell, so "these two columns differ" is decidable. */
  stamp: (quote: Quote) => string;
}

/**
 * The rows of the comparison. Price, tax and fees are structural; everything
 * else is whatever the offerings themselves put in `coverageJson`, because the
 * attributes that decide a sale are the domain pack's to name, not ours
 * (CLAUDE.md §14).
 */
function attributesFor(
  quotes: Quote[],
  opts: {
    locale: string;
    L: (key: string, vars?: Record<string, string>) => string;
    t: (key: string, vars?: Record<string, string>) => string;
    commission: boolean;
  }
): Attribute[] {
  const { locale, L, t, commission } = opts;
  const money = (amount: number | null, currency: string): ReactNode =>
    amount === null ? null : <Money amountMinor={amount} currency={currency} locale={locale} />;

  const out: Attribute[] = [
    {
      key: "price",
      label: L("price"),
      cell: (quote) => money(quote.premiumMinor, quote.currency),
      stamp: (quote) => `${quote.premiumMinor ?? ""}${quote.currency}`
    }
  ];

  for (const [key, label] of [
    ["taxMinor", L("tax")],
    ["feesMinor", L("fees")]
  ] as const) {
    if (quotes.some((quote) => quote[key] !== null)) {
      out.push({
        key,
        label,
        cell: (quote) => money(quote[key], quote.currency),
        stamp: (quote) => String(quote[key] ?? "")
      });
    }
  }

  if (quotes.some((quote) => quote.taxMinor !== null || quote.feesMinor !== null)) {
    const total = (quote: Quote) =>
      quote.premiumMinor === null
        ? null
        : quote.premiumMinor + (quote.taxMinor ?? 0) + (quote.feesMinor ?? 0);
    out.push({
      key: "total",
      label: L("total"),
      cell: (quote) => money(total(quote), quote.currency),
      stamp: (quote) => String(total(quote) ?? "")
    });
  }

  // Union of coverage keys, in first-seen order: an offering that carries an
  // attribute nobody else does is exactly the difference worth showing.
  const coverages = new Map(quotes.map((quote) => [quote.id, jsonObject(quote.coverageJson)]));
  const keys: string[] = [];
  for (const coverage of coverages.values()) {
    for (const key of Object.keys(coverage)) if (!keys.includes(key)) keys.push(key);
  }
  for (const key of keys) {
    out.push({
      key: `coverage.${key}`,
      label: humanize(key),
      cell: (quote) => coverageCell(key, coverages.get(quote.id)?.[key], quote.currency, locale, t),
      stamp: (quote) => JSON.stringify(coverages.get(quote.id)?.[key] ?? null)
    });
  }

  out.push({
    key: "validUntil",
    label: L("validUntil"),
    cell: (quote) =>
      quote.validUntil === null ? null : (
        <DateTime value={quote.validUntil} locale={locale} precision="minute" />
      ),
    stamp: (quote) => String(quote.validUntil ?? "")
  });

  if (commission) {
    out.push(
      {
        key: "commission",
        label: L("commission"),
        cell: (quote) => money(quote.commissionMinor, quote.currency),
        stamp: (quote) => String(quote.commissionMinor ?? "")
      },
      {
        key: "commissionRate",
        label: L("commissionRate"),
        // Rates are stored in parts per million (packages/db dist schema).
        // Intl, not `toFixed` + "%": the sign's side and the digits are the
        // reader's, not English's.
        cell: (quote) =>
          quote.commissionPpm === null ? null : (
            <span className="tabular-nums">
              {new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
                quote.commissionPpm / 1_000_000
              )}
            </span>
          ),
        stamp: (quote) => String(quote.commissionPpm ?? "")
      }
    );
    if (quotes.some((quote) => quote.channelCommissionMinor !== null)) {
      out.push({
        key: "channelShare",
        label: L("channelShare"),
        cell: (quote) => money(quote.channelCommissionMinor, quote.currency),
        stamp: (quote) => String(quote.channelCommissionMinor ?? "")
      });
    }
  }

  return out;
}

function coverageCell(
  key: string,
  value: unknown,
  currency: string,
  locale: string,
  t: (key: string) => string
): ReactNode {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return t(value ? "common.yes" : "common.no");
  if (typeof value === "number") {
    // The platform's money convention: a `*Minor` field is minor units.
    return key.endsWith("Minor") ? (
      <Money amountMinor={value} currency={currency} locale={locale} />
    ) : (
      <span className="tabular-nums">{value}</span>
    );
  }
  if (typeof value === "object") return <span className="font-mono text-12">{JSON.stringify(value)}</span>;
  return String(value);
}

/** The offering names itself, per locale; the code is the last resort. */
function offeringName(quote: Quote, locale: string): string {
  const offering = quote.offering;
  if (!offering) return quote.offeringId;
  const names = jsonObject(offering.nameJson);
  const localised = names[locale] ?? names.en;
  return typeof localised === "string" ? localised : offering.code;
}

// Two wire shapes meet here: the comparison route hands back raw rows, so
// `nameJson`/`coverageJson` are still text, while `next-best-offers` is generic
// CRUD and its `reasonJson` arrives parsed. `jsonOf` settles both.
function jsonObject(raw: unknown): Record<string, unknown> {
  const parsed = jsonOf(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/** `excessMinor` → "Excess"; the data supplies the noun, we only space it out. */
function humanize(key: string): string {
  const words = key
    .replace(/Minor$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A consequential action the tenant's policy holds comes back as a 403 with
 * `code: "approval_required"` (packages/core/src/errors.ts). Reading it here is
 * what keeps the button honest: the click raised an approval, it did not close
 * the sale.
 */
function approvalOf(problem: ApiProblem | null): { policyKey: string; approvalId?: string } | null {
  if (!problem || problem.status !== 403) return null;
  const extras = problem as ApiProblem & {
    code?: string;
    policy_key?: string;
    approval_id?: string;
  };
  if (extras.code !== "approval_required") return null;
  return {
    policyKey: extras.policy_key ?? problem.detail ?? problem.title,
    ...(extras.approval_id ? { approvalId: extras.approval_id } : {})
  };
}

/**
 * The sale. A selected quote becomes the policy the customer holds: a number
 * and a term, nothing else typed — premium, provider and product come from the
 * quote itself on the server. A comparison with no customer can price a risk
 * but not sell one (routes/axis.ts refuses it), so the form says why instead.
 */
function BindPanel({
  quote,
  customer,
  L,
  busy,
  idempotencyKey,
  problem
}: {
  quote: Quote;
  customer: string | null;
  L: (key: string, vars?: Record<string, string>) => string;
  busy: boolean;
  idempotencyKey: string;
  problem: ApiProblem | null;
}) {
  const gated = approvalOf(problem);
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const nextYear = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), today.getUTCDate() - 1));
  return (
    <section aria-labelledby="bind-heading" className="flex flex-col gap-3 rounded-lg border border-border bg-surface-1 p-4">
      <h2 id="bind-heading" className="section-title">
        {L("bindTitle")}
      </h2>
      {customer ? (
        <Form method="post" className="flex flex-col gap-3">
          <p className="max-w-prose font-ui text-13 text-muted">{L("bindBody")}</p>
          <input type="hidden" name="intent" value="bind" />
          <input type="hidden" name="responseId" value={quote.id} />
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={L("bind.policyNo")} required>
              <Input name="policyNo" required maxLength={64} />
            </Field>
            <Field label={L("startAt")} required>
              <Input name="startAt" type="date" required defaultValue={iso(today)} />
            </Field>
            <Field label={L("endAt")} required>
              <Input name="endAt" type="date" required defaultValue={iso(nextYear)} />
            </Field>
          </div>
          {gated ? (
            <p role="status" className="font-ui text-13 text-warning">
              {L("approvalBody", { policy: gated.policyKey })}
            </p>
          ) : problem ? (
            <Problem problem={problem} />
          ) : null}
          <div>
            <Button type="submit" loading={busy}>
              {L("bindSubmit")}
            </Button>
          </div>
        </Form>
      ) : (
        <p className="max-w-prose font-ui text-13 text-muted">{L("bindNoCustomer")}</p>
      )}
    </section>
  );
}

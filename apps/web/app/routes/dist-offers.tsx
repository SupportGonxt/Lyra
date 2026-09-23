import { Fragment } from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  AgentBadge,
  Badge,
  Button,
  ConfidenceMeter,
  DateTime,
  EmptyState,
  EvidenceLink,
  Money,
  Ref,
  shortRef
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { FieldInput, toneFor } from "../components/fields";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { bodyFrom, humanise, optionLabel, type FieldSpec, type Row } from "../modules/spec";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { labelsFrom } from "./detail-kit";
import { jsonOf } from "../json.js";

// Next best offers for one customer: ask the model for them, read what it
// proposed and why, then decide which of them a person is allowed to see.
//
// Proposing is a background draft — nothing reaches the customer. Surfacing is
// the consequential half, and it is a separate, per-offer decision made by
// someone who can see the evidence (CLAUDE.md §4, docs/15 §4).

/** apps/api/src/routes/dist.ts. Note the two write gates are not the same. */
const PERM = {
  read: "dist:offers:read",
  /** `POST /next-best-offers/propose` — dist.ts requires only the read grant. */
  propose: "dist:offers:read",
  /** `POST /next-best-offers/:id/surface`. */
  surface: "dist:offers:surface"
} as const;

/** ProposeBody, apps/api/src/routes/dist.ts. */
const PROPOSE_FIELDS: readonly FieldSpec[] = [
  { name: "customerId", type: "text", required: true, hintKey: "customerIdHint" },
  { name: "channelId", type: "text", hintKey: "channelIdHint" },
  { name: "anchorPolicyId", type: "text", hintKey: "anchorPolicyIdHint" },
  { name: "limit", type: "number", hintKey: "limitHint" }
];

/** `markSurfaced` only moves an offer out of `proposed`; anything else no-ops. */
const SURFACEABLE = "proposed";

export interface Offer {
  id: string;
  customerId: string;
  kind: string;
  offeringId: string;
  anchorRef: string | null;
  channelId: string | null;
  score: number;
  expectedValueMinor: number | null;
  currency: string | null;
  reasonKey: string;
  /** Already parsed on the wire — see `jsonOf`. */
  reasonJson: unknown;
  runId: string | null;
  model: string | null;
  state: string;
  suppressReason: string | null;
  surfacedAt: number | null;
  decidedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
}

interface Page {
  data: Offer[];
  cursor?: string;
}

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Next best offers",
    intro:
      "Asks the model what this customer is most likely to take next, and why. Proposing changes nothing the customer can see — an offer reaches them only when someone surfaces it.",
    backToOffers: "Back to next best offers",
    "summary.offers": "{count} offers, {surfaceable} ready to surface.",
    ask: "Propose offers",
    askIntro: "Scored against what this customer already holds. Nothing is sent.",
    customerId: "Customer",
    customerIdHint: "The customer to score. Required.",
    channelId: "Channel",
    channelIdHint: "Restrict to one channel's offerings. Optional.",
    anchorPolicyId: "Anchor policy",
    anchorPolicyIdHint: "The policy the suggestion should build on. Optional.",
    limit: "How many",
    limitHint: "Between 1 and 10. Defaults to the model's own cut-off.",
    proposed: "Proposed {count} offers.",
    results: "What the model proposed",
    startTitle: "Start with a customer",
    startBody: "Give a customer and the model will score every offering they do not already hold.",
    emptyTitle: "Nothing to offer this customer",
    emptyBody:
      "The model found no offering worth proposing — usually because the customer already holds them, or none is eligible.",
    deniedTitle: "You cannot read offers",
    matchScore: "Match",
    noScore: "Not scored",
    expectedValue: "Expected value",
    noExpectedValue: "No value estimated",
    expires: "Expires",
    why: "Why this offer",
    evidence: "The signals behind this score",
    model: "Model",
    run: "Run",
    anchor: "Built on",
    offering: "Offering",
    surface: "Surface to the customer",
    surfaceFor: "Surface the {kind} offer to the customer",
    surfaced: "Surfaced",
    surfacedNow: "Surfaced.",
    notSurfaceable: "Already decided — surfacing does nothing now.",
    suppressed: "Held back",
    "kind.cross_sell": "Cross-sell",
    "kind.upsell": "Upsell",
    "kind.renewal": "Renewal",
    "kind.bundle": "Bundle",
    "kind.top_up": "Top-up",
    "state.surfaced": "Surfaced",
    "state.suppressed": "Suppressed",
    "state.converted": "Converted",
    "suppress.no_consent": "The customer has not consented to being offered this.",
    "suppress.frequency_cap": "They have been offered enough for now.",
    "suppress.not_eligible": "They are not eligible for this offering.",
    "suppress.agent_declined": "An agent declined it."
  },
  ar: {
    title: "أفضل العروض التالية",
    intro:
      "يسأل النموذج عما يرجَّح أن يأخذه هذا العميل تاليًا، ولماذا. الاقتراح لا يغيّر شيئًا يراه العميل — لا يصل إليه العرض إلا حين يعرضه شخص ما.",
    backToOffers: "العودة إلى أفضل العروض التالية",
    "summary.offers": "{count} عرضًا، {surfaceable} جاهز للعرض.",
    ask: "اقتراح عروض",
    askIntro: "تُحتسب مقابل ما يملكه العميل بالفعل. لا يُرسل شيء.",
    customerId: "العميل",
    customerIdHint: "العميل المراد احتسابه. مطلوب.",
    channelId: "القناة",
    channelIdHint: "الاقتصار على عروض قناة واحدة. اختياري.",
    anchorPolicyId: "الوثيقة المرجعية",
    anchorPolicyIdHint: "الوثيقة التي يُبنى عليها الاقتراح. اختياري.",
    limit: "العدد",
    limitHint: "بين 1 و10. الافتراضي هو حد النموذج نفسه.",
    proposed: "تم اقتراح {count} عرضًا.",
    results: "ما اقترحه النموذج",
    startTitle: "ابدأ بعميل",
    startBody: "أدخل عميلًا وسيحتسب النموذج كل عرض لا يملكه بعد.",
    emptyTitle: "لا يوجد ما يُعرض على هذا العميل",
    emptyBody:
      "لم يجد النموذج عرضًا يستحق الاقتراح — غالبًا لأن العميل يملكها بالفعل أو لا ينطبق عليه أي منها.",
    deniedTitle: "لا يمكنك قراءة العروض",
    matchScore: "التطابق",
    noScore: "غير محتسب",
    expectedValue: "القيمة المتوقعة",
    noExpectedValue: "لا تقدير للقيمة",
    expires: "ينتهي",
    why: "لماذا هذا العرض",
    evidence: "المؤشرات وراء هذه الدرجة",
    model: "النموذج",
    run: "التشغيل",
    anchor: "مبني على",
    offering: "المنتج",
    surface: "عرضه على العميل",
    surfaceFor: "عرض {kind} على العميل",
    surfaced: "عُرض",
    surfacedNow: "تم العرض.",
    notSurfaceable: "تم البت فيه — العرض الآن بلا أثر.",
    suppressed: "محجوب",
    "kind.cross_sell": "بيع تكميلي",
    "kind.upsell": "ترقية",
    "kind.renewal": "تجديد",
    "kind.bundle": "باقة",
    "kind.top_up": "تعزيز",
    "state.surfaced": "معروض",
    "state.suppressed": "محجوب",
    "state.converted": "محوَّل",
    "suppress.no_consent": "لم يوافق العميل على تلقي هذا العرض.",
    "suppress.frequency_cap": "تلقى ما يكفي من العروض حاليًا.",
    "suppress.not_eligible": "غير مؤهل لهذا المنتج.",
    "suppress.agent_declined": "رفضه أحد الوكلاء."
  }
};

/** The shared resolver: the tenant's pack, then the route's own table, then the
 *  shared catalogue, then the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------- rules */

/**
 * Whether surfacing this offer would do anything. `markSurfaced` filters on
 * `state = 'proposed'` and still answers 204 when it matched nothing, so a
 * button on a decided offer would report a success that never happened.
 */
export function canSurface(offer: Pick<Offer, "state">, maySurface: boolean): boolean {
  return maySurface && offer.state === SURFACEABLE;
}

/** The evidence blob, parsed defensively — it is model output, not a contract. */
export function evidenceOf(reasonJson: unknown): Record<string, unknown> {
  const parsed = jsonOf(reasonJson);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

/**
 * Total offers versus how many are still one click from surfacing. Arithmetic
 * over what the loader already listed — not a model finding, so no ✦
 * (CLAUDE.md §11, same call as `consoleHeadline` in orbit-console.tsx).
 */
export function offerSummary(offers: Pick<Offer, "state">[], maySurface: boolean): { total: number; surfaceable: number } {
  return { total: offers.length, surfaceable: offers.filter((offer) => canSurface(offer, maySurface)).length };
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const customerId = new URL(request.url).searchParams.get("customerId")?.trim() ?? "";

  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    read: held.has(PERM.read),
    propose: held.has(PERM.propose),
    surface: held.has(PERM.surface)
  };
  if (!may.read || !customerId) return { may, customerId, offers: null };

  const query = new URLSearchParams({ customerId, sort: "score", order: "desc", limit: "20" });
  try {
    const page = await api<Page>(`/v1/dist/next-best-offers?${query.toString()}`, { env, request });
    return { may, customerId, offers: page.data };
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return { may: { ...may, read: false }, customerId, offers: null };
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "surface") {
      await api<void>(`/v1/dist/next-best-offers/${String(form.get("offerId") ?? "")}/surface`, {
        env,
        request,
        method: "POST"
      });
      // 204 and no body: the loader revalidates and shows the new state.
      return { problem: null, surfaced: true };
    }

    const body = bodyFrom(PROPOSE_FIELDS, form);
    await api<{ data: Offer[] }>("/v1/dist/next-best-offers/propose", {
      env,
      request,
      method: "POST",
      body
    });
    // The proposals are rows now, so the list is the loader's job. Redirecting
    // also means a refresh re-reads them instead of proposing all over again.
    return redirect(`?customerId=${encodeURIComponent(String(body.customerId ?? ""))}`);
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, surfaced: false };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function NextBestOffers() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  const offers = loaded.offers;
  const summary = offers && offers.length > 0 ? offerSummary(offers, loaded.may.surface) : null;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link
            to="/distribution/next-best-offers"
            className="w-fit font-ui text-12 text-subtle underline-offset-2 hover:underline"
          >
            {l("backToOffers")}
          </Link>
          <h1 className="page-title">{l("title")}</h1>
          <p className="max-w-prose font-ui text-13 text-muted">
            {summary
              ? l("summary.offers", { count: String(summary.total), surfaceable: String(summary.surfaceable) })
              : l("intro")}
          </p>
        </div>
      </header>

      {!loaded.may.read ? (
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      ) : (
        <>
          {loaded.may.propose ? (
            <section aria-labelledby="propose-heading" className="flex flex-col gap-3">
              <h2 id="propose-heading" className="eyebrow">
                {l("ask")}
              </h2>
              <p className="max-w-prose font-ui text-13 text-muted">{l("askIntro")}</p>
              {result?.problem ? <Problem problem={result.problem} /> : null}
              <Form
                method="post"
                className="flex flex-col gap-4 rounded-lg border border-border p-4"
              >
                <input type="hidden" name="intent" value="propose" />
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {PROPOSE_FIELDS.map((field) => (
                    <FieldInput
                      key={field.name}
                      field={field}
                      {...(field.name === "customerId" && loaded.customerId
                        ? { row: { customerId: loaded.customerId } as Row }
                        : {})}
                      label={l}
                    />
                  ))}
                </div>
                <div>
                  <Button type="submit" loading={busy}>
                    {l("ask")}
                  </Button>
                </div>
              </Form>
            </section>
          ) : null}

          {result?.surfaced ? (
            <p role="status" className="font-ui text-13 text-success">
              {l("surfacedNow")}
            </p>
          ) : null}

          {offers === null ? (
            <EmptyState title={l("startTitle")} body={l("startBody")} />
          ) : offers.length === 0 ? (
            <EmptyState title={l("emptyTitle")} body={l("emptyBody")} />
          ) : (
            <section aria-labelledby="offers-heading" className="flex flex-col gap-3">
              <h2 id="offers-heading" className="eyebrow">
                {l("results")}
              </h2>
              {/* Ranked, not tiled: the order is the model's answer, and a grid
                  of equal boxes would throw that away. */}
              <ul className="flex flex-col divide-y divide-border border-y border-border">
                {offers.map((offer) => (
                  <li key={offer.id}>
                    <OfferRow
                      offer={offer}
                      locale={locale}
                      l={l}
                      maySurface={loaded.may.surface}
                      busy={busy}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function OfferRow({
  offer,
  locale,
  l,
  maySurface,
  busy
}: {
  offer: Offer;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
  maySurface: boolean;
  busy: boolean;
}) {
  const evidence = evidenceOf(offer.reasonJson);
  const reason = l(offer.reasonKey);
  const reasonText = reason === offer.reasonKey ? humanise(offer.reasonKey) : reason;

  return (
    <article className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="eyebrow">{optionLabel(l, "kind", offer.kind)}</h3>
          <Badge tone={toneFor(offer.state)} size="sm" dot>
            {optionLabel(l, "state", offer.state)}
          </Badge>
          {/* The single ✦ on the artifact, with its "why" one interaction away
              (CLAUDE.md §11). */}
          <AgentBadge
            {...(offer.model ? { agent: offer.model } : {})}
            why={
              <div className="flex flex-col gap-2">
                <span className="font-ui text-13 text-text">{reasonText}</span>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 font-ui text-12 text-subtle">
                  <Fragment>
                    <dt>{l("offering")}</dt>
                    <dd className="font-mono text-12 text-text">{shortRef(offer.offeringId)}</dd>
                  </Fragment>
                  {offer.runId ? (
                    <Fragment>
                      <dt>{l("run")}</dt>
                      <dd className="font-mono text-12 text-text">{shortRef(offer.runId)}</dd>
                    </Fragment>
                  ) : null}
                  {Object.entries(evidence).map(([key, value]) => (
                    <Fragment key={key}>
                      <dt>{humanise(key)}</dt>
                      <dd className="font-mono text-12 text-text">{String(value)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </div>
            }
          />
        </div>

        <p className="min-w-0 break-words font-ui text-13 text-muted">
          {offer.anchorRef ? (
            <EvidenceLink
              source={
                <span className="flex flex-col gap-1 font-ui text-12">
                  <span className="text-subtle">{l("anchor")}</span>
                  <Ref value={offer.anchorRef} className="text-12 text-text" />
                </span>
              }
              sourceLabel={l("evidence")}
            >
              {reasonText}
            </EvidenceLink>
          ) : (
            reasonText
          )}
        </p>

        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-ui text-12 text-subtle">
          {offer.expectedValueMinor !== null && offer.currency ? (
            <span className="text-text">
              {l("expectedValue")}{" "}
              <Money
                amountMinor={offer.expectedValueMinor}
                currency={offer.currency}
                locale={locale}
              />
            </span>
          ) : (
            <span>{l("noExpectedValue")}</span>
          )}
          {offer.expiresAt !== null ? (
            <span>
              {l("expires")} <DateTime value={offer.expiresAt} locale={locale} precision="day" />
            </span>
          ) : null}
          {offer.surfacedAt !== null ? (
            <span>
              {l("surfaced")}{" "}
              <DateTime value={offer.surfacedAt} locale={locale} precision="minute" />
            </span>
          ) : null}
        </p>

        {offer.suppressReason ? (
          <p className="flex flex-wrap items-baseline gap-2 font-ui text-12 text-subtle">
            <Badge tone="warning" size="sm">
              {l("suppressed")}
            </Badge>
            <span className="min-w-0">{l(`suppress.${offer.suppressReason}`)}</span>
          </p>
        ) : null}
      </div>

      <div className="flex w-full shrink-0 flex-col items-start gap-2 sm:w-56">
        <ConfidenceMeter value={offer.score / 100} label={l("matchScore")} />
        {canSurface(offer, maySurface) ? (
          <Form method="post">
            <input type="hidden" name="intent" value="surface" />
            <input type="hidden" name="offerId" value={offer.id} />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              loading={busy}
              aria-label={l("surfaceFor", { kind: optionLabel(l, "kind", offer.kind) })}
            >
              {l("surface")}
            </Button>
          </Form>
        ) : null}
      </div>
    </article>
  );
}

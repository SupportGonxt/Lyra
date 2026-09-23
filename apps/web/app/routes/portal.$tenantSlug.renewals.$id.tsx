import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Badge, Button, Card, formatInstant } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";
import { vocabulary } from "../modules/vocabulary";

// J-C3 "Renew in one tap" — orbit.md §2.2's "one-tap renewal link (hosted page,
// tenant-branded)". The person arriving here has no session and no account: the
// link's token is the whole credential, so the page shows only what the API
// hands a stranger holding that link (reference, expiry, state) and never the
// churn score, the retention strategy or the owner that decided to send it.
//
// One tap, and the tap is a decision, not a purchase. Binding cover is
// `consequential: true` (CLAUDE.md §4) and no PSP connector exists, so accepting
// records the customer's answer and stops the nudge campaign; a human confirms.
//
// No price on this page: `orbit_renewals.requotesJson` is written by nothing yet
// (the auto-requote engine is an open gap in engines/renewal-campaign.ts), and a
// renewal page that invents a number is worse than one that quotes none.

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "renewal.title": "Renew your cover",
    "renewal.intro": "Tap once to keep this cover running. Nothing is charged — we confirm with you first.",
    "renewal.reference": "Reference",
    "renewal.expiry": "Cover ends",
    "renewal.accept": "Yes, renew this",
    "renewal.accepting": "Saving…",
    "renewal.accepted.title": "Thank you — that is noted",
    "renewal.accepted.body": "One of our people will confirm the renewal with you before anything is charged.",
    "renewal.accepted.on": "Confirmed on",
    "renewal.closed.title": "This renewal is closed",
    "renewal.closed.body": "Please contact us and we will pick it up from here.",
    "renewal.expired.title": "This cover has already ended",
    "renewal.expired.body": "Please contact us and we will quote you again.",
    "renewal.error.generic": "Something went wrong. Please try again.",
    "renewal.home": "Go to our site"
  },
  ar: {
    "renewal.title": "جدّد تغطيتك",
    "renewal.intro": "اضغط مرة واحدة لاستمرار التغطية. لن يتم أي خصم — سنؤكد معك أولًا.",
    "renewal.reference": "المرجع",
    "renewal.expiry": "تنتهي التغطية",
    "renewal.accept": "نعم، جدّد",
    "renewal.accepting": "جارٍ الحفظ…",
    "renewal.accepted.title": "شكرًا لك — تم تسجيل ذلك",
    "renewal.accepted.body": "سيؤكد أحد موظفينا التجديد معك قبل أي خصم.",
    "renewal.accepted.on": "تم التأكيد في",
    "renewal.closed.title": "هذا التجديد مُغلق",
    "renewal.closed.body": "يرجى التواصل معنا وسنتابع الأمر من هنا.",
    "renewal.expired.title": "انتهت هذه التغطية بالفعل",
    "renewal.expired.body": "يرجى التواصل معنا وسنقدم لك عرضًا جديدًا.",
    "renewal.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "renewal.home": "انتقل إلى موقعنا"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

interface Renewal {
  reference: string;
  expiryAt: number;
  state: string;
  decidedAt: number | null;
}

/**
 * Which of the four faces the page wears. Pure, so the state machine is tested
 * without a browser: `accepted` beats everything (the customer already answered,
 * and re-reading their own link after expiry must still thank them), a term that
 * has run out cannot be renewed, and `lost` is the desk's own closure.
 */
export function renewalStance(renewal: Renewal, now: number): "accepted" | "closed" | "expired" | "open" {
  if (renewal.state === "accepted") return "accepted";
  if (renewal.state === "lost") return "closed";
  if (renewal.expiryAt < now) return "expired";
  return "open";
}

/** The word for the reference line: the tenant's domain pack first (a pack that
 *  sells orders must not say "policy"), this screen's own label otherwise. */
export function referenceLabel(l: (key: string) => string, pack: string | undefined, locale: string): string {
  return vocabulary(pack, locale)("policyRef") ?? l("renewal.reference");
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const [site, renewal] = await Promise.all([
    api<{ tenant: { name: string; brand: Brand; domainPack?: string } }>(`/v1/portal/${tenantSlug}/site`, {
      env,
      request
    }),
    api<Renewal>(`/v1/portal/${tenantSlug}/renewals/${params.id}?token=${encodeURIComponent(token)}`, {
      env,
      request
    })
  ]).catch(asRouteError);
  return { locale: localeFrom(request), tenantSlug, tenant: site.tenant, renewal, now: Date.now() };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? `${loaded.tenant.name} — renewal` : "" }
];

type ActionData = { ok: boolean; errorKey?: string };

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  try {
    await api(`/v1/portal/${tenantSlug}/renewals/${params.id}/accept`, {
      env,
      method: "POST",
      body: { token: String(form.get("token") ?? "") }
    });
    return { ok: true } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // 409 means the row moved under us (closed by the desk, or the term ran
    // out). Re-render from the loader rather than guess which: the reloaded
    // state picks the right face on its own.
    return {
      ok: false,
      ...(error.status === 409 ? {} : { errorKey: "renewal.error.generic" })
    } satisfies ActionData;
  }
}

export default function PortalRenewal() {
  const { locale, tenantSlug, tenant, renewal, now } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const l = labeller(locale);
  const token = searchParams.get("token") ?? "";
  const busy = navigation.state !== "idle";
  const stance = renewalStance(renewal, now);
  const date = (at: number) => formatInstant(at, new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format);

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-xl p-6">
        <header className="lyra-enter mb-8 flex flex-col gap-1">
          <h1 className="page-title">{l("renewal.title")}</h1>
          {stance === "open" ? <p className="font-ui text-13 text-muted">{l("renewal.intro")}</p> : null}
        </header>

        {result?.errorKey ? (
          <p role="alert" className="mb-4 text-13 text-danger">
            {l(result.errorKey)}
          </p>
        ) : null}

        <Card
          title={referenceLabel(l, tenant.domainPack, locale)}
          description={renewal.reference}
          actions={stance === "accepted" ? <Badge tone="success">{l("renewal.accepted.title")}</Badge> : undefined}
        >
          <p className="text-13 text-muted">{l("renewal.expiry")}</p>
          <p className="page-title">{date(renewal.expiryAt)}</p>

          {stance === "open" ? (
            <Form method="post" className="mt-6">
              <input type="hidden" name="token" value={token} />
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? l("renewal.accepting") : l("renewal.accept")}
              </Button>
            </Form>
          ) : null}

          {stance === "accepted" ? (
            <div role="status" className="mt-6 flex flex-col gap-1">
              <p className="text-14">{l("renewal.accepted.body")}</p>
              {renewal.decidedAt ? (
                <p className="text-13 text-muted">
                  {l("renewal.accepted.on")} {date(renewal.decidedAt)}
                </p>
              ) : null}
            </div>
          ) : null}

          {stance === "closed" || stance === "expired" ? (
            <div className="mt-6 flex flex-col gap-1">
              <p className="text-14">{l(`renewal.${stance}.title`)}</p>
              <p className="text-13 text-muted">{l(`renewal.${stance}.body`)}</p>
            </div>
          ) : null}
        </Card>

        <footer className="mt-10 border-t border-border pt-4 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("renewal.home")}
          </a>
        </footer>
      </div>
    </main>
  );
}

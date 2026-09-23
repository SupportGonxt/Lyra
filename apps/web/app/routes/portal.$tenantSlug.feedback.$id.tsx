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
import { Button, Card } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";

// J-C2's last step — orbit.md §5's "CSAT/NPS collection", the CSAT half. The
// page is a single tap on the 1-5 scale orbit-analytics.tsx already averages,
// opened from a messaged link after the conversation closed. NPS is absent on
// purpose: `orbit_conversations` carries one `csat` integer and no NPS column,
// and reusing that column for a second, differently-scaled question would
// poison the KPI the same screen reports (orbit.md §7 "CSAT ≥ 4.5").
//
// The link holder is authenticated as nobody, so the page shows nothing about
// the conversation: no transcript, no AI summary, no agent name. Only whether it
// can still be rated.

export const SCALE_MAX = 5;

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "csat.title": "How did we do?",
    "csat.intro": "One tap, and you are done. 1 is poor, 5 is excellent.",
    "csat.rating": "Your rating",
    "csat.rate": "Rate {n} out of {max}",
    "csat.sending": "Saving…",
    "csat.done.title": "Thank you",
    "csat.done.body": "Your rating is with the team that helped you.",
    "csat.rated": "You rated this {n} out of {max}.",
    "csat.unavailable.title": "This is not open for feedback",
    "csat.unavailable.body": "The conversation may still be running, or you may have rated it already.",
    "csat.error.generic": "Something went wrong. Please try again.",
    "csat.home": "Go to our site"
  },
  ar: {
    "csat.title": "كيف كان أداؤنا؟",
    "csat.intro": "ضغطة واحدة وتنتهي. 1 ضعيف، 5 ممتاز.",
    "csat.rating": "تقييمك",
    "csat.rate": "قيّم {n} من {max}",
    "csat.sending": "جارٍ الحفظ…",
    "csat.done.title": "شكرًا لك",
    "csat.done.body": "وصل تقييمك إلى الفريق الذي ساعدك.",
    "csat.rated": "لقد قيّمت هذا {n} من {max}.",
    "csat.unavailable.title": "هذا غير متاح للتقييم",
    "csat.unavailable.body": "قد تكون المحادثة ما زالت جارية، أو ربما قيّمتها بالفعل.",
    "csat.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "csat.home": "انتقل إلى موقعنا"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

interface Feedback {
  ratable: boolean;
  rating: number | null;
  scaleMax: number;
  closedAt: number | null;
}

/**
 * The scale the page draws. Taken from the API's own `scaleMax` so the buttons
 * cannot drift from the column the analytics screen averages, and clamped
 * because a corrupt or absent value must still render a usable page.
 */
export function csatScale(scaleMax: number): number[] {
  const max = Number.isInteger(scaleMax) && scaleMax >= 2 && scaleMax <= 10 ? scaleMax : SCALE_MAX;
  return Array.from({ length: max }, (_, i) => i + 1);
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const [site, feedback] = await Promise.all([
    api<{ tenant: { name: string; brand: Brand } }>(`/v1/portal/${tenantSlug}/site`, { env, request }),
    api<Feedback>(`/v1/portal/${tenantSlug}/feedback/${params.id}?token=${encodeURIComponent(token)}`, {
      env,
      request
    })
  ]).catch(asRouteError);
  return { locale: localeFrom(request), tenantSlug, tenant: site.tenant, feedback };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? `${loaded.tenant.name} — feedback` : "" }
];

type ActionData = { ok: boolean; errorKey?: string };

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  try {
    await api(`/v1/portal/${tenantSlug}/feedback/${params.id}`, {
      env,
      method: "POST",
      body: { token: String(form.get("token") ?? ""), rating: Number(form.get("rating")) }
    });
    return { ok: true } satisfies ActionData;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // 409 is "already rated" or "still open" — the reloaded state says which,
    // and either way the answer is the unavailable face, not an error banner.
    return {
      ok: false,
      ...(error.status === 409 ? {} : { errorKey: "csat.error.generic" })
    } satisfies ActionData;
  }
}

export default function PortalFeedback() {
  const { locale, tenantSlug, tenant, feedback } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const l = labeller(locale);
  const token = searchParams.get("token") ?? "";
  const busy = navigation.state !== "idle";
  const scale = csatScale(feedback.scaleMax);
  const max = scale.length;
  const fill = (key: string, n: number) => l(key).replace("{n}", String(n)).replace("{max}", String(max));

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-xl p-6">
        <header className="lyra-enter mb-8 flex flex-col gap-1">
          <h1 className="page-title">{l("csat.title")}</h1>
          {feedback.ratable ? <p className="font-ui text-13 text-muted">{l("csat.intro")}</p> : null}
        </header>

        {result?.errorKey ? (
          <p role="alert" className="mb-4 text-13 text-danger">
            {l(result.errorKey)}
          </p>
        ) : null}

        {feedback.ratable ? (
          <Card title={l("csat.rating")}>
            <Form method="post" className="flex flex-wrap gap-2">
              <input type="hidden" name="token" value={token} />
              {scale.map((n) => (
                <Button
                  key={n}
                  type="submit"
                  name="rating"
                  value={n}
                  variant="secondary"
                  loading={busy}
                  // The digit alone is not a name a screen reader can act on.
                  aria-label={fill("csat.rate", n)}
                >
                  {new Intl.NumberFormat(locale).format(n)}
                </Button>
              ))}
            </Form>
            {busy ? (
              <p role="status" className="mt-3 text-13 text-muted">
                {l("csat.sending")}
              </p>
            ) : null}
          </Card>
        ) : feedback.rating !== null ? (
          <Card title={l("csat.done.title")}>
            <p role="status" className="text-14">
              {l("csat.done.body")}
            </p>
            <p className="mt-1 text-13 text-muted">{fill("csat.rated", feedback.rating)}</p>
          </Card>
        ) : (
          <Card title={l("csat.unavailable.title")}>
            <p className="text-14">{l("csat.unavailable.body")}</p>
          </Card>
        )}

        <footer className="mt-10 border-t border-border pt-4 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("csat.home")}
          </a>
        </footer>
      </div>
    </main>
  );
}

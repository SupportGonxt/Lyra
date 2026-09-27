import { useEffect, useRef } from "react";
import {
  Form,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction
} from "react-router";
import { Button, Card, Field, Input, Textarea } from "@lyra/ui";
import { cloudflare } from "../context";
import { ApiError, api, asRouteError, type Brand } from "../api.server";
import { DEFAULT_LOCALE, localeFrom, pseudoText } from "../i18n";
import { brandStyle } from "../components/shell";
import { Turnstile } from "../components/turnstile";

// docs/30 ORBIT 4, ADR-0099: web chat on the public storefront. A stranger with
// no session writes to the tenant's team; the line lands in the ORBIT inbox
// through the `lyra-webchat` ChannelAdapter, and replies come back on the next
// poll. The visitor token the API mints on the first line is the only
// credential the conversation has, so it lives in an HttpOnly cookie scoped to
// this page and reaches the API as a header from the loader — page script never
// sees it and it never sits in a URL.

export const VISITOR_COOKIE = "lyra_chat";
/** The API allows 600 polls per 10 minutes per IP (routes/portal.ts), room for a few tabs at this pace. */
export const POLL_MS = 5000;
const COOKIE_MAX_AGE_SEC = 30 * 24 * 60 * 60;
const VISITOR_HEADER = "x-lyra-visitor";

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    "chat.title": "Chat with us",
    "chat.intro": "Write to our team here. Keep this page open and replies appear below.",
    "chat.transcript": "Conversation",
    "chat.empty": "No messages yet. Say hello and a member of the team will answer here.",
    "chat.you": "You",
    "chat.team": "Our team",
    "chat.name": "Your name",
    "chat.message": "Your message",
    "chat.send": "Send",
    "chat.sending": "Sending…",
    "chat.error.validation": "Please add your name and a message.",
    "chat.error.throttled": "That was a lot of messages at once. Please wait a few minutes and try again.",
    "chat.error.challenge": "We could not confirm you are not a bot. Please try again.",
    "chat.error.generic": "Something went wrong. Please try again.",
    "chat.unavailable.title": "Chat is not open",
    "chat.unavailable.body": "This team is not taking chat messages right now.",
    "chat.home": "Go to our site"
  },
  ar: {
    "chat.title": "تحدّث معنا",
    "chat.intro": "اكتب إلى فريقنا هنا. أبقِ هذه الصفحة مفتوحة وستظهر الردود أدناه.",
    "chat.transcript": "المحادثة",
    "chat.empty": "لا توجد رسائل بعد. ألقِ التحية وسيرد عليك أحد أعضاء الفريق هنا.",
    "chat.you": "أنت",
    "chat.team": "فريقنا",
    "chat.name": "اسمك",
    "chat.message": "رسالتك",
    "chat.send": "إرسال",
    "chat.sending": "جارٍ الإرسال…",
    "chat.error.validation": "يرجى إضافة اسمك ورسالة.",
    "chat.error.throttled": "أرسلت رسائل كثيرة دفعة واحدة. يرجى الانتظار بضع دقائق ثم المحاولة مرة أخرى.",
    "chat.error.challenge": "تعذّر التأكد من أنك لست برنامجًا آليًا. حاول مرة أخرى.",
    "chat.error.generic": "حدث خطأ ما. حاول مرة أخرى.",
    "chat.unavailable.title": "الدردشة غير متاحة",
    "chat.unavailable.body": "لا يستقبل هذا الفريق رسائل الدردشة حاليًا.",
    "chat.home": "انتقل إلى موقعنا"
  }
};

function labeller(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS[DEFAULT_LOCALE];
  return (key) => pseudoText(locale, table?.[key] ?? LABELS[DEFAULT_LOCALE]?.[key] ?? key);
}

/** The visitor cookie, scoped to this tenant's chat page and unreadable to script. */
export function visitorCookie(tenantSlug: string, token: string, opts: { secure: boolean }): string {
  return [
    `${VISITOR_COOKIE}=${token}`,
    `Path=/portal/${encodeURIComponent(tenantSlug)}/chat`,
    `Max-Age=${COOKIE_MAX_AGE_SEC}`,
    "HttpOnly",
    "SameSite=Lax",
    ...(opts.secure ? ["Secure"] : [])
  ].join("; ");
}

export function visitorFrom(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === VISITOR_COOKIE) return rest.join("=") || null;
  }
  return null;
}

/** Mirrors `ChatLine` in apps/api/src/routes/portal.ts §web chat. */
interface ChatLine {
  id: string;
  from: "visitor" | "agent";
  text: string;
  at: number;
}

/** The part of `GET /v1/portal/{tenantSlug}/site` this page reads. */
interface Site {
  tenant: { name: string; brand: Brand };
  chat?: boolean;
}

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const site = await api<Site>(`/v1/portal/${tenantSlug}/site`, { env, request }).catch(asRouteError);
  const base = {
    locale: localeFrom(request),
    tenantSlug,
    tenant: site.tenant,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null
  };
  if (!site.chat) return { ...base, open: false, messages: [] as ChatLine[] };

  const token = visitorFrom(request.headers.get("cookie"));
  const chat = await api<{ messages: ChatLine[] }>(`/v1/portal/${tenantSlug}/chat`, {
    env,
    request,
    ...(token ? { headers: { [VISITOR_HEADER]: token } } : {})
  }).catch((error: unknown) => {
    // Switched off between the two calls: the same face as never switched on.
    if (error instanceof ApiError && error.status === 404) return null;
    return asRouteError(error);
  });
  return { ...base, open: chat !== null, messages: chat?.messages ?? [] };
}

export const meta: MetaFunction<typeof loader> = ({ loaderData: loaded }) => [
  { title: loaded ? loaded.tenant.name : "" }
];

type ActionData = { ok: boolean; errorKey?: string };

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const tenantSlug = params.tenantSlug!;
  const form = await request.formData();
  const token = visitorFrom(request.headers.get("cookie"));
  const name = String(form.get("name") ?? "").trim();
  try {
    const sent = await api<{ visitorToken: string }>(`/v1/portal/${tenantSlug}/chat/messages`, {
      env,
      method: "POST",
      ...(token ? { headers: { [VISITOR_HEADER]: token } } : {}),
      body: {
        text: String(form.get("text") ?? "").trim(),
        ...(name ? { name } : {}),
        ...(form.get("cf-turnstile-response") ? { turnstileToken: String(form.get("cf-turnstile-response")) } : {})
      }
    });
    const secure = new URL(request.url).protocol === "https:";
    return data({ ok: true } satisfies ActionData, {
      headers: { "set-cookie": visitorCookie(tenantSlug, sent.visitorToken, { secure }) }
    });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const errorKey =
      error.status === 429
        ? "chat.error.throttled"
        : error.status === 403
          ? "chat.error.challenge"
          : error.status === 400
            ? "chat.error.validation"
            : "chat.error.generic";
    return { ok: false, errorKey } satisfies ActionData;
  }
}

export default function PortalChat() {
  const { locale, tenantSlug, tenant, open, messages, turnstileSiteKey } = useLoaderData<typeof loader>();
  const result = useActionData<ActionData>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const formRef = useRef<HTMLFormElement>(null);
  const l = labeller(locale);
  const busy = navigation.state !== "idle";
  const started = messages.length > 0;
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });

  // A reply lands on the next loader run. Only poll a conversation that exists
  // and a tab someone is looking at.
  useEffect(() => {
    if (!open || !started) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && revalidator.state === "idle") void revalidator.revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [open, started, revalidator]);

  useEffect(() => {
    if (result?.ok && navigation.state === "idle") formRef.current?.reset();
  }, [result, navigation.state]);

  return (
    <main style={brandStyle(tenant.brand)} className="lyra-field min-h-screen bg-bg text-text">
      <div className="mx-auto max-w-xl p-6">
        <header className="lyra-enter mb-8 flex flex-col gap-1">
          <h1 className="page-title">{l("chat.title")}</h1>
          {open ? <p className="font-ui text-13 text-muted">{l("chat.intro")}</p> : null}
        </header>

        {!open ? (
          <Card title={l("chat.unavailable.title")}>
            <p className="text-14">{l("chat.unavailable.body")}</p>
          </Card>
        ) : (
          <div className="flex flex-col gap-4">
            <Card title={l("chat.transcript")}>
              {started ? (
                <ol role="log" aria-live="polite" aria-label={l("chat.transcript")} className="flex flex-col gap-3">
                  {messages.map((m) => (
                    <li
                      key={m.id}
                      className={
                        m.from === "visitor"
                          ? "ms-auto max-w-[85%] rounded-md bg-accent/10 px-3 py-2"
                          : "me-auto max-w-[85%] rounded-md border border-border px-3 py-2"
                      }
                    >
                      <p className="text-12 text-muted">
                        {m.from === "visitor" ? l("chat.you") : l("chat.team")} · {time.format(m.at)}
                      </p>
                      <p className="whitespace-pre-wrap text-14">{m.text}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-13 text-muted">{l("chat.empty")}</p>
              )}
            </Card>

            {result?.errorKey ? (
              <p role="alert" className="text-13 text-danger">
                {l(result.errorKey)}
              </p>
            ) : null}

            <Form ref={formRef} method="post" className="flex flex-col gap-3">
              {started ? null : (
                <Field label={l("chat.name")} id="chat-name" required>
                  <Input name="name" autoComplete="name" maxLength={200} required />
                </Field>
              )}
              <Field label={l("chat.message")} id="chat-message" required>
                <Textarea name="text" rows={3} maxLength={2000} required />
              </Field>
              {started ? null : <Turnstile siteKey={turnstileSiteKey} locale={locale} />}
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? l("chat.sending") : l("chat.send")}
              </Button>
            </Form>
          </div>
        )}

        <footer className="mt-10 border-t border-border pt-4 text-13">
          <a className="text-accent underline" href={`/portal/${tenantSlug}`}>
            {l("chat.home")}
          </a>
        </footer>
      </div>
    </main>
  );
}

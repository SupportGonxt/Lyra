import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, Card, EmptyState, Field, PageHeader, Select, type BadgeTone } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { labelsFrom, rowsOf, type Page } from "./detail-kit";
import { Problem } from "./module";
import { useOrbitSessionData } from "./orbit-shell";

// docs/modules/orbit.md §4 screen 7 — ORBIT Dev. Four of the five bullets
// already have homes and are linked, not rebuilt: API keys and the webhook
// tester are /admin/developer, and the embedded flow is the customer portal
// itself. What has no home is the conversation simulator: a scripted persona
// (Arabic included) pushed through the real AgentRoom turn endpoint and the
// real drafting sweep, so an integrator can watch the agent answer without a
// live channel, a BSP number or a real customer on the other end.
//
// ponytail: the personas are literal, not i18n keys. An Arabic persona types
// Arabic whatever language the console is in — that is the point of having
// one — so these are fixtures, not UI copy.

/* --------------------------------------------------------------- contract */

export const PERM = {
  simulate: "orbit:messages:send",
  open: "orbit:conversations:reply",
  read: "orbit:messages:read"
} as const;

export interface Persona {
  key: string;
  lang: "en" | "ar";
  channel: string;
  lines: readonly string[];
}

export const PERSONAS: readonly Persona[] = [
  {
    key: "renewal",
    lang: "en",
    channel: "whatsapp",
    lines: [
      "Hi, I got a message saying my cover expires next month.",
      "Can you tell me what it costs to keep it going? Nothing has changed on my side."
    ]
  },
  {
    key: "claim",
    lang: "ar",
    channel: "whatsapp",
    lines: [
      "السلام عليكم، تعرضت لحادث بسيط صباح اليوم ولا أعرف ما الخطوة التالية.",
      "السيارة تسير لكن المصد الأمامي متضرر. هل أحتاج تقرير شرطة؟"
    ]
  },
  {
    key: "angry",
    lang: "en",
    channel: "email",
    lines: [
      "This is the third time I am asking about the same refund and nobody has come back to me.",
      "If I do not hear something today I am cancelling everything."
    ]
  }
];

export interface MessageRow {
  id: string;
  role: string;
  content: string;
  deliveryStatus?: string | null;
  ts?: number | null;
}

export interface Outcome {
  customer: number;
  agent: number;
  /** A trailing `agent_ai` turn with no delivery status is a pending draft —
   *  the same rule routes/conversation.tsx renders approve/discard on. */
  drafted: boolean;
}

export function outcomeOf(rows: readonly MessageRow[]): Outcome {
  const last = rows[rows.length - 1];
  return {
    customer: rows.filter((row) => row.role === "customer").length,
    agent: rows.filter((row) => row.role === "agent_ai" || row.role === "agent_human").length,
    drafted: last?.role === "agent_ai" && !last.deliveryStatus
  };
}

export const personaOf = (key: string): Persona | undefined => PERSONAS.find((p) => p.key === key);

/* ------------------------------------------------------------------ labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Conversation simulator",
    intro:
      "Runs a scripted customer through the real agent room and the real drafting sweep. Nothing is sent to anyone — the reply comes back as a draft, exactly as it would on a live channel.",
    deniedTitle: "You cannot run the simulator",
    persona: "Persona",
    "persona.renewal": "Renewal question (English, WhatsApp)",
    "persona.claim": "Motor accident (Arabic, WhatsApp)",
    "persona.angry": "Chasing a refund (English, email)",
    run: "Run the script",
    scriptTitle: "What the customer says",
    resultTitle: "Transcript",
    turns: "{customer} from the customer · {agent} from the agent",
    drafted: "A reply was drafted",
    noDraft: "No reply was drafted",
    noDraftWhy:
      "The drafting sweep only writes a reply when a drafting agent is active for this tenant. Check the agents tab.",
    openThread: "Open this conversation",
    role: "Role",
    "role.customer": "Customer",
    "role.agent_ai": "Agent (AI)",
    "role.agent_human": "Agent",
    "role.system": "System",
    linksTitle: "The rest of the developer surface",
    devLink: "API keys and the webhook tester",
    portalLink: "The embedded customer flow",
    searchLink: "Search transcripts",
    searchHint: "Message bodies are searchable only for people who may read them unmasked."
  },
  ar: {
    title: "محاكي المحادثات",
    intro:
      "يشغّل عميلاً مكتوباً مسبقاً عبر غرفة الوكيل الحقيقية ومسح الصياغة الحقيقي. لا يُرسل شيء إلى أحد — يعود الرد كمسودة، تماماً كما في قناة حقيقية.",
    deniedTitle: "لا يمكنك تشغيل المحاكي",
    persona: "الشخصية",
    "persona.renewal": "سؤال عن التجديد (إنجليزي، واتساب)",
    "persona.claim": "حادث مركبة (عربي، واتساب)",
    "persona.angry": "متابعة استرداد مبلغ (إنجليزي، بريد)",
    run: "شغّل النص",
    scriptTitle: "ما يقوله العميل",
    resultTitle: "نص المحادثة",
    turns: "{customer} من العميل · {agent} من الوكيل",
    drafted: "تمت صياغة رد",
    noDraft: "لم تتم صياغة رد",
    noDraftWhy: "لا يكتب مسح الصياغة رداً إلا عند وجود وكيل صياغة نشط لهذه المؤسسة. راجع تبويب الوكلاء.",
    openThread: "افتح هذه المحادثة",
    role: "الدور",
    "role.customer": "العميل",
    "role.agent_ai": "الوكيل (ذكاء اصطناعي)",
    "role.agent_human": "الوكيل",
    "role.system": "النظام",
    linksTitle: "بقية أدوات المطوّرين",
    devLink: "مفاتيح الواجهة البرمجية واختبار الويب هوك",
    portalLink: "تدفّق العميل المدمج",
    searchLink: "ابحث في نصوص المحادثات",
    searchHint: "نصوص الرسائل قابلة للبحث فقط لمن يحق له قراءتها دون إخفاء."
  }
};

export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  return {
    may: { simulate: held.has(PERM.simulate) && held.has(PERM.open) && held.has(PERM.read) },
    tenantSlug: me.tenant.slug
  };
}

/* ------------------------------------------------------------------ action */

interface Ran {
  problem: unknown;
  conversationId: string | null;
  rows: MessageRow[];
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const persona = personaOf(String(form.get("persona") ?? ""));
  if (!persona) return { problem: null, conversationId: null, rows: [] } satisfies Ran;

  try {
    const conversation = await api<{ id: string }>("/v1/orbit/conversations", {
      env,
      request,
      method: "POST",
      body: { channel: persona.channel, lang: persona.lang, state: "bot" }
    });

    // Sequential on purpose: a transcript is ordered, and the room stamps each
    // turn as it arrives.
    for (const content of persona.lines) {
      await api(`/v1/orbit/conversations/${conversation.id}/turns`, {
        env,
        request,
        method: "POST",
        body: { role: "customer", content }
      });
    }

    // ponytail: one sweep after the whole script, not one per line. The sweep
    // is tenant-wide and costs a model call per conversation it touches; a
    // per-line sweep would be a truer simulation of a live back-and-forth at
    // several times the spend. Loop it if a multi-turn agent is what is being
    // tested.
    await api("/v1/orbit/drafts/sweep", { env, request, method: "POST", body: {} });

    const page = await api<Page<MessageRow>>(
      `/v1/orbit/messages?conversationId=${conversation.id}&sort=ts&order=asc&limit=50`,
      { env, request }
    );

    return { problem: null, conversationId: conversation.id, rows: rowsOf(page) } satisfies Ran;
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, conversationId: null, rows: [] } satisfies Ran;
    throw error;
  }
}

/* --------------------------------------------------------------- component */

const TONES: Record<string, BadgeTone> = { customer: "neutral", agent_ai: "info", agent_human: "success" };

export default function OrbitDev() {
  const loaded = useLoaderData<typeof loader>();
  const ran = useActionData<typeof action>();
  const shell = useOrbitSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale, shell?.overrides);
  const l = labelsIn(locale, shell?.domainPack);
  const busy = navigation.state !== "idle";
  const outcome = ran ? outcomeOf(ran.rows) : null;

  if (!loaded.may.simulate) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={l("title")} description={l("intro")} />

      {ran?.problem ? <Problem problem={ran.problem} /> : null}

      <Card className="flex flex-col gap-4 p-4">
        <Form method="post" className="flex flex-wrap items-end gap-3">
          <Field label={l("persona")} className="min-w-64">
            <Select
              name="persona"
              defaultValue={PERSONAS[0]?.key ?? ""}
              options={PERSONAS.map((persona) => ({ value: persona.key, label: l(`persona.${persona.key}`) }))}
            />
          </Field>
          <Button type="submit" variant="primary" loading={busy}>
            {l("run")}
          </Button>
        </Form>

        <section className="flex flex-col gap-2">
          <h2 className="eyebrow">{l("scriptTitle")}</h2>
          <ul className="flex flex-col gap-2">
            {PERSONAS.map((persona) => (
              <li key={persona.key} className="flex flex-col gap-1">
                <span className="font-ui text-12 text-subtle">{l(`persona.${persona.key}`)}</span>
                {persona.lines.map((line) => (
                  <p
                    key={line}
                    lang={persona.lang}
                    dir={persona.lang === "ar" ? "rtl" : "ltr"}
                    className="font-ui text-13 text-muted"
                  >
                    {line}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      </Card>

      {ran && ran.rows.length > 0 && outcome ? (
        <Card className="flex flex-col gap-3 p-4">
          <header className="flex flex-wrap items-center gap-3">
            <h2 className="eyebrow">{l("resultTitle")}</h2>
            <span className="font-ui text-12 text-subtle">
              {l("turns", { customer: String(outcome.customer), agent: String(outcome.agent) })}
            </span>
            <Badge tone={outcome.drafted ? "success" : "warning"} size="sm">
              {outcome.drafted ? l("drafted") : l("noDraft")}
            </Badge>
          </header>

          {!outcome.drafted ? <p className="font-ui text-12 text-muted">{l("noDraftWhy")}</p> : null}

          <ol className="flex flex-col gap-3">
            {ran.rows.map((row) => (
              <li key={row.id} className="flex flex-col gap-1">
                <Badge tone={TONES[row.role] ?? "neutral"} size="sm">
                  {l(`role.${row.role}`)}
                </Badge>
                <p className="whitespace-pre-wrap font-ui text-13 text-text">{row.content}</p>
              </li>
            ))}
          </ol>

          {ran.conversationId ? (
            <Link
              to={`/orbit/conversations/${ran.conversationId}/thread`}
              className="font-ui text-13 text-accent underline underline-offset-2"
            >
              {l("openThread")}
            </Link>
          ) : null}
        </Card>
      ) : null}

      <Card className="flex flex-col gap-2 p-4">
        <h2 className="eyebrow">{l("linksTitle")}</h2>
        <Link to="/admin/developer" className="font-ui text-13 text-accent underline underline-offset-2">
          {l("devLink")}
        </Link>
        <Link to={`/portal/${loaded.tenantSlug}`} className="font-ui text-13 text-accent underline underline-offset-2">
          {l("portalLink")}
        </Link>
        <Link to="/search/results" className="font-ui text-13 text-accent underline underline-offset-2">
          {l("searchLink")}
        </Link>
        <p className="font-ui text-12 text-subtle">{l("searchHint")}</p>
      </Card>
    </div>
  );
}

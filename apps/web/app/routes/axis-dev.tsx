import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { AgentBadge, Button, EmptyState } from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { FieldInput } from "../components/fields";
import { cloudflare } from "../context";
import { pseudoText, translator } from "../i18n";
import { bodyFrom, type FieldSpec } from "../modules/spec";
import { Problem } from "./module";
import { useAxisSessionData } from "./axis-shell";

// docs/20 developer console "extraction playground". Runs the exact prompt
// apps/api/src/routes/axis.ts's /documents/:id/extract uses, minus a document
// row, so an integrator can check a field schema against sample text before
// wiring a real upload.

const PERM = { sandbox: "dev:sandbox:use" } as const;

/** SampleExtractBody, apps/api/src/routes/axis.ts. */
const FIELDS: readonly FieldSpec[] = [
  { name: "docType", type: "select", options: ["eid", "mulkiya"], required: true },
  { name: "locale", type: "select", options: ["en", "ar"], required: true },
  { name: "rawText", type: "textarea", required: true, hintKey: "rawTextHint" }
];

interface Result {
  values: Record<string, string>;
  confidence: number;
  model: string;
}

/* ----------------------------------------------------------------- labels */

const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Extraction playground",
    intro: "Runs the real document-extraction prompt on sample text, without a document to attach it to.",
    deniedTitle: "You cannot use the sandbox",
    docType: "Document type",
    "docType.eid": "Emirates ID",
    "docType.mulkiya": "Mulkiya",
    locale: "Locale",
    "locale.en": "English",
    "locale.ar": "Arabic",
    rawText: "Sample text",
    rawTextHint: "Paste OCR'd text as if it came off a real document.",
    extract: "Extract fields",
    resultsTitle: "Extracted fields",
    confidence: "Confidence",
    model: "Model",
    devLinkTitle: "Webhooks and API keys",
    devLink: "Open the developer portal"
  },
  ar: {
    title: "بيئة تجربة الاستخراج",
    intro: "تُشغّل طلب استخراج المستندات الحقيقي على نص تجريبي، دون مستند تُرفق به.",
    deniedTitle: "لا يمكنك استخدام بيئة التجربة",
    docType: "نوع المستند",
    "docType.eid": "هوية إماراتية",
    "docType.mulkiya": "ملكية",
    locale: "اللغة",
    "locale.en": "الإنجليزية",
    "locale.ar": "العربية",
    rawText: "نص تجريبي",
    rawTextHint: "الصق نصًا كما لو أنه استُخرج من مستند حقيقي.",
    extract: "استخرج الحقول",
    resultsTitle: "الحقول المستخرجة",
    confidence: "درجة الثقة",
    model: "النموذج",
    devLinkTitle: "الويب هوك ومفاتيح الواجهة البرمجية",
    devLink: "افتح بوابة المطوّرين"
  }
};

function labelsIn(locale: string): (key: string, vars?: Record<string, string>) => string {
  const table = LABELS[locale] ?? LABELS.en ?? {};
  const fallback = LABELS.en ?? {};
  const t = translator(locale);
  return (key, vars) => {
    const local = table[key] ?? fallback[key];
    // `t()` pseudoizes on its own; only the route's own table needs the wrap.
    const shared = local === undefined ? t(`common.${key}`) : pseudoText(locale, local);
    const raw = shared === `common.${key}` ? key : shared;
    return vars ? raw.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match) : raw;
  };
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const may = { sandbox: me.permissions.includes(PERM.sandbox) };
  return { may };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const body = bodyFrom(FIELDS, form);

  try {
    const result = await api<Result>("/v1/axis/dev/extract-sample", { env, request, method: "POST", body });
    return { problem: null, result };
  } catch (error) {
    if (error instanceof ApiError) return { problem: error.problem, result: null };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function AxisDev() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useAxisSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-prose font-ui text-13 text-muted">{l("intro")}</p>
      </header>

      {!loaded.may.sandbox ? (
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      ) : (
        <>
          {result?.problem ? <Problem problem={result.problem} /> : null}

          <Form method="post" className="flex flex-col gap-4 rounded-lg border border-border p-4">
            {FIELDS.map((field) => (
              <FieldInput key={field.name} field={field} label={l} />
            ))}
            <div>
              <Button type="submit" loading={busy}>
                {l("extract")}
              </Button>
            </div>
          </Form>

          {result?.result ? (
            <section aria-labelledby="results-heading" className="flex flex-col gap-3 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="results-heading" className="eyebrow">
                  {l("resultsTitle")}
                </h2>
                {/* F54: this is a model's finding, so it carries the single ✦
                    with its "why" one interaction away (CLAUDE.md §11) — the
                    model and confidence are the provenance, not plain text. */}
                <AgentBadge
                  agent={result.result.model}
                  why={
                    <span className="font-ui text-13 text-text">
                      {l("confidence")}: {result.result.confidence}%
                    </span>
                  }
                />
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-ui text-13">
                {Object.entries(result.result.values).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-subtle">{key}</dt>
                    <dd className="text-text">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ) : null}

          <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
            <h2 className="eyebrow">{l("devLinkTitle")}</h2>
            <Link to="/admin/developer" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("devLink")}
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

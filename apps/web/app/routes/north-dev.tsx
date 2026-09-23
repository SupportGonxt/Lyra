import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Table, type Column } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import {
  labelsFrom,
  metricName,
  readable,
  refuse,
  refused,
  type ActionResult,
  type Labels,
  type Metric,
  type Page,
  type Snapshot
} from "./north-shared";

// NORTH dev (docs/modules/north.md §4 screen 8): the integrator's bench. The
// query console runs the real /v1/north/explore — fixed columns over the
// semantic layer, never a client SQL string (§2.1) — so what an integrator
// tests here is exactly what their code will get.

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:snapshots:read",
  metrics: "north:metrics:read",
  run: "north:snapshots:run",
  keys: "core:api_keys:read"
} as const;

// ponytail: day and month only. The snapshotter writes those two grains
// (apps/api/src/engines/north-snapshotter.ts periodsFor); offering `week` here
// would hand an integrator an empty result and no reason for it.
const GRAINS = ["day", "month"] as const;
type Grain = (typeof GRAINS)[number];

const DAY = 86_400_000;
const MAX_KEYS = 20;

/** The events NORTH publishes; a webhook subscribes to these by name. */
const TOPICS = ["north.alert.triggered", "north.briefing.generated", "north.boardpack.generated"] as const;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Insight dev",
    kicker: "The integrator's bench",
    intro:
      "Run the real metric query, trigger a snapshot ahead of the nightly window, and read the contract your code will hold to. Nothing here is a mock — the console calls the same endpoint your integration will.",
    "query.eyebrow": "Query console",
    "query.lede":
      "POST /v1/north/explore reads the snapshot layer by metric key, grain and period. There is no SQL parameter by design: the semantic layer is the only definition of a number.",
    "query.metrics": "Metrics",
    "query.metrics.hint": "Up to {max} keys in one call.",
    "query.grain": "Grain",
    "query.period": "Period",
    "query.period.hint": "A day is YYYY-MM-DD, a month is YYYY-MM. Prefilled with the last period the snapshotter would have closed.",
    "query.run": "Run the query",
    "query.rows": "Rows returned",
    "query.caption": "Snapshot rows returned by the query",
    "query.empty": "No row matches that metric, grain and period.",
    "query.empty.body": "Nothing is broken — the snapshotter has simply not written that period yet. Widen the period or pick another grain.",
    "query.raw": "Response body",
    "col.metric": "Metric key",
    "col.period": "Period",
    "col.value": "Value",
    "col.ts": "Written at",
    "grain.day": "Day",
    "grain.month": "Month",
    "snap.eyebrow": "Snapshotter",
    "snap.lede":
      "Snapshots run nightly at 02:00 UTC. Running it here writes the same rows for the same periods — it is idempotent, so a second run overwrites rather than duplicates.",
    "snap.run": "Run the snapshotter now",
    "snap.written": "{written} rows written, {anomalies} anomalies raised, {alerts} alert rules triggered.",
    "curl.eyebrow": "The same call from your code",
    "curl.lede": "The console above sends exactly this. Mint the key in the developer portal — it is never shown here.",
    "curl.keys": "Open the developer portal",
    "hooks.eyebrow": "Webhooks",
    "hooks.lede": "Insight publishes these events. Subscribe an endpoint to one in the developer portal and every payload arrives signed.",
    "sandbox.eyebrow": "Sandbox",
    "sandbox.lede":
      "The demo tenant carries a deterministic synthetic dataset — the same fixtures every environment is seeded from, so a query written against it behaves the same on staging and in production.",
    "sandbox.open": "Open the metric explorer",
    denied: "You do not have permission to read the snapshot layer. Ask a tenant administrator for Insight access.",
    "headline.denied": "You do not have access to the snapshot layer.",
    "headline.empty": "Nothing to query yet — no metric is registered.",
    "headline.action": "Register a metric",
    "headline.ready": "{count} metrics ready to query.",
    "saved.query": "Query ran.",
    "saved.snapshot": "Snapshotter run.",
    approvalTitle: "Queued for approval",
    approvalBody: "This action needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_metric": "Pick at least one metric to query.",
    "problem.too_many": "That is more than the twenty keys one call carries. Query them in two.",
    "problem.bad_grain": "That grain is not one the snapshotter writes.",
    "problem.bad_period": "That period does not match the grain: a day is YYYY-MM-DD, a month is YYYY-MM.",
    "problem.bad_intent": "That form did not carry a recognised action."
  },
  ar: {
    title: "مطوّرو التحليلات التنفيذية",
    kicker: "منضدة المتكامِل",
    intro:
      "شغّل استعلام المقاييس الحقيقي، وخذ لقطة قبل نافذة الليل، واقرأ العقد الذي سيلتزم به كودك. لا شيء هنا محاكاة — الوحدة تنادي نفس نقطة النهاية التي سيناديها تكاملك.",
    "query.eyebrow": "وحدة الاستعلام",
    "query.lede":
      "‏POST /v1/north/explore يقرأ طبقة اللقطات بمفتاح المقياس والحبيبة والفترة. لا يوجد وسيط SQL عن قصد: الطبقة الدلالية هي التعريف الوحيد للرقم.",
    "query.metrics": "المقاييس",
    "query.metrics.hint": "حتى {max} مفتاحاً في النداء الواحد.",
    "query.grain": "الحبيبة",
    "query.period": "الفترة",
    "query.period.hint": "اليوم بصيغة YYYY-MM-DD والشهر بصيغة YYYY-MM. مُعبّأ مسبقاً بآخر فترة كان المُلقِط ليغلقها.",
    "query.run": "شغّل الاستعلام",
    "query.rows": "الصفوف المُعادة",
    "query.caption": "صفوف اللقطات التي أعادها الاستعلام",
    "query.empty": "لا صف يطابق هذا المقياس والحبيبة والفترة.",
    "query.empty.body": "لا شيء معطّل — المُلقِط ببساطة لم يكتب تلك الفترة بعد. وسّع الفترة أو اختر حبيبة أخرى.",
    "query.raw": "جسم الاستجابة",
    "col.metric": "مفتاح المقياس",
    "col.period": "الفترة",
    "col.value": "القيمة",
    "col.ts": "وقت الكتابة",
    "grain.day": "يوم",
    "grain.month": "شهر",
    "snap.eyebrow": "المُلقِط",
    "snap.lede":
      "تعمل اللقطات ليلاً عند 02:00 بتوقيت UTC. تشغيله هنا يكتب الصفوف نفسها للفترات نفسها — وهو مُتماثل، فالتشغيل الثاني يستبدل ولا يكرّر.",
    "snap.run": "شغّل المُلقِط الآن",
    "snap.written": "كُتب {written} صفاً، ورُصدت {anomalies} حالة شاذة، وأُطلقت {alerts} قاعدة تنبيه.",
    "curl.eyebrow": "النداء نفسه من كودك",
    "curl.lede": "الوحدة أعلاه ترسل هذا بالضبط. أصدر المفتاح من بوابة المطوّرين — لا يُعرض هنا أبداً.",
    "curl.keys": "افتح بوابة المطوّرين",
    "hooks.eyebrow": "الويب هوك",
    "hooks.lede": "ينشر التحليلات التنفيذية هذه الأحداث. اربط نقطة نهاية بأحدها من بوابة المطوّرين ويصلك كل حمل موقّعاً.",
    "sandbox.eyebrow": "بيئة التجربة",
    "sandbox.lede":
      "تحمل المؤسسة التجريبية بيانات اصطناعية حتمية — نفس التجهيزات التي تُبذر منها كل البيئات، فالاستعلام المكتوب عليها يتصرف كما هو على التجريب والإنتاج.",
    "sandbox.open": "افتح مستكشف المقاييس",
    denied: "لا تملك صلاحية قراءة طبقة اللقطات. اطلب من مدير المؤسسة صلاحية التحليلات التنفيذية.",
    "headline.denied": "لا تملك صلاحية الوصول إلى طبقة اللقطات.",
    "headline.empty": "لا شيء لاستعلامه بعد — لم يُسجَّل أي مقياس.",
    "headline.action": "سجّل مقياساً",
    "headline.ready": "{count} مقياس جاهز للاستعلام.",
    "saved.query": "شُغّل الاستعلام.",
    "saved.snapshot": "شُغّل المُلقِط.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "يحتاج هذا الإجراء موافقة بموجب سياسة {policy}. هو في الانتظار ولم يُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_metric": "اختر مقياساً واحداً على الأقل.",
    "problem.too_many": "هذا أكثر من عشرين مفتاحاً يحملها النداء الواحد. استعلمها على دفعتين.",
    "problem.bad_grain": "هذه الحبيبة ليست مما يكتبه المُلقِط.",
    "problem.bad_period": "الفترة لا تطابق الحبيبة: اليوم YYYY-MM-DD والشهر YYYY-MM.",
    "problem.bad_intent": "لم يحمل هذا النموذج إجراءً معروفاً."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ----------------------------------------------------------------- helpers */

/**
 * The last period of this grain the snapshotter would have closed: yesterday
 * for a day (today's row is not written until the day ends), the current month
 * for a month, which it keeps month-to-date.
 */
export function periodFor(grain: Grain, now: number): string {
  const at = grain === "day" ? Math.floor(now / DAY) * DAY - DAY : now;
  return new Date(at).toISOString().slice(0, grain === "day" ? 10 : 7);
}

/** Whether a typed period is the shape its grain is stored in. */
export function validPeriod(grain: Grain, text: string): boolean {
  return (grain === "day" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}$/).test(text.trim());
}

/**
 * The bench's own headline: whether there is anything registered to query at
 * all. Arithmetic on the loaded registry, not a model's reading, so it
 * carries no ✦ mark (CLAUDE.md §11).
 */
export function headline(
  metrics: readonly Pick<Metric, "key">[] | null,
  l: (key: string, vars?: Record<string, string>) => string
): string {
  if (metrics === null) return l("headline.denied");
  if (metrics.length === 0) return l("headline.empty");
  return l("headline.ready", { count: String(metrics.length) });
}

/** The console's own request, written out so an integrator can paste it. */
export function curlFor(
  origin: string,
  input: { metricKeys: string[]; grain: Grain; period: string }
): string {
  return [
    `curl -X POST ${origin}/v1/north/explore \\`,
    `  -H "authorization: Bearer $LYRA_API_KEY" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '${JSON.stringify(input)}'`
  ].join("\n");
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const metrics = await readable(api<Page<Metric>>("/v1/north/metrics?limit=200&sort=key&order=asc", { env, request }));
  return {
    metrics: metrics?.data ?? null,
    origin: env.API_ORIGIN,
    now: Date.now(),
    idempotencyKey: crypto.randomUUID()
  };
}

/* ------------------------------------------------------------------ action */

interface Ran extends ActionResult {
  rows?: Snapshot[];
  snapshot?: { written: number; anomalies: number; alertsTriggered: number };
}

export async function action({ request, context }: ActionFunctionArgs): Promise<Ran> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { headers: { "idempotency-key": key } } : {};

  if (intent === "snapshot") {
    try {
      const snapshot = await api<{ written: number; anomalies: number; alertsTriggered: number }>(
        "/v1/north/snapshotter/run",
        { env, request, method: "POST", ...headers }
      );
      return { problem: null, saved: "snapshot", snapshot };
    } catch (error) {
      return refused(error);
    }
  }

  if (intent !== "query") return refuse("bad_intent");

  const metricKeys = form.getAll("metricKeys").map(String).filter(Boolean);
  const grain = String(form.get("grain") ?? "");
  const period = String(form.get("period") ?? "").trim();
  if (metricKeys.length === 0) return refuse("missing_metric");
  if (metricKeys.length > MAX_KEYS) return refuse("too_many");
  if (!GRAINS.some((one) => one === grain)) return refuse("bad_grain");
  if (!validPeriod(grain as Grain, period)) return refuse("bad_period");

  try {
    const result = await api<{ rows: Snapshot[] }>("/v1/north/explore", {
      env,
      request,
      method: "POST",
      body: { metricKeys, grain, period }
    });
    return { problem: null, saved: "query", rows: result.rows };
  } catch (error) {
    return refused(error);
  }
}

/* -------------------------------------------------------------- the screen */

export default function NorthDev() {
  const { metrics, origin, now, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);

  const shown =
    result?.problem && result.problem.code !== "approval_required"
      ? {
          title: l(`problem.${result.problem.code ?? ""}`),
          status: result.problem.status,
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : (result?.problem ?? null);

  const rows = metrics ?? [];
  const sample = rows.slice(0, 2).map((row) => row.key);
  const columns: Column<Snapshot>[] = [
    { key: "metricKey", header: l("col.metric"), render: (row) => <span className="font-mono text-12">{row.metricKey}</span> },
    { key: "period", header: l("col.period"), render: (row) => <span className="font-mono text-12">{row.period}</span> },
    { key: "value", header: l("col.value"), numeric: true, render: (row) => row.value },
    { key: "ts", header: l("col.ts"), numeric: true, render: (row) => <span className="font-mono text-12">{row.ts}</span> }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="eyebrow">{l("kicker")}</span>
        <h1 className="page-title">{headline(metrics, l)}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        {metrics !== null && metrics.length === 0 ? (
          <Link to="/north/admin" className="w-fit font-ui text-13 text-accent underline">
            {l("headline.action")}
          </Link>
        ) : null}
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`saved.${result.saved}`)}
        </p>
      ) : null}

      {metrics === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : (
        <>
          <Panel module="north" eyebrow={l("query.eyebrow")} lede={l("query.lede")}>
            <Form method="post" className="flex flex-col gap-4">
              <input type="hidden" name="intent" value="query" />
              <fieldset className="flex flex-col gap-2">
                <legend className="eyebrow">
                  {l("query.metrics")}
                </legend>
                <p className="font-ui text-12 text-subtle">{l("query.metrics.hint", { max: String(MAX_KEYS) })}</p>
                <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                  {rows.map((metric) => (
                    <label key={metric.id} className="flex items-start gap-2 font-ui text-13 text-text">
                      <input
                        type="checkbox"
                        name="metricKeys"
                        value={metric.key}
                        defaultChecked={sample.includes(metric.key)}
                        className="mt-1"
                      />
                      <span className="flex flex-col">
                        <span>{metricName(metric, locale)}</span>
                        <span className="font-mono text-12 text-subtle">{metric.key}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={l("query.grain")}>
                  <Select
                    name="grain"
                    defaultValue="day"
                    aria-label={l("query.grain")}
                    options={GRAINS.map((one) => ({ value: one, label: l(`grain.${one}`) }))}
                  />
                </Field>
                <Field label={l("query.period")} hint={l("query.period.hint")}>
                  <Input name="period" defaultValue={periodFor("day", now)} aria-label={l("query.period")} />
                </Field>
              </div>
              <div>
                <Button type="submit" disabled={busy}>
                  {l("query.run")}
                </Button>
              </div>
            </Form>

            {result?.rows ? (
              <div className="mt-5 flex flex-col gap-3">
                <p className="font-ui text-13 text-subtle">
                  {l("query.rows")}: <span className="font-mono text-text">{result.rows.length}</span>
                </p>
                <Table
                  columns={columns}
                  rows={result.rows}
                  rowKey={(row) => row.id}
                  caption={l("query.caption")}
                  empty={<EmptyState title={l("query.empty")} body={l("query.empty.body")} />}
                />
                <details>
                  <summary className="cursor-pointer font-ui text-13 text-accent">{l("query.raw")}</summary>
                  <pre className="mt-2 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
                    {JSON.stringify({ rows: result.rows }, null, 2)}
                  </pre>
                </details>
              </div>
            ) : null}
          </Panel>

          <Panel module="north" eyebrow={l("curl.eyebrow")} lede={l("curl.lede")}>
            <div className="flex flex-col gap-3">
              <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-12 text-text">
                {curlFor(origin, {
                  metricKeys: sample.length > 0 ? sample : ["your_metric_key"],
                  grain: "day",
                  period: periodFor("day", now)
                })}
              </pre>
              {held.has(PERM.keys) ? (
                <Link to="/admin/developer" className="font-ui text-13 text-accent underline underline-offset-2">
                  {l("curl.keys")}
                </Link>
              ) : null}
            </div>
          </Panel>

          <Panel module="north" eyebrow={l("hooks.eyebrow")} lede={l("hooks.lede")}>
            <ul className="flex flex-wrap gap-2">
              {TOPICS.map((topic) => (
                <li key={topic}>
                  <Badge tone="neutral" size="sm">
                    <span className="font-mono">{topic}</span>
                  </Badge>
                </li>
              ))}
            </ul>
          </Panel>

          {held.has(PERM.run) ? (
            <Panel module="north" eyebrow={l("snap.eyebrow")} lede={l("snap.lede")}>
              <div className="flex flex-col gap-3">
                <Form method="post">
                  <input type="hidden" name="intent" value="snapshot" />
                  <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                  <Button type="submit" variant="secondary" disabled={busy}>
                    {l("snap.run")}
                  </Button>
                </Form>
                {result?.snapshot ? (
                  <p className="font-ui text-13 text-subtle">
                    {l("snap.written", {
                      written: String(result.snapshot.written),
                      anomalies: String(result.snapshot.anomalies),
                      alerts: String(result.snapshot.alertsTriggered)
                    })}
                  </p>
                ) : null}
              </div>
            </Panel>
          ) : null}

          {/* ponytail: the sandbox is the seeded synthetic dataset every
              environment shares, not a second tenant to switch into — there is
              no tenant-switching surface to hang one off. */}
          <Panel module="north" eyebrow={l("sandbox.eyebrow")} lede={l("sandbox.lede")}>
            <Link to="/north/explorer" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("sandbox.open")}
            </Link>
          </Panel>
        </>
      )}
    </div>
  );
}

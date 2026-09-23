import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import { Badge, Button, EmptyState, Panel, Table, type Column } from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import {
  labelsFrom,
  metricName,
  readable,
  refused,
  type ActionResult,
  type Labels,
  type Metric,
  type Page
} from "./north-shared";

// Alert rules (docs/modules/north.md §4): a threshold a metric is watched
// against, and where the alert goes when it trips. NORTH's snapshotter
// evaluates these on the clock; this screen is where a person manages them —
// see what is armed, and switch a rule on or off.
//
// The rules themselves live behind the generated CRUD resource
// (`/v1/north/alert_rules`, north:alerts:read / :write); this screen reads the
// list and patches `enabled`. It never decides whether a metric has tripped —
// that is the detector's job.

/* --------------------------------------------------------------- constants */

export const PERM = { read: "north:alerts:read", write: "north:alerts:write" } as const;

// Type-only tuples: the wire values are validated server-side; these pin the
// union types the labels below key off.
export const OPERATORS = ["gt", "gte", "lt", "lte", "eq"] as const;
export const GRAINS = ["day", "week", "month"] as const;
export type Operator = (typeof OPERATORS)[number];
export type Grain = (typeof GRAINS)[number];

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    kicker: "Insight / Alert rules",
    title: "Alert rules",
    intro:
      "A threshold a metric is watched against. When a snapshot crosses one, NORTH raises an alert. Switch a rule off to stop it firing without deleting it.",
    denied: "You cannot read Insight alert rules.",
    empty: "No alert rules yet.",
    "empty.body": "Add one from the Insight admin screen to start watching a metric.",
    "col.metric": "Metric",
    "col.operator": "Fires when",
    "col.threshold": "Threshold",
    "col.window": "Window",
    "col.notify": "Notify",
    "col.state": "State",
    "col.toggle": "",
    "op.gt": "above",
    "op.gte": "at or above",
    "op.lt": "below",
    "op.lte": "at or below",
    "op.eq": "equals",
    "grain.day": "daily",
    "grain.week": "weekly",
    "grain.month": "monthly",
    "state.enabled": "Armed",
    "state.disabled": "Off",
    enable: "Arm",
    disable: "Switch off",
    "problem.bad_intent": "That action is not recognised.",
    "problem.missing_id": "The rule to change was not identified.",
    "problem.unknown": "The change could not be saved."
  },
  ar: {
    kicker: "التحليلات التنفيذية / قواعد التنبيه",
    title: "قواعد التنبيه",
    intro:
      "عتبة يُراقَب مقياس مقابلها. عندما يتجاوزها لقطة، يرفع نورث تنبيهاً. أوقف قاعدة دون حذفها لتتوقف عن الإطلاق.",
    denied: "لا يمكنك قراءة قواعد تنبيه التحليلات التنفيذية.",
    empty: "لا توجد قواعد تنبيه بعد.",
    "empty.body": "أضف واحدة من شاشة إدارة التحليلات التنفيذية لبدء مراقبة مقياس.",
    "col.metric": "المقياس",
    "col.operator": "يُطلق عندما",
    "col.threshold": "العتبة",
    "col.window": "النافذة",
    "col.notify": "الإخطار",
    "col.state": "الحالة",
    "col.toggle": "",
    "op.gt": "أعلى من",
    "op.gte": "يساوي أو أعلى من",
    "op.lt": "أقل من",
    "op.lte": "يساوي أو أقل من",
    "op.eq": "يساوي",
    "grain.day": "يومياً",
    "grain.week": "أسبوعياً",
    "grain.month": "شهرياً",
    "state.enabled": "مفعّلة",
    "state.disabled": "متوقفة",
    enable: "تفعيل",
    disable: "إيقاف",
    "problem.bad_intent": "هذا الإجراء غير معرّف.",
    "problem.missing_id": "لم يتم تحديد القاعدة المطلوب تغييرها.",
    "problem.unknown": "تعذّر حفظ التغيير."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface AlertRule {
  id: string;
  metricKey: string;
  operator: Operator;
  thresholdValue: number;
  windowGrain: Grain;
  notifyChannelRef: string | null;
  enabled: boolean;
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };

  const [rules, metrics] = await Promise.all([
    readable(api<Page<AlertRule>>("/v1/north/alert_rules?limit=200", opts)),
    readable(api<Page<Metric>>("/v1/north/metrics?limit=200", opts))
  ]);

  return {
    rules: rules?.data ?? null,
    metrics: metrics?.data ?? [],
    idempotencyKey: crypto.randomUUID()
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { headers: { "idempotency-key": key } } : {};

  if (intent !== "toggle") return { problem: { title: "bad intent", code: "bad_intent", status: 400 }, saved: null };

  const id = String(form.get("id") ?? "").trim();
  if (!id) return { problem: { title: "missing id", code: "missing_id", status: 400 }, saved: null };
  const enabled = form.get("enabled") === "true";

  try {
    await api(`/v1/north/alert_rules/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      ...headers,
      body: { enabled }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: "rule" };
}

/* -------------------------------------------------------------- the screen */

export default function NorthAlerts() {
  const { rules, metrics, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);
  const canWrite = held.has(PERM.write);

  const shown = result?.problem ? { title: l(`problem.${result.problem.code ?? "unknown"}`), status: result.problem.status } : null;

  const byKey = new Map((metrics ?? []).map((m) => [m.key, m]));
  const number = new Intl.NumberFormat(locale);

  const columns: Column<AlertRule>[] = [
    {
      key: "metric",
      header: l("col.metric"),
      render: (row) => {
        const metric = byKey.get(row.metricKey);
        return metric ? metricName(metric, locale) : <span className="font-mono text-12">{row.metricKey}</span>;
      }
    },
    {
      key: "operator",
      header: l("col.operator"),
      render: (row) => (
        <span className="font-ui text-13 text-text">
          {l(`op.${row.operator}`)} <span className="font-mono">{number.format(row.thresholdValue)}</span>
        </span>
      )
    },
    { key: "window", header: l("col.window"), render: (row) => l(`grain.${row.windowGrain}`) },
    {
      key: "notify",
      header: l("col.notify"),
      render: (row) =>
        row.notifyChannelRef ? <span className="font-mono text-12">{row.notifyChannelRef}</span> : <span className="text-subtle">—</span>
    },
    {
      key: "state",
      header: l("col.state"),
      render: (row) => (
        <Badge tone={row.enabled ? "success" : "neutral"} size="sm" dot>
          {l(row.enabled ? "state.enabled" : "state.disabled")}
        </Badge>
      )
    },
    {
      key: "toggle",
      header: l("col.toggle"),
      render: (row) =>
        canWrite ? (
          <Form method="post">
            <input type="hidden" name="intent" value="toggle" />
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="enabled" value={row.enabled ? "false" : "true"} />
            <input type="hidden" name="idempotencyKey" value={`${idempotencyKey}:${row.id}`} />
            <Button type="submit" size="sm" variant={row.enabled ? "ghost" : "secondary"} loading={busy}>
              {l(row.enabled ? "disable" : "enable")}
            </Button>
          </Form>
        ) : null
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="eyebrow">{l("kicker")}</span>
        <h1 className="page-title">{l("title")}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}

      {rules === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : rules.length === 0 ? (
        <EmptyState title={l("empty")} body={l("empty.body")} />
      ) : (
        <Table rows={rules} columns={columns} rowKey={(row) => row.id} caption={l("title")} captionHidden />
      )}
    </div>
  );
}

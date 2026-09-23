import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  DateTime,
  EmptyState,
  Field,
  Input,
  Panel,
  Select,
  Table,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import {
  labelsFrom,
  metricName,
  parsed,
  readable,
  refuse,
  refused,
  type ActionResult,
  type Labels,
  type Metric,
  type Page
} from "./north-shared";

// NORTH admin (docs/modules/north.md §4 screen 7): the registry seen as a
// registry — who owns each metric, who may see it, which way is good, what it
// is aimed at, and whether the snapshotter has actually been feeding it.
//
// "One version of the numbers" (§2.1) is the product, so this is the only place
// the definition of a metric changes, and every change here is what every chart
// in NORTH reads next.

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:metrics:read",
  write: "north:metrics:write",
  run: "north:snapshots:run",
  alerts: "north:alerts:read"
} as const;

const SENSITIVITIES = ["public", "internal", "restricted"] as const;
const DIRECTIONS = ["up", "down"] as const;

const DAY = 86_400_000;
/** How long a grain may go unfed before the registry calls it late. */
const PATIENCE: Record<string, number> = { day: 2 * DAY, week: 9 * DAY, month: 40 * DAY };

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "NORTH admin",
    kicker: "One version of the numbers",
    intro:
      "The metric registry as a registry: owner, audience, direction and target, plus whether the snapshotter is still feeding each one. A change here is what every chart in NORTH reads next.",
    "registry.title": "Metric registry",
    "registry.caption": "Every metric in this tenant, with its owner, audience, target and last snapshot",
    "registry.empty": "No metric is registered yet.",
    "registry.empty.body": "NORTH has nothing to narrate until one is. Metrics are provisioned with the tenant, not added here — this screen edits the target and owner of ones that exist.",
    "col.metric": "Metric",
    "col.grain": "Grain",
    "col.owner": "Owner",
    "col.sensitivity": "Audience",
    "col.direction": "Good direction",
    "col.target": "Target",
    "col.fresh": "Last snapshot",
    "col.edit": "",
    "sensitivity.public": "Public",
    "sensitivity.internal": "Internal",
    "sensitivity.restricted": "Restricted",
    "direction.up": "Up",
    "direction.down": "Down",
    "fresh.fresh": "Fed",
    "fresh.late": "Late",
    "fresh.missing": "Never",
    unset: "Not set",
    "edit.eyebrow": "Edit metric",
    "edit.lede": "Definition, owner, audience and target. Unit and grain are fixed once a metric has history — changing them would silently rewrite every past reading.",
    "edit.key": "Key",
    "edit.definition": "Definition",
    "edit.definition.hint": "The source this metric is computed from. Changing it annotates every chart from today.",
    "edit.owner": "Owner",
    "edit.owner.hint": "The steward who answers for this number.",
    "edit.sensitivity": "Audience",
    "edit.sensitivity.hint": "Restricted metrics stay out of board packs and shared briefs.",
    "edit.direction": "Good direction",
    "edit.direction.hint": "Which way of moving counts as improvement — anomaly wording follows it.",
    "edit.target": "Target",
    "edit.target.hint": "In the metric's own units: money in minor units, percentages in basis points. Empty clears it.",
    "edit.save": "Save the definition",
    "edit.cancel": "Close",
    "schedule.eyebrow": "Brief schedule and locales",
    "schedule.lede": "Snapshots run nightly at 02:00 UTC. Briefings are generated against that data and published only after a human approves them.",
    "schedule.locales": "Briefings exist in",
    "schedule.audiences": "Written for",
    "schedule.none": "No briefing has been generated yet.",
    "schedule.open": "Open the daily brief",
    "schedule.run": "Run the snapshotter now",
    "alerts.eyebrow": "Thresholds",
    "alerts.lede": "Alert rules watch a metric against a threshold and are managed in the NORTH workspace.",
    "alerts.open": "Open alert rules",
    denied: "You do not have permission to read the metric registry. Ask a tenant administrator for NORTH metric access.",
    "headline.denied": "You do not have access to the metric registry.",
    "headline.fresh": "Every metric is fed.",
    "headline.unfed": "{count} metrics have gone quiet.",
    "saved.metric": "Metric definition saved.",
    "saved.snapshot": "Snapshotter run — the registry below reads the new snapshots.",
    approvalTitle: "Queued for approval",
    approvalBody: "This change needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_id": "That metric could not be identified.",
    "problem.missing_definition": "A metric with no definition has no number behind it.",
    "problem.bad_target": "That target is not a number. Leave it empty to clear the target instead.",
    "problem.bad_sensitivity": "That audience level is not one NORTH recognises.",
    "problem.bad_direction": "A metric is good going up or good going down — nothing else.",
    "problem.bad_intent": "That form did not carry a recognised action."
  },
  ar: {
    title: "إدارة نورث",
    kicker: "نسخة واحدة من الأرقام",
    intro:
      "سجل المقاييس بوصفه سجلاً: المالك والجمهور والاتجاه والمستهدف، ومعه هل ما زال المُلقِط يغذّي كل مقياس. أي تغيير هنا هو ما ستقرأه كل رسوم نورث بعده.",
    "registry.title": "سجل المقاييس",
    "registry.caption": "كل مقياس في هذه المؤسسة، مع مالكه وجمهوره ومستهدفه وآخر لقطة",
    "registry.empty": "لا يوجد مقياس مسجَّل بعد.",
    "registry.empty.body": "لا شيء لنورث ليرويه حتى يُسجَّل واحد. تُهيَّأ المقاييس مع المستأجر ولا تُضاف من هنا — هذه الشاشة تعدّل هدف ومالك المقاييس الموجودة.",
    "col.metric": "المقياس",
    "col.grain": "الحبيبة",
    "col.owner": "المالك",
    "col.sensitivity": "الجمهور",
    "col.direction": "الاتجاه الجيد",
    "col.target": "المستهدف",
    "col.fresh": "آخر لقطة",
    "col.edit": "",
    "sensitivity.public": "عام",
    "sensitivity.internal": "داخلي",
    "sensitivity.restricted": "مقيّد",
    "direction.up": "صعوداً",
    "direction.down": "نزولاً",
    "fresh.fresh": "مُغذّى",
    "fresh.late": "متأخر",
    "fresh.missing": "أبداً",
    unset: "غير محدد",
    "edit.eyebrow": "تحرير المقياس",
    "edit.lede": "التعريف والمالك والجمهور والمستهدف. الوحدة والحبيبة ثابتتان بعد أن يصير للمقياس تاريخ — تغييرهما يعيد كتابة كل قراءة سابقة بصمت.",
    "edit.key": "المفتاح",
    "edit.definition": "التعريف",
    "edit.definition.hint": "المصدر الذي يُحسب منه هذا المقياس. تغييره يضيف تعليقاً على كل رسم من اليوم.",
    "edit.owner": "المالك",
    "edit.owner.hint": "القيّم الذي يجيب عن هذا الرقم.",
    "edit.sensitivity": "الجمهور",
    "edit.sensitivity.hint": "المقاييس المقيّدة تبقى خارج حزم المجلس والإحاطات المشتركة.",
    "edit.direction": "الاتجاه الجيد",
    "edit.direction.hint": "أي اتجاه يُعدّ تحسّناً — صياغة الحالات الشاذة تتبعه.",
    "edit.target": "المستهدف",
    "edit.target.hint": "بوحدات المقياس نفسها: المال بالوحدات الصغرى والنسب بنقاط الأساس. الفراغ يمسحه.",
    "edit.save": "احفظ التعريف",
    "edit.cancel": "إغلاق",
    "schedule.eyebrow": "جدول الإحاطة ولغاتها",
    "schedule.lede": "تعمل اللقطات ليلاً عند 02:00 بتوقيت UTC. تُولَّد الإحاطات على تلك البيانات ولا تُنشر إلا بعد موافقة إنسان.",
    "schedule.locales": "الإحاطات موجودة بـ",
    "schedule.audiences": "مكتوبة لـ",
    "schedule.none": "لم تُولَّد أي إحاطة بعد.",
    "schedule.open": "افتح الإحاطة اليومية",
    "schedule.run": "شغّل المُلقِط الآن",
    "alerts.eyebrow": "العتبات",
    "alerts.lede": "قواعد التنبيه تراقب مقياساً مقابل عتبة، وتُدار في مساحة عمل نورث.",
    "alerts.open": "افتح قواعد التنبيه",
    denied: "لا تملك صلاحية قراءة سجل المقاييس. اطلب من مدير المستأجر صلاحية مقاييس نورث.",
    "headline.denied": "لا تملك صلاحية الوصول إلى سجل المقاييس.",
    "headline.fresh": "كل مقياس مُغذّى.",
    "headline.unfed": "{count} مقاييس صمتت.",
    "saved.metric": "حُفظ تعريف المقياس.",
    "saved.snapshot": "شُغّل المُلقِط — السجل أدناه يقرأ اللقطات الجديدة.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "يحتاج هذا التغيير موافقة بموجب سياسة {policy}. هو في الانتظار ولم يُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_id": "تعذّر تحديد هذا المقياس.",
    "problem.missing_definition": "المقياس بلا تعريف ليس خلفه رقم.",
    "problem.bad_target": "المستهدف ليس رقماً. اترك الحقل فارغاً لمسح المستهدف.",
    "problem.bad_sensitivity": "مستوى الجمهور هذا غير معروف لنورث.",
    "problem.bad_direction": "المقياس إما جيد صعوداً أو جيد نزولاً — لا ثالث.",
    "problem.bad_intent": "لم يحمل هذا النموذج إجراءً معروفاً."
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface HealthRow {
  metricKey: string;
  grain: string;
  lastSnapshotAt: number | null;
  staleness: number | null;
}

interface Briefing {
  locale: string;
  audience: string;
}

export interface Target {
  value?: unknown;
  scale?: unknown;
  currency?: unknown;
}

/* ----------------------------------------------------------------- helpers */

/**
 * Whether the snapshotter is still feeding a metric, judged against its own
 * grain: a monthly metric that has not moved in a week is fine, a daily one is
 * two nights from being a lie on the exec's home screen. An unknown grain gets
 * the strictest window rather than a free pass.
 */
export function freshness(lastSnapshotAt: number | null, grain: string, now: number): "fresh" | "late" | "missing" {
  if (lastSnapshotAt === null) return "missing";
  return now - lastSnapshotAt <= (PATIENCE[grain] ?? PATIENCE.day!) ? "fresh" : "late";
}

/** The target number, in the metric's own stored units. `null` when unset. */
export function targetValue(raw: unknown): number | null {
  const target = parsed<Target | null>(raw, null);
  return typeof target?.value === "number" ? target.value : null;
}

/**
 * A retyped target, keeping the scale and currency the registry already
 * recorded — those describe the metric, not the aim. `"bad"` rather than a
 * silent clear when the box holds something that is not a number.
 */
export function targetFrom(text: string, previous: Target | null): Target | null | "bad" {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return "bad";
  return {
    value,
    ...(previous?.scale === undefined ? {} : { scale: previous.scale }),
    ...(previous?.currency === undefined ? {} : { currency: previous.currency })
  };
}

/**
 * The registry's own headline: how many metrics the snapshotter has stopped
 * feeding, judged by each metric's own freshness() — the same read behind
 * the "Last snapshot" column. Arithmetic on stored timestamps, not a model's
 * reading, so it carries no ✦ mark (CLAUDE.md §11).
 */
export function headline(
  metrics: readonly Pick<Metric, "key" | "grain">[] | null,
  health: readonly Pick<HealthRow, "metricKey" | "lastSnapshotAt">[],
  now: number,
  l: (key: string, vars?: Record<string, string>) => string
): string {
  if (metrics === null) return l("headline.denied");
  if (metrics.length === 0) return l("title");
  const freshByKey = new Map(health.map((row) => [row.metricKey, row]));
  const unfed = metrics.filter(
    (metric) => freshness(freshByKey.get(metric.key)?.lastSnapshotAt ?? null, metric.grain, now) !== "fresh"
  );
  return unfed.length === 0 ? l("headline.fresh") : l("headline.unfed", { count: String(unfed.length) });
}

const FRESH_TONE: Record<"fresh" | "late" | "missing", BadgeTone> = {
  fresh: "success",
  late: "warning",
  missing: "danger"
};

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const selected = new URL(request.url).searchParams.get("metric");

  const [metrics, health, briefings] = await Promise.all([
    readable(api<Page<Metric>>("/v1/north/metrics?limit=200&sort=key&order=asc", opts)),
    readable(api<{ metrics: HealthRow[] }>("/v1/north/data-health", opts)),
    readable(api<Page<Briefing>>("/v1/north/briefings?limit=100", opts))
  ]);

  return {
    metrics: metrics?.data ?? null,
    health: health?.metrics ?? [],
    locales: [...new Set((briefings?.data ?? []).map((one) => one.locale))].sort(),
    audiences: [...new Set((briefings?.data ?? []).map((one) => one.audience))].sort(),
    selected,
    now: Date.now(),
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

  if (intent === "snapshot") {
    try {
      await api("/v1/north/snapshotter/run", { env, request, method: "POST", ...headers });
    } catch (error) {
      return refused(error);
    }
    return { problem: null, saved: "snapshot" };
  }

  if (intent !== "metric") return refuse("bad_intent");

  const id = String(form.get("id") ?? "").trim();
  const definition = String(form.get("definitionSqlRef") ?? "").trim();
  const sensitivity = String(form.get("sensitivity") ?? "");
  const direction = String(form.get("direction") ?? "");
  if (!id) return refuse("missing_id");
  if (!definition) return refuse("missing_definition");
  if (!SENSITIVITIES.some((one) => one === sensitivity)) return refuse("bad_sensitivity");
  if (!DIRECTIONS.some((one) => one === direction)) return refuse("bad_direction");

  const previous = parsed<Target | null>(String(form.get("targetJson") ?? ""), null);
  const target = targetFrom(String(form.get("target") ?? ""), previous);
  if (target === "bad") return refuse("bad_target");

  const owner = String(form.get("owner") ?? "").trim();
  try {
    await api(`/v1/north/metrics/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      ...headers,
      body: { definitionSqlRef: definition, sensitivity, direction, owner: owner || null, targetJson: target }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: "metric" };
}

/* -------------------------------------------------------------- the screen */

export default function NorthAdmin() {
  const { metrics, health, locales, audiences, selected, now, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);
  const canWrite = held.has(PERM.write);

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
  const freshByKey = new Map(health.map((row) => [row.metricKey, row]));
  const editing = selected ? (rows.find((row) => row.id === selected) ?? null) : null;
  const number = new Intl.NumberFormat(locale);

  const columns: Column<Metric>[] = [
    {
      key: "key",
      header: l("col.metric"),
      render: (row) => (
        <span className="flex flex-col">
          <span className="text-text">{metricName(row, locale)}</span>
          <span className="font-mono text-12 text-subtle">{row.key}</span>
        </span>
      )
    },
    { key: "grain", header: l("col.grain"), render: (row) => row.grain },
    { key: "owner", header: l("col.owner"), render: (row) => row.owner ?? <span className="text-subtle">—</span> },
    {
      key: "sensitivity",
      header: l("col.sensitivity"),
      render: (row) => (
        <Badge tone={row.sensitivity === "restricted" ? "warning" : "neutral"} size="sm">
          {l(`sensitivity.${row.sensitivity}`)}
        </Badge>
      )
    },
    { key: "direction", header: l("col.direction"), render: (row) => l(`direction.${row.direction}`) },
    {
      key: "target",
      header: l("col.target"),
      numeric: true,
      render: (row) => {
        const value = targetValue(row.targetJson);
        return value === null ? <span className="text-subtle">{l("unset")}</span> : number.format(value);
      }
    },
    {
      key: "fresh",
      header: l("col.fresh"),
      render: (row) => {
        const state = freshness(freshByKey.get(row.key)?.lastSnapshotAt ?? null, row.grain, now);
        const at = freshByKey.get(row.key)?.lastSnapshotAt ?? null;
        return (
          <span className="flex items-center gap-2">
            <Badge tone={FRESH_TONE[state]} size="sm" dot>
              {l(`fresh.${state}`)}
            </Badge>
            {at === null ? null : <DateTime value={at} locale={locale} precision="day" />}
          </span>
        );
      }
    },
    {
      key: "edit",
      header: l("col.edit"),
      headerLabel: l("edit"),
      render: (row) =>
        canWrite ? (
          <Link
            to={`?metric=${encodeURIComponent(row.id)}`}
            className="font-ui text-13 text-accent underline underline-offset-2"
          >
            {l("edit")}
          </Link>
        ) : null
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-12 uppercase tracking-[0.14em] text-subtle">{l("kicker")}</span>
        <h1 className="font-serif text-22 leading-[1.2] text-text">{headline(metrics, health, now, l)}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
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
          {editing ? (
            <Panel module="north" eyebrow={l("edit.eyebrow")} lede={l("edit.lede")}>
              <Form method="post" className="flex flex-col gap-3">
                <input type="hidden" name="intent" value="metric" />
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                <input
                  type="hidden"
                  name="targetJson"
                  value={typeof editing.targetJson === "string" ? editing.targetJson : JSON.stringify(editing.targetJson ?? null)}
                />
                <p className="font-ui text-13 text-subtle">
                  {l("edit.key")}: <span className="font-mono text-12 text-text">{editing.key}</span>
                </p>
                <Field label={l("edit.definition")} hint={l("edit.definition.hint")}>
                  <Input
                    name="definitionSqlRef"
                    defaultValue={editing.definitionSqlRef ?? ""}
                    required
                    aria-label={l("edit.definition")}
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={l("edit.owner")} hint={l("edit.owner.hint")}>
                    <Input name="owner" defaultValue={editing.owner ?? ""} aria-label={l("edit.owner")} />
                  </Field>
                  <Field label={l("edit.target")} hint={l("edit.target.hint")}>
                    <Input
                      name="target"
                      inputMode="numeric"
                      defaultValue={targetValue(editing.targetJson)?.toString() ?? ""}
                      aria-label={l("edit.target")}
                    />
                  </Field>
                  <Field label={l("edit.sensitivity")} hint={l("edit.sensitivity.hint")}>
                    <Select
                      name="sensitivity"
                      defaultValue={editing.sensitivity}
                      aria-label={l("edit.sensitivity")}
                      options={SENSITIVITIES.map((one) => ({ value: one, label: l(`sensitivity.${one}`) }))}
                    />
                  </Field>
                  <Field label={l("edit.direction")} hint={l("edit.direction.hint")}>
                    <Select
                      name="direction"
                      defaultValue={editing.direction}
                      aria-label={l("edit.direction")}
                      options={DIRECTIONS.map((one) => ({ value: one, label: l(`direction.${one}`) }))}
                    />
                  </Field>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="submit" disabled={busy}>
                    {l("edit.save")}
                  </Button>
                  <Link to="?" className="font-ui text-13 text-accent underline underline-offset-2">
                    {l("edit.cancel")}
                  </Link>
                </div>
              </Form>
            </Panel>
          ) : null}

          <section className="flex flex-col gap-3">
            <h2 className="font-serif text-18 leading-[1.3] text-text">{l("registry.title")}</h2>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              caption={l("registry.caption")}
              empty={<EmptyState title={l("registry.empty")} body={l("registry.empty.body")} />}
            />
          </section>

          {/* ponytail: the cadence is the worker cron (apps/api/src/index.ts
              scheduled), not a per-tenant setting — there is no store to edit one
              into. Stated here rather than pretending it is configurable. */}
          <Panel module="north" eyebrow={l("schedule.eyebrow")} lede={l("schedule.lede")}>
            <div className="flex flex-col gap-3">
              {locales.length === 0 ? (
                <p className="font-ui text-13 text-subtle">{l("schedule.none")}</p>
              ) : (
                <dl className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <dt className="font-ui text-12 uppercase tracking-[0.14em] text-subtle">{l("schedule.locales")}</dt>
                    <dd className="font-mono text-13 text-text">{locales.join(", ")}</dd>
                  </div>
                  <div className="flex flex-wrap items-baseline gap-2">
                    <dt className="font-ui text-12 uppercase tracking-[0.14em] text-subtle">{l("schedule.audiences")}</dt>
                    <dd className="font-mono text-13 text-text">{audiences.join(", ")}</dd>
                  </div>
                </dl>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <Link to="/north/brief" className="font-ui text-13 text-accent underline underline-offset-2">
                  {l("schedule.open")}
                </Link>
                {held.has(PERM.run) ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="snapshot" />
                    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
                    <Button type="submit" variant="secondary" size="sm" disabled={busy}>
                      {l("schedule.run")}
                    </Button>
                  </Form>
                ) : null}
              </div>
            </div>
          </Panel>

          {held.has(PERM.alerts) ? (
            <Panel module="north" eyebrow={l("alerts.eyebrow")} lede={l("alerts.lede")}>
              <Link to="/north/alerts" className="font-ui text-13 text-accent underline underline-offset-2">
                {l("alerts.open")}
              </Link>
            </Panel>
          ) : null}
        </>
      )}
    </div>
  );
}

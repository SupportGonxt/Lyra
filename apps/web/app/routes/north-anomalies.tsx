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
  AutoGrid,
  Badge,
  Button,
  DateTime,
  EmptyState,
  Field,
  Figure,
  Input,
  Panel,
  Provenance,
  Select
} from "@lyra/ui";
import { api } from "../api.server";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { useNorthSessionData } from "./north-shell";
import {
  labelsFrom,
  metricName,
  num,
  parsed,
  pct,
  readable,
  refuse,
  refused,
  type ActionResult,
  type Anomaly,
  type Labels,
  type Metric,
  type Page
} from "./north-shared";

// Anomalies (docs/modules/north.md §4 screen 3): what moved unexpectedly, what
// the detector thinks drove it, and the one decision each card is waiting for.
//
// The detector runs in the API; this screen never decides what is anomalous. It
// shows the stored deviation, the driver breakdown that came with it, and lets a
// person close the loop — explain it, own it, or say it does not matter.

/* --------------------------------------------------------------- constants */

export const PERM = {
  read: "north:anomalies:read",
  assign: "north:anomalies:assign"
} as const;

const PAGE = 60;
const STATES = ["new", "explained", "action_created", "dismissed"] as const;

/* ------------------------------------------------------------------ labels */

const LABELS: Labels = {
  en: {
    title: "Anomalies",
    kicker: "What moved more than it should have",
    intro:
      "The detector compares each closed period against its own baseline. It does not know why a number moved — that part is yours, and the card stays open until you say it.",
    filter: "Show",
    all: "Everything",
    new: "Unowned",
    explained: "Explained",
    action_created: "Being worked",
    dismissed: "Dismissed",
    "card.window": "Window",
    "card.expected": "Expected",
    "card.actual": "Actual",
    "card.detected": "Detected",
    "card.state": "State",
    "card.owner": "Owner",
    "card.deviation": "against expected",
    "drivers.title": "What the detector thinks drove it",
    "drivers.none": "No driver breakdown was recorded with this anomaly.",
    "drivers.method": "Method",
    "drivers.baseline": "Baseline",
    "who.label": "Your name",
    "who.hint": "Recorded against the anomaly so the next reader knows who looked.",
    "note.label": "Linked work",
    "note.hint": "A case, task or decision reference. Optional.",
    "act.explain": "Explain it",
    "act.own": "Take it on",
    "act.dismiss": "Dismiss",
    // The hero's opening line: what state the whole loaded list is in, not
    // the filtered one — see `headline()`. Deliberately count-free, same
    // reasoning as home.tsx's `answer`: a number here needs a plural rule per
    // locale, and Arabic has five.
    "headline.denied": "You do not have access to anomalies.",
    "headline.clear": "Nothing moved more than the detector expected.",
    "headline.open": "There is a deviation nobody has looked at yet.",
    "headline.owned": "Every anomaly here already has an owner.",
    "headline.action": "Open the anomaly",
    "none.title": "Nothing is out of line",
    "none.body": "No anomaly matches this filter. That is the state you want most days.",
    denied: "You do not have permission to read anomalies. Ask a tenant administrator for NORTH anomaly access.",
    "saved.explained": "Explanation recorded.",
    "saved.action_created": "Recorded as yours.",
    "saved.dismissed": "Dismissed.",
    // Read by <Gate> when the API holds a write for approval.
    approvalTitle: "Queued for approval",
    approvalBody: "Closing this anomaly needs sign-off under policy {policy}. It is queued, not lost.",
    approvalLink: "Open the approvals queue",
    "problem.missing_id": "That anomaly could not be identified.",
    "problem.missing_owner": "Put your name to it — an anomaly nobody signed for is still unowned.",
    "problem.bad_intent": "That form did not carry a recognised action.",
    // The natural next stop after reading a deviation: the rule that watches
    // for it. Permission-gated by the shell's own rail entry; this link only
    // renders when the actor holds the read.
    "alerts.link": "Alert rules"
  },
  ar: {
    title: "الحالات الشاذة",
    kicker: "ما تحرك أكثر مما ينبغي",
    intro:
      "يقارن الكاشف كل فترة مغلقة بخط أساسها. لا يعرف سبب الحركة — هذا دورك، وتبقى البطاقة مفتوحة حتى تقول ذلك.",
    filter: "اعرض",
    all: "الكل",
    new: "بلا مسؤول",
    explained: "مُفسَّرة",
    action_created: "قيد المعالجة",
    dismissed: "مُستبعدة",
    "card.window": "النافذة",
    "card.expected": "المتوقع",
    "card.actual": "الفعلي",
    "card.detected": "وقت الاكتشاف",
    "card.state": "الحالة",
    "card.owner": "المسؤول",
    "card.deviation": "عن المتوقع",
    "drivers.title": "ما يعتقد الكاشف أنه السبب",
    "drivers.none": "لم يُسجَّل تحليل للمسببات مع هذه الحالة.",
    "drivers.method": "الطريقة",
    "drivers.baseline": "خط الأساس",
    "who.label": "اسمك",
    "who.hint": "يُسجَّل مع الحالة ليعرف القارئ التالي من اطّلع عليها.",
    "note.label": "العمل المرتبط",
    "note.hint": "مرجع حالة أو مهمة أو قرار. اختياري.",
    "act.explain": "فسّرها",
    "act.own": "تولّها",
    "act.dismiss": "استبعدها",
    "headline.denied": "لا تملك صلاحية الوصول إلى الحالات الشاذة.",
    "headline.clear": "لم يتحرك شيء أكثر مما توقعه الكاشف.",
    "headline.open": "هناك انحراف لم ينظر إليه أحد بعد.",
    "headline.owned": "كل حالة هنا لها مسؤول بالفعل.",
    "headline.action": "فتح الحالة الشاذة",
    "none.title": "لا شيء خارج الحد",
    "none.body": "لا توجد حالة تطابق هذا المرشّح. وهذه هي الحالة المرجوة في معظم الأيام.",
    denied: "لا تملك صلاحية قراءة الحالات الشاذة. اطلب من مدير المستأجر صلاحية حالات نورث.",
    "saved.explained": "سُجّل التفسير.",
    "saved.action_created": "سُجّلت باسمك.",
    "saved.dismissed": "استُبعدت.",
    approvalTitle: "في انتظار الموافقة",
    approvalBody: "إغلاق هذه الحالة يحتاج موافقة بموجب سياسة {policy}. هي في الانتظار ولم تُفقد.",
    approvalLink: "افتح قائمة الموافقات",
    "problem.missing_id": "تعذّر تحديد هذه الحالة.",
    "problem.missing_owner": "ضع اسمك عليها — الحالة بلا توقيع تبقى بلا مسؤول.",
    "problem.bad_intent": "لم يحمل هذا النموذج إجراءً معروفاً.",
    "alerts.link": "قواعد التنبيه"
  }
};

const labelsIn = (locale: string) => labelsFrom(LABELS, locale);

/* ------------------------------------------------------------------- types */

interface Driver {
  dimension: string;
  key: string;
  contributionBps: number;
}

interface DriverAnalysis {
  method?: string;
  baseline?: string;
  drivers?: Driver[];
}

/* ----------------------------------------------------------------- helpers */

/** `period_over_period` is a column name, not a sentence. */
export const words = (value: string): string => value.replace(/_/g, " ");

/**
 * Driver bars are drawn against the largest contribution in the same card, not
 * against the anomaly's own magnitude: the parts of a deviation do not have to
 * sum to it, and a bar wider than its track reads as a rendering fault.
 */
export function driverWidth(contributionBps: number, drivers: readonly Driver[]): number {
  const widest = Math.max(...drivers.map((one) => Math.abs(one.contributionBps)), 0);
  if (widest === 0) return 0;
  return Math.round((Math.abs(contributionBps) / widest) * 100);
}

/** A deviation is bad news when it runs against the metric's stated direction. */
export function tone(magnitude: number, direction: string | undefined): "ok" | "bad" | "neutral" {
  if (magnitude === 0) return "neutral";
  const good = direction === "down" ? magnitude < 0 : magnitude > 0;
  return good ? "ok" : "bad";
}

/**
 * The hero's headline: what state the whole loaded list is in, before a single
 * card is drawn — same move as home.tsx's `answer`. Arithmetic on stored
 * state, not an agent's reading, so it carries no ✦ mark.
 */
export function headline(
  anomalies: readonly Pick<Anomaly, "state">[] | null,
  l: (key: string, vars?: Record<string, string>) => string
): string {
  if (anomalies === null) return l("headline.denied");
  if (anomalies.length === 0) return l("headline.clear");
  return anomalies.some((one) => one.state === "new") ? l("headline.open") : l("headline.owned");
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const url = new URL(request.url);

  const state = STATES.find((one) => one === url.searchParams.get("state")) ?? null;
  // ?asOf=<epoch-ms> replays the queue as of a past moment (Meridian's
  // replay mode) — an upper time bound on the anomalies query.
  const asOf = url.searchParams.get("asOf")?.trim();
  // A non-numeric ?asOf= is not a moment — replay stays off rather than
  // sending `&to=NaN` upstream.
  const to = asOf && Number.isFinite(Number(asOf)) ? `&to=${encodeURIComponent(asOf)}` : "";
  const query = `/v1/north/anomalies?sort=detectedAt&order=desc&limit=${PAGE}${
    state ? `&state=${state}` : ""
  }${to}`;

  const [anomalies, metrics] = await Promise.all([
    readable(api<Page<Anomaly>>(query, opts)),
    readable(api<Page<Metric>>("/v1/north/metrics?limit=200", opts))
  ]);

  return {
    anomalies: anomalies?.data ?? null,
    metrics: metrics?.data ?? [],
    state,
    idempotencyKey: crypto.randomUUID()
  };
}

/* ------------------------------------------------------------------ action */

/** The three closes a person can put on an anomaly, and the state each writes. */
const CLOSES: Record<string, (typeof STATES)[number]> = {
  explain: "explained",
  own: "action_created",
  dismiss: "dismissed"
};

export async function action({ request, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const state = CLOSES[intent];
  if (!state) return refuse("bad_intent");

  const id = String(form.get("id") ?? "").trim();
  const owner = String(form.get("owner") ?? "").trim();
  const linked = String(form.get("linked") ?? "").trim();
  if (!id) return refuse("missing_id");
  // Dismissing is still a decision somebody made, so it is signed like the rest.
  if (!owner) return refuse("missing_owner");

  const key = String(form.get("idempotencyKey") ?? "");
  try {
    await api(`/v1/north/anomalies/${encodeURIComponent(id)}`, {
      env,
      request,
      method: "PATCH",
      ...(key ? { headers: { "idempotency-key": key } } : {}),
      body: { state, explainedBy: owner, ...(linked ? { linkedActionRef: linked } : {}) }
    });
  } catch (error) {
    return refused(error);
  }
  return { problem: null, saved: state };
}

/* --------------------------------------------------------------- the screen */

export default function NorthAnomalies() {
  const { anomalies, metrics, state, idempotencyKey } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useNorthSessionData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";
  const held = new Set(shell?.permissions ?? []);

  const byKey = new Map(metrics.map((row) => [row.key, row]));
  // The most recently detected unowned anomaly (the list loads detectedAt
  // desc) is what the hero's link drills into — a real destination
  // (record.tsx's generic `/north/anomalies/:id`, already used the same way
  // from north-brief.tsx), not a fabricated one.
  const openAnomaly = anomalies?.find((one) => one.state === "new") ?? null;

  // An approval hold is a state, not a failure, so it goes to Gate untranslated
  // and everything else gets this screen's own copy for the refusal code.
  const shown =
    result?.problem && result.problem.code !== "approval_required"
      ? {
          title: l(`problem.${result.problem.code ?? ""}`),
          status: result.problem.status,
          ...(result.problem.detail === undefined ? {} : { detail: result.problem.detail }),
          ...(result.problem.requestId === undefined ? {} : { requestId: result.problem.requestId })
        }
      : (result?.problem ?? null);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-12 uppercase tracking-[0.14em] text-subtle">{l("kicker")}</span>
        <h1 className="font-serif text-22 leading-[1.2] text-text">{headline(anomalies, l)}</h1>
        <p className="max-w-[var(--measure-prose)] font-ui text-13 text-subtle">{l("intro")}</p>
        {openAnomaly ? (
          <Link to={`/north/anomalies/${openAnomaly.id}`} className="w-fit font-ui text-13 text-accent underline">
            {l("headline.action")}
          </Link>
        ) : null}
        {/* The rule behind the deviation: after reading what moved, the next
            question is "who was watching for this". Withheld, not disabled,
            when the actor cannot read alert rules (ui.md §4 rule 2). */}
        {held.has("north:alerts:read") ? (
          <Link to="/north/alerts" className="w-fit font-ui text-13 text-accent underline">
            {l("alerts.link")}
          </Link>
        ) : null}
      </header>

      {shown ? <Gate problem={shown} l={l} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(`saved.${result.saved}`)}
        </p>
      ) : null}

      {/* The filter lives in the URL: a queue somebody is working is a link. */}
      <Form method="get" className="flex flex-wrap items-end gap-4">
        <Field label={l("filter")}>
          <Select
            name="state"
            defaultValue={state ?? ""}
            aria-label={l("filter")}
            options={[{ value: "", label: l("all") }, ...STATES.map((one) => ({ value: one, label: l(one) }))]}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {l("apply")}
        </Button>
      </Form>

      {anomalies === null ? (
        <Panel>
          <p className="font-ui text-13 text-subtle">{l("denied")}</p>
        </Panel>
      ) : anomalies.length === 0 ? (
        <EmptyState title={l("none.title")} body={l("none.body")} />
      ) : (
        <AutoGrid min="24rem">
          {anomalies.map((anomaly) => (
            <AnomalyCard
              key={anomaly.id}
              anomaly={anomaly}
              metric={byKey.get(anomaly.metricKey) ?? null}
              locale={locale}
              l={l}
              busy={busy}
              canAct={held.has(PERM.assign)}
              idempotencyKey={idempotencyKey}
            />
          ))}
        </AutoGrid>
      )}
    </div>
  );
}

function AnomalyCard({
  anomaly,
  metric,
  locale,
  l,
  busy,
  canAct,
  idempotencyKey
}: {
  anomaly: Anomaly;
  metric: Metric | null;
  locale: string;
  l: (key: string, vars?: Record<string, string>) => string;
  busy: boolean;
  canAct: boolean;
  idempotencyKey: string;
}) {
  const analysis = parsed<DriverAnalysis>(anomaly.driverAnalysisJson, {});
  const drivers = analysis.drivers ?? [];
  const name = metric ? metricName(metric, locale) : anomaly.metricKey;
  const open = anomaly.state === "new";

  return (
    <Panel
      module="north"
      eyebrow={name}
      lede={<Figure value={pct(anomaly.magnitude, locale) ?? "—"} unit={l("card.deviation")} tone={tone(anomaly.magnitude, metric?.direction)} />}
      actions={<Badge tone={open ? "warning" : "neutral"}>{l(anomaly.state)}</Badge>}
    >
      <div className="flex flex-col gap-4">
        <Provenance
          rows={[
            { label: l("card.window"), value: anomaly.window, mono: true },
            { label: l("card.expected"), value: num(anomaly.expected, locale), mono: true },
            { label: l("card.actual"), value: num(anomaly.actual, locale), mono: true },
            { label: l("card.detected"), value: <DateTime value={anomaly.detectedAt} locale={locale} /> },
            ...(anomaly.explainedBy ? [{ label: l("card.owner"), value: anomaly.explainedBy }] : [])
          ]}
        />

        <section className="flex flex-col gap-2">
          <h3 className="font-ui text-12 uppercase tracking-[0.14em] text-subtle">{l("drivers.title")}</h3>
          {drivers.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{l("drivers.none")}</p>
          ) : (
            <>
              <ul className="flex flex-col gap-2">
                {drivers.map((driver) => (
                  <li key={`${driver.dimension}:${driver.key}`} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-ui text-13 text-text">
                        {driver.key}
                        <span className="ms-2 font-mono text-11 uppercase tracking-[0.12em] text-subtle">
                          {driver.dimension}
                        </span>
                      </span>
                      <span className="font-mono text-12 tabular-nums text-subtle">
                        {pct(driver.contributionBps, locale) ?? "—"}
                      </span>
                    </div>
                    {/* Presentational: the number beside it is the accessible value. */}
                    <div aria-hidden="true" className="h-1 rounded-full bg-surface-2">
                      <div
                        className={
                          driver.contributionBps < 0
                            ? "h-1 rounded-full bg-danger motion-safe:transition-[width]"
                            : "h-1 rounded-full bg-success motion-safe:transition-[width]"
                        }
                        style={{ width: `${driverWidth(driver.contributionBps, drivers)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
          {/* Outside the drivers branch on purpose: a ratio has no additive
              decomposition and still has a named baseline, and "no breakdown
              was recorded" must not read as "nothing was compared". */}
          {analysis.method || analysis.baseline ? (
            <p className="font-mono text-11 uppercase tracking-[0.12em] text-subtle">
              {[
                analysis.method ? `${l("drivers.method")}: ${words(analysis.method)}` : null,
                analysis.baseline ? `${l("drivers.baseline")}: ${words(analysis.baseline)}` : null
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </section>

        {canAct ? (
          <Form method="post" className="flex flex-col gap-3 border-t border-border pt-3">
            <input type="hidden" name="id" value={anomaly.id} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <Field label={l("who.label")} hint={l("who.hint")}>
              <Input name="owner" required defaultValue={anomaly.explainedBy ?? ""} aria-label={l("who.label")} />
            </Field>
            <Field label={l("note.label")} hint={l("note.hint")}>
              <Input name="linked" defaultValue={anomaly.linkedActionRef ?? ""} aria-label={l("note.label")} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" name="intent" value="explain" disabled={busy}>
                {l("act.explain")}
              </Button>
              <Button type="submit" name="intent" value="own" variant="secondary" disabled={busy}>
                {l("act.own")}
              </Button>
              <Button type="submit" name="intent" value="dismiss" variant="ghost" disabled={busy}>
                {l("act.dismiss")}
              </Button>
            </div>
          </Form>
        ) : null}
      </div>
    </Panel>
  );
}

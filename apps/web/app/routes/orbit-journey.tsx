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
  Card,
  DateTime,
  EmptyState,
  Field,
  GuardrailNotice,
  Input,
  Select,
  Table,
  hueVar,
  renderSection,
  type BadgeTone,
  type Column,
  type Section
} from "@lyra/ui";
import { api, asRouteError, fetchMe, type Problem as ProblemShape } from "../api.server";
import { arrowFor, localeFrom } from "../i18n";
import { cloudflare } from "../context";
import { Gate } from "./staff";
import { ConfirmButton } from "../components/confirm";
import { ORBIT, labelsFrom, orbitPortals, refusal, safe, type Label, type Labels, type Page } from "./orbit-shared";

// The journey editor. Steps, the trigger, and the branches between them — as
// forms, because the graph the runtime reads is a list of nodes and a list of
// edges (apps/api/src/engines/orbit-journeys.ts), not a drawing.
//
// ponytail: no canvas library. Every edit here is one form post that reads the
// stored graph, applies one change, and writes the whole graph back. Slower per
// edit and completely inspectable; a canvas can come later over the same shape.

/* --------------------------------------------------------------- contract */

export interface JourneyNode {
  key: string;
  type: string;
  [extra: string]: unknown;
}

export interface JourneyEdge {
  from: string;
  to: string;
}

export interface JourneyGraph {
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  cooldownDays?: number;
}

export interface Journey {
  id: string;
  key: string;
  version: number;
  nameJson: unknown;
  graphJson: unknown;
  status: string;
  createdBy: string | null;
  createdAt: number;
}

/** Mirrors `orbit_journey_runs` (packages/db/src/schema/orbit.ts) as the generic
 *  CRUD resource returns it. The column is `state` — running|waiting|done|halted
 *  — and there is no `status`, so reading one drew an empty badge on every row. */
export interface JourneyRun {
  id: string;
  journeyId: string;
  customerId: string | null;
  node: string | null;
  state: string;
  nextAt: number | null;
  createdAt: number;
}

/** The step kinds this editor offers. Only `trigger` means anything to the
 *  runtime today (it is where a run starts); the rest are carried through to
 *  whatever executes them, so the list is additive, not a contract. */
export const NODE_TYPES = ["trigger", "send", "wait", "branch", "task", "exit"] as const;

export const STATUSES = ["draft", "active", "paused", "retired"] as const;

const KEY_SHAPE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** The graph column is hydrated to an object by the API; anything else is empty. */
export function readGraph(value: unknown): JourneyGraph {
  const raw = typeof value === "string" ? tryParse(value) : value;
  const shape = (raw ?? {}) as Partial<JourneyGraph>;
  return {
    nodes: Array.isArray(shape.nodes) ? shape.nodes : [],
    edges: Array.isArray(shape.edges) ? shape.edges : [],
    ...(typeof shape.cooldownDays === "number" ? { cooldownDays: shape.cooldownDays } : {})
  };
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export type MutateResult = { graph: JourneyGraph } | { code: string };

/**
 * One edit to the graph, as a pure function so the rules are testable without a
 * request. Refusals come back as a code the screen turns into a sentence.
 */
export function mutate(graph: JourneyGraph, intent: string, input: Record<string, string>): MutateResult {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];

  if (intent === "add-step") {
    const key = (input.key ?? "").trim();
    const type = input.type ?? "";
    if (!KEY_SHAPE.test(key)) return { code: "bad_key" };
    if (!NODE_TYPES.includes(type as (typeof NODE_TYPES)[number])) return { code: "bad_type" };
    if (nodes.some((node) => node.key === key)) return { code: "duplicate_key" };
    // One trigger: two starts would make where a run begins arbitrary.
    if (type === "trigger" && nodes.some((node) => node.type === "trigger")) return { code: "second_trigger" };
    return { graph: { ...graph, nodes: [...nodes, { key, type }], edges } };
  }

  if (intent === "remove-step") {
    const key = input.key ?? "";
    if (!nodes.some((node) => node.key === key)) return { code: "no_such_step" };
    return {
      graph: {
        ...graph,
        nodes: nodes.filter((node) => node.key !== key),
        edges: edges.filter((edge) => edge.from !== key && edge.to !== key)
      }
    };
  }

  if (intent === "link" || intent === "unlink") {
    const from = input.from ?? "";
    const to = input.to ?? "";
    const known = (key: string) => nodes.some((node) => node.key === key);
    if (!known(from) || !known(to)) return { code: "no_such_step" };
    if (intent === "unlink") {
      return {
        graph: { ...graph, nodes, edges: edges.filter((edge) => !(edge.from === from && edge.to === to)) }
      };
    }
    if (from === to) return { code: "self_link" };
    if (edges.some((edge) => edge.from === from && edge.to === to)) return { code: "duplicate_edge" };
    return { graph: { ...graph, nodes, edges: [...edges, { from, to }] } };
  }

  if (intent === "cooldown") {
    const days = Number(input.cooldownDays ?? "");
    if (!Number.isInteger(days) || days <= 0 || days > 365) return { code: "bad_cooldown" };
    return { graph: { ...graph, nodes, edges, cooldownDays: days } };
  }

  return { code: "unknown_intent" };
}

/** Where a run starts, exactly as the engine works it out. */
export function startsAt(graph: JourneyGraph): string | null {
  const trigger = graph.nodes.find((node) => node.type === "trigger");
  if (trigger) {
    const edge = graph.edges.find((candidate) => candidate.from === trigger.key);
    if (edge) return edge.to;
  }
  return graph.nodes[0]?.key ?? null;
}

/** What stops this journey going live. The cooldown floor is docs/17 ORB-051. */
export function blockers(graph: JourneyGraph): string[] {
  const found: string[] = [];
  if (!graph.cooldownDays || graph.cooldownDays <= 0) found.push("needsCooldown");
  if (graph.nodes.length === 0) found.push("needsSteps");
  if (!graph.nodes.some((node) => node.type === "trigger")) found.push("needsTrigger");
  const reachable = new Set(graph.edges.flatMap((edge) => [edge.from, edge.to]));
  if (graph.nodes.length > 1 && graph.nodes.some((node) => !reachable.has(node.key))) {
    found.push("hasOrphan");
  }
  return found;
}

/** What to say about readiness before the generic lede: blocked beats vague. */
export function journeyLede(blockerCount: number, hasStart: boolean, l: Label): string {
  if (!hasStart) return l("startsNowhere");
  if (blockerCount > 0) return l("ledeBlocked", { n: String(blockerCount) });
  return l("lede");
}

export function statusTone(status: string): BadgeTone {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  if (status === "retired") return "neutral";
  return "info";
}

export function nameOf(journey: Journey, locale: string): string {
  const raw = typeof journey.nameJson === "string" ? tryParse(journey.nameJson) : journey.nameJson;
  const names = (raw ?? {}) as Record<string, string>;
  return names[locale] ?? names.en ?? journey.key;
}

/* ------------------------------------------------------------------ labels */

export const LABELS: Labels = {
  en: {
    title: "Journey builder",
    lede: "Steps, the trigger, and the branches between them. Every edit is saved as you make it.",
    ledeBlocked: "{n} thing(s) keep this journey from starting.",
    version: "Version {n}",
    startsAt: "A run starts at {node}",
    startsNowhere: "This journey has no first step yet.",
    startHere: "First step",
    steps: "Steps",
    stepsBody: "The trigger is where a run starts. Everything else runs when a branch reaches it.",
    stepKey: "Step name",
    stepType: "Step kind",
    addStep: "Add step",
    removeStep: "Remove",
    removeStepConfirm: "Remove this step? Any step that routed into it loses that path, and conversations already on it stay where they are. Add the step again to undo.",
    branches: "Branches",
    branchesBody: "A branch says which step follows which. Add one line per path.",
    fromStep: "From",
    toStep: "To",
    link: "Add branch",
    unlink: "Remove branch",
    frequency: "Frequency cap",
    frequencyBody:
      "The shortest gap, in days, before the same customer can enter this journey again. It cannot be removed.",
    cooldownDays: "Days between entries",
    setCooldown: "Save cap",
    lifecycle: "Status",
    lifecycleBody: "Draft edits freely. Active means the runtime will start runs.",
    status: "Status",
    setStatus: "Change status",
    draft: "Draft",
    active: "Active",
    paused: "Paused",
    retired: "Retired",
    trigger: "Trigger",
    send: "Send a message",
    wait: "Wait",
    branch: "Branch",
    task: "Task for a person",
    exit: "Exit",
    running: "Running",
    waiting: "Waiting",
    done: "Done",
    halted: "Halted",
    runs: "Recent runs",
    runsBody: "Customers currently moving through this journey.",
    customer: "Customer",
    node: "At step",
    nextStep: "Next step due",
    started: "Started",
    noRuns: "No runs yet",
    noRunsBody: "Runs appear once the journey is active and something triggers it.",
    noSteps: "No steps yet",
    noStepsBody: "Add a trigger first, then the steps that follow it.",
    noBranches: "No branches yet",
    noBranchesBody: "Add a branch to say which step follows which.",
    blocked: "Not ready to go live",
    needsCooldown: "Set a frequency cap in days before this can be activated.",
    needsSteps: "Add at least one step.",
    needsTrigger: "Add a trigger step so a run knows where to start.",
    hasOrphan: "One or more steps have no branch into or out of them.",
    backToList: "All journeys",
    bad_key: "A step name uses lowercase letters, digits, dashes or underscores.",
    bad_type: "Pick a step kind from the list.",
    duplicate_key: "A step with that name already exists.",
    second_trigger: "A journey has one trigger.",
    no_such_step: "That step is not in this journey.",
    self_link: "A step cannot branch to itself.",
    duplicate_edge: "That branch already exists.",
    bad_cooldown: "The frequency cap is a whole number of days between 1 and 365.",
    bad_status: "Pick a status from the list.",
    cannot_activate: "Clear what is listed under the readiness notice before activating.",
    unknown_intent: "That control is not available.",
    approvalLink: "Open approvals",
    portalsTitle: "Public portals",
    portalsBody: "Where a \"send\" step can point a customer — the tenant's self-serve pages.",
    portalStorefront: "Storefront",
    portalRegister: "Self-registration",
    portalPartners: "Partner sign-up"
  },
  ar: {
    title: "منشئ الرحلات",
    lede: "الخطوات والمُشغِّل والتفرعات بينها. كل تعديل يُحفظ لحظة إجرائه.",
    ledeBlocked: "{n} أمر يمنع بدء هذه الرحلة.",
    version: "الإصدار {n}",
    startsAt: "تبدأ الرحلة عند {node}",
    startsNowhere: "لا توجد خطوة أولى لهذه الرحلة بعد.",
    startHere: "الخطوة الأولى",
    steps: "الخطوات",
    stepsBody: "المُشغِّل هو نقطة البداية. وما عداه ينفَّذ عندما يصل إليه تفرّع.",
    stepKey: "اسم الخطوة",
    stepType: "نوع الخطوة",
    addStep: "أضف خطوة",
    removeStep: "احذف",
    removeStepConfirm: "هل تريد حذف هذه الخطوة؟ ستفقد كل خطوة تؤدي إليها ذلك المسار، وتبقى المحادثات الموجودة عليها في مكانها. أضف الخطوة مرة أخرى للتراجع.",
    branches: "التفرعات",
    branchesBody: "التفرّع يحدد الخطوة التالية لكل خطوة. أضف سطرًا لكل مسار.",
    fromStep: "من",
    toStep: "إلى",
    link: "أضف تفرّعًا",
    unlink: "احذف التفرّع",
    frequency: "حد التكرار",
    frequencyBody: "أقصر فترة بالأيام قبل أن يدخل العميل نفسه هذه الرحلة مرة أخرى. لا يمكن إزالته.",
    cooldownDays: "الأيام بين الدخولين",
    setCooldown: "احفظ الحد",
    lifecycle: "الحالة",
    lifecycleBody: "المسودة تُعدَّل بحرية. النشطة تعني أن النظام سيبدأ رحلات فعلية.",
    status: "الحالة",
    setStatus: "غيّر الحالة",
    draft: "مسودة",
    active: "نشطة",
    paused: "متوقفة مؤقتًا",
    retired: "مسحوبة",
    trigger: "مُشغِّل",
    send: "أرسل رسالة",
    wait: "انتظار",
    branch: "تفرّع",
    task: "مهمة لموظف",
    exit: "خروج",
    running: "قيد التنفيذ",
    waiting: "بالانتظار",
    done: "مكتملة",
    halted: "متوقفة",
    runs: "الرحلات الأخيرة",
    runsBody: "العملاء الذين يتحركون داخل هذه الرحلة الآن.",
    customer: "العميل",
    node: "عند الخطوة",
    nextStep: "الخطوة التالية",
    started: "البداية",
    noRuns: "لا رحلات بعد",
    noRunsBody: "تظهر الرحلات بعد تنشيط الرحلة ووقوع ما يُشغِّلها.",
    noSteps: "لا خطوات بعد",
    noStepsBody: "أضف مُشغِّلًا أولًا، ثم الخطوات التي تليه.",
    noBranches: "لا تفرعات بعد",
    noBranchesBody: "أضف تفرّعًا لتحديد الخطوة التالية.",
    blocked: "غير جاهزة للتنشيط",
    needsCooldown: "حدّد حد التكرار بالأيام قبل التنشيط.",
    needsSteps: "أضف خطوة واحدة على الأقل.",
    needsTrigger: "أضف خطوة مُشغِّل ليعرف النظام نقطة البداية.",
    hasOrphan: "خطوة أو أكثر بلا تفرّع داخل إليها أو خارج منها.",
    backToList: "كل الرحلات",
    bad_key: "اسم الخطوة يستخدم حروفًا صغيرة أو أرقامًا أو شرطات.",
    bad_type: "اختر نوع الخطوة من القائمة.",
    duplicate_key: "توجد خطوة بهذا الاسم بالفعل.",
    second_trigger: "للرحلة مُشغِّل واحد.",
    no_such_step: "هذه الخطوة ليست في الرحلة.",
    self_link: "لا يمكن للخطوة أن تتفرّع إلى نفسها.",
    duplicate_edge: "هذا التفرّع موجود بالفعل.",
    bad_cooldown: "حد التكرار عدد صحيح من الأيام بين ١ و٣٦٥.",
    bad_status: "اختر حالة من القائمة.",
    cannot_activate: "عالج ما ورد في تنبيه الجاهزية قبل التنشيط.",
    unknown_intent: "هذا الإجراء غير متاح.",
    approvalLink: "افتح الموافقات",
    portalsTitle: "البوابات العامة",
    portalsBody: "الوجهة التي يمكن لخطوة \"إرسال\" توجيه العميل إليها: صفحات الخدمة الذاتية الخاصة بالمستأجر.",
    portalStorefront: "واجهة المتجر",
    portalRegister: "التسجيل الذاتي",
    portalPartners: "تسجيل الشركاء"
  }
};

export function labelsIn(locale: string): Label {
  return labelsFrom(LABELS, locale);
}

/* ------------------------------------------------------------------ loader */

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const me = await fetchMe(env, request).catch(asRouteError);
  const held = new Set(me.permissions);
  const journey = await api<Journey>(`/v1/orbit/journeys/${params.id}`, opts).catch(asRouteError);
  const runs = held.has(ORBIT.runs)
    ? await safe(
        () =>
          api<Page<JourneyRun>>(
            `/v1/orbit/journey-runs?journeyId=${encodeURIComponent(journey.id)}&sort=nextAt&order=asc&limit=20`,
            opts
          ),
        { data: [] } as Page<JourneyRun>
      )
    : ({ data: [] } as Page<JourneyRun>);

  return {
    locale: localeFrom(request),
    nonce: crypto.randomUUID(),
    may: { edit: held.has(ORBIT.journeysWrite) },
    tenantSlug: me.tenant.slug,
    journey,
    graph: readGraph(journey.graphJson),
    runs: runs.data
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: ProblemShape | null;
  /** A refusal this screen worked out itself, as a label key. */
  error: string | null;
  saved: boolean;
}

const nothing: ActionResult = { problem: null, error: null, saved: false };

export async function action({ request, params, context }: ActionFunctionArgs): Promise<ActionResult> {
  const env = context.get(cloudflare).env;
  const opts = { env, request };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("nonce") ?? crypto.randomUUID());

  const write = async (body: Record<string, unknown>): Promise<ActionResult> => {
    try {
      await api(`/v1/orbit/journeys/${params.id}`, {
        ...opts,
        method: "PATCH",
        headers: { "idempotency-key": key },
        body
      });
      return { ...nothing, saved: true };
    } catch (error) {
      return { ...nothing, problem: refusal(error) };
    }
  };

  if (intent === "status") {
    const status = String(form.get("status") ?? "");
    if (!STATUSES.includes(status as (typeof STATUSES)[number])) return { ...nothing, error: "bad_status" };
    if (status === "active") {
      // Activating is what makes the runtime send things, so the readiness
      // rules are checked here rather than after the fact. The frequency cap is
      // also enforced server-side (ORB-051) — this is the earlier, kinder no.
      let current: Journey;
      try {
        current = await api<Journey>(`/v1/orbit/journeys/${params.id}`, opts);
      } catch (error) {
        return { ...nothing, problem: refusal(error) };
      }
      if (blockers(readGraph(current.graphJson)).length > 0) {
        return { ...nothing, error: "cannot_activate" };
      }
    }
    return write({ status });
  }

  if (!["add-step", "remove-step", "link", "unlink", "cooldown"].includes(intent)) {
    return { ...nothing, error: "unknown_intent" };
  }

  // Read, apply one change, write the whole graph back. The read is what keeps
  // two operators from writing over each other's steps with a stale copy.
  let current: Journey;
  try {
    current = await api<Journey>(`/v1/orbit/journeys/${params.id}`, opts);
  } catch (error) {
    return { ...nothing, problem: refusal(error) };
  }

  const input = Object.fromEntries(
    ["key", "type", "from", "to", "cooldownDays"].map((field) => [field, String(form.get(field) ?? "")])
  );
  const outcome = mutate(readGraph(current.graphJson), intent, input);
  if ("code" in outcome) return { ...nothing, error: outcome.code };
  return write({ graphJson: outcome.graph });
}

/** `orbitPortals`'s three keys, each to the label naming it. */
const PORTAL_LABEL_KEY: Record<string, string> = {
  storefront: "portalStorefront",
  register: "portalRegister",
  partners: "portalPartners"
};

/* --------------------------------------------------------------- component */

export default function JourneyBuilder() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const l = labelsIn(loaded.locale);
  const busy = navigation.state === "submitting";
  const graph = loaded.graph;
  const start = startsAt(graph);
  const notReady = blockers(graph);
  const stepOptions = graph.nodes.map((node) => ({ value: node.key, label: node.key }));
  const portals = orbitPortals(loaded.tenantSlug);
  const portalSection: Section = {
    kind: "kv",
    title: l("portalsTitle"),
    items: portals.map((p) => ({ label: l(PORTAL_LABEL_KEY[p.key]!), value: p.path, hue: hueVar("orbit"), font: "" }))
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="page-title">{nameOf(loaded.journey, loaded.locale)}</h1>
          <p className="font-ui text-13 text-muted">{journeyLede(notReady.length, start !== null, l)}</p>
          <p className="font-ui text-12 text-subtle">
            <span className="font-mono">{loaded.journey.key}</span>{" "}
            {l("version", { n: String(loaded.journey.version) })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone={statusTone(loaded.journey.status)}>{l(loaded.journey.status)}</Badge>
          <Link to="/orbit?tab=journeys" className="font-ui text-13 text-accent underline underline-offset-2">
            {l("backToList")}
          </Link>
        </div>
      </header>

      {result?.error ? (
        <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 p-3">
          <p className="font-ui text-13 text-text">{l(result.error)}</p>
        </div>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}
      {result?.saved ? (
        <div role="status" className="rounded-md border border-success/40 bg-success/10 p-3">
          <p className="font-ui text-13 text-text">{l("saved")}</p>
        </div>
      ) : null}

      {notReady.length > 0 ? (
        <GuardrailNotice
          title={l("blocked")}
          tone="warning"
          reason={notReady.map((code) => l(code)).join(" ")}
        />
      ) : null}

      <p className="font-ui text-13 text-muted">
        {start ? l("startsAt", { node: start }) : l("startsNowhere")}
      </p>

      <div className="flex flex-col gap-2">
        <p className="font-ui text-12 text-subtle">{l("portalsBody")}</p>
        {renderSection(portalSection, "orbit")}
        <div className="flex flex-wrap gap-4">
          {portals.map((p) => (
            <Link key={p.key} to={p.path} className="font-ui text-13 text-accent underline underline-offset-2">
              {l(PORTAL_LABEL_KEY[p.key]!)}
            </Link>
          ))}
        </div>
      </div>

      <Card title={l("steps")} description={l("stepsBody")}>
        {graph.nodes.length === 0 ? (
          <EmptyState title={l("noSteps")} body={l("noStepsBody")} />
        ) : (
          <ol className="flex flex-col gap-2">
            {graph.nodes.map((node) => (
              <li
                key={node.key}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-2 p-3"
              >
                <span className="flex items-center gap-2">
                  <Badge tone={node.type === "trigger" ? "accent" : "neutral"} size="sm">
                    {l(node.type)}
                  </Badge>
                  <span className="font-mono text-12 text-text">{node.key}</span>
                  {node.key === start ? (
                    <Badge tone="info" size="sm">
                      {l("startHere")}
                    </Badge>
                  ) : null}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-ui text-12 text-subtle">
                    {graph.edges.filter((edge) => edge.from === node.key).map((edge) => edge.to).join(", ")}
                  </span>
                  {loaded.may.edit ? (
                    <Form method="post" replace>
                      <input type="hidden" name="intent" value="remove-step" />
                      <input type="hidden" name="key" value={node.key} />
                      <input type="hidden" name="nonce" value={`remove:${loaded.nonce}:${node.key}`} />
                      <ConfirmButton
                        type="submit"
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        // Every step's button says "Remove". Which step it removes
                        // is only visible on screen, so name it for the ones who
                        // are not looking at the screen.
                        aria-label={`${l("removeStep")}: ${node.key}`}
                        // The dialog names the step too: by the time it opens, the
                        // row that said which one is behind it.
                        message={`${l("removeStepConfirm")}\n\n${node.key}`}
                      >
                        {l("removeStep")}
                      </ConfirmButton>
                    </Form>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        )}

        {loaded.may.edit ? (
          <Form method="post" replace className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="add-step" />
            <input type="hidden" name="nonce" value={`add:${loaded.nonce}`} />
            <Field label={l("stepKey")}>
              <Input name="key" required pattern="[a-z0-9][a-z0-9_-]*" />
            </Field>
            <Field label={l("stepType")}>
              <Select
                name="type"
                aria-label={l("stepType")}
                defaultValue="send"
                options={NODE_TYPES.map((value) => ({ value, label: l(value) }))}
              />
            </Field>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? l("working") : l("addStep")}
            </Button>
          </Form>
        ) : null}
      </Card>

      <Card title={l("branches")} description={l("branchesBody")}>
        {graph.edges.length === 0 ? (
          <EmptyState title={l("noBranches")} body={l("noBranchesBody")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {graph.edges.map((edge) => (
              <li
                key={`${edge.from}->${edge.to}`}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-1 p-3"
              >
                <span className="font-mono text-12 text-text">
                  {edge.from} <span aria-hidden="true">{arrowFor(loaded.locale)}</span> {edge.to}
                </span>
                {loaded.may.edit ? (
                  <Form method="post" replace>
                    <input type="hidden" name="intent" value="unlink" />
                    <input type="hidden" name="from" value={edge.from} />
                    <input type="hidden" name="to" value={edge.to} />
                    <input type="hidden" name="nonce" value={`unlink:${loaded.nonce}:${edge.from}:${edge.to}`} />
                    <Button
                      type="submit"
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`${l("unlink")}: ${edge.from} ${arrowFor(loaded.locale)} ${edge.to}`}
                    >
                      {l("unlink")}
                    </Button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {loaded.may.edit && stepOptions.length > 1 ? (
          <Form method="post" replace className="mt-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="link" />
            <input type="hidden" name="nonce" value={`link:${loaded.nonce}`} />
            <Field label={l("fromStep")}>
              <Select name="from" aria-label={l("fromStep")} options={stepOptions} />
            </Field>
            <Field label={l("toStep")}>
              <Select name="to" aria-label={l("toStep")} options={stepOptions} />
            </Field>
            <Button type="submit" size="sm" disabled={busy}>
              {l("link")}
            </Button>
          </Form>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={l("frequency")} description={l("frequencyBody")}>
          <Form method="post" replace className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="cooldown" />
            <input type="hidden" name="nonce" value={`cooldown:${loaded.nonce}`} />
            <Field label={l("cooldownDays")}>
              <Input
                name="cooldownDays"
                type="number"
                min={1}
                max={365}
                step={1}
                required
                defaultValue={graph.cooldownDays ?? ""}
                disabled={!loaded.may.edit}
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm" disabled={busy || !loaded.may.edit}>
              {l("setCooldown")}
            </Button>
          </Form>
        </Card>

        <Card title={l("lifecycle")} description={l("lifecycleBody")}>
          <Form method="post" replace className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="status" />
            <input type="hidden" name="nonce" value={`status:${loaded.nonce}`} />
            <Field label={l("status")}>
              <Select
                name="status"
                aria-label={l("status")}
                defaultValue={loaded.journey.status}
                options={STATUSES.map((value) => ({ value, label: l(value) }))}
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm" disabled={busy || !loaded.may.edit}>
              {l("setStatus")}
            </Button>
          </Form>
        </Card>
      </div>

      <Card title={l("runs")} description={l("runsBody")}>
        {loaded.runs.length === 0 ? (
          <EmptyState title={l("noRuns")} body={l("noRunsBody")} />
        ) : (
          <Table
            caption={l("runs")}
            rows={loaded.runs}
            rowKey={(row) => row.id}
            density="compact"
            columns={[
              { key: "customerId", header: l("customer"), render: (row) => row.customerId ?? "—" },
              { key: "node", header: l("node"), render: (row) => row.node ?? "—" },
              {
                key: "state",
                header: l("status"),
                render: (row) => <Badge tone={row.state === "halted" ? "danger" : "neutral"}>{l(row.state)}</Badge>
              },
              {
                key: "nextAt",
                header: l("nextStep"),
                render: (row) =>
                  row.nextAt ? <DateTime value={row.nextAt} locale={loaded.locale} relative /> : "—"
              },
              {
                key: "createdAt",
                header: l("started"),
                render: (row) => <DateTime value={row.createdAt} locale={loaded.locale} precision="day" />
              }
            ] satisfies Column<JourneyRun>[]}
          />
        )}
      </Card>
    </div>
  );
}

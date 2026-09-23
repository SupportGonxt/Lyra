import {
  Form,
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
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  Input,
  KPIWall,
  PageHeader,
  ProgressBar,
  Stat,
  Table,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { RefPicker, type RefOption } from "../components/ref-picker";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { Problem } from "./module";
import { Gate } from "./staff";
import { useShellData } from "./workspace";
import { labelsFrom } from "./detail-kit";

// The one workspace that is not tenant-scoped (ADR-0029): how every tenant is
// doing, which capability flags are live, and who is standing in a customer's
// shoes right now. Reads fan out per tenant on the API side; nothing here
// queries across tenants.

/* --------------------------------------------------------------- contract */

export const PERM = {
  read: "admin:diagnostics:read",
  flagsRead: "admin:flags:read",
  flagsWrite: "admin:flags:write",
  impersonate: "core:impersonate:use"
} as const;

export interface TenantHealth {
  tenantId: string;
  outboxPending: number;
  dlqDepth: number;
  pendingApprovals: number;
}

export interface Slo {
  id: string;
  key: string;
  description: string;
  module: string;
  targetPercent: number;
  windowDays: number;
  actualPercent: number;
  burnPercent: number;
}

export interface PlatformIncident {
  id: string;
  tenantId: string;
  severity: string;
  title: string;
  state: string;
  createdAt: number;
}

export interface Deployment {
  id: string;
  environment: string;
  workerName: string;
  version: string;
  status: string;
  deployedBy: string;
  deployedAt: number;
}

export interface FeatureFlag {
  id: string;
  key: string;
  description: string;
  enabled: boolean;
  rolloutPercent: number;
  updatedBy: string;
  updatedAt: number;
}

export interface ImpersonationSession {
  id: string;
  tenantId: string;
  targetUserId: string;
  reason: string;
  startedAt: number;
  expiresAt: number;
}

/* ---------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Platform staff",
    intro: "How every tenant is doing, which capabilities are live, and who is standing in for a customer.",
    deniedTitle: "You cannot read platform diagnostics",
    introDlq: "{dlq} dead letter(s) across {tenants} tenant(s) — that queue needs a look now.",
    introWaiting: "{outbox} event(s) and {approvals} decision(s) waiting across {tenants} tenant(s).",
    introClear: "All {tenants} tenant(s) are clear — nothing waiting, no dead letters.",

    kpiTenants: "Active tenants",
    kpiOutbox: "Events waiting",
    kpiDlq: "Dead letters",
    kpiApprovals: "Decisions waiting",
    snapshotHint: "Last metric snapshot",
    snapshotNever: "No snapshot yet",

    healthTitle: "Tenant health",
    healthCaption: "Queue depth and waiting decisions, per tenant",
    colTenant: "Tenant",
    colOutbox: "Outbox",
    colDlq: "Dead letters",
    colApprovals: "Waiting",
    healthEmpty: "No active tenants",
    healthEmptyBody: "No tenant is provisioned on this deployment yet, so there is nothing to report health on.",

    sloTitle: "Service levels",
    sloCaption: "Target against measured, with error budget burned",
    colSlo: "Objective",
    colModule: "Area",
    colTargetPct: "Target",
    colActual: "Measured",
    colBurn: "Budget burned",
    colWindow: "Window",
    sloEmpty: "No objectives defined",
    sloEmptyBody: "No service objective is defined, so nothing here is being measured against a target.",

    incidentsTitle: "Outages",
    incidentsCaption: "Operational incidents raised in any tenant",
    colIncident: "Incident",
    colSeverity: "Severity",
    colState: "State",
    colOpened: "Opened",
    incidentsEmpty: "No open outages",
    incidentsEmptyBody: "Nothing is degraded right now. Open incidents appear here the moment one is declared.",

    deploysTitle: "Deployments",
    deploysCaption: "What shipped where, and when",
    colEnv: "Environment",
    colWorker: "Worker",
    colVersion: "Version",
    colDeployed: "Deployed",
    colBy: "By",
    deploysEmpty: "No deployments recorded",
    deploysEmptyBody: "No release has been recorded against this deployment yet.",

    flagsTitle: "Capability flags",
    flagsCaption: "Global switches, with the share of tenants they reach",
    colFlag: "Key",
    colDescription: "What it does",
    colEnabled: "Live",
    colRollout: "Rollout",
    colUpdated: "Changed",
    flagsEmpty: "No flags yet",
    flagsEmptyBody: "No feature flag exists yet. Use the form below to add the first one.",
    flagsShut: "You cannot read capability flags",
    flagOn: "Live",
    flagOff: "Off",
    enable: "Turn on",
    disable: "Turn off",
    saveRollout: "Save",

    createFlagTitle: "New flag",
    fieldKey: "Key",
    fieldDescription: "What it does",
    fieldRollout: "Rollout percent",
    createFlag: "Create flag",

    impersonateTitle: "Standing in for a customer",
    impersonateCaption: "Time-boxed, approved by a second operator, and audited end to end",
    impersonateShut: "You cannot stand in for a customer",
    activeTitle: "Your live sessions",
    colTarget: "Standing in for",
    colStarted: "Started",
    colExpires: "Expires",
    colReason: "Reason",
    endSession: "End session",
    noSessions: "No live session",
    noSessionsBody: "Nobody is impersonating a tenant right now. Start a session with the form below.",
    fieldTargetUser: "User to stand in for",
    fieldReason: "Why",
    confirmImpersonate: "I understand this is recorded against my name",
    startImpersonation: "Request session",


    errKeyRequired: "Give the flag a key",
    errDescriptionRequired: "Say what the flag does",
    errRolloutRange: "Rollout has to be between 0 and 100",
    errTargetRequired: "Name the user to stand in for",
    errReasonRequired: "Say why",
    errConfirmRequired: "Tick the box to go ahead",

    savedFlag: "Flag created",
    savedToggle: "Flag changed",
    savedStart: "Session started",
    savedEnd: "Session ended"
  },
  ar: {
    title: "فريق المنصة",
    intro: "حال كل مستأجر، وأي القدرات مفعّلة، ومن ينوب عن عميل الآن.",
    deniedTitle: "لا يمكنك قراءة تشخيصات المنصة",
    introDlq: "{dlq} رسالة فاشلة عبر {tenants} مستأجر — قائمة الانتظار هذه تحتاج نظرة الآن.",
    introWaiting: "{outbox} حدث و{approvals} قرار في الانتظار عبر {tenants} مستأجر.",
    introClear: "كل {tenants} مستأجر بلا انتظار وبلا رسائل فاشلة.",

    kpiTenants: "المؤسسات النشطة",
    kpiOutbox: "أحداث في الانتظار",
    kpiDlq: "رسائل فاشلة",
    kpiApprovals: "قرارات في الانتظار",
    snapshotHint: "آخر لقطة قياس",
    snapshotNever: "لا لقطة بعد",

    healthTitle: "حال المؤسسات",
    healthCaption: "عمق الطوابير والقرارات المنتظرة لكل مستأجر",
    colTenant: "المؤسسة",
    colOutbox: "الصادر",
    colDlq: "الفاشلة",
    colApprovals: "منتظرة",
    healthEmpty: "لا مستأجرين نشطين",
    healthEmptyBody: "لا يوجد مستأجر مُهيّأ على هذا النشر بعد، لذا لا توجد حالة صحية لعرضها.",

    sloTitle: "مستويات الخدمة",
    sloCaption: "الهدف مقابل المقاس، مع نسبة الميزانية المستهلكة",
    colSlo: "الهدف",
    colModule: "المجال",
    colTargetPct: "المستهدف",
    colActual: "المقاس",
    colBurn: "الميزانية المستهلكة",
    colWindow: "النافذة",
    sloEmpty: "لا أهداف محددة",
    sloEmptyBody: "لم يُحدَّد أي هدف خدمة، لذا لا يُقاس شيء هنا مقابل هدف.",

    incidentsTitle: "الانقطاعات",
    incidentsCaption: "حوادث تشغيلية مسجلة في أي مستأجر",
    colIncident: "الحادث",
    colSeverity: "الخطورة",
    colState: "الحالة",
    colOpened: "فُتح",
    incidentsEmpty: "لا انقطاعات مفتوحة",
    incidentsEmptyBody: "لا يوجد تدهور حالياً. تظهر الانقطاعات المفتوحة هنا فور الإعلان عنها.",

    deploysTitle: "الإصدارات",
    deploysCaption: "ما نُشر وأين ومتى",
    colEnv: "البيئة",
    colWorker: "الخدمة",
    colVersion: "الإصدار",
    colDeployed: "نُشر",
    colBy: "بواسطة",
    deploysEmpty: "لا إصدارات مسجلة",
    deploysEmptyBody: "لم يُسجَّل أي إصدار على هذا النشر بعد.",

    flagsTitle: "مفاتيح القدرات",
    flagsCaption: "مفاتيح عامة، ونسبة المؤسسات التي تشملها",
    colFlag: "المفتاح",
    colDescription: "ما يفعله",
    colEnabled: "مفعّل",
    colRollout: "نسبة الإطلاق",
    colUpdated: "آخر تغيير",
    flagsEmpty: "لا مفاتيح بعد",
    flagsEmptyBody: "لا يوجد مفتاح ميزة بعد. استخدم النموذج أدناه لإضافة أول واحد.",
    flagsShut: "لا يمكنك قراءة مفاتيح القدرات",
    flagOn: "مفعّل",
    flagOff: "متوقف",
    enable: "تشغيل",
    disable: "إيقاف",
    saveRollout: "حفظ",

    createFlagTitle: "مفتاح جديد",
    fieldKey: "المفتاح",
    fieldDescription: "ما يفعله",
    fieldRollout: "نسبة الإطلاق",
    createFlag: "إنشاء مفتاح",

    impersonateTitle: "النيابة عن عميل",
    impersonateCaption: "محدودة بوقت، بموافقة مشغّل ثانٍ، ومسجلة من البداية للنهاية",
    impersonateShut: "لا يمكنك النيابة عن عميل",
    activeTitle: "جلساتك الجارية",
    colTarget: "النيابة عن",
    colStarted: "بدأت",
    colExpires: "تنتهي",
    colReason: "السبب",
    endSession: "إنهاء الجلسة",
    noSessions: "لا جلسة جارية",
    noSessionsBody: "لا أحد ينتحل صفة مستأجر حالياً. ابدأ جلسة من النموذج أدناه.",
    fieldTargetUser: "المستخدم المنوب عنه",
    fieldReason: "السبب",
    confirmImpersonate: "أفهم أن هذا يُسجل باسمي",
    startImpersonation: "طلب جلسة",


    errKeyRequired: "أعطِ المفتاح اسمًا",
    errDescriptionRequired: "اذكر ما يفعله المفتاح",
    errRolloutRange: "نسبة الإطلاق بين 0 و100",
    errTargetRequired: "حدد المستخدم المنوب عنه",
    errReasonRequired: "اذكر السبب",
    errConfirmRequired: "علّم الخيار للمتابعة",

    savedFlag: "أُنشئ المفتاح",
    savedToggle: "تغيّر المفتاح",
    savedStart: "بدأت الجلسة",
    savedEnd: "انتهت الجلسة"
  }
};

type Label = (key: string, vars?: Record<string, string>) => string;

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/** The one line under the title: dead letters first, then anything waiting, else all clear. */
export function platformLede(tenants: readonly TenantHealth[], l: Label): string {
  const totals = tenants.reduce(
    (sum, row) => ({
      outbox: sum.outbox + row.outboxPending,
      dlq: sum.dlq + row.dlqDepth,
      approvals: sum.approvals + row.pendingApprovals
    }),
    { outbox: 0, dlq: 0, approvals: 0 }
  );
  const vars = { tenants: String(tenants.length), outbox: String(totals.outbox), approvals: String(totals.approvals), dlq: String(totals.dlq) };
  if (totals.dlq > 0) return l("introDlq", vars);
  if (totals.outbox > 0 || totals.approvals > 0) return l("introWaiting", vars);
  return l("introClear", vars);
}

/* ------------------------------------------------------------------ loader */

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    read: held.has(PERM.read),
    flagsRead: held.has(PERM.flagsRead),
    flagsWrite: held.has(PERM.flagsWrite),
    impersonate: held.has(PERM.impersonate)
  };
  const idempotencyKey = crypto.randomUUID();

  const [overview, slo, incidents, deployments, flags, sessions, staff] = await Promise.all([
    may.read
      ? safe(() => api<{ tenants: TenantHealth[]; lastSnapshotAt: number | null }>("/v1/platform/ops/overview", { env, request }), {
          tenants: [],
          lastSnapshotAt: null
        })
      : { tenants: [] as TenantHealth[], lastSnapshotAt: null },
    may.read ? safe(() => api<{ slos: Slo[] }>("/v1/platform/slo", { env, request }), { slos: [] }) : { slos: [] },
    may.read
      ? safe(() => api<{ incidents: PlatformIncident[] }>("/v1/platform/incidents", { env, request }), { incidents: [] })
      : { incidents: [] },
    may.read
      ? safe(() => api<{ deployments: Deployment[] }>("/v1/platform/deployments", { env, request }), { deployments: [] })
      : { deployments: [] },
    may.flagsRead
      ? safe(() => api<{ flags: FeatureFlag[] }>("/v1/platform/flags", { env, request }), { flags: [] })
      : { flags: [] },
    may.impersonate
      ? safe(() => api<{ sessions: ImpersonationSession[] }>("/v1/platform/impersonation", { env, request }), { sessions: [] })
      : { sessions: [] },
    // Who an operator may act as, by name. The list is best-effort: a platform
    // role without `core:users:read` still gets the plain box and a pasted id.
    may.impersonate
      ? safe(() => api<{ data: { id: string; name: string }[] }>("/v1/staff/users?limit=200", { env, request }), { data: [] })
      : { data: [] }
  ]);

  return {
    may,
    tenants: overview.tenants,
    lastSnapshotAt: overview.lastSnapshotAt,
    slos: slo.slos,
    incidents: incidents.incidents,
    deployments: deployments.deployments,
    flags: flags.flags,
    sessions: sessions.sessions,
    people: staff.data.map((row) => ({ id: row.id, label: row.name })) as RefOption[],
    idempotencyKey
  };
}

/* ------------------------------------------------------------------ action */

interface ActionResult {
  problem: { title: string; status: number; code?: string; detail?: string } | null;
  error: string | null;
  saved: string | null;
}

const nothing: ActionResult = { problem: null, error: null, saved: null };
const wrong = (error: string): ActionResult => ({ ...nothing, error });

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { "idempotency-key": key } : {};

  const call = async (path: string, method: "POST" | "PATCH", body: unknown, saved: string): Promise<ActionResult> => {
    try {
      await api(path, { env, request, method, headers, body });
      return { ...nothing, saved };
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  };

  if (intent === "flag-create") {
    const flagKey = String(form.get("key") ?? "").trim();
    if (!flagKey) return wrong("errKeyRequired");
    const description = String(form.get("description") ?? "").trim();
    if (!description) return wrong("errDescriptionRequired");
    const rolloutRaw = String(form.get("rolloutPercent") ?? "").trim();
    const rolloutPercent = rolloutRaw ? Number(rolloutRaw) : 0;
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      return wrong("errRolloutRange");
    }
    return call("/v1/platform/flags", "POST", { key: flagKey, description, rolloutPercent }, "savedFlag");
  }

  if (intent === "flag-toggle") {
    const flagId = String(form.get("flagId") ?? "");
    const enabled = String(form.get("enabled") ?? "") === "on";
    return call(`/v1/platform/flags/${flagId}`, "PATCH", { enabled }, "savedToggle");
  }

  if (intent === "flag-rollout") {
    const flagId = String(form.get("flagId") ?? "");
    const rolloutPercent = Number(String(form.get("rolloutPercent") ?? "").trim());
    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      return wrong("errRolloutRange");
    }
    return call(`/v1/platform/flags/${flagId}`, "PATCH", { rolloutPercent }, "savedToggle");
  }

  if (intent === "impersonate-start") {
    if (String(form.get("confirm") ?? "") !== "on") return wrong("errConfirmRequired");
    const targetUserId = String(form.get("targetUserId") ?? "").trim();
    if (!targetUserId) return wrong("errTargetRequired");
    const reason = String(form.get("reason") ?? "").trim();
    if (!reason) return wrong("errReasonRequired");
    return call("/v1/platform/impersonation/start", "POST", { targetUserId, reason }, "savedStart");
  }

  if (intent === "impersonate-end") {
    const sessionId = String(form.get("sessionId") ?? "");
    return call(`/v1/platform/impersonation/${sessionId}/end`, "POST", {}, "savedEnd");
  }

  return { ...nothing, problem: { title: "unknown intent", status: 400 } };
}

/* ------------------------------------------------------------------- tones */

const SEVERITY_TONE: Record<string, BadgeTone> = {
  sev1: "danger",
  sev2: "danger",
  sev3: "warning",
  sev4: "neutral"
};

const STATE_TONE: Record<string, BadgeTone> = {
  open: "danger",
  mitigated: "warning",
  resolved: "success",
  postmortem: "info"
};

/* --------------------------------------------------------------- component */

export default function Platform() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";

  if (!loaded.may.read) {
    return (
      <div className="flex flex-col gap-6">
        <Header l={l} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const totals = loaded.tenants.reduce(
    (sum, row) => ({
      outbox: sum.outbox + row.outboxPending,
      dlq: sum.dlq + row.dlqDepth,
      approvals: sum.approvals + row.pendingApprovals
    }),
    { outbox: 0, dlq: 0, approvals: 0 }
  );

  const healthColumns: Array<Column<TenantHealth>> = [
    { key: "tenant", header: l("colTenant"), render: (row) => row.tenantId },
    { key: "outbox", header: l("colOutbox"), numeric: true, render: (row) => row.outboxPending },
    { key: "dlq", header: l("colDlq"), numeric: true, render: (row) => row.dlqDepth },
    { key: "approvals", header: l("colApprovals"), numeric: true, render: (row) => row.pendingApprovals }
  ];

  const sloColumns: Array<Column<Slo>> = [
    { key: "slo", header: l("colSlo"), render: (row) => row.description },
    { key: "module", header: l("colModule"), render: (row) => <Badge tone="neutral">{row.module}</Badge> },
    { key: "target", header: l("colTargetPct"), numeric: true, render: (row) => `${row.targetPercent}%` },
    { key: "actual", header: l("colActual"), numeric: true, render: (row) => `${row.actualPercent}%` },
    {
      key: "burn",
      header: l("colBurn"),
      render: (row) => (
        <ProgressBar
          value={row.burnPercent}
          label={`${row.burnPercent}%`}
          tone={row.burnPercent > 0 ? "danger" : "success"}
        />
      )
    },
    { key: "window", header: l("colWindow"), numeric: true, render: (row) => row.windowDays }
  ];

  const incidentColumns: Array<Column<PlatformIncident>> = [
    { key: "incident", header: l("colIncident"), render: (row) => row.title },
    { key: "tenant", header: l("colTenant"), render: (row) => row.tenantId },
    {
      key: "severity",
      header: l("colSeverity"),
      render: (row) => <Badge tone={SEVERITY_TONE[row.severity] ?? "neutral"}>{row.severity}</Badge>
    },
    {
      key: "state",
      header: l("colState"),
      render: (row) => <Badge tone={STATE_TONE[row.state] ?? "neutral"}>{row.state}</Badge>
    },
    { key: "opened", header: l("colOpened"), render: (row) => <DateTime value={row.createdAt} locale={locale} /> }
  ];

  const deployColumns: Array<Column<Deployment>> = [
    {
      key: "env",
      header: l("colEnv"),
      render: (row) => <Badge tone={row.environment === "production" ? "accent" : "neutral"}>{row.environment}</Badge>
    },
    { key: "worker", header: l("colWorker"), render: (row) => row.workerName },
    { key: "version", header: l("colVersion"), render: (row) => row.version },
    {
      key: "status",
      header: l("colStatus"),
      render: (row) => <Badge tone={row.status === "success" ? "success" : "danger"}>{row.status}</Badge>
    },
    { key: "by", header: l("colBy"), render: (row) => row.deployedBy },
    { key: "at", header: l("colDeployed"), render: (row) => <DateTime value={row.deployedAt} locale={locale} /> }
  ];

  const flagColumns: Array<Column<FeatureFlag>> = [
    { key: "flag", header: l("colFlag"), render: (row) => row.key },
    { key: "description", header: l("colDescription"), render: (row) => row.description },
    {
      key: "enabled",
      header: l("colEnabled"),
      render: (row) => (
        <Badge tone={row.enabled ? "success" : "neutral"}>{row.enabled ? l("flagOn") : l("flagOff")}</Badge>
      )
    },
    {
      key: "rollout",
      header: l("colRollout"),
      render: (row) =>
        loaded.may.flagsWrite ? (
          <Form method="post" className="flex items-end gap-2">
            <input type="hidden" name="intent" value="flag-rollout" />
            <input type="hidden" name="flagId" value={row.id} />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <Field label={l("fieldRollout")} labelHidden>
              <Input name="rolloutPercent" type="number" min={0} max={100} defaultValue={String(row.rolloutPercent)} />
            </Field>
            <Button type="submit" variant="ghost" disabled={busy}>
              {l("saveRollout")}
            </Button>
          </Form>
        ) : (
          `${row.rolloutPercent}%`
        )
    },
    { key: "updated", header: l("colUpdated"), render: (row) => <DateTime value={row.updatedAt} locale={locale} /> },
    {
      key: "act",
      header: l("colStatus"),
      headerLabel: l("colStatus"),
      render: (row) =>
        loaded.may.flagsWrite ? (
          <Form method="post">
            <input type="hidden" name="intent" value="flag-toggle" />
            <input type="hidden" name="flagId" value={row.id} />
            <input type="hidden" name="enabled" value={row.enabled ? "off" : "on"} />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <Button type="submit" variant={row.enabled ? "secondary" : "primary"} disabled={busy}>
              {row.enabled ? l("disable") : l("enable")}
            </Button>
          </Form>
        ) : null
    }
  ];

  const sessionColumns: Array<Column<ImpersonationSession>> = [
    { key: "target", header: l("colTarget"), render: (row) => row.targetUserId },
    { key: "tenant", header: l("colTenant"), render: (row) => row.tenantId },
    { key: "reason", header: l("colReason"), render: (row) => row.reason },
    { key: "started", header: l("colStarted"), render: (row) => <DateTime value={row.startedAt} locale={locale} /> },
    { key: "expires", header: l("colExpires"), render: (row) => <DateTime value={row.expiresAt} locale={locale} /> },
    {
      key: "act",
      header: l("endSession"),
      render: (row) => (
        <Form method="post">
          <input type="hidden" name="intent" value="impersonate-end" />
          <input type="hidden" name="sessionId" value={row.id} />
          <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
          <Button type="submit" variant="danger" disabled={busy}>
            {l("endSession")}
          </Button>
        </Form>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <Header l={l} lede={platformLede(loaded.tenants, l)} />

      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}
      {result?.error ? <Problem problem={{ title: l(result.error) }} /> : null}
      {result?.saved ? (
        <p role="status" className="font-ui text-13 text-success">
          {l(result.saved)}
        </p>
      ) : null}

      <KPIWall>
        <Stat label={l("kpiTenants")} value={loaded.tenants.length} />
        <Stat label={l("kpiOutbox")} value={totals.outbox} />
        <Stat label={l("kpiDlq")} value={totals.dlq} />
        <Stat
          label={l("kpiApprovals")}
          value={totals.approvals}
          hint={
            loaded.lastSnapshotAt === null ? (
              l("snapshotNever")
            ) : (
              <DateTime value={loaded.lastSnapshotAt} locale={locale} relative />
            )
          }
        />
      </KPIWall>

      <Card title={l("healthTitle")} description={l("healthCaption")}>
        <Table
          columns={healthColumns}
          rows={loaded.tenants}
          rowKey={(row) => row.tenantId}
          caption={l("healthCaption")}
          density="compact"
          empty={<EmptyState title={l("healthEmpty")} body={l("healthEmptyBody")} />}
        />
      </Card>

      <Card title={l("sloTitle")} description={l("sloCaption")}>
        <Table
          columns={sloColumns}
          rows={loaded.slos}
          rowKey={(row) => row.id}
          caption={l("sloCaption")}
          empty={<EmptyState title={l("sloEmpty")} body={l("sloEmptyBody")} />}
        />
      </Card>

      <Card title={l("incidentsTitle")} description={l("incidentsCaption")}>
        <Table
          columns={incidentColumns}
          rows={loaded.incidents}
          rowKey={(row) => row.id}
          caption={l("incidentsCaption")}
          empty={<EmptyState title={l("incidentsEmpty")} body={l("incidentsEmptyBody")} />}
        />
      </Card>

      <Card title={l("deploysTitle")} description={l("deploysCaption")}>
        <Table
          columns={deployColumns}
          rows={loaded.deployments}
          rowKey={(row) => row.id}
          density="compact"
          caption={l("deploysCaption")}
          empty={<EmptyState title={l("deploysEmpty")} body={l("deploysEmptyBody")} />}
        />
      </Card>

      <Card title={l("flagsTitle")} description={l("flagsCaption")}>
        {loaded.may.flagsRead ? (
          <div className="flex flex-col gap-5">
            <Table
              columns={flagColumns}
              rows={loaded.flags}
              rowKey={(row) => row.id}
              caption={l("flagsCaption")}
              empty={<EmptyState title={l("flagsEmpty")} body={l("flagsEmptyBody")} />}
            />
            {loaded.may.flagsWrite ? (
              <Form method="post" className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-end">
                <input type="hidden" name="intent" value="flag-create" />
                <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                <Field label={l("fieldKey")} required className="sm:w-56">
                  <Input name="key" required />
                </Field>
                <Field label={l("fieldDescription")} required className="sm:flex-1">
                  <Input name="description" required />
                </Field>
                <Field label={l("fieldRollout")} className="sm:w-32">
                  <Input name="rolloutPercent" type="number" min={0} max={100} defaultValue="0" />
                </Field>
                <Button type="submit" disabled={busy}>
                  {l("createFlag")}
                </Button>
              </Form>
            ) : null}
          </div>
        ) : (
          <EmptyState title={l("flagsShut")} body={t("error.forbidden")} />
        )}
      </Card>

      <Card title={l("impersonateTitle")} description={l("impersonateCaption")}>
        {loaded.may.impersonate ? (
          <div className="flex flex-col gap-5">
            <Table
              columns={sessionColumns}
              rows={loaded.sessions}
              rowKey={(row) => row.id}
              caption={l("activeTitle")}
              empty={<EmptyState title={l("noSessions")} body={l("noSessionsBody")} />}
            />
            <Form method="post" className="flex flex-col gap-3 border-t border-border pt-4">
              <input type="hidden" name="intent" value="impersonate-start" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <Field label={l("fieldTargetUser")} required className="sm:w-72">
                  <RefPicker name="targetUserId" options={loaded.people} required />
                </Field>
                <Field label={l("fieldReason")} required className="sm:flex-1">
                  <Input name="reason" required />
                </Field>
                <Button type="submit" variant="secondary" disabled={busy}>
                  {l("startImpersonation")}
                </Button>
              </div>
              <Checkbox name="confirm" label={l("confirmImpersonate")} />
            </Form>
          </div>
        ) : (
          <EmptyState title={l("impersonateShut")} body={t("error.forbidden")} />
        )}
      </Card>
    </div>
  );
}

function Header({ l, lede }: { l: Label; lede?: string }) {
  return lede ? (
    <PageHeader eyebrow={l("title")} title={lede} description={l("intro")} />
  ) : (
    <PageHeader title={l("title")} description={l("intro")} />
  );
}

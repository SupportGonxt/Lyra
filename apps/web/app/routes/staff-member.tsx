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
  Checkbox,
  DatePicker,
  DateTime,
  EmptyState,
  Field,
  Input,
  Table,
  Textarea,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe } from "../api.server";
import { cloudflare } from "../context";
import { translator } from "../i18n";
import { labelsFrom } from "./detail-kit";
import { PERM, Gate, userTone, type Role, type StaffOption, type StaffUser } from "./staff";
import { useShellData } from "./workspace";

// One member of staff: their roles (move), their onboarding checklist (join),
// and the offboard action (leave). All three touch permissions or other
// people's open work, so all three are engine calls, never a plain PATCH.

const STAFF_PERM = {
  ...PERM,
  rolesAssign: "core:roles:assign",
  onboardingRead: "core:onboarding:read",
  onboardingWrite: "core:onboarding:write",
  usersUpdate: "core:users:update"
} as const;

interface OnboardingStep {
  id: string;
  key: string;
  /** Already an object on the wire: `onboarding-steps` is a generic-CRUD
   *  resource (apps/api/src/resources.ts) and apps/api/src/crud.ts hydrate()s
   *  every `*Json` column before it is serialised. Parsing it again threw, and
   *  the catch handed the object itself to React as a child. */
  labelJson: Record<string, string>;
  seq: number;
  required: boolean;
  state: string;
  dueAt: number | null;
}

const STEP_TONES: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  pending: "neutral",
  in_progress: "info",
  done: "success",
  waived: "warning",
  failed: "danger"
};

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    back: "Back to staff",
    ledeRoles: "{count} role(s) held.",
    ledeRolesOnboarding: "{count} role(s) held. {done} of {total} required onboarding steps cleared.",
    rolesTitle: "Roles",
    rolesIntro: "Adding a role you do not hold yourself is refused by the server, not by this form.",
    reason: "Reason for this change",
    saveRoles: "Save role changes",
    onboardingTitle: "Onboarding",
    onboardingIntro: "The checklist that has to clear before this account is more than an invitation.",
    colStep: "Step",
    colState: "State",
    colDue: "Due",
    emptyOnboarding: "No checklist on file yet.",
    restart: "Re-run checklist",
    "step.pending": "Pending",
    "step.in_progress": "In progress",
    "step.done": "Done",
    "step.waived": "Waived",
    "step.failed": "Failed",
    offboardTitle: "Offboard",
    offboardIntro: "Every credential this account holds dies, and every open item gets a named owner.",
    lastDay: "Last working day",
    reassignTo: "Reassign open work to",
    offboardReason: "Reason",
    confirm: "I confirm this offboarding cannot be undone from here",
    offboard: "Offboard",
    offboarded: "Offboarded",
    offboardedBody: "{sessions} sessions and {keys} API keys revoked; {conversations} conversations and {tasks} tasks reassigned.",
    reasonRequired: "Explain why in a few words.",
    reassignRequired: "Choose who inherits this person's open work.",
    confirmRequired: "Confirm before submitting.",
    approvalLink: "Open approvals"
  },
  ar: {
    back: "العودة إلى الموظفين",
    ledeRoles: "{count} دور محتفظ به.",
    ledeRolesOnboarding: "{count} دور محتفظ به. اكتملت {done} من {total} خطوة تأهيل مطلوبة.",
    rolesTitle: "الأدوار",
    rolesIntro: "إضافة دور لا تملكه أنت يرفضه الخادم، وليس هذا النموذج.",
    reason: "سبب هذا التغيير",
    saveRoles: "حفظ تغييرات الأدوار",
    onboardingTitle: "التأهيل",
    onboardingIntro: "القائمة التي يجب إنجازها قبل أن يصبح هذا الحساب أكثر من دعوة.",
    colStep: "الخطوة",
    colState: "الحالة",
    colDue: "الاستحقاق",
    emptyOnboarding: "لا توجد قائمة تأهيل بعد.",
    restart: "إعادة تشغيل القائمة",
    "step.pending": "معلّق",
    "step.in_progress": "قيد التنفيذ",
    "step.done": "منجز",
    "step.waived": "متنازَل عنه",
    "step.failed": "فشل",
    offboardTitle: "إنهاء الخدمة",
    offboardIntro: "كل بيانات الاعتماد التي يملكها هذا الحساب تُلغى، وكل عمل مفتوح يُسند إلى مالك محدد.",
    lastDay: "آخر يوم عمل",
    reassignTo: "إسناد العمل المفتوح إلى",
    offboardReason: "السبب",
    confirm: "أؤكد أن إنهاء الخدمة هذا لا يمكن التراجع عنه من هنا",
    offboard: "إنهاء الخدمة",
    offboarded: "تم إنهاء الخدمة",
    offboardedBody: "تم إلغاء {sessions} جلسات و {keys} مفاتيح API؛ وإعادة إسناد {conversations} محادثات و {tasks} مهام.",
    reasonRequired: "اشرح السبب بإيجاز.",
    reassignRequired: "اختر من يرث العمل المفتوح لهذا الشخص.",
    confirmRequired: "أكّد قبل الإرسال.",
    approvalLink: "افتح الموافقات"
  }
};

// Resolved through detail-kit (docs/ui.md §7 P3-14) so the shared words behind
// the <Gate> notice — approvalTitle, approvalBody — are said rather than
// printed as their keys. A hand-rolled lookup here skipped SHARED entirely.
export const memberLabelsIn = labelsFrom(LABELS);

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return fallback;
    throw error;
  }
}

/** The line under the name and status: roles held, and onboarding progress once it is readable. */
export function memberLede(
  heldRoleKeys: readonly string[],
  steps: readonly OnboardingStep[],
  l: (key: string, vars?: Record<string, string>) => string
): string {
  const count = String(heldRoleKeys.length);
  if (steps.length === 0) return l("ledeRoles", { count });
  const required = steps.filter((step) => step.required);
  const done = required.filter((step) => step.state === "done" || step.state === "waived").length;
  return l("ledeRolesOnboarding", { count, done: String(done), total: String(required.length) });
}

function stepLabel(labelJson: OnboardingStep["labelJson"]): string {
  const names = labelJson ?? {};
  return names.en ?? Object.values(names)[0] ?? "";
}

export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    read: held.has(STAFF_PERM.read),
    rolesAssign: held.has(STAFF_PERM.rolesAssign),
    onboardingRead: held.has(STAFF_PERM.onboardingRead),
    onboardingWrite: held.has(STAFF_PERM.onboardingWrite),
    offboard: held.has(STAFF_PERM.usersUpdate) && held.has(STAFF_PERM.delegWrite)
  };
  const idempotencyKey = crypto.randomUUID();
  const shut = {
    may: { ...may, read: false },
    id,
    user: null as StaffUser | null,
    roles: [] as Role[],
    heldRoleKeys: [] as string[],
    steps: [] as OnboardingStep[],
    options: [] as StaffOption[],
    idempotencyKey
  };
  if (!may.read) return shut;

  const user = await safe(() => api<StaffUser>(`/v1/core/users/${id}`, { env, request }), null);
  if (!user) return shut;

  const [roles, userRoles, steps, options] = await Promise.all([
    safe(() => api<{ data: Role[] }>("/v1/core/roles?limit=100", { env, request }), { data: [] }),
    safe(
      () => api<{ data: { roleId: string }[] }>(`/v1/core/user-roles?userId=${id}&limit=100`, { env, request }),
      { data: [] }
    ),
    may.onboardingRead
      ? safe(
          () =>
            api<{ data: OnboardingStep[] }>(
              `/v1/core/onboarding-steps?subjectKind=staff&subjectRef=${encodeURIComponent(`users:${id}`)}&limit=100&sort=seq&order=asc`,
              { env, request }
            ),
          { data: [] }
        )
      : { data: [] },
    may.offboard
      ? safe(() => api<{ data: StaffOption[] }>("/v1/staff/users?limit=200", { env, request }), { data: [] })
      : { data: [] }
  ]);

  const heldIds = new Set(userRoles.data.map((r) => r.roleId));
  const heldRoleKeys = roles.data.filter((r) => heldIds.has((r as unknown as { id: string }).id)).map((r) => r.key);

  return {
    may,
    id,
    user,
    roles: roles.data,
    heldRoleKeys,
    steps: steps.data,
    options: options.data.filter((o) => o.id !== id),
    idempotencyKey
  };
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const id = params.id as string;
  const form = await request.formData();
  const nothing = { problem: null, error: null as string | null, offboarded: null as Record<string, number> | null };
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { "idempotency-key": key } : {};

  if (intent === "roles") {
    const reason = String(form.get("reason") ?? "").trim();
    if (reason.length < 3) return { ...nothing, error: "reasonRequired" };
    const add = form.getAll("add").map(String);
    const remove = form.getAll("remove").map(String);
    try {
      await api(`/v1/staff/users/${id}/roles`, {
        env,
        request,
        method: "POST",
        headers,
        body: { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}), reason }
      });
      return nothing;
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  if (intent === "restart-onboarding") {
    try {
      await api(`/v1/staff/users/${id}/onboarding`, { env, request, method: "POST", headers, body: {} });
      return nothing;
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  if (intent === "offboard") {
    if (String(form.get("confirm") ?? "") !== "on") return { ...nothing, error: "confirmRequired" };
    const reassignTo = String(form.get("reassignTo") ?? "").trim();
    if (!reassignTo) return { ...nothing, error: "reassignRequired" };
    const lastDayRaw = String(form.get("lastDay") ?? "");
    const reason = String(form.get("reason") ?? "").trim();
    try {
      const out = await api<Record<string, number>>(`/v1/staff/users/${id}/offboard`, {
        env,
        request,
        method: "POST",
        headers,
        body: {
          lastDay: Date.parse(`${lastDayRaw}T00:00:00.000Z`),
          reassignTo,
          ...(reason ? { reason } : {})
        }
      });
      return { ...nothing, offboarded: out };
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  return { ...nothing, problem: { title: "unknown intent", status: 400 } };
}

export default function StaffMember() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = memberLabelsIn(locale);
  const busy = navigation.state !== "idle";

  if (!loaded.may.read || !loaded.user) {
    return (
      <div className="flex flex-col gap-6">
        <Link to="/admin/staff" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
          {l("back")}
        </Link>
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const user = loaded.user;
  const stepColumns: Array<Column<OnboardingStep>> = [
    { key: "step", header: l("colStep"), render: (row) => stepLabel(row.labelJson) },
    {
      key: "state",
      header: l("colState"),
      render: (row) => (
        <Badge tone={STEP_TONES[row.state] ?? "neutral"} size="sm" dot>
          {l(`step.${row.state}`)}
        </Badge>
      )
    },
    {
      key: "due",
      header: l("colDue"),
      render: (row) => (row.dueAt ? <DateTime value={row.dueAt} precision="day" /> : "—")
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <Link to="/admin/staff" className="font-ui text-13 text-accent underline-offset-2 hover:underline">
        {l("back")}
      </Link>

      <header className="flex flex-col gap-1">
        <h1 className="page-title">{user.name}</h1>
        <p className="font-ui text-13 text-muted">{user.email}</p>
        <p className="font-ui text-13 text-muted">{memberLede(loaded.heldRoleKeys, loaded.steps, l)}</p>
        <Badge tone={userTone(user.status)} size="sm" dot className="w-fit">
          {l(`status.${user.status}`)}
        </Badge>
      </header>

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      {loaded.may.rolesAssign ? (
        <Card title={l("rolesTitle")} description={l("rolesIntro")}>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="roles" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <div className="flex flex-wrap gap-4">
              {loaded.roles.map((role) => {
                const heldNow = loaded.heldRoleKeys.includes(role.key);
                return (
                  <Checkbox
                    key={role.id}
                    name={heldNow ? "remove" : "add"}
                    value={role.key}
                    defaultChecked={heldNow}
                    label={role.name}
                  />
                );
              })}
            </div>
            <Field label={l("reason")} required>
              <Input name="reason" required className="w-96" />
            </Field>
            <Button type="submit" loading={busy} className="self-start">
              {l("saveRoles")}
            </Button>
          </Form>
        </Card>
      ) : null}

      {loaded.may.onboardingRead ? (
        <Card title={l("onboardingTitle")} description={l("onboardingIntro")} padded={loaded.steps.length === 0}>
          {loaded.steps.length === 0 ? (
            <EmptyState title={l("onboardingTitle")} body={l("emptyOnboarding")} />
          ) : (
            <Table
              columns={stepColumns}
              rows={loaded.steps}
              rowKey={(row) => row.id}
              caption={l("onboardingTitle")}
            />
          )}
          {loaded.may.onboardingWrite ? (
            <Form method="post" className="p-4">
              <input type="hidden" name="intent" value="restart-onboarding" />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <Button type="submit" variant="secondary" size="sm" loading={busy}>
                {l("restart")}
              </Button>
            </Form>
          ) : null}
        </Card>
      ) : null}

      {result?.offboarded ? (
        <Card
          title={l("offboarded")}
          description={l("offboardedBody", {
            sessions: String(result.offboarded.sessionsRevoked ?? 0),
            keys: String(result.offboarded.apiKeysRevoked ?? 0),
            conversations: String(result.offboarded.conversationsReassigned ?? 0),
            tasks: String(result.offboarded.tasksReassigned ?? 0)
          })}
        />
      ) : null}

      {loaded.may.offboard ? (
        <Card title={l("offboardTitle")} description={l("offboardIntro")}>
          <datalist id="reassign-options">
            {loaded.options.map((o) => (
              <option key={o.id} value={o.id} label={o.name} />
            ))}
          </datalist>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="offboard" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <div className="flex flex-wrap gap-3">
              <Field label={l("lastDay")} required>
                <DatePicker name="lastDay" required />
              </Field>
              <Field label={l("reassignTo")} required>
                <Input name="reassignTo" list="reassign-options" required className="w-56" />
              </Field>
            </div>
            <Field label={l("offboardReason")}>
              <Textarea name="reason" rows={2} className="w-full max-w-prose" />
            </Field>
            <Checkbox name="confirm" value="on" label={l("confirm")} />
            <Button type="submit" variant="danger" loading={busy} className="self-start">
              {l("offboard")}
            </Button>
          </Form>
        </Card>
      ) : null}
    </div>
  );
}

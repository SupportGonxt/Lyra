import { useState } from "react";
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
  Money,
  MoneyField,
  PageHeader,
  Select,
  Table,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe, names } from "../api.server";
import { RefPicker, type RefOption } from "../components/ref-picker";
import { cloudflare } from "../context";
import { who, type Names } from "../names";
import { translator } from "../i18n";
import { Gate } from "./module";
import { useShellData } from "./workspace";
import { labelsFrom, type Label } from "./detail-kit";

// Gate is re-exported rather than duplicated: this file's version was byte-
// identical to routes/module.tsx's (UX audit 2026-08-10, gap G6), so a fix to
// one silently missed the other. One import, used below and by every screen
// that does `import { Gate } from "./staff"`.
export { Gate };

// Who is staff, what they may do, and who is standing in for whom while they
// are out (docs/06 §1). Invitation and delegation are consequential — they
// change who can approve what — so both are gated and audited by the engine;
// this screen only offers what a held permission allows.

/* --------------------------------------------------------------- contract */

export const PERM = {
  read: "core:users:read",
  invite: "core:users:create",
  rolesRead: "core:roles:read",
  teamsRead: "core:teams:read",
  delegRead: "core:delegations:read",
  delegWrite: "core:delegations:write"
} as const;

/** `scope.policyKeys` is a 41-key catalogue; picking one at a time belongs to a
 *  later iteration. For now a delegation scopes by module only. */
export const DELEGATION_MODULES = ["ledger", "axis", "core", "signal", "ai"] as const;

export const DELEGATION_REASONS = ["leave", "travel", "cover", "offboarding"] as const;

export interface StaffUser {
  id: string;
  email: string;
  phone: string | null;
  name: string;
  locale: string;
  status: string;
  authProvider: string;
  createdAt: number;
}

export interface Role {
  id: string;
  key: string;
  name: string;
}

export interface Team {
  id: string;
  name: string;
}

export interface StaffOption {
  id: string;
  name: string;
}

/** A row of `GET /v1/staff/delegations` — see apps/api/src/routes/staff.ts.
 *  That route is hand-written and returns the selected rows as they sit, so
 *  crud.ts `hydrate()` never runs and `scopeJson` arrives as text. */
export interface Delegation {
  id: string;
  fromUserId: string;
  toUserId: string;
  reason: string;
  scopeJson: string | null;
  maxAmountMinor: number | null;
  currency: string | null;
  startsAt: number;
  endsAt: number;
  status: string;
  createdAt: number;
}

export interface InviteResult extends StaffUser {
  /** How many onboarding steps the invite opened — a count, not the steps.
   *  Mirrors `inviteStaff` in apps/api/src/engines/staff.ts. */
  steps: number;
}

const USER_TONES: Record<string, BadgeTone> = { invited: "info", active: "success", suspended: "danger" };
const DELEG_TONES: Record<string, BadgeTone> = { active: "success", revoked: "danger", expired: "neutral" };

export function userTone(status: string): BadgeTone {
  return USER_TONES[status] ?? "neutral";
}

export function delegationTone(status: string): BadgeTone {
  return DELEG_TONES[status] ?? "neutral";
}

/** The one line under the title: headcount, and how many are covering for someone. */
export function staffLede(users: readonly StaffUser[], delegations: readonly Delegation[], l: Label): string {
  if (users.length === 0) return l("introEmpty");
  const active = delegations.filter((row) => row.status === "active").length;
  return l("introCount", { count: String(users.length), delegations: String(active) });
}

/* ----------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Staff",
    intro: "Who works here, what they are trusted with, and who is covering for whom.",
    deniedTitle: "You cannot read staff",
    introEmpty: "No one matches this workspace yet.",
    introCount: "{count} people, {delegations} active delegation(s) in place.",
    directoryTitle: "Directory",
    directoryCaption: "People with access to this workspace",
    apply: "Search",
    colName: "Name",
    colEmail: "Email",
    colJoined: "Joined",
    openFor: "Open {name}'s record",
    emptyDirectory: "No one matches this search.",
    inviteTitle: "Invite someone",
    inviteIntro: "They receive an invitation and start in the onboarding checklist.",
    email: "Email",
    name: "Name",
    locale: "Language",
    roles: "Roles",
    teams: "Teams",
    manager: "Manager",
    managerHint: "Optional — pick from the directory.",
    dueAt: "Due by",
    invite: "Send invitation",
    invited: "Invited",
    invitedBody: "{name} has been invited and is on the onboarding checklist.",
    delegationsTitle: "Delegations",
    delegationsIntro: "Standing in for someone while they are away — an approval taken under a delegation is capped at its own ceiling, and audited as such.",
    grantTitle: "Grant a delegation",
    from: "Delegating from",
    fromHint: "Leave blank to delegate your own authority.",
    to: "Delegate to",
    reason: "Reason",
    "reason.leave": "Leave",
    "reason.travel": "Travel",
    "reason.cover": "Cover",
    "reason.offboarding": "Offboarding",
    modules: "Modules covered",
    "module.ledger": "Ledger",
    "module.axis": "Axis",
    "module.core": "Core",
    "module.signal": "Signal",
    "module.ai": "AI",
    maxAmount: "Approval ceiling",
    maxAmountHint: "Optional. Leave blank for no ceiling.",
    currency: "Currency",
    startsAt: "Starts",
    endsAt: "Ends",
    confirm: "I confirm this delegation",
    grant: "Grant delegation",
    revoke: "Revoke",
    revokeConfirm: "I confirm revoking this delegation",
    colFrom: "From",
    colTo: "To",
    colReason: "Reason",
    colWindow: "Window",
    colCeiling: "Ceiling",
    colDelegState: "Status",
    statusFilter: "Status",
    delegationsCaption: "Delegations matching this status",
    emptyDelegations: "No delegations here yet.",
    "deleg.active": "Active",
    "deleg.revoked": "Revoked",
    "deleg.expired": "Expired",
    emailRequired: "Enter an email address.",
    nameRequired: "Enter a name.",
    roleRequired: "Choose at least one role.",
    toRequired: "Choose who is receiving this delegation.",
    reasonRequired: "Choose a reason.",
    currencyRequired: "A ceiling needs a currency.",
    confirmRequired: "Confirm before submitting.",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "الموظفون",
    intro: "من يعمل هنا، بماذا يُؤتمن، وعمّن ينوب.",
    deniedTitle: "لا يمكنك عرض الموظفين",
    introEmpty: "لا أحد في مساحة العمل هذه بعد.",
    introCount: "{count} شخص، {delegations} تفويض نشط قائم.",
    directoryTitle: "الدليل",
    directoryCaption: "الأشخاص الذين لديهم وصول إلى مساحة العمل هذه",
    apply: "بحث",
    colName: "الاسم",
    colEmail: "البريد الإلكتروني",
    colJoined: "تاريخ الانضمام",
    openFor: "افتح سجل {name}",
    emptyDirectory: "لا توجد مطابقة لهذا البحث.",
    inviteTitle: "دعوة شخص",
    inviteIntro: "سيتلقى دعوة ويبدأ في قائمة التأهيل.",
    email: "البريد الإلكتروني",
    name: "الاسم",
    locale: "اللغة",
    roles: "الأدوار",
    teams: "الفرق",
    manager: "المدير",
    managerHint: "اختياري — اختر من الدليل.",
    dueAt: "تاريخ الاستحقاق",
    invite: "إرسال الدعوة",
    invited: "تمت الدعوة",
    invitedBody: "تمت دعوة {name} وهو الآن في قائمة التأهيل.",
    delegationsTitle: "التفويضات",
    delegationsIntro: "النيابة عن شخص أثناء غيابه — أي موافقة تُتخذ بموجب تفويض تكون محدودة بسقفه الخاص، وتُدقَّق على هذا الأساس.",
    grantTitle: "منح تفويض",
    from: "التفويض من",
    fromHint: "اتركه فارغًا لتفويض صلاحيتك أنت.",
    to: "التفويض إلى",
    reason: "السبب",
    "reason.leave": "إجازة",
    "reason.travel": "سفر",
    "reason.cover": "تغطية",
    "reason.offboarding": "إنهاء الخدمة",
    modules: "الوحدات المشمولة",
    "module.ledger": "السجل المالي",
    "module.axis": "أكسِس",
    "module.core": "الأساس",
    "module.signal": "التسويق",
    "module.ai": "الذكاء الاصطناعي",
    maxAmount: "سقف الموافقة",
    maxAmountHint: "اختياري. اتركه فارغًا لعدم وجود سقف.",
    currency: "العملة",
    startsAt: "يبدأ",
    endsAt: "ينتهي",
    confirm: "أؤكد هذا التفويض",
    grant: "منح التفويض",
    revoke: "إلغاء",
    revokeConfirm: "أؤكد إلغاء هذا التفويض",
    colFrom: "من",
    colTo: "إلى",
    colReason: "السبب",
    colWindow: "المدة",
    colCeiling: "السقف",
    colDelegState: "الحالة",
    statusFilter: "الحالة",
    delegationsCaption: "التفويضات المطابقة لهذه الحالة",
    emptyDelegations: "لا توجد تفويضات هنا بعد.",
    "deleg.active": "نشط",
    "deleg.revoked": "ملغى",
    "deleg.expired": "منتهٍ",
    emailRequired: "أدخل عنوان بريد إلكتروني.",
    nameRequired: "أدخل الاسم.",
    roleRequired: "اختر دورًا واحدًا على الأقل.",
    toRequired: "اختر من يتلقى هذا التفويض.",
    reasonRequired: "اختر سببًا.",
    currencyRequired: "السقف يحتاج إلى عملة.",
    confirmRequired: "أكّد قبل الإرسال.",
    approvalLink: "افتح الموافقات"
  }
};

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) return fallback;
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const delegStatus = (url.searchParams.get("status") ?? "").trim();
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    read: held.has(PERM.read),
    invite: held.has(PERM.invite),
    delegRead: held.has(PERM.delegRead),
    delegWrite: held.has(PERM.delegWrite)
  };
  const idempotencyKey = crypto.randomUUID();
  const shut = {
    may: { ...may, read: false },
    q,
    delegStatus,
    users: [] as StaffUser[],
    roles: [] as Role[],
    teams: [] as Team[],
    options: [] as StaffOption[],
    delegations: [] as Delegation[],
    named: {} as Names,
    profileId: me.profile?.id ?? null,
    idempotencyKey
  };
  if (!may.read) return shut;

  const [users, roles, teams, options, delegations] = await Promise.all([
    safe(
      () => api<{ data: StaffUser[] }>(`/v1/core/users?${new URLSearchParams({ q, limit: "100" })}`, { env, request }),
      { data: [] }
    ),
    may.invite
      ? safe(() => api<{ data: Role[] }>("/v1/core/roles?limit=100", { env, request }), { data: [] })
      : { data: [] },
    may.invite
      ? safe(() => api<{ data: Team[] }>("/v1/core/teams?limit=100", { env, request }), { data: [] })
      : { data: [] },
    may.invite
      ? safe(() => api<{ data: StaffOption[] }>("/v1/staff/users?limit=200", { env, request }), { data: [] })
      : { data: [] },
    may.delegRead
      ? safe(
          () =>
            api<{ data: Delegation[] }>(
              `/v1/staff/delegations${delegStatus ? `?status=${delegStatus}` : ""}`,
              { env, request }
            ),
          { data: [] }
        )
      : { data: [] }
  ]);

  // A delegation names both sides by user id. The picker's option list covers
  // most of them, but it is only loaded for someone who may invite and it stops
  // at 200 — and the row that falls off the end printed a bare ULID at whoever
  // is deciding to revoke it.
  const named = await names(
    delegations.data.flatMap((row) => [row.fromUserId, row.toUserId]),
    { env, request }
  );

  return {
    may,
    q,
    delegStatus,
    users: users.data,
    roles: roles.data,
    teams: teams.data,
    options: options.data,
    delegations: delegations.data,
    named,
    profileId: me.profile?.id ?? null,
    idempotencyKey
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const nothing = { problem: null, error: null as string | null, invited: null as InviteResult | null };
  const intent = String(form.get("intent") ?? "");
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { "idempotency-key": key } : {};

  if (intent === "invite") {
    const email = String(form.get("email") ?? "").trim();
    if (!email) return { ...nothing, error: "emailRequired" };
    const name = String(form.get("name") ?? "").trim();
    if (!name) return { ...nothing, error: "nameRequired" };
    const roleKeys = form.getAll("roleKeys").map(String);
    if (roleKeys.length === 0) return { ...nothing, error: "roleRequired" };
    const teamIds = form.getAll("teamIds").map(String);
    const locale = String(form.get("locale") ?? "").trim();
    const managerId = String(form.get("managerId") ?? "").trim();
    const dueRaw = String(form.get("dueAt") ?? "").trim();
    const dueAt = dueRaw ? Date.parse(`${dueRaw}T00:00:00.000Z`) : undefined;

    try {
      const invited = await api<InviteResult>("/v1/staff/invitations", {
        env,
        request,
        method: "POST",
        headers,
        body: {
          email,
          name,
          roleKeys,
          ...(teamIds.length ? { teamIds } : {}),
          ...(locale ? { locale } : {}),
          ...(managerId ? { managerId } : {}),
          ...(dueAt !== undefined ? { dueAt } : {})
        }
      });
      return { ...nothing, invited };
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  if (intent === "grant") {
    if (String(form.get("confirm") ?? "") !== "on") return { ...nothing, error: "confirmRequired" };
    const toUserId = String(form.get("toUserId") ?? "").trim();
    if (!toUserId) return { ...nothing, error: "toRequired" };
    const reason = String(form.get("reason") ?? "").trim();
    if (!(DELEGATION_REASONS as readonly string[]).includes(reason)) return { ...nothing, error: "reasonRequired" };
    const fromUserId = String(form.get("fromUserId") ?? "").trim();
    const modules = form.getAll("modules").map(String);
    const currency = String(form.get("currency") ?? "").trim().toUpperCase();
    const maxAmountRaw = String(form.get("maxAmountMinor") ?? "").trim();
    if (maxAmountRaw && currency.length !== 3) return { ...nothing, error: "currencyRequired" };
    const startsRaw = String(form.get("startsAt") ?? "");
    const endsRaw = String(form.get("endsAt") ?? "");

    try {
      await api("/v1/staff/delegations", {
        env,
        request,
        method: "POST",
        headers,
        body: {
          ...(fromUserId ? { fromUserId } : {}),
          toUserId,
          reason,
          ...(modules.length ? { scope: { modules } } : {}),
          ...(maxAmountRaw ? { maxAmountMinor: Number(maxAmountRaw), currency } : {}),
          startsAt: Date.parse(startsRaw),
          endsAt: Date.parse(endsRaw)
        }
      });
      return nothing;
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  if (intent === "revoke") {
    if (String(form.get("confirm") ?? "") !== "on") return { ...nothing, error: "confirmRequired" };
    const id = String(form.get("delegationId") ?? "");
    try {
      await api(`/v1/staff/delegations/${id}/revoke`, { env, request, method: "POST", headers, body: {} });
      return nothing;
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  return { ...nothing, problem: { title: "unknown intent", status: 400 } };
}

/* --------------------------------------------------------------- component */

export default function Staff() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const people: RefOption[] = loaded.options.map((o) => ({ id: o.id, label: o.name }));
  const l = labelsIn(locale);
  // The money field's precision follows the currency beside it: 500 in JPY is
  // 500 minor units, in ZAR it is 50000.
  const [currency, setCurrency] = useState(shell?.currency ?? "ZAR");

  const busy = navigation.state !== "idle";

  if (!loaded.may.read) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const userColumns: Array<Column<StaffUser>> = [
    { key: "name", header: l("colName"), render: (row) => row.name },
    { key: "email", header: l("colEmail"), render: (row) => row.email },
    {
      key: "status",
      header: l("colStatus"),
      render: (row) => (
        <Badge tone={userTone(row.status)} size="sm" dot>
          {l(`status.${row.status}`)}
        </Badge>
      )
    },
    {
      key: "createdAt",
      header: l("colJoined"),
      render: (row) => <DateTime value={row.createdAt} precision="day" />
    },
    {
      key: "open",
      header: t("common.actions"),
      render: (row) => (
        <Link
          to={`/admin/staff/${row.id}`}
          aria-label={l("openFor", { name: row.name })}
          className="font-ui text-12 text-accent underline-offset-2 hover:underline"
        >
          {l("open")}
        </Link>
      )
    }
  ];

  const delegationColumns: Array<Column<Delegation>> = [
    { key: "fromUserId", header: l("colFrom"), render: (row) => nameOf(loaded.options, row.fromUserId, loaded.named) },
    { key: "toUserId", header: l("colTo"), render: (row) => nameOf(loaded.options, row.toUserId, loaded.named) },
    { key: "reason", header: l("colReason"), render: (row) => l(`reason.${row.reason}`) },
    {
      key: "window",
      header: l("colWindow"),
      render: (row) => (
        <span className="font-mono text-12">
          <DateTime value={row.startsAt} precision="day" /> – <DateTime value={row.endsAt} precision="day" />
        </span>
      )
    },
    {
      key: "ceiling",
      header: l("colCeiling"),
      numeric: true,
      render: (row) =>
        row.maxAmountMinor !== null && row.currency ? (
          <Money amountMinor={row.maxAmountMinor} currency={row.currency} locale={locale} />
        ) : (
          <span className="font-ui text-12 text-subtle">—</span>
        )
    },
    {
      key: "status",
      header: l("colDelegState"),
      render: (row) => (
        <Badge tone={delegationTone(row.status)} size="sm" dot>
          {l(`deleg.${row.status}`)}
        </Badge>
      )
    },
    {
      key: "revoke",
      header: t("common.actions"),
      render: (row) =>
        row.status === "active" && (loaded.may.delegWrite || row.fromUserId === loaded.profileId) ? (
          <Form method="post" className="flex items-center gap-2">
            <input type="hidden" name="intent" value="revoke" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <input type="hidden" name="delegationId" value={row.id} />
            <Checkbox name="confirm" value="on" label={l("revokeConfirm")} />
            <Button type="submit" variant="ghost" size="sm" loading={busy}>
              {l("revoke")}
            </Button>
          </Form>
        ) : null
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={l("title")} title={staffLede(loaded.users, loaded.delegations, l)} description={l("intro")} />

      <Form method="get" className="flex flex-wrap items-end gap-3" aria-label={l("search")}>
        <Field label={l("search")}>
          <Input name="q" defaultValue={loaded.q} className="w-64" />
        </Field>
        <Button type="submit" variant="secondary" size="sm" loading={busy}>
          {l("apply")}
        </Button>
      </Form>

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      {"invited" in (result ?? {}) && result?.invited ? (
        <Card title={l("invited")} description={l("invitedBody", { name: result.invited.name })} />
      ) : null}

      {loaded.users.length === 0 ? (
        <EmptyState title={l("directoryTitle")} body={l("emptyDirectory")} />
      ) : (
        <Card title={l("directoryTitle")} padded={false}>
          <Table caption={l("directoryCaption")} columns={userColumns} rows={loaded.users} rowKey={(row) => row.id} />
        </Card>
      )}

      {loaded.may.invite ? (
        <Card title={l("inviteTitle")} description={l("inviteIntro")}>
          <Form method="post" className="flex flex-col gap-3">
            <input type="hidden" name="intent" value="invite" />
            <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
            <div className="flex flex-wrap gap-3">
              <Field label={l("email")} required>
                <Input type="email" name="email" required className="w-64" />
              </Field>
              <Field label={l("name")} required>
                <Input name="name" required className="w-56" />
              </Field>
              <Field label={l("locale")}>
                <Select
                  name="locale"
                  defaultValue=""
                  options={[
                    { value: "", label: t("common.default") },
                    { value: "en", label: "English" },
                    { value: "ar", label: "العربية" }
                  ]}
                />
              </Field>
              <Field label={l("manager")} hint={l("managerHint")}>
                <RefPicker name="managerId" options={people} className="w-56" />
              </Field>
              <Field label={l("dueAt")}>
                <DatePicker name="dueAt" />
              </Field>
            </div>
            <Field label={l("roles")} required>
              <div className="flex flex-wrap gap-3">
                {loaded.roles.map((role) => (
                  <Checkbox key={role.id} name="roleKeys" value={role.key} label={role.name} />
                ))}
              </div>
            </Field>
            <Field label={l("teams")}>
              <div className="flex flex-wrap gap-3">
                {loaded.teams.map((team) => (
                  <Checkbox key={team.id} name="teamIds" value={team.id} label={team.name} />
                ))}
              </div>
            </Field>
            <Button type="submit" loading={busy} className="self-start">
              {l("invite")}
            </Button>
          </Form>
        </Card>
      ) : null}

      {loaded.may.delegRead ? (
        <div className="flex flex-col gap-4">
          <Form method="get" className="flex flex-wrap items-end gap-3" aria-label={l("statusFilter")}>
            <Field label={l("statusFilter")}>
              <Select
                name="status"
                defaultValue={loaded.delegStatus}
                options={[
                  { value: "", label: t("common.all") },
                  ...["active", "revoked", "expired"].map((s) => ({ value: s, label: l(`deleg.${s}`) }))
                ]}
              />
            </Field>
            <Button type="submit" variant="secondary" size="sm" loading={busy}>
              {l("apply")}
            </Button>
          </Form>

          {loaded.may.delegWrite ? (
            <Card title={l("grantTitle")} description={l("delegationsIntro")}>
              <Form method="post" className="flex flex-col gap-3">
                <input type="hidden" name="intent" value="grant" />
                <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
                <div className="flex flex-wrap gap-3">
                  <Field label={l("from")} hint={l("fromHint")}>
                    <RefPicker name="fromUserId" options={people} className="w-56" />
                  </Field>
                  <Field label={l("to")} required>
                    <RefPicker name="toUserId" options={people} required className="w-56" />
                  </Field>
                  <Field label={l("reason")} required>
                    <Select
                      name="reason"
                      defaultValue=""
                      options={[
                        { value: "", label: t("common.choose") },
                        ...DELEGATION_REASONS.map((r) => ({ value: r, label: l(`reason.${r}`) }))
                      ]}
                    />
                  </Field>
                  <Field label={l("startsAt")} required>
                    <DatePicker name="startsAt" withTime required />
                  </Field>
                  <Field label={l("endsAt")} required>
                    <DatePicker name="endsAt" withTime required />
                  </Field>
                  <Field label={l("maxAmount")} hint={l("maxAmountHint")}>
                    <MoneyField name="maxAmountMinor" currency={currency || "ZAR"} locale={locale} className="w-32" />
                  </Field>
                  <Field label={l("currency")}>
                    <Input
                      name="currency"
                      value={currency}
                      onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                      maxLength={3}
                      pattern="[A-Za-z]{3}"
                      className="w-24"
                    />
                  </Field>
                </div>
                <Field label={l("modules")}>
                  <div className="flex flex-wrap gap-3">
                    {DELEGATION_MODULES.map((m) => (
                      <Checkbox key={m} name="modules" value={m} label={l(`module.${m}`)} />
                    ))}
                  </div>
                </Field>
                <Checkbox name="confirm" value="on" label={l("confirm")} />
                <Button type="submit" loading={busy} className="self-start">
                  {l("grant")}
                </Button>
              </Form>
            </Card>
          ) : null}

          {loaded.delegations.length === 0 ? (
            <EmptyState title={l("delegationsTitle")} body={l("emptyDelegations")} />
          ) : (
            <Card title={l("delegationsTitle")} padded={false}>
              <Table
                caption={l("delegationsCaption")}
                columns={delegationColumns}
                rows={loaded.delegations}
                rowKey={(row) => row.id}
              />
            </Card>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function nameOf(options: readonly StaffOption[], id: string, resolved: Names = {}): string {
  return options.find((o) => o.id === id)?.name ?? who(id, resolved) ?? id;
}


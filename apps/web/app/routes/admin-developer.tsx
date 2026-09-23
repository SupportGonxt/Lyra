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
  DateTime,
  EmptyState,
  PageHeader,
  Stat,
  Table,
  type BadgeTone,
  type Column
} from "@lyra/ui";
import { ApiError, api, fetchMe, type Problem } from "../api.server";
import { cloudflare } from "../context";
import { asJson } from "../json.js";
import { translator } from "../i18n";
import { Gate } from "./staff";
import { useShellData } from "./workspace";
import { labelsFrom, type Label } from "./detail-kit";

// The developer portal (docs/10 §6). Three things an integrator needs that no
// generated list can give them:
//
//   * the shape of the API they are calling — /openapi.json, summarised;
//   * which credentials exist, in which mode, and when each was last used;
//   * a way to rotate a webhook signing secret. That last one is why this is a
//     route: POST /v1/core/webhooks/:id/rotate returns the new secret exactly
//     once and never again, so the reveal has to live in the response of the
//     write. `revealOnCreate` on a generated resource only covers creates —
//     a generic action would rotate the secret and silently discard it, which
//     breaks every receiver.
//
// Minting keys stays in /settings/security, which already owns the one-time reveal for
// creates; this screen links there rather than growing a second mint.

/* --------------------------------------------------------------- contract */

export const PERM = {
  keysRead: "core:api_keys:read",
  hooksRead: "core:webhooks:read",
  hooksWrite: "core:webhooks:write"
} as const;

/** The headers dispatch.ts signs every delivery with (apps/api/src/dispatch.ts). */
export const SIGNING_HEADERS = [
  "x-lyra-event",
  "x-lyra-event-id",
  "x-lyra-timestamp",
  "x-lyra-signature"
] as const;

export interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  mode: string;
  scopesJson: string[] | string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

export interface HookRow {
  id: string;
  url: string;
  eventTypesJson: string[] | string;
  status: string;
  createdAt: number;
}

/** A rotated endpoint, with the one copy of its new secret. */
export interface Rotated {
  id: string;
  url: string;
  secret: string;
}

/** apps/api/src/dispatch.ts `deliver`'s return shape, echoed back by the test-ping route. */
export interface TestPing {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface Surface {
  version: string;
  paths: number;
  operations: number;
  tags: string[];
}

/** `*Json` columns hydrate to arrays; malformed text stays a bad row, not a 500. */
export function listOf(raw: string[] | string): string[] {
  const list = asJson<unknown>(raw, []);
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Shrink the OpenAPI document to the four numbers a portal shows. Shipping the
 * whole document to the browser would be a megabyte of loader payload for a
 * heading.
 */
export function surfaceOf(document: unknown): Surface {
  const doc = (document ?? {}) as {
    info?: { version?: unknown };
    paths?: Record<string, Record<string, unknown>>;
    tags?: Array<{ name?: unknown }>;
  };
  const paths = doc.paths ?? {};
  return {
    version: typeof doc.info?.version === "string" ? doc.info.version : "",
    paths: Object.keys(paths).length,
    operations: Object.values(paths).reduce((n, item) => n + Object.keys(item ?? {}).length, 0),
    tags: (doc.tags ?? []).map((tag) => tag.name).filter((name): name is string => typeof name === "string")
  };
}

const KEY_TONES: Record<string, BadgeTone> = { live: "warning", test: "info" };

export function keyTone(row: Pick<KeyRow, "mode" | "revokedAt">): BadgeTone {
  return row.revokedAt ? "neutral" : (KEY_TONES[row.mode] ?? "neutral");
}

/** The one line under the title: what is actually live right now, not the static blurb. */
export function devLede(keys: readonly KeyRow[], hooks: readonly HookRow[], l: Label): string {
  const liveKeys = keys.filter((row) => !row.revokedAt && row.mode === "live").length;
  const activeHooks = hooks.filter((row) => row.status === "active").length;
  if (liveKeys === 0 && activeHooks === 0) return l("introEmpty");
  return l("introSummary", { keys: String(liveKeys), hooks: String(activeHooks) });
}

/* ----------------------------------------------------------------- labels */

export const LABELS: Record<string, Record<string, string>> = {
  en: {
    title: "Developer portal",
    intro: "The API surface, the credentials that call it, and the secret every delivery is signed with.",
    introEmpty: "No live keys or active webhooks yet — everything running is in test mode.",
    introSummary: "{keys} live key(s) and {hooks} active webhook(s) are calling this API right now.",
    deniedTitle: "You cannot read developer settings",
    surfaceTitle: "API surface",
    surfaceIntro: "Generated from the running API, so it can never describe an endpoint that is not there.",
    surfaceVersion: "Version",
    surfacePaths: "Paths",
    surfaceOperations: "Operations",
    surfaceTags: "Modules",
    surfaceLink: "Open the OpenAPI document",
    surfaceMissing: "The API did not return a description of itself.",
    "surfaceMissing.body": "Nothing to document without it. Retry, and if it persists the API build is missing its OpenAPI output.",
    keysTitle: "API keys",
    keysIntro: "Test keys touch test data only. A live key acts on real records, so treat it as a password.",
    keysCaption: "API keys issued for this organisation",
    keysEmpty: "No API keys yet.",
    "keysEmpty.body": "Issue a key to let a system call this tenant's API on your behalf.",
    keysMint: "Mint a key in your settings",
    colKeyName: "Name",
    colPrefix: "Prefix",
    colMode: "Mode",
    colScopes: "Scopes",
    colLastUsed: "Last used",
    colExpires: "Expires",
    never: "Never used",
    noExpiry: "No expiry",
    revoked: "Revoked",
    hooksTitle: "Webhook endpoints",
    hooksIntro: "Every delivery is signed. Verify the signature before you trust the body.",
    hooksCaption: "Webhook endpoints and their signing state",
    hooksEmpty: "No webhook endpoints yet.",
    "hooksEmpty.body": "Add an endpoint to have events pushed to your systems as they happen.",
    hooksManage: "Add or edit endpoints in the integrations tab",
    colUrl: "Endpoint",
    colEvents: "Events",
    signingTitle: "Verifying a delivery",
    signingIntro:
      "The signature is HMAC-SHA256 over the timestamp, a dot, and the raw body, using the endpoint's secret. Compare it in constant time and refuse a timestamp that is far from now.",
    rotate: "Rotate secret",
    rotateConfirm: "I can update the receiver now",
    rotateTitle: "New signing secret",
    rotateIntro: "This is the only time it is shown. Deliveries are signed with it from now on.",
    confirmRequired: "Tick the confirmation first: the old secret stops working immediately.",
    hookRequired: "Choose an endpoint to rotate.",
    testPing: "Send test event",
    testPingTitle: "Test delivery",
    testPingOk: "Delivered",
    testPingFailed: "Failed",
    sandboxTitle: "Sandbox credentials",
    sandboxIntro:
      "Test-mode API keys are the sandbox for API calls. For AI extraction, the developer console has a scratch space that runs the real prompt without a document row.",
    sandboxLink: "Open the extraction playground",
    approvalLink: "Open approvals"
  },
  ar: {
    title: "بوابة المطوّرين",
    intro: "سطح الواجهة البرمجية، والاعتمادات التي تستدعيه، والسر الذي يُوقَّع به كل تسليم.",
    introEmpty: "لا مفاتيح حية أو ويب هوك نشط بعد — كل ما يعمل الآن في وضع الاختبار.",
    introSummary: "{keys} مفتاح حي (مفاتيح) و{hooks} ويب هوك نشط يستدعون هذه الواجهة الآن.",
    deniedTitle: "لا يمكنك قراءة إعدادات المطوّرين",
    surfaceTitle: "سطح الواجهة البرمجية",
    surfaceIntro: "مُولَّد من الواجهة العاملة، فلا يمكن أن يصف مسارًا غير موجود.",
    surfaceVersion: "الإصدار",
    surfacePaths: "المسارات",
    surfaceOperations: "العمليات",
    surfaceTags: "الوحدات",
    surfaceLink: "افتح مستند OpenAPI",
    surfaceMissing: "لم تُرجع الواجهة البرمجية وصفًا لنفسها.",
    "surfaceMissing.body": "لا شيء لتوثيقه بدونه. أعد المحاولة، وإن استمر فإن بناء الواجهة يفتقد مخرجات OpenAPI.",
    keysTitle: "مفاتيح الواجهة البرمجية",
    keysIntro: "مفاتيح الاختبار تمسّ بيانات الاختبار فقط. المفتاح الحقيقي يتصرف في سجلات حقيقية، فتعامل معه ككلمة مرور.",
    keysCaption: "مفاتيح الواجهة البرمجية الصادرة لهذه المؤسسة",
    keysEmpty: "لا توجد مفاتيح بعد.",
    "keysEmpty.body": "أصدر مفتاحاً ليتمكن نظام من استدعاء واجهة هذه المؤسسة نيابة عنك.",
    keysMint: "أصدر مفتاحًا من إعداداتك",
    colKeyName: "الاسم",
    colPrefix: "البادئة",
    colMode: "الوضع",
    colScopes: "النطاقات",
    colLastUsed: "آخر استخدام",
    colExpires: "تنتهي في",
    never: "لم يُستخدم",
    noExpiry: "بلا انتهاء",
    revoked: "مُلغى",
    hooksTitle: "نقاط الويب هوك",
    hooksIntro: "كل تسليم موقَّع. تحقّق من التوقيع قبل أن تثق بالمحتوى.",
    hooksCaption: "نقاط الويب هوك وحالة توقيعها",
    hooksEmpty: "لا توجد نقاط ويب هوك بعد.",
    "hooksEmpty.body": "أضف نقطة نهاية لتُدفع إليها الأحداث فور وقوعها.",
    hooksManage: "أضف النقاط أو عدّلها من تبويب التكاملات",
    colUrl: "النقطة",
    colEvents: "الأحداث",
    signingTitle: "التحقق من التسليم",
    signingIntro:
      "التوقيع هو HMAC-SHA256 على الطابع الزمني ثم نقطة ثم المحتوى الخام، باستخدام سر النقطة. قارنه بزمن ثابت، وارفض أي طابع زمني بعيد عن الآن.",
    rotate: "دوّر السر",
    rotateConfirm: "أستطيع تحديث المستقبِل الآن",
    rotateTitle: "سر توقيع جديد",
    rotateIntro: "هذه المرة الوحيدة التي يُعرض فيها. ستُوقَّع التسليمات به من الآن.",
    confirmRequired: "أكّد أولًا: السر القديم يتوقف عن العمل فورًا.",
    hookRequired: "اختر نقطة لتدوير سرّها.",
    testPing: "أرسل حدث اختبار",
    testPingTitle: "نتيجة الاختبار",
    testPingOk: "تم التسليم",
    testPingFailed: "فشل",
    sandboxTitle: "اعتمادات بيئة التجربة",
    sandboxIntro:
      "مفاتيح وضع الاختبار هي بيئة التجربة لاستدعاءات الواجهة البرمجية. لاستخراج الذكاء الاصطناعي، توجد في وحدة المطوّرين بيئة تجربة تُشغّل الطلب الحقيقي دون سجل مستند.",
    sandboxLink: "افتح بيئة تجربة الاستخراج",
    approvalLink: "افتح الموافقات"
  }
};

/** The shared resolver: the route's own table, then the shared catalogue, then
 *  the platform's `common.*` words (docs/ui.md §7 P3-14). */
export const labelsIn = labelsFrom(LABELS);

/* ------------------------------------------------------------------ loader */

/** A withheld read blanks one card, never the screen. */
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
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const may = {
    keysRead: held.has(PERM.keysRead),
    hooksRead: held.has(PERM.hooksRead),
    hooksWrite: held.has(PERM.hooksWrite)
  };
  const idempotencyKey = crypto.randomUUID();

  const [keys, hooks, document] = await Promise.all([
    may.keysRead
      ? safe(() => api<{ data: KeyRow[] }>("/v1/core/api-keys?limit=100", { env, request }), { data: [] })
      : { data: [] },
    may.hooksRead
      ? safe(() => api<{ data: HookRow[] }>("/v1/core/webhooks?limit=100", { env, request }), { data: [] })
      : { data: [] },
    // Unauthenticated and outside /v1 by design (apps/api/src/index.ts), so this
    // one is the description of the API rather than anything tenant-scoped.
    safe(() => api<unknown>("/openapi.json", { env, request }), null)
  ]);

  return {
    may,
    keys: keys.data,
    hooks: hooks.data,
    surface: document ? surfaceOf(document) : null,
    openapiUrl: new URL("/openapi.json", env.API_ORIGIN).toString(),
    idempotencyKey
  };
}

/* ------------------------------------------------------------------ action */

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const nothing = {
    problem: null as Problem | null,
    error: null as string | null,
    rotated: null as Rotated | null,
    tested: null as TestPing | null
  };
  const intent = String(form.get("intent") ?? "");

  if (intent === "test") {
    const hookId = String(form.get("hookId") ?? "").trim();
    if (!hookId) return { ...nothing, error: "hookRequired" };
    try {
      const tested = await api<TestPing>(`/v1/core/webhooks/${encodeURIComponent(hookId)}/test`, {
        env,
        request,
        method: "POST"
      });
      return { ...nothing, tested };
    } catch (error) {
      if (error instanceof ApiError) return { ...nothing, problem: error.problem };
      throw error;
    }
  }

  if (intent !== "rotate") return { ...nothing, problem: { title: "unknown intent", status: 400 } };

  // Rotation is destructive for the receiver — the previous secret stops
  // verifying the moment this returns — so it asks first.
  if (String(form.get("confirm") ?? "") !== "on") return { ...nothing, error: "confirmRequired" };
  const hookId = String(form.get("hookId") ?? "").trim();
  if (!hookId) return { ...nothing, error: "hookRequired" };
  const key = String(form.get("idempotencyKey") ?? "");
  const headers = key ? { "idempotency-key": key } : {};

  try {
    const rotated = await api<Rotated>(`/v1/core/webhooks/${encodeURIComponent(hookId)}/rotate`, {
      env,
      request,
      method: "POST",
      headers
    });
    // Returned, never redirected to: a redirect would drop the one copy of the
    // plaintext secret, and the API cannot mint it again.
    return { ...nothing, rotated: { id: rotated.id, url: rotated.url, secret: rotated.secret } };
  } catch (error) {
    if (error instanceof ApiError) return { ...nothing, problem: error.problem };
    throw error;
  }
}

/* --------------------------------------------------------------- component */

export default function AdminDeveloper() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const shell = useShellData();
  const navigation = useNavigation();

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const l = labelsIn(locale);
  const busy = navigation.state !== "idle";

  if (!loaded.may.keysRead && !loaded.may.hooksRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={l("title")} description={l("intro")} />
        <EmptyState title={l("deniedTitle")} body={t("error.forbidden")} />
      </div>
    );
  }

  const keyColumns: Array<Column<KeyRow>> = [
    { key: "name", header: l("colKeyName"), render: (row) => row.name },
    { key: "prefix", header: l("colPrefix"), render: (row) => <span className="font-mono text-12">{row.prefix}</span> },
    {
      key: "mode",
      header: l("colMode"),
      render: (row) => (
        <Badge tone={keyTone(row)} size="sm" dot>
          {row.revokedAt ? l("revoked") : row.mode}
        </Badge>
      )
    },
    { key: "scopes", header: l("colScopes"), numeric: true, render: (row) => listOf(row.scopesJson).length },
    {
      key: "lastUsedAt",
      header: l("colLastUsed"),
      render: (row) =>
        row.lastUsedAt ? (
          <DateTime value={row.lastUsedAt} locale={locale} />
        ) : (
          <span className="font-ui text-12 text-subtle">{l("never")}</span>
        )
    },
    {
      key: "expiresAt",
      header: l("colExpires"),
      render: (row) =>
        row.expiresAt ? (
          <DateTime value={row.expiresAt} locale={locale} />
        ) : (
          <span className="font-ui text-12 text-subtle">{l("noExpiry")}</span>
        )
    }
  ];

  const hookColumns: Array<Column<HookRow>> = [
    { key: "url", header: l("colUrl"), render: (row) => <span className="font-mono text-12 break-all">{row.url}</span> },
    { key: "events", header: l("colEvents"), numeric: true, render: (row) => listOf(row.eventTypesJson).length },
    {
      key: "status",
      header: l("colStatus"),
      render: (row) => (
        <Badge tone={row.status === "active" ? "success" : "neutral"} size="sm" dot>
          {row.status}
        </Badge>
      )
    },
    {
      key: "actions",
      header: t("common.actions"),
      render: (row) => (
        <div className="flex flex-wrap items-center gap-2">
          <Form method="post">
            <input type="hidden" name="intent" value="test" />
            <input type="hidden" name="hookId" value={row.id} />
            <Button type="submit" variant="ghost" size="sm" loading={busy}>
              {l("testPing")}
            </Button>
          </Form>
          {loaded.may.hooksWrite ? (
            <Form method="post" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="intent" value="rotate" />
              <input type="hidden" name="hookId" value={row.id} />
              <input type="hidden" name="idempotencyKey" value={loaded.idempotencyKey} />
              <Checkbox name="confirm" value="on" label={l("rotateConfirm")} />
              <Button type="submit" variant="ghost" size="sm" loading={busy}>
                {l("rotate")}
              </Button>
            </Form>
          ) : null}
        </div>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={l("title")} title={devLede(loaded.keys, loaded.hooks, l)} description={l("intro")} />

      {result?.error ? (
        <p role="alert" className="font-ui text-13 text-danger">
          {l(result.error)}
        </p>
      ) : null}
      {result?.problem ? <Gate problem={result.problem} l={l} /> : null}

      <Card title={l("surfaceTitle")} description={l("surfaceIntro")}>
        {loaded.surface ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <Stat label={l("surfaceVersion")} value={loaded.surface.version} />
              <Stat label={l("surfacePaths")} value={String(loaded.surface.paths)} />
              <Stat label={l("surfaceOperations")} value={String(loaded.surface.operations)} />
              <Stat label={l("surfaceTags")} value={String(loaded.surface.tags.length)} />
            </div>
            <div className="flex flex-wrap gap-2">
              {loaded.surface.tags.map((tag) => (
                <Badge key={tag} tone="neutral" size="sm">
                  {tag}
                </Badge>
              ))}
            </div>
            <a
              href={loaded.openapiUrl}
              className="font-ui text-13 text-accent underline underline-offset-2"
              rel="noreferrer"
            >
              {l("surfaceLink")}
            </a>
          </div>
        ) : (
          <EmptyState title={l("surfaceMissing")} body={l("surfaceMissing.body")} />
        )}
      </Card>

      {loaded.may.keysRead ? (
        <Card title={l("keysTitle")} description={l("keysIntro")}>
          <div className="flex flex-col gap-3">
            <Table
              caption={l("keysCaption")}
              columns={keyColumns}
              rows={loaded.keys}
              rowKey={(row) => row.id}
              rowState={(row) => (row.revokedAt ? "sealed" : undefined)}
              empty={<EmptyState title={l("keysEmpty")} body={l("keysEmpty.body")} />}
            />
            <Link to="/settings/security" className="font-ui text-13 text-accent underline underline-offset-2">
              {l("keysMint")}
            </Link>
          </div>
        </Card>
      ) : null}

      {loaded.may.hooksRead ? (
        <Card title={l("hooksTitle")} description={l("hooksIntro")}>
          <div className="flex flex-col gap-4">
            {result?.rotated ? <RevealedSecret rotated={result.rotated} l={l} /> : null}
            {result?.tested ? <TestPingResult tested={result.tested} l={l} /> : null}
            <Table
              caption={l("hooksCaption")}
              columns={hookColumns}
              rows={loaded.hooks}
              rowKey={(row) => row.id}
              empty={<EmptyState title={l("hooksEmpty")} body={l("hooksEmpty.body")} />}
            />
            <div className="flex flex-col gap-2 border-t border-border pt-3">
              <h3 className="font-display text-14 text-text">{l("signingTitle")}</h3>
              <p className="max-w-prose font-ui text-12 text-subtle">{l("signingIntro")}</p>
              <div className="flex flex-wrap gap-2">
                {SIGNING_HEADERS.map((header) => (
                  <code key={header} className="font-mono text-12 text-muted">
                    {header}
                  </code>
                ))}
              </div>
            </div>
            <Link
              to="/admin/webhooks"
              className="font-ui text-13 text-accent underline underline-offset-2"
            >
              {l("hooksManage")}
            </Link>
          </div>
        </Card>
      ) : null}

      <Card title={l("sandboxTitle")}>
        <div className="flex flex-col gap-2">
          <p className="max-w-prose font-ui text-13 text-muted">{l("sandboxIntro")}</p>
          <Link to="/axis/dev" className="font-ui text-13 text-accent underline underline-offset-2">
            {l("sandboxLink")}
          </Link>
        </div>
      </Card>
    </div>
  );
}

/** Shown once, selectable, and never editable-looking: it is a value, not a field. */
function RevealedSecret({ rotated, l }: { rotated: Rotated; l: (key: string) => string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-surface-2 p-3">
      <h3 className="font-display text-14 text-text">{l("rotateTitle")}</h3>
      <p className="max-w-prose font-ui text-12 text-subtle">{l("rotateIntro")}</p>
      <code className="font-mono text-12 text-muted break-all">{rotated.url}</code>
      <code role="status" className="break-all font-mono text-13 text-text">
        {rotated.secret}
      </code>
    </div>
  );
}

function TestPingResult({ tested, l }: { tested: TestPing; l: (key: string) => string }) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2 p-3">
      <h3 className="font-display text-14 text-text">{l("testPingTitle")}</h3>
      <Badge tone={tested.ok ? "success" : "danger"} size="sm" dot>
        {tested.ok ? l("testPingOk") : l("testPingFailed")}
      </Badge>
      {tested.status !== undefined ? <code className="font-mono text-12 text-muted">{tested.status}</code> : null}
      {tested.error ? (
        <p role="alert" className="font-ui text-12 text-danger">
          {tested.error}
        </p>
      ) : null}
    </div>
  );
}

import * as React from "react";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useParams,
  useSearchParams,
  type ActionFunctionArgs,
  type LoaderFunctionArgs
} from "react-router";
import {
  Badge,
  Button,
  Checkbox,
  DateTime,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  type Column
} from "@lyra/ui";
import { ApiError, api, clearedSessionCookie, fetchMe, type Problem as ProblemBody } from "../api.server";
import { cloudflare } from "../context";
import { asJson } from "../json.js";
import { CATALOGUES, LOCALES, moduleName, pseudoText, translator, type Translate } from "../i18n";
import { ConfirmButton } from "../components/confirm";
import { humanise, permissionTitle } from "@lyra/core/words";
import { titleText } from "../modules/spec";
import { Problem } from "./module";
import { useShellData } from "./workspace";
import { CALENDARS, FALLBACK_CURRENCY, calendarFrom, timezoneFrom, zones } from "../calendar";
import type { CalendarPreference } from "@lyra/ui";

// The actor's own account, and — for whoever administers the tenant — the parts
// of the tenant that are settings rather than records.
//
// Everything about the person themselves goes through /v1/me and /v1/auth/mfa,
// so nothing gates it: an actor always has standing over their own record. The
// three tenant-level panels below are gated on the permission the API itself
// would check, and every one of their fetches tolerates a refusal — a settings
// screen that 500s because one panel is out of reach is worse than a settings
// screen with one panel missing.
//
// Deliberately absent, because apps/api has no surface for them:
//   · timezone — core_users has no column for it; only name and locale are
//     writable (routes/me.ts ProfileBody).
//   · notification preferences — there is no preferences table; the inbox is
//     read/unread and nothing else.
//
// API keys are minted here (POST /v1/core/api-keys, apps/api/src/routes/core.ts).
// The plaintext comes back once in the action's result and is rendered from
// there — never a loader, never a cookie, because either would mean the secret
// is re-readable after the one moment it exists.

interface SessionRow {
  id: string;
  ip: string | null;
  ua: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
}

/** A row of `GET /v1/me/inbox` — see apps/api/src/routes/me.ts. That route is
 *  hand-written and returns the selected rows as they sit, so crud.ts
 *  `hydrate()` never runs and `paramsJson` arrives as text. */
interface NotificationRow {
  id: string;
  /** i18n key plus its variables — the API never sends display text. */
  titleKey: string;
  paramsJson: string | null;
  createdAt: number;
}

interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  mode: string;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}

interface DsarRow {
  id: string;
  type: string;
  state: string;
  dueAt: number;
  fulfilledAt: number | null;
  createdAt: number;
}

/** packages/db/src/json.ts BrandJson, narrowed to what this form writes. */
interface BrandShape {
  name?: string;
  logo?: { light?: string; dark?: string; mark?: string };
  palette?: { accent?: string; accentHover?: string; accentContrast?: string };
  font?: string;
}

/** Permission strings, as apps/api/src/resources.ts spells them. */
const CAN = {
  keysRead: "core:api_keys:read",
  keysCreate: "core:api_keys:create",
  // J-D1: a developer issues test keys; only dev.admin issues live ones.
  keysTest: "dev:keys_test:issue",
  keysLive: "dev:keys_live:issue",
  keysRevoke: "core:api_keys:revoke",
  tenantWrite: "core:tenants:update",
  usersRead: "core:users:read",
  dsarRead: "compliance:dsar:read",
  dsarCreate: "compliance:dsar:create",
  pii: "core:pii:view"
} as const;

/**
 * Settings is five screens, not one stack. An account is not a tenant's brand,
 * and the brand editor — where a tenant expresses its identity — is a
 * destination of its own rather than the seventh panel down the page
 * (docs/ui.md §7 P3-10). Each tab is an address, so it can be linked to.
 */
const TABS = [
  { id: "account", can: null },
  { id: "security", can: null },
  { id: "brand", can: "brand" },
  { id: "tenant", can: "brand" },
  { id: "data", can: "dsarCreate" }
] as const;

/** BrandJson.font — the approved set, and the only values --font-display and
 *  --font-ui may be re-mapped to (packages/ui/src/tokens.css §whitelabel). */
const FONTS = ["space-grotesk", "inter", "ibm-plex-sans-arabic"] as const;

/** compliance_dsar_requests.type, minus the ones only a case handler raises. */
const DSAR_TYPES = ["access", "portability", "rectification", "erasure"] as const;

/**
 * A subject request is answered within one month. `due_at` is NOT NULL with no
 * default, so the caller has to supply it; a month is the statutory floor the
 * platform assumes everywhere else (docs/12).
 */
const DSAR_DUE_MS = 30 * 24 * 60 * 60 * 1000;

/** WCAG 2.2 AA for body text. --accent-contrast is text placed ON --accent. */
const AA_RATIO = 4.5;

/* --------------------------------------------------------------- i18n table */

/**
 * Local to this screen by design: `app/i18n/en.ts` is the shell's shared
 * vocabulary, and a settings noun that only one route renders does not belong
 * in a catalogue every page pays for. Words the platform already shares
 * (save, working, saved) come from `translator` instead of being restated here.
 */
const LABELS: Record<string, Record<string, string>> = {
  en: {
    "tabs.label": "Settings sections",
    "tabs.account": "Profile",
    "tabs.security": "Sign-in & access",
    "tabs.brand": "Brand",
    "tabs.tenant": "Regional",
    "tabs.data": "Your data",
    "settings.title": "Account",
    "settings.intro": "Your profile, sign-in and sessions.",
    "settings.introUnread": "{count} unread notification(s) below.",
    "settings.tenantIntro": "Settings for the whole tenant, because you administer it.",

    "profile.title": "Profile",
    "profile.name": "Name",
    "profile.email": "Email address",
    "profile.emailHint": "Changed by an administrator, not here.",
    "profile.locale": "Language",
    "profile.localeHint": "Changes the language and reading direction of every screen.",

    "lens.title": "Workspace",
    "lens.intro": "Which workspace opens when you sign in, and what you've pinned or hidden there.",
    "lens.current": "Currently",
    "lens.default": "Your role's default — nothing learned yet.",
    "lens.custom": "Adapted from what you use.",
    "lens.reset": "Reset to role default",
    "lens.ok": "Your workspace is back to its role default.",
    "lens.unavailable": "Your workspace preference is not readable from here.",

    "password.title": "Password",
    "password.intro":
      "Changing your password ends every session, including this one — you will be asked to sign in again.",
    "password.current": "Current password",
    "password.new": "New password",
    "password.confirm": "Confirm new password",
    "password.hint": "At least 12 characters.",
    "password.mismatch": "The two new passwords do not match.",
    "password.same": "The new password must differ from the current one.",
    "password.submit": "Update password",

    "mfa.title": "Two-step sign-in",
    "mfa.intro":
      "An authenticator app generates a six-digit code that is asked for after your password.",
    "mfa.on": "Turned on",
    "mfa.off": "Turned off",
    "mfa.unknown":
      "Whether this account uses two-step sign-in is not readable from here, so both actions are offered.",
    "mfa.start": "Set up two-step sign-in",
    "mfa.secret": "Setup key",
    "mfa.secretHint":
      "Type this into your authenticator app, or open the link below on the device that holds it. It is shown once.",
    "mfa.uri": "Setup link",
    "mfa.code": "Six-digit code",
    "mfa.codeHint": "The code your authenticator shows right now.",
    "mfa.confirm": "Confirm and turn on",
    "mfa.recoveryTitle": "Your recovery codes",
    "mfa.recoveryIntro":
      "Each code signs you in once if you lose the authenticator. Save them now — they are never shown again.",
    "mfa.disableLink": "Turn off two-step sign-in",
    "mfa.disableTitle": "Turn off two-step sign-in",
    "mfa.disableIntro":
      "Confirm with a current code. Roles that require two-step sign-in cannot turn it off.",
    "mfa.disable": "Turn off",
    "mfa.cancel": "Leave it on",
    "mfa.disabled": "Two-step sign-in is now off.",
    "mfa.enabled": "Two-step sign-in is now on.",

    "perms.title": "What this account may do",
    "perms.intro":
      "The permissions you hold, spelled exactly as the platform checks them. An administrator changes them, not you.",
    "perms.none": "This account holds no permissions of its own.",
    "perms.pii":
      "You can see personal data unmasked. Every unmasking is written to the audit log with the record, the time and your name.",
    "perms.masked": "Personal data is shown to you masked.",

    "sessions.title": "Where you are signed in",
    "sessions.caption": "Sessions for this account",
    "sessions.device": "Device",
    "sessions.ip": "IP address",
    "sessions.started": "Signed in",
    "sessions.expires": "Expires",
    "sessions.state": "State",
    "sessions.active": "Active",
    "sessions.ended": "Ended",
    "sessions.end": "End session",
    "sessions.endConfirm": "End this session? Whoever is signed in on that device is signed out immediately and has to sign in again.",
    "sessions.ok": "That session has been ended.",
    "sessions.none": "No sessions recorded.",
    "sessions.none.body": "Sign-ins appear here so you can spot a device you do not recognise.",
    "sessions.unavailable": "Your sessions could not be read just now.",
    "sessions.unknown": "Unknown",

    "keys.title": "API keys",
    "keys.intro": "Keys that call the platform on your tenant's behalf.",
    "keys.caption": "API keys for this tenant",
    "keys.name": "Name",
    "keys.prefix": "Prefix",
    "keys.mode": "Mode",
    "keys.used": "Last used",
    "keys.expires": "Expires",
    "keys.state": "State",
    "keys.live": "Live",
    "keys.test": "Test",
    "keys.active": "Active",
    "keys.revoked": "Revoked",
    "keys.never": "Never",
    "keys.noExpiry": "No expiry",
    "keys.revoke": "Revoke",
    "keys.confirm": "Revoke this key? Anything using it stops working immediately.",
    "keys.ok": "That key has been revoked.",
    "keys.none": "No keys have been issued.",
    "keys.none.body": "Issue a key to let one of your own tools sign in as you.",
    "keys.unavailable": "Keys could not be read just now.",
    "keys.newTitle": "Issue a key",
    "keys.newIntro":
      "A key carries the permissions you give it and nothing more — you can only grant what you hold yourself.",
    "keys.newName": "What is it for",
    "keys.newNameHint": "The name is how you will recognise it in the list above.",
    "keys.newMode": "Mode",
    "keys.newModeHint": "A test key is the safe default; a live key acts on real records.",
    "keys.scopes": "What this key may do",
    "keys.scopesHint": "Choose as few as the job needs. A key with no permissions can sign in and nothing else.",
    "keys.scopesNone": "You hold no permissions that could be granted to a key.",
    "keys.submit": "Issue key",
    "keys.secretTitle": "Your new key",
    "keys.secretIntro":
      "Copy it now and store it somewhere safe — this is the only time it is shown. If you lose it, revoke the key and issue another.",

    "notifications.title": "Notifications",
    "notifications.intro": "Unread only. Reading one here clears it everywhere.",
    "notifications.read": "Mark as read",
    "notifications.ok": "Marked as read.",
    "notifications.none": "Nothing unread.",
    "notifications.unavailable": "Your inbox could not be read just now.",

    "brand.title": "Tenant appearance",
    "brand.intro":
      "The product name, logo and accent every screen in this tenant renders with. Leave a field empty to keep the platform default.",
    "brand.name": "Product name",
    "brand.nameHint": "Replaces the tenant name in the header and the browser tab.",
    "brand.logoLight": "Logo for light backgrounds",
    "brand.logoDark": "Logo for dark backgrounds",
    "brand.logoMark": "Square mark",
    "brand.logoHint": "A URL the browser can load.",
    "brand.accent": "Accent",
    "brand.accentHover": "Accent, hovered",
    "brand.accentContrast": "Text on the accent",
    "brand.colourHint": "Six-digit hex, for example the value your brand guide gives.",
    "brand.font": "Typeface",
    "brand.fontHint": "Applies to headings and body text alike.",
    "brand.fontDefault": "Platform default",
    "brand.preview": "Preview",
    "brand.previewButton": "Primary action",
    "brand.contrastFail":
      "Text on the accent must reach a contrast ratio of {ratio}:1. This pair reaches {actual}:1.",
    "brand.colourFormat": "Use a six-digit hex value beginning with a hash.",
    "brand.ok": "Appearance saved. It applies on the next screen you open.",
    "brand.unavailable": "The tenant's appearance could not be read just now.",

    "calendar.title": "Dates, language and money",
    "calendar.intro":
      "How this tenant reads dates, which language it opens in, and the currency its money is written in. Nothing is re-dated or re-priced: the same instant and the same amount are simply written the way your business writes them.",
    "calendar.field": "Calendar",
    "calendar.gregorian": "Gregorian",
    "calendar.islamic-umalqura": "Hijri (Umm al-Qura)",
    "calendar.dual": "Gregorian, with the Hijri date on hover",
    "calendar.hint": "Applies to every date on every screen, for everyone in this tenant.",
    "calendar.locale": "Default language",
    "calendar.localeHint": "What people see before they choose their own language.",
    "calendar.currency": "Currency",
    "calendar.currencyHint": "Three-letter code (ISO 4217), such as AED or SAR.",
    "calendar.timezone": "Time zone",
    "calendar.timezoneHint":
      "Where this tenant's working day is. Cutoffs, due dates and scheduled reports are all read against it.",
    "calendar.timezoneAuto": "Each reader's own zone",
    "calendar.submit": "Save",
    "calendar.ok": "Saved. It applies on the next screen you open.",
    "calendar.unknown": "That is not a calendar this platform renders.",
    "calendar.localeUnknown": "This tenant does not run in that language.",
    "calendar.currencyBad": "Use a three-letter currency code, such as AED.",
    "calendar.timezoneBad": "That is not a time zone this platform can read dates in.",

    "dsar.title": "Your data",
    "dsar.intro":
      "Ask for a copy of the personal data held about you, or ask for it to be erased. A request is logged and answered by the compliance team.",
    "dsar.subject": "Subject of the request",
    "dsar.type": "What you are asking for",
    "dsar.type.access": "A copy of my data",
    "dsar.type.portability": "My data in a portable format",
    "dsar.type.rectification": "A correction to my data",
    "dsar.type.erasure": "Erasure of my data",
    "dsar.erasureNote":
      "Erasure is carried out only after a second approver signs it off, and records under a legal hold are kept.",
    "dsar.submit": "Raise the request",
    "dsar.ok": "Request raised. It is answered by the date shown below.",
    "dsar.caption": "Requests about you",
    "dsar.state": "State",
    "dsar.due": "Answer due",
    "dsar.raised": "Raised",
    "dsar.none": "You have raised no requests.",
    "dsar.none.body": "Raise a request to get a copy of your data, or to have it erased.",
    "dsar.unavailable": "Existing requests could not be read just now.",

    "problem.unknown": "That action is not one this screen offers."
  },
  ar: {
    "tabs.label": "أقسام الإعدادات",
    "tabs.account": "الملف الشخصي",
    "tabs.security": "تسجيل الدخول والوصول",
    "tabs.brand": "الهوية",
    "tabs.tenant": "الإقليمية",
    "tabs.data": "بياناتك",
    "settings.title": "الحساب",
    "settings.intro": "ملفك الشخصي وتسجيل الدخول والجلسات.",
    "settings.introUnread": "{count} إشعار غير مقروء أدناه.",
    "settings.tenantIntro": "إعدادات تخص المؤسسة بأكملها، لأنك تديرها.",

    "profile.title": "الملف الشخصي",
    "profile.name": "الاسم",
    "profile.email": "البريد الإلكتروني",
    "profile.emailHint": "يغيّره المسؤول، وليس من هنا.",
    "profile.locale": "اللغة",
    "profile.localeHint": "تُغيّر لغة جميع الشاشات واتجاه القراءة فيها.",

    "lens.title": "مساحة العمل",
    "lens.intro": "مساحة العمل التي تُفتح عند تسجيل الدخول، وما ثبّتّه أو أخفيته فيها.",
    "lens.current": "حاليًا",
    "lens.default": "الإعداد الافتراضي لدورك — لم يُتعلَّم شيء بعد.",
    "lens.custom": "مُكيَّفة بحسب استخدامك.",
    "lens.reset": "إعادة الضبط إلى الإعداد الافتراضي",
    "lens.ok": "عادت مساحة عملك إلى الإعداد الافتراضي لدورك.",
    "lens.unavailable": "تعذّرت قراءة تفضيل مساحة العمل من هنا.",

    "password.title": "كلمة المرور",
    "password.intro":
      "تغيير كلمة المرور يُنهي كل الجلسات، بما فيها هذه الجلسة — وسيُطلب منك تسجيل الدخول من جديد.",
    "password.current": "كلمة المرور الحالية",
    "password.new": "كلمة المرور الجديدة",
    "password.confirm": "تأكيد كلمة المرور الجديدة",
    "password.hint": "اثنا عشر حرفًا على الأقل.",
    "password.mismatch": "كلمتا المرور الجديدتان غير متطابقتين.",
    "password.same": "يجب أن تختلف كلمة المرور الجديدة عن الحالية.",
    "password.submit": "تحديث كلمة المرور",

    "mfa.title": "تسجيل الدخول بخطوتين",
    "mfa.intro": "يولّد تطبيق المصادقة رمزًا من ستة أرقام يُطلب بعد كلمة المرور.",
    "mfa.on": "مُفعّل",
    "mfa.off": "غير مُفعّل",
    "mfa.unknown": "لا يمكن قراءة حالة التفعيل من هنا، لذلك يظهر الخياران معًا.",
    "mfa.start": "تفعيل تسجيل الدخول بخطوتين",
    "mfa.secret": "مفتاح الإعداد",
    "mfa.secretHint":
      "أدخل هذا المفتاح في تطبيق المصادقة، أو افتح الرابط أدناه على الجهاز الذي يحمله. يظهر مرة واحدة فقط.",
    "mfa.uri": "رابط الإعداد",
    "mfa.code": "الرمز المكوّن من ستة أرقام",
    "mfa.codeHint": "الرمز الذي يعرضه تطبيق المصادقة الآن.",
    "mfa.confirm": "تأكيد وتفعيل",
    "mfa.recoveryTitle": "رموز الاسترداد الخاصة بك",
    "mfa.recoveryIntro":
      "كل رمز يسمح بتسجيل دخول واحد إذا فقدت تطبيق المصادقة. احفظها الآن — لن تظهر مرة أخرى.",
    "mfa.disableLink": "إيقاف تسجيل الدخول بخطوتين",
    "mfa.disableTitle": "إيقاف تسجيل الدخول بخطوتين",
    "mfa.disableIntro":
      "أكّد برمز حالي. الأدوار التي تفرض تسجيل الدخول بخطوتين لا يمكنها إيقافه.",
    "mfa.disable": "إيقاف",
    "mfa.cancel": "إبقاؤه مُفعّلًا",
    "mfa.disabled": "أصبح تسجيل الدخول بخطوتين متوقفًا.",
    "mfa.enabled": "أصبح تسجيل الدخول بخطوتين مُفعّلًا.",

    "perms.title": "ما يسمح به هذا الحساب",
    "perms.intro":
      "الصلاحيات التي تملكها، مكتوبة كما تتحقق منها المنصة تمامًا. يغيّرها المسؤول وليس أنت.",
    "perms.none": "لا يملك هذا الحساب أي صلاحيات خاصة به.",
    "perms.pii":
      "يمكنك رؤية البيانات الشخصية بدون تمويه. كل عملية إظهار تُسجَّل في سجل التدقيق مع السجل والوقت واسمك.",
    "perms.masked": "تُعرض لك البيانات الشخصية مموّهة.",

    "sessions.title": "أين سجّلت الدخول",
    "sessions.caption": "جلسات هذا الحساب",
    "sessions.device": "الجهاز",
    "sessions.ip": "عنوان IP",
    "sessions.started": "بدأت",
    "sessions.expires": "تنتهي",
    "sessions.state": "الحالة",
    "sessions.active": "نشطة",
    "sessions.ended": "منتهية",
    "sessions.end": "إنهاء الجلسة",
    "sessions.endConfirm": "هل تريد إنهاء هذه الجلسة؟ سيُسجَّل خروج من يستخدم ذلك الجهاز فوراً وسيحتاج إلى تسجيل الدخول مرة أخرى.",
    "sessions.ok": "تم إنهاء تلك الجلسة.",
    "sessions.none": "لا توجد جلسات مسجّلة.",
    "sessions.none.body": "تظهر عمليات تسجيل الدخول هنا لترصد أي جهاز لا تعرفه.",
    "sessions.unavailable": "تعذّرت قراءة جلساتك الآن.",
    "sessions.unknown": "غير معروف",

    "keys.title": "مفاتيح الواجهة البرمجية",
    "keys.intro": "مفاتيح تستدعي المنصة نيابة عن مؤسستك.",
    "keys.caption": "مفاتيح الواجهة البرمجية لهذه المؤسسة",
    "keys.name": "الاسم",
    "keys.prefix": "البادئة",
    "keys.mode": "الوضع",
    "keys.used": "آخر استخدام",
    "keys.expires": "تنتهي",
    "keys.state": "الحالة",
    "keys.live": "إنتاج",
    "keys.test": "اختبار",
    "keys.active": "نشط",
    "keys.revoked": "مُبطَل",
    "keys.never": "لم يُستخدم",
    "keys.noExpiry": "بلا انتهاء",
    "keys.revoke": "إبطال",
    "keys.confirm": "هل تريد إبطال هذا المفتاح؟ سيتوقف كل ما يستخدمه فورًا.",
    "keys.ok": "تم إبطال المفتاح.",
    "keys.none": "لم تُصدر أي مفاتيح.",
    "keys.none.body": "أصدر مفتاحاً ليتمكن أحد أدواتك من الدخول باسمك.",
    "keys.unavailable": "تعذّرت قراءة المفاتيح الآن.",
    "keys.newTitle": "إصدار مفتاح",
    "keys.newIntro": "يحمل المفتاح الصلاحيات التي تمنحها له فقط، ولا يمكنك منح ما لا تملكه أنت.",
    "keys.newName": "الغرض منه",
    "keys.newNameHint": "الاسم هو ما ستعرفه به في الجدول أعلاه.",
    "keys.newMode": "الوضع",
    "keys.newModeHint": "مفتاح الاختبار هو الخيار الآمن، أما مفتاح الإنتاج فيعمل على سجلات حقيقية.",
    "keys.scopes": "ما الذي يسمح به هذا المفتاح",
    "keys.scopesHint": "اختر أقل ما تتطلبه المهمة. المفتاح بلا صلاحيات يسجّل الدخول ولا شيء غير ذلك.",
    "keys.scopesNone": "لا تملك صلاحيات يمكن منحها لمفتاح.",
    "keys.submit": "إصدار المفتاح",
    "keys.secretTitle": "مفتاحك الجديد",
    "keys.secretIntro":
      "انسخه الآن واحفظه في مكان آمن؛ هذه هي المرة الوحيدة التي يُعرض فيها. وإذا فقدته فأبطِل المفتاح وأصدر غيره.",

    "notifications.title": "الإشعارات",
    "notifications.intro": "غير المقروءة فقط. تعليم إشعار هنا يُزيله في كل مكان.",
    "notifications.read": "تعليم كمقروء",
    "notifications.ok": "تم التعليم كمقروء.",
    "notifications.none": "لا شيء غير مقروء.",
    "notifications.unavailable": "تعذّرت قراءة صندوق الوارد الآن.",

    "brand.title": "هوية المؤسسة",
    "brand.intro":
      "اسم المنتج والشعار واللون المميّز الذي تظهر به كل شاشة في هذه المؤسسة. اترك الحقل فارغًا للإبقاء على الإعداد الافتراضي.",
    "brand.name": "اسم المنتج",
    "brand.nameHint": "يحلّ محل اسم المؤسسة في الترويسة وفي عنوان المتصفح.",
    "brand.logoLight": "الشعار على خلفية فاتحة",
    "brand.logoDark": "الشعار على خلفية داكنة",
    "brand.logoMark": "الرمز المربّع",
    "brand.logoHint": "رابط يستطيع المتصفح تحميله.",
    "brand.accent": "اللون المميّز",
    "brand.accentHover": "اللون المميّز عند المرور",
    "brand.accentContrast": "لون النص فوق اللون المميّز",
    "brand.colourHint": "قيمة ست عشرية من ستة أرقام، كما في دليل هويتك.",
    "brand.font": "الخط",
    "brand.fontHint": "يُطبّق على العناوين والنصوص معًا.",
    "brand.fontDefault": "خط المنصة الافتراضي",
    "brand.preview": "معاينة",
    "brand.previewButton": "إجراء رئيسي",
    "brand.contrastFail":
      "يجب أن يبلغ تباين النص فوق اللون المميّز {ratio}:1. هذا المزيج يبلغ {actual}:1.",
    "brand.colourFormat": "استخدم قيمة ست عشرية من ستة أرقام تبدأ بعلامة #.",
    "brand.ok": "تم حفظ الهوية. تُطبَّق على الشاشة التالية التي تفتحها.",
    "brand.unavailable": "تعذّرت قراءة هوية المؤسسة الآن.",

    "calendar.title": "التواريخ واللغة والعملة",
    "calendar.intro":
      "كيف تُقرأ التواريخ في هذه المؤسسة، وبأي لغة تُفتح، وبأي عملة تُكتب مبالغها. لا يتغيّر أي تاريخ ولا أي مبلغ: اللحظة نفسها والمبلغ نفسه يُكتبان بالطريقة التي تكتبها بها.",
    "calendar.field": "التقويم",
    "calendar.gregorian": "ميلادي",
    "calendar.islamic-umalqura": "هجري (أم القرى)",
    "calendar.dual": "ميلادي، مع التاريخ الهجري عند المرور بالمؤشر",
    "calendar.hint": "يُطبَّق على كل تاريخ في كل شاشة، ولكل من في هذه المؤسسة.",
    "calendar.locale": "اللغة الافتراضية",
    "calendar.localeHint": "ما يراه الناس قبل أن يختاروا لغتهم.",
    "calendar.currency": "العملة",
    "calendar.currencyHint": "رمز من ثلاثة أحرف (ISO 4217)، مثل AED أو SAR.",
    "calendar.timezone": "المنطقة الزمنية",
    "calendar.timezoneHint":
      "أين يقع يوم العمل في هذه المؤسسة. تُقرأ عليها المواعيد النهائية وتواريخ الاستحقاق والتقارير المجدولة.",
    "calendar.timezoneAuto": "منطقة كل قارئ نفسه",
    "calendar.submit": "حفظ",
    "calendar.ok": "تم الحفظ. يُطبَّق على الشاشة التالية التي تفتحها.",
    "calendar.unknown": "هذا ليس تقويمًا تعرضه المنصّة.",
    "calendar.localeUnknown": "هذه المؤسسة لا تعمل بهذه اللغة.",
    "calendar.currencyBad": "استخدم رمز عملة من ثلاثة أحرف، مثل AED.",
    "calendar.timezoneBad": "هذه ليست منطقة زمنية تستطيع المنصّة قراءة التواريخ بها.",

    "dsar.title": "بياناتك",
    "dsar.intro":
      "اطلب نسخة من بياناتك الشخصية المحفوظة، أو اطلب محوها. يُسجَّل الطلب ويجيب عليه فريق الالتزام.",
    "dsar.subject": "موضوع الطلب",
    "dsar.type": "ما الذي تطلبه",
    "dsar.type.access": "نسخة من بياناتي",
    "dsar.type.portability": "بياناتي بصيغة قابلة للنقل",
    "dsar.type.rectification": "تصحيح بياناتي",
    "dsar.type.erasure": "محو بياناتي",
    "dsar.erasureNote":
      "لا يُنفَّذ المحو إلا بعد موافقة شخص ثانٍ، وتبقى السجلات الخاضعة لحجز قانوني محفوظة.",
    "dsar.submit": "إرسال الطلب",
    "dsar.ok": "تم تسجيل الطلب. سيُجاب عليه في التاريخ الموضّح أدناه.",
    "dsar.caption": "الطلبات المتعلقة بك",
    "dsar.state": "الحالة",
    "dsar.due": "موعد الإجابة",
    "dsar.raised": "تاريخ الطلب",
    "dsar.none": "لم تُرسل أي طلبات.",
    "dsar.none.body": "أرسل طلباً للحصول على نسخة من بياناتك أو لمحوها.",
    "dsar.unavailable": "تعذّرت قراءة الطلبات القائمة الآن.",

    "problem.unknown": "هذا الإجراء ليس من إجراءات هذه الشاشة."
  }
};

function labelsFor(locale: string): (key: string) => string {
  const table = LABELS[locale] ?? LABELS.en!;
  // A missing translation falls back to English rather than to the raw key: a
  // half-translated screen still reads, an ar table with a hole does not.
  return (key) => pseudoText(locale, table[key] ?? LABELS.en![key] ?? key);
}

/** `{ratio}` in a local label. The shared catalogue has `translator`; this one
 *  string is not worth widening it for. */
function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);
}

/**
 * The hero lede for every tab of this screen, not just the account tab where
 * the inbox itself lives — an unread count is worth surfacing wherever the
 * actor lands. Falls back to the plain, static intro once nothing is unread.
 */
export function settingsLede(unreadCount: number, label: (key: string) => string): string {
  if (unreadCount > 0) {
    return fill(label("settings.introUnread"), { count: String(unreadCount) });
  }
  return label("settings.intro");
}

/* ------------------------------------------------------------------ loader */

/**
 * A panel the actor may not read is missing, not fatal. `soft` keeps a 403 (or
 * a resource that is simply unavailable) from taking the whole screen down, and
 * reports the gap so the panel can say so rather than render an empty table that
 * looks like "you have none".
 */
async function soft<T>(work: Promise<T>): Promise<{ value: T | null }> {
  try {
    return { value: await work };
  } catch (error) {
    // 401 is the session, not this panel: let the workspace layout redirect.
    if (error instanceof ApiError && error.status !== 401) return { value: null };
    throw error;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.get(cloudflare).env;
  // The shell keeps neither the tenant id, the raw permission list nor the
  // actor's email, and all three decide what this screen may render.
  const me = await fetchMe(env, request);
  const held = new Set(me.permissions);
  const email = me.profile?.email ?? "";

  const [sessions, inbox, keys, self, dsar, lens] = await Promise.all([
    soft(api<{ data: SessionRow[] }>("/v1/me/sessions", { env, request })),
    soft(api<{ notifications: NotificationRow[] }>("/v1/me/inbox", { env, request })),
    held.has(CAN.keysRead)
      ? soft(
          api<{ data: ApiKeyRow[] }>("/v1/core/api-keys?sort=createdAt&order=desc&limit=25", {
            env,
            request
          })
        )
      : Promise.resolve({ value: null }),
    // The only way to learn whether this account already carries a second
    // factor: /v1/me does not report it. Most actors cannot read it, and the
    // panel is built to work either way.
    held.has(CAN.usersRead) && me.profile
      ? soft(
          api<{ mfaEnrolled?: boolean }>(`/v1/core/users/${encodeURIComponent(me.profile.id)}`, {
            env,
            request
          })
        )
      : Promise.resolve({ value: null }),
    held.has(CAN.dsarRead) && email
      ? soft(
          api<{ data: DsarRow[] }>(
            `/v1/compliance/dsar-requests?subjectIdentifier=${encodeURIComponent(email)}` +
              "&sort=createdAt&order=desc&limit=10",
            { env, request }
          )
        )
      : Promise.resolve({ value: null }),
    // Non-user actors (agent/partner/system) have no lens; the route 400s and
    // `soft` turns that into "unavailable" rather than failing the screen.
    soft(
      api<{ lens: { workspace: string }; isDefault: boolean }>("/v1/me/lens", { env, request })
    ),
  ]);

  const brand = (me.tenant.brand ?? {}) as BrandShape;

  return {
    email,
    tenantName: me.tenant.name,
    can: {
      keysRead: held.has(CAN.keysRead),
      keysCreate: held.has(CAN.keysCreate) || held.has(CAN.keysTest),
      keysLive: held.has(CAN.keysLive),
      keysRevoke: held.has(CAN.keysRevoke),
      brand: held.has(CAN.tenantWrite),
      dsarRead: held.has(CAN.dsarRead),
      dsarCreate: held.has(CAN.dsarCreate),
      pii: held.has(CAN.pii)
    },
    /** What this session may do, as the API spells it. Read-only here: a person
     *  never edits their own grants (that is /admin/permissions). */
    permissions: me.permissions,
    sessions: sessions.value?.data ?? [],
    sessionsReadable: sessions.value !== null,
    notifications: (inbox.value?.notifications ?? []).map((n) => ({
      id: n.id,
      titleKey: n.titleKey,
      createdAt: n.createdAt,
      vars: varsOf(n.paramsJson)
    })),
    inboxReadable: inbox.value !== null,
    keys: keys.value?.data ?? [],
    keysReadable: keys.value !== null,
    /**
     * The scope picker offers exactly what this session holds and nothing else:
     * the API refuses any other scope as privilege escalation, so a free-text
     * box could only ever produce a 403. /v1/me returns wildcards already
     * expanded, so these are the concrete strings the API will check.
     */
    grantable: held.has(CAN.keysCreate) || held.has(CAN.keysTest) ? me.permissions : [],
    /** `null` when the actor cannot read their own user row — an unknown, not a no. */
    mfaEnrolled: typeof self.value?.mfaEnrolled === "boolean" ? self.value.mfaEnrolled : null,
    brand: {
      name: brand.name ?? "",
      logoLight: brand.logo?.light ?? "",
      logoDark: brand.logo?.dark ?? "",
      logoMark: brand.logo?.mark ?? "",
      accent: brand.palette?.accent ?? "",
      accentHover: brand.palette?.accentHover ?? "",
      accentContrast: brand.palette?.accentContrast ?? "",
      font: brand.font ?? ""
    },
    /** Rendering preference, stored on tenant policy; see UiCalendarProvider. */
    calendar: calendarFrom(me.policy?.calendarPreference),
    /** The other tenant-wide regional settings, edited on the same panel. */
    defaultLocale: stringFrom(me.policy?.defaultLocale, "en"),
    currency: stringFrom(me.policy?.currency, FALLBACK_CURRENCY),
    /** Empty when the tenant has none — then every reader sees their own zone. */
    timezone: timezoneFrom(me.policy?.timezone) ?? "",
    /** Which locales this tenant runs in — the only valid default locales. */
    locales: localesFrom(me.policy?.locales),
    dsar: dsar.value?.data ?? [],
    dsarReadable: dsar.value !== null,
    lens: lens.value ? { workspace: lens.value.lens.workspace, isDefault: lens.value.isDefault } : null,
    lensReadable: lens.value !== null
  };
}

/* ------------------------------------------------------------------ action */

/** Which form failed or succeeded, so the message lands beside it. */
interface ActionResult {
  intent: string;
  ok?: boolean;
  problem?: ProblemBody;
  /** A refusal we made ourselves; the client owns the wording. */
  errorKey?: string;
  errorVars?: Record<string, string>;
  /** Shown once, straight from the API, and never stored (MFA enrolment). */
  secret?: string;
  otpauthUri?: string;
  recoveryCodes?: string[];
  /** The plaintext of a key just minted. Lives for exactly one render. */
  keySecret?: string;
  dueAt?: number;
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.get(cloudflare).env;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const here = new URL(request.url).pathname;
  const text = (key: string): string => String(form.get(key) ?? "").trim();

  try {
    if (intent === "profile") {
      const locale = text("locale");
      const known = Boolean(CATALOGUES[locale]);
      await api("/v1/me", {
        env,
        request,
        method: "PATCH",
        body: { name: text("name"), ...(known ? { locale } : {}) }
      });

      const headers = new Headers();
      // The document's lang and dir come from this cookie (app/i18n.ts), read on
      // the *next* request — so a plain revalidation would save the language and
      // keep rendering the old one. The redirect is what carries it back.
      if (known) {
        headers.append(
          "set-cookie",
          `lyra_locale=${locale}; Path=/; SameSite=Lax; Max-Age=31536000`
        );
      }
      return redirect(`${here}?saved=profile`, { headers });
    }

    if (intent === "password") {
      // The browser check below is the fast one; this is the one that holds when
      // scripting is off, and it runs before the secret leaves this worker.
      const next = String(form.get("next") ?? "");
      if (next !== String(form.get("confirm") ?? "")) {
        return { intent, errorKey: "password.mismatch" } satisfies ActionResult;
      }
      if (next === String(form.get("current") ?? "")) {
        return { intent, errorKey: "password.same" } satisfies ActionResult;
      }
      await api("/v1/me/password", {
        env,
        request,
        method: "POST",
        body: { current: String(form.get("current") ?? ""), next }
      });
      // /v1/me/password revokes every session of this user, this one included.
      // Staying on the page would only show a screen whose next fetch is a 401,
      // so clear the cookie and say so plainly.
      return redirect("/login", {
        headers: new Headers([["set-cookie", clearedSessionCookie(env)]])
      });
    }

    if (intent === "mfa-start") {
      // The secret comes back exactly once. It is rendered from this result and
      // written nowhere: the API has already stored its own copy, so the confirm
      // step below needs only the code.
      const started = await api<{ secret: string; otpauthUri: string }>("/v1/auth/mfa/enrol", {
        env,
        request,
        method: "POST"
      });
      return { intent, secret: started.secret, otpauthUri: started.otpauthUri } satisfies ActionResult;
    }

    if (intent === "mfa-confirm") {
      const confirmed = await api<{ recoveryCodes: string[] }>("/v1/auth/mfa/enrol/confirm", {
        env,
        request,
        method: "POST",
        body: { code: text("code") }
      });
      return { intent, ok: true, recoveryCodes: confirmed.recoveryCodes } satisfies ActionResult;
    }

    if (intent === "mfa-disable") {
      await api("/v1/auth/mfa/disable", {
        env,
        request,
        method: "POST",
        body: { code: text("code") }
      });
      return redirect(here);
    }

    if (intent === "brand") {
      const accent = text("accent");
      const accentHover = text("accentHover");
      const accentContrast = text("accentContrast");
      for (const value of [accent, accentHover, accentContrast]) {
        if (value && !isHex(value)) return { intent, errorKey: "brand.colourFormat" } satisfies ActionResult;
      }
      // "must pass AA — validated on save" (tokens.css §whitelabel). The check
      // runs here rather than only in the browser so a scripted client cannot
      // put unreadable text on every button in the tenant.
      // Hovering a button does not change its label colour, so the hover fill
      // carries the same label and has to clear the same bar.
      for (const fill of [accent, accentHover]) {
        const ratio = fill && accentContrast ? contrastRatio(fill, accentContrast) : null;
        if (ratio !== null && ratio < AA_RATIO) {
          return {
            intent,
            errorKey: "brand.contrastFail",
            errorVars: { ratio: AA_RATIO.toFixed(1), actual: ratio.toFixed(2) }
          } satisfies ActionResult;
        }
      }

      // Second, independent pairing: `accent`/`accentHover` also render as
      // `text-accent`/`text-accent-hover` link text directly on white surfaces
      // (docs/07). A colour can clear the button-label check above and fail
      // this one — a light accent reads fine as a dark-on-light button fill
      // but not as light-on-white text.
      for (const fill of [accent, accentHover]) {
        const ratio = fill ? contrastRatio(fill, "#ffffff") : null;
        if (ratio !== null && ratio < AA_RATIO) {
          return {
            intent,
            errorKey: "brand.contrastFail",
            errorVars: { ratio: AA_RATIO.toFixed(1), actual: ratio.toFixed(2) }
          } satisfies ActionResult;
        }
      }

      const font = text("font");
      const logo = pruned({ light: text("logoLight"), dark: text("logoDark"), mark: text("logoMark") });
      const palette = pruned({ accent, accentHover, accentContrast });
      const brand: BrandShape = {
        ...(text("name") ? { name: text("name") } : {}),
        ...(logo ? { logo } : {}),
        ...(palette ? { palette } : {}),
        ...(FONTS.includes(font as (typeof FONTS)[number]) ? { font } : {})
      };

      // The tenant id comes from the session, never from the form: a hidden
      // field would let a caller re-skin somebody else's tenant.
      const me = await fetchMe(env, request);
      await api(`/v1/core/tenants/${encodeURIComponent(me.tenant.id)}`, {
        env,
        request,
        method: "PATCH",
        body: { brandJson: brand }
      });
      return { intent, ok: true } satisfies ActionResult;
    }

    if (intent === "calendar") {
      const calendar = text("calendar");
      if (!CALENDARS.includes(calendar as CalendarPreference)) {
        return { intent, errorKey: "calendar.unknown" } satisfies ActionResult;
      }

      // Policy is one JSON column and the CRUD PATCH replaces it wholesale, so
      // the current policy is read back and merged here. The form contributes
      // three fields; nothing else about it is reachable from the browser.
      const me = await fetchMe(env, request);

      // An omitted field means "leave it alone", so a narrower form (or a
      // tenant on one locale) can post this same intent without clearing
      // anything it never showed.
      const defaultLocale = text("defaultLocale");
      const runs = localesFrom(me.policy?.locales);
      if (defaultLocale && !runs.includes(defaultLocale)) {
        return { intent, errorKey: "calendar.localeUnknown" } satisfies ActionResult;
      }

      // ISO 4217 is three letters, upper case. Anything else would be written
      // beside every money figure in the tenant and formatted by nothing.
      const currency = text("currency").toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        return { intent, errorKey: "calendar.currencyBad" } satisfies ActionResult;
      }

      // Refused here rather than degraded, because this is the one place a
      // human names the zone. Everywhere downstream degrades instead
      // (apps/web/app/calendar.ts timezoneFrom): a zone Intl cannot read
      // throws from inside formatToParts, during render, on every screen.
      // `has` and not the value: submitted-and-empty clears the setting back
      // to each reader's own zone, while an absent field leaves it alone.
      const posted = form.has("timezone");
      const timezone = text("timezone");
      if (timezone && !timezoneFrom(timezone)) {
        return { intent, errorKey: "calendar.timezoneBad" } satisfies ActionResult;
      }

      await api(`/v1/core/tenants/${encodeURIComponent(me.tenant.id)}`, {
        env,
        request,
        method: "PATCH",
        body: {
          policyJson: {
            ...me.policy,
            calendarPreference: calendar,
            ...(defaultLocale ? { defaultLocale } : {}),
            ...(currency ? { currency } : {}),
            // undefined drops the key on the way through JSON, which is how
            // "no configured zone" is stored — the field is optional, not "".
            ...(posted ? { timezone: timezone || undefined } : {})
          }
        }
      });
      return { intent, ok: true } satisfies ActionResult;
    }

    if (intent === "dsar") {
      const me = await fetchMe(env, request);
      const subject = me.profile?.email;
      if (!subject) return { intent, errorKey: "problem.unknown" } satisfies ActionResult;
      const type = text("type");
      if (!DSAR_TYPES.includes(type as (typeof DSAR_TYPES)[number])) {
        return { intent, errorKey: "problem.unknown" } satisfies ActionResult;
      }
      const dueAt = Date.now() + DSAR_DUE_MS;
      // Raising the request is not the erasure. Carrying one out is gated by the
      // `compliance.erasure` policy behind `compliance:erasure:execute`, with
      // dual control and no auto-approve (packages/core/src/approvals.ts).
      const raised = await api<{ id: string; dueAt: number }>("/v1/compliance/dsar-requests", {
        env,
        request,
        method: "POST",
        // `state` is left to the column default ("received").
        body: { subjectIdentifier: subject, type, channel: "portal", dueAt }
      });
      return { intent, ok: true, dueAt: raised.dueAt ?? dueAt } satisfies ActionResult;
    }

    if (intent === "lens-reset") {
      await api("/v1/me/lens/reset", { env, request, method: "POST" });
      return { intent, ok: true } satisfies ActionResult;
    }

    if (intent === "create-key") {
      // `scopes` is whatever boxes were ticked; the API re-checks every one
      // against the session, so a tampered form buys nothing but a 403.
      const scopes = form.getAll("scopes").map(String).filter(Boolean);
      const minted = await api<{ key: string }>("/v1/core/api-keys", {
        env,
        request,
        method: "POST",
        body: { name: text("name"), mode: text("mode") === "live" ? "live" : "test", scopes }
      });
      // Straight back to the render and nowhere else — no redirect, because a
      // redirect would drop the one copy of the plaintext that will ever exist.
      return { intent, ok: true, keySecret: minted.key } satisfies ActionResult;
    }

    const id = String(form.get("id") ?? "");
    if (intent === "revoke-session" && id) {
      await api(`/v1/me/sessions/${encodeURIComponent(id)}`, { env, request, method: "DELETE" });
    } else if (intent === "read-notification" && id) {
      await api(`/v1/me/notifications/${encodeURIComponent(id)}/read`, {
        env,
        request,
        method: "POST"
      });
    } else if (intent === "revoke-key" && id) {
      await api(`/v1/core/api-keys/${encodeURIComponent(id)}`, { env, request, method: "DELETE" });
    } else {
      return { intent, errorKey: "problem.unknown" } satisfies ActionResult;
    }
  } catch (error) {
    if (error instanceof ApiError) return { intent, problem: error.problem } satisfies ActionResult;
    throw error;
  }
  return { intent, ok: true } satisfies ActionResult;
}

/* ------------------------------------------------------------------- screen */

export default function Settings() {
  const loaded = useLoaderData<typeof loader>();
  const result = useActionData<ActionResult>();
  const shell = useShellData();
  const navigation = useNavigation();
  const [params] = useSearchParams();
  // A tab the actor may not see is not a tab: /settings/brand without
  // core:tenants:update falls back to the account screen rather than 404ing.
  const tabs = TABS.filter((entry) => !entry.can || loaded.can[entry.can]);
  const asked = useParams().tab;
  const tab = tabs.some((entry) => entry.id === asked) ? asked : "account";
  const [mismatch, setMismatch] = React.useState(false);

  const locale = shell?.locale ?? "en";
  const t = translator(locale);
  const label = labelsFor(locale);
  // One form at a time: a page-wide busy flag would spin every button for one
  // submit and tell the actor nothing about which.
  const pending = navigation.formData?.get("intent");
  const mismatched =
    mismatch || (result?.intent === "password" && result.errorKey === "password.mismatch");

  /** The problem detail, or our own refusal, for the form that produced it. */
  const failure = (intent: string): React.ReactNode => {
    if (result?.intent !== intent) return null;
    if (result.problem) return <Problem problem={result.problem} />;
    if (result.errorKey && result.errorKey !== "password.mismatch") {
      return (
        <Problem
          problem={{ title: fill(label(result.errorKey), result.errorVars ?? {}) }}
        />
      );
    }
    return null;
  };

  /** Confirmation, only once the API has answered. */
  const done = (intent: string, key: string): React.ReactNode =>
    result?.intent === intent && result.ok ? (
      <p role="status" className="font-ui text-13 text-success">
        {label(key)}
      </p>
    ) : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="page-title">{label("settings.title")}</h1>
        <p className="font-ui text-13 text-muted">{settingsLede(loaded.notifications.length, label)}</p>
      </header>

      <nav aria-label={label("tabs.label")} className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((entry) => (
          <Link
            key={entry.id}
            to={`/settings/${entry.id}`}
            aria-current={entry.id === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 font-ui text-13 transition-colors ${
              entry.id === tab
                ? "border-accent text-text"
                : "border-transparent text-subtle hover:text-text"
            }`}
          >
            {label(`tabs.${entry.id}`)}
          </Link>
        ))}
      </nav>

      {tab === "account" ? (
        <>
        {/* ---------------------------------------------------------- profile */}
        <Section id="settings-profile" title={label("profile.title")}>
          {failure("profile")}
          {params.get("saved") === "profile" ? (
            <p role="status" className="font-ui text-13 text-success">
              {t("common.saved")}
            </p>
          ) : null}

          <Form method="post" className="flex flex-col gap-4">
            <input type="hidden" name="intent" value="profile" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={label("profile.name")}>
                <Input
                  name="name"
                  defaultValue={shell?.actorName ?? ""}
                  autoComplete="name"
                  maxLength={120}
                  required
                />
              </Field>
              <Field label={label("profile.locale")} hint={label("profile.localeHint")}>
                <Select
                  name="locale"
                  defaultValue={locale}
                  options={LOCALES.map((code) => ({ value: code, label: nameOfLocale(code) }))}
                />
              </Field>
              {/* Read-only rather than hidden: knowing which address the account
                  answers to is half of what this panel is for. */}
              <Field label={label("profile.email")} hint={label("profile.emailHint")}>
                <Input value={loaded.email} readOnly disabled autoComplete="email" />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" loading={pending === "profile"}>
                {pending === "profile" ? t("common.working") : t("common.save")}
              </Button>
            </div>
          </Form>
        </Section>

        {/* ------------------------------------------------------------ lens */}
        <Section id="settings-lens" title={label("lens.title")} lead={label("lens.intro")}>
          {failure("lens-reset")}
          {done("lens-reset", "lens.ok")}
          {loaded.lensReadable && loaded.lens ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="font-ui text-13 text-text">
                {label("lens.current")}:{" "}
                <span className="font-medium">{t(`nav.${loaded.lens.workspace}`)}</span>
                {" — "}
                {loaded.lens.isDefault ? label("lens.default") : label("lens.custom")}
              </p>
              {loaded.lens.isDefault ? null : (
                <Form method="post">
                  <input type="hidden" name="intent" value="lens-reset" />
                  <Button type="submit" variant="secondary" loading={pending === "lens-reset"}>
                    {pending === "lens-reset" ? t("common.working") : label("lens.reset")}
                  </Button>
                </Form>
              )}
            </div>
          ) : (
            <p className="font-ui text-13 text-subtle">{label("lens.unavailable")}</p>
          )}
        </Section>

        {/* ---------------------------------------------------- notifications */}
        <Section
          id="settings-notifications"
          title={label("notifications.title")}
          lead={label("notifications.intro")}
        >
          {failure("read-notification")}
          {done("read-notification", "notifications.ok")}

          {!loaded.inboxReadable ? (
            <p className="font-ui text-13 text-subtle">{label("notifications.unavailable")}</p>
          ) : loaded.notifications.length === 0 ? (
            <p className="font-ui text-13 text-subtle">{label("notifications.none")}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {loaded.notifications.map((note) => (
                <li key={note.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    {/* titleKey is a shared-catalogue key; an unknown one reads
                        as words rather than as a dotted key (modules/spec.ts). */}
                    <p className="font-ui text-14 break-words text-text">
                      {titleText(t(note.titleKey, note.vars), note.titleKey)}
                    </p>
                    <p className="font-ui text-12 text-subtle">
                      <DateTime value={note.createdAt} locale={locale} precision="minute" relative />
                    </p>
                  </div>
                  <Form method="post">
                    <input type="hidden" name="intent" value="read-notification" />
                    <input type="hidden" name="id" value={note.id} />
                    {/* No aria-label: an accessible name that does not contain the
                        visible one fails WCAG 2.5.3, and the row is the context. */}
                    <Button type="submit" size="sm" loading={pending === "read-notification"}>
                      {label("notifications.read")}
                    </Button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </Section>
        </>
      ) : null}

      {tab === "security" ? (
        <>
        {/* --------------------------------------------------------- password */}
        <Section id="settings-password" title={label("password.title")} lead={label("password.intro")}>
          {failure("password")}

          <Form
            method="post"
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              // Reading the values, never storing them: the check is a comparison
              // and the strings die with the handler.
              const entries = new FormData(event.currentTarget);
              const bad = entries.get("next") !== entries.get("confirm");
              setMismatch(bad);
              if (bad) event.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="password" />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={label("password.current")}>
                <Input name="current" type="password" autoComplete="current-password" required />
              </Field>
              {/* The two new-password boxes stay empty on every render, success or
                  failure: a value attribute is a credential in the DOM. */}
              <Field label={label("password.new")} hint={label("password.hint")}>
                <Input
                  name="next"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={200}
                  required
                />
              </Field>
              {/* One place says "these do not match": the field that is wrong.
                  Both the browser check and the no-script one land here. */}
              <Field
                label={label("password.confirm")}
                {...(mismatched ? { error: label("password.mismatch") } : {})}
              >
                <Input
                  name="confirm"
                  type="password"
                  autoComplete="new-password"
                  minLength={12}
                  maxLength={200}
                  required
                />
              </Field>
            </div>
            <div>
              <Button type="submit" variant="primary" loading={pending === "password"}>
                {pending === "password" ? t("common.working") : label("password.submit")}
              </Button>
            </div>
          </Form>
        </Section>

        {/* -------------------------------------------------------------- mfa */}
        <MfaPanel
          enrolled={loaded.mfaEnrolled}
          showDisable={params.get("mfa") === "off"}
          result={result}
          pending={pending}
          label={label}
          t={t}
          failure={failure}
        />

        {/* ------------------------------------------------------ permissions */}
        <PermissionsPanel permissions={loaded.permissions} pii={loaded.can.pii} label={label} t={t} />

        {/* --------------------------------------------------------- sessions */}
        <Section id="settings-sessions" title={label("sessions.title")}>
          {failure("revoke-session")}
          {done("revoke-session", "sessions.ok")}

          {loaded.sessionsReadable ? (
            <Table<SessionRow>
              columns={sessionColumns(label, locale, pending)}
              rows={loaded.sessions}
              rowKey={(row) => row.id}
              caption={label("sessions.caption")}
              density="compact"
              empty={<EmptyState title={label("sessions.none")} body={label("sessions.none.body")} />}
            />
          ) : (
            <p className="font-ui text-13 text-subtle">{label("sessions.unavailable")}</p>
          )}
        </Section>

        {/* ------------------------------------------------------------- keys */}
        {loaded.can.keysRead ? (
          <Section id="settings-keys" title={label("keys.title")} lead={label("keys.intro")}>
            {failure("revoke-key")}
            {done("revoke-key", "keys.ok")}

            {loaded.keysReadable ? (
              <Table<ApiKeyRow>
                columns={keyColumns(label, locale, pending, loaded.can.keysRevoke)}
                rows={loaded.keys}
                rowKey={(row) => row.id}
                caption={label("keys.caption")}
                density="compact"
                empty={<EmptyState title={label("keys.none")} body={label("keys.none.body")} />}
              />
            ) : (
              <p className="font-ui text-13 text-subtle">{label("keys.unavailable")}</p>
            )}

            {/* Absent, not disabled, when the actor cannot mint — same rule the
                revoke column follows. */}
            {loaded.can.keysCreate ? (
              <NewKeyForm
                grantable={loaded.grantable}
                mayLive={loaded.can.keysLive}
                result={result}
                pending={pending}
                label={label}
                t={t}
                failure={failure}
              />
            ) : null}
          </Section>
        ) : null}
        </>
      ) : null}

      {tab === "brand" ? (
        <>
        <p className="font-ui text-13 text-subtle">{label("settings.tenantIntro")}</p>

        {loaded.can.brand ? (
          <BrandPanel
            brand={loaded.brand}
            tenantName={loaded.tenantName}
            pending={pending}
            label={label}
            t={t}
            failure={failure}
            done={done}
          />
        ) : null}
        </>
      ) : null}

      {tab === "tenant" ? (
        <>
        {loaded.can.brand ? (
          <Section id="settings-calendar" title={label("calendar.title")} lead={label("calendar.intro")}>
            {failure("calendar")}
            {done("calendar", "calendar.ok")}
            <Form method="post" className="flex flex-col gap-4">
              <input type="hidden" name="intent" value="calendar" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={label("calendar.field")} hint={label("calendar.hint")}>
                  <Select
                    name="calendar"
                    defaultValue={loaded.calendar}
                    options={CALENDARS.map((value) => ({ value, label: label(`calendar.${value}`) }))}
                  />
                </Field>
                {/* Only the locales the tenant actually runs in: a default the
                    app has no catalogue for would leave every screen in a
                    language nobody picked. */}
                <Field label={label("calendar.locale")} hint={label("calendar.localeHint")}>
                  <Select
                    name="defaultLocale"
                    defaultValue={loaded.defaultLocale}
                    options={loaded.locales.map((code) => ({ value: code, label: nameOfLocale(code) }))}
                  />
                </Field>
                <Field label={label("calendar.currency")} hint={label("calendar.currencyHint")}>
                  <Input
                    name="currency"
                    defaultValue={loaded.currency}
                    maxLength={3}
                    minLength={3}
                    pattern="[A-Za-z]{3}"
                    autoComplete="off"
                    className="uppercase"
                  />
                </Field>
                {/* The zones this runtime can actually format in, asked of the
                    runtime rather than listed here — a hand-kept list goes
                    stale every time a country moves its clocks. Same answer on
                    the server and the client, so it cannot mismatch on
                    hydration. Blank is a real choice: no tenant zone means
                    each reader reads in their own. */}
                <Field label={label("calendar.timezone")} hint={label("calendar.timezoneHint")}>
                  <Select
                    name="timezone"
                    defaultValue={loaded.timezone}
                    options={[
                      { value: "", label: label("calendar.timezoneAuto") },
                      ...zones(loaded.timezone).map((value) => ({ value, label: value.replace(/_/g, " ") }))
                    ]}
                  />
                </Field>
              </div>
              <div>
                <Button type="submit" variant="primary" loading={pending === "calendar"}>
                  {pending === "calendar" ? t("common.working") : label("calendar.submit")}
                </Button>
              </div>
            </Form>
          </Section>
        ) : null}
        </>
      ) : null}

      {tab === "data" ? (
        <>
        {loaded.can.dsarCreate ? (
          <Section id="settings-dsar" title={label("dsar.title")} lead={label("dsar.intro")}>
            {failure("dsar")}
            {result?.intent === "dsar" && result.ok ? (
              <p role="status" className="font-ui text-13 text-success">
                {label("dsar.ok")}
              </p>
            ) : null}

            <Form method="post" className="flex flex-col gap-4">
              <input type="hidden" name="intent" value="dsar" />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={label("dsar.subject")}>
                  <Input value={loaded.email} readOnly disabled />
                </Field>
                <Field label={label("dsar.type")}>
                  <Select
                    name="type"
                    defaultValue="access"
                    options={DSAR_TYPES.map((type) => ({
                      value: type,
                      label: label(`dsar.type.${type}`)
                    }))}
                  />
                </Field>
              </div>
              <p className="max-w-prose font-ui text-12 text-subtle">{label("dsar.erasureNote")}</p>
              <div>
                <Button type="submit" variant="primary" loading={pending === "dsar"}>
                  {pending === "dsar" ? t("common.working") : label("dsar.submit")}
                </Button>
              </div>
            </Form>

            {loaded.can.dsarRead ? (
              loaded.dsarReadable ? (
                <Table<DsarRow>
                  columns={dsarColumns(label, locale)}
                  rows={loaded.dsar}
                  rowKey={(row) => row.id}
                  caption={label("dsar.caption")}
                  density="compact"
                  empty={<EmptyState title={label("dsar.none")} body={label("dsar.none.body")} />}
                />
              ) : (
                <p className="font-ui text-13 text-subtle">{label("dsar.unavailable")}</p>
              )
            ) : null}
          </Section>
        ) : null}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ panels */

function Section({
  id,
  title,
  lead,
  children
}: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 rounded-lg border border-border p-4">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="eyebrow">
          {title}
        </h2>
        {lead ? <p className="max-w-prose font-ui text-13 text-subtle">{lead}</p> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Enrolment is a two-step conversation with the API and the panel follows it
 * literally: ask for a secret, prove you captured it, keep the recovery codes.
 * Nothing here decides on its own that the account is protected — `mfaEnrolled`
 * is whatever the API last said, and `null` when the actor cannot read it.
 */
function MfaPanel({
  enrolled,
  showDisable,
  result,
  pending,
  label,
  t,
  failure
}: {
  enrolled: boolean | null;
  showDisable: boolean;
  result: ActionResult | undefined;
  pending: FormDataEntryValue | undefined | null;
  label: (key: string) => string;
  t: Translate;
  failure: (intent: string) => React.ReactNode;
}) {
  const secret = result?.intent === "mfa-start" ? result.secret : undefined;
  const codes = result?.intent === "mfa-confirm" ? result.recoveryCodes : undefined;
  const enrolling = Boolean(secret) || Boolean(result?.intent === "mfa-confirm" && result.problem);

  return (
    <Section id="settings-mfa" title={label("mfa.title")} lead={label("mfa.intro")}>
      <p className="font-ui text-13">
        {enrolled === true ? (
          <Badge tone="success" dot>
            {label("mfa.on")}
          </Badge>
        ) : enrolled === false ? (
          <Badge tone="warning" dot>
            {label("mfa.off")}
          </Badge>
        ) : (
          <span className="text-subtle">{label("mfa.unknown")}</span>
        )}
      </p>

      {failure("mfa-start")}
      {failure("mfa-confirm")}
      {failure("mfa-disable")}

      {codes ? (
        // Shown once, and only because the API just returned them. There is no
        // route that reads them back (apps/api/src/auth.ts §mfa).
        <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-surface-2 p-3">
          <h3 className="font-display text-14 text-text">{label("mfa.recoveryTitle")}</h3>
          <p className="max-w-prose font-ui text-12 text-subtle">{label("mfa.recoveryIntro")}</p>
          <ul className="grid gap-1 font-mono text-13 text-text sm:grid-cols-2">
            {codes.map((code) => (
              <li key={code} className="break-all">
                {code}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {enrolling ? (
        <div className="flex flex-col gap-4">
          {secret ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={label("mfa.secret")} hint={label("mfa.secretHint")}>
                <Input value={secret} readOnly className="font-mono" />
              </Field>
              <Field label={label("mfa.uri")}>
                <Input value={result?.otpauthUri ?? ""} readOnly className="font-mono" />
              </Field>
            </div>
          ) : null}
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="mfa-confirm" />
            <Field label={label("mfa.code")} hint={label("mfa.codeHint")} className="w-48">
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
            </Field>
            <Button type="submit" variant="primary" loading={pending === "mfa-confirm"}>
              {pending === "mfa-confirm" ? t("common.working") : label("mfa.confirm")}
            </Button>
          </Form>
        </div>
      ) : codes ? null : showDisable ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h3 className="font-display text-14 text-text">{label("mfa.disableTitle")}</h3>
            <p className="max-w-prose font-ui text-12 text-subtle">{label("mfa.disableIntro")}</p>
          </div>
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="intent" value="mfa-disable" />
            <Field label={label("mfa.code")} className="w-48">
              <Input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={12}
                required
              />
            </Field>
            <Button type="submit" variant="danger" loading={pending === "mfa-disable"}>
              {pending === "mfa-disable" ? t("common.working") : label("mfa.disable")}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/settings">{label("mfa.cancel")}</Link>
            </Button>
          </Form>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {enrolled === true ? null : (
            <Form method="post">
              <input type="hidden" name="intent" value="mfa-start" />
              <Button type="submit" variant="primary" loading={pending === "mfa-start"}>
                {pending === "mfa-start" ? t("common.working") : label("mfa.start")}
              </Button>
            </Form>
          )}
          {enrolled === false ? null : (
            <Button asChild variant="ghost">
              {/* F53: the disable flow lives on the security tab, so the link
                  must carry the :tab segment or the loader defaults to
                  "account" and the mfa=off param is never read. */}
              <Link to="/settings/security?mfa=off">{label("mfa.disableLink")}</Link>
            </Button>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * `core:api_keys:read` reads as "core / api keys / read" — the module is the
 * first segment, and grouping by it is the difference between a wall of strings
 * and a list a person can scan. Insertion order is preserved, which is the order
 * /v1/me emitted, so the grouping never reshuffles between renders.
 */
export function byModule(permissions: readonly string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const permission of permissions) {
    const module = permission.split(":")[0] ?? "";
    groups.set(module, [...(groups.get(module) ?? []), permission]);
  }
  return groups;
}

/**
 * What this account may do, in the platform's own words. Read-only by design:
 * grants are changed at /admin/permissions by someone who holds
 * `core:roles:write`, never by the holder. The point of showing them is that a
 * refusal elsewhere in the product stops being a mystery.
 */
function PermissionsPanel({
  permissions,
  pii,
  label,
  t
}: {
  permissions: readonly string[];
  pii: boolean;
  label: (key: string) => string;
  t: Translate;
}) {
  const groups = byModule(permissions);

  return (
    <Section id="settings-perms" title={label("perms.title")} lead={label("perms.intro")}>
      {permissions.length === 0 ? (
        <p className="font-ui text-13 text-subtle">{label("perms.none")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Native disclosure, same as the key scope picker: an administrator
              holds hundreds of these, and a wall of chips is not a screen. */}
          {[...groups].map(([module, held]) => (
            <details key={module} className="rounded-md border border-border p-2">
              <summary className="cursor-pointer font-ui text-13 text-text">
                {`${moduleName(t, module)} (${held.length})`}
              </summary>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {held.map((permission) => (
                  <li
                    key={permission}
                    className="rounded bg-surface-2 px-1.5 py-0.5 font-ui text-12 text-muted"
                    title={permission}
                  >
                    {permissionTitle(permission)}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}

      {/* Whether personal data arrives masked is the one permission whose effect
          a person sees on every screen, so it is said in words as well. */}
      <p className="max-w-prose font-ui text-12 text-subtle">
        {label(pii ? "perms.pii" : "perms.masked")}
      </p>
    </Section>
  );
}

/**
 * Minting a key. The plaintext comes back in the action's result, is rendered
 * once, and has nowhere else to live — no loader re-reads it, no cookie carries
 * it, and the API stores only its SHA-256 (apps/api/src/routes/core.ts).
 *
 * The scope list is the actor's own permissions, so the picker cannot express a
 * key stronger than the person making it — which is also what the API enforces.
 */
function NewKeyForm({
  grantable,
  mayLive,
  result,
  pending,
  label,
  t,
  failure
}: {
  grantable: string[];
  mayLive: boolean;
  result: ActionResult | undefined;
  pending: FormDataEntryValue | undefined | null;
  label: (key: string) => string;
  t: Translate;
  failure: (intent: string) => React.ReactNode;
}) {
  const minted = result?.intent === "create-key" ? result.keySecret : undefined;
  // ponytail: prefix grouping, not a curated taxonomy; if the list needs
  // friendlier names they belong in the permission catalogue, not here.
  const groups = byModule(grantable);

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex flex-col gap-1">
        <h3 className="font-display text-14 text-text">{label("keys.newTitle")}</h3>
        <p className="max-w-prose font-ui text-12 text-subtle">{label("keys.newIntro")}</p>
      </div>

      {failure("create-key")}

      {minted ? (
        <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-surface-2 p-3">
          <h4 className="font-display text-14 text-text">{label("keys.secretTitle")}</h4>
          <p className="max-w-prose font-ui text-12 text-subtle">{label("keys.secretIntro")}</p>
          {/* Selectable text, not an input: nothing here should look editable,
              and a screen reader should read it as the value it is. */}
          <code role="status" className="break-all font-mono text-13 text-text">
            {minted}
          </code>
        </div>
      ) : null}

      <Form method="post" className="flex flex-col gap-4">
        <input type="hidden" name="intent" value="create-key" />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={label("keys.newName")} hint={label("keys.newNameHint")}>
            <Input name="name" maxLength={120} required />
          </Field>
          <Field label={label("keys.newMode")} hint={label("keys.newModeHint")}>
            <Select
              name="mode"
              defaultValue="test"
              options={[
                { value: "test", label: label("keys.test") },
                ...(mayLive ? [{ value: "live", label: label("keys.live") }] : [])
              ]}
            />
          </Field>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="font-ui text-13 font-medium text-muted">{label("keys.scopes")}</legend>
          <p className="max-w-prose font-ui text-12 text-subtle">{label("keys.scopesHint")}</p>
          {grantable.length === 0 ? (
            <p className="font-ui text-12 text-subtle">{label("keys.scopesNone")}</p>
          ) : (
            // <details> because the list runs to hundreds for an administrator.
            // Native disclosure: keyboard-reachable and focusable with no script.
            [...groups].map(([module, permissions]) => (
              <details key={module} className="rounded-md border border-border p-2">
                <summary className="cursor-pointer font-ui text-13 text-text">
                  {`${moduleName(t, module)} (${permissions.length})`}
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {/* The grant string is the value; what the actor reads is the
                      verb — "Revoke API keys", not `core:api_keys:revoke`. The
                      module is the <summary> they opened to get here. */}
                  {permissions.map((permission) => (
                    <Checkbox
                      key={permission}
                      name="scopes"
                      value={permission}
                      label={permissionTitle(permission)}
                    />
                  ))}
                </div>
              </details>
            ))
          )}
        </fieldset>

        <div>
          <Button type="submit" variant="primary" loading={pending === "create-key"}>
            {pending === "create-key" ? t("common.working") : label("keys.submit")}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * The whitelabel contract and nothing else (packages/ui/src/tokens.css): three
 * accent colours, one typeface, a name and the logos. The preview beside the
 * form is the point — a hex value nobody can picture is how a tenant ends up
 * with unreadable buttons.
 */
function BrandPanel({
  brand,
  tenantName,
  pending,
  label,
  t,
  failure,
  done
}: {
  brand: Awaited<ReturnType<typeof loader>>["brand"];
  tenantName: string;
  pending: FormDataEntryValue | undefined | null;
  label: (key: string) => string;
  t: Translate;
  failure: (intent: string) => React.ReactNode;
  done: (intent: string, key: string) => React.ReactNode;
}) {
  const [accent, setAccent] = React.useState(brand.accent);
  const [contrast, setContrast] = React.useState(brand.accentContrast);
  const ratio = accent && contrast ? contrastRatio(accent, contrast) : null;
  const fails = ratio !== null && ratio < AA_RATIO;

  return (
    <Section id="settings-brand" title={label("brand.title")} lead={label("brand.intro")}>
      {failure("brand")}
      {done("brand", "brand.ok")}

      <Form method="post" className="flex flex-col gap-5">
        <input type="hidden" name="intent" value="brand" />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={label("brand.name")} hint={label("brand.nameHint")}>
            <Input name="name" defaultValue={brand.name} maxLength={80} />
          </Field>
          <Field label={label("brand.font")} hint={label("brand.fontHint")}>
            <Select
              name="font"
              defaultValue={brand.font}
              options={[
                { value: "", label: label("brand.fontDefault") },
                ...FONTS.map((font) => ({ value: font, label: fontName(font) }))
              ]}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={label("brand.logoLight")} hint={label("brand.logoHint")}>
            <Input name="logoLight" type="url" defaultValue={brand.logoLight} maxLength={2000} />
          </Field>
          <Field label={label("brand.logoDark")}>
            <Input name="logoDark" type="url" defaultValue={brand.logoDark} maxLength={2000} />
          </Field>
          <Field label={label("brand.logoMark")}>
            <Input name="logoMark" type="url" defaultValue={brand.logoMark} maxLength={2000} />
          </Field>
        </div>

        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-8">
          <div className="grid flex-1 gap-4 sm:grid-cols-3">
            <Field
              label={label("brand.accent")}
              hint={label("brand.colourHint")}
              {...(fails ? { error: contrastMessage(label, ratio) } : {})}
            >
              <Input
                name="accent"
                value={accent}
                onChange={(event) => setAccent(event.currentTarget.value)}
                pattern="#?[0-9a-fA-F]{6}"
                maxLength={7}
              />
            </Field>
            <Field label={label("brand.accentHover")}>
              <Input
                name="accentHover"
                defaultValue={brand.accentHover}
                pattern="#?[0-9a-fA-F]{6}"
                maxLength={7}
              />
            </Field>
            <Field label={label("brand.accentContrast")}>
              <Input
                name="accentContrast"
                value={contrast}
                onChange={(event) => setContrast(event.currentTarget.value)}
                pattern="#?[0-9a-fA-F]{6}"
                maxLength={7}
              />
            </Field>
          </div>

          {/* Not decoration: this is the pair the contrast rule is about, drawn
              the way a button will draw it. */}
          <div
            className="flex min-w-56 flex-col gap-2 rounded-md border border-border bg-surface-2 p-3"
            aria-hidden="true"
          >
            <p className="font-ui text-12 text-subtle">{label("brand.preview")}</p>
            <p className="font-display text-16 break-words text-text">{brand.name || tenantName}</p>
            <span
              className="inline-flex h-9 items-center justify-center rounded-md px-3 font-ui text-13"
              style={{
                backgroundColor: isHex(accent) ? normaliseHex(accent) : "var(--accent)",
                color: isHex(contrast) ? normaliseHex(contrast) : "var(--accent-contrast)"
              }}
            >
              {label("brand.previewButton")}
            </span>
          </div>
        </div>

        <div>
          <Button type="submit" variant="primary" loading={pending === "brand"} disabled={fails}>
            {pending === "brand" ? t("common.working") : t("common.save")}
          </Button>
        </div>
      </Form>
    </Section>
  );
}

/* ------------------------------------------------------------------ helpers */

/**
 * The session table. `revokedAt` is the only state the API reports — there is no
 * "this is you" flag on /v1/me/sessions, so no row claims to be the current one.
 */
/**
 * A session as the person ending it recognises it. The row carries the raw user
 * agent — `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36
 * (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36` — and this list is how
 * somebody spots the sign-in that is not theirs. Two words they can act on beat
 * a string that is the same for every row until its 90th character.
 */
export function deviceName(ua: string | null | undefined, unknown: string): string {
  if (!ua) return unknown;
  const browser =
    /\bEdg[eA]?\//.test(ua) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(ua) ? "Opera"
    : /\bChrome\//.test(ua) ? "Chrome"
    : /\bFirefox\//.test(ua) ? "Firefox"
    : /\bSafari\//.test(ua) ? "Safari"
    : null;
  const platform =
    /\biPhone\b|\biPad\b/.test(ua) ? "iOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS"
    : /\bWindows\b/.test(ua) ? "Windows"
    : /\bCrOS\b/.test(ua) ? "ChromeOS"
    : /\bLinux\b/.test(ua) ? "Linux"
    : null;
  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? unknown;
}

function sessionColumns(
  label: (key: string) => string,
  locale: string,
  pending: FormDataEntryValue | undefined | null
): Array<Column<SessionRow>> {
  return [
    {
      key: "ua",
      header: label("sessions.device"),
      render: (row) => (
        <span className="block max-w-96 break-words font-ui text-12" title={row.ua ?? undefined}>
          {deviceName(row.ua, label("sessions.unknown"))}
        </span>
      )
    },
    {
      key: "ip",
      header: label("sessions.ip"),
      render: (row) => (
        <span className="font-mono text-12">{row.ip ?? label("sessions.unknown")}</span>
      )
    },
    {
      key: "createdAt",
      header: label("sessions.started"),
      render: (row) => <DateTime value={row.createdAt} locale={locale} precision="minute" />
    },
    {
      key: "expiresAt",
      header: label("sessions.expires"),
      render: (row) => <DateTime value={row.expiresAt} locale={locale} precision="minute" />
    },
    {
      key: "state",
      header: label("sessions.state"),
      render: (row) =>
        row.revokedAt ? (
          <Badge tone="neutral">{label("sessions.ended")}</Badge>
        ) : (
          <Badge tone="success" dot>
            {label("sessions.active")}
          </Badge>
        )
    },
    {
      key: "actions",
      header: label("sessions.end"),
      render: (row) =>
        row.revokedAt ? null : (
          <Form method="post">
            <input type="hidden" name="intent" value="revoke-session" />
            <input type="hidden" name="id" value={row.id} />
            <ConfirmButton
              type="submit"
              variant="danger"
              size="sm"
              loading={pending === "revoke-session"}
              message={label("sessions.endConfirm")}
            >
              {label("sessions.end")}
            </ConfirmButton>
          </Form>
        )
    }
  ];
}

/** Creation lives in NewKeyForm; this is the list, and revoke when permitted. */
function keyColumns(
  label: (key: string) => string,
  locale: string,
  pending: FormDataEntryValue | undefined | null,
  canRevoke: boolean
): Array<Column<ApiKeyRow>> {
  const columns: Array<Column<ApiKeyRow>> = [
    {
      key: "name",
      header: label("keys.name"),
      render: (row) => <span className="block max-w-64 break-words font-ui text-13">{row.name}</span>
    },
    {
      key: "prefix",
      header: label("keys.prefix"),
      render: (row) => <span className="font-mono text-12">{row.prefix}</span>
    },
    {
      key: "mode",
      header: label("keys.mode"),
      render: (row) => (
        <Badge tone={row.mode === "live" ? "warning" : "neutral"}>
          {label(row.mode === "live" ? "keys.live" : "keys.test")}
        </Badge>
      )
    },
    {
      key: "lastUsedAt",
      header: label("keys.used"),
      render: (row) =>
        row.lastUsedAt ? (
          <DateTime value={row.lastUsedAt} locale={locale} precision="minute" relative />
        ) : (
          <span className="font-ui text-12 text-subtle">{label("keys.never")}</span>
        )
    },
    {
      key: "expiresAt",
      header: label("keys.expires"),
      render: (row) =>
        row.expiresAt ? (
          <DateTime value={row.expiresAt} locale={locale} precision="day" />
        ) : (
          <span className="font-ui text-12 text-subtle">{label("keys.noExpiry")}</span>
        )
    },
    {
      key: "state",
      header: label("keys.state"),
      render: (row) =>
        row.revokedAt ? (
          <Badge tone="neutral">{label("keys.revoked")}</Badge>
        ) : (
          <Badge tone="success" dot>
            {label("keys.active")}
          </Badge>
        )
    }
  ];

  // The column is absent rather than disabled when the actor cannot revoke: an
  // affordance that can only 403 is not an affordance.
  if (canRevoke) {
    columns.push({
      key: "actions",
      header: label("keys.revoke"),
      render: (row) =>
        row.revokedAt ? null : (
          <Form method="post">
            <input type="hidden" name="intent" value="revoke-key" />
            <input type="hidden" name="id" value={row.id} />
            <ConfirmButton
              type="submit"
              variant="danger"
              size="sm"
              loading={pending === "revoke-key"}
              message={label("keys.confirm")}
            >
              {label("keys.revoke")}
            </ConfirmButton>
          </Form>
        )
    });
  }

  return columns;
}

function dsarColumns(label: (key: string) => string, locale: string): Array<Column<DsarRow>> {
  return [
    {
      key: "type",
      header: label("dsar.type"),
      render: (row) => <span className="font-ui text-13">{label(`dsar.type.${row.type}`)}</span>
    },
    {
      key: "state",
      header: label("dsar.state"),
      // The API's own state vocabulary; there is no label key for it, so it is
      // said as words rather than guessed at as a translation.
      render: (row) => <Badge tone="neutral">{humanise(row.state)}</Badge>
    },
    {
      key: "dueAt",
      header: label("dsar.due"),
      render: (row) => <DateTime value={row.dueAt} locale={locale} precision="day" />
    },
    {
      key: "createdAt",
      header: label("dsar.raised"),
      render: (row) => <DateTime value={row.createdAt} locale={locale} precision="day" />
    }
  ];
}

/** Every language names itself in its own words, in every catalogue. */
function nameOfLocale(code: string): string {
  return new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
}

// Tenant policy crosses the API boundary as an untyped JSON blob
// (api.server.ts: `policy: Record<string, unknown>`), so what comes back is
// whatever was last written to it — narrow before rendering it.

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

/** The locales a tenant runs in; the platform's own set when unset. */
function localesFrom(value: unknown): string[] {
  return Array.isArray(value) && value.every((one) => typeof one === "string") ? value : [...LOCALES];
}

/** The approved typefaces are proper nouns; they read the same in every locale. */
function fontName(key: string): string {
  return key
    .split("-")
    .map((part) => (part ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function varsOf(raw: unknown): Record<string, string> {
  return Object.fromEntries(
    Object.entries(asJson<Record<string, unknown>>(raw, {})).map(([k, v]) => [k, String(v)])
  );
}

/** Drops the empty strings; an object with nothing left is omitted entirely, so
 *  clearing a field clears the override rather than storing "". */
function pruned(values: Record<string, string>): Record<string, string> | null {
  const kept = Object.entries(values).filter(([, value]) => value !== "");
  return kept.length ? Object.fromEntries(kept) : null;
}

function isHex(value: string): boolean {
  return /^#?[0-9a-fA-F]{6}$/.test(value.trim());
}

function normaliseHex(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** WCAG 2.2 relative luminance. Six-digit hex only — see `isHex`. */
function luminance(value: string): number | null {
  if (!isHex(value)) return null;
  const int = Number.parseInt(normaliseHex(value).slice(1), 16);
  const channels = [(int >> 16) & 255, (int >> 8) & 255, int & 255].map((raw) => {
    const s = raw / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function contrastMessage(label: (key: string) => string, ratio: number | null): string {
  return fill(label("brand.contrastFail"), {
    ratio: AA_RATIO.toFixed(1),
    actual: (ratio ?? 0).toFixed(2)
  });
}

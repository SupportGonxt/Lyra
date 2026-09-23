import { humanise } from "./modules/spec";

/**
 * What an approval policy is called, in the reader's language. The heading of
 * every approvals card, the inbox and the home queue printed `humanise(key)` —
 * English for an Arabic reader. The key list is core's APPROVAL_POLICIES
 * (packages/core/src/approvals.ts); policy.test.ts fails on one left unnamed.
 */
const TITLES: Record<string, Record<string, string>> = {
  en: {
    "axis.ntu": "Not taken up",
    "axis.claim_exgratia": "Ex-gratia payment",
    "dist.rshare_adjust": "Revenue share adjustment",
    "axis.bind": "Issue cover",
    "axis.bind_group": "Issue group cover",
    "axis.endorse": "Endorsement",
    "core.impersonate": "Sign in as a user",
    "core.unmasked_export": "Unmasked export",
    "ai.budget_raise": "AI budget raise",
    "ai.prompt_publish": "Publish a prompt",
    "ai.autonomy_raise": "Raise autonomy",
    "compliance.shariah_certify": "Shariah certification"
  },
  ar: {
    "ledger.refund": "استرداد",
    "ledger.payout": "صرف دفعة",
    "ledger.client_money_transfer": "تحويل أموال العملاء",
    "ledger.partner_settlement": "تسوية الشريك",
    "ledger.success_fee": "أتعاب النجاح",
    "ledger.period_close": "إقفال الفترة",
    "ledger.manual_journal": "قيد يدوي",
    "ledger.opening_balance": "رصيد افتتاحي",
    "ledger.year_end_close": "إقفال نهاية السنة",
    "ledger.write_off": "شطب",
    "ledger.period_close_force": "إقفال فترة قسري",
    "ledger.period_reopen": "إعادة فتح فترة",
    "ledger.remit": "تحويل المستحقات",
    "ledger.surplus": "فائض",
    "ledger.credit_note": "إشعار دائن",
    "axis.case_issue": "إصدار الحالة",
    "axis.price_match": "مطابقة السعر",
    "axis.claim_settlement": "تسوية مطالبة",
    "axis.escrow_release": "الإفراج عن الضمان",
    "axis.claim_reserve": "احتياطي مطالبة",
    "axis.claim_payment": "دفع مطالبة",
    "axis.claim_exgratia": "دفعة استثنائية",
    "axis.recovery_writeoff": "شطب استرداد",
    "axis.bind": "إصدار التغطية",
    "axis.bind_group": "إصدار تغطية جماعية",
    "axis.endorse": "ملحق تعديل",
    "axis.cancel": "إلغاء",
    "axis.reinstate": "إعادة السريان",
    "axis.ntu": "لم يُقبل العرض",
    "axis.renew": "تجديد",
    "axis.underwriting_referral": "إحالة اكتتاب",
    "dist.rate_change": "تغيير سعر العمولة",
    "dist.commission_adjust": "تعديل عمولة",
    "dist.offering_publish": "نشر عرض",
    "dist.settlement_run": "تشغيل التسويات",
    "dist.partner_activate": "تفعيل شريك",
    "dist.rshare_adjust": "تعديل حصة الإيراد",
    "dist.agreement_sign": "توقيع اتفاقية",
    "core.delegation_grant": "منح تفويض",
    "signal.budget_move": "نقل ميزانية",
    "signal.campaign_launch": "إطلاق حملة",
    "signal.creative_publish": "نشر محتوى إبداعي",
    "signal.budget_commit": "الالتزام بالميزانية",
    "signal.boost": "تعزيز منشور",
    "signal.creator_brief": "موجز صانع محتوى",
    "signal.outreach_send": "إرسال تواصل",
    "orbit.renewal_offer": "عرض تجديد",
    "orbit.document_send": "إرسال مستند",
    "scout.whitespace_promote": "ترقية فرصة سوقية",
    "core.impersonate": "الدخول بهوية مستخدم",
    "core.flag_toggle": "تبديل ميزة",
    "core.mandate_register": "تسجيل تفويض وكيل",
    "core.unmasked_export": "تصدير بلا إخفاء",
    "compliance.erasure": "محو البيانات",
    "compliance.legal_hold_release": "رفع الحجز القانوني",
    "compliance.shariah_certify": "شهادة الامتثال الشرعي",
    "ai.autonomy_raise": "رفع مستوى الاستقلالية",
    "ai.prompt_publish": "نشر موجِّه",
    "ai.budget_raise": "رفع ميزانية الذكاء الاصطناعي"
  }
};

/**
 * `axis.claim_payment` → "Claim payment" / "دفع مطالبة". The module prefix goes
 * when it is this row's own module (it is already a line below) and stays when
 * the key came from somewhere else.
 *
 * Lives here rather than in routes/approvals.tsx because the shell's inbox says
 * the same words in the same place, and a component may not import a route
 * module: that drags a loader into the browser bundle.
 */
export function policyTitle(policyKey: string, module: string, locale = "en"): string {
  const base = locale.split("-")[0] ?? "en";
  const named = TITLES[base]?.[policyKey] ?? TITLES.en?.[policyKey];
  if (named) return named;
  return humanise(policyKey.startsWith(`${module}.`) ? policyKey.slice(module.length + 1) : policyKey);
}

export const POLICY_TITLES_AR = TITLES.ar!;

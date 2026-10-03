import type { PolicyState } from "@lyra/core";
import { majorUnits, minorExponent } from "./export/money.js";

// The words a policy document prints for codes: the policy's status and the
// keys (and a few values) of its terms record. A schedule is read by the
// customer, so "active", "excessMinor" or "true" on it is a code leaking into a
// contract — in either language, and unreadable in Arabic (CLAUDE.md §7, §14).
//
// Terms are a free-form record (routes/axis.ts takes `z.record(...)`), so the
// key table can never be complete. A key it does not know is humanised in
// English and printed as a numbered "additional term" in Arabic: the value is
// still there, and the code is not.

type Locale = "en" | "ar";
type Words = Record<Locale, string>;

/** Every policy state has a word; the Record type makes a new state fail to compile until it does. */
const STATUS: Record<PolicyState, Words> = {
  draft: { en: "Draft", ar: "مسودة" },
  bound: { en: "Bound", ar: "مُبرمة" },
  active: { en: "Active", ar: "سارية" },
  lapsed: { en: "Lapsed", ar: "متوقفة لعدم السداد" },
  cancelled: { en: "Cancelled", ar: "ملغاة" },
  expired: { en: "Expired", ar: "منتهية" },
  renewed: { en: "Renewed", ar: "مجددة" },
  ntu: { en: "Not taken up", ar: "لم تُفعّل" }
};

/** Term keys the platform and its seeds write. Pack overrides below. */
const TERM_KEYS: Record<string, Words> = {
  cover: { en: "Cover type", ar: "نوع التغطية" },
  line: { en: "Product line", ar: "خط المنتج" },
  excessMinor: { en: "Excess", ar: "مبلغ التحمل" },
  deductibleMinor: { en: "Deductible", ar: "مبلغ الخصم" },
  limitMinor: { en: "Limit", ar: "حد التغطية" },
  limits: { en: "Limits", ar: "حدود التغطية" },
  thirdParty: { en: "Third party", ar: "الطرف الثالث" },
  sumInsuredMinor: { en: "Sum insured", ar: "مبلغ التأمين" },
  agencyRepair: { en: "Agency repair", ar: "الإصلاح لدى الوكالة" },
  roadside: { en: "Roadside assistance", ar: "المساعدة على الطريق" },
  autoRenew: { en: "Automatic renewal", ar: "تجديد تلقائي" },
  ubi: { en: "Usage-based price adjustment", ar: "تعديل السعر حسب الاستخدام" }
};

/** Domain-pack nouns (CLAUDE.md §14): the same key means something else outside insurance. */
const PACK_TERM_KEYS: Record<string, Record<string, Words>> = {
  "retail-ecom": {
    cover: { en: "Entitlement", ar: "الاستحقاق" },
    sumInsuredMinor: { en: "Covered value", ar: "القيمة المشمولة" }
  }
};

/** Coded values worth a word. Anything else in a term is the tenant's data and prints as given. */
const TERM_VALUES: Record<string, Record<string, Words>> = {
  cover: {
    comprehensive: { en: "Comprehensive", ar: "شاملة" },
    third_party: { en: "Third party only", ar: "ضد الغير" },
    thirdParty: { en: "Third party only", ar: "ضد الغير" },
    tpl: { en: "Third party only", ar: "ضد الغير" }
  },
  line: {
    motor: { en: "Motor", ar: "المركبات" },
    home: { en: "Home", ar: "المنزل" },
    health: { en: "Health", ar: "الصحة" },
    travel: { en: "Travel", ar: "السفر" },
    life: { en: "Life", ar: "الحياة" }
  }
};

const YES_NO: Record<Locale, [string, string]> = { en: ["Yes", "No"], ar: ["نعم", "لا"] };
const EXTRA: Words = { en: "Additional term", ar: "شرط إضافي" };
const ITEMS: Words = { en: "items", ar: "بنود" };

export function statusLabel(status: string, locale: Locale): string {
  const w = STATUS[status as PolicyState];
  if (w) return w[locale];
  return locale === "en" ? humanise(status) : EXTRA.ar;
}

/** `excessMinor` → "Excess", `sum_insured` → "Sum insured". English fallback only. */
function humanise(key: string): string {
  const words = key
    .replace(/(Minor|Json|Ppm)$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : key;
}

export interface TermRow {
  k: string;
  v: string;
}

/**
 * The rows a terms record prints as. Nested objects flatten to
 * "Limits — Third party"; money keys (`…Minor`) print in major units with the
 * version's currency; booleans print as Yes/No.
 */
export function termRows(termsJson: string | null | undefined, opts: { locale: Locale; pack: string; currency: string }): TermRow[] {
  let terms: Record<string, unknown>;
  try {
    terms = JSON.parse(termsJson || "{}") as Record<string, unknown>;
  } catch {
    return [];
  }
  const { locale, pack, currency } = opts;
  let extra = 0;
  const label = (key: string): string => {
    const w = PACK_TERM_KEYS[pack]?.[key] ?? TERM_KEYS[key];
    if (w) return w[locale];
    if (locale === "en") return humanise(key);
    extra += 1;
    return `${EXTRA.ar} ${String(extra).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)))}`;
  };
  const money = (minor: number): string => {
    const dp = minorExponent(currency);
    return `${currency} ${majorUnits(minor, currency).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  };
  const scalar = (key: string, v: unknown): string => {
    if (typeof v === "boolean") return YES_NO[locale][v ? 0 : 1];
    if (typeof v === "number") return /Minor$/.test(key) && Number.isFinite(v) ? money(v) : v.toLocaleString("en-US");
    if (typeof v === "string") return TERM_VALUES[key]?.[v]?.[locale] ?? v;
    return v === null || v === undefined ? "" : String(v);
  };

  const rows: TermRow[] = [];
  const walk = (key: string, v: unknown, prefix: string | undefined): void => {
    const k = prefix ? `${prefix} — ${label(key)}` : label(key);
    if (key === "ubi" && v && typeof v === "object" && typeof (v as { premiumDeltaPpm?: unknown }).premiumDeltaPpm === "number") {
      // The usage-based reprice stamp is provenance (audit ids, evidence
      // refs); what the customer is owed from it is the price movement.
      const pct = (v as { premiumDeltaPpm: number }).premiumDeltaPpm / 10_000;
      rows.push({ k, v: `${pct > 0 ? "+" : ""}${pct.toLocaleString("en-US", { maximumFractionDigits: 2 })}%` });
      return;
    }
    if (Array.isArray(v)) {
      const plain = v.every((x) => x === null || typeof x !== "object");
      rows.push({
        k,
        v: plain ? v.map((x) => scalar(key, x)).join(locale === "ar" ? "، " : ", ") : `${v.length.toLocaleString("en-US")} ${ITEMS[locale]}`
      });
      return;
    }
    if (v && typeof v === "object") {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) walk(ck, cv, k);
      return;
    }
    rows.push({ k, v: scalar(key, v) });
  };
  for (const [key, v] of Object.entries(terms)) walk(key, v, undefined);
  return rows;
}

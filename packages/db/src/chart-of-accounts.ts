// docs/19 §5.1 — the standard chart of accounts. Every tenant is provisioned
// with these rows; tenants may add accounts, never remove or renumber these.
// Codes are the join key everywhere (ledger_journal_lines.account_code), so the
// catalogue lives in @lyra/db and is imported by both seed and provisioning.
//
// ADR-0083: this constant is the *default/seed* chart only. `seed()` and
// `syncChartOfAccounts` (packages/core/src/seed.ts) are its only runtime
// readers — they materialize it into the tenant-scoped `ledger_accounts`
// table. Every other runtime reader (posting, reports, the chart-of-accounts
// report route) must read a tenant's chart through
// `packages/core/src/chart.ts` (`tenantChart`/`tenantAccount`), never this
// constant, so that an account a tenant adds at runtime is visible everywhere
// a seeded one is. `packages/ledger/src/recipes.ts` is the one deliberate
// exception — see the ADR for why its pure builders keep reading this file.

export type AccountType = "asset" | "liability" | "income" | "expense" | "equity";

/** IAS 7 classification (ADR-0090). Absent = derived from the account type. */
export const CASH_FLOW_CLASSES = ["cash", "operating", "investing", "financing"] as const;
export type CashFlowClass = (typeof CASH_FLOW_CLASSES)[number];

export interface AccountDef {
  code: string;
  en: string;
  ar: string;
  type: AccountType;
  /** debit|credit — the side that increases this account. */
  normalSide: "debit" | "credit";
  /** Segregated client money (CBUAE). Guarded by the per-pair 1010 ≥ 2010 invariant. */
  clientMoney?: true;
  /**
   * ADR-0126. On a client-money account, the code of the account holding the
   * same clients' money on the other side: the asset names its liability and
   * the liability names the asset back. A broker is licensed per market, so
   * segregation is a property of the *pair* and never of the tenant's total.
   */
  clientMoneyPair?: string;
  /**
   * The currency the account is held in, where it is fixed (a segregated
   * account is opened for one market's licence). Absent on the many accounts
   * that hold any currency; provisioning falls back to the tenant's own.
   * A reporting label only — every balance is still summed from the journal
   * lines' own currency.
   */
  currency?: string;
  /** A clearing/suspense account that must net to zero at period close (ADR-0083). */
  suspense?: true;
  /** IAS 7 class (ADR-0090); absent = derived from `type`. */
  cashFlow?: CashFlowClass;
}

export const CHART_OF_ACCOUNTS: readonly AccountDef[] = [
  // assets
  { code: "1000", en: "Cash – Operating", ar: "النقد – التشغيلي", type: "asset", normalSide: "debit", cashFlow: "cash" },
  { code: "1010", en: "Cash – Client Money", ar: "النقد – أموال العملاء", type: "asset", normalSide: "debit", clientMoney: true, clientMoneyPair: "2010", currency: "AED" },
  // ADR-0126. The second licence, held to the same rule as the first. A broker
  // is licensed per market, and one market's client money may not be spent on
  // another market's clients, so this is a pair of its own and not a currency
  // column on 1010. `1011` sits beside `1010` because the chart is grouped by
  // kind; the pairing, not the number, is what binds it to `2011`.
  { code: "1011", en: "Cash – Client Money (KSA)", ar: "النقد – أموال العملاء (السعودية)", type: "asset", normalSide: "debit", clientMoney: true, clientMoneyPair: "2011", currency: "SAR" },
  { code: "1100", en: "Commission Receivable", ar: "عمولات مستحقة القبض", type: "asset", normalSide: "debit" },
  { code: "1150", en: "Financier Receivable", ar: "مستحقات من جهة التمويل", type: "asset", normalSide: "debit" },
  { code: "1155", en: "Recovery Receivable", ar: "مستحقات الاسترداد", type: "asset", normalSide: "debit" },
  { code: "1160", en: "Trade Receivable", ar: "ذمم مدينة تجارية", type: "asset", normalSide: "debit" },
  { code: "1200", en: "Premium Receivable", ar: "أقساط مستحقة القبض", type: "asset", normalSide: "debit" },
  { code: "1300", en: "PSP Clearing", ar: "تسوية مزود خدمة الدفع", type: "asset", normalSide: "debit", suspense: true },

  // liabilities
  { code: "2000", en: "Insurer Payable", ar: "مستحقات لشركات التأمين", type: "liability", normalSide: "credit" },
  { code: "2010", en: "Client Money Liability", ar: "التزام أموال العملاء", type: "liability", normalSide: "credit", clientMoney: true, clientMoneyPair: "1010", currency: "AED" },
  // ADR-0126, the liability side of the KSA licence. It names `1011` back, so a
  // pair that is half-written is a chart the controls refuse rather than one
  // they silently skip.
  { code: "2011", en: "Client Money Liability (KSA)", ar: "التزام أموال العملاء (السعودية)", type: "liability", normalSide: "credit", clientMoney: true, clientMoneyPair: "1011", currency: "SAR" },
  { code: "2100", en: "Partner / Publisher Payable", ar: "مستحقات الشركاء والناشرين", type: "liability", normalSide: "credit" },
  { code: "2150", en: "Creator Payable", ar: "مستحقات صنّاع المحتوى", type: "liability", normalSide: "credit" },
  { code: "2200", en: "Tax Payable", ar: "ضرائب مستحقة الدفع", type: "liability", normalSide: "credit" },
  // ADR-0121 / docs/29 G1. One tax liability could not say which tax it held:
  // an EU/UK insurance premium tax posted as though it were recoverable VAT, and
  // Egypt's table tax on a premium landed in the same account as the VAT beside
  // it — two returns, one balance. The rule's `kind` decides which of the three
  // the money belongs to.
  { code: "2210", en: "Insurance Premium Tax Payable", ar: "ضريبة أقساط التأمين مستحقة الدفع", type: "liability", normalSide: "credit" },
  { code: "2220", en: "Table Tax Payable", ar: "ضريبة الجدول مستحقة الدفع", type: "liability", normalSide: "credit" },
  { code: "2250", en: "Accrued Expenses", ar: "مصروفات مستحقة", type: "liability", normalSide: "credit" },
  { code: "2300", en: "Deferred Revenue", ar: "إيرادات مؤجلة", type: "liability", normalSide: "credit" },
  { code: "2350", en: "Customer Deposits", ar: "ودائع العملاء", type: "liability", normalSide: "credit" },
  { code: "2400", en: "Refunds Payable", ar: "مبالغ مستردة مستحقة الدفع", type: "liability", normalSide: "credit" },
  // Takaful (docs/16 H8, docs/27 F45). A takaful risk fund is the participants'
  // money that the operator manages; it is never the operator's revenue, which
  // is why a surplus distribution cannot be posted as a partner revenue share
  // (5400/2100) the way SURPLUS-DIST's generic recipe used to. Two accounts,
  // because declaring a surplus and paying it are two different facts: 2040 is
  // what the fund holds, 2050 is what has been declared out of it and is owed.
  //
  // Not flagged `clientMoney`. The tabarru' fund is segregated under a takaful
  // operator's own licence, not under the CBUAE client-money rules the 1010 >=
  // 2010 invariant enforces, and folding it into that invariant would make one
  // regulatory test answer for two regimes. Its own segregation test is H8
  // LATER, and it needs its own asset account to be written against.
  { code: "2040", en: "Takaful Participants' Fund", ar: "صندوق المشتركين التكافلي", type: "liability", normalSide: "credit" },
  { code: "2050", en: "Takaful Surplus Payable", ar: "فائض تكافلي مستحق الدفع", type: "liability", normalSide: "credit" },
  // Reinsurance (docs/30 AXIS 5, ADR-0106). What the tenant, as underwriter,
  // owes a reinsurer for premium ceded under a treaty, net of the ceding
  // commission the reinsurer gives back. RI-CEDE moves the ceded share here out
  // of 2000: the premium was never revenue, so ceding it is a reclassification
  // of who the premium is owed to, not an expense.
  { code: "2060", en: "Reinsurance Payable", ar: "مستحقات إعادة التأمين", type: "liability", normalSide: "credit" },

  // equity (docs/27 F3). Retained earnings are posted by YEAR-END-CLOSE, not
  // derived: a derived plug makes the balance sheet un-auditable and leaves
  // closePeriod with nothing to do but flip a status.
  { code: "3000", en: "Share Capital", ar: "رأس المال", type: "equity", normalSide: "credit" },
  { code: "3100", en: "Retained Earnings", ar: "الأرباح المحتجزة", type: "equity", normalSide: "credit" },
  { code: "3200", en: "Owner Drawings", ar: "مسحوبات الملاك", type: "equity", normalSide: "credit" },

  // income
  { code: "4000", en: "Commission – New", ar: "عمولة – أعمال جديدة", type: "income", normalSide: "credit" },
  { code: "4010", en: "Commission – Renewal", ar: "عمولة – تجديد", type: "income", normalSide: "credit" },
  { code: "4020", en: "Brokerage Fees", ar: "أتعاب الوساطة", type: "income", normalSide: "credit" },
  { code: "4030", en: "Referral Revenue", ar: "إيرادات الإحالة", type: "income", normalSide: "credit" },
  { code: "4040", en: "Subscription Revenue", ar: "إيرادات الاشتراكات", type: "income", normalSide: "credit" },
  { code: "4045", en: "Membership Revenue", ar: "إيرادات العضوية", type: "income", normalSide: "credit" },
  { code: "4050", en: "Usage Revenue", ar: "إيرادات الاستخدام", type: "income", normalSide: "credit" },
  { code: "4060", en: "Data Products", ar: "إيرادات منتجات البيانات", type: "income", normalSide: "credit" },
  { code: "4070", en: "Advertising Revenue", ar: "إيرادات الإعلانات", type: "income", normalSide: "credit" },
  { code: "4075", en: "Marketplace Revenue", ar: "إيرادات السوق", type: "income", normalSide: "credit" },
  { code: "4080", en: "Financing Commission", ar: "عمولة التمويل", type: "income", normalSide: "credit" },
  { code: "4090", en: "Service Fees", ar: "رسوم الخدمات", type: "income", normalSide: "credit" },
  // docs/19 §5.3 revaluation (docs/27 F18). Unrealised, and therefore its own
  // pair of accounts rather than folded into the income it came nowhere near:
  // a controller has to be able to read the margin without the exchange rate in it.
  { code: "4095", en: "FX Revaluation Gain", ar: "أرباح إعادة تقييم العملة", type: "income", normalSide: "credit" },
  // The operator's own share of a declared takaful surplus. Under wakala the
  // operator is paid a fee and takes none of the surplus, so this account stays
  // at zero; under mudaraba it is the operator's agreed share. One account,
  // because which model a product runs is a product attribute (core_products
  // .takaful_json) and not a different posting shape.
  { code: "4096", en: "Takaful Operator Surplus Share", ar: "حصة المشغّل من الفائض التكافلي", type: "income", normalSide: "credit" },
  // The ceding commission a reinsurer allows on premium ceded to it (ADR-0106).
  // Its own account rather than 4000: it is earned from a reinsurer on the
  // tenant's own underwriting, not from an insurer for distribution.
  { code: "4097", en: "Reinsurance Ceding Commission", ar: "عمولة التنازل عن إعادة التأمين", type: "income", normalSide: "credit" },

  // expense / contra-income
  { code: "5000", en: "Commission Clawback", ar: "استرداد العمولة", type: "expense", normalSide: "debit" },
  { code: "5100", en: "Media Spend", ar: "الإنفاق الإعلامي", type: "expense", normalSide: "debit" },
  { code: "5150", en: "Creator Spend", ar: "إنفاق صنّاع المحتوى", type: "expense", normalSide: "debit" },
  { code: "5200", en: "AI & Inference COGS", ar: "تكلفة الذكاء الاصطناعي والاستدلال", type: "expense", normalSide: "debit" },
  { code: "5300", en: "Payment Processing Fees", ar: "رسوم معالجة المدفوعات", type: "expense", normalSide: "debit" },
  { code: "5400", en: "Partner Revenue Share", ar: "حصة الشركاء من الإيرادات", type: "expense", normalSide: "debit" },
  { code: "5450", en: "Recovery Written Off", ar: "استرداد مشطوب", type: "expense", normalSide: "debit" },
  { code: "5500", en: "FX Revaluation Loss", ar: "خسائر إعادة تقييم العملة", type: "expense", normalSide: "debit" },
  // One account for both directions of a reconciliation write-off: a residual
  // we give up collecting is a debit here, one the counterparty overpaid is a
  // credit, and the period's net difference is then a single figure a
  // controller can be asked about. Splitting it in two would hide the netting.
  { code: "5510", en: "Reconciliation Write-Off", ar: "فروق تسوية مشطوبة", type: "expense", normalSide: "debit" }
];

const BY_CODE = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));

export function account(code: string): AccountDef | undefined {
  return BY_CODE.get(code);
}

/**
 * The **legacy singular** client-money accounts.
 *
 * Read these and you will reintroduce the defect item 2 of the 2026-10 audit removed.
 * They say there is **one** client-money asset and **one** liability; the platform has
 * as many pairs as the tenant's chart declares — `1010/2010` (AED) and `1011/2011`
 * (SAR) ship in the seed — so the segregation invariant, the position report, the
 * Money Map and the period-close check all read `clientMoneyPairs(ctx)`
 * (`packages/core/src/chart.ts`) instead.
 *
 * **They have no caller in the repository**, verified by counting rather than by
 * reading: a repo-wide sweep finds these two lines and nothing else. They are kept
 * because `docs/specs/gap-finance-design.md:539` says to keep them — *"stay exported
 * unchanged so no existing caller breaks"* — and that reason has since **expired**,
 * since there is no existing caller. Deleting them is a change to a client-facing
 * design, so it is **not** made here; what is fixed here is the comment that presented
 * them as the answer.
 *
 * `clientMoneyPairs` is the answer. This is a leftover with a spec paragraph behind it.
 */
export const CLIENT_MONEY_ACCOUNT = "1010";
export const CLIENT_MONEY_LIABILITY_ACCOUNT = "2010";

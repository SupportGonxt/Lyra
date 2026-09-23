import type { ReactNode } from "react";
import { Button, cn, focusRing, PageHeader } from "@lyra/ui";
import { ApiError } from "../api-error";
import { plural, pseudoText, translator } from "../i18n";
import { optionLabel } from "../modules/spec";
import { vocabulary } from "../modules/vocabulary";

// The six composite record screens (customer 360, policy, claim, case, product,
// channel) are the same shape: one primary read plus a fan-out of scoped panel
// reads, each of which the actor may not hold. This is the part they share —
// the panel-degradation rule, the list envelope, the definition-list pair every
// summary block is built from, and the vocabulary those six screens have in
// common (statuses, the money and identity nouns a domain pack renames, and the
// chrome around a denied panel). A route's own table only carries its own copy.

/** The list envelope apps/api/src/crud.ts returns (`{ data, cursor? }`). */
export interface Page<T> {
  data: T[];
  cursor?: string;
}

export type Label = (key: string, vars?: Record<string, string>) => string;

/**
 * Vocabulary every one of the six screens needs. Enum values are keyed the way
 * `optionLabel` resolves them (`<column>.<value>`, falling back to the bare
 * value), and the industry nouns are keyed the way `modules/vocabulary.ts`
 * keys them — `premiumMinor`, `claimNo`, `insurer` — so a tenant on a different
 * domain pack gets its own word without these routes knowing the word exists.
 */
export const SHARED: Record<string, Record<string, string>> = {
  en: {
    deniedTitle: "You can't open this record",
    back: "Back",
    open: "Open",
    none: "Nothing on file here.",
    approvalTitle: "Waiting on an approval",
    approvalBody: "This needs sign-off under {policy} before it can go through.",
    approvalLink: "Open the approval queue",

    // Industry nouns — a domain pack renames these (docs/21 §3).
    policies: "Cover",
    policyNo: "Policy number",
    policyId: "Policy",
    premiumMinor: "Premium",
    minPremiumMinor: "Minimum premium",
    bestPremiumMinor: "Best price",
    coverageJson: "Cover",
    claims: "Claims",
    claimNo: "Claim number",
    insurer: "Underwriter",
    renewal: "Renewal",

    // Shared column headings.
    colRef: "Reference",
    colStatus: "Status",
    colKind: "Kind",
    colAmount: "Amount",
    colCreated: "Created",
    colUpdated: "Updated",
    colCurrency: "Currency",
    colDocument: "Document",
    colSensitivity: "Sensitivity",
    colWhen: "When",
    colWho: "Who",
    colOutcome: "Outcome",

    // Report downloads. Three finance screens offer the same four formats
    // against the same export route, so the words live here once — the third
    // screen to write them down itself is how "Excel" and "Spreadsheet" end up
    // beside each other (docs/ui.md §7 P3-14).
    download: "Download",
    "download.xlsx": "Excel",
    "download.pdf": "PDF",
    "download.csv": "CSV",
    "download.json": "JSON",

    // core_customers
    "type.person": "Individual",
    "type.business": "Business",
    "kycStatus.none": "Not started",
    "kycStatus.pending": "In progress",
    "kycStatus.verified": "Verified",
    "kycStatus.failed": "Failed",

    // core_users — a staff row is invited before it is active (staff.tsx,
    // staff-member.tsx both read this column).
    "status.invited": "Invited",
    "status.suspended": "Suspended",

    // axis_policies
    "status.active": "Active",
    "status.lapsed": "Lapsed",
    "status.cancelled": "Cancelled",
    "status.renewed": "Renewed",
    "status.paused": "Paused",
    "status.draft": "Draft",
    "status.withdrawn": "Withdrawn",
    "status.terminated": "Terminated",

    // axis_claims
    "status.reported": "Reported",
    "status.assessing": "Assessing",
    "status.approved": "Approved",
    "status.rejected": "Rejected",
    "status.settled": "Settled",

    // axis_cases
    "status.intake": "Intake",
    "status.quoting": "Quoting",
    "status.awaiting_docs": "Awaiting documents",
    "status.review": "Review",
    "status.approval": "Approval",
    "status.issued": "Issued",
    "status.failed": "Failed",

    // axis_documents
    "status.received": "Received",
    "status.extracting": "Reading",
    "status.extracted": "Read",
    "status.verified": "Verified",

    "docType.eid": "Identity card",
    "docType.mulkiya": "Vehicle registration",
    "docType.census": "Member list",
    "docType.medical": "Medical report",
    "docType.tradelicense": "Trade licence",
    "docType.other": "Other",

    "piiLevel.none": "None",
    "piiLevel.low": "Low",
    "piiLevel.high": "High",

    "priority.low": "Low",
    "priority.normal": "Normal",
    "priority.high": "High",
    "priority.urgent": "Urgent",

    "decision.pending": "Pending",
    "decision.approved": "Approved",
    "decision.rejected": "Rejected",

    // orbit_conversations
    "state.bot": "Automated",
    "state.human": "With a person",
    "state.closed": "Closed",

    // dist_quote_requests
    "state.open": "Open",
    "state.fanned_out": "Out to market",
    "state.complete": "Priced",
    "state.expired": "Expired",
    "state.converted": "Bought",
    "state.abandoned": "Abandoned",

    // dist_commission_entries
    "kind.new_business": "New sale",
    "kind.endorsement": "Endorsement",
    "kind.clawback": "Clawback",
    "kind.adjustment": "Adjustment",
    "state.accrued": "Earned",
    "state.invoiced": "Invoiced",
    "state.received": "Received",
    "state.payable": "Payable",
    "state.clawed_back": "Clawed back",
    "state.written_off": "Written off",

    // ledger_settlements
    "state.draft": "Draft",
    "state.approved": "Approved",
    "state.paid": "Paid",
    "state.disputed": "Disputed",

    // dist_next_best_offers
    "state.proposed": "Proposed",
    "state.surfaced": "Shown",
    "state.accepted": "Accepted",
    "state.dismissed": "Dismissed",
    "state.suppressed": "Held back"
  },
  ar: {
    deniedTitle: "لا يمكنك فتح هذا السجل",
    back: "رجوع",
    open: "فتح",
    none: "لا يوجد شيء مسجّل هنا.",
    approvalTitle: "بانتظار موافقة",
    approvalBody: "يحتاج هذا إلى موافقة بموجب {policy} قبل أن يمضي.",
    approvalLink: "افتح قائمة الموافقات",

    policies: "التغطية",
    policyNo: "رقم الوثيقة",
    policyId: "الوثيقة",
    premiumMinor: "القسط",
    minPremiumMinor: "الحد الأدنى للقسط",
    bestPremiumMinor: "أفضل سعر",
    coverageJson: "التغطية",
    claims: "المطالبات",
    claimNo: "رقم المطالبة",
    insurer: "شركة التأمين",
    renewal: "التجديد",

    colRef: "المرجع",
    colStatus: "الحالة",
    colKind: "النوع",
    colAmount: "المبلغ",
    colCreated: "تاريخ الإنشاء",
    colUpdated: "آخر تحديث",
    colCurrency: "العملة",
    colDocument: "المستند",
    colSensitivity: "درجة الحساسية",
    colWhen: "التاريخ",
    colWho: "المنفّذ",
    colOutcome: "النتيجة",

    download: "تنزيل",
    "download.xlsx": "إكسل",
    "download.pdf": "PDF",
    "download.csv": "CSV",
    "download.json": "JSON",

    "type.person": "فرد",
    "type.business": "منشأة",
    "kycStatus.none": "لم يبدأ",
    "kycStatus.pending": "قيد التنفيذ",
    "kycStatus.verified": "تم التحقق",
    "kycStatus.failed": "فشل",

    "status.invited": "مدعو",
    "status.suspended": "موقوف",

    "status.active": "سارية",
    "status.lapsed": "منقضية",
    "status.cancelled": "ملغاة",
    "status.renewed": "مجدّدة",
    "status.paused": "موقوفة مؤقتًا",
    "status.draft": "مسودة",
    "status.withdrawn": "مسحوبة",
    "status.terminated": "منتهية",

    "status.reported": "مُبلّغ عنها",
    "status.assessing": "قيد التقييم",
    "status.approved": "معتمدة",
    "status.rejected": "مرفوضة",
    "status.settled": "مسددة",

    "status.intake": "الاستلام",
    "status.quoting": "التسعير",
    "status.awaiting_docs": "بانتظار المستندات",
    "status.review": "المراجعة",
    "status.approval": "الموافقة",
    "status.issued": "صادرة",
    "status.failed": "فشل",

    "status.received": "مستلم",
    "status.extracting": "قيد القراءة",
    "status.extracted": "تمت القراءة",
    "status.verified": "موثّق",

    "docType.eid": "بطاقة الهوية",
    "docType.mulkiya": "ملكية المركبة",
    "docType.census": "قائمة الأعضاء",
    "docType.medical": "تقرير طبي",
    "docType.tradelicense": "الرخصة التجارية",
    "docType.other": "أخرى",

    "piiLevel.none": "لا شيء",
    "piiLevel.low": "منخفضة",
    "piiLevel.high": "عالية",

    "priority.low": "منخفضة",
    "priority.normal": "عادية",
    "priority.high": "مرتفعة",
    "priority.urgent": "عاجلة",

    "decision.pending": "معلّقة",
    "decision.approved": "معتمدة",
    "decision.rejected": "مرفوضة",

    "state.bot": "آلية",
    "state.human": "مع موظف",
    "state.closed": "مغلقة",

    "state.open": "مفتوح",
    "state.fanned_out": "معروض على السوق",
    "state.complete": "تم التسعير",
    "state.expired": "منتهي",
    "state.converted": "تم الشراء",
    "state.abandoned": "متروك",

    "kind.new_business": "بيع جديد",
    "kind.endorsement": "تعديل",
    "kind.clawback": "استرداد",
    "kind.adjustment": "تسوية",
    "state.accrued": "مستحقة",
    "state.invoiced": "مفوترة",
    "state.received": "محصّلة",
    "state.payable": "واجبة الدفع",
    "state.clawed_back": "مستردة",
    "state.written_off": "مشطوبة",

    "state.draft": "مسودة",
    "state.approved": "معتمدة",
    "state.paid": "مدفوعة",
    "state.disputed": "متنازع عليها",

    "state.proposed": "مقترح",
    "state.surfaced": "معروض",
    "state.accepted": "مقبول",
    "state.dismissed": "مستبعد",
    "state.suppressed": "محجوب"
  }
};

/**
 * `labelsIn` for a route's in-file bilingual table, with `{var}` interpolation.
 * Resolution is pack → route table → shared table → the platform catalogue's
 * `common.<key>` → the key itself, so a tenant selling something other than
 * insurance renames the nouns (CLAUDE.md §14) without any of these screens
 * carrying an industry word of its own, and a word the whole platform already
 * says — Save, Cancel, Status — is said the same way everywhere it is said
 * (docs/ui.md §7 P3-14).
 */
export function labelsFrom(labels: Record<string, Record<string, string>>) {
  return (locale: string, pack?: string): Label => {
    const packed = vocabulary(pack, locale);
    const own = labels[locale] ?? labels.en ?? {};
    const ownEn = labels.en ?? {};
    const shared = SHARED[locale] ?? SHARED.en!;
    const t = translator(locale);
    return (key, vars) => {
      const mine = packed(key) ?? own[key] ?? ownEn[key] ?? shared[key] ?? SHARED.en![key];
      // `t()` pseudoizes on its own, and answers with the key it was handed when
      // the catalogue has no such word — which is the signal to fall through.
      const common = mine === undefined ? t(`common.${key}`) : pseudoText(locale, mine);
      const raw = common === `common.${key}` ? key : common;
      return vars ? plural(raw, vars, locale).replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match) : raw;
    };
  };
}

/** One enum value as a label: `status.settled`, then `settled`, then humanised. */
export function tag(l: Label, column: string, value: string | null | undefined): string {
  return value ? optionLabel((key) => l(key), column, value) : "—";
}

/**
 * A withheld panel is an absent panel. A composite screen reads from half a
 * dozen resources and an actor rarely holds all of them, so a 403 (or a 404 for
 * a reference that no longer resolves) degrades that one panel and leaves the
 * rest of the screen standing. Anything else is a real fault and still throws.
 */
export async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

export function rowsOf<T>(page: Page<T> | null | undefined): T[] {
  return page?.data ?? [];
}

export function sumBy<T>(rows: readonly T[], pick: (row: T) => number | null | undefined): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

/**
 * A `*Json` name column, as the API hydrates it: `{en, ar}` for a product or a
 * channel, a `{first,last}`-ish object for a person, or a plain string. Falls
 * back to the id rather than rendering an object.
 */
export function nameOf(value: unknown, locale: string, fallback: string): string {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (value && typeof value === "object") {
    const bag = value as Record<string, unknown>;
    const localised = bag[locale] ?? bag.en;
    if (typeof localised === "string" && localised.trim() !== "") return localised;
    const words = Object.values(bag).filter((part): part is string => typeof part === "string");
    if (words.length > 0) return words.join(" ").trim();
  }
  return fallback;
}

/** Rates are ppm across the platform (1 000 000 = 100%). */
export function percentOf(ppm: number | null | undefined, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(
    (ppm ?? 0) / 1_000_000
  );
}

/** The `{policy}` a 403 `approval_required` names, for callers that need the key. */
export function policyKeyOf(problem: unknown): string | null {
  const extras = problem as { status?: number; code?: string; policy_key?: string } | null;
  if (!extras || extras.status !== 403 || extras.code !== "approval_required") return null;
  return extras.policy_key ?? "";
}

/** The flat list of `{term, value}` pairs every summary block on these screens is. */
export function Facts({ children }: { children: ReactNode }) {
  return <dl className="flex flex-wrap gap-x-8 gap-y-4">{children}</dl>;
}

export function Entry({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="eyebrow">{term}</dt>
      <dd className="font-ui text-13 text-text">{children}</dd>
    </div>
  );
}

export function Header({ title, intro }: { title: string; intro: string }) {
  return <PageHeader title={title} description={intro} />;
}

/**
 * The formats `GET /v1/ledger/reports/:report/export` renders. PDF is offered
 * for every report and the API refuses it with a 400 when a row carries
 * non-Latin text (the base-14 fonts have no Arabic), because which rows are
 * Latin is not knowable until the report is run.
 */
export const EXPORT_FORMATS = ["xlsx", "pdf", "csv", "json"] as const;

/**
 * One report, four files. `url` is the export address with the query the
 * loader normalised, ending on a separator so this only has to name the format
 * — the file is then the answer to exactly the question the screen is showing.
 *
 * Plain links straight to the API: the browser downloads, so there is no
 * progress to fake and nothing to hold in state, and nothing is written client
 * side — a second spreadsheet writer would be a second, unaudited rendering of
 * the same money (docs/19 §9).
 */
export function ReportDownloads({ url, l }: { url: string; l: Label }) {
  return (
    <nav aria-label={l("download")} className="flex flex-wrap items-center gap-2">
      <span className="font-ui text-13 text-subtle">{l("download")}</span>
      {EXPORT_FORMATS.map((format) => (
        <Button key={format} asChild variant="ghost" size="sm">
          <a href={`${url}format=${format}`} rel="noopener" download>
            {l(`download.${format}`)}
          </a>
        </Button>
      ))}
    </nav>
  );
}

/**
 * A JSON column shown as-is: cover terms, rating inputs, an FNOL statement.
 * `tabIndex` because a wide payload scrolls sideways and nothing inside it can
 * take focus — a mouse-only scroller is a wall to a keyboard (WCAG 2.2 AA,
 * axe scrollable-region-focusable).
 */
export function Payload({ value }: { value: unknown }) {
  return (
    <pre
      tabIndex={0}
      className={cn(
        "overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-12 text-muted",
        focusRing
      )}
    >
      {JSON.stringify(value ?? {}, null, 2)}
    </pre>
  );
}

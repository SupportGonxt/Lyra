import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema } from "@lyra/db";
import { audit, conflict, emit, notFound, scoped, sha256Hex, type Ctx } from "@lyra/core";
import type { ReportTable } from "@lyra/ledger";
import { isoDay } from "@lyra/model-gateway";
import { pdfSafe, toPdf, type PdfLabels } from "./export/pdf.js";

// docs/27 F27 / docs/specs/gap-axis-design.md §D.11. A contract the customer
// cannot hold is not a contract they have been sold. This renders the document
// for one policy version, stores it and attaches it to that version. Delivery
// is ORBIT's: AXIS emits `axis.policy.document_issued` and stops there —
// `axis_policy_versions.deliveredAt` is stamped by whoever actually sends it.
//
// The spec names `core_templates` as the source of the copy. No such table
// exists; the nearest real one is `core_message_templates`, which is keyed by
// outbound *channel* (email|sms|whatsapp|push) and holds message bodies, not
// document layouts. Rather than bend a messaging table into a document store,
// the copy lives in the noun table below, read by domain pack.

type PolicyRow = typeof schema.axisPolicies.$inferSelect;
type VersionRow = typeof schema.axisPolicyVersions.$inferSelect;

export const PolicyDocumentBody = z.object({
  kind: z.enum(["schedule", "certificate", "endorsement", "cancellation"]),
  /** Which version the document describes. Absent means the one on risk now. */
  versionId: z.string().min(1).optional()
});
export type PolicyDocumentInput = z.infer<typeof PolicyDocumentBody>;
export type PolicyDocumentKind = PolicyDocumentInput["kind"];

/**
 * Domain-pack nouns for the document (CLAUDE.md §14). Same seam as
 * apps/web/app/modules/vocabulary.ts, which cannot be imported here — the web
 * app does not depend on @lyra/core and this is the first server surface that
 * needs nouns. ponytail: two small tables beat a package move for one caller;
 * merge them into @lyra/core when a second server surface needs the same words.
 *
 * English and Arabic: pdf.ts embeds an Arabic face (ADR-0114), so a document
 * is written in its reader's language. Keyed `pack` → `locale` → noun; a
 * locale with no table here reads English.
 */
const PACKS: Record<string, Record<string, Record<string, string>>> = {
  "insurance-retail": {
    en: {
      schedule: "Policy schedule",
      certificate: "Certificate of insurance",
      endorsement: "Endorsement",
      cancellation: "Cancellation notice",
      policyNo: "Policy number",
      insured: "Insured",
      premium: "Premium",
      cover: "Cover",
      terms: "Cover terms"
    },
    ar: {
      schedule: "جدول الوثيقة",
      certificate: "شهادة التأمين",
      endorsement: "ملحق الوثيقة",
      cancellation: "إشعار الإلغاء",
      policyNo: "رقم الوثيقة",
      insured: "المؤمن له",
      premium: "القسط",
      cover: "التغطية",
      terms: "شروط التغطية"
    }
  },
  "retail-ecom": {
    en: {
      schedule: "Order confirmation",
      certificate: "Proof of purchase",
      endorsement: "Order amendment",
      cancellation: "Cancellation notice",
      policyNo: "Order number",
      insured: "Customer",
      premium: "Order value",
      cover: "Entitlement period",
      terms: "Entitlements"
    },
    ar: {
      schedule: "تأكيد الطلب",
      certificate: "إثبات الشراء",
      endorsement: "تعديل الطلب",
      cancellation: "إشعار الإلغاء",
      policyNo: "رقم الطلب",
      insured: "العميل",
      premium: "قيمة الطلب",
      cover: "فترة الاستحقاق",
      terms: "الاستحقاقات"
    }
  }
};

const PLATFORM: Record<string, Record<string, string>> = {
  en: {
    version: "Version",
    status: "Status",
    from: "From",
    to: "To",
    issued: "Issued",
    effectiveFrom: "Effective from",
    reason: "Reason",
    change: "Change",
    tax: "Tax",
    fees: "Fees",
    total: "Total",
    detail: "Detail",
    value: "Value",
    amount: "Amount",
    item: "Item"
  },
  ar: {
    version: "الإصدار",
    status: "الحالة",
    from: "من",
    to: "إلى",
    issued: "تاريخ الإصدار",
    effectiveFrom: "ساري من",
    reason: "السبب",
    change: "التغيير",
    tax: "الضريبة",
    fees: "الرسوم",
    total: "الإجمالي",
    detail: "البيان",
    value: "القيمة",
    amount: "المبلغ",
    item: "البند"
  }
};

/** The renderer's own page furniture, in the document's language. */
const FURNITURE: Record<string, PdfLabels> = {
  ar: {
    generated: "تاريخ الإنشاء",
    continued: "تابع",
    total: "الإجمالي",
    noData: "لا توجد بيانات",
    page: (page, of) => `صفحة ${page} من ${of}`
  }
};

/** A document's language: one this module has words for, else English. */
function documentLocale(locale: string | null | undefined): "en" | "ar" {
  return locale?.toLowerCase().startsWith("ar") ? "ar" : "en";
}

function nounsFor(pack: string, locale: "en" | "ar"): (key: string) => string {
  const tables = PACKS[pack] ?? PACKS["insurance-retail"]!;
  const own = tables[locale] ?? {};
  const en = tables.en!;
  return (key) => own[key] ?? PLATFORM[locale]?.[key] ?? en[key] ?? PLATFORM.en![key] ?? key;
}

/**
 * `{en,ar}` name blobs: the document's language, else English, else whatever
 * name the customer gave — an Arabic-only name is the name, not a gap.
 */
function nameOf(json: string | null | undefined, locale: string): string {
  if (!json) return "";
  try {
    const map = JSON.parse(json) as Record<string, string>;
    return map[locale] ?? map.en ?? Object.values(map)[0] ?? "";
  } catch {
    return "";
  }
}

/** The version the document is about: asked for, else on risk, else the last. */
async function versionFor(ctx: Ctx, policy: PolicyRow, versionId?: string): Promise<VersionRow> {
  if (versionId) {
    const [asked] = await ctx.db
      .select()
      .from(schema.axisPolicyVersions)
      .where(
        scoped(
          ctx,
          schema.axisPolicyVersions,
          and(eq(schema.axisPolicyVersions.id, versionId), eq(schema.axisPolicyVersions.policyId, policy.id))
        )
      );
    if (!asked) throw notFound("policy version");
    return asked;
  }
  const [current] = await ctx.db
    .select()
    .from(schema.axisPolicyVersions)
    .where(scoped(ctx, schema.axisPolicyVersions, eq(schema.axisPolicyVersions.policyId, policy.id)))
    // `effective` first, then the highest sequence — a cancelled policy has no
    // effective version left but its last one is still what the notice is about.
    .orderBy(desc(schema.axisPolicyVersions.state), desc(schema.axisPolicyVersions.versionSeq))
    .limit(1);
  if (!current) throw conflict("this policy has no version to document");
  return current;
}

function tablesFor(a: {
  kind: PolicyDocumentKind;
  noun: (key: string) => string;
  policy: PolicyRow;
  version: VersionRow;
  insured: string;
  now: number;
}): ReportTable[] {
  const { kind, noun, policy, version, insured, now } = a;
  const kv = (rows: { k: string; v: string }[]): ReportTable => ({
    title: noun(kind),
    columns: [
      { key: "k", label: noun("detail"), kind: "text" },
      { key: "v", label: noun("value"), kind: "text" }
    ],
    rows,
    generatedAt: now
  });

  const head = [
    { k: noun("policyNo"), v: policy.policyNo },
    { k: noun("insured"), v: insured },
    { k: noun("version"), v: String(version.versionSeq) },
    { k: noun("status"), v: policy.status },
    { k: `${noun("cover")} — ${noun("from")}`, v: isoDay(version.effectiveFrom) },
    { k: `${noun("cover")} — ${noun("to")}`, v: isoDay(version.effectiveTo) },
    { k: noun("issued"), v: isoDay(now) }
  ];

  const money = (rows: { item: string; amount: number }[]): ReportTable => ({
    title: noun("premium"),
    columns: [
      { key: "item", label: noun("item"), kind: "text" },
      { key: "amount", label: noun("amount"), kind: "money" }
    ],
    rows,
    currency: version.currency,
    generatedAt: now
  });

  // A certificate proves cover, so it carries no prices: it is the document
  // handed to a third party (a bank, a traffic desk) who has no business
  // seeing what the customer paid.
  if (kind === "certificate") return [kv(head)];

  if (kind === "cancellation") {
    return [
      kv([
        ...head,
        { k: noun("reason"), v: policy.cancelReasonCode ?? version.reasonCode ?? "" },
        { k: noun("effectiveFrom"), v: isoDay(policy.cancelEffectiveAt ?? policy.cancelledAt ?? now) }
      ])
    ];
  }

  if (kind === "endorsement") {
    const changes = Object.entries(JSON.parse(version.termsJson || "{}") as Record<string, unknown>).map(([k, v]) => ({
      k,
      v: typeof v === "string" ? v : JSON.stringify(v)
    }));
    return [
      kv([
        ...head,
        { k: noun("reason"), v: version.reasonCode ?? version.reason },
        { k: noun("effectiveFrom"), v: isoDay(version.effectiveFrom) }
      ]),
      money([{ item: noun("change"), amount: version.premiumDeltaMinor }]),
      ...(changes.length ? [{ ...kv(changes), title: noun("terms") }] : [])
    ];
  }

  const terms = Object.entries(JSON.parse(version.termsJson || "{}") as Record<string, unknown>).map(([k, v]) => ({
    k,
    v: typeof v === "string" ? v : JSON.stringify(v)
  }));
  return [
    kv(head),
    money([
      { item: noun("premium"), amount: version.premiumMinor },
      { item: noun("tax"), amount: version.taxMinor },
      { item: noun("fees"), amount: version.feesMinor },
      { item: noun("total"), amount: version.premiumMinor + version.taxMinor + version.feesMinor }
    ]),
    ...(terms.length ? [{ ...kv(terms), title: noun("terms") }] : [])
  ];
}

export async function issuePolicyDocument(ctx: Ctx, policy: PolicyRow, input: PolicyDocumentInput, bucket?: R2Bucket) {
  const version = await versionFor(ctx, policy, input.versionId);

  const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId));
  const brand = tenant?.brandJson ? (JSON.parse(tenant.brandJson) as { name?: string }) : {};
  // Brand tokens, not brand strings (CLAUDE.md §5): the footer is the tenant's
  // own name, never the platform's.
  const issuer = brand.name ?? tenant?.name ?? "";
  const [customer] = policy.customerId
    ? await ctx.db.select().from(schema.customers).where(scoped(ctx, schema.customers, eq(schema.customers.id, policy.customerId)))
    : [];

  // The document is the customer's, so it is written in *their* language
  // (core_customers.locale), not the language of whoever pressed the button —
  // the bind that issues a schedule automatically has no reader of its own.
  // With no customer row, the requester's locale is all there is (ADR-0114).
  const locale = documentLocale(customer ? customer.locale : ctx.locale);
  const noun = nounsFor(ctx.policy.domainPack, locale);

  const build = (nameLocale: string): ReportTable[] =>
    tablesFor({
      kind: input.kind,
      noun,
      policy,
      version,
      insured: nameOf(customer?.nameJson, nameLocale),
      now: ctx.now
    });
  // Latin-1 and Arabic both draw (ADR-0114), so this falls back only for a
  // name in a script no embedded font covers — to the English name if there
  // is one — and refuses only when nothing drawable is left.
  let tables = build(locale);
  if (!pdfSafe(tables)) tables = build("en");
  if (!pdfSafe(tables)) throw conflict("this document contains text the renderer cannot draw");

  const bytes = toPdf(tables, {
    orientation: "portrait",
    footer: issuer,
    meta: { [noun("policyNo")]: policy.policyNo, [noun("version")]: String(version.versionSeq) },
    ...(locale === "ar" ? { direction: "rtl" as const, labels: FURNITURE.ar } : {})
  });

  const fileId = newId("file", ctx.now);
  const r2Key = `axis/policies/${ctx.tenantId}/${policy.id}/${input.kind}-v${version.versionSeq}-${fileId}.pdf`;
  if (bucket) await bucket.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" } });

  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "axis_policy_document",
    subjectRef: version.id,
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    contentType: "application/pdf",
    // It names the insured and what they hold.
    piiLevel: "high",
    createdAt: ctx.now,
    deletedAt: null
  });

  // The version carries the document that describes it, so a later endorsement
  // cannot silently repoint the schedule the customer was actually sent.
  await ctx.db
    .update(schema.axisPolicyVersions)
    .set({ documentFileId: fileId, updatedAt: ctx.now })
    .where(scoped(ctx, schema.axisPolicyVersions, eq(schema.axisPolicyVersions.id, version.id)));

  const issued = {
    id: fileId,
    fileId,
    policyId: policy.id,
    versionId: version.id,
    versionSeq: version.versionSeq,
    kind: input.kind,
    contentType: "application/pdf",
    sizeBytes: bytes.byteLength,
    issuedAt: ctx.now
  };
  await audit(ctx, { action: "axis.policy.document_issued", subjectRef: policy.id, after: issued });
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.document_issued",
    subject: policy.id,
    data: { ...issued, customerId: policy.customerId }
  });
  return issued;
}

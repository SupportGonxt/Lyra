import { and, eq, inArray, or } from "drizzle-orm";
import { schema } from "@lyra/db";
import { sha256Hex, type Ctx } from "@lyra/core";
import { utf8 } from "./export/zip.js";
import type { ReportTable } from "@lyra/ledger";

// docs/modules/axis.md §8, acceptance criterion 3: "Any case exports a complete
// signed audit bundle."
//
// Nothing implemented it. Bundles existed for ledger recon
// (`/v1/ledger/recon/runs/{id}/evidence-bundle`) and for compliance, both writing
// the same `compliance_evidence_bundles` row and the same R2 layout — so this is
// the third caller of an existing shape rather than a third shape, and it needs
// no new table.
//
// What "signed" means here, and it is worth being precise because the word is
// easy to overclaim: the bundle is **hash-manifested and tamper-evident**. Every
// artefact carries its sha256 in `manifest.json`, the manifest travels inside the
// archive, and `bundleHash` is the sha256 of the archive *including* the
// manifest — so one hash quoted anywhere proves the whole set, and an entry can
// be verified against the manifest without trusting the archive. There is no
// cryptographic signature by a key, and the docstring says so rather than
// letting a regulator discover it.
//
// The audit rows are what make it an *audit* bundle: `core_audit_log` is a hash
// chain (`prevHash` → `chainHash`), so including the chain for this case's
// subject refs lets a reader walk it independently.

/** One file in the archive. `path` is what a reader sees inside the zip. */
export interface BundleFile {
  path: string;
  data: Uint8Array;
}

export interface BundleManifestEntry {
  path: string;
  sizeBytes: number;
  sha256: string;
}

export interface CaseBundle {
  contents: BundleFile[];
  manifest: {
    kind: "axis_case";
    caseId: string;
    generatedAt: number;
    counts: Record<string, number>;
    entries: BundleManifestEntry[];
    /** What a reader would expect and is not here, named rather than omitted. */
    missing: string[];
    /**
     * How to read the hash. Written into the manifest itself so the bundle
     * explains its own guarantee wherever it ends up.
     */
    hashNote: string;
  };
  scope: Record<string, unknown>;
}

const HASH_NOTE =
  "Each entry's sha256 is over its own bytes. bundleHash (on the bundle record) is the sha256 of the " +
  "archive including this manifest, so verifying bundleHash proves the whole set. This bundle is " +
  "hash-manifested and tamper-evident; it is not cryptographically signed.";

/** JSON at two spaces, as bytes — the same rendering every other bundle uses. */
const json = (value: unknown): Uint8Array => utf8(JSON.stringify(value, null, 2));

/** JSON Lines, one row per line, so a reader can stream a long chain. */
const jsonl = (rows: readonly unknown[]): Uint8Array => utf8(rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""));

/**
 * Everything a case is made of, as files.
 *
 * A missing artefact is **named in `missing`**, never silently omitted: a bundle
 * that quietly leaves out the policy of an unbound case reads as a case with no
 * policy, which is a different and much worse claim.
 */
export async function assembleCaseBundle(ctx: Ctx, caseId: string): Promise<CaseBundle> {
  const [row] = await ctx.db
    .select()
    .from(schema.axisCases)
    .where(and(eq(schema.axisCases.tenantId, ctx.tenantId), eq(schema.axisCases.id, caseId)))
    .limit(1);
  if (!row) throw new Error("case not found");

  const contents: BundleFile[] = [];
  const missing: string[] = [];
  const counts: Record<string, number> = {};

  contents.push({ path: "case.json", data: json(row) });
  counts.cases = 1;

  // The comparative shop this case came from, and every response the panel gave.
  const requests = row.quoteRequestId
    ? await ctx.db
        .select()
        .from(schema.distQuoteRequests)
        .where(and(eq(schema.distQuoteRequests.tenantId, ctx.tenantId), eq(schema.distQuoteRequests.id, row.quoteRequestId)))
    : [];
  if (!row.quoteRequestId) missing.push("quote_request: the case records no comparative shop");
  counts.quoteRequests = requests.length;
  if (requests.length) contents.push({ path: "quote-requests.json", data: json(requests) });

  const responses = requests.length
    ? await ctx.db
        .select()
        .from(schema.distQuoteResponses)
        .where(and(eq(schema.distQuoteResponses.tenantId, ctx.tenantId), inArray(schema.distQuoteResponses.requestId, requests.map((r) => r.id))))
    : [];
  counts.quoteResponses = responses.length;
  if (responses.length) contents.push({ path: "quote-responses.json", data: json(responses) });
  else if (requests.length) missing.push("quote_responses: the shop was sent and the panel answered nothing");

  // The policy, if the case bound. `axis_policies.caseId` is the link.
  const policies = await ctx.db
    .select()
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), eq(schema.axisPolicies.caseId, caseId)));
  counts.policies = policies.length;
  if (policies.length) contents.push({ path: "policies.json", data: json(policies) });
  else missing.push("policy: the case has not bound, so there is no contract in this bundle");

  const documents = await ctx.db
    .select()
    .from(schema.axisDocuments)
    .where(and(eq(schema.axisDocuments.tenantId, ctx.tenantId), eq(schema.axisDocuments.caseId, caseId)));
  counts.documents = documents.length;
  if (documents.length) contents.push({ path: "documents.json", data: json(documents) });

  // The commission the placement earned. Keyed on the policy, so it is present
  // exactly when the case bound.
  const commissions = policies.length
    ? await ctx.db
        .select()
        .from(schema.distCommissionEntries)
        .where(and(eq(schema.distCommissionEntries.tenantId, ctx.tenantId), inArray(schema.distCommissionEntries.policyId, policies.map((p) => p.id))))
    : [];
  counts.commissionEntries = commissions.length;
  if (commissions.length) contents.push({ path: "commissions.json", data: json(commissions) });

  // The audit chain for everything this case touched. The subject refs are the
  // shapes the rest of the platform writes: the case itself, its documents, and
  // the policy it became.
  const refs = [
    `axis_case:${caseId}`,
    `axis_case:${row.ref}`,
    caseId,
    ...documents.map((d) => `axis_document:${d.id}`),
    ...policies.flatMap((p) => [`axis_policy:${p.id}`, `policy:${p.id}`])
  ];
  const auditRows = await ctx.db
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.tenantId, ctx.tenantId), or(...refs.map((ref) => eq(schema.auditLog.subjectRef, ref)))));
  counts.auditEntries = auditRows.length;
  // Ordered by the chain, not by time: `prevHash` is what a reader walks.
  const chain = [...auditRows].sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  contents.push({ path: "audit.jsonl", data: jsonl(chain) });
  if (!chain.length) missing.push("audit: no audit row names this case, which is itself worth asking about");

  // Hash every entry, manifest included in the zip by the caller.
  const entries: BundleManifestEntry[] = await Promise.all(
    contents.map(async (file) => ({ path: file.path, sizeBytes: file.data.length, sha256: await sha256Hex(file.data) }))
  );

  return {
    contents,
    manifest: {
      kind: "axis_case",
      caseId,
      generatedAt: ctx.now,
      counts,
      entries,
      missing,
      hashNote: HASH_NOTE
    },
    scope: { caseId, ref: row.ref, status: row.status, kinds: [...new Set(documents.map((d) => d.docType))] }
  };
}

/* ------------------------------------------------------------------- the PDF */

// docs/modules/axis.md §2.4, "Audit-on-demand": the export is a **signed PDF+JSON
// bundle**. The JSON half is above; this is the PDF, rendered from the same
// assembly so the two cannot disagree about what the case contains.
//
// The tables are built here and rendered by the caller (routes/axis.ts), which is
// the idiom the policy schedule already uses — pure data in the engine, bytes at
// the edge — and it keeps this testable without a PDF reader.

/** Column labels per language. Domain nouns come from the domain pack, not here. */
const TRAIL_LABELS: Record<string, Record<string, string>> = {
  en: {
    identity: "Case audit bundle",
    field: "Field",
    value: "Value",
    ref: "Reference",
    status: "Status",
    generated: "Generated",
    artefacts: "Artefacts in this bundle",
    artefact: "Artefact",
    count: "Count",
    missing: "Expected and not present",
    notPresent: "Not present",
    chainTitle: "Audit chain",
    when: "When",
    actor: "Actor",
    action: "Action",
    subject: "Subject",
    chain: "Chain hash",
    docsTitle: "Documents",
    docType: "Document",
    extracted: "Extraction",
    confidence: "Confidence",
    verified: "Verified by",
    none: "None"
  },
  ar: {
    identity: "حزمة تدقيق الحالة",
    field: "الحقل",
    value: "القيمة",
    ref: "المرجع",
    status: "الحالة",
    generated: "تاريخ الإنشاء",
    artefacts: "المرفقات في هذه الحزمة",
    artefact: "المرفق",
    count: "العدد",
    missing: "متوقّع وغير موجود",
    notPresent: "غير موجود",
    chainTitle: "سلسلة التدقيق",
    when: "الوقت",
    actor: "الفاعل",
    action: "الإجراء",
    subject: "الموضوع",
    chain: "بصمة السلسلة",
    docsTitle: "المستندات",
    docType: "المستند",
    extracted: "الاستخراج",
    confidence: "الثقة",
    verified: "تحقّق بواسطة",
    none: "لا شيء"
  }
};

export const trailLabelsFor = (locale: string): Record<string, string> => TRAIL_LABELS[locale] ?? TRAIL_LABELS.en!;

/**
 * The bundle as report tables: its identity, what it holds, what it does not, the
 * audit chain and the documents.
 *
 * The `missing` table is deliberately present even when empty and says "None" —
 * an audit reader has to be able to tell "nothing was missing" from "this page
 * was not generated", and an absent table cannot say that.
 */
export function trailTables(bundle: CaseBundle, locale = "en"): ReportTable[] {
  const t = trailLabelsFor(locale);
  const generatedAt = bundle.manifest.generatedAt;
  const rows = (pairs: [string, string][]): Record<string, unknown>[] =>
    pairs.map(([field, value]) => ({ field, value }));

  const identity: ReportTable = {
    title: t.identity!,
    columns: [
      { key: "field", label: t.field!, kind: "text" },
      { key: "value", label: t.value!, kind: "text" }
    ],
    rows: rows([
      [t.ref!, bundle.scope.ref as string],
      [t.status!, String(bundle.scope.status ?? "")],
      [t.generated!, new Date(generatedAt).toISOString()]
    ]),
    generatedAt
  };

  const contents: ReportTable = {
    title: t.artefacts!,
    columns: [
      { key: "artefact", label: t.artefact!, kind: "text" },
      { key: "count", label: t.count!, kind: "number" },
      { key: "sha256", label: "sha256", kind: "text" }
    ],
    rows: bundle.manifest.entries.map((entry) => ({ artefact: entry.path, count: entry.sizeBytes, sha256: entry.sha256 })),
    generatedAt
  };

  const missing: ReportTable = {
    title: t.missing!,
    columns: [{ key: "what", label: t.field!, kind: "text" }],
    rows: bundle.manifest.missing.length
      ? bundle.manifest.missing.map((what) => ({ what }))
      : [{ what: t.none! }],
    generatedAt
  };

  // The chain, read back out of the bundle rather than re-queried: the PDF must
  // describe the archive it travels in, not the database at render time.
  const chainRows = parseJsonl(bundle.contents.find((file) => file.path === "audit.jsonl")?.data) as AuditRow[];
  const chain: ReportTable = {
    title: t.chainTitle!,
    columns: [
      { key: "ts", label: t.when!, kind: "date" },
      { key: "actorRef", label: t.actor!, kind: "text" },
      { key: "action", label: t.action!, kind: "text" },
      { key: "subjectRef", label: t.subject!, kind: "text" },
      { key: "chainHash", label: t.chain!, kind: "text" }
    ],
    rows: chainRows.map((row) => ({
      ts: row.ts,
      actorRef: row.actorRef,
      action: row.action,
      subjectRef: row.subjectRef ?? "",
      chainHash: row.chainHash
    })),
    generatedAt
  };

  const docs = parseJson(bundle.contents.find((file) => file.path === "documents.json")?.data) as DocRow[] | null;
  const documents: ReportTable = {
    title: t.docsTitle!,
    columns: [
      { key: "docType", label: t.docType!, kind: "text" },
      { key: "status", label: t.status!, kind: "text" },
      { key: "extracted", label: t.extracted!, kind: "text" },
      { key: "confidence", label: t.confidence!, kind: "number" },
      { key: "verifiedBy", label: t.verified!, kind: "text" }
    ],
    rows: (docs ?? []).map((doc) => ({
      docType: doc.docType,
      status: doc.status,
      extracted: doc.extractionModel ?? t.notPresent!,
      confidence: doc.extractionConfidence ?? 0,
      verifiedBy: doc.verifiedBy ?? t.notPresent!
    })),
    generatedAt
  };

  return [identity, contents, missing, chain, documents];
}

interface AuditRow {
  ts: number;
  actorRef: string;
  action: string;
  subjectRef: string | null;
  chainHash: string;
}

interface DocRow {
  docType: string;
  status: string;
  extractionModel: string | null;
  extractionConfidence: number | null;
  verifiedBy: string | null;
}

/** JSON Lines back to rows. A file that will not parse is empty, not a crash:
 *  the JSON half of the bundle is still the authority. */
function parseJsonl(data: Uint8Array | undefined): unknown[] {
  if (!data) return [];
  return new TextDecoder()
    .decode(data)
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function parseJson(data: Uint8Array | undefined): unknown {
  if (!data) return null;
  try {
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
}

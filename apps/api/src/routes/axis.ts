import { Hono } from "hono";
import { and, eq, desc, not, sql } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema } from "@lyra/db";
import {
  actorRef,
  AppError,
  assertPolicyTransition,
  isPolicyState,
  audit,
  badRequest,
  canSeePii,
  conflict,
  decide,
  emit,
  forbidden,
  gate,
  hashObject,
  notFound,
  openFields,
  require_,
  scoped,
  sealFields,
  sha256Hex,
  verifyGroundedness,
  withIdempotency,
  type Ctx
} from "@lyra/core";
import { buildRecipe, runTxn } from "@lyra/ledger";
import {
  EXTRACTION_FIELDS,
  SENSITIVE_EXTRACTION_FIELDS,
  extractionMessages,
  extractionSchema,
  parseExtraction,
  parseVisionExtraction,
  promptInstant,
  visionExtractionMessages,
  visionExtractionSchema
} from "@lyra/model-gateway";
import { body, csvBody, InstantMs } from "../http.js";
import { readUpload } from "../upload.js";
import { must } from "../rows.js";
import { EndorseBody, changeSetHashOf, endorsePolicy, priceEndorsement } from "../engines/axis-endorse.js";
import { MAX_POINTS_PER_BATCH, TelematicsIngest, repriceFromTelemetry, unpricedExposureKey } from "../engines/telematics.js";
import { bindGroup, brokerFee } from "../engines/group-commission.js";
import { importCases } from "../engines/axis-case-import.js";
import { applyBulkAction } from "../engines/axis-bulk.js";
import {
  CancelBody,
  LapseBody,
  NtuBody,
  ReinstateBody,
  RenewBody,
  cancelPolicy,
  lapsePolicy,
  ntuPolicy,
  priceCancellation,
  reinstatePolicy,
  renewPolicy
} from "../engines/axis-lifecycle.js";
import {
  ClaimReserveBody,
  ClaimTransitionBody,
  appendReserve,
  listReserves,
  permissionForClaimTransition,
  transitionClaim
} from "../engines/axis-claim-lifecycle.js";
import { writeRecommendedReserve } from "../engines/axis-reserve-advisor.js";
import { scoreAndReferClaim } from "../engines/axis-fraud-scorer.js";
import { predictSlaBreach } from "../engines/axis-sla-sentinel.js";
import {
  CaseTransitionBody,
  permissionForCaseTransition,
  transitionCase
} from "../engines/axis-case-lifecycle.js";
import { PolicyDocumentBody, issuePolicyDocument } from "../engines/axis-policy-document.js";
import { renderDocumentPages } from "../engines/axis-document-render.js";
import {
  ClaimPaymentBody,
  RecoveryOpenBody,
  RecoveryReceiptBody,
  RecoveryWriteOffBody,
  listClaimPayments,
  listClaimRecoveries,
  openRecovery,
  receiveRecovery,
  requestClaimPayment,
  writeOffRecovery
} from "../engines/axis-claims.js";
import {
  CoverageCheckBody,
  FnolBody,
  checkCoverage,
  policyForCoverage,
  registerFnol
} from "../engines/axis-fnol.js";
import { GenerateBordereauBody, generateBordereaux, reconcileBordereaux } from "../engines/axis-bordereaux.js";
import { cancelPlan, createPlan, livePlanOf } from "../engines/premium-financing.js";
import { embedUpsert } from "../engines/vectorize.js";
import { meterEgress } from "../engines/egress.js";
import { fieldKey, type App } from "../env.js";

// docs/07 §3. The one axis verb generated CRUD cannot express: verifying a
// document. `verifiedBy` and `verifiedAt` are evidence that a named person
// looked at the file at a known time, so they come from the session and the
// clock — a PATCH would let the caller name its own verifier.

export const axisRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/** The doc types the AXIS resource definition offers (apps/web/app/modules/axis.ts). */
const DOC_TYPES = new Set(["eid", "mulkiya", "census", "medical", "tradelicense", "other"]);

/**
 * Capture: a multipart photo or scan becomes a stored file plus the
 * `axis_documents` row that points at it, in one call. The generated CRUD
 * create takes a `fileId` it has no way to produce, so before this the only
 * door for bytes was the public portal — a field agent with a licence disc in
 * front of them had nowhere to send it. Mounted before the generic
 * `/documents/:id` handlers so "upload" is never read as an id.
 */
axisRoutes.post("/documents/upload", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:documents:upload", { tenantId: ctx.tenantId, module: "axis" });
  const form = await c.req.formData();
  const caseId = form.get("caseId");
  const docType = form.get("docType");
  if (typeof caseId !== "string" || !caseId) throw badRequest("caseId is required");
  if (typeof docType !== "string" || !DOC_TYPES.has(docType)) throw badRequest("docType is not a known document type");
  // 404 for another tenant's case, same as every other read.
  const kase = await must(ctx, schema.axisCases, caseId, "case");

  const bucket = c.env.FILES;
  if (!bucket) throw conflict("document storage is not configured");
  const { bytes, contentType } = await readUpload(form);

  const fileId = newId("fil", ctx.now);
  const r2Key = `axis/${ctx.tenantId}/${kase.id}/${fileId}`;
  await bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "axis_document",
    subjectRef: `axis_case:${kase.id}`,
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    contentType,
    // An identity document or a licence disc is as sensitive as this platform holds.
    piiLevel: "high",
    createdAt: ctx.now,
    deletedAt: null
  });

  const row = {
    id: newId("doc", ctx.now),
    tenantId: ctx.tenantId,
    caseId: kase.id,
    fileId,
    docType,
    // "received", never "extracted": extraction is a separate, audited call
    // (`POST /documents/:id/extract`) and nothing has read these bytes yet.
    status: "received" as const,
    createdAt: ctx.now
  };
  await ctx.db.insert(schema.axisDocuments).values(row);
  await audit(ctx, {
    action: "axis.documents.upload",
    subjectRef: `axis_document:${row.id}`,
    after: { id: row.id, caseId: kase.id, docType, fileId, contentType, sizeBytes: bytes.length }
  });
  return c.json(row, 201);
});

axisRoutes.post("/documents/:id/verify", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:documents:verify", { tenantId: ctx.tenantId, module: "axis" });
  const rowId = c.req.param("id");
  // 404, not 403, for another tenant's document: `must` goes through the same
  // tenant scope every read does, so a row the caller may not see does not exist.
  const before = await must(ctx, schema.axisDocuments, rowId, "documents");

  // ponytail: no body at all. Nothing here is the caller's to choose, so there
  // is no schema to validate — the only input is the id in the path.
  const after = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, {}, async () => {
    // Inside the wrap, not before it: a retry with the same idempotency key
    // must replay the cached success, not trip over the state its own first
    // attempt already produced.
    if (before.status === "verified") throw conflict(`document is already ${before.status}`);
    const stamp = { verifiedBy: actorRef(ctx), verifiedAt: ctx.now, status: "verified" as const };
    await ctx.db
      .update(schema.axisDocuments)
      .set(stamp)
      .where(scoped(ctx, schema.axisDocuments, eq(schema.axisDocuments.id, rowId)));

    const after = { ...before, ...stamp };
    // Bare id, as the generated create/update/delete on this same row use — the
    // verification has to line up with them in one subject's audit trail.
    await audit(ctx, { action: "axis.documents.verify", subjectRef: rowId, before, after });
    return after;
  });
  return c.json(after);
});

const ExtractBody = z.object({
  // Optional now (AXIS §G.5, ADR-0036): without it, the route renders the
  // document's own file to a page image and runs vision extraction instead.
  // Still accepted directly for tests and any doc type whose text is already
  // in hand — that path skips rendering entirely.
  rawText: z.string().min(1).max(20_000).optional(),
  locale: z.enum(["en", "ar"]).default("en")
});

/**
 * docs/04 §4 "documents(+extract)". Structures a document into named fields via
 * the gateway's `responseSchema` (docs/02 §5) — every model call still
 * budgeted, scrubbed, guardrailed and written to ai_audit_log, same as any
 * other gateway.complete() call.
 *
 * Two paths (AXIS §G.5): `rawText` given -> text extraction, same as before.
 * Omitted -> the document's file is rendered to a page image and read by a
 * vision model instead (packages/model-gateway/src/extract.ts). On-prem
 * tenants have no browser-rendering/vision route today, so they must supply
 * `rawText` directly.
 */
axisRoutes.post("/documents/:id/extract", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:documents:extract", { tenantId: ctx.tenantId, module: "axis" });
  const rowId = c.req.param("id");
  const before = await must(ctx, schema.axisDocuments, rowId, "documents");
  const fields = EXTRACTION_FIELDS[before.docType];
  if (!fields) throw badRequest(`no extraction schema for doc type ${before.docType}`);
  if (before.status !== "received") throw conflict(`document is already ${before.status}`);

  const input = await body(c, ExtractBody);
  if (!input.rawText && ctx.policy.dataResidency === "on-prem") {
    throw badRequest("on-prem tenants must supply rawText — vision extraction is not available");
  }

  await ctx.db
    .update(schema.axisDocuments)
    .set({ status: "extracting" })
    .where(scoped(ctx, schema.axisDocuments, eq(schema.axisDocuments.id, rowId)));

  let result;
  let plainValues: Record<string, string | null>;
  const bbox: Record<string, [number, number, number, number]> = {};
  let confidence: number;
  try {
    if (input.rawText) {
      result = await c.get("gateway").complete(ctx, {
        module: "axis",
        purpose: "axis.document.extract",
        tier: "standard",
        subjectRef: rowId,
        locale: input.locale,
        responseSchema: extractionSchema(fields),
        // Prompt lives in @lyra/model-gateway so evals/live-extraction scores the
        // prompt this route actually sends (docs/27 F10).
        messages: extractionMessages({
          docType: before.docType,
          fields,
          locale: input.locale,
          rawText: input.rawText
        })
      });
      ({ values: plainValues, confidence } = parseExtraction(result.text, fields));
    } else {
      const file = await must(ctx, schema.files, before.fileId, "document file");
      const object = await c.env.FILES?.get(file.r2Key);
      if (!object) throw notFound("document file");
      if (!c.env.BROWSER) throw badRequest("vision extraction unavailable: no browser binding");

      const pages = await renderDocumentPages(c.env.BROWSER, {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: file.contentType ?? "application/pdf"
      });

      result = await c.get("gateway").complete(ctx, {
        module: "axis",
        purpose: "axis.document.extract",
        tier: "standard",
        // AXIS §G.5, ADR-0036: vision goes to Anthropic regardless of tier
        // routing — Workers AI has no vision-capable catalogue entry today.
        modelKey: "claude-haiku-4-5",
        subjectRef: rowId,
        locale: input.locale,
        responseSchema: visionExtractionSchema(fields),
        images: pages,
        messages: visionExtractionMessages({ docType: before.docType, fields, locale: input.locale })
      });

      const vision = parseVisionExtraction(result.text, fields);
      confidence = vision.confidence;
      plainValues = {};
      for (const f of fields) {
        const evidence = vision.values[f];
        plainValues[f] = evidence?.value ?? null;
        if (evidence?.bbox) bbox[f] = evidence.bbox;
      }
    }
  } catch (err) {
    // Nothing stays stuck "extracting" for a call that never landed — the
    // document is exactly as receivable as before this request.
    await ctx.db
      .update(schema.axisDocuments)
      .set({ status: "received" })
      .where(scoped(ctx, schema.axisDocuments, eq(schema.axisDocuments.id, rowId)));
    throw err;
  }

  // docs/12 §1: the identifier fields never reach the column in the clear, so
  // the audit `after` image and every CRUD read carry the sealed value too.
  const sealed = await sealFields(fieldKey(c.env), plainValues, SENSITIVE_EXTRACTION_FIELDS);
  // `_bbox`: the reserved key apps/web's axis-doc-intel.tsx already reads
  // (bboxOf) — present only when the vision path had a box to give it.
  const extractionJson = Object.keys(bbox).length ? { ...sealed, _bbox: bbox } : sealed;
  const stamp = {
    status: "extracted" as const,
    extractionJson: JSON.stringify(extractionJson),
    extractionConfidence: confidence,
    extractionModel: result.model
  };
  await ctx.db
    .update(schema.axisDocuments)
    .set(stamp)
    .where(scoped(ctx, schema.axisDocuments, eq(schema.axisDocuments.id, rowId)));

  const after = { ...before, ...stamp };
  await audit(ctx, { action: "axis.documents.extract", subjectRef: rowId, before, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.document.extracted",
    subject: rowId,
    data: { docType: before.docType, confidence }
  });
  // docs/21 KB search: the extracted text is the only thing worth recalling
  // later, so it's embedded after extraction succeeds, not on upload. The
  // vision path has no rawText to embed, so the read fields stand in for it.
  const embedText = input.rawText ?? Object.values(plainValues).filter((v): v is string => Boolean(v)).join(" ");
  await embedUpsert(ctx, c.get("gateway"), c.env.VEC_KB, {
    module: "axis",
    purpose: "axis.document.embed",
    id: rowId,
    text: embedText,
    metadata: { tenantId: ctx.tenantId, docType: before.docType }
  });
  return c.json(after);
});

/**
 * docs/12 §2: "PII masked by default in UIs (reveal = permission + audit)".
 * Reads hand back the sealed envelope; this is the one door that opens it, and
 * it leaves a row behind naming who opened it and when.
 *
 * `core:pii:view` on top of `axis:documents:read`: the same split the customer
 * spine uses (pii.ts), so an operator who may work a case is not thereby
 * someone who may read the identity documents in it.
 */
axisRoutes.post("/documents/:id/reveal", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:documents:read", { tenantId: ctx.tenantId, module: "axis" });
  if (!canSeePii(ctx.actor, ctx.tenantId)) throw forbidden("core:pii:view");
  const rowId = c.req.param("id");
  const before = await must(ctx, schema.axisDocuments, rowId, "documents");
  if (!before.extractionJson) throw conflict("document has no extraction to reveal");

  const values = await openFields(
    fieldKey(c.env),
    JSON.parse(before.extractionJson) as Record<string, string | null>
  );
  // The revealed values are the point of the row, so they stay out of it: the
  // audit trail records the act, not a second copy of the identifier.
  await audit(ctx, {
    action: "axis.documents.reveal",
    subjectRef: rowId,
    after: { fields: Object.keys(values).filter((f) => SENSITIVE_EXTRACTION_FIELDS.has(f)) }
  });
  return c.json({ values });
});

const CopilotBody = z.object({
  question: z.string().min(1).max(2000),
  locale: z.enum(["en", "ar"]).default("en")
});

axisRoutes.post("/cases/:id/copilot", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:cases:read", { tenantId: ctx.tenantId, module: "axis" });
  const rowId = c.req.param("id");
  const kase = await must(ctx, schema.axisCases, rowId, "cases");
  const input = await body(c, CopilotBody);

  const reply = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    const [documents, events, tasks] = await Promise.all([
      ctx.db.select().from(schema.axisDocuments).where(scoped(ctx, schema.axisDocuments, eq(schema.axisDocuments.caseId, rowId))),
      ctx.db.select().from(schema.axisProcessEvents).where(scoped(ctx, schema.axisProcessEvents, eq(schema.axisProcessEvents.caseId, rowId))).orderBy(desc(schema.axisProcessEvents.ts)).limit(10),
      ctx.db.select().from(schema.axisTasks).where(scoped(ctx, schema.axisTasks, eq(schema.axisTasks.caseId, rowId)))
    ]);

    const contextLines: string[] = [
      `Case ${kase.ref}: kind ${kase.kind}, status ${kase.status}, priority ${kase.priority}, opened ${promptInstant(kase.createdAt)}` +
        (kase.slaDueAt ? `, SLA due ${promptInstant(kase.slaDueAt)}` : "") +
        (kase.valueMinor !== null ? `, value ${kase.valueMinor / 100} ${kase.currency ?? ""}`.trimEnd() : "") +
        ".",
      ...documents.map((d) => `Document ${d.docType}: status ${d.status}.`),
      ...events.map((e) => `Event ${e.step}: ${e.outcome ?? "in progress"} at ${promptInstant(e.ts)}.`),
      ...tasks.map((t) => `Task ${t.titleKey}: state ${t.state}.`)
    ];

    const result = await c.get("gateway").complete(ctx, {
      module: "axis",
      purpose: "axis.case.copilot",
      tier: "standard",
      subjectRef: rowId,
      locale: input.locale,
      messages: [
        {
          role: "system",
          content:
            "Answer the question about this case using only the context lines below. " +
            "Do not state a number that is not in the context. Locale: " + input.locale + ".\n\n" +
            contextLines.join("\n")
        },
        { role: "user", content: input.question }
      ]
    });

    const groundedness = verifyGroundedness(result.text, contextLines);
    const confidence = groundedness.ok ? 0.95 : Math.max(0.2, 0.95 - groundedness.mismatches.length * 0.15);

    return {
      answer: result.text,
      confidence,
      mismatches: groundedness.mismatches,
      auditId: result.auditId
    };
  });
  return c.json(reply);
});

/**
 * §G.4. Estimates SLA-breach risk from the case's age, status, process-event
 * history, queue depth and owner load. Never consequential (CLAUDE.md §4):
 * generation only, writes nothing — no axis_sla_* table exists, and the
 * queue-reorder/chase-draft actions the spec's human boundary names belong
 * to the deferred Prioritiser/Chaser (§G.6, ADR-0035), not this route.
 * Reuses `axis:cases:read` — nothing is mutated, so no new permission.
 * No body: everything it needs already lives on the case.
 */
axisRoutes.post("/cases/:id/sla-predict", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:cases:read", { tenantId: ctx.tenantId, module: "axis" });
  const kase = await must(ctx, schema.axisCases, c.req.param("id"), "cases");
  const key = c.req.header("idempotency-key");
  const run = () => predictSlaBreach(ctx, kase, c.get("gateway"));
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, {}, run);
  return out ? c.json(out, 200) : c.json({ predicted: false }, 200);
});

/**
 * Moving a case through its machine (docs/specs/gap-axis-design.md §D.9).
 * Mirrors /claims/:id/transition: the right you need depends on where you
 * are going, and `issued` alone gates through axis.case_issue.
 */
axisRoutes.post("/cases/:id/transition", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, CaseTransitionBody);
  require_(ctx.actor, permissionForCaseTransition(input.to), { tenantId: ctx.tenantId, module: "axis" });
  const kase = await must(ctx, schema.axisCases, c.req.param("id"), "cases");
  const key = c.req.header("idempotency-key");
  const run = () => transitionCase(ctx, kase, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 200);
});

const SampleExtractBody = z.object({
  docType: z.enum(["eid", "mulkiya"]),
  rawText: z.string().min(1).max(20_000),
  locale: z.enum(["en", "ar"]).default("en")
});

/**
 * docs/20 developer console. Same field-extraction call as
 * `/documents/:id/extract`, minus the document row, audit trail and
 * embedding — a scratch space to check a prompt/schema before wiring a real
 * upload. `docType`'s zod enum already limits input to the two keys
 * `EXTRACTION_FIELDS` defines, so there's no missing-schema case to guard.
 */
axisRoutes.post("/dev/extract-sample", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "dev:sandbox:use", { tenantId: ctx.tenantId, module: "dev" });
  const input = await body(c, SampleExtractBody);
  // `docType`'s zod enum limits input to the two keys EXTRACTION_FIELDS defines.
  const fields = EXTRACTION_FIELDS[input.docType]!;

  const result = await c.get("gateway").complete(ctx, {
    module: "axis",
    purpose: "axis.dev.extract_sample",
    tier: "standard",
    locale: input.locale,
    responseSchema: extractionSchema(fields),
    // Same builder as the real route, so "check the prompt before wiring an
    // upload" checks the prompt that ships.
    messages: extractionMessages({
      docType: input.docType,
      fields,
      locale: input.locale,
      rawText: input.rawText
    })
  });

  const { values, confidence } = parseExtraction(result.text, fields);
  return c.json({ values, confidence, model: result.model });
});

axisRoutes.get("/documents/:id/file", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:documents:read", { tenantId: ctx.tenantId, module: "axis" });
  const doc = await must(ctx, schema.axisDocuments, c.req.param("id"), "document");
  const file = await must(ctx, schema.files, doc.fileId, "document file");
  const object = await c.env.FILES?.get(file.r2Key);
  if (!object) throw notFound("document file");

  await audit(ctx, {
    action: "axis.documents.file.read",
    subjectRef: `axis_document:${doc.id}`,
    after: { fileId: file.id }
  });
  await meterEgress(ctx, file.sizeBytes ?? object.size);
  return new Response(object.body, {
    headers: {
      "content-type": file.contentType ?? "application/octet-stream",
      "content-disposition": "inline",
      "cache-control": "no-store"
    }
  });
});

// docs/03 §AXIS admin. The one axis verb generated CRUD cannot express for
// SOPs: publish. Setting `status` to "active" through the generic PATCH does
// nothing about the version it replaces, so two versions of the same
// procedure could sit "active" at once — whichever the caller last touched.
// This makes the swap atomic, and "rollback" is just publishing an older
// version again — no separate endpoint.
axisRoutes.post("/sops/:id/publish", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:sops:write", { tenantId: ctx.tenantId, module: "axis" });
  const rowId = c.req.param("id");
  const before = await must(ctx, schema.axisSops, rowId, "sops");
  const after = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, {}, async () => {
    // Inside the wrap, not before it: a retry with the same idempotency key
    // must replay the cached success, not trip over the state its own first
    // attempt already produced.
    if (before.status === "active") throw conflict(`sop is already ${before.status}`);
    await ctx.db
      .update(schema.axisSops)
      .set({ status: "retired" })
      .where(
        scoped(
          ctx,
          schema.axisSops,
          and(eq(schema.axisSops.key, before.key), eq(schema.axisSops.status, "active"), not(eq(schema.axisSops.id, rowId)))
        )
      );
    const stamp = { status: "active" as const };
    await ctx.db
      .update(schema.axisSops)
      .set(stamp)
      .where(scoped(ctx, schema.axisSops, eq(schema.axisSops.id, rowId)));
    const after = { ...before, ...stamp };
    await audit(ctx, { action: "axis.sops.publish", subjectRef: rowId, before, after });
    return after;
  });
  return c.json(after);
});

// docs/27 F4 / docs/specs/gap-axis-design.md §D.10. Binding is not a row
// insert. A contract comes into existence: one BIND transaction with its
// commission accrual, version 1 of the schedule, an audited state hop, and an
// event the rest of the platform can hang renewals and servicing off. Generic
// CRUD (`axis:policies:create`) can still write a policy row for corrections;
// it can do none of the above, which is why `axis:policies:bind` is a
// separate permission.

const BindBody = z.object({
  policyNo: z.string().min(1).max(64),
  startAt: InstantMs.positive(),
  endAt: InstantMs.positive(),
  caseId: z.string().min(1).optional(),
  terms: z.record(z.string(), z.unknown()).optional()
});

type PolicyRow = typeof schema.axisPolicies.$inferSelect;
type AuthorityRule = { role: string; productLine: string; maxPremiumMinor: number };

/**
 * Delegated underwriting authority (docs/specs/gap-axis-design.md §A.4). Absence
 * of a matching rule means no delegated authority: everything above zero refers.
 */
async function enforceUnderwritingAuthority(
  ctx: Ctx,
  policy: PolicyRow,
  opts: { quoteResponseId?: string }
): Promise<void> {
  const opsPolicyRow = (
    await ctx.db
      .select()
      .from(schema.axisOpsPolicies)
      .where(
        and(
          eq(schema.axisOpsPolicies.tenantId, ctx.tenantId),
          eq(schema.axisOpsPolicies.key, "axis.authority"),
          eq(schema.axisOpsPolicies.status, "active")
        )
      )
  )[0];
  const rules = opsPolicyRow
    ? ((JSON.parse(opsPolicyRow.valueJson) as { underwriting?: AuthorityRule[] }).underwriting ?? [])
    : [];

  const roleKeys = new Set(ctx.actor.grants.map((g) => g.roleKey));
  const product = policy.productId
    ? (await ctx.db.select().from(schema.products).where(eq(schema.products.id, policy.productId)))[0]
    : undefined;

  const limitMinor = rules
    .filter((r) => roleKeys.has(r.role) && (r.productLine === "*" || r.productLine === product?.line))
    .reduce((max, r) => Math.max(max, r.maxPremiumMinor), -1);

  if (policy.grossMinor <= limitMinor) return;

  // Keyed by the policy, not by a fresh referral each attempt: a retried bind
  // after `/referrals/:id/decide` accepts must land on the same gate, so gate()
  // can find the now-approved row and let the retry through instead of opening
  // a new referral every time.
  const subjectRef = `axis_policy_bind:${policy.id}`;
  try {
    await gate(ctx, { policyKey: "axis.underwriting_referral", subjectRef, amountMinor: policy.grossMinor });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "approval_required") throw err;
    const approvalId = err.extras.approval_id as string | undefined;

    const openReferral = (
      await ctx.db
        .select()
        .from(schema.axisReferrals)
        .where(
          and(
            eq(schema.axisReferrals.tenantId, ctx.tenantId),
            eq(schema.axisReferrals.policyId, policy.id),
            eq(schema.axisReferrals.state, "open")
          )
        )
        .limit(1)
    )[0];

    if (openReferral) {
      if (approvalId && openReferral.approvalId !== approvalId) {
        await ctx.db
          .update(schema.axisReferrals)
          .set({ approvalId })
          .where(and(eq(schema.axisReferrals.tenantId, ctx.tenantId), eq(schema.axisReferrals.id, openReferral.id)));
      }
    } else {
      const referral = {
        id: newId("rfl", ctx.now),
        tenantId: ctx.tenantId,
        caseId: null,
        policyId: policy.id,
        quoteResponseId: opts.quoteResponseId ?? null,
        kind: "authority_limit",
        triggerJson: JSON.stringify({ rule: "maxPremiumMinor", limitMinor: Math.max(limitMinor, 0), valueMinor: policy.grossMinor }),
        valueMinor: policy.grossMinor,
        currency: policy.currency,
        state: "open",
        decidedBy: null,
        decisionNote: null,
        counterTermsJson: null,
        approvalId: approvalId ?? null,
        slaDueAt: null,
        createdAt: ctx.now,
        updatedAt: ctx.now
      };
      await ctx.db.insert(schema.axisReferrals).values(referral);
      await audit(ctx, { action: "axis.policy.refer", subjectRef: policy.id, after: referral });
    }
    throw err;
  }
}

/** The half both bind entrypoints share: transaction, version 1, head, audit, event. */
async function bindPolicy(
  ctx: Ctx,
  policy: PolicyRow,
  opts: { quoteResponseId?: string; channelMinor?: number; terms?: Record<string, unknown> },
  files?: R2Bucket
) {
  if (!isPolicyState(policy.status)) throw conflict(`policy is in unknown state ${policy.status}`);
  assertPolicyTransition(policy.status, "bound");
  if (policy.currentVersionId) throw conflict("policy already has a version history");
  await enforceUnderwritingAuthority(ctx, policy, opts);
  // BIND is financial (docs/19 §4) and `buildRecipe` refuses a batch of fewer
  // than two lines, so a zero-commission bind would strand the transaction in
  // `failed`. A 400 naming the reason is more use than that.
  if (policy.commissionMinor <= 0) {
    throw badRequest("cannot bind with no commission: BIND posts a commission accrual");
  }
  const channelMinor = Math.min(Math.max(opts.channelMinor ?? 0, 0), policy.commissionMinor);

  const txn = await runTxn(
    ctx,
    {
      type: "BIND",
      // Derived from the policy, not from the request: two calls that bind the
      // same contract are the same money movement whatever headers they carry.
      idempotencyKey: `axis.bind:${policy.id}`,
      currency: policy.currency,
      // The approval threshold measures the premium the customer pays, not the
      // commission the recipe splits.
      grossMinor: policy.grossMinor,
      subjectRefs: {
        policy: policy.id,
        ...(opts.quoteResponseId ? { quoteResponse: opts.quoteResponseId } : {})
      }
    },
    {
      recipe: {
        // docs/27 F14. `gwpMinor` is what makes gross written premium a
        // receivable at bind instead of a cash event whenever the money turns
        // up: Dr 1200 / Cr 2000 beside the commission accrual. policy.grossMinor
        // is premium + tax + fees — the whole debt the customer owes.
        lines: buildRecipe("BIND", {
          gwpMinor: policy.grossMinor,
          grossMinor: policy.commissionMinor,
          channelMinor,
          // docs/27 F15: `item` is the open-item key the aging report groups on
          // and `dueAt` is what it ages from. Premium is due at inception unless
          // a payment plan says otherwise, and a plan restates both on its own
          // instalment legs.
          dims: {
            item: `policy:${policy.id}`,
            dueAt: policy.startAt,
            policy: policy.id,
            provider: policy.providerId,
            counterparty: `provider:${policy.providerId}`
          }
        }),
        currency: policy.currency
      },
      approvalSubjectRef: `axis_policy:${policy.id}`
    }
  );

  const version = {
    id: newId("pver", ctx.now),
    tenantId: ctx.tenantId,
    policyId: policy.id,
    versionSeq: 1,
    reason: "issue",
    effectiveFrom: policy.startAt,
    effectiveTo: policy.endAt,
    premiumMinor: policy.premiumMinor,
    taxMinor: policy.taxMinor,
    feesMinor: policy.feesMinor,
    commissionMinor: policy.commissionMinor,
    currency: policy.currency,
    premiumDeltaMinor: 0,
    termsJson: JSON.stringify(opts.terms ?? {}),
    quoteResponseId: opts.quoteResponseId ?? null,
    txnId: txn.id,
    state: "effective",
    issuedBy: actorRef(ctx),
    issuedAt: ctx.now,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.axisPolicyVersions).values(version);

  // ponytail: bind stops at `bound`. `bound -> active` is inception, which is
  // a clock event, not a request — the INCEPT scheduler owns that hop.
  const stamp = {
    status: "bound",
    currentVersionId: version.id,
    versionSeq: 1,
    lastTxnId: txn.id,
    updatedAt: ctx.now
  };
  await ctx.db
    .update(schema.axisPolicies)
    .set(stamp)
    .where(scoped(ctx, schema.axisPolicies, eq(schema.axisPolicies.id, policy.id)));
  const after = { ...policy, ...stamp };

  await audit(ctx, { action: "axis.policy.bind", subjectRef: policy.id, before: policy, after });
  // Emitted here rather than through runTxn's `event` option: that stamps
  // `module: "ledger"`, and this is AXIS telling the platform a policy exists.
  await emit(ctx, {
    module: "axis",
    type: "axis.policy.issued",
    subject: policy.id,
    data: {
      policyId: policy.id,
      customerId: policy.customerId,
      providerId: policy.providerId,
      channelId: policy.channelId,
      productId: policy.productId,
      premiumMinor: policy.premiumMinor,
      grossMinor: policy.grossMinor,
      currency: policy.currency,
      txnId: txn.id,
      ...(opts.quoteResponseId ? { quoteResponseId: opts.quoteResponseId } : {})
    }
  });
  // docs/30 AXIS gap 2: the schedule comes with the bind. The bind has already
  // committed, so a document the renderer refuses is recorded, not a 409 on a
  // policy that now exists — the manual documents route can issue it later.
  await issuePolicyDocument(ctx, after as PolicyRow, { kind: "schedule", versionId: version.id }, files).catch((err: unknown) =>
    audit(ctx, { action: "axis.policy.document_failed", subjectRef: policy.id, after: { kind: "schedule", error: String(err).slice(0, 300) } })
  );
  return { policy: after, version, txn };
}

/** The sale: the quote the customer accepted becomes the contract they hold. */
axisRoutes.post("/quote-responses/:id/bind", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:bind", { tenantId: ctx.tenantId, module: "axis" });
  const input = await body(c, BindBody);
  const response = await must(ctx, schema.distQuoteResponses, c.req.param("id"), "quote response");
  const request = await must(ctx, schema.distQuoteRequests, response.requestId, "quote request");

  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    // Inside the wrap, not before it: a retry with the same idempotency key
    // must replay the cached success, not trip over the state its own first
    // attempt already produced.
    if (response.state !== "quoted") throw conflict(`that response is ${response.state}, not a quote`);
    if (response.selectedAt === null) throw conflict("that quote has not been selected");
    if (response.premiumMinor === null) throw conflict("that quote carries no premium");
    if (input.endAt <= input.startAt) throw badRequest("endAt must be after startAt");
    // An anonymous shop can price a risk; it cannot sell one. A policy without
    // a customer has nobody to service, renew or pay a claim to.
    if (!request.customerId) throw conflict("quote request has no customer to bind");

    const already = await ctx.db
      .select({ id: schema.axisPolicyVersions.policyId })
      .from(schema.axisPolicyVersions)
      .where(scoped(ctx, schema.axisPolicyVersions, eq(schema.axisPolicyVersions.quoteResponseId, response.id)))
      .limit(1);
    if (already[0]) throw conflict(`that quote response is already bound to ${already[0].id}`);

    // An approval gate throws after the draft head is written, so a caller who
    // retries once the approval lands must land on the same draft rather than
    // colliding with `axis_policies_no_uq`.
    const prior = (
      await ctx.db
        .select()
        .from(schema.axisPolicies)
        .where(
          scoped(
            ctx,
            schema.axisPolicies,
            and(
              eq(schema.axisPolicies.providerId, response.providerId),
              eq(schema.axisPolicies.policyNo, input.policyNo)
            )
          )
        )
        .limit(1)
    )[0];
    if (prior && prior.status !== "draft") throw conflict(`policy number ${input.policyNo} is already in use`);

    let policy = prior;
    if (!policy) {
      const premiumMinor = response.premiumMinor;
      const row = {
        id: newId("pol", ctx.now),
        tenantId: ctx.tenantId,
        caseId: input.caseId ?? request.caseId,
        customerId: request.customerId,
        providerId: response.providerId,
        productId: request.productId,
        offeringId: response.offeringId,
        channelId: request.channelId,
        policyNo: input.policyNo,
        startAt: input.startAt,
        endAt: input.endAt,
        premiumMinor,
        taxMinor: response.taxMinor,
        feesMinor: response.feesMinor,
        grossMinor: premiumMinor + response.taxMinor + response.feesMinor,
        currency: response.currency ?? request.currency,
        commissionMinor: response.commissionMinor ?? 0,
        status: "draft",
        createdAt: ctx.now,
        updatedAt: ctx.now
      };
      await ctx.db.insert(schema.axisPolicies).values(row);
      policy = row as PolicyRow;
    }

    return bindPolicy(ctx, policy, {
      quoteResponseId: response.id,
      channelMinor: response.channelCommissionMinor ?? 0,
      ...(input.terms ? { terms: input.terms } : {})
    }, c.env.FILES);
  });
  return c.json(out, 201);
});

const ReferralDecideBody = z.object({
  // ponytail: refer-up (next authority tier) needs tier ordering the ops-policy
  // rule list doesn't have yet. Add when a tenant asks for a second tier.
  intent: z.enum(["accept", "decline", "counter"]),
  reason: z.string().max(2000).optional(),
  counterTermsJson: z.record(z.string(), z.unknown()).optional()
});

/**
 * Resolves the referral gate.ts opened on the bind path (§A.4). Acts on the
 * referral's id, not the approval's: decide() there is plumbing the desk
 * never sees directly.
 */
axisRoutes.post("/referrals/:id/decide", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:decide_referral", { tenantId: ctx.tenantId, module: "axis" });
  const input = await body(c, ReferralDecideBody);
  const referral = await must(ctx, schema.axisReferrals, c.req.param("id"), "referral");
  if (referral.state !== "open") throw conflict(`referral is ${referral.state}, not open`);
  if (input.intent === "decline" && !input.reason) throw badRequest("decline requires a reason");
  if (input.intent === "counter" && !input.counterTermsJson) throw badRequest("counter requires counterTermsJson");

  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    if (referral.approvalId) {
      await decide(ctx, referral.approvalId, input.intent === "accept" ? "approved" : "rejected", input.reason);
    }
    const state = input.intent === "accept" ? "accepted" : input.intent === "decline" ? "declined" : "counter_offered";
    const after = {
      ...referral,
      state,
      decidedBy: actorRef(ctx),
      decisionNote: input.reason ?? null,
      counterTermsJson: input.counterTermsJson ? JSON.stringify(input.counterTermsJson) : referral.counterTermsJson,
      updatedAt: ctx.now
    };
    await ctx.db
      .update(schema.axisReferrals)
      .set(after)
      .where(and(eq(schema.axisReferrals.tenantId, ctx.tenantId), eq(schema.axisReferrals.id, referral.id)));
    await audit(ctx, { action: "axis.referral.decide", subjectRef: referral.id, before: referral, after });
    return after;
  });
  return c.json(out, 200);
});

const ManualQuoteBody = z.object({
  offeringId: z.string().min(1),
  /** Redundant with the offering, and checked against it — a desk keying from
   *  an email should not be able to file Provider A's price under Provider B. */
  providerId: z.string().min(1).optional(),
  premiumMinor: z.number().int().nonnegative(),
  taxMinor: z.number().int().nonnegative().optional(),
  feesMinor: z.number().int().nonnegative().optional(),
  commissionMinor: z.number().int().optional(),
  currency: z.string().length(3),
  validUntil: InstantMs.optional(),
  coverage: z.record(z.string(), z.unknown()).optional()
});

/**
 * docs/27 F13 / docs/specs/gap-axis-design.md §C.10. A quote that arrives by
 * phone or email, keyed by hand. It lands in `dist_quote_responses` beside the
 * panel's own answers, so comparison, ranking, selection and bind read one
 * table. `axis_quotes` is retired as a write target.
 */
axisRoutes.post("/cases/:id/quotes", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:quotes:create", { tenantId: ctx.tenantId, module: "axis" });
  const kase = await must(ctx, schema.axisCases, c.req.param("id"), "case");
  const input = await body(c, ManualQuoteBody);

  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    const offering = await must(ctx, schema.distOfferings, input.offeringId, "offering");
    if (input.providerId && input.providerId !== offering.providerId) {
      throw badRequest("providerId does not own that offering");
    }

    // A case opened without a shop has no request to hang an answer on, so the
    // first hand-keyed quote creates one. Every later quote on the case joins
    // it, which is what keeps `/comparison` and `/select` working for a panel
    // assembled by hand. `inputsJson` is empty: the risk was never normalised
    // to the product's rating inputs, because nobody rated it here.
    let requestId = kase.quoteRequestId;
    if (!requestId) {
      if (!kase.channelId) throw conflict("that case has no channel to quote against");
      requestId = newId("qr", ctx.now);
      await ctx.db.insert(schema.distQuoteRequests).values({
        id: requestId,
        tenantId: ctx.tenantId,
        caseId: kase.id,
        customerId: kase.customerId,
        channelId: kase.channelId,
        productId: offering.productId,
        inputsJson: "{}",
        currency: input.currency,
        state: "open",
        createdAt: ctx.now,
        updatedAt: ctx.now
      });
      await ctx.db
        .update(schema.axisCases)
        .set({ quoteRequestId: requestId, updatedAt: ctx.now })
        .where(scoped(ctx, schema.axisCases, eq(schema.axisCases.id, kase.id)));
    }

    // `dist_quote_responses_uq` says one answer per offering per request. Catch
    // it here so a second keying reads as a conflict, not a constraint dump.
    const clash = await ctx.db
      .select({ id: schema.distQuoteResponses.id })
      .from(schema.distQuoteResponses)
      .where(
        scoped(
          ctx,
          schema.distQuoteResponses,
          and(
            eq(schema.distQuoteResponses.requestId, requestId),
            eq(schema.distQuoteResponses.offeringId, offering.id)
          )
        )
      )
      .limit(1);
    if (clash[0]) throw conflict("that offering has already answered this case");

    const row = {
      id: newId("qs", ctx.now),
      tenantId: ctx.tenantId,
      requestId,
      offeringId: offering.id,
      providerId: offering.providerId,
      state: "quoted",
      premiumMinor: input.premiumMinor,
      taxMinor: input.taxMinor ?? 0,
      feesMinor: input.feesMinor ?? 0,
      currency: input.currency,
      commissionMinor: input.commissionMinor ?? null,
      coverageJson: input.coverage ? JSON.stringify(input.coverage) : null,
      validUntil: input.validUntil ?? null,
      // ponytail: the response table has no `source` column, and a null latency
      // is already the marker — every machine path stamps one. Display only; a
      // migration for a column that decorates one cell can wait for a second use.
      latencyMs: null,
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
    await ctx.db.insert(schema.distQuoteResponses).values(row);
    await ctx.db
      .update(schema.distQuoteRequests)
      .set({ respondedCount: sql`responded_count + 1`, updatedAt: ctx.now })
      .where(scoped(ctx, schema.distQuoteRequests, eq(schema.distQuoteRequests.id, requestId)));

    await audit(ctx, { action: "axis.quote.capture", subjectRef: row.id, after: row });
    return row;
  });
  return c.json(out, 201);
});

/** The desk ruling a quote out — the answer stays on the record, because a
 *  panel's declines are what tell us which underwriter is worth shopping. */
axisRoutes.post("/quote-responses/:id/decline", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:quotes:create", { tenantId: ctx.tenantId, module: "axis" });
  const before = await must(ctx, schema.distQuoteResponses, c.req.param("id"), "quote response");
  const input = await body(c, z.object({ reason: z.string().min(1) }));

  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    if (before.selectedAt !== null) throw conflict("that quote has already been selected");
    const after = { ...before, state: "declined", declineReason: input.reason, updatedAt: ctx.now };
    await ctx.db
      .update(schema.distQuoteResponses)
      .set({ state: "declined", declineReason: input.reason, updatedAt: ctx.now })
      .where(scoped(ctx, schema.distQuoteResponses, eq(schema.distQuoteResponses.id, before.id)));
    await audit(ctx, { action: "axis.quote.decline", subjectRef: before.id, before, after });
    return after;
  });
  return c.json(out);
});

/** The same hop for a draft written some other way — a correction, or a retry
 *  after the bind approval landed. */
axisRoutes.post("/policies/:id/bind", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:bind", { tenantId: ctx.tenantId, module: "axis" });
  const rowId = c.req.param("id");
  const before = await must(ctx, schema.axisPolicies, rowId, "policies");
  const input = await body(c, z.object({ terms: z.record(z.string(), z.unknown()).optional() }));
  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, () =>
    bindPolicy(ctx, before, { ...(input.terms ? { terms: input.terms } : {}) }, c.env.FILES)
  );
  return c.json(out, 201);
});

axisRoutes.post("/policies/:id/bind-group", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:bind", { tenantId: ctx.tenantId, module: "axis" });
  const before = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(
    c,
    z.object({
      channelMinor: z.number().int().nonnegative().optional(),
      terms: z.record(z.string(), z.unknown()).optional()
    })
  );
  const opts = {
    ...(input.channelMinor !== undefined ? { channelMinor: input.channelMinor } : {}),
    ...(input.terms ? { terms: input.terms } : {})
  };
  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, () =>
    bindGroup(ctx, before, opts)
  );
  return c.json(out, 201);
});

axisRoutes.post("/policies/:id/broker-fee", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:bind", { tenantId: ctx.tenantId, module: "axis" });
  const before = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, z.object({ feeMinor: z.number().int().positive() }));
  const out = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, () =>
    brokerFee(ctx, before, input)
  );
  return c.json(out, 201);
});

/** §D.4 step 3: the desk sees the price before it commits. Writes nothing. */
axisRoutes.post("/policies/:id/endorse/preview", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:endorse", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, EndorseBody);
  const { quote, needsApproval, needsReferral } = await priceEndorsement(ctx, policy, input);
  return c.json({ ...quote, needsApproval, needsReferral });
});

axisRoutes.post("/policies/:id/endorse", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:endorse", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, EndorseBody);
  // Without a caller-supplied key the change-set is the key: submitting the same
  // change twice is one endorsement. A throw releases the slot, so the retry
  // that follows a granted approval runs rather than replaying the 403.
  const key = c.req.header("idempotency-key") ?? `axis_endorse:${policy.id}:${await changeSetHashOf(input)}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => endorsePolicy(ctx, policy, input));
  return c.json(out, 200);
});

// docs/27 F5 — telematics/UBI. `/telemetry` is a device/integration doorway,
// not an underwriting one (packages/core/src/rbac.ts): a fleet posting
// kilometres must not also be able to move a price. `/reprice` is the opposite
// shape — it produces a priced endorsement, so it stays behind the same
// `axis:policies:endorse` gate as a manual one and invents no permission of
// its own.

/** The series key and points come from the body; the cover is the route's own
 *  param, never the body's — `TelematicsIngest` refuses a mismatch anyway,
 *  but the route should not hand it a ref to check against itself. */
axisRoutes.post("/policies/:id/telemetry", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:telemetry", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  // Bounded at the trust boundary, not only inside the engine: without `.max()`
  // a 500 000-point body is parsed and validated in full before anything refuses
  // it. The engine keeps its own copy of both checks (defence in depth).
  const input = await body(
    c,
    z.object({
      source: z.string().min(1),
      points: z
        .array(z.object({ at: InstantMs, value: z.number() }))
        .min(1)
        .max(MAX_POINTS_PER_BATCH)
    })
  );
  // Plan §Task 5: absent a caller key the batch is the key, so a device that
  // retries a flush after a timeout stores one set of rows, not two.
  const key = c.req.header("idempotency-key") ?? `axis_telemetry:${policy.id}:${await hashObject(input)}`;
  const run = async () => {
    await new TelematicsIngest(ctx, input.source, policy).ingest(`policy:${policy.id}`, input.points);
    return { accepted: true as const };
  };
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run);
  return c.json(out, 201);
});

/**
 * §F5: prices the exposure the cover's telemetry has recorded since its
 * current version took effect and, if it moved, endorses the contract by that
 * much — same pricing call, same referral guard, same `axis.endorse` approval
 * gate as a manual endorsement (`repriceFromTelemetry`, engines/telematics.ts).
 * `{ repriced: false }` is a genuine no-op, not an error: a model that proposed
 * no change is a success, so it comes back 200 rather than a 4xx.
 */
axisRoutes.post("/policies/:id/reprice", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:endorse", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  // Plan §Task 5: one reprice per exposure per retry storm. The body is empty,
  // so without this a header-less retry storm is N model calls and N price
  // moves.
  //
  // The key is kept whatever the outcome, `repriced:false` included: that answer
  // is only reachable after `gateway.complete` has billed a provider call and
  // written an `ai_audit_log` row, so a no-op is not a run that did nothing and
  // releasing its key buys the next retry another billed call. What moves
  // instead is the key itself — it fingerprints the unpriced telemetry, so it
  // changes exactly when the exposure to be priced changes. New telemetry mints
  // a new key and prices; no new telemetry replays.
  //
  // ponytail: the version component is redundant against the fingerprint for
  // telemetry alone, and a manual endorsement moves it without moving the
  // exposure — one extra billed no-op for an endorse-then-reprice. Kept because
  // the stored body carries `premiumMinor`, computed off the version's base:
  // dropping it would let a replay hand back a price struck against a premium
  // that has since been endorsed away. Drop it if that body ever stops naming
  // an absolute amount.
  const key =
    c.req.header("idempotency-key") ??
    `axis_ubi_reprice:${policy.id}:${policy.currentVersionId ?? policy.versionSeq}:${await unpricedExposureKey(ctx, policy)}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, {}, () =>
    repriceFromTelemetry(ctx, policy, c.get("gateway"))
  );
  return c.json(out, 200);
});

/** §D.11: the document the customer holds — rendered, stored, attached. */
axisRoutes.post("/policies/:id/documents", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:document", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, PolicyDocumentBody);
  // One document per version per kind, whoever asks twice. Asking again after
  // an endorsement is a different version, so it renders a new one.
  const key = c.req.header("idempotency-key") ?? `axis_policy_doc:${policy.id}:${input.versionId ?? "current"}:${input.kind}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () =>
    issuePolicyDocument(ctx, policy, input, c.env.FILES)
  );
  return c.json(out, 201);
});

/** §D.5 step 2: what comes back and what is clawed, before anything is written. */
axisRoutes.post("/policies/:id/cancel/preview", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:cancel", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, CancelBody);
  const { effectiveAt, quote, refundMinor, clawbackMinor } = await priceCancellation(ctx, policy, input);
  return c.json({ effectiveAt, refundMinor, clawbackMinor, proRataDays: quote.proRataDays, currency: policy.currency });
});

axisRoutes.post("/policies/:id/cancel", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:cancel", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, CancelBody);
  // One cancellation per policy, whoever asks twice — the policy id is the key.
  const key = c.req.header("idempotency-key") ?? `axis_cancel:${policy.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => cancelPolicy(ctx, policy, input));
  return c.json(out, 200);
});

axisRoutes.post("/policies/:id/ntu", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:ntu", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, NtuBody);
  const key = c.req.header("idempotency-key") ?? `axis_ntu:${policy.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => ntuPolicy(ctx, policy, input));
  return c.json(out, 200);
});

/**
 * The sweep lapses policies on the clock; this is the manual path for the cases
 * the plan cannot see — a returned debit order, a broker's instruction.
 */
axisRoutes.post("/policies/:id/lapse", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:lapse", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, LapseBody);
  const key = c.req.header("idempotency-key") ?? `axis_lapse:${policy.id}:${input.missedSeq}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () =>
    lapsePolicy(ctx, policy, input.missedSeq, input.reason)
  );
  return c.json(out, 200);
});

axisRoutes.post("/policies/:id/reinstate", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:reinstate", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, ReinstateBody);
  // Keyed on the lapse being cured, so a later lapse can be cured again.
  const key = c.req.header("idempotency-key") ?? `axis_reinstate:${policy.id}:${policy.lapsedAt ?? 0}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => reinstatePolicy(ctx, policy, input));
  return c.json(out, 200);
});

/**
 * docs/27 group D — opens a premium-financing plan on a bound policy.
 * PLAN-CREATE itself moves no money (non-financial); the financing house's
 * commission posts as a chained FIN-CMSN transaction inside createPlan().
 */
const PremiumFinancingPlanBody = z.object({
  financierRef: z.string().min(1).optional(),
  totalMinor: z.number().int().positive(),
  currency: z.string().min(1),
  instalments: z.number().int().positive(),
  startAt: InstantMs.positive(),
  frequencyDays: z.number().int().positive(),
  // positive, not nonnegative: buildRecipe refuses a zero gross, so `0` was a
  // route-legal body that only failed once the engine tried to post the chained
  // FIN-CMSN. The engine re-checks it (that is the real fix); this stops it here.
  commissionMinor: z.number().int().positive(),
  commissionTaxMinor: z.number().int().nonnegative().optional()
});

axisRoutes.post("/policies/:id/premium-financing-plan", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:finance", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, PremiumFinancingPlanBody);
  // withIdempotency is a no-op without a key, and a policy is financed once:
  // two plans on one contract double-book the commission and post a duplicate
  // client-money receipt every tick for the plan's life. Key on the policy so a
  // retrying client with no header still gets one plan.
  const key = c.req.header("idempotency-key") ?? `axis_finance_plan:${policy.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => createPlan(ctx, policy, input));
  return c.json(out, 200);
});

const CancelFinancingPlanBody = z.object({ reason: z.string().min(1).max(500) });

/**
 * C3 gives a policy at most one live financing plan, which makes a plan opened
 * against the wrong contract permanent without this route. Same permission as
 * opening one: whoever may commit a contract to a financier may un-commit it.
 */
axisRoutes.post("/policies/:id/premium-financing-plan/cancel", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:finance", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, CancelFinancingPlanBody);
  const plan = await livePlanOf(ctx, policy.id);
  // Keyed on the plan, not the policy: cancelling reverses a settled
  // transaction, so a retrying client must not un-earn the commission twice.
  const key = c.req.header("idempotency-key") ?? `axis_finance_cancel:${plan.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () =>
    cancelPlan(ctx, plan, input.reason)
  );
  return c.json(out, 200);
});

/**
 * §D.4 / F5: the endorsement history of *this* contract. The web detail screen
 * used to reach for the customer's other policies, which is a different list
 * with the same shape — the kind of bug nobody sees until an audit asks why a
 * schedule cites a version that belongs to somebody else's car.
 */
axisRoutes.get("/policies/:id/versions", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:read", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const data = await ctx.db
    .select()
    .from(schema.axisPolicyVersions)
    .where(scoped(ctx, schema.axisPolicyVersions, eq(schema.axisPolicyVersions.policyId, policy.id)))
    .orderBy(desc(schema.axisPolicyVersions.versionSeq));
  return c.json({ data, total: data.length });
});

/** §D.7: next year's contract, born from this one and pointing back at it. */
axisRoutes.post("/policies/:id/renew", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:policies:renew", { tenantId: ctx.tenantId, module: "axis" });
  const policy = await must(ctx, schema.axisPolicies, c.req.param("id"), "policies");
  const input = await body(c, RenewBody);
  // One successor per term, whoever asks twice — a policy renews once.
  const key = c.req.header("idempotency-key") ?? `axis_renew:${policy.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () => renewPolicy(ctx, policy, input));
  return c.json(out, 201);
});

/* -------------------------------------------------------- FNOL (§D.1) --- */

/**
 * Cover as it stood on the day of the loss. Read-only on purpose: the intake
 * screen calls it before anything is written, so a handler learns there is no
 * cover *before* they take a statement, not after.
 */
axisRoutes.post("/claims/coverage-check", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:register", { tenantId: ctx.tenantId, module: "axis" });
  const input = await body(c, CoverageCheckBody);
  const policy = await policyForCoverage(ctx, input.policyId);
  return c.json(await checkCoverage(ctx, policy, input.incidentAt), 200);
});

/**
 * Registering a notification. Shadows generated CRUD (mounted later in
 * `index.ts`) because a claim is not a row someone types: it snapshots the
 * cover in force, numbers itself, and emits into ORBIT. It never refuses on
 * failed cover — §D.1, refusing to record a notification is a conduct failure.
 */
axisRoutes.post("/claims", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:register", { tenantId: ctx.tenantId, module: "axis" });
  const input = await body(c, FnolBody);
  const key = c.req.header("idempotency-key");
  const run = () => registerFnol(ctx, input, c.get("gateway"));
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 201);
});

/* --------------------------------------------- claim desk (§B.2, §C.4) --- */

/**
 * Moving the claim through its machine. Every legal hop is here except the two
 * that money owns: `settling` and `settled` belong to the payment endpoint, so
 * that no claim can read as paying without a payment behind it.
 */
axisRoutes.post("/claims/:id/transition", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(c, ClaimTransitionBody);
  // The right you need depends on where you are going — triaging is a handler's
  // job, declining is not.
  require_(ctx.actor, permissionForClaimTransition(input.to), { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const key = c.req.header("idempotency-key");
  const run = () => transitionClaim(ctx, claim, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 200);
});

/**
 * A reserve movement. Like payments and unlike everything else, the key is
 * never derived from the claim: a reserve is revised many times over a claim's
 * life and a claim-derived key would replay the first estimate forever.
 */
axisRoutes.post("/claims/:id/reserves", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:reserve", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const input = await body(c, ClaimReserveBody);
  const key = c.req.header("idempotency-key");
  const run = () => appendReserve(ctx, claim, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 201);
});

/** What we thought this was worth, and when — the history under the control. */
axisRoutes.get("/claims/:id/reserves", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:read", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const data = await listReserves(ctx, claim.id);
  return c.json({ data, total: data.length });
});

/**
 * §G.3. A reserve suggested by the model gateway from comparable closed
 * claims, not the handler's own figure — but written through the very same
 * appendReserve gate, so an above-threshold suggestion still stops for
 * approval instead of ever landing unsupervised. No body: everything it
 * needs already lives on the claim.
 */
axisRoutes.post("/claims/:id/reserve-recommendation", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:reserve", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const key = c.req.header("idempotency-key");
  const run = () => writeRecommendedReserve(ctx, claim, c.get("gateway"));
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, {}, run);
  return out ? c.json(out, 201) : c.json({ recommended: false }, 200);
});

/**
 * §G.2. Scores a claim for SIU referral from its peril/cause, incident-to-report
 * gap, amount against limits, the holder's own claim history, and any document
 * extraction results. Never consequential (CLAUDE.md §4): the model may only
 * stamp claims.fraudScore and open an axis_siu_referrals queue entry for a human
 * investigator — it cannot decline, reduce a reserve, or block a payment. No
 * body: everything it needs already lives on the claim.
 */
axisRoutes.post("/claims/:id/fraud-score", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:siu:write", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const key = c.req.header("idempotency-key");
  const run = () => scoreAndReferClaim(ctx, claim, c.get("gateway"));
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, {}, run);
  return out ? c.json(out, 201) : c.json({ scored: false }, 200);
});

/* ------------------------------------------------- claim money (§D.10) --- */

/**
 * Paying a claim. Unlike every other endpoint here the key is never derived
 * from the subject: a claim takes many payments, and a claim-derived key would
 * make the second interim payment replay the first.
 */
axisRoutes.post("/claims/:id/payments", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:pay", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const input = await body(c, ClaimPaymentBody);
  const key = c.req.header("idempotency-key");
  const run = () => requestClaimPayment(ctx, claim, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 201);
});

/** What has left the door on this claim, newest first. */
axisRoutes.get("/claims/:id/payments", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:read", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const data = await listClaimPayments(ctx, claim.id);
  return c.json({ data, total: data.length });
});

axisRoutes.post("/claims/:id/recoveries", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:recover", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const input = await body(c, RecoveryOpenBody);
  const key = c.req.header("idempotency-key");
  const run = () => openRecovery(ctx, claim, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 201);
});

/** What is being chased back on this claim, newest first. */
axisRoutes.get("/claims/:id/recoveries", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:read", { tenantId: ctx.tenantId, module: "axis" });
  const claim = await must(ctx, schema.axisClaims, c.req.param("id"), "claims");
  const data = await listClaimRecoveries(ctx, claim.id);
  return c.json({ data, total: data.length });
});

axisRoutes.post("/recoveries/:id/receipt", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:recover", { tenantId: ctx.tenantId, module: "axis" });
  const recovery = await must(ctx, schema.axisClaimRecoveries, c.req.param("id"), "recoveries");
  const input = await body(c, RecoveryReceiptBody);
  const key = c.req.header("idempotency-key");
  const run = () => receiveRecovery(ctx, recovery, input);
  const out = key ? await withIdempotency(ctx, key, `POST ${c.req.path}`, input, run) : await run();
  return c.json(out, 201);
});

axisRoutes.post("/recoveries/:id/writeoff", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:claims:recover", { tenantId: ctx.tenantId, module: "axis" });
  const recovery = await must(ctx, schema.axisClaimRecoveries, c.req.param("id"), "recoveries");
  const input = await body(c, RecoveryWriteOffBody);
  // One write-off per recovery, whoever asks twice.
  const key = c.req.header("idempotency-key") ?? `axis_recovery_writeoff:${recovery.id}`;
  const out = await withIdempotency(ctx, key, `POST ${c.req.path}`, input, () =>
    writeOffRecovery(ctx, recovery, input)
  );
  return c.json(out, 200);
});

/** docs/27 §E. Generate (or idempotently regenerate) a period bordereau. */
axisRoutes.post("/bordereaux", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:bordereaux:generate", { tenantId: ctx.tenantId, module: "axis" });
  const input = await body(c, GenerateBordereauBody);
  const out = await generateBordereaux(ctx, input);
  return c.json(out, 201);
});

axisRoutes.post("/bordereaux/:id/reconcile", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:bordereaux:reconcile", { tenantId: ctx.tenantId, module: "axis" });
  const bordereau = await must(ctx, schema.axisBordereaux, c.req.param("id"), "bordereaux");
  const out = await reconcileBordereaux(ctx, bordereau);
  return c.json(out, 200);
});

// AXIS-001's bulk half: CSV case import. Web intake, the partner API and
// ORBIT handoffs existed; this is the door a migration or an operations team
// actually uses. Per-row honest — the response names every line that failed
// and why, because a partial silent success on a compliance-adjacent surface
// is worse than a loud failure (engines/axis-case-import.ts).
axisRoutes.post("/cases/import", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "axis:cases:create", { tenantId: ctx.tenantId, module: "axis" });
  const csvText = await csvBody(c);
  const result = await importCases(ctx, csvText);
  return c.json(result, 201);
});

// AXIS-007: bulk actions with per-row permission checks and audit. Per-row
// honesty again — the response names every case that failed and why, because
// an operator who selected fifty cases deserves to know the three that did
// not happen (engines/axis-bulk.ts).
axisRoutes.post("/cases/bulk", async (c) => {
  const ctx = ctxOf(c);
  const input = await body(
    c,
    z.object({
      action: z.enum(["assign", "reprioritise", "close", "tag"]),
      caseIds: z.array(z.string().min(1)).min(1).max(500),
      ownerRef: z.string().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      tag: z.string().max(64).optional()
    })
  );
  return c.json(await applyBulkAction(ctx, input));
});

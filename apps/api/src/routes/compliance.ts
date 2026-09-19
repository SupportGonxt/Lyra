import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, inArray, isNull, lt, lte } from "drizzle-orm";
import { NameJson, TakafulJson, id, parseJson, schema, shariahCertified, toJson } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  canonicalJson,
  emit,
  gate,
  notFound,
  require_,
  scoped,
  sha256Hex,
  withIdempotency,
  type Ctx
} from "@lyra/core";
import { runTxn, type ReportTable } from "@lyra/ledger";
import { meterEgress } from "../engines/egress.js";
import { render } from "../engines/export/render.js";
import { utf8, zip } from "../engines/export/zip.js";
import { body, InstantMs } from "../http.js";
import type { App } from "../env.js";

// docs/12 §3–§5. Three compliance capabilities that a form cannot perform,
// because their rows carry values only the server can compute: a screening's
// query hash, a bundle's manifest and hash, a purge's counts. Decisions and
// their reasons: docs/decisions/ADR-0002-compliance-run-endpoints.md.

export const complianceRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

/* ------------------------------------------------------------- screening */

export type ScreeningKind = "sanctions" | "pep" | "adverse_media" | "fraud";

/** What the provider is asked. Hashed as-is, so normalisation lives upstream. */
export interface ScreeningQuery {
  kind: ScreeningKind;
  /** Lower-cased, single-spaced. Two spellings of one search must hash alike. */
  name: string;
  identifiers: Record<string, string>;
}

export interface ScreeningHit {
  listRef: string;
  matchedName: string;
  matchPct: number;
  note: string;
  /** Present on every hit this platform can produce today. See `stubScreening`. */
  stub: true;
}

export interface ScreeningOutcome {
  result: "clear" | "hit" | "inconclusive";
  hits: ScreeningHit[];
}

/**
 * The seam a bought watchlist plugs into (CLAUDE.md §15). One method, because a
 * screening is one question — the endpoint owns the hash, the row, the block and
 * the audit, so a provider cannot get any of those wrong.
 */
export interface ScreeningProvider {
  /** Written to `compliance_screenings.provider`; it is the evidence of what ran. */
  readonly name: string;
  screen(query: ScreeningQuery): Promise<ScreeningOutcome>;
}

/** Names that make the stub answer something other than "clear". Exported so a
 *  test can walk the hit path without pretending a real list exists. */
export const STUB_SCREENING_TOKENS = [
  ["lyra-test-hit", "hit"],
  ["lyra-test-inconclusive", "inconclusive"]
] as const;

/**
 * ponytail: no sanctions/PEP list is an approved provider (docs/02 §9), so this
 * consults nothing. It matches two deliberately fake tokens and returns "clear"
 * for every real name — which is not a screening result and is labelled as such
 * on every hit and on the screen. Upgrade path: a second implementation of
 * ScreeningProvider naming a real list, plus the ADR docs/02 §9 requires.
 */
export const stubScreening: ScreeningProvider = {
  name: "stub",
  async screen(query) {
    const match = STUB_SCREENING_TOKENS.find(([token]) => query.name.includes(token));
    if (!match) return { result: "clear", hits: [] };
    return {
      result: match[1],
      hits: [
        {
          listRef: `stub:${match[0]}`,
          matchedName: query.name,
          matchPct: 100,
          note: "Produced locally by the built-in stub. No watchlist was consulted.",
          stub: true
        }
      ]
    };
  }
};

const normaliseName = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, " ");

const ScreenBody = z
  .object({
    kind: z.enum(["sanctions", "pep", "adverse_media", "fraud"]).default("sanctions"),
    /** Screen a customer on file… */
    customerId: z.string().min(1).max(64).optional(),
    /** …or a name that is not one yet (an applicant, a counterparty). */
    name: z.string().min(1).max(200).optional(),
    /** Passport number, trade licence, date of birth — whatever narrows it. */
    identifiers: z.record(z.string().max(64), z.string().max(200)).optional()
  })
  .strict();

complianceRoutes.post("/screenings/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:screenings:run", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, ScreenBody);

  let subjectRef: string;
  let name: string;
  if (input.customerId) {
    const rows = await ctx.db
      .select({ id: schema.customers.id, nameJson: schema.customers.nameJson })
      .from(schema.customers)
      .where(scoped(ctx, schema.customers, eq(schema.customers.id, input.customerId)))
      .limit(1);
    const customer = rows[0];
    if (!customer) throw notFound("customer");
    subjectRef = `customer:${customer.id}`;
    name = input.name ?? NameJson.parse(JSON.parse(customer.nameJson)).en;
  } else if (input.name) {
    name = input.name;
    subjectRef = `name:${normaliseName(name)}`;
  } else {
    throw badRequest("customerId or name is required");
  }

  const query: ScreeningQuery = {
    kind: input.kind,
    name: normaliseName(name),
    identifiers: input.identifiers ?? {}
  };
  // Server-side, from the normalised query: the hash is the evidence that this
  // row answers that question, so it is never something a caller can state.
  const queryHash = await sha256Hex(canonicalJson(query));
  const outcome = await stubScreening.screen(query);

  const row = {
    id: id("scr", ctx.now),
    tenantId: ctx.tenantId,
    subjectRef,
    kind: input.kind,
    provider: stubScreening.name,
    queryHash,
    result: outcome.result,
    hitsJson: outcome.hits.length ? JSON.stringify(outcome.hits) : null,
    dispositionedBy: null,
    disposition: null,
    // docs/19 §4: a hit blocks. Clearing it is a disposition by a person.
    blocked: outcome.result === "hit",
    caseRef: null,
    ts: ctx.now
  };
  await ctx.db.insert(schema.screenings).values(row);
  await audit(ctx, { action: "compliance.screening.run", subjectRef, after: row });
  if (row.blocked) {
    // docs/19 §4 asks for "case + block". The block is here; the case is opened
    // by a consumer of this event, because compliance does not write AXIS rows
    // (CLAUDE.md §6). `case_ref` stays null until that consumer fills it.
    await emit(ctx, {
      module: "compliance",
      type: "compliance.screening.hit",
      subject: subjectRef,
      data: { screeningId: row.id, kind: row.kind, provider: row.provider }
    });
  }
  return c.json({ ...row, hits: outcome.hits }, 201);
});

/* --------------------------------------------------------- disclosures */

const DisclosurePresentBody = z
  .object({
    subjectRef: z.string().min(1).max(200),
    key: z.string().min(1).max(64),
    locale: z.string().min(2).max(10).default("en"),
    wording: z.string().min(1),
    wordingRef: z.string().min(1).max(200).optional(),
    criteria: z.record(z.string(), z.unknown()).optional(),
    channel: z.string().min(1).max(64),
    customerId: z.string().min(1).max(64).optional(),
    idempotencyKey: z.string().min(1).max(200)
  })
  .strict();

complianceRoutes.post("/disclosures/present", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:disclosures:present", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, DisclosurePresentBody);

  // The insert, audit, emit and runTxn call all need to replay as one unit —
  // runTxn alone only dedupes its own ledger write, so a replayed request was
  // otherwise double-writing the disclosures row/audit/event underneath it.
  const result = await withIdempotency(ctx, input.idempotencyKey, `POST ${c.req.path}`, input, async () => {
    const wordingHash = await sha256Hex(input.wording);
    const row = {
      id: id("dsc", ctx.now),
      tenantId: ctx.tenantId,
      key: input.key,
      locale: input.locale,
      subjectRef: input.subjectRef,
      customerId: input.customerId ?? null,
      wordingHash,
      wordingRef: input.wordingRef ?? null,
      criteriaJson: input.criteria ? JSON.stringify(input.criteria) : null,
      channel: input.channel,
      acknowledgedAt: null,
      ts: ctx.now
    };
    await ctx.db.insert(schema.disclosures).values(row);
    await audit(ctx, { action: "compliance.disclosure.present", subjectRef: input.subjectRef, after: row });
    await emit(ctx, {
      module: "compliance",
      type: "compliance.disclosure.presented",
      subject: input.subjectRef,
      data: { disclosureId: row.id, key: row.key, channel: row.channel }
    });

    // DISCLOSURE-PRESENT is non-financial (docs/19 §4: ⊘, financial: false) — the
    // disclosure itself, inserted above, is the evidence AD-PLACEMENT's
    // precondition reads; this is the audited, idempotent, reversible envelope
    // every business fact gets, posting no journal (same shape as REFERRAL-QUAL).
    const txn = await runTxn(ctx, {
      type: "DISCLOSURE-PRESENT",
      idempotencyKey: input.idempotencyKey,
      subjectRefs: { subject: input.subjectRef, ...(input.customerId ? { customer: input.customerId } : {}) }
    });

    return { ...row, txn };
  });

  return c.json(result, 201);
});

/* ------------------------------------------------------- evidence bundles */

/** ponytail: one page of each log per bundle. A regulator scope wider than this
 *  needs paging into several parts, which needs a part index in the manifest —
 *  build it when a real request exceeds it, not before. */
const BUNDLE_MAX_ROWS = 5_000;

const ExportBody = z
  .object({
    purpose: z.enum(["regulator", "audit", "dispute", "internal"]),
    /** Narrow to one subject: `customer:cus_…`, `case:cas_…`. Absent = the window. */
    subjectRef: z.string().min(1).max(200).optional(),
    from: InstantMs.nonnegative().optional(),
    to: InstantMs.nonnegative().optional(),
    /** Who asked for it — the regulator, the auditor. Not a delivery instruction. */
    deliveredTo: z.string().max(200).optional()
  })
  .strict();

complianceRoutes.post("/evidence-bundles/export", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:evidence:export", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, ExportBody);
  const from = input.from ?? 0;
  const to = input.to ?? ctx.now;
  if (from > to) throw badRequest("from must not be after to");

  const result = await withIdempotency(ctx, c.req.header("idempotency-key"), `POST ${c.req.path}`, input, async () => {
    const subject = input.subjectRef;
    const auditRows = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        scoped(
          ctx,
          schema.auditLog,
          gte(schema.auditLog.ts, from),
          lte(schema.auditLog.ts, to),
          subject ? eq(schema.auditLog.subjectRef, subject) : undefined
        )
      )
      .orderBy(schema.auditLog.ts)
      .limit(BUNDLE_MAX_ROWS);

    const aiRows = await ctx.db
      .select()
      .from(schema.aiAuditLog)
      .where(
        scoped(
          ctx,
          schema.aiAuditLog,
          gte(schema.aiAuditLog.ts, from),
          lte(schema.aiAuditLog.ts, to),
          subject ? eq(schema.aiAuditLog.subjectRef, subject) : undefined
        )
      )
      .orderBy(schema.aiAuditLog.ts)
      .limit(BUNDLE_MAX_ROWS);

    const scope = { subjectRef: subject ?? null, from, to, purpose: input.purpose };
    const jsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

    const summary: ReportTable = {
      title: "Evidence bundle",
      columns: [
        { key: "item", label: "Item", kind: "text" },
        { key: "value", label: "Value", kind: "text" }
      ],
      rows: [
        { item: "Purpose", value: input.purpose },
        { item: "Subject", value: subject ?? "all subjects in window" },
        { item: "Window from", value: new Date(from).toISOString() },
        { item: "Window to", value: new Date(to).toISOString() },
        { item: "Audit entries", value: String(auditRows.length) },
        { item: "AI actions", value: String(aiRows.length) },
        { item: "Requested by", value: actorRef(ctx) }
      ],
      generatedAt: ctx.now
    };

    const contents = [
      { path: "audit.jsonl", data: utf8(jsonl(auditRows)) },
      { path: "ai-audit.jsonl", data: utf8(jsonl(aiRows)) },
      { path: "summary.pdf", data: (await render("pdf", summary, {}, c.env.BROWSER)).bytes }
    ];
    const manifest = {
      version: 1,
      tenantId: ctx.tenantId,
      generatedAt: ctx.now,
      requestedBy: actorRef(ctx),
      scope,
      files: await Promise.all(
        contents.map(async (f) => ({ path: f.path, sizeBytes: f.data.length, sha256: await sha256Hex(f.data) }))
      ),
      truncated: auditRows.length === BUNDLE_MAX_ROWS || aiRows.length === BUNDLE_MAX_ROWS
    };
    // The manifest travels inside the archive, so the bundle hash covers it too:
    // one hash to quote, and the entries verify themselves against the manifest.
    // zip() writes fixed timestamps, so the same scope hashes the same twice.
    const archive = zip([...contents, { path: "manifest.json", data: utf8(JSON.stringify(manifest, null, 2)) }]);
    const bundleHash = await sha256Hex(archive);

    const bundleId = id("evb", ctx.now);
    const bucket = c.env.FILES;
    const fileId = bucket ? id("file", ctx.now) : null;
    if (bucket && fileId) {
      const r2Key = `evidence/${ctx.tenantId}/${bundleId}.zip`;
      await bucket.put(r2Key, archive, { httpMetadata: { contentType: "application/zip" } });
      await ctx.db.insert(schema.files).values({
        id: fileId,
        tenantId: ctx.tenantId,
        r2Key,
        kind: "evidence_bundle",
        subjectRef: bundleId,
        sha256: bundleHash,
        sizeBytes: archive.length,
        contentType: "application/zip",
        // The bundle is raw audit rows: high, always, whoever asked for it.
        piiLevel: "high",
        createdAt: ctx.now,
        deletedAt: null
      });
    }

    const row = {
      id: bundleId,
      tenantId: ctx.tenantId,
      purpose: input.purpose,
      scopeJson: JSON.stringify(scope),
      manifestJson: JSON.stringify(manifest),
      bundleHash,
      fileId,
      requestedBy: actorRef(ctx),
      approvedBy: null,
      state: bucket ? "ready" : "failed",
      // Recorded because a bundle is built *for* someone. Delivery itself is not
      // an API action here — see ADR-0002.
      deliveredTo: input.deliveredTo ?? null,
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
    await ctx.db.insert(schema.evidenceBundles).values(row);
    await audit(ctx, {
      action: "compliance.evidence.export",
      subjectRef: `evidence_bundle:${bundleId}`,
      after: { ...row, manifestJson: undefined, manifest }
    });
    return { ...row, manifest };
  });
  return c.json(result, 201);
});

complianceRoutes.get("/evidence-bundles/:id/download", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:evidence:read", { tenantId: ctx.tenantId, module: "compliance" });
  const rows = await ctx.db
    .select()
    .from(schema.evidenceBundles)
    .where(scoped(ctx, schema.evidenceBundles, eq(schema.evidenceBundles.id, c.req.param("id"))))
    .limit(1);
  const bundle = rows[0];
  if (!bundle) throw notFound("evidence bundle");
  if (!bundle.fileId) throw notFound("evidence bundle file");

  const files = await ctx.db
    .select()
    .from(schema.files)
    .where(scoped(ctx, schema.files, eq(schema.files.id, bundle.fileId)))
    .limit(1);
  const file = files[0];
  const object = file ? await c.env.FILES?.get(file.r2Key) : undefined;
  if (!object) throw notFound("evidence bundle file");

  await audit(ctx, {
    action: "compliance.evidence.download",
    subjectRef: `evidence_bundle:${bundle.id}`,
    after: { bundleHash: bundle.bundleHash }
  });
  await meterEgress(ctx, file?.sizeBytes ?? object.size);
  return new Response(object.body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="evidence-${bundle.id}.zip"`,
      "cache-control": "no-store"
    }
  });
});

/* ------------------------------------------------------------- retention */

/**
 * The record classes docs/12 §3 puts a floor under. The floor is the regulatory
 * minimum; `policy.retention` may only keep data *longer*, so the cutoff is the
 * later of the two and is never taken from the request.
 *
 * ponytail: `messages` only. `files` needs the object store purged with the row
 * and the erasure-completeness job (PLAT-038); `ai_audit` and `consent` are
 * evidence the platform is required to keep (docs/12 §2). Adding one is an entry
 * here plus its delete.
 */
const RETENTION_CLASSES = {
  messages: { tableName: "orbit_messages", floorMonths: 24 }
} as const;

/** ponytail: one batch per call, so a purge cannot time out or blow the SQL
 *  variable limit. Call again while `rowsAffected` equals this. */
const RETENTION_BATCH = 500;

function monthsBefore(now: number, months: number): number {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.getTime();
}

const RetentionBody = z
  .object({
    policyKey: z.string().min(1).max(64),
    /** Default true: a purge is irreversible and holds no approval (ADR-0002). */
    dryRun: z.boolean().default(true)
  })
  .strict();

complianceRoutes.post("/retention/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:retention:run", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, RetentionBody);
  const klass = Object.entries(RETENTION_CLASSES).find(([key]) => key === input.policyKey)?.[1];
  if (!klass) throw badRequest(`policyKey must be one of ${Object.keys(RETENTION_CLASSES).join(", ")}`);

  const months = Math.max(ctx.policy.retention.messagesMonths, klass.floorMonths);
  const cutoffAt = monthsBefore(ctx.now, months);

  const candidates = await ctx.db
    .select({ id: schema.orbitMessages.id, conversationId: schema.orbitMessages.conversationId })
    .from(schema.orbitMessages)
    .where(scoped(ctx, schema.orbitMessages, lt(schema.orbitMessages.ts, cutoffAt)))
    .limit(RETENTION_BATCH);

  // A hold freezes deletion for its subject (schema compliance_legal_holds).
  // It can name the conversation or the person behind it; both stop the purge.
  const holds = new Set(
    (
      await ctx.db
        .select({ subjectRef: schema.legalHolds.subjectRef })
        .from(schema.legalHolds)
        .where(scoped(ctx, schema.legalHolds, isNull(schema.legalHolds.releasedAt)))
    ).map((h) => h.subjectRef)
  );
  const conversationIds = [...new Set(candidates.map((m) => m.conversationId))];
  const customerOf = new Map(
    conversationIds.length
      ? (
          await ctx.db
            .select({ id: schema.orbitConversations.id, customerId: schema.orbitConversations.customerId })
            .from(schema.orbitConversations)
            .where(scoped(ctx, schema.orbitConversations, inArray(schema.orbitConversations.id, conversationIds)))
        ).map((row) => [row.id, row.customerId])
      : []
  );

  const held = (conversationId: string): boolean => {
    if (holds.has(`conversation:${conversationId}`)) return true;
    const customerId = customerOf.get(conversationId);
    return customerId ? holds.has(`customer:${customerId}`) : false;
  };
  const purge = candidates.filter((m) => !held(m.conversationId));
  const rowsHeld = candidates.length - purge.length;

  if (input.dryRun) {
    await audit(ctx, {
      action: "compliance.retention.plan",
      subjectRef: `retention:${input.policyKey}`,
      after: { policyKey: input.policyKey, cutoffAt, rowsAffected: purge.length, rowsHeld }
    });
    return c.json({
      dryRun: true,
      policyKey: input.policyKey,
      tableName: klass.tableName,
      cutoffAt,
      retentionMonths: months,
      rowsAffected: purge.length,
      rowsHeld,
      more: candidates.length === RETENTION_BATCH
    });
  }

  const run = {
    id: id("ret", ctx.now),
    tenantId: ctx.tenantId,
    policyKey: input.policyKey,
    tableName: klass.tableName,
    cutoffAt,
    rowsAffected: purge.length,
    rowsHeld,
    state: "done",
    error: null,
    startedAt: ctx.now,
    endedAt: ctx.now
  };
  if (purge.length) {
    await ctx.db.delete(schema.orbitMessages).where(
      and(
        scoped(ctx, schema.orbitMessages),
        inArray(
          schema.orbitMessages.id,
          purge.map((m) => m.id)
        )
      )
    );
  }
  await ctx.db.insert(schema.retentionRuns).values(run);
  await audit(ctx, {
    action: "compliance.retention.run",
    subjectRef: `retention:${input.policyKey}`,
    after: run
  });
  return c.json({ ...run, more: candidates.length === RETENTION_BATCH }, 201);
});

/* ------------------------------------------------------------ run-only rows */

// These three rows are produced by the runs above and nothing else: their hashes
// and counts are evidence, and evidence a caller can type is not evidence. The
// generated CRUD would happily take a body with a `queryHash` in it, so this
// shadows the create — Hono answers with whatever registered first, and this
// router mounts before the generated one (apps/api/src/index.ts).
const RUN_ONLY = [
  ["/screenings", "compliance:screenings:run", "POST /v1/compliance/screenings/run"],
  ["/evidence-bundles", "compliance:evidence:export", "POST /v1/compliance/evidence-bundles/export"],
  ["/retention-runs", "compliance:retention:run", "POST /v1/compliance/retention/run"]
] as const;

for (const [path, permission, endpoint] of RUN_ONLY) {
  complianceRoutes.post(path, (c) => {
    const ctx = ctxOf(c);
    require_(ctx.actor, permission, { tenantId: ctx.tenantId, module: "compliance" });
    throw badRequest(`this record is produced by a run, not written directly — use ${endpoint}`);
  });
}

/* --------------------------------------------------- Shariah review lane */

// docs/16 H8 "Shariah-board workflow (review lane like compliance pre-flight)",
// docs/27 F45. A takaful product carries a standing ruling in
// core_products.takaful_json; `SURPLUS-DIST`'s precondition
// (packages/ledger/src/preconditions.ts) refuses to distribute out of a product
// whose ruling is missing or expired.
//
// These two endpoints exist because the state is otherwise writable through the
// generic product CRUD, which knows nothing about `compliance.shariah_certify`.
// An approval policy no write routes through is a declared gate nothing passes
// — so the lane is a route, and the CRUD field is refused below.

const ShariahSubmit = z.object({
  productId: z.string().min(1),
  model: z.enum(["wakala", "mudaraba", "hybrid"]).optional(),
  wakalaFeeBps: z.number().int().min(0).max(10_000).optional(),
  participantShareBps: z.number().int().min(0).max(10_000).optional(),
  fundRef: z.string().max(200).optional()
});

const ShariahCertify = z.object({
  productId: z.string().min(1),
  boardRef: z.string().min(1).max(200),
  fatwaRef: z.string().min(1).max(200),
  /** When the ruling lapses and the product stops being certified. */
  expiresAt: InstantMs.optional()
});

async function takafulProduct(ctx: Ctx, productId: string) {
  const [row] = await ctx.db
    .select({
      id: schema.products.id,
      structure: schema.products.structure,
      takafulJson: schema.products.takafulJson
    })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId)))
    .limit(1);
  if (!row) throw notFound(`product ${productId} not found`);
  if (row.structure !== "takaful") {
    throw badRequest(`product ${productId} is ${row.structure}; only a takaful product has a Shariah ruling`);
  }
  return { row, takaful: parseJson(TakafulJson, row.takafulJson) };
}

async function writeTakaful(ctx: Ctx, productId: string, next: TakafulJson): Promise<void> {
  await ctx.db
    .update(schema.products)
    .set({ takafulJson: toJson(TakafulJson, next), updatedAt: ctx.now })
    .where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId)));
}

/** Put a product's terms in front of the board. Not itself consequential —
 *  submitting asks a question, it does not answer one. */
complianceRoutes.post("/shariah/submit", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:shariah:read", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, ShariahSubmit);
  const { takaful } = await takafulProduct(ctx, input.productId);

  const next: TakafulJson = {
    ...takaful,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.wakalaFeeBps !== undefined ? { wakalaFeeBps: input.wakalaFeeBps } : {}),
    ...(input.participantShareBps !== undefined ? { participantShareBps: input.participantShareBps } : {}),
    ...(input.fundRef !== undefined ? { fundRef: input.fundRef } : {}),
    // Resubmitting drops the old ruling rather than keeping it beside new
    // terms: a board certified the terms it was shown, and a certificate that
    // survives an edit to the surplus rule is a certificate for something else.
    shariah: { state: "submitted" }
  };
  await writeTakaful(ctx, input.productId, next);
  await audit(ctx, {
    action: "compliance.shariah.submit",
    subjectRef: `product:${input.productId}`,
    before: takaful,
    after: next
  });
  return c.json({ productId: input.productId, shariah: next.shariah });
});

/** The board's ruling. Gated: dual control, never auto-approvable. */
complianceRoutes.post("/shariah/certify", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:shariah:certify", { tenantId: ctx.tenantId, module: "compliance" });
  const input = await body(c, ShariahCertify);
  const { takaful } = await takafulProduct(ctx, input.productId);

  if (takaful.shariah.state === "certified") {
    throw badRequest(`product ${input.productId} is already certified; resubmit it before certifying again`);
  }

  const approval = await gate(ctx, {
    policyKey: "compliance.shariah_certify",
    subjectRef: `product:${input.productId}`,
    context: input
  });

  const next: TakafulJson = {
    ...takaful,
    shariah: {
      state: "certified",
      // `gate` returns null only on an auto-approval path, and
      // `compliance.shariah_certify` is `neverAutoApprove` — so a null here
      // would mean the policy lost that flag, and the ruling would be recorded
      // with nothing behind it. Recorded as an absent id rather than asserted,
      // because the row must not claim an approval it does not have.
      ...(approval ? { approvalId: approval.id } : {}),
      boardRef: input.boardRef,
      fatwaRef: input.fatwaRef,
      certifiedAt: ctx.now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {})
    }
  };
  await writeTakaful(ctx, input.productId, next);
  await audit(ctx, {
    action: "compliance.shariah.certify",
    subjectRef: `product:${input.productId}`,
    before: takaful,
    after: next
  });
  await emit(ctx, {
    type: "compliance.shariah.certified",
    module: "core",
    subject: `product:${input.productId}`,
    data: { productId: input.productId, fatwaRef: input.fatwaRef, certifiedAt: ctx.now }
  });
  return c.json({ productId: input.productId, shariah: next.shariah });
});

/** What the board has said, for a screen that has to show it. */
complianceRoutes.get("/shariah/:productId", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "compliance:shariah:read", { tenantId: ctx.tenantId, module: "compliance" });
  const productId = c.req.param("productId");
  const { takaful } = await takafulProduct(ctx, productId);
  return c.json({
    productId,
    model: takaful.model,
    wakalaFeeBps: takaful.wakalaFeeBps,
    participantShareBps: takaful.participantShareBps,
    ...(takaful.fundRef !== undefined ? { fundRef: takaful.fundRef } : {}),
    shariah: takaful.shariah,
    // The question every reader actually has, answered once here rather than
    // recomputed per screen — "certified" alone is not the answer, an expired
    // ruling is still `state: "certified"`.
    current: shariahCertified(takaful, ctx.now)
  });
});

import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@lyra/db";
import {
  actorRef,
  audit,
  can,
  conflict,
  coverageOf,
  diffWords,
  ForbiddenError,
  kAnonymityFloor,
  moduleOn,
  require_,
  withIdempotency,
  SIGNAL_SOURCE_KINDS,
  notFound,
  type Ctx
} from "@lyra/core";
import type { WhitespaceCandidate } from "@lyra/core";
import { body, csvBody, requireHeader } from "../http.js";
import {
  sweepWhitespace,
  coveragePerLine,
  whitespaceCommentaries,
  whitespaceCommentary
} from "../engines/scout-whitespace.js";
import { promoteWhitespace } from "../engines/scout-promote.js";
import { describeSources, harvestSignals } from "../engines/scout-ingest.js";
import { deliverProduct, subscribeProduct } from "../engines/scout-data-product.js";
import { parseSignalCsv } from "../engines/scout-import.js";
import { sweepSignalClusters } from "../engines/scout-cluster.js";
import { benchElasticity, sweepPanelBench } from "../engines/scout-bench.js";
import { runWatch } from "../engines/scout-watch.js";
import { suggestTargeting } from "../engines/signal-audience.js";
import { compareWordings, comparisonRef } from "../engines/scout-wording.js";
import { planCampaign } from "../engines/signal-campaign-plan.js";
import { generateCreatives } from "../engines/signal-creative.js";
import { embedQuery } from "../engines/vectorize.js";
import { buildNegotiationPackTables } from "../engines/export/negotiation-pack.js";
import { toPdf } from "../engines/export/pdf.js";
import { gatewayFor } from "../mw.js";
import type { App } from "../env.js";

// docs/modules/scout.md §8 clause 1 (whitespace) and §2.3 (wording diffs feed
// negotiation packs) — three bespoke compute/export routes, same idiom as
// orbit.ts's `/renewals/sweep`: none of these is one-row CRUD.

export const scoutRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

scoutRoutes.post("/whitespaces/compute", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:whitespaces:promote", { tenantId: ctx.tenantId, module: "scout" });
  return c.json({ candidates: await sweepWhitespace(ctx, c.get("gateway")) }, 201);
});

/**
 * The commentary a Radar hover shows: why each category is whitespace, in one
 * sentence, plus the evidence it was grounded against. A plain read — every
 * sentence was drafted at sweep time and cached on its row, so this is the
 * prefetch the Radar issues beside the dots and a hover then costs neither a
 * request nor a model call. The payload carries the ✦ + provenance that makes it
 * inspectable (docs/15 §4). `scout:whitespaces:read`, not the promote grant: an
 * analyst who may look at the Radar may read why a row is on it.
 *
 * Registered before the generated CRUD (index.ts), so `commentary` is a path and
 * not read as a whitespace id.
 */
scoutRoutes.get("/whitespaces/commentary", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:whitespaces:read", { tenantId: ctx.tenantId, module: "scout" });
  const limit = Number(c.req.query("limit"));
  return c.json({ data: await whitespaceCommentaries(ctx, Number.isFinite(limit) ? limit : undefined) });
});

/** One row's commentary, same payload as an element of the prefetch above. */
scoutRoutes.get("/whitespaces/:id/commentary", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:whitespaces:read", { tenantId: ctx.tenantId, module: "scout" });
  return c.json(await whitespaceCommentary(ctx, c.req.param("id")));
});

/**
 * Whitespace -> SIGNAL campaign. Approval-gated, idempotent, audited, and
 * announced on the bus (docs/04 §7 `scout.whitespace.promoted`) rather than by
 * reaching into SIGNAL's tables. The creative generator is handed in so the
 * cross-module call happens here, at the composition root, and not between two
 * module engines (CLAUDE.md rule 6).
 */
scoutRoutes.post("/whitespaces/:id/promote-to-signal", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:whitespaces:promote", { tenantId: ctx.tenantId, module: "scout" });
  // @accept:SA: the handover drafts a campaign, its ads and its audience in
  // SIGNAL. Without SIGNAL there is nowhere for them to land — say so before
  // asking anyone to approve a promotion that could only write orphan rows.
  if (!moduleOn(ctx, "signal")) throw conflict("promoting a whitespace hands it to signal (marketing), which this tenant does not have on");
  const whitespaceId = c.req.param("id");
  const result = await withIdempotency(
    ctx,
    c.req.header("idempotency-key"),
    "scout.whitespace.promote",
    { whitespaceId },
    () =>
      promoteWhitespace(ctx, c.get("gateway"), generateCreatives, suggestTargeting, planCampaign, whitespaceId)
  );
  return c.json(result, 201);
});

/**
 * The Harvester (docs/modules/scout.md §3). Runs every registered
 * `SignalSource` and records what is new. Idempotent at the engine — a second
 * call in the same window ingests nothing — so it needs no idempotency key and
 * can be scheduled, retried or pressed twice by a person without consequence.
 *
 * `fed` is the feed API §4 screen 7 names: items an integrator supplies
 * directly, which travel the same path a connector's would. No adapter in this
 * build calls anything outside LYRA (ADR-0078).
 */
const FedSignal = z.object({
  source: z.enum(SIGNAL_SOURCE_KINDS),
  sourceRef: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()).default({}),
  observedAt: z.number().int(),
  // Defaulted rather than optional: `exactOptionalPropertyTypes` makes
  // `weight?: number` and `weight: number | undefined` different types, and one
  // observation weighing 1 is the right reading of a body that omitted it.
  weight: z.number().int().min(1).max(1_000).default(1)
});
const HarvestBody = z.object({ fed: z.array(FedSignal).max(200).default([]) });

scoutRoutes.post("/signals/harvest", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:signals:ingest", { tenantId: ctx.tenantId, module: "scout" });
  const input = c.req.header("content-type")?.includes("json") ? await body(c, HarvestBody) : { fed: [] };
  const report = await harvestSignals(ctx, c.get("gateway"), c.env, { fed: input.fed });
  await audit(ctx, { action: "scout.signals.harvest", subjectRef: "signals", after: report });
  return c.json(report, 201);
});

// @accept:SA: SCOUT's own signals from a file, so a tenant that bought SCOUT
// alone has a market to read. Per-line honest; stored by the harvest path.
scoutRoutes.post("/signals/import", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:signals:ingest", { tenantId: ctx.tenantId, module: "scout" });
  const { items, errors } = parseSignalCsv(await csvBody(c), ctx.now);
  const report = items.length ? await harvestSignals(ctx, c.get("gateway"), c.env, { fed: items, fedOnly: true }) : { harvested: 0, ingested: 0, duplicates: 0, bySource: {} };
  await audit(ctx, { action: "scout.signals.import", subjectRef: "signals", after: { ...report, errors: errors.length } });
  return c.json({ ...report, errors }, 201);
});

/** The registry itself — what can arrive, without running anything. The source
 *  manager (§4 screen 6) renders this instead of claiming a connector table. */
scoutRoutes.get("/sources", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:signals:read", { tenantId: ctx.tenantId, module: "scout" });
  return c.json({ data: describeSources(ctx) });
});

/** The Clusterer (docs §3, weekly). Reads VEC_MARKET to place a signal in an
 *  existing cluster and stamps `scout_signals.cluster_id`. Idempotent. */
scoutRoutes.post("/clusters/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:clusters:build", { tenantId: ctx.tenantId, module: "scout" });
  const report = await sweepSignalClusters(ctx, c.get("gateway"), c.env);
  await audit(ctx, { action: "scout.clusters.sweep", subjectRef: "clusters", after: report });
  return c.json(report, 201);
});

/** The Bench Builder (docs §3, nightly). Rebuilds every provider x line x month
 *  cell from the panel's own answers. Idempotent; emits `scout.bench.updated`. */
scoutRoutes.post("/panel-bench/sweep", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:panel_bench:build", { tenantId: ctx.tenantId, module: "scout" });
  const report = await sweepPanelBench(ctx);
  await audit(ctx, { action: "scout.bench.sweep", subjectRef: "panel-bench", after: report });
  return c.json(report, 201);
});

/** docs/30 SCOUT 5: how much win rate moves with price, per line, fitted over
 *  the bench cells a bench reader may see (engines/scout-bench.ts). A read — no
 *  audit row, same as the bench list it summarises. */
scoutRoutes.get("/price-elasticity", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:panel_bench:read", { tenantId: ctx.tenantId, module: "scout" });
  return c.json({ data: await benchElasticity(ctx) });
});

/**
 * The competitor and regulatory watch (docs §2.1). A derivation over the
 * signals already recorded, never a write — see engines/scout-watch.ts for why
 * a persisted finding would have to answer a question this shape cannot.
 */
scoutRoutes.get("/watch", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:signals:read", { tenantId: ctx.tenantId, module: "scout" });
  const days = Number(c.req.query("days"));
  const windowMs = Number.isFinite(days) && days >= 1 && days <= 180 ? days * 86_400_000 : undefined;
  return c.json(await runWatch(ctx, windowMs));
});

/**
 * docs/modules/scout.md §2.5, docs/30 SCOUT 1 (ADR-0101). Selling a data
 * product: subscribe fixes a provider's fee under the
 * `scout.data_product_subscribe` approval; deliver builds the cut, gates it on
 * k-anonymity, bills the approved fee and logs the artefact. Both are
 * contractual, so both demand an idempotency key rather than accept one.
 * Registered before the generated CRUD, like the whitespace routes above.
 */
const SubscribeBody = z.object({
  providerId: z.string().min(1).max(100),
  feeMinor: z.number().int().positive().max(1_000_000_000_00)
});
const DeliverBody = z.object({ providerId: z.string().min(1).max(100) });

scoutRoutes.post("/data-products/:id/subscribe", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:data_products:publish", { tenantId: ctx.tenantId, module: "scout" });
  const key = requireHeader(c, "idempotency-key");
  const input = await body(c, SubscribeBody);
  const dataProductId = c.req.param("id");
  const result = await withIdempotency(ctx, key, "scout.data_product.subscribe", { dataProductId, ...input }, () =>
    subscribeProduct(ctx, { dataProductId, ...input, key })
  );
  return c.json(result, 201);
});

scoutRoutes.post("/data-products/:id/deliver", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:data_products:publish", { tenantId: ctx.tenantId, module: "scout" });
  const key = requireHeader(c, "idempotency-key");
  const input = await body(c, DeliverBody);
  const dataProductId = c.req.param("id");
  const result = await withIdempotency(ctx, key, "scout.data_product.deliver", { dataProductId, ...input }, () =>
    deliverProduct(ctx, c.env.FILES, { dataProductId, providerId: input.providerId, key })
  );
  return c.json(result, 201);
});

// docs/27 P2 K_FLOOR follow-up: scout-admin.tsx, scout-data-products.tsx,
// scout-panel.tsx and scout-pricing.tsx all show/validate against the SCOUT
// k-anonymity floor, and until now read a compiled literal that could not see
// a tenant's own override (moduleConfig.scout.settings.kAnonymityFloor). This
// is the seam they read the resolved value from. Gated on any of the three
// real SCOUT read permissions those screens require — not scout:signals:read
// alone, which provider.viewer (reachable on two of the four) does not hold.
scoutRoutes.get("/config", (c) => {
  const ctx = ctxOf(c);
  const subject = { tenantId: ctx.tenantId, module: "scout" };
  const allowed = (
    ["scout:signals:read", "scout:data_products:read", "scout:panel_bench:read"] as const
  ).some((p) => can(ctx.actor, p, subject));
  if (!allowed) throw new ForbiddenError("scout:signals:read");
  return c.json({ kFloor: kAnonymityFloor(ctx.policy, "scout") });
});

const WordingDiffBody = z.object({ textA: z.string().max(50_000), textB: z.string().max(50_000) });

/**
 * ADR-0123. The route the criterion actually needed: **two documents, not two
 * strings.** The differ above takes text a human already has; this one gets the
 * text from the documents, transcribing whichever side has no reading yet, and
 * answers the spans **with where each side came from** — because a comparison of
 * two model readings is a different claim from a comparison of two text layers,
 * and a surface that does not say which it is looking at cannot be defended.
 *
 * Bytes come from R2 through the file row, so the engine stays testable without a
 * bucket binding.
 */
const WordingCompareBody = z.object({ leftId: z.string().min(1), rightId: z.string().min(1) });

scoutRoutes.post("/wording-diff/documents", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:panel_bench:read", { tenantId: ctx.tenantId, module: "scout" });
  const input = await body(c, WordingCompareBody);

  const read = async (documentId: string) => {
    const [document] = await ctx.db
      .select({ fileId: schema.axisDocuments.fileId })
      .from(schema.axisDocuments)
      .where(and(eq(schema.axisDocuments.tenantId, ctx.tenantId), eq(schema.axisDocuments.id, documentId)));
    if (!document) throw notFound("document");
    const object = await c.env.FILES?.get(`documents/${ctx.tenantId}/${document.fileId}`);
    if (!object) {
      // A document row whose object is gone is a missing document, not a wording
      // of nothing: transcribing nothing would report the whole document as a
      // coverage change.
      throw notFound("document file");
    }
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      mimeType: object.httpMetadata?.contentType ?? "application/pdf"
    };
  };

  const comparison = await compareWordings(ctx, gatewayFor(c.env), { ...input, read });
  await audit(ctx, {
    action: "scout.wording.compared",
    subjectRef: comparisonRef(input.leftId, input.rightId),
    // Which readings were taken now, and by which model — the half a reader
    // needs to know whether this comparison is stable or fresh.
    after: {
      left: { model: comparison.left.reading.model, transcribedNow: comparison.left.transcribedNow },
      right: { model: comparison.right.reading.model, transcribedNow: comparison.right.transcribedNow },
      spans: comparison.spans.length
    }
  });
  return c.json(comparison);
});

// ADR-0016: PDF-to-text extraction deferred, this takes plain text.
scoutRoutes.post("/wording-diff", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:panel_bench:read", { tenantId: ctx.tenantId, module: "scout" });
  const input = await body(c, WordingDiffBody);
  return c.json({ spans: diffWords(input.textA, input.textB) });
});

const SimilarBody = z.object({ text: z.string().min(1).max(4_000), topK: z.number().int().min(1).max(20).default(10) });

// Signals are embedded into VEC_MARKET on ingest (resources.ts SCOUT signals
// beforeWrite). This is the read side of that index: the nearest neighbours of
// a phrase, so an integrator can see whether what they ingest lands near what
// the harvester already holds. The tenant filter is not optional — one index
// carries every tenant's vectors.
scoutRoutes.post("/signals/similar", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "scout:signals:read", { tenantId: ctx.tenantId, module: "scout" });
  const input = await body(c, SimilarBody);
  const matches = await embedQuery(ctx, c.get("gateway"), c.env.VEC_MARKET, {
    module: "scout",
    purpose: "scout.signal.similar",
    text: input.text,
    topK: input.topK,
    filter: { tenantId: ctx.tenantId }
  });
  // Vectorize holds the vector id, not the row: the signal's own columns come
  // from the database, and a match whose row has been deleted is dropped
  // rather than served as a bare id.
  const rows = matches.length
    ? await ctx.db
        .select({
          id: schema.scoutSignals.id,
          source: schema.scoutSignals.source,
          observedAt: schema.scoutSignals.observedAt,
          embeddingRef: schema.scoutSignals.embeddingRef
        })
        .from(schema.scoutSignals)
        .where(
          and(
            eq(schema.scoutSignals.tenantId, ctx.tenantId),
            inArray(
              schema.scoutSignals.embeddingRef,
              matches.map((one) => one.id)
            )
          )
        )
    : [];
  const byRef = new Map(rows.map((row) => [row.embeddingRef, row]));
  return c.json({
    matches: matches.flatMap((one) => {
      const row = byRef.get(one.id);
      return row ? [{ id: row.id, source: row.source, observedAt: row.observedAt, score: one.score }] : [];
    })
  });
});

scoutRoutes.get("/panel-bench/negotiation-pack", async (c) => {
  const ctx = ctxOf(c);
  // Not scout:panel_bench:read — provider.viewer holds that too, and this pack
  // bakes every provider's price index/win-rate/volume into one PDF for LYRA's
  // own negotiation prep. Handing a provider its counterparty's numbers (or its
  // own prep pack against itself) defeats the tool; gate on an internal-only
  // scout permission instead (scout.pm/lead/admin, never provider.viewer).
  require_(ctx.actor, "scout:whitespaces:promote", { tenantId: ctx.tenantId, module: "scout" });

  const bench = await ctx.db
    .select({
      providerId: schema.scoutPanelBench.providerId,
      line: schema.scoutPanelBench.line,
      period: schema.scoutPanelBench.period,
      ourPriceIdx: schema.scoutPanelBench.ourPriceIdx,
      marketPriceIdx: schema.scoutPanelBench.marketPriceIdx,
      winRate: schema.scoutPanelBench.winRate,
      volume: schema.scoutPanelBench.volume,
      // ADR-0127: the pack's own copy promises the wording gaps, and this
      // select used to omit the column, so it never carried any. Read through
      // the one accessor, never parsed here.
      coverageGapsJson: schema.scoutPanelBench.coverageGapsJson
    })
    .from(schema.scoutPanelBench)
    .where(eq(schema.scoutPanelBench.tenantId, ctx.tenantId));

  const whitespaceRows = await ctx.db
    .select({ category: schema.scoutWhitespaces.category, demandEstimate: schema.scoutWhitespaces.demandEstimate })
    .from(schema.scoutWhitespaces)
    .where(
      and(
        eq(schema.scoutWhitespaces.tenantId, ctx.tenantId),
        inArray(schema.scoutWhitespaces.status, ["candidate", "validating", "validated"])
      )
    );

  // scout_whitespaces never persists a suppressed (below k-anonymity) row, so
  // every one read back here is already `visible: true` by construction — see
  // sweepWhitespace's own filter. coverage is looked up live rather than
  // stored, so the pack always reflects the book as it stands today.
  const coverageByLine = await coveragePerLine(ctx);
  const whitespace: WhitespaceCandidate[] = whitespaceRows
    .filter((w): w is typeof w & { category: string } => w.category !== null)
    .map((w) => ({
      category: w.category,
      momentum: w.demandEstimate ?? 0,
      coverage: coverageByLine.get(w.category) ?? 0,
      cellCount: 0,
      visible: true
    }));

  // The stored column reaches the pack only through the accessor that tolerates
  // what is already in the database (ADR-0127) — including the seed's pre-union
  // shapes on rows written before this change.
  const tables = buildNegotiationPackTables(
    bench.map((row) => ({
      providerId: row.providerId,
      line: row.line,
      period: row.period,
      ourPriceIdx: row.ourPriceIdx,
      marketPriceIdx: row.marketPriceIdx,
      winRate: row.winRate,
      volume: row.volume,
      coverage: coverageOf(row.coverageGapsJson)
    })),
    whitespace,
    ctx.now
  );
  // The same two omissions NORTH's board pack had, on a document that goes to a
  // **provider** rather than to the tenant's own board: no footer at all, and a
  // `Requested by` of `user:<id>`. CLAUDE.md §5 — the footer is the tenant's own
  // name, never the platform's, and never its id
  // (`axis-policy-document.ts:288` is the idiom).
  const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId));
  const brand = tenant?.brandJson ? (JSON.parse(tenant.brandJson) as { name?: string }) : {};
  const requestedBy =
    ctx.actor.kind === "user"
      ? ((
          await ctx.db
            .select({ name: schema.users.name })
            .from(schema.users)
            .where(and(eq(schema.users.tenantId, ctx.tenantId), eq(schema.users.id, ctx.actor.id)))
            .limit(1)
        )[0]?.name ?? actorRef(ctx))
      : actorRef(ctx);
  const bytes = toPdf(tables, {
    footer: brand.name ?? tenant?.name ?? "",
    meta: { "Requested by": requestedBy }
  });

  await audit(ctx, { action: "scout.negotiation_pack.export", subjectRef: "panel-bench", after: { rows: bench.length } });

  const stamp = new Date(ctx.now).toISOString().slice(0, 10);
  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="negotiation-pack-${stamp}.pdf"`,
      "cache-control": "no-store"
    }
  });
});

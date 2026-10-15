import { Hono } from "hono";
import { z } from "zod";
import { and, count, eq, gte, inArray, max } from "drizzle-orm";
import type { ReportTable } from "@lyra/ledger";
import { id, schema } from "@lyra/db";
import { actorRef, audit, buildCompliancePosture, forecast, journeyHealth, notFound, require_, sha256Hex, type Ctx } from "@lyra/core";
import { body, csvBody, IsoDay, parse } from "../http.js";
import { must, one } from "../rows.js";
import { meterEgress } from "../engines/egress.js";
import { generateBriefing } from "../engines/narrator.js";
import { runSnapshotter } from "../engines/north-snapshotter.js";
import { importMetricCsv, pushMetricValues } from "../engines/north-metric-push.js";
import { closedHistory, runScenario } from "../engines/north-scenario.js";
import { approveBoardpack, assembleBoardpackSections, distributeBoardpack } from "../engines/north-boardpack.js";
import { toPdf } from "../engines/export/pdf.js";
import { pushToActor } from "../engines/realtime.js";
import type { App } from "../env.js";

// docs/modules/north.md §2.2 (daily brief) and §2.5/§8 (board pack, one
// click). Two bespoke routes, same idiom as signal.ts/scout.ts: gate, call
// the engine, respond. Neither is one-row CRUD.

export const northRoutes = new Hono<App>();

const ctxOf = (c: { get(k: "ctx"): Ctx }): Ctx => c.get("ctx");

const GenerateBriefingBody = z.object({
  date: IsoDay,
  audience: z.string().optional(),
  locale: z.string().optional()
});

// engines/narrator.ts was complete (snapshot build, gateway call, numeric-claim
// verification, DB insert) but had no caller until this route.
northRoutes.post("/briefings/generate", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:briefings:generate", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, GenerateBriefingBody);
  const result = await generateBriefing(ctx, c.get("gateway"), {
    date: input.date,
    ...(input.audience !== undefined ? { audience: input.audience } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {})
  });
  await pushToActor(c.env, ctx.tenantId, ctx.actor.id, "north.briefing.generated", { id: result.id }, ctx.now);
  // J-E1: the briefing reaching the reader is its own audit step, so the
  // journey funnel has a "delivered" end that a push cannot supply.
  await audit(ctx, {
    action: "north.briefing.generated",
    subjectRef: result.id,
    after: { date: input.date, audience: result.audience, status: result.status }
  });
  return c.json(result, 201);
});

// J-E1 "the 7am read": opening a briefing is the read half of the journey. Once
// per reader per briefing per UTC day — a refresh is not a second read, and the
// audit log is not a page-view log.
northRoutes.post("/briefings/:id/read", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:briefings:read", { tenantId: ctx.tenantId, module: "north" });
  const briefing = await must(ctx, schema.northBriefings, c.req.param("id"), "briefing");
  const dayStart = ctx.now - (ctx.now % 86_400_000);
  const [seen] = await ctx.db
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.tenantId, ctx.tenantId),
        eq(schema.auditLog.action, "north.briefing.read"),
        eq(schema.auditLog.subjectRef, briefing.id),
        eq(schema.auditLog.actorRef, actorRef(ctx)),
        gte(schema.auditLog.ts, dayStart)
      )
    )
    .limit(1);
  if (!seen) await audit(ctx, { action: "north.briefing.read", subjectRef: briefing.id });
  return c.json({ read: true, alreadyReadToday: Boolean(seen) });
});

// ADR-0118: the grounding provenance behind a briefing's narrative — epistemic
// coverage, the assembled facts and their sources, whether it refused to guess.
// Read-only and tenant-scoped; a briefing the narrator never grounded (or that
// predates the grounding column) answers `{ grounding: null }`, never a guess.
northRoutes.get("/briefings/:id/grounding", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:briefings:read", { tenantId: ctx.tenantId, module: "north" });
  const briefing = await must(ctx, schema.northBriefings, c.req.param("id"), "briefing");
  if (!briefing.aiAuditId) return c.json({ grounding: null });
  const audit = await one(ctx, schema.aiAuditLog, briefing.aiAuditId);
  if (!audit?.groundingJson) return c.json({ grounding: null });
  try {
    return c.json({ grounding: JSON.parse(audit.groundingJson) });
  } catch {
    return c.json({ grounding: null });
  }
});

const GenerateBoardpackBody = z.object({ period: z.string().min(1), title: z.string().min(1).max(200) });

// docs/30 NORTH 5, rule 4: a person signs the rendered pack off, then sends it.
northRoutes.post("/boardpacks/:id/approve", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:boardpacks:approve", { tenantId: ctx.tenantId, module: "north" });
  return c.json(await approveBoardpack(ctx, c.req.param("id")));
});

// docs/30 NORTH 3: numbers from outside Lyra, for a metric nothing here computes.
northRoutes.post("/metrics/:key/values", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:metrics:write", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(
    c,
    z.object({ values: z.array(z.object({ period: z.string().min(7).max(10), value: z.number().int() })).min(1).max(400) })
  );
  return c.json(await pushMetricValues(ctx, c.req.param("key"), input.values));
});

// @accept:SA: the same push from a file (`metric,period,value`), per-line errors.
northRoutes.post("/metrics/import", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:metrics:write", { tenantId: ctx.tenantId, module: "north" });
  return c.json(await importMetricCsv(ctx, await csvBody(c)), 201);
});

// docs/30 NORTH 4, ADR-0103: compute a stored what-if against the metric's own
// forecast and store the answer on the row. Mounted before generic CRUD, and the
// CRUD strips resultJson (resources.ts), so this is the one writer of an answer.
northRoutes.post("/scenarios/:id/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:scenarios:run", { tenantId: ctx.tenantId, module: "north" });
  return c.json(await runScenario(ctx, c.req.param("id")));
});

northRoutes.post("/boardpacks/:id/distribute", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:boardpacks:distribute", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, z.object({ recipients: z.array(z.string().min(1).max(200)).min(1).max(100) }));
  return c.json(await distributeBoardpack(ctx, c.req.param("id"), input.recipients));
});

// Mounted before generic CRUD (index.ts), so this real assembly+render wins
// over the generated create for the same path — which would otherwise accept
// arbitrary sectionsJson/pdfFileId straight from the client with no render
// behind it. Status lands on "review", never "final": rule 4 (human-in-the-
// loop) — distribution is the consequential step (docs/modules/north.md §3),
// not assembly: approval and distribution are the two routes above.
/**
 * docs/12-security-compliance.md §5's closing claim, which was not true until
 * now: *"NORTH surfaces a live 'Compliance posture' tile for `tenant.compliance`
 * from these signals."* Every figure below is read at the moment of the request
 * — this tile is a query, not a stored score, so it cannot drift from the data
 * it describes.
 *
 * Gated on `core:audit:read`, which `tenant.compliance` holds: the posture is an
 * evidence map, and the person who reads it is the one who can already read the
 * trail behind it.
 */
northRoutes.get("/compliance-posture", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "core:audit:read", { tenantId: ctx.tenantId, module: "north" });
  const scoped = <T extends { tenantId: unknown }>(table: T) =>
    eq((table as unknown as { tenantId: never }).tenantId, ctx.tenantId as never);

  const [consents, aiRuns, disclosureRows, briefingRows, purges] = await Promise.all([
    ctx.db.select({ n: count() }).from(schema.consents).where(scoped(schema.consents)),
    ctx.db.select({ n: count() }).from(schema.aiAuditLog).where(scoped(schema.aiAuditLog)),
    ctx.db.select({ n: count() }).from(schema.disclosures).where(scoped(schema.disclosures)),
    ctx.db.select({ n: count() }).from(schema.northBriefings).where(scoped(schema.northBriefings)),
    ctx.db
      .select({ last: max(schema.retentionRuns.startedAt) })
      .from(schema.retentionRuns)
      .where(and(scoped(schema.retentionRuns), eq(schema.retentionRuns.state, "done")))
  ]);

  return c.json({
    controls: buildCompliancePosture({
      consentRows: consents[0]?.n ?? 0,
      aiAuditRows: aiRuns[0]?.n ?? 0,
      disclosures: disclosureRows[0]?.n ?? 0,
      briefings: briefingRows[0]?.n ?? 0,
      retentionCadence: ctx.policy.retention.schedule,
      lastPurgedAt: purges[0]?.last ?? null,
      // A stub screening provider is not a configured one, and the tile says so.
      screeningConfigured: Boolean(c.env.OPENSANCTIONS_API_KEY ?? c.env.OPENSANCTIONS_URL)
    })
  });
});

northRoutes.post("/boardpacks", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:boardpacks:generate", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, GenerateBoardpackBody);

  const sections = await assembleBoardpackSections(ctx, input.period);
  const tables: ReportTable[] = [sections.briefing, sections.metrics, sections.decisions];
  // CLAUDE.md §5, brand tokens not brand strings — and this footer carried
  // **`ctx.tenantId`**, so every page of a document that goes to a board named
  // the tenant by an internal id like `t_01J…`. `toPdf`'s own comment says what
  // the field is for ("e.g. the tenant name"), and the policy schedule already
  // reads it the right way (`axis-policy-document.ts:288`, whose comment says the
  // footer is "the tenant's own name, never the platform's"). This is that same
  // idiom, in the one renderer that missed it.
  const [tenant] = await ctx.db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.tenantId));
  const brand = tenant?.brandJson ? (JSON.parse(tenant.brandJson) as { name?: string }) : {};
  // `actorRef(ctx)` is `user:<id>`, which is the same defect one field over: a
  // board pack should say who asked for it, in words a board reads.
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
    meta: { Period: input.period, "Requested by": requestedBy }
  });

  const boardpackId = id("bpk", ctx.now);
  const fileId = id("file", ctx.now);
  const r2Key = `boardpacks/${ctx.tenantId}/${boardpackId}.pdf`;
  const bucket = c.env.FILES;
  if (bucket) await bucket.put(r2Key, bytes, { httpMetadata: { contentType: "application/pdf" } });

  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "north_boardpack",
    subjectRef: boardpackId,
    sha256: await sha256Hex(bytes),
    sizeBytes: bytes.length,
    contentType: "application/pdf",
    piiLevel: "none",
    createdAt: ctx.now,
    deletedAt: null
  });

  const row = {
    id: boardpackId,
    tenantId: ctx.tenantId,
    period: input.period,
    title: input.title,
    sectionsJson: JSON.stringify(tables),
    pdfFileId: bucket ? fileId : null,
    xlsxFileId: null,
    distributionLogJson: "[]",
    status: bucket ? "review" : "draft",
    approvedBy: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.northBoardpacks).values(row);
  await audit(ctx, {
    action: "north.boardpack.generate",
    subjectRef: boardpackId,
    after: { period: input.period, rows: tables.reduce((n, t) => n + t.rows.length, 0) }
  });
  await pushToActor(c.env, ctx.tenantId, ctx.actor.id, "north.boardpack.generated", { id: boardpackId }, ctx.now);

  return c.json(row, 201);
});

// The rendered pack itself. Assembly stores an R2 key; without this the board
// screen can only show that a PDF exists, which is not a board pack.
// Same idiom as ledger.ts's evidence-bundle download: gate, resolve the file
// row inside the tenant, meter the egress, stream it.
northRoutes.get("/boardpacks/:id/file", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:boardpacks:read", { tenantId: ctx.tenantId, module: "north" });
  const pack = await must(ctx, schema.northBoardpacks, c.req.param("id"), "board pack");
  if (!pack.pdfFileId) throw notFound("board pack file");

  const file = await must(ctx, schema.files, pack.pdfFileId, "board pack file");
  const object = await c.env.FILES?.get(file.r2Key);
  if (!object) throw notFound("board pack file");

  await audit(ctx, {
    action: "north.boardpack.download",
    subjectRef: pack.id,
    after: { period: pack.period, fileId: file.id }
  });
  await meterEgress(ctx, file.sizeBytes ?? object.size);
  return new Response(object.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="boardpack-${pack.period}.pdf"`,
      "cache-control": "no-store"
    }
  });
});

// Manual trigger, same idiom as orbit.ts's /renewals/sweep and staff.ts's
// /delegations/expire — RBAC-gated rather than environment-gated, so it also
// serves the 30-day compressed simulation (docs/24 sim plan) to force a
// snapshot outside index.ts's UTC 02:00-02:15 backup window.
northRoutes.post("/snapshotter/run", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:snapshots:run", { tenantId: ctx.tenantId, module: "north" });
  return c.json(await runSnapshotter(ctx));
});

/**
 * docs/19 §11.10 / docs/27 F21. A snapshotter run *computes* a figure; this is
 * where somebody *attests* to one, and it is the only writer of
 * north_snapshots.verified_at. Only a verified row may be pinned for a
 * SUCCESS-FEE (ledger_metric_pins, ADR-0111); without this the pin would be
 * a gate with nothing on the other side — a declared contract nothing routes
 * through, which is the recurring defect this repo keeps finding.
 *
 * The verifier must re-read the metric and state what they re-read it against;
 * `ref` is that evidence, and it is required rather than optional because a
 * verification with no evidence is a click.
 */
const VerifySnapshotBody = z.object({ ref: z.string().min(3).max(200) });

northRoutes.post("/snapshots/:id/verify", async (c) => {
  const ctx = ctxOf(c);
  // north:metrics:write, not snapshots:read — attesting to a figure somebody
  // will be invoiced on is a stronger act than reading it.
  require_(ctx.actor, "north:metrics:write", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, VerifySnapshotBody);
  const snapshotId = c.req.param("id");
  const [snap] = await ctx.db
    .select()
    .from(schema.northSnapshots)
    .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.id, snapshotId)))
    .limit(1);
  if (!snap) throw notFound(`snapshot ${snapshotId}`);

  await ctx.db
    .update(schema.northSnapshots)
    .set({ verifiedAt: ctx.now, verifiedBy: actorRef(ctx), verificationRef: input.ref })
    .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.id, snapshotId)));

  await audit(ctx, {
    action: "north.snapshot.verified",
    subjectRef: `north_snapshot:${snapshotId}`,
    before: { verifiedAt: snap.verifiedAt, verifiedBy: snap.verifiedBy },
    after: { verifiedAt: ctx.now, verifiedBy: actorRef(ctx), ref: input.ref, value: snap.value }
  });

  return c.json({ id: snapshotId, verifiedAt: ctx.now, verifiedBy: actorRef(ctx), verificationRef: input.ref });
});

const ExploreBody = z.object({
  metricKeys: z.array(z.string().min(1)).min(1).max(20),
  grain: z.enum(["day", "week", "month"]),
  period: z.string().min(1)
});

// Explorer: a fixed set of columns the caller can filter by, never a client
// SQL string (docs/modules/north.md). Reads north_snapshots only — the same
// semantic layer everything else in NORTH reads.
northRoutes.post("/explore", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:snapshots:read", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, ExploreBody);
  const rows = await ctx.db
    .select()
    .from(schema.northSnapshots)
    .where(
      and(
        eq(schema.northSnapshots.tenantId, ctx.tenantId),
        inArray(schema.northSnapshots.metricKey, input.metricKeys),
        eq(schema.northSnapshots.grain, input.grain),
        eq(schema.northSnapshots.period, input.period)
      )
    );
  return c.json({ rows });
});

const ForecastQuery = z.object({
  metricKey: z.string().min(1),
  grain: z.enum(["day", "month"]),
  // A horizon is bounded because the band at the far end of an unbounded one is
  // wider than the number it surrounds, and a projection nobody can act on is
  // not a forecast (docs/modules/north.md §2.4).
  horizon: z.coerce.number().int().min(1).max(36)
});

/**
 * The forecast (docs/27 F50, spec §H). Reads *closed* snapshots only — a
 * month-to-date row is a partial observation, and projecting from half a month
 * as though it were a month is F48's bug wearing a different hat — hands them
 * to the pure engine in packages/core, and answers with a band per period plus
 * the fit that produced it. No model is in this path; the gateway may narrate a
 * forecast, but the numbers are arithmetic.
 *
 * Nothing is stored. Spec §H.4 wants immutable versioned runs so a board pack
 * from March still resolves the forecast it printed, and that wants two tables;
 * this answers the question on demand from the same snapshots, deterministically
 * — the same history is the same forecast — and is the read half of that design.
 */
northRoutes.get("/forecast", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:forecasts:read", { tenantId: ctx.tenantId, module: "north" });
  const input = parse(ForecastQuery, c.req.query());

  const [metric] = await ctx.db
    .select()
    .from(schema.northMetrics)
    .where(and(eq(schema.northMetrics.tenantId, ctx.tenantId), eq(schema.northMetrics.key, input.metricKey)))
    .limit(1);
  if (!metric) throw notFound(`metric ${input.metricKey}`);

  const history = await closedHistory(ctx, input.metricKey, input.grain);
  const result = forecast(input.grain, history, input.horizon);

  return c.json({
    metricKey: metric.key,
    nameJson: metric.nameJson,
    unit: metric.unit,
    currency: metric.currency,
    horizon: input.horizon,
    // `grain` comes from the result, which is the engine's own record of what
    // it projected — one field, one writer.
    ...result
  });
});

// Journey health (docs/06 §3): each documented journey's funnel, read from the
// audit log (packages/core/src/journey-health.ts). ?days= sets the window.
northRoutes.get("/journeys", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:metrics:read", { tenantId: ctx.tenantId, module: "north" });
  const days = z.coerce.number().int().min(7).max(365).catch(30).parse(c.req.query("days"));
  return c.json({ days, data: await journeyHealth(ctx, { days }) });
});

// Data health: staleness per metric, computed live from the snapshot table —
// no separate freshness table to fall out of sync with it.
northRoutes.get("/data-health", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:metrics:read", { tenantId: ctx.tenantId, module: "north" });

  const [metrics, lastByKey] = await Promise.all([
    ctx.db.select().from(schema.northMetrics).where(eq(schema.northMetrics.tenantId, ctx.tenantId)),
    ctx.db
      .select({ metricKey: schema.northSnapshots.metricKey, lastTs: max(schema.northSnapshots.ts) })
      .from(schema.northSnapshots)
      .where(eq(schema.northSnapshots.tenantId, ctx.tenantId))
      .groupBy(schema.northSnapshots.metricKey)
  ]);
  const lastTsByKey = new Map(lastByKey.map((r) => [r.metricKey, r.lastTs as number | null]));

  return c.json({
    metrics: metrics.map((m) => {
      const lastSnapshotAt = lastTsByKey.get(m.key) ?? null;
      return {
        metricKey: m.key,
        grain: m.grain,
        lastSnapshotAt,
        staleness: lastSnapshotAt === null ? null : ctx.now - lastSnapshotAt
      };
    })
  });
});

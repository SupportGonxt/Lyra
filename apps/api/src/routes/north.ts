import { Hono } from "hono";
import { z } from "zod";
import { and, eq, inArray, max } from "drizzle-orm";
import type { ReportTable } from "@lyra/ledger";
import { id, schema } from "@lyra/db";
import { actorRef, audit, notFound, require_, sha256Hex, type Ctx } from "@lyra/core";
import { body, IsoDay } from "../http.js";
import { must } from "../rows.js";
import { meterEgress } from "../engines/egress.js";
import { generateBriefing } from "../engines/narrator.js";
import { runSnapshotter } from "../engines/north-snapshotter.js";
import { assembleBoardpackSections } from "../engines/north-boardpack.js";
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
  return c.json(result, 201);
});

const GenerateBoardpackBody = z.object({ period: z.string().min(1), title: z.string().min(1).max(200) });

// Mounted before generic CRUD (index.ts), so this real assembly+render wins
// over the generated create for the same path — which would otherwise accept
// arbitrary sectionsJson/pdfFileId straight from the client with no render
// behind it. Status lands on "review", never "final": rule 4 (human-in-the-
// loop) — distribution is the consequential step (docs/modules/north.md §3),
// not assembly, and no approval/distribution route exists yet (ADR-0017).
northRoutes.post("/boardpacks", async (c) => {
  const ctx = ctxOf(c);
  require_(ctx.actor, "north:boardpacks:generate", { tenantId: ctx.tenantId, module: "north" });
  const input = await body(c, GenerateBoardpackBody);

  const sections = await assembleBoardpackSections(ctx, input.period);
  const tables: ReportTable[] = [sections.briefing, sections.metrics, sections.decisions];
  const bytes = toPdf(tables, { footer: ctx.tenantId, meta: { Period: input.period, "Requested by": actorRef(ctx) } });

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
 * north_snapshots.verified_at. Without it the SUCCESS-FEE precondition would be
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

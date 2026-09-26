import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { ReportTable } from "@lyra/ledger";
import { id as newId, schema } from "@lyra/db";
import { actorRef, audit, badRequest, conflict, emit, notFound, type Ctx } from "@lyra/core";

export interface BoardpackSections {
  readonly briefing: ReportTable;
  readonly metrics: ReportTable;
  readonly decisions: ReportTable;
}

/**
 * Pulls the three inputs a board pack needs — the latest exec briefing's
 * highlights, the metric snapshots for the period, and the open decision log
 * — and shapes them into the same ReportTable[] toPdf already knows how to
 * draw. docs/modules/north.md §2.5's "auto-assembled from briefs, metric
 * snapshots, decision log" is exactly this join, no new rendering pipeline.
 */
export async function assembleBoardpackSections(ctx: Ctx, period: string): Promise<BoardpackSections> {
  // Board pack shows the latest exec briefing we have, not one strictly dated
  // within `period` — a briefing date (daily) and a metric period (monthly)
  // are different granularities and don't compare as strings.
  const [briefingRow] = await ctx.db
    .select({ highlightsJson: schema.northBriefings.highlightsJson })
    .from(schema.northBriefings)
    .where(and(eq(schema.northBriefings.tenantId, ctx.tenantId), eq(schema.northBriefings.audience, "exec")))
    .orderBy(desc(schema.northBriefings.date))
    .limit(1);

  const highlights: Array<{ metricKey: string; deltaBps: number; note?: string }> = briefingRow?.highlightsJson
    ? JSON.parse(briefingRow.highlightsJson)
    : [];

  const briefing: ReportTable = {
    title: "Executive briefing highlights",
    columns: [
      { key: "metricKey", label: "Metric", kind: "text" },
      { key: "deltaBps", label: "Delta (bps)", kind: "number" },
      { key: "note", label: "Note", kind: "text" }
    ],
    rows: highlights.map((h) => ({ metricKey: h.metricKey, deltaBps: h.deltaBps, note: h.note ?? "" })),
    generatedAt: ctx.now
  };

  const snapshotRows = await ctx.db
    .select({
      metricKey: schema.northSnapshots.metricKey,
      period: schema.northSnapshots.period,
      value: schema.northSnapshots.value
    })
    .from(schema.northSnapshots)
    .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.period, period)));

  const metrics: ReportTable = {
    title: "Metric snapshot",
    columns: [
      { key: "metricKey", label: "Metric", kind: "text" },
      { key: "period", label: "Period", kind: "text" },
      { key: "value", label: "Value", kind: "number" }
    ],
    rows: snapshotRows,
    generatedAt: ctx.now
  };

  const decisionRows = await ctx.db
    .select({
      title: schema.northDecisions.title,
      owner: schema.northDecisions.owner,
      status: schema.northDecisions.status,
      reviewAt: schema.northDecisions.reviewAt
    })
    .from(schema.northDecisions)
    .where(and(eq(schema.northDecisions.tenantId, ctx.tenantId), eq(schema.northDecisions.status, "open")));

  const decisions: ReportTable = {
    title: "Open decisions",
    columns: [
      { key: "title", label: "Decision", kind: "text" },
      { key: "owner", label: "Owner", kind: "text" },
      { key: "status", label: "Status", kind: "text" },
      { key: "reviewAt", label: "Review by", kind: "date" }
    ],
    rows: decisionRows,
    generatedAt: ctx.now
  };

  return { briefing, metrics, decisions };
}

/* ------------------------------------------------------ approve, distribute */

type BoardpackRow = typeof schema.northBoardpacks.$inferSelect;

async function packOf(ctx: Ctx, boardpackId: string): Promise<BoardpackRow> {
  const [pack] = await ctx.db
    .select()
    .from(schema.northBoardpacks)
    .where(and(eq(schema.northBoardpacks.tenantId, ctx.tenantId), eq(schema.northBoardpacks.id, boardpackId)))
    .limit(1);
  if (!pack) throw notFound("board pack");
  return pack;
}

/**
 * docs/30 NORTH 5, rule 4. A rendered pack waits in review until a person signs
 * it off; approval moves it to final. A draft has no file behind it, so there
 * is nothing to approve.
 */
export async function approveBoardpack(ctx: Ctx, boardpackId: string): Promise<BoardpackRow> {
  const pack = await packOf(ctx, boardpackId);
  if (pack.status !== "review") throw conflict(`a board pack in ${pack.status} cannot be approved; only one in review`);
  const patch = { status: "final", approvedBy: actorRef(ctx), updatedAt: ctx.now };
  await ctx.db.update(schema.northBoardpacks).set(patch).where(eq(schema.northBoardpacks.id, pack.id));
  await audit(ctx, { action: "north.boardpack.approve", subjectRef: pack.id, before: { status: pack.status }, after: patch });
  return { ...pack, ...patch };
}

/**
 * Sends an approved pack to named people in this tenant: one notice each, and
 * a line in the pack's distribution log — who, when, by whom, which file. A
 * person already on the log is not told twice. The log is what a board
 * secretary is asked to produce; the notice is how the reader finds the pack.
 */
export async function distributeBoardpack(ctx: Ctx, boardpackId: string, recipients: readonly string[]): Promise<BoardpackRow> {
  const pack = await packOf(ctx, boardpackId);
  if (pack.status !== "final" && pack.status !== "distributed") {
    throw conflict("only an approved board pack can be distributed");
  }
  // A person is named by id or by email — whichever the sender has to hand.
  const asked = [...new Set(recipients.map((r) => r.trim()).filter(Boolean))];
  const people = asked.length
    ? await ctx.db
        .select({ id: schema.users.id, email: schema.users.email })
        .from(schema.users)
        .where(and(eq(schema.users.tenantId, ctx.tenantId), or(inArray(schema.users.id, asked), inArray(schema.users.email, asked))))
    : [];
  const strangers = asked.filter((r) => !people.some((p) => p.id === r || p.email === r));
  if (strangers.length || !asked.length) {
    throw badRequest(`not people in this tenant: ${strangers.join(", ") || "none named"}`, { recipients: "unknown person" });
  }
  const wanted = [...new Set(asked.map((r) => people.find((p) => p.id === r || p.email === r)!.id))];

  const log = JSON.parse(pack.distributionLogJson ?? "[]") as { to: string; at: number; by: string; fileId: string | null }[];
  const already = new Set(log.map((line) => line.to));
  const fresh = wanted.filter((id) => !already.has(id));
  const by = actorRef(ctx);
  const lines = fresh.map((to) => ({ to, at: ctx.now, by, fileId: pack.pdfFileId }));
  if (fresh.length) {
    await ctx.db.insert(schema.notifications).values(
      fresh.map((userId) => ({
        id: newId("ntf", ctx.now),
        tenantId: ctx.tenantId,
        userId,
        kind: "info",
        titleKey: "north.boardpack.distributed",
        paramsJson: JSON.stringify({ title: pack.title, period: pack.period }),
        subjectRef: pack.id,
        readAt: null,
        createdAt: ctx.now
      }))
    );
  }
  const patch = { status: "distributed", distributionLogJson: JSON.stringify([...log, ...lines]), updatedAt: ctx.now };
  await ctx.db.update(schema.northBoardpacks).set(patch).where(eq(schema.northBoardpacks.id, pack.id));
  await audit(ctx, { action: "north.boardpack.distribute", subjectRef: pack.id, after: { to: fresh } });
  if (pack.status === "final") {
    await emit(ctx, { module: "north", type: "north.boardpack.distributed", subject: pack.id, data: { id: pack.id, period: pack.period, recipients: fresh.length } });
  }
  return { ...pack, ...patch };
}

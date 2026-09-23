import { Hono } from "hono";
import { desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { id, schema } from "@lyra/db";
import {
  actorRef,
  audit,
  badRequest,
  can,
  conflict,
  forbidden,
  gate,
  mask,
  notFound,
  require_,
  ReportDefinitionSchema,
  ReportFilterSchema,
  scoped,
  sha256Hex,
  withIdempotency,
  type Ctx,
  type PiiMap
} from "@lyra/core";
import {
  DATASETS,
  MAX_ROWS,
  feedPiiColumns,
  feedRows,
  runReport,
  totalsOf,
  type Dataset,
  type ReportDefinition,
  type RunResult
} from "../engines/report.js";
import { render, type BrowserBinding, type Rendered } from "../engines/export/render.js";
import { meterEgress } from "../engines/egress.js";
import { grantsFor } from "../auth.js";
import { body, decodeCursor, encodeCursor, instantParam, InstantMsParam, listParams, parse, MAX_PAGE } from "../http.js";
import { must } from "../rows.js";
import type { App } from "../env.js";

// docs/09. Reporting that a finance team will actually accept: a definition it
// can read, a run it can repeat, and a file it can attach to an email. The
// engine is in engines/report.ts; this file is permissions, persistence and
// bytes — the three things the engine deliberately does not know about.

export const analyticsRoutes = new Hono<App>();

/* ------------------------------------------------------------- semantic layer */

/** What a report builder can offer the user. Derived, never hand-maintained. */
analyticsRoutes.get("/datasets", (c) => {
  const ctx = c.get("ctx");
  const data = Object.entries(DATASETS)
    .filter(([, ds]) => can(ctx.actor, ds.permission, { tenantId: ctx.tenantId, module: ds.module }))
    .map(([key, ds]) => ({
      key,
      module: ds.module,
      timeColumn: ds.timeColumn,
      dimensions: Object.entries(ds.dimensions).map(([k, d]) => ({ key: k, label: d.label, kind: d.kind, pii: Boolean(d.pii) })),
      metrics: Object.entries(ds.metrics).map(([k, m]) => ({ key: k, label: m.label, kind: m.kind, agg: m.agg }))
    }));
  return c.json({ data });
});

/* -------------------------------------------------------------------- reports */

// One schema for every reader of a definition, the ask purpose included
// (packages/core/src/report-definition.ts).
const Filter = ReportFilterSchema;
const Definition = ReportDefinitionSchema;

const ReportBody = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/),
  module: z.string().min(1).max(32),
  name: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()).optional(),
  definition: Definition,
  piiLevel: z.enum(["none", "low", "high"]).default("none"),
  scope: z.enum(["tenant", "team", "personal"]).default("tenant")
});

analyticsRoutes.get("/reports", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:read", { tenantId: ctx.tenantId });
  const { list } = listParams(c);
  const rows = await ctx.db
    .select()
    .from(schema.reports)
    .where(
      scoped(
        ctx,
        schema.reports,
        // Personal reports belong to their owner; tenant and team scopes are shared.
        or(eq(schema.reports.scope, "tenant"), eq(schema.reports.scope, "team"), eq(schema.reports.ownerRef, actorRef(ctx)))
      )
    )
    .orderBy(desc(schema.reports.updatedAt))
    .limit(list.limit);
  return c.json({
    data: rows
      .filter((r) => can(ctx.actor, r.requiredPermission, { tenantId: ctx.tenantId, module: r.module }))
      .map(reportView)
  });
});

analyticsRoutes.post("/reports", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:write", { tenantId: ctx.tenantId });
  const input = await body(c, ReportBody);
  const ds = DATASETS[input.definition.dataset];
  if (!ds) throw badRequest(`unknown dataset ${input.definition.dataset}`);
  // The report inherits the dataset's permission rather than accepting one from
  // the caller — otherwise a report is a way to relabel data as less sensitive.
  const row = {
    id: id("rep", ctx.now),
    tenantId: ctx.tenantId,
    key: input.key,
    module: ds.module,
    nameJson: JSON.stringify(input.name),
    descriptionJson: input.description ? JSON.stringify(input.description) : null,
    definitionJson: JSON.stringify(input.definition),
    piiLevel: input.piiLevel,
    requiredPermission: ds.permission,
    ownerRef: actorRef(ctx),
    scope: input.scope,
    system: false,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    deletedAt: null
  };
  await ctx.db.insert(schema.reports).values(row);
  await audit(ctx, { action: "analytics.report.create", subjectRef: row.id, after: row });
  return c.json(reportView(row), 201);
});

analyticsRoutes.get("/reports/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:read", { tenantId: ctx.tenantId });
  return c.json(reportView(await readableReport(ctx, c.req.param("id"))));
});

analyticsRoutes.patch("/reports/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:write", { tenantId: ctx.tenantId });
  const before = await readableReport(ctx, c.req.param("id"));
  if (before.system) throw conflict("a system report cannot be edited; clone it first");
  const input = await body(c, ReportBody.partial());

  const patch: Record<string, unknown> = { updatedAt: ctx.now };
  if (input.name) patch.nameJson = JSON.stringify(input.name);
  if (input.description) patch.descriptionJson = JSON.stringify(input.description);
  if (input.piiLevel) patch.piiLevel = input.piiLevel;
  if (input.scope) patch.scope = input.scope;
  if (input.definition) {
    const ds = DATASETS[input.definition.dataset];
    if (!ds) throw badRequest(`unknown dataset ${input.definition.dataset}`);
    patch.definitionJson = JSON.stringify(input.definition);
    patch.module = ds.module;
    patch.requiredPermission = ds.permission;
  }
  await ctx.db.update(schema.reports).set(patch).where(scoped(ctx, schema.reports, eq(schema.reports.id, before.id)));
  await audit(ctx, { action: "analytics.report.update", subjectRef: before.id, before, after: patch });
  return c.json(reportView({ ...before, ...patch } as typeof before));
});

analyticsRoutes.delete("/reports/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:write", { tenantId: ctx.tenantId });
  const row = await readableReport(ctx, c.req.param("id"));
  if (row.system) throw conflict("a system report cannot be deleted");
  await ctx.db
    .update(schema.reports)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(scoped(ctx, schema.reports, eq(schema.reports.id, row.id)));
  await audit(ctx, { action: "analytics.report.delete", subjectRef: row.id, before: row });
  return c.body(null, 204);
});

/* ----------------------------------------------------------------------- runs */

const RunBody = z.object({
  /** Overrides merged over the stored definition — the "same report, last week" case. */
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  filters: z.array(Filter).max(20).optional(),
  grain: z.enum(["none", "day", "week", "month", "quarter", "year"]).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  totals: z.boolean().default(true)
});

analyticsRoutes.post("/reports/:id/run", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:run", { tenantId: ctx.tenantId });
  const report = await readableReport(ctx, c.req.param("id"));
  const overrides = await body(c, RunBody);
  const def = mergeDefinition(report.definitionJson, overrides);
  const { result, runId } = await materialise(ctx, def, { reportId: report.id, title: labelOf(report.nameJson, ctx.locale) });
  return c.json({ runId, ...result, ...(overrides.totals ? { totals: totalsOf(result) } : {}) }, 201);
});

/** Ad-hoc: build a definition in the UI and run it without saving. */
analyticsRoutes.post("/run", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:run", { tenantId: ctx.tenantId });
  const input = await body(c, Definition.extend({ totals: z.boolean().default(true) }));
  const { totals, ...def } = input;
  requireDataset(ctx, def.dataset);
  const { result, runId } = await materialise(ctx, def, {});
  return c.json({ runId, ...result, ...(totals ? { totals: totalsOf(result) } : {}) }, 201);
});

analyticsRoutes.get("/runs/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:read", { tenantId: ctx.tenantId });
  const run = await must(ctx, schema.reportRuns, c.req.param("id"), "run");
  // A run carries the definition it ran, so it inherits its report's gate. An
  // ad-hoc run belongs to whoever asked for it — there is no report to ask.
  if (run.reportId === "adhoc") {
    if (run.requestedBy !== actorRef(ctx)) throw notFound("run");
  } else {
    await readableReport(ctx, run.reportId);
  }
  return c.json(run);
});

/* -------------------------------------------------------------------- exports */

const ExportBody = z.object({
  format: z.enum(["xlsx", "pdf", "csv", "json"]),
  reportId: z.string().optional(),
  definition: Definition.optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  filters: z.array(Filter).max(20).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
  totals: z.boolean().default(true),
  /** Ask for real identifiers instead of masked ones. Dual control, always. */
  unmasked: z.boolean().default(false),
  piiJustification: z.string().min(10).max(500).optional(),
  orientation: z.enum(["portrait", "landscape"]).optional()
});

analyticsRoutes.post("/exports", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:exports:create", { tenantId: ctx.tenantId });
  const input = await body(c, ExportBody);

  let def: ReportDefinition;
  let title = "Export";
  let reportId: string | null = null;
  if (input.reportId) {
    const report = await readableReport(ctx, input.reportId);
    def = mergeDefinition(report.definitionJson, input);
    title = labelOf(report.nameJson, ctx.locale);
    reportId = report.id;
  } else if (input.definition) {
    def = { ...input.definition, ...(input.filters ? { filters: input.filters } : {}) };
    requireDataset(ctx, def.dataset);
    title = `${def.dataset} export`;
  } else {
    throw badRequest("an export needs either reportId or definition");
  }

  // Unmasking is the one thing here that can turn a report into a data breach,
  // so it needs the permission, a written reason, and a second person.
  let approvedBy: string | null = null;
  if (input.unmasked) {
    require_(ctx.actor, "analytics:exports:unmasked", { tenantId: ctx.tenantId });
    if (!input.piiJustification) throw badRequest("an unmasked export needs piiJustification");
    const approval = await gate(ctx, {
      policyKey: "core.unmasked_export",
      subjectRef: reportId ?? `dataset:${def.dataset}`,
      context: { reason: input.piiJustification, format: input.format, dataset: def.dataset }
    });
    approvedBy = approval?.id ?? "auto";
  }

  const { result, runId } = await materialise(ctx, def, {
    ...(reportId ? { reportId } : {}),
    title,
    unmasked: input.unmasked
  });
  const totals = input.totals ? totalsOf(result) : undefined;

  // Watermark every unmasked artefact with who asked and when. A leaked PDF that
  // names its recipient is traceable; an anonymous one is not.
  const watermark = input.unmasked ? `${actorRef(ctx)} · ${new Date(ctx.now).toISOString().slice(0, 19)}` : undefined;
  const rendered = await render(
    input.format,
    result,
    {
      ...(totals ? { totals } : {}),
      ...(watermark ? { watermark } : {}),
      ...(input.orientation ? { orientation: input.orientation } : {}),
      meta: { "Requested by": actorRef(ctx), Rows: String(result.rowCount), ...(input.unmasked ? { Access: "UNMASKED" } : {}) }
    },
    c.env.BROWSER
  );

  const row = await storeExport(ctx, c.env.FILES, {
    runId,
    reportId,
    format: input.format,
    rendered,
    rowCount: result.rowCount,
    unmasked: input.unmasked,
    piiJustification: input.piiJustification ?? null,
    watermark: watermark ?? null,
    approvedBy
  });
  await audit(ctx, {
    action: "analytics.export.create",
    subjectRef: row.id,
    after: { format: input.format, rows: result.rowCount, unmasked: input.unmasked, reportId }
  });
  return c.json(row, 201);
});

analyticsRoutes.get("/exports", async (c) => {
  const ctx = c.get("ctx");
  // Reading the register is not creating an export; `:download` is the gate that
  // matches what comes back, and it is the gate the download itself uses.
  require_(ctx.actor, "analytics:exports:download", { tenantId: ctx.tenantId });
  const { list } = listParams(c);
  const mine = can(ctx.actor, "core:audit:read", { tenantId: ctx.tenantId })
    ? undefined
    : eq(schema.analyticsExports.requestedBy, actorRef(ctx));
  const rows = await ctx.db
    .select()
    .from(schema.analyticsExports)
    .where(scoped(ctx, schema.analyticsExports, mine))
    .orderBy(desc(schema.analyticsExports.createdAt))
    .limit(list.limit);
  return c.json({ data: rows });
});

analyticsRoutes.get("/exports/:id/download", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:exports:download", { tenantId: ctx.tenantId });
  const row = await must(ctx, schema.analyticsExports, c.req.param("id"), "export");
  // The same rule the register narrows on. Holding `:download` is permission to
  // fetch your own artefacts, not everyone else's by id.
  if (!(await exportVisible(ctx, row))) throw notFound("export");
  if (row.state !== "ready" || !row.fileId) throw notFound("export file");
  if (row.expiresAt && row.expiresAt < ctx.now) throw notFound("export file");
  // An unmasked export is readable only by the person who justified it, or by
  // someone who could have approved it.
  if (!row.piiMasked && row.requestedBy !== actorRef(ctx)) {
    require_(ctx.actor, "analytics:exports:unmasked", { tenantId: ctx.tenantId });
  }

  const file = await must(ctx, schema.files, row.fileId, "file");
  const bucket = c.env.FILES;
  const object = bucket ? await bucket.get(file.r2Key) : null;
  if (!object) throw notFound("export file");

  await ctx.db
    .update(schema.analyticsExports)
    .set({ downloadCount: row.downloadCount + 1, updatedAt: ctx.now })
    .where(scoped(ctx, schema.analyticsExports, eq(schema.analyticsExports.id, row.id)));
  // Every download of a PII artefact is an audit event, not a metric.
  await audit(ctx, { action: "analytics.export.download", subjectRef: row.id, after: { piiMasked: row.piiMasked } });
  await meterEgress(ctx, file.sizeBytes ?? object.size);

  return new Response(object.body, {
    headers: {
      "content-type": file.contentType ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${row.id}.${row.format}"`,
      "cache-control": "no-store"
    }
  });
});

/* ---------------------------------------------------------- warehouse feed */

const FeedQuery = z.object({
  /** Epoch-ms watermark on the dataset's time column, for the first poll. */
  since: InstantMsParam.optional(),
  /** Opaque keyset cursor; preferred over `since` once a poll has run once. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(MAX_PAGE)
});

/**
 * ANL-010. Row-level, incremental, tenant-scoped NDJSON for a warehouse or a BI
 * tool. Read `x-lyra-cursor` and pass it back as `?cursor=` until `x-lyra-more`
 * is false; keep the last cursor and resume from it on the next poll. Masked
 * exactly like every other read — a warehouse is not an exemption from docs/06.
 */
analyticsRoutes.get("/feed/:dataset", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:exports:create", { tenantId: ctx.tenantId });
  const ds = requireDataset(ctx, c.req.param("dataset"));
  const q = parse(FeedQuery, c.req.query());

  const after = q.cursor ? decodeCursor(q.cursor) : undefined;
  const { rows, more } = await feedRows(ctx, c.req.param("dataset"), {
    since: q.since,
    after: after ? { value: Number(after.value), id: after.id } : undefined,
    limit: q.limit
  });

  // Identifiers a report would pseudonymise are masked here too; `mask` is a
  // no-op for a caller holding core:pii:view.
  const piiMap: PiiMap = Object.fromEntries(feedPiiColumns(ds).map((col) => [col, "id" as const]));
  const safe = Object.keys(piiMap).length ? mask(ctx.actor, rows, piiMap, ctx.tenantId) : rows;

  const last = safe[safe.length - 1];
  const cursor = last ? encodeCursor(Number(last[ds.timeColumn]), String(last.id)) : q.cursor;
  await audit(ctx, {
    action: "analytics.feed.read",
    subjectRef: `dataset:${c.req.param("dataset")}`,
    after: { rows: safe.length, since: q.since ?? null, more }
  });

  return new Response(safe.map((r) => JSON.stringify(r)).join("\n") + (safe.length ? "\n" : ""), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "x-lyra-more": String(more),
      ...(cursor ? { "x-lyra-cursor": cursor } : {}),
      "cache-control": "no-store"
    }
  });
});

/* ------------------------------------------------------------------ schedules */

const ScheduleBody = z.object({
  reportId: z.string().optional(),
  dashboardId: z.string().optional(),
  name: z.record(z.string(), z.string()),
  cron: z.string().min(9).max(64),
  // No default: the tenant's own zone is the right one, and a code literal
  // here fired a South African broker's report on Gulf wall-clock. Resolved
  // below against tenant policy, UTC only when the tenant has none either.
  timezone: z.string().min(3).max(64).optional(),
  format: z.enum(["xlsx", "pdf", "csv", "json"]).default("pdf"),
  recipients: z.array(z.string().min(3).max(200)).min(1).max(50),
  params: z.record(z.string(), z.unknown()).optional(),
  locale: z.enum(["en", "ar"]).default("en"),
  status: z.enum(["active", "paused"]).default("active")
});

analyticsRoutes.get("/schedules", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:schedules:read", { tenantId: ctx.tenantId });
  const rows = await ctx.db
    .select()
    .from(schema.analyticsSchedules)
    .where(scoped(ctx, schema.analyticsSchedules))
    .orderBy(desc(schema.analyticsSchedules.updatedAt))
    .limit(200);
  return c.json({ data: rows });
});

analyticsRoutes.post("/schedules", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:schedules:write", { tenantId: ctx.tenantId });
  const input = await body(c, ScheduleBody);
  // deliverSchedule renders reports only — a dashboard-only schedule would be
  // accepted here and then fail + alert its owner on every fire, forever.
  if (!input.reportId) throw badRequest("dashboard schedules are not supported yet: a schedule needs a reportId");
  await readableReport(ctx, input.reportId);
  // What this tenant's business day runs on — the same field the screens
  // render timestamps in (apps/web/app/session.server.ts), so the scheduler
  // and the screen agree about which day a cutoff falls on.
  const timezone = input.timezone ?? ctx.policy.timezone ?? "UTC";
  const next = nextRun(input.cron, ctx.now, timezone);

  const row = {
    id: id("sch", ctx.now),
    tenantId: ctx.tenantId,
    reportId: input.reportId ?? null,
    dashboardId: input.dashboardId ?? null,
    nameJson: JSON.stringify(input.name),
    cron: input.cron,
    timezone,
    format: input.format,
    // Delivery is consent-checked at send time (docs/12 §4); storing an address
    // here is not permission to mail it.
    recipientsJson: JSON.stringify(input.recipients),
    paramsJson: input.params ? JSON.stringify(input.params) : null,
    locale: input.locale,
    status: input.status,
    lastRunAt: null,
    lastState: null,
    nextRunAt: next,
    createdBy: actorRef(ctx),
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.analyticsSchedules).values(row);
  await audit(ctx, { action: "analytics.schedule.create", subjectRef: row.id, after: row });
  return c.json(row, 201);
});

analyticsRoutes.post("/schedules/:id/pause", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:schedules:write", { tenantId: ctx.tenantId });
  const row = await must(ctx, schema.analyticsSchedules, c.req.param("id"), "schedule");
  await ctx.db
    .update(schema.analyticsSchedules)
    .set({ status: "paused", nextRunAt: null, updatedAt: ctx.now })
    .where(scoped(ctx, schema.analyticsSchedules, eq(schema.analyticsSchedules.id, row.id)));
  await audit(ctx, { action: "analytics.schedule.pause", subjectRef: row.id });
  return c.body(null, 204);
});

analyticsRoutes.post("/schedules/:id/resume", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:schedules:write", { tenantId: ctx.tenantId });
  const row = await must(ctx, schema.analyticsSchedules, c.req.param("id"), "schedule");
  await ctx.db
    .update(schema.analyticsSchedules)
    .set({ status: "active", nextRunAt: nextRun(row.cron, ctx.now, row.timezone), updatedAt: ctx.now })
    .where(scoped(ctx, schema.analyticsSchedules, eq(schema.analyticsSchedules.id, row.id)));
  await audit(ctx, { action: "analytics.schedule.resume", subjectRef: row.id });
  return c.body(null, 204);
});

analyticsRoutes.delete("/schedules/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:schedules:write", { tenantId: ctx.tenantId });
  const row = await must(ctx, schema.analyticsSchedules, c.req.param("id"), "schedule");
  await ctx.db.delete(schema.analyticsSchedules).where(scoped(ctx, schema.analyticsSchedules, eq(schema.analyticsSchedules.id, row.id)));
  await audit(ctx, { action: "analytics.schedule.delete", subjectRef: row.id, before: row });
  return c.body(null, 204);
});

/* ----------------------------------------------------------------- dashboards */

const DashboardBody = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/),
  module: z.string().min(1).max(32),
  name: z.record(z.string(), z.string()),
  layout: z.object({
    tiles: z
      .array(
        z.object({
          key: z.string().min(1).max(64),
          viz: z.enum(["number", "line", "bar", "table", "donut", "list"]),
          span: z.number().int().min(1).max(12).default(4),
          reportId: z.string().optional(),
          definition: Definition.optional()
        })
      )
      .max(24)
  }),
  scope: z.enum(["tenant", "team", "personal"]).default("tenant"),
  roles: z.array(z.string()).max(30).optional(),
  isDefault: z.boolean().default(false)
});

analyticsRoutes.get("/dashboards", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:dashboards:read", { tenantId: ctx.tenantId });
  const rows = await ctx.db
    .select()
    .from(schema.dashboards)
    .where(scoped(ctx, schema.dashboards))
    .orderBy(desc(schema.dashboards.isDefault))
    .limit(200);
  return c.json({ data: rows.filter((r) => dashboardVisible(ctx, r)) });
});

analyticsRoutes.post("/dashboards", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:dashboards:write", { tenantId: ctx.tenantId });
  const input = await body(c, DashboardBody);
  for (const tile of input.layout.tiles) {
    if (tile.definition) requireDataset(ctx, tile.definition.dataset);
  }
  const row = {
    id: id("dsh", ctx.now),
    tenantId: ctx.tenantId,
    key: input.key,
    module: input.module,
    nameJson: JSON.stringify(input.name),
    layoutJson: JSON.stringify(input.layout),
    scope: input.scope,
    ownerRef: actorRef(ctx),
    rolesJson: input.roles ? JSON.stringify(input.roles) : null,
    isDefault: input.isDefault,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.dashboards).values(row);
  await audit(ctx, { action: "analytics.dashboard.create", subjectRef: row.id, after: row });
  return c.json(row, 201);
});

/** One call paints the whole dashboard — a tile per round trip is a slow page. */
analyticsRoutes.get("/dashboards/:id/data", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:dashboards:read", { tenantId: ctx.tenantId });
  const dash = await must(ctx, schema.dashboards, c.req.param("id"), "dashboard");
  // The same rule the list applies. Without it a board-only dashboard is readable
  // by anyone who can guess its id — a filter that lives only on the list is not
  // a filter at all.
  if (!dashboardVisible(ctx, dash)) throw notFound("dashboard");
  const layout = JSON.parse(dash.layoutJson) as { tiles: { key: string; reportId?: string; definition?: ReportDefinition }[] };

  const tiles = await Promise.all(
    layout.tiles.map(async (tile) => {
      try {
        const def = tile.definition
          ? tile.definition
          : tile.reportId
            ? (JSON.parse((await readableReport(ctx, tile.reportId)).definitionJson) as ReportDefinition)
            : null;
        if (!def) return { key: tile.key, error: "tile has no definition" };
        requireDataset(ctx, def.dataset);
        const table = await runReport(ctx, def, { title: tile.key });
        return { key: tile.key, table, totals: totalsOf(table) };
      } catch (err) {
        // One dead tile must not blank the dashboard.
        return { key: tile.key, error: err instanceof Error ? err.message : "failed" };
      }
    })
  );
  return c.json({ id: dash.id, key: dash.key, layout, tiles, generatedAt: ctx.now });
});

/* ---------------------------------------------------------------- saved views */

const SavedViewBody = z.object({
  route: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  query: z.record(z.string(), z.unknown()),
  columns: z.array(z.string()).max(60).optional(),
  isDefault: z.boolean().default(false),
  shared: z.boolean().default(false)
});

analyticsRoutes.get("/saved-views", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:saved_views:read", { tenantId: ctx.tenantId });
  const route = c.req.query("route");
  const rows = await ctx.db
    .select()
    .from(schema.savedViews)
    .where(
      scoped(
        ctx,
        schema.savedViews,
        route ? eq(schema.savedViews.route, route) : undefined,
        or(isNull(schema.savedViews.userId), eq(schema.savedViews.userId, ctx.actor.id))
      )
    )
    .orderBy(desc(schema.savedViews.isDefault))
    .limit(200);
  return c.json({ data: rows });
});

analyticsRoutes.post("/saved-views", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:saved_views:write", { tenantId: ctx.tenantId });
  const input = await body(c, SavedViewBody);
  const row = {
    id: id("sv", ctx.now),
    tenantId: ctx.tenantId,
    userId: input.shared ? null : ctx.actor.id,
    route: input.route,
    name: input.name,
    queryJson: JSON.stringify(input.query),
    columnsJson: input.columns ? JSON.stringify(input.columns) : null,
    isDefault: input.isDefault,
    sharedWithJson: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.savedViews).values(row);
  return c.json(row, 201);
});

analyticsRoutes.delete("/saved-views/:id", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:saved_views:write", { tenantId: ctx.tenantId });
  const row = await must(ctx, schema.savedViews, c.req.param("id"), "saved view");
  if (row.userId && row.userId !== ctx.actor.id) throw forbidden("analytics:saved_views:write");
  await ctx.db.delete(schema.savedViews).where(scoped(ctx, schema.savedViews, eq(schema.savedViews.id, row.id)));
  return c.body(null, 204);
});

/* ------------------------------------------------------------ unit economics */

/** Cost per outcome (NFR-013). The number that says whether AI is paying for itself. */
analyticsRoutes.get("/unit-economics", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:read", { tenantId: ctx.tenantId });
  // `instantParam` 400s on NaN and on an instant no `Date` can hold; a NaN here
  // would otherwise silently drop the filter and ship the full table. The
  // non-negative floor is this endpoint's own: cost accrues after the epoch.
  const since = instantParam(c.req.query("since")) ?? 0;
  if (since < 0) throw badRequest("since must be a non-negative epoch-ms number");
  const rows = await ctx.db
    .select()
    .from(schema.unitEconomics)
    .where(scoped(ctx, schema.unitEconomics, since ? sql`${schema.unitEconomics.updatedAt} >= ${since}` : undefined))
    .orderBy(desc(schema.unitEconomics.day))
    .limit(1000);

  const data = rows.map((r) => {
    const cost = r.aiCostMicro + r.mediaCostMicro;
    return {
      ...r,
      // Micro-units to minor units: 1_000_000 micro = 1 major = 100 minor.
      costMinor: Math.round(cost / 10_000),
      costPerUnitMinor: r.volume ? Math.round(cost / 10_000 / r.volume) : null,
      marginMinor: r.revenueMinor - Math.round(cost / 10_000)
    };
  });
  return c.json({ data });
});

/** Storage and egress bytes (docs/25 §6 cost guards). Storage is the live sum
 *  of core_files; egress is the daily counter meterEgress() maintains. */
analyticsRoutes.get("/usage", async (c) => {
  const ctx = c.get("ctx");
  require_(ctx.actor, "analytics:reports:read", { tenantId: ctx.tenantId });
  const totals = await ctx.db
    .select({ storageBytes: sql<number>`coalesce(sum(${schema.files.sizeBytes}), 0)` })
    .from(schema.files)
    .where(scoped(ctx, schema.files));
  const egress = await ctx.db
    .select()
    .from(schema.egressDays)
    .where(scoped(ctx, schema.egressDays))
    .orderBy(desc(schema.egressDays.day))
    .limit(30);
  return c.json({
    data: {
      storageBytes: totals[0]?.storageBytes ?? 0,
      egressDays: egress.map((r) => ({ day: r.day, bytes: r.bytes }))
    }
  });
});

/* ------------------------------------------------------------------- helpers */

async function readableReport(ctx: Ctx, reportId: string): Promise<typeof schema.reports.$inferSelect> {
  const row = await must(ctx, schema.reports, reportId, "report");
  // The report's own permission is the gate — `analytics:reports:read` gets you
  // the list, not the contents of a report about a module you cannot see.
  // `require_` first so a missing permission still reads as 403 on the module
  // routes; `reportVisible` then owns the rule, so this and generic CRUD agree.
  require_(ctx.actor, row.requiredPermission, { tenantId: ctx.tenantId, module: row.module });
  if (!reportVisible(ctx, row)) throw notFound("report");
  return row;
}

/**
 * Row-level visibility for a report. Generic CRUD reaches this through
 * `Resource.rowVisible`, where a hidden row is a 404; the module routes reach
 * the same rule through `readableReport`.
 */
export function reportVisible(ctx: Ctx, row: typeof schema.reports.$inferSelect): boolean {
  if (!can(ctx.actor, row.requiredPermission, { tenantId: ctx.tenantId, module: row.module })) {
    return false;
  }
  return row.scope !== "personal" || row.ownerRef === actorRef(ctx);
}

/** Can this actor see the report behind an artefact? A missing report hides it. */
async function reportReadable(ctx: Ctx, reportId: string): Promise<boolean> {
  const [report] = await ctx.db
    .select()
    .from(schema.reports)
    .where(scoped(ctx, schema.reports, eq(schema.reports.id, reportId)))
    .limit(1);
  return report ? reportVisible(ctx, report) : false;
}

/** A run is as visible as the report it ran — the payload is that report's data. */
export async function reportRunVisible(
  ctx: Ctx,
  row: typeof schema.reportRuns.$inferSelect
): Promise<boolean> {
  return reportReadable(ctx, row.reportId);
}

/** A saved view with no `userId` is the tenant's; one with a `userId` is that person's. */
export function savedViewVisible(ctx: Ctx, row: typeof schema.savedViews.$inferSelect): boolean {
  return row.userId === null || row.userId === ctx.actor.id;
}

/**
 * Row-level visibility for a dashboard, shared by the list and by every read of
 * one dashboard. A `roles` list narrows visibility; no list means "anyone who
 * can read dashboards". A personal dashboard belongs to its owner.
 */
export function dashboardVisible(ctx: Ctx, row: typeof schema.dashboards.$inferSelect): boolean {
  if (row.scope === "personal" && row.ownerRef !== actorRef(ctx)) return false;
  const allowed = row.rolesJson ? (JSON.parse(row.rolesJson) as string[]) : null;
  if (!allowed?.length) return true;
  return allowed.some((role) => ctx.actor.grants.some((g) => g.roleKey === role));
}

/**
 * Row-level visibility for an export, shared by the register and the download.
 * Your own exports, plus everything if you can read the audit trail — the same
 * two clauses `GET /exports` narrows on in SQL. A scheduled artefact is
 * requested by the scheduler, so its recipients are recognised by the inbox row
 * that delivered it (ANL-012) rather than by a permission nobody would hold.
 */
export async function exportVisible(ctx: Ctx, row: typeof schema.analyticsExports.$inferSelect): Promise<boolean> {
  if (can(ctx.actor, "core:audit:read", { tenantId: ctx.tenantId })) return true;
  // The artefact is the report's data, so the report's own permission gates it —
  // checked before the clauses below, because neither having asked for the file
  // nor having been sent it is authority to read it. A requester who has since
  // lost the role, and a schedule recipient who never held it, both stop here.
  if (row.reportId && !(await reportReadable(ctx, row.reportId))) return false;
  if (row.requestedBy === actorRef(ctx)) return true;
  const delivered = await ctx.db
    .select({ id: schema.notifications.id })
    .from(schema.notifications)
    .where(
      scoped(
        ctx,
        schema.notifications,
        eq(schema.notifications.userId, ctx.actor.id),
        eq(schema.notifications.subjectRef, row.id)
      )
    )
    .limit(1);
  return delivered.length > 0;
}

/** The stored row plus its i18n maps decoded, so a GET body is a valid PATCH body. */
function reportView<T extends { nameJson: string; descriptionJson: string | null }>(
  row: T
): T & { name: Record<string, string>; description?: Record<string, string> } {
  const map = (json: string | null): Record<string, string> | undefined => {
    if (!json) return undefined;
    try {
      return JSON.parse(json) as Record<string, string>;
    } catch {
      return undefined;
    }
  };
  const description = map(row.descriptionJson);
  return { ...row, name: map(row.nameJson) ?? {}, ...(description ? { description } : {}) };
}

function requireDataset(ctx: Ctx, dataset: string): Dataset {
  const ds = DATASETS[dataset];
  if (!ds) throw badRequest(`unknown dataset ${dataset}`);
  require_(ctx.actor, ds.permission, { tenantId: ctx.tenantId, module: ds.module });
  return ds;
}

function mergeDefinition(
  definitionJson: string,
  over: Partial<Pick<ReportDefinition, "from" | "to" | "filters" | "grain" | "limit">>
): ReportDefinition {
  const base = JSON.parse(definitionJson) as ReportDefinition;
  return {
    ...base,
    ...(over.from !== undefined ? { from: over.from } : {}),
    ...(over.to !== undefined ? { to: over.to } : {}),
    ...(over.grain !== undefined ? { grain: over.grain } : {}),
    ...(over.limit !== undefined ? { limit: over.limit } : {}),
    // Overriding filters replaces rather than appends: a caller who cannot see
    // the stored filters cannot reason about what appending would produce.
    ...(over.filters ? { filters: over.filters } : {})
  };
}

/** Run it, and leave a row saying it ran. A report nobody can prove ran is a rumour. */
async function materialise(
  ctx: Ctx,
  def: ReportDefinition,
  opts: { reportId?: string; title?: string; unmasked?: boolean; trigger?: "user" | "schedule" }
): Promise<{ result: RunResult; runId: string }> {
  const runId = id("run", ctx.now);
  const started = Date.now();
  const unmasked = opts.unmasked ?? can(ctx.actor, "core:pii:view", { tenantId: ctx.tenantId });
  try {
    const result = await runReport(ctx, def, { unmasked, ...(opts.title ? { title: opts.title } : {}) });
    await ctx.db.insert(schema.reportRuns).values({
      id: runId,
      tenantId: ctx.tenantId,
      reportId: opts.reportId ?? "adhoc",
      paramsJson: JSON.stringify(def),
      requestedBy: actorRef(ctx),
      trigger: opts.trigger ?? "user",
      state: "done",
      rowCount: result.rowCount,
      resultRef: null,
      truncated: result.truncated,
      durationMs: Date.now() - started,
      error: null,
      expiresAt: ctx.now + 24 * 60 * 60 * 1000,
      startedAt: ctx.now,
      endedAt: Date.now()
    });
    return { result, runId };
  } catch (err) {
    await ctx.db.insert(schema.reportRuns).values({
      id: runId,
      tenantId: ctx.tenantId,
      reportId: opts.reportId ?? "adhoc",
      paramsJson: JSON.stringify(def),
      requestedBy: actorRef(ctx),
      trigger: opts.trigger ?? "user",
      state: "failed",
      truncated: false,
      durationMs: Date.now() - started,
      error: err instanceof Error ? err.message : "failed",
      startedAt: ctx.now,
      endedAt: Date.now()
    });
    throw err;
  }
}

/** Put the bytes in the object store and leave the two rows that describe them. */
async function storeExport(
  ctx: Ctx,
  bucket: R2Bucket | undefined,
  a: {
    runId: string;
    reportId: string | null;
    format: string;
    rendered: Rendered;
    rowCount: number;
    unmasked: boolean;
    piiJustification?: string | null;
    watermark?: string | null;
    approvedBy?: string | null;
  }
): Promise<typeof schema.analyticsExports.$inferSelect> {
  const exportId = id("exp", ctx.now);
  const fileId = id("file", ctx.now);
  const r2Key = `exports/${ctx.tenantId}/${exportId}.${a.format}`;
  if (bucket) await bucket.put(r2Key, a.rendered.bytes, { httpMetadata: { contentType: a.rendered.contentType } });

  await ctx.db.insert(schema.files).values({
    id: fileId,
    tenantId: ctx.tenantId,
    r2Key,
    kind: "analytics_export",
    subjectRef: exportId,
    sha256: await sha256Hex(a.rendered.bytes),
    sizeBytes: a.rendered.bytes.length,
    contentType: a.rendered.contentType,
    piiLevel: a.unmasked ? "high" : "none",
    createdAt: ctx.now,
    deletedAt: null
  });

  const row = {
    id: exportId,
    tenantId: ctx.tenantId,
    runId: a.runId,
    reportId: a.reportId,
    subjectRef: null,
    format: a.format,
    fileId,
    sizeBytes: a.rendered.bytes.length,
    rowCount: a.rowCount,
    piiMasked: !a.unmasked,
    piiJustification: a.piiJustification ?? null,
    watermark: a.watermark ?? null,
    requestedBy: actorRef(ctx),
    approvedBy: a.approvedBy ?? null,
    // Rendering happens inline: these reports are bounded by MAX_ROWS, and a
    // queue for something that takes 200ms is a queue to debug at 3am.
    state: bucket ? "ready" : "failed",
    downloadCount: 0,
    expiresAt: ctx.now + 7 * 24 * 60 * 60 * 1000,
    error: bucket ? null : "no object store bound",
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  await ctx.db.insert(schema.analyticsExports).values(row);
  return row;
}

/**
 * Next fire time for a five-field cron, evaluated in the schedule's timezone
 * by minute stepping. Returns a UTC timestamp.
 * ponytail: a minute-by-minute scan over at most 366 days. It runs once per
 * schedule write, not per tick — swap for a field-wise solver if that changes.
 */
export function nextRun(cron: string, from: number, timezone = "UTC"): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw badRequest("cron must have five fields: minute hour dom month dow");
  const [min, hour, dom, month, dow] = fields as [string, string, string, string, string];
  // ponytail: one offset for the whole scan, taken at `from`. Exact for the
  // fixed-offset Gulf zones this ships to (Asia/Dubai is +04:00 year-round);
  // a DST zone's fire that straddles a transition can be an hour off once.
  const offset = zoneOffsetMs(timezone, from);

  const matches = (spec: string, value: number, max: number): boolean => {
    if (spec === "*") return true;
    return spec.split(",").some((part) => {
      const [range, stepRaw] = part.split("/");
      const step = stepRaw ? Number(stepRaw) : 1;
      if (!Number.isFinite(step) || step < 1) return false;
      if (range === "*" || range === undefined) return value % step === 0;
      const [aRaw, bRaw] = range.split("-");
      const a = Number(aRaw);
      const b = bRaw === undefined ? a : Number(bRaw);
      if (!Number.isFinite(a) || !Number.isFinite(b) || a > max) return false;
      return value >= a && value <= b && (value - a) % step === 0;
    });
  };

  const cursor = new Date(Math.ceil((from + 60_000) / 60_000) * 60_000);
  const limit = from + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    // The cron's fields describe wall-clock time in `timezone`; shifting the
    // instant by the zone offset makes the getUTC* reads give exactly that.
    const local = new Date(cursor.getTime() + offset);
    if (
      matches(min, local.getUTCMinutes(), 59) &&
      matches(hour, local.getUTCHours(), 23) &&
      matches(dom, local.getUTCDate(), 31) &&
      matches(month, local.getUTCMonth() + 1, 12) &&
      matches(dow, local.getUTCDay(), 6)
    ) {
      return cursor.getTime();
    }
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  return null;
}

/** Offset of `timezone` from UTC at instant `at`, via Intl — no dependency. */
function zoneOffsetMs(timezone: string, at: number): number {
  if (timezone === "UTC") return 0;
  // Checked before the `try`, not caught inside it: `formatToParts` throws the
  // same `RangeError` for an instant no `Date` can hold as for a zone Intl does
  // not know, and reporting that as "unknown timezone: Asia/Dubai" sends the
  // reader after a zone that is perfectly fine. `at` is `ctx.now` at every call
  // site today, but `nextRun` is exported.
  if (!Number.isFinite(at) || Math.abs(at) > 8.64e15) throw badRequest(`not an instant a Date can hold: ${at}`);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).formatToParts(new Date(at));
  } catch {
    throw badRequest(`unknown timezone: ${timezone}`);
  }
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  // `hour12: false` renders midnight as "24" in some ICU builds.
  const wall = Date.UTC(f.year!, f.month! - 1, f.day!, f.hour! % 24, f.minute!);
  return wall - Math.floor(at / 60_000) * 60_000;
}

/* ------------------------------------------------------- scheduled delivery */

type Schedule = typeof schema.analyticsSchedules.$inferSelect;

/**
 * ANL-012. Run every schedule that is due for this tenant, render its report and
 * deliver it. Called from the worker's `scheduled` handler, so it runs as the
 * system actor with no grants — which is why nothing here checks a permission
 * and everything here is masked by default.
 *
 * Exactly-once is the idempotency key `<schedule>@<due>`: a cron that fires
 * twice for the same slot finds the first attempt's result and delivers nothing.
 */
export async function runDueSchedules(ctx: Ctx, bucket?: R2Bucket, browser?: BrowserBinding): Promise<number> {
  const due = await ctx.db
    .select()
    .from(schema.analyticsSchedules)
    .where(
      scoped(
        ctx,
        schema.analyticsSchedules,
        eq(schema.analyticsSchedules.status, "active"),
        lte(schema.analyticsSchedules.nextRunAt, ctx.now)
      )
    )
    .limit(50);

  let delivered = 0;
  for (const s of due) {
    try {
      delivered += await withIdempotency(
        ctx,
        `${s.id}@${s.nextRunAt}`,
        "analytics.schedule.run",
        { scheduleId: s.id, due: s.nextRunAt },
        () => deliverSchedule(ctx, s, bucket, browser)
      );
    } catch (err) {
      // A failed schedule must alert its owner and then get out of the way: the
      // next tick belongs to the other schedules, not to this one's retry loop.
      await failSchedule(ctx, s, err);
    }
  }
  return delivered;
}

async function deliverSchedule(ctx: Ctx, s: Schedule, bucket: R2Bucket | undefined, browser?: BrowserBinding): Promise<number> {
  // ponytail: report schedules only. A dashboard schedule needs a multi-table
  // artefact; when that lands it renders every tile and calls storeExport once.
  if (!s.reportId) throw badRequest("only report schedules are delivered");
  const report = await must(ctx, schema.reports, s.reportId, "report");
  const params = s.paramsJson ? (JSON.parse(s.paramsJson) as Partial<ReportDefinition>) : {};
  const def = mergeDefinition(report.definitionJson, params);
  const title = labelOf(s.nameJson, s.locale);

  const { result, runId } = await materialise(ctx, def, { reportId: report.id, title, trigger: "schedule" });
  const rendered = await render(
    s.format as "xlsx" | "pdf" | "csv" | "json",
    result,
    {
      totals: totalsOf(result),
      meta: { Schedule: title, Rows: String(result.rowCount) }
    },
    browser
  );
  const row = await storeExport(ctx, bucket, {
    runId,
    reportId: report.id,
    format: s.format,
    rendered,
    rowCount: result.rowCount,
    unmasked: false
  });
  if (row.state !== "ready") throw new Error("no object store bound");

  const recipients = JSON.parse(s.recipientsJson) as string[];
  const named = recipients.length
    ? await ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          scoped(
            ctx,
            schema.users,
            or(inArray(schema.users.id, recipients), inArray(schema.users.email, recipients)),
            eq(schema.users.status, "active")
          )
        )
    : [];

  // Being named on a schedule is not permission to read the report — a schedule
  // outlives the roles of everyone on it. Filter here rather than at download,
  // so nobody is handed an artefact they will then be refused; the shortfall
  // lands in `state` below and alerts the schedule's owner.
  const permitted = await Promise.all(
    named.map(async (u) => {
      const grants = await grantsFor(ctx.db, ctx.tenantId, u.id);
      const actor = { kind: "user" as const, id: u.id, tenantId: ctx.tenantId, grants };
      return reportVisible({ ...ctx, actor }, report) ? u : null;
    })
  );
  const reachable = permitted.filter((u): u is { id: string } => u !== null);

  // ponytail: the inbox is the one delivery channel that is built. Email, R2
  // hand-off, webhook and Slack are the same seam — a `deliver(kind, target)`
  // switch here, each case consent-checked and gated (docs/12 §4) before send,
  // which is exactly why an outbound channel is not being smuggled in today.
  await notify(ctx, reachable.map((u) => u.id), "report", "analytics.schedule.delivered", row.id, {
    scheduleId: s.id,
    exportId: row.id,
    format: s.format,
    rows: result.rowCount
  });

  const state = reachable.length === recipients.length ? "done" : reachable.length ? "partial" : "undelivered";
  if (state !== "done") {
    await notify(ctx, ownerOf(s), "alert", "analytics.schedule.undelivered", s.id, {
      scheduleId: s.id,
      delivered: reachable.length,
      recipients: recipients.length
    });
  }

  await ctx.db
    .update(schema.analyticsSchedules)
    .set({ lastRunAt: ctx.now, lastState: state, nextRunAt: nextRun(s.cron, ctx.now, s.timezone), updatedAt: ctx.now })
    .where(scoped(ctx, schema.analyticsSchedules, eq(schema.analyticsSchedules.id, s.id)));
  await audit(ctx, {
    action: "analytics.schedule.deliver",
    subjectRef: s.id,
    after: { exportId: row.id, format: s.format, rows: result.rowCount, delivered: reachable.length, state }
  });
  return 1;
}

async function failSchedule(ctx: Ctx, s: Schedule, err: unknown): Promise<void> {
  const error = err instanceof Error ? err.message : "failed";
  let next: number | null = null;
  try {
    next = nextRun(s.cron, ctx.now, s.timezone);
  } catch {
    // A schedule with an unparseable cron stops rather than spinning.
  }
  await ctx.db
    .update(schema.analyticsSchedules)
    .set({ lastRunAt: ctx.now, lastState: "failed", nextRunAt: next, updatedAt: ctx.now })
    .where(scoped(ctx, schema.analyticsSchedules, eq(schema.analyticsSchedules.id, s.id)));
  await notify(ctx, ownerOf(s), "alert", "analytics.schedule.failed", s.id, { scheduleId: s.id, error });
  await audit(ctx, { action: "analytics.schedule.failed", subjectRef: s.id, after: { error } });
}

/** `user:u_1` → `u_1`; anything else has no inbox to write to. */
function ownerOf(s: Schedule): string[] {
  const [kind, userId] = s.createdBy.split(":");
  return kind === "user" && userId ? [userId] : [];
}

async function notify(
  ctx: Ctx,
  userIds: string[],
  kind: string,
  titleKey: string,
  subjectRef: string,
  params: Record<string, unknown>
): Promise<void> {
  if (!userIds.length) return;
  await ctx.db.insert(schema.notifications).values(
    userIds.map((userId) => ({
      id: id("ntf", ctx.now),
      tenantId: ctx.tenantId,
      userId,
      kind,
      // Rule 7: the inbox stores a key and its parameters, never a sentence.
      titleKey,
      paramsJson: JSON.stringify(params),
      subjectRef,
      readAt: null,
      createdAt: ctx.now
    }))
  );
}

function labelOf(nameJson: string, locale: string): string {
  try {
    const map = JSON.parse(nameJson) as Record<string, string>;
    return map[locale] ?? map.en ?? Object.values(map)[0] ?? "Report";
  } catch {
    return "Report";
  }
}

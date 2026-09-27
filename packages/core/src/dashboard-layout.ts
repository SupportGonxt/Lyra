import { z } from "zod";
import { ReportDefinitionSchema, ReportFilterSchema, type ReportDefinition, type ReportFilter } from "./report-definition.js";

// docs/30 Analytics 5. What `analytics_dashboards.layout_json` may hold: the
// tiles, in reading order, each drawn from a saved report or an inline report
// definition, plus the dashboard's own filters, which every tile inherits at
// render. One schema for every writer — POST /v1/analytics/dashboards, the
// generic CRUD PATCH, the tile editor — and the renderer, so a malformed layout
// is refused at the write rather than painted as blank tiles (the
// CommissionStructureJson precedent, ADR-0084).
//
// Shape and bounds only. Whether a dataset, metric or report *exists*, and
// whether the writer may read it, is the API's question.

export const DASHBOARD_VIZ = ["number", "line", "bar", "table", "donut", "list"] as const;
export type DashboardViz = (typeof DASHBOARD_VIZ)[number];

/** The grid is twelve columns wide; a tile spans some of them. */
export const DASHBOARD_COLUMNS = 12;
export const DASHBOARD_MAX_TILES = 24;
/** Ten years is the longest rolling window a dashboard may ask for. */
export const DASHBOARD_MAX_DAYS = 3660;

const DAY_MS = 86_400_000;

export const DashboardTileSchema = z
  .object({
    key: z.string().trim().min(1).max(64),
    viz: z.enum(DASHBOARD_VIZ),
    span: z.number().int().min(1).max(DASHBOARD_COLUMNS).default(4),
    reportId: z.string().min(1).max(64).optional(),
    definition: ReportDefinitionSchema.optional()
  })
  .strict()
  .refine((tile) => (tile.reportId === undefined) !== (tile.definition === undefined), {
    message: "a tile names a report or carries a definition, exactly one"
  });

export const DashboardFiltersSchema = z
  .object({
    /** A rolling window ending at render time — a board that does not go stale. */
    lastDays: z.number().int().min(1).max(DASHBOARD_MAX_DAYS).optional(),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    /** Dimension filters, applied to every tile whose dataset has the field. */
    where: z.array(ReportFilterSchema).max(10).optional()
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.lastDays !== undefined && (f.from !== undefined || f.to !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["lastDays"], message: "a rolling window cannot also have fixed dates" });
    }
    if (f.from !== undefined && f.to !== undefined && f.to < f.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "the range ends before it starts" });
    }
  });

export const DashboardLayoutSchema = z
  .object({
    tiles: z.array(DashboardTileSchema).max(DASHBOARD_MAX_TILES),
    filters: DashboardFiltersSchema.optional()
  })
  .strict()
  .superRefine((layout, ctx) => {
    const seen = new Set<string>();
    layout.tiles.forEach((tile, i) => {
      if (seen.has(tile.key)) ctx.addIssue({ code: "custom", path: ["tiles", i, "key"], message: "duplicate tile key" });
      seen.add(tile.key);
    });
  });

export type DashboardTile = z.infer<typeof DashboardTileSchema>;
export type DashboardFilters = z.infer<typeof DashboardFiltersSchema>;
export type DashboardLayout = z.infer<typeof DashboardLayoutSchema>;

/** The first issue, keyed the way `Problem.errors` keys a field (dotted path). */
export function layoutProblem(error: z.ZodError): { path: string; message: string } {
  const issue = error.issues[0];
  return { path: (issue?.path ?? []).map(String).join("."), message: issue?.message ?? "invalid" };
}

/** The instants a dashboard's range stands for at `now`; empty when it sets none. */
export function dashboardRange(filters: DashboardFilters | undefined, now: number): { from?: number; to?: number } {
  if (!filters) return {};
  if (filters.lastDays !== undefined) return { from: now - filters.lastDays * DAY_MS, to: now };
  return {
    ...(filters.from !== undefined ? { from: filters.from } : {}),
    ...(filters.to !== undefined ? { to: filters.to } : {})
  };
}

/**
 * One tile's definition with the dashboard's filters over it. The dashboard's
 * range replaces the tile's own at whichever end it sets; its dimension filters
 * are added beside the tile's own. A filter on a field the tile's dataset does
 * not have (`dimensions`) is not applied and is named in `unfiltered`, so the
 * screen can say so under that tile rather than fail it or pretend.
 */
export function applyDashboardFilters(
  def: ReportDefinition,
  filters: DashboardFilters | undefined,
  dimensions: ReadonlySet<string>,
  now: number
): { definition: ReportDefinition; unfiltered: string[] } {
  if (!filters) return { definition: def, unfiltered: [] };
  const definition: ReportDefinition = { ...def, ...dashboardRange(filters, now) };
  const applied: ReportFilter[] = [];
  const unfiltered: string[] = [];
  for (const f of filters.where ?? []) {
    if (dimensions.has(f.field)) applied.push(f);
    else if (!unfiltered.includes(f.field)) unfiltered.push(f.field);
  }
  if (applied.length) definition.filters = [...(def.filters ?? []), ...applied];
  return { definition, unfiltered };
}

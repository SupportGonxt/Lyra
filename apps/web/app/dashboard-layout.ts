// A dashboard layout as the web reads and edits it (docs/30 Analytics 5): the
// tiles in reading order and the dashboard's own filters, which every tile
// inherits when GET /v1/analytics/dashboards/:id/data paints it.
//
// Mirrors `DashboardLayoutSchema` in packages/core/src/dashboard-layout.ts,
// which POST /v1/analytics/dashboards and the generic PATCH validate with. The
// web does not depend on @lyra/core, so `layoutOf` is a structural read only —
// enough that a mangled row opens as "cannot be read" rather than crashing the
// editor; the API stays the authority on what a layout may say.
//
// Every edit is a pure function over the tile list, so each move a pointer
// makes is also a keyboard move and a one-line test.

import { defFromParams, fitToDataset, type DatasetInfo, type ReportDefinition, type ReportFilter } from "./analytics-def";

export const VIZ = ["number", "line", "bar", "table", "donut", "list"] as const;
export type Viz = (typeof VIZ)[number];

/** The grid is twelve columns wide (DASHBOARD_COLUMNS). */
export const COLUMNS = 12;
/** DASHBOARD_MAX_TILES. */
export const MAX_TILES = 24;
/** Rolling windows the range control offers, in days. */
export const WINDOWS = ["7", "30", "90", "365"] as const;
/** How many dimension filter rows the editor offers; the API caps at ten. */
export const FILTER_ROWS = 3;

export interface TileSpec {
  key: string;
  viz: Viz;
  span?: number;
  reportId?: string;
  definition?: ReportDefinition;
}

export interface DashboardFilters {
  lastDays?: number;
  from?: number;
  to?: number;
  where?: ReportFilter[];
}

export interface Layout {
  tiles: TileSpec[];
  filters?: DashboardFilters;
}

/* ------------------------------------------------------------------ read */

/** A stored layout — text, or the object generic CRUD hydrates — or null. Never throws. */
export function layoutOf(raw: unknown): Layout | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (!Array.isArray(r.tiles)) return null;
  const tiles = r.tiles as unknown[];
  if (!tiles.every(isTile)) return null;
  return r.filters && typeof r.filters === "object" ? { tiles, filters: r.filters as DashboardFilters } : { tiles };
}

function isTile(v: unknown): v is TileSpec {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return typeof t.key === "string" && t.key.length > 0 && (VIZ as readonly string[]).includes(String(t.viz));
}

/* ----------------------------------------------------------------- edits */

/** One tile moved to position `to` (clamped); the rest keep their order. */
export function moveTile(tiles: TileSpec[], from: number, to: number): TileSpec[] {
  const target = Math.max(0, Math.min(tiles.length - 1, to));
  const next = [...tiles];
  const [moved] = next.splice(from, 1);
  if (!moved) return next;
  next.splice(target, 0, moved);
  return next;
}

/**
 * The position a key press moves a tile to, or null when it does not move it.
 * Alt+Up/Down steps one place, Alt+Home/End goes to either end; plain arrows
 * stay the page's (WCAG 2.1.1 without stealing navigation keys).
 */
export function reorderKey(key: string, alt: boolean, index: number, length: number): number | null {
  if (!alt) return null;
  const to =
    key === "ArrowUp" ? index - 1 : key === "ArrowDown" ? index + 1 : key === "Home" ? 0 : key === "End" ? length - 1 : null;
  if (to === null || to < 0 || to >= length || to === index) return null;
  return to;
}

/** A tile resized to a whole number of the grid's columns. */
export function resizeTile(tiles: TileSpec[], index: number, span: number): TileSpec[] {
  const whole = Number.isFinite(span) ? Math.round(span) : 4;
  const clamped = Math.max(1, Math.min(COLUMNS, whole));
  return tiles.map((tile, i) => (i === index ? { ...tile, span: clamped } : tile));
}

export function removeTile(tiles: TileSpec[], index: number): TileSpec[] {
  return tiles.filter((_, i) => i !== index);
}

/**
 * A tile added at the end, its title trimmed and made unique on the board (the
 * key is how a painted result finds its tile). Null for a blank title or a
 * full board.
 */
export function addTile(tiles: TileSpec[], tile: TileSpec): TileSpec[] | null {
  const base = tile.key.trim();
  if (!base || tiles.length >= MAX_TILES) return null;
  const taken = new Set(tiles.map((t) => t.key));
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base} (${n})`;
  return [...tiles, { ...tile, key }];
}

/**
 * A tile's definition from the add form's four choices, read through the
 * builder's own form reader (`defFromParams`) and narrowed the way the builder
 * narrows (`fitToDataset`) — one reading of a build, not two.
 */
export function tileFromChoice(
  choice: { dataset: string; metric: string; dimension: string; grain: string },
  ds: DatasetInfo | undefined
): ReportDefinition | null {
  if (!ds) return null;
  const params = new URLSearchParams({ dataset: choice.dataset, grain: choice.grain });
  if (choice.metric) params.append("metric", choice.metric);
  if (choice.dimension) params.append("dimension", choice.dimension);
  const posted = defFromParams(params);
  if (!posted) return null;
  const def = fitToDataset(posted, ds);
  return def.metrics.length ? def : null;
}

/* ---------------------------------------------------------------- filters */

/**
 * The dashboard's filters from the editor form: `range` is "" (none), a number
 * of days, or "fixed" with `from`/`to` dates; `f<n>.field|op|value` are
 * dimension rows in the builder's own encoding, read by the builder's reader.
 */
export function filtersFromForm(form: { get(name: string): FormDataEntryValue | null }): DashboardFilters | undefined {
  const text = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const params = new URLSearchParams({ dataset: "_" });
  const range = text("range");
  if (range === "fixed") {
    params.set("from", text("from"));
    params.set("to", text("to"));
  }
  for (let i = 0; i < FILTER_ROWS; i++) {
    for (const part of ["field", "op", "value"]) params.set(`f${i}.${part}`, text(`f${i}.${part}`));
  }
  const read = defFromParams(params);
  const out: DashboardFilters = {};
  const days = Number(range);
  if (range && range !== "fixed" && Number.isInteger(days) && days > 0) out.lastDays = days;
  if (read?.from !== undefined) out.from = read.from;
  if (read?.to !== undefined) out.to = read.to;
  if (read?.filters?.length) out.where = read.filters;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------------ grid */

/** Tailwind needs each class to exist in the source, so the spans are written out. */
export const SPAN: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
  9: "lg:col-span-9",
  10: "lg:col-span-10",
  11: "lg:col-span-11",
  12: "lg:col-span-12"
};

/** The class a tile's span draws with, defaulting the way the API does (four). */
export function spanClass(span: number | undefined): string {
  return SPAN[Math.min(COLUMNS, Math.max(1, span ?? 4))] ?? SPAN[4]!;
}

/** The range control's value for stored filters. */
export function rangeChoice(filters: DashboardFilters | undefined): string {
  if (filters?.lastDays !== undefined) return String(filters.lastDays);
  if (filters?.from !== undefined || filters?.to !== undefined) return "fixed";
  return "";
}

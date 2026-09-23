// A report definition as the web reads and writes it — the builder's whole
// state, carried in the URL as `?def=<base64url JSON>` so any build is a link:
// shareable, bookmarkable, and what the ask bar and the AI operations
// dashboard hand over.
//
// Mirrors `ReportDefinitionSchema` in packages/core/src/report-definition.ts,
// the one zod schema POST /v1/analytics/run, /reports and /ask all validate
// with. The web does not depend on @lyra/core, so this is a structural check
// only: it keeps a mangled link from crashing the screen, and the API stays the
// authority on what a definition may say.

export const GRAINS = ["none", "day", "week", "month", "quarter", "year"] as const;
export type Grain = (typeof GRAINS)[number];

export const FILTER_OPS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Ops that test presence and so carry no value. */
export const VALUELESS: ReadonlySet<FilterOp> = new Set(["is_null", "not_null"]);

export type FilterValue = string | number | (string | number)[];

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value?: FilterValue;
}

export interface ReportDefinition {
  dataset: string;
  metrics: string[];
  dimensions?: string[];
  filters?: ReportFilter[];
  grain?: Grain;
  from?: number;
  to?: number;
  sort?: { field: string; dir: "asc" | "desc" };
  limit?: number;
}

/** One row of GET /v1/analytics/datasets (apps/api/src/routes/analytics.ts). */
export interface DatasetInfo {
  key: string;
  module: string;
  timeColumn: string;
  dimensions: { key: string; label: string; kind: string; pii: boolean }[];
  metrics: { key: string; label: string; kind: string; agg: string }[];
}

/** How many filter rows the builder form offers. The API caps at 20. */
export const FILTER_ROWS = 4;

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------ the URL token */

export function encodeDef(def: ReportDefinition): string {
  const bytes = new TextEncoder().encode(JSON.stringify(def));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A link's definition, or null for anything that is not one. Never throws. */
export function decodeDef(token: string | null | undefined): ReportDefinition | null {
  if (!token) return null;
  try {
    const binary = atob(token.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return asDefinition(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

export function builderHref(def: ReportDefinition, opts: { run?: boolean } = {}): string {
  return `/analytics/builder?def=${encodeDef(def)}${opts.run ? "&run=1" : ""}`;
}

/* --------------------------------------------------------------- the form */

/**
 * The definition the builder's GET form describes. Repeated `metric` and
 * `dimension` params are the multi-selects; `f<n>.field|op|value` are the
 * filter rows, a blank field meaning an unused row.
 */
export function defFromParams(params: URLSearchParams): ReportDefinition | null {
  const dataset = params.get("dataset")?.trim();
  if (!dataset) return null;
  const def: ReportDefinition = { dataset, metrics: params.getAll("metric").filter(Boolean) };

  const dimensions = params.getAll("dimension").filter(Boolean);
  if (dimensions.length) def.dimensions = dimensions;

  const grain = params.get("grain");
  if (isGrain(grain) && grain !== "none") def.grain = grain;

  const from = dayStart(params.get("from"));
  if (from !== undefined) def.from = from;
  const to = dayStart(params.get("to"));
  if (to !== undefined) def.to = to + DAY_MS - 1;

  const filters: ReportFilter[] = [];
  for (let i = 0; i < 20; i++) {
    const field = params.get(`f${i}.field`)?.trim();
    const op = params.get(`f${i}.op`);
    if (!field || !isOp(op)) continue;
    if (VALUELESS.has(op)) {
      filters.push({ field, op });
      continue;
    }
    const raw = params.get(`f${i}.value`) ?? "";
    const value =
      op === "in"
        ? raw
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean)
            .map(scalar)
        : scalar(raw.trim());
    filters.push({ field, op, value });
  }
  if (filters.length) def.filters = filters;

  const sort = params.get("sort");
  if (sort) def.sort = { field: sort, dir: params.get("dir") === "asc" ? "asc" : "desc" };

  const limit = Number(params.get("limit"));
  if (Number.isInteger(limit) && limit > 0) def.limit = limit;
  return def;
}

/**
 * The definition narrowed to what `ds` actually offers. Switching dataset in the
 * form posts the old dataset's metrics along with the new key; this is what
 * keeps that from reaching the API as an "unknown metric" 400.
 */
export function fitToDataset(def: ReportDefinition, ds: DatasetInfo): ReportDefinition {
  const metrics = new Set(ds.metrics.map((m) => m.key));
  const dimensions = new Set(ds.dimensions.map((d) => d.key));
  const out: ReportDefinition = { ...def, metrics: def.metrics.filter((m) => metrics.has(m)) };

  const dims = (def.dimensions ?? []).filter((d) => dimensions.has(d));
  if (dims.length) out.dimensions = dims;
  else delete out.dimensions;

  const filters = (def.filters ?? []).filter((f) => dimensions.has(f.field));
  if (filters.length) out.filters = filters;
  else delete out.filters;

  const grain = def.grain && def.grain !== "none" ? def.grain : undefined;
  const sortable = def.sort
    ? def.sort.field === "period"
      ? Boolean(grain)
      : metrics.has(def.sort.field) || dimensions.has(def.sort.field)
    : false;
  if (!sortable) delete out.sort;
  return out;
}

/* ------------------------------------------------------------------ guards */

function asDefinition(raw: unknown): ReportDefinition | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.dataset !== "string" || !r.dataset) return null;
  if (!isStrings(r.metrics) || !r.metrics.length) return null;
  const def: ReportDefinition = { dataset: r.dataset, metrics: r.metrics };
  if (r.dimensions !== undefined) {
    if (!isStrings(r.dimensions)) return null;
    def.dimensions = r.dimensions;
  }
  if (r.grain !== undefined) {
    if (!isGrain(r.grain)) return null;
    def.grain = r.grain;
  }
  for (const key of ["from", "to", "limit"] as const) {
    if (r[key] === undefined) continue;
    if (typeof r[key] !== "number" || !Number.isInteger(r[key])) return null;
    def[key] = r[key] as number;
  }
  if (r.sort !== undefined) {
    const s = r.sort as Record<string, unknown> | null;
    if (!s || typeof s.field !== "string" || (s.dir !== "asc" && s.dir !== "desc")) return null;
    def.sort = { field: s.field, dir: s.dir };
  }
  if (r.filters !== undefined) {
    if (!Array.isArray(r.filters)) return null;
    const filters: ReportFilter[] = [];
    for (const f of r.filters as unknown[]) {
      const row = f as Record<string, unknown> | null;
      if (!row || typeof row.field !== "string" || !isOp(row.op)) return null;
      const filter: ReportFilter = { field: row.field, op: row.op };
      if (row.value !== undefined) {
        if (!isValue(row.value)) return null;
        filter.value = row.value;
      }
      filters.push(filter);
    }
    def.filters = filters;
  }
  return def;
}

function isStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
}

function isGrain(v: unknown): v is Grain {
  return typeof v === "string" && (GRAINS as readonly string[]).includes(v);
}

function isOp(v: unknown): v is FilterOp {
  return typeof v === "string" && (FILTER_OPS as readonly string[]).includes(v);
}

function isValue(v: unknown): v is FilterValue {
  const one = (x: unknown) => typeof x === "string" || (typeof x === "number" && Number.isFinite(x));
  return one(v) || (Array.isArray(v) && v.every(one));
}

/** A numeric-looking value is a number; anything else stays text. */
function scalar(raw: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

/** `YYYY-MM-DD` to that day's first millisecond in UTC. */
function dayStart(raw: string | null): number | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** An epoch-ms instant back to the `YYYY-MM-DD` a date input shows. */
export function dayOf(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  return new Date(ms).toISOString().slice(0, 10);
}

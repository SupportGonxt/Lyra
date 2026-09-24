import { ReportDefinitionSchema, type ReportDefinition, type ReportFilter } from "@lyra/core";
import { parseJsonObject } from "./parse.js";

// docs/05 §analytics — "ask a question in words → compiled to a visible,
// editable query" — and docs/17 ANL-009. The model's whole job is to name
// things from a catalogue the caller is allowed to read; the report engine
// writes the SQL, as it does for a hand-built definition. So the model never
// touches data, and what comes back is a definition a reader inspects, edits
// and runs themselves (docs/15: a background draft, never an action).
//
// Same shape as whitespace-brief.ts: an exported schema, an exported prompt
// builder, and a parser that is the trust boundary and never throws. Unlike a
// brief, there is no deterministic fallback — a definition the parser cannot
// hold to the catalogue is a refusal the reader sees, never a guess.
//
// CLAUDE.md rule 14: the prompt names no industry noun. Every noun the model
// sees is a catalogue label (the registry's own, pack-renamed upstream).

/** One row of GET /v1/analytics/datasets — what the caller may report on. */
export interface AskCatalogueEntry {
  key: string;
  module?: string;
  dimensions: { key: string; label: string; kind: string }[];
  metrics: { key: string; label: string; kind: string }[];
}

/** Why a reply was not turned into a definition. A code, never model prose. */
export type AskRefusal =
  | "unparseable"
  | "refused"
  | "missing_why"
  | "unknown_dataset"
  | "unknown_metric"
  | "unknown_dimension"
  | "bad_filter"
  | "bad_sort"
  | "bad_window"
  | "invalid";

export type AskResult =
  | { ok: true; definition: ReportDefinition; why: string }
  | { ok: false; reason: AskRefusal };

/** The longest relative window a reply may state: ten years. */
export const ASK_MAX_DAYS = 3650;
const DAY_MS = 86_400_000;
const WHY_MAX = 400;

/** JSON schema handed to `ModelRequest.responseSchema` (gateway.ts, docs/02 §5). */
export function analyticsAskSchema(): Record<string, unknown> {
  return {
    name: "analytics_ask",
    schema: {
      type: "object",
      properties: {
        dataset: { type: "string" },
        metrics: { type: "array", items: { type: "string" } },
        dimensions: { type: "array", items: { type: "string" } },
        grain: { type: "string", enum: ["none", "day", "week", "month", "quarter", "year"] },
        filters: {
          type: "array",
          items: {
            type: "object",
            properties: { field: { type: "string" }, op: { type: "string" }, value: {} },
            required: ["field", "op"]
          }
        },
        sort: {
          type: "object",
          properties: { field: { type: "string" }, dir: { type: "string", enum: ["asc", "desc"] } }
        },
        limit: { type: "integer" },
        lastDays: { type: "integer" },
        why: { type: "string" },
        refusal: { type: "string" }
      }
    }
  };
}

/** The catalogue as the model reads it: one dataset per block, key then label. */
export function catalogueLines(catalogue: readonly AskCatalogueEntry[]): string[] {
  return catalogue.map((ds) =>
    [
      `dataset ${ds.key}`,
      `  metrics: ${ds.metrics.map((m) => `${m.key} (${m.label})`).join(", ")}`,
      `  dimensions: ${ds.dimensions.map((d) => `${d.key} (${d.label})`).join(", ") || "none"}`
    ].join("\n")
  );
}

export function analyticsAskMessages(
  question: string,
  catalogue: readonly AskCatalogueEntry[],
  opts: { locale: string; today: string }
): { role: "system" | "user"; content: string }[] {
  const language = opts.locale === "ar" ? "Arabic" : "English";
  return [
    {
      role: "system",
      content:
        "You compile a reader's question about their own business data into a report definition " +
        "over a fixed catalogue. You never see data and never answer the question yourself. " +
        "Reply with JSON only: dataset (one catalogue dataset key), metrics (keys from that dataset), " +
        "optional dimensions (keys from that dataset, to split by), optional grain " +
        "(day|week|month|quarter|year, to bucket over time), optional filters " +
        "([{field, op, value}] where field is a dimension key and op is one of " +
        "eq, neq, in, gt, gte, lt, lte, contains, is_null, not_null), optional sort " +
        "({field, dir} on a metric, a dimension, or period when there is a grain), optional limit, " +
        "optional lastDays (a whole number of days back from today for a relative window), and why " +
        `(one sentence in ${language} saying which dataset and measures you chose and why). ` +
        "Use only keys that appear in the catalogue, from the one dataset you pick. If the catalogue " +
        'cannot answer the question, reply {"refusal": "<one sentence>"} — never guess a key. ' +
        `Today is ${opts.today}.\n\nCatalogue:\n${catalogueLines(catalogue).join("\n")}`
    },
    { role: "user", content: question }
  ];
}

/**
 * Parses one model reply against the catalogue the prompt was built from.
 * Never throws; anything it cannot hold to the catalogue is a refusal.
 *
 * A reply may name a metric or dimension by its exact label instead of its key
 * ("Gross written premium" for `gwp`). That is a lookup, not a guess — the label
 * is unique within its dataset and the match is exact, case aside — and it is
 * the one leniency. A near-miss, a key from a different dataset, or a word in
 * another language is refused.
 */
export function parseAnalyticsAsk(reply: string, catalogue: readonly AskCatalogueEntry[], now: number): AskResult {
  const raw = parseJsonObject(reply);
  if (!raw) return refuse("unparseable");
  if (typeof raw.refusal === "string" && raw.refusal.trim()) return refuse("refused");

  const why = typeof raw.why === "string" ? raw.why.trim().slice(0, WHY_MAX) : "";
  if (!why) return refuse("missing_why");

  const ds = catalogue.find((d) => d.key === raw.dataset);
  if (!ds) return refuse("unknown_dataset");

  const metrics = resolveAll(raw.metrics, ds.metrics);
  if (!metrics) return refuse("unknown_metric");
  const dimensions = raw.dimensions === undefined ? [] : resolveAll(raw.dimensions, ds.dimensions);
  if (!dimensions) return refuse("unknown_dimension");

  const def: Record<string, unknown> = { dataset: ds.key, metrics };
  if (dimensions.length) def.dimensions = dimensions;
  if (raw.grain !== undefined && raw.grain !== "none") def.grain = raw.grain;
  if (raw.limit !== undefined) def.limit = raw.limit;

  if (raw.filters !== undefined) {
    if (!Array.isArray(raw.filters)) return refuse("bad_filter");
    const filters: ReportFilter[] = [];
    for (const f of raw.filters as unknown[]) {
      const filter = resolveFilter(f, ds);
      if (!filter) return refuse("bad_filter");
      filters.push(filter);
    }
    if (filters.length) def.filters = filters;
  }

  if (raw.sort !== undefined) {
    const sort = raw.sort as Record<string, unknown> | null;
    const field =
      sort && typeof sort.field === "string"
        ? sort.field === "period"
          ? def.grain
            ? "period"
            : null
          : (resolve(sort.field, ds.metrics) ?? resolve(sort.field, ds.dimensions))
        : null;
    if (!field || (sort!.dir !== "asc" && sort!.dir !== "desc")) return refuse("bad_sort");
    def.sort = { field, dir: sort!.dir };
  }

  if (raw.lastDays !== undefined) {
    const days = raw.lastDays;
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > ASK_MAX_DAYS) return refuse("bad_window");
    def.from = now - days * DAY_MS;
  }

  const checked = ReportDefinitionSchema.safeParse(def);
  if (!checked.success) return refuse("invalid");
  return { ok: true, definition: checked.data, why };
}

function refuse(reason: AskRefusal): AskResult {
  return { ok: false, reason };
}

/** A key, or an exact (case-insensitive) label, to its key. Nothing else. */
function resolve(name: unknown, fields: readonly { key: string; label: string }[]): string | null {
  if (typeof name !== "string" || !name) return null;
  const byKey = fields.find((f) => f.key === name);
  if (byKey) return byKey.key;
  const folded = name.trim().toLowerCase();
  const byLabel = fields.filter((f) => f.label.toLowerCase() === folded);
  return byLabel.length === 1 ? byLabel[0]!.key : null;
}

/** Every name resolved, de-duplicated in order — or null if any one does not. */
function resolveAll(names: unknown, fields: readonly { key: string; label: string }[]): string[] | null {
  if (!Array.isArray(names)) return null;
  const out: string[] = [];
  for (const name of names) {
    const key = resolve(name, fields);
    if (!key) return null;
    if (!out.includes(key)) out.push(key);
  }
  // Duplicates collapse, but a reply that needed collapsing past the schema's
  // bound was not describing a report anyone asked for.
  return names.length > 12 ? null : out;
}

const OPS = new Set(["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"]);

function resolveFilter(raw: unknown, ds: AskCatalogueEntry): ReportFilter | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const field = resolve(f.field, ds.dimensions);
  if (!field || typeof f.op !== "string" || !OPS.has(f.op)) return null;
  const op = f.op as ReportFilter["op"];
  if (op === "is_null" || op === "not_null") return { field, op };
  const scalar = (v: unknown) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
  if (op === "in") {
    if (!Array.isArray(f.value) || !f.value.length || !f.value.every(scalar)) return null;
    return { field, op, value: f.value as (string | number)[] };
  }
  if (!scalar(f.value)) return null;
  return { field, op, value: f.value as string | number };
}

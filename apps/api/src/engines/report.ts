import { and, sql, type SQL } from "drizzle-orm";
import { schema } from "@lyra/db";
import { badRequest, sha256Hex, type Ctx } from "@lyra/core";
import type { ReportTable } from "@lyra/ledger";

// The reporting engine. A report is a definition over a registered dataset, not
// SQL from a user — that is the whole security model here: a caller names a
// dataset, dimensions and metrics from a fixed vocabulary, and this file writes
// the SQL. There is no path from request text to a query fragment.

export type ColKind = "text" | "money" | "date" | "number";

interface Field {
  /** Physical column. Never interpolated from request data. */
  column: string;
  label: string;
  kind: ColKind;
  /** PII columns are masked unless the caller holds the unmasked permission. */
  pii?: boolean;
}

interface Metric {
  label: string;
  kind: ColKind;
  /** SQL aggregate over one physical column, or `*` for count. */
  agg: "count" | "sum" | "avg" | "min" | "max" | "count_distinct";
  column?: string;
}

export interface Dataset {
  table: string;
  module: string;
  /** Permission required to query it at all. */
  permission: string;
  /** Column carrying the row's timestamp, for grain bucketing and date filters. */
  timeColumn: string;
  dimensions: Record<string, Field>;
  metrics: Record<string, Metric>;
  /** Rows nobody may see through analytics — soft-deleted, mostly. */
  baseFilter?: string;
}

/**
 * The semantic layer. Adding a reportable area is a row here; it is deliberately
 * the only place a table name can enter a query, so an area that is not listed
 * is not reportable rather than reportable-by-accident.
 */
export const DATASETS: Record<string, Dataset> = {
  policies: {
    table: "axis_policies",
    module: "axis",
    permission: "axis:policies:read",
    timeColumn: "start_at",
    dimensions: {
      status: { column: "status", label: "Status", kind: "text" },
      providerId: { column: "provider_id", label: "Provider", kind: "text" },
      productId: { column: "product_id", label: "Product", kind: "text" },
      offeringId: { column: "offering_id", label: "Offering", kind: "text" },
      channelId: { column: "channel_id", label: "Channel", kind: "text" },
      currency: { column: "currency", label: "Currency", kind: "text" },
      customerId: { column: "customer_id", label: "Customer", kind: "text", pii: true }
    },
    metrics: {
      policies: { label: "Policies", kind: "number", agg: "count" },
      gwp: { label: "Gross written premium", kind: "money", agg: "sum", column: "premium_minor" },
      commission: { label: "Commission", kind: "money", agg: "sum", column: "commission_minor" },
      avgPremium: { label: "Average premium", kind: "money", agg: "avg", column: "premium_minor" },
      customers: { label: "Customers", kind: "number", agg: "count_distinct", column: "customer_id" }
    }
  },
  quotes: {
    table: "dist_quote_requests",
    module: "dist",
    permission: "dist:quote_requests:read",
    timeColumn: "created_at",
    dimensions: {
      state: { column: "state", label: "State", kind: "text" },
      channelId: { column: "channel_id", label: "Channel", kind: "text" },
      productId: { column: "product_id", label: "Product", kind: "text" },
      currency: { column: "currency", label: "Currency", kind: "text" }
    },
    metrics: {
      requests: { label: "Quote requests", kind: "number", agg: "count" },
      fanout: { label: "Panel size", kind: "number", agg: "avg", column: "fanout_count" },
      responded: { label: "Responses", kind: "number", agg: "sum", column: "responded_count" },
      bestPremium: { label: "Best premium", kind: "money", agg: "avg", column: "best_premium_minor" }
    }
  },
  quoteResponses: {
    table: "dist_quote_responses",
    module: "dist",
    permission: "dist:quote_requests:read",
    timeColumn: "created_at",
    dimensions: {
      state: { column: "state", label: "State", kind: "text" },
      providerId: { column: "provider_id", label: "Provider", kind: "text" },
      offeringId: { column: "offering_id", label: "Offering", kind: "text" },
      priceRank: { column: "price_rank", label: "Price rank", kind: "number" }
    },
    metrics: {
      responses: { label: "Responses", kind: "number", agg: "count" },
      premium: { label: "Premium quoted", kind: "money", agg: "sum", column: "premium_minor" },
      commission: { label: "Commission", kind: "money", agg: "sum", column: "commission_minor" },
      latency: { label: "Latency ms", kind: "number", agg: "avg", column: "latency_ms" },
      valueScore: { label: "Value score", kind: "number", agg: "avg", column: "value_score" }
    }
  },
  commissions: {
    table: "dist_commission_entries",
    module: "dist",
    permission: "dist:commissions:read",
    timeColumn: "earned_at",
    dimensions: {
      kind: { column: "kind", label: "Kind", kind: "text" },
      state: { column: "state", label: "State", kind: "text" },
      providerId: { column: "provider_id", label: "Provider", kind: "text" },
      channelId: { column: "channel_id", label: "Channel", kind: "text" },
      currency: { column: "currency", label: "Currency", kind: "text" }
    },
    metrics: {
      entries: { label: "Entries", kind: "number", agg: "count" },
      premium: { label: "Premium", kind: "money", agg: "sum", column: "premium_minor" },
      gross: { label: "Gross commission", kind: "money", agg: "sum", column: "gross_commission_minor" },
      channel: { label: "Channel share", kind: "money", agg: "sum", column: "channel_commission_minor" },
      net: { label: "Net commission", kind: "money", agg: "sum", column: "net_commission_minor" },
      tax: { label: "Tax", kind: "money", agg: "sum", column: "tax_minor" }
    }
  },
  cases: {
    table: "axis_cases",
    module: "axis",
    permission: "axis:cases:read",
    timeColumn: "created_at",
    dimensions: {
      status: { column: "status", label: "Status", kind: "text" },
      kind: { column: "kind", label: "Kind", kind: "text" },
      priority: { column: "priority", label: "Priority", kind: "text" },
      source: { column: "source", label: "Source", kind: "text" },
      ownerRef: { column: "owner_ref", label: "Owner", kind: "text" },
      productLine: { column: "product_line", label: "Product line", kind: "text" },
      channelId: { column: "channel_id", label: "Channel", kind: "text" }
    },
    metrics: {
      cases: { label: "Cases", kind: "number", agg: "count" },
      value: { label: "Value", kind: "money", agg: "sum", column: "value_minor" },
      avgRisk: { label: "Average risk score", kind: "number", agg: "avg", column: "risk_score" },
      customers: { label: "Customers", kind: "number", agg: "count_distinct", column: "customer_id" }
    },
    baseFilter: "deleted_at is null"
  },
  transactions: {
    table: "ledger_txns",
    module: "ledger",
    permission: "ledger:txns:read",
    timeColumn: "created_at",
    dimensions: {
      type: { column: "type", label: "Type", kind: "text" },
      state: { column: "state", label: "State", kind: "text" },
      currency: { column: "currency", label: "Currency", kind: "text" }
    },
    metrics: {
      txns: { label: "Transactions", kind: "number", agg: "count" },
      gross: { label: "Gross", kind: "money", agg: "sum", column: "gross_minor" },
      base: { label: "Gross (base)", kind: "money", agg: "sum", column: "base_gross_minor" }
    }
  },
  aiSpend: {
    table: "ai_audit_log",
    module: "ai",
    permission: "ai:budgets:read",
    timeColumn: "ts",
    dimensions: {
      module: { column: "module", label: "Module", kind: "text" },
      purpose: { column: "purpose", label: "Purpose", kind: "text" },
      model: { column: "model", label: "Model", kind: "text" },
      provider: { column: "provider", label: "Provider", kind: "text" },
      tier: { column: "tier", label: "Tier", kind: "text" },
      outcome: { column: "outcome", label: "Outcome", kind: "text" }
    },
    metrics: {
      calls: { label: "Calls", kind: "number", agg: "count" },
      tokensIn: { label: "Tokens in", kind: "number", agg: "sum", column: "tokens_in" },
      tokensOut: { label: "Tokens out", kind: "number", agg: "sum", column: "tokens_out" },
      costMicro: { label: "Cost (micro)", kind: "number", agg: "sum", column: "cost_micro" },
      latency: { label: "Latency ms", kind: "number", agg: "avg", column: "latency_ms" }
    }
  },
  conversations: {
    table: "orbit_conversations",
    module: "orbit",
    permission: "orbit:conversations:read",
    timeColumn: "created_at",
    dimensions: {
      channel: { column: "channel", label: "Channel", kind: "text" },
      state: { column: "state", label: "State", kind: "text" },
      assigneeRef: { column: "assignee_ref", label: "Assignee", kind: "text" }
    },
    metrics: { conversations: { label: "Conversations", kind: "number", agg: "count" } }
  },
  campaigns: {
    table: "signal_campaigns",
    module: "signal",
    permission: "signal:campaigns:read",
    timeColumn: "created_at",
    dimensions: {
      state: { column: "state", label: "State", kind: "text" },
      objective: { column: "objective", label: "Objective", kind: "text" },
      autonomyLevel: { column: "autonomy_level", label: "Autonomy", kind: "text" },
      ownerRef: { column: "owner_ref", label: "Owner", kind: "text" }
    },
    metrics: {
      campaigns: { label: "Campaigns", kind: "number", agg: "count" }
    },
    baseFilter: "deleted_at is null"
  },
  // Budget lives in campaigns as JSON, so money questions are answered from the
  // spend ledger instead — one row per campaign, channel and day.
  spend: {
    table: "signal_spend",
    module: "signal",
    permission: "signal:spend:read",
    timeColumn: "ts",
    dimensions: {
      campaignId: { column: "campaign_id", label: "Campaign", kind: "text" },
      channel: { column: "channel", label: "Channel", kind: "text" },
      currency: { column: "currency", label: "Currency", kind: "text" },
      source: { column: "source", label: "Source", kind: "text" }
    },
    metrics: {
      spend: { label: "Spend", kind: "money", agg: "sum", column: "amount_minor" },
      impressions: { label: "Impressions", kind: "number", agg: "sum", column: "impressions" },
      clicks: { label: "Clicks", kind: "number", agg: "sum", column: "clicks" },
      conversions: { label: "Conversions", kind: "number", agg: "sum", column: "conversions" }
    }
  },
  signals: {
    table: "scout_signals",
    module: "scout",
    permission: "scout:signals:read",
    timeColumn: "observed_at",
    dimensions: {
      source: { column: "source", label: "Source", kind: "text" },
      clusterId: { column: "cluster_id", label: "Cluster", kind: "text" }
    },
    metrics: {
      signals: { label: "Signals", kind: "number", agg: "count" },
      weight: { label: "Weight", kind: "number", agg: "sum", column: "weight" }
    }
  },
  whitespaces: {
    table: "scout_whitespaces",
    module: "scout",
    permission: "scout:whitespaces:read",
    timeColumn: "created_at",
    dimensions: {
      status: { column: "status", label: "Status", kind: "text" },
      clusterId: { column: "cluster_id", label: "Cluster", kind: "text" },
      owner: { column: "owner", label: "Owner", kind: "text" }
    },
    metrics: {
      whitespaces: { label: "Whitespaces", kind: "number", agg: "count" },
      demand: { label: "Demand estimate", kind: "number", agg: "sum", column: "demand_estimate" },
      avgCompetition: { label: "Average competition score", kind: "number", agg: "avg", column: "competition_score" }
    }
  },
  // docs/27 P2: only signals and whitespaces were registered, so a caller
  // asking "how are clusters trending", "how are our experiments doing" or
  // "what data products have we published" could not build a report at all —
  // the same semantic layer that already answers those questions for every
  // other SCOUT table.
  //
  // Deliberately NOT here: scout_panel_bench. `runReport` aggregates whatever
  // the caller's filters and group-by select, with no floor check — the exact
  // re-identification risk `checkKAnonymity`/`rowVisible` exist to close on the
  // CRUD path (docs/modules/scout.md §2.5, resources.ts panel-bench). A generic
  // report grouped by provider+line+period would hand back a thin cell's exact
  // number and name the one counterparty behind it. scout-analytics.tsx already
  // documents this same decision for the export card; the two agree on purpose.
  clusters: {
    table: "scout_clusters",
    module: "scout",
    permission: "scout:clusters:read",
    timeColumn: "last_seen",
    dimensions: {
      theme: { column: "theme", label: "Theme", kind: "text" }
    },
    metrics: {
      clusters: { label: "Clusters", kind: "number", agg: "count" },
      avgMomentum: { label: "Average momentum", kind: "number", agg: "avg", column: "momentum_score" },
      size: { label: "Signal count", kind: "number", agg: "sum", column: "size" }
    }
  },
  experiments: {
    table: "scout_experiments",
    module: "scout",
    permission: "scout:experiments:read",
    timeColumn: "created_at",
    dimensions: {
      whitespaceId: { column: "whitespace_id", label: "Whitespace", kind: "text" },
      state: { column: "state", label: "State", kind: "text" }
    },
    metrics: {
      experiments: { label: "Experiments", kind: "number", agg: "count" }
    }
  },
  dataProducts: {
    table: "scout_data_products",
    module: "scout",
    permission: "scout:data_products:read",
    timeColumn: "created_at",
    dimensions: {
      name: { column: "name", label: "Name", kind: "text" },
      status: { column: "status", label: "Status", kind: "text" },
      delivery: { column: "delivery", label: "Delivery", kind: "text" }
    },
    metrics: {
      dataProducts: { label: "Data products", kind: "number", agg: "count" },
      avgFloor: { label: "Average k-anonymity floor", kind: "number", agg: "avg", column: "aggregation_min" }
    }
  },
  boardpacks: {
    table: "north_boardpacks",
    module: "north",
    permission: "north:boardpacks:read",
    timeColumn: "created_at",
    dimensions: {
      period: { column: "period", label: "Period", kind: "text" },
      status: { column: "status", label: "Status", kind: "text" },
      approvedBy: { column: "approved_by", label: "Approved by", kind: "text" }
    },
    metrics: {
      boardpacks: { label: "Boardpacks", kind: "number", agg: "count" }
    }
  },
  decisions: {
    table: "north_decisions",
    module: "north",
    permission: "north:decisions:read",
    timeColumn: "created_at",
    dimensions: {
      status: { column: "status", label: "Status", kind: "text" },
      owner: { column: "owner", label: "Owner", kind: "text" },
      chosen: { column: "chosen", label: "Chosen option", kind: "text" }
    },
    metrics: {
      decisions: { label: "Decisions", kind: "number", agg: "count" }
    }
  }
};

export type Grain = "none" | "day" | "week" | "month" | "quarter" | "year";

export interface Filter {
  field: string;
  op: "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "contains" | "is_null" | "not_null";
  value?: string | number | (string | number)[] | undefined;
}

export interface ReportDefinition {
  dataset: string;
  metrics: string[];
  dimensions?: string[] | undefined;
  filters?: Filter[] | undefined;
  grain?: Grain | undefined;
  from?: number | undefined;
  to?: number | undefined;
  sort?: { field: string; dir: "asc" | "desc" } | undefined;
  limit?: number | undefined;
}

/** Hard ceiling on any single materialisation; bigger jobs export, not render. */
export const MAX_ROWS = 50_000;

const GRAIN_FORMAT: Record<Exclude<Grain, "none">, string> = {
  day: "%Y-%m-%d",
  week: "%Y-W%W",
  month: "%Y-%m",
  quarter: "%Y-%m", // refined below — SQLite has no quarter token
  year: "%Y"
};

export interface RunResult extends ReportTable {
  rowCount: number;
  truncated: boolean;
  definition: ReportDefinition;
}

/**
 * Materialise one report. Every identifier that reaches the SQL string is looked
 * up in the dataset registry first, and every value is a bound parameter.
 */
export async function runReport(
  ctx: Ctx,
  def: ReportDefinition,
  opts: { unmasked?: boolean; title?: string } = {}
): Promise<RunResult> {
  const ds = DATASETS[def.dataset];
  if (!ds) throw badRequest(`unknown dataset ${def.dataset}`);
  if (!def.metrics.length) throw badRequest("a report needs at least one metric");

  const grain: Grain = def.grain ?? "none";
  const selects: string[] = [];
  const groups: string[] = [];
  const columns: ReportTable["columns"] = [];
  const maskedKeys: string[] = [];

  if (grain !== "none") {
    selects.push(`${bucket(ds.timeColumn, grain)} as "period"`);
    groups.push(`"period"`);
    columns.push({ key: "period", label: "Period", kind: "text" });
  }

  for (const key of def.dimensions ?? []) {
    const dim = ds.dimensions[key];
    if (!dim) throw badRequest(`unknown dimension ${key} on ${def.dataset}`);
    // A PII dimension without the unmasked permission is pseudonymised, not
    // dropped: the operator still sees "how many per customer", never which
    // customer. Masking happens after grouping — masking inside the SQL would
    // collapse distinct customers whose identifiers share a prefix.
    if (dim.pii && !opts.unmasked) maskedKeys.push(key);
    selects.push(`${dim.column} as "${key}"`);
    groups.push(`"${key}"`);
    columns.push({ key, label: dim.label, kind: dim.kind });
  }

  for (const key of def.metrics) {
    const m = ds.metrics[key];
    if (!m) throw badRequest(`unknown metric ${key} on ${def.dataset}`);
    selects.push(`${aggregate(m)} as "${key}"`);
    columns.push({ key, label: m.label, kind: m.kind });
  }

  const params: unknown[] = [ctx.tenantId];
  const where: string[] = ["tenant_id = ?"];
  if (ds.baseFilter) where.push(ds.baseFilter);
  if (def.from !== undefined) {
    where.push(`${ds.timeColumn} >= ?`);
    params.push(def.from);
  }
  if (def.to !== undefined) {
    where.push(`${ds.timeColumn} <= ?`);
    params.push(def.to);
  }
  for (const f of def.filters ?? []) {
    const field = ds.dimensions[f.field] ?? (ds.metrics[f.field] ? { column: ds.metrics[f.field]!.column } : undefined);
    if (!field?.column) throw badRequest(`unknown filter field ${f.field}`);
    where.push(condition(field.column, f, params));
  }

  const orderBy = sortClause(def, ds, grain);
  const limit = Math.min(def.limit ?? 1000, MAX_ROWS);

  const text =
    `select ${selects.join(", ")} from ${ds.table} where ${where.join(" and ")}` +
    (groups.length ? ` group by ${groups.join(", ")}` : "") +
    (orderBy ? ` order by ${orderBy}` : "") +
    ` limit ${limit + 1}`;

  const raw = await ctx.db.all<Record<string, unknown>>(sql.raw(bind(text, params)));
  const truncated = raw.length > limit;
  const rows = truncated ? raw.slice(0, limit) : raw;
  if (maskedKeys.length) await mask(ctx, rows, maskedKeys);

  return {
    title: opts.title ?? `${def.dataset} report`,
    columns,
    rows,
    currency: ctx.policy.currency,
    generatedAt: ctx.now,
    rowCount: rows.length,
    truncated,
    definition: def
  };
}

/* --------------------------------------------------------------- feed (row) */

export interface FeedPage {
  /** Physical rows, keyed by column name — the shape a warehouse wants to land. */
  rows: Record<string, unknown>[];
  /** True when another page is waiting behind this one. */
  more: boolean;
}

/**
 * Row-level read of one dataset for warehouse-out (ANL-010). Same registry, same
 * tenant guard as `runReport`; the difference is that nothing is aggregated, so
 * a BI tool can model the grain itself.
 *
 * ponytail: NDJSON over a keyset cursor, not Parquet to the customer's bucket.
 * A warehouse polls this; when someone asks for Parquet, the column list below
 * is already the schema to write.
 */
export async function feedRows(
  ctx: Ctx,
  datasetKey: string,
  opts: { since?: number | undefined; after?: { value: number; id: string } | undefined; limit: number }
): Promise<FeedPage> {
  const ds = DATASETS[datasetKey];
  if (!ds) throw badRequest(`unknown dataset ${datasetKey}`);

  const columns = feedColumns(ds);
  const params: unknown[] = [ctx.tenantId];
  // Every row carries its tenant, and every query is filtered by it: a warehouse
  // that lands two tenants in one table is the failure this line prevents.
  const where: string[] = ["tenant_id = ?"];
  if (ds.baseFilter) where.push(ds.baseFilter);
  if (opts.since !== undefined) {
    where.push(`${ds.timeColumn} >= ?`);
    params.push(opts.since);
  }
  if (opts.after) {
    // Keyset over (time, id): the same tuple the cursor encodes, so a poll that
    // resumes mid-second neither repeats nor skips a row.
    where.push(`(${ds.timeColumn} > ? or (${ds.timeColumn} = ? and id > ?))`);
    params.push(opts.after.value, opts.after.value, opts.after.id);
  }

  const text =
    `select ${columns.join(", ")} from ${ds.table} where ${where.join(" and ")}` +
    ` order by ${ds.timeColumn} asc, id asc limit ${opts.limit + 1}`;

  const raw = await ctx.db.all<Record<string, unknown>>(sql.raw(bind(text, params)));
  const more = raw.length > opts.limit;
  return { rows: more ? raw.slice(0, opts.limit) : raw, more };
}

/** id, tenant, time and every registered column — never `select *`. */
function feedColumns(ds: Dataset): string[] {
  return [
    ...new Set([
      "id",
      "tenant_id",
      ds.timeColumn,
      ...Object.values(ds.dimensions).map((d) => d.column),
      ...Object.values(ds.metrics).flatMap((m) => (m.column ? [m.column] : []))
    ])
  ];
}

/** Which feed columns hold PII, for the masker in the route. */
export function feedPiiColumns(ds: Dataset): string[] {
  return Object.values(ds.dimensions)
    .filter((d) => d.pii)
    .map((d) => d.column);
}

/* ------------------------------------------------------------------ helpers */

/**
 * Replace each PII value with a stable pseudonym. Salted with the tenant so the
 * same identifier is not comparable across tenants, and cached so one report
 * hashes each distinct value once.
 */
async function mask(ctx: Ctx, rows: Record<string, unknown>[], keys: string[]): Promise<void> {
  const seen = new Map<string, string>();
  for (const row of rows) {
    for (const key of keys) {
      const value = row[key];
      if (value === null || value === undefined) continue;
      const raw = String(value);
      let token = seen.get(raw);
      if (token === undefined) {
        token = (await sha256Hex(`${ctx.tenantId}:${raw}`)).slice(0, 12);
        seen.set(raw, token);
      }
      row[key] = token;
    }
  }
}

function aggregate(m: Metric): string {
  if (m.agg === "count") return "count(*)";
  if (!m.column) throw badRequest(`metric needs a column for ${m.agg}`);
  if (m.agg === "count_distinct") return `count(distinct ${m.column})`;
  // avg of an integer minor amount is rounded back to minor units, because half
  // a fils in a report column is noise nobody can reconcile against.
  return m.agg === "avg" ? `cast(round(avg(${m.column})) as integer)` : `${m.agg}(${m.column})`;
}

function bucket(column: string, grain: Grain): string {
  if (grain === "quarter") {
    // strftime has no quarter token, so derive it from the month.
    return `strftime('%Y', ${column} / 1000, 'unixepoch') || '-Q' || ((cast(strftime('%m', ${column} / 1000, 'unixepoch') as integer) + 2) / 3)`;
  }
  return `strftime('${GRAIN_FORMAT[grain as Exclude<Grain, "none">]}', ${column} / 1000, 'unixepoch')`;
}

function condition(column: string, f: Filter, params: unknown[]): string {
  switch (f.op) {
    case "is_null":
      return `${column} is null`;
    case "not_null":
      return `${column} is not null`;
    case "in": {
      const list = Array.isArray(f.value) ? f.value : [f.value];
      if (!list.length) return "1 = 0";
      params.push(...list);
      return `${column} in (${list.map(() => "?").join(", ")})`;
    }
    case "contains":
      params.push(`%${String(f.value)}%`);
      return `${column} like ?`;
    default: {
      const ops = { eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
      params.push(f.value);
      return `${column} ${ops[f.op]} ?`;
    }
  }
}

function sortClause(def: ReportDefinition, ds: Dataset, grain: Grain): string {
  if (def.sort) {
    const known =
      def.sort.field === "period" ? grain !== "none" : Boolean(ds.dimensions[def.sort.field] ?? ds.metrics[def.sort.field]);
    if (!known) throw badRequest(`cannot sort by ${def.sort.field}`);
    return `"${def.sort.field}" ${def.sort.dir === "asc" ? "asc" : "desc"}`;
  }
  if (grain !== "none") return `"period" asc`;
  const first = def.metrics[0];
  return first ? `"${first}" desc` : "";
}

/**
 * Inline the bound values. Drizzle's `all()` takes a prepared SQL object; the
 * placeholders here are ours, and every value has already been through zod, so
 * escaping is a quote-double and a numeric check — nothing user-shaped reaches
 * an identifier position.
 */
function bind(text: string, params: readonly unknown[]): string {
  let i = 0;
  return text.replace(/\?/g, () => literal(params[i++]));
}

function literal(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw badRequest("non-finite number in filter");
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
}

/** Totals row for the money columns — every enterprise report is asked for one. */
export function totalsOf(result: RunResult): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const col of result.columns) {
    if (col.kind !== "money" && col.kind !== "number") continue;
    totals[col.key] = result.rows.reduce((s, r) => s + (Number(r[col.key]) || 0), 0);
  }
  return totals;
}

/** Tenant scoping belongs in every query this engine writes; this proves it. */
export function tenantGuard(ctx: Ctx): SQL {
  return and(sql`tenant_id = ${ctx.tenantId}`)!;
}

export { schema };

import { z } from "zod";

// docs/09. What a report asks the semantic layer, as one schema every reader of
// a definition validates with: POST /v1/analytics/run, /reports and /exports
// (apps/api/src/routes/analytics.ts), and the `analytics.ask` purpose that
// compiles a question into one (packages/model-gateway/src/analytics-ask.ts).
// A definition a model wrote is held to exactly the bounds a hand-built one is
// — one schema, so the two cannot drift.
//
// The schema is shape and bounds only. Whether `dataset`, a metric or a
// dimension *exists* is the registry's question (apps/api/src/engines/report.ts
// `DATASETS`), because only the registry knows.

/** Hard ceiling on any single materialisation; bigger jobs export, not render. */
export const REPORT_MAX_ROWS = 50_000;

export const REPORT_GRAINS = ["none", "day", "week", "month", "quarter", "year"] as const;
export const REPORT_FILTER_OPS = ["eq", "neq", "in", "gt", "gte", "lt", "lte", "contains", "is_null", "not_null"] as const;

export const ReportFilterSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(REPORT_FILTER_OPS),
  value: z.union([z.string().max(200), z.number(), z.array(z.union([z.string().max(200), z.number()])).max(200)]).optional()
});

export const ReportDefinitionSchema = z.object({
  dataset: z.string().min(1).max(64),
  metrics: z.array(z.string().min(1).max(64)).min(1).max(12),
  dimensions: z.array(z.string().min(1).max(64)).max(6).optional(),
  filters: z.array(ReportFilterSchema).max(20).optional(),
  grain: z.enum(REPORT_GRAINS).optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  sort: z.object({ field: z.string().min(1).max(64), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(REPORT_MAX_ROWS).optional()
});

export type ReportGrain = (typeof REPORT_GRAINS)[number];
export type ReportFilter = z.infer<typeof ReportFilterSchema>;
export type ReportDefinition = z.infer<typeof ReportDefinitionSchema>;

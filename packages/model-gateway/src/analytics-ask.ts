import type { ReportDefinition } from "@lyra/core";

// docs/05 §analytics ("ask a question in words → compiled to a visible,
// editable query"), docs/17 ANL-009. Stub: the eval (evals/analytics-ask) is
// authored first and must fail against this.

export interface AskCatalogueEntry {
  key: string;
  module?: string;
  dimensions: { key: string; label: string; kind: string }[];
  metrics: { key: string; label: string; kind: string }[];
}

export type AskRefusal = "unparseable";

export type AskResult =
  | { ok: true; definition: ReportDefinition; why: string }
  | { ok: false; reason: AskRefusal };

export function parseAnalyticsAsk(_reply: string, _catalogue: AskCatalogueEntry[], _now: number): AskResult {
  return { ok: false, reason: "unparseable" };
}

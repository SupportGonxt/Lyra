import { describe, expect, it } from "vitest";
import type { BriefingSnapshot } from "@lyra/core";
import { composeTemplateBrief, templateLocale, type TemplateAnomaly, type TemplateMetric } from "./north-brief-template.js";

// J-E1, docs/06 "the 7am read": the morning brief must exist with no model
// configured. The template is the floor under the narrator — every number in
// it is read straight off the snapshot, so it needs no verifier, and it is
// written in the reader's language rather than in English stored under `ar`.

const snapshot: BriefingSnapshot = {
  tenantId: "t1",
  date: "2026-01-06",
  metrics: [
    {
      metricKey: "policies_issued",
      name: "Issued today",
      unit: "count",
      currency: null,
      grain: "day",
      period: "2026-01-05",
      value: 57,
      previousPeriod: "2026-01-04",
      previousValue: 61,
      deltaBps: -656
    },
    {
      metricKey: "gwp",
      name: "Written volume",
      unit: "money",
      currency: "AED",
      grain: "month",
      period: "2026-01",
      value: 74_300_000,
      previousPeriod: "2025-12",
      previousValue: 238_900_000,
      deltaBps: -6890
    },
    {
      metricKey: "quote_latency",
      name: "Quote latency",
      unit: "duration_ms",
      currency: null,
      grain: "day",
      period: "2026-01-05",
      value: 840,
      previousPeriod: null,
      previousValue: null,
      deltaBps: null
    }
  ]
};

const metricsEn = new Map<string, TemplateMetric>([
  ["policies_issued", { name: "Issued today", unit: "count", currency: null }],
  ["gwp", { name: "Written volume", unit: "money", currency: "AED" }],
  ["quote_to_bind_rate", { name: "Bind rate", unit: "percent", currency: null }]
]);

const anomalies: TemplateAnomaly[] = [
  { metricKey: "quote_to_bind_rate", window: "2026-01-05", magnitude: -1992, expected: 2_360, actual: 1_890 }
];

describe("composeTemplateBrief", () => {
  it("leads with the largest move and states every metric with its own figures", () => {
    // Intl puts a no-break space between a currency code and its amount.
    const text = composeTemplateBrief({ snapshot, anomalies, metrics: metricsEn, locale: "en" }).replace(/ /g, " ");
    const [lead, body, open] = text.split("\n\n");
    // gwp moved -68.9%, the largest absolute delta, so it leads.
    expect(lead).toContain("Written volume");
    expect(lead).toContain("AED 743,000.00");
    expect(lead).toContain("68.9%");
    expect(lead).toContain("down");
    expect(body).toContain("Issued today");
    expect(body).toContain("57");
    expect(body).toContain("6.6%");
    // No prior period: stated, never given a made-up delta.
    expect(body).toContain("Quote latency");
    expect(body).toContain("840");
    expect(open).toContain("Bind rate");
    expect(open).toContain("23.6%");
    expect(open).toContain("18.9%");
  });

  it("writes the Arabic brief in Arabic, with no English template prose in it", () => {
    const metricsAr = new Map<string, TemplateMetric>([
      ["policies_issued", { name: "الصادرة اليوم", unit: "count", currency: null }],
      ["gwp", { name: "الحجم المكتتب", unit: "money", currency: "AED" }],
      ["quote_latency", { name: "زمن التسعير", unit: "duration_ms", currency: null }],
      ["quote_to_bind_rate", { name: "معدل الإصدار", unit: "percent", currency: null }]
    ]);
    const arSnapshot = {
      ...snapshot,
      metrics: snapshot.metrics.map((m) => ({ ...m, name: metricsAr.get(m.metricKey)!.name }))
    };
    const text = composeTemplateBrief({ snapshot: arSnapshot, anomalies, metrics: metricsAr, locale: "ar" });
    expect(text).toContain("الحجم المكتتب");
    expect(text).toContain("معدل الإصدار");
    // Every Latin letter would be English template prose leaking through.
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).toMatch(/[؀-ۿ]/);
  });

  it("says plainly when nothing has closed and nothing is open", () => {
    const empty = { tenantId: "t1", date: "2099-01-01", metrics: [] };
    const en = composeTemplateBrief({ snapshot: empty, anomalies: [], metrics: new Map(), locale: "en" });
    expect(en).toMatch(/no metric has closed/i);
    expect(en).toMatch(/no anomaly is open/i);
    const ar = composeTemplateBrief({ snapshot: empty, anomalies: [], metrics: new Map(), locale: "ar" });
    expect(ar).not.toMatch(/[A-Za-z]/);
  });

  it("ends its lead with a sentence break, so the brief screen can headline it", () => {
    const text = composeTemplateBrief({ snapshot, anomalies: [], metrics: metricsEn, locale: "en" });
    expect(text.split("\n\n")[0]).toMatch(/\.$/);
  });
});

describe("templateLocale", () => {
  it("writes in the languages it has a catalogue for, and in English otherwise", () => {
    expect(templateLocale("ar")).toBe("ar");
    expect(templateLocale("en")).toBe("en");
    expect(templateLocale("fr")).toBe("en");
  });
});

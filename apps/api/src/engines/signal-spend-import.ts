import { and, eq, isNull } from "drizzle-orm";
import { id as newId, schema } from "@lyra/db";
import { audit, emit, type Ctx } from "@lyra/core";
import { parseCsv, type RowError } from "./axis-case-import.js";

// docs/30 SIGNAL gap 1. Spend actuals from an ad-platform export (CSV). The
// same per-line honesty as the case import: every line is written or named in
// `errors`. A (campaign, channel, day) already held is corrected, not doubled —
// platforms restate yesterday, and the autopilot's CAC must see the restatement.

const REQUIRED = ["day", "channel", "amountMinor", "currency"] as const;
const COUNTS = ["impressions", "clicks", "conversions"] as const;

export interface SpendImportResult {
  created: number;
  updated: number;
  errors: RowError[];
}

const wholeOrZero = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return 0;
  return /^\d+$/.test(v) ? Number(v) : null;
};

function realDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export async function importSpend(ctx: Ctx, csv: string): Promise<SpendImportResult> {
  const { header, rows, parseErrors } = parseCsv(csv);
  const missing = REQUIRED.find((c) => !header.includes(c));
  if (missing && !parseErrors.length) return { created: 0, updated: 0, errors: [{ line: 1, ref: null, error: `missing column ${missing}` }] };
  const out: SpendImportResult = { created: 0, updated: 0, errors: [...parseErrors] };
  if (missing) return out;

  const campaigns = new Set(
    (await ctx.db.select({ id: schema.signalCampaigns.id }).from(schema.signalCampaigns).where(eq(schema.signalCampaigns.tenantId, ctx.tenantId))).map(
      (c) => c.id
    )
  );

  for (const { line, cells } of rows) {
    const fail = (error: string) => out.errors.push({ line, ref: cells.day || null, error });
    const campaignId = cells.campaignId || null;
    const amount = cells.amountMinor ?? "";
    if (!realDay(cells.day ?? "")) { fail("day must be a real YYYY-MM-DD date"); continue; }
    if (campaignId && !campaigns.has(campaignId)) { fail(`no campaign ${campaignId}`); continue; }
    if (!cells.channel) { fail("channel is required"); continue; }
    if (!/^\d+$/.test(amount)) { fail("amountMinor must be a whole number of minor units, 0 or more"); continue; }
    if (!/^[A-Z]{3}$/.test(cells.currency ?? "")) { fail("currency must be a 3-letter ISO code"); continue; }
    const counts = Object.fromEntries(COUNTS.map((k) => [k, wholeOrZero(cells[k])])) as Record<(typeof COUNTS)[number], number | null>;
    const bad = COUNTS.find((k) => counts[k] === null);
    if (bad) { fail(`${bad} must be a whole number, 0 or more`); continue; }

    const values = {
      amountMinor: Number(amount),
      currency: cells.currency!,
      impressions: counts.impressions!,
      clicks: counts.clicks!,
      conversions: counts.conversions!,
      source: "import",
      ts: ctx.now
    };
    // Looked up rather than upserted: a null campaign is distinct to SQLite's
    // unique index, so ON CONFLICT would never fire for channel-level spend.
    const [held] = await ctx.db
      .select({ id: schema.signalSpend.id })
      .from(schema.signalSpend)
      .where(
        and(
          eq(schema.signalSpend.tenantId, ctx.tenantId),
          campaignId ? eq(schema.signalSpend.campaignId, campaignId) : isNull(schema.signalSpend.campaignId),
          eq(schema.signalSpend.channel, cells.channel),
          eq(schema.signalSpend.day, cells.day!)
        )
      )
      .limit(1);
    const id = held?.id ?? newId("spd", ctx.now);
    if (held) {
      await ctx.db.update(schema.signalSpend).set(values).where(eq(schema.signalSpend.id, id));
      out.updated++;
    } else {
      await ctx.db.insert(schema.signalSpend).values({ id, tenantId: ctx.tenantId, campaignId, channel: cells.channel, day: cells.day!, ...values });
      out.created++;
    }
    // The same announcement a CRUD write makes (resources.ts spend afterWrite).
    await emit(ctx, {
      module: "signal",
      type: "signal.spend.recorded",
      subject: id,
      data: { campaignId, channel: cells.channel, day: cells.day, amountMinor: values.amountMinor, currency: values.currency, conversions: values.conversions }
    });
  }
  await audit(ctx, { action: "signal.spend.imported", subjectRef: "signal_spend:import", after: { created: out.created, updated: out.updated, errors: out.errors.length } });
  return out;
}

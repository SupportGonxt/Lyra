import { and, eq, gte, inArray, lt } from "drizzle-orm";
import { z } from "zod";
import { id as newId, schema } from "@lyra/db";
import { actorRef, AppError, audit, badRequest, conflict, emit, scoped, type Ctx } from "@lyra/core";
import { IsoMonth, monthRangeMs } from "../http.js";
import { parseCsv, type RowError } from "./axis-case-import.js";
import { FIELDS_BY_KIND, matchBordereau, type AmountField, type MatchGroup, type MatchLine } from "./bordereau-match.js";

// docs/27 §E. A bordereau is the periodic reconciliation file between us and
// a provider/channel/partner: what we say happened this period vs what they
// say happened. Outbound is generated straight from our own ledger data;
// inbound is whatever lines the counterparty handed us — as JSON, or as a CSV
// read row-honestly by importInboundBordereau — matched against the same
// records outbound generation reads (ourRecords) by reconcileBordereaux.
//
// docs/30 Ledger 5, ADR-0105: reconciliation only *reports*. It classifies
// (matched / variance / missing_ours / missing_theirs, bordereau-match.ts) and
// stamps their lines; it never writes a commission entry, a journal line or a
// settlement. Resolving a discrepancy that moves money goes through the paths
// that already carry the approval and the idempotency key — the commission
// entry's clawback (`dist.commission_adjust`) — which the screen links to.

type BordereauRow = typeof schema.axisBordereaux.$inferSelect;
type LineInsert = typeof schema.axisBordereauLines.$inferInsert;
type LineRow = typeof schema.axisBordereauLines.$inferSelect;

const Currency = z.string().regex(/^[A-Z]{3}$/, "currency must be a three-letter ISO 4217 code");

const RawLine = z.object({
  externalRef: z.string().min(1).max(200),
  policyId: z.string().nullish(),
  riskRef: z.string().max(200).nullish(),
  /** The line's own currency; the bordereau's when absent. */
  currency: Currency.optional(),
  grossPremiumMinor: z.number().int().default(0),
  taxMinor: z.number().int().default(0),
  netPremiumMinor: z.number().int().default(0),
  commissionMinor: z.number().int().default(0),
  claimsPaidMinor: z.number().int().default(0),
  reserveMinor: z.number().int().default(0),
  /** The CSV row verbatim, when the line came from a file (`rawJson`). */
  cells: z.record(z.string(), z.string()).optional()
});

const BordereauHeader = {
  counterpartyKind: z.enum(["provider", "channel", "partner"]),
  counterpartyId: z.string().min(1),
  kind: z.enum(["premium", "claims", "combined"]),
  // `IsoMonth`, not the bare shape: `2026-13` matched, and the bounds rolled it
  // into January 2027 — a regulatory return labelled one month and summing
  // another, with nothing to notice it. `monthRangeMs` closes the matching hole
  // on the year axis.
  period: IsoMonth,
  currency: Currency.default("AED")
};

export const GenerateBordereauBody = z.object({
  direction: z.enum(["inbound", "outbound"]),
  ...BordereauHeader,
  lines: z.array(RawLine).default([])
});
export type GenerateBordereauInput = z.infer<typeof GenerateBordereauBody>;

/** The header an inbound CSV import carries beside its file. */
export const ImportBordereauBody = z.object(BordereauHeader);
export type ImportBordereauInput = z.infer<typeof ImportBordereauBody>;

export const ReconcileBody = z.object({
  toleranceMinor: z.number().int().min(0).max(1_000_000).optional()
});

/** One of our own records for the period — what outbound reports and inbound is matched against. */
interface OurRecord {
  id: string;
  resource: "commission-entries" | "claims";
  policyId: string | null;
  policyVersionId: string | null;
  claimId: string | null;
  ref: string;
  currency: string;
  grossPremiumMinor: number;
  taxMinor: number;
  commissionMinor: number;
  claimsPaidMinor: number;
  reserveMinor: number;
}

async function policyNos(ctx: Ctx, policyIds: string[]): Promise<Map<string, string>> {
  if (policyIds.length === 0) return new Map();
  const rows = await ctx.db
    .select({ id: schema.axisPolicies.id, policyNo: schema.axisPolicies.policyNo })
    .from(schema.axisPolicies)
    .where(and(eq(schema.axisPolicies.tenantId, ctx.tenantId), inArray(schema.axisPolicies.id, policyIds)));
  return new Map(rows.map((r) => [r.id, r.policyNo]));
}

async function ourRecords(
  ctx: Ctx,
  input: { kind: GenerateBordereauInput["kind"]; counterpartyId: string; period: string }
): Promise<OurRecord[]> {
  const { start, end } = monthRangeMs(input.period);
  const records: OurRecord[] = [];

  if (input.kind === "premium" || input.kind === "combined") {
    // dist_commission_entries.providerId is copied from the policy at accrual
    // time (see dist.ts /commission-entries/accrue), so this filters directly
    // with no join through policies/policy versions.
    const entries = await ctx.db
      .select()
      .from(schema.distCommissionEntries)
      .where(
        and(
          eq(schema.distCommissionEntries.tenantId, ctx.tenantId),
          eq(schema.distCommissionEntries.providerId, input.counterpartyId),
          gte(schema.distCommissionEntries.earnedAt, start),
          lt(schema.distCommissionEntries.earnedAt, end)
        )
      );
    const numbers = await policyNos(ctx, [...new Set(entries.flatMap((e) => (e.policyId ? [e.policyId] : [])))]);
    for (const entry of entries) {
      records.push({
        id: entry.id,
        resource: "commission-entries",
        policyId: entry.policyId,
        policyVersionId: null,
        claimId: null,
        // A sale booked without AXIS (ADR-0094) has no policy number to be
        // listed under; its sale reference is the only honest key it has.
        ref: (entry.policyId ? numbers.get(entry.policyId) : undefined) ?? entry.saleRef ?? entry.id,
        currency: entry.currency,
        grossPremiumMinor: entry.premiumMinor,
        taxMinor: entry.taxMinor,
        commissionMinor: entry.grossCommissionMinor,
        claimsPaidMinor: 0,
        reserveMinor: 0
      });
    }
  }

  if (input.kind === "claims" || input.kind === "combined") {
    const rows = await ctx.db
      .select({ claim: schema.axisClaims, policyNo: schema.axisPolicies.policyNo })
      .from(schema.axisClaims)
      .innerJoin(schema.axisPolicies, eq(schema.axisClaims.policyId, schema.axisPolicies.id))
      .where(
        and(
          eq(schema.axisClaims.tenantId, ctx.tenantId),
          eq(schema.axisPolicies.providerId, input.counterpartyId),
          gte(schema.axisClaims.updatedAt, start),
          lt(schema.axisClaims.updatedAt, end)
        )
      );
    for (const { claim, policyNo } of rows) {
      records.push({
        id: claim.id,
        resource: "claims",
        policyId: claim.policyId,
        policyVersionId: claim.policyVersionId,
        claimId: claim.id,
        ref: policyNo,
        currency: claim.currency,
        grossPremiumMinor: 0,
        taxMinor: 0,
        commissionMinor: 0,
        claimsPaidMinor: claim.paidMinor,
        reserveMinor: claim.reserveMinor
      });
    }
  }

  return records;
}

async function buildOutboundLines(ctx: Ctx, input: GenerateBordereauInput, bordereauId: string): Promise<LineInsert[]> {
  const records = await ourRecords(ctx, input);
  return records.map((r, i) => ({
    id: newId("bdxl", ctx.now),
    tenantId: ctx.tenantId,
    bordereauId,
    lineNo: i + 1,
    policyId: r.policyId,
    policyVersionId: r.policyVersionId,
    claimId: r.claimId,
    externalRef: null,
    riskRef: null,
    effectiveFrom: null,
    effectiveTo: null,
    grossPremiumMinor: r.grossPremiumMinor,
    taxMinor: r.taxMinor,
    netPremiumMinor: r.grossPremiumMinor - r.taxMinor,
    commissionMinor: r.commissionMinor,
    claimsPaidMinor: r.claimsPaidMinor,
    reserveMinor: r.reserveMinor,
    currency: r.currency,
    matchState: "unmatched",
    varianceMinor: 0,
    rawJson: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  }));
}

function buildInboundLines(ctx: Ctx, input: GenerateBordereauInput, bordereauId: string): LineInsert[] {
  return input.lines.map((raw, i) => {
    const { cells, ...line } = raw;
    return {
      id: newId("bdxl", ctx.now),
      tenantId: ctx.tenantId,
      bordereauId,
      lineNo: i + 1,
      policyId: line.policyId ?? null,
      policyVersionId: null,
      claimId: null,
      externalRef: line.externalRef,
      riskRef: line.riskRef ?? null,
      effectiveFrom: null,
      effectiveTo: null,
      grossPremiumMinor: line.grossPremiumMinor,
      taxMinor: line.taxMinor,
      netPremiumMinor: line.netPremiumMinor || line.grossPremiumMinor - line.taxMinor,
      commissionMinor: line.commissionMinor,
      claimsPaidMinor: line.claimsPaidMinor,
      reserveMinor: line.reserveMinor,
      currency: line.currency ?? input.currency,
      matchState: "unmatched",
      varianceMinor: 0,
      rawJson: JSON.stringify(cells ?? line),
      createdAt: ctx.now,
      updatedAt: ctx.now
    };
  });
}

async function replaceLines(ctx: Ctx, bordereauId: string, lines: LineInsert[]): Promise<void> {
  await ctx.db
    .delete(schema.axisBordereauLines)
    .where(scoped(ctx, schema.axisBordereauLines, eq(schema.axisBordereauLines.bordereauId, bordereauId)));
  if (lines.length > 0) await ctx.db.insert(schema.axisBordereauLines).values(lines);
}

function totals(lines: LineInsert[]) {
  const sum = (f: "grossPremiumMinor" | "commissionMinor" | "claimsPaidMinor" | "reserveMinor") =>
    lines.reduce((n, l) => n + (Number(l[f]) || 0), 0);
  return {
    lineCount: lines.length,
    grossPremiumMinor: sum("grossPremiumMinor"),
    commissionMinor: sum("commissionMinor"),
    claimsPaidMinor: sum("claimsPaidMinor"),
    reserveMinor: sum("reserveMinor")
  };
}

export async function generateBordereaux(ctx: Ctx, input: GenerateBordereauInput) {
  if (input.direction === "inbound" && input.lines.length === 0) {
    throw badRequest("inbound bordereau needs at least one line");
  }

  const [prior] = await ctx.db
    .select()
    .from(schema.axisBordereaux)
    .where(
      and(
        eq(schema.axisBordereaux.tenantId, ctx.tenantId),
        eq(schema.axisBordereaux.direction, input.direction),
        eq(schema.axisBordereaux.counterpartyId, input.counterpartyId),
        eq(schema.axisBordereaux.kind, input.kind),
        eq(schema.axisBordereaux.period, input.period)
      )
    );

  // ponytail: regenerating an inbound bordereau would blow away matchState a
  // human already set on its lines via reconcileBordereaux. Outbound is
  // system-generated and safe to recompute every call; inbound import is a
  // one-shot for this first pass — regenerate support for it can follow if
  // a real need for re-importing a period shows up.
  if (prior && input.direction === "inbound") {
    throw conflict(`inbound bordereau for ${input.period} already exists (${prior.id})`);
  }

  const bordereauId = prior?.id ?? newId("bdx", ctx.now);
  const lines =
    input.direction === "outbound"
      ? await buildOutboundLines(ctx, input, bordereauId)
      : buildInboundLines(ctx, input, bordereauId);

  await replaceLines(ctx, bordereauId, lines);
  const sums = totals(lines);

  const row: typeof schema.axisBordereaux.$inferInsert = {
    id: bordereauId,
    tenantId: ctx.tenantId,
    direction: input.direction,
    counterpartyKind: input.counterpartyKind,
    counterpartyId: input.counterpartyId,
    kind: input.kind,
    period: input.period,
    // An inbound file may carry lines in several currencies; the header's is
    // the one the counterparty declared, not whichever line came first.
    currency: input.direction === "inbound" ? input.currency : (lines[0]?.currency ?? input.currency),
    ...sums,
    varianceMinor: prior?.varianceMinor ?? 0,
    state: "generated",
    fileId: null,
    sourceFileId: null,
    escrowBatchId: null,
    generatedBy: actorRef(ctx),
    generatedAt: ctx.now,
    closedAt: null,
    createdAt: prior?.createdAt ?? ctx.now,
    updatedAt: ctx.now
  };

  if (prior) {
    await ctx.db
      .update(schema.axisBordereaux)
      .set(row)
      .where(scoped(ctx, schema.axisBordereaux, eq(schema.axisBordereaux.id, bordereauId)));
  } else {
    await ctx.db.insert(schema.axisBordereaux).values(row);
  }

  await audit(ctx, { action: "axis.bordereau.generated", subjectRef: bordereauId, before: prior, after: row });
  await emit(ctx, {
    module: "axis",
    type: "axis.bordereau.generated",
    subject: bordereauId,
    data: {
      bordereauId,
      direction: input.direction,
      counterpartyId: input.counterpartyId,
      kind: input.kind,
      period: input.period,
      lineCount: sums.lineCount
    }
  });

  return { bordereau: row, lines };
}

/* ------------------------------------------------------------ CSV import */

const WHOLE = /^-?\d+$/;

/**
 * An inbound bordereau from the counterparty's CSV. Columns: `policyNo`
 * (required on every row), the amounts the kind compares
 * (`FIELDS_BY_KIND` — all required columns, whole numbers in minor units),
 * and optionally `currency` (per line; the header's when blank), `taxMinor`
 * and `riskRef`. Any other column is kept verbatim in the line's `rawJson`.
 *
 * All or nothing, unlike the other imports: an inbound period is one-shot
 * (generateBordereaux refuses a second), so storing the good rows of a bad
 * file would lock the period with lines missing and every missing line would
 * then read as `missing_theirs`. A file with any unreadable row is refused
 * whole — 422, every bad line named — and nothing is stored.
 */
export async function importInboundBordereau(ctx: Ctx, input: ImportBordereauInput, csv: string) {
  const { header, rows, parseErrors } = parseCsv(csv);
  const refuse = (errors: RowError[]) => {
    const sorted = [...errors].sort((a, b) => a.line - b.line);
    return new AppError(422, "unprocessable", "Cannot process", `${sorted.length} line(s) of the bordereau could not be read`, { rowErrors: sorted });
  };

  const amountColumns: AmountField[] = FIELDS_BY_KIND[input.kind];
  const missing = ["policyNo", ...amountColumns].filter((col) => !header.includes(col));
  if (header.length > 0 && missing.length > 0) {
    throw refuse([{ line: 1, ref: null, error: `missing column(s): ${missing.join(", ")}` }]);
  }

  const errors: RowError[] = [...parseErrors];
  const lines: z.input<typeof RawLine>[] = [];
  for (const { line, cells } of rows) {
    const policyNo = cells.policyNo ?? "";
    if (!policyNo) {
      errors.push({ line, ref: null, error: "policyNo is required" });
      continue;
    }
    const amounts: Partial<Record<AmountField | "taxMinor", number>> = {};
    const bad = [...amountColumns, ...(header.includes("taxMinor") ? (["taxMinor"] as const) : [])].find((col) => {
      const value = cells[col] ?? "";
      if (!WHOLE.test(value)) return true;
      amounts[col] = Number(value);
      return !Number.isSafeInteger(amounts[col]);
    });
    if (bad) {
      errors.push({ line, ref: policyNo, error: `${bad} must be a whole number of minor units` });
      continue;
    }
    const currency = (cells.currency ?? "").toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) {
      errors.push({ line, ref: policyNo, error: "currency must be a three-letter ISO 4217 code" });
      continue;
    }
    lines.push({
      externalRef: policyNo,
      ...(cells.riskRef ? { riskRef: cells.riskRef } : {}),
      ...(currency ? { currency } : {}),
      ...amounts,
      cells
    });
  }

  if (errors.length > 0) throw refuse(errors);
  if (lines.length === 0) throw refuse([{ line: 1, ref: null, error: "the file carries no lines" }]);

  return generateBordereaux(ctx, GenerateBordereauBody.parse({ ...input, direction: "inbound", lines }));
}

/* -------------------------------------------------------- reconciliation */

export interface ReportGroup extends Omit<MatchGroup, "ours"> {
  ours: MatchGroup["ours"] & { records: Array<{ id: string; resource: OurRecord["resource"] }> };
  /** Our policy under this reference, when we hold one — to open it from the report. */
  policyId: string | null;
}

function reconcilable(bordereau: BordereauRow): void {
  if (bordereau.direction !== "inbound") throw conflict("only an inbound bordereau is reconciled — an outbound one is our own records");
  // Our records are keyed to the provider who underwrote them
  // (dist_commission_entries.providerId, axis_policies.providerId). A channel
  // or partner file has nothing of ours keyed to its sender, so every line
  // would read as missing on our side; refuse rather than report that.
  if (bordereau.counterpartyKind !== "provider") {
    throw conflict(`a ${bordereau.counterpartyKind} bordereau has no records of ours keyed to its sender to reconcile against`);
  }
}

async function buildReport(ctx: Ctx, bordereau: BordereauRow, toleranceMinor: number) {
  const lines = await ctx.db
    .select()
    .from(schema.axisBordereauLines)
    .where(scoped(ctx, schema.axisBordereauLines, eq(schema.axisBordereauLines.bordereauId, bordereau.id)));
  lines.sort((a, b) => a.lineNo - b.lineNo);
  const kind = bordereau.kind as GenerateBordereauInput["kind"];
  const fields = FIELDS_BY_KIND[kind];
  const ours = await ourRecords(ctx, { kind, counterpartyId: bordereau.counterpartyId, period: bordereau.period });

  const amounts = (row: Record<AmountField, number>) => Object.fromEntries(fields.map((f) => [f, row[f]])) as MatchLine["amounts"];
  const theirLines: MatchLine[] = lines.flatMap((l) =>
    l.externalRef ? [{ id: l.id, ref: l.externalRef, currency: l.currency, amounts: amounts(l) }] : []
  );
  const ourLines: MatchLine[] = ours.map((r) => ({ id: r.id, ref: r.ref, currency: r.currency, amounts: amounts(r) }));
  const matched = matchBordereau(theirLines, ourLines, { fields, toleranceMinor });

  const byId = new Map(ours.map((r) => [r.id, r]));
  // A reference only they sent may still be one of our policies with nothing
  // booked this period — name it so a person can open it.
  const unbooked = await ctx.db
    .select({ id: schema.axisPolicies.id, policyNo: schema.axisPolicies.policyNo })
    .from(schema.axisPolicies)
    .where(
      and(
        eq(schema.axisPolicies.tenantId, ctx.tenantId),
        inArray(
          schema.axisPolicies.policyNo,
          matched.groups.filter((g) => g.state === "missing_ours").map((g) => g.ref)
        )
      )
    );
  const policyByNo = new Map(unbooked.map((p) => [p.policyNo, p.id]));

  const groups: ReportGroup[] = matched.groups.map((g) => ({
    ...g,
    ours: { ...g.ours, records: g.ours.ids.map((id) => ({ id, resource: byId.get(id)!.resource })) },
    policyId: g.ours.ids.map((id) => byId.get(id)!.policyId).find((p) => p) ?? policyByNo.get(g.ref) ?? null
  }));

  return {
    lines,
    report: {
      bordereauId: bordereau.id,
      kind,
      fields,
      toleranceMinor,
      groups,
      totals: matched.totals
    }
  };
}

/** The reconciliation as it stands now, under the tolerance it was last run with. Reads only. */
export async function reconciliationReport(ctx: Ctx, bordereau: BordereauRow) {
  reconcilable(bordereau);
  return (await buildReport(ctx, bordereau, bordereau.toleranceMinor)).report;
}

export async function reconcileBordereaux(ctx: Ctx, bordereau: BordereauRow, options: { toleranceMinor?: number | undefined } = {}) {
  reconcilable(bordereau);
  const toleranceMinor = options.toleranceMinor ?? 0;
  const { lines, report } = await buildReport(ctx, bordereau, toleranceMinor);

  // Each of their lines takes its group's state. The group's variance sits on
  // its first line only, so summing line variances never counts a duplicate
  // reference twice.
  const stamp = new Map<string, { matchState: string; varianceMinor: number; policyId: string | null }>();
  for (const group of report.groups) {
    group.theirs.ids.forEach((id, i) =>
      stamp.set(id, { matchState: group.state, varianceMinor: i === 0 ? group.varianceMinor : 0, policyId: group.policyId })
    );
  }

  const updated: LineRow[] = [];
  for (const line of lines) {
    const s = stamp.get(line.id);
    if (!s) {
      updated.push(line);
      continue;
    }
    const policyId = s.policyId ?? line.policyId;
    await ctx.db
      .update(schema.axisBordereauLines)
      .set({ matchState: s.matchState, varianceMinor: s.varianceMinor, policyId, updatedAt: ctx.now })
      .where(scoped(ctx, schema.axisBordereauLines, eq(schema.axisBordereauLines.id, line.id)));
    updated.push({ ...line, matchState: s.matchState, varianceMinor: s.varianceMinor, policyId, updatedAt: ctx.now });
  }

  // The header's variance is in the header's currency only; the per-currency
  // totals are in the report. Summing across currencies would be a number in
  // no currency at all.
  const varianceMinor = report.totals.find((t) => t.currency === bordereau.currency)?.varianceMinor ?? 0;
  const state = report.groups.every((g) => g.state === "matched") ? "matched" : "variance";
  const after: BordereauRow = { ...bordereau, varianceMinor, toleranceMinor, state, updatedAt: ctx.now };
  await ctx.db
    .update(schema.axisBordereaux)
    .set({ varianceMinor, toleranceMinor, state, updatedAt: ctx.now })
    .where(scoped(ctx, schema.axisBordereaux, eq(schema.axisBordereaux.id, bordereau.id)));

  await audit(ctx, { action: "axis.bordereau.reconciled", subjectRef: bordereau.id, before: bordereau, after });
  await emit(ctx, {
    module: "axis",
    type: "axis.bordereau.reconciled",
    subject: bordereau.id,
    data: { bordereauId: bordereau.id, state, varianceMinor, lineCount: updated.length, toleranceMinor }
  });

  return { bordereau: after, lines: updated, report };
}

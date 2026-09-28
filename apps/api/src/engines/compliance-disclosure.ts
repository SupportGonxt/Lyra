import { and, eq } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { audit, emit, sha256Hex, withIdempotency, type Ctx, type DisclosureScope, type MandatoryDisclosure } from "@lyra/core";
import { runTxn } from "@lyra/ledger";

// DISCLOSURE-PRESENT (docs/12, docs/19 §4) as an engine function, so the
// compliance route and SIGNAL's publish path record a presentation through the
// one code path: row, audit, event and non-financial txn as a single
// idempotent unit. ADR-0108.

export interface PresentDisclosureInput {
  subjectRef: string;
  key: string;
  locale: string;
  wording: string;
  wordingRef?: string | undefined;
  criteria?: Record<string, unknown> | undefined;
  channel: string;
  customerId?: string | undefined;
  idempotencyKey: string;
}

export async function presentDisclosure(ctx: Ctx, input: PresentDisclosureInput, route: string) {
  // The insert, audit, emit and runTxn call all need to replay as one unit —
  // runTxn alone only dedupes its own ledger write, so a replayed request was
  // otherwise double-writing the disclosures row/audit/event underneath it.
  return withIdempotency(ctx, input.idempotencyKey, route, input, async () => {
    const wordingHash = await sha256Hex(input.wording);
    const row = {
      id: id("dsc", ctx.now),
      tenantId: ctx.tenantId,
      key: input.key,
      locale: input.locale,
      subjectRef: input.subjectRef,
      customerId: input.customerId ?? null,
      wordingHash,
      wordingRef: input.wordingRef ?? null,
      criteriaJson: input.criteria ? JSON.stringify(input.criteria) : null,
      channel: input.channel,
      acknowledgedAt: null,
      ts: ctx.now
    };
    await ctx.db.insert(schema.disclosures).values(row);
    await audit(ctx, { action: "compliance.disclosure.present", subjectRef: input.subjectRef, after: row });
    await emit(ctx, {
      module: "compliance",
      type: "compliance.disclosure.presented",
      subject: input.subjectRef,
      data: { disclosureId: row.id, key: row.key, channel: row.channel }
    });

    // DISCLOSURE-PRESENT is non-financial (docs/19 §4: ⊘, financial: false) — the
    // disclosure itself, inserted above, is the evidence AD-PLACEMENT's
    // precondition reads; this is the audited, idempotent, reversible envelope
    // every business fact gets, posting no journal (same shape as REFERRAL-QUAL).
    const txn = await runTxn(ctx, {
      type: "DISCLOSURE-PRESENT",
      idempotencyKey: input.idempotencyKey,
      subjectRefs: { subject: input.subjectRef, ...(input.customerId ? { customer: input.customerId } : {}) }
    });

    return { ...row, txn };
  });
}

/** The wordingRef a presentation carries: which row, at which version. */
export const wordingRefOf = (d: Pick<MandatoryDisclosure, "id" | "version">): string =>
  `compliance_disclosure_wording:${d.id}@v${d.version}`;

/**
 * What the disclosure lane needs to judge one creative: the tenant's active
 * wording for its product line in its locale, and whether the tenant has
 * configured any at all. Tenant-scoped reads only; nothing here consults
 * policy, so no setting can change the answer (SIG-015).
 */
export async function disclosureScope(ctx: Ctx, productLine: string | null, locale: string): Promise<DisclosureScope> {
  const t = schema.disclosureWordings;
  const active = and(eq(t.tenantId, ctx.tenantId), eq(t.status, "active"));
  const [any] = await ctx.db.select({ id: t.id }).from(t).where(active).limit(1);
  if (!productLine) return { productLine: null, disclosure: null, tenantConfigured: Boolean(any) };
  const [row] = await ctx.db
    .select()
    .from(t)
    .where(and(active, eq(t.productLine, productLine), eq(t.locale, locale)))
    .limit(1);
  return {
    productLine,
    tenantConfigured: Boolean(any),
    disclosure: row
      ? { id: row.id, version: row.version, key: row.key, productLine: row.productLine, locale: row.locale, wording: row.wording }
      : null
  };
}

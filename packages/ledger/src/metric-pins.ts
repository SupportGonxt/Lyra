import { and, eq, isNull, ne, or } from "drizzle-orm";
import { id, schema } from "@lyra/db";
import { actorRef, audit, badRequest, conflict, hashObject, notFound, type Ctx } from "@lyra/core";

// docs/specs/gap-finance-design.md D11, ADR-0111 — a success fee needs a pinned,
// countersigned metric snapshot.
//
// A verified north_snapshots row is attested, not frozen: the snapshotter can
// recompute it and somebody can re-verify it after both parties agreed on the
// number. The pin is the frozen half. It copies the row, hashes the copy, and
// is then signed by both sides; SUCCESS-FEE reads the pin and never the live
// row (preconditions.ts), re-derives the hash, and posts under a key derived
// from the pin's id, so the ledger's own (tenant, type, key) unique index is
// what makes one pin bill exactly once.
//
// State machine: pinned → countersigned (both sides). There is no edit and no
// delete path at all, which is stronger than "immutable once signed".

export type MetricPin = typeof schema.ledgerMetricPins.$inferSelect;
export const PIN_SIDES = ["tenant", "counterparty"] as const;
export type PinSide = (typeof PIN_SIDES)[number];

/** The one idempotency key a SUCCESS-FEE on this pin may post under. */
export function successFeeKey(pinId: string): string {
  return `success-fee:${pinId}`;
}

/** Exactly the fields the hash covers: what was measured, the number, who attested it. */
export type PinCopy = Pick<
  MetricPin,
  | "tenantId"
  | "sourceSnapshotId"
  | "metricKey"
  | "grain"
  | "period"
  | "dimsHash"
  | "value"
  | "unit"
  | "currency"
  | "sourceVerifiedBy"
  | "sourceVerifiedAt"
>;

export function pinHashInput(pin: PinCopy): Record<string, unknown> {
  return {
    tenantId: pin.tenantId,
    sourceSnapshotId: pin.sourceSnapshotId,
    metricKey: pin.metricKey,
    grain: pin.grain,
    period: pin.period,
    dimsHash: pin.dimsHash,
    value: pin.value,
    unit: pin.unit,
    currency: pin.currency ?? null,
    sourceVerifiedBy: pin.sourceVerifiedBy,
    sourceVerifiedAt: pin.sourceVerifiedAt
  };
}

/** sha-256 over the canonical JSON of `pinHashInput`. */
export function pinSourceHash(pin: PinCopy): Promise<string> {
  return hashObject(pinHashInput(pin));
}

export async function getMetricPin(ctx: Ctx, pinId: string): Promise<MetricPin | undefined> {
  const [row] = await ctx.db
    .select()
    .from(schema.ledgerMetricPins)
    .where(and(eq(schema.ledgerMetricPins.tenantId, ctx.tenantId), eq(schema.ledgerMetricPins.id, pinId)))
    .limit(1);
  return row;
}

/** Pin a verified snapshot. Tenant-scoped: another tenant's row reads as not found. */
export async function pinMetricSnapshot(ctx: Ctx, snapshotId: string): Promise<MetricPin> {
  const [snap] = await ctx.db
    .select()
    .from(schema.northSnapshots)
    .where(and(eq(schema.northSnapshots.tenantId, ctx.tenantId), eq(schema.northSnapshots.id, snapshotId)))
    .limit(1);
  if (!snap) throw notFound(`metric snapshot ${snapshotId}`);
  if (snap.verifiedAt == null || !snap.verifiedBy) {
    throw conflict(
      `metric snapshot ${snapshotId} (${snap.metricKey} ${snap.period}) has not been verified; only an attested figure may be pinned for a success fee`
    );
  }
  // The unit and currency live on the metric definition; without them the
  // pinned number means nothing a counterparty could sign.
  const [metric] = await ctx.db
    .select({ unit: schema.northMetrics.unit, currency: schema.northMetrics.currency })
    .from(schema.northMetrics)
    .where(and(eq(schema.northMetrics.tenantId, ctx.tenantId), eq(schema.northMetrics.key, snap.metricKey)))
    .limit(1);
  if (!metric) throw conflict(`metric ${snap.metricKey} has no definition; a figure with no unit cannot be pinned`);

  const [already] = await ctx.db
    .select({ id: schema.ledgerMetricPins.id })
    .from(schema.ledgerMetricPins)
    .where(and(eq(schema.ledgerMetricPins.tenantId, ctx.tenantId), eq(schema.ledgerMetricPins.sourceSnapshotId, snapshotId)))
    .limit(1);
  if (already) throw conflict(`metric snapshot ${snapshotId} is already pinned (${already.id})`);

  const copy: PinCopy = {
    tenantId: ctx.tenantId,
    sourceSnapshotId: snap.id,
    metricKey: snap.metricKey,
    grain: snap.grain,
    period: snap.period,
    dimsHash: snap.dimsHash,
    value: snap.value,
    unit: metric.unit,
    currency: metric.currency ?? null,
    sourceVerifiedBy: snap.verifiedBy,
    sourceVerifiedAt: snap.verifiedAt
  };
  const row: MetricPin = {
    ...copy,
    id: id("pms", ctx.now),
    sourceHash: await pinSourceHash(copy),
    state: "pinned",
    pinnedBy: actorRef(ctx),
    pinnedAt: ctx.now,
    tenantSignedBy: null,
    tenantSignedAt: null,
    counterpartySignedBy: null,
    counterpartySignedAt: null,
    counterpartyEvidenceRef: null,
    createdAt: ctx.now,
    updatedAt: ctx.now
  };
  try {
    await ctx.db.insert(schema.ledgerMetricPins).values(row);
  } catch (err) {
    // Lost a race on ledger_metric_pins_source_uq: the other pin is the answer.
    throw conflict(`metric snapshot ${snapshotId} is already pinned: ${(err as Error).message}`);
  }
  await audit(ctx, {
    action: "ledger.metric_pin.pinned",
    subjectRef: `ledger_metric_pin:${row.id}`,
    after: { ...copy, sourceHash: row.sourceHash }
  });
  return row;
}

/**
 * Sign one side of a pin. Our side may not be signed by whoever pinned it, the
 * counterparty's acceptance must carry its evidence, and no one person may
 * stand on both sides. Each side is signed once; the update is conditional on
 * that side still being empty, so two concurrent signers cannot both win.
 */
export async function countersignPin(
  ctx: Ctx,
  pinId: string,
  side: PinSide,
  opts: { evidenceRef?: string } = {}
): Promise<MetricPin> {
  const pin = await getMetricPin(ctx, pinId);
  if (!pin) throw notFound(`metric pin ${pinId}`);
  const me = actorRef(ctx);
  const signedBy = side === "tenant" ? pin.tenantSignedBy : pin.counterpartySignedBy;
  if (signedBy) throw conflict(`the ${side} side of ${pinId} is already signed (${signedBy})`);
  const otherSigner = side === "tenant" ? pin.counterpartySignedBy : pin.tenantSignedBy;
  if (otherSigner === me) throw conflict(`one person may not sign both sides of ${pinId} (dual control)`);
  if (side === "tenant" && pin.pinnedBy === me) {
    throw conflict(`${me} pinned it, so our side of ${pinId} needs a second seat (dual control)`);
  }
  const evidenceRef = opts.evidenceRef?.trim();
  if (side === "counterparty" && !evidenceRef) {
    throw badRequest("evidenceRef is required: the counterparty's acceptance must name its evidence");
  }

  const bothSigned = Boolean(otherSigner);
  const set =
    side === "tenant"
      ? { tenantSignedBy: me, tenantSignedAt: ctx.now }
      : { counterpartySignedBy: me, counterpartySignedAt: ctx.now, counterpartyEvidenceRef: evidenceRef ?? null };
  const [mine, theirs] =
    side === "tenant"
      ? [schema.ledgerMetricPins.tenantSignedBy, schema.ledgerMetricPins.counterpartySignedBy]
      : [schema.ledgerMetricPins.counterpartySignedBy, schema.ledgerMetricPins.tenantSignedBy];
  const updated = await ctx.db
    .update(schema.ledgerMetricPins)
    .set({ ...set, state: bothSigned ? "countersigned" : "pinned", updatedAt: ctx.now })
    .where(
      and(
        eq(schema.ledgerMetricPins.tenantId, ctx.tenantId),
        eq(schema.ledgerMetricPins.id, pinId),
        isNull(mine),
        or(isNull(theirs), ne(theirs, me))
      )
    )
    .returning();
  const after = updated[0];
  if (!after) throw conflict(`the ${side} side of ${pinId} was signed concurrently`);

  // The other side may have been signed between our read and our write; the
  // state then has to be settled from the row as it now stands.
  let final = after;
  if (after.tenantSignedBy && after.counterpartySignedBy && after.state !== "countersigned") {
    const [row] = await ctx.db
      .update(schema.ledgerMetricPins)
      .set({ state: "countersigned" })
      .where(and(eq(schema.ledgerMetricPins.tenantId, ctx.tenantId), eq(schema.ledgerMetricPins.id, pinId)))
      .returning();
    final = row ?? after;
  }

  await audit(ctx, {
    action: "ledger.metric_pin.countersigned",
    subjectRef: `ledger_metric_pin:${pinId}`,
    before: { state: pin.state, side },
    after: { state: final.state, side, signedBy: me, ...(evidenceRef ? { evidenceRef } : {}) }
  });
  return final;
}

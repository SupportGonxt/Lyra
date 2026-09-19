import { and, eq, gte, like } from "drizzle-orm";
import { parseJson, schema, shariahCertified, TakafulJson } from "@lyra/db";
import { checkKAnonymity, conflict, type Ctx } from "@lyra/core";

// docs/specs/gap-finance-design.md D2/D3. Some transactions are illegal because
// of what is already in the ledger, not because of their own arguments: a second
// opening balance, a year-end close over months still open, a year closed twice.
//
// A recipe cannot see the database and the state machine must not grow a branch
// per type, so this is the one new mechanism: a table of read-only checks that
// run once, at the top of the `initiated` hop, before anything has been written.
// Read, decide, then write — enforced by the shape.

export type Precondition = (ctx: Ctx, args: Record<string, unknown>) => Promise<void>;

/** Settled transactions of `type`, oldest first. */
async function settledOfType(ctx: Ctx, type: string): Promise<{ idempotencyKey: string }[]> {
  return ctx.db
    .select({ idempotencyKey: schema.ledgerTxns.idempotencyKey })
    .from(schema.ledgerTxns)
    .where(
      and(
        eq(schema.ledgerTxns.tenantId, ctx.tenantId),
        eq(schema.ledgerTxns.type, type),
        eq(schema.ledgerTxns.state, "settled")
      )
    );
}

function fiscalYearOf(args: Record<string, unknown>): number {
  const y = args["fiscalYear"];
  if (typeof y !== "number" || !Number.isInteger(y)) throw conflict("fiscalYear is required");
  return y;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw conflict(`${key} is required`);
  return v;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw conflict(`${key} is required`);
  return v;
}

/**
 * An opening balance restates the whole ledger from nothing. A second one would
 * double every balance it names, and no reversal makes that obvious after the
 * fact — so it is once per tenant, ever.
 */
const firstOpeningBalanceOnly: Precondition = async (ctx) => {
  const prior = await settledOfType(ctx, "OPEN-BAL");
  if (prior.length) {
    throw conflict(
      `this tenant already posted an opening balance (${prior[0]?.idempotencyKey}); correct it with a manual journal`
    );
  }
};

/**
 * Closing a year whose months are still open would close figures that can still
 * move. Months with no postings have no period row and so nothing to close —
 * the check is over what exists, not over twelve codes.
 */
const fiscalYearSoftClosed: Precondition = async (ctx, args) => {
  const year = fiscalYearOf(args);
  const rows = await ctx.db
    .select({ code: schema.ledgerPeriods.code, state: schema.ledgerPeriods.state })
    .from(schema.ledgerPeriods)
    .where(and(eq(schema.ledgerPeriods.tenantId, ctx.tenantId), like(schema.ledgerPeriods.code, `${year}-%`)));
  const open = rows.filter((r) => r.state === "open").map((r) => r.code).sort();
  if (open.length) {
    throw conflict(`fiscal year ${year} still has open periods: ${open.join(", ")}`);
  }
};

/**
 * `yearend:{year}` as the idempotency key makes a replay a no-op through the
 * existing unique index, so the only thing left to catch is a *different* key
 * for a year already closed — which would post retained earnings twice.
 */
const yearNotAlreadyClosed: Precondition = async (ctx, args) => {
  const year = fiscalYearOf(args);
  const prior = await settledOfType(ctx, "YEAR-END-CLOSE");
  if (prior.some((p) => p.idempotencyKey === `yearend:${year}`)) {
    throw conflict(`fiscal year ${year} is already closed`);
  }
};

const AD_PLACEMENT_STALENESS_MS = 24 * 60 * 60 * 1000;

const freshAdPlacementDisclosure: Precondition = async (ctx, args) => {
  const subjectRef = requireString(args, "subjectRef");
  const rows = await ctx.db
    .select({ id: schema.disclosures.id })
    .from(schema.disclosures)
    .where(
      and(
        eq(schema.disclosures.tenantId, ctx.tenantId),
        eq(schema.disclosures.subjectRef, subjectRef),
        eq(schema.disclosures.key, "ad_placement"),
        gte(schema.disclosures.ts, ctx.now - AD_PLACEMENT_STALENESS_MS)
      )
    )
    .limit(1);
  if (!rows.length) {
    throw conflict(`no disclosure presented for ${subjectRef} in the last 24h; present one before placing this ad`);
  }
};

/**
 * docs/19 §5.2 F: a data-product delivery whose result set is too small to
 * anonymise must be refused before any transaction is opened — the caller
 * supplies the query's own cell count via `args`, the product supplies its
 * own floor via `aggregationMin` (docs/03 §SCOUT).
 */
const dataProductKAnonymity: Precondition = async (ctx, args) => {
  const dataProductId = requireString(args, "dataProductId");
  const cellCount = requireNumber(args, "cellCount");
  const [product] = await ctx.db
    .select({
      aggregationMin: schema.scoutDataProducts.aggregationMin,
      status: schema.scoutDataProducts.status
    })
    .from(schema.scoutDataProducts)
    .where(
      and(eq(schema.scoutDataProducts.tenantId, ctx.tenantId), eq(schema.scoutDataProducts.id, dataProductId))
    );
  if (!product) throw conflict(`data product ${dataProductId} not found`);
  // draft|published|suspended (schema scout.ts): only a published product may be
  // delivered and billed — a draft was never approved for sale and a suspended
  // one has been withdrawn, often for the exact disclosure reasons this gate
  // exists to enforce.
  if (product.status !== "published") {
    throw conflict(`data product ${dataProductId} is ${product.status}, not published`);
  }
  const result = checkKAnonymity(cellCount, product.aggregationMin);
  if (!result.allowed) {
    throw conflict(
      `k-anonymity floor not met: ${result.cellCount} cells below floor of ${result.floor}`
    );
  }
};

/**
 * docs/16 H8, docs/27 F45. A takaful surplus may only be distributed out of a
 * product the Shariah board has certified, and the certification must still be
 * current at the moment the money moves.
 *
 * This is a precondition rather than a second approval on purpose. `SURPLUS-DIST`
 * already gates on `ledger.surplus` — dual control, never auto-approvable — and
 * that approval is about *this* distribution: the amount, the period, the
 * counterparties. The board's ruling is about the product and stands between
 * distributions. Two facts, so two mechanisms; folding the ruling into the
 * payout approval would mean asking a treasury approver to certify a contract
 * structure, which is not a thing they can answer.
 *
 * It refuses a non-takaful product outright rather than letting it through. A
 * conventional product has no participants' fund to distribute from, so a
 * SURPLUS-DIST against one would debit 2040 to a balance that was never
 * credited — an overdrawn fund is not an error the ledger can detect after the
 * fact, because the account is a liability and a debit balance on it reads as a
 * perfectly ordinary prepayment.
 */
const shariahRulingCurrent: Precondition = async (ctx, args) => {
  const productId = requireString(args, "productId");
  const [product] = await ctx.db
    .select({ structure: schema.products.structure, takafulJson: schema.products.takafulJson })
    .from(schema.products)
    .where(and(eq(schema.products.tenantId, ctx.tenantId), eq(schema.products.id, productId)))
    .limit(1);

  if (!product) throw conflict(`product ${productId} not found in this tenant`);
  if (product.structure !== "takaful") {
    throw conflict(
      `product ${productId} is ${product.structure}, not takaful — it has no participants' fund to distribute from`
    );
  }

  const takaful = parseJson(TakafulJson, product.takafulJson);
  if (!shariahCertified(takaful, ctx.now)) {
    const why =
      takaful.shariah.state === "certified"
        ? `its Shariah ruling expired at ${takaful.shariah.expiresAt}`
        : `its Shariah ruling is "${takaful.shariah.state}", not "certified"`;
    throw conflict(`product ${productId} may not distribute a surplus: ${why}`);
  }
};

/** Every check that must pass before a transaction of this type may proceed. */
export const TXN_PRECONDITIONS: Record<string, Precondition> = {
  "OPEN-BAL": firstOpeningBalanceOnly,
  "YEAR-END-CLOSE": async (ctx, args) => {
    await yearNotAlreadyClosed(ctx, args);
    await fiscalYearSoftClosed(ctx, args);
  },
  "AD-PLACEMENT": freshAdPlacementDisclosure,
  "DPROD-DELIVER": dataProductKAnonymity,
  "SURPLUS-DIST": shariahRulingCurrent
};

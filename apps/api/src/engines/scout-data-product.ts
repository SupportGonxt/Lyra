import { and, eq, gte, isNotNull } from "drizzle-orm";
import { schema } from "@lyra/db";
import { audit, conflict, gate, kAnonymityFloor, notFound, scoped, type Ctx } from "@lyra/core";
import { deliverDataProduct, subscribeToDataProduct } from "./billing.js";
import { storeExport } from "../routes/analytics.js";

// docs/modules/scout.md §2.5 "Data products (insight-as-revenue)", docs/30
// SCOUT 1, ADR-0101. `subscribeToDataProduct` and `deliverDataProduct`
// (billing.ts) were the whole money half of this and nothing but their own
// tests called them — a seam with no caller. These are the callers:
//
//  - subscribe is the contract. It fixes the fee every later delivery to that
//    provider invoices, so it is where the approval is asked for
//    (`scout.data_product_subscribe`), once, for that price.
//  - deliver executes the contract: it builds the cut the product's own
//    definition names, lets the DPROD-DELIVER precondition refuse it if any
//    cell would name fewer than the floor, bills the approved fee through the
//    existing SUB-INVOICE/SUB-RECOG legs, and leaves the artefact in the
//    export register the screen's delivery log already reads.

/** `analytics_exports.subject_ref` for a cut of a product — the key the
 *  delivery log filters on (apps/web scout-data-products.tsx `subjectRefOf`). */
export const subjectRefOf = (id: string): string => `scout_data_product:${id}`;

/** Rows one cut may read. A bound, not a sample: past it the cut says so. */
export const DELIVERABLE_MAX_ROWS = 50_000;

/** The measures a quote-request cut knows how to compute. */
const MEASURES = ["requests", "bindRateBps", "medianQuotedPremiumMinor"] as const;
type Measure = (typeof MEASURES)[number];

export interface Subscriber {
  providerId: string;
  since: number;
  feeMinor?: number;
  suspendedAt?: number;
  [extra: string]: unknown;
}

export type Cell = Record<string, string | number | null>;

export interface Deliverable {
  dataProductId: string;
  name: string;
  source: string;
  window: string;
  since: number;
  until: number;
  line: string | null;
  dimensions: string[];
  measures: Measure[];
  floor: number;
  /** Rows read, after the consent filter. */
  rows: number;
  truncated: boolean;
  cells: Cell[];
  /** Cells dropped for naming fewer than `floor` rows. Counted, never shown. */
  suppressed: number;
  /** The smallest cell delivered — what the k-anonymity precondition checks. 0 when none survive. */
  smallestCell: number;
  builtAt: number;
}

type Product = typeof schema.scoutDataProducts.$inferSelect;

async function productOf(ctx: Ctx, id: string): Promise<Product> {
  const [row] = await ctx.db
    .select()
    .from(schema.scoutDataProducts)
    .where(scoped(ctx, schema.scoutDataProducts, eq(schema.scoutDataProducts.id, id)))
    .limit(1);
  if (!row) throw notFound("data product");
  if (row.status !== "published") throw conflict(`data product ${id} is ${row.status}, not published`);
  return row;
}

/** The subscriber list as stored, unknown fields kept. Malformed reads as empty. */
export function subscribersIn(raw: string | null): Subscriber[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is Subscriber => typeof x === "object" && x !== null && typeof (x as { providerId?: unknown }).providerId === "string"
    );
  } catch {
    return [];
  }
}

const isFee = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n > 0;

/* ------------------------------------------------------------- subscribe */

export interface SubscribeResult {
  dataProductId: string;
  providerId: string;
  feeMinor: number;
  since: number;
  txnId: string | null;
}

export async function subscribeProduct(
  ctx: Ctx,
  input: { dataProductId: string; providerId: string; feeMinor: number; key: string }
): Promise<SubscribeResult> {
  const product = await productOf(ctx, input.dataProductId);
  const [provider] = await ctx.db
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(scoped(ctx, schema.providers, eq(schema.providers.id, input.providerId)))
    .limit(1);
  if (!provider) throw notFound("provider");

  // Asked per product x provider, carrying the price: an approval covers at
  // most the fee it was given for (gate compares amounts).
  await gate(ctx, {
    policyKey: "scout.data_product_subscribe",
    subjectRef: `${subjectRefOf(product.id)}:${input.providerId}`,
    amountMinor: input.feeMinor,
    context: { dataProductId: product.id, providerId: input.providerId, feeMinor: input.feeMinor, consentBasis: product.consentBasis }
  });

  const { txnId } = await subscribeToDataProduct(ctx, {
    dataProductId: product.id,
    subscriberRef: `provider:${input.providerId}`,
    idempotencyKey: `dprod-sub:${input.key}`
  });

  // A current subscriber is re-priced in place and keeps the day it joined; a
  // suspended or new one starts a fresh entry.
  const list = subscribersIn(product.subscribersJson);
  const at = list.findIndex((one) => one.providerId === input.providerId);
  const before = at === -1 ? null : list[at]!;
  const next: Subscriber =
    before && before.suspendedAt == null
      ? { ...before, feeMinor: input.feeMinor }
      : { providerId: input.providerId, since: ctx.now, feeMinor: input.feeMinor };
  if (at === -1) list.push(next);
  else list[at] = next;

  await ctx.db
    .update(schema.scoutDataProducts)
    .set({ subscribersJson: JSON.stringify(list), updatedAt: ctx.now })
    .where(scoped(ctx, schema.scoutDataProducts, eq(schema.scoutDataProducts.id, product.id)));
  await audit(ctx, {
    action: "scout.data_product.subscribe",
    subjectRef: subjectRefOf(product.id),
    before,
    after: { ...next, consentBasis: product.consentBasis }
  });

  return { dataProductId: product.id, providerId: input.providerId, feeMinor: input.feeMinor, since: next.since, txnId: txnId ?? null };
}

/* ----------------------------------------------------------------- build */

interface Definition {
  source: string;
  window: string;
  line: string | null;
  dimensions: string[];
  measures: Measure[];
}

/** `trailing_12_month` / `trailing_90_day` → the instant the window opens. */
export function windowStart(window: string, now: number): number | null {
  const m = /^trailing_(\d{1,3})_(day|month)$/.exec(window);
  if (!m) return null;
  const n = Number(m[1]);
  if (n < 1) return null;
  if (m[2] === "day") return now - n * 86_400_000;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.getTime();
}

function definitionOf(product: Product): Definition {
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(product.definitionJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // An unreadable definition is refused below by its missing source.
  }
  const source = typeof raw.source === "string" ? raw.source : "(none)";
  // One builder today. A product over another table is refused by name rather
  // than delivered as something it does not define.
  if (source !== "dist_quote_requests") throw conflict(`there is no builder yet for a data product over "${source}"`);
  const window = typeof raw.window === "string" ? raw.window : "";
  const dims = Array.isArray(raw.dimensions) ? raw.dimensions : [];
  const dimensions = dims.filter((d): d is string => typeof d === "string" && /^[A-Za-z]\w{0,39}$/.test(d)).slice(0, 6);
  if (dimensions.length !== dims.length) throw conflict("the definition names a dimension this builder cannot read");
  const measures = Array.isArray(raw.measures) ? raw.measures : [];
  const unknown = measures.filter((m) => !(MEASURES as readonly unknown[]).includes(m));
  if (unknown.length || !measures.length) throw conflict(`the definition names no measure this builder computes: ${unknown.join(", ") || "none"}`);
  return {
    source,
    window,
    line: typeof raw.line === "string" ? raw.line : null,
    dimensions,
    measures: measures as Measure[]
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

const valueOf = (v: unknown): string => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "unknown");

/**
 * The cut a product's definition names, over this tenant's quote requests.
 * A product whose basis is consent reads only requests that carry a recorded
 * consent. Every cell under the floor — the product's own or the module's,
 * whichever is higher — is dropped whole and only counted: suppressed, not
 * rounded. No row identifier and no input outside the named dimensions ever
 * reaches the cut.
 */
export async function buildDeliverable(ctx: Ctx, product: Product): Promise<Deliverable> {
  const def = definitionOf(product);
  const since = windowStart(def.window, ctx.now);
  if (since === null) throw conflict(`the definition's window "${def.window}" is not one this builder reads`);

  const consentOnly = product.consentBasis.startsWith("consent:");
  const rows = await ctx.db
    .select({
      inputsJson: schema.distQuoteRequests.inputsJson,
      state: schema.distQuoteRequests.state,
      premium: schema.distQuoteRequests.bestPremiumMinor
    })
    .from(schema.distQuoteRequests)
    .innerJoin(
      schema.products,
      and(eq(schema.products.id, schema.distQuoteRequests.productId), eq(schema.products.tenantId, schema.distQuoteRequests.tenantId))
    )
    .where(
      scoped(
        ctx,
        schema.distQuoteRequests,
        gte(schema.distQuoteRequests.createdAt, since),
        def.line ? eq(schema.products.line, def.line) : undefined,
        consentOnly ? isNotNull(schema.distQuoteRequests.consentId) : undefined
      )
    )
    .limit(DELIVERABLE_MAX_ROWS + 1);
  const truncated = rows.length > DELIVERABLE_MAX_ROWS;

  const groups = new Map<string, { key: Record<string, string>; count: number; converted: number; premiums: number[] }>();
  for (const row of rows.slice(0, DELIVERABLE_MAX_ROWS)) {
    let inputs: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.inputsJson) as unknown;
      if (parsed && typeof parsed === "object") inputs = parsed as Record<string, unknown>;
    } catch {
      // An unreadable row lands in the "unknown" cell of every dimension.
    }
    const key = Object.fromEntries(def.dimensions.map((d) => [d, valueOf(inputs[d])]));
    const id = JSON.stringify(def.dimensions.map((d) => key[d]));
    const group = groups.get(id) ?? { key, count: 0, converted: 0, premiums: [] };
    group.count += 1;
    if (row.state === "converted") group.converted += 1;
    if (typeof row.premium === "number") group.premiums.push(row.premium);
    groups.set(id, group);
  }

  const floor = Math.max(product.aggregationMin, kAnonymityFloor(ctx.policy, "scout"));
  const kept = [...groups.values()].filter((g) => g.count >= floor).sort((a, b) => b.count - a.count);
  const cells: Cell[] = kept.map((g) => {
    const cell: Cell = { ...g.key };
    for (const m of def.measures) {
      if (m === "requests") cell.requests = g.count;
      else if (m === "bindRateBps") cell.bindRateBps = Math.round((g.converted / g.count) * 10_000);
      else cell.medianQuotedPremiumMinor = median(g.premiums);
    }
    return cell;
  });

  return {
    dataProductId: product.id,
    name: product.name,
    source: def.source,
    window: def.window,
    since,
    until: ctx.now,
    line: def.line,
    dimensions: def.dimensions,
    measures: def.measures,
    floor,
    rows: Math.min(rows.length, DELIVERABLE_MAX_ROWS),
    truncated,
    cells,
    suppressed: groups.size - kept.length,
    smallestCell: kept.length ? Math.min(...kept.map((g) => g.count)) : 0,
    builtAt: ctx.now
  };
}

/* --------------------------------------------------------------- deliver */

export interface DeliverResult {
  dataProductId: string;
  providerId: string;
  exportId: string;
  invoiceId: string;
  deliverTxnId: string | null;
  feeMinor: number;
  cells: number;
  suppressed: number;
}

export async function deliverProduct(
  ctx: Ctx,
  bucket: R2Bucket | undefined,
  input: { dataProductId: string; providerId: string; key: string }
): Promise<DeliverResult> {
  const product = await productOf(ctx, input.dataProductId);
  const subscriber = subscribersIn(product.subscribersJson).find(
    (one) => one.providerId === input.providerId && one.suspendedAt == null
  );
  if (!subscriber) throw conflict(`provider ${input.providerId} does not subscribe to this data product`);
  // Subscriptions written before the fee was recorded carry none. Billing an
  // invented price is worse than refusing: subscribing again sets one.
  if (!isFee(subscriber.feeMinor)) throw conflict("this subscription records no fee; subscribe the provider again to price it");
  const feeMinor = subscriber.feeMinor;

  const cut = await buildDeliverable(ctx, product);

  // The precondition on DPROD-DELIVER is the k-anonymity gate: nothing is
  // stored or billed unless the smallest delivered cell clears the floor.
  const billed = await deliverDataProduct(ctx, {
    dataProductId: product.id,
    subscriberRef: `provider:${input.providerId}`,
    cellCount: cut.smallestCell,
    netMinor: feeMinor,
    idempotencyKey: `dprod-deliver:${input.key}`
  });

  const bytes = new TextEncoder().encode(JSON.stringify({ ...cut, providerId: input.providerId }));
  const row = await storeExport(ctx, bucket, {
    runId: null,
    reportId: null,
    subjectRef: subjectRefOf(product.id),
    format: "json",
    rendered: { bytes, contentType: "application/json" },
    rowCount: cut.cells.length,
    unmasked: false
  });

  await audit(ctx, {
    action: "scout.data_product.deliver",
    subjectRef: subjectRefOf(product.id),
    after: {
      providerId: input.providerId,
      exportId: row.id,
      invoiceId: billed.invoiceId,
      cells: cut.cells.length,
      suppressed: cut.suppressed,
      floor: cut.floor,
      feeMinor
    }
  });

  return {
    dataProductId: product.id,
    providerId: input.providerId,
    exportId: row.id,
    invoiceId: billed.invoiceId,
    deliverTxnId: billed.deliverTxnId ?? null,
    feeMinor,
    cells: cut.cells.length,
    suppressed: cut.suppressed
  };
}

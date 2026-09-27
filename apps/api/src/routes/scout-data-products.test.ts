import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import { decide, notFound, permissionsForRole, seed, type Ctx } from "@lyra/core";
import { Gateway, makeStub } from "@lyra/model-gateway";
import { onError } from "../mw.js";
import { scoutRoutes } from "./scout.js";
import { analyticsRoutes } from "./analytics.js";
import type { App, Env } from "../env.js";

// docs/30 SCOUT 1: `subscribeToDataProduct` and `deliverDataProduct` existed
// (engines/billing.ts) and only their own tests called them. These are the
// callers, driven through the real router so the permission gate, the approval
// gate, the idempotency slot, the k-anonymity precondition and the delivery
// log are the ones production runs.
//
//   POST /data-products/:id/subscribe  scout:data_products:publish, approval-gated
//   POST /data-products/:id/deliver    scout:data_products:publish

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

const NOW = Date.UTC(2026, 8, 27, 9, 0, 0);
const DAY = 86_400_000;

let ctx: Ctx;
let tenantId: string;
let providerId: string;
let otherProviderId: string;
let seededProductId: string;

/** R2 as a Map — enough to prove the bytes landed and what they say. */
const objects = new Map<string, Uint8Array>();
const bucket = {
  put: async (key: string, value: Uint8Array) => {
    objects.set(key, value);
  },
  get: async (key: string) => (objects.has(key) ? { body: objects.get(key), size: objects.get(key)!.length } : null)
} as unknown as Env["FILES"];

const PRODUCT = "dtp_test_demand";
const THIN = "dtp_test_thin";
const ODD = "dtp_test_odd";
const DRAFT = "dtp_test_draft";

async function product(id: string, definition: Record<string, unknown>, status = "published"): Promise<void> {
  await ctx.db.insert(schema.scoutDataProducts).values({
    id,
    tenantId,
    name: id,
    definitionJson: JSON.stringify(definition),
    consentBasis: "consent:dataSharing",
    aggregationMin: 20,
    subscribersJson: null,
    delivery: "api",
    status,
    createdAt: NOW - 30 * DAY,
    updatedAt: NOW - 30 * DAY
  });
}

/** `n` quote requests on the test line, each with the given inputs. */
async function requests(prefix: string, n: number, opts: { inputs: Record<string, unknown>; consent: boolean; converted?: number; line: string }): Promise<void> {
  const productId = `prd_${opts.line}`;
  await ctx.db
    .insert(schema.products)
    .values({ id: productId, tenantId, line: opts.line, nameJson: JSON.stringify({ en: opts.line }), createdAt: NOW, updatedAt: NOW } as never)
    .onConflictDoNothing();
  await ctx.db.insert(schema.distQuoteRequests).values(
    Array.from({ length: n }, (_, i) => ({
      id: `${prefix}_${i}`,
      tenantId,
      customerId: `cust_${prefix}_${i}`,
      channelId: "chn_test",
      productId,
      inputsJson: JSON.stringify(opts.inputs),
      consentId: opts.consent ? `cns_${prefix}_${i}` : null,
      currency: "AED",
      state: i < (opts.converted ?? 0) ? "converted" : "complete",
      bestPremiumMinor: 100_000 + i * 1_000,
      fanoutCount: 3,
      respondedCount: 3,
      createdAt: NOW - 10 * DAY,
      updatedAt: NOW - 10 * DAY
    })) as never
  );
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  const db = drizzle(client) as unknown as Ctx["db"];
  const r = await seed(db, { password: "scout-data-products-test-password-2026" });
  tenantId = r.tenantId;
  ctx = {
    db,
    tenantId,
    actor: { kind: "user", id: "u_admin", tenantId, grants: [{ roleKey: "scout.admin", permissions: permissionsForRole("scout.admin") }] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({ modules: ["axis", "orbit", "signal", "scout", "north"] })
  };
  const providers = await ctx.db.select({ id: schema.providers.id }).from(schema.providers).where(eq(schema.providers.tenantId, tenantId));
  providerId = providers[0]!.id;
  otherProviderId = providers[1]!.id;
  const [seeded] = await ctx.db
    .select({ id: schema.scoutDataProducts.id, subscribersJson: schema.scoutDataProducts.subscribersJson })
    .from(schema.scoutDataProducts)
    .where(and(eq(schema.scoutDataProducts.tenantId, tenantId), eq(schema.scoutDataProducts.status, "published")));
  seededProductId = seeded!.id;

  const demand = { source: "dist_quote_requests", line: "dptest", dimensions: ["emirate"], measures: ["requests", "bindRateBps", "medianQuotedPremiumMinor"], window: "trailing_12_month" };
  await product(PRODUCT, demand);
  await product(THIN, { ...demand, line: "dpthin" });
  await product(ODD, { ...demand, source: "scout_panel_bench" });
  await product(DRAFT, demand, "draft");
  // 25 consented in Dubai (5 converted), 3 consented in Ajman (a cell of 3,
  // suppressed), 30 unconsented in Dubai (excluded: the basis is consent).
  await requests("qr_dxb", 25, { inputs: { emirate: "dubai", name: "Private Person" }, consent: true, converted: 5, line: "dptest" });
  await requests("qr_ajm", 3, { inputs: { emirate: "ajman" }, consent: true, line: "dptest" });
  await requests("qr_nocns", 30, { inputs: { emirate: "dubai" }, consent: false, line: "dptest" });
  await requests("qr_thin", 4, { inputs: { emirate: "sharjah" }, consent: true, line: "dpthin" });
}, 120_000);

function app(over: Partial<Ctx> = {}): Hono<App> {
  const stub = makeStub({});
  const gw = new Gateway({ env: {}, providers: { "workers-ai": stub, anthropic: stub, "openai-compat": stub } });
  const a = new Hono<App>();
  a.onError(onError);
  a.notFound((c) => onError(notFound(c.req.path), c));
  a.use("*", async (c, next) => {
    c.set("ctx", { ...ctx, ...over });
    c.set("gateway", gw);
    await next();
  });
  a.route("/scout", scoutRoutes);
  a.route("/analytics", analyticsRoutes);
  return a;
}

const send = async (a: Hono<App>, method: string, path: string, headers: Record<string, string> = {}, payload?: unknown) => {
  const res = await a.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    }),
    { FILES: bucket } as Env
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> };
};

const autoApproved = (): Partial<Ctx> => ({ policy: PolicyJson.parse({ autoApprove: ["scout.data_product_subscribe"] }) });

const subscribersOf = async (id: string) => {
  const [row] = await ctx.db
    .select({ subscribersJson: schema.scoutDataProducts.subscribersJson })
    .from(schema.scoutDataProducts)
    .where(and(eq(schema.scoutDataProducts.tenantId, tenantId), eq(schema.scoutDataProducts.id, id)));
  return JSON.parse(row?.subscribersJson ?? "[]") as { providerId: string; since: number; feeMinor?: number; suspendedAt?: number }[];
};

const txnsOf = async (type: string) =>
  ctx.db.select().from(schema.ledgerTxns).where(and(eq(schema.ledgerTxns.tenantId, tenantId), eq(schema.ledgerTxns.type, type)));

describe("POST /data-products/:id/subscribe", () => {
  it("needs the publish permission — a lead may define a product but not sell it", async () => {
    const lead = { kind: "user" as const, id: "u_lead", tenantId, grants: [{ roleKey: "scout.lead", permissions: permissionsForRole("scout.lead") }] };
    const res = await send(app({ actor: lead }), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-lead" }, { providerId, feeMinor: 50_000 });
    expect(res.status).toBe(403);
  });

  it("needs an idempotency key: a subscription is a contract", async () => {
    const res = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, {}, { providerId, feeMinor: 50_000 });
    expect(res.status).toBe(400);
  });

  it("refuses a fee that is not a positive whole number of minor units", async () => {
    for (const feeMinor of [0, -5, 1.5]) {
      const res = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": `k-fee-${feeMinor}` }, { providerId, feeMinor });
      expect(res.status).toBe(400);
    }
  });

  it("refuses a draft product and an unknown provider", async () => {
    const draft = await send(app(), "POST", `/scout/data-products/${DRAFT}/subscribe`, { "idempotency-key": "k-draft" }, { providerId, feeMinor: 50_000 });
    expect(draft.status).toBe(409);
    const stranger = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-stranger" }, { providerId: "prv_nobody", feeMinor: 50_000 });
    expect(stranger.status).toBe(404);
  });

  it("asks for approval first, then subscribes once approved: DPROD-SUB posted, subscriber recorded with its fee, audited", async () => {
    const first = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-sub-1" }, { providerId, feeMinor: 50_000 });
    expect(first.status).toBe(403);
    expect(first.body.code).toBe("approval_required");
    expect(await subscribersOf(PRODUCT)).toEqual([]);
    expect((await txnsOf("DPROD-SUB")).length).toBe(0);

    const [pending] = await ctx.db
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, tenantId), eq(schema.approvals.subjectRef, `scout_data_product:${PRODUCT}:${providerId}`)));
    expect(pending?.policyKey).toBe("scout.data_product_subscribe");
    expect(JSON.parse(pending!.contextJson!)).toMatchObject({ amountMinor: 50_000 });
    await decide(ctx, pending!.id, "approved");

    const second = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-sub-1" }, { providerId, feeMinor: 50_000 });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ dataProductId: PRODUCT, providerId, feeMinor: 50_000 });
    expect(await subscribersOf(PRODUCT)).toEqual([{ providerId, since: NOW, feeMinor: 50_000 }]);
    expect((await txnsOf("DPROD-SUB")).length).toBe(1);

    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, tenantId), eq(schema.auditLog.action, "scout.data_product.subscribe")));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.subjectRef).toBe(`scout_data_product:${PRODUCT}`);

    // A replay of the same key is the same answer, not a second contract.
    const replay = await send(app(), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-sub-1" }, { providerId, feeMinor: 50_000 });
    expect(replay).toEqual(second);
    expect((await txnsOf("DPROD-SUB")).length).toBe(1);
  });

  it("re-prices an existing subscriber in place, keeping the date they joined", async () => {
    const later = NOW + DAY;
    const res = await send(app({ ...autoApproved(), now: later }), "POST", `/scout/data-products/${PRODUCT}/subscribe`, { "idempotency-key": "k-sub-2" }, { providerId, feeMinor: 60_000 });
    expect(res.status).toBe(201);
    expect(await subscribersOf(PRODUCT)).toEqual([{ providerId, since: NOW, feeMinor: 60_000 }]);
  });
});

describe("POST /data-products/:id/deliver", () => {
  it("refuses a provider that does not subscribe", async () => {
    const res = await send(app(), "POST", `/scout/data-products/${PRODUCT}/deliver`, { "idempotency-key": "k-del-none" }, { providerId: otherProviderId });
    expect(res.status).toBe(409);
  });

  it("refuses a subscription that records no fee — the seeded ones predate the price — rather than invent one", async () => {
    const [subscriber] = await subscribersOf(seededProductId);
    const res = await send(app(), "POST", `/scout/data-products/${seededProductId}/deliver`, { "idempotency-key": "k-del-nofee" }, { providerId: subscriber!.providerId });
    expect(res.status).toBe(409);
    expect(String(res.body.detail)).toMatch(/fee/);
  });

  it("refuses a definition it has no builder for, naming the source", async () => {
    await send(app(autoApproved()), "POST", `/scout/data-products/${ODD}/subscribe`, { "idempotency-key": "k-sub-odd" }, { providerId, feeMinor: 10_000 });
    const res = await send(app(), "POST", `/scout/data-products/${ODD}/deliver`, { "idempotency-key": "k-del-odd" }, { providerId });
    expect(res.status).toBe(409);
    expect(String(res.body.detail)).toMatch(/scout_panel_bench/);
  });

  it("refuses when every cell is under the floor — nothing is written, nothing is billed", async () => {
    await send(app(autoApproved()), "POST", `/scout/data-products/${THIN}/subscribe`, { "idempotency-key": "k-sub-thin" }, { providerId, feeMinor: 10_000 });
    const invoicesBefore = await ctx.db.select().from(schema.ledgerInvoices).where(eq(schema.ledgerInvoices.tenantId, tenantId));
    const res = await send(app(), "POST", `/scout/data-products/${THIN}/deliver`, { "idempotency-key": "k-del-thin" }, { providerId });
    expect(res.status).toBe(409);
    expect(String(res.body.detail)).toMatch(/k-anonymity/);
    const invoicesAfter = await ctx.db.select().from(schema.ledgerInvoices).where(eq(schema.ledgerInvoices.tenantId, tenantId));
    expect(invoicesAfter).toHaveLength(invoicesBefore.length);
    const exports = await ctx.db
      .select()
      .from(schema.analyticsExports)
      .where(and(eq(schema.analyticsExports.tenantId, tenantId), eq(schema.analyticsExports.subjectRef, `scout_data_product:${THIN}`)));
    expect(exports).toEqual([]);
  });

  it("builds the cut the product defines — consented rows only, thin cells suppressed — logs it, bills the approved fee", async () => {
    const res = await send(app(), "POST", `/scout/data-products/${PRODUCT}/deliver`, { "idempotency-key": "k-del-1" }, { providerId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ dataProductId: PRODUCT, providerId, cells: 1, suppressed: 1, feeMinor: 60_000 });

    const [log] = await ctx.db
      .select()
      .from(schema.analyticsExports)
      .where(and(eq(schema.analyticsExports.tenantId, tenantId), eq(schema.analyticsExports.subjectRef, `scout_data_product:${PRODUCT}`)));
    expect(log).toMatchObject({ id: res.body.exportId, format: "json", state: "ready", rowCount: 1, piiMasked: true });

    const [file] = await ctx.db.select().from(schema.files).where(eq(schema.files.id, log!.fileId!));
    const cut = JSON.parse(new TextDecoder().decode(objects.get(file!.r2Key)));
    expect(cut).toMatchObject({
      dataProductId: PRODUCT,
      floor: 20,
      suppressed: 1,
      cells: [{ emirate: "dubai", requests: 25, bindRateBps: 2_000, medianQuotedPremiumMinor: 112_000 }]
    });
    // Nothing identifying survives aggregation.
    expect(JSON.stringify(cut)).not.toMatch(/Private Person|cust_|qr_/);

    const [invoice] = await ctx.db.select().from(schema.ledgerInvoices).where(eq(schema.ledgerInvoices.id, String(res.body.invoiceId)));
    expect(invoice).toMatchObject({ customerRef: `provider:${providerId}`, totalMinor: 60_000 });
    expect((await txnsOf("DPROD-DELIVER")).length).toBe(1);

    const replay = await send(app(), "POST", `/scout/data-products/${PRODUCT}/deliver`, { "idempotency-key": "k-del-1" }, { providerId });
    expect(replay).toEqual(res);
    expect((await txnsOf("DPROD-DELIVER")).length).toBe(1);
  });

  it("the delivery log reads only this product's cuts from the export register", async () => {
    const res = await send(app(), "GET", `/analytics/exports?subjectRef=${encodeURIComponent(`scout_data_product:${PRODUCT}`)}`);
    expect(res.status).toBe(200);
    const rows = (res.body as unknown as { data: { subjectRef: string | null }[] }).data;
    expect(rows.length).toBe(1);
    expect(rows.every((row) => row.subjectRef === `scout_data_product:${PRODUCT}`)).toBe(true);
    const none = await send(app(), "GET", `/analytics/exports?subjectRef=scout_data_product:nothing`);
    expect((none.body as unknown as { data: unknown[] }).data).toEqual([]);
  });
});

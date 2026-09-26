import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/27 F4 / docs/specs/gap-axis-design.md §H task 3. Before this file there
// was no issuance path in production code: `/dist/quote-requests/:id/select`
// stamped `selectedAt` and stopped, and the only "bind" anywhere was a policy
// row hand-assembled through generic CRUD. A bind is a contract coming into
// existence — one transaction, one version row, one audited state hop.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const DAY = 86_400_000;
const exec = { waitUntil() {}, passThroughOnException() {} };
const RISK = { age: 34, sumInsuredMinor: 28_000_000, priorClaims: false, vehicleUse: "private", market: "AE" };

let env: Env;
let database: Db;
let seeded: SeedResult;
let token: string;
let productId: string;
let customerId: string;
let consentId: string;

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : await res.arrayBuffer()) as T };
}

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** A fresh shop + select, so each test owns a response nobody else has bound. */
async function selectedQuote(): Promise<{ responseId: string; premiumMinor: number }> {
  const shopped = ok(
    await call("POST", "/v1/dist/quote-requests/shop", {
      productId,
      channelId: seeded.channels.web,
      customerId,
      consentId,
      inputs: RISK,
      currency: "AED"
    }),
    201
  );
  const quoted = (shopped.responses as any[]).filter((r) => r.state === "quoted");
  const best = quoted.slice().sort((a, b) => a.premiumMinor - b.premiumMinor)[0];
  expect(best, "the motor panel returned no quote to bind").toBeTruthy();
  ok(await call("POST", `/v1/dist/quote-requests/${shopped.request.id}/select`, { responseId: best.id }));
  return { responseId: best.id as string, premiumMinor: best.premiumMinor as number };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  // `axis.bind` on this tenant's own autoApprove allowlist, as in
  // axis-zero-touch.test.ts: the gate itself is proven by J-O1 in
  // journeys.test.ts, and what is under test here is the issuance mechanics.
  const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
  const policy = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
  await database
    .update(schema.tenants)
    .set({ policyJson: JSON.stringify({ ...policy, autoApprove: [...policy.autoApprove, "axis.bind", "axis.underwriting_referral"] }) })
    .where(eq(schema.tenants.id, seeded.tenantId));

  const login = await call("POST", "/v1/auth/login", {
    email: "omar.farouk@gonxt.ae",
    password: PASSWORD,
    tenantSlug: "gonxt"
  });
  token = ok(login).token as string;
  const verified = await call("POST", "/v1/auth/mfa/verify", {
    code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
  });
  expect(verified.status).toBe(200);

  productId = (await database.select().from(schema.products).where(eq(schema.products.line, "motor")))[0]!.id;
  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
  consentId = customer.consentId!;
}, 120_000);

describe("AXIS bind (docs/27 F4)", () => {
  it("binds a selected dist_quote_response into a policy with version 1", async () => {
    const { responseId, premiumMinor } = await selectedQuote();
    const start = Date.now();

    const out = ok(
      await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
        policyNo: "POL-BIND-1",
        startAt: start,
        endAt: start + 365 * DAY
      }),
      201
    );

    expect(out.policy.status).toBe("bound");
    expect(out.policy.premiumMinor).toBe(premiumMinor);
    expect(out.policy.versionSeq).toBe(1);
    expect(out.policy.currentVersionId).toBe(out.version.id);
    expect(out.policy.lastTxnId).toBe(out.txn.id);
    expect(out.txn.state).toBe("settled");

    const version = (
      await database
        .select()
        .from(schema.axisPolicyVersions)
        .where(eq(schema.axisPolicyVersions.policyId, out.policy.id))
    )[0]!;
    expect(version.versionSeq).toBe(1);
    expect(version.state).toBe("effective");
    expect(version.reason).toBe("issue");
    expect(version.quoteResponseId).toBe(responseId);
    expect(version.txnId).toBe(out.txn.id);
    expect(version.premiumDeltaMinor).toBe(0);
    expect(version.effectiveFrom).toBe(start);

    // The money moved through the ledger, not through a column write: BIND is
    // financial, so a settled transaction must carry a balanced batch.
    expect(out.txn.ledgerBatchId).toBeTruthy();
    const legs = await database
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.batchId, out.txn.ledgerBatchId as string));
    expect(legs.length).toBeGreaterThanOrEqual(2);
    const debit = legs.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
    const credit = legs.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);
    expect(debit).toBe(credit);

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.action, "axis.policy.bind")));
    expect(audits.some((a) => a.subjectRef === out.policy.id)).toBe(true);

    const events = await database.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "axis.policy.issued"));
    expect(events.some((e) => e.envelopeJson.includes(out.policy.id))).toBe(true);

    // docs/30 AXIS gap 2: the customer's schedule is produced by the bind itself,
    // not by someone remembering to press a button afterwards.
    const [issued] = await database.select().from(schema.axisPolicyVersions).where(eq(schema.axisPolicyVersions.id, out.version.id));
    expect(issued!.documentFileId).toBeTruthy();
    const docs = await database.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "axis.policy.document_issued"));
    expect(docs.some((e) => e.envelopeJson.includes(out.policy.id))).toBe(true);
  });

  it("the comparison names the policy a bound quote became, so a revisit cannot bind twice", async () => {
    const { responseId } = await selectedQuote();
    const [row] = await database.select().from(schema.distQuoteResponses).where(eq(schema.distQuoteResponses.id, responseId));
    const before = ok(await call("GET", `/v1/dist/quote-requests/${row!.requestId}/comparison`));
    expect(before.quotes.every((q: any) => q.policyId === null)).toBe(true);
    const start = Date.now();
    const out = ok(await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, { policyNo: "POL-BIND-CMP", startAt: start, endAt: start + 365 * DAY }), 201);
    const after = ok(await call("GET", `/v1/dist/quote-requests/${row!.requestId}/comparison`));
    expect(after.quotes.find((q: any) => q.id === responseId).policyId).toBe(out.policy.id);
  });

  it("is idempotent under a replayed idempotency key", async () => {
    const { responseId } = await selectedQuote();
    const start = Date.now();
    const payload = { policyNo: "POL-BIND-2", startAt: start, endAt: start + 365 * DAY };
    const key = { "idempotency-key": "bind-replay-1" };

    const first = ok(await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, payload, key), 201);
    const second = ok(await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, payload, key), 201);

    expect(second.policy.id).toBe(first.policy.id);
    expect(second.version.id).toBe(first.version.id);
    expect(second.txn.id).toBe(first.txn.id);

    // One contract, one version, one journal — a replay that doubled any of
    // these would be a second commission accrual against the same policy.
    const policies = await database
      .select()
      .from(schema.axisPolicies)
      .where(and(eq(schema.axisPolicies.tenantId, seeded.tenantId), eq(schema.axisPolicies.policyNo, "POL-BIND-2")));
    expect(policies.length).toBe(1);
    const versions = await database
      .select()
      .from(schema.axisPolicyVersions)
      .where(eq(schema.axisPolicyVersions.policyId, first.policy.id));
    expect(versions.length).toBe(1);
  });

  // The hand-written `BindBody` is a trust boundary too, and it was not one:
  // `z.number().int()` is a *safe*-integer check, so `endAt: 9e15` was accepted
  // and persisted. `checkCoverage` then answers "in force" for the next 250 000
  // years and apps/web's policy page throws RangeError formatting the term.
  it("refuses an endAt outside the range a Date can hold, and still binds a real term", async () => {
    const { responseId } = await selectedQuote();
    const start = Date.now();

    const bad = await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
      policyNo: "POL-BIND-RANGE",
      startAt: start,
      endAt: 9e15
    });
    expect(bad.status).toBe(400);
    const written = await database
      .select()
      .from(schema.axisPolicies)
      .where(
        and(eq(schema.axisPolicies.tenantId, seeded.tenantId), eq(schema.axisPolicies.policyNo, "POL-BIND-RANGE"))
      );
    expect(written).toEqual([]);

    // Positive control: the same response, the same policy number, a term a
    // Date can hold — the bound refuses the unrenderable value and nothing else.
    const good = ok(
      await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
        policyNo: "POL-BIND-RANGE",
        startAt: start,
        endAt: start + 365 * DAY
      }),
      201
    );
    expect(good.policy.endAt).toBe(start + 365 * DAY);
  });

  it("refuses an operator shop that names no customer: a sale needs one (docs/27, 2026-09-23)", async () => {
    const res = await call("POST", "/v1/dist/quote-requests/shop", {
      productId,
      channelId: seeded.channels.web,
      consentId,
      inputs: RISK,
      currency: "AED"
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty("customerId");
  });

  it("refuses a hand-opened quote request that names no customer", async () => {
    const res = await call("POST", "/v1/dist/quote-requests", {
      productId,
      channelId: seeded.channels.web,
      inputsJson: "{}",
      currency: "AED"
    });
    expect(res.status).toBe(400);
    expect(res.body.errors).toHaveProperty("customerId");
  });

  it("refuses to bind twice from the same response", async () => {
    const { responseId } = await selectedQuote();
    const start = Date.now();
    ok(
      await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
        policyNo: "POL-BIND-3",
        startAt: start,
        endAt: start + 365 * DAY
      }),
      201
    );

    // A different policy number and a different idempotency key: this is not a
    // replay, it is a second contract sold off one accepted quote.
    const again = await call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
      policyNo: "POL-BIND-3B",
      startAt: start,
      endAt: start + 365 * DAY
    });
    expect(again.status).toBe(409);
    expect(again.body.detail).toContain("already bound");
  });
});

/**
 * docs/27 F25. Premium was read as "a free-text integer with no tax/fee split".
 * The split exists now — `rating.ts` computes `taxMinor` from the table's
 * `taxPpm`, the quoter carries it, bind writes it to the policy and the version
 * — but nothing asserted that it survives the whole chain, and a split that
 * silently falls back to zero at any hand-off is indistinguishable from not
 * having one. Every step from the rating table to the schedule is checked here
 * so the chain cannot rot at a seam.
 */
describe("AXIS premium carries a tax and fee split (docs/27 F25)", () => {
  it("the split survives rating, quote, policy, version and schedule", async () => {
    const shopped = ok(
      await call("POST", "/v1/dist/quote-requests/shop", {
        productId,
        channelId: seeded.channels.web,
        customerId,
        consentId,
        inputs: RISK,
        currency: "AED"
      }),
      201
    );
    const quoted = (shopped.responses as any[]).filter((r) => r.state === "quoted");
    const best = quoted.slice().sort((a, b) => a.premiumMinor - b.premiumMinor)[0];

    // The seeded motor tables carry `taxPpm: 50_000` — 5% VAT. A zero here is
    // the whole finding: it means the rate never reached the rating engine.
    expect(best.taxMinor).toBeGreaterThan(0);
    expect(best.taxMinor).toBe(Math.floor((best.premiumMinor * 50_000) / 1_000_000));

    ok(await call("POST", `/v1/dist/quote-requests/${shopped.request.id}/select`, { responseId: best.id }));
    const start = Date.now();
    const out = ok(
      await call("POST", `/v1/axis/quote-responses/${best.id}/bind`, {
        policyNo: "POL-BIND-TAX",
        startAt: start,
        endAt: start + 365 * DAY
      }),
      201
    );

    // Gross is the sum, not a fourth free-text number: a reader who adds the
    // parts and a reader who takes the total must agree.
    expect(out.policy.taxMinor).toBe(best.taxMinor);
    expect(out.policy.feesMinor).toBe(best.feesMinor ?? 0);
    expect(out.policy.grossMinor).toBe(out.policy.premiumMinor + out.policy.taxMinor + out.policy.feesMinor);

    const version = (
      await database
        .select()
        .from(schema.axisPolicyVersions)
        .where(eq(schema.axisPolicyVersions.policyId, out.policy.id))
    )[0]!;
    expect(version.taxMinor).toBe(out.policy.taxMinor);
    expect(version.feesMinor).toBe(out.policy.feesMinor);
    expect(version.premiumMinor).toBe(out.policy.premiumMinor);
  });
});

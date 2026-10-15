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
import { requoteRenewal } from "./engines/orbit-requote.js";

// ADR-0125. AXIS could place a risk anywhere and recorded nowhere which market
// or which licence it was placed under; `MARKETS`/`REGULATORS`
// (packages/core/src/operating-model.ts) quoted the broker's two real licence
// numbers and no route read them. This file is the seam: the refusal when no
// authorisation covers the placement, the refusal when the one on file has
// expired, the success when one is live, and the CRUD around the register.

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
/** khalid.rashed, tenant.compliance — the seat that keeps the register. */
let complianceToken: string;
let productId: string;
let customerId: string;
let consentId: string;

interface Res<T = any> {
  status: number;
  body: T;
}

/** One request with an explicit credential (`null` for the public login door). */
async function fetchAs<T = any>(
  bearer: string | null,
  method: string,
  path: string,
  payload?: unknown
): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : await res.arrayBuffer()) as T };
}

/** Sign one seeded persona in, second factor and all. The token is stable across it. */
async function login(email: string): Promise<string> {
  const started = await fetchAs<{ token: string }>(null, "POST", "/v1/auth/login", {
    email,
    password: PASSWORD,
    tenantSlug: "gonxt"
  });
  const pre = ok(started).token;
  const verified = await fetchAs(pre, "POST", "/v1/auth/mfa/verify", {
    code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
  });
  expect(verified.status, email).toBe(200);
  return pre;
}

/** The AXIS lead's credential: the seat that binds. */
const call = <T = any>(method: string, path: string, payload?: unknown) =>
  fetchAs<T>(token, method, path, payload);

/** The compliance officer's own credential, for the register's write surface. */
const asCompliance = <T = any>(method: string, path: string, payload?: unknown) =>
  fetchAs<T>(complianceToken, method, path, payload);

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

async function bind(responseId: string, policyNo: string): Promise<Res> {
  const start = Date.now();
  return call("POST", `/v1/axis/quote-responses/${responseId}/bind`, {
    policyNo,
    startAt: start,
    endAt: start + 365 * DAY
  });
}

/** The tenant's own statement of where it is established (ADR-0075/0121). */
async function setTaxMarket(market: string | null): Promise<void> {
  const [row] = await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId));
  const policy = JSON.parse(row!.policyJson as string) as Record<string, unknown>;
  if (market === null) delete policy.taxMarket;
  else policy.taxMarket = market;
  await database
    .update(schema.tenants)
    .set({ policyJson: JSON.stringify(policy) })
    .where(eq(schema.tenants.id, seeded.tenantId));
}

const authorisations = (tenantId: string) =>
  database.select().from(schema.axisAuthorisations).where(eq(schema.axisAuthorisations.tenantId, tenantId));

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

  // `axis.bind` and `axis.underwriting_referral` on the tenant's own allowlist,
  // as in axis-bind.test.ts: the underwriting gate is a different test's subject
  // and would otherwise answer first, before the authorisation seam is reached.
  const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
  const policy = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
  await database
    .update(schema.tenants)
    .set({
      policyJson: JSON.stringify({
        ...policy,
        autoApprove: [...policy.autoApprove, "axis.bind", "axis.underwriting_referral"]
      })
    })
    .where(eq(schema.tenants.id, seeded.tenantId));

  // The desk that binds, and the officer who keeps the register it reads.
  token = await login("omar.farouk@gonxt.ae");
  complianceToken = await login("khalid.rashed@gonxt.ae");

  productId = (await database.select().from(schema.products).where(eq(schema.products.line, "motor")))[0]!.id;
  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
  consentId = customer.consentId!;
}, 120_000);

describe("the seeded register (ADR-0125)", () => {
  it("a fresh tenant holds the two UAE licences REGULATORS quotes", async () => {
    const out = ok(await call("GET", "/v1/axis/authorisations"));
    const rows = out.data as any[];
    expect(rows.map((r) => r.licenceNumber).sort()).toEqual(["20", "BRK-00045"]);
    expect([...new Set(rows.map((r) => r.market))]).toEqual(["AE"]);
    // The lines are the operating model's classes, not a restatement of them.
    const centralBank = rows.find((r) => r.regulatorKey === "ae_central_bank")!;
    expect(centralBank.productLinesJson).toContain("car_insurance");
    expect(centralBank.scope).toBe("insurance_broking");
  });
});

describe("the bind seam refuses an unlicensed placement", () => {
  it("binds when an active authorisation covers the market and the product's line", async () => {
    const { responseId } = await selectedQuote();
    const out = ok(await bind(responseId, "POL-AUTH-OK"), 201);
    expect(out.policy.status).toBe("bound");

    // ADR-0128: the contract records the market it was placed in, from the same
    // statement the licence check just read — so the licence that permitted the
    // placement and the market stamped on it cannot disagree. Without this a
    // nine-market book cannot answer a per-market question from its own rows.
    const [row] = await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.policyNo, "POL-AUTH-OK"));
    expect(row!.market).toBe("AE");
  });

  it("refuses with a named 400 when the tenant holds nothing for the market", async () => {
    const { responseId } = await selectedQuote();
    await setTaxMarket("QA");
    try {
      const refused = await bind(responseId, "POL-AUTH-NONE");
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("authorisation_required");
      expect(refused.body.reason).toBe("none_on_file");
      expect(refused.body.market).toBe("QA");
      expect(refused.body.detail).toContain("no authorisation is on file");

      // The refusal is a refusal to *bind*: the draft the retry needs is still
      // there (the same shape the authority referral leaves), and no contract
      // and no money exist.
      const [policy] = await database
        .select()
        .from(schema.axisPolicies)
        .where(
          and(eq(schema.axisPolicies.tenantId, seeded.tenantId), eq(schema.axisPolicies.policyNo, "POL-AUTH-NONE"))
        );
      expect(policy?.status).toBe("draft");
      expect(policy?.currentVersionId).toBeNull();
    } finally {
      await setTaxMarket(null);
    }
  });

  it("refuses with `expired`, distinct from nothing on file, when the window has passed", async () => {
    const [centralBank] = (await authorisations(seeded.tenantId)).filter(
      (row) => row.regulatorKey === "ae_central_bank"
    );
    const before = centralBank!.validTo;
    await database
      .update(schema.axisAuthorisations)
      .set({ validTo: Date.now() - DAY })
      .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    try {
      const { responseId } = await selectedQuote();
      const refused = await bind(responseId, "POL-AUTH-EXPIRED");
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe("authorisation_required");
      expect(refused.body.reason).toBe("expired");
      expect(refused.body.detail).toContain("expired on");
    } finally {
      await database
        .update(schema.axisAuthorisations)
        .set({ validTo: before })
        .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    }
  });

  it("refuses a market the tenant holds a licence for but a line it does not cover", async () => {
    const [centralBank] = (await authorisations(seeded.tenantId)).filter(
      (row) => row.regulatorKey === "ae_central_bank"
    );
    const before = centralBank!.productLinesJson;
    await database
      .update(schema.axisAuthorisations)
      .set({ productLinesJson: JSON.stringify(["home_insurance"]) })
      .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    try {
      const { responseId } = await selectedQuote();
      const refused = await bind(responseId, "POL-AUTH-LINE");
      expect(refused.status).toBe(400);
      expect(refused.body.reason).toBe("none_on_file");
      expect(refused.body.detail).toContain("car_insurance");
    } finally {
      await database
        .update(schema.axisAuthorisations)
        .set({ productLinesJson: before })
        .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    }
  });

  it("refuses a suspended licence by name rather than treating it as active", async () => {
    const [centralBank] = (await authorisations(seeded.tenantId)).filter(
      (row) => row.regulatorKey === "ae_central_bank"
    );
    await database
      .update(schema.axisAuthorisations)
      .set({ status: "suspended" })
      .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    try {
      const { responseId } = await selectedQuote();
      const refused = await bind(responseId, "POL-AUTH-SUSPENDED");
      expect(refused.status).toBe(400);
      expect(refused.body.reason).toBe("suspended");
    } finally {
      await database
        .update(schema.axisAuthorisations)
        .set({ status: "active" })
        .where(eq(schema.axisAuthorisations.id, centralBank!.id));
    }
  });
});

describe("the register is CRUD the compliance seat keeps", () => {
  it("creates, reads back and updates a licence, normalising the market code", async () => {
    const created = ok(
      await asCompliance(
        "POST",
        "/v1/axis/authorisations",
        {
          market: "ae",
          regulatorKey: "test_regulator",
          licenceNumber: "TEST-1",
          scope: "banking",
          productLinesJson: ["credit_cards"],
          validFrom: Date.now(),
          status: "active"
        }
      ),
      201
    );
    expect(created.market).toBe("AE");

    const read = ok(await call("GET", `/v1/axis/authorisations/${created.id}`));
    expect(read.licenceNumber).toBe("TEST-1");
    expect(read.productLinesJson).toEqual(["credit_cards"]);

    const patched = ok(await asCompliance("PATCH", `/v1/axis/authorisations/${created.id}`, { status: "suspended" }));
    expect(patched.status).toBe("suspended");
  });

  it("refuses a register row that could never authorise anything", async () => {
    const base = {
      market: "AE",
      regulatorKey: "test_regulator",
      licenceNumber: "TEST-2",
      scope: "insurance_broking",
      productLinesJson: ["car_insurance"],
      validFrom: Date.now()
    };
    const cases: [string, Record<string, unknown>, string][] = [
      ["an unknown scope", { ...base, scope: "witchcraft" }, "scope"],
      ["a line the operating model does not name", { ...base, productLinesJson: ["spaceships"] }, "product line"],
      ["a licence covering no line", { ...base, productLinesJson: [] }, "at least one product line"],
      ["a window that ends before it starts", { ...base, validTo: Date.now() - DAY }, "validTo"],
      ["a status that is not one of the three", { ...base, status: "pending" }, "status"]
    ];
    for (const [what, body, expected] of cases) {
      const res = await asCompliance("POST", "/v1/axis/authorisations", body);
      expect(res.status, what).toBe(400);
      expect(String(res.body.detail), what).toContain(expected);
    }
    // And none of them landed: the register holds only what the seed wrote plus
    // the licence the previous test created.
    const rows = (await authorisations(seeded.tenantId)).filter((row) => row.regulatorKey === "test_regulator");
    expect(rows.map((row) => row.licenceNumber)).toEqual(["TEST-1"]);
  });

  it("reads for the desk but refuses the write to a seat that is not the compliance officer", async () => {
    // omar.farouk is axis.lead: `readsOf("axis")` carries the read, and the write
    // belongs to tenant.compliance and axis.admin.
    expect((await call("GET", "/v1/axis/authorisations")).status).toBe(200);
    const res = await call("POST", "/v1/axis/authorisations", {
      market: "AE",
      regulatorKey: "x",
      licenceNumber: "X-1",
      scope: "banking",
      productLinesJson: ["credit_cards"],
      validFrom: Date.now()
    });
    expect(res.status).toBe(403);
  });
});

/* --------------------------- the re-quote engine against a real bound policy */

/**
 * ADR-0129's round trip, on the **only** fixture that can prove it.
 *
 * The first attempt at this test hand-inserted an `axis_policy_versions` row and
 * was refused six times, one NOT NULL column per run — `reason`, `effective_from`,
 * `effective_to`, `currency`, `terms_json`, `issued_by`. Every one was avoidable by
 * reading the schema, and the deeper error was the approach: **that row is written
 * by the bind path**, and a fixture that assembles it by hand is testing a fiction.
 * So this test binds a policy through the real route and re-quotes what follows.
 */
describe("a renewal behind a really-bound policy gets a real price", () => {
  it("re-shops the bound risk, stores the cheapest panel answer on the renewal", async () => {
    const { responseId } = await selectedQuote();
    const bound = ok(await bind(responseId, "POL-REQUOTE-1"), 201);

    const [policy] = await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.policyNo, "POL-REQUOTE-1"));
    expect(policy!.id).toBe(bound.policy.id);

    // The provenance the engine reads — created by the bind, not by this test.
    const versions = await database.select().from(schema.axisPolicyVersions).where(eq(schema.axisPolicyVersions.policyId, policy!.id));
    expect(versions[0]!.quoteResponseId).toBe(responseId);

    await database.insert(schema.orbitRenewals).values({
      id: "rnw_rt",
      tenantId: seeded.tenantId,
      policyRef: policy!.id,
      customerId: policy!.customerId,
      expiryAt: Date.now() + 20 * 86_400_000,
      strategy: "auto_requote",
      state: "scheduled",
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as never);

    const ctx = {
      db: database,
      tenantId: seeded.tenantId,
      actor: { kind: "user", id: "u_1", tenantId: seeded.tenantId, grants: [] },
      requestId: "req_rt",
      now: Date.now(),
      locale: "en",
      policy: { taxMarket: "AE", currency: "AED" },
      entitlements: {}
    } as never;

    // Two underwriters answer; the cheaper one must win and be stored.
    const stub = (async ({ provider }: { provider?: { id: string } }) => ({
      state: "quoted",
      premiumMinor: provider?.id === "prov_test" ? 111_000 : 99_000,
      taxMinor: 0,
      feesMinor: 0,
      currency: "AED"
    })) as never;

    const out = await requoteRenewal(ctx, {} as never, "rnw_rt", stub);
    expect(out).toBeTruthy();
    expect(out!.requote.quotes.length).toBeGreaterThanOrEqual(2);
    expect(out!.requote.premiumMinor).toBe(Math.min(...out!.requote.quotes.map((q) => q.premiumMinor)));

    // The column with no production writer now has one, on a renewal a real bind
    // produced.
    const [row] = await database.select().from(schema.orbitRenewals).where(eq(schema.orbitRenewals.id, "rnw_rt"));
    const stored = JSON.parse(String(row!.requotesJson)) as { premiumMinor: number; quotes: unknown[] };
    expect(stored.premiumMinor).toBe(99_000);
    expect(stored.quotes.length).toBeGreaterThanOrEqual(2);
  });
});

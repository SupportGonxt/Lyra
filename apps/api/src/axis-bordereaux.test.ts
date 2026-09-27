import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

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
let controllerToken: string;
let productId: string;
let customerId: string;
let consentId: string;

interface Res<T = any> { status: number; body: T; }

async function call<T = any>(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}, as: () => string = () => token): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${as()}`, ...headers },
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
  if (!allowed.includes(res.status)) throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

async function login(local: string): Promise<string> {
  const res = ok(await call("POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" }));
  const issued = res.token as string;
  const verified = await call("POST", "/v1/auth/mfa/verify", { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) }, {}, () => issued);
  expect(verified.status).toBe(200);
  return issued;
}

async function autoApprove(...keys: string[]): Promise<void> {
  const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
  const policy = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
  await database.update(schema.tenants).set({ policyJson: JSON.stringify({ ...policy, autoApprove: keys }) }).where(eq(schema.tenants.id, seeded.tenantId));
}

async function boundPolicy(policyNo: string, startAt: number) {
  const shopped = ok(await call("POST", "/v1/dist/quote-requests/shop", { productId, channelId: seeded.channels.web, customerId, consentId, inputs: RISK, currency: "AED" }), 201);
  const quoted = (shopped.responses as any[]).filter((r) => r.state === "quoted");
  const best = quoted.slice().sort((a, b) => a.premiumMinor - b.premiumMinor)[0];
  expect(best, "the motor panel returned no quote to bind").toBeTruthy();
  ok(await call("POST", `/v1/dist/quote-requests/${shopped.request.id}/select`, { responseId: best.id }));
  const bound = ok(await call("POST", `/v1/axis/quote-responses/${best.id}/bind`, { policyNo, startAt, endAt: startAt + 365 * DAY }), 201);
  return bound.policy.id as string;
}

async function policyRow(policyId: string) {
  return (await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policyId)))[0]!;
}

async function accrueCommission(policyId: string) {
  return ok(await call("POST", "/v1/dist/commission-entries/accrue", { policyId, kind: "new_business", earnedOn: "issue", taxMinor: 0 }, {}, () => controllerToken), 201);
}

function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  const statements = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;
  token = await login("omar.farouk");
  controllerToken = await login("faisal.omar");
  productId = (await database.select().from(schema.products).where(eq(schema.products.line, "motor")))[0]!.id;
  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
  consentId = customer.consentId!;
  await autoApprove("axis.bind", "axis.underwriting_referral", "dist.commission_accrue");
}, 120_000);

describe("AXIS bordereaux (docs/27 §E)", () => {
  it("an outbound premium bordereau totals to the period's commission entries", async () => {
    const policyId1 = await boundPolicy(`BDX-P-${Date.now()}-1`, Date.now());
    const policyId2 = await boundPolicy(`BDX-P-${Date.now()}-2`, Date.now());
    const entry1 = await accrueCommission(policyId1);
    const entry2 = await accrueCommission(policyId2);
    const providerId = (await policyRow(policyId1)).providerId;

    const generated = ok(
      await call("POST", "/v1/axis/bordereaux", {
        direction: "outbound",
        counterpartyKind: "provider",
        counterpartyId: providerId,
        kind: "premium",
        period: currentPeriod()
      }),
      201
    );

    expect(generated.bordereau.lineCount).toBeGreaterThanOrEqual(2);
    const expectedCommission = entry1.grossCommissionMinor + entry2.grossCommissionMinor;
    expect(generated.bordereau.commissionMinor).toBe(expectedCommission);
  });

  // `^\d{4}-\d{2}$` accepts `2026-13`, and `Date.UTC(2026, 12, 1)` rolls into
  // January 2027 without complaining — a bordereau labelled one month and
  // summing another, which is a regulatory return.
  it("refuses a period that is not a real month", async () => {
    const policyId = await boundPolicy(`BDX-BAD-${Date.now()}`, Date.now());
    const providerId = (await policyRow(policyId)).providerId;

    const res = await call("POST", "/v1/axis/bordereaux", {
      direction: "outbound",
      counterpartyKind: "provider",
      counterpartyId: providerId,
      kind: "premium",
      period: "2026-13"
    });
    expect(res.status).toBe(400);
  });

  it("regenerating the same period is idempotent", async () => {
    const policyId = await boundPolicy(`BDX-I-${Date.now()}`, Date.now());
    await accrueCommission(policyId);
    const providerId = (await policyRow(policyId)).providerId;
    const period = currentPeriod();
    const params = { direction: "outbound", counterpartyKind: "provider", counterpartyId: providerId, kind: "premium", period };

    const first = ok(await call("POST", "/v1/axis/bordereaux", params), 201);
    const second = ok(await call("POST", "/v1/axis/bordereaux", params), 201);

    expect(second.bordereau.id).toBe(first.bordereau.id);
    expect(second.bordereau.lineCount).toBe(first.bordereau.lineCount);
    expect(second.bordereau.commissionMinor).toBe(first.bordereau.commissionMinor);
  });

  it("an inbound line with no local match lands as missing_ours", async () => {
    const generated = ok(
      await call("POST", "/v1/axis/bordereaux", {
        direction: "inbound",
        counterpartyKind: "provider",
        counterpartyId: "ext-provider-1",
        kind: "premium",
        period: currentPeriod(),
        currency: "AED",
        lines: [{ externalRef: "NO-SUCH-POLICY-999", grossPremiumMinor: 500_000 }]
      }),
      201
    );

    const reconciled = ok(await call("POST", `/v1/axis/bordereaux/${generated.bordereau.id}/reconcile`), 200);
    expect(reconciled.lines).toHaveLength(1);
    expect(reconciled.lines[0].matchState).toBe("missing_ours");
  });

  it("an outbound claims bordereau totals paid and reserve amounts for the period", async () => {
    const policyId = await boundPolicy(`BDX-C-${Date.now()}`, Date.now());
    const policy = await policyRow(policyId);
    const now = Date.now();
    await database.insert(schema.axisClaims).values({
      id: `axclm_bdx_${now}`,
      tenantId: seeded.tenantId,
      policyId,
      customerId,
      claimNo: `BDX-CLM-${now}`,
      incidentAt: now - DAY,
      reportedAt: now,
      amountMinor: 400_000,
      paidMinor: 150_000,
      reserveMinor: 100_000,
      currency: "AED",
      createdAt: now,
      updatedAt: now
    } as typeof schema.axisClaims.$inferInsert);

    const generated = ok(
      await call("POST", "/v1/axis/bordereaux", {
        direction: "outbound",
        counterpartyKind: "provider",
        counterpartyId: policy.providerId,
        kind: "claims",
        period: currentPeriod()
      }),
      201
    );

    expect(generated.bordereau.lineCount).toBeGreaterThanOrEqual(1);
    expect(generated.bordereau.claimsPaidMinor).toBeGreaterThanOrEqual(150_000);
    expect(generated.bordereau.reserveMinor).toBeGreaterThanOrEqual(100_000);
  });
});

// docs/30 Ledger 5, ADR-0105. Inbound reconciliation: a counterparty's CSV,
// read row-honestly, matched against the period's commission entries, and
// reported — never a money write.
describe("inbound bordereau reconciliation (docs/30 Ledger 5)", () => {
  async function importCsv(csv: string, counterpartyId: string, extra: Record<string, unknown> = {}) {
    return call("POST", "/v1/axis/bordereaux/import", {
      counterpartyKind: "provider",
      counterpartyId,
      kind: "premium",
      period: currentPeriod(),
      currency: "AED",
      csv,
      ...extra
    });
  }

  it("imports a CSV, and classifies matched, amount mismatch, missing on either side, and a second currency", async () => {
    const stamp = Date.now();
    const exactNo = `BDX-IN-${stamp}-A`;
    const offNo = `BDX-IN-${stamp}-B`;
    const unlistedNo = `BDX-IN-${stamp}-C`;
    const exact = await boundPolicy(exactNo, Date.now());
    const off = await boundPolicy(offNo, Date.now());
    const unlisted = await boundPolicy(unlistedNo, Date.now());
    const e1 = await accrueCommission(exact);
    const e2 = await accrueCommission(off);
    const e3 = await accrueCommission(unlisted);
    const providerId = (await policyRow(exact)).providerId;
    expect((await policyRow(off)).providerId).toBe(providerId);
    expect((await policyRow(unlisted)).providerId).toBe(providerId);

    const csv = [
      "policyNo,grossPremiumMinor,commissionMinor,currency,riskRef",
      `${exactNo},${e1.premiumMinor},${e1.grossCommissionMinor},,VIN-1`,
      `${offNo},${e2.premiumMinor + 500},${e2.grossCommissionMinor},AED,VIN-2`,
      `GHOST-${stamp},1000,100,AED,`,
      `${exactNo},2000,200,usd,`
    ].join("\n");
    const imported = ok(await importCsv(csv, providerId), 201);
    expect(imported.bordereau.direction).toBe("inbound");
    expect(imported.lines).toHaveLength(4);
    expect(imported.lines.map((l: any) => l.currency)).toEqual(["AED", "AED", "AED", "USD"]);
    expect(imported.lines[0].riskRef).toBe("VIN-1");
    expect(JSON.parse(imported.lines[1].rawJson)).toMatchObject({ policyNo: offNo, currency: "AED" });

    const entriesBefore = (await database.select().from(schema.distCommissionEntries)).length;
    const reconciled = ok(await call("POST", `/v1/axis/bordereaux/${imported.bordereau.id}/reconcile`, {}), 200);
    const group = (ref: string, currency = "AED") =>
      (reconciled.report.groups as any[]).find((g) => g.ref === ref && g.currency === currency);

    expect(group(exactNo)).toMatchObject({ state: "matched", varianceMinor: 0 });
    expect(group(exactNo).ours.records).toEqual([{ id: e1.id, resource: "commission-entries" }]);
    expect(group(offNo)).toMatchObject({ state: "variance", varianceMinor: 500 });
    expect(group(`GHOST-${stamp}`)).toMatchObject({ state: "missing_ours", varianceMinor: 1000, policyId: null });
    expect(group(unlistedNo)).toMatchObject({ state: "missing_theirs", varianceMinor: -e3.premiumMinor, policyId: unlisted });
    expect(group(exactNo, "USD")).toMatchObject({ state: "missing_ours", varianceMinor: 2000 });

    // Their lines carry the state of the group they fell in; the header says
    // the period did not reconcile clean. Nothing money-affecting was written.
    expect(reconciled.lines.map((l: any) => l.matchState)).toEqual(["matched", "variance", "missing_ours", "missing_ours"]);
    expect(reconciled.lines[0].policyId).toBe(exact);
    expect(reconciled.bordereau.state).toBe("variance");
    expect((await database.select().from(schema.distCommissionEntries)).length).toBe(entriesBefore);

    // The report reads back the same without a second write.
    const read = ok(await call("GET", `/v1/axis/bordereaux/${imported.bordereau.id}/reconciliation`), 200);
    expect(read.groups).toEqual(reconciled.report.groups);
    expect(read.totals.map((t: any) => t.currency)).toEqual(["AED", "USD"]);
  });

  it("a tolerance absorbs a rounding difference, is stored, and the report reads back under it", async () => {
    const no = `BDX-TOL-${Date.now()}`;
    const policyId = await boundPolicy(no, Date.now());
    const entry = await accrueCommission(policyId);
    const providerId = (await policyRow(policyId)).providerId;
    // `combined`, so this period's one-shot premium import above stays its own.
    const csv = `policyNo,grossPremiumMinor,commissionMinor,claimsPaidMinor,reserveMinor\n${no},${entry.premiumMinor + 2},${entry.grossCommissionMinor},0,0`;
    const imported = ok(await importCsv(csv, providerId, { kind: "combined" }), 201);

    const strict = ok(await call("POST", `/v1/axis/bordereaux/${imported.bordereau.id}/reconcile`, {}), 200);
    expect(strict.report.groups.find((g: any) => g.ref === no).state).toBe("variance");

    const loose = ok(await call("POST", `/v1/axis/bordereaux/${imported.bordereau.id}/reconcile`, { toleranceMinor: 2 }), 200);
    expect(loose.report.groups.find((g: any) => g.ref === no)).toMatchObject({ state: "matched", varianceMinor: 2 });
    expect(loose.bordereau.toleranceMinor).toBe(2);
    const read = ok(await call("GET", `/v1/axis/bordereaux/${imported.bordereau.id}/reconciliation`), 200);
    expect(read.toleranceMinor).toBe(2);
    expect(read.groups.find((g: any) => g.ref === no).state).toBe("matched");

    expect((await call("POST", `/v1/axis/bordereaux/${imported.bordereau.id}/reconcile`, { toleranceMinor: -1 })).status).toBe(400);
  });

  it("reads every row honestly: a file with a bad row stores nothing and names each bad line", async () => {
    const counterpartyId = `ext-honest-${Date.now()}`;
    const csv = [
      "policyNo,grossPremiumMinor,commissionMinor,currency",
      "P-1,1000,100,AED",
      ",1000,100,AED",
      "P-3,10.50,100,AED",
      "P-4,1000,100,dirhams",
      "P-5,1000"
    ].join("\n");
    const refused = await importCsv(csv, counterpartyId);
    expect(refused.status).toBe(422);
    expect(refused.body.rowErrors.map((e: any) => e.line)).toEqual([3, 4, 5, 6]);
    expect(refused.body.rowErrors.find((e: any) => e.line === 4).error).toMatch(/grossPremiumMinor/);
    expect(refused.body.rowErrors.find((e: any) => e.line === 5).error).toMatch(/currency/);

    // Nothing was stored, so the corrected file is not a duplicate period.
    const fixed = ok(await importCsv("policyNo,grossPremiumMinor,commissionMinor\nP-1,1000,100", counterpartyId), 201);
    expect(fixed.lines).toHaveLength(1);
    // And the period is one-shot once it is in.
    expect((await importCsv("policyNo,grossPremiumMinor,commissionMinor\nP-1,1000,100", counterpartyId)).status).toBe(409);
  });

  it("refuses a file missing a column its kind compares, and an empty file", async () => {
    const counterpartyId = `ext-cols-${Date.now()}`;
    const noCommission = await importCsv("policyNo,grossPremiumMinor\nP-1,1000", counterpartyId);
    expect(noCommission.status).toBe(422);
    expect(noCommission.body.rowErrors[0]).toMatchObject({ line: 1 });
    expect(noCommission.body.rowErrors[0].error).toMatch(/commissionMinor/);
    expect((await importCsv("policyNo,grossPremiumMinor,commissionMinor\n", counterpartyId)).status).toBe(422);
  });

  it("reconciles only what a provider sent us: an outbound bordereau, or another counterparty's, is refused", async () => {
    const policyId = await boundPolicy(`BDX-OUT-${Date.now()}`, Date.now());
    const providerId = (await policyRow(policyId)).providerId;
    const outbound = ok(
      await call("POST", "/v1/axis/bordereaux", { direction: "outbound", counterpartyKind: "provider", counterpartyId: providerId, kind: "claims", period: currentPeriod() }),
      201
    );
    expect((await call("POST", `/v1/axis/bordereaux/${outbound.bordereau.id}/reconcile`, {})).status).toBe(409);
    expect((await call("GET", `/v1/axis/bordereaux/${outbound.bordereau.id}/reconciliation`)).status).toBe(409);

    const partner = ok(await importCsv("policyNo,grossPremiumMinor,commissionMinor\nP-1,1,1", `ext-ptn-${Date.now()}`, { counterpartyKind: "partner" }), 201);
    expect((await call("POST", `/v1/axis/bordereaux/${partner.bordereau.id}/reconcile`, {})).status).toBe(409);
  });

  it("takes the file as a multipart upload, the header as its form fields", async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries({ counterpartyKind: "provider", counterpartyId: `ext-upload-${Date.now()}`, kind: "premium", period: currentPeriod(), currency: "USD" })) form.set(k, v);
    form.set("file", new File(["policyNo,grossPremiumMinor,commissionMinor\nP-9,700,70\n"], "bdx.csv", { type: "text/csv" }));
    const res = await app.fetch(
      new Request("http://api.test/v1/axis/bordereaux/import", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }),
      env as never,
      exec as never
    );
    expect(res.status).toBe(201);
    const out = (await res.json()) as any;
    expect(out.bordereau.currency).toBe("USD");
    expect(out.lines.map((l: any) => [l.externalRef, l.grossPremiumMinor, l.currency])).toEqual([["P-9", 700, "USD"]]);
  });

  it("the report is gated on reading bordereaux", async () => {
    const imported = ok(await importCsv("policyNo,grossPremiumMinor,commissionMinor\nP-1,1,1", `ext-perm-${Date.now()}`), 201);
    const res = await call("GET", `/v1/axis/bordereaux/${imported.bordereau.id}/reconciliation`, undefined, {}, () => controllerToken);
    expect(res.status).toBe(403);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EntitlementsJson, id as newId, schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/30 Compliance 4 (docs/19 §4): a screening hit blocks. The block was a
// column nothing read, so a customer with a standing sanctions hit bound, renewed,
// was reinstated and was sold to like anyone else. Every such door now asks
// `assertNotScreenedOut` first, and a blocked customer gets a 409 before any
// approval is raised for a bind that must not happen.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  // Two controllers: dist:commissions:adjust is dual-control above the
  // threshold, so an accrual needs one to ask and the other to decide.
  "finance.controller": "faisal.omar",
  "finance.approver": "nadia.rahman",
  "axis.lead": "omar.farouk",
  "tenant.compliance": "khalid.rashed"
};

let env: Env;
let database: Db;
let seeded: SeedResult;
let tokens: Record<string, string>;

const exec = { waitUntil() {}, passThroughOnException() {} };

async function call<T = any>(
  who: string | null,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const token = who ? tokens[who] : undefined;
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const text = res.headers.get("content-type")?.includes("json") ? await res.text() : "";
  return { status: res.status, body: text ? (JSON.parse(text) as T) : (null as T) };
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

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173"
  } as unknown as Env;

  tokens = {};
  for (const [role, local] of Object.entries(PEOPLE)) {
    const login = await call(null, "POST", "/v1/auth/login", {
      email: `${local}@gonxt.ae`,
      password: PASSWORD,
      tenantSlug: "gonxt"
    });
    expect(login.status).toBe(200);
    const token = login.body.token as string;
    const verified = await call(
      null,
      "POST",
      "/v1/auth/mfa/verify",
      { code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) },
      { authorization: `Bearer ${token}` }
    );
    expect(verified.status).toBe(200);
    tokens[role] = token;
  }
}, 120_000);

const block = async (customerId: string, id: string) => {
  await database.insert(schema.screenings).values({
    id,
    tenantId: seeded.tenantId,
    subjectRef: `customer:${customerId}`,
    kind: "sanctions",
    provider: "stub",
    queryHash: `h_${id}`,
    result: "hit",
    blocked: true,
    ts: Date.now()
  });
};

const refusedForScreening = (res: { status: number; body: any }, id: string) => {
  expect(res.status).toBe(409);
  expect(res.body.detail).toContain(id);
};

describe("a standing screening hit blocks every door that binds or sells", () => {
  let policy: typeof schema.axisPolicies.$inferSelect;

  beforeAll(async () => {
    policy = (await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118")))[0]!;
    await block(policy.customerId, "scr_block_doors");
  });

  it("refuses a new policy for the customer, before any approval is raised", async () => {
    const res = await call("axis.lead", "POST", "/v1/axis/policies", {
      policyNo: "SCR-BLOCK-1",
      customerId: policy.customerId,
      productId: policy.productId,
      providerId: policy.providerId,
      premiumMinor: 1000,
      currency: policy.currency,
      startAt: Date.now(),
      endAt: Date.now() + 86_400_000
    });
    refusedForScreening(res, "scr_block_doors");
    const raised = await database.select().from(schema.approvals).where(eq(schema.approvals.policyKey, "axis.bind"));
    expect(raised.filter((a) => a.contextJson?.includes("SCR-BLOCK-1"))).toHaveLength(0);
  });

  it("refuses to bind a chosen quote for the customer", async () => {
    const now = Date.now();
    const requestId = newId("qr", now);
    await database.insert(schema.distQuoteRequests).values({
      id: requestId, tenantId: seeded.tenantId, customerId: policy.customerId, channelId: policy.channelId!,
      productId: policy.productId ?? "prd_screening", inputsJson: "{}", currency: policy.currency, state: "converted", createdAt: now, updatedAt: now
    });
    const responseId = newId("qresp", now);
    await database.insert(schema.distQuoteResponses).values({
      id: responseId, tenantId: seeded.tenantId, requestId, offeringId: policy.offeringId!, providerId: policy.providerId,
      state: "quoted", premiumMinor: 1000, currency: policy.currency, selectedAt: now, createdAt: now, updatedAt: now
    });
    const bind = await call("axis.lead", "POST", `/v1/axis/quote-responses/${responseId}/bind`, {
      policyNo: "SCR-BLOCK-2", startAt: now, endAt: now + 86_400_000
    });
    refusedForScreening(bind, "scr_block_doors");

    // …and, on a tenant without AXIS, to book it as a sale (ADR-0094).
    await database.update(schema.tenants)
      .set({ entitlementsJson: JSON.stringify(EntitlementsJson.parse({ edition: "suite", modules: ["signal"], seats: 250 })) })
      .where(eq(schema.tenants.id, seeded.tenantId));
    try {
      refusedForScreening(await call("finance.controller", "POST", `/v1/dist/quote-responses/${responseId}/sale`, {}), "scr_block_doors");
    } finally {
      await database.update(schema.tenants)
        .set({ entitlementsJson: JSON.stringify(EntitlementsJson.parse({ edition: "suite", modules: ["axis", "orbit", "signal", "scout", "north"], seats: 250 })) })
        .where(eq(schema.tenants.id, seeded.tenantId));
    }
  });

  it("refuses to renew or reinstate the customer's policy", async () => {
    refusedForScreening(await call("axis.lead", "POST", `/v1/axis/policies/${policy.id}/renew`, {}), "scr_block_doors");
    refusedForScreening(await call("axis.lead", "POST", `/v1/axis/policies/${policy.id}/reinstate`, {}), "scr_block_doors");
  });
});

describe("POST /v1/compliance/screenings/:id/disposition", () => {
  let customerId: string;

  beforeAll(async () => {
    customerId = (await database.select().from(schema.customers).limit(1))[0]!.id;
    await block(customerId, "scr_dispose");
  });

  it("is compliance's to decide, not the underwriter's", async () => {
    const res = await call("axis.lead", "POST", "/v1/compliance/screenings/scr_dispose/disposition", { disposition: "false_positive", note: "Different birth date." });
    expect(res.status).toBe(403);
  });

  it("keeps the block on a confirmed or escalated hit", async () => {
    const res = await call("tenant.compliance", "POST", "/v1/compliance/screenings/scr_dispose/disposition", { disposition: "escalated", note: "Asking the MLRO." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disposition: "escalated", blocked: true });
  });

  it("clears it on a false positive, audited under the officer's name, and says so on the bus", async () => {
    const res = await call("tenant.compliance", "POST", "/v1/compliance/screenings/scr_dispose/disposition", { disposition: "false_positive", note: "Different birth date and nationality." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ disposition: "false_positive", blocked: false });
    expect(res.body.dispositionedBy).toMatch(/^user:/);
    const audits = await database.select().from(schema.auditLog).where(eq(schema.auditLog.subjectRef, "scr_dispose"));
    expect(audits.map((a) => a.action)).toContain("compliance.screening.disposition");
    const cleared = (await database.select().from(schema.eventOutbox)).filter((e) => e.type === "compliance.screening.cleared" && e.envelopeJson.includes("scr_dispose"));
    expect(cleared).toHaveLength(1);
  });

  it("wants a reason, and refuses a disposition on something that never hit", async () => {
    expect((await call("tenant.compliance", "POST", "/v1/compliance/screenings/scr_dispose/disposition", { disposition: "false_positive" })).status).toBe(400);
    await database.insert(schema.screenings).values({
      id: "scr_clear_row", tenantId: seeded.tenantId, subjectRef: `customer:${customerId}`, kind: "pep", provider: "stub", queryHash: "hc", result: "clear", blocked: false, ts: Date.now()
    });
    expect((await call("tenant.compliance", "POST", "/v1/compliance/screenings/scr_clear_row/disposition", { disposition: "false_positive", note: "n/a here" })).status).toBe(409);
  });
});

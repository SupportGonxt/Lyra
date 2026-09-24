import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { id as newId, schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Regression suite for the distribution router. One describe per defect the
// distribution UI reported against these endpoints; each test is named after
// the defect it reproduces (CLAUDE.md — bugs reproduce before they die).

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  // Two controllers: dist:commissions:adjust is dual-control above the
  // threshold, so an accrual needs one to ask and the other to decide.
  "finance.controller": "faisal.omar",
  "finance.approver": "nadia.rahman",
  "axis.lead": "omar.farouk",
  // Rate cards are the administrator's (rbac.ts tenant.admin `dist:rates:write`).
  "tenant.admin": "amina.saleh"
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

/** Initiator is refused with an approval id, a second person clears it, retry. */
async function throughApproval<T = any>(
  initiator: string,
  approver: string,
  method: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  const first = await call(initiator, method, path, payload, headers);
  expect(first.status).toBe(403);
  const approvalId = (first.body as any).approval_id as string;
  expect(approvalId).toBeTruthy();
  const decided = await call(approver, "POST", `/v1/me/approvals/${approvalId}/decide`, {
    decision: "approved"
  });
  expect(decided.status).toBe(200);
  return call<T>(initiator, method, path, payload, headers);
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

/* ------------------------------------------------------- 1. accrue is gated */

describe("defect 1: POST /commission-entries/accrue writes a financial position with no approval gate", () => {
  let policyId: string;

  beforeAll(async () => {
    // The renewal-window policy — seeded without a commission entry, so it is
    // the one accrual that can still be posted.
    const rows = await database
      .select()
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118"));
    policyId = rows[0]!.id;
  });

  it("refuses the first attempt with approval_required and writes nothing", async () => {
    const res = await call("finance.controller", "POST", "/v1/dist/commission-entries/accrue", {
      policyId,
      kind: "new_business"
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("dist.commission_accrue");
    expect(res.body.approval_id).toBeTruthy();

    const written = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.policyId, policyId));
    expect(written).toHaveLength(0);
  });

  it("posts the accrual once the second pair of eyes clears it", async () => {
    const res = await throughApproval(
      "finance.controller",
      "finance.approver",
      "POST",
      "/v1/dist/commission-entries/accrue",
      { policyId, kind: "new_business" },
      { "idempotency-key": `accrue-${policyId}` }
    );
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("accrued");
    expect(res.body.policyId).toBe(policyId);
  });
});

/* ------------------------------------------------- 2. propose is AI-audited */

describe("defect 2: POST /next-best-offers/propose writes no ai_audit_log row", () => {
  it("returns an aiAuditId that resolves to an ai_audit_log row", async () => {
    const customer = (await database.select().from(schema.customers).limit(1))[0]!;
    const res = await call("axis.lead", "POST", "/v1/dist/next-best-offers/propose", {
      customerId: customer.id
    });
    expect(res.status).toBe(200);
    expect(typeof res.body.aiAuditId).toBe("string");

    const rows = await database
      .select()
      .from(schema.aiAuditLog)
      .where(eq(schema.aiAuditLog.id, res.body.aiAuditId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.module).toBe("dist");
    expect(rows[0]!.subjectRef).toBe(customer.id);
    expect(rows[0]!.outcome).toBe("ok");
  });
});

/* --------------------------------------------- 3. surface is a real transition */

describe("defect 3: POST /next-best-offers/:id/surface succeeds while doing nothing", () => {
  async function offer(state: string): Promise<string> {
    const offerId = newId("nbo", Date.now());
    await database.insert(schema.distNextBestOffers).values({
      id: offerId,
      tenantId: seeded.tenantId,
      customerId: "cus_surface_test",
      kind: "cross_sell",
      offeringId: "off_surface_test",
      score: 50,
      reasonKey: "nbo.reason.complements_cover",
      state,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    return offerId;
  }

  it("409s naming the actual state instead of 204-ing a no-op", async () => {
    const offerId = await offer("dismissed");
    const res = await call("axis.lead", "POST", `/v1/dist/next-best-offers/${offerId}/surface`);
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain("dismissed");
  });

  it("404s for an offer that does not exist", async () => {
    const res = await call("axis.lead", "POST", "/v1/dist/next-best-offers/nbo_missing/surface");
    expect(res.status).toBe(404);
  });

  it("audits the transition it actually made", async () => {
    const offerId = await offer("proposed");
    const res = await call("axis.lead", "POST", `/v1/dist/next-best-offers/${offerId}/surface`);
    expect(res.status).toBe(204);

    const rows = await database
      .select()
      .from(schema.distNextBestOffers)
      .where(eq(schema.distNextBestOffers.id, offerId));
    expect(rows[0]!.state).toBe("surfaced");

    const audited = await database
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, "dist.nbo.surface"), eq(schema.auditLog.subjectRef, offerId))
      );
    expect(audited).toHaveLength(1);
  });
});

/* --------------------------------- 4 + 6. statement range, limit, currencies */

describe("defects 4 and 6: the statement ignores from/to/limit and sums across currencies", () => {
  const providerId = "prv_statement_test";
  const channelId = "chn_statement_test";

  beforeAll(async () => {
    const rows = [
      { at: 1_000, currency: "AED", premium: 100_00, gross: 10_00, channel: 4_00, net: 6_00, tax: 0 },
      { at: 2_000, currency: "AED", premium: 200_00, gross: 20_00, channel: 8_00, net: 12_00, tax: 0 },
      { at: 3_000, currency: "USD", premium: 50_00, gross: 5_00, channel: 2_00, net: 3_00, tax: 0 }
    ];
    for (const r of rows) {
      await database.insert(schema.distCommissionEntries).values({
        id: newId("ce", r.at),
        tenantId: seeded.tenantId,
        // One policy per entry: dist_commission_entries_accrual_uq allows a
        // single accrual per (policy, kind).
        policyId: `pol_statement_test_${r.at}`,
        providerId,
        channelId,
        kind: "new_business",
        premiumMinor: r.premium,
        grossCommissionMinor: r.gross,
        channelCommissionMinor: r.channel,
        netCommissionMinor: r.net,
        taxMinor: r.tax,
        currency: r.currency,
        state: "accrued",
        createdAt: r.at,
        updatedAt: r.at
      });
    }
  });

  it("totals per currency rather than adding AED to USD", async () => {
    const res = await call("finance.controller", "GET", `/v1/dist/commission-entries/statement?providerId=${providerId}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);

    const byCurrency = Object.fromEntries(res.body.totals.map((t: any) => [t.currency, t]));
    expect(Object.keys(byCurrency).sort()).toEqual(["AED", "USD"]);
    expect(byCurrency.AED).toMatchObject({
      count: 2,
      premiumMinor: 300_00,
      receivableMinor: 30_00,
      payableMinor: 12_00,
      netMinor: 18_00,
      taxMinor: 0
    });
    expect(byCurrency.USD).toMatchObject({ count: 1, premiumMinor: 50_00, netMinor: 3_00 });
  });

  it("honours from/to on the range it orders by", async () => {
    const from = await call("finance.controller", "GET", `/v1/dist/commission-entries/statement?providerId=${providerId}&from=2000`);
    expect(from.body.count).toBe(2);
    expect(from.body.entries.every((e: any) => e.createdAt >= 2_000)).toBe(true);

    const to = await call("finance.controller", "GET", `/v1/dist/commission-entries/statement?providerId=${providerId}&to=2000`);
    expect(to.body.count).toBe(2);
    expect(to.body.entries.every((e: any) => e.createdAt <= 2_000)).toBe(true);
  });

  it("totals the whole matching set even when the page is smaller", async () => {
    const res = await call("finance.controller", "GET", `/v1/dist/commission-entries/statement?providerId=${providerId}&limit=1`);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.count).toBe(3);
    const aed = res.body.totals.find((t: any) => t.currency === "AED");
    expect(aed.premiumMinor).toBe(300_00);
  });
});

/* ------------------------------------------------ 5. no reversing one twice */

/* ------------------------------------- 7. accrue races past its pre-check */

describe("defect 7: accrue is check-then-insert, so concurrent submits double-accrue", () => {
  let policyId: string;

  beforeAll(async () => {
    // A fresh policy cloned from a seeded one, so quoteCommission finds a rate.
    const [seededPolicy] = await database
      .select()
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118"));
    policyId = newId("pol", Date.now());
    await database.insert(schema.axisPolicies).values({
      ...seededPolicy!,
      id: policyId,
      policyNo: `RACE-${Date.now()}`
    });

    // Take the dual-control signature up front: the approval lives 24h against
    // (subject, policy), so both racers below pass the gate — the exact window
    // the pre-check does not cover.
    const first = await call("finance.controller", "POST", "/v1/dist/commission-entries/accrue", {
      policyId,
      kind: "new_business"
    });
    expect(first.status).toBe(403);
    const decided = await call("finance.approver", "POST", `/v1/me/approvals/${first.body.approval_id}/decide`, {
      decision: "approved"
    });
    expect(decided.status).toBe(200);
  });

  it("posts exactly one accrual when submits race, and answers 409, not 500", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call("finance.controller", "POST", "/v1/dist/commission-entries/accrue", { policyId, kind: "new_business" })
      )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);

    const rows = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.policyId, policyId));
    expect(rows).toHaveLength(1);
  });
});

/* --------------------------------------- 8. taxMinor above net goes negative */

describe("defect 8: accrue stores a negative net commission when taxMinor exceeds net", () => {
  it("400s naming taxMinor instead of silently accruing a negative position", async () => {
    const [seededPolicy] = await database
      .select()
      .from(schema.axisPolicies)
      .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2501-664118"));
    const policyId = newId("pol", Date.now());
    await database.insert(schema.axisPolicies).values({
      ...seededPolicy!,
      id: policyId,
      policyNo: `TAX-${Date.now()}`
    });

    const res = await call("finance.controller", "POST", "/v1/dist/commission-entries/accrue", {
      policyId,
      kind: "new_business",
      taxMinor: 999_999_999
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toContain("taxMinor");

    const rows = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.policyId, policyId));
    expect(rows).toHaveLength(0);
  });
});

/* --------------------------------------------- 9. clawback is not idempotent */

describe("defect 9: clawback has no idempotency wrapper, so a retried submit reverses twice", () => {
  let entryId: string;
  const KEY = "clawback-replay-1";
  const REASON = "duplicate submit from a retrying client";

  beforeAll(async () => {
    entryId = newId("ce", Date.now());
    await database.insert(schema.distCommissionEntries).values({
      id: entryId,
      tenantId: seeded.tenantId,
      policyId: `pol_clawback_idem_${Date.now()}`,
      providerId: "prv_idem_test",
      channelId: "chn_idem_test",
      kind: "new_business",
      premiumMinor: 100_00,
      grossCommissionMinor: 10_00,
      channelCommissionMinor: 4_00,
      netCommissionMinor: 6_00,
      taxMinor: 0,
      currency: "AED",
      state: "accrued",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  });

  it("replays the stored 201 for the same idempotency key and writes one reversal", async () => {
    const first = await throughApproval(
      "finance.controller",
      "finance.approver",
      "POST",
      `/v1/dist/commission-entries/${entryId}/clawback`,
      { reason: REASON },
      { "idempotency-key": KEY }
    );
    expect(first.status).toBe(201);

    const replay = await call(
      "finance.controller",
      "POST",
      `/v1/dist/commission-entries/${entryId}/clawback`,
      { reason: REASON },
      { "idempotency-key": KEY }
    );
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);

    const reversals = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.reversalOf, entryId));
    expect(reversals).toHaveLength(1);
  });
});

describe("defect 5: clawback reverses the same accrual twice", () => {
  let entryId: string;

  beforeAll(async () => {
    // The seeded sale's accrual — a real entry with a real policy behind it.
    const policy = (
      await database
        .select()
        .from(schema.axisPolicies)
        .where(eq(schema.axisPolicies.policyNo, "CDR-MOT-2601-778201"))
    )[0]!;
    const rows = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(
        and(
          eq(schema.distCommissionEntries.policyId, policy.id),
          eq(schema.distCommissionEntries.state, "accrued")
        )
      );
    entryId = rows[0]!.id;
  });

  it("refuses a second reversal of an entry already clawed back", async () => {
    const first = await throughApproval(
      "finance.controller",
      "finance.approver",
      "POST",
      `/v1/dist/commission-entries/${entryId}/clawback`,
      { reason: "underwriter cancelled the policy" }
    );
    expect(first.status).toBe(201);

    const second = await call("finance.controller", "POST", `/v1/dist/commission-entries/${entryId}/clawback`, {
      reason: "underwriter cancelled the policy"
    });
    expect(second.status).toBe(409);
    expect(second.body.detail).toContain("clawed back");

    // Exactly one reversal exists for that entry — the double credit never happened.
    const reversals = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.reversalOf, entryId));
    expect(reversals).toHaveLength(1);
  });
});

/* --------------------------- P2: clawback computes the unearned share --- */

describe("clawback prorates against the policy's remaining term (docs/27 P2)", () => {
  const DAY = 86_400_000;
  let entryId: string;
  let policyId: string;

  beforeAll(async () => {
    const now = Date.now();
    // A year term, cancelled at the exact midpoint: half is earned, half is
    // clawable — neither the full amount nor zero, which is what a blind full
    // reversal or a since-fixed no-op would each get wrong.
    policyId = newId("pol", now);
    await database.insert(schema.axisPolicies).values({
      id: policyId,
      tenantId: seeded.tenantId,
      customerId: "cus_clawback_prorate_test",
      providerId: "prv_clawback_prorate_test",
      policyNo: `POL-CLAWBACK-PRORATE-${now}`,
      startAt: now - 182 * DAY,
      endAt: now + 183 * DAY,
      premiumMinor: 1_000_00,
      currency: "AED",
      commissionMinor: 100_00,
      status: "active",
      versionSeq: 1,
      createdAt: now,
      updatedAt: now
    });
    entryId = newId("ce", now);
    await database.insert(schema.distCommissionEntries).values({
      id: entryId,
      tenantId: seeded.tenantId,
      policyId,
      providerId: "prv_clawback_prorate_test",
      channelId: "chn_clawback_prorate_test",
      kind: "new_business",
      premiumMinor: 1_000_00,
      grossCommissionMinor: 100_00,
      channelCommissionMinor: 40_00,
      netCommissionMinor: 60_00,
      taxMinor: 0,
      currency: "AED",
      state: "accrued",
      createdAt: now,
      updatedAt: now
    });
  });

  it("claws back roughly the unearned half, not the full accrual", async () => {
    const res = await throughApproval(
      "finance.controller",
      "finance.approver",
      "POST",
      `/v1/dist/commission-entries/${entryId}/clawback`,
      { reason: "policy cancelled at the midpoint of its term" }
    );
    expect(res.status).toBe(201);

    const [reversal] = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.reversalOf, entryId));
    expect(reversal).toBeDefined();
    // Full reversal would be exactly -10,000; a computed no-op would be 0.
    // Roughly half, allowing for day-rounding either side of the midpoint.
    expect(reversal!.grossCommissionMinor).toBeLessThan(0);
    expect(reversal!.grossCommissionMinor).toBeGreaterThan(-100_00);
    expect(Math.abs(reversal!.grossCommissionMinor + 50_00)).toBeLessThan(1_00);
  });

  it("falls back to a full reversal when the entry's policyId names no real policy", async () => {
    const now = Date.now();
    const orphanEntryId = newId("ce", now + 1);
    await database.insert(schema.distCommissionEntries).values({
      id: orphanEntryId,
      tenantId: seeded.tenantId,
      policyId: `pol_no_such_policy_${now}`,
      providerId: "prv_clawback_fallback_test",
      channelId: "chn_clawback_fallback_test",
      kind: "new_business",
      premiumMinor: 500_00,
      grossCommissionMinor: 50_00,
      channelCommissionMinor: 20_00,
      netCommissionMinor: 30_00,
      taxMinor: 0,
      currency: "AED",
      state: "accrued",
      createdAt: now,
      updatedAt: now
    });

    const res = await throughApproval(
      "finance.controller",
      "finance.approver",
      "POST",
      `/v1/dist/commission-entries/${orphanEntryId}/clawback`,
      { reason: "no term to prorate against" }
    );
    expect(res.status).toBe(201);

    const [reversal] = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.reversalOf, orphanEntryId));
    expect(reversal!.grossCommissionMinor).toBe(-50_00);
  });
});

describe("the retired generic CRUD door onto commission-entries is gone", () => {
  let entryId: string;

  beforeAll(async () => {
    entryId = newId("ce", Date.now());
    await database.insert(schema.distCommissionEntries).values({
      id: entryId,
      tenantId: seeded.tenantId,
      policyId: `pol_generic_crud_door_${Date.now()}`,
      providerId: "prv_generic_crud_door",
      channelId: "chn_generic_crud_door",
      kind: "new_business",
      premiumMinor: 100_00,
      grossCommissionMinor: 10_00,
      channelCommissionMinor: 4_00,
      netCommissionMinor: 6_00,
      taxMinor: 0,
      currency: "AED",
      state: "paid",
      channelSettlementId: "stl_already_settled",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  });

  it("cannot unstick a paid entry back onto a settlement by PATCHing state/channelSettlementId directly", async () => {
    // Only /commission-entries/:id/clawback may move money here. A generic
    // PATCH resetting state or channelSettlementId would let this entry sweep
    // into a second settlement run and get paid twice.
    const res = await call("finance.controller", "PATCH", `/v1/dist/commission-entries/${entryId}`, {
      state: "accrued",
      channelSettlementId: null
    });
    expect(res.status).toBe(404);

    const [row] = await database
      .select()
      .from(schema.distCommissionEntries)
      .where(eq(schema.distCommissionEntries.id, entryId));
    expect(row?.state).toBe("paid");
    expect(row?.channelSettlementId).toBe("stl_already_settled");
  });

  it("still reads through the generic resource", async () => {
    const res = await call("finance.controller", "GET", "/v1/dist/commission-entries");
    expect(res.status).toBe(200);
  });
});

/* -------------------------------- F56: select carries an idempotency key */

describe("F56: POST /quote-requests/:id/select is idempotent and single-shot", () => {
  let requestId: string;
  let responseId: string;
  const KEY = "select-replay-1";

  beforeAll(async () => {
    requestId = newId("qrq", Date.now());
    responseId = newId("qrs", Date.now());
    const now = Date.now();
    await database.insert(schema.distQuoteRequests).values({
      id: requestId,
      tenantId: seeded.tenantId,
      channelId: "chn_select_test",
      productId: "prd_select_test",
      inputsJson: "{}",
      currency: "AED",
      state: "open",
      createdAt: now,
      updatedAt: now
    });
    await database.insert(schema.distQuoteResponses).values({
      id: responseId,
      tenantId: seeded.tenantId,
      requestId,
      offeringId: "off_select_test",
      providerId: "prv_select_test",
      state: "quoted",
      premiumMinor: 120_000_00,
      currency: "AED",
      createdAt: now,
      updatedAt: now
    });
  });

  it("replays the stored result for the same idempotency key and selects once", async () => {
    const first = await call("axis.lead", "POST", `/v1/dist/quote-requests/${requestId}/select`, { responseId }, { "idempotency-key": KEY });
    expect(first.status).toBe(200);

    const replay = await call("axis.lead", "POST", `/v1/dist/quote-requests/${requestId}/select`, { responseId }, { "idempotency-key": KEY });
    expect(replay.status).toBe(200);

    const [row] = await database
      .select()
      .from(schema.distQuoteResponses)
      .where(eq(schema.distQuoteResponses.id, responseId));
    expect(row?.selectedAt).not.toBeNull();
  });

  it("refuses a second selection once the comparison is converted", async () => {
    const res = await call("axis.lead", "POST", `/v1/dist/quote-requests/${requestId}/select`, { responseId }, { "idempotency-key": "select-second" });
    expect(res.status).toBe(409);
  });
});

/* -------------------------------- F56: decide refuses an already-decided offer */

describe("F56: POST /next-best-offers/:id/decide refuses a decided offer", () => {
  let offerId: string;

  beforeAll(async () => {
    offerId = newId("nbo", Date.now());
    const customer = (await database.select().from(schema.customers).limit(1))[0]!;
    await database.insert(schema.distNextBestOffers).values({
      id: offerId,
      tenantId: seeded.tenantId,
      customerId: customer.id,
      kind: "cross_sell",
      offeringId: "off_decide_test",
      score: 80,
      reasonKey: "nbo.cross_sell",
      state: "proposed",
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  });

  it("decides once, then refuses a replay instead of re-emitting", async () => {
    const first = await call("axis.lead", "POST", `/v1/dist/next-best-offers/${offerId}/decide`, { decision: "accepted" });
    expect(first.status).toBe(204);

    const replay = await call("axis.lead", "POST", `/v1/dist/next-best-offers/${offerId}/decide`, { decision: "dismissed" });
    expect(replay.status).toBe(409);

    const [row] = await database.select().from(schema.distNextBestOffers).where(eq(schema.distNextBestOffers.id, offerId));
    expect(row?.state).toBe("accepted");
  });
});

// ADR-0084: `structureJson` (tiers, volume bonus, override) is parsed by
// `commissionStructureOf`, which reads anything it cannot parse as "flat". Once
// the rates form offers the field, a typo would pass for a ladder and pay the
// flat rate — so a structure is validated where it is written.
describe("commission-rate structures are validated on write", () => {
  const rate = (structureJson: unknown) => ({
    channelId: "chn_rate_structure_test",
    channelSharePpm: 100_000,
    effectiveFrom: Date.UTC(2026, 9, 1),
    structureJson
  });

  it("refuses a structure that is not the ADR-0084 shape", async () => {
    for (const bad of [{ tiers: [{ ratePpm: "ten" }] }, { tiers: [{ uptoMinor: 100, ratePpm: 1 }] }, "not json", { unknown: 1 }]) {
      const res = await call("tenant.admin", "POST", "/v1/dist/commission-rates", rate(bad));
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("lets a well-formed ladder through to the rate-change approval", async () => {
    const res = await call(
      "tenant.admin",
      "POST",
      "/v1/dist/commission-rates",
      rate({ tiers: [{ uptoMinor: 1_000_000, ratePpm: 100_000 }, { ratePpm: 150_000 }], overridePpm: 10_000 })
    );
    expect([201, 403]).toContain(res.status);
    if (res.status === 403) expect(res.body.code).toBe("approval_required");
  });
});

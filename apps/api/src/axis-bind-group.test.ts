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

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const DAY = 86_400_000;
const exec = { waitUntil() {}, passThroughOnException() {} };

let env: Env;
let database: Db;
let seeded: SeedResult;
let token: string;
let customerId: string;

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

async function insertDraftPolicy(policyNo: string) {
  const start = Date.now();
  // The product is load-bearing since ADR-0125: the licence register is asked
  // whether an authorisation covers this policy's market **and product line**, so
  // a draft with no product cannot be assessed and is refused — correctly, since a
  // placement nobody can tie to a licence is the thing the register exists to
  // stop. The fixture had none; a real bindable policy always does.
  const [motor] = await database.select().from(schema.products).where(eq(schema.products.line, "motor"));
  const row = {
    id: `pol_${policyNo.toLowerCase()}`,
    tenantId: seeded.tenantId,
    customerId,
    productId: motor!.id,
    providerId: seeded.providers.falcon as string,
    policyNo,
    startAt: start,
    endAt: start + 365 * DAY,
    premiumMinor: 500_000_00,
    currency: "AED",
    commissionMinor: 50_000_00,
    grossMinor: 500_000_00,
    status: "draft" as const,
    createdAt: start,
    updatedAt: start
  };
  await database.insert(schema.axisPolicies).values(row);
  return row;
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

  const customer = (await database.select().from(schema.customers).limit(1))[0]!;
  customerId = customer.id;
}, 120_000);

describe("AXIS bind-group (docs/superpowers/specs/2026-08-16-revenue-lines-full-build-design.md, Group A)", () => {
  it("refuses BIND-GROUP without axis.bind_group on the tenant's autoApprove allowlist", async () => {
    const policy = await insertDraftPolicy("POL-GROUP-REFUSED");
    const res = await call("POST", `/v1/axis/policies/${policy.id}/bind-group`, {});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");

    const pending = await database
      .select()
      .from(schema.approvals)
      .where(and(eq(schema.approvals.tenantId, seeded.tenantId), eq(schema.approvals.subjectRef, `axis_policy:${policy.id}`)));
    expect(pending.some((a) => a.policyKey === "axis.bind_group")).toBe(true);
  });

  it("binds a group policy with a commission accrual once axis.bind_group is auto-approved", async () => {
    const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
    const policy0 = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
    await database
      .update(schema.tenants)
      .set({ policyJson: JSON.stringify({ ...policy0, autoApprove: [...policy0.autoApprove, "axis.bind_group"] }) })
      .where(eq(schema.tenants.id, seeded.tenantId));

    const policy = await insertDraftPolicy("POL-GROUP-1");
    const out = ok(await call("POST", `/v1/axis/policies/${policy.id}/bind-group`, { channelMinor: 10_000_00 }), 201);

    expect(out.policy.status).toBe("bound");
    expect(out.policy.versionSeq).toBe(1);
    expect(out.policy.currentVersionId).toBe(out.version.id);
    expect(out.txn.state).toBe("settled");

    const legs = await database
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.batchId, out.txn.ledgerBatchId as string));
    const debit = legs.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
    const credit = legs.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);
    expect(debit).toBe(credit);
    expect(legs.some((l) => l.accountCode === "2100" && l.amountMinor === 10_000_00)).toBe(true);

    const audits = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.action, "axis.policy.bind_group")));
    expect(audits.some((a) => a.subjectRef === out.policy.id)).toBe(true);

    const events = await database.select().from(schema.eventOutbox).where(eq(schema.eventOutbox.type, "axis.policy.issued"));
    expect(events.some((e) => e.envelopeJson.includes(out.policy.id))).toBe(true);
  });

  it("posts a broker fee with no approval gate", async () => {
    const policy = await insertDraftPolicy("POL-GROUP-FEE");
    const out = ok(await call("POST", `/v1/axis/policies/${policy.id}/broker-fee`, { feeMinor: 5_000_00 }), 201);

    expect(out.txn.state).toBe("settled");
    const legs = await database
      .select()
      .from(schema.ledgerJournalLines)
      .where(eq(schema.ledgerJournalLines.batchId, out.txn.ledgerBatchId as string));
    const debit = legs.filter((l) => l.side === "debit").reduce((n, l) => n + l.amountMinor, 0);
    const credit = legs.filter((l) => l.side === "credit").reduce((n, l) => n + l.amountMinor, 0);
    expect(debit).toBe(credit);
    expect(legs.some((l) => l.accountCode === "4020")).toBe(true);
    expect(legs.some((l) => l.accountCode === "1160")).toBe(true);
  });
});

/* ------------------------------- the licence door, on the group path too */

/**
 * `bindGroup` goes straight to its own accrual and never enters `bindPolicy`, so
 * the authorisation check added for individual placements (ADR-0125) did not
 * reach it: a broker could write group medical in a market it holds no licence in
 * while the individual path refused the same market. **The register is only a
 * control where every door asks it**, so the group door now asks.
 *
 * The check runs *before* the approval gate, so this needs no autoApprove change
 * and the refusal is about the licence rather than about the approval.
 */
describe("AXIS bind-group asks the licence register", () => {
  it("refuses a group placement in a market the tenant holds no authorisation for", async () => {
    const tenantRow = (await database.select().from(schema.tenants).where(eq(schema.tenants.id, seeded.tenantId)))[0]!;
    const policy0 = JSON.parse(tenantRow.policyJson as string) as { autoApprove: string[] };
    // Qatar: no rulepack and no authorisation on file, which is exactly the state
    // six of the client's nine markets are in.
    await database
      .update(schema.tenants)
      .set({
        policyJson: JSON.stringify({
          ...policy0,
          taxMarket: "QA",
          autoApprove: [...policy0.autoApprove, "axis.bind_group"]
        })
      })
      .where(eq(schema.tenants.id, seeded.tenantId));

    const policy = await insertDraftPolicy("POL-GROUP-UNLICENSED");
    const res = await call("POST", `/v1/axis/policies/${policy.id}/bind-group`, { channelMinor: 10_000_00 });

    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toContain("QA");
    // And nothing was written: the refusal is the control, not the message.
    const [after] = await database.select().from(schema.axisPolicies).where(eq(schema.axisPolicies.id, policy.id));
    expect(after!.status).toBe("draft");
  });
});

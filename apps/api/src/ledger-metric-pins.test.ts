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

// D11 (docs/specs/gap-finance-design.md), ADR-0111: the HTTP doorway to a
// success fee's pinned, countersigned metric snapshot. The rules live in
// packages/ledger/src/metric-pins.ts; this proves the routes carry them, the
// scopes gate them, and each step lands in the audit log.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

let env: Env;
let database: Db;
let seeded: SeedResult;
const tokens: Record<string, string> = {};

interface Res<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(who: string, method: string, path: string, payload?: unknown): Promise<Res<T>> {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens[who]}` },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  return { status: res.status, body: (await res.json()) as T };
}

async function login(local: string): Promise<string> {
  const res = await call("", "POST", "/v1/auth/login", { email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" });
  const issued = res.body.token as string;
  tokens["_"] = issued;
  const verified = await call("_", "POST", "/v1/auth/mfa/verify", {
    code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC))
  });
  expect(verified.status).toBe(200);
  return issued;
}

async function verifiedSnapshot(id: string): Promise<string> {
  const [metric] = await database
    .select()
    .from(schema.northMetrics)
    .where(eq(schema.northMetrics.tenantId, seeded.tenantId))
    .limit(1);
  await database.insert(schema.northSnapshots).values({
    id,
    tenantId: seeded.tenantId,
    metricKey: metric!.key,
    grain: "month",
    period: "2031-01",
    dimsHash: id,
    value: 4_200_000,
    ts: Date.now(),
    verifiedAt: Date.now(),
    verifiedBy: "user:auditor",
    verificationRef: "stmt-2031-01"
  });
  return id;
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
  tokens.faisal = await login("faisal.omar"); // finance.controller
  tokens.nadia = await login("nadia.rahman"); // finance.controller
  tokens.mona = await login("mona.idris"); // finance.analyst
}, 120_000);

describe("ledger metric pins (D11, ADR-0111)", () => {
  it("pins a verified snapshot, countersigns both sides with two seats, and audits each step", async () => {
    const snapshotId = await verifiedSnapshot("nsp_api_1");
    const pinned = await call("faisal", "POST", "/v1/ledger/metric-pins", { snapshotId });
    expect(pinned.status).toBe(201);
    expect(pinned.body).toMatchObject({ sourceSnapshotId: snapshotId, value: 4_200_000, state: "pinned" });
    const pinId = pinned.body.id as string;

    // The pinner cannot also be our signature.
    const self = await call("faisal", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/tenant`, {});
    expect(self.status).toBe(409);

    const ours = await call("nadia", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/tenant`, {});
    expect(ours.status).toBe(200);
    expect(ours.body.state).toBe("pinned");

    // Nor may one person stand on both sides.
    const both = await call("nadia", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/counterparty`, {
      evidenceRef: "esign-9"
    });
    expect(both.status).toBe(409);

    const noEvidence = await call("faisal", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/counterparty`, {});
    expect(noEvidence.status).toBe(400);

    const theirs = await call("faisal", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/counterparty`, {
      evidenceRef: "esign-9"
    });
    expect(theirs.status).toBe(200);
    expect(theirs.body).toMatchObject({ state: "countersigned", counterpartyEvidenceRef: "esign-9" });

    const read = await call("mona", "GET", `/v1/ledger/metric-pins/${pinId}`);
    expect(read.status).toBe(200);
    expect(read.body.state).toBe("countersigned");

    const trail = await database
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, seeded.tenantId), eq(schema.auditLog.subjectRef, `ledger_metric_pin:${pinId}`)));
    expect(trail.map((r) => r.action).sort()).toEqual([
      "ledger.metric_pin.countersigned",
      "ledger.metric_pin.countersigned",
      "ledger.metric_pin.pinned"
    ]);
  });

  it("refuses an unknown side and a second pin of the same snapshot", async () => {
    const snapshotId = await verifiedSnapshot("nsp_api_2");
    const pinned = await call("faisal", "POST", "/v1/ledger/metric-pins", { snapshotId });
    expect(pinned.status).toBe(201);
    expect((await call("nadia", "POST", "/v1/ledger/metric-pins", { snapshotId })).status).toBe(409);
    expect((await call("nadia", "POST", `/v1/ledger/metric-pins/${pinned.body.id}/countersign/broker`, {})).status).toBe(400);
  });

  it("gates pinning and signing on their own scopes: an analyst may read, not pin or sign", async () => {
    const snapshotId = await verifiedSnapshot("nsp_api_3");
    expect((await call("mona", "POST", "/v1/ledger/metric-pins", { snapshotId })).status).toBe(403);
    const pinned = await call("faisal", "POST", "/v1/ledger/metric-pins", { snapshotId });
    expect((await call("mona", "POST", `/v1/ledger/metric-pins/${pinned.body.id}/countersign/tenant`, {})).status).toBe(403);
    expect((await call("mona", "GET", "/v1/ledger/metric-pins")).status).toBe(200);
  });

  it("refuses a SUCCESS-FEE whose key is not derived from its pin", async () => {
    const snapshotId = await verifiedSnapshot("nsp_api_4");
    const pinId = (await call("faisal", "POST", "/v1/ledger/metric-pins", { snapshotId })).body.id as string;
    await call("nadia", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/tenant`, {});
    await call("faisal", "POST", `/v1/ledger/metric-pins/${pinId}/countersign/counterparty`, { evidenceRef: "esign-4" });
    const res = await call("faisal", "POST", "/v1/ledger/txn/SUCCESS-FEE", {
      idempotencyKey: "sf:any",
      args: { netMinor: 10_000, taxMinor: 500, pinnedSnapshotId: pinId }
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain(`success-fee:${pinId}`);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { SEED_TENANT_SLUG, seed, type Ctx } from "@lyra/core";
import { EntitlementsJson, PolicyJson, schema, type Db } from "@lyra/db";
import { buildRecipe, post } from "@lyra/ledger";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/27 F14 follow-up. The generic money endpoint is how a controller records
// a manual receipt — cash that arrived by transfer, a cheque, a statement line.
// It used to build the receipt straight from the caller's args, so unless the
// caller knew to pass `clearsReceivableAccount` (nobody did) the premium the
// bind booked on 1200 was never cleared. It now routes premium receipts through
// `premiumReceiptLines`, which clears what the ledger says is open.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

const exec = { waitUntil() {}, passThroughOnException() {} };
const CONTROLLER = "faisal.omar@gonxt.ae";
let database: Db;
let env: Env;
let token = "";

async function call(path: string, method = "GET", payload?: unknown): Promise<Response> {
  return app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
}

async function openOn(code: string, item: string): Promise<number> {
  const l = schema.ledgerJournalLines;
  const rows = await database
    .select()
    .from(l)
    .where(and(eq(l.accountCode, code), sql`json_extract(${l.dimsJson}, '$.item') = ${item}`));
  return rows.reduce((s, r) => s + (r.side === "debit" ? r.amountMinor : -r.amountMinor), 0);
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never);
  env = { DB_CLIENT: database, ENVIRONMENT: "staging", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;
  const res = await call("/v1/auth/demo/login", "POST", { email: CONTROLLER });
  token = ((await res.json()) as { token: string }).token;
}, 60_000);

describe("a manual premium receipt clears the receivable the bind booked", () => {
  it("bind then PREM-COLLECT through /v1/ledger/txn: 1200 and 2000 net to zero for the item", async () => {
    const item = "policy:pol_receipt_test";
    // The bind exactly as `routes/axis.ts` posts it. Posted straight to the
    // ledger: BIND is approval-gated (axis.bind) and the approval flow is not
    // what this test is about.
    const [tenant] = await database.select().from(schema.tenants).where(eq(schema.tenants.slug, SEED_TENANT_SLUG));
    const now = Date.now();
    const ctx: Ctx = {
      db: database as unknown as Ctx["db"],
      tenantId: tenant!.id,
      actor: { kind: "user", id: "u_test", tenantId: tenant!.id, grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
      requestId: "req_receipt",
      now,
      locale: "en",
      policy: PolicyJson.parse({ currency: "AED" }),
      entitlements: EntitlementsJson.parse({})
    };
    await database.insert(schema.ledgerTxns).values({
      id: "tx_receipt_bind",
      tenantId: tenant!.id,
      type: "BIND",
      idempotencyKey: "receipt-test-bind",
      state: "authorized",
      actorKind: "user",
      actorId: "u_test",
      currency: "AED",
      baseCurrency: "AED",
      grossMinor: 50_000,
      baseGrossMinor: 50_000,
      createdAt: now,
      updatedAt: now
    });
    await post(ctx, {
      txnId: "tx_receipt_bind",
      currency: "AED",
      lines: buildRecipe("BIND", {
        gwpMinor: 50_000,
        grossMinor: 5_000,
        dims: { item, dueAt: now, policy: "pol_receipt_test", counterparty: "provider:prov_receipt" }
      })
    });
    expect(await openOn("1200", item)).toBe(50_000);

    const paid = await call("/v1/ledger/txn/PREM-COLLECT", "POST", {
      idempotencyKey: "receipt-test-collect",
      currency: "AED",
      grossMinor: 50_000,
      // The caller names the policy and nothing about clearing.
      args: { amountMinor: 50_000, dims: { policy: "pol_receipt_test" } }
    });
    expect(paid.status).toBe(201);

    expect(await openOn("1200", item)).toBe(0);
    expect(await openOn("2000", item)).toBe(0);
  });
});

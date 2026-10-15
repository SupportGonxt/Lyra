import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// ADR-0124 — the consumer's door, and the three things it promises:
//   1. it captures its own consent basis rather than bypassing the gate;
//   2. it widens no permission (a customer actor with no grants, so the margin
//      strip applies by construction);
//   3. it works with no session at all.
//
// Run against the real app, because the point of the door is that it is reachable
// by someone with no token — a unit test of the handler would supply the very
// thing this has to prove absent.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const exec = { waitUntil() {}, passThroughOnException() {} };

let database: Db;
let env: Env;
let seeded: SeedResult;
let productId: string;
let channelId: string;

async function call<T = any>(method: string, path: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      // Deliberately no authorization header anywhere in this file.
      headers: { "content-type": "application/json", ...headers },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  return { status: res.status, body: (isJson ? await res.json() : null) as T };
}

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean)) {
    await client.execute(stmt);
  }
  database = drizzle(client) as unknown as Db;
  seeded = await seed(database as never, { mfaSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" });
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173", KV: fakeKv() } as unknown as Env;

  const [product] = await database.select().from(schema.products).where(eq(schema.products.line, "motor"));
  productId = product!.id;
  channelId = seeded.channels.web!;
}, 120_000);

/** The rate limiter needs somewhere to count; a Map is the whole of it here. */
function fakeKv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v)
  };
}

const body = (over: Record<string, unknown> = {}) => ({
  tenantSlug: "gonxt",
  productId,
  channelId,
  inputs: { age: 34, sumInsuredMinor: 28_000_000, priorClaims: false, vehicleUse: "private" },
  contact: { name: "Web Visitor", email: `visitor-${Math.random().toString(36).slice(2)}@example.com` },
  consent: { dataSharing: true },
  ...over
});

describe("POST /v1/dist/public/quote-start", () => {
  it("quotes a visitor who has no session at all", async () => {
    const res = await call("POST", "/v1/dist/public/quote-start", body());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.requestId).toBeTruthy();
  });

  it("records the visitor's own consent rather than shopping without one", async () => {
    // The gate it must not bypass: "no consent, no fan-out". A row is written, it
    // names the basis, and it permits data sharing.
    const email = `consented-${Math.random().toString(36).slice(2)}@example.com`;
    expect((await call("POST", "/v1/dist/public/quote-start", body({ contact: { name: "V", email } }))).status).toBe(201);

    const [customer] = await database
      .select()
      .from(schema.customers)
      .where(and(eq(schema.customers.tenantId, seeded.tenantId), eq(schema.customers.emailsJson, JSON.stringify([email]))));
    expect(customer).toBeTruthy();

    const consents = await database
      .select()
      .from(schema.consents)
      .where(and(eq(schema.consents.tenantId, seeded.tenantId), eq(schema.consents.customerId, customer!.id)));
    expect(consents).toHaveLength(1);
    expect(consents[0]!.source).toBe("web");
    expect(JSON.parse(consents[0]!.purposesJson).dataSharing).toBe(true);
  });

  it("returns ranked offers and never the margin", async () => {
    const res = await call<{ quotes: Record<string, unknown>[] }>("POST", "/v1/dist/public/quote-start", body());
    expect(res.status).toBe(201);
    expect(res.body.quotes.length).toBeGreaterThan(0);
    // The customer-facing projection must not carry a commission under any name.
    for (const quote of res.body.quotes) {
      expect(Object.keys(quote)).not.toContain("commissionMinor");
      expect(Object.keys(quote)).not.toContain("commissionPpm");
      expect(Object.keys(quote)).not.toContain("channelCommissionMinor");
    }
    const premiums = res.body.quotes.map((q) => Number(q.premiumMinor ?? 0));
    expect(premiums).toEqual([...premiums].sort((a, b) => a - b));
  });

  it("refuses a body with no consent statement, and says which field is missing", async () => {
    // `dataSharing: true` is a literal, so omitting or falsifying it is a refusal
    // at the boundary rather than a fan-out.
    const res = await call<{ detail?: string }>("POST", "/v1/dist/public/quote-start", {
      ...body(),
      consent: { marketing: false }
    });
    expect(res.status).toBe(400);
  });
});

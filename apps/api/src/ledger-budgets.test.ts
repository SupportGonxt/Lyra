import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/30 Ledger 4, ADR-0104. Budgets are a CRUD resource on the chart of
// accounts — validated against the tenant's own chart, audited on every write —
// and the report compares them with the posted lines of the same month and
// currency.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const exec = { waitUntil() {}, passThroughOnException() {} };

let database: Db;
let env: Env;
const tokens: Record<string, string> = {};

/** Sets budgets (finance.controller). */
const CONTROLLER = "faisal.omar@gonxt.ae";
/** Reads budgets, cannot set them (finance.analyst). */
const FINANCE_ANALYST = "mona.idris@gonxt.ae";
/** Reads the journal but not the plan (north.analyst). */
const NORTH_ANALYST = "rana.hadid@gonxt.ae";

async function fetchAs(email: string | null, path: string, method = "GET", payload?: unknown): Promise<Response> {
  const token = email ? tokens[email] : undefined;
  return app.fetch(
    new Request(`http://api.test${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
    }),
    env as never,
    exec as never
  );
}

const PERIOD = "2031-03"; // a month the seeded history never reached

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never);
  env = { DB_CLIENT: database, ENVIRONMENT: "staging", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;
  for (const email of [CONTROLLER, FINANCE_ANALYST, NORTH_ANALYST]) {
    const res = await fetchAs(null, "/v1/auth/demo/login", "POST", { email });
    tokens[email] = ((await res.json()) as { token: string }).token;
  }
}, 60_000);

describe("budgets (the resource)", () => {
  it("sets a budget for an account, month and currency, and audits it", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/budgets", "POST", {
      accountCode: "5100",
      period: PERIOD,
      currency: "AED",
      amountMinor: 50_000_00,
      note: "Spring campaign"
    });
    expect(res.status).toBe(201);
    const row = (await res.json()) as { id: string; tenantId: string };

    const audit = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, row.tenantId), eq(schema.auditLog.action, "ledger.budgets.create")));
    expect(audit.some((a) => a.subjectRef === row.id)).toBe(true);

    const changed = await fetchAs(CONTROLLER, `/v1/ledger/budgets/${row.id}`, "PATCH", { amountMinor: 60_000_00 });
    expect(changed.status).toBe(200);
    const updates = await database
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.tenantId, row.tenantId), eq(schema.auditLog.action, "ledger.budgets.update")));
    expect(updates.some((a) => a.subjectRef === row.id)).toBe(true);
  });

  it("refuses a second budget for the same account, month and currency", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/budgets", "POST", {
      accountCode: "5100",
      period: PERIOD,
      currency: "AED",
      amountMinor: 1
    });
    expect(res.status).toBe(409);
  });

  it("refuses an account the tenant's chart does not hold, a non-month and a non-ISO currency", async () => {
    const base = { accountCode: "4000", period: PERIOD, currency: "AED", amountMinor: 100 };
    for (const bad of [
      { accountCode: "9999" },
      { period: "2031-13" },
      { period: "2031-3" },
      { currency: "aed" },
      { currency: "DIRHAM" },
      { amountMinor: -1 }
    ]) {
      const res = await fetchAs(CONTROLLER, "/v1/ledger/budgets", "POST", { ...base, ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("refuses an edit that would move a budget onto an account the chart does not hold", async () => {
    const created = await fetchAs(CONTROLLER, "/v1/ledger/budgets", "POST", {
      accountCode: "4020",
      period: PERIOD,
      currency: "AED",
      amountMinor: 100
    });
    const { id } = (await created.json()) as { id: string };
    expect((await fetchAs(CONTROLLER, `/v1/ledger/budgets/${id}`, "PATCH", { accountCode: "9999" })).status).toBe(400);
  });

  it("lets a finance analyst read budgets but not set them", async () => {
    expect((await fetchAs(FINANCE_ANALYST, "/v1/ledger/budgets")).status).toBe(200);
    const res = await fetchAs(FINANCE_ANALYST, "/v1/ledger/budgets", "POST", {
      accountCode: "4000",
      period: PERIOD,
      currency: "AED",
      amountMinor: 1
    });
    expect(res.status).toBe(403);
  });
});

interface Report {
  periodCode: string;
  rows: Array<{ accountCode: string; currency: string; budgetMinor: number | null; actualMinor: number; varianceMinor: number | null }>;
}

describe("budget vs actual (the report)", () => {
  it("compares each budget with the same month's lines in its own currency", async () => {
    expect(
      (
        await fetchAs(CONTROLLER, "/v1/ledger/budgets", "POST", {
          accountCode: "5100",
          period: PERIOD,
          currency: "USD",
          amountMinor: 2_000_00
        })
      ).status
    ).toBe(201);

    const res = await fetchAs(CONTROLLER, `/v1/ledger/reports/budget-vs-actual?period=${PERIOD}`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as Report;
    expect(report.periodCode).toBe(PERIOD);
    const media = report.rows.filter((r) => r.accountCode === "5100");
    expect(media.map((r) => [r.currency, r.budgetMinor, r.actualMinor, r.varianceMinor])).toEqual([
      ["AED", 60_000_00, 0, -60_000_00],
      ["USD", 2_000_00, 0, -2_000_00]
    ]);
  });

  it("refuses a period that is not a month", async () => {
    expect((await fetchAs(CONTROLLER, "/v1/ledger/reports/budget-vs-actual?period=March")).status).toBe(400);
  });

  it("is closed to a reader of the journal who may not read the plan", async () => {
    expect((await fetchAs(NORTH_ANALYST, `/v1/ledger/reports/budget-vs-actual?period=${PERIOD}`)).status).toBe(403);
    expect((await fetchAs(FINANCE_ANALYST, `/v1/ledger/reports/budget-vs-actual?period=${PERIOD}`)).status).toBe(200);
    expect((await fetchAs(null, `/v1/ledger/reports/budget-vs-actual?period=${PERIOD}`)).status).toBe(401);
  });

  it("exports the same rows the screen shows", async () => {
    const res = await fetchAs(CONTROLLER, `/v1/ledger/reports/budget-vs-actual/export?format=json&period=${PERIOD}`);
    expect(res.status).toBe(200);
    const table = (await res.json()) as { columns: Array<{ key: string; kind: string }>; rows: Array<Record<string, unknown>> };
    expect(table.columns.find((c) => c.key === "budgetMinor")?.kind).toBe("money");
    expect(table.rows.filter((r) => r.accountCode === "5100").map((r) => r.currency)).toEqual(["AED", "USD"]);
  });
});

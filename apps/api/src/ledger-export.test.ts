import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { seed } from "@lyra/core";
import { schema, type Db } from "@lyra/db";
import { app } from "./index.js";
import type { Env } from "./env.js";

// LED-REP. The finance reports as files: same permission as the screen beside
// them, same numbers, and a row in the audit log every time one leaves.

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

/** The controller reads everything; the analyst reads journals but not client money. */
const CONTROLLER = "faisal.omar@gonxt.ae";
const ANALYST = "rana.hadid@gonxt.ae";

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

beforeAll(async () => {
  const client = createClient({ url: ":memory:" });
  for (const stmt of statements()) await client.execute(stmt);
  database = drizzle(client) as unknown as Db;
  await seed(database as never);
  env = {
    DB_CLIENT: database,
    // Staging so the persona door is open — the password path costs a TOTP and
    // proves nothing about exports.
    ENVIRONMENT: "staging",
    APP_ORIGIN: "http://localhost:5173"
  } as unknown as Env;

  for (const email of [CONTROLLER, ANALYST]) {
    const res = await fetchAs(null, "/v1/auth/demo/login", "POST", { email });
    const body = (await res.json()) as { token: string };
    tokens[email] = body.token;
  }

  // Real money in the ledger, so an export is a report and not an empty grid.
  const posted = await fetchAs(CONTROLLER, "/v1/ledger/txn/PREM-COLLECT", "POST", {
    idempotencyKey: "led-export-collect-1",
    currency: "AED",
    grossMinor: 120_000_00,
    args: { amountMinor: 120_000_00, memo: "premium received" }
  });
  expect(posted.status).toBe(201);
}, 60_000);

describe("finance report exports", () => {
  const CASES = [
    ["xlsx", "spreadsheetml.sheet", "PK"],
    ["pdf", "application/pdf", "%PDF"],
    // The CSV opens on a UTF-8 BOM, so its signature starts three bytes in.
    ["csv", "text/csv", "Acc"],
    ["json", "application/json", "{"]
  ] as const;

  for (const [format, contentType, magic] of CASES) {
    it(`renders the trial balance as ${format}`, async () => {
      const res = await fetchAs(CONTROLLER, `/v1/ledger/reports/trial-balance/export?format=${format}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(contentType);
      expect(res.headers.get("content-disposition")).toContain(`filename="trial-balance-`);

      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(64);
      // The first bytes are the format's own signature: a file that opens, not
      // a placeholder with the right content-type on it.
      expect(new TextDecoder().decode(bytes.slice(0, 8))).toContain(magic);
    });
  }

  it("puts real numbers, in minor units under a money column, into the payload", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/reports/trial-balance/export?format=json");
    const table = (await res.json()) as {
      columns: { key: string; label: string; kind: string }[];
      rows: Record<string, number>[];
      totals: Record<string, number>;
    };
    const debit = table.columns.find((c) => c.key === "debitMinor");
    expect(debit?.kind).toBe("money");
    // The currency rides in the header so the number stays a number.
    expect(debit?.label).toContain("AED");
    expect(table.rows.length).toBeGreaterThan(0);
    // The premium posted in setup has to be inside the total; the tenant's
    // seeded history sits alongside it, so the floor is the assertion.
    expect(table.totals.debitMinor).toBeGreaterThanOrEqual(120_000_00);
    expect(table.totals.debitMinor).toBe(table.totals.creditMinor);
  });

  // docs/27 "thin screens": the statement and the money map had no export at
  // all, so a controller could read either on screen and hand nothing to an
  // auditor. Both are driven by the very functions their JSON routes call.
  it("exports the account statement, with its two figures as totals", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/reports/account-statement/export?format=json&code=1000");
    expect(res.status).toBe(200);
    const table = (await res.json()) as {
      title: string;
      columns: { key: string; kind: string }[];
      rows: Record<string, unknown>[];
      totals: Record<string, number>;
    };
    expect(table.title).toContain("1000");
    expect(table.columns.find((c) => c.key === "runningMinor")?.kind).toBe("money");
    expect(table.rows.length).toBeGreaterThan(0);
    // Opening and closing are the figures the statement is read for and neither
    // is a row, so they travel as totals or they are lost in the file.
    expect(table.totals).toHaveProperty("openingMinor");
    expect(table.totals).toHaveProperty("closingMinor");
  });

  it("refuses an account statement with no account named", async () => {
    expect((await fetchAs(CONTROLLER, "/v1/ledger/reports/account-statement/export?format=csv")).status).toBe(400);
  });

  it("exports the money map, one row per stage of the flow", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/reports/value-flow/export?format=json&period=2026-06");
    expect(res.status).toBe(200);
    const table = (await res.json()) as {
      title: string;
      rows: { node: string; amountMinor: number }[];
      totals: Record<string, number>;
    };
    expect(table.title).toContain("2026-06");
    expect(table.rows.map((r) => r.node)).toContain("premium-in");
    expect(table.totals).toHaveProperty("carriedMinor");
  });

  // docs/27 P2 "no bordereaux, inbound or outbound". Outbound only: the
  // per-policy premium/commission listing an insurer expects, reusing the same
  // export infrastructure as the account statement and the money map above.
  it("exports a bordereaux, one row per commission entry with its policy's term", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/reports/bordereaux/export?format=json");
    expect(res.status).toBe(200);
    const table = (await res.json()) as {
      title: string;
      columns: { key: string; kind: string }[];
      rows: Record<string, unknown>[];
    };
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.columns.find((c) => c.key === "commissionMinor")?.kind).toBe("money");
    for (const key of ["policyNo", "providerId", "earnedAt", "startAt", "endAt"]) {
      expect(table.rows[0]).toHaveProperty(key);
    }
  });

  it("narrows a bordereaux to one provider and period", async () => {
    const all = (await (await fetchAs(CONTROLLER, "/v1/ledger/reports/bordereaux/export?format=json")).json()) as {
      rows: { providerId: string }[];
    };
    const someProvider = all.rows[0]!.providerId;
    const res = await fetchAs(
      CONTROLLER,
      `/v1/ledger/reports/bordereaux/export?format=json&providerId=${encodeURIComponent(someProvider)}`
    );
    const table = (await res.json()) as { rows: { providerId: string }[] };
    expect(table.rows.length).toBeGreaterThan(0);
    expect(table.rows.every((r) => r.providerId === someProvider)).toBe(true);
  });

  it("exports every report the screen can show", async () => {
    for (const key of [
      "trial-balance",
      "pnl",
      "balance-sheet",
      "aged",
      "commission",
      "client-money",
      "value-flow",
      "bordereaux"
    ]) {
      const res = await fetchAs(CONTROLLER, `/v1/ledger/reports/${key}/export?format=csv`);
      expect(res.status, key).toBe(200);
      const text = await res.text();
      // Header row at least — a report with no rows still names its columns.
      expect(text.split("\r\n")[0]!.length, key).toBeGreaterThan(0);
    }
  });

  it("refuses an unknown report and an unknown format", async () => {
    expect((await fetchAs(CONTROLLER, "/v1/ledger/reports/nonsense/export")).status).toBe(404);
    expect((await fetchAs(CONTROLLER, "/v1/ledger/reports/pnl/export?format=doc")).status).toBe(400);
  });

  it("gates each report on that report's own permission", async () => {
    // The analyst holds ledger:journals:read and not ledger:client_money:read,
    // so the same door opens on one report and stays shut on the other.
    expect((await fetchAs(ANALYST, "/v1/ledger/reports/trial-balance/export?format=csv")).status).toBe(200);
    expect((await fetchAs(ANALYST, "/v1/ledger/reports/client-money/export?format=csv")).status).toBe(403);
    expect((await fetchAs(null, "/v1/ledger/reports/trial-balance/export?format=csv")).status).toBe(401);
  });

  // `?asOf=` is caller input on a money report. `Number("abc")` is NaN, which
  // `??` does not catch, and it reached `lte(postedAt, asOf)` and
  // `Math.floor((asOf - postedAt) / DAY)` as a bind param — a DrizzleQueryError
  // 500 where 400 is the answer. `9e15` is worse: it survives the query and
  // lands in `generatedAt`, which the document header renders.
  it("refuses an asOf that is not an instant, on every report that takes one", async () => {
    for (const key of ["balance-sheet", "aged", "trial-balance"]) {
      for (const bad of ["abc", "9e15"]) {
        expect((await fetchAs(CONTROLLER, `/v1/ledger/reports/${key}?asOf=${bad}`)).status, `${key} ${bad}`).toBe(400);
        expect(
          (await fetchAs(CONTROLLER, `/v1/ledger/reports/${key}/export?format=csv&asOf=${bad}`)).status,
          `${key} ${bad} export`
        ).toBe(400);
      }
    }
    // The window params on the account statement are the same shape.
    expect((await fetchAs(CONTROLLER, "/v1/ledger/accounts/1000/statement?from=abc")).status).toBe(400);
    expect((await fetchAs(CONTROLLER, "/v1/ledger/accounts/1000/statement?to=9e15")).status).toBe(400);
  });

  it("still takes an asOf a Date can hold", async () => {
    const res = await fetchAs(CONTROLLER, "/v1/ledger/reports/balance-sheet?asOf=" + Date.parse("2026-06-15T00:00:00Z"));
    expect(res.status).toBe(200);
  });

  it("writes an audit row for every export", async () => {
    const rows = await database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "ledger.report.export"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.subjectRef === "report:client-money")).toBe(true);
  });
});

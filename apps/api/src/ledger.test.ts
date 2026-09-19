import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// Which handler owns `GET /v1/ledger/periods/:id`. The enriched period view used
// to sit on that path and swallow the generated CRUD record handler, so the
// record screen got a `{period, checks}` wrapper where it expects a flat row.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

const PEOPLE: Record<string, string> = {
  "finance.controller": "faisal.omar",
  "orbit.agent": "sara.nasser"
};

let env: Env;
let tokens: Record<string, string>;
let database: Db;

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
  await seed(database as never, { mfaSecret: DEMO_TOTP_SECRET });

  env = {
    DB_CLIENT: database,
    ENVIRONMENT: "development",
    APP_ORIGIN: "http://localhost:5173",
    // ponytail: a Map is the whole of R2 a bundle needs — put then get.
    FILES: (() => {
      const objects = new Map<string, Uint8Array>();
      return {
        put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes),
        get: async (key: string) => {
          const bytes = objects.get(key);
          return bytes ? { body: new Response(bytes).body } : null;
        }
      };
    })()
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

describe("GET /v1/ledger/periods/:id reaches the CRUD record handler", () => {
  const code = "2026-03";
  let periodId: string;

  beforeAll(async () => {
    // The enriched view is what creates the row, so ask for it first.
    const seeded = await call("finance.controller", "GET", `/v1/ledger/period/${code}`);
    expect(seeded.status).toBe(200);
    periodId = seeded.body.period.id as string;
  });

  it("answers with a flat row, not the enriched wrapper", async () => {
    const res = await call("finance.controller", "GET", `/v1/ledger/periods/${periodId}`);
    expect(res.status).toBe(200);
    expect(res.body.period).toBeUndefined();
    expect(res.body.checks).toBeUndefined();
    expect(res.body.id).toBe(periodId);
    expect(res.body.code).toBe(code);
    expect(res.body.state).toBe("open");
  });

  it("serves the enriched view from the singular path", async () => {
    const res = await call("finance.controller", "GET", `/v1/ledger/period/${code}`);
    expect(res.status).toBe(200);
    expect(res.body.period.code).toBe(code);
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.every((c: { name: string }) => c.name.endsWith(`@${code}`))).toBe(true);
  });

  it("still gates the enriched view on ledger:periods:read", async () => {
    const res = await call("orbit.agent", "GET", `/v1/ledger/period/${code}`);
    expect(res.status).toBe(403);
  });
});

describe("the retired generic CRUD door onto periods is gone", () => {
  const code = "2026-04";
  let periodId: string;

  beforeAll(async () => {
    const seeded = await call("finance.controller", "GET", `/v1/ledger/period/${code}`);
    expect(seeded.status).toBe(200);
    periodId = seeded.body.period.id as string;
  });

  it("cannot jump a period straight to hard_closed by PATCHing state directly", async () => {
    // Only POST /periods/:code/close runs closeChecks() and enforces
    // soft-before-hard sequencing. A generic PATCH here would skip both.
    const res = await call("finance.controller", "PATCH", `/v1/ledger/periods/${periodId}`, {
      state: "hard_closed"
    });
    expect(res.status).toBe(404);

    const [row] = await database
      .select()
      .from(schema.ledgerPeriods)
      .where(eq(schema.ledgerPeriods.id, periodId));
    expect(row?.state).toBe("open");
  });

  it("still reads through the generic resource", async () => {
    const res = await call("finance.controller", "GET", `/v1/ledger/periods/${periodId}`);
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/ledger/recon/runs/:id/evidence-bundle", () => {
  let runId: string;

  beforeAll(async () => {
    const created = await call("finance.controller", "POST", "/v1/ledger/recon/runs", {
      process: "psp",
      period: "2026-03",
      currency: "AED",
      lines: [{ ref: "stmt-1", amountMinor: 10000, currency: "AED" }]
    });
    expect(created.status).toBe(201);
    runId = created.body.runId as string;
  });

  it("bundles the run, hashes each file and the archive, and records the file on the run", async () => {
    const res = await call("finance.controller", "POST", `/v1/ledger/recon/runs/${runId}/evidence-bundle`);
    expect(res.status).toBe(201);
    expect(res.body.state).toBe("ready");
    expect(res.body.purpose).toBe("audit");
    expect(res.body.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.manifest.files).toHaveLength(3);

    const [run] = await database
      .select()
      .from(schema.ledgerReconRuns)
      .where(eq(schema.ledgerReconRuns.id, runId));
    expect(run?.evidenceBundleFileId).toBe(res.body.fileId);
  });

  it("downloads an archive whose bytes hash to the stored bundle hash", async () => {
    const built = await call("finance.controller", "POST", `/v1/ledger/recon/runs/${runId}/evidence-bundle`);
    const res = await call<ArrayBuffer>("finance.controller", "GET", `/v1/ledger/recon/runs/${runId}/evidence-bundle/download`);
    expect(res.status).toBe(200);

    const raw = await app.fetch(
      new Request(`http://api.test/v1/ledger/recon/runs/${runId}/evidence-bundle/download`, {
        headers: { authorization: `Bearer ${tokens["finance.controller"]}` }
      }),
      env as never,
      exec as never
    );
    const bytes = new Uint8Array(await raw.arrayBuffer());
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe(built.body.bundleHash);
  });

  it("is 403 without ledger:recon:export, 404 for a run with no bundle yet", async () => {
    expect((await call("orbit.agent", "POST", `/v1/ledger/recon/runs/${runId}/evidence-bundle`)).status).toBe(403);
    expect((await call("orbit.agent", "GET", `/v1/ledger/recon/runs/${runId}/evidence-bundle/download`)).status).toBe(403);

    const bare = await call("finance.controller", "POST", "/v1/ledger/recon/runs", {
      process: "psp",
      period: "2026-04",
      currency: "AED",
      lines: [{ ref: "stmt-2", amountMinor: 500, currency: "AED" }]
    });
    expect((await call("finance.controller", "GET", `/v1/ledger/recon/runs/${bare.body.runId}/evidence-bundle/download`)).status).toBe(404);
  });
});

// The write-off is the instrument reconciliation needed to reach
// nothing-left-open. What matters at this level is that it is a transaction
// like any other: gated, keyed, and refused where it must never reach.
describe("POST /v1/ledger/txn/RECON-WRITEOFF", () => {
  const reason = "insurer statement rounds premium tax; 42 fils left on the receivable";

  it("stops at the approval gate — a write-off is dual control always", async () => {
    const res = await call("finance.controller", "POST", "/v1/ledger/txn/RECON-WRITEOFF", {
      idempotencyKey: "writeoff:gate:shortfall:42",
      currency: "AED",
      grossMinor: 42,
      reason,
      args: { amountMinor: 42, direction: "shortfall", reason }
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("approval_required");
    expect(res.body.policy_key).toBe("ledger.write_off");
  });

  it("refuses a client-money account before it ever reaches the gate", async () => {
    const res = await call("finance.controller", "POST", "/v1/ledger/txn/RECON-WRITEOFF", {
      idempotencyKey: "writeoff:cm:shortfall:42",
      currency: "AED",
      grossMinor: 42,
      reason,
      args: { amountMinor: 42, direction: "shortfall", clearingAccount: "1010", reason }
    });
    expect(res.status).toBe(400);
    expect(String(res.body.detail)).toMatch(/client money/);
  });

  it("publishes its arguments on the type catalogue, so the UI can ask for them", async () => {
    const res = await call("finance.controller", "GET", "/v1/ledger/txn-types");
    const type = (res.body.data as Array<{ code: string; financial: boolean; approval: string | null; args: Array<{ name: string }> }>)
      .find((t) => t.code === "RECON-WRITEOFF");
    expect(type).toMatchObject({ financial: true, approval: "ledger.write_off" });
    expect(type?.args.map((a) => a.name)).toEqual(
      expect.arrayContaining(["amountMinor", "direction", "clearingAccount", "reason"])
    );
  });
});

// `closeRun` was written, exported and called by nothing, so a run could be
// reviewed and never closed. These are the three answers the endpoint owes:
// refuse while anything is open, close when nothing is, and gate on the same
// permission deciding a match needs.
describe("POST /v1/ledger/recon/runs/:id/close", () => {
  let runId: string;
  let openMatchIds: string[];

  beforeAll(async () => {
    const created = await call("finance.controller", "POST", "/v1/ledger/recon/runs", {
      process: "psp",
      period: "2026-05",
      currency: "AED",
      // Nothing of ours matches this reference, so the line lands `unmatched`:
      // open, and decidable only by rejecting it with a reason.
      lines: [{ ref: "stmt-close-1", amountMinor: 4200, currency: "AED" }]
    });
    expect(created.status).toBe(201);
    runId = created.body.runId as string;

    const matches = await database
      .select()
      .from(schema.ledgerReconMatches)
      .where(eq(schema.ledgerReconMatches.runId, runId));
    openMatchIds = matches.filter((m) => m.state === "proposed" || m.state === "unmatched").map((m) => m.id);
    expect(openMatchIds.length).toBeGreaterThan(0);
  });

  it("refuses a run that still has open matches, and leaves it in review", async () => {
    const res = await call("finance.controller", "POST", `/v1/ledger/recon/runs/${runId}/close`);
    expect(res.status).toBe(409);

    const [run] = await database
      .select()
      .from(schema.ledgerReconRuns)
      .where(eq(schema.ledgerReconRuns.id, runId));
    expect(run?.state).toBe("review");
  });

  it("is 403 without ledger:recon:confirm", async () => {
    expect((await call("orbit.agent", "POST", `/v1/ledger/recon/runs/${runId}/close`)).status).toBe(403);
  });

  it("closes once every straggler has been rejected with a reason", async () => {
    for (const id of openMatchIds) {
      const decided = await call("finance.controller", "POST", `/v1/ledger/recon/matches/${id}/decide`, {
        decision: "rejected",
        reasonCode: "not_ours"
      });
      expect(decided.status).toBe(204);
    }

    const res = await call("finance.controller", "POST", `/v1/ledger/recon/runs/${runId}/close`);
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("closed");
    expect(res.body.open).toBe(0);

    const [run] = await database
      .select()
      .from(schema.ledgerReconRuns)
      .where(eq(schema.ledgerReconRuns.id, runId));
    expect(run?.state).toBe("closed");
    // The closer is named: a system close and a human close are not the same fact.
    expect(run?.closedBy).toMatch(/^user:/);
  });
});

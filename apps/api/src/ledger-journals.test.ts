import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { schema, type Db } from "@lyra/db";
import { seed, totpAt, TOTP_STEP_SEC, type SeedResult } from "@lyra/core";
import { app } from "./index.js";
import type { Env } from "./env.js";

// docs/27 F2 and F3, through the doorway. The ledger package proves the entries
// balance; what is proved here is the separation of duties around them: an
// analyst may write a manual journal but not post it, and a year-end close is a
// controller's act that reads its own lines out of the ledger rather than
// trusting the ones a browser sent.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "packages", "db", "migrations");
const PASSWORD = "Gonxt-Demo-2026!";
const DEMO_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const exec = { waitUntil() {}, passThroughOnException() {} };

/** analyst drafts, controller posts, second controller is the other half of dual control. */
const PEOPLE: Record<string, string> = {
  analyst: "mona.idris",
  controller: "faisal.omar",
  approver: "nadia.rahman"
};

let env: Env;
let database: Db;
let seeded: SeedResult;
let tokens: Record<string, string>;

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

function ok<T>(res: Res<T>, ...accept: number[]): T {
  const allowed = accept.length ? accept : [200, 201, 204];
  if (!allowed.includes(res.status)) {
    throw new Error(`expected ${allowed.join("|")}, got ${res.status}: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

/** The dual-control shape: one seat asks, a different seat decides, the ask is replayed. */
async function throughApproval<T = any>(
  initiator: string,
  approver: string,
  method: string,
  path: string,
  payload?: unknown
): Promise<Res<T>> {
  const first = await call(initiator, method, path, payload);
  expect(first.status, JSON.stringify(first.body)).toBe(403);
  expect(first.body.type).toContain("approval_required");
  ok(await call(approver, "POST", `/v1/me/approvals/${first.body.approval_id}/decide`, { decision: "approved" }));
  return call<T>(initiator, method, path, payload);
}

async function login(local: string): Promise<string> {
  const res = await app.fetch(
    new Request("http://api.test/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `${local}@gonxt.ae`, password: PASSWORD, tenantSlug: "gonxt" })
    }),
    env as never,
    exec as never
  );
  const token = ((await res.json()) as { token: string }).token;
  const verified = await app.fetch(
    new Request("http://api.test/v1/auth/mfa/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: await totpAt(DEMO_TOTP_SECRET, Math.floor(Date.now() / 1000 / TOTP_STEP_SEC)) })
    }),
    env as never,
    exec as never
  );
  expect(verified.status).toBe(200);
  return token;
}

const REASON = "accrue August office rent not yet invoiced";

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
  expect(seeded.tenantId).toBeTruthy();
  env = { DB_CLIENT: database, ENVIRONMENT: "development", APP_ORIGIN: "http://localhost:5173" } as unknown as Env;

  tokens = {};
  for (const [who, local] of Object.entries(PEOPLE)) tokens[who] = await login(local);
}, 120_000);

/** The seed already trades through this ledger, so every figure here is a delta. */
async function balanceOf(accountCode: string): Promise<number> {
  const tb = ok(await call("controller", "GET", "/v1/ledger/reports/trial-balance"));
  return (tb.rows.find((r: any) => r.accountCode === accountCode)?.balanceMinor as number) ?? 0;
}

describe("manual journals (docs/27 F2)", () => {
  const lines = [
    { accountCode: "5400", side: "debit", amountMinor: 12_000_00 },
    { accountCode: "2100", side: "credit", amountMinor: 12_000_00 }
  ];

  it("an analyst may draft one, and it does not post until a second seat says so", async () => {
    const before = await balanceOf("5400");
    const posted = await throughApproval("analyst", "controller", "POST", "/v1/ledger/txn/MANUAL-JRNL", {
      idempotencyKey: "mj-accrual-1",
      currency: "AED",
      args: { lines, reason: REASON }
    });
    expect(posted.body.txn.state).toBe("settled");
    expect(await balanceOf("5400")).toBe(before + 12_000_00);
  });

  it("refuses an unbalanced entry before it reaches the approval queue", async () => {
    const bad = await call("analyst", "POST", "/v1/ledger/txn/MANUAL-JRNL", {
      idempotencyKey: "mj-unbalanced-1",
      currency: "AED",
      args: {
        lines: [
          { accountCode: "5400", side: "debit", amountMinor: 900_00 },
          { accountCode: "2100", side: "credit", amountMinor: 100_00 }
        ],
        reason: REASON
      }
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("does not balance");
  });

  it("will not let a manual journal touch client money or equity", async () => {
    for (const accountCode of ["1010", "3100"]) {
      const denied = await call("analyst", "POST", "/v1/ledger/txn/MANUAL-JRNL", {
        idempotencyKey: `mj-forbidden-${accountCode}`,
        currency: "AED",
        args: {
          lines: [
            { accountCode, side: "debit", amountMinor: 100_00 },
            { accountCode: "2100", side: "credit", amountMinor: 100_00 }
          ],
          reason: REASON
        }
      });
      expect(denied.status, `account ${accountCode}`).toBe(400);
    }
  });
});

describe("year-end close (docs/27 F3)", () => {
  const year = new Date().getUTCFullYear();
  const period = new Date().toISOString().slice(0, 7);

  it("previews the entry that would zero income and expense", async () => {
    const preview = ok(await call("controller", "GET", `/v1/ledger/year-end/${year}`));
    expect(preview.fiscalYear).toBe(year);
    expect(preview.netMinor).toBe(preview.incomeMinor - preview.expenseMinor);
    // Every closing leg is the mirror of a balance the trial balance still carries.
    const rent = preview.closingLines.find((l: any) => l.accountCode === "5400");
    expect(rent).toMatchObject({ side: "credit", amountMinor: await balanceOf("5400") });
    expect(preview.retainedEarningsAccount).toBe("3100");
  });

  it("refuses while the year still has an open period", async () => {
    const early = await call("controller", "POST", `/v1/ledger/year-end/${year}`);
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain("open periods");
  });

  it("posts the residual to retained earnings once the months are closed", async () => {
    // The seed leaves money in flight; the checklist will not freeze a month over
    // a transaction still waiting on a provider, so clear the queue the way a
    // controller would — the provider never answered, so they expire.
    const inflight = ok(await call("controller", "GET", "/v1/ledger/txns?state=pending_external&limit=100"));
    for (const txn of inflight.data as { id: string }[]) {
      ok(await call("controller", "POST", `/v1/ledger/txn/${txn.id}/transition`, {
        to: "expired",
        reason: "provider did not respond before the month closed"
      }));
    }

    // ADR-0083's recon_complete check: the seed deliberately leaves a couple of
    // reconciliation runs in `review` (the ongoing-work the demo shows on the
    // recon desk), which now also blocks a month from freezing — same as the
    // pending_external queue above. This test is about the year-end posting,
    // not about reconciliation, so it resolves them directly rather than
    // through decideMatch/closeRun's settlement path, which would book money
    // this test asserts nothing about.
    await database
      .update(schema.ledgerReconMatches)
      .set({ state: "confirmed", confirmedBy: "system:test-fixture", confirmedAt: Date.now() })
      .where(
        and(
          eq(schema.ledgerReconMatches.tenantId, seeded.tenantId),
          sql`${schema.ledgerReconMatches.state} in ('proposed','unmatched')`
        )
      );
    await database
      .update(schema.ledgerReconRuns)
      .set({ state: "closed", closedBy: "system:test-fixture", updatedAt: Date.now() })
      .where(
        and(eq(schema.ledgerReconRuns.tenantId, seeded.tenantId), sql`${schema.ledgerReconRuns.state} != 'closed'`)
      );

    const expected = ok(await call("controller", "GET", `/v1/ledger/year-end/${year}`));

    // Every month of the year has to be frozen, not only the current one.
    const periods = ok(await call("controller", "GET", "/v1/ledger/periods?limit=100"));
    const open = (periods.data as { code: string; state: string }[])
      .filter((p) => p.state === "open" && p.code.startsWith(`${year}-`))
      .map((p) => p.code)
      .sort();
    expect(open).toContain(period);
    for (const code of open) {
      const closed = await throughApproval("controller", "approver", "POST", `/v1/ledger/periods/${code}/close`, {
        to: "soft_closed"
      });
      expect(ok(closed).state).toBe("soft_closed");
    }

    const closed = await throughApproval("controller", "approver", "POST", `/v1/ledger/year-end/${year}`);
    expect(ok(closed, 201).txn.state).toBe("settled");

    const bs = ok(await call("controller", "GET", "/v1/ledger/reports/balance-sheet"));
    // Posted, not derived: the year's result now sits in 3100 and nothing is left over.
    expect(bs.equity.rows).toContainEqual(
      expect.objectContaining({ accountCode: "3100", amountMinor: expected.netMinor })
    );
    expect(bs.currentYearUnpostedMinor).toBe(0);
    expect(bs.balanced).toBe(true);
  });

  it("will not close the same year twice", async () => {
    const again = await call("controller", "POST", `/v1/ledger/year-end/${year}`);
    expect(again.status).toBe(409);
    expect(JSON.stringify(again.body)).toContain("already closed");
  });

  it("is not an analyst's act", async () => {
    const denied = await call("analyst", "POST", `/v1/ledger/year-end/${year - 1}`);
    expect(denied.status).toBe(403);
  });
});

describe("statement of cash flows (docs/19 §5.4, ADR-0090)", () => {
  it("answers IAS 7's indirect statement over the seeded book, and it reconciles", async () => {
    const cf = ok(await call("controller", "GET", `/v1/ledger/reports/cash-flow?from=0&to=${Date.now()}`));
    expect(cf.reconciled).toBe(true);
    expect(cf.openingCashMinor + cf.netIncreaseMinor + cf.fxEffectMinor).toBe(cf.closingCashMinor);
    expect(cf.operating.totalMinor + cf.investing.totalMinor + cf.financing.totalMinor).toBe(cf.netIncreaseMinor);
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await call("controller", "GET", "/v1/ledger/reports/cash-flow?from=2000&to=1000");
    expect(res.status).toBe(400);
  });
});

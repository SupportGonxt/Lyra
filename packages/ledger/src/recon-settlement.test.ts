import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { decideMatch, reconcile, closeRun } from "./recon.js";
import { accountStatement } from "./reports.js";
import { seedTestChart } from "./test-chart.js";

// docs/27 F19: "Insurer statement reconciliation posts nothing — `decideMatch`
// updates match state and never books the `CMSN-SETL` the spec promises."
// docs/19 §6: the insurer-statement process's *output* is "matched, variance,
// missing-both-ways queues; **`CMSN-SETL` postings**". A reconciliation that
// moves no money is a spreadsheet with an audit trail.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: {
      kind: "user",
      id: "u_test",
      tenantId: "t_test",
      grants: [{ roleKey: "owner", permissions: ["*:*:*"] }]
    },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
});

/** An accrual the insurer's statement will later pay. */
async function accrual(id: string, key: string, amountMinor: number): Promise<void> {
  await ctx.db.insert(schema.ledgerTxns).values({
    id,
    tenantId: ctx.tenantId,
    type: "CMSN-ACCR",
    version: 1,
    idempotencyKey: key,
    state: "settled",
    actorKind: "system",
    actorId: "sys",
    currency: "AED",
    baseCurrency: "AED",
    grossMinor: amountMinor,
    baseGrossMinor: amountMinor,
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000
  });
}

async function run(lines: { ref: string; ourRef: string; amountMinor: number }[]) {
  return reconcile(ctx, {
    process: "insurer",
    period: "2026-06",
    currency: "AED",
    counterpartyRef: "provider:falcon",
    lines: lines.map((l) => ({ ...l, currency: "AED" }))
  });
}

async function matchRow(ref: string) {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerReconMatches)
    .where(and(eq(schema.ledgerReconMatches.tenantId, ctx.tenantId), eq(schema.ledgerReconMatches.statementLineRef, ref)));
  return rows[0];
}

describe("docs/27 F19 — confirming an insurer match books CMSN-SETL", () => {
  it("clears the commission receivable into cash at the statement's amount", async () => {
    await accrual("tx_a", "stmt-a", 10_000);
    await run([{ ref: "L1", ourRef: "stmt-a", amountMinor: 9_950 }]);

    const m = await matchRow("L1");
    expect(m?.state).toBe("proposed"); // within tolerance, so a human decides
    await decideMatch(ctx, m?.id ?? "", "confirmed");

    const cash = await accountStatement(ctx, "1000");
    const receivable = await accountStatement(ctx, "1100");
    // The statement paid 9_950, so that is what clears and that is what arrives:
    // the 50 shortfall stays on the receivable as the variance it is, for a
    // controller to write off or chase. A recon must never invent the difference.
    expect(cash.closingMinor).toBe(9_950);
    expect(receivable.closingMinor).toBe(-9_950);
  });

  it("records the settlement on the match, so nothing has to be inferred", async () => {
    await accrual("tx_b", "stmt-b", 10_000);
    await run([{ ref: "L1", ourRef: "stmt-b", amountMinor: 9_950 }]);
    const m = await matchRow("L1");
    await decideMatch(ctx, m?.id ?? "", "confirmed");
    expect((await matchRow("L1"))?.settlementTxnId).toMatch(/^txn_/);
  });

  it("books nothing when the reviewer rejects", async () => {
    await accrual("tx_c", "stmt-c", 10_000);
    await run([{ ref: "L1", ourRef: "stmt-c", amountMinor: 9_950 }]);
    const m = await matchRow("L1");
    await decideMatch(ctx, m?.id ?? "", "rejected", "not_our_policy");
    expect((await accountStatement(ctx, "1000")).closingMinor).toBe(0);
    expect((await matchRow("L1"))?.settlementTxnId).toBeNull();
  });

  it("books nothing for a process that is not an insurer statement", async () => {
    // A client-money reconciliation proves segregation; it moves no money of
    // ours, and a posting here would be an invention (docs/19 §6).
    await ctx.db.insert(schema.ledgerTxns).values({
      id: "tx_cm",
      tenantId: ctx.tenantId,
      type: "CM-RECEIPT",
      version: 1,
      idempotencyKey: "cm-1",
      state: "settled",
      actorKind: "system",
      actorId: "sys",
      currency: "AED",
      baseCurrency: "AED",
      grossMinor: 5_000,
      baseGrossMinor: 5_000,
      createdAt: NOW - 1000,
      updatedAt: NOW - 1000
    });
    await reconcile(ctx, {
      process: "client_money",
      period: "2026-06",
      currency: "AED",
      lines: [{ ref: "C1", ourRef: "cm-1", amountMinor: 5_000, currency: "AED" }]
    });
    const m = await matchRow("C1");
    expect(m?.state).toBe("confirmed");
    expect((await accountStatement(ctx, "1000")).closingMinor).toBe(0);
  });

  it("closing the run books the settlements the deterministic pass confirmed itself", async () => {
    // An exact match needs no human, so it never reaches decideMatch — and if
    // only decideMatch posted, a perfectly clean statement would book nothing
    // at all, which is the defect wearing its best suit.
    await accrual("tx_d", "stmt-d", 10_000);
    const r = await run([{ ref: "L1", ourRef: "stmt-d", amountMinor: 10_000 }]);
    expect(r.state).toBe("closed");
    expect((await accountStatement(ctx, "1000")).closingMinor).toBe(10_000);
    expect((await matchRow("L1"))?.settlementTxnId).toMatch(/^txn_/);
  });

  // Regression: a run reaching `closed` announced nothing, so the seeded ops
  // webhook subscribed to `ledger.recon.completed` could never fire. A run
  // closes on one of two paths — the deterministic pass (clean statement) or
  // closeRun after review — and each says so exactly once.
  it("announces ledger.recon.completed once when a clean statement closes the run itself", async () => {
    await accrual("tx_f", "stmt-f", 10_000);
    const r = await run([{ ref: "L1", ourRef: "stmt-f", amountMinor: 10_000 }]);
    expect(r.state).toBe("closed");
    await closeRun(ctx, r.runId); // closing a closed run is not a second completion
    const events = (await ctx.db.select().from(schema.eventOutbox)).filter((e) => e.type === "ledger.recon.completed");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.envelopeJson).data).toMatchObject({ runId: r.runId, process: "insurer", period: "2026-06" });
  });

  it("announces ledger.recon.completed when a reviewed run is closed", async () => {
    await accrual("tx_g", "stmt-g", 10_000);
    const r = await run([{ ref: "L1", ourRef: "stmt-g", amountMinor: 9_950 }]);
    expect(r.state).toBe("review");
    expect((await ctx.db.select().from(schema.eventOutbox)).filter((e) => e.type === "ledger.recon.completed")).toHaveLength(0);
    await decideMatch(ctx, (await matchRow("L1"))?.id ?? "", "confirmed");
    await closeRun(ctx, r.runId);
    expect((await ctx.db.select().from(schema.eventOutbox)).filter((e) => e.type === "ledger.recon.completed")).toHaveLength(1);
  });

  it("is idempotent: closing a run twice books one settlement", async () => {
    await accrual("tx_e", "stmt-e", 10_000);
    await run([{ ref: "L1", ourRef: "stmt-e", amountMinor: 10_000 }]);
    await closeRun(ctx, (await matchRow("L1"))?.runId ?? "");
    expect((await accountStatement(ctx, "1000")).closingMinor).toBe(10_000);
    const settlements = await ctx.db
      .select()
      .from(schema.ledgerTxns)
      .where(and(eq(schema.ledgerTxns.tenantId, ctx.tenantId), eq(schema.ledgerTxns.type, "CMSN-SETL")));
    expect(settlements).toHaveLength(1);
  });
});

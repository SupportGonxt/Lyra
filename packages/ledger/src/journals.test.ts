import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, account, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { post } from "./posting.js";
import { runTxn } from "./txn.js";
import { closePeriod, ensurePeriod, reopenPeriod } from "./periods.js";
import { buildRecipe } from "./recipes.js";
import { TXN_PRECONDITIONS } from "./preconditions.js";
import { balanceSheet, yearEndPreview } from "./reports.js";
import { TXN_TYPES } from "./types.js";

// docs/27 F2 (no manual journal) and F3 (no equity accounts, so no year-end
// close). The two go together: an opening balance needs somewhere to put the
// other side, and that somewhere is 3xxx.
//
// docs/specs/gap-finance-design.md D5 is the load-bearing decision here —
// equity is *posted* from the first year-end close onward, so the balance
// sheet stops plugging retained earnings and starts reading them.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

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
    now: Date.UTC(2026, 5, 15, 12),
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function rejects(p: Promise<unknown>, detail: RegExp): Promise<void> {
  await expect(p).rejects.toThrow();
  try {
    await p;
  } catch (e) {
    expect((e as { detail?: string }).detail ?? String(e)).toMatch(detail);
  }
}

/** Two balanced lines that are legal in a manual journal. */
const OK_LINES = [
  { accountCode: "5400", side: "debit", amountMinor: 25_000 },
  { accountCode: "2100", side: "credit", amountMinor: 25_000 }
];
const REASON = "accrue the audit fee agreed in the June engagement letter";

describe("F3 — equity accounts", () => {
  it("puts 3000/3100/3200 in the chart as credit-normal equity", () => {
    for (const code of ["3000", "3100", "3200"]) {
      const a = account(code);
      expect(a, `account ${code} missing from the chart`).toBeDefined();
      expect(a?.type).toBe("equity");
      expect(a?.normalSide).toBe("credit");
      // Arabic is not optional: docs/21 and the RTL rule apply to the chart too.
      expect(a?.ar.length).toBeGreaterThan(0);
    }
  });
});

describe("F2 — manual journal recipe", () => {
  it("builds the lines it is given", () => {
    const lines = buildRecipe("MANUAL-JRNL", { lines: OK_LINES, reason: REASON });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountCode: "5400", side: "debit", amountMinor: 25_000 });
  });

  it("refuses a one-sided journal", () => {
    expect(() => buildRecipe("MANUAL-JRNL", { lines: [OK_LINES[0]], reason: REASON })).toThrow();
  });

  it("refuses an unbalanced journal", () => {
    const lines = [OK_LINES[0], { ...OK_LINES[1], amountMinor: 24_999 }];
    expect(() => buildRecipe("MANUAL-JRNL", { lines, reason: REASON })).toThrow();
  });

  // The one instrument that can express any entry is the one instrument that
  // must not be able to express a client-money entry (CBUAE segregation).
  it.each(["1010", "2010"])("refuses client-money account %s", (code) => {
    const lines = [
      { accountCode: code, side: "debit", amountMinor: 25_000 },
      { accountCode: "2100", side: "credit", amountMinor: 25_000 }
    ];
    expect(() => buildRecipe("MANUAL-JRNL", { lines, reason: REASON })).toThrow();
  });

  it("refuses to touch equity — that is what the year-end close is for", () => {
    const lines = [
      { accountCode: "5400", side: "debit", amountMinor: 25_000 },
      { accountCode: "3100", side: "credit", amountMinor: 25_000 }
    ];
    expect(() => buildRecipe("MANUAL-JRNL", { lines, reason: REASON })).toThrow();
  });

  it("refuses a reason nobody could audit", () => {
    expect(() => buildRecipe("MANUAL-JRNL", { lines: OK_LINES, reason: "fix" })).toThrow();
  });

  it("is a financial transaction gated by the orphaned ledger.manual_journal policy", () => {
    expect(TXN_TYPES["MANUAL-JRNL"]).toMatchObject({ financial: true, approval: "ledger.manual_journal" });
  });

  it("posts through runTxn once approved", async () => {
    const txn = await runTxn(
      ctx,
      { type: "MANUAL-JRNL", idempotencyKey: "mj-1", grossMinor: 25_000 },
      {
        recipe: { lines: buildRecipe("MANUAL-JRNL", { lines: OK_LINES, reason: REASON }), reason: REASON },
        args: { lines: OK_LINES, reason: REASON },
        preApproved: true
      }
    );
    expect(txn.state).toBe("settled");
    expect(txn.ledgerBatchId).toBeTruthy();
  });

  it("stops at the approval gate when nobody has approved it", async () => {
    await rejects(
      runTxn(
        ctx,
        { type: "MANUAL-JRNL", idempotencyKey: "mj-2", grossMinor: 25_000 },
        {
          recipe: { lines: buildRecipe("MANUAL-JRNL", { lines: OK_LINES, reason: REASON }), reason: REASON },
          args: { lines: OK_LINES, reason: REASON }
        }
      ),
      /ledger\.manual_journal/
    );
  });
});

describe("F3 — opening balance", () => {
  const OPENING = [
    { accountCode: "1000", side: "debit", amountMinor: 500_000 },
    { accountCode: "1010", side: "debit", amountMinor: 120_000 },
    { accountCode: "2010", side: "credit", amountMinor: 120_000 },
    { accountCode: "3000", side: "credit", amountMinor: 500_000 }
  ];

  // A migrating broker genuinely has a client-account balance and share capital
  // on day one; refusing both would make the ledger unusable on arrival.
  it("permits equity and client money, unlike a manual journal", () => {
    expect(buildRecipe("OPEN-BAL", { lines: OPENING, reason: "migration from the legacy ledger" })).toHaveLength(4);
    expect(() => buildRecipe("MANUAL-JRNL", { lines: OPENING, reason: "migration from the legacy ledger" })).toThrow();
  });

  it("still has to balance", () => {
    const lines = [...OPENING.slice(0, 3), { ...OPENING[3], amountMinor: 1 }];
    expect(() => buildRecipe("OPEN-BAL", { lines, reason: "migration from the legacy ledger" })).toThrow();
  });

  it("may only be posted once per tenant", async () => {
    const args = { lines: OPENING, reason: "migration from the legacy ledger" };
    await runTxn(
      ctx,
      { type: "OPEN-BAL", idempotencyKey: "ob-1", grossMinor: 500_000 },
      { recipe: { lines: buildRecipe("OPEN-BAL", args) }, args, preApproved: true }
    );
    await rejects(
      runTxn(
        ctx,
        { type: "OPEN-BAL", idempotencyKey: "ob-2", grossMinor: 500_000 },
        { recipe: { lines: buildRecipe("OPEN-BAL", args) }, args, preApproved: true }
      ),
      /opening balance/i
    );
  });
});

describe("F3 — year-end close", () => {
  /** A year of trading: revenue and one cost, posted inside 2025. */
  async function trade2025(): Promise<void> {
    await post(ctx, {
      txnId: "seed-1",
      currency: "AED",
      baseCurrency: "AED",
      postedAt: Date.UTC(2025, 2, 15),
      lines: [
        { accountCode: "1100", side: "debit", amountMinor: 900_000 },
        { accountCode: "4000", side: "credit", amountMinor: 900_000 }
      ]
    });
    await post(ctx, {
      txnId: "seed-2",
      currency: "AED",
      baseCurrency: "AED",
      postedAt: Date.UTC(2025, 2, 15),
      lines: [
        { accountCode: "5400", side: "debit", amountMinor: 350_000 },
        { accountCode: "2100", side: "credit", amountMinor: 350_000 }
      ]
    });
  }

  it("previews the closing entry from the year's income and expense", async () => {
    await trade2025();
    const preview = await yearEndPreview(ctx, 2025);
    expect(preview.incomeMinor).toBe(900_000);
    expect(preview.expenseMinor).toBe(350_000);
    expect(preview.netMinor).toBe(550_000);
    expect(preview.retainedEarningsAccount).toBe("3100");
    // Income carries a credit balance, so closing it is a debit; expense the reverse.
    expect(preview.closingLines).toContainEqual(
      expect.objectContaining({ accountCode: "4000", side: "debit", amountMinor: 900_000 })
    );
    expect(preview.closingLines).toContainEqual(
      expect.objectContaining({ accountCode: "5400", side: "credit", amountMinor: 350_000 })
    );
  });

  it("puts the residual on retained earnings and balances by construction", async () => {
    await trade2025();
    const preview = await yearEndPreview(ctx, 2025);
    const lines = buildRecipe("YEAR-END-CLOSE", {
      closingLines: preview.closingLines,
      retainedEarningsAccount: preview.retainedEarningsAccount,
      fiscalYear: 2025
    });
    const debit = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
    const credit = lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);
    expect(debit).toBe(credit);
    expect(lines).toContainEqual(
      expect.objectContaining({ accountCode: "3100", side: "credit", amountMinor: 550_000 })
    );
  });

  it("refuses to close anything that is not income or expense", () => {
    expect(() =>
      buildRecipe("YEAR-END-CLOSE", {
        closingLines: [{ accountCode: "1100", side: "credit", amountMinor: 900_000 }],
        retainedEarningsAccount: "3100",
        fiscalYear: 2025
      })
    ).toThrow();
  });

  it("refuses to close a fiscal year that still has an open month", async () => {
    await trade2025();
    const guard = TXN_PRECONDITIONS["YEAR-END-CLOSE"];
    expect(guard).toBeDefined();
    await rejects(guard!(ctx, { fiscalYear: 2025 }), /2025-03/);

    await closePeriod(ctx, "2025-03", "soft_closed", { preApproved: true });
    await expect(guard!(ctx, { fiscalYear: 2025 })).resolves.toBeUndefined();
  });

  it("refuses a second close of the same year under a different key", async () => {
    await trade2025();
    await closePeriod(ctx, "2025-03", "soft_closed", { preApproved: true });
    const preview = await yearEndPreview(ctx, 2025);
    const args = {
      closingLines: preview.closingLines,
      retainedEarningsAccount: preview.retainedEarningsAccount,
      fiscalYear: 2025
    };
    const run = (key: string): Promise<unknown> =>
      runTxn(
        ctx,
        { type: "YEAR-END-CLOSE", idempotencyKey: key, grossMinor: preview.netMinor },
        { recipe: { lines: buildRecipe("YEAR-END-CLOSE", args), periodCode: "2025-12" }, args, preApproved: true }
      );
    await run("yearend:2025");
    await rejects(run("yearend:2025-again"), /2025/);
  });
});

describe("F3 — the balance sheet stops plugging equity", () => {
  async function trade2025(): Promise<void> {
    await post(ctx, {
      txnId: "seed-1",
      currency: "AED",
      baseCurrency: "AED",
      postedAt: Date.UTC(2025, 2, 15),
      lines: [
        { accountCode: "1100", side: "debit", amountMinor: 900_000 },
        { accountCode: "4000", side: "credit", amountMinor: 900_000 }
      ]
    });
  }

  it("labels the unposted current-year result before the first close", async () => {
    await trade2025();
    const bs = await balanceSheet(ctx);
    expect(bs.balanced).toBe(true);
    expect(bs.currentYearUnpostedMinor).toBe(900_000);
    expect(bs.equity.rows).toHaveLength(0);
    expect(bs.equityMinor).toBe(900_000);
  });

  it("reads equity off the ledger once the year is closed", async () => {
    await trade2025();
    await closePeriod(ctx, "2025-03", "soft_closed", { preApproved: true });
    const preview = await yearEndPreview(ctx, 2025);
    const args = {
      closingLines: preview.closingLines,
      retainedEarningsAccount: preview.retainedEarningsAccount,
      fiscalYear: 2025
    };
    await runTxn(
      ctx,
      { type: "YEAR-END-CLOSE", idempotencyKey: "yearend:2025", grossMinor: preview.netMinor },
      { recipe: { lines: buildRecipe("YEAR-END-CLOSE", args), periodCode: "2025-12" }, args, preApproved: true }
    );

    const bs = await balanceSheet(ctx);
    expect(bs.balanced).toBe(true);
    // The plug is gone: the number now comes from a posted 3100 line.
    expect(bs.currentYearUnpostedMinor).toBe(0);
    expect(bs.equity.rows).toContainEqual(expect.objectContaining({ accountCode: "3100", amountMinor: 900_000 }));
    expect(bs.equityMinor).toBe(900_000);
  });
});

/**
 * docs/27 "thin screens": reconciliation had no instrument for the residual it
 * is guaranteed to produce. What is asserted here is the shape of the one it has
 * now — balanced both ways, refusing the two account families a write-off must
 * never reach, and gated always.
 */
describe("reconciliation write-off", () => {
  const REASON_WO = "insurer statement rounds premium tax; 42 fils left on the receivable";

  it("clears the residual off the clearing account and into the write-off expense", () => {
    const lines = buildRecipe("RECON-WRITEOFF", { amountMinor: 42, direction: "shortfall", reason: REASON_WO });
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "5510", side: "debit", amountMinor: 42 }),
      expect.objectContaining({ accountCode: "1100", side: "credit", amountMinor: 42 })
    ]);
  });

  it("runs the other way when the counterparty overpaid", () => {
    const lines = buildRecipe("RECON-WRITEOFF", {
      amountMinor: 42,
      direction: "surplus",
      clearingAccount: "1300",
      reason: REASON_WO
    });
    expect(lines).toEqual([
      expect.objectContaining({ accountCode: "1300", side: "debit", amountMinor: 42 }),
      expect.objectContaining({ accountCode: "5510", side: "credit", amountMinor: 42 })
    ]);
  });

  // A client-money shortfall is a reportable breach (CBUAE), so writing it off
  // would leave 1010 < 2010 with the journal saying everything was fine.
  it.each(["1010", "2010"])("refuses client-money account %s", (code) => {
    expect(() =>
      buildRecipe("RECON-WRITEOFF", { amountMinor: 42, direction: "shortfall", clearingAccount: code, reason: REASON_WO })
    ).toThrow();
  });

  it("refuses to touch equity, and refuses an unknown clearing account", () => {
    expect(() =>
      buildRecipe("RECON-WRITEOFF", { amountMinor: 42, direction: "shortfall", clearingAccount: "3100", reason: REASON_WO })
    ).toThrow();
    expect(() =>
      buildRecipe("RECON-WRITEOFF", { amountMinor: 42, direction: "shortfall", clearingAccount: "9999", reason: REASON_WO })
    ).toThrow();
  });

  it("refuses a reason nobody could audit, and a zero amount", () => {
    expect(() => buildRecipe("RECON-WRITEOFF", { amountMinor: 42, direction: "shortfall", reason: "typo" })).toThrow();
    expect(() => buildRecipe("RECON-WRITEOFF", { amountMinor: 0, direction: "shortfall", reason: REASON_WO })).toThrow();
  });

  it("is financial, gated by ledger.write_off, and never auto-approvable", async () => {
    expect(TXN_TYPES["RECON-WRITEOFF"]).toMatchObject({ financial: true, approval: "ledger.write_off" });
    const args = { amountMinor: 42, direction: "shortfall", reason: REASON_WO };
    await rejects(
      runTxn(
        ctx,
        { type: "RECON-WRITEOFF", idempotencyKey: "wo-gate", grossMinor: 42 },
        { recipe: { lines: buildRecipe("RECON-WRITEOFF", args), reason: REASON_WO }, args }
      ),
      /ledger\.write_off/
    );
  });

  it("posts once approved, and replays the same key as a no-op", async () => {
    const args = { amountMinor: 42, direction: "shortfall", reason: REASON_WO };
    const opts = {
      recipe: { lines: buildRecipe("RECON-WRITEOFF", args), reason: REASON_WO },
      args,
      preApproved: true
    };
    const txn = await runTxn(ctx, { type: "RECON-WRITEOFF", idempotencyKey: "wo-1", grossMinor: 42 }, opts);
    expect(txn.state).toBe("settled");
    expect(txn.ledgerBatchId).toBeTruthy();

    const again = await runTxn(ctx, { type: "RECON-WRITEOFF", idempotencyKey: "wo-1", grossMinor: 42 }, opts);
    expect(again.id).toBe(txn.id);
    expect(again.ledgerBatchId).toBe(txn.ledgerBatchId);
  });
});

describe("D10 — closing a period is itself an approved act", () => {
  const FORCE_REASON = "accepting the known torn batch from the March migration";

  it("gates a forced close on ledger.period_close_force", async () => {
    const p = await ensurePeriod(ctx, "2025-04");
    // docs/27 F20: a force over a month with nothing wrong is now refused before
    // the gate is reached, so the break has to be real for the gate to be what
    // is under test. A header that disagrees with its lines is the cheapest one.
    await ctx.db.insert(schema.ledgerJournalBatches).values({
      id: "bat_torn_d10",
      tenantId: ctx.tenantId,
      txnId: "txn_torn_d10",
      periodId: p.id,
      currency: "AED",
      baseCurrency: "AED",
      fxRatePpm: 1_000_000,
      totalDebitMinor: 100,
      totalCreditMinor: 100,
      baseTotalDebitMinor: 100,
      baseTotalCreditMinor: 100,
      postedBy: "user:u_test",
      postedAt: ctx.now
    });
    await rejects(
      closePeriod(ctx, "2025-04", "soft_closed", { force: true, reason: FORCE_REASON }),
      /ledger\.period_close_force/
    );
  });

  it("gates a reopen on ledger.period_reopen", async () => {
    const reason = "reopening for the late insurer statement";
    await closePeriod(ctx, "2025-04", "soft_closed", { preApproved: true });
    await rejects(reopenPeriod(ctx, "2025-04", { reason }), /ledger\.period_reopen/);
    const p = await reopenPeriod(ctx, "2025-04", { reason, preApproved: true });
    expect(p.state).toBe("open");
  });
});

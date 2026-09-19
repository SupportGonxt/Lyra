import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { PolicyJson, EntitlementsJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { balanceOf, post, reverse } from "./posting.js";
import { openTxn, reverseTxn, runSaga, runTxn, transition } from "./txn.js";
import { closeChecks, closePeriod, ensurePeriod, periodCode } from "./periods.js";
import { RECIPES, argFields, buildRecipe } from "./recipes.js";
import { clientMoneyPosition, rebuildBalances, trialBalance } from "./reports.js";
import { valueFlow, valueFlowLines, type MoneyMap } from "./money-map.js";
import { closeRun, decideMatch, reconSummary, reconcile } from "./recon.js";
import { TXN_TYPES, autoApprovable } from "./types.js";

// docs/19 §11. These are the invariants that may not be relaxed to make a test
// pass. Everything runs against a real migrated SQLite engine, not a mock,
// because half of what is being asserted here is enforced by an index.

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

async function freshCtx(): Promise<Ctx> {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  return {
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
}

beforeEach(async () => {
  ctx = await freshCtx();
});

/**
 * AppError carries the human-readable title as `message` and the specific cause
 * as `detail`, so asserting on `toThrow(/…/)` would only ever test the title.
 */
async function rejects(p: Promise<unknown>, detail: RegExp): Promise<void> {
  await expect(p).rejects.toThrow();
  try {
    await p;
  } catch (e) {
    expect((e as { detail?: string }).detail ?? String(e)).toMatch(detail);
  }
}

/* ------------------------------------------------------------- generators */

/** Deterministic PRNG: a failing seed is reproducible, unlike Math.random(). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const FINANCIAL = Object.values(TXN_TYPES).filter((t) => t.financial && RECIPES[t.code]);

/** Plausible arguments for any recipe, driven by the seed. */
function argsFor(code: string, r: () => number): Record<string, unknown> {
  const amount = 1 + Math.floor(r() * 500_000);
  const tax = Math.floor(amount * 0.05);
  const channel = Math.floor((amount - tax) * r() * 0.5);
  const commission = { grossMinor: amount, taxMinor: tax, channelMinor: channel };
  const spec = RECIPES[code];
  if (!spec) throw new Error(`no recipe ${code}`);
  // Probe the schema rather than branching per code: whichever shape parses is
  // the shape the recipe wants.
  const shapes: Record<string, unknown>[] = [
    commission,
    { ...commission, amountMinor: amount },
    { amountMinor: amount, feeMinor: Math.floor(amount * 0.02) },
    { amountMinor: amount, withholdingMinor: Math.floor(amount * 0.05) },
    { amountMinor: amount },
    { netMinor: amount, taxMinor: tax },
    // Authored entries (docs/27 F2, F3): the caller supplies the lines, so the
    // generator has to as well. Last, so no derived recipe matches these first.
    {
      lines: [
        { accountCode: "5400", side: "debit", amountMinor: amount },
        { accountCode: "2100", side: "credit", amountMinor: amount }
      ],
      reason: "fuzzed authored entry for the balance invariant"
    },
    { closingLines: [{ accountCode: "4000", side: "debit", amountMinor: amount }], fiscalYear: 2025 },
    // A write-off states its direction and its reason; nothing above carries
    // either, so it sits last and matches only itself.
    { amountMinor: amount, direction: "shortfall", reason: "fuzzed reconciliation residual" }
  ];
  for (const s of shapes) {
    if (spec.schema.safeParse({ ...spec.defaults, ...s }).success) return s;
  }
  throw new Error(`no generator shape fits ${code}`);
}

/* ---------------------------------------------------------------- §11.1 */

describe("every journal batch balances in both currencies", () => {
  it("holds for every financial transaction type, fuzzed", async () => {
    const r = rng(20260615);
    expect(FINANCIAL.length).toBeGreaterThan(20);

    for (const def of FINANCIAL) {
      for (let i = 0; i < 3; i++) {
        const lines = buildRecipe(def.code, argsFor(def.code, r));
        const debit = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
        const credit = lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);
        expect(debit, `${def.code} txn currency`).toBe(credit);

        const txnId = `tx_${def.code}_${i}`;
        await ctx.db.insert(schema.ledgerTxns).values(baseTxn(txnId, def.code, debit));
        const batch = await post(ctx, {
          txnId,
          currency: "AED",
          baseCurrency: "USD",
          // A non-unit rate is the case where base-currency balance is not free.
          fxRatePpm: 272_300,
          lines
        });
        expect(batch.totalMinor).toBe(debit);

        const rows = await ctx.db
          .select()
          .from(schema.ledgerJournalLines)
          .where(eq(schema.ledgerJournalLines.batchId, batch.batchId));
        const baseDebit = rows.filter((l) => l.side === "debit").reduce((s, l) => s + l.baseAmountMinor, 0);
        const baseCredit = rows.filter((l) => l.side === "credit").reduce((s, l) => s + l.baseAmountMinor, 0);
        expect(baseDebit, `${def.code} base currency`).toBe(baseCredit);
      }
    }
  });
});

function baseTxn(txnId: string, type: string, gross: number) {
  return {
    id: txnId,
    tenantId: "t_test",
    type,
    idempotencyKey: `k_${txnId}`,
    state: "authorized",
    actorKind: "user",
    actorId: "u_test",
    currency: "AED",
    baseCurrency: "USD",
    grossMinor: gross,
    baseGrossMinor: gross,
    createdAt: Date.UTC(2026, 5, 15, 12),
    updatedAt: Date.UTC(2026, 5, 15, 12)
  };
}

/* ---------------------------------------------------------------- §11.2 */

describe("client money segregation", () => {
  it("1010 >= 2010 after any random sequence of client-money transactions", async () => {
    const r = rng(7);
    const ops = ["CM-RECEIPT", "PREM-REMIT", "CM-TRANSFER"] as const;
    let held = 0;

    for (let i = 0; i < 60; i++) {
      const op = ops[Math.floor(r() * ops.length)] ?? "CM-RECEIPT";
      const amount = 1 + Math.floor(r() * 100_000);
      let args: Record<string, unknown>;
      if (op === "CM-RECEIPT") {
        args = { amountMinor: amount };
      } else if (held <= 0) {
        continue;
      } else if (op === "PREM-REMIT") {
        args = { amountMinor: Math.min(amount, held) };
      } else {
        const gross = Math.min(amount, held);
        args = { amountMinor: gross, grossMinor: gross, taxMinor: 0, channelMinor: 0 };
      }

      const txnId = `tx_cm_${i}`;
      await ctx.db.insert(schema.ledgerTxns).values(baseTxn(txnId, op, amount));
      await post(ctx, { txnId, currency: "AED", lines: buildRecipe(op, args) });

      held += op === "CM-RECEIPT" ? amount : -(args.amountMinor as number);

      const asset = await balanceOf(ctx, "1010", "AED");
      const liability = await balanceOf(ctx, "2010", "AED");
      expect(asset.balanceMinor, `after ${op} #${i}`).toBeGreaterThanOrEqual(liability.balanceMinor);
    }

    const [position] = await clientMoneyPosition(ctx, "AED");
    expect(position?.breach).toBe(false);
    expect(position?.surplusMinor).toBe(0);
  });

  it("refuses a posting that would take client money below the liability", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_in", "CM-RECEIPT", 10_000));
    await post(ctx, { txnId: "tx_in", currency: "AED", lines: buildRecipe("CM-RECEIPT", { amountMinor: 10_000 }) });

    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_bad", "PREM-REMIT", 5_000));
    // Draining the asset without releasing the liability is the breach shape.
    await rejects(
      post(ctx, {
        txnId: "tx_bad",
        currency: "AED",
        lines: [
          { accountCode: "1000", side: "debit", amountMinor: 5_000 },
          { accountCode: "1010", side: "credit", amountMinor: 5_000 }
        ]
      }),
      /client money/i
    );

    const alarms = await ctx.db
      .select()
      .from(schema.ledgerClientMoneyChecks)
      .where(eq(schema.ledgerClientMoneyChecks.breach, true));
    expect(alarms.length, "a breach must leave an alarm row behind").toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------------- §11.3 */

describe("no journal debits client-money assets to credit income or expense", () => {
  it("rejects the illegal shape directly", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_x", "CM-RECEIPT", 1_000));
    await rejects(
      post(ctx, {
        txnId: "tx_x",
        currency: "AED",
        lines: [
          { accountCode: "1010", side: "debit", amountMinor: 1_000 },
          { accountCode: "4000", side: "credit", amountMinor: 1_000 }
        ]
      }),
      /CM-TRANSFER/
    );
  });

  it("no recipe in the catalogue produces the illegal shape", () => {
    const r = rng(99);
    for (const def of FINANCIAL) {
      const lines = buildRecipe(def.code, argsFor(def.code, r));
      const debitsClientMoney = lines.some((l) => l.side === "debit" && l.accountCode === "1010");
      const creditsPnl = lines.some((l) => l.side === "credit" && /^[45]/.test(l.accountCode));
      expect(debitsClientMoney && creditsPnl, def.code).toBe(false);
    }
  });

  it("allows CM-TRANSFER, which debits the liability rather than the asset", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_r", "CM-RECEIPT", 100_000));
    await post(ctx, { txnId: "tx_r", currency: "AED", lines: buildRecipe("CM-RECEIPT", { amountMinor: 100_000 }) });

    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_t", "CM-TRANSFER", 10_000));
    const batch = await post(ctx, {
      txnId: "tx_t",
      currency: "AED",
      lines: buildRecipe("CM-TRANSFER", { amountMinor: 10_000, grossMinor: 10_000, taxMinor: 500, channelMinor: 2_000 })
    });
    expect(batch.lineCount).toBeGreaterThanOrEqual(5);

    // Channel's share became a payable at the moment of earning, not later.
    const payable = await balanceOf(ctx, "2100", "AED");
    expect(payable.balanceMinor).toBe(2_000);
    const income = await balanceOf(ctx, "4000", "AED");
    expect(income.balanceMinor).toBe(7_500);
  });
});

/* ---------------------------------------------------------------- §11.4 */

describe("idempotency", () => {
  it("replaying a transaction with the same key posts nothing new", async () => {
    const recipe = { lines: buildRecipe("CMSN-ACCR", { grossMinor: 50_000, taxMinor: 2_500, channelMinor: 10_000 }) };
    const input = { type: "CMSN-ACCR", idempotencyKey: "idem-1", currency: "AED", grossMinor: 50_000 };

    const first = await runTxn(ctx, input, { recipe, preApproved: true });
    const second = await runTxn(ctx, input, { recipe, preApproved: true });
    expect(second.id).toBe(first.id);
    expect(second.state).toBe("settled");

    const batches = await ctx.db.select().from(schema.ledgerJournalBatches);
    expect(batches).toHaveLength(1);
    const lines = await ctx.db.select().from(schema.ledgerJournalLines);
    expect(lines).toHaveLength(4);

    const income = await balanceOf(ctx, "4000", "AED");
    expect(income.balanceMinor).toBe(37_500);
  });

  it("a second batch for the same transaction is a conflict, not a duplicate", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_d", "CMSN-ACCR", 1_000));
    const lines = buildRecipe("CMSN-ACCR", { grossMinor: 1_000 });
    await post(ctx, { txnId: "tx_d", currency: "AED", lines });
    await rejects(post(ctx, { txnId: "tx_d", currency: "AED", lines }), /already has a posted batch/);
  });
});

/* ---------------------------------------------------------------- §11.5 */

describe("reversal", () => {
  it("returns net-zero economics and leaves the original intact", async () => {
    const original = await runTxn(
      ctx,
      { type: "CMSN-ACCR", idempotencyKey: "rev-1", currency: "AED", grossMinor: 80_000 },
      { recipe: { lines: buildRecipe("CMSN-ACCR", { grossMinor: 80_000, taxMinor: 4_000, channelMinor: 16_000 }) }, preApproved: true }
    );

    const before = await ctx.db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.txnId, original.id));
    const { original: after, reversal } = await reverseTxn(ctx, original.id, "customer cancelled in cooling-off");

    expect(after.state).toBe("reversed");
    expect(reversal.state).toBe("settled");

    const stillThere = await ctx.db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.txnId, original.id));
    expect(stillThere).toEqual(before);

    for (const code of ["1100", "4000", "2100", "2200"]) {
      const b = await balanceOf(ctx, code, "AED");
      expect(b.balanceMinor, `${code} after reversal`).toBe(0);
    }

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
  });

  it("refuses to reverse the same batch twice", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_o", "CMSN-ACCR", 1_000));
    const batch = await post(ctx, { txnId: "tx_o", currency: "AED", lines: buildRecipe("CMSN-ACCR", { grossMinor: 1_000 }) });
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_c1", "CMSN-ACCR", 1_000));
    await reverse(ctx, batch.batchId, { txnId: "tx_c1", reason: "error" });
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_c2", "CMSN-ACCR", 1_000));
    await rejects(reverse(ctx, batch.batchId, { txnId: "tx_c2", reason: "again" }), /already reversed/i);
  });

  it("nets to zero even when FX left a rounding residual", async () => {
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_fx", "CMSN-ACCR", 33_333));
    const batch = await post(ctx, {
      txnId: "tx_fx",
      currency: "AED",
      baseCurrency: "USD",
      fxRatePpm: 272_294,
      lines: buildRecipe("CMSN-ACCR", { grossMinor: 33_333, taxMinor: 1_111, channelMinor: 7_777 })
    });
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_fxr", "CMSN-ACCR", 33_333));
    await reverse(ctx, batch.batchId, { txnId: "tx_fxr", reason: "fx residual check" });

    const tb = await trialBalance(ctx);
    expect(tb.balanced).toBe(true);
    for (const row of tb.rows) expect(row.balanceMinor, row.accountCode).toBe(0);
  });
});

/* --------------------------------------------------- state machine & saga */

describe("transaction state machine", () => {
  it("refuses an illegal transition", async () => {
    const t = await openTxn(ctx, { type: "CMSN-ACCR", idempotencyKey: "sm-1", currency: "AED" });
    await expect(transition(ctx, t.id, "settled")).rejects.toThrow();
  });

  it("a failed step unwinds the ones before it", async () => {
    const t = await openTxn(ctx, { type: "CMSN-ACCR", idempotencyKey: "saga-1", currency: "AED" });
    const undone: string[] = [];
    await expect(
      runSaga(ctx, t.id, [
        { name: "reserve", run: async () => "r1", compensate: async () => void undone.push("reserve") },
        { name: "charge", run: async () => "c1", compensate: async () => void undone.push("charge") },
        {
          name: "notify",
          run: async () => {
            throw new Error("provider down");
          }
        }
      ])
    ).rejects.toThrow("provider down");

    expect(undone).toEqual(["charge", "reserve"]);
    const steps = await ctx.db.select().from(schema.ledgerSagaSteps).where(eq(schema.ledgerSagaSteps.txnId, t.id));
    expect(steps).toHaveLength(3);
  });
});

/* ------------------------------------------------------ periods & reports */

describe("periods", () => {
  // Every caller today hands it `ctx.now` (traced: post/reverse in posting.ts,
  // routes/ledger.ts, routes/me.ts), so this is the seam, not a live bug —
  // `periodCode` is exported from @lyra/ledger and `post` takes a caller's
  // `postedAt`. Unguarded, an instant no `Date` can hold left a `RangeError:
  // Invalid time value` mid-post, with a half-written batch behind it and
  // nothing in the message about which value was wrong.
  it("refuses an instant no Date can hold rather than throwing RangeError", () => {
    // `badRequest`'s message is "Bad request"; the value is in `detail`.
    for (const bad of [9e15, Number.NaN]) {
      try {
        periodCode(bad);
        expect.unreachable(`periodCode accepted ${bad}`);
      } catch (e) {
        expect((e as { detail?: string }).detail).toMatch(/not an instant a Date can hold/);
      }
    }
  });

  it("blocks a posting into a hard-closed period unless it is a contra batch", async () => {
    const code = periodCode(ctx.now);
    await ensurePeriod(ctx, code);
    await closePeriod(ctx, code, "soft_closed", { preApproved: true });
    await closePeriod(ctx, code, "hard_closed", { preApproved: true });

    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_late", "CMSN-ACCR", 1_000));
    await rejects(
      post(ctx, { txnId: "tx_late", currency: "AED", lines: buildRecipe("CMSN-ACCR", { grossMinor: 1_000 }) }),
      /hard closed/
    );
  });

  it("will not hard close straight from open", async () => {
    const code = periodCode(ctx.now);
    await ensurePeriod(ctx, code);
    await rejects(closePeriod(ctx, code, "hard_closed"), /soft closed/);
  });

  it("refuses to close over a batch that disagrees with its own lines", async () => {
    // Damage from before posting was atomic still sits in the table. Freezing a
    // month over it would make the tear permanent and unexplained.
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_torn", "CMSN-ACCR", 1_000));
    await post(ctx, { txnId: "tx_torn", currency: "AED", lines: buildRecipe("CMSN-ACCR", { grossMinor: 1_000 }) });
    const [line] = await ctx.db.select().from(schema.ledgerJournalLines).limit(1);
    await ctx.db.delete(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.id, line!.id));

    await rejects(closePeriod(ctx, periodCode(ctx.now), "soft_closed"), /batches_match_lines/);
  });
});

describe("reports", () => {
  it("the balances cache agrees with a rebuild from lines", async () => {
    const r = rng(4242);
    for (const [i, def] of FINANCIAL.slice(0, 12).entries()) {
      const txnId = `tx_rb_${i}`;
      const lines = buildRecipe(def.code, argsFor(def.code, r));
      const gross = lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
      await ctx.db.insert(schema.ledgerTxns).values(baseTxn(txnId, def.code, gross));
      await post(ctx, { txnId, currency: "AED", lines });
    }
    const drift = (await rebuildBalances(ctx)).filter((d) => d.drifted);
    expect(drift).toEqual([]);
  });
});

/* ------------------------------------------------------------ money map */

describe("money map", () => {
  /**
   * docs/22 §1.2. One period of the aggregator's actual shape: premium arrives,
   * most of it goes to the insurer, a slice is drawn as commission and splits
   * into partner share, tax and net. The two trailing postings are the control
   * group — a partner accrual on 5400 and an output tax credit on 2200 that
   * belong to no premium — because the failure this test exists to catch is a
   * map that sums an account and calls it a flow.
   */
  async function postPeriod(): Promise<void> {
    const seq: [string, string, number, Record<string, unknown>][] = [
      ["tx_mm_1", "CM-RECEIPT", 100_000, { amountMinor: 100_000 }],
      ["tx_mm_2", "PREM-COLLECT", 50_000, { amountMinor: 50_000 }],
      ["tx_mm_3", "PREM-REMIT", 90_000, { amountMinor: 90_000 }],
      [
        "tx_mm_4",
        "CM-TRANSFER",
        20_000,
        { amountMinor: 20_000, grossMinor: 20_000, channelMinor: 5_000, taxMinor: 1_000 }
      ],
      ["tx_mm_5", "RSHARE-ACCR", 3_000, { amountMinor: 3_000 }],
      ["tx_mm_6", "SUB-INVOICE", 8_400, { netMinor: 8_000, taxMinor: 400 }]
    ];
    for (const [txnId, type, gross, args] of seq) {
      await ctx.db.insert(schema.ledgerTxns).values(baseTxn(txnId, type, gross));
      await post(ctx, { txnId, currency: "AED", lines: buildRecipe(type, args) });
    }
  }

  function amount(map: MoneyMap, key: string): number | undefined {
    return map.nodes.find((n) => n.key === key)?.amountMinor;
  }

  function link(map: MoneyMap, from: string, to: string): number | undefined {
    return map.links.find((l) => l.from === from && l.to === to)?.amountMinor;
  }

  it("attributes each flow to a transaction type, not to an account movement", async () => {
    await postPeriod();
    const map = await valueFlow(ctx, { periodCode: "2026-06", currency: "AED" });

    expect(amount(map, "premium-in")).toBe(150_000);
    expect(amount(map, "insurer-remittance")).toBe(90_000);
    expect(amount(map, "commission-retained")).toBe(20_000);
    expect(amount(map, "partner-share")).toBe(5_000);
    // 1_000 from the transfer, not 1_400: the invoice's output tax is tax the
    // business owes, but it is not a slice of anybody's premium.
    expect(amount(map, "tax")).toBe(1_000);
    expect(amount(map, "net")).toBe(14_000);
    expect(amount(map, "still-held")).toBe(40_000);
  });

  it("conserves — every node's inflow equals what leaves it", async () => {
    await postPeriod();
    const map = await valueFlow(ctx, { periodCode: "2026-06", currency: "AED" });

    expect(link(map, "premium-in", "insurer-remittance")).toBe(90_000);
    expect(link(map, "premium-in", "commission-retained")).toBe(20_000);
    expect(link(map, "premium-in", "still-held")).toBe(40_000);
    expect(link(map, "commission-retained", "partner-share")).toBe(5_000);
    expect(link(map, "commission-retained", "tax")).toBe(1_000);
    expect(link(map, "commission-retained", "net")).toBe(14_000);

    for (const node of ["premium-in", "commission-retained"]) {
      const out = map.links.filter((l) => l.from === node).reduce((s, l) => s + l.amountMinor, 0);
      expect(out, `${node} conserves`).toBe(amount(map, node));
    }
    expect(map.carriedMinor).toBe(40_000);
  });

  it("drops the still-held ribbon when the period paid out more than it took in", async () => {
    // Premium collected last month, remitted this one. The remainder is
    // negative, which is a fact about the period, not an error — but a
    // negative ribbon would draw a flow that never happened.
    await ctx.db.insert(schema.ledgerTxns).values(baseTxn("tx_prior", "CM-RECEIPT", 60_000));
    await post(ctx, {
      txnId: "tx_prior",
      currency: "AED",
      lines: buildRecipe("CM-RECEIPT", { amountMinor: 60_000 })
    });
    await ctx.db.insert(schema.ledgerTxns).values({
      ...baseTxn("tx_late_remit", "PREM-REMIT", 60_000),
      createdAt: Date.UTC(2026, 6, 3),
      updatedAt: Date.UTC(2026, 6, 3)
    });
    await post(ctx, {
      txnId: "tx_late_remit",
      currency: "AED",
      lines: buildRecipe("PREM-REMIT", { amountMinor: 60_000 }),
      postedAt: Date.UTC(2026, 6, 3)
    });

    const july = await valueFlow(ctx, { periodCode: "2026-07", currency: "AED" });
    expect(amount(july, "premium-in")).toBe(0);
    expect(amount(july, "insurer-remittance")).toBe(60_000);
    expect(july.carriedMinor).toBe(-60_000);
    expect(amount(july, "still-held")).toBe(0);
    expect(link(july, "premium-in", "still-held")).toBeUndefined();
  });

  it("hands every node the filter that reproduces it in the journals", async () => {
    await postPeriod();
    const map = await valueFlow(ctx, { periodCode: "2026-06", currency: "AED" });

    const premium = map.nodes.find((n) => n.key === "premium-in");
    expect(premium?.drill).toEqual({
      accountCodes: ["1010"],
      side: "debit",
      txnTypes: ["CM-RECEIPT", "PREM-COLLECT", "PREM-INSTALMENT"]
    });
    // still-held is a remainder, not a query — nothing to drill into.
    expect(map.nodes.find((n) => n.key === "still-held")?.drill).toBeUndefined();
    for (const node of map.nodes) {
      if (!node.drill) continue;
      expect(node.drill.accountCodes.length, `${node.key} names its accounts`).toBeGreaterThan(0);
      expect(node.drill.txnTypes.length, `${node.key} names its types`).toBeGreaterThan(0);
    }
  });

  it("opens a node onto the lines that add up to it, and nothing else", async () => {
    await postPeriod();
    const map = await valueFlow(ctx, { periodCode: "2026-06", currency: "AED" });

    for (const node of map.nodes) {
      if (!node.drill) continue;
      const drilled = await valueFlowLines(ctx, {
        periodCode: "2026-06",
        node: node.key,
        currency: "AED"
      });
      expect(drilled.totalMinor, `${node.key} ties to its lines`).toBe(node.amountMinor);
    }

    // The one that would break if the drill filtered on account alone: the
    // subscription invoice credits 2200 too, and it is not premium tax.
    const tax = await valueFlowLines(ctx, { periodCode: "2026-06", node: "tax", currency: "AED" });
    expect(tax.lines).toHaveLength(1);
    expect(tax.lines[0]).toMatchObject({ txnId: "tx_mm_4", accountCode: "2200", side: "credit" });
  });

  it("refuses a node that has no lines of its own", async () => {
    await rejects(valueFlowLines(ctx, { periodCode: "2026-06", node: "still-held" }), /still-held/);
  });
});

/* ------------------------------------------------------- reconciliation */

describe("reconciliation", () => {
  it("matches exactly, within tolerance, and leaves the rest for a human", async () => {
    for (const [i, amount] of [10_000, 20_050, 30_000].entries()) {
      const txnId = `tx_rc_${i}`;
      await ctx.db.insert(schema.ledgerTxns).values({
        ...baseTxn(txnId, "CMSN-ACCR", amount),
        idempotencyKey: `stmt-${i}`,
        state: "settled"
      });
    }

    const result = await reconcile(ctx, {
      process: "insurer",
      period: "2026-06",
      currency: "AED",
      lines: [
        { ref: "L1", ourRef: "stmt-0", amountMinor: 10_000, currency: "AED" },
        { ref: "L2", ourRef: "stmt-1", amountMinor: 20_100, currency: "AED" },
        { ref: "L3", ourRef: "nothing-of-ours", amountMinor: 999, currency: "AED" }
      ]
    });

    expect(result.matched).toBe(2);
    expect(result.unmatchedStatementRefs).toEqual(["L3"]);
    expect(result.unmatchedTxnIds).toEqual(["tx_rc_2"]);
    expect(result.state).toBe("review");

    const matches = await ctx.db.select().from(schema.ledgerReconMatches);
    const exact = matches.find((m) => m.statementLineRef === "L1");
    expect(exact?.method).toBe("deterministic");
    expect(exact?.state).toBe("confirmed");
    const near = matches.find((m) => m.statementLineRef === "L2");
    expect(near?.method).toBe("tolerance");
    // Anything with a delta stays a proposal — a variance is a decision, not a match.
    expect(near?.state).toBe("proposed");
    expect(near?.deltaMinor).toBe(50);
  });

  it("client money reconciles at zero tolerance", async () => {
    await ctx.db.insert(schema.ledgerTxns).values({
      ...baseTxn("tx_cm_r", "CM-RECEIPT", 5_000),
      idempotencyKey: "cm-1",
      state: "settled"
    });
    const result = await reconcile(ctx, {
      process: "client_money",
      period: "2026-06",
      currency: "AED",
      lines: [{ ref: "C1", ourRef: "cm-1", amountMinor: 5_001, currency: "AED" }]
    });
    expect(result.matched).toBe(0);
  });

  it("closes only once every open match has been decided, and names the closer", async () => {
    await ctx.db.insert(schema.ledgerTxns).values({
      ...baseTxn("tx_close", "CMSN-ACCR", 7_000),
      idempotencyKey: "close-1",
      state: "settled"
    });
    const result = await reconcile(ctx, {
      process: "insurer",
      period: "2026-06",
      currency: "AED",
      lines: [
        { ref: "K1", ourRef: "close-1", amountMinor: 7_000, currency: "AED" },
        { ref: "K2", ourRef: "nothing-of-ours", amountMinor: 120, currency: "AED" }
      ]
    });
    expect(result.state).toBe("review");

    // The straggler is open, so the run may not close. There is no force flag:
    // rejecting it with a reason is the only way through.
    await rejects(closeRun(ctx, result.runId), /open matches/);

    const open = (await ctx.db.select().from(schema.ledgerReconMatches)).filter(
      (m) => m.state === "proposed" || m.state === "unmatched"
    );
    expect(open).toHaveLength(1);
    for (const m of open) await decideMatch(ctx, m.id, "rejected", "not_ours");

    await closeRun(ctx, result.runId);
    const summary = await reconSummary(ctx, result.runId);
    expect(summary.state).toBe("closed");
    expect(summary.open).toBe(0);

    const [run] = await ctx.db
      .select()
      .from(schema.ledgerReconRuns)
      .where(eq(schema.ledgerReconRuns.id, result.runId));
    // A human close and a system close are different facts about the same run.
    expect(run?.closedBy).toBe("user:u_test");
  });
});

/* ---------------------------------------------------------- the catalogue */

describe("catalogue", () => {
  it("every financial transaction type has a posting recipe", () => {
    const missing = Object.values(TXN_TYPES)
      .filter((t) => t.financial && !RECIPES[t.code])
      .map((t) => t.code);
    expect(missing).toEqual([]);
  });

  it("every payout type is gated by an approval policy", () => {
    // Money leaving needs a policy. Money arriving does not — refusing a
    // customer's premium because nobody approved it would be the worse failure.
    for (const t of Object.values(TXN_TYPES)) {
      if (t.payout) expect(t.approval, `${t.code} must be gated`).toBeTruthy();
    }
  });

  it("no payout or client-money type is auto-approvable", () => {
    for (const t of Object.values(TXN_TYPES)) {
      if (t.payout || t.clientMoney) expect(autoApprovable(t.code), t.code).toBe(false);
    }
  });
});

/* --------------------------------------------------------- §5 atomicity */

/**
 * A ctx on a real migrated database whose driver can be made to fail the write
 * set *after* the engine has applied part of it — the only honest way to model
 * "the process went away mid-post". `poison` appends a statement SQLite will
 * refuse to the end of every batch, so everything before it has already been
 * applied inside the transaction when it dies; if the write is not atomic, the
 * damage survives. `batches` counts trips through the atomic path so a test can
 * tell one batch from a sequence of statements.
 */
async function armedCtx(
  opts: { poison?: boolean } = {}
): Promise<{ ctx: Ctx; batches: () => number; disarm: () => void }> {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);

  let batchCalls = 0;
  let poison = opts.poison === true;
  const trapped = new Proxy(client, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv);
      if (typeof value !== "function") return value;
      if (prop !== "batch") return (value as (...a: unknown[]) => unknown).bind(target);
      return (stmts: unknown[], ...rest: unknown[]) => {
        batchCalls += 1;
        const armed = poison
          ? [...stmts, { sql: `insert into "ledger_journal_batches" ("id") values (null)`, args: [] }]
          : stmts;
        return (value as (...a: unknown[]) => unknown).apply(target, [armed, ...rest]);
      };
    }
  });

  const base = await freshCtx();
  return {
    ctx: { ...base, db: drizzle(trapped) as unknown as Ctx["db"] },
    batches: () => batchCalls,
    disarm: () => {
      poison = false;
    }
  };
}

const TWO_LINES = [
  { accountCode: "1000", side: "debit" as const, amountMinor: 5_000 },
  { accountCode: "4000", side: "credit" as const, amountMinor: 5_000 }
];

describe("a posting is one write or none", () => {
  it("hands its whole write set to the driver at once", async () => {
    const { ctx: armed, batches } = await armedCtx();
    await post(armed, { txnId: "txn_batched", currency: "AED", lines: TWO_LINES });
    expect(batches()).toBe(1);
  });

  it("leaves nothing behind when the write dies part-way through", async () => {
    // The header carries the unique index on (tenant, txn). An orphan header
    // burns the transaction id: the retry is refused as a duplicate and the
    // money is gone with no way to re-post it. The balance cache matters for
    // the same reason from the other side — closeChecks reads it for
    // trial_balance_zero, so a half-applied bump makes the trial balance
    // disagree with the lines it summarises.
    const { ctx: armed } = await armedCtx({ poison: true });
    await expect(post(armed, { txnId: "txn_torn", currency: "AED", lines: TWO_LINES })).rejects.toThrow();

    expect(await armed.db.select().from(schema.ledgerJournalBatches)).toHaveLength(0);
    expect(await armed.db.select().from(schema.ledgerJournalLines)).toHaveLength(0);
    expect(await armed.db.select().from(schema.ledgerAccountBalances)).toHaveLength(0);
  });

  it("still accepts the retry after a write that died", async () => {
    // The point of all-or-nothing: the transaction id is not burned, so the
    // caller can simply post again.
    const { ctx: armed, disarm } = await armedCtx({ poison: true });
    await post(armed, { txnId: "txn_retry", currency: "AED", lines: TWO_LINES }).catch(() => undefined);

    disarm();
    await post(armed, { txnId: "txn_retry", currency: "AED", lines: TWO_LINES });
    expect(await armed.db.select().from(schema.ledgerJournalBatches)).toHaveLength(1);
  });
});

// A close check's detail is read by the controller who has to clear it, and
// "1 transactions still waiting on a provider" reads as a broken ledger rather
// than one stuck payment.
describe("close check details", () => {
  const detailOf = (checks: Awaited<ReturnType<typeof closeChecks>>, name: string) =>
    checks.find((c) => c.name.startsWith(name))?.detail;

  it("counts one stuck transaction in the singular", async () => {
    const code = periodCode(ctx.now);
    await openTxn(ctx, { type: "CMSN-ACCR", idempotencyKey: "stuck-1", currency: "AED" });
    await ctx.db.update(schema.ledgerTxns).set({ state: "pending_external" });

    expect(detailOf(await closeChecks(ctx, code), "no_pending_external")).toBe(
      "1 transaction still waiting on a provider"
    );
  });

  it("counts two in the plural", async () => {
    const code = periodCode(ctx.now);
    await openTxn(ctx, { type: "CMSN-ACCR", idempotencyKey: "stuck-1", currency: "AED" });
    await openTxn(ctx, { type: "CMSN-ACCR", idempotencyKey: "stuck-2", currency: "AED" });
    await ctx.db.update(schema.ledgerTxns).set({ state: "pending_external" });

    expect(detailOf(await closeChecks(ctx, code), "no_pending_external")).toBe(
      "2 transactions still waiting on a provider"
    );
  });
});

// docs/ui.md §7 P3-16: a controller opening a transaction should not be
// writing JSON. The recipe schemas stay private; what they publish is a flat
// field list the UI can render as inputs.
describe("recipe argument fields", () => {
  it("names each argument, its kind and whether it must be given", () => {
    const fields = argFields("CM-RECEIPT");
    expect(fields).toEqual([
      { name: "amountMinor", kind: "integer", required: true },
      { name: "memo", kind: "text", required: false }
    ]);
  });

  it("carries the recipe's own default so the form shows the account it will post to", () => {
    const fields = argFields("FEE-BROK");
    expect(fields.find((f) => f.name === "incomeAccount")).toEqual({
      name: "incomeAccount",
      kind: "text",
      required: false,
      default: "4020"
    });
  });

  it("leaves free-form dimensions out — they are not a form field", () => {
    expect(argFields("PAYOUT-INSTRUCT").map((f) => f.name)).not.toContain("dims");
  });

  it("says nothing for a type that posts no journal", () => {
    expect(argFields("NOTE")).toEqual([]);
  });

  it("publishes fields for every financial type, and every field is renderable", () => {
    for (const code of Object.keys(RECIPES)) {
      const fields = argFields(code);
      expect(fields.length, code).toBeGreaterThan(0);
      for (const f of fields) expect(["integer", "text"], `${code}.${f.name}`).toContain(f.kind);
    }
  });

  it("offers a closed set as a closed set", () => {
    const direction = argFields("RECON-WRITEOFF").find((f) => f.name === "direction");
    expect(direction).toEqual({
      name: "direction",
      kind: "text",
      required: true,
      options: ["shortfall", "surplus"]
    });
  });

  /**
   * The inverse guard. `argFields` answers by probing, so it can only describe
   * the shapes it was shown a sample of — and a *required* argument it cannot
   * describe is a transaction type the generic open-transaction screen can
   * never post, silently. This partitions every required key into published or
   * excluded-for-a-named-reason and requires the leftover bucket to be empty.
   */
  it("publishes every argument a recipe requires, or names why it cannot", () => {
    // Authored entries hand the ledger whole journal lines; no flat input can
    // ask for those, which is why each has its own screen (F2, F3).
    const STRUCTURED = new Set(["lines", "closingLines"]);
    const undescribed: string[] = [];
    for (const [code, spec] of Object.entries(RECIPES)) {
      const shape = (spec.schema as unknown as { shape: Record<string, { safeParse(v: unknown): { success: boolean } }> }).shape;
      const published = new Set(argFields(code).map((f) => f.name));
      for (const [name, field] of Object.entries(shape)) {
        if (name === "dims" || STRUCTURED.has(name)) continue;
        const required = !field.safeParse(undefined).success;
        if (required && !published.has(name)) undescribed.push(`${code}.${name}`);
      }
    }
    expect(undescribed).toEqual([]);
  });
});

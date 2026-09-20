import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, account, schema } from "@lyra/db";
import { APPROVAL_POLICIES, needsDualControl, type Ctx } from "@lyra/core";
import { RECIPES, buildRecipe } from "./recipes.js";
import { TXN_TYPES, autoApprovable } from "./types.js";
import { post } from "./posting.js";
import { runSaga, runTxn, reverseTxn } from "./txn.js";
import { clientMoneyPosition, trialBalance } from "./reports.js";
import { straightLine, assertWithinInvoice, recognitionHeadroom } from "./recognition.js";

// docs/19 §11 — the eleven test obligations, as **property** tests.
//
// docs/27 F22: "Four of the ten mandated property obligations are untested, and
// the tests are seeded-LCG fuzz, not property tests — fast-check is not a
// dependency." The distinction matters more than it sounds. A seeded LCG walks
// one fixed path through the input space and reports "no counterexample on this
// path"; a property test searches, and when it finds one it *shrinks* it to the
// smallest input that still fails, which is the difference between a red build
// you can read and a red build you have to bisect. It also records its own
// counterexamples, so a rare failure reproduces instead of evaporating.
//
// CLAUDE.md §12: these invariants may not be relaxed to make a test pass.
//
// Obligations 6, 9, 10 and 11 had no test of any kind before this file.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const SQL = statements();
const NOW = Date.UTC(2026, 5, 15, 12);

async function freshCtx(): Promise<Ctx> {
  const client = createClient({ url: ":memory:" });
  for (const sql of SQL) await client.execute(sql);
  return {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_prop",
    actor: { kind: "user", id: "u_prop", tenantId: "t_prop", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_prop",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
}

/**
 * Each DB-backed property migrates a fresh SQLite for every run, which costs
 * about a second. `runs` is therefore tuned per property rather than globally:
 * enough to search, few enough that the suite stays a thing people run.
 */
const DB_RUNS = { numRuns: 12 } as const;
const PURE_RUNS = { numRuns: 300 } as const;

/* --------------------------------------------------------- the generators */

const minor = fc.integer({ min: 1, max: 5_000_000 });
const ppm = fc.integer({ min: 1, max: 5_000_000 });

const FINANCIAL = Object.values(TXN_TYPES).filter((t) => t.financial && RECIPES[t.code]);

/**
 * Arguments that fit whichever recipe a type uses, found by probing the schema
 * rather than by a switch on the code: the generator then cannot drift away
 * from the catalogue when a type is added.
 */
function argsFor(code: string, amount: number, split: number): Record<string, unknown> | null {
  const spec = RECIPES[code];
  if (!spec) return null;
  const tax = Math.floor(amount * 0.05);
  const channel = Math.min(split, amount - tax);
  const commission = { grossMinor: amount, taxMinor: tax, channelMinor: Math.max(channel, 0) };
  const shapes: Record<string, unknown>[] = [
    commission,
    { ...commission, amountMinor: amount },
    { amountMinor: amount, feeMinor: Math.floor(amount * 0.02) },
    { amountMinor: amount, withholdingMinor: Math.floor(amount * 0.05) },
    { amountMinor: amount },
    { netMinor: amount, taxMinor: tax },
    {
      lines: [
        { accountCode: "5400", side: "debit", amountMinor: amount },
        { accountCode: "2100", side: "credit", amountMinor: amount }
      ],
      reason: "property-test authored entry for the balance invariant"
    },
    { closingLines: [{ accountCode: "4000", side: "debit", amountMinor: amount }], fiscalYear: 2025 },
    { adjustments: [{ accountCode: "1100", deltaMinor: amount, currency: "USD" }] },
    // A write-off states its direction and its reason; nothing above carries
    // either, so it sits here and matches only itself.
    { amountMinor: amount, direction: "shortfall", reason: "property-test reconciliation residual" },
    // A takaful surplus distribution: only `surplusMinor` is required, every
    // account defaulted, so this is the shape that fits it and nothing earlier.
    { surplusMinor: amount }
  ];
  for (const s of shapes) {
    if (spec.schema.safeParse({ ...spec.defaults, ...s }).success) return s;
  }
  return null;
}

const debits = (ls: readonly { side: string; amountMinor: number }[]) =>
  ls.filter((l) => l.side === "debit").reduce((s, l) => s + l.amountMinor, 0);
const credits = (ls: readonly { side: string; amountMinor: number }[]) =>
  ls.filter((l) => l.side === "credit").reduce((s, l) => s + l.amountMinor, 0);

async function openTxnRow(ctx: Ctx, id: string, type: string, currency = "AED"): Promise<void> {
  await ctx.db.insert(schema.ledgerTxns).values({
    id,
    tenantId: ctx.tenantId,
    type,
    version: 1,
    idempotencyKey: id,
    state: "settled",
    actorKind: "system",
    actorId: "sys",
    currency,
    baseCurrency: "AED",
    grossMinor: 0,
    baseGrossMinor: 0,
    createdAt: NOW,
    updatedAt: NOW
  });
}

/* ------------------------------------------------------------ obligation 1 */

describe("1 — every journal batch balances in both currencies", () => {
  it("holds for every financial type, at every amount, at every rate", async () => {
    const ctx = await freshCtx();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...FINANCIAL.map((t) => t.code)),
        minor,
        minor,
        ppm,
        async (code, amount, split, ratePpm) => {
          const args = argsFor(code, amount, split);
          if (!args) return; // a type whose shape no generator fits is a catalogue bug, caught below
          let built;
          try {
            built = buildRecipe(code, args);
          } catch {
            return; // a refused *argument* is not a broken invariant
          }
          expect(debits(built)).toBe(credits(built));

          // And in base currency, which is the half a recipe cannot promise:
          // per-line conversion rounds, so `post()` has to place the residual.
          const txnId = `txn_${code}_${amount}_${ratePpm}`.replace(/[^\w]/g, "_");
          await openTxnRow(ctx, txnId, code);
          const batch = await post(ctx, {
            txnId,
            currency: "AED",
            baseCurrency: "USD",
            fxRatePpm: ratePpm,
            lines: built
          }).catch(() => null);
          if (!batch) return;
          const rows = await ctx.db
            .select()
            .from(schema.ledgerJournalLines)
            .where(and(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId), eq(schema.ledgerJournalLines.batchId, batch.batchId)));
          const baseDebit = rows.filter((r) => r.side === "debit").reduce((s, r) => s + r.baseAmountMinor, 0);
          const baseCredit = rows.filter((r) => r.side === "credit").reduce((s, r) => s + r.baseAmountMinor, 0);
          expect(baseDebit).toBe(baseCredit);
        }
      ),
      DB_RUNS
    );
  }, 120_000);

  it("the generator covers the whole catalogue — a type it cannot fit is the bug", () => {
    const unfitted = FINANCIAL.filter((t) => argsFor(t.code, 10_000, 1_000) === null).map((t) => t.code);
    expect(unfitted).toEqual([]);
  });
});

/* ------------------------------------------------------------ obligation 2 */

const CLIENT_MONEY_TYPES = ["CM-RECEIPT", "PREM-COLLECT", "CLAIM-FUND", "RECOVERY-RECEIPT"] as const;
const CLIENT_MONEY_OUT = ["PREM-REMIT", "CLAIM-PAY", "RECOVERY-REMIT"] as const;

describe("2 — 1010 >= 2010 after any sequence of client-money transactions", () => {
  it("holds under any interleaving of receipts and remittances", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.constantFrom(...CLIENT_MONEY_TYPES, ...CLIENT_MONEY_OUT),
            fc.integer({ min: 1, max: 100_000 })
          ),
          { minLength: 1, maxLength: 8 }
        ),
        async (steps) => {
          const ctx = await freshCtx();
          for (const [i, [code, amount]] of steps.entries()) {
            const txnId = `txn_cm_${i}`;
            await openTxnRow(ctx, txnId, code);
            // A remittance that would overdraw the client account must be
            // refused, not absorbed: that refusal is the invariant working.
            await post(ctx, {
              txnId,
              currency: "AED",
              fxRatePpm: 1_000_000,
              lines: buildRecipe(code, { amountMinor: amount })
            }).catch(() => undefined);
          }
          for (const p of await clientMoneyPosition(ctx)) {
            expect(p.assetMinor).toBeGreaterThanOrEqual(p.liabilityMinor);
            expect(p.breach).toBe(false);
          }
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

/* ------------------------------------------------------------ obligation 3 */

describe("3 — no journal debits a client-money asset to credit income or expense", () => {
  it("no recipe in the catalogue can be argued into the illegal shape", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FINANCIAL.map((t) => t.code)), minor, minor, (code, amount, split) => {
        const args = argsFor(code, amount, split);
        if (!args) return;
        let built;
        try {
          built = buildRecipe(code, args);
        } catch {
          return;
        }
        const debitsClientMoney = built.some(
          (l) => l.side === "debit" && account(l.accountCode)?.clientMoney && account(l.accountCode)?.type === "asset"
        );
        if (!debitsClientMoney) return;
        expect(built.filter((l) => l.side === "credit" && /^[45]/.test(l.accountCode))).toEqual([]);
      }),
      PURE_RUNS
    );
  });
});

/* ------------------------------------------------------------ obligation 4 */

describe("4 — replaying a transaction with the same idempotency key posts nothing new", () => {
  it("holds for any type and any number of replays", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("CMSN-ACCR", "CM-RECEIPT", "MEDIA-SPEND", "SUB-INVOICE"),
        minor,
        fc.integer({ min: 2, max: 5 }),
        async (code, amount, replays) => {
          const ctx = await freshCtx();
          const args = argsFor(code, amount, 0);
          if (!args) return;
          for (let i = 0; i < replays; i++) {
            await runTxn(
              ctx,
              { type: code, idempotencyKey: "replay-me", currency: "AED", grossMinor: amount },
              { recipe: { lines: buildRecipe(code, args), currency: "AED" }, preApproved: true }
            );
          }
          const txns = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
          const batches = await ctx.db
            .select()
            .from(schema.ledgerJournalBatches)
            .where(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId));
          expect(txns).toHaveLength(1);
          expect(batches).toHaveLength(1);
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

/* ------------------------------------------------------------ obligation 5 */

describe("5 — reversal is net-zero and leaves the original intact", () => {
  it("holds at any amount and any fx rate", async () => {
    await fc.assert(
      fc.asyncProperty(minor, ppm, async (amount, ratePpm) => {
        const ctx = await freshCtx();
        // A rate small enough to round a line's base amount to zero is refused
        // by post() — correctly, since a zero base amount is not a conversion,
        // it is a loss of the line. The invariant here is about reversing what
        // actually posted, so a refused posting is out of scope rather than a
        // counterexample. (The property found this; it is the engine being
        // right, not the engine being wrong.)
        const original = await runTxn(
          ctx,
          { type: "CMSN-ACCR", idempotencyKey: `rev-${amount}`, currency: "AED", grossMinor: amount },
          {
            recipe: { lines: buildRecipe("CMSN-ACCR", { grossMinor: amount }), currency: "AED", fxRatePpm: ratePpm },
            preApproved: true
          }
        ).catch(() => null);
        if (!original) return;
        await reverseTxn(ctx, original.id, "property test reversal");

        const tb = await trialBalance(ctx);
        // Net-zero economics: every account is back to nothing, in base currency.
        for (const row of tb.rows) expect(row.balanceMinor).toBe(0);
        // …and the original still exists, untouched, with its own batch.
        const rows = await ctx.db
          .select()
          .from(schema.ledgerJournalBatches)
          .where(and(eq(schema.ledgerJournalBatches.tenantId, ctx.tenantId), eq(schema.ledgerJournalBatches.txnId, original.id)));
        expect(rows).toHaveLength(1);
        expect(rows[0]?.reversalOfBatchId).toBeNull();
      }),
      DB_RUNS
    );
  }, 120_000);
});

/* ------------------------------------------------------------ obligation 6 */

describe("6 — every payout has an approval with a distinct approver above threshold", () => {
  const PAYOUTS = Object.values(TXN_TYPES).filter((t) => t.payout);

  it("every payout type names an approval policy", () => {
    expect(PAYOUTS.filter((t) => !t.approval).map((t) => t.code)).toEqual([]);
  });

  it("that policy demands a second pair of eyes above its threshold, and when no amount is stated", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PAYOUTS.map((t) => t.code)),
        fc.option(fc.integer({ min: 0, max: 100_000_000 }), { nil: undefined }),
        (code, amountMinor) => {
          const policy = APPROVAL_POLICIES[TXN_TYPES[code]?.approval ?? ""];
          expect(policy, code).toBeDefined();
          const threshold = policy?.defaultThresholdMinor ?? 0;
          // docs/19 §7 is explicit that a refund at or below the tenant's
          // threshold takes a single approver; the obligation is about
          // *above* threshold. `undefined` is the case that matters most —
          // an amount the caller could not state may be any amount, so the
          // predicate has to fail closed.
          if (amountMinor === undefined || amountMinor >= threshold) {
            expect(needsDualControl(policy!, amountMinor), `${code} @ ${String(amountMinor)}`).toBe(true);
          }
        }
      ),
      PURE_RUNS
    );
  });

  it("and no tenant setting can turn one into a one-click action", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAYOUTS.map((t) => t.code)), (code) => {
        expect(autoApprovable(code), code).toBe(false);
        expect(APPROVAL_POLICIES[TXN_TYPES[code]?.approval ?? ""]?.neverAutoApprove, code).toBe(true);
      }),
      PURE_RUNS
    );
  });
});

/* ------------------------------------------------------------ obligation 7 */

describe("7 — a saga interrupted at any step ends settled or fully compensated", () => {
  it("compensates exactly the steps that ran, in reverse, whichever step fails", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (stepCount, rawFailAt) => {
          const ctx = await freshCtx();
          const failAt = rawFailAt >= stepCount ? -1 : rawFailAt; // -1 = nothing fails
          const done: number[] = [];
          const undone: number[] = [];
          const steps = Array.from({ length: stepCount }, (_, i) => ({
            name: `step-${i}`,
            run: async () => {
              if (i === failAt) throw new Error(`step ${i} failed`);
              done.push(i);
            },
            compensate: async () => {
              undone.push(i);
            }
          }));

          const outcome = await runSaga(ctx, `saga-${stepCount}-${rawFailAt}`, steps).then(
            () => "settled" as const,
            () => "failed" as const
          );

          if (outcome === "settled") {
            expect(done).toEqual(steps.map((_, i) => i));
            expect(undone).toEqual([]);
          } else {
            // Partial success is impossible: everything that ran was undone,
            // and in reverse — a compensation order that is not the mirror of
            // the run order undoes a step whose precondition is already gone.
            expect([...undone].sort()).toEqual([...done].sort());
            expect(undone).toEqual([...done].reverse());
          }
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

/* ------------------------------------------------------------ obligation 8 */

describe("8 — the trial balance equals the sum of all journal lines at any point", () => {
  it("holds after any sequence of postings, at any moment in it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom("CMSN-ACCR", "MEDIA-SPEND", "CM-RECEIPT", "SUB-INVOICE"), minor), {
          minLength: 1,
          maxLength: 6
        }),
        async (steps) => {
          const ctx = await freshCtx();
          for (const [i, [code, amount]] of steps.entries()) {
            const args = argsFor(code, amount, 0);
            if (!args) continue;
            const txnId = `txn_tb_${i}`;
            await openTxnRow(ctx, txnId, code);
            await post(ctx, {
              txnId,
              currency: "AED",
              fxRatePpm: 1_000_000,
              lines: buildRecipe(code, args)
            }).catch(() => undefined);

            // Checked after *every* step, not only at the end: "at any point in
            // time" is what the obligation says, and a ledger that is only
            // right when you stop looking is not right.
            const tb = await trialBalance(ctx);
            const lines = await ctx.db
              .select()
              .from(schema.ledgerJournalLines)
              .where(eq(schema.ledgerJournalLines.tenantId, ctx.tenantId));
            expect(tb.totalDebitMinor).toBe(
              lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.baseAmountMinor, 0)
            );
            expect(tb.totalCreditMinor).toBe(
              lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.baseAmountMinor, 0)
            );
            expect(tb.balanced).toBe(true);
          }
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

/* ------------------------------------------------------------ obligation 9 */

describe("9 — recognition schedules never recognise more than invoiced", () => {
  it("a straight-line schedule sums to exactly the invoice, never a fils more", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 120 }), (net, periods) => {
        const plan = straightLine(net, periods);
        expect(plan).toHaveLength(periods);
        expect(plan.reduce((s, n) => s + n, 0)).toBe(net);
        for (const n of plan) expect(n).toBeGreaterThanOrEqual(0);
      }),
      PURE_RUNS
    );
  });

  it("every prefix of a schedule is within the invoice, so an early stop is safe", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 120 }), (net, periods) => {
        let released = 0;
        for (const amount of straightLine(net, periods)) {
          released += amount;
          expect(released).toBeLessThanOrEqual(net);
        }
      }),
      PURE_RUNS
    );
  });

  it("the ceiling refuses any release that would cross it, however it is reached", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (invoicedMinor, alreadyRecognisedMinor, amountMinor) => {
          const c = { invoicedMinor, alreadyRecognisedMinor, amountMinor };
          if (recognitionHeadroom(c) < 0) {
            expect(() => assertWithinInvoice(c)).toThrow();
          } else {
            expect(() => assertWithinInvoice(c)).not.toThrow();
          }
        }
      ),
      PURE_RUNS
    );
  });

  it("and the recipe enforces it, so no caller can route around the check", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 100_000 }), (invoiced, over) => {
        expect(() =>
          buildRecipe("SUB-RECOG", {
            amountMinor: invoiced + over,
            invoicedMinor: invoiced,
            alreadyRecognisedMinor: 0
          })
        ).toThrow();
      }),
      PURE_RUNS
    );
  });
});

/* ----------------------------------------------------------- obligation 10 */

describe("10 — SUCCESS-FEE cannot post without a verified metric snapshot", () => {
  it("refuses every unverified reference, and accepts only a verified one", async () => {
    await fc.assert(
      fc.asyncProperty(
        minor,
        fc.oneof(
          fc.constant(null), // no reference at all
          fc.constant("nsp_missing"), // a reference to nothing
          fc.constant("nsp_unverified"), // computed, never attested
          fc.constant("nsp_other_tenant"), // real, verified, someone else's
          fc.constant("nsp_verified")
        ),
        async (amount, ref) => {
          const ctx = await freshCtx();
          const snap = (id: string, tenantId: string, verified: boolean) => ({
            id,
            tenantId,
            metricKey: "gwp",
            grain: "month",
            period: "2026-05",
            dimsHash: id,
            value: 1,
            ts: NOW - 1,
            ...(verified ? { verifiedAt: NOW - 1, verifiedBy: "user:auditor" } : {})
          });
          await ctx.db.insert(schema.northSnapshots).values([
            snap("nsp_unverified", ctx.tenantId, false),
            snap("nsp_verified", ctx.tenantId, true),
            snap("nsp_other_tenant", "t_someone_else", true)
          ]);

          const args = {
            netMinor: amount,
            taxMinor: 0,
            ...(ref ? { metricSnapshotId: ref } : {})
          };
          const run = runTxn(
            ctx,
            { type: "SUCCESS-FEE", idempotencyKey: `sf-${amount}`, currency: "AED", grossMinor: amount },
            { recipe: { lines: buildRecipe("SUCCESS-FEE", args), currency: "AED" }, args, preApproved: true }
          );

          if (ref === "nsp_verified") {
            expect((await run).state).toBe("settled");
          } else {
            await expect(run).rejects.toThrow();
            // A precondition is a "not yet", so a refusal leaves no trace to
            // burn the idempotency key on.
            const rows = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));
            expect(rows).toEqual([]);
          }
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

/* ----------------------------------------------------------- obligation 11 */

describe("11 — a claim float never goes negative", () => {
  it("sum of CLAIM-PAY never exceeds sum of CLAIM-FUND, under any ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(fc.constantFrom("CLAIM-FUND", "CLAIM-PAY"), fc.integer({ min: 1, max: 50_000 })),
          { minLength: 1, maxLength: 10 }
        ),
        async (steps) => {
          const ctx = await freshCtx();
          let funded = 0;
          let paid = 0;
          for (const [i, [code, amount]] of steps.entries()) {
            const txnId = `txn_claim_${i}`;
            await openTxnRow(ctx, txnId, code);
            const posted = await post(ctx, {
              txnId,
              currency: "AED",
              fxRatePpm: 1_000_000,
              lines: buildRecipe(code, { amountMinor: amount })
            }).then(
              () => true,
              () => false
            );
            if (!posted) continue;
            if (code === "CLAIM-FUND") funded += amount;
            else paid += amount;
            // Checked at every step: a float that only balances at the end of
            // the sequence was negative somewhere in the middle, and that is
            // the moment a payment would have bounced.
            expect(paid).toBeLessThanOrEqual(funded);
          }
          const [position] = await clientMoneyPosition(ctx);
          if (position) expect(position.assetMinor).toBeGreaterThanOrEqual(0);
        }
      ),
      DB_RUNS
    );
  }, 120_000);
});

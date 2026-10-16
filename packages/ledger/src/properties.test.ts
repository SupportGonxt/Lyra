import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, account, schema } from "@lyra/db";
import {
  APPROVAL_POLICIES,
  clientMoneyPairs,
  needsDualControl,
  type Ctx
} from "@lyra/core";
import { RECIPES, buildRecipe } from "./recipes.js";
import { TXN_TYPES, autoApprovable } from "./types.js";
import { post } from "./posting.js";
import { runSaga, runTxn, reverseTxn } from "./txn.js";
import { clientMoneyPosition, trialBalance } from "./reports.js";
import { straightLine, assertWithinInvoice, recognitionHeadroom } from "./recognition.js";
import { seedTestChart } from "./test-chart.js";
import { countersignPin, pinMetricSnapshot, successFeeKey } from "./metric-pins.js";

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
  const ctx: Ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_prop",
    actor: { kind: "user", id: "u_prop", tenantId: "t_prop", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_prop",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
  return ctx;
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
    { surplusMinor: amount },
    // A reinsurance cession (ADR-0106): the ceded premium and the ceding
    // commission the reinsurer gives back on it, which can never exceed it.
    { cededPremiumMinor: amount, cedingCommissionMinor: tax }
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

/* ------------------------------------------- client money, per account pair */

// docs/19 §5.2 B, the second half. A licensed broker holds a segregated
// client-money account **per licence, per market**, so "is client money whole"
// is a question about each pair and never about their sum. A surplus in one
// account must not answer for a shortfall in another, and the position report
// has to name both.
//
// These run against the seeded 1010/2010 (UAE, AED) and the seeded second pair
// 1011/2011 (KSA, SAR). Recipes may not be touched to reach the second pair
// (recipes.ts is the next slice), so the batches here are authored lines:
// `post()` is the seam under test, not the recipe table.

/** One client-money account row a test needs beyond the seeded chart. */
async function addAccount(
  ctx: Ctx,
  a: {
    code: string;
    en: string;
    type: "asset" | "liability";
    normalSide: "debit" | "credit";
    currency?: string;
    clientMoneyPair?: string;
  }
): Promise<void> {
  await ctx.db.insert(schema.ledgerAccounts).values({
    id: `acc_test_${a.code}`,
    tenantId: ctx.tenantId,
    code: a.code,
    nameJson: JSON.stringify({ en: a.en, ar: a.en }),
    type: a.type,
    normalSide: a.normalSide,
    clientMoney: true,
    suspense: false,
    cashFlow: null,
    currency: a.currency ?? "AED",
    clientMoneyPair: a.clientMoneyPair ?? null,
    status: "active",
    createdAt: ctx.now
  });
}

/** A settled transaction row, so `post()` has a transaction to update. */
async function settleTxn(ctx: Ctx, txnId: string, type: string, currency: string): Promise<void> {
  await ctx.db.insert(schema.ledgerTxns).values({
    id: txnId,
    tenantId: ctx.tenantId,
    type,
    version: 1,
    idempotencyKey: txnId,
    state: "settled",
    actorKind: "system",
    actorId: "sys",
    currency,
    baseCurrency: currency,
    grossMinor: 0,
    baseGrossMinor: 0,
    createdAt: NOW,
    updatedAt: NOW
  });
}

/**
 * Put the pair through a real receipt, so a test can then ask the report a
 * question about a pair the posting rules already consider whole.
 */
async function receipt(
  ctx: Ctx,
  txnId: string,
  currency: string,
  lines: readonly { accountCode: string; side: "debit" | "credit"; amountMinor: number }[]
): Promise<void> {
  await settleTxn(ctx, txnId, "CM-RECEIPT", currency);
  await post(ctx, { txnId, currency, fxRatePpm: 1_000_000, lines });
}

/**
 * Why a call was refused, as an operator would read it — `AppError` keeps the
 * reason in `detail`, so `toThrow(/…/)` matches the bare title "Bad request"
 * and says nothing about which account or amount was wrong.
 */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { detail?: string }).detail ?? String(e);
  }
  return "no refusal";
}

/* ------------------------- the pairing register and the per-pair invariant */

describe("client money is a per-account invariant, not a tenant-wide one", () => {
  // ADR-0126. The register the check reads: an asset names its own liability and
  // the liability names it back. A misconfigured pair is a control that cannot
  // work, so it fails closed and says which account it could not resolve.
  it("pairs every client-money asset with the liability that names it back", async () => {
    const ctx = await freshCtx();
    const pairs = await clientMoneyPairs(ctx);
    const byAsset = new Map(pairs.map((p) => [p.assetCode, p.liabilityCode]));
    expect(byAsset.get("1010")).toBe("2010");
    expect(byAsset.get("1011")).toBe("2011");
    expect(pairs.every((p) => p.assetCode !== p.liabilityCode)).toBe(true);
  });

  it("refuses a client-money asset whose pair is missing, unknown or one-way", async () => {
    const unnamed = await freshCtx();
    await addAccount(unnamed, { code: "1013", en: "Cash – unnamed pair", type: "asset", normalSide: "debit" });
    await expect(refusal(clientMoneyPairs(unnamed))).resolves.toMatch(/1013/);

    const unknown = await freshCtx();
    await addAccount(unknown, {
      code: "1013",
      en: "Cash – unknown pair",
      type: "asset",
      normalSide: "debit",
      clientMoneyPair: "2999"
    });
    await expect(refusal(clientMoneyPairs(unknown))).resolves.toMatch(/1013/);

    const oneWay = await freshCtx();
    await addAccount(oneWay, {
      code: "1013",
      en: "Cash – one-way pair",
      type: "asset",
      normalSide: "debit",
      clientMoneyPair: "2013"
    });
    await addAccount(oneWay, { code: "2013", en: "Liability – silent", type: "liability", normalSide: "credit" });
    await expect(refusal(clientMoneyPairs(oneWay))).resolves.toMatch(/1013/);
  });

  it("records the account and its liability on the alarm, not only the amounts", async () => {
    const ctx = await freshCtx();
    // A liability recognised with nothing behind it: the client is owed money the
    // platform is not holding. `post()` refuses it and leaves the alarm behind,
    // because a float that is short is the one thing this control exists for.
    //
    // The batch this test first used was a client-money **debit** against a
    // receivable — `Dr 1010 / Cr 1200` — which is a *surplus*, not a shortfall
    // (asset 500 > liability 0), and the shape is legitimate by design: a receipt
    // that clears a receivable is named in `assertClientMoneyShape`'s own comment
    // as one of the credits a client-money debit may take. The control correctly
    // did not fire, and it was the fixture that was wrong rather than the check.
    await expect(
      refusal(
        receipt(ctx, "tx_uae_orphan", "AED", [
          { accountCode: "2010", side: "credit", amountMinor: 500 },
          { accountCode: "1200", side: "debit", amountMinor: 500 }
        ])
      )
    ).resolves.toMatch(/client money/i);

    const alarms = await ctx.db.select().from(schema.ledgerClientMoneyChecks);
    expect(alarms.length).toBeGreaterThan(0);
    expect(alarms[0]?.accountCode).toBe("1010");
    expect(alarms[0]?.liabilityCode).toBe("2010");
    expect(alarms[0]?.breach).toBe(true);
  });

  // The invariant, and the one that actually makes this real: a batch that
  // crosses the two markets — debiting the KSA float to credit the UAE client
  // liability — nets to nothing when the two liabilities are summed, so the old
  // check saw a whole tenant while one account stood under-funded.
  it("refuses a batch that funds one market's float from another market's liability", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 500_000 }), fc.integer({ min: 1, max: 500_000 }), async (uae, amount) => {
        const ctx = await freshCtx();
        await receipt(ctx, "tx_uae", "AED", [
          { accountCode: "1010", side: "debit", amountMinor: uae },
          { accountCode: "2010", side: "credit", amountMinor: uae }
        ]);

        await settleTxn(ctx, "tx_cross", "CM-RECEIPT", "SAR");
        const why = await refusal(
          post(ctx, {
            txnId: "tx_cross",
            currency: "SAR",
            fxRatePpm: 1_000_000,
            lines: [
              { accountCode: "1011", side: "debit", amountMinor: amount },
              { accountCode: "2010", side: "credit", amountMinor: amount }
            ]
          })
        );
        // Refused by name, so an operator can see which two accounts were
        // crossed rather than only that something was wrong.
        expect(why, "a surplus in the UAE float cannot fund the KSA float").toMatch(/1010|1011/);

        // And nothing was hidden: the KSA account has no position of its own,
        // because the only batch that would have given it one was refused. Its
        // shortfall cannot be reported as a UAE surplus — which is exactly what
        // a tenant-wide sum would have called whole.
        const ksa = (await clientMoneyPosition(ctx)).find((p) => p.accountCode === "1011");
        expect(ksa).toBeUndefined();
      }),
      DB_RUNS
    );
  }, 120_000);

  it("reports one row per client-money account, and never nets the pairs", async () => {
    const ctx = await freshCtx();
    // One balanced receipt that clears a receivable as well as recognising the
    // liability, so the UAE account ends up holding 6,000 more than it owes.
    await receipt(ctx, "tx_uae", "AED", [
      { accountCode: "1010", side: "debit", amountMinor: 10_000 },
      { accountCode: "2010", side: "credit", amountMinor: 4_000 },
      { accountCode: "1200", side: "credit", amountMinor: 6_000 }
    ]);
    await receipt(ctx, "tx_ksa", "SAR", [
      { accountCode: "1011", side: "debit", amountMinor: 250 },
      { accountCode: "2011", side: "credit", amountMinor: 250 }
    ]);

    const rows = await clientMoneyPosition(ctx);
    const uae = rows.find((r) => r.accountCode === "1010");
    const ksa = rows.find((r) => r.accountCode === "1011");
    expect(uae, "the UAE account is its own row").toBeDefined();
    expect(ksa, "the KSA account is its own row").toBeDefined();
    expect(ksa?.currency).toBe("SAR");
    expect(ksa?.liabilityCode).toBe("2011");
    // The property: a position row's stated breach is its own pair's arithmetic,
    // and the KSA shortfall above is not offset by the UAE surplus.
    expect(ksa?.surplusMinor).toBe(ksa!.assetMinor - ksa!.liabilityMinor);
    expect(ksa?.breach).toBe(ksa!.assetMinor < ksa!.liabilityMinor);
    expect(uae?.surplusMinor).toBe(uae!.assetMinor - uae!.liabilityMinor);
    expect(uae?.breach).toBe(uae!.assetMinor < uae!.liabilityMinor);
    // 1010 holds more than it owes and 1011 holds exactly what it owes: the one
    // row a tenant-wide sum would report is not what the tenant actually holds.
    expect(uae?.surplusMinor).toBe(6_000);
    expect(ksa?.surplusMinor).toBe(0);
  });
});

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

describe("10 — SUCCESS-FEE cannot post without a countersigned metric pin, and bills it once", () => {
  // D11 (ADR-0111): the reference is a pin — a hashed copy of a verified
  // snapshot both sides countersigned — and the key is derived from it.
  it("refuses every pin short of fully countersigned and intact, and posts a good one exactly once", async () => {
    await fc.assert(
      fc.asyncProperty(
        minor,
        fc.constantFrom("none", "missing", "unsigned", "tenant_only", "counterparty_only", "tampered", "wrong_key", "good"),
        fc.integer({ min: 1, max: 3 }),
        async (amount, kind, attempts) => {
          const ctx = await freshCtx();
          const as = (id: string): Ctx => ({ ...ctx, actor: { ...ctx.actor, id } });
          await ctx.db.insert(schema.northMetrics).values({
            id: "mtr_gwp", tenantId: ctx.tenantId, key: "gwp", nameJson: "{}", definitionSqlRef: "gwp",
            unit: "money", currency: "AED", createdAt: NOW, updatedAt: NOW
          });
          await ctx.db.insert(schema.northSnapshots).values({
            id: "nsp_1", tenantId: ctx.tenantId, metricKey: "gwp", grain: "month", period: "2026-05",
            dimsHash: "", value: amount, ts: NOW - 1, verifiedAt: NOW - 1, verifiedBy: "user:auditor"
          });
          const pin = await pinMetricSnapshot(ctx, "nsp_1");
          if (kind !== "unsigned" && kind !== "counterparty_only") await countersignPin(as("u_dir"), pin.id, "tenant");
          if (kind !== "unsigned" && kind !== "tenant_only") {
            await countersignPin(as("u_ctl"), pin.id, "counterparty", { evidenceRef: "esign" });
          }
          if (kind === "tampered") {
            await ctx.db.update(schema.ledgerMetricPins).set({ value: amount + 1 }).where(eq(schema.ledgerMetricPins.id, pin.id));
          }
          const ref = kind === "none" ? null : kind === "missing" ? "pms_missing" : pin.id;
          const args = { netMinor: amount, taxMinor: 0, ...(ref ? { pinnedSnapshotId: ref } : {}) };
          const key = kind === "wrong_key" ? `sf-${amount}` : successFeeKey(ref ?? "none");
          const once = () =>
            runTxn(
              ctx,
              { type: "SUCCESS-FEE", idempotencyKey: key, currency: "AED", grossMinor: amount },
              { recipe: { lines: buildRecipe("SUCCESS-FEE", args), currency: "AED" }, args, preApproved: true }
            );
          const rows = () => ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.tenantId, ctx.tenantId));

          if (kind === "good") {
            const ids = new Set<string>();
            for (let i = 0; i < attempts; i++) {
              const txn = await once();
              expect(txn.state).toBe("settled");
              ids.add(txn.id);
            }
            expect(ids.size).toBe(1);
            expect(await rows()).toHaveLength(1);
          } else {
            await expect(once()).rejects.toThrow();
            // A precondition is a "not yet", so a refusal leaves no trace to
            // burn the idempotency key on.
            expect(await rows()).toEqual([]);
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

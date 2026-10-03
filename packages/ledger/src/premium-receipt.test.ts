import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { post } from "./posting.js";
import { buildRecipe } from "./recipes.js";
import { agedOpenItems } from "./reports.js";
import { valueFlow } from "./money-map.js";
import { PREMIUM_RECEIPT_TYPES, premiumReceiptLines } from "./premium-receipt.js";
import { seedTestChart } from "./test-chart.js";

// docs/27 F14 booked the premium as Dr 1200 at bind and gave the receipt a
// form that clears it — `clearsReceivableAccount` — which no caller in the
// product ever passed. So 1200 was debited at every bind and credited by
// nothing: every paid policy aged as unpaid, and the Money Map read all of it as
// still due. `premiumReceiptLines` is the one place that decides how much of a
// receipt clears a receivable, from what the ledger says is open for the item.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");
const statements = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);

const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;
let n = 0;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  n = 0;
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({ currency: "AED" }),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
});

async function postTxn(type: string, lines: ReturnType<typeof buildRecipe>, currency = "AED"): Promise<string> {
  n += 1;
  const txnId = `tx_pr_${n}`;
  await ctx.db.insert(schema.ledgerTxns).values({
    id: txnId,
    tenantId: "t_test",
    type,
    idempotencyKey: `k_${txnId}`,
    state: "authorized",
    actorKind: "user",
    actorId: "u_test",
    currency,
    baseCurrency: currency,
    grossMinor: 1,
    baseGrossMinor: 1,
    createdAt: NOW,
    updatedAt: NOW
  });
  await post(ctx, { txnId, currency, lines, ...(currency === "AED" ? {} : { fxRatePpm: 3_672_500 }) });
  return txnId;
}

/** The bind exactly as `routes/axis.ts` posts it: item, due date, counterparty. */
async function bind(policy: string, gwpMinor: number, currency = "AED"): Promise<void> {
  await postTxn(
    "BIND",
    buildRecipe("BIND", {
      gwpMinor,
      grossMinor: Math.max(1, Math.floor(gwpMinor / 10)),
      dims: {
        item: `policy:${policy}`,
        dueAt: NOW,
        policy,
        provider: "prov_x",
        counterparty: "provider:prov_x"
      }
    }),
    currency
  );
}

async function receive(type: string, amountMinor: number, args: Record<string, unknown>, currency = "AED") {
  const lines = await premiumReceiptLines(ctx, type, { amountMinor, ...args }, currency);
  await postTxn(type, lines, currency);
  return lines;
}

async function net(code: string): Promise<number> {
  const rows = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(and(eq(schema.ledgerJournalLines.tenantId, "t_test"), eq(schema.ledgerJournalLines.accountCode, code)));
  return rows.reduce((s, l) => s + (l.side === "debit" ? l.amountMinor : -l.amountMinor), 0);
}

const openPremium = async () =>
  (await agedOpenItems(ctx, { accountCodes: ["1200"] })).reduce((s, r) => s + r.totalMinor, 0);

describe("premiumReceiptLines", () => {
  it("names the three receipt types the Money Map reads as premium in", () => {
    expect([...PREMIUM_RECEIPT_TYPES].sort()).toEqual(["CM-RECEIPT", "PREM-COLLECT", "PREM-INSTALMENT"]);
  });

  it("bind then payment: 1200 nets to zero, the Money Map has nothing still due, and aging is clear", async () => {
    await bind("p1", 100_000);
    expect(await openPremium()).toBe(100_000);

    await receive("PREM-COLLECT", 100_000, { dims: { policy: "p1" } });

    expect(await net("1200")).toBe(0);
    // The insurer is now owed from client money (2010), not from the bind's 2000.
    expect(await net("2000")).toBe(0);
    const map = await valueFlow(ctx, { periodCode: "2026-06", currency: "AED" });
    expect(map.nodes.find((x) => x.key === "premium-collected")?.amountMinor).toBe(100_000);
    expect(map.nodes.find((x) => x.key === "premium-due")?.amountMinor).toBe(0);
    expect(map.uncollectedMinor).toBe(0);
    expect(await openPremium()).toBe(0);
    expect(await agedOpenItems(ctx, { kind: "payable", accountCodes: ["2000"] })).toEqual([]);
  });

  it("instalments clear the receivable piece by piece, and aging shows what is left", async () => {
    await bind("p2", 120_000);
    await receive("PREM-INSTALMENT", 40_000, { dims: { policy: "p2" } });
    expect(await openPremium()).toBe(80_000);
    await receive("PREM-INSTALMENT", 40_000, { dims: { policy: "p2" } });
    await receive("PREM-INSTALMENT", 40_000, { dims: { policy: "p2" } });
    expect(await net("1200")).toBe(0);
    expect(await openPremium()).toBe(0);
  });

  it("accepts the open-item key itself, as a statement line would carry it", async () => {
    await bind("p3", 50_000);
    await receive("CM-RECEIPT", 50_000, { dims: { item: "policy:p3" } });
    expect(await net("1200")).toBe(0);
  });

  it("never drives 1200 below zero: an overpayment clears the debt and holds the rest", async () => {
    await bind("p4", 30_000);
    const lines = await receive("PREM-COLLECT", 45_000, { dims: { policy: "p4" } });
    expect(await net("1200")).toBe(0);
    expect(lines.find((l) => l.accountCode === "2010")?.amountMinor).toBe(45_000);
    // A second receipt on a settled item clears nothing.
    const again = await receive("PREM-COLLECT", 5_000, { dims: { policy: "p4" } });
    expect(again.map((l) => l.accountCode)).toEqual(["1010", "2010"]);
    expect(await net("1200")).toBe(0);
  });

  it("posts the plain receipt when no receivable is named or open", async () => {
    const unnamed = await receive("CM-RECEIPT", 10_000, {});
    expect(unnamed.map((l) => l.accountCode)).toEqual(["1010", "2010"]);
    // Commission-only bind: no premium passed through us, nothing to clear.
    const commissionOnly = await receive("PREM-COLLECT", 10_000, { dims: { policy: "nobody" } });
    expect(commissionOnly.map((l) => l.accountCode)).toEqual(["1010", "2010"]);
  });

  it("clears only a receivable in the receipt's own currency", async () => {
    await bind("p5", 20_000, "USD");
    const lines = await receive("PREM-COLLECT", 20_000, { dims: { policy: "p5" } }, "AED");
    expect(lines.some((l) => l.accountCode === "1200")).toBe(false);
  });

  it("decides the clearing itself: a caller cannot argue 1200 below what is open", async () => {
    await bind("p6", 10_000);
    const lines = await receive("PREM-COLLECT", 50_000, {
      dims: { policy: "p6" },
      clearsReceivableAccount: "1200",
      clearsReceivableMinor: 50_000
    });
    expect(lines.find((l) => l.accountCode === "1200")?.amountMinor).toBe(10_000);
    expect(await net("1200")).toBe(0);
  });

  it("refuses a type that is not a premium receipt", async () => {
    await expect(premiumReceiptLines(ctx, "PREM-REMIT", { amountMinor: 1 }, "AED")).rejects.toThrow();
  });
});

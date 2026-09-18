import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { agedOpenItems, PAYABLE_AGING_ACCOUNTS, RECEIVABLE_AGING_ACCOUNTS } from "./reports.js";

// docs/27 F15: "Aging ages journal lines by posting date against a free-text
// counterparty string, not open items by due date, and there is no payables
// aging."
//
// Three separate faults in one report, so three separate things to hold:
//   1. it aged *lines*, so a receivable raised in January and settled in
//      February showed as two lines in two buckets instead of one closed item;
//   2. it aged by *posting date*, which is when we invoiced, not when they owe;
//   3. it had no payables side at all, so nothing could answer "what do we owe,
//      and how late are we".

const MIGRATIONS = join(import.meta.dirname, "..", "..", "db", "migrations");

function statements(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
}

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 15, 12);
let ctx: Ctx;
let seq = 0;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  for (const sql of statements()) await client.execute(sql);
  seq = 0;
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_test",
    actor: { kind: "user", id: "u_test", tenantId: "t_test", grants: [{ roleKey: "owner", permissions: ["*:*:*"] }] },
    requestId: "req_test",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
});

async function line(opts: {
  account: string;
  side: "debit" | "credit";
  amountMinor: number;
  postedAt: number;
  dims?: Record<string, string | number>;
}): Promise<void> {
  seq += 1;
  await ctx.db.insert(schema.ledgerJournalLines).values({
    id: `jln_${seq}`,
    tenantId: ctx.tenantId,
    batchId: `bat_${seq}`,
    txnId: `txn_${seq}`,
    seq: 1,
    accountCode: opts.account,
    side: opts.side,
    amountMinor: opts.amountMinor,
    currency: "AED",
    baseAmountMinor: opts.amountMinor,
    baseCurrency: "AED",
    dimsJson: opts.dims ? JSON.stringify(opts.dims) : null,
    postedAt: opts.postedAt
  });
}

describe("aging is over open items, not journal lines", () => {
  it("nets an item's own legs, so a settled invoice leaves the report", async () => {
    await line({ account: "1100", side: "debit", amountMinor: 10_000, postedAt: NOW - 90 * DAY, dims: { item: "INV-1", counterparty: "falcon" } });
    await line({ account: "1100", side: "credit", amountMinor: 10_000, postedAt: NOW - 5 * DAY, dims: { item: "INV-1", counterparty: "falcon" } });

    const rows = await agedOpenItems(ctx, { kind: "receivable" });
    expect(rows).toEqual([]);
  });

  it("ages a part-paid item by what is still open", async () => {
    await line({ account: "1100", side: "debit", amountMinor: 10_000, postedAt: NOW - 100 * DAY, dims: { item: "INV-2", counterparty: "falcon" } });
    await line({ account: "1100", side: "credit", amountMinor: 4_000, postedAt: NOW - 5 * DAY, dims: { item: "INV-2", counterparty: "falcon" } });

    const [row] = await agedOpenItems(ctx, { kind: "receivable" });
    expect(row?.totalMinor).toBe(6_000);
    // The whole remainder sits in one bucket — the item's, not each leg's.
    expect(row?.d90Minor).toBe(6_000);
    expect(row?.currentMinor).toBe(0);
    expect(row?.items).toHaveLength(1);
    expect(row?.items[0]?.ref).toBe("INV-2");
  });
});

describe("aging is by due date, not posting date", () => {
  it("a stated due date is what the buckets measure from", async () => {
    // Raised 100 days ago on 90-day terms: only 10 days overdue, not 100.
    await line({
      account: "1100",
      side: "debit",
      amountMinor: 10_000,
      postedAt: NOW - 100 * DAY,
      dims: { item: "INV-3", counterparty: "falcon", dueAt: NOW - 10 * DAY }
    });
    const [row] = await agedOpenItems(ctx, { kind: "receivable" });
    expect(row?.currentMinor).toBe(10_000);
    expect(row?.d90Minor).toBe(0);
  });

  it("an item with no stated due date is due when it was raised", async () => {
    // Stated, not guessed: with no terms on file the debt is due on demand, so
    // the raise date is the due date. Falling back to *today* would report every
    // unpaid item as current, which is the friendly lie an aging report exists
    // to prevent.
    await line({ account: "1100", side: "debit", amountMinor: 10_000, postedAt: NOW - 100 * DAY, dims: { item: "INV-4" } });
    const [row] = await agedOpenItems(ctx, { kind: "receivable" });
    expect(row?.d90Minor).toBe(10_000);
  });

  it("an item not yet due is current, never negative-aged into a bucket", async () => {
    await line({
      account: "1100",
      side: "debit",
      amountMinor: 10_000,
      postedAt: NOW - DAY,
      dims: { item: "INV-5", dueAt: NOW + 30 * DAY }
    });
    const [row] = await agedOpenItems(ctx, { kind: "receivable" });
    expect(row?.currentMinor).toBe(10_000);
    expect(row?.items[0]?.daysOverdue).toBe(0);
  });
});

describe("payables age too, on the other sign", () => {
  it("reports what we owe as a positive figure", async () => {
    await line({ account: "2100", side: "credit", amountMinor: 8_000, postedAt: NOW - 45 * DAY, dims: { item: "PO-1", counterparty: "channel:gulf" } });
    const [row] = await agedOpenItems(ctx, { kind: "payable" });
    expect(row?.counterparty).toBe("channel:gulf");
    expect(row?.totalMinor).toBe(8_000);
    expect(row?.d30Minor).toBe(8_000);
  });

  it("a paid payable leaves the report as a receivable would", async () => {
    await line({ account: "2100", side: "credit", amountMinor: 8_000, postedAt: NOW - 45 * DAY, dims: { item: "PO-2" } });
    await line({ account: "2100", side: "debit", amountMinor: 8_000, postedAt: NOW - DAY, dims: { item: "PO-2" } });
    expect(await agedOpenItems(ctx, { kind: "payable" })).toEqual([]);
  });

  it("the two sides read disjoint accounts, so nothing is counted twice", () => {
    const overlap = RECEIVABLE_AGING_ACCOUNTS.filter((c) => PAYABLE_AGING_ACCOUNTS.includes(c));
    expect(overlap).toEqual([]);
    // Premium receivable and insurer payable (docs/27 F14) are the two the
    // report exists for — an aggregator's whole working-capital position.
    expect(RECEIVABLE_AGING_ACCOUNTS).toContain("1200");
    expect(PAYABLE_AGING_ACCOUNTS).toContain("2000");
  });
});

describe("the counterparty is a reference, not free text", () => {
  it("keeps items with different counterparties apart", async () => {
    await line({ account: "1100", side: "debit", amountMinor: 1_000, postedAt: NOW - DAY, dims: { item: "A", counterparty: "provider:falcon" } });
    await line({ account: "1100", side: "debit", amountMinor: 2_000, postedAt: NOW - DAY, dims: { item: "B", counterparty: "provider:cedar" } });
    const rows = await agedOpenItems(ctx, { kind: "receivable" });
    expect(rows.map((r) => r.counterparty).sort()).toEqual(["provider:cedar", "provider:falcon"]);
  });

  it("an item with no counterparty is reported as unattributed rather than dropped", async () => {
    await line({ account: "1100", side: "debit", amountMinor: 1_000, postedAt: NOW - DAY, dims: { item: "C" } });
    const [row] = await agedOpenItems(ctx, { kind: "receivable" });
    expect(row?.counterparty).toBe("unattributed");
  });
});

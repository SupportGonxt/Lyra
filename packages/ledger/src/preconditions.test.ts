import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { TXN_PRECONDITIONS } from "./preconditions.js";
import { expireStale } from "./txn.js";

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
    policy: {} as any,
    entitlements: {} as any
  };
}

beforeEach(async () => {
  ctx = await freshCtx();
});

describe("AD-PLACEMENT precondition", () => {
  it("refuses when no disclosure has been presented for the subjectRef", async () => {
    const precondition = TXN_PRECONDITIONS["AD-PLACEMENT"]!;
    await expect(precondition(ctx, { subjectRef: "campaign:no-disclosure" })).rejects.toThrow();
  });

  it("refuses when the disclosure is older than 24 hours", async () => {
    await ctx.db.insert(schema.disclosures).values({
      id: "dsc_stale",
      tenantId: ctx.tenantId,
      key: "ad_placement",
      locale: "en",
      subjectRef: "campaign:stale",
      customerId: null,
      wordingHash: "deadbeef",
      wordingRef: null,
      criteriaJson: null,
      channel: "web",
      acknowledgedAt: null,
      ts: ctx.now - 25 * 60 * 60 * 1000
    });
    const precondition = TXN_PRECONDITIONS["AD-PLACEMENT"]!;
    await expect(precondition(ctx, { subjectRef: "campaign:stale" })).rejects.toThrow();
  });

  it("passes when a fresh disclosure exists for the subjectRef", async () => {
    await ctx.db.insert(schema.disclosures).values({
      id: "dsc_fresh",
      tenantId: ctx.tenantId,
      key: "ad_placement",
      locale: "en",
      subjectRef: "campaign:fresh",
      customerId: null,
      wordingHash: "deadbeef",
      wordingRef: null,
      criteriaJson: null,
      channel: "web",
      acknowledgedAt: null,
      ts: ctx.now - 60 * 60 * 1000
    });
    const precondition = TXN_PRECONDITIONS["AD-PLACEMENT"]!;
    await expect(precondition(ctx, { subjectRef: "campaign:fresh" })).resolves.toBeUndefined();
  });
});

function fakeCtx(aggregationMin: number, status = "published") {
  return {
    tenantId: "t1",
    db: {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ aggregationMin, status }])
        })
      })
    }
  } as any;
}

/**
 * AppError carries the human-readable title as `message` and the specific
 * cause as `detail` (see ledger.test.ts), so asserting on `toThrow(/…/)`
 * would only ever test the fixed "Conflict" title — assert on `detail`.
 */
async function rejects(p: Promise<unknown>, detail: RegExp): Promise<void> {
  await expect(p).rejects.toThrow();
  try {
    await p;
  } catch (e) {
    expect((e as { detail?: string }).detail ?? String(e)).toMatch(detail);
  }
}

describe("TXN_PRECONDITIONS[DPROD-DELIVER]", () => {
  it("throws conflict when cellCount is below the product's aggregationMin", async () => {
    const c = fakeCtx(50);
    await rejects(
      TXN_PRECONDITIONS["DPROD-DELIVER"]!(c, { dataProductId: "dp1", cellCount: 10 }),
      /k-anonymity/i
    );
  });

  it("refuses a product that is not published, whatever the cell count", async () => {
    // A draft was never approved for sale and a suspended one has been pulled,
    // often for the same disclosure reasons this gate exists to enforce.
    await rejects(
      TXN_PRECONDITIONS["DPROD-DELIVER"]!(fakeCtx(50, "draft"), { dataProductId: "dp1", cellCount: 500 }),
      /not published/i
    );
    await rejects(
      TXN_PRECONDITIONS["DPROD-DELIVER"]!(fakeCtx(50, "suspended"), { dataProductId: "dp1", cellCount: 500 }),
      /not published/i
    );
  });

  it("passes when cellCount meets the product's aggregationMin", async () => {
    const c = fakeCtx(50);
    await expect(
      TXN_PRECONDITIONS["DPROD-DELIVER"]!(c, { dataProductId: "dp1", cellCount: 50 })
    ).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------ takaful H8 */

// docs/16 H8, docs/27 F45. The Shariah lane and the surplus distribution are
// joined here and nowhere else: this precondition is the only thing standing
// between a declared surplus and a fund whose structure no board has ruled on.
describe("TXN_PRECONDITIONS[SURPLUS-DIST]", () => {
  const precondition = TXN_PRECONDITIONS["SURPLUS-DIST"]!;

  async function product(over: Record<string, unknown> = {}): Promise<string> {
    const id = `prd_${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.insert(schema.products).values({
      id,
      tenantId: ctx.tenantId,
      line: "life",
      nameJson: JSON.stringify({ en: "Term life" }),
      structure: "takaful",
      takafulJson: JSON.stringify({
        model: "wakala",
        participantShareBps: 10_000,
        shariah: { state: "certified", boardRef: "board:x", certifiedAt: ctx.now - 1000 }
      }),
      status: "active",
      createdAt: ctx.now,
      updatedAt: ctx.now,
      ...over
    });
    return id;
  }

  it("allows a distribution out of a certified takaful product", async () => {
    await expect(precondition(ctx, { productId: await product() })).resolves.toBeUndefined();
  });

  it("refuses a product that is not takaful at all", async () => {
    // Not a permission failure and not a typo: 2040 is a liability, so
    // debiting it for a product that never credited it leaves a debit balance
    // that reads exactly like an ordinary prepayment. Nothing downstream can
    // find this afterwards, which is why it is refused before the write.
    const id = await product({ structure: "conventional" });
    await rejects(precondition(ctx, { productId: id }), /not takaful/i);
  });

  it("refuses a product whose board has not ruled", async () => {
    const id = await product({ takafulJson: JSON.stringify({ shariah: { state: "submitted" } }) });
    await rejects(precondition(ctx, { productId: id }), /"submitted", not "certified"/);
  });

  it("refuses a product with no takaful terms recorded at all", async () => {
    // The state this column was in before F45: structure says takaful, the
    // terms are null, and the default state is draft — so the absence refuses
    // rather than defaulting to permitted.
    const id = await product({ takafulJson: null });
    await rejects(precondition(ctx, { productId: id }), /"draft", not "certified"/);
  });

  it("refuses a ruling that has expired, which 'certified' alone would not catch", async () => {
    const id = await product({
      takafulJson: JSON.stringify({
        shariah: { state: "certified", certifiedAt: ctx.now - 10_000, expiresAt: ctx.now - 1 }
      })
    });
    await rejects(precondition(ctx, { productId: id }), /expired/i);
  });

  it("treats a ruling expiring in the future as current", async () => {
    const id = await product({
      takafulJson: JSON.stringify({
        shariah: { state: "certified", certifiedAt: ctx.now - 10_000, expiresAt: ctx.now + 1 }
      })
    });
    await expect(precondition(ctx, { productId: id })).resolves.toBeUndefined();
  });

  it("refuses a product belonging to another tenant", async () => {
    const id = await product({ tenantId: "t_other" });
    await rejects(precondition(ctx, { productId: id }), /not found/i);
  });

  it("requires a productId, rather than deciding without one", async () => {
    await rejects(precondition(ctx, {}), /productId is required/);
  });
});

/* -------------------------- the sweep that enforces a provider's deadline */

/**
 * The 2026-10-01 sweep's LEDGER finding. `expireStale` existed, worked, and its own
 * docstring said **"Called by the scheduled worker"** — and nothing called it: one
 * grep hit repo-wide, its own definition, no test anywhere that mentioned it or
 * `externalTimeoutAt` either.
 *
 * What that cost is not one stuck row. The period-close check `no_pending_external`
 * counts **every** `pending_external` row tenant-wide, with no period and no
 * deadline filter — so a single row past its `externalTimeoutAt` failed the close
 * of **every** period for that tenant, permanently. And the seed writes exactly such
 * a row into the open period of every seeded tenant, so close was red on arrival.
 *
 * This covers the behaviour; a comment in `apps/api/src/index.ts` records that the
 * scheduled worker now calls it.
 */
describe("expireStale enforces the deadline it was written for", () => {
  const stale = async (id: string, timeoutAt: number) => {
    await ctx.db.insert(schema.ledgerTxns).values({
      id,
      tenantId: ctx.tenantId,
      type: "CMSN-SETL",
      version: 1,
      idempotencyKey: id,
      state: "pending_external",
      actorKind: "system",
      actorId: "sys",
      currency: "AED",
      baseCurrency: "AED",
      grossMinor: 0,
      baseGrossMinor: 0,
      externalTimeoutAt: timeoutAt,
      createdAt: ctx.now - 10_000,
      updatedAt: ctx.now - 10_000
    } as never);
  };

  it("expires a transaction past its deadline and leaves a live one alone", async () => {
    await stale("txn_overdue", ctx.now - 1);
    await stale("txn_inflight", ctx.now + 600_000);

    const expired = await expireStale(ctx);
    expect(expired).toContain("txn_overdue");
    expect(expired).not.toContain("txn_inflight");

    const [overdue] = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, "txn_overdue"));
    expect(overdue!.state).toBe("expired");

    // The one still inside its window keeps pretending to be in flight, because it
    // still is — expiring it early would unblock a close by lying.
    const [inflight] = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, "txn_inflight"));
    expect(inflight!.state).toBe("pending_external");
  });

  it("leaves a transaction with no deadline at all alone", async () => {
    // No deadline is not a deadline of zero. A row nobody set a timeout on has not
    // timed out, and treating null as "overdue" would expire live payments.
    await ctx.db.insert(schema.ledgerTxns).values({
      id: "txn_nodl",
      tenantId: ctx.tenantId,
      type: "CMSN-SETL",
      version: 1,
      idempotencyKey: "txn_nodl",
      state: "pending_external",
      actorKind: "system",
      actorId: "sys",
      currency: "AED",
      baseCurrency: "AED",
      grossMinor: 0,
      baseGrossMinor: 0,
      externalTimeoutAt: null,
      createdAt: ctx.now - 10_000,
      updatedAt: ctx.now - 10_000
    } as never);

    expect(await expireStale(ctx)).not.toContain("txn_nodl");
    const [row] = await ctx.db.select().from(schema.ledgerTxns).where(eq(schema.ledgerTxns.id, "txn_nodl"));
    expect(row!.state).toBe("pending_external");
  });
});

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { EntitlementsJson, PolicyJson, schema } from "@lyra/db";
import type { Ctx } from "@lyra/core";
import { closeChecks, closePeriod, profitAndLoss } from "@lyra/ledger";
import { seedTestChart } from "@lyra/ledger/test-chart";
import { importSpend, recordSpend, type SpendLine } from "./signal-spend-import.js";
import { onError } from "../mw.js";
import { signalRoutes } from "../routes/signal.js";
import type { App } from "../env.js";

// docs/19 §4.8 / §5 G: MEDIA-SPEND is "actual spend recorded from channel API",
// Dr 5100 Media Spend / Cr 2250 Accrued Expenses. The type and its recipe have
// existed all along and only the seed ever posted one: a simulated month put
// AED 214k into signal_spend and AED 0 onto the P&L. Every spend write now
// accrues at the write, per row, through runTxn.

const MIGRATIONS = join(import.meta.dirname, "..", "..", "..", "..", "packages", "db", "migrations");
const NOW = Date.parse("2026-08-20T12:00:00Z");
const PERIOD = "2026-08";
const HOUR = 3_600_000;
let ctx: Ctx;

beforeEach(async () => {
  const client = createClient({ url: ":memory:" });
  const sqls = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint"))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of sqls) await client.execute(s);
  ctx = {
    db: drizzle(client) as unknown as Ctx["db"],
    tenantId: "t_1",
    actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [] },
    requestId: "req_1",
    now: NOW,
    locale: "en",
    policy: PolicyJson.parse({}),
    entitlements: EntitlementsJson.parse({})
  };
  await seedTestChart(ctx);
  for (const id of ["cmp_1", "cmp_2"]) {
    await ctx.db.insert(schema.signalCampaigns).values({
      id,
      tenantId: "t_1",
      name: id,
      objective: "acq",
      channelsJson: "[]",
      budgetJson: "{}",
      state: "live",
      autonomyLevel: "act",
      ownerRef: "user:1",
      createdAt: NOW,
      updatedAt: NOW
    });
  }
});

const HEADER = "day,campaignId,channel,amountMinor,currency,impressions,clicks,conversions";
const line = (o: Partial<SpendLine> = {}): SpendLine => ({
  campaignId: "cmp_1",
  channel: "meta",
  day: "2026-08-18",
  amountMinor: 100_000,
  currency: "AED",
  impressions: 0,
  clicks: 0,
  conversions: 0,
  ...o
});

const mediaTxns = () =>
  ctx.db
    .select()
    .from(schema.ledgerTxns)
    .where(and(eq(schema.ledgerTxns.tenantId, "t_1"), eq(schema.ledgerTxns.type, "MEDIA-SPEND")));

/** Net debit on an account, from the lines themselves. */
async function net(code: string): Promise<number> {
  const lines = await ctx.db
    .select()
    .from(schema.ledgerJournalLines)
    .where(and(eq(schema.ledgerJournalLines.tenantId, "t_1"), eq(schema.ledgerJournalLines.accountCode, code)));
  return lines.reduce((n, l) => n + (l.side === "debit" ? l.amountMinor : -l.amountMinor), 0);
}

const spendTotal = async () => (await ctx.db.select().from(schema.signalSpend)).reduce((n, r) => n + r.amountMinor, 0);

async function mediaOnPnl(code = PERIOD): Promise<number> {
  const pnl = await profitAndLoss(ctx, code);
  return pnl.expense.rows.find((r) => r.accountCode === "5100")?.amountMinor ?? 0;
}

describe("recordSpend accrues MEDIA-SPEND", () => {
  it("posts Dr 5100 / Cr 2250 for a new row, dimensioned by campaign and channel", async () => {
    expect(await recordSpend(ctx, line(), "import")).toBe("created");
    const txns = await mediaTxns();
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ state: "settled", grossMinor: 100_000, currency: "AED" });
    const lines = await ctx.db.select().from(schema.ledgerJournalLines).where(eq(schema.ledgerJournalLines.txnId, txns[0]!.id));
    expect(lines.map((l) => [l.accountCode, l.side, l.amountMinor])).toEqual([
      ["5100", "debit", 100_000],
      ["2250", "credit", 100_000]
    ]);
    for (const l of lines) expect(JSON.parse(l.dimsJson ?? "{}")).toEqual({ campaign: "cmp_1", channel: "meta" });
    expect(await mediaOnPnl()).toBe(100_000);
  });

  it("leaves campaign out of the dims for channel-level spend", async () => {
    await recordSpend(ctx, line({ campaignId: null, channel: "google_search" }), "api");
    const [l] = await ctx.db.select().from(schema.ledgerJournalLines);
    expect(JSON.parse(l!.dimsJson ?? "{}")).toEqual({ channel: "google_search" });
  });

  it("is a no-op when the same row is recorded again at the same amount", async () => {
    await recordSpend(ctx, line(), "import");
    await recordSpend(ctx, line(), "import");
    await recordSpend(ctx, line(), "api");
    expect(await mediaTxns()).toHaveLength(1);
    expect(await net("5100")).toBe(100_000);
  });

  it("posts the positive delta when a restatement raises a row", async () => {
    await recordSpend(ctx, line(), "import");
    await recordSpend(ctx, line({ amountMinor: 130_000 }), "import");
    const grosses = (await mediaTxns()).map((t) => t.grossMinor).sort((a, b) => a - b);
    expect(grosses).toEqual([30_000, 100_000]);
    expect(await net("5100")).toBe(130_000);
    expect(await net("2250")).toBe(-130_000);
  });

  it("reverses through the contra mechanism when a restatement lowers a row — never a negative line", async () => {
    await recordSpend(ctx, line(), "import");
    await recordSpend(ctx, line({ amountMinor: 130_000 }), "import");
    await recordSpend(ctx, line({ amountMinor: 110_000 }), "import");

    const txns = await mediaTxns();
    // The 30k top-up is reversed (state reversed, contra txn carries reversal_of)
    // and the 10k that remains is booked fresh.
    const reversed = txns.filter((t) => t.state === "reversed");
    expect(reversed.map((t) => t.grossMinor)).toEqual([30_000]);
    const contra = txns.filter((t) => t.reversalOf);
    expect(contra.map((t) => t.reversalOf)).toEqual([reversed[0]!.id]);
    const allLines = await ctx.db.select().from(schema.ledgerJournalLines);
    expect(allLines.every((l) => l.amountMinor > 0)).toBe(true);
    expect(await net("5100")).toBe(110_000);
  });

  it("survives a restatement that goes back to an amount it held before", async () => {
    for (const amount of [100_000, 50_000, 100_000, 50_000, 0, 70_000, 70_000]) {
      await recordSpend(ctx, line({ amountMinor: amount }), "import");
      expect(await net("5100")).toBe(amount);
    }
  });

  it("books nothing for a zero-spend day", async () => {
    await recordSpend(ctx, line({ amountMinor: 0 }), "import");
    expect(await mediaTxns()).toEqual([]);
    expect(await spendTotal()).toBe(0);
  });

  it("refuses spend in a currency the tenant has no rate for, and writes no row", async () => {
    await expect(recordSpend(ctx, line({ currency: "USD" }), "import")).rejects.toMatchObject({ status: 400, detail: expect.stringMatching(/fx rate/) });
    expect(await ctx.db.select().from(schema.signalSpend)).toEqual([]);
  });

  it("converts foreign spend at the tenant's rate", async () => {
    await ctx.db.insert(schema.ledgerFxRates).values({
      id: "fx_1",
      tenantId: "t_1",
      fromCurrency: "USD",
      toCurrency: "AED",
      ratePpm: 3_672_500,
      asOf: "2026-08-19",
      source: "test"
    });
    await recordSpend(ctx, line({ currency: "USD", amountMinor: 10_000 }), "api");
    const [txn] = await mediaTxns();
    expect(txn).toMatchObject({ currency: "USD", grossMinor: 10_000, baseGrossMinor: 36_725 });
  });

  it("refuses to change the currency of a row it has already accrued", async () => {
    await recordSpend(ctx, line(), "import");
    await expect(recordSpend(ctx, line({ currency: "USD" }), "import")).rejects.toMatchObject({ status: 400, detail: expect.stringMatching(/currency/) });
    expect((await ctx.db.select().from(schema.signalSpend))[0]!.currency).toBe("AED");
  });

  it("treats a row written before the seam as already booked elsewhere, and accrues only what moves", async () => {
    // A seeded history row is carried by the seed's own monthly MEDIA-SPEND.
    await ctx.db.insert(schema.signalSpend).values({
      id: "spd_legacy",
      tenantId: "t_1",
      campaignId: "cmp_1",
      channel: "meta",
      day: "2026-08-18",
      amountMinor: 80_000,
      currency: "AED",
      source: "api",
      ts: NOW - 48 * HOUR
    });
    await recordSpend(ctx, line({ amountMinor: 80_000 }), "api");
    expect(await mediaTxns()).toEqual([]);
    await recordSpend(ctx, line({ amountMinor: 95_000 }), "api");
    expect(await net("5100")).toBe(15_000);
    await recordSpend(ctx, line({ amountMinor: 90_000 }), "api");
    expect(await net("5100")).toBe(10_000);
    // Below what the seam inherited: there is nothing of its own left to
    // reverse, so it books nothing and says so for the media recon.
    await recordSpend(ctx, line({ amountMinor: 60_000 }), "api");
    expect(await net("5100")).toBe(0);
    const notes = await ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "signal.spend.accrual_floor"));
    expect(notes).toHaveLength(1);
    // And back above it, the chain remembers where it started.
    await recordSpend(ctx, line({ amountMinor: 85_000 }), "api");
    expect(await net("5100")).toBe(5_000);
  });
});

describe("every write path accrues", () => {
  const app = (permissions: string[]) => {
    const a = new Hono<App>();
    a.onError(onError);
    a.use("*", async (c, next) => {
      c.set("ctx", { ...ctx, actor: { kind: "user", id: "u_1", tenantId: "t_1", grants: [{ roleKey: "t", permissions: permissions as never }] } });
      await next();
    });
    a.route("/", signalRoutes);
    return a;
  };
  const call = async (method: string, path: string, payload?: unknown, permissions = ["signal:spend:write", "signal:autopilot:run"]) => {
    const res = await app(permissions).fetch(
      new Request(`http://api.test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {})
      }),
      { ENVIRONMENT: "demo" } as never
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("the CSV import", async () => {
    const result = await importSpend(ctx, [HEADER, "2026-08-18,cmp_1,meta,125000,AED,0,0,0", "2026-08-18,,google_search,50000,AED,,,"].join("\n"));
    expect(result.errors).toEqual([]);
    expect(await net("5100")).toBe(175_000);
  });

  it("the CSV import names a line it could not accrue instead of failing the file", async () => {
    const result = await importSpend(ctx, [HEADER, "2026-08-18,cmp_1,meta,100,USD,0,0,0", "2026-08-18,cmp_2,meta,100,AED,0,0,0"].join("\n"));
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([{ line: 2, ref: "2026-08-18", error: expect.stringMatching(/fx rate/) }]);
    expect(await net("5100")).toBe(100);
  });

  it("POST /spend — a hand-keyed row", async () => {
    const res = await call("POST", "/spend", { day: "2026-08-18", campaignId: "cmp_1", channel: "email", amountMinor: 12_400, currency: "AED" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ channel: "email", amountMinor: 12_400, source: "manual" });
    expect(await net("5100")).toBe(12_400);
    // The same (campaign, channel, day) again is a conflict, as it always was.
    expect((await call("POST", "/spend", { day: "2026-08-18", campaignId: "cmp_1", channel: "email", amountMinor: 1, currency: "AED" })).status).toBe(409);
    expect(await net("5100")).toBe(12_400);
  });

  it("POST /spend refuses a reader and another tenant's campaign", async () => {
    expect((await call("POST", "/spend", { day: "2026-08-18", channel: "email", amountMinor: 1, currency: "AED" }, ["signal:spend:read"])).status).toBe(403);
    expect((await call("POST", "/spend", { day: "2026-08-18", campaignId: "cmp_nope", channel: "email", amountMinor: 1, currency: "AED" })).status).toBe(404);
    expect(await spendTotal()).toBe(0);
  });

  it("PATCH /spend/:id — a correction up and down", async () => {
    const created = await call("POST", "/spend", { day: "2026-08-18", campaignId: "cmp_1", channel: "email", amountMinor: 12_400, currency: "AED" });
    const id = created.body.id as string;
    const up = await call("PATCH", `/spend/${id}`, { amountMinor: 15_000, conversions: 3 });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ id, amountMinor: 15_000, conversions: 3 });
    expect(await net("5100")).toBe(15_000);
    expect((await call("PUT", `/spend/${id}`, { amountMinor: 9_000 })).status).toBe(200);
    expect(await net("5100")).toBe(9_000);
    // A row's identity is its (campaign, channel, day): moving it is a new row.
    expect((await call("PATCH", `/spend/${id}`, { day: "2026-08-19" })).status).toBe(400);
    expect((await call("PATCH", "/spend/spd_nope", { amountMinor: 1 })).status).toBe(404);
  });

  it("the demo spend tick", async () => {
    await recordSpend(ctx, line({ day: "2026-08-19", amountMinor: 40_000, conversions: 2 }), "api");
    const first = await call("POST", "/demo/spend-tick");
    expect(first).toEqual({ status: 200, body: { inserted: 1 } });
    expect(await net("5100")).toBe(80_000);
    // A second tick the same day finds today's row already there.
    expect(await call("POST", "/demo/spend-tick")).toEqual({ status: 200, body: { inserted: 0 } });
    expect(await net("5100")).toBe(80_000);
  });
});

/* -------------------------------------------------------------- the invariant */

/** Small deterministic PRNG, so a failure names a seed that reproduces it. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("ledger 5100 equals signal_spend", () => {
  it("for the period, after any sequence of imports and restatements", async () => {
    const base = ctx;
    for (let seed = 1; seed <= 12; seed++) {
      // A fresh tenant per seed on the same database: the property is per tenant.
      const tenantId = `t_p${seed}`;
      ctx = { ...base, tenantId, actor: { ...base.actor, tenantId } };
      await seedTestChart(ctx);
      const campaigns = [`p${seed}_a`, `p${seed}_b`];
      for (const id of campaigns) {
        await ctx.db.insert(schema.signalCampaigns).values({ id, tenantId, name: id, objective: "acq", channelsJson: "[]", budgetJson: "{}", ownerRef: "user:1", createdAt: NOW, updatedAt: NOW });
      }
      const rand = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
      for (let step = 0; step < 25; step++) {
        // Zero is a real restatement too: a day the platform zeroed out.
        const amountMinor = rand() < 0.1 ? 0 : 1 + Math.floor(rand() * 50) * 1_000;
        const day = `2026-08-1${Math.floor(rand() * 4)}`;
        ctx = { ...ctx, now: NOW + step * HOUR };
        const result = await importSpend(ctx, [HEADER, `${day},${pick([...campaigns, ""])},${pick(["meta", "google_search"])},${amountMinor},AED,0,0,0`].join("\n"));
        expect(result.errors).toEqual([]);
        const rows = await ctx.db.select().from(schema.signalSpend).where(eq(schema.signalSpend.tenantId, tenantId));
        expect({ seed, step, booked: await mediaOnPnl() }).toEqual({ seed, step, booked: rows.reduce((n, r) => n + r.amountMinor, 0) });
      }
      // The month still closes clean: every close check passes.
      expect((await closeChecks(ctx, PERIOD)).filter((c) => !c.ok)).toEqual([]);
    }
    ctx = base;
  }, 120_000);

  it("and the month it lands in closes", async () => {
    await importSpend(ctx, [HEADER, "2026-08-18,cmp_1,meta,125000,AED,0,0,0"].join("\n"));
    await importSpend(ctx, [HEADER, "2026-08-18,cmp_1,meta,90000,AED,0,0,0"].join("\n"));
    const closed = await closePeriod(ctx, PERIOD, "soft_closed", { preApproved: true });
    expect(closed.state).toBe("soft_closed");
    expect(await mediaOnPnl()).toBe(90_000);
  });
});
